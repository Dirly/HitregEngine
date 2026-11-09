/**
 * SETTLEMENT GRAMMAR — lay out a place where people LIVE (a frogkin isle village, a CrocKin stilt village, an ogre
 * camp, a giant steading) from a culture profile and a few numbers, instead of scattering props into discs.
 *
 * The grammar (the Totem Isles, the best place so far): households on the best ground the culture wants, spaced by the
 * terrain, ALL facing one gathering place, each household a small area holding its dwelling + its kit (storage, light,
 * work, sleeping), work where the work belongs (the water's edge, downwind, at the resource), one connected way of
 * travelling between them (carved tracks, fords, walkways), cover cleared under every dwelling / fire / yard, and creature
 * groups where the people are.
 *
 * Steps (`planSettlement`): survey the ground (dry pads, water at kit depth, slope) → the gathering spot → cluster
 * centres → households (dwelling + kit) → work areas → defences → paths (one graph from the approach to everything) →
 * clearings → creature spots. Stilt cultures (`ground: "stilt"`) lay a 4 m village GRID instead (`layoutStiltGrid`):
 * a communal deck, one block per cluster (the caller fills each with a seeded, pinned WFC solve), corridor runs joining
 * them, work decks, landings and a link to dry land. `checkSettlement` is the gate (households complete, spacing,
 * doors facing, reach, cover cleared, creature spots, tier). Pure and headless: the caller samples the ground
 * (tools/settle.mts uses the world field).
 */
import { z } from "zod";
import { defaultLooseBudget, defaultMinItems } from "./resolve.js";
import { RIBBONS_REMOVED } from "../voxel/operator-registry.js";

type V2 = [number, number];

// ---------------------------------------------------------------------------------------------------------- profile

const ids = z.array(z.string().min(1)).min(1);
export const SETTLE_UNIT_ROLES = ["storage", "light", "work", "sleeping", "shrine", "boat", "marker", "seat", "other"] as const;
export const SETTLE_UNIT_PLACES = ["door", "side", "back", "yard", "water-edge"] as const;

const unitSchema = z.object({
  role: z.enum(SETTLE_UNIT_ROLES).describe("What the item is FOR in the household; `settle check` requires every required role."),
  props: ids.describe("Catalogued prefab ids, picked in turn by household (variety without randomness)."),
  count: z.number().int().min(1).max(8).default(1),
  place: z.enum(SETTLE_UNIT_PLACES).default("side").describe("Where it stands in the dwelling's frame: beside the door, at a side, behind, in the front yard, or at the nearest water edge (traps, boats)."),
  required: z.boolean().default(true),
  faceGathering: z.boolean().default(false).describe("Turn it to face the gathering spot (boats point at the centre)."),
}).strict();

const wfcDwellingSchema = z.object({
  kind: z.literal("wfc"),
  project: z.string().min(1).describe("Project holding the kit's tileset (assets/wfc/<kit>.tileset.json)."),
  kit: z.string().min(1),
  cell: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).describe("Kit cell size, metres."),
  hutTiles: z.string().min(1).describe("RegExp over tile ids: the 1x1 dwelling tiles a cluster solve pins (one per household)."),
  walkwayWeight: z.number().min(0).default(0.05).describe("Multiplier on the kit's narrow walkway tiles inside a cluster solve (they are below the 2.4 m walkway rule)."),
  block: z.tuple([z.number().int().min(3), z.number().int().min(3)]).default([5, 5]).describe("Cells per cluster solve (x, z)."),
  deckOverWater: z.number().default(1.5).describe("Deck height above the local water (the kit's water contract)."),
  depth: z.tuple([z.number(), z.number()]).default([0.2, 3]).describe("Water depth range the posts may stand in, metres."),
  communal: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([3, 3]).describe("Communal deck size in cells."),
  landings: z.number().int().min(0).default(3),
  frames: z.array(z.string().min(1)).default([]).describe("Kit work-frame parts a family compound stands on a free back-row deck cell (egg-net frame, hide frame)."),
  raise: z.number().min(0).max(2).default(1).describe("Height a raised compound stands above the village deck, metres: the kit's deck-ramp drop."),
  stops: z.number().int().min(0).max(12).default(2).describe("In-between platforms on the walkway network besides the work decks (a drying frame, a boat landing down a ramp): walking between homes passes things."),
  walkways: z.object({ main: z.string().min(1).default("floor-walkway-wide"), branch: z.string().min(1).default("floor-walkway"), mainWidth: z.number().positive().default(2.6), branchWidth: z.number().positive().default(1.6) }).strict().default({ main: "floor-walkway-wide", branch: "floor-walkway", mainWidth: 2.6, branchWidth: 1.6 }).describe("Kit walkway parts (each with its own '-hub' part) and their plank widths: the spine (bank -> communal deck -> busy branches) is main, a branch to one or two compounds is narrow."),
  watch: z.string().min(1).optional().describe("Kit part (a whole deck cell) for the lookout: stood on a free corner deck of the first raised compound, the village's highest point."),
  levels: z.object({
    rise: z.number().positive().default(1.5).describe("Metres between walk levels: the kit's stair flight."),
    core: z.array(z.number().int().min(0).max(3)).min(1).default([1, 2, 0, 2, 1, 0]).describe("Level (in rises above the village deck) each core compound tries, in placement order (cycled); a compound above the first level must stand its stair on a deck one level below, else it drops a level."),
    fringe: z.array(z.number().int().min(0).max(3)).min(1).default([0, 0, 1]),
    floors: z.array(z.string().min(1)).min(1).describe("Kit deck parts of every height: per walk level the composer takes the one whose top (read from the kit geometry) is nearest the level while its posts still end 0.5 m under the water, set down so its top meets the level: tall decks stand on long braced posts."),
    stairs: z.array(z.object({ part: z.string().min(1), lo: z.number() }).strict()).min(1).describe("Kit stair flights (`lo` = the low end's height in the part): a flight from level k is the part that keeps its posts deepest in the water when set to start at k * rise."),
    landings: z.array(z.object({ part: z.string().min(1), ladder: z.string().min(1), ladderTop: z.number().describe("Height in the ladder part where it meets the deck lip.") }).strict()).default([]).describe("Per-hut boat docks: notched landing deck parts of any height, each with its ladder down into the water; the composer picks one per level as for floors."),
    terrace: z.object({ hatch: z.string().min(1), stack: z.string().min(1), ladder: z.string().min(1), every: z.number().int().min(2).default(3), stackEvery: z.number().int().min(2).default(5) }).strict().optional().describe("Two-storey huts on the village deck: every `every`-th base-level hut carries a roof terrace (hatch + inside ladder, no roof), every `stackEvery`-th an upper room (stack slab + ladder, the hut's walls again one storey up under its roof)."),
  }).strict().optional().describe("Multi-level village: compounds stacked in walk levels joined by stairs (a level-1 compound steps down to the village deck or onto a walkway, a higher one onto a deck one level below), tall decks on long braced posts, two-storey huts with roof terraces, a dock per hut."),
  hearth: z.string().min(1).optional().describe("Kit part with its own fire pan laid at the communal deck's centre (the gathering hearth): the gathering's centre props are not placed on it, the composer lights the pan with the first centre prop's flame and light instead."),
}).strict();

const prefabDwellingSchema = z.object({
  kind: z.literal("prefab"),
  props: ids.describe("Catalogued dwelling prefabs, picked in turn by household."),
  footprint: z.tuple([z.number().positive(), z.number().positive()]).describe("Width x depth of the dwelling, metres (front = local +Z = the door)."),
}).strict();

export const settlementCultureSchema = z.object({
  id: z.string().min(1),
  describe: z.string().default(""),
  scale: z.string().min(1).describe("The catalogue scale class its props are made for (dressing plan `space.scale`)."),
  cultures: z.array(z.string().min(1)).min(1).describe("Catalogue culture tags (dressing plan `space.cultures`)."),
  ground: z.enum(["hummock", "bank", "ledge", "flat", "stilt"]).describe("Preferred ground: the highest isles, a river/lake bank, a sheltered ledge, any flat table, or open water at kit depth (stilts)."),
  maxSlope: z.number().min(0).max(45).default(12).describe("Degrees: steepest ground a dwelling or yard may stand on."),
  minPadArea: z.number().min(0).default(0).describe("m²: dry pads smaller than this are skipped (the Totem Isles skipped isles under 350 m²)."),
  onePerPad: z.boolean().default(false).describe("One household per dry pad (isle villages): water between every home."),
  householdSpacing: z.tuple([z.number().min(0), z.number().min(0)]).describe("Metres between dwellings of one cluster (or between households when onePerPad)."),
  clusterSpacing: z.tuple([z.number().min(0), z.number().min(0)]).describe("Metres between cluster centres (and from the gathering spot)."),
  core: z.object({ share: z.number().min(0).max(1).default(0.6), radius: z.number().positive().default(60) }).strict().default({ share: 0.6, radius: 60 }).describe("A village has a core and a fringe: this share of the households live within `radius` m of the gathering spot, the rest on outlying spots (clustered and stilt villages; one-per-pad isles keep their isles)."),
  dwelling: z.discriminatedUnion("kind", [prefabDwellingSchema, wfcDwellingSchema]),
  household: z.array(unitSchema).describe("The kit every household carries besides its dwelling."),
  yardRadius: z.number().positive().default(8).describe("Radius of a household's dressing area round its dwelling."),
  gathering: z.object({
    kind: z.enum(["ring", "hearth", "shrine", "deck"]),
    centre: z.array(z.string()).default([]).describe("Props at the centre (a fire, a brazier); a ring keeps its middle open when empty."),
    ring: z.object({ props: ids, count: z.number().int().min(3).max(16), radius: z.number().positive() }).strict().optional().describe("Props in a circle facing in (totems, standing stones)."),
    head: z.array(z.string()).default([]).describe("The one prop at the ring's head (idol, chief's seat), on the side facing the approach."),
    radius: z.number().positive().default(14),
  }).strict(),
  work: z.array(z.object({
    id: z.string().min(1),
    where: z.enum(["water-edge", "downwind", "resource", "edge", "dry"]).describe("water-edge: dry ground beside water nearest the centre; downwind: down `wind` from the gathering; resource: the caller's anchor `work:<id>`; edge: the rim on the far side from the approach; dry: the best dry pad near the village (a hatchery on sand)."),
    props: ids,
    count: z.number().int().min(1).max(12).default(2),
    radius: z.number().positive().default(8),
    creature: z.boolean().default(true).describe("A creature group works here."),
  }).strict()).default([]),
  paths: z.object({
    kind: z.string().refine((k) => k !== "ribbon", `paths.kind "ribbon": ${RIBBONS_REMOVED}`).pipe(z.enum(["track", "walkway", "ford"]))
      .describe("How the culture travels between homes: trodden TRACKS (carved + painted through `worldgen road` by `settle apply`), deck walkways, or wading fords (water between isles)."),
    width: z.number().positive().default(2.4).describe("Metres; walkways are never narrower than 2.4 (the capsule rule)."),
    style: z.string().default("dirt"),
    maxGrade: z.number().positive().default(0.18),
    maxWade: z.number().min(0).default(0.9).describe("Deepest water a ford may cross, metres."),
  }).strict(),
  defences: z.object({ props: ids, count: z.number().int().min(1).max(20), spacing: z.number().positive().default(4) }).strict().optional().describe("Placed in an arc on the approach side, beyond the outermost homes."),
  creatures: z.object({ perCluster: z.number().int().min(0).default(1), atGathering: z.number().int().min(0).default(1), radius: z.number().positive().default(10) }).strict().default({ perCluster: 1, atGathering: 1, radius: 10 }),
  clear: z.object({ margin: z.number().min(1.5).max(3).default(1.5), doorMargin: z.number().min(1.5).max(6).default(3) }).strict().default({ margin: 1.5, doorMargin: 3 }).describe("Ground cover cleared under every dwelling, fire and yard footprint plus this margin (3 m at doors and fires)."),
  lights: z.string().default("camp").describe("Light bucket for the dressing plans."),
  wind: z.tuple([z.number(), z.number()]).default([1, 0]).describe("Prevailing wind direction (where smoke and smells blow): downwind work goes this way."),
}).strict().describe("A culture's settlement grammar: authoring/settlement/cultures/<id>.json in the project that owns the culture.");
export type SettlementCulture = z.infer<typeof settlementCultureSchema>;
export type SettlementCultureIn = z.input<typeof settlementCultureSchema>;

// ---------------------------------------------------------------------------------------------------------- input

export interface SettleGround {
  height(x: number, z: number): number;
  /** Water surface y, or null when dry. */
  water(x: number, z: number): number | null;
  /** True where something installed already stands (a structure, a road you must not build on). */
  blocked?(x: number, z: number): boolean;
}
export interface SettleTier { id: string; minCreatureGroups: number; footprintDiameterM: { min: number; max: number } }
export interface SettleInput {
  id: string;
  culture: SettlementCultureIn;
  households: number;
  clusters?: number;
  wealth?: "poor" | "modest" | "comfortable" | "rich";
  centre: V2;
  radius: number;
  seed?: number;
  /** Pinned spots: `gather`, `approach`, `work:<id>`. */
  anchors?: Record<string, V2>;
  tier?: SettleTier;
  step?: number;
  /** The catalogue's word on a prop (its `dressing`): footprint size, the rooms it furnishes, its setting and mount. With
   *  it the planner keeps every footprint on dry open ground (or deck), off its own lanes, and names area roles the props
   *  declare. */
  props?: (id: string) => SettlePropInfo | undefined;
}
export interface SettlePropInfo { size: [number, number, number]; rooms?: string[]; setting?: string; mount?: string; solid?: boolean; /** A loose floor container (counts against an area's floor-clutter budget). */ loose?: boolean }

/** Metres between an area's outermost footprint and its rim: the rim's entry band (0.6) + the comfortable doorway buffer (1.1). */
export const AREA_RIM = 1.75;
/** Share of an area's disc a site map measures as open floor (paths, walls, water and drops take the rest), for sizing estimates. */
const OPEN_SHARE = 0.8;

// ---------------------------------------------------------------------------------------------------------- output

export interface SettleItem { id: string; role: string; prop: string; at: V2; yaw: number }
export interface SettleHousehold {
  id: string; cluster: string; pad: number;
  dwelling: { prop?: string; at: V2; yaw: number; footprint: V2; door: V2; tile?: string; cell?: V2 };
  items: SettleItem[];
  ground: number; water: number | null;
}
/** A creature group's standing spot is kept clear this far (its pack spreads from it over the open floor round it). */
const CREATURE_KEEP = 0.9;
const ROLES = ["camp", "shore", "yard", "ruin", "path"] as const;
export interface SettleArea { id: string; role: (typeof ROLES)[number]; also?: string[]; centre: V2; radius: number; kind: "household" | "gathering" | "work" | "defence"; ref: string; surface?: "built"; floorY?: number; items: SettleItem[]; required: string[] }
export interface SettlePath { id: string; kind: "track" | "ford" | "walkway" | "raft"; from: string; to: string; points: V2[]; width: number; maxDepth: number }
export interface SettleClearing { id: string; center: V2; radius: number; why: string }
export interface SettleCreatureSpot { id: string; at: V2; radius: number; why: string }
export interface SettleFinding { code: string; message: string; ref?: string }
export interface SettlePad { id: number; cells: number; area: number; centroid: V2; top: V2; topY: number; overWater: number }
export interface SettleSurvey { step: number; cells: number; dry: number; wet: number; waterLevel: number | null; pads: SettlePad[]; origin: V2; columns: number; rows: number; kinds: string }
export interface SettlementPlan {
  id: string; culture: string; centre: V2; radius: number; seed: number;
  gathering: { at: V2; facing: V2; items: SettleItem[]; radius: number };
  approach: V2;
  clusters: { id: string; centre: V2; households: string[] }[];
  households: SettleHousehold[];
  work: { id: string; at: V2; items: SettleItem[]; radius: number }[];
  defences: SettleItem[];
  paths: SettlePath[];
  clearings: SettleClearing[];
  creatures: SettleCreatureSpot[];
  areas: SettleArea[];
  stilt?: StiltGrid;
  survey: SettleSurvey;
  warnings: SettleFinding[];
}

// ---------------------------------------------------------------------------------------------------------- helpers

const d2 = (a: V2, b: V2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r2 = (v: number): number => Math.round(v * 100) / 100;
const p2 = (p: V2): V2 => [r2(p[0]), r2(p[1])];
const norm = (v: V2): V2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
/** Degrees about +Y that turn a prop's front (local +Z) to face `dir` (the dressing plan's `yaw`). */
export const yawToward = (dir: V2): number => Math.round((Math.atan2(dir[0], dir[1]) * 180) / Math.PI);
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------------------------------------- survey

interface Grid { step: number; origin: V2; cols: number; rows: number; h: Float64Array; w: Float64Array; slope: Float64Array; kind: Uint8Array; pad: Int32Array }
// kind: 0 outside the disc, 1 dry, 2 wet, 3 blocked
const OUT = 0, DRY = 1, WET = 2, BLOCKED = 3;

function surveyGrid(g: SettleGround, centre: V2, radius: number, step: number): Grid {
  const cols = Math.ceil((2 * radius) / step) + 1, rows = cols, origin: V2 = [centre[0] - radius, centre[1] - radius];
  const n = cols * rows, h = new Float64Array(n), w = new Float64Array(n).fill(NaN), slope = new Float64Array(n), kind = new Uint8Array(n), pad = new Int32Array(n).fill(-1);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, x = origin[0] + i * step, z = origin[1] + j * step;
    h[k] = g.height(x, z);
    if (Math.hypot(x - centre[0], z - centre[1]) > radius) continue;
    const wy = g.water(x, z);
    if (wy != null) w[k] = wy;
    kind[k] = g.blocked?.(x, z) ? BLOCKED : wy != null && wy > h[k]! + 0.05 ? WET : DRY;
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, ix = Math.min(cols - 1, i + 1), jx = Math.min(rows - 1, j + 1), i0 = Math.max(0, i - 1), j0 = Math.max(0, j - 1);
    const gx = (h[j * cols + ix]! - h[j * cols + i0]!) / ((ix - i0) * step || 1), gz = (h[jx * cols + i]! - h[j0 * cols + i]!) / ((jx - j0) * step || 1);
    slope[k] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
  }
  return { step, origin, cols, rows, h, w, slope, kind, pad };
}
const cellAt = (G: Grid, p: V2): number => { const i = Math.round((p[0] - G.origin[0]) / G.step), j = Math.round((p[1] - G.origin[1]) / G.step); return i < 0 || j < 0 || i >= G.cols || j >= G.rows ? -1 : j * G.cols + i; };
const posOf = (G: Grid, k: number): V2 => [G.origin[0] + (k % G.cols) * G.step, G.origin[1] + Math.floor(k / G.cols) * G.step];

function findPads(G: Grid): SettlePad[] {
  const pads: SettlePad[] = [];
  for (let k0 = 0; k0 < G.kind.length; k0++) {
    if (G.kind[k0] !== DRY || G.pad[k0]! >= 0) continue;
    const id = pads.length, stack = [k0], cells: number[] = [];
    G.pad[k0] = id;
    while (stack.length) {
      const k = stack.pop()!; cells.push(k);
      const i = k % G.cols, j = Math.floor(k / G.cols);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= G.cols || b >= G.rows) continue;
        const q = b * G.cols + a; if (G.kind[q] === DRY && G.pad[q]! < 0) { G.pad[q] = id; stack.push(q); }
      }
    }
    let sx = 0, sz = 0, top = cells[0]!, wsum = 0, wn = 0;
    for (const k of cells) { const p = posOf(G, k); sx += p[0]; sz += p[1]; if (G.h[k]! > G.h[top]! && G.slope[k]! < 10) top = k; if (!Number.isNaN(G.w[k]!)) { wsum += G.w[k]!; wn++; } }
    const topY = G.h[top]!;
    pads.push({ id, cells: cells.length, area: cells.length * G.step * G.step, centroid: p2([sx / cells.length, sz / cells.length]), top: p2(posOf(G, top)), topY: r2(topY), overWater: wn ? r2(topY - wsum / wn) : 0 });
  }
  return pads;
}

/** Is a disc of radius r round p all dry, unblocked, inside the survey and no steeper than maxSlope? */
function fits(G: Grid, p: V2, r: number, maxSlope: number, want: number = DRY): boolean {
  const n = Math.ceil(r / G.step);
  for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
    if (Math.hypot(di, dj) * G.step > r) continue;
    const k = cellAt(G, [p[0] + di * G.step, p[1] + dj * G.step]);
    if (k < 0 || G.kind[k] !== want) return false;
    if (want === DRY && G.slope[k]! > maxSlope) return false;
  }
  return true;
}
/** Share of dry cells in a disc. */
function dryShare(G: Grid, p: V2, r: number): number { let n = 0, d = 0; const m = Math.ceil(r / G.step); for (let dj = -m; dj <= m; dj++) for (let di = -m; di <= m; di++) { if (Math.hypot(di, dj) * G.step > r) continue; const k = cellAt(G, [p[0] + di * G.step, p[1] + dj * G.step]); n++; if (k >= 0 && G.kind[k] === DRY) d++; } return n ? d / n : 0; }
/** Nearest dry cell that touches water, from p, within maxR. */
function waterEdge(G: Grid, p: V2, maxR: number, pad?: number): V2 | null {
  let best: V2 | null = null, bd = Infinity;
  const n = Math.ceil(maxR / G.step), c = cellAt(G, p);
  if (c < 0) return null;
  const ci = c % G.cols, cj = Math.floor(c / G.cols);
  for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) {
    const i = ci + di, j = cj + dj; if (i < 1 || j < 1 || i >= G.cols - 1 || j >= G.rows - 1) continue;
    const k = j * G.cols + i; if (G.kind[k] !== DRY || (pad !== undefined && G.pad[k] !== pad)) continue;
    if (![k + 1, k - 1, k + G.cols, k - G.cols].some((q) => G.kind[q] === WET)) continue;
    const d = Math.hypot(di, dj) * G.step; if (d < bd && d <= maxR) { bd = d; best = posOf(G, k); }
  }
  return best;
}

function kindsText(G: Grid): string {
  const ch = [" ", ".", "~", "#"];
  const rows: string[] = [];
  for (let j = G.rows - 1; j >= 0; j--) { let s = ""; for (let i = 0; i < G.cols; i++) s += ch[G.kind[j * G.cols + i]!]; rows.push(s); }
  return rows.join("\n");
}

export function surveySettlement(g: SettleGround, centre: V2, radius: number, step = 2): { grid: Grid; survey: SettleSurvey } {
  const G = surveyGrid(g, centre, radius, step);
  const pads = findPads(G);
  let dry = 0, wet = 0; const hist = new Map<number, number>();
  for (let k = 0; k < G.kind.length; k++) { if (G.kind[k] === DRY) dry++; if (G.kind[k] === WET) { wet++; const b = Math.round(G.w[k]! * 10) / 10; hist.set(b, (hist.get(b) ?? 0) + 1); } }
  const waterLevel = hist.size ? [...hist.entries()].sort((a, b) => b[1] - a[1])[0]![0] : null;
  return { grid: G, survey: { step, cells: dry + wet, dry, wet, waterLevel, pads: pads.sort((a, b) => b.area - a.area).slice(0, 60), origin: G.origin, columns: G.cols, rows: G.rows, kinds: kindsText(G) } };
}

// ---------------------------------------------------------------------------------------------------------- kit

/** Household kit round a dwelling: the dwelling faces `facing` (its door side); items stand in its frame. */
export function householdKit(hid: string, culture: SettlementCulture, at: V2, facing: V2, footprint: V2, index: number, edge: (from: V2) => V2 | null, gather: V2): SettleItem[] {
  const f = norm(facing), r: V2 = [f[1], -f[0]], hw = footprint[0] / 2, hd = footprint[1] / 2;
  const out: SettleItem[] = [];
  const side = { door: 0, side: 0, back: 0, yard: 0, "water-edge": 0 } as Record<string, number>;
  const off = (a: number, b: number): V2 => [at[0] + f[0] * a + r[0] * b, at[1] + f[1] * a + r[1] * b];
  for (const u of culture.household) {
    for (let c = 0; c < u.count; c++) {
      const prop = u.props[(index + c) % u.props.length]!;
      const n = side[u.place]!++;
      const alt = n % 2 === 0 ? 1 : -1, step = Math.floor(n / 2);
      let p: V2;
      switch (u.place) {
        case "door": p = off(hd + 1.2, alt * (Math.min(hw, 2.2) + 0.6 + step * 1.4)); break;
        case "side": p = off(-hd * 0.3 + step * 1.6, alt * (hw + 1.3)); break;
        case "back": p = off(-(hd + 1.3), alt * (0.8 + step * 1.6)); break;
        case "yard": p = off(hd + 3.2 + step * 1.6, alt * 2.2); break;
        default: {
          const e = edge(at);
          p = e ? [e[0] + r[0] * alt * (1.4 + step * 2.2), e[1] + r[1] * alt * (1.4 + step * 2.2)] : off(hd + 4.5, alt * (1.5 + step * 2));
        }
      }
      const toward = u.faceGathering ? norm([gather[0] - p[0], gather[1] - p[1]]) : u.place === "back" ? ([-f[0], -f[1]] as V2) : f;
      out.push({ id: `${hid}-${u.role}${u.count > 1 || n ? `-${n + 1}` : ""}`, role: u.role, prop, at: p2(p), yaw: yawToward(toward) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------- stilt grid

export type StiltCellKind = "communal" | "corridor" | "work" | "landing" | "platform" | "hut" | "ramp" | "stair";
/**
 * One 4 m cell of the village deck. `y` is the deck top above `deckY` (a raised compound stands +1 m, reached by a ramp);
 * `face` is a landing's open side or the side a ramp DESCENDS toward; `fit` is a fitting the cell carries (a work frame);
 * `hut` is the household id whose hut stands on a hut cell.
 */
export interface StiltCell { i: number; j: number; kind: StiltCellKind; ref: string; at: V2; ground: number; water: number | null; face?: "px" | "nx" | "pz" | "nz"; y?: number; fit?: string; hut?: string; low?: boolean; open?: ("px" | "nx" | "pz" | "nz")[]; /** a hut's mooring: a ladder down into the water off this side (its rail gated) */ moor?: "px" | "nx" | "pz" | "nz" }
/**
 * A walkway between two deck nodes (the communal deck, a compound, a stop platform, the bank): a free-angle polyline of
 * plank pieces on posts, from one node's port (a deck edge, its rail left open) to the other's, `width` m wide (the spine
 * wide, branches narrow). `ramp`: the last point is the top of a ramp running on 4 m down onto the bank.
 */
export interface StiltWalk { id: string; from: string; to: string; points: V2[]; width: number; main: boolean; ramp?: boolean }
export interface StiltHut { cell: [number, number]; door: "px" | "nx" | "pz" | "nz"; size: "1x1" | "2x2"; cells: [number, number][]; porch: [number, number]; turn: number; /** a two-storey hut: a roof terrace (hatch, no roof) or an upper room */ top?: "terrace" | "room"; /** its boat dock (a landing cell at its level, ladder into the water) */ dock?: [number, number] }
/** A family compound: platforms of 2x2 to 4x3 cells with huts on their back rows, a work frame, a boat landing. */
export interface StiltBlock { id: string; i0: number; j0: number; w: number; d: number; centre: V2; y: number; turn: number; huts: StiltHut[]; cells: [number, number][] }
export interface StiltGrid { origin: V2; cell: number; deckY: number; water: number; cols: number; rows: number; blocks: StiltBlock[]; cells: StiltCell[]; dryLink: V2 | null; walks: StiltWalk[]; /** metres a stair flight climbs (levels.rise) */ rise?: number; /** metres a ramp drops (raise) */ raise?: number; /** bare deck cells trimmed away (trimStiltDecks) */ trimmed?: number }

const FACES = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] } as const;
type Face = keyof typeof FACES;
const FACE_DEG: Record<Face, number> = { pz: 0, px: 90, nz: 180, nx: 270 };
const faceOfDeg = (deg: number): Face => (["pz", "px", "nz", "nx"] as const)[(((Math.round(deg / 90) % 4) + 4) % 4)]!;
const faceOf = (di: number, dj: number): Face => (Math.abs(di) >= Math.abs(dj) ? (di >= 0 ? "px" : "nx") : dj >= 0 ? "pz" : "nz");
/** Quarter turns: +90° maps +Z to +X (the yaw convention of `yawToward`). */
const turnIJ = (i: number, j: number, q: number): [number, number] => { let a = i, b = j; for (let n = 0; n < ((q % 4) + 4) % 4; n++) [a, b] = [b, -a]; return [a, b]; };
const turnFace = (f: Face, q: number): Face => faceOfDeg(FACE_DEG[f] + 90 * q);


/** 4-connected shortest run of cells from any of `from` to any of `to` through `free` cells (straight runs preferred). */
export function routeCells(cols: number, rows: number, free: (i: number, j: number) => boolean, from: [number, number][], to: (i: number, j: number) => boolean): [number, number][] | null {
  const key = (i: number, j: number): number => j * cols + i;
  const prev = new Map<number, number>(), dir = new Map<number, number>();
  let queue: [number, number][] = [];
  for (const [i, j] of from) { prev.set(key(i, j), -1); dir.set(key(i, j), -1); queue.push([i, j]); }
  const D = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  while (queue.length) {
    const next: [number, number][] = [];
    for (const [i, j] of queue) {
      const kd = dir.get(key(i, j))!;
      const order = kd >= 0 ? [kd, ...[0, 1, 2, 3].filter((x) => x !== kd)] : [0, 1, 2, 3];
      for (const o of order) {
        const a = i + D[o]![0], b = j + D[o]![1];
        if (a < 0 || b < 0 || a >= cols || b >= rows || prev.has(key(a, b))) continue;
        if (to(a, b)) {
          const path: [number, number][] = [];
          let k = key(i, j);
          while (k >= 0) { path.push([k % cols, Math.floor(k / cols)]); k = prev.get(k)!; }
          path.reverse();
          return [...path.slice(from.some(([x, y]) => x === path[0]![0] && y === path[0]![1]) ? 1 : 0), [a, b]];
        }
        if (!free(a, b)) continue;
        prev.set(key(a, b), key(i, j)); dir.set(key(a, b), o); next.push([a, b]);
      }
    }
    queue = next;
  }
  return null;
}

interface LocalCompound { cells: Map<string, { kind: "platform" | "hut"; fit?: string; hut?: number }>; huts: { cells: [number, number][]; door: [number, number]; size: "1x1" | "2x2" }[]; landing: { cells: [number, number][]; face: Face } | null; front: [number, number][] }
const KEY = (i: number, j: number): string => `${i},${j}`;
/**
 * A family compound in its own frame (front = -Z, toward the gathering spot): a main platform 3-4 x 2-3 cells with huts
 * on its back row (a 2x2 big hut first when `big`), a work frame on a free back-row cell, side platforms of 2 x 2-3
 * cells set back 0-1 rows for the rest, a boat landing off a front corner. Every hut door faces -Z onto a deck cell.
 */
/** A compound's open platform cells (no fitting) all still joined edge to edge without `skip`. */
function deckLinked(cells: Map<string, { kind: StiltCellKind; fit?: string }>, skip: string): boolean {
  const ps = new Set([...cells].filter(([k, c]) => c.kind === "platform" && !c.fit && k !== skip).map(([k]) => k));
  if (ps.size <= 1) return true;
  const first = ps.values().next().value as string, seen = new Set([first]), q = [first];
  while (q.length) { const [i, j] = q.pop()!.split(",").map(Number) as [number, number]; for (const [di, dj] of Object.values(FACES)) { const k = KEY(i + di, j + dj); if (ps.has(k) && !seen.has(k)) { seen.add(k); q.push(k); } } }
  return seen.size === ps.size;
}

function compoundLocal(n: number, big: boolean, frames: string[], rnd: () => number): LocalCompound {
  const cells: LocalCompound["cells"] = new Map(), huts: LocalCompound["huts"] = [];
  const plat = (i0: number, j0: number, w: number, d: number): void => { for (let j = j0; j < j0 + d; j++) for (let i = i0; i < i0 + w; i++) cells.set(KEY(i, j), { kind: "platform" }); };
  // one hut: a 2x2 platform; two: 3 x 2 (the huts and the frame on the back row, a porch row in front), or `big` 3 x 3 (a
  // 2x2 big hut and a 1x1 beside it, both porches on the front row, the frame behind the 1x1: roofs, not planks); three: a big hut on 4 x 3,
  // else 3-4 x 2 with a side platform (a deck as big as the life on it: no plank plaza)
  const w0 = n <= 1 ? 2 : big ? (n === 2 ? 3 : 4) : n === 2 ? 3 : 3 + (rnd() < 0.5 ? 1 : 0), d0 = n <= 1 ? 2 : big ? 3 : 2;
  plat(0, 0, w0, d0);
  let left = n, bi = 0;
  const hut1 = (i: number, j: number): void => { cells.set(KEY(i, j), { kind: "hut", hut: huts.length }); huts.push({ cells: [[i, j]], door: [i, j], size: "1x1" }); left--; };
  if (big && left > 0) {
    const hc: [number, number][] = [[0, d0 - 2], [1, d0 - 2], [0, d0 - 1], [1, d0 - 1]];
    for (const [i, j] of hc) cells.set(KEY(i, j), { kind: "hut", hut: huts.length });
    huts.push({ cells: hc, door: [0, d0 - 2], size: "2x2" }); left--; bi = 2;
  }
  // 1x1 huts side by side along the back row from the far end (wall to wall, 4 m apart), one back cell kept for the frame
  const slots: number[] = [];
  for (let i = w0 - 1; i >= bi; i--) slots.push(i);
  const onMain = Math.min(left, Math.max(1, w0 - bi - 1));
  // (a big two-hut compound: the 1x1 a row forward, its porch on the front row beside the big hut's, the frame behind it)
  if (big && n === 2 && left === 1) hut1(w0 - 1, d0 - 2);
  else for (const i of slots.slice(0, onMain)) hut1(i, d0 - 1);
  const sides: number[] = [];
  for (const side of rnd() < 0.5 ? [1, -1] : [-1, 1]) {
    if (left <= 0) break;
    const w1 = 2, d1 = 2, j0 = rnd() < 0.5 ? 0 : 1, i0 = side > 0 ? w0 : -w1;
    plat(i0, j0, w1, d1); sides.push(side);
    const k = Math.min(left, 2);
    for (let h = 0; h < k; h++) hut1(side > 0 ? i0 + w1 - 1 - h : i0 + h, j0 + d1 - 1);
  }
  // the work frame on a free back-row cell whose deck the rest of the compound does not walk through (a side platform
  // touching the main one only there keeps it)
  const workCell = [...Array(w0).keys()].map((i) => KEY(i, d0 - 1)).find((k) => cells.get(k)?.kind === "platform" && deckLinked(cells, k));
  if (workCell && frames.length) cells.get(workCell)!.fit = frames[Math.floor(rnd() * frames.length)]!;
  // the boat landing: off a front corner on a side with no side platform (else straight out of the front)
  const ls = !sides.includes(-1) ? { at: [-1, 0] as [number, number], f: "nx" as Face } : !sides.includes(1) ? { at: [w0, 0] as [number, number], f: "px" as Face } : { at: [0, -1] as [number, number], f: "nz" as Face };
  const v = FACES[ls.f];
  const landing = { cells: [ls.at, [ls.at[0] + v[0], ls.at[1] + v[1]] as [number, number]], face: ls.f };
  const front = [...cells.entries()].filter(([, c]) => c.kind === "platform").map(([k]) => k.split(",").map(Number) as [number, number]).filter(([i, j]) => !cells.has(KEY(i, j - 1)));
  return { cells, huts, landing, front };
}

/** Split a village's households into family compounds of 1-3 huts (the chief's compound first, three huts when it can). */
export function compoundSizes(households: number, rnd: () => number): number[] {
  const out: number[] = [];
  let left = Math.max(1, households);
  while (left > 0) {
    const r = rnd(), n = out.length === 0 ? 3 : r < 0.25 ? 1 : r < 0.65 ? 2 : 3;
    out.push(Math.min(n, left)); left -= Math.min(n, left);
  }
  return out;
}

/** Simplest path through `ok` points: from each kept point, the farthest later point a straight segment reaches. */
function pullString(pts: V2[], clear: (a: V2, b: V2) => boolean): V2[] {
  if (pts.length <= 2) return pts;
  const out: V2[] = [pts[0]!];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !clear(pts[i]!, pts[j]!)) j--;
    out.push(pts[j]!); i = j;
  }
  return out;
}

const segDist2 = (p: V2, a: V2, b: V2): number => { const dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz); };

