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
    | { kind: 'detail'; rowNumber: number; col: number }
    | { kind: 'record'; rowNumber: number }
    | null;

export interface Banner {
    kind: 'info' | 'error';
    message: string;
    reload?: boolean;
    retry?: boolean;
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

    nonEmptyJob: 0,

    // side panel
    panel: null as Panel,
    unique: null as UniqueResult | null,
    uniqueLoading: false,
    uniqueJob: 0,
    uniqueError: '',
};

export function buildPredicates(skipSearch = false): Predicate[] {
    const predicates: Predicate[] = [];
    const s = state.search;
    if (s.query !== '' && !skipSearch) {
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

/** Show a dismissible info banner. */
export function showInfo(message: string): void {
    state.banner = { kind: 'info', message };
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
    state.uniqueError = '';
    state.uniqueJob++;
    state.nonEmptyJob++;
}
