import * as vscode from 'vscode';
import * as path from 'path';
import type { CsvViewerApi } from '../csv/CsvEditorProvider';
import type { ViewCommand } from '../csv/protocol';
import type { FileSummary } from '../csv/types';
import { Preset, describePreset } from '../csv/core/presets';
import { RecentState } from './recentStore';

export interface ToolNode {
    kind: 'tool';
    label: string;
    icon: string;
    command: string;
    tooltip: string;
}

export class ToolsProvider implements vscode.TreeDataProvider<ToolNode> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    private readonly tools: ToolNode[] = [
        { kind: 'tool', label: 'Open CSV or Excel file…', icon: 'folder-opened', command: 'get-unique-values.sidebar.openFile', tooltip: 'Pick a CSV, TSV, PSV or Excel file and open it in the viewer.' },
        { kind: 'tool', label: 'Remove duplicate lines (text file)', icon: 'trash', command: 'get-unique-values.run', tooltip: 'Remove duplicate and empty lines from the active text editor.' },
        { kind: 'tool', label: 'Export current view…', icon: 'export', command: 'get-unique-values.csv.export', tooltip: 'Export the current viewer rows and columns to another format.' },
        { kind: 'tool', label: 'Choose Excel sheet…', icon: 'table', command: 'get-unique-values.csv.chooseSheet', tooltip: 'Switch to another sheet of the open Excel workbook.' },
    ];

    refresh(): void { this.emitter.fire(); }

    getTreeItem(node: ToolNode): vscode.TreeItem {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip;
        item.command = { command: node.command, title: node.label };
        return item;
    }

    getChildren(node?: ToolNode): ToolNode[] {
        return node ? [] : this.tools;
    }
}

export type RecentNode =
    | { kind: 'group'; id: 'favorites' | 'recent'; label: string }
    | { kind: 'file'; uri: string }
    | { kind: 'empty' };

export class RecentProvider implements vscode.TreeDataProvider<RecentNode> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly getState: () => RecentState) { }

    refresh(): void { this.emitter.fire(); }

    getTreeItem(node: RecentNode): vscode.TreeItem {
        if (node.kind === 'group') {
            return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        }
        if (node.kind === 'empty') {
            return new vscode.TreeItem('Nothing yet — open a file', vscode.TreeItemCollapsibleState.None);
        }
        const uri = vscode.Uri.parse(node.uri);
        const item = new vscode.TreeItem(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
        item.description = path.basename(path.dirname(uri.fsPath));
        item.tooltip = uri.fsPath;
        item.contextValue = 'recentFile';
        item.resourceUri = uri;
        item.command = { command: 'get-unique-values.sidebar.openRecent', title: 'Open', arguments: [uri] };
        return item;
    }

    getChildren(node?: RecentNode): RecentNode[] {
        const s = this.getState();
        if (!node) {
            const groups: RecentNode[] = [];
            if (s.favorites.length > 0) {
                groups.push({ kind: 'group', id: 'favorites', label: 'Favorites' });
            }
            if (s.recent.length > 0) {
                groups.push({ kind: 'group', id: 'recent', label: 'Recent' });
            }
            return groups.length > 0 ? groups : [{ kind: 'empty' }];
        }
        if (node.kind !== 'group') {
            return [];
        }
        const uris = node.id === 'favorites' ? s.favorites : s.recent.map((r) => r.uri);
        return uris.map((uri) => ({ kind: 'file', uri }));
    }
}

// ---- Current File ----------------------------------------------------------

export type FileNode =
    | { kind: 'group'; id: 'info' | 'actions' | 'sets'; label: string }
    | { kind: 'info'; label: string; icon: string }
    | { kind: 'action'; label: string; icon: string; tooltip: string; command: vscode.Command }
    | { kind: 'set'; name: string }
    | { kind: 'saveSet' };

const DELIMITER_NAMES: Record<string, string> = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

export function delimiterName(d: string): string {
    return DELIMITER_NAMES[d] ?? `"${d}"`;
}

const num = (n: number): string => n.toLocaleString('en-US');

function fileAction(label: string, icon: string, tooltip: string, name: ViewCommand): FileNode {
    return {
        kind: 'action', label, icon, tooltip,
        command: { command: 'get-unique-values.sidebar.fileAction', title: label, arguments: [{ name }] },
    };
}

function pickAction(label: string, icon: string, tooltip: string, name: 'moveToFirst' | 'freezeColumn'): FileNode {
    return {
        kind: 'action', label, icon, tooltip,
        command: { command: 'get-unique-values.sidebar.pickColumn', title: label, arguments: [name] },
    };
}

function infoNodes(s: FileSummary): FileNode[] {
    const nodes: FileNode[] = [
        { kind: 'info', label: s.fileName, icon: 'file' },
        { kind: 'info', label: `${num(s.rows)} rows · ${num(s.columns)} columns${s.indexing ? ' · indexing…' : ''}`, icon: 'table' },
        { kind: 'info', label: `Delimiter ${delimiterName(s.delimiter)} · ${s.hasHeader ? 'header' : 'no header'} · ${s.encoding}`, icon: 'settings' },
    ];
    if (s.badRows > 0) {
        nodes.push({ kind: 'info', label: `${num(s.badRows)} rows with the wrong column count`, icon: 'warning' });
    }
    if (s.hiddenColumns > 0) {
        nodes.push({ kind: 'info', label: `${num(s.hiddenColumns)} hidden columns`, icon: 'eye-closed' });
    }
    if (s.filterActive) {
        nodes.push({ kind: 'info', label: `Filter active: ${num(s.matches)} matching rows`, icon: 'filter' });
    }
    return nodes;
}

