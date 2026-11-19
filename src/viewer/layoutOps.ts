import { defaultLayout, visibleColumns } from '../csv/core/layout';
import type { ColorMode, Layout, LongText } from '../csv/core/layout';
import { loadPage, saveLayout } from './actions';
import { state } from './state';

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
