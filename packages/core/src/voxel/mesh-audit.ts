/**
 * Blade / hole detector for extracted voxel chunks.
 *
 * A terrain triangle belongs on (or inside) the density surface. Two failures
 * break that and both read as "the mesher is broken" in play:
 *
 * - **Blades.** Geometry standing in open air: a vertex whose density says
 *   AIR by more than a tolerance. The classic one was a cell-boundary skirt
 *   (mesh.ts `addSkirts`) hanging a fixed 6 m off a passage roof or a thin
 *   ridge and poking out through the far side of the rock as a long pale
 *   sliver. Geometry buried in rock is invisible and harmless; geometry in
 *   air is a visible, collidable, prop-snappable spike.
 * - **Holes.** Open edges after welding every cell of a region by position:
 *   a seam whose two sides disagree, a band that ended mid-surface.
 *
 * The audit meshes cells exactly as render, physics and placement do
 * (`buildVoxelMesh`), so its numbers describe the one shared mesh.
 */
import type { WorldField } from "./field.js";
import { buildVoxelMesh, type VoxelMesh, type VoxelMeshSource } from "./mesh.js";

export interface VoxelMeshAuditOptions {
  /** Inclusive cell range [cx0, cz0, cx1, cz1]. */
  cells: readonly [number, number, number, number];
  lodStep?: number;
  mesher?: VoxelMeshSource["mesher"];
  /** Probe distance for the clearance test. Default: half a lattice step. */
  reach?: number;
  /** Clearance density (min over vertex + six probes) above which a vertex stands in air. Default 0.25. */
  airTolerance?: number;
  /** How many of the worst blades to return. */
  worst?: number;
}

export interface VoxelMeshBlade {
  /** World-space vertex position that stands in air. */
  at: [number, number, number];
  cell: [number, number];
  /** Clearance: the least field density over the vertex and six probes `reach` away (≈ metres of air). */
  air: number;
  /** Longest edge of the worst triangle using it. */
  edge: number;
  /** A skirt end rather than a surface vertex. */
  skirt: boolean;
}

export interface VoxelMeshAuditResult {
  cells: number;
  triangles: number;
  /**
   * Unique vertices whose density says air beyond the tolerance. Includes
   * surface vertices that marching cubes' linear interpolation put a little
   * off a sharply curved field — tolerance-sized, not blades.
   */
  bladeVertices: number;
  /** Triangles with at least one such vertex. */
  bladeTriangles: number;
  /**
   * Skirt ENDS in air: a flap vertex no surface triangle uses, standing
   * outside the rock. Any is a blade (the zone-5/Gnawspur failure); must be 0.
   */
  skirtBladeVertices: number;
  skirtMaxAir: number;
  /** Skirt flap triangles (all three vertices on one cell-side plane). */
  skirtTriangles: number;
  /**
   * Flap triangles with any part outside the RENDERED rock (centroid or a point halfway to a corner, by ray parity
   * against the region's own surface triangles; see `skirtVisibility`): seen from
   * outside the rock. Must be 0 — a skirt is only legitimate inside rock (the HLOD crack cover).
   */
  skirtExposed: number;
  /** Of `skirtExposed`, those shaded as ground (mean normal y > 0.5): the PALE blades on a cliff wall. */
  skirtPale: number;
  /** Where the first exposed flaps are (world space). */
  skirtAt: [number, number, number][];
  /** Long thin triangles (longest edge > 2 steps, area small for its length) with an air vertex. */
  slivers: number;
  maxAir: number;
  /** Welded edges used by one triangle, excluding the region's outer boundary and skirt flaps. */
  openEdges: number;
  /** Welded edges used by more than two triangles (doubled surface). */
  nonManifoldEdges: number;
  /** Midpoints of the first open edges, world space. */
  openAt: [number, number, number][];
  worst: VoxelMeshBlade[];
}

/** True when all three vertices sit on one vertical cell-side plane — a skirt flap, open by design. */
function onSidePlane(p: Float32Array, a: number, b: number, c: number, cellSize: number): boolean {
  const eps = 1e-3;
  for (const axis of [0, 2]) {
    const va = p[a * 3 + axis]!;
    if (Math.abs(va) > eps && Math.abs(va - cellSize) > eps) continue;
    if (Math.abs(p[b * 3 + axis]! - va) < eps && Math.abs(p[c * 3 + axis]! - va) < eps) return true;
  }
  return false;
}

