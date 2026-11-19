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
