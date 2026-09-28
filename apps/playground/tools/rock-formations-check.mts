/**
 * The checks a baked rock-formation mesh must pass against the terrain AS MESHED
 * (`meshDensity(...).solid` answers from the marching-cubes triangles themselves, so this is
 * the surface the player sees, not `field.height`). Shared by `rock-formations.mts` (which
 * gates and repairs the bake with it) and `_site-audit.mts` check (f).
 *
 * - OPEN EDGES: a boundary edge (used by one triangle) is a hole unless the terrain hides it:
 *   its midpoint and the six points 0.3 m around it must all be inside the terrain.
 * - COMPONENTS (connected pieces, welded on position), the scree support rule applied to rock:
 *   (c) touching: some vertex has terrain within 0.2 m (inside, or 0.2 m in along -normal);
 *   (a) seated: at least half of its lowest metre of exposed vertices has terrain, or a supported
 *       piece, within 0.3 m below — or runs into the ground: a vertex of its one-ring is inside the
 *       terrain (a steep face's last vertex above the ground sits up to a lattice cell over it while
 *       its triangles carry on down, which is no gap);
 *   (d) slender: a piece under 2 m across in plan but taller than twice that is a spire or fin
 *       left between cuts, not a rock mass;
 *   (b) overhang: no exposed underside vertex (normal y < -0.3, not inside terrain) is more than
 *       1.5 m (horizontally) from the nearest vertex where it meets the ground or wall.
 */
import { meshDensity, type WorldField } from "@hitreg/core";

export interface CheckMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

export interface ComponentStat {
  index: number;
  triangles: number;
  size: [number, number, number];
  minY: number;
  touching: boolean;
  seated: number;
  overhang: number;
  ok: boolean;
  why: string;
}

export interface FormationCheck {
  openEdges: number;
  exposedOpenEdges: number;
  exposedAt: [number, number, number][];
  components: ComponentStat[];
  unsupported: number;
  /** Per-vertex component root index into `components` order. */
  vertexComponent: Int32Array;
}

export const OVERHANG_MAX = 1.5;
export const SEATED_MIN = 0.5;

export function terrainSolid(field: WorldField, mesh: CheckMesh, pad = 6) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < mesh.vertexCount; i++) {
    x0 = Math.min(x0, mesh.positions[i * 3]!); x1 = Math.max(x1, mesh.positions[i * 3]!);
    y0 = Math.min(y0, mesh.positions[i * 3 + 1]!); y1 = Math.max(y1, mesh.positions[i * 3 + 1]!);
    z0 = Math.min(z0, mesh.positions[i * 3 + 2]!); z1 = Math.max(z1, mesh.positions[i * 3 + 2]!);
  }
  const md = meshDensity(field, { x0: x0 - pad, y0: y0 - pad, z0: z0 - pad, x1: x1 + pad, y1: y1 + pad, z1: z1 + pad });
  return (x: number, y: number, z: number) => md.solid(x, y, z);
}

/** Weld on position (DC duplicates vertices across meshing blocks) and label connected pieces. */
export function components(mesh: CheckMesh): { weldId: Int32Array; root: (w: number) => number; welded: number } {
  const key = (i: number) => `${mesh.positions[i * 3]!.toFixed(4)},${mesh.positions[i * 3 + 1]!.toFixed(4)},${mesh.positions[i * 3 + 2]!.toFixed(4)}`;
  const weld = new Map<string, number>();
  const weldId = new Int32Array(mesh.vertexCount);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const k = key(i);
    let w = weld.get(k);
    if (w === undefined) weld.set(k, (w = weld.size));
    weldId[i] = w;
  }
  const parent = Int32Array.from({ length: weld.size }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = find(weldId[mesh.indices[t * 3]!]!);
    parent[find(weldId[mesh.indices[t * 3 + 1]!]!)] = a;
    parent[find(weldId[mesh.indices[t * 3 + 2]!]!)] = a;
  }
  return { weldId, root: find, welded: weld.size };
}

