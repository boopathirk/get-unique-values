import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { CsvEngine, Tuning } from '../../csv/core/engine';
import { XLSX_MAX_ROWS, exportToFile, xlsxValue } from '../../csv/export/exportFile';
import type { ExportOptions } from '../../csv/export/exportFile';
import type { CancelToken } from '../../csv/types';

const TINY: Tuning = { chunkBytes: 7, scanBytes: 16, maxQuoteBytes: 1 << 20 };
const CSV = 'id,name,price\n1,Blue,10\n2,"Red, dark",\n3,Blue,30\n';
const live = (): CancelToken => ({ cancelled: false });
const noop = () => undefined;

suite('exportToFile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-export-'));
    const engines: CsvEngine[] = [];
    let counter = 0;

    async function load(content: string): Promise<CsvEngine> {
        const p = path.join(dir, `in${counter++}.csv`);
        fs.writeFileSync(p, content);
        const engine = new CsvEngine(p, {}, TINY);
        engines.push(engine);
        assert.strictEqual((await engine.open()).kind, 'ready');
        const indexing = engine.index(noop, live());
        await engine.getInfo();
        await indexing;
        return engine;
    }

    const out = (name: string): string => path.join(dir, name);
    const opts = (o: Partial<ExportOptions> & { outPath: string }): ExportOptions => ({
        format: 'csv', scope: 'all', columns: [0, 1, 2], ...o,
    });

    suiteTeardown(async () => {
        for (const e of engines) {
            await e.dispose();
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('csv: all rows, all columns', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('a.csv') }), live(), noop);
        assert.deepStrictEqual(r, { rows: 3, truncated: false, path: out('a.csv') });
        assert.strictEqual(fs.readFileSync(out('a.csv'), 'utf8'), 'id,name,price\n1,Blue,10\n2,"Red, dark",\n3,Blue,30\n');
    });

    test('column subset and reorder', async () => {
        const engine = await load(CSV);
        await exportToFile(engine, opts({ outPath: out('b.csv'), columns: [1, 0] }), live(), noop);
        assert.strictEqual(fs.readFileSync(out('b.csv'), 'utf8'), 'name,id\nBlue,1\n"Red, dark",2\nBlue,3\n');
    });

    test('json', async () => {
        const engine = await load(CSV);
        await exportToFile(engine, opts({ outPath: out('c.json'), format: 'json', columns: [0, 1] }), live(), noop);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(out('c.json'), 'utf8')), [
            { id: '1', name: 'Blue' }, { id: '2', name: 'Red, dark' }, { id: '3', name: 'Blue' },
        ]);
    });

    test('view scope exports only the filtered rows', async () => {
        const engine = await load(CSV);
        await engine.filter([{ kind: 'columnIn', column: 1, values: ['Blue'] }], live(), noop);
        const r = await exportToFile(engine, opts({ outPath: out('d.csv'), scope: 'view' }), live(), noop);
        assert.strictEqual(r?.rows, 2);
        assert.strictEqual(fs.readFileSync(out('d.csv'), 'utf8'), 'id,name,price\n1,Blue,10\n3,Blue,30\n');
    });

    test('view scope with no active filter exports everything', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('e.csv'), scope: 'view' }), live(), noop);
        assert.strictEqual(r?.rows, 3);
    });

    test('progress reports done and total', async () => {
        const engine = await load(CSV);
        const seen: Array<[number, number]> = [];
        await exportToFile(engine, opts({ outPath: out('f.csv') }), live(), (d, t) => seen.push([d, t]));
        assert.ok(seen.length > 0);
        assert.deepStrictEqual(seen[seen.length - 1], [3, 3]);
    });

    test('cancelled export returns null and removes the partial file', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('g.csv') }), { cancelled: true }, noop);
        assert.strictEqual(r, null);
        assert.strictEqual(fs.existsSync(out('g.csv')), false);
    });

    test('unwritable path rejects', async () => {
        const engine = await load(CSV);
        await assert.rejects(() => exportToFile(engine, opts({ outPath: path.join(dir, 'no-such-dir', 'x.csv') }), live(), noop));
    });

    for (const format of ['csv', 'xlsx'] as const) {
        test(`${format}: failing export rejects and leaves no file`, async () => {
            const engine = await load(CSV);
            const p = out(`fail.${format}`);
            const failing = engine as unknown as { exportRows: () => Promise<never> };
            failing.exportRows = () => Promise.reject(new Error('boom'));
            await assert.rejects(() => exportToFile(engine, opts({ outPath: p, format }), live(), noop), /boom/);
            assert.strictEqual(fs.existsSync(p), false);
        });
    }

    test('xlsx round trip with numbers kept as numbers', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('h.xlsx'), format: 'xlsx', sheetName: 'Items' }), live(), noop);
        assert.strictEqual(r?.rows, 3);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(out('h.xlsx'));
        const ws = wb.getWorksheet('Items');
        assert.ok(ws);
        assert.deepStrictEqual((ws.getRow(1).values as unknown[]).slice(1), ['id', 'name', 'price']);
        assert.deepStrictEqual((ws.getRow(2).values as unknown[]).slice(1), [1, 'Blue', 10]);
        assert.strictEqual(ws.getRow(3).getCell(2).value, 'Red, dark');
    });

    test('xlsxValue keeps leading zeros and long numbers as text', () => {
        assert.strictEqual(xlsxValue('42'), 42);
        assert.strictEqual(xlsxValue('-3.5'), -3.5);
        assert.strictEqual(xlsxValue('1.50'), '1.50');
        assert.strictEqual(xlsxValue('-0'), '-0');
        assert.strictEqual(xlsxValue('007'), '007');
        assert.strictEqual(xlsxValue('1234567890123456'), '1234567890123456');
        assert.strictEqual(xlsxValue('1e5'), '1e5');
        assert.strictEqual(xlsxValue(''), '');
        assert.strictEqual(XLSX_MAX_ROWS, 1_048_576);
    });
});
