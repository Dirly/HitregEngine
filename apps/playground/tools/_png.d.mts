/** Types for the dependency-free PNG codec in `_png.mjs` (RGBA8 in, RGBA8 out). */
export function decodePng(buf: Uint8Array | Buffer): { width: number; height: number; data: Uint8Array };
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer;
