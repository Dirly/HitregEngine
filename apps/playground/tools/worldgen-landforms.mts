/**
 * worldgen landforms — landform classes painted as a flat-colour KEY by an
 * image generator, turned into ordinary recipe features BEFORE rivers.
 *
 *   landforms base    <world>  relief base map (+ .json pixel mapping) and the legend
 *   landforms request <world>  prompt from landforms-prompt.md + legend -> image-request.mjs gen
 *   landforms apply   <world> --key <png>  classify -> components -> features (ids `landform-*`)
 *   landforms check   <world>  gate: land/sea, size, overlap, coverage, buried rivers; preview PNG
 *
 * Why a categorical key and not a heightmap: generators are good at LAYOUT and
 * bad at MEASUREMENT. Greyscale heightmaps came back with ~6 m rim lips and
 * grain bumps. Here a colour only says "a mesa goes here"; every metre is
 * computed from the class parameters, seeded per component, against the
 * terrain the field actually has. Image brightness never becomes a height.
 *
 * Classes map onto EXISTING feature kinds (no new core kinds):
 *   mesa, plateau          fills (absolute flat top, raise-only, applied BEFORE water so later stages carve through)
 *   ridge-spur             ridges (tagged `landform`, `landform:<class>`)
 *   gorge, crater pit, sinkholes  canyons (floorY absolute, descending)
 *   crater rim             ridges (a closed ring)
 *   sea-stack field, rock arch    blobs (add)
 *
 * Artifacts live in <project>/authoring/landforms/<world>/: base.png,
 * base.json, legend.json, key.png (request), ledger.json (apply), preview.png (check).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWorldField, mulberry32, smoothstep, type WorldField, type WorldRecipe, type CanyonDoc, type RidgeDoc, type BlobDoc, type FillDoc } from "@hitreg/core";
import { decodePng, encodePng } from "./_png.mjs";

type HeightPatchDoc = WorldRecipe["features"]["heightPatches"][number];
type RGB = [number, number, number];

export interface LandformsHost {
  argv: string[];
  findRecipeFile(name: string): string | null;
  loadRecipe(name: string): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
}

const PLAYGROUND = path.resolve(import.meta.dirname, "..");
const PREFIX = "landform-";

// ---------------------------------------------------------------- the legend

type FeatureKind = "fill" | "ridge" | "canyon" | "ridge+canyon" | "blob";
interface LandformClass {
  id: string;
  name: string;
  hex: string;
  /** what the generator is told the colour means */
  draw: string;
  where: "land" | "sea";
  kind: FeatureKind;
  /** footprint limits, m² (component area as classified) */
  minArea: number;
  maxArea: number;
  /** linear classes: limits on the length along the major axis, m */
  minLength?: number;
  maxLength?: number;
  /** raises ground, cuts ground, or adds rock in 3D */
  effect: "raise" | "cut" | "rock";
  params: string;
}

export const LANDFORM_CLASSES: readonly LandformClass[] = [
  { id: "mesa", name: "Mesa", hex: "#FF0000", draw: "a compact rounded blob: a steep-sided flat-topped table mountain", where: "land", kind: "fill", minArea: 15_000, maxArea: 700_000, effect: "raise", params: "flat top = q90 ground + 35..70 m; bank 10..18 m" },
  { id: "plateau", name: "Plateau", hex: "#FF8000", draw: "a large irregular blob: a broad raised tableland", where: "land", kind: "fill", minArea: 120_000, maxArea: 5_000_000, effect: "raise", params: "flat top = q85 ground + 14..28 m; bank 50..90 m" },
  { id: "ridge-spur", name: "Ridge spur", hex: "#FFFF00", draw: "a long thin stroke: a rocky spur ridge", where: "land", kind: "ridge", minArea: 4_000, maxArea: 900_000, minLength: 250, maxLength: 3_500, effect: "raise", params: "crest 30..60 m tapered to 35% at the ends; width 12..40; falloff 30..120" },
  { id: "gorge", name: "Gorge", hex: "#00FFFF", draw: "a long thin stroke: a narrow terraced gorge", where: "land", kind: "canyon", minArea: 4_000, maxArea: 900_000, minLength: 250, maxLength: 4_000, effect: "cut", params: "floor 18..34 wide, 25..45 deep, descending from the high end, never below sea + 1.5; 2..4 steps" },
  { id: "crater", name: "Crater", hex: "#FF00FF", draw: "a round disc: an impact crater with a raised rim", where: "land", kind: "ridge+canyon", minArea: 6_000, maxArea: 900_000, effect: "cut", params: "pit floor 0.3r, 18..35 deep, rim cut to 0.85r; ring ridge at 0.95r 8..18 m high" },
  { id: "sinkhole-field", name: "Sinkhole field", hex: "#8000FF", draw: "a blob covering an area pocked with sinkholes", where: "land", kind: "canyon", minArea: 8_000, maxArea: 1_500_000, effect: "cut", params: "2..14 pits (area/12000), 8..20 wide, 10..22 deep, spaced >= 2.5 widths" },
  { id: "sea-stack-field", name: "Sea-stack field", hex: "#00FF00", draw: "a blob in shallow sea next to a coast: a cluster of rock pillars standing out of the water", where: "sea", kind: "blob", minArea: 5_000, maxArea: 1_500_000, effect: "rock", params: "2..12 tapered capsules on seabed 1..30 m deep, 12..40 m above water, r 5..11" },
  { id: "rock-arch", name: "Rock arch", hex: "#0000FF", draw: "a small dot: a natural stone arch", where: "land", kind: "blob", minArea: 300, maxArea: 80_000, effect: "rock", params: "two legs 22..40 apart, 14..26 tall, r 4..6.5; sphere lintel rising 15% of span" },
];

function hexRgb(hex: string): RGB {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const CLASS_RGB = LANDFORM_CLASSES.map((c) => hexRgb(c.hex));

// ---------------------------------------------------------------- small utils

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Smooth value noise in [-1, 1], for wobbling outlines off the pixel grid. */
function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const h = (a: number, b: number): number => {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 2246822519);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = h(xi, zi) + (h(xi + 1, zi) - h(xi, zi)) * sx;
  const b = h(xi, zi + 1) + (h(xi + 1, zi + 1) - h(xi, zi + 1)) * sx;
  return (a + (b - a) * sz) * 2 - 1;
}

