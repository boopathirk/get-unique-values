import * as vscode from 'vscode';
import { CsvViewerApi } from '../csv/CsvEditorProvider';
import { RecentProvider, RecentNode, ToolsProvider } from './trees';
import {
    RecentState, clearRecent, removeRecent, sanitizeRecent, toggleFavorite, touch,
} from './recentStore';

const STATE_KEY = 'dataToolkit.recent';

export function registerSidebar(context: vscode.ExtensionContext, _api: CsvViewerApi): { recordOpen(uri: vscode.Uri): void } {
    let state: RecentState = sanitizeRecent(context.globalState.get(STATE_KEY));
    const tools = new ToolsProvider();
    const recent = new RecentProvider(() => state);

    const setState = (next: RecentState): void => {
        state = next;
        void context.globalState.update(STATE_KEY, state);
        recent.refresh();
    };
    const nodeUri = (node?: RecentNode | vscode.Uri): string | undefined => {
        if (node instanceof vscode.Uri) {
            return node.toString();
        }
        return node && node.kind === 'file' ? node.uri : undefined;
    };

    context.subscriptions.push(
        vscode.window.createTreeView('dataToolkit.tools', { treeDataProvider: tools }),
        vscode.window.createTreeView('dataToolkit.recent', { treeDataProvider: recent }),
        vscode.commands.registerCommand('get-unique-values.sidebar.openFile', async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'CSV / Excel': ['csv', 'tsv', 'psv', 'xlsx', 'xlsm'] },
            });
            if (picked && picked[0]) {
                await vscode.commands.executeCommand('get-unique-values.openCsvViewer', picked[0]);
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.openRecent', async (uri?: vscode.Uri) => {
            if (!uri) {
                return;
            }
            try {
                await vscode.workspace.fs.stat(uri);
            } catch {
                const choice = await vscode.window.showWarningMessage(`${uri.fsPath} no longer exists.`, 'Remove from list');
                if (choice === 'Remove from list') {
                    setState(removeRecent(state, uri.toString()));
                }
                return;
            }
            await vscode.commands.executeCommand('get-unique-values.openCsvViewer', uri);
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.toggleFavorite', (node?: RecentNode) => {
            const uri = nodeUri(node);
            if (uri) {
                setState(toggleFavorite(state, uri));
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.removeRecent', (node?: RecentNode) => {
            const uri = nodeUri(node);
            if (uri) {
                setState(removeRecent(state, uri));
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.clearRecent', () => setState(clearRecent(state))),
        vscode.commands.registerCommand('get-unique-values.sidebar.refresh', () => {
            tools.refresh();
            recent.refresh();
        }),
    );

    return {
        recordOpen(uri: vscode.Uri): void {
            if (uri.scheme !== 'file' || uri.fsPath.startsWith(context.globalStorageUri.fsPath)) {
                return;
            }
            setState(touch(state, uri.toString(), Date.now()));
        },
    };
}
