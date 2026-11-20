import { visibleColumns } from '../csv/core/layout';
import { applyFilters, emit } from './actions';
import { fmt, h } from './dom';
import { clampPinned, mutate } from './layoutOps';
import { panelHeader } from './panelCommon';
import { cancelAnalysis, post, state } from './state';

const MAX_ROWS = 500;
const MAX_CHECKS = 300;
let listScroll = 0;
let rowScanStarted = false;

const name = (c: number): string => state.info?.header[c] ?? `Column ${c + 1}`;

function reset(mode: 'rows' | 'columns', selected: number[]): void {
    cancelAnalysis();
    rowScanStarted = false;
    if (state.dup.mode !== mode) {
        listScroll = 0;
    }
    state.panel = { kind: 'duplicates' };
    state.dup.mode = mode;
    state.dup.selected = selected;
    state.duplicates = null;
    state.duplicateColumns = null;
    state.analysisLoading = false;
    state.analysisError = '';
}

function scanRows(): void {
    cancelAnalysis();
    rowScanStarted = true;
    state.duplicates = null;
    state.analysisLoading = true;
    state.analysisError = '';
    state.analysisJob++;
    post({ type: 'duplicates', jobId: state.analysisJob, columns: [...state.dup.selected] });
    emit('panel');
}

function scanColumns(): void {
    cancelAnalysis();
    state.analysisLoading = true;
    state.analysisJob++;
    post({ type: 'duplicateColumns', jobId: state.analysisJob });
}

export function openDuplicates(arg: { mode: 'rows' | 'columns'; columns?: number[] }): void {
    reset(arg.mode, arg.columns ?? []);
    state.dup.filter = '';
    listScroll = 0;
    if (arg.mode === 'columns') {
        scanColumns();
    } else if (state.dup.selected.length > 0) {
        scanRows();
        return;
    }
    emit('panel');
}

function switchMode(mode: 'rows' | 'columns'): void {
    reset(mode, state.dup.selected);
    if (mode === 'columns') {
        scanColumns();
    }
    emit('panel');
}

function scanning(body: HTMLElement): void {
    const cancel = h('button', {}, 'Cancel');
    cancel.addEventListener('click', () => post({ type: 'cancel', kind: 'analysis', jobId: state.analysisJob }));
    body.append(h('div', { class: 'message' }, 'Looking for duplicates…'), cancel);
}

export function renderDuplicates(root: HTMLElement): void {
    root.append(panelHeader('Duplicates'));
    const modes = h('div', { class: 'dup-modes' });
    for (const [mode, label] of [['rows', 'Rows'], ['columns', 'Columns']] as const) {
        const btn = h('button', { class: state.dup.mode === mode ? 'active' : '' }, label);
        btn.addEventListener('click', () => switchMode(mode));
        modes.append(btn);
    }
    const body = h('div', { class: 'side-body' });
    root.append(modes, body);
    if (state.dup.mode === 'rows') {
        renderRows(body);
    } else {
        renderColumns(body);
    }
}

