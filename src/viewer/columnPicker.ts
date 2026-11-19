import { columnColor } from '../csv/core/colors';
import { on } from './actions';
import { h } from './dom';
import {
    applySet, deleteSet, hideAll, invertHidden, moveColumn, requestHideEmpty, saveSet, setPinned,
    showAll, showOnlyFiltered, showOnlyMatching, toggleColumn,
} from './layoutOps';
import { state } from './state';

let popover: HTMLElement | null = null;
let refreshFn: (() => void) | null = null;

export function mountColumnPicker(): void {
    on<HTMLElement>('toggleColumns', (anchor) => (popover ? close() : open(anchor)));
    on('render', () => refreshFn?.());
    window.addEventListener('mousedown', (e) => {
        if (popover && !(e.target as Element).closest('.picker, [data-picker-anchor]')) {
            close();
        }
    }, true);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && popover) {
            close();
        }
    });
}

function close(): void {
    popover?.remove();
    popover = null;
    refreshFn = null;
}

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const el = h('button', { title }, label);
    el.addEventListener('click', onClick);
    return el;
}

function open(anchor: HTMLElement): void {
    if (!state.layout || !state.info) {
        return;
    }
    const pop = h('div', { class: 'picker', role: 'dialog', 'aria-label': 'Columns' });
    const rect = anchor.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 350))}px`;

    let filterText = '';
    let dragFrom = -1;

    const finder = h('input', { type: 'search', placeholder: 'Find column…', 'aria-label': 'Find column' });
    const count = h('span', { class: 'muted' });
    finder.addEventListener('input', () => {
        filterText = finder.value.toLowerCase();
        refresh();
    });

    const matchInput = h('input', { type: 'text', placeholder: 'Show only names matching (regex)…', 'aria-label': 'Name pattern' });
    const matchBtn = button('Apply', 'Show only columns whose name matches', () => showOnlyMatching(matchInput.value));
    matchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            showOnlyMatching(matchInput.value);
        }
    });

    const list = h('div', { class: 'picker-list' });

    const pinInput = h('input', { class: 'page-input', type: 'text', inputmode: 'numeric', 'aria-label': 'Pinned column count' });
    const pinApply = (): void => {
        const n = parseInt(pinInput.value, 10);
        if (Number.isFinite(n)) {
            setPinned(n);
        }
    };
    pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            pinApply();
        }
    });
    pinInput.addEventListener('change', pinApply);

    const setSelect = h('select', { 'aria-label': 'Saved column sets' });
    const setName = h('input', { type: 'text', placeholder: 'Set name…', 'aria-label': 'New column set name' });

    pop.append(
        h('div', { class: 'row' }, finder, count),
        h('div', { class: 'row' },
            button('Show all', 'Show every column', showAll),
            button('Hide all', 'Hide every column', hideAll),
            button('Invert', 'Swap shown and hidden columns', invertHidden),
            button('Hide empty', 'Hide columns that have no values (scans the file)', requestHideEmpty),
            button('Only filtered', 'Show only columns with a filter or the search column', showOnlyFiltered)),
        h('div', { class: 'row' }, matchInput, matchBtn),
        list,
        h('div', { class: 'row' }, 'Pin first', pinInput, 'visible columns'),
        h('div', { class: 'row' },
            setSelect,
            button('Apply', 'Apply the selected set', () => setSelect.value && applySet(setSelect.value)),
            button('Delete', 'Delete the selected set', () => setSelect.value && deleteSet(setSelect.value))),
        h('div', { class: 'row' },
            setName,
            button('Save as set', 'Save the current visible/hidden columns and order', () => {
                saveSet(setName.value);
                setName.value = '';
            })),
    );

    function refresh(): void {
        const { layout, info } = state;
        if (!layout || !info) {
            return;
        }
        const hidden = new Set(layout.hidden);
        count.textContent = `${layout.order.length - hidden.size} of ${layout.order.length} shown`;
        if (document.activeElement !== pinInput) {
            pinInput.value = String(layout.pinned);
        }

        const previous = setSelect.value;
        setSelect.replaceChildren(h('option', { value: '' }, '— saved sets —'));
        for (const name of Object.keys(layout.sets)) {
            setSelect.append(h('option', { value: name }, name));
        }
        setSelect.value = previous in layout.sets ? previous : '';

        list.replaceChildren();
        layout.order.forEach((c, position) => {
            const name = info.header[c] ?? `Column ${c + 1}`;
            if (filterText !== '' && !name.toLowerCase().includes(filterText)) {
                return;
            }
            const checkbox = h('input', { type: 'checkbox', checked: !hidden.has(c), 'aria-label': `Show ${name}` });
            checkbox.addEventListener('change', () => toggleColumn(c));
            const dot = h('span', { class: 'dot' });
            dot.style.background = columnColor(c, state.theme).edge;
            const item = h('div', { class: `picker-item${hidden.has(c) ? ' hidden-col' : ''}`, draggable: 'true' },
                h('span', { class: 'handle', title: 'Drag to reorder' }, '⠿'), checkbox, dot, h('span', { class: 'pname', title: name }, name));
            item.addEventListener('dragstart', (e) => {
                dragFrom = position;
                e.dataTransfer?.setData('text/plain', String(c));
                item.classList.add('dragging');
            });
            item.addEventListener('dragend', () => item.classList.remove('dragging'));
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                item.classList.add('drop-target');
            });
            item.addEventListener('dragleave', () => item.classList.remove('drop-target'));
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drop-target');
                if (dragFrom >= 0 && dragFrom !== position) {
                    moveColumn(dragFrom, position);
                }
                dragFrom = -1;
            });
            list.append(item);
        });
    }

    document.body.append(pop);
    popover = pop;
    refreshFn = refresh;
    refresh();
    finder.focus();
}
