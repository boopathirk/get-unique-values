import { truncateText } from '../csv/core/textUtil';
import type { UniqueEntry, UniqueResult } from '../csv/types';
import { applyFilters, emit } from './actions';
import { debounce, fmt, h } from './dom';
import { panelHeader } from './panelCommon';
import { post, state } from './state';

const MAX_ROWS = 500;
let sortBy: 'count' | 'value' = 'count';
let needle = '';

export function openUnique(column: number): void {
    state.panel = { kind: 'unique', column };
    state.unique = null;
    state.uniqueLoading = true;
    state.uniqueJob++;
    needle = '';
    post({ type: 'unique', jobId: state.uniqueJob, column });
    emit('panel');
}

export function renderUnique(root: HTMLElement, column: number): void {
    const name = state.info?.header[column] ?? `Column ${column + 1}`;
    root.append(panelHeader(`Unique values: ${name}`));
    const body = h('div', { class: 'side-body' });
    root.append(body);

    const result = state.unique;
    if (state.uniqueLoading) {
        const cancel = h('button', {}, 'Cancel');
        cancel.addEventListener('click', () => post({ type: 'cancel', jobId: state.uniqueJob }));
        body.append(h('div', { class: 'message' }, 'Scanning the column…'), cancel);
        return;
    }
    if (!result || result.column !== column) {
        body.append(h('div', { class: 'message' }, 'The scan was cancelled. Choose "Unique values" again to retry.'));
        return;
    }
    body.append(...buildList(result, column));
}

function buildList(result: UniqueResult, column: number): HTMLElement[] {
    const list = h('div', { class: 'u-list' });
    const summary = h('div', { class: 'u-summary' });
    const filterInput = h('input', { type: 'search', placeholder: 'Filter values…', 'aria-label': 'Filter values' });
    const sortLabel = (): string => (sortBy === 'count' ? 'Sort: count' : 'Sort: value');
    const sortBtn = h('button', { title: 'Change the sort order' }, sortLabel());
    const clearBtn = h('button', { title: 'Remove the filter on this column' }, 'Clear selection');

    let matches = 0;
    const refreshSummary = (): void => {
        const selected = (state.columnFilters[column] ?? []).length;
        let text = `${fmt(result.distinct)} distinct values`;
        if (result.truncated) {
            text += ` (top ${fmt(result.entries.length)} by count)`;
        }
        if (matches > MAX_ROWS) {
            text += ` · showing ${MAX_ROWS} of ${fmt(matches)} matches, type to narrow`;
        }
        if (selected > 0) {
            text += ` · ${selected} selected`;
        }
        summary.textContent = text;
    };

    const toggle = (value: string, checked: boolean): void => {
        const set = new Set(state.columnFilters[column] ?? []);
        if (checked) {
            set.add(value);
        } else {
            set.delete(value);
        }
        if (set.size > 0) {
            state.columnFilters[column] = [...set];
        } else {
            delete state.columnFilters[column];
        }
        applyFilters();
        refreshSummary();
    };

    const row = (entry: UniqueEntry, selected: Set<string>): HTMLElement => {
        const pct = result.total > 0 ? (entry.count / result.total) * 100 : 0;
        const checkbox = h('input', { type: 'checkbox', checked: selected.has(entry.value), 'aria-label': entry.value === '' ? 'empty value' : entry.value });
        checkbox.addEventListener('change', () => toggle(entry.value, checkbox.checked));
        const label = entry.value === ''
            ? h('i', { class: 'u-empty' }, '(empty)')
            : h('span', { class: 'u-val', title: truncateText(entry.value, 500) }, truncateText(entry.value, 200));
        const bar = h('div', { class: 'u-bar' });
        bar.style.width = `${Math.min(100, pct)}%`;
        return h('label', { class: 'u-row' },
            checkbox,
            h('div', { class: 'u-label' }, bar, label),
            h('span', { class: 'u-count' }, `${fmt(entry.count)} · ${pct.toFixed(1)}%`));
    };

    const fill = (): void => {
        const selected = new Set(state.columnFilters[column] ?? []);
        const q = needle.toLowerCase();
        let entries = result.entries.filter((e) =>
            q === '' || e.value.toLowerCase().includes(q) || (e.value === '' && '(empty)'.includes(q)));
        if (sortBy === 'value') {
            entries = entries.slice().sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
        }
        matches = entries.length;
        list.replaceChildren(...entries.slice(0, MAX_ROWS).map((e) => row(e, selected)));
        refreshSummary();
    };

    filterInput.addEventListener('input', debounce(() => {
        needle = filterInput.value;
        fill();
    }, 150));
    sortBtn.addEventListener('click', () => {
        sortBy = sortBy === 'count' ? 'value' : 'count';
        sortBtn.textContent = sortLabel();
        fill();
    });
    clearBtn.addEventListener('click', () => {
        delete state.columnFilters[column];
        applyFilters();
        fill();
    });

    fill();
    return [h('div', { class: 'side-tools' }, filterInput, sortBtn, clearBtn), summary, list];
}
