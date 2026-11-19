import type { Predicate } from './core/predicates';
import type { ColorMode, Layout, LongText } from './core/layout';
import type {
    ColumnStats, DuplicateColumnsResult, DuplicateResult, ExportOptions, ExportProgress, FileInfo, FilterProgress, FilterResult, ImportProgress, IndexProgress, PageResult, ParseOptions, UniqueResult,
} from './types';

// ---- host <-> worker ------------------------------------------------------

export type WorkerRequest =
    | { id: number; type: 'open'; path: string; options: ParseOptions }
    | { id: number; type: 'page'; page: number; pageSize: number }
    | { id: number; type: 'filter'; predicates: Predicate[] }
    | { id: number; type: 'unique'; column: number }
    | { id: number; type: 'stats'; column: number }
    | { id: number; type: 'duplicates'; columns: number[] }
    | { id: number; type: 'duplicateColumns' }
    | { id: number; type: 'nonEmptyColumns' }
    | { id: number; type: 'export'; options: ExportOptions }
    | { id: number; type: 'xlsxSheets'; path: string }
    | { id: number; type: 'xlsxConvert'; path: string; sheet: number; out: string }
    | { id: number; type: 'cancel'; target: number };

export type WorkerMessage =
    | { type: 'result'; id: number; data: unknown }
    | { type: 'failure'; id: number; message: string }
    | { type: 'progress'; id: number; data: IndexProgress | FilterProgress | ExportProgress | ImportProgress }
    | { type: 'fatal'; message: string };

/** A request without its id (the client assigns it). */
export type RequestBody = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

// ---- host <-> webview -----------------------------------------------------

export interface ViewerSettings {
    defaultPageSize: number;
    columnColors: ColorMode;
    longText: LongText;
    defaultColumnWidth: number;
}

/** Commands the host forwards to the webview (keybindings contributed in package.json). */
export type ViewCommand = 'hideSelectedColumn' | 'showAllColumns' | 'export';

export type HostToView =
    | { type: 'opened'; info: FileInfo; layout: Layout; settings: ViewerSettings; fileName: string }
    | { type: 'status'; kind: 'empty' | 'binary' | 'unsupported-encoding' | 'error'; message: string }
    | { type: 'error'; message: string; retry?: boolean }
    | { type: 'indexProgress'; progress: IndexProgress }
    | { type: 'page'; reqId: number; result: PageResult }
    | { type: 'filterProgress'; jobId: number; progress: FilterProgress }
    | { type: 'filterDone'; jobId: number; result: FilterResult }
    | { type: 'filterError'; jobId: number; message: string }
    | { type: 'unique'; jobId: number; result: UniqueResult | null; error?: string }
    | { type: 'stats'; jobId: number; result: ColumnStats | null; error?: string }
    | { type: 'duplicates'; jobId: number; result: DuplicateResult | null; error?: string }
    | { type: 'duplicateColumns'; jobId: number; result: DuplicateColumnsResult | null; error?: string }
    | { type: 'nonEmpty'; jobId: number; columns: number[] | null }
    | { type: 'fileChanged'; deleted: boolean }
    | { type: 'command'; name: ViewCommand };

export type ViewToHost =
    | { type: 'ready' }
    | { type: 'reload' }
    | { type: 'retry' }
    | { type: 'getPage'; reqId: number; page: number; pageSize: number }
    | { type: 'filter'; jobId: number; predicates: Predicate[] }
    | { type: 'unique'; jobId: number; column: number }
    | { type: 'stats'; jobId: number; column: number }
    | { type: 'duplicates'; jobId: number; columns: number[] }
    | { type: 'duplicateColumns'; jobId: number }
    | { type: 'cancel'; kind: 'filter' | 'unique' | 'analysis'; jobId: number }
    | { type: 'nonEmpty'; jobId: number }
    | { type: 'export'; columns: number[] }
    | { type: 'chooseParseOptions' }
    | { type: 'saveLayout'; layout: Layout }
    | { type: 'openInEditor'; text: string; language: string }
    | { type: 'copy'; text: string };
