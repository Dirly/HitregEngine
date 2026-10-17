/**
 * The stone landing plinth half of `worldgen bridge-place` (`--kind plinth`, and rope ends `--seat-a|b plinth`).
 *
 * Derek's standing rule for rope spans: STRAIGHT in plan, NEAR-LEVEL, anchored at TOPS — never a stair tower or a
 * switchback to meet a deck. Where two ends differ a lot in height the LOW end is raised: a short coursed tower stub
 * (world-kit bridges plinth.mts) on the stack top or the low ground, rising to the deck, with parapet gaps where the
 * ropes land, a doorway at its foot and a stair inside up to a roof hatch.
 *
 * A plinth is its own bridge span (kind plinth): `a` = centre and deck height, `toward` = the far ends of the ropes
 * it carries. The fit:
 *   - base = the highest rock under the footprint (the floor inside stands on it everywhere), walls buried 1.5 m;
 *   - orientation: the yaw that puts every rope entry square through a wall (entries on one wall or two adjacent
 *     walls, each within 1 m of the wall's middle), so the roof hatch (the last two flights' strips) keeps clear;
 *   - the door: on the wall the stair has to start from, and it must open onto rock (checked; the next orientation
 *     is tried otherwise).
 */
import type { WorldField } from "@hitreg/core";

type V2 = [number, number];
type V3 = [number, number, number];
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface PlinthModule {
  PLINTH: { half: number; wall: number; flightW: number; grade: number; roof: number; bury: number; minH: number; maxH: number };
  plinthStair(spec: { half: number; wall: number; height: number; door: number }): { hi: number; fw: number; flights: number; lastWall: number; stations: V3[] };
  plinthNormal(k: number): V3;
  plinthTangent(k: number): V3;
}

export interface PlinthFit {
  spec: { style: "gnawspur" | "coastal"; half: number; wall: number; height: number; bury: number; door: number; gaps: { wall: number; at: number; width: number }[] };
  yaw: number;
  roof: V3;
  base: number;
  door: V3;
  stair: V3[];
  warnings: string[];
}

/** World <-> plinth frame (three's yaw about +Y: local +X -> (cos, -sin), local +Z -> (sin, cos)). */
export function plinthFrame(yawDeg: number) {
  const th = (yawDeg * Math.PI) / 180;
  const ex: V2 = [Math.cos(th), -Math.sin(th)], ez: V2 = [Math.sin(th), Math.cos(th)];
  return { ex, ez, toWorld: (o: V3, p: V3): V3 => [r3(o[0] + ex[0] * p[0] + ez[0] * p[2]), r3(o[1] + p[1]), r3(o[2] + ex[1] * p[0] + ez[1] * p[2])] };
}

export function fitPlinth(
  field: WorldField,
  P: PlinthModule,
  opts: { at: V2; deckY: number; toward: V2[]; style: "gnawspur" | "coastal" },
  ground: (x: number, z: number, from: number) => number,
): PlinthFit {
  const { half, wall, bury, minH, maxH } = P.PLINTH;
  const roofY = opts.deckY - 0.1;
  const g = (x: number, z: number) => ground(x, z, roofY + 40);
  const warnings: string[] = [];
  // the rock under the footprint
  let hiRock = -Infinity, loRock = Infinity;
  for (let a = -half; a <= half + 1e-6; a += 0.5) for (let b = -half; b <= half + 1e-6; b += 0.5) {
    const y = g(opts.at[0] + a, opts.at[1] + b);
    hiRock = Math.max(hiRock, y); loRock = Math.min(loRock, y);
  }
  const base = r3(hiRock);
  const height = r3(roofY - base);
  if (height < minH || height > maxH) throw new Error(`plinth: ${height.toFixed(1)} m tall (roof ${roofY.toFixed(2)} over rock ${base.toFixed(2)}) is outside ${minH}..${maxH} m`);
  if (loRock < base - bury + 0.2) warnings.push(`the rock under the footprint falls ${r3(base - loRock)} m: the walls (buried ${bury} m) stand over a ${r3(base - bury - loRock)} m drop at a corner`);
  const dirs = opts.toward.map((t) => { const d = Math.hypot(t[0] - opts.at[0], t[1] - opts.at[1]) || 1; return [(t[0] - opts.at[0]) / d, (t[1] - opts.at[1]) / d] as V2; });
  // candidate orientations, best first
  const cands: { yaw: number; score: number; gaps: { wall: number; at: number; width: number }[]; walls: number[] }[] = [];
  for (let yaw = 0; yaw < 90; yaw += 1) {
    const { ex, ez } = plinthFrame(yaw);
    const gaps: { wall: number; at: number; width: number }[] = [];
    let ok = true, score = 0;
    for (const d of dirs) {
      const a = Math.atan2(d[0] * ez[0] + d[1] * ez[1], d[0] * ex[0] + d[1] * ex[1]);
      const w = ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4;
      const off = a - Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
      const at = (half - 0.6) * Math.tan(off);
      if (Math.abs(at) > 1.0) { ok = false; break; }
      gaps.push({ wall: w, at: r3(at), width: 2.6 });
      score += Math.abs(at);
    }
    if (!ok) continue;
    const walls = [...new Set(gaps.map((x) => x.wall))].sort();
    if (gaps.length !== walls.length) continue; // two ropes through one wall: no
    if (walls.length === 2 && ((walls[1]! - walls[0]!) % 4 !== 1 && (walls[0]! - walls[1]! + 4) % 4 !== 1)) continue;
    if (walls.length > 2) continue;
    cands.push({ yaw, score, gaps, walls });
  }
  cands.sort((a, b) => a.score - b.score);
  if (!cands.length) throw new Error("plinth: no orientation lands every rope square through a wall (at most two ropes, on adjacent walls)");
  for (const c of cands) {
    const { ex, ez, toWorld } = plinthFrame(c.yaw);
    const E = c.walls;
    // hatch walls f and f - 1: neither may carry a rope
    const fs: number[] = [];
    for (let f = 0; f < 4; f++) if (!E.includes(f) && !E.includes((f + 3) % 4)) fs.push(f);
    for (const f of fs) {
      const flights = P.plinthStair({ half, wall, height, door: 0 }).flights;
      const door = (((f - (flights - 1)) % 4) + 4) % 4;
      const n = P.plinthNormal(door), t = P.plinthTangent(door);
      const hi = half - wall, fw = P.PLINTH.flightW;
      const doorS = -(hi - fw / 2);
      const outLocal: V3 = [n[0] * (half + 1.2) + t[0] * doorS, -height, n[2] * (half + 1.2) + t[2] * doorS];
      const roof: V3 = [opts.at[0], roofY, opts.at[1]];
      const doorW = toWorld(roof, outLocal);
      const gd = g(doorW[0], doorW[2]);
      if (gd < base - 0.6 || gd > base + 0.35) continue;
      const stair = P.plinthStair({ half, wall, height, door }).stations.map((s) => toWorld(roof, s));
      void ex; void ez;
      return {
        spec: { style: opts.style, half, wall, height, bury, door, gaps: c.gaps }, yaw: c.yaw, roof, base, door: [doorW[0], r3(gd), doorW[2]], stair,
        warnings: [...warnings, ...(c.score > 0.5 ? [`rope entries off the wall middles by up to ${r3(Math.max(...c.gaps.map((x) => Math.abs(x.at))))} m`] : [])],
      };
    }
  }
  throw new Error("plinth: no orientation puts the doorway onto rock (the stack top is too small round the tower: a smaller or a taller plinth, or move it)");
}