const PROBES: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export function auditVoxelMesh(field: WorldField, options: VoxelMeshAuditOptions): VoxelMeshAuditResult {
  const [cx0, cz0, cx1, cz1] = options.cells;
  const lodStep = Math.max(1, Math.floor(options.lodStep ?? 1));
  const step = field.voxelSize * lodStep;
  const S = field.recipe.cellSize;
  const tol = options.airTolerance ?? 0.25;
  const reach = options.reach ?? step * 0.5;
  const keep = options.worst ?? 10;
  const result: VoxelMeshAuditResult = {
    cells: 0, triangles: 0, bladeVertices: 0, bladeTriangles: 0, skirtBladeVertices: 0, skirtMaxAir: 0, skirtTriangles: 0, skirtExposed: 0, skirtPale: 0, skirtAt: [],
    slivers: 0, maxAir: 0, openEdges: 0, nonManifoldEdges: 0, openAt: [], worst: [],
  };
  const vertexIds = new Map<string, number>();
  const edgeUse = new Map<string, number>();
  const edgeOuter = new Set<string>();
  const edgeMid = new Map<string, [number, number, number]>();
  const minX = cx0 * S, maxX = (cx1 + 1) * S, minZ = cz0 * S, maxZ = (cz1 + 1) * S;
  const outer = (x: number, z: number): boolean =>
    Math.abs(x - minX) < 1e-3 || Math.abs(x - maxX) < 1e-3 || Math.abs(z - minZ) < 1e-3 || Math.abs(z - maxZ) < 1e-3;
  /** Every audited cell's mesh, for the skirt-visibility pass against the rendered surface. */
  const kept: { pos: Float32Array; idx: Uint32Array; nrm: Float32Array; flap: Uint8Array; surface: Uint8Array; ox: number; oz: number }[] = [];

  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const source = { kind: "voxel", world: "audit", cell: [cx, cz], lodStep, ...(options.mesher ? { mesher: options.mesher } : {}) } as VoxelMeshSource;
      const mesh: VoxelMesh = buildVoxelMesh(field, source);
      result.cells++;
      const pos = mesh.positions;
      const idx = mesh.indices;
      const ox = cx * S, oz = cz * S;
      const nv = pos.length / 3;
      const tris = idx.length / 3;
      result.triangles += tris;
      const air = new Float32Array(nv);
      const welded = new Int32Array(nv);
      for (let v = 0; v < nv; v++) {
        const x = pos[v * 3]! + ox, y = pos[v * 3 + 1]!, z = pos[v * 3 + 2]! + oz;
        // Clearance, not raw density: a heightfield cliff makes density jump by
        // hundreds across a centimetre, so a vertex sitting correctly on a
        // sheer wall can read "200 of air". Take the MINIMUM over the vertex and
        // six probes `reach` away: positive only when there is no rock within
        // reach along any axis, i.e. the vertex really stands out in the open.
        let m = field.density(x, y, z);
        if (m > tol) {
          for (const [dx, dy, dz] of PROBES) {
            m = Math.min(m, field.density(x + dx * reach, y + dy * reach, z + dz * reach));
            if (m <= tol) break;
          }
        }
        air[v] = m;
        // 1 cm weld: a lattice sample within a hair of zero gives sub-mm edges that
        // round differently per cell and would read as phantom open edges
        const key = `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`;
        let id = vertexIds.get(key);
        if (id === undefined) {
          id = vertexIds.size;
          vertexIds.set(key, id);
        }
        welded[v] = id;
      }
      // A skirt END is a vertex no surface triangle uses: the far edge of a flap.
      const flap = new Uint8Array(tris);
      const surfaceVertex = new Uint8Array(nv);
      for (let t = 0; t < tris; t++) {
        const a = idx[t * 3]!, b = idx[t * 3 + 1]!, c = idx[t * 3 + 2]!;
        if (onSidePlane(pos, a, b, c, S)) flap[t] = 1;
        else surfaceVertex[a] = surfaceVertex[b] = surfaceVertex[c] = 1;
      }
      kept.push({ pos, idx, nrm: mesh.normals, flap, surface: surfaceVertex, ox, oz });
      const counted = new Uint8Array(nv);
      const L = (p: number, q: number): number =>
        Math.hypot(pos[p * 3]! - pos[q * 3]!, pos[p * 3 + 1]! - pos[q * 3 + 1]!, pos[p * 3 + 2]! - pos[q * 3 + 2]!);
      for (let t = 0; t < tris; t++) {
        const a = idx[t * 3]!, b = idx[t * 3 + 1]!, c = idx[t * 3 + 2]!;
        const longest = Math.max(L(a, b), L(b, c), L(c, a));
        let exposed = -1;
        for (const v of [a, b, c]) {
          if (air[v]! > tol && (exposed < 0 || air[v]! > air[exposed]!)) exposed = v;
        }
        if (exposed >= 0) {
          result.bladeTriangles++;
          if (air[exposed]! > result.maxAir) result.maxAir = air[exposed]!;
          const ux = pos[b * 3]! - pos[a * 3]!, uy = pos[b * 3 + 1]! - pos[a * 3 + 1]!, uz = pos[b * 3 + 2]! - pos[a * 3 + 2]!;
          const wx = pos[c * 3]! - pos[a * 3]!, wy = pos[c * 3 + 1]! - pos[a * 3 + 1]!, wz = pos[c * 3 + 2]! - pos[a * 3 + 2]!;
          const area2 = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
          if (longest > step * 2 && longest * longest > 8 * area2) result.slivers++;
          for (const v of [a, b, c]) {
            if (air[v]! <= tol || counted[v]) continue;
            counted[v] = 1;
            const skirt = !surfaceVertex[v];
            result.bladeVertices++;
            if (skirt) {
              result.skirtBladeVertices++;
              if (air[v]! > result.skirtMaxAir) result.skirtMaxAir = air[v]!;
            }
            result.worst.push({ at: [pos[v * 3]! + ox, pos[v * 3 + 1]!, pos[v * 3 + 2]! + oz], cell: [cx, cz], air: air[v]!, edge: longest, skirt });
          }
          if (result.worst.length > keep * 8 + 64) {
            result.worst.sort((p, q) => q.air - p.air);
            result.worst.length = keep;
          }
        }
        if (flap[t]) continue;
        for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
          const u = welded[p]!, w = welded[q]!;
          if (u === w) continue;
          const key = u < w ? `${u}_${w}` : `${w}_${u}`;
          const uses = (edgeUse.get(key) ?? 0) + 1;
          edgeUse.set(key, uses);
          if (uses === 1) edgeMid.set(key, [(pos[p * 3]! + pos[q * 3]!) / 2 + ox, (pos[p * 3 + 1]! + pos[q * 3 + 1]!) / 2, (pos[p * 3 + 2]! + pos[q * 3 + 2]!) / 2 + oz]);
          if (outer(pos[p * 3]! + ox, pos[p * 3 + 2]! + oz) && outer(pos[q * 3]! + ox, pos[q * 3 + 2]! + oz)) edgeOuter.add(key);
        }
      }
    }
  }
  skirtVisibility(kept, S, [minX, minZ, maxX, maxZ], result);
  for (const [key, n] of edgeUse) {
    if (n === 1 && !edgeOuter.has(key)) {
      result.openEdges++;
      if (result.openAt.length < keep) result.openAt.push(edgeMid.get(key)!);
    }
    else if (n > 2) result.nonManifoldEdges++;
  }
  result.worst.sort((p, q) => q.air - p.air);
  result.worst.length = Math.min(result.worst.length, keep);
  return result;
}

