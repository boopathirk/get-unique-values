import * as assert from 'assert';
import { detect, detectDelimiter, detectEncoding, guessHasHeader, splitRecords } from '../../csv/core/detect';

suite('detect', () => {
    test('UTF-8 BOM', () => {
        const r = detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
        assert.deepStrictEqual(r, { encoding: 'utf-8', bomLength: 3 });
    });

    test('UTF-16 BOMs', () => {
        assert.deepStrictEqual(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00])), { encoding: 'utf-16le', bomLength: 2 });
        assert.deepStrictEqual(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61])), { encoding: 'utf-16be', bomLength: 2 });
    });

    test('valid multi-byte UTF-8 and a sample cut mid-character are utf-8', () => {
        assert.strictEqual(detectEncoding(Buffer.from('café,ü')).encoding, 'utf-8');
        assert.strictEqual(detectEncoding(Buffer.from('café').subarray(0, 4)).encoding, 'utf-8');
    });

    test('invalid UTF-8 falls back to latin1', () => {
        assert.strictEqual(detectEncoding(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])).encoding, 'latin1');
    });

    test('splitRecords respects quotes and caps the count', () => {
        assert.deepStrictEqual(splitRecords('a,b\n"x\ny",2\r\nz,3\n', 10), ['a,b', '"x\ny",2', 'z,3']);
        assert.deepStrictEqual(splitRecords('a\nb\nc\n', 2), ['a', 'b']);
        assert.deepStrictEqual(splitRecords('a;b;c', 5), ['a;b;c']);
    });

    test('delimiter detection', () => {
        assert.strictEqual(detectDelimiter('a,b,c\n1,2,3\n4,5,6\n'), ',');
        assert.strictEqual(detectDelimiter('a;b;c\n1;2;3\n4;5;6\n'), ';');
        assert.strictEqual(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
        assert.strictEqual(detectDelimiter('a|b|c\n1|2|3\n'), '|');
        assert.strictEqual(detectDelimiter('single\ncolumn\nfile\n'), ',');
    });

    test('decimal commas do not beat the real semicolon delimiter', () => {
        assert.strictEqual(detectDelimiter('name;price\nA;1,5\nB;2,5\n'), ';');
    });

    test('quoted delimiters are ignored when detecting', () => {
        assert.strictEqual(detectDelimiter('a,b\n"x;y;z",2\n"p;q;r",3\n'), ',');
    });

    test('header guess', () => {
        assert.strictEqual(guessHasHeader(['id', 'name', 'price']), true);
        assert.strictEqual(guessHasHeader(['1', '2', '3']), false);
        assert.strictEqual(guessHasHeader(['', '', 'x']), false);
        assert.strictEqual(guessHasHeader(['sku', '2024', 'name']), true);
    });

    test('detect() ties it together', () => {
        const d = detect(Buffer.from('﻿id;name\n1;A\n2;B\n', 'utf8'));
        assert.deepStrictEqual(d, { encoding: 'utf-8', bomLength: 3, binary: false, delimiter: ';', hasHeader: true });
    });

    test('NUL bytes mean binary (except in UTF-16)', () => {
        assert.strictEqual(detect(Buffer.from([0x61, 0x00, 0x62, 0x0a])).binary, true);
        assert.strictEqual(detect(Buffer.from([0xff, 0xfe, 0x61, 0x00])).binary, false);
    });
});
