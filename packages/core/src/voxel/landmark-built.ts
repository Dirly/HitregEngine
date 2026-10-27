/**
 * BUILT LANDMARKS — `landmark` operator `kind: "built"`: the same CSG part spec meshed DIRECTLY (no voxels): crisp
 * edges, real UVs in metres at the role's tile, one group per role (the baker gives each role its own material, one draw
 * per material, a trimesh collider from the same mesh).
 *
 * The solids are applied in order like the DC compile, with mesh rules:
 * - `add`: the part's closed surface; portions hidden inside an earlier CONVEX solid are dropped, and it hides what it
 *   covers of earlier surfaces (a union without internal faces). Touching faces between two solids are dropped from
 *   both; coplanar same-facing overlaps keep the earlier part's face.
 * - `sub`: must be CONVEX (box, cylinder, cone, convex extrude, sphere). It removes the surface inside it and adds its
 *   own inward faces (the REVEAL: jambs, soffit, sill) wherever it cut through an earlier convex solid, in that solid's
 *   role and UV frame. A cut through a non-convex part (lathe, arch, torus) leaves no reveal and is reported.
 *   Prefer an opening modelled as pieces around a gap when it is cleaner (an `arch` part is exactly that).
 * - `intersect`: refused (stamp mode only).
 * Natural roles (rock, cliff, ...) are skipped here: the baker DC-stamps them in the same prefab (mixed landmark).
 *
 * UVs (metres / tile; v up, u to the viewer's right — the flat-art flipY rule for engine materials):
 * `box` per face from its dominant part-local axis, `cylindrical` around part +Y snapped to whole tiles per ring,
 * `planar` local XY; `uvRegion` maps one face onto an image region once. Pure and deterministic.
 * `bevel` (a box part's, or its role's default): every edge chamfered at 45 degrees, the box stays convex (cuts, reveals).
 */
import type { CsgNode } from "./csg.js";
import { isNaturalRole, type CompiledLandmark, type LandmarkUvMode, type LandmarkUvRegion } from "./landmark-stamp.js";
import { triangulateFace } from "../poly-mesh/compile.js";

type V3 = [number, number, number];
/** `uva`: an explicit planar UV map in metres (part `triUv`): u = a.p + cu, v = b.p + cv; survives clipping. */
interface Poly { v: V3[]; n: V3; part: number; uva?: number[] }

/** The affine map of one triangle's metre UVs over its plane (u, v = dot(a|b, p) + c). */
function triAffine(p: V3[], uv: number[]): number[] | undefined {
  const e1 = sub3(p[1]!, p[0]!), e2 = sub3(p[2]!, p[0]!);
  const g11 = dot(e1, e1), g12 = dot(e1, e2), g22 = dot(e2, e2), det = g11 * g22 - g12 * g12;
  if (Math.abs(det) < 1e-12) return undefined;
  const out: number[] = [];
  for (const k of [0, 1]) {
    const d1 = uv[2 + k]! - uv[k]!, d2 = uv[4 + k]! - uv[k]!;
    const al = (d1 * g22 - d2 * g12) / det, be = (d2 * g11 - d1 * g12) / det;
    const a: V3 = [al * e1[0] + be * e2[0], al * e1[1] + be * e2[1], al * e1[2] + be * e2[2]];
    out.push(a[0], a[1], a[2], uv[k]! - dot(a, p[0]!));
  }
  return out;
}
interface Plane { n: V3; d: number }
interface Solid { planes: Plane[] | null; min: V3; max: V3 }

export interface BuiltGroup {
  role: string;
  positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array;
  vertexCount: number; triangleCount: number; min: V3; max: V3;
}
export interface BuiltLandmarkMesh {
  groups: BuiltGroup[];
  /** Subs whose cut passed through a non-convex part (no reveal faces there). */
  revealSkipped: string[];
  /** Natural-role add parts left to the DC stamp. */
  natural: number;
  triangles: number;
}
export interface BuiltOptions {
  /** Metres per texture repeat for a role (the baker: texture px / 40). Falls back to the spec's role `tile`, then 4 m. */
  tile?: (role: string) => [number, number] | undefined;
}