/**
 * The stilt village: a communal deck at the gathering spot; family compounds of 1-3 huts, the core share of the
 * households packed round the communal deck (within `culture.core.radius`), the rest on outlying spots (by hummocks and
 * shallows, spread round); stop platforms (the work decks, a drying frame, a boat landing) on the long legs; then ONE
 * walkway network: a minimum spanning tree over the decks plus a loop or two where the tree detours, each leg routed
 * through shallow water round every deck and pulled straight with a gentle bend, the spine (bank -> communal -> busy
 * branches) wide and the branches narrow; a walkway to the bank ending in a ramp down onto it; boat landings.
 */
function layoutStiltGrid(G: Grid, culture: SettlementCulture, wf: z.infer<typeof wfcDwellingSchema>, input: SettleInput, gather: V2, approach: V2, sizes: number[], warn: SettleFinding[], rnd: () => number): StiltGrid {
  const cell = wf.cell[0], half = cell / 2;
  const LV = wf.levels, rise = LV ? LV.rise : wf.raise, perHutDocks = !!LV?.landings.length;
  // a deck's way up or down along its slope: a ramp (one raise) or a stair flight (one level)
  const climb = (t: StiltCell | undefined): boolean => !!t && (t.kind === "ramp" || t.kind === "stair");
  const water = G.w.reduce((acc, v, k) => (G.kind[k] === WET ? acc.concat(v) : acc), [] as number[]);
  const hist = new Map<number, number>(); for (const v of water) { const b = Math.round(v * 10) / 10; hist.set(b, (hist.get(b) ?? 0) + 1); }
  const level = hist.size ? [...hist.entries()].sort((a, b) => b[1] - a[1])[0]![0] : 0;
  const deckY = r2(level + wf.deckOverWater);
  const cols = Math.floor((2 * input.radius) / cell), rows = cols;
  const origin: V2 = [gather[0] - Math.floor(cols / 2) * cell, gather[1] - Math.floor(rows / 2) * cell];
  const centreOf = (i: number, j: number): V2 => [origin[0] + i * cell, origin[1] + j * cell];
  const inGrid = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < cols && j < rows;
  const key = (i: number, j: number): number => j * cols + i;
  // a grid cell stands in water at kit depth: every sample under its 4 m square is wet at the village level
  const ok = new Map<number, boolean>(), gnd = (p: V2): number => G.h[Math.max(0, cellAt(G, p))]!;
  const wetOk = (i: number, j: number): boolean => {
    if (!inGrid(i, j)) return false;
    const k0 = key(i, j); if (ok.has(k0)) return ok.get(k0)!;
    const c = centreOf(i, j); let good = true;
    for (const [dx, dz] of [[0, 0], [-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]] as const) {
      const k = cellAt(G, [c[0] + dx, c[1] + dz]);
      if (k < 0 || G.kind[k] !== WET) { good = false; break; }
      const depth = G.w[k]! - G.h[k]!;
      if (Math.abs(G.w[k]! - level) > 0.35 || depth < wf.depth[0] || depth > wf.depth[1]) { good = false; break; }
    }
    ok.set(k0, good); return good;
  };
  const taken = new Map<number, StiltCell>();
  const put = (i: number, j: number, kind: StiltCellKind, ref: string, extra: Partial<StiltCell> = {}): void => { const c = centreOf(i, j); taken.set(key(i, j), { i, j, kind, ref, at: p2(c), ground: r2(gnd(c)), water: level, ...extra }); };
  // a deck footprint keeps one free cell of water round it (the walkways run there)
  const reserved = new Set<number>(); // the water a raised compound's ramp comes down into
  // the core packs its decks edge to edge (compounds share decks, porches meet); the fringe keeps a ring of water. Boat
  // ramps and landings always keep their water.
  const roomFor = (cs: [number, number][], packed = false): boolean => cs.every(([i, j]) => {
    if (!wetOk(i, j) || reserved.has(key(i, j)) || taken.has(key(i, j))) return false;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const t = taken.get(key(i + di, j + dj)); if (!inGrid(i + di, j + dj)) return false; if (t && (!packed || t.kind === "landing" || t.kind === "ramp")) return false; }
    return true;
  });
  // a deck cell one walks on at its level (no hut, frame, lookout or ramp)
  const walkable = (t: StiltCell | undefined): t is StiltCell => !!t && (t.kind === "communal" || t.kind === "work" || (t.kind === "platform" && !t.fit));
  const gi = Math.floor(cols / 2), gj = Math.floor(rows / 2);
  const [cw, cd] = wf.communal;
  const ci0 = gi - Math.floor(cw / 2), cj0 = gj - Math.floor(cd / 2);
  const communalCells: [number, number][] = [];
  for (let j = cj0; j < cj0 + cd; j++) for (let i = ci0; i < ci0 + cw; i++) { if (!wetOk(i, j)) warn.push({ code: "stilt-communal-ground", message: `communal deck cell ${i},${j} is not water at kit depth (the gathering spot should stand in open water)` }); put(i, j, "communal", "gathering"); communalCells.push([i, j]); }
  const toward = norm([approach[0] - gather[0], approach[1] - gather[1]]);

  // ---- family compounds: the core first (close round the communal deck), then the fringe (outlying spots, spread round)
  const blocks: StiltBlock[] = [];
  const rampOf = new Map<string, [number, number]>();
  const total = sizes.reduce((a, b) => a + b, 0), coreWant = Math.ceil(total * culture.core.share);
  let coreHH = 0;
  const fringeAng: number[] = [];
  let coreN = 0, fringeN = 0, baseHutN = 0;
  for (let c = 0; c < sizes.length; c++) {
    const want = sizes[c]!; let isCore = coreHH < coreWant;
    let local = compoundLocal(want, (c === 0 && want >= 3) || (want === 2 && rnd() < 0.75), wf.frames, rnd);
    // levels: with `levels`, each compound tries its pattern level (a stair flight per level; above the first it must stand its
    // stair on a deck one level below, else it drops a level); without, every other core compound (never the chief's first)
    // and every third on the fringe stand a ramp higher than the deck they step off
    const want0 = LV ? (isCore ? LV.core[coreN % LV.core.length]! : LV.fringe[fringeN % LV.fringe.length]!) : c === 0 ? 0 : (isCore ? c % 2 === 1 : c % 3 === 2) ? 1 : 0;
    let y = 0;
    let lc = [...local.cells.keys()].map((k) => k.split(",").map(Number) as [number, number]);
    // per-hut docks (levels.landings) replace the compound's boat landing
    let all = [...lc, ...(perHutDocks ? [] : local.landing?.cells ?? [])];
    let porches = new Set(local.huts.map((h) => KEY(h.door[0], h.door[1] - 1)));
    let best: { ai: number; aj: number; q: number; ramp: [number, number] | null } | null = null;
    // (a big two-hut compound that finds no room tries again as the plain 3 x 2; a core compound with no room in the core
    // stands on the fringe)
    for (let attempt = 0; attempt < 3 && !best; attempt++) {
    if (attempt === 2) { if (!isCore) break; isCore = false; }
    if (attempt === 1) { if (!(want === 2 && local.huts.some((h) => h.size === "2x2"))) continue; local = compoundLocal(want, false, wf.frames, rnd); lc = [...local.cells.keys()].map((k) => k.split(",").map(Number) as [number, number]); all = [...lc, ...(perHutDocks ? [] : local.landing?.cells ?? [])]; porches = new Set(local.huts.map((h) => KEY(h.door[0], h.door[1] - 1))); }
    for (const needJoin of isCore ? [true, false] : [false]) for (let lvl = want0; lvl >= 0 && !best; lvl--) {
    y = r2(lvl * rise);
    const below = r2(y - rise);
    for (const relax of isCore ? [1, 1.35, 1.8] : [1, 1.3]) {
      const scored: { ai: number; aj: number; q: number; score: number }[] = [];
      // spots: every grid cell (its front turned to the gathering spot); an upper compound only where a front cell's stair
      // foot lands on a deck one level below (any turn)
      const spots: { ai: number; aj: number; q?: number }[] = [];
      if (lvl < 2) { for (let aj = 0; aj < rows; aj++) for (let ai = 0; ai < cols; ai++) spots.push({ ai, aj }); }
      else {
        const seen = new Set<string>();
        for (const t of taken.values()) if (walkable(t) && (t.y ?? 0) === below) for (let q = 0; q < 4; q++) for (const [li, lj] of local.front) { const [ti, tj] = turnIJ(li, lj - 2, q), k = `${t.i - ti},${t.j - tj},${q}`; if (!seen.has(k)) { seen.add(k); spots.push({ ai: t.i - ti, aj: t.j - tj, q }); } }
      }
      for (const sp of spots) {
        const { ai, aj } = sp, at = centreOf(ai, aj), dist = d2(at, gather);
        if (isCore ? dist > culture.core.radius * relax : dist < culture.core.radius + 10 || dist > (input.radius - 12) * (relax > 1 ? 1 : 0.9)) continue;
        // the compound's front (-Z) turns to the gathering spot
        const q = sp.q ?? (((Math.round((yawToward([gi - ai, gj - aj]) - 180) / 90)) % 4) + 4) % 4;
        // every hut door within 78 degrees of the gathering spot (the door-facing check allows 80)
        { const dv = FACES[turnFace("nz", q)]; if (local.huts.some((h) => { const [ti, tj] = turnIJ(h.door[0], h.door[1], q), c = centreOf(ai + ti, aj + tj), to = norm([gather[0] - c[0], gather[1] - c[1]]); return dv[0] * to[0] + dv[1] * to[1] < Math.cos((78 * Math.PI) / 180); })) continue; }
        const absAll = all.map(([li, lj]) => { const [ti, tj] = turnIJ(li, lj, q); return [ai + ti, aj + tj] as [number, number]; });
        if (!roomFor(absAll, isCore)) continue;
        // how much of it leans on decks already laid (a dense core grows edge to edge)
        const touch = isCore ? absAll.filter(([i, j]) => (Object.values(FACES) as readonly (readonly [number, number])[]).some(([di, dj]) => taken.has(key(i + di, j + dj)))).length : 0;
        // an upper compound leans on the deck one level below (its stair lands there)
        const under = lvl >= 2 && absAll.some(([i, j]) => (Object.values(FACES) as readonly (readonly [number, number])[]).some(([di, dj]) => { const t = taken.get(key(i + di, j + dj)); return walkable(t) && (t.y ?? 0) === below; })) ? 4 : 0;
        const dir = norm([at[0] - gather[0], at[1] - gather[1]]), along = dir[0] * toward[0] + dir[1] * toward[1];
        let score: number;
        // the core packs in close (the approach side kept open); the fringe takes outlying spots by hummocks and shallows,
        // spread round the village
        if (isCore) score = -dist * 0.09 + Math.min(touch, 4) * 0.9 + under - along * 0.5 + rnd() * 0.6;
        else {
          const ang = Math.atan2(dir[1], dir[0]);
          const sep = Math.min(Math.PI, ...fringeAng.map((t) => { let d = Math.abs(t - ang) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; }));
          score = sep * 2 + dryShare(G, at, 18) * 4 - Math.abs(dist - (culture.core.radius + 40)) * 0.03 - along * 0.6 + rnd() * 0.6;
        }
        scored.push({ ai, aj, q, score });
      }
      scored.sort((a, b) => b.score - a.score);
      // a core compound first looks for a spot JOINED to the village floor (a deck touching one at its level, or its stair
      // landing on a deck one level below): the core grows as one walked-over mass of decks, not decks strung on walkways
      // (a walkway threaded through a packed core finds no water and runs the long way round). Only then any spot.
      const failed: { ai: number; aj: number }[] = [];
      let tried = 0;
      for (const s of scored) {
        if (tried >= (needJoin ? 400 : 60)) break;
        if (!needJoin && lvl < 2 && failed.some((f) => Math.abs(f.ai - s.ai) + Math.abs(f.aj - s.aj) <= 2)) continue;
        tried++;
        const abs2 = (li: number, lj: number): [number, number] => { const [ti, tj] = turnIJ(li, lj, s.q); return [s.ai + ti, s.aj + tj]; };
        const mine = new Set(all.map(([li, lj]) => KEY(...abs2(li, lj))));
        const free = (i: number, j: number): boolean => !taken.has(key(i, j)) && wetOk(i, j) && !mine.has(KEY(i, j));
        // a deck-height compound is walked onto off any front platform; a raised one up a ramp off a front cell (no porch
        // first), its foot two cells out
        // ... or steps straight onto a deck it touches: off a front platform onto one at its level, or down its ramp onto one
        // (an upper compound, two levels and more, only onto a deck one level below: no walkway climbs)
        const onto = (p: [number, number], at = 0): boolean => { const t = taken.get(key(...p)); return walkable(t) && (t.y ?? 0) === at; };
        let ramp: [number, number] | null = null, targets: [number, number][] = [], joined = false;
        if (!y) {
          const fr = local.front.map(([li, lj]) => abs2(li, lj - 1));
          // joined: a front platform steps onto a deck at the village level, or any open platform of it touches one side on
          joined = fr.some((p) => onto(p)) || [...local.cells].some(([k, lc]) => { if (lc.kind !== "platform" || lc.fit) return false; const [li, lj] = k.split(",").map(Number) as [number, number], [i, j] = abs2(li, lj); return (Object.values(FACES) as readonly (readonly [number, number])[]).some(([di, dj]) => !mine.has(KEY(i + di, j + dj)) && onto([i + di, j + dj])); });
          targets = fr.filter((p) => free(...p));
        }
        // a stair (or ramp) never stands where another flight comes down (its reserved foot): it lands on a free deck cell or
        // open water straight out of its own front, never sideways onto another flight
        else for (const [li, lj] of [...local.front.filter(([a, b]) => !porches.has(KEY(a, b))), ...local.front.filter(([a, b]) => porches.has(KEY(a, b)))]) { const a = abs2(li, lj - 1), b = abs2(li, lj - 2); if (free(...a) && !reserved.has(key(...a)) && (onto(b, below) || (lvl <= 1 && free(...b)))) { ramp = a; joined = onto(b, below); targets = joined ? [] : [b]; break; } }
        // ... and never boxes in an earlier flight's foot: every reserved foot keeps a free water side its walkway arrives by
        const blocks2 = new Set([...mine, ...(ramp ? [KEY(...ramp)] : [])]);
        const seals = [...reserved].some((r) => { const ri = r % cols, rj = Math.floor(r / cols); if (taken.has(r)) return false; const near = (Object.values(FACES) as readonly (readonly [number, number])[]).map(([di, dj]) => [ri + di, rj + dj] as [number, number]); return near.some(([i, j]) => blocks2.has(KEY(i, j))) && !near.some(([i, j]) => free(i, j) && !blocks2.has(KEY(i, j)) && !reserved.has(key(i, j))); });
        if (seals) continue;
        if (joined) { best = { ai: s.ai, aj: s.aj, q: s.q, ramp }; break; }
        if (needJoin) continue;
        if (!targets.length) { failed.push(s); continue; }
        const T = new Set(targets.map((p) => KEY(...p)));
        const way = routeCells(cols, rows, (i, j) => free(i, j) && !(ramp && i === ramp[0] && j === ramp[1]), [...taken.values()].filter((t) => !isCore || (walkable(t) && !t.y)).map((t) => [t.i, t.j] as [number, number]), (i, j) => T.has(KEY(i, j)) && free(i, j));
        if (!way || way.length > (isCore ? 10 : 70)) { failed.push(s); continue; }
        best = { ai: s.ai, aj: s.aj, q: s.q, ramp }; break;
      }
      if (best) break;
    }
    }
    }
    if (!best) { warn.push({ code: "stilt-no-room", message: `compound ${c + 1} (${want} huts, ${isCore ? "core" : "fringe"}) found no water at kit depth with room and a way in` }); continue; }
    const id = `c${blocks.length + 1}`, { ai, aj, q } = best;
    const abs = (li: number, lj: number): [number, number] => { const [ti, tj] = turnIJ(li, lj, q); return [ai + ti, aj + tj]; };
    const huts: StiltHut[] = local.huts.map((h) => {
      const door = turnFace("nz", q), cellA = abs(h.door[0], h.door[1]), v = FACES[door];
      // two-storey huts on the village deck: every few base-level 1x1 huts a roof terrace, now and then an upper room
      let top: StiltHut["top"];
      if (LV?.terrace && y <= rise && h.size === "1x1") { baseHutN++; top = baseHutN % LV.terrace.stackEvery === 0 ? "room" : baseHutN % LV.terrace.every === 0 ? "terrace" : undefined; }
      return { cell: cellA, door, size: h.size, cells: h.cells.map(([a, b]) => abs(a, b)), porch: [cellA[0] + v[0], cellA[1] + v[1]] as [number, number], turn: q, ...(top ? { top } : {}) };
    });
    if (huts.length < want) warn.push({ code: "stilt-block-huts", message: `compound ${id}: ${huts.length} of ${want} huts` });
    const absCells: [number, number][] = [];
    for (const [k, lcell] of local.cells) {
      const [li, lj] = k.split(",").map(Number) as [number, number], [i, j] = abs(li, lj);
      absCells.push([i, j]);
      put(i, j, lcell.kind, id, { y, ...(lcell.fit ? { fit: lcell.fit, face: turnFace("pz", q) } : {}) });
    }
    if (local.landing && !perHutDocks) {
      const f = turnFace(local.landing.face, q), [a, b] = local.landing.cells.map(([li, lj]) => abs(li, lj)) as [[number, number], [number, number]];
      // a compound at deck height steps down a ramp to a low boat landing; a raised one keeps the ladder notch
      if (y === 0) { put(a[0], a[1], "ramp", id, { face: f, y: 0 }); put(b[0], b[1], "landing", `${id}-boats`, { face: f, y: 0, low: true }); }
      else put(a[0], a[1], "landing", `${id}-boats`, { face: f, y });
    }
    // a raised compound's way up: a ramp descending out of its front toward the walkway
    if (best.ramp) { const f = turnFace("nz", q), v = FACES[f]; put(best.ramp[0], best.ramp[1], LV ? "stair" : "ramp", `in-${id}`, { face: f, y }); rampOf.set(id, best.ramp); if (!taken.has(key(best.ramp[0] + v[0], best.ramp[1] + v[1]))) reserved.add(key(best.ramp[0] + v[0], best.ramp[1] + v[1])); }
    const bi = absCells.map((p) => p[0]), bj = absCells.map((p) => p[1]);
    const i0 = Math.min(...bi), j0 = Math.min(...bj), w = Math.max(...bi) - i0 + 1, d = Math.max(...bj) - j0 + 1;
    const centre = p2(centreOf(i0 + (w - 1) / 2, j0 + (d - 1) / 2));
    blocks.push({ id, i0, j0, w, d, centre, y, turn: q, huts, cells: absCells });
    if (isCore) { coreHH += huts.length; coreN++; } else { fringeN++; fringeAng.push(Math.atan2(centre[1] - gather[1], centre[0] - gather[0])); }
  }

  // ---- the lookout: the first raised compound's free corner deck carries the watch platform
  if (wf.watch) {
    const b = blocks.find((x) => x.y === r2(rise)) ?? blocks.find((x) => x.y);
    const nb = (t: StiltCell): StiltCell[] => (Object.values(FACES) as readonly (readonly [number, number])[]).map(([di, dj]) => taken.get(key(t.i + di, t.j + dj))).filter((x): x is StiltCell => !!x);
    const cutsOf = (x: StiltBlock, t: StiltCell): boolean => !deckLinked(new Map(x.cells.map(([i, j]) => taken.get(key(i, j))!).filter((u) => u.kind === "platform" || u.kind === "hut").map((u) => [KEY(u.i, u.j), { kind: u.kind, ...(u.fit ? { fit: u.fit } : {}) }])), KEY(t.i, t.j));
    const free = (x: StiltBlock): StiltCell[] => x.cells.map(([i, j]) => taken.get(key(i, j))!).filter((t) => t.kind === "platform" && !t.fit && !cutsOf(x, t) && !blocks.some((o) => o.huts.some((h) => h.porch[0] === t.i && h.porch[1] === t.j)) && !nb(t).some(climb)).sort((u, v) => nb(u).filter((x) => x.ref === u.ref).length - nb(v).filter((x) => x.ref === v.ref).length);
    const pool = [...blocks.filter((x) => x.y === r2(rise)), ...blocks.filter((x) => x.y && x.y !== r2(rise))];
    const c = pool.map((x) => free(x).find((t) => nb(t).filter((x2) => x2.ref === t.ref).length <= 3)).find((t) => t);
    if (c) { c.fit = wf.watch; c.face = "pz"; } else if (b || pool.length) warn.push({ code: "stilt-watch", message: "no free corner deck on a raised compound for the watch platform" });
  }
  // ---- the network's nodes and its spanning tree (over deck centres)
  interface Node { id: string; centre: V2; cells: [number, number][]; hh: number }
  const nodes: Node[] = [{ id: "gathering", centre: gather, cells: communalCells, hh: 0 }, ...blocks.map((b) => ({ id: b.id, centre: b.centre, cells: [...b.cells, ...(rampOf.has(b.id) ? [rampOf.get(b.id)!] : [])], hh: b.huts.length }))];
  const nodeOf = (id: string): Node => nodes.find((n) => n.id === id)!;
  let edges: { a: string; b: string; loop?: boolean; joined?: boolean }[] = [];
  // decks that touch at one level (or meet at a ramp's foot) are one floor: no walkway between them
  const owner = new Map<number, string>(); for (const n of nodes) for (const [i, j] of n.cells) owner.set(key(i, j), n.id);
  const joins = new Set<string>();
  for (const t of taken.values()) {
    const a = owner.get(key(t.i, t.j)); if (!a) continue;
    for (const [f, v] of Object.entries(FACES) as [Face, readonly [number, number]][]) {
      const n = taken.get(key(t.i + v[0], t.j + v[1])), b = n && owner.get(key(n.i, n.j)); if (!n || !b || b === a) continue;
      const level = walkable(t) && walkable(n) && (t.y ?? 0) === (n.y ?? 0);
      const rampFoot = climb(t) && t.ref === `in-${a}` && t.face === f && walkable(n) && (n.y ?? 0) === r2((t.y ?? 0) - rise);
      if (level || rampFoot) { joins.add(`${a}|${b}`); joins.add(`${b}|${a}`); }
    }
  }
  {
    const inTree = new Set(["gathering"]);
    while (inTree.size < nodes.length) {
      let e: { a: Node; b: Node; d: number } | null = null;
      // a raised compound has one way in (its ramp): it is a leaf of the tree
      for (const a of nodes) if (inTree.has(a.id)) for (const b of nodes) if (!inTree.has(b.id)) { const j = joins.has(`${a.id}|${b.id}`); if (!j && rampOf.has(a.id)) continue; const dd = j ? 0 : d2(a.centre, b.centre); if (!e || dd < e.d) e = { a, b, d: dd }; }
      if (!e) break;
      inTree.add(e.b.id); edges.push({ a: e.a.id, b: e.b.id, ...(joins.has(`${e.a.id}|${e.b.id}`) ? { joined: true } : {}) });
    }
  }

  // ---- stop platforms on the long legs: the work decks (racks along the way), then drying frames and boat landings
  const workDecks = culture.work.filter((x) => x.where === "water-edge" || x.where === "edge");
  const lenOf = (w: (typeof workDecks)[number]): number => {
    // long enough that its props cover at most 30% of the deck floor a site map measures as placeable (under half of each cell)
    const cover = [...Array(w.count).keys()].reduce((a, n) => { const z = input.props?.(w.props[n % w.props.length]!)?.size; return a + (z ? z[0] * z[2] : 1.4); }, 0);
    return Math.max(2, Math.ceil(w.count / 1.5), Math.ceil(cover / (0.3 * cell * cell * 0.45)));
  };
  const stops: { id: string; kind: "work" | "drying" | "boats"; len: number }[] = [
    ...workDecks.map((w) => ({ id: w.id, kind: "work" as const, len: lenOf(w) })),
    ...Array.from({ length: wf.stops }, (_, n) => ({ id: `stop-${n + 1}`, kind: n % 2 ? ("boats" as const) : ("drying" as const), len: n % 2 ? 1 : 2 })),
  ];
  const unplacedWork: string[] = [];
  for (const st of stops) {
    let done = false;
    const order = edges.filter((e) => !e.loop && !e.joined).map((e) => ({ e, l: d2(nodeOf(e.a).centre, nodeOf(e.b).centre) })).filter((x) => x.l >= 26).sort((a, b) => b.l - a.l);
    for (const { e } of order) {
      const A = nodeOf(e.a).centre, B = nodeOf(e.b).centre, dir = norm([B[0] - A[0], B[1] - A[1]]);
      const ax: Face = Math.abs(dir[0]) >= Math.abs(dir[1]) ? "px" : "pz", side: Face = ax === "px" ? "pz" : "px";
      const [vx, vz] = FACES[ax], [sx, sz] = FACES[side];
      for (const t of [0.5, 0.42, 0.58, 0.34, 0.66]) {
        const m: V2 = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
        const mi = Math.round((m[0] - origin[0]) / cell), mj = Math.round((m[1] - origin[1]) / cell);
        for (const [oi, oj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
          const i0 = mi + oi - Math.floor(((st.len - 1) * vx) / 2), j0 = mj + oj - Math.floor(((st.len - 1) * vz) / 2);
          const run: [number, number][] = Array.from({ length: st.len }, (_, n) => [i0 + vx * n, j0 + vz * n]);
          // a boat stop: its deck, a ramp off its side down to a low landing; which side is clear decides
          const sgn = rnd() < 0.5 ? 1 : -1;
          let extra: [number, number][] = [], sideF: Face = side;
          if (st.kind === "boats") {
            const opts = [sgn, -sgn].map((g) => ({ g, cs: [[i0 + sx * g, j0 + sz * g], [i0 + 2 * sx * g, j0 + 2 * sz * g]] as [number, number][] }));
            const pick = opts.find((o) => roomFor([...run, ...o.cs]));
            if (!pick) continue;
            extra = pick.cs; sideF = faceOf(sx * pick.g, sz * pick.g);
          } else if (!roomFor(run)) continue;
          else sideF = faceOf(sx * sgn, sz * sgn);
          if (st.kind === "work") run.forEach(([i, j]) => put(i, j, "work", st.id));
          else if (st.kind === "drying") run.forEach(([i, j], n) => put(i, j, "platform", st.id, n === 0 && wf.frames.length ? { fit: wf.frames[wf.frames.length - 1]!, face: sideF } : {}));
          else { put(run[0]![0], run[0]![1], "platform", st.id); put(extra[0]![0], extra[0]![1], "ramp", st.id, { face: sideF, y: 0 }); put(extra[1]![0], extra[1]![1], "landing", `${st.id}-boats`, { face: sideF, y: 0, low: true }); }
          const c0 = centreOf(...run[0]!), c1 = centreOf(...run[run.length - 1]!);
          nodes.push({ id: st.id, centre: p2([(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2]), cells: run, hh: 0 });
          edges = edges.filter((x) => x !== e).concat([{ a: e.a, b: st.id }, { a: st.id, b: e.b }]);
          done = true; break;
        }
        if (done) break;
      }
      if (done) break;
    }
    if (!done && st.kind === "work") unplacedWork.push(st.id);
  }
  // a work deck no long leg took: a run straight off the communal deck, else off a compound's deck at the village level
  // (it is walked onto from that deck itself)
  const porchOf = new Set(blocks.flatMap((b) => b.huts.map((h) => key(h.porch[0], h.porch[1]))));
  for (const id of unplacedWork) {
    const len = lenOf(workDecks.find((w) => w.id === id)!);
    const base = [...communalCells.map(([i, j]) => taken.get(key(i, j))!), ...[...taken.values()].filter((t) => t.kind === "platform" && !t.fit && !t.y && !porchOf.has(key(t.i, t.j)))];
    const cand = base.flatMap((t) => (Object.keys(FACES) as Face[]).map((f) => ({ i: t.i + FACES[f][0], j: t.j + FACES[f][1], f })));
    const free = (i: number, j: number): boolean => !taken.has(key(i, j)) && wetOk(i, j);
    const pick = cand.filter((q) => [...Array(len).keys()].every((n) => free(q.i + FACES[q.f][0] * n, q.j + FACES[q.f][1] * n)));
    const q = pick[Math.floor(rnd() * pick.length)];
    if (!q) {
      // no straight run off a deck: a free-standing deck of its own in open water nearest the village, walked to from the
      // nearest deck at the village level
      let spot: [number, number][] | null = null, bd = Infinity;
      for (let aj = 0; aj < rows; aj++) for (let ai = 0; ai < cols; ai++) {
        const dd = d2(centreOf(ai, aj), gather); if (dd >= bd || dd > culture.core.radius + 30) continue;
        for (const [vx, vz] of [[1, 0], [0, 1]] as const) { const run = Array.from({ length: len }, (_, n) => [ai + vx * n, aj + vz * n] as [number, number]); if (roomFor(run)) { spot = run; bd = dd; break; } }
      }
      if (!spot) { warn.push({ code: "stilt-work-deck", message: `no room for work deck ${id}` }); continue; }
      spot.forEach(([i, j]) => put(i, j, "work", id));
      const c0 = centreOf(...spot[0]!), c1 = centreOf(...spot[spot.length - 1]!), centre = p2([(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2]);
      const to = nodes.filter((n) => !rampOf.has(n.id)).sort((a, b) => d2(a.centre, centre) - d2(b.centre, centre))[0]!;
      nodes.push({ id, centre, cells: spot, hh: 0 });
      edges.push({ a: to.id, b: id });
      continue;
    }
    for (let n = 0; n < len; n++) put(q.i + FACES[q.f][0] * n, q.j + FACES[q.f][1] * n, "work", id);
  }

  // ---- a loop or two where the tree makes a neighbour walk the long way round
  {
    const adj = new Map<string, { to: string; l: number }[]>();
    for (const e of edges) { const l = d2(nodeOf(e.a).centre, nodeOf(e.b).centre); (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push({ to: e.b, l }); (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push({ to: e.a, l }); }
    const treeDist = (a: string, b: string): number => { const dist = new Map([[a, 0]]), q = [a]; while (q.length) { const u = q.shift()!; for (const x of adj.get(u) ?? []) if (!dist.has(x.to)) { dist.set(x.to, dist.get(u)! + x.l); q.push(x.to); } } return dist.get(b) ?? Infinity; };
    const cands: { a: string; b: string; r: number }[] = [];
    for (const A of nodes) for (const B of nodes) {
      if (A.id >= B.id || rampOf.has(A.id) || rampOf.has(B.id) || joins.has(`${A.id}|${B.id}`)) continue;
      const dd = d2(A.centre, B.centre); if (dd > 50) continue;
      if (edges.some((e) => (e.a === A.id && e.b === B.id) || (e.a === B.id && e.b === A.id))) continue;
      const r = treeDist(A.id, B.id) / dd; if (r > 2.2) cands.push({ a: A.id, b: B.id, r });
    }
    cands.sort((x, y) => y.r - x.r);
    const used = new Set<string>();
    for (const c of cands) { if (used.has(c.a) || used.has(c.b)) continue; edges.push({ a: c.a, b: c.b, loop: true }); used.add(c.a); used.add(c.b); if (used.size >= 4) break; }
  }

  // ---- ports: deck edges a walkway may arrive at (open water beyond); a raised compound only at its ramp's foot
  interface Port { node: string; i: number; j: number; f: Face; at: V2; out: V2; porch: boolean }
  const STUB = 2.5;
  const porchCells = new Set(blocks.flatMap((b) => b.huts.map((h) => KEY(h.porch[0], h.porch[1]))));
  const usedPorts = new Set<string>();
  const portsOf = (n: Node): Port[] => {
    const out: Port[] = [];
    for (const [i, j] of n.cells) {
      // a fitted cell (drying frame, lookout) is no floor a body crosses: a walkway never arrives at one
      const c = taken.get(key(i, j)); if (!c) continue;
      const fits = c.kind === "communal" || c.kind === "work" || (c.kind === "platform" && !c.y && !c.fit) || (climb(c) && c.ref === `in-${n.id}`);
      if (!fits) continue;
      for (const f of Object.keys(FACES) as Face[]) {
        if (climb(c) && f !== c.face) continue;
        if (c.fit && c.face === f) continue;
        const v = FACES[f], ni = i + v[0], nj = j + v[1];
        if (taken.has(key(ni, nj)) || !wetOk(ni, nj) || usedPorts.has(`${i},${j},${f}`)) continue;
        const ctr = centreOf(i, j);
        out.push({ node: n.id, i, j, f, at: p2([ctr[0] + v[0] * half, ctr[1] + v[1] * half]), out: p2([ctr[0] + v[0] * (half + STUB), ctr[1] + v[1] * (half + STUB)]), porch: porchCells.has(KEY(i, j)) });
      }
    }
    return out;
  };
  const facePen = (p: Port, to: V2): number => { const v = FACES[p.f], d = norm([to[0] - p.out[0], to[1] - p.out[1]]); return (1 - (v[0] * d[0] + v[1] * d[1])) * 10; };

  // ---- routing through water round every deck (fine survey lattice, shallow water cheaper), then pulled straight
  const blockedAt = (p: V2, m: number): boolean => {
    const i = Math.round((p[0] - origin[0]) / cell), j = Math.round((p[1] - origin[1]) / cell);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const t = taken.get(key(i + di, j + dj)); if (t && Math.abs(p[0] - t.at[0]) < half + m && Math.abs(p[1] - t.at[1]) < half + m) return true; }
    return false;
  };
  // water at post depth, or mud flats at the water line (the boardwalk runs on over them)
  const waterOk = (p: V2): boolean => {
    const k = cellAt(G, p); if (k < 0) return false;
    if (G.kind[k] === WET) { const depth = G.w[k]! - G.h[k]!; return Math.abs(G.w[k]! - level) <= 0.35 && depth <= wf.depth[1]; }
    return G.kind[k] === DRY && G.h[k]! <= deckY - wf.raise - 0.45 && G.h[k]! > level - 0.5;
  };
  const walks: StiltWalk[] = [];
  const near = new Set<number>(); // survey cells beside a walkway already laid (a later one keeps off them)
  const mark = (pts: V2[]): void => { for (let n = 1; n < pts.length; n++) { const a = pts[n - 1]!, b = pts[n]!, L = d2(a, b); for (let s = 0; s <= L; s += 1) { const p: V2 = [a[0] + ((b[0] - a[0]) * s) / (L || 1), a[1] + ((b[1] - a[1]) * s) / (L || 1)]; for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const k = cellAt(G, [p[0] + dx * G.step, p[1] + dz * G.step]); if (k >= 0) near.add(k); } } } };
  const route = (from: V2, to: V2, width: number): V2[] | null => {
    const m = width / 2 + 0.35;
    const pass = (p: V2): boolean => waterOk(p) && !blockedAt(p, m);
    const s0 = cellAt(G, from), g0 = cellAt(G, to);
    if (s0 < 0 || g0 < 0) return null;
    const goal = posOf(G, g0), cost = new Map<number, number>([[s0, 0]]), prev = new Map<number, number>();
    // a binary heap of [f, cell]
    const heap: [number, number][] = [];
    const push = (x: [number, number]): void => { heap.push(x); let n = heap.length - 1; while (n > 0) { const p = (n - 1) >> 1; if (heap[p]![0] <= heap[n]![0]) break; [heap[p], heap[n]] = [heap[n]!, heap[p]!]; n = p; } };
    const pop = (): [number, number] => { const top = heap[0]!, last = heap.pop()!; if (heap.length) { heap[0] = last; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l; if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r; if (m === n) break; [heap[m], heap[n]] = [heap[n]!, heap[m]!]; n = m; } } return top; };
    push([d2(posOf(G, s0), goal), s0]);
    const closed = new Set<number>();
    let found = false;
    while (heap.length) {
      const [, k] = pop();
      if (closed.has(k)) continue; closed.add(k);
      if (k === g0) { found = true; break; }
      const i = k % G.cols, j = Math.floor(k / G.cols);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= G.cols || b >= G.rows) continue;
        const nk = b * G.cols + a; if (closed.has(nk)) continue;
        const p = posOf(G, nk), endZone = d2(p, from) < 2 || d2(p, to) < 2;
        if (!endZone && !pass(p)) continue;
        const depth = G.kind[nk] === WET ? Math.max(0, G.w[nk]! - G.h[nk]!) : 0;
        const step = Math.hypot(di, dj) * G.step * (1 + 0.35 * Math.min(1, depth / Math.max(0.5, wf.depth[1]))) + (near.has(nk) && !endZone ? 3 : 0);
        const nc = cost.get(k)! + step;
        if (nc < (cost.get(nk) ?? Infinity)) { cost.set(nk, nc); prev.set(nk, k); push([nc + d2(p, goal), nk]); }
      }
    }
    if (!found) return null;
    const cellsOn: V2[] = []; for (let k: number | undefined = g0; k !== undefined; k = prev.get(k)) cellsOn.unshift(posOf(G, k));
    const pts: V2[] = [from, ...cellsOn.slice(1, -1), to];
    const clear = (a: V2, b: V2): boolean => { const L = d2(a, b); for (let s = 0; s <= L; s += 0.7) { const p: V2 = [a[0] + ((b[0] - a[0]) * s) / (L || 1), a[1] + ((b[1] - a[1]) * s) / (L || 1)]; if (d2(p, from) < 1 || d2(p, to) < 1) continue; if (!pass(p)) return false; } return true; };
    const line = pullString(pts, clear);
    // a long straight run takes a gentle bend (a walkway built by hand never runs ruler-straight)
    const out: V2[] = [line[0]!];
    for (let n = 1; n < line.length; n++) {
      const a = line[n - 1]!, b = line[n]!, L = d2(a, b);
      if (L > 16) {
        const nrm: V2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L], off = (1.2 + rnd() * 1.8) * (rnd() < 0.5 ? 1 : -1);
        for (const o of [off, -off]) { const mid: V2 = p2([(a[0] + b[0]) / 2 + nrm[0] * o, (a[1] + b[1]) / 2 + nrm[1] * o]); if (clear(a, mid) && clear(mid, b)) { out.push(mid); break; } }
      }
      out.push(b);
    }
    return out.map(p2);
  };

  // ---- the spine: the bank link and every leg carrying four or more households toward the communal deck
  const tree = edges.filter((e) => !e.loop);
  const parent = new Map<string, string>([["gathering", ""]]);
  { const q = ["gathering"]; while (q.length) { const u = q.shift()!; for (const e of tree) { const v = e.a === u ? e.b : e.b === u ? e.a : null; if (v && !parent.has(v)) { parent.set(v, u); q.push(v); } } } }
  const down = new Map<string, number>(nodes.map((n) => [n.id, n.hh]));
  { const order = [...parent.keys()].reverse(); for (const v of order) { const p = parent.get(v); if (p) down.set(p, (down.get(p) ?? 0) + (down.get(v) ?? 0)); } }
  const spine = new Set<string>(); // nodes whose leg to their parent carries the bank link's traffic
  const mainEdge = (e: { a: string; b: string; loop?: boolean }): boolean => { if (e.loop) return false; const child = parent.get(e.a) === e.b ? e.a : e.b; return (down.get(child) ?? 0) >= 4 || spine.has(child); };

  // ---- the bank link: a ramp's top in the water whose foot lands on bank one ramp below the deck, nearest the network
  let dryLink: V2 | null = null;
  let bank: { T: V2; d: V2; stub: V2; port: Port; s: number; ramp: boolean } | null = null;
  {
    // bank one ramp below the deck (a ramp runs down onto it), or level with the deck (the walkway steps straight off)
    const rampLand = (h: number): boolean => h > deckY - wf.raise - 0.45 && h < deckY - wf.raise + 0.35;
    const levelLand = (h: number): boolean => Math.abs(h - deckY) <= 0.4;
    const allPorts = nodes.flatMap(portsOf);
    const dirs: V2[] = Array.from({ length: 8 }, (_, n) => [Math.cos((n * Math.PI) / 4), Math.sin((n * Math.PI) / 4)]);
    for (let k = 0; k < G.kind.length; k++) {
      if (G.kind[k] !== DRY) continue;
      const ramp = rampLand(G.h[k]!); if (!ramp && !levelLand(G.h[k]!)) continue;
      const L = posOf(G, k);
      if (d2(L, gather) > input.radius) continue;
      for (const d of dirs) {
        const back = ramp ? 4.3 : 1.2, T: V2 = [L[0] - d[0] * back, L[1] - d[1] * back], stub: V2 = [T[0] - d[0] * STUB, T[1] - d[1] * STUB];
        if ((ramp && !waterOk(T)) || !waterOk(stub) || blockedAt(T, 1.6) || blockedAt(stub, 1.6) || blockedAt([L[0] - d[0] * 2, L[1] - d[1] * 2], 1.6)) continue;
        // (off the communal deck or a stop; a family compound's deck only when nothing else is near: its few free edges are
    // its own way into the network)
    for (const p of allPorts) { const s = d2(p.out, stub) + facePen(p, stub) + (p.porch ? 6 : 0) + (p.node === "gathering" ? 0 : p.node.startsWith("stop-") ? 4 : 24) + (ramp ? 0 : 3); if (!bank || s < bank.s) bank = { T: p2(T), d, stub: p2(stub), port: p, s, ramp }; }
      }
    }
  }

  for (let n: string | undefined = bank?.port.node; n && n !== "gathering"; n = parent.get(n)) spine.add(n);
  // ---- lay the legs: the bank link and the spine first, then branches by length, then the loops
  const legs = [...(bank ? [{ a: bank.port.node, b: "dry-link", bank: true as const }] : []), ...edges.map((e) => ({ ...e, bank: false as const }))];
  const isMain = (e: (typeof legs)[number]): boolean => e.bank || mainEdge(e);
  legs.sort((x, y) => Number(isMain(y)) - Number(isMain(x)) || Number(!!(x as { loop?: boolean }).loop) - Number(!!(y as { loop?: boolean }).loop));
  for (const e of legs) {
    const main = isMain(e), width = main ? wf.walkways.mainWidth : wf.walkways.branchWidth;
    if ((e as { joined?: boolean }).joined) { walks.push({ id: `deck-${e.a}-${e.b}`, from: e.a, to: e.b, points: [], width: cell, main: false }); continue; }
    let pa: Port | undefined, pb: Port | undefined, end: V2[] = [];
    if (e.bank) { pa = bank!.port; end = [bank!.stub, bank!.T]; }
    else {
      const A = nodeOf(e.a), B = nodeOf(e.b);
      let bs = Infinity;
      const PA = portsOf(A), PB = portsOf(B);
      for (const x of PA) for (const y of PB) { const s = d2(x.out, y.out) + facePen(x, y.out) + facePen(y, x.out) + (x.porch ? 6 : 0) + (y.porch ? 6 : 0); if (s < bs) { bs = s; pa = x; pb = y; } }
      if (!pa || !pb) { warn.push({ code: "stilt-walkway", message: `no free deck edge for the walkway ${e.a} - ${e.b}` }); continue; }
      end = [pb.out, pb.at];
    }
    const mid = route(pa.out, end[0]!, width);
    if (!mid) { if (!(e as { loop?: boolean }).loop) warn.push({ code: "stilt-walkway", message: `no water route for the walkway ${e.a} - ${e.b}` }); continue; }
    const pts = [pa.at, ...mid, end[1]!].map(p2);
    walks.push({ id: `walk-${e.a}-${e.b}`, from: e.a, to: e.b, points: pts, width, main, ...(e.bank && bank!.ramp ? { ramp: true } : {}) });
    mark(pts);
    for (const p of [pa, pb]) if (p) { usedPorts.add(`${p.i},${p.j},${p.f}`); const c = taken.get(key(p.i, p.j))!; c.open = [...(c.open ?? []), p.f]; }
    if (e.bank) { const o = bank!.ramp ? 5 : 2; dryLink = p2([bank!.T[0] + bank!.d[0] * o, bank!.T[1] + bank!.d[1] * o]); }
  }
  {
    const linkedTo = (): Set<string> => { const adj = new Map<string, string[]>(); for (const w of walks) { (adj.get(w.from) ?? adj.set(w.from, []).get(w.from)!).push(w.to); (adj.get(w.to) ?? adj.set(w.to, []).get(w.to)!).push(w.from); } const seen = new Set(["gathering"]), q = ["gathering"]; while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); } return seen; };
    for (let pass = 0; pass < nodes.length; pass++) {
      const seen = linkedTo(), lost = nodes.filter((n) => !seen.has(n.id));
      if (!lost.length) break;
      let fixed = false;
      for (const L of lost) {
        for (const T of nodes.filter((n) => seen.has(n.id)).sort((a, b) => d2(a.centre, L.centre) - d2(b.centre, L.centre))) {
          if (rampOf.has(T.id)) continue;
          let pa: Port | undefined, pb: Port | undefined, bs = Infinity;
          for (const x of portsOf(L)) for (const y of portsOf(T)) { const sc = d2(x.out, y.out) + facePen(x, y.out) + facePen(y, x.out); if (sc < bs) { bs = sc; pa = x; pb = y; } }
          if (!pa || !pb) continue;
          const mid = route(pa.out, pb.out, wf.walkways.branchWidth);
          if (!mid) continue;
          const pts = [pa.at, ...mid, pb.at].map(p2);
          walks.push({ id: `walk-${L.id}-${T.id}`, from: L.id, to: T.id, points: pts, width: wf.walkways.branchWidth, main: false });
          mark(pts);
          for (const p of [pa, pb]) { usedPorts.add(`${p.i},${p.j},${p.f}`); const c = taken.get(key(p.i, p.j))!; c.open = [...(c.open ?? []), p.f]; }
          fixed = true; break;
        }
        if (fixed) break;
      }
      if (!fixed) { for (const L of lost) warn.push({ code: "stilt-walkway", message: `${L.id} has no walkway to the village network` }); break; }
    }
  }
  if (!dryLink) warn.push({ code: "stilt-dry-link", message: "no walkway reaches bank one ramp below the deck: the village has no link to the bank" });

  // ---- boat landings off the communal deck and the stops, one facing the approach, clear of every walkway
  const nearWalk = (p: V2, r: number): boolean => walks.some((w) => w.points.slice(1).some((b, n) => segDist2(p, w.points[n]!, b) < r));
  const rimCells = [...taken.values()].filter((t) => t.kind === "communal" || (t.kind === "platform" && t.ref.startsWith("stop-") && !t.fit)).flatMap((t) => (Object.keys(FACES) as Face[]).filter((f) => !t.open?.includes(f)).map((f) => ({ t, f, i: t.i + FACES[f][0], j: t.j + FACES[f][1] }))).filter((q) => !taken.has(key(q.i, q.j)) && wetOk(q.i, q.j) && !nearWalk(centreOf(q.i, q.j), half + 1.6));
  const landings: { i: number; j: number }[] = [];
  for (let n = 0; n < wf.landings && rimCells.length; n++) {
    const want = n === 0 ? toward : norm([Math.cos(rnd() * 6.283), Math.sin(rnd() * 6.283)]);
    let pick: (typeof rimCells)[number] | null = null, bs = -Infinity;
    for (const q of rimCells) {
      if (taken.has(key(q.i, q.j)) || landings.some((l) => Math.abs(l.i - q.i) + Math.abs(l.j - q.j) < 4)) continue;
      const dir = norm([q.i - gi, q.j - gj]), s = dir[0] * want[0] + dir[1] * want[1] + d2([q.i, q.j], [gi, gj]) * 0.05;
      if (s > bs) { bs = s; pick = q; }
    }
    if (!pick) break;
    put(pick.i, pick.j, "landing", `landing-${n + 1}`, { face: pick.f });
    landings.push({ i: pick.i, j: pick.j });
  }
  // ---- a little dock per hut (levels.landings): a landing cell at the hut's level, stepped onto from its own compound's
  // deck beside the hut (or its porch), its ladder on the far side down into the water, clear of every walkway
  if (perHutDocks) {
    for (const b of blocks) for (const h of b.huts) {
      const mine = (t: StiltCell | undefined): boolean => !!t && t.ref === b.id && walkable(t) && (t.y ?? 0) === b.y;
      // deck cells of the compound next to the hut (its porch first), then any of its free water neighbours
      const near = (i: number, j: number): number => Math.min(...h.cells.map(([a, c]) => Math.abs(a - i) + Math.abs(c - j)));
      const decks = b.cells.filter(([i, j]) => mine(taken.get(key(i, j))) && near(i, j) <= 3).sort((u, v) => near(...u) - near(...v));
      let pick: { i: number; j: number; f: Face; s: number } | null = null;
      for (const [i, j] of decks) for (const f of Object.keys(FACES) as Face[]) {
        const v = FACES[f], di = i + v[0], dj = j + v[1];
        if (taken.has(key(di, dj)) || !wetOk(di, dj) || reserved.has(key(di, dj)) || nearWalk(centreOf(di, dj), half + 1.2)) continue;
        // the ladder side keeps open water; a dock touching the hut itself reads as the hut's own
        const beyond = !taken.has(key(di + v[0], dj + v[1])) && wetOk(di + v[0], dj + v[1]);
        const byHut = h.cells.some(([a, c]) => Math.abs(a - di) + Math.abs(c - dj) === 1);
        const s = (beyond ? 2 : 0) + (byHut ? 1 : 0) - near(di, dj) * 0.6 - (Object.values(FACES) as readonly (readonly [number, number])[]).filter(([a, c]) => taken.has(key(di + a, dj + c))).length * 0.3;
        if (!pick || s > pick.s) pick = { i: di, j: dj, f, s };
      }
      if (pick) { put(pick.i, pick.j, "landing", `${b.id}-dock`, { face: pick.f, y: b.y }); h.dock = [pick.i, pick.j]; continue; }
      // no room for a landing deck: a mooring ladder off the nearest deck edge over open water (its rail gated)
      for (const [i, j] of decks) {
        const t = taken.get(key(i, j))!;
        const f = (Object.keys(FACES) as Face[]).find((ff) => !t.open?.includes(ff) && !taken.has(key(i + FACES[ff][0], j + FACES[ff][1])) && wetOk(i + FACES[ff][0], j + FACES[ff][1]) && !nearWalk([t.at[0] + FACES[ff][0] * half, t.at[1] + FACES[ff][1] * half], 1.6));
        if (f && !t.moor) { t.moor = f; h.dock = [i, j]; break; }
      }
    }
    const docked = blocks.reduce((a, b) => a + b.huts.filter((h) => h.dock).length, 0), all = blocks.reduce((a, b) => a + b.huts.length, 0);
    if (docked < all) warn.push({ code: "stilt-docks", message: `${docked} of ${all} huts have a dock or mooring ladder of their own (no free water beside the rest)` });
  }
  return { origin, cell, deckY, water: level, cols, rows, blocks, cells: [...taken.values()], dryLink, walks, rise, raise: wf.raise };
}

