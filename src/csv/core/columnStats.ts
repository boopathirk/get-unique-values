import type { ColumnStats, ColumnType } from '../types';

const SAMPLE_SIZE = 1000;
const MATCH_RATIO = 0.95;
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const CHECKS: Array<[ColumnType, (v: string) => boolean]> = [
    ['integer', (v) => /^[-+]?\d+$/.test(v)],
    ['number', (v) => NUMBER_RE.test(v)],
    ['boolean', (v) => /^(true|false|yes|no)$/i.test(v)],
    ['date', (v) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(v)],
    ['url', (v) => /^https?:\/\/\S+$/i.test(v)],
    ['email', (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)],
    ['json', isJson],
    ['html', (v) => /<\/?[a-z][^>]*>/i.test(v)],
];

function isJson(v: string): boolean {
    if (!(v.startsWith('{') || v.startsWith('['))) {
        return false;
    }
    try {
        JSON.parse(v);
        return true;
    } catch {
        return false;
    }
}

/** Guess a column type from sample values: the first type that matches at least 95% of the non-blank values. */
export function detectColumnType(values: string[]): ColumnType {
    const sample = values.map((v) => v.trim()).filter((v) => v !== '').slice(0, SAMPLE_SIZE);
    if (sample.length === 0) {
        return 'text';
    }
    for (const [type, test] of CHECKS) {
        const hits = sample.reduce((n, v) => n + (test(v) ? 1 : 0), 0);
        if (hits / sample.length >= MATCH_RATIO) {
            return type;
        }
    }
    return 'text';
}

export class StatsAccumulator {
    private rows = 0;
    private empty = 0;
    private readonly seen = new Set<string>();
    private capped = false;
    private lexMin: string | undefined;
    private lexMax: string | undefined;
    private numMin = Infinity;
    private numMax = -Infinity;
    private allNumeric = true;
    private minLen = Infinity;
    private maxLen = 0;
    private totalLen = 0;
    private nonEmpty = 0;
    private readonly samples: string[] = [];
    private readonly typeSample: string[] = [];

    constructor(private readonly column: number, private readonly distinctCap = 100_000) { }

    add(value: string): void {
        this.rows++;
        const v = value.trim();
        if (v === '') {
            this.empty++;
            return;
        }
        this.nonEmpty++;
        if (this.seen.size < this.distinctCap) {
            if (!this.seen.has(value)) {
                this.seen.add(value);
                if (this.samples.length < 5) {
                    this.samples.push(value);
                }
            }
        } else if (!this.seen.has(value)) {
            this.capped = true;
        }
        if (this.typeSample.length < SAMPLE_SIZE) {
            this.typeSample.push(value);
        }
        if (this.lexMin === undefined || value < this.lexMin) {
            this.lexMin = value;
        }
        if (this.lexMax === undefined || value > this.lexMax) {
            this.lexMax = value;
        }
        if (this.allNumeric) {
            if (NUMBER_RE.test(v)) {
                const n = Number(v);
                this.numMin = Math.min(this.numMin, n);
                this.numMax = Math.max(this.numMax, n);
            } else {
                this.allNumeric = false;
            }
        }
        this.minLen = Math.min(this.minLen, value.length);
        this.maxLen = Math.max(this.maxLen, value.length);
        this.totalLen += value.length;
    }

    result(): ColumnStats {
        const numeric = this.allNumeric && this.nonEmpty > 0;
        const lexMin = this.lexMin ?? '';
        const lexMax = this.lexMax ?? '';
        return {
            column: this.column,
            type: detectColumnType(this.typeSample),
            rows: this.rows,
            empty: this.empty,
            distinct: this.seen.size,
            distinctCapped: this.capped,
            min: numeric ? String(this.numMin) : lexMin,
            max: numeric ? String(this.numMax) : lexMax,
            numeric,
            minLen: this.nonEmpty > 0 ? this.minLen : 0,
            maxLen: this.maxLen,
            avgLen: this.nonEmpty > 0 ? this.totalLen / this.nonEmpty : 0,
            samples: this.samples.slice(),
        };
    }
}