function opt(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}
function num(argv: string[], name: string, fallback: number): number {
  const v = opt(argv, name);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------- files

interface BaseMapping {
  world: string;
  size: number;
  /** world X/Z of the image's top-left EDGE; pixel (px,py) centre = origin + (p + 0.5) * metresPerPixel */
  originX: number;
  originZ: number;
  metresPerPixel: number;
  cx: number;
  cz: number;
  extent: number;
  seaLevel: number;
  northUp: "-Z";
  continentsStamp: string | null;
  createdAt: string;
}

function artifactDir(recipeFile: string, world: string): string {
  // <project>/assets/worlds/<world>.json -> <project>/authoring/landforms/<world>/
  return path.resolve(path.dirname(recipeFile), "..", "..", "authoring", "landforms", world);
}

function strippedField(recipe: WorldRecipe): WorldField {
  // The ground the landforms stand on: earlier stages only. Water and the
  // things that come after it (towns, roads) are re-solved around the result,
  // and this stage's own previous output is never measured.
  const f = recipe.features;
  const own = <T extends { id: string }>(list: readonly T[]): T[] => list.filter((x) => !x.id.startsWith(PREFIX));
  return createWorldField({
    ...recipe,
    features: {
      ...f,
      ridges: own(f.ridges),
      canyons: own(f.canyons),
      blobs: own(f.blobs),
      heightPatches: own(f.heightPatches),
      rivers: [],
      lakes: [],
      fills: [],
      towns: [],
      roads: [],
      bridges: [],
    },
  });
}

/** Square window fitted to the landmasses (continent + lobes + coast band), or --cx/--cz/--extent. */
function fitWindow(recipe: WorldRecipe, argv: string[]): { cx: number; cz: number; extent: number } {
  if (opt(argv, "extent") !== null) return { cx: num(argv, "cx", 0), cz: num(argv, "cz", 0), extent: num(argv, "extent", 3000) };
  const continents = recipe.bounds?.continents ?? [];
  if (continents.length === 0) return { cx: 0, cz: 0, extent: 3000 };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const c of continents) {
    const discs: [number, number, number][] = [[c.center[0], c.center[1], c.radius], ...c.lobes.map((l): [number, number, number] => [c.center[0] + l[0], c.center[1] + l[1], l[2]])];
    for (const [x, z, r] of discs) {
      const reach = r + c.falloff * 0.8;
      x0 = Math.min(x0, x - reach); x1 = Math.max(x1, x + reach);
      z0 = Math.min(z0, z - reach); z1 = Math.max(z1, z + reach);
    }
  }
  const cx = Math.round((x0 + x1) / 2);
  const cz = Math.round((z0 + z1) / 2);
  let extent = Math.ceil((Math.max(x1 - x0, z1 - z0) / 2) * 1.06 / 50) * 50;
  const limit = recipe.bounds?.limit;
  if (limit) extent = Math.min(extent, Math.ceil((limit + 200) / 50) * 50);
  return { cx, cz, extent };
}

// ---------------------------------------------------------------- base

function renderBase(recipe: WorldRecipe, field: WorldField, m: BaseMapping): { rgba: Uint8Array; land: Uint8Array; heights: Float32Array } {
  const n = m.size;
  const heights = new Float32Array(n * n);
  const land = new Uint8Array(n * n);
  const limit = field.worldLimit;
  let maxH = recipe.seaLevel + 1;
  for (let py = 0; py < n; py++) {
    const z = m.originZ + (py + 0.5) * m.metresPerPixel;
    for (let px = 0; px < n; px++) {
      const x = m.originX + (px + 0.5) * m.metresPerPixel;
      const beyond = limit !== Infinity && x * x + z * z > limit * limit;
      const h = beyond ? (recipe.bounds?.oceanFloor ?? recipe.seaLevel - 40) : field.height(x, z);
      heights[px + py * n] = h;
      if (h > recipe.seaLevel) {
        land[px + py * n] = 1;
        if (h > maxH) maxH = h;
      }
    }
  }
  // Desaturated relief on purpose: every legend colour is fully saturated, so
  // nothing the generator copies from the base can ever snap to a class.
  const rgba = new Uint8Array(n * n * 4);
  const mpp = m.metresPerPixel;
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const i = px + py * n;
      const o = i * 4;
      const h = heights[i]!;
      if (!land[i]) {
        const depth = clamp((recipe.seaLevel - h) / 40, 0, 1);
        rgba[o] = Math.round(46 - depth * 18);
        rgba[o + 1] = Math.round(56 - depth * 20);
        rgba[o + 2] = Math.round(74 - depth * 22);
      } else {
        const hx = heights[Math.min(n - 1, px + 1) + py * n]! - heights[Math.max(0, px - 1) + py * n]!;
        const hz = heights[px + Math.min(n - 1, py + 1) * n]! - heights[px + Math.max(0, py - 1) * n]!;
        // light from the north-west (-X, -Z), the cartographic convention
        const nx = -hx / (2 * mpp);
        const nz = -hz / (2 * mpp);
        const lambert = (nx * -0.6 + nz * -0.6 + 0.53) / Math.sqrt(nx * nx + nz * nz + 1);
        const elev = clamp((h - recipe.seaLevel) / (maxH - recipe.seaLevel), 0, 1);
        const g = clamp(95 + elev * 90 + lambert * 90, 60, 245);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = Math.round(g);
      }
      rgba[o + 3] = 255;
    }
  }
  return { rgba, land, heights };
}

function legendDoc(m: BaseMapping): object {
  return {
    note: "Flat-colour landform key. Paint each class as a solid blob in EXACTLY its colour; transparent or #000000 = nothing.",
    metresPerPixel: m.metresPerPixel,
    classes: LANDFORM_CLASSES.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.hex,
      draw: c.draw,
      where: c.where,
      feature: c.kind,
      pixelsAcross: pixelSpan(c, m.metresPerPixel, m.size),
      params: c.params,
    })),
  };
}

/** Thinnest shape that survives apply: the open (radius 1) on a grid of half the key's resolution needs 3 cells = 6 px; ask for twice that. */
function strokePx(size: number): number {
  return Math.max(12, Math.round(size / 64));
}

function pixelSpan(c: LandformClass, mpp: number, size = 1024): string {
  const floor = strokePx(size);
  if (c.minLength) return `${Math.max(floor * 3, Math.round(c.minLength / mpp))}-${Math.round(c.maxLength! / mpp)} px long`;
  const d = (a: number): number => Math.max(floor, Math.round((2 * Math.sqrt(a / Math.PI)) / mpp));
  return `${d(c.minArea)}-${d(c.maxArea)} px across`;
}

