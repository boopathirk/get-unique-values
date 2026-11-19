# CSV Data Checks (v0.1.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add column type detection, a column stats panel, a duplicate key finder and a large-file prompt to the Data Toolkit CSV viewer.

**Architecture:** Pure analysis code in `src/csv/core/columnStats.ts`; two new cancellable engine scans (`columnStats`, `duplicateKeys`) using the existing `scan()`; two new worker request types forwarded by `CsvSession`; two new side panels in the webview. The large-file prompt is a separate extension-host module.

**Tech Stack:** TypeScript, esbuild, mocha (tdd UI), VS Code API. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-csv-viewer-design.md` §8 features 9, 12, 13, 14.

**Deferred to the next plan (v0.1.3):** parse presets (1), skip lines / comment lines (2), header row number (3), quote/escape chars (4), trim toggle (5), JSONL (8), streamed dedupe (11). Multi-column duplicate keys are supported by the engine; the UI offers a single column.

## Global Constraints

- Webview CSP: nonce script only, no inline styles, no `innerHTML` (build DOM with `h()` from `src/viewer/dom.ts`).
- Worker/engine code stays pure TS (no `vscode` import under `src/csv/core` and `src/csv/worker`).
- Every long scan takes a `CancelToken` and returns `null` when cancelled.
- Existing 97 unit tests must keep passing; `npm run typecheck` must be clean after every task.
- Tests: mocha `suite`/`test` (tdd), run with `npm run test:unit`.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

---

### Task 1: Column type detection and stats accumulator (pure)

**Files:**
- Create: `src/csv/core/columnStats.ts`
- Modify: `src/csv/types.ts` (append types)
- Test: `src/test/unit/columnStats.test.ts`

**Interfaces:**
- Produces (types.ts):
```ts
export type ColumnType = 'integer' | 'number' | 'boolean' | 'date' | 'url' | 'email' | 'json' | 'html' | 'text';

export interface ColumnStats {
    column: number;
    type: ColumnType;
    rows: number;
    empty: number;
    distinct: number;
    distinctCapped: boolean;
    min: string;
    max: string;
    numeric: boolean;
    minLen: number;
    maxLen: number;
    avgLen: number;
    samples: string[];
}
```
- Produces (columnStats.ts): `detectColumnType(values: string[]): ColumnType`, `class StatsAccumulator { constructor(column: number, distinctCap?: number); add(value: string): void; result(): ColumnStats }`

- [ ] **Step 1: Append the types above to `src/csv/types.ts`.**

- [ ] **Step 2: Write the failing test** `src/test/unit/columnStats.test.ts`

```ts
import * as assert from 'assert';
import { StatsAccumulator, detectColumnType } from '../../csv/core/columnStats';

suite('detectColumnType', () => {
    test('integers', () => assert.strictEqual(detectColumnType(['1', '22', '-3', '+4']), 'integer'));
    test('numbers', () => assert.strictEqual(detectColumnType(['1.5', '2', '3e4']), 'number'));
    test('booleans', () => assert.strictEqual(detectColumnType(['true', 'FALSE', 'Yes', 'no']), 'boolean'));
    test('dates', () => assert.strictEqual(detectColumnType(['2024-01-31', '2024-02-01T10:20:30Z', '2024-03-04 05:06']), 'date'));
    test('urls', () => assert.strictEqual(detectColumnType(['https://a.com/x', 'http://b.org']), 'url'));
    test('emails', () => assert.strictEqual(detectColumnType(['a@b.com', 'c.d@e.org']), 'email'));
    test('json', () => assert.strictEqual(detectColumnType(['{"a":1}', '[1,2]']), 'json'));
    test('html', () => assert.strictEqual(detectColumnType(['<p>x</p>', '<b>y</b>']), 'html'));
    test('ignores blanks', () => assert.strictEqual(detectColumnType(['1', '', '  ', '2']), 'integer'));
    test('95% rule: 1 bad of 20 still integer', () => {
        assert.strictEqual(detectColumnType([...Array(19).fill('7'), 'x']), 'integer');
    });
    test('below 95% is text', () => assert.strictEqual(detectColumnType(['1', '2', 'x', 'y']), 'text'));
    test('empty input is text', () => assert.strictEqual(detectColumnType([]), 'text'));
});

