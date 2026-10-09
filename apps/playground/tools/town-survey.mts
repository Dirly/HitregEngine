/**
 * town-survey — stage 1 of the town planner: read the ground a town stands on
 * and PROVE a player can walk in.
 *
 *   npx tsx tools/town-survey.mts --project proving --town brinehold [--margin 90] [--out <dir>]
 *
 * Reads the town doc (`authoring/towns/<town>.json`: its world and town id)
 * and the world recipe, samples the field's ground on a 1 m grid round the
 * town, and walks it with the PLAYER's limits (the physics character
 * defaults: 50° climb; the 0.4 m autostep is finer than the grid so it adds
 * nothing here). Water is not walkable. It writes:
 *
 *   <out>/<town>.json   site stats, every road that touches the town walked
 *                       metre by metre (first blocked point), and which
 *                       anchors (gates, terraces, residents, the spawn) can be
 *                       reached from the far end of each approach road
 *   <out>/<town>.png    north-up map, 2 px per metre: hillshade, water,
 *                       steep (orange >35°) and unclimbable (red >50°) ground,
 *                       ground the approach cannot reach (purple), roads
 *                       (yellow; blocked metres magenta), gate (white),
 *                       terrace spines (cyan), residents (green = reachable,
 *                       red = not)
 *
 * Exit code 1 when any approach road or any anchor is blocked: the survey is a
 * gate the town pipeline cannot pass without fixing the ground (worldgen
 * paths / terrace, or a DC stair), never the town.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const projectName = opt("project", "");
const townName = opt("town", "");
if (!projectName || !townName) {
  console.error("usage: town-survey --project <p> --town <name> [--margin 90] [--out <dir>]");
  process.exit(2);
}
const projectDir = path.resolve("projects", projectName);
const townDoc = JSON.parse(fs.readFileSync(path.join(projectDir, "authoring/towns", `${townName}.json`), "utf8"));
const recipeFile = path.join(projectDir, "assets/worlds", `${townDoc.world}.json`);
const recipe: WorldRecipe = worldRecipeSchema.parse(JSON.parse(fs.readFileSync(recipeFile, "utf8")));
const field = createWorldField(recipe);
const town = recipe.features.towns?.find((t) => t.id === townDoc.town);
if (!town) throw new Error(`world ${townDoc.world} has no town ${townDoc.town}`);

/** Player limits: packages/physics DEFAULT_CHARACTER (maxSlopeClimbAngle 50°). */
const CLIMB_DEG = 50;
const COMFORT_DEG = 35;
const climbTan = Math.tan((CLIMB_DEG * Math.PI) / 180);
const comfortTan = Math.tan((COMFORT_DEG * Math.PI) / 180);

// ---- the grid -------------------------------------------------------------
const margin = Number(opt("margin", "90"));
const half = Math.ceil(town.radius + (town.falloff ?? 0) + margin);
const n = half * 2 + 1;
const [cx, cz] = town.center;
const x0 = Math.round(cx) - half;
const z0 = Math.round(cz) - half;
const H = new Float32Array(n * n);
const wet = new Uint8Array(n * n);
const t0 = Date.now();
/** Cells where the 3D surface departs from the 2D height by > 0.5 m (overhangs, fins, carved hollows). */
let solid3d = 0;
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) {
    const x = x0 + i;
    const z = z0 + j;
    // the TOPMOST SOLID surface from the density (what the voxel mesh and the physics collider are built from),
    // not the 2D height: overhangs, fins and hollows the 2D field smooths over are exactly what blocks a player
    const h2 = field.height(x, z);
    const h = field.surfaceCast(x, z, h2 + 40, h2 - 40) ?? h2;
    H[i + j * n] = h;
    if (Math.abs(h - h2) > 0.5) solid3d++;
    const w = field.waterY(x, z);
    if (h < recipe.seaLevel || (w !== null && w > h + 0.3)) wet[i + j * n] = 1;
  }
