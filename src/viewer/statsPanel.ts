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
