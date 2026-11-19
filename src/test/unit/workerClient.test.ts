import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerClient } from '../../csv/WorkerClient';
import type { FilterResult, IndexProgress, OpenResult, PageResult, UniqueResult } from '../../csv/types';

// out-test/test/unit -> repo root -> out/csvWorker.js (built by `npm run test:unit` via esbuild)
const workerPath = path.resolve(__dirname, '../../../out/csvWorker.js');

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) {
            throw new Error('timed out');
        }
        await new Promise((r) => setTimeout(r, 10));
    }
}

suite('WorkerClient', function () {
    this.timeout(20000);
    let dir: string;
    let file: string;
    let client: WorkerClient;

    suiteSetup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-worker-'));
        file = path.join(dir, 't.csv');
        fs.writeFileSync(file, 'sku,name\nA1,Blue\nA2,Red\nA3,Blue\n');
        client = new WorkerClient(workerPath);
    });

    suiteTeardown(() => {
        client.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('open returns info and index progress keeps flowing until done', async () => {
        const progress: IndexProgress[] = [];
        const res = await client.request<OpenResult>({ type: 'open', path: file, options: {} }, (p) => progress.push(p as IndexProgress)).promise;
        assert.strictEqual(res.kind, 'ok');
        if (res.kind === 'ok') {
            assert.deepStrictEqual(res.info.header, ['sku', 'name']);
        }
        await waitFor(() => progress.some((p) => p.done));
        assert.strictEqual(progress[progress.length - 1].rows, 3);
    });

    test('page', async () => {
        const page = await client.request<PageResult>({ type: 'page', page: 0, pageSize: 10 }).promise;
        assert.deepStrictEqual(page.rows, [['A1', 'Blue'], ['A2', 'Red'], ['A3', 'Blue']]);
        assert.strictEqual(page.total, 3);
    });

    test('filter then page', async () => {
        const mode = { caseSensitive: false, wholeCell: false, regex: false };
        const result = await client.request<FilterResult>({
            type: 'filter', predicates: [{ kind: 'search', query: 'blue', column: null, mode }],
        }).promise;
        assert.deepStrictEqual(result, { matches: 2, complete: true });
        const page = await client.request<PageResult>({ type: 'page', page: 0, pageSize: 10 }).promise;
        assert.deepStrictEqual(page.rowNumbers, [0, 2]);
    });

    test('unique values', async () => {
        const result = await client.request<UniqueResult | null>({ type: 'unique', column: 1 }).promise;
        assert.deepStrictEqual(result?.entries, [{ value: 'Blue', count: 2 }, { value: 'Red', count: 1 }]);
    });

    test('an invalid regex rejects with a readable message', async () => {
        const mode = { caseSensitive: false, wholeCell: false, regex: true };
        await assert.rejects(
            client.request<FilterResult>({ type: 'filter', predicates: [{ kind: 'search', query: '(', column: null, mode }] }).promise,
            /Invalid regular expression/,
        );
    });

    test('opening a missing file rejects', async () => {
        await assert.rejects(
            client.request<OpenResult>({ type: 'open', path: path.join(dir, 'missing.csv'), options: {} }).promise,
            /ENOENT/,
        );
    });
});
