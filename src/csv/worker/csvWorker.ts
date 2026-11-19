import { parentPort } from 'worker_threads';
import { CsvEngine } from '../core/engine';
import { exportToFile } from '../export/exportFile';
import type { CancelToken } from '../types';
import type { WorkerMessage, WorkerRequest } from '../protocol';

const port = parentPort;
if (!port) {
    throw new Error('csvWorker must run in a worker thread');
}

let engine: CsvEngine | undefined;
let indexToken: CancelToken | undefined;
const tokens = new Map<number, CancelToken>();

function send(message: WorkerMessage): void {
    port?.postMessage(message);
}

function getEngine(): CsvEngine {
    if (!engine) {
        throw new Error('No file is open.');
    }
    return engine;
}

function tokenFor(id: number): CancelToken {
    const token: CancelToken = { cancelled: false };
    tokens.set(id, token);
    return token;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

let openChain: Promise<void> = Promise.resolve();

async function doOpen(req: Extract<WorkerRequest, { type: 'open' }>): Promise<void> {
    if (indexToken) {
        indexToken.cancelled = true;
    }
    await engine?.dispose();
    const next = new CsvEngine(req.path, req.options);
    engine = next;
    const opened = await next.open();
    if (opened.kind !== 'ready') {
        send({ type: 'result', id: req.id, data: opened });
        return;
    }
    const token: CancelToken = { cancelled: false };
    indexToken = token;
    next.index((p) => send({ type: 'progress', id: req.id, data: p }), token)
        .catch((err) => send({ type: 'fatal', message: errorMessage(err) }));
    let info;
    try {
        info = await next.getInfo();
    } catch (err) {
        token.cancelled = true;
        await next.dispose();
        throw err;
    }
    if (info.columnCount === 0 && next.indexed) {
        send({ type: 'result', id: req.id, data: { kind: 'empty' } });
        return;
    }
    send({ type: 'result', id: req.id, data: { kind: 'ok', info } });
}

async function handle(req: WorkerRequest): Promise<void> {
    try {
        switch (req.type) {
            case 'cancel': {
                const token = tokens.get(req.target);
                if (token) {
                    token.cancelled = true;
                }
                return;
            }
            case 'open': {
                // Serialise opens so overlapping requests never leak an engine or file descriptor.
                const run = openChain.then(() => doOpen(req));
                openChain = run.catch(() => undefined);
                await run;
                return;
            }
            case 'page':
                send({ type: 'result', id: req.id, data: await getEngine().readPage(req.page, req.pageSize) });
                return;
            case 'filter': {
                const token = tokenFor(req.id);
                try {
                    const result = await getEngine().filter(req.predicates, token, (p) =>
                        send({ type: 'progress', id: req.id, data: p }));
                    send({ type: 'result', id: req.id, data: result });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
            case 'unique': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().uniqueValues(req.column, token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
            case 'stats': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().columnStats(req.column, token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
            case 'duplicates': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().duplicateKeys(req.columns, token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
            case 'nonEmptyColumns': {
                const token = tokenFor(req.id);
                try {
                    send({ type: 'result', id: req.id, data: await getEngine().nonEmptyColumns(token) });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
            case 'export': {
                const token = tokenFor(req.id);
                try {
                    const result = await exportToFile(getEngine(), req.options, token, (done, total) =>
                        send({ type: 'progress', id: req.id, data: { done, total } }));
                    send({ type: 'result', id: req.id, data: result });
                } finally {
                    tokens.delete(req.id);
                }
                return;
            }
        }
    } catch (err) {
        send({ type: 'failure', id: req.id, message: errorMessage(err) });
    }
}

port.on('message', (req: WorkerRequest) => {
    void handle(req);
});
