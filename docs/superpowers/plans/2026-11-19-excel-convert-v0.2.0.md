# Excel Input and Format Conversion (v0.2.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open `.xlsx`/`.xlsm` files in the Data Toolkit viewer, and export (download/convert) the current view or the whole file to CSV, TSV, JSON, JSONL, SQL INSERT, Markdown or XLSX.

**Architecture:** Export is a streaming worker job built on a new `scanWindows` primitive in `CsvEngine`; each format is a pure `Formatter` (text formats) or an `exceljs` stream writer (XLSX). Excel input converts the chosen sheet once into a cached CSV under `globalStorageUri` (streaming, in the worker) and the existing viewer opens that CSV unchanged.

**Tech Stack:** TypeScript, esbuild, mocha (tdd UI), `exceljs` 4.4.0 as a **devDependency** (bundled into `out/csvWorker.js` by esbuild, so it is NOT shipped as `node_modules`; keeping it a devDependency stops `vsce` from packaging its 21 MB of files).

**Spec:** `docs/superpowers/specs/2026-11-19-csv-viewer-design.md` §8 features 20 (export formats) and Excel input (added by the user after the spec).

**Not in this release:** `.xls` and `.ods` input (exceljs streams `.xlsx` only), compare two files (v0.3.0), merge/join (v0.4.0). The v0.1.2 plan (`2026-11-19-csv-data-checks-v0.1.2.md`) is a separate release; if both are built, merge `protocol.ts` / `CsvSession.ts` edits carefully (both add message types).

## Global Constraints

- Webview CSP: nonce script only, no inline styles, no `innerHTML` (DOM via `h()` from `src/viewer/dom.ts`).
- `src/csv/core`, `src/csv/export`, `src/csv/import` and `src/csv/worker` must not import `vscode`.
- Long jobs take a `CancelToken`; cancelled export deletes its partial output file.
- Existing unit and integration tests must keep passing; `npm run typecheck` clean after every task.
- Verified by spike (Node 24, exceljs 4.4.0): the streaming reader lists sheet names without reading rows (152 ms for 200k rows); a full read of 200k rows takes 1.4 s; streaming writer round-trips; esbuild bundle ≈ 1.0 MB. Streaming-read cell values: strings, numbers, `Date` (or ISO string), `{formula, result}`, `{richText:[{text}]}`, `{text, hyperlink}`, `{error}`; empty cells are holes/`null` in `row.values` (1-indexed).
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

---

### Task 1: Pure text formatters

**Files:**
- Create: `src/csv/core/formats.ts`
- Test: `src/test/unit/formats.test.ts`

**Interfaces:**
- Produces:
```ts
export type TextFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'sql' | 'markdown';
export interface Formatter { begin(): string; row(fields: string[]): string; end(): string }
export interface FormatOptions { table?: string }
export function csvField(value: string, delimiter: string): string;
export function createFormatter(format: TextFormat, header: string[], options?: FormatOptions): Formatter;
export function uniqueKeys(header: string[]): string[];
```

- [ ] **Step 1: Write the failing test** `src/test/unit/formats.test.ts`

```ts
import * as assert from 'assert';
import { createFormatter, csvField, uniqueKeys } from '../../csv/core/formats';
import type { TextFormat } from '../../csv/core/formats';

function render(format: TextFormat, header: string[], rows: string[][], table?: string): string {
    const f = createFormatter(format, header, { table });
    return f.begin() + rows.map((r) => f.row(r)).join('') + f.end();
}
const H = ['id', 'name'];
const ROWS = [['1', 'Blue, "big"'], ['2', 'a\nb']];

suite('formats', () => {
    test('csvField quotes only when needed', () => {
        assert.strictEqual(csvField('plain', ','), 'plain');
        assert.strictEqual(csvField('a,b', ','), '"a,b"');
        assert.strictEqual(csvField('a"b', ','), '"a""b"');
        assert.strictEqual(csvField('a\nb', ','), '"a\nb"');
        assert.strictEqual(csvField('a,b', '\t'), 'a,b');
        assert.strictEqual(csvField('a\tb', '\t'), '"a\tb"');
    });
    test('csv', () => {
        assert.strictEqual(render('csv', H, ROWS), 'id,name\n1,"Blue, ""big"""\n2,"a\nb"\n');
    });
    test('tsv', () => {
        assert.strictEqual(render('tsv', H, [['1', 'x,y']]), 'id\tname\n1\tx,y\n');
    });
    test('json is a valid array of objects', () => {
        const out = render('json', H, ROWS);
        assert.deepStrictEqual(JSON.parse(out), [{ id: '1', name: 'Blue, "big"' }, { id: '2', name: 'a\nb' }]);
    });
    test('json with no rows is an empty array', () => {
        assert.deepStrictEqual(JSON.parse(render('json', H, [])), []);
    });
    test('jsonl is one object per line', () => {
        const lines = render('jsonl', H, ROWS).trimEnd().split('\n');
        assert.strictEqual(lines.length, 2);
        assert.deepStrictEqual(JSON.parse(lines[0]), { id: '1', name: 'Blue, "big"' });
    });
    test('duplicate header names get unique json keys', () => {
        assert.deepStrictEqual(uniqueKeys(['a', 'a', 'b', 'a']), ['a', 'a_2', 'b', 'a_3']);
        assert.deepStrictEqual(JSON.parse(render('jsonl', ['a', 'a'], [['1', '2']])), { a: '1', a_2: '2' });
    });
    test('markdown escapes pipes and newlines', () => {
        assert.strictEqual(
            render('markdown', H, [['1', 'a|b\nc']]),
            '| id | name |\n| --- | --- |\n| 1 | a\\|b<br>c |\n',
        );
    });
    test('sql quotes identifiers and strings', () => {
        assert.strictEqual(
            render('sql', ['id', 'na"me'], [['1', "O'Neil"]], 'my table'),
            'INSERT INTO "my table" ("id", "na""me") VALUES (\'1\', \'O\'\'Neil\');\n',
        );
    });
    test('sql defaults the table name to data', () => {
        assert.ok(render('sql', H, [['1', 'x']]).startsWith('INSERT INTO "data" '));
    });
});
```

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/csv/core/formats.ts`

```ts
export type TextFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'sql' | 'markdown';