/**
 * Trim a stilt village's bare deck: every open platform or work cell nothing stands on (`used` false: no item, creature
 * spot or kit fixture over it), that is no porch, walkway port, mooring or stair foot, and whose removal still leaves every
 * porch, dock, landing, stair (and its head and foot), port, fitted cell and used cell reachable from the communal deck (same-height deck, stairs
 * and ramps along their slope, walkways between their nodes' ports). A deck is as big as the life on it. Returns the
 * trimmed cells (removed from `grid.cells` and their blocks).
 */
export function trimStiltDecks(grid: StiltGrid, used: (c: StiltCell) => boolean, still?: (cells: StiltCell[]) => boolean): StiltCell[] {
  const at = new Map(grid.cells.map((c) => [KEY(c.i, c.j), c]));
  const porch = new Set(grid.blocks.flatMap((b) => b.huts.map((h) => KEY(h.porch[0], h.porch[1]))));
  const floor = (c: StiltCell): boolean => ((c.kind === "platform" || c.kind === "communal" || c.kind === "work") && !c.fit) || c.kind === "landing";
  const sloped = (c: StiltCell): boolean => c.kind === "stair" || c.kind === "ramp";
  // a stair's or ramp's head and foot deck stay (the flight lands on them)
  const ends = new Set(grid.cells.filter(sloped).flatMap((c) => { const v = FACES[c.face as Face]; return v ? [KEY(c.i + v[0], c.j + v[1]), KEY(c.i - v[0], c.j - v[1])] : []; }));
  const required = (c: StiltCell): boolean => c.kind !== "hut" && (!floor(c) || c.kind === "landing" || c.kind === "communal" || porch.has(KEY(c.i, c.j)) || ends.has(KEY(c.i, c.j)) || !!c.open?.length || !!c.moor || used(c));
  // walkway ends: every port cell of a walkway's two nodes is linked to every port cell of the other
  const ports = new Map<string, StiltCell[]>();
  for (const c of grid.cells) if (c.open?.length) (ports.get(c.ref) ?? ports.set(c.ref, []).get(c.ref)!).push(c);
  const links = new Map<string, StiltCell[]>();
  for (const w of grid.walks) if (w.points.length) for (const [a, b] of [[w.from, w.to], [w.to, w.from]] as const) for (const c of ports.get(a) ?? []) links.set(KEY(c.i, c.j), [...(links.get(KEY(c.i, c.j)) ?? []), ...(ports.get(b) ?? [])]);
  const reach = (gone: Set<string>): Set<string> => {
    const seen = new Set<string>(), q: StiltCell[] = [];
    const add = (c: StiltCell | undefined): void => { if (c && !gone.has(KEY(c.i, c.j)) && !seen.has(KEY(c.i, c.j))) { seen.add(KEY(c.i, c.j)); q.push(c); } };
    for (const c of grid.cells) if (c.kind === "communal" || (c.open?.length && grid.walks.some((w) => w.to === "dry-link" && w.from === c.ref))) add(c);
    while (q.length) {
      const u = q.pop()!;
      // a fitted cell, a hut or a dock / boat landing is reached, not passed through
      if ((!floor(u) || u.kind === "landing") && !sloped(u)) continue;
      for (const [f, v] of Object.entries(FACES) as [Face, readonly [number, number]][]) {
        const n = at.get(KEY(u.i + v[0], u.j + v[1])); if (!n) continue;
        const along = (s: StiltCell): boolean => s.face === f || FACE_DEG[s.face as Face] === (FACE_DEG[f] + 180) % 360;
        if (sloped(u) ? along(u) : sloped(n) ? along(n) : (n.y ?? 0) === (u.y ?? 0) && (floor(n) || !!n.fit || (n.kind === "hut" && porch.has(KEY(u.i, u.j))))) add(n);
      }
      for (const n of links.get(KEY(u.i, u.j)) ?? []) add(n);
    }
    return seen;
  };
  const need = grid.cells.filter(required).map((c) => KEY(c.i, c.j));
  const gone = new Set<string>();
  const base = reach(gone);
  const cands = grid.cells.filter((c) => (c.kind === "platform" || c.kind === "work") && !c.fit && !required(c));
  for (const c of cands) {
    gone.add(KEY(c.i, c.j));
    const r = reach(gone);
    if (need.some((k) => base.has(k) && !r.has(k)) || (still && !still(grid.cells.filter((x) => !gone.has(KEY(x.i, x.j)))))) gone.delete(KEY(c.i, c.j));
  }
  const out = grid.cells.filter((c) => gone.has(KEY(c.i, c.j)));
  grid.cells = grid.cells.filter((c) => !gone.has(KEY(c.i, c.j)));
  for (const b of grid.blocks) b.cells = b.cells.filter(([i, j]) => !gone.has(KEY(i, j)));
  return out;
}