const EPS = 1e-4;
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** Row-major R = Rz*Ry*Rx (csg.ts eulerMatrix). */
function euler(rx: number, ry: number, rz: number): number[] {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}
const mulV = (m: number[], v: V3): V3 => [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
const mulT = (m: number[], v: V3): V3 => [m[0]! * v[0] + m[3]! * v[1] + m[6]! * v[2], m[1]! * v[0] + m[4]! * v[1] + m[7]! * v[2], m[2]! * v[0] + m[5]! * v[1] + m[8]! * v[2]];

function newell(v: V3[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < v.length; i++) { const a = v[i]!, b = v[(i + 1) % v.length]!; x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]); }
  return norm([x, y, z]);
}

/**
 * A box of half extents `e` with every edge chamfered by `b` (b < the smallest half extent): 6 shrunk faces, 12 edge
 * strips at 45 degrees and 8 corner triangles, outward-wound. Still convex, so it cuts and is cut like a box.
 */
function chamferedBox(e: V3, b: number): V3[][] {
  // P(s, a): the corner (signs s) pulled in by b on every axis except a
  const P = (s: V3, a: number): V3 => [0, 1, 2].map((k) => s[k]! * (k === a ? e[k]! : e[k]! - b)) as V3;
  const outward = (q: V3[]): V3[] => {
    const c = q.reduce((t, v) => [t[0] + v[0], t[1] + v[1], t[2] + v[2]] as V3, [0, 0, 0] as V3);
    // angular order around the centroid, in a plane basis perpendicular to the centroid direction
    const nn = norm(c), ref: V3 = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], u = norm(cross(nn, ref)), v = cross(nn, u);
    const cc: V3 = [c[0] / q.length, c[1] / q.length, c[2] / q.length];
    const s = [...q].sort((p, r) => Math.atan2(dot(sub3(p, cc), v), dot(sub3(p, cc), u)) - Math.atan2(dot(sub3(r, cc), v), dot(sub3(r, cc), u)));
    return dot(newell(s), nn) >= 0 ? s : s.reverse();
  };
  const out: V3[][] = [];
  const sg = [-1, 1];
  for (let a = 0; a < 3; a++) for (const sa of sg) { // faces
    const q: V3[] = [];
    for (const s1 of sg) for (const s2 of sg) { const s: V3 = [0, 0, 0]; s[a] = sa; s[(a + 1) % 3] = s1; s[(a + 2) % 3] = s2; q.push(P(s, a)); }
    out.push(outward(q));
  }
  for (let a = 0; a < 3; a++) { const c2 = (a + 1) % 3, e2 = (a + 2) % 3; for (const sa of sg) for (const sc of sg) { // edge strips between faces a and c2
    const q: V3[] = [];
    for (const se of sg) { const s: V3 = [0, 0, 0]; s[a] = sa; s[c2] = sc; s[e2] = se; q.push(P(s, a), P(s, c2)); }
    out.push(outward(q));
  } }
  for (const sx of sg) for (const sy of sg) for (const sz of sg) { const s: V3 = [sx, sy, sz]; out.push(outward([P(s, 0), P(s, 1), P(s, 2)])); } // corners
  return out;
}

