/**
 * `worldgen terrace <world> --from-plan <design.json>`: cut the ground to an APPROVED town design (2026-10-29).
 *
 * The design (tools/town-design-schema.mts) is the truth; nothing is re-planned or re-fitted here:
 *   - ONE height patch `town-plan-<town>` (raster, masked, calm) holds every designed terrace at its level, every bank
 *     at 1 : 2 (the riser rule's planted bank: a terrace's cone [level - d/2, level + d/2] at d metres out, the cones
 *     intersected, the natural ground clamped into them), and every stair / ramp cut through a bank as its own graded
 *     corridor;
 *   - a retaining wall (`features.terraceWalls` `<town>-plan-<terrace>`, tags town-riser + town-plan, owner = the town)
 *     on every WALL edge, its stairs / ramps as the wall's inserts; a STEPPED edge as 2-3 low walls with 2 m tread
 *     platforms between them; all solved bottom-up with the terrace-wall fitter (`solveTerraceChain`);
 *   - the streets as painted town roads `<town>-street-<id>` at their designed levels and the cut stairs / ramps as
 *     `<town>-ramp-<id>` / `<town>-stair-<id>` (flatten 0: the patch already shaped the ground; they paint and route);
 *   - the town's first gate moved to the design's gate;
 *   - the town's `terraces` as flatten-0 records of the platforms (tag `plan`) so the town tools (program-fit, walk
 *     grid, riser measure) see the shelves, `flatten` 0, the radius grown to hold them.
 * It refuses a design that is a `draft` (approve the plan picture first) or that fails `town-design check`, then
 * MEASURES the built ground: each platform must be level (within 0.3 m) over 90 % of its area 1 m in from its edges.
 */
import fs from "node:fs";
import path from "node:path";
import { createWorldField, terraceWallSchema, type HeightPatchDoc, type TerraceDoc, type TerraceWallDoc, type WorldRecipe } from "@hitreg/core";
import { recipeInverse, removeTerrace, solveTerraceChain, terraceGates, townWallStyle, type TerraceFit, type TerraceKit } from "./worldgen-terrace-walls.mts";
import { checkDesign, densify, footprintOf, inPoly, lineDist, polyEdgeDist, polyEdges, r2, siteFall, type DesignReport, type Envelopes, type ResolvedEdge, type V2 } from "./town-design-check.mts";
import { DESIGN_RULE, townDesignSchema, type DesignTerrace, type TownDesign } from "./town-design-schema.mts";
import { programFromPlan } from "./worldgen-town-program.mts";

type RoadDoc = WorldRecipe["features"]["roads"][number];

export const planPatchId = (town: string): string => `town-plan-${town}`;
const isPlanRoad = (town: string, id: string): boolean => id.startsWith(`${town}-street-`) || id.startsWith(`${town}-ramp-`) || id.startsWith(`${town}-stair-`);

/** The recipe with this town's earthworks lifted off: the natural ground every from-plan cut is measured on. */
export function bareOfTown(recipe: WorldRecipe, townId: string): WorldRecipe {
  const bare = structuredClone(recipe);
  for (const t of [...(bare.features.terraceWalls ?? [])]) if (t.owner === townId && t.tags.includes("town-riser")) removeTerrace(bare, t.id);
  bare.features.heightPatches = bare.features.heightPatches.filter((p) => p.id !== planPatchId(townId));
  bare.features.roads = bare.features.roads.filter((r) => !isPlanRoad(townId, r.id));
  bare.features.towns = bare.features.towns.map((t) => (t.id === townId ? { ...t, flatten: 0, terraces: [] } : t));
  return bare;
}

