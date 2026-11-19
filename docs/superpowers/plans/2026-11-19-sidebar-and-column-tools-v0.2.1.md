# Sidebar and Column Tools (v0.2.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Data Toolkit sidebar to VS Code's Activity Bar (tool launcher, recent files and favorites, current-file info with quick actions, saved parse presets and column sets), plus viewer features: move a column to first, freeze a column, and duplicate checks on whole rows, chosen key columns, and identical columns.

**Architecture:** The sidebar is four native `TreeView`s in one view container, all in the extension host. A new `summary` message lets the webview report the open file's state to its `CsvSession`; the tree reads the active session and sends it commands over the existing `command` channel. Column moves are pure functions in `layout.ts`. Duplicate checks extend the v0.1.2 `duplicateKeys` scan with a composite-key filter predicate and a new `duplicateColumns` scan.

**Tech Stack:** TypeScript, VS Code TreeView API, esbuild, mocha (tdd UI). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-csv-viewer-design.md` §4.3 (column view), §8 features 1 (presets), 14 (duplicate key finder), 21 (recent files).

**Prerequisites (must be built and merged first):**
- `2026-11-19-csv-data-checks-v0.1.2.md` (provides `CsvEngine.duplicateKeys`, `startAnalysis` in `CsvSession`, `statsPanel.ts`/`duplicatesPanel.ts`, `state.analysisJob`, the `'analysis'` cancel kind).
- `2026-11-19-excel-convert-v0.2.0.md` (provides the `get-unique-values.csv.export` command and the `.xlsx` viewer type `getUniqueValues.xlsxViewer`).

**Not in this release:** reopening a file at the last viewed row, freezing a *row* (the header row is already always visible), auto-applying presets by file glob, compare and merge.

## Global Constraints

- Webview CSP: nonce script only, no inline styles, no `innerHTML` (DOM via `h()` from `src/viewer/dom.ts`).
- `src/csv/core` and `src/csv/worker` must not import `vscode`; pure logic that the sidebar needs lives in `src/csv/core` or `src/sidebar/*Store.ts` files without a `vscode` import so mocha can test it.
- Every long scan takes a `CancelToken` and returns `null` when cancelled.
- Existing tests keep passing; `npm run typecheck` clean after every task.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

---

### Task 1: Move column to first and freeze column

**Files:**
- Modify: `src/csv/core/layout.ts` (append two pure functions), `src/viewer/layoutOps.ts`, `src/viewer/table.ts`
- Test: `src/test/unit/layout.test.ts` (append)

**Interfaces:**
- Produces (layout.ts):
```ts
/** Put `column` first in the column order. */
export function moveToFirst(l: Layout, column: number): void;
/** Move `column` to the front and keep it (and any columns already pinned) frozen while scrolling sideways. */
export function freezeColumn(l: Layout, column: number): void;
```
- Produces (layoutOps.ts): `export function moveColumnToFirst(column: number): void`, `export function freezeColumnOp(column: number): void` (both `mutate()` wrappers).

Semantics: `l.pinned` counts the first N *visible* columns. `freezeColumn`: if the column is already inside the pinned area, only move it to the front; otherwise move it to the front and increase `pinned` by one.

- [ ] **Step 1: Write the failing tests** (append inside the existing `suite` of `layout.test.ts`; reuse its imports and add `moveToFirst, freezeColumn` to them; build layouts with `defaultLayout(5, {pageSize: 100, longText: 'truncate', colorMode: 'off'})`)

```ts
    test('moveToFirst puts the column first and keeps the others in order', () => {
        const l = defaultLayout(5, { pageSize: 100, longText: 'truncate', colorMode: 'off' });
        moveToFirst(l, 3);
        assert.deepStrictEqual(l.order, [3, 0, 1, 2, 4]);
    });
    test('moveToFirst on the first column changes nothing', () => {
        const l = defaultLayout(3, { pageSize: 100, longText: 'truncate', colorMode: 'off' });
        moveToFirst(l, 0);
        assert.deepStrictEqual(l.order, [0, 1, 2]);
    });
    test('freezeColumn moves to front and pins one column', () => {
        const l = defaultLayout(5, { pageSize: 100, longText: 'truncate', colorMode: 'off' });
        freezeColumn(l, 2);
        assert.deepStrictEqual(l.order, [2, 0, 1, 3, 4]);
        assert.strictEqual(l.pinned, 1);
    });
    test('freezeColumn adds to existing pinned columns', () => {
        const l = defaultLayout(5, { pageSize: 100, longText: 'truncate', colorMode: 'off' });
        l.pinned = 2;
        freezeColumn(l, 4);
        assert.deepStrictEqual(l.order, [4, 0, 1, 2, 3]);
        assert.strictEqual(l.pinned, 3);
    });
    test('freezeColumn on an already pinned column only reorders', () => {
        const l = defaultLayout(5, { pageSize: 100, longText: 'truncate', colorMode: 'off' });
        l.pinned = 3;
        freezeColumn(l, 2);
        assert.deepStrictEqual(l.order, [2, 0, 1, 3, 4]);
        assert.strictEqual(l.pinned, 3);
    });
    test('freezeColumn counts only visible columns when deciding if a column is pinned', () => {
        const l = defaultLayout(5, { pageSize: 100, longText: 'truncate', colorMode: 'off' });
        l.hidden = [0];
        l.pinned = 1; // pinned area = visible column 1
        freezeColumn(l, 3);
        assert.deepStrictEqual(l.order, [3, 0, 1, 2, 4]);
        assert.strictEqual(l.pinned, 2);
    });
