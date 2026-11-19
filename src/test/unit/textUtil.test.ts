import * as assert from 'assert';
import { csvEscape, guessLanguage, prettyJson, rowToCsv, rowToJson, truncateText } from '../../csv/core/textUtil';

suite('textUtil', () => {
    test('guessLanguage', () => {
        assert.strictEqual(guessLanguage('{"a":1}'), 'json');
        assert.strictEqual(guessLanguage('[1,2]'), 'json');
        assert.strictEqual(guessLanguage('{not json}'), 'plaintext');
        assert.strictEqual(guessLanguage('<p>Hello <b>x</b></p>'), 'html');
        assert.strictEqual(guessLanguage('1 < 2 and 3 > 2'), 'plaintext');
        assert.strictEqual(guessLanguage('plain'), 'plaintext');
    });

    test('prettyJson', () => {
        assert.strictEqual(prettyJson('{"a":1}'), '{\n  "a": 1\n}');
    });

    test('csvEscape / rowToCsv', () => {
        assert.strictEqual(csvEscape('plain', ','), 'plain');
        assert.strictEqual(csvEscape('a,b', ','), '"a,b"');
        assert.strictEqual(csvEscape('say "hi"', ','), '"say ""hi"""');
        assert.strictEqual(csvEscape('a;b', ';'), '"a;b"');
        assert.strictEqual(csvEscape('x\ny', ','), '"x\ny"');
        assert.strictEqual(rowToCsv(['a', 'b,c', ''], ','), 'a,"b,c",');
    });

    test('rowToJson keys by header and pads missing fields', () => {
        assert.strictEqual(rowToJson(['a', 'b'], ['1']), '{\n  "a": "1",\n  "b": ""\n}');
        assert.strictEqual(rowToJson(['', 'b'], ['1', '2']), '{\n  "Column 1": "1",\n  "b": "2"\n}');
    });

    test('truncateText', () => {
        assert.strictEqual(truncateText('abc', 5), 'abc');
        assert.strictEqual(truncateText('abcdef', 3), 'abc…');
    });
});
