# CSV Viewer v0.1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only large-file CSV viewer (pagination, search, unique values, filters, per-column colours, long-cell handling, column show/hide) to the `get-unique-values` VS Code extension and release it as 0.1.0.

**Architecture:** A worker thread owns a `CsvEngine` that streams the file once to build a byte-offset row index; pages, searches and unique-value scans read from disk on demand. A custom readonly editor hosts a vanilla-TypeScript webview that only ever holds the current page. All parsing logic lives in pure modules under `src/csv/core/` (no `vscode` import) so it is unit-tested in plain Node with mocha.

**Tech Stack:** TypeScript 5, VS Code API ^1.99 (custom editors, webviews, workspaceState), Node `worker_threads`, esbuild (bundling), mocha (tdd UI) for unit tests, `@vscode/test-electron` for one integration test. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-csv-viewer-design.md` (sections 1-7 plus the column show/hide parts of 4.3). The §8 feature catalog (M1-M3) is **out of scope for this plan**; each milestone gets its own plan.

**Repo:** `/home/dckap/get-unique-values`, branch `feature/csv-viewer`. All paths below are relative to that repo. Run every command from the repo root.

## Global Constraints

- `engines.vscode` stays `^1.99.0`; **no runtime dependencies** (esbuild, mocha and types are devDependencies only).
- Existing command `get-unique-values.run` and its keybinding `ctrl+alt+u` / `cmd+alt+u` keep behaving exactly as today (remove duplicate and empty lines, preserve order).
- Extension ID `get-unique-values` and publisher `boopathi08` unchanged. Version → `0.1.0`; displayName → `Get Unique Values & CSV Viewer`.
- Custom editor viewType `getUniqueValues.csvViewer`, selector `*.csv`, `*.tsv`, `*.psv`, `priority: "option"` (text editor stays default).
- Three esbuild bundles: `out/extension.js` (cjs, external `vscode`), `out/csvWorker.js` (cjs), `out/viewer.js` (iife) + `media/viewer.css`.
- Webview security: CSP `default-src 'none'` with nonce'd script and `cspSource` styles; cell values inserted with `textContent` only (never `innerHTML`); `localResourceRoots` limited to `out/` and `media/`; no remote content.
- Settings (all under `getUniqueValues.csv.`): `defaultPageSize` (50/100/250/500/1000, default 100), `columnColors` (`header` | `headerAndCells` | `off`, default `headerAndCells`), `longText` (`truncate` | `wrap` | `full`, default `truncate`), `defaultColumnWidth` (px, default 300).
- Row index chunk 1 MB; scan window 4 MB; unclosed quote recovery after 1 MB; first 64 KB sampled for detection; unique values display cap 100,000; cell tooltip = first 500 characters; column hue = `(index × 137.508°) mod 360`.
- Code style: ESLint `curly`, `eqeqeq`, `semi` are on, so always use braces, `===` and semicolons.
- Commit trailer on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Deviations from the spec (synced into the spec in Task 15)

1. Viewer sources live in `src/viewer/` (not `media/viewer/`); only `viewer.css` is in `media/`. Shared pure types live in `src/csv/types.ts`.
2. UTF-16 files are *detected* but show an "unsupported encoding until v0.2" message (spec §8.6 already schedules UTF-16 for M2).
3. The 5-page LRU cache (spec §3.2) is dropped: a page read is one `fs.read` and is already fast.
4. The unique-values panel renders at most 500 rows at a time (narrow with its search box); the 100,000 cap stays for what the worker returns.
5. "Show only columns with active filter or search hit" is implemented as "columns that have a column filter or are the search column".
6. The perf script's synthetic data is two shapes (mixed ≈ 600k rows with long descriptions on every 10th row, narrow ≈ 1.5M short rows) because "1.5M rows × 1-4 KB" cannot fit in 300 MB.

## File Structure

```
package.json, tsconfig.json, tsconfig.test.json, esbuild.mjs        (Task 1)
src/extension.ts            activate(): lineTools + CSV viewer; returns test API
src/lineTools.ts            existing dedupe command, moved unchanged
src/csv/types.ts            pure shared data types (FileInfo, PageResult, ...)
src/csv/protocol.ts         worker + webview message unions
src/csv/WorkerClient.ts     request/response wrapper over worker_threads
src/csv/CsvEditorProvider.ts  custom editor registration + open command
src/csv/CsvSession.ts       one per open editor: worker, webview, persistence, watcher
src/csv/worker/csvWorker.ts worker entry: wraps CsvEngine
src/csv/core/               pure modules (unit-tested in Node):
    resultSet.ts            GrowableF64, ResultSet (Uint32), coalesce()
    rowIndexer.ts           streaming quote-aware row-offset indexer
    rowParser.ts            parseRow(): one row's text -> fields
    detect.ts               encoding / binary / delimiter / header detection
    predicates.ts           Predicate -> compiled row test
    layout.ts               Layout model, sanitize, column ops helpers
    colors.ts               per-column colours
    textUtil.ts             language guess, row -> CSV/JSON, truncate
    engine.ts               CsvEngine: open, index, pages, filter, unique, empty cols
src/viewer/                 webview (vanilla TS): main, state, actions, dom, table,
                            toolbar, sidePanel, uniquePanel, detailPanel,
                            columnPicker, layoutOps (+ tsconfig.json)
media/viewer.css
scripts/perf.mjs
src/test/unit/*.test.ts     mocha tests for core + WorkerClient
src/test/integration/*.test.ts  vscode-test smoke
```

---

### Task 1: Tooling and restructure

**Files:**
- Create: `esbuild.mjs`, `tsconfig.test.json`, `src/viewer/tsconfig.json`, `src/lineTools.ts`
- Modify: `package.json` (scripts, devDependencies), `tsconfig.json`, `src/extension.ts`, `.gitignore`, `.vscodeignore`, `.vscode-test.mjs`, `.vscode/tasks.json`, `.vscode/extensions.json`
- Move: `src/test/extension.test.ts` → `src/test/integration/extension.test.ts`

**Interfaces:**
- Produces: `registerLineTools(context: vscode.ExtensionContext): void` in `src/lineTools.ts`; npm scripts `build`, `typecheck`, `test:unit`, `test:integration`, `perf`.

- [ ] **Step 1: Install dev dependencies**

```bash
npm install -D esbuild mocha
```
Expected: `package.json` devDependencies now list `esbuild` and `mocha`; exit code 0.

- [ ] **Step 2: Create `esbuild.mjs`**

```js
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

// Entries that do not exist yet are skipped so the build works at every task.
const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: ['src/csv/worker/csvWorker.ts'], outfile: 'out/csvWorker.js', platform: 'node', format: 'cjs', target: 'node20' },
  { ...common, entryPoints: ['src/viewer/main.ts'], outfile: 'out/viewer.js', platform: 'browser', format: 'iife', target: 'es2022' },
].filter((t) => existsSync(t.entryPoints[0]));

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context(t);
    await ctx.watch();
  }
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
```

- [ ] **Step 3: Replace `tsconfig.json`** (type-check only; esbuild emits)

```json
{
	"compilerOptions": {
		"module": "Node16",
		"target": "ES2022",
		"lib": ["ES2022"],
		"rootDir": "src",
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true
	},
	"include": ["src/**/*.ts"],
	"exclude": ["src/viewer", "src/test"]
}
```

- [ ] **Step 4: Create `tsconfig.test.json`** (compiles pure core + tests to `out-test/` with tsc)

```json
{
	"compilerOptions": {
		"module": "Node16",
		"target": "ES2022",
		"lib": ["ES2022"],
		"rootDir": "src",
		"outDir": "out-test",
		"strict": true,
		"sourceMap": true,
		"skipLibCheck": true
	},
	"include": ["src/test/**/*.ts", "src/csv/core/**/*.ts", "src/csv/types.ts", "src/csv/protocol.ts", "src/csv/WorkerClient.ts"]
}
```

- [ ] **Step 5: Create `src/viewer/tsconfig.json`** (webview is type-checked with the DOM lib)

```json
{
	"compilerOptions": {
		"module": "ES2022",
		"moduleResolution": "Bundler",
		"target": "ES2022",
		"lib": ["ES2022", "DOM"],
		"strict": true,
		"noEmit": true,
		"skipLibCheck": true,
		"types": []
	},
	"include": ["./**/*.ts"]
}
```
Also create the temporary file `src/viewer/placeholder.ts` containing exactly `export {};` (so `tsc -p src/viewer` has an input; Task 11 deletes it).

Note: `types: []` means viewer code can only import pure modules (`src/csv/types.ts`, `protocol.ts`, `core/predicates|layout|colors|textUtil`). Never import `engine.ts`/`WorkerClient.ts` from the viewer.

- [ ] **Step 6: Move line tools out of `extension.ts`**

Create `src/lineTools.ts` (the existing logic, unchanged, wrapped in a register function):

```ts
import * as vscode from 'vscode';

export function registerLineTools(context: vscode.ExtensionContext): void {
    const singleFileCommand = vscode.commands.registerCommand('get-unique-values.run', () => {
        processActiveEditor();
    });
    context.subscriptions.push(singleFileCommand);
}

function processActiveEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('No active editor found!');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;

    // Get text from selection or entire document
    const text = selection.isEmpty
        ? document.getText()
        : document.getText(selection);

    // Split lines, filter out empty lines, filter unique, preserve order
    const lines = text.split(/\r?\n/);
    const nonEmptyLines = lines.filter(line => line.trim() !== '');
    const uniqueLines = Array.from(new Set(nonEmptyLines)).join('\n');

    editor.edit(editBuilder => {
        if (selection.isEmpty) {
            // Replace entire document
            const firstLine = document.lineAt(0);
            const lastLine = document.lineAt(document.lineCount - 1);
            const fullRange = new vscode.Range(firstLine.range.start, lastLine.range.end);
            editBuilder.replace(fullRange, uniqueLines);
        } else {
            // Replace selected text
            editBuilder.replace(selection, uniqueLines);
        }
    });
}
```

Replace `src/extension.ts` entirely with:

```ts
import * as vscode from 'vscode';
import { registerLineTools } from './lineTools';

export function activate(context: vscode.ExtensionContext) {
    registerLineTools(context);
}

export function deactivate() { }
```
(Task 10 extends `activate` to also register the CSV viewer and return its test API.)

- [ ] **Step 7: Move the integration test and update configs**

```bash
mkdir -p src/test/integration src/test/unit
git mv src/test/extension.test.ts src/test/integration/extension.test.ts
echo "out-test" >> .gitignore
```

Replace `.vscode-test.mjs` with:

```js
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out-test/test/integration/**/*.test.js',
});
```

Replace `.vscodeignore` with:

```
.vscode/**
.vscode-test/**
src/**
out-test/**
scripts/**
docs/**
node_modules/**
esbuild.mjs
.gitignore
.yarnrc
vsc-extension-quickstart.md
**/tsconfig*.json
**/eslint.config.mjs
**/*.map
**/*.ts
**/.vscode-test.*
```

Replace `.vscode/tasks.json` with a one-shot build (the old `$tsc-watch` matcher never completes with esbuild):

```json
{
	"version": "2.0.0",
	"tasks": [
		{
			"type": "npm",
			"script": "build",
			"problemMatcher": [],
			"group": { "kind": "build", "isDefault": true }
		}
	]
}
```

In `.vscode/extensions.json` change `"boopathi.get-unique-values"` to `"boopathi08.get-unique-values"`.

- [ ] **Step 8: Replace the `scripts` block in `package.json`**

Replace the whole existing `"scripts": { ... }` object with:

```json
"scripts": {
    "vscode:prepublish": "npm run typecheck && node esbuild.mjs --production",
    "build": "node esbuild.mjs",
    "compile": "npm run typecheck && node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc -p ./ --noEmit && tsc -p src/viewer --noEmit",
    "lint": "eslint src",
    "test:unit": "node esbuild.mjs && tsc -p tsconfig.test.json && mocha --ui tdd \"out-test/test/unit/**/*.test.js\"",
    "test:integration": "node esbuild.mjs && tsc -p tsconfig.test.json && vscode-test",
    "pretest": "npm run typecheck && npm run lint",
    "test": "npm run test:unit && npm run test:integration",
    "perf": "tsc -p tsconfig.test.json && node --expose-gc scripts/perf.mjs"
},
```

- [ ] **Step 9: Verify**

Run: `npm run typecheck && npm run build && ls out`
Expected: both type-checks pass silently; esbuild prints the `out/extension.js` size; `ls out` shows `extension.js`.

- [ ] **Step 10: Commit**

```bash
git add esbuild.mjs tsconfig.json tsconfig.test.json src/viewer package.json package-lock.json src/extension.ts src/lineTools.ts src/test .gitignore .vscodeignore .vscode-test.mjs .vscode/tasks.json .vscode/extensions.json
git commit -m "Bundle with esbuild, split line tools, add test tooling" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared types and result sets

**Files:**
- Create: `src/csv/types.ts`, `src/csv/core/resultSet.ts`, `src/test/unit/resultSet.test.ts`

**Interfaces:**
- Produces (`types.ts`): `Encoding`, `ParseOptions`, `IndexWarning`, `FileInfo`, `IndexProgress`, `FilterProgress`, `PageResult`, `UniqueEntry`, `UniqueResult`, `CancelToken`, `OpenResult`, `FilterResult` (exact definitions below).
- Produces (`resultSet.ts`): `class GrowableF64 { length: number; push(v: number): void; get(i: number): number }`, `class ResultSet { length: number; push(v: number): void; get(i: number): number; slice(start: number, end: number): number[] }`, `coalesce(nums: number[]): Array<[number, number]>` (runs as `[start, count]`).

- [ ] **Step 1: Create `src/csv/types.ts`**

```ts
// Pure shared types: safe to import from the extension host, worker and webview.

export type Encoding = 'utf-8' | 'latin1' | 'utf-16le' | 'utf-16be';

export interface ParseOptions {
    delimiter?: string;
    hasHeader?: boolean;
    encoding?: 'utf-8' | 'latin1';
}

export interface IndexWarning {
    kind: 'unclosed-quote';
    /** 0-based index row (header counts as row 0). */
    row: number;
    offset: number;
}

export interface FileInfo {
    header: string[];
    columnCount: number;
    delimiter: string;
    hasHeader: boolean;
    encoding: Encoding;
    size: number;
}

export interface IndexProgress {
    /** Data rows indexed so far (header excluded). */
    rows: number;
    bytes: number;
    total: number;
    done: boolean;
    badRows: number;
    warnings: IndexWarning[];
}

export interface FilterProgress {
    matches: number;
    scanned: number;
    total: number;
}

export interface PageResult {
    /** 0-based data row numbers for each returned row. */
    rowNumbers: number[];
    rows: string[][];
    /** Rows in the current view (all rows, or matches so far). */
    total: number;
    /** False while indexing / filtering is still running. */
    complete: boolean;
}

export interface UniqueEntry {
    value: string;
    count: number;
}

export interface UniqueResult {
    column: number;
    entries: UniqueEntry[];
    distinct: number;
    total: number;
    truncated: boolean;
}

export interface CancelToken {
    cancelled: boolean;
}

export type OpenResult =
    | { kind: 'ok'; info: FileInfo }
    | { kind: 'empty' }
    | { kind: 'binary' }
    | { kind: 'unsupported-encoding'; encoding: string };

export interface FilterResult {
    matches: number;
    complete: boolean;
}
```

- [ ] **Step 2: Write the failing test** `src/test/unit/resultSet.test.ts`

```ts
import * as assert from 'assert';
import { GrowableF64, ResultSet, coalesce } from '../../csv/core/resultSet';

suite('resultSet', () => {
    test('GrowableF64 grows past its initial capacity', () => {
        const g = new GrowableF64();
        for (let i = 0; i < 5000; i++) {
            g.push(i * 2);
        }
        assert.strictEqual(g.length, 5000);
        assert.strictEqual(g.get(0), 0);
        assert.strictEqual(g.get(4999), 9998);
    });

    test('GrowableF64 stores values above 2^32', () => {
        const g = new GrowableF64();
        g.push(5_000_000_000);
        assert.strictEqual(g.get(0), 5_000_000_000);
    });

    test('ResultSet grows and slices', () => {
        const r = new ResultSet();
        for (let i = 0; i < 3000; i++) {
            r.push(i);
        }
        assert.strictEqual(r.length, 3000);
        assert.deepStrictEqual(r.slice(2, 5), [2, 3, 4]);
        assert.deepStrictEqual(r.slice(2998, 5000), [2998, 2999]);
        assert.deepStrictEqual(r.slice(10, 10), []);
    });

    test('coalesce merges consecutive numbers into runs', () => {
        assert.deepStrictEqual(coalesce([1, 2, 3, 7, 8, 10]), [[1, 3], [7, 2], [10, 1]]);
        assert.deepStrictEqual(coalesce([]), []);
        assert.deepStrictEqual(coalesce([5]), [[5, 1]]);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL (TypeScript error `Cannot find module '../../csv/core/resultSet'`).

- [ ] **Step 4: Implement `src/csv/core/resultSet.ts`**

```ts
/** Growable list of byte offsets (needs doubles: files can exceed 4 GB). */
export class GrowableF64 {
    private buf = new Float64Array(1024);
    length = 0;

    push(v: number): void {
        if (this.length === this.buf.length) {
            const next = new Float64Array(this.buf.length * 2);
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.length++] = v;
    }

    get(i: number): number {
        return this.buf[i];
    }
}

/** Growable list of row numbers (4 bytes per entry). */
export class ResultSet {
    private buf = new Uint32Array(1024);
    length = 0;

    push(v: number): void {
        if (this.length === this.buf.length) {
            const next = new Uint32Array(this.buf.length * 2);
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.length++] = v;
    }

    get(i: number): number {
        return this.buf[i];
    }

    slice(start: number, end: number): number[] {
        const stop = Math.min(end, this.length);
        const out: number[] = [];
        for (let i = start; i < stop; i++) {
            out.push(this.buf[i]);
        }
        return out;
    }
}