```

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL (functions missing).

- [ ] **Step 3: Implement** in `layout.ts`:

```ts
export function moveToFirst(l: Layout, column: number): void {
    const i = l.order.indexOf(column);
    if (i > 0) {
        l.order = moveItem(l.order, i, 0);
    }
}

export function freezeColumn(l: Layout, column: number): void {
    const visible = visibleColumns(l);
    const alreadyPinned = visible.indexOf(column) !== -1 && visible.indexOf(column) < l.pinned;
    moveToFirst(l, column);
    if (!alreadyPinned) {
        l.pinned = Math.min(l.pinned + 1, visibleColumns(l).length);
    }
}
```

- [ ] **Step 4: layoutOps.ts** — import both and add:
```ts
export function moveColumnToFirst(column: number): void {
    mutate((l) => moveToFirst(l, column));
}

export function freezeColumnOp(column: number): void {
    mutate((l) => freezeColumn(l, column));
}
```

- [ ] **Step 5: table.ts** — in `headerMenu`, after `{ label: 'Hide column', ... }` add
```ts
        { label: 'Move to first column', run: () => moveColumnToFirst(column) },
        { label: 'Freeze column (move to first and pin)', run: () => freezeColumnOp(column) },
```
(import from `./layoutOps`; keep the existing `Pin columns up to here` and `Unpin columns` items).

- [ ] **Step 6: Run** `npm run typecheck`, `npm run test:unit` — Expected: pass.

- [ ] **Step 7: Commit**
```bash
git add src/csv/core/layout.ts src/viewer/layoutOps.ts src/viewer/table.ts src/test/unit/layout.test.ts
git commit -m "Add Move to first column and Freeze column to the header menu"
```

---

### Task 2: Engine and predicate support for row and column duplicate checks

**Files:**
- Modify: `src/csv/core/predicates.ts`, `src/csv/core/engine.ts`, `src/csv/types.ts`
- Test: `src/test/unit/predicates.test.ts` (append), `src/test/unit/analysis.test.ts` (append; created by the v0.1.2 plan)

**Interfaces:**
- Produces (predicates.ts): `Predicate` gains `| { kind: 'keyEquals'; columns: number[]; values: string[] }` (a row passes when every listed column equals the matching value).
- Produces (types.ts):
```ts
export interface DuplicateColumnsResult {
    /** Groups of 2+ columns whose values are identical in every row (all-empty columns excluded). */
    groups: number[][];
    /** Columns that are empty in every row. */
    emptyColumns: number[];
    rows: number;
}
```
- Produces (engine.ts): `async duplicateColumns(token: CancelToken, onProgress?: (scanned: number, total: number) => void): Promise<DuplicateColumnsResult | null>`

- [ ] **Step 1: Write the failing tests.**

In `predicates.test.ts` (use its existing imports/helpers; if it has none, import `compilePredicates`):
```ts
    test('keyEquals matches every listed column', () => {
        const { test: t } = compilePredicates([{ kind: 'keyEquals', columns: [0, 2], values: ['a', 'c'] }]);
        assert.strictEqual(t(['a', 'x', 'c']), true);
        assert.strictEqual(t(['a', 'x', 'd']), false);
        assert.strictEqual(t(['b', 'x', 'c']), false);
    });
    test('keyEquals treats a missing cell as empty', () => {
        const { test: t } = compilePredicates([{ kind: 'keyEquals', columns: [1], values: [''] }]);
        assert.strictEqual(t(['a']), true);
    });
```
In `analysis.test.ts`, add inside the suite:
```ts
    const WIDE = 'a,b,c,d,e\n1,1,x,,y\n2,2,y,,x\n3,3,z, ,w\n';

    test('duplicateColumns: identical columns and empty columns', async () => {
        const engine = await load(WIDE);
        const r = await engine.duplicateColumns(live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups, [[0, 1]]);
        assert.deepStrictEqual(r.emptyColumns, [3]);
        assert.strictEqual(r.rows, 3);
    });

    test('duplicateColumns: nothing duplicated', async () => {
        const engine = await load(CSV);
        const r = await engine.duplicateColumns(live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups, []);
    });

    test('duplicateColumns: cancelled returns null', async () => {
        const engine = await load(WIDE);
        assert.strictEqual(await engine.duplicateColumns({ cancelled: true }), null);
    });

    test('duplicateKeys with every column finds whole-row duplicates', async () => {
        const engine = await load('a,b\n1,x\n2,y\n1,x\n');
        const r = await engine.duplicateKeys([0, 1], live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count, g.firstRow]), [[['1', 'x'], 2, 0]]);
    });
```
(`CSV` and `load` come from the v0.1.2 test file; its columns are `id,name,price`, all different.)

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL.

- [ ] **Step 3: Implement.** `predicates.ts`: add the union member and, in `compilePredicates` before the search handling:
```ts
        if (p.kind === 'keyEquals') {
            const { columns, values } = p;
            tests.push((f) => columns.every((c, i) => (f[c] ?? '') === values[i]));
            continue;
        }
