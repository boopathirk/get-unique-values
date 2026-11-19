import * as vscode from 'vscode';
import * as path from 'path';
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
