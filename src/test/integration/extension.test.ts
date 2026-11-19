import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CsvViewerApi } from '../../csv/CsvEditorProvider';

async function waitFor(cond: () => boolean, ms = 20000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) {
            throw new Error('timed out waiting for condition');
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

suite('Extension integration', function () {
    this.timeout(90000);

    test('the remove-duplicates command still works', async () => {
        const doc = await vscode.workspace.openTextDocument({ content: 'a\na\n\nb\n', language: 'plaintext' });
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('get-unique-values.run');
        await waitFor(() => doc.getText() === 'a\nb');
        assert.strictEqual(doc.getText(), 'a\nb');
    });

    test('CSV Viewer opens a file and serves page 1', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-it-'));
        const file = path.join(dir, 'sample.csv');
        fs.writeFileSync(file, 'sku,name\nA1,Blue\nA2,Red\nA3,Blue\n');

        try {
            const ext = vscode.extensions.getExtension<CsvViewerApi>('boopathi08.get-unique-values');
            assert.ok(ext, 'extension not found');
            const api = await ext.activate();

            const uri = vscode.Uri.file(file);
            await vscode.commands.executeCommand('vscode.openWith', uri, 'getUniqueValues.csvViewer');
            await waitFor(() => api.sessions.get(uri.toString())?.lastPage !== undefined);

            const page = api.sessions.get(uri.toString())?.lastPage;
            assert.deepStrictEqual(page?.rows, [['A1', 'Blue'], ['A2', 'Red'], ['A3', 'Blue']]);
            assert.deepStrictEqual(page?.rowNumbers, [0, 1, 2]);
            assert.strictEqual(page?.total, 3);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
