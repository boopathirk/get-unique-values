import { GrowableF64, ResultSet } from './resultSet';
import type { IndexWarning } from '../types';

export interface IndexerOptions {
    delimiter: number;
    quote: number;
    maxQuoteBytes: number;
}

const LF = 10;
const CR = 13;

export class RowIndexer {
    readonly starts = new GrowableF64();
    readonly badRows = new ResultSet();
    readonly warnings: IndexWarning[] = [];
    rowCount = 0;

    private expectedFields = 0;
    private rowOpen = false;
    private fieldCount = 0;
    private inQuote = false;
    private quoteJustClosed = false;
    private atFieldStart = false;
    private lineMode = false;
    private quoteOpenedAt = 0;
    private fieldsAtQuote = 0;

    constructor(private readonly options: IndexerOptions) { }

    /** Returns a file offset to rewind to (discarding the rest of this chunk), or undefined. */
    push(chunk: Uint8Array, base: number): number | undefined {
        const { delimiter, quote, maxQuoteBytes } = this.options;
        for (let i = 0; i < chunk.length; i++) {
            const b = chunk[i];
            const off = base + i;

            if (!this.inQuote && (b === LF || b === CR)) {
                if (this.rowOpen) {
                    this.endRow();
                }
                this.lineMode = false;
                this.quoteJustClosed = false;
                continue;
            }

            if (!this.rowOpen) {
                this.starts.push(off);
                this.rowOpen = true;
                this.fieldCount = 1;
                this.atFieldStart = true;
            }

            if (this.inQuote && off - this.quoteOpenedAt > maxQuoteBytes) {
                return this.recover();
            }

            if (b === quote && !this.lineMode) {
                if (this.inQuote) {
                    this.inQuote = false;
                    this.quoteJustClosed = true;
                } else if (this.quoteJustClosed) {
                    this.inQuote = true; // "" escape: reopen
                    this.quoteJustClosed = false;
                } else if (this.atFieldStart) {
                    this.inQuote = true;
                    this.quoteOpenedAt = off;
                    this.fieldsAtQuote = this.fieldCount;
                }
                this.atFieldStart = false;
                continue;
            }

            this.quoteJustClosed = false;
            if (!this.inQuote && b === delimiter) {
                this.fieldCount++;
                this.atFieldStart = true;
            } else {
                this.atFieldStart = false;
            }
        }
        return undefined;
    }

    /** Call at end of file. Returns a rewind offset if a quote was left open. */
    finish(): number | undefined {
        if (this.inQuote) {
            return this.recover();
        }
        if (this.rowOpen) {
            this.endRow();
        }
        return undefined;
    }

    private recover(): number {
        this.warnings.push({ kind: 'unclosed-quote', row: this.starts.length - 1, offset: this.quoteOpenedAt });
        this.inQuote = false;
        this.quoteJustClosed = false;
        this.atFieldStart = false;
        this.lineMode = true;
        this.fieldCount = this.fieldsAtQuote;
        return this.quoteOpenedAt;
    }

    private endRow(): void {
        if (this.rowCount === 0) {
            this.expectedFields = this.fieldCount;
        } else if (this.fieldCount !== this.expectedFields) {
            this.badRows.push(this.rowCount);
        }
        this.rowCount++;
        this.rowOpen = false;
        this.inQuote = false;
    }
}