/** One kit tier height for a wall edge: a stepped edge's tiers (each <= tierMax), else the whole drop. */
export function tierHeight(e: Pick<ResolvedEdge, "drop" | "tiers" | "treatment">): number {
  const want = e.treatment === "stepped" ? e.drop / e.tiers : e.drop;
  const pool = e.treatment === "stepped" ? DESIGN_RULE.kitHeights.filter((v) => v <= DESIGN_RULE.tierMax + 1e-9) : DESIGN_RULE.kitHeights;
  return [...pool].sort((p, q) => Math.abs(p - want) - Math.abs(q - want))[0]!;
}
/** Where a wall edge's foot is levelled: the lower terrace it stands over, else its level less its kit tiers. */
export function footLevel(design: TownDesign, e: ResolvedEdge): number {
  const lower = design.terraces.find((t) => t.id === e.outside);
  const t = design.terraces.find((x) => x.id === e.terrace)!;
  return lower ? lower.level : r2(t.level - Math.max(1, e.tiers) * tierHeight(e));
}

/** A tread platform of a stepped edge (k = 1 is the highest, against the upper terrace's wall). */
export interface Tread { id: string; terrace: string; edge: number; k: number; level: number; polygon: V2[] }
export function treadsOf(design: TownDesign, edges: readonly ResolvedEdge[]): Tread[] {
  const out: Tread[] = [];
  for (const e of edges) {
    if (e.treatment !== "stepped" || e.kind !== "drop") continue;
    const t = design.terraces.find((x) => x.id === e.terrace)!;
    const n = e.tiers;
    // each tier a kit height near drop / n, none over tierMax
    const h = tierHeight(e);
    for (let k = 1; k < n; k++) {
      const o0 = (k - 1) * DESIGN_RULE.tread, o1 = k * DESIGN_RULE.tread;
      const dir: V2 = [(e.b[0] - e.a[0]) / (Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) || 1), (e.b[1] - e.a[1]) / (Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) || 1)];
      // 2 m past each end of the edge: the fitter's stepped ends and corner pieces stand there
      const A: V2 = [e.a[0] - dir[0] * 2, e.a[1] - dir[1] * 2], Bp: V2 = [e.b[0] + dir[0] * 2, e.b[1] + dir[1] * 2];
      const off = (p: V2, o: number): V2 => [r2(p[0] + e.normal[0] * o), r2(p[1] + e.normal[1] * o)];
      out.push({ id: `${t.id}-tread-${e.edge}-${k}`, terrace: t.id, edge: e.edge, k, level: r2(t.level - k * h), polygon: [off(A, o0), off(Bp, o0), off(Bp, o1), off(A, o1)] });
    }
  }
  return out;
}

/** The gap between a wall edge and the lower terrace it stands over, as a platform at that terrace's level (past any treads). */
export function footStrips(design: TownDesign, edges: readonly ResolvedEdge[]): { id: string; level: number; polygon: V2[]; wallEdge: (i: number) => boolean }[] {
  const out: { id: string; level: number; polygon: V2[]; wallEdge: (i: number) => boolean }[] = [];
  for (const e of edges) {
    if (e.kind !== "drop" || (e.treatment !== "wall" && e.treatment !== "stepped") || e.outside === "sea") continue;
    const lower = design.terraces.find((t) => t.id === e.outside);
    if (lower && (e.gap === null || e.gap < 0.3)) continue;
    // over the natural ground the fitter's single height cannot follow a foot that falls along the run: the foot is
    // levelled here at the kit height below (4.5 m: the fitter's foot strip), and the patch banks it back into the hill
    const o0 = e.treatment === "stepped" ? (e.tiers - 1) * DESIGN_RULE.tread : 0;
    const o1 = lower ? e.gap! + 0.5 : o0 + 4.5;
    if (o1 <= o0 + 0.2) continue;
    const dir: V2 = [(e.b[0] - e.a[0]) / (Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) || 1), (e.b[1] - e.a[1]) / (Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) || 1)];
    const ext = lower ? 0 : 3;
    const A: V2 = [e.a[0] - dir[0] * ext, e.a[1] - dir[1] * ext], Bp: V2 = [e.b[0] + dir[0] * ext, e.b[1] + dir[1] * ext];
    const off = (p: V2, o: number): V2 => [r2(p[0] + e.normal[0] * o), r2(p[1] + e.normal[1] * o)];
    out.push({ id: `${e.terrace}-foot-${e.edge}`, level: footLevel(design, e), polygon: [off(A, o0), off(Bp, o0), off(Bp, o1), off(A, o1)], wallEdge: () => false });
  }
  return out;
}