```
`types.ts`: append `DuplicateColumnsResult`. `engine.ts`: `import { createHash } from 'crypto';`, extend the type import, and add (next to `duplicateKeys`):
```ts
    /** Columns whose values are identical in every row, and columns that are empty throughout. */
    async duplicateColumns(
        token: CancelToken,
        onProgress?: (scanned: number, total: number) => void,
    ): Promise<DuplicateColumnsResult | null> {
        await this.indexFinished;
        this.throwIfIndexFailed();
        const n = (await this.getInfo()).columnCount;
        const total = this.dataRowCount;
        const hashes = Array.from({ length: n }, () => createHash('sha1'));
        const nonEmpty = new Array<boolean>(n).fill(false);
        const outcome = await this.scan(
            [[0, total]],
            token,
            (_rowNum, fields) => {
                for (let c = 0; c < n; c++) {
                    const v = fields[c] ?? '';
                    hashes[c].update(v);
                    hashes[c].update('\u0000');
                    if (!nonEmpty[c] && v.trim() !== '') {
                        nonEmpty[c] = true;
                    }
                }
            },
            (scanned) => onProgress?.(scanned, total),
        );
        if (outcome === 'cancelled') {
            return null;
        }
        const byDigest = new Map<string, number[]>();
        const emptyColumns: number[] = [];
        for (let c = 0; c < n; c++) {
            if (!nonEmpty[c]) {
                emptyColumns.push(c);
                continue;
            }
            const digest = hashes[c].digest('hex');
            const group = byDigest.get(digest);
            if (group) {
                group.push(c);
            } else {
                byDigest.set(digest, [c]);
            }
        }
        return { groups: [...byDigest.values()].filter((g) => g.length > 1), emptyColumns, rows: total };
    }
