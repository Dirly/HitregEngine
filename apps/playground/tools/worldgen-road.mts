/**
 * `worldgen road`: ONE carved+painted road along a drawn line, graded and painted exactly as `worldgen paths` /
 * `trails` grade theirs (the same `roadFrom`: solved profile, shoulder, embankment band, painted tread), without
 * re-routing or rebuilding any other road. For a road a stage cannot find by itself (the approach up to a landmark
 * that no town or peak names) and for replacing a hand-laid route with a real road.
 *
 *   worldgen road <world> --id road-<name> --points "x,z;x,z;..." [--width 6] [--max-grade 0.18] [--max-cut 3]
 *        [--max-fill 0.8] [--tread-cut <m>] [--tread-fill <m>]   (tread caps default to --max-cut / --max-fill) [--pin-start y] [--pin-end y] [--step 2]
 *        [--surface dirt] [--keep-landforms] [--dry-run [--out built.json]] [--inverse f.json]
 *   --keep-landforms: the road is no obstacle to buttes/sea cliffs (RoadDoc.keepLandforms) - an approach onto a
 *   monument; without it a road into a butte field drops the monument it reaches.
 *   worldgen road <world> --remove <id> [--inverse f.json]
 *   --route: the points are ANCHORS, not the line: each leg between two anchors is searched over the ground
 *   (worldgen-routing's heading-limited A* on a 4 m grid: water and `--avoid` areas are walls, steps over --hard-grade
 *   (0.6) and cross-slopes over 1.1 are walls, grade over --route-grade (0.15) costs, the line is pulled toward the
 *   anchor polyline) and rounded; the dense route is then graded as above. `--avoid f.json` = { discs: [[x,z,r]],
 *   polys: [[[x,z],..]] } (built places, a protected corridor). A leg the caps cannot route fails the command.
 *   --role road|paving|none: the zone ground role the tread paints with (RoadDoc.role). Class by traffic: a trunk
 *   `paving`, a place road the zone `road`, a footpath `none` + --surface dirt.
 *
 * The line is followed as drawn (densified every --step metres, never smoothed or re-routed). Ids must start with
 * `road-`: `path-*`, `trail-*`, `barrier-*` and `pass-*` belong to stages that rewrite them wholesale, so a road
 * filed under one of those would vanish on the next run. Re-running with the same id replaces it (idempotent).
 * The inverse is a recipe-edit batch in the operator format: `worldgen op <world> --undo <inverse>` reverts it.
 */
import fs from "node:fs";
import path from "node:path";
import { applyRecipeEdits, createWorldField, type RecipeEdit, type RoadDoc, type BridgeDoc, type WorldField, type WorldRecipe } from "@hitreg/core";
import { sideDir } from "./worldgen-operators.mts";
import { routeBetween, smoothRoute, type RouteGrid } from "./worldgen-routing.mts";

export interface RoadGradeOptions {
  width: number;
  maxGrade: number;
  maxCut: number;
  maxFill: number;
  pinStart?: number;
  pinEnd?: number;
  /** Keep a control point at least every this many metres (0 = only where the line bends or the profile moves). */
  spacing?: number;
  surface?: string;
  surfaceByBiome?: Record<string, string>;
}
export interface RoadHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
  /** Grade + paint a fixed line into road docs (worldgen.mts wires its `roadFrom`). */
  grade(id: string, points: [number, number][], field: WorldField, options: RoadGradeOptions): { roads: RoadDoc[]; bridges: BridgeDoc[] };
  /** The palette surfaces a path is painted with (worldgen.mts `pathSurfaces`). */
  surfaces?(recipe: WorldRecipe): { surface: string; surfaceByBiome?: Record<string, string> };
  /** The ground the grading reads (default: the recipe's own field). */
  field?(recipe: WorldRecipe): WorldField;
}

const STAGE_OWNED = /^(path|trail|barrier|pass)-/;
const opt = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !/^--[a-z]/.test(argv[i + 1]!) ? argv[i + 1] : undefined;
};
const num = (argv: string[], name: string): number | undefined => {
  const v = opt(argv, name);
  return v === undefined ? undefined : Number(v);
};

/** "x,z;x,z;..." -> points. */
export function parsePoints(raw: string): [number, number][] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [x, z] = s.split(",").map(Number);
      return [x!, z!] as [number, number];
    });
}

/** The drawn line resampled every `step` metres (the drawn vertices kept). */
export function densify(points: readonly (readonly [number, number])[], step: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  const last = points[points.length - 1]!;
  out.push([last[0], last[1]]);
  return out;
}

