import * as fs from 'fs';
import { detect } from './detect';
import { Predicate, compilePredicates } from './predicates';
import { parseRow } from './rowParser';
import { RowIndexer } from './rowIndexer';
import { ResultSet, coalesce } from './resultSet';
import type {
    CancelToken, Encoding, FileInfo, FilterProgress, FilterResult, IndexProgress,
    OpenResult, PageResult, ParseOptions, UniqueResult,
} from '../types';

export interface Tuning {
    chunkBytes: number;
    scanBytes: number;
    maxQuoteBytes: number;
    /** Test-only: called before every index read; may throw to simulate an I/O failure. */
    beforeIndexRead?: (position: number) => void;
}

export const DEFAULT_TUNING: Tuning = { chunkBytes: 1 << 20, scanBytes: 4 << 20, maxQuoteBytes: 1 << 20 };
export const UNIQUE_CAP = 100_000;

const QUOTE = 0x22;
const SAMPLE_BYTES = 64 * 1024;

type OpenOutcome = Exclude<OpenResult, { kind: 'ok' }> | { kind: 'ready' };
type ScanOutcome = 'complete' | 'stopped' | 'cancelled';
type Run = [number, number];

export class CsvEngine {
    private fh: fs.promises.FileHandle | undefined;
    private idx: RowIndexer | undefined;
    private size = 0;
    private bom = 0;
    private done = false;
    private headerRows = 0;
    private delimiter = ',';
    private encoding: Encoding = 'utf-8';
    private hasHeader = true;
    private decoder = new TextDecoder('utf-8');
    private waiters: Array<{ rows: number; resolve: () => void }> = [];
    private info: FileInfo | undefined;
    private view: ResultSet | null = null;
    private viewComplete = true;
    private readonly uniqueCache = new Map<number, UniqueResult>();
    private nonEmptyCache: number[] | undefined;
    private indexError: Error | undefined;
    private readonly indexFinished: Promise<void>;
    private finishIndex: () => void = () => undefined;

    constructor(
        private readonly path: string,
        private readonly options: ParseOptions = {},
        private readonly tuning: Tuning = DEFAULT_TUNING,
    ) {
        this.indexFinished = new Promise<void>((resolve) => {
            this.finishIndex = resolve;
        });
    }

    private get file(): fs.promises.FileHandle {
        if (!this.fh) {
            throw new Error('The file is closed.');
        }
        return this.fh;
    }

    private get indexer(): RowIndexer {
        if (!this.idx) {
            throw new Error('The file is not open.');
        }
        return this.idx;
    }

    async open(): Promise<OpenOutcome> {
        this.fh = await fs.promises.open(this.path, 'r');
        this.size = (await this.fh.stat()).size;
        if (this.size === 0) {
            return { kind: 'empty' };
        }
        const sample = Buffer.alloc(Math.min(SAMPLE_BYTES, this.size));
        await this.readFully(sample, 0);
        const d = detect(sample);
        if (d.binary) {
            return { kind: 'binary' };
        }
        if (d.encoding === 'utf-16le' || d.encoding === 'utf-16be') {
            return { kind: 'unsupported-encoding', encoding: d.encoding };
        }
        this.encoding = this.options.encoding ?? d.encoding;
        this.bom = this.encoding === d.encoding ? d.bomLength : 0;
        if (this.size <= this.bom) {
            return { kind: 'empty' };
        }
        this.delimiter = this.options.delimiter ?? d.delimiter;
        this.hasHeader = this.options.hasHeader ?? d.hasHeader;
        this.headerRows = this.hasHeader ? 1 : 0;
        this.decoder = new TextDecoder(this.encoding === 'latin1' ? 'windows-1252' : 'utf-8');
        this.idx = new RowIndexer({
            delimiter: this.delimiter.charCodeAt(0),
            quote: QUOTE,
            maxQuoteBytes: this.tuning.maxQuoteBytes,
        });
        return { kind: 'ready' };
    }

    /**
     * Stream the whole file once, building the row index. Resolves when indexing is complete (or cancelled).
     * On an I/O error every waiter is released, later reads rethrow the error, and the error is rethrown here.
     */
    async index(onProgress: (p: IndexProgress) => void, token: CancelToken): Promise<void> {
        try {
            await this.indexBody(onProgress, token);
        } catch (err) {
            this.indexError = err instanceof Error ? err : new Error(String(err));
            this.notify();
            this.finishIndex();
            throw this.indexError;
        }
    }

    private async indexBody(onProgress: (p: IndexProgress) => void, token: CancelToken): Promise<void> {
        const buf = Buffer.allocUnsafe(this.tuning.chunkBytes);
        let pos = this.bom;
        let lastReport = 0;
        for (;;) {
            while (pos < this.size) {
                if (token.cancelled) {
                    return;
                }
                this.tuning.beforeIndexRead?.(pos);
                const { bytesRead } = await this.file.read(buf, 0, buf.length, pos);
                if (bytesRead === 0) {
                    break;
                }
                const rewind = this.indexer.push(buf.subarray(0, bytesRead), pos);
                if (rewind !== undefined) {
                    pos = rewind;
                    continue;
                }
                pos += bytesRead;
                this.notify();
                const now = Date.now();
                if (now - lastReport > 250) {
                    lastReport = now;
                    onProgress(this.progress(pos));
                }
            }
            const rewind = this.indexer.finish();
            if (rewind === undefined) {
                break;
            }
            pos = rewind;
        }
        this.done = true;
        this.notify();
        this.finishIndex();
        onProgress(this.progress(this.size));
    }

