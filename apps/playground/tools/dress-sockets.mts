/**
 * dress sockets — measure a building model into a `socket-map` (packages/core/src/dressing/schema.ts):
 * free floor, walls with their uninterrupted spans, headroom, rooms, and the stairs / wells / doorways /
 * entry lane that must stay clear. One map per BUILDING MODEL, in the model's own local frame, so it is
 * measured once and reused in every town that places the model.
 *
 *   dress sockets --project <p> --id <map id> --model <glb> [--floor-y 0] [--storey 3.2]
 *                 [--door x,z --facing x,z] [--footprint "x,z;x,z;..."] [--step 0.25] [--floor-relief 0.06] [--quiet]
 *   dress sockets --project <p> --from-layout <layout.json> --building <id> [--auto] [--id <map id>]
 *   either path: [--out-dir <dir>]   write the map and its .steps.json there instead of authoring/dressing/sockets
 *   either path: [--markers <file>]   the kit's fixture markers; default (path 1): <model>.markers.json beside the model
 *
 * Fixture markers (`<model>.markers.json`, written by the building kit's exporter) are read when they exist:
 *   { "model", "markers": [ { id, kind, level, position: [x,y,z], yaw, size: [w,h,d] } ] }, model frame, yaw 0 = +Z.
 *   Light/fire markers become anchors (MARKER_MOUNTS: hearth/forge floor, sconce/lantern/candle-niche wall, chandelier
 *   ceiling, chimney-top an OUTDOOR floor point); `hearth-clearance` turns its floor rectangle (size w x d about
 *   position, turned by yaw) into 'H' cells: walkable, no solid prop (the resolver refuses and warns like a stair).
 *   `stair-foot`, `stair-head` and `stair-approach` (the way on and off a stair, side gap included) take the same
 *   path into 'A' cells (no solid prop; the resolver demands a player-wide lane to each) and a floor anchor of their
 *   kind that nothing may be placed on.
 *   `dress fixtures` then puts the default lit prefab on each anchor.
 * Then the CIRCULATION MASK (`circulate`, packages/core/src/dressing/resolve.ts): per level, walking paths as wide as
 *   the resolver's lane (DEFAULT_LANE_WIDTH) from the door / stair head to every doorway, stair approach, the hearth's
 *   clear zone and into every room, plus a spine wherever free floor is over CIRCULATION_REACH m from a path. Their free
 *   floor becomes 'x' cells: no solid prop, rugs allowed.
 *
 * Path 1 (the town pipeline): a standalone building GLB in its own frame, ground floor flat at --floor-y
 *   (buildings stand on a flat foundation pad, so the shell needs no ground slab). Without --footprint the
 *   footprint is the largest region the walls enclose (slices up to lintel height close doors and windows);
 *   without --door the door is the widest wall gap where the interior meets the outside, preferring +Z.
 *   --facing points INTO the building.
 * Path 2 (test path for Brinehold): one building is cut out of its baked district GLB (manifest beside it),
 *   moved into its model frame (origin at the footprint centre on its ground, yaw and preRot removed, so the
 *   street/door side is local +Z as the WFC exporter builds it) and run through the same pipeline. --auto
 *   ignores the layout's corners and door, to test path 1's detection on real geometry.
 *
 * Writes projects/<p>/authoring/dressing/sockets/<id>.json and prints a summary plus an ASCII plan per level.
 * Ported from projects/proving/authoring/towns/interior-grid.mts (+ interior-walls.mjs, brinehold-props
 * findDoor): wall slices at hip/waist/chest, roof ray for headroom, 0.75 m erosion to split rooms at
 * doorways, stair treads by up-facing normals 0.45-0.86 (51 and 35 degree flights), wells where an upper floor has no slab.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { analyse, controllerLimits, laneTable, profileLine, stepTable, sweepLane, type LaneSweep, type ProbeLine, type Surfaces } from "./dress-steps.mts";
import { circulate, DEFAULT_LANE_WIDTH, socketMapSchema, SOCKET_CELLS, HEAD_STEP, type SocketMap, type SocketLevel, type SocketWall, type SocketRoom, type SocketAnchor } from "@hitreg/core";

type P2 = [number, number];
const PLAYGROUND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- triangle soup + GLB reading

/** Triangles as a flat array, 9 floats each (ax,ay,az,bx,...), plus a per-triangle roof-material flag. */
export interface TriSoup { pos: Float32Array; roof: Uint8Array; /** per triangle: index into `names` (the GLB node, else mesh, name) */ node?: Uint16Array; names?: string[] }

