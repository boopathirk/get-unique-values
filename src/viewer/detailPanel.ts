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
