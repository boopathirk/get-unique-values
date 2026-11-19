import { applyFilters, clearAllFilters, clearColumnFilter, on } from './actions';
import { debounce, fmt, h } from './dom';
import { post, state } from './state';

type ToggleKey = 'caseSensitive' | 'wholeCell' | 'regex';

export function mountSearch(root: HTMLElement): void {
    const input = h('input', { class: 'search', type: 'search', placeholder: 'Search…  (Ctrl+F)', 'aria-label': 'Search' });
    const scope = h('select', { title: 'Search in', 'aria-label': 'Search scope' });

    const toggle = (label: string, title: string, key: ToggleKey): HTMLButtonElement => {
        const el = h('button', { class: 'toggle', title, 'aria-label': title, 'aria-pressed': 'false' }, label);
        el.addEventListener('click', () => {
            state.search[key] = !state.search[key];
            refresh();
            if (state.search.query !== '') {
                applyFilters();
            }
        });
        return el;
    };
    const caseBtn = toggle('Aa', 'Match case', 'caseSensitive');
    const wholeBtn = toggle('ab', 'Match whole cell', 'wholeCell');
    const regexBtn = toggle('.*', 'Use regular expression', 'regex');

    const progress = h('span', { class: 'muted' });
    const cancel = h('button', { title: 'Stop the running search' }, 'Cancel');
    cancel.addEventListener('click', () => post({ type: 'cancel', kind: 'filter', jobId: state.filterJob }));
    const error = h('span', { class: 'err' });
    const chips = h('span', { class: 'chips' });
    const clearAll = h('button', { title: 'Remove the search and every filter' }, 'Clear all');
    clearAll.addEventListener('click', clearAllFilters);

    const runSearch = (): void => {
        state.search.query = input.value;
        applyFilters();
    };
    input.addEventListener('input', debounce(runSearch, 300));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            runSearch();
        }
    });
    scope.addEventListener('change', () => {
        state.search.column = scope.value === '' ? null : Number(scope.value);
        if (state.search.query !== '') {
            applyFilters();
        }
    });

    root.append(input, scope, caseBtn, wholeBtn, regexBtn, progress, cancel, error, chips, clearAll);

    let builtFor: unknown = null;
    const refresh = (): void => {
        const info = state.info;
        if (info !== builtFor) {
            builtFor = info;
            scope.replaceChildren(h('option', { value: '' }, 'All columns'));
            info?.header.forEach((name, i) => scope.append(h('option', { value: i }, name)));
        }
        scope.value = state.search.column === null ? '' : String(state.search.column);
        if (document.activeElement !== input) {
            input.value = state.search.query;
        }
        caseBtn.setAttribute('aria-pressed', String(state.search.caseSensitive));
        wholeBtn.setAttribute('aria-pressed', String(state.search.wholeCell));
        regexBtn.setAttribute('aria-pressed', String(state.search.regex));

        cancel.hidden = !state.filterRunning;
        const f = state.filtering;
        progress.textContent = state.filterRunning
            ? `Searching… ${f && f.total > 0 ? Math.floor((f.scanned / f.total) * 100) : 0}% · ${fmt(f?.matches ?? 0)} found`
            : '';
        error.textContent = state.filterError;

        chips.replaceChildren();
        for (const [col, values] of Object.entries(state.columnFilters)) {
            if (values.length === 0) {
                continue;
            }
            const name = state.info?.header[Number(col)] ?? `Column ${Number(col) + 1}`;
            const chip = h('button', { class: 'chip', title: 'Remove this filter' }, `${name}: ${values.length} value${values.length === 1 ? '' : 's'} ✕`);
            chip.addEventListener('click', () => clearColumnFilter(Number(col)));
            chips.append(chip);
        }
        if (state.badRowsOnly) {
            const chip = h('button', { class: 'chip', title: 'Show all rows again' }, 'Bad rows only ✕');
            chip.addEventListener('click', () => {
                state.badRowsOnly = false;
                applyFilters();
            });
            chips.append(chip);
        }
        clearAll.hidden = !state.filterActive;
    };

    on('status', refresh);
    on('render', refresh);
    on('focusSearch', () => {
        input.focus();
        input.select();
    });
    refresh();
}
