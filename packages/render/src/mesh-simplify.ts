import * as THREE from "three/webgpu";
import { MeshoptSimplifier } from "meshoptimizer";

/**
 * Mesh decimation on top of meshoptimizer's WASM simplifier — the piece of
 * "Nanite for the web" that actually pays off for this engine. It replaces
 * three's `SimplifyModifier` for the instanced-prop mid LOD tier, which was
 * (a) slow enough to read as an editor hang once a chunk-streamed world
 * flushed enough unique models (tens to hundreds of ms per model), (b) prone
 * to throwing on real glTF topology (see docs/performance-lessons.md), and
 * (c) blind — it removed a fixed vertex fraction and told us nothing about
 * how wrong the result looked. meshoptimizer does the same job in single-
 * digit milliseconds on this project's actual trees (measured: 0.3–12 ms per
 * submesh across the nature pack and the 11k-tri soldier), never throws on
 * degenerate input, and returns the **geometric error** of the result, which
 * is what lets `FoliageLodSystem` pick the near→mid switch distance from
 * screen-space error instead of a hand-tuned constant.
 *
 * Strategy: attribute-aware quadric collapse first (`simplifyWithAttributes`,
 * preserving normal/uv seams), which is the right tool for solid geometry —
 * rocks, buildings, characters. Foliage built from disconnected leaf cards
 * resists it almost completely (measured 76–100 % of triangles kept on the
 * nature pack's canopies: every card edge is a border the quadric refuses to
 * cross), so when the quadric pass can't reach the target we fall back to
 * `simplifySloppy`, which ignores topology and merges spatially-close
 * features — that gets those same canopies to the target ratio with LOWER
 * measured geometric error than the quadric managed. Attribute quality is
 * worse under sloppy, which is fine for a tier only ever shown at a distance
 * where the geometric error is already sub-pixel.
 *
 * Synchronous once the WASM module has loaded — callers on an async path
 * await `simplifierReady()` first; anything that calls before then just gets
 * `null` ("no mid tier") rather than a throw.
 */

export interface SimplifiedGeometry {
  geometry: THREE.BufferGeometry;
  /** Maximum geometric deviation from the source, in the source geometry's
   * own local units (meshoptimizer's relative error × `getScale`). */
  error: number;
  /** Achieved triangle count / source triangle count. */
  ratio: number;
  method: "quadric" | "sloppy";
}

export interface SimplifyOptions {
  /** Fraction of the source triangle count to aim for. Default 0.35. */
  targetRatio?: number;
  /** Error budget for the quadric pass, relative to the mesh extents
   * (meshoptimizer convention; 0.05 = 5 % of the bounding radius). Default 0.05. */
  targetError?: number;
  /** When the quadric pass still keeps more than this fraction of triangles,
   * try the topology-agnostic sloppy pass and keep whichever is smaller.
   * Default 0.6. */
  sloppyFallbackAbove?: number;
  /** A result keeping at least this fraction isn't worth a second draw path
   * at all — return null instead. Default 0.9. */
  maxUsefulRatio?: number;
}

let wasmReady = false;
let warnedNotReady = false;
const readyPromise: Promise<void> = MeshoptSimplifier.supported
  ? MeshoptSimplifier.ready.then(
      () => {
        wasmReady = true;
      },
      (error: unknown) => {
        console.warn("[render] meshoptimizer failed to initialise; mid LOD tiers disabled:", error);
      },
    )
  : Promise.resolve();

/** Resolves once the simplifier can be called synchronously (never rejects —
 * an unsupported/failed WASM load just means `simplifyGeometry` returns null). */
export function simplifierReady(): Promise<void> {
  return readyPromise;
}

const UNUSED = 0xffffffff;
// meshoptimizer's recommended ballpark: normals matter about half as much as
// position for a distant tier; uv seams a bit more (a visibly torn texture
// reads worse than a slightly wrong shading normal).
const NORMAL_WEIGHT = 0.5;
const UV_WEIGHT = 1.0;

/** Plain, de-interleaved, de-normalised Float32 copy of one attribute — the
 * simplifier wants tightly packed floats, and glTF loaders routinely hand us
 * interleaved and/or normalised-integer attributes. */
function toFloat32(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i++) {
    for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent(i, c);
  }
  return out;
}

/**
 * Decimate `source` toward `targetRatio` of its triangles. Returns a NEW,
 * compacted, indexed geometry carrying every attribute the source had, or
 * `null` when there's nothing worth doing (empty/point/line geometry, WASM not
 * ready, or the result wouldn't be meaningfully smaller). Never throws on
 * geometry content; the source is left untouched.
 */