export interface EarthworkPlan {
  patch: HeightPatchDoc;
  walls: TerraceWallDoc[];
  roads: RoadDoc[];
  terraces: TerraceDoc[];
  treads: Tread[];
  report: DesignReport;
  radius: number;
}

/**
 * Everything the cut writes, from the design and the natural ground (pure apart from `height`). `spacing` is the
 * raster's sample step (1 m; 2 m for a town over 1 km across).
 */
export function planEarthworks(design: TownDesign, site: { height: (x: number, z: number) => number; sea: number }, envelopes: Envelopes = {}, opts: { tier?: string; tags?: string[]; centre?: V2; spacing?: number } = {}): EarthworkPlan {
  const fall = siteFall(site.height, opts.centre ?? design.gate.at, 60);
  const report = checkDesign(design, { ...site, ...fall }, envelopes);
  const edges = report.edges;
  const treads = treadsOf(design, edges);
  // the shapes the raster holds: designed terraces + tread platforms
  interface Shape { id: string; level: number; polygon: V2[]; wallEdge: (i: number) => boolean }
  const wallSet = new Set(edges.filter((e) => e.kind === "drop" && (e.treatment === "wall" || e.treatment === "stepped")).map((e) => `${e.terrace}#${e.edge}`));
  const shapes: Shape[] = [
    ...design.terraces.map((t) => ({ id: t.id, level: t.level, polygon: t.polygon as V2[], wallEdge: (i: number) => wallSet.has(`${t.id}#${i}`) })),
    // a tread's outer edge (index 2: o1 side, b -> a) is its wall
    ...treads.map((t) => ({ id: t.id, level: t.level, polygon: t.polygon, wallEdge: (i: number) => i === 2 })),
    // a wall standing over a lower terrace across a gap: the gap is levelled at the lower terrace (the wall's foot), so
    // the face stands its whole drop and no cut bank of the shelf below climbs into it (hill lab 10-29: lips 3.5 m)
    ...footStrips(design, edges),
  ];
  // connections through a wall are the wall's inserts; the rest are cut corridors
  const throughWall = (c: TownDesign["connections"][number]): ResolvedEdge | undefined =>
    edges.find((e) => e.terrace === c.to && (e.treatment === "wall" || e.treatment === "stepped") && densify(c.points, 0.5).some((p) => lineDist([e.a, e.b], p[0], p[1]).d < 1));
  const levelOf = (idv: string): number => (idv === "gate" ? site.height(design.gate.at[0], design.gate.at[1]) : design.terraces.find((t) => t.id === idv)!.level);
  const corridors = design.connections.filter((c) => !throughWall(c)).map((c) => ({ c, lo: levelOf(c.from), hi: levelOf(c.to), len: Math.max(0.01, densify(c.points, 1).length - 1) }));
  const corridorLen = corridors.map((k) => { let s = 0; for (let i = 0; i + 1 < k.c.points.length; i++) s += Math.hypot(k.c.points[i + 1]![0] - k.c.points[i]![0], k.c.points[i + 1]![1] - k.c.points[i]![1]); return s || 0.01; });

  // ---- the raster box: every shape + its bank run + margin
  const maxBank = Math.max(4, ...edges.map((e) => Math.abs(e.drop) * DESIGN_RULE.bankRun));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of shapes) for (const p of s.polygon) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  for (const k of corridors) for (const p of k.c.points) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  const margin = maxBank + 6;
  let sp = opts.spacing ?? 1;
  x0 = Math.floor(x0 - margin); z0 = Math.floor(z0 - margin); x1 = Math.ceil(x1 + margin); z1 = Math.ceil(z1 + margin);
  while ((x1 - x0) / sp + 1 > 1025 || (z1 - z0) / sp + 1 > 1025) sp *= 2;
  const columns = Math.floor((x1 - x0) / sp) + 1, rows = Math.floor((z1 - z0) / sp) + 1;
  const heights = new Array<number>(columns * rows);
  const weights = new Array<number>(columns * rows);
  const slope = 1 / DESIGN_RULE.bankRun;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const x = x0 + i * sp, z = z0 + j * sp;
      const nat = site.height(x, z);
      let fixed: number | null = null;
      let fixedLevel = -Infinity;
      for (const s of shapes) if (inPoly(s.polygon, x, z) && s.level > fixedLevel) { fixed = s.level; fixedLevel = s.level; }
      if (fixed === null)
        for (const [ci, k] of corridors.entries()) {
          const r = lineDist(k.c.points, x, z);
          if (r.d <= k.c.width / 2) { fixed = k.lo + (k.hi - k.lo) * Math.min(1, r.s / corridorLen[ci]!); break; }
        }
      let h: number;
      if (fixed !== null) h = fixed;
      else {
        let lo = -Infinity, hi = Infinity, nearest = Infinity, nearestH = nat;
        const cone = (v: number, d: number) => {
          const a = v - d * slope, b = v + d * slope;
          lo = Math.max(lo, a); hi = Math.min(hi, b);
          if (d < nearest) { nearest = d; nearestH = Math.min(b, Math.max(a, nat)); }
        };
        for (const s of shapes) {
          const d = polyEdgeDist(s.polygon, x, z);
          if (d.d > maxBank + 2) continue;
          if (s.wallEdge(d.edge)) continue; // a wall edge holds its own face: no bank
          cone(s.level, d.d);
        }
        for (const [ci, k] of corridors.entries()) {
          const r = lineDist(k.c.points, x, z);
          const d = r.d - k.c.width / 2;
          if (d > maxBank + 2) continue;
          cone(k.lo + (k.hi - k.lo) * Math.min(1, r.s / corridorLen[ci]!), d);
        }
        h = lo <= hi ? Math.min(hi, Math.max(lo, nat)) : nearestH;
      }
      heights[i + j * columns] = r2(h);
      weights[i + j * columns] = fixed !== null || Math.abs(h - nat) > 0.02 ? 1 : 0;
    }
  const patch: HeightPatchDoc = {
    id: planPatchId(design.town),
    origin: [x0, z0],
    size: [(columns - 1) * sp, (rows - 1) * sp],
    columns,
    rows,
    heights,
    weights,
    blend: 2,
    calm: true,
  };

  // ---- walls: every terrace / tread with a wall edge
  const walls: TerraceWallDoc[] = [];
  const style = (t: DesignTerrace | undefined, e?: ResolvedEdge) => e?.style ?? townWallStyle({ tier: opts.tier, tags: opts.tags ?? [] });
  // ONE DOC PER RUN of consecutive wall edges over the same thing (a lower terrace, or the natural ground / sea): the
  // fitter builds one wall height per doc, so a terrace whose risers drop 3.6 m to the shelf below and 2 m to the hill
  // is two docs. Each doc's footprint is a BAND along its run (the run + the run offset 5 m inward): the band's other
  // edges are flush with the platform the patch already levelled, so their feathers change nothing (the whole polygon as
  // the footprint feathered its bank edges over the walls of the other docs: hill lab 10-29, pad clip 1.2 m).
  const kitH = (h: number) => [...DESIGN_RULE.kitHeights].sort((p, q) => Math.abs(p - h) - Math.abs(q - h))[0]!;
  for (const t of design.terraces) {
    const n = t.polygon.length;
    const isWall = (i: number) => { const e = edges.find((x) => x.terrace === t.id && x.edge === i); return !!e && e.kind === "drop" && (e.treatment === "wall" || e.treatment === "stepped"); };
    const edgeAt = (i: number) => edges.find((x) => x.terrace === t.id && x.edge === i)!;
    const key = (i: number) => `${edgeAt(i).outside}|${edgeAt(i).treatment}|${tierHeight(edgeAt(i))}`;
    const wallIdx = [...Array(n).keys()].filter(isWall);
    if (!wallIdx.length) continue;
    // runs: start where the previous edge is not a wall of the same key
    const runs: number[][] = [];
    const startOf = wallIdx.filter((i) => !(isWall((i + n - 1) % n) && key((i + n - 1) % n) === key(i)));
    if (!startOf.length) runs.push([...Array(n).keys()]); // every edge one wall over one thing: the polygon itself
    for (const s0 of startOf) {
      const run = [s0];
      for (let i = (s0 + 1) % n; isWall(i) && key(i) === key(s0) && i !== s0; i = (i + 1) % n) run.push(i);
      runs.push(run);
    }
    for (const [ri, run] of runs.entries()) {
      const closed = run.length === n && !startOf.length;
      const pathPts: V2[] = closed ? (t.polygon as V2[]) : [...run.map((i) => t.polygon[i] as V2), t.polygon[(run[run.length - 1]! + 1) % n] as V2];
      let footprint: V2[];
      let wallsIdx: number[];
      if (closed) { footprint = pathPts; wallsIdx = run; }
      else {
        // offset each vertex inward (against the outward normals of its edges), mitred and capped
        const depth = 5;
        const inner = pathPts.map((p, k) => {
          const ns = [run[k - 1], run[k]].filter((i): i is number => i !== undefined).map((i) => edgeAt(i).normal);
          const m: V2 = [ns.reduce((a, v) => a + v[0], 0) / ns.length, ns.reduce((a, v) => a + v[1], 0) / ns.length];
          const ml = Math.hypot(m[0], m[1]) || 1;
          const scale = depth / Math.max(0.5, ml);
          return [r2(p[0] - (m[0] / ml) * Math.min(scale, depth * 2)), r2(p[1] - (m[1] / ml) * Math.min(scale, depth * 2))] as V2;
        });
        footprint = [...pathPts, ...inner.reverse()];
        wallsIdx = run.map((_, k) => k);
      }
      const first = edgeAt(run[0]!);
      // a stepped run's top tier; a wall over a terrace or the levelled foot: the whole drop to it (the sea: fitted)
      const height = first.outside === "sea" ? undefined : first.treatment === "stepped" ? tierHeight(first) : kitH(t.level - footLevel(design, first));
      const inserts: TerraceWallDoc["inserts"] = [];
      for (const c of design.connections) {
        const e = throughWall(c);
        if (!e || e.terrace !== t.id || !run.includes(e.edge)) continue;
        // the insert stands where the connection crosses the edge, snapped down to the 2 m grid
        const hit = densify(c.points, 0.5).map((p) => ({ p, r: lineDist([e.a, e.b], p[0], p[1]) })).sort((p, q) => p.r.d - q.r.d)[0]!;
        inserts.push({ role: c.kind === "ramp" ? "ramp" : "stair", edge: closed ? e.edge : run.indexOf(e.edge), at: Math.max(0, Math.floor(hit.r.s / 2) * 2 - 2), run: 4 });
      }
      walls.push(terraceWallSchema.parse({
        id: `${design.town}-plan-${t.id}${runs.length > 1 ? `-${ri + 1}` : ""}`,
        owner: design.town,
        style: style(t, first),
        footprint,
        walls: wallsIdx,
        topY: t.level,
        ...(height !== undefined ? { height } : {}),
        inserts,
        feather: 4,
        tags: ["town-riser", "town-plan"],
      }));
    }
  }
  for (const tr of treads) {
    const e = edges.find((x) => x.terrace === tr.terrace && x.edge === tr.edge)!;
    const next = treads.find((x) => x.terrace === tr.terrace && x.edge === tr.edge && x.k === tr.k + 1)?.level ?? footLevel(design, e);
    walls.push(terraceWallSchema.parse({ id: `${design.town}-plan-${tr.id}`, owner: design.town, style: style(undefined, e), footprint: tr.polygon, walls: [2], topY: tr.level, height: kitH(tr.level - next), feather: 4, tags: ["town-riser", "town-plan", "tread"] }));
  }

  // ---- roads: streets (painted, at their designed level), cut stairs / ramps
  const groundAt = (x: number, z: number): number => {
    let best: number | null = null;
    for (const s of shapes) if (inPoly(s.polygon, x, z) && (best === null || s.level > best)) best = s.level;
    if (best !== null) return best;
    for (const [ci, k] of corridors.entries()) { const r = lineDist(k.c.points, x, z); if (r.d <= k.c.width / 2 + 0.5) return k.lo + (k.hi - k.lo) * Math.min(1, r.s / corridorLen[ci]!); }
    return site.height(x, z);
  };
  const roads: RoadDoc[] = [];
  for (const st of design.streets) {
    const pts = densify(st.points, 4).map((p) => [r2(p[0]), r2(p[1])] as V2);
    roads.push({ id: `${design.town}-street-${st.id}`, points: pts, width: st.width, shoulder: 0.5, smooth: 0, flatten: 0, surfaceY: pts.map((p) => r2(groundAt(p[0], p[1]))), surface: st.surface === "paving" ? "gravel" : st.surface, surfaceEdge: 1, ...(st.surface === "paving" ? { role: "paving" as const } : {}) } as RoadDoc);
  }
  for (const k of corridors) {
    const pts = densify(k.c.points, 2).map((p) => [r2(p[0]), r2(p[1])] as V2);
    roads.push({ id: `${design.town}-${k.c.kind}-${k.c.id}`, points: pts, width: k.c.width, shoulder: 0.5, smooth: 0, flatten: 0, surfaceY: pts.map((p) => r2(groundAt(p[0], p[1]))), surface: "gravel", surfaceEdge: 1 } as RoadDoc);
  }

  // ---- the town's terrace records: a covering band per platform (flatten 0: the patch shapes the ground)
  const terraces: TerraceDoc[] = design.terraces.map((t) => {
    const cx = t.polygon.reduce((s, p) => s + p[0], 0) / t.polygon.length, cz = t.polygon.reduce((s, p) => s + p[1], 0) / t.polygon.length;
    let sxx = 0, szz = 0, sxz = 0;
    for (const p of t.polygon) { sxx += (p[0] - cx) ** 2; szz += (p[1] - cz) ** 2; sxz += (p[0] - cx) * (p[1] - cz); }
    const th = 0.5 * Math.atan2(2 * sxz, sxx - szz), u: V2 = [Math.cos(th), Math.sin(th)];
    const along = t.polygon.map((p) => (p[0] - cx) * u[0] + (p[1] - cz) * u[1]);
    const across = t.polygon.map((p) => Math.abs(-(p[0] - cx) * u[1] + (p[1] - cz) * u[0]));
    const a0 = Math.min(...along), a1 = Math.max(...along);
    const down = edges.filter((e) => e.terrace === t.id && e.kind === "drop").sort((p, q) => q.drop - p.drop)[0];
    return {
      id: `${design.town}-${t.id}`,
      points: [[r2(cx + u[0] * a0), r2(cz + u[1] * a0)], [r2(cx + u[0] * a1), r2(cz + u[1] * a1)]],
      radius: r2(Math.max(1, ...across)),
      falloff: 0,
      groundY: t.level,
      flatten: 0,
      ...(down ? { riser: { kind: down.treatment === "bank" ? ("bank" as const) : ("wall" as const), height: down.drop, why: down.verdict?.why ?? `designed ${down.treatment}` } } : {}),
      tags: ["plan"],
    } as TerraceDoc;
  });
  const c = opts.centre ?? design.gate.at;
  let radius = 0;
  for (const s of shapes) for (const p of s.polygon) radius = Math.max(radius, Math.hypot(p[0] - c[0], p[1] - c[1]));
  return { patch, walls, roads, terraces, treads, report, radius: r2(radius + 2) };
}

