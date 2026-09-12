/** Types for `_gltf-bounds.mjs` (zero-dep glTF/GLB bounding box, see that file). */

export interface ModelBounds {
  min: [number, number, number];
  max: [number, number, number];
  /** Full extents [x, y, z]. */
  size: [number, number, number];
  triangles: number;
  /** Radius of the ground footprint circle the prop occupies. */
  radius: number;
  /** Texture names, in file order — what the `wind.materials` filter matches on. */
  textures?: string[];
}

export function boundsOf(
  doc: unknown,
  bufferBytes: (index: number) => Buffer,
  roots?: number[],
): ModelBounds;

export function modelBounds(file: string): ModelBounds & { textures: string[] };
