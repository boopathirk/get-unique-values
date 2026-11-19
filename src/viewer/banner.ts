import { on } from './actions';
import { h } from './dom';
import { post, state } from './state';

export function mountBanner(root: HTMLElement): void {
    const render = (): void => {
        const banner = state.banner;
        root.hidden = !banner;
        root.replaceChildren();
        if (!banner) {
            return;
        }
        root.className = `banner ${banner.kind}`;
        root.append(h('span', {}, banner.message), h('span', { class: 'spacer' }));
        if (banner.retry) {
            const retry = h('button', { class: 'primary', title: 'Restart the background worker and reopen the file' }, 'Retry');
            retry.addEventListener('click', () => post({ type: 'retry' }));
            root.append(retry);
        }
        if (banner.reload) {
            const reload = h('button', { class: 'primary' }, 'Reload');
            reload.addEventListener('click', () => post({ type: 'reload' }));
            root.append(reload);
        }
        const dismiss = h('button', { title: 'Dismiss', 'aria-label': 'Dismiss' }, '✕');
        dismiss.addEventListener('click', () => {
            state.banner = null;
            render();
        });
        root.append(dismiss);
    };
    on('status', render);
    on('render', render);
}
