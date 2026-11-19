import * as assert from 'assert';
import {
    MAX_RECENT, clearRecent, emptyRecent, removeRecent, sanitizeRecent, toggleFavorite, touch,
} from '../../sidebar/recentStore';

suite('recentStore', () => {
    test('touch adds to the front and de-duplicates', () => {
        let s = emptyRecent();
        s = touch(s, 'file:///a.csv', 1);
        s = touch(s, 'file:///b.csv', 2);
        s = touch(s, 'file:///a.csv', 3);
        assert.deepStrictEqual(s.recent.map((r) => r.uri), ['file:///a.csv', 'file:///b.csv']);
        assert.strictEqual(s.recent[0].at, 3);
    });
    test('touch caps the list', () => {
        let s = emptyRecent();
        for (let i = 0; i < MAX_RECENT + 5; i++) {
            s = touch(s, `file:///${i}.csv`, i);
        }
        assert.strictEqual(s.recent.length, MAX_RECENT);
        assert.strictEqual(s.recent[0].uri, `file:///${MAX_RECENT + 4}.csv`);
    });
    test('toggleFavorite adds then removes', () => {
        let s = toggleFavorite(emptyRecent(), 'file:///a.csv');
        assert.deepStrictEqual(s.favorites, ['file:///a.csv']);
        s = toggleFavorite(s, 'file:///a.csv');
        assert.deepStrictEqual(s.favorites, []);
    });
    test('removeRecent also unfavorites', () => {
        let s = touch(emptyRecent(), 'file:///a.csv', 1);
        s = toggleFavorite(s, 'file:///a.csv');
        s = removeRecent(s, 'file:///a.csv');
        assert.deepStrictEqual(s, emptyRecent());
    });
    test('clearRecent keeps favorites', () => {
        let s = touch(emptyRecent(), 'file:///a.csv', 1);
        s = toggleFavorite(s, 'file:///a.csv');
        s = clearRecent(s);
        assert.deepStrictEqual(s.recent, []);
        assert.deepStrictEqual(s.favorites, ['file:///a.csv']);
    });
    test('sanitizeRecent survives garbage', () => {
        assert.deepStrictEqual(sanitizeRecent(null), emptyRecent());
        assert.deepStrictEqual(sanitizeRecent({ recent: [{ uri: 5 }, { uri: 'x', at: 1 }], favorites: [1, 'y'] }), {
            recent: [{ uri: 'x', at: 1 }],
            favorites: ['y'],
        });
    });
});
