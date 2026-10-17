/**
 * LANDFORM OPERATORS — install them, gate the 6 m rule, preview them. (docs/voxel-worlds.md "Landform operators")
 *
 *   worldgen op <world> --apply <file|id> [--dry-run] [--inverse f.json]   compile + install one doc (or an array), inverse kept
 *   worldgen op <world> --remove <id> [--inverse f.json]                    drop an operator and its op:<id>:* pieces, inverse kept
 *   worldgen op <world> --undo <inverse.json>                               apply a kept inverse batch
 *   worldgen op <world> --list | --check                                    installed operators (--check: EDITED / MISSING / STALE)
 *   worldgen fine <world> [--near x,z,r] [--json] [--out f.json] [--list] [--record-legacy]
 *        the 6 m gate: any passage / height patch / blob finer than 6 m (three 2 m lattice steps) fails —
 *        "too fine for terrain: use a kit/hero piece or an operator". `--record-legacy` writes every current violation
 *        to <project>/authoring/terrain/<world>.fine-legacy.json so a world built before the rule passes (and is counted).
 *   worldgen op-preview <world> --near x,z,r [--op <file|id>] [--out dir]
 *        a top-down map PNG (height shading, contours, walkable / too-steep mask, footprint, scale bar; before | after)
 *        and a standalone three.js page of just that area (terrain meshed in node by the engine's own mesher, the
 *        zone's ground and cliff textures, sun, orbit + walk, before/after toggle). Opens from disk; no engine boot.
 *
 * Every command takes `--recipe <file>` (worldgen-wide) to work on a scratch copy.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyOperator,
  applyRecipeEdits,
  buildVolumeMesh,
  createVolume,
  compileLandmarkOperator,
  landmarkOperatorSchema,
  decodeHeightfieldValues,
  landmarkOptions,
  landmarkTileDoc,
  ledgeLandmarkVolume,
  ledgesOperatorSchema,
  solveLedges,
  buildVoxelMesh,
  checkOperators,
  createWorldField,
  fineCarves,
  FINE_MIN,
  FINE_REMEDY,
  getOperator,
  operatorParams,
  recipeEditSchema,
  removeOperator,
  ribbonArc,
  ribbonHalfWidth,
  withoutOperatorPieces,
  type OperatorFieldReader,
  type RecipeEdit,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { encodePng, decodePng } from "./_png.mjs";
import { findAsset } from "./_closure.mjs";

export interface OpHost {
  argv: string[];
  loadRecipe(): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
  project: string;
}

/** The player's walk limit: packages/physics DEFAULT_CHARACTER.maxSlopeClimbAngle (50 degrees). */
export const WALK_SLOPE_DEG = 50;

const opt = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

export function operatorReader(recipe: WorldRecipe, id: string): OperatorFieldReader {
  const field = createWorldField(withoutOperatorPieces(recipe, id));
  return { height: (x, z) => field.height(x, z), density: (x, y, z) => field.density(x, y, z), voxelSize: field.voxelSize, seaLevel: recipe.seaLevel, seed: recipe.seed };
}

/** `--apply` source: a JSON file holding one doc or an array, else the id of an operator already in the recipe. */
function operatorDocs(recipe: WorldRecipe, ref: string, fail: OpHost["fail"], project?: string): Record<string, unknown>[] {
  if (fs.existsSync(ref)) {
    const j = JSON.parse(fs.readFileSync(ref, "utf8"));
    return (Array.isArray(j) ? j : [j]).map((d: Record<string, unknown>) => inlineLandmarkSource(d, [path.dirname(ref), ...(project ? [path.join("projects", project)] : []), "."], fail));
  }
  const doc = (recipe.features.operators ?? []).find((o) => o.id === ref);
  if (!doc) fail(`--apply ${ref}: no such file and no operator "${ref}" in the recipe`);
  return [inlineLandmarkSource(doc as Record<string, unknown>, [...(project ? [path.join("projects", project)] : []), "."], fail)];
}

/** A `landmark` doc whose source names a spec FILE gets the spec inlined into `source.csg` (file kept): the recipe always
 *  carries the solids, and re-applying by id picks up an edited file. Searched next to the op file, then in the project. */
function inlineLandmarkSource(doc: Record<string, unknown>, roots: string[], fail: OpHost["fail"]): Record<string, unknown> {
  const src = doc.source as Record<string, unknown> | undefined;
  if (doc.op !== "landmark" || !src || typeof src.file !== "string") return doc;
  const file = roots.map((r) => path.resolve(r, src.file as string)).find((f) => fs.existsSync(f));
  if (!file) { if (src.csg) return doc; fail(`landmark "${String(doc.id)}": source.file ${String(src.file)} not found (looked in ${roots.join(", ")})`); }
  return { ...doc, source: { csg: JSON.parse(fs.readFileSync(file!, "utf8")), file: src.file } };
}

/**
 * Where a world's operator side files live: <project>/authoring/terrain for a project world (NOT assets/worlds — every
 * json there is registered as a world recipe), next to the file for a scratch copy.
 */
export function sideDir(recipeFile: string): string {
  const parts = path.resolve(recipeFile).split(/[\\/]/);
  const at = parts.lastIndexOf("assets");
  if (at > 1 && parts[at - 2] === "projects" && parts[at + 1] === "worlds") return path.join(...parts.slice(0, at), "authoring", "terrain");
  return path.dirname(recipeFile);
}
function undoDir(file: string): string {
  return path.join(sideDir(file), "undo");
}
function keepInverse(file: string, recipe: WorldRecipe, what: string, inverse: RecipeEdit[], explicit?: string): string {
  const out = explicit ?? path.join(undoDir(file), `${recipe.name}.${what}.${new Date().toISOString().replace(/[:.]/g, "-")}.inverse.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ world: recipe.name, what, edits: inverse }, null, 1)}\n`);
  return out;
}

