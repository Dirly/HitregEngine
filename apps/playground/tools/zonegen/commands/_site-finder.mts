/**
 * THE SITE FINDER: read the ground of a zone and say where places want to go, before anyone writes a brief.
 *
 * The owner's verdict on the first zones: places were chosen from design text and reservation circles, not from the
 * land and the player's path ("even a simple height map would tell you what would look cool"). This module samples
 * the world field on a grid (height, water, slope) and finds the land features a designer would circle on a height
 * map, scores them, and says how the player arrives at each one. `zonegen sites` (./sites.mts) prints, maps and lints
 * the result; this file has no I/O so it can be tested on a synthetic field.
 *
 * Feature kinds (all numbers are metres; the thresholds are the constants below):
 *   cliff-water   a standable perch above a steep drop into a lake, river or the sea      (Gnawspur over the lake)
 *   canyon-end    a cul-de-sac: walled on most sides, one mouth; the end of a valley/canyon (the Rime Door)
 *   plateau       a flat landform standing above its surroundings; mesa when small          (the Shelf's plateau)
 *   peak          a summit with prominence                                                  (a lookout, a shrine)
 *   saddle        a pass: ground rises on two opposite sides and falls on the other two     (a gate, a waystation)
 *   wall-gap      the narrowest walkable neck between a cliff and water (or two cliffs) a road threads (Greyharbour)
 *   cove          water pocket enclosed by land with one mouth                              (a smugglers' landing)
 *   waterfall     a solved river fall                                                       (a mill, a grotto)
 *   path-end      where a path stops without arriving anywhere, or tops out after climbing (a cave, a house, a ruin)
 *   switchback    the top of a run of hairpins
 *   empty-land    the largest disc of walkable land with no place, town or reservation in it
 *
 * Approach (every candidate): the nearest road or path, how far, the height change from it, how many metres of road
 * see a landmark standing there (line of sight over the sampled ground, eye 1.7 m, landmark 8 m), the farthest
 * point it is first seen from, and the bearing it should FACE (toward the road that sees it).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
export type Vec2 = [number, number];

export interface FieldLike {
  height(x: number, z: number): number;
  waterSurface(x: number, z: number, out: { y: number; kind?: string }): boolean;
  readonly falls?: readonly { river: string; x: number; z: number; top: number; bottom: number; dirX: number; dirZ: number }[];
}

export interface Content {
  id: string;
  kind: "town" | "reservation" | "place";
  x: number;
  z: number;
  radius: number;
  zone?: string;
  /** A hostile place (its quest-graph location names a holder). Hostile places stay off town-to-town roads. */
  hostile?: boolean;
  /** A lookout over a road: a hostile place allowed beside one (location `overlooksRoad`). */
  overlooksRoad?: boolean;
}

export interface RoadLine {
  id: string;
  points: Vec2[];
  trail: boolean;
}

export type SiteKind = "cliff-water" | "canyon-end" | "plateau" | "peak" | "saddle" | "wall-gap" | "cove" | "waterfall" | "path-end" | "switchback" | "empty-land" | "island" | "access";

/** The access device proposed for a strong site no walking body can reach from a road (sites.md "access devices"). */
export type AccessDevice = "ladder" | "cliff-stair" | "lift" | "rope-way" | "bridge-or-ferry";

export interface Approach {
  /** Nearest road/path id and distance from the site to it. */
  road: string | null;
  distance: number;
  /** Where on that road the site is closest. */
  from: Vec2 | null;
  /** Site ground minus road ground there: + = the player climbs to it. */
  climb: number;
  /** Metres of road (within SIGHT_RANGE) from which an 8 m landmark here is in view. */
  seenM: number;
  /** Farthest road point that sees it, and its distance. */
  firstSeen: { at: Vec2; distance: number; road: string } | null;
  /** Bearing (deg, 0 = north = -Z, 90 = east = +X) the site should face: toward the road that sees it. */
  faces: number;
  facesWord: string;
  /** What the approach lacks, for the designer ("no path within 250 m: give it its own trail"). */
  note: string;
}

export interface Candidate {
  id: string;
  kind: SiteKind;
  at: Vec2;
  y: number;
  score: number;
  /** One line a designer can read. */
  why: string;
  /** Kind-specific measures (drop, gap, area, mouth bearing, wall line...). */
  detail: J;
  approach: Approach;
  /** A place/town/reservation already standing on it. */
  usedBy: string | null;
  inZone: boolean;
  /** Walkable ground (dry, slope < WALK_SLOPE) joins it to a road or path. false = it needs an access device. */
  reachable: boolean;
}

export interface PathFinding {
  road: string;
  kind: "dead-end" | "climb-top" | "switchback-top" | "wasted-climb";
  at: Vec2;
  climb: number;
  switchbacks: number;
  leadsTo: string | null;
  message: string;
}

export interface SiteReport {
  step: number;
  box: [number, number, number, number];
  landKm2: number;
  places: number;
  perKm2: number;
  /** The largest walkable-land disc inside the zone that holds no place/town/reservation. */
  largestEmpty: { at: Vec2; radius: number; landform: string } | null;
  empties: { at: Vec2; radius: number; landform: string }[];
  candidates: Candidate[];
  paths: PathFinding[];
  /** Hostile places on or beside a town-to-town road (lint `hostile-on-road`; lookouts are listed but allowed). */
  hostileOnRoad: HostileOnRoad[];
  /** Plateau / flat landforms of 15 ha or more, and how much of each lies within reach of a place. */
  landforms: { id: string; kind: string; at: Vec2; areaHa: number; relief: number; covered: number; usedBy: string | null }[];
}

export interface HostileOnRoad {
  place: string;
  road: string;
  /** Metres from the place's edge to the road (<= 0: the road runs through it). */
  gap: number;
  lookout: boolean;
  message: string;
}

// ---------------------------------------------------------------- thresholds (the rules, as data)

/** A hostile place's edge keeps this far from a town-to-town road (sites.md: major hostile places sit off them). */
export const HOSTILE_ROAD_CLEAR = 80;
/** A road is town-to-town when each end lies within this many metres of a different town's edge (falloff included). */
export const MAIN_ROAD_END = 60;
/** Islands: dry ground wholly ringed by water, between these areas. */
export const ISLAND_MIN_M2 = 150;
export const ISLAND_MAX_HA = 60;
/** Score at or above which a site no walking body reaches from a road gets an access-device proposal. */
export const ACCESS_SCORE = 5;
/** How far from the site the foot of an access device may stand (m). */
export const ACCESS_REACH = 400;
/** Kinds that never need an access device (a path point is reached by its path; empty land is not a site). */
const NO_ACCESS: ReadonlySet<SiteKind> = new Set<SiteKind>(["path-end", "switchback", "empty-land", "access", "waterfall"]);

/** Roads and paths a player walks: not paint-only strips (`role: "none"`), not town paving or a town's own lanes. */
export function travelRoads(recipe: J): RoadLine[] {
  const xz = (p: number[]): Vec2 => (p.length >= 3 ? [p[0]!, p[2]!] : [p[0]!, p[1]!]);
  const towns = ((recipe.features?.towns ?? []) as J[]).map((t) => t.id as string);
  return ((recipe.features?.roads ?? []) as J[])
    .filter((r) => r.role !== "none" && r.role !== "paving" && !towns.some((t) => r.id.startsWith(`${t}-`)))
    .map((r) => ({ id: r.id, points: (r.points as number[][]).map(xz), trail: String(r.id).startsWith("trail-") }));
}

/** Roads whose two ends each reach a different town: the main town-to-town roads. */
export function mainRoads(roads: RoadLine[], content: Content[]): RoadLine[] {
  const towns = content.filter((c) => c.kind === "town");
  const townAt = (p: Vec2 | undefined): string | null => {
    if (!p) return null;
    let best: string | null = null;
    let bd = Infinity;
    for (const t of towns) {
      const d = Math.hypot(t.x - p[0], t.z - p[1]) - t.radius;
      if (d <= MAIN_ROAD_END && d < bd) (best = t.id), (bd = d);
    }
    return best;
  };
  return roads.filter((r) => {
    if (r.trail) return false;
    const a = townAt(r.points[0]);
    const b = townAt(r.points[r.points.length - 1]);
    return a !== null && b !== null && a !== b;
  });
}

