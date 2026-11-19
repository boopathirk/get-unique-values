import * as fs from 'fs';
import ExcelJS from 'exceljs';
import { createFormatter } from '../core/formats';
import type { CsvEngine } from '../core/engine';
import type { CancelToken, ExportFormat, ExportOptions, ExportResult } from '../types';
import { XLSX_MAX_ROWS } from '../types';

export type { ExportFormat, ExportOptions, ExportResult } from '../types';
export { XLSX_MAX_ROWS } from '../types';

/** Plain numbers become numeric cells; anything that could lose information (leading zeros, 16+ digits, exponents) stays text. */
export function xlsxValue(v: string): string | number {
    return /^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v) && String(Number(v)) === v ? Number(v) : v;
}

export async function exportToFile(
    engine: CsvEngine,
    opts: ExportOptions,
    token: CancelToken,
    onProgress: (done: number, total: number) => void,
): Promise<ExportResult | null> {
    const info = await engine.getInfo();
    const header = opts.columns.map((c) => info.header[c] ?? `Column ${c + 1}`);
    const pick = (row: string[]): string[] => opts.columns.map((c) => row[c] ?? '');
    const result = opts.format === 'xlsx'
        ? await writeXlsx(engine, opts, header, pick, token, onProgress)
        : await writeText(engine, opts, header, pick, token, onProgress);
    if (result === null) {
        await fs.promises.rm(opts.outPath, { force: true });
    }
    return result;
}

function closeStream(stream: fs.WriteStream): Promise<void> {
    return new Promise<void>((resolve) => {
        if (stream.closed) {
            resolve(); // already closed (e.g. after a write error): 'close' will not fire again
            return;
        }
        stream.once('close', () => resolve());
        stream.destroy();
    });
}

async function writeText(
    engine: CsvEngine,
    opts: ExportOptions,
    header: string[],
    pick: (row: string[]) => string[],
    token: CancelToken,
    onProgress: (done: number, total: number) => void,
): Promise<ExportResult | null> {
    const fmt = createFormatter(opts.format as Exclude<ExportFormat, 'xlsx'>, header, { table: opts.table });
    const stream = fs.createWriteStream(opts.outPath);
    await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', reject);
    });
    stream.on('error', () => undefined); // later failures surface through the write callbacks
    const write = (text: string): Promise<void> => text === ''
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => stream.write(text, (err) => (err ? reject(err) : resolve())));
    let rows = 0;
    try {
        await write(fmt.begin());
        const outcome = await engine.exportRows(opts.scope, token, async (window) => {
            rows += window.length;
            await write(window.map((r) => fmt.row(pick(r))).join(''));
        }, onProgress);
        if (outcome === 'cancelled') {
            await closeStream(stream);
            return null;
        }
        await write(fmt.end());
        await new Promise<void>((resolve) => stream.end(resolve));
        return { rows, truncated: false, path: opts.outPath };
    } catch (err) {
        await closeStream(stream);
        await fs.promises.rm(opts.outPath, { force: true });
        throw err;
    }
}

async function writeXlsx(
    engine: CsvEngine,
    opts: ExportOptions,
    header: string[],
    pick: (row: string[]) => string[],
    token: CancelToken,
    onProgress: (done: number, total: number) => void,
): Promise<ExportResult | null> {
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: opts.outPath, useStyles: false, useSharedStrings: false });
    const ws = wb.addWorksheet((opts.sheetName || 'Data').slice(0, 31));
    ws.addRow(header).commit();
    let rows = 0;
    let truncated = false;
    let outcome: Awaited<ReturnType<CsvEngine['exportRows']>>;
    try {
        outcome = await engine.exportRows(opts.scope, token, async (window) => {
            for (const r of window) {
                if (rows + 1 >= XLSX_MAX_ROWS) {
                    truncated = true;
                    return true;
                }
                ws.addRow(pick(r).map(xlsxValue)).commit();
                rows++;
            }
            return false;
        }, onProgress);
    } catch (err) {
        try {
            ws.commit();
            await wb.commit();
        } catch {
            // ignore: the original error is what matters
        }
        await fs.promises.rm(opts.outPath, { force: true });
        throw err;
    }
    ws.commit();
    await wb.commit();
    return outcome === 'cancelled' ? null : { rows, truncated, path: opts.outPath };
}
