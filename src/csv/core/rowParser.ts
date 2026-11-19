/** Parse the text of one row into fields. Mirrors the quoting rules of RowIndexer. */
export function parseRow(text: string, delimiter: string, quote = '"'): string[] {
    const fields: string[] = [];
    let field = '';
    let inQuote = false;
    let atStart = true;
    let justClosed = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuote) {
            if (c === quote) {
                inQuote = false;
                justClosed = true;
            } else {
                field += c;
            }
            continue;
        }
        if (c === quote) {
            if (justClosed) {
                inQuote = true; // "" escape
                justClosed = false;
                field += quote;
            } else if (atStart) {
                inQuote = true;
                atStart = false;
            } else {
                field += c;
            }
            continue;
        }
        justClosed = false;
        if (c === delimiter) {
            fields.push(field);
            field = '';
            atStart = true;
            continue;
        }
        if (c === '\n' || c === '\r') {
            break;
        }
        field += c;
        atStart = false;
    }

    if (inQuote) {
        return text.replace(/[\r\n]+$/, '').split(delimiter);
    }
    fields.push(field);
    return fields;
}
