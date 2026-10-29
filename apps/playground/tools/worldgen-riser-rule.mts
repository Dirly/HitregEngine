/**
 * BANK OR WALL, PER RISER (s1g, 2026-10-29). Derek: "why does every town have a retaining wall? we dont need that for
 * everything." and "our retaining walls need a bit more gradual". A town shelf's downhill riser is a graded earth bank
 * with ground cover by default; a built retaining wall only where the bank cannot do the job. The numbers (also in core
 * `terraceSchema.riser`'s description):
 * - bankRun 2: a bank runs 2 m per metre of drop (1 : 2, ~27 deg) — the usual limit for a planted, mowable earth bank,
 *   gentler than the 1 : 1.25 the stage used as its steepest graded voxel riser (Derek: "more gradual");
 * - tallBank 2.5: over 2.5 m of drop a 1 : 2 bank's run passes one 5 m street width (PROGRAM_RULE.street / bankRun):
 *   it takes a lot's worth of ground, so the riser is built (c);
 * - topEdge 3: a street or building within 3 m of the riser's top edge (the 2.5 m street kerb + 0.5 m) needs a wall to
 *   stand at, not a soft shoulder (b);
 * - keepHalf 9: a shelf below with nothing laid on it yet keeps at least a 9 m half-width (TERRACE_DEFAULTS.minShelf)
 *   when a bank runs onto it; a laid shelf keeps its pads, plots and streets (a);
 * - a built riser over tallBank is planned as `tiers` low walls (each <= 2.5 m) with planted `tread` m treads between
 *   them, never one sheer wall.
 *
 * DC OR KIT, PER BUILT RISER (2026-10-29, Derek: "i feel like you could do this with a DC much better", "they dont feel
 * hand made"): a built riser is a DC RISER (core `features.dcRisers`: the ground itself as planes, no seam, a crest laid
 * in short stepped runs) by default. A KIT retaining wall only where a street or a building stands closer to the top
 * edge than a DC crest holds a clean walkable edge:
 * - dcEdge 2: metres behind the top edge a DC crest may step down or drop a stone (`rough.crest` 2, the deepest of the
 *   crest and the panel joint; measured on the field by `measureDcCrest`, held by test/worldgen-riser-rule.test.ts);
 * - stand 0.5: what a street kerb or a wall foot needs beyond that edge, so a street or building within dcEdge + stand
 *   (2.5 m) of the top edge gets the kit wall's straight coping; further back (3 m is the rule's (b) reach) a DC riser.
 */
import { createWorldField, terraceWallFeatureId, type WorldField, type WorldRecipe } from "@hitreg/core";

type V2 = [number, number];
type RoadDoc = WorldRecipe["features"]["roads"][number];

export const RISER_RULE = { bankRun: 2, street: 5, tallBank: 2.5, topEdge: 3, keepHalf: 9, tierMax: 2.5, tread: 2, dcEdge: 2, stand: 0.5 } as const;

export interface RiserMeasure {
  /** `<town>-riser-<k+1>`, k = the shelf's index bottom-up */
  id: string;
  k: number;
  height: number;
  /** the bank's run: bankRun x height */
  need: number;
  /** metres of run clear below the top edge before the first thing a bank may not cover; null = clear for the whole run */
  clear: number | null;
  blocker: string | null;
  /** a street or building within topEdge of the top edge */
  top: string | null;
  /** metres from the top edge to that street's or building's edge (the closest sample); absent = not measured (kit) */
  topGap?: number | null;
}
export interface RiserVerdict extends RiserMeasure {
  kind: "bank" | "wall";
  /** a wall's build: a DC riser (the default) or a kit retaining wall (a street/building too close to its top edge) */
  face?: "dc" | "kit";
  why: string;
  /** a wall: how many low walls it is built as (1 = one wall <= tierMax), with `tread` m planted treads between */
  tiers: number;
}