function commandBase(host: LandformsHost, world: string): void {
  const { recipe, file } = host.loadRecipe(world);
  const argv = host.argv;
  const size = Math.round(num(argv, "size", 1024));
  const win = fitWindow(recipe, argv);
  const mpp = (win.extent * 2) / size;
  const m: BaseMapping = {
    world,
    size,
    originX: win.cx - win.extent,
    originZ: win.cz - win.extent,
    metresPerPixel: mpp,
    cx: win.cx,
    cz: win.cz,
    extent: win.extent,
    seaLevel: recipe.seaLevel,
    northUp: "-Z",
    continentsStamp: recipe.pipeline["continents"] ?? null,
    createdAt: new Date().toISOString(),
  };
  const t0 = Date.now();
  const { rgba, land } = renderBase(recipe, strippedField(recipe), m);
  const dir = artifactDir(file, world);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "base.png"), encodePng(size, size, rgba));
  fs.writeFileSync(path.join(dir, "base.json"), `${JSON.stringify(m, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "legend.json"), `${JSON.stringify(legendDoc(m), null, 2)}\n`);
  let landPx = 0;
  for (const v of land) landPx += v;
  console.log(`wrote ${path.relative(process.cwd(), dir)}/{base.png,base.json,legend.json}`);
  console.log(`  ${size}x${size} px, ${(mpp).toFixed(2)} m/px, window centre [${win.cx}, ${win.cz}] ±${win.extent} m, land ${((100 * landPx) / (size * size)).toFixed(1)}% (${((landPx * mpp * mpp) / 1e6).toFixed(2)} km²), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

// ---------------------------------------------------------------- request

function commandRequest(host: LandformsHost, world: string): void {
  const { file } = host.loadRecipe(world);
  const argv = host.argv;
  const dir = artifactDir(file, world);
  const basePath = path.join(dir, "base.png");
  if (!fs.existsSync(basePath)) host.fail(`no base map — run: worldgen landforms base ${world}`);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "base.json"), "utf8")) as BaseMapping;
  const templatePath = path.join(import.meta.dirname, "landforms-prompt.md");
  const template = fs.readFileSync(templatePath, "utf8");
  const legend = LANDFORM_CLASSES.map((c) => `- ${c.hex} = ${c.name.toUpperCase()}: ${c.draw}. ${c.where === "sea" ? "In the SEA (dark blue-grey), touching or near a coast." : "On LAND (grey) only."} ${pixelSpan(c, m.metresPerPixel, m.size)}.`).join("\n");
  const brief = opt(argv, "brief") ?? "Make the terrain more interesting and varied: a few landmarks that give each part of the land a character, spread out, not clustered, nothing touching the edge of the image.";
  const prompt = template
    .replaceAll("{{SIZE}}", String(m.size))
    .replaceAll("{{STROKE}}", String(strokePx(m.size)))
    .replaceAll("{{METRES}}", String(Math.round(m.extent * 2)))
    .replaceAll("{{MPP}}", m.metresPerPixel.toFixed(1))
    .replaceAll("{{LEGEND}}", legend)
    .replaceAll("{{COVERAGE}}", String(Math.round(num(argv, "coverage", 0.15) * 100)))
    .replaceAll("{{BRIEF}}", brief);
  // prompts never live in a project folder (docs/image-generation.md)
  const promptFile = path.join(os.tmpdir(), `landforms-${world}-${process.pid}.txt`);
  fs.writeFileSync(promptFile, prompt);
  const target = path.join(dir, opt(argv, "out") ?? "key.png");
  const args = [
    path.join(PLAYGROUND, "tools", "image-request.mjs"), "gen",
    "--id", `landforms-${world}`,
    "--target", target,
    "--size", `${m.size}x${m.size}`,
    "--purpose", `landform key map for world ${world} (worldgen landforms)`,
    "--prompt-file", promptFile,
    "--ref", basePath,
    "--timeout", String(Math.round(num(argv, "timeout", 900))),
    "--force",
  ];
  if (argv.includes("--dry")) {
    console.log(prompt);
    console.log(`\n(dry) node ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
    return;
  }
  console.log(`requesting key -> ${path.relative(process.cwd(), target)} (prompt from ${path.basename(templatePath)}; this blocks until the image exists)`);
  const t0 = Date.now();
  const run = spawnSync(process.execPath, args, { cwd: PLAYGROUND, stdio: "inherit" });
  fs.rmSync(promptFile, { force: true });
  console.log(`image-request exited ${run.status} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (run.status === 4) host.fail("the Codex CLI is not on PATH — queue it with `image-request.mjs new` or paint the key by hand from legend.json");
  if (run.status !== 0) process.exit(run.status ?? 1);
  console.log(`next: worldgen landforms apply ${world} --key ${path.relative(PLAYGROUND, target)}`);
}

// ---------------------------------------------------------------- classify

interface Grid {
  n: number;
  /** -1 nothing, else class index */
  label: Int8Array;
  cell: number;
  m: BaseMapping;
}
interface Component {
  cls: number;
  cells: number[];
  area: number;
  cx: number;
  cz: number;
  /** principal axis (unit), extents along it and across it */
  ux: number;
  uz: number;
  length: number;
  width: number;
  /** max distance of any cell centre from the centroid */
  reach: number;
}

interface ClassifyOptions {
  tolerance: number;
  grid: number;
  open: number;
  minPx: number;
}

function classify(keyPath: string, m: BaseMapping, o: ClassifyOptions): { grid: Grid; components: Component[]; stats: string[] } {
  const png = decodePng(fs.readFileSync(keyPath)) as { width: number; height: number; data: Uint8Array };
  const stats: string[] = [];
  const { width: W, height: H, data } = png;
  if (Math.abs(W / H - 1) > 0.02) stats.push(`key is ${W}x${H}, not square: stretched onto the square base window`);
  // 1. snap every source pixel to the nearest legend colour within tolerance
  const snapped = new Int8Array(W * H).fill(-1);
  const tol2 = o.tolerance * o.tolerance;
  const perClass = new Array<number>(LANDFORM_CLASSES.length).fill(0);
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3]!;
    if (a < 128) continue;
    const r = data[i * 4]!, g = data[i * 4 + 1]!, b = data[i * 4 + 2]!;
    let best = -1;
    let bestD = tol2;
    for (let k = 0; k < CLASS_RGB.length; k++) {
      const c = CLASS_RGB[k]!;
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d <= bestD) { bestD = d; best = k; }
    }
    snapped[i] = best;
    if (best >= 0) perClass[best]!++;
  }
  stats.push(`snapped ${W}x${H} key: ${LANDFORM_CLASSES.map((c, k) => (perClass[k] ? `${c.id} ${perClass[k]}` : "")).filter(Boolean).join(", ") || "no legend pixels"}`);
  // 2. resample to the label grid by plurality vote (nothing is a candidate too)
  const n = o.grid;
  const label = new Int8Array(n * n).fill(-1);
  const votes = new Int32Array(LANDFORM_CLASSES.length + 1);
  for (let gy = 0; gy < n; gy++) {
    const y0 = Math.floor((gy * H) / n), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * H) / n));
    for (let gx = 0; gx < n; gx++) {
      const x0 = Math.floor((gx * W) / n), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * W) / n));
      votes.fill(0);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) votes[snapped[x + y * W]! + 1]!++;
      let best = 0;
      for (let k = 1; k < votes.length; k++) if (votes[k]! > votes[best]!) best = k;
      label[gx + gy * n] = best - 1;
    }
  }
  // 3. morphological open per class: strips anti-aliased fringes and stray specks
  const r = o.open;
  if (r > 0) {
    const eroded = new Int8Array(n * n).fill(-1);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const c = label[x + y * n]!;
      if (c < 0) continue;
      let keep = true;
      for (let dy = -r; dy <= r && keep; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n || label[xx + yy * n] !== c) { keep = false; break; }
      }
      if (keep) eroded[x + y * n] = c;
    }
    const opened = new Int8Array(n * n).fill(-1);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const c = eroded[x + y * n]!;
      if (c < 0) continue;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        // dilate back only over the class's own original pixels (no growth)
        if (xx >= 0 && yy >= 0 && xx < n && yy < n && label[xx + yy * n] === c) opened[xx + yy * n] = c;
      }
    }
    label.set(opened);
  }
  // 4. connected components (8-connected), tiny ones dropped
  const cell = (m.extent * 2) / n;
  const seen = new Uint8Array(n * n);
  const components: Component[] = [];
  let dropped = 0;
  const stack: number[] = [];
  for (let start = 0; start < n * n; start++) {
    const cls = label[start]!;
    if (cls < 0 || seen[start]) continue;
    const cells: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % n, y = (i / n) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const j = xx + yy * n;
        if (!seen[j] && label[j] === cls) { seen[j] = 1; stack.push(j); }
      }
    }
    if (cells.length < o.minPx) {
      dropped++;
      for (const i of cells) label[i] = -1;
      continue;
    }
    components.push(describe(cls, cells, n, cell, m));
  }
  if (dropped) stats.push(`dropped ${dropped} component(s) under ${o.minPx} cells`);
  // deterministic order: class, then position
  components.sort((a, b) => a.cls - b.cls || a.cz - b.cz || a.cx - b.cx);
  return { grid: { n, label, cell, m }, components, stats };
}