```

- [ ] **Step 4: Run** `npm run test:unit`, `npm run typecheck` — Expected: pass.

- [ ] **Step 5: Commit**
```bash
git add src/csv src/test
git commit -m "Add duplicate-column scan and composite key filter predicate"
```

---

### Task 3: Duplicates panel for rows (chosen key columns or whole row) and columns

**Files:**
- Modify: `src/csv/protocol.ts`, `src/csv/worker/csvWorker.ts`, `src/csv/CsvSession.ts`, `src/viewer/state.ts`, `src/viewer/actions.ts`, `src/viewer/searchBar.ts`, `src/viewer/duplicatesPanel.ts`, `src/viewer/sidePanel.ts`, `src/viewer/main.ts`, `src/viewer/table.ts`, `media/viewer.css`

**Interfaces:**
- Consumes: `duplicateColumns`, `keyEquals`, `DuplicateColumnsResult` (Task 2); `duplicateKeys`/`startAnalysis` (v0.1.2); `hideColumn`/`mutate` (`layoutOps.ts`).
- Produces:
  - `WorkerRequest` gains `| { id: number; type: 'duplicateColumns' }`; `ViewToHost` gains `| { type: 'duplicateColumns'; jobId: number }`; `HostToView` gains `| { type: 'duplicateColumns'; jobId: number; result: DuplicateColumnsResult | null; error?: string }`.
  - `Panel` member `{ kind: 'duplicates'; column: number }` (v0.1.2) becomes `{ kind: 'duplicates' }`.
  - state: `dup: { mode: 'rows' | 'columns'; selected: number[] }`, `duplicateColumns: DuplicateColumnsResult | null`, `keyFilter: { columns: number[]; values: string[] } | null`.
  - bus event `openDuplicates` now takes `{ mode: 'rows' | 'columns'; columns?: number[] }` (`columns` empty or missing in rows mode = preselect nothing; the user can press "All columns").

- [ ] **Step 1: Protocol, worker, session.** Add the three message members above. Worker: add a case mirroring `'stats'`:
```ts
            case 'duplicateColumns': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().duplicateColumns(token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
```
Session `handleMessage`: `case 'duplicateColumns': this.startAnalysis(m.jobId, { type: 'duplicateColumns' }, (result, error) => this.post({ type: 'duplicateColumns', jobId: m.jobId, result: result as DuplicateColumnsResult | null, error })); break;` and widen `startAnalysis`'s `body` union with `{ type: 'duplicateColumns' }`.

- [ ] **Step 2: state.ts.** Change the Panel member; add to `state` (next to `duplicates`):
```ts
    dup: { mode: 'rows' as 'rows' | 'columns', selected: [] as number[] },
    duplicateColumns: null as DuplicateColumnsResult | null,
    keyFilter: null as { columns: number[]; values: string[] } | null,
```
In `buildPredicates()` append before `return`:
```ts
    if (state.keyFilter) {
        predicates.push({ kind: 'keyEquals', columns: state.keyFilter.columns, values: state.keyFilter.values });
    }
```
In `resetForNewFile()` add `state.keyFilter = null; state.duplicateColumns = null; state.dup = { mode: 'rows', selected: [] };`. In `actions.ts` `clearAllFilters()` (line ~79) add `state.keyFilter = null;`. In `searchBar.ts` where the chips render (near line 88-94) add a chip for an active key filter: text `Duplicate key: <values joined by " · ">`, click → `state.keyFilter = null; applyFilters();`.

- [ ] **Step 3: Rewrite `src/viewer/duplicatesPanel.ts`.** Exports `openDuplicates(arg: { mode: 'rows' | 'columns'; columns?: number[] }): void` and `renderDuplicates(root: HTMLElement): void`.
  - `openDuplicates`: set `state.panel = { kind: 'duplicates' }`, `state.dup.mode = arg.mode`, `state.dup.selected = arg.columns ?? []`, clear `state.duplicates`/`state.duplicateColumns`/error; if `mode === 'columns'` immediately start the scan: `state.analysisLoading = true; state.analysisJob++; post({ type: 'duplicateColumns', jobId: state.analysisJob })`; in rows mode do not scan until the user presses Find (when `selected.length > 0` and the panel was opened from the header menu, start the scan at once with `post({ type: 'duplicates', jobId, columns: state.dup.selected })`). `emit('panel')`.
  - `renderDuplicates` draws, in order: the panel header "Duplicates"; two mode buttons (`Rows` / `Columns`, the active one has class `active`; switching calls `openDuplicates({ mode, columns: state.dup.selected })`); then the mode body.
  - **Rows body:** a short hint ("Rows are duplicates when the chosen columns have the same values."), a filter input that narrows the column checklist by name, a scrollable checklist of all columns (`info.header`, checkbox per column, `state.dup.selected` updated on change), buttons `All columns` (selects every column = whole-row check), `None`, and `Find duplicates` (disabled when nothing is selected). While `state.analysisLoading` show the scanning message with a Cancel button (`post({ type: 'cancel', kind: 'analysis', jobId: state.analysisJob })`). When `state.duplicates` exists and `state.duplicates.columns` equals `state.dup.selected` (same order), show the summary line (`N duplicated keys in M rows`, plus the truncated and capped notes from v0.1.2) and the list: each entry is a `button.dup-row` showing the key values joined by ` · ` (empty shown as `(empty)`) and `×count · first row N`; clicking sets `state.keyFilter = { columns: result.columns, values: group.key }`, clears `state.columnFilters`, and calls `applyFilters()`. A group count of zero shows "No duplicate rows for these columns."
  - **Columns body:** while loading show the scanning message with Cancel. With a result: if `groups` is empty and `emptyColumns` is empty show "No duplicate or empty columns."; for each group a block "Identical columns: A, B, C" (header names) with a button `Hide extra copies` that hides every column of the group except the first (`hideColumn(c)` from `layoutOps.ts` for each); for `emptyColumns` a block "Empty columns: …" with a button `Hide empty columns` (hides them all). The `hideColumn` calls each save the layout; that is acceptable.
  - Header-name display helper: `const name = (c: number): string => state.info?.header[c] ?? \`Column ${c + 1}\`;`.

- [ ] **Step 4: sidePanel.ts / main.ts / table.ts / css.**
  - `sidePanel.ts`: the `'duplicates'` case becomes `renderDuplicates(root)`; the bus registration becomes `on<{ mode: 'rows' | 'columns'; columns?: number[] }>('openDuplicates', openDuplicates);`.
  - `main.ts`: update the `'duplicates'` case to also handle `analysis` ownership (unchanged) and add:
```ts
        case 'duplicateColumns':
            if (m.jobId === state.analysisJob) {
                state.duplicateColumns = m.result;
                state.analysisLoading = false;
                state.analysisError = m.error ?? '';
                emit('panel');
            }
            break;
```
  - `table.ts`: header menu item `Find duplicates` now emits `emit('openDuplicates', { mode: 'rows', columns: [column] })`; add `{ label: 'Find duplicate columns', run: () => emit('openDuplicates', { mode: 'columns' }) }`.
  - `media/viewer.css`: add `.dup-modes { display: flex; gap: 4px; padding: 6px 0; }`, `.dup-modes button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }`, `.col-check { max-height: 220px; overflow: auto; border: 1px solid var(--vscode-panel-border); padding: 4px; }`, `.col-check label { display: flex; gap: 6px; padding: 1px 0; }`.

- [ ] **Step 5: Run** `npm run typecheck`, `npm run build`, `npm run test:unit` — Expected: pass. (The webview UI is verified manually in Task 6.)

- [ ] **Step 6: Commit**
```bash
git add -A
git commit -m "Duplicate checks: chosen key columns, whole rows and identical columns"
```

---

### Task 4: Sidebar foundation, tool launcher, recent files and favorites

**Files:**
- Create: `media/sidebar.svg`, `src/sidebar/recentStore.ts`, `src/sidebar/trees.ts` (tools and recent providers), `src/sidebar/index.ts`
- Modify: `package.json`, `src/extension.ts`, `src/csv/CsvEditorProvider.ts`
- Test: `src/test/unit/recentStore.test.ts`, `src/test/integration/extension.test.ts` (append)

**Interfaces:**
- Produces (recentStore.ts, no `vscode` import):
```ts
export interface RecentState { recent: Array<{ uri: string; at: number }>; favorites: string[] }
export const MAX_RECENT = 20;
export function emptyRecent(): RecentState;
export function sanitizeRecent(raw: unknown): RecentState;
export function touch(s: RecentState, uri: string, at: number): RecentState;        // moves/adds to the front, caps at MAX_RECENT
export function toggleFavorite(s: RecentState, uri: string): RecentState;
export function removeRecent(s: RecentState, uri: string): RecentState;              // also unfavorites
export function clearRecent(s: RecentState): RecentState;                            // keeps favorites
```
- Produces (index.ts): `registerSidebar(context: vscode.ExtensionContext, api: CsvViewerApi): { recordOpen(uri: vscode.Uri): void }`.
- `CsvViewerApi` (CsvEditorProvider.ts) gains `getActive(): CsvSession | undefined` and `onDidChangeActive: vscode.Event<void>`; `registerCsvViewer(context, onOpen?: (uri: vscode.Uri) => void)` calls `onOpen` from `resolveCustomEditor`. `activate()` therefore becomes: create the viewer API first with a late-bound callback, then `registerSidebar`.

- [ ] **Step 1: Write the failing test** `src/test/unit/recentStore.test.ts`

```ts
import * as assert from 'assert';
import {
    MAX_RECENT, clearRecent, emptyRecent, removeRecent, sanitizeRecent, toggleFavorite, touch,
} from '../../sidebar/recentStore';

suite('recentStore', () => {
    test('touch adds to the front and de-duplicates', () => {
        let s = emptyRecent();
        s = touch(s, 'file:///a.csv', 1);
        s = touch(s, 'file:///b.csv', 2);
        s = touch(s, 'file:///a.csv', 3);
        assert.deepStrictEqual(s.recent.map((r) => r.uri), ['file:///a.csv', 'file:///b.csv']);
        assert.strictEqual(s.recent[0].at, 3);
    });
    test('touch caps the list', () => {
        let s = emptyRecent();
        for (let i = 0; i < MAX_RECENT + 5; i++) {
            s = touch(s, `file:///${i}.csv`, i);
        }
        assert.strictEqual(s.recent.length, MAX_RECENT);
        assert.strictEqual(s.recent[0].uri, `file:///${MAX_RECENT + 4}.csv`);
    });
    test('toggleFavorite adds then removes', () => {
        let s = toggleFavorite(emptyRecent(), 'file:///a.csv');
        assert.deepStrictEqual(s.favorites, ['file:///a.csv']);
        s = toggleFavorite(s, 'file:///a.csv');
        assert.deepStrictEqual(s.favorites, []);
    });
    test('removeRecent also unfavorites', () => {
        let s = touch(emptyRecent(), 'file:///a.csv', 1);
        s = toggleFavorite(s, 'file:///a.csv');
        s = removeRecent(s, 'file:///a.csv');
        assert.deepStrictEqual(s, emptyRecent());
    });
    test('clearRecent keeps favorites', () => {
        let s = touch(emptyRecent(), 'file:///a.csv', 1);
        s = toggleFavorite(s, 'file:///a.csv');
        s = clearRecent(s);
        assert.deepStrictEqual(s.recent, []);
        assert.deepStrictEqual(s.favorites, ['file:///a.csv']);
    });
    test('sanitizeRecent survives garbage', () => {
        assert.deepStrictEqual(sanitizeRecent(null), emptyRecent());
        assert.deepStrictEqual(sanitizeRecent({ recent: [{ uri: 5 }, { uri: 'x', at: 1 }], favorites: [1, 'y'] }), {
            recent: [{ uri: 'x', at: 1 }],
            favorites: ['y'],
        });
    });
});
```

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL.

- [ ] **Step 3: Implement** `src/sidebar/recentStore.ts`

```ts
export interface RecentState {
    recent: Array<{ uri: string; at: number }>;
    favorites: string[];
}

