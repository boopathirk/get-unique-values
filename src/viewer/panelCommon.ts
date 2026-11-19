import { emit } from './actions';
import { h } from './dom';
import { state } from './state';

export function closePanel(): void {
    state.panel = null;
    emit('panel');
}

export function panelHeader(title: string): HTMLElement {
    const close = h('button', { title: 'Close (Esc)', 'aria-label': 'Close panel' }, '✕');
    close.addEventListener('click', closePanel);
    return h('div', { class: 'side-head' }, h('strong', { class: 'side-title', title }, title), close);
}
