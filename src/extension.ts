import * as vscode from 'vscode';
import { registerLineTools } from './lineTools';
import { registerLargeFilePrompt } from './largeFilePrompt';
import { CsvViewerApi, registerCsvViewer } from './csv/CsvEditorProvider';

export function activate(context: vscode.ExtensionContext): CsvViewerApi {
    registerLineTools(context);
    registerLargeFilePrompt(context);
    return registerCsvViewer(context);
}

export function deactivate() { }
