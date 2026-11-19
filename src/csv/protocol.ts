import type { Predicate } from './core/predicates';
import type { ColorMode, Layout, LongText } from './core/layout';
import type {
    FileInfo, FilterProgress, FilterResult, IndexProgress, PageResult, ParseOptions, UniqueResult,
} from './types';

// ---- host <-> worker ------------------------------------------------------

export type WorkerRequest =
    | { id: number; type: 'open'; path: string; options: ParseOptions }
    | { id: number; type: 'page'; page: number; pageSize: number }
    | { id: number; type: 'filter'; predicates: Predicate[] }
    | { id: number; type: 'unique'; column: number }
    | { id: number; type: 'nonEmptyColumns' }
    | { id: number; type: 'cancel'; target: number };

export type WorkerMessage =
    | { type: 'result'; id: number; data: unknown }
    | { type: 'failure'; id: number; message: string }
    | { type: 'progress'; id: number; data: IndexProgress | FilterProgress }
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

export type HostToView =
    | { type: 'opened'; info: FileInfo; layout: Layout; settings: ViewerSettings; fileName: string }
    | { type: 'status'; kind: 'empty' | 'binary' | 'unsupported-encoding' | 'error'; message: string }
    | { type: 'error'; message: string }
    | { type: 'indexProgress'; progress: IndexProgress }
    | { type: 'page'; reqId: number; result: PageResult }
    | { type: 'filterProgress'; jobId: number; progress: FilterProgress }
    | { type: 'filterDone'; jobId: number; result: FilterResult }
    | { type: 'filterError'; jobId: number; message: string }
    | { type: 'unique'; jobId: number; result: UniqueResult | null }
    | { type: 'nonEmpty'; columns: number[] | null }
    | { type: 'fileChanged'; deleted: boolean };

export type ViewToHost =
    | { type: 'ready' }
    | { type: 'reload' }
    | { type: 'getPage'; reqId: number; page: number; pageSize: number }
    | { type: 'filter'; jobId: number; predicates: Predicate[] }
    | { type: 'unique'; jobId: number; column: number }
    | { type: 'cancel'; jobId: number }
    | { type: 'nonEmpty' }
    | { type: 'chooseParseOptions' }
    | { type: 'saveLayout'; layout: Layout }
    | { type: 'openInEditor'; text: string; language: string }
    | { type: 'copy'; text: string };