/** The edits that put `roads`/`bridges` in under `id` (dropping the last run's pieces of that id first), or with none, take it out. */
export function roadEdits(recipe: WorldRecipe, id: string, roads: RoadDoc[], bridges: BridgeDoc[]): RecipeEdit[] {
  const edits: RecipeEdit[] = [];
  // a road split at a bridge is <id>, <id>.2, ...
  const own = (fid: string): boolean => fid === id || fid.startsWith(`${id}.`);
  for (const r of recipe.features.roads) if (own(r.id)) edits.push({ edit: "remove-feature", kind: "roads", id: r.id });
  for (const b of recipe.features.bridges) if (b.id.startsWith(`bridge-${id}-`)) edits.push({ edit: "remove-feature", kind: "bridges", id: b.id });
  for (const r of roads) edits.push({ edit: "add-feature", kind: "roads", feature: r });
  for (const b of bridges) edits.push({ edit: "add-feature", kind: "bridges", feature: b });
  return edits;
}

function keep(file: string, recipe: WorldRecipe, what: string, inverse: RecipeEdit[], explicit?: string): string {
  const out = explicit ?? path.join(sideDir(file), "undo", `${recipe.name}.${what}.${new Date().toISOString().replace(/[:.]/g, "-")}.inverse.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ world: recipe.name, what, edits: inverse }, null, 1)}\n`);
  return out;
}


/** Areas a routed road must not enter (`--avoid`): discs [x, z, r] and polygons. */
export interface RouteAvoid { discs?: [number, number, number][]; polys?: [number, number][][] }
export function inAvoid(a: RouteAvoid | undefined, x: number, z: number): boolean {
  if (!a) return false;
  for (const [cx, cz, r] of a.discs ?? []) if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
  for (const poly of a.polys ?? []) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    if (c) return true;
  }
  return false;
}
export interface RouteGround { ground(x: number, z: number): number; wet(x: number, z: number): boolean }
export interface RouteAnchorOptions { step?: number; maxGrade?: number; hardGrade?: number; maxCross?: number; pad?: number; avoid?: RouteAvoid }
const segDistance = (x: number, z: number, pts: readonly (readonly [number, number])[]): number => {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1]!, [bx, bz] = pts[i]!;
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
};
/**
 * `--route`: a road through ANCHORS, each leg searched over the ground (the zone trail router's rules made a tool after
 * Hagsheer's hand-routed ribbon trails were rejected: heading-limited A*, hard grade + cross-slope walls, water and the
 * avoid areas walls, pulled toward the anchor polyline so it goes where it was drawn to go) and rounded. Returns the
 * dense line (anchors kept exactly) or the first leg no capped route joins.
 */