/** Level ground achieved on each platform (share of 1 m samples 1 m in from its edges within `tol` of its level). */
export function measurePlatforms(field: { height: (x: number, z: number) => number }, design: TownDesign, tol = 0.3): { id: string; share: number; samples: number }[] {
  return design.terraces.map((t) => {
    const xs = t.polygon.map((p) => p[0]), zs = t.polygon.map((p) => p[1]);
    let n = 0, ok = 0;
    for (let z = Math.ceil(Math.min(...zs)); z <= Math.max(...zs); z++)
      for (let x = Math.ceil(Math.min(...xs)); x <= Math.max(...xs); x++) {
        if (!inPoly(t.polygon, x, z) || polyEdgeDist(t.polygon, x, z).d < 1) continue;
        n++;
        if (Math.abs(field.height(x, z) - t.level) <= tol) ok++;
      }
    return { id: t.id, share: n ? ok / n : 0, samples: n };
  });
}

/** Apply a planned earthwork to `recipe` (the town's old earthworks lifted first), the walls fitted bottom-up. */
export function applyEarthworks(recipe: WorldRecipe, design: TownDesign, plan: EarthworkPlan, kit: TerraceKit, log: (s: string) => void = () => {}): TerraceFit[] {
  const lifted = bareOfTown(recipe, design.town);
  recipe.features = lifted.features;
  recipe.features.heightPatches.push(plan.patch);
  recipe.features.roads.push(...plan.roads);
  const town = recipe.features.towns.find((t) => t.id === design.town)!;
  town.terraces = plan.terraces;
  town.flatten = 0;
  town.groundY = Math.min(...design.terraces.map((t) => t.level));
  town.radius = Math.max(town.radius, plan.radius);
  // the design's gate is the town's way in (the designer may move it to the saddle the road arrives by)
  const g0 = town.gates[0];
  town.gates = [{ id: g0?.id ?? "gate", width: g0?.width ?? 6, approach: g0?.approach ?? 30, tags: [...(g0?.tags ?? []), "plan"].filter((v, i, a) => a.indexOf(v) === i), at: [r2(design.gate.at[0]), r2(design.gate.at[1])], facing: [r2(design.gate.facing[0]), r2(design.gate.facing[1])] }, ...town.gates.slice(1)];
  const program = programFromPlan(design as never, {}, `authoring/towns/${design.name}-design.json`);
  town.program = { area: Math.max(1, program.area), lots: program.lots, across: program.across, source: program.source };
  return plan.walls.length ? solveTerraceChain(recipe, plan.walls, kit, log) : [];
}

