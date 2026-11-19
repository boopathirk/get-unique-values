import * as assert from 'assert';
import { parseRow } from '../../csv/core/rowParser';

suite('rowParser', () => {
    test('plain fields', () => {
        assert.deepStrictEqual(parseRow('a,b,c', ','), ['a', 'b', 'c']);
    });

    test('empty fields and trailing delimiter', () => {
        assert.deepStrictEqual(parseRow('a,,c', ','), ['a', '', 'c']);
        assert.deepStrictEqual(parseRow('a,b,', ','), ['a', 'b', '']);
    });

    test('quoted field with delimiter', () => {
        assert.deepStrictEqual(parseRow('"Blue, large",10', ','), ['Blue, large', '10']);
    });

    test('doubled quotes unescape', () => {
        assert.deepStrictEqual(parseRow('"he said ""hi""",2', ','), ['he said "hi"', '2']);
    });

    test('newline inside quotes is kept', () => {
        assert.deepStrictEqual(parseRow('"x\ny",2\n', ','), ['x\ny', '2']);
    });

    test('trailing CRLF and blank lines are dropped', () => {
        assert.deepStrictEqual(parseRow('a,b\r\n', ','), ['a', 'b']);
        assert.deepStrictEqual(parseRow('a,b\n\n\n', ','), ['a', 'b']);
    });

    test('quote inside an unquoted field is literal', () => {
        assert.deepStrictEqual(parseRow('ab"c,d', ','), ['ab"c', 'd']);
    });

    test('other delimiters', () => {
        assert.deepStrictEqual(parseRow('a;"b;c";d', ';'), ['a', 'b;c', 'd']);
        assert.deepStrictEqual(parseRow('a\tb', '\t'), ['a', 'b']);
    });

    test('empty quoted field', () => {
        assert.deepStrictEqual(parseRow('"",x', ','), ['', 'x']);
    });

    test('unterminated quote falls back to a plain split', () => {
        assert.deepStrictEqual(parseRow('"oops,1\n', ','), ['"oops', '1']);
    });
});