/** Distance from a point to a polyline. */
export function polylineDist(x: number, z: number, pts: Vec2[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(x, z, pts[i - 1]!, pts[i]!));
  return pts.length === 1 ? Math.hypot(x - pts[0]![0], z - pts[0]![1]) : d;
}

/** Every hostile place whose edge comes within HOSTILE_ROAD_CLEAR of a town-to-town road. Pure (no field). */
export function hostileOnMainRoads(content: Content[], roads: RoadLine[], clear = HOSTILE_ROAD_CLEAR): HostileOnRoad[] {
  const mains = mainRoads(roads, content);
  const out: HostileOnRoad[] = [];
  for (const c of content) {
    if (!c.hostile || c.kind === "town") continue;
    let best: { road: string; gap: number } | null = null;
    for (const r of mains) {
      const gap = polylineDist(c.x, c.z, r.points) - c.radius;
      if (gap < clear && (!best || gap < best.gap)) best = { road: r.id, gap };
    }
    if (!best) continue;
    const lookout = !!c.overlooksRoad;
    const where = best.gap <= 0 ? `the road runs through it` : `${Math.round(best.gap)} m from its edge`;
    out.push({
      place: c.id,
      road: best.road,
      gap: Math.round(best.gap),
      lookout,
      message: lookout
        ? `${c.id}: a lookout over town-to-town road ${best.road} (${where}): allowed`
        : `${c.id}: a hostile place on town-to-town road ${best.road} (${where}; keep ${clear} m clear). Move it off the road, or declare the location \`overlooksRoad\` if it is a lookout over it`,
    });
  }
  return out;
}

/** Grid step for the ground sample. 8 m resolves a cliff and a 10 m path neck; a zone samples in ~3 s. */
export const STEP = 8;
/** Walkable: steeper than this a body slides (matches the capsule's slope limit in docs/voxel-worlds.md). */
export const WALK_SLOPE = 35;
/** Cliff-water: perch at least this high above the water, the drop reached within CLIFF_REACH. */
export const CLIFF_DROP = 15;
export const CLIFF_REACH = 120;
/** ...and with at least this much near-level standing ground on top (m2) for something to be built. */
export const CLIFF_PERCH = 500;
/** Canyon end: rays (of 16) that meet a wall rising RISE m within RANGE m; one open arc only. */
export const CANYON_RAYS = 12;
export const CANYON_RISE = 25;
export const CANYON_RANGE = 240;
/** Plateau: flat cells (slope < FLAT) in a component of MIN_HA standing RELIEF m over the ring around it. */
export const FLAT = 10;
export const PLATEAU_MIN_HA = 1.5;
export const PLATEAU_RELIEF = 12;
/** A flat landform this large must hold a place (the Shelf's empty plateau). */
export const LANDFORM_HA = 15;
/** Fraction of a large landform that must lie within PLACE_REACH of a place. */
export const LANDFORM_COVER = 0.25;
export const PLACE_REACH = 150;
/** Peak: local summit within PEAK_WINDOW m standing PEAK_PROMINENCE m over the ground within 300 m. */
export const PEAK_WINDOW = 120;
export const PEAK_PROMINENCE = 45;
/** Saddle: rises SADDLE_RISE on two opposite sides and falls SADDLE_FALL on the other two, within 250 m. */
export const SADDLE_RISE = 30;
export const SADDLE_FALL = 18;
/** Wall gap: walkable neck no wider than GAP_MAX between barriers, opening out along the corridor. */
export const GAP_MAX = 220;
/** Cove: water cell with COVE_RAYS of 16 rays meeting land within 300 m, one mouth. */
export const COVE_RAYS = 11;
/** A path that climbs this much and stops (or tops out) must lead to a place. */
export const CLIMB_NEEDS_PLACE = 25;
/** Hairpin: the heading over the next 16 m of path turns more than this from the heading over the last 16 m. */
export const HAIRPIN_TURN = 100;
/** Wasted climb: a crest or dip on a path with at least this much height on both sides of it. */
export const WASTE_LEG = 30;
/** A path end within this of another path, a town or a place is connected. */
export const PATH_JOIN = 40;
/** Sight lines are tested from road points within this range. */
export const SIGHT_RANGE = 700;
/** Density gates (see docs/zone-creation-lessons.md "Site finder" for the measured zones). */
// Owner 2026-10-06: "it should be dense, it should feel like Skyrim, stuff around every corner": several major places
// plus many small ones; small finds (radius >= 10 m) count; nowhere further than EMPTY_MAX from something to see.
export const MIN_PER_KM2 = 8;
export const EMPTY_MAX = 250;

const DIRS16: Vec2[] = Array.from({ length: 16 }, (_, k) => [Math.sin((k * Math.PI) / 8), -Math.cos((k * Math.PI) / 8)]);
const WORDS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
/** Bearing of a direction (0 = north = -Z, clockwise). */
export const bearing = (dx: number, dz: number): number => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
export const compass = (deg: number): string => WORDS[Math.round(deg / 45) % 8]!;

export function pointInPolygon(x: number, z: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The sampled ground. */
export class Grid {
  readonly nx: number;
  readonly nz: number;
  readonly h: Float32Array;
  /** Water surface over the cell, NaN when dry. */
  readonly wy: Float32Array;
  readonly wkind: Uint8Array; // 0 dry, 1 lake, 2 river, 3 sea
  readonly slope: Float32Array;
  readonly zone: Uint8Array;
  constructor(
    readonly field: FieldLike,
    readonly x0: number,
    readonly z0: number,
    readonly x1: number,
    readonly z1: number,
    readonly step: number,
    seaLevel: number,
    polygon: Vec2[],
  ) {
    this.nx = Math.floor((x1 - x0) / step) + 1;
    this.nz = Math.floor((z1 - z0) / step) + 1;
    const n = this.nx * this.nz;
    this.h = new Float32Array(n);
    this.wy = new Float32Array(n).fill(NaN);
    this.wkind = new Uint8Array(n);
    this.slope = new Float32Array(n);
    this.zone = new Uint8Array(n);
    const ws = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        const k = j * this.nx + i;
        const h = field.height(x, z);
        this.h[k] = h;
        if (field.waterSurface(x, z, ws) && ws.y > h + 0.3) {
          this.wy[k] = ws.y;
          this.wkind[k] = ws.kind === "river" ? 2 : 1;
        } else if (h < seaLevel - 0.3) {
          this.wy[k] = seaLevel;
          this.wkind[k] = 3;
        }
        this.zone[k] = pointInPolygon(x, z, polygon) ? 1 : 0;
      }
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const a = this.h[j * this.nx + Math.max(0, i - 1)]!;
        const b = this.h[j * this.nx + Math.min(this.nx - 1, i + 1)]!;
        const c = this.h[Math.max(0, j - 1) * this.nx + i]!;
        const d = this.h[Math.min(this.nz - 1, j + 1) * this.nx + i]!;
        const gx = (b - a) / (2 * step);
        const gz = (d - c) / (2 * step);
        this.slope[j * this.nx + i] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
      }
  }
  idx(i: number, j: number): number {
    return j * this.nx + i;
  }
  xOf(i: number): number {
    return this.x0 + i * this.step;
  }
  zOf(j: number): number {
    return this.z0 + j * this.step;
  }
  cell(x: number, z: number): number {
    const i = Math.round((x - this.x0) / this.step);
    const j = Math.round((z - this.z0) / this.step);
    return i < 0 || j < 0 || i >= this.nx || j >= this.nz ? -1 : j * this.nx + i;
  }
  wet(k: number): boolean {
    return this.wkind[k]! > 0;
  }
  walkable(k: number): boolean {
    return !this.wet(k) && this.slope[k]! < WALK_SLOPE;
  }
  /** Bilinear ground height (clamped to the grid). */
  ground(x: number, z: number): number {
    const fx = Math.min(this.nx - 1.001, Math.max(0, (x - this.x0) / this.step));
    const fz = Math.min(this.nz - 1.001, Math.max(0, (z - this.z0) / this.step));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h = this.h;
    const n = this.nx;
    return (h[j * n + i]! * (1 - u) + h[j * n + i + 1]! * u) * (1 - v) + (h[(j + 1) * n + i]! * (1 - u) + h[(j + 1) * n + i + 1]! * u) * v;
  }
  /** Walk a ray from cell (i, j) in direction d (unit, world), calling fn(k, dist) per step until it returns true. */
  ray(i: number, j: number, d: Vec2, range: number, fn: (k: number, dist: number) => boolean | void): void {
    const steps = Math.floor(range / this.step);
    for (let s = 1; s <= steps; s++) {
      const ii = Math.round(i + d[0] * s);
      const jj = Math.round(j + d[1] * s);
      if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) return;
      if (fn(jj * this.nx + ii, s * this.step)) return;
    }
  }
  /** Line of sight between two world points over the sampled ground. */
  sees(ax: number, az: number, ay: number, bx: number, bz: number, by: number): boolean {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(2, Math.ceil(len / this.step));
    for (let s = 1; s < n; s++) {
      const t = s / n;
      if (this.ground(ax + (bx - ax) * t, az + (bz - az) * t) > ay + (by - ay) * t - 0.5) return false;
    }
    return true;
  }
}

