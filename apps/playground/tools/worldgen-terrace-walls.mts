/**
 * `worldgen terrace-place <world> --project <p>` — a terrace held up by REAL retaining walls.
 *
 * Derek's rulings: retaining walls and stairs are geometry, terrain is only levelled for them; terraces are
 * nine-slice/parametric (the agent dictates the drop and the length, walls are plain by default, stairs / ramps /
 * doors / drains / buttresses are inserts). Input is a `features.terraceWalls` doc (core `terraceWallSchema`):
 *
 *   --spec <file.json>                 one doc or an array of docs (the schema, `solved` omitted)
 *   --id <slug> (--footprint "x,z x,z …" | --path "x,z x,z …" [--depth 8]) [--style masonry-common|masonry-stone|natural]
 *        [--fallback masonry-common] [--height <m>] [--top-y <m>] [--walls auto|0,2] [--insert <role>@<m>[:<edge>]]…
 *        [--strip 2.5] [--wear 0-3] [--owner <id>]
 *        footprint = the upper pad's outline (axis-aligned, 2 m grid); path = the wall line with the pad on its LEFT
 *        (open: the last->first closing edge is the uphill side, a 2-point path gets a --depth deep pad).
 *   --refit [--id a,b | --all]         re-solve fitted terraces against the current ground (after a terrain rebuild)
 *   --check [--id a,b | --all]         gates only (and STALE when the ground under a fit has changed)
 *   --remove <id>                      drop a terrace and everything derived from it
 *   --dry-run, --no-gates
 *
 * What a fit does (all derived data is written into the recipe, ids `tw-<id>*`, never as scene entities):
 *  (a) a feathered height patch: the pad level, the low strip at every wall foot at the wall's base, a graded bank
 *      behind each stepped end, and the rest blended back into the hill; oriented cuts (`solved.cuts`) on the low side of
 *      every face so the terrain riser stands 0.15 m inside the wall body instead of as a 2 m ramp; the doorway
 *      keep-clear boxes carved; a clearing so nothing grows on the pad or in the strip.
 *  (b) the wall pieces from the retaining-wall kit (world-kit authoring/retaining-wall plan.mjs planTerrace), with
 *      any height the kit lacks built first by `build.mts make`;
 *  (c) `solved` on the doc (pieces, faces, levels, sockets, ground fingerprint) — the streamer emits the pieces;
 *  (d) the gates for its footprint: `worldgen lips` (the wall's own lattice step exempt) and `worldgen seated`
 *      (wall foot strip at baseY, pad at topY) plus a riser probe through the density (no gutter behind the coping,
 *      no ground against the face).
 *
 * Natural style reads world-kit authoring/rock-kit/shelf-lookup.json (the natural shelf kit) and fails clearly while
 * it does not exist, unless the doc names a masonry `fallback`.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  createRockCapResolver,
  createWorldField,
  measureTerrainLips,
  prepareHeightPatch,
  seatReport,
  terraceWallSchema,
  terraceWallFeatureId,
  worldRecipeSchema,
  type HeightPatchDoc,
  type PassageDoc,
  type TerraceWallDoc,
  type TerraceWallSolved,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { closure, PROJECTS } from "./_closure.mjs";
import { terraceRiserBand } from "./worldgen-lips.mts";

type V2 = [number, number];
type V3 = [number, number, number];
type ClearingDoc = NonNullable<WorldRecipe["features"]["clearings"]>[number];
type RoadDoc = WorldRecipe["features"]["roads"][number];

const PLAYGROUND = path.resolve(import.meta.dirname, "..");
const GRID = 2;
/** Where the field's cut stands behind the face: inside the 0.6 m wall body. */
const CUT_BEHIND = 0.15;
/** How far in front of the face the cut box reaches (past the lattice cell holding the face). */
const CUT_FRONT = 3.5;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const snapGrid = (v: number) => Math.round(v / GRID) * GRID;
const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

// ------------------------------------------------------------------ kit access

interface KitPiece { run: number; plan?: number[][]; notes?: string; capBaked?: boolean; sockets?: { name: string; tag: string; position: V3; yaw: number }[]; phases?: Record<string, { entity: string; asset: string }[]> }
interface KitLookup { heights?: number[]; styles: Record<string, Record<string, Record<string, string>>>; pieces: Record<string, KitPiece> }
interface PlanResult {
  height: number;
  placements: { id: string; role: string; position: V3; yaw: number; edge: number; at: number; phase?: number }[];
  caps: { id: string; role: string; position: V3; yaw: number; edge: number; at: number }[];
  sockets: { name: string; tag: string; of: string; position: V3; yaw: number }[];
  warnings: string[];
}
interface PlanModule {
  planTerrace(lookup: KitLookup, req: Record<string, unknown>): PlanResult;
  snapHeight(h: number, lookup?: { heights?: number[] }): number;
}

/** The retaining-wall kit (and the natural shelf kit, when it exists) found in the project's dependency closure. */
export interface TerraceKit {
  /** Lookup + kit style key for a terrace style; throws when the style's kit does not exist. */
  resolve(style: TerraceWallDoc["style"]): { lookup: KitLookup; key: string };
  plan: PlanModule;
  /** Build a height the kit has no slices for (`build.mts make`), then reload the lookup. */
  ensureHeight(style: TerraceWallDoc["style"], height: number): void;
  /** Build an any-angle corner the kit has no pieces for (`build.mts make --corner`, every height and style). */
  ensureCorner?(style: TerraceWallDoc["style"], deg: number): void;
  /** A prefab's root entity id (overrides address its components). */
  prefabRoot?(id: string): string;
}

