import * as assert from 'assert';
import { StatsAccumulator, detectColumnType } from '../../csv/core/columnStats';

suite('detectColumnType', () => {
    test('integers', () => assert.strictEqual(detectColumnType(['1', '22', '-3', '+4']), 'integer'));
    test('numbers', () => assert.strictEqual(detectColumnType(['1.5', '2', '3e4']), 'number'));
    test('booleans', () => assert.strictEqual(detectColumnType(['true', 'FALSE', 'Yes', 'no']), 'boolean'));
    test('dates', () => assert.strictEqual(detectColumnType(['2024-01-31', '2024-02-01T10:20:30Z', '2024-03-04 05:06']), 'date'));
    test('urls', () => assert.strictEqual(detectColumnType(['https://a.com/x', 'http://b.org']), 'url'));
    test('emails', () => assert.strictEqual(detectColumnType(['a@b.com', 'c.d@e.org']), 'email'));
    test('json', () => assert.strictEqual(detectColumnType(['{"a":1}', '[1,2]']), 'json'));
    test('html', () => assert.strictEqual(detectColumnType(['<p>x</p>', '<b>y</b>']), 'html'));
    test('ignores blanks', () => assert.strictEqual(detectColumnType(['1', '', '  ', '2']), 'integer'));
    test('95% rule: 1 bad of 20 still integer', () => {
        assert.strictEqual(detectColumnType([...Array(19).fill('7'), 'x']), 'integer');
    });
    test('below 95% is text', () => assert.strictEqual(detectColumnType(['1', '2', 'x', 'y']), 'text'));
    test('empty input is text', () => assert.strictEqual(detectColumnType([]), 'text'));
});

suite('StatsAccumulator', () => {
    test('numeric column', () => {
        const a = new StatsAccumulator(2);
        for (const v of ['10', '2', '', '30', '2']) {
            a.add(v);
        }
        const r = a.result();
        assert.strictEqual(r.column, 2);
        assert.strictEqual(r.type, 'integer');
        assert.strictEqual(r.rows, 5);
        assert.strictEqual(r.empty, 1);
        assert.strictEqual(r.distinct, 3);
        assert.strictEqual(r.numeric, true);
        assert.strictEqual(r.min, '2');
        assert.strictEqual(r.max, '30');
        assert.strictEqual(r.minLen, 1);
        assert.strictEqual(r.maxLen, 2);
        assert.strictEqual(r.avgLen, 1.5);
        assert.deepStrictEqual(r.samples, ['10', '2', '30']);
    });
    test('text column uses lexicographic min/max', () => {
        const a = new StatsAccumulator(0);
        for (const v of ['pear', 'apple', 'zed']) {
            a.add(v);
        }
        const r = a.result();
        assert.strictEqual(r.numeric, false);
        assert.strictEqual(r.min, 'apple');
        assert.strictEqual(r.max, 'zed');
    });
    test('distinct is capped', () => {
        const a = new StatsAccumulator(0, 3);
        for (const v of ['a', 'b', 'c', 'd', 'e']) {
            a.add(v);
        }
        const r = a.result();
        assert.strictEqual(r.distinct, 3);
        assert.strictEqual(r.distinctCapped, true);
    });
    test('all empty', () => {
        const a = new StatsAccumulator(0);
        a.add('');
        a.add(' ');
        const r = a.result();
        assert.strictEqual(r.empty, 2);
        assert.strictEqual(r.distinct, 0);
        assert.strictEqual(r.min, '');
        assert.strictEqual(r.type, 'text');
    });
});