function renderRows(body: HTMLElement): void {
    const info = state.info;
    body.append(h('div', { class: 'u-summary' }, 'Rows are duplicates when the chosen columns have the same values.'));
    const loading = state.analysisLoading;
    const filter = h('input', { type: 'search', placeholder: 'Filter columns…', 'aria-label': 'Filter columns' });
    filter.value = state.dup.filter;
    const list = h('div', { class: 'col-check' });
    const boxes = new Map<number, HTMLInputElement>();
    const sync = (): void => {
        find.disabled = state.dup.selected.length === 0 || state.analysisLoading;
    };
    const header = info?.header ?? [];
    const hint = h('div', { class: 'u-summary' });
    const fill = (): void => {
        const q = state.dup.filter.toLowerCase();
        list.replaceChildren();
        boxes.clear();
        let shown = 0;
        let matched = 0;
        header.forEach((text, c) => {
            if (q !== '' && !text.toLowerCase().includes(q)) {
                return;
            }
            matched++;
            if (shown >= MAX_CHECKS) {
                return;
            }
            shown++;
            const box = h('input', { type: 'checkbox' });
            box.checked = state.dup.selected.includes(c);
            box.disabled = loading;
            box.addEventListener('change', () => {
                const s = state.dup.selected.filter((x) => x !== c);
                if (box.checked) {
                    s.push(c);
                }
                state.dup.selected = s.sort((x, y) => x - y);
                sync();
            });
            boxes.set(c, box);
            list.append(h('label', {}, box, h('span', {}, text)));
        });
        hint.textContent = matched > shown
            ? (q === '' ? `Showing the first ${MAX_CHECKS} of ${fmt(header.length)} columns — type to narrow` : `Showing the first ${MAX_CHECKS} of ${fmt(matched)} matching columns — type to narrow`)
            : '';
        hint.hidden = hint.textContent === '';
    };
    list.addEventListener('scroll', () => {
        listScroll = list.scrollTop;
    });
    filter.addEventListener('input', () => {
        state.dup.filter = filter.value;
        listScroll = 0;
        fill();
    });
    fill();
    const all = h('button', {}, 'All columns');
    all.addEventListener('click', () => {
        state.dup.selected = header.map((_, i) => i);
        boxes.forEach((b) => (b.checked = true));
        sync();
    });
    const none = h('button', {}, 'None');
    none.addEventListener('click', () => {
        state.dup.selected = [];
        boxes.forEach((b) => (b.checked = false));
        sync();
    });
    const find = h('button', {}, 'Find duplicates');
    find.addEventListener('click', () => {
        if (state.dup.selected.length > 0) {
            scanRows();
        }
    });
    all.disabled = loading;
    none.disabled = loading;
    body.append(filter, list, hint, h('div', { class: 'dup-modes' }, all, none, find));
    list.scrollTop = listScroll;
    sync();

    if (state.analysisLoading) {
        scanning(body);
        return;
    }
    if (state.analysisError) {
        body.append(h('div', { class: 'message err' }, `Could not scan: ${state.analysisError}`));
        return;
    }
    const r = state.duplicates;
    if (!r && rowScanStarted) {
        body.append(h('div', { class: 'message' }, 'The scan was cancelled. Choose "Find duplicates" again to retry.'));
        return;
    }
    if (!r || r.columns.length !== state.dup.selected.length || r.columns.some((c, i) => c !== state.dup.selected[i])) {
        return;
    }
    if (r.groups.length === 0) {
        body.append(h('div', { class: 'message' }, 'No duplicate rows for these columns.'));
        return;
    }
    let text = `${fmt(r.duplicateKeys)} duplicated keys in ${fmt(r.duplicateRows)} rows`;
    if (r.truncated) {
        text += ` · showing the top ${fmt(r.groups.length)}`;
    }
    if (r.capped) {
        text += ' · key limit reached, counts may be incomplete';
    }
    body.append(h('div', { class: 'u-summary' }, text), h('div', { class: 'u-summary' }, 'Click a key to show only its rows.'));
    const results = h('div', { class: 'u-list' });
    for (const g of r.groups.slice(0, MAX_ROWS)) {
        const label = g.key.map((v) => (v === '' ? '(empty)' : v.slice(0, 200))).join(' · ');
        const row = h('button', { class: 'dup-row', title: label },
            h('span', { class: 'u-val' }, label),
            h('span', { class: 'u-count' }, `×${fmt(g.count)} · first row ${fmt(g.firstRow + 1)}`));
        row.addEventListener('click', () => {
            state.keyFilter = { columns: r.columns, values: g.key };
            state.columnFilters = {};
            applyFilters();
            emit('table');
            emit('panel');
        });
        results.append(row);
    }
    body.append(results);
}

/** Hide the columns in one layout change (one save and redraw), never hiding the last visible column. */
function hideMany(columns: number[]): void {
    mutate((l) => {
        for (const c of columns) {
            if (l.hidden.includes(c)) {
                continue;
            }
            if (visibleColumns(l).filter((v) => v !== c).length === 0) {
                break;
            }
            l.hidden.push(c);
        }
        clampPinned(l);
    });
}

function renderColumns(body: HTMLElement): void {
    if (state.analysisLoading) {
        scanning(body);
        return;
    }
    if (state.analysisError) {
        body.append(h('div', { class: 'message err' }, `Could not scan: ${state.analysisError}`));
        return;
    }
    const r = state.duplicateColumns;
    if (!r) {
        body.append(h('div', { class: 'message' }, 'The scan was cancelled. Choose "Columns" again to retry.'));
        return;
    }
    if (r.groups.length === 0 && r.emptyColumns.length === 0) {
        body.append(h('div', { class: 'message' }, 'No duplicate or empty columns.'));
        return;
    }
    for (const g of r.groups) {
        const btn = h('button', {}, 'Hide extra copies');
        btn.addEventListener('click', () => hideMany(g.slice(1)));
        body.append(h('div', { class: 'u-summary' }, `Identical columns: ${g.map(name).join(', ')}`), btn);
    }
    if (r.emptyColumns.length > 0) {
        const btn = h('button', {}, 'Hide empty columns');
        btn.addEventListener('click', () => hideMany(r.emptyColumns));
        body.append(h('div', { class: 'u-summary' }, `Empty columns: ${r.emptyColumns.map(name).join(', ')}`), btn);
    }
}
