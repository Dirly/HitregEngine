/**
 * WALL SEATED — does a baked `wall` operator stand on the ground along its whole length, or does daylight show under it?
 * (Reedholt 2026-10-21: the marsh-stake palisade climbed a slope with ground visible under the stakes.)
 *
 * The wall is rebuilt exactly as the bake builds it (operatorReader -> wallLandmarkParams -> compileLandmarkOperator ->
 * buildLandmarkMesh, placed at the recipe's `op:<id>:landmark` piece). Along the line, every `sample` metres, at the
 * centre and just inside both faces, a vertical ray finds the LOWEST surface of the wall's solid in that column; the
 * ground there is the lower of the field height and the drawn lattice height (the mesher draws the 2 m lattice: on a
 * convex slope the drawn ground sags under the field between samples) and the real solid under it (cuts and carves are
 * ground). `gap` = wall bottom - ground: > 0 is daylight under the wall. Columns inside a declared opening are skipped
 * (the lintel over a gate is meant to hang). Samples are pooled into SEGMENTS of <= `segment` metres; the gate fails a
 * segment whose worst gap exceeds `maxGap` (default 0.05 m).
 */
import {
  buildLandmarkMesh, compileLandmarkOperator, createWorldField, fieldSolidProbe, latticeHeight, operatorParams, wallLandmarkParams, wallParamsSchema,
  wallPlanCurve, type OperatorFieldReader, type WorldRecipe,
} from "@hitreg/core";
import { operatorReader } from "./worldgen-operators.mts";

export interface WallSeatSegment { from: number; to: number; at: [number, number]; gap: number; samples: number }
export interface WallSeatReport { id: string; length: number; samples: number; segments: WallSeatSegment[]; worst: number; worstAt: [number, number] | null; bad: number; ok: boolean; maxGap: number; digest: string; stale?: string }

/** Lowest surface of a triangle soup per vertical column (1 m XZ bins). */
export function columnBottom(pos: number[], idx: number[]): (x: number, z: number) => number | null {
  const bins = new Map<string, number[]>();
  for (let t = 0; t < idx.length / 3; t++) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let e = 0; e < 3; e++) { const v = idx[t * 3 + e]!; x0 = Math.min(x0, pos[v * 3]!); x1 = Math.max(x1, pos[v * 3]!); z0 = Math.min(z0, pos[v * 3 + 2]!); z1 = Math.max(z1, pos[v * 3 + 2]!); }
    for (let i = Math.floor(x0); i <= Math.floor(x1); i++) for (let j = Math.floor(z0); j <= Math.floor(z1); j++) {
      const k = `${i},${j}`; const b = bins.get(k); if (b) b.push(t); else bins.set(k, [t]);
    }
  }
  return (x, z) => {
    let lo: number | null = null;
    for (const t of bins.get(`${Math.floor(x)},${Math.floor(z)}`) ?? []) {
      const a = idx[t * 3]! * 3, b = idx[t * 3 + 1]! * 3, c = idx[t * 3 + 2]! * 3;
      const ax = pos[a]!, az = pos[a + 2]!, bx = pos[b]!, bz = pos[b + 2]!, cx = pos[c]!, cz = pos[c + 2]!;
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue; // vertical: no area in plan
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * pos[a + 1]! + v * pos[b + 1]! + w * pos[c + 1]!;
      if (lo === null || y < lo) lo = y;
    }
    return lo;
  };
}

