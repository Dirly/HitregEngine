/**
 * Water and road audit for a world recipe: the numbers that decide whether a
 * generated world is RIGHT, computed from the recipe and its field alone, so
 * an agent can check a regeneration without opening the browser.
 *
 *   - every river ends somewhere: the sea, a lake, or its parent river
 *   - every lake has the network running through it (rivers-first: a lake
 *     with no river is a bug by construction now, not a style choice)
 *   - beds only descend; an outlet leaves its lake flush with the surface
 *   - no town centre is under water
 *   - no road point is under more than a ford's depth of water, and every
 *     bridge has a road ending at each abutment
 *
 * `worldgen audit <world>` prints the whole thing; the rivers and roads
 * stages print `summary` at the end of their run.
 */

import type { WorldField, WorldRecipe } from "@hitreg/core";

type P = readonly [number, number];

function inside(poly: readonly P[], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

function segDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = dx * dx + dz * dz;
  const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

function polyDist(poly: readonly P[], p: P, closed: boolean): number {
  let best = Infinity;
  const n = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < n; i++) best = Math.min(best, segDist(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return best;
}

function bounds(poly: readonly P[]): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

export interface WaterAudit {
  /** One line per finding worth reading; empty when the world is clean. */
  problems: string[];
  /** Per-river / per-lake detail, for `worldgen audit`. */
  detail: string[];
  /** The one-line verdict the stages print. */
  summary: string;
  counts: {
    rivers: number;
    toSea: number;
    toLake: number;
    toRiver: number;
    dangling: number;
    lakes: number;
    lakesUnconnected: number;
    uphillSteps: number;
    outletsOff: number;
    townsUnderWater: number;
    roadPointsSubmerged: number;
    bridges: number;
    bridgesLoose: number;
  };
}

export function auditWorld(recipe: WorldRecipe, field: WorldField): WaterAudit {
  // the field's rivers: a hand-written river (an agent's `{ points, width }`)
  // has its bed solved there and none in the recipe
  const rivers = field.rivers;
  /**
   * A world whose rivers are all written by hand (no recipe river carries a
   * bed) is not rivers-first: its lakes came from the hydrology and its
   * rivers from an author, and a lake nobody has drawn a river to yet is the
   * author's business, not a finding.
   */
  const handWritten = recipe.features.rivers.every((r) => !r.bedY || r.bedY.length !== r.points.length);
  const lakes = recipe.features.lakes;
  const problems: string[] = [];
  const detail: string[] = [];
  const surfaceAt = (r: (typeof rivers)[number], i: number): number => {
    const depth = r.depths && r.depths.length === r.points.length ? r.depths[i]! : r.depth;
    return r.bedY![i]! + Math.max(0.4, depth * 0.7);
  };
  const lakeBounds = lakes.map((l) => (l.polygon ? bounds(l.polygon) : [l.center[0] - l.radius, l.center[1] - l.radius, l.center[0] + l.radius, l.center[1] + l.radius]));
  /**
   * The lake containing (x, z); with several (a tarn's outline overlapping the
   * shore of the lake it drops into) the one whose level is nearest
   * `surface`, so a stream falling from the tarn is judged against the tarn.
   */
  const inLake = (x: number, z: number, surface = NaN): number => {
    let best = -1;
    for (let k = 0; k < lakes.length; k++) {
      const b = lakeBounds[k]!;
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) continue;
      const l = lakes[k]!;
      if (!(l.polygon ? inside(l.polygon, x, z) : Math.hypot(x - l.center[0], z - l.center[1]) <= l.radius)) continue;
      if (best < 0 || Number.isNaN(surface)) {
        best = k;
        if (Number.isNaN(surface)) return k;
      } else if (Math.abs(l.waterY - surface) < Math.abs(lakes[best]!.waterY - surface)) best = k;
    }
    return best;
  };

  let toSea = 0;
  let toLake = 0;
  let toRiver = 0;
  let dangling = 0;
  let uphillSteps = 0;
  let outletsOff = 0;
  const inlets = new Array<number>(lakes.length).fill(0);
  const outlets = new Array<number>(lakes.length).fill(0);
  const through = new Array<number>(lakes.length).fill(0);
  for (const r of rivers) {
    if (!r.bedY || r.bedY.length !== r.points.length) {
      problems.push(`${r.id}: no bedY`);
      continue;
    }
    // a dry reach (a steep gully between two wet ones) has no mouth to judge
    if (!r.water) {
      for (let i = 0; i + 1 < r.bedY.length; i++) if (r.bedY[i + 1]! > r.bedY[i]! + 1e-6) uphillSteps++;
      // a gully running into the sea is a mouth too — a dry wash on a steep
      // coast, which reads better than a water sheet tilted into the surf
      const end = r.points[r.points.length - 1]!;
      if (field.naturalHeight(end[0], end[1]) < recipe.seaLevel) toSea++;
      detail.push(`${r.id.padEnd(10)} gully      width ${r.width.toFixed(1).padStart(5)}`);
      continue;
    }
    for (let i = 0; i + 1 < r.bedY.length; i++) if (r.bedY[i + 1]! > r.bedY[i]! + 1e-6) uphillSteps++;
    const last = r.points[r.points.length - 1]!;
    const first = r.points[0]!;
    const lastLake = inLake(last[0], last[1], surfaceAt(r, r.points.length - 1));
    const firstLake = inLake(first[0], first[1], surfaceAt(r, 0));
    // sampled along every segment, not just at the control points: a
    // simplified polyline can cross a small lake between two of them
    const touched = new Set<number>();
    for (let i = 0; i < r.points.length; i++) {
      const p = r.points[i]!;
      const q = r.points[Math.min(i + 1, r.points.length - 1)]!;
      const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 8));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const x = p[0] + (q[0] - p[0]) * t;
        const z = p[1] + (q[1] - p[1]) * t;
        const k = inLake(x, z);
        if (k >= 0) touched.add(k);
        else {
          // or within a bank of the shore: the outline is refined onto the
          // terrain and the channel swung by its meander, and a river running
          // along the waterline is a river the lake has
          for (let j = 0; j < lakes.length; j++) {
            const b = lakeBounds[j]!;
            const l = lakes[j]!;
            if (x < b[0] - l.bank || x > b[2] + l.bank || z < b[1] - l.bank || z > b[3] + l.bank || !l.polygon) continue;
            if (polyDist(l.polygon, [x, z], true) <= l.bank) touched.add(j);
          }
        }
      }
    }
    for (const k of touched) if (k !== lastLake && k !== firstLake) through[k]!++;
    if (firstLake >= 0) {
      outlets[firstLake]!++;
      const s = surfaceAt(r, 0);
      const l = lakes[firstLake]!;
      if (Math.abs(s - l.waterY) > 0.5) {
        outletsOff++;
        problems.push(`${r.id} leaves ${l.id} at ${s.toFixed(1)} m, lake at ${l.waterY} m`);
      }
    }
    let kind: string;
    let note = "";
    const surface = surfaceAt(r, r.points.length - 1);
    if (field.naturalHeight(last[0], last[1]) < recipe.seaLevel) {
      kind = "sea";
      toSea++;
    } else if (lastLake >= 0) {
      kind = "lake";
      toLake++;
      inlets[lastLake]!++;
      const l = lakes[lastLake]!;
      note = `${l.id} surface ${surface.toFixed(1)} vs ${l.waterY}`;
      if (surface > l.waterY + 0.8 || surface < l.waterY - 1.5) problems.push(`${r.id} arrives in ${l.id} at ${surface.toFixed(1)} m, lake at ${l.waterY} m`);
    } else {
      let nearRiver = Infinity;
      let nearId = "";
      let nearSurface = NaN;
      for (const o of rivers) {
        if (o === r || !o.bedY) continue;
        const d = polyDist(o.points, last, false);
        if (d < nearRiver) {
          nearRiver = d;
          nearId = o.id;
          // the surface at the nearest point ON the polyline, interpolated
          // along its segment: the nearest control point can be fifty metres
          // up a steep reach
          let bs = 0;
          let bt = 0;
          let bd = Infinity;
          for (let i = 0; i + 1 < o.points.length; i++) {
            const a = o.points[i]!;
            const b = o.points[i + 1]!;
            const dx = b[0] - a[0];
            const dz = b[1] - a[1];
            const l = dx * dx + dz * dz;
            const t = l < 1e-9 ? 0 : Math.max(0, Math.min(1, ((last[0] - a[0]) * dx + (last[1] - a[1]) * dz) / l));
            const dd = Math.hypot(last[0] - (a[0] + dx * t), last[1] - (a[1] + dz * t));
            if (dd < bd) {
              bd = dd;
              bs = i;
              bt = t;
            }
          }
          nearSurface = surfaceAt(o, bs) + (surfaceAt(o, Math.min(bs + 1, o.points.length - 1)) - surfaceAt(o, bs)) * bt;
        }
      }
      if (nearRiver < 12) {
        kind = "confluence";
        toRiver++;
        note = `${nearId} @${nearRiver.toFixed(0)} m, surface ${surface.toFixed(1)} vs ${nearSurface.toFixed(1)}`;
        if (surface > nearSurface + 0.6) problems.push(`${r.id} joins ${nearId} ${(surface - nearSurface).toFixed(1)} m above its surface`);
      } else {
        kind = "DANGLING";
        dangling++;
        note = `ends ${nearRiver.toFixed(0)} m from ${nearId}, ground ${field.height(last[0], last[1]).toFixed(1)}`;
        problems.push(`${r.id} dangles: ${note}`);
      }
    }
    detail.push(`${r.id.padEnd(10)} ${kind.padEnd(10)} width ${r.width.toFixed(1).padStart(5)}  ${note}${firstLake >= 0 ? `  [out of ${lakes[firstLake]!.id}]` : ""}`);
  }

  let lakesUnconnected = 0;
  lakes.forEach((l, k) => {
    let n = inlets[k]! + outlets[k]! + through[k]!;
    // a lagoon: the outline reaches the sea, so it drains straight into it
    if (n === 0 && l.polygon && l.polygon.some(([x, z]) => field.naturalHeight(x, z) < recipe.seaLevel + 1)) n = 1;
    // or it touches another lake: one basin spilling straight into the next
    if (n === 0 && l.polygon) {
      for (let j = 0; j < lakes.length && n === 0; j++) {
        const o = lakes[j]!;
        if (j === k || !o.polygon) continue;
        if (l.polygon.some(([x, z]) => polyDist(o.polygon!, [x, z], true) <= l.bank + o.bank)) n = 1;
      }
    }
    if (n === 0) {
      lakesUnconnected++;
      const note = `${l.id} at [${l.center[0]}, ${l.center[1]}] (~${Math.round(l.radius)} m) has no river`;
      if (handWritten) detail.push(`  (${note} — a hand-written world; draw one or leave it)`);
      else problems.push(note);
    }
    detail.push(`${l.id.padEnd(10)} y ${String(l.waterY).padStart(7)}  r ${Math.round(l.radius).toString().padStart(4)}  in ${inlets[k]} out ${outlets[k]} through ${through[k]}`);
  });

  let townsUnderWater = 0;
  for (const t of recipe.features.towns) {
    const w = field.waterY(t.center[0], t.center[1]);
    const g = t.groundY ?? field.height(t.center[0], t.center[1]);
    if (w !== null && g < w) {
      townsUnderWater++;
      problems.push(`${t.id} at [${t.center[0]}, ${t.center[1]}] ground ${g.toFixed(1)} under water at ${w.toFixed(1)} — re-run towns`);
    }
  }

  let roadPointsSubmerged = 0;
  const submerged: string[] = [];
  for (const road of recipe.features.roads) {
    const ys = road.surfaceY ?? [];
    road.points.forEach((p, i) => {
      const w = field.waterY(p[0], p[1]);
      const y = ys[i] ?? field.height(p[0], p[1]);
      if (w !== null && y < w - 0.6) {
        roadPointsSubmerged++;
        if (submerged.length < 12) submerged.push(`${road.id}[${i}] at [${p[0]}, ${p[1]}] ${(w - y).toFixed(1)} m under`);
      }
    });
  }
  for (const line of submerged) problems.push(`road under water: ${line}`);
  if (roadPointsSubmerged > 0) problems.push(`${roadPointsSubmerged} road points under more than a ford's depth of water`);

  const bridges = recipe.features.bridges;
  let bridgesLoose = 0;
  for (const b of bridges) {
    for (const end of b.points) {
      const near = recipe.features.roads.some((road) => {
        const a = road.points[0]!;
        const z = road.points[road.points.length - 1]!;
        return Math.hypot(a[0] - end[0], a[1] - end[1]) < 2 || Math.hypot(z[0] - end[0], z[1] - end[1]) < 2;
      });
      if (!near) {
        bridgesLoose++;
        problems.push(`${b.id}: no road ends at abutment [${end[0]}, ${end[1]}]`);
      }
    }
  }

  const counts = {
    rivers: rivers.length,
    toSea,
    toLake,
    toRiver,
    dangling,
    lakes: lakes.length,
    lakesUnconnected,
    uphillSteps,
    outletsOff,
    townsUnderWater,
    roadPointsSubmerged,
    bridges: bridges.length,
    bridgesLoose,
  };
  const wetCount = rivers.filter((r) => r.water).length;
  const summary =
    `audit: ${wetCount} wet reaches + ${rivers.length - wetCount} dry gullies (${toSea} to sea, ${toLake} into lakes, ${toRiver} into rivers, ${dangling} dangling), ` +
    `${lakes.length} lakes (${lakesUnconnected} without a river), ${uphillSteps} uphill bed steps, ${outletsOff} outlets off level, ` +
    `${townsUnderWater} towns under water, ${roadPointsSubmerged} road points submerged, ${bridges.length} bridges (${bridgesLoose} loose ends)`;
  return { problems, detail, summary, counts };
}
