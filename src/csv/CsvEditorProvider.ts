import * as vscode from 'vscode';
import { CsvSession } from './CsvSession';

export const VIEW_TYPE = 'getUniqueValues.csvViewer';

export interface CsvViewerApi {
    sessions: Map<string, CsvSession>;
}

class CsvDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) { }
    dispose(): void { }
}

export function registerCsvViewer(context: vscode.ExtensionContext): CsvViewerApi {
    const sessions = new Map<string, CsvSession>();
    /** The CSV Viewer editor that was most recently active (target of the keybinding commands). */
    let activeSession: CsvSession | undefined;

    const provider: vscode.CustomReadonlyEditorProvider<CsvDocument> = {
        openCustomDocument: (uri) => new CsvDocument(uri),
        resolveCustomEditor: (document, panel) => {
            const session = new CsvSession(context, document.uri, panel);
            const key = document.uri.toString();
            sessions.set(key, session);
            if (panel.active) {
                activeSession = session;
            }
            panel.onDidChangeViewState((e) => {
                if (e.webviewPanel.active) {
                    activeSession = session;
                } else if (activeSession === session) {
                    activeSession = undefined;
                }
            });
            panel.onDidDispose(() => {
                if (activeSession === session) {
                    activeSession = undefined;
                }
                sessions.delete(key);
                session.dispose();
            });
            session.start();
        },
    };

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            supportsMultipleEditorsPerDocument: false,
            webviewOptions: { retainContextWhenHidden: true },
        }),
        vscode.commands.registerCommand('get-unique-values.openCsvViewer', async (uri?: vscode.Uri) => {
            const target = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!target) {
                void vscode.window.showInformationMessage('Open a CSV file first.');
                return;
            }
            if (!/\.(csv|tsv|psv)$/i.test(target.path)) {
                void vscode.window.showInformationMessage('The CSV Viewer opens .csv, .tsv and .psv files.');
                return;
            }
            await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
        }),
        vscode.commands.registerCommand('get-unique-values.csv.hideSelectedColumn', () => activeSession?.sendCommand('hideSelectedColumn')),
        vscode.commands.registerCommand('get-unique-values.csv.showAllColumns', () => activeSession?.sendCommand('showAllColumns')),
    );

    return { sessions };
}