const at = (x: number, z: number): number => {
  const i = Math.round(x - x0);
  const j = Math.round(z - z0);
  return i < 0 || j < 0 || i >= n || j >= n ? -1 : i + j * n;
};

/** Slope over the 2 m voxel spacing (a 1 m difference sees grid noise the mesh never has). */
const slopeTan = new Float32Array(n * n);
for (let j = 2; j < n - 2; j++)
  for (let i = 2; i < n - 2; i++) {
    const gx = (H[i + 2 + j * n]! - H[i - 2 + j * n]!) / 4;
    const gz = (H[i + (j + 2) * n]! - H[i + (j - 2) * n]!) / 4;
    slopeTan[i + j * n] = Math.hypot(gx, gz);
  }

// ---- the walk graph -------------------------------------------------------
/** A move between neighbours is walkable both ways: dry, and no steeper than the climb limit. */
function passable(a: number, b: number, run: number): boolean {
  if (wet[a] || wet[b]) return false;
  return Math.abs(H[b]! - H[a]!) / run <= climbTan;
}
const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];
function flood(seeds: number[]): Uint8Array {
  const seen = new Uint8Array(n * n);
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  for (const s of seeds) if (s >= 0 && !wet[s] && !seen[s]) { seen[s] = 1; queue[tail++] = s; }
  while (head < tail) {
    const c = queue[head++]!;
    const i = c % n;
    const j = (c - i) / n;
    for (const [di, dj, run] of DIRS) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const k = ii + jj * n;
      if (!seen[k] && passable(c, k, run)) { seen[k] = 1; queue[tail++] = k; }
    }
  }
  return seen;
}
/** Nearest dry cell to a point (anchors sit on ground the grid may round into a ditch). */
function snap(x: number, z: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let dz = -2; dz <= 2; dz++)
    for (let dx = -2; dx <= 2; dx++) {
      const k = at(x + dx, z + dz);
      if (k >= 0 && !wet[k] && dx * dx + dz * dz < bestD) { best = k; bestD = dx * dx + dz * dz; }
    }
  return best;
}

// ---- roads that touch the town -------------------------------------------
type Pt = [number, number];
const inBox = ([x, z]: Pt): boolean => at(x, z) >= 0;
function densify(points: Pt[], step: number): Pt[] {
  const out: Pt[] = [points[0]!];
  for (let k = 1; k < points.length; k++) {
    const [ax, az] = points[k - 1]!;
    const [bx, bz] = points[k]!;
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / step));
    for (let s = 1; s <= steps; s++) out.push([ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps]);
  }
  return out;
}
const gates = town.gates ?? [];
const roads = (recipe.features.roads ?? [])
  .map((r) => ({ id: r.id, width: r.width, points: r.points as Pt[] }))
  .filter((r) => r.points.some(inBox));