export const MAX_RECENT = 20;

export function emptyRecent(): RecentState {
    return { recent: [], favorites: [] };
}

export function sanitizeRecent(raw: unknown): RecentState {
    if (typeof raw !== 'object' || raw === null) {
        return emptyRecent();
    }
    const o = raw as { recent?: unknown; favorites?: unknown };
    const recent = Array.isArray(o.recent)
        ? o.recent.filter((r): r is { uri: string; at: number } =>
            typeof r === 'object' && r !== null && typeof (r as { uri?: unknown }).uri === 'string' && typeof (r as { at?: unknown }).at === 'number')
            .map((r) => ({ uri: r.uri, at: r.at }))
        : [];
    const favorites = Array.isArray(o.favorites) ? o.favorites.filter((f): f is string => typeof f === 'string') : [];
    return { recent: recent.slice(0, MAX_RECENT), favorites: [...new Set(favorites)] };
}

export function touch(s: RecentState, uri: string, at: number): RecentState {
    const rest = s.recent.filter((r) => r.uri !== uri);
    return { ...s, recent: [{ uri, at }, ...rest].slice(0, MAX_RECENT) };
}

export function toggleFavorite(s: RecentState, uri: string): RecentState {
    return s.favorites.includes(uri)
        ? { ...s, favorites: s.favorites.filter((f) => f !== uri) }
        : { ...s, favorites: [...s.favorites, uri] };
}

export function removeRecent(s: RecentState, uri: string): RecentState {
    return { recent: s.recent.filter((r) => r.uri !== uri), favorites: s.favorites.filter((f) => f !== uri) };
}

export function clearRecent(s: RecentState): RecentState {
    return { ...s, recent: [] };
}
```

- [ ] **Step 4: Run** `npm run test:unit` — Expected: pass.

- [ ] **Step 5: `media/sidebar.svg`** (24×24, monochrome so VS Code can tint it):
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="4" width="18" height="16" rx="2"/>
  <path d="M3 9h18M9 4v16M15 4v16"/>
</svg>
```
Add `media/sidebar.svg` is already packaged (`media/` is not in `.vscodeignore`; verify).

- [ ] **Step 6: package.json contributions.**
```json
    "viewsContainers": {
      "activitybar": [
        { "id": "dataToolkit", "title": "Data Toolkit", "icon": "media/sidebar.svg" }
      ]
    },
    "views": {
      "dataToolkit": [
        { "id": "dataToolkit.file", "name": "Current File" },
        { "id": "dataToolkit.tools", "name": "Tools" },
        { "id": "dataToolkit.recent", "name": "Recent & Favorites" },
        { "id": "dataToolkit.presets", "name": "Parse Presets" }
      ]
    },
    "viewsWelcome": [
      {
        "view": "dataToolkit.file",
        "contents": "No CSV or Excel file is open in the viewer.\n[Open a file](command:get-unique-values.sidebar.openFile)"
      }
    ],
```
Commands to add (titles; all hidden from the Command Palette via `menus.commandPalette` `"when": "false"` except `openFile`): `get-unique-values.sidebar.openFile` ("Data Toolkit: Open CSV or Excel File…"), `sidebar.openRecent` (arg uri), `sidebar.toggleFavorite`, `sidebar.removeRecent`, `sidebar.clearRecent`, `sidebar.refresh`. Inline item buttons via `menus."view/item/context"` with `"when": "view == dataToolkit.recent && viewItem == recentFile"`, `"group": "inline"` for toggleFavorite (icon `$(star-empty)`) and removeRecent (icon `$(close)`); and `"view/title"` for clearRecent on `view == dataToolkit.recent` (icon `$(clear-all)`).