function cellXZ(i: number, n: number, cell: number, m: BaseMapping): [number, number] {
  return [m.originX + ((i % n) + 0.5) * cell, m.originZ + (((i / n) | 0) + 0.5) * cell];
}

function describe(cls: number, cells: number[], n: number, cell: number, m: BaseMapping): Component {
  let sx = 0, sz = 0;
  for (const i of cells) { const [x, z] = cellXZ(i, n, cell, m); sx += x; sz += z; }
  const cx = sx / cells.length, cz = sz / cells.length;
  let cxx = 0, czz = 0, cxz = 0;
  for (const i of cells) { const [x, z] = cellXZ(i, n, cell, m); cxx += (x - cx) ** 2; czz += (z - cz) ** 2; cxz += (x - cx) * (z - cz); }
  const angle = 0.5 * Math.atan2(2 * cxz, cxx - czz);
  const ux = Math.cos(angle), uz = Math.sin(angle);
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity, reach = 0;
  for (const i of cells) {
    const [x, z] = cellXZ(i, n, cell, m);
    const s = (x - cx) * ux + (z - cz) * uz;
    const t = -(x - cx) * uz + (z - cz) * ux;
    s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    reach = Math.max(reach, Math.hypot(x - cx, z - cz));
  }
  const area = cells.length * cell * cell;
  const length = s1 - s0 + cell;
  return { cls, cells, area, cx, cz, ux, uz, length, width: area / length, reach: reach + cell / 2 };
}

/** Centre-line of an elongated component: centroids of slices along its major axis, smoothed once. */
function medialLine(c: Component, g: Grid): [number, number][] {
  const bins = clamp(Math.round(c.length / 70), 2, 14);
  const sum = Array.from({ length: bins }, () => [0, 0, 0]);
  const half = c.length / 2;
  for (const i of c.cells) {
    const [x, z] = cellXZ(i, g.n, g.cell, g.m);
    const s = (x - c.cx) * c.ux + (z - c.cz) * c.uz;
    const b = clamp(Math.floor(((s + half) / c.length) * bins), 0, bins - 1);
    sum[b]![0]! += x; sum[b]![1]! += z; sum[b]![2]! += 1;
  }
  const pts = sum.filter((s) => s[2]! > 0).map((s): [number, number] => [s[0]! / s[2]!, s[1]! / s[2]!]);
  if (pts.length < 2) return [[c.cx - c.ux * half * 0.5, c.cz - c.uz * half * 0.5], [c.cx + c.ux * half * 0.5, c.cz + c.uz * half * 0.5]];
  const out = pts.map((p, k): [number, number] => {
    if (k === 0 || k === pts.length - 1) return p;
    const a = pts[k - 1]!, b = pts[k + 1]!;
    return [0.25 * a[0] + 0.5 * p[0] + 0.25 * b[0], 0.25 * a[1] + 0.5 * p[1] + 0.25 * b[1]];
  });
  return out.map(([x, z]) => [r1(x), r1(z)]);
}

// ---------------------------------------------------------------- features

interface Built {
  ridges: RidgeDoc[];
  canyons: CanyonDoc[];
  blobs: BlobDoc[];
  fills: FillDoc[];
  notes: string[];
}

/** Signed distance (m, + outside) to a component's outline, on a local window of the label grid. */
function componentSdf(c: Component, g: Grid, padM: number): { sample: (x: number, z: number) => number } {
  const { n, cell, m } = g;
  const mine = new Set(c.cells);
  let gx0 = n, gx1 = 0, gy0 = n, gy1 = 0;
  for (const i of c.cells) { const x = i % n, y = (i / n) | 0; gx0 = Math.min(gx0, x); gx1 = Math.max(gx1, x); gy0 = Math.min(gy0, y); gy1 = Math.max(gy1, y); }
  const pad = Math.ceil(padM / cell) + 2;
  gx0 -= pad; gy0 -= pad; gx1 += pad; gy1 += pad;
  const w = gx1 - gx0 + 1, h = gy1 - gy0 + 1;
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x + gx0, Y = y + gy0;
    if (X >= 0 && Y >= 0 && X < n && Y < n && mine.has(X + Y * n)) inside[x + y * w] = 1;
  }
  // two-pass chamfer (1, √2) distance to the other side, for both sides
  const chamfer = (target: number): Float32Array => {
    const d = new Float32Array(w * h).fill(1e9);
    for (let i = 0; i < w * h; i++) if (inside[i] !== target) d[i] = 0;
    const S = Math.SQRT2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = x + y * w;
      if (x > 0) d[i] = Math.min(d[i]!, d[i - 1]! + 1);
      if (y > 0) d[i] = Math.min(d[i]!, d[i - w]! + 1);
      if (x > 0 && y > 0) d[i] = Math.min(d[i]!, d[i - w - 1]! + S);
      if (x < w - 1 && y > 0) d[i] = Math.min(d[i]!, d[i - w + 1]! + S);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = x + y * w;
      if (x < w - 1) d[i] = Math.min(d[i]!, d[i + 1]! + 1);
      if (y < h - 1) d[i] = Math.min(d[i]!, d[i + w]! + 1);
      if (x < w - 1 && y < h - 1) d[i] = Math.min(d[i]!, d[i + w + 1]! + S);
      if (x > 0 && y < h - 1) d[i] = Math.min(d[i]!, d[i + w - 1]! + S);
    }
    return d;
  };
  const dOut = chamfer(0); // for outside cells: distance to the nearest inside cell
  const dIn = chamfer(1);
  const sd = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) sd[i] = inside[i] ? -(dIn[i]! - 0.5) * cell : (dOut[i]! - 0.5) * cell;
  return {
    sample(x: number, z: number): number {
      const u = (x - m.originX) / cell - 0.5 - gx0;
      const v = (z - m.originZ) / cell - 0.5 - gy0;
      const i = clamp(Math.floor(u), 0, w - 2), j = clamp(Math.floor(v), 0, h - 2);
      const fx = clamp(u - i, 0, 1), fz = clamp(v - j, 0, 1);
      const a = sd[i + j * w]! + (sd[i + 1 + j * w]! - sd[i + j * w]!) * fx;
      const b = sd[i + (j + 1) * w]! + (sd[i + 1 + (j + 1) * w]! - sd[i + (j + 1) * w]!) * fx;
      return a + (b - a) * fz;
    },
  };
}

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[clamp(Math.floor(q * (s.length - 1)), 0, s.length - 1)]!;
}

/**
 * Mesa / plateau as a FILL: raise-only to an absolute flat top inside the
 * outline, easing out over `bank`. Fills apply BEFORE water in the field, so
 * rivers, canyons, town pads and roads solved later still carve through them
 * (a heightPatch applies after every feature and overwrote all of those).
 */
