import type { ThemeKind } from '../csv/core/colors';
import type { HostToView, ViewCommand } from '../csv/protocol';
import { applyFilters, clearAllFilters, emit, loadPage, requestExport } from './actions';
import { mountBanner } from './banner';
import { closePicker, mountColumnPicker } from './columnPicker';
import { h } from './dom';
import { mountKeyboard } from './keyboard';
import {
    applyNonEmpty, applySet, deleteSet, freezeColumnOp, hideColumn, moveColumnToFirst, requestHideEmpty, saveSet, showAll,
} from './layoutOps';
import { mountSearch } from './searchBar';
import { mountSidePanel } from './sidePanel';
import { post, resetForNewFile, state } from './state';
import { mountSummary } from './summary';
import { mountTable } from './table';
import { mountStatus, mountToolbar } from './toolbar';

function detectTheme(): ThemeKind {
    const classes = document.body.classList;
    if (classes.contains('vscode-high-contrast') || classes.contains('vscode-high-contrast-light')) {
        return 'high-contrast';
    }
    return classes.contains('vscode-light') ? 'light' : 'dark';
}

function applyTheme(): void {
    const next = detectTheme();
    document.body.classList.toggle('hc', next === 'high-contrast');
    if (next !== state.theme) {
        state.theme = next;
        emit('table');
    }
}

const app = document.getElementById('app');
if (!app) {
    throw new Error('#app element not found');
}
const toolbarEl = h('div', { class: 'toolbar' });
const bannerEl = h('div', { class: 'banner', hidden: true });
const tableEl = h('div', { class: 'table-wrap', tabindex: '0' });
const sideEl = h('aside', { class: 'side', hidden: true });
const statusEl = h('div', { class: 'status' });
app.append(toolbarEl, bannerEl, h('div', { class: 'main' }, tableEl, sideEl), statusEl);

applyTheme();
const { searchRow } = mountToolbar(toolbarEl);
mountBanner(bannerEl);
mountTable(tableEl);
mountStatus(statusEl);
mountSearch(searchRow);
mountSidePanel(sideEl);
mountColumnPicker();
mountKeyboard();
mountSummary();

new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

/** A column number sent by the host, or null when it is not a non-negative integer. */
function columnArg(arg: string | undefined): number | null {
    const n = Number(arg);
    return arg !== undefined && arg.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : null;
}

function runCommand(name: ViewCommand, arg: string | undefined): void {
    if (!state.info || !state.layout) {
        return; // no file shown (yet): every command is a no-op, as before
    }
    switch (name) {
        case 'hideSelectedColumn':
            if (state.selected) {
                hideColumn(state.selected.col);
            }
            break;
        case 'showAllColumns':
            showAll();
            break;
        case 'export':
            requestExport();
            break;
        case 'toggleBadRows':
            state.badRowsOnly = !state.badRowsOnly;
            applyFilters();
            break;
        case 'clearFilters':
            clearAllFilters();
            break;
        case 'hideEmptyColumns':
            requestHideEmpty();
            break;
        case 'applySet':
            applySet(arg ?? '');
            break;
        case 'saveSet':
            saveSet(arg ?? '');
            break;
        case 'deleteSet':
            deleteSet(arg ?? '');
            break;
        case 'duplicateRows':
            emit('openDuplicates', { mode: 'rows', columns: [] });
            break;
        case 'duplicateColumns':
            emit('openDuplicates', { mode: 'columns' });
            break;
        case 'moveToFirst':
        case 'freezeColumn': {
            const column = columnArg(arg);
            if (column !== null) {
                (name === 'moveToFirst' ? moveColumnToFirst : freezeColumnOp)(column);
            }
            break;
        }
    }
}

window.addEventListener('message', (event: MessageEvent<HostToView>) => {
    const m = event.data;
    switch (m.type) {
        case 'opened':
            closePicker();
            resetForNewFile();
            state.fileName = m.fileName;
            state.info = m.info;
            state.layout = m.layout;
            state.settings = m.settings;
            loadPage(0);
            emit('render');
            break;
        case 'status':
            state.info = null;
            state.status = { kind: m.kind, message: m.message };
            emit('render');
            break;
        case 'error':
            state.banner = { kind: 'error', message: m.message, retry: m.retry };
            emit('status');
            break;
        case 'indexProgress': {
            state.indexing = m.progress;
            state.totalRows = m.progress.rows;
            const pageSize = state.layout?.pageSize ?? 0;
            if (!state.filterActive && state.layout && (state.rows.length < pageSize || m.progress.done)) {
                loadPage();
            }
            emit('status');
            break;
        }
        case 'page': {
            if (m.reqId !== state.pageReq) {
                break;
            }
            state.rows = m.result.rows;
            state.rowNumbers = m.result.rowNumbers;
            state.total = m.result.total;
            state.complete = m.result.complete;
            if (!state.filterActive) {
                state.totalRows = Math.max(state.totalRows, m.result.total);
            }
            if (state.selected && state.selected.row >= state.rows.length) {
                state.selected = null;
            }
            emit('table');
            break;
        }
        case 'filterProgress':
            if (m.jobId === state.filterJob) {
                state.filtering = m.progress;
                if (state.rows.length < (state.layout?.pageSize ?? 0)) {
                    loadPage();
                }
                emit('status');
            }
            break;
        case 'filterDone':
            if (m.jobId === state.filterJob) {
                state.filterRunning = false;
                state.filtering = null;
                state.filterComplete = m.result.complete;
                loadPage(state.page);
                emit('status');
            }
            break;
        case 'filterError':
            if (m.jobId === state.filterJob) {
                state.filterRunning = false;
                state.filtering = null;
                state.filterError = m.message;
                emit('status');
            }
            break;
        case 'unique':
            if (m.jobId === state.uniqueJob) {
                state.unique = m.result;
                state.uniqueLoading = false;
                state.uniqueError = m.error ?? '';
                emit('panel');
            }
            break;
        case 'stats':
            if (m.jobId === state.analysisJob) {
                state.stats = m.result;
                state.analysisLoading = false;
                state.analysisError = m.error ?? '';
                emit('panel');
            }
            break;
        case 'duplicates':
            if (m.jobId === state.analysisJob) {
                state.duplicates = m.result;
                state.analysisLoading = false;
                state.analysisError = m.error ?? '';
                emit('panel');
            }
            break;
        case 'duplicateColumns':
            if (m.jobId === state.analysisJob) {
                state.duplicateColumns = m.result;
                state.analysisLoading = false;
                state.analysisError = m.error ?? '';
                emit('panel');
            }
            break;
        case 'nonEmpty':
            if (m.jobId === state.nonEmptyJob) {
                applyNonEmpty(m.columns);
            }
            break;
        case 'command':
            runCommand(m.name, m.arg);
            break;
        case 'fileChanged':
            state.banner = {
                kind: 'info',
                message: m.deleted ? 'The file was deleted from disk. What you see is the last loaded data.' : 'The file changed on disk.',
                reload: !m.deleted,
            };
            emit('status');
            break;
    }
});

post({ type: 'ready' });
