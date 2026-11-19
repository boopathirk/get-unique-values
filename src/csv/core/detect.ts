import { parseRow } from './rowParser';
import type { Encoding } from '../types';

export interface Detected {
    encoding: Encoding;
    bomLength: number;
    binary: boolean;
    delimiter: string;
    hasHeader: boolean;
}

const CANDIDATES = [',', ';', '\t', '|'];

export function detectEncoding(sample: Uint8Array): { encoding: Encoding; bomLength: number } {
    if (sample.length >= 3 && sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) {
        return { encoding: 'utf-8', bomLength: 3 };
    }
    if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) {
        return { encoding: 'utf-16le', bomLength: 2 };
    }
    if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) {
        return { encoding: 'utf-16be', bomLength: 2 };
    }
    try {
        // stream:true tolerates a multi-byte character cut off at the end of the sample
        new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
        return { encoding: 'utf-8', bomLength: 0 };
    } catch {
        return { encoding: 'latin1', bomLength: 0 };
    }
}

/** First `max` non-empty records, splitting on newlines outside quotes. */
export function splitRecords(text: string, max: number): string[] {
    const out: string[] = [];
    let start = 0;
    let inQuote = false;
    for (let i = 0; i < text.length && out.length < max; i++) {
        const c = text[i];
        if (c === '"') {
            inQuote = !inQuote;
        } else if (!inQuote && (c === '\n' || c === '\r')) {
            if (i > start) {
                out.push(text.slice(start, i));
            }
            start = i + 1;
        }
    }
    if (out.length === 0 && start < text.length) {
        out.push(text.slice(start));
    }
    return out;
}

export function detectDelimiter(text: string): string {
    const records = splitRecords(text, 50);
    let best = ',';
    let bestScore = 0;
    for (const d of CANDIDATES) {
        const counts = new Map<number, number>();
        for (const r of records) {
            const n = parseRow(r, d).length;
            counts.set(n, (counts.get(n) ?? 0) + 1);
        }
        let score = 0;
        for (const [fieldCount, occurrences] of counts) {
            if (fieldCount > 1 && occurrences > score) {
                score = occurrences;
            }
        }
        if (score > bestScore) {
            best = d;
            bestScore = score;
        }
    }
    return best;
}

/** Header names are rarely numbers or blank: no header if half or more fields are empty or numeric. */
export function guessHasHeader(fields: string[]): boolean {
    if (fields.length === 0) {
        return true;
    }
    const empty = fields.filter((f) => f.trim() === '').length;
    const numeric = fields.filter((f) => /^-?\d+([.,]\d+)?$/.test(f.trim())).length;
    return empty * 2 < fields.length && numeric * 2 < fields.length;
}

export function detect(sample: Uint8Array): Detected {
    const { encoding, bomLength } = detectEncoding(sample);
    const utf16 = encoding === 'utf-16le' || encoding === 'utf-16be';
    const binary = !utf16 && sample.includes(0);
    const text = new TextDecoder(encoding === 'latin1' ? 'windows-1252' : 'utf-8').decode(sample.subarray(bomLength));
    const delimiter = detectDelimiter(text);
    const first = splitRecords(text, 1)[0];
    const hasHeader = first === undefined ? true : guessHasHeader(parseRow(first, delimiter));
    return { encoding, bomLength, binary, delimiter, hasHeader };
}