/**
 * Walk routes through a stilt village for the real-body walk gate (handoff navigation.routes, points [x, y, z]): from the
 * bank along the bank walkway onto the communal deck, then on to hut doors (the highest-level hut, one on a middle level,
 * one on the village deck): deck cell to deck cell at one height, up and down ramps and stair flights along their slope,
 * along the walkway polylines between their ports, through the porch and the door into the hut. With `network`, also the
 * way to every dressing area (flagged `network`: handoff navigation.network, not walked as routes).
 */
/** A thing standing on a stilt deck as the walk lattice sees it: its footprint + 0.5 m, turned by its yaw, at height `y`. */
export interface LatticeThing { at: V2; hw: number; hd: number; cs: number; sn: number; y?: number }
/** A deck thing's lattice body (its own box + 0.5 m; an unknown size 1.2 m square). */
export function latticeThing(it: { at: V2; yaw: number }, z: [number, number] | undefined, y?: number): LatticeThing {
  const t = (it.yaw * Math.PI) / 180;
  return { at: it.at, hw: (z ? z[0] / 2 : 0.6) + 0.5, hd: (z ? z[1] / 2 : 0.6) + 0.5, cs: Math.cos(t), sn: Math.sin(t), ...(y !== undefined ? { y } : {}) };
}
type P3 = [number, number, number];
interface StiltLattice { nodes: Map<string, P3>; cellOf: Map<string, StiltCell>; adj: Map<string, { to: string; via: P3[]; w: number }[]>; sid: (x: number, z: number) => string; nearestIn: (p: V2, q: V2) => string | null; drop: (c: StiltCell) => number }
/**
 * The 1 m walk lattice over a stilt village's decks (a slope only down its 2.6 m middle), linked to its 8 neighbours
 * where a body walks, the walkways linking their port cells (and "bank"), every point a body's room off the `things`.
 */
function stiltLattice(g: StiltGrid, things: LatticeThing[]): StiltLattice {
  const rise = g.rise ?? 1, raise = g.raise ?? 1, at = new Map(g.cells.map((c) => [KEY(c.i, c.j), c]));
  const ctr = (i: number, j: number): V2 => [g.origin[0] + i * g.cell, g.origin[1] + j * g.cell];
  const ijOf = (p: V2): [number, number] => [Math.round((p[0] - g.origin[0]) / g.cell), Math.round((p[1] - g.origin[1]) / g.cell)];
  const drop = (c: StiltCell): number => (c.kind === "stair" ? rise : c.kind === "ramp" ? raise : 0);
  const deck = (c?: StiltCell): c is StiltCell => !!c && !c.fit && !c.low && (c.kind === "communal" || c.kind === "work" || c.kind === "platform" || c.kind === "ramp" || c.kind === "stair");
  // the height a cell offers on its side f (a slope: its low end on its face side, its top opposite, no way on at its sides)
  const edgeY = (c: StiltCell, f: Face): number | null => { const d = drop(c); if (!d) return c.y ?? 0; if (f === c.face) return r2((c.y ?? 0) - d); if (FACE_DEG[f] === (FACE_DEG[c.face as Face] + 180) % 360) return c.y ?? 0; return null; };
  const inThing = (t: LatticeThing, p: V2): boolean => { const dx = p[0] - t.at[0], dz = p[1] - t.at[1]; return Math.abs(dx * t.cs - dz * t.sn) < t.hw && Math.abs(dx * t.sn + dz * t.cs) < t.hd; };
  // a 1 m lattice over every deck cell (a slope only down its 2.6 m middle), linked to its 8 neighbours where a body walks
  const nodes = new Map<string, P3>(), cellOf = new Map<string, StiltCell>(), adj = new Map<string, { to: string; via: P3[]; w: number }[]>();
  const node = (id: string, p: P3): void => { if (!nodes.has(id)) { nodes.set(id, p); adj.set(id, []); } };
  const link = (a: string, b: string, via: P3[] = []): void => { const pts = [nodes.get(a)!, ...via, nodes.get(b)!]; let w = 0; for (let n = 1; n < pts.length; n++) w += Math.hypot(pts[n]![0] - pts[n - 1]![0], pts[n]![2] - pts[n - 1]![2]); adj.get(a)!.push({ to: b, via, w }); adj.get(b)!.push({ to: a, via: [...via].reverse(), w }); };
  const sid = (x: number, z: number): string => `${r2(x)},${r2(z)}`;
  // a side the deck runs on across (a same-height deck, a slope's matching end) or a port left open in the rail; any
  // other side carries a rail, a hut wall or a mooring gate 0.3 m in, so a body keeps the outer row off it (a hut
  // door is a port too)
  const doors = new Set(g.blocks.flatMap((b) => b.huts.map((h) => `${h.porch[0]},${h.porch[1]},${faceOf(h.cell[0] - h.porch[0], h.cell[1] - h.porch[1])}`)));
  const goesOn = (c: StiltCell, f: Face): "on" | "port" | null => {
    const v = FACES[f], n = at.get(KEY(c.i + v[0], c.j + v[1])), back = (["nx", "px", "nz", "pz"] as Face[])[["px", "nx", "pz", "nz"].indexOf(f)]!;
    const ea = edgeY(c, f), eb = deck(n) ? edgeY(n, back) : null;
    if (ea !== null && eb !== null && Math.abs(ea - eb) < 0.01) return "on";
    return (c.open?.includes(f) || doors.has(`${c.i},${c.j},${f}`)) && c.moor !== f ? "port" : null;
  };
  for (const c of g.cells) if (deck(c)) {
    const o = ctr(c.i, c.j), d = drop(c), fv = c.face ? FACES[c.face as Face] : [0, 0];
    const side = Object.fromEntries((Object.keys(FACES) as Face[]).map((f) => [f, goesOn(c, f)])) as Record<Face, "on" | "port" | null>;
    for (const dz of [-1.5, -0.5, 0.5, 1.5]) for (const dx of [-1.5, -0.5, 0.5, 1.5]) {
      if (d && Math.abs(dx * fv[1] - dz * fv[0]) > 0.6) continue;
      // the outer row: kept on a side the deck goes on across; on a port only its middle two (the rail's gap); along a rail
      // or a hut wall pulled in to 1.1 m off the middle (0.9 m off the edge, a body's room inside the rail)
      const off = (f: Face, a: number, lat: number): boolean => Math.abs(a) > 1 && side[f] === "port" && Math.abs(lat) > 1;
      if (!d && (off(dx > 0 ? "px" : "nx", dx, dz) || off(dz > 0 ? "pz" : "nz", dz, dx))) continue;
      const pull = (f: Face, a: number): number => (!d && Math.abs(a) > 1 && side[f] === null ? Math.sign(a) * 1.1 : a);
      const x = o[0] + pull(dx > 0 ? "px" : "nx", dx), z = o[1] + pull(dz > 0 ? "pz" : "nz", dz), along = d ? (dx * fv[0] + dz * fv[1]) : 0;
      const y = r2(g.deckY + (c.y ?? 0) - (d ? d * (0.5 + along / g.cell) : 0));
      if (things.some((t) => Math.abs((t.y ?? g.deckY + (c.y ?? 0)) - y) < 1.2 && inThing(t, [x, z]))) continue;
      // (named by its lattice point, so the 1 m neighbour links still find it)
      node(sid(o[0] + dx, o[1] + dz), [x, y, z]); cellOf.set(sid(o[0] + dx, o[1] + dz), c);
    }
  }
  for (const id of nodes.keys()) for (const [ox, oz] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
    const [gx, gz] = id.split(",").map(Number) as [number, number], nid = sid(gx + ox, gz + oz), q = nodes.get(nid); if (!q) continue;
    const a = cellOf.get(id)!, b = cellOf.get(nid)!;
    if (a !== b) {
      if (ox && oz) { if (drop(a) || drop(b) || (a.y ?? 0) !== (b.y ?? 0)) continue; }
      const f = faceOf(b.i - a.i, b.j - a.j), ea = edgeY(a, f), eb = edgeY(b, (["px", "nx", "pz", "nz"] as Face[])[["nx", "px", "nz", "pz"].indexOf(f)]!);
      if (Math.abs(b.i - a.i) + Math.abs(b.j - a.j) !== 1 || ea === null || eb === null || Math.abs(ea - eb) > 0.01) continue;
    }
    // the hop itself keeps the walking body off a thing too: two points clear of it can still cut its corner (a diagonal
    // past a chest: poi-walk BODY 2026-10-19). A hop needs the body's 0.4 m less the 0.1 m the walk gate tolerates (the
    // points keep 0.5 m, the margin they are spaced on)
    const p = nodes.get(id)!, HOP = 0.2;
    if ([0.25, 0.5, 0.75].some((k) => { const x = p[0] + (q[0] - p[0]) * k, y = p[1] + (q[1] - p[1]) * k, z = p[2] + (q[2] - p[2]) * k; return things.some((t) => { if (Math.abs((t.y ?? y) - y) >= 1.2) return false; const dx = x - t.at[0], dz = z - t.at[1]; return Math.abs(dx * t.cs - dz * t.sn) < t.hw - HOP && Math.abs(dx * t.sn + dz * t.cs) < t.hd - HOP; }); })) continue;
    link(id, nid);
  }
  // walkways: the nearest lattice point of each port cell -> the polyline at the village deck -> the other port (or the bank)
  const nearestIn = (p: V2, q: V2): string | null => { const l = d2(p, q) || 1, ij = ijOf([p[0] - ((q[0] - p[0]) / l) * 0.6, p[1] - ((q[1] - p[1]) / l) * 0.6]), c = at.get(KEY(ij[0], ij[1])); let best: string | null = null, bd = Infinity; for (const [id, n] of nodes) if (cellOf.get(id) === c) { const dd = d2([n[0], n[2]], p); if (dd < bd) { bd = dd; best = id; } } return best; };
  if (g.dryLink) node("bank", [g.dryLink[0], r2(g.deckY - (g.walks.some((w) => w.ramp) ? raise : 0)), g.dryLink[1]]);
  for (const w of g.walks) {
    const P = w.points; if (P.length < 2) continue;
    const a = nearestIn(P[0]!, P[1]!), b = w.to === "dry-link" || w.from === "dry-link" ? (g.dryLink ? "bank" : null) : nearestIn(P[P.length - 1]!, P[P.length - 2]!);
    if (a && b) link(a, b, P.map((p) => [p[0], g.deckY, p[1]] as P3));
  }
  return { nodes, cellOf, adj, sid, nearestIn, drop };
}

/**
 * The places a body must reach on a stilt village from its communal deck (and the bank) on the 1 m walk lattice: every
 * hut door (the porch points straight out of it), every stair and ramp, every dock's and mooring's deck edge, every
 * walkway end, and across each border where two decks (compounds, the communal deck) join at one height a lane >= 1.2 m
 * (two side-by-side crossing points). Returns the ones it cannot reach: the point it is measured at and `goal`, the
 * lattice points (named as the bare lattice names them) any one of which reaches it.
 */
export function stiltUnreached(g: StiltGrid, things: LatticeThing[]): { id: string; at: V2; goal: string[] }[] {
  const L = stiltLattice(g, things), L0 = things.length ? stiltLattice(g, []) : L, at = new Map(g.cells.map((c) => [KEY(c.i, c.j), c])), half = g.cell / 2;
  const ctr = (i: number, j: number): V2 => [g.origin[0] + i * g.cell, g.origin[1] + j * g.cell];
  const seen = latticeReach(L);
  const byCell = new Map<StiltCell, string[]>(); for (const [id, c] of L0.cellOf) (byCell.get(c) ?? byCell.set(c, []).get(c)!).push(id);
  const out: { id: string; at: V2; goal: string[] }[] = [];
  const need = (id: string, p: V2, goal: string[]): void => { if (goal.length && !goal.some((k) => seen.has(k))) out.push({ id, at: p, goal }); };
  // a cell's edge f: its lattice points within 1.6 m of that edge's middle
  const edge = (c: StiltCell, f: Face): string[] => { const v = FACES[f], m: V2 = [c.at[0] + v[0] * half, c.at[1] + v[1] * half]; return (byCell.get(c) ?? []).filter((id) => { const n = L0.nodes.get(id)!; return Math.hypot(n[0] - m[0], n[2] - m[1]) <= 1.6; }); };
  for (const b of g.blocks) for (const h of b.huts) {
    const hc = ctr(...h.cell), pc = ctr(...h.porch), v: V2 = [(hc[0] - pc[0]) / g.cell, (hc[1] - pc[1]) / g.cell];
    const hid = at.get(KEY(...h.cell))?.hut ?? b.id;
    need(`door ${hid}`, [pc[0] + v[0] * 1.5, pc[1] + v[1] * 1.5], [-0.5, 0.5].map((s) => L0.sid(pc[0] + v[0] * 1.5 + (v[1] ? s : 0), pc[1] + v[1] * 1.5 + (v[0] ? s : 0))));
    const d = h.dock ? at.get(KEY(...h.dock)) : undefined;
    if (d) need(`dock ${hid}`, d.at, (Object.keys(FACES) as Face[]).flatMap((f) => { const n = at.get(KEY(d.i - FACES[f][0], d.j - FACES[f][1])); return n && !L0.drop(n) && (n.y ?? 0) === (d.y ?? 0) && n.kind !== "hut" && n.kind !== "landing" ? edge(n, f) : []; }));
  }
  for (const c of g.cells) {
    if (c.kind === "stair" || c.kind === "ramp") need(`${c.kind} ${c.i},${c.j}`, c.at, byCell.get(c) ?? []);
    if (c.moor && !L0.drop(c)) need(`mooring ${c.i},${c.j}`, c.at, edge(c, c.moor));
  }
  for (const w of g.walks) for (const [p, q2, e] of [[w.points[0], w.points[1], "a"], [w.points[w.points.length - 1], w.points[w.points.length - 2], "b"]] as const) {
    if (!p || !q2) continue; const id = L0.nearestIn(p, q2);
    if (id) need(`walkway ${w.id}:${e}`, p, [id]);
  }
  // joined decks: per pair of compounds meeting at one height, some crossing two side-by-side lattice points wide
  const joins = new Map<string, { ok: boolean; at: V2; goal: string[] }>();
  const flat = (x?: StiltCell): boolean => !!x && !x.fit && !x.low && (x.kind === "communal" || x.kind === "work" || x.kind === "platform");
  for (const c of g.cells) for (const f of ["px", "pz"] as Face[]) {
    const n = at.get(KEY(c.i + FACES[f][0], c.j + FACES[f][1]));
    if (!flat(c) || !flat(n) || n!.ref === c.ref || (n!.y ?? 0) !== (c.y ?? 0)) continue;
    const key = `${[c.ref, n!.ref].sort().join("|")}@${c.y ?? 0}`, j = joins.get(key) ?? { ok: false, at: [(c.at[0] + n!.at[0]) / 2, (c.at[1] + n!.at[1]) / 2] as V2, goal: [] };
    const v = FACES[f], m: V2 = [c.at[0] + v[0] * half, c.at[1] + v[1] * half];
    const pair = (s: number): [string, string] => [L0.sid(m[0] - v[0] * 0.5 + (v[1] ? s : 0), m[1] - v[1] * 0.5 + (v[0] ? s : 0)), L0.sid(m[0] + v[0] * 0.5 + (v[1] ? s : 0), m[1] + v[1] * 0.5 + (v[0] ? s : 0))];
    const cross = (s: number): boolean => { const [a, b] = pair(s); return seen.has(a) && seen.has(b) && !!L.adj.get(a)?.some((e) => e.to === b); };
    for (const s of [-1.5, -0.5, 0.5]) if (cross(s) && cross(s + 1)) j.ok = true;
    for (const s of [-1.5, -0.5, 0.5, 1.5]) j.goal.push(...pair(s).filter((k) => L0.nodes.has(k)));
    joins.set(key, j);
  }
  for (const [k, j] of joins) if (!j.ok && j.goal.length) out.push({ id: `join ${k}`, at: j.at, goal: j.goal });
  return out;
}

/** Lattice points reached from the communal deck and the bank. */
function latticeReach(L: StiltLattice): Set<string> {
  const seen = new Set<string>(), q: string[] = [];
  for (const [id, c] of L.cellOf) if (c.kind === "communal") { seen.add(id); q.push(id); }
  if (L.nodes.has("bank")) { seen.add("bank"); q.push("bank"); }
  while (q.length) for (const e of L.adj.get(q.pop()!) ?? []) if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
  return seen;
}

/**
 * The things standing in the way to a `goal` (stiltUnreached): indices of `things` over a lattice point of the shortest
 * way there on the bare deck (communal deck or bank to the goal), or over a goal point itself.
 */
export function stiltBlockers(g: StiltGrid, things: LatticeThing[], goal: string[]): number[] {
  const L0 = stiltLattice(g, []), want = new Set(goal), prev = new Map<string, string | null>(), q: string[] = [];
  for (const [id, c] of L0.cellOf) if (c.kind === "communal") { prev.set(id, null); q.push(id); }
  if (L0.nodes.has("bank")) { prev.set("bank", null); q.push("bank"); }
  let end: string | null = null;
  for (let h = 0; h < q.length && !end; h++) { const u = q[h]!; if (want.has(u)) { end = u; break; } for (const e of L0.adj.get(u) ?? []) if (!prev.has(e.to)) { prev.set(e.to, u); q.push(e.to); } }
  const pts = new Set(goal); for (let k = end; k; k = prev.get(k) ?? null) pts.add(k);
  const inThing = (t: LatticeThing, p: P3): boolean => { const dx = p[0] - t.at[0], dz = p[2] - t.at[1]; return (t.y === undefined || Math.abs(t.y - p[1]) < 1.2) && Math.abs(dx * t.cs - dz * t.sn) < t.hw && Math.abs(dx * t.sn + dz * t.cs) < t.hd; };
  const P = [...pts].map((k) => L0.nodes.get(k)).filter((p): p is P3 => !!p);
  return things.flatMap((t, n) => (P.some((p) => inThing(t, p)) ? [n] : []));
}

/** How far into a hut, from its door, a body walking straight in may stop: clear of the bed in the hut's middle by the
 *  walking body's 0.4 m radius + 0.15 m (poi-walk BODY: capsule r 0.4, 0.1 m tolerated), 0.3..1.0 m in. */
export const HUT_STEP_IN = { max: 1.0, min: 0.3, clear: 0.55 } as const;
/**
 * Where a body stands just inside each stilt hut (the walk gate's target for its household area, and where a route into
 * the hut stops): straight in from the middle of its door, short of the bed laid in the hut's middle (its larger
 * footprint half, so any yaw clears). Keyed by household id. The area's centre is the middle of its footprints' box,
 * which can lie on the bed or beside the porch kit: a body sent there walks through them (poi-walk BODY 2026-10-19).
 */
export function stiltHutReach(plan: SettlementPlan, size?: (prop: string) => [number, number, number] | undefined): Map<string, { door: [number, number, number]; inside: [number, number, number]; v: V2 }> {
  const out = new Map<string, { door: [number, number, number]; inside: [number, number, number]; v: V2 }>();
  const g = plan.stilt; if (!g) return out;
  const at = new Map(g.cells.map((c) => [KEY(c.i, c.j), c])), half = g.cell / 2;
  const ctr = (i: number, j: number): V2 => [g.origin[0] + i * g.cell, g.origin[1] + j * g.cell];
  for (const b of g.blocks) for (const h of b.huts) {
    const hid = at.get(KEY(h.cell[0], h.cell[1]))?.hut; if (!hid || out.has(hid)) continue;
    const hc = ctr(...h.cell), pc = ctr(...h.porch), v: V2 = [(hc[0] - pc[0]) / g.cell, (hc[1] - pc[1]) / g.cell], y = r2(g.deckY + b.y);
    const door: [number, number, number] = [r2(pc[0] + v[0] * half), y, r2(pc[1] + v[1] * half)];
    const bed = plan.households.find((x) => x.id === hid)?.items.find((it) => it.role === "sleeping");
    let k: number = HUT_STEP_IN.max;
    if (bed) {
      const z = size?.(bed.prop), hx = z ? Math.max(z[0], z[2]) / 2 : 0.9, along = (bed.at[0] - door[0]) * v[0] + (bed.at[1] - door[2]) * v[1];
      k = Math.max(HUT_STEP_IN.min, Math.min(HUT_STEP_IN.max, along - hx - HUT_STEP_IN.clear));
    }
    out.set(hid, { door, inside: [r2(door[0] + v[0] * k), y, r2(door[2] + v[1] * k)], v });
  }
  return out;
}
export function stiltRoutes(plan: SettlementPlan, huts = 3, size?: (prop: string) => [number, number, number] | undefined, network = false): { id: string; points: [number, number, number][]; network?: true }[] {
  const g = plan.stilt; if (!g?.dryLink) return [];
  const at = new Map(g.cells.map((c) => [KEY(c.i, c.j), c])), half = g.cell / 2;
  const ctr = (i: number, j: number): V2 => [g.origin[0] + i * g.cell, g.origin[1] + j * g.cell];
  // what stands on the decks (dressing items, the gathering's ring): a body keeps its footprint + 0.5 m off each
  // (its own box, turned by its yaw, + 0.5 m: a long rack blocks a strip, not a disc as wide as it is long)
  const things = plan.areas.flatMap((a) => a.items.map((it) => { const z = size?.(it.prop); return latticeThing(it, z ? [z[0], z[2]] : undefined, a.floorY); }));
  const { nodes, cellOf, adj, sid, drop } = stiltLattice(g, things);
  const reach = stiltHutReach(plan, size);
  const path =(from: string, to: (id: string) => boolean): { pts: P3[]; end: string } | null => {
    const dist = new Map([[from, 0]]), prev = new Map<string, { u: string; via: P3[] }>(), done = new Set<string>();
    let end: string | null = null;
    while (!end) {
      let u: string | null = null, du = Infinity; for (const [k, d] of dist) if (!done.has(k) && d < du) { du = d; u = k; }
      if (u === null) return null; if (to(u)) { end = u; break; } done.add(u);
      for (const e of adj.get(u) ?? []) { const nd = du + e.w; if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { u, via: e.via }); } }
    }
    const out: P3[] = [nodes.get(end)!];
    for (let k = end; k !== from;) { const s = prev.get(k)!; out.unshift(nodes.get(s.u)!, ...s.via); k = s.u; }
    return { pts: out, end };
  };
  // drop repeats and collinear points at one height (the stick holds a straight run)
  const tidy = (pts: P3[]): P3[] => {
    const q = pts.filter((p, n) => n === 0 || Math.hypot(p[0] - pts[n - 1]![0], p[2] - pts[n - 1]![2]) > 0.3 || Math.abs(p[1] - pts[n - 1]![1]) > 0.05);
    return q.filter((p, n) => { if (n === 0 || n === q.length - 1) return true; const a = q[n - 1]!, b = q[n + 1]!; return Math.abs(a[1] - p[1]) > 0.01 || Math.abs(b[1] - p[1]) > 0.01 || Math.abs((a[0] - p[0]) * (b[2] - p[2]) - (a[2] - p[2]) * (b[0] - p[0])) > 0.01; }).map((p) => [r2(p[0]), r2(p[1]), r2(p[2])] as P3);
  };
  const toComm = path("bank", (id) => cellOf.get(id)?.kind === "communal"); if (!toComm) return [];
  const routes: { id: string; points: P3[] }[] = [{ id: "bank-to-communal", points: tidy(toComm.pts) }];
  // the huts: the highest level first, then a middle level, then the village deck (nearest the communal deck first); the
  // way in is the porch point straight out of the door
  const cands = g.blocks.flatMap((b) => b.huts.map((h) => ({ b, h, hid: at.get(KEY(h.cell[0], h.cell[1]))?.hut ?? `${b.id}-hut` })));
  const lvls = [...new Set(cands.map((x) => x.b.y))].sort((a, b) => b - a);
  const order = [...new Set([lvls[0], lvls[Math.floor(lvls.length / 2)], lvls[lvls.length - 1]].filter((v): v is number => v !== undefined)), ...lvls, ...lvls];
  const picked = new Set<string>();
  for (const lv of order) {
    if (routes.length > huts) break;
    for (const x of cands.filter((c) => c.b.y === lv && !picked.has(c.hid)).sort((a, b) => d2(ctr(...a.h.porch), plan.gathering.at) - d2(ctr(...b.h.porch), plan.gathering.at))) {
      const hc = ctr(...x.h.cell), pc = ctr(...x.h.porch), v: V2 = [(hc[0] - pc[0]) / g.cell, (hc[1] - pc[1]) / g.cell];
      const front = sid(pc[0] + v[0] * 1.5 + (v[1] ? 0.5 : 0), pc[1] + v[1] * 1.5 + (v[0] ? 0.5 : 0)), front2 = sid(pc[0] + v[0] * 1.5 - (v[1] ? 0.5 : 0), pc[1] + v[1] * 1.5 - (v[0] ? 0.5 : 0));
      const leg = path(toComm.end, (id) => id === front || id === front2); if (!leg) continue;
      picked.add(x.hid);
      const e = nodes.get(leg.end)!, y = r2(g.deckY + x.b.y), door: P3 = [pc[0] + v[0] * half, y, pc[1] + v[1] * half];
      door[0] += v[1] ? e[0] - (pc[0] + v[0] * 1.5) : 0; door[2] += v[0] ? e[2] - (pc[1] + v[1] * 1.5) : 0;
      // (stops just inside, short of the bed in the hut's middle: stiltHutReach)
      const inn = reach.get(x.hid)?.inside, k = inn ? (inn[0] - door[0]) * v[0] + (inn[2] - door[2]) * v[1] : HUT_STEP_IN.max;
      routes.push({ id: `bank-to-${x.hid}`, points: tidy([...toComm.pts, ...leg.pts.slice(1), door, [r2(door[0] + v[0] * k), y, r2(door[2] + v[1] * k)]]) });
      break;
    }
  }
  // `network`: the way to every dressing area too (handoff navigation.network: a walk gate reaches each area along it, not
  // in a straight line over water and between levels): bank -> communal deck -> the lattice point nearest the area's
  // middle on its floor level
  const out: { id: string; points: P3[]; network?: true }[] = routes;
  // (the area's nearest lattice point a body can reach from the communal deck: a point boxed in by its things is no way in)
  const reached = new Set([toComm.end]);
  if (network) { const q = [toComm.end]; while (q.length) for (const e of adj.get(q.pop()!) ?? []) if (!reached.has(e.to)) { reached.add(e.to); q.push(e.to); } }
  // (a household area with a hut is reached through the hut's door, as the hut routes go in, to just inside it: its
  // walk target is stiltHutReach, not the middle of its footprints' box, which can lie on the bed or the porch kit)
  const viaDoor = (a: SettlementPlan["areas"][number]): P3[] | null => {
    const x = a.kind === "household" && reach.has(a.id) ? cands.find((c) => c.hid === a.id) : undefined; if (!x) return null;
    const hc = ctr(...x.h.cell), pc = ctr(...x.h.porch), v: V2 = [(hc[0] - pc[0]) / g.cell, (hc[1] - pc[1]) / g.cell];
    const front = sid(pc[0] + v[0] * 1.5 + (v[1] ? 0.5 : 0), pc[1] + v[1] * 1.5 + (v[0] ? 0.5 : 0)), front2 = sid(pc[0] + v[0] * 1.5 - (v[1] ? 0.5 : 0), pc[1] + v[1] * 1.5 - (v[0] ? 0.5 : 0));
    const leg = path(toComm.end, (id) => id === front || id === front2); if (!leg) return null;
    const e = nodes.get(leg.end)!, y = r2(g.deckY + x.b.y), door: P3 = [pc[0] + v[0] * half, y, pc[1] + v[1] * half];
    door[0] += v[1] ? e[0] - (pc[0] + v[0] * 1.5) : 0; door[2] += v[0] ? e[2] - (pc[1] + v[1] * 1.5) : 0;
    // (one step inside the door, straight in: the walk's last hop to the area's middle starts clear of the jambs)
    const inn = reach.get(a.id)?.inside, k = inn ? (inn[0] - door[0]) * v[0] + (inn[2] - door[2]) * v[1] : HUT_STEP_IN.max;
    return tidy([...toComm.pts, ...leg.pts.slice(1), door, [r2(door[0] + v[0] * k), y, r2(door[2] + v[1] * k)]]);
  };
  if (network) for (const a of plan.areas) {
    const inHut = viaDoor(a); if (inHut) { out.push({ id: `to-${a.id}`, points: inHut, network: true }); continue; }
    const fy = a.floorY ?? g.deckY;
    let best: string | null = null, bd = Infinity;
    for (const id of reached) { const n = nodes.get(id)!, c = cellOf.get(id); if (!c || drop(c) || Math.abs(n[1] - fy) > 0.8) continue; const dd = d2([n[0], n[2]], a.centre); if (dd < bd) { bd = dd; best = id; } }
    if (!best || bd > 12) continue;
    const leg = path(toComm.end, (id) => id === best); if (!leg) continue;
    out.push({ id: `to-${a.id}`, points: tidy([...toComm.pts, ...leg.pts.slice(1)]), network: true });
  }
  return out;
}

/** How far a walkway's bend hub sits above the runs it joins. The runs reach 0.1 m under the hub, so the two plank
 *  slabs overlap in plan: one mesh must own each plane (zfight: same facing closer than 0.02 m), so the hub stands a
 *  clear 5 cm proud — a cross plank laid over the run ends, a step far below any stair rise. */
export const WALKWAY_HUB_LIFT = 0.05;
/** The shortest a walkway run's plank part is squeezed to (its texture stays within the 40 +- 8 texels/m standard). */
export const WALKWAY_MIN_STRETCH = 0.85;
/** How far a run that reaches on past its walk's END (onto the deck it arrives at, or out to where the bank ramp now
 *  starts) stands above the walkway level: a plank laid over the deck edge, a step far below any stair rise. The kit's
 *  plank parts carry up-facing planes at 0 / -0.12 / -0.157 / -0.18 / -0.25 and down-facing ones at -0.16 / -0.2 / -0.3 /
 *  -0.383 / -0.43, so a lift is clear of both the deck (0) and the bend hubs (WALKWAY_HUB_LIFT) only in narrow windows:
 *  0.075 measured clean (zfight 0 clusters on the Gullet's dry-link + egg-net walks; 0.07 / 0.1 / 0.2 fought). */
