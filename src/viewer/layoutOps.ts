import { defaultLayout, freezeColumn, matchColumns, moveItem, moveToFirst, visibleColumns } from '../csv/core/layout';
import type { ColorMode, Layout, LongText } from '../csv/core/layout';
import { emit, loadPage, saveLayout } from './actions';
import { post, showInfo, state } from './state';

export function mutate(fn: (layout: Layout) => void): void {
    if (state.layout) {
        fn(state.layout);
        saveLayout();
    }
}

export function clampPinned(layout: Layout): void {
    layout.pinned = Math.min(layout.pinned, visibleColumns(layout).length);
}

export function hideColumn(column: number): void {
    mutate((l) => {
        if (!l.hidden.includes(column)) {
            l.hidden.push(column);
        }
        clampPinned(l);
    });
}

export function setPinned(count: number): void {
    mutate((l) => {
        l.pinned = Math.max(0, Math.min(count, visibleColumns(l).length));
    });
}

export function setPageSize(size: number): void {
    mutate((l) => {
        l.pageSize = size;
    });
    loadPage(0);
}

export function setLongText(value: LongText): void {
    mutate((l) => {
        l.longText = value;
    });
}

export function setColorMode(value: ColorMode): void {
    mutate((l) => {
        l.colorMode = value;
    });
}

export function resetLayout(): void {
    const { info, settings, layout } = state;
    if (!info || !settings || !layout) {
        return;
    }
    state.layout = {
        ...defaultLayout(info.columnCount, {
            pageSize: settings.defaultPageSize,
            longText: settings.longText,
            colorMode: settings.columnColors,
        }),
        sets: layout.sets,
    };
    saveLayout();
    loadPage(0);
}

export function toggleColumn(column: number): void {
    mutate((l) => {
        const i = l.hidden.indexOf(column);
        if (i >= 0) {
            l.hidden.splice(i, 1);
        } else {
            l.hidden.push(column);
        }
        clampPinned(l);
    });
}

export function showAll(): void {
    mutate((l) => {
        l.hidden = [];
    });
}

export function hideAll(): void {
    mutate((l) => {
        l.hidden = l.order.slice();
        l.pinned = 0;
    });
}

export function invertHidden(): void {
    mutate((l) => {
        const hidden = new Set(l.hidden);
        l.hidden = l.order.filter((c) => !hidden.has(c));
        clampPinned(l);
    });
}

export function moveColumn(from: number, to: number): void {
    mutate((l) => {
        l.order = moveItem(l.order, from, to);
    });
}

export function moveColumnToFirst(column: number): void {
    mutate((l) => moveToFirst(l, column));
}

export function freezeColumnOp(column: number): void {
    mutate((l) => freezeColumn(l, column));
}

function notify(message: string): void {
    showInfo(message);
    emit('status');
}

function showOnly(keep: Set<number>): void {
    if (!state.layout || !state.layout.order.some((c) => keep.has(c))) {
        notify('No columns match.');
        return;
    }
    mutate((l) => {
        l.hidden = l.order.filter((c) => !keep.has(c));
        clampPinned(l);
    });
}

/** Show only columns whose name matches the pattern (regex, case-insensitive). */
export function showOnlyMatching(pattern: string): void {
    const info = state.info;
    if (info && pattern.trim() !== '') {
        showOnly(new Set(matchColumns(info.header, pattern)));
    }
}

/** Show only columns that have a column filter or are the search column. */
export function showOnlyFiltered(): void {
    const keep = new Set<number>(Object.keys(state.columnFilters).map(Number));
    if (state.search.column !== null) {
        keep.add(state.search.column);
    }
    showOnly(keep);
}

/** Ask the worker which columns contain data; the reply is handled by `applyNonEmpty`. */
export function requestHideEmpty(): void {
    state.nonEmptyJob++;
    post({ type: 'nonEmpty', jobId: state.nonEmptyJob });
}

/** Hide only the empty columns; columns the user already hid stay hidden. */
export function applyNonEmpty(columns: number[] | null): void {
    const layout = state.layout;
    if (!columns || !layout) {
        return;
    }
    const keep = new Set(columns);
    const hidden = new Set(layout.hidden);
    for (const c of layout.order) {
        if (!keep.has(c)) {
            hidden.add(c);
        }
    }
    if (layout.order.every((c) => hidden.has(c))) {
        notify('Every column would be hidden, so nothing was changed.');
        return;
    }
    mutate((l) => {
        l.hidden = l.order.filter((c) => hidden.has(c));
        clampPinned(l);
    });
}

export function saveSet(name: string): void {
    const trimmed = name.trim();
    if (trimmed === '') {
        return;
    }
    mutate((l) => {
        l.sets[trimmed] = { hidden: l.hidden.slice(), order: l.order.slice() };
    });
}

export function applySet(name: string): void {
    mutate((l) => {
        const set = l.sets[name];
        if (set) {
            l.hidden = set.hidden.slice();
            l.order = set.order.slice();
            clampPinned(l);
        }
    });
}

export function deleteSet(name: string): void {
    mutate((l) => {
        delete l.sets[name];
    });
}
