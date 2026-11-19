import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { WorkerClient } from './WorkerClient';
import { PAGE_SIZES, headerHash, sanitizeLayout } from './core/layout';
import type { ColorMode, LongText } from './core/layout';
import type { Predicate } from './core/predicates';
import type { HostToView, ViewCommand, ViewToHost, ViewerSettings } from './protocol';
import type {
    FileInfo, FilterProgress, FilterResult, IndexProgress, OpenResult, PageResult, ParseOptions, UniqueResult,
} from './types';

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function statusMessage(result: Exclude<OpenResult, { kind: 'ok' }>): string {
    switch (result.kind) {
        case 'empty':
            return 'This file is empty.';
        case 'binary':
            return 'This looks like a binary file, not a CSV.';
        case 'unsupported-encoding':
            return `Encoding ${result.encoding} is not supported yet (planned for v0.2). Open the file in the text editor instead.`;
    }
}

/** Escape glob metacharacters so a file name is matched literally. */
function escapeGlob(name: string): string {
    return name.replace(/[[\]{}*?!]/g, (c) => `[${c}]`);
}

function isValidDelimiter(v: string): boolean {
    if (v.length !== 1 || v === '"') {
        return false;
    }
    const code = v.charCodeAt(0);
    return code === 9 || (code >= 32 && code <= 126);
}

type Item<T> = vscode.QuickPickItem & { value: T };

export class CsvSession implements vscode.Disposable {
    private worker: WorkerClient;
    private readonly disposables: vscode.Disposable[] = [];
    /** webview job id -> worker request id (the webview counts filter and unique jobs separately). */
    private readonly filterJobs = new Map<number, number>();
    private readonly uniqueJobs = new Map<number, number>();
    private disposed = false;
    private activeFilter: number | undefined;
    private parseOptions: ParseOptions;
    private info: FileInfo | undefined;
    private openGen = 0;

