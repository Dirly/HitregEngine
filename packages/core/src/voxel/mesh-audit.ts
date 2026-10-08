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
    cells: 0, triangles: 0, bladeVertices: 0, bladeTriangles: 0, skirtBladeVertices: 0, skirtMaxAir: 0,
    slivers: 0, maxAir: 0, openEdges: 0, nonManifoldEdges: 0, openAt: [], worst: [],
  };
  const vertexIds = new Map<string, number>();
  const edgeUse = new Map<string, number>();
  const edgeOuter = new Set<string>();
  const edgeMid = new Map<string, [number, number, number]>();
  const minX = cx0 * S, maxX = (cx1 + 1) * S, minZ = cz0 * S, maxZ = (cz1 + 1) * S;
  const outer = (x: number, z: number): boolean =>
    Math.abs(x - minX) < 1e-3 || Math.abs(x - maxX) < 1e-3 || Math.abs(z - minZ) < 1e-3 || Math.abs(z - maxZ) < 1e-3;

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
