import * as THREE from "three/webgpu";

/**
 * Turn an ordinary 2D colour-lookup image into the `Data3DTexture` that
 * `Lut3DNode` samples.
 *
 * Two layouts are accepted, because those are the two that image editors and
 * grading tools actually export:
 *
 * - **strip** — `N` slices left to right: `N*N` wide, `N` tall.
 * - **tile sheet** — a square grid of `N` slices: `N*sqrt(N)` on a side
 *   (only meaningful when `N` is a perfect square, e.g. 16, 64).
 *
 * A `.cube` file is deliberately not handled here: parsing it belongs to
 * whatever loads the asset, not to the renderer.
 */
export interface Lut3D {
  texture: THREE.Data3DTexture;
  size: number;
}

/** Cache keyed on the source texture — a LUT never changes once decoded. */
const cache = new WeakMap<THREE.Texture, Lut3D | null>();

export function lut3DTextureFrom(source: THREE.Texture): Lut3D | null {
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const built = build(source);
  cache.set(source, built);
  return built;
}

type ImageLike = { width: number; height: number };

function build(source: THREE.Texture): Lut3D | null {
  const image = source.image as ImageLike | undefined;
  if (!image || !image.width || !image.height) return null;
  const layout = detectLayout(image.width, image.height);
  if (!layout) return null;
  const pixels = readPixels(source, image.width, image.height);
  if (!pixels) return null;

  const { size, columns } = layout;
  const data = new Uint8Array(size * size * size * 4);
  for (let z = 0; z < size; z++) {
    const tileX = (z % columns) * size;
    const tileY = Math.floor(z / columns) * size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const src = ((tileY + y) * image.width + tileX + x) * 4;
        const dst = (z * size * size + y * size + x) * 4;
        data[dst] = pixels[src] as number;
        data[dst + 1] = pixels[src + 1] as number;
        data[dst + 2] = pixels[src + 2] as number;
        data[dst + 3] = 255;
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.type = THREE.UnsignedByteType;
  texture.format = THREE.RGBAFormat;
  // A LUT is sampled with trilinear interpolation between neighbouring cells —
  // NearestFilter here is what produces the banded, posterised look people
  // mistake for "the LUT is broken".
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  // The LUT holds already-graded display values; treating it as sRGB would run
  // the transfer function twice.
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, size };
}

interface Layout {
  size: number;
  columns: number;
}

/** Exported for tests: which LUT layout, if any, an image's dimensions imply. */
export function detectLayout(width: number, height: number): Layout | null {
  // strip: width = size * size, height = size
  if (width === height * height && isUsableSize(height)) {
    return { size: height, columns: height };
  }
  // vertical strip: height = size * size, width = size
  if (height === width * width && isUsableSize(width)) {
    return { size: width, columns: 1 };
  }
  // square tile sheet: side = size * sqrt(size)
  if (width === height) {
    for (const size of [8, 16, 25, 27, 32, 36, 49, 64]) {
      const columns = Math.round(Math.sqrt(size));
      if (columns * columns === size && size * columns === width) return { size, columns };
    }
  }
  return null;
}

function isUsableSize(size: number): boolean {
  return Number.isInteger(size) && size >= 2 && size <= 64;
}

function readPixels(source: THREE.Texture, width: number, height: number): Uint8ClampedArray | null {
  const image = source.image as unknown;
  // Already decoded (Data/DataArray textures, or an ImageData handed straight in)
  const maybeData = (image as { data?: unknown }).data;
  if (maybeData instanceof Uint8ClampedArray) return maybeData;
  if (maybeData instanceof Uint8Array) return new Uint8ClampedArray(maybeData.buffer.slice(0));
  if (typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image as CanvasImageSource, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  } catch {
    // cross-origin images taint the canvas; a LUT that cannot be read is simply
    // not applied rather than taking the frame down
    return null;
  }
}