export interface Formatter {
    /** Text written before the first row (header line, opening bracket, …). */
    begin(): string;
    row(fields: string[]): string;
    /** Text written after the last row. */
    end(): string;
}

export interface FormatOptions {
    table?: string;
}

export function csvField(value: string, delimiter: string): string {
    return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** JSON object keys from header names: a repeated name gets _2, _3, … */
export function uniqueKeys(header: string[]): string[] {
    const seen = new Map<string, number>();
    return header.map((name) => {
        const n = (seen.get(name) ?? 0) + 1;
        seen.set(name, n);
        return n === 1 ? name : `${name}_${n}`;
    });
}

function toObject(keys: string[], fields: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    keys.forEach((k, i) => {
        out[k] = fields[i] ?? '';
    });
    return out;
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const quoteString = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

export function createFormatter(format: TextFormat, header: string[], options: FormatOptions = {}): Formatter {
    switch (format) {
        case 'csv':
        case 'tsv': {
            const d = format === 'csv' ? ',' : '\t';
            const line = (fields: string[]): string => `${fields.map((f) => csvField(f, d)).join(d)}\n`;
            return { begin: () => line(header), row: line, end: () => '' };
        }
        case 'json': {
            const keys = uniqueKeys(header);
            let first = true;
            return {
                begin: () => '[',
                row: (fields) => {
                    const text = `${first ? '' : ','}\n  ${JSON.stringify(toObject(keys, fields))}`;
                    first = false;
                    return text;
                },
                end: () => '\n]\n',
            };
        }
        case 'jsonl': {
            const keys = uniqueKeys(header);
            return { begin: () => '', row: (fields) => `${JSON.stringify(toObject(keys, fields))}\n`, end: () => '' };
        }
        case 'markdown':
            return {
                begin: () => `| ${header.map(mdCell).join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n`,
                row: (fields) => `| ${header.map((_, i) => mdCell(fields[i] ?? '')).join(' | ')} |\n`,
                end: () => '',
            };
        case 'sql': {
            const prefix = `INSERT INTO ${quoteIdent(options.table || 'data')} (${header.map(quoteIdent).join(', ')}) VALUES (`;
            return {
                begin: () => '',
                row: (fields) => `${prefix}${header.map((_, i) => quoteString(fields[i] ?? '')).join(', ')});\n`,
                end: () => '',
            };
        }
    }
}
```

- [ ] **Step 4: Run** `npm run test:unit` and `npm run typecheck` — Expected: all pass. (JSON with zero rows renders `[` + `\n]\n`, which `JSON.parse` accepts.)

- [ ] **Step 5: Commit**
```bash
git add src/csv/core/formats.ts src/test/unit/formats.test.ts
git commit -m "Add pure text formatters (csv, tsv, json, jsonl, sql, markdown)"
```

---

### Task 2: Engine export scan and export-to-file (text formats and XLSX)

**Files:**
- Modify: `package.json` / `package-lock.json` (devDependency), `src/csv/core/engine.ts`, `src/csv/types.ts`
- Create: `src/csv/export/exportFile.ts`
- Test: `src/test/unit/exportFile.test.ts`

**Interfaces:**
- Consumes: `createFormatter`, `TextFormat` (Task 1); `CsvEngine.getInfo()`.
- Produces (types.ts): `export interface ExportProgress { done: number; total: number }`
- Produces (engine.ts): refactor `scan` onto a new private `scanWindows`, plus `async exportRows(scope: 'view' | 'all', token: CancelToken, onWindow: (rows: string[][]) => Promise<boolean | void>, onProgress?: (done: number, total: number) => void): Promise<'complete' | 'stopped' | 'cancelled'>` (public; `onWindow` returns `true` to stop early).
- Produces (exportFile.ts):
```ts
export type ExportFormat = TextFormat | 'xlsx';
export interface ExportOptions {
    format: ExportFormat;
    scope: 'view' | 'all';
    /** Column indexes to write, in output order. */
    columns: number[];
    outPath: string;
    table?: string;      // sql
    sheetName?: string;  // xlsx
}
export interface ExportResult { rows: number; truncated: boolean; path: string }
export const XLSX_MAX_ROWS = 1_048_576;
export function xlsxValue(v: string): string | number;
export function exportToFile(engine: CsvEngine, opts: ExportOptions, token: CancelToken,
    onProgress: (done: number, total: number) => void): Promise<ExportResult | null>; // null = cancelled
```

- [ ] **Step 1: Install** `npm install --save-dev exceljs@4.4.0`; confirm it appears under `devDependencies` and `npm run build` still succeeds.

- [ ] **Step 2: Write the failing tests** `src/test/unit/exportFile.test.ts`

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { CsvEngine, Tuning } from '../../csv/core/engine';
import { XLSX_MAX_ROWS, exportToFile, xlsxValue } from '../../csv/export/exportFile';
import type { ExportOptions } from '../../csv/export/exportFile';
import type { CancelToken } from '../../csv/types';

const TINY: Tuning = { chunkBytes: 7, scanBytes: 16, maxQuoteBytes: 1 << 20 };
const CSV = 'id,name,price\n1,Blue,10\n2,"Red, dark",\n3,Blue,30\n';
const live = (): CancelToken => ({ cancelled: false });
const noop = () => undefined;

suite('exportToFile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-export-'));
    const engines: CsvEngine[] = [];
    let counter = 0;

    async function load(content: string): Promise<CsvEngine> {
        const p = path.join(dir, `in${counter++}.csv`);
        fs.writeFileSync(p, content);
        const engine = new CsvEngine(p, {}, TINY);
        engines.push(engine);
        assert.strictEqual((await engine.open()).kind, 'ready');
        const indexing = engine.index(noop, live());
        await engine.getInfo();
        await indexing;
        return engine;
    }

    const out = (name: string): string => path.join(dir, name);
    const opts = (o: Partial<ExportOptions> & { outPath: string }): ExportOptions => ({
        format: 'csv', scope: 'all', columns: [0, 1, 2], ...o,
    });

    suiteTeardown(async () => {
        for (const e of engines) {
            await e.dispose();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('csv: all rows, all columns', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('a.csv') }), live(), noop);
        assert.deepStrictEqual(r, { rows: 3, truncated: false, path: out('a.csv') });
        assert.strictEqual(fs.readFileSync(out('a.csv'), 'utf8'), 'id,name,price\n1,Blue,10\n2,"Red, dark",\n3,Blue,30\n');
    });

    test('column subset and reorder', async () => {
        const engine = await load(CSV);
        await exportToFile(engine, opts({ outPath: out('b.csv'), columns: [1, 0] }), live(), noop);
        assert.strictEqual(fs.readFileSync(out('b.csv'), 'utf8'), 'name,id\nBlue,1\n"Red, dark",2\nBlue,3\n');
    });

    test('json', async () => {
        const engine = await load(CSV);
        await exportToFile(engine, opts({ outPath: out('c.json'), format: 'json', columns: [0, 1] }), live(), noop);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(out('c.json'), 'utf8')), [
            { id: '1', name: 'Blue' }, { id: '2', name: 'Red, dark' }, { id: '3', name: 'Blue' },
        ]);
    });

    test('view scope exports only the filtered rows', async () => {
        const engine = await load(CSV);
        await engine.filter([{ kind: 'columnIn', column: 1, values: ['Blue'] }], live(), noop);
        const r = await exportToFile(engine, opts({ outPath: out('d.csv'), scope: 'view' }), live(), noop);
        assert.strictEqual(r?.rows, 2);
        assert.strictEqual(fs.readFileSync(out('d.csv'), 'utf8'), 'id,name,price\n1,Blue,10\n3,Blue,30\n');
    });

    test('view scope with no active filter exports everything', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('e.csv'), scope: 'view' }), live(), noop);
        assert.strictEqual(r?.rows, 3);
    });

    test('progress reports done and total', async () => {
        const engine = await load(CSV);
        const seen: Array<[number, number]> = [];
        await exportToFile(engine, opts({ outPath: out('f.csv') }), live(), (d, t) => seen.push([d, t]));
        assert.ok(seen.length > 0);
        assert.deepStrictEqual(seen[seen.length - 1], [3, 3]);
    });

    test('cancelled export returns null and removes the partial file', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('g.csv') }), { cancelled: true }, noop);
        assert.strictEqual(r, null);
        assert.strictEqual(fs.existsSync(out('g.csv')), false);
    });

    test('unwritable path rejects', async () => {
        const engine = await load(CSV);
        await assert.rejects(() => exportToFile(engine, opts({ outPath: path.join(dir, 'no-such-dir', 'x.csv') }), live(), noop));
    });

    test('xlsx round trip with numbers kept as numbers', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('h.xlsx'), format: 'xlsx', sheetName: 'Items' }), live(), noop);
        assert.strictEqual(r?.rows, 3);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(out('h.xlsx'));
        const ws = wb.getWorksheet('Items');
        assert.ok(ws);
        assert.deepStrictEqual(ws.getRow(1).values, [undefined, 'id', 'name', 'price']);
        assert.deepStrictEqual(ws.getRow(2).values, [undefined, 1, 'Blue', 10]);
        assert.strictEqual(ws.getRow(3).getCell(2).value, 'Red, dark');
    });

    test('xlsxValue keeps leading zeros and long numbers as text', () => {
        assert.strictEqual(xlsxValue('42'), 42);
        assert.strictEqual(xlsxValue('-3.5'), -3.5);
        assert.strictEqual(xlsxValue('007'), '007');
        assert.strictEqual(xlsxValue('1234567890123456'), '1234567890123456');
        assert.strictEqual(xlsxValue('1e5'), '1e5');
        assert.strictEqual(xlsxValue(''), '');
        assert.strictEqual(XLSX_MAX_ROWS, 1_048_576);
    });
});
```

- [ ] **Step 3: Run** `npm run test:unit` — Expected: FAIL (module missing).

- [ ] **Step 4: Engine refactor.** In `src/csv/core/engine.ts` replace the private `scan` with a `scanWindows` plus a thin `scan` wrapper (behaviour identical; the existing engine tests guard this):

```ts
    private async scanWindows(
        runs: Run[],
        token: CancelToken,
        onWindow: (firstRow: number, rows: string[][]) => Promise<boolean | void> | boolean | void,
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
                if ((await onWindow(r, rows)) === true) {
                    return 'stopped';
                }
                r += n;
                scanned += n;
                tick(scanned);
            }
        }
        return 'complete';
    }

    private scan(
        runs: Run[],
        token: CancelToken,
        visit: (rowNum: number, fields: string[]) => boolean | void,
        tick: (scanned: number) => void,
    ): Promise<ScanOutcome> {
        return this.scanWindows(runs, token, (first, rows) => {
            for (let k = 0; k < rows.length; k++) {
                if (visit(first + k, rows[k]) === true) {
                    return true;
                }
            }
            return false;
        }, tick);
    }
```
Keep the existing doc comment on `scan`. Then add the public method (before `dispose`):

```ts
    /** Stream the rows of the current view (or the whole file) to `onWindow`, a window at a time. */
    async exportRows(
        scope: 'view' | 'all',
        token: CancelToken,
        onWindow: (rows: string[][]) => Promise<boolean | void>,
        onProgress?: (done: number, total: number) => void,
    ): Promise<ScanOutcome> {
        await this.indexFinished;
        this.throwIfIndexFailed();
        let runs: Run[];
        if (scope === 'view' && this.view) {
            if (!this.viewComplete) {
                throw new Error('Wait for the search to finish before exporting the filtered rows.');
            }
            runs = coalesce(this.view.slice(0, this.view.length));
        } else {
            runs = [[0, this.dataRowCount]];
        }
        const total = runs.reduce((n, r) => n + r[1], 0);
        return this.scanWindows(runs, token, (_first, rows) => onWindow(rows), (done) => onProgress?.(done, total));
    }
```
Also append `ExportProgress` to `src/csv/types.ts`.

- [ ] **Step 5: Implement** `src/csv/export/exportFile.ts`

```ts
import * as fs from 'fs';
import ExcelJS from 'exceljs';
import { createFormatter } from '../core/formats';
import type { TextFormat } from '../core/formats';
import type { CsvEngine } from '../core/engine';
import type { CancelToken } from '../types';

export type ExportFormat = TextFormat | 'xlsx';

export interface ExportOptions {
    format: ExportFormat;
    scope: 'view' | 'all';
    columns: number[];
    outPath: string;
    table?: string;
    sheetName?: string;
}

export interface ExportResult {
    rows: number;
    truncated: boolean;
    path: string;
}

export const XLSX_MAX_ROWS = 1_048_576;

/** Plain numbers become numeric cells; anything that could lose information (leading zeros, 16+ digits, exponents) stays text. */
export function xlsxValue(v: string): string | number {
    return /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v) ? Number(v) : v;
}

export async function exportToFile(
    engine: CsvEngine,
    opts: ExportOptions,
    token: CancelToken,
    onProgress: (done: number, total: number) => void,
): Promise<ExportResult | null> {
    const info = await engine.getInfo();
    const header = opts.columns.map((c) => info.header[c] ?? `Column ${c + 1}`);
    const pick = (row: string[]): string[] => opts.columns.map((c) => row[c] ?? '');
    const result = opts.format === 'xlsx'
        ? await writeXlsx(engine, opts, header, pick, token, onProgress)
        : await writeText(engine, opts, header, pick, token, onProgress);
    if (result === null) {
        await fs.promises.rm(opts.outPath, { force: true });
    }
    return result;
}

async function writeText(
    engine: CsvEngine,
    opts: ExportOptions,
    header: string[],
    pick: (row: string[]) => string[],
    token: CancelToken,
    onProgress: (done: number, total: number) => void,
): Promise<ExportResult | null> {
    const fmt = createFormatter(opts.format as Exclude<ExportFormat, 'xlsx'>, header, { table: opts.table });
    const stream = fs.createWriteStream(opts.outPath);
    await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', reject);
    });
    stream.on('error', () => undefined); // later failures surface through the write callbacks
    const write = (text: string): Promise<void> => text === ''
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => stream.write(text, (err) => (err ? reject(err) : resolve())));
    let rows = 0;
    try {
        await write(fmt.begin());
        const outcome = await engine.exportRows(opts.scope, token, async (window) => {
            rows += window.length;
            await write(window.map((r) => fmt.row(pick(r))).join(''));
        }, onProgress);
        if (outcome === 'cancelled') {
            stream.destroy();
            return null;
        }
        await write(fmt.end());
        await new Promise<void>((resolve) => stream.end(resolve));
        return { rows, truncated: false, path: opts.outPath };
    } catch (err) {
        stream.destroy();
        await fs.promises.rm(opts.outPath, { force: true });
        throw err;
    }
}

async function writeXlsx(
    engine: CsvEngine,
    opts: ExportOptions,
    header: string[],
    pick: (row: string[]) => string[],
    token: CancelToken,
    onProgress: (done: number, total: number) => void,
): Promise<ExportResult | null> {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: opts.outPath, useStyles: false, useSharedStrings: false });
    const ws = wb.addWorksheet((opts.sheetName || 'Data').slice(0, 31));
    ws.addRow(header).commit();
    let rows = 0;
    let truncated = false;
    const outcome = await engine.exportRows(opts.scope, token, async (window) => {
        for (const r of window) {
            if (rows + 1 >= XLSX_MAX_ROWS) {
                truncated = true;
                return true;
            }
            ws.addRow(pick(r).map(xlsxValue)).commit();
            rows++;
        }
        return false;
    }, onProgress);
    ws.commit();
    await wb.commit();
    return outcome === 'cancelled' ? null : { rows, truncated, path: opts.outPath };
}
```

- [ ] **Step 6: Run** `npm run test:unit`, `npm run typecheck`, `npm run build` — Expected: all pass; `out/csvWorker.js` grows to about 1 MB. If the build warns about exceljs optional requires, add `external` only for modules that fail to resolve, never `exceljs` itself.

- [ ] **Step 7: Commit**
```bash
git add package.json package-lock.json src/csv/core/engine.ts src/csv/types.ts src/csv/export/exportFile.ts src/test/unit/exportFile.test.ts
git commit -m "Add streaming export (csv/tsv/json/jsonl/sql/markdown/xlsx) to the engine"
```

---

### Task 3: Export UX (worker request, host flow, toolbar button, command)

**Files:**
- Modify: `src/csv/protocol.ts`, `src/csv/worker/csvWorker.ts`, `src/csv/CsvSession.ts`, `src/csv/CsvEditorProvider.ts`, `src/viewer/actions.ts`, `src/viewer/toolbar.ts`, `src/viewer/main.ts`, `package.json`

**Interfaces:**
- Consumes: `exportToFile`, `ExportOptions`, `ExportResult` (Task 2); `visibleColumns(layout)` (layout.ts).
- Produces:
  - `WorkerRequest` gains `| { id: number; type: 'export'; options: ExportOptions }`; `WorkerMessage` progress data becomes `IndexProgress | FilterProgress | ExportProgress`.
  - `ViewToHost` gains `| { type: 'export'; columns: number[] }`.
  - `ViewCommand` becomes `'hideSelectedColumn' | 'showAllColumns' | 'export'`.
  - `actions.ts`: `export function requestExport(): void` (posts `{type:'export', columns: visibleColumns(layout)}`).
  - Command `get-unique-values.csv.export` ("CSV Viewer: Export…") and `CsvSession.exportData(columns: number[]): Promise<void>`.

- [ ] **Step 1: protocol.ts** — apply the additions above (import `ExportOptions` from `./export/exportFile` and `ExportProgress` from `./types`; type-only imports keep exceljs out of the webview bundle).

- [ ] **Step 2: csvWorker.ts** — add a case after `'nonEmptyColumns'`:

```ts
            case 'export': {
                const token = tokenFor(req.id);
                try {
                    const result = await exportToFile(getEngine(), req.options, token, (done, total) =>
                        send({ type: 'progress', id: req.id, data: { done, total } }));
                    send({ type: 'result', id: req.id, data: result });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
```
(import `exportToFile` from `../export/exportFile`).

- [ ] **Step 3: CsvSession.ts** — add `case 'export': await this.exportData(m.columns); break;` to `handleMessage`, and:

```ts
    private async exportData(viewColumns: number[]): Promise<void> {
        const info = this.info;
        if (!info) {
            return;
        }
        const format = await vscode.window.showQuickPick<Item<ExportFormat>>(
            [
                { label: 'CSV', description: '.csv', value: 'csv' },
                { label: 'Excel', description: '.xlsx (numbers stay numbers, up to 1,048,575 rows)', value: 'xlsx' },
                { label: 'JSON', description: '.json array of objects', value: 'json' },
                { label: 'JSON Lines', description: '.jsonl, one object per line', value: 'jsonl' },
                { label: 'TSV', description: '.tsv', value: 'tsv' },
                { label: 'SQL INSERT', description: '.sql', value: 'sql' },
                { label: 'Markdown table', description: '.md', value: 'markdown' },
            ],
            { title: 'Export format' },
        );
        if (!format) {
            return;
        }
        const scope = await vscode.window.showQuickPick<Item<'view' | 'all'>>(
            [
                { label: 'Current view', description: 'filtered rows, visible columns', value: 'view' },
                { label: 'Whole file', description: 'every row and every column', value: 'all' },
            ],
            { title: 'What to export' },
        );
        if (!scope) {
            return;
        }
        let table: string | undefined;
        if (format.value === 'sql') {
            table = await vscode.window.showInputBox({
                title: 'SQL table name',
                value: path.basename(this.uri.fsPath).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'data',
            });
            if (table === undefined) {
                return;
            }
        }
        const ext = EXPORT_EXTENSIONS[format.value];
        const base = path.basename(this.uri.fsPath).replace(/\.[^.]+$/, '');
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(this.uri, '..', `${base}.${ext}`),
            filters: { [format.label]: [ext] },
            title: 'Export to',
        });
        if (!target) {
            return;
        }
        const columns = scope.value === 'all' ? Array.from({ length: info.columnCount }, (_, i) => i) : viewColumns;
        const options: ExportOptions = {
            format: format.value, scope: scope.value, columns, outPath: target.fsPath, table, sheetName: base.slice(0, 31),
        };
        try {
            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(target.fsPath)}`, cancellable: true },
                async (progress, cancelToken) => {
                    let last = 0;
                    const { id, promise } = this.worker.request<ExportResult | null>({ type: 'export', options }, (p) => {
                        const { done, total } = p as ExportProgress;
                        const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
                        progress.report({ increment: pct - last, message: `${done.toLocaleString()} of ${total.toLocaleString()} rows` });
                        last = pct;
                    });
                    cancelToken.onCancellationRequested(() => this.worker.cancel(id));
                    return promise;
                },
            );
            if (result === null) {
                void vscode.window.showInformationMessage('Export cancelled.');
                return;
            }
            const note = result.truncated ? ` (stopped at the Excel limit of ${XLSX_MAX_ROWS.toLocaleString()} rows)` : '';
            const choice = await vscode.window.showInformationMessage(
                `Exported ${result.rows.toLocaleString()} rows to ${path.basename(result.path)}${note}.`,
                'Open', 'Reveal in file manager',
            );
            if (choice === 'Open') {
                await vscode.commands.executeCommand('vscode.open', target);
            } else if (choice === 'Reveal in file manager') {
                await vscode.commands.executeCommand('revealFileInOS', target);
            }
        } catch (err) {
            void vscode.window.showErrorMessage(`Export failed: ${errorMessage(err)}`);
        }
    }