/** The rule itself (pure): wall when any of (a) (b) (c) holds, else bank; `why` lists every reason that held. */
export function riserRule(m: RiserMeasure): RiserVerdict {
  const R = RISER_RULE;
  const reasons: string[] = [];
  if (m.height > R.tallBank + 1e-9) reasons.push(`(c) ${m.height.toFixed(2)} m drop, over the ${R.tallBank} m a 1 : ${R.bankRun} bank grades in one ${R.street} m street width`);
  if (m.top) reasons.push(`(b) ${m.top} within ${R.topEdge} m of its top edge`);
  if (m.clear !== null && m.clear < m.need - 1e-9) reasons.push(`(a) the bank needs ${m.need.toFixed(1)} m of run, ${m.clear.toFixed(1)} m clear before ${m.blocker ?? "something"}`);
  const tiers = Math.max(1, Math.ceil(m.height / R.tierMax - 1e-9));
  if (reasons.length) {
    // DC by default; a kit wall only where something stands on the crest a DC riser steps (or the gap was not measured)
    const need = R.dcEdge + R.stand;
    const kit = m.top !== null && (m.topGap === undefined || m.topGap === null || m.topGap < need - 1e-9);
    const how = kit
      ? `KIT wall: ${m.top} ${m.topGap === undefined || m.topGap === null ? "at" : `${m.topGap.toFixed(1)} m from`} the top edge, inside the ${need} m a DC crest needs to hold a clean walkable edge`
      : `DC riser${m.top ? ` (${m.top} ${(m.topGap ?? 0).toFixed(1)} m back, clear of the ${need} m crest)` : ""}`;
    return { ...m, kind: "wall", face: kit ? "kit" : "dc", tiers, why: `${reasons.join("; ")}${tiers > 1 ? ` -> ${tiers} low ${kit ? "walls" : "faces"} with ${R.tread} m planted treads` : ""} -> ${how}` };
  }
  return { ...m, kind: "bank", tiers: 0, why: `${m.height.toFixed(2)} m drop, its ${m.need.toFixed(1)} m bank (1 : ${R.bankRun}) fits (${m.clear === null ? "nothing in its run" : `${m.clear.toFixed(1)} m clear`}), nothing at its top edge` };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
function segDist(x: number, z: number, a: V2, b: V2): { d: number; t: number } {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
  return { d: Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t), t };
}
function distToPolyline(points: readonly (readonly [number, number])[], x: number, z: number): number {
  if (points.length === 1) return Math.hypot(x - points[0]![0], z - points[0]![1]);
  let d = Infinity;
  for (let i = 0; i + 1 < points.length; i++) d = Math.min(d, segDist(x, z, points[i] as V2, points[i + 1] as V2).d);
  return d;
}
function inPoly(poly: readonly V2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function nearestOn(line: readonly V2[], x: number, z: number): { d: number; q: V2 } {
  if (line.length === 1) return { d: Math.hypot(x - line[0]![0], z - line[0]![1]), q: line[0]! };
  let best = { d: Infinity, q: line[0]! };
  for (let i = 0; i + 1 < line.length; i++) {
    const r = segDist(x, z, line[i]!, line[i + 1]!);
    if (r.d < best.d) best = { d: r.d, q: [line[i]![0] + (line[i + 1]![0] - line[i]![0]) * r.t, line[i]![1] + (line[i + 1]![1] - line[i]![1]) * r.t] };
  }
  return best;
}
function densify(line: readonly V2[], step: number): V2[] {
  if (line.length < 2) return line.map((p) => [p[0], p[1]]);
  const out: V2[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!, b = line[i + 1]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let s = 0; s < n; s++) out.push([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]);
  }
  out.push([line[line.length - 1]![0], line[line.length - 1]![1]]);
  return out;
}

/**
 * Measure every riser of a stepped town for the rule: shelf k's DOWNHILL riser (k = 0 the lowest, to the natural
 * ground). `drops[k]` overrides the drop (the stage passes its planned levels); otherwise k >= 1 is the level
 * difference and k = 0 is measured on the ground without the town's shelves, walls and roads. What a bank may not run
 * over below the riser's top: a building pad (`<town>-pad-*`) or plot clearing, a town street or lane (ramps, stairs
 * and door paths excepted), a band's own street, the sea, and an unlaid shelf's last 9 m of half-width.
 */
