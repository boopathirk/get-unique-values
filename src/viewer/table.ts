import { detectColumnType } from '../csv/core/columnStats';
import { columnColor } from '../csv/core/colors';
import type { ColumnColor } from '../csv/core/colors';
import { visibleColumns } from '../csv/core/layout';
import { rowToCsv, rowToJson, truncateText } from '../csv/core/textUtil';
import { applyFilters, clearColumnFilter, emit, on, saveLayout } from './actions';
import { MenuItem, h, showMenu } from './dom';
import { freezeColumnOp, hideColumn, moveColumnToFirst, setPinned } from './layoutOps';
import { post, state } from './state';

const ROWNUM_WIDTH = 72;
let wrap: HTMLElement;
let renderedPage = -1;

export function mountTable(root: HTMLElement): void {
    wrap = root;
    on('render', renderTable);
    on('table', renderTable);
    wrap.addEventListener('click', (e) => {
        const cell = cellOf(e);
        if (cell) {
            select(cell.row, cell.col);
        }
    });
    wrap.addEventListener('dblclick', (e) => {
        const cell = cellOf(e);
        if (cell) {
            emit('openDetail', { row: cell.row, col: cell.col });
        }
    });
    wrap.addEventListener('contextmenu', (e) => {
        const tr = (e.target as Element).closest('tbody tr') as HTMLElement | null;
        if (!tr) {
            return;
        }
        e.preventDefault();
        const cell = cellOf(e);
        showMenu(e.clientX, e.clientY, rowMenu(Number(tr.dataset.r), cell ? cell.col : undefined));
    });
}

function cellOf(e: Event): { row: number; col: number } | null {
    const td = (e.target as Element).closest('td.cell') as HTMLElement | null;
    return td ? { row: Number(td.dataset.r), col: Number(td.dataset.c) } : null;
}

export function select(row: number, col: number): void {
    state.selected = { row, col };
    updateSelection(true);
}

function updateSelection(scroll: boolean): void {
    wrap.querySelector('td.selected')?.classList.remove('selected');
    const sel = state.selected;
    if (!sel) {
        return;
    }
    const td = wrap.querySelector<HTMLElement>(`td.cell[data-r="${sel.row}"][data-c="${sel.col}"]`);
    td?.classList.add('selected');
    if (scroll) {
        td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
}

function rowMenu(row: number, col: number | undefined): MenuItem[] {
    const info = state.info;
    const fields = state.rows[row];
    if (!info || !fields) {
        return [];
    }
    const items: MenuItem[] = [{ label: 'View record', run: () => emit('openRecord', row) }];
    if (col !== undefined) {
        items.push(
            { label: 'Open cell detail', run: () => emit('openDetail', { row, col }) },
            { label: 'Copy cell', run: () => post({ type: 'copy', text: fields[col] ?? '' }) },
        );
    }
    items.push(
        { label: 'Copy row as CSV', run: () => post({ type: 'copy', text: rowToCsv(fields, info.delimiter) }) },
        { label: 'Copy row as JSON', run: () => post({ type: 'copy', text: rowToJson(info.header, fields) }) },
    );
    return items;
}

function headerMenu(column: number): MenuItem[] {
    const layout = state.layout;
    if (!layout) {
        return [];
    }
    const position = visibleColumns(layout).indexOf(column);
    const items: MenuItem[] = [
        { label: 'Unique values', run: () => emit('openUnique', column) },
        { label: 'Column stats', run: () => emit('openStats', column) },
        { label: 'Find duplicates', run: () => emit('openDuplicates', { mode: 'rows', columns: [column] }) },
        { label: 'Find duplicate columns', run: () => emit('openDuplicates', { mode: 'columns' }) },
        {
            label: 'Search in this column',
            run: () => {
                state.search.column = column;
                if (state.search.query !== '') {
                    applyFilters();
                }
                emit('status');
                emit('focusSearch');
            },
        },
        { label: 'Hide column', run: () => hideColumn(column) },
        { label: 'Move to first column', run: () => moveColumnToFirst(column) },
        { label: 'Freeze column (move to first and pin)', run: () => freezeColumnOp(column) },
        { label: 'Pin columns up to here', run: () => setPinned(position + 1) },
    ];
    if (layout.pinned > 0) {
        items.push({ label: 'Unpin columns', run: () => setPinned(0) });
    }
    if ((state.columnFilters[column] ?? []).length > 0) {
        items.push({ label: 'Clear filter on this column', run: () => clearColumnFilter(column) });
    }
    return items;
}

function startResize(
    e: MouseEvent,
    column: number,
    startWidth: number,
    colEl: HTMLTableColElement,
    table: HTMLElement,
    onWidth: (column: number, width: number) => void,
): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const tableStart = parseFloat(table.style.width);
    let width = startWidth;
    const move = (ev: MouseEvent): void => {
        width = Math.max(40, Math.min(2000, startWidth + ev.clientX - startX));
        colEl.style.width = `${width}px`;
        table.style.width = `${tableStart + width - startWidth}px`;
        onWidth(column, width);
    };
    const up = (): void => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (state.layout) {
            state.layout.widths[String(column)] = Math.round(width);
            saveLayout();
        }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
}

function paint(el: HTMLElement, color: ColumnColor): void {
    el.style.setProperty('--col-bg', color.headerBg);
    el.style.setProperty('--col-fg', color.headerFg);
    el.style.setProperty('--col-edge', color.edge);
}