    /** True once the whole file has been indexed. */
    get indexed(): boolean {
        return this.done;
    }

    private throwIfIndexFailed(): void {
        if (this.indexError) {
            throw this.indexError;
        }
    }

    async getInfo(): Promise<FileInfo> {
        if (this.info) {
            return this.info;
        }
        await this.waitForRows(1);
        this.throwIfIndexFailed();
        const first = this.readable() > 0 ? (await this.readRows(0, 1))[0] : [];
        const header = this.hasHeader
            ? first.map((name, i) => name.trim() || `Column ${i + 1}`)
            : first.map((_, i) => `Column ${i + 1}`);
        this.info = {
            header,
            columnCount: first.length,
            delimiter: this.delimiter,
            hasHeader: this.hasHeader,
            encoding: this.encoding,
            size: this.size,
        };
        return this.info;
    }

    async readPage(page: number, pageSize: number): Promise<PageResult> {
        const startRow = page * pageSize;
        this.throwIfIndexFailed();
        if (this.view) {
            const view = this.view;
            const complete = this.viewComplete;
            const rowNumbers = view.slice(startRow, startRow + pageSize);
            return { rowNumbers, rows: await this.readDataRows(rowNumbers), total: view.length, complete };
        }
        await this.waitForRows(this.headerRows + startRow + pageSize);
        this.throwIfIndexFailed();
        const total = this.dataRowCount;
        const count = Math.max(0, Math.min(total, startRow + pageSize) - startRow);
        const rowNumbers = Array.from({ length: count }, (_, i) => startRow + i);
        const rows = await this.readRows(this.headerRows + startRow, count);
        return { rowNumbers, rows, total, complete: this.done };
    }

    async filter(
        predicates: Predicate[],
        token: CancelToken,
        onProgress: (p: FilterProgress) => void,
    ): Promise<FilterResult> {
        const compiled = compilePredicates(predicates); // throws SyntaxError on a bad regex, before the view changes
        if (compiled.empty) {
            this.view = null;
            this.viewComplete = true;
            await this.indexFinished;
            this.throwIfIndexFailed();
            return { matches: this.dataRowCount, complete: true };
        }
        // Take over the view right away so pages requested while indexing never show unfiltered rows.
        const result = new ResultSet();
        this.view = result;
        this.viewComplete = false;
        await this.indexFinished;
        this.throwIfIndexFailed();
        if (token.cancelled || this.view !== result) {
            if (this.view === result) {
                // Cancelled before any scanning: the search simply stops and every row shows again.
                this.view = null;
                this.viewComplete = true;
                return { matches: this.dataRowCount, complete: false };
            }
            return { matches: 0, complete: false };
        }
        const runs: Run[] = compiled.badRowsOnly ? coalesce(this.badDataRows()) : [[0, this.dataRowCount]];
        const total = runs.reduce((n, r) => n + r[1], 0);
        let scannedNow = 0;
        let lastReport = 0;
        const outcome = await this.scan(
            runs,
            token,
            (rowNum, fields) => {
                if (compiled.test(fields)) {
                    result.push(rowNum);
                }
            },
            (scanned) => {
                scannedNow = scanned;
                const now = Date.now();
                if (now - lastReport >= 150) {
                    lastReport = now;
                    onProgress({ matches: result.length, scanned, total });
                }
            },
        );
        const complete = outcome !== 'cancelled';
        if (this.view === result) {
            // A user cancel keeps the partial view; paging must not wait for a scan that will never finish.
            this.viewComplete = true;
        }
        onProgress({ matches: result.length, scanned: scannedNow, total });
        return { matches: result.length, complete };
    }

    async uniqueValues(
        column: number,
        token: CancelToken,
        onProgress?: (scanned: number, total: number) => void,
    ): Promise<UniqueResult | null> {
        await this.indexFinished;
        this.throwIfIndexFailed();
        const cached = this.uniqueCache.get(column);
        if (cached) {
            return cached;
        }
        const total = this.dataRowCount;
        const counts = new Map<string, number>();
        const outcome = await this.scan(
            [[0, total]],
            token,
            (_rowNum, fields) => {
                const v = fields[column] ?? '';
                counts.set(v, (counts.get(v) ?? 0) + 1);
            },
            (scanned) => onProgress?.(scanned, total),
        );
        if (outcome === 'cancelled') {
            return null;
        }
        const all = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const result: UniqueResult = {
            column,
            entries: all.slice(0, UNIQUE_CAP).map(([value, count]) => ({ value, count })),
            distinct: all.length,
            total,
            truncated: all.length > UNIQUE_CAP,
        };
        this.uniqueCache.set(column, result);
        return result;
    }