- [ ] **Step 7: `src/sidebar/trees.ts`.** Two `vscode.TreeDataProvider<Node>` classes, each with `onDidChangeTreeData` event and `refresh()`:
  - **ToolsProvider** (static): items (label, icon via `new vscode.ThemeIcon(...)`, `command`):
    - "Open CSV or Excel file…" (`folder-opened`) → `get-unique-values.sidebar.openFile`
    - "Remove duplicate lines (text file)" (`trash`) → `get-unique-values.run`
    - "Export current view…" (`export`) → `get-unique-values.csv.export`
    - "Choose Excel sheet…" (`table`) → `get-unique-values.csv.chooseSheet`
    - Each has a tooltip describing it. Commands that need an open viewer already show an information message when none is active; make `csv.export` and `csv.chooseSheet` do the same (`vscode.window.showInformationMessage('Open a CSV or Excel file in the viewer first.')` when `activeSession` is undefined — update `CsvEditorProvider.ts`).
  - **RecentProvider** (reads a `() => RecentState`): two collapsible groups "Favorites" and "Recent" (omit an empty group; when both are empty return a single non-clickable "Nothing yet — open a file" item). File items: label = base name, description = parent folder, tooltip = full path, `contextValue = 'recentFile'`, `resourceUri` set (gives the file icon), `command = { command: 'get-unique-values.sidebar.openRecent', arguments: [uri] }`, and a star icon prefix handled through the inline button (no icon logic needed beyond the file icon).

- [ ] **Step 8: `src/sidebar/index.ts`.** Holds the `RecentState` in `context.globalState` under key `dataToolkit.recent` (`sanitizeRecent(globalState.get(...))` at start; every change calls `globalState.update` then `provider.refresh()`). Registers the two tree views with `vscode.window.createTreeView('dataToolkit.tools', { treeDataProvider })` and `…recent`, plus the commands:
  - `sidebar.openFile`: `showOpenDialog({ canSelectMany: false, filters: { 'CSV / Excel': ['csv','tsv','psv','xlsx','xlsm'] } })` then `executeCommand('get-unique-values.openCsvViewer', uri)`.
  - `sidebar.openRecent(uri)`: if the file no longer exists (`vscode.workspace.fs.stat` throws) show a warning with a "Remove from list" action; else `get-unique-values.openCsvViewer`.
  - `sidebar.toggleFavorite(node)`, `sidebar.removeRecent(node)`, `sidebar.clearRecent`, `sidebar.refresh`.
  - `recordOpen(uri)` → `touch(...)` + persist + refresh. Return it from `registerSidebar`.
  - Ignore any Excel cache path: only record URIs with scheme `file` whose path is not under `context.globalStorageUri.fsPath`.

- [ ] **Step 9: Wiring.** `CsvEditorProvider.ts`: extend `CsvViewerApi` and `registerCsvViewer` per the Interfaces block (an `EventEmitter<void>` fired whenever `activeSession` changes; `getActive` returns `activeSession`). `extension.ts`:
```ts
export function activate(context: vscode.ExtensionContext): CsvViewerApi {
    registerLineTools(context);
    let onOpen: (uri: vscode.Uri) => void = () => undefined;
    const api = registerCsvViewer(context, (uri) => onOpen(uri));
    onOpen = registerSidebar(context, api).recordOpen;
    return api;
}
```

- [ ] **Step 10: Integration test** — append to `src/test/integration/extension.test.ts` (use its existing activation helper):
```ts
    test('sidebar commands are registered', async () => {
        const all = await vscode.commands.getCommands(true);
        for (const id of ['get-unique-values.sidebar.openFile', 'get-unique-values.sidebar.clearRecent']) {
            assert.ok(all.includes(id), `${id} should be registered`);
        }
    });
```

- [ ] **Step 11: Run** `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:integration` — Expected: pass.

- [ ] **Step 12: Commit**
```bash
git add -A
git commit -m "Add the Data Toolkit sidebar: tool launcher, recent files and favorites"
```

---

### Task 5: Current File view, quick actions, column sets and parse presets

**Files:**
- Create: `src/csv/core/presets.ts`, `src/viewer/summary.ts`
- Modify: `src/csv/types.ts`, `src/csv/protocol.ts`, `src/csv/CsvSession.ts`, `src/csv/CsvEditorProvider.ts`, `src/sidebar/trees.ts`, `src/sidebar/index.ts`, `src/viewer/main.ts`, `src/viewer/layoutOps.ts`, `package.json`
- Test: `src/test/unit/presets.test.ts`

**Interfaces:**
- Produces (types.ts):
```ts
export interface FileSummary {
    fileName: string;
    rows: number;
    indexing: boolean;
    columns: number;
    header: string[];
    delimiter: string;
    hasHeader: boolean;
    encoding: string;
    badRows: number;
    hiddenColumns: number;
    filterActive: boolean;
    matches: number;
    sets: string[];
}
```
- Produces (protocol.ts): `ViewToHost` gains `| { type: 'summary'; summary: FileSummary }`; `ViewCommand` becomes `'hideSelectedColumn' | 'showAllColumns' | 'export' | 'toggleBadRows' | 'clearFilters' | 'hideEmptyColumns' | 'applySet' | 'saveSet' | 'deleteSet' | 'duplicateRows' | 'duplicateColumns' | 'moveToFirst' | 'freezeColumn'`; the `HostToView` command message gains `arg?: string` (`{ type: 'command'; name: ViewCommand; arg?: string }`).
- Produces (CsvSession): `summary: FileSummary | undefined`, `onDidChangeSummary: vscode.Event<void>`, `sendCommand(name: ViewCommand, arg?: string)`, `get parseSettings(): ParseOptions`, `applyParseOptions(options: ParseOptions): Promise<void>` (stores to workspaceState like `chooseParseOptions` does and reopens).
- Produces (presets.ts, no `vscode` import):
```ts
export interface Preset { name: string; delimiter?: string; hasHeader?: boolean; encoding?: 'utf-8' | 'latin1' }
export function sanitizePresets(raw: unknown): Preset[];
export function upsertPreset(list: Preset[], preset: Preset): Preset[];   // same name (case-insensitive) is replaced
export function removePreset(list: Preset[], name: string): Preset[];
export function describePreset(p: Preset): string;                          // e.g. "; · header · utf-8"
```