function emptyMessage(): string {
    if (state.filterRunning) {
        return 'Searching…';
    }
    if (state.filterActive) {
        return 'No rows match the current search and filters.';
    }
    return state.complete ? 'This file has no data rows.' : 'Indexing…';
}

function renderTable(): void {
    // Keep the scroll position while re-rendering the same page; a new page starts at the top.
    const scrollTop = state.page === renderedPage ? wrap.scrollTop : 0;
    renderedPage = state.page;
    const scrollLeft = wrap.scrollLeft;
    wrap.replaceChildren();
    if (state.status) {
        wrap.append(h('div', { class: 'message' }, state.status.message));
        return;
    }
    const { info, layout, settings } = state;
    if (!info || !layout || !settings) {
        wrap.append(h('div', { class: 'message' }, 'Opening…'));
        return;
    }
    const cols = visibleColumns(layout);
    if (cols.length === 0) {
        wrap.append(h('div', { class: 'message' }, 'All columns are hidden. Use the Columns button to show some.'));
        return;
    }

    const width = (c: number): number => layout.widths[String(c)] ?? settings.defaultColumnWidth;
    const pinnedCols = cols.slice(0, layout.pinned);
    const pinned = new Set<number>(pinnedCols);
    const colored = layout.colorMode !== 'off';
    const tinted = layout.colorMode === 'headerAndCells' && state.theme !== 'high-contrast';
    const colors = new Map<number, ColumnColor>(cols.map((c): [number, ColumnColor] => [c, columnColor(c, state.theme)]));

    const table = h('table', { class: `csv longtext-${layout.longText}` });
    table.style.width = `${ROWNUM_WIDTH + cols.reduce((n, c) => n + width(c), 0)}px`;
    // Sticky offsets of pinned columns live in per-column CSS variables so a live resize can move later ones.
    const setPinnedOffsets = (resized?: number, resizedWidth = 0): void => {
        let acc = ROWNUM_WIDTH;
        for (const c of pinnedCols) {
            table.style.setProperty(`--left-${c}`, `${acc}px`);
            acc += c === resized ? resizedWidth : width(c);
        }
    };
    setPinnedOffsets();

    const colgroup = h('colgroup');
    const rowNumCol = h('col');
    rowNumCol.style.width = `${ROWNUM_WIDTH}px`;
    colgroup.append(rowNumCol);
    const colEls = new Map<number, HTMLTableColElement>();
    for (const c of cols) {
        const colEl = h('col');
        colEl.style.width = `${width(c)}px`;
        colEls.set(c, colEl);
        colgroup.append(colEl);
    }
    table.append(colgroup);

    const headRow = h('tr', {}, h('th', { class: 'rownum' }, '#'));
    for (const c of cols) {
        const name = info.header[c] ?? `Column ${c + 1}`;
        const sample = state.rows.map((r) => r[c] ?? '');
        const type = sample.length > 0 ? detectColumnType(sample) : '';
        const th = h('th', { class: `colhead${pinned.has(c) ? ' pinned' : ''}`, title: type ? `${name} (${type})` : name });
        const color = colors.get(c);
        if (colored && color) {
            paint(th, color);
        }
        const menuBtn = h('button', { class: 'menu-btn', title: 'Column menu', 'aria-label': `Menu for ${name}` }, '⋮');
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const rect = menuBtn.getBoundingClientRect();
            showMenu(rect.left, rect.bottom, headerMenu(c));
        });
        const handle = h('span', { class: 'resize' });
        const colEl = colEls.get(c);
        if (colEl) {
            handle.addEventListener('mousedown', (e) => startResize(e, c, width(c), colEl, table, setPinnedOffsets));
        }
        const filtered = (state.columnFilters[c] ?? []).length > 0;
        th.append(
            h('span', { class: 'name' }, name, filtered ? h('span', { class: 'filtered', title: 'A filter is active on this column' }, '●') : null),
            menuBtn,
            handle,
        );
        if (pinned.has(c)) {
            th.style.left = `var(--left-${c})`;
        }
        headRow.append(th);
    }
    table.append(h('thead', {}, headRow));

    const body = h('tbody');
    for (let r = 0; r < state.rows.length; r++) {
        const fields = state.rows[r];
        const tr = h('tr', { 'data-r': r }, h('td', { class: 'rownum' }, String((state.rowNumbers[r] ?? r) + 1)));
        for (const c of cols) {
            const value = fields[c] ?? '';
            const td = h('td', { class: `cell${tinted ? ' tinted' : ''}${pinned.has(c) ? ' pinned' : ''}`, 'data-r': r, 'data-c': c },
                h('div', { class: 'v' }, value));
            if (value.length > 30) {
                td.title = truncateText(value, 500);
            }
            const color = colors.get(c);
            if (tinted && color) {
                td.style.setProperty('--col-tint', color.cellTint);
                td.style.setProperty('--col-edge', color.edge);
            }
            if (pinned.has(c)) {
                td.style.left = `var(--left-${c})`;
            }
            tr.append(td);
        }
        body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    if (state.rows.length === 0) {
        wrap.append(h('div', { class: 'message' }, emptyMessage()));
    }
    wrap.scrollTop = scrollTop;
    wrap.scrollLeft = scrollLeft;
    updateSelection(false);
}
