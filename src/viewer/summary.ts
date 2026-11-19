import type { FileSummary } from '../csv/types';
import { on } from './actions';
import { debounce } from './dom';
import { post, state } from './state';

export function buildSummary(): FileSummary | null {
    const { info, layout } = state;
    if (!info || !layout) {
        return null;
    }
    return {
        fileName: state.fileName,
        rows: state.totalRows,
        indexing: state.indexing !== null && !state.indexing.done,
        columns: info.columnCount,
        header: info.header,
        delimiter: info.delimiter,
        hasHeader: info.hasHeader,
        encoding: info.encoding,
        badRows: state.indexing?.badRows ?? 0,
        hiddenColumns: layout.hidden.length,
        filterActive: state.filterActive,
        matches: state.total,
        sets: Object.keys(layout.sets),
    };
}

/** Report the summary to the host (for the sidebar), at most every 200 ms. */
export function mountSummary(): void {
    const send = debounce(() => {
        const summary = buildSummary();
        if (summary) {
            post({ type: 'summary', summary });
        }
    }, 200);
    // 'table' follows a page reply, which carries the match count after a filter finishes.
    for (const event of ['status', 'render', 'panel', 'table']) {
        on(event, send);
    }
}