/** The gate on one wall doc: built against `reader` (the ground the bake saw), measured against `ground` (the world now). */
export function wallSeatOf(id: string, params: unknown, reader: OperatorFieldReader, ground: (x: number, z: number) => number, opts: { segment?: number; sample?: number; maxGap?: number; position?: [number, number, number] } = {}): WallSeatReport {
  const segment = opts.segment ?? 4, sample = opts.sample ?? 0.5, maxGap = opts.maxGap ?? 0.05;
  const wp = wallParamsSchema.parse(params);
  const c = compileLandmarkOperator(wallLandmarkParams(params, reader, { id }), reader, { id });
  if (!c) throw new Error(`"${id}" did not compile`);
  const b = buildLandmarkMesh(c.compiled);
  const [px, py, pz] = opts.position ?? [c.at[0], c.footY ?? 0, c.at[1]];
  const pos: number[] = [], idx: number[] = [];
  for (const g of b.groups) {
    const base = pos.length / 3;
    for (let v = 0; v < g.vertexCount; v++) pos.push(g.positions[v * 3]! + px, g.positions[v * 3 + 1]! + py, g.positions[v * 3 + 2]! + pz);
    for (const i of g.indices) idx.push(i + base);
  }
  const bottom = columnBottom(pos, idx);
  const closed = wp.points.length >= 4 && Math.hypot(wp.points[0]![0] - wp.points.at(-1)![0], wp.points[0]![1] - wp.points.at(-1)![1]) < 1e-3;
  const curve = wallPlanCurve(wp.points as [number, number][], wp.smooth, closed);
  const L = curve.length, inner = Math.max(0.05, wp.thickness / 2 - 0.08);
  const inOpening = (s: number) => wp.openings.some((o) => s > o.at - o.width / 2 - 0.3 && s < o.at + o.width / 2 + 0.3);
  const nSeg = Math.max(1, Math.ceil(L / segment)), segLen = L / nSeg;
  const segments: WallSeatSegment[] = [];
  let samples = 0, worst = -Infinity, worstAt: [number, number] | null = null;
  for (let k = 0; k < nSeg; k++) {
    const from = k * segLen, to = (k + 1) * segLen;
    let gap = -Infinity, n = 0, at: [number, number] = [0, 0];
    for (let s = from + sample / 2; s < to; s += sample) {
      if (inOpening(s)) continue;
      const f = curve.at(s);
      for (const off of [-inner, 0, inner]) {
        const x = f.x - f.tz * off, z = f.z + f.tx * off;
        const yb = bottom(x, z);
        if (yb === null) continue;
        const g = yb - ground(x, z);
        n++;
        if (g > gap) { gap = g; at = [x, z]; }
      }
    }
    samples += n;
    if (!n) continue;
    segments.push({ from: Math.round(from * 10) / 10, to: Math.round(to * 10) / 10, at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10], gap: Math.round(gap * 100) / 100, samples: n });
    if (gap > worst) { worst = gap; worstAt = segments.at(-1)!.at; }
  }
  const bad = segments.filter((s) => s.gap > maxGap).length;
  return { id, length: Math.round(L * 10) / 10, samples, segments, worst: Math.round(Math.max(worst, -99) * 100) / 100, worstAt, bad, ok: bad === 0 && samples > 0, maxGap, digest: c.compiled.digest };
}

/** The visible ground of a world: the lower of the field, the drawn lattice and the real solid under it (cuts, carves). */
export function visibleWorldGround(recipe: WorldRecipe): (x: number, z: number) => number {
  const field = createWorldField(recipe), probe = fieldSolidProbe(field);
  return (x, z) => {
    const h = Math.min(field.height(x, z), latticeHeight(field, x, z));
    const solid = probe.floor(x, z, h + 2, h - 30);
    return solid === null ? h : Math.min(h, solid);
  };
}

/** The gate on an installed wall operator, rebuilt as the bake builds it, placed at its recipe landmark piece. */
export function wallSeat(recipe: WorldRecipe, opId: string, opts: { segment?: number; sample?: number; maxGap?: number; ground?: (x: number, z: number) => number } = {}): WallSeatReport {
  const doc = (recipe.features.operators ?? []).find((o) => o.id === opId) as Record<string, unknown> | undefined;
  if (!doc || doc.op !== "wall") throw new Error(`no installed wall operator "${opId}"`);
  const piece = (recipe.features.landmarks ?? []).find((l) => l.id === `op:${opId}:landmark`);
  if (!piece) throw new Error(`the recipe has no op:${opId}:landmark piece (worldgen op --apply)`);
  const r = wallSeatOf(opId, operatorParams(doc), operatorReader(recipe, opId), opts.ground ?? visibleWorldGround(recipe), { ...opts, position: piece.position as [number, number, number] });
  // the gate measures the wall as it builds NOW: a recipe naming another bake shows older geometry in the game
  if (piece.prefab !== `landmarks/${opId}-${r.digest}`) { r.stale = `the recipe names ${piece.prefab} but the wall rebuilds as landmarks/${opId}-${r.digest}: worldgen op --apply ${opId} + tools/landmark.mts`; r.ok = false; }
  return r;
}
