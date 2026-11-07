/* tslint:disable */
/* eslint-disable */

export function wasm_cancel_session(session_id: string): boolean;

export function wasm_detect(session_id: string, params_js: any): any;

export function wasm_drop_session(session_id: string): boolean;

export function wasm_export_file(session_id: string, format: string, color_space?: string | null): Uint8Array;

export function wasm_ingest_and_detect(file_name: string, bytes: Uint8Array | number[], params_js: any): any;

export function wasm_ingest_and_detect_json(file_name: string, bytes: Uint8Array | number[], params_json: string): string;

export function wasm_init(): void;

export function wasm_inpaint(session_id: string, params_js: any): any;

export function wasm_multi_detect(config_js: any): any;

export function wasm_render_tile(session_id: string, layer: string, level: number, tx: number, ty: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly wasm_cancel_session: (a: number, b: number) => number;
    readonly wasm_detect: (a: number, b: number, c: any) => [number, number, number];
    readonly wasm_drop_session: (a: number, b: number) => number;
    readonly wasm_export_file: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasm_ingest_and_detect: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly wasm_ingest_and_detect_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly wasm_init: () => void;
    readonly wasm_inpaint: (a: number, b: number, c: any) => [number, number, number];
    readonly wasm_multi_detect: (a: any) => [number, number, number];
    readonly wasm_render_tile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
