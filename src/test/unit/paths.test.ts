import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSameFile, partPath, samePath } from '../../csv/core/paths';

suite('paths', () => {
    test('samePath resolves . and .. segments', () => {
        assert.strictEqual(samePath('/a/b/../c.csv', '/a/c.csv', 'linux'), true);
        assert.strictEqual(samePath('/a/./c.csv', '/a/c.csv', 'linux'), true);
        assert.strictEqual(samePath('/a/c.csv', '/a/d.csv', 'linux'), false);
    });

    test('samePath ignores case only on Windows and macOS', () => {
        assert.strictEqual(samePath('/a/Data.CSV', '/a/data.csv', 'linux'), false);
        assert.strictEqual(samePath('/a/Data.CSV', '/a/data.csv', 'darwin'), true);
        assert.strictEqual(samePath('/a/Data.CSV', '/a/data.csv', 'win32'), true);
    });

    test('partPath adds a random .part suffix next to the target', () => {
        const a = partPath('/x/out.csv');
        const b = partPath('/x/out.csv');
        assert.match(a, /^\/x\/out\.csv\.[0-9a-f]{8}\.part$/);
        assert.notStrictEqual(a, b);
    });

    test('isSameFile sees through hard links and missing files', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-paths-'));
        try {
            const a = path.join(dir, 'a.csv');
            const b = path.join(dir, 'b.csv');
            fs.writeFileSync(a, 'x');
            fs.writeFileSync(b, 'x');
            fs.linkSync(a, path.join(dir, 'link.csv'));
            assert.strictEqual(await isSameFile(a, a), true);
            assert.strictEqual(await isSameFile(a, path.join(dir, 'link.csv')), true);
            assert.strictEqual(await isSameFile(a, b), false);
            assert.strictEqual(await isSameFile(a, path.join(dir, 'missing.csv')), false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