export const WALKWAY_END_LIFT = 0.075;
/** The kit pieces of one walkway leg: a run of the walkway part stretched to fit each straight stretch (the part is
 *  `partLen` long; `scaleZ` stretches it), a hub at every bend (yaw on the bisector, `y` = WALKWAY_HUB_LIFT). Runs stop
 *  0.1 m inside a hub's square so the joint never shows a gap; the hub's lift keeps its planes off theirs. A stretch too
 *  short to lay even after reaching under its hubs, at the walk's first or last point, reaches on past that end (`ext`
 *  [start, end] metres; `y` = WALKWAY_END_LIFT) — over the deck it arrives at; a bank ramp at that end moves out by
 *  `ext[1]` (settle). */
export function walkwayPieces(points: V2[], width: number, partLen = 4): { kind: "run" | "hub"; id: string; at: V2; yaw: number; y: number; scaleZ: number; length: number; ext?: [number, number] }[] {
  const out: { kind: "run" | "hub"; id: string; at: V2; yaw: number; y: number; scaleZ: number; length: number; ext?: [number, number] }[] = [];
  // a point the walkway runs straight through (turn < 5 deg) is no bend: a hub there would lay its plank sides in the
  // runs' side planes (zfight), so the stretch runs on through it
  const P: V2[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, q = P[P.length - 1], n = points[i + 1];
    if (q && n && i > 0) { const a0 = Math.atan2(p[1] - q[1], p[0] - q[0]), a1 = Math.atan2(n[1] - p[1], n[0] - p[0]); let t = Math.abs(a1 - a0); if (t > Math.PI) t = 2 * Math.PI - t; if (t < (5 * Math.PI) / 180) continue; }
    P.push(p);
  }
  const hh = width / 2, last = P.length - 1;
  const dirOf = (a: V2, b: V2): V2 => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const deg = (d: V2): number => (Math.atan2(d[0], d[1]) * 180) / Math.PI;
  const runLen = (k: number): number => Math.hypot(P[k + 1]![0] - P[k]![0], P[k + 1]![1] - P[k]![1]) - (k > 0 ? hh - 0.1 : 0) - (k + 1 < last ? hh - 0.1 : 0);
  /** a hub stands at bend j when the stretch leaving it is long enough to lay */
  const hubAt = (j: number): boolean => j > 0 && j < last && runLen(j) >= 0.3;
  for (let k = 0; k < last; k++) {
    const a = P[k]!, b = P[k + 1]!, d = dirOf(a, b);
    const s0 = k > 0 ? hh - 0.1 : 0, s1 = k + 1 < last ? hh - 0.1 : 0, L = Math.hypot(b[0] - a[0], b[1] - a[1]) - s0 - s1;
    if (L < 0.3) continue; // a bend too close to the next: the next hub covers both (no two hubs lie in one plane)
    {
      const n = Math.max(1, Math.round(L / partLen));
      if (n === 1 && L < WALKWAY_MIN_STRETCH * partLen) {
        // a short stretch: squeezing the plank texture below WALKWAY_MIN_STRETCH packs its texels (art-check texel); the run
        // reaches on under the (lifted) hub at each hub end instead, never past hh - 0.15 so the runs either side of a hub
        // never meet under it (one mesh owns each plane)
        const cap = hh - 0.15, hubs = (hubAt(k) ? 1 : 0) + (hubAt(k + 1) ? 1 : 0), want = WALKWAY_MIN_STRETCH * partLen - L;
        const o = hubs ? Math.min(cap, want / hubs) : 0, o0 = hubAt(k) ? o : 0, o1 = hubAt(k + 1) ? o : 0;
        // still short (a 2.45 m leg onto a deck squeezed the planks to 0.61: 51 texels/m, Gullet 2026-10-19): the walk's own
        // ends take the rest
        const left = WALKWAY_MIN_STRETCH * partLen - (L + o0 + o1), f0 = k === 0, f1 = k + 1 === last, nf = (f0 ? 1 : 0) + (f1 ? 1 : 0);
        const e0 = left > 1e-6 && f0 ? left / nf : 0, e1 = left > 1e-6 && f1 ? left / nf : 0;
        const pl = L + o0 + o1 + e0 + e1, t = s0 - o0 - e0 + pl / 2;
        out.push({ kind: "run", id: `${k}-0`, at: [a[0] + d[0] * t, a[1] + d[1] * t], yaw: deg(d), y: e0 || e1 ? WALKWAY_END_LIFT : 0, scaleZ: +(pl / partLen).toFixed(4), length: pl, ...(e0 || e1 ? { ext: [+e0.toFixed(3), +e1.toFixed(3)] as [number, number] } : {}) });
      } else {
        const pl = L / n;
        for (let m = 0; m < n; m++) { const t = s0 + (m + 0.5) * pl; out.push({ kind: "run", id: `${k}-${m}`, at: [a[0] + d[0] * t, a[1] + d[1] * t], yaw: deg(d), y: 0, scaleZ: +(pl / partLen).toFixed(4), length: pl }); }
      }
    }
    if (k > 0) { const din = dirOf(P[k - 1]!, a), bis: V2 = [din[0] + d[0], din[1] + d[1]]; out.push({ kind: "hub", id: `hub-${k}`, at: [a[0], a[1]], yaw: deg(Math.hypot(...bis) > 0.01 ? bis : d), y: WALKWAY_HUB_LIFT, scaleZ: 1, length: width }); }
  }
  return out;
}

/** Deck cells a prop may stand on (the same height floor, no hut, walkway or ramp): its footprint keeps `edge` m off every
 *  side that is not such a cell (rails, drops, hut walls, walkway shoulders). */
/** stiltFloorFree `hut` value that admits the walkways too (a creature group may stand on one). */
export const WALKWAY = "*walkway*";
/** stiltFloorFree `hut` value for a family's boat dock (a landing cell; its ladder side and a lane from the deck kept clear). */
export const DOCK = "*dock*";
/** `tight`: a hut door's lane only 1 m deep across its porch, a dock's ladder lane its only clear band (a crowded
 *  family's last resort for a required thing). */
export function stiltFloorFree(grid: StiltGrid, tight = false): (p: V2, edge: number, hut?: string, level?: number, lane?: number) => boolean {
  const at = new Map(grid.cells.map((c) => [`${c.i},${c.j}`, c]));
  // porch sides a hut door opens from: "i,j,face toward the hut"
  const doors = new Set(grid.blocks.flatMap((b) => b.huts.map((h) => `${h.porch[0]},${h.porch[1]},${faceOf(h.cell[0] - h.porch[0], h.cell[1] - h.porch[1])}`)));
  // a porch entered from ONE deck side only (a strip, a dead end): half its width stays clear from that side to the door
  const deckOn = (c: StiltCell | undefined, y: number): boolean => !!c && (c.kind === "platform" || c.kind === "communal" || c.kind === "work") && !c.fit && (c.y ?? 0) === y;
  const porches = new Set(grid.blocks.flatMap((b) => b.huts.map((h) => `${h.porch[0]},${h.porch[1]}`)).filter((k) => { const c = at.get(k); return !!c && Object.values(FACES).filter((v) => deckOn(at.get(`${c.i + v[0]},${c.j + v[1]}`), c.y ?? 0)).length === 1; }));
  // a deck cell crossed THROUGH (same-height deck on two opposite sides, a rail or hut wall on at least one other): its walk
  // lane runs down the half by the open arm (a T) and things keep to the closed side — the hut wall (a porch's door side) first
  const through = new Map<string, readonly [number, number]>(), OPP: Record<Face, Face> = { px: "nx", nx: "px", pz: "nz", nz: "pz" };
  // (the communal deck is a square walked round its ring, not a strip crossed: its cells keep no crossing lane)
  for (const c of grid.cells) {
    if (!deckOn(c, c.y ?? 0) || c.kind === "communal") continue;
    // a side one walks in by: same-height deck, a walkway port (open), a stair or ramp landing along its slope
    const on = (Object.keys(FACES) as Face[]).filter((f) => { const n = at.get(`${c.i + FACES[f][0]},${c.j + FACES[f][1]}`); return deckOn(n, c.y ?? 0) || !!c.open?.includes(f) || (!!n && (n.kind === "stair" || n.kind === "ramp") && (n.face === f || FACE_DEG[n.face as Face] === (FACE_DEG[f] + 180) % 360)); });
    // an axis crossed: two opposite sides one walks in by (a full crossing, deck on all four sides, is wide enough)
    const axis = (["px", "pz"] as Face[]).find((f) => on.includes(f) && on.includes(OPP[f]));
    if (!axis) continue;
    const sides = (Object.keys(FACES) as Face[]).filter((f) => f !== axis && f !== OPP[axis]);
    if (sides.every((f) => on.includes(f))) continue;
    const closed = sides.filter((f) => !on.includes(f));
    // ... else the side away from a walkway port in the side of its run (the way in runs along that side)
    const portSide = closed.find((f) => grid.cells.some((o) => o.ref === c.ref && (o.y ?? 0) === (c.y ?? 0) && !!o.open?.includes(f)));
    const keep = closed.find((f) => at.get(`${c.i + FACES[f][0]},${c.j + FACES[f][1]}`)?.kind === "hut") ?? (portSide && closed.includes(OPP[portSide]) ? OPP[portSide] : closed.find((f) => f !== portSide) ?? closed[0]!);
    through.set(`${c.i},${c.j}`, FACES[keep]);
  }
  // `level`: only deck at that height over the village deck (a household keeps its kit on its own compound's level)
  // `lane`: how far into a crossed strip's keep half a thing stands (0.6 m; an optional extra keeps 0.9 m, off the walk
  // line a dress map draws down the open half)
  return (p, edge, hut, level, lane = 0.6) => {
    const floorKind = (c?: StiltCell): boolean => !!c && (level === undefined || (c.y ?? 0) === level) && (hut === DOCK ? c.kind === "landing" && c.ref.endsWith("-dock") : hut === WALKWAY ? c.kind !== "hut" && c.kind !== "ramp" && c.kind !== "stair" && c.kind !== "landing" : hut ? c.kind === "hut" && c.hut === hut : c.kind === "platform" || c.kind === "communal" || c.kind === "work");
    const i = Math.round((p[0] - grid.origin[0]) / grid.cell), j = Math.round((p[1] - grid.origin[1]) / grid.cell), c = at.get(`${i},${j}`);
    if (!floorKind(c) || c!.fit) return false;
    const u = [p[0] - c!.at[0], p[1] - c!.at[1]], half = grid.cell / 2;
    // a crossed strip: the thing's centre at least 0.6 m into its keep half, so a body passes down the other
    const tk = !hut || hut === WALKWAY ? through.get(`${i},${j}`) : undefined;
    // (a work deck's racks stand back toward its far rail: their near edge up to 0.4 m short of its middle, 0.85 m of
    // deck left clear inside the near rail)
    if (tk && u[0]! * tk[0] + u[1]! * tk[1] < (c!.kind === "work" ? -0.4 : lane)) return false;
    for (const [f, v] of Object.entries(FACES)) {
      const n = at.get(`${i + v[0]},${j + v[1]}`);
      // an entrance keeps a lane clear into the cell: a stair or ramp landing here along its slope, a walkway's port, a hut
      // door (its lane as wide as the way in, across the porch), a mooring ladder
      const slope = !!n && (n.kind === "stair" || n.kind === "ramp") && (n.face === f || FACE_DEG[n.face as Face] === (FACE_DEG[f as Face] + 180) % 360);
      // (a tight dock gives up its half band: only the ladder lane stays clear)
      const enter = (porches.has(`${i},${j}`) || (hut === DOCK && !tight && c!.kind === "landing")) && deckOn(n, c!.y ?? 0);
      // (a joint: deck of another compound or the communal deck at this height, walked across like a walkway's port)
      const joint = !hut && deckOn(n, c!.y ?? 0) && n!.ref !== c!.ref;
      const door = doors.has(`${i},${j},${f}`), lane = slope ? 0.9 : c!.open?.includes(f as Face) || joint ? 0.8 : door ? 0.6 : c!.moor === f || (hut === DOCK && c!.face === f) ? 0.7 : 0, deep = door ? (tight ? 1.0 : 2.2) : slope ? 1.2 : 1.0;
      if (lane) { const along = half - (u[0]! * v[0] + u[1]! * v[1]), lat = Math.abs(u[0]! * v[1] - u[1]! * v[0]); if (along < deep + edge && lat < lane + edge * 0.5) return false; }
      // the strip is crossed down its left half (looking in from the deck it is entered from): things keep to the right
      if (enter && u[0]! * v[1] - u[1]! * v[0] > -0.15) return false;
      if (floorKind(n) && (n!.y ?? 0) === (c!.y ?? 0) && !n!.fit && (hut !== DOCK || n!.ref === c!.ref)) continue;
      // a hut wall on this floor is a wall, not a rail: a thing stands by it (0.6 m off: the wall and its eaves stand ~0.5 m into this cell), not the rail's 1 m
      const wall = !!n && n.kind === "hut" && (n.y ?? 0) === (c!.y ?? 0);
      if (half - (u[0]! * v[0] + u[1]! * v[1]) < (wall ? Math.min(edge, 0.6) : edge)) return false;
    }
    return true;
  };
}

// ---------------------------------------------------------------------------------------------------------- planner