export interface FromPlanHost {
  argv: string[];
  project: string;
  loadRecipe: () => { recipe: WorldRecipe; file: string };
  writeRecipe: (recipe: WorldRecipe, file: string) => void;
  fail: (msg: string) => never;
  loadKit: () => TerraceKit;
}

export function commandTerraceFromPlan(host: FromPlanHost, planFile: string): void {
  const { argv } = host;
  const file = path.resolve(planFile);
  if (!fs.existsSync(file)) host.fail(`terrace --from-plan: no ${planFile}`);
  const design = townDesignSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (design.status !== "approved" && !argv.includes("--unapproved")) host.fail(`terrace --from-plan: ${design.name} is a draft — the coordinator or Derek approves the plan picture first (town-design render), then status "approved" + approval { by, at }`);
  const { recipe, file: recipeFile } = host.loadRecipe();
  if (recipe.name !== design.world) host.fail(`terrace --from-plan: the design is for world ${design.world}, this is ${recipe.name}`);
  const town = recipe.features.towns.find((t) => t.id === design.town);
  if (!town) host.fail(`terrace --from-plan: no town ${design.town} in ${recipe.name}`);
  const envFile = path.join(path.dirname(file), `${design.name}-envelopes.json`);
  const envelopes: Envelopes = fs.existsSync(envFile) ? JSON.parse(fs.readFileSync(envFile, "utf8")) : {};
  const bare = createWorldField(bareOfTown(recipe, design.town));
  const plan = planEarthworks(design, { height: (x, z) => bare.heightfield(x, z), sea: recipe.seaLevel }, envelopes, { tier: town!.tier, tags: town!.tags, centre: town!.center as V2 });
  if (!plan.report.ok && !argv.includes("--force")) {
    for (const f of plan.report.faults) console.error(`  ! ${f}`);
    host.fail(`terrace --from-plan: the design fails ${plan.report.faults.length} check(s) — fix it (town-design check) before the cut; nothing written`);
  }
  console.log(`  ${design.town}: ${design.terraces.length} terraces + ${plan.treads.length} tread(s), patch ${plan.patch.id} ${plan.patch.columns}x${plan.patch.rows} at ${plan.patch.size[0] / (plan.patch.columns - 1)} m, ${plan.walls.length} wall doc(s), ${plan.roads.length} road(s)`);
  for (const e of plan.report.edges.filter((x) => x.kind === "drop")) console.log(`    ${e.terrace} edge ${e.edge}: ${e.treatment}${e.tiers > 1 ? ` x${e.tiers}` : ""}, ${e.drop} m to ${e.outside}`);
  const before = structuredClone(recipe);
  let fits: TerraceFit[] = [];
  try {
    fits = applyEarthworks(recipe, design, plan, host.loadKit(), console.log);
  } catch (e) {
    host.fail(`terrace --from-plan: a retaining wall did not fit (${(e as Error).message}) — nothing written`);
  }
  const field = createWorldField(recipe);
  let bad = 0;
  let gateFails = 0;
  for (const f of fits) {
    const s = f.doc.solved!;
    const g = terraceGates(recipe, f.doc, { field });
    console.log(`    wall ${f.doc.id}: ${s.style} ${s.height} m, pad ${s.topY} over ${s.baseY}, ${s.pieces.length} pieces${g.ok ? "" : " — GATES FAIL"}`);
    for (const w of s.warnings) console.log(`      ! ${w}`);
    if (!g.ok) { gateFails++; for (const l of g.lines) console.log(`      ${l}`); }
  }
  for (const m of measurePlatforms(field, design)) {
    const ok = m.share >= 0.9;
    if (!ok) bad++;
    console.log(`    ${ok ? "ok  " : "FAIL"} ${m.id}: ${(m.share * 100).toFixed(0)} % of ${m.samples} m2 level at its design height`);
  }
  if (bad && !argv.includes("--force")) host.fail(`terrace --from-plan: ${bad} platform(s) did not come out level — nothing written`);
  if (argv.includes("--dry-run")) { console.log("  (dry run: nothing written)"); return; }
  host.writeRecipe(recipe, recipeFile);
  const edits = recipeInverse(before, recipe);
  const inv = path.join("projects", host.project, "authoring", "terrain", "undo", `${recipe.name}.terrace-from-plan.${design.town}.inverse.json`);
  fs.mkdirSync(path.dirname(inv), { recursive: true });
  fs.writeFileSync(inv, JSON.stringify({ world: recipe.name, what: `terrace --from-plan ${design.name}`, edits }, null, 1) + "\n");
  console.log(`  cut ${design.name} from its plan; inverse: ${inv}  (worldgen op ${recipe.name} --undo <it>)`);
  if (gateFails) { process.exitCode = 1; console.log(`  ! ${gateFails} retaining wall(s) fail their gates (lips / seated / riser): worldgen terrace-place ${recipe.name} --check --id <id> --list`); }
  console.log(`  next: town-layout --project ${host.project} --from-plan ${path.relative(process.cwd(), file).replace(/\\/g, "/")}`);
}

export { footprintOf };