export function commandOp(host: OpHost): void {
  const { argv, fail } = host;
  const { recipe, file } = host.loadRecipe();
  const apply = opt(argv, "apply"), remove = opt(argv, "remove"), undo = opt(argv, "undo");
  if (argv.includes("--list") || argv.includes("--check") || (!apply && !remove && !undo)) {
    const rows = checkOperators(recipe, argv.includes("--check") ? (id) => operatorReader(recipe, id) : undefined);
    if (!rows.length) console.log(`${recipe.name}: no landform operators`);
    for (const r of rows) {
      const doc = recipe.features.operators!.find((o) => o.id === r.id)!;
      console.log(`  ${r.state.padEnd(10)} ${r.id.padEnd(24)} ${r.op.padEnd(10)} ${doc.compiled?.pieces.join(", ") ?? ""}${r.why ? ` — ${r.why}` : ""}`);
    }
    if (rows.some((r) => r.state !== "ok")) process.exitCode = 1;
    return;
  }
  if (undo) {
    const j = JSON.parse(fs.readFileSync(undo, "utf8"));
    const edits = (j.edits ?? j) as unknown[];
    const parsed = edits.map((e) => recipeEditSchema.parse(e));
    const res = applyRecipeEdits(recipe, parsed);
    const back = keepInverse(file, recipe, "undo", res.inverse, opt(argv, "inverse"));
    host.writeRecipe(res.recipe, file);
    console.log(`  undone (${parsed.length} edits); redo with --undo ${back}`);
    return;
  }
  if (remove) {
    let res;
    try { res = removeOperator(recipe, remove); } catch (e) { fail((e as Error).message); }
    if (argv.includes("--dry-run")) { console.log(`  would remove ${res.edits.length} feature(s)`); return; }
    const inv = keepInverse(file, recipe, `remove-${remove}`, res.inverse, opt(argv, "inverse"));
    host.writeRecipe(res.recipe, file);
    console.log(`  removed ${remove} (${res.edits.length} edits); inverse: ${inv}`);
    return;
  }
  let current = recipe;
  const inverse: RecipeEdit[] = [];
  for (const doc of operatorDocs(recipe, apply!, fail, host.project)) {
    const id = String(doc.id ?? "");
    const t0 = performance.now();
    let res;
    try { res = applyOperator(current, doc, operatorReader(current, id)); } catch (e) { fail((e as Error).message); }
    current = res.recipe;
    inverse.unshift(...res.inverse);
    console.log(`  ${id} (${String(doc.op)}): ${res.doc.compiled!.pieces.join(", ")} in ${Math.round(performance.now() - t0)} ms`);
    console.log(`    ${JSON.stringify(res.report).slice(0, 900)}`);
  }
  if (argv.includes("--dry-run")) return;
  const inv = keepInverse(file, recipe, `apply-${path.basename(apply!, ".json")}`, inverse, opt(argv, "inverse"));
  host.writeRecipe(current, file);
  console.log(`  inverse: ${inv}  (worldgen op ${recipe.name} --undo <it>)`);
  const fine = fineCarves(current, { legacy: readLegacy(file) });
  console.log(`  6 m gate: ${fine.ok ? "ok" : `${fine.faults.length} fault(s)`}${fine.legacy.length ? ` (${fine.legacy.length} legacy)` : ""}`);
}

// ------------------------------------------------------------------ the 6 m gate

export function legacyFile(recipeFile: string): string {
  return path.join(sideDir(recipeFile), path.basename(recipeFile).replace(/\.json$/i, ".fine-legacy.json"));
}
export function readLegacy(recipeFile: string): string[] {
  const f = legacyFile(recipeFile);
  if (!fs.existsSync(f)) return [];
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  return Array.isArray(j.ids) ? j.ids : [];
}

/** One line for `worldgen status`. */
export function fineStatusLine(recipe: WorldRecipe, file: string): { ok: boolean; line: string } {
  const rep = fineCarves(recipe, { legacy: readLegacy(file) });
  const tail = `${rep.legacy.length} legacy, ${rep.exempt} kit-owned (tw-/bs-)`;
  return rep.ok
    ? { ok: true, line: `ok      terrain-fine  (6 m rule: ${tail})` }
    : { ok: false, line: `FAIL    terrain-fine  — ${rep.faults.length} carve(s) under ${FINE_MIN} m: ${FINE_REMEDY} (worldgen fine ${recipe.name} --list; ${tail})` };
}

export function commandFine(host: OpHost): void {
  const { argv, fail } = host;
  const { recipe, file } = host.loadRecipe();
  const nearArg = opt(argv, "near");
  const near = nearArg ? (nearArg.split(",").map(Number) as [number, number, number]) : undefined;
  if (near && (near.length !== 3 || near.some((v) => !Number.isFinite(v)))) fail("--near x,z,r");
  if (argv.includes("--record-legacy")) {
    const all = fineCarves(recipe, {});
    const ids = all.faults.map((f) => `${f.kind}/${f.id}`);
    fs.writeFileSync(legacyFile(file), `${JSON.stringify({
      note: "Carves finer than the 6 m rule, recorded when the rule landed (2026-10-15). They pass and are counted; new ones fail. Replace them with operators or kit pieces, then drop them from this list.",
      recorded: new Date().toISOString().slice(0, 10), count: ids.length, ids,
    }, null, 1)}\n`);
    console.log(`  recorded ${ids.length} legacy fine carve(s) in ${legacyFile(file)}`);
    return;
  }
  const rep = fineCarves(recipe, { legacy: readLegacy(file), near });
  const out = { ok: rep.ok, rule: `smallest dimension >= ${FINE_MIN} m`, remedy: FINE_REMEDY, near: near ?? null, counts: { faults: rep.faults.length, legacy: rep.legacy.length, exempt: rep.exempt }, faults: rep.faults, legacy: rep.legacy.length };
  const outFile = opt(argv, "out");
  if (outFile) { fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); fs.writeFileSync(outFile, `${JSON.stringify(out, null, 1)}\n`); }
  if (argv.includes("--json")) console.log(JSON.stringify(out, null, 1));
  else {
    console.log(`${recipe.name}: 6 m gate ${rep.ok ? "ok" : "FAIL"} — ${rep.faults.length} fault(s), ${rep.legacy.length} legacy, ${rep.exempt} kit-owned${near ? ` within ${near[2]} m of ${near[0]},${near[1]}` : ""}`);
    const show = argv.includes("--list") ? rep.faults : rep.faults.slice(0, 12);
    for (const f of show) console.log(`  ${f.kind}/${f.id}: ${f.what} — ${FINE_REMEDY}`);
    if (show.length < rep.faults.length) console.log(`  ... ${rep.faults.length - show.length} more (--list)`);
  }
  if (!rep.ok) process.exitCode = 1;
}