function findInClosure(project: string, rel: string): string | null {
  for (const name of closure(project)) {
    const file = path.join(PROJECTS, name, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function loadTerraceKit(project: string, log: (s: string) => void = console.log): TerraceKit {
  const lookupFile = findInClosure(project, path.join("authoring", "retaining-wall", "lookup.json"));
  if (!lookupFile) throw new Error(`no retaining-wall kit in ${project}'s closure (world-kit authoring/retaining-wall/lookup.json)`);
  const dir = path.dirname(lookupFile);
  const require = createRequire(import.meta.url);
  const plan = require(path.join(dir, "plan.mjs")) as PlanModule;
  let masonry = JSON.parse(fs.readFileSync(lookupFile, "utf8")) as KitLookup;
  const shelfFile = findInClosure(project, path.join("authoring", "rock-kit", "shelf-lookup.json"));
  return {
    plan,
    resolve(style) {
      if (style === "natural") {
        if (!shelfFile) throw new Error("natural terraces need the natural shelf kit (world-kit authoring/rock-kit/shelf-lookup.json), which does not exist yet: give the terrace a masonry `fallback` or wait for it");
        const lookup = JSON.parse(fs.readFileSync(shelfFile, "utf8")) as KitLookup;
        if (!lookup.styles || !lookup.pieces) throw new Error(`${shelfFile} is not a planTerrace lookup (styles + pieces)`);
        return { lookup, key: Object.keys(lookup.styles).includes("natural") ? "natural" : Object.keys(lookup.styles)[0]! };
      }
      return { lookup: masonry, key: style === "masonry-stone" ? "stone" : "common" };
    },
    ensureHeight(style, height) {
      // `make` builds + catalogues the height, then prints a demo plan of --length; a plan too short for the height's
      // stepped ends fails AFTER the build, so success is judged by the lookup, not by the exit code
      const run = (cmd: string, args: string[], strict = true) => {
        const r = spawnSync(cmd, args, { cwd: PLAYGROUND, shell: process.platform === "win32", stdio: "pipe", encoding: "utf8" });
        if (strict && r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
        return r;
      };
      const has = (file: string, key: string) => {
        try { return !!(JSON.parse(fs.readFileSync(file, "utf8")) as KitLookup).styles[key]?.[String(+height.toFixed(3))]; } catch { return false; }
      };
      if (style === "natural") {
        // the natural shelf kit is parametric the same way: shelf-build.mts make builds and catalogues a new height
        const build = shelfFile ? path.join(path.dirname(shelfFile), "shelf-build.mts") : "";
        if (!shelfFile || !fs.existsSync(build)) throw new Error(`the natural shelf kit has no ${height} m pieces and no shelf-build.mts to make them`);
        log(`  building natural shelf pieces at ${height} m (shelf-build.mts make)`);
        const made = run("npx", ["tsx", path.relative(PLAYGROUND, build), "make", "--style", "natural", "--height", String(height), "--length", "24"], false);
        if (!has(shelfFile, "natural")) throw new Error(`shelf-build.mts make --height ${height} did not add it:\n${made.stdout}\n${made.stderr}`);
        const shelfProject = path.basename(path.resolve(path.dirname(shelfFile), "..", ".."));
        run("npx", ["tsx", "tools/props.mts", "sync", "--project", shelfProject]);
        run("npx", ["tsx", "tools/props.mts", "index", "--project", shelfProject]);
        return;
      }
      const key = style === "masonry-stone" ? "stone" : "common";
      log(`  building retaining-wall slices at ${height} m (build.mts make; both styles)`);
      const made = run("npx", ["tsx", path.relative(PLAYGROUND, path.join(dir, "build.mts")), "make", "--style", key, "--height", String(height), "--length", "24"], false);
      if (!has(lookupFile, key)) throw new Error(`build.mts make --height ${height} did not add it:\n${made.stdout}\n${made.stderr}`);
      const kitProject = path.basename(path.resolve(dir, "..", ".."));
      run("npx", ["tsx", "tools/props.mts", "index", "--project", kitProject]);
      masonry = JSON.parse(fs.readFileSync(lookupFile, "utf8")) as KitLookup;
    },
    prefabRoot(id) {
      const file = findInClosure(project, path.join("assets", "prefabs", `${id}.json`));
      try { return file ? (JSON.parse(fs.readFileSync(file, "utf8")) as { root: string }).root : "piece"; } catch { return "piece"; }
    },
    ensureCorner(style, deg) {
      if (style === "natural") throw new Error(`the natural shelf kit has no ${deg} deg corner (natural runs bridge turns up to 20 deg; split the shelf)`);
      log(`  building ${deg} deg retaining-wall corners (build.mts make --corner ${deg}; every height and style)`);
      const r = spawnSync("npx", ["tsx", path.relative(PLAYGROUND, path.join(dir, "build.mts")), "make", "--corner", String(deg)], { cwd: PLAYGROUND, shell: process.platform === "win32", stdio: "pipe", encoding: "utf8" });
      masonry = JSON.parse(fs.readFileSync(lookupFile, "utf8")) as KitLookup;
      if (!(masonry as unknown as { corners?: number[] }).corners?.includes(deg)) throw new Error(`build.mts make --corner ${deg} did not add it:\n${r.stdout}\n${r.stderr}`);
      const kitProject = path.basename(path.resolve(dir, "..", ".."));
      spawnSync("npx", ["tsx", "tools/props.mts", "index", "--project", kitProject], { cwd: PLAYGROUND, shell: process.platform === "win32", stdio: "pipe", encoding: "utf8" });
    },
  };
}

// ------------------------------------------------------------------ geometry

function signedArea(poly: readonly V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i]!, q = poly[(i + 1) % poly.length]!; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
function inPoly(poly: readonly V2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(x: number, z: number, a: V2, b: V2): { d: number; t: number } {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
  return { d: Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t), t };
}
interface Edge { i: number; a: V2; b: V2; dir: V2; len: number; normal: V2 }
function edgesOf(poly: readonly V2[]): Edge[] {
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    // pad on the LEFT walking a -> b, so the low side (the face normal) is on the right: (-dz, dx)
    return { i, a, b, dir, len, normal: [-dir[1], dir[0]] as V2 };
  });
}

/**
 * De-duplicate and orient so the pad is on the left. An outline of world-axis edges is snapped to the 2 m world
 * grid (as before); any other outline keeps its vertices, and its wall runs are put on the RUN grid at fit time
 * (lengths on 2 m along each edge, turns on 5 deg: the same rule as plan.mjs).
 */
export function normaliseFootprint(raw: readonly V2[]): { poly: V2[]; reversed: boolean } {
  const axis = raw.every((p, i) => { const q = raw[(i + 1) % raw.length]!; return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6; });
  let poly = raw.map(([x, z]) => (axis ? [snapGrid(x), snapGrid(z)] : [r3(x), r3(z)]) as V2);
  poly = poly.filter((p, i) => { const q = poly[(i + 1) % poly.length]!; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3; });
  if (poly.length < 3) throw new Error("footprint needs at least 3 distinct vertices");
  const reversed = signedArea(poly) > 0;
  if (reversed) poly = [poly[0]!, ...poly.slice(1).reverse()];
  return { poly, reversed };
}

// ------------------------------------------------------------------ the fit

export interface TerraceFit {
  doc: TerraceWallDoc;
  patch: HeightPatchDoc;
  passages: PassageDoc[];
  clearing: ClearingDoc;
}

/** The world with no terrace wall's derived features at all: the ground every fit's STALE check is measured on. */
export function bareOfTerraceWalls(recipe: WorldRecipe): WorldRecipe {
  const tw = (id: string) => id.startsWith("tw-");
  return { ...recipe, features: { ...recipe.features, terraceWalls: [], heightPatches: recipe.features.heightPatches.filter((p) => !tw(p.id)), passages: (recipe.features.passages ?? []).filter((p) => !tw(p.id)) } };
}
/** Mean bare ground over a raster: changes when the terrain under a terrace changes, not when a neighbour is fitted. */
function groundFingerprint(recipe: WorldRecipe, ox: number, oz: number, columns: number, rows: number, spacing: number): number {
  const bare = createWorldField(bareOfTerraceWalls(recipe));
  let sum = 0;
  for (let j = 0; j < rows; j += 2) for (let i = 0; i < columns; i += 2) sum += bare.height(ox + i * spacing, oz + j * spacing);
  return r2(sum / (Math.ceil(columns / 2) * Math.ceil(rows / 2)));
}

/** The ground a terrace is fitted on: the world without this terrace's own derived features. */
export function naturalRecipe(recipe: WorldRecipe, id: string): WorldRecipe {
  const own = (fid: string) => fid === terraceWallFeatureId(id) || fid.startsWith(`${terraceWallFeatureId(id)}-`);
  return {
    ...recipe,
    features: {
      ...recipe.features,
      heightPatches: recipe.features.heightPatches.filter((p) => !own(p.id)),
      passages: (recipe.features.passages ?? []).filter((p) => !own(p.id)),
      terraceWalls: (recipe.features.terraceWalls ?? []).filter((t) => t.id !== id),
    },
  };
}

function passage(id: string, start: V3, axis: "x" | "z", length: number, width: number, height: number): PassageDoc {
  return {
    id, start: [r3(start[0]), r3(start[1]), r3(start[2])], axis, direction: 1, footprint: "box", length: r3(length), width: r3(width), height: r3(height),
    wallNoise: 0, noiseDetail: 0, roofRise: 0, roofNoise: 0, noiseScale: 6, seed: 1, falloff: 4, connectionBand: 4,
  };
}

/** A world AABB [x0, z0, x1, z1] of the rectangle swept `d0..d1` along an edge's normal over `s0..s1` of its length. */
function edgeRect(e: Edge, s0: number, s1: number, d0: number, d1: number): [number, number, number, number] {
  const pts = [[s0, d0], [s1, d0], [s0, d1], [s1, d1]].map(([s, d]) => [e.a[0] + e.dir[0] * s! + e.normal[0] * d!, e.a[1] + e.dir[1] * s! + e.normal[1] * d!]);
  return [Math.min(...pts.map((p) => p[0]!)), Math.min(...pts.map((p) => p[1]!)), Math.max(...pts.map((p) => p[0]!)), Math.max(...pts.map((p) => p[1]!))];
}
const rectDist = (r: [number, number, number, number], x: number, z: number) => Math.hypot(Math.max(r[0] - x, 0, x - r[2]), Math.max(r[1] - z, 0, z - r[3]));
/** A rectangle in an edge's own frame: s along it, d toward its low side (any heading). */
interface ORect { e: Edge; s0: number; s1: number; d0: number; d1: number }
const orLocal = (r: ORect, x: number, z: number) => { const rx = x - r.e.a[0], rz = z - r.e.a[1]; return [rx * r.e.dir[0] + rz * r.e.dir[1], rx * r.e.normal[0] + rz * r.e.normal[1]] as V2; };
const orInside = (r: ORect, x: number, z: number) => { const [a, b] = orLocal(r, x, z); return a >= r.s0 - 1e-6 && a <= r.s1 + 1e-6 && b >= r.d0 - 1e-6 && b <= r.d1 + 1e-6; };
const orDist = (r: ORect, x: number, z: number) => { const [a, b] = orLocal(r, x, z); return Math.hypot(Math.max(r.s0 - a, 0, a - r.s1), Math.max(r.d0 - b, 0, b - r.d1)); };
const orBounds = (r: ORect) => edgeRect(r.e, r.s0, r.s1, r.d0, r.d1);
/** Metres over which a feather's target blends between equidistant levelled edges (see the raster). */
const TARGET_BLEND = 1.5;
/** How far into its feather (as a fraction of the blend) a terrace gives way completely to held ground below. */
const HOLD_TAKEOVER = 0.35;
/** Metres beyond a lower wall's foot strip over which its hold eases off. */
const HOLD_EASE = 3;
/** A stepped end's bank climbs back to the pad over this many times the end piece's run behind the face. */
const BANK_DEPTH = 1.5;
/** Metres over which the bank's crease with the pad is rounded (wider than a lattice cell would draw as a crease). */
const BANK_ROUND = 1.2;
/** Width of the band in front of a face held at pad height for the cut to carve: every lattice edge crossing the face has its front end in it. */
const BERM = 2;

const DOOR_BOX = /box x (-?[\d.]+)\.\.(-?[\d.]+), y (-?[\d.]+)\.\.(-?[\d.]+), z (-?[\d.]+)\.\.(-?[\d.]+)/;

export interface TerraceFitOptions {
  /**
   * Levelled ground that must stay as it is, in [0, 1] (1 = held): this terrace's FEATHER (not its pad, strip or berm)
   * gives way there. A town chain passes the risers below: an upper pad's feather running over the foot strip of the
   * wall below lifted it, and that wall's face cut then clipped it back to the foot in a 2 m step.
   */
  hold?: (x: number, z: number) => number;
}

export function fitTerraceWall(recipe: WorldRecipe, input: TerraceWallDoc, kit: TerraceKit, log: (s: string) => void = () => {}, opts: TerraceFitOptions = {}): TerraceFit {
  const doc = terraceWallSchema.parse({ ...input, solved: undefined });
  // the levelled foot strip reaches past the berm and the raster samples it interpolates with (the cut and the
  // ground queries carve that far): never narrower than the cut
  const strip = Math.max(doc.strip, CUT_FRONT + 0.5);
  const warnings: string[] = [];
  const { poly, reversed } = normaliseFootprint(doc.footprint);
  const n = poly.length;
  let edges = edgesOf(poly);
  // edge indices in the caller's winding -> ours
  const mapEdge = (i: number) => (reversed ? (n - 1 - i + n) % n : i);
  const ground = createWorldField(naturalRecipe(recipe, doc.id));
  // the raw heightfield (neighbouring terraces' berms included): the raster copies it outside its own levelled ground
  const nat = (x: number, z: number) => ground.heightfield(x, z);

  // ---- style
  let style = doc.style;
  let resolved: { lookup: KitLookup; key: string };
  try {
    resolved = kit.resolve(style);
  } catch (e) {
    if (style !== "natural" || !doc.fallback) throw e;
    warnings.push(`natural shelf kit missing: built in ${doc.fallback} (refit when world-kit rock-kit shelf-lookup.json lands)`);
    style = doc.fallback;
    resolved = kit.resolve(style);
  }

  // ---- pad level
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const [x, z] of poly) { bx0 = Math.min(bx0, x); bz0 = Math.min(bz0, z); bx1 = Math.max(bx1, x); bz1 = Math.max(bz1, z); }
  const interior: number[] = [];
  for (let z = bz0 + 1; z < bz1; z += 2) for (let x = bx0 + 1; x < bx1; x += 2) if (inPoly(poly, x, z)) interior.push(nat(x, z));
  let topY = doc.topY ?? median(interior);
  if (!Number.isFinite(topY)) throw new Error(`terrace ${doc.id}: footprint has no interior`);
  const footOf = (set: Iterable<number>) => {
    const foot: number[] = [];
    for (const i of set) { const e = edges[i]!; for (let s = 1; s < e.len; s += 2) foot.push(nat(e.a[0] + e.dir[0] * s + e.normal[0] * 1.5, e.a[1] + e.dir[1] * s + e.normal[1] * 1.5)); }
    return median(foot);
  };

  // ---- which edges carry wall
  const outsideDrop = (e: Edge, out: number) => {
    const v: number[] = [];
    for (let s = 1; s < e.len; s += 2) v.push(nat(e.a[0] + e.dir[0] * s + e.normal[0] * out, e.a[1] + e.dir[1] * s + e.normal[1] * out));
    return topY - median(v);
  };
  let wallSet: Set<number>;
  if (doc.walls === "auto") {
    const drops = edges.map((e) => outsideDrop(e, 3));
    const steepest = Math.max(...drops);
    const need = doc.height !== undefined ? Math.max(doc.minDrop, 0.25 * doc.height) : Math.max(doc.minDrop, 0.6 * steepest);
    const fl = doc.facing ? Math.hypot(doc.facing[0], doc.facing[1]) || 1 : 1;
    const faces = (e: Edge) => !doc.facing || (e.normal[0] * doc.facing[0] + e.normal[1] * doc.facing[1]) / fl >= 0.5;
    wallSet = new Set(edges.filter((e, i) => drops[i]! >= need && faces(e)).map((e) => e.i));
    if (!wallSet.size) throw new Error(`terrace ${doc.id}: no edge drops ${doc.minDrop} m below the pad (steepest ${steepest.toFixed(2)} m) — nothing to retain; give walls or a topY`);
    // A run may not stop at an INNER corner: the open edge beyond it stands right beside the levelled foot strip, a
    // cliff of the full drop with no wall. Carry the wall round onto it (and on, while that is true).
    const inner = (p: Edge, q: Edge) => p.dir[0] * q.dir[1] - p.dir[1] * q.dir[0] > 1e-9;
    for (let changed = true, guard = 0; changed && guard < n; guard++) {
      changed = false;
      for (const i of [...wallSet]) {
        const nx = (i + 1) % n, pv = (i + n - 1) % n;
        if (!wallSet.has(nx) && inner(edges[i]!, edges[nx]!)) { wallSet.add(nx); changed = true; }
        if (!wallSet.has(pv) && inner(edges[pv]!, edges[i]!)) { wallSet.add(pv); changed = true; }
      }
    }
  } else {
    wallSet = new Set(doc.walls.map(mapEdge));
    for (const i of wallSet) if (i >= n) throw new Error(`terrace ${doc.id}: wall edge ${i} does not exist (${n} edges)`);
  }

  // ---- height. Dictated (and no topY): the wall rises that far from the ground at its foot, so the strip meets
  // the hill and the pad is what moves. Otherwise the drop from the pad to the foot ground.
  let height: number;
  if (doc.height !== undefined) {
    height = kit.plan.snapHeight(doc.height, resolved.lookup);
    if (doc.topY === undefined) topY = footOf(wallSet) + height;
  } else {
    const raw = topY - footOf(wallSet);
    if (raw > 6.4) warnings.push(`the ground falls ${raw.toFixed(1)} m: walls capped at the kit's 6.4 m (the strip is filled up to the foot)`);
    // a height the kit already has, when one is within a course of the drop (each new height is ~40 built pieces)
    const want = Math.max(0.8, Math.min(6.4, raw));
    const have = Object.keys(resolved.lookup.styles[resolved.key] ?? {}).map(Number).sort((p, q) => Math.abs(p - want) - Math.abs(q - want))[0];
    height = have !== undefined && Math.abs(have - want) <= 0.4 ? have : kit.plan.snapHeight(want, resolved.lookup);
  }

  // ---- doorway roof: the pad must keep a lattice node over the passage, or the mesher opens a hole in it
  const doors = doc.inserts.filter((x) => x.role.startsWith("door"));
  const step = ground.voxelSize;
  const doorRoof = (role: string): number => {
    const set = resolved.lookup.styles[resolved.key]?.[String(+height.toFixed(3))];
    const id = set?.[role];
    const m = id ? DOOR_BOX.exec(resolved.lookup.pieces[id]?.notes ?? "") : null;
    return m ? Number(m[4]) : role === "door-arch" ? 3.5 : 3.0;
  };
  if (doors.length) {
    const roof = Math.max(...doors.map((d) => doorRoof(d.role)));
    if (height < roof + 0.6) throw new Error(`terrace ${doc.id}: a doorway needs at least 0.6 m of pad over its passage roof — height ${height} m is under ${r2(roof + 0.6)} m`);
    // A lattice row must stand in the UPPER half of the slab between the passage roof and the pad: there the pad's
    // own distance is the nearer one and the surface is drawn at topY. In the lower half the roof's signed field
    // wins, and the mesher pulls the pad down into a dip over the passage (the grey patch on the coping).
    const ok = (top: number) => Math.ceil(((top - height + roof) + top) / 2 / step - 1e-9) * step <= top - 0.15;
    if (!ok(topY)) {
      if (doc.topY !== undefined) warnings.push(`doorway roof: no lattice node between ${r2(topY - height + roof)} and ${r2(topY - 0.15)} — the pad will open over the passage; move topY`);
      else {
        let best = Infinity;
        for (let d = -step; d <= step; d += 0.05) if (ok(topY + d) && Math.abs(d) < Math.abs(best)) best = d;
        topY += best;
        log(`  pad nudged ${best >= 0 ? "+" : ""}${best.toFixed(2)} m so the doorway passage keeps a roof`);
      }
    }
  }
  topY = r2(topY);
  const baseY = r2(topY - height);

  // ---- runs of consecutive wall edges
  const runsOf = (set: Set<number>) => {
    const out: { edges: number[]; closed: boolean }[] = [];
    if (set.size === n) out.push({ edges: edges.map((e) => e.i), closed: true });
    else {
      const start = edges.findIndex((e) => !set.has(e.i));
      let cur: number[] = [];
      for (let k = 1; k <= n; k++) {
        const i = (start + k) % n;
        if (set.has(i)) cur.push(i);
        else if (cur.length) { out.push({ edges: cur, closed: false }); cur = []; }
      }
      if (cur.length) out.push({ edges: cur, closed: false });
    }
    return out;
  };
  let runs = runsOf(wallSet);
  // RUN GRID: each wall run's vertices re-laid from its first vertex with lengths on 2 m and turns on 5 deg (the
  // planner's own rule, so its pieces close on the outline exactly); the open edges either side take up the slack
  const snapRuns = () => {
    let moved = false;
    for (const run of runs) {
      const idx = run.edges.map((i) => i);
      let at: V2 = [poly[idx[0]!]![0], poly[idx[0]!]![1]];
      let heading: number | null = null;
      const head = (d: V2) => (Math.atan2(-d[1], d[0]) * 180) / Math.PI;
      const fix: V2[] = [];
      for (const i of idx) {
        const e = edges[i]!;
        let h = head(e.dir);
        if (heading === null) { const q = Math.round(h / 90) * 90; if (Math.abs(h - q) < 0.5) h = q; }
        else { let dt = ((h - heading + 180) % 360 + 360) % 360 - 180; h = heading + Math.round(dt / 5) * 5; }
        const len = Math.max(2, Math.round(e.len / 2 + 1e-9) * 2);
        const rad = (h * Math.PI) / 180;
        at = [r3(at[0] + Math.cos(rad) * len), r3(at[1] - Math.sin(rad) * len)];
        fix.push(at);
        heading = h;
      }
      // the run's later vertices take the snapped positions (a closed run must close on its own first vertex)
      const last = run.closed ? idx.length - 1 : idx.length;
      for (let k = 0; k < last; k++) {
        const vi = (idx[k]! + 1) % n;
        if (Math.hypot(poly[vi]![0] - fix[k]![0], poly[vi]![1] - fix[k]![1]) > 1e-3) { poly[vi] = fix[k]!; moved = true; }
      }
      if (run.closed && Math.hypot(fix[idx.length - 1]![0] - poly[idx[0]!]![0], fix[idx.length - 1]![1] - poly[idx[0]!]![1]) > 0.5) throw new Error(`terrace ${doc.id}: a closed wall does not close on the 2 m / 5 deg run grid`);
    }
    if (moved) edges = edgesOf(poly);
  };
  snapRuns();

  // ---- plan every run with the kit
  const pieces: TerraceWallSolved["pieces"] = [];
  const sockets: TerraceWallSolved["sockets"] = [];
  const doorBoxes: { e: Edge; s: number; info: KitPiece }[] = [];
  const stairStrips: { e: Edge; s0: number; s1: number; depth: number }[] = [];
  const banks: { e: Edge; from: number; dirSign: 1 | -1; run: number }[] = [];
  // Kit role per insert. Natural rock has one way up (rock-steps) and no masonry details.
  const kitRole = (x: TerraceWallDoc["inserts"][number]): string | null => {
    if (style === "natural") return x.role === "stair" || x.role === "stair-turn" || x.role === "ramp" ? "rock-steps" : null;
    return x.role === "drain" || x.role === "buttress" ? `straight-${x.run}-${x.role}` : x.role;
  };
  if (style === "natural") {
    for (const x of doc.inserts) {
      const k = kitRole(x);
      if (!k) {
        if (x.role.startsWith("door")) throw new Error(`terrace ${doc.id}: natural rock shelves have no doorway (${x.role}); build that wall in masonry`);
        warnings.push(`natural: ${x.role} dropped (rock has no such piece)`);
      } else if (k !== x.role) warnings.push(`natural: ${x.role} built as rock-steps`);
    }
  }
  const insertsFor = (run: { edges: number[] }) =>
    doc.inserts
      .filter((x) => kitRole(x) !== null)
      .map((x) => ({ ...x, edge: mapEdge(x.edge), at: reversed ? edges[mapEdge(x.edge)]!.len - x.at - insertRun(x) : x.at }))
      .filter((x) => run.edges.includes(x.edge))
      .map((x) => ({ role: kitRole(x)!, at: Math.max(0, x.at), edge: run.edges.indexOf(x.edge) }));
  function insertRun(x: TerraceWallDoc["inserts"][number]): number {
    if (x.role === "drain" || x.role === "buttress") return x.run;
    const id = resolved.lookup.styles[resolved.key]?.[String(+height.toFixed(3))]?.[kitRole(x) ?? x.role];
    return id ? resolved.lookup.pieces[id]?.run ?? 4 : 4;
  }
  const requestFor = (run: { edges: number[]; closed: boolean }, ri: number) => {
    const verts = run.edges.map((i) => edges[i]!.a);
    if (!run.closed) verts.push(edges[run.edges[run.edges.length - 1]!]!.b);
    const origin = verts[0]!;
    return { origin, req: { style: resolved.key, height, path: verts.map(([x, z]) => [x - origin[0], z - origin[1]]), closed: run.closed, inserts: insertsFor(run), wear: doc.wear, seed: `${doc.seed ?? doc.id}|${ri}`, ...(style === "natural" ? { cornerless: 20 } : {}) } };
  };
  // An open run whose END edge is too short for its stepped end (2/4/6 m by height) plus a corner cannot be built
  // as a wall: that edge drops out of the wall set (it meets the ground as a bank) and the runs are re-cut.
  for (let guard = 0; guard < n; guard++) {
    let dropped = false;
    for (const [ri, run] of runs.entries()) {
      const { req } = requestFor(run, ri);
      try {
        kit.plan.planTerrace(resolved.lookup, req);
      } catch (e) {
        const msg = String((e as Error).message);
        // a height the kit lacks: build it, then check every run again
        if (/no \w+ slices at/.test(msg)) { kit.ensureHeight(style, height); resolved = kit.resolve(style); dropped = true; break; }
        // a corner angle the kit lacks: build it (every height and style), then check again
        const ang = /make --corner (\d+)/.exec(msg);
        if (ang && kit.ensureCorner) { kit.ensureCorner(style, Number(ang[1])); resolved = kit.resolve(style); dropped = true; break; }
        const m = /edge (\d+) \(.*too short/.exec(msg);
        const local = m ? Number(m[1]) : -1;
        if (!run.closed && (local === 0 || local === run.edges.length - 1)) {
          const i = run.edges[local]!;
          wallSet.delete(i);
          warnings.push(`edge ${i} (${edges[i]!.len} m) is too short for a ${height} m wall's stepped end: left as a bank`);
          dropped = true;
          break;
        }
        throw new Error(`terrace ${doc.id} run ${ri}: ${msg}`);
      }
    }
    if (!dropped) break;
    if (!wallSet.size) throw new Error(`terrace ${doc.id}: every wall edge is too short for a ${height} m wall`);
    runs = runsOf(wallSet);
    snapRuns();
  }
  for (const [ri, run] of runs.entries()) {
    const verts = run.edges.map((i) => edges[i]!.a);
    if (!run.closed) verts.push(edges[run.edges[run.edges.length - 1]!]!.b);
    const origin = verts[0]!;
    const local = verts.map(([x, z]) => [x - origin[0], z - origin[1]]);
    const req = { style: resolved.key, height, path: local, closed: run.closed, inserts: insertsFor(run), wear: doc.wear, seed: `${doc.seed ?? doc.id}|${ri}`, ...(style === "natural" ? { cornerless: 20 } : {}) };
    let plan: PlanResult;
    try {
      plan = kit.plan.planTerrace(resolved.lookup, req);
    } catch (e) {
      if (!/no \w+ slices at/.test(String((e as Error).message))) throw new Error(`terrace ${doc.id} run ${ri}: ${(e as Error).message}`);
      kit.ensureHeight(style, height);
      resolved = kit.resolve(style);
      plan = kit.plan.planTerrace(resolved.lookup, req);
    }
    warnings.push(...plan.warnings.map((w) => `run ${ri}: ${w}`));
    for (const p of plan.placements) {
      const e = edges[run.edges[p.edge]!]!;
      const info = resolved.lookup.pieces[p.id]!;
      // the run-space UV phase this placement needs: its meshes swapped for that phase's variants
      const variants = p.phase ? info.phases?.[String(p.phase)] : undefined;
      const overrides = variants?.map((v) => ({ path: `${v.entity}/components/mesh/source/assetId`, value: v.asset }));
      pieces.push({ prefab: p.id, role: p.role, position: [r3(p.position[0] + origin[0]), baseY, r3(p.position[2] + origin[1])], yaw: p.yaw, run: info.run, ...(overrides?.length ? { overrides } : {}) });
      const s = p.at;
      if (p.role.startsWith("door")) doorBoxes.push({ e, s, info });
      const front = Math.max(0, ...(info.plan ?? []).map((q) => q[1]!));
      // stairs, ramps and the dog-leg stand on low ground in front of the face: level their footprint + 1 m (a rock
      // face's lean at the foot is not a footprint: the ordinary strip covers it)
      if (front > 1 && front + 1 > strip) stairStrips.push({ e, s0: s, s1: s + info.run, depth: front + 1 });
      if (p.role === "end-l") banks.push({ e, from: s, dirSign: 1, run: info.run });
      if (p.role === "end-r") banks.push({ e, from: s + info.run, dirSign: -1, run: info.run });
    }
    for (const c of plan.caps) pieces.push({ prefab: c.id, role: c.role, position: [r3(c.position[0] + origin[0]), r3(baseY + c.position[1]), r3(c.position[2] + origin[1])], yaw: c.yaw });
    for (const k of plan.sockets) sockets.push({ name: k.name, tag: k.tag, position: [r3(k.position[0] + origin[0]), r3(baseY + k.position[1]), r3(k.position[2] + origin[1])], yaw: k.yaw });
  }

  // ---- cuts: the low side of every face, so the riser stands inside the wall body
  const fid = terraceWallFeatureId(doc.id);
  const passages: PassageDoc[] = [];
  const cuts: NonNullable<TerraceWallSolved["cuts"]> = [];
  const turn = (p: Edge, q: Edge) => { const c = p.dir[0] * q.dir[1] - p.dir[1] * q.dir[0]; return Math.abs(c) < 1e-9 ? 0 : c < 0 ? -1 : 1; };
  const faces: TerraceWallSolved["faces"] = [];
  const stripRects: ORect[] = [];
  /** The wall edge each strip rect stands in front of (its feather width follows that edge's). */
  const stripEdge: number[] = [];
  // BERM: the lattice row ON each face line stays at pad height in the heightfield and the cut carves it away. The
  // mesher interpolates between lattice nodes, so a node that is plain low ground (y - baseY) beside a pad node
  // draws a 2 m ramp; a node inside the cut's signed field (0.15 m from its back plane) puts the riser there.
  const berms: { e: Edge; s0: number; s1: number }[] = [];
  for (const run of runs) {
    run.edges.forEach((i, k) => {
      const e = edges[i]!;
      const prev = k > 0 ? edges[run.edges[k - 1]!]! : run.closed ? edges[run.edges[run.edges.length - 1]!]! : null;
      const next = k + 1 < run.edges.length ? edges[run.edges[k + 1]!]! : run.closed ? edges[run.edges[0]!]! : null;
      // outer (convex, turn left) corners: reach over the corner square; inner: stop inside the other wall's body
      const ext0 = prev ? (turn(prev, e) < 0 ? CUT_FRONT : CUT_BEHIND) : 0;
      const ext1 = next ? (turn(e, next) < 0 ? CUT_FRONT : CUT_BEHIND) : 0;
      cuts.push({ kind: "face", origin: [r3(e.a[0]), r3(e.a[1])], dir: [+e.dir[0].toFixed(6), +e.dir[1].toFixed(6)], s: [r3(-ext0), r3(e.len + ext1)], n: [-CUT_BEHIND, CUT_FRONT], y: [baseY, r2(topY + 3)] });
      faces.push({ a: [e.a[0], e.a[1]], b: [e.b[0], e.b[1]], normal: [e.normal[0], e.normal[1]] });
      berms.push({ e, s0: prev && turn(prev, e) < 0 ? -BERM : 0, s1: e.len + (next && turn(e, next) < 0 ? BERM : 0) });
      stripRects.push({ e, s0: -(prev && turn(prev, e) < 0 ? strip : 0), s1: e.len + (next && turn(e, next) < 0 ? strip : 0), d0: 0, d1: strip });
      stripEdge.push(e.i);
    });
  }
  // clipped to the edge: past a run's open end the strip would stand beside the pad's bank and seam against it
  for (const s of stairStrips) { stripRects.push({ e: s.e, s0: Math.max(0, s.s0 - 1), s1: Math.min(s.e.len, s.s1 + 1), d0: 0, d1: s.depth }); stripEdge.push(s.e.i); }
  // doorway keep-clear: the passage box behind the opening, carved through the pad
  for (const [k, d] of doorBoxes.entries()) {
    const m = DOOR_BOX.exec(d.info.notes ?? "");
    const [lx0, lx1, , ly1, lz0] = m ? m.slice(1).map(Number) : [0.4, 3.6, 0, 3.5, -2.6];
    void k;
    cuts.push({ kind: "door", origin: [r3(d.e.a[0]), r3(d.e.a[1])], dir: [+d.e.dir[0].toFixed(6), +d.e.dir[1].toFixed(6)], s: [r3(d.s + lx0!), r3(d.s + lx1!)], n: [lz0!, 0.5], y: [baseY, r2(baseY + ly1!)] });
  }

  // ---- the raster: pad, strip, banks behind stepped ends, feathered back into the hill
  const wallEdges = edges.filter((e) => wallSet.has(e.i));
  // A rock shelf carries its own flat top 1 m deep at y = height: ground drawn at exactly that height z-fights it,
  // so the pad sits a few cm under a natural shelf's top (masonry is capped by its coping, so it is flush).
  const padY = style === "natural" ? topY - 0.08 : topY;
  const padTarget = (x: number, z: number): number => {
    let t = padY;
    for (const b of banks) {
      // along the wall from the open end (u) and behind the face (d)
      const rx = x - b.e.a[0], rz = z - b.e.a[1];
      const s = rx * b.e.dir[0] + rz * b.e.dir[1];
      const d = -(rx * b.e.normal[0] + rz * b.e.normal[1]);
      const u = (s - b.from) * b.dirSign;
      // The bank climbs back to the pad over BANK_DEPTH x run behind the face (a 6 m wall's bank over its own 6 m run
      // was a 1.5 slope whose crease drew as an alias), and its crease with the pad is rounded over ~1.2 m (still
      // under the step tops: rounding only lowers it), so the band reaches a little past the piece along the face.
      const depth = BANK_DEPTH * b.run;
      const grad = Math.hypot(1 / (b.run - 0.5), 1 / depth);
      const kr = BANK_ROUND * grad;
      // a little past the open end and the face too: the end vertex itself sits on that boundary in floating point
      if (u < -2 * b.run || u > b.run + kr / grad + 0.5 || d < -0.5 || d > depth + kr / grad + 0.5) continue;
      // under every step top (H (k+1) / run over step k) and up to the pad at the end of the piece
      // a plane: under the step tops along the face, up to the pad going back; one crease where it meets the pad
      // (a curved bank bends inside one lattice cell and draws as teeth)
      const at = (uu: number) => {
        const q = (uu - 0.5) / (b.run - 0.5) + d / depth;
        const h = Math.max(kr - Math.abs(q - 1), 0) / kr;
        return baseY + (padY - baseY) * Math.max(0, Math.min(q, 1) - (h * h * kr) / 4);
      };
      // past the open end (a pad corner that runs on beyond the wall): the bank at the end, easing back up to the pad
      // over two more end lengths, so the outline beyond the wall has no seam either
      t = Math.min(t, u >= 0 ? at(u) : at(0) + (padY - at(0)) * smooth(0, 2 * b.run, -u));
    }
    return t;
  };
  const featherFor = (delta: number) => Math.min(24, Math.max(doc.feather ?? 4, 1.6 * Math.abs(delta)));
  let rx0 = bx0, rz0 = bz0, rx1 = bx1, rz1 = bz1;
  for (const r of stripRects.map(orBounds)) { rx0 = Math.min(rx0, r[0]); rz0 = Math.min(rz0, r[1]); rx1 = Math.max(rx1, r[2]); rz1 = Math.max(rz1, r[3]); }
  // margin: wide enough for the steepest feather this terrace can need
  // The feather width is set by the height difference AT the levelled edge (the nearest pad / strip boundary point
  // 1 m out), not at the sample: on a hillside the difference grows with distance and a per-sample width never ends.
  // On a hillside the difference keeps growing across the feather (the hill rises away from a cut, falls away from
  // a fill), so the width solves f = 1.6 (delta + k f) with k the hill's own outward slope: the blend then climbs at
  // most ~1 between lattice samples. Memoised per edge point: every sample beyond a stretch of edge shares it.
  const memo = new Map<string, number>();
  const edgeFeather = (px: number, pz: number, ox: number, oz: number, t: number) => {
    const l = Math.hypot(ox, oz);
    if (l < 1e-6) return featherFor(0);
    const ux = ox / l, uz = oz / l;
    const key = `${px.toFixed(2)},${pz.toFixed(2)},${ux.toFixed(3)},${uz.toFixed(3)},${t}`;
    let f = memo.get(key);
    if (f === undefined) {
      const g1 = nat(px + ux, pz + uz), g6 = nat(px + ux * 6, pz + uz * 6);
      const delta = g1 - t;
      const k = Math.sign(delta || 1) * (g6 - g1) / 5;
      f = Math.min(24, Math.max(doc.feather ?? 4, (1.6 * Math.abs(delta)) / Math.max(0.25, 1 - 1.6 * Math.max(0, k))));
      memo.set(key, f);
    }
    return f;
  };
  // One width per outline edge (its worst sample) and per vertex (the wider of its two edges), interpolated along
  // each edge: a width that jumps between neighbouring directions draws its own cliff where the fans meet.
  const fEdge = edges.map((e) => {
    let f = featherFor(0);
    for (let s = 0; s <= e.len; s += 2) {
      const out = wallSet.has(e.i) ? strip : 0;
      f = Math.max(f, edgeFeather(e.a[0] + e.dir[0] * s + e.normal[0] * out, e.a[1] + e.dir[1] * s + e.normal[1] * out, e.normal[0], e.normal[1], wallSet.has(e.i) ? baseY : topY));
    }
    return f;
  });
  const fVert = edges.map((_, i) => Math.max(fEdge[i]!, fEdge[(i + n - 1) % n]!));
  const outlineFeather = (i: number, t: number) => Math.max(fEdge[i]!, fVert[i]! + (fVert[(i + 1) % n]! - fVert[i]!) * t);
  const maxFeather = Math.max(...fEdge);
  const margin = Math.ceil(maxFeather + 4);
  const ox = Math.floor((rx0 - margin) / GRID) * GRID, oz = Math.floor((rz0 - margin) / GRID) * GRID;
  const ex = Math.ceil((rx1 + margin) / GRID) * GRID, ez = Math.ceil((rz1 + margin) / GRID) * GRID;
  const spacing = 1;
  const columns = Math.round((ex - ox) / spacing) + 1, rows = Math.round((ez - oz) / spacing) + 1;
  if (columns > 1025 || rows > 1025) throw new Error(`terrace ${doc.id}: raster ${columns}x${rows} is over the 1025 sample limit — split the terrace`);
  // A MASKED patch (heights = the levelled target, weights = how hard it holds): outside the levelled ground the
  // weight falls to 0 over the feather and the ground under the patch shows through. An opaque raster froze a copy of
  // the whole box (up to 150 m: a neighbouring riser's pad, a road cut later) at fit time, so every refit of one riser
  // moved the ground under its neighbours and the town's fits never converged.
  const heights: number[] = new Array(columns * rows);
  const weights: number[] = new Array(columns * rows);
  let fingerprint = 0;
  /** Pad height to hold a berm sample at, or null when (x, z) is not within 1 m in front of a face. */
  const bermAt = (x: number, z: number): number | null => {
    for (const b of berms) {
      const rx = x - b.e.a[0], rz = z - b.e.a[1];
      const s = rx * b.e.dir[0] + rz * b.e.dir[1], d = rx * b.e.normal[0] + rz * b.e.normal[1];
      if (d < -1e-6 || d >= BERM - 1e-6 || s < b.s0 - 1e-6 || s > b.s1 + 1e-6) continue;
      const cs = Math.max(0, Math.min(b.e.len, s));
      return padTarget(b.e.a[0] + b.e.dir[0] * cs - b.e.normal[0] * 0.3, b.e.a[1] + b.e.dir[1] * cs - b.e.normal[1] * 0.3);
    }
    return null;
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const x = ox + i * spacing, z = oz + j * spacing;
      let v: number, w = 1;
      const berm = bermAt(x, z);
      if (berm !== null) v = berm;
      else if (inPoly(poly, x, z)) v = padTarget(x, z);
      else if (stripRects.some((r) => orInside(r, x, z))) v = baseY;
      else {
        // Blend toward the NEAREST point of the levelled ground (pad outline or a strip), holding that point's own
        // target, over the feather width of the outline edge it belongs to (interpolated between vertices). The
        // nearest point moves continuously; where two are equidistant (the pad's open side vs the strip's end at a
        // run end) both targets are the wall foot and both widths the vertex's, so there is no seam.
        // Every candidate (outline edges, strips) with its distance, target and width; the nearest sets the distance,
        // and the TARGET and WIDTH are a soft blend of the candidates within a few metres of it. A hard nearest-point
        // switch drew a seam where a strip (wall foot) and a pad corner's bank (metres higher) are equidistant: the
        // target jumped by the wall's height times the feather weight there. The blend tightens to the nearest one at
        // the levelled edge itself (no seam with the levelled ground).
        const cand: [number, number, number][] = [];
        for (const e of edges) {
          const q = segDist(x, z, e.a, e.b);
          const px = e.a[0] + (e.b[0] - e.a[0]) * q.t, pz = e.a[1] + (e.b[1] - e.a[1]) * q.t;
          cand.push([q.d, wallSet.has(e.i) ? baseY : padTarget(px, pz), outlineFeather(e.i, q.t)]);
        }
        stripRects.forEach((r, k) => {
          const e = edges[stripEdge[k]!]!;
          cand.push([orDist(r, x, z), baseY, outlineFeather(e.i, segDist(x, z, e.a, e.b).t)]);
        });
        let best = Infinity;
        for (const c of cand) best = Math.min(best, c[0]);
        const tau = TARGET_BLEND * Math.min(1, best / 2) + 1e-6;
        let ks = 0, tq = 0, fq = 0;
        for (const [d, t, f] of cand) { const kw = Math.exp(-(d - best) / tau); ks += kw; tq += kw * t; fq += kw * f; }
        tq /= ks; fq /= ks;
        // held ground below gives the feather way, but only as it leaves this terrace's own edge (fully a third of the way out): at the
        // edge the weight is still 1, so the levelled ground and its feather meet without a seam
        const sm = smooth(0, fq, best);
        w = (1 - sm) * (opts.hold ? 1 - opts.hold(x, z) * smooth(0, HOLD_TAKEOVER, sm) : 1);
        v = tq;
      }
      heights[i + j * columns] = r2(v);
      weights[i + j * columns] = Math.round(w * 1000) / 1000;
    }
  }
  fingerprint = groundFingerprint(recipe, ox, oz, columns, rows, spacing);
  const patch: HeightPatchDoc = { id: fid, origin: [ox, oz], size: [ex - ox, ez - oz], columns, rows, heights, weights, blend: 2, filter: 0 };

  const cx0 = Math.min(bx0, rx0) - 1, cz0 = Math.min(bz0, rz0) - 1, cx1 = Math.max(bx1, rx1) + 1, cz1 = Math.max(bz1, rz1) + 1;
  const clearing: ClearingDoc = { id: fid, polygon: [[cx0, cz0], [cx1, cz0], [cx1, cz1], [cx0, cz1]], feather: 3, keep: 0, scatter: true, cover: true, owner: doc.owner ?? doc.id };

  // NATURAL SHELVES wear the zone's rock cap exactly as the loose rocks do: the world's rock material (the one its
  // rock-kit scatter rules draw with: the rock-cap shader) and a per-placement `mesh.source.rockCap` resolved by the
  // same resolver scatter uses, from that rule's cap settings, at the piece's top. Resolved at fit time: a refit
  // picks up a changed zone cap.
  if (style === "natural") {
    const rule = recipe.scatter.find((r) => /^rock-kit\//.test(r.model ?? r.prefab ?? "") && r.material && r.cap);
    if (!rule) warnings.push("no rock-kit scatter rule with a material and a cap in this world: shelves keep the kit's bare material");
    else {
      const capOf = createRockCapResolver(ground);
      for (const p of pieces) {
        if (!p.prefab.startsWith("rock-kit/")) continue;
        const root = kit.prefabRoot?.(p.prefab) ?? "rock";
        const a = (p.yaw * Math.PI) / 180, half = (p.run ?? 4) / 2;
        const cx = p.position[0] + Math.cos(a) * half, cz = p.position[2] - Math.sin(a) * half;
        const cap = capOf(rule, cx, topY, cz);
        p.overrides = [
          ...(p.overrides ?? []),
          { path: `${root}/components/mesh/material`, value: rule.material },
          ...(cap ? [{ path: `${root}/components/mesh/source/rockCap`, value: cap }] : []),
        ];
      }
    }
  }

  const solved: TerraceWallSolved = {
    style, topY, baseY, height,
    runs: runs.map((r) => ({ edges: r.edges, closed: r.closed })),
    faces, pieces, sockets, cuts,
    derived: { patch: fid, passages: passages.map((p) => p.id), clearing: fid },
    ground: fingerprint,
    warnings,
  };
  // keep the caller's footprint as written (its winding is what their edge indices mean)
  return { doc: { ...doc, solved }, patch, passages, clearing };
}

/** Put a fit into a recipe: replace the doc and exactly its derived features (appended last, so its patch wins). */
export function applyTerraceFit(recipe: WorldRecipe, fit: TerraceFit): void {
  removeTerrace(recipe, fit.doc.id, false);
  const list = (recipe.features.terraceWalls ??= []);
  const at = list.findIndex((t) => t.id === fit.doc.id);
  if (at >= 0) list[at] = fit.doc; else list.push(fit.doc);
  recipe.features.heightPatches.push(fit.patch);
  (recipe.features.passages ??= []).push(...fit.passages);
  (recipe.features.clearings ??= []).push(fit.clearing);
}

/** Remove a terrace's derived features (and the doc too, unless `keepDoc`). */
export function removeTerrace(recipe: WorldRecipe, id: string, dropDoc = true): void {
  const fid = terraceWallFeatureId(id);
  const own = (x: string) => x === fid || x.startsWith(`${fid}-`);
  recipe.features.heightPatches = recipe.features.heightPatches.filter((p) => !own(p.id));
  recipe.features.passages = (recipe.features.passages ?? []).filter((p) => !own(p.id));
  if (recipe.features.clearings) recipe.features.clearings = recipe.features.clearings.filter((c) => c.id !== fid);
  if (dropDoc && recipe.features.terraceWalls) recipe.features.terraceWalls = recipe.features.terraceWalls.filter((t) => t.id !== id);
}

// ------------------------------------------------------------------ gates

export interface TerraceGateReport {
  id: string;
  ok: boolean;
  lips: { alias: number; step: number; lip: number; worst: number };
  seated: { foot: { gap: number; clip: number }; pad: { gap: number; clip: number } };
  riser: { gutter: number; against: number };
  stale: boolean;
  lines: string[];
}

/** The gates for one fitted terrace's footprint: lips (its patch), seated (foot strip + pad), riser probe, staleness. */
export function terraceGates(recipe: WorldRecipe, doc: TerraceWallDoc, opts: { field?: WorldField; faults?: boolean } = {}): TerraceGateReport {
  const s = doc.solved;
  if (!s) throw new Error(`terrace ${doc.id} is not fitted`);
  const field = opts.field ?? createWorldField(recipe);
  const fid = terraceWallFeatureId(doc.id);
  const lines: string[] = [];
  // lips: what THIS terrace's patch adds over the same world without it (the lips gate's measure, with its own
  // reference: the world-wide gate's reference drops every patch and road, so a trail's own teeth inside this
  // raster would be charged to the terrace). The wall's lattice cell is exempt, as in `worldgen lips`.
  const patch = recipe.features.heightPatches.find((p) => p.id === fid);
  const lips = { alias: 0, step: 0, lip: 0, worst: 0 };
  if (patch) {
    const reference = createWorldField(naturalRecipe(recipe, doc.id));
    const riser = terraceRiserBand(recipe);
    const rep = measureTerrainLips(field, reference, {
      x0: patch.origin[0] - 6, z0: patch.origin[1] - 6, x1: patch.origin[0] + patch.size[0] + 6, z1: patch.origin[1] + patch.size[1] + 6,
      include: (x, z) => !riser(x, z),
    });
    Object.assign(lips, { alias: rep.counts.alias, step: rep.counts.step, lip: rep.counts.lip, worst: r2(Math.max(rep.worst.alias, rep.worst.step, rep.worst.lip)) });
    if (opts.faults) for (const f of rep.faults) lines.push(`    ${f.kind} @ ${f.x},${f.z} ${f.size} m`);
  }
  // seated: the foot strip at baseY, sampled through the DENSITY (the cut is a 3D carve that latticeHeight cannot
  // see: the heightfield holds a berm on the face line that the cut removes)
  const foot = { gap: 0, clip: 0 }, pad = { gap: 0, clip: 0 };
  const stairy = s.pieces.filter((p) => /stair|ramp|door/.test(p.role));
  const strip = Math.min(doc.strip, 2.5);
  for (const f of s.faces) {
    const len = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
    const dir: V2 = [(f.b[0] - f.a[0]) / len, (f.b[1] - f.a[1]) / len];
    for (let t = 0.5; t < len; t += 1) {
      for (let d = 0.4; d < strip; d += 0.6) {
        const g = field.surfaceCast(f.a[0] + dir[0] * t + f.normal[0] * d, f.a[1] + dir[1] * t + f.normal[1] * d, s.topY + 4, s.baseY - 3);
        if (g === null) continue;
        foot.gap = Math.max(foot.gap, r2(s.baseY - g)); foot.clip = Math.max(foot.clip, r2(g - s.baseY));
      }
    }
  }
  // seated: the pad at topY, 2x2 slabs on a 4 m lattice at least 2.5 m from any face and 1.5 m from the outline
  const { poly } = normaliseFootprint(doc.footprint);
  const es = edgesOf(poly);
  const faceSegs = s.faces.map((f) => [f.a, f.b] as [V2, V2]);
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (const [x, z] of poly) { bx0 = Math.min(bx0, x); bz0 = Math.min(bz0, z); bx1 = Math.max(bx1, x); bz1 = Math.max(bz1, z); }
  const endPieces = s.pieces.filter((p) => p.role.startsWith("end-"));
  for (let z = bz0 + 2; z < bz1; z += 4) {
    for (let x = bx0 + 2; x < bx1; x += 4) {
      if (!inPoly(poly, x, z)) continue;
      if (es.some((e) => segDist(x, z, e.a, e.b).d < 2.5)) continue;
      if (faceSegs.some(([a, b]) => segDist(x, z, a, b).d < 3.5)) continue;
      // the banks behind stepped ends (and past the open end) are lower than the pad by design
      if (endPieces.some((p) => Math.hypot(x - p.position[0], z - p.position[2]) < 3 * (p.run ?? 4) + 2)) continue;
      if (stairy.some((p) => Math.hypot(x - p.position[0], z - p.position[2]) < 6)) continue;
      const r = seatReport(field, { x, z, halfX: 1, halfZ: 1, yaw: 0, baseY: s.topY });
      pad.gap = Math.max(pad.gap, r.gap); pad.clip = Math.max(pad.clip, r.clip);
    }
  }
  // riser probe through the DENSITY (the cut is a 3D carve the heightfield cannot see): behind the coping the pad
  // must be at topY (no gutter), in front of the face the ground at baseY (nothing heaped against the wall)
  const riser = { gutter: 0, against: 0 };
  const worstAt = { gutter: "", against: "" };
  // skip the stretches of special pieces (their own tops, banks and landings): the piece's run along its face
  const skip = s.pieces.filter((p) => /stair|ramp|door|end-|corner/.test(p.role)).map((p) => {
    const a = (p.yaw * Math.PI) / 180, run = p.run ?? 4;
    return { a: [p.position[0], p.position[2]] as V2, b: [p.position[0] + Math.cos(a) * run, p.position[2] - Math.sin(a) * run] as V2 };
  });
  for (const f of s.faces) {
    const len = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
    const dir: V2 = [(f.b[0] - f.a[0]) / len, (f.b[1] - f.a[1]) / len];
    for (let t = 1; t < len; t += 1) {
      const x = f.a[0] + dir[0] * t, z = f.a[1] + dir[1] * t;
      if (skip.some((q) => segDist(x, z, q.a, q.b).d < 1.5)) continue;
      for (const d of [0.9, 1.5]) {
        const px = x - f.normal[0] * d, pz = z - f.normal[1] * d;
        const g = field.surfaceCast(px, pz, s.topY + 4, s.baseY - 3);
        if (g !== null && s.topY - g > riser.gutter) { riser.gutter = s.topY - g; worstAt.gutter = `${r2(px)},${r2(pz)}`; }
      }
      const g = field.surfaceCast(x + f.normal[0] * 0.4, z + f.normal[1] * 0.4, s.topY + 4, s.baseY - 3);
      if (g !== null && g - s.baseY > riser.against) { riser.against = g - s.baseY; worstAt.against = `${r2(x + f.normal[0] * 0.4)},${r2(z + f.normal[1] * 0.4)}`; }
    }
  }
  riser.gutter = r2(Math.max(0, riser.gutter)); riser.against = r2(Math.max(0, riser.against));
  // staleness: the ground the fit was solved on
  let stale = false;
  if (patch) {
    stale = Math.abs(groundFingerprint(recipe, patch.origin[0], patch.origin[1], patch.columns, patch.rows, patch.size[0] / (patch.columns - 1)) - s.ground) > 0.05;
  } else stale = true;
  const lipsOk = lips.alias + lips.step + lips.lip === 0;
  const seatOk = foot.gap <= 0.25 && foot.clip <= 0.6 && pad.gap <= 0.25 && pad.clip <= 0.6;
  const riserOk = riser.gutter <= 0.25 && riser.against <= 0.3;
  lines.push(`  lips   ${lipsOk ? "ok  " : "FAIL"} alias ${lips.alias}, step ${lips.step}, lip ${lips.lip}${lips.worst ? `; worst ${lips.worst} m` : ""}`);
  lines.push(`  seated ${seatOk ? "ok  " : "FAIL"} foot gap ${foot.gap} / clip ${foot.clip} m; pad gap ${pad.gap} / clip ${pad.clip} m (limits 0.25 / 0.6)`);
  lines.push(`  riser  ${riserOk ? "ok  " : "FAIL"} gutter behind the coping ${riser.gutter} m${riser.gutter > 0.25 ? ` @ ${worstAt.gutter}` : ""} (<= 0.25), ground against the face ${riser.against} m${riser.against > 0.3 ? ` @ ${worstAt.against}` : ""} (<= 0.3)`);
  if (stale) lines.push(`  STALE  the ground under it changed since the fit: worldgen terrace-place --refit --id ${doc.id}`);
  return { id: doc.id, ok: lipsOk && seatOk && riserOk && !stale, lips, seated: { foot, pad }, riser, stale, lines };
}

// ------------------------------------------------------------------ command

export interface TerracePlaceHost {
  argv: string[];
  project: string;
  loadRecipe(): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
}

const str = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
const all = (argv: string[], name: string): string[] => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));
const pts = (s: string): V2[] => s.trim().split(/\s+/).map((p) => p.split(",").map(Number) as V2);

