import { visibleColumns } from '../csv/core/layout';
import { emit, goToPage } from './actions';
import { closeMenu, isMenuOpen } from './dom';
import { closePicker, isPickerOpen } from './columnPicker';
import { hideColumn, showAll } from './layoutOps';
import { closePanel } from './panelCommon';
import { state } from './state';
import { select } from './table';

function move(rowDelta: number, colDelta: number): void {
    const layout = state.layout;
    if (!layout || state.rows.length === 0) {
        return;
    }
    const cols = visibleColumns(layout);
    if (cols.length === 0) {
        return;
    }
    if (!state.selected) {
        select(0, cols[0]); // the first arrow press only picks the starting cell
        return;
    }
    const current = state.selected;
    const colIndex = Math.max(0, cols.indexOf(current.col));
    const row = Math.max(0, Math.min(state.rows.length - 1, current.row + rowDelta));
    const col = cols[Math.max(0, Math.min(cols.length - 1, colIndex + colDelta))];
    select(row, col);
}

export function mountKeyboard(): void {
    // Ctrl/Cmd+C copies the selected cell unless the user selected text or is typing in a field.
    document.addEventListener('copy', (e) => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
            return;
        }
        const sel = state.selected;
        if (!sel || window.getSelection()?.toString()) {
            return;
        }
        e.clipboardData?.setData('text/plain', state.rows[sel.row]?.[sel.col] ?? '');
        e.preventDefault();
    });

    window.addEventListener('keydown', (e) => {
        const target = e.target as HTMLElement;
        const typing = target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement
            || target.closest('button, a, [role="button"], [contenteditable="true"]') !== null;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();

        if (mod && key === 'f') {
            e.preventDefault();
            emit('focusSearch');
            return;
        }
        if (mod && e.shiftKey && key === 'h') {
            e.preventDefault();
            if (state.selected) {
                hideColumn(state.selected.col);
            }
            return;
        }
        if (mod && e.shiftKey && key === 'u') {
            e.preventDefault();
            showAll();
            return;
        }
        if (e.key === 'Escape') {
            // One layer per press: context menu, then column picker, then side panel.
            if (isMenuOpen()) {
                closeMenu();
            } else if (isPickerOpen()) {
                closePicker();
            } else if (state.panel) {
                closePanel();
            }
            return;
        }
        if (typing) {
            return;
        }
        switch (e.key) {
            case 'PageDown':
                e.preventDefault();
                goToPage(state.page + 1);
                break;
            case 'PageUp':
                e.preventDefault();
                goToPage(state.page - 1);
                break;
            case 'ArrowDown':
                e.preventDefault();
                move(1, 0);
                break;
            case 'ArrowUp':
                e.preventDefault();
                move(-1, 0);
                break;
            case 'ArrowRight':
                e.preventDefault();
                move(0, 1);
                break;
            case 'ArrowLeft':
                e.preventDefault();
                move(0, -1);
                break;
            case 'Enter':
                if (state.selected) {
                    e.preventDefault();
                    if (e.shiftKey) {
                        emit('openRecord', state.selected.row);
                    } else {
                        emit('openDetail', { row: state.selected.row, col: state.selected.col });
                    }
                }
                break;
        }
    });
}