export function simplifyGeometry(
  source: THREE.BufferGeometry,
  options: SimplifyOptions = {},
): SimplifiedGeometry | null {
  if (!wasmReady) {
    if (!warnedNotReady && MeshoptSimplifier.supported) {
      warnedNotReady = true;
      console.warn("[render] simplifyGeometry called before meshoptimizer loaded — await simplifierReady() first");
    }
    return null;
  }
  const targetRatio = options.targetRatio ?? 0.35;
  const targetError = options.targetError ?? 0.05;
  const sloppyFallbackAbove = options.sloppyFallbackAbove ?? 0.6;
  const maxUsefulRatio = options.maxUsefulRatio ?? 0.9;

  const positionAttr = source.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!positionAttr || positionAttr.itemSize !== 3 || positionAttr.count < 3) return null;
  const vertexCount = positionAttr.count;
  const positions = toFloat32(positionAttr);

  let indices: Uint32Array;
  if (source.index) {
    const array = source.index.array;
    indices = array instanceof Uint32Array ? array : Uint32Array.from(array as ArrayLike<number>);
  } else {
    indices = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) indices[i] = i;
  }
  const indexCount = indices.length - (indices.length % 3);
  if (indexCount < 3) return null;
  if (indexCount !== indices.length) indices = indices.subarray(0, indexCount);
  const targetIndexCount = Math.max(3, Math.floor((indexCount * targetRatio) / 3) * 3);

  // secondary attributes the quadric pass should respect: normal + uv when present
  const normalAttr = source.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const uvAttr = source.getAttribute("uv") as THREE.BufferAttribute | undefined;
  const useNormal = !!normalAttr && normalAttr.itemSize === 3 && normalAttr.count === vertexCount;
  const useUv = !!uvAttr && uvAttr.itemSize === 2 && uvAttr.count === vertexCount;
  const attrStride = (useNormal ? 3 : 0) + (useUv ? 2 : 0);
  let quadric: [Uint32Array, number];
  if (attrStride > 0) {
    const attrs = new Float32Array(vertexCount * attrStride);
    const weights: number[] = [];
    let offset = 0;
    if (useNormal) {
      const normals = toFloat32(normalAttr!);
      for (let i = 0; i < vertexCount; i++) attrs.set(normals.subarray(i * 3, i * 3 + 3), i * attrStride + offset);
      weights.push(NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT);
      offset += 3;
    }
    if (useUv) {
      const uvs = toFloat32(uvAttr!);
      for (let i = 0; i < vertexCount; i++) attrs.set(uvs.subarray(i * 2, i * 2 + 2), i * attrStride + offset);
      weights.push(UV_WEIGHT, UV_WEIGHT);
    }
    quadric = MeshoptSimplifier.simplifyWithAttributes(
      indices,
      positions,
      3,
      attrs,
      attrStride,
      weights,
      null,
      targetIndexCount,
      targetError,
      ["Prune"],
    );
  } else {
    quadric = MeshoptSimplifier.simplify(indices, positions, 3, targetIndexCount, targetError, ["Prune"]);
  }

  let best = quadric;
  let method: SimplifiedGeometry["method"] = "quadric";
  if (quadric[0].length > sloppyFallbackAbove * indexCount) {
    // foliage cards / shattered topology: quadric refuses, sloppy doesn't care
    const sloppy = MeshoptSimplifier.simplifySloppy(indices, positions, 3, null, targetIndexCount, targetError * 2);
    if (sloppy[0].length < quadric[0].length && sloppy[0].length >= 3) {
      best = sloppy;
      method = "sloppy";
    }
  }
  const [resultIndices, relativeError] = best;
  if (resultIndices.length < 3 || resultIndices.length >= maxUsefulRatio * indexCount) return null;

  // drop the vertices nothing references any more — the simplified index
  // buffer still addresses the full source vertex range otherwise. NOTE:
  // compactMesh rewrites `resultIndices` IN PLACE to the compacted vertex
  // space as well as returning the old→new remap for the attributes.
  const [remap, uniqueCount] = MeshoptSimplifier.compactMesh(resultIndices);
  const geometry = new THREE.BufferGeometry();
  for (const name of Object.keys(source.attributes)) {
    const attr = source.attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    if (attr.count !== vertexCount) continue; // not a per-vertex attribute we can carry
    const src = name === "position" ? positions : toFloat32(attr);
    const size = attr.itemSize;
    const dst = new Float32Array(uniqueCount * size);
    for (let v = 0; v < vertexCount; v++) {
      const to = remap[v]!;
      if (to === UNUSED) continue;
      dst.set(src.subarray(v * size, v * size + size), to * size);
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(dst, size));
  }
  const compactIndices = uniqueCount <= 0xffff ? Uint16Array.from(resultIndices) : Uint32Array.from(resultIndices);
  geometry.setIndex(new THREE.BufferAttribute(compactIndices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    error: relativeError * MeshoptSimplifier.getScale(positions, 3),
    ratio: resultIndices.length / indexCount,
    method,
  };
}
