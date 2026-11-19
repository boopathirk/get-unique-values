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

    const provider: vscode.CustomReadonlyEditorProvider<CsvDocument> = {
        openCustomDocument: (uri) => new CsvDocument(uri),
        resolveCustomEditor: (document, panel) => {
            const session = new CsvSession(context, document.uri, panel);
            const key = document.uri.toString();
            sessions.set(key, session);
            panel.onDidDispose(() => {
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
            await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
        }),
    );

    return { sessions };
}