suite('StatsAccumulator', () => {
    test('numeric column', () => {
        const a = new StatsAccumulator(2);
        for (const v of ['10', '2', '', '30', '2']) {
            a.add(v);
        }
        const r = a.result();
        assert.strictEqual(r.column, 2);
        assert.strictEqual(r.type, 'integer');
        assert.strictEqual(r.rows, 5);
        assert.strictEqual(r.empty, 1);
        assert.strictEqual(r.distinct, 3);
        assert.strictEqual(r.numeric, true);
        assert.strictEqual(r.min, '2');
        assert.strictEqual(r.max, '30');
        assert.strictEqual(r.minLen, 1);
        assert.strictEqual(r.maxLen, 2);
        assert.strictEqual(r.avgLen, 1.5);
        assert.deepStrictEqual(r.samples, ['10', '2', '30']);
    });
    test('text column uses lexicographic min/max', () => {
        const a = new StatsAccumulator(0);
        for (const v of ['pear', 'apple', 'zed']) {
            a.add(v);
        }
        const r = a.result();
        assert.strictEqual(r.numeric, false);
        assert.strictEqual(r.min, 'apple');
        assert.strictEqual(r.max, 'zed');
    });
    test('distinct is capped', () => {
        const a = new StatsAccumulator(0, 3);
        for (const v of ['a', 'b', 'c', 'd', 'e']) {
            a.add(v);
        }
        const r = a.result();
        assert.strictEqual(r.distinct, 3);
        assert.strictEqual(r.distinctCapped, true);
    });
    test('all empty', () => {
        const a = new StatsAccumulator(0);
        a.add('');
        a.add(' ');
        const r = a.result();
        assert.strictEqual(r.empty, 2);
        assert.strictEqual(r.distinct, 0);
        assert.strictEqual(r.min, '');
        assert.strictEqual(r.type, 'text');
    });
});
```

- [ ] **Step 3: Run** `npm run test:unit` — Expected: FAIL (module not found).

- [ ] **Step 4: Implement** `src/csv/core/columnStats.ts`

```ts
import type { ColumnStats, ColumnType } from '../types';

const SAMPLE_SIZE = 1000;
const MATCH_RATIO = 0.95;
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const CHECKS: Array<[ColumnType, (v: string) => boolean]> = [
    ['integer', (v) => /^[-+]?\d+$/.test(v)],
    ['number', (v) => NUMBER_RE.test(v)],
    ['boolean', (v) => /^(true|false|yes|no)$/i.test(v)],
    ['date', (v) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)],
    ['url', (v) => /^https?:\/\/\S+$/i.test(v)],
    ['email', (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)],
    ['json', isJson],
    ['html', (v) => /<\/?[a-z][^>]*>/i.test(v)],
];

function isJson(v: string): boolean {
    if (!(v.startsWith('{') || v.startsWith('['))) {
        return false;
    }
    try {
        JSON.parse(v);
        return true;
    } catch {
        return false;
    }
}

/** Guess a column type from sample values: the first type that matches at least 95% of the non-blank values. */
export function detectColumnType(values: string[]): ColumnType {
    const sample = values.map((v) => v.trim()).filter((v) => v !== '').slice(0, SAMPLE_SIZE);
    if (sample.length === 0) {
        return 'text';
    }
    for (const [type, test] of CHECKS) {
        const hits = sample.reduce((n, v) => n + (test(v) ? 1 : 0), 0);
        if (hits / sample.length >= MATCH_RATIO) {
            return type;
        }
    }
    return 'text';
}

export class StatsAccumulator {
    private rows = 0;
    private empty = 0;
    private readonly seen = new Set<string>();
    private capped = false;
    private lexMin: string | undefined;
    private lexMax: string | undefined;
    private numMin = Infinity;
    private numMax = -Infinity;
    private allNumeric = true;
    private minLen = Infinity;
    private maxLen = 0;
    private totalLen = 0;
    private nonEmpty = 0;
    private readonly samples: string[] = [];
    private readonly typeSample: string[] = [];

    constructor(private readonly column: number, private readonly distinctCap = 100_000) { }

    add(value: string): void {
        this.rows++;
        const v = value.trim();
        if (v === '') {
            this.empty++;
            return;
        }
        this.nonEmpty++;
        if (this.seen.size < this.distinctCap) {
            if (!this.seen.has(value)) {
                this.seen.add(value);
                if (this.samples.length < 5) {
                    this.samples.push(value);
                }
            }
        } else if (!this.seen.has(value)) {
            this.capped = true;
        }
        if (this.typeSample.length < SAMPLE_SIZE) {
            this.typeSample.push(value);
        }
        if (this.lexMin === undefined || value < this.lexMin) {
            this.lexMin = value;
        }
        if (this.lexMax === undefined || value > this.lexMax) {
            this.lexMax = value;
        }
        if (this.allNumeric) {
            if (NUMBER_RE.test(v)) {
                const n = Number(v);
                this.numMin = Math.min(this.numMin, n);
                this.numMax = Math.max(this.numMax, n);
            } else {
                this.allNumeric = false;
            }
        }
        this.minLen = Math.min(this.minLen, value.length);
        this.maxLen = Math.max(this.maxLen, value.length);
        this.totalLen += value.length;
    }