export function checkFormationMesh(mesh: CheckMesh, solid: (x: number, y: number, z: number) => boolean): FormationCheck {
  const { weldId, root } = components(mesh);
  const P = (i: number, a: number) => mesh.positions[i * 3 + a]!;
  // ---- open edges (on welded ids)
  const edges = new Map<string, { n: number; a: number; b: number }>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[t * 3 + k]!, b = mesh.indices[t * 3 + ((k + 1) % 3)]!;
      const wa = weldId[a]!, wb = weldId[b]!;
      const key = wa < wb ? `${wa}_${wb}` : `${wb}_${wa}`;
      const e = edges.get(key);
      if (e) e.n++;
      else edges.set(key, { n: 1, a, b });
    }
  }
  let openEdges = 0, exposedOpenEdges = 0;
  const exposedAt: [number, number, number][] = [];
  for (const e of edges.values()) {
    if (e.n !== 1) continue;
    openEdges++;
    const m: [number, number, number] = [(P(e.a, 0) + P(e.b, 0)) / 2, (P(e.a, 1) + P(e.b, 1)) / 2, (P(e.a, 2) + P(e.b, 2)) / 2];
    const r = 0.3;
    const buried = [[0, 0, 0], [r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]].every(([dx, dy, dz]) => solid(m[0] + dx!, m[1] + dy!, m[2] + dz!));
    if (!buried) {
      exposedOpenEdges++;
      if (exposedAt.length < 20) exposedAt.push(m);
    }
  }
  // one-ring neighbours on welded ids
  const ring = new Map<number, number[]>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[t * 3 + k]!, b = mesh.indices[t * 3 + ((k + 1) % 3)]!;
      const wa = weldId[a]!;
      let l = ring.get(wa);
      if (!l) ring.set(wa, (l = []));
      l.push(b);
      const wb = weldId[b]!;
      let m = ring.get(wb);
      if (!m) ring.set(wb, (m = []));
      m.push(a);
    }
  }
  // ---- components
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < mesh.vertexCount; i++) {
    const r = root(weldId[i]!);
    let list = byRoot.get(r);
    if (!list) byRoot.set(r, (list = []));
    list.push(i);
  }
  const triCount = new Map<number, number>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    const r = root(weldId[mesh.indices[t * 3]!]!);
    triCount.set(r, (triCount.get(r) ?? 0) + 1);
  }
  const roots = [...byRoot.keys()].sort((a, b) => (triCount.get(b) ?? 0) - (triCount.get(a) ?? 0));
  const vertexComponent = new Int32Array(mesh.vertexCount).fill(-1);
  const stats: ComponentStat[] = [];
  // supported pieces' vertices in a 1 m hash, so a smaller piece may sit on a bigger supported one
  const supportHash = new Set<string>();
  const cellKey = (x: number, y: number, z: number) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  const nearSupported = (x: number, y: number, z: number) => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (supportHash.has(cellKey(x + dx * 0.3, y + dy * 0.3, z + dz * 0.3))) return true;
    return false;
  };
  roots.forEach((r, index) => {
    const verts = byRoot.get(r)!;
    for (const v of verts) vertexComponent[v] = index;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of verts) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, P(v, a)); hi[a] = Math.max(hi[a]!, P(v, a)); }
    const inside = (v: number) => solid(P(v, 0), P(v, 1), P(v, 2));
    const contact = (v: number) => inside(v) || solid(P(v, 0) - mesh.normals[v * 3]! * 0.2, P(v, 1) - mesh.normals[v * 3 + 1]! * 0.2, P(v, 2) - mesh.normals[v * 3 + 2]! * 0.2);
    const contacts = verts.filter(contact);
    const touching = contacts.length > 0;
    // (a) the lowest metre of its EXPOSED surface (a buried foot is seated by definition)
    const exposed = verts.filter((v) => !inside(v));
    const minExposed = exposed.reduce((m, v) => Math.min(m, P(v, 1)), Infinity);
    const low = exposed.filter((v) => P(v, 1) < minExposed + 1);
    const held = low.filter((v) => {
      for (let t = 0; t <= 0.3 + 1e-9; t += 0.1) if (solid(P(v, 0), P(v, 1) - t, P(v, 2))) return true;
      for (const u of ring.get(weldId[v]!) ?? []) if (P(u, 1) < P(v, 1) && inside(u)) return true;
      return nearSupported(P(v, 0), P(v, 1) - 0.3, P(v, 2));
    });
    const seated = low.length ? held.length / low.length : 1;
    // (b) exposed underside far from any contact
    let overhang = 0;
    const cx = contacts.map((v) => [P(v, 0), P(v, 2)] as const);
    for (const v of exposed) {
      if (mesh.normals[v * 3 + 1]! > -0.3) continue;
      let best = Infinity;
      for (const [x, z] of cx) best = Math.min(best, Math.hypot(P(v, 0) - x, P(v, 2) - z));
      overhang = Math.max(overhang, best);
    }
    const plan = Math.min(hi[0]! - lo[0]!, hi[2]! - lo[2]!);
    const slender = plan < 2 && hi[1]! - lo[1]! > 2 * plan;
    const why = [!touching ? "floating" : "", slender ? `slender ${plan.toFixed(1)} m` : "", seated < SEATED_MIN ? `seated ${(seated * 100).toFixed(0)}%` : "", overhang > OVERHANG_MAX ? `overhang ${overhang.toFixed(1)} m` : ""].filter(Boolean).join(", ");
    const ok = !why;
    if (ok) for (const v of verts) supportHash.add(cellKey(P(v, 0), P(v, 1), P(v, 2)));
    stats.push({ index, triangles: triCount.get(r) ?? 0, size: [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!], minY: lo[1]!, touching, seated, overhang, ok, why });
  });
  return { openEdges, exposedOpenEdges, exposedAt, components: stats, unsupported: stats.filter((s) => !s.ok).length, vertexComponent };
}