// ------------------------------------------------------------------ preview

interface Area { x: number; z: number; r: number }

function sampleGrid(field: WorldField, a: Area, res: number): { n: number; h: Float32Array } {
  const n = Math.round((2 * a.r) / res) + 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = field.height(a.x - a.r + i * res, a.z - a.r + j * res);
  return { n, h };
}

/** 3x5 pixel glyphs for map labels. */
const GLYPHS: Record<string, string> = {
  "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111", "4": "101101111001001",
  "5": "111100111001111", "6": "111100111101111", "7": "111001001001001", "8": "111101111101111", "9": "111101111001111",
  M: "101111111101101", B: "110101110101110", E: "111100110100111", F: "111100110100100", O: "111101101101111",
  R: "110101110101101", A: "010101111101101", T: "111010010010010", " ": "000000000000000", N: "101111111111101",
  W: "101101111111101", L: "100100100100111", K: "101101110101101", S: "111100111001111", P: "111101111100100",
  "-": "000000111000000", ".": "000000000000010", C: "111100100100111", D: "110101101101110", G: "111100101101111",
  I: "111010010010111", H: "101101111101101", U: "101101101101111", V: "101101101101010", Y: "101101010010010",
};

class Canvas {
  readonly px: Uint8Array;
  constructor(readonly w: number, readonly h: number) { this.px = new Uint8Array(w * h * 4); }
  set(x: number, y: number, c: [number, number, number], a = 1): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    for (let k = 0; k < 3; k++) this.px[o + k] = Math.round(this.px[o + k]! * (1 - a) + c[k]! * a);
    this.px[o + 3] = 255;
  }
  rect(x: number, y: number, w: number, h: number, c: [number, number, number], a = 1): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, a);
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], width = 1): void {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps, y = y0 + ((y1 - y0) * s) / steps;
      this.rect(x - (width - 1) / 2, y - (width - 1) / 2, width, width, c);
    }
  }
  text(x: number, y: number, s: string, c: [number, number, number], scale = 2): void {
    for (const ch of s.toUpperCase()) {
      const g = GLYPHS[ch] ?? GLYPHS[" "]!;
      for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (g[j * 3 + i] === "1") this.rect(x + i * scale, y + j * scale, scale, scale, c);
      x += 4 * scale;
    }
  }
}

/** The SOLVED ribbon of a `path` op as map lines (op-preview): edges of the walk surface (green, magenta where a retaining wall
 *  stands on that side), the centreline (grey), stair flights (yellow, a tick per tread) and switchback turns (red). Open
 *  polylines, unlike the closed operator outlines. */
interface OverlayLine { pts: [number, number][]; col: [number, number, number]; w: number }
function ribbonOverlay(recipe: WorldRecipe | null, opId: string): OverlayLine[] {
  const r = recipe?.features?.ribbons?.find((x) => x.id === `op:${opId}:ribbon`);
  if (!r) return [];
  const arc = ribbonArc(r), S = r.samples, out: OverlayLine[] = [];
  const edge = (i: number, side: -1 | 1): [number, number] => {
    const a = S[Math.max(0, i - 1)]!, b = S[Math.min(S.length - 1, i + 1)]!;
    const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
    const hw = ribbonHalfWidth(r, arc[i]!, side);
    return [S[i]![0] + (-dz / l) * side * hw, S[i]![2] + (dx / l) * side * hw];
  };
  out.push({ pts: S.map((p) => [p[0], p[2]] as [number, number]), col: [200, 200, 200], w: 1 });
  for (const side of [-1, 1] as const) {
    let run: [number, number][] = [], wall = false;
    const flush = () => { if (run.length > 1) out.push({ pts: run, col: wall ? [255, 0, 255] : [90, 255, 90], w: 2 }); };
    for (let i = 0; i < S.length; i++) {
      const w = (side > 0 ? S[i]![4] : S[i]![3]) < 0;
      if (i > 0 && w !== wall) { flush(); run = run.length ? [run[run.length - 1]!] : []; }
      wall = w; run.push(edge(i, side));
    }
    flush();
  }
  for (const f of r.flights) {
    out.push({ pts: S.slice(f.from, f.to + 1).map((p) => [p[0], p[2]] as [number, number]), col: [255, 220, 0], w: 3 });
    for (const t of f.treads) {   // a tick across the ribbon at each tread's start
      let i = f.from; while (i < f.to && arc[i]! < t[0]) i++;
      out.push({ pts: [edge(i, -1), edge(i, 1)], col: [255, 220, 0], w: 1 });
    }
  }
  let lastTurn = -99;   // switchback turns: the heading reverses by more than ~100 degrees over 8 m each way
  for (let i = 8; i < S.length - 8; i++) {
    const a = [S[i]![0] - S[i - 8]![0], S[i]![2] - S[i - 8]![2]], b = [S[i + 8]![0] - S[i]![0], S[i + 8]![2] - S[i]![2]];
    const c = (a[0]! * b[0]! + a[1]! * b[1]!) / ((Math.hypot(a[0]!, a[1]!) * Math.hypot(b[0]!, b[1]!)) || 1);
    if (c < -0.2 && i - lastTurn > 12) { lastTurn = i; out.push({ pts: [[S[i]![0] - 1.5, S[i]![2] - 1.5], [S[i]![0] + 1.5, S[i]![2] + 1.5]], col: [255, 60, 60], w: 4 }); }
  }
  return out;
}

/** An operator's compiled kit walls (`features.kitWalls` `op:<id>:wall-*`): map lines along each face (magenta) and,
 *  for the 3D page, one quad per 2 m module from its foot to its cap (grey stone). */