    result(): ColumnStats {
        const numeric = this.allNumeric && this.nonEmpty > 0;
        const lexMin = this.lexMin ?? '';
        const lexMax = this.lexMax ?? '';
        return {
            column: this.column,
            type: detectColumnType(this.typeSample),
            rows: this.rows,
            empty: this.empty,
            distinct: this.seen.size,
            distinctCapped: this.capped,
            min: numeric ? String(this.numMin) : lexMin,
            max: numeric ? String(this.numMax) : lexMax,
            numeric,
            minLen: this.nonEmpty > 0 ? this.minLen : 0,
            maxLen: this.maxLen,
            avgLen: this.nonEmpty > 0 ? this.totalLen / this.nonEmpty : 0,
            samples: this.samples.slice(),
        };
    }
}
```

- [ ] **Step 5: Run** `npm run test:unit` — Expected: all pass (97 + new). `npm run typecheck` clean.

- [ ] **Step 6: Commit**
```bash
git add src/csv/types.ts src/csv/core/columnStats.ts src/test/unit/columnStats.test.ts
git commit -m "Add column type detection and stats accumulator"
```

---

### Task 2: Engine scans for column stats and duplicate keys

**Files:**
- Modify: `src/csv/types.ts` (append `DuplicateGroup`, `DuplicateResult`)
- Modify: `src/csv/core/engine.ts` (add two methods and caches)
- Test: `src/test/unit/analysis.test.ts` (new; copies the small `load` helper pattern from `src/test/unit/engine.test.ts` lines 10-45)

**Interfaces:**
- Consumes: `CsvEngine.scan` (private, same file), `StatsAccumulator` from Task 1.
- Produces (types.ts):
```ts
export interface DuplicateGroup {
    /** One value per key column, in the order requested. */
    key: string[];
    count: number;
    /** 0-based data row number of the first occurrence. */
    firstRow: number;
}

export interface DuplicateResult {
    columns: number[];
    groups: DuplicateGroup[];
    /** Keys that occur more than once (before truncation). */
    duplicateKeys: number;
    /** Rows that belong to a duplicated key (before truncation). */
    duplicateRows: number;
    truncated: boolean;
    /** True when more than DUPLICATE_KEY_CAP distinct keys were seen: counts for later keys are unknown. */
    capped: boolean;
}
```
- Produces (engine.ts): `async columnStats(column: number, token: CancelToken, onProgress?: (scanned: number, total: number) => void): Promise<ColumnStats | null>` and `async duplicateKeys(columns: number[], token: CancelToken, onProgress?: (scanned: number, total: number) => void): Promise<DuplicateResult | null>`; exported consts `DUPLICATE_KEY_CAP = 3_000_000`, `DUPLICATE_GROUP_CAP = 10_000`.

- [ ] **Step 1: Write the failing tests** `src/test/unit/analysis.test.ts`

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvEngine, Tuning } from '../../csv/core/engine';
import type { CancelToken } from '../../csv/types';

const TINY: Tuning = { chunkBytes: 7, scanBytes: 16, maxQuoteBytes: 1 << 20 };
const CSV = 'id,name,price\n1,Blue,10\n2,Red,\n3,Blue,30\n4,blue,10\n5,Red,20\n';
const live = (): CancelToken => ({ cancelled: false });

suite('CsvEngine analysis', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-analysis-'));
    const engines: CsvEngine[] = [];
    let counter = 0;

    async function load(content: string): Promise<CsvEngine> {
        const p = path.join(dir, `f${counter++}.csv`);
        fs.writeFileSync(p, content);
        const engine = new CsvEngine(p, {}, TINY);
        engines.push(engine);
        assert.strictEqual((await engine.open()).kind, 'ready');
        const indexing = engine.index(() => undefined, live());
        await engine.getInfo();
        await indexing;
        return engine;
    }

    suiteTeardown(async () => {
        for (const e of engines) {
            await e.dispose();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('columnStats: numeric column with an empty cell', async () => {
        const engine = await load(CSV);
        const s = await engine.columnStats(2, live());
        assert.ok(s);
        assert.strictEqual(s.type, 'integer');
        assert.strictEqual(s.rows, 5);
        assert.strictEqual(s.empty, 1);
        assert.strictEqual(s.distinct, 3);
        assert.strictEqual(s.min, '10');
        assert.strictEqual(s.max, '30');
    });

    test('columnStats: result is cached', async () => {
        const engine = await load(CSV);
        const a = await engine.columnStats(1, live());
        const b = await engine.columnStats(1, live());
        assert.strictEqual(a, b);
    });

    test('columnStats: cancelled scan returns null and is not cached', async () => {
        const engine = await load(CSV);
        assert.strictEqual(await engine.columnStats(1, { cancelled: true }), null);
        assert.ok(await engine.columnStats(1, live()));
    });

    test('duplicateKeys: single column, case-sensitive', async () => {
        const engine = await load(CSV);
        const r = await engine.duplicateKeys([1], live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count, g.firstRow]), [
            [['Blue'], 2, 0],
            [['Red'], 2, 1],
        ]);
        assert.strictEqual(r.duplicateKeys, 2);
        assert.strictEqual(r.duplicateRows, 4);
        assert.strictEqual(r.truncated, false);
    });

    test('duplicateKeys: two columns', async () => {
        const engine = await load(CSV);
        const r = await engine.duplicateKeys([1, 2], live());
        assert.ok(r);
        assert.strictEqual(r.groups.length, 0);
    });

    test('duplicateKeys: no duplicates in a unique column', async () => {
        const engine = await load(CSV);
        const r = await engine.duplicateKeys([0], live());
        assert.ok(r);
        assert.strictEqual(r.groups.length, 0);
        assert.strictEqual(r.duplicateRows, 0);
    });

    test('duplicateKeys: cancelled returns null', async () => {
        const engine = await load(CSV);
        assert.strictEqual(await engine.duplicateKeys([1], { cancelled: true }), null);
    });

    test('duplicateKeys: empty column list is rejected', async () => {
        const engine = await load(CSV);
        await assert.rejects(() => engine.duplicateKeys([], live()));
    });
});
```

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL (methods missing).