```
with, near the top of the file, `const EXPORT_EXTENSIONS: Record<ExportFormat, string> = { csv: 'csv', xlsx: 'xlsx', json: 'json', jsonl: 'jsonl', tsv: 'tsv', sql: 'sql', markdown: 'md' };` and type imports `ExportFormat, ExportOptions, ExportResult` plus `XLSX_MAX_ROWS` (value import is fine, it is a constant; but importing `exportFile.ts` pulls exceljs into the host bundle: so move `XLSX_MAX_ROWS` and the `ExportFormat/ExportOptions/ExportResult` types into `src/csv/types.ts` and re-export from `exportFile.ts`; keep the host free of exceljs)..

- [ ] **Step 4: Provider + command + keybinding context.** In `CsvEditorProvider.ts` register `vscode.commands.registerCommand('get-unique-values.csv.export', () => activeSession?.sendCommand('export'))`. In `package.json` add the command (`"title": "CSV Viewer: Export…"`).

- [ ] **Step 5: Webview.** `actions.ts`: add
```ts
import { visibleColumns } from '../csv/core/layout';

export function requestExport(): void {
    const layout = state.layout;
    if (layout) {
        post({ type: 'export', columns: visibleColumns(layout) });
    }
}
```
`toolbar.ts`: add `const exportBtn = button('Export…', 'Download the current view or the whole file as CSV, Excel, JSON, SQL, …', requestExport);` next to `resetBtn`, include it in the `root.append` row after `resetBtn`, and in the `ready` disabled list. `main.ts`: in the `'command'` case handle `m.name === 'export'` → `requestExport()` (keep the existing two branches).

- [ ] **Step 6: Run** `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:integration` — Expected: pass. Verify `out/extension.js` does NOT contain exceljs: `grep -c "WorkbookWriter" out/extension.js` prints 0.

- [ ] **Step 7: Commit**
```bash
git add -A
git commit -m "Add Export… (current view or whole file) with format picker and progress"
```

---

### Task 4: Open Excel (.xlsx/.xlsm) files

**Files:**
- Create: `src/csv/import/xlsx.ts`
- Test: `src/test/unit/xlsxImport.test.ts`
- Modify: `src/csv/protocol.ts`, `src/csv/worker/csvWorker.ts`, `src/csv/CsvSession.ts`, `src/csv/CsvEditorProvider.ts`, `package.json`

**Interfaces:**
- Consumes: `csvField` (Task 1); `ExcelJS` stream reader.
- Produces (xlsx.ts):
```ts
export function cellText(v: unknown): string;
export function listSheets(file: string): Promise<string[]>;
/** Stream sheet #sheetIndex (0-based) to a CSV file. Returns the data row count, or null when cancelled (output removed). */
export function convertSheetToCsv(file: string, sheetIndex: number, outPath: string, token: CancelToken, onProgress: (rows: number) => void): Promise<number | null>;
```
- Produces (protocol): `WorkerRequest` gains `| { id: number; type: 'xlsxSheets'; path: string } | { id: number; type: 'xlsxConvert'; path: string; sheet: number; out: string }`; progress data also allows `{ rows: number }` (add `ImportProgress { rows: number }` to types.ts).
- Produces (provider): second view type `export const XLSX_VIEW_TYPE = 'getUniqueValues.xlsxViewer'` registered with the same provider; command `get-unique-values.csv.chooseSheet` ("CSV Viewer: Choose Excel Sheet…").

- [ ] **Step 1: Write the failing tests** `src/test/unit/xlsxImport.test.ts`

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { cellText, convertSheetToCsv, listSheets } from '../../csv/import/xlsx';

const live = () => ({ cancelled: false });
const noop = () => undefined;

suite('xlsx import', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-xlsx-'));
    const book = path.join(dir, 'book.xlsx');

    suiteSetup(async () => {
        const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: book });
        const s1 = wb.addWorksheet('Products');
        s1.addRow(['sku', 'name', 'price', 'when']).commit();
        s1.addRow(['A1', 'Blue, "big"', 10.5, new Date('2024-01-02T00:00:00Z')]).commit();
        s1.addRow(['A2', { formula: '1+1', result: 2 }, '', 'x']).commit();
        s1.addRow(['A3', { richText: [{ text: 'Rich ' }, { text: 'text' }] }]).commit();
        s1.commit();
        const s2 = wb.addWorksheet('Other');
        s2.addRow(['z']).commit();
        s2.commit();
        await wb.commit();
    });

    suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('cellText covers every value shape', () => {
        assert.strictEqual(cellText(null), '');
        assert.strictEqual(cellText(undefined), '');
        assert.strictEqual(cellText('a'), 'a');
        assert.strictEqual(cellText(3.5), '3.5');
        assert.strictEqual(cellText(true), 'true');
        assert.strictEqual(cellText(new Date('2024-01-02T03:04:05Z')), '2024-01-02T03:04:05.000Z');
        assert.strictEqual(cellText({ formula: 'A1', result: 7 }), '7');
        assert.strictEqual(cellText({ formula: 'A1' }), '');
        assert.strictEqual(cellText({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab');
        assert.strictEqual(cellText({ text: 'link', hyperlink: 'http://x' }), 'link');
        assert.strictEqual(cellText({ error: '#N/A' }), '#N/A');
    });

    test('listSheets returns names in order', async () => {
        assert.deepStrictEqual(await listSheets(book), ['Products', 'Other']);
    });

    test('convert sheet 0 to csv', async () => {
        const out = path.join(dir, 'p.csv');
        const rows = await convertSheetToCsv(book, 0, out, live(), noop);
        assert.strictEqual(rows, 3);
        assert.strictEqual(
            fs.readFileSync(out, 'utf8'),
            'sku,name,price,when\nA1,"Blue, ""big""",10.5,2024-01-02T00:00:00.000Z\nA2,2,,x\nA3,Rich text,,\n',
        );
    });

    test('convert sheet 1', async () => {
        const out = path.join(dir, 'o.csv');
        assert.strictEqual(await convertSheetToCsv(book, 1, out, live(), noop), 0);
        assert.strictEqual(fs.readFileSync(out, 'utf8'), 'z\n');
    });

    test('unknown sheet index rejects', async () => {
        await assert.rejects(() => convertSheetToCsv(book, 5, path.join(dir, 'x.csv'), live(), noop));
    });

    test('cancelled conversion returns null and leaves no file', async () => {
        const out = path.join(dir, 'c.csv');
        assert.strictEqual(await convertSheetToCsv(book, 0, out, { cancelled: true }, noop), null);
        assert.strictEqual(fs.existsSync(out), false);
    });

    test('a non-xlsx file rejects with a clear error', async () => {
        const bad = path.join(dir, 'bad.xlsx');
        fs.writeFileSync(bad, 'not a zip');
        await assert.rejects(() => listSheets(bad));
    });
});
```
Note the header row of an Excel sheet is data row 1: the converted CSV's first row is the header, so `rows` counts data rows (3 for Products, 0 for Other since `z` is the header). Padding: a row shorter than the first row is padded with empty cells to the first row's width (`A3,Rich text,,` above); a longer row is kept as is.

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/csv/import/xlsx.ts`

```ts
import * as fs from 'fs';
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