type WallQuad = { a: [number, number]; b: [number, number]; y0: number; y1: number };
function kitWallOverlay(recipe: WorldRecipe | null, opId: string): { lines: OverlayLine[]; quads: WallQuad[] } {
  const lines: OverlayLine[] = [], quads: WallQuad[] = [];
  for (const w of recipe?.features?.kitWalls ?? []) {
    if (!w.id.startsWith(`op:${opId}:`)) continue;
    const pts: [number, number][] = [];
    for (const c of w.cuts) {
      const a: [number, number] = [c.origin[0], c.origin[1]], b: [number, number] = [c.origin[0] + c.dir[0] * c.s[1], c.origin[1] + c.dir[1] * c.s[1]];
      if (!pts.length) pts.push(a);
      pts.push(b);
      quads.push({ a, b, y0: c.y[0], y1: c.y[1] - 2 });
    }
    lines.push({ pts, col: [255, 0, 255], w: 2 });
  }
  return { lines, quads };
}

/** One map panel: hillshade x hypsometric tint, too-steep mask, contours, outline, scale bar. */
function drawPanel(cv: Canvas, ox: number, oy: number, size: number, grid: { n: number; h: Float32Array }, res: number, a: Area,
  outlines: [number, number][][], label: string, hRange: [number, number], seaLevel: number, overlay: OverlayLine[] = []): { steep: number; walk: number } {
  const { n, h } = grid;
  const at = (i: number, j: number) => h[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))]!;
  const tanWalk = Math.tan((WALK_SLOPE_DEG * Math.PI) / 180);
  let steep = 0, walk = 0;
  const sc = size / (n - 1);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const i = Math.round(px / sc), j = Math.round(py / sc);
    const y = at(i, j);
    const dx = (at(i + 1, j) - at(i - 1, j)) / (2 * res), dz = (at(i, j + 1) - at(i, j - 1)) / (2 * res);
    const grad = Math.hypot(dx, dz);
    // hillshade, sun from the northwest
    const nx = -dx, nz = -dz, ny = 1, nl = Math.hypot(nx, ny, nz);
    const shade = Math.max(0.25, (nx * -0.5 + ny * 0.75 + nz * -0.43) / nl);
    const t = Math.max(0, Math.min(1, (y - hRange[0]) / Math.max(1, hRange[1] - hRange[0])));
    let c: [number, number, number] = y < seaLevel ? [70, 110, 160] : [Math.round(95 + 120 * t), Math.round(125 + 85 * t), Math.round(80 + 90 * t)];
    c = [c[0] * shade, c[1] * shade, c[2] * shade].map((v) => Math.min(255, Math.round(v))) as [number, number, number];
    cv.set(ox + px, oy + py, c);
    if (grad > tanWalk) { cv.set(ox + px, oy + py, [220, 40, 40], 0.55); if ((px + py) % 4 === 0) steep++; }
    else if ((px + py) % 4 === 0) walk++;
  }
  // contours: thin every 2 m, bold every 10 m
  for (let py = 0; py < size - 1; py++) for (let px = 0; px < size - 1; px++) {
    const y0 = at(Math.round(px / sc), Math.round(py / sc));
    const y1 = at(Math.round((px + 1) / sc), Math.round(py / sc)), y2 = at(Math.round(px / sc), Math.round((py + 1) / sc));
    for (const [step, col, alpha] of [[10, [20, 20, 20], 0.75], [2, [30, 30, 30], 0.3]] as const) {
      const b0 = Math.floor(y0 / step);
      if (b0 !== Math.floor(y1 / step) || b0 !== Math.floor(y2 / step)) { cv.set(ox + px, oy + py, col as unknown as [number, number, number], alpha); break; }
    }
  }
  const toPx = (x: number, z: number): [number, number] => [ox + ((x - (a.x - a.r)) / (2 * a.r)) * size, oy + ((z - (a.z - a.r)) / (2 * a.r)) * size];
  for (const loop of outlines) for (let k = 0; k < loop.length; k++) {
    const [x0, y0] = toPx(...loop[k]!), [x1, y1] = toPx(...loop[(k + 1) % loop.length]!);
    cv.line(x0, y0, x1, y1, [0, 230, 255], 2);
  }
  for (const l of overlay) for (let k = 0; k + 1 < l.pts.length; k++) {
    const [x0, y0] = toPx(...l.pts[k]!), [x1, y1] = toPx(...l.pts[k + 1]!);
    cv.line(x0, y0, x1, y1, l.col, l.w);
  }
  // scale bar: a round length near a fifth of the panel
  const nice = [10, 20, 25, 50, 100, 200, 250, 500].find((m) => m >= (2 * a.r) / 6) ?? 500;
  const barPx = (nice / (2 * a.r)) * size;
  cv.rect(ox + 12, oy + size - 22, barPx, 6, [255, 255, 255]);
  cv.rect(ox + 12, oy + size - 22, barPx / 2, 6, [0, 0, 0]);
  cv.text(ox + 16 + barPx, oy + size - 26, `${nice} M`, [255, 255, 255]);
  cv.text(ox + 10, oy + 10, label, [255, 255, 255], 3);
  return { steep, walk };
}

interface MeshOut { pos: Float32Array; nrm: Int8Array; idx: Uint32Array; cliff: Uint8Array; tint: Uint8Array }

/** Mesh every cell over the area with the engine's own mesher; world-space positions; per-vertex cliff share + tint. */
function meshArea(field: WorldField, recipe: WorldRecipe, a: Area, cliffSurf: Set<number>): MeshOut {
  const cs = recipe.cellSize;
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [], cliff: number[] = [], tint: number[] = [];
  for (let cz = Math.floor((a.z - a.r) / cs); cz <= Math.floor((a.z + a.r) / cs); cz++) {
    for (let cx = Math.floor((a.x - a.r) / cs); cx <= Math.floor((a.x + a.r) / cs); cx++) {
      const m = buildVoxelMesh(field, { kind: "voxel", world: recipe.name, cell: [cx, cz] });
      const base = pos.length / 3, vn = m.positions.length / 3;
      for (let v = 0; v < vn; v++) {
        pos.push(m.positions[v * 3]! + cx * cs, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]! + cz * cs);
        for (let k = 0; k < 3; k++) nrm.push(Math.round(Math.max(-1, Math.min(1, m.normals[v * 3 + k]!)) * 127));
        let c = 0;
        if (m.layerIndex && m.layerWeight) {
          for (let k = 0; k < 4; k++) if (cliffSurf.has(m.layerIndex[v * 4 + k]!)) c += m.layerWeight[v * 4 + k]! / 255;
        } else {
          for (let k = 0; k < m.surfaceCount; k++) if (cliffSurf.has(k)) c += m.splat[v * m.surfaceCount + k]!;
        }
        // the slope decides too: a face steeper than the walk limit reads as rock whatever its splat
        const ny = m.normals[v * 3 + 1]!;
        c = Math.max(c, Math.max(0, Math.min(1, (Math.cos((40 * Math.PI) / 180) - ny) / 0.15)));
        cliff.push(Math.round(Math.min(1, c) * 255));
        for (let k = 0; k < 3; k++) tint.push(Math.round(Math.max(0, Math.min(2, m.tint[v * 3 + k] ?? 1)) * 127));
      }
      for (let k = 0; k < m.indices.length; k++) idx.push(m.indices[k]! + base);
    }
  }
  return { pos: Float32Array.from(pos), nrm: Int8Array.from(nrm), idx: Uint32Array.from(idx), cliff: Uint8Array.from(cliff), tint: Uint8Array.from(tint) };
}

