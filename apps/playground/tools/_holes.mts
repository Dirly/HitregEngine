/**
 * The pure half of the HOLES gate (tools/holes.mts): what counts as a hole in a column, the triangle grid the render
 * side is cast against, the sample lattice and the clustering. No world, no server: tested on synthetic columns in
 * test/holes.test.ts.
 *
 * A column is sampled three ways at one (x, z):
 *   surface  the open-air ground the recipe field says is there (`field.surfaceCast`): what the terrain mesh draws;
 *   render   the highest BUILT render surface over the column (landmark render GLBs), or null;
 *   collider the first PHYSICS hit casting straight down, against the colliders the server holds for a body standing
 *            there (terrain cells, landmark collider tiles, ribbons, kit/town pieces, props) — or null.
 * The body walks on `collider`. The player sees max(surface, render). A hole is where what is seen has nothing under it.
 */

/** The character's autostep (packages/physics DEFAULT_CHARACTER): a collider lower than the seen surface by more than this is a sink. */
export const AUTOSTEP = 0.4;
/** Slack for the marching-cubes mesh against the field it samples (2 m lattice: up to ~half a voxel on a slope). */
export const MESH_SLACK = 0.6;
/** A collider this far under the seen surface (or none at all) is a hole the body falls into. */
export const HOLE_DEPTH = 3;

export type HoleKind =
  /** no collider at all under ground the player sees: falls through the earth */
  | "no-collider"
  /** the collider is metres under the seen ground (a missing/offset collider over terrain, a mesh hole) */
  | "deep"
  /** the collider is under the seen ground by more than the autostep (sinks to the knees, a step that can't be climbed back) */
  | "sink"
  /** a landmark's visible surface stands over nothing it collides with */
  | "landmark-render"
  /** a portal arrival spot (an anchor + the landing lift, and the spots arrivals line up on) with no floor under it, or inside the rock */
  | "arrival";

export interface Column {
  x: number;
  z: number;
  /** Field surface (terrain). null = no ground at all (outside the world / open sea floor below the band). */
  surface: number | null;
  /** Lowest field surface within the slack neighbourhood (a 2 m ring): what the mesh may legitimately sit at on a slope. */
  surfaceMin: number | null;
  /** Highest landmark render surface over the column, or null. */
  render: number | null;
  /** First physics hit casting down from above everything, or null. */
  collider: number | null;
}

export interface HoleFault { x: number; z: number; kind: HoleKind; seen: number; collider: number | null; drop: number }

/** One column's verdict: null = fine. */
export function classifyColumn(c: Column): HoleFault | null {
  if (c.surface === null) return null;
  const terrainSeen = c.surfaceMin ?? c.surface;
  // a landmark drawn above the ground with no collider at its height
  if (c.render !== null && c.render > c.surface + AUTOSTEP) {
    if (c.collider === null || c.collider < c.render - MESH_SLACK - AUTOSTEP) {
      return { x: c.x, z: c.z, kind: "landmark-render", seen: c.render, collider: c.collider, drop: c.render - (c.collider ?? terrainSeen) };
    }
  }
  if (c.collider === null) return { x: c.x, z: c.z, kind: "no-collider", seen: c.surface, collider: null, drop: Infinity };
  const drop = terrainSeen - c.collider;
  if (drop > HOLE_DEPTH) return { x: c.x, z: c.z, kind: "deep", seen: c.surface, collider: c.collider, drop };
  if (drop > MESH_SLACK + AUTOSTEP) return { x: c.x, z: c.z, kind: "sink", seen: c.surface, collider: c.collider, drop };
  return null;
}

/**
 * What fails the gate: no collider at all under seen ground, a landmark drawn over nothing, an arrival spot with no
 * floor. `deep` and `sink` are LISTED, not failed: the terrain's render mesh IS its collider (one voxelMesh, three
 * consumers), so a collider under the field's surface there is the mesher's band or lattice not drawing a thin field
 * feature — seen and walked alike; check those with tools/voxel-blades.mts / see-through when they sit on a route.
 */
export const FALLS: ReadonlySet<HoleKind> = new Set(["no-collider", "landmark-render", "arrival"]);

/**
 * One portal arrival spot: `spot` is where the body's centre is put (anchor + PORTAL_LANDING_LIFT), `floor` the first
 * physics hit below it within 4 m (null = none), `inRock` whether the field is solid at the spot. The body must land
 * on something within a short drop (2.5 m) and must not start inside the rock.
 */
export function classifyArrival(spot: [number, number, number], floor: number | null, inRock: boolean): HoleFault | null {
  const drop = floor === null ? Infinity : spot[1] - floor;
  if (inRock || floor === null || drop > 2.5 || drop < 0.2) return { x: spot[0], z: spot[2], kind: "arrival", seen: spot[1], collider: floor, drop: inRock ? -1 : drop };
  return null;
}

/**
 * Triangles binned on an XZ grid for vertical rays (the render side: a landmark's merged GLB in world space).
 * `top(x, z)` = the highest triangle surface over the point, or null.
 */