/** Local-frame outward-wound polygons of one node (convex faces, or triangles where a face is concave). */
function localPolys(node: CsgNode, segments: number, bevel = 0): V3[][] {
  const n = node as CsgNode & Record<string, unknown>;
  const out: V3[][] = [];
  const ring = (r: number, y: number, k: number): V3 => { const a = (2 * Math.PI * k) / segments; return [r * Math.sin(a), y, r * Math.cos(a)]; };
  switch (node.shape) {
    case "box": {
      const [w, h, d] = (n.size as number[]).map((s) => s / 2) as V3;
      const b = Math.min(bevel, 0.45 * Math.min(w, h, d));
      if (b > 1e-4) { out.push(...chamferedBox([w, h, d], b)); break; }
      const c = (x: number, y: number, z: number): V3 => [x * w, y * h, z * d];
      out.push([c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1), c(-1, -1, 1)], // +z
        [c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1), c(1, -1, -1)], // -z
        [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)], // +x
        [c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1), c(-1, -1, -1)], // -x
        [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)], // +y
        [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)]); // -y
      break;
    }
    case "cylinder": case "cone": {
      const r = n.radius as number, h = (n.height as number) / 2, top = node.shape === "cone" ? 0 : r;
      for (let k = 0; k < segments; k++) {
        if (top > 0) out.push([ring(r, -h, k), ring(r, -h, k + 1), ring(top, h, k + 1), ring(top, h, k)]);
        else out.push([ring(r, -h, k), ring(r, -h, k + 1), [0, h, 0]]);
      }
      out.push(Array.from({ length: segments }, (_, k) => ring(r, -h, segments - k)));
      if (top > 0) out.push(Array.from({ length: segments }, (_, k) => ring(top, h, k)));
      break;
    }
    case "sphere": case "ellipsoid": case "capsule": {
      const lat = Math.max(4, Math.round(segments / 2));
      const sz = node.shape === "sphere" ? [n.radius, n.radius, n.radius] as number[] : node.shape === "ellipsoid" ? (n.size as number[]).map((s) => s / 2) : [n.radius, n.radius, n.radius] as number[];
      const half = node.shape === "capsule" ? (n.height as number) / 2 : 0;
      const p = (i: number, k: number): V3 => {
        const t = Math.PI * (i / lat) - Math.PI / 2, a = (2 * Math.PI * k) / segments;
        const y = Math.sin(t) * sz[1]! + (half ? (i >= lat / 2 ? half : -half) : 0);
        return [Math.cos(t) * Math.sin(a) * sz[0]!, y, Math.cos(t) * Math.cos(a) * sz[2]!];
      };
      for (let i = 0; i < lat; i++) for (let k = 0; k < segments; k++) {
        const q = [p(i, k), p(i, k + 1), p(i + 1, k + 1), p(i + 1, k)];
        const keep = q.filter((v, j) => j === 0 || Math.hypot(...sub3(v, q[j - 1]!)) > EPS);
        if (keep.length >= 3 && Math.hypot(...sub3(keep[0]!, keep[keep.length - 1]!)) > EPS) out.push(keep); else if (keep.length >= 4) out.push(keep.slice(0, -1));
      }
      break;
    }
    case "torus": {
      const R = n.radius as number, r = n.height as number, m = Math.max(6, Math.round(segments / 3));
      const p = (k: number, j: number): V3 => { const a = (2 * Math.PI * k) / segments, b = (2 * Math.PI * j) / m, rr = R + r * Math.cos(b); return [rr * Math.sin(a), r * Math.sin(b), rr * Math.cos(a)]; };
      for (let k = 0; k < segments; k++) for (let j = 0; j < m; j++) out.push([p(k, j), p(k + 1, j), p(k + 1, j + 1), p(k, j + 1)]);
      break;
    }
    case "prism": {
      const poly = n.polygon as [number, number][], h = (n.height as number) / 2;
      // outward winding: the polygon is CCW seen from +y when its signed area (x, z) is negative in this frame
      let area = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i]!, b = poly[(i + 1) % poly.length]!; area += a[0] * b[1] - b[0] * a[1]; }
      const P = area > 0 ? [...poly].reverse() : poly;
      const top = P.map(([x, z]) => [x, h, z] as V3), bot = P.map(([x, z]) => [x, -h, z] as V3);
      for (let i = 0; i < P.length; i++) { const j = (i + 1) % P.length; out.push([bot[i]!, bot[j]!, top[j]!, top[i]!]); }
      for (const [cap, up] of [[top, [0, 1, 0]], [[...bot].reverse(), [0, -1, 0]]] as [V3[], V3][]) for (const [a, b, c] of triangulateFace(cap, up)) out.push([cap[a]!, cap[b]!, cap[c]!]);
      break;
    }
    case "mesh": {
      const m = n.mesh as { positions: number[]; indices: number[] };
      for (let t = 0; t < m.indices.length; t += 3) out.push([0, 1, 2].map((e) => { const i = m.indices[t + e]! * 3; return [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!] as V3; }));
      break;
    }
    default: throw new Error(`built landmark: shape ${node.shape} is not supported (stamp mode only)`);
  }
  return out;
}