/** Surfaces that read as rock (cliff role or a rock/cliff name), and the most-used ground and cliff textures in the area. */
function areaSurfaces(field: WorldField, recipe: WorldRecipe, a: Area): { cliff: Set<number>; ground: string | null; rock: string | null } {
  const cliff = new Set<number>();
  recipe.surfaces.forEach((s, i) => { if ((s as { role?: string }).role === "cliff" || /cliff|rock|clints/i.test(s.name)) cliff.add(i); });
  const tally = new Float64Array(recipe.surfaces.length);
  const out = new Float32Array(recipe.surfaces.length);
  for (let j = 0; j <= 10; j++) for (let i = 0; i <= 10; i++) {
    const x = a.x - a.r + (i / 10) * 2 * a.r, z = a.z - a.r + (j / 10) * 2 * a.r;
    out.fill(0);
    field.splatAt(x, field.height(x, z), z, 1, out, 0);
    out.forEach((w, k) => (tally[k]! += w));
  }
  const best = (want: boolean) => {
    let k = -1;
    tally.forEach((w, i) => { if (cliff.has(i) === want && (k < 0 || w > tally[k]!)) k = i; });
    return k >= 0 ? (recipe.surfaces[k] as { map?: string }).map ?? null : null;
  };
  return { cliff, ground: best(false), rock: best(true) ?? "mmo/RockGrey.png" };
}

/** A texture as a data URI, nearest-downsampled to at most 512 px (keeps the page small). */
function textureUri(project: string, rel: string | null): string | null {
  if (!rel) return null;
  const file = findAsset(project, path.join("textures", rel)) as string | null;
  if (!file) return null;
  const img = decodePng(fs.readFileSync(file)) as { width: number; height: number; data: Uint8Array };
  const f = Math.max(1, Math.ceil(Math.max(img.width, img.height) / 512));
  const w = Math.floor(img.width / f), h = Math.floor(img.height / f);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) px[(y * w + x) * 4 + k] = img.data[((y * f) * img.width + x * f) * 4 + k]!;
  return `data:image/png;base64,${Buffer.from(encodePng(w, h, px)).toString("base64")}`;
}

const b64 = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");

