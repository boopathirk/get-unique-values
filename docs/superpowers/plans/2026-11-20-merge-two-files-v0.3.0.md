# Merge Two CSV Files (v0.3.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge two CSV/TSV/PSV files on a common column. For each column of the second file the user chooses: add it as a new column, fill empty cells of an existing column, update an existing column, or ignore it. A preview (counts plus sample changed rows) is shown first; only after the user confirms is the merged result written to a new file. The two source files are never modified.

**Architecture:** A pure merge core (`src/csv/merge/mergeCore.ts`: settings, key normalisation, column plan, per-row merge, stats) is driven by a streaming `runMerge` (`src/csv/merge/merge.ts`) that reads both files through `CsvEngine.exportRows('all')`, indexes the second file by key in memory, streams the first file row by row, and either collects a preview or writes a CSV. Two new worker requests (`inspect`, `merge`) run it in a dedicated worker owned by a new `MergePanel` webview (own bundle) with the form, the preview and a confirm step.

**Tech Stack:** TypeScript, esbuild (a 4th bundle), mocha (tdd UI), VS Code webview API. No new dependencies.

**Spec:** the user's request: "two csv merge feature like common column value based on new column or existing column empty or update or ignore based on feature need, preview show once confirm then merge". Design rulings are listed under Global Constraints.

**Prerequisite:** the final fix wave after the v0.2.1 whole-branch review must be landed first (export no longer overwrites its source, `.part` + rename writes, pending worker requests rejected on dispose, `sanitizeSheetName`). This plan reuses those patterns and the same-path guard: if a same-path helper (case-insensitive on win32/darwin) already exists from that wave, reuse it; otherwise create `src/csv/core/samePath.ts` exporting `samePath(a: string, b: string): boolean` (path.resolve both; lower-case when `process.platform` is `win32` or `darwin`).

**Not in this release:** Excel (`.xlsx`) inputs to merge (CSV/TSV/PSV only; convert via Export first), output formats other than CSV (open the merged file in the viewer and use Export…), compare two files (next release), fuzzy matching, many-to-many joins.

## Global Constraints

- Rulings on merge semantics (binding):
  - File **A** is the base: every row of A appears in the output, in order, with its original columns first. File **B** supplies data.
  - Rows match when the normalised key values are equal. A key whose cells are all blank never matches. Normalisation options: `trim` (default on) and `caseInsensitive` (default off).
  - Per B column (never a key column) the action is one of: `new` (add a column to the output), `fillEmpty` (set an A column's cell only when it is blank and B's value is not blank), `update` (replace an A column's cell when B's value is not blank and differs; with `overwriteWithEmpty` on, a blank B value also replaces), `ignore`.
  - `fillEmpty`/`update` targets must be A columns that are not key columns; one target per B column; no two rules may share a target.
  - Duplicate keys in B: `first` or `last` occurrence wins (setting `duplicateKeyInB`, default `first`).
  - B-only rows: `ignore` (default) or `append` (added after all A rows: key values go to the A key columns, mapped columns to their targets/new columns, everything else blank).
  - `new` column names default to B's header name, de-duplicated case-insensitively against A's header and each other (`name`, `name_2`, …).
  - B is indexed in memory: at most `MERGE_B_CAP = 2_000_000` distinct keys, otherwise the run fails with a clear message.
- The merged file is written to a new path via `<outPath>.<8 hex>.part` then renamed; the target may not be A's or B's file; cancel or error removes the `.part`.
- Webview CSP: nonce script only, no inline styles, no `innerHTML` (DOM via `h()` from `src/viewer/dom.ts`; verify that module has no VS Code API dependency before importing it from the merge UI).
- `src/csv/core`, `src/csv/merge`, `src/csv/export`, `src/csv/import` and `src/csv/worker` must not import `vscode`.
- Every long scan takes a `CancelToken` and returns `null` when cancelled.
- Existing tests keep passing (currently 184+); `npm run typecheck` clean after every task.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`

---

### Task 1: Pure merge core

**Files:**
- Create: `src/csv/merge/mergeCore.ts`
- Test: `src/test/unit/mergeCore.test.ts`

**Interfaces (all exported from mergeCore.ts):**
```ts
export type ColumnAction = 'new' | 'fillEmpty' | 'update' | 'ignore';

export interface ColumnRule {
    /** Column index in file B. */
    source: number;
    action: ColumnAction;
    /** fillEmpty / update: column index in file A to change. */
    target?: number;
    /** new: header of the added column (defaults to B's header). */
    newName?: string;
}

export interface MergeSettings {
    keysA: number[];
    keysB: number[];
    caseInsensitive: boolean;
    trim: boolean;
    duplicateKeyInB: 'first' | 'last';
    unmatchedB: 'ignore' | 'append';
    overwriteWithEmpty: boolean;
    rules: ColumnRule[];
}

export interface MergeStats {
    rowsA: number;
    rowsB: number;
    matched: number;
    unmatchedA: number;
    /** Distinct B keys that no A row has. */
    unmatchedB: number;
    /** B rows whose key had already been seen (the winner is chosen by duplicateKeyInB). */
    duplicateKeysB: number;
    /** B rows with a blank key (never matched). */
    blankKeysB: number;
    appended: number;
    /** Values written into new columns (non-blank only). */
    cellsAdded: number;
    cellsFilled: number;
    cellsUpdated: number;
    /** Cells left as they were (B blank, equal values, or A already had a value for fillEmpty). */
    cellsSkipped: number;
}

export interface ColumnPlan {
    /** Output header: A's header followed by the new columns. */
    header: string[];
    aWidth: number;
    newRules: ColumnRule[];
    changeRules: ColumnRule[];
    /** Distinct B columns needed by the rules (new, fillEmpty, update), ascending. */
    sourceCols: number[];
}

export interface IndexEntry { vals: string[]; keyVals: string[] | null; matched: boolean }
export interface MergedRow { row: string[]; changed: number[] }

export const MERGE_B_CAP = 2_000_000;

