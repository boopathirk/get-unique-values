import * as assert from 'assert';
import { GrowableF64, ResultSet, coalesce } from '../../csv/core/resultSet';

suite('resultSet', () => {
    test('GrowableF64 grows past its initial capacity', () => {
        const g = new GrowableF64();
        for (let i = 0; i < 5000; i++) {
            g.push(i * 2);
        }
        assert.strictEqual(g.length, 5000);
        assert.strictEqual(g.get(0), 0);
        assert.strictEqual(g.get(4999), 9998);
    });

    test('GrowableF64 stores values above 2^32', () => {
        const g = new GrowableF64();
        g.push(5_000_000_000);
        assert.strictEqual(g.get(0), 5_000_000_000);
    });

    test('ResultSet grows and slices', () => {
        const r = new ResultSet();
        for (let i = 0; i < 3000; i++) {
            r.push(i);
        }
        assert.strictEqual(r.length, 3000);
        assert.deepStrictEqual(r.slice(2, 5), [2, 3, 4]);
        assert.deepStrictEqual(r.slice(2998, 5000), [2998, 2999]);
        assert.deepStrictEqual(r.slice(10, 10), []);
    });

    test('coalesce merges consecutive numbers into runs', () => {
        assert.deepStrictEqual(coalesce([1, 2, 3, 7, 8, 10]), [[1, 3], [7, 2], [10, 1]]);
        assert.deepStrictEqual(coalesce([]), []);
        assert.deepStrictEqual(coalesce([5]), [[5, 1]]);
    });
});