    /** Most recent page sent to the webview (read by the integration test). */
    lastPage: PageResult | undefined;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly uri: vscode.Uri,
        private readonly panel: vscode.WebviewPanel,
    ) {
        this.worker = this.createWorker();
        this.parseOptions = context.workspaceState.get<ParseOptions>(this.key('parse'), {});
    }

    start(): void {
        const webview = this.panel.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'out'),
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            ],
        };
        webview.html = this.html();
        this.disposables.push(webview.onDidReceiveMessage((m: ViewToHost) => void this.onMessage(m)));

        const dir = vscode.Uri.joinPath(this.uri, '..');
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, escapeGlob(path.basename(this.uri.fsPath))));
        this.disposables.push(
            watcher,
            watcher.onDidChange(() => this.post({ type: 'fileChanged', deleted: false })),
            watcher.onDidCreate(() => this.post({ type: 'fileChanged', deleted: false })),
            watcher.onDidDelete(() => this.post({ type: 'fileChanged', deleted: true })),
        );
    }

    /** Forward a keybinding command to the webview. */
    sendCommand(name: ViewCommand): void {
        this.post({ type: 'command', name });
    }

    private createWorker(): WorkerClient {
        const worker = new WorkerClient(path.join(this.context.extensionPath, 'out', 'csvWorker.js'));
        worker.onFatal = (message) => {
            if (worker === this.worker) {
                this.post({ type: 'error', message, retry: true });
            }
        };
        return worker;
    }

    dispose(): void {
        this.disposed = true;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.worker.dispose();
    }

    // ---- messages from the webview -----------------------------------------

    private async onMessage(m: ViewToHost): Promise<void> {
        try {
            await this.handleMessage(m);
        } catch (err) {
            this.post({ type: 'error', message: errorMessage(err) });
        }
    }

    private async handleMessage(m: ViewToHost): Promise<void> {
        switch (m.type) {
            case 'ready':
            case 'reload':
                await this.openFile();
                break;
            case 'retry':
                this.worker.dispose();
                this.worker = this.createWorker();
                await this.openFile();
                break;
            case 'getPage':
                await this.sendPage(m.reqId, m.page, m.pageSize);
                break;
            case 'filter':
                this.startFilter(m.jobId, m.predicates);
                break;
            case 'unique':
                this.startUnique(m.jobId, m.column);
                break;
            case 'cancel': {
                const id = (m.kind === 'unique' ? this.uniqueJobs : this.filterJobs).get(m.jobId);
                if (id !== undefined) {
                    this.worker.cancel(id);
                }
                break;
            }
            case 'nonEmpty':
                this.worker.request<number[] | null>({ type: 'nonEmptyColumns' }).promise.then(
                    (columns) => this.post({ type: 'nonEmpty', jobId: m.jobId, columns }),
                    (err) => this.post({ type: 'error', message: errorMessage(err) }),
                );
                break;
            case 'chooseParseOptions':
                await this.chooseParseOptions();
                break;
            case 'saveLayout':
                if (this.info) {
                    await this.context.workspaceState.update(this.layoutKey(this.info), m.layout);
                }
                break;
            case 'openInEditor': {
                const doc = await vscode.workspace.openTextDocument({ content: m.text, language: m.language });
                await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
                break;
            }
            case 'copy':
                await vscode.env.clipboard.writeText(m.text);
                break;
        }
    }

    private async openFile(): Promise<void> {
        const gen = ++this.openGen;
        this.filterJobs.clear();
        this.uniqueJobs.clear();
        this.activeFilter = undefined;
        try {
            const { promise } = this.worker.request<OpenResult>(
                { type: 'open', path: this.uri.fsPath, options: this.parseOptions },
                (p) => {
                    if (gen === this.openGen) {
                        this.post({ type: 'indexProgress', progress: p as IndexProgress });
                    }
                },
            );
            const result = await promise;
            if (gen !== this.openGen) {
                return;
            }
            if (result.kind !== 'ok') {
                this.post({ type: 'status', kind: result.kind, message: statusMessage(result) });
                return;
            }
            this.info = result.info;
            const settings = this.settings();
            const layout = sanitizeLayout(
                this.context.workspaceState.get<unknown>(this.layoutKey(result.info)),
                result.info.columnCount,
                { pageSize: settings.defaultPageSize, longText: settings.longText, colorMode: settings.columnColors },
            );
            this.post({ type: 'opened', info: result.info, layout, settings, fileName: path.basename(this.uri.fsPath) });
        } catch (err) {
            if (gen !== this.openGen) {
                return;
            }
            this.post({ type: 'status', kind: 'error', message: errorMessage(err) });
        }
    }

    private async sendPage(reqId: number, page: number, pageSize: number): Promise<void> {
        try {
            const result = await this.worker.request<PageResult>({ type: 'page', page, pageSize }).promise;
            this.lastPage = result;
            this.post({ type: 'page', reqId, result });
        } catch (err) {
            this.post({ type: 'error', message: errorMessage(err) });
        }
    }

    private startFilter(jobId: number, predicates: Predicate[]): void {
        if (this.activeFilter !== undefined) {
            const previous = this.filterJobs.get(this.activeFilter);
            if (previous !== undefined) {
                this.worker.cancel(previous);
            }
        }
        this.activeFilter = jobId;
        const { id, promise } = this.worker.request<FilterResult>(
            { type: 'filter', predicates },
            (p) => this.post({ type: 'filterProgress', jobId, progress: p as FilterProgress }),
        );
        this.filterJobs.set(jobId, id);
        promise
            .then(
                (result) => this.post({ type: 'filterDone', jobId, result }),
                (err) => this.post({ type: 'filterError', jobId, message: errorMessage(err) }),
            )
            .finally(() => {
                if (this.filterJobs.get(jobId) === id) {
                    this.filterJobs.delete(jobId);
                }
            });
    }

    private startUnique(jobId: number, column: number): void {
        const { id, promise } = this.worker.request<UniqueResult | null>({ type: 'unique', column });
        this.uniqueJobs.set(jobId, id);
        promise
            .then(
                (result) => this.post({ type: 'unique', jobId, result }),
                (err) => this.post({ type: 'unique', jobId, result: null, error: errorMessage(err) }),
            )
            .finally(() => {
                if (this.uniqueJobs.get(jobId) === id) {
                    this.uniqueJobs.delete(jobId);
                }
            });
    }

    private async chooseParseOptions(): Promise<void> {
        const delimiter = await vscode.window.showQuickPick<Item<string | undefined>>(
            [
                { label: 'Auto-detect', value: undefined },
                { label: 'Comma  ,', value: ',' },
                { label: 'Semicolon  ;', value: ';' },
                { label: 'Tab', value: '\t' },
                { label: 'Pipe  |', value: '|' },
                { label: 'Custom…', value: 'custom' },
            ],
            { title: 'CSV delimiter' },
        );
        if (!delimiter) {
            return;
        }
        let delimiterValue = delimiter.value;
        if (delimiterValue === 'custom') {
            delimiterValue = await vscode.window.showInputBox({
                prompt: 'Delimiter character',
                validateInput: (v) => (isValidDelimiter(v) ? undefined : 'Enter one ASCII character (not a quote or newline)'),
            });
            if (delimiterValue === undefined) {
                return;
            }
        }
        const header = await vscode.window.showQuickPick<Item<boolean | undefined>>(
            [
                { label: 'Auto-detect', value: undefined },
                { label: 'First row is a header', value: true },
                { label: 'No header row', value: false },
            ],
            { title: 'Header row' },
        );
        if (!header) {
            return;
        }
        const encoding = await vscode.window.showQuickPick<Item<'utf-8' | 'latin1' | undefined>>(
            [
                { label: 'Auto-detect', value: undefined },
                { label: 'UTF-8', value: 'utf-8' },
                { label: 'Latin-1 (Windows-1252)', value: 'latin1' },
            ],
            { title: 'Encoding' },
        );
        if (!encoding) {
            return;
        }
        this.parseOptions = { delimiter: delimiterValue, hasHeader: header.value, encoding: encoding.value };
        await this.context.workspaceState.update(this.key('parse'), this.parseOptions);
        await this.openFile();
    }

    // ---- helpers -----------------------------------------------------------

    private post(message: HostToView): void {
        if (!this.disposed) {
            void this.panel.webview.postMessage(message);
        }
    }

    private key(kind: string): string {
        return `csv.${kind}:${this.uri.fsPath}`;
    }

    private layoutKey(info: FileInfo): string {
        return `${this.key('layout')}:${headerHash(info.header)}`;
    }

    private settings(): ViewerSettings {
        const c = vscode.workspace.getConfiguration('getUniqueValues.csv');
        const pageSize = c.get<number>('defaultPageSize', 100);
        const width = Number(c.get<number>('defaultColumnWidth', 300));
        return {
            defaultPageSize: PAGE_SIZES.includes(pageSize) ? pageSize : 100,
            columnColors: c.get<ColorMode>('columnColors', 'headerAndCells'),
            longText: c.get<LongText>('longText', 'truncate'),
            defaultColumnWidth: Number.isFinite(width) ? Math.min(2000, Math.max(40, width)) : 300,
        };
    }

    private html(): string {
        const webview = this.panel.webview;
        const nonce = randomBytes(16).toString('hex');
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'viewer.js'));
        const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.css'));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>CSV Viewer</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
    }
}
