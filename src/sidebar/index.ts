import * as vscode from 'vscode';
import { CsvViewerApi, NO_VIEWER_MESSAGE } from '../csv/CsvEditorProvider';
import type { CsvSession } from '../csv/CsvSession';
import type { ViewCommand } from '../csv/protocol';
import { Preset, removePreset, sanitizePresets, upsertPreset } from '../csv/core/presets';
import { FileNode, FileProvider, PresetNode, PresetsProvider, RecentProvider, RecentNode, ToolsProvider } from './trees';
import {
    RecentState, clearRecent, removeRecent, sanitizeRecent, toggleFavorite, touch,
} from './recentStore';

const STATE_KEY = 'dataToolkit.recent';

type Item<T> = vscode.QuickPickItem & { value: T };

/** The active viewer session, or undefined after telling the user to open one. */
function activeOrNotify(api: CsvViewerApi): CsvSession | undefined {
    const session = api.getActive();
    if (!session) {
        void vscode.window.showInformationMessage(NO_VIEWER_MESSAGE);
    }
    return session;
}

function presetsConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('getUniqueValues.csv');
}

function readPresets(): Preset[] {
    return sanitizePresets(presetsConfig().get('presets'));
}

async function writePresets(list: Preset[]): Promise<void> {
    try {
        await presetsConfig().update('presets', list, vscode.ConfigurationTarget.Global);
    } catch (err) {
        void vscode.window.showErrorMessage(`Could not save the parse presets: ${err instanceof Error ? err.message : String(err)}`);
    }
}

export function registerSidebar(context: vscode.ExtensionContext, api: CsvViewerApi): { recordOpen(uri: vscode.Uri): void } {
    let state: RecentState = sanitizeRecent(context.globalState.get(STATE_KEY));
    const tools = new ToolsProvider();
    const recent = new RecentProvider(() => state);
    const file = new FileProvider(api);
    const presets = new PresetsProvider(readPresets);

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
        vscode.window.createTreeView('dataToolkit.file', { treeDataProvider: file }),
        vscode.window.createTreeView('dataToolkit.presets', { treeDataProvider: presets }),
        api.onDidChangeSummary(() => file.refresh()),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('getUniqueValues.csv.presets')) {
                presets.refresh();
            }
        }),
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
            file.refresh();
            presets.refresh();
        }),

        // ---- Current File: quick actions and column sets ----
        vscode.commands.registerCommand('get-unique-values.sidebar.fileAction', (action?: { name: ViewCommand; arg?: string }) => {
            if (action) {
                activeOrNotify(api)?.sendCommand(action.name, action.arg);
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.pickColumn', async (name?: 'moveToFirst' | 'freezeColumn') => {
            if (name !== 'moveToFirst' && name !== 'freezeColumn') {
                return;
            }
            const session = activeOrNotify(api);
            const header = session?.summary?.header;
            if (!session || !header) {
                return;
            }
            // Every column, hidden ones too (freezing a hidden column only moves it).
            const pick = await vscode.window.showQuickPick<Item<number>>(
                header.map((label, i) => ({ label, description: `column ${i + 1}`, value: i })),
                {
                    title: name === 'moveToFirst' ? 'Move a column to first' : 'Freeze a column',
                    placeHolder: 'Column',
                    matchOnDescription: true,
                },
            );
            if (pick) {
                session.sendCommand(name, String(pick.value));
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.applySet', (name?: string) => {
            if (typeof name === 'string') {
                activeOrNotify(api)?.sendCommand('applySet', name);
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.deleteSet', (node?: FileNode | string) => {
            const name = typeof node === 'string' ? node : node?.kind === 'set' ? node.name : undefined;
            if (name !== undefined) {
                activeOrNotify(api)?.sendCommand('deleteSet', name);
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.saveSet', async () => {
            const session = activeOrNotify(api);
            if (!session) {
                return;
            }
            const name = await vscode.window.showInputBox({
                title: 'Save current columns as a set',
                prompt: 'Name of the column set (a set with the same name is replaced)',
                validateInput: (v) => (v.trim() === '' ? 'Enter a name' : undefined),
            });
            if (name !== undefined && name.trim() !== '') {
                session.sendCommand('saveSet', name.trim());
            }
        }),

        // ---- Parse Presets ----
        vscode.commands.registerCommand('get-unique-values.sidebar.applyPreset', async (preset?: Preset) => {
            if (!preset) {
                return;
            }
            const session = activeOrNotify(api);
            if (session) {
                await session.applyParseOptions({ delimiter: preset.delimiter, hasHeader: preset.hasHeader, encoding: preset.encoding });
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.deletePreset', async (node?: PresetNode) => {
            if (node?.kind === 'preset') {
                await writePresets(removePreset(readPresets(), node.preset.name));
            }
        }),
        vscode.commands.registerCommand('get-unique-values.sidebar.savePreset', async () => {
            const session = activeOrNotify(api);
            if (!session) {
                return;
            }
            const name = await vscode.window.showInputBox({
                title: 'Save current parse settings as a preset',
                prompt: 'Preset name (a preset with the same name is replaced)',
                validateInput: (v) => (v.trim() === '' ? 'Enter a name' : undefined),
            });
            if (name === undefined || name.trim() === '') {
                return;
            }
            // What the viewer shows, overridden by any option chosen explicitly for this file;
            // sanitizing drops values a preset cannot hold (e.g. a UTF-16 encoding).
            const shown = session.summary;
            const chosen = session.parseSettings;
            const [preset] = sanitizePresets([{
                name: name.trim(),
                delimiter: chosen.delimiter ?? shown?.delimiter,
                hasHeader: chosen.hasHeader ?? shown?.hasHeader,
                encoding: chosen.encoding ?? shown?.encoding,
            }]);
            if (preset) {
                await writePresets(upsertPreset(readPresets(), preset));
            }
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