export function commandOpPreview(host: OpHost): void {
  const { argv, fail } = host;
  const t0 = performance.now();
  const { recipe, file } = host.loadRecipe();
  const project = host.project || projectOf(file);
  const opRef = opt(argv, "op");
  let doc: Record<string, unknown> | null = null;
  if (opRef) doc = operatorDocs(recipe, opRef, fail, host.project)[0]!;
  const nearArg = opt(argv, "near");
  let a: Area;
  if (nearArg) {
    const [x, z, r] = nearArg.split(",").map(Number);
    if (![x, z, r].every((v) => Number.isFinite(v))) fail("--near x,z,r");
    a = { x: x!, z: z!, r: r! };
  } else if (doc) {
    const o = getOperator(String(doc.op));
    if (!o) fail(`unknown operator ${String(doc.op)}`);
    const b = o.bounds(o.schema.parse(operatorParams(doc)) as never);
    a = { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2, r: Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2 + 40 };
  } else fail("op-preview needs --near x,z,r or --op <file|id>");
  if (a.r > 400) fail("--near radius above 400 m: preview a smaller area");
  const id = doc ? String(doc.id) : "area";
  const outDir = opt(argv, "out") ?? path.join(os.tmpdir(), "hitreg-op-preview", `${recipe.name}-${id}`);
  fs.mkdirSync(outDir, { recursive: true });

  // before = the ground without this operator's pieces; after = compiled fresh against it
  const before = doc ? withoutOperatorPieces(recipe, id) : recipe;
  let after: WorldRecipe | null = null, report: unknown = null;
  if (doc) {
    try {
      const res = applyOperator(before, doc, operatorReader(before, id));
      after = res.recipe; report = res.report;
    } catch (e) { fail((e as Error).message); }
  }
  const tCompile = performance.now();
  const fBefore = createWorldField(before);
  const fAfter = after ? createWorldField(after) : null;
  const res = Math.max(1, Math.round((2 * a.r) / 300));
  const gBefore = sampleGrid(fBefore, a, res);
  const gAfter = fAfter ? sampleGrid(fAfter, a, res) : null;
  // a landmark stands on the terrain: the map and the walk read the higher of the two
  const landmark = doc && after ? (String(doc.op) === "landmark" ? stampPreview(before, after, doc) : landmarkPreview(before, doc)) : null;
  if (landmark && gAfter) for (let j = 0; j < gAfter.n; j++) for (let i = 0; i < gAfter.n; i++) {
    const t = landmark.top(a.x - a.r + i * res, a.z - a.r + j * res);
    if (t !== null && t > gAfter.h[j * gAfter.n + i]!) gAfter.h[j * gAfter.n + i] = t;
  }
  let lo = Infinity, hi = -Infinity;
  for (const g of [gBefore, gAfter]) if (g) for (const v of g.h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const o = doc ? getOperator(String(doc.op)) : undefined;
  const outlines = o?.outline ? o.outline(o.schema.parse(operatorParams(doc!)) as never) : [];
  const kw = doc ? kitWallOverlay(after, id) : { lines: [], quads: [] };
  const overlay = [...(doc && String(doc.op) === "path" ? ribbonOverlay(after, id) : []), ...kw.lines];
  const panel = 600, pad = 8;
  const cv = new Canvas(gAfter ? panel * 2 + pad * 3 : panel + pad * 2, panel + pad * 2);
  cv.rect(0, 0, cv.w, cv.h, [24, 24, 28]);
  const sb = drawPanel(cv, pad, pad, panel, gBefore, res, a, outlines, doc ? "BEFORE" : recipe.name, [lo, hi], recipe.seaLevel, overlay);
  const sa = gAfter ? drawPanel(cv, panel + pad * 2, pad, panel, gAfter, res, a, outlines, "AFTER", [lo, hi], recipe.seaLevel, overlay) : null;
  const mapFile = path.join(outDir, "map.png");
  fs.writeFileSync(mapFile, encodePng(cv.w, cv.h, cv.px));
  const tMap = performance.now();

  // meshes, textures, page
  const surf = areaSurfaces(fBefore, recipe, a);
  const mBefore = meshArea(fBefore, before, a, surf.cliff);
  const mAfter = fAfter ? meshArea(fAfter, after!, a, surf.cliff) : null;
  const tMesh = performance.now();
  const walkGrid = gAfter ?? gBefore;
  const page = previewHtml({
    title: `${recipe.name} ${id}`, area: a, seaLevel: recipe.seaLevel,
    before: mBefore, after: mAfter, groundTex: textureUri(project, surf.ground), rockTex: textureUri(project, surf.rock),
    walk: { n: walkGrid.n, res, h: b64(walkGrid.h), before: b64(gBefore.h) }, mapPng: `data:image/png;base64,${fs.readFileSync(mapFile).toString("base64")}`,
    report, outlines, overlay, walls: kw.quads, landmark: landmark?.mesh ?? null,
  });
  const pageFile = path.join(outDir, "preview.html");
  fs.writeFileSync(pageFile, page);
  const t1 = performance.now();
  const pct = (s: { steep: number; walk: number }) => `${Math.round((100 * s.steep) / Math.max(1, s.steep + s.walk))}% too steep`;
  console.log(`${recipe.name} op-preview ${id} @ ${a.x},${a.z} r ${a.r}: ${sb ? pct(sb) : ""}${sa ? ` -> ${pct(sa)}` : ""} (walk limit ${WALK_SLOPE_DEG} deg)`);
  if (report) console.log(`  report: ${JSON.stringify(report).slice(0, 700)}`);
  console.log(`  map:  ${mapFile}`);
  console.log(`  page: ${pageFile} (${Math.round(page.length / 1024)} KB, ${(mBefore.idx.length / 3) | 0}${mAfter ? ` / ${(mAfter.idx.length / 3) | 0}` : ""} tris${landmark ? `, landmark ${landmark.tris} tris at 1 m` : ""})`);
  console.log(`  timing: compile ${Math.round(tCompile - t0)} ms, map ${Math.round(tMap - tCompile)} ms, mesh ${Math.round(tMesh - tMap)} ms, page ${Math.round(t1 - tMesh)} ms, total ${((t1 - t0) / 1000).toFixed(1)} s`);
}

function projectOf(file: string): string {
  const m = /projects[\\/]([^\\/]+)[\\/]assets/.exec(file);
  return m ? m[1]! : "foundation";
}

/**
 * A `ledges` landmark for op-preview, rebuilt from the same solve the compile ran (no bake needed): the solids meshed at
 * 1 m (a preview; the bake is at the operator's voxel) in world space, plus the rock-top heightfield so the map and the
 * walk mode stand on the landmark rather than on the terrain under it.
 */
function stampPreview(before: WorldRecipe, after: WorldRecipe, doc: Record<string, unknown>): { mesh: MeshOut; top: (x: number, z: number) => number | null; tris: number } | null {
  const id = String(doc.id), p = landmarkOperatorSchema.parse(operatorParams(doc));
  const c = compileLandmarkOperator(p, operatorReader(before, id), { id }, { skipThin: true });
  const piece = (after.features.landmarks ?? []).find((l) => l.id === `op:${id}:landmark`);
  if (!c || !piece) return null;
  const [ox, oy, oz] = piece.position, f = Math.max(0.5, c.compiled.voxel);
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const tops = new Map<string, number>();
  for (const tile of c.compiled.tiles) {
    const m = buildVolumeMesh(createVolume({ voxelSize: f, bounds: tile, palette: ["rock"], nodes: c.compiled.nodes }));
    const base = pos.length / 3;
    for (let i = 0; i < m.vertexCount; i++) {
      const x = m.positions[i * 3]! + ox, y = m.positions[i * 3 + 1]! + oy, z = m.positions[i * 3 + 2]! + oz;
      pos.push(x, y, z);
      for (let k = 0; k < 3; k++) nrm.push(Math.round(m.normals[i * 3 + k]! * 127));
      const key = `${Math.round(x)},${Math.round(z)}`; if (y > (tops.get(key) ?? -Infinity)) tops.set(key, y);
    }
    for (const v of m.indices) idx.push(v + base);
  }
  const n = pos.length / 3;
  return { mesh: { pos: Float32Array.from(pos), nrm: Int8Array.from(nrm), idx: Uint32Array.from(idx), cliff: new Uint8Array(n).fill(255), tint: new Uint8Array(n * 3).fill(127) }, top: (x, z) => tops.get(`${Math.round(x)},${Math.round(z)}`) ?? null, tris: idx.length / 3 };
}

function landmarkPreview(before: WorldRecipe, doc: Record<string, unknown> | null): { mesh: MeshOut; top: (x: number, z: number) => number | null; tris: number } | null {
  if (!doc || String(doc.op) !== "ledges") return null;
  const p = ledgesOperatorSchema.parse(operatorParams(doc));
  if (p.mode !== "landmark") return null;
  const id = String(doc.id), reader = operatorReader(before, id);
  const lm = ledgeLandmarkVolume(solveLedges(p, reader, { id }).grid, { ...landmarkOptions(p, reader) });
  const coarse = { ...lm, voxel: 1 };
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  for (let t = 0; t < lm.tiles.length; t++) {
    const m = buildVolumeMesh(createVolume(landmarkTileDoc(coarse, t, ["rock"], { floor: 0, wall: 0, ceiling: 0 })));
    const base = pos.length / 3;
    for (let i = 0; i < m.vertexCount; i++) {
      pos.push(m.positions[i * 3]! + lm.origin[0], m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]! + lm.origin[2]);
      for (let k = 0; k < 3; k++) nrm.push(Math.round(m.normals[i * 3 + k]! * 127));
    }
    for (const v of m.indices) idx.push(v + base);
  }
  const n = pos.length / 3;
  const hf = (lm.nodes[0] as unknown as { size: number[]; heightfield: { width: number; depth: number; values: string } });
  const L = decodeHeightfieldValues(hf.heightfield.values), w = hf.heightfield.width, dpt = hf.heightfield.depth;
  const x0 = lm.origin[0] - hf.size[0]! / 2, z0 = lm.origin[2] - hf.size[2]! / 2, f = lm.voxel;
  const top = (x: number, z: number) => {
    const i = Math.round((x - x0) / f), j = Math.round((z - z0) / f);
    return i < 0 || j < 0 || i >= w || j >= dpt ? null : L[j * w + i]!;
  };
  return { mesh: { pos: Float32Array.from(pos), nrm: Int8Array.from(nrm), idx: Uint32Array.from(idx), cliff: new Uint8Array(n).fill(255), tint: new Uint8Array(n * 3).fill(127) }, top, tris: idx.length / 3 };
}

