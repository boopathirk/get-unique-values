import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { WorkerClient } from './WorkerClient';
import { PAGE_SIZES, headerHash, sanitizeLayout } from './core/layout';
import type { ColorMode, LongText } from './core/layout';
import type { Predicate } from './core/predicates';
import type { HostToView, ViewCommand, ViewToHost, ViewerSettings } from './protocol';
import type {
    ColumnStats, DuplicateColumnsResult, DuplicateResult, ExportFormat, ExportOptions, ExportProgress, ExportResult, FileInfo, FileSummary, FilterProgress, FilterResult, ImportProgress, IndexProgress, OpenResult, PageResult, ParseOptions, UniqueResult,
} from './types';
import { XLSX_MAX_ROWS } from './types';

const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
    csv: 'csv', xlsx: 'xlsx', json: 'json', jsonl: 'jsonl', tsv: 'tsv', sql: 'sql', markdown: 'md',
};

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
    private readonly analysisJobs = new Map<number, number>();
    private disposed = false;
    private activeFilter: number | undefined;
    private parseOptions: ParseOptions;
    private info: FileInfo | undefined;
    private openGen = 0;
    private sheet: number | undefined;
    private sheetName = '';
    /** Sheet names of the workbook, valid while the file's mtime and size are unchanged. */
    private sheetNames: { stamp: string; names: string[] } | undefined;
    /** Worker request id of the Excel conversion in flight, if any. */
    private convertId: number | undefined;
    private lastError: { gen: number; message: string; retry: boolean } | undefined;

    /** Most recent page sent to the webview (read by the integration test). */
    lastPage: PageResult | undefined;

    /** What the webview last reported about the open file (undefined until a file is shown). */
    summary: FileSummary | undefined;
    private readonly summaryEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeSummary = this.summaryEmitter.event;

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

    /** Forward a command (keybinding or sidebar) to the webview. */
    sendCommand(name: ViewCommand, arg?: string): void {
        this.post({ type: 'command', name, arg });
    }

    /** The parse options chosen for this file (empty fields mean auto-detect). */
    get parseSettings(): ParseOptions {
        return { ...this.parseOptions };
    }

    /** Use these parse options for this file from now on (as "chooseParseOptions" does) and reopen it. */
    async applyParseOptions(options: ParseOptions): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.parseOptions = { delimiter: options.delimiter, hasHeader: options.hasHeader, encoding: options.encoding };
        await this.context.workspaceState.update(this.key('parse'), this.parseOptions);
        await this.openFile();
    }

    private setSummary(summary: FileSummary | undefined): void {
        if (summary === undefined && this.summary === undefined) {
            return;
        }
        this.summary = summary;
        this.summaryEmitter.fire();
    }

    private createWorker(): WorkerClient {
        const worker = new WorkerClient(path.join(this.context.extensionPath, 'out', 'csvWorker.js'));
        worker.onFatal = (message) => {
            if (worker === this.worker) {
                this.postError(message, true);
            }
        };
        return worker;
    }

    dispose(): void {
        this.disposed = true;
        this.setSummary(undefined);
        this.summaryEmitter.dispose();
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
            this.postError(errorMessage(err));
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
            case 'stats':
                this.startAnalysis(m.jobId, { type: 'stats', column: m.column }, (result, error) =>
                    this.post({ type: 'stats', jobId: m.jobId, result: result as ColumnStats | null, error }));
                break;
            case 'duplicateColumns':
                this.startAnalysis(m.jobId, { type: 'duplicateColumns' }, (result, error) =>
                    this.post({ type: 'duplicateColumns', jobId: m.jobId, result: result as DuplicateColumnsResult | null, error }));
                break;
            case 'duplicates':
                this.startAnalysis(m.jobId, { type: 'duplicates', columns: m.columns }, (result, error) =>
                    this.post({ type: 'duplicates', jobId: m.jobId, result: result as DuplicateResult | null, error }));
                break;
            case 'cancel': {
                const id = (m.kind === 'unique' ? this.uniqueJobs : m.kind === 'analysis' ? this.analysisJobs : this.filterJobs).get(m.jobId);
                if (id !== undefined) {
                    this.worker.cancel(id);
                }
                break;
            }
            case 'nonEmpty':
                this.worker.request<number[] | null>({ type: 'nonEmptyColumns' }).promise.then(
                    (columns) => this.post({ type: 'nonEmpty', jobId: m.jobId, columns }),
                    (err) => this.postError(errorMessage(err)),
                );
                break;
            case 'export':
                await this.exportData(m.columns);
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
            case 'summary':
                this.setSummary(m.summary);
                break;
        }
    }

    private async openFile(): Promise<void> {
        const gen = ++this.openGen;
        this.filterJobs.clear();
        this.uniqueJobs.clear();
        this.analysisJobs.clear();
        this.activeFilter = undefined;
        if (this.convertId !== undefined) {
            this.worker.cancel(this.convertId);
            this.convertId = undefined;
        }
        try {
            const source = await this.resolveSource(gen);
            if (source === undefined || gen !== this.openGen) {
                return;
            }
            const { promise } = this.worker.request<OpenResult>(
                { type: 'open', path: source.path, options: source.options },
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
                this.setSummary(undefined);
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
            this.post({ type: 'opened', info: result.info, layout, settings, fileName: source.label });
        } catch (err) {
            if (gen !== this.openGen) {
                return;
            }
            this.setSummary(undefined);
            this.post({ type: 'status', kind: 'error', message: errorMessage(err) });
        }
    }

    /** The CSV file to open: the file itself, or the cached CSV conversion of the chosen Excel sheet. */
    private async resolveSource(gen: number): Promise<{ path: string; options: ParseOptions; label: string } | undefined> {
        const file = this.uri.fsPath;
        const base = path.basename(file);
        if (!/\.xls[xm]$/i.test(file)) {
            return { path: file, options: this.parseOptions, label: base };
        }
        const stat = await fs.promises.stat(file);
        const stamp = `${stat.mtimeMs}|${stat.size}`;
        let sheets: string[];
        if (this.sheetNames?.stamp === stamp) {
            sheets = this.sheetNames.names;
        } else {
            sheets = await this.worker.request<string[]>({ type: 'xlsxSheets', path: file }).promise;
            this.sheetNames = { stamp, names: sheets };
        }
        const live = (): boolean => gen === this.openGen && !this.disposed;
        if (!live()) {
            return undefined;
        }
        if (sheets.length === 0) {
            this.post({ type: 'status', kind: 'error', message: 'This workbook has no sheets.' });
            return undefined;
        }
        if (this.sheet === undefined || this.sheet >= sheets.length) {
            if (sheets.length === 1) {
                this.sheet = 0;
            } else {
                const pick = await vscode.window.showQuickPick<Item<number>>(
                    sheets.map((name, i) => ({ label: name, value: i })),
                    { title: `Choose a sheet from ${base}`, placeHolder: 'Sheet' },
                );
                if (!live()) {
                    return undefined;
                }
                if (!pick) {
                    this.post({ type: 'status', kind: 'error', message: 'No sheet chosen. Run "CSV Viewer: Choose Excel Sheet\u2026" to pick one.' });
                    return undefined;
                }
                this.sheet = pick.value;
            }
        }
        const sheetIndex = this.sheet;
        this.sheetName = sheets[sheetIndex];
        const hash = createHash('sha1').update(`${file}|${stamp}|${sheetIndex}`).digest('hex').slice(0, 24);
        const cacheDir = path.join(this.context.globalStorageUri.fsPath, 'xlsx');
        await fs.promises.mkdir(cacheDir, { recursive: true });
        const out = path.join(cacheDir, `${hash}.csv`);
        const cached = await fs.promises.access(out).then(() => true, () => false);
        if (!live()) {
            return undefined;
        }
        if (!cached) {
            const rows = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Reading ${base} (${this.sheetName})`, cancellable: true },
                async (progress, cancelToken) => {
                    const { id, promise } = this.worker.request<number | null>(
                        { type: 'xlsxConvert', path: file, sheet: sheetIndex, out },
                        (p) => progress.report({ message: `${(p as ImportProgress).rows.toLocaleString()} rows` }),
                    );
                    this.convertId = id;
                    cancelToken.onCancellationRequested(() => this.worker.cancel(id));
                    try {
                        return await promise;
                    } finally {
                        if (this.convertId === id) {
                            this.convertId = undefined;
                        }
                    }
                },
            );
            if (!live()) {
                return undefined;
            }
            if (rows === null) {
                this.post({ type: 'status', kind: 'error', message: 'Reading the Excel file was cancelled. Reload to try again.' });
                return undefined;
            }
        }
        return { path: out, options: { ...this.parseOptions, delimiter: ',', encoding: 'utf-8' }, label: `${base} \u2014 ${this.sheetName}` };
    }

    /** Forget the chosen sheet and reopen (command "CSV Viewer: Choose Excel Sheet\u2026"). */
    async chooseSheet(): Promise<void> {
        this.sheet = undefined;
        await this.openFile();
    }

    private async sendPage(reqId: number, page: number, pageSize: number): Promise<void> {
        try {
            const result = await this.worker.request<PageResult>({ type: 'page', page, pageSize }).promise;
            this.lastPage = result;
            this.post({ type: 'page', reqId, result });
        } catch (err) {
            this.postError(errorMessage(err));
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

    private startAnalysis(
        jobId: number,
        body: { type: 'stats'; column: number } | { type: 'duplicates'; columns: number[] } | { type: 'duplicateColumns' },
        reply: (result: unknown, error?: string) => void,
    ): void {
        const { id, promise } = this.worker.request<unknown>(body);
        this.analysisJobs.set(jobId, id);
        promise
            .then(
                (result) => reply(result),
                (err) => reply(null, errorMessage(err)),
            )
            .finally(() => {
                if (this.analysisJobs.get(jobId) === id) {
                    this.analysisJobs.delete(jobId);
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

    private async exportData(viewColumns: number[]): Promise<void> {
        const info = this.info;
        if (!info) {
            return;
        }
        const format = await vscode.window.showQuickPick<Item<ExportFormat>>(
            [
                { label: 'CSV', description: '.csv', value: 'csv' },
                { label: 'Excel', description: '.xlsx (numbers stay numbers, up to 1,048,575 rows)', value: 'xlsx' },
                { label: 'JSON', description: '.json array of objects', value: 'json' },
                { label: 'JSON Lines', description: '.jsonl, one object per line', value: 'jsonl' },
                { label: 'TSV', description: '.tsv', value: 'tsv' },
                { label: 'SQL INSERT', description: '.sql', value: 'sql' },
                { label: 'Markdown table', description: '.md', value: 'markdown' },
            ],
            { title: 'Export format' },
        );
        if (!format) {
            return;
        }
        const scope = await vscode.window.showQuickPick<Item<'view' | 'all'>>(
            [
                { label: 'Current view', description: 'filtered rows, visible columns', value: 'view' },
                { label: 'Whole file', description: 'every row and every column', value: 'all' },
            ],
            { title: 'What to export' },
        );
        if (!scope) {
            return;
        }
        let table: string | undefined;
        if (format.value === 'sql') {
            table = await vscode.window.showInputBox({
                title: 'SQL table name',
                value: path.basename(this.uri.fsPath).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_') || 'data',
            });
            if (table === undefined) {
                return;
            }
        }
        const ext = EXPORT_EXTENSIONS[format.value];
        const base = path.basename(this.uri.fsPath).replace(/\.[^.]+$/, '');
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(path.join(path.dirname(this.uri.fsPath), `${base}.${ext}`)),
            filters: { [format.label]: [ext] },
            title: 'Export to',
        });
        if (!target) {
            return;
        }
        const columns = scope.value === 'all' ? Array.from({ length: info.columnCount }, (_, i) => i) : viewColumns;
        const options: ExportOptions = {
            format: format.value, scope: scope.value, columns, outPath: target.fsPath, table, sheetName: base.slice(0, 31),
        };
        try {
            const result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(target.fsPath)}`, cancellable: true },
                async (progress, cancelToken) => {
                    let last = 0;
                    const { id, promise } = this.worker.request<ExportResult | null>({ type: 'export', options }, (p) => {
                        const { done, total } = p as ExportProgress;
                        const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
                        progress.report({ increment: pct - last, message: `${done.toLocaleString()} of ${total.toLocaleString()} rows` });
                        last = pct;
                    });
                    cancelToken.onCancellationRequested(() => this.worker.cancel(id));
                    return promise;
                },
            );
            if (result === null) {
                void vscode.window.showInformationMessage('Export cancelled.');
                return;
            }
            const note = result.truncated ? ` (stopped at the Excel limit of ${XLSX_MAX_ROWS.toLocaleString()} rows)` : '';
            const choice = await vscode.window.showInformationMessage(
                `Exported ${result.rows.toLocaleString()} rows to ${path.basename(result.path)}${note}.`,
                'Open', 'Reveal in file manager',
            );
            if (choice === 'Open') {
                await vscode.commands.executeCommand('vscode.open', target);
            } else if (choice === 'Reveal in file manager') {
                await vscode.commands.executeCommand('revealFileInOS', target);
            }
        } catch (err) {
            void vscode.window.showErrorMessage(`Export failed: ${errorMessage(err)}`);
        }
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

    /** Post an error banner, skipping an identical repeat within the same open generation. */
    private postError(message: string, retry?: boolean): void {
        const last = this.lastError;
        if (last?.gen === this.openGen && last.message === message && (!retry || last.retry)) {
            return;
        }
        this.lastError = { gen: this.openGen, message, retry: retry === true };
        this.post({ type: 'error', message, retry });
    }

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
