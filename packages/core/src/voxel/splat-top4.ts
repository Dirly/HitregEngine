import type { VoxelMesh } from "./mesh.js";

/** Layer id written into an unused slot of `layerIndex` (its weight is always 0). */
export const SPLAT_TOP_UNUSED = 255;

export interface SplatTop4Options {
  /**
   * Group id per palette surface (-1 = none): weight on a layer that does not
   * make a triangle's four is handed to a kept layer of the SAME group (a
   * zone's grass and the base grass), so it fades instead of popping.
   */
  roleGroup?: Int8Array | null;
  /** A layer must carry at least this much summed weight over a triangle's three corners to be kept. */
  minWeight?: number;
}

/**
 * Reduce a mesh's dense per-vertex splat to the FOUR layers each vertex blends.
 *
 * Output: `layerIndex` (4 palette ids per vertex, `SPLAT_TOP_UNUSED` in an
 * empty slot) and `layerWeight` (4 weights per vertex, 0..255, summing to
 * ~255). Two 4-byte attributes however deep the palette is; the shader
 * samples those four layers from one texture array.
 *
 * The ids are interpolated across a triangle like any attribute, so all three
 * corners of a triangle must name the SAME ordered set — otherwise the
 * fragment would read a blend of two ids, which is a third, unrelated layer.
 * So the set is chosen per TRIANGLE (the heaviest four of its corners'
 * summed weights, sorted by id) and a vertex is duplicated only where two
 * triangles sharing it chose different sets. Positions, normals and tint are
 * copied with it, so the duplicate is invisible: same place, same shading,
 * and the same weight on every layer both copies carry.
 *
 * Pure typed-array work, run where the mesh is built (the voxel worker), so
 * the main thread never pays for it.
 */
export function reduceSplatTop4(mesh: VoxelMesh, options: SplatTop4Options = {}): VoxelMesh {
  const S = mesh.surfaceCount;
  const V = mesh.vertexCount;
  const T = mesh.triangleCount;
  if (V === 0 || S === 0 || T === 0) {
    return { ...mesh, layerIndex: new Uint8Array(V * 4), layerWeight: new Uint8Array(V * 4) };
  }
  const minWeight = options.minWeight ?? 0.02;
  const group = options.roleGroup ?? null;
  const splat = mesh.splat;
  const indices = mesh.indices;

  const sums = new Float32Array(S);
  const firstKey = new Uint32Array(V);
  const firstNew = new Int32Array(V).fill(-1);
  const extra = new Map<number, Map<number, number>>();
  // worst case every corner is its own vertex
  const source = new Int32Array(T * 3);
  const keyOfNew = new Uint32Array(T * 3);
  const heavyOfNew = new Uint8Array(T * 3);
  const outIndices = new Uint32Array(T * 3);
  let count = 0;
  const set = [0, 0, 0, 0];

  for (let t = 0; t < T; t++) {
    sums.fill(0);
    const a = indices[t * 3]!;
    const b = indices[t * 3 + 1]!;
    const c = indices[t * 3 + 2]!;
    for (let s = 0; s < S; s++) sums[s] = splat[a * S + s]! + splat[b * S + s]! + splat[c * S + s]!;
    // heaviest four, by repeated selection (S is small)
    let n = 0;
    let heavyLayer = -1;
    for (let k = 0; k < 4; k++) {
      let best = -1;
      let bestW = minWeight;
      for (let s = 0; s < S; s++) {
        const w = sums[s]!;
        if (w >= bestW && (best < 0 || w > bestW)) {
          let taken = false;
          for (let q = 0; q < n; q++) if (set[q] === s) taken = true;
          if (taken) continue;
          best = s;
          bestW = w;
        }
      }
      if (best < 0) break;
      if (k === 0) heavyLayer = best;
      set[n++] = best;
    }
    if (n === 0) {
      // nothing carries weight (a degenerate splat): the first layer, as the shader's fallback does
      set[0] = 0;
      heavyLayer = 0;
      n = 1;
    }
    // canonical order so equal sets compare equal
    for (let i = 1; i < n; i++) {
      const v = set[i]!;
      let j = i - 1;
      while (j >= 0 && set[j]! > v) {
        set[j + 1] = set[j]!;
        j--;
      }
      set[j + 1] = v;
    }
    for (let i = n; i < 4; i++) set[i] = SPLAT_TOP_UNUSED;
    const key = (set[0]! | (set[1]! << 8) | (set[2]! << 16) | (set[3]! << 24)) >>> 0;
    let heavySlot = 0;
    for (let i = 0; i < n; i++) if (set[i] === heavyLayer) heavySlot = i;

    for (let corner = 0; corner < 3; corner++) {
      const v = indices[t * 3 + corner]!;
      let out: number;
      if (firstNew[v]! < 0) {
        out = count++;
        firstNew[v] = out;
        firstKey[v] = key;
        source[out] = v;
        keyOfNew[out] = key;
        heavyOfNew[out] = heavySlot;
      } else if (firstKey[v] === key) {
        out = firstNew[v]!;
      } else {
        let byKey = extra.get(v);
        if (!byKey) extra.set(v, (byKey = new Map()));
        const found = byKey.get(key);
        if (found !== undefined) out = found;
        else {
          out = count++;
          byKey.set(key, out);
          source[out] = v;
          keyOfNew[out] = key;
          heavyOfNew[out] = heavySlot;
        }
      }
      outIndices[t * 3 + corner] = out;
    }
  }

  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const tint = new Float32Array(count * 3);
  const hasTint = mesh.tint.length === V * 3;
  const outSplat = new Float32Array(count * S);
  const layerIndex = new Uint8Array(count * 4);
  const layerWeight = new Uint8Array(count * 4);
  const w = [0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    const v = source[i]!;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = mesh.positions[v * 3 + k]!;
      normals[i * 3 + k] = mesh.normals[v * 3 + k]!;
      if (hasTint) tint[i * 3 + k] = mesh.tint[v * 3 + k]!;
    }
    outSplat.set(splat.subarray(v * S, v * S + S), i * S);
    const key = keyOfNew[i]!;
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const layer = (key >>> (k * 8)) & 0xff;
      layerIndex[i * 4 + k] = layer;
      w[k] = layer === SPLAT_TOP_UNUSED || layer >= S ? 0 : splat[v * S + layer]!;
    }
    if (group) {
      // dropped weight goes to a kept layer of the same role group
      for (let s = 0; s < S; s++) {
        const g = group[s]!;
        if (g < 0) continue;
        const ws = splat[v * S + s]!;
        if (ws <= 0) continue;
        let kept = false;
        let into = -1;
        for (let k = 0; k < 4; k++) {
          const layer = layerIndex[i * 4 + k]!;
          if (layer === s) kept = true;
          else if (into < 0 && layer !== SPLAT_TOP_UNUSED && layer < S && group[layer] === g) into = k;
        }
        if (!kept && into >= 0) w[into] = w[into]! + ws;
      }
    }
    for (let k = 0; k < 4; k++) sum += w[k]!;
    if (sum <= 1e-6) {
      layerWeight[i * 4 + heavyOfNew[i]!] = 255;
      continue;
    }
    const inv = 255 / sum;
    for (let k = 0; k < 4; k++) layerWeight[i * 4 + k] = Math.round(w[k]! * inv);
  }

  return {
    ...mesh,
    positions,
    normals,
    indices: outIndices,
    splat: outSplat,
    tint: hasTint ? tint : mesh.tint,
    vertexCount: count,
    triangleCount: T,
    layerIndex,
    layerWeight,
  };
}