export function planSettlement(input: SettleInput, ground: SettleGround): SettlementPlan {
  const info = input.props ?? ((): undefined => undefined);
  // a prop the catalogue mounts on a surface (a dish on a table) cannot stand on the ground: floor props only, where known
  const floorOnly = (ids: string[]): string[] => { const f = ids.filter((id) => { const m = info(id)?.mount; return !m || m === "floor"; }); return f.length ? f : ids; };
  const parsed = settlementCultureSchema.parse(input.culture);
  const culture: SettlementCulture = { ...parsed, household: parsed.household.map((u) => ({ ...u, props: floorOnly(u.props) })), work: parsed.work.map((w) => ({ ...w, props: floorOnly(w.props) })) };
  const seed = input.seed ?? 1, rnd = rng(seed), warn: SettleFinding[] = [];
  const { grid: G, survey } = surveySettlement(ground, input.centre, input.radius, input.step ?? 2);
  const stilt = culture.ground === "stilt";
  const dw = culture.dwelling;
  const foot: V2 = dw.kind === "prefab" ? dw.footprint : [dw.cell[0], dw.cell[2]];
  const footR = Math.hypot(foot[0], foot[1]) / 2;
  const pads = new Map(survey.pads.map((p) => [p.id, p]));
  const usable = survey.pads.filter((p) => p.area >= culture.minPadArea);
  const approach: V2 = input.anchors?.approach ?? (() => {
    // the approach: where dry land meets the survey rim nearest the centre's highest ground, else due south
    let best: V2 = [input.centre[0], input.centre[1] - input.radius], bs = -Infinity;
    for (let a = 0; a < 32; a++) { const t = (a / 32) * 2 * Math.PI, p: V2 = [input.centre[0] + Math.cos(t) * input.radius * 0.98, input.centre[1] + Math.sin(t) * input.radius * 0.98], k = cellAt(G, p); if (k >= 0 && G.kind[k] === DRY && G.h[k]! > bs) { bs = G.h[k]!; best = p2(p); } }
    return best;
  })();

  // ---- candidate dwelling spots on the culture's ground
  interface Cand { at: V2; pad: number; score: number }
  const cands: Cand[] = [];
  if (!stilt) {
    const stride = Math.max(1, Math.round(2 / G.step));
    for (let k = 0; k < G.kind.length; k += 1) {
      if (G.kind[k] !== DRY || (k % G.cols) % stride || Math.floor(k / G.cols) % stride) continue;
      const pad = pads.get(G.pad[k]!); if (!pad || pad.area < culture.minPadArea) continue;
      const at = posOf(G, k);
      if (!fits(G, at, footR + culture.clear.margin, culture.maxSlope)) continue;
      const wy = Number.isNaN(G.w[k]!) ? (survey.waterLevel ?? G.h[k]! - 5) : G.w[k]!;
      const over = G.h[k]! - wy, edge = waterEdge(G, at, 30);
      const toEdge = edge ? d2(edge, at) : 30;
      let score = 0;
      switch (culture.ground) {
        case "hummock": score = over * 4 + Math.log(pad.area) - G.slope[k]! * 0.1; break;
        case "bank": score = -Math.abs(toEdge - 6) * 0.4 + Math.min(over, 3) - G.slope[k]! * 0.1; break;
        case "ledge": score = over * 0.3 - G.slope[k]! * 0.2; break;
        default: score = -G.slope[k]! * 0.3 - d2(at, input.centre) * 0.01;
      }
      cands.push({ at, pad: pad.id, score: score + rnd() * 0.3 });
    }
    cands.sort((a, b) => b.score - a.score);
    if (!cands.length) warn.push({ code: "no-ground", message: `no ${culture.ground} ground for a ${foot[0]}x${foot[1]} m dwelling (slope <= ${culture.maxSlope}°, pads >= ${culture.minPadArea} m²) within ${input.radius} m` });
  }

  // ---- the gathering spot first
  let gatherAt: V2 | null = input.anchors?.gather ?? null;
  let gatherPad = -1;
  if (!gatherAt) {
    if (stilt) {
      // open water at kit depth nearest the centre with room for the communal deck
      const wf = dw as z.infer<typeof wfcDwellingSchema>;
      const half = (Math.max(...wf.communal) * wf.cell[0] * 1.42) / 2;
      let best: V2 | null = null, bs = Infinity;
      for (let k = 0; k < G.kind.length; k += 2) { if (G.kind[k] !== WET) continue; const p = posOf(G, k); if (!fits(G, p, half + 2, 90, WET)) continue; const s = d2(p, input.centre); if (s < bs) { bs = s; best = p; } }
      gatherAt = best ?? input.centre;
      if (!best) warn.push({ code: "no-water", message: "no open water at the centre for the communal deck" });
    } else {
      const gr = culture.gathering.radius;
      let best: Cand | null = null, bs = -Infinity;
      for (const c of cands) {
        if (!fits(G, c.at, Math.min(gr, 12), culture.maxSlope + 4)) continue;
        const area = pads.get(c.pad)!.area, s = Math.log(area) * 3 - d2(c.at, input.centre) / (input.radius * 0.25) + c.score * 0.2;
        if (s > bs) { bs = s; best = c; }
      }
      gatherAt = best?.at ?? cands[0]?.at ?? input.centre;
      gatherPad = best?.pad ?? cands[0]?.pad ?? -1;
    }
  } else gatherPad = G.pad[Math.max(0, cellAt(G, gatherAt))] ?? -1;
  const gather = p2(gatherAt);
  // an isle home stands on the near side of its isle, toward the gathering ring (read from the ring, a short ford over)
  if (culture.ground === "hummock") {
    for (const c of cands) { const pad = pads.get(c.pad); if (pad && fits(G, c.at, footR + culture.clear.margin + 2.5, culture.maxSlope)) c.score += (d2(pad.centroid, gather) - d2(c.at, gather)) * 0.6; }
    cands.sort((a, b) => b.score - a.score);
  }
  const gFacing = norm([approach[0] - gather[0], approach[1] - gather[1]]);
  const gItems: SettleItem[] = [];
  const g = culture.gathering;
  const hearthPart = stilt && dw.kind === "wfc" ? dw.hearth : undefined;
  if (!hearthPart) g.centre.forEach((prop, n) => gItems.push({ id: `gather-centre-${n + 1}`, role: n === 0 && g.kind === "hearth" ? "fire" : "centre", prop, at: n === 0 ? gather : p2([gather[0] + (n % 2 ? 2.5 : -2.5), gather[1]]), yaw: yawToward(gFacing) }));
  if (g.ring) for (let n = 0; n < g.ring.count; n++) {
    const t = Math.atan2(gFacing[1], gFacing[0]) + Math.PI + ((n + 0.5) / g.ring.count) * 2 * Math.PI * (g.head.length ? 0.86 : 1) + (g.head.length ? Math.PI * 0.14 : 0);
    const p: V2 = [gather[0] + Math.cos(t) * g.ring.radius, gather[1] + Math.sin(t) * g.ring.radius];
    gItems.push({ id: `gather-ring-${n + 1}`, role: "ring", prop: g.ring.props[n % g.ring.props.length]!, at: p2(p), yaw: yawToward([gather[0] - p[0], gather[1] - p[1]]) });
  }
  // (on a stilt communal deck the head stands inside its rails: 1.6 m in from the deck edge)
  const headR = Math.min((g.ring?.radius ?? 4) + 1.5, stilt && dw.kind === "wfc" ? (Math.min(...dw.communal) * dw.cell[0]) / 2 - 1.6 : Infinity);
  g.head.forEach((prop, n) => { const p: V2 = [gather[0] - gFacing[0] * headR, gather[1] - gFacing[1] * headR]; gItems.push({ id: `gather-head-${n + 1}`, role: "head", prop, at: p2(p), yaw: yawToward(gFacing) }); });

  // ---- clusters and households
  const H = Math.max(1, input.households);
  const C = culture.onePerPad ? H : Math.max(1, Math.min(H, input.clusters ?? Math.ceil(H / 3)));
  const perCluster = Array.from({ length: C }, (_, c) => Math.floor(H / C) + (c < H % C ? 1 : 0));
  const clusters: SettlementPlan["clusters"] = [];
  const households: SettleHousehold[] = [];
  let stiltGrid: StiltGrid | undefined;
  const edgeFrom = (pad?: number) => (from: V2): V2 | null => waterEdge(G, from, culture.yardRadius * 2.5, pad);
  const waterAt = (p: V2): number | null => { const k = cellAt(G, p); return k >= 0 && !Number.isNaN(G.w[k]!) ? r2(G.w[k]!) : null; };
  const hAt = (p: V2): number => r2(G.h[Math.max(0, cellAt(G, p))]!);
  // an area is as big as what it holds: the middle of its footprints' box, out to the farthest footprint + the rim band
  const halfDiag = (it: SettleItem): number => { const z = info(it.prop)?.size; return z ? Math.hypot(z[0], z[2]) / 2 : it.role === "dwelling" ? footR : 0.9; };
  const fitArea = (its: SettleItem[], extra: V2[] = []): { centre: V2; radius: number } => {
    const xs = [...its.flatMap((it) => [it.at[0] - halfDiag(it), it.at[0] + halfDiag(it)]), ...extra.map((p) => p[0])], zs = [...its.flatMap((it) => [it.at[1] - halfDiag(it), it.at[1] + halfDiag(it)]), ...extra.map((p) => p[1])];
    const c: V2 = xs.length ? p2([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2]) : [0, 0];
    return { centre: c, radius: r2(Math.max(3, ...its.map((it) => d2(it.at, c) + halfDiag(it) + AREA_RIM), ...extra.map((p) => d2(p, c) + AREA_RIM))) };
  };
  // a deck village is floor nearly wall to wall inside an area (its neighbours' decks and the walkways count): the whole disc
  const needIn = (radius: number): number => defaultMinItems(Math.PI * radius * radius * (stilt ? 1 : OPEN_SHARE));
  // a loose container past an area's floor-clutter budget turns into a non-loose prop its unit offers, else is left out
  // (a required one stays): `alts` are the unit's props, `must` whether it is required
  const isLoose = (id: string): boolean => info(id)?.loose === true;
  const trimLoose = (its: SettleItem[], alts: (it: SettleItem) => string[], must: (it: SettleItem) => boolean): SettleItem[] => {
    // the budget of the floor a site map will measure, counted low (a deck loses its rails, huts and walkway shoulders)
    const budget = defaultLooseBudget(Math.PI * fitArea(its).radius ** 2 * 0.5, "camp");
    let n = 0;
    return its.filter((it) => {
      if (!isLoose(it.prop)) return true;
      if (n < budget || must(it)) { n++; return true; }
      const alt = alts(it).find((p) => !isLoose(p));
      if (alt) { it.prop = alt; return true; }
      return false;
    });
  };

  if (stilt) {
    const wf = dw as z.infer<typeof wfcDwellingSchema>;
    // compounds of 1-3 huts (the households split by the grammar, not --clusters)
    stiltGrid = layoutStiltGrid(G, culture, wf, input, gather, approach, compoundSizes(H, rnd), warn, rnd);
    let hn = 0;
    const cellAtIJ = new Map(stiltGrid.cells.map((c) => [`${c.i},${c.j}`, c]));
    for (const b of stiltGrid.blocks) {
      const hs: string[] = [];
      for (const h of b.huts) {
        const id = `h${++hn}`, cellIJ = h.cell, g0 = stiltGrid;
        const ctr = (i: number, j: number): V2 => [g0.origin[0] + i * g0.cell, g0.origin[1] + j * g0.cell];
        // the hut's middle (a 2x2 hut: the middle of its four cells), its door on the porch side of the door cell
        const at: V2 = h.cells.reduce((s, [i, j]) => [s[0] + ctr(i, j)[0] / h.cells.length, s[1] + ctr(i, j)[1] / h.cells.length] as V2, [0, 0] as V2);
        const f = FACES[h.door] as unknown as V2, dc = ctr(cellIJ[0], cellIJ[1]), door: V2 = p2([dc[0] + f[0] * g0.cell * 0.5, dc[1] + f[1] * g0.cell * 0.5]);
        for (const [i, j] of h.cells) { const c = cellAtIJ.get(`${i},${j}`); if (c) c.hut = id; }
        // the kit goes on the porch deck in front of the door, not inside the hut (the resolver keeps it on the deck)
        const porch = ctr(h.porch[0], h.porch[1]);
        const items = householdKit(id, { ...culture, household: culture.household.map((u) => ({ ...u, place: u.place === "water-edge" ? "yard" : u.place })) }, porch, f, [1.2, 1.2], hn, () => null, gather);
        const footprint: V2 = h.size === "2x2" ? [g0.cell * 2, g0.cell * 2] : [g0.cell, g0.cell];
        households.push({ id, cluster: b.id, pad: -1, dwelling: { at: p2(at), yaw: yawToward(f), footprint, door, cell: cellIJ, tile: h.size }, items, ground: hAt(at), water: waterAt(at) });
        hs.push(id);
      }
      clusters.push({ id: b.id, centre: b.centre, households: hs });
    }
  } else {
    const used: V2[] = [gather], usedPads = new Set<number>(culture.onePerPad && gatherPad >= 0 ? [gatherPad] : []);
    const [cmin, cmax] = culture.onePerPad ? culture.householdSpacing : culture.clusterSpacing;
    const centres: { at: V2; pad: number }[] = [];
    if (!culture.onePerPad && C === 1) centres.push({ at: gather, pad: gatherPad });
    else for (let c = 0; c < C; c++) {
      let pick: Cand | null = null;
      // the core clusters (the culture's core share of the households) stand within its core radius of the gathering
      const inCore = !culture.onePerPad && c < Math.ceil(C * culture.core.share);
      for (const relax of [1, 1.5, 2.2]) {
        for (const k of cands) {
          if (culture.onePerPad && usedPads.has(k.pad)) continue;
          if (d2(k.at, input.centre) > input.radius - footR) continue;
          if (inCore && d2(k.at, gather) > culture.core.radius * relax) continue;
          const near = Math.min(...used.map((u) => d2(u, k.at)));
          if (near < cmin || near > cmax * relax) continue;
          pick = k; break;
        }
        if (pick) { if (relax > 1) warn.push({ code: "spacing-relaxed", message: `cluster ${c + 1}: no spot within ${cmax} m of the village; took one ${relax}x further` }); break; }
      }
      if (!pick) { warn.push({ code: "too-few-sites", message: `only ${c} of ${C} ${culture.onePerPad ? "households (one per pad)" : "clusters"} found ${culture.ground} ground ${cmin}-${cmax} m apart` }); break; }
      centres.push({ at: pick.at, pad: pick.pad }); used.push(pick.at); usedPads.add(pick.pad);
    }
    let hn = 0;
    centres.forEach((cc, c) => {
      const id = `c${c + 1}`, n = culture.onePerPad ? 1 : perCluster[c]!, hs: string[] = [];
      const spots: V2[] = [];
      if (n === 1 && cc.at !== gather) spots.push(cc.at);
      else {
        // round the cluster centre (the fire, for a camp) at the household spacing, the approach side left open
        const [smin, smax] = culture.householdSpacing, ring = Math.max(smin, Math.min(smax, (smin + smax) / 2));
        const base = Math.atan2(gFacing[1], gFacing[0]);
        for (let a = 0, tries = 0; spots.length < n && tries < 72; tries++) {
          const t = base + Math.PI * 0.35 + ((a + tries * 0.37) / Math.max(n, 3)) * Math.PI * 1.3 + rnd() * 0.2;
          const rr = ring * (0.85 + rnd() * 0.3);
          const p: V2 = [cc.at[0] + Math.cos(t) * rr, cc.at[1] + Math.sin(t) * rr];
          if (!fits(G, p, footR + culture.clear.margin, culture.maxSlope) || spots.some((s) => d2(s, p) < smin) || d2(p, gather) < (cc.at === gather ? smin : culture.gathering.radius)) continue;
          spots.push(p); a++;
        }
        if (spots.length < n) warn.push({ code: "cluster-short", message: `cluster ${id}: ${spots.length} of ${n} dwellings fit round its centre` });
      }
      for (const s of spots) {
        const hid = `h${++hn}`;
        const faceTo = n === 1 ? gather : cc.at === gather ? gather : cc.at;
        const f = norm([faceTo[0] - s[0], faceTo[1] - s[1]]);
        const prop = (dw as z.infer<typeof prefabDwellingSchema>).props[(hn - 1) % (dw as z.infer<typeof prefabDwellingSchema>).props.length]!;
        const sz = info(prop)?.size, fp: V2 = sz ? [r2(sz[0]), r2(sz[2])] : foot;
        const door: V2 = p2([s[0] + f[0] * (fp[1] / 2 + 0.6), s[1] + f[1] * (fp[1] / 2 + 0.6)]);
        const padId = G.pad[Math.max(0, cellAt(G, s))]!;
        const items = householdKit(hid, culture, s, f, fp, hn - 1, edgeFrom(padId >= 0 ? padId : undefined), gather);
        households.push({ id: hid, cluster: id, pad: padId, dwelling: { prop, at: p2(s), yaw: yawToward(f), footprint: fp, door }, items, ground: hAt(s), water: waterAt(s) });
        hs.push(hid);
      }
      clusters.push({ id, centre: p2(cc.at), households: hs });
    });
  }
  if (households.length < H) warn.push({ code: "households-short", message: `${households.length} of ${H} households placed` });
  for (const h of households) h.items = trimLoose(h.items, (it) => culture.household.filter((u) => u.role === it.role).flatMap((u) => u.props), (it) => it.role === "storage" && culture.household.some((u) => u.role === "storage" && u.required));

  // ---- work areas
  const work: SettlementPlan["work"] = [];
  // a work yard keeps off the lanes the paths lay later (approach -> gathering -> each cluster -> each household): a yard
  // on a ford lane puts its props under the lane
  const laneHalf = Math.max(culture.paths.width, 2.4) / 2 + 1;
  const workLanes: [V2, V2][] = [[approach, gather], ...clusters.flatMap((c) => [[gather, c.centre] as [V2, V2], ...c.households.map((hid) => [c.centre, households.find((h) => h.id === hid)?.dwelling.at ?? c.centre] as [V2, V2])])];
  for (const w of culture.work) {
    const onLane = (p: V2): boolean => !stilt && workLanes.some(([a, b]) => d2(a, b) > 0.5 && segDist2(p, a, b) < w.radius + laneHalf);
    let at: V2 | null = null;
    if (stilt && stiltGrid && (w.where === "water-edge" || w.where === "edge")) {
      const cells = stiltGrid.cells.filter((c) => c.kind === "work" && c.ref === w.id);
      // its racks start from the run's far end: the middle of the cells no walkway arrives at (the way in stays clear)
      const inner = cells.filter((c) => !c.open?.length), use = inner.length ? inner : cells;
      if (cells.length) at = p2([(use[0]!.at[0] + use[use.length - 1]!.at[0]) / 2, (use[0]!.at[1] + use[use.length - 1]!.at[1]) / 2]);
      // ... nudged 0.6 m toward the way in (the clear middle the racks stand either side of leans to the entry)
      const door = cells.filter((c) => c.open?.length).sort((p, q) => d2(p.at, at!) - d2(q.at, at!))[0];
      if (at && door && inner.length) { const v = norm([door.at[0] - at[0], door.at[1] - at[1]]); at = p2([at[0] + v[0] * 0.6, at[1] + v[1] * 0.6]); }
    } else if (w.where === "resource") at = input.anchors?.[`work:${w.id}`] ?? null;
    else if (w.where === "water-edge") {
      // the dry water edge nearest the gathering spot that no household yard holds, off the lanes
      let best: V2 | null = null, bs = Infinity;
      for (let k = 0; k < G.kind.length; k++) {
        if (G.kind[k] !== DRY) continue;
        if (![k + 1, k - 1, k + G.cols, k - G.cols].some((q) => G.kind[q] === WET)) continue;
        const p = posOf(G, k); if (households.some((h) => d2(h.dwelling.at, p) < culture.yardRadius + w.radius) || work.some((x) => d2(x.at, p) < x.radius + w.radius)) continue;
        if (G.slope[k]! > culture.maxSlope + 6 || dryShare(G, p, 4) < 0.5 || onLane(p)) continue;
        const s = d2(p, gather); if (s < bs && s > culture.gathering.radius + 4) { bs = s; best = p; }
      }
      at = best;
    } else {
      const dir: V2 = w.where === "downwind" ? norm(culture.wind) : w.where === "edge" ? norm([gather[0] - approach[0], gather[1] - approach[1]]) : [0, 0];
      const reach = w.where === "dry" ? 0 : Math.max(culture.clusterSpacing[1], culture.gathering.radius + w.radius + 6);
      const target: V2 = [gather[0] + dir[0] * reach, gather[1] + dir[1] * reach];
      let best: V2 | null = null, bs = Infinity;
      for (const c of stilt ? [] : cands) {
        if (households.some((h) => d2(h.dwelling.at, c.at) < culture.yardRadius + w.radius) || d2(c.at, gather) < culture.gathering.radius + w.radius || work.some((x) => d2(x.at, c.at) < x.radius + w.radius) || onLane(c.at)) continue;
        const s = d2(c.at, target); if (s < bs) { bs = s; best = c.at; }
      }
      if (stilt) {
        // a dry-ground job for a stilt village (a hatchery on the sand): the dry pad nearest the land link
        const from = stiltGrid?.dryLink ?? approach;
        let bd = Infinity;
        for (let k = 0; k < G.kind.length; k++) { if (G.kind[k] !== DRY) continue; const p = posOf(G, k); if (!fits(G, p, Math.min(4, w.radius / 2), culture.maxSlope + 6)) continue; const s = d2(p, from); if (s < bd && s > 6) { bd = s; best = p; } }
      }
      at = best;
    }
    if (!at) { warn.push({ code: "work-unplaced", message: `work area ${w.id} (${w.where}) found no ground${w.where === "resource" ? `: pass --anchor work:${w.id}=x,z` : ""}` }); continue; }
    at = p2(at);
    const wc = stiltGrid?.cells.filter((c) => c.kind === "work" && c.ref === w.id) ?? [];
    const toG = norm([gather[0] - at[0], gather[1] - at[1]]), side: V2 = wc.length >= 2 ? norm([wc[wc.length - 1]!.at[0] - wc[0]!.at[0], wc[wc.length - 1]!.at[1] - wc[0]!.at[1]]) : [toG[1], -toG[0]];
    // a work yard packs its props in a tight block (rows across the way to the gathering), a deck lines them along its run:
    // a yard is as big as what it holds, so it reads worked, not empty
    const pitch = Math.max(2.2, ...w.props.map((id) => { const z = info(id)?.size; return z ? Math.max(z[0], z[2]) + 0.5 : 2.2; }));
    const deckRun = wc.length >= 2, runLen = deckRun ? d2(wc[0]!.at, wc[wc.length - 1]!.at) + (stiltGrid?.cell ?? 4) - 2 : 0;
    const lay = (count: number): SettleItem[] => {
      const ncol = deckRun ? count : Math.ceil(Math.sqrt(count)), nrow = Math.ceil(count / ncol);
      return Array.from({ length: count }, (_, n) => {
        const o = ((n % ncol) - (ncol - 1) / 2) * (deckRun ? Math.max(2.2, runLen / count) : pitch), r = (Math.floor(n / ncol) - (nrow - 1) / 2) * pitch;
        const p: V2 = [at![0] + side[0] * o + toG[0] * r, at![1] + side[1] * o + toG[1] * r];
        return { id: `${w.id}-${n + 1}`, role: "work", prop: w.props[n % w.props.length]!, at: p2(p), yaw: yawToward(toG) };
      });
    };
    // a yard on the ground holds as much as its size asks (`dress check` room-sparse), up to 6 things; a deck run is sized to its props
    let count = w.count, items = lay(count);
    while (!deckRun && count < 6 && needIn(fitArea(items).radius) > count) items = lay(++count);
    items = trimLoose(items, () => w.props, () => false);
    work.push({ id: w.id, at, items, radius: w.radius });
  }

  // ---- defences: an arc across the approach side, beyond the outermost homes
  const defences: SettleItem[] = [];
  if (culture.defences) {
    const reachOut = Math.max(culture.gathering.radius, ...households.map((h) => { const v: V2 = [h.dwelling.at[0] - gather[0], h.dwelling.at[1] - gather[1]]; return v[0] * gFacing[0] + v[1] * gFacing[1]; })) + culture.yardRadius;
    const base = Math.atan2(gFacing[1], gFacing[0]), n = culture.defences.count, span = (culture.defences.spacing * (n - 1)) / reachOut;
    for (let i = 0; i < n; i++) {
      const t = base - span / 2 + (n > 1 ? (span * i) / (n - 1) : 0);
      const p: V2 = [gather[0] + Math.cos(t) * reachOut, gather[1] + Math.sin(t) * reachOut];
      defences.push({ id: `defence-${i + 1}`, role: "defence", prop: culture.defences.props[i % culture.defences.props.length]!, at: p2(p), yaw: yawToward([p[0] - gather[0], p[1] - gather[1]]) });
    }
  }

  // ---- paths: one graph — approach → gathering → clusters (MST) → households, work areas off the nearest node
  const paths: SettlePath[] = [];
  // a lane ends in front of a doorway (its half width + margin out), never through the dwelling
  // a lane keeps its kept-clear half width (+0.6 margin) off the dwelling's farthest corner (half its diagonal)
  const laneW = Math.max(culture.paths.width, 2.4);
  const keepR = (h: SettleHousehold): number => Math.hypot(h.dwelling.footprint[0], h.dwelling.footprint[1]) / 2 + laneW / 2 + 0.6 + 0.3;
  // the lane's end in front of the door stands outside that ring, so a lane leaving it sideways does not brush the walls
  const front = (h: SettleHousehold): V2 => { const t = (h.dwelling.yaw * Math.PI) / 180, o = Math.max(laneW / 2 + 0.9, keepR(h) + 0.4 - d2(h.dwelling.door, h.dwelling.at)); return p2([h.dwelling.door[0] + Math.sin(t) * o, h.dwelling.door[1] + Math.cos(t) * o]); };
  const depthAlong = (a: V2, b: V2): number => { let m = 0; const n = Math.max(2, Math.ceil(d2(a, b) / G.step)); for (let i = 0; i <= n; i++) { const p: V2 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n], k = cellAt(G, p); if (k >= 0 && G.kind[k] === WET) m = Math.max(m, G.w[k]! - G.h[k]!); } return r2(m); };
  const leg = (id: string, from: string, to: string, a: V2, b: V2): void => {
    if (d2(a, b) < 3) return;
    const maxDepth = depthAlong(a, b);
    const kind: SettlePath["kind"] = culture.paths.kind === "walkway" ? "walkway" : maxDepth > 0.05 ? (maxDepth <= culture.paths.maxWade ? "ford" : "raft") : "track";
    // a lane never runs through a dwelling: where it would pass one, it bends round it on the near side
    const width = laneW, pts: V2[] = [a, b];
    for (let pass = 0; pass < 16; pass++) {
      let hit: { k: number; q: V2 } | null = null;
      for (let k = 0; k + 1 < pts.length && !hit; k++) for (const h of households) {
        if (!h.dwelling.prop) continue;
        const R = keepR(h), A = pts[k]!, B = pts[k + 1]!;
        const dx = B[0] - A[0], dz = B[1] - A[1], l2 = dx * dx + dz * dz || 1, t = ((h.dwelling.at[0] - A[0]) * dx + (h.dwelling.at[1] - A[1]) * dz) / l2;
        // an end inside the ring cannot be bent round (the lane starts or ends there)
        if (t <= 0 || t >= 1) continue;
        const c: V2 = [A[0] + t * dx, A[1] + t * dz], dd = d2(c, h.dwelling.at);
        if (dd >= R) continue;
        const nrm = dd > 0.01 ? norm([c[0] - h.dwelling.at[0], c[1] - h.dwelling.at[1]]) : norm([-dz, dx]);
        hit = { k, q: [h.dwelling.at[0] + nrm[0] * R * 1.1, h.dwelling.at[1] + nrm[1] * R * 1.1] }; break;
      }
      if (!hit) break;
      pts.splice(hit.k + 1, 0, hit.q);
    }
    paths.push({ id, kind, from, to, points: pts.map(p2), width, maxDepth });
  };
  if (stilt && stiltGrid) {
    // a walkway's lane is its run over the water (stub point to stub point): the deck it arrives on keeps its own rail band clear
    for (const w of stiltGrid.walks) paths.push({ id: w.id, kind: "walkway", from: w.from, to: w.to, points: w.points.length ? w.points.slice(1, w.ramp || w.to === "dry-link" ? undefined : -1) : [], width: w.width, maxDepth: 0 });
    if (stiltGrid.dryLink && d2(stiltGrid.dryLink, approach) > 6) leg("approach", "approach", "dry-link", approach, stiltGrid.dryLink);
    // dry-ground work (a hatchery on the sand) hangs off the bank landing
    for (const w of work) if (!stiltGrid.cells.some((c) => c.kind === "work" && c.ref === w.id)) leg(`dry-link-${w.id}`, stiltGrid.dryLink ? "dry-link" : "gathering", w.id, stiltGrid.dryLink ?? gather, w.at);
  } else {
    leg("approach", "approach", "gathering", approach, [gather[0] + gFacing[0] * culture.gathering.radius, gather[1] + gFacing[1] * culture.gathering.radius]);
    const nodes = [{ id: "gathering", at: gather }, ...clusters.filter((c) => d2(c.centre, gather) >= 0.5).map((c) => ({ id: c.id, at: c.households.length === 1 ? front(households.find((h) => h.id === c.households[0])!) : c.centre }))];
    const inTree = new Set(["gathering"]);
    while (inTree.size < nodes.length) {
      let e: { a: (typeof nodes)[number]; b: (typeof nodes)[number]; d: number } | null = null;
      for (const a of nodes) if (inTree.has(a.id)) for (const b of nodes) if (!inTree.has(b.id)) { const d = d2(a.at, b.at); if (!e || d < e.d) e = { a, b, d }; }
      if (!e) break; inTree.add(e.b.id);
      leg(`${e.a.id}-${e.b.id}`, e.a.id, e.b.id, e.a.at, e.b.at);
    }
    for (const c of clusters) {
      // a cluster centred on the gathering spot (a camp round its fire) hangs its homes off the gathering node
      const from = d2(c.centre, gather) < 0.5 ? "gathering" : c.id;
      for (const hid of c.households) {
        const h = households.find((x) => x.id === hid)!;
        if (c.households.length === 1 && from !== "gathering") paths.push({ id: `${from}-${hid}`, kind: "track", from, to: hid, points: [], width: Math.max(culture.paths.width, 2.4), maxDepth: 0 });
        else if (d2(h.dwelling.at, c.centre) > 3) leg(`${from}-${hid}`, from, hid, c.centre, front(h));
        else paths.push({ id: `${from}-${hid}`, kind: "track", from, to: hid, points: [], width: Math.max(culture.paths.width, 2.4), maxDepth: 0 });
      }
    }
    for (const w of work) {
      const near = [{ id: "gathering", at: gather }, ...households.map((h) => ({ id: h.id, at: front(h) }))].sort((a, b) => d2(a.at, w.at) - d2(b.at, w.at))[0]!;
      leg(`${near.id}-${w.id}`, near.id, w.id, near.at, w.at);
    }
  }

  // ---- creature spots, sized by tier
  const creatures: SettleCreatureSpot[] = [];
  const cr = culture.creatures;
  for (let n = 0; n < cr.atGathering; n++) creatures.push({ id: `gathering${n ? `-${n + 1}` : ""}`, at: p2([gather[0] - gFacing[0] * 3 * n, gather[1] - gFacing[1] * 3 * n]), radius: cr.radius, why: "at the gathering spot" });
  const deckSpot = (cid: string, fallback: V2): V2 => { const cs = stiltGrid?.cells.filter((x) => x.ref === cid && x.kind === "platform" && !x.fit) ?? []; return cs.length ? cs.reduce((b, x) => (d2(x.at, fallback) < d2(b.at, fallback) ? x : b)).at : fallback; };
  for (const c of clusters) for (let n = 0; n < cr.perCluster; n++) creatures.push({ id: `${c.id}${n ? `-${n + 1}` : ""}`, at: stilt ? deckSpot(c.id, c.centre) : c.centre, radius: cr.radius, why: `household cluster ${c.id}` });
  for (const w of work) if (culture.work.find((x) => x.id === w.id)?.creature) creatures.push({ id: w.id, at: w.at, radius: Math.max(cr.radius * 0.8, w.radius), why: `work area ${w.id}` });
  const tierMin = input.tier?.minCreatureGroups ?? 0;
  if (creatures.length < tierMin) warn.push({ code: "creatures-short", message: `${creatures.length} creature spots; a ${input.tier!.id} place needs ${tierMin}` });

  // ---- every footprint on open ground (or deck) of its own: dry, off the lanes and kept-clear discs this plan writes,
  // off the doors, off each other. A spot that fails moves to the nearest that holds (a ring prop slides round its ring).
  const lanes = paths.filter((p) => p.points.length >= 2).map((p) => ({ pts: p.points, half: p.width / 2 + 0.6 }));
  const discs: { at: V2; r: number }[] = [
    ...(g.ring && !g.centre.length ? [{ at: gather, r: Math.max(2, g.ring.radius - 3) }] : []),
    ...households.map((h) => ({ at: h.dwelling.door, r: stilt ? 1.1 : 1.2 })),
  ];
  const segDist = (p: V2, a: V2, b: V2): number => { const dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz); };
  const deckFreeWide = stilt && stiltGrid ? stiltFloorFree(stiltGrid) : null, deckFreeTight = stilt && stiltGrid ? stiltFloorFree(stiltGrid, true) : null;
  let deckFree = deckFreeWide; // swapped for deckFreeTight while a required thing tries a crowded porch's last room
  let extraLane: number | undefined; // a crossed strip's keep-half depth while an optional extra is placed
  let deckLevel: number | undefined; // the deck level the item being placed must stand on (its household's)
  const levelOf = (h: SettleHousehold): number | undefined => (stilt ? stiltGrid?.cells.find((x) => x.i === h.dwelling.cell?.[0] && x.j === h.dwelling.cell?.[1])?.y ?? 0 : undefined);
  const placed: { c: V2; hw: number; hd: number; yaw: number }[] = [];
  const sizeOf = (prop: string, role: string): [number, number] => { const s = info(prop)?.size; return s ? [s[0], s[2]] : role === "dwelling" ? foot : [1.2, 1.2]; };
  const corners = (c: V2, hw: number, hd: number, yaw: number): V2[] => { const cs = Math.cos((yaw * Math.PI) / 180), sn = Math.sin((yaw * Math.PI) / 180); const out: V2[] = []; for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) { const x = a * hw, z = b * hd; out.push([c[0] + x * cs + z * sn, c[1] - x * sn + z * cs]); } return out; };
  const overlaps = (A: { c: V2; hw: number; hd: number; yaw: number }, B: { c: V2; hw: number; hd: number; yaw: number }): boolean => corners(A.c, A.hw, A.hd, A.yaw).some((p) => { const cs = Math.cos((B.yaw * Math.PI) / 180), sn = Math.sin((B.yaw * Math.PI) / 180), dx = p[0] - B.c[0], dz = p[1] - B.c[1]; return Math.abs(dx * cs - dz * sn) < B.hw && Math.abs(dx * sn + dz * cs) < B.hd; });
  const pointOk = (p: V2, solid: boolean, deck: boolean, hut?: string): boolean => {
    // rails stand 0.3 m inside a deck cell's edge and measure ~0.75 m in (their posts and the grade test); hut walls 0.3 m
    if (deck && deckFree) { if (!deckFree(p, hut && hut !== WALKWAY && hut !== DOCK ? 0.6 : 1.0, hut, deckLevel, extraLane)) return false; }
    else { const k = cellAt(G, p); if (k < 0 || G.kind[k] !== DRY || G.slope[k]! > culture.maxSlope + 10) return false; const wy = ground.water(p[0], p[1]); if ((wy != null && wy > ground.height(p[0], p[1]) - 0.05) || ground.blocked?.(p[0], p[1])) return false; }
    if (!solid) return true;
    return !lanes.some((l) => l.pts.slice(1).some((b, i) => segDist(p, l.pts[i]!, b) < l.half)) && !discs.some((d) => d2(p, d.at) < d.r);
  };
  const fitsAt = (c: V2, hw: number, hd: number, yaw: number, solid: boolean, deck: boolean, hut?: string): boolean => {
    const box = { c, hw: hw + 0.15, hd: hd + 0.15, yaw };
    const m = deck ? 0 : 0.35;
    return corners(c, hw + m, hd + m, yaw).every((p) => pointOk(p, solid, deck, hut)) && !placed.some((q) => overlaps(box, q) || overlaps(q, box));
  };
  const settleItem = (it: SettleItem, ring?: { at: V2; r: number }, deck = !!deckFree, size?: [number, number], solidIn?: boolean, reach = deck ? 4 : 9, hut?: string, quiet = false): boolean => {
    // on a deck grid a loose prop sits square to the planks (quarter turns); a ring prop still faces its ring's middle
    if (deck && !ring) it.yaw = Math.round(it.yaw / 90) * 90;
    const [w, d] = size ?? sizeOf(it.prop, it.role), hw = w / 2, hd = d / 2, solid = solidIn ?? info(it.prop)?.solid !== false;
    const cands: V2[] = [it.at];
    if (ring) { const t0 = Math.atan2(it.at[1] - ring.at[1], it.at[0] - ring.at[0]); for (let n = 1; n <= 24; n++) for (const s of [1, -1]) { const t = t0 + s * n * (0.6 / ring.r); cands.push([ring.at[0] + Math.cos(t) * ring.r, ring.at[1] + Math.sin(t) * ring.r]); } }
    // rings 0.25 m apart, points ~0.35 m apart round each: a strip of deck under a metre wide is still found
    for (let rr = 0.25; rr <= reach + 1e-9; rr += 0.25) { const m = Math.max(8, Math.ceil((2 * Math.PI * rr) / 0.35)); for (let a = 0; a < m; a++) { const t = (a / m) * 2 * Math.PI; cands.push([it.at[0] + Math.cos(t) * rr, it.at[1] + Math.sin(t) * rr]); } }
    // a ring prop faces the ring's middle; a loose prop may turn a quarter where its own heading does not fit
    for (const c of cands) for (const turn of ring ? [0] : [0, 90]) {
      const yaw = ring ? yawToward([ring.at[0] - c[0], ring.at[1] - c[1]]) : it.yaw + turn;
      if (!fitsAt(c, hw, hd, yaw, solid, deck, hut)) continue;
      it.at = p2(c); it.yaw = yaw; placed.push({ c, hw: hw + 0.15, hd: hd + 0.15, yaw });
      return true;
    }
    if (!quiet) warn.push({ code: "item-no-room", message: `${it.id} (${it.prop}, ${w.toFixed(1)} x ${d.toFixed(1)} m) found no open ${deck ? "deck" : "dry ground"} clear of the lanes within ${reach} m of its spot` });
    return false;
  };
  // the dwellings first (they never move: a prefab dwelling's footprint is held), then the gathering, households, work
  // a kit hearth's fire pan is built: nothing stands on it, solids keep its fire clearance
  if (hearthPart) { placed.push({ c: gather, hw: 1.6, hd: 1.6, yaw: 0 }); discs.push({ at: gather, r: 2.8 }); }
  for (const h of households) if (h.dwelling.prop) placed.push({ c: h.dwelling.at, hw: h.dwelling.footprint[0] / 2 + 0.15, hd: h.dwelling.footprint[1] / 2 + 0.15, yaw: h.dwelling.yaw });
  // a two-storey hut's inside ladder stands 0.8 m behind its middle (the door wall's far side), 1.2 m wide: nothing
  // stands on it (the 0.15 m every placed thing keeps off it is the foot room)
  if (stiltGrid) for (const b of stiltGrid.blocks) for (const u of b.huts) {
    const hid = stiltGrid.cells.find((x) => x.i === u.cell[0] && x.j === u.cell[1])?.hut, h = households.find((x) => x.id === hid);
    if (!u.top || !h) continue;
    const ya = (h.dwelling.yaw * Math.PI) / 180;
    placed.push({ c: p2([h.dwelling.at[0] - Math.sin(ya) * 0.75, h.dwelling.at[1] - Math.cos(ya) * 0.75]), hw: 0.65, hd: 0.15, yaw: h.dwelling.yaw });
  }
  for (let n = gItems.length - 1; n >= 0; n--) { const it = gItems[n]!; if (!settleItem(it, it.role === "ring" && g.ring ? { at: gather, r: g.ring.radius } : undefined) && it.role === "ring") gItems.splice(n, 1); }
  // the bed goes in first (the hut's middle), then the required things, then any other: a crowded porch drops an
  // optional thing, never a required one
  const roleRank = (it: SettleItem): number => (stilt && it.role === "sleeping" ? 0 : culture.household.some((u) => u.role === it.role && u.required) ? 1 : 2);
  const bedOf = new Map<string, SettleItem>();
  const sleepProps = culture.household.filter((u) => u.role === "sleeping").flatMap((u) => u.props);
  // a family's boat dock (its landing cell) holds a bundle, a trap or a store when its porch is full
  const dockAt = (h: SettleHousehold): V2 | null => { if (!stiltGrid) return null; for (const b of stiltGrid.blocks) for (const u of b.huts) if (u.dock && stiltGrid.cells.find((x) => x.i === u.cell[0] && x.j === u.cell[1])?.hut === h.id) return p2([stiltGrid.origin[0] + u.dock[0] * stiltGrid.cell, stiltGrid.origin[1] + u.dock[1] * stiltGrid.cell]); return null; };
  const onDock = (h: SettleHousehold, it: SettleItem, props: string[]): boolean => { const at = dockAt(h); if (!at) return false; for (const prop of props) { const t = { ...it, prop, at }; if (settleItem(t, undefined, true, undefined, undefined, 2.5, DOCK, true)) { Object.assign(it, t); return true; } } return false; };
  // every spot for a thing of size `sz` on a family's own compound deck at its level, inside a cell: 0.3 m off a side the
  // same deck goes on from, 0.85 m off any other (a rail's posts, a hut wall and its eaves, a stair's side stand ~0.75 m
  // into the cell), hugging the hut first and a cell's
  // middle last (a required thing's last resort; the caller checks the box, the lanes and the walk lattice)
  const familySpots = (h: SettleHousehold, sz: [number, number], lvl: number): { c: V2; yaw: number; s: number }[] => {
    const SG = stiltGrid; if (!SG) return [];
    const blk = SG.blocks.find((b) => b.huts.some((u) => SG.cells.find((c) => c.i === u.cell[0] && c.j === u.cell[1])?.hut === h.id)), hutAt = h.dwelling.at;
    const spots: { c: V2; yaw: number; s: number }[] = [];
    for (const c of SG.cells) {
      if (!blk || c.ref !== blk.id || c.kind !== "platform" || c.fit || (c.y ?? 0) !== lvl) continue;
      const off = (f: Face): number => { const n = SG.cells.find((x) => x.i === c.i + FACES[f][0] && x.j === c.j + FACES[f][1]); return n && !n.fit && (n.y ?? 0) === (c.y ?? 0) && (n.kind === "platform" || n.kind === "communal" || n.kind === "work") ? 0.3 : 0.85; };
      for (const yaw of [0, 90]) { const hw = (yaw ? sz[1] : sz[0]) / 2, hd = (yaw ? sz[0] : sz[1]) / 2; for (let dx = -SG.cell / 2 + hw + off("nx"); dx <= SG.cell / 2 - hw - off("px") + 1e-9; dx += 0.5) for (let dz = -SG.cell / 2 + hd + off("nz"); dz <= SG.cell / 2 - hd - off("pz") + 1e-9; dz += 0.5) { const p: V2 = p2([c.at[0] + dx, c.at[1] + dz]); spots.push({ c: p, yaw, s: d2(p, hutAt) + (Math.abs(dx) + Math.abs(dz) < 1 ? 3 : 0) }); } }
    }
    return spots.sort((a, b) => a.s - b.s);
  };
  const misfit = new Set<SettleItem>(); // things left at their grammar spot (no room found by the lane rules)
  for (const h of households) h.items = [...h.items].sort((a, b) => roleRank(a) - roleRank(b)).filter((it) => {
    deckLevel = levelOf(h);
    // on a stilt compound the sleeping place is inside the family's own hut (its middle first), the rest on the porch deck
    if (stilt && it.role === "sleeping") {
      // the unit's own bed first, then any other bedding it offers that fits the hut (a rolled mat in a small hut)
      const beds = [it.prop, ...culture.household.filter((u) => u.role === "sleeping").flatMap((u) => u.props).filter((p) => p !== it.prop)];
      for (const prop of beds) {
        const back = { ...it, prop, at: h.dwelling.at };
        if (settleItem(back, undefined, true, undefined, undefined, 3, h.id, true)) { it.at = back.at; it.yaw = back.yaw; it.prop = prop; bedOf.set(h.id, it); return true; }
      }
      // a bed that does not fit the hut is left out (never laid on the porch or a walkway)
      if (!culture.household.some((u) => u.role === "sleeping" && u.required)) return false;
    }
    // a required thing that finds no room by its spot looks further (a free back-row cell of its compound) before it is left where the grammar put it
    const must = culture.household.some((u) => u.role === it.role && u.required);
    // on a stilt compound the kit keeps to the family's porch, then its dock (cells that stay anyway), before it spreads
    // over deck that would otherwise be trimmed away
    if (stilt && deckFree) {
      const was = { ...it };
      if (settleItem(it, undefined, undefined, undefined, undefined, 1.75, undefined, true)) return true;
      Object.assign(it, was);
      if ((it.role === "storage" || it.role === "work" || it.role === "light") && onDock(h, it, [it.prop])) return true;
      Object.assign(it, was);
    }
    if (settleItem(it, undefined, undefined, undefined, undefined, undefined, undefined, must)) return true;
    if (!must) return false;
    const alts = [it.prop, ...culture.household.filter((u) => u.role === it.role).flatMap((u) => u.props).filter((p) => p !== it.prop).sort((a, b) => { const sa = sizeOf(a, it.role), sb = sizeOf(b, it.role); return sa[0] * sa[1] - sb[0] * sb[1]; })];
    const tryAlts = (reach: number, hut?: string, at?: V2): boolean => { for (const prop of alts) { const alt = { ...it, prop, ...(at ? { at } : {}) }; if (settleItem(alt, undefined, undefined, undefined, undefined, reach, hut, true)) { Object.assign(it, alt); return true; } } return false; };
    if (!deckFree) { if (tryAlts(14)) return true; return settleItem(it, undefined, undefined, undefined, undefined, 14) || must; }
    // on a deck: further along the compound (never so far the area sprawls), then storage inside the family's hut, then
    // the porch with the door lane cut to 1 m; a thing that still finds no deck stays at its grammar spot, warned (the
    // dress check then names the clash)
    if (tryAlts(6)) return true;
    const stow = it.role === "storage" || it.role === "work"; // a store, a trap or a bundle may be kept inside the hut
    // in a back corner (side wall + back wall), the rest of the hut left for its bed
    // (as far in as its own footprint allows off the walls: two things share a 4 m hut, one in each back corner)
    const sz0 = sizeOf(it.prop, it.role), k0 = Math.max(0.3, Math.min(0.8, 1.38 - Math.max(sz0[0], sz0[1]) / 2));
    const ya = (h.dwelling.yaw * Math.PI) / 180, wallSide: V2 = p2([h.dwelling.at[0] + Math.cos(ya) * k0 - Math.sin(ya) * k0, h.dwelling.at[1] - Math.sin(ya) * k0 - Math.cos(ya) * k0]);
    if (stow && tryAlts(3, h.id, wallSide)) return true;
    // a hut its bed fills: the store goes in first and the smallest bedding that still fits beside it (the bed as it
    // was when neither fits)
    const bed = bedOf.get(h.id);
    if (stow && bed) {
      const k = placed.findIndex((q) => d2(q.c, bed.at) < 0.02), held = k >= 0 ? placed.splice(k, 1)[0]! : null, was = { ...bed }, itWas = { ...it };
      if (tryAlts(3, h.id, wallSide)) {
        const small = [...sleepProps].sort((a, b) => { const sa = sizeOf(a, "sleeping"), sb = sizeOf(b, "sleeping"); return sa[0] * sa[1] - sb[0] * sb[1]; });
        for (const prop of small) { const t = { ...bed, prop, at: h.dwelling.at }; if (settleItem(t, undefined, true, undefined, undefined, 3, h.id, true)) { Object.assign(bed, t); return true; } }
        // no bed beside it: the bed stays and the store keeps looking
        placed.pop(); Object.assign(it, itWas);
      }
      Object.assign(bed, was); if (held) placed.push(held);
    }
    if ((stow || it.role === "light") && onDock(h, it, alts)) return true; // a torch lights the boat landing
    deckFree = deckFreeTight; const ok = tryAlts(6) || ((stow || it.role === "light") && onDock(h, it, alts)); deckFree = deckFreeWide;
    if (ok) return true;
    // last: inside the family's own hut, in either back corner (a lamp lit indoors, a store by the wall), the bed swapped
    // for its smallest bedding when that makes the room
    const otherSide: V2 = p2([h.dwelling.at[0] - Math.cos(ya) * k0 - Math.sin(ya) * k0, h.dwelling.at[1] + Math.sin(ya) * k0 - Math.cos(ya) * k0]);
    if (tryAlts(3, h.id, otherSide) || tryAlts(3, h.id, wallSide)) return true;
    if (bed) {
      const k = placed.findIndex((q) => d2(q.c, bed.at) < 0.02), held = k >= 0 ? placed.splice(k, 1)[0]! : null, was = { ...bed }, itWas = { ...it };
      if (tryAlts(3, h.id, otherSide) || tryAlts(3, h.id, wallSide)) {
        const small = [...sleepProps].sort((a, b) => { const sa = sizeOf(a, "sleeping"), sb = sizeOf(b, "sleeping"); return sa[0] * sa[1] - sb[0] * sb[1]; });
        for (const prop of small) { const t = { ...bed, prop, at: h.dwelling.at }; if (settleItem(t, undefined, true, undefined, undefined, 3, h.id, true)) { Object.assign(bed, t); return true; } }
        placed.pop(); Object.assign(it, itWas);
      }
      Object.assign(bed, was); if (held) placed.push(held);
    }
    // (the ways-clear pass looks again for it, on its family's deck, in its hut or on its dock: a spot that walls nothing off)
    misfit.add(it);
    warn.push({ code: "item-no-room", message: `${it.id} (${it.prop}) found no open deck within 6 m of its spot, even inside the hut, on its dock or with the door lane cut to 1 m: left at its grammar spot` });
    return true;
  });
  // a household area that came out bigger than its kit fills (a big hut, a bed inside it) takes one more of its kit's
  // non-loose things (work first, a light last) by its middle until it holds what its size asks (up to 6). `keep`: the
  // top-up after the ways-clear pass takes a thing only where it walls no way off
  const pri = ["work", "boat", "shrine", "seat", "other", "marker", "light"];
  const extraKit = culture.household.filter((u) => u.role !== "sleeping" && u.role !== "storage").sort((a, b) => pri.indexOf(a.role) - pri.indexOf(b.role)).flatMap((u) => u.props.map((p) => ({ role: u.role, prop: p }))).filter((x) => !isLoose(x.prop));
  const topUp = (h: SettleHousehold, keep?: () => boolean): void => {
    deckLevel = levelOf(h);
    const kit = (): SettleItem[] => [...(h.dwelling.prop ? [{ id: "dwelling", role: "dwelling", prop: h.dwelling.prop, at: h.dwelling.at, yaw: h.dwelling.yaw }] : []), ...h.items];
    // (a thing taken goes back out when `keep` says it walls a way off)
    const take = (it: SettleItem): boolean => { h.items.push(it); if (!keep || keep()) return true; h.items.pop(); placed.pop(); return false; };
    for (let tries = 0, n = 0; tries < 6 && kit().length < 6 && needIn(fitArea(kit()).radius) > kit().length; tries++) {
      const x = extraKit[n++ % extraKit.length]!;
      let k = 1; while (h.items.some((i) => i.id === `${h.id}-extra-${k}`)) k++;
      const it: SettleItem = { id: `${h.id}-extra-${k}`, role: x.role, prop: x.prop, at: fitArea(kit()).centre, yaw: h.dwelling.yaw };
      // anywhere on the family's deck inside the area (it is measured that wide), but not so far out that the wider
      // area asks for more than the thing adds
      const area0 = fitArea(kit()), reach = stilt ? Math.max(4, area0.radius - 1) : undefined;
      extraLane = 0.9; const got = settleItem(it, undefined, undefined, undefined, undefined, reach, undefined, true); extraLane = undefined;
      if (got) {
        const need1 = needIn(fitArea([...kit(), it]).radius);
        if (!stilt || need1 <= kit().length + 1 || need1 <= needIn(area0.radius)) { if (take(it)) continue; }
        else placed.pop();
      }
      // a full porch: a stilt family keeps one more store, trap or bundle inside its hut instead (the smallest first), and, in the
      // last top-up, a lamp lit indoors (a 4 m hut its bed fills still has a back corner for a torch)
      if (!stilt) continue;
      const small = (a: { role: string; prop: string }, b: { role: string; prop: string }): number => { const sa = sizeOf(a.prop, a.role), sb = sizeOf(b.prop, b.role); return sa[0] * sa[1] - sb[0] * sb[1]; };
      const kitOf = (roles: string[]): { role: string; prop: string }[] => culture.household.filter((u) => roles.includes(u.role)).flatMap((u) => u.props.map((prop) => ({ role: u.role, prop }))).filter((x) => !isLoose(x.prop)).sort(small);
      const kept = [...kitOf(["storage", "work"]), ...(keep ? kitOf(["light"]) : [])];
      let stowed = false;
      for (const x of kept) { const ins: SettleItem = { ...it, role: x.role, prop: x.prop, at: h.dwelling.at }; if (settleItem(ins, undefined, true, undefined, undefined, 3, h.id, true) && take(ins)) { stowed = true; break; } }
      if (!stowed) for (const x of kept) { const ins: SettleItem = { ...it, role: x.role, prop: x.prop }; if (onDock(h, ins, [x.prop]) && take(ins)) { stowed = true; break; } }
      // (the last top-up: a crowded dock's half band too, only its ladder lane kept clear)
      if (!stowed && keep) { deckFree = deckFreeTight; for (const x of kept) { const ins: SettleItem = { ...it, role: x.role, prop: x.prop }; if (onDock(h, ins, [x.prop]) && take(ins)) break; } deckFree = deckFreeWide; }
    }
  };
  if (extraKit.length) for (const h of households) topUp(h);
  deckLevel = stilt ? 0 : undefined;
  const onDeck = (w: { id: string }): boolean => !!stiltGrid?.cells.some((c) => c.kind === "work" && c.ref === w.id);
  for (const w of work) {
    // a work deck keeps its middle (the area centre, where the way in arrives) clear: its racks stand either side of it
    const mid = onDeck(w) ? discs.push({ at: w.at, r: 1.0 }) : 0;
    w.items = w.items.filter((it) => settleItem(it, undefined, onDeck(w)));
    if (mid) discs.splice(mid - 1, 1);
    // a yard on the ground that came out bigger than its things fill (they moved to open ground) takes one more of
    // its props by its middle, non-loose first, until it holds what its size asks (up to 6)
    const unit = culture.work.find((x) => x.id === w.id);
    if (onDeck(w) || !unit) continue;
    const order = [...unit.props.filter((p) => !isLoose(p)), ...unit.props.filter(isLoose)];
    for (let tries = 0, n = w.items.length; tries < 8 && w.items.length < 6 && w.items.length && needIn(fitArea(w.items).radius) > w.items.length; tries++) {
      let k = w.items.length + 1; while (w.items.some((x) => x.id === `${w.id}-${k}`)) k++;
      const it: SettleItem = { id: `${w.id}-${k}`, role: "work", prop: order[n++ % order.length]!, at: fitArea(w.items).centre, yaw: w.items[0]!.yaw };
      if (settleItem(it, undefined, false, undefined, undefined, undefined, undefined, true)) w.items.push(it);
    }
  }
  // the defence line keeps off the homes, their kit and the lanes like every other thing (on the ground: the arc's ends
  // swing past the outermost homes' sides); one that finds no room stays at its grammar spot, warned
  if (!stilt) for (const d of defences) settleItem(d, undefined, false);
  deckLevel = undefined;
  // creature spots last: a 1.6 m standing square of open floor of its own, near where the grammar put it
  for (const c of creatures) {
    const w = work.find((x) => x.id === c.id), deck = stilt ? (w ? onDeck(w) : true) : false;
    const spot: SettleItem = { id: `creatures-${c.id}`, role: "creatures", prop: "", at: c.at, yaw: 0 };
    if (settleItem(spot, undefined, deck, [1.6, 1.6], false, 14, deck ? WALKWAY : undefined)) c.at = spot.at;
  }
  discs.push(...creatures.map((c) => ({ at: c.at, r: CREATURE_KEEP })));
  // every thing on the decks as the walk lattice sees it (its own box + 0.5 m at its floor's height)
  const latticeOf = (): { t: LatticeThing; it: { at: V2 } }[] => {
    const dy = stiltGrid?.deckY ?? 0;
    return [
      ...gItems.map((it) => ({ it, t: latticeThing(it, sizeOf(it.prop, it.role), dy) })),
      ...households.flatMap((h) => [...(h.dwelling.prop ? [{ prop: h.dwelling.prop, role: "dwelling", at: h.dwelling.at, yaw: h.dwelling.yaw }] : []), ...h.items].map((it) => ({ it, t: latticeThing(it, sizeOf(it.prop, it.role), dy + (levelOf(h) ?? 0)) }))),
      ...work.flatMap((w) => w.items.map((it) => ({ it, t: latticeThing(it, sizeOf(it.prop, it.role), onDeck(w) ? dy : undefined) }))),
    ];
  };
  const latticeThings = (): LatticeThing[] => latticeOf().map((x) => x.t);
  // ways clear: from the communal deck a body reaches every hut door, stair, dock, mooring and walkway end on the 1 m walk
  // lattice, and joined decks keep a lane across their border. A thing that walls one off moves (a free spot that walls
  // nothing off, its family's hut, its dock) or, if optional, goes; a required thing that finds nowhere stays, warned.
  if (stiltGrid) {
    const SG = stiltGrid, cellIt = (p: V2): StiltCell | undefined => SG.cells.find((c) => Math.abs(c.at[0] - p[0]) <= SG.cell / 2 && Math.abs(c.at[1] - p[1]) <= SG.cell / 2);
    const reqRoles = new Set<string>(culture.household.filter((u) => u.required).map((u) => u.role));
    // (a required role's only thing in its household is required; a second store or lamp is not)
    type Own = { it: SettleItem; list: SettleItem[]; rank: number; y?: number; lvl: number; h?: SettleHousehold; box?: (typeof placed)[number] };
    const own = (): Own[] => [
      ...households.flatMap((h) => h.items.map((it) => ({ it, list: h.items, rank: reqRoles.has(it.role) && h.items.filter((x) => x.role === it.role).length === 1 ? 3 : 0, y: SG.deckY + (levelOf(h) ?? 0), lvl: levelOf(h) ?? 0, h }))),
      ...gItems.filter((it) => it.role !== "fire" && it.role !== "hearth").map((it) => ({ it, list: gItems, rank: 1, y: SG.deckY, lvl: 0 })),
      ...work.filter((w) => onDeck(w) && w.items.length > 1).flatMap((w) => w.items.map((it) => ({ it, list: w.items, rank: 2, y: SG.deckY, lvl: 0 }))),
    ].filter((o) => { const c = cellIt(o.it.at); return !!c && c.kind !== "hut" && c.kind !== "landing"; });
    const thingsOf = latticeOf, things = latticeThings;
    const lift = (o: Own): void => { const k = o.list.indexOf(o.it); if (k >= 0) o.list.splice(k, 1); const b = placed.findIndex((q) => d2(q.c, o.it.at) < 0.02); o.box = b >= 0 ? placed.splice(b, 1)[0] : undefined; };
    const put = (o: Own): void => { o.list.push(o.it); if (o.box) placed.push(o.box); };
    const failing = (): Set<string> => new Set(stiltUnreached(SG, things()).map((f) => f.id));
    const structural = new Set<string>(), stuck = new Set<string>();
    // a thing lifted off the decks looks for a spot where `ok` holds (no way walled off): its own prop within 6 m (a
    // required thing also a smaller one of its role, then 10 m), its family's deck, its hut or its dock
    const relocate = (o: Own, ok: () => boolean): boolean => {
      const was = { ...o.it };
      // its old spot held clear while it looks (it walled the way off there)
      const hold = o.box ? { ...o.box, hw: o.box.hw + 0.4, hd: o.box.hd + 0.4 } : { c: was.at, hw: 1, hd: 1, yaw: 0 };
      const holds = [hold]; placed.push(hold);
      let done = false;
      deckLevel = o.lvl;
      // its own prop within 6 m; a required thing also a smaller one of its role, then up to 10 m off
      const props = o.rank === 3 ? [was.prop, ...culture.household.filter((u) => u.role === was.role).flatMap((u) => u.props).filter((p) => p !== was.prop).sort((a, b) => { const sa = sizeOf(a, was.role), sb = sizeOf(b, was.role); return sa[0] * sa[1] - sb[0] * sb[1]; })] : [was.prop];
      for (const [prop, reach] of [...props.map((p) => [p, 6] as const), ...(o.rank === 3 ? props.map((p) => [p, 10] as const) : [])]) {
        for (let n = 0; n < 3 && !done; n++) {
          o.it.prop = prop; o.it.at = was.at; o.it.yaw = was.yaw;
          if (!settleItem(o.it, undefined, true, undefined, undefined, reach, undefined, true)) break;
          o.list.push(o.it);
          if (ok()) { done = true; break; }
          o.list.splice(o.list.indexOf(o.it), 1); const bad = placed.pop()!, h2 = { ...bad, hw: bad.hw + 0.4, hd: bad.hd + 0.4 }; holds.push(h2); placed.push(h2);
        }
        if (done) break;
      }
      if (!done) Object.assign(o.it, was);
      // a required thing with no room by the lane rules: any spot on its family's deck at its level (inside a cell, 0.3 m
      // off its edges, its middle on open deck, clear of every other thing) that walls nothing off, hugging a hut wall first
      if (!done && o.rank === 3 && o.h) {
        const sz = sizeOf(was.prop, was.role), spots = familySpots(o.h, sz, o.lvl);
        let tries = 0;
        for (const sp of spots) {
          const box = { c: sp.c, hw: sz[0] / 2 + 0.15, hd: sz[1] / 2 + 0.15, yaw: sp.yaw };
          if (placed.some((q) => overlaps(box, q) || overlaps(q, box)) || !deckFreeWide?.(sp.c, 0.5, undefined, o.lvl)) continue;
          if (++tries > 60) break;
          o.it.at = sp.c; o.it.yaw = sp.yaw; o.list.push(o.it);
          if (ok()) { placed.push(box); done = true; break; }
          o.list.splice(o.list.indexOf(o.it), 1);
        }
        if (!done) Object.assign(o.it, was);
      }
      // a store, a trap, a bundle or a lamp goes in the family's hut or on its dock
      if (!done && o.h && (o.it.role === "storage" || o.it.role === "work" || o.it.role === "light")) {
        // (the hut's middle, then either back corner off its walls)
        const h = o.h, t2 = { ...o.it, at: h.dwelling.at }, ya = (h.dwelling.yaw * Math.PI) / 180, sz = sizeOf(t2.prop, t2.role), k0 = Math.max(0.3, Math.min(0.8, 1.38 - Math.max(sz[0], sz[1]) / 2));
        const corner = (sd: number): V2 => p2([h.dwelling.at[0] + sd * Math.cos(ya) * k0 - Math.sin(ya) * k0, h.dwelling.at[1] - sd * Math.sin(ya) * k0 - Math.cos(ya) * k0]);
        const inHut = (at: V2): boolean => { const x = { ...t2, at }; if (!settleItem(x, undefined, true, undefined, undefined, 3, h.id, true)) return false; Object.assign(t2, x); return true; };
        // (a required thing may take a crowded dock's half band: only its ladder lane kept clear)
        const tightDock = (): boolean => { if (o.rank !== 3) return false; deckFree = deckFreeTight; const r = onDock(h, t2, [t2.prop]); deckFree = deckFreeWide; return r; };
        if (inHut(h.dwelling.at) || inHut(corner(1)) || inHut(corner(-1)) || onDock(h, t2, [t2.prop]) || tightDock()) { Object.assign(o.it, t2); o.list.push(o.it); if (ok()) done = true; else { o.list.splice(o.list.indexOf(o.it), 1); placed.pop(); Object.assign(o.it, was); } }
        // a required thing last: the hut shared side by side, the store (a smaller one of its role next) along one side
        // wall and the bed (its smallest bedding first) along the other, both long ways to the door, the middle lane to the door left clear
        const bed = h.items.find((x) => x.role === "sleeping");
        if (!done && o.rank === 3 && bed) {
          const k = placed.findIndex((q) => d2(q.c, bed.at) < 0.02), held = k >= 0 ? placed.splice(k, 1)[0]! : null, bedWas = { ...bed };
          const side = (sd: number): V2 => p2([h.dwelling.at[0] + sd * Math.cos(ya) * 0.85, h.dwelling.at[1] - sd * Math.sin(ya) * 0.85]);
          const beds = [...sleepProps].sort((a, b) => { const sa = sizeOf(a, "sleeping"), sb = sizeOf(b, "sleeping"); return sa[0] * sa[1] - sb[0] * sb[1]; });
          for (const prop of props) for (const sd of [1, -1]) {
            if (done) break;
            const t3 = { ...o.it, prop, at: side(sd), yaw: h.dwelling.yaw + 90 };
            if (!settleItem(t3, undefined, true, undefined, undefined, 0.75, h.id, true)) continue;
            let laid = false;
            for (const prop of beds) { const b = { ...bed, prop, at: side(-sd), yaw: h.dwelling.yaw + 90 }; if (settleItem(b, undefined, true, undefined, undefined, 0.75, h.id, true)) { Object.assign(bed, b); laid = true; break; } }
            if (!laid) { placed.pop(); continue; }
            Object.assign(o.it, t3); o.list.push(o.it);
            if (ok()) { done = true; continue; }
            o.list.splice(o.list.indexOf(o.it), 1); placed.pop(); placed.pop(); Object.assign(o.it, was); Object.assign(bed, bedWas);
          }
          if (!done) { Object.assign(bed, bedWas); if (held) placed.push(held); }
        }
      }
      // the holds go (they were only for this search)
      for (const x of holds) { const k = placed.indexOf(x); if (k >= 0) placed.splice(k, 1); }
      return done;
    };
    let moved = 0, dropped = 0;
    // things left at their grammar spot first: a spot that walls no new way off; a required one may take the room of a
    // family's optional things near it (they look again for a spot, else go: the last top-up refills the family), else it
    // stays where it was (warned)
    for (const it of misfit) {
      const h = households.find((x) => x.items.includes(it)); if (!h) continue;
      const o: Own = { it, list: h.items, rank: reqRoles.has(it.role) && h.items.filter((x) => x.role === it.role).length === 1 ? 3 : 0, y: SG.deckY + (levelOf(h) ?? 0), lvl: levelOf(h) ?? 0, h };
      lift(o); const base = failing(), ok = (): boolean => [...failing()].every((id) => base.has(id));
      if (relocate(o, ok)) { moved++; continue; }
      if (o.rank === 3) {
        // (on the decks or a dock at its level, not in a hut)
        const spare = households.flatMap((x) => x.items.filter((i) => i !== it && i.role !== "sleeping" && !(reqRoles.has(i.role) && x.items.filter((y) => y.role === i.role).length === 1) && (levelOf(x) ?? 0) === o.lvl && d2(i.at, it.at) < 10 && !!cellIt(i.at) && cellIt(i.at)!.kind !== "hut").map((i): Own => ({ it: i, list: x.items, rank: 0, y: o.y, lvl: o.lvl, h: x }))).sort((a, b) => Number(!a.it.id.includes("-extra-")) - Number(!b.it.id.includes("-extra-")) || d2(a.it.at, it.at) - d2(b.it.at, it.at)).slice(0, 5);
        const off: Own[] = []; let done = false;
        for (const x of spare) { lift(x); off.push(x); if ((done = relocate(o, ok))) break; }
        if (done) { moved++; for (const x of off) { if (relocate(x, ok)) moved++; else dropped++; } continue; }
        for (const x of [...off].reverse()) put(x);
      }
      put(o); warn.push({ code: "item-no-room", message: `${it.id} (${it.prop}) found no spot on its family's deck, in its hut or on its dock that walls nothing off: left at its grammar spot` });
    }
    for (let guard = 0; guard < 80; guard++) {
      const now = stiltUnreached(SG, things()), t = now.find((f) => !structural.has(f.id) && !stuck.has(f.id)); if (!t) break;
      const before = new Set(now.map((f) => f.id));
      const tl = thingsOf(), hit = new Set(stiltBlockers(SG, tl.map((x) => x.t), t.goal).map((n) => tl[n]!.it));
      const cands = own().filter((o) => hit.has(o.it)).sort((a, b) => a.rank - b.rank || d2(a.it.at, t.at) - d2(b.it.at, t.at));
      const off: Own[] = [];
      for (const o of cands) { lift(o); off.push(o); if (!failing().has(t.id)) break; }
      if (failing().has(t.id)) { for (const o of [...off].reverse()) put(o); structural.add(t.id); continue; }
      // put back each lifted thing the way does not need (the highest rank first)
      for (const o of [...off].sort((a, b) => b.rank - a.rank)) { put(o); if (failing().has(t.id)) lift(o); else off.splice(off.indexOf(o), 1); }
      for (const o of off) {
        const ok = (): boolean => { const f = failing(); return !f.has(t.id) && [...f].every((id) => before.has(id)); };
        const done = relocate(o, ok);
        if (done) { moved++; continue; }
        if (o.rank === 3) { put(o); stuck.add(t.id); warn.push({ code: "item-blocks-way", message: `${o.it.id} (${o.it.prop}) walls off ${t.id} and found nowhere else: left in place` }); continue; }
        dropped++;
      }
    }
    // the families the pass left short (an optional thing dropped, or none fitted before it) top up again now the ways
    // are known: a thing is taken only where it walls no further way off
    const still = failing();
    if (extraKit.length) for (const h of households) topUp(h, () => [...failing()].every((id) => still.has(id)));
    deckLevel = undefined;
    for (const id of [...structural]) warn.push({ code: "way-blocked", message: `${id} cannot be reached from the communal deck (not a thing in the way: the deck layout)` });
    if (moved || dropped) warn.push({ code: "ways-cleared", message: `ways clear: ${moved} thing(s) moved, ${dropped} optional thing(s) dropped` });
  }
  // a deck is as big as the life on it: bare cells off every way through go (no plank plaza)
  if (stiltGrid) {
    const half = stiltGrid.cell / 2;
    const loose = [...gItems, ...households.flatMap((h) => h.items), ...work.flatMap((w) => w.items)].map((it) => it.at);
    const over = (c: StiltCell): boolean => placed.some((q) => { const t = (q.yaw * Math.PI) / 180, ex = Math.abs(Math.cos(t)) * q.hw + Math.abs(Math.sin(t)) * q.hd, ez = Math.abs(Math.sin(t)) * q.hw + Math.abs(Math.cos(t)) * q.hd; return Math.abs(q.c[0] - c.at[0]) < half + ex - 0.3 && Math.abs(q.c[1] - c.at[1]) < half + ez - 0.3; }) || loose.some((p) => Math.abs(p[0] - c.at[0]) < half + 0.3 && Math.abs(p[1] - c.at[1]) < half + 0.3);
    // (and no cut walls a way the walk lattice had: a door, stair, dock or joined border still reached)
    const SG = stiltGrid, th = latticeThings(), had = new Set(stiltUnreached(SG, th).map((f) => f.id));
    // (nor leaves a family's thing over a rail it now stands against: every kit thing on open deck stays on open deck)
    const kitFree = (cells: StiltCell[]): boolean => { const was = stiltFloorFree(SG), now = stiltFloorFree({ ...SG, cells }); return households.every((h) => h.items.every((it) => !was(it.at, 0.5) || now(it.at, 0.5))); };
    stiltGrid.trimmed = trimStiltDecks(stiltGrid, over, (cells) => kitFree(cells) && stiltUnreached({ ...SG, cells }, th).every((f) => had.has(f.id))).length;
  }

  // ---- clearings: every dwelling, fire and yard footprint + margin (3 m at doors and fires), cover cleared
  const clearings: SettleClearing[] = [];
  const cm = culture.clear;
  if (!stilt) {
    clearings.push({ id: "gathering", center: gather, radius: r2(Math.max(culture.gathering.radius * 0.7, (g.ring?.radius ?? 3) + cm.doorMargin)), why: `gathering ${g.kind}` });
    for (const h of households) {
      clearings.push({ id: `${h.id}-dwelling`, center: h.dwelling.at, radius: r2(Math.hypot(h.dwelling.footprint[0], h.dwelling.footprint[1]) / 2 + cm.margin), why: "dwelling footprint" });
      clearings.push({ id: `${h.id}-door`, center: h.dwelling.door, radius: r2(cm.doorMargin), why: "doorway" });
      // the yard: every thing the household owns stands clear of cover (the kit's footprints, not just round the door)
      const yard = fitArea([{ id: "dwelling", role: "dwelling", prop: h.dwelling.prop ?? "", at: h.dwelling.at, yaw: h.dwelling.yaw }, ...h.items], [h.dwelling.door]);
      clearings.push({ id: `${h.id}-yard`, center: yard.centre, radius: r2(yard.radius + cm.margin), why: "yard" });
    }
    // a work yard clears round everything it holds (it may have grown past its radius to fill)
    for (const w of work) { const y = w.items.length ? fitArea(w.items) : { centre: w.at, radius: w.radius * 0.75 }; clearings.push({ id: `${w.id}-yard`, center: y.centre, radius: r2(Math.max(w.radius * 0.75, y.radius) + cm.margin), why: "work yard" }); }
  } else if (stiltGrid?.dryLink) clearings.push({ id: "dry-link", center: stiltGrid.dryLink, radius: 6, why: "landing on the bank" });
  for (const w of stilt ? work.filter((x) => !stiltGrid?.cells.some((c) => c.kind === "work" && c.ref === x.id)) : []) clearings.push({ id: `${w.id}-yard`, center: w.at, radius: r2(w.radius * 0.75 + cm.margin), why: "work yard" });
  for (const it of [...gItems, ...work.flatMap((w) => w.items)].filter((i) => i.role === "fire")) clearings.push({ id: `${it.id}-fire`, center: it.at, radius: r2(cm.doorMargin + 1), why: "fire" });

  // ---- dressing areas (one per household, the gathering spot, each work yard, the defence line)
  const areas: SettleArea[] = [];
  const req = culture.household.filter((u) => u.required).map((u) => u.role);
  // the area's role is one every prop in it declares (dressing.rooms); props naming none of the outdoor roles add theirs as also
  const roleOf = (items: SettleItem[], prefer: SettleArea["role"]): { role: SettleArea["role"]; also?: string[] } => {
    const rooms = items.map((it) => info(it.prop)?.rooms ?? []).filter((r) => r.length);
    const order = [prefer, ...ROLES.filter((r) => r !== prefer)];
    const role = order.find((r) => rooms.every((rs) => rs.includes(r))) ?? order.reduce((b, r) => (rooms.filter((rs) => rs.includes(r)).length > rooms.filter((rs) => rs.includes(b)).length ? r : b), prefer);
    const also = [...new Set(rooms.filter((rs) => !rs.includes(role)).map((rs) => rs.find((x) => (ROLES as readonly string[]).includes(x)) ?? rs[0]!))];
    return also.length ? { role, also } : { role };
  };
  const yOf = (hid: string): number => { const h = households.find((x) => x.id === hid); const c = h && stiltGrid?.cells.find((x) => x.i === h.dwelling.cell?.[0] && x.j === h.dwelling.cell?.[1]); return r2((stiltGrid?.deckY ?? 0) + (c?.y ?? 0)); };
  const ga = gItems.length ? fitArea(gItems, [gather]) : { centre: gather, radius: r2(culture.gathering.radius) };
  areas.push({ id: "gathering", ...roleOf(gItems, "camp"), kind: "gathering", ref: "gathering", centre: ga.centre, radius: ga.radius, items: gItems, required: gItems.map((i) => i.role), ...(stilt && stiltGrid ? { surface: "built" as const, floorY: stiltGrid.deckY } : {}) });
  for (const h of households) {
    const its = [...(h.dwelling.prop ? [{ id: `${h.id}-dwelling`, role: "dwelling", prop: h.dwelling.prop, at: h.dwelling.at, yaw: h.dwelling.yaw }] : []), ...h.items];
    const fa = fitArea(its, h.dwelling.prop ? [h.dwelling.door] : []);
    areas.push({ id: h.id, ...roleOf(its, "camp"), kind: "household", ref: h.id, centre: fa.centre, radius: fa.radius, items: its, required: ["dwelling", ...req], ...(stilt && stiltGrid ? { surface: "built" as const, floorY: yOf(h.id) } : {}) });
  }
  for (const w of work) {
    const onDeck = stilt && stiltGrid?.cells.some((c) => c.kind === "work" && c.ref === w.id);
    const wa = onDeck && w.items.length ? { centre: w.at, radius: r2(Math.max(3, ...w.items.map((it) => d2(it.at, w.at) + halfDiag(it) + AREA_RIM))) } : fitArea(w.items);
    areas.push({ id: w.id, ...roleOf(w.items, "camp"), kind: "work", ref: w.id, centre: wa.centre, radius: wa.radius, items: w.items, required: ["work"], ...(onDeck && stiltGrid ? { surface: "built" as const, floorY: stiltGrid.deckY } : {}) });
  }
  if (defences.length) {
    const c: V2 = p2([defences.reduce((s, d) => s + d.at[0], 0) / defences.length, defences.reduce((s, d) => s + d.at[1], 0) / defences.length]);
    areas.push({ id: "defences", role: "path", kind: "defence", ref: "defences", centre: c, radius: r2(Math.max(8, ...defences.map((d) => d2(d.at, c) + 3))), items: defences, required: ["defence"] });
  }

  return { id: input.id, culture: culture.id, centre: input.centre, radius: input.radius, seed, gathering: { at: gather, facing: p2(gFacing), items: gItems, radius: culture.gathering.radius }, approach, clusters, households, work, defences, paths, clearings, creatures, areas, ...(stiltGrid ? { stilt: stiltGrid } : {}), survey, warnings: warn };
}

