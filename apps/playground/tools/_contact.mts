/**
 * The ONE contact solver for anything that must touch real surfaces: structural kit pieces (shoring, ladders, chutes,
 * walkways, decks: tools/structure.mts `scene` / `fit`) and the spider-web planners (world-kit authoring/spider-webs:
 * skirts.mts). Lifted from the web skirt planner's anchor proving: supports are FINITE world triangles (baked rock
 * shell, meshes, placed structure) plus an optional terrain height field; an anchor counts only when it lands on one
 * within tolerance (no bounds or "floating support" fallback); a candidate with any missed anchor is REJECTED, and the
 * report says which anchor missed and by how much.
 *
 *   const S = surfaces(tris, { ground });          // tris: { a, b, c } world triangles
 *   S.nearest(p)          -> { d, signed, normal, tri } | null     (signed: + in air, - inside the solid)
 *   S.ray(o, dir, max)    -> { t, p, normal } | null                (first hit along a unit dir)
 *   S.prove(anchors, tol) -> { ok, contacts, missed }              (anchor: { id, at, what? })
 *
 * Tolerance: an anchor is met when it sits at most `gap` (default 0.05 m) above a surface or at most `embed` (default
 * 0.10 m) inside it. "Above/inside" comes from the nearest triangle's normal, which for a closed shell points into the
 * air; open single-sided meshes (bark, a deck plank) count both sides as outside, so only the gap applies there.
 */
export type V3 = [number, number, number];
export interface SurfaceTri { a: V3; b: V3; c: V3; owner?: string }
export interface Anchor { id: string; at: V3; what?: string }
export interface Contact { id: string; what?: string; at: V3; d: number; signed: number; owner?: string; on: "mesh" | "ground" }
export interface Missed { id: string; what?: string; at: V3; d: number | null; why: string }
export interface Proof { ok: boolean; contacts: Contact[]; missed: Missed[] }
export interface Tolerance { gap?: number; embed?: number; reach?: number }
export interface Surfaces {
  tris: SurfaceTri[];
  nearest(p: V3, reach?: number, skip?: (t: SurfaceTri) => boolean): { d: number; signed: number; normal: V3; tri: SurfaceTri } | null;
  ray(o: V3, dir: V3, max: number, skip?: (t: SurfaceTri) => boolean): { t: number; p: V3; normal: V3; tri: SurfaceTri | null } | null;
  prove(anchors: Anchor[], tol?: Tolerance, skip?: (t: SurfaceTri) => boolean): Proof;
}

const sub = (u: V3, v: V3): V3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const dot = (u: V3, v: V3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u: V3, v: V3): V3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const unit = (u: V3): V3 => { const l = Math.hypot(u[0], u[1], u[2]) || 1; return [u[0] / l, u[1] / l, u[2] / l]; };

/** closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5) */
export function closestOnTri(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (s: number, t: number): V3 => [a[0] + ab[0] * s + ac[0] * t, a[1] + ab[1] * s + ac[1] * t, a[2] + ab[2] * s + ac[2] * t];
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
  const den = 1 / (va + vb + vc); return at(vb * den, vc * den);
}

/** world triangles from tools/_prop-geometry sceneGeometry() entries (nine numbers per triangle) */
export function trisFromWorld(world: number[], owner?: string): SurfaceTri[] {
  const out: SurfaceTri[] = [];
  for (let o = 0; o + 8 < world.length; o += 9) out.push({ a: [world[o]!, world[o + 1]!, world[o + 2]!], b: [world[o + 3]!, world[o + 4]!, world[o + 5]!], c: [world[o + 6]!, world[o + 7]!, world[o + 8]!], owner });
  return out;
}

