import * as assert from 'assert';
import { PAGE_SIZES, defaultLayout, headerHash, matchColumns, moveItem, sanitizeLayout, visibleColumns } from '../../csv/core/layout';

const D = { pageSize: 100, longText: 'truncate', colorMode: 'headerAndCells' } as const;

suite('layout', () => {
    test('headerHash is stable and sensitive to changes', () => {
        assert.strictEqual(headerHash(['a', 'b']), headerHash(['a', 'b']));
        assert.notStrictEqual(headerHash(['a', 'b']), headerHash(['a', 'c']));
        assert.notStrictEqual(headerHash(['a', 'b']), headerHash(['ab']));
    });

    test('defaultLayout', () => {
        const l = defaultLayout(3, D);
        assert.deepStrictEqual(l.order, [0, 1, 2]);
        assert.deepStrictEqual(l.hidden, []);
        assert.strictEqual(l.pinned, 0);
        assert.strictEqual(l.pageSize, 100);
        assert.deepStrictEqual(l.sets, {});
    });

    test('sanitizeLayout falls back on garbage', () => {
        assert.deepStrictEqual(sanitizeLayout(null, 3, D), defaultLayout(3, D));
        assert.deepStrictEqual(sanitizeLayout('x', 3, D), defaultLayout(3, D));
    });

    test('sanitizeLayout keeps valid fields and drops invalid ones', () => {
        const saved = {
            hidden: [1, 1, 9, -1, 'x'], order: [2, 0, 1], widths: { '0': 200, '9': 100, '1': 5 },
            pinned: 2, pageSize: 250, longText: 'wrap', colorMode: 'off',
            sets: { good: { hidden: [0], order: [1, 0, 2] }, bad: { hidden: [], order: [0, 0, 1] } },
        };
        const l = sanitizeLayout(saved, 3, D);
        assert.deepStrictEqual(l.hidden, [1]);
        assert.deepStrictEqual(l.order, [2, 0, 1]);
        assert.deepStrictEqual(l.widths, { '0': 200 });
        assert.strictEqual(l.pinned, 2);
        assert.strictEqual(l.pageSize, 250);
        assert.strictEqual(l.longText, 'wrap');
        assert.strictEqual(l.colorMode, 'off');
        assert.deepStrictEqual(Object.keys(l.sets), ['good']);
    });

    test('sanitizeLayout rejects a non-permutation order and bad enums', () => {
        const l = sanitizeLayout({ order: [0, 0, 1], pageSize: 77, longText: 'x', colorMode: 'y', pinned: 9 }, 3, D);
        assert.deepStrictEqual(l.order, [0, 1, 2]);
        assert.strictEqual(l.pageSize, 100);
        assert.strictEqual(l.longText, 'truncate');
        assert.strictEqual(l.colorMode, 'headerAndCells');
        assert.strictEqual(l.pinned, 0);
        assert.ok(PAGE_SIZES.includes(l.pageSize));
    });

    test('visibleColumns and moveItem', () => {
        const l = { ...defaultLayout(4, D), order: [3, 1, 0, 2], hidden: [1] };
        assert.deepStrictEqual(visibleColumns(l), [3, 0, 2]);
        assert.deepStrictEqual(moveItem([0, 1, 2, 3], 0, 2), [1, 2, 0, 3]);
        assert.deepStrictEqual(moveItem([0, 1, 2, 3], 3, 0), [3, 0, 1, 2]);
    });

    test('matchColumns uses regex, falls back to substring on invalid regex', () => {
        const header = ['SKU', 'Name', 'Price (USD)', 'price_eur'];
        assert.deepStrictEqual(matchColumns(header, '^price_'), [3]);
        assert.deepStrictEqual(matchColumns(header, 'price'), [2, 3]);
        assert.deepStrictEqual(matchColumns(header, '('), [2]);
    });
});
