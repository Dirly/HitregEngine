/**
 * `worldgen bridge-place <world> --project <p>` — a REAL bridge across a gap: a stone arch bridge / aqueduct with
 * piers founded on the ground or seabed (one or two arcades), or a rope suspension bridge (catenary, 12-130 m).
 *
 * STANDING RULE (Derek, 2026-10-11): straight spans between natural tops; slope instead of structures. Rope spans
 * run STRAIGHT in plan between NATURAL TOPS (a headland lip, a stack's rock top: --seat rock) and take any height
 * difference as SLOPE: end to end up to 30 deg, the deck nowhere over 35 deg including the sag at the low end and the
 * ease over each rim (the body climbs 50). No stairs, stages, towers or plinths to meet a deck; steeper than that,
 * pick a different anchor pair. `--seat stage` (a timber landing stage) is only for docks / sea-level landings within
 * 4 m of the water; the stone landing plinth in the kit is a future POI part, never suggested for a rope span.
 * Input is a `features.bridgeSpans` doc (core `bridgeSpanSchema`):
 *
 *   --spec <file.json>                     one doc or an array of docs (the schema, `solved` omitted)
 *   --id <slug> --a "x,z[,y|ground]" --b "x,z[,y|ground]" [--kind arch|rope] [--style gnawspur|coastal]
 *        [--channel] [--tiers auto|1|2] [--bay 6..16] [--max-pier 70] [--max-water 14]
 *        [--sag 0.035] [--width 1.8] [--no-rails] [--seat pad|rock] [--seat-a pad|rock] [--seat-b pad|rock] [--owner <id>]
 *        a / b = where the deck meets the land at each end (cliff-top edges, a stack top); y = the deck there, or
 *        "ground" (default). Arch decks are level (ends within 2 m); a rope deck runs end to end.
 *   --refit [--id a,b | --all]            re-solve fitted spans against the current ground (after a terrain rebuild)
 *   --check [--id a,b | --all]            gates only (and STALE when the ground under a fit has changed)
 *   --remove <id>                         drop a span and everything derived from it
 *   --dry-run, --no-gates, --list
 *
 * What a fit does (derived data goes into the recipe, ids `bs-<id>*`, never scene entities):
 *  (a) measures the gap along A -> B (the faces: where the ground first falls 3 m under the deck) and the ground /
 *      seabed profile under it through the DENSITY (sea stacks, overhangs) and the water over it;
 *  (b) arch: plan.mjs planArch chooses bay width + count (piers only where the depth and the ground allow: a layout
 *      needing a pier in deeper water than --max-water or taller than --max-pier fails over to another width), stacks
 *      every pier and each abutment down to real footing, adds a lower arcade for tall crossings and cutwaters in
 *      water; rope: plan.mjs planRope + `build.mts make rope` (the catenary piece for this span, made once);
 *  (c) seats both ends: a feathered height patch pad behind each face (never in front: the cliff stays a cliff), or
 *      --seat rock (no patch: the gate proves the ground already seats it); a clearing over the whole footprint;
 *  (d) gates: `worldgen lips` on its patches, seated pads, every footing buried (no floating pier), and the walk
 *      probe: deck grade, no ground through the deck, headroom, step on/off each end <= 0.35 m.
 *
 * The streamer emits `solved.pieces` (core bridgeSpanEntities). Colliders follow the kit contract: every walked
 * surface is a smooth box (no paving bevel or plank edge snags a body).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  bridgeSpanFeatureId,
  bridgeSpanSchema,
  createWorldField,
  measureTerrainLips,
  worldRecipeSchema,
  type BridgeSpanDoc,
  type BridgeSpanSolved,
  type HeightPatchDoc,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { closure, PROJECTS } from "./_closure.mjs";
import { planStage, type StagePlan } from "./worldgen-bridge-stage.mts";
import type { PlinthFit, PlinthModule } from "./worldgen-bridge-plinth.mts";
import { createHash } from "node:crypto";
import os from "node:os";

type V2 = [number, number];
type V3 = [number, number, number];
type ClearingDoc = NonNullable<WorldRecipe["features"]["clearings"]>[number];

const PLAYGROUND = path.resolve(import.meta.dirname, "..");
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const smooth = (e0: number, e1: number, x: number) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ kit access

interface Placement { id: string; role: string; s: number; y: number; yaw: number }
interface ArchPlan {
  error?: string;
  style: string; W: number; N: number; pw: number; span: number; faceA: number; faceB: number; deckY: number; springTop: number; tiers: number;
  springLow: number | null; tierTop: number | null; channel: boolean;
  piers: { s: number; ground: number; water: number | null; kind: "full" | "two-tier"; height: number; bottom: number }[];
  placements: Placement[]; warnings: string[];
}
interface RopePlan { id: string; lipA: number; lipB: number; masonryA: boolean; masonryB: boolean; dropA: number; dropB: number; segments: { id: string; s: number }[]; span: number; dy: number; sag: number; width: number; endSlopeDeg: number; lowDrop: number; errors: string[] }
interface PlanModule extends PlinthModule {
  DECK: { walk: number; parapetT: number; parapetH: number; depth: number; tierDepth: number };
  ABUT: { length: number; capDrop: number };
  PIER: { cap: number; foot: number; bury: number };
  ROPE: { landing: number; width: number; sag: number; maxSlopeDeg: number };
  planArch(req: Record<string, unknown>): ArchPlan;
  planRope(req: Record<string, unknown>): RopePlan;
  catenary(L: number, dy: number, sag: number): { y(x: number): number; slope(x: number): number; lowY: number };
  ropeDeck(L: number, dy: number, sag: number, lipA?: number, lipB?: number): { y(x: number): number; maxSlopeDeg: number };
}

export interface BridgeKit {
  plan: PlanModule;
  /** Does the kit hold this prefab (in the project's closure)? */
  hasPrefab(id: string): boolean;
  /** Build + catalogue a rope bridge the kit lacks (`build.mts make rope`), then props sync + index. */
  ensureRope(spec: { span: number; dy: number; sag: number; width: number; rails: boolean; lipA?: number; lipB?: number; masonryA?: boolean; masonryB?: boolean; dropA?: number; dropB?: number }): string;
  /** Build + catalogue a stone landing plinth from its solved spec (`build.mts make plinth`); its prefab id. */
  ensurePlinth(spec: PlinthFit["spec"]): string;
  /** Build + catalogue a landing stage from its solved spec (`build.mts make stage`); its segments with their offsets. */
  ensureStage(spec: StagePlan["spec"]): { id: string; segments: { id: string; offset: V3 }[] };
}