/** World-space polygons + its solid (convex planes or null) for a node. */
function nodeSurface(node: CsgNode, segments: number, bevel = 0): { polys: V3[][]; solid: Solid } {
  const rot = node.rotation ?? [0, 0, 0], R = euler(rot[0]!, rot[1]!, rot[2]!), t = (node.position ?? [0, 0, 0]) as V3;
  const polys = localPolys(node, segments, bevel).map((p) => p.map((v) => { const w = mulV(R, v); return [w[0] + t[0], w[1] + t[1], w[2] + t[2]] as V3; }))
    .filter((p) => { const a = cross(sub3(p[1]!, p[0]!), sub3(p[2]!, p[0]!)); return p.length > 3 || Math.hypot(...a) > 1e-9; });
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const v of p) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a]!, v[a]!); max[a] = Math.max(max[a]!, v[a]!); }
  const planes: Plane[] = [];
  for (const p of polys) {
    const nn = newell(p), d = dot(nn, p[0]!);
    if (!planes.some((q) => Math.abs(q.d - d) < 1e-3 && dot(q.n, nn) > 1 - 1e-6)) planes.push({ n: nn, d });
  }
  let convex = true;
  outer: for (const q of planes) for (const p of polys) for (const v of p) if (dot(q.n, v) - q.d > 1e-3) { convex = false; break outer; }
  return { polys, solid: { planes: convex ? planes : null, min, max } };
}

const overlaps = (p: V3[], s: Solid) => {
  for (let a = 0; a < 3; a++) { let lo = Infinity, hi = -Infinity; for (const v of p) { lo = Math.min(lo, v[a]!); hi = Math.max(hi, v[a]!); } if (hi < s.min[a]! - EPS || lo > s.max[a]! + EPS) return false; }
  return true;
};

/** Split a convex polygon by a plane: [outside (dist > 0), inside]. */
function splitPlane(v: V3[], pl: Plane): [V3[] | null, V3[] | null] {
  const d = v.map((p) => dot(pl.n, p) - pl.d);
  if (d.every((x) => x <= EPS)) return [null, v];
  if (d.every((x) => x >= -EPS)) return [v, null];
  const front: V3[] = [], back: V3[] = [];
  for (let i = 0; i < v.length; i++) {
    const j = (i + 1) % v.length, a = v[i]!, b = v[j]!, da = d[i]!, db = d[j]!;
    if (da >= -EPS) front.push(a);
    if (da <= EPS) back.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) { const x = lerp(a, b, da / (da - db)); front.push(x); back.push(x); }
  }
  return [front.length >= 3 ? front : null, back.length >= 3 ? back : null];
}

/**
 * Poly vs convex solid: [outside pieces, the inside piece]. A poly lying ON one of the solid's planes: rule 0 (a cutter)
 * keeps it outside; rules 1/2 count it inside when it faces against the plane (a touching interface), and rule 2 also
 * when it faces the same way (a later part's coplanar overlap: the earlier part's face wins).
 */
