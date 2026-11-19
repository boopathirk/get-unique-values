type Child = Node | string | null | undefined | false;

/**
 * Tiny element factory. Strings become text nodes (never HTML).
 * Do NOT pass a `style` prop: inline style attributes are blocked by the CSP. Use el.style.x = ... instead.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, unknown> = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) {
            continue;
        }
        if (key === 'class') {
            el.className = String(value);
        } else if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2), value as EventListener);
        } else if (key === 'value') {
            (el as unknown as HTMLInputElement).value = String(value);
        } else if (key === 'checked') {
            (el as unknown as HTMLInputElement).checked = Boolean(value);
        } else {
            el.setAttribute(key, value === true ? '' : String(value));
        }
    }
    for (const child of children) {
        if (child !== null && child !== undefined && child !== false) {
            el.append(child);
        }
    }
    return el;
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
    let timer: number | undefined;
    return (...args: A) => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => fn(...args), ms);
    };
}

export function fmt(n: number): string {
    return n.toLocaleString('en-US');
}

export interface MenuItem {
    label: string;
    run: () => void;
    disabled?: boolean;
}

export function closeMenu(): void {
    document.getElementById('ctx-menu')?.remove();
}

export function showMenu(x: number, y: number, items: MenuItem[]): void {
    closeMenu();
    const menu = h('div', { class: 'menu', id: 'ctx-menu', role: 'menu' });
    for (const item of items) {
        const button = h('button', { class: 'menu-item', role: 'menuitem', disabled: item.disabled }, item.label);
        button.addEventListener('click', () => {
            closeMenu();
            item.run();
        });
        menu.append(button);
    }
    document.body.append(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 4))}px`;
}

window.addEventListener('mousedown', (e) => {
    if (!(e.target as Element).closest('.menu')) {
        closeMenu();
    }
}, true);
window.addEventListener('blur', closeMenu);
