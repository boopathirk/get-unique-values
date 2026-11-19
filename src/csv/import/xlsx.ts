/*
 * Excel to CSV conversion limits:
 *  - Fully empty rows are skipped by the streaming reader.
 *  - Rows are padded to the first row's width; longer rows are kept as they are.
 *  - Inline rich text from stream-written files may lose its leading runs (an ExcelJS reader limitation).
 */
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import ExcelJS from 'exceljs';
import { csvField } from '../core/formats';
import type { CancelToken } from '../types';

const READER_OPTIONS = { sharedStrings: 'cache', worksheets: 'emit', hyperlinks: 'ignore', styles: 'cache' } as const;

export function cellText(v: unknown): string {
    if (v === null || v === undefined) {
        return '';
    }
    if (typeof v === 'string') {
        return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
        return String(v);
    }
    if (v instanceof Date) {
        return v.toISOString();
    }
    if (typeof v === 'object') {
        const o = v as Record<string, unknown>;
        if ('result' in o) {
            return cellText(o.result);
        }
        if ('formula' in o || 'sharedFormula' in o) {
            return '';
        }
        if (Array.isArray(o.richText)) {
            return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? '').join('');
        }
        if ('text' in o) {
            return cellText(o.text);
        }
        if ('error' in o) {
            return String(o.error);
        }
    }
    return JSON.stringify(v);
}

/** Close a worksheet's source stream without reading it (ExcelJS leaves it open, leaking a file handle and later emitting an unhandled error). */
function discard(ws: unknown): void {
    const it = (ws as { iterator?: { destroy?: () => void; on?: (e: string, f: () => void) => void } }).iterator;
    try {
        it?.on?.('error', () => undefined);
        it?.destroy?.();
    } catch { /* already closed */ }
}

/** Close the workbook's underlying file stream (ExcelJS does not when iteration stops early). */
function closeReader(reader: unknown): void {
    const st = (reader as { stream?: { destroy?: () => void; on?: (e: string, f: () => void) => void } }).stream;
    try {
        st?.on?.('error', () => undefined);
        st?.destroy?.();
    } catch { /* already closed */ }
}

export async function listSheets(file: string): Promise<string[]> {
    const names: string[] = [];
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, READER_OPTIONS);
    for await (const ws of reader) {
        names.push((ws as unknown as { name: string }).name);
        discard(ws);
    }
    closeReader(reader);
    return names;
}

export async function convertSheetToCsv(
    file: string,
    sheetIndex: number,
    outPath: string,
    token: CancelToken,
    onProgress: (rows: number) => void,
): Promise<number | null> {
    const tmp = `${outPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const out = fs.createWriteStream(tmp);
    await new Promise<void>((resolve, reject) => {
        out.once('open', () => resolve());
        out.once('error', reject);
    });
    out.on('error', () => undefined);
    const write = (text: string): Promise<void> =>
        new Promise<void>((resolve, reject) => out.write(text, (err) => (err ? reject(err) : resolve())));
    const cleanup = async (): Promise<void> => {
        out.destroy();
        await fs.promises.rm(tmp, { force: true });
    };
    try {
        let current = -1;
        let found = false;
        let width = 0;
        let lines = 0;
        let buffer: string[] = [];
        const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, READER_OPTIONS);
        let chosen: unknown;
        let cancelled = false;
        try {
            // Keep iterating after the chosen sheet: ExcelJS only releases a sheet's temp file when the reader moves past it.
            for await (const ws of reader) {
                current++;
                if (current !== sheetIndex || cancelled) {
                    discard(ws);
                    continue;
                }
                found = true;
                chosen = ws;
                for await (const row of ws as unknown as AsyncIterable<{ values: unknown }>) {
                    if (token.cancelled) {
                        cancelled = true;
                        break;
                    }
                    const cells = (row.values as unknown[]).slice(1).map(cellText);
                    if (lines === 0) {
                        width = cells.length;
                    }
                    while (cells.length < width) {
                        cells.push('');
                    }
                    buffer.push(`${cells.map((c) => csvField(c, ',')).join(',')}\n`);
                    lines++;
                    if (buffer.length >= 5000) {
                        await write(buffer.join(''));
                        buffer = [];
                        onProgress(Math.max(0, lines - 1));
                    }
                }
                discard(ws);
            }
        } finally {
            discard(chosen);
            closeReader(reader);
        }
        if (cancelled) {
            await cleanup();
            return null;
        }
        if (!found) {
            throw new Error(`The workbook has no sheet number ${sheetIndex + 1}.`);
        }
        if (buffer.length > 0) {
            await write(buffer.join(''));
        }
        await new Promise<void>((resolve) => out.end(resolve));
        try {
            await fs.promises.rename(tmp, outPath);
        } catch (err) {
            // Another conversion of the same sheet may have won the race.
            if (!fs.existsSync(outPath)) {
                throw err;
            }
            await fs.promises.rm(tmp, { force: true });
        }
        const rows = Math.max(0, lines - 1);
        onProgress(rows);
        return rows;
    } catch (err) {
        await cleanup();
        throw err;
    }
}