export function routeAnchors(anchors: readonly (readonly [number, number])[], g: RouteGround, o: RouteAnchorOptions = {}): { points: [number, number][] } | { error: string } {
  const step = o.step ?? 4, pad = o.pad ?? 90;
  const xs = anchors.map((p) => p[0]), zs = anchors.map((p) => p[1]);
  const x0 = Math.min(...xs) - pad, z0 = Math.min(...zs) - pad;
  const n = Math.max(Math.ceil((Math.max(...xs) + pad - x0) / step), Math.ceil((Math.max(...zs) + pad - z0) / step)) + 1; // RouteGrid is square
  const height = new Float32Array(n * n), cost = new Float32Array(n * n), river = new Float32Array(n * n);
  const blocked = (x: number, z: number) => g.wet(x, z) || inAvoid(o.avoid, x, z);
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const x = x0 + ix * step, z = z0 + iz * step, i = ix + iz * n;
    height[i] = g.ground(x, z);
    cost[i] = blocked(x, z) ? Infinity : 1 + Math.max(0, segDistance(x, z, anchors) - 24) / 30;
  }
  const gradX = new Float32Array(n * n), gradZ = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
    const i = ix + iz * n, h = height[i]!;
    gradX[i] = Math.max(ix > 0 ? Math.abs(h - height[i - 1]!) : 0, ix < n - 1 ? Math.abs(height[i + 1]! - h) : 0) / step;
    gradZ[i] = Math.max(iz > 0 ? Math.abs(h - height[i - n]!) : 0, iz < n - 1 ? Math.abs(height[i + n]! - h) : 0) / step;
  }
  const grid: RouteGrid = { n, step, height, cost, river, gradX, gradZ };
  const cell = (p: readonly [number, number]) => Math.round((p[0] - x0) / step) + Math.round((p[1] - z0) / step) * n;
  // an anchor may sit on a cut, a pad edge or a road end: a small disc round it is exempt from the hard caps (never an avoid area)
  const exempt = new Uint8Array(n * n);
  for (const a of anchors) {
    const c = cell(a), cx = c % n, cz = (c / n) | 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      exempt[x + z * n] = 1;
      if (!Number.isFinite(cost[x + z * n]!) && !inAvoid(o.avoid, x0 + x * step, z0 + z * step)) cost[x + z * n] = 1;
    }
  }
  const hardGrade = o.hardGrade ?? 0.6;
  const opts = {
    maxGrade: o.maxGrade ?? 0.15, gradeWeight: 14, riverToll: 60, turnWeight: 8, maxTurn: 1, hardGrade,
    maxCross: o.maxCross ?? Math.min(1.1, hardGrade * 1.6), crossWeight: 1.2, maxExpansions: 4_000_000, hardGradeExempt: exempt, exemptGrade: 1.2,
  };
  const out: [number, number][] = [[anchors[0]![0], anchors[0]![1]]];
  const fixedAt = new Set<number>([0]);
  for (let k = 1; k < anchors.length; k++) {
    const a = anchors[k - 1]!, b = anchors[k]!;
    const r = routeBetween(grid, cell(a), cell(b), opts);
    if (!r) return { error: `no capped route ${a.join(",")} -> ${b.join(",")} (hard grade ${hardGrade}; water and avoid areas are walls)` };
    for (const c of r.slice(1, -1)) out.push([x0 + (c % n) * step, z0 + ((c / n) | 0) * step]);
    fixedAt.add(out.length);
    out.push([b[0], b[1]]);
  }
  return { points: smoothRoute(out, 12, (x, z) => !blocked(x, z), (i) => fixedAt.has(i)) };
}

