import { PAGE_SIZES } from '../csv/core/layout';
import type { ColorMode, LongText } from '../csv/core/layout';
import { applyFilters, emit, goToPage, on, totalPages } from './actions';
import { fmt, h } from './dom';
import { resetLayout, setColorMode, setLongText, setPageSize } from './layoutOps';
import { post, state } from './state';

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const el = h('button', { title, 'aria-label': title }, label);
    el.addEventListener('click', onClick);
    return el;
}

function select(options: Array<[string, string]>, onChange: (value: string) => void, title: string): HTMLSelectElement {
    const el = h('select', { title, 'aria-label': title });
    for (const [value, label] of options) {
        el.append(h('option', { value }, label));
    }
    el.addEventListener('change', () => onChange(el.value));
    return el;
}

const DELIMITER_NAMES: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

export function mountToolbar(root: HTMLElement): { searchRow: HTMLElement } {
    const searchRow = h('div', { class: 'row' });

    const parseChip = h('button', { class: 'chip', title: 'Delimiter · header · encoding. Click to change.' });
    parseChip.addEventListener('click', () => post({ type: 'chooseParseOptions' }));

    const first = button('⏮', 'First page', () => goToPage(0));
    const prev = button('◀', 'Previous page', () => goToPage(state.page - 1));
    const pageInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Page number' });
    pageInput.addEventListener('keydown', (e) => {
        const n = parseInt(pageInput.value, 10);
        if (e.key === 'Enter' && Number.isFinite(n)) {
            goToPage(n - 1);
        }
    });
    const pageTotal = h('span', { class: 'muted' });
    const next = button('▶', 'Next page', () => goToPage(state.page + 1));
    const last = button('⏭', 'Last page', () => goToPage(totalPages() - 1));

    const rowInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', placeholder: 'row #', 'aria-label': 'Go to row number' });
    rowInput.addEventListener('keydown', (e) => {
        const n = parseInt(rowInput.value, 10);
        if (e.key === 'Enter' && Number.isFinite(n) && n >= 1) {
            goToPage(Math.floor((n - 1) / (state.layout?.pageSize ?? 100)));
        }
    });

    const sizeSelect = select(PAGE_SIZES.map((n): [string, string] => [String(n), `${n} / page`]), (v) => setPageSize(Number(v)), 'Rows per page');
    const textSelect = select(
        [['truncate', 'Truncate long text'], ['wrap', 'Wrap (3 lines)'], ['full', 'Show full text']],
        (v) => setLongText(v as LongText),
        'How to show long cell values',
    );
    const colorSelect = select(
        [['headerAndCells', 'Colours: header + cells'], ['header', 'Colours: header only'], ['off', 'Colours: off']],
        (v) => setColorMode(v as ColorMode),
        'Column colours',
    );
    const columnsBtn = h('button', { 'data-picker-anchor': true, title: 'Show, hide, reorder and pin columns' }, 'Columns');
    columnsBtn.addEventListener('click', () => emit('toggleColumns', columnsBtn));
    const resetBtn = button('Reset view', 'Restore default columns, widths and display options', resetLayout);

    root.append(
        searchRow,
        h('div', { class: 'row' },
            parseChip, first, prev, pageInput, pageTotal, next, last, rowInput,
            sizeSelect, textSelect, colorSelect, columnsBtn, resetBtn),
    );

    const update = (): void => {
        const { info, layout } = state;
        const ready = info !== null && layout !== null;
        for (const el of [parseChip, first, prev, pageInput, next, last, rowInput, sizeSelect, textSelect, colorSelect, columnsBtn, resetBtn]) {
            (el as HTMLButtonElement).disabled = !ready;
        }
        if (!info || !layout) {
            parseChip.textContent = '…';
            return;
        }
        const delimiter = DELIMITER_NAMES[info.delimiter] ?? `"${info.delimiter}"`;
        parseChip.textContent = `${delimiter} · ${info.hasHeader ? 'header' : 'no header'} · ${info.encoding}`;
        if (document.activeElement !== pageInput) {
            pageInput.value = String(state.page + 1);
        }
        pageTotal.textContent = `/ ${fmt(totalPages())}${state.complete ? '' : '+'}`;
        first.disabled = prev.disabled = state.page === 0;
        next.disabled = state.complete && state.page >= totalPages() - 1;
        last.disabled = !state.complete || state.page >= totalPages() - 1;
        sizeSelect.value = String(layout.pageSize);
        textSelect.value = layout.longText;
        colorSelect.value = layout.colorMode;
        columnsBtn.textContent = layout.hidden.length > 0 ? `Columns (${layout.hidden.length} hidden)` : 'Columns';
    };
    on('render', update);
    on('table', update);
    on('status', update);

    return { searchRow };
}

export function mountStatus(root: HTMLElement): void {
    const bar = h('div', { class: 'progress' });
    const text = h('span', {});
    const bad = h('button', { class: 'link', title: 'Show only rows whose column count differs from the first row' });
    bad.addEventListener('click', () => {
        state.badRowsOnly = !state.badRowsOnly;
        applyFilters();
    });
    const warning = h('span', {});
    const name = h('span', {});
    root.append(bar, text, bad, warning, h('span', { class: 'spacer' }), name);

    const update = (): void => {
        const { info, layout, indexing } = state;
        name.textContent = state.fileName;
        if (!info || !layout) {
            text.textContent = state.status ? '' : 'Opening…';
            bad.hidden = true;
            warning.textContent = '';
            bar.style.width = '0';
            return;
        }
        const indexingNow = indexing !== null && !indexing.done;
        bar.style.width = indexingNow ? `${Math.min(100, (indexing.bytes / Math.max(1, indexing.total)) * 100)}%` : '0';

        const parts: string[] = [];
        if (state.filterActive) {
            const suffix = state.filterRunning ? ' so far…' : state.filterComplete ? '' : ' (partial)';
            parts.push(`${fmt(state.total)} ${state.total === 1 ? 'match' : 'matches'}${suffix} of ${fmt(state.totalRows)} rows`);
        } else {
            parts.push(`${fmt(state.totalRows || state.total)} rows${indexingNow ? ' (indexing…)' : ''}`);
        }
        parts.push(`${fmt(info.columnCount)} columns`);
        if (state.rows.length > 0) {
            const start = state.page * layout.pageSize;
            parts.push(`showing ${fmt(start + 1)}–${fmt(start + state.rows.length)}`);
        }
        text.textContent = parts.join(' · ');

        const badCount = indexing?.badRows ?? 0;
        bad.hidden = badCount === 0;
        bad.textContent = state.badRowsOnly
            ? `⚠ ${fmt(badCount)} bad rows (click to show all)`
            : `⚠ ${fmt(badCount)} ${badCount === 1 ? 'row' : 'rows'} with a wrong column count`;

        const warnings = indexing?.warnings ?? [];
        if (warnings.length > 0) {
            const row = Math.max(1, warnings[0].row - (info.hasHeader ? 1 : 0) + 1);
            warning.textContent = `⚠ ${warnings.length} unclosed quote${warnings.length === 1 ? '' : 's'} recovered (first near row ${fmt(row)})`;
        } else {
            warning.textContent = '';
        }
    };
    on('status', update);
    on('table', update);
    on('render', update);
}
