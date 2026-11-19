import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { cellText, convertSheetToCsv, listSheets } from '../../csv/import/xlsx';

const live = () => ({ cancelled: false });
const noop = () => undefined;

suite('xlsx import', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-xlsx-'));
    const book = path.join(dir, 'book.xlsx');

    suiteSetup(async () => {
        // Plain Workbook (shared strings, like Excel itself): the stream writer emits inline strings, whose rich text the stream reader truncates.
        const wb = new ExcelJS.Workbook();
        const s1 = wb.addWorksheet('Products');
        s1.addRow(['sku', 'name', 'price', 'when']);
        s1.addRow(['A1', 'Blue, "big"', 10.5, new Date('2024-01-02T00:00:00Z')]);
        s1.addRow(['A2', { formula: '1+1', result: 2 }, '', 'x']);
        s1.addRow(['A3', { richText: [{ text: 'Rich ' }, { text: 'text' }] }]);
        const s2 = wb.addWorksheet('Other');
        s2.addRow(['z']);
        await wb.xlsx.writeFile(book);
    });

    suiteTeardown(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('cellText covers every value shape', () => {
        assert.strictEqual(cellText(null), '');
        assert.strictEqual(cellText(undefined), '');
        assert.strictEqual(cellText('a'), 'a');
        assert.strictEqual(cellText(3.5), '3.5');
        assert.strictEqual(cellText(true), 'true');
        assert.strictEqual(cellText(new Date('2024-01-02T03:04:05Z')), '2024-01-02T03:04:05.000Z');
        assert.strictEqual(cellText({ formula: 'A1', result: 7 }), '7');
        assert.strictEqual(cellText({ formula: 'A1' }), '');
        assert.strictEqual(cellText({ richText: [{ text: 'a' }, { text: 'b' }] }), 'ab');
        assert.strictEqual(cellText({ text: 'link', hyperlink: 'http://x' }), 'link');
        assert.strictEqual(cellText({ error: '#N/A' }), '#N/A');
    });

    test('listSheets returns names in order', async () => {
        assert.deepStrictEqual(await listSheets(book), ['Products', 'Other']);
    });

    test('convert sheet 0 to csv', async () => {
        const out = path.join(dir, 'p.csv');
        const rows = await convertSheetToCsv(book, 0, out, live(), noop);
        assert.strictEqual(rows, 3);
        assert.strictEqual(
            fs.readFileSync(out, 'utf8'),
            'sku,name,price,when\nA1,"Blue, ""big""",10.5,2024-01-02T00:00:00.000Z\nA2,2,,x\nA3,Rich text,,\n',
        );
    });

    test('convert sheet 1', async () => {
        const out = path.join(dir, 'o.csv');
        assert.strictEqual(await convertSheetToCsv(book, 1, out, live(), noop), 0);
        assert.strictEqual(fs.readFileSync(out, 'utf8'), 'z\n');
    });

    test('unknown sheet index rejects', async () => {
        await assert.rejects(() => convertSheetToCsv(book, 5, path.join(dir, 'x.csv'), live(), noop));
    });

    test('cancelled conversion returns null and leaves no file', async () => {
        const out = path.join(dir, 'c.csv');
        assert.strictEqual(await convertSheetToCsv(book, 0, out, { cancelled: true }, noop), null);
        assert.strictEqual(fs.existsSync(out), false);
    });

    test('a non-xlsx file rejects with a clear error', async () => {
        const bad = path.join(dir, 'bad.xlsx');
        fs.writeFileSync(bad, 'not a zip');
        await assert.rejects(() => listSheets(bad));
    });
});
