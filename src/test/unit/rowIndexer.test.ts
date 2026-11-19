import * as assert from 'assert';
import { RowIndexer, IndexerOptions } from '../../csv/core/rowIndexer';

interface Result {
    starts: number[];
    rowCount: number;
    bad: number[];
    warnings: Array<{ kind: string; row: number; offset: number }>;
}

function indexAll(text: string, chunk: number, options: Partial<IndexerOptions> = {}): Result {
    const bytes = Buffer.from(text, 'utf8');
    const idx = new RowIndexer({ delimiter: 44, quote: 34, maxQuoteBytes: 1 << 20, ...options });
    let pos = 0;
    for (;;) {
        while (pos < bytes.length) {
            const end = Math.min(pos + chunk, bytes.length);
            const rewind = idx.push(bytes.subarray(pos, end), pos);
            pos = rewind !== undefined ? rewind : end;
        }
        const rewind = idx.finish();
        if (rewind === undefined) {
            break;
        }
        pos = rewind;
    }
    const starts: number[] = [];
    for (let i = 0; i < idx.starts.length; i++) {
        starts.push(idx.starts.get(i));
    }
    const bad: number[] = [];
    for (let i = 0; i < idx.badRows.length; i++) {
        bad.push(idx.badRows.get(i));
    }
    return { starts, rowCount: idx.rowCount, bad, warnings: idx.warnings };
}

const CHUNKS = [1, 2, 3, 5, 7, 1 << 20];

function expectAll(text: string, expected: Partial<Result>, options: Partial<IndexerOptions> = {}): void {
    for (const chunk of CHUNKS) {
        const got = indexAll(text, chunk, options);
        for (const [key, value] of Object.entries(expected)) {
            assert.deepStrictEqual((got as unknown as Record<string, unknown>)[key], value, `chunk=${chunk} key=${key}`);
        }
    }
}

suite('rowIndexer', () => {
    test('LF rows', () => {
        expectAll('a,b\n1,2\n3,4\n', { starts: [0, 4, 8], rowCount: 3, bad: [] });
    });

    test('CRLF rows, no trailing newline', () => {
        expectAll('a,b\r\n1,2\r\n3,4', { starts: [0, 5, 10], rowCount: 3 });
    });

    test('CR-only rows', () => {
        expectAll('a,b\r1,2\r3,4\r', { starts: [0, 4, 8], rowCount: 3 });
    });

    test('blank lines are not rows', () => {
        expectAll('a,b\n\n\n1,2', { starts: [0, 6], rowCount: 2 });
    });

    test('newline inside quotes stays in the row', () => {
        expectAll('a,b\n"x\ny",2\nz,3', { starts: [0, 4, 12], rowCount: 3, bad: [] });
    });

    test('doubled quotes are an escape', () => {
        expectAll('a,b\n"he said ""hi""",2\nz,3\n', { starts: [0, 4, 23], rowCount: 3, bad: [] });
    });

    test('delimiter inside quotes is not counted', () => {
        expectAll('a,b\n"1,5",2\n', { rowCount: 2, bad: [] });
    });

    test('quote in the middle of an unquoted field is literal', () => {
        expectAll('a,b\nab"c,d\ne,f\n', { starts: [0, 4, 11], rowCount: 3, bad: [] });
    });

    test('rows with the wrong field count are recorded', () => {
        expectAll('a,b\n1,2,3\n4\n5,6\n', { starts: [0, 4, 10, 12], rowCount: 4, bad: [1, 2] });
    });

    test('unclosed quote past maxQuoteBytes is recovered line by line', () => {
        expectAll(
            'a,b\n"oops,1\nx,2\ny,3\n',
            { starts: [0, 4, 12, 16], rowCount: 4, bad: [], warnings: [{ kind: 'unclosed-quote', row: 1, offset: 4 }] },
            { maxQuoteBytes: 4 },
        );
    });

    test('unclosed quote at end of file is recovered', () => {
        expectAll('a,b\n"x,1', {
            starts: [0, 4],
            rowCount: 2,
            bad: [],
            warnings: [{ kind: 'unclosed-quote', row: 1, offset: 4 }],
        });
    });
});
