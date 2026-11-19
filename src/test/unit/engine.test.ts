import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvEngine, Tuning } from '../../csv/core/engine';
import type { Predicate } from '../../csv/core/predicates';
import type { CancelToken, IndexProgress, ParseOptions } from '../../csv/types';

const TINY: Tuning = { chunkBytes: 7, scanBytes: 16, maxQuoteBytes: 1 << 20 };
const SAMPLE = 'sku,name,price\r\nA1,"Blue, large",10\r\nA2,"Multi\nline",20\r\nA3,Red,\r\nA4,Blue,30\r\n';
const noop = () => undefined;
const live = (): CancelToken => ({ cancelled: false });

suite('CsvEngine', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-engine-'));
    const engines: CsvEngine[] = [];
    let counter = 0;

    function write(content: string | Buffer): string {
        const p = path.join(dir, `f${counter++}.csv`);
        fs.writeFileSync(p, content);
        return p;
    }

    async function load(content: string | Buffer, options: ParseOptions = {}, tuning: Tuning = TINY) {
        const engine = new CsvEngine(write(content), options, tuning);
        engines.push(engine);
        const opened = await engine.open();
        assert.strictEqual(opened.kind, 'ready');
        let last: IndexProgress | undefined;
        const indexing = engine.index((p) => { last = p; }, live());
        const info = await engine.getInfo();
        await indexing;
        return { engine, info, last: () => last };
    }

    suiteTeardown(async () => {
        for (const e of engines) {
            await e.dispose();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('info: header, delimiter, column count', async () => {
        const { info } = await load(SAMPLE);
        assert.deepStrictEqual(info.header, ['sku', 'name', 'price']);
        assert.strictEqual(info.delimiter, ',');
        assert.strictEqual(info.hasHeader, true);
        assert.strictEqual(info.columnCount, 3);
        assert.strictEqual(info.encoding, 'utf-8');
    });

    test('pages through all rows, quoted newlines and delimiters intact', async () => {
        const { engine } = await load(SAMPLE);
        const p0 = await engine.readPage(0, 2);
        assert.deepStrictEqual(p0.rows, [['A1', 'Blue, large', '10'], ['A2', 'Multi\nline', '20']]);
        assert.deepStrictEqual(p0.rowNumbers, [0, 1]);
        assert.strictEqual(p0.total, 4);
        assert.strictEqual(p0.complete, true);
        const p1 = await engine.readPage(1, 2);
        assert.deepStrictEqual(p1.rows, [['A3', 'Red', ''], ['A4', 'Blue', '30']]);
        assert.deepStrictEqual(p1.rowNumbers, [2, 3]);
        const p2 = await engine.readPage(2, 2);
        assert.deepStrictEqual(p2.rows, []);
    });

    test('hasHeader:false override generates column names and keeps the first row as data', async () => {
        const { engine, info } = await load(SAMPLE, { hasHeader: false });
        assert.deepStrictEqual(info.header, ['Column 1', 'Column 2', 'Column 3']);
        assert.strictEqual((await engine.readPage(0, 10)).total, 5);
    });

    test('UTF-8 BOM is skipped', async () => {
        const { info } = await load('﻿a,b\n1,2\n');
        assert.deepStrictEqual(info.header, ['a', 'b']);
    });

    test('latin1 files are decoded', async () => {
        const { engine } = await load(Buffer.concat([Buffer.from('n\ncaf'), Buffer.from([0xe9]), Buffer.from('\n')]));
        assert.deepStrictEqual((await engine.readPage(0, 5)).rows, [['café']]);
    });

    test('search filter: all columns, then a single column', async () => {
        const { engine } = await load(SAMPLE);
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        const all = await engine.filter([{ kind: 'search', query: 'blue', column: null, mode }], live(), noop);
        assert.deepStrictEqual(all, { matches: 2, complete: true });
        const page = await engine.readPage(0, 10);
        assert.deepStrictEqual(page.rowNumbers, [0, 3]);
        assert.strictEqual(page.rows[0][1], 'Blue, large');
        assert.strictEqual(page.total, 2);
        const col0 = await engine.filter([{ kind: 'search', query: 'blue', column: 0, mode }], live(), noop);
        assert.strictEqual(col0.matches, 0);
    });

    test('column filter, including empty values, combined with search', async () => {
        const { engine } = await load(SAMPLE);
        await engine.filter([{ kind: 'columnIn', column: 2, values: [''] }], live(), noop);
        assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [2]);
        await engine.filter([{ kind: 'columnIn', column: 2, values: ['10', '30'] }], live(), noop);
        assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [0, 3]);
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        await engine.filter([
            { kind: 'search', query: 'blue', column: null, mode },
            { kind: 'columnIn', column: 2, values: ['30'] },
        ], live(), noop);
        assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [3]);
    });

    test('empty predicate list clears the filter', async () => {
        const { engine } = await load(SAMPLE);
        await engine.filter([{ kind: 'columnIn', column: 2, values: [''] }], live(), noop);
        const cleared = await engine.filter([], live(), noop);
        assert.deepStrictEqual(cleared, { matches: 4, complete: true });
        assert.strictEqual((await engine.readPage(0, 10)).total, 4);
    });

    test('bad rows are indexed and filterable', async () => {
        const { engine, last } = await load('a,b\n1,2\n3\n4,5,6\n7,8\n');
        assert.strictEqual(last()?.badRows, 2);
        await engine.filter([{ kind: 'badRows' }], live(), noop);
        const page = await engine.readPage(0, 10);
        assert.deepStrictEqual(page.rowNumbers, [1, 2]);
        assert.deepStrictEqual(page.rows, [['3'], ['4', '5', '6']]);
    });

    test('an invalid regex throws and keeps the previous view', async () => {
        const { engine } = await load(SAMPLE);
        await engine.filter([{ kind: 'columnIn', column: 2, values: [''] }], live(), noop);
        const mode = { caseSensitive: false, wholeCell: false, regex: true };
        await assert.rejects(engine.filter([{ kind: 'search', query: '(', column: null, mode }], live(), noop), SyntaxError);
        assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [2]);
    });

    test('a cancelled scan reports incomplete', async () => {
        const { engine } = await load(SAMPLE);
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        const result = await engine.filter([{ kind: 'search', query: 'a', column: null, mode }], { cancelled: true }, noop);
        assert.strictEqual(result.complete, false);
    });

    test('unique values count empties and sort by count then value', async () => {
        const { engine } = await load('k,v\na,1\nb,\na,2\nc,1\na,\n');
        const k = await engine.uniqueValues(0, live());
        assert.deepStrictEqual(k?.entries, [{ value: 'a', count: 3 }, { value: 'b', count: 1 }, { value: 'c', count: 1 }]);
        assert.strictEqual(k?.distinct, 3);
        assert.strictEqual(k?.total, 5);
        assert.strictEqual(k?.truncated, false);
        const v = await engine.uniqueValues(1, live());
        assert.deepStrictEqual(v?.entries, [{ value: '', count: 2 }, { value: '1', count: 2 }, { value: '2', count: 1 }]);
    });

    test('unique values on a cancelled scan return null', async () => {
        const { engine } = await load(SAMPLE);
        assert.strictEqual(await engine.uniqueValues(0, { cancelled: true }), null);
    });

    test('nonEmptyColumns lists columns with at least one value', async () => {
        const { engine } = await load('a,b,c\n1,,\n2,,x\n');
        assert.deepStrictEqual(await engine.nonEmptyColumns(live()), [0, 2]);
    });

    test('unclosed quote is recovered, warned about, and shown as a plain row', async () => {
        const { engine, last } = await load('a,b\n"oops,1\nx,2\n', {}, { ...TINY, maxQuoteBytes: 4 });
        const page = await engine.readPage(0, 10);
        assert.strictEqual(page.total, 2);
        assert.deepStrictEqual(page.rows, [['"oops', '1'], ['x', '2']]);
        assert.strictEqual(last()?.done, true);
        assert.strictEqual(last()?.warnings.length, 1);
    });

    test('empty, binary and UTF-16 files are reported instead of opened', async () => {
        const kinds: Array<[string | Buffer, string]> = [
            ['', 'empty'],
            [Buffer.from([0x61, 0x00, 0x62]), 'binary'],
            [Buffer.from([0xff, 0xfe, 0x61, 0x00]), 'unsupported-encoding'],
        ];
        for (const [content, kind] of kinds) {
            const engine = new CsvEngine(write(content), {}, TINY);
            engines.push(engine);
            assert.strictEqual((await engine.open()).kind, kind);
        }
    });

    suite('before indexing finishes', () => {
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        const blue = (): Predicate[] => [{ kind: 'search', query: 'blue', column: null, mode }];

        async function opened(tuning: Tuning = TINY): Promise<CsvEngine> {
            const engine = new CsvEngine(write(SAMPLE), {}, tuning);
            engines.push(engine);
            assert.strictEqual((await engine.open()).kind, 'ready');
            return engine;
        }

        test('a search issued while indexing never shows unfiltered rows', async () => {
            const engine = await opened();
            const pending = engine.filter(blue(), live(), noop);
            const during = await engine.readPage(0, 10);
            assert.deepStrictEqual(during, { rowNumbers: [], rows: [], total: 0, complete: false });
            const indexing = engine.index(noop, live());
            assert.deepStrictEqual(await pending, { matches: 2, complete: true });
            await indexing;
            assert.deepStrictEqual((await engine.readPage(0, 10)).rowNumbers, [0, 3]);
        });

        test('a bad regex rejects immediately, before indexing finishes', async () => {
            const engine = await opened();
            const regex = { ...mode, regex: true };
            await assert.rejects(engine.filter([{ kind: 'search', query: '(', column: null, mode: regex }], live(), noop), SyntaxError);
        });

        test('overlapping filters: the cancelled first one leaves the second owning the view', async () => {
            const engine = await opened();
            const first = { cancelled: false };
            const f1 = engine.filter(blue(), first, noop);
            first.cancelled = true;
            const f2 = engine.filter([{ kind: 'columnIn', column: 2, values: [''] }], live(), noop);
            const indexing = engine.index(noop, live());
            assert.strictEqual((await f1).complete, false);
            assert.deepStrictEqual(await f2, { matches: 1, complete: true });
            await indexing;
            const page = await engine.readPage(0, 10);
            assert.deepStrictEqual(page.rowNumbers, [2]);
            assert.strictEqual(page.complete, true);
        });

        test('clearing the filter during indexing leaves the view null', async () => {
            const engine = await opened();
            const f1 = engine.filter(blue(), live(), noop);
            const cleared = engine.filter([], live(), noop);
            const indexing = engine.index(noop, live());
            assert.strictEqual((await f1).complete, false);
            assert.deepStrictEqual(await cleared, { matches: 4, complete: true });
            await indexing;
            const page = await engine.readPage(0, 10);
            assert.strictEqual(page.total, 4);
            assert.deepStrictEqual(page.rowNumbers, [0, 1, 2, 3]);
        });

        test('cancelling before indexing finishes drops the empty view so all rows show', async () => {
            const engine = await opened();
            const token = { cancelled: false };
            const pending = engine.filter(blue(), token, noop);
            token.cancelled = true;
            const indexing = engine.index(noop, live());
            assert.deepStrictEqual(await pending, { matches: 4, complete: false });
            await indexing;
            const page = await engine.readPage(0, 10);
            assert.strictEqual(page.total, 4);
            assert.strictEqual(page.complete, true);
        });

        test('readPage beyond the indexed rows resolves once indexing completes', async () => {
            const engine = await opened();
            const page = engine.readPage(0, 100);
            const indexing = engine.index(noop, live());
            const result = await page;
            await indexing;
            assert.strictEqual(result.total, 4);
            assert.strictEqual(result.rows.length, 4);
            assert.strictEqual(result.complete, true);
        });

        test('an index I/O error releases every waiter and later reads rethrow it', async () => {
            const engine = await opened({
                ...TINY,
                beforeIndexRead: (pos) => {
                    if (pos >= 14) {
                        throw new Error('disk gone');
                    }
                },
            });
            const waiting = Promise.allSettled([
                engine.readPage(0, 100),
                engine.filter(blue(), live(), noop),
                engine.uniqueValues(0, live()),
                engine.getInfo(),
            ]);
            await assert.rejects(engine.index(noop, live()), /disk gone/);
            for (const outcome of await waiting) {
                assert.strictEqual(outcome.status, 'rejected');
                assert.match(String((outcome as PromiseRejectedResult).reason), /disk gone/);
            }
            await assert.rejects(engine.nonEmptyColumns(live()), /disk gone/);
            await assert.rejects(engine.readPage(0, 10), /disk gone/);
        });
    });

    test('after a user cancel the partial view counts as complete for paging', async () => {
        const { engine } = await load(SAMPLE);
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        const result = await engine.filter([{ kind: 'search', query: 'a', column: null, mode }], { cancelled: true }, noop);
        assert.strictEqual(result.complete, false);
        assert.strictEqual((await engine.readPage(0, 10)).complete, true);
    });
});