/** The walkable surface at a point: the topmost solid, as the grid samples it. */
function ground(x: number, z: number): number {
  const h2 = field.height(x, z);
  return field.surfaceCast(x, z, h2 + 40, h2 - 40) ?? h2;
}
/** Minimum clear width a player gets on a way into town: a 3.4 m footpath, less a little (Derek: the gate slot "is not the slope, it's the width"). */
const MIN_WIDTH = 3;
const widthStepTan = Math.tan((COMFORT_DEG * Math.PI) / 180) * 0.25;
/** Walkable width across (x, z) perpendicular to (nx, nz): the run each side before a 35° lip or the water. */
function clearWidth(x: number, z: number, nx: number, nz: number): number {
  let total = 0;
  for (const s of [1, -1]) {
    let prev = ground(x, z);
    let d = 0;
    for (; d < 8; d += 0.25) {
      const h = ground(x + nx * s * (d + 0.25), z + nz * s * (d + 0.25));
      if (Math.abs(h - prev) > widthStepTan || h < recipe.seaLevel + 0.2) break;
      prev = h;
    }
    total += d;
  }
  return total;
}
interface RoadWalk {
  id: string;
  metres: number;
  maxGradePct: number;
  maxCrossPct: number;
  overComfort: number;
  blocked: { along: number; at: Pt; gradePct: number; wet: boolean }[];
  firstBlocked: { along: number; at: Pt; gradePct: number; wet: boolean } | null;
  minWidth: number;
  narrow: { along: number; at: Pt; width: number }[];
}
function walkRoad(points: Pt[]): Omit<RoadWalk, "id"> {
  let minWidth = Infinity;
  const narrow: RoadWalk["narrow"] = [];
  const d = densify(points, 1).filter(inBox);
  let along = 0;
  let maxGrade = 0;
  let maxCross = 0;
  let overComfort = 0;
  const blocked: RoadWalk["blocked"] = [];
  for (let k = 1; k < d.length; k++) {
    const [ax, az] = d[k - 1]!;
    const [bx, bz] = d[k]!;
    const run = Math.hypot(bx - ax, bz - az) || 1;
    along += run;
    const ha = ground(ax, az);
    const hb = ground(bx, bz);
    const grade = Math.abs(hb - ha) / run;
    maxGrade = Math.max(maxGrade, grade);
    if (grade > comfortTan) overComfort += run;
    const nx = -(bz - az) / run;
    const nz = (bx - ax) / run;
    const cross = Math.abs(ground(bx + nx * 1.5, bz + nz * 1.5) - ground(bx - nx * 1.5, bz - nz * 1.5)) / 3;
    maxCross = Math.max(maxCross, cross);
    const k2 = at(bx, bz);
    const isWet = k2 >= 0 && wet[k2] === 1;
    const w = clearWidth(bx, bz, nx, nz);
    minWidth = Math.min(minWidth, w);
    if (w < MIN_WIDTH) narrow.push({ along: Math.round(along), at: [Math.round(bx * 10) / 10, Math.round(bz * 10) / 10], width: Math.round(w * 100) / 100 });
    if (grade > climbTan || isWet) blocked.push({ along: Math.round(along), at: [Math.round(bx * 10) / 10, Math.round(bz * 10) / 10], gradePct: Math.round(grade * 100), wet: isWet });
  }
  return { metres: Math.round(along), maxGradePct: Math.round(maxGrade * 100), maxCrossPct: Math.round(maxCross * 100), overComfort: Math.round(overComfort), blocked, firstBlocked: blocked[0] ?? null, minWidth: Math.round(minWidth * 100) / 100, narrow };
}
const roadWalks: RoadWalk[] = roads.map((r) => ({ id: r.id, ...walkRoad(r.points) }));
const ownRoads = roads.filter((r) => r.id.startsWith(`${town.id}-`));
for (const g of gates) {
  let best: Pt | null = null;
  for (const r of ownRoads) for (const e of [r.points[0]!, r.points.at(-1)!]) if (!best || Math.hypot(e[0] - g.at[0], e[1] - g.at[1]) < Math.hypot(best[0] - g.at[0], best[1] - g.at[1])) best = e;
  if (best) roadWalks.push({ id: `link:${g.id}`, ...walkRoad([g.at as Pt, best]) });
}

// ---- reachability from each approach road's far end -----------------------
/** An approach = a road that reaches a gate; its seed is its last point still inside the grid. */
const approaches = roads
  .filter((r) => gates.some((g) => Math.hypot(r.points[0]![0] - g.at[0], r.points[0]![1] - g.at[1]) < 4 || Math.hypot(r.points.at(-1)![0] - g.at[0], r.points.at(-1)![1] - g.at[1]) < 4))
  .map((r) => {
    const fromGate = gates.some((g) => Math.hypot(r.points[0]![0] - g.at[0], r.points[0]![1] - g.at[1]) < 4);
    const ordered = fromGate ? r.points : [...r.points].reverse();
    const inside = densify(ordered, 1).filter(inBox);
    return { id: r.id, seed: inside.at(-1)! };
  });

