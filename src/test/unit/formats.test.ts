import * as assert from 'assert';
import { createFormatter, csvField, uniqueKeys } from '../../csv/core/formats';
import type { TextFormat } from '../../csv/core/formats';

function render(format: TextFormat, header: string[], rows: string[][], table?: string): string {
    const f = createFormatter(format, header, { table });
    return f.begin() + rows.map((r) => f.row(r)).join('') + f.end();
}
const H = ['id', 'name'];
const ROWS = [['1', 'Blue, "big"'], ['2', 'a\nb']];

suite('formats', () => {
    test('csvField quotes only when needed', () => {
        assert.strictEqual(csvField('plain', ','), 'plain');
        assert.strictEqual(csvField('a,b', ','), '"a,b"');
        assert.strictEqual(csvField('a"b', ','), '"a""b"');
        assert.strictEqual(csvField('a\nb', ','), '"a\nb"');
        assert.strictEqual(csvField('a,b', '\t'), 'a,b');
        assert.strictEqual(csvField('a\tb', '\t'), '"a\tb"');
    });
    test('csv', () => {
        assert.strictEqual(render('csv', H, ROWS), 'id,name\n1,"Blue, ""big"""\n2,"a\nb"\n');
    });
    test('tsv', () => {
        assert.strictEqual(render('tsv', H, [['1', 'x,y']]), 'id\tname\n1\tx,y\n');
    });
    test('json is a valid array of objects', () => {
        const out = render('json', H, ROWS);
        assert.deepStrictEqual(JSON.parse(out), [{ id: '1', name: 'Blue, "big"' }, { id: '2', name: 'a\nb' }]);
    });
    test('json with no rows is an empty array', () => {
        assert.deepStrictEqual(JSON.parse(render('json', H, [])), []);
    });
    test('jsonl is one object per line', () => {
        const lines = render('jsonl', H, ROWS).trimEnd().split('\n');
        assert.strictEqual(lines.length, 2);
        assert.deepStrictEqual(JSON.parse(lines[0]), { id: '1', name: 'Blue, "big"' });
    });
    test('duplicate header names get unique json keys', () => {
        assert.deepStrictEqual(uniqueKeys(['a', 'a', 'b', 'a']), ['a', 'a_2', 'b', 'a_3']);
        assert.deepStrictEqual(JSON.parse(render('jsonl', ['a', 'a'], [['1', '2']])), { a: '1', a_2: '2' });
    });
    test('uniqueKeys never collides with an existing suffixed name', () => {
        const keys = uniqueKeys(['a', 'a', 'a_2']);
        assert.strictEqual(new Set(keys).size, 3);
        assert.deepStrictEqual(keys.slice(0, 2), ['a', 'a_2']);
    });
    test('a __proto__ header keeps both keys', () => {
        const line = render('jsonl', ['__proto__', 'x'], [['1', '2']]).trim();
        assert.deepStrictEqual(Object.keys(JSON.parse(line)).sort(), ['__proto__', 'x']);
    });
    test('markdown escapes pipes and newlines', () => {
        assert.strictEqual(
            render('markdown', H, [['1', 'a|b\nc']]),
            '| id | name |\n| --- | --- |\n| 1 | a\\|b<br>c |\n',
        );
    });
    test('sql quotes identifiers and strings', () => {
        assert.strictEqual(
            render('sql', ['id', 'na"me'], [['1', "O'Neil"]], 'my table'),
            'INSERT INTO "my table" ("id", "na""me") VALUES (\'1\', \'O\'\'Neil\');\n',
        );
    });
    test('sql defaults the table name to data', () => {
        assert.ok(render('sql', H, [['1', 'x']]).startsWith('INSERT INTO "data" '));
    });
});
