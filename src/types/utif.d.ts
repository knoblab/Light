declare module 'utif' {
  export function decode(buffer: ArrayBuffer | Uint8Array): any[];
  export function decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: any): void;
  export function toRGBA8(ifd: any): Uint8Array;
}
