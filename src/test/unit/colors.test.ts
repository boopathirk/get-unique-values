import * as assert from 'assert';
import { columnColor, columnHue } from '../../csv/core/colors';

suite('colors', () => {
    const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

    test('neighbouring columns differ by roughly the golden angle', () => {
        for (let i = 0; i < 40; i++) {
            assert.ok(gap(columnHue(i), columnHue(i + 1)) > 100, `columns ${i}/${i + 1}`);
        }
    });

    test('the first 20 hues are all distinct', () => {
        for (let i = 0; i < 20; i++) {
            for (let j = i + 1; j < 20; j++) {
                assert.ok(gap(columnHue(i), columnHue(j)) > 5, `columns ${i}/${j}`);
            }
        }
    });

    test('theme variants', () => {
        assert.match(columnColor(1, 'light').headerBg, /^hsl\(/);
        assert.match(columnColor(1, 'dark').headerBg, /^hsl\(/);
        assert.strictEqual(columnColor(1, 'high-contrast').headerBg, 'transparent');
        assert.match(columnColor(1, 'high-contrast').edge, /^hsl\(/);
    });
});