export function emptyStats(): MergeStats;
export function defaultSettings(): MergeSettings;                          // keys [], trim true, caseInsensitive false, first, ignore, false, rules []
export function normalizeKey(values: string[], s: Pick<MergeSettings, 'caseInsensitive' | 'trim'>): string | null;
export function validateSettings(headerA: string[], headerB: string[], s: MergeSettings): string[];   // human-readable errors, [] when valid
export function planColumns(headerA: string[], headerB: string[], s: MergeSettings): ColumnPlan;
export function autoKeys(headerA: string[], headerB: string[]): { keyA: number; keyB: number } | null;  // first same-named pair (trimmed, case-insensitive); null if none
export function defaultRules(headerA: string[], headerB: string[], keysA: number[], keysB: number[]): ColumnRule[];
export class MergeIndex {
    constructor(s: MergeSettings, plan: ColumnPlan, cap?: number);
    readonly map: Map<string, IndexEntry>;
    duplicateKeys: number;
    blankKeys: number;
    capped: boolean;
    add(bRow: string[]): void;
}
export function mergeRow(aRow: string[], entry: IndexEntry | undefined, s: MergeSettings, plan: ColumnPlan, stats: MergeStats): MergedRow;
export function appendedRow(entry: IndexEntry, s: MergeSettings, plan: ColumnPlan, stats: MergeStats): MergedRow;
```

- [ ] **Step 1: Write the failing tests** `src/test/unit/mergeCore.test.ts`

```ts
import * as assert from 'assert';
import {
    MergeIndex, appendedRow, autoKeys, defaultRules, defaultSettings, emptyStats, mergeRow, normalizeKey,
    planColumns, validateSettings,
} from '../../csv/merge/mergeCore';
import type { MergeSettings } from '../../csv/merge/mergeCore';

const HA = ['id', 'name', 'city'];
const HB = ['ID', 'name', 'email', 'city'];

function settings(over: Partial<MergeSettings>): MergeSettings {
    return { ...defaultSettings(), keysA: [0], keysB: [0], ...over };
}

suite('mergeCore: keys', () => {
    test('normalizeKey trims and lower-cases on request', () => {
        assert.strictEqual(normalizeKey([' A1 '], { trim: true, caseInsensitive: true }), normalizeKey(['a1'], { trim: true, caseInsensitive: true }));
        assert.notStrictEqual(normalizeKey([' A1 '], { trim: false, caseInsensitive: false }), normalizeKey(['A1'], { trim: false, caseInsensitive: false }));
    });
    test('blank key never matches', () => {
        assert.strictEqual(normalizeKey(['', '  '], { trim: true, caseInsensitive: false }), null);
    });
    test('composite keys are not ambiguous', () => {
        const o = { trim: false, caseInsensitive: false };
        assert.notStrictEqual(normalizeKey(['ab', 'c'], o), normalizeKey(['a', 'bc'], o));
        assert.notStrictEqual(normalizeKey(['a|1:b', 'c'], o), normalizeKey(['a', '1:b|c'], o));
    });
    test('autoKeys picks the first same-named pair ignoring case', () => {
        assert.deepStrictEqual(autoKeys(HA, HB), { keyA: 0, keyB: 0 });
        assert.strictEqual(autoKeys(['x'], ['y']), null);
    });
});

suite('mergeCore: planning and validation', () => {
    test('defaultRules: same-name columns fillEmpty, others new, keys skipped', () => {
        const rules = defaultRules(HA, HB, [0], [0]);
        assert.deepStrictEqual(rules, [
            { source: 1, action: 'fillEmpty', target: 1 },
            { source: 2, action: 'new', newName: 'email' },
            { source: 3, action: 'fillEmpty', target: 2 },
        ]);
    });
    test('planColumns builds the output header and de-duplicates new names', () => {
        const s = settings({ rules: [{ source: 2, action: 'new' }, { source: 1, action: 'new', newName: 'NAME' }, { source: 3, action: 'new', newName: 'name' }] });
        const plan = planColumns(HA, HB, s);
        assert.deepStrictEqual(plan.header, ['id', 'name', 'city', 'email', 'NAME_2', 'name_3']);
        assert.strictEqual(plan.aWidth, 3);
        assert.deepStrictEqual(plan.sourceCols, [1, 2, 3]);
    });
    test('validate: needs keys of equal length', () => {
        assert.ok(validateSettings(HA, HB, settings({ keysA: [], keysB: [] })).length > 0);
        assert.ok(validateSettings(HA, HB, settings({ keysA: [0, 1], keysB: [0] })).length > 0);
        assert.deepStrictEqual(validateSettings(HA, HB, settings({})), []);
    });
    test('validate: bad indexes, missing target, key as target, shared target, key as source', () => {
        assert.ok(validateSettings(HA, HB, settings({ keysA: [9] })).length > 0);
        assert.ok(validateSettings(HA, HB, settings({ rules: [{ source: 1, action: 'update' }] })).length > 0);
        assert.ok(validateSettings(HA, HB, settings({ rules: [{ source: 1, action: 'update', target: 0 }] })).length > 0);
        assert.ok(validateSettings(HA, HB, settings({ rules: [{ source: 1, action: 'update', target: 1 }, { source: 3, action: 'fillEmpty', target: 1 }] })).length > 0);
        assert.ok(validateSettings(HA, HB, settings({ rules: [{ source: 0, action: 'new' }] })).length > 0);
        assert.ok(validateSettings(HA, HB, settings({ rules: [{ source: 99, action: 'new' }] })).length > 0);
    });
    test('validate: ignore rules need nothing', () => {
        assert.deepStrictEqual(validateSettings(HA, HB, settings({ rules: [{ source: 1, action: 'ignore' }] })), []);
    });
});

function build(s: MergeSettings, bRows: string[][]) {
    const plan = planColumns(HA, HB, s);
    const index = new MergeIndex(s, plan);
    bRows.forEach((r) => index.add(r));
    return { plan, index };
}
const key = (s: MergeSettings, v: string) => normalizeKey([v], s);