interface Anchor { id: string; kind: string; at: Pt; y: number }
const anchors: Anchor[] = [];
for (const g of gates) anchors.push({ id: g.id, kind: "gate", at: g.at as Pt, y: ground(g.at[0], g.at[1]) });
for (const t of town.terraces ?? []) {
  const mid = t.points[Math.floor(t.points.length / 2)]!;
  anchors.push({ id: t.id, kind: "terrace", at: mid as Pt, y: t.groundY });
}
anchors.push({ id: "centre", kind: "centre", at: [cx, cz], y: ground(cx, cz) });
for (const r of townDoc.residents ?? []) {
  const p = r.place?.at as Pt | undefined;
  if (p) anchors.push({ id: r.id, kind: `resident:${r.role}`, at: p, y: ground(p[0], p[1]) });
}

const floods = approaches.map((a) => ({ ...a, reach: flood([snap(a.seed[0], a.seed[1])]) }));
const anyReach = new Uint8Array(n * n);
for (const f of floods) for (let k = 0; k < n * n; k++) if (f.reach[k]) anyReach[k] = 1;
const anchorResults = anchors.map((a) => {
  const k = snap(a.at[0], a.at[1]);
  return { ...a, y: Math.round(a.y * 10) / 10, reachedFrom: floods.filter((f) => k >= 0 && f.reach[k]).map((f) => f.id) };
});

// ---- site character ---------------------------------------------------------
let dryInTown = 0;
let flat = 0;
let steep = 0;
let cliff = 0;
let minY = Infinity;
let maxY = -Infinity;
let wetInTown = 0;
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) {
    if (Math.hypot(i - half, j - half) > town.radius) continue;
    const k = i + j * n;
    if (wet[k]) { wetInTown++; continue; }
    dryInTown++;
    minY = Math.min(minY, H[k]!);
    maxY = Math.max(maxY, H[k]!);
    const s = slopeTan[k]!;
    if (s < 0.08) flat++;
    else if (s > climbTan) cliff++;
    else if (s > comfortTan) steep++;
  }
const biome = field.biome(cx, cz);
const climate = field.climate(cx, cz);
const relief = maxY - minY;
const terraces = town.terraces?.length ?? 0;
const nearWater = wetInTown / Math.max(1, dryInTown + wetInTown) > 0.03;
const site =
  terraces > 0 || relief > 12 ? (nearWater ? "terraced-coast" : "terraced-hill") : nearWater ? "coast" : relief < 4 ? "flat" : "rolling";

const failures: string[] = [];
for (const w of roadWalks) {
  const way = approaches.some((a) => a.id === w.id) || w.id.startsWith("link:") || w.id.startsWith(`${town.id}-`);
  // the gate mouth itself is where road and court meet: the first and last 2 m of a way are not judged for width
  const narrowRun = w.narrow.filter((n) => n.along > 2 && n.along < w.metres - 2);
  if (way && narrowRun.length) failures.push(`${w.id}: ${narrowRun.length} m narrower than ${MIN_WIDTH} m, narrowest ${Math.min(...narrowRun.map((n) => n.width))} m at ${narrowRun[0]!.along} m [${narrowRun[0]!.at}]`);
}
for (const w of roadWalks)
  if (w.firstBlocked && approaches.some((a) => a.id === w.id))
    failures.push(`${w.id}: ${w.blocked.length} blocked metre(s) inside the survey, first at ${w.firstBlocked.along} m [${w.firstBlocked.at}] (${w.firstBlocked.wet ? "water" : `${w.firstBlocked.gradePct}% grade`})`);
