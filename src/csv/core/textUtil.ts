export function guessLanguage(value: string): 'json' | 'html' | 'plaintext' {
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
            JSON.parse(t);
            return 'json';
        } catch {
            // not JSON, fall through
        }
    }
    if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(t)) {
        return 'html';
    }
    return 'plaintext';
}

export function prettyJson(value: string): string {
    return JSON.stringify(JSON.parse(value), null, 2);
}

export function csvEscape(value: string, delimiter: string): string {
    if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

export function rowToCsv(fields: string[], delimiter: string): string {
    return fields.map((f) => csvEscape(f, delimiter)).join(delimiter);
}

export function rowToJson(header: string[], fields: string[]): string {
    const obj: Record<string, string> = {};
    header.forEach((name, i) => {
        obj[name || `Column ${i + 1}`] = fields[i] ?? '';
    });
    return JSON.stringify(obj, null, 2);
}

export function truncateText(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}…`;
}