- [ ] **Step 1: Write the failing test** `src/test/unit/presets.test.ts`

```ts
import * as assert from 'assert';
import { describePreset, removePreset, sanitizePresets, upsertPreset } from '../../csv/core/presets';

suite('presets', () => {
    test('sanitize keeps valid presets and drops junk', () => {
        const out = sanitizePresets([
            { name: 'EU', delimiter: ';', hasHeader: true, encoding: 'latin1' },
            { name: '', delimiter: ',' },
            { delimiter: ',' },
            { name: 'Bad', delimiter: ';;', encoding: 'ebcdic' },
            'x',
        ]);
        assert.deepStrictEqual(out, [
            { name: 'EU', delimiter: ';', hasHeader: true, encoding: 'latin1' },
            { name: 'Bad' },
        ]);
    });
    test('sanitize of a non-array is empty', () => assert.deepStrictEqual(sanitizePresets(undefined), []));
    test('upsert replaces by name ignoring case', () => {
        const list = upsertPreset([{ name: 'EU', delimiter: ';' }], { name: 'eu', delimiter: '|' });
        assert.deepStrictEqual(list, [{ name: 'eu', delimiter: '|' }]);
    });
    test('upsert appends a new name', () => {
        assert.strictEqual(upsertPreset([{ name: 'A' }], { name: 'B' }).length, 2);
    });
    test('remove by name', () => {
        assert.deepStrictEqual(removePreset([{ name: 'A' }, { name: 'B' }], 'a'), [{ name: 'B' }]);
    });
    test('describe', () => {
        assert.strictEqual(describePreset({ name: 'x', delimiter: ';', hasHeader: false, encoding: 'utf-8' }), '; · no header · utf-8');
        assert.strictEqual(describePreset({ name: 'x' }), 'auto-detect');
    });
});
```
Rules the implementation must follow: a delimiter is valid only if it is exactly one character (tab allowed); encoding only `'utf-8'` or `'latin1'`; `hasHeader` only a boolean; invalid fields are dropped, the preset is kept if it has a non-empty trimmed `name`; `describePreset` joins the present parts with ` · ` (`delimiter` shown as `Tab` for `\t`, header as `header`/`no header`, encoding as is) and returns `auto-detect` when none is set.

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL. Then implement `src/csv/core/presets.ts` per the rules; Run — Expected: pass.

- [ ] **Step 3: Summary pipeline.**
  - `types.ts`: add `FileSummary`. `protocol.ts`: the additions above.
  - `src/viewer/summary.ts`:
```ts
import type { FileSummary } from '../csv/types';
import { on } from './actions';
import { debounce } from './dom';
import { post, state } from './state';

export function buildSummary(): FileSummary | null {
    const { info, layout } = state;
    if (!info || !layout) {
        return null;
    }
    return {
        fileName: state.fileName,
        rows: state.totalRows,
        indexing: state.indexing !== null && !state.indexing.done,
        columns: info.columnCount,
        header: info.header,
        delimiter: info.delimiter,
        hasHeader: info.hasHeader,
        encoding: info.encoding,
        badRows: state.indexing?.badRows ?? 0,
        hiddenColumns: layout.hidden.length,
        filterActive: state.filterActive,
        matches: state.total,
        sets: Object.keys(layout.sets),
    };
}

export function mountSummary(): void {
    const send = debounce(() => {
        const summary = buildSummary();
        if (summary) {
            post({ type: 'summary', summary });
        }
    }, 200);
    for (const event of ['status', 'render', 'panel']) {
        on(event, send);
    }
}
```
  Call `mountSummary()` from `main.ts` next to the other `mount*` calls. The implementer must confirm (by reading `main.ts`/`actions.ts`) that `emit('status')` or `emit('render')` fires after: file opened, index progress, filter start/finish, layout mutation; add `emit('status')` where one is missing.
  - `CsvSession.ts`: field `summary`, an `EventEmitter<void>` (`onDidChangeSummary`), `case 'summary': this.summary = m.summary; this.summaryEmitter.fire(); break;`; clear the summary and fire on `dispose()`. `sendCommand(name, arg?)` posts `{ type: 'command', name, arg }`. Add `get parseSettings()` and `applyParseOptions()`.
  - `CsvEditorProvider.ts`: forward each session's summary events: `CsvViewerApi` gains `onDidChangeSummary: vscode.Event<void>` (fires when the active session's summary changes or the active session changes).

