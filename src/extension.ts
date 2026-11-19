import * as vscode from 'vscode';
import { registerLineTools } from './lineTools';

export function activate(context: vscode.ExtensionContext) {
    registerLineTools(context);
}

export function deactivate() { }