for (const a of anchorResults) if (a.reachedFrom.length === 0) failures.push(`${a.kind} ${a.id} at [${a.at.map((v) => Math.round(v))}] y ${a.y} is not reachable from any approach`);

// the SEA near the town (ground under sea level within the pad + 60 m): an ocean-coastal town must have a dock
let seaCells = 0;
for (let j = 0; j < n; j += 2)
  for (let i = 0; i < n; i += 2)
    if (Math.hypot(i - half, j - half) <= town.radius + (town.falloff ?? 0) + 60 && H[i + j * n]! < recipe.seaLevel) seaCells++;
const coastal = seaCells > 50;
const report = {
  coastal,
  town: townName,
  townId: town.id,
  world: townDoc.world,
  tier: town.tier,
  site,
  limits: { climbDeg: CLIMB_DEG, comfortDeg: COMFORT_DEG, grid: "1 m, slope over 2 m" },
  /** Where the map picture sits in the world: pixel (px, py) = world (x0 + px / scale, z0 + py / scale). */
  map: { x0, z0, n, scale: 2 },
  ground: {
    radius: town.radius,
    minY: Math.round(minY * 10) / 10,
    maxY: Math.round(maxY * 10) / 10,
    reliefM: Math.round(relief * 10) / 10,
    flatPct: Math.round((100 * flat) / Math.max(1, dryInTown)),
    steepPct: Math.round((100 * steep) / Math.max(1, dryInTown)),
    cliffPct: Math.round((100 * cliff) / Math.max(1, dryInTown)),
    waterPct: Math.round((100 * wetInTown) / Math.max(1, dryInTown + wetInTown)),
    overhangCells: solid3d,
    biome: biome.id,
    temperature: Math.round(climate.temperature * 100) / 100,
    moisture: Math.round(climate.moisture * 100) / 100,
  },
  terraces: (town.terraces ?? []).map((t) => ({ id: t.id, groundY: t.groundY, radius: t.radius })),
  gates: gates.map((g) => ({ id: g.id, at: g.at, facing: g.facing, width: g.width })),
  approaches: approaches.map((a) => a.id),
  roads: roadWalks.map((w) => ({ ...w, blocked: w.blocked.length > 12 ? [...w.blocked.slice(0, 12), `… ${w.blocked.length - 12} more`] : w.blocked })),
  anchors: anchorResults,
  failures,
  ms: Date.now() - t0,
};

// ---- the picture ------------------------------------------------------------
const S = 2;
const W = n * S;
const img = new Uint8Array(W * W * 3);
const put = (px: number, py: number, r: number, g: number, b: number): void => {
  if (px < 0 || py < 0 || px >= W || py >= W) return;
  const o = (px + py * W) * 3;
  img[o] = r; img[o + 1] = g; img[o + 2] = b;
};
const span = Math.max(1, maxY - Math.min(minY, recipe.seaLevel));
for (let j = 1; j < n - 1; j++)
  for (let i = 1; i < n - 1; i++) {
    const k = i + j * n;
    let r: number, g: number, b: number;
    if (wet[k]) { r = 40; g = 70; b = 120; }
    else {
      const shade = Math.max(0, Math.min(1, 0.6 + ((H[k - 1]! - H[k + 1]!) + (H[k - n]! - H[k + n]!)) * 0.35));
      const lum = 70 + 110 * Math.max(0, Math.min(1, (H[k]! - minY) / span));
      r = g = b = lum * shade;
      const s = slopeTan[k]!;
      if (s > climbTan) { r = 200; g = 40; b = 40; }
      else if (s > comfortTan) { r = Math.min(255, r + 90); g = g * 0.8 + 30; b *= 0.5; }
      if (!anyReach[k]) { r = r * 0.55 + 60; g *= 0.45; b = b * 0.55 + 80; }
    }
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) put(i * S + dx, j * S + dy, r | 0, g | 0, b | 0);
  }