- [ ] **Step 4: Webview command handling.** In `main.ts`'s `'command'` case replace the if/else with a `switch (m.name)`:
  - `hideSelectedColumn` / `showAllColumns` / `export`: as today (`export` → `requestExport()`).
  - `toggleBadRows`: `state.badRowsOnly = !state.badRowsOnly; applyFilters();`
  - `clearFilters`: `clearAllFilters();`
  - `hideEmptyColumns`: `requestHideEmpty();`
  - `applySet` / `deleteSet`: `applySet(m.arg ?? '')` / `deleteSet(m.arg ?? '')`.
  - `saveSet`: `saveSet(m.arg ?? '')`.
  - `duplicateRows`: `emit('openDuplicates', { mode: 'rows', columns: [] })`; `duplicateColumns`: `emit('openDuplicates', { mode: 'columns' })`.
  - `moveToFirst` / `freezeColumn`: `moveColumnToFirst(Number(m.arg))` / `freezeColumnOp(Number(m.arg))`, ignoring a non-integer arg.

- [ ] **Step 5: Sidebar "Current File" and "Parse Presets" views** (`trees.ts`, `index.ts`, `package.json`).
  - **FileProvider** reads `api.getActive()?.summary`; refreshes on `api.onDidChangeSummary`. With no summary it returns `[]` (the view's welcome text shows). Otherwise top-level groups:
    1. **Info** (non-clickable items): `<fileName>`; `<rows> rows · <columns> columns` (add `· indexing…` while indexing); `Delimiter <name> · <header|no header> · <encoding>`; `<badRows> rows with the wrong column count` (only when > 0); `<hiddenColumns> hidden columns` (only when > 0); `Filter active: <matches> matching rows` (only when `filterActive`).
    2. **Quick actions** (clickable, each executes a viewer command through `getActive()?.sendCommand`): "Show only bad rows" (visible when `badRows > 0`), "Clear all filters" (visible when `filterActive`), "Show all columns" (when `hiddenColumns > 0`), "Hide empty columns", "Find duplicate rows…", "Find duplicate columns", "Move a column to first…", "Freeze a column…", "Export current view…". The last two column actions open `showQuickPick` over `summary.header` (label = name, with the column number in `description`), then send `moveToFirst`/`freezeColumn` with the chosen index as `arg`.
    3. **Column sets**: one item per name in `summary.sets` (click → `applySet`, inline delete button for `contextValue = 'columnSet'`), and a final "Save current columns as a set…" item (`showInputBox` → `saveSet`).
    Register internal commands for these (`get-unique-values.sidebar.fileAction` taking `{ name: ViewCommand; arg?: string }`, `sidebar.pickColumn` taking `'moveToFirst' | 'freezeColumn'`, `sidebar.applySet`, `sidebar.deleteSet`, `sidebar.saveSet`) and hide them from the Command Palette.
  - **PresetsProvider**: lists presets from `vscode.workspace.getConfiguration('getUniqueValues.csv').get('presets')` through `sanitizePresets` (label = name, description = `describePreset`; click → apply to the active session via `applyParseOptions({ delimiter, hasHeader, encoding })`, or an information message when no viewer is open; inline delete button, `contextValue = 'preset'`), plus an item "Save current parse settings as a preset…" (`showInputBox` for the name; `upsertPreset` with `session.parseSettings` merged with the delimiter/header/encoding currently shown in the summary; write back with `config.update('presets', list, vscode.ConfigurationTarget.Global)`). Refresh on `vscode.workspace.onDidChangeConfiguration` for `getUniqueValues.csv.presets`.
  - `package.json`: add the setting `"getUniqueValues.csv.presets": { "type": "array", "default": [], "items": { "type": "object", "properties": { "name": {"type": "string"}, "delimiter": {"type": "string"}, "hasHeader": {"type": "boolean"}, "encoding": {"type": "string", "enum": ["utf-8", "latin1"]} }, "required": ["name"] }, "markdownDescription": "Saved parse settings (delimiter, header, encoding). Manage them from the Data Toolkit sidebar." }`; the new commands; the inline `view/item/context` buttons for `columnSet` and `preset`; extend `menus.commandPalette` hidden list.

- [ ] **Step 6: Run** `npm run typecheck`, `npm run build`, `npm run test:unit`, `npm run test:integration` — Expected: pass.

- [ ] **Step 7: Commit**
```bash
git add -A
git commit -m "Sidebar: current-file info, quick actions, column sets and parse presets"
```

---

### Task 6: Release 0.2.1

**Files:** `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** `npm version 0.2.1 --no-git-tag-version`.
- [ ] **Step 2:** `CHANGELOG.md` `## [0.2.1]` / `### Added`: Data Toolkit sidebar in the Activity Bar (Tools, Current File with quick actions, Recent & Favorites, Parse Presets, column sets); **Move to first column** and **Freeze column** in the header menu; duplicate checks on chosen key columns, whole rows, and identical or empty columns (with "Hide extra copies"); setting `getUniqueValues.csv.presets`.
- [ ] **Step 3:** README: a "Sidebar" section (what each of the four views does) and the new viewer features.
- [ ] **Step 4:** Verify: `npm run typecheck && npm run test:unit && npm run test:integration && npm run build`; `npx @vscode/vsce package` produces `get-unique-values-0.2.1.vsix`; confirm `media/sidebar.svg` is inside it (`npx @vscode/vsce ls | grep sidebar`).
- [ ] **Step 5: Commit**
```bash
git add package.json package-lock.json CHANGELOG.md README.md
git commit -m "Release 0.2.1: sidebar, column move/freeze, duplicate row and column checks"
```
- [ ] **Step 6 (controller, manual):** F5 pass: the Data Toolkit icon appears in the Activity Bar; with no file open "Current File" shows the Open button; open `/tmp/sample-products.csv` and check info, bad rows, clear filters, hide empty columns, move/freeze column (header menu and sidebar), duplicate rows with one column, with all columns, duplicate columns (use a file with a repeated column), save/apply a column set, save/apply/delete a preset, favorite a recent file and reopen it. Do not publish until this passes.