suite('mergeCore: merging rows', () => {
    test('new column gets B value; unmatched A row gets blank', () => {
        const s = settings({ rules: [{ source: 2, action: 'new', newName: 'email' }] });
        const { plan, index } = build(s, [['1', 'Ann', 'ann@x.com', 'Paris']]);
        const stats = emptyStats();
        const hit = mergeRow(['1', 'Ann', ''], index.map.get(key(s, '1')!)!, s, plan, stats);
        assert.deepStrictEqual(hit.row, ['1', 'Ann', '', 'ann@x.com']);
        assert.deepStrictEqual(hit.changed, [3]);
        const miss = mergeRow(['2', 'Bob', ''], undefined, s, plan, stats);
        assert.deepStrictEqual(miss.row, ['2', 'Bob', '', '']);
        assert.strictEqual(stats.matched, 1);
        assert.strictEqual(stats.unmatchedA, 1);
        assert.strictEqual(stats.cellsAdded, 1);
    });
    test('fillEmpty only fills blank cells with non-blank values', () => {
        const s = settings({ rules: [{ source: 3, action: 'fillEmpty', target: 2 }] });
        const { plan, index } = build(s, [['1', 'Ann', 'e', 'Paris'], ['2', 'Bob', 'e', '']]);
        const stats = emptyStats();
        assert.deepStrictEqual(mergeRow(['1', 'Ann', ''], index.map.get(key(s, '1')!)!, s, plan, stats).row, ['1', 'Ann', 'Paris']);
        assert.deepStrictEqual(mergeRow(['1', 'Ann', 'Rome'], index.map.get(key(s, '1')!)!, s, plan, stats).row, ['1', 'Ann', 'Rome']);
        assert.deepStrictEqual(mergeRow(['2', 'Bob', ''], index.map.get(key(s, '2')!)!, s, plan, stats).row, ['2', 'Bob', '']);
        assert.strictEqual(stats.cellsFilled, 1);
        assert.strictEqual(stats.cellsSkipped, 2);
    });
    test('update replaces non-blank differing values and never blanks by default', () => {
        const s = settings({ rules: [{ source: 3, action: 'update', target: 2 }] });
        const { plan, index } = build(s, [['1', 'Ann', 'e', 'Paris'], ['2', 'Bob', 'e', ''], ['3', 'Cy', 'e', 'Oslo']]);
        const stats = emptyStats();
        assert.deepStrictEqual(mergeRow(['1', 'Ann', 'Rome'], index.map.get(key(s, '1')!)!, s, plan, stats).row, ['1', 'Ann', 'Paris']);
        assert.deepStrictEqual(mergeRow(['2', 'Bob', 'Rome'], index.map.get(key(s, '2')!)!, s, plan, stats).row, ['2', 'Bob', 'Rome']);
        assert.deepStrictEqual(mergeRow(['3', 'Cy', 'Oslo'], index.map.get(key(s, '3')!)!, s, plan, stats).row, ['3', 'Cy', 'Oslo']);
        assert.strictEqual(stats.cellsUpdated, 1);
        assert.strictEqual(stats.cellsSkipped, 2);
    });
    test('update into a blank cell counts as filled', () => {
        const s = settings({ rules: [{ source: 3, action: 'update', target: 2 }] });
        const { plan, index } = build(s, [['1', 'Ann', 'e', 'Paris']]);
        const stats = emptyStats();
        mergeRow(['1', 'Ann', ''], index.map.get(key(s, '1')!)!, s, plan, stats);
        assert.strictEqual(stats.cellsFilled, 1);
        assert.strictEqual(stats.cellsUpdated, 0);
    });
    test('overwriteWithEmpty lets update blank a cell', () => {
        const s = settings({ overwriteWithEmpty: true, rules: [{ source: 3, action: 'update', target: 2 }] });
        const { plan, index } = build(s, [['2', 'Bob', 'e', '']]);
        const stats = emptyStats();
        const r = mergeRow(['2', 'Bob', 'Rome'], index.map.get(key(s, '2')!)!, s, plan, stats);
        assert.deepStrictEqual(r.row, ['2', 'Bob', '']);
        assert.strictEqual(stats.cellsUpdated, 1);
    });
    test('ignore changes nothing', () => {
        const s = settings({ rules: [{ source: 3, action: 'ignore' }] });
        const { plan, index } = build(s, [['1', 'Ann', 'e', 'Paris']]);
        const r = mergeRow(['1', 'Ann', ''], index.map.get(key(s, '1')!)!, s, plan, emptyStats());
        assert.deepStrictEqual(r.row, ['1', 'Ann', '']);
        assert.deepStrictEqual(r.changed, []);
    });
    test('duplicate keys: first or last wins, counted', () => {
        const rows = [['1', 'A', 'first@x', 'p'], ['1', 'B', 'last@x', 'q']];
        const sFirst = settings({ rules: [{ source: 2, action: 'new' }] });
        const a = build(sFirst, rows);
        assert.strictEqual(a.index.duplicateKeys, 1);
        assert.strictEqual(a.index.map.get(key(sFirst, '1')!)!.vals[0], 'first@x');
        const sLast = settings({ duplicateKeyInB: 'last', rules: [{ source: 2, action: 'new' }] });
        const b = build(sLast, rows);
        assert.strictEqual(b.index.map.get(key(sLast, '1')!)!.vals[0], 'last@x');
    });
    test('blank B keys are skipped and counted', () => {
        const s = settings({ rules: [{ source: 2, action: 'new' }] });
        const { index } = build(s, [['', 'A', 'x', 'p'], ['1', 'B', 'y', 'q']]);
        assert.strictEqual(index.blankKeys, 1);
        assert.strictEqual(index.map.size, 1);
    });
    test('index cap sets capped and stops adding', () => {
        const s = settings({ rules: [{ source: 2, action: 'new' }] });
        const plan = planColumns(HA, HB, s);
        const index = new MergeIndex(s, plan, 2);
        ['1', '2', '3'].forEach((k) => index.add([k, 'n', 'e', 'c']));
        assert.strictEqual(index.map.size, 2);
        assert.strictEqual(index.capped, true);
    });
    test('case-insensitive trimmed keys match', () => {
        const s = settings({ caseInsensitive: true, trim: true, rules: [{ source: 2, action: 'new' }] });
        const { plan, index } = build(s, [[' ab1 ', 'n', 'e@x', 'c']]);
        const stats = emptyStats();
        const r = mergeRow(['AB1', 'n', 'c'], index.map.get(normalizeKey(['AB1'], s)!), s, plan, stats);
        assert.strictEqual(r.row[3], 'e@x');
    });
    test('appendedRow places key, targets and new columns; counts appended', () => {
        const s = settings({ unmatchedB: 'append', rules: [{ source: 2, action: 'new' }, { source: 3, action: 'fillEmpty', target: 2 }, { source: 1, action: 'update', target: 1 }] });
        const { plan, index } = build(s, [['9', 'Zed', 'z@x', 'Rome']]);
        const stats = emptyStats();
        const r = appendedRow(index.map.get(key(s, '9')!)!, s, plan, stats);
        assert.deepStrictEqual(r.row, ['9', 'Zed', 'Rome', 'z@x']);
        assert.strictEqual(stats.appended, 1);
    });
});
```

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/csv/merge/mergeCore.ts`

