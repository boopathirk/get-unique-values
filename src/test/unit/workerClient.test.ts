import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkerClient } from '../../csv/WorkerClient';
import type { WorkerMessage } from '../../csv/protocol';
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

suite('WorkerClient lifecycle', function () {
    this.timeout(20000);

    test('dispose does not report a fatal error', async () => {
        const client = new WorkerClient(workerPath);
        const fatals: string[] = [];
        client.onFatal = (m) => fatals.push(m);
        client.dispose();
        await client.terminateForTest(); // resolves once the worker thread has exited
        assert.deepStrictEqual(fatals, []);
    });

    test('request after dispose rejects', async () => {
        const client = new WorkerClient(workerPath);
        client.dispose();
        await assert.rejects(client.request({ type: 'nonEmptyColumns' }).promise, /not running/);
        client.cancel(1);
    });

    test('an unexpectedly killed worker reports once and later requests reject', async () => {
        const client = new WorkerClient(workerPath);
        const fatals: string[] = [];
        client.onFatal = (m) => fatals.push(m);
        await client.terminateForTest();
        await waitFor(() => fatals.length > 0);
        assert.strictEqual(fatals.length, 1);
        assert.strictEqual(client.alive, false);
        await assert.rejects(client.request({ type: 'nonEmptyColumns' }).promise, /not running/);
        client.dispose();
    });
});

suite('WorkerClient open edge cases', function () {
    this.timeout(20000);
    let dir: string;
    let client: WorkerClient;

    suiteSetup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-worker-open-'));
        client = new WorkerClient(workerPath);
    });

    suiteTeardown(() => {
        client.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a file with only blank lines opens as empty', async () => {
        const f = path.join(dir, 'blank.csv');
        fs.writeFileSync(f, '\n\n\n');
        const res = await client.request<OpenResult>({ type: 'open', path: f, options: {} }).promise;
        assert.strictEqual(res.kind, 'empty');
    });

    test('overlapping opens all resolve and the last file wins', async () => {
        const files = ['a', 'b', 'c'].map((n) => {
            const f = path.join(dir, `${n}.csv`);
            fs.writeFileSync(f, `h\n${n}1\n${n}2\n`);
            return f;
        });
        const results = await Promise.all(
            files.map((f) => client.request<OpenResult>({ type: 'open', path: f, options: {} }).promise),
        );
        assert.deepStrictEqual(results.map((r) => r.kind), ['ok', 'ok', 'ok']);
        const page = await client.request<PageResult>({ type: 'page', page: 0, pageSize: 10 }).promise;
        assert.deepStrictEqual(page.rows, [['c1'], ['c2']]);
    });
});

suite('WorkerClient message handling', function () {
    this.timeout(20000);

    const progress = (id: number): WorkerMessage => ({
        type: 'progress', id,
        data: { rows: 1, bytes: 1, total: 10, done: false, badRows: 0, warnings: [] },
    });

    test('a new open drops the lingering progress handler of the previous open', async () => {
        const client = new WorkerClient(workerPath);
        const missing = path.join(os.tmpdir(), 'csv-worker-does-not-exist.csv');
        let events = 0;
        const first = client.request<OpenResult>({ type: 'open', path: missing, options: {} }, () => { events++; });
        first.promise.catch(() => undefined);
        // Everything below runs synchronously, before the real worker can answer.
        client.deliverForTest({ type: 'result', id: first.id, data: { kind: 'empty' } });
        client.deliverForTest(progress(first.id));
        assert.strictEqual(events, 1, 'index progress keeps flowing after open resolved');
        const second = client.request<OpenResult>({ type: 'open', path: missing, options: {} });
        second.promise.catch(() => undefined);
        client.deliverForTest(progress(first.id));
        assert.strictEqual(events, 1, 'stale handler must not be called after a new open');
        client.dispose();
    });

    test('messages arriving after dispose are ignored', () => {
        const client = new WorkerClient(workerPath);
        const fatals: string[] = [];
        client.onFatal = (m) => fatals.push(m);
        client.dispose();
        client.deliverForTest({ type: 'fatal', message: 'late' });
        assert.deepStrictEqual(fatals, []);
    });
});