- [ ] **Step 3: Append the two interfaces to `src/csv/types.ts`.**

- [ ] **Step 4: Implement in `src/csv/core/engine.ts`.** Add `import { StatsAccumulator } from './columnStats';`, extend the type import with `ColumnStats, DuplicateGroup, DuplicateResult`, add after `UNIQUE_CAP`:

```ts
export const DUPLICATE_KEY_CAP = 3_000_000;
export const DUPLICATE_GROUP_CAP = 10_000;
```
add a field next to `uniqueCache`:
```ts
    private readonly statsCache = new Map<number, ColumnStats>();
```
and these methods after `nonEmptyColumns` (before `dispose`):

```ts
    async columnStats(
        column: number,
        token: CancelToken,
        onProgress?: (scanned: number, total: number) => void,
    ): Promise<ColumnStats | null> {
        await this.indexFinished;
        this.throwIfIndexFailed();
        const cached = this.statsCache.get(column);
        if (cached) {
            return cached;
        }
        const total = this.dataRowCount;
        const acc = new StatsAccumulator(column);
        const outcome = await this.scan(
            [[0, total]],
            token,
            (_rowNum, fields) => {
                acc.add(fields[column] ?? '');
            },
            (scanned) => onProgress?.(scanned, total),
        );
        if (outcome === 'cancelled') {
            return null;
        }
        const result = acc.result();
        this.statsCache.set(column, result);
        return result;
    }

    /** Keys (one or more columns) that occur more than once, with counts and the row of the first occurrence. */
    async duplicateKeys(
        columns: number[],
        token: CancelToken,
        onProgress?: (scanned: number, total: number) => void,
    ): Promise<DuplicateResult | null> {
        if (columns.length === 0) {
            throw new Error('Choose at least one key column.');
        }
        await this.indexFinished;
        this.throwIfIndexFailed();
        const total = this.dataRowCount;
        const seen = new Map<string, { n: number; first: number }>();
        let capped = false;
        const outcome = await this.scan(
            [[0, total]],
            token,
            (rowNum, fields) => {
                const key = columns.map((c) => fields[c] ?? '').join('\u0001');
                const entry = seen.get(key);
                if (entry) {
                    entry.n++;
                } else if (seen.size < DUPLICATE_KEY_CAP) {
                    seen.set(key, { n: 1, first: rowNum });
                } else {
                    capped = true;
                }
            },
            (scanned) => onProgress?.(scanned, total),
        );
        if (outcome === 'cancelled') {
            return null;
        }
        const groups: DuplicateGroup[] = [];
        let duplicateRows = 0;
        let duplicateKeys = 0;
        for (const [key, { n, first }] of seen) {
            if (n > 1) {
                duplicateKeys++;
                duplicateRows += n;
                groups.push({ key: key.split('\u0001'), count: n, firstRow: first });
            }
        }
        groups.sort((a, b) => b.count - a.count || a.firstRow - b.firstRow);
        return {
            columns,
            groups: groups.slice(0, DUPLICATE_GROUP_CAP),
            duplicateKeys,
            duplicateRows,
            truncated: groups.length > DUPLICATE_GROUP_CAP,
            capped,
        };
    }
```

Note: a key column value containing `\u0001` would split wrongly; this is accepted (control character in CSV data is vanishingly rare) and the engine test does not cover it.

- [ ] **Step 5: Run** `npm run test:unit` and `npm run typecheck` — Expected: all pass.

- [ ] **Step 6: Commit**
```bash
git add src/csv/types.ts src/csv/core/engine.ts src/test/unit/analysis.test.ts
git commit -m "Add column stats and duplicate key scans to the engine"
```

---

### Task 3: Worker, protocol and session wiring

**Files:**
- Modify: `src/csv/protocol.ts`
- Modify: `src/csv/worker/csvWorker.ts`
- Modify: `src/csv/CsvSession.ts`