export class TriangleGrid {
  private readonly bins = new Map<string, number[]>();
  private readonly tris: number[] = [];
  constructor(private readonly cell = 2) {}
  /** Add one triangle (9 numbers, world space). */
  add(t: ArrayLike<number>): void {
    const i = this.tris.length / 9;
    for (let k = 0; k < 9; k++) this.tris.push(t[k]!);
    const x0 = Math.min(t[0]!, t[3]!, t[6]!), x1 = Math.max(t[0]!, t[3]!, t[6]!);
    const z0 = Math.min(t[2]!, t[5]!, t[8]!), z1 = Math.max(t[2]!, t[5]!, t[8]!);
    for (let bx = Math.floor(x0 / this.cell); bx <= Math.floor(x1 / this.cell); bx++) {
      for (let bz = Math.floor(z0 / this.cell); bz <= Math.floor(z1 / this.cell); bz++) {
        const key = `${bx},${bz}`;
        let b = this.bins.get(key);
        if (!b) this.bins.set(key, (b = []));
        b.push(i);
      }
    }
  }
  get size(): number { return this.tris.length / 9; }
  top(x: number, z: number): number | null {
    const b = this.bins.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (!b) return null;
    let best: number | null = null;
    const T = this.tris;
    for (const i of b) {
      const o = i * 9;
      const ax = T[o]!, ay = T[o + 1]!, az = T[o + 2]!, bx = T[o + 3]!, by = T[o + 4]!, bz = T[o + 5]!, cx = T[o + 6]!, cy = T[o + 7]!, cz = T[o + 8]!;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue; // vertical face: no top
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * ay + v * by + w * cy;
      if (best === null || y > best) best = y;
    }
    return best;
  }
}

/** Point in polygon (XZ), even-odd. */
export function inPolygon(x: number, z: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export interface LatticeInput {
  /** Area: a polygon, or a rect [x0, z0, x1, z1]. */
  polygon?: ReadonlyArray<readonly [number, number]>;
  rect: [number, number, number, number];
  coarse: number;
  fine: number;
  /** Discs sampled at the fine step: places, landmarks, towns. */
  discs: Array<{ x: number; z: number; r: number }>;
  /** Polylines sampled at the fine step within `halfWidth`: roads, paths. */
  lines: Array<{ points: Array<[number, number]>; halfWidth: number }>;
}

/** The sample points: the coarse lattice over the area plus the fine lattice on places and roads (deduplicated). */
export function samplePoints(inp: LatticeInput): Array<[number, number]> {
  const [x0, z0, x1, z1] = inp.rect;
  const keep = (x: number, z: number) => x >= x0 && x <= x1 && z >= z0 && z <= z1 && (!inp.polygon || inPolygon(x, z, inp.polygon));
  const seen = new Set<string>();
  const out: Array<[number, number]> = [];
  const put = (x: number, z: number) => {
    const key = `${Math.round(x * 4)},${Math.round(z * 4)}`;
    if (seen.has(key) || !keep(x, z)) return;
    seen.add(key);
    out.push([x, z]);
  };
  const c = inp.coarse;
  for (let x = Math.ceil(x0 / c) * c; x <= x1; x += c) for (let z = Math.ceil(z0 / c) * c; z <= z1; z += c) put(x, z);
  const f = inp.fine;
  for (const d of inp.discs) {
    for (let x = Math.ceil((d.x - d.r) / f) * f; x <= d.x + d.r; x += f) {
      for (let z = Math.ceil((d.z - d.r) / f) * f; z <= d.z + d.r; z += f) if ((x - d.x) ** 2 + (z - d.z) ** 2 <= d.r * d.r) put(x, z);
    }
  }
  for (const l of inp.lines) {
    for (let i = 0; i + 1 < l.points.length; i++) {
      const [ax, az] = l.points[i]!, [bx, bz] = l.points[i + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len === 0) continue;
      const lx0 = Math.min(ax, bx) - l.halfWidth, lx1 = Math.max(ax, bx) + l.halfWidth;
      const lz0 = Math.min(az, bz) - l.halfWidth, lz1 = Math.max(az, bz) + l.halfWidth;
      if (lx1 < x0 || lx0 > x1 || lz1 < z0 || lz0 > z1) continue;
      for (let x = Math.ceil(lx0 / f) * f; x <= lx1; x += f) {
        for (let z = Math.ceil(lz0 / f) * f; z <= lz1; z += f) {
          const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (len * len)));
          if (Math.hypot(x - (ax + t * (bx - ax)), z - (az + t * (bz - az))) <= l.halfWidth) put(x, z);
        }
      }
    }
  }
  return out;
}

export interface HoleCluster { x: number; z: number; kind: HoleKind; count: number; worstDrop: number; seen: number; collider: number | null; near: string }

/** Faults within `radius` of each other (same kind) become one site; `near` names the closest owner. */
export function clusterFaults(faults: HoleFault[], owners: Array<{ id: string; x: number; z: number }>, radius = 4): HoleCluster[] {
  const out: Array<HoleCluster & { sx: number; sz: number }> = [];
  for (const f of faults) {
    let hit = out.find((c) => c.kind === f.kind && Math.hypot(c.x - f.x, c.z - f.z) <= radius * Math.max(1, Math.sqrt(c.count)));
    if (!hit) {
      hit = { x: f.x, z: f.z, sx: 0, sz: 0, kind: f.kind, count: 0, worstDrop: 0, seen: f.seen, collider: f.collider, near: "" };
      out.push(hit);
    }
    hit.count++;
    hit.sx += f.x; hit.sz += f.z;
    hit.x = hit.sx / hit.count; hit.z = hit.sz / hit.count;
    if (f.drop > hit.worstDrop) { hit.worstDrop = f.drop; hit.seen = f.seen; hit.collider = f.collider; }
  }
  for (const c of out) {
    let best = "", bd = Infinity;
    for (const o of owners) { const d = Math.hypot(o.x - c.x, o.z - c.z); if (d < bd) { bd = d; best = o.id; } }
    c.near = best ? `${best} (${Math.round(bd)} m)` : "";
  }
  return out.map(({ sx: _sx, sz: _sz, ...c }) => ({ ...c, x: Math.round(c.x * 10) / 10, z: Math.round(c.z * 10) / 10 }))
    .sort((a, b) => (FALLS.has(b.kind) ? 1 : 0) - (FALLS.has(a.kind) ? 1 : 0) || b.count - a.count);
}
