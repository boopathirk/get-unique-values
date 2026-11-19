import { emit, on } from './actions';
import { renderDetail, renderRecord } from './detailPanel';
import { renderDuplicates, openDuplicates } from './duplicatesPanel';
import { state } from './state';
import { openStats, renderStats } from './statsPanel';
import { openUnique, renderUnique } from './uniquePanel';

export function mountSidePanel(root: HTMLElement): void {
    const render = (): void => {
        root.replaceChildren();
        const panel = state.panel;
        root.hidden = panel === null;
        if (!panel) {
            return;
        }
        switch (panel.kind) {
            case 'unique':
                renderUnique(root, panel.column);
                break;
            case 'stats':
                renderStats(root, panel.column);
                break;
            case 'duplicates':
                renderDuplicates(root, panel.column);
                break;
            case 'detail':
                renderDetail(root, panel.rowNumber, panel.col);
                break;
            case 'record':
                renderRecord(root, panel.rowNumber);
                break;
        }
    };
    on('panel', render);
    on('render', render);
    on<number>('openUnique', openUnique);
    on<number>('openStats', openStats);
    on<number>('openDuplicates', openDuplicates);
    on<{ row: number; col: number }>('openDetail', ({ row, col }) => {
        state.panel = { kind: 'detail', rowNumber: state.rowNumbers[row] ?? row, col };
        emit('panel');
    });
    on<number>('openRecord', (row) => {
        state.panel = { kind: 'record', rowNumber: state.rowNumbers[row] ?? row };
        emit('panel');
    });
}
