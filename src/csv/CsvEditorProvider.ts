import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CsvSession } from './CsvSession';

export const VIEW_TYPE = 'getUniqueValues.csvViewer';
export const XLSX_VIEW_TYPE = 'getUniqueValues.xlsxViewer';

export interface CsvViewerApi {
    sessions: Map<string, CsvSession>;
    getActive(): CsvSession | undefined;
    onDidChangeActive: vscode.Event<void>;
    /** Fires when the active session's summary changes or another session (or none) becomes active. */
    onDidChangeSummary: vscode.Event<void>;
}

export const NO_VIEWER_MESSAGE = 'Open a CSV or Excel file in the viewer first.';

class CsvDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) { }
    dispose(): void { }
}

export function registerCsvViewer(context: vscode.ExtensionContext, onOpen?: (uri: vscode.Uri) => void): CsvViewerApi {
    const sessions = new Map<string, CsvSession>();
    /** The CSV Viewer editor that was most recently active (target of the keybinding commands). */
    let activeSession: CsvSession | undefined;
    const activeEmitter = new vscode.EventEmitter<void>();
    const summaryEmitter = new vscode.EventEmitter<void>();
    /** Listener on the active session's summary; replaced on every active change. */
    let summarySubscription: vscode.Disposable | undefined;
    const setActive = (next: CsvSession | undefined): void => {
        if (activeSession !== next) {
            activeSession = next;
            summarySubscription?.dispose();
            summarySubscription = next?.onDidChangeSummary(() => summaryEmitter.fire());
            activeEmitter.fire();
            summaryEmitter.fire();
        }
    };

    const provider: vscode.CustomReadonlyEditorProvider<CsvDocument> = {
        openCustomDocument: (uri) => new CsvDocument(uri),
        resolveCustomEditor: (document, panel) => {
            const session = new CsvSession(context, document.uri, panel);
            const key = document.uri.toString();
            sessions.set(key, session);
            onOpen?.(document.uri);
            if (panel.active) {
                setActive(session);
            }
            panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.active) {
                    setActive(session);
                } else if (activeSession === session) {
                    setActive(undefined);
                }
            });
            panel.onDidDispose(() => {
                if (activeSession === session) {
                    setActive(undefined);
                }
                sessions.delete(key);
                session.dispose();
            });
            session.start();
        },
    };

    // Best-effort: drop cached Excel conversions older than 7 days.
    void (async () => {
        const dir = path.join(context.globalStorageUri.fsPath, 'xlsx');
        let files: string[] = [];
        try {
            files = await fs.promises.readdir(dir);
        } catch { /* no cache yet */ }
        for (const f of files) {
            try {
                const p = path.join(dir, f);
                if (Date.now() - (await fs.promises.stat(p)).mtimeMs > 7 * 86_400_000) {
                    await fs.promises.rm(p, { force: true });
                }
            } catch { /* skip this entry */ }
        }
    })();

    const editorOptions = {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
    };
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, editorOptions),
        vscode.window.registerCustomEditorProvider(XLSX_VIEW_TYPE, provider, editorOptions),
        vscode.commands.registerCommand('get-unique-values.openCsvViewer', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                void vscode.window.showInformationMessage('Open a CSV file first.');
                return;
            }
            if (!/\.(csv|tsv|psv|xlsx|xlsm)$/i.test(target.path)) {
                void vscode.window.showInformationMessage('The CSV Viewer opens .csv, .tsv, .psv and Excel (.xlsx, .xlsm) files.');
                return;
            }
            await vscode.commands.executeCommand('vscode.openWith', target, /\.xls[xm]$/i.test(target.path) ? XLSX_VIEW_TYPE : VIEW_TYPE);
        }),
        vscode.commands.registerCommand('get-unique-values.csv.hideSelectedColumn', () => activeSession?.sendCommand('hideSelectedColumn')),
        vscode.commands.registerCommand('get-unique-values.csv.showAllColumns', () => activeSession?.sendCommand('showAllColumns')),
        vscode.commands.registerCommand('get-unique-values.csv.chooseSheet', () => {
            if (!activeSession) {
                void vscode.window.showInformationMessage(NO_VIEWER_MESSAGE);
                return;
            }
            return activeSession.chooseSheet();
        }),
        vscode.commands.registerCommand('get-unique-values.csv.export', () => {
            if (!activeSession) {
                void vscode.window.showInformationMessage(NO_VIEWER_MESSAGE);
                return;
            }
            activeSession.sendCommand('export');
        }),
        activeEmitter,
        summaryEmitter,
        { dispose: () => summarySubscription?.dispose() },
    );

    return {
        sessions,
        getActive: () => activeSession,
        onDidChangeActive: activeEmitter.event,
        onDidChangeSummary: summaryEmitter.event,
    };
}