**Interfaces:**
- Consumes: `CsvEngine.columnStats`, `CsvEngine.duplicateKeys` (Task 2).
- Produces (protocol.ts):
  - `WorkerRequest` gains `| { id: number; type: 'stats'; column: number } | { id: number; type: 'duplicates'; columns: number[] }`
  - `HostToView` gains `| { type: 'stats'; jobId: number; result: ColumnStats | null; error?: string } | { type: 'duplicates'; jobId: number; result: DuplicateResult | null; error?: string }`
  - `ViewToHost` gains `| { type: 'stats'; jobId: number; column: number } | { type: 'duplicates'; jobId: number; columns: number[] }`, and the `cancel` message's `kind` becomes `'filter' | 'unique' | 'analysis'`.
  - Import `ColumnStats, DuplicateResult` from `./types`.

- [ ] **Step 1: protocol.ts** — apply the additions above.

- [ ] **Step 2: csvWorker.ts** — add two cases in `handle()` after `'unique'`, same pattern:

```ts
            case 'stats': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().columnStats(req.column, token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
            case 'duplicates': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().duplicateKeys(req.columns, token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
```

- [ ] **Step 3: CsvSession.ts**
  - Add field `private readonly analysisJobs = new Map<number, number>();` next to `uniqueJobs`; clear it in `openFile()` next to `this.uniqueJobs.clear();`.
  - Add cases to `handleMessage`:
```ts
            case 'stats':
                this.startAnalysis(m.jobId, { type: 'stats', column: m.column }, (result, error) =>
                    this.post({ type: 'stats', jobId: m.jobId, result: result as ColumnStats | null, error }));
                break;
            case 'duplicates':
                this.startAnalysis(m.jobId, { type: 'duplicates', columns: m.columns }, (result, error) =>
                    this.post({ type: 'duplicates', jobId: m.jobId, result: result as DuplicateResult | null, error }));
                break;
```
  - Change the `cancel` case lookup to pick the map by kind: `m.kind === 'unique' ? this.uniqueJobs : m.kind === 'analysis' ? this.analysisJobs : this.filterJobs`.
  - Add the method (mirrors `startUnique`):
```ts
    private startAnalysis(
        jobId: number,
        body: { type: 'stats'; column: number } | { type: 'duplicates'; columns: number[] },
        reply: (result: unknown, error?: string) => void,
    ): void {
        const { id, promise } = this.worker.request<unknown>(body);
        this.analysisJobs.set(jobId, id);
        promise
            .then(
                (result) => reply(result),
                (err) => reply(null, errorMessage(err)),
            )
            .finally(() => {
                if (this.analysisJobs.get(jobId) === id) {
                    this.analysisJobs.delete(jobId);
                }
            });
    }
```
  - Extend the `./types` import with `ColumnStats, DuplicateResult`.

- [ ] **Step 3b:** Check `WorkerClient.request`'s generic signature accepts the new request bodies (it takes `RequestBody`, derived from `WorkerRequest`, so no change expected). If `npm run typecheck` complains, fix the typing there.

- [ ] **Step 4: Run** `npm run typecheck` and `npm run test:unit` — Expected: clean; all tests pass. (No new unit test: this task is wiring covered by Task 2's engine tests and Task 6's integration smoke.)

- [ ] **Step 5: Commit**
```bash
git add src/csv/protocol.ts src/csv/worker/csvWorker.ts src/csv/CsvSession.ts
git commit -m "Wire column stats and duplicate scans through worker and session"
```

---

### Task 4: Webview panels (stats, duplicates) and header type hint

**Files:**
- Create: `src/viewer/statsPanel.ts`, `src/viewer/duplicatesPanel.ts`
- Modify: `src/viewer/state.ts`, `src/viewer/sidePanel.ts`, `src/viewer/main.ts`, `src/viewer/table.ts`, `src/viewer/actions.ts`, `media/viewer.css`

**Interfaces:**
- Consumes: protocol messages from Task 3; `applyFilters`, `emit`, `on` (`actions.ts`); `h`, `fmt` (`dom.ts`); `panelHeader` (`panelCommon.ts`); `post`, `state` (`state.ts`); `detectColumnType` (Task 1).
- Produces: bus events `openStats` (arg `number` column) and `openDuplicates` (arg `number` column); `Panel` gains `{ kind: 'stats'; column: number } | { kind: 'duplicates'; column: number }`.

- [ ] **Step 1: state.ts**
  - Import `ColumnStats, DuplicateResult` from `../csv/types`.
  - Extend `Panel` with the two new kinds.
  - Add to `state` (after `uniqueError`):
```ts
    stats: null as ColumnStats | null,
    duplicates: null as DuplicateResult | null,
    analysisLoading: false,
    analysisJob: 0,
    analysisError: '',
```
  - In `resetForNewFile()` add:
```ts
    state.stats = null;
    state.duplicates = null;
    state.analysisLoading = false;
    state.analysisError = '';
    state.analysisJob++;
```

- [ ] **Step 2: actions.ts** — in `closeRowPanels()` change the condition so only row panels close:
```ts
    if (state.panel && (state.panel.kind === 'detail' || state.panel.kind === 'record')) {
```

- [ ] **Step 3: `src/viewer/statsPanel.ts`**

```ts
import { emit } from './actions';
import { fmt, h } from './dom';
import { panelHeader } from './panelCommon';
import { post, state } from './state';

export function openStats(column: number): void {
    state.panel = { kind: 'stats', column };
    state.stats = null;
    state.analysisLoading = true;
    state.analysisError = '';
    state.analysisJob++;
    post({ type: 'stats', jobId: state.analysisJob, column });
    emit('panel');
}

export function renderStats(root: HTMLElement, column: number): void {
    const name = state.info?.header[column] ?? `Column ${column + 1}`;
    root.append(panelHeader(`Column stats: ${name}`));
    const body = h('div', { class: 'side-body' });
    root.append(body);
    if (state.analysisLoading) {
        const cancel = h('button', {}, 'Cancel');
        cancel.addEventListener('click', () => post({ type: 'cancel', kind: 'analysis', jobId: state.analysisJob }));
        body.append(h('div', { class: 'message' }, 'Scanning the column…'), cancel);
        return;
    }
    if (state.analysisError) {
        body.append(h('div', { class: 'message err' }, `Could not scan the column: ${state.analysisError}`));
        return;
    }
    const s = state.stats;
    if (!s || s.column !== column) {
        body.append(h('div', { class: 'message' }, 'The scan was cancelled. Choose "Column stats" again to retry.'));
        return;
    }
    const pct = (n: number): string => (s.rows > 0 ? `${((n / s.rows) * 100).toFixed(1)}%` : '0%');
    const rows: Array<[string, string]> = [
        ['Type', s.type],
        ['Rows', fmt(s.rows)],
        ['Empty', `${fmt(s.empty)} (${pct(s.empty)})`],
        ['Distinct', `${fmt(s.distinct)}${s.distinctCapped ? '+ (capped)' : ''}`],
        [s.numeric ? 'Min (number)' : 'Min (text order)', s.min],
        [s.numeric ? 'Max (number)' : 'Max (text order)', s.max],
        ['Length min / avg / max', `${s.minLen} / ${s.avgLen.toFixed(1)} / ${s.maxLen}`],
    ];
    const table = h('div', { class: 'stats-grid' });
    for (const [label, value] of rows) {
        table.append(h('span', { class: 'stats-k' }, label), h('span', { class: 'stats-v', title: value }, value));
    }
    body.append(table, h('div', { class: 'u-summary' }, 'Sample values'));
    for (const sample of s.samples) {
        body.append(h('div', { class: 'stats-sample', title: sample }, sample.length > 200 ? `${sample.slice(0, 200)}…` : sample));
    }
}
```

- [ ] **Step 4: `src/viewer/duplicatesPanel.ts`**

```ts
import { applyFilters, emit } from './actions';
import { fmt, h } from './dom';
import { panelHeader } from './panelCommon';
import { post, state } from './state';

const MAX_ROWS = 500;

export function openDuplicates(column: number): void {
    state.panel = { kind: 'duplicates', column };
    state.duplicates = null;
    state.analysisLoading = true;
    state.analysisError = '';
    state.analysisJob++;
    post({ type: 'duplicates', jobId: state.analysisJob, columns: [column] });
    emit('panel');
}

export function renderDuplicates(root: HTMLElement, column: number): void {
    const name = state.info?.header[column] ?? `Column ${column + 1}`;
    root.append(panelHeader(`Duplicates: ${name}`));
    const body = h('div', { class: 'side-body' });
    root.append(body);
    if (state.analysisLoading) {
        const cancel = h('button', {}, 'Cancel');
        cancel.addEventListener('click', () => post({ type: 'cancel', kind: 'analysis', jobId: state.analysisJob }));
        body.append(h('div', { class: 'message' }, 'Looking for duplicates…'), cancel);
        return;
    }
    if (state.analysisError) {
        body.append(h('div', { class: 'message err' }, `Could not scan the column: ${state.analysisError}`));
        return;
    }
    const r = state.duplicates;
    if (!r || r.columns[0] !== column) {
        body.append(h('div', { class: 'message' }, 'The scan was cancelled. Choose "Find duplicates" again to retry.'));
        return;
    }
    if (r.groups.length === 0) {
        body.append(h('div', { class: 'message' }, r.capped ? 'No duplicates found among the first 3,000,000 distinct values.' : 'No duplicate values in this column.'));
        return;
    }
    let text = `${fmt(r.duplicateKeys)} duplicated values in ${fmt(r.duplicateRows)} rows`;
    if (r.truncated) {
        text += ` · showing the top ${fmt(r.groups.length)}`;
    }
    if (r.capped) {
        text += ' · key limit reached, counts may be incomplete';
    }
    body.append(h('div', { class: 'u-summary' }, text), h('div', { class: 'u-summary' }, 'Click a value to show only its rows.'));
    const list = h('div', { class: 'u-list' });
    for (const g of r.groups.slice(0, MAX_ROWS)) {
        const value = g.key[0] ?? '';
        const row = h('button', { class: 'dup-row', title: value },
            h('span', { class: 'u-val' }, value === '' ? '(empty)' : value.slice(0, 200)),
            h('span', { class: 'u-count' }, `×${fmt(g.count)} · first row ${fmt(g.firstRow + 1)}`));
        row.addEventListener('click', () => {
            state.columnFilters[column] = [value];
            applyFilters();
        });
        list.append(row);
    }
    body.append(list);
}
```
(Row numbers shown to users are 1-based; `firstRow` is 0-based, hence `+ 1`.)