```ts
export type ColumnAction = 'new' | 'fillEmpty' | 'update' | 'ignore';

export interface ColumnRule {
    source: number;
    action: ColumnAction;
    target?: number;
    newName?: string;
}

export interface MergeSettings {
    keysA: number[];
    keysB: number[];
    caseInsensitive: boolean;
    trim: boolean;
    duplicateKeyInB: 'first' | 'last';
    unmatchedB: 'ignore' | 'append';
    overwriteWithEmpty: boolean;
    rules: ColumnRule[];
}

export interface MergeStats {
    rowsA: number;
    rowsB: number;
    matched: number;
    unmatchedA: number;
    unmatchedB: number;
    duplicateKeysB: number;
    blankKeysB: number;
    appended: number;
    cellsAdded: number;
    cellsFilled: number;
    cellsUpdated: number;
    cellsSkipped: number;
}

export interface ColumnPlan {
    header: string[];
    aWidth: number;
    newRules: ColumnRule[];
    changeRules: ColumnRule[];
    sourceCols: number[];
}

export interface IndexEntry {
    vals: string[];
    keyVals: string[] | null;
    matched: boolean;
}

export interface MergedRow {
    row: string[];
    changed: number[];
}

export const MERGE_B_CAP = 2_000_000;

export function emptyStats(): MergeStats {
    return {
        rowsA: 0, rowsB: 0, matched: 0, unmatchedA: 0, unmatchedB: 0, duplicateKeysB: 0, blankKeysB: 0,
        appended: 0, cellsAdded: 0, cellsFilled: 0, cellsUpdated: 0, cellsSkipped: 0,
    };
}

export function defaultSettings(): MergeSettings {
    return {
        keysA: [], keysB: [], caseInsensitive: false, trim: true, duplicateKeyInB: 'first',
        unmatchedB: 'ignore', overwriteWithEmpty: false, rules: [],
    };
}

const isBlank = (v: string): boolean => v.trim() === '';

export function normalizeKey(values: string[], s: Pick<MergeSettings, 'caseInsensitive' | 'trim'>): string | null {
    const parts = values.map((v) => {
        let x = s.trim ? v.trim() : v;
        if (s.caseInsensitive) {
            x = x.toLowerCase();
        }
        return x;
    });
    if (parts.every(isBlank)) {
        return null;
    }
    return parts.map((p) => `${p.length}:${p}`).join('|');
}

export function validateSettings(headerA: string[], headerB: string[], s: MergeSettings): string[] {
    const errors: string[] = [];
    const inRange = (c: number, n: number): boolean => Number.isInteger(c) && c >= 0 && c < n;
    if (s.keysA.length === 0 || s.keysB.length === 0 || s.keysA.length !== s.keysB.length) {
        errors.push('Choose at least one key column in each file, with the same number of key columns.');
    }
    if (!s.keysA.every((c) => inRange(c, headerA.length)) || !s.keysB.every((c) => inRange(c, headerB.length))) {
        errors.push('A key column does not exist in its file.');
    }
    const targets = new Set<number>();
    for (const rule of s.rules) {
        if (!inRange(rule.source, headerB.length)) {
            errors.push(`The second file has no column number ${rule.source + 1}.`);
            continue;
        }
        const name = headerB[rule.source];
        if (rule.action === 'ignore') {
            continue;
        }
        if (s.keysB.includes(rule.source)) {
            errors.push(`The key column "${name}" cannot also be merged.`);
            continue;
        }
        if (rule.action === 'new') {
            continue;
        }
        if (rule.target === undefined || !inRange(rule.target, headerA.length)) {
            errors.push(`Choose the column to ${rule.action === 'fillEmpty' ? 'fill' : 'update'} for "${name}".`);
            continue;
        }
        if (s.keysA.includes(rule.target)) {
            errors.push(`"${name}" cannot change the key column "${headerA[rule.target]}".`);
        }
        if (targets.has(rule.target)) {
            errors.push(`More than one column of the second file targets "${headerA[rule.target]}".`);
        }
        targets.add(rule.target);
    }
    return errors;
}

export function planColumns(headerA: string[], headerB: string[], s: MergeSettings): ColumnPlan {
    const active = s.rules.filter((r) => r.action !== 'ignore');
    const newRules = active.filter((r) => r.action === 'new');
    const changeRules = active.filter((r) => r.action === 'fillEmpty' || r.action === 'update');
    const used = new Set(headerA.map((h) => h.toLowerCase()));
    const header = headerA.slice();
    for (const rule of newRules) {
        const base = (rule.newName?.trim() || headerB[rule.source] || `Column ${rule.source + 1}`).trim() || 'Column';
        let name = base;
        let n = 1;
        while (used.has(name.toLowerCase())) {
            n++;
            name = `${base}_${n}`;
        }
        used.add(name.toLowerCase());
        header.push(name);
    }
    const sourceCols = [...new Set(active.map((r) => r.source))].sort((a, b) => a - b);
    return { header, aWidth: headerA.length, newRules, changeRules, sourceCols };
}

export function autoKeys(headerA: string[], headerB: string[]): { keyA: number; keyB: number } | null {
    const norm = (h: string): string => h.trim().toLowerCase();
    for (let a = 0; a < headerA.length; a++) {
        const b = headerB.findIndex((h) => norm(h) === norm(headerA[a]));
        if (b !== -1 && norm(headerA[a]) !== '') {
            return { keyA: a, keyB: b };
        }
    }
    return null;
}

export function defaultRules(headerA: string[], headerB: string[], keysA: number[], keysB: number[]): ColumnRule[] {
    const rules: ColumnRule[] = [];
    headerB.forEach((name, source) => {
        if (keysB.includes(source)) {
            return;
        }
        const target = headerA.findIndex((h, i) => !keysA.includes(i) && h.trim().toLowerCase() === name.trim().toLowerCase());
        rules.push(target === -1 ? { source, action: 'new', newName: name } : { source, action: 'fillEmpty', target });
    });
    return rules;
}

export class MergeIndex {
    readonly map = new Map<string, IndexEntry>();
    duplicateKeys = 0;
    blankKeys = 0;
    capped = false;

    constructor(
        private readonly s: MergeSettings,
        private readonly plan: ColumnPlan,
        private readonly cap: number = MERGE_B_CAP,
    ) { }

    add(bRow: string[]): void {
        const key = normalizeKey(this.s.keysB.map((c) => bRow[c] ?? ''), this.s);
        if (key === null) {
            this.blankKeys++;
            return;
        }
        const vals = this.plan.sourceCols.map((c) => bRow[c] ?? '');
        const keyVals = this.s.unmatchedB === 'append' ? this.s.keysB.map((c) => bRow[c] ?? '') : null;
        const existing = this.map.get(key);
        if (existing) {
            this.duplicateKeys++;
            if (this.s.duplicateKeyInB === 'last') {
                existing.vals = vals;
                existing.keyVals = keyVals;
            }
            return;
        }
        if (this.map.size >= this.cap) {
            this.capped = true;
            return;
        }
        this.map.set(key, { vals, keyVals, matched: false });
    }
}

function valueOf(entry: IndexEntry, plan: ColumnPlan, source: number): string {
    return entry.vals[plan.sourceCols.indexOf(source)] ?? '';
}

export function mergeRow(
    aRow: string[],
    entry: IndexEntry | undefined,
    s: MergeSettings,
    plan: ColumnPlan,
    stats: MergeStats,
): MergedRow {
    const row = new Array<string>(plan.header.length).fill('');
    for (let i = 0; i < plan.aWidth; i++) {
        row[i] = aRow[i] ?? '';
    }
    const changed: number[] = [];
    if (!entry) {
        stats.unmatchedA++;
        return { row, changed };
    }
    stats.matched++;
    entry.matched = true;
    plan.newRules.forEach((rule, i) => {
        const v = valueOf(entry, plan, rule.source);
        const col = plan.aWidth + i;
        row[col] = v;
        if (!isBlank(v)) {
            stats.cellsAdded++;
            changed.push(col);
        }
    });
    for (const rule of plan.changeRules) {
        const v = valueOf(entry, plan, rule.source);
        const t = rule.target as number;
        const cur = row[t];
        if (rule.action === 'fillEmpty') {
            if (isBlank(cur) && !isBlank(v)) {
                row[t] = v;
                stats.cellsFilled++;
                changed.push(t);
            } else {
                stats.cellsSkipped++;
            }
            continue;
        }
        if ((isBlank(v) && !s.overwriteWithEmpty) || v === cur) {
            stats.cellsSkipped++;
            continue;
        }
        row[t] = v;
        if (isBlank(cur)) {
            stats.cellsFilled++;
        } else {
            stats.cellsUpdated++;
        }
        changed.push(t);
    }
    changed.sort((a, b) => a - b);
    return { row, changed };
}

export function appendedRow(entry: IndexEntry, s: MergeSettings, plan: ColumnPlan, stats: MergeStats): MergedRow {
    const row = new Array<string>(plan.header.length).fill('');
    const changed: number[] = [];
    s.keysA.forEach((c, i) => {
        row[c] = entry.keyVals?.[i] ?? '';
        changed.push(c);
    });
    for (const rule of plan.changeRules) {
        const t = rule.target as number;
        row[t] = valueOf(entry, plan, rule.source);
        if (!isBlank(row[t])) {
            changed.push(t);
        }
    }
    plan.newRules.forEach((rule, i) => {
        const col = plan.aWidth + i;
        row[col] = valueOf(entry, plan, rule.source);
        if (!isBlank(row[col])) {
            changed.push(col);
        }
    });
    stats.appended++;
    changed.sort((a, b) => a - b);
    return { row, changed };
}
```

