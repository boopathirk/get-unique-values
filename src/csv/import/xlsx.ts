/*
 * Excel to CSV conversion limits:
 *  - Fully empty rows are skipped by the streaming reader.
 *  - Every row is padded to the widest row's width (a narrow title row in A1 does not hide the table).
 *  - Inline rich text from stream-written files may lose its leading runs (an ExcelJS reader limitation).
 */
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import ExcelJS from 'exceljs';
import { csvField } from '../core/formats';
import type { CancelToken } from '../types';

const READER_OPTIONS = { sharedStrings: 'cache', worksheets: 'emit', hyperlinks: 'ignore', styles: 'cache' } as const;

export function cellText(v: unknown): string {
    if (v === null || v === undefined) {
        return '';
    }
    if (typeof v === 'string') {
        return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
        return String(v);
    }
    if (v instanceof Date) {
        return v.toISOString();
    }
    if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if ('result' in o) {
            return cellText(o.result);
        }
        if ('formula' in o || 'sharedFormula' in o) {
            return '';
        }
        if (Array.isArray(o.richText)) {
            return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('');
        }
        if ('text' in o) {
            return cellText(o.text);
        }
        if ('error' in o) {
            return String(o.error);
        }
    }
    return JSON.stringify(v);
}

/** Close a worksheet's source stream without reading it (ExcelJS leaves it open, leaking a file handle and later emitting an unhandled error). */
function discard(ws: unknown): void {
    const it = (ws as { iterator?: { destroy?: () => void; on?: (e: string, f: () => void) => void } }).iterator;
    try {
        it?.on?.('error', () => undefined);
        it?.destroy?.();
    } catch { /* already closed */ }
}

/** Close the workbook's underlying file stream (ExcelJS does not when iteration stops early). */
function closeReader(reader: unknown): void {
    const st = (reader as { stream?: { destroy?: () => void; on?: (e: string, f: () => void) => void } }).stream;
    try {
        st?.on?.('error', () => undefined);
        st?.destroy?.();
    } catch { /* already closed */ }
}

export async function listSheets(file: string): Promise<string[]> {
    const names: string[] = [];
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, READER_OPTIONS);
    try {
        for await (const ws of reader) {
            names.push((ws as unknown as { name: string }).name);
            discard(ws);
        }
    } finally {
        closeReader(reader);
    }
    return names;
}

/**
 * Copy the CSV `body` to `out`, appending empty fields so every row has `width` fields.
 * `lineBytes[i]` is the byte length of row i including its final newline (quoted fields may contain
 * newlines, so rows cannot be found by scanning); `cells[i]` is its field count.
 */
async function padRows(
    body: string,
    out: string,
    lineBytes: number[],
    cells: number[],
    width: number,
    token: CancelToken,
): Promise<boolean> {
    const input = fs.createReadStream(body, { highWaterMark: 1 << 20 });
    const output = fs.createWriteStream(out);
    output.on('error', () => undefined); // surfaced by the write callbacks
    const write = (chunk: Buffer): Promise<void> =>
        new Promise<void>((resolve, reject) => output.write(chunk, (err) => (err ? reject(err) : resolve())));
    let row = 0;
    let remaining = lineBytes[0] ?? 0;
    try {
        for await (const chunk of input as AsyncIterable<Buffer>) {
            if (token.cancelled) {
                return false;
            }
            const pieces: Buffer[] = [];
            let off = 0;
            while (off < chunk.length && row < lineBytes.length) {
                const take = Math.min(remaining, chunk.length - off);
                const ends = take === remaining;
                const contentEnd = ends ? off + take - 1 : off + take; // drop the row's newline, re-added after the padding
                if (contentEnd > off) {
                    pieces.push(chunk.subarray(off, contentEnd));
                }
                off += take;
                remaining -= take;
                if (ends) {
                    pieces.push(Buffer.from(`${','.repeat(Math.max(0, width - cells[row]))}\n`));
                    row++;
                    remaining = lineBytes[row] ?? 0;
                }
            }
            await write(Buffer.concat(pieces));
        }
        await new Promise<void>((resolve) => output.end(resolve));
        return true;
    } finally {
        input.destroy();
        output.destroy();
    }
}

export async function convertSheetToCsv(
    file: string,
    sheetIndex: number,
    outPath: string,
    token: CancelToken,
    onProgress: (rows: number) => void,
): Promise<number | null> {
    const tmp = `${outPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const padded = `${tmp}.padded`;
    const out = fs.createWriteStream(tmp);
    await new Promise<void>((resolve, reject) => {
        out.once('open', () => resolve());
        out.once('error', reject);
    });
    out.on('error', () => undefined);
    const write = (text: string): Promise<void> =>
        new Promise<void>((resolve, reject) => out.write(text, (err) => (err ? reject(err) : resolve())));
    const cleanup = async (): Promise<void> => {
        out.destroy();
        await fs.promises.rm(tmp, { force: true });
        await fs.promises.rm(padded, { force: true });
    };
    try {
        let current = -1;
        let found = false;
        let width = 0;
        let lines = 0;
        let buffer: string[] = [];
        // Per row: byte length (with newline) and field count, so rows narrower than the widest row can be
        // padded afterwards. Bounded by Excel's row limit (~1M rows, a few MB).
        const lineBytes: number[] = [];
        const cells: number[] = [];
        let ragged = false;
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, READER_OPTIONS);
        let chosen: unknown;
        let cancelled = false;
        try {
            // Keep iterating after the chosen sheet: ExcelJS only releases a sheet's temp file when the reader moves past it.
            for await (const ws of reader) {
                current++;
                if (current !== sheetIndex || cancelled) {
                    discard(ws);
                    continue;
                }
                found = true;
                chosen = ws;
                for await (const row of ws as unknown as AsyncIterable<{ values: unknown }>) {
                    if (token.cancelled) {
                        cancelled = true;
                        break;
                    }
                    const values = (row.values as unknown[]).slice(1).map(cellText);
                    // An empty row (cells with only a fill or border) is written as "": that is already one field.
                    const fields = Math.max(1, values.length);
                    if (lines > 0 && fields !== width) {
                        ragged = true;
                    }
                    width = Math.max(width, fields);
                    const line = `${values.map((c) => csvField(c, ',')).join(',')}\n`;
                    lineBytes.push(Buffer.byteLength(line));
                    cells.push(fields);
                    buffer.push(line);
                    lines++;
                    if (buffer.length >= 5000) {
                        await write(buffer.join(''));
                        buffer = [];
                        onProgress(Math.max(0, lines - 1));
                    }
                }
                discard(ws);
            }
        } finally {
            discard(chosen);
            closeReader(reader);
        }
        if (cancelled) {
            await cleanup();
            return null;
        }
        if (!found) {
            throw new Error(`The workbook has no sheet number ${sheetIndex + 1}.`);
        }
        if (buffer.length > 0) {
            await write(buffer.join(''));
        }
        await new Promise<void>((resolve) => out.end(resolve));
        let result = tmp;
        if (ragged) {
            if (!(await padRows(tmp, padded, lineBytes, cells, width, token))) {
                await cleanup();
                return null;
            }
            await fs.promises.rm(tmp, { force: true });
            result = padded;
        }
        try {
            await fs.promises.rename(result, outPath);
        } catch (err) {
            // Another conversion of the same sheet may have won the race.
            if (!fs.existsSync(outPath)) {
                throw err;
            }
            await fs.promises.rm(result, { force: true });
        }
        const rows = Math.max(0, lines - 1);
        onProgress(rows);
        return rows;
    } catch (err) {
        await cleanup();
        throw err;
    }
}