- [ ] **Step 5: sidePanel.ts** — import both modules; in `render` add:
```ts
            case 'stats':
                renderStats(root, panel.column);
                break;
            case 'duplicates':
                renderDuplicates(root, panel.column);
                break;
```
and register `on<number>('openStats', openStats);` and `on<number>('openDuplicates', openDuplicates);`.

- [ ] **Step 6: main.ts** — add cases next to `'unique'`:
```ts
        case 'stats':
            if (m.jobId === state.analysisJob) {
                state.stats = m.result;
                state.analysisLoading = false;
                state.analysisError = m.error ?? '';
                emit('panel');
            }
            break;
        case 'duplicates':
            if (m.jobId === state.analysisJob) {
                state.duplicates = m.result;
                state.analysisLoading = false;
                state.analysisError = m.error ?? '';
                emit('panel');
            }
            break;
```

- [ ] **Step 7: table.ts**
  - In `headerMenu`, after the `Unique values` item add:
```ts
        { label: 'Column stats', run: () => emit('openStats', column) },
        { label: 'Find duplicates', run: () => emit('openDuplicates', column) },
```
  - In the header loop (`const th = h('th', ...)`) change the title to include the guessed type from the current page: add `import { detectColumnType } from '../csv/core/columnStats';` and
```ts
        const sample = state.rows.map((r) => r[c] ?? '');
        const type = sample.length > 0 ? detectColumnType(sample) : '';
        const th = h('th', { class: `colhead${pinned.has(c) ? ' pinned' : ''}`, title: type ? `${name} (${type})` : name });
```

- [ ] **Step 8: media/viewer.css** — append (use existing theme variables, same style as `.u-row`):
```css
.stats-grid { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; padding: 8px 0; }
.stats-k { color: var(--vscode-descriptionForeground); }
.stats-v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stats-sample { padding: 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); }
.dup-row { display: flex; justify-content: space-between; gap: 8px; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--vscode-panel-border); padding: 4px 2px; color: inherit; cursor: pointer; }
.dup-row:hover { background: var(--vscode-list-hoverBackground); }
```

- [ ] **Step 9: Run** `npm run typecheck`, `npm run build`, `npm run test:unit` — Expected: all clean/passing. (Webview UI cannot be unit-tested here; the manual F5 check is in Task 6.)

- [ ] **Step 10: Commit**
```bash
git add src/viewer media/viewer.css
git commit -m "Add column stats and duplicate finder panels with a header type hint"
```

---

### Task 5: Large-file prompt

**Files:**
- Create: `src/largeFilePrompt.ts`
- Modify: `src/extension.ts`, `package.json` (one setting), `src/test/unit/` (new test)
- Test: `src/test/unit/largeFilePrompt.test.ts`

**Interfaces:**
- Produces: `shouldPrompt(sizeBytes: number, thresholdMB: number, fileName: string): boolean` (pure) and `registerLargeFilePrompt(context: vscode.ExtensionContext): void`.
- Consumes: command id `get-unique-values.openCsvViewer` (takes an optional `vscode.Uri`); setting `getUniqueValues.csv.largeFileMB`.

Ruling: the spec says default 50 MB, but VS Code refuses to open text documents much above ~50 MB, so the event would almost never fire. Default the setting to **20**.

- [ ] **Step 1: Failing test** `src/test/unit/largeFilePrompt.test.ts`