function tableFill(id: string, c: Component, g: Grid, field: WorldField, rand: () => number, kind: "mesa" | "plateau", seed: number): { fill: FillDoc; note: string } {
  const ground = c.cells.map((i) => { const [x, z] = cellXZ(i, g.n, g.cell, g.m); return field.height(x, z); });
  const mesa = kind === "mesa";
  const rise = mesa ? lerp(35, 70, rand()) : lerp(14, 28, rand());
  const top = r1(quantile(ground, mesa ? 0.9 : 0.85) + rise);
  const bank = mesa ? lerp(10, 18, rand()) : lerp(50, 90, rand());
  const wobble = Math.min(g.cell * 0.6, mesa ? 8 : 20); // hides the label-grid stairs
  const sdf = componentSdf(c, g, g.cell * 2);
  // outline: the outermost inside point along rays from the centroid (mesas and plateaus are blobs)
  const rays = clamp(Math.round((2 * Math.PI * c.reach) / Math.max(6, g.cell)), 24, 96);
  const step = g.cell / 3;
  const polygon: [number, number][] = [];
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    let edge = step;
    for (let r = 0; r <= c.reach + g.cell; r += step) if (sdf.sample(c.cx + dx * r, c.cz + dz * r) <= 0) edge = r;
    edge = Math.max(step, edge + wobble * valueNoise(Math.cos(a) * 3, Math.sin(a) * 3, seed));
    polygon.push([r1(c.cx + dx * edge), r1(c.cz + dz * edge)]);
  }
  return {
    fill: { id, polygon, y: top, bank: r1(bank), tags: ["landform", `landform:${kind}`] },
    note: `top ${top} m (+${r1(rise)} over q${mesa ? 90 : 85} ground), bank ${r1(bank)} m, ${rays}-point outline`,
  };
}
function buildFeatures(recipe: WorldRecipe, comps: Component[], g: Grid, field: WorldField): Built {
  const out: Built = { ridges: [], canyons: [], blobs: [], fills: [], notes: [] };
  const counters = new Map<string, number>();
  const sea = recipe.seaLevel;
  for (const c of comps) {
    const cls = LANDFORM_CLASSES[c.cls]!;
    const k = (counters.get(cls.id) ?? 0) + 1;
    counters.set(cls.id, k);
    const base = `${PREFIX}${cls.id}-${k}`;
    // seeded per component: world seed + class + where it is (not its index),
    // so adding a landform elsewhere does not reshuffle this one
    const seed = hash32(`${recipe.seed}:${cls.id}:${Math.round(c.cx / 10)}:${Math.round(c.cz / 10)}`);
    const rand = mulberry32(seed);
    const tags = ["landform", `landform:${cls.id}`];
    const inside = (): [number, number] => {
      const i = c.cells[Math.floor(rand() * c.cells.length)]!;
      const [x, z] = cellXZ(i, g.n, g.cell, g.m);
      return [x + (rand() - 0.5) * g.cell, z + (rand() - 0.5) * g.cell];
    };
    let note = "";
    switch (cls.id) {
      case "mesa":
      case "plateau": {
        const built = tableFill(base, c, g, field, rand, cls.id, seed);
        out.fills.push(built.fill);
        note = built.note;
        break;
      }
      case "ridge-spur": {
        const points = medialLine(c, g);
        const crest = lerp(30, 60, rand());
        const heights = points.map((_, i) => r1(crest * (0.35 + 0.65 * Math.sin((Math.PI * (i + 0.5)) / points.length))));
        const width = r1(clamp(c.width * 0.35, 12, 40));
        const falloff = r1(clamp(c.width * 0.6, 30, 120));
        out.ridges.push({ id: base, points, height: r1(crest), heights, width, falloff, tags });
        note = `${points.length} pts, crest ${r1(crest)} m, width ${width}, falloff ${falloff}`;
        break;
      }
      case "gorge": {
        let points = medialLine(c, g);
        const groundAt = (p: [number, number]): number => field.height(p[0], p[1]);
        if (groundAt(points[0]!) < groundAt(points[points.length - 1]!)) points = points.reverse();
        // densify so floorY follows the ground between the slice centroids
        const dense: [number, number][] = [];
        for (let i = 0; i + 1 < points.length; i++) {
          const a = points[i]!, b = points[i + 1]!;
          const steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 40));
          for (let s = 0; s < steps; s++) dense.push([r1(a[0] + ((b[0] - a[0]) * s) / steps), r1(a[1] + ((b[1] - a[1]) * s) / steps)]);
        }
        dense.push(points[points.length - 1]!);
        const width = r1(clamp(lerp(18, 34, rand()), 10, Math.max(10, c.width * 0.6)));
        const depth = lerp(25, 45, rand());
        let running = Infinity;
        const floorY = dense.map((p) => {
          running = Math.min(running, groundAt(p) - depth);
          return r1(Math.max(running, sea + 1.5));
        });
        out.canyons.push({ id: base, points: dense, width, depth: r1(depth), rim: r1(width * lerp(0.7, 1.1, rand())), steps: 2 + Math.floor(rand() * 3), stepSharpness: r2(lerp(0.66, 0.9, rand())), floorY });
        note = `${dense.length} pts, floor ${width} wide, ${r1(depth)} deep, ${floorY[0]} -> ${floorY[floorY.length - 1]} m`;
        break;
      }
      case "crater": {
        const r = Math.sqrt(c.area / Math.PI);
        let minG = Infinity;
        for (let a = 0; a < 16; a++) for (const f of [0, 0.4, 0.8]) minG = Math.min(minG, field.height(c.cx + Math.cos((a * Math.PI) / 8) * r * f, c.cz + Math.sin((a * Math.PI) / 8) * r * f));
        const depth = lerp(18, 35, rand());
        const floor = r1(Math.max(minG - depth, sea + 1.5));
        const hw = 0.3 * r;
        out.canyons.push({ id: `${base}-pit`, points: [[r1(c.cx - 0.5), r1(c.cz)], [r1(c.cx + 0.5), r1(c.cz)]], width: r1(hw * 2), depth: r1(depth), rim: r1(0.55 * r), steps: 2, stepSharpness: r2(lerp(0.55, 0.8, rand())), floorY: [floor, floor] });
        const ring: [number, number][] = [];
        const segs = clamp(Math.round((2 * Math.PI * r) / 30), 12, 48);
        const phase = rand() * Math.PI * 2;
        for (let s = 0; s < segs; s++) {
          const a = phase + (s / segs) * Math.PI * 2;
          const rr = r * (0.95 + 0.05 * valueNoise(Math.cos(a) * 2, Math.sin(a) * 2, seed));
          ring.push([r1(c.cx + Math.cos(a) * rr), r1(c.cz + Math.sin(a) * rr)]);
        }
        ring.push(ring[0]!);
        const rimH = lerp(8, 18, rand());
        out.ridges.push({ id: `${base}-rim`, points: ring, height: r1(rimH), width: r1(clamp(r * 0.08, 6, 14)), falloff: r1(clamp(r * 0.35, 15, 120)), tags });
        note = `r ${r1(r)} m, floor ${floor} m (${r1(depth)} under the lowest inner ground), rim +${r1(rimH)} m`;
        break;
      }
      case "sinkhole-field": {
        const count = clamp(Math.round(c.area / 12_000), 2, 14);
        const placed: [number, number, number][] = [];
        for (let tries = 0; tries < count * 40 && placed.length < count; tries++) {
          const [x, z] = inside();
          const w = lerp(8, 20, rand());
          if (placed.some((p) => Math.hypot(p[0] - x, p[1] - z) < 2.5 * Math.max(w, p[2]))) continue;
          placed.push([x, z, w]);
        }
        placed.forEach(([x, z, w], i) => {
          const depth = lerp(10, 22, rand());
          const floor = r1(Math.max(field.height(x, z) - depth, sea + 1.5));
          out.canyons.push({ id: `${base}-${i + 1}`, points: [[r1(x - 0.5), r1(z)], [r1(x + 0.5), r1(z)]], width: r1(w), depth: r1(depth), rim: r1(lerp(6, 14, rand())), steps: 1 + Math.floor(rand() * 2), stepSharpness: r2(lerp(0.6, 0.85, rand())), floorY: [floor, floor] });
        });
        note = `${placed.length}/${count} pits`;
        break;
      }
      case "sea-stack-field": {
        const count = clamp(Math.round(c.area / 15_000), 2, 12);
        const placed: [number, number, number][] = [];
        for (let tries = 0; tries < count * 60 && placed.length < count; tries++) {
          const [x, z] = inside();
          const bed = field.height(x, z);
          const deep = sea - bed;
          if (deep < 1 || deep > 30) continue;
          const radius = lerp(5, 11, rand());
          if (placed.some((p) => Math.hypot(p[0] - x, p[1] - z) < (radius + p[2]) * 1.6)) continue;
          placed.push([x, z, radius]);
          const above = lerp(12, 40, rand());
          out.blobs.push({ id: `${base}-${placed.length}`, center: [r1(x), r1(bed - 2), r1(z)], radius: r1(radius), op: "add", falloff: 2, height: r1(deep + 2 + above), topRadius: r1(radius * lerp(0.55, 0.85, rand())), scaleX: r2(lerp(0.75, 1.3, rand())), scaleZ: r2(lerp(0.75, 1.3, rand())) });
        }
        note = `${placed.length}/${count} stacks${placed.length === 0 ? " (no seabed 1..30 m deep inside the blob)" : ""}`;
        break;
      }
      case "rock-arch": {
        const span = lerp(22, 40, rand());
        const legH = lerp(14, 26, rand());
        const legR = lerp(4, 6.5, rand());
        const ends: [number, number, number][] = [-1, 1].map((s) => {
          const x = c.cx + c.ux * s * (span / 2), z = c.cz + c.uz * s * (span / 2);
          return [x, field.height(x, z), z];
        });
        ends.forEach(([x, y, z], i) => out.blobs.push({ id: `${base}-leg${i + 1}`, center: [r1(x), r1(y - 2), r1(z)], radius: r1(legR), op: "add", falloff: 2, height: r1(legH + 2), topRadius: r1(legR * 0.8), scaleX: 1, scaleZ: 1 }));
        const lr = legR * 0.85;
        const yA = ends[0]![1] + legH, yB = ends[1]![1] + legH;
        const rise = span * 0.15;
        const arcLen = span + rise * 2;
        const n = Math.max(4, Math.ceil(arcLen / (lr * 0.7)));
        let clearance = Infinity;
        for (let s = 0; s <= n; s++) {
          const t = s / n;
          const x = lerp(ends[0]![0], ends[1]![0], t), z = lerp(ends[0]![2], ends[1]![2], t);
          const y = lerp(yA, yB, t) + Math.sin(Math.PI * t) * rise;
          if (t > 0.2 && t < 0.8) clearance = Math.min(clearance, y - lr - field.height(x, z));
          out.blobs.push({ id: `${base}-span${s + 1}`, center: [r1(x), r1(y), r1(z)], radius: r1(lr), op: "add", falloff: 2, height: 0, scaleX: 1, scaleZ: 1 });
        }
        note = `span ${r1(span)} m, legs ${r1(legH)} m, ${n + 1} lintel spheres, min clearance ${r1(clearance)} m`;
        if (clearance < 6) out.notes.push(`${base}: only ${r1(clearance)} m under the lintel (ground rises under the span)`);
        break;
      }
    }
    out.notes.push(`${base.padEnd(30)} ${cls.kind.padEnd(12)} area ${(c.area / 1e3).toFixed(0).padStart(5)}k m² @ [${Math.round(c.cx)}, ${Math.round(c.cz)}]  ${note}`);
  }
  return out;
}