- [ ] **Step 4: Run** `npm run test:unit` and `npm run typecheck` — Expected: all pass. If a test expectation in Step 1 contradicts the semantics in Global Constraints, the Global Constraints win: fix the test and say so in the report.

- [ ] **Step 5: Commit**
```bash
git add src/csv/merge/mergeCore.ts src/test/unit/mergeCore.test.ts
git commit -m "Add the pure merge core (keys, column plan, per-row merge)"
```

---

### Task 2: Streaming merge driver (preview and write)

**Files:**
- Create: `src/csv/merge/merge.ts`
- Test: `src/test/unit/merge.test.ts` (copy the temp-file `load` pattern from `src/test/unit/exportFile.test.ts`: `TINY` tuning, `load(content)` returning an indexed `CsvEngine`, teardown removing the temp dir)

**Interfaces:**
- Consumes: Task 1; `CsvEngine.exportRows('all', token, onWindow, onProgress)` and `getInfo()`; `createFormatter('csv', header)` from `src/csv/core/formats.ts`; the same-path helper (see Prerequisite).
- Produces (merge.ts):
```ts
export interface MergeSource {
    info(): Promise<FileInfo>;
    scan(token: CancelToken, onWindow: (rows: string[][]) => Promise<boolean | void>,
         onProgress: (done: number, total: number) => void): Promise<'complete' | 'stopped' | 'cancelled'>;
}
export function engineSource(engine: CsvEngine): MergeSource;

export interface MergeProgress { phase: 'second' | 'first'; done: number; total: number }

export interface MergeSample {
    /** 0-based data row number in file A (appended rows: -1). */
    rowNumber: number;
    key: string[];
    before: string[];   // A's original cells (padded to A's width); [] for appended rows
    after: string[];    // output row
    changed: number[];  // output column indexes that changed
}

export interface MergeResult {
    stats: MergeStats;
    header: string[];
    samples: MergeSample[];          // changed A rows, at most SAMPLE_LIMIT
    appendedSamples: MergeSample[];  // at most APPEND_SAMPLE_LIMIT
    outPath?: string;
}

export const SAMPLE_LIMIT = 30;
export const APPEND_SAMPLE_LIMIT = 10;

export type MergeMode = { kind: 'preview' } | { kind: 'write'; outPath: string; protectedPaths: string[] };

export function runMerge(a: MergeSource, b: MergeSource, s: MergeSettings, mode: MergeMode,
    token: CancelToken, onProgress: (p: MergeProgress) => void): Promise<MergeResult | null>;  // null = cancelled
```

