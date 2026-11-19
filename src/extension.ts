import * as vscode from 'vscode';
import { registerLineTools } from './lineTools';
import { CsvViewerApi, registerCsvViewer } from './csv/CsvEditorProvider';

export function activate(context: vscode.ExtensionContext): CsvViewerApi {
    registerLineTools(context);
    return registerCsvViewer(context);
}

export function deactivate() { }