/** Turn a wall line (pad on its LEFT) into footprint + wall edges. */
export function footprintFromPath(path: V2[], depth = 8, closed = false): { footprint: V2[]; walls: number[] } {
  if (closed) return { footprint: path, walls: path.map((_, i) => i) };
  if (path.length === 2) {
    const [a, b] = path as [V2, V2];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const left: V2 = [((b[1] - a[1]) / len) * depth, (-(b[0] - a[0]) / len) * depth];
    return { footprint: [a, b, [b[0] + left[0], b[1] + left[1]], [a[0] + left[0], a[1] + left[1]]], walls: [0] };
  }
  return { footprint: path, walls: path.slice(0, -1).map((_, i) => i) };
}

function docsFromArgs(host: TerracePlaceHost): TerraceWallDoc[] {
  const { argv } = host;
  const spec = str(argv, "spec");
  if (spec) {
    const raw = JSON.parse(fs.readFileSync(spec, "utf8"));
    return (Array.isArray(raw) ? raw : [raw]).map((d) => terraceWallSchema.parse(d));
  }
  const id = str(argv, "id");
  if (!id) host.fail("terrace-place: give --spec <file.json> or --id <slug> with --footprint / --path");
  const fp = str(argv, "footprint"), wallPath = str(argv, "path");
  let footprint: V2[], walls: "auto" | number[] = "auto";
  if (fp) footprint = pts(fp);
  else if (wallPath) ({ footprint, walls } = footprintFromPath(pts(wallPath), Number(str(argv, "depth") ?? 8), argv.includes("--closed")));
  else host.fail("terrace-place: --footprint \"x,z x,z ...\" or --path \"x,z x,z ...\"");
  const w = str(argv, "walls");
  if (w && w !== "auto") walls = w.split(",").map(Number);
  const inserts = all(argv, "insert").map((s) => {
    const m = /^([\w-]+)@([\d.]+)(?::(\d+))?$/.exec(s);
    if (!m) host.fail(`--insert ${s}: want <role>@<metres>[:<edge>]`);
    return { role: m[1], at: Number(m[2]), edge: m[3] ? Number(m[3]) : 0 };
  });
  const num = (k: string) => (str(argv, k) !== undefined ? Number(str(argv, k)) : undefined);
  return [terraceWallSchema.parse({
    id, footprint, walls, inserts,
    style: str(argv, "style") ?? "masonry-common",
    fallback: str(argv, "fallback"),
    height: num("height"), topY: num("top-y"), strip: num("strip"), wear: num("wear"), feather: num("feather"),
    owner: str(argv, "owner"), seed: str(argv, "seed"),
  })];
}

