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
