export type TextFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'sql' | 'markdown';

export interface Formatter {
    /** Text written before the first row (header line, opening bracket, …). */
    begin(): string;
    row(fields: string[]): string;
    /** Text written after the last row. */
    end(): string;
}

export interface FormatOptions {
    table?: string;
}

export function csvField(value: string, delimiter: string): string {
    return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** JSON object keys from header names: a repeated name gets _2, _3, … (never colliding with another key) */
export function uniqueKeys(header: string[]): string[] {
    const used = new Set<string>();
    const counts = new Map<string, number>();
    return header.map((name) => {
        let key = name;
        let n = counts.get(name) ?? 1;
        while (used.has(key)) {
            n++;
            key = `${name}_${n}`;
        }
        counts.set(name, n);
        used.add(key);
        return key;
    });
}

function toObject(keys: string[], fields: string[]): Record<string, string> {
    const out: Record<string, string> = Object.create(null);
    keys.forEach((k, i) => {
        out[k] = fields[i] ?? '';
    });
    return out;
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const quoteString = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const mdCell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

export function createFormatter(format: TextFormat, header: string[], options: FormatOptions = {}): Formatter {
    switch (format) {
        case 'csv':
        case 'tsv': {
            const d = format === 'csv' ? ',' : '\t';
            const line = (fields: string[]): string => `${fields.map((f) => csvField(f, d)).join(d)}\n`;
            return { begin: () => line(header), row: line, end: () => '' };
        }
        case 'json': {
            const keys = uniqueKeys(header);
            let first = true;
            return {
                begin: () => '[',
                row: (fields) => {
                    const text = `${first ? '' : ','}\n  ${JSON.stringify(toObject(keys, fields))}`;
                    first = false;
                    return text;
                },
                end: () => '\n]\n',
            };
        }
        case 'jsonl': {
            const keys = uniqueKeys(header);
            return { begin: () => '', row: (fields) => `${JSON.stringify(toObject(keys, fields))}\n`, end: () => '' };
        }
        case 'markdown':
            return {
                begin: () => `| ${header.map(mdCell).join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n`,
                row: (fields) => `| ${header.map((_, i) => mdCell(fields[i] ?? '')).join(' | ')} |\n`,
                end: () => '',
            };
        case 'sql': {
            const prefix = `INSERT INTO ${quoteIdent(options.table || 'data')} (${header.map(quoteIdent).join(', ')}) VALUES (`;
            return {
                begin: () => '',
                row: (fields) => `${prefix}${header.map((_, i) => quoteString(fields[i] ?? '')).join(', ')});\n`,
                end: () => '',
            };
        }
    }
}