export function measureTownRisers(recipe: WorldRecipe, townId: string, drops: readonly (number | undefined)[] = []): RiserMeasure[] {
  const R = RISER_RULE;
  const town = recipe.features.towns.find((t) => t.id === townId);
  if (!town) throw new Error(`no town ${townId}`);
  const shelves = town.terraces.filter((t) => !t.tags.includes("building-foundation")).sort((a, b) => a.groundY - b.groundY);
  const pads = town.terraces.filter((t) => t.tags.includes("building-foundation"));
  const plots = (recipe.features.clearings ?? []).filter((c) => c.owner === townId && /-plot-/.test(c.id) && Array.isArray((c as { polygon?: V2[] }).polygon)).map((c) => ({ id: c.id, poly: (c as { polygon: V2[] }).polygon }));
  const roadLevel = (r: RoadDoc) => (r.surfaceY?.length ? median([...r.surfaceY]) : NaN);
  const roads = recipe.features.roads.filter((r) => r.id.startsWith(`${townId}-`) && !/-(ramp|stair|door)-/.test(r.id)).map((r) => ({ id: r.id, points: r.points as V2[], half: r.width / 2, level: roadLevel(r) }));
  const lines = shelves.map((s) => (s.points.length === 1 ? [[s.points[0]![0], s.points[0]![1]] as V2] : s.points.map((p) => [p[0], p[1]] as V2)));
  // a band's own street (its `street`, before the lanes are drawn): the centreline moved `offset` to the axis's left
  const bandStreets = shelves.flatMap((t, k) => {
    if (!t.street) return [];
    const st = t.street, left: V2 = [-st.axis[1], st.axis[0]];
    return [{ id: `${t.id} street`, points: lines[k]!.map((p) => [p[0] + left[0] * st.offset, p[1] + left[1] * st.offset] as V2), half: st.width / 2, level: t.groundY }];
  });
  const laid = shelves.map((s, k) => !!s.street || pads.some((p) => Math.abs(p.groundY - s.groundY) < 0.6 && distToPolyline(lines[k]!, p.points[0]![0], p.points[0]![1]) <= s.radius + 2) || roads.some((r) => Math.abs(r.level - s.groundY) < 1 && r.points.some((p) => distToPolyline(lines[k]!, p[0], p[1]) <= s.radius)));
  let bare: WorldField | null = null;
  const bareField = (): WorldField => {
    if (bare) return bare;
    const own = new Set((recipe.features.terraceWalls ?? []).filter((w) => w.owner === townId).map((w) => terraceWallFeatureId(w.id)));
    const tw = (id: string) => [...own].some((f) => id === f || id.startsWith(`${f}-`));
    bare = createWorldField({
      ...recipe,
      features: {
        ...recipe.features,
        towns: recipe.features.towns.map((t) => (t.id === townId ? { ...t, terraces: [], flatten: 0 } : t)),
        terraceWalls: (recipe.features.terraceWalls ?? []).filter((w) => w.owner !== townId),
        heightPatches: recipe.features.heightPatches.filter((p) => !tw(p.id)),
        passages: (recipe.features.passages ?? []).filter((p) => !tw(p.id)),
        roads: recipe.features.roads.filter((r) => !r.id.startsWith(`${townId}-`)),
      },
    });
    return bare;
  };
  const blockerAt = (x: number, z: number, under: number, below: number): string | null => {
    for (const p of pads) if (p.groundY < under && distToPolyline(p.points, x, z) <= p.radius) return `building pad ${p.id.replace(`${townId}-pad-`, "")}`;
    for (const p of plots) if (inPoly(p.poly, x, z)) return `plot ${p.id}`;
    for (const r of [...roads, ...bandStreets]) if (!(r.level >= under - 0.5) && distToPolyline(r.points, x, z) <= r.half) return `street ${r.id}`;
    if (below >= 0 && !laid[below]) {
      const s = shelves[below]!;
      if (distToPolyline(lines[below]!, x, z) <= Math.min(s.radius, R.keepHalf)) return `${s.id}'s ${R.keepHalf} m half-width (an unlaid shelf)`;
    }
    return null;
  };
  const out: RiserMeasure[] = [];
  for (let k = 0; k < shelves.length; k++) {
    const sh = shelves[k]!;
    const other = k > 0 ? lines[k - 1]! : shelves.length > 1 ? lines[1]! : null;
    const samples: { p: V2; n: V2; facing: boolean }[] = [];
    for (const p of densify(lines[k]!, 2)) {
      if (!other) continue;
      const { d, q } = nearestOn(other, p[0], p[1]);
      if (d < 1e-6) continue;
      let n: V2 = [(q[0] - p[0]) / d, (q[1] - p[1]) / d];
      if (k === 0) n = [-n[0], -n[1]];
      // a sample faces the shelf below when the gap between their flats is within a bank's reach (+8 m)
      const facing = k > 0 ? d - sh.radius - shelves[k - 1]!.radius < R.bankRun * R.tallBank + 8 : true;
      samples.push({ p, n, facing });
    }
    let height = drops[k];
    if (height === undefined) {
      if (k > 0) height = sh.groundY - shelves[k - 1]!.groundY;
      else {
        const f = bareField();
        // the drop where a 1 : 2 bank off the edge meets the natural ground (its toe), by fixed point; the median sample
        const fall = samples.map(({ p, n }) => {
          let h = 1;
          for (let i = 0; i < 6; i++) { const s = sh.radius + Math.max(1, R.bankRun * h); h = Math.max(0, sh.groundY - f.height(p[0] + n[0] * s, p[1] + n[1] * s)); }
          return h;
        }).filter((v) => v > 0);
        height = fall.length ? median(fall) : 0;
      }
    }
    height = r2(height);
    const need = r2(R.bankRun * height);
    let clear: number | null = null, blocker: string | null = null, top: string | null = null, topGap: number | null = null;
    for (const { p, n, facing } of samples) {
      const e: V2 = [p[0] + n[0] * sh.radius, p[1] + n[1] * sh.radius];
      // what stands at the top edge, and how close (the gap decides DC or kit): the closest sample over the whole edge
      const near = (gap: number, what: string) => { if (topGap === null || gap < topGap) { topGap = r2(Math.max(0, gap)); top = what; } };
      for (const r of [...roads, ...bandStreets]) { const g = distToPolyline(r.points, e[0], e[1]) - r.half; if (Math.abs(r.level - sh.groundY) < 1.5 && g <= R.topEdge) near(g, `street ${r.id}`); }
      for (const pd of pads) { const g = distToPolyline(pd.points, e[0], e[1]) - pd.radius; if (Math.abs(pd.groundY - sh.groundY) < 0.6 && g <= R.topEdge) near(g, `building ${pd.id.replace(`${townId}-pad-`, "")}`); }
      for (const pl of plots) {
        if (!inPoly(pl.poly, e[0] - n[0] * R.topEdge, e[1] - n[1] * R.topEdge)) continue;
        let g = R.topEdge;
        for (let q = 0; q < R.topEdge; q += 0.25) if (inPoly(pl.poly, e[0] - n[0] * q, e[1] - n[1] * q)) { g = q; break; }
        near(g, `plot ${pl.id}`);
      }
      if (!facing) continue;
      const f = k === 0 ? bareField() : null;
      for (let s = 0.5; s <= need + 1e-9; s += 0.5) {
        const x = e[0] + n[0] * s, z = e[1] + n[1] * s;
        let hit = blockerAt(x, z, sh.groundY - 0.5, k - 1);
        if (!hit && f && f.height(x, z) < recipe.seaLevel) hit = "the sea";
        if (hit) {
          if (clear === null || s - 0.5 < clear) { clear = r2(s - 0.5); blocker = `${hit} @ ${r2(x)},${r2(z)}`; }
          break;
        }
      }
    }
    out.push({ id: `${townId}-riser-${k + 1}`, k, height, need, clear, blocker, top, topGap });
  }
  return out;
}

/**
 * MEASURED on the field: how far behind its top edge a DC riser's crest leaves the shelf (the deepest point along the
 * edge where the ground stands more than `tol` under `top`, sampled every 0.25 m). What RISER_RULE.dcEdge must cover.
 */
export function measureDcCrest(field: WorldField, riser: { points: readonly (readonly [number, number])[]; top: number }, tol = 0.1): number {
  let worst = 0;
  for (let i = 0; i + 1 < riser.points.length; i++) {
    const a = riser.points[i]!, b = riser.points[i + 1]!, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], right: V2 = [-d[1], d[0]];
    for (let s = 0; s <= len; s += 0.5) {
      // walk back from the edge onto the shelf until the ground holds at the top
      let lost = 0;
      for (let q = 0; q <= 6; q += 0.25) {
        const x = a[0] + d[0] * s - right[0] * q, z = a[1] + d[1] * s - right[1] * q;
        if (field.ground(x, z) < riser.top - tol) lost = q + 0.25;
      }
      worst = Math.max(worst, lost);
    }
  }
  return worst;
}