function findInClosure(project: string, rel: string): string | null {
  for (const name of closure(project)) {
    const file = path.join(PROJECTS, name, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** tsx: the playground's own copy when there is no .bin shim (pnpm without links), else npx. */
function tsxArgs(script: string, args: string[]): [string, string[]] {
  const cli = path.join(PLAYGROUND, "node_modules", "tsx", "dist", "cli.mjs");
  return fs.existsSync(cli) ? [process.execPath, [cli, script, ...args]] : ["npx", ["tsx", script, ...args]];
}

export function loadBridgeKit(project: string, log: (s: string) => void = console.log, opts: { dryRun?: boolean } = {}): BridgeKit {
  const lookupFile = findInClosure(project, path.join("authoring", "bridges", "lookup.json"));
  if (!lookupFile) throw new Error(`no bridge kit in ${project}'s closure (world-kit authoring/bridges/lookup.json): run world-kit authoring/bridges/build.mts`);
  const dir = path.dirname(lookupFile);
  const kitProject = path.basename(path.resolve(dir, "..", ".."));
  const require = createRequire(import.meta.url);
  const plan = require(path.join(dir, "plan.mjs")) as PlanModule;
  const prefabFile = (id: string) => path.join(PROJECTS, kitProject, "assets", "prefabs", `${id}.json`);
  const run = (script: string, a: string[]) => {
    const [cmd, full] = tsxArgs(script, a);
    const r = spawnSync(cmd, full, { cwd: PLAYGROUND, shell: cmd === "npx" && process.platform === "win32", stdio: "pipe", encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${script} ${a.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  return {
    plan,
    hasPrefab: (id) => fs.existsSync(prefabFile(id)),
    ensurePlinth(spec) {
      const id = `bridges/plinth-${spec.style}-h${Math.round(spec.height * 10)}-${createHash("sha1").update(JSON.stringify(spec)).digest("hex").slice(0, 8)}`;
      if (opts.dryRun) { log(`  (dry run: would build ${id})`); return id; }
      if (fs.existsSync(prefabFile(id))) return id;
      const file = path.join(os.tmpdir(), `hitreg-plinth-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(spec));
      log(`  building the landing plinth ${id} (bridges/build.mts make plinth)`);
      const out = run(path.relative(PLAYGROUND, path.join(dir, "build.mts")), ["make", "plinth", "--spec", file]);
      fs.rmSync(file, { force: true });
      if (/MADE (\S+)/.exec(out)?.[1] !== id) throw new Error(`build.mts make plinth did not report ${id}:\n${out}`);
      run("tools/props.mts", ["sync", "--project", kitProject]);
      run("tools/props.mts", ["index", "--project", kitProject]);
      return id;
    },
    ensureStage(spec) {
      const id = `bridges/stage-${createHash("sha1").update(JSON.stringify(spec)).digest("hex").slice(0, 10)}`;
      if (opts.dryRun) { log(`  (dry run: would build ${id})`); return { id, segments: [] }; }
      const lookup = JSON.parse(fs.readFileSync(lookupFile, "utf8")) as { stages?: Record<string, { segments: { id: string; offset: V3 }[] }> };
      const known = lookup.stages?.[id];
      if (known && known.segments.every((sg) => fs.existsSync(prefabFile(sg.id)))) return { id, segments: known.segments };
      const file = path.join(os.tmpdir(), `hitreg-stage-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(spec));
      log(`  building the landing stage ${id} (bridges/build.mts make stage)`);
      const out = run(path.relative(PLAYGROUND, path.join(dir, "build.mts")), ["make", "stage", "--spec", file]);
      fs.rmSync(file, { force: true });
      const made = /MADE (\S+)/.exec(out)?.[1];
      const segs = /SEGMENTS (.+)/.exec(out)?.[1];
      if (made !== id || !segs) throw new Error(`build.mts make stage did not report ${id}:\n${out}`);
      run("tools/props.mts", ["sync", "--project", kitProject]);
      run("tools/props.mts", ["index", "--project", kitProject]);
      return { id, segments: JSON.parse(segs) };
    },
    ensureRope(spec) {
      if (opts.dryRun) {
        // a dry run builds nothing: the id the make would produce (plan.mjs ropeId), so the fit and its gates still run
        const id = plan.planRope({ span: spec.span, dy: spec.dy, sag: spec.sag, width: spec.width, rails: spec.rails, lipA: spec.lipA, lipB: spec.lipB, masonryA: spec.masonryA, masonryB: spec.masonryB, dropA: spec.dropA, dropB: spec.dropB }).id + (spec.rails ? "" : "-norail");
        log(`  (dry run: would build ${id})`);
        return id;
      }
      const args = ["make", "rope", "--span", String(spec.span), "--dy", String(spec.dy), "--sag", String(spec.sag), "--width", String(spec.width), ...(spec.rails ? [] : ["--no-rails"]), ...(spec.lipA ? ["--lip-a", String(spec.lipA)] : []), ...(spec.lipB ? ["--lip-b", String(spec.lipB)] : []), ...(spec.masonryA ? ["--masonry-a"] : []), ...(spec.masonryB ? ["--masonry-b"] : []), ...(spec.dropA ? ["--drop-a", String(spec.dropA)] : []), ...(spec.dropB ? ["--drop-b", String(spec.dropB)] : [])];
      log(`  building the rope bridge for span ${spec.span} m, dy ${spec.dy} m, sag ${spec.sag} (bridges/build.mts make rope)`);
      const run = (script: string, a: string[]) => {
        const [cmd, full] = tsxArgs(script, a);
        const r = spawnSync(cmd, full, { cwd: PLAYGROUND, shell: cmd === "npx" && process.platform === "win32", stdio: "pipe", encoding: "utf8" });
        if (r.status !== 0) throw new Error(`${script} ${a.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
        return r.stdout;
      };
      const out = run(path.relative(PLAYGROUND, path.join(dir, "build.mts")), args);
      const id = /MADE (\S+)/.exec(out)?.[1];
      if (!id || !fs.existsSync(prefabFile(id))) throw new Error(`build.mts make rope did not report a prefab:\n${out}`);
      run("tools/props.mts", ["sync", "--project", kitProject]);
      run("tools/props.mts", ["index", "--project", kitProject]);
      return id;
    },
  };
}

// ------------------------------------------------------------------ geometry helpers

interface Frame { O: V2; dir: V2; perp: V2; heading: number; dist: number }
function frameOf(a: V2, b: V2): Frame {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const dist = Math.hypot(dx, dz);
  if (dist < 1) throw new Error("bridge ends are less than 1 m apart");
  const dir: V2 = [dx / dist, dz / dist];
  return { O: a, dir, perp: [-dir[1], dir[0]], heading: (Math.atan2(-dir[1], dir[0]) * 180) / Math.PI, dist };
}
const at = (f: Frame, s: number, z = 0): V2 => [f.O[0] + f.dir[0] * s + f.perp[0] * z, f.O[1] + f.dir[1] * s + f.perp[1] * z];
const normYaw = (d: number) => { let y = ((d + 180) % 360 + 360) % 360 - 180; if (Math.abs(y + 180) < 1e-9) y = 180; return r3(y); };

/** Solid ground at (x, z) through the density (stacks, overhangs), from `from` down; the heightfield when nothing is hit. */
function solidGround(field: WorldField, x: number, z: number, from: number): number {
  const hit = field.surfaceCast(x, z, from, Math.min(from - 1, field.recipe.minY ?? -200));
  return hit ?? field.height(x, z);
}

/** A masked height patch levelling an oriented rectangle (s0..s1 along the frame, |z| <= half) to `y`, feathered
 * outside it, and handing back to the natural ground over `gapFade` metres before `gapS`, 0 beyond it on the gap
 * side (the patch never fills the gorge in front of a face, and never builds a rim along the cliff edge). */
interface PadCut { s0: number; s1: number; half: number; y: number; ground: (x: number, z: number) => number }
function padPatch(id: string, f: Frame, s0: number, s1: number, half: number, y: number, feather: number, gapS: number, gapSide: 1 | -1, gapFade = 0, cut?: PadCut): HeightPatchDoc {
  const corners = [at(f, s0 - feather, -half - feather), at(f, s1 + feather, -half - feather), at(f, s1 + feather, half + feather), at(f, s0 - feather, half + feather)];
  const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) - 2), x1 = Math.ceil(Math.max(...corners.map((c) => c[0])) + 2);
  const z0 = Math.floor(Math.min(...corners.map((c) => c[1])) - 2), z1 = Math.ceil(Math.max(...corners.map((c) => c[1])) + 2);
  const step = 1;
  const columns = Math.round((x1 - x0) / step) + 1, rows = Math.round((z1 - z0) / step) + 1;
  const heights: number[] = [], weights: number[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
    const x = x0 + i * step, z = z0 + j * step;
    const rx = x - f.O[0], rz = z - f.O[1];
    const s = rx * f.dir[0] + rz * f.dir[1], q = rx * f.perp[0] + rz * f.perp[1];
    const ds = Math.max(0, s0 - s, s - s1), dq = Math.max(0, Math.abs(q) - half);
    const d = Math.hypot(ds, dq);
    let w = 1 - smooth(0, feather, d);
    const toGap = (gapS - s) * gapSide; // metres on the land side of the gap line
    if (toGap < 0) w = 0;
    else if (gapFade > 0) w *= smooth(0, gapFade, toGap);
    // under a structure (an abutment): only ever CUT the ground down to cut.y (never raise it beside a cliff edge)
    if (cut && s >= cut.s0 - 1e-6 && s <= cut.s1 + 1e-6 && Math.abs(q) <= cut.half) {
      heights.push(r3(Math.min(cut.ground(x, z), cut.y)));
      weights.push(1);
      continue;
    }
    // where the pad lets go, carry the natural ground (the raster is prefiltered: a placeholder height there would
    // bleed into the cells beside it and build a rim along the cliff edge)
    heights.push(r3(w > 0.999 || !cut ? y : w < 0.001 ? cut.ground(x, z) : y * w + cut.ground(x, z) * (1 - w)));
    weights.push(r3(w));
  }
  return { id, origin: [x0, z0], size: [x1 - x0, z1 - z0], columns, rows, heights, weights, blend: 1, filter: 1 } as HeightPatchDoc;
}

/** Mean ground height (WITHOUT this span's own pads: pass the bare field) over the span line and both ends: the fingerprint `--check` compares. Any terrain edit under it (noise, patches, rivers) moves it. */
function groundFingerprint(field: WorldField, f: Frame, s0: number, s1: number): number {
  let sum = 0, n = 0;
  for (let s = s0; s <= s1 + 1e-6; s += 2) { const [x, z] = at(f, s); sum += field.height(x, z); n++; }
  return r3(sum / Math.max(1, n));
}

// ------------------------------------------------------------------ fit

export interface BridgeFit {
  doc: BridgeSpanDoc;
  patches: HeightPatchDoc[];
  clearing: ClearingDoc;
  /** Pads the seated gate checks: oriented slabs (centre, half extents along / across, yaw rad, baseY). */
  pads: { x: number; z: number; halfX: number; halfZ: number; yaw: number; baseY: number }[];
}

/** The recipe without this span's derived features (its natural ground). */
export function bareOfBridge(recipe: WorldRecipe, id: string): WorldRecipe {
  const r = structuredClone(recipe);
  removeBridge(r, id, false);
  return r;
}

export function fitBridgeSpan(recipe: WorldRecipe, input: BridgeSpanDoc, kit: BridgeKit, log: (s: string) => void = () => {}): BridgeFit {
  const doc = bridgeSpanSchema.parse({ ...input, solved: undefined });
  const field = createWorldField(bareOfBridge(recipe, doc.id));
  const fid = bridgeSpanFeatureId(doc.id);
  const high = (recipe.maxY ?? 600) + 10;
  // A rope end on ROCK with y "ground" (a DC stack top, a sea-cliff lip: no pad may level it) is SEATED: slid along the
  // span line to the outermost point where the landing, both anchor posts and the deck edges all stand on the rock
  // top, and the top is the deck end's ground. A rope deck leaving a rounded rim otherwise either hangs its posts over
  // the drop or dives under the rim.
  const rockSeat = (end: V2, inward: V2, width: number): { at: V2; y: number; drop: number } | null => {
    const n: V2 = [-inward[1], inward[0]];
    const g = (p: V2, b: number, q: number) => solidGround(field, p[0] + inward[0] * b + n[0] * q, p[1] + inward[1] * b + n[1] * q, high);
    const refs = [2, 3, 4, 5].map((b) => g(end, b, 0)).sort((a, c) => a - c);
    const topRef = refs[2]!;
    const lat = [-(width / 2 + 0.4), -width / 4, 0, width / 4, width / 2 + 0.4];
    for (let tt = 4; tt >= -8; tt -= 0.1) {
      const p: V2 = [end[0] - inward[0] * tt, end[1] - inward[1] * tt];
      // the landing lies on the top as it is: a plane from the rim to the rock 2.6 m inland (a natural top falls or
      // rises a little; the landing's sleepers follow it, up to 1.2 m either way); every sample within -0.5 / +0.35
      let rim = -Infinity;
      for (const b of [0, 0.3, 0.6]) for (const q of [-(width / 4), 0, width / 4]) rim = Math.max(rim, g(p, b, q));
      const far = [-(width / 4), 0, width / 4].map((q) => g(p, 2.6, q)).sort((a, c) => a - c)[1]!;
      if (rim < topRef - 3 || Math.abs(rim - far) > 1.2) continue;
      let ok = true;
      for (const b of [0, 0.3, 1, 2, 2.8]) {
        const plane = rim + (far - rim) * Math.min(1, b / 2.6);
        for (const q of lat) { const y = g(p, b, q); if (y < plane - 0.5 || y > plane + 0.35) { if (process.env.ROCK_DEBUG) console.log("rock", tt.toFixed(1), b, q, "y", y.toFixed(2), "plane", plane.toFixed(2)); ok = false; break; } }
        if (!ok) break;
      }
      if (ok) {
        // the deck end sits on the RIM; the landing follows the top down (drop > 0) or up (drop < 0)
        const drop = Math.max(-1.2, Math.min(1.2, Math.round((rim - far) * 10) / 10));
        return { at: [r2(p[0]), r2(p[1])], y: r3(rim), drop };
      }
    }
    return null;
  };
  let endA: V2 = doc.a.at, endB: V2 = doc.b.at;
  let rockYA: number | undefined, rockYB: number | undefined;
  let dropA = 0, dropB = 0;
  const stagePlans: { end: "a" | "b"; plan: StagePlan }[] = [];
  if (doc.kind !== "rope" && ((doc.a.seat ?? doc.seat) === "stage" || (doc.b.seat ?? doc.seat) === "stage")) throw new Error(`${doc.id}: seat stage is for rope spans`);
  if (doc.kind === "rope") {
    const f0 = frameOf(endA, endB);
    // a STAGE end: a timber landing stage off the steep lip (worldgen-bridge-stage.mts); the deck end is the lip's
    // highest rock within 1.5 m plus 0.35 m (or the y given), and the end slides out to the platform's front edge
    // rock ends first: a stage at the other end sets its deck from theirs
    const rockFirst = () => {
      if ((doc.a.seat ?? doc.seat) === "rock" && doc.a.y === "ground") {
        const s = rockSeat(endA, [-f0.dir[0], -f0.dir[1]], doc.width);
        if (s) { endA = s.at; rockYA = s.y; dropA = s.drop; }
      }
      if ((doc.b.seat ?? doc.seat) === "rock" && doc.b.y === "ground") {
        const s = rockSeat(endB, f0.dir, doc.width);
        if (s) { endB = s.at; rockYB = s.y; dropB = s.drop; }
      }
    };
    rockFirst();
    // a plinth / tower end is refused: rope spans anchor on natural tops (Derek, 2026-10-11)
    for (const e of ["a", "b"] as const) {
      const an = e === "a" ? doc.a : doc.b;
      if ((an.seat ?? doc.seat) !== "plinth") continue;
      throw new Error(`${doc.id}: a rope end never lands on a plinth or a tower: rope spans run straight between natural tops and take the height as slope (seat rock); pick a different anchor pair if it is too steep`);
    }
    for (const e of ["a", "b"] as const) {
      const an = e === "a" ? doc.a : doc.b;
      if ((an.seat ?? doc.seat) !== "stage") continue;
      const at0 = e === "a" ? endA : endB;
      let lipY = -Infinity;
      for (const [dx, dz] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]] as V2[]) lipY = Math.max(lipY, solidGround(field, at0[0] + dx, at0[1] + dz, high));
      // set down the face so the rope deck stays under ~28 deg from the other end (a Pyke stair climbs the rest)
      const other = e === "a" ? rockYB : rockYA;
      const reach = Math.hypot(endB[0] - endA[0], endB[1] - endA[1]) - 6;
      const lowCap = other !== undefined ? other + 0.25 + 0.42 * Math.max(4, reach) : Infinity;
      const deckY = typeof an.y === "number" ? an.y : r3(Math.min(lipY + 0.35, lowCap));
      const inward: V2 = e === "a" ? [-f0.dir[0], -f0.dir[1]] : f0.dir;
      // Derek's rule: a stage never climbs to meet a rope deck; it stays for docks / sea-level landings
      const water = field.waterY(at0[0], at0[1]) ?? field.recipe.seaLevel ?? 0;
      if (deckY - water > 4) throw new Error(`${doc.id}: seat stage is only for docks / sea-level landings (deck ${r2(deckY)} is ${r2(deckY - water)} m over the water): rope spans run straight between natural tops and take the height as slope (seat rock); pick a different anchor pair if it is too steep`);
      const plan = planStage(field, { end: at0, inward, deckY, ropeWidth: doc.width }, (x, z, from) => solidGround(field, x, z, from));
      stagePlans.push({ end: e, plan });
      if (e === "a") { endA = plan.endAt; rockYA = deckY - 0.25; } else { endB = plan.endAt; rockYB = deckY - 0.25; }
    }
    if ((doc.a.seat ?? doc.seat) === "rock" && doc.a.y === "ground") {
      const s = rockSeat(endA, [-f0.dir[0], -f0.dir[1]], doc.width);
      if (!s) throw new Error(`${doc.id}: end A is not on a rock top wide enough for the landing (seat rock); move it or seat a pad`);
      endA = s.at; rockYA = s.y; dropA = s.drop;
    }
    if ((doc.b.seat ?? doc.seat) === "rock" && doc.b.y === "ground") {
      const s = rockSeat(endB, f0.dir, doc.width);
      if (!s) throw new Error(`${doc.id}: end B is not on a rock top wide enough for the landing (seat rock); move it or seat a pad`);
      // the span is made in whole metres: B goes INTO its rock (ceil), never out over the drop
      const f1 = frameOf(endA, s.at);
      const L = Math.ceil(f1.dist - 1e-6);
      endB = [r2(endA[0] + f1.dir[0] * L), r2(endA[1] + f1.dir[1] * L)]; rockYB = s.y; dropB = s.drop;
    }
  }
  const f = doc.kind === "plinth" ? frameOf(endA, [endA[0] + 1, endA[1]]) : frameOf(endA, endB);
  const anchorY = (p: V2, y: number | "ground", probeFrom: number) => {
    if (y !== "ground") return y;
    const ys: number[] = [];
    for (const [dx, dz] of [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]] as V2[]) ys.push(solidGround(field, p[0] + dx, p[1] + dz, probeFrom));
    ys.sort((a, b) => a - b);
    return ys[2]!;
  };
  const top = high;
  const yA = rockYA ?? anchorY(endA, doc.a.y, top), yB = rockYB ?? anchorY(endB, doc.b.y, top);
  const warnings: string[] = [];
  const pads: BridgeFit["pads"] = [];
  // each end seats on its own terms: a levelled pad (height patch) or the rock as it stands (a DC stack top)
  const seatA = doc.a.seat ?? doc.seat, seatB = doc.b.seat ?? doc.seat;
  const patches: HeightPatchDoc[] = [];
  const yawRad = (f.heading * Math.PI) / 180;
  let solved: BridgeSpanSolved;
  let footprint: [number, number, number]; // s0, s1, half width of the clearing

  if (doc.kind === "plinth") {
    throw new Error(`${doc.id}: the stone landing plinth is a future POI part (world-kit bridges plinth.mts, build.mts make plinth), not something bridge-place builds: rope spans anchor on natural tops`);
  } else if (doc.kind === "arch") {
    if (Math.abs(yA - yB) > 2) throw new Error(`${doc.id}: arch decks are level, but the ends differ by ${r2(Math.abs(yA - yB))} m (give both ends a y within 2 m, or use --kind rope)`);
    const deckY = r2((yA + yB) / 2);
    const P = kit.plan;
    const half = P.DECK.depth / 2;
    // the faces: where the ground first falls 3 m under the deck, walking in from each end
    const g = (s: number, z = 0) => { const [x, zz] = at(f, s, z); return solidGround(field, x, zz, deckY + 30); };
    let edgeA = 0, edgeB = f.dist;
    for (let s = 0; s <= f.dist; s += 0.5) if (Math.min(g(s), g(s, -half), g(s, half)) < deckY - 3) { edgeA = Math.max(0, s - 1); break; }
    for (let s = f.dist; s >= 0; s -= 0.5) if (Math.min(g(s), g(s, -half), g(s, half)) < deckY - 3) { edgeB = Math.min(f.dist, s + 1); break; }
    if (edgeB - edgeA < 4) throw new Error(`${doc.id}: no gap between the anchors (the ground never falls 3 m under the deck at ${deckY})`);
    const fs0 = { ...f, O: at(f, edgeA) } as Frame;
    const L = edgeB - edgeA;
    const ground = (s0: number, s1: number, h: number) => {
      let m = Infinity;
      for (let s = s0; s <= s1 + 1e-6; s += 0.5) for (let z = -h; z <= h + 1e-6; z += Math.max(0.5, h / 3)) {
        const [x, zz] = at(fs0, s, z);
        m = Math.min(m, solidGround(field, x, zz, deckY + 30));
      }
      return m;
    };
    const water = (s: number) => { const [x, z] = at(fs0, s); return field.waterY(x, z); };
    const plan = P.planArch({
      span: L, deckY, ground, water, style: doc.style, channel: doc.channel, tiers: doc.tiers, bay: doc.bay,
      maxPier: doc.maxPier, maxWater: doc.maxWater,
    });
    if (plan.error) throw new Error(`${doc.id}: ${plan.error}`);
    warnings.push(...plan.warnings);
    const missing = [...new Set(plan.placements.map((p) => p.id))].filter((id) => !kit.hasPrefab(id));
    if (missing.length) throw new Error(`${doc.id}: the bridge kit lacks ${missing.join(", ")} (run world-kit authoring/bridges/build.mts)`);
    const pieces = plan.placements.map((p) => {
      const [x, z] = at(fs0, p.s);
      return { prefab: p.id, role: p.role, position: [r3(x), r3(p.y), r3(z)] as V3, yaw: normYaw(f.heading + p.yaw) };
    });
    const piers = plan.piers.map((p) => {
      const [x, z] = at(fs0, p.s);
      return { position: [r3(x), r3(plan.springLow !== null && p.kind === "two-tier" ? plan.springLow : plan.springTop), r3(z)] as V3, ground: r2(p.ground), water: p.water === null ? null : r2(p.water), bottom: r2(p.bottom), kind: p.kind };
    });
    // abutment stacks (their bottoms, for the footing gate)
    for (const [face, sign] of [[plan.faceA, -1], [plan.faceB, 1]] as [number, number][]) {
      const courses = plan.placements.filter((p) => p.role.startsWith("abut-course") && Math.abs(p.s - face) < 1e-6);
      const bottom = courses.length ? Math.min(...courses.map((c) => c.y - Number(c.role.slice(-1)))) : plan.springTop - P.ABUT.capDrop;
      const [x, z] = at(fs0, face + sign * (P.ABUT.length / 2));
      piers.push({ position: [r3(x), r3(plan.springTop), r3(z)], ground: r2(ground(Math.min(face, face + sign * P.ABUT.length), Math.max(face, face + sign * P.ABUT.length), half)), water: null, bottom: r2(bottom), kind: "abutment" as never });
    }
    const padLen = P.ABUT.length + 6;
    const padY = deckY - 0.16;
    {
      // level the land past the abutment's land end; under the abutment only cut the ground below its paving
      const nat = (x: number, z: number) => solidGround(field, x, z, high); // the drawn surface (on a DC / planar coast the heightfield is not it)
      if (seatA === "pad") patches.push(padPatch(`${fid}-a`, fs0, plan.faceA - padLen, plan.faceA - P.ABUT.length, half + 2, padY, 6, plan.faceA - 1.5, 1, P.ABUT.length - 2, { s0: plan.faceA - P.ABUT.length, s1: plan.faceA, half: half + 0.6, y: deckY - 0.26, ground: nat }));
      if (seatB === "pad") patches.push(padPatch(`${fid}-b`, fs0, plan.faceB + P.ABUT.length, plan.faceB + padLen, half + 2, padY, 6, plan.faceB + 1.5, -1, P.ABUT.length - 2, { s0: plan.faceB, s1: plan.faceB + P.ABUT.length, half: half + 0.6, y: deckY - 0.26, ground: nat }));
    }
    // pads the seated gate checks: the land beyond the abutment (where the player steps off)
    for (const [s0, s1] of [[plan.faceA - padLen, plan.faceA - P.ABUT.length - 0.5], [plan.faceB + P.ABUT.length + 0.5, plan.faceB + padLen]] as V2[]) {
      const [x, z] = at(fs0, (s0 + s1) / 2);
      pads.push({ x, z, halfX: (s1 - s0) / 2, halfZ: half - 0.5, yaw: yawRad, baseY: padY });
    }
    const profile: [number, number][] = [];
    for (let s = plan.faceA - P.ABUT.length; s <= plan.faceB + P.ABUT.length + 1e-6; s += 1) profile.push([r2(s), deckY]);
    footprint = [plan.faceA - padLen, plan.faceB + padLen, half + 3];
    solved = {
      kind: "arch", style: doc.style, heading: r3(f.heading), origin: [r3(fs0.O[0]), deckY, r3(fs0.O[1])], span: plan.span, deckY, dy: 0, drops: [0, 0],
      bay: plan.W, bays: plan.N, tiers: plan.tiers, pieces, piers, profile, stages: [],
      derived: { patches: patches.map((p) => p.id), clearing: fid }, ground: groundFingerprint(field, fs0, plan.faceA - padLen, plan.faceB + padLen), warnings,
    };
    log(`  ${doc.id}: gap ${r2(L)} m (faces at ${r2(edgeA)} / ${r2(edgeB)} m from A) -> ${plan.N} x ${plan.W} m bays (${plan.span} m), ${plan.tiers} arcade(s), deck ${deckY}, ${plan.piers.length} piers (tallest ${r2(Math.max(0, ...plan.piers.map((p) => p.height)))} m${plan.piers.some((p) => p.water !== null) ? `, ${plan.piers.filter((p) => p.water !== null).length} in water` : ""})`);
  } else {
    const P = kit.plan;
    const deckA = typeof doc.a.y === "number" ? doc.a.y : yA + 0.25;
    const deckB0 = typeof doc.b.y === "number" ? doc.b.y : yB + 0.25;
    // a rock end's rim cannot be cut: the deck is carried level over its rim instead (plan.mjs ropeDeck: a bounded
    // ease, nowhere steeper than the catenary or ROPE.maxSlopeDeg - 3; the height is taken as slope, never a structure)
    const plan = P.planRope({ span: f.dist, dy: deckB0 - deckA, sag: doc.sag, width: doc.width, style: "gnawspur", rails: doc.rails, lipA: seatA === "rock" ? 6 : 0, lipB: seatB === "rock" ? 6 : 0, masonryA: false, masonryB: false, dropA: seatA === "rock" ? dropA : 0, dropB: seatB === "rock" ? dropB : 0 });
    if (plan.errors.length) throw new Error(`${doc.id}: ${plan.errors.join("; ")}`);
    const id = plan.id + (doc.rails ? "" : "-norail");
    if (!kit.hasPrefab(id) || plan.segments.some((sg) => !kit.hasPrefab(sg.id))) {
      const made = kit.ensureRope({ span: plan.span, dy: plan.dy, sag: plan.sag, width: plan.width, rails: doc.rails, lipA: plan.lipA, lipB: plan.lipB, masonryA: plan.masonryA, masonryB: plan.masonryB, dropA: plan.dropA, dropB: plan.dropB });
      if (made !== id) throw new Error(`${doc.id}: made ${made}, expected ${id}`);
    }
    const L = plan.span, dy = plan.dy;
    const half = plan.width / 2 + 1;
    const LAND = P.ROPE.landing;
    const back = LAND + 2.2 + 1.5;
    if (Math.abs(f.dist - L) > 0.01) warnings.push(`span quantised ${r2(f.dist)} -> ${L} m: end B moves ${r2(L - f.dist)} m along the line`);
    if (Math.abs(deckB0 - deckA - dy) > 0.01) warnings.push(`rise quantised ${r2(deckB0 - deckA)} -> ${dy} m: end B's pad is levelled to the deck`);
    const padA = deckA - 0.25 - plan.dropA / 2, padB = deckA + dy - 0.25 - plan.dropB / 2;
    {
      // the deck leaves each end on its catenary: for 2.5 m past the end only CUT the rim under it (0.35 m clear)
      const nat = (x: number, z: number) => solidGround(field, x, z, high); // the drawn surface (on a DC / planar coast the heightfield is not it)
      const drop = 2.5 * Math.tan((plan.endSlopeDeg * Math.PI) / 180) + 0.35;
      if (seatA === "pad") patches.push(padPatch(`${fid}-a`, f, -back, 0.6, half + 0.6, padA, 4, 0.6, 1, 0, { s0: 0.6, s1: 2.5, half: plan.width / 2 + 0.4, y: deckA - drop, ground: nat }));
      if (seatB === "pad") patches.push(padPatch(`${fid}-b`, f, L - 0.6, L + back, half + 0.6, padB, 4, L - 0.6, -1, 0, { s0: L - 2.5, s1: L - 0.6, half: plan.width / 2 + 0.4, y: deckA + dy - drop, ground: nat }));
    }
    for (const [s0, s1, y, e] of [[-LAND, -0.5, padA, "a"], [L + 0.5, L + LAND, padB, "b"]] as [number, number, number, "a" | "b"][]) {
      if ((e === "a" ? seatA : seatB) === "stage" || (e === "a" ? seatA : seatB) === "plinth") continue; // a platform / roof carries that landing
      const [x, z] = at(f, (s0 + s1) / 2);
      pads.push({ x, z, halfX: (s1 - s0) / 2, halfZ: plan.width / 2 - 0.2, yaw: yawRad, baseY: y });
    }
    const deck = P.ropeDeck(L, dy, plan.sag, plan.lipA, plan.lipB);
    const profile: [number, number][] = [];
    for (let s = 0; s <= L + 1e-6; s += 0.5) profile.push([s, r3(deckA + deck.y(s))]);
    const posts = [-0.25, L + 0.25].map((s, e) => {
      const [x, z] = at(f, s);
      const y = e ? deckA + dy : deckA;
      return { position: [r3(x), r3(y), r3(z)] as V3, ground: r2(e ? padB : padA), water: null, bottom: r2((e ? padB : padA) - 1.0), kind: "post" as const };
    }).filter((_, e) => (e ? seatB : seatA) !== "stage" && (e ? seatB : seatA) !== "plinth");
    // the stages: build (or reuse) each, and place its segments in the stage frame
    const stages: BridgeSpanSolved["stages"] = [];
    const stagePieces: BridgeSpanSolved["pieces"] = [];
    for (const { end, plan: sp } of stagePlans) {
      const made = kit.ensureStage(sp.spec);
      const th = (sp.yaw * Math.PI) / 180;
      const ex: V2 = [Math.cos(th), -Math.sin(th)], ez: V2 = [Math.sin(th), Math.cos(th)];
      const O: V3 = [sp.endAt[0], sp.deckY, sp.endAt[1]];
      for (const sg of made.segments) stagePieces.push({ prefab: sg.id, role: "stage-segment", position: [r3(O[0] + ex[0] * sg.offset[0] + ez[0] * sg.offset[2]), r3(O[1] + sg.offset[1]), r3(O[2] + ex[1] * sg.offset[0] + ez[1] * sg.offset[2])], yaw: normYaw(sp.yaw) });
      if (!made.segments.length) warnings.push(`dry run: the stage ${made.id} is not built, so it has no pieces`);
      stages.push({ end, prefab: made.id, origin: O.map(r3) as V3, yaw: r3(sp.yaw), path: sp.pathWorld, ground: sp.ground, feet: sp.feet });
      for (const n of sp.notes) warnings.push(`stage ${end}: ${n}`);
      log(`  ${doc.id}: stage at end ${end.toUpperCase()}: platform at ${sp.endAt.map(r2).join(",")} (deck ${sp.deckY}), ${sp.pathWorld.length - 1} m of walkway to ground at ${sp.ground.map(r2).join(",")}, ${sp.feet.length} timbers -> ${made.id}`);
    }
    footprint = [-back, L + back, half + 1];
    solved = {
      kind: "rope", style: "gnawspur", heading: r3(f.heading), origin: [r3(f.O[0]), r3(deckA), r3(f.O[1])], span: L, deckY: r3(deckA), dy,
      lowDrop: plan.lowDrop, drops: [plan.dropA, plan.dropB],
      // one piece per 16 m segment, each from its own origin: every streamed cell the span crosses carries its share
      pieces: [...plan.segments.map((sg) => { const [x, z] = at(f, sg.s); return { prefab: sg.id, role: "rope-segment", position: [r3(x), r3(deckA), r3(z)] as V3, yaw: normYaw(f.heading) }; }), ...stagePieces],
      piers: posts, profile, stages,
      derived: { patches: patches.map((p) => p.id), clearing: fid }, ground: groundFingerprint(field, f, -back, L + back), warnings,
    };
    log(`  ${doc.id}: rope bridge ${L} m, ${dy >= 0 ? "rising" : "falling"} ${Math.abs(dy)} m, sag ${plan.sag} (lowest ${plan.lowDrop} m under end A), end slope ${plan.endSlopeDeg} deg -> ${id}`);
  }
  const [s0, s1, hw] = footprint;
  const fr = doc.kind === "arch" ? ({ ...f, O: [solved.origin[0], solved.origin[2]] } as Frame) : f;
  if (doc.kind === "plinth") {
    const h = (solved.plinth?.half ?? 4) + 2, c: V2 = [solved.origin[0], solved.origin[2]];
    const clearingP = { id: fid, polygon: [[c[0] - h, c[1] - h], [c[0] + h, c[1] - h], [c[0] + h, c[1] + h], [c[0] - h, c[1] + h]].map(([x, z]) => [r2(x!), r2(z!)] as V2), feather: 2, keep: 0, scatter: true, cover: true, owner: doc.owner ?? doc.id } as ClearingDoc;
    return { doc: { ...doc, solved }, patches, clearing: clearingP, pads };
  }
  const clearing = { id: fid, polygon: [at(fr, s0, -hw), at(fr, s1, -hw), at(fr, s1, hw), at(fr, s0, hw)].map(([x, z]) => [r2(x), r2(z)] as V2), feather: 3, keep: 0, scatter: true, cover: true, owner: doc.owner ?? doc.id } as ClearingDoc;
  return { doc: { ...doc, solved }, patches, clearing, pads };
}

export function applyBridgeFit(recipe: WorldRecipe, fit: BridgeFit): void {
  removeBridge(recipe, fit.doc.id, false);
  const list = (recipe.features.bridgeSpans ??= []);
  const i = list.findIndex((b) => b.id === fit.doc.id);
  if (i >= 0) list[i] = fit.doc; else list.push(fit.doc);
  recipe.features.heightPatches.push(...fit.patches);
  (recipe.features.clearings ??= []).push(fit.clearing);
}

/** Remove a span's derived features (and the doc too, unless `dropDoc` is false). */
export function removeBridge(recipe: WorldRecipe, id: string, dropDoc = true): void {
  const fid = bridgeSpanFeatureId(id);
  const own = (x: string) => x === fid || x.startsWith(`${fid}-`);
  recipe.features.heightPatches = recipe.features.heightPatches.filter((p) => !own(p.id));
  if (recipe.features.clearings) recipe.features.clearings = recipe.features.clearings.filter((c) => c.id !== fid);
  if (dropDoc && recipe.features.bridgeSpans) recipe.features.bridgeSpans = recipe.features.bridgeSpans.filter((b) => b.id !== id);
}

// ------------------------------------------------------------------ gates

export interface BridgeGateReport { id: string; ok: boolean; stale: boolean; lines: string[] }

/** Pads the seated gate checks, re-derived from a solved doc (so `--check` needs no fit). */
function padsOf(doc: BridgeSpanDoc, kit: BridgeKit): BridgeFit["pads"] {
  const s = doc.solved!;
  const yaw = (s.heading * Math.PI) / 180;
  const f: Frame = { ...frameOf(doc.a.at, doc.b.at), O: [s.origin[0], s.origin[2]] };
  if (s.kind === "arch") {
    const P = kit.plan, half = P.DECK.depth / 2, padLen = P.ABUT.length + 6;
    const xs = s.pieces.filter((p) => p.role.startsWith("abut") && !p.role.startsWith("abut-course")).map((p) => (p.position[0] - f.O[0]) * f.dir[0] + (p.position[2] - f.O[1]) * f.dir[1]).sort((a, b) => a - b);
    if (xs.length < 2) return [];
    return [[xs[0]! - padLen, xs[0]! - P.ABUT.length - 0.5], [xs[1]! + P.ABUT.length + 0.5, xs[1]! + padLen]].map(([a, b]) => { const [x, z] = at(f, (a! + b!) / 2); return { x, z, halfX: (b! - a!) / 2, halfZ: half - 0.5, yaw, baseY: s.deckY - 0.16 }; });
  }
  const LAND = kit.plan.ROPE.landing, w = kit.plan.ROPE.width;
  const staged = new Set<string>([...(s.stages ?? []).map((st) => st.end), ...(["a", "b"] as const).filter((e) => ((e === "a" ? doc.a.seat : doc.b.seat) ?? doc.seat) === "plinth")]);
  const dr = s.drops ?? [0, 0];
  return ([[-LAND, -0.5, s.deckY - 0.25 - dr[0] / 2, "a"], [s.span + 0.5, s.span + LAND, s.deckY + s.dy - 0.25 - dr[1] / 2, "b"]] as [number, number, number, "a" | "b"][]).filter((r) => !staged.has(r[3])).map(([a, b, y, e]) => {
    const [x, z] = at(f, (a + b) / 2);
    // where the player steps off: the landing's land end, its top there
    const sEnd = e === "a" ? a : b, [ex, ez] = at(f, sEnd), d = e === "a" ? dr[0] : dr[1];
    const endTop = (e === "a" ? s.deckY : s.deckY + s.dy) - d;
    return { x, z, halfX: (b - a) / 2, halfZ: w / 2 - 0.2, yaw, baseY: y, step: [ex, ez, endTop] as V3 };
  });
}

type PadRow = BridgeFit["pads"][number] & { step?: V3 };
export function bridgeGates(recipe: WorldRecipe, doc: BridgeSpanDoc, kit: BridgeKit, opts: { field?: WorldField; faults?: boolean } = {}): BridgeGateReport {
  const s = doc.solved;
  if (!s) throw new Error(`bridge span ${doc.id} is not fitted`);
  const field = opts.field ?? createWorldField(recipe);
  if (s.kind === "plinth" && s.plinth) {
    // a plinth: the tower on rock (no corner over a drop deeper than its burial), the doorway onto rock, its height
    const pl = s.plinth, lines: string[] = [];
    let worst = Infinity;
    for (let a = -pl.half; a <= pl.half + 1e-6; a += 1) for (let b = -pl.half; b <= pl.half + 1e-6; b += 1) worst = Math.min(worst, solidGround(field, pl.position[0] + a, pl.position[2] + b, pl.position[1] + 5) - (pl.base - kit.plan.PLINTH.bury));
    const doorStep = r2(solidGround(field, pl.door[0], pl.door[2], pl.base + 3) - pl.base);
    const heightOk = pl.height >= kit.plan.PLINTH.minH && pl.height <= kit.plan.PLINTH.maxH;
    const footOk = worst >= 0, doorOk = doorStep <= 0.35 && doorStep >= -0.6;
    const bare = createWorldField(bareOfBridge(recipe, doc.id));
    const stale = Math.abs(groundFingerprint(bare, { ...frameOf([pl.position[0], pl.position[2]], [pl.position[0] + 1, pl.position[2]]) }, -pl.half, pl.half) - s.ground) > 0.05;
    lines.push(`  plinth ${heightOk && footOk && doorOk ? "ok  " : "FAIL"} ${pl.height.toFixed(1)} m (${kit.plan.PLINTH.minH}..${kit.plan.PLINTH.maxH}), walls in rock everywhere (shallowest ${r2(worst)} m, >= 0), doorway step ${doorStep} m (-0.6..0.35)`);
    if (stale) lines.push(`  STALE  the ground under it changed since the fit: worldgen bridge-place --refit --id ${doc.id}`);
    return { id: doc.id, ok: heightOk && footOk && doorOk && !stale, stale, lines };
  }
  const lines: string[] = [];
  const fid = bridgeSpanFeatureId(doc.id);
  // lips: what THIS span's patches add over the same world without them
  const lips = { alias: 0, step: 0, lip: 0, worst: 0 };
  const own = recipe.features.heightPatches.filter((p) => p.id === fid || p.id.startsWith(`${fid}-`));
  if (own.length) {
    const reference = createWorldField(bareOfBridge(recipe, doc.id));
    for (const patch of own) {
      const rep = measureTerrainLips(field, reference, { x0: patch.origin[0] - 4, z0: patch.origin[1] - 4, x1: patch.origin[0] + patch.size[0] + 4, z1: patch.origin[1] + patch.size[1] + 4 });
      lips.alias += rep.counts.alias; lips.step += rep.counts.step; lips.lip += rep.counts.lip;
      lips.worst = Math.max(lips.worst, r2(Math.max(rep.worst.alias, rep.worst.step, rep.worst.lip)));
      if (opts.faults) for (const f of rep.faults) lines.push(`    ${f.kind} @ ${f.x},${f.z} ${f.size} m`);
    }
  }
  // seated: the pads where the player steps off
  const seat = { gap: 0, clip: 0 };
  // measured through the DENSITY (a DC stack top or a planar cliff lip is not the heightfield under it), 1 m lattice
  for (const p of padsOf(doc, kit)) {
    const c = Math.cos(p.yaw), sn = Math.sin(p.yaw);
    for (let a = -p.halfX; a <= p.halfX + 1e-6; a += 1) for (let b = -p.halfZ; b <= p.halfZ + 1e-6; b += 0.5) {
      const x = p.x + a * c + b * sn, z = p.z - a * sn + b * c;
      const g = solidGround(field, x, z, p.baseY + 3);
      seat.gap = Math.max(seat.gap, p.baseY - g); seat.clip = Math.max(seat.clip, g - p.baseY);
    }
  }
  // footings: every pier / abutment stack / post bottom must be buried (no floating masonry)
  const f0: Frame = { ...frameOf(doc.a.at, doc.b.at), O: [s.origin[0], s.origin[2]] };
  let worstFoot = Infinity, worstFootAt = "";
  for (const p of s.piers) {
    const hx = p.kind === "abutment" ? kit.plan.ABUT.length / 2 : p.kind === "post" ? 0.15 : 1.4;
    const hz = p.kind === "post" ? 0.15 : kit.plan.DECK.tierDepth / 2;
    for (const [a, b] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz], [0, 0]]) {
      const x = p.position[0] + f0.dir[0] * a! + f0.perp[0] * b!, z = p.position[2] + f0.dir[1] * a! + f0.perp[1] * b!;
      const g = solidGround(field, x, z, p.position[1] + 2);
      const buried = g - p.bottom;
      if (buried < worstFoot) { worstFoot = buried; worstFootAt = `${p.kind} at ${r2(x)},${r2(z)} (ground ${r2(g)}, bottom ${p.bottom})`; }
    }
  }
  // walk probe: grade, nothing through the deck, headroom, steps on and off the ends
  const walk = { grade: 0, through: 0, throughAt: "", headroom: 0, headAt: "", step: 0, stepAt: "" };
  for (let i = 0; i + 1 < s.profile.length; i++) {
    const [sa, ya] = s.profile[i]!, [sb, yb] = s.profile[i + 1]!;
    walk.grade = Math.max(walk.grade, (Math.atan2(Math.abs(yb - ya), sb - sa) * 180) / Math.PI);
  }
  const deckHalf = s.kind === "arch" ? kit.plan.DECK.walk / 2 : kit.plan.ROPE.width / 2;
  const sMin = s.profile[0]![0], sMax = s.profile[s.profile.length - 1]![0];
  const span0 = s.kind === "arch" ? sMin + kit.plan.ABUT.length + 0.5 : 0.5, span1 = s.kind === "arch" ? sMax - kit.plan.ABUT.length - 0.5 : s.span - 0.5;
  for (const [ps, py] of s.profile) {
    for (const q of [-deckHalf + 0.2, 0, deckHalf - 0.2]) {
      const [x, z] = at(f0, ps, q);
      // over the span nothing may come within 0.3 m of the deck; on an abutment the ground stays under its paving
      // a rope deck leaving a ROCK end (no pad to cut the rim) lies on the rim for its first metres, as a real one does:
      // there the rock may touch the planks from below, up to 0.15 m above their top at an oblique rim (a body steps
      // over that; the walk chain is not a wall), never more
      const rockEnd = s.kind === "rope" && ((ps < 2.5 && (doc.a.seat ?? doc.seat) === "rock") || (ps > s.span - 2.5 && (doc.b.seat ?? doc.seat) === "rock"));
      const lim = ps > span0 && ps < span1 ? py + (rockEnd ? 0.15 : -0.3) : s.kind === "arch" ? py - 0.1 : Infinity;
      const g = solidGround(field, x, z, py + 3);
      if (g > lim && g - lim > walk.through) { walk.through = r2(g - lim); walk.throughAt = `${r2(x)},${r2(z)}`; }
      for (const h of [0.9, 1.7]) if (field.density(x, py + h, z) < 0 && h > walk.headroom) { walk.headroom = h; walk.headAt = `${r2(x)},${r2(z)}`; }
    }
  }
  for (const p of padsOf(doc, kit)) {
    // the ground the player steps onto, just past the deck's land end
    const st = (p as { step?: V3 }).step;
    const deckEnd = st ? st[2] : p.baseY + (s.kind === "arch" ? 0.16 : 0.25);
    const px = st ? st[0] : p.x, pz = st ? st[1] : p.z;
    const g = solidGround(field, px, pz, deckEnd + 3);
    if (Math.abs(deckEnd - g) > walk.step) { walk.step = r2(Math.abs(deckEnd - g)); walk.stepAt = `${r2(px)},${r2(pz)}`; }
  }
  // stages: the walkway clear of rock under its deck (but the last metres, which meet the ground), headroom, the step
  // off onto the ground, and every timber's foot in rock
  const stage = { through: 0, at: "", head: 0, headAt: "", step: 0, feet: 0, footAt: "", grade: 0 };
  for (const st of s.stages ?? []) {
    const P = st.path;
    let arc = 0; const total = P.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - P[i - 1]![0], p[2] - P[i - 1]![2]) : 0), 0);
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1]!, b = P[i]!;
      const hd = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1e-6;
      arc += hd;
      stage.grade = Math.max(stage.grade, (Math.atan2(Math.abs(b[1] - a[1]), hd) * 180) / Math.PI);
      const dir: V2 = [(b[0] - a[0]) / hd, (b[2] - a[2]) / hd], n: V2 = [-dir[1], dir[0]];
      for (const q of [-0.55, 0, 0.55]) {
        const x = b[0] + n[0] * q, z = b[2] + n[1] * q;
        const gq = solidGround(field, x, z, b[1] + 3);
        const lim = total - arc < 2.5 ? b[1] + 0.02 : b[1] - 0.15;
        if (gq > lim && gq - lim > stage.through) { stage.through = r2(gq - lim); stage.at = `${r2(x)},${r2(z)}`; }
        if (Math.abs(q) < 0.4) for (const h of [0.9, 1.7]) if (field.density(x, b[1] + h, z) < 0 && h > stage.head) { stage.head = h; stage.headAt = `${r2(x)},${r2(z)}`; }
      }
    }
    const last = P[P.length - 1]!;
    stage.step = Math.max(stage.step, r2(Math.abs(last[1] - solidGround(field, last[0], last[2], last[1] + 3))));
    for (const ft of st.feet) if (field.density(ft[0], ft[1], ft[2]) >= 0) { stage.feet++; stage.footAt = ft.map(r2).join(","); }
  }
  const stageOk = stage.through === 0 && stage.head === 0 && stage.step <= 0.35 && stage.feet === 0 && stage.grade <= 35;
  const maxGrade = s.kind === "arch" ? 1 : kit.plan.ROPE.maxSlopeDeg;
  const lipsOk = lips.alias + lips.step + lips.lip === 0;
  // a rock end's landing lies on sleepers: on a top that falls inland they take up to 0.75 m (pads stay at 0.25)
  const rockSeat = (["a", "b"] as const).some((e) => ((e === "a" ? doc.a.seat : doc.b.seat) ?? doc.seat) === "rock");
  const seatOk = seat.gap <= (rockSeat ? 0.75 : 0.25) && seat.clip <= 0.6;
  const footOk = worstFoot >= 0.3;
  const walkOk = walk.grade <= maxGrade && walk.through === 0 && walk.headroom === 0 && walk.step <= 0.35;
  let stale = false;
  {
    const bare = createWorldField(bareOfBridge(recipe, doc.id));
    const sp = s.profile;
    stale = Math.abs(groundFingerprint(bare, f0, sp[0]![0] - (s.kind === "arch" ? 6 : kit.plan.ROPE.landing + 3.7) , sp[sp.length - 1]![0] + (s.kind === "arch" ? 6 : kit.plan.ROPE.landing + 3.7)) - s.ground) > 0.05;
  }
  lines.push(`  lips   ${lipsOk ? "ok  " : "FAIL"} alias ${lips.alias}, step ${lips.step}, lip ${lips.lip}${lips.worst ? `; worst ${lips.worst} m` : ""}${own.length ? "" : " (no pads: rock seat)"}`);
  lines.push(`  seated ${seatOk ? "ok  " : "FAIL"} pads gap ${r2(seat.gap)} / clip ${r2(seat.clip)} m (limits ${rockSeat ? 0.75 : 0.25} / 0.6${rockSeat ? ": a rock end's landing on sleepers" : ""})`);
  lines.push(`  footing ${footOk ? "ok " : "FAIL"} shallowest burial ${r2(worstFoot)} m (>= 0.3)${footOk ? "" : `: ${worstFootAt}`}`);
  lines.push(`  walk   ${walkOk ? "ok  " : "FAIL"} grade ${r2(walk.grade)} deg (<= ${maxGrade}), ground through the deck ${walk.through} m${walk.throughAt ? ` @ ${walk.throughAt}` : ""}, headroom hit ${walk.headroom ? `${walk.headroom} m @ ${walk.headAt}` : "none"}, step on/off ${walk.step} m (<= 0.35)${walk.stepAt && walk.step > 0.35 ? ` @ ${walk.stepAt}` : ""}`);
  if ((s.stages ?? []).length) lines.push(`  stage  ${stageOk ? "ok  " : "FAIL"} walkway steepest ${r2(stage.grade)} deg (<= 35), rock through it ${stage.through} m${stage.at ? ` @ ${stage.at}` : ""}, headroom hit ${stage.head ? `${stage.head} m @ ${stage.headAt}` : "none"}, step onto the ground ${stage.step} m (<= 0.35), timbers not in rock ${stage.feet}${stage.footAt ? ` (e.g. ${stage.footAt})` : ""}`);
  if (stale) lines.push(`  STALE  the ground under it changed since the fit: worldgen bridge-place --refit --id ${doc.id}`);
  return { id: doc.id, ok: lipsOk && seatOk && footOk && walkOk && stageOk && !stale, stale, lines };
}

// ------------------------------------------------------------------ command

export interface BridgePlaceHost {
  argv: string[];
  project: string;
  loadRecipe(): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
}

const str = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };

function anchorArg(host: BridgePlaceHost, name: string): { at: V2; y: number | "ground" } {
  const v = str(host.argv, name);
  if (!v) host.fail(`bridge-place: --${name} "x,z[,y|ground]" is required`);
  const parts = v.split(",").map((p) => p.trim());
  const x = Number(parts[0]), z = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) host.fail(`--${name} ${v}: want "x,z[,y|ground]"`);
  const y = parts[2] === undefined || parts[2] === "ground" ? "ground" : Number(parts[2]);
  if (y !== "ground" && !Number.isFinite(y)) host.fail(`--${name} ${v}: y must be a number or "ground"`);
  return { at: [x, z], y };
}

function docsFromArgs(host: BridgePlaceHost): BridgeSpanDoc[] {
  const { argv } = host;
  const spec = str(argv, "spec");
  if (spec) {
    const raw = JSON.parse(fs.readFileSync(spec, "utf8"));
    return (Array.isArray(raw) ? raw : [raw]).map((d) => bridgeSpanSchema.parse(d));
  }
  const id = str(argv, "id");
  if (!id) host.fail("bridge-place: give --spec <file.json> or --id <slug> with --a / --b");
  const num = (k: string) => (str(argv, k) !== undefined ? Number(str(argv, k)) : undefined);
  const tiers = str(argv, "tiers");
  return [bridgeSpanSchema.parse({
    id, a: { ...anchorArg(host, "a"), seat: str(argv, "seat-a") }, b: str(argv, "kind") === "plinth" && !str(argv, "b") ? { ...anchorArg(host, "a") } : { ...anchorArg(host, "b"), seat: str(argv, "seat-b") },
    kind: str(argv, "kind") ?? "arch", style: str(argv, "style") ?? "gnawspur",
    toward: (str(argv, "toward") ?? "").trim() ? (str(argv, "toward") as string).trim().split(/\s+/).map((p) => p.split(",").map(Number) as V2) : [],
    channel: argv.includes("--channel"), tiers: tiers === undefined || tiers === "auto" ? "auto" : Number(tiers),
    bay: num("bay"), maxPier: num("max-pier"), maxWater: num("max-water"), sag: num("sag"), width: num("width"),
    rails: !argv.includes("--no-rails"), seat: str(argv, "seat") ?? "pad", owner: str(argv, "owner"), seed: str(argv, "seed"),
  })];
}

function writeFresh(host: BridgePlaceHost, mutate: (r: WorldRecipe) => void): void {
  const { recipe, file } = host.loadRecipe();
  mutate(recipe);
  const parsed = worldRecipeSchema.safeParse(recipe);
  if (!parsed.success) host.fail(`refusing to write an invalid recipe:\n${parsed.error.message}`);
  host.writeRecipe(parsed.data, file);
}

/** Refit every bridge span (filter optional) in place on `recipe`: the terrain-rebuild hook. */
export function refitBridgeSpans(recipe: WorldRecipe, kit: BridgeKit, filter: (b: BridgeSpanDoc) => boolean = () => true, log: (s: string) => void = () => {}): BridgeFit[] {
  const fits: BridgeFit[] = [];
  for (const b of [...(recipe.features.bridgeSpans ?? [])].filter(filter).sort((x, y) => (x.kind === "plinth" ? 0 : 1) - (y.kind === "plinth" ? 0 : 1))) {
    const fit = fitBridgeSpan(recipe, b, kit, log);
    applyBridgeFit(recipe, fit);
    fits.push(fit);
  }
  return fits;
}

export function commandBridgePlace(host: BridgePlaceHost): void {
  const { argv } = host;
  const dry = argv.includes("--dry-run");
  const remove = str(argv, "remove");
  if (remove) {
    if (!dry) writeFresh(host, (r) => removeBridge(r, remove));
    console.log(`removed bridge span ${remove} and its bs-${remove}* features`);
    return;
  }
  const { recipe } = host.loadRecipe();
  const ids = (str(argv, "id") ?? "").split(",").filter(Boolean);
  const existing = recipe.features.bridgeSpans ?? [];
  const pick = () => (argv.includes("--all") ? existing : existing.filter((b) => ids.includes(b.id)));
  const kit = loadBridgeKit(host.project, console.log, { dryRun: dry });
  if (argv.includes("--check")) {
    const field = createWorldField(recipe);
    let bad = 0;
    for (const b of pick()) {
      const g = bridgeGates(recipe, b, kit, { field, faults: argv.includes("--list") });
      console.log(`${g.ok ? "ok  " : "FAIL"} bridge ${b.id}`);
      for (const l of g.lines) console.log(l);
      if (!g.ok) bad++;
    }
    if (bad) process.exitCode = 1;
    return;
  }
  const docs = (argv.includes("--refit") ? pick() : docsFromArgs(host)).sort((x, y) => (x.kind === "plinth" ? 0 : 1) - (y.kind === "plinth" ? 0 : 1));
  if (!docs.length) host.fail("bridge-place: nothing to fit (no matching --id, or no bridgeSpans in the recipe)");
  const work = structuredClone(recipe);
  const t0 = Date.now();
  const fits: BridgeFit[] = [];
  for (const d of docs) {
    let fit: BridgeFit;
    try { fit = fitBridgeSpan(work, d, kit, console.log); } catch (e) { host.fail((e as Error).message); }
    applyBridgeFit(work, fit);
    fits.push(fit);
    const s = fit.doc.solved!;
    console.log(`bridge ${fit.doc.id}: ${s.kind} (${s.style}), ${s.pieces.length} pieces, ${fit.patches.length} pad patch(es)`);
    for (const w of s.warnings) console.log(`  ! ${w}`);
  }
  console.log(`  (${fits.length} fit(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  let bad = 0;
  if (!argv.includes("--no-gates")) {
    const field = createWorldField(work);
    for (const f of fits) {
      const g = bridgeGates(work, f.doc, kit, { field, faults: argv.includes("--list") });
      console.log(`${g.ok ? "ok  " : "FAIL"} gates ${f.doc.id}`);
      for (const l of g.lines) console.log(l);
      if (!g.ok) bad++;
    }
  }
  if (!dry) writeFresh(host, (r) => { for (const f of fits) applyBridgeFit(r, f); });
  else console.log("(dry run: nothing written)");
  if (bad) process.exitCode = 1;
}