export async function listSheets(file: string): Promise<string[]> {
    const names: string[] = [];
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, READER_OPTIONS);
    for await (const ws of reader) {
        names.push((ws as { name: string }).name);
    }
    return names;
}

export async function convertSheetToCsv(
    file: string,
    sheetIndex: number,
    outPath: string,
    token: CancelToken,
    onProgress: (rows: number) => void,
): Promise<number | null> {
    const tmp = `${outPath}.tmp`;
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
    };
    try {
        let current = -1;
        let found = false;
        let width = 0;
        let lines = 0;
        let buffer: string[] = [];
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, READER_OPTIONS);
        for await (const ws of reader) {
            current++;
            if (current !== sheetIndex) {
                continue;
            }
            found = true;
            for await (const row of ws as AsyncIterable<{ values: unknown }>) {
                if (token.cancelled) {
                    await cleanup();
                    return null;
                }
                const cells = (row.values as unknown[]).slice(1).map(cellText);
                if (lines === 0) {
                    width = cells.length;
                }
                while (cells.length < width) {
                    cells.push('');
                }
                buffer.push(`${cells.map((c) => csvField(c, ',')).join(',')}\n`);
                lines++;
                if (buffer.length >= 5000) {
                    await write(buffer.join(''));
                    buffer = [];
                    onProgress(Math.max(0, lines - 1));
                }
            }
            break;
        }
        if (!found) {
            throw new Error(`The workbook has no sheet number ${sheetIndex + 1}.`);
        }
        if (buffer.length > 0) {
            await write(buffer.join(''));
        }
        await new Promise<void>((resolve) => out.end(resolve));
        await fs.promises.rename(tmp, outPath);
        const rows = Math.max(0, lines - 1);
        onProgress(rows);
        return rows;
    } catch (err) {
        await cleanup();
        throw err;
    }
}
```
If a row's values array is shorter than `width` because Excel omits trailing empties, the padding loop handles it. An empty sheet produces an empty CSV file; the viewer then reports "This file is empty."

- [ ] **Step 4: Run** `npm run test:unit` — Expected: all pass. If `listSheets` on the invalid file hangs rather than rejecting, wrap the reader loop in a 30 s `Promise.race` timeout that rejects with "This does not look like an Excel (.xlsx) file."

- [ ] **Step 5: protocol.ts / csvWorker.ts.** Add the two `WorkerRequest` members and `ImportProgress` to the progress union; in the worker add:

```ts
            case 'xlsxSheets':
                send({ type: 'result', id: req.id, data: await listSheets(req.path) });
                return;
            case 'xlsxConvert': {
                const token = tokenFor(req.id);
                try {
                    const rows = await convertSheetToCsv(req.path, req.sheet, req.out, token, (n) =>
                        send({ type: 'progress', id: req.id, data: { rows: n } }));
                    send({ type: 'result', id: req.id, data: rows });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
```

- [ ] **Step 6: CsvSession.ts.** Add fields `private sheet: number | undefined;` and `private sheetName = '';`. In `openFile()`, replace the `path: this.uri.fsPath` / `options: this.parseOptions` arguments of the `'open'` request with the result of a new helper, called right after `const gen = ++this.openGen; …clear(); …` and before the `try`'s request (inside the `try`):

```ts
            const source = await this.resolveSource(gen);
            if (source === undefined || gen !== this.openGen) {
                return;
            }
```
then use `{ type: 'open', path: source.path, options: source.options }`, and `fileName: source.label` in the `opened` message. Add:

```ts
    /** The CSV file to open: the file itself, or the cached CSV conversion of the chosen Excel sheet. */
    private async resolveSource(gen: number): Promise<{ path: string; options: ParseOptions; label: string } | undefined> {
        const file = this.uri.fsPath;
        const base = path.basename(file);
        if (!/\.xls[xm]$/i.test(file)) {
            return { path: file, options: this.parseOptions, label: base };
        }
        const sheets = await this.worker.request<string[]>({ type: 'xlsxSheets', path: file }).promise;
        if (gen !== this.openGen) {
            return undefined;
        }
        if (sheets.length === 0) {
            this.post({ type: 'status', kind: 'error', message: 'This workbook has no sheets.' });
            return undefined;
        }
        if (this.sheet === undefined || this.sheet >= sheets.length) {
            if (sheets.length === 1) {
                this.sheet = 0;
            } else {
                const pick = await vscode.window.showQuickPick<Item<number>>(
                    sheets.map((name, i) => ({ label: name, value: i })),
                    { title: `Choose a sheet from ${base}`, placeHolder: 'Sheet' },
                );
                if (!pick) {
                    this.post({ type: 'status', kind: 'error', message: 'No sheet chosen. Run "CSV Viewer: Choose Excel Sheet…" to pick one.' });
                    return undefined;
                }
                this.sheet = pick.value;
            }
        }
        this.sheetName = sheets[this.sheet];
        const stat = await fs.promises.stat(file);
        const hash = createHash('sha1').update(`${file}|${stat.mtimeMs}|${stat.size}|${this.sheet}`).digest('hex').slice(0, 24);
        const cacheDir = path.join(this.context.globalStorageUri.fsPath, 'xlsx');
        await fs.promises.mkdir(cacheDir, { recursive: true });
        const out = path.join(cacheDir, `${hash}.csv`);
        const sheetIndex = this.sheet;
        if (!fs.existsSync(out)) {
            const rows = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Reading ${base} (${this.sheetName})`, cancellable: true },
                async (progress, cancelToken) => {
                    const { id, promise } = this.worker.request<number | null>(
                        { type: 'xlsxConvert', path: file, sheet: sheetIndex, out },
                        (p) => progress.report({ message: `${(p as ImportProgress).rows.toLocaleString()} rows` }),
                    );
                    cancelToken.onCancellationRequested(() => this.worker.cancel(id));
                    return promise;
                },
            );
            if (rows === null) {
                this.post({ type: 'status', kind: 'error', message: 'Reading the Excel file was cancelled. Reload to try again.' });
                return undefined;
            }
        }
        return { path: out, options: { ...this.parseOptions, delimiter: ',', encoding: 'utf-8' }, label: `${base} — ${this.sheetName}` };
    }

    /** Forget the chosen sheet and reopen (command "CSV Viewer: Choose Excel Sheet…"). */
    async chooseSheet(): Promise<void> {
        this.sheet = undefined;
        await this.openFile();
    }
```
Imports needed: `import * as fs from 'fs';`, `import { createHash, randomBytes } from 'crypto';`, `ImportProgress` from `./types`. Also: the `watcher` and `fileChanged` banner already cover `.xlsx` (cache key includes mtime, so Reload reconverts). Cache cleanup: in `CsvEditorProvider.registerCsvViewer`, on activation delete cache files older than 7 days (best-effort, errors ignored):

```ts
    void (async () => {
        const dir = path.join(context.globalStorageUri.fsPath, 'xlsx');
        try {
            for (const f of await fs.promises.readdir(dir)) {
                const p = path.join(dir, f);
                if (Date.now() - (await fs.promises.stat(p)).mtimeMs > 7 * 86_400_000) {
                    await fs.promises.rm(p, { force: true });
                }
            }
        } catch { /* no cache yet */ }
    })();
```

- [ ] **Step 7: Provider and package.json.** In `CsvEditorProvider.ts` export `XLSX_VIEW_TYPE = 'getUniqueValues.xlsxViewer'`, register the same `provider` for it too (same options), accept `.xlsx`/`.xlsm` in `openCsvViewer` (regex `/\.(csv|tsv|psv|xlsx|xlsm)$/i`; open with `XLSX_VIEW_TYPE` for Excel files, update the info message text to mention Excel), and register `get-unique-values.csv.chooseSheet` → `activeSession?.chooseSheet()`. In `package.json`: add a second `customEditors` entry `{ "viewType": "getUniqueValues.xlsxViewer", "displayName": "Excel Viewer", "priority": "default", "selector": [{"filenamePattern": "*.xlsx"}, {"filenamePattern": "*.xlsm"}] }`; add the `chooseSheet` command; extend the keybinding `when` clauses to `activeCustomEditorId == 'getUniqueValues.csvViewer' || activeCustomEditorId == 'getUniqueValues.xlsxViewer'`; extend any `resourceExtname` conditions in `menus` so "Open in CSV Viewer" also shows for `.xlsx`/`.xlsm`; add `onCustomEditor:getUniqueValues.xlsxViewer` to `activationEvents` if the file lists activation events explicitly.

- [ ] **Step 8: Run** `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:integration` — Expected: pass.

- [ ] **Step 9: Commit**
```bash
git add -A
git commit -m "Open .xlsx/.xlsm files in the viewer via a cached CSV conversion"
```

---

### Task 5: Release 0.2.0

**Files:** `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** `npm version 0.2.0 --no-git-tag-version`.
- [ ] **Step 2:** `CHANGELOG.md`: new `## [0.2.0]` / `### Added` — Excel (`.xlsx`, `.xlsm`) files open in the viewer with a sheet picker (converted once to a cached CSV, streamed, so large sheets work); **Export…** (toolbar and Command Palette) writes the current view or the whole file as CSV, Excel, JSON, JSON Lines, TSV, SQL INSERT or Markdown; command "Choose Excel Sheet…". `### Notes`: `.xls` and `.ods` are not supported yet.
- [ ] **Step 3:** README: add "Open Excel files" and "Export and convert" to the CSV Viewer feature list; update the extension description/keywords in `package.json` to mention Excel if a keyword list exists.
- [ ] **Step 4:** Verify everything: `npm run typecheck && npm run test:unit && npm run test:integration && npm run build`; then `npx @vscode/vsce package` and confirm `get-unique-values-0.2.0.vsix` is produced and its size is roughly 0.3-0.5 MB (not tens of MB; if it is large, exceljs was installed as a dependency instead of a devDependency).
- [ ] **Step 5: Commit**
```bash
git add package.json package-lock.json CHANGELOG.md README.md
git commit -m "Release 0.2.0: Excel input and export to many formats"
```
- [ ] **Step 6 (controller, manual):** F5 pass on the webview: open a real `.xlsx` (several sheets → picker), Export… each format from a filtered view and from the whole file, cancel an export, export to a read-only folder (error message). Do not publish until this passes.