function previewHtml(d: {
  title: string; area: Area; seaLevel: number; before: MeshOut; after: MeshOut | null; groundTex: string | null; rockTex: string | null;
  walk: { n: number; res: number; h: string; before: string }; mapPng: string; report: unknown; outlines: [number, number][][]; overlay: OverlayLine[]; walls?: WallQuad[]; landmark?: MeshOut | null;
}): string {
  const mesh = (m: MeshOut | null) => (m ? { pos: b64(m.pos), nrm: b64(m.nrm), idx: b64(m.idx), cliff: b64(m.cliff), tint: b64(m.tint) } : null);
  const data = JSON.stringify({ area: d.area, sea: d.seaLevel, before: mesh(d.before), after: mesh(d.after), walk: d.walk, report: d.report, outlines: d.outlines, overlay: d.overlay, walls: d.walls ?? [], landmark: mesh(d.landmark ?? null), ground: d.groundTex, rock: d.rockTex });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Operator preview</title>
<style>
:root{--bg:#111316;--panel:#1b1e23;--text:#e6e8eb;--muted:#9aa1ab;--accent:#38c6e8}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#111316;--panel:#1b1e23;--text:#e6e8eb;--muted:#9aa1ab}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13px/1.4 system-ui,sans-serif;overflow:hidden}
#ui{position:absolute;top:12px;left:12px;right:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;pointer-events:none}
#ui>*{pointer-events:auto}
button{background:var(--panel);color:var(--text);border:1px solid #333a44;border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}
button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
#info{background:color-mix(in srgb,var(--panel) 85%,transparent);padding:6px 10px;border-radius:6px;color:var(--muted);max-width:min(560px,100%)}
#map{position:absolute;right:12px;bottom:12px;width:min(420px,45vw);border:1px solid #333a44;border-radius:6px;display:none}
#map.on{display:block}
</style>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
</head><body>
<div id="ui">
<button id="state" aria-pressed="true">Showing: AFTER</button>
<button id="mode">Walk mode (W A S D, drag to look)</button>
<button id="maptoggle">Map</button>
<span id="info">${d.title}. Orbit: drag / wheel. Red on the map = steeper than the ${WALK_SLOPE_DEG} degree walk limit.</span>
</div>
<img id="map" alt="Top-down height, slope and walkable map, before and after" src="${d.mapPng}">
<script type="module">
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
const D = ${data};
const dec = (s, T) => { const b = Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); return new T(b.buffer); };
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio)); renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9fb4c8); scene.fog = new THREE.Fog(0x9fb4c8, D.area.r * 2, D.area.r * 5);
const cam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.3, 5000);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.4); sun.position.set(D.area.x - D.area.r * 2.2, D.area.r * 1.1 + 120, D.area.z - D.area.r * 1.2);
sun.target.position.set(D.area.x, 0, D.area.z); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -D.area.r * 1.2, right: D.area.r * 1.2, top: D.area.r * 1.2, bottom: -D.area.r * 1.2, far: 1500 });
scene.add(sun, sun.target, new THREE.HemisphereLight(0xcfe3ff, 0x5b4f3a, 0.6));
const loader = new THREE.TextureLoader();
const tex = (uri, fallback) => { if (!uri) { const c = new THREE.DataTexture(new Uint8Array(fallback), 1, 1); c.needsUpdate = true; return c; }
  const t = loader.load(uri); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
const uniforms = { ground: { value: tex(D.ground, [90, 120, 60, 255]) }, rock: { value: tex(D.rock, [120, 118, 112, 255]) } };
function material() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms);
    s.vertexShader = s.vertexShader.replace("#include <common>", "#include <common>\\nattribute float cliff; varying float vCliff; varying vec3 vW; varying vec3 vN;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\\nvCliff = cliff; vW = (modelMatrix * vec4(position,1.)).xyz; vN = normal;");
    s.fragmentShader = s.fragmentShader.replace("#include <common>", "#include <common>\\nuniform sampler2D ground; uniform sampler2D rock; varying float vCliff; varying vec3 vW; varying vec3 vN;")
      .replace("#include <map_fragment>", \`
        vec3 bw = pow(abs(normalize(vN)), vec3(4.)); bw /= bw.x + bw.y + bw.z;
        vec3 g = texture2D(ground, vW.xz / 3.5).rgb;
        vec3 r = texture2D(rock, vW.zy / 11.).rgb * bw.x + texture2D(rock, vW.xz / 11.).rgb * bw.y + texture2D(rock, vW.xy / 11.).rgb * bw.z;
        diffuseColor.rgb *= mix(g, r, smoothstep(0.35, 0.65, vCliff));\`);
  };
  return m;
}
function build(M) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(dec(M.pos, Float32Array), 3));
  g.setAttribute("cliff", new THREE.BufferAttribute(new Float32Array(dec(M.cliff, Uint8Array)).map((v) => v / 255), 1));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(dec(M.tint, Uint8Array)).map((v) => Math.min(1.2, v / 127)), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(dec(M.nrm, Int8Array), 3, true));
  g.setIndex(new THREE.BufferAttribute(dec(M.idx, Uint32Array), 1));
  const mesh = new THREE.Mesh(g, material()); mesh.castShadow = mesh.receiveShadow = true; return mesh;
}
const meshes = { before: build(D.before), after: D.after ? build(D.after) : null };
let state = D.after ? "after" : "before";
scene.add(meshes.before); if (meshes.after) scene.add(meshes.after);
const sea = new THREE.Mesh(new THREE.PlaneGeometry(D.area.r * 6, D.area.r * 6), new THREE.MeshLambertMaterial({ color: 0x3b6e96, transparent: true, opacity: 0.7 }));
sea.rotation.x = -Math.PI / 2; sea.position.set(D.area.x, D.sea, D.area.z); scene.add(sea);
// operator outline, draped
const H = { after: dec(D.walk.h, Float32Array), before: dec(D.walk.before, Float32Array) };
const heightAt = (x, z) => { const n = D.walk.n, r = D.walk.res, h = H[state];
  const fx = (x - (D.area.x - D.area.r)) / r, fz = (z - (D.area.z - D.area.r)) / r;
  const i = Math.max(0, Math.min(n - 2, Math.floor(fx))), j = Math.max(0, Math.min(n - 2, Math.floor(fz))), u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fz - j));
  return (h[j*n+i]*(1-u)+h[j*n+i+1]*u)*(1-v)+(h[(j+1)*n+i]*(1-u)+h[(j+1)*n+i+1]*u)*v; };
for (const loop of D.outlines) { const pts = loop.concat([loop[0]]).map(([x, z]) => new THREE.Vector3(x, heightAt(x, z) + 0.6, z));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x38c6e8, depthTest: false }))); }
for (const l of D.overlay || []) { const pts = l.pts.map(([x, z]) => new THREE.Vector3(x, heightAt(x, z) + 0.9, z));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: (l.col[0] << 16) | (l.col[1] << 8) | l.col[2], depthTest: false }))); }
// kit walls (after only): one quad per module, foot to cap
const wallMesh = (() => { if (!(D.walls || []).length) return null; const p = [];
  for (const q of D.walls) { const [ax, az] = q.a, [bx, bz] = q.b; p.push(ax, q.y0, az, bx, q.y0, bz, bx, q.y1, bz, ax, q.y0, az, bx, q.y1, bz, ax, q.y1, az); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(p), 3)); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x8a8378, side: THREE.DoubleSide })); m.castShadow = m.receiveShadow = true; scene.add(m); return m; })();
const lmMesh = D.landmark ? build(D.landmark) : null; if (lmMesh) scene.add(lmMesh);
function show() { meshes.before.visible = state === "before"; if (meshes.after) meshes.after.visible = state === "after"; if (wallMesh) wallMesh.visible = state === "after"; if (lmMesh) lmMesh.visible = state === "after";
  const b = document.getElementById("state"); b.textContent = "Showing: " + state.toUpperCase(); b.setAttribute("aria-pressed", String(state === "after")); }
show();
document.getElementById("state").onclick = () => { if (meshes.after) { state = state === "after" ? "before" : "after"; show(); } };
document.getElementById("maptoggle").onclick = () => document.getElementById("map").classList.toggle("on");
const orbit = new OrbitControls(cam, renderer.domElement);
orbit.target.set(D.area.x, heightAt(D.area.x, D.area.z), D.area.z);
cam.position.set(D.area.x + D.area.r * 0.9, orbit.target.y + D.area.r * 0.8, D.area.z + D.area.r * 1.1); orbit.update();
// a stated camera for headless evidence: #cam=x,y,z,tx,ty,tz (and #cam=...;before to show the untouched ground)
const view = (p, t) => { cam.position.set(p[0], p[1], p[2]); orbit.target.set(t[0], t[1], t[2]); orbit.update(); };
window.__opView = view;
if (location.hash.startsWith("#cam=")) { const [v, s] = location.hash.slice(5).split(";"); const n = v.split(",").map(Number);
  if (n.length === 6 && n.every(Number.isFinite)) view(n.slice(0, 3), n.slice(3)); if (s === "before") { state = "before"; show(); } }
let walk = false, yaw = 0, pitch = 0; const keys = {}; const me = new THREE.Vector3();
document.getElementById("mode").onclick = () => { walk = !walk; orbit.enabled = !walk;
  document.getElementById("mode").setAttribute("aria-pressed", String(walk));
  if (walk) { me.set(D.area.x, 0, D.area.z); yaw = Math.atan2(cam.position.x - D.area.x, cam.position.z - D.area.z); pitch = -0.1; } };
addEventListener("keydown", (e) => keys[e.code] = true); addEventListener("keyup", (e) => keys[e.code] = false);
let drag = null; renderer.domElement.addEventListener("pointerdown", (e) => drag = [e.clientX, e.clientY]);
addEventListener("pointerup", () => drag = null);
addEventListener("pointermove", (e) => { if (!walk || !drag) return; yaw -= (e.clientX - drag[0]) * 0.005; pitch = Math.max(-1.3, Math.min(1.3, pitch - (e.clientY - drag[1]) * 0.005)); drag = [e.clientX, e.clientY]; });
addEventListener("resize", () => { cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => { const dt = Math.min(0.05, clock.getDelta());
  if (walk) { const sp = (keys.ShiftLeft ? 14 : 5) * dt, f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    me.x += (-Math.sin(yaw) * f + Math.cos(yaw) * s) * sp; me.z += (-Math.cos(yaw) * f - Math.sin(yaw) * s) * sp;
    me.y = heightAt(me.x, me.z) + 1.7; cam.position.copy(me);
    cam.lookAt(me.x - Math.sin(yaw) * Math.cos(pitch), me.y + Math.sin(pitch), me.z - Math.cos(yaw) * Math.cos(pitch)); }
  else orbit.update();
  renderer.render(scene, cam); });
</script></body></html>
`;
}