export function commandRoad(host: RoadHost): void {
  const { argv, fail } = host;
  const { recipe, file } = host.loadRecipe();
  const remove = opt(argv, "remove");
  const dry = argv.includes("--dry-run");
  if (remove) {
    const edits = roadEdits(recipe, remove, [], []);
    if (!edits.length) {
      console.log(`  no road ${remove} in ${recipe.name}: nothing to do`);
      return;
    }
    if (dry) {
      console.log(`  [dry-run] would remove ${edits.length} feature(s)`);
      return;
    }
    const res = applyRecipeEdits(recipe, edits);
    const inv = keep(file, recipe, `road-remove-${remove}`, res.inverse, opt(argv, "inverse"));
    host.writeRecipe(res.recipe, file);
    console.log(`  removed ${remove} (${edits.length} feature(s)); inverse: ${inv}`);
    return;
  }
  const id = opt(argv, "id") ?? fail("road: --id road-<name> (or --remove <id>)");
  if (!id.startsWith("road-") || STAGE_OWNED.test(id)) fail(`road: id "${id}" must start with road- (path-/trail-/barrier-/pass- are rewritten by their stages)`);
  const drawn = parsePoints(opt(argv, "points") ?? fail('road: --points "x,z;x,z;..."'));
  if (drawn.length < 2 || drawn.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) fail("road: --points needs at least two x,z pairs");
  // graded (and measured) on the ground WITHOUT this road's last run, so a re-run gives the same road
  const own = (fid: string): boolean => fid === id || fid.startsWith(`${id}.`);
  const ground: WorldRecipe = { ...recipe, features: { ...recipe.features, roads: recipe.features.roads.filter((r) => !own(r.id)) } };
  const field = host.field?.(ground) ?? createWorldField(ground);
  let line: [number, number][] = drawn;
  if (argv.includes("--route")) {
    const avoidFile = opt(argv, "avoid");
    const avoid = avoidFile ? (JSON.parse(fs.readFileSync(avoidFile, "utf8")) as RouteAvoid) : undefined;
    const wet = (x: number, z: number) => { const w = field.waterY(x, z); return w != null && w > field.ground(x, z) - 0.1; };
    const routed = routeAnchors(drawn, { ground: (x, z) => field.ground(x, z), wet }, {
      maxGrade: num(argv, "route-grade") ?? 0.15, hardGrade: num(argv, "hard-grade") ?? 0.6, avoid,
    });
    if ("error" in routed) fail(`road: ${id}: ${routed.error}`);
    line = routed.points;
    console.log(`  routed ${drawn.length} anchors -> ${line.length} route points`);
    const routeOut = opt(argv, "route-out");
    if (routeOut) fs.writeFileSync(routeOut, `${JSON.stringify(line)}\n`);
  }
  const points = densify(line, num(argv, "step") ?? 2);
  const paint = host.surfaces?.(recipe);
  const options: RoadGradeOptions = {
    width: num(argv, "width") ?? 6,
    maxGrade: num(argv, "max-grade") ?? 0.18,
    maxCut: num(argv, "max-cut") ?? 3,
    maxFill: num(argv, "max-fill") ?? 0.8,
    pinStart: num(argv, "pin-start"),
    pinEnd: num(argv, "pin-end"),
    spacing: num(argv, "spacing") ?? 0,
    surface: opt(argv, "surface") ?? paint?.surface,
    surfaceByBiome: paint?.surfaceByBiome,
  };
  const built = host.grade(id, points, field, options);
  if (!built.roads.length) fail(`road: ${id} graded to nothing`);
  const treadCut = num(argv, "tread-cut"), treadFill = num(argv, "tread-fill");
  const keepLandforms = argv.includes("--keep-landforms");
  const role = opt(argv, "role");
  if (role !== undefined && !["road", "paving", "none"].includes(role)) fail(`road: --role road|paving|none, not ${role}`);
  for (const r of built.roads) {
    if (keepLandforms) r.keepLandforms = true;
    if (role) r.role = role as RoadDoc["role"];
    // the tread rides the ground within the grading caps unless told otherwise (as `paths` / `trails` do): an uncapped band
    // graded along a 1:1 side slope or up an apron fill drew 12 m cut/fill walls and sawtooth (2026-10-29 redstrand w11:
    // road-moon / road-weeping-sun, ~500 lips cells at the Sun and Moon aprons and the lake shore)
    r.maxCut = treadCut ?? options.maxCut;
    r.maxFill = treadFill ?? options.maxFill;
  }
  // what the grading did, against the ground it was graded on
  let len = 0, climb = 0, steepest = 0, cut = 0, fill = 0;
  for (const r of built.roads) {
    const ys = r.surfaceY ?? [];
    for (let i = 0; i < r.points.length; i++) {
      if (i === 0) continue;
      const d = Math.hypot(r.points[i]![0] - r.points[i - 1]![0], r.points[i]![1] - r.points[i - 1]![1]);
      // cut/fill along the centreline every ~2 m, against the ground it was graded on
      const k = Math.max(1, Math.ceil(d / 2));
      for (let j = 0; j <= k; j++) {
        const t = j / k, a = r.points[i - 1]!, b = r.points[i]!;
        const y = ys[i - 1]! + (ys[i]! - ys[i - 1]!) * t, g = field.height(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        cut = Math.max(cut, g - y);
        fill = Math.max(fill, y - g);
      }
      len += d;
      climb += Math.max(0, ys[i]! - ys[i - 1]!);
      if (d > 0) steepest = Math.max(steepest, Math.abs(ys[i]! - ys[i - 1]!) / d);
    }
  }
  const first = built.roads[0]!, last = built.roads[built.roads.length - 1]!;
  console.log(
    `  ${id}: ${built.roads.length} piece(s), ${built.roads.reduce((n, r) => n + r.points.length, 0)} points, ${len.toFixed(0)} m, ` +
      `y ${first.surfaceY?.[0]} -> ${last.surfaceY?.at(-1)}, climbs ${climb.toFixed(1)} m, steepest ${(steepest * 100).toFixed(0)} %, ` +
      `max cut ${cut.toFixed(2)} m, max fill ${fill.toFixed(2)} m, width ${options.width}${built.bridges.length ? `, ${built.bridges.length} bridge(s)` : ""}`,
  );
  const edits = roadEdits(recipe, id, built.roads, built.bridges);
  if (dry) {
    console.log(`  [dry-run] ${edits.length} edit(s); not written`);
    const out = opt(argv, "out");
    if (out) fs.writeFileSync(out, `${JSON.stringify(built, null, 1)}\n`);
    return;
  }
  const res = applyRecipeEdits(recipe, edits);
  const inv = keep(file, recipe, `road-${id}`, res.inverse, opt(argv, "inverse"));
  host.writeRecipe(res.recipe, file);
  console.log(`  wrote ${id} (${edits.length} edit(s)); inverse: ${inv}  (worldgen op ${recipe.name} --undo <it>)`);
}
