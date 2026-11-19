import * as vscode from 'vscode';
import { shouldPrompt } from './csv/core/largeFile';

export { shouldPrompt };

const SUPPRESS_KEY = 'largeFilePrompt.suppressed';

/** The file URI shown by a plain text editor tab (custom editors such as the CSV Viewer are excluded). */
function textTabUri(tab: vscode.Tab): vscode.Uri | undefined {
    const input = tab.input;
    return input instanceof vscode.TabInputText && input.uri.scheme === 'file' ? input.uri : undefined;
}

/**
 * Offer the CSV Viewer for large CSV/TSV/PSV files opened in a text editor tab.
 * Tabs are watched instead of text documents because VS Code does not hand documents over 50 MB to
 * extensions (onDidOpenTextDocument never fires for them); tabs already open at activation are checked too.
 */
export function registerLargeFilePrompt(context: vscode.ExtensionContext): void {
    const asked = new Set<string>();

    const check = async (uri: vscode.Uri): Promise<void> => {
        if (context.workspaceState.get<boolean>(SUPPRESS_KEY) === true) {
            return;
        }
        const key = uri.toString();
        if (asked.has(key)) {
            return;
        }
        const thresholdMB = vscode.workspace.getConfiguration('getUniqueValues.csv').get<number>('largeFileMB', 20);
        if (!shouldPrompt(Number.MAX_SAFE_INTEGER, thresholdMB, uri.fsPath)) {
            return; // not a CSV/TSV/PSV file, or the prompt is turned off: no need to stat
        }
        asked.add(key); // before the await, so a tab reported twice prompts once
        let size: number;
        try {
            size = (await vscode.workspace.fs.stat(uri)).size;
        } catch {
            asked.delete(key);
            return;
        }
        if (!shouldPrompt(size, thresholdMB, uri.fsPath)) {
            asked.delete(key); // the file may grow past the threshold later
            return;
        }
        const choice = await vscode.window.showInformationMessage(
            'This is a large file. Open it in the CSV Viewer for fast paging and search?',
            'Open in CSV Viewer',
            "Don't ask again",
        );
        if (choice === 'Open in CSV Viewer') {
            await vscode.commands.executeCommand('get-unique-values.openCsvViewer', uri);
        } else if (choice === "Don't ask again") {
            await context.workspaceState.update(SUPPRESS_KEY, true);
        }
    };

    const checkTabs = (tabs: readonly vscode.Tab[]): void => {
        for (const tab of tabs) {
            const uri = textTabUri(tab);
            if (uri) {
                void check(uri);
            }
        }
    };

    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs((e) => checkTabs(e.opened)));
    checkTabs(vscode.window.tabGroups.all.flatMap((g) => g.tabs));
}
