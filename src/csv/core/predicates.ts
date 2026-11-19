export interface SearchMode {
    caseSensitive: boolean;
    wholeCell: boolean;
    regex: boolean;
}

export type Predicate =
    | { kind: 'search'; query: string; column: number | null; mode: SearchMode }
    | { kind: 'columnIn'; column: number; values: string[] }
    | { kind: 'badRows' };

export type RowTest = (fields: string[]) => boolean;

function cellMatcher(query: string, mode: SearchMode): (cell: string) => boolean {
    if (mode.regex) {
        const source = mode.wholeCell ? `^(?:${query})$` : query;
        const re = new RegExp(source, mode.caseSensitive ? '' : 'i');
        return (cell) => re.test(cell);
    }
    if (mode.wholeCell) {
        if (mode.caseSensitive) {
            return (cell) => cell === query;
        }
        const q = query.toLowerCase();
        return (cell) => cell.toLowerCase() === q;
    }
    if (mode.caseSensitive) {
        return (cell) => cell.includes(query);
    }
    const q = query.toLowerCase();
    return (cell) => cell.toLowerCase().includes(q);
}

export function compilePredicates(preds: Predicate[]): { test: RowTest; badRowsOnly: boolean; empty: boolean } {
    const tests: RowTest[] = [];
    let badRowsOnly = false;
    for (const p of preds) {
        if (p.kind === 'badRows') {
            badRowsOnly = true;
            continue;
        }
        if (p.kind === 'columnIn') {
            const set = new Set(p.values);
            const col = p.column;
            tests.push((f) => set.has(f[col] ?? ''));
            continue;
        }
        if (p.query === '') {
            continue;
        }
        const match = cellMatcher(p.query, p.mode);
        const col = p.column;
        if (col === null) {
            tests.push((f) => f.some((cell) => match(cell)));
        } else {
            tests.push((f) => match(f[col] ?? ''));
        }
    }
    return {
        test: (f) => tests.every((t) => t(f)),
        badRowsOnly,
        empty: tests.length === 0 && !badRowsOnly,
    };
}
