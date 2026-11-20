import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { CsvEngine, Tuning } from '../../csv/core/engine';
import { XLSX_MAX_ROWS, exportToFile, sanitizeSheetName, xlsxValue } from '../../csv/export/exportFile';
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
    const parts = (): string[] => fs.readdirSync(dir).filter((f) => f.endsWith('.part'));
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
        assert.deepStrictEqual(parts(), [], 'no .part file is left behind');
    });

    for (const format of ['csv', 'json', 'xlsx'] as const) {
        test(`${format}: exporting onto the viewed file rejects and leaves it intact`, async () => {
            const engine = await load(CSV);
            const before = fs.readFileSync(engine.sourcePath);
            await assert.rejects(
                () => exportToFile(engine, opts({ outPath: engine.sourcePath, format }), live(), noop),
                /file being viewed/,
            );
            assert.ok(fs.readFileSync(engine.sourcePath).equals(before), 'source must be byte-for-byte unchanged');
            assert.deepStrictEqual(parts(), []);
        });
    }

    test('a relative or differently spelled path to the viewed file is refused too', async () => {
        const engine = await load(CSV);
        const before = fs.readFileSync(engine.sourcePath);
        const odd = path.join(path.dirname(engine.sourcePath), '.', 'sub', '..', path.basename(engine.sourcePath));
        await assert.rejects(() => exportToFile(engine, opts({ outPath: odd }), live(), noop), /file being viewed/);
        const rel = path.relative(process.cwd(), engine.sourcePath);
        await assert.rejects(() => exportToFile(engine, opts({ outPath: rel }), live(), noop), /file being viewed/);
        assert.ok(fs.readFileSync(engine.sourcePath).equals(before));
    });

    test('a hard link to the viewed file is refused', async () => {
        const engine = await load(CSV);
        const link = out('hardlink.csv');
        fs.linkSync(engine.sourcePath, link);
        const before = fs.readFileSync(engine.sourcePath);
        await assert.rejects(() => exportToFile(engine, opts({ outPath: link }), live(), noop), /file being viewed/);
        assert.ok(fs.readFileSync(engine.sourcePath).equals(before));
        fs.rmSync(link);
    });

    test('xlsx: successful export leaves no .part file', async () => {
        const engine = await load(CSV);
        await exportToFile(engine, opts({ outPath: out('ok.xlsx'), format: 'xlsx' }), live(), noop);
        assert.ok(fs.existsSync(out('ok.xlsx')));
        assert.deepStrictEqual(parts(), []);
    });

    for (const format of ['csv', 'xlsx'] as const) {
        test(`${format}: a part path chosen by the caller is written and renamed onto the target`, async () => {
            const engine = await load(CSV);
            const target = out(`chosen.${format}`);
            const part = out(`chosen.${format}.host1234.part`);
            let sawPart = false;
            const r = await exportToFile(engine, opts({ outPath: target, partPath: part, format }), live(), () => {
                sawPart = sawPart || fs.existsSync(part);
            });
            assert.strictEqual(r?.path, target);
            assert.ok(sawPart, 'the export is written to the supplied part path');
            assert.ok(fs.existsSync(target));
            assert.strictEqual(fs.existsSync(part), false);
            assert.deepStrictEqual(parts(), []);
        });
    }

    test('cancel removes the part path chosen by the caller', async () => {
        const engine = await load(CSV);
        const target = out('chosen-cancel.csv');
        const part = out('chosen-cancel.csv.host5678.part');
        const token: CancelToken = { cancelled: false };
        let sawPart = false;
        const r = await exportToFile(engine, opts({ outPath: target, partPath: part }), token, () => {
            sawPart = sawPart || fs.existsSync(part);
            token.cancelled = true;
        });
        assert.strictEqual(r, null);
        assert.ok(sawPart);
        assert.strictEqual(fs.existsSync(part), false);
        assert.strictEqual(fs.existsSync(target), false);
    });

    test('an existing target is only replaced once the export succeeded', async () => {
        const engine = await load(CSV);
        const p = out('existing.csv');
        fs.writeFileSync(p, 'old');
        assert.strictEqual(await exportToFile(engine, opts({ outPath: p }), { cancelled: true }, noop), null);
        assert.strictEqual(fs.readFileSync(p, 'utf8'), 'old', 'a cancelled export keeps the old file');
        await exportToFile(engine, opts({ outPath: p }), live(), noop);
        assert.strictEqual(fs.readFileSync(p, 'utf8').split('\n')[0], 'id,name,price');
        assert.deepStrictEqual(parts(), []);
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
        assert.deepStrictEqual(parts(), []);
    });

    test('xlsx: cancelled export leaves neither the file nor a .part', async () => {
        const engine = await load(CSV);
        const r = await exportToFile(engine, opts({ outPath: out('g.xlsx'), format: 'xlsx' }), { cancelled: true }, noop);
        assert.strictEqual(r, null);
        assert.strictEqual(fs.existsSync(out('g.xlsx')), false);
        assert.deepStrictEqual(parts(), []);
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
            assert.deepStrictEqual(parts(), []);
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

    test('xlsx: an invalid sheet name is sanitized so the workbook opens', async () => {
        const engine = await load(CSV);
        await exportToFile(engine, opts({ outPath: out('s.xlsx'), format: 'xlsx', sheetName: 'report[2024]' }), live(), noop);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(out('s.xlsx'));
        assert.ok(wb.getWorksheet('report_2024_'));
    });

    test('sanitizeSheetName', () => {
        assert.strictEqual(sanitizeSheetName('report[2024]'), 'report_2024_');
        assert.strictEqual(sanitizeSheetName('a:b*c?d/e\\f'), 'a_b_c_d_e_f');
        assert.strictEqual(sanitizeSheetName(''), 'Data');
        assert.strictEqual(sanitizeSheetName("'''"), 'Data');
        assert.strictEqual(sanitizeSheetName("'quoted'"), 'quoted');
        assert.strictEqual(sanitizeSheetName("it's"), "it's");
        assert.strictEqual(sanitizeSheetName('x'.repeat(40)), 'x'.repeat(31));
        assert.strictEqual(sanitizeSheetName(`${'y'.repeat(30)}'z`), `${'y'.repeat(30)}`);
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