/**
 * The thin solid lattice cells behind blades: for each point (an air vertex the audit found, an open-edge midpoint),
 * the solid corners of the lattice cube around it (and its 1-cell ring) that are ONE SAMPLE THICK — air on both
 * sides along some axis (a fin, a sliver, a spike), which marching cubes draws as a blade standing in the air.
 * Clearing them (`features.floaterClears`) removes the blade; a cell with rock on at least one side along every
 * axis (the ground mass, a surface sample) is never returned. Flat (gx, gy, gz) triples, deduplicated, skipping cells already in `skip`.
 */
export function bladeClearCells(
  field: Pick<WorldField, "density" | "voxelSize">,
  points: readonly (readonly [number, number, number])[],
  options: { ring?: number; skip?: ReadonlySet<string> } = {},
): number[] {
  const v = field.voxelSize, ring = options.ring ?? 1;
  const solid = new Map<string, boolean>();
  const isSolid = (gx: number, gy: number, gz: number): boolean => {
    const k = `${gx},${gy},${gz}`;
    let s = solid.get(k);
    if (s === undefined) { s = field.density(gx * v, gy * v, gz * v) < 0; solid.set(k, s); }
    return s;
  };
  const out: number[] = [], seen = new Set<string>();
  for (const [x, y, z] of points) {
    const bx = Math.floor(x / v), by = Math.floor(y / v), bz = Math.floor(z / v);
    for (let gx = bx - ring; gx <= bx + ring; gx++) for (let gy = by - ring; gy <= by + ring; gy++) for (let gz = bz - ring; gz <= bz + ring; gz++) {
      const k = `${gx},${gy},${gz}`;
      if (seen.has(k) || options.skip?.has(k)) continue;
      seen.add(k);
      if (!isSolid(gx, gy, gz)) continue;
      const thin =
        (!isSolid(gx + 1, gy, gz) && !isSolid(gx - 1, gy, gz)) ||
        (!isSolid(gx, gy + 1, gz) && !isSolid(gx, gy - 1, gz)) ||
        (!isSolid(gx, gy, gz + 1) && !isSolid(gx, gy, gz - 1));
      if (thin) out.push(gx, gy, gz);
    }
  }
  return out;
}