/** Sliding max/min over a square window (radius r cells), separable. */
function windowed(src: Float32Array, nx: number, nz: number, r: number, max: boolean): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const pick = max ? Math.max : Math.min;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      let v = src[j * nx + i]!;
      for (let d = Math.max(0, i - r); d <= Math.min(nx - 1, i + r); d++) v = pick(v, src[j * nx + d]!);
      tmp[j * nx + i] = v;
    }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      let v = tmp[j * nx + i]!;
      for (let d = Math.max(0, j - r); d <= Math.min(nz - 1, j + r); d++) v = pick(v, tmp[d * nx + i]!);
      out[j * nx + i] = v;
    }
  return out;
}

/** Resample a polyline every `step` metres. */
export function resample(points: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  if (!points.length) return out;
  out.push([points[0]![0], points[0]![1]]);
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]!;
    const [bx, bz] = points[i]!;
    const len = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= len) {
      out.push([ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len]);
      t += step;
    }
    carry = len - (t - step);
  }
  const last = points[points.length - 1]!;
  if (Math.hypot(out[out.length - 1]![0] - last[0], out[out.length - 1]![1] - last[1]) > 1) out.push([last[0], last[1]]);
  return out;
}

interface Raw {
  kind: SiteKind;
  x: number;
  z: number;
  score: number;
  why: string;
  detail: J;
}

/** Keep the best of each kind, dropping any within `sep` m of a better one of the same kind. */
function suppress(list: Raw[], sep: number): Raw[] {
  const kept: Raw[] = [];
  for (const c of list.sort((a, b) => b.score - a.score)) if (!kept.some((k) => Math.hypot(k.x - c.x, k.z - c.z) < sep)) kept.push(c);
  return kept;
}

export interface FindInput {
  field: FieldLike;
  seaLevel: number;
  polygon: Vec2[];
  /** The zone id (reservations carry theirs; density counts this zone's). */
  zone: string;
  roads: RoadLine[];
  content: Content[];
  /** Recipe canyons (their two ends are tested as canyon ends). */
  canyons?: { id: string; points: Vec2[] }[];
  step?: number;
  margin?: number;
  /** Per-kind cap in the output. */
  perKind?: number;
}

