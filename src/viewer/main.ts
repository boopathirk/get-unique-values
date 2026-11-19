import type { ThemeKind } from '../csv/core/colors';
import type { HostToView } from '../csv/protocol';
import { emit, loadPage, requestExport } from './actions';
import { mountBanner } from './banner';
import { closePicker, mountColumnPicker } from './columnPicker';
import { h } from './dom';
import { mountKeyboard } from './keyboard';
import { applyNonEmpty, hideColumn, showAll } from './layoutOps';
import { mountSearch } from './searchBar';
import { mountSidePanel } from './sidePanel';
import { post, resetForNewFile, state } from './state';
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

new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

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
            if (m.name === 'hideSelectedColumn') {
                if (state.selected) {
                    hideColumn(state.selected.col);
                }
            } else if (m.name === 'export') {
                requestExport();
            } else {
                showAll();
            }
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