    /** Columns that contain at least one non-blank value. Stops scanning once every column has one. */
    async nonEmptyColumns(token: CancelToken): Promise<number[] | null> {
        await this.indexFinished;
        this.throwIfIndexFailed();
        if (this.nonEmptyCache) {
            return this.nonEmptyCache;
        }
        const info = await this.getInfo();
        const seen = new Array<boolean>(info.columnCount).fill(false);
        let remaining = info.columnCount;
        const outcome = await this.scan(
            [[0, this.dataRowCount]],
            token,
            (_rowNum, fields) => {
                for (let c = 0; c < seen.length; c++) {
                    if (!seen[c] && (fields[c] ?? '').trim() !== '') {
                        seen[c] = true;
                        remaining--;
                    }
                }
                return remaining === 0;
            },
            () => undefined,
        );
        if (outcome === 'cancelled') {
            return null;
        }
        this.nonEmptyCache = seen.flatMap((s, c) => (s ? [c] : []));
        return this.nonEmptyCache;
    }

    async dispose(): Promise<void> {
        for (const w of this.waiters) {
            w.resolve();
        }
        this.waiters = [];
        this.finishIndex();
        const fh = this.fh;
        this.fh = undefined;
        await fh?.close();
    }

    // ---- internals -------------------------------------------------------

    private progress(pos: number): IndexProgress {
        return {
            rows: this.dataRowCount,
            bytes: pos,
            total: this.size,
            done: this.done,
            badRows: this.indexer.badRows.length,
            warnings: this.done ? this.indexer.warnings.slice() : [],
        };
    }

    /** Rows whose byte range is fully known. */
    private readable(): number {
        const idx = this.indexer;
        return this.done ? idx.rowCount : Math.max(0, idx.starts.length - 1);
    }

    private get dataRowCount(): number {
        return Math.max(0, this.readable() - this.headerRows);
    }

    private waitForRows(n: number): Promise<void> {
        if (this.done || this.indexError || this.readable() >= n) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => this.waiters.push({ rows: n, resolve }));
    }

    private notify(): void {
        const available = this.readable();
        this.waiters = this.waiters.filter((w) => {
            if (this.done || this.indexError || available >= w.rows) {
                w.resolve();
                return false;
            }
            return true;
        });
    }

    private rowEnd(i: number): number {
        const starts = this.indexer.starts;
        return i + 1 < starts.length ? starts.get(i + 1) : this.size;
    }

    private async readFully(buf: Buffer, position: number): Promise<number> {
        let total = 0;
        while (total < buf.length) {
            const { bytesRead } = await this.file.read(buf, total, buf.length - total, position + total);
            if (bytesRead === 0) {
                break;
            }
            total += bytesRead;
        }
        return total;
    }

    /** Read and parse index rows [first, first+count) with a single disk read. */
    private async readRows(first: number, count: number): Promise<string[][]> {
        if (count <= 0) {
            return [];
        }
        const starts = this.indexer.starts;
        const from = starts.get(first);
        const to = this.rowEnd(first + count - 1);
        const buf = Buffer.allocUnsafe(to - from);
        await this.readFully(buf, from);
        const out: string[][] = [];
        for (let r = 0; r < count; r++) {
            const s = starts.get(first + r) - from;
            const e = this.rowEnd(first + r) - from;
            out.push(parseRow(this.decoder.decode(buf.subarray(s, e)), this.delimiter));
        }
        return out;
    }

    private async readDataRows(rowNumbers: number[]): Promise<string[][]> {
        const out: string[][] = [];
        for (const [start, n] of coalesce(rowNumbers)) {
            out.push(...(await this.readRows(this.headerRows + start, n)));
        }
        return out;
    }

    private badDataRows(): number[] {
        const bad = this.indexer.badRows;
        const out: number[] = [];
        for (let i = 0; i < bad.length; i++) {
            const r = bad.get(i) - this.headerRows;
            if (r >= 0) {
                out.push(r);
            }
        }
        return out;
    }

    /**
     * Visit data rows in the given runs, reading ~scanBytes at a time.
     * `visit` may return true to stop early. Yields to the event loop between windows
     * (the awaited disk read), so cancel messages are processed.
     */
    private async scan(
        runs: Run[],
        token: CancelToken,
        visit: (rowNum: number, fields: string[]) => boolean | void,
        tick: (scanned: number) => void,
    ): Promise<ScanOutcome> {
        const starts = this.indexer.starts;
        let scanned = 0;
        for (const [start, count] of runs) {
            let r = start;
            const end = start + count;
            while (r < end) {
                if (token.cancelled) {
                    return 'cancelled';
                }
                let n = 0;
                let bytes = 0;
                while (r + n < end && (n === 0 || bytes < this.tuning.scanBytes)) {
                    const i = this.headerRows + r + n;
                    bytes += this.rowEnd(i) - starts.get(i);
                    n++;
                }
                const rows = await this.readRows(this.headerRows + r, n);
                for (let k = 0; k < n; k++) {
                    if (visit(r + k, rows[k]) === true) {
                        return 'stopped';
                    }
                }
                r += n;
                scanned += n;
                tick(scanned);
            }
        }
        return 'complete';
    }
}
