export type LongText = 'truncate' | 'wrap' | 'full';
export type ColorMode = 'header' | 'headerAndCells' | 'off';

export interface ColumnSet {
    hidden: number[];
    order: number[];
}

export interface Layout {
    hidden: number[];
    order: number[];
    widths: Record<string, number>;
    pinned: number;
    pageSize: number;
    longText: LongText;
    colorMode: ColorMode;
    sets: Record<string, ColumnSet>;
}

export interface LayoutDefaults {
    pageSize: number;
    longText: LongText;
    colorMode: ColorMode;
}

export const PAGE_SIZES = [50, 100, 250, 500, 1000];

export function headerHash(header: string[]): string {
    let h = 0x811c9dc5;
    for (const ch of header.join('\u0001')) {
        h ^= ch.codePointAt(0) ?? 0;
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

export function defaultLayout(columnCount: number, d: LayoutDefaults): Layout {
    return {
        hidden: [],
        order: Array.from({ length: columnCount }, (_, i) => i),
        widths: {},
        pinned: 0,
        pageSize: d.pageSize,
        longText: d.longText,
        colorMode: d.colorMode,
        sets: {},
    };
}

function ints(v: unknown, max: number): number[] {
    if (!Array.isArray(v)) {
        return [];
    }
    return [...new Set(v.filter((x): x is number => Number.isInteger(x) && x >= 0 && x < max))];
}

function isPermutation(v: unknown, n: number): v is number[] {
    return Array.isArray(v)
        && v.length === n
        && new Set(v).size === n
        && v.every((x) => Number.isInteger(x) && x >= 0 && x < n);
}

function pick<T>(v: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(v as T) ? (v as T) : fallback;
}

export function sanitizeLayout(saved: unknown, columnCount: number, d: LayoutDefaults): Layout {
    const base = defaultLayout(columnCount, d);
    if (typeof saved !== 'object' || saved === null) {
        return base;
    }
    const s = saved as Record<string, unknown>;

    const widths: Record<string, number> = {};
    if (typeof s.widths === 'object' && s.widths !== null) {
        for (const [k, v] of Object.entries(s.widths)) {
            const col = Number(k);
            if (Number.isInteger(col) && col >= 0 && col < columnCount && typeof v === 'number' && v >= 40 && v <= 2000) {
                widths[k] = v;
            }
        }
    }

    const sets: Record<string, ColumnSet> = {};
    if (typeof s.sets === 'object' && s.sets !== null) {
        for (const [name, v] of Object.entries(s.sets)) {
            const set = v as Record<string, unknown> | null;
            if (set && isPermutation(set.order, columnCount)) {
                sets[name] = { hidden: ints(set.hidden, columnCount), order: set.order };
            }
        }
    }

    const pinned = typeof s.pinned === 'number' && Number.isInteger(s.pinned) && s.pinned >= 0 && s.pinned <= columnCount ? s.pinned : 0;

    return {
        hidden: ints(s.hidden, columnCount),
        order: isPermutation(s.order, columnCount) ? s.order : base.order,
        widths,
        pinned,
        pageSize: pick(s.pageSize, PAGE_SIZES, d.pageSize),
        longText: pick<LongText>(s.longText, ['truncate', 'wrap', 'full'], d.longText),
        colorMode: pick<ColorMode>(s.colorMode, ['header', 'headerAndCells', 'off'], d.colorMode),
        sets,
    };
}

export function visibleColumns(l: Layout): number[] {
    const hidden = new Set(l.hidden);
    return l.order.filter((c) => !hidden.has(c));
}

export function moveItem(order: number[], from: number, to: number): number[] {
    const next = order.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
}

export function matchColumns(header: string[], pattern: string): number[] {
    let test: (s: string) => boolean;
    try {
        const re = new RegExp(pattern, 'i');
        test = (s) => re.test(s);
    } catch {
        const q = pattern.toLowerCase();
        test = (s) => s.toLowerCase().includes(q);
    }
    return header.flatMap((name, i) => (test(name) ? [i] : []));
}

/** Put `column` first in the column order. */
export function moveToFirst(l: Layout, column: number): void {
    const i = l.order.indexOf(column);
    if (i > 0) {
        l.order = moveItem(l.order, i, 0);
    }
}

/** Move `column` to the front and keep it (and any columns already pinned) frozen while scrolling sideways. */
export function freezeColumn(l: Layout, column: number): void {
    const visible = visibleColumns(l);
    const alreadyPinned = visible.indexOf(column) !== -1 && visible.indexOf(column) < l.pinned;
    moveToFirst(l, column);
    if (!alreadyPinned) {
        l.pinned = Math.min(l.pinned + 1, visibleColumns(l).length);
    }
}
