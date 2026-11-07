/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const wasm_cancel_session: (a: number, b: number) => number;
export const wasm_detect: (a: number, b: number, c: any) => [number, number, number];
export const wasm_drop_session: (a: number, b: number) => number;
export const wasm_export_file: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const wasm_ingest_and_detect: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
export const wasm_ingest_and_detect_json: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
export const wasm_init: () => void;
export const wasm_inpaint: (a: number, b: number, c: any) => [number, number, number];
export const wasm_multi_detect: (a: any) => [number, number, number];
export const wasm_render_tile: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