const toPx = (x: number, z: number): [number, number] => [Math.round((x - x0) * S), Math.round((z - z0) * S)];
const dot = (x: number, z: number, rad: number, c: [number, number, number]): void => {
  const [px, py] = toPx(x, z);
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) if (dx * dx + dy * dy <= rad * rad) put(px + dx, py + dy, ...c);
};
for (const t of town.terraces ?? []) for (const [x, z] of densify(t.points as Pt[], 0.5)) dot(x, z, 1, [80, 220, 230]);
for (const r of roads) {
  const walk = roadWalks.find((w) => w.id === r.id)!;
  const bad = new Set(walk.blocked.map((b) => `${Math.round(b.at[0])},${Math.round(b.at[1])}`));
  for (const [x, z] of densify(r.points, 0.5)) dot(x, z, 1, bad.has(`${Math.round(x)},${Math.round(z)}`) ? [255, 0, 255] : [240, 210, 60]);
}
// the physics walk (town-walk.mts), when one has been run: trails light blue, stuck points magenta rings
const walkFile = path.join(path.resolve(opt("out", path.join(projectDir, "authoring/towns/survey"))), `${townName}-walk.json`);
if (fs.existsSync(walkFile)) {
  const walked = JSON.parse(fs.readFileSync(walkFile, "utf8")) as { routes: { trail: [number, number, number][]; stuck: { at: [number, number, number] }[] }[] };
  for (const r of walked.routes) {
    for (const [x, , z] of r.trail) dot(x, z, 1, [150, 200, 255]);
    for (const st of r.stuck) for (let a = 0; a < 64; a++) dot(st.at[0] + Math.cos(a / 10) * 4, st.at[2] + Math.sin(a / 10) * 4, 1, [255, 0, 255]);
  }
}
for (const g of gates) dot(g.at[0], g.at[1], 5, [255, 255, 255]);
for (const a of anchorResults) if (a.kind.startsWith("resident")) dot(a.at[0], a.at[1], 3, a.reachedFrom.length ? [60, 230, 90] : [255, 40, 40]);
for (const a of approaches) dot(a.seed[0], a.seed[1], 4, [240, 210, 60]);
// north arrow, top-left
for (let y = 8; y < 40; y++) put(20, y, 255, 255, 255);
for (let d = 0; d < 8; d++) { put(20 - d, 8 + d, 255, 255, 255); put(20 + d, 8 + d, 255, 255, 255); }

function png(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, c) => { for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer): number => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const outDir = path.resolve(opt("out", path.join(projectDir, "authoring/towns/survey")));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${townName}.json`), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(outDir, `${townName}.png`), png(W, W, img));

console.log(`${townName} (${town.id}, ${town.tier}) — site ${site}; relief ${report.ground.reliefM} m, flat ${report.ground.flatPct}%, steep ${report.ground.steepPct}%, cliff ${report.ground.cliffPct}%, water ${report.ground.waterPct}%; biome ${biome.id}`);
for (const w of roadWalks) console.log(`  road ${w.id.padEnd(26)} ${String(w.metres).padStart(4)} m in survey, max grade ${w.maxGradePct}%, max cross ${w.maxCrossPct}%, ${w.overComfort} m over ${COMFORT_DEG}°, ${w.blocked.length} blocked, min width ${w.minWidth} m`);
for (const a of anchorResults) console.log(`  ${a.reachedFrom.length ? "ok  " : "FAIL"} ${a.kind.padEnd(22)} ${a.id.padEnd(22)} y ${String(a.y).padStart(5)}  ${a.reachedFrom.join(", ") || "unreachable"}`);
console.log(`wrote ${path.relative(process.cwd(), outDir)}/${townName}.{json,png} (${report.ms} ms)`);
if (failures.length) {
  console.log(`SURVEY FAILED (${failures.length}):`);
  for (const f of failures) console.log(`  ! ${f}`);
  process.exit(1);
}
console.log("SURVEY OK");