export function findSites(input: FindInput): SiteReport {
  const step = input.step ?? STEP;
  const margin = input.margin ?? 300;
  const xs = input.polygon.map((p) => p[0]);
  const zs = input.polygon.map((p) => p[1]);
  const box: [number, number, number, number] = [Math.min(...xs) - margin, Math.min(...zs) - margin, Math.max(...xs) + margin, Math.max(...zs) + margin];
  const g = new Grid(input.field, box[0], box[1], box[2], box[3], step, input.seaLevel, input.polygon);
  const { nx, nz } = g;
  const raw: Raw[] = [];
  const stride = 2; // ray-based detectors run on every 2nd cell (16 m)

  // ---- road samples (shared by approach, wall-gap and path analysis)
  const roadSamples: { road: string; x: number; z: number; y: number }[] = [];
  const roadsIn = input.roads.filter((r) => r.points.some(([x, z]) => x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3]));
  for (const r of roadsIn) for (const [x, z] of resample(r.points, 16)) if (x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3]) roadSamples.push({ road: r.id, x, z, y: g.ground(x, z) });
  const roadNear = (x: number, z: number, within: number): { road: string; d: number; x: number; z: number } | null => {
    let best: { road: string; d: number; x: number; z: number } | null = null;
    for (const s of roadSamples) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d <= within && (!best || d < best.d)) best = { road: s.road, d, x: s.x, z: s.z };
    }
    return best;
  };
  const townNear = (x: number, z: number, within: number): Content | null => {
    let best: Content | null = null;
    let bd = Infinity;
    for (const c of input.content) {
      if (c.kind !== "town") continue;
      const d = Math.hypot(c.x - x, c.z - z) - c.radius;
      if (d <= within && d < bd) (best = c), (bd = d);
    }
    return best;
  };

  // ---- 1. cliff-water: a standable perch, steep drop to water within CLIFF_REACH
  for (let j = 0; j < nz; j += 1)
    for (let i = 0; i < nx; i += 1) {
      const k = g.idx(i, j);
      if (!g.zone[k] || g.wet(k) || g.slope[k]! > 25) continue;
      const h = g.h[k]!;
      let best = 0;
      let dir = -1;
      let wkind = 0;
      for (let d = 0; d < 16; d++) {
        // the perch stands AT the edge: the ground toward the water falls away within the first 16 m
        const edge = g.cell(g.xOf(i) + DIRS16[d]![0] * 16, g.zOf(j) + DIRS16[d]![1] * 16);
        if (edge < 0 || (!g.wet(edge) && h - g.h[edge]! < 5)) continue;
        g.ray(i, j, DIRS16[d]!, CLIFF_REACH, (kk, dist) => {
          if (!g.wet(kk)) return false;
          const drop = h - g.wy[kk]!;
          if (drop >= CLIFF_DROP && drop / dist >= 0.5 && drop > best) (best = drop), (dir = d), (wkind = g.wkind[kk]!);
          return true;
        });
      }
      if (dir < 0) continue;
      // the perch: flat standable ground within 30 m at about this height
      let perch = 0;
      for (let dj = -4; dj <= 4; dj++)
        for (let di = -4; di <= 4; di++) {
          const kk = g.cell(g.xOf(i + di), g.zOf(j + dj));
          if (kk >= 0 && !g.wet(kk) && g.slope[kk]! < 15 && Math.abs(g.h[kk]! - h) < 5) perch++;
        }
      const water = ["", "lake", "river", "sea"][wkind]!;
      const perchM2 = perch * step * step;
      if (perchM2 < CLIFF_PERCH) continue; // a knife-edge over water holds nothing
      raw.push({
        kind: "cliff-water",
        x: g.xOf(i),
        z: g.zOf(j),
        score: 3 + Math.min(4, best / 30) + Math.min(2, perchM2 / 1500),
        why: `perch ${Math.round(best)} m above the ${water}, drop to the ${compass(bearing(DIRS16[dir]![0], DIRS16[dir]![1]))}; ${Math.round(perchM2 / 100) / 100} ha flat on top`,
        detail: { drop: Math.round(best), water, overlooks: compass(bearing(DIRS16[dir]![0], DIRS16[dir]![1])), perchM2 },
      });
    }

  // ---- 2. canyon-end: walled in >= CANYON_RAYS of 16 directions, open in one contiguous arc (the mouth)
  const enclosure = (i: number, j: number): { walls: boolean[]; rise: number } => {
    const h = g.h[g.idx(i, j)]!;
    const walls: boolean[] = [];
    let riseSum = 0;
    for (let d = 0; d < 16; d++) {
      let rise = 0;
      g.ray(i, j, DIRS16[d]!, CANYON_RANGE, (kk) => {
        rise = Math.max(rise, g.h[kk]! - h);
        return rise >= CANYON_RISE * 3;
      });
      walls.push(rise >= CANYON_RISE);
      if (rise >= CANYON_RISE) riseSum += rise;
    }
    return { walls, rise: riseSum / Math.max(1, walls.filter(Boolean).length) };
  };
  const mouthOf = (walls: boolean[]): { arcs: number; bearing: number; width: number } => {
    let arcs = 0;
    for (let d = 0; d < 16; d++) if (!walls[d] && walls[(d + 15) % 16]) arcs++;
    let sx = 0;
    let sz = 0;
    for (let d = 0; d < 16; d++) if (!walls[d]) (sx += DIRS16[d]![0]), (sz += DIRS16[d]![1]);
    return { arcs, bearing: bearing(sx, sz), width: walls.filter((w) => !w).length };
  };
  const canyonCell = (i: number, j: number, src: string): void => {
    const k = g.idx(i, j);
    if (!g.zone[k] || !g.walkable(k) || g.slope[k]! > 20) return;
    const { walls, rise } = enclosure(i, j);
    const n = walls.filter(Boolean).length;
    if (n < CANYON_RAYS || n === 16) return;
    const m = mouthOf(walls);
    if (m.arcs !== 1) return;
    // the back wall: walk away from the mouth until the ground rises 8 m; a door or a set piece goes at its foot,
    // facing the mouth (the way the player comes in)
    const back = (m.bearing + 180) % 360;
    const bd: Vec2 = [Math.sin((back * Math.PI) / 180), -Math.cos((back * Math.PI) / 180)];
    const h0 = g.h[k]!;
    let wall: Vec2 | null = null;
    g.ray(i, j, bd, CANYON_RANGE, (kk, dist) => {
      if (g.h[kk]! - h0 < 8) return false;
      wall = [Math.round(g.xOf(i) + bd[0] * (dist - step)), Math.round(g.zOf(j) + bd[1] * (dist - step))];
      return true;
    });
    raw.push({
      kind: "canyon-end",
      x: g.xOf(i),
      z: g.zOf(j),
      score: 3 + (n - CANYON_RAYS) * 0.6 + Math.min(3, rise / 35) + (src ? 0.5 : 0),
      why: `${src ? `end of ${src}: ` : ""}walled on ${n}/16 sides (walls ~${Math.round(rise)} m), one mouth opening ${compass(m.bearing)}${wall ? `; back wall foot at [${wall[0]}, ${wall[1]}] faces the mouth` : ""}`,
      detail: { walled: n, wallHeight: Math.round(rise), mouth: compass(m.bearing), mouthBearing: Math.round(m.bearing), backWall: wall, canyon: src || undefined },
    });
  };
  for (let j = 0; j < nz; j += stride) for (let i = 0; i < nx; i += stride) canyonCell(i, j, "");
  for (const c of input.canyons ?? []) {
    for (const end of [c.points[0], c.points[c.points.length - 1]]) {
      if (!end) continue;
      // the floor near the recipe end: the lowest walkable cell within 40 m
      const k0 = g.cell(end[0], end[1]);
      if (k0 < 0) continue;
      let bi = -1;
      let bj = -1;
      let bh = Infinity;
      for (let dj = -5; dj <= 5; dj++)
        for (let di = -5; di <= 5; di++) {
          const kk = g.cell(end[0] + di * step, end[1] + dj * step);
          if (kk >= 0 && g.walkable(kk) && g.h[kk]! < bh) (bh = g.h[kk]!), (bi = kk % nx), (bj = Math.floor(kk / nx));
        }
      if (bi >= 0) canyonCell(bi, bj, c.id);
    }
  }

  // ---- 3. plateaus and large flat landforms: connected flat ground, relief over the ring around it
  const comp = new Int32Array(nx * nz).fill(-1);
  const landforms: SiteReport["landforms"] = [];
  const contentDist = (x: number, z: number): { d: number; id: string | null } => {
    let d = Infinity;
    let id: string | null = null;
    for (const c of input.content) {
      const e = Math.hypot(c.x - x, c.z - z) - c.radius;
      if (e < d) (d = e), (id = c.id);
    }
    return { d, id };
  };
  {
    let next = 0;
    const queue = new Int32Array(nx * nz);
    for (let k0 = 0; k0 < nx * nz; k0++) {
      if (comp[k0] !== -1 || g.wet(k0) || g.slope[k0]! >= FLAT) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = k0;
      comp[k0] = next;
      while (head < tail) {
        const k = queue[head++]!;
        const i = k % nx;
        const j = (k - i) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const kk = jj * nx + ii;
          if (comp[kk] !== -1 || g.wet(kk) || g.slope[kk]! >= FLAT) continue;
          comp[kk] = next;
          queue[tail++] = kk;
        }
      }
      const cells = Array.from(queue.subarray(0, tail));
      const id = next++;
      const ha = (cells.length * step * step) / 10000;
      if (ha < PLATEAU_MIN_HA) continue;
      const inZone = cells.filter((k) => g.zone[k]).length / cells.length;
      if (inZone < 0.5) continue;
      // ring: cells within 120 m outside the component (sampled on the component's boundary)
      const ring: number[] = [];
      const hs = cells.map((k) => g.h[k]!).sort((a, b) => a - b);
      const median = hs[hs.length >> 1]!;
      for (const k of cells) {
        const i = k % nx;
        const j = (k - i) / nx;
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => {
          const ii = i + di!;
          const jj = j + dj!;
          return ii >= 0 && jj >= 0 && ii < nx && jj < nz && comp[jj * nx + ii] !== id;
        });
        if (!edge) continue;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          let low = Infinity;
          for (let s = 2; s <= 15; s++) {
            const ii = i + di! * s;
            const jj = j + dj! * s;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) break;
            const kk = jj * nx + ii;
            if (comp[kk] === id) break;
            low = Math.min(low, g.wet(kk) ? g.wy[kk]! : g.h[kk]!);
          }
          if (low < Infinity) ring.push(low);
        }
      }
      ring.sort((a, b) => a - b);
      const relief = ring.length ? median - ring[ring.length >> 1]! : 0;
      // the heart: the component cell farthest from its own edge (coarse: farthest from the edge sample)
      let sx = 0;
      let sz = 0;
      for (const k of cells) (sx += g.xOf(k % nx)), (sz += g.zOf(Math.floor(k / nx)));
      let heart = cells[0]!;
      let hd = Infinity;
      const cx = sx / cells.length;
      const cz = sz / cells.length;
      for (const k of cells) {
        const d = Math.hypot(g.xOf(k % nx) - cx, g.zOf(Math.floor(k / nx)) - cz);
        if (d < hd) (hd = d), (heart = k);
      }
      const hx = g.xOf(heart % nx);
      const hz = g.zOf(Math.floor(heart / nx));
      const raised = relief >= PLATEAU_RELIEF;
      if (raised) {
        const mesa = ha < 10;
        raw.push({
          kind: "plateau",
          x: hx,
          z: hz,
          score: 2 + Math.min(3, relief / 25) + Math.min(3, Math.log2(1 + ha) * 0.6),
          why: `${mesa ? "mesa" : "plateau"} of ${ha.toFixed(1)} ha standing ${Math.round(relief)} m over its foot`,
          detail: { areaHa: +ha.toFixed(1), relief: Math.round(relief), mesa, component: id },
        });
      }
      if (ha >= LANDFORM_HA) {
        let covered = 0;
        let user: string | null = null;
        for (const k of cells) {
          const c = contentDist(g.xOf(k % nx), g.zOf(Math.floor(k / nx)));
          if (c.d <= PLACE_REACH) {
            covered++;
            if (c.d <= 0) user = c.id;
          }
        }
        landforms.push({ id: `landform-${id}`, kind: raised ? "plateau" : "flat", at: [Math.round(hx), Math.round(hz)], areaHa: +ha.toFixed(1), relief: Math.round(relief), covered: +(covered / cells.length).toFixed(2), usedBy: user });
      }
    }
  }

  // ---- 4. peaks: local maxima with prominence
  const win = Math.round(PEAK_WINDOW / step);
  const hmax = windowed(g.h, nx, nz, win, true);
  const hmin = windowed(g.h, nx, nz, Math.round(300 / step), false);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = g.idx(i, j);
      if (!g.zone[k] || g.wet(k) || g.h[k]! < hmax[k]!) continue;
      // a summit, not the flat top of a plateau: the ground 60 m out falls away on average
      let ring = 0;
      for (const d of DIRS16) ring += g.ground(g.xOf(i) + d[0] * 60, g.zOf(j) + d[1] * 60);
      if (g.h[k]! - ring / 16 < 6) continue;
      const prom = g.h[k]! - hmin[k]!;
      if (prom < PEAK_PROMINENCE) continue;
      raw.push({ kind: "peak", x: g.xOf(i), z: g.zOf(j), score: 2 + Math.min(4, prom / 110), why: `summit ${Math.round(prom)} m over the ground within 300 m`, detail: { prominence: Math.round(prom) } });
    }

  // ---- 5. saddles / passes
  for (let j = 0; j < nz; j += stride)
    for (let i = 0; i < nx; i += stride) {
      const k = g.idx(i, j);
      if (!g.zone[k] || !g.walkable(k)) continue;
      const h = g.h[k]!;
      const ext: { rise: number; fall: number }[] = [];
      for (let d = 0; d < 16; d++) {
        let rise = 0;
        let fall = 0;
        g.ray(i, j, DIRS16[d]!, 250, (kk) => {
          const v = g.wet(kk) ? g.wy[kk]! : g.h[kk]!;
          rise = Math.max(rise, v - h);
          fall = Math.max(fall, h - v);
        });
        ext.push({ rise, fall });
      }
      let best = 0;
      let axis = -1;
      for (let a = 0; a < 8; a++) {
        const up = Math.min(ext[a]!.rise, ext[a + 8]!.rise);
        const b = (a + 4) % 16;
        const down = Math.min(ext[b]!.fall, ext[(b + 8) % 16]!.fall);
        // the cell must be the low point along the ridge axis (not on a flank)
        const flank = Math.max(ext[a]!.fall, ext[a + 8]!.fall);
        if (up >= SADDLE_RISE && down >= SADDLE_FALL && flank < 8 && Math.min(up, down) > best) (best = Math.min(up, down)), (axis = a);
      }
      if (axis < 0) continue;
      const crossing = (axis + 4) % 8;
      const road = roadNear(g.xOf(i), g.zOf(j), 60);
      raw.push({
        kind: "saddle",
        x: g.xOf(i),
        z: g.zOf(j),
        score: 3 + Math.min(3, best / 30) + (road ? 1.5 : 0),
        why: `pass between heights ${Math.round(Math.min(ext[axis]!.rise, ext[axis + 8]!.rise))} m to the ${compass(bearing(...DIRS16[axis]!))}/${compass(bearing(...DIRS16[axis + 8]!))}, crossing ${compass(bearing(...DIRS16[crossing]!))}-${compass(bearing(...DIRS16[crossing + 8]!))}${road ? `; ${road.road} goes over it` : ""}`,
        detail: { depth: Math.round(best), road: road?.road },
      });
    }

  // ---- 6. wall gaps: narrowest walkable neck between barriers (cliff rising / water), opening out along it
  const barrier = (k: number, h0: number): "water" | "cliff" | null => (g.wet(k) ? "water" : g.slope[k]! >= 38 && g.h[k]! - h0 >= 5 ? "cliff" : null);
  for (let j = 0; j < nz; j += stride)
    for (let i = 0; i < nx; i += stride) {
      const k = g.idx(i, j);
      if (!g.zone[k] || !g.walkable(k) || g.slope[k]! > 20) continue;
      const h0 = g.h[k]!;
      let best: { gap: number; a: number; d1: number; d2: number; t1: string; t2: string } | null = null;
      for (let a = 0; a < 8; a++) {
        const hit = (d: Vec2): { dist: number; type: string } | null => {
          let out: { dist: number; type: string } | null = null;
          g.ray(i, j, d, GAP_MAX, (kk, dist) => {
            const b = barrier(kk, h0);
            if (b) out = { dist, type: b };
            return !!b;
          });
          return out;
        };
        const p = hit(DIRS16[a]!);
        if (!p) continue;
        const q = hit(DIRS16[a + 8]!);
        if (!q) continue;
        const gap = p.dist + q.dist;
        if (gap <= GAP_MAX && (!best || gap < best.gap)) best = { gap, a, d1: p.dist, d2: q.dist, t1: p.type, t2: q.type };
      }
      if (!best) continue;
      if (best.t1 === "water" && best.t2 === "water") continue; // an isthmus between two waters is not a wall site
      // a neck opens out: along the corridor (perpendicular) the ground runs on for 150 m both ways
      const along = (best.a + 4) % 16;
      let open = 0;
      for (const d of [along, (along + 8) % 16]) {
        let blocked = false;
        g.ray(i, j, DIRS16[d]!, 150, (kk) => (blocked = !!barrier(kk, h0)));
        if (!blocked) open++;
      }
      if (open < 2) continue;
      const u = DIRS16[best.a]!;
      const x = g.xOf(i);
      const z = g.zOf(j);
      const road = roadNear(x, z, 30);
      const town = townNear(x, z, 900);
      const mixed = best.t1 !== best.t2;
      raw.push({
        kind: "wall-gap",
        x,
        z,
        score: 2 + 3 * (1 - best.gap / GAP_MAX) + (road ? 1 : 0) + (town ? 1.5 : 0) + (mixed ? 0.5 : 0),
        why: `${Math.round(best.gap)} m neck between ${best.t1} and ${best.t2}${road ? `, ${road.road} runs through it` : ""}${town ? `, ${Math.round(Math.hypot(town.x - x, town.z - z))} m from ${town.id}` : ""}`,
        detail: {
          gap: Math.round(best.gap),
          sides: [best.t1, best.t2],
          line: [
            [Math.round(x + u[0] * best.d1), Math.round(z + u[1] * best.d1)],
            [Math.round(x - u[0] * best.d2), Math.round(z - u[1] * best.d2)],
          ],
          road: road?.road,
          town: town?.id,
        },
      });
    }

  // ---- 7. coves: water enclosed by land with one mouth, near a shore
  for (let j = 0; j < nz; j += stride)
    for (let i = 0; i < nx; i += stride) {
      const k = g.idx(i, j);
      if (!g.wet(k) || g.wkind[k] === 2) continue;
      let shore = Infinity;
      const land: boolean[] = [];
      let shoreH = 0;
      for (let d = 0; d < 16; d++) {
        let hit = false;
        g.ray(i, j, DIRS16[d]!, 300, (kk, dist) => {
          if (g.wet(kk)) return false;
          hit = true;
          shore = Math.min(shore, dist);
          shoreH += Math.max(0, hmax[kk]! - g.wy[k]!);
          return true;
        });
        land.push(hit);
      }
      if (shore > 60) continue;
      const n = land.filter(Boolean).length;
      if (n < COVE_RAYS || n === 16) continue;
      const m = mouthOf(land);
      if (m.arcs !== 1) continue;
      // the landing: nearest walkable shore cell
      let lx = g.xOf(i);
      let lz = g.zOf(j);
      let ld = Infinity;
      for (let d = 0; d < 16; d++)
        g.ray(i, j, DIRS16[d]!, 120, (kk, dist) => {
          if (g.wet(kk)) return false;
          if (g.walkable(kk) && dist < ld) (ld = dist), (lx = g.xOf(kk % nx)), (lz = g.zOf(Math.floor(kk / nx)));
          return true;
        });
      if (!g.zone[g.cell(lx, lz)]) continue;
      const wall = shoreH / n;
      raw.push({
        kind: "cove",
        x: lx,
        z: lz,
        score: 2.5 + (n - COVE_RAYS) * 0.4 + Math.min(2.5, wall / 60),
        why: `${["", "lake", "river", "sea"][g.wkind[k]!]} cove closed on ${n}/16 sides, mouth to the ${compass(m.bearing)}, banks ~${Math.round(wall)} m`,
        detail: { closed: n, mouth: compass(m.bearing), banks: Math.round(wall), water: [g.xOf(i), g.zOf(j)] },
      });
    }

  // ---- 8. waterfalls (solved by the field)
  for (const f of input.field.falls ?? []) {
    const k = g.cell(f.x, f.z);
    if (k < 0 || !g.zone[k]) continue;
    const drop = f.top - f.bottom;
    raw.push({ kind: "waterfall", x: f.x, z: f.z, score: 4 + Math.min(4, drop / 5), why: `${f.river} falls ${drop.toFixed(1)} m`, detail: { river: f.river, drop: +drop.toFixed(1) } });
  }

  // ---- 9. paths: dead ends, climbing tops, hairpins, wasted climbs
  const paths: PathFinding[] = [];
  const connected = (x: number, z: number, self: string): string | null => {
    for (const c of input.content) if (Math.hypot(c.x - x, c.z - z) <= c.radius + PATH_JOIN + (c.kind === "town" ? 60 : 0)) return c.id;
    for (const r of input.roads) {
      if (r.id === self) continue;
      for (let s = 1; s < r.points.length; s++) if (segDist(x, z, r.points[s - 1]!, r.points[s]!) <= PATH_JOIN) return `road ${r.id}`;
    }
    return null;
  };
  const placeNear = (x: number, z: number, within: number): string | null => {
    const c = contentDist(x, z);
    return c.d <= within ? c.id : null;
  };
  for (const r of roadsIn) {
    // paths are resampled finer than the grid (hairpin legs on a hillside are 10-20 m) and read the field itself
    const PSTEP = 4;
    const pts = resample(r.points, PSTEP);
    if (pts.length < 3) continue;
    if (!pts.some(([x, z]) => { const k = g.cell(x, z); return k >= 0 && g.zone[k]; })) continue;
    const ys = pts.map(([x, z]) => input.field.height(x, z));
    // hairpins: the heading over the next 16 m turns HAIRPIN_TURN from the heading over the last 16 m
    const turnAt: number[] = [];
    const span = Math.max(2, Math.round(16 / PSTEP));
    for (let s = span; s < pts.length - span; s++) {
      const a = bearing(pts[s]![0] - pts[s - span]![0], pts[s]![1] - pts[s - span]![1]);
      const b = bearing(pts[s + span]![0] - pts[s]![0], pts[s + span]![1] - pts[s]![1]);
      const turn = Math.abs(((b - a + 540) % 360) - 180);
      if (turn >= HAIRPIN_TURN && (!turnAt.length || s - turnAt[turnAt.length - 1]! > span * 2)) turnAt.push(s);
    }
    // ends
    for (const end of [0, pts.length - 1]) {
      const [x, z] = pts[end]!;
      const k = g.cell(x, z);
      if (k < 0 || !g.zone[k]) continue;
      const join = connected(x, z, r.id);
      if (join) continue;
      // how much the last 600 m climbs to reach this end
      const n = Math.min(pts.length - 1, Math.round(600 / PSTEP));
      const seg = end === 0 ? ys.slice(0, n + 1) : ys.slice(ys.length - 1 - n);
      const climb = ys[end]! - Math.min(...seg);
      const hp = turnAt.filter((s) => (end === 0 ? s <= n : s >= pts.length - 1 - n)).length;
      const dest = placeNear(x, z, PLACE_REACH);
      paths.push({
        road: r.id,
        kind: "dead-end",
        at: [Math.round(x), Math.round(z)],
        climb: Math.round(climb),
        switchbacks: hp,
        leadsTo: dest,
        message: `${r.id} stops at [${Math.round(x)}, ${Math.round(z)}] after climbing ${Math.round(climb)} m${hp ? ` over ${hp} hairpin(s)` : ""}${dest ? `; reaches ${dest}` : ": it leads to nothing"}`,
      });
      if (!dest) raw.push({
        kind: "path-end",
        x,
        z,
        score: Math.min(10, 4 + climb / 20 + hp * 0.5),
        why: `${r.trail ? "trail" : "road"} ${r.id} ends here after climbing ${Math.round(climb)} m${hp ? ` (${hp} hairpins)` : ""}: a cave, house or ruin belongs at its end`,
        detail: { road: r.id, climb: Math.round(climb), hairpins: hp },
      });
    }
    // switchback tops: a run of 2+ hairpins; its top must lead somewhere (a place) or carry on over a pass
    for (let a = 0; a + 1 < turnAt.length; ) {
      let b = a;
      while (b + 1 < turnAt.length && (turnAt[b + 1]! - turnAt[b]!) * PSTEP <= 120) b++;
      if (b > a) {
        let top = turnAt[a]!;
        let bottom = turnAt[a]!;
        const lo = Math.max(0, turnAt[a]! - span * 3);
        const hi = Math.min(pts.length - 1, turnAt[b]! + span * 3);
        for (let s = lo; s <= hi; s++) {
          if (ys[s]! > ys[top]!) top = s;
          if (ys[s]! < ys[bottom]!) bottom = s;
        }
        const climb = ys[top]! - ys[bottom]!;
        if (climb >= CLIMB_NEEDS_PLACE) {
          const [x, z] = pts[top]!;
          const dest = placeNear(x, z, PLACE_REACH + 50);
          const k = g.cell(x, z);
          if (k >= 0 && g.zone[k]) {
            paths.push({ road: r.id, kind: "switchback-top", at: [Math.round(x), Math.round(z)], climb: Math.round(climb), switchbacks: b - a + 1, leadsTo: dest, message: `${r.id} winds up ${b - a + 1} hairpins (${Math.round(climb)} m) to [${Math.round(x)}, ${Math.round(z)}]${dest ? `; ${dest} is there` : ": nothing waits at the top"}` });
            raw.push({ kind: "switchback", x, z, score: Math.min(9, 3.5 + climb / 20 + (b - a) * 0.5), why: `top of ${b - a + 1} hairpins on ${r.id}, ${Math.round(climb)} m up`, detail: { road: r.id, climb: Math.round(climb), hairpins: b - a + 1 } });
          }
        }
      }
      a = b + 1;
    }
    // wasted climb: the profile's turning points (10 m hysteresis); a crest or a dip whose legs on BOTH sides exceed
    // WASTE_LEG is height the route gains only to give back (over a ridge and back up it, down a gully and up again)
    const turns: number[] = [0];
    let dirUp = 0;
    let ext = 0;
    for (let s = 1; s < ys.length; s++) {
      if (dirUp >= 0 && ys[s]! > ys[ext]!) (ext = s), (dirUp = 1);
      else if (dirUp <= 0 && ys[s]! < ys[ext]!) (ext = s), (dirUp = -1);
      else if (Math.abs(ys[s]! - ys[ext]!) >= 10) {
        turns.push(ext);
        dirUp = ys[s]! > ys[ext]! ? 1 : -1;
        ext = s;
      }
    }
    turns.push(ys.length - 1);
    for (let t = 1; t + 1 < turns.length; t++) {
      const [p, q, n] = [turns[t - 1]!, turns[t]!, turns[t + 1]!];
      const legIn = Math.abs(ys[q]! - ys[p]!);
      const legOut = Math.abs(ys[n]! - ys[q]!);
      const lengthM = (n - p) * PSTEP;
      if (Math.min(legIn, legOut) < WASTE_LEG || lengthM > 2500) continue;
      const [x, z] = pts[q]!;
      const k = g.cell(x, z);
      if (k < 0 || !g.zone[k]) continue;
      const crest = ys[q]! > ys[p]!;
      paths.push({
        road: r.id,
        kind: "wasted-climb",
        at: [Math.round(x), Math.round(z)],
        climb: Math.round(Math.min(legIn, legOut)),
        switchbacks: 0,
        leadsTo: null,
        message: `${r.id} ${crest ? `climbs ${Math.round(legIn)} m over a crest at [${Math.round(x)}, ${Math.round(z)}] and drops ${Math.round(legOut)} m` : `drops ${Math.round(legIn)} m into a dip at [${Math.round(x)}, ${Math.round(z)}] and climbs ${Math.round(legOut)} m back`} within ${Math.round(lengthM)} m: route along the contour, or put the place on the high ground the road already reached`,
      });
    }
  }

  // ---- 10. empty land: the largest discs of walkable land inside the zone with nothing in them
  const empties: SiteReport["empties"] = [];
  {
    const dist = new Float32Array(nx * nz).fill(-1);
    for (let j = 0; j < nz; j += stride)
      for (let i = 0; i < nx; i += stride) {
        const k = g.idx(i, j);
        if (!g.zone[k] || !g.walkable(k)) continue;
        dist[k] = Math.max(0, contentDist(g.xOf(i), g.zOf(j)).d);
      }
    // a disc counts as empty LAND: shrink it until at least 60% of it is dry ground inside the zone (a disc that is
    // mostly sea or a neighbour zone is not open space this zone failed to use)
    const landRadius = (x: number, z: number, r0: number): number => {
      for (let r = r0; r >= 150; r -= 25) {
        let n = 0;
        let land = 0;
        for (let dj = -6; dj <= 6; dj++)
          for (let di = -6; di <= 6; di++) {
            if (di * di + dj * dj > 36) continue;
            const kk = g.cell(x + (di * r) / 6, z + (dj * r) / 6);
            n++;
            if (kk >= 0 && g.zone[kk] && !g.wet(kk)) land++;
          }
        if (land >= 0.6 * n) return r;
      }
      return 0;
    };
    const order: number[] = [];
    for (let k = 0; k < nx * nz; k++) if (dist[k]! > 150) order.push(k);
    for (const k of order) dist[k] = landRadius(g.xOf(k % nx), g.zOf(Math.floor(k / nx)), dist[k]!);
    order.sort((a, b) => dist[b]! - dist[a]!);
    for (const k of order) {
      const x = g.xOf(k % nx);
      const z = g.zOf(Math.floor(k / nx));
      const r = dist[k]!;
      if (r < 200 || empties.length >= 6) break;
      if (empties.some((e) => Math.hypot(e.at[0] - x, e.at[1] - z) < e.radius + r * 0.5)) continue;
      // what the empty land is: the landform under the disc
      const c = comp[k]!;
      const lf = landforms.find((l) => l.id === `landform-${c}`);
      let steep = 0;
      let wet = 0;
      let n = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let dj = -6; dj <= 6; dj++)
        for (let di = -6; di <= 6; di++) {
          const kk = g.cell(x + (di * r) / 6, z + (dj * r) / 6);
          if (kk < 0 || di * di + dj * dj > 36) continue;
          n++;
          if (g.wet(kk)) wet++;
          else if (g.slope[kk]! > 20) steep++;
          lo = Math.min(lo, g.h[kk]!);
          hi = Math.max(hi, g.h[kk]!);
        }
      const landform = lf
        ? `${lf.kind} landform ${lf.areaHa} ha${lf.relief >= PLATEAU_RELIEF ? `, ${lf.relief} m over its foot` : ""}`
        : `${Math.round((100 * steep) / n)}% steep, ${Math.round((100 * wet) / n)}% water, ${Math.round(hi - lo)} m relief`;
      empties.push({ at: [Math.round(x), Math.round(z)], radius: Math.round(r), landform });
      raw.push({ kind: "empty-land", x, z, score: Math.min(10, r / 60), why: `${Math.round(r)} m from any place, town or reservation: ${landform}`, detail: { radius: Math.round(r) } });
    }
  }

  // ---- 11. islands: dry ground wholly ringed by lake/river water (easy, strong places: sites.md)
  {
    const seen = new Uint8Array(nx * nz);
    const stack: number[] = [];
    for (let k0 = 0; k0 < nx * nz; k0++) {
      if (seen[k0] || g.wet(k0)) continue;
      seen[k0] = 1;
      stack.length = 0;
      stack.push(k0);
      const cells: number[] = [];
      let edge = false;
      let sea = false;
      while (stack.length) {
        const k = stack.pop()!;
        cells.push(k);
        const i = k % nx;
        const j = (k - i) / nx;
        if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) edge = true;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const kk = jj * nx + ii;
          if (g.wet(kk)) {
            if (g.wkind[kk] === 3) sea = true;
            continue;
          }
          if (!seen[kk]) (seen[kk] = 1), stack.push(kk);
        }
      }
      const m2 = cells.length * step * step;
      if (edge || sea || m2 < ISLAND_MIN_M2 || m2 > ISLAND_MAX_HA * 1e4) continue;
      // the island's highest standable cell, and its height over the water round it
      let top = cells[0]!;
      for (const k of cells) if (g.h[k]! > g.h[top]!) top = k;
      let wy = -Infinity;
      for (const k of cells) {
        const i = k % nx;
        const j = (k - i) / nx;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const kk = (j + dj) * nx + i + di;
          if (g.wet(kk)) wy = Math.max(wy, g.wy[kk]!);
        }
      }
      const ti = top % nx;
      const tj = (top - ti) / nx;
      const ha = m2 / 1e4;
      raw.push({
        kind: "island",
        x: g.xOf(ti),
        z: g.zOf(tj),
        score: 6 + Math.min(3, ha * 1.5),
        why: `island of ${ha.toFixed(2)} ha, ${Math.max(0, Math.round(g.h[top]! - wy))} m over the water round it`,
        detail: { areaHa: +ha.toFixed(2), rise: Math.max(0, Math.round(g.h[top]! - wy)) },
      });
    }
  }

  // ---- rank, suppress, approach
  const sep: Record<SiteKind, number> = { "cliff-water": 160, "canyon-end": 200, plateau: 250, peak: 250, saddle: 220, "wall-gap": 220, cove: 220, waterfall: 60, "path-end": 40, switchback: 120, "empty-land": 1, island: 30, access: 1 };
  const perKind = input.perKind ?? 15;
  const kinds = [...new Set(raw.map((r) => r.kind))];
  const kept = kinds.flatMap((kind) => suppress(raw.filter((r) => r.kind === kind), sep[kind]).slice(0, kind === "path-end" || kind === "empty-land" ? 99 : perKind));

  // walkable ground joined to a road or path: flood from every road sample over dry cells under WALK_SLOPE
  const reach = new Uint8Array(nx * nz);
  {
    const stack: number[] = [];
    for (const s of roadSamples) {
      const k = g.cell(s.x, s.z);
      if (k >= 0 && !reach[k]) (reach[k] = 1), stack.push(k);
    }
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % nx;
      const j = (k - i) / nx;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if ((!di && !dj) || ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const kk = jj * nx + ii;
          if (reach[kk] || !g.walkable(kk)) continue;
          // a step between neighbours steeper than the walk limit is a cliff even where both cells read flat
          const rise = Math.abs(g.h[kk]! - g.h[k]!) / (step * Math.hypot(di, dj));
          if (rise > Math.tan((WALK_SLOPE * Math.PI) / 180)) continue;
          reach[kk] = 1;
          stack.push(kk);
        }
    }
  }
  /** A site is reached when a joined cell lies within 16 m (a perch on a cliff edge reads steep itself). */
  const reachedAt = (x: number, z: number): boolean => {
    const r = Math.ceil(16 / step);
    const i0 = Math.round((x - g.x0) / step);
    const j0 = Math.round((z - g.z0) / step);
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const ii = i0 + di;
        const jj = j0 + dj;
        if (ii >= 0 && jj >= 0 && ii < nx && jj < nz && reach[jj * nx + ii]) return true;
      }
    return false;
  };

  const near = (x: number, z: number): typeof roadSamples => roadSamples.filter((s) => Math.abs(s.x - x) <= SIGHT_RANGE && Math.abs(s.z - z) <= SIGHT_RANGE && Math.hypot(s.x - x, s.z - z) <= SIGHT_RANGE);
  const candidates: Candidate[] = kept.map((c) => {
    const y = g.ground(c.x, c.z);
    const nearRoad = roadNear(c.x, c.z, 5000);
    let seen = 0;
    let first: Approach["firstSeen"] = null;
    let fx = 0;
    let fz = 0;
    for (const s of near(c.x, c.z)) {
      if (!g.sees(s.x, s.z, s.y + 1.7, c.x, c.z, y + 8)) continue;
      seen += 16;
      const d = Math.hypot(s.x - c.x, s.z - c.z);
      const w = 1 / Math.max(30, d);
      fx += (s.x - c.x) * w;
      fz += (s.z - c.z) * w;
      if (!first || d > first.distance) first = { at: [Math.round(s.x), Math.round(s.z)], distance: Math.round(d), road: s.road };
    }
    if (!seen && nearRoad) (fx = nearRoad.x - c.x), (fz = nearRoad.z - c.z);
    const faces = fx || fz ? bearing(fx, fz) : c.detail.mouthBearing ?? 0;
    const approach: Approach = {
      road: nearRoad?.road ?? null,
      distance: nearRoad ? Math.round(nearRoad.d) : -1,
      from: nearRoad ? [Math.round(nearRoad.x), Math.round(nearRoad.z)] : null,
      climb: nearRoad ? Math.round(y - g.ground(nearRoad.x, nearRoad.z)) : 0,
      seenM: seen,
      firstSeen: first,
      faces: Math.round(faces),
      facesWord: compass(faces),
      note: [
        !nearRoad || nearRoad.d > 250 ? "no road or path within 250 m: it needs its own trail" : "",
        seen === 0 ? "seen from no road: a hidden find, or raise a landmark the road can see" : "",
      ].filter(Boolean).join("; "),
    };
    const used = c.kind === "empty-land" ? null : (() => {
      // a wall gap by a town is that town's wall site, not a site the town already uses
      for (const ct of input.content) if (!(c.kind === "wall-gap" && ct.kind === "town") && Math.hypot(ct.x - c.x, ct.z - c.z) <= ct.radius + 20) return ct.id;
      return null;
    })();
    // scoring the approach: a site seen from the road and reached from it beats one nobody passes
    const reach = !nearRoad ? -1.5 : nearRoad.d <= 250 ? 0.8 : nearRoad.d <= 600 ? 0 : -1;
    const sight = seen >= 300 ? 1.2 : seen >= 100 ? 0.6 : 0;
    const k = g.cell(c.x, c.z);
    return {
      id: "",
      kind: c.kind,
      at: [Math.round(c.x), Math.round(c.z)] as Vec2,
      y: Math.round(y * 10) / 10,
      score: c.kind === "empty-land" || c.kind === "path-end" ? +Math.min(10, c.score).toFixed(1) : +Math.min(10, c.score + reach + sight).toFixed(1),
      why: c.why,
      detail: c.detail,
      approach,
      usedBy: used,
      inZone: k >= 0 && !!g.zone[k],
      reachable: roadSamples.length === 0 || reachedAt(c.x, c.z),
    };
  });

  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((c, n) => (c.id = `s${String(n + 1).padStart(2, "0")}`));

  // ---- access devices: a strong site no walking body reaches from a road gets a lift, stair, rope way or ferry
  //      proposed as its own candidate, standing at the nearest joined ground (the device's foot)
  for (const c of [...candidates]) {
    if (c.reachable || NO_ACCESS.has(c.kind) || c.score < ACCESS_SCORE || !c.inZone) continue;
    const r = Math.ceil(ACCESS_REACH / step);
    const i0 = Math.round((c.at[0] - g.x0) / step);
    const j0 = Math.round((c.at[1] - g.z0) / step);
    let foot = -1;
    let fd = Infinity;
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const ii = i0 + di;
        const jj = j0 + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz || !reach[jj * nx + ii]) continue;
        const d = Math.hypot(di, dj) * step;
        if (d < fd) (fd = d), (foot = jj * nx + ii);
      }
    if (foot < 0) {
      c.approach.note = [c.approach.note, `no road-joined walkable ground within ${ACCESS_REACH} m: it needs its own trail before any access device`].filter(Boolean).join("; ");
      continue;
    }
    const fx = g.xOf(foot % nx);
    const fz = g.zOf(Math.floor(foot / nx));
    const fy = g.h[foot]!;
    const rise = c.y - fy;
    // what lies between the foot and the site: water (an island, a sea stack) or a wall/gap
    let wetRun = 0;
    const n = Math.max(2, Math.ceil(fd / step));
    for (let s = 1; s < n; s++) {
      const kk = g.cell(fx + ((c.at[0] - fx) * s) / n, fz + ((c.at[1] - fz) * s) / n);
      if (kk >= 0 && g.wet(kk)) wetRun++;
    }
    const device: AccessDevice =
      wetRun * step >= Math.max(12, 0.4 * fd) ? "bridge-or-ferry"
      : Math.abs(rise) <= 6 ? "ladder"
      : fd > 3 * Math.max(10, Math.abs(rise)) || Math.abs(rise) > 80 ? "rope-way"
      : Math.abs(rise) <= 30 ? "cliff-stair"
      : "lift";
    const why = `${c.id} ${c.kind} has no walkable way from a road: a ${device} from [${Math.round(fx)}, ${Math.round(fz)}] (${Math.round(fd)} m, ${rise >= 0 ? "up" : "down"} ${Math.abs(Math.round(rise))} m)`;
    c.approach.note = [c.approach.note, `no walkable way up: needs an access device (${device}, see the access candidate)`].filter(Boolean).join("; ");
    candidates.push({
      id: `a${String(candidates.filter((x) => x.kind === "access").length + 1).padStart(2, "0")}`,
      kind: "access",
      at: [Math.round(fx), Math.round(fz)],
      y: Math.round(fy * 10) / 10,
      score: +Math.max(0, c.score - 1).toFixed(1),
      why,
      detail: { for: c.id, forKind: c.kind, device, rise: Math.round(rise), span: Math.round(fd), to: c.at, water: wetRun * step >= 12 },
      approach: { ...c.approach, note: "" },
      usedBy: c.usedBy,
      inZone: true,
      reachable: true,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  // ---- density
  let land = 0;
  for (let k = 0; k < nx * nz; k++) if (g.zone[k] && !g.wet(k)) land++;
  const landKm2 = (land * step * step) / 1e6;
  // places of this zone: its towns and its reservations of 20 m or more (a door or a stone inside a place is not one)
  const places = input.content.filter((c) => (c.kind === "town" ? pointInPolygon(c.x, c.z, input.polygon) : c.zone === input.zone && c.radius >= 10)).length;
  return {
    step,
    box,
    landKm2: +landKm2.toFixed(2),
    places,
    perKm2: +(places / Math.max(0.01, landKm2)).toFixed(2),
    largestEmpty: empties[0] ?? null,
    empties,
    candidates,
    paths,
    landforms,
    hostileOnRoad: hostileOnMainRoads(input.content, input.roads),
  };
}

function segDist(x: number, z: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l = dx * dx + dz * dz;
  const t = l ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l)) : 0;
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}