/** a bucketed surface set (2 m cells in x/z); `ground` = terrain height at (x, z), or null where there is none */
export function surfaces(tris: SurfaceTri[], opts: { ground?: (x: number, z: number) => number | null; cell?: number } = {}): Surfaces {
  const CELL = opts.cell ?? 2, grid = new Map<string, number[]>(), normals: V3[] = [];
  tris.forEach((t, i) => {
    normals.push(unit(cross(sub(t.b, t.a), sub(t.c, t.a))));
    const x0 = Math.min(t.a[0], t.b[0], t.c[0]), x1 = Math.max(t.a[0], t.b[0], t.c[0]), z0 = Math.min(t.a[2], t.b[2], t.c[2]), z1 = Math.max(t.a[2], t.b[2], t.c[2]);
    if ((x1 - x0) / CELL > 64 || (z1 - z0) / CELL > 64) return; // sea planes and the like carry nothing
    for (let i0 = Math.floor(x0 / CELL); i0 <= Math.floor(x1 / CELL); i0++) for (let k = Math.floor(z0 / CELL); k <= Math.floor(z1 / CELL); k++) {
      const key = `${i0},${k}`; (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
    }
  });
  const near = (x: number, z: number, r: number): Set<number> => {
    const out = new Set<number>();
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) for (let k = Math.floor((z - r) / CELL); k <= Math.floor((z + r) / CELL); k++) for (const j of grid.get(`${i},${k}`) ?? []) out.add(j);
    return out;
  };
  // a closed shell's normals point into the air; a triangle with no neighbour on its back side (an open sheet) is
  // two-sided: the caller decides by `signed` only when the nearest triangle is part of a closed set (owner-level)
  const S: Surfaces = {
    tris,
    nearest(p, reach = 1, skip) {
      let best: { d: number; signed: number; normal: V3; tri: SurfaceTri } | null = null;
      for (const i of near(p[0], p[2], reach)) {
        const t = tris[i]!; if (skip?.(t)) continue;
        const q = closestOnTri(p, t.a, t.b, t.c), v = sub(p, q), d = Math.hypot(v[0], v[1], v[2]);
        if (d > reach || (best && d >= best.d)) continue;
        const n = normals[i]!, s = dot(v, n);
        best = { d, signed: d < 1e-6 ? 0 : Math.sign(s) * d, normal: n, tri: t };
      }
      return best;
    },
    ray(o, dir, max, skip) {
      const d = unit(dir); let best: { t: number; p: V3; normal: V3; tri: SurfaceTri | null } | null = null;
      // walk the cells the ray passes (step half a cell; candidate sets are small)
      const seen = new Set<number>();
      for (let s = 0; s <= max + CELL; s += CELL / 2) {
        const x = o[0] + d[0] * Math.min(s, max), z = o[2] + d[2] * Math.min(s, max);
        for (const i of near(x, z, CELL / 2)) {
          if (seen.has(i)) continue; seen.add(i);
          const t = tris[i]!; if (skip?.(t)) continue;
          // Moller-Trumbore, both faces
          const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a), pv = cross(d, e2), det = dot(e1, pv);
          if (Math.abs(det) < 1e-9) continue;
          const inv = 1 / det, tv = sub(o, t.a), u = dot(tv, pv) * inv; if (u < 0 || u > 1) continue;
          const qv = cross(tv, e1), v = dot(d, qv) * inv; if (v < 0 || u + v > 1) continue;
          const tt = dot(e2, qv) * inv; if (tt < 1e-4 || tt > max || (best && tt >= best.t)) continue;
          best = { t: tt, p: [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt], normal: normals[i]!, tri: t };
        }
        if (best && best.t < s - CELL) break;
      }
      if (opts.ground && d[1] < -1e-6) { // terrain under a downward ray
        for (let s = 0; s <= Math.min(max, best?.t ?? max); s += 0.1) {
          const p: V3 = [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s], g = opts.ground(p[0], p[2]);
          if (g !== null && p[1] <= g) { if (!best || s < best.t) best = { t: s, p: [p[0], g, p[2]], normal: [0, 1, 0], tri: null }; break; }
        }
      }
      return best;
    },
    prove(anchors, tol = {}, skip) {
      const gap = tol.gap ?? 0.05, embed = tol.embed ?? 0.1, reach = tol.reach ?? 1;
      const contacts: Contact[] = [], missed: Missed[] = [];
      for (const an of anchors) {
        const m = S.nearest(an.at, reach, skip);
        const g = opts.ground?.(an.at[0], an.at[2]);
        const gs = g === null || g === undefined ? null : an.at[1] - g;
        const meshOk = m && (m.signed >= 0 ? m.d <= gap : m.d <= embed);
        const groundOk = gs !== null && gs <= gap && gs >= -embed;
        if (meshOk) contacts.push({ id: an.id, what: an.what, at: an.at, d: m!.d, signed: m!.signed, owner: m!.tri.owner, on: "mesh" });
        else if (groundOk) contacts.push({ id: an.id, what: an.what, at: an.at, d: Math.abs(gs!), signed: gs!, on: "ground" });
        else {
          const d = m ? m.d : gs !== null ? Math.abs(gs) : null;
          missed.push({ id: an.id, what: an.what, at: an.at, d, why: m ? (m.signed >= 0 ? `${m.d.toFixed(3)} m short of the nearest surface` : `${m.d.toFixed(3)} m inside it`) : gs !== null ? `${Math.abs(gs).toFixed(3)} m ${gs > 0 ? "above" : "under"} the ground` : `no surface within ${reach} m` });
        }
      }
      return { ok: missed.length === 0, contacts, missed };
    },
  };
  return S;
}

/** an entity's local point -> world, through a column-major 4x4 */
export function applyM4(m: number[], p: V3): V3 {
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
}