function splitSolid(p: Poly, s: Solid, rule: 0 | 1 | 2): [Poly[], Poly | null] {
  if (!s.planes || !overlaps(p.v, s)) return [[p], null];
  const outside: Poly[] = [];
  let cur: V3[] | null = p.v;
  for (const pl of s.planes) {
    if (!cur) break;
    if (cur.every((v) => Math.abs(dot(pl.n, v) - pl.d) <= EPS * 10)) {
      const facing = dot(pl.n, p.n);
      if (rule > 0 && (facing < -0.999 || (facing > 0.999 && rule === 2))) continue;
      outside.push({ ...p, v: cur }); cur = null; break;
    }
    const [f, b] = splitPlane(cur, pl);
    if (f) outside.push({ ...p, v: f });
    cur = b;
  }
  return [outside, cur ? { ...p, v: cur } : null];
}

/** UVs of one world-space polygon in its part's frame. */
function polyUvs(p: Poly, frame: number[], mode: LandmarkUvMode, tile: [number, number], region: LandmarkUvRegion | undefined, regionBox: number[] | undefined): number[] {
  const ln = mulT(frame, p.n), ax = Math.abs(ln[0]) >= Math.abs(ln[1]) && Math.abs(ln[0]) >= Math.abs(ln[2]) ? 0 : Math.abs(ln[1]) >= Math.abs(ln[2]) ? 1 : 2;
  const face = `${ln[ax]! >= 0 ? "+" : "-"}${"xyz"[ax]}`;
  const L = p.v.map((v) => mulT(frame, v));
  const boxUv = (q: V3): [number, number] => {
    switch (face) {
      case "+z": return [q[0], q[1]]; case "-z": return [-q[0], q[1]];
      case "+x": return [-q[2], q[1]]; case "-x": return [q[2], q[1]];
      case "+y": return [q[0], -q[2]]; default: return [q[0], q[2]];
    }
  };
  if (p.uva) {
    const a = p.uva;
    return p.v.flatMap((q) => [(a[0]! * q[0] + a[1]! * q[1] + a[2]! * q[2] + a[3]!) / tile[0], (a[4]! * q[0] + a[5]! * q[1] + a[6]! * q[2] + a[7]!) / tile[1]]);
  }
  if (region) {
    const [x0, y0, x1, y1] = region.rect;
    if (face !== region.face || !regionBox) return L.flatMap(() => [x0 + 0.002, 1 - (y0 + 0.002)]);
    const [u0, v0, u1, v1] = regionBox;
    return L.flatMap((q) => { const [u, v] = boxUv(q); const tu = (u - u0!) / Math.max(1e-6, u1! - u0!), tv = (v - v0!) / Math.max(1e-6, v1! - v0!); return [x0 + tu * (x1 - x0), 1 - (y1 - tv * (y1 - y0))]; });
  }
  let uv: [number, number][];
  if (mode === "planar") uv = L.map((q) => [q[0], q[1]]);
  else if (mode === "cylindrical" && ax !== 1) {
    const c = L.reduce((a, q) => [a[0] + q[0] / L.length, a[1] + q[1] / L.length, a[2] + q[2] / L.length] as V3, [0, 0, 0] as V3);
    const tc = Math.atan2(c[0], c[2]), rbar = L.reduce((a, q) => a + Math.hypot(q[0], q[2]), 0) / L.length;
    const tilesRound = Math.max(1, Math.round((2 * Math.PI * rbar) / tile[0])); // whole tiles per ring: no seam
    return L.flatMap((q) => { let t = Math.atan2(q[0], q[2]) - tc; t -= Math.round(t / (2 * Math.PI)) * 2 * Math.PI; return [((tc + t) / (2 * Math.PI)) * tilesRound, q[1] / tile[1]]; });
  } else uv = L.map(boxUv);
  return uv.flatMap(([u, v]) => [u / tile[0], v / tile[1]]);
}

const DEFAULT_UV = (shape: string): LandmarkUvMode => (shape === "box" || shape === "prism" ? "box" : "cylindrical");

