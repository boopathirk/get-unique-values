import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvEngine, Tuning } from '../../csv/core/engine';
import type { CancelToken } from '../../csv/types';

const TINY: Tuning = { chunkBytes: 7, scanBytes: 16, maxQuoteBytes: 1 << 20 };
const CSV = 'id,name,price\n1,Blue,10\n2,Red,\n3,Blue,30\n4,blue,10\n5,Red,20\n';
const live = (): CancelToken => ({ cancelled: false });

suite('CsvEngine analysis', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-analysis-'));
    const engines: CsvEngine[] = [];
    let counter = 0;

    async function load(content: string): Promise<CsvEngine> {
        const p = path.join(dir, `f${counter++}.csv`);
        fs.writeFileSync(p, content);
        const engine = new CsvEngine(p, {}, TINY);
        engines.push(engine);
        assert.strictEqual((await engine.open()).kind, 'ready');
        const indexing = engine.index(() => undefined, live());
        await engine.getInfo();
        await indexing;
        return engine;
    }

    suiteTeardown(async () => {
        for (const e of engines) {
            await e.dispose();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('columnStats: numeric column with an empty cell', async () => {
        const engine = await load(CSV);
        const s = await engine.columnStats(2, live());
        assert.ok(s);
        assert.strictEqual(s.type, 'integer');
        assert.strictEqual(s.rows, 5);
        assert.strictEqual(s.empty, 1);
        assert.strictEqual(s.distinct, 3);
        assert.strictEqual(s.min, '10');
        assert.strictEqual(s.max, '30');
    });

    test('columnStats: result is cached', async () => {
        const engine = await load(CSV);
        const a = await engine.columnStats(1, live());
        const b = await engine.columnStats(1, live());
        assert.strictEqual(a, b);
    });

    test('columnStats: cancelled scan returns null and is not cached', async () => {
        const engine = await load(CSV);
        assert.strictEqual(await engine.columnStats(1, { cancelled: true }), null);
        assert.ok(await engine.columnStats(1, live()));
    });

    test('duplicateKeys: single column, case-sensitive', async () => {
        const engine = await load(CSV);
        const r = await engine.duplicateKeys([1], live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count, g.firstRow]), [
            [['Blue'], 2, 0],
            [['Red'], 2, 1],
        ]);
        assert.strictEqual(r.duplicateKeys, 2);
        assert.strictEqual(r.duplicateRows, 4);
        assert.strictEqual(r.truncated, false);
    });

    test('duplicateKeys: two columns', async () => {
        const engine = await load(CSV);
        const r = await engine.duplicateKeys([1, 2], live());
        assert.ok(r);
        assert.strictEqual(r.groups.length, 0);
    });

    test('duplicateKeys: no duplicates in a unique column', async () => {
        const engine = await load(CSV);
        const r = await engine.duplicateKeys([0], live());
        assert.ok(r);
        assert.strictEqual(r.groups.length, 0);
        assert.strictEqual(r.duplicateRows, 0);
    });

    test('duplicateKeys: cancelled returns null', async () => {
        const engine = await load(CSV);
        assert.strictEqual(await engine.duplicateKeys([1], { cancelled: true }), null);
    });

    test('duplicateKeys: empty column list is rejected', async () => {
        const engine = await load(CSV);
        await assert.rejects(() => engine.duplicateKeys([], live()));
    });

    const WIDE = 'a,b,c,d,e\n1,1,x,,y\n2,2,y,,x\n3,3,z, ,w\n';

    test('duplicateColumns: identical columns and empty columns', async () => {
        const engine = await load(WIDE);
        const r = await engine.duplicateColumns(live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups, [[0, 1]]);
        assert.deepStrictEqual(r.emptyColumns, [3]);
        assert.strictEqual(r.rows, 3);
    });

    test('duplicateColumns: nothing duplicated', async () => {
        const engine = await load(CSV);
        const r = await engine.duplicateColumns(live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups, []);
    });

    test('duplicateColumns: cancelled returns null', async () => {
        const engine = await load(WIDE);
        assert.strictEqual(await engine.duplicateColumns({ cancelled: true }), null);
    });

    test('duplicateKeys: a moved field boundary is not a duplicate', async () => {
        const engine = await load('x,y\nab,c\na,bc\nab,c\n');
        const r = await engine.duplicateKeys([0, 1], live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count, g.firstRow]), [[['ab', 'c'], 2, 0]]);
        assert.strictEqual(r.duplicateRows, 2);
    });

    test('duplicateKeys: values containing \\u0001 are kept apart and returned intact', async () => {
        const engine = await load('x,y\na\u0001b,c\na,b\u0001c\na\u0001b,c\n');
        const r = await engine.duplicateKeys([0, 1], live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count, g.firstRow]), [[['a\u0001b', 'c'], 2, 0]]);
        assert.strictEqual(r.duplicateKeys, 1);
    });

    test('duplicateKeys: keys are read back for many groups in order', async () => {
        const lines = ['k,v'];
        for (let i = 0; i < 60; i++) {
            lines.push(`k${i % 20},"v ${i}"`);
        }
        const engine = await load(`${lines.join('\n')}\n`);
        const r = await engine.duplicateKeys([0], live());
        assert.ok(r);
        assert.strictEqual(r.groups.length, 20);
        assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count, g.firstRow]),
            Array.from({ length: 20 }, (_, i) => [[`k${i}`], 3, i]));
    });

    test('duplicateKeys with every column finds whole-row duplicates', async () => {
        const engine = await load('a,b\n1,x\n2,y\n1,x\n');
        const r = await engine.duplicateKeys([0, 1], live());
        assert.ok(r);
        assert.deepStrictEqual(r.groups.map((g) => [g.key, g.count, g.firstRow]), [[['1', 'x'], 2, 0]]);
    });
});
