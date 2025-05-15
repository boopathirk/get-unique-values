import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // Command for processing single file
    let singleFileCommand = vscode.commands.registerCommand('get-unique-values.run', () => {
        processActiveEditor();
    });

    context.subscriptions.push(singleFileCommand);
}

function processActiveEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('No active editor found!');
        return;
    }

    const document = editor.document;
    const selection = editor.selection;

    // Get text from selection or entire document
    const text = selection.isEmpty
        ? document.getText()
        : document.getText(selection);

    // Split lines, filter out empty lines, filter unique, preserve order
    const lines = text.split(/\r?\n/);
    const nonEmptyLines = lines.filter(line => line.trim() !== '');
    const uniqueLines = Array.from(new Set(nonEmptyLines)).join('\n');

    editor.edit(editBuilder => {
        if (selection.isEmpty) {
            // Replace entire document
            const firstLine = document.lineAt(0);
            const lastLine = document.lineAt(document.lineCount - 1);
            const fullRange = new vscode.Range(firstLine.range.start, lastLine.range.end);
            editBuilder.replace(fullRange, uniqueLines);
        } else {
            // Replace selected text
            editBuilder.replace(selection, uniqueLines);
        }
    });
}

export function deactivate() { }