// ---------------------------------------------------------------------------------------------------------- check

/** Degrees between a dwelling's front and the way to its gathering spot / cluster centre. */
const offFacing = (yawDeg: number, from: V2, to: V2): number => { const want = yawToward([to[0] - from[0], to[1] - from[1]]); let d = Math.abs(((yawDeg - want) % 360) + 360) % 360; if (d > 180) d = 360 - d; return d; };

/** Is the disc (p, r) inside one cleared circle of `clearings` (cover cleared)? */
export function discCleared(p: V2, r: number, clearings: { center?: V2 | [number, number]; radius?: number; cover?: boolean; polygon?: [number, number][] }[]): boolean {
  return clearings.some((c) => c.cover === true && c.center && c.radius != null && d2(p, c.center as V2) + r <= c.radius + 0.01);
}

/**
 * The gate. `installed` (optional) is what the world/scene actually holds: the clearings written (cover flag included)
 * and the track paths. Without it the plan's own clearings are judged (they are written cover-cleared by `settle apply`).
 */
export function checkSettlement(plan: SettlementPlan, cultureIn: SettlementCultureIn, opts: { tier?: SettleTier; clearings?: { center?: [number, number]; radius?: number; cover?: boolean }[]; households?: number } = {}): { ok: boolean; findings: SettleFinding[]; summary: Record<string, number | string> } {
  const culture = settlementCultureSchema.parse(cultureIn);
  const F: SettleFinding[] = [];
  const stilt = culture.ground === "stilt";
  const want = opts.households ?? 0;
  // households complete
  if (plan.households.length < want) F.push({ code: "households", message: `${plan.households.length} dwellings for ${want} households` });
  const req = culture.household.filter((u) => u.required).map((u) => u.role);
  for (const h of plan.households) {
    const have = new Set(h.items.map((i) => i.role));
    const miss = req.filter((r) => !have.has(r));
    if (miss.length) F.push({ code: "household-kit", ref: h.id, message: `${h.id} lacks ${miss.join(", ")}` });
    if (!stilt && !h.dwelling.prop) F.push({ code: "household-dwelling", ref: h.id, message: `${h.id} has no dwelling` });
  }
  // doors face the gathering spot (one household per site) or their cluster centre
  for (const c of plan.clusters) for (const hid of c.households) {
    const h = plan.households.find((x) => x.id === hid)!;
    // a stilt compound turns its front to the gathering spot in quarter turns: its doors within 80 degrees of it
    if (stilt) { const off = offFacing(h.dwelling.yaw, h.dwelling.at, plan.gathering.at); if (off > 80) F.push({ code: "door-facing", ref: h.id, message: `${h.id}'s door turns ${Math.round(off)}° away from the gathering spot` }); continue; }
    const to = c.households.length === 1 || d2(c.centre, h.dwelling.at) < 1 ? plan.gathering.at : c.centre;
    const off = offFacing(h.dwelling.yaw, h.dwelling.at, to);
    if (off > 45) F.push({ code: "door-facing", ref: h.id, message: `${h.id}'s door turns ${Math.round(off)}° away from ${to === plan.gathering.at ? "the gathering spot" : `its cluster centre ${c.id}`}` });
  }
  // spacing
  const [hmin, hmax] = culture.householdSpacing, [cmin, cmax] = culture.clusterSpacing;
  for (let a = 0; a < plan.households.length; a++) for (let b = a + 1; b < plan.households.length; b++) {
    const A = plan.households[a]!, B = plan.households[b]!, d = d2(A.dwelling.at, B.dwelling.at);
    const min = culture.onePerPad || A.cluster === B.cluster ? hmin : Math.min(hmin, cmin * 0.5);
    if (!stilt && d < min - 0.01) F.push({ code: "spacing-tight", ref: `${A.id}/${B.id}`, message: `${A.id} and ${B.id} stand ${d.toFixed(1)} m apart (< ${min} m)` });
  }
  if (culture.onePerPad) {
    const seen = new Map<number, string>();
    for (const h of plan.households) { if (h.pad < 0) continue; if (seen.has(h.pad)) F.push({ code: "one-per-pad", ref: h.id, message: `${h.id} shares its isle with ${seen.get(h.pad)}` }); seen.set(h.pad, h.id); }
    for (const h of plan.households) { const near = Math.min(...plan.households.filter((x) => x !== h).map((x) => d2(x.dwelling.at, h.dwelling.at)), d2(h.dwelling.at, plan.gathering.at)); if (near > hmax * 1.5) F.push({ code: "spacing-far", ref: h.id, message: `${h.id} is ${near.toFixed(0)} m from its nearest neighbour (> ${hmax * 1.5} m)` }); }
  } else for (const c of plan.clusters) {
    const others = [plan.gathering.at, ...plan.clusters.filter((x) => x !== c).map((x) => x.centre)].filter((p) => d2(p, c.centre) > 0.5);
    if (!others.length) continue;
    const near = Math.min(...others.map((p) => d2(p, c.centre)));
    if (near < cmin * (stilt ? 0.9 : 1) - 0.01) F.push({ code: "cluster-tight", ref: c.id, message: `cluster ${c.id} is ${near.toFixed(0)} m from its nearest neighbour (< ${cmin} m)` });
    if (near > cmax * 1.6) F.push({ code: "cluster-far", ref: c.id, message: `cluster ${c.id} is ${near.toFixed(0)} m from its nearest neighbour (> ${cmax * 1.6} m)` });
  }
  // reach: the path graph joins the approach, the gathering spot, every household and work area
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => { (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b); (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a); };
  for (const p of plan.paths) { if (p.kind === "raft" && culture.paths.kind !== "ford") continue; link(p.from, p.to); }
  if (stilt) { for (const c of plan.clusters) for (const h of c.households) link(c.id, h); for (const w of plan.work) if (plan.stilt?.cells.some((c) => c.kind === "work" && c.ref === w.id)) link("gathering", w.id); if (plan.stilt?.dryLink) link("gathering", "dry-link"); if (!plan.paths.some((p) => p.from === "approach")) link("approach", "dry-link"); }
  const seen = new Set<string>(["approach"]), q = ["approach"];
  if (!adj.has("approach")) { seen.add("gathering"); q.push("gathering"); }
  while (q.length) for (const n of adj.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  for (const n of ["gathering", ...plan.households.map((h) => h.id), ...plan.work.map((w) => w.id)]) if (!seen.has(n)) F.push({ code: "unreachable", ref: n, message: `${n} is not on the path graph from the approach` });
  for (const p of plan.paths) {
    if (p.kind === "raft") F.push({ code: "deep-crossing", ref: p.id, message: `${p.id} crosses ${p.maxDepth} m of water (> ${culture.paths.maxWade} m wade): only a raft/swim joins ${p.from} and ${p.to}` });
    // a walkway branch is the kit's narrow plank run (1.6 m, rails none: the capsule passes); every other path 2.4 m
    const minW = p.kind === "walkway" ? 1.5 : 2.4;
    if (p.width < minW) F.push({ code: "path-narrow", ref: p.id, message: `${p.id} is ${p.width} m wide (< ${minW} m)` });
  }
  if (stilt && plan.stilt) {
    if (!plan.stilt.dryLink) F.push({ code: "stilt-dry-link", message: "the stilt village has no walkway to dry land" });
    const landings = plan.stilt.cells.filter((c) => c.kind === "landing" && c.ref !== "dry-link").length;
    if (landings < 2) F.push({ code: "stilt-landings", message: `${landings} boat landings (need 2+)` });
    const dwf = culture.dwelling as z.infer<typeof wfcDwellingSchema>;
    for (const c of plan.stilt.cells) if (c.water != null) { const depth = c.water - c.ground; if (depth > dwf.depth[1] + 0.5) F.push({ code: "stilt-depth", ref: `${c.i},${c.j}`, message: `deck cell ${c.i},${c.j} stands in ${depth.toFixed(1)} m of water (posts reach ${dwf.depth[1]} m)` }); }
    if (Math.abs(plan.stilt.deckY - plan.stilt.water - dwf.deckOverWater) > 0.3) F.push({ code: "stilt-deck-height", message: `deck y ${plan.stilt.deckY} is not water ${plan.stilt.water} + ${dwf.deckOverWater}` });
  }
  // cover cleared under every dwelling, fire and yard
  const clr = opts.clearings ?? plan.clearings.map((c) => ({ center: c.center, radius: c.radius, cover: true }));
  if (!stilt) {
    for (const h of plan.households) {
      if (!discCleared(h.dwelling.at, Math.hypot(h.dwelling.footprint[0], h.dwelling.footprint[1]) / 2 + 1.5, clr)) F.push({ code: "cover-under-dwelling", ref: h.id, message: `${h.id}'s dwelling stands on uncleared ground cover (clear footprint + 1.5 m, cover cleared)` });
      if (!discCleared(h.dwelling.door, 1.5, clr)) F.push({ code: "cover-at-door", ref: h.id, message: `${h.id}'s doorway is not cleared of ground cover` });
    }
    for (const it of plan.areas.flatMap((a) => a.items).filter((i) => i.role === "fire")) if (!discCleared(it.at, 3, clr)) F.push({ code: "cover-at-fire", ref: it.id, message: `${it.id} burns on uncleared ground cover (3 m round a fire)` });
  }
  // creature spots
  const minGroups = Math.max(opts.tier?.minCreatureGroups ?? 0, plan.clusters.length * Math.min(1, culture.creatures.perCluster));
  if (plan.creatures.length < minGroups) F.push({ code: "creature-spots", message: `${plan.creatures.length} creature spots (need ${minGroups}${opts.tier ? `, ${opts.tier.id} tier` : ""})` });
  for (const c of plan.clusters) if (culture.creatures.perCluster > 0 && !plan.creatures.some((s) => s.id === c.id || s.id.startsWith(`${c.id}-`))) F.push({ code: "cluster-unpopulated", ref: c.id, message: `cluster ${c.id} has no creature spot` });
  // tier footprint
  const pts = [plan.gathering.at, ...plan.households.map((h) => h.dwelling.at), ...plan.work.map((w) => w.at)];
  let span = 0; for (const a of pts) for (const b of pts) span = Math.max(span, d2(a, b));
  if (opts.tier && span < opts.tier.footprintDiameterM.min) F.push({ code: "tier-footprint", message: `the settlement spans ${span.toFixed(0)} m; a ${opts.tier.id} place spans ${opts.tier.footprintDiameterM.min}-${opts.tier.footprintDiameterM.max} m (the rest of the place must make it up)` });
  const errors = F.filter((f) => f.code !== "tier-footprint");
  return { ok: errors.length === 0, findings: F, summary: { households: plan.households.length, clusters: plan.clusters.length, work: plan.work.length, paths: plan.paths.length, clearings: plan.clearings.length, creatures: plan.creatures.length, spanM: Math.round(span) } };
}

// ---------------------------------------------------------------------------------------------------------- outputs

/** A dressing plan per area (items by NAME at world coordinates) for `dress check` / `dress apply --at 0,0,0`. */
export function settlementDressingPlans(plan: SettlementPlan, cultureIn: SettlementCultureIn, poi: string): { id: string; map: string; lights: string; rooms: Record<string, { role: string; also?: string[] }>; space: { kind: "site"; scale: string; cultures: string[] }; items: { id: string; prop: string; place: { kind: "floor"; level: 0; at: V2; yaw: number } | { kind: "anchor"; anchor: string }; note?: string }[] }[] {
  const culture = settlementCultureSchema.parse(cultureIn);
  // the gathering's fire stands ON its hearth anchor (settlementSiteDressing's `gathering-centre`, kind hearth): the site
  // socket map keeps the floor round a hearth clear ('H'), so a fire placed by `floor` on that spot covers its own clearance
  const onHearth = (a: SettleArea, it: SettleItem): boolean => a.kind === "gathering" && it.role === "fire" && culture.gathering.kind === "hearth";
  return plan.areas.filter((a) => a.items.length).map((a) => ({
    id: `${poi}-${a.id}`, map: `${poi}-${a.id}`, lights: culture.lights,
    rooms: { [a.id]: { role: a.role, ...(a.also ? { also: a.also } : {}) } },
    space: { kind: "site" as const, scale: culture.scale, cultures: culture.cultures },
    items: a.items.map((it) => ({
      id: it.id.replace(new RegExp(`^${a.id}-`), "") || it.id, prop: it.prop,
      place: onHearth(a, it) ? { kind: "anchor" as const, anchor: `${a.id}/gathering-centre` } : { kind: "floor" as const, level: 0 as const, at: it.at, yaw: it.yaw },
      note: `settle: ${it.role}`,
    })),
  }));
}

/** The handoff.json `siteDressing` block (areas + anchors + keepClear) for `site-sockets`. */
export function settlementSiteDressing(plan: SettlementPlan, cultureIn: SettlementCultureIn, size?: (prop: string) => [number, number, number] | undefined): { lights: string; areas: Record<string, unknown>[]; anchors: Record<string, unknown>[]; keepClear: Record<string, unknown>[] } {
  const culture = settlementCultureSchema.parse(cultureIn);
  // `reach`: where a body stands to visit the area — the end of the network route to it (stiltRoutes: just inside its hut
  // door, stiltHutReach, or the clear lattice point nearest its middle) — the walk gate's target, so it never walks onto
  // the bed or the kit round the area's centre, nor straight on from where its route stops
  const ends = new Map(stiltRoutes(plan, 3, size, true).filter((x) => x.network).map((x) => [x.id.replace(/^to-/, ""), x.points[x.points.length - 1]!] as const));
  const areas = plan.areas.map((a) => ({ id: a.id, role: a.role, centre: a.centre, radius: a.radius, ...(a.surface ? { surface: a.surface, floorY: a.floorY } : {}), ...(ends.has(a.id) ? { reach: ends.get(a.id)! } : {}), note: `settle ${a.kind} (${culture.id}); REQUIRED: ${a.required.join(", ")}` }));
  const anchors = [
    { id: "gathering-centre", kind: culture.gathering.kind === "hearth" || (culture.dwelling.kind === "wfc" && culture.dwelling.hearth) ? "hearth" : "ritual-centre", at: plan.gathering.at, radius: culture.dwelling.kind === "wfc" && culture.dwelling.hearth ? 1.6 : 3 },
    ...plan.households.map((h) => ({ id: `${h.id}-door`, kind: "door", at: h.dwelling.door, facing: [Math.sin((h.dwelling.yaw * Math.PI) / 180), Math.cos((h.dwelling.yaw * Math.PI) / 180)].map(r2) })),
  ];
  const keepClear = [
    ...(culture.gathering.ring && !culture.gathering.centre.length ? [{ id: "gathering-open", why: "the ring's middle stays open", at: plan.gathering.at, radius: Math.max(2, culture.gathering.ring.radius - 3) }] : []),
    ...plan.paths.filter((p) => p.points.length >= 2).map((p) => ({ id: `path-${p.id}`, why: `settle ${p.kind}`, points: p.points, width: p.width })),
    ...plan.creatures.map((c) => ({ id: `creatures-${c.id}`, why: "creature group spot", at: c.at, radius: CREATURE_KEEP })),
  ];
  return { lights: culture.lights, areas, anchors, keepClear };
}

/** A dry leg carved + painted as a narrow track by the world's road machinery (`settle apply` runs `worldgen road`). */
export interface SettleTrack { id: string; points: V2[]; width: number; maxGrade: number }
/** World ops: vegetation clearings (cover cleared) + carved + painted tracks for the dry legs (never ribbons). */
export function settlementWorldOps(plan: SettlementPlan, cultureIn: SettlementCultureIn, poi: string): { clearings: { id: string; center: V2; radius: number; feather: number; keep: number; scatter: boolean; cover: boolean; owner: string }[]; tracks: SettleTrack[] } {
  const culture = settlementCultureSchema.parse(cultureIn);
  const owner = `settle-${poi}`;
  const clearings = plan.clearings.map((c) => ({ id: `${owner}-${c.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"), center: c.center, radius: c.radius, feather: 2, keep: 0, scatter: true, cover: true, owner }));
  const tracks = culture.paths.kind === "track" ? plan.paths.filter((p) => p.kind === "track" && p.points.length >= 2 && d2(p.points[0]!, p.points[1]!) >= 12).map((p) => ({ id: `road-${owner}-${p.id}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"), points: p.points, width: Math.min(3, Math.max(2.4, culture.paths.width)), maxGrade: culture.paths.maxGrade })) : [];
  return { clearings, tracks };
}

export interface StiltFootprint {
  /** m² seen from above: every deck, hut, stair and dock cell plus the walkways (length x width) */
  builtM2: number; hutM2: number; deckM2: number; walkM2: number;
  /** hut roofs / built (whole village, and the core: cells and walkways within the core radius) */
  hutShare: number; coreHutShare: number;
  /** open deck (no hut, fit, stair or item on it) + walkways, over built */
  openShare: number;
  /** the communal deck's size in metres */
  communal: [number, number];
  /** walkway m² per hut within the core radius */
  coreWalkPerHut: number;
  /** pairs of walkways running side by side within `parallelM` for 6 m or more */
  parallel: { a: string; b: string; m: number; gap: number }[];
  /** connected empty deck (one level, no hut, porch, fit, stair, dock, item or creature spot) larger than `emptyM2` */
  empty: { ref: string; cells: number; m2: number; at: V2 }[];
}
/** True when an item (its catalogue footprint, else a 0.6 m disc) stands on stilt deck cell `c`. */
function itemOnCell(it: { at: V2; prop: string; yaw: number }, c: StiltCell, half: number, size?: (prop: string) => [number, number, number] | undefined): boolean {
  const s = size?.(it.prop), q = Math.abs(Math.round(it.yaw / 90)) % 2 === 1, hx = s ? (q ? s[2] : s[0]) / 2 : 0.6, hz = s ? (q ? s[0] : s[2]) / 2 : 0.6;
  return Math.abs(it.at[0] - c.at[0]) < half + hx - 0.15 && Math.abs(it.at[1] - c.at[1]) < half + hz - 0.15;
}
/**
 * How much of a stilt village is huts and how much is bare plank, measured from above: hut roof share (whole and core),
 * open-deck share, the communal deck's size, walkway area per core hut, side-by-side walkway pairs and large empty decks.
 */
export function stiltFootprint(plan: SettlementPlan, coreR: number, size?: (prop: string) => [number, number, number] | undefined, opts: { parallelM?: number; emptyM2?: number } = {}): StiltFootprint | null {
  const g = plan.stilt; if (!g) return null;
  const A = g.cell * g.cell, half = g.cell / 2, gat = plan.gathering.at, parallelM = opts.parallelM ?? 6, emptyM2 = opts.emptyM2 ?? 30;
  const items = [...plan.areas.flatMap((a) => a.items), ...plan.creatures.map((c) => ({ at: c.at, prop: "", yaw: 0 }))];
  const len = (pts: V2[]): number => pts.slice(1).reduce((t, b, n) => t + d2(b, pts[n]!), 0);
  const inCore = (p: V2): boolean => d2(p, gat) <= coreR;
  const walks = g.walks.filter((w) => w.points.length >= 2);
  const walkM2 = walks.reduce((t, w) => t + len(w.points) * w.width, 0);
  const coreWalkM2 = walks.reduce((t, w) => { let m = 0; for (let n = 1; n < w.points.length; n++) { const a = w.points[n - 1]!, b = w.points[n]!; if (inCore([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) m += d2(a, b); } return t + m * w.width; }, 0);
  const huts = g.cells.filter((c) => c.kind === "hut"), coreCells = g.cells.filter((c) => inCore(c.at));
  const hutM2 = huts.length * A, deckM2 = (g.cells.length - huts.length) * A, builtM2 = g.cells.length * A + walkM2;
  const coreBuilt = coreCells.length * A + coreWalkM2, coreHuts = coreCells.filter((c) => c.kind === "hut").length;
  const coreHH = plan.households.filter((h) => inCore(h.dwelling.at)).length;
  const at = new Map(g.cells.map((c) => [KEY(c.i, c.j), c]));
  // a hut door step (its porch) belongs to the hut
  const porch = new Set(g.blocks.flatMap((b) => b.huts.map((h) => KEY(h.porch[0], h.porch[1]))));
  const used = (c: StiltCell): boolean => porch.has(KEY(c.i, c.j)) || c.kind === "hut" || c.kind === "stair" || c.kind === "ramp" || c.kind === "landing" || !!c.fit || items.some((it) => itemOnCell(it, c, half, size));
  const open = g.cells.filter((c) => !used(c));
  const comm = g.cells.filter((c) => c.kind === "communal"), ci = comm.map((c) => c.i), cj = comm.map((c) => c.j);
  const communal: [number, number] = comm.length ? [(Math.max(...ci) - Math.min(...ci) + 1) * g.cell, (Math.max(...cj) - Math.min(...cj) + 1) * g.cell] : [0, 0];
  // side by side: a walkway's sample points within parallelM of another walkway's segment, running the same way
  const parallel: StiltFootprint["parallel"] = [];
  for (let x = 0; x < walks.length; x++) for (let y = x + 1; y < walks.length; y++) {
    const P = walks[x]!, Q = walks[y]!;
    let run = 0, best = 0, gapSum = 0, gapN = 0;
    for (let n = 1; n < P.points.length; n++) {
      const a = P.points[n - 1]!, b = P.points[n]!, L = d2(a, b), dir = norm([b[0] - a[0], b[1] - a[1]]);
      for (let s = 0; s < L; s += 1) {
        const p: V2 = [a[0] + dir[0] * s, a[1] + dir[1] * s];
        let hit = false;
        for (let m = 1; m < Q.points.length; m++) {
          const c = Q.points[m - 1]!, e = Q.points[m]!, dq = norm([e[0] - c[0], e[1] - c[1]]), gap = segDist2(p, c, e);
          // the far walkway's centre line within parallelM, running within 25 degrees of this one, and not where they meet a deck
          if (gap < parallelM && gap > 0.5 && Math.abs(dir[0] * dq[0] + dir[1] * dq[1]) > 0.9) { hit = true; gapSum += gap; gapN++; break; }
        }
        run = hit ? run + 1 : 0; best = Math.max(best, run);
      }
    }
    if (best >= 6) parallel.push({ a: P.id, b: Q.id, m: best, gap: r2(gapSum / Math.max(1, gapN)) });
  }
  // empty decks: 4-connected open cells at one level
  const empty: StiltFootprint["empty"] = [], seen = new Set<string>();
  const openSet = new Set(open.map((c) => KEY(c.i, c.j)));
  for (const c of open) {
    if (seen.has(KEY(c.i, c.j))) continue;
    const comp: StiltCell[] = [], q = [c]; seen.add(KEY(c.i, c.j));
    while (q.length) { const u = q.pop()!; comp.push(u); for (const v of Object.values(FACES)) { const k = KEY(u.i + v[0], u.j + v[1]), n = at.get(k); if (n && openSet.has(k) && !seen.has(k) && (n.y ?? 0) === (u.y ?? 0)) { seen.add(k); q.push(n); } } }
    if (comp.length * A > emptyM2) empty.push({ ref: c.ref, cells: comp.length, m2: comp.length * A, at: c.at });
  }
  return {
    builtM2: r2(builtM2), hutM2: r2(hutM2), deckM2: r2(deckM2), walkM2: r2(walkM2),
    hutShare: r2(hutM2 / builtM2), coreHutShare: r2(coreBuilt ? (coreHuts * A) / coreBuilt : 0),
    openShare: r2((open.length * A + walkM2) / builtM2), communal, coreWalkPerHut: r2(coreWalkM2 / Math.max(1, coreHH)), parallel, empty,
  };
}

/** A top-down plan picture (SVG): water, dry ground, pads, the gathering spot, households, work, paths, clearings, creatures. */
export function settlementSvg(plan: SettlementPlan, title = plan.id): string {
  const S = plan.survey, px = 900 / (S.columns * S.step), W = 900, Hh = 900;
  const X = (x: number): number => r2((x - S.origin[0]) * px), Y = (z: number): number => r2(Hh - (z - S.origin[1]) * px);
  const rows = S.kinds.split("\n"), cs = r2(S.step * px + 0.4);
  let ground = "";
  rows.forEach((row, r) => { const j = rows.length - 1 - r; for (let i = 0; i < row.length; i++) { const ch = row[i]; if (ch === " ") continue; const fill = ch === "~" ? "#2d4f63" : ch === "#" ? "#555" : "#6b7a4c"; ground += `<rect x="${X(S.origin[0] + i * S.step - S.step / 2)}" y="${Y(S.origin[1] + j * S.step + S.step / 2)}" width="${cs}" height="${cs}" fill="${fill}"/>`; } });
  const circ = (p: V2, r: number, a: string): string => `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="${r2(Math.max(1.5, r * px))}" ${a}/>`;
  const txt = (p: V2, t: string, a = ""): string => `<text x="${X(p[0]) + 6}" y="${Y(p[1]) - 6}" font-size="13" fill="#fff" stroke="#000" stroke-width="0.6" ${a}>${t}</text>`;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh + 70}" viewBox="0 0 ${W} ${Hh + 70}" font-family="sans-serif"><rect width="${W}" height="${Hh + 70}" fill="#111"/>${ground}`;
  for (const c of plan.clearings) s += circ(c.center, c.radius, `fill="#c9b27a" fill-opacity="0.28" stroke="#c9b27a" stroke-opacity="0.6"`);
  if (plan.stilt) {
    const G = plan.stilt, half = G.cell / 2;
    const col: Record<string, string> = { communal: "#d9a441", corridor: "#a07a4a", work: "#7fb069", landing: "#4fc3f7", block: "#8d7b68" };
    for (const b of G.blocks) s += `<rect x="${X(G.origin[0] + b.i0 * G.cell - half)}" y="${Y(G.origin[1] + (b.j0 + b.d) * G.cell - half)}" width="${r2(b.w * G.cell * px)}" height="${r2(b.d * G.cell * px)}" fill="none" stroke="#e57373" stroke-dasharray="4 3"/>` + txt(b.centre, b.id);
    for (const c of G.cells) s += `<rect x="${X(c.at[0] - half)}" y="${Y(c.at[1] + half)}" width="${r2(G.cell * px)}" height="${r2(G.cell * px)}" fill="${col[c.kind] ?? "#999"}" stroke="#222" stroke-width="0.5"/>`;
  }
  for (const p of plan.paths) if (p.points.length >= 2) s += `<polyline fill="none" points="${p.points.map((q) => `${X(q[0])},${Y(q[1])}`).join(" ")}" stroke="${p.kind === "track" ? "#e0c080" : p.kind === "ford" ? "#80d8ff" : p.kind === "raft" ? "#ff8a80" : "#c8a46e"}" stroke-width="${p.kind === "walkway" ? r2(Math.max(2, p.width * px)) : p.kind === "track" ? 3 : 2}" ${p.kind === "track" || p.kind === "walkway" ? "" : 'stroke-dasharray="6 4"'}/>`;
  for (const c of plan.creatures) s += circ(c.at, c.radius, `fill="none" stroke="#ff5252" stroke-width="1.5" stroke-dasharray="2 3"`);
  s += circ(plan.gathering.at, plan.gathering.radius, `fill="none" stroke="#ffd54f" stroke-width="2.5"`) + txt(plan.gathering.at, "gathering");
  for (const it of plan.gathering.items) s += circ(it.at, 0.8, `fill="#ffd54f"`);
  for (const h of plan.households) {
    const a = h.dwelling.at, f: V2 = [Math.sin((h.dwelling.yaw * Math.PI) / 180), Math.cos((h.dwelling.yaw * Math.PI) / 180)];
    s += `<rect x="${X(a[0]) - (h.dwelling.footprint[0] * px) / 2}" y="${Y(a[1]) - (h.dwelling.footprint[1] * px) / 2}" width="${r2(h.dwelling.footprint[0] * px)}" height="${r2(h.dwelling.footprint[1] * px)}" fill="#fafafa" stroke="#000" transform="rotate(${-h.dwelling.yaw + 180} ${X(a[0])} ${Y(a[1])})"/>`;
    s += `<line x1="${X(a[0])}" y1="${Y(a[1])}" x2="${X(a[0] + f[0] * 9)}" y2="${Y(a[1] + f[1] * 9)}" stroke="#fff" stroke-width="1.5"/>`;
    for (const it of h.items) s += circ(it.at, 0.6, `fill="${it.role === "boat" ? "#80d8ff" : it.role === "light" ? "#ffab40" : it.role === "work" ? "#aed581" : "#e0e0e0"}"`);
    s += txt(a, h.id);
  }
  for (const w of plan.work) { s += circ(w.at, w.radius, `fill="none" stroke="#aed581" stroke-width="2"`) + txt(w.at, w.id); for (const it of w.items) s += circ(it.at, 0.7, `fill="#aed581"`); }
  for (const d of plan.defences) s += circ(d.at, 0.8, `fill="#b0bec5"`);
  s += circ(plan.approach, 3, `fill="#fff"`) + txt(plan.approach, "approach");
  // scale bar + legend
  const bar = 50 * px;
  s += `<line x1="20" y1="${Hh + 20}" x2="${20 + bar}" y2="${Hh + 20}" stroke="#fff" stroke-width="3"/><text x="20" y="${Hh + 40}" font-size="12" fill="#fff">50 m</text>`;
  s += `<text x="150" y="${Hh + 24}" font-size="14" fill="#fff">${title} — ${plan.culture}: ${plan.households.length} households in ${plan.clusters.length} clusters, ${plan.work.length} work areas, ${plan.paths.length} path legs, ${plan.clearings.length} clearings, ${plan.creatures.length} creature spots</text>`;
  s += `<text x="150" y="${Hh + 46}" font-size="12" fill="#bbb">+z up; white = dwelling (line = door), yellow = gathering, green = work, tan = cleared cover, red dashed = creature spot, path: tan track / blue ford / red raft-only${plan.stilt ? " / decks: gold communal, tan walkways (wide spine, narrow branches), blue landing, green work, red dashed = cluster WFC block" : ""}</text>`;
  return s + "</svg>";
}

/** Which placed props must stand on cleared cover (the grass rule): dwellings, fires, bedding and yard work frames. */
export const COVER_CLEARING_PROP = /(^|\/)[^/]*(tent|hut|lodge|shelter|pavilion|house|hovel|shack|lean-to|bonfire|fire-pit|campfire|hearth|giant-fire|brazier|sleeping-nest|sleeping-mat|hide-bed|sleeping-hides)[^/]*$/;
export function needsClearedCover(prop: string, dressing?: { fire?: boolean; mount?: string; category?: string }): "dwelling" | "fire" | null {
  if (dressing?.fire && (dressing.mount ?? "floor") === "floor" && /fire|hearth|bonfire|brazier|pyre/.test(prop)) return "fire";
  return COVER_CLEARING_PROP.test(prop) && !/torch|sconce|lantern/.test(prop) ? (/(fire|hearth|brazier)/.test(prop) ? "fire" : "dwelling") : null;
}
