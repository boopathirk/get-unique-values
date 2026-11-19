import { Worker } from 'worker_threads';
import type { ExportProgress, FilterProgress, ImportProgress, IndexProgress } from './types';
import type { RequestBody, WorkerMessage, WorkerRequest } from './protocol';

type Progress = IndexProgress | FilterProgress | ExportProgress | ImportProgress;

/**
 * A request that can never be answered because its worker is gone: disposed by the host (viewer closed,
 * retry, reopen) or died unexpectedly. Callers use `reason` to decide whether to tell the user.
 */
export class WorkerDisposedError extends Error {
    constructor(readonly reason: 'disposed' | 'died', message: string) {
        super(message);
        this.name = 'WorkerDisposedError';
    }
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    onProgress?: (p: Progress) => void;
    keepProgress: boolean;
    doneSeen: boolean;
}

export class WorkerClient {
    private readonly worker: Worker;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();
    /** Progress handlers that outlive their request (index progress after `open` resolved). */
    private readonly lingering = new Map<number, (p: Progress) => void>();

    private disposed = false;
    private dead = false;

    onFatal: (message: string) => void = () => undefined;

    constructor(workerPath: string) {
        this.worker = new Worker(workerPath);
        this.worker.on('message', (m: WorkerMessage) => this.onMessage(m));
        this.worker.on('error', (e) => this.failAll(e instanceof Error ? e : new Error(String(e))));
        this.worker.on('exit', (code) => {
            // Any exit is unexpected unless dispose() ran (failAll ignores disposed clients).
            this.failAll(new Error(`The CSV worker stopped unexpectedly (exit code ${code}).`));
        });
    }

    request<T>(body: RequestBody, onProgress?: (p: Progress) => void): { id: number; promise: Promise<T> } {
        const id = this.nextId++;
        if (this.dead || this.disposed) {
            return { id, promise: Promise.reject(new WorkerDisposedError(this.disposed ? 'disposed' : 'died', 'The CSV worker is not running.')) };
        }
        if (body.type === 'open') {
            // A new open replaces the previous file: drop index-progress handlers of the old one.
            this.lingering.clear();
        }
        const promise = new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                onProgress,
                keepProgress: body.type === 'open',
                doneSeen: false,
            });
        });
        this.worker.postMessage({ ...body, id } as WorkerRequest);
        return { id, promise };
    }

    cancel(target: number): void {
        if (this.dead || this.disposed) {
            return;
        }
        const message: WorkerRequest = { id: 0, type: 'cancel', target };
        this.worker.postMessage(message);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const all = [...this.pending.values()];
        this.pending.clear();
        this.lingering.clear();
        void this.worker.terminate();
        const error = new WorkerDisposedError('disposed', 'The CSV worker was stopped.');
        for (const p of all) {
            p.reject(error);
        }
    }

    /** True while the worker thread is usable (not disposed and has not died). */
    get alive(): boolean {
        return !this.dead && !this.disposed;
    }

    /** Test-only: kill the worker thread without calling dispose(), simulating a crash. */
    terminateForTest(): Promise<number> {
        return this.worker.terminate();
    }

    /** Test-only: feed a message through the normal worker message path. */
    deliverForTest(m: WorkerMessage): void {
        this.onMessage(m);
    }

    private onMessage(m: WorkerMessage): void {
        if (this.disposed) {
            return;
        }
        switch (m.type) {
            case 'result': {
                const p = this.pending.get(m.id);
                this.pending.delete(m.id);
                if (p?.onProgress && p.keepProgress && !p.doneSeen) {
                    this.lingering.set(m.id, p.onProgress);
                }
                p?.resolve(m.data);
                break;
            }
            case 'failure': {
                const p = this.pending.get(m.id);
                this.pending.delete(m.id);
                this.lingering.delete(m.id);
                p?.reject(new Error(m.message));
                break;
            }
            case 'progress': {
                const p = this.pending.get(m.id);
                const handler = p?.onProgress ?? this.lingering.get(m.id);
                handler?.(m.data);
                if ('done' in m.data && typeof m.data.done === 'boolean' && m.data.done) {
                    if (p) {
                        p.doneSeen = true;
                    }
                    this.lingering.delete(m.id);
                }
                break;
            }
            case 'fatal':
                this.onFatal(m.message);
                break;
        }
    }

    private failAll(error: Error): void {
        if (this.dead || this.disposed) {
            return;
        }
        this.dead = true;
        const all = [...this.pending.values()];
        this.pending.clear();
        this.lingering.clear();
        const died = new WorkerDisposedError('died', error.message);
        for (const p of all) {
            p.reject(died);
        }
        this.onFatal(error.message);
    }
}
