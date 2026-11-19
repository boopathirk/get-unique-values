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
    if (state.panel && (state.panel.kind === 'detail' || state.panel.kind === 'record')) {
        state.panel = null;
        emit('panel');
    }
}

export function goToPage(page: number): void {
    const max = state.complete ? totalPages() - 1 : Number.MAX_SAFE_INTEGER;
    closeRowPanels();
    state.selected = null;
    loadPage(Math.max(0, Math.min(page, max)));
    emit('status');
}

/** Send the current search + column filters + bad-rows flag to the worker as one AND-ed filter. */
export function applyFilters(): void {
    const s = state.search;
    let regexError = '';
    if (s.regex && s.query !== '') {
        try {
            new RegExp(s.query);
        } catch (err) {
            regexError = err instanceof Error ? err.message : String(err);
        }
    }
    // An invalid regex is left out of the filter, so the table always matches what the host applies.
    const predicates = buildPredicates(regexError !== '');
    state.filterJob++;
    state.filterError = regexError === '' ? '' : `Invalid regular expression — search term ignored: ${regexError}`;
    state.filterActive = predicates.length > 0;
    state.filterRunning = predicates.length > 0;
    state.filtering = null;
    state.page = 0;
    state.selected = null;
    closeRowPanels();
    post({ type: 'filter', jobId: state.filterJob, predicates });
    loadPage(0);
    emit('status');
}

export function clearColumnFilter(column: number): void {
    delete state.columnFilters[column];
    applyFilters();
    emit('table');
    emit('panel');
}

export function clearAllFilters(): void {
    state.search.query = '';
    state.columnFilters = {};
    state.badRowsOnly = false;
    applyFilters();
    emit('table');
    emit('panel');
}

/** Persist the layout (per file) and re-render everything. */
export function saveLayout(): void {
    if (state.layout) {
        post({ type: 'saveLayout', layout: state.layout });
    }
    emit('render');
}