Behaviour of `runMerge`:
1. `infoA`, `infoB`; `validateSettings(...)` errors joined with a space become `throw new Error(...)`. In `write` mode refuse (throw) when `outPath` is the same path as any of `protectedPaths` (use the same-path helper).
2. Scan **B** (`phase: 'second'`): `stats.rowsB += rows.length`, `index.add(row)` per row. Cancelled → `null`. After the scan, if `index.capped` throw `Error('The second file has more than 2,000,000 distinct keys. Filter it first or merge a smaller file.')`; copy `duplicateKeysB` and `blankKeysB` into stats.
3. In `write` mode create `<outPath>.<8 hex>.part`, a CSV formatter for the output header (`createFormatter('csv', plan.header)`), write `begin()`; every write awaits the stream callback (same pattern as `writeText` in `src/csv/export/exportFile.ts`).
4. Scan **A** (`phase: 'first'`): per row `stats.rowsA++`, key via `normalizeKey(keysA.map(c => row[c] ?? ''), s)`, entry = `key === null ? undefined : index.map.get(key)`, `mergeRow`, write the formatted row (write mode) or collect a `MergeSample` when `changed.length > 0` and fewer than `SAMPLE_LIMIT` (preview mode).
5. After A: `stats.unmatchedB` = number of index entries with `matched === false`. If `s.unmatchedB === 'append'`, for each unmatched entry (Map insertion order) `appendedRow(...)`, write or sample (`rowNumber: -1`, `before: []`, at most `APPEND_SAMPLE_LIMIT` samples).
6. Write mode: `end()`, close the stream, rename `.part` → `outPath`, return `{..., outPath}`. Cancel at any point or any error: destroy the stream, wait for `close`, remove the `.part`, return `null` / rethrow. Preview mode never touches the disk.

- [ ] **Step 1: Write the failing tests** `src/test/unit/merge.test.ts` (use real engines on temp CSV files):