// ---------------------------------------------------------------- ledger

interface Ledger {
  world: string;
  key: string;
  keySha1: string;
  appliedAt: string;
  options: ClassifyOptions;
  base: BaseMapping;
  ids: { ridges: string[]; canyons: string[]; blobs: string[]; fills?: string[]; heightPatches?: string[] };
  components: { id: string; class: string; area: number; center: [number, number]; length: number; width: number; reach: number; cells: number }[];
}

function readLedger(dir: string): Ledger | null {
  const f = path.join(dir, "ledger.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Ledger) : null;
}

function lostIds(recipe: WorldRecipe, ledger: Ledger): string[] {
  const lost: string[] = [];
  for (const kind of ["ridges", "canyons", "blobs", "fills", "heightPatches"] as const) {
    const have = new Set((recipe.features[kind] as { id: string }[]).map((f) => f.id));
    for (const id of ledger.ids[kind] ?? []) if (!have.has(id)) lost.push(`${kind}:${id}`);
  }
  return lost;
}

/** pipelineStages() check: written, and nothing a later stage wiped (canyons replaces every canyon). */
export function landformsStageCheck(recipe: WorldRecipe, recipeFile: string | null): string | null {
  if (!recipeFile) return "nothing written";
  const ledger = readLedger(artifactDir(recipeFile, recipe.name));
  if (!ledger) return "nothing written";
  const lost = lostIds(recipe, ledger);
  return lost.length > 0 ? `${lost.length} landform feature(s) missing (${lost.slice(0, 3).join(", ")}) — a later stage replaced them; re-run landforms apply` : null;
}

// ---------------------------------------------------------------- apply

function loadBase(host: LandformsHost, dir: string, world: string, recipe: WorldRecipe): BaseMapping {
  const f = path.join(dir, "base.json");
  if (!fs.existsSync(f)) host.fail(`no base mapping ${f} — run: worldgen landforms base ${world}`);
  const m = JSON.parse(fs.readFileSync(f, "utf8")) as BaseMapping;
  const stamp = recipe.pipeline["continents"] ?? null;
  if (stamp && m.continentsStamp && stamp !== m.continentsStamp) console.warn(`  ! continents re-ran since the base map was drawn (${m.continentsStamp} -> ${stamp}): the key was painted over different land`);
  return m;
}

function classifyOptions(argv: string[], m: BaseMapping): ClassifyOptions {
  return {
    tolerance: num(argv, "tolerance", 72),
    grid: Math.round(num(argv, "grid", Math.max(64, Math.round(m.size / 2)))),
    open: Math.round(num(argv, "open", 1)),
    minPx: Math.round(num(argv, "min-px", 4)),
  };
}

function commandApply(host: LandformsHost, world: string): void {
  const { recipe, file } = host.loadRecipe(world);
  const argv = host.argv;
  const dir = artifactDir(file, world);
  const keyArg = opt(argv, "key");
  const keyPath = keyArg ? path.resolve(keyArg) : path.join(dir, "key.png");
  if (!fs.existsSync(keyPath)) host.fail(`no key image ${keyPath} — pass --key <png> or run: worldgen landforms request ${world}`);
  const m = loadBase(host, dir, world, recipe);
  const o = classifyOptions(argv, m);
  const t0 = Date.now();
  const { grid, components, stats } = classify(keyPath, m, o);
  for (const s of stats) console.log(`  ${s}`);
  console.log(`  ${components.length} component(s) on a ${o.grid}² grid (${grid.cell.toFixed(1)} m cells, tolerance ${o.tolerance}, open ${o.open})`);
  // idempotent: drop our own entries, measure the ground without them
  const f = recipe.features;
  const own = <T extends { id: string }>(list: T[]): T[] => list.filter((x) => !x.id.startsWith(PREFIX));
  f.ridges = own(f.ridges);
  f.canyons = own(f.canyons);
  f.blobs = own(f.blobs);
  f.heightPatches = own(f.heightPatches);
  f.fills = own(f.fills);
  const field = strippedField(recipe);
  const built = buildFeatures(recipe, components, grid, field);
  for (const note of built.notes) console.log(`  ${note}`);
  f.ridges.push(...built.ridges);
  f.canyons.push(...built.canyons);
  f.blobs.push(...built.blobs);
  f.fills.push(...built.fills);
  if (argv.includes("--dry")) {
    console.log(`(dry) would write ${built.ridges.length} ridges, ${built.canyons.length} canyons, ${built.blobs.length} blobs, ${built.fills.length} fills`);
    return;
  }
  host.writeRecipe(recipe, file);
  const counters = new Map<string, number>();
  const ledger: Ledger = {
    world,
    key: path.relative(dir, keyPath).startsWith("..") ? keyPath : path.relative(dir, keyPath),
    keySha1: createHash("sha1").update(fs.readFileSync(keyPath)).digest("hex"),
    appliedAt: new Date().toISOString(),
    options: o,
    base: m,
    ids: {
      ridges: built.ridges.map((x) => x.id),
      canyons: built.canyons.map((x) => x.id),
      blobs: built.blobs.map((x) => x.id),
      fills: built.fills.map((x) => x.id),
    },
    components: components.map((c) => {
      const cls = LANDFORM_CLASSES[c.cls]!.id;
      const k = (counters.get(cls) ?? 0) + 1;
      counters.set(cls, k);
      return { id: `${PREFIX}${cls}-${k}`, class: cls, area: Math.round(c.area), center: [Math.round(c.cx), Math.round(c.cz)], length: Math.round(c.length), width: Math.round(c.width), reach: Math.round(c.reach), cells: c.cells.length };
    }),
  };
  fs.writeFileSync(path.join(dir, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`landforms: ${built.ridges.length} ridges, ${built.canyons.length} canyons, ${built.blobs.length} blobs, ${built.fills.length} fills (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  console.log(`next: worldgen landforms check ${world}, then worldgen rivers ${world}`);
}

// ---------------------------------------------------------------- check

const RAISE = new Set(["mesa", "plateau", "ridge-spur", "rock-arch"]);
const CUT = new Set(["gorge", "crater", "sinkhole-field"]);

function patchWeight(p: HeightPatchDoc, x: number, z: number): number {
  const dx = x - p.origin[0], dz = z - p.origin[1];
  if (dx <= 0 || dz <= 0 || dx >= p.size[0] || dz >= p.size[1]) return 0;
  return smoothstep(0, p.blend, Math.min(dx, dz, p.size[0] - dx, p.size[1] - dz));
}

function commandCheck(host: LandformsHost, world: string): void {
  const { recipe, file } = host.loadRecipe(world);
  const argv = host.argv;
  const dir = artifactDir(file, world);
  const ledger = readLedger(dir);
  if (!ledger) host.fail(`no ledger in ${dir} — run: worldgen landforms apply ${world} --key <png>`);
  const keyPath = path.isAbsolute(ledger.key) ? ledger.key : path.join(dir, ledger.key);
  if (!fs.existsSync(keyPath)) host.fail(`the applied key ${keyPath} is gone`);
  const m = ledger.base;
  const { grid, components } = classify(keyPath, m, ledger.options);
  const field = strippedField(recipe);
  const findings: string[] = [];
  const sea = recipe.seaLevel;
  const ids = ledger.components.map((c) => c.id);

  // 0. features a later stage wiped (`worldgen canyons` rewrites every canyon)
  const lost = lostIds(recipe, ledger);
  if (lost.length) findings.push(`${lost.length} landform feature(s) no longer in the recipe (${lost.slice(0, 4).join(", ")}): re-run landforms apply`);
  if (createHash("sha1").update(fs.readFileSync(keyPath)).digest("hex") !== ledger.keySha1) findings.push("the key image changed since apply: re-run landforms apply");

  // 1. land / sea, 2. size
  let landCells = 0;
  const isLand = new Uint8Array(grid.n * grid.n);
  for (let i = 0; i < grid.n * grid.n; i++) {
    const [x, z] = cellXZ(i, grid.n, grid.cell, m);
    const beyond = field.worldLimit !== Infinity && x * x + z * z > field.worldLimit ** 2;
    if (!beyond && field.height(x, z) > sea + 0.5) { isLand[i] = 1; landCells++; }
  }
  let covered = 0;
  components.forEach((c, k) => {
    const cls = LANDFORM_CLASSES[c.cls]!;
    const id = ids[k] ?? `${cls.id}?`;
    const onLand = c.cells.reduce((s, i) => s + isLand[i]!, 0) / c.cells.length;
    if (cls.where === "land" && onLand < 0.9) findings.push(`${id}: only ${Math.round(onLand * 100)}% on land (needs 90%)`);
    if (cls.where === "sea") {
      if (onLand > 0.25) findings.push(`${id}: ${Math.round(onLand * 100)}% on land — sea stacks stand in the sea`);
      let coast = false;
      for (let a = 0; a < 24 && !coast; a++) for (const d of [100, 250, 450]) {
        const x = c.cx + Math.cos((a * Math.PI) / 12) * (c.reach + d), z = c.cz + Math.sin((a * Math.PI) / 12) * (c.reach + d);
        if (field.height(x, z) > sea) { coast = true; break; }
      }
      if (!coast && onLand === 0) findings.push(`${id}: no coast within 450 m — sea stacks belong off a shore`);
    } else covered += c.area;
    if (c.area < cls.minArea) findings.push(`${id}: ${Math.round(c.area)} m² is under the ${cls.name} minimum ${cls.minArea} m²`);
    if (c.area > cls.maxArea) findings.push(`${id}: ${Math.round(c.area)} m² is over the ${cls.name} maximum ${cls.maxArea} m²`);
    if (cls.minLength && c.length < cls.minLength) findings.push(`${id}: ${Math.round(c.length)} m long, under ${cls.minLength} m`);
    if (cls.maxLength && c.length > cls.maxLength) findings.push(`${id}: ${Math.round(c.length)} m long, over ${cls.maxLength} m`);
  });

  // 3. incompatible overlap: a raise and a cut whose influence discs meet,
  // and any feature under a landform-* height patch (none are written now; hand-added ones apply after every feature)
  const influence = (cls: string): number => (cls === "plateau" ? 90 : cls === "ridge-spur" ? 120 : cls === "mesa" ? 20 : 60);
  for (let a = 0; a < components.length; a++) for (let b = a + 1; b < components.length; b++) {
    const A = components[a]!, B = components[b]!;
    const ca = LANDFORM_CLASSES[A.cls]!.id, cb = LANDFORM_CLASSES[B.cls]!.id;
    const incompatible = (RAISE.has(ca) && CUT.has(cb)) || (CUT.has(ca) && RAISE.has(cb));
    if (!incompatible) continue;
    const d = Math.hypot(A.cx - B.cx, A.cz - B.cz);
    if (d < A.reach + B.reach + Math.max(influence(ca), influence(cb))) findings.push(`${ids[a]} (${ca}) and ${ids[b]} (${cb}) overlap: a raise and a cut fight over the same ground`);
  }
  const patches = recipe.features.heightPatches.filter((p) => p.id.startsWith(PREFIX));
  for (let a = 0; a < patches.length; a++) for (let b = a + 1; b < patches.length; b++) {
    const A = patches[a]!, B = patches[b]!;
    if (A.origin[0] < B.origin[0] + B.size[0] && B.origin[0] < A.origin[0] + A.size[0] && A.origin[1] < B.origin[1] + B.size[1] && B.origin[1] < A.origin[1] + A.size[1]) findings.push(`${A.id} and ${B.id}: height patch rectangles overlap (the later one wins wholesale)`);
  }
  // features (landform or not) under a landform patch get overwritten by it
  const underPatch = (x: number, z: number): HeightPatchDoc | null => {
    // the whole rectangle, not just the raised footprint: outside it the patch
    // stores the ground as it was at apply time, which still overwrites a later carve
    for (const p of patches) if (patchWeight(p, x, z) >= 0.2) return p;
    return null;
  };
  const buried = new Map<string, number>();
  const note = (what: string, p: HeightPatchDoc): void => { const k = `${what} under ${p.id}`; buried.set(k, (buried.get(k) ?? 0) + 1); };
  for (const r of recipe.features.rivers) for (const [x, z] of r.points) { const p = underPatch(x, z); if (p) note(`river ${r.id}`, p); }
  for (const l of recipe.features.lakes) { const p = underPatch(l.center[0], l.center[1]); if (p) note(`lake ${l.id}`, p); }
  for (const t of recipe.features.towns) { const p = underPatch(t.center[0], t.center[1]); if (p) note(`town ${t.id}`, p); }
  for (const r of recipe.features.roads) for (const [x, z] of r.points) { const p = underPatch(x, z); if (p) note(`road ${r.id}`, p); }
  for (const kind of ["ridges", "canyons"] as const) for (const f of recipe.features[kind]) for (const [x, z] of f.points) { const p = underPatch(x, z); if (p && p.id !== f.id) note(`${kind.slice(0, -1)} ${f.id}`, p); }
  for (const [what, n] of buried) findings.push(`${what} (${n} point${n === 1 ? "" : "s"}): height patches apply after every feature and overwrite it`);

  // 4. coverage cap
  const cap = num(argv, "coverage", 0.15);
  const landArea = landCells * grid.cell * grid.cell;
  const share = landArea > 0 ? covered / landArea : 0;
  if (share > cap) findings.push(`landforms cover ${(share * 100).toFixed(1)}% of the land (cap ${(cap * 100).toFixed(0)}%, --coverage)`);

  // preview: base + class overlay + feature lines
  const basePng = path.join(dir, "base.png");
  const n = m.size;
  const rgba = fs.existsSync(basePng) ? (decodePng(fs.readFileSync(basePng)) as { data: Uint8Array }).data : new Uint8Array(n * n * 4).fill(255);
  for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
    const gi = Math.floor((px * grid.n) / n) + Math.floor((py * grid.n) / n) * grid.n;
    const c = grid.label[gi]!;
    if (c < 0) continue;
    const o = (px + py * n) * 4;
    const col = CLASS_RGB[c]!;
    for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(rgba[o + k]! * 0.45 + col[k]! * 0.55);
  }
  const toPx = (x: number, z: number): [number, number] => [Math.floor((x - m.originX) / m.metresPerPixel), Math.floor((z - m.originZ) / m.metresPerPixel)];
  const plot = (x: number, y: number, col: RGB): void => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const o = (x + y * n) * 4;
    rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]; rgba[o + 3] = 255;
  };
  const line = (pts: readonly (readonly [number, number])[], col: RGB): void => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = toPx(pts[i]![0], pts[i]![1]);
      const [bx, by] = toPx(pts[i + 1]![0], pts[i + 1]![1]);
      const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay)));
      for (let s = 0; s <= steps; s++) plot(Math.round(ax + ((bx - ax) * s) / steps), Math.round(ay + ((by - ay) * s) / steps), col);
    }
  };
  for (const p of patches) {
    const [x0, z0] = [p.origin[0], p.origin[1]];
    const [x1, z1] = [x0 + p.size[0], z0 + p.size[1]];
    line([[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]], [255, 255, 255]);
  }
  for (const f of recipe.features.fills) if (f.id.startsWith(PREFIX)) line([...f.polygon, f.polygon[0]!], [255, 255, 255]);
  for (const r of recipe.features.ridges) if (r.id.startsWith(PREFIX)) line(r.points, [40, 20, 0]);
  for (const c of recipe.features.canyons) if (c.id.startsWith(PREFIX)) { line(c.points, [255, 255, 255]); const [x, y] = toPx(c.points[0]![0], c.points[0]![1]); for (let d = -1; d <= 1; d++) { plot(x + d, y, [0, 0, 0]); plot(x, y + d, [0, 0, 0]); } }
  for (const b of recipe.features.blobs) if (b.id.startsWith(PREFIX)) { const [x, y] = toPx(b.center[0], b.center[2]); plot(x, y, [0, 0, 0]); }
  for (const r of recipe.features.rivers) line(r.points, [70, 150, 235]);
  fs.writeFileSync(path.join(dir, "preview.png"), encodePng(n, n, rgba));

  console.log(`${world}: ${components.length} landform(s), ${((share * 100).toFixed(1))}% of ${(landArea / 1e6).toFixed(2)} km² land; preview ${path.relative(process.cwd(), path.join(dir, "preview.png"))}`);
  for (const f of findings) console.log(`  ! ${f}`);
  console.log(findings.length === 0 ? "  no findings" : `  ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
  if (findings.length > 0) process.exit(1);
}

// ---------------------------------------------------------------- entry

export function commandLandforms(host: LandformsHost): void {
  const sub = host.argv[1] ?? "help";
  const world = host.argv[2] && !host.argv[2].startsWith("--") ? host.argv[2] : "";
  if (sub !== "help" && sub !== "legend" && !world) host.fail(`usage: worldgen landforms ${sub} <world>`);
  switch (sub) {
    case "base":
      return commandBase(host, world);
    case "request":
      return commandRequest(host, world);
    case "apply":
      return commandApply(host, world);
    case "check":
      return commandCheck(host, world);
    case "legend":
      for (const c of LANDFORM_CLASSES) console.log(`${c.hex}  ${c.id.padEnd(16)} ${c.where.padEnd(5)} ${c.kind.padEnd(13)} ${c.params}`);
      return;
    default:
      console.log(`worldgen landforms — a flat-colour KEY of landform classes -> recipe features (run after continents, before canyons/rivers)

  landforms base    <world> [--size 1024] [--cx --cz --extent]   relief base map + base.json mapping + legend.json
  landforms request <world> [--brief "..."] [--dry] [--timeout 900]  prompt (landforms-prompt.md + legend) -> image-request.mjs gen
  landforms apply   <world> [--key <png>] [--tolerance 72] [--grid N] [--open 1] [--min-px 4] [--dry]
  landforms check   <world> [--coverage 0.15]                    gate (exit 1 on findings) + preview.png
  landforms legend                                                 the class table`);
  }
}
