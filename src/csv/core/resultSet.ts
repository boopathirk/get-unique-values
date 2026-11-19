/** Growable list of byte offsets (needs doubles: files can exceed 4 GB). */
export class GrowableF64 {
    private buf = new Float64Array(1024);
    length = 0;

    push(v: number): void {
        if (this.length === this.buf.length) {
            const next = new Float64Array(this.buf.length * 2);
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.length++] = v;
    }

    get(i: number): number {
        return this.buf[i];
    }
}

/** Growable list of row numbers (4 bytes per entry). */
export class ResultSet {
    private buf = new Uint32Array(1024);
    length = 0;

    push(v: number): void {
        if (this.length === this.buf.length) {
            const next = new Uint32Array(this.buf.length * 2);
            next.set(this.buf);
            this.buf = next;
        }
        this.buf[this.length++] = v;
    }

    get(i: number): number {
        return this.buf[i];
    }

    slice(start: number, end: number): number[] {
        const stop = Math.min(end, this.length);
        const out: number[] = [];
        for (let i = start; i < stop; i++) {
            out.push(this.buf[i]);
        }
        return out;
    }
}

/** Merge ascending row numbers into `[start, count]` runs of consecutive rows. */
export function coalesce(nums: number[]): Array<[number, number]> {
    const runs: Array<[number, number]> = [];
    for (const n of nums) {
        const last = runs[runs.length - 1];
        if (last && last[0] + last[1] === n) {
            last[1]++;
        } else {
            runs.push([n, 1]);
        }
    }
    return runs;
}