```ts
// Files used by most tests:
const A = 'id,name,city\n1,Ann,\n2,Bob,Rome\n3,Cy,\n';
const B = 'ID,name,email,city\n1,Annie,ann@x.com,Paris\n2,Bobby,bob@x.com,\n4,Dee,dee@x.com,Oslo\n';
```
Tests (each builds `engineSource` for A and B, the settings via `defaultSettings()` plus overrides and rules from `defaultRules` where convenient):
  1. **preview, new column**: rule `{source: 2, action: 'new', newName: 'email'}`; assert `result.header` is `['id','name','city','email']`; stats `rowsA 3, rowsB 3, matched 2, unmatchedA 1, unmatchedB 1, cellsAdded 2`; `samples` has 2 entries whose `after` are `['1','Ann','','ann@x.com']` and `['2','Bob','Rome','bob@x.com']` with `changed` `[3]`; nothing written to disk.
  2. **write, new column + fillEmpty city + update name**: rules `new email`, `fillEmpty city` (source 3 → target 2), `update name` (source 1 → target 1); file content exactly `id,name,city,email\n1,Annie,Paris,ann@x.com\n2,Bobby,Rome,bob@x.com\n3,Cy,,\n`; stats `cellsFilled 1, cellsUpdated 2, cellsSkipped 1` (Bob's city: B blank, A has Rome → fillEmpty skipped); no `.part` file remains in the directory.
  3. **append B-only rows**: `unmatchedB: 'append'`, same rules as test 2; output ends with `4,Dee,Oslo,dee@x.com\n`; `stats.appended === 1`.
  4. **case-insensitive + trim keys**: A key `' x1 '`, B key `X1`, `caseInsensitive` + `trim` true → matched.
  5. **composite key**: two key columns on both sides.
  6. **cancel**: a pre-cancelled token → resolves `null`; in write mode no output file and no `.part`.
  7. **cap**: not unit-testable through the public constant; instead assert that a B file with a duplicate-key row increments `duplicateKeysB` and that `first` vs `last` yields the matching email in the output.
  8. **validation error**: settings with no keys → `runMerge` rejects with a message containing "key column".
  9. **protected path**: write mode with `outPath` equal to `protectedPaths[0]` rejects and leaves that file byte-for-byte unchanged.
  10. **progress**: `onProgress` is called with `phase: 'second'` then `phase: 'first'`, the last call of each having `done === total`.
  11. **quoting**: B value `Smith, "Jr"` is written correctly quoted (`"Smith, ""Jr"""`) and re-reading the output with a new `CsvEngine` yields the original value.
  12. **short rows / ragged A**: an A row with fewer cells than the header is padded to the output width.

- [ ] **Step 2: Run** `npm run test:unit` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/csv/merge/merge.ts` per the behaviour list above (file stream handling copied from `writeText` in `exportFile.ts`: open event awaited, `stream.on('error', noop)`, write callback promises, `closeStream` that handles an already-closed stream). Keep `runMerge` under ~150 lines by extracting `openPartWriter(outPath)` returning `{ write(text): Promise<void>; finish(): Promise<void>; abort(): Promise<void> }`.

- [ ] **Step 4: Run** `npm run test:unit`, `npm run typecheck`, `npm run build` — Expected: pass. `grep -c "from 'vscode'" -r src/csv/merge` prints 0 per file.

- [ ] **Step 5: Commit**
```bash
git add src/csv/merge/merge.ts src/test/unit/merge.test.ts
git commit -m "Add the streaming merge driver with preview and write modes"
```

---

### Task 3: Worker requests `inspect` and `merge`

**Files:**
- Modify: `src/csv/protocol.ts`, `src/csv/types.ts`, `src/csv/worker/csvWorker.ts`, `src/csv/WorkerClient.ts` (progress union only if it type-checks no other way)
- Create: `src/csv/merge/openSource.ts`
- Test: `src/test/unit/openSource.test.ts`

**Interfaces:**
- Produces (openSource.ts, worker side, no `vscode`):
```ts
export interface OpenedSource { engine: CsvEngine; info: FileInfo; source: MergeSource; dispose(): Promise<void> }
/** Open a CSV/TSV/PSV file in a fresh engine and index it completely. Rejects with a readable message for empty/binary/unsupported files. */
export function openIndexedSource(path: string, token: CancelToken, onProgress?: (done: number, total: number) => void): Promise<OpenedSource>;
/** Open, read only the header and a few rows (does not wait for the whole index), then dispose. */
export function inspectFile(path: string, sampleRows: number): Promise<{ info: FileInfo; sample: string[][] }>;
```
- Produces (protocol.ts): `WorkerRequest` gains
  `| { id: number; type: 'inspect'; path: string }`
  `| { id: number; type: 'merge'; a: string; b: string; settings: MergeSettings; mode: { kind: 'preview' } | { kind: 'write'; outPath: string } }`;
  the worker `progress` data union gains `MergeProgress` (and `{ phase: 'open'; done: number; total: number }` is NOT added: file opening reports as `phase: 'second'`/`'first'` by passing the matching callback into `openIndexedSource`).
  Result of `inspect`: `{ info: FileInfo; sample: string[][] }`; result of `merge`: `MergeResult | null`.

Worker `merge` handler: `tokenFor(req.id)`; open **B** then **A** with `openIndexedSource` (two fresh engines, not the viewer engine; A's indexing progress is reported as `{ phase: 'first', ... }`, B's as `{ phase: 'second', ... }` — preview/scan progress from `runMerge` uses the same phases, so the UI shows one progress bar per phase); `runMerge(a.source, b.source, req.settings, mode with protectedPaths [req.a, req.b], token, progress)`; always `dispose()` both engines in `finally`; `tokens.delete`.

- [ ] **Step 1: Tests** `src/test/unit/openSource.test.ts`: `inspectFile` on a 3-row CSV returns the header, delimiter and up to N sample rows; on an empty file rejects with a message containing "empty"; on a binary file (bytes with NULs) rejects with "binary"; `openIndexedSource` on a small CSV returns an indexed source whose `scan` visits every row, and `dispose()` can be called twice without throwing.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `openSource.ts` using `new CsvEngine(path, {}, DEFAULT_TUNING)`, `engine.open()` (map `empty`/`binary`/`unsupported-encoding` outcomes to `Error` messages: "This file is empty.", "This looks like a binary file, not a CSV.", "Encoding … is not supported yet."), `engine.index(onProgressAdapter, token)` awaited, `engine.getInfo()`; `inspectFile` starts the index without awaiting it (like the worker's `doOpen`), awaits `getInfo()`, reads `readPage(0, sampleRows)`, cancels the index via a token it owns, disposes. Wire protocol types and the two worker cases.
- [ ] **Step 4: Run** `npm run test:unit`, `npm run typecheck`, `npm run build` — Expected: pass.
- [ ] **Step 5: Commit**
```bash
git add src/csv/merge/openSource.ts src/csv/protocol.ts src/csv/types.ts src/csv/worker/csvWorker.ts src/csv/WorkerClient.ts src/test/unit/openSource.test.ts
git commit -m "Add inspect and merge worker requests"
```

---

### Task 4: Merge panel (host), merge UI (webview), entry points

**Files:**
- Create: `src/merge/MergePanel.ts`, `src/merge/protocol.ts`, `src/merge/ui/main.ts`, `src/merge/ui/state.ts`, `src/merge/ui/render.ts`, `src/merge/ui/tsconfig.json` (copy `src/viewer/tsconfig.json`), `media/merge.css`
- Modify: `esbuild.mjs` (4th target), `package.json` (typecheck script, command, sidebar Tools entry), `src/extension.ts`, `src/csv/CsvSession.ts` (expose `get fileUri(): vscode.Uri`), `src/sidebar/trees.ts` (Tools item), `src/test/integration/extension.test.ts`

**Interfaces:**
- Produces (`src/merge/protocol.ts`, type-only, shared by host and UI):
```ts
export type Side = 'a' | 'b';
export interface FileView { path: string; name: string; info: FileInfo; sample: string[][] }

export type HostToMerge =
    | { type: 'init'; a: FileView | null }
    | { type: 'file'; side: Side; file: FileView }
    | { type: 'progress'; job: 'preview' | 'merge'; phase: 'second' | 'first'; done: number; total: number }
    | { type: 'preview'; result: MergeResult }
    | { type: 'merged'; outPath: string; stats: MergeStats }
    | { type: 'cancelled' }
    | { type: 'error'; message: string };

export type MergeToHost =
    | { type: 'ready' }
    | { type: 'pick'; side: Side }
    | { type: 'preview'; settings: MergeSettings }
    | { type: 'merge'; settings: MergeSettings }
    | { type: 'cancel' }
    | { type: 'open'; path: string };
```
- Command `get-unique-values.merge.open` ("Data Toolkit: Merge Two CSV Files…"), a sidebar Tools item "Merge two CSV files…" (icon `git-merge`), both opening/focusing the single `MergePanel`; when a CSV viewer is active its file (CSV/TSV/PSV only) pre-fills file A.

**Host behaviour (`MergePanel.ts`):**
- One panel at a time (`MergePanel.show(context, api)`); own `WorkerClient` (path `out/csvWorker.js`) created with the panel, disposed with it (pending requests reject with the disposed error from the final fix wave: ignore that error silently).
- HTML like `CsvSession.html()`: CSP `default-src 'none'; style-src ${cspSource}; script-src 'nonce-…'`, `out/mergeView.js`, `media/merge.css`, `localResourceRoots` out + media.
- `pick`: `showOpenDialog` (filters csv/tsv/psv/txt), then worker `inspect` (sample of 5 rows) → `file` message; a failure posts `error`.
- `preview`: cancel any running job; worker `merge` with `mode: {kind:'preview'}`, progress → `progress` messages; result → `preview`; `null` → `cancelled`; errors → `error`.
- `merge`: `showSaveDialog` (default `<A dir>/<A base>-merged.csv`, filter csv); refuse (error message) a target equal to A's or B's file; worker `merge` with `mode: {kind:'write', outPath}`; progress; result → `merged` then an information message with `Open in viewer` (`vscode.commands.executeCommand('get-unique-values.openCsvViewer', Uri.file(outPath))`) and `Reveal in file manager`.
- `cancel` → `worker.cancel(currentJobId)`. Only one job at a time.

**UI behaviour (`src/merge/ui/*`, vanilla DOM via `h()`; no `innerHTML`, no inline styles):**
- State: `a`, `b` (FileView | null), settings (`MergeSettings` from `defaultSettings()`), `preview` (MergeResult | null), `stale` (true whenever any setting or file changes after a preview), `running` (job + progress), `error`.
- Sections in order: **1. Files** (A "Base file — keeps all its rows", B "Data file — supplies values"; name, delimiter, column count, a collapsible 5-row sample table; `Choose…` buttons). **2. Match rows on** (list of key pairs: select A column ↔ select B column, `Add another key`, remove; when both files are loaded and no keys are set, preselect via `autoKeys`; checkboxes `Trim spaces`, `Ignore upper/lower case`). **3. Columns of the data file** (table: B column name, first sample value, Action select — "Add as new column" / "Fill empty cells of…" / "Update…" / "Ignore"; for fill/update a target select listing A's non-key columns, for new a name input; key columns of B are shown greyed as "Match column"; buttons `Match by name` (= `defaultRules`) and `All as new columns`). **4. Options** (`If the data file repeats a key: use first/last`, `Rows only in the data file: ignore / add at the end`, checkbox `Allow update to replace with empty values`). **5. Preview and merge**: button `Preview` (disabled until `validateSettings` returns no errors; errors listed above it); progress bar per phase with `Cancel` while running; the result: stat lines (matched, only in base, only in data file, repeated keys, cells added / filled / updated / skipped, rows appended), a sample table "First changed rows" (key, then each changed cell shown as old → new, unchanged columns omitted or dimmed), "Rows that would be added" sample; a stale notice "Settings changed: preview again" disabling `Merge and save…`; button `Merge and save…` enabled only for a non-stale preview with no errors; on `merged` show the stats, the path and an `Open result` button (`open` message).
- Any change to files/keys/rules/options sets `stale = true` and clears nothing else.
- `main.ts` posts `ready` on load, handles every `HostToMerge` message, re-renders from state.

- [ ] **Step 1:** Create the files above following the behaviour lists. Reuse `h`, `fmt` from `src/viewer/dom.ts` after confirming it has no dependency on `acquireVsCodeApi`/viewer state (if it does, copy the two helpers into `src/merge/ui/dom.ts`). The UI imports `defaultSettings`, `autoKeys`, `defaultRules`, `validateSettings` from `../../csv/merge/mergeCore` (pure, bundles fine).
- [ ] **Step 2: Build wiring.** `esbuild.mjs`: add `{ ...common, entryPoints: ['src/merge/ui/main.ts'], outfile: 'out/mergeView.js', platform: 'browser', format: 'iife', target: 'es2022' }`. `package.json` `typecheck` script: append `&& tsc -p src/merge/ui --noEmit`. Add the command to `contributes.commands` and make it visible in the palette. Sidebar: add the Tools item in `src/sidebar/trees.ts` (command `get-unique-values.merge.open`). `extension.ts`: register the command (inside `registerMergePanel(context, api)` exported from `MergePanel.ts`). `CsvSession`: add `get fileUri(): vscode.Uri { return this.uri; }`.
- [ ] **Step 3: Integration test** (append to `src/test/integration/extension.test.ts`): `get-unique-values.merge.open` is registered, executing it creates the panel without throwing (use the command and assert no rejection; do not drive the webview).
- [ ] **Step 4: Run** `npm run typecheck`, `npm run build` (confirm `out/mergeView.js` exists and `grep -c WorkbookWriter out/mergeView.js` and `out/extension.js` print 0), `npm run test:unit`, `npm run test:integration`.
- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "Add the Merge Two CSV Files panel with preview and confirm"
```

---

### Task 5: Release 0.3.0

**Files:** `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1:** `npm version 0.3.0 --no-git-tag-version`.
- [ ] **Step 2:** `CHANGELOG.md` `## [0.3.0]` / `### Added`: **Merge Two CSV Files** (Command Palette "Data Toolkit: Merge Two CSV Files…" and the sidebar Tools list): match rows on one or more key columns; per column of the second file add as new column / fill empty cells / update / ignore; options for repeated keys and rows only in the second file; preview with counts and sample changes, then confirm; the result is a new file and the originals are never changed. `### Notes`: CSV/TSV/PSV only (Excel files: export to CSV first); the second file is indexed in memory (up to 2,000,000 distinct keys).
- [ ] **Step 3:** README: a "Merge two files" section (the five steps: choose files, choose key, choose what to do with each column, preview, confirm; plus the semantics of fill empty vs update) and a feature bullet.
- [ ] **Step 4:** Verify: `npm run typecheck && npm run test:unit && npm run test:integration && npm run build`; `npx @vscode/vsce package` produces `get-unique-values-0.3.0.vsix` (~420 KB expected); `npx @vscode/vsce ls | grep -E "mergeView|merge.css"` lists both files.
- [ ] **Step 5: Commit**
```bash
git add package.json package-lock.json CHANGELOG.md README.md
git commit -m "Release 0.3.0: merge two CSV files with preview and confirm"
```
- [ ] **Step 6 (controller, manual):** F5 pass with two small files (e.g. `/tmp/merge-a.csv`, `/tmp/merge-b.csv` generated by the controller): choose files, key auto-selected, each action type, preview counts and samples, change a setting (preview goes stale, Merge disabled), confirm, open the result in the viewer; try a target equal to a source (refused); cancel a preview on a large file. Do not publish until this passes.