/** Mesh a compiled landmark spec directly (built mode). Natural-role adds are left to the DC stamp. */
export function buildLandmarkMesh(c: CompiledLandmark, o: BuiltOptions = {}): BuiltLandmarkMesh {
  const N = c.nodes.length;
  const surf = c.nodes.map((n, i) => (c.roles[i] !== "opening" && n.op !== "sub" && isNaturalRole(c.roles[i]!)) ? null : nodeSurface(n, c.meta[i]?.segments ?? (n.shape === "box" ? 4 : 24), c.meta[i]?.bevel ?? 0));
  let polys: Poly[] = [];
  const revealSkipped: string[] = [];
  let natural = 0;
  // per node: face-extent box of its uvRegion face (part frame, before any clip)
  const regionBox: (number[] | undefined)[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const node = c.nodes[i]!, s = surf[i];
    if (!s) { if (node.op !== "sub") natural++; continue; }
    if (node.op === "intersect") throw new Error(`built landmark: part "${c.names[i]}" uses intersect (stamp mode only)`);
    if (node.op === "sub") {
      if (!s.solid.planes) throw new Error(`built landmark: sub part "${c.names[i]}" is not convex (use a box, cylinder or convex extrude, or model the opening as pieces around a gap)`);
      polys = polys.flatMap((p) => splitSolid(p, s.solid, 0)[0]);
      // reveal: the cutter's inward faces inside each earlier convex add, minus earlier adds already covering them and
      // minus subs between that add and this one (already air)
      let cutNonConvex = false;
      for (let j = 0; j < i; j++) if (surf[j] && c.nodes[j]!.op !== "sub" && !surf[j]!.solid.planes && s.polys.some((v) => overlaps(v, surf[j]!.solid))) cutNonConvex = true;
      if (cutNonConvex) revealSkipped.push(c.names[i]!);
      for (const face of s.polys) {
        const v = [...face].reverse();
        let remaining: Poly[] = [{ v, n: newell(v), part: -1 }];
        for (let j = 0; j < i && remaining.length; j++) {
          const sj = surf[j];
          if (!sj || c.nodes[j]!.op === "sub" || !sj.solid.planes) continue;
          const next: Poly[] = [];
          for (const r of remaining) {
            const [out, inside] = splitSolid(r, sj.solid, 1);
            next.push(...out);
            if (!inside) continue;
            let keep: Poly[] = [{ ...inside, part: j }];
            for (let k = j + 1; k < i; k++) if (surf[k] && c.nodes[k]!.op === "sub") keep = keep.flatMap((q) => splitSolid(q, surf[k]!.solid, 0)[0]);
            polys.push(...keep);
          }
          remaining = next;
        }
      }
      continue;
    }
    // add: new faces hidden inside earlier convex adds (unless an intervening sub carved that space) are dropped
    const triUv = node.shape === "mesh" ? c.meta[i]?.triUv : undefined;
    if (triUv && triUv.length !== s.polys.length * 6) throw new Error(`built landmark: part "${c.names[i]}" triUv has ${triUv.length / 6} triangles, the mesh ${s.polys.length}`);
    let fresh: Poly[] = s.polys.map((v, k) => {
      const uva = triUv ? triAffine(v, triUv.slice(k * 6, k * 6 + 6)) : undefined;
      return { v, n: newell(v), part: i, ...(uva ? { uva } : {}) };
    });
    const reg = c.meta[i]?.uvRegion;
    if (reg) {
      const frame = c.meta[i]!.frame; let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const p of fresh) {
        const uvs = polyUvs(p, frame, "box", [1, 1], undefined, undefined); // metres in the face's box frame
        const ln = mulT(frame, p.n), ax = Math.abs(ln[0]) >= Math.abs(ln[1]) && Math.abs(ln[0]) >= Math.abs(ln[2]) ? 0 : Math.abs(ln[1]) >= Math.abs(ln[2]) ? 1 : 2;
        if (`${ln[ax]! >= 0 ? "+" : "-"}${"xyz"[ax]}` !== reg.face) continue;
        for (let k = 0; k < uvs.length; k += 2) { u0 = Math.min(u0, uvs[k]!); u1 = Math.max(u1, uvs[k]!); v0 = Math.min(v0, uvs[k + 1]!); v1 = Math.max(v1, uvs[k + 1]!); }
      }
      if (u1 > u0) regionBox[i] = [u0, v0, u1, v1];
    }
    for (let j = 0; j < i; j++) {
      const sj = surf[j];
      if (!sj || c.nodes[j]!.op === "sub" || !sj.solid.planes) continue;
      fresh = fresh.flatMap((p) => {
        const [out, inside] = splitSolid(p, sj.solid, 2);
        if (!inside) return out;
        let rescued: Poly[] = [], left: Poly[] = [inside];
        for (let k = j + 1; k < i && left.length; k++) if (surf[k] && c.nodes[k]!.op === "sub") {
          const nl: Poly[] = [];
          for (const q of left) { const [o2, in2] = splitSolid(q, surf[k]!.solid, 0); nl.push(...o2); if (in2) rescued.push(in2); }
          left = nl;
        }
        return [...out, ...rescued];
      });
    }
    if (s.solid.planes) polys = polys.flatMap((p) => splitSolid(p, s.solid, 1)[0]);
    polys.push(...fresh);
  }
  // group by role, UVs, fan-triangulate, weld
  const byRole = new Map<string, { pos: number[]; nrm: number[]; uv: number[]; idx: number[]; key: Map<string, number> }>();
  for (const p of polys) {
    const pi = p.part, role = c.roles[pi]!, m = c.meta[pi]!;
    const area = Math.hypot(...p.v.slice(2).reduce((a, v, k) => { const cr = cross(sub3(p.v[k + 1]!, p.v[0]!), sub3(v, p.v[0]!)); return [a[0] + cr[0], a[1] + cr[1], a[2] + cr[2]] as V3; }, [0, 0, 0] as V3));
    if (area < 1e-7) continue;
    const tile = o.tile?.(role) ?? c.roleTiles[role] ?? [4, 4];
    const uv = polyUvs(p, m.frame, m.uv ?? DEFAULT_UV(c.nodes[pi]!.shape), tile, m.uvRegion, regionBox[pi]);
    let g = byRole.get(role); if (!g) byRole.set(role, g = { pos: [], nrm: [], uv: [], idx: [], key: new Map() });
    const vi = p.v.map((v, k) => {
      const key = `${v.map((x) => Math.round(x * 1e4)).join(",")}|${p.n.map((x) => Math.round(x * 1e3)).join(",")}|${Math.round(uv[k * 2]! * 1e4)},${Math.round(uv[k * 2 + 1]! * 1e4)}`;
      let id = g!.key.get(key);
      if (id === undefined) { id = g!.pos.length / 3; g!.key.set(key, id); g!.pos.push(...v); g!.nrm.push(...p.n); g!.uv.push(uv[k * 2]!, uv[k * 2 + 1]!); }
      return id;
    });
    for (let k = 1; k + 1 < vi.length; k++) if (vi[0] !== vi[k] && vi[k] !== vi[k + 1] && vi[0] !== vi[k + 1]) g.idx.push(vi[0]!, vi[k]!, vi[k + 1]!);
  }
  const groups: BuiltGroup[] = [...byRole.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([role, g]) => {
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.pos.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a]!, g.pos[i + a]!); max[a] = Math.max(max[a]!, g.pos[i + a]!); }
    return { role, positions: Float32Array.from(g.pos), normals: Float32Array.from(g.nrm), uvs: Float32Array.from(g.uv), indices: Uint32Array.from(g.idx), vertexCount: g.pos.length / 3, triangleCount: g.idx.length / 3, min, max };
  }).filter((g) => g.triangleCount);
  return { groups, revealSkipped, natural, triangles: groups.reduce((a, g) => a + g.triangleCount, 0) };
}