/** Re-read the recipe file, apply `mutate`, validate, write: never clobbers what another tool wrote meanwhile. */
function writeFresh(host: TerracePlaceHost, mutate: (r: WorldRecipe) => void): void {
  const { recipe, file } = host.loadRecipe();
  mutate(recipe);
  const parsed = worldRecipeSchema.safeParse(recipe);
  if (!parsed.success) host.fail(`refusing to write an invalid recipe:\n${parsed.error.message}`);
  host.writeRecipe(parsed.data, file);
}

export function commandTerracePlace(host: TerracePlaceHost): void {
  const { argv } = host;
  const dry = argv.includes("--dry-run");
  const gates = !argv.includes("--no-gates");
  const remove = str(argv, "remove");
  if (remove) {
    if (!dry) writeFresh(host, (r) => removeTerrace(r, remove));
    console.log(`removed terrace ${remove} and its tw-${remove}* features`);
    return;
  }
  const { recipe } = host.loadRecipe();
  const ids = (str(argv, "id") ?? "").split(",").filter(Boolean);
  const existing = recipe.features.terraceWalls ?? [];
  const pick = () => (argv.includes("--all") ? existing : existing.filter((t) => ids.includes(t.id)));
  if (argv.includes("--check")) {
    const field = createWorldField(recipe);
    let bad = 0;
    for (const t of pick()) {
      const g = terraceGates(recipe, t, { field, faults: argv.includes("--list") });
      console.log(`${g.ok ? "ok  " : "FAIL"} terrace ${t.id}`);
      for (const l of g.lines) console.log(l);
      if (!g.ok) bad++;
    }
    if (bad) process.exitCode = 1;
    return;
  }
  const docs = argv.includes("--refit") ? pick() : docsFromArgs(host);
  if (!docs.length) host.fail("terrace-place: nothing to fit (no matching --id, or no terraceWalls in the recipe)");
  const kit = loadTerraceKit(host.project);
  const work = structuredClone(recipe);
  const t0 = Date.now();
  // a town's risers share ground: refitting one refits the whole town, bottom-up (solveTerraceChain)
  const fits: TerraceFit[] = argv.includes("--refit") ? refitGrouped(work, docs, kit, console.log) : docs.map((d) => { const f = fitTerraceWall(work, d, kit, console.log); applyTerraceFit(work, f); return f; });
  for (const fit of fits) {
    const s = fit.doc.solved!;
    console.log(`terrace ${fit.doc.id}: ${s.style} ${s.height} m wall, pad ${s.topY} over foot ${s.baseY}; ${s.runs.length} run(s), ${s.pieces.length} pieces, ${s.cuts.length} cut(s), patch ${fit.patch.columns}x${fit.patch.rows}`);
    for (const w of s.warnings) console.log(`  ! ${w}`);
  }
  console.log(`  (${fits.length} fit(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  let bad = 0;
  if (gates) {
    const field = createWorldField(work);
    for (const f of fits) {
      const g = terraceGates(work, f.doc, { field });
      console.log(`${g.ok ? "ok  " : "FAIL"} gates ${f.doc.id}`);
      for (const l of g.lines) console.log(l);
      if (!g.ok) bad++;
    }
  }
  if (!dry) writeFresh(host, (r) => { for (const f of fits) applyTerraceFit(r, f); });
  else console.log("(dry run: nothing written)");
  if (bad) process.exitCode = 1;
}

/** Refit every terrace wall (owner filter optional) in place on `recipe`: the terrain-rebuild hook. A town's risers are solved together. */
export function refitTerraceWalls(recipe: WorldRecipe, kit: TerraceKit, filter: (t: TerraceWallDoc) => boolean = () => true, log: (s: string) => void = () => {}): TerraceFit[] {
  return refitGrouped(recipe, [...(recipe.features.terraceWalls ?? [])].filter(filter), kit, log);
}

// ------------------------------------------------------------------ town risers, solved together

/** A town riser wall (`worldgen terrace` writes `<town>-riser-<n>`, tag town-riser, owner = the town). */
const isTownRiser = (t: TerraceWallDoc) => t.tags.includes("town-riser") && !!t.owner;
/** Bottom-up: by the pad level the stage dictated, then by the riser number. */
function chainOrder(docs: readonly TerraceWallDoc[]): TerraceWallDoc[] {
  const num = (t: TerraceWallDoc) => Number(/-riser-(\d+)$/.exec(t.id)?.[1] ?? 0);
  return [...docs].sort((p, q) => (p.topY ?? p.solved?.topY ?? 0) - (q.topY ?? q.solved?.topY ?? 0) || num(p) - num(q));
}

/**
 * SOLVE A TOWN'S RISERS TOGETHER. Neighbouring risers share ground: the foot strip of riser k+1 is levelled on the
 * pad of riser k, and the pad of k+1 stands on the hill behind the open edge of k. Fitted one at a time they never
 * converge (each refit reads its neighbours' current patches and moves the ground under them). Here every riser of
 * the chain is lifted off first (patches, passages, clearings AND its solved cuts: the field carves those directly),
 * then they are fitted BOTTOM-UP, each against the heightfield with only the risers below it applied, and applied in
 * that order, so a higher pad always wins where two overlap. One pass, deterministic: refitting the chain again gives
 * the same result. `onFit` may veto a fit (returns false): that riser is left off and the chain carries on without it.
 */
export function solveTerraceChain(
  recipe: WorldRecipe,
  docs: readonly TerraceWallDoc[],
  kit: TerraceKit,
  log: (s: string) => void = () => {},
  onFit?: (fit: TerraceFit, k: number) => TerraceFit | null,
): TerraceFit[] {
  const chain = chainOrder(docs);
  // docs and derived features both: each riser goes back in (applyTerraceFit) as it is fitted, in chain order
  for (const d of chain) removeTerrace(recipe, d.id);
  const fits: TerraceFit[] = [];
  const voxel = recipe.cellSize / recipe.resolution;
  for (const [k, d] of chain.entries()) {
    let fit = fitTerraceWall(recipe, { ...d, solved: undefined }, kit, log, { hold: holdOf(fits, voxel) });
    if (onFit) {
      const kept = onFit(fit, k);
      if (!kept) continue;
      fit = kept;
    }
    applyTerraceFit(recipe, fit);
    fits.push(fit);
  }
  return fits;
}

/**
 * The FOOT STRIPS of fits already made (the levelled low ground in front of every face, where the face cut clips the
 * ground to the wall foot), as a TerraceFitOptions.hold: 1 on the strip, easing to 0 over HOLD_EASE metres beyond
 * it. Only the strips: a lower pad, its stepped-end banks and its feather may be overridden by the terrace above (a
 * hold on the whole lower patch killed the upper strip's feather in one cell where it ran over a lower end bank).
 */
export function holdOf(fits: readonly TerraceFit[], voxelSize: number): ((x: number, z: number) => number) | undefined {
  void voxelSize;
  const strips = fits.flatMap((f) => {
    const depth = Math.max(f.doc.strip, CUT_FRONT + 0.5);
    return (f.doc.solved?.faces ?? []).map((fc) => {
      const len = Math.hypot(fc.b[0] - fc.a[0], fc.b[1] - fc.a[1]);
      return { a: fc.a, dir: [(fc.b[0] - fc.a[0]) / len, (fc.b[1] - fc.a[1]) / len] as V2, n: fc.normal, len, depth };
    });
  });
  if (!strips.length) return undefined;
  return (x, z) => {
    let h = 0;
    for (const st of strips) {
      const rx = x - st.a[0], rz = z - st.a[1];
      const u = rx * st.dir[0] + rz * st.dir[1], v = rx * st.n[0] + rz * st.n[1];
      const d = Math.hypot(Math.max(-u, 0, u - st.len), Math.max(-v, 0, v - st.depth));
      if (d >= HOLD_EASE) continue;
      h = Math.max(h, 1 - smooth(0, HOLD_EASE, d));
      if (h >= 1) return 1;
    }
    return h;
  };
}

/** Refit a list of terraces: a town's risers as one chain (the whole town, whichever of them was named), the rest one by one. */
export function refitGrouped(recipe: WorldRecipe, docs: readonly TerraceWallDoc[], kit: TerraceKit, log: (s: string) => void = () => {}): TerraceFit[] {
  const out: TerraceFit[] = [];
  const towns = new Set(docs.filter(isTownRiser).map((t) => t.owner!));
  for (const town of towns) {
    const chain = (recipe.features.terraceWalls ?? []).filter((t) => isTownRiser(t) && t.owner === town);
    log(`  ${town}: ${chain.length} riser(s) solved together, bottom-up`);
    out.push(...solveTerraceChain(recipe, chain, kit, log));
  }
  for (const t of docs.filter((d) => !isTownRiser(d))) {
    const fit = fitTerraceWall(recipe, t, kit, log);
    applyTerraceFit(recipe, fit);
    out.push(fit);
  }
  return out;
}


// ------------------------------------------------------------------ town shelves (`worldgen terrace`)

/** Do segments ab and cd cross (touching counts)? */
function segmentsCross(a: V2, b: V2, c: V2, d: V2): boolean {
  const o = (p: V2, q: V2, r: V2) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

function distToPolyline(points: readonly (readonly [number, number])[], x: number, z: number): number {
  if (points.length === 1) return Math.hypot(x - points[0]![0], z - points[0]![1]);
  let d = Infinity;
  for (let i = 0; i + 1 < points.length; i++) d = Math.min(d, segDist(x, z, points[i] as V2, points[i + 1] as V2).d);
  return d;
}

/**
 * A rectilinear pad outline (pad on the left, 4 m grid) fitted INSIDE a town shelf (a thick polyline): the shelf is
 * cut into 8 m bins along its main axis, each bin keeps the across-extent every sample in it agrees on, bins whose
 * extents agree within 4 m merge (fewer jogs: a jog is a pair of corners in the wall), and the longest run of bins
 * is traced bottom profile out, top profile back. Null when nothing 8 m wide fits.
 */
export function shelfFootprint(points: readonly (readonly [number, number])[], radius: number, opts: { bin?: number; snap?: number; minCover?: number } = {}): V2[] | null {
  const bin = opts.bin ?? 8, snap = opts.snap ?? 4;
  const a = points[0]!, b = points[points.length - 1]!;
  const alongX = points.length === 1 || Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  const toWorld = (A: number, C: number): V2 => (alongX ? [A, C] : [C, A]);
  const inside = (A: number, C: number) => { const [x, z] = toWorld(A, C); return distToPolyline(points, x, z) <= radius; };
  let A0 = Infinity, A1 = -Infinity, C0 = Infinity, C1 = -Infinity;
  for (const p of points) { const A = alongX ? p[0] : p[1], C = alongX ? p[1] : p[0]; A0 = Math.min(A0, A - radius); A1 = Math.max(A1, A + radius); C0 = Math.min(C0, C - radius); C1 = Math.max(C1, C + radius); }
  const bins: { A: number; lo: number; hi: number }[] = [];
  for (let A = Math.floor(A0 / bin) * bin; A + bin <= Math.ceil(A1 / bin) * bin; A += bin) {
    let lo = -Infinity, hi = Infinity, ok = true;
    for (let s = A + 0.5; s < A + bin; s += 1) {
      let l = Infinity, h = -Infinity;
      for (let c = Math.floor(C0); c <= Math.ceil(C1); c += 1) if (inside(s, c)) { l = Math.min(l, c); h = Math.max(h, c); }
      if (!(h > l)) { ok = false; break; }
      lo = Math.max(lo, l); hi = Math.min(hi, h);
    }
    lo = Math.ceil(lo / snap) * snap; hi = Math.floor(hi / snap) * snap;
    bins.push(ok && hi - lo >= 8 ? { A, lo, hi } : { A, lo: NaN, hi: NaN });
  }
  // longest chain of valid bins, each sharing at least 8 m of its across-extent with the one before (a shelf at an
  // angle steps across as it goes; two bins that only touch would pinch the outline into two pads)
  let best: typeof bins = [], cur: typeof bins = [];
  for (const q of bins) {
    const prev = cur[cur.length - 1];
    if (Number.isNaN(q.lo) || (prev && Math.min(prev.hi, q.hi) - Math.max(prev.lo, q.lo) < 8)) {
      if (cur.length > best.length) best = cur;
      cur = Number.isNaN(q.lo) ? [] : [q];
    } else cur.push(q);
  }
  if (cur.length > best.length) best = cur;
  if (!best.length) return null;
  // merge neighbours whose extents agree within a jog
  const groups: { A0: number; A1: number; lo: number; hi: number }[] = [];
  const overlap = (p: { lo: number; hi: number }, q: { lo: number; hi: number }) => Math.min(p.hi, q.hi) - Math.max(p.lo, q.lo);
  for (const q of best) {
    const g = groups[groups.length - 1], before = groups[groups.length - 2];
    const merged = g ? { lo: Math.max(g.lo, q.lo), hi: Math.min(g.hi, q.hi) } : null;
    if (g && merged && Math.abs(g.lo - q.lo) <= snap && Math.abs(g.hi - q.hi) <= snap && merged.hi - merged.lo >= 8 && (!before || overlap(before, merged) >= 8)) {
      g.A1 = q.A + bin; g.lo = merged.lo; g.hi = merged.hi;
    } else if (!g || overlap(g, q) >= 8) groups.push({ A0: q.A, A1: q.A + bin, lo: q.lo, hi: q.hi });
    else break; // merging shrank the last group off this bin: the outline would pinch, so it ends here
  }
  const poly: V2[] = [];
  for (const g of groups) poly.push(toWorld(g.A0, g.lo), toWorld(g.A1, g.lo));
  for (const g of [...groups].reverse()) poly.push(toWorld(g.A1, g.hi), toWorld(g.A0, g.hi));
  // drop duplicates and collinear points
  let out = poly.filter((p, i) => { const q = poly[(i + 1) % poly.length]!; return p[0] !== q[0] || p[1] !== q[1]; });
  out = out.filter((p, i) => {
    const prev = out[(i + out.length - 1) % out.length]!, next = out[(i + 1) % out.length]!;
    return !((prev[0] === p[0] && p[0] === next[0]) || (prev[1] === p[1] && p[1] === next[1]));
  });
  if (out.length < 4) return null;
  return signedArea(out) > 0 ? [out[0]!, ...out.slice(1).reverse()] : out;
}

/**
 * A town shelf's pad outline at ANY heading: its centreline (a thick polyline) offset by the half-width less 1.5 m on
 * both sides, mitred at the bends, closed by its two end edges; pad on the left. The fit puts the wall runs on the
 * 2 m / 5 deg run grid. A one-point shelf is a square. `cap(p, m)`, when given, limits the half-width at centreline
 * vertex p offset along the unit direction m (never under 4 m): how `townShelfOutlines` keeps neighbours apart.
 */
export function shelfOutline(points: readonly (readonly [number, number])[], radius: number, cap?: (p: V2, m: V2) => number): V2[] | null {
  const pts = shelfCentreline(points);
  const w = Math.max(4, radius - 1.5);
  if (pts.length === 1) {
    const [x, z] = pts[0]!, h = Math.round(w / 2) * 2;
    return [[x - h, z + h], [x + h, z + h], [x + h, z - h], [x - h, z - h]];
  }
  const dir = (i: number): V2 => { const a = pts[i]!, b = pts[i + 1]!; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const side = (k: 1 | -1): V2[] => {
    const out: V2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const dPrev = i > 0 ? dir(i - 1) : dir(0), dNext = i < pts.length - 1 ? dir(i) : dir(pts.length - 2);
      const nPrev: V2 = [-dPrev[1] * k, dPrev[0] * k], nNext: V2 = [-dNext[1] * k, dNext[0] * k];
      // mitre: the offset lines of the two segments meet; held to 2 w so a sharp bend does not spike
      let m: V2 = [nPrev[0] + nNext[0], nPrev[1] + nNext[1]];
      const ml = Math.hypot(m[0], m[1]) || 1;
      m = [m[0] / ml, m[1] / ml];
      const cos = Math.max(0.5, m[0] * nNext[0] + m[1] * nNext[1]);
      const wi = cap ? Math.max(4, Math.min(w, cap(pts[i]!, m))) : w;
      out.push([r3(pts[i]![0] + m[0] * (wi / cos)), r3(pts[i]![1] + m[1] * (wi / cos))]);
    }
    return out;
  };
  const right = side(1), left = side(-1);
  const poly = [...right, ...left.reverse()];
  return signedArea(poly) > 0 ? [poly[0]!, ...poly.slice(1).reverse()] : poly;
}

/** A shelf centreline with vertices closer than 4 m merged (what `shelfOutline` offsets). */
export function shelfCentreline(points: readonly (readonly [number, number])[]): V2[] {
  const pts: V2[] = [];
  for (const p of points) if (!pts.length || Math.hypot(p[0] - pts[pts.length - 1]![0], p[1] - pts[pts.length - 1]![1]) > 4) pts.push([p[0], p[1]]);
  return pts;
}

/**
 * Trim a shelf centreline to the along-contour stretch of another (projected on that one's end-to-end axis, `inset`
 * metres inside its ends). Unchanged when it already lies within; null when what is left is under 16 m (then it is
 * left as it was: a short upper pad is worse than a long one that overhangs).
 */
export function trimShelfTo(points: readonly (readonly [number, number])[], below: readonly (readonly [number, number])[], inset = 2): [number, number][] | null {
  const a = below[0]!, b = below[below.length - 1]!;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const pts = points.map((p) => [p[0], p[1]] as [number, number]);
  if (len < 1 || pts.length < 2) return pts;
  const ax: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  // only a shelf running along the one below (within 35 deg): one that climbs across it stands on its END, not its length
  const p0 = pts[0]!, p1 = pts[pts.length - 1]!, l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (l1 > 1 && Math.abs(((p1[0] - p0[0]) * ax[0] + (p1[1] - p0[1]) * ax[1]) / l1) < Math.cos((35 * Math.PI) / 180)) return pts;
  const proj = (p: readonly [number, number]) => (p[0] - a[0]) * ax[0] + (p[1] - a[1]) * ax[1];
  const lo = inset, hi = len - inset;
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, t = proj(p);
    if (t >= lo && t <= hi) out.push(p);
    const q = pts[i + 1];
    if (!q) break;
    const u = proj(q);
    // where the segment crosses either end of the range, in order along it
    const hits = [lo, hi].map((c) => (u !== t ? (c - t) / (u - t) : -1)).filter((f) => f > 0 && f < 1).sort((x, y) => x - y);
    for (const f of hits) out.push([r2(p[0] + (q[0] - p[0]) * f), r2(p[1] + (q[1] - p[1]) * f)]);
  }
  const dedup = out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1]![0], p[1] - out[i - 1]![1]) > 0.5);
  if (dedup.length < 2) return null;
  let run = 0;
  for (let i = 1; i < dedup.length; i++) run += Math.hypot(dedup[i]![0] - dedup[i - 1]![0], dedup[i]![1] - dedup[i - 1]![1]);
  return run >= 16 ? dedup : null;
}

/** A shelf centreline with `cut` metres taken off the end nearer the points given (null when under 16 m would be left). */
export function shortenShelf(points: readonly (readonly [number, number])[], near: readonly V2[], cut: number): [number, number][] | null {
  const pts = points.map((p) => [p[0], p[1]] as [number, number]);
  if (pts.length < 2 || !near.length) return null;
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (len - cut < 16) return null;
  const d = (p: readonly [number, number]) => Math.min(...near.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1])));
  const fromStart = d(pts[0]!) <= d(pts[pts.length - 1]!);
  const line = fromStart ? pts.reverse() : pts;
  // walk back from the far end by `cut`
  let left = cut;
  while (line.length >= 2 && left > 0) {
    const a = line[line.length - 2]!, b = line[line.length - 1]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l <= left + 1e-6) { line.pop(); left -= l; continue; }
    const f = (l - left) / l;
    line[line.length - 1] = [r2(a[0] + (b[0] - a[0]) * f), r2(a[1] + (b[1] - a[1]) * f)];
    left = 0;
  }
  return fromStart ? line.reverse() : line;
}

/** Do two closed outlines overlap (an edge crossing, or one inside the other)? */
export function outlinesOverlap(a: readonly V2[], b: readonly V2[]): boolean {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) if (segmentsCross(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
  return inPoly(b, a[0]![0], a[0]![1]) || inPoly(a, b[0]![0], b[0]![1]);
}

/**
 * The pad outlines of a stepped town's shelves, NEIGHBOURS KEPT APART. Each shelf is its centreline offset by its
 * half-width (radius - 1.5 m); where another shelf's centreline lies within reach on that side, the half-width there
 * is held so the two pads share the gap (each takes half, or what the other's own width leaves: they meet, they do
 * not overlap). Overlapping pads were the worst fault of the one-at-a-time fits: the later patch buried the earlier
 * pad (ground 5.7 m through it) and an upper pad's foot strip reached the face of the wall below. Checked as
 * polygons after: a pair that still overlaps (bends, ends) gives up another metre each round, at most six.
 */
export function townShelfOutlines(
  shelves: readonly { points: readonly (readonly [number, number])[]; radius: number; groundY?: number }[],
  opts: { ground?: (x: number, z: number) => number; maxCut?: number } = {},
): (V2[] | null)[] {
  const lines = shelves.map((s) => shelfCentreline(s.points));
  const widths = shelves.map((s) => Math.max(4, s.radius - 1.5));
  const margin = shelves.map(() => 0.25);
  const maxCut = opts.maxCut ?? MAX_PAD_CUT;
  const capFor = (k: number) => (p: V2, m: V2): number => {
    let cap = Infinity;
    // NOT CUT DEEP INTO A HILL: the pad's edge stops where the natural ground just beyond it stands more than maxCut
    // over the pad. A pad notched into a hill steeper than its feather can climb back up drew a 3-5 m cut bank of
    // lattice steps along its uphill side.
    const level = shelves[k]!.groundY;
    if (opts.ground && level !== undefined) {
      for (let w = 4; w <= widths[k]! + 1e-9; w += 1) {
        if (opts.ground(p[0] + m[0] * (w + 1), p[1] + m[1] * (w + 1)) - level > maxCut) { cap = Math.max(4, w - 1); break; }
      }
    }
    for (const [j, line] of lines.entries()) {
      if (j === k) continue;
      // nearest point of the other centreline, and only if it lies on this side
      let best = Infinity, q: V2 = line[0]!;
      if (line.length === 1) { best = Math.hypot(p[0] - q[0], p[1] - q[1]); }
      else for (let i = 0; i + 1 < line.length; i++) {
        const r = segDist(p[0], p[1], line[i]!, line[i + 1]!);
        if (r.d < best) { best = r.d; q = [line[i]![0] + (line[i + 1]![0] - line[i]![0]) * r.t, line[i]![1] + (line[i + 1]![1] - line[i]![1]) * r.t]; }
      }
      const toward = ((q[0] - p[0]) * m[0] + (q[1] - p[1]) * m[1]) / Math.max(1e-6, best);
      if (toward < 0.3) continue;
      // the gap along m to that centreline (its perpendicular distance, opened up by the angle)
      const gap = best / toward;
      cap = Math.min(cap, Math.max(gap / 2, gap - widths[j]!) - Math.max(margin[k]!, margin[j]!));
    }
    return cap;
  };
  let out = shelves.map((s, k) => shelfOutline(s.points, s.radius, capFor(k)));
  for (let round = 0; round < 6; round++) {
    let clash = false;
    for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
      if (!out[a] || !out[b] || !outlinesOverlap(out[a]!, out[b]!)) continue;
      margin[a]! += 1; margin[b]! += 1; clash = true;
    }
    if (!clash) break;
    out = shelves.map((s, k) => shelfOutline(s.points, s.radius, capFor(k)));
  }
  return out;
}

export interface TownRiserLink { k: number; kind: "ramp" | "stair"; at: V2; roads: string[] }

/** The retaining-wall style for a town: its building system (capitals and cities build in dressed stone), or a `walls:<style>` tag. */
export function townWallStyle(town: { tier?: string; tags: string[] }): "masonry-common" | "masonry-stone" {
  const tag = town.tags.find((t) => t.startsWith("walls:"))?.slice(6);
  if (tag === "stone" || tag === "masonry-stone") return "masonry-stone";
  if (tag === "common" || tag === "masonry-common") return "masonry-common";
  const tier = town.tier ?? (town.tags.includes("capital") ? "capital" : "town");
  return tier === "capital" || tier === "city" ? "masonry-stone" : "masonry-common";
}

/** Deepest a town pad's open edge may be cut into the natural hill beside it (m). */
const MAX_PAD_CUT = 3;
/**
 * Gap (m) between two shelf centrelines that takes a split shelf: the narrowest pads either side (4 m half-widths:
 * townShelfOutlines narrows them to make room), an 8 m pad between and 2 m of slack.
 */
const SPLIT_GAP = 18;
/** A drop this far (m) over the tallest wall is split into two terraces; less, the wall is held and the shelf moves down. */
const SPLIT_OVER = 1;

/**
 * A shelf between two others (a drop too tall for one wall split in two): its centreline runs halfway between
 * theirs, over the stretch where they are at least SPLIT_GAP apart; null when they never are.
 */
export function splitShelf<T extends { id: string; points: readonly (readonly [number, number])[]; radius: number; falloff: number; groundY: number; flatten: number; tags: string[] }>(
  lower: T, upper: T, townId: string, taken: readonly string[],
): T | null {
  const need = SPLIT_GAP;
  const a = shelfCentreline(lower.points), b = shelfCentreline(upper.points);
  // only between shelves that run along each other (within 35 deg): a shelf that climbs ACROSS the one below stands
  // on its end, and a band between them has no wall long enough for a stair
  const dirOf = (l: V2[]): V2 | null => { const p = l[0]!, q = l[l.length - 1]!; const d = Math.hypot(q[0] - p[0], q[1] - p[1]); return d > 1 ? [(q[0] - p[0]) / d, (q[1] - p[1]) / d] : null; };
  const da = dirOf(a), db = dirOf(b);
  if (da && db && Math.abs(da[0] * db[0] + da[1] * db[1]) < Math.cos((35 * Math.PI) / 180)) return null;
  const nearest = (p: V2, line: V2[]): { d: number; q: V2 } => {
    if (line.length === 1) return { d: Math.hypot(p[0] - line[0]![0], p[1] - line[0]![1]), q: line[0]! };
    let best = { d: Infinity, q: line[0]! };
    for (let i = 0; i + 1 < line.length; i++) {
      const r = segDist(p[0], p[1], line[i]!, line[i + 1]!);
      if (r.d < best.d) best = { d: r.d, q: [line[i]![0] + (line[i + 1]![0] - line[i]![0]) * r.t, line[i]![1] + (line[i + 1]![1] - line[i]![1]) * r.t] };
    }
    return best;
  };
  const pts: [number, number][] = [];
  let gap = Infinity;
  for (const p of a.length === 1 ? a : a.flatMap((p, i) => (i + 1 < a.length ? [p, [(p[0] + a[i + 1]![0]) / 2, (p[1] + a[i + 1]![1]) / 2] as V2] : [p]))) {
    const n = nearest(p, b);
    if (n.d < need) continue;
    gap = Math.min(gap, n.d);
    pts.push([r2((p[0] + n.q[0]) / 2), r2((p[1] + n.q[1]) / 2)]);
  }
  if (!pts.length || (pts.length > 1 && Math.hypot(pts[pts.length - 1]![0] - pts[0]![0], pts[pts.length - 1]![1] - pts[0]![1]) < 16)) return null;
  let n = 1;
  while (taken.includes(`${townId}-terrace-${n}`)) n++;
  return { ...lower, id: `${townId}-terrace-${n}`, points: pts, radius: r2(Math.max(5.5, Math.min(lower.radius, gap / 3 + 1.5))), groundY: lower.groundY, flatten: lower.flatten, tags: [...lower.tags, "split"] };
}

/** Remove every terrace wall a town owns (and its derived features). */
export function removeTownTerraceWalls(recipe: WorldRecipe, townId: string): void {
  // only the stage's own riser walls: a terrace someone else placed near the town (owner = the town) stays
  for (const t of [...(recipe.features.terraceWalls ?? [])]) if (t.owner === townId && t.tags.includes("town-riser")) removeTerrace(recipe, t.id);
}

/**
 * Turn a stepped town's shelves into terraces held up by retaining walls: shelf by shelf from the bottom, each
 * shelf's level re-snapped so its riser is a whole number of the kit's courses above the shelf below (the field's
 * shelf moves with it), walls where the ground falls away (auto), and each ramp / stair link the stage cut replaced
 * by a stair-turn (or a ramp where the stage made one and the wall is long enough) in the upper shelf's wall nearest
 * where the link left the lower shelf. Returns the link roads the walls replaced.
 */
export function townTerraceWalls(
  recipe: WorldRecipe,
  town: WorldRecipe["features"]["towns"][number],
  kit: TerraceKit,
  links: readonly TownRiserLink[],
  log: (s: string) => void = () => {},
  maxStep = 6,
): { dropRoads: string[]; fits: TerraceFit[] } {
  removeTownTerraceWalls(recipe, town.id);
  const style = townWallStyle(town);
  // the stage's link roads come off BEFORE the fits (the walls carry the stairs instead, and a road removed after a
  // fit would change the ground it was fitted on); one whose insert finds no wall goes back at the end
  const linkRoads = new Map(recipe.features.roads.filter((r) => links.some((l) => l.roads.includes(r.id))).map((r) => [r.id, r]));
  recipe.features.roads = recipe.features.roads.filter((r) => !linkRoads.has(r.id));
  const shelves = [...town.terraces].sort((p, q) => p.groundY - q.groundY);
  const dropRoads: string[] = [];
  const fits: TerraceFit[] = [];
  // LEVELS FIRST: every fit reads the town's shelves, so each level must be final before the first fit (a level
  // moved after a fit leaves that fit STALE). A riser is a whole number of courses, preferring a height the kit
  // already has within a course (fewer parametric heights built), held to maxStep (the shelf above moves down).
  const { lookup: kitLookup, key: kitKey } = kit.resolve(style);
  const kitHeights = Object.keys(kitLookup.styles[kitKey] ?? {}).map(Number);
  // the stage's link INTO each shelf (from the one below), by shelf: a split shelf shifts every index after it
  const linkInto = new Map<object, TownRiserLink>();
  for (const l of links) { const up = shelves[l.k + 1]; if (up) linkInto.set(up, l); }
  // the tallest riser one wall may be: the town's maxStep, never over the kit's tallest slice
  const tallest = Math.min(maxStep, Math.max(6.4, ...kitHeights.filter((h) => h <= 6.4 + 1e-9)), 6.4);
  const riserHeights: (number | undefined)[] = [];
  const heightFor = (drop: number) => {
    const want = Math.max(0.8, Math.min(tallest, drop));
    const near = kitHeights.filter((h) => h <= tallest + 1e-9).sort((p, q) => Math.abs(p - want) - Math.abs(q - want))[0];
    return near !== undefined && Math.abs(near - want) <= 0.4 ? near : kit.plan.snapHeight(want);
  };
  const tooTall = new Set<object>();
  let prevTop: number | null = null;
  for (let k = 0; k < shelves.length; k++) {
    const shelf = shelves[k]!;
    if (prevTop !== null) {
      const drop = shelf.groundY - prevTop;
      // TOO TALL FOR ONE WALL (by more than SPLIT_OVER): split the drop into two stacked terraces, a shelf of its own
      // between them, where the gap between the two shelves holds a third pad; otherwise (no room, or over two walls)
      // a graded voxel riser. Within SPLIT_OVER the wall is held to the tallest riser and the shelf moves down a little.
      if (drop > tallest + SPLIT_OVER) {
        const mid = drop <= 2 * tallest + 0.4 ? splitShelf(shelves[k - 1]!, shelf, town.id, [...town.terraces, ...shelves].map((t) => t.id)) : null;
        if (mid) {
          mid.groundY = r2(prevTop + heightFor(drop / 2));
          log(`    ${shelf.id}: ${drop.toFixed(1)} m above the shelf below - over one ${tallest} m wall: split, new shelf ${mid.id} at ${mid.groundY} between them`);
          town.terraces.push(mid);
          shelves.splice(k, 0, mid);
          // the stage's stair up from the lower shelf now climbs to the new one; the upper wall takes its own stair
          const link = linkInto.get(shelf);
          if (link) { linkInto.set(mid, link); linkInto.set(shelf, { ...link, roads: [] }); }
          k--; // the new shelf takes this slot; the old one is levelled next round against it
          continue;
        }
        // no room for a shelf between: holding the wall to the tallest riser would sink this shelf by the excess
        // into the hill (a cut bank of lattice steps along its back). It keeps its own level and its riser is the
        // field's graded voxel slope with the stage's ramp up it: the one place a town falls back to no wall.
        log(`    ${shelf.id}: ${drop.toFixed(1)} m above the shelf below, over one ${tallest} m wall, and ${drop > 2 * tallest + 0.4 ? "over two walls" : `no room between them for a split shelf (${SPLIT_GAP} m between centrelines that run along each other)`} - left as a graded voxel riser`);
        tooTall.add(shelf);
        prevTop = shelf.groundY;
        continue;
      } else if (drop > tallest + 0.2) log(`    ${shelf.id}: ${drop.toFixed(1)} m above the shelf below - held to a ${heightFor(drop)} m wall (the shelf moves down)`);
      const h = heightFor(drop);
      riserHeights[k] = h;
      shelf.groundY = r2(prevTop + h);
    }
    prevTop = shelf.groundY;
  }
  // bold steps (16 m bins, 8 m jogs): a contour at an angle becomes a few long walls and real corners, not a saw.
  // A shelf that gets a pad stops carving the field (flatten 0): the terrace's own patch is its flat ground, and the
  // wall is its riser; left carving, the shelf's flat apron would stand between the wall and the drop it retains.
  const area = (p: V2[] | null) => (p ? Math.abs(signedArea(p)) : 0);
  void area;
  // the shelf's own outline at any heading: its centreline offset both ways (walls follow the contour, no zigzag)
  // A TERRACE STANDS ON THE ONE BELOW: an upper shelf is trimmed to the stretch of contour the shelf below covers
  // (2 m inside its ends), so the upper wall's foot strip lies on the lower pad. Run on past it, the strip was fill
  // poured onto the open hillside beyond the lower pad's end, a lip where its feather met the falling ground.
  for (let k = 1; k < shelves.length; k++) {
    const trimmed = trimShelfTo(shelves[k]!.points, shelves[k - 1]!.points, 2);
    const was = shelves[k]!.points;
    if (trimmed && (trimmed.length !== was.length || trimmed.some((p, i) => p[0] !== was[i]![0] || p[1] !== was[i]![1]))) {
      log(`    ${shelves[k]!.id}: trimmed to the contour of ${shelves[k - 1]!.id} below it`);
      shelves[k]!.points = trimmed!;
    }
  }
  // ...neighbours kept apart: two pads that overlap bury one another (the later patch wins)
  const shelfGround = createWorldField(recipe);
  const footprints = townShelfOutlines(shelves, { ground: (x, z) => shelfGround.heightfield(x, z) });
  const voxel = recipe.cellSize / recipe.resolution;
  shelves.forEach((sh, k) => { if (footprints[k]) sh.flatten = 0; });
  let restored = false;
  // THE FALLBACK where no wall fits: the shelf carves its own flat ground again and its riser is the field's graded
  // voxel slope, never steeper than 1 : 1.25 over the drop to the shelf below (a 6 m drop over the stage's ~4.5 m
  // falloff drew as lattice steps beside the walls either side of it)
  const voxelRiser = (k: number) => {
    const sh = shelves[k]!;
    sh.flatten = 1;
    const drop = k > 0 ? Math.abs(sh.groundY - shelves[k - 1]!.groundY) : 0;
    sh.falloff = r2(Math.max(sh.falloff, 1.25 * drop));
    restored = true;
  };
  for (const [k, shelf] of shelves.entries()) {
    const footprint = footprints[k];
    // the walls below keep their foot strips: this pad's feather gives way over them
    const hold = holdOf(fits, voxel);
    if (!footprint) { log(`    ${shelf.id}: nothing 8 m wide fits inside the shelf - left as a voxel riser`); voxelRiser(k); continue; }
    if (tooTall.has(shelf)) { voxelRiser(k); continue; }
    // walls on the edges that face DOWN the town (toward the shelf below); the lowest shelf decides by the ground
    const centroid = (pts: readonly (readonly [number, number])[]): V2 => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    const walls = "auto" as const;
    let facing: V2 | undefined;
    const below = k > 0 ? shelves[k - 1] : undefined;
    if (below) {
      const [ax, az] = centroid(below.points), [bx, bz] = centroid(shelf.points);
      const l = Math.hypot(ax - bx, az - bz) || 1;
      const down: V2 = [(ax - bx) / l, (az - bz) / l];
      facing = down;
    }
    const height = riserHeights[k];
    const base: TerraceWallDoc = terraceWallSchema.parse({
      id: `${town.id}-riser-${k + 1}`, owner: town.id, style, footprint, walls, ...(facing ? { facing } : {}), topY: shelf.groundY,
      ...(height !== undefined ? { height } : {}), wear: 1, strip: 6, feather: 8, tags: ["town-riser"],
    });
    let fit: TerraceFit;
    try {
      fit = fitTerraceWall(recipe, base, kit, undefined, { hold });
    } catch (e) {
      log(`    ${shelf.id}: no wall (${(e as Error).message.replace(/^terrace [\w-]+: /, "")})`);
      voxelRiser(k); // no wall: the shelf carves its own flat ground and voxel riser again
      restored = true;
      continue;
    }
    // the stage's link from the shelf below up to this one becomes a wall insert
    const link = linkInto.get(shelf);
    if (link) {
      // nearest the link first; the planner refuses an insert inside a corner or a stepped end
      const placeLink = (doc: TerraceWallDoc, onto: TerraceFit): TerraceFit | null => {
        const s = onto.doc.solved!;
        const es = edgesOf(normaliseFootprint(doc.footprint).poly);
        const runOf = (role: string) => {
          const { lookup, key } = kit.resolve(style);
          const id = lookup.styles[key]?.[String(+s.height.toFixed(3))]?.[role];
          return id ? lookup.pieces[id]!.run : Infinity;
        };
        // the stage's kind first, then whatever else fits: a straight stair or a ramp before giving the riser up
        const choices = (link.kind === "ramp" ? ["ramp", "stair", "stair-turn"] : ["stair-turn", "stair", "ramp"]).map((role) => ({ role, run: runOf(role) }));
        const near = (i: number) => segDist(link.at[0], link.at[1], es[i]!.a, es[i]!.b).d;
        for (const i of s.runs.flatMap((r) => r.edges).sort((p, q) => near(p) - near(q))) {
          const e = es[i]!;
          for (const c of choices) {
            if (e.len < c.run + 4) continue;
            const proj = segDist(link.at[0], link.at[1], e.a, e.b).t * e.len;
            const tries = [...new Set([Math.round((proj - c.run / 2) / 2) * 2, Math.round((e.len - c.run) / 4) * 2, 2, e.len - c.run - 2].map((v) => Math.max(0, Math.min(e.len - c.run, v))))];
            for (const at of tries) {
              try {
                const got = fitTerraceWall(recipe, { ...doc, walls: s.runs.flatMap((r) => r.edges), inserts: [{ role: c.role as TerraceWallDoc["inserts"][number]["role"], edge: i, at, run: 4 }] }, kit, undefined, { hold });
                if (!got.doc.solved!.warnings.some((w) => /moved from/.test(w))) return got;
              } catch { /* does not fit here */ }
            }
          }
        }
        return null;
      };
      const placed = placeLink(base, fit);
      if (placed) { fit = placed; dropRoads.push(...link.roads); }
      else {
        // no wall takes a stair: this riser stays the stage's voxel riser with its graded ramp (a road may not run
        // into masonry, and a pad patch would erase the ramp's cut)
        log(`    ${shelf.id}: no wall edge long enough for a stair - left as a voxel riser with the stage's ${link.kind}`);
        voxelRiser(k);
        restored = true;
        continue;
      }
    }
    applyTerraceFit(recipe, fit);
    fits.push(fit);
    const s = fit.doc.solved!;
    const ups = s.pieces.filter((p) => /stair|ramp/.test(p.role)).map((p) => p.role);
    log(`    ${fit.doc.id}: ${s.style} ${s.height} m, pad ${s.topY}; ${s.pieces.filter((p) => !p.role.startsWith("cap")).length} pieces${ups.length ? ` incl. ${ups.join(", ")}` : ""}`);
  }
  // a shelf that went back to carving moved the ground under the fits before it: solve the town's walls again on
  // the final ground, together and bottom-up (one at a time, each refit moves the ground under its neighbours)
  if (restored) fits.splice(0, fits.length, ...solveTerraceChain(recipe, fits.map((f) => f.doc), kit));
  const lowest = shelves[0];
  if (lowest) town.groundY = lowest.groundY;
  const kept = [...linkRoads.values()].filter((r) => !dropRoads.includes(r.id));
  if (kept.length) {
    recipe.features.roads.push(...kept);
    // the kept roads change the ground the walls were fitted on: solve the chain again over them
    fits.splice(0, fits.length, ...solveTerraceChain(recipe, fits.map((f) => f.doc), kit));
    log(`    ${kept.length} link road(s) kept (no wall took their stair): ${kept.map((r) => r.id).join(", ")}; walls re-solved over them`);
  }
  // GATES, AND THE FALLBACK. A wall whose fit fails its gates (lips / seated / riser) after the joint solve does not
  // fit as it stands. Faults are often SHARED by neighbours (a lower foot strip under an upper feather) and mostly sit
  // at a run's END, so each failing riser is TRIED in turn, most faults first: SHORTENED (4 m, then 8 m off the end
  // of its shelf nearest the faults), and only then given up to the field's graded voxel riser (its shelf carves
  // again, its stage link road comes back). The first trial that lowers the town's count of failing walls is kept,
  // the rest are undone; when none does, the worst riser falls back anyway, so the loop ends with every remaining
  // wall passing. Each change is logged with the gate that failed.
  const shelfOfFit = (f: TerraceFit) => shelves.findIndex((_, k) => f.doc.id === `${town.id}-riser-${k + 1}`);
  // BUILDING PLOTS (the town's `<name>-plot-<building>` clearings, one per plot): a wall, or the stair or foot strip in
  // front of it, never stands in one. A built town's buildings were laid on its ground before its shelves were cut;
  // a riser through a plot is a wall through a house. Counted as a failing gate, so the fallback shortens or drops it.
  const plots = (recipe.features.clearings ?? []).filter((c) => c.owner === town.id && /-plot-/.test(c.id) && "polygon" in c && Array.isArray((c as { polygon?: V2[] }).polygon)).map((c) => ({ id: c.id, poly: (c as { polygon: V2[] }).polygon }));
  const plotHit = (f: TerraceFit): { id: string; at: V2 } | null => {
    for (const fc of f.doc.solved?.faces ?? []) {
      const len = Math.hypot(fc.b[0] - fc.a[0], fc.b[1] - fc.a[1]);
      for (let u = 0; u <= len; u += 1) for (const d of [-0.5, 1, 2.5]) {
        const x = fc.a[0] + ((fc.b[0] - fc.a[0]) / len) * u + fc.normal[0] * d, z = fc.a[1] + ((fc.b[1] - fc.a[1]) / len) * u + fc.normal[1] * d;
        const hit = plots.find((pl) => inPoly(pl.poly, x, z));
        if (hit) return { id: hit.id, at: [r2(x), r2(z)] };
      }
    }
    return null;
  };
  const gateAll = () => {
    const field = createWorldField(recipe);
    return fits.map((f) => {
      const g = terraceGates(recipe, f.doc, { field, faults: true });
      const hit = plots.length ? plotHit(f) : null;
      if (hit) { g.ok = false; g.lines.push(`  plots  FAIL the wall stands in building plot ${hit.id} @ ${hit.at[0]},${hit.at[1]}`); }
      return { f, g };
    }).filter((x) => !x.g.ok);
  };
  const faultsOf = (g: TerraceGateReport) => g.lips.alias + g.lips.step + g.lips.lip + (g.riser.gutter > 0.25 ? 1 : 0) + (g.riser.against > 0.3 ? 1 : 0) + (g.seated.pad.clip > 0.6 || g.seated.pad.gap > 0.25 ? 1 : 0) + (g.lines.some((l) => /plots +FAIL/.test(l)) ? 50 : 0);
  const whyOf = (g: TerraceGateReport) => g.lines.filter((l) => /FAIL|STALE/.test(l)).map((l) => l.trim().replace(/\s+/g, " ")).join("; ");
  const faultXZ = (g: TerraceGateReport): V2[] => g.lines.flatMap((l) => { const m = /@ (-?[\d.]+),\s*(-?[\d.]+)/.exec(l); return m ? [[Number(m[1]), Number(m[2])] as V2] : []; });
  const solveOrUndo = (docs: TerraceWallDoc[]): boolean => {
    try { fits.splice(0, fits.length, ...solveTerraceChain(recipe, docs, kit)); return true; } catch { return false; }
  };
  let failing = gateAll();
  for (let round = 0; round < 2 * shelves.length && failing.length; round++) {
    const order = [...failing].sort((p, q) => faultsOf(q.g) - faultsOf(p.g) || fits.indexOf(q.f) - fits.indexOf(p.f));
    const docs = fits.map((f) => f.doc);
    let done: { note: string; after: typeof failing } | null = null;
    for (const cand of order.slice(0, 3)) {
      const k = shelfOfFit(cand.f);
      const sh = k >= 0 ? shelves[k]! : null;
      const why = whyOf(cand.g);
      // 1. shorten the shelf at the end nearest its faults
      if (sh) {
        const pts0 = sh.points.map((q) => [q[0], q[1]] as [number, number]);
        const at = faultXZ(cand.g);
        for (const cut of [4, 8]) {
          const shorter = shortenShelf(pts0, at, cut);
          if (!shorter) break;
          sh.points = shorter;
          const fp = townShelfOutlines(shelves, { ground: (x, z) => shelfGround.heightfield(x, z) })[k];
          if (fp && solveOrUndo(docs.map((d) => (d.id === cand.f.doc.id ? { ...d, footprint: fp } : d)))) {
            const after = gateAll();
            if (after.length < failing.length) { done = { note: `${cand.f.doc.id}: fails its gates (${why}) - its shelf shortened ${cut} m at the end by its faults`, after }; break; }
          }
          sh.points = pts0;
        }
        if (done) break;
        sh.points = pts0;
        solveOrUndo(docs);
      }
      // 2. give it up to the field's graded voxel riser
      const undo = { flatten: sh?.flatten ?? 0, falloff: sh?.falloff ?? 0, back: [] as RoadDoc[] };
      if (sh) {
        voxelRiser(k);
        const link = linkInto.get(sh);
        undo.back = (link?.roads ?? []).filter((id) => dropRoads.includes(id)).map((id) => linkRoads.get(id)).filter((r): r is RoadDoc => !!r);
        for (const r of undo.back) { dropRoads.splice(dropRoads.indexOf(r.id), 1); recipe.features.roads.push(r); }
      }
      removeTerrace(recipe, cand.f.doc.id);
      solveOrUndo(docs.filter((d) => d.id !== cand.f.doc.id));
      const after = gateAll();
      if (after.length < failing.length || cand === order[Math.min(2, order.length - 1)]) {
        // kept: it helped, or it is the last candidate and nothing else did (the worst of them goes instead)
        if (after.length >= failing.length && cand !== order[0]) {
          // undo this one and give up the worst instead
          if (sh) { sh.flatten = undo.flatten; sh.falloff = undo.falloff; }
          for (const r of undo.back) { dropRoads.push(r.id); recipe.features.roads = recipe.features.roads.filter((x) => x.id !== r.id); }
          const w = order[0]!, kw = shelfOfFit(w.f);
          if (kw >= 0) {
            voxelRiser(kw);
            for (const id of (linkInto.get(shelves[kw]!)?.roads ?? []).filter((r) => dropRoads.includes(r))) { dropRoads.splice(dropRoads.indexOf(id), 1); const r = linkRoads.get(id); if (r) recipe.features.roads.push(r); }
          }
          removeTerrace(recipe, w.f.doc.id);
          solveOrUndo(docs.filter((d) => d.id !== w.f.doc.id));
          done = { note: `${w.f.doc.id}: fails its gates (${whyOf(w.g)}) - fell back to a graded voxel riser`, after: gateAll() };
        } else done = { note: `${cand.f.doc.id}: fails its gates (${why}) - fell back to a graded voxel riser`, after };
        break;
      }
      if (sh) { sh.flatten = undo.flatten; sh.falloff = undo.falloff; }
      for (const r of undo.back) { dropRoads.push(r.id); recipe.features.roads = recipe.features.roads.filter((x) => x.id !== r.id); }
      solveOrUndo(docs);
    }
    if (!done) break;
    log(`    ${done.note}`);
    failing = done.after;
  }
  // a SPLIT shelf exists to carry a wall: when neither it nor the shelf above kept one, it goes (the drop is one
  // graded voxel riser again, not two with a ledge between)
  const walled = new Set(fits.map((f) => f.doc.id));
  const gone = shelves.filter((sh, k) => sh.tags.includes("split") && !walled.has(`${town.id}-riser-${k + 1}`) && !walled.has(`${town.id}-riser-${k + 2}`));
  if (gone.length) {
    town.terraces = town.terraces.filter((t) => !gone.includes(t));
    log(`    ${gone.map((t) => t.id).join(", ")}: split shelf with no wall either side of it - removed`);
    fits.splice(0, fits.length, ...solveTerraceChain(recipe, fits.map((f) => f.doc), kit));
  }
  return { dropRoads, fits };
}
