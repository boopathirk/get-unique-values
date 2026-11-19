import * as vscode from 'vscode';
import { shouldPrompt } from './csv/core/largeFile';

export { shouldPrompt };

const SUPPRESS_KEY = 'largeFilePrompt.suppressed';

export function registerLargeFilePrompt(context: vscode.ExtensionContext): void {
    const asked = new Set<string>();
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(async (doc) => {
            if (doc.uri.scheme !== 'file' || context.workspaceState.get<boolean>(SUPPRESS_KEY) === true) {
                return;
            }
            const key = doc.uri.toString();
            if (asked.has(key)) {
                return;
            }
            const thresholdMB = vscode.workspace.getConfiguration('getUniqueValues.csv').get<number>('largeFileMB', 20);
            let size: number;
            try {
                size = (await vscode.workspace.fs.stat(doc.uri)).size;
            } catch {
                return;
            }
            if (!shouldPrompt(size, thresholdMB, doc.uri.fsPath)) {
                return;
            }
            asked.add(key);
            const choice = await vscode.window.showInformationMessage(
                'This is a large file. Open it in the CSV Viewer for fast paging and search?',
                'Open in CSV Viewer',
                "Don't ask again",
            );
            if (choice === 'Open in CSV Viewer') {
                await vscode.commands.executeCommand('get-unique-values.openCsvViewer', doc.uri);
            } else if (choice === "Don't ask again") {
                await context.workspaceState.update(SUPPRESS_KEY, true);
            }
        }),
    );
}
