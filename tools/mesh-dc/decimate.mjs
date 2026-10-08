/**
 * Error-bounded decimation of a role-noised DC bake.
 *
 * The exact coplanar merge (each dungeon's planar-merge.mts) reduces crisp
 * masonry ~10x, but a noised rock surface has no coplanar regions: it ships at
 * the raw dual-contouring density (one quad per 0.12 m cell). Noise relief is
 * 0.25-0.55 m at a 2 m feature size, so that density is wasted. This collapses
 * edges with meshoptimizer's quadric simplifier under an ABSOLUTE geometric
 * error bound (default 2 cm), weighting the splat channels and normals so
 * material borders and creases stay put, then compacts the vertex arrays.
 * Run it after the planar merge and gate the result with meshAudit as before.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../packages/render/package.json", import.meta.url));
const { MeshoptSimplifier } = await import(pathToFileURL(require.resolve("meshoptimizer")).href);
await MeshoptSimplifier.ready;

/**
 * mesh: { positions, normals, indices, splat, surfaceCount, tint?, vertexCount, triangleCount, min, max }
 * Returns a new mesh of the same shape plus `decimate: { before, after, error }`.
 */
export function decimateRough(mesh, { error = 0.02, splatWeight = 0.5, normalWeight = 0.25 } = {}) {
  const n = mesh.positions.length / 3;
  const S = mesh.surfaceCount;
  const stride = S + 3;
  const attrs = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < S; k++) attrs[i * stride + k] = mesh.splat[i * S + k] ?? 0;
    for (let k = 0; k < 3; k++) attrs[i * stride + S + k] = mesh.normals[i * 3 + k];
  }
  const weights = [...Array(S).fill(splatWeight), normalWeight, normalWeight, normalWeight];
  const indices = mesh.indices instanceof Uint32Array ? mesh.indices : Uint32Array.from(mesh.indices);
  const pos = mesh.positions instanceof Float32Array ? mesh.positions : Float32Array.from(mesh.positions);
  // A collapse can pinch two nearby sheets onto one edge (4 uses: non-manifold). Lock the vertices of every
  // pinched edge and their 1-ring in the SOURCE mesh and simplify again; a few rounds clear it.
  const lock = new Uint8Array(n);
  let ring = null, out, achieved, rounds = 0, locked = 0;
  for (;;) {
    [out, achieved] = MeshoptSimplifier.simplifyWithAttributes(indices, pos, 3, attrs, stride, weights, locked ? lock : null, 0, error, ["ErrorAbsolute"]);
    const uses = new Map();
    for (let t = 0; t < out.length; t += 3) for (let e = 0; e < 3; e++) {
      const p = out[t + e], q = out[t + (e + 1) % 3], k = p < q ? p * n + q : q * n + p;
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
    const pinched = [];
    for (const [k, c] of uses) if (c > 2) pinched.push(Math.floor(k / n), k % n);
    if (!pinched.length || rounds >= 6) break;
    if (!ring) {
      ring = Array.from({ length: n }, () => []);
      for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e++) ring[indices[t + e]].push(indices[t + (e + 1) % 3]);
    }
    // grow the lock by one more ring each round
    let frontier = pinched;
    for (let r = 0; r <= rounds + 1; r++) {
      const next = [];
      for (const v of frontier) { if (!lock[v]) { lock[v] = 1; locked++; } for (const w of ring[v]) if (!lock[w]) next.push(w); }
      frontier = next;
    }
    rounds++;
  }
  // compact
  const remap = new Int32Array(n).fill(-1);
  let m = 0;
  for (const v of out) if (remap[v] < 0) remap[v] = m++;
  const tintStride = mesh.tint ? mesh.tint.length / n : 0;
  const positions = new Float32Array(m * 3), normals = new Float32Array(m * 3), splat = new Float32Array(m * S);
  const tint = mesh.tint ? new Float32Array(m * tintStride) : undefined;
  for (let v = 0; v < n; v++) {
    const r = remap[v];
    if (r < 0) continue;
    for (let k = 0; k < 3; k++) { positions[r * 3 + k] = mesh.positions[v * 3 + k]; normals[r * 3 + k] = mesh.normals[v * 3 + k]; }
    for (let k = 0; k < S; k++) splat[r * S + k] = mesh.splat[v * S + k];
    if (tint) for (let k = 0; k < tintStride; k++) tint[r * tintStride + k] = mesh.tint[v * tintStride + k];
  }
  const newIndices = new Uint32Array(out.length);
  for (let i = 0; i < out.length; i++) newIndices[i] = remap[out[i]];
  const flips = repairSlivers(positions, newIndices);
  return {
    ...mesh, positions, normals, splat, ...(tint ? { tint } : {}), indices: newIndices,
    vertexCount: m, triangleCount: newIndices.length / 3,
    decimate: { before: indices.length / 3, after: newIndices.length / 3, error: achieved, sliverFlips: flips, pinchRounds: rounds, lockedVertices: locked },
  };
}

/**
 * A collapse can leave an exactly zero-area "cap" (three collinear corners). Flip its longest edge with the
 * neighbouring triangle: (a,b,c)+(b,a,d) -> (d,c,a)+(c,d,b). Orientation and the closed manifold are kept;
 * a flip that would duplicate an edge or stay degenerate is skipped (meshAudit then refuses the result).
 */
function repairSlivers(P, I) {
  const area2 = (a, b, c) => {
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  const len2 = (a, b) => (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
  let flips = 0;
  for (let pass = 0; pass < 4; pass++) {
    const bad = [];
    for (let t = 0; t < I.length; t += 3) if (!(area2(I[t], I[t + 1], I[t + 2]) > 0)) bad.push(t);
    if (!bad.length) break;
    const edge = new Map();
    for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) edge.set(I[t + e] + "," + I[t + (e + 1) % 3], t);
    for (const t of bad) {
      if (area2(I[t], I[t + 1], I[t + 2]) > 0) continue;
      let best = 0, bl = -1;
      for (let e = 0; e < 3; e++) { const l = len2(I[t + e], I[t + (e + 1) % 3]); if (l > bl) { bl = l; best = e; } }
      const a = I[t + best], b = I[t + (best + 1) % 3], c = I[t + (best + 2) % 3];
      const u = edge.get(b + "," + a);
      if (u === undefined) continue;
      let d = -1;
      for (let e = 0; e < 3; e++) if (I[u + e] !== a && I[u + e] !== b) d = I[u + e];
      if (d < 0 || d === c || edge.has(c + "," + d) || edge.has(d + "," + c)) continue;
      if (!(area2(d, c, a) > 0) || !(area2(c, d, b) > 0)) continue;
      I[t] = d; I[t + 1] = c; I[t + 2] = a;
      I[u] = c; I[u + 1] = d; I[u + 2] = b;
      for (const k of [a + "," + b, b + "," + a]) edge.delete(k);
      for (let e = 0; e < 3; e++) { edge.set(I[t + e] + "," + I[t + (e + 1) % 3], t); edge.set(I[u + e] + "," + I[u + (e + 1) % 3], u); }
      flips++;
    }
  }
  return flips;
}
