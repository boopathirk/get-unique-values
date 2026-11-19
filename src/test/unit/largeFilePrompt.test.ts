import * as assert from 'assert';
import { shouldPrompt } from '../../csv/core/largeFile';

suite('shouldPrompt', () => {
    const MB = 1024 * 1024;
    test('large csv prompts', () => assert.strictEqual(shouldPrompt(30 * MB, 20, 'a.csv'), true));
    test('tsv and psv prompt', () => {
        assert.strictEqual(shouldPrompt(30 * MB, 20, 'a.tsv'), true);
        assert.strictEqual(shouldPrompt(30 * MB, 20, 'A.PSV'), true);
    });
    test('small file does not prompt', () => assert.strictEqual(shouldPrompt(5 * MB, 20, 'a.csv'), false));
    test('exactly at the threshold does not prompt', () => assert.strictEqual(shouldPrompt(20 * MB, 20, 'a.csv'), false));
    test('other extensions never prompt', () => assert.strictEqual(shouldPrompt(90 * MB, 20, 'a.log'), false));
    test('threshold 0 disables the prompt', () => assert.strictEqual(shouldPrompt(90 * MB, 0, 'a.csv'), false));
});