const COMP: Record<number, any> = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readGlbFile(file: string): { json: any; bin: Buffer } {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`);
  let o = 12, json: any = null, bin: Buffer | null = null;
  while (o + 8 <= b.length) {
    const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4), data = b.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8")); else if (type === 0x004e4942) bin = data;
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json || !bin) throw new Error(`GLB without JSON/BIN chunk: ${file}`);
  return { json, bin };
}
function accessor(g: { json: any; bin: Buffer }, i: number): ArrayLike<number> {
  const a = g.json.accessors[i], v = g.json.bufferViews[a.bufferView], T = COMP[a.componentType], n = NCOMP[a.type]!;
  const size = T.BYTES_PER_ELEMENT, stride = v.byteStride ?? n * size, base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0), out = new T(a.count * n);
  const dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
  const get = T === Float32Array ? (o: number) => dv.getFloat32(o, true) : T === Uint32Array ? (o: number) => dv.getUint32(o, true) : T === Uint16Array ? (o: number) => dv.getUint16(o, true)
    : T === Uint8Array ? (o: number) => dv.getUint8(o) : T === Int16Array ? (o: number) => dv.getInt16(o, true) : (o: number) => dv.getInt8(o);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = get(base + k * stride + c * size);
  return out;
}
type M4 = number[];
const mul = (a: M4, b: M4): M4 => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r]! * b[c * 4 + k]!; return o; };
const nodeMatrix = (n: any): M4 => {
  if (n.matrix) return n.matrix;
  const t = n.translation ?? [0, 0, 0], q = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1], [x, y, z, w] = q;
  return [(1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0, 2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0, t[0], t[1], t[2], 1];
};

/** Every triangle of a GLB's default scene in model space (node transforms applied), with roof flags by material name. */
export function glbTriangles(file: string, transform?: (x: number, y: number, z: number) => [number, number, number], keep?: (t: number[]) => boolean): TriSoup {
  const g = readGlbFile(file), json = g.json, out: number[] = [], roof: number[] = [], nodeOf: number[] = [], names: string[] = [], nameIx = new Map<string, number>();
  const walk = (i: number, parent: M4) => {
    const node = json.nodes[i], m = mul(parent, nodeMatrix(node));
    const nm = String(node.name ?? json.meshes?.[node.mesh]?.name ?? `node${i}`); let ni = nameIx.get(nm); if (ni === undefined) { ni = names.length; names.push(nm); nameIx.set(nm, ni); }
    if (node.mesh != null) for (const prim of json.meshes[node.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4) continue;
      const p = accessor(g, prim.attributes.POSITION), idx = prim.indices != null ? accessor(g, prim.indices) : Uint32Array.from({ length: p.length / 3 }, (_, k) => k);
      const isRoof = /roof/i.test(json.materials?.[prim.material]?.name ?? "") ? 1 : 0;
      const tri = new Array<number>(9);
      for (let k = 0; k < idx.length; k += 3) {
        for (let v = 0; v < 3; v++) {
          const j = idx[k + v]! * 3, x = p[j]!, y = p[j + 1]!, z = p[j + 2]!;
          let wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
          if (transform) [wx, wy, wz] = transform(wx, wy, wz);
          tri[v * 3] = wx; tri[v * 3 + 1] = wy; tri[v * 3 + 2] = wz;
        }
        if (keep && !keep(tri)) continue;
        out.push(...tri); roof.push(isRoof); nodeOf.push(ni);
      }
    }
    for (const c of node.children ?? []) walk(c, m);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of json.scenes[json.scene ?? 0].nodes) walk(r, I);
  return { pos: Float32Array.from(out), roof: Uint8Array.from(roof), node: Uint16Array.from(nodeOf), names };
}

// ---------------------------------------------------------------- geometry queries

const inPoly = (x: number, z: number, poly: P2[]) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
const segCross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number) => { const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px); const d1 = o(ax, az, bx, bz, cx, cz), d2 = o(ax, az, bx, bz, dx, dz), d3 = o(cx, cz, dx, dz, ax, az), d4 = o(cx, cz, dx, dz, bx, bz); return d1 * d2 <= 0 && d3 * d4 <= 0 && (d1 !== 0 || d2 !== 0); };
const segDist = (x: number, z: number, s: ArrayLike<number>) => { const dx = s[2]! - s[0]!, dz = s[3]! - s[1]!, L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - s[0]!) * dx + (z - s[1]!) * dz) / L)); return Math.hypot(x - s[0]! - t * dx, z - s[1]! - t * dz); };

/** XZ bins over the soup so vertical rays only test nearby triangles. */
class Mesh {
  readonly n: number; readonly bins = new Map<number, number[]>(); readonly B = 1;
  constructor(readonly s: TriSoup) {
    this.n = s.pos.length / 9;
    for (let t = 0; t < this.n; t++) {
      const p = s.pos, o = t * 9;
      const i0 = Math.floor(Math.min(p[o]!, p[o + 3]!, p[o + 6]!) / this.B), i1 = Math.floor(Math.max(p[o]!, p[o + 3]!, p[o + 6]!) / this.B);
      const j0 = Math.floor(Math.min(p[o + 2]!, p[o + 5]!, p[o + 8]!) / this.B), j1 = Math.floor(Math.max(p[o + 2]!, p[o + 5]!, p[o + 8]!) / this.B);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = this.key(i, j); let a = this.bins.get(k); if (!a) this.bins.set(k, (a = [])); a.push(t); }
    }
  }
  key(i: number, j: number) { return (i + 50000) * 100000 + (j + 50000); }
  /** Each surface crossing the vertical line at (x,z): calls f(y, normalY sign/size as unnormalised ny, tri). */
  column(x: number, z: number, f: (y: number, ny: number, t: number) => void) {
    const list = this.bins.get(this.key(Math.floor(x / this.B), Math.floor(z / this.B))); if (!list) return;
    const p = this.s.pos;
    for (const t of list) {
      const o = t * 9, ax = p[o]!, ay = p[o + 1]!, az = p[o + 2]!, bx = p[o + 3]!, by = p[o + 4]!, bz = p[o + 5]!, cx = p[o + 6]!, cy = p[o + 7]!, cz = p[o + 8]!;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz); if (Math.abs(d) < 1e-9) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, w = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d; if (u < 0 || w < 0 || u + w > 1) continue;
      f(u * ay + w * by + (1 - u - w) * cy, (bz - az) * (cx - ax) - (bx - ax) * (cz - az), t);
    }
  }
  /** Lowest down-facing surface more than 1 m above y (a ceiling or roof underside); Infinity = open sky. */
  roofAbove(x: number, z: number, y: number) { let best = Infinity; this.column(x, z, (yy, ny) => { if (yy > y + 1.0 && ny < 0 && yy < best) best = yy; }); return best; }
  /** An up-facing surface within 0.2 m of y (a floor slab). */
  slabAt(x: number, z: number, y: number) { let hit = false; this.column(x, z, (yy, ny) => { if (ny > 0 && Math.abs(yy - y) <= 0.2) hit = true; }); return hit; }
  /** Plane cut at height y: segments [x0,z0,x1,z1] whose bbox meets bb [x0,x1,z0,z1]. */
  slice(y: number, bb: number[]): number[][] {
    const p = this.s.pos, segs: number[][] = [];
    for (let t = 0; t < this.n; t++) {
      const o = t * 9; if (y < Math.min(p[o + 1]!, p[o + 4]!, p[o + 7]!) || y > Math.max(p[o + 1]!, p[o + 4]!, p[o + 7]!)) continue;
      const pts: number[] = [];
      for (let e = 0; e < 3; e++) { const a = o + e * 3, b = o + ((e + 1) % 3) * 3; if ((p[a + 1]! - y) * (p[b + 1]! - y) < 0) { const s = (y - p[a + 1]!) / (p[b + 1]! - p[a + 1]!); pts.push(p[a]! + s * (p[b]! - p[a]!), p[a + 2]! + s * (p[b + 2]! - p[a + 2]!)); } }
      if (pts.length !== 4) continue;
      if (Math.max(pts[0]!, pts[2]!) < bb[0]! || Math.min(pts[0]!, pts[2]!) > bb[1]! || Math.max(pts[1]!, pts[3]!) < bb[2]! || Math.min(pts[1]!, pts[3]!) > bb[3]!) continue;
      // [4], [5]: the face's horizontal outward normal (the side the surface faces), 0,0 when it has none
      const e1x = p[o + 3]! - p[o]!, e1y = p[o + 4]! - p[o + 1]!, e1z = p[o + 5]! - p[o + 2]!, e2x = p[o + 6]! - p[o]!, e2y = p[o + 7]! - p[o + 1]!, e2z = p[o + 8]! - p[o + 2]!;
      const nx = e1y * e2z - e1z * e2y, nz = e1x * e2y - e1y * e2x, nl = Math.hypot(nx, nz);
      pts.push(nl > 1e-9 ? nx / nl : 0, nl > 1e-9 ? nz / nl : 0);
      segs.push(pts);
    }
    return segs;
  }
}

/** Straight lines the wall slices lie on (collinear segments clustered), with a bin index for nearest-segment queries. */
class Lines {
  readonly lines: { ux: number; uz: number; nx: number; nz: number; c: number }[] = [];
  readonly segs: { s: number[]; line: number; h: number }[] = [];
  readonly bins = new Map<string, number[]>();
  constructor(byHeight: number[][][]) {
    byHeight.forEach((list, h) => {
      for (const s of list) {
        const dx = s[2]! - s[0]!, dz = s[3]! - s[1]!, L = Math.hypot(dx, dz); if (L < 0.02) continue;
        let ux = dx / L, uz = dz / L; if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uz < 0)) { ux = -ux; uz = -uz; } // canonical direction
        const nx = -uz, nz = ux, c = nx * s[0]! + nz * s[1]!;
        // antiparallel directions (a near-axis segment can canonicalise either way) flip the normal and so the sign of c
        let line = this.lines.findIndex((l) => { const d = l.ux * ux + l.uz * uz; return Math.abs(d) > Math.cos((2 * Math.PI) / 180) && Math.abs(l.c - (d < 0 ? -c : c)) < 0.015; });
        if (line < 0) { line = this.lines.length; this.lines.push({ ux, uz, nx, nz, c }); }
        const k = this.segs.length; this.segs.push({ s, line, h });
        for (let i = Math.floor(Math.min(s[0]!, s[2]!)); i <= Math.floor(Math.max(s[0]!, s[2]!)); i++) for (let j = Math.floor(Math.min(s[1]!, s[3]!)); j <= Math.floor(Math.max(s[1]!, s[3]!)); j++) { const key = i + "," + j; let a = this.bins.get(key); if (!a) this.bins.set(key, (a = [])); a.push(k); }
      }
    });
  }
  near(x: number, z: number, f: (k: number) => void) { const i0 = Math.floor(x), j0 = Math.floor(z), seen = new Set<number>(); for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const k of this.bins.get(i + "," + j) ?? []) if (!seen.has(k)) { seen.add(k); f(k); } }
}

// ---------------------------------------------------------------- the pipeline

export interface SocketInput {
  id: string;
  tris: TriSoup;
  /** Local Y of the ground-floor walking surface. */
  floorY?: number;
  /** Nominal storey height; each upper floor is snapped to the slab found near floorY + n * storey. */
  storey?: number;
  step?: number;
  /** Sloped faces lying wholly within this of the level's floor are floor relief (rough earth, a noised floor), not stair treads. Default 0.06 m. */
  floorRelief?: number;
  /** Footprint polygon in the local frame (walls included). Omitted = detected from the walls. */
  footprint?: P2[];
  /** Outside door point and the unit vector pointing INTO the building. Omitted = detected. */
  door?: P2; facing?: P2;
  source?: { model: string; sha256: string };
}
export interface SocketProbes { surfaces: Surfaces; lines: ProbeLine[] }
export interface SocketReport { notes: string[]; axisAligned: number; plans: string[]; levels: { level: number; floorY: number; rooms: { id: string; area: number; gross: number }[]; walls: number; stair: number; well: number; doorway: number; entry: number }[]; footprintSource: string; doorSource: string; }

const b36 = (n: number) => Math.max(0, Math.min(35, n)).toString(36);
const r2 = (v: number) => Math.round(v * 100) / 100;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function buildSocketMap(input: SocketInput): { map: SocketMap; report: SocketReport; probes: SocketProbes } {
  const RELIEF = input.floorRelief ?? 0.06, STEP = input.step ?? 0.25, STOREY = input.storey ?? 3.2, FLOOR = input.floorY ?? 0, mesh = new Mesh(input.tris), notes: string[] = [];
  const P = input.tris.pos;
  // grid extent: the footprint (or the geometry above the floor) plus 1 m
  let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
  if (input.footprint) for (const [x, z] of input.footprint) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fz0 = Math.min(fz0, z); fz1 = Math.max(fz1, z); }
  else for (let i = 0; i < P.length; i += 3) if (P[i + 1]! > FLOOR + 0.3) { fx0 = Math.min(fx0, P[i]!); fx1 = Math.max(fx1, P[i]!); fz0 = Math.min(fz0, P[i + 2]!); fz1 = Math.max(fz1, P[i + 2]!); }
  const x0 = Math.floor((fx0 - 1) / STEP) * STEP, z0 = Math.floor((fz0 - 1) / STEP) * STEP, W = Math.ceil((fx1 + 1 - x0) / STEP), H = Math.ceil((fz1 + 1 - z0) / STEP), N = W * H;
  const bb = [x0, x0 + W * STEP, z0, z0 + H * STEP];
  const cx = (i: number) => x0 + (i + 0.5) * STEP, cz = (j: number) => z0 + (j + 0.5) * STEP;
  const cellOf = (x: number, z: number) => { const i = Math.floor((x - x0) / STEP), j = Math.floor((z - z0) / STEP); return i < 0 || j < 0 || i >= W || j >= H ? -1 : j * W + i; };
  const rasterSegs = (segs: number[][], into: Uint8Array, r = STEP * 0.55) => {
    for (const s of segs) {
      const i0 = Math.max(0, Math.floor((Math.min(s[0]!, s[2]!) - r - x0) / STEP)), i1 = Math.min(W - 1, Math.floor((Math.max(s[0]!, s[2]!) + r - x0) / STEP));
      const j0 = Math.max(0, Math.floor((Math.min(s[1]!, s[3]!) - r - z0) / STEP)), j1 = Math.min(H - 1, Math.floor((Math.max(s[1]!, s[3]!) + r - z0) / STEP));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!into[j * W + i] && segDist(cx(i), cz(j), s) < r) into[j * W + i] = 1;
    }
  };

  /** Cells a face really occupies: within 0.4 step of a slice, or within 0.55 step but behind the face (or of a face with no side). */
  const grazeSegs = (segs: number[][], into: Uint8Array, r = STEP * 0.55) => {
    for (const s of segs) {
      const i0 = Math.max(0, Math.floor((Math.min(s[0]!, s[2]!) - r - x0) / STEP)), i1 = Math.min(W - 1, Math.floor((Math.max(s[0]!, s[2]!) + r - x0) / STEP));
      const j0 = Math.max(0, Math.floor((Math.min(s[1]!, s[3]!) - r - z0) / STEP)), j1 = Math.min(H - 1, Math.floor((Math.max(s[1]!, s[3]!) + r - z0) / STEP));
      const nx = s[4] ?? 0, nz = s[5] ?? 0, mx = (s[0]! + s[2]!) / 2, mz = (s[1]! + s[3]!) / 2;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const k = j * W + i; if (into[k]) continue;
        const d = segDist(cx(i), cz(j), s); if (d >= r) continue;
        if (d < STEP * 0.4 || (cx(i) - mx) * nx + (cz(j) - mz) * nz <= 0.02) into[k] = 1;
      }
    }
  };

  // ---- footprint (inside mask)
  const inside = new Uint8Array(N); let footprintSource: string, floodReach: Uint8Array | null = null;
  if (input.footprint) { for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (inPoly(cx(i), cz(j), input.footprint)) inside[j * W + i] = 1; footprintSource = "given polygon"; }
  else {
    // walls sliced from hip to lintel height: doors and windows have wall above them, so this outline is closed
    const closed = new Uint8Array(N);
    for (let y = 0.45; y <= 2.95; y += 0.25) rasterSegs(mesh.slice(FLOOR + y, bb), closed);
    const reach = new Uint8Array(N), q: number[] = [];
    for (let i = 0; i < W; i++) for (const j of [0, H - 1]) q.push(j * W + i);
    for (let j = 0; j < H; j++) for (const i of [0, W - 1]) q.push(j * W + i);
    for (const k of q) reach[k] = 1;
    for (let h = 0; h < q.length; h++) { const k = q[h]!, i = k % W, j = (k - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (!reach[nk] && !closed[nk]) { reach[nk] = 1; q.push(nk); } } }
    floodReach = reach.slice();
    // an opening taller than the slices (a great arch) lets that flood in: a cell with wall on at least three of its four sides
    // (rays along the grid) is inside too; outside a facade only the ray back into the building finds wall
    const lft = new Uint8Array(N), rgt = new Uint8Array(N), up = new Uint8Array(N), dn = new Uint8Array(N);
    for (let j = 0; j < H; j++) { let f = 0; for (let i = 0; i < W; i++) { lft[j * W + i] = f; if (closed[j * W + i]) f = 1; } f = 0; for (let i = W - 1; i >= 0; i--) { rgt[j * W + i] = f; if (closed[j * W + i]) f = 1; } }
    for (let i = 0; i < W; i++) { let f = 0; for (let j = 0; j < H; j++) { up[j * W + i] = f; if (closed[j * W + i]) f = 1; } f = 0; for (let j = H - 1; j >= 0; j--) { dn[j * W + i] = f; if (closed[j * W + i]) f = 1; } }
    for (let k = 0; k < N; k++) if (reach[k] && lft[k]! + rgt[k]! + up[k]! + dn[k]! >= 3) reach[k] = 0;
    // keep the largest unreached component (walls + interior); stray enclosed bits elsewhere drop out
    const comp = new Int32Array(N).fill(-1); let best = -1, bestN = 0;
    for (let k = 0; k < N; k++) if (!reach[k] && comp[k] === -1) {
      const id = k, st = [k]; comp[k] = id; let n = 0;
      while (st.length) { const c = st.pop()!, i = c % W, j = (c - i) / W; n++; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (!reach[nk] && comp[nk] === -1) { comp[nk] = id; st.push(nk); } } }
      if (n > bestN) { bestN = n; best = id; }
    }
    for (let k = 0; k < N; k++) if (comp[k] === best) inside[k] = 1;
    footprintSource = "detected from wall slices";
  }
  let insideCells = 0; for (let k = 0; k < N; k++) insideCells += inside[k]!;
  if (insideCells === 0) throw new Error("empty footprint: no enclosed area found");

  // ---- floor heights: up-facing flat area by Y inside the footprint
  const slabHist = new Map<number, number>();
  for (let t = 0; t < mesh.n; t++) {
    const o = t * 9, e1x = P[o + 3]! - P[o]!, e1y = P[o + 4]! - P[o + 1]!, e1z = P[o + 5]! - P[o + 2]!, e2x = P[o + 6]! - P[o]!, e2y = P[o + 7]! - P[o + 1]!, e2z = P[o + 8]! - P[o + 2]!;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, L = Math.hypot(nx, ny, nz); if (L < 1e-9 || ny / L < 0.95) continue;
    const k = cellOf((P[o]! + P[o + 3]! + P[o + 6]!) / 3, (P[o + 2]! + P[o + 5]! + P[o + 8]!) / 3); if (k < 0 || !inside[k]) continue;
    const y = Math.round(((P[o + 1]! + P[o + 4]! + P[o + 7]!) / 3) / 0.05); slabHist.set(y, (slabHist.get(y) ?? 0) + L / 2);
  }
  const snapFloor = (expect: number) => { let by = NaN, ba = 0; for (const [k, a] of slabHist) { const y = k * 0.05; if (Math.abs(y - expect) <= 0.6 && a > ba) { ba = a; by = y; } } return ba >= 4 ? by : NaN; };

  // ---- triangle normals (for stair treads)
  const treads: number[] = [];
  for (let t = 0; t < mesh.n; t++) {
    if (input.tris.roof[t]) continue;
    const o = t * 9, e1x = P[o + 3]! - P[o]!, e1y = P[o + 4]! - P[o + 1]!, e1z = P[o + 5]! - P[o + 2]!, e2x = P[o + 6]! - P[o]!, e2y = P[o + 7]! - P[o + 1]!, e2z = P[o + 8]! - P[o + 2]!;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x, L = Math.hypot(nx, ny, nz) || 1;
    // stair flights: the old 0.20/0.16 m kit flights slope 51 deg (ny ~0.62), the 0.133/0.18 m flights 35 deg (ny ~0.81);
    // 0.86 (31 deg) keeps both and still drops the 0.9-0.95 plinth bevels
    if (ny / L >= 0.45 && ny / L <= 0.86) treads.push(t);
  }

  // ---- door
  let door = input.door, inward = input.facing, doorSource = door ? "given" : "";
  const levels: SocketLevel[] = [], anchors: SocketAnchor[] = [], plans: string[] = [], repLevels: SocketReport["levels"] = [];
  let axisLen = 0, totalLen = 0;
  let entryPos: P2 | null = null;
  const probeLines: ProbeLine[] = [];
  let cell0: (k: number) => number = () => 0;
  let entryInfo: { wallS: number; gapU: number; gapW: number; m: P2; t: P2; door: P2; doorTop: number } | null = null;

  let gy = FLOOR;
  for (let level = 0; level < 8; level++) {
    if (level > 0) { const y = snapFloor(gy + STOREY); if (!Number.isFinite(y)) break; gy = y; }
    const heights = [0.45, 1.0, 1.7], slices = heights.map((h) => mesh.slice(gy + h, bb));
    // A cell is wall when a slice runs within 0.55 step of its centre, EXCEPT a cell only grazed from in front: every face
    // near it faces the cell and stays >= 0.4 step from its centre (the face lies on the cell's edge, the solid behind it).
    // Without that a 0.95 m gap between a newel post and a wall read as 0.5 m of floor (two cells lost to two grazing faces).
    const wallMask = new Uint8Array(N), hard = new Uint8Array(N);
    for (const s of slices) rasterSegs(s, wallMask);
    for (const s of slices) grazeSegs(s, hard);
    let grazed = 0; for (let k = 0; k < N; k++) if (wallMask[k] && !hard[k]) { wallMask[k] = 0; grazed++; }
    if (grazed) notes.push(`level ${level}: ${grazed} cell(s) only grazed by a wall face from the room side read as floor`);
    const lines = new Lines(slices);
    for (const s of slices[1]!) { const k = cellOf((s[0]! + s[2]!) / 2, (s[1]! + s[3]!) / 2); if (k < 0 || !inside[k]) continue; const L = Math.hypot(s[2]! - s[0]!, s[3]! - s[1]!), a = Math.abs(Math.atan2(s[3]! - s[1]!, s[2]! - s[0]!)) % (Math.PI / 2); totalLen += L; if (a < 0.035 || a > Math.PI / 2 - 0.035) axisLen += L; }

    // 0 outside, 1 free + roofed, 2 wall, 3 open (no ceiling), 4 well (upper floor without slab)
    const cell = new Uint8Array(N), head = new Float32Array(N).fill(-1); let slabCells = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i; if (!inside[k]) continue;
      const x = cx(i), z = cz(j);
      if (level > 0 && !mesh.slabAt(x, z, gy)) { cell[k] = 4; continue; }
      slabCells++;
      if (wallMask[k]) { cell[k] = 2; continue; }
      const r = mesh.roofAbove(x, z, gy); head[k] = Number.isFinite(r) ? r - gy : 99;
      cell[k] = head[k]! < 99 ? 1 : 3;
    }
    let freeCells = 0; for (let k = 0; k < N; k++) if (cell[k] === 1) freeCells++;
    if (level > 0 && (slabCells < 40 || freeCells < 40)) break;

    // rooms: erode free space so doorways cut the plan, label the cores, grow them back. Clearance is measured to the real wall
    // slices (not the raster), so whether a doorway splits does not depend on how the grid happens to fall: openings under
    // 2 x CORE_CLEAR = 1.6 m wide separate rooms, wider arches join them.
    const dist = new Int16Array(N).fill(-1), q: number[] = [];
    for (let k = 0; k < N; k++) if (cell[k] !== 1) { dist[k] = 0; q.push(k); }
    for (let h = 0; h < q.length; h++) { const k = q[h]!, i = k % W, j = (k - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (dist[nk] === -1) { dist[nk] = dist[k]! + 1; q.push(nk); } } }
    const open = new Int16Array(N).fill(-1), oq: number[] = []; // cells to the nearest floor that is not free (outside, unroofed, well); walls are measured exactly below
    for (let k = 0; k < N; k++) if (cell[k] !== 1 && cell[k] !== 2) { open[k] = 0; oq.push(k); }
    for (let h = 0; h < oq.length; h++) { const k = oq[h]!, i = k % W, j = (k - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (open[nk] === -1) { open[nk] = open[k]! + 1; oq.push(nk); } } }
    const CORE_CLEAR = 0.8, core = new Uint8Array(N);
    for (let k = 0; k < N; k++) { if (cell[k] !== 1 || (open[k] !== -1 && (open[k]! - 0.5) * STEP < CORE_CLEAR)) continue; const i = k % W, j = (k - i) / W, x = cx(i), z = cz(j); let c = Infinity; lines.near(x, z, (sk) => { c = Math.min(c, segDist(x, z, lines.segs[sk]!.s)); }); if (c >= CORE_CLEAR) core[k] = 1; }
    const label = new Int16Array(N).fill(-1); let nLabels = 0;
    for (let k = 0; k < N; k++) if (cell[k] === 1 && core[k] && label[k] === -1) { const st = [k]; label[k] = nLabels; while (st.length) { const c = st.pop()!, i = c % W, j = (c - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (cell[nk] === 1 && core[nk] && label[nk] === -1) { label[nk] = nLabels; st.push(nk); } } } nLabels++; }
    // zones: 1 stair run, 2 well, 3 doorway between rooms
    const zone = new Uint8Array(N);
    for (const t of treads) {
      const o = t * 9, cyy = (P[o + 1]! + P[o + 4]! + P[o + 7]!) / 3; if (cyy < gy - 0.1 || cyy > gy + 2.9) continue;
      // floor relief: a bump or a rough-earth face that never leaves the floor by more than RELIEF is floor, not a tread
      if (Math.min(P[o + 1]!, P[o + 4]!, P[o + 7]!) >= gy - RELIEF && Math.max(P[o + 1]!, P[o + 4]!, P[o + 7]!) <= gy + RELIEF) continue;
      const mnx = Math.min(P[o]!, P[o + 3]!, P[o + 6]!), mxx = Math.max(P[o]!, P[o + 3]!, P[o + 6]!), mnz = Math.min(P[o + 2]!, P[o + 5]!, P[o + 8]!), mxz = Math.max(P[o + 2]!, P[o + 5]!, P[o + 8]!);
      if (mxx < bb[0]! || mnx > bb[1]! || mxz < bb[2]! || mnz > bb[3]!) continue;
      const ax = P[o]!, az = P[o + 2]!, bx = P[o + 3]!, bz = P[o + 5]!, qx = P[o + 6]!, qz = P[o + 8]!, d = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz); if (Math.abs(d) < 1e-9) continue;
      for (let j = Math.max(0, Math.floor((mnz - z0) / STEP)); j <= Math.min(H - 1, Math.floor((mxz - z0) / STEP)); j++) for (let i = Math.max(0, Math.floor((mnx - x0) / STEP)); i <= Math.min(W - 1, Math.floor((mxx - x0) / STEP)); i++) {
        const x = cx(i), z = cz(j), u = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / d, w = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / d;
        if (u >= 0 && w >= 0 && u + w <= 1 && inside[j * W + i]) zone[j * W + i] = 1;
      }
    }
    for (let k = 0; k < N; k++) if (cell[k] === 4) zone[k] = 2;
    // doorways: free floor outside every core that two rooms' cores both reach within R cells WALKING through free floor
    // (a wall thickness plus the core clearance), so cells on either side of a solid wall are not doorways
    const R = Math.ceil((CORE_CLEAR + 0.5) / STEP), reached = new Uint8Array(N), gd = new Int16Array(N);
    for (let l = 0; l < nLabels; l++) {
      gd.fill(-1); const bq: number[] = []; for (let k = 0; k < N; k++) if (label[k] === l) { gd[k] = 0; bq.push(k); }
      for (let h = 0; h < bq.length; h++) { const k = bq[h]!; if (gd[k]! >= R) continue; const i = k % W, j = (k - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (cell[nk] === 1 && gd[nk] === -1) { gd[nk] = gd[k]! + 1; bq.push(nk); } } }
      for (let k = 0; k < N; k++) if (gd[k]! > 0 && reached[k]! < 2) reached[k]!++;
    }
    for (let k = 0; k < N; k++) if (cell[k] === 1 && label[k] === -1 && reached[k]! >= 2) zone[k] = 3;
    const grow: number[] = []; for (let k = 0; k < N; k++) if (label[k] !== -1) grow.push(k);
    const growBack = () => { for (let h = 0; h < grow.length; h++) { const k = grow[h]!, i = k % W, j = (k - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (cell[nk] === 1 && label[nk] === -1) { label[nk] = label[k]!; grow.push(nk); } } } };
    growBack();
    // free floor no core reached (a space under 1.6 m wide on its own): its own room when it is big enough
    for (let k = 0; k < N; k++) if (cell[k] === 1 && label[k] === -1 && zone[k] !== 3) { const comp = [k]; label[k] = nLabels; for (let h = 0; h < comp.length; h++) { const c = comp[h]!, i = c % W, j = (c - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (cell[nk] === 1 && label[nk] === -1 && zone[nk] !== 3) { label[nk] = nLabels; comp.push(nk); } } } if (comp.length * STEP * STEP >= 4) nLabels++; else for (const c of comp) label[c] = -2; }
    for (let k = 0; k < N; k++) if (label[k] === -2) label[k] = -1;

    // ---- ground floor: the outside door and its entry lane
    cell0 = (k: number) => cell[k]!;
    const entry = new Uint8Array(N);
    if (level === 0) {
      if (!door || !inward) {
        const found = detectDoor(lines); if (found) { door = found.door; inward = found.inward; doorSource = "detected (widest wall gap" + (found.front ? " on the +Z side)" : ")"); } else notes.push("no outside door found: no entry lane, no door anchors");
      }
      if (door && inward) {
        const L = Math.hypot(inward[0], inward[1]) || 1; let m: P2 = [inward[0] / L, inward[1] / L];
        // the facade: the longest wall line square to the facing within 5 m either side of the door point (porch posts and
        // door frames are short); of the long lines near it, the outermost is the outer face. The facing snaps to its normal.
        const along = new Map<number, number>();
        for (const sg of lines.segs) {
          const l = lines.lines[sg.line]!; if (Math.abs(l.nx * m[0] + l.nz * m[1]) < Math.cos((15 * Math.PI) / 180)) continue;
          const mx = (sg.s[0]! + sg.s[2]!) / 2 - door[0], mz = (sg.s[1]! + sg.s[3]!) / 2 - door[1], s = mx * m[0] + mz * m[1], u = mx * -m[1] + mz * m[0];
          if (s < -0.5 || s > 7 || Math.abs(u) > 5) continue;
          along.set(sg.line, (along.get(sg.line) ?? 0) + Math.hypot(sg.s[2]! - sg.s[0]!, sg.s[3]! - sg.s[1]!));
        }
        const dp: P2 = door, sOfLine = (li: number) => { const l = lines.lines[li]!, dn = l.nx * m[0] + l.nz * m[1]; return (l.c - (l.nx * dp[0] + l.nz * dp[1])) / dn; };
        let wallS = 1.5, best = -1, bestLen = 0;
        for (const [li, len] of along) if (len > bestLen) { bestLen = len; best = li; }
        if (best >= 0) {
          const s0 = sOfLine(best); wallS = s0;
          for (const [li, len] of along) { const s = sOfLine(li); if (len >= 0.6 * bestLen && s < wallS && s > s0 - 1.0) wallS = s; }
          const l = lines.lines[best]!, sg = l.nx * m[0] + l.nz * m[1] > 0 ? 1 : -1; m = [l.nx * sg, l.nz * sg]; inward = m;
        } else notes.push("no facade wall found near the door point; door facing kept as given");
        const t: P2 = [-m[1], m[0]];
        const cAt = (x: number, z: number) => { const k = cellOf(x, z); return k < 0 ? -1 : cell[k]!; };
        // the doorway: rays across the facade with no wall in the wall's thickness band, the run nearest the door point
        const open: number[] = [];
        for (let u = -4; u <= 4.001; u += 0.25) { let wall = false; for (let d = wallS - 0.1; d <= wallS + 0.6 && !wall; d += 0.05) if (cAt(door[0] + m[0] * d + t[0] * u, door[1] + m[1] * d + t[1] * u) === 2) wall = true; if (!wall) open.push(+u.toFixed(2)); }
        let gapU = 0, gapW = 1.2;
        const runs: [number, number][] = []; for (const u of open) { const r = runs[runs.length - 1]; if (r && Math.abs(u - r[1] - 0.25) < 1e-6) r[1] = u; else runs.push([u, u]); }
        const doors = runs.filter(([lo, hi]) => hi - lo + 0.25 >= 0.75);
        if (doors.length) { const [lo, hi] = doors.reduce((a, c) => (Math.min(Math.abs(c[0]), Math.abs(c[1]), Math.abs((c[0] + c[1]) / 2)) < Math.min(Math.abs(a[0]), Math.abs(a[1]), Math.abs((a[0] + a[1]) / 2)) ? c : a)); gapU = (lo + hi) / 2; gapW = hi - lo + 0.25; }
        else notes.push("no doorway gap found in the facade near the door point; lane centred on it");
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
          const k = j * W + i; if (!inside[k] || cell[k] === 2) continue;
          const dx = cx(i) - door[0], dz = cz(j) - door[1], s = dx * m[0] + dz * m[1], u = dx * t[0] + dz * t[1] - gapU;
          if (s > wallS - 0.8 && s < wallS + 3.2 && Math.abs(u) < gapW / 2 + 0.55) entry[k] = 1;
        }
        // door top: the lintel underside seen from just inside the threshold
        const thr: P2 = [door[0] + m[0] * (wallS + 0.1) + t[0] * gapU, door[1] + m[1] * (wallS + 0.1) + t[1] * gapU];
        let doorTop = Infinity; mesh.column(thr[0], thr[1], (yy, ny) => { if (ny < 0 && yy > gy + 1.6 && yy < doorTop) doorTop = yy; });
        entryInfo = { wallS, gapU, gapW, m, t, door, doorTop: Number.isFinite(doorTop) ? doorTop - gy : 2.4 };
        entryPos = [door[0] + m[0] * wallS + t[0] * gapU, door[1] + m[1] * wallS + t[1] * gapU]; // the doorway on the outer face
        // step gate: from 1.2 m inside on the floor, out through the doorway centre, 4.5 m beyond the facade
        probeLines.push({ id: "entry", kind: "entry", level: 0, start: [door[0] + m[0] * (wallS + 1.2) + t[0] * gapU, door[1] + m[1] * (wallS + 1.2) + t[1] * gapU], dir: [-m[0], -m[1]], length: 5.7, startY: gy, outward: true, face: 4.5 });
      }
    }

    // ---- characters
    const ch = new Array<string>(N).fill(SOCKET_CELLS.outside);
    for (let k = 0; k < N; k++) {
      if (!inside[k]) continue;
      const c = cell[k]!;
      ch[k] = c === 4 ? SOCKET_CELLS.well : zone[k] === 1 ? SOCKET_CELLS.stair : c === 2 ? SOCKET_CELLS.wall : zone[k] === 3 ? SOCKET_CELLS.doorway : entry[k] ? SOCKET_CELLS.entry : c === 3 ? SOCKET_CELLS.open : c === 0 ? SOCKET_CELLS.outside : SOCKET_CELLS.free;
    }

    // ---- upper floors: a stair strip no body can stand on (one cell of top tread showing beside a balustrade, between the well
    // and a wall) is part of the well, not a stair a lane must reach: no cell of it has a walkable 3 x 3 around it
    if (level > 0) {
      const walk = (k: number) => { const c = ch[k]; return c === SOCKET_CELLS.free || c === SOCKET_CELLS.stair || c === SOCKET_CELLS.open || c === SOCKET_CELLS.doorway || c === SOCKET_CELLS.entry; };
      const seen = new Uint8Array(N); let sliver = 0;
      for (let k0 = 0; k0 < N; k0++) {
        if (ch[k0] !== SOCKET_CELLS.stair || seen[k0]) continue;
        const comp = [k0]; seen[k0] = 1;
        for (let h = 0; h < comp.length; h++) { const c = comp[h]!, i = c % W, j = (c - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (!seen[nk] && ch[nk] === SOCKET_CELLS.stair) { seen[nk] = 1; comp.push(nk); } } }
        const standable = comp.some((c) => { const i = c % W, j = (c - i) / W; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H || !walk(nj * W + ni)) return false; } return true; });
        if (standable) continue;
        for (const c of comp) ch[c] = SOCKET_CELLS.well;
        sliver += comp.length;
      }
      if (sliver) notes.push(`level ${level}: ${sliver} stair cell(s) in strips too narrow to stand on (beside a balustrade) read as stair well`);
    }

    // ---- step gate: each stair flight (a connected run of S cells), probed along its uphill direction
    { const seen = new Uint8Array(N); let fn = 0;
      for (let k0 = 0; k0 < N; k0++) { if (ch[k0] !== SOCKET_CELLS.stair || seen[k0]) continue;
        const comp = [k0], inComp = new Set<number>([k0]); seen[k0] = 1;
        for (let h = 0; h < comp.length; h++) { const c = comp[h]!, i = c % W, j = (c - i) / W; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (!seen[nk] && ch[nk] === SOCKET_CELLS.stair) { seen[nk] = 1; comp.push(nk); inComp.add(nk); } } }
        if (comp.length * STEP * STEP < 0.5) continue;
        let ux = 0, uz = 0;
        for (const tr of treads) { const o = tr * 9, cyy = (P[o + 1]! + P[o + 4]! + P[o + 7]!) / 3; if (cyy < gy - 0.1 || cyy > gy + 2.9) continue; const k = cellOf((P[o]! + P[o + 3]! + P[o + 6]!) / 3, (P[o + 2]! + P[o + 5]! + P[o + 8]!) / 3); if (k < 0 || !inComp.has(k)) continue;
          const e1x = P[o + 3]! - P[o]!, e1y = P[o + 4]! - P[o + 1]!, e1z = P[o + 5]! - P[o + 2]!, e2x = P[o + 6]! - P[o]!, e2y = P[o + 7]! - P[o + 1]!, e2z = P[o + 8]! - P[o + 2]!;
          ux -= e1y * e2z - e1z * e2y; uz -= e1x * e2y - e1y * e2x; } // area-weighted -normal.xz = uphill
        const ul = Math.hypot(ux, uz); if (ul < 1e-9) continue; ux /= ul; uz /= ul;
        let sx = 0, sz = 0, lo = Infinity, hi = -Infinity; for (const c of comp) { const i = c % W, j = (c - i) / W; sx += cx(i); sz += cz(j); }
        sx /= comp.length; sz /= comp.length; for (const c of comp) { const i = c % W, j = (c - i) / W, d = (cx(i) - sx) * ux + (cz(j) - sz) * uz; lo = Math.min(lo, d); hi = Math.max(hi, d); }
        fn++; probeLines.push({ id: `${level === 0 ? "G" : "U" + level}-stair${fn}`, kind: "flight", level, start: [sx + ux * (lo - 1.2), sz + uz * (lo - 1.2)], dir: [ux, uz], length: hi - lo + 2.4, startY: gy });
      }
    }

    // ---- rooms (same basis as interior-grid: gross >= 4 m², stair and entry cells count toward gross)
    const prefix = level === 0 ? "G-" : `U${level}-`, rooms: (SocketRoom & { label: number; gross: number })[] = [];
    for (let r = 0; r < nLabels; r++) {
      let n = 0, nFree = 0, sx = 0, sz = 0, mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9, minHead = 99, maxHead = 0;
      for (let k = 0; k < N; k++) if (label[k] === r) {
        const i = k % W, j = (k - i) / W, x = cx(i), z = cz(j); n++;
        if (ch[k] !== SOCKET_CELLS.free) continue;
        nFree++; sx += x; sz += z; mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mnz = Math.min(mnz, z); mxz = Math.max(mxz, z); minHead = Math.min(minHead, head[k]!); maxHead = Math.max(maxHead, head[k]!);
      }
      if (n * STEP * STEP < 4 || nFree === 0 || rooms.length >= 36) continue;
      rooms.push({ id: prefix + (rooms.length + 1), index: rooms.length, area: r2(nFree * STEP * STEP), centre: [r2(sx / nFree), r2(sz / nFree)], bbox: [mnx, mxx, mnz, mxz].map(r2) as [number, number, number, number], minHead: r2(minHead), maxHead: r2(maxHead), label: r, gross: r2(n * STEP * STEP) });
    }
    if (level > 0 && !rooms.length) break; // an attic or void: nothing to furnish, and nothing above it either
    const roomOf = new Int16Array(N).fill(-1); const byLabel = new Map(rooms.map((r) => [r.label, r.index]));
    for (let k = 0; k < N; k++) { const idx = byLabel.get(label[k]!); if (idx !== undefined && ch[k] !== SOCKET_CELLS.doorway && ch[k] !== SOCKET_CELLS.wall) roomOf[k] = idx; }
    { // floor between the footprint edge and the outer wall face (eaves strip, plinth) belongs to no room and touches the outside: it is outside
      const q2: number[] = [], out = new Uint8Array(N);
      const loose = (k: number) => (ch[k] === SOCKET_CELLS.free || ch[k] === SOCKET_CELLS.open) && roomOf[k] === -1;
      // A well is a hole in the floor INSIDE the shell that a body could fall through or a stair comes up through: slab-less cells a
      // room opens onto directly, through no wall (a stair well, a gallery over a hall), plus the slab-less wall cells along its edge
      // (an outer wall standing over the well). Every other slab-less cell the outside reaches is outside: the void between an upper
      // storey's outer wall and the footprint / eave line (~0.35 m on the Tidewell kit; the eave rasterises as wall), a wing roof
      // below, a chimney-stack bump. Stair cells do not make a well real: roof slopes beyond the wall read as treads.
      const isWell = (k: number) => ch[k] === SOCKET_CELLS.well, real = new Uint8Array(N), rq: number[] = [];
      const nbrs = (k: number, f: (nk: number) => void) => { const i = k % W, j = (k - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni >= 0 && nj >= 0 && ni < W && nj < H) f(nj * W + ni); } };
      for (let k = 0; k < N; k++) if (isWell(k) && !wallMask[k]) { let opens = false; nbrs(k, (nk) => { if (roomOf[nk]! >= 0 || ch[nk] === SOCKET_CELLS.doorway || ch[nk] === SOCKET_CELLS.entry) opens = true; }); if (opens) { real[k] = 1; rq.push(k); } }
      for (let h = 0; h < rq.length; h++) nbrs(rq[h]!, (nk) => { if (!real[nk] && isWell(nk) && !wallMask[nk]) { real[nk] = 1; rq.push(nk); } });
      for (let k = 0; k < N; k++) if (isWell(k) && wallMask[k] && !real[k]) nbrs(k, (nk) => { if (real[nk] === 1) real[k] = 2; });
      const reach = (k: number) => loose(k) || (isWell(k) && !real[k]);
      for (let k = 0; k < N; k++) if (!inside[k]) { out[k] = 1; q2.push(k); }
      for (let h = 0; h < q2.length; h++) { const k = q2[h]!, i = k % W, j = (k - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (!out[nk] && reach(nk)) { out[nk] = 1; ch[nk] = SOCKET_CELLS.outside; q2.push(nk); } } }
      // what is left loose and touches no room is a hollow inside the masonry (a pier, a chimney): solid as far as dressing goes
      for (let k = 0; k < N; k++) if (loose(k) && !out[k]) { const comp = [k]; out[k] = 2; let touches = false; for (let h = 0; h < comp.length; h++) { const c = comp[h]!, i = c % W, j = (c - i) / W; for (const [di, dj] of DIRS) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue; const nk = nj * W + ni; if (roomOf[nk]! >= 0 || ch[nk] === SOCKET_CELLS.doorway || ch[nk] === SOCKET_CELLS.entry || ch[nk] === SOCKET_CELLS.stair) touches = true; if (!out[nk] && loose(nk)) { out[nk] = 2; comp.push(nk); } } } if (!touches) for (const c of comp) ch[c] = SOCKET_CELLS.wall; }
    }

    // ---- walls: room/wall boundary faces assigned to the slice line they lie on, merged into runs
    const walls: SocketWall[] = [], usedIds = new Set<string>(); let dropped = 0;
    const synthetic = new Map<string, number>();
    for (const room of rooms) {
      const groups = new Map<string, { line: number; sign: number; ts: number[] }>();
      for (let k = 0; k < N; k++) {
        if (roomOf[k] !== room.index) continue;
        const i = k % W, j = (k - i) / W;
        for (const [di, dj] of DIRS) {
          const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H || ch[nj * W + ni] !== SOCKET_CELLS.wall) continue; // not a stair side
          // the wall FACE behind this boundary: a slice line square to it that runs past this point no more than one cell either side of
          // the free/wall boundary. The face standing at the most slice heights wins (a wall, not a window frame proud of it), then the
          // first one met walking from the room into the wall. No slice there: the boundary itself.
          const mx = cx(i) + (di * STEP) / 2, mz = cz(j) + (dj * STEP) / 2, cand = new Map<number, { off: number; hs: Set<number> }>();
          lines.near(mx, mz, (sk) => { const sg = lines.segs[sk]!, l = lines.lines[sg.line]!, nd = l.nx * di + l.nz * dj; if (Math.abs(nd) < 0.5) return;
            const perp = l.c - (l.nx * mx + l.nz * mz), off = perp / nd; if (off < -STEP || off > STEP * 1.1) return; // a wall cell is one whose centre is within 0.55 step of a slice, so the face can sit up to 1.05 step behind
            const sd = segDist(mx, mz, sg.s); if (sd * sd - perp * perp > 0.15 * 0.15) return; // the segment must run past this point
            let c = cand.get(sg.line); if (!c) cand.set(sg.line, (c = { off, hs: new Set() })); c.hs.add(sg.h); });
          let bestLine = -1, bestH = 0, bestOff = Infinity;
          for (const [li, c] of cand) if (c.hs.size > bestH || (c.hs.size === bestH && c.off < bestOff)) { bestLine = li; bestH = c.hs.size; bestOff = c.off; }
          if (bestLine < 0) { const key = `${di},${dj},${(di ? mx : mz).toFixed(3)}`; let li = synthetic.get(key); if (li === undefined) { const ux = Math.abs(dj), uz = Math.abs(di); li = lines.lines.length; lines.lines.push({ ux, uz, nx: -uz, nz: ux, c: -uz * mx + ux * mz }); synthetic.set(key, li); } bestLine = li; }
          const l = lines.lines[bestLine]!, sign = l.nx * -di + l.nz * -dj > 0 ? 1 : -1, key = bestLine + ":" + sign;
          let g = groups.get(key); if (!g) groups.set(key, (g = { line: bestLine, sign, ts: [] }));
          g.ts.push(l.ux * mx + l.uz * mz);
        }
      }
      const runs: { line: number; sign: number; t0: number; t1: number }[] = [];
      for (const g of groups.values()) {
        g.ts.sort((a, b) => a - b); let s = g.ts[0]!, e = s;
        for (const t of g.ts.slice(1)) { if (t - e > 2.5) { runs.push({ line: g.line, sign: g.sign, t0: s - STEP / 2, t1: e + STEP / 2 }); s = t; } e = t; }
        runs.push({ line: g.line, sign: g.sign, t0: s - STEP / 2, t1: e + STEP / 2 });
      }
      for (const run of runs) {
        if (run.t1 - run.t0 < 0.5) continue;
        const l = lines.lines[run.line]!, nIn: P2 = [l.nx * run.sign, l.nz * run.sign], at = (t: number): P2 => [l.nx * l.c + l.ux * t, l.nz * l.c + l.uz * t];
        const len = run.t1 - run.t0, solid: boolean[] = [];
        for (let s = 0; s <= len + 1e-6; s += 0.05) {
          const [px, pz] = at(run.t0 + s); let ok = true;
          for (let h = 0; h < 3 && ok; h++) { let hit = false; lines.near(px, pz, (sk) => { const sg = lines.segs[sk]!; if (hit || sg.h !== h) return; const sl = lines.lines[sg.line]!; if (Math.abs(sl.ux * l.ux + sl.uz * l.uz) < 0.995) return; if (segDist(px, pz, sg.s) < 0.06) hit = true; }); ok = hit; }
          if (ok) { // nothing standing proud of the face within 0.3 m (window frames on a blind wall, pilasters, a hearth)
            const ax = px + nIn[0] * 0.025, az = pz + nIn[1] * 0.025, bx = px + nIn[0] * 0.3, bz = pz + nIn[1] * 0.3;
            lines.near(px, pz, (sk) => { if (!ok) return; const q = lines.segs[sk]!.s; if (segCross(ax, az, bx, bz, q[0]!, q[1]!, q[2]!, q[3]!)) ok = false; });
          }
          if (ok) { const k = cellOf(px + nIn[0] * 0.3, pz + nIn[1] * 0.3), c = k < 0 ? " " : ch[k]!; if (c !== SOCKET_CELLS.free && c !== SOCKET_CELLS.wall && c !== SOCKET_CELLS.open) ok = false; }
          solid.push(ok);
        }
        const spans: [number, number][] = []; let sStart = -1;
        for (let i = 0; i <= solid.length; i++) { if (i < solid.length && solid[i]) { if (sStart < 0) sStart = i; } else if (sStart >= 0) { const a = sStart * 0.05, b = Math.min(len, (i - 1) * 0.05); if (b - a >= 0.3) spans.push([r2(a), r2(b)]); sStart = -1; } }
        let height = Infinity;
        const probe = spans.length ? spans : [[0, len] as [number, number]];
        for (const [a, b] of probe) for (let s = b - a > 0.3 ? a + 0.15 : (a + b) / 2; s <= Math.max(b - 0.15, (a + b) / 2) + 1e-6; s += 0.25) { /* span ends meet whatever interrupts them */ const [px, pz] = at(run.t0 + s), r = mesh.roofAbove(px + nIn[0] * 0.2, pz + nIn[1] * 0.2, gy); if (Number.isFinite(r)) height = Math.min(height, r - gy); }
        if (!spans.length) { dropped++; continue; } // nothing can stand against it: a frame, post or stair stub
        if (!Number.isFinite(height)) height = room.maxHead;
        const ang = (Math.atan2(nIn[0], nIn[1]) * 180) / Math.PI; // 0 = normal +Z = the wall stands on the room's -Z (north) side
        const dir = ["N", "NW", "W", "SW", "S", "SE", "E", "NE"][(Math.round(ang / 45) + 8) % 8]!; // normal +X -> wall on the west side
        let id = `${room.id}.${dir}`, n = 2; while (usedIds.has(id)) id = `${room.id}.${dir}${n++}`; usedIds.add(id);
        // `a` is always the LEFT end as seen from inside the room, facing the wall: t runs left to right for every wall
        let wa = at(run.t0).map(r2) as P2, wb = at(run.t1).map(r2) as P2, wspans = spans;
        if ((wb[0] - wa[0]) * nIn[1] - (wb[1] - wa[1]) * nIn[0] < 0) { [wa, wb] = [wb, wa]; wspans = spans.map(([s0, s1]) => [r2(Math.max(0, len - s1)), r2(len - s0)] as [number, number]).reverse(); }
        walls.push({ id, room: room.id, a: wa, b: wb, normal: nIn.map((v) => Math.round(v * 1e4) / 1e4) as P2, spans: wspans, height: r2(Math.max(0.1, height)) });
      }
    }

    // a short face standing just proud of a longer wall of the same room (a blind window, a hearth front) is relief on that wall, not a wall:
    // the long wall's spans already stop at it
    for (let i = walls.length - 1; i >= 0; i--) {
      const w = walls[i]!, len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), ux = (w.b[0] - w.a[0]) / len, uz = (w.b[1] - w.a[1]) / len;
      const host = walls.find((o) => { if (o === w || o.room !== w.room || o.normal[0] * w.normal[0] + o.normal[1] * w.normal[1] < 0.999) return false; const ol = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]); if (ol <= len) return false;
        const off = (w.a[0] - o.a[0]) * o.normal[0] + (w.a[1] - o.a[1]) * o.normal[1]; if (off < 0.005 || off > 0.3) return false;
        const oux = (o.b[0] - o.a[0]) / ol, ouz = (o.b[1] - o.a[1]) / ol, t0 = (w.a[0] - o.a[0]) * oux + (w.a[1] - o.a[1]) * ouz, t1 = (w.b[0] - o.a[0]) * oux + (w.b[1] - o.a[1]) * ouz; void ux; void uz;
        return Math.max(t0, t1) > 0 && Math.min(t0, t1) < ol; });
      if (host) { walls.splice(i, 1); dropped++; }
    }

    // ---- rasters
    const rows = (f: (k: number) => string) => Array.from({ length: H }, (_, j) => Array.from({ length: W }, (_, i) => f(j * W + i)).join(""));
    const cellsRows = rows((k) => ch[k]!);
    const headRows = rows((k) => { const c = ch[k]!; if (c === SOCKET_CELLS.outside || c === SOCKET_CELLS.well || c === SOCKET_CELLS.wall) return "."; return c === SOCKET_CELLS.open || head[k]! >= 99 ? "z" : head[k]! < 0 ? "." : b36(Math.floor(head[k]! / HEAD_STEP + 1e-6)); });
    const roomRows = rows((k) => (roomOf[k]! >= 0 ? b36(roomOf[k]!) : "."));
    levels.push({ level, floorY: r2(gy), origin: [r2(x0), r2(z0)], step: STEP, columns: W, rows: H, cells: cellsRows, head: headRows, room: roomRows, rooms: rooms.map(({ label: _l, gross: _g, ...r }) => r), walls, paths: [] });
    const count = (c: string) => ch.filter((v) => v === c).length;
    repLevels.push({ level, floorY: r2(gy), rooms: rooms.map((r) => ({ id: r.id, area: r.area, gross: r.gross })), walls: walls.length, stair: count(SOCKET_CELLS.stair), well: count(SOCKET_CELLS.well), doorway: count(SOCKET_CELLS.doorway), entry: count(SOCKET_CELLS.entry) });
    // plan: cells, with free floor shown as its room digit
    plans.push(`level ${level}  floor y ${gy.toFixed(2)}  origin (${x0.toFixed(2)}, ${z0.toFixed(2)})  ${W}x${H} @ ${STEP} m  rows +Z down, columns +X right\n` + cellsRows.map((row, j) => row.split("").map((c, i) => (c === "." && roomRows[j]![i] !== "." ? roomRows[j]![i] : c)).join("").replace(/\s+$/, "")).join("\n"));

    // ---- anchors outside the door (ground floor)
    if (level === 0 && entryInfo) {
      const { wallS, gapU, gapW, m, t, door: d, doorTop } = entryInfo;
      // outer face of the door wall: nearest slice line parallel to the door wall, at the gap jambs
      const outerS = (u: number) => { const px = d[0] + m[0] * wallS + t[0] * u, pz = d[1] + m[1] * wallS + t[1] * u; let best = wallS; let bd = 0.5; lines.near(px, pz, (sk) => { const sg = lines.segs[sk]!, l = lines.lines[sg.line]!; if (Math.abs(l.nx * m[0] + l.nz * m[1]) < 0.95) return; const dd = segDist(px, pz, sg.s); if (dd < bd) { bd = dd; best = (l.c - (l.nx * d[0] + l.nz * d[1])) / (l.nx * m[0] + l.nz * m[1]); } }); return best; };
      const yaw = r2((Math.atan2(-m[0], -m[1]) * 180) / Math.PI), place = (s: number, u: number, y: number): [number, number, number] => [r2(d[0] + m[0] * s + t[0] * (gapU + u)), r2(y), r2(d[1] + m[1] * s + t[1] * (gapU + u))];
      // clear of the door frame: the farthest end of anything standing proud of the outer face near the doorway, + 0.25 m
      const face = outerS(0); let frame = gapW / 2;
      for (const sg of lines.segs) { if (sg.h !== 2) continue; for (const e of [0, 2]) { const ex = sg.s[e]! - d[0], ez = sg.s[e + 1]! - d[1], s = ex * m[0] + ez * m[1], u = ex * t[0] + ez * t[1] - gapU; if (s < face - 0.4 || s > face - 0.01 || Math.abs(u) > 1.6) continue; frame = Math.max(frame, Math.abs(u)); } }
      const side = Math.max(gapW / 2 + 0.35, frame + 0.25);
      // left/right as seen by someone outside looking at the door (they face m); the right of facing (fx,fz), +Y up, is (-fz, fx)
      const f: P2 = m, right: P2 = [-f[1], f[0]], rightSign = right[0] * t[0] + right[1] * t[1] > 0 ? 1 : -1;
      for (const [name, sgn] of [["left", -rightSign], ["right", rightSign]] as const) {
        const u = sgn * side, s = outerS(u) - 0.05;
        anchors.push({ id: `door-${name}`, kind: "door-side", level: 0, position: place(s, u, gy + Math.min(1.9, doorTop + 0.1)), yaw, mount: "wall", outdoor: true });
      }
      anchors.push({ id: "sign", kind: "sign-bracket", level: 0, position: place(outerS(0) - 0.05, 0, gy + Math.min(doorTop + 0.45, STOREY - 0.3)), yaw, mount: "wall", outdoor: true });
    }
  }

  if (!levels.length) throw new Error("no level measured");
  const axisAligned = totalLen ? axisLen / totalLen : 1;
  if (axisAligned < 0.9) notes.push(`only ${(axisAligned * 100).toFixed(0)}% of the wall slice length is axis-aligned; walls follow the slice lines, so diagonal walls are still faced correctly`);
  const raw: SocketMap = {
    id: input.id,
    ...(input.source ? { source: input.source } : {}),
    ...(door && inward ? { entry: { position: (entryPos ?? door).map(r2) as P2, facing: ((): P2 => { const L = Math.hypot(inward[0], inward[1]) || 1; return [Math.round((inward[0] / L) * 1e4) / 1e4, Math.round((inward[1] / L) * 1e4) / 1e4]; })() } } : {}),
    levels, anchors,
  };
  const map = socketMapSchema.parse(raw);
  const surfaces: Surfaces = (x, z) => { const ys: number[] = []; mesh.column(x, z, (y, ny) => { if (ny > 0) ys.push(y); }); return ys; };
  return { map, report: { notes, axisAligned, plans, levels: repLevels, footprintSource, doorSource }, probes: { surfaces, lines: probeLines } };

  /** Doors are gaps in the OUTER wall faces open at both hip and waist height (a window keeps its sill), 0.75-8 m wide,
   *  with solid wall on both sides and the inside behind them. The widest on the +Z side wins, else the widest anywhere. */
  function detectDoor(lines: Lines): { door: P2; inward: P2; front: boolean } | null {
    const isIn = (x: number, z: number) => { const k = cellOf(x, z); return k >= 0 && inside[k] === 1; };
    let best: { door: P2; inward: P2; front: boolean } | null = null, bestScore = -1;
    lines.lines.forEach((l, li) => {
      const mine = lines.segs.filter((sg) => sg.line === li);
      const tOf = (x: number, z: number) => l.ux * x + l.uz * z, cov: [number, number][][] = [[], [], []];
      let lo = Infinity, hi = -Infinity, longest = mine[0], longestLen = 0;
      for (const sg of mine) {
        const a = tOf(sg.s[0]!, sg.s[1]!), b = tOf(sg.s[2]!, sg.s[3]!), len = Math.abs(b - a);
        cov[sg.h]!.push([Math.min(a, b), Math.max(a, b)]); lo = Math.min(lo, a, b); hi = Math.max(hi, a, b);
        if (len > longestLen) { longestLen = len; longest = sg; }
      }
      if (!longest || hi - lo < 2) return;
      // which side is outside
      const mx = (longest.s[0]! + longest.s[2]!) / 2, mz = (longest.s[1]! + longest.s[3]!) / 2;
      // the outside side is the one the open-air flood reached and/or that lies outside the footprint (porches and buttresses can
      // put the ground in front of a facade inside the footprint; a great arch can let the flood into the nave)
      const outness = (x: number, z: number) => { const k = cellOf(x, z); if (k < 0) return 2; return (inside[k] ? 0 : 1) + (floodReach ? floodReach[k]! : inside[k] ? 0 : 1); };
      const po = outness(mx + l.nx * 0.4, mz + l.nz * 0.4), mo = outness(mx - l.nx * 0.4, mz - l.nz * 0.4);
      const plus = po < mo && isIn(mx + l.nx * 0.4, mz + l.nz * 0.4), minus = mo < po && isIn(mx - l.nx * 0.4, mz - l.nz * 0.4);
      if (plus === minus) return; // plus = the + side is the inside
      const out: P2 = plus ? [-l.nx, -l.nz] : [l.nx, l.nz];
      // open = covered by neither the hip nor the waist slice
      const solid = [...cov[0]!, ...cov[1]!].sort((a, b) => a[0] - b[0]), merged: [number, number][] = [];
      for (const iv of solid) { const m = merged[merged.length - 1]; if (m && iv[0] <= m[1] + 0.02) m[1] = Math.max(m[1], iv[1]); else merged.push([iv[0], iv[1]]); }
      for (let i = 0; i + 1 < merged.length; i++) {
        const g0 = merged[i]![1], g1 = merged[i + 1]![0], w = g1 - g0; if (w < 0.75 || w > 8) continue;
        const tc = (g0 + g1) / 2, px = l.nx * l.c + l.ux * tc, pz = l.nz * l.c + l.uz * tc;
        let leads = false; // walking in through the gap reaches floor inside (walls can be thick, plinths thicker)
        for (let d = 0.3; d <= 1.6 && !leads; d += 0.1) { const k = cellOf(px - out[0] * d, pz - out[1] * d); if (k >= 0 && inside[k] && cell0(k) !== 2) leads = true; }
        if (!leads) continue;
        const front = out[1] > 0.7, score = w + (front ? 100 : 0);
        if (score > bestScore) { bestScore = score; best = { door: [px + out[0] * 0.75, pz + out[1] * 0.75], inward: [-out[0], -out[1]], front }; }
      }
    });
    return best;
  }
}

// ---------------------------------------------------------------- CLI

// ---------------------------------------------------------------- fixture markers

/** Marker kind -> the anchor mount it becomes. A marker's position is where the fixture prefab's ORIGIN goes. */
export const MARKER_MOUNTS: Record<string, { mount: "floor" | "wall" | "ceiling"; outdoor?: boolean }> = {
  hearth: { mount: "floor" },
  forge: { mount: "floor" },
  sconce: { mount: "wall" },
  lantern: { mount: "wall" },
  "candle-niche": { mount: "wall" },
  chandelier: { mount: "ceiling" },
  "chimney-top": { mount: "floor", outdoor: true },
};
/**
 * The way on and off a stair (the kit exporter's `stair-foot`, `stair-head`, `stair-approach`): each rectangle
 * (size w x d about position, turned by yaw) becomes 'A' cells (walkable, no solid prop, must be reachable by a
 * player-wide lane) and a floor anchor of that kind that nothing may be placed on. Same keep-out code as the hearth.
 */
export const STAIR_MARKERS = new Set(["stair-foot", "stair-head", "stair-approach"]);
export interface FixtureMarker { id: string; kind: string; level?: number; position: [number, number, number]; yaw?: number; size?: [number, number, number] }

/**
 * Fold a model's fixture markers into its socket map: anchors for light/fire points, 'H' cells for each
 * hearth-clearance rectangle (only free '.' / unroofed 'o' cells change; walls and stairs stay what they are).
 */
export function applyMarkers(map: SocketMap, markers: FixtureMarker[]): string[] {
  const lines: string[] = [];
  const ids = new Set(map.anchors.map((a) => a.id));
  for (const m of markers) {
    const level = m.level ?? 0, yaw = m.yaw ?? 0;
    if (!Array.isArray(m.position) || m.position.length !== 3 || m.position.some((v) => !Number.isFinite(v))) { lines.push(`marker ${m.id}: no usable position, skipped`); continue; }
    const stairWay = STAIR_MARKERS.has(m.kind);
    if (m.kind === "hearth-clearance" || stairWay) {
      const lv = map.levels.find((l) => l.level === level);
      if (!lv) { lines.push(`marker ${m.id}: level ${level} is not in the map, clearance skipped`); continue; }
      const mark = stairWay ? SOCKET_CELLS.stairClear : SOCKET_CELLS.hearth;
      const [w, , d] = m.size ?? [0, 0, 0], a = (yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      let marked = 0, kept = 0;
      lv.cells = lv.cells.map((row, j) => [...row].map((ch, i) => {
        const x = lv.origin[0] + (i + 0.5) * lv.step - m.position[0], z = lv.origin[1] + (j + 0.5) * lv.step - m.position[2];
        const lx = x * c - z * s, lz = x * s + z * c; // map -> marker frame (inverse of the yaw turn)
        if (Math.abs(lx) > w / 2 + 1e-6 || Math.abs(lz) > d / 2 + 1e-6) return ch;
        if (ch === SOCKET_CELLS.free || ch === SOCKET_CELLS.open || (stairWay && ch === SOCKET_CELLS.hearth)) { marked++; return mark; }
        if (ch !== mark) kept++;
        return ch;
      }).join(""));
      lines.push(`marker ${m.id}: ${stairWay ? m.kind : "hearth clearance"} ${w} x ${d} m -> ${marked} '${mark}' cells on level ${level}${kept ? ` (${kept} wall/stair/door cells inside it left as they are)` : ""}`);
      if (!stairWay) continue;
      // The stair marks are also anchors (mount floor), so a designer sees them by id; the resolver refuses anything placed on one.
      let sid = m.id;
      for (let k = 2; ids.has(sid); k++) sid = `${m.id}-${k}`;
      ids.add(sid);
      map.anchors.push({ id: sid, kind: m.kind, level, position: [m.position[0], m.position[1], m.position[2]], yaw, mount: "floor", outdoor: false, ...(m.size ? { size: [m.size[0], m.size[1], m.size[2]] as [number, number, number] } : {}) });
      continue;
    }
    const spec = MARKER_MOUNTS[m.kind];
    if (!spec) { lines.push(`marker ${m.id}: unknown kind "${m.kind}", skipped`); continue; }
    let id = m.id;
    for (let k = 2; ids.has(id); k++) id = `${m.id}-${k}`;
    ids.add(id);
    map.anchors.push({ id, kind: m.kind, level, position: [m.position[0], m.position[1], m.position[2]], yaw, mount: spec.mount, outdoor: spec.outdoor ?? false, ...(m.size ? { size: [m.size[0], m.size[1], m.size[2]] as [number, number, number] } : {}) });
    lines.push(`marker ${m.id}: ${m.kind} -> ${spec.outdoor ? "outdoor " : ""}${spec.mount} anchor "${id}"`);
  }
  return lines;
}

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const pair = (s: string): P2 => { const v = s.split(",").map(Number); if (v.length !== 2 || v.some((n) => !Number.isFinite(n))) throw new Error(`expected x,z: "${s}"`); return [v[0]!, v[1]!]; };

export async function run(argv: string[]): Promise<void> {
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const project = opt("--project"); if (!project) throw new Error("dress sockets: --project <name> is required");
  const projDir = path.join(PLAYGROUND, "projects", project); if (!fs.existsSync(projDir)) throw new Error(`no project folder ${projDir}`);
  const resolve = (p: string) => (path.isAbsolute(p) ? p : fs.existsSync(path.resolve(p)) ? path.resolve(p) : path.join(projDir, p));
  const rel = (p: string) => path.relative(projDir, p).split(path.sep).join("/");
  const floorRelief = opt("--floor-relief") ? Number(opt("--floor-relief")) : undefined, step = opt("--step") ? Number(opt("--step")) : undefined, storey = opt("--storey") ? Number(opt("--storey")) : undefined;
  let input: SocketInput;
  let markersFile: string | undefined = opt("--markers") ? resolve(opt("--markers")!) : undefined;
  // the ground outside the door, when the model does not carry it: terrain (layout path) or a flat grade
  let ground: (x: number, z: number) => number | null = () => null, groundLabel = "none";

  if (opt("--from-layout")) {
    const layoutFile = resolve(opt("--from-layout")!), layout = JSON.parse(fs.readFileSync(layoutFile, "utf8"));
    const bid = opt("--building"); const b = layout.buildings.find((x: any) => x.id === bid); if (!b) throw new Error(`no building "${bid}" in ${layoutFile}`);
    const manifestFile = opt("--manifest") ? resolve(opt("--manifest")!) : path.join(projDir, "assets/models/towns", layout.town ?? layout.townId ?? "", "manifest.json");
    const man = JSON.parse(fs.readFileSync(manifestFile, "utf8")), dist = man.districts[b.district]; if (!dist) throw new Error(`district "${b.district}" not in ${manifestFile}`);
    const glb = path.join(path.dirname(manifestFile), dist.file), lift = dist.lift ?? 0;
    // world -> model frame: model = R(-preRot) R(-yaw) (world - centre), R(a) turning local +Z to (sin a, cos a)
    const a = -(b.yaw + (b.preRot ?? 0)), ca = Math.cos(a), sa = Math.sin(a);
    const toLocal = (x: number, z: number): P2 => { const dx = x - b.centre[0], dz = z - b.centre[1]; return [dx * ca + dz * sa, -dx * sa + dz * ca]; };
    const lc = b.corners.map((p: P2) => toLocal(p[0], p[1])), lb = [Math.min(...lc.map((p: P2) => p[0])) - 1, Math.max(...lc.map((p: P2) => p[0])) + 1, Math.min(...lc.map((p: P2) => p[1])) - 1, Math.max(...lc.map((p: P2) => p[1])) + 1];
    const tris = glbTriangles(glb, (x, y, z) => { const wx = x + dist.anchor[0], wy = y + dist.anchor[1], wz = z + dist.anchor[2], [lx, lz] = toLocal(wx, wz); return [lx, wy - b.groundY, lz]; },
      (t) => { // this lot only: centroid within the footprint's local bbox + 1 m, so neighbours on the district mesh drop out
        const x = (t[0]! + t[3]! + t[6]!) / 3, z = (t[2]! + t[5]! + t[8]!) / 3; return x > lb[0]! && x < lb[1]! && z > lb[2]! && z < lb[3]!; });
    const auto = argv.includes("--auto"), rot = (v: P2): P2 => [v[0] * ca + v[1] * sa, -v[0] * sa + v[1] * ca];
    const outward = rot(b.facing);
    input = { id: opt("--id") ?? b.model ?? b.id, tris, floorY: lift, storey, step, floorRelief,
      footprint: auto ? undefined : b.corners.map((p: P2) => toLocal(p[0], p[1])),
      door: auto ? undefined : toLocal(b.door[0], b.door[1]), facing: auto ? undefined : [-outward[0], -outward[1]],
      source: { model: rel(glb), sha256: sha256(glb) } };
    console.log(`${b.id}: cut from ${rel(glb)} (district ${b.district}, ${tris.roof.length} tris near the lot), yaw ${b.yaw}${b.preRot ? ` preRot ${b.preRot}` : ""} removed${auto ? "; --auto: layout corners and door ignored" : ""}`);
    if (argv.includes("--terrain")) { // the built town: sample the voxel terrain under the lot (read-only)
      const tv = opt("--terrain"), worldFile = resolve(tv && !tv.startsWith("--") ? tv : "assets/worlds/proving.json");
      const core = await import("@hitreg/core"), recipe = core.worldRecipeSchema.parse(JSON.parse(fs.readFileSync(worldFile, "utf8"))), wid = "dress-steps";
      core.registerVoxelWorld(wid, recipe); const cs = recipe.cellSize, meshes = new Map<string, any>(), cb = Math.cos(-a), sb = Math.sin(-a);
      ground = (lx, lz) => { const x = lx * cb + lz * sb + b.centre[0], z = -lx * sb + lz * cb + b.centre[1], ci = Math.floor(x / cs), cj = Math.floor(z / cs), key = ci + "," + cj;
        let m = meshes.get(key); if (!m) { m = core.voxelMesh({ kind: "voxel", world: wid, cell: [ci, cj] } as any); meshes.set(key, m); }
        const px = x - ci * cs, pz = z - cj * cs, P = m.positions as ArrayLike<number>, I = m.indices as ArrayLike<number>; let h = -Infinity;
        for (let i = 0; i < I.length; i += 3) { const A = I[i]! * 3, B = I[i + 1]! * 3, C = I[i + 2]! * 3, den = (P[B + 2]! - P[C + 2]!) * (P[A]! - P[C]!) + (P[C]! - P[B]!) * (P[A + 2]! - P[C + 2]!); if (Math.abs(den) < 1e-8) continue; const u = ((P[B + 2]! - P[C + 2]!) * (px - P[C]!) + (P[C]! - P[B]!) * (pz - P[C + 2]!)) / den, v = ((P[C + 2]! - P[A + 2]!) * (px - P[C]!) + (P[A]! - P[C]!) * (pz - P[C + 2]!)) / den; if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) h = Math.max(h, u * P[A + 1]! + v * P[B + 1]! + (1 - u - v) * P[C + 1]!); }
        return Number.isFinite(h) ? h - b.groundY : null; };
      groundLabel = `voxel terrain from ${rel(worldFile)}`;
    } else { ground = () => 0; groundLabel = "ASSUMED flat grade at the layout groundY (no --terrain)"; }
    console.log(`  NOTE: source is the DISTRICT glb; a per-building model must replace it before this map is used by a town pipeline`);
  } else {
    const model = opt("--model"), id = opt("--id"); if (!model || !id) throw new Error("dress sockets: --model <glb> and --id <map id> are required (or --from-layout + --building)");
    const file = resolve(model); if (!fs.existsSync(file)) throw new Error(`no model ${file}`);
    if (!markersFile) { const beside = file.replace(/.glb$/i, ".markers.json"); if (beside !== file && fs.existsSync(beside)) markersFile = beside; }
    const fp = opt("--footprint"), door = opt("--door"), facing = opt("--facing");
    if ((door == null) !== (facing == null)) throw new Error("--door and --facing go together");
    input = { id, tris: glbTriangles(file), floorY: opt("--floor-y") ? Number(opt("--floor-y")) : 0, storey, step, floorRelief,
      footprint: fp ? fp.split(";").map(pair) : undefined, door: door ? pair(door) : undefined, facing: facing ? pair(facing) : undefined,
      source: { model: rel(file), sha256: sha256(file) } };
    const g = opt("--grade"); if (g !== undefined) { const gy = Number(g); ground = () => gy; groundLabel = `flat grade y ${gy} (--grade)`; }
    else { ground = () => 0; groundLabel = "ASSUMED flat grade at model y 0 (no --grade)"; }
  }

  const t0 = Date.now(), built = buildSocketMap(input), { report, probes } = built;
  let map = built.map;
  if (markersFile) {
    if (!fs.existsSync(markersFile)) throw new Error(`no markers file ${markersFile}`);
    const doc = JSON.parse(fs.readFileSync(markersFile, "utf8")) as { model?: string; markers?: FixtureMarker[] };
    for (const l of applyMarkers(map, doc.markers ?? [])) report.notes.push(l);
    report.notes.push(`fixture markers from ${rel(markersFile)} (sha256 ${sha256(markersFile).slice(0, 12)})`);
    const parsed = socketMapSchema.safeParse(map);
    if (!parsed.success) throw new Error(`markers made the map invalid: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  }
  // Circulation mask: the walking paths ('x') reserved before anything is placed, as wide as the resolver's lane.
  { const circ = circulate(map, { laneWidth: DEFAULT_LANE_WIDTH }); map = socketMapSchema.parse(circ.map); for (const n of circ.notes) report.notes.push(`paths: ${n}`); }
  const outDir = opt("--out-dir") ? path.resolve(opt("--out-dir")!) : path.join(projDir, "authoring/dressing/sockets"), out = path.join(outDir, `${map.id}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(map, null, 1) + "\n");
  console.log(`${map.id}: ${map.levels.length} level(s), footprint ${report.footprintSource}, door ${report.doorSource || "none"}, walls ${(report.axisAligned * 100).toFixed(0)}% axis-aligned, ${Date.now() - t0} ms`);
  for (const l of report.levels) {
    console.log(`  L${l.level} floor y ${l.floorY.toFixed(2)}: ${l.rooms.map((r) => `${r.id} ${r.area} m² (gross ${r.gross})`).join(", ") || "no rooms"} | walls ${l.walls} | cells: stair ${l.stair}, well ${l.well}, doorway ${l.doorway}, entry ${l.entry}`);
  }
  console.log(`  anchors: ${map.anchors.map((a) => `${a.id} (${a.kind}) [${a.position.join(", ")}] yaw ${a.yaw}`).join("; ") || "none"}`);
  for (const n of report.notes) console.log(`  note: ${n}`);
  if (!argv.includes("--quiet")) for (const p of report.plans) console.log(p);
  console.log(`wrote ${rel(out)}`);

  // ---- step gate
  const engineRoot = path.resolve(PLAYGROUND, "../.."), limits = controllerLimits(engineRoot, projDir), keep = new Set(map.levels.map((l) => l.level));
  const gated = probes.lines.filter((l) => keep.has(l.level)), profs = gated.map((l) => profileLine(probes.surfaces, l, l.kind === "entry" ? ground : () => null, groundLabel));
  const analysed = gated.map((l, i) => analyse(l, profs[i]!, limits));
  // a flight needs at least three risers: S cells whose probe finds fewer (roof slopes and eave edges read as treads) are not a
  // stair and are not reported, unless what the probe found stops the body (a FAIL stays visible)
  const fragment = (i: number) => gated[i]!.kind === "flight" && analysed[i]!.steps < 3 && analysed[i]!.verdict !== "FAIL";
  const profiles = analysed.filter((_, i) => !fragment(i)), dropped = gated.filter((_, i) => fragment(i)).map((l) => l.id);
  if (dropped.length) console.log(`  steps: ${dropped.length} stair fragment(s) with under 3 risers dropped (not flights): ${dropped.join(", ")}`);
  // ---- doorway lane sweeps: the capsule's whole volume through the outside door and each interior doorway
  const lanes: LaneSweep[] = [], laneUp = limits.stepHeight + 0.05;
  for (const l of probes.lines) if (l.kind === "entry" && l.face !== undefined) {
    const prof = profileLine(probes.surfaces, l, ground, groundLabel, laneUp);
    lanes.push(sweepLane(input.tris, l, prof, limits, { id: "entry-lane", kind: "entry-lane", from: l.face - 2.6, to: l.face + 1.1, ref: l.face }));
  }
  // stair flights: the capsule swept up the whole flight on the profiled treads (headroom under the slab/well edge,
  // rails or stringers narrower than the body); the probe starts 1.2 m before the foot, so ref 1.2 = the first riser
  // (a fragment of S cells whose probe finds under 3 risers is not a flight and would sweep into a wall)
  gated.forEach((l, i) => { if (l.kind !== "flight" || analysed[i]!.steps < 3) return;
    lanes.push(sweepLane(input.tris, l, profs[i]!, limits, { id: `${l.id}-lane`, kind: "flight-lane", from: 0.6, to: l.length - 0.6, ref: 1.2 })); });
  for (const lv of map.levels) { // interior doorways: each run of 'D' cells between two rooms, crossed room to room
    const W = lv.columns, Hh = lv.rows, D = SOCKET_CELLS.doorway, seen = new Uint8Array(W * Hh); let di = 0;
    const cxy = (i: number, j: number): P2 => [lv.origin[0] + (i + 0.5) * lv.step, lv.origin[1] + (j + 0.5) * lv.step];
    for (let j0 = 0; j0 < Hh; j0++) for (let i0 = 0; i0 < W; i0++) {
      if (seen[j0 * W + i0] || lv.cells[j0]![i0] !== D) continue;
      const comp: number[] = [j0 * W + i0]; seen[j0 * W + i0] = 1;
      for (let q = 0; q < comp.length; q++) { const i = comp[q]! % W, j = (comp[q]! - i) / W; for (const [a, b] of DIRS) { const ni = i + a, nj = j + b; if (ni < 0 || nj < 0 || ni >= W || nj >= Hh) continue; const k = nj * W + ni; if (!seen[k] && lv.cells[nj]![ni] === D) { seen[k] = 1; comp.push(k); } } }
      const side = new Map<string, P2[]>();
      for (const c of comp) { const i = c % W, j = (c - i) / W; for (const [a, b] of DIRS) { const ni = i + a, nj = j + b; if (ni < 0 || nj < 0 || ni >= W || nj >= Hh) continue; const rm = lv.room[nj]![ni]!; if (rm !== "." && lv.cells[nj]![ni] !== D) { const v = side.get(rm) ?? []; v.push(cxy(ni, nj)); side.set(rm, v); } } }
      const two = [...side.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 2);
      if (two.length < 2) continue;
      const cen = (v: P2[]): P2 => [v.reduce((a, p) => a + p[0], 0) / v.length, v.reduce((a, p) => a + p[1], 0) / v.length];
      const mid = cen(comp.map((c) => cxy(c % W, (c - (c % W)) / W))), ca = cen(two[0]![1]), cb = cen(two[1]![1]);
      let dx = cb[0] - ca[0], dz = cb[1] - ca[1]; const len = Math.hypot(dx, dz); if (len < 1e-6) continue; dx /= len; dz /= len;
      if (Math.abs(dx) > Math.cos(0.35)) { dx = Math.sign(dx); dz = 0; } else if (Math.abs(dz) > Math.cos(0.35)) { dz = Math.sign(dz); dx = 0; }
      di++;
      const line: ProbeLine = { id: `L${lv.level}-door${di}`, kind: "flight", level: lv.level, start: [mid[0] - dx * 1.6, mid[1] - dz * 1.6], dir: [dx, dz], length: 3.2, startY: lv.floorY };
      const prof = profileLine(probes.surfaces, line, () => null, "model surfaces only", laneUp);
      lanes.push(sweepLane(input.tris, line, prof, limits, { id: line.id, kind: "doorway-lane", from: 0.6, to: 2.6, ref: 1.6 }));
    }
  }
  const verdict = profiles.some((p) => p.verdict === "FAIL") || lanes.some((l) => l.verdict === "FAIL") ? "FAIL" : profiles.some((p) => p.verdict === "WARN") || lanes.some((l) => l.verdict === "WARN") ? "WARN" : "PASS";
  const stepsOut = path.join(outDir, `${map.id}.steps.json`);
  fs.writeFileSync(stepsOut, JSON.stringify({ id: map.id, source: map.source, verdict, controller: limits, outsideGround: groundLabel, profiles, lanes }, null, 1) + "\n");
  console.log(stepTable(map.id, profiles));
  for (const p of profiles) for (const r of p.reasons) console.log(`  ${p.id}: ${r}`);
  if (lanes.length) { console.log(`${map.id} lanes (capsule r ${limits.radius} m, h ${limits.height} m)\n${laneTable(lanes)}`); for (const l of lanes) for (const r of l.reasons) console.log(`  ${l.id}: ${r}`); }
  const entry = profiles.find((p) => p.kind === "entry"); if (entry) console.log(`  entry ground: ${entry.ground}`);
  console.log(`wrote ${rel(stepsOut)} (${verdict})`);
  if (argv.includes("--check-steps") && verdict === "FAIL") { console.error(`${map.id}: step gate FAILED`); process.exitCode = 1; }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) run(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