/** Merge ascending row numbers into `[start, count]` runs of consecutive rows. */
export function coalesce(nums: number[]): Array<[number, number]> {
    const runs: Array<[number, number]> = [];
    for (const n of nums) {
        const last = runs[runs.length - 1];
        if (last && last[0] + last[1] === n) {
            last[1]++;
        } else {
            runs.push([n, 1]);
        }
    }
    return runs;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:unit`
Expected: PASS (4 passing).

- [ ] **Step 6: Commit**

```bash
git add src/csv/types.ts src/csv/core/resultSet.ts src/test/unit/resultSet.test.ts
git commit -m "Add shared csv types and growable result sets" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Row indexer (streaming, quote-aware)

**Files:**
- Create: `src/csv/core/rowIndexer.ts`, `src/test/unit/rowIndexer.test.ts`

**Interfaces:**
- Consumes: `GrowableF64`, `ResultSet` (Task 2), `IndexWarning` (`types.ts`).
- Produces:
  ```ts
  interface IndexerOptions { delimiter: number; quote: number; maxQuoteBytes: number }
  class RowIndexer {
    readonly starts: GrowableF64;     // byte offset of each non-empty row, in order
    readonly badRows: ResultSet;      // index-row numbers whose field count differs from row 0
    readonly warnings: IndexWarning[];
    rowCount: number;                 // rows that have ended
    constructor(options: IndexerOptions);
    push(chunk: Uint8Array, base: number): number | undefined; // rewind offset, or undefined
    finish(): number | undefined;                              // rewind offset, or undefined
  }
  ```
  **Caller contract:** if `push`/`finish` returns an offset, discard the rest of the chunk and continue reading from that file offset (the engine and test helper both do this). Blank lines are never rows. Row `r` spans `starts[r]` to `starts[r+1]` (or end of file), trailing newlines included.

How it works (read before coding): a byte state machine. A quote only *opens* a quoted field at field start; inside quotes a quote closes, and a quote immediately after a closing quote re-opens (the `""` escape); a quote in the middle of an unquoted field is literal. Delimiters and newlines inside quotes are content. A row starts at its first non-newline byte, so CRLF, LF, CR and blank lines need no special state. If a quote stays open longer than `maxQuoteBytes` or reaches EOF, the indexer records a warning, asks the caller to rewind to the opening quote, and ignores quotes until the end of that line ("line mode").

- [ ] **Step 1: Write the failing tests** `src/test/unit/rowIndexer.test.ts`

```ts
import * as assert from 'assert';
import { RowIndexer, IndexerOptions } from '../../csv/core/rowIndexer';

interface Result {
    starts: number[];
    rowCount: number;
    bad: number[];
    warnings: Array<{ kind: string; row: number; offset: number }>;
}

function indexAll(text: string, chunk: number, options: Partial<IndexerOptions> = {}): Result {
    const bytes = Buffer.from(text, 'utf8');
    const idx = new RowIndexer({ delimiter: 44, quote: 34, maxQuoteBytes: 1 << 20, ...options });
    let pos = 0;
    for (;;) {
        while (pos < bytes.length) {
            const end = Math.min(pos + chunk, bytes.length);
            const rewind = idx.push(bytes.subarray(pos, end), pos);
            pos = rewind !== undefined ? rewind : end;
        }
        const rewind = idx.finish();
        if (rewind === undefined) {
            break;
        }
        pos = rewind;
    }
    const starts: number[] = [];
    for (let i = 0; i < idx.starts.length; i++) {
        starts.push(idx.starts.get(i));
    }
    const bad: number[] = [];
    for (let i = 0; i < idx.badRows.length; i++) {
        bad.push(idx.badRows.get(i));
    }
    return { starts, rowCount: idx.rowCount, bad, warnings: idx.warnings };
}

const CHUNKS = [1, 2, 3, 5, 7, 1 << 20];

function expectAll(text: string, expected: Partial<Result>, options: Partial<IndexerOptions> = {}): void {
    for (const chunk of CHUNKS) {
        const got = indexAll(text, chunk, options);
        for (const [key, value] of Object.entries(expected)) {
            assert.deepStrictEqual((got as unknown as Record<string, unknown>)[key], value, `chunk=${chunk} key=${key}`);
        }
    }
}

suite('rowIndexer', () => {
    test('LF rows', () => {
        expectAll('a,b\n1,2\n3,4\n', { starts: [0, 4, 8], rowCount: 3, bad: [] });
    });

    test('CRLF rows, no trailing newline', () => {
        expectAll('a,b\r\n1,2\r\n3,4', { starts: [0, 5, 10], rowCount: 3 });
    });

    test('CR-only rows', () => {
        expectAll('a,b\r1,2\r3,4\r', { starts: [0, 4, 8], rowCount: 3 });
    });

    test('blank lines are not rows', () => {
        expectAll('a,b\n\n\n1,2', { starts: [0, 6], rowCount: 2 });
    });

    test('newline inside quotes stays in the row', () => {
        expectAll('a,b\n"x\ny",2\nz,3', { starts: [0, 4, 12], rowCount: 3, bad: [] });
    });

    test('doubled quotes are an escape', () => {
        expectAll('a,b\n"he said ""hi""",2\nz,3\n', { starts: [0, 4, 23], rowCount: 3, bad: [] });
    });

    test('delimiter inside quotes is not counted', () => {
        expectAll('a,b\n"1,5",2\n', { rowCount: 2, bad: [] });
    });

    test('quote in the middle of an unquoted field is literal', () => {
        expectAll('a,b\nab"c,d\ne,f\n', { starts: [0, 4, 11], rowCount: 3, bad: [] });
    });

    test('rows with the wrong field count are recorded', () => {
        expectAll('a,b\n1,2,3\n4\n5,6\n', { starts: [0, 4, 10, 12], rowCount: 4, bad: [1, 2] });
    });

    test('unclosed quote past maxQuoteBytes is recovered line by line', () => {
        expectAll(
            'a,b\n"oops,1\nx,2\ny,3\n',
            { starts: [0, 4, 12, 16], rowCount: 4, bad: [], warnings: [{ kind: 'unclosed-quote', row: 1, offset: 4 }] },
            { maxQuoteBytes: 4 },
        );
    });

    test('unclosed quote at end of file is recovered', () => {
        expectAll('a,b\n"x,1', {
            starts: [0, 4],
            rowCount: 2,
            bad: [],
            warnings: [{ kind: 'unclosed-quote', row: 1, offset: 4 }],
        });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL (`Cannot find module '../../csv/core/rowIndexer'`).

- [ ] **Step 3: Implement `src/csv/core/rowIndexer.ts`**

```ts
import { GrowableF64, ResultSet } from './resultSet';
import type { IndexWarning } from '../types';

export interface IndexerOptions {
    delimiter: number;
    quote: number;
    maxQuoteBytes: number;
}

const LF = 10;
const CR = 13;

export class RowIndexer {
    readonly starts = new GrowableF64();
    readonly badRows = new ResultSet();
    readonly warnings: IndexWarning[] = [];
    rowCount = 0;

    private expectedFields = 0;
    private rowOpen = false;
    private fieldCount = 0;
    private inQuote = false;
    private quoteJustClosed = false;
    private atFieldStart = false;
    private lineMode = false;
    private quoteOpenedAt = 0;
    private fieldsAtQuote = 0;

    constructor(private readonly options: IndexerOptions) { }

    /** Returns a file offset to rewind to (discarding the rest of this chunk), or undefined. */
    push(chunk: Uint8Array, base: number): number | undefined {
        const { delimiter, quote, maxQuoteBytes } = this.options;
        for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            const off = base + i;

            if (!this.inQuote && (b === LF || b === CR)) {
                if (this.rowOpen) {
                    this.endRow();
                }
                this.lineMode = false;
                this.quoteJustClosed = false;
                continue;
            }

            if (!this.rowOpen) {
                this.starts.push(off);
                this.rowOpen = true;
                this.fieldCount = 1;
                this.atFieldStart = true;
            }

            if (this.inQuote && off - this.quoteOpenedAt > maxQuoteBytes) {
                return this.recover();
            }

            if (b === quote && !this.lineMode) {
                if (this.inQuote) {
                    this.inQuote = false;
                    this.quoteJustClosed = true;
                } else if (this.quoteJustClosed) {
                    this.inQuote = true; // "" escape: reopen
                    this.quoteJustClosed = false;
                } else if (this.atFieldStart) {
                    this.inQuote = true;
                    this.quoteOpenedAt = off;
                    this.fieldsAtQuote = this.fieldCount;
                }
                this.atFieldStart = false;
                continue;
            }

            this.quoteJustClosed = false;
            if (!this.inQuote && b === delimiter) {
                this.fieldCount++;
                this.atFieldStart = true;
            } else {
                this.atFieldStart = false;
            }
        }
        return undefined;
    }

    /** Call at end of file. Returns a rewind offset if a quote was left open. */
    finish(): number | undefined {
        if (this.inQuote) {
            return this.recover();
        }
        if (this.rowOpen) {
            this.endRow();
        }
        return undefined;
    }

    private recover(): number {
        this.warnings.push({ kind: 'unclosed-quote', row: this.starts.length - 1, offset: this.quoteOpenedAt });
        this.inQuote = false;
        this.quoteJustClosed = false;
        this.atFieldStart = false;
        this.lineMode = true;
        this.fieldCount = this.fieldsAtQuote;
        return this.quoteOpenedAt;
    }

    private endRow(): void {
        if (this.rowCount === 0) {
            this.expectedFields = this.fieldCount;
        } else if (this.fieldCount !== this.expectedFields) {
            this.badRows.push(this.rowCount);
        }
        this.rowCount++;
        this.rowOpen = false;
        this.inQuote = false;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS. If a chunk-size variant fails, the failure message names `chunk=` and `key=`; the bug is in state carried across chunks (flags that must persist: `quoteJustClosed`, `atFieldStart`, `lineMode`).

- [ ] **Step 5: Commit**

```bash
git add src/csv/core/rowIndexer.ts src/test/unit/rowIndexer.test.ts
git commit -m "Add streaming quote-aware row indexer" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Row parser

**Files:**
- Create: `src/csv/core/rowParser.ts`, `src/test/unit/rowParser.test.ts`

**Interfaces:**
- Produces: `parseRow(text: string, delimiter: string, quote?: string): string[]` — parses **one row** (text of a single row's byte range, trailing newlines allowed). An unterminated quote falls back to a plain split on the delimiter (matches the indexer's line-mode recovery).

- [ ] **Step 1: Write the failing tests** `src/test/unit/rowParser.test.ts`

```ts
import * as assert from 'assert';
import { parseRow } from '../../csv/core/rowParser';

suite('rowParser', () => {
    test('plain fields', () => {
        assert.deepStrictEqual(parseRow('a,b,c', ','), ['a', 'b', 'c']);
    });

    test('empty fields and trailing delimiter', () => {
        assert.deepStrictEqual(parseRow('a,,c', ','), ['a', '', 'c']);
        assert.deepStrictEqual(parseRow('a,b,', ','), ['a', 'b', '']);
    });

    test('quoted field with delimiter', () => {
        assert.deepStrictEqual(parseRow('"Blue, large",10', ','), ['Blue, large', '10']);
    });

    test('doubled quotes unescape', () => {
        assert.deepStrictEqual(parseRow('"he said ""hi""",2', ','), ['he said "hi"', '2']);
    });

    test('newline inside quotes is kept', () => {
        assert.deepStrictEqual(parseRow('"x\ny",2\n', ','), ['x\ny', '2']);
    });

    test('trailing CRLF and blank lines are dropped', () => {
        assert.deepStrictEqual(parseRow('a,b\r\n', ','), ['a', 'b']);
        assert.deepStrictEqual(parseRow('a,b\n\n\n', ','), ['a', 'b']);
    });

    test('quote inside an unquoted field is literal', () => {
        assert.deepStrictEqual(parseRow('ab"c,d', ','), ['ab"c', 'd']);
    });

    test('other delimiters', () => {
        assert.deepStrictEqual(parseRow('a;"b;c";d', ';'), ['a', 'b;c', 'd']);
        assert.deepStrictEqual(parseRow('a\tb', '\t'), ['a', 'b']);
    });

    test('empty quoted field', () => {
        assert.deepStrictEqual(parseRow('"",x', ','), ['', 'x']);
    });

    test('unterminated quote falls back to a plain split', () => {
        assert.deepStrictEqual(parseRow('"oops,1\n', ','), ['"oops', '1']);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL (`Cannot find module '../../csv/core/rowParser'`).

- [ ] **Step 3: Implement `src/csv/core/rowParser.ts`**

```ts
/** Parse the text of one row into fields. Mirrors the quoting rules of RowIndexer. */
export function parseRow(text: string, delimiter: string, quote = '"'): string[] {
    const fields: string[] = [];
    let field = '';
    let inQuote = false;
    let atStart = true;
    let justClosed = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuote) {
            if (c === quote) {
                inQuote = false;
                justClosed = true;
            } else {
                field += c;
            }
            continue;
        }
        if (c === quote) {
            if (justClosed) {
                inQuote = true; // "" escape
                justClosed = false;
                field += quote;
            } else if (atStart) {
                inQuote = true;
                atStart = false;
            } else {
                field += c;
            }
            continue;
        }
        justClosed = false;
        if (c === delimiter) {
            fields.push(field);
            field = '';
            atStart = true;
            continue;
        }
        if (c === '\n' || c === '\r') {
            break;
        }
        field += c;
        atStart = false;
    }

    if (inQuote) {
        return text.replace(/[\r\n]+$/, '').split(delimiter);
    }
    fields.push(field);
    return fields;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/csv/core/rowParser.ts src/test/unit/rowParser.test.ts
git commit -m "Add single-row CSV parser" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Detection (encoding, binary, delimiter, header)

**Files:**
- Create: `src/csv/core/detect.ts`, `src/test/unit/detect.test.ts`

**Interfaces:**
- Consumes: `parseRow` (Task 4), `Encoding` (`types.ts`).
- Produces:
  ```ts
  interface Detected { encoding: Encoding; bomLength: number; binary: boolean; delimiter: string; hasHeader: boolean }
  detect(sample: Uint8Array): Detected            // sample = first ≤ 64 KB
  detectEncoding(sample): { encoding: Encoding; bomLength: number }
  detectDelimiter(text: string): string
  guessHasHeader(fields: string[]): boolean
  splitRecords(text: string, max: number): string[]
  ```

- [ ] **Step 1: Write the failing tests** `src/test/unit/detect.test.ts`

```ts
import * as assert from 'assert';
import { detect, detectDelimiter, detectEncoding, guessHasHeader, splitRecords } from '../../csv/core/detect';

suite('detect', () => {
    test('UTF-8 BOM', () => {
        const r = detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
        assert.deepStrictEqual(r, { encoding: 'utf-8', bomLength: 3 });
    });

    test('UTF-16 BOMs', () => {
        assert.deepStrictEqual(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00])), { encoding: 'utf-16le', bomLength: 2 });
        assert.deepStrictEqual(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61])), { encoding: 'utf-16be', bomLength: 2 });
    });

    test('valid multi-byte UTF-8 and a sample cut mid-character are utf-8', () => {
        assert.strictEqual(detectEncoding(Buffer.from('café,ü')).encoding, 'utf-8');
        assert.strictEqual(detectEncoding(Buffer.from('café').subarray(0, 4)).encoding, 'utf-8');
    });

    test('invalid UTF-8 falls back to latin1', () => {
        assert.strictEqual(detectEncoding(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])).encoding, 'latin1');
    });

    test('splitRecords respects quotes and caps the count', () => {
        assert.deepStrictEqual(splitRecords('a,b\n"x\ny",2\r\nz,3\n', 10), ['a,b', '"x\ny",2', 'z,3']);
        assert.deepStrictEqual(splitRecords('a\nb\nc\n', 2), ['a', 'b']);
        assert.deepStrictEqual(splitRecords('a;b;c', 5), ['a;b;c']);
    });

    test('delimiter detection', () => {
        assert.strictEqual(detectDelimiter('a,b,c\n1,2,3\n4,5,6\n'), ',');
        assert.strictEqual(detectDelimiter('a;b;c\n1;2;3\n4;5;6\n'), ';');
        assert.strictEqual(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
        assert.strictEqual(detectDelimiter('a|b|c\n1|2|3\n'), '|');
        assert.strictEqual(detectDelimiter('single\ncolumn\nfile\n'), ',');
    });

    test('decimal commas do not beat the real semicolon delimiter', () => {
        assert.strictEqual(detectDelimiter('name;price\nA;1,5\nB;2,5\n'), ';');
    });

    test('quoted delimiters are ignored when detecting', () => {
        assert.strictEqual(detectDelimiter('a,b\n"x;y;z",2\n"p;q;r",3\n'), ',');
    });

    test('header guess', () => {
        assert.strictEqual(guessHasHeader(['id', 'name', 'price']), true);
        assert.strictEqual(guessHasHeader(['1', '2', '3']), false);
        assert.strictEqual(guessHasHeader(['', '', 'x']), false);
        assert.strictEqual(guessHasHeader(['sku', '2024', 'name']), true);
    });

    test('detect() ties it together', () => {
        const d = detect(Buffer.from('﻿id;name\n1;A\n2;B\n', 'utf8'));
        assert.deepStrictEqual(d, { encoding: 'utf-8', bomLength: 3, binary: false, delimiter: ';', hasHeader: true });
    });

    test('NUL bytes mean binary (except in UTF-16)', () => {
        assert.strictEqual(detect(Buffer.from([0x61, 0x00, 0x62, 0x0a])).binary, true);
        assert.strictEqual(detect(Buffer.from([0xff, 0xfe, 0x61, 0x00])).binary, false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL (`Cannot find module '../../csv/core/detect'`).

- [ ] **Step 3: Implement `src/csv/core/detect.ts`**

```ts
import { parseRow } from './rowParser';
import type { Encoding } from '../types';

export interface Detected {
    encoding: Encoding;
    bomLength: number;
    binary: boolean;
    delimiter: string;
    hasHeader: boolean;
}

const CANDIDATES = [',', ';', '\t', '|'];

export function detectEncoding(sample: Uint8Array): { encoding: Encoding; bomLength: number } {
    if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
        return { encoding: 'utf-8', bomLength: 3 };
    }
    if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
        return { encoding: 'utf-16le', bomLength: 2 };
    }
    if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
        return { encoding: 'utf-16be', bomLength: 2 };
    }
    try {
        // stream:true tolerates a multi-byte character cut off at the end of the sample
        new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
        return { encoding: 'utf-8', bomLength: 0 };
    } catch {
        return { encoding: 'latin1', bomLength: 0 };
    }
}

/** First `max` non-empty records, splitting on newlines outside quotes. */
export function splitRecords(text: string, max: number): string[] {
    const out: string[] = [];
    let start = 0;
    let inQuote = false;
    for (let i = 0; i < text.length && out.length < max; i++) {
        const c = text[i];
        if (c === '"') {
            inQuote = !inQuote;
        } else if (!inQuote && (c === '\n' || c === '\r')) {
            if (i > start) {
                out.push(text.slice(start, i));
            }
            start = i + 1;
        }
    }
    if (out.length === 0 && start < text.length) {
        out.push(text.slice(start));
    }
    return out;
}

export function detectDelimiter(text: string): string {
    const records = splitRecords(text, 50);
    let best = ',';
    let bestScore = 0;
    for (const d of CANDIDATES) {
        const counts = new Map<number, number>();
        for (const r of records) {
            const n = parseRow(r, d).length;
            counts.set(n, (counts.get(n) ?? 0) + 1);
        }
        let score = 0;
        for (const [fieldCount, occurrences] of counts) {
            if (fieldCount > 1 && occurrences > score) {
                score = occurrences;
            }
        }
        if (score > bestScore) {
            best = d;
            bestScore = score;
        }
    }
    return best;
}

/** Header names are rarely numbers or blank: no header if half or more fields are empty or numeric. */
export function guessHasHeader(fields: string[]): boolean {
    if (fields.length === 0) {
        return true;
    }
    const empty = fields.filter((f) => f.trim() === '').length;
    const numeric = fields.filter((f) => /^-?\d+([.,]\d+)?$/.test(f.trim())).length;
    return empty * 2 < fields.length && numeric * 2 < fields.length;
}

export function detect(sample: Uint8Array): Detected {
    const { encoding, bomLength } = detectEncoding(sample);
    const utf16 = encoding === 'utf-16le' || encoding === 'utf-16be';
    const binary = !utf16 && sample.includes(0);
    const text = new TextDecoder(encoding === 'latin1' ? 'windows-1252' : 'utf-8').decode(sample.subarray(bomLength));
    const delimiter = detectDelimiter(text);
    const first = splitRecords(text, 1)[0];
    const hasHeader = first === undefined ? true : guessHasHeader(parseRow(first, delimiter));
    return { encoding, bomLength, binary, delimiter, hasHeader };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/csv/core/detect.ts src/test/unit/detect.test.ts
git commit -m "Add encoding, binary, delimiter and header detection" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Search / filter predicates

**Files:**
- Create: `src/csv/core/predicates.ts`, `src/test/unit/predicates.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SearchMode { caseSensitive: boolean; wholeCell: boolean; regex: boolean }
  type Predicate =
    | { kind: 'search'; query: string; column: number | null; mode: SearchMode }   // column null = all columns
    | { kind: 'columnIn'; column: number; values: string[] }                       // '' means empty cell
    | { kind: 'badRows' };
  type RowTest = (fields: string[]) => boolean;
  compilePredicates(preds: Predicate[]): { test: RowTest; badRowsOnly: boolean; empty: boolean }
  ```
  `compilePredicates` throws `SyntaxError` for an invalid regex. A search with an empty query is ignored. `empty` is true when nothing would filter anything.

- [ ] **Step 1: Write the failing tests** `src/test/unit/predicates.test.ts`

```ts
import * as assert from 'assert';
import { Predicate, SearchMode, compilePredicates } from '../../csv/core/predicates';

const ci: SearchMode = { caseSensitive: false, wholeCell: false, regex: false };
const search = (query: string, column: number | null = null, mode: Partial<SearchMode> = {}): Predicate => ({
    kind: 'search', query, column, mode: { ...ci, ...mode },
});

suite('predicates', () => {
    test('contains is case-insensitive by default', () => {
        const { test } = compilePredicates([search('blue')]);
        assert.strictEqual(test(['A1', 'Big BLUE shirt']), true);
        assert.strictEqual(test(['A1', 'Red']), false);
    });

    test('match case', () => {
        const { test } = compilePredicates([search('Blue', null, { caseSensitive: true })]);
        assert.strictEqual(test(['Blue']), true);
        assert.strictEqual(test(['blue']), false);
    });

    test('whole cell', () => {
        const { test } = compilePredicates([search('blue', null, { wholeCell: true })]);
        assert.strictEqual(test(['BLUE']), true);
        assert.strictEqual(test(['blue shirt']), false);
    });

    test('regex, and regex + whole cell', () => {
        assert.strictEqual(compilePredicates([search('^A\\d+$', null, { regex: true })]).test(['x', 'A12']), true);
        assert.strictEqual(compilePredicates([search('A\\d', null, { regex: true, wholeCell: true })]).test(['A12']), false);
        assert.strictEqual(compilePredicates([search('A\\d+', null, { regex: true, wholeCell: true })]).test(['A12']), true);
    });

    test('invalid regex throws', () => {
        assert.throws(() => compilePredicates([search('(', null, { regex: true })]), SyntaxError);
    });

    test('column scope', () => {
        const { test } = compilePredicates([search('blue', 0)]);
        assert.strictEqual(test(['blue', 'x']), true);
        assert.strictEqual(test(['x', 'blue']), false);
    });

    test('columnIn includes empty cells and missing fields', () => {
        const { test } = compilePredicates([{ kind: 'columnIn', column: 2, values: [''] }]);
        assert.strictEqual(test(['a', 'b', '']), true);
        assert.strictEqual(test(['a', 'b']), true);
        assert.strictEqual(test(['a', 'b', 'x']), false);
    });

    test('predicates are ANDed', () => {
        const { test } = compilePredicates([search('blue'), { kind: 'columnIn', column: 2, values: ['10', '30'] }]);
        assert.strictEqual(test(['A1', 'Blue', '10']), true);
        assert.strictEqual(test(['A1', 'Blue', '20']), false);
        assert.strictEqual(test(['A1', 'Red', '10']), false);
    });

    test('badRows flag and empty detection', () => {
        assert.strictEqual(compilePredicates([{ kind: 'badRows' }]).badRowsOnly, true);
        assert.strictEqual(compilePredicates([{ kind: 'badRows' }]).empty, false);
        assert.strictEqual(compilePredicates([search('')]).empty, true);
        assert.strictEqual(compilePredicates([]).empty, true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL (`Cannot find module '../../csv/core/predicates'`).

- [ ] **Step 3: Implement `src/csv/core/predicates.ts`**

```ts
export interface SearchMode {
    caseSensitive: boolean;
    wholeCell: boolean;
    regex: boolean;
}

export type Predicate =
    | { kind: 'search'; query: string; column: number | null; mode: SearchMode }
    | { kind: 'columnIn'; column: number; values: string[] }
    | { kind: 'badRows' };

export type RowTest = (fields: string[]) => boolean;

function cellMatcher(query: string, mode: SearchMode): (cell: string) => boolean {
    if (mode.regex) {
        const source = mode.wholeCell ? `^(?:${query})$` : query;
        const re = new RegExp(source, mode.caseSensitive ? '' : 'i');
        return (cell) => re.test(cell);
    }
    if (mode.wholeCell) {
        if (mode.caseSensitive) {
            return (cell) => cell === query;
        }
        const q = query.toLowerCase();
        return (cell) => cell.toLowerCase() === q;
    }
    if (mode.caseSensitive) {
        return (cell) => cell.includes(query);
    }
    const q = query.toLowerCase();
    return (cell) => cell.toLowerCase().includes(q);
}

export function compilePredicates(preds: Predicate[]): { test: RowTest; badRowsOnly: boolean; empty: boolean } {
    const tests: RowTest[] = [];
    let badRowsOnly = false;
    for (const p of preds) {
        if (p.kind === 'badRows') {
            badRowsOnly = true;
            continue;
        }
        if (p.kind === 'columnIn') {
            const set = new Set(p.values);
            const col = p.column;
            tests.push((f) => set.has(f[col] ?? ''));
            continue;
        }
        if (p.query === '') {
            continue;
        }
        const match = cellMatcher(p.query, p.mode);
        const col = p.column;
        if (col === null) {
            tests.push((f) => f.some((cell) => match(cell)));
        } else {
            tests.push((f) => match(f[col] ?? ''));
        }
    }
    return {
        test: (f) => tests.every((t) => t(f)),
        badRowsOnly,
        empty: tests.length === 0 && !badRowsOnly,
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/csv/core/predicates.ts src/test/unit/predicates.test.ts
git commit -m "Add search and filter predicates" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: View-model helpers (layout, colours, text utilities)

**Files:**
- Create: `src/csv/core/layout.ts`, `src/csv/core/colors.ts`, `src/csv/core/textUtil.ts`, `src/test/unit/layout.test.ts`, `src/test/unit/colors.test.ts`, `src/test/unit/textUtil.test.ts`

**Interfaces:**
- Produces (`layout.ts`):
  ```ts
  type LongText = 'truncate' | 'wrap' | 'full';  type ColorMode = 'header' | 'headerAndCells' | 'off';
  interface ColumnSet { hidden: number[]; order: number[] }
  interface Layout { hidden: number[]; order: number[]; widths: Record<string, number>; pinned: number;
                     pageSize: number; longText: LongText; colorMode: ColorMode; sets: Record<string, ColumnSet> }
  interface LayoutDefaults { pageSize: number; longText: LongText; colorMode: ColorMode }
  const PAGE_SIZES: number[]
  headerHash(header: string[]): string
  defaultLayout(columnCount: number, d: LayoutDefaults): Layout
  sanitizeLayout(saved: unknown, columnCount: number, d: LayoutDefaults): Layout
  visibleColumns(l: Layout): number[]          // order minus hidden
  moveItem(order: number[], from: number, to: number): number[]
  matchColumns(header: string[], pattern: string): number[]   // regex (case-insens.), substring fallback
  ```
- Produces (`colors.ts`): `type ThemeKind = 'light'|'dark'|'high-contrast'`, `interface ColumnColor { headerBg; headerFg; cellTint; edge: string }`, `columnHue(i): number`, `columnColor(i, theme): ColumnColor`.
- Produces (`textUtil.ts`): `guessLanguage(v): 'json'|'html'|'plaintext'`, `prettyJson(v): string`, `csvEscape(v, delimiter): string`, `rowToCsv(fields, delimiter): string`, `rowToJson(header, fields): string`, `truncateText(s, max): string`.

- [ ] **Step 1: Write the failing tests**

`src/test/unit/layout.test.ts`:
```ts
import * as assert from 'assert';
import { PAGE_SIZES, defaultLayout, headerHash, matchColumns, moveItem, sanitizeLayout, visibleColumns } from '../../csv/core/layout';

const D = { pageSize: 100, longText: 'truncate', colorMode: 'headerAndCells' } as const;

suite('layout', () => {
    test('headerHash is stable and sensitive to changes', () => {
        assert.strictEqual(headerHash(['a', 'b']), headerHash(['a', 'b']));
        assert.notStrictEqual(headerHash(['a', 'b']), headerHash(['a', 'c']));
        assert.notStrictEqual(headerHash(['a', 'b']), headerHash(['ab']));
    });

    test('defaultLayout', () => {
        const l = defaultLayout(3, D);
        assert.deepStrictEqual(l.order, [0, 1, 2]);
        assert.deepStrictEqual(l.hidden, []);
        assert.strictEqual(l.pinned, 0);
        assert.strictEqual(l.pageSize, 100);
        assert.deepStrictEqual(l.sets, {});
    });

    test('sanitizeLayout falls back on garbage', () => {
        assert.deepStrictEqual(sanitizeLayout(null, 3, D), defaultLayout(3, D));
        assert.deepStrictEqual(sanitizeLayout('x', 3, D), defaultLayout(3, D));
    });

    test('sanitizeLayout keeps valid fields and drops invalid ones', () => {
        const saved = {
            hidden: [1, 1, 9, -1, 'x'], order: [2, 0, 1], widths: { '0': 200, '9': 100, '1': 5 },
            pinned: 2, pageSize: 250, longText: 'wrap', colorMode: 'off',
            sets: { good: { hidden: [0], order: [1, 0, 2] }, bad: { hidden: [], order: [0, 0, 1] } },
        };
        const l = sanitizeLayout(saved, 3, D);
        assert.deepStrictEqual(l.hidden, [1]);
        assert.deepStrictEqual(l.order, [2, 0, 1]);
        assert.deepStrictEqual(l.widths, { '0': 200 });
        assert.strictEqual(l.pinned, 2);
        assert.strictEqual(l.pageSize, 250);
        assert.strictEqual(l.longText, 'wrap');
        assert.strictEqual(l.colorMode, 'off');
        assert.deepStrictEqual(Object.keys(l.sets), ['good']);
    });

    test('sanitizeLayout rejects a non-permutation order and bad enums', () => {
        const l = sanitizeLayout({ order: [0, 0, 1], pageSize: 77, longText: 'x', colorMode: 'y', pinned: 9 }, 3, D);
        assert.deepStrictEqual(l.order, [0, 1, 2]);
        assert.strictEqual(l.pageSize, 100);
        assert.strictEqual(l.longText, 'truncate');
        assert.strictEqual(l.colorMode, 'headerAndCells');
        assert.strictEqual(l.pinned, 0);
        assert.ok(PAGE_SIZES.includes(l.pageSize));
    });

    test('visibleColumns and moveItem', () => {
        const l = { ...defaultLayout(4, D), order: [3, 1, 0, 2], hidden: [1] };
        assert.deepStrictEqual(visibleColumns(l), [3, 0, 2]);
        assert.deepStrictEqual(moveItem([0, 1, 2, 3], 0, 2), [1, 2, 0, 3]);
        assert.deepStrictEqual(moveItem([0, 1, 2, 3], 3, 0), [3, 0, 1, 2]);
    });

    test('matchColumns uses regex, falls back to substring on invalid regex', () => {
        const header = ['SKU', 'Name', 'Price (USD)', 'price_eur'];
        assert.deepStrictEqual(matchColumns(header, '^price_'), [3]);
        assert.deepStrictEqual(matchColumns(header, 'price'), [2, 3]);
        assert.deepStrictEqual(matchColumns(header, '('), [2]);
    });
});
```

`src/test/unit/colors.test.ts`:
```ts
import * as assert from 'assert';
import { columnColor, columnHue } from '../../csv/core/colors';

suite('colors', () => {
    const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

    test('neighbouring columns differ by roughly the golden angle', () => {
        for (let i = 0; i < 40; i++) {
            assert.ok(gap(columnHue(i), columnHue(i + 1)) > 100, `columns ${i}/${i + 1}`);
        }
    });

    test('the first 20 hues are all distinct', () => {
        for (let i = 0; i < 20; i++) {
            for (let j = i + 1; j < 20; j++) {
                assert.ok(gap(columnHue(i), columnHue(j)) > 5, `columns ${i}/${j}`);
            }
        }
    });

    test('theme variants', () => {
        assert.match(columnColor(1, 'light').headerBg, /^hsl\(/);
        assert.match(columnColor(1, 'dark').headerBg, /^hsl\(/);
        assert.strictEqual(columnColor(1, 'high-contrast').headerBg, 'transparent');
        assert.match(columnColor(1, 'high-contrast').edge, /^hsl\(/);
    });
});
```

`src/test/unit/textUtil.test.ts`:
```ts
import * as assert from 'assert';
import { csvEscape, guessLanguage, prettyJson, rowToCsv, rowToJson, truncateText } from '../../csv/core/textUtil';

suite('textUtil', () => {
    test('guessLanguage', () => {
        assert.strictEqual(guessLanguage('{"a":1}'), 'json');
        assert.strictEqual(guessLanguage('[1,2]'), 'json');
        assert.strictEqual(guessLanguage('{not json}'), 'plaintext');
        assert.strictEqual(guessLanguage('<p>Hello <b>x</b></p>'), 'html');
        assert.strictEqual(guessLanguage('1 < 2 and 3 > 2'), 'plaintext');
        assert.strictEqual(guessLanguage('plain'), 'plaintext');
    });

    test('prettyJson', () => {
        assert.strictEqual(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
    });

    test('csvEscape / rowToCsv', () => {
        assert.strictEqual(csvEscape('plain', ','), 'plain');
        assert.strictEqual(csvEscape('a,b', ','), '"a,b"');
        assert.strictEqual(csvEscape('say "hi"', ','), '"say ""hi"""');
        assert.strictEqual(csvEscape('a;b', ';'), '"a;b"');
        assert.strictEqual(csvEscape('x\ny', ','), '"x\ny"');
        assert.strictEqual(rowToCsv(['a', 'b,c', ''], ','), 'a,"b,c",');
    });

    test('rowToJson keys by header and pads missing fields', () => {
        assert.strictEqual(rowToJson(['a', 'b'], ['1']), '{\n  "a": "1",\n  "b": ""\n}');
        assert.strictEqual(rowToJson(['', 'b'], ['1', '2']), '{\n  "Column 1": "1",\n  "b": "2"\n}');
    });

    test('truncateText', () => {
        assert.strictEqual(truncateText('abc', 5), 'abc');
        assert.strictEqual(truncateText('abcdef', 3), 'abc…');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL (cannot find the three modules).

- [ ] **Step 3: Implement `src/csv/core/layout.ts`**

```ts
export type LongText = 'truncate' | 'wrap' | 'full';
export type ColorMode = 'header' | 'headerAndCells' | 'off';

export interface ColumnSet {
    hidden: number[];
    order: number[];
}

export interface Layout {
    hidden: number[];
    order: number[];
    widths: Record<string, number>;
    pinned: number;
    pageSize: number;
    longText: LongText;
    colorMode: ColorMode;
    sets: Record<string, ColumnSet>;
}

export interface LayoutDefaults {
    pageSize: number;
    longText: LongText;
    colorMode: ColorMode;
}

export const PAGE_SIZES = [50, 100, 250, 500, 1000];

export function headerHash(header: string[]): string {
    let h = 0x811c9dc5;
    for (const ch of header.join('\u0001')) {
        h ^= ch.codePointAt(0) ?? 0;
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

export function defaultLayout(columnCount: number, d: LayoutDefaults): Layout {
    return {
        hidden: [],
        order: Array.from({ length: columnCount }, (_, i) => i),
        widths: {},
        pinned: 0,
        pageSize: d.pageSize,
        longText: d.longText,
        colorMode: d.colorMode,
        sets: {},
    };
}

function ints(v: unknown, max: number): number[] {
    if (!Array.isArray(v)) {
        return [];
    }
    return [...new Set(v.filter((x): x is number => Number.isInteger(x) && x >= 0 && x < max))];
}

function isPermutation(v: unknown, n: number): v is number[] {
    return Array.isArray(v)
        && v.length === n
        && new Set(v).size === n
        && v.every((x) => Number.isInteger(x) && x >= 0 && x < n);
}

function pick<T>(v: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(v as T) ? (v as T) : fallback;
}

export function sanitizeLayout(saved: unknown, columnCount: number, d: LayoutDefaults): Layout {
    const base = defaultLayout(columnCount, d);
    if (typeof saved !== 'object' || saved === null) {
        return base;
    }
    const s = saved as Record<string, unknown>;

    const widths: Record<string, number> = {};
    if (typeof s.widths === 'object' && s.widths !== null) {
        for (const [k, v] of Object.entries(s.widths)) {
            const col = Number(k);
            if (Number.isInteger(col) && col >= 0 && col < columnCount && typeof v === 'number' && v >= 40 && v <= 2000) {
                widths[k] = v;
            }
        }
    }

    const sets: Record<string, ColumnSet> = {};
    if (typeof s.sets === 'object' && s.sets !== null) {
        for (const [name, v] of Object.entries(s.sets)) {
            const set = v as Record<string, unknown> | null;
            if (set && isPermutation(set.order, columnCount)) {
                sets[name] = { hidden: ints(set.hidden, columnCount), order: set.order };
            }
        }
    }

    const pinned = typeof s.pinned === 'number' && Number.isInteger(s.pinned) && s.pinned >= 0 && s.pinned <= columnCount ? s.pinned : 0;

    return {
        hidden: ints(s.hidden, columnCount),
        order: isPermutation(s.order, columnCount) ? s.order : base.order,
        widths,
        pinned,
        pageSize: pick(s.pageSize, PAGE_SIZES, d.pageSize),
        longText: pick<LongText>(s.longText, ['truncate', 'wrap', 'full'], d.longText),
        colorMode: pick<ColorMode>(s.colorMode, ['header', 'headerAndCells', 'off'], d.colorMode),
        sets,
    };
}

export function visibleColumns(l: Layout): number[] {
    const hidden = new Set(l.hidden);
    return l.order.filter((c) => !hidden.has(c));
}

export function moveItem(order: number[], from: number, to: number): number[] {
    const next = order.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

export function matchColumns(header: string[], pattern: string): number[] {
    let test: (s: string) => boolean;
    try {
        const re = new RegExp(pattern, 'i');
        test = (s) => re.test(s);
    } catch {
        const q = pattern.toLowerCase();
        test = (s) => s.toLowerCase().includes(q);
    }
    return header.flatMap((name, i) => (test(name) ? [i] : []));
}
```

- [ ] **Step 4: Implement `src/csv/core/colors.ts`**

```ts
export type ThemeKind = 'light' | 'dark' | 'high-contrast';

export interface ColumnColor {
    headerBg: string;
    headerFg: string;
    cellTint: string;
    edge: string;
}

/** Golden-angle hue spacing keeps neighbouring columns visually distinct. */
export function columnHue(index: number): number {
    return (index * 137.508) % 360;
}

export function columnColor(index: number, theme: ThemeKind): ColumnColor {
    const h = columnHue(index).toFixed(1);
    switch (theme) {
        case 'light':
            return { headerBg: `hsl(${h} 70% 88%)`, headerFg: `hsl(${h} 55% 20%)`, cellTint: `hsl(${h} 70% 97%)`, edge: `hsl(${h} 65% 55%)` };
        case 'dark':
            return { headerBg: `hsl(${h} 40% 26%)`, headerFg: `hsl(${h} 70% 90%)`, cellTint: `hsl(${h} 35% 17%)`, edge: `hsl(${h} 60% 55%)` };
        default:
            return { headerBg: 'transparent', headerFg: 'inherit', cellTint: 'transparent', edge: `hsl(${h} 100% 60%)` };
    }
}
```

- [ ] **Step 5: Implement `src/csv/core/textUtil.ts`**

```ts
export function guessLanguage(value: string): 'json' | 'html' | 'plaintext' {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
            JSON.parse(t);
            return 'json';
        } catch {
            // not JSON, fall through
        }
    }
    if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(t)) {
        return 'html';
    }
    return 'plaintext';
}

export function prettyJson(value: string): string {
    return JSON.stringify(JSON.parse(value), null, 2);
}

export function csvEscape(value: string, delimiter: string): string {
    if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

export function rowToCsv(fields: string[], delimiter: string): string {
    return fields.map((f) => csvEscape(f, delimiter)).join(delimiter);
}

export function rowToJson(header: string[], fields: string[]): string {
    const obj: Record<string, string> = {};
    header.forEach((name, i) => {
        obj[name || `Column ${i + 1}`] = fields[i] ?? '';
    });
    return JSON.stringify(obj, null, 2);
}

export function truncateText(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS (all suites so far).

- [ ] **Step 7: Commit**

```bash
git add src/csv/core/layout.ts src/csv/core/colors.ts src/csv/core/textUtil.ts src/test/unit/layout.test.ts src/test/unit/colors.test.ts src/test/unit/textUtil.test.ts
git commit -m "Add layout model, column colours and text utilities" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: CsvEngine (index, pages, filter, unique values)

**Files:**
- Create: `src/csv/core/engine.ts`, `src/test/unit/engine.test.ts`

**Interfaces:**
- Consumes: `detect` (T5), `compilePredicates`/`Predicate` (T6), `parseRow` (T4), `RowIndexer` (T3), `ResultSet`/`coalesce` (T2), types (T2).
- Produces:
  ```ts
  interface Tuning { chunkBytes: number; scanBytes: number; maxQuoteBytes: number }
  const DEFAULT_TUNING: Tuning;   const UNIQUE_CAP = 100_000;
  class CsvEngine {
    constructor(path: string, options?: ParseOptions, tuning?: Tuning);
    open(): Promise<{ kind: 'ready' } | { kind: 'empty' } | { kind: 'binary' } | { kind: 'unsupported-encoding'; encoding: string }>;
    index(onProgress: (p: IndexProgress) => void, token: CancelToken): Promise<void>;   // run after open(); resolves when indexed
    getInfo(): Promise<FileInfo>;                      // resolves once the first row is indexed
    readPage(page: number, pageSize: number): Promise<PageResult>;   // 0-based page of the current view
    filter(predicates: Predicate[], token: CancelToken, onProgress: (p: FilterProgress) => void): Promise<FilterResult>;
    uniqueValues(column: number, token: CancelToken, onProgress?: (scanned: number, total: number) => void): Promise<UniqueResult | null>;
    nonEmptyColumns(token: CancelToken): Promise<number[] | null>;
    dispose(): Promise<void>;
  }
  ```
  Behaviour contract: `filter([])` (or only no-op predicates) clears the view. `filter` sets the view immediately so `readPage` returns partial matches (`complete:false`) while the scan runs. Unfiltered `readPage` waits until the requested rows are indexed (or indexing is done). A cancelled scan returns `complete:false` / `null`. `filter` throws `SyntaxError` for an invalid regex without touching the current view. Row numbers are 0-based **data** rows (header excluded).

- [ ] **Step 1: Write the failing tests** `src/test/unit/engine.test.ts`

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvEngine, Tuning } from '../../csv/core/engine';
import type { CancelToken, IndexProgress, ParseOptions } from '../../csv/types';

const TINY: Tuning = { chunkBytes: 7, scanBytes: 16, maxQuoteBytes: 1 << 20 };
const SAMPLE = 'sku,name,price\r\nA1,"Blue, large",10\r\nA2,"Multi\nline",20\r\nA3,Red,\r\nA4,Blue,30\r\n';
const noop = () => undefined;
const live = (): CancelToken => ({ cancelled: false });

suite('CsvEngine', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-engine-'));
    const engines: CsvEngine[] = [];
    let counter = 0;

    function write(content: string | Buffer): string {
        const p = path.join(dir, `f${counter++}.csv`);
        fs.writeFileSync(p, content);
        return p;
    }

    async function load(content: string | Buffer, options: ParseOptions = {}, tuning: Tuning = TINY) {
        const engine = new CsvEngine(write(content), options, tuning);
        engines.push(engine);
        const opened = await engine.open();
        assert.strictEqual(opened.kind, 'ready');
        let last: IndexProgress | undefined;
        const indexing = engine.index((p) => { last = p; }, live());
        const info = await engine.getInfo();
        await indexing;
        return { engine, info, last: () => last };
    }

    suiteTeardown(async () => {
        for (const e of engines) {
            await e.dispose();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('info: header, delimiter, column count', async () => {
        const { info } = await load(SAMPLE);
        assert.deepStrictEqual(info.header, ['sku', 'name', 'price']);
        assert.strictEqual(info.delimiter, ',');
        assert.strictEqual(info.hasHeader, true);
        assert.strictEqual(info.columnCount, 3);
        assert.strictEqual(info.encoding, 'utf-8');
    });

    test('pages through all rows, quoted newlines and delimiters intact', async () => {
        const { engine } = await load(SAMPLE);
        const p0 = await engine.readPage(0, 2);
        assert.deepStrictEqual(p0.rows, [['A1', 'Blue, large', '10'], ['A2', 'Multi\nline', '20']]);
        assert.deepStrictEqual(p0.rowNumbers, [0, 1]);
        assert.strictEqual(p0.total, 4);
        assert.strictEqual(p0.complete, true);
        const p1 = await engine.readPage(1, 2);
        assert.deepStrictEqual(p1.rows, [['A3', 'Red', ''], ['A4', 'Blue', '30']]);
        assert.deepStrictEqual(p1.rowNumbers, [2, 3]);
        const p2 = await engine.readPage(2, 2);
        assert.deepStrictEqual(p2.rows, []);
    });

    test('hasHeader:false override generates column names and keeps the first row as data', async () => {
        const { engine, info } = await load(SAMPLE, { hasHeader: false });
        assert.deepStrictEqual(info.header, ['Column 1', 'Column 2', 'Column 3']);
        assert.strictEqual((await engine.readPage(0, 10)).total, 5);
    });

    test('UTF-8 BOM is skipped', async () => {
        const { info } = await load('﻿a,b\n1,2\n');
        assert.deepStrictEqual(info.header, ['a', 'b']);
    });

    test('latin1 files are decoded', async () => {
        const { engine } = await load(Buffer.concat([Buffer.from('n\ncaf'), Buffer.from([0xe9]), Buffer.from('\n')]));
        assert.deepStrictEqual((await engine.readPage(0, 5)).rows, [['café']]);
    });

    test('search filter: all columns, then a single column', async () => {
        const { engine } = await load(SAMPLE);
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        const all = await engine.filter([{ kind: 'search', query: 'blue', column: null, mode }], live(), noop);
        assert.deepStrictEqual(all, { matches: 2, complete: true });
        const page = await engine.readPage(0, 10);
        assert.deepStrictEqual(page.rowNumbers, [0, 3]);
        assert.strictEqual(page.rows[0][1], 'Blue, large');
        assert.strictEqual(page.total, 2);
        const col0 = await engine.filter([{ kind: 'search', query: 'blue', column: 0, mode }], live(), noop);
        assert.strictEqual(col0.matches, 0);
    });

    test('column filter, including empty values, combined with search', async () => {
        const { engine } = await load(SAMPLE);
        await engine.filter([{ kind: 'columnIn', column: 2, values: [''] }], live(), noop);
        assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [2]);
        await engine.filter([{ kind: 'columnIn', column: 2, values: ['10', '30'] }], live(), noop);
        assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [0, 3]);
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        await engine.filter([
            { kind: 'search', query: 'blue', column: null, mode },
            { kind: 'columnIn', column: 2, values: ['30'] },
        ], live(), noop);
        assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [3]);
    });

    test('empty predicate list clears the filter', async () => {
        const { engine } = await load(SAMPLE);
        await engine.filter([{ kind: 'columnIn', column: 2, values: [''] }], live(), noop);
        const cleared = await engine.filter([], live(), noop);
        assert.deepStrictEqual(cleared, { matches: 4, complete: true });
        assert.strictEqual((await engine.readPage(0, 10)).total, 4);
    });

    test('bad rows are indexed and filterable', async () => {
        const { engine, last } = await load('a,b\n1,2\n3\n4,5,6\n7,8\n');
        assert.strictEqual(last()?.badRows, 2);
        await engine.filter([{ kind: 'badRows' }], live(), noop);
        const page = await engine.readPage(0, 10);
        assert.deepStrictEqual(page.rowNumbers, [1, 2]);
        assert.deepStrictEqual(page.rows, [['3'], ['4', '5', '6']]);
    });

    test('an invalid regex throws and keeps the previous view', async () => {
        const { engine } = await load(SAMPLE);
        await engine.filter([{ kind: 'columnIn', column: 2, values: [''] }], live(), noop);
        const mode = { caseSensitive: false, wholeCell: false, regex: true };
        await assert.rejects(engine.filter([{ kind: 'search', query: '(', column: null, mode }], live(), noop), SyntaxError);
        assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [2]);
    });

    test('a cancelled scan reports incomplete', async () => {
        const { engine } = await load(SAMPLE);
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        const result = await engine.filter([{ kind: 'search', query: 'a', column: null, mode }], { cancelled: true }, noop);
        assert.strictEqual(result.complete, false);
    });

    test('unique values count empties and sort by count then value', async () => {
        const { engine } = await load('k,v\na,1\nb,\na,2\nc,1\na,\n');
        const k = await engine.uniqueValues(0, live());
        assert.deepStrictEqual(k?.entries, [{ value: 'a', count: 3 }, { value: 'b', count: 1 }, { value: 'c', count: 1 }]);
        assert.strictEqual(k?.distinct, 3);
        assert.strictEqual(k?.total, 5);
        assert.strictEqual(k?.truncated, false);
        const v = await engine.uniqueValues(1, live());
        assert.deepStrictEqual(v?.entries, [{ value: '', count: 2 }, { value: '1', count: 2 }, { value: '2', count: 1 }]);
    });

    test('unique values on a cancelled scan return null', async () => {
        const { engine } = await load(SAMPLE);
        assert.strictEqual(await engine.uniqueValues(0, { cancelled: true }), null);
    });

    test('nonEmptyColumns lists columns with at least one value', async () => {
        const { engine } = await load('a,b,c\n1,,\n2,,x\n');
        assert.deepStrictEqual(await engine.nonEmptyColumns(live()), [0, 2]);
    });

    test('unclosed quote is recovered, warned about, and shown as a plain row', async () => {
        const { engine, last } = await load('a,b\n"oops,1\nx,2\n', {}, { ...TINY, maxQuoteBytes: 4 });
        const page = await engine.readPage(0, 10);
        assert.strictEqual(page.total, 2);
        assert.deepStrictEqual(page.rows, [['"oops', '1'], ['x', '2']]);
        assert.strictEqual(last()?.done, true);
        assert.strictEqual(last()?.warnings.length, 1);
    });

    test('empty, binary and UTF-16 files are reported instead of opened', async () => {
        const kinds: Array<[string | Buffer, string]> = [
            ['', 'empty'],
            [Buffer.from([0x61, 0x00, 0x62]), 'binary'],
            [Buffer.from([0xff, 0xfe, 0x61, 0x00]), 'unsupported-encoding'],
        ];
        for (const [content, kind] of kinds) {
            const engine = new CsvEngine(write(content), {}, TINY);
            engines.push(engine);
            assert.strictEqual((await engine.open()).kind, kind);
        }
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL (`Cannot find module '../../csv/core/engine'`).

- [ ] **Step 3: Implement `src/csv/core/engine.ts`**

```ts
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

    /** Stream the whole file once, building the row index. Resolves when indexing is complete (or cancelled). */
    async index(onProgress: (p: IndexProgress) => void, token: CancelToken): Promise<void> {
        const buf = Buffer.allocUnsafe(this.tuning.chunkBytes);
        let pos = this.bom;
        let lastReport = 0;
        for (;;) {
            while (pos < this.size) {
                if (token.cancelled) {
                    return;
                }
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

    async getInfo(): Promise<FileInfo> {
        if (this.info) {
            return this.info;
        }
        await this.waitForRows(1);
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
        if (this.view) {
            const view = this.view;
            const complete = this.viewComplete;
            const rowNumbers = view.slice(startRow, startRow + pageSize);
            return { rowNumbers, rows: await this.readDataRows(rowNumbers), total: view.length, complete };
        }
        await this.waitForRows(this.headerRows + startRow + pageSize);
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
        await this.indexFinished;
        const compiled = compilePredicates(predicates); // throws SyntaxError on a bad regex, before the view changes
        if (compiled.empty) {
            this.view = null;
            this.viewComplete = true;
            return { matches: this.dataRowCount, complete: true };
        }
        const result = new ResultSet();
        this.view = result;
        this.viewComplete = false;
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
        if (complete && this.view === result) {
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
        if (this.done || this.readable() >= n) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => this.waiters.push({ rows: n, resolve }));
    }

    private notify(): void {
        const available = this.readable();
        this.waiters = this.waiters.filter((w) => {
            if (this.done || available >= w.rows) {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS (engine suite: 15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/csv/core/engine.ts src/test/unit/engine.test.ts
git commit -m "Add CsvEngine: streaming index, paging, filter, unique values" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Protocol, worker thread and WorkerClient

**Files:**
- Create: `src/csv/protocol.ts`, `src/csv/worker/csvWorker.ts`, `src/csv/WorkerClient.ts`, `src/test/unit/workerClient.test.ts`

**Interfaces:**
- Consumes: `CsvEngine` (T8), types (T2), `Predicate` (T6), `Layout`/`ColorMode`/`LongText` (T7).
- Produces: `WorkerClient` and the message unions below, used by Task 10 (host) and Tasks 11-14 (webview).
  ```ts
  class WorkerClient {
    constructor(workerPath: string);
    onFatal: (message: string) => void;
    request<T>(body: RequestBody, onProgress?: (p: IndexProgress | FilterProgress) => void): { id: number; promise: Promise<T> };
    cancel(target: number): void;   // target = the id returned by request()
    dispose(): void;
  }
  ```
  Progress for an `open` request keeps flowing after its promise resolves, until a progress with `done: true`.

- [ ] **Step 1: Create `src/csv/protocol.ts`**

```ts
import type { Predicate } from './core/predicates';
import type { ColorMode, Layout, LongText } from './core/layout';
import type {
    FileInfo, FilterProgress, FilterResult, IndexProgress, PageResult, ParseOptions, UniqueResult,
} from './types';

// ---- host <-> worker ------------------------------------------------------

export type WorkerRequest =
    | { id: number; type: 'open'; path: string; options: ParseOptions }
    | { id: number; type: 'page'; page: number; pageSize: number }
    | { id: number; type: 'filter'; predicates: Predicate[] }
    | { id: number; type: 'unique'; column: number }
    | { id: number; type: 'nonEmptyColumns' }
    | { id: number; type: 'cancel'; target: number };

export type WorkerMessage =
    | { type: 'result'; id: number; data: unknown }
    | { type: 'failure'; id: number; message: string }
    | { type: 'progress'; id: number; data: IndexProgress | FilterProgress }
    | { type: 'fatal'; message: string };

/** A request without its id (the client assigns it). */
export type RequestBody = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

// ---- host <-> webview -----------------------------------------------------

export interface ViewerSettings {
    defaultPageSize: number;
    columnColors: ColorMode;
    longText: LongText;
    defaultColumnWidth: number;
}

export type HostToView =
    | { type: 'opened'; info: FileInfo; layout: Layout; settings: ViewerSettings; fileName: string }
    | { type: 'status'; kind: 'empty' | 'binary' | 'unsupported-encoding' | 'error'; message: string }
    | { type: 'error'; message: string }
    | { type: 'indexProgress'; progress: IndexProgress }
    | { type: 'page'; reqId: number; result: PageResult }
    | { type: 'filterProgress'; jobId: number; progress: FilterProgress }
    | { type: 'filterDone'; jobId: number; result: FilterResult }
    | { type: 'filterError'; jobId: number; message: string }
    | { type: 'unique'; jobId: number; result: UniqueResult | null }
    | { type: 'nonEmpty'; columns: number[] | null }
    | { type: 'fileChanged'; deleted: boolean };

export type ViewToHost =
    | { type: 'ready' }
    | { type: 'reload' }
    | { type: 'getPage'; reqId: number; page: number; pageSize: number }
    | { type: 'filter'; jobId: number; predicates: Predicate[] }
    | { type: 'unique'; jobId: number; column: number }
    | { type: 'cancel'; jobId: number }
    | { type: 'nonEmpty' }
    | { type: 'chooseParseOptions' }
    | { type: 'saveLayout'; layout: Layout }
    | { type: 'openInEditor'; text: string; language: string }
    | { type: 'copy'; text: string };
```

- [ ] **Step 2: Create `src/csv/worker/csvWorker.ts`**

```ts
import { parentPort } from 'worker_threads';
import { CsvEngine } from '../core/engine';
import type { CancelToken } from '../types';
import type { WorkerMessage, WorkerRequest } from '../protocol';

const port = parentPort;
if (!port) {
    throw new Error('csvWorker must run in a worker thread');
}

let engine: CsvEngine | undefined;
let indexToken: CancelToken | undefined;
const tokens = new Map<number, CancelToken>();

function send(message: WorkerMessage): void {
    port?.postMessage(message);
}

function getEngine(): CsvEngine {
    if (!engine) {
        throw new Error('No file is open.');
    }
    return engine;
}

function tokenFor(id: number): CancelToken {
    const token: CancelToken = { cancelled: false };
    tokens.set(id, token);
    return token;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function handle(req: WorkerRequest): Promise<void> {
    try {
        switch (req.type) {
            case 'cancel': {
                const token = tokens.get(req.target);
                if (token) {
                    token.cancelled = true;
                }
                return;
            }
            case 'open': {
                if (indexToken) {
                    indexToken.cancelled = true;
                }
                await engine?.dispose();
                const next = new CsvEngine(req.path, req.options);
                engine = next;
                const opened = await next.open();
                if (opened.kind !== 'ready') {
                    send({ type: 'result', id: req.id, data: opened });
                    return;
                }
                const token: CancelToken = { cancelled: false };
                indexToken = token;
                next.index((p) => send({ type: 'progress', id: req.id, data: p }), token)
                    .catch((err) => send({ type: 'fatal', message: errorMessage(err) }));
                const info = await next.getInfo();
                send({ type: 'result', id: req.id, data: { kind: 'ok', info } });
                return;
            }
            case 'page':
                send({ type: 'result', id: req.id, data: await getEngine().readPage(req.page, req.pageSize) });
                return;
            case 'filter': {
                const token = tokenFor(req.id);
                try {
                    const result = await getEngine().filter(req.predicates, token, (p) =>
                        send({ type: 'progress', id: req.id, data: p }));
                    send({ type: 'result', id: req.id, data: result });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
            case 'unique': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().uniqueValues(req.column, token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
            case 'nonEmptyColumns': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().nonEmptyColumns(token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
        }
    } catch (err) {
        send({ type: 'failure', id: req.id, message: errorMessage(err) });
    }
}

port.on('message', (req: WorkerRequest) => {
    void handle(req);
});
```

- [ ] **Step 3: Create `src/csv/WorkerClient.ts`**

```ts
import { Worker } from 'worker_threads';
import type { FilterProgress, IndexProgress } from './types';
import type { RequestBody, WorkerMessage, WorkerRequest } from './protocol';

type Progress = IndexProgress | FilterProgress;

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    onProgress?: (p: Progress) => void;
    keepProgress: boolean;
    doneSeen: boolean;
}

export class WorkerClient {
    private readonly worker: Worker;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    /** Progress handlers that outlive their request (index progress after `open` resolved). */
    private readonly lingering = new Map<number, (p: Progress) => void>();

    onFatal: (message: string) => void = () => undefined;

    constructor(workerPath: string) {
        this.worker = new Worker(workerPath);
        this.worker.on('message', (m: WorkerMessage) => this.onMessage(m));
        this.worker.on('error', (e) => this.failAll(e instanceof Error ? e : new Error(String(e))));
        this.worker.on('exit', (code) => {
            if (code !== 0) {
                this.failAll(new Error(`The CSV worker stopped unexpectedly (exit code ${code}).`));
            }
        });
    }

    request<T>(body: RequestBody, onProgress?: (p: Progress) => void): { id: number; promise: Promise<T> } {
        const id = this.nextId++;
        const promise = new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                onProgress,
                keepProgress: body.type === 'open',
                doneSeen: false,
            });
        });
        this.worker.postMessage({ ...body, id } as WorkerRequest);
        return { id, promise };
    }

    cancel(target: number): void {
        const message: WorkerRequest = { id: 0, type: 'cancel', target };
        this.worker.postMessage(message);
    }

    dispose(): void {
        this.pending.clear();
        this.lingering.clear();
        void this.worker.terminate();
    }

    private onMessage(m: WorkerMessage): void {
        switch (m.type) {
            case 'result': {
                const p = this.pending.get(m.id);
                this.pending.delete(m.id);
                if (p?.onProgress && p.keepProgress && !p.doneSeen) {
                    this.lingering.set(m.id, p.onProgress);
                }
                p?.resolve(m.data);
                break;
            }
            case 'failure': {
                const p = this.pending.get(m.id);
                this.pending.delete(m.id);
                this.lingering.delete(m.id);
                p?.reject(new Error(m.message));
                break;
            }
            case 'progress': {
                const p = this.pending.get(m.id);
                const handler = p?.onProgress ?? this.lingering.get(m.id);
                handler?.(m.data);
                if ('done' in m.data && m.data.done) {
                    if (p) {
                        p.doneSeen = true;
                    }
                    this.lingering.delete(m.id);
                }
                break;
            }
            case 'fatal':
                this.onFatal(m.message);
                break;
        }
    }

    private failAll(error: Error): void {
        const all = [...this.pending.values()];
        this.pending.clear();
        this.lingering.clear();
        for (const p of all) {
            p.reject(error);
        }
        this.onFatal(error.message);
    }
}
```

- [ ] **Step 4: Write the test** `src/test/unit/workerClient.test.ts`

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerClient } from '../../csv/WorkerClient';
import type { FilterResult, IndexProgress, OpenResult, PageResult, UniqueResult } from '../../csv/types';

// out-test/test/unit -> repo root -> out/csvWorker.js (built by `npm run test:unit` via esbuild)
const workerPath = path.resolve(__dirname, '../../../out/csvWorker.js');

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) {
            throw new Error('timed out');
        }
        await new Promise((r) => setTimeout(r, 10));
    }
}

suite('WorkerClient', function () {
    this.timeout(20000);
    let dir: string;
    let file: string;
    let client: WorkerClient;

    suiteSetup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-worker-'));
        file = path.join(dir, 't.csv');
        fs.writeFileSync(file, 'sku,name\nA1,Blue\nA2,Red\nA3,Blue\n');
        client = new WorkerClient(workerPath);
    });

    suiteTeardown(() => {
        client.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('open returns info and index progress keeps flowing until done', async () => {
        const progress: IndexProgress[] = [];
        const res = await client.request<OpenResult>({ type: 'open', path: file, options: {} }, (p) => progress.push(p as IndexProgress)).promise;
        assert.strictEqual(res.kind, 'ok');
        if (res.kind === 'ok') {
            assert.deepStrictEqual(res.info.header, ['sku', 'name']);
        }
        await waitFor(() => progress.some((p) => p.done));
        assert.strictEqual(progress[progress.length - 1].rows, 3);
    });

    test('page', async () => {
        const page = await client.request<PageResult>({ type: 'page', page: 0, pageSize: 10 }).promise;
        assert.deepStrictEqual(page.rows, [['A1', 'Blue'], ['A2', 'Red'], ['A3', 'Blue']]);
        assert.strictEqual(page.total, 3);
    });

    test('filter then page', async () => {
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        const result = await client.request<FilterResult>({
            type: 'filter', predicates: [{ kind: 'search', query: 'blue', column: null, mode }],
        }).promise;
        assert.deepStrictEqual(result, { matches: 2, complete: true });
        const page = await client.request<PageResult>({ type: 'page', page: 0, pageSize: 10 }).promise;
        assert.deepStrictEqual(page.rowNumbers, [0, 2]);
    });

    test('unique values', async () => {
        const result = await client.request<UniqueResult | null>({ type: 'unique', column: 1 }).promise;
        assert.deepStrictEqual(result?.entries, [{ value: 'Blue', count: 2 }, { value: 'Red', count: 1 }]);
    });

    test('an invalid regex rejects with a readable message', async () => {
        const mode = { caseSensitive: false, wholeCell: false, regex: true };
        await assert.rejects(
            client.request<FilterResult>({ type: 'filter', predicates: [{ kind: 'search', query: '(', column: null, mode }] }).promise,
            /Invalid regular expression/,
        );
    });

    test('opening a missing file rejects', async () => {
        await assert.rejects(
            client.request<OpenResult>({ type: 'open', path: path.join(dir, 'missing.csv'), options: {} }).promise,
            /ENOENT/,
        );
    });
});
```

- [ ] **Step 5: Run tests**

Run: `npm run test:unit`
Expected: PASS (the script rebuilds `out/csvWorker.js` first). If the worker file is missing, check `esbuild.mjs` printed `out/csvWorker.js`.

- [ ] **Step 6: Type-check and commit**

Run: `npm run typecheck`
Expected: no output (pass).

```bash
git add src/csv/protocol.ts src/csv/worker src/csv/WorkerClient.ts src/test/unit/workerClient.test.ts
git commit -m "Add worker thread, protocol and WorkerClient" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Extension host: custom editor, session, settings

**Files:**
- Create: `src/csv/CsvEditorProvider.ts`, `src/csv/CsvSession.ts`
- Modify: `src/extension.ts`, `package.json` (`activationEvents`, `contributes`)

**Interfaces:**
- Consumes: `WorkerClient`, `HostToView`/`ViewToHost`/`ViewerSettings` (T9), `sanitizeLayout`/`headerHash` (T7), types (T2).
- Produces: `registerCsvViewer(context): CsvViewerApi` where `CsvViewerApi = { sessions: Map<string, CsvSession> }` (the integration test reads `session.lastPage`); `VIEW_TYPE = 'getUniqueValues.csvViewer'`; command `get-unique-values.openCsvViewer`.

- [ ] **Step 1: Create `src/csv/CsvSession.ts`**

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { WorkerClient } from './WorkerClient';
import { headerHash, sanitizeLayout } from './core/layout';
import type { ColorMode, LongText } from './core/layout';
import type { Predicate } from './core/predicates';
import type { HostToView, ViewToHost, ViewerSettings } from './protocol';
import type {
    FileInfo, FilterProgress, FilterResult, IndexProgress, OpenResult, PageResult, ParseOptions, UniqueResult,
} from './types';

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function statusMessage(result: Exclude<OpenResult, { kind: 'ok' }>): string {
    switch (result.kind) {
        case 'empty':
            return 'This file is empty.';
        case 'binary':
            return 'This looks like a binary file, not a CSV.';
        case 'unsupported-encoding':
            return `Encoding ${result.encoding} is not supported yet (planned for v0.2). Open the file in the text editor instead.`;
    }
}

type Item<T> = vscode.QuickPickItem & { value: T };

export class CsvSession implements vscode.Disposable {
    private readonly worker: WorkerClient;
    private readonly disposables: vscode.Disposable[] = [];
    /** webview job id -> worker request id */
    private readonly jobs = new Map<number, number>();
    private activeFilter: number | undefined;
    private parseOptions: ParseOptions;
    private info: FileInfo | undefined;

    /** Most recent page sent to the webview (read by the integration test). */
    lastPage: PageResult | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly uri: vscode.Uri,
        private readonly panel: vscode.WebviewPanel,
    ) {
        this.worker = new WorkerClient(path.join(context.extensionPath, 'out', 'csvWorker.js'));
        this.worker.onFatal = (message) => this.post({ type: 'error', message });
        this.parseOptions = context.workspaceState.get<ParseOptions>(this.key('parse'), {});
    }

    start(): void {
        const webview = this.panel.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'out'),
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            ],
        };
        webview.html = this.html();
        this.disposables.push(webview.onDidReceiveMessage((m: ViewToHost) => void this.onMessage(m)));

        const dir = vscode.Uri.joinPath(this.uri, '..');
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, path.basename(this.uri.fsPath)));
        this.disposables.push(
            watcher,
            watcher.onDidChange(() => this.post({ type: 'fileChanged', deleted: false })),
            watcher.onDidCreate(() => this.post({ type: 'fileChanged', deleted: false })),
            watcher.onDidDelete(() => this.post({ type: 'fileChanged', deleted: true })),
        );
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.worker.dispose();
    }

    // ---- messages from the webview -----------------------------------------

    private async onMessage(m: ViewToHost): Promise<void> {
        switch (m.type) {
            case 'ready':
            case 'reload':
                await this.openFile();
                break;
            case 'getPage':
                await this.sendPage(m.reqId, m.page, m.pageSize);
                break;
            case 'filter':
                this.startFilter(m.jobId, m.predicates);
                break;
            case 'unique':
                this.startUnique(m.jobId, m.column);
                break;
            case 'cancel': {
                const id = this.jobs.get(m.jobId);
                if (id !== undefined) {
                    this.worker.cancel(id);
                }
                break;
            }
            case 'nonEmpty':
                this.worker.request<number[] | null>({ type: 'nonEmptyColumns' }).promise.then(
                    (columns) => this.post({ type: 'nonEmpty', columns }),
                    (err) => this.post({ type: 'error', message: errorMessage(err) }),
                );
                break;
            case 'chooseParseOptions':
                await this.chooseParseOptions();
                break;
            case 'saveLayout':
                if (this.info) {
                    await this.context.workspaceState.update(this.layoutKey(this.info), m.layout);
                }
                break;
            case 'openInEditor': {
                const doc = await vscode.workspace.openTextDocument({ content: m.text, language: m.language });
                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
                break;
            }
            case 'copy':
                await vscode.env.clipboard.writeText(m.text);
                break;
        }
    }

    private async openFile(): Promise<void> {
        this.jobs.clear();
        this.activeFilter = undefined;
        try {
            const { promise } = this.worker.request<OpenResult>(
                { type: 'open', path: this.uri.fsPath, options: this.parseOptions },
                (p) => this.post({ type: 'indexProgress', progress: p as IndexProgress }),
            );
            const result = await promise;
            if (result.kind !== 'ok') {
                this.post({ type: 'status', kind: result.kind, message: statusMessage(result) });
                return;
            }
            this.info = result.info;
            const settings = this.settings();
            const layout = sanitizeLayout(
                this.context.workspaceState.get<unknown>(this.layoutKey(result.info)),
                result.info.columnCount,
                { pageSize: settings.defaultPageSize, longText: settings.longText, colorMode: settings.columnColors },
            );
            this.post({ type: 'opened', info: result.info, layout, settings, fileName: path.basename(this.uri.fsPath) });
        } catch (err) {
            this.post({ type: 'status', kind: 'error', message: errorMessage(err) });
        }
    }

    private async sendPage(reqId: number, page: number, pageSize: number): Promise<void> {
        try {
            const result = await this.worker.request<PageResult>({ type: 'page', page, pageSize }).promise;
            this.lastPage = result;
            this.post({ type: 'page', reqId, result });
        } catch (err) {
            this.post({ type: 'error', message: errorMessage(err) });
        }
    }

    private startFilter(jobId: number, predicates: Predicate[]): void {
        if (this.activeFilter !== undefined) {
            const previous = this.jobs.get(this.activeFilter);
            if (previous !== undefined) {
                this.worker.cancel(previous);
            }
        }
        this.activeFilter = jobId;
        const { id, promise } = this.worker.request<FilterResult>(
            { type: 'filter', predicates },
            (p) => this.post({ type: 'filterProgress', jobId, progress: p as FilterProgress }),
        );
        this.jobs.set(jobId, id);
        promise
            .then(
                (result) => this.post({ type: 'filterDone', jobId, result }),
                (err) => this.post({ type: 'filterError', jobId, message: errorMessage(err) }),
            )
            .finally(() => this.jobs.delete(jobId));
    }

    private startUnique(jobId: number, column: number): void {
        const { id, promise } = this.worker.request<UniqueResult | null>({ type: 'unique', column });
        this.jobs.set(jobId, id);
        promise
            .then(
                (result) => this.post({ type: 'unique', jobId, result }),
                (err) => this.post({ type: 'error', message: errorMessage(err) }),
            )
            .finally(() => this.jobs.delete(jobId));
    }

    private async chooseParseOptions(): Promise<void> {
        const delimiter = await vscode.window.showQuickPick<Item<string | undefined>>(
            [
                { label: 'Auto-detect', value: undefined },
                { label: 'Comma  ,', value: ',' },
                { label: 'Semicolon  ;', value: ';' },
                { label: 'Tab', value: '\t' },
                { label: 'Pipe  |', value: '|' },
                { label: 'Custom…', value: 'custom' },
            ],
            { title: 'CSV delimiter' },
        );
        if (!delimiter) {
            return;
        }
        let delimiterValue = delimiter.value;
        if (delimiterValue === 'custom') {
            delimiterValue = await vscode.window.showInputBox({
                prompt: 'Delimiter character',
                validateInput: (v) => (v.length === 1 ? undefined : 'Enter exactly one character'),
            });
            if (delimiterValue === undefined) {
                return;
            }
        }
        const header = await vscode.window.showQuickPick<Item<boolean | undefined>>(
            [
                { label: 'Auto-detect', value: undefined },
                { label: 'First row is a header', value: true },
                { label: 'No header row', value: false },
            ],
            { title: 'Header row' },
        );
        if (!header) {
            return;
        }
        const encoding = await vscode.window.showQuickPick<Item<'utf-8' | 'latin1' | undefined>>(
            [
                { label: 'Auto-detect', value: undefined },
                { label: 'UTF-8', value: 'utf-8' },
                { label: 'Latin-1 (Windows-1252)', value: 'latin1' },
            ],
            { title: 'Encoding' },
        );
        if (!encoding) {
            return;
        }
        this.parseOptions = { delimiter: delimiterValue, hasHeader: header.value, encoding: encoding.value };
        await this.context.workspaceState.update(this.key('parse'), this.parseOptions);
        await this.openFile();
    }

    // ---- helpers -----------------------------------------------------------

    private post(message: HostToView): void {
        void this.panel.webview.postMessage(message);
    }

    private key(kind: string): string {
        return `csv.${kind}:${this.uri.fsPath}`;
    }

    private layoutKey(info: FileInfo): string {
        return `${this.key('layout')}:${headerHash(info.header)}`;
    }

    private settings(): ViewerSettings {
        const c = vscode.workspace.getConfiguration('getUniqueValues.csv');
        return {
            defaultPageSize: c.get<number>('defaultPageSize', 100),
            columnColors: c.get<ColorMode>('columnColors', 'headerAndCells'),
            longText: c.get<LongText>('longText', 'truncate'),
            defaultColumnWidth: c.get<number>('defaultColumnWidth', 300),
        };
    }

    private html(): string {
        const webview = this.panel.webview;
        const nonce = randomBytes(16).toString('hex');
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'viewer.js'));
        const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.css'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>CSV Viewer</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}
```

- [ ] **Step 2: Create `src/csv/CsvEditorProvider.ts`**

```ts
import * as vscode from 'vscode';
import { CsvSession } from './CsvSession';

export const VIEW_TYPE = 'getUniqueValues.csvViewer';

export interface CsvViewerApi {
    sessions: Map<string, CsvSession>;
}

class CsvDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) { }
    dispose(): void { }
}

export function registerCsvViewer(context: vscode.ExtensionContext): CsvViewerApi {
    const sessions = new Map<string, CsvSession>();

    const provider: vscode.CustomReadonlyEditorProvider<CsvDocument> = {
        openCustomDocument: (uri) => new CsvDocument(uri),
        resolveCustomEditor: (document, panel) => {
            const session = new CsvSession(context, document.uri, panel);
            const key = document.uri.toString();
            sessions.set(key, session);
            panel.onDidDispose(() => {
                sessions.delete(key);
                session.dispose();
            });
            session.start();
        },
    };

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('get-unique-values.openCsvViewer', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                void vscode.window.showInformationMessage('Open a CSV file first.');
                return;
            }
            await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
        }),
    );

    return { sessions };
}
```

- [ ] **Step 3: Update `src/extension.ts`**

```ts
import * as vscode from 'vscode';
import { registerLineTools } from './lineTools';
import { CsvViewerApi, registerCsvViewer } from './csv/CsvEditorProvider';

export function activate(context: vscode.ExtensionContext): CsvViewerApi {
    registerLineTools(context);
    return registerCsvViewer(context);
}

export function deactivate() { }
```

- [ ] **Step 4: Update `package.json`**

Delete the whole `"activationEvents": [ "onStartupFinished" ],` entry (commands and custom editors activate the extension on demand). Replace the whole `"contributes": { ... }` object with:

```json
"contributes": {
    "commands": [
      {
        "command": "get-unique-values.run",
        "title": "Get Unique Values (Remove Duplicates & Empty Lines)"
      },
      {
        "command": "get-unique-values.openCsvViewer",
        "title": "Open in CSV Viewer"
      }
    ],
    "keybindings": [
      {
        "command": "get-unique-values.run",
        "key": "ctrl+alt+u",
        "mac": "cmd+alt+u",
        "when": "editorTextFocus"
      }
    ],
    "menus": {
      "editor/context": [
        {
          "command": "get-unique-values.run",
          "group": "modification"
        }
      ],
      "editor/title": [
        {
          "command": "get-unique-values.openCsvViewer",
          "when": "resourceExtname =~ /^\\.(csv|tsv|psv)$/",
          "group": "navigation"
        }
      ],
      "explorer/context": [
        {
          "command": "get-unique-values.openCsvViewer",
          "when": "resourceExtname =~ /^\\.(csv|tsv|psv)$/",
          "group": "navigation"
        }
      ]
    },
    "customEditors": [
      {
        "viewType": "getUniqueValues.csvViewer",
        "displayName": "CSV Viewer",
        "priority": "option",
        "selector": [
          { "filenamePattern": "*.csv" },
          { "filenamePattern": "*.tsv" },
          { "filenamePattern": "*.psv" }
        ]
      }
    ],
    "configuration": {
      "title": "CSV Viewer",
      "properties": {
        "getUniqueValues.csv.defaultPageSize": {
          "type": "number",
          "enum": [50, 100, 250, 500, 1000],
          "default": 100,
          "description": "Rows per page in the CSV Viewer."
        },
        "getUniqueValues.csv.columnColors": {
          "type": "string",
          "enum": ["header", "headerAndCells", "off"],
          "default": "headerAndCells",
          "description": "Give every column its own colour: header only, header plus a tinted cell edge, or off."
        },
        "getUniqueValues.csv.longText": {
          "type": "string",
          "enum": ["truncate", "wrap", "full"],
          "default": "truncate",
          "description": "How long cell values are shown: one truncated line, up to 3 wrapped lines, or in full."
        },
        "getUniqueValues.csv.defaultColumnWidth": {
          "type": "number",
          "default": 300,
          "minimum": 80,
          "description": "Default column width in pixels."
        }
      }
    }
  },
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run build && npm run test:unit`
Expected: type-check passes, esbuild writes `out/extension.js`, `out/csvWorker.js`, unit tests all pass. (The webview bundle does not exist yet; Task 11 adds it.)

- [ ] **Step 6: Commit**

```bash
git add src/csv/CsvEditorProvider.ts src/csv/CsvSession.ts src/extension.ts package.json
git commit -m "Add CSV custom editor, session, settings and contributions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Webview foundation: styles, state, table, pager

**Files:**
- Delete: `src/viewer/placeholder.ts`
- Create: `media/viewer.css`, `scripts/make-sample.mjs`, `src/viewer/dom.ts`, `src/viewer/state.ts`, `src/viewer/actions.ts`, `src/viewer/layoutOps.ts`, `src/viewer/banner.ts`, `src/viewer/toolbar.ts`, `src/viewer/table.ts`, `src/viewer/main.ts`

**Interfaces:**
- Consumes: `HostToView`/`ViewToHost` (T9), `Layout` helpers (T7), `columnColor` (T7), `textUtil` (T7).
- Produces (used by Tasks 12-14):
  - `dom.ts`: `h(tag, props?, ...children)`, `debounce(fn, ms)`, `fmt(n)`, `showMenu(x, y, items: MenuItem[])`, `closeMenu()`, `interface MenuItem { label: string; run: () => void; disabled?: boolean }`.
  - `state.ts`: `post(msg: ViewToHost)`, `state` (single mutable object, fields below), `buildPredicates(): Predicate[]`, `resetForNewFile()`, `type Panel`, `interface Banner`.
  - `actions.ts`: event bus `emit(name, arg?)` / `on<T>(name, fn)`; `loadPage(page?)`, `goToPage(n)`, `totalPages()`, `applyFilters()`, `clearColumnFilter(col)`, `clearAllFilters()`, `saveLayout()`.
  - Bus events: `render` (everything), `table` (table + toolbar + status), `status` (toolbar + status + search bar), `panel` (side panel only), `openUnique` (col: number), `openDetail` ({row, col}), `openRecord` (row: number), `focusSearch`, `toggleColumns` (anchor: HTMLElement).
  - `layoutOps.ts`: `hideColumn(c)`, `setPinned(n)`, `resetLayout()`, `setPageSize(n)`, `setLongText(v)`, `setColorMode(v)`.
  - `table.ts`: `mountTable(root)`, `select(row, col)`.

**Webview rules (CSP + security):** never set `innerHTML`, never use `setAttribute('style', ...)` or markup `style="..."` (blocked by the CSP); set styles with `el.style.x = ...` / `el.style.setProperty(...)`. Insert all CSV data through `textContent` / text nodes (`h()` appends strings as text nodes).

- [ ] **Step 1: Remove the placeholder and create `scripts/make-sample.mjs`** (a realistic test file with quoted newlines, HTML, JSON and one bad row)

```bash
git rm -f src/viewer/placeholder.ts 2>/dev/null || rm -f src/viewer/placeholder.ts
```

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.argv[2] ?? path.join(os.tmpdir(), 'sample-products.csv');
const q = (s) => `"${s.replace(/"/g, '""')}"`;
const rows = ['id,sku,name,price,description,attributes'];
for (let i = 0; i < 5000; i++) {
    rows.push([
        i,
        `SKU-${i}`,
        `Product ${i % 50}`,
        (i % 97) / 10,
        q(`<p>Hello <b>world</b> ${'text '.repeat(i % 60)}</p>\n<ul><li>"quoted"</li></ul>`),
        q(JSON.stringify({ color: ['red', 'blue'][i % 2], size: i % 5 })),
    ].join(','));
}
rows.push('bad,row'); // wrong column count on purpose
fs.writeFileSync(out, rows.join('\n') + '\n');
console.log(`wrote ${rows.length - 1} rows to ${out}`);
```

- [ ] **Step 2: Create `media/viewer.css`**

```css
html, body { height: 100%; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    overflow: hidden;
}
#app { display: flex; flex-direction: column; height: 100vh; }

/* controls */
button, select, input {
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 2px 6px;
}
button {
    cursor: pointer;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border-color: transparent;
}
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.toggle[aria-pressed="true"] {
    color: var(--vscode-inputOption-activeForeground);
    background: var(--vscode-inputOption-activeBackground);
    outline: 1px solid var(--vscode-inputOption-activeBorder);
}
button.link { background: none; border: 0; color: var(--vscode-textLink-foreground); padding: 0; }
button.chip { border-radius: 10px; padding: 1px 10px; }
input.search { width: 260px; }
input.page-input { width: 56px; text-align: right; }
.spacer { flex: 1; }
.err { color: var(--vscode-errorForeground); }
.muted { color: var(--vscode-descriptionForeground); }

/* toolbar, banner, status */
.toolbar { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.toolbar .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.banner { display: flex; align-items: center; gap: 8px; padding: 6px 10px; color: var(--vscode-foreground);
    background: var(--vscode-inputValidation-infoBackground); border-bottom: 1px solid var(--vscode-inputValidation-infoBorder); }
.banner.error { background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder); }
.banner[hidden], .side[hidden] { display: none; }
.status { position: relative; display: flex; align-items: center; gap: 12px; padding: 4px 10px;
    border-top: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.progress { position: absolute; left: 0; top: 0; height: 2px; width: 0; background: var(--vscode-progressBar-background); transition: width 0.2s; }

/* main area */
.main { flex: 1; display: flex; min-height: 0; }
.table-wrap { flex: 1; overflow: auto; min-width: 0; outline: none; }
.message { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }

/* table */
table.csv { border-collapse: separate; border-spacing: 0; table-layout: fixed; }
table.csv th, table.csv td {
    box-sizing: border-box; padding: 2px 8px; overflow: hidden; vertical-align: top;
    border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border);
}
table.csv th {
    position: sticky; top: 0; z-index: 2; text-align: left; font-weight: 600; white-space: nowrap;
    padding-right: 24px; color: var(--col-fg, inherit); background: var(--col-bg, var(--vscode-editor-background));
}
table.csv th .name { display: block; overflow: hidden; text-overflow: ellipsis; }
table.csv th .filtered { color: var(--vscode-charts-orange); margin-left: 4px; }
table.csv th .menu-btn { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); padding: 0 4px; background: none; border: 0; color: inherit; opacity: 0.6; }
table.csv th .menu-btn:hover { opacity: 1; }
table.csv th .resize { position: absolute; right: 0; top: 0; bottom: 0; width: 6px; cursor: col-resize; }
table.csv th.rownum, table.csv td.rownum { position: sticky; left: 0; text-align: right; color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
table.csv th.rownum { z-index: 4; }
table.csv td.rownum { z-index: 1; }
table.csv th.pinned { z-index: 3; }
table.csv td.pinned { position: sticky; z-index: 1; background: var(--col-tint, var(--vscode-editor-background)); }
table.csv td.cell .v { overflow: hidden; }
table.csv.longtext-truncate td.cell .v { white-space: nowrap; text-overflow: ellipsis; }
table.csv.longtext-wrap td.cell .v { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; white-space: pre-wrap; word-break: break-word; }
table.csv.longtext-full td.cell .v { white-space: pre-wrap; word-break: break-word; }
table.csv td.cell.tinted { background: var(--col-tint); box-shadow: inset 3px 0 0 var(--col-edge); }
table.csv td.cell.selected { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
body.hc table.csv th.colhead { border-bottom: 3px solid var(--col-edge); }

/* context menu */
.menu { position: fixed; z-index: 100; min-width: 190px; padding: 4px 0;
    color: var(--vscode-menu-foreground); background: var(--vscode-menu-background);
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
.menu-item { display: block; width: 100%; text-align: left; padding: 4px 12px; color: inherit; background: none; border: 0; border-radius: 0; }
.menu-item:hover:not(:disabled) { color: var(--vscode-menu-selectionForeground); background: var(--vscode-menu-selectionBackground); }

/* side panel */
.side { width: 360px; flex: none; display: flex; flex-direction: column; border-left: 1px solid var(--vscode-panel-border); }
.side-head { display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.side-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-body { flex: 1; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.side-tools { display: flex; flex-wrap: wrap; gap: 6px; }
.side-tools input { flex: 1; min-width: 120px; }
.tabs { display: flex; gap: 4px; }
.u-summary { color: var(--vscode-descriptionForeground); }
.u-list { display: flex; flex-direction: column; }
.u-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; padding: 2px 0; cursor: pointer; }
.u-label { position: relative; overflow: hidden; padding: 1px 4px; }
.u-bar { position: absolute; left: 0; top: 0; bottom: 0; background: var(--vscode-charts-blue); opacity: 0.18; }
.u-val, .u-empty { position: relative; white-space: nowrap; }
.u-empty { font-style: italic; }
.u-count { color: var(--vscode-descriptionForeground); white-space: nowrap; }
pre.detail-value { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); }
.rec-row { border-left: 3px solid var(--col-edge, transparent); padding: 2px 8px; cursor: pointer; }
.rec-row.dim { opacity: 0.55; }
.rec-name { font-weight: 600; }
.rec-val { white-space: pre-wrap; word-break: break-word; max-height: 8em; overflow: auto; }

/* column picker */
.picker { position: fixed; z-index: 90; width: 340px; max-height: 80vh; display: flex; flex-direction: column; gap: 6px; padding: 8px;
    color: var(--vscode-foreground); background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
.picker .row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.picker .row input[type="text"], .picker .row input[type="search"] { flex: 1; min-width: 100px; }
.picker-list { overflow: auto; max-height: 280px; border: 1px solid var(--vscode-panel-border); }
.picker-item { display: flex; align-items: center; gap: 6px; padding: 2px 6px; }
.picker-item.dragging { opacity: 0.4; }
.picker-item.drop-target { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
.picker-item .handle { cursor: grab; color: var(--vscode-descriptionForeground); }
.picker-item .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.picker-item .pname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picker-item.hidden-col .pname { opacity: 0.55; }
```

- [ ] **Step 3: Create `src/viewer/dom.ts`**

```ts
type Child = Node | string | null | undefined | false;

/**
 * Tiny element factory. Strings become text nodes (never HTML).
 * Do NOT pass a `style` prop: inline style attributes are blocked by the CSP. Use el.style.x = ... instead.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, unknown> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (key === 'class') {
            el.className = String(value);
        } else if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2), value as EventListener);
        } else if (key === 'value') {
            (el as unknown as HTMLInputElement).value = String(value);
        } else if (key === 'checked') {
            (el as unknown as HTMLInputElement).checked = Boolean(value);
        } else {
            el.setAttribute(key, value === true ? '' : String(value));
        }
    }
    for (const child of children) {
        if (child !== null && child !== undefined && child !== false) {
            el.append(child);
        }
    }
    return el;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
    let timer: number | undefined;
    return (...args: A) => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => fn(...args), ms);
    };
}

export function fmt(n: number): string {
    return n.toLocaleString('en-US');
}

export interface MenuItem {
    label: string;
    run: () => void;
    disabled?: boolean;
}

export function closeMenu(): void {
    document.getElementById('ctx-menu')?.remove();
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
    closeMenu();
    const menu = h('div', { class: 'menu', id: 'ctx-menu', role: 'menu' });
    for (const item of items) {
        const button = h('button', { class: 'menu-item', role: 'menuitem', disabled: item.disabled }, item.label);
        button.addEventListener('click', () => {
            closeMenu();
            item.run();
        });
        menu.append(button);
    }
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

window.addEventListener('mousedown', (e) => {
    if (!(e.target as Element).closest('.menu')) {
        closeMenu();
    }
}, true);
window.addEventListener('blur', closeMenu);
```

- [ ] **Step 4: Create `src/viewer/state.ts`**

```ts
import type { ThemeKind } from '../csv/core/colors';
import type { Layout } from '../csv/core/layout';
import type { Predicate } from '../csv/core/predicates';
import type { ViewToHost, ViewerSettings } from '../csv/protocol';
import type { FileInfo, FilterProgress, IndexProgress, UniqueResult } from '../csv/types';

interface VsCodeApi {
    postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();

export function post(message: ViewToHost): void {
    api.postMessage(message);
}

export type Panel =
    | { kind: 'unique'; column: number }
    | { kind: 'detail'; row: number; col: number }
    | { kind: 'record'; row: number }
    | null;

export interface Banner {
    kind: 'info' | 'error';
    message: string;
    reload?: boolean;
}

function emptySearch() {
    return { query: '', column: null as number | null, caseSensitive: false, wholeCell: false, regex: false };
}

export const state = {
    fileName: '',
    info: null as FileInfo | null,
    layout: null as Layout | null,
    settings: null as ViewerSettings | null,
    status: null as { kind: string; message: string } | null,
    banner: null as Banner | null,
    theme: 'dark' as ThemeKind,

    // current page
    page: 0,
    pageReq: 0,
    rows: [] as string[][],
    rowNumbers: [] as number[],
    total: 0,          // rows in the current view (all rows or matches)
    totalRows: 0,      // all data rows indexed so far
    complete: false,
    indexing: null as IndexProgress | null,
    selected: null as { row: number; col: number } | null,

    // filters
    search: emptySearch(),
    columnFilters: {} as Record<number, string[]>,
    badRowsOnly: false,
    filterActive: false,
    filterRunning: false,
    filterComplete: true,
    filterJob: 0,
    filtering: null as FilterProgress | null,
    filterError: '',

    // side panel
    panel: null as Panel,
    unique: null as UniqueResult | null,
    uniqueLoading: false,
    uniqueJob: 0,
};

export function buildPredicates(): Predicate[] {
    const predicates: Predicate[] = [];
    const s = state.search;
    if (s.query !== '') {
        predicates.push({
            kind: 'search',
            query: s.query,
            column: s.column,
            mode: { caseSensitive: s.caseSensitive, wholeCell: s.wholeCell, regex: s.regex },
        });
    }
    for (const [col, values] of Object.entries(state.columnFilters)) {
        if (values.length > 0) {
            predicates.push({ kind: 'columnIn', column: Number(col), values });
        }
    }
    if (state.badRowsOnly) {
        predicates.push({ kind: 'badRows' });
    }
    return predicates;
}

/** Reset everything tied to the previously opened file (not `indexing`: progress may arrive before `opened`). */
export function resetForNewFile(): void {
    state.status = null;
    state.banner = null;
    state.page = 0;
    state.rows = [];
    state.rowNumbers = [];
    state.total = 0;
    state.totalRows = 0;
    state.complete = false;
    state.selected = null;
    state.search = emptySearch();
    state.columnFilters = {};
    state.badRowsOnly = false;
    state.filterActive = false;
    state.filterRunning = false;
    state.filterComplete = true;
    state.filterJob++;
    state.filtering = null;
    state.filterError = '';
    state.panel = null;
    state.unique = null;
    state.uniqueLoading = false;
    state.uniqueJob++;
}
```

- [ ] **Step 5: Create `src/viewer/actions.ts`**

```ts
import { buildPredicates, post, state } from './state';

const bus = new EventTarget();

export function emit(name: string, arg?: unknown): void {
    bus.dispatchEvent(new CustomEvent(name, { detail: arg }));
}

export function on<T = undefined>(name: string, fn: (arg: T) => void): void {
    bus.addEventListener(name, (e) => fn((e as CustomEvent<T>).detail));
}

export function totalPages(): number {
    const size = state.layout?.pageSize ?? 100;
    return Math.max(1, Math.ceil(state.total / size));
}

/** Ask the host for a page of the current view. The reply updates `state` (see main.ts). */
export function loadPage(page: number = state.page): void {
    const layout = state.layout;
    if (!layout) {
        return;
    }
    state.page = Math.max(0, page);
    state.pageReq++;
    post({ type: 'getPage', reqId: state.pageReq, page: state.page, pageSize: layout.pageSize });
}

function closeRowPanels(): void {
    if (state.panel && state.panel.kind !== 'unique') {
        state.panel = null;
        emit('panel');
    }
}

export function goToPage(page: number): void {
    const max = state.complete ? totalPages() - 1 : Number.MAX_SAFE_INTEGER;
    closeRowPanels();
    loadPage(Math.max(0, Math.min(page, max)));
    emit('status');
}

/** Send the current search + column filters + bad-rows flag to the worker as one AND-ed filter. */
export function applyFilters(): void {
    const predicates = buildPredicates();
    state.filterJob++;
    state.filterError = '';
    state.filterActive = predicates.length > 0;
    state.filterRunning = predicates.length > 0;
    state.filtering = null;
    state.page = 0;
    state.selected = null;
    closeRowPanels();
    post({ type: 'filter', jobId: state.filterJob, predicates });
    emit('status');
}

export function clearColumnFilter(column: number): void {
    delete state.columnFilters[column];
    applyFilters();
    emit('table');
}

export function clearAllFilters(): void {
    state.search.query = '';
    state.columnFilters = {};
    state.badRowsOnly = false;
    applyFilters();
    emit('table');
}

/** Persist the layout (per file) and re-render everything. */
export function saveLayout(): void {
    if (state.layout) {
        post({ type: 'saveLayout', layout: state.layout });
    }
    emit('render');
}
```

- [ ] **Step 6: Create `src/viewer/layoutOps.ts`** (more ops are appended in Task 14)

```ts
import { defaultLayout, visibleColumns } from '../csv/core/layout';
import type { ColorMode, Layout, LongText } from '../csv/core/layout';
import { loadPage, saveLayout } from './actions';
import { state } from './state';

export function mutate(fn: (layout: Layout) => void): void {
    if (state.layout) {
        fn(state.layout);
        saveLayout();
    }
}

export function clampPinned(layout: Layout): void {
    layout.pinned = Math.min(layout.pinned, visibleColumns(layout).length);
}

export function hideColumn(column: number): void {
    mutate((l) => {
        if (!l.hidden.includes(column)) {
            l.hidden.push(column);
        }
        clampPinned(l);
    });
}

export function setPinned(count: number): void {
    mutate((l) => {
        l.pinned = Math.max(0, Math.min(count, visibleColumns(l).length));
    });
}

export function setPageSize(size: number): void {
    mutate((l) => {
        l.pageSize = size;
    });
    loadPage(0);
}

export function setLongText(value: LongText): void {
    mutate((l) => {
        l.longText = value;
    });
}

export function setColorMode(value: ColorMode): void {
    mutate((l) => {
        l.colorMode = value;
    });
}

export function resetLayout(): void {
    const { info, settings, layout } = state;
    if (!info || !settings || !layout) {
        return;
    }
    state.layout = {
        ...defaultLayout(info.columnCount, {
            pageSize: settings.defaultPageSize,
            longText: settings.longText,
            colorMode: settings.columnColors,
        }),
        sets: layout.sets,
    };
    saveLayout();
    loadPage(0);
}
```

- [ ] **Step 7: Create `src/viewer/banner.ts`**

```ts
import { on } from './actions';
import { h } from './dom';
import { post, state } from './state';

export function mountBanner(root: HTMLElement): void {
    const render = (): void => {
        const banner = state.banner;
        root.hidden = !banner;
        root.replaceChildren();
        if (!banner) {
            return;
        }
        root.className = `banner ${banner.kind}`;
        root.append(h('span', {}, banner.message), h('span', { class: 'spacer' }));
        if (banner.reload) {
            const reload = h('button', { class: 'primary' }, 'Reload');
            reload.addEventListener('click', () => post({ type: 'reload' }));
            root.append(reload);
        }
        const dismiss = h('button', { title: 'Dismiss', 'aria-label': 'Dismiss' }, '✕');
        dismiss.addEventListener('click', () => {
            state.banner = null;
            render();
        });
        root.append(dismiss);
    };
    on('status', render);
    on('render', render);
}
```

- [ ] **Step 8: Create `src/viewer/toolbar.ts`** (view controls, pager, status bar; the search row is filled in Task 12)

```ts
import { PAGE_SIZES } from '../csv/core/layout';
import type { ColorMode, LongText } from '../csv/core/layout';
import { applyFilters, emit, goToPage, on, totalPages } from './actions';
import { fmt, h } from './dom';
import { resetLayout, setColorMode, setLongText, setPageSize } from './layoutOps';
import { post, state } from './state';

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const el = h('button', { title, 'aria-label': title }, label);
    el.addEventListener('click', onClick);
    return el;
}

function select(options: Array<[string, string]>, onChange: (value: string) => void, title: string): HTMLSelectElement {
    const el = h('select', { title, 'aria-label': title });
    for (const [value, label] of options) {
        el.append(h('option', { value }, label));
    }
    el.addEventListener('change', () => onChange(el.value));
    return el;
}

const DELIMITER_NAMES: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

export function mountToolbar(root: HTMLElement): { searchRow: HTMLElement } {
    const searchRow = h('div', { class: 'row' });

    const parseChip = h('button', { class: 'chip', title: 'Delimiter · header · encoding. Click to change.' });
    parseChip.addEventListener('click', () => post({ type: 'chooseParseOptions' }));

    const first = button('⏮', 'First page', () => goToPage(0));
    const prev = button('◀', 'Previous page', () => goToPage(state.page - 1));
    const pageInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Page number' });
    pageInput.addEventListener('keydown', (e) => {
        const n = parseInt(pageInput.value, 10);
        if (e.key === 'Enter' && Number.isFinite(n)) {
            goToPage(n - 1);
        }
    });
    const pageTotal = h('span', { class: 'muted' });
    const next = button('▶', 'Next page', () => goToPage(state.page + 1));
    const last = button('⏭', 'Last page', () => goToPage(totalPages() - 1));

    const rowInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', placeholder: 'row #', 'aria-label': 'Go to row number' });
    rowInput.addEventListener('keydown', (e) => {
        const n = parseInt(rowInput.value, 10);
        if (e.key === 'Enter' && Number.isFinite(n) && n >= 1) {
            goToPage(Math.floor((n - 1) / (state.layout?.pageSize ?? 100)));
        }
    });

    const sizeSelect = select(PAGE_SIZES.map((n): [string, string] => [String(n), `${n} / page`]), (v) => setPageSize(Number(v)), 'Rows per page');
    const textSelect = select(
        [['truncate', 'Truncate long text'], ['wrap', 'Wrap (3 lines)'], ['full', 'Show full text']],
        (v) => setLongText(v as LongText),
        'How to show long cell values',
    );
    const colorSelect = select(
        [['headerAndCells', 'Colours: header + cells'], ['header', 'Colours: header only'], ['off', 'Colours: off']],
        (v) => setColorMode(v as ColorMode),
        'Column colours',
    );
    const columnsBtn = h('button', { 'data-picker-anchor': true, title: 'Show, hide, reorder and pin columns' }, 'Columns');
    columnsBtn.addEventListener('click', () => emit('toggleColumns', columnsBtn));
    const resetBtn = button('Reset view', 'Restore default columns, widths and display options', resetLayout);

    root.append(
        searchRow,
        h('div', { class: 'row' },
            parseChip, first, prev, pageInput, pageTotal, next, last, rowInput,
            sizeSelect, textSelect, colorSelect, columnsBtn, resetBtn),
    );

    const update = (): void => {
        const { info, layout } = state;
        const ready = info !== null && layout !== null;
        for (const el of [parseChip, first, prev, pageInput, next, last, rowInput, sizeSelect, textSelect, colorSelect, columnsBtn, resetBtn]) {
            (el as HTMLButtonElement).disabled = !ready;
        }
        if (!info || !layout) {
            parseChip.textContent = '…';
            return;
        }
        const delimiter = DELIMITER_NAMES[info.delimiter] ?? `"${info.delimiter}"`;
        parseChip.textContent = `${delimiter} · ${info.hasHeader ? 'header' : 'no header'} · ${info.encoding}`;
        if (document.activeElement !== pageInput) {
            pageInput.value = String(state.page + 1);
        }
        pageTotal.textContent = `/ ${fmt(totalPages())}${state.complete ? '' : '+'}`;
        first.disabled = prev.disabled = state.page === 0;
        next.disabled = state.complete && state.page >= totalPages() - 1;
        last.disabled = !state.complete || state.page >= totalPages() - 1;
        sizeSelect.value = String(layout.pageSize);
        textSelect.value = layout.longText;
        colorSelect.value = layout.colorMode;
        columnsBtn.textContent = layout.hidden.length > 0 ? `Columns (${layout.hidden.length} hidden)` : 'Columns';
    };
    on('render', update);
    on('table', update);
    on('status', update);

    return { searchRow };
}

export function mountStatus(root: HTMLElement): void {
    const bar = h('div', { class: 'progress' });
    const text = h('span', {});
    const bad = h('button', { class: 'link', title: 'Show only rows whose column count differs from the first row' });
    bad.addEventListener('click', () => {
        state.badRowsOnly = !state.badRowsOnly;
        applyFilters();
    });
    const warning = h('span', {});
    const name = h('span', {});
    root.append(bar, text, bad, warning, h('span', { class: 'spacer' }), name);

    const update = (): void => {
        const { info, layout, indexing } = state;
        name.textContent = state.fileName;
        if (!info || !layout) {
            text.textContent = state.status ? '' : 'Opening…';
            bad.hidden = true;
            warning.textContent = '';
            bar.style.width = '0';
            return;
        }
        const indexingNow = indexing !== null && !indexing.done;
        bar.style.width = indexingNow ? `${Math.min(100, (indexing.bytes / Math.max(1, indexing.total)) * 100)}%` : '0';

        const parts: string[] = [];
        if (state.filterActive) {
            const suffix = state.filterRunning ? ' so far…' : state.filterComplete ? '' : ' (partial)';
            parts.push(`${fmt(state.total)} ${state.total === 1 ? 'match' : 'matches'}${suffix} of ${fmt(state.totalRows)} rows`);
        } else {
            parts.push(`${fmt(state.totalRows || state.total)} rows${indexingNow ? ' (indexing…)' : ''}`);
        }
        parts.push(`${fmt(info.columnCount)} columns`);
        if (state.rows.length > 0) {
            const start = state.page * layout.pageSize;
            parts.push(`showing ${fmt(start + 1)}–${fmt(start + state.rows.length)}`);
        }
        text.textContent = parts.join(' · ');

        const badCount = indexing?.badRows ?? 0;
        bad.hidden = badCount === 0;
        bad.textContent = state.badRowsOnly
            ? `⚠ ${fmt(badCount)} bad rows (click to show all)`
            : `⚠ ${fmt(badCount)} ${badCount === 1 ? 'row' : 'rows'} with a wrong column count`;

        const warnings = indexing?.warnings ?? [];
        if (warnings.length > 0) {
            const row = Math.max(1, warnings[0].row - (info.hasHeader ? 1 : 0) + 1);
            warning.textContent = `⚠ ${warnings.length} unclosed quote${warnings.length === 1 ? '' : 's'} recovered (first near row ${fmt(row)})`;
        } else {
            warning.textContent = '';
        }
    };
    on('status', update);
    on('table', update);
    on('render', update);
}
```

- [ ] **Step 9: Create `src/viewer/table.ts`**

```ts
import { columnColor } from '../csv/core/colors';
import type { ColumnColor } from '../csv/core/colors';
import { visibleColumns } from '../csv/core/layout';
import { rowToCsv, rowToJson, truncateText } from '../csv/core/textUtil';
import { clearColumnFilter, emit, on, saveLayout } from './actions';
import { MenuItem, h, showMenu } from './dom';
import { hideColumn, setPinned } from './layoutOps';
import { post, state } from './state';

const ROWNUM_WIDTH = 72;
let wrap: HTMLElement;

export function mountTable(root: HTMLElement): void {
    wrap = root;
    on('render', renderTable);
    on('table', renderTable);
    wrap.addEventListener('click', (e) => {
        const cell = cellOf(e);
        if (cell) {
            select(cell.row, cell.col);
        }
    });
    wrap.addEventListener('dblclick', (e) => {
        const cell = cellOf(e);
        if (cell) {
            emit('openDetail', { row: cell.row, col: cell.col });
        }
    });
    wrap.addEventListener('contextmenu', (e) => {
        const tr = (e.target as Element).closest('tbody tr') as HTMLElement | null;
        if (!tr) {
            return;
        }
        e.preventDefault();
        const cell = cellOf(e);
        showMenu(e.clientX, e.clientY, rowMenu(Number(tr.dataset.r), cell ? cell.col : undefined));
    });
}

function cellOf(e: Event): { row: number; col: number } | null {
    const td = (e.target as Element).closest('td.cell') as HTMLElement | null;
    return td ? { row: Number(td.dataset.r), col: Number(td.dataset.c) } : null;
}

export function select(row: number, col: number): void {
    state.selected = { row, col };
    updateSelection();
}

function updateSelection(): void {
    wrap.querySelector('td.selected')?.classList.remove('selected');
    const sel = state.selected;
    if (!sel) {
        return;
    }
    const td = wrap.querySelector<HTMLElement>(`td.cell[data-r="${sel.row}"][data-c="${sel.col}"]`);
    td?.classList.add('selected');
    td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function rowMenu(row: number, col: number | undefined): MenuItem[] {
    const info = state.info;
    const fields = state.rows[row];
    if (!info || !fields) {
        return [];
    }
    const items: MenuItem[] = [{ label: 'View record', run: () => emit('openRecord', row) }];
    if (col !== undefined) {
        items.push(
            { label: 'Open cell detail', run: () => emit('openDetail', { row, col }) },
            { label: 'Copy cell', run: () => post({ type: 'copy', text: fields[col] ?? '' }) },
        );
    }
    items.push(
        { label: 'Copy row as CSV', run: () => post({ type: 'copy', text: rowToCsv(fields, info.delimiter) }) },
        { label: 'Copy row as JSON', run: () => post({ type: 'copy', text: rowToJson(info.header, fields) }) },
    );
    return items;
}

function headerMenu(column: number): MenuItem[] {
    const layout = state.layout;
    if (!layout) {
        return [];
    }
    const position = visibleColumns(layout).indexOf(column);
    const items: MenuItem[] = [
        { label: 'Unique values', run: () => emit('openUnique', column) },
        {
            label: 'Search in this column',
            run: () => {
                state.search.column = column;
                emit('status');
                emit('focusSearch');
            },
        },
        { label: 'Hide column', run: () => hideColumn(column) },
        { label: 'Pin columns up to here', run: () => setPinned(position + 1) },
    ];
    if (layout.pinned > 0) {
        items.push({ label: 'Unpin columns', run: () => setPinned(0) });
    }
    if ((state.columnFilters[column] ?? []).length > 0) {
        items.push({ label: 'Clear filter on this column', run: () => clearColumnFilter(column) });
    }
    return items;
}

function startResize(e: MouseEvent, column: number, startWidth: number, colEl: HTMLTableColElement, table: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const tableStart = parseFloat(table.style.width);
    let width = startWidth;
    const move = (ev: MouseEvent): void => {
        width = Math.max(40, Math.min(2000, startWidth + ev.clientX - startX));
        colEl.style.width = `${width}px`;
        table.style.width = `${tableStart + width - startWidth}px`;
    };
    const up = (): void => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (state.layout) {
            state.layout.widths[String(column)] = Math.round(width);
            saveLayout();
        }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

function paint(el: HTMLElement, color: ColumnColor): void {
    el.style.setProperty('--col-bg', color.headerBg);
    el.style.setProperty('--col-fg', color.headerFg);
    el.style.setProperty('--col-edge', color.edge);
}

function emptyMessage(): string {
    if (state.filterRunning) {
        return 'Searching…';
    }
    if (state.filterActive) {
        return 'No rows match the current search and filters.';
    }
    return state.complete ? 'This file has no data rows.' : 'Indexing…';
}

function renderTable(): void {
    const scrollTop = wrap.scrollTop;
    const scrollLeft = wrap.scrollLeft;
    wrap.replaceChildren();
    if (state.status) {
        wrap.append(h('div', { class: 'message' }, state.status.message));
        return;
    }
    const { info, layout, settings } = state;
    if (!info || !layout || !settings) {
        wrap.append(h('div', { class: 'message' }, 'Opening…'));
        return;
    }
    const cols = visibleColumns(layout);
    if (cols.length === 0) {
        wrap.append(h('div', { class: 'message' }, 'All columns are hidden. Use the Columns button to show some.'));
        return;
    }

    const width = (c: number): number => layout.widths[String(c)] ?? settings.defaultColumnWidth;
    const left = new Map<number, number>();
    let acc = ROWNUM_WIDTH;
    for (const c of cols.slice(0, layout.pinned)) {
        left.set(c, acc);
        acc += width(c);
    }
    const colored = layout.colorMode !== 'off';
    const tinted = layout.colorMode === 'headerAndCells' && state.theme !== 'high-contrast';
    const colors = new Map<number, ColumnColor>(cols.map((c): [number, ColumnColor] => [c, columnColor(c, state.theme)]));

    const table = h('table', { class: `csv longtext-${layout.longText}` });
    table.style.width = `${ROWNUM_WIDTH + cols.reduce((n, c) => n + width(c), 0)}px`;

    const colgroup = h('colgroup');
    const rowNumCol = h('col');
    rowNumCol.style.width = `${ROWNUM_WIDTH}px`;
    colgroup.append(rowNumCol);
    const colEls = new Map<number, HTMLTableColElement>();
    for (const c of cols) {
        const colEl = h('col');
        colEl.style.width = `${width(c)}px`;
        colEls.set(c, colEl);
        colgroup.append(colEl);
    }
    table.append(colgroup);

    const headRow = h('tr', {}, h('th', { class: 'rownum' }, '#'));
    for (const c of cols) {
        const name = info.header[c] ?? `Column ${c + 1}`;
        const th = h('th', { class: `colhead${left.has(c) ? ' pinned' : ''}`, title: name });
        const color = colors.get(c);
        if (colored && color) {
            paint(th, color);
        }
        const menuBtn = h('button', { class: 'menu-btn', title: 'Column menu', 'aria-label': `Menu for ${name}` }, '⋮');
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = menuBtn.getBoundingClientRect();
            showMenu(rect.left, rect.bottom, headerMenu(c));
        });
        const handle = h('span', { class: 'resize' });
        const colEl = colEls.get(c);
        if (colEl) {
            handle.addEventListener('mousedown', (e) => startResize(e, c, width(c), colEl, table));
        }
        const filtered = (state.columnFilters[c] ?? []).length > 0;
        th.append(
            h('span', { class: 'name' }, name, filtered ? h('span', { class: 'filtered', title: 'A filter is active on this column' }, '●') : null),
            menuBtn,
            handle,
        );
        const offset = left.get(c);
        if (offset !== undefined) {
            th.style.left = `${offset}px`;
        }
        headRow.append(th);
    }
    table.append(h('thead', {}, headRow));

    const body = h('tbody');
    for (let r = 0; r < state.rows.length; r++) {
        const fields = state.rows[r];
        const tr = h('tr', { 'data-r': r }, h('td', { class: 'rownum' }, String((state.rowNumbers[r] ?? r) + 1)));
        for (const c of cols) {
            const value = fields[c] ?? '';
            const td = h('td', { class: `cell${tinted ? ' tinted' : ''}${left.has(c) ? ' pinned' : ''}`, 'data-r': r, 'data-c': c },
                h('div', { class: 'v' }, value));
            if (value.length > 30) {
                td.title = truncateText(value, 500);
            }
            const color = colors.get(c);
            if (tinted && color) {
                td.style.setProperty('--col-tint', color.cellTint);
                td.style.setProperty('--col-edge', color.edge);
            }
            const offset = left.get(c);
            if (offset !== undefined) {
                td.style.left = `${offset}px`;
            }
            tr.append(td);
        }
        body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    if (state.rows.length === 0) {
        wrap.append(h('div', { class: 'message' }, emptyMessage()));
    }
    wrap.scrollTop = scrollTop;
    wrap.scrollLeft = scrollLeft;
    updateSelection();
}
```

- [ ] **Step 10: Create `src/viewer/main.ts`**

```ts
import type { ThemeKind } from '../csv/core/colors';
import type { HostToView } from '../csv/protocol';
import { emit, loadPage } from './actions';
import { mountBanner } from './banner';
import { h } from './dom';
import { post, resetForNewFile, state } from './state';
import { mountTable } from './table';
import { mountStatus, mountToolbar } from './toolbar';

function detectTheme(): ThemeKind {
    const classes = document.body.classList;
    if (classes.contains('vscode-high-contrast') || classes.contains('vscode-high-contrast-light')) {
        return 'high-contrast';
    }
    return classes.contains('vscode-light') ? 'light' : 'dark';
}

function applyTheme(): void {
    const next = detectTheme();
    document.body.classList.toggle('hc', next === 'high-contrast');
    if (next !== state.theme) {
        state.theme = next;
        emit('table');
    }
}

const app = document.getElementById('app');
if (!app) {
    throw new Error('#app element not found');
}
const toolbarEl = h('div', { class: 'toolbar' });
const bannerEl = h('div', { class: 'banner', hidden: true });
const tableEl = h('div', { class: 'table-wrap', tabindex: '0' });
const sideEl = h('aside', { class: 'side', hidden: true });
const statusEl = h('div', { class: 'status' });
app.append(toolbarEl, bannerEl, h('div', { class: 'main' }, tableEl, sideEl), statusEl);

applyTheme();
const { searchRow } = mountToolbar(toolbarEl);
mountBanner(bannerEl);
mountTable(tableEl);
mountStatus(statusEl);
void searchRow; // filled in Task 12
void sideEl; // filled in Task 13

new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

window.addEventListener('message', (event: MessageEvent<HostToView>) => {
    const m = event.data;
    switch (m.type) {
        case 'opened':
            resetForNewFile();
            state.fileName = m.fileName;
            state.info = m.info;
            state.layout = m.layout;
            state.settings = m.settings;
            loadPage(0);
            emit('render');
            break;
        case 'status':
            state.info = null;
            state.status = { kind: m.kind, message: m.message };
            emit('render');
            break;
        case 'error':
            state.banner = { kind: 'error', message: m.message };
            emit('status');
            break;
        case 'indexProgress': {
            state.indexing = m.progress;
            state.totalRows = m.progress.rows;
            const pageSize = state.layout?.pageSize ?? 0;
            if (!state.filterActive && state.layout && (state.rows.length < pageSize || m.progress.done)) {
                loadPage();
            }
            emit('status');
            break;
        }
        case 'page': {
            if (m.reqId !== state.pageReq) {
                break;
            }
            state.rows = m.result.rows;
            state.rowNumbers = m.result.rowNumbers;
            state.total = m.result.total;
            state.complete = m.result.complete;
            if (!state.filterActive) {
                state.totalRows = Math.max(state.totalRows, m.result.total);
            }
            if (state.selected && state.selected.row >= state.rows.length) {
                state.selected = null;
            }
            emit('table');
            break;
        }
        case 'filterProgress':
            if (m.jobId === state.filterJob) {
                state.filtering = m.progress;
                if (state.rows.length < (state.layout?.pageSize ?? 0)) {
                    loadPage();
                }
                emit('status');
            }
            break;
        case 'filterDone':
            if (m.jobId === state.filterJob) {
                state.filterRunning = false;
                state.filtering = null;
                state.filterComplete = m.result.complete;
                loadPage(state.page);
                emit('status');
            }
            break;
        case 'filterError':
            if (m.jobId === state.filterJob) {
                state.filterRunning = false;
                state.filtering = null;
                state.filterError = m.message;
                emit('status');
            }
            break;
        case 'unique':
            if (m.jobId === state.uniqueJob) {
                state.unique = m.result;
                state.uniqueLoading = false;
                emit('panel');
            }
            break;
        case 'fileChanged':
            state.banner = {
                kind: 'info',
                message: m.deleted ? 'The file was deleted from disk. What you see is the last loaded data.' : 'The file changed on disk.',
                reload: !m.deleted,
            };
            emit('status');
            break;
    }
});

post({ type: 'ready' });
```

- [ ] **Step 11: Verify (type-check, build, manual run)**

Run: `npm run typecheck && npm run build && node scripts/make-sample.mjs`
Expected: no TypeScript errors; esbuild writes `out/viewer.js`; the script prints `wrote 5001 rows to /tmp/sample-products.csv`.

Manual check (needs a human at the keyboard): press **F5** (Run Extension). In the new window open `/tmp/sample-products.csv`, right-click the file in Explorer → **Open in CSV Viewer** (or editor title-bar button, or "Open With… → CSV Viewer"). Expected:
  - table appears with a coloured header per column (each a different hue), 100 rows, row numbers on the left;
  - status bar: `5,001 rows · 6 columns · showing 1–100`, plus `⚠ 1 row with a wrong column count`;
  - pager works (next/last/page number box, "row #" box jumps to that row's page), page-size select works;
  - "Truncate / Wrap / Show full text" changes how the HTML description column shows; "Colours" select switches modes; drag a header's right edge to resize; header `⋮` → "Pin columns up to here" keeps columns visible while scrolling right; header `⋮` → "Hide column" hides it (re-show comes with Task 14);
  - right-click a row → Copy row as CSV / JSON puts text on the clipboard;
  - the ⚠ bad-rows text in the status bar filters the table down (the table updates once Task 12 wires the search bar's clear button; for now check that the status text flips to "bad rows (click to show all)").
  Header menu "Unique values", cell double-click detail and "View record" do nothing yet (Task 13).

- [ ] **Step 12: Commit**

```bash
git add -A src/viewer media scripts
git commit -m "Add CSV viewer webview: table, pager, colours, long-text modes, pinning" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Search bar and filter chips

**Files:**
- Create: `src/viewer/searchBar.ts`
- Modify: `src/viewer/main.ts`

**Interfaces:**
- Consumes: `applyFilters`, `clearAllFilters`, `clearColumnFilter`, `on` (T11 `actions.ts`), `state`, `post`, `h`, `debounce`, `fmt`.
- Produces: `mountSearch(root: HTMLElement): void`. Listens for bus events `status`/`render` (refresh) and `focusSearch` (focus + select the input).

- [ ] **Step 1: Create `src/viewer/searchBar.ts`**

```ts
import { applyFilters, clearAllFilters, clearColumnFilter, on } from './actions';
import { debounce, fmt, h } from './dom';
import { post, state } from './state';

type ToggleKey = 'caseSensitive' | 'wholeCell' | 'regex';

export function mountSearch(root: HTMLElement): void {
    const input = h('input', { class: 'search', type: 'search', placeholder: 'Search…  (Ctrl+F)', 'aria-label': 'Search' });
    const scope = h('select', { title: 'Search in', 'aria-label': 'Search scope' });

    const toggle = (label: string, title: string, key: ToggleKey): HTMLButtonElement => {
        const el = h('button', { class: 'toggle', title, 'aria-label': title, 'aria-pressed': 'false' }, label);
        el.addEventListener('click', () => {
            state.search[key] = !state.search[key];
            refresh();
            if (state.search.query !== '') {
                applyFilters();
            }
        });
        return el;
    };
    const caseBtn = toggle('Aa', 'Match case', 'caseSensitive');
    const wholeBtn = toggle('ab', 'Match whole cell', 'wholeCell');
    const regexBtn = toggle('.*', 'Use regular expression', 'regex');

    const progress = h('span', { class: 'muted' });
    const cancel = h('button', { title: 'Stop the running search' }, 'Cancel');
    cancel.addEventListener('click', () => post({ type: 'cancel', jobId: state.filterJob }));
    const error = h('span', { class: 'err' });
    const chips = h('span', { class: 'chips' });
    const clearAll = h('button', { title: 'Remove the search and every filter' }, 'Clear all');
    clearAll.addEventListener('click', clearAllFilters);

    const runSearch = (): void => {
        state.search.query = input.value;
        applyFilters();
    };
    input.addEventListener('input', debounce(runSearch, 300));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            runSearch();
        }
    });
    scope.addEventListener('change', () => {
        state.search.column = scope.value === '' ? null : Number(scope.value);
        if (state.search.query !== '') {
            applyFilters();
        }
    });

    root.append(input, scope, caseBtn, wholeBtn, regexBtn, progress, cancel, error, chips, clearAll);

    let builtFor: unknown = null;
    const refresh = (): void => {
        const info = state.info;
        if (info !== builtFor) {
            builtFor = info;
            scope.replaceChildren(h('option', { value: '' }, 'All columns'));
            info?.header.forEach((name, i) => scope.append(h('option', { value: i }, name)));
        }
        scope.value = state.search.column === null ? '' : String(state.search.column);
        if (document.activeElement !== input) {
            input.value = state.search.query;
        }
        caseBtn.setAttribute('aria-pressed', String(state.search.caseSensitive));
        wholeBtn.setAttribute('aria-pressed', String(state.search.wholeCell));
        regexBtn.setAttribute('aria-pressed', String(state.search.regex));

        cancel.hidden = !state.filterRunning;
        const f = state.filtering;
        progress.textContent = state.filterRunning
            ? `Searching… ${f && f.total > 0 ? Math.floor((f.scanned / f.total) * 100) : 0}% · ${fmt(f?.matches ?? 0)} found`
            : '';
        error.textContent = state.filterError;

        chips.replaceChildren();
        for (const [col, values] of Object.entries(state.columnFilters)) {
            if (values.length === 0) {
                continue;
            }
            const name = state.info?.header[Number(col)] ?? `Column ${Number(col) + 1}`;
            const chip = h('button', { class: 'chip', title: 'Remove this filter' }, `${name}: ${values.length} value${values.length === 1 ? '' : 's'} ✕`);
            chip.addEventListener('click', () => clearColumnFilter(Number(col)));
            chips.append(chip);
        }
        if (state.badRowsOnly) {
            const chip = h('button', { class: 'chip', title: 'Show all rows again' }, 'Bad rows only ✕');
            chip.addEventListener('click', () => {
                state.badRowsOnly = false;
                applyFilters();
            });
            chips.append(chip);
        }
        clearAll.hidden = !state.filterActive;
    };

    on('status', refresh);
    on('render', refresh);
    on('focusSearch', () => {
        input.focus();
        input.select();
    });
    refresh();
}
```

- [ ] **Step 2: Wire it into `src/viewer/main.ts`**

Add the import `import { mountSearch } from './searchBar';` and replace the line `void searchRow; // filled in Task 12` with `mountSearch(searchRow);`.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run build`
Expected: both pass.

Manual check (F5, open `/tmp/sample-products.csv` in the viewer):
  - type `product 7` in the search box: after ~300 ms the status shows `N matches of 5,001 rows` and only matching rows show (original row numbers kept);
  - toggle `Aa` / `ab` / `.*` and re-check results; type `(` with `.*` on: red error text `Invalid regular expression…` appears and the table keeps its last good result;
  - pick a single column in the scope select: matches limited to it;
  - click the status bar `⚠ 1 row with a wrong column count`: table shows only that row and a `Bad rows only ✕` chip appears; click the chip or `Clear all` to restore;
  - header `⋮` → "Search in this column" selects that column in the scope dropdown and focuses the box.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/searchBar.ts src/viewer/main.ts
git commit -m "Add search bar with scope, modes, cancel and filter chips" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Unique values panel, cell detail and record view

**Files:**
- Create: `src/viewer/panelCommon.ts`, `src/viewer/uniquePanel.ts`, `src/viewer/detailPanel.ts`, `src/viewer/sidePanel.ts`
- Modify: `src/viewer/main.ts`

**Interfaces:**
- Consumes: bus events `openUnique` (number), `openDetail` ({row, col}), `openRecord` (number), `panel`; `state.panel`, `state.unique`, `state.uniqueLoading`, `state.uniqueJob`, `state.columnFilters` (T11); `guessLanguage`, `prettyJson`, `rowToCsv`, `rowToJson`, `truncateText` (T7); worker messages `unique`, `cancel`, `copy`, `openInEditor` (T9/T10).
- Produces: `mountSidePanel(root)`; `closePanel()`, `panelHeader(title)` in `panelCommon.ts`.

- [ ] **Step 1: Create `src/viewer/panelCommon.ts`**

```ts
import { emit } from './actions';
import { h } from './dom';
import { state } from './state';

export function closePanel(): void {
    state.panel = null;
    emit('panel');
}

export function panelHeader(title: string): HTMLElement {
    const close = h('button', { title: 'Close (Esc)', 'aria-label': 'Close panel' }, '✕');
    close.addEventListener('click', closePanel);
    return h('div', { class: 'side-head' }, h('strong', { class: 'side-title', title }, title), close);
}
```

- [ ] **Step 2: Create `src/viewer/uniquePanel.ts`**

```ts
import { truncateText } from '../csv/core/textUtil';
import type { UniqueEntry, UniqueResult } from '../csv/types';
import { applyFilters, emit } from './actions';
import { debounce, fmt, h } from './dom';
import { panelHeader } from './panelCommon';
import { post, state } from './state';

const MAX_ROWS = 500;
let sortBy: 'count' | 'value' = 'count';
let needle = '';

export function openUnique(column: number): void {
    state.panel = { kind: 'unique', column };
    state.unique = null;
    state.uniqueLoading = true;
    state.uniqueJob++;
    needle = '';
    post({ type: 'unique', jobId: state.uniqueJob, column });
    emit('panel');
}

export function renderUnique(root: HTMLElement, column: number): void {
    const name = state.info?.header[column] ?? `Column ${column + 1}`;
    root.append(panelHeader(`Unique values: ${name}`));
    const body = h('div', { class: 'side-body' });
    root.append(body);

    const result = state.unique;
    if (state.uniqueLoading) {
        const cancel = h('button', {}, 'Cancel');
        cancel.addEventListener('click', () => post({ type: 'cancel', jobId: state.uniqueJob }));
        body.append(h('div', { class: 'message' }, 'Scanning the column…'), cancel);
        return;
    }
    if (!result || result.column !== column) {
        body.append(h('div', { class: 'message' }, 'The scan was cancelled. Choose "Unique values" again to retry.'));
        return;
    }
    body.append(...buildList(result, column));
}

function buildList(result: UniqueResult, column: number): HTMLElement[] {
    const list = h('div', { class: 'u-list' });
    const summary = h('div', { class: 'u-summary' });
    const filterInput = h('input', { type: 'search', placeholder: 'Filter values…', 'aria-label': 'Filter values' });
    const sortLabel = (): string => (sortBy === 'count' ? 'Sort: count' : 'Sort: value');
    const sortBtn = h('button', { title: 'Change the sort order' }, sortLabel());
    const clearBtn = h('button', { title: 'Remove the filter on this column' }, 'Clear selection');

    let matches = 0;
    const refreshSummary = (): void => {
        const selected = (state.columnFilters[column] ?? []).length;
        let text = `${fmt(result.distinct)} distinct values`;
        if (result.truncated) {
            text += ` (top ${fmt(result.entries.length)} by count)`;
        }
        if (matches > MAX_ROWS) {
            text += ` · showing ${MAX_ROWS} of ${fmt(matches)} matches, type to narrow`;
        }
        if (selected > 0) {
            text += ` · ${selected} selected`;
        }
        summary.textContent = text;
    };

    const toggle = (value: string, checked: boolean): void => {
        const set = new Set(state.columnFilters[column] ?? []);
        if (checked) {
            set.add(value);
        } else {
            set.delete(value);
        }
        if (set.size > 0) {
            state.columnFilters[column] = [...set];
        } else {
            delete state.columnFilters[column];
        }
        applyFilters();
        refreshSummary();
    };

    const row = (entry: UniqueEntry, selected: Set<string>): HTMLElement => {
        const pct = result.total > 0 ? (entry.count / result.total) * 100 : 0;
        const checkbox = h('input', { type: 'checkbox', checked: selected.has(entry.value), 'aria-label': entry.value === '' ? 'empty value' : entry.value });
        checkbox.addEventListener('change', () => toggle(entry.value, checkbox.checked));
        const label = entry.value === ''
            ? h('i', { class: 'u-empty' }, '(empty)')
            : h('span', { class: 'u-val', title: truncateText(entry.value, 500) }, truncateText(entry.value, 200));
        const bar = h('div', { class: 'u-bar' });
        bar.style.width = `${Math.min(100, pct)}%`;
        return h('label', { class: 'u-row' },
            checkbox,
            h('div', { class: 'u-label' }, bar, label),
            h('span', { class: 'u-count' }, `${fmt(entry.count)} · ${pct.toFixed(1)}%`));
    };

    const fill = (): void => {
        const selected = new Set(state.columnFilters[column] ?? []);
        const q = needle.toLowerCase();
        let entries = result.entries.filter((e) =>
            q === '' || e.value.toLowerCase().includes(q) || (e.value === '' && '(empty)'.includes(q)));
        if (sortBy === 'value') {
            entries = entries.slice().sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
        }
        matches = entries.length;
        list.replaceChildren(...entries.slice(0, MAX_ROWS).map((e) => row(e, selected)));
        refreshSummary();
    };

    filterInput.addEventListener('input', debounce(() => {
        needle = filterInput.value;
        fill();
    }, 150));
    sortBtn.addEventListener('click', () => {
        sortBy = sortBy === 'count' ? 'value' : 'count';
        sortBtn.textContent = sortLabel();
        fill();
    });
    clearBtn.addEventListener('click', () => {
        delete state.columnFilters[column];
        applyFilters();
        fill();
    });

    fill();
    return [h('div', { class: 'side-tools' }, filterInput, sortBtn, clearBtn), summary, list];
}
```

- [ ] **Step 3: Create `src/viewer/detailPanel.ts`**

```ts
import { columnColor } from '../csv/core/colors';
import { guessLanguage, prettyJson, rowToCsv, rowToJson, truncateText } from '../csv/core/textUtil';
import { emit } from './actions';
import { h } from './dom';
import { panelHeader } from './panelCommon';
import { post, state } from './state';

let pretty = false;

function tabs(active: 'value' | 'record', row: number, col: number | null): HTMLElement {
    const value = h('button', { class: 'toggle', 'aria-pressed': String(active === 'value') }, 'Value');
    value.addEventListener('click', () => emit('openDetail', { row, col: col ?? state.layout?.order[0] ?? 0 }));
    const record = h('button', { class: 'toggle', 'aria-pressed': String(active === 'record') }, 'Record');
    record.addEventListener('click', () => emit('openRecord', row));
    return h('div', { class: 'tabs' }, value, record);
}

export function renderDetail(root: HTMLElement, row: number, col: number): void {
    const info = state.info;
    const value = state.rows[row]?.[col];
    const name = info?.header[col] ?? `Column ${col + 1}`;
    const rowNumber = (state.rowNumbers[row] ?? row) + 1;
    root.append(panelHeader(`${name} · row ${rowNumber}`));
    const body = h('div', { class: 'side-body' });
    root.append(body);
    if (value === undefined) {
        body.append(h('div', { class: 'message' }, 'This row is no longer on the current page.'));
        return;
    }

    const language = guessLanguage(value);
    let text = value;
    if (pretty && language === 'json') {
        text = prettyJson(value);
    }

    const copy = h('button', {}, 'Copy');
    copy.addEventListener('click', () => post({ type: 'copy', text }));
    const open = h('button', { title: 'Open the full value in an editor tab' }, 'Open in editor tab');
    open.addEventListener('click', () => post({ type: 'openInEditor', text, language }));
    const tools = h('div', { class: 'side-tools' }, copy, open);
    if (language === 'json') {
        const format = h('button', { class: 'toggle', 'aria-pressed': String(pretty) }, 'Format JSON');
        format.addEventListener('click', () => {
            pretty = !pretty;
            emit('panel');
        });
        tools.append(format);
    }
    body.append(tabs('value', row, col), tools, h('pre', { class: 'detail-value' }, text));
}

export function renderRecord(root: HTMLElement, row: number): void {
    const { info, layout } = state;
    const fields = state.rows[row];
    const rowNumber = (state.rowNumbers[row] ?? row) + 1;
    root.append(panelHeader(`Record · row ${rowNumber}`));
    const body = h('div', { class: 'side-body' });
    root.append(body);
    if (!info || !layout || !fields) {
        body.append(h('div', { class: 'message' }, 'This row is no longer on the current page.'));
        return;
    }

    const copyCsv = h('button', {}, 'Copy as CSV');
    copyCsv.addEventListener('click', () => post({ type: 'copy', text: rowToCsv(fields, info.delimiter) }));
    const copyJson = h('button', {}, 'Copy as JSON');
    copyJson.addEventListener('click', () => post({ type: 'copy', text: rowToJson(info.header, fields) }));
    body.append(tabs('record', row, null), h('div', { class: 'side-tools' }, copyCsv, copyJson));

    const hidden = new Set(layout.hidden);
    for (const c of layout.order) {
        const item = h('div', { class: `rec-row${hidden.has(c) ? ' dim' : ''}`, title: 'Click to open the full value' },
            h('div', { class: 'rec-name' }, info.header[c] ?? `Column ${c + 1}`),
            h('div', { class: 'rec-val' }, truncateText(fields[c] ?? '', 2000)));
        item.style.setProperty('--col-edge', columnColor(c, state.theme).edge);
        item.addEventListener('click', () => emit('openDetail', { row, col: c }));
        body.append(item);
    }
}
```

- [ ] **Step 4: Create `src/viewer/sidePanel.ts`**

```ts
import { emit, on } from './actions';
import { renderDetail, renderRecord } from './detailPanel';
import { state } from './state';
import { openUnique, renderUnique } from './uniquePanel';

export function mountSidePanel(root: HTMLElement): void {
    const render = (): void => {
        root.replaceChildren();
        const panel = state.panel;
        root.hidden = panel === null;
        if (!panel) {
            return;
        }
        switch (panel.kind) {
            case 'unique':
                renderUnique(root, panel.column);
                break;
            case 'detail':
                renderDetail(root, panel.row, panel.col);
                break;
            case 'record':
                renderRecord(root, panel.row);
                break;
        }
    };
    on('panel', render);
    on('render', render);
    on<number>('openUnique', openUnique);
    on<{ row: number; col: number }>('openDetail', ({ row, col }) => {
        state.panel = { kind: 'detail', row, col };
        emit('panel');
    });
    on<number>('openRecord', (row) => {
        state.panel = { kind: 'record', row };
        emit('panel');
    });
}
```

- [ ] **Step 5: Wire into `src/viewer/main.ts`**

Add `import { mountSidePanel } from './sidePanel';` and replace `void sideEl; // filled in Task 13` with `mountSidePanel(sideEl);`.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run build`
Expected: both pass.

Manual check (F5, open `/tmp/sample-products.csv`):
  - header `⋮` → **Unique values** on `name`: side panel shows `Scanning…`, then 50 values with counts and percentage bars; type in the panel's filter box to narrow; toggle **Sort: count/value**;
  - tick two values: table filters to rows with either value, the header shows a `●`, a chip `name: 2 values ✕` appears in the search row; the panel's summary shows `2 selected`; **Clear selection** removes it;
  - on `attributes` (JSON) double-click a cell: detail panel shows the value, **Format JSON** pretty-prints it, **Copy** copies, **Open in editor tab** opens a JSON-highlighted untitled editor; on `description` (HTML) it opens as HTML;
  - row right-click → **View record** shows all columns with their colours; clicking a value opens its detail; **Value / Record** tabs switch; ✕ closes the panel.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/panelCommon.ts src/viewer/uniquePanel.ts src/viewer/detailPanel.ts src/viewer/sidePanel.ts src/viewer/main.ts
git commit -m "Add unique-values panel, cell detail and record view" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Column picker (hide / show / reorder / smart toggles / sets) and keyboard

**Files:**
- Create: `src/viewer/columnPicker.ts`, `src/viewer/keyboard.ts`
- Modify: `src/viewer/layoutOps.ts` (append), `src/viewer/main.ts`

**Interfaces:**
- Consumes: bus event `toggleColumns` (anchor: HTMLElement) from the toolbar's Columns button; `mutate`, `clampPinned` (T11 `layoutOps.ts`); `matchColumns`, `moveItem`, `visibleColumns` (T7); `select` (T11 `table.ts`); `closePanel` (T13); worker message `nonEmpty` (T9/T10).
- Produces: in `layoutOps.ts`: `toggleColumn(c)`, `showAll()`, `hideAll()`, `invertHidden()`, `moveColumn(from, to)`, `showOnlyMatching(pattern)`, `showOnlyFiltered()`, `requestHideEmpty()`, `applyNonEmpty(columns: number[] | null)`, `saveSet(name)`, `applySet(name)`, `deleteSet(name)`; `mountColumnPicker()`, `mountKeyboard()`.

- [ ] **Step 1: Append to `src/viewer/layoutOps.ts`**

Change its imports to:

```ts
import { defaultLayout, matchColumns, moveItem, visibleColumns } from '../csv/core/layout';
import type { ColorMode, Layout, LongText } from '../csv/core/layout';
import { loadPage, saveLayout } from './actions';
import { post, state } from './state';
```

Then append:

```ts
export function toggleColumn(column: number): void {
    mutate((l) => {
        const i = l.hidden.indexOf(column);
        if (i >= 0) {
            l.hidden.splice(i, 1);
        } else {
            l.hidden.push(column);
        }
        clampPinned(l);
    });
}

export function showAll(): void {
    mutate((l) => {
        l.hidden = [];
    });
}

export function hideAll(): void {
    mutate((l) => {
        l.hidden = l.order.slice();
        l.pinned = 0;
    });
}

export function invertHidden(): void {
    mutate((l) => {
        const hidden = new Set(l.hidden);
        l.hidden = l.order.filter((c) => !hidden.has(c));
        clampPinned(l);
    });
}

export function moveColumn(from: number, to: number): void {
    mutate((l) => {
        l.order = moveItem(l.order, from, to);
    });
}

function showOnly(keep: Set<number>): void {
    mutate((l) => {
        l.hidden = l.order.filter((c) => !keep.has(c));
        clampPinned(l);
    });
}

/** Show only columns whose name matches the pattern (regex, case-insensitive). */
export function showOnlyMatching(pattern: string): void {
    const info = state.info;
    if (info && pattern.trim() !== '') {
        showOnly(new Set(matchColumns(info.header, pattern)));
    }
}

/** Show only columns that have a column filter or are the search column. */
export function showOnlyFiltered(): void {
    const keep = new Set<number>(Object.keys(state.columnFilters).map(Number));
    if (state.search.column !== null) {
        keep.add(state.search.column);
    }
    if (keep.size > 0) {
        showOnly(keep);
    }
}

/** Ask the worker which columns contain data; the reply is handled by `applyNonEmpty`. */
export function requestHideEmpty(): void {
    post({ type: 'nonEmpty' });
}

export function applyNonEmpty(columns: number[] | null): void {
    if (columns) {
        showOnly(new Set(columns));
    }
}

export function saveSet(name: string): void {
    const trimmed = name.trim();
    if (trimmed === '') {
        return;
    }
    mutate((l) => {
        l.sets[trimmed] = { hidden: l.hidden.slice(), order: l.order.slice() };
    });
}

export function applySet(name: string): void {
    mutate((l) => {
        const set = l.sets[name];
        if (set) {
            l.hidden = set.hidden.slice();
            l.order = set.order.slice();
            clampPinned(l);
        }
    });
}

export function deleteSet(name: string): void {
    mutate((l) => {
        delete l.sets[name];
    });
}
```

- [ ] **Step 2: Create `src/viewer/columnPicker.ts`**

```ts
import { columnColor } from '../csv/core/colors';
import { on } from './actions';
import { h } from './dom';
import {
    applySet, deleteSet, hideAll, invertHidden, moveColumn, requestHideEmpty, saveSet, setPinned,
    showAll, showOnlyFiltered, showOnlyMatching, toggleColumn,
} from './layoutOps';
import { state } from './state';

let popover: HTMLElement | null = null;
let refreshFn: (() => void) | null = null;

export function mountColumnPicker(): void {
    on<HTMLElement>('toggleColumns', (anchor) => (popover ? close() : open(anchor)));
    on('render', () => refreshFn?.());
    window.addEventListener('mousedown', (e) => {
        if (popover && !(e.target as Element).closest('.picker, [data-picker-anchor]')) {
            close();
        }
    }, true);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && popover) {
            close();
        }
    });
}

function close(): void {
    popover?.remove();
    popover = null;
    refreshFn = null;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const el = h('button', { title }, label);
    el.addEventListener('click', onClick);
    return el;
}

function open(anchor: HTMLElement): void {
    if (!state.layout || !state.info) {
        return;
    }
    const pop = h('div', { class: 'picker', role: 'dialog', 'aria-label': 'Columns' });
    const rect = anchor.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 350))}px`;

    let filterText = '';
    let dragFrom = -1;

    const finder = h('input', { type: 'search', placeholder: 'Find column…', 'aria-label': 'Find column' });
    const count = h('span', { class: 'muted' });
    finder.addEventListener('input', () => {
        filterText = finder.value.toLowerCase();
        refresh();
    });

    const matchInput = h('input', { type: 'text', placeholder: 'Show only names matching (regex)…', 'aria-label': 'Name pattern' });
    const matchBtn = button('Apply', 'Show only columns whose name matches', () => showOnlyMatching(matchInput.value));
    matchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            showOnlyMatching(matchInput.value);
        }
    });

    const list = h('div', { class: 'picker-list' });

    const pinInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Pinned column count' });
    const pinApply = (): void => {
        const n = parseInt(pinInput.value, 10);
        if (Number.isFinite(n)) {
            setPinned(n);
        }
    };
    pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            pinApply();
        }
    });
    pinInput.addEventListener('change', pinApply);

    const setSelect = h('select', { 'aria-label': 'Saved column sets' });
    const setName = h('input', { type: 'text', placeholder: 'Set name…', 'aria-label': 'New column set name' });

    pop.append(
        h('div', { class: 'row' }, finder, count),
        h('div', { class: 'row' },
            button('Show all', 'Show every column', showAll),
            button('Hide all', 'Hide every column', hideAll),
            button('Invert', 'Swap shown and hidden columns', invertHidden),
            button('Hide empty', 'Hide columns that have no values (scans the file)', requestHideEmpty),
            button('Only filtered', 'Show only columns with a filter or the search column', showOnlyFiltered)),
        h('div', { class: 'row' }, matchInput, matchBtn),
        list,
        h('div', { class: 'row' }, 'Pin first', pinInput, 'visible columns'),
        h('div', { class: 'row' },
            setSelect,
            button('Apply', 'Apply the selected set', () => setSelect.value && applySet(setSelect.value)),
            button('Delete', 'Delete the selected set', () => setSelect.value && deleteSet(setSelect.value))),
        h('div', { class: 'row' },
            setName,
            button('Save as set', 'Save the current visible/hidden columns and order', () => {
                saveSet(setName.value);
                setName.value = '';
            })),
    );

    function refresh(): void {
        const { layout, info } = state;
        if (!layout || !info) {
            return;
        }
        const hidden = new Set(layout.hidden);
        count.textContent = `${layout.order.length - hidden.size} of ${layout.order.length} shown`;
        if (document.activeElement !== pinInput) {
            pinInput.value = String(layout.pinned);
        }

        const previous = setSelect.value;
        setSelect.replaceChildren(h('option', { value: '' }, '— saved sets —'));
        for (const name of Object.keys(layout.sets)) {
            setSelect.append(h('option', { value: name }, name));
        }
        setSelect.value = previous in layout.sets ? previous : '';

        list.replaceChildren();
        layout.order.forEach((c, position) => {
            const name = info.header[c] ?? `Column ${c + 1}`;
            if (filterText !== '' && !name.toLowerCase().includes(filterText)) {
                return;
            }
            const checkbox = h('input', { type: 'checkbox', checked: !hidden.has(c), 'aria-label': `Show ${name}` });
            checkbox.addEventListener('change', () => toggleColumn(c));
            const dot = h('span', { class: 'dot' });
            dot.style.background = columnColor(c, state.theme).edge;
            const item = h('div', { class: `picker-item${hidden.has(c) ? ' hidden-col' : ''}`, draggable: 'true' },
                h('span', { class: 'handle', title: 'Drag to reorder' }, '⠿'), checkbox, dot, h('span', { class: 'pname', title: name }, name));
            item.addEventListener('dragstart', (e) => {
                dragFrom = position;
                e.dataTransfer?.setData('text/plain', String(c));
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', () => item.classList.remove('dragging'));
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                item.classList.add('drop-target');
            });
            item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drop-target');
                if (dragFrom >= 0 && dragFrom !== position) {
                    moveColumn(dragFrom, position);
                }
                dragFrom = -1;
            });
            list.append(item);
        });
    }

    document.body.append(pop);
    popover = pop;
    refreshFn = refresh;
    refresh();
    finder.focus();
}
```

- [ ] **Step 3: Create `src/viewer/keyboard.ts`**

```ts
import { visibleColumns } from '../csv/core/layout';
import { emit, goToPage } from './actions';
import { closeMenu } from './dom';
import { hideColumn, showAll } from './layoutOps';
import { closePanel } from './panelCommon';
import { post, state } from './state';
import { select } from './table';

function move(rowDelta: number, colDelta: number): void {
    const layout = state.layout;
    if (!layout || state.rows.length === 0) {
        return;
    }
    const cols = visibleColumns(layout);
    if (cols.length === 0) {
        return;
    }
    const current = state.selected ?? { row: 0, col: cols[0] };
    const colIndex = Math.max(0, cols.indexOf(current.col));
    const row = Math.max(0, Math.min(state.rows.length - 1, current.row + rowDelta));
    const col = cols[Math.max(0, Math.min(cols.length - 1, colIndex + colDelta))];
    select(row, col);
}

export function mountKeyboard(): void {
    window.addEventListener('keydown', (e) => {
        const target = e.target as HTMLElement;
        const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();

        if (mod && key === 'f') {
            e.preventDefault();
            emit('focusSearch');
            return;
        }
        if (mod && e.shiftKey && key === 'h') {
            e.preventDefault();
            if (state.selected) {
                hideColumn(state.selected.col);
            }
            return;
        }
        if (mod && e.shiftKey && key === 'u') {
            e.preventDefault();
            showAll();
            return;
        }
        if (e.key === 'Escape') {
            closeMenu();
            if (state.panel) {
                closePanel();
            }
            return;
        }
        if (typing) {
            return;
        }
        if (mod && key === 'c') {
            const sel = state.selected;
            if (sel && !window.getSelection()?.toString()) {
                e.preventDefault();
                post({ type: 'copy', text: state.rows[sel.row]?.[sel.col] ?? '' });
            }
            return;
        }
        switch (e.key) {
            case 'PageDown':
                e.preventDefault();
                goToPage(state.page + 1);
                break;
            case 'PageUp':
                e.preventDefault();
                goToPage(state.page - 1);
                break;
            case 'ArrowDown':
                e.preventDefault();
                move(1, 0);
                break;
            case 'ArrowUp':
                e.preventDefault();
                move(-1, 0);
                break;
            case 'ArrowRight':
                e.preventDefault();
                move(0, 1);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                move(0, -1);
                break;
            case 'Enter':
                if (state.selected) {
                    e.preventDefault();
                    if (e.shiftKey) {
                        emit('openRecord', state.selected.row);
                    } else {
                        emit('openDetail', { row: state.selected.row, col: state.selected.col });
                    }
                }
                break;
        }
    });
}
```

- [ ] **Step 4: Wire into `src/viewer/main.ts`**

Add imports:

```ts
import { mountColumnPicker } from './columnPicker';
import { mountKeyboard } from './keyboard';
import { applyNonEmpty } from './layoutOps';
```

After `mountSidePanel(sideEl);` add:

```ts
mountColumnPicker();
mountKeyboard();
```

In the message switch, add before `case 'fileChanged':`:

```ts
        case 'nonEmpty':
            applyNonEmpty(m.columns);
            break;
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all pass (lint may print warnings only).

Manual check (F5, open `/tmp/sample-products.csv`):
  - **Columns** button opens a popover: untick `price` and it disappears from the table, the button reads `Columns (1 hidden)`; tick it back;
  - drag `sku` above `id` in the list: table column order changes; reload the file (close/reopen the tab) and the order, hidden columns and widths are still there (saved per file);
  - **Hide all** then **Show all**; **Invert**; type `desc` in the regex box and **Apply**: only `description` remains; **Show all**;
  - **Hide empty**: for the sample file nothing is empty so nothing hides; verify on a file with an all-empty column (edit a copy to blank one column) that it hides;
  - tick a value in a column's Unique values panel, then **Only filtered**: only that column stays; **Show all**;
  - save the current layout as set `Pricing` (name box + **Save as set**), change columns, pick `Pricing` and **Apply**: it restores; **Delete** removes it;
  - set **Pin first** to `2`: first two visible columns stay while scrolling right;
  - keyboard: arrow keys move a cell highlight, `PageDown/PageUp` change page, `Ctrl+F` focuses search, `Enter` opens detail, `Shift+Enter` opens the record, `Ctrl+C` copies the cell, `Ctrl+Shift+H` hides the selected column, `Ctrl+Shift+U` shows all, `Esc` closes the panel/menu/popover;
  - **Reset view** restores defaults.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/columnPicker.ts src/viewer/keyboard.ts src/viewer/layoutOps.ts src/viewer/main.ts
git commit -m "Add column picker (show/hide, reorder, smart toggles, sets) and keyboard shortcuts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Integration test, performance check, docs and 0.1.0 release

**Files:**
- Modify: `src/test/integration/extension.test.ts` (replace), `package.json` (metadata), `README.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-11-19-csv-viewer-design.md` (append §9)
- Create: `scripts/perf.mjs`

**Interfaces:**
- Consumes: `CsvViewerApi` (T10; `session.lastPage`), `CsvEngine` compiled to `out-test/csv/core/engine.js` (T8 + `npm run perf`'s tsc step).

- [ ] **Step 1: Replace `src/test/integration/extension.test.ts`**

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CsvViewerApi } from '../../csv/CsvEditorProvider';

async function waitFor(cond: () => boolean, ms = 20000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

suite('Extension integration', function () {
    this.timeout(90000);

    test('the remove-duplicates command still works', async () => {
        const doc = await vscode.workspace.openTextDocument({ content: 'a\na\n\nb\n', language: 'plaintext' });
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('get-unique-values.run');
        await waitFor(() => doc.getText() === 'a\nb');
        assert.strictEqual(doc.getText(), 'a\nb');
    });

    test('CSV Viewer opens a file and serves page 1', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-it-'));
        const file = path.join(dir, 'sample.csv');
        fs.writeFileSync(file, 'sku,name\nA1,Blue\nA2,Red\nA3,Blue\n');

        const ext = vscode.extensions.getExtension<CsvViewerApi>('boopathi08.get-unique-values');
        assert.ok(ext, 'extension not found');
        const api = await ext.activate();

        const uri = vscode.Uri.file(file);
        await vscode.commands.executeCommand('vscode.openWith', uri, 'getUniqueValues.csvViewer');
        await waitFor(() => api.sessions.get(uri.toString())?.lastPage !== undefined);

        const page = api.sessions.get(uri.toString())?.lastPage;
        assert.deepStrictEqual(page?.rows, [['A1', 'Blue'], ['A2', 'Red'], ['A3', 'Blue']]);
        assert.deepStrictEqual(page?.rowNumbers, [0, 1, 2]);
        assert.strictEqual(page?.total, 3);

        fs.rmSync(dir, { recursive: true, force: true });
    });
});
```

- [ ] **Step 2: Run the integration test**

Run: `npm run test:integration`
Expected: VS Code is downloaded on first run (needs network), the suite runs, `2 passing`. If the second test times out, open the Output panel logs of the test host: a missing `out/viewer.js` or `out/csvWorker.js` means `node esbuild.mjs` did not run.

- [ ] **Step 3: Create `scripts/perf.mjs`**

```js
// Usage: npm run perf -- [sizeMB=300] [shape=mixed|narrow]   (npm script passes --expose-gc)
//   mixed  : 20 columns, a 1-4 KB HTML description (with quotes + newlines) on every 10th row (~700k rows at 300 MB)
//   narrow : 20 columns, short rows (~1.5M rows at 300 MB)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { CsvEngine } = require('../out-test/csv/core/engine.js');

const targetMb = Number(process.argv[2] ?? 300);
const shape = process.argv[3] ?? 'mixed';
const file = path.join(os.tmpdir(), `perf-${targetMb}mb-${shape}.csv`);
const targetBytes = targetMb * 1024 * 1024;

function lorem(words) {
    return 'lorem ipsum dolor sit amet '.repeat(Math.ceil(words / 5)).slice(0, words * 6);
}

function generate() {
    if (fs.existsSync(file) && fs.statSync(file).size >= targetBytes) {
        return;
    }
    console.log(`generating ${file} ...`);
    const fd = fs.openSync(file, 'w');
    const header = ['id', 'sku', 'name', 'price', 'category', 'brand', 'color', 'size', 'stock', 'weight', 'status',
        'created', 'updated', 'vendor', 'tags', 'seo_title', 'seo_description', 'url', 'image', 'description'];
    fs.writeSync(fd, header.join(',') + '\n');
    let written = 0;
    let i = 0;
    let batch = [];
    while (written < targetBytes) {
        const long = shape === 'mixed' && i % 10 === 0;
        const description = long
            ? `<p>${lorem(150 + (i % 450))}</p>\n<ul><li>"feature" ${i}</li></ul>`
            : `Short text ${i}`;
        const row = [
            i, `SKU-${i}`, `Product ${i % 5000}`, (i % 997) / 10, `Category ${i % 40}`, `Brand ${i % 120}`,
            ['red', 'blue', 'green', ''][i % 4], ['S', 'M', 'L', 'XL'][i % 4], i % 300, i % 50,
            i % 7 === 0 ? 'draft' : 'active', '2024-01-01', '2024-06-01', `Vendor ${i % 60}`,
            `tag${i % 10};tag${i % 7}`, `Title ${i}`, `Meta ${i}`, `/p/${i}`, `/img/${i}.jpg`,
            `"${description.replace(/"/g, '""')}"`,
        ];
        batch.push(row.join(',') + '\n');
        if (batch.length >= 2000) {
            const chunk = batch.join('');
            fs.writeSync(fd, chunk);
            written += Buffer.byteLength(chunk);
            batch = [];
        }
        i++;
    }
    fs.writeSync(fd, batch.join(''));
    fs.closeSync(fd);
}

generate();
const sizeMb = fs.statSync(file).size / 1024 / 1024;
const noop = () => undefined;
const token = { cancelled: false };

// Retained memory after a forced GC (RSS also counts garbage that has not been collected yet).
const retainedMb = () => {
    globalThis.gc?.();
    const m = process.memoryUsage();
    return (m.heapUsed + m.external) / 1024 / 1024;
};
const memBefore = retainedMb();
const t0 = performance.now();
const engine = new CsvEngine(file);
const opened = await engine.open();
if (opened.kind !== 'ready') {
    throw new Error(`open failed: ${opened.kind}`);
}
const indexing = engine.index(noop, token);
await engine.getInfo();
await engine.readPage(0, 100);
const firstPage = performance.now() - t0;
await indexing;
const indexTime = performance.now() - t0;

const t1 = performance.now();
const unique = await engine.uniqueValues(4, token); // `category`
const uniqueTime = performance.now() - t1;
const memDelta = retainedMb() - memBefore;
await engine.dispose();

const rows = [
    ['first page', `${firstPage.toFixed(0)} ms`, firstPage < 1000],
    ['full index', `${(indexTime / 1000).toFixed(1)} s`, indexTime <= 10000],
    ['unique (1 column)', `${(uniqueTime / 1000).toFixed(1)} s (${unique?.distinct} distinct)`, uniqueTime <= 10000],
    ['retained memory increase', `${memDelta.toFixed(0)} MB`, memDelta < 100],
];
console.log(`\nfile: ${sizeMb.toFixed(0)} MB, shape: ${shape}`);
for (const [name, value, ok] of rows) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} ${value}`);
}
process.exit(rows.every((r) => r[2]) ? 0 : 1);
```

- [ ] **Step 4: Run the performance check**

Run: `npm run perf -- 300 mixed` then `npm run perf -- 300 narrow`
Expected: file generation takes ~10-30 s the first time, then four `PASS` lines each. If a target is missed (typical culprits: first-page time on a slow disk; index time on a 1.5M-row narrow file), note the numbers in the commit message and in the README "Performance" note rather than loosening the targets silently. Profile with `node --cpu-prof scripts/perf.mjs 300 narrow` if index time exceeds 10 s; the usual hot spots are `RowIndexer.push` (per-byte loop) and `parseRow` string concatenation.

- [ ] **Step 5: Update `package.json` metadata**

Set these fields (keep everything else):

```json
"displayName": "Get Unique Values & CSV Viewer",
"description": "Remove duplicate lines, and view huge CSV files fast: pagination, search, unique values per column, filters, column colours.",
"version": "0.1.0",
```

Replace the `keywords` array with:

```json
"keywords": [
    "unique",
    "duplicate",
    "remove duplicates",
    "clean",
    "format",
    "csv",
    "csv viewer",
    "large csv",
    "tsv"
],
```

- [ ] **Step 6: Replace `README.md`**

````markdown
# Get Unique Values & CSV Viewer

Two tools in one extension:

1. **Get Unique Values**: remove duplicate and empty lines from a file or selection (`Ctrl+Alt+U`).
2. **CSV Viewer**: open huge CSV / TSV / PSV files (300 MB and well beyond) in a fast table with pagination, search, unique values per column, filters, per-column colours and full control over which columns are shown.

## CSV Viewer

Open a file with **right-click → Open in CSV Viewer**, the button in the editor title bar, or **Open With… → CSV Viewer**. The normal text editor stays the default for `.csv` files.

| Feature | What it does |
|---|---|
| Large files | The file is indexed once in a background thread and pages are read from disk on demand. Page 1 appears immediately while indexing continues. |
| Pagination | 50 / 100 / 250 / 500 / 1000 rows per page, first / previous / next / last, jump to page or to a row number. |
| Search | All columns or one column; match case, whole cell, regular expression; streamed results with progress and Cancel. |
| Unique values | Column menu → *Unique values*: every distinct value with count and percentage. Tick values to filter the table. |
| Column colours | Every column header (and cell edge) gets its own colour, adapted to light, dark and high-contrast themes. |
| Long cells | One truncated line by default (or 3 wrapped lines, or full). Double-click a cell for the full value; format JSON, copy, or open it in an editor tab (HTML/JSON highlighting). |
| Record view | See one row as a vertical column → value list. |
| Show / hide columns | Column picker with search, show all / hide all / invert, drag to reorder, *Hide empty*, *Only filtered*, name-pattern filter, saved column sets, pin the first N columns, resize by dragging. Everything is remembered per file. |
| Bad rows | Rows whose column count differs from the first row are counted; click the warning in the status bar to list just them. |
| Auto-detect | Delimiter, header row and encoding (UTF-8 / Latin-1) are detected; click the chip in the toolbar to override. |
| Copy | Copy a cell, or a row as CSV or JSON. |

Keyboard: arrows move the cell, `PageUp`/`PageDown` change page, `Ctrl+F` search, `Enter` cell detail, `Shift+Enter` record view, `Ctrl+C` copy cell, `Ctrl+Shift+H` hide column, `Ctrl+Shift+U` show all columns, `Esc` close panel.

### Settings

| Setting | Default | |
|---|---|---|
| `getUniqueValues.csv.defaultPageSize` | `100` | Rows per page (50, 100, 250, 500, 1000) |
| `getUniqueValues.csv.columnColors` | `headerAndCells` | `header`, `headerAndCells` or `off` |
| `getUniqueValues.csv.longText` | `truncate` | `truncate`, `wrap` or `full` |
| `getUniqueValues.csv.defaultColumnWidth` | `300` | Pixels |

### Limitations in 0.1.0

Read-only (editing, sorting, export and AI prompts are planned). UTF-16 files are detected but not yet supported.

## Get Unique Values

1. Open any file.
2. Select lines (or leave the selection empty to process the whole file).
3. Press `Ctrl+Alt+U` (`Cmd+Alt+U` on macOS), or run **Get Unique Values** from the Command Palette.

Duplicate lines and blank lines are removed; the first occurrence keeps its position.

---

Developed by Boopathi.
````

- [ ] **Step 7: Replace `CHANGELOG.md`**

```markdown
# Change Log

All notable changes to the "get-unique-values" extension are documented in this file.

## [0.1.0]

### Added
- **CSV Viewer** for `.csv`, `.tsv`, `.psv` (Open With… → CSV Viewer, editor title button, Explorer context menu).
- Streaming row index with on-demand pages: works on 300 MB+ files; first page shows while indexing continues.
- Pagination, search (all columns or one; match case / whole cell / regex; cancellable), unique values per column with counts and tick-to-filter.
- A distinct colour per column; truncate / wrap / full long-cell modes; cell detail panel (format JSON, copy, open in editor tab); record view.
- Column picker: show/hide, reorder, resize, pin, hide empty, name-pattern filter, saved column sets; layout remembered per file.
- Bad-row detection and unclosed-quote recovery; delimiter / header / encoding auto-detection with manual override.
- Settings: `getUniqueValues.csv.defaultPageSize`, `columnColors`, `longText`, `defaultColumnWidth`.

### Changed
- The extension no longer activates at startup; it activates when a command or the CSV Viewer is used.

## [0.0.1]

- Initial release: remove duplicate and empty lines from a file or selection.
```

- [ ] **Step 8: Append §9 to the spec**

Append this section to the end of `docs/superpowers/specs/2026-11-19-csv-viewer-design.md` (it records where the implementation intentionally differs from §2-§6; where they disagree, §9 wins):

```markdown

## 9. Implementation notes for v0.1.0

Where this section disagrees with §2-§6, this section wins.

1. **Source layout.** Webview sources are in `src/viewer/` (only `viewer.css` is in `media/`). Shared pure types are in `src/csv/types.ts`. The core also contains `engine.ts` (index, paging, filter, unique, empty-column scan), `predicates.ts` (replaces `scanner.ts`), `layout.ts`, `colors.ts` and `textUtil.ts`; `WorkerClient.ts` wraps the worker.
2. **UTF-16** files are detected (BOM) but show an "unsupported encoding" message in v0.1.0; support lands with M2 (§8.6).
3. **No page LRU cache** (§3.2): one page is a single `fs.read`.
4. **Unique panel** renders at most 500 rows at a time; its search box narrows them. The worker still returns up to 100,000 distinct values.
5. **"Only filtered" column toggle** keeps columns that have a column filter or are the search column (not columns with a search hit).
6. **Perf script** (`npm run perf -- 300 mixed|narrow`) uses two shapes: *mixed* (20 columns, 1-4 KB HTML description with quotes and newlines on every 10th row, about 700k rows at 300 MB) and *narrow* (short rows, about 1.5M rows). "1.5M rows × 1-4 KB" cannot fit in 300 MB.
7. **Unclosed quote** recovery rewinds to the opening quote and ignores quotes until the end of that line; the row is then shown split on the delimiter.
8. **Blank lines** are never rows.
```

- [ ] **Step 9: Full verification and packaging**

Run:
```bash
npm run typecheck && npm run lint && npm run test:unit && npm run test:integration
npx --yes @vscode/vsce package --no-dependencies
unzip -l get-unique-values-0.1.0.vsix | grep -E "extension/(out|media|package.json|README|LICENSE)"
```
Expected: type-check and lint clean (lint warnings acceptable, no errors); unit tests all pass; integration `2 passing`; `vsce` writes `get-unique-values-0.1.0.vsix`; the listing shows `out/extension.js`, `out/csvWorker.js`, `out/viewer.js`, `media/viewer.css`, `package.json`, `README.md`, `LICENSE` and **no** `src/`, `out-test/`, `scripts/` or `docs/` entries.

Final manual pass: install the vsix (`code --install-extension get-unique-values-0.1.0.vsix --force`), restart, and open one of your real files from `~/Downloads/cdi/1_client_data` (read-only) plus a 1 GB+ file if you have one; confirm paging, search, unique values and hide/show columns behave.

- [ ] **Step 10: Commit**

```bash
git add src/test/integration/extension.test.ts scripts/perf.mjs package.json package-lock.json README.md CHANGELOG.md docs/superpowers/specs/2026-11-19-csv-viewer-design.md
git commit -m "Release 0.1.0: integration test, perf script, docs" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Publishing (`vsce publish`) is a separate, outward-facing step: do it only when you decide to release.

---

## Self-review (spec coverage)

| Spec requirement | Task |
|---|---|
| §1 existing command unchanged | T1 (moved verbatim), T15 integration test |
| §2.1 custom editor `priority: option`, command + title/explorer menus | T10 |
| §2.2 worker, pure core modules, no `vscode` import in core | T1-T9 |
| §2.3 esbuild bundles, no runtime deps, `.vscodeignore` | T1 |
| §3.1 detect (encoding, binary, delimiter, header), override chip + QuickPicks, index, progress, first page early, unclosed quote | T3, T5, T8, T10, T11 (chip), T12 |
| §3.2 paging, filtered paging via result set, page sizes, jump to page/row | T8, T11 |
| §3.3 search modes, scope, streaming, progress + cancel, AND with column filters | T6, T8, T12 |
| §3.4 unique values, counts, empty row, sort, panel search, tick-to-filter, 100k cap, cache | T8, T13 |
| §3.5 file watcher banner + reload, deleted | T10, T11 (banner) |
| §4.1 golden-angle colours, 3 modes, high-contrast | T7, T11 |
| §4.2 long cells, tooltip 500 chars, detail panel, format JSON, copy, open in editor tab, modes, record view | T11, T13 |
| §4.3 column picker, quick hide/show, smart toggles, named sets, shortcuts, resize, pin, per-file persistence keyed by header hash, reset | T7, T11, T14 |
| §4.4 keyboard, copy row as CSV/JSON | T11, T14 |
| §4.5 status line, bad-rows click | T11 |
| §4.6 settings | T10 |
| §4.7 CSP, textContent, localResourceRoots | T10, T11 (rules) |
| §5 error handling table | T3 (unclosed quote), T8 (binary/empty), T10/T11 (worker errors via `fatal`/banner), T12 (invalid regex inline) |
| §6 testing: unit incl. chunk boundaries, integration, perf, manual | T3-T9, T15 |
| §7 release 0.1.0 | T15 |

Known intentional gaps (documented in §9 / Deviations): UTF-16, page LRU, 500-row unique render cap. Worker crash shows an error banner; an explicit "Retry" button is covered by the banner's *Reload* only for file changes, so after a fatal worker error the user reopens the tab (the spec's Retry button is deferred to M1 along with the other robustness work).