function actionNodes(s: FileSummary): FileNode[] {
    const nodes: FileNode[] = [];
    if (s.badRows > 0) {
        nodes.push(fileAction('Show only bad rows', 'warning', 'Toggle the filter that shows only rows with the wrong column count.', 'toggleBadRows'));
    }
    if (s.filterActive) {
        nodes.push(fileAction('Clear all filters', 'clear-all', 'Clear the search, column filters and the bad-rows filter.', 'clearFilters'));
    }
    if (s.hiddenColumns > 0) {
        nodes.push(fileAction('Show all columns', 'eye', 'Show every hidden column.', 'showAllColumns'));
    }
    nodes.push(
        fileAction('Hide empty columns', 'eye-closed', 'Hide the columns that have no values (scans the file).', 'hideEmptyColumns'),
        fileAction('Find duplicate rows…', 'copy', 'Open the duplicates panel to choose key columns.', 'duplicateRows'),
        fileAction('Find duplicate columns', 'split-horizontal', 'Find columns whose values are identical in every row.', 'duplicateColumns'),
        pickAction('Move a column to first…', 'arrow-left', 'Pick a column to move to the front.', 'moveToFirst'),
        pickAction('Freeze a column…', 'pinned', 'Pick a column to move to the front and keep visible while scrolling sideways.', 'freezeColumn'),
        fileAction('Export current view…', 'export', 'Export the current viewer rows and columns to another format.', 'export'),
    );
    return nodes;
}

export class FileProvider implements vscode.TreeDataProvider<FileNode> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly api: CsvViewerApi) { }

    refresh(): void { this.emitter.fire(); }

    getTreeItem(node: FileNode): vscode.TreeItem {
        switch (node.kind) {
            case 'group':
                return new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
            case 'info': {
                const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon(node.icon);
                item.tooltip = node.label;
                return item;
            }
            case 'action': {
                const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon(node.icon);
                item.tooltip = node.tooltip;
                item.command = node.command;
                return item;
            }
            case 'set': {
                const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('list-selection');
                item.tooltip = `Apply the column set "${node.name}"`;
                item.contextValue = 'columnSet';
                item.command = { command: 'get-unique-values.sidebar.applySet', title: 'Apply column set', arguments: [node.name] };
                return item;
            }
            case 'saveSet': {
                const item = new vscode.TreeItem('Save current columns as a set…', vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('save');
                item.tooltip = 'Save the visible and hidden columns and their order under a name.';
                item.command = { command: 'get-unique-values.sidebar.saveSet', title: 'Save column set' };
                return item;
            }
        }
    }

    getChildren(node?: FileNode): FileNode[] {
        const summary = this.api.getActive()?.summary;
        if (!summary) {
            return [];
        }
        if (!node) {
            return [
                { kind: 'group', id: 'info', label: 'Info' },
                { kind: 'group', id: 'actions', label: 'Quick actions' },
                { kind: 'group', id: 'sets', label: 'Column sets' },
            ];
        }
        if (node.kind !== 'group') {
            return [];
        }
        switch (node.id) {
            case 'info':
                return infoNodes(summary);
            case 'actions':
                return actionNodes(summary);
            case 'sets':
                return [...summary.sets.map((name): FileNode => ({ kind: 'set', name })), { kind: 'saveSet' }];
        }
    }
}

// ---- Parse Presets ---------------------------------------------------------

export type PresetNode =
    | { kind: 'preset'; preset: Preset }
    | { kind: 'savePreset' };

export class PresetsProvider implements vscode.TreeDataProvider<PresetNode> {
    private readonly emitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.emitter.event;

    constructor(private readonly getPresets: () => Preset[]) { }

    refresh(): void { this.emitter.fire(); }

    getTreeItem(node: PresetNode): vscode.TreeItem {
        if (node.kind === 'savePreset') {
            const item = new vscode.TreeItem('Save current parse settings as a preset…', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('save');
            item.tooltip = 'Save the delimiter, header and encoding of the open file under a name.';
            item.command = { command: 'get-unique-values.sidebar.savePreset', title: 'Save parse preset' };
            return item;
        }
        const p = node.preset;
        const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.None);
        item.description = describePreset(p);
        item.tooltip = `Reopen the current file with: ${describePreset(p)}`;
        item.iconPath = new vscode.ThemeIcon('symbol-property');
        item.contextValue = 'preset';
        item.command = { command: 'get-unique-values.sidebar.applyPreset', title: 'Apply parse preset', arguments: [p] };
        return item;
    }

    getChildren(node?: PresetNode): PresetNode[] {
        if (node) {
            return [];
        }
        return [...this.getPresets().map((preset): PresetNode => ({ kind: 'preset', preset })), { kind: 'savePreset' }];
    }
}
