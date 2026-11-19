import * as vscode from 'vscode';
import { registerLineTools } from './lineTools';
import { registerLargeFilePrompt } from './largeFilePrompt';
import { CsvViewerApi, registerCsvViewer } from './csv/CsvEditorProvider';
import { registerSidebar } from './sidebar';

export function activate(context: vscode.ExtensionContext): CsvViewerApi {
    registerLineTools(context);
    registerLargeFilePrompt(context);
    let onOpen: (uri: vscode.Uri) => void = () => undefined;
    const api = registerCsvViewer(context, (uri) => onOpen(uri));
    onOpen = registerSidebar(context, api).recordOpen;
    return api;
}

export function deactivate() { }