```ts
import * as assert from 'assert';
import { shouldPrompt } from '../../largeFilePrompt';

suite('shouldPrompt', () => {
    const MB = 1024 * 1024;
    test('large csv prompts', () => assert.strictEqual(shouldPrompt(30 * MB, 20, 'a.csv'), true));
    test('tsv and psv prompt', () => {
        assert.strictEqual(shouldPrompt(30 * MB, 20, 'a.tsv'), true);
        assert.strictEqual(shouldPrompt(30 * MB, 20, 'A.PSV'), true);
    });
    test('small file does not prompt', () => assert.strictEqual(shouldPrompt(5 * MB, 20, 'a.csv'), false));
    test('exactly at the threshold does not prompt', () => assert.strictEqual(shouldPrompt(20 * MB, 20, 'a.csv'), false));
    test('other extensions never prompt', () => assert.strictEqual(shouldPrompt(90 * MB, 20, 'a.log'), false));
    test('threshold 0 disables the prompt', () => assert.strictEqual(shouldPrompt(90 * MB, 0, 'a.csv'), false));
});
```

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/largeFilePrompt.ts`

```ts
import * as vscode from 'vscode';

const MB = 1024 * 1024;
const EXTENSIONS = ['.csv', '.tsv', '.psv'];
const SUPPRESS_KEY = 'largeFilePrompt.suppressed';

export function shouldPrompt(sizeBytes: number, thresholdMB: number, fileName: string): boolean {
    if (thresholdMB <= 0) {
        return false;
    }
    const lower = fileName.toLowerCase();
    return EXTENSIONS.some((e) => lower.endsWith(e)) && sizeBytes > thresholdMB * MB;
}

export function registerLargeFilePrompt(context: vscode.ExtensionContext): void {
    const asked = new Set<string>();
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(async (doc) => {
            if (doc.uri.scheme !== 'file' || context.workspaceState.get<boolean>(SUPPRESS_KEY) === true) {
                return;
            }
            const key = doc.uri.toString();
            if (asked.has(key)) {
                return;
            }
            const thresholdMB = vscode.workspace.getConfiguration('getUniqueValues.csv').get<number>('largeFileMB', 20);
            let size: number;
            try {
                size = (await vscode.workspace.fs.stat(doc.uri)).size;
            } catch {
                return;
            }
            if (!shouldPrompt(size, thresholdMB, doc.uri.fsPath)) {
                return;
            }
            asked.add(key);
            const choice = await vscode.window.showInformationMessage(
                'This is a large file. Open it in the CSV Viewer for fast paging and search?',
                'Open in CSV Viewer',
                "Don't ask again",
            );
            if (choice === 'Open in CSV Viewer') {
                await vscode.commands.executeCommand('get-unique-values.openCsvViewer', doc.uri);
            } else if (choice === "Don't ask again") {
                await context.workspaceState.update(SUPPRESS_KEY, true);
            }
        }),
    );
}
```

- [ ] **Step 4: extension.ts** — import and call `registerLargeFilePrompt(context);` after `registerLineTools(context);`.

- [ ] **Step 5: package.json** — add under `contributes.configuration.properties`:
```json
        "getUniqueValues.csv.largeFileMB": {
          "type": "number",
          "default": 20,
          "minimum": 0,
          "markdownDescription": "Offer to open CSV/TSV/PSV files larger than this many MB in the CSV Viewer. Set 0 to turn the prompt off."
        },
```
(keep valid JSON: mind commas).

- [ ] **Step 6: Run** `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:integration` — Expected: all pass. (If `largeFilePrompt.ts` importing `vscode` breaks the mocha unit run, move `shouldPrompt` into `src/csv/core/largeFile.ts` (pure) and re-export it from `largeFilePrompt.ts`; point the test at the pure module.)

- [ ] **Step 7: Commit**
```bash
git add src/largeFilePrompt.ts src/extension.ts package.json src/test/unit/largeFilePrompt.test.ts
git commit -m "Offer to open large CSV files in the CSV Viewer"
```

---

### Task 6: Release 0.1.2

**Files:**
- Modify: `package.json` (version), `package-lock.json`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** `npm version 0.1.2 --no-git-tag-version`.
- [ ] **Step 2:** Add to the top of `CHANGELOG.md` under a new `## [0.1.2]` heading, `### Added`: column type detection (shown in the header tooltip), **Column stats** panel (empty %, distinct, min/max, lengths, samples), **Find duplicates** (click a value to filter to its rows), large-file prompt with the `getUniqueValues.csv.largeFileMB` setting.
- [ ] **Step 3:** README — add the three features to the CSV Viewer feature list (one line each).
- [ ] **Step 4:** Full verification: `npm run typecheck && npm run test:unit && npm run test:integration && npm run build` — all green. Then `npx @vscode/vsce package` and confirm a `get-unique-values-0.1.2.vsix` is produced.
- [ ] **Step 5: Commit**
```bash
git add package.json package-lock.json CHANGELOG.md README.md
git commit -m "Release 0.1.2: column stats, duplicate finder, large-file prompt"
```
- [ ] **Step 6 (controller, manual):** The webview panels need a human F5 pass on `/tmp/sample-products.csv`: header menu → Column stats, Find duplicates (click a value → table filters), Cancel button during a scan; open a >20 MB CSV in the text editor and confirm the prompt. Do not publish until this passes.