/**
 * Skirt flaps seen from outside: a flap is legitimate only BURIED in the rendered rock. Each flap triangle is tested
 * at its centroid and halfway to each corner, a hair to either side of its cell plane (both cells' sides, where the
 * region holds both), for inside/outside of the region's RENDERED surface by ray parity (+y; the band's top is open
 * sky). Measured against the mesh rather than the field on purpose: the dual mesher's planar walls and MC's chords
 * both stand a little off the density surface, so a field test both misses flaps standing proud of a wall (within
 * a clearance) and flags buried ones (in a bulge of the mesh).
 */
function skirtVisibility(
  kept: readonly { pos: Float32Array; idx: Uint32Array; nrm: Float32Array; flap: Uint8Array; surface: Uint8Array; ox: number; oz: number }[],
  S: number,
  [minX, minZ, maxX, maxZ]: readonly [number, number, number, number],
  result: VoxelMeshAuditResult,
): void {
  const G = 2;
  const grid = new Map<number, number[]>();
  const key = (gx: number, gz: number): number => (gx + 32768) * 65536 + (gz + 32768);
  for (let c = 0; c < kept.length; c++) {
    const { pos, idx, flap, ox, oz } = kept[c]!;
    for (let t = 0; t < idx.length / 3; t++) {
      if (flap[t]) continue;
      const a = idx[t * 3]!, b = idx[t * 3 + 1]!, d = idx[t * 3 + 2]!;
      const x0 = Math.min(pos[a * 3]!, pos[b * 3]!, pos[d * 3]!) + ox, x1 = Math.max(pos[a * 3]!, pos[b * 3]!, pos[d * 3]!) + ox;
      const z0 = Math.min(pos[a * 3 + 2]!, pos[b * 3 + 2]!, pos[d * 3 + 2]!) + oz, z1 = Math.max(pos[a * 3 + 2]!, pos[b * 3 + 2]!, pos[d * 3 + 2]!) + oz;
      for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G); gx++) for (let gz = Math.floor(z0 / G); gz <= Math.floor(z1 / G); gz++) {
        const k = key(gx, gz);
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(c * 4194304 + t);
      }
    }
  }
  /** Inside the rendered rock: an odd number of surface crossings straight above. */
  const inside = (x: number, y: number, z: number): boolean => {
    const list = grid.get(key(Math.floor(x / G), Math.floor(z / G)));
    if (!list) return false;
    let n = 0;
    for (const e of list) {
      const { pos, idx, ox, oz } = kept[Math.floor(e / 4194304)]!;
      const t = e % 4194304;
      const a = idx[t * 3]!, b = idx[t * 3 + 1]!, d = idx[t * 3 + 2]!;
      const ax = pos[a * 3]! + ox, az = pos[a * 3 + 2]! + oz, bx = pos[b * 3]! + ox, bz = pos[b * 3 + 2]! + oz, dx = pos[d * 3]! + ox, dz = pos[d * 3 + 2]! + oz;
      const area = (bx - ax) * (dz - az) - (dx - ax) * (bz - az);
      if (Math.abs(area) < 1e-12) continue; // vertical: no crossing
      const u = ((bx - x) * (dz - z) - (dx - x) * (bz - z)) / area;
      const v = ((dx - x) * (az - z) - (ax - x) * (dz - z)) / area;
      const w = 1 - u - v;
      if (u < 0 || v < 0 || w < 0) continue;
      if (u * pos[a * 3 + 1]! + v * pos[b * 3 + 1]! + w * pos[d * 3 + 1]! > y) n++;
    }
    return (n & 1) === 1;
  };
  const eps = 0.00137, jitter = 0.000731;
  for (const { pos, idx, nrm, flap, surface, ox, oz } of kept) {
    for (let t = 0; t < idx.length / 3; t++) {
      if (!flap[t]) continue;
      const a = idx[t * 3]!, b = idx[t * 3 + 1]!, c = idx[t * 3 + 2]!;
      // a triangle lying in the plane whose corners are all surface vertices is SURFACE (MC and the dual clip put a few
      // faces exactly on a cell plane), not a flap: a skirt always has an extruded corner no surface triangle uses
      if (surface[a] && surface[b] && surface[c]) continue;
      // and a flap under 5 mm across (the dual clip's near-coincident corners) shows nothing
      const ux = pos[b * 3]! - pos[a * 3]!, uy = pos[b * 3 + 1]! - pos[a * 3 + 1]!, uz = pos[b * 3 + 2]! - pos[a * 3 + 2]!;
      const wx = pos[c * 3]! - pos[a * 3]!, wy = pos[c * 3 + 1]! - pos[a * 3 + 1]!, wz = pos[c * 3 + 2]! - pos[a * 3 + 2]!;
      const longest = Math.max(Math.hypot(ux, uy, uz), Math.hypot(wx, wy, wz), Math.hypot(wx - ux, wy - uy, wz - uz));
      if (Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) < 0.005 * longest) continue;
      result.skirtTriangles++;
      const axis = Math.abs(pos[a * 3]! - pos[b * 3]!) < 1e-3 && Math.abs(pos[a * 3]! - pos[c * 3]!) < 1e-3 && (Math.abs(pos[a * 3]!) < 1e-3 || Math.abs(pos[a * 3]! - S) < 1e-3) ? 0 : 2;
      const cx = (pos[a * 3]! + pos[b * 3]! + pos[c * 3]!) / 3 + ox;
      const cy = (pos[a * 3 + 1]! + pos[b * 3 + 1]! + pos[c * 3 + 1]!) / 3;
      const cz = (pos[a * 3 + 2]! + pos[b * 3 + 2]! + pos[c * 3 + 2]!) / 3 + oz;
      let exposed: [number, number, number] | null = null;
      for (const v of [-1, a, b, c]) {
        const px = v < 0 ? cx : (cx + pos[v * 3]! + ox) / 2, py = v < 0 ? cy : (cy + pos[v * 3 + 1]!) / 2, pz = v < 0 ? cz : (cz + pos[v * 3 + 2]! + oz) / 2;
        for (const side of [-1, 1]) {
          const qx = axis === 0 ? px + side * eps : px + jitter, qz = axis === 2 ? pz + side * eps : pz + jitter;
          if (qx < minX || qx > maxX || qz < minZ || qz > maxZ) continue;
          if (!inside(qx, py, qz)) { exposed = [px, py, pz]; break; }
        }
        if (exposed) break;
      }
      if (!exposed) continue;
      result.skirtExposed++;
      if (result.skirtAt.length < 16) result.skirtAt.push(exposed);
      if ((nrm[a * 3 + 1]! + nrm[b * 3 + 1]! + nrm[c * 3 + 1]!) / 3 > 0.5) result.skirtPale++;
    }
  }
}
