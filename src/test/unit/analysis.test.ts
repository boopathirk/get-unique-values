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
});
