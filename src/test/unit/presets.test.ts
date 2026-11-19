import * as assert from 'assert';
import { describePreset, removePreset, sanitizePresets, upsertPreset } from '../../csv/core/presets';

suite('presets', () => {
    test('sanitize keeps valid presets and drops junk', () => {
        const out = sanitizePresets([
            { name: 'EU', delimiter: ';', hasHeader: true, encoding: 'latin1' },
            { name: '', delimiter: ',' },
            { delimiter: ',' },
            { name: 'Bad', delimiter: ';;', encoding: 'ebcdic' },
            'x',
        ]);
        assert.deepStrictEqual(out, [
            { name: 'EU', delimiter: ';', hasHeader: true, encoding: 'latin1' },
            { name: 'Bad' },
        ]);
    });
    test('sanitize of a non-array is empty', () => assert.deepStrictEqual(sanitizePresets(undefined), []));
    test('upsert replaces by name ignoring case', () => {
        const list = upsertPreset([{ name: 'EU', delimiter: ';' }], { name: 'eu', delimiter: '|' });
        assert.deepStrictEqual(list, [{ name: 'eu', delimiter: '|' }]);
    });
    test('upsert appends a new name', () => {
        assert.strictEqual(upsertPreset([{ name: 'A' }], { name: 'B' }).length, 2);
    });
    test('remove by name', () => {
        assert.deepStrictEqual(removePreset([{ name: 'A' }, { name: 'B' }], 'a'), [{ name: 'B' }]);
    });
    test('describe', () => {
        assert.strictEqual(describePreset({ name: 'x', delimiter: ';', hasHeader: false, encoding: 'utf-8' }), '; · no header · utf-8');
        assert.strictEqual(describePreset({ name: 'x' }), 'auto-detect');
    });
});
