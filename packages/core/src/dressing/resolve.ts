import { cultureFits, dressingOrigin, isLooseClutter, mergeVocabulary, scaleFits, type DressingData, type DressingSocket, type DressingVocabulary } from "../components/dressing.js";
import { GROUND_STEP, GROUND_ZERO, HEAD_STEP, type DressingObstacle, type DressingPlace, type DressingPlan, type DressingSet, type SocketLevel, type SocketMap, type SocketWall } from "./schema.js";

/**
 * resolveDressing — a plan + a socket map + the props' own declarations ->
 * transforms and findings. Pure and headless: no scene, no DOM, no file I/O.
 *
 * CONTRACT (the types below are fixed; the body is implemented separately).
 */

export interface DressingPlacement {
  /** The plan item id; set members are `<item>/<member>`, generated chain links `<item>/chain-<n>`. */
  id: string;
  /** Prefab id to instantiate. */
  prop: string;
  level: number;
  /** Room id the item landed in ("" outdoors / on an outdoor anchor). */
  room: string;
  /** Map-local metres: where the prefab ORIGIN goes. */
  position: [number, number, number];
  /** Radians about +Y (the prop's front, local +Z, rotated to face this way). */
  yaw: number;
  /** Only when a generated link is stretched; otherwise omitted. */
  scale?: [number, number, number];
}

export interface DressingFinding {
  /** Item id, or a room id / "" for plan-level findings. */
  item: string;
  /** Stable machine code, e.g. "mount-mismatch", "not-free", "stair-buffer", "no-socket", "room-empty", "blocks-route". */
  code: string;
  message: string;
}

export interface DressingResolveOptions {
  /** Metres from a stair, well or doorway inside which a solid floor item is refused. Default 0.6. */
  hardBuffer?: number;
  /** Metres inside which it is only warned. Default 1.1. */
  warnBuffer?: number;
  /**
   * Narrowest lane that must remain from the entry to every room, stair, stair approach/head and doorway, and to the
   * front of every piece of furniture a person uses. Measured edge to edge against each prop's real footprint. Default
   * `DEFAULT_LANE_WIDTH` (0.9 m: the player capsule's 0.8 m diameter plus 0.05 m comfort each side); `dress` passes
   * the width derived from the project's own player collider.
   */
  laneWidth?: number;
  /** Largest share of a room's free floor solid floor props may cover. Default 0.3 (0.5 for a storage/cellar room). */
  maxCover?: number;
  /** Most loose containers (sacks, crates, barrels, boxes) standing on a room's floor; default `defaultRoomBudget`. */
  looseBudget?: (areaM2: number, role: string) => number;
  /** Flames allowed per level (rooms with maxHead >= 5 m raise it to `flamesLargeHall`). Default 4 / 6. */
  flames?: number;
  flamesLargeHall?: number;
  /** Fewest items for a room of a given area (a set counts as its members); default `defaultMinItems`: 1 per 15 m², at least 2, at most 6. */
  minItems?: (areaM2: number) => number;
  /** Metres a SOLID floor prop keeps off walking-path ('x') and stair-approach ('A') cells. Default 0, or DUNGEON_PATH_MARGIN in a dungeon. */
  pathMargin?: number;
}

/** A decal already in the space (decals go on BEFORE props): no prop may stand in its projection box. Map-local metres. */
export interface DressingDecal {
  id: string;
  /** Centre of the projection box. */
  position: [number, number, number];
  /** Projection direction (world/map frame): [0,-1,0] for a floor decal, horizontal into a wall for a wall decal. */
  direction: [number, number, number];
  /** [width, height] across the projection axis, metres. */
  size: [number, number];
  /** Box depth along the projection axis, metres. */
  depth: number;
  /** Spin about the projection axis, degrees. */
  rotation?: number;
  /** Texture or a label, for the message. */
  label?: string;
}

/** Per-room dressing review: is the room furnished from its walls in, with its middle clear and only its own kind of props? */
export interface DressingRoomReview {
  room: string;
  level: number;
  role: string;
  area: number;
  /** Items standing, hanging or mounted in the room (surface/slot items ride with their host and are not counted). */
  items: number;
  /** Solid floor items + wall-hung items. */
  furniture: number;
  /** Share of `furniture` with its back to a wall or hung on one: 1 = everything fills the walls. */
  wallShare: number;
  /** Area of the room's keep-clear centre zone, m² (0 = too small to have one). */
  centreM2: number;
  /** Solid items (not centrepieces / set pieces) whose footprint reaches the centre zone. */
  centreItems: string[];
  /** Share of the centre zone covered by those items. */
  centreCover: number;
  /** 0..100: centre items as a share of solid floor items, plus centre cover. 0 = middle clear. */
  centreClutter: number;
  scaleViolations: number;
  cultureViolations: number;
  /** Did this room have the centre rule on (dungeon, or `keepCentre`)? */
  keepCentre: boolean;
}

export interface DressingResolveInput {
  plan: DressingPlan;
  map: SocketMap;
  /** A prop's parsed `dressing` component, or undefined if the prefab does not exist / does not declare one. */
  prop: (prefabId: string) => DressingData | undefined;
  set: (setId: string) => DressingSet | undefined;
  options?: DressingResolveOptions;
  /** Decals already placed in this space, map-local. */
  decals?: DressingDecal[];
  /** Placed geometry not in the map (added to the plan's own `obstacles`), e.g. statues read from the scene. */
  obstacles?: DressingObstacle[];
  /** Scale classes and cultures (default DRESSING_VOCABULARY; tools merge the project's vocabulary.json). */
  vocabulary?: DressingVocabulary;
}

/** The spot the resolver chose for an `auto` place, in plan syntax (paste it over the auto place to freeze it). */
export interface DressingAutoChoice {
  /** The plan item id. */
  item: string;
  place: DressingPlace;
  /** True when a set was mirrored (its left and right swapped). */
  mirror: boolean;
  note: string;
}

export interface DressingResolveResult {
  placements: DressingPlacement[];
  /** One entry per `auto` item that found a spot, in plan order. */
  auto?: DressingAutoChoice[];
  /** Any violation means the plan must not be installed. */
  violations: DressingFinding[];
  warnings: DressingFinding[];
  /** One row per room of the map: centre clutter, wall share, scale/culture findings (`dress review`). */
  review?: DressingRoomReview[];
}


// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const EPS = 1e-6;
/** Metres of air a floor prop needs above its top. */
const HEAD_MARGIN = 0.05;
/** A hanging prop whose bottom is lower than this over walkable floor is warned. */
const WALK_HEAD = 2.0;
/** Cells a person can walk on (wells are holes). */
const WALKABLE = new Set([".", "o", "D", "E", "S", "H", "A", "x"]);
const HAZARD_NAME: Record<string, string> = { S: "stair", W: "stair well", D: "doorway", E: "entry lane" };
const CELL_NAME: Record<string, string> = { " ": "outside the space", "#": "wall", S: "stair", W: "stair well", D: "doorway", E: "entry lane", H: "hearth clearance", A: "stair approach", x: "walking path" };
/** Floor a person may stand on and a non-solid prop (a rug) may cover: free, unroofed, the hearth clearance, the way onto a stair and a reserved path. */
const FLOORISH = new Set([".", "o", "H", "A", "x"]);
/** Default lane: the player capsule (0.8 m diameter, characters/player) plus 0.05 m comfort on each side. */
export const DEFAULT_LANE_WIDTH = 0.9;
/** Anchor kinds that mark the way on and off a stair: nothing is ever placed on them. */
const STAIR_MARKS = new Set(["stair-foot", "stair-head", "stair-approach"]);
/** Furniture a person walks up to and uses: a chair, a table edge, a bed side, a counter. */
const USED_CATEGORIES = new Set(["furniture", "bedding"]);
/** How close (m) the edge of the body must get to a piece of furniture to use it. */
const USE_REACH = 0.3;

type V2 = [number, number];
type V3 = [number, number, number];
const f2 = (v: number): string => (Math.abs(v) < 0.005 ? "0.00" : v.toFixed(2));
const at2 = (x: number, z: number): string => `(${f2(x)}, ${f2(z)})`;

/** An oriented floor rectangle: centre, half extents along its local X/Z, yaw in radians. */
interface Rect {
  cx: number;
  cz: number;
  hw: number;
  hd: number;
  yaw: number;
}

/** The placed bounds of an item: footprint centre, bottom height, yaw (radians), size. */
interface Box {
  cx: number;
  cz: number;
  y0: number;
  yaw: number;
  w: number;
  h: number;
  d: number;
}

/** The yaw (radians) whose front (+Z) points along `dir`. */
const yawOf = (dir: V2): number => Math.atan2(dir[0], dir[1]);
const fwd = (yaw: number): V2 => [Math.sin(yaw), Math.cos(yaw)];
/** Rotate a prop-local XZ offset by yaw into the map frame (three.js rotation about +Y). */
const rot = (yaw: number, lx: number, lz: number): V2 => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [lx * c + lz * s, -lx * s + lz * c];
};
const toLocal = (r: Rect, x: number, z: number): V2 => {
  const dx = x - r.cx, dz = z - r.cz, c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  return [dx * c - dz * s, dx * s + dz * c];
};

function originOf(box: Box, origin: "foot" | "back" | "top"): V3 {
  if (origin === "top") return [box.cx, box.y0 + box.h, box.cz];
  if (origin === "back") {
    const f = fwd(box.yaw);
    return [box.cx - (f[0] * box.d) / 2, box.y0 + box.h / 2, box.cz - (f[1] * box.d) / 2];
  }
  return [box.cx, box.y0, box.cz];
}
function boxFromOrigin(o: V3, yaw: number, size: V3, origin: "foot" | "back" | "top"): Box {
  const [w, h, d] = size;
  if (origin === "top") return { cx: o[0], cz: o[2], y0: o[1] - h, yaw, w, h, d };
  if (origin === "back") {
    const f = fwd(yaw);
    return { cx: o[0] + (f[0] * d) / 2, cz: o[2] + (f[1] * d) / 2, y0: o[1] - h / 2, yaw, w, h, d };
  }
  return { cx: o[0], cz: o[2], y0: o[1], yaw, w, h, d };
}
const rectOf = (b: Box): Rect => ({ cx: b.cx, cz: b.cz, hw: b.w / 2, hd: b.d / 2, yaw: b.yaw });

function corners(r: Rect): V2[] {
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sz]) => {
    const [x, z] = rot(r.yaw, sx * r.hw, sz * r.hd);
    return [r.cx + x, r.cz + z] as V2;
  });
}

/** Penetration depth of two oriented rectangles (SAT); <= 0 when they do not overlap. */
function overlapDepth(a: Rect, b: Rect): number {
  const axes: V2[] = [];
  for (const r of [a, b]) axes.push([Math.cos(r.yaw), -Math.sin(r.yaw)], [Math.sin(r.yaw), Math.cos(r.yaw)]);
  const ca = corners(a), cb = corners(b);
  let depth = Infinity;
  for (const [ax, az] of axes) {
    const pa = ca.map(([x, z]) => x * ax + z * az), pb = cb.map(([x, z]) => x * ax + z * az);
    depth = Math.min(depth, Math.min(Math.max(...pa) - Math.min(...pb), Math.max(...pb) - Math.min(...pa)));
  }
  return depth;
}

// ---- level rasters --------------------------------------------------------

class Grid {
  constructor(readonly lv: SocketLevel) {}
  /** Floor height at a point: `floorY`, plus the level's `ground` raster when it has one (an outdoor site on uneven ground). */
  y(x: number, z: number): number {
    const gr = this.lv.ground;
    if (!gr) return this.lv.floorY;
    const [c, r] = this.cellOf(x, z), ch = this.inside(c, r) ? gr[r]![c]! : ".";
    return ch === "." ? this.lv.floorY : this.lv.floorY + (parseInt(ch, 36) - GROUND_ZERO) * GROUND_STEP;
  }
  get step(): number {
    return this.lv.step;
  }
  inside(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.lv.columns && r < this.lv.rows;
  }
  cellOf(x: number, z: number): V2 {
    return [Math.floor((x - this.lv.origin[0]) / this.lv.step), Math.floor((z - this.lv.origin[1]) / this.lv.step)];
  }
  centre(c: number, r: number): V2 {
    return [this.lv.origin[0] + (c + 0.5) * this.lv.step, this.lv.origin[1] + (r + 0.5) * this.lv.step];
  }
  ch(c: number, r: number): string {
    return this.inside(c, r) ? (this.lv.cells[r]?.[c] ?? " ") : " ";
  }
  /** Clear height in metres, NaN where there is no floor. */
  head(c: number, r: number): number {
    const ch = this.inside(c, r) ? this.lv.head[r]?.[c] : undefined;
    if (ch === undefined || ch === ".") return NaN;
    const v = parseInt(ch, 36);
    return Number.isFinite(v) ? v * HEAD_STEP : NaN;
  }
  roomAt(c: number, r: number): string {
    const ch = this.inside(c, r) ? this.lv.room[r]?.[c] : undefined;
    if (ch === undefined || ch === ".") return "";
    const idx = parseInt(ch, 36);
    return this.lv.rooms.find((room) => room.index === idx)?.id ?? "";
  }
  /** Cells whose centre lies inside the rectangle; the cell under its centre when none does. */
  cells(r: Rect): V2[] {
    const cs = corners(r);
    const [c0, r0] = this.cellOf(Math.min(...cs.map((p) => p[0])), Math.min(...cs.map((p) => p[1])));
    const [c1, r1] = this.cellOf(Math.max(...cs.map((p) => p[0])), Math.max(...cs.map((p) => p[1])));
    const out: V2[] = [];
    for (let rr = r0; rr <= r1; rr++)
      for (let cc = c0; cc <= c1; cc++) {
        const [x, z] = this.centre(cc, rr), [lx, lz] = toLocal(r, x, z);
        if (Math.abs(lx) < r.hw - 0.01 && Math.abs(lz) < r.hd - 0.01) out.push([cc, rr]);
      }
    if (out.length === 0) out.push(this.cellOf(r.cx, r.cz));
    return out;
  }
  /** Edge-to-edge distance from a rectangle to a cell square. */
  distToCell(r: Rect, c: number, rr: number): number {
    const [x, z] = this.centre(c, rr), [lx, lz] = toLocal(r, x, z);
    const ext = (this.lv.step / 2) * (Math.abs(Math.cos(r.yaw)) + Math.abs(Math.sin(r.yaw)));
    return Math.hypot(Math.max(Math.abs(lx) - r.hw - ext, 0), Math.max(Math.abs(lz) - r.hd - ext, 0));
  }
  majorityRoom(cells: V2[]): string {
    const n = new Map<string, number>();
    for (const [c, r] of cells) {
      const id = this.roomAt(c, r);
      if (id) n.set(id, (n.get(id) ?? 0) + 1);
    }
    let best = "", bn = 0;
    for (const [id, k] of n) if (k > bn) [best, bn] = [id, k];
    return best;
  }
}

// ---- work items -----------------------------------------------------------

/** Internal place for set members: relative to the set's anchor piece. */
interface RelPlace {
  kind: "rel";
  host: string;
  at: V2;
  yaw: number;
}
type OnPlace = Extract<DressingPlace, { kind: "on" }>;
type WorkPlace = DressingPlace | RelPlace;

interface Work {
  id: string;
  prop: string;
  place: WorkPlace;
  /** The plan item a set member came from ("" for a plain plan item). */
  group: string;
  /** A set item's `mirror` (anchor work only). */
  mirror?: boolean;
  /** The plan item is a declared set piece (may stand in a keep-clear centre). */
  setPiece?: boolean;
}

interface Res {
  work: Work;
  data: DressingData;
  level: number;
  room: string;
  outdoor: boolean;
  /** Placed on an outdoor anchor of a street/plaza map: the map's grid is a stub there, the anchor's measurer owns the ground. */
  outdoorAnchor?: boolean;
  box: Box;
  origin: V3;
  /** Solid floor footprint. */
  floor?: Rect;
  /** Footprint of a non-solid floor covering (blocks nothing). */
  cover?: Rect;
  /** Interval on a wall face: t range and height range above the floor. */
  onWall?: { wall: string; t0: number; t1: number; y0: number; y1: number };
  chain: DressingPlacement[];
}

interface Ctx {
  input: DressingResolveInput;
  opts: Required<Omit<DressingResolveOptions, "minItems" | "maxCover">> & { minItems: (a: number) => number; maxCover?: number };
  grids: Map<number, Grid>;
  walls: Map<string, { wall: SocketWall; level: number }>;
  violations: DressingFinding[];
  warnings: DressingFinding[];
  autos: DressingAutoChoice[];
  vocab: DressingVocabulary;
  dungeon: boolean;
  zones: Map<number, Zones>;
  obst: Obst[];
}

/** Default fewest items for a room: a believable floor without padding (a 90 m² hall needs 6, a 9 m² closet 2). Fewer, better things. */
/** A pocket under 4 m² (an alcove a pillar or a noised wall cuts off a room) holds one piece; real rooms at least 2. */
export const defaultMinItems = (areaM2: number): number => (areaM2 < 4 ? 1 : Math.min(6, Math.max(2, Math.floor(areaM2 / 15))));
const STORE_ROLES = new Set(["storage", "cellar"]);
/** Default loose-container budget: 1 per 25 m², 1..3; a storage room or cellar 1 per 4 m², at least 4. */
export const defaultLooseBudget = (areaM2: number, role: string): number =>
  STORE_ROLES.has(role) ? Math.max(4, Math.floor(areaM2 / 4)) : Math.min(3, Math.max(1, Math.floor(areaM2 / 25)));
/** Default largest share of a room's PLACEABLE floor (free floor less paths and keep-clear zones) solid props may cover. A lived-in room is mostly open floor. */
export const defaultMaxCover = (role: string): number => (STORE_ROLES.has(role) ? 0.5 : 0.3);
/**
 * The density limits a room of this area and role is held to (what `dress manifest` shows before anything is placed). The cover
 * ceiling is a share of `placeableM2` (the floor solid props may stand on at all); omitted = the whole free floor.
 */
export function roomBudget(areaM2: number, role = "", placeableM2?: number): { minItems: number; maxCover: number; maxCoverM2: number; loose: number } {
  const maxCover = defaultMaxCover(role);
  return { minItems: defaultMinItems(areaM2), maxCover, maxCoverM2: +((placeableM2 ?? areaM2) * maxCover).toFixed(1), loose: defaultLooseBudget(areaM2, role) };
}
const vio = (ctx: Ctx, item: string, code: string, message: string): void => void ctx.violations.push({ item, code, message });
const warn = (ctx: Ctx, item: string, code: string, message: string): void => void ctx.warnings.push({ item, code, message });

// ---- place rules: scale, culture, keep-clear centre, obstacles and decals ----

/** Metres solid props keep off paths and stair approaches in a dungeon (wider than a house: a fight moves through it). */
export const DUNGEON_PATH_MARGIN = 0.4;
/** The keep-clear centre: cells farther from the room's edge than max(CENTRE_MIN_BAND, CENTRE_SHARE x the room's inradius). */
export const CENTRE_MIN_BAND = 1.5;
export const CENTRE_SHARE = 0.5;
/** A centre narrower than this (metres across) is no centre: a corridor-like room keeps its paths, not a middle. */
const CENTRE_MIN_WIDTH = 1.5;
/** A floor prop whose footprint comes within this of the room edge counts as filling the wall (review wall share). */
export const EDGE_REACH = 1.0;

interface Zones {
  /** Metres from each room cell to its room's edge (Infinity outside rooms). */
  dist: Float32Array;
  /** room index + 1 on keep-clear centre cells, 0 elsewhere. */
  centre: Uint8Array;
  /** Centre-zone cell count per room id. */
  cells: Map<string, number>;
}
interface Obst {
  id: string;
  kind: "geometry" | "decal";
  label: string;
  level: number;
  rect: Rect;
  y0: number;
  y1: number;
}

/** Distance of every room cell to its room's edge (chamfer 1/sqrt2), and the keep-clear centre of each room. */
function zonesFor(g: Grid): Zones {
  const { columns: C, rows: R, step } = g.lv;
  const rm = (c: number, r: number): string => (c < 0 || r < 0 || c >= C || r >= R ? "." : (g.lv.room[r]?.[c] ?? "."));
  const dist = new Float32Array(C * R).fill(Infinity);
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const me = rm(c, r);
      if (me === ".") continue;
      const edge = rm(c - 1, r) !== me || rm(c + 1, r) !== me || rm(c, r - 1) !== me || rm(c, r + 1) !== me;
      if (edge) dist[r * C + c] = step / 2;
    }
  const D2 = step * Math.SQRT2;
  const relax = (c: number, r: number, nc: number, nr: number, w: number): void => {
    if (nc < 0 || nr < 0 || nc >= C || nr >= R || rm(nc, nr) !== rm(c, r)) return;
    const v = dist[nr * C + nc]! + w;
    if (v < dist[r * C + c]!) dist[r * C + c] = v;
  };
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      if (rm(c, r) === ".") continue;
      relax(c, r, c - 1, r, step); relax(c, r, c, r - 1, step); relax(c, r, c - 1, r - 1, D2); relax(c, r, c + 1, r - 1, D2);
    }
  for (let r = R - 1; r >= 0; r--)
    for (let c = C - 1; c >= 0; c--) {
      if (rm(c, r) === ".") continue;
      relax(c, r, c + 1, r, step); relax(c, r, c, r + 1, step); relax(c, r, c + 1, r + 1, D2); relax(c, r, c - 1, r + 1, D2);
    }
  const maxD = new Map<string, number>();
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const me = rm(c, r);
      if (me !== ".") maxD.set(me, Math.max(maxD.get(me) ?? 0, dist[r * C + c]!));
    }
  const centre = new Uint8Array(C * R), cells = new Map<string, number>();
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const me = rm(c, r);
      if (me === ".") continue;
      const m = maxD.get(me)!, band = Math.max(CENTRE_MIN_BAND, CENTRE_SHARE * m);
      if (m - band < CENTRE_MIN_WIDTH / 2 || dist[r * C + c]! <= band) continue;
      const idx = parseInt(me, 36);
      centre[r * C + c] = idx + 1;
      const id = g.lv.rooms.find((x) => x.index === idx)?.id ?? "";
      cells.set(id, (cells.get(id) ?? 0) + 1);
    }
  return { dist, centre, cells };
}

/** The scale, cultures and centre rule a room is held to: the room's own, else the plan's `space`. */
function roomRules(ctx: Ctx, room: string): { scale?: string; cultures: string[]; keepCentre: boolean } {
  const sp = ctx.input.plan.space, r = room ? ctx.input.plan.rooms[room] : undefined;
  const scale = r?.scale ?? sp?.scale;
  return { ...(scale ? { scale } : {}), cultures: r?.cultures ?? sp?.cultures ?? [], keepCentre: r?.keepCentre ?? ctx.dungeon };
}

const exemptCentre = (w: Work, d: DressingData): boolean => !!d.centrepiece || !!w.setPiece || !d.solid;

/** The first keep-clear centre cell a footprint covers, in a room that keeps its centre. */
function centreHit(ctx: Ctx, g: Grid, level: number, r: Rect): { room: string; at: V2 } | undefined {
  const z = ctx.zones.get(level);
  if (!z) return undefined;
  for (const [c, rr] of g.cells(r)) {
    if (!g.inside(c, rr)) continue;
    const v = z.centre[rr * g.lv.columns + c]!;
    if (!v) continue;
    const room = g.lv.rooms.find((x) => x.index === v - 1)?.id ?? "";
    if (roomRules(ctx, room).keepCentre) return { room, at: g.centre(c, rr) };
  }
  return undefined;
}

/** The first walking-path / stair-approach cell within `margin` of a solid footprint (the footprint's own cells excluded). */
function marginHit(g: Grid, r: Rect, margin: number): V2 | undefined {
  if (margin <= 0) return undefined;
  const own = new Set(g.cells(r).map(([c, rr]) => `${c},${rr}`));
  for (const [c, rr] of g.cells({ ...r, hw: r.hw + margin, hd: r.hd + margin })) {
    if (own.has(`${c},${rr}`)) continue;
    const ch = g.ch(c, rr);
    if (ch === "x" || ch === "A") return g.centre(c, rr);
  }
  return undefined;
}

function obstaclesOf(ctx: Ctx): Obst[] {
  const out: Obst[] = [];
  for (const o of [...(ctx.input.plan.obstacles ?? []), ...(ctx.input.obstacles ?? [])]) {
    const g = ctx.grids.get(o.level), y0 = g?.lv.floorY ?? 0;
    out.push({ id: o.id, kind: "geometry", label: o.note || o.id, level: o.level, rect: { cx: o.at[0], cz: o.at[1], hw: o.size[0] / 2, hd: o.size[1] / 2, yaw: o.yaw * DEG }, y0, y1: y0 + o.height });
  }
  for (const d of ctx.input.decals ?? []) {
    const [x, y, z] = d.position, [dx, dy, dz] = d.direction, rotd = (d.rotation ?? 0) * DEG;
    // the level whose floor is nearest below the decal
    let level = 0, best = -Infinity;
    for (const [l, g] of ctx.grids) if (g.lv.floorY <= y + 0.5 && g.lv.floorY > best) [level, best] = [l, g.lv.floorY];
    const [w, h] = d.size;
    if (Math.abs(dy) >= 0.7) {
      out.push({ id: d.id, kind: "decal", label: d.label ?? d.id, level, rect: { cx: x, cz: z, hw: w / 2, hd: h / 2, yaw: rotd }, y0: y - d.depth / 2, y1: y + d.depth / 2 });
    } else {
      const len = Math.hypot(dx, dz) || 1, c = Math.abs(Math.cos(rotd)), s = Math.abs(Math.sin(rotd));
      const W = w * c + h * s, H = w * s + h * c;
      out.push({ id: d.id, kind: "decal", label: d.label ?? d.id, level, rect: { cx: x, cz: z, hw: W / 2, hd: d.depth / 2, yaw: yawOf([dx / len, dz / len]) }, y0: y - H / 2, y1: y + H / 2 });
    }
  }
  return out;
}

/** The obstacle (placed geometry or decal box) a placed box runs into, by at least `gap` metres of clearance. */
function obstacleHit(ctx: Ctx, level: number, box: Box, gap = 0): Obst | undefined {
  const r = rectOf(box), y0 = box.y0, y1 = box.y0 + box.h;
  return ctx.obst.find((o) => o.level === level && overlapDepth(r, o.rect) > (gap > 0 ? -gap : 0.01) && Math.min(y1, o.y1) - Math.max(y0, o.y0) > 0.01);
}

const placeName = (p: WorkPlace): string => (p.kind === "rel" ? "a set-relative floor place" : `a \`${p.kind}\` place`);

/** Can a prop of this mount be placed with this place kind? Returns the refusal when not. */
function mountRefusal(data: DressingData, place: WorkPlace, anchorMount: string | undefined, prop: string): string | undefined {
  const m = data.mount, k = place.kind;
  if (m === "part") return `${prop} is a \`part\` of another prefab and is never placed on its own; place the prefab it belongs to`;
  if (k === "auto" && (m === "floor" || m === "wall" || m === "ceiling")) return undefined;
  if (k === "anchor") {
    if (anchorMount === undefined || anchorMount === m) return undefined; // missing anchor is reported when placing
    return `${prop} mounts \`${m}\` but anchor "${place.anchor}" takes \`${anchorMount}\` props`;
  }
  const ok =
    (m === "floor" && (k === "floor" || k === "wall" || k === "rel")) ||
    (m === "wall" && k === "wall") ||
    (m === "ceiling" && k === "ceiling") ||
    ((m === "surface" || m === "slot") && k === "on");
  if (ok) return undefined;
  if (m === "surface")
    return `${prop} is a surface prop: it only goes \`on\` a surface or hang socket of another item (a table top, a shelf board), never ${placeName(place)}; the floor is never a fallback`;
  if (m === "slot") return `${prop} is a slot prop (slotKind "${data.slotKind}"): it only goes \`on\` a slot socket that accepts "${data.slotKind}", never ${placeName(place)}`;
  if (m === "floor") return `${prop} stands on the floor: place it with \`floor\` or \`wall\` (back to a wall), not ${placeName(place)}`;
  if (m === "wall") return `${prop} hangs on a wall: place it with { kind: "wall", wall, t, height }, not ${placeName(place)}`;
  return `${prop} hangs from the ceiling: place it with { kind: "ceiling", level, at }, not ${placeName(place)}`;
}

function settingCheck(ctx: Ctx, w: Work, data: DressingData, outdoor: boolean): void {
  if (data.setting === "indoor" && outdoor)
    vio(ctx, w.id, "setting", `${w.prop} is an indoor prop but this spot is outdoors/unroofed; use an outdoor or "both" prop, or move it under a roof`);
  if (data.setting === "outdoor" && !outdoor)
    vio(ctx, w.id, "setting", `${w.prop} is an outdoor prop but this spot is under a roof; move it outside (an unroofed 'o' cell or an outdoor anchor)`);
}

/** Valid centre ranges of a prop `width` wide along a wall's spans. */
function centreRanges(wall: SocketWall, width: number): V2[] {
  return wall.spans.filter(([t0, t1]) => t1 - t0 >= width - EPS).map(([t0, t1]) => [t0 + width / 2, t1 - width / 2] as V2);
}
const rangesText = (rs: V2[]): string => (rs.length ? rs.map(([a, b]) => (Math.abs(a - b) < 0.005 ? f2(a) : `${f2(a)}..${f2(b)}`)).join(", ") : "none");
const spansText = (wall: SocketWall): string => wall.spans.map(([a, b]) => `${f2(a)}..${f2(b)}`).join(", ") || "none";

function wallFrame(wall: SocketWall): { u: V2; len: number } {
  const dx = wall.b[0] - wall.a[0], dz = wall.b[1] - wall.a[1], len = Math.hypot(dx, dz);
  return { u: len > EPS ? [dx / len, dz / len] : [1, 0], len };
}

function spanCheck(ctx: Ctx, w: Work, wall: SocketWall, t: number, width: number): void {
  const t0 = t - width / 2, t1 = t + width / 2;
  if (wall.spans.some(([a, b]) => t0 >= a - EPS && t1 <= b + EPS)) return;
  const ranges = centreRanges(wall, width);
  let best: number | undefined;
  for (const [a, b] of ranges) {
    const c = Math.min(Math.max(t, a), b);
    if (best === undefined || Math.abs(c - t) < Math.abs(best - t)) best = c;
  }
  vio(
    ctx,
    w.id,
    "no-span",
    `${w.prop} (${f2(width)} m wide) at t ${f2(t)} on wall ${wall.id} does not fit one solid span (free spans ${spansText(wall)}); ` +
      `its centre may go at t ${rangesText(ranges)}` +
      (best !== undefined ? ` (nearest: t ${f2(best)})` : `: no span on this wall is wide enough, pick another wall`),
  );
}

/** The nearest wall placement for a wall-backed floor prop standing at (x, z). */
function suggestWall(ctx: Ctx, level: number, x: number, z: number, width: number): string {
  let best: { id: string; t: number; dist: number } | undefined;
  for (const [id, { wall, level: l }] of ctx.walls) {
    if (l !== level) continue;
    const { u, len } = wallFrame(wall);
    const tp = Math.min(Math.max((x - wall.a[0]) * u[0] + (z - wall.a[1]) * u[1], 0), len);
    for (const [a, b] of centreRanges(wall, width)) {
      const t = Math.min(Math.max(tp, a), b);
      const dist = Math.hypot(wall.a[0] + u[0] * t - x, wall.a[1] + u[1] * t - z);
      if (!best || dist < best.dist) best = { id, t, dist };
    }
  }
  return best ? `; nearest fit: { kind: "wall", wall: "${best.id}", t: ${f2(best.t)} }` : `; no wall span on level ${level} is ${f2(width)} m wide`;
}

/** Is a floor prop's back flush to a wall span? (set members, which cannot name a wall) */
function backOnWall(ctx: Ctx, level: number, box: Box): { wall: string; t0: number; t1: number } | undefined {
  const f = fwd(box.yaw), bx = box.cx - (f[0] * box.d) / 2, bz = box.cz - (f[1] * box.d) / 2;
  for (const [id, { wall, level: l }] of ctx.walls) {
    if (l !== level || wall.normal[0] * f[0] + wall.normal[1] * f[1] < 0.98) continue;
    const off = (bx - wall.a[0]) * wall.normal[0] + (bz - wall.a[1]) * wall.normal[1];
    if (Math.abs(off) > 0.08) continue;
    const { u } = wallFrame(wall), t = (bx - wall.a[0]) * u[0] + (bz - wall.a[1]) * u[1];
    const t0 = t - box.w / 2, t1 = t + box.w / 2;
    if (wall.spans.some(([a, b]) => t0 >= a - 0.02 && t1 <= b + 0.02)) return { wall: id, t0, t1 };
  }
  return undefined;
}

/** Fit a floor prop's footprint on the raster, reporting findings. */
/**
 * The wall line is the truth: its face may sit up to one cell inside the raster's `#` cells (0.25 m cells cannot
 * represent it). A `#` cell of THAT wall from which the first free cell lies within one step (+ epsilon) along the
 * normal counts as floor in front of the face; returns that free cell, or undefined when the cell stays a wall.
 */
function besideFace(g: Grid, wall: SocketWall, c: number, r: number): V2 | undefined {
  if (g.ch(c, r) !== "#") return undefined;
  const [x, z] = g.centre(c, r), { u, len } = wallFrame(wall);
  const t = (x - wall.a[0]) * u[0] + (z - wall.a[1]) * u[1];
  if (t < -g.step || t > len + g.step) return undefined;
  for (let k = 1; k <= 4; k++) {
    const d = (k / 4) * (g.step + 0.02);
    const cell = g.cellOf(x + wall.normal[0] * d, z + wall.normal[1] * d);
    const ch = g.ch(cell[0], cell[1]);
    if (FLOORISH.has(ch)) return cell;
  }
  return undefined;
}

/** The first free cell in front of a wall face at a point (wall cells may cover the face). */
function cellInFront(g: Grid, wall: SocketWall, x: number, z: number): V2 {
  for (let d = 0.05; d <= 2 * g.step + 0.1; d += g.step / 2) {
    const cell = g.cellOf(x + wall.normal[0] * d, z + wall.normal[1] * d), ch = g.ch(cell[0], cell[1]);
    if (FLOORISH.has(ch)) return cell;
  }
  return g.cellOf(x + wall.normal[0] * 0.2, z + wall.normal[1] * 0.2);
}

function fitFloor(ctx: Ctx, w: Work, data: DressingData, g: Grid, r: Rect, wall?: SocketWall): { room: string; outdoor: boolean } {
  const cells: V2[] = [];
  const bad = new Map<string, V2>();
  let minHead = Infinity, open = 0;
  let hearth: V2 | undefined; // first hearth-clearance cell a SOLID prop covers
  let stairWay: V2 | undefined; // first stair approach/foot/head cell a SOLID prop covers
  let onPath: V2 | undefined; // first reserved walking-path cell a SOLID prop covers
  for (const [c0, r0] of g.cells(r)) {
    // On a wall place, a wall cell just behind the free row reads as the free cell in front of it.
    const [c, rr] = (wall && besideFace(g, wall, c0, r0)) || [c0, r0];
    cells.push([c, rr]);
    const ch = g.ch(c, rr);
    if (ch === "o") open++;
    if (ch === "H") {
      if (data.solid && !hearth) hearth = g.centre(c, rr);
    } else if (ch === "A") {
      if (data.solid && !stairWay) stairWay = g.centre(c, rr);
    } else if (ch === "x") {
      if (data.solid && !onPath) onPath = g.centre(c, rr);
    } else if (ch !== "." && ch !== "o" && !bad.has(ch)) bad.set(ch, g.centre(c, rr));
    const h = g.head(c, rr);
    minHead = Math.min(minHead, Number.isFinite(h) ? h : 0);
  }
  if (bad.size) {
    const parts = [...bad].map(([ch, p]) => `${CELL_NAME[ch] ?? `'${ch}'`} at ${at2(p[0], p[1])}`);
    vio(ctx, w.id, "not-free", `${w.prop} at ${at2(r.cx, r.cz)} (footprint ${f2(r.hw * 2)} x ${f2(r.hd * 2)} m) covers ${parts.join(", ")}; move it onto free floor ('.')`);
  }
  if (hearth)
    vio(ctx, w.id, "hearth-clearance", `${w.prop} at ${at2(r.cx, r.cz)} stands on the floor kept clear in front of a hearth (cell at ${at2(hearth[0], hearth[1])}); move it off the 'H' cells (a rug or other non-solid prop may lie there)`);
  if (stairWay)
    vio(ctx, w.id, "stair-clearance", `${w.prop} at ${at2(r.cx, r.cz)} stands in the way onto a stair (stair approach/foot/head cell at ${at2(stairWay[0], stairWay[1])}): a player could not reach or leave the steps; move ${w.id} off the 'A' cells`);
  if (onPath)
    vio(ctx, w.id, "on-path",
      `${w.prop} at ${at2(r.cx, r.cz)} stands on ${pathName(g, onPath[0], onPath[1])} (path cell at ${at2(onPath[0], onPath[1])}): the walking paths ('x') are reserved, ` +
        `so solid props go only on the floor left beside them (a rug or other non-solid prop may lie on a path); ${w.group ? `it is a member of set item "${w.group}": move or turn the set so it lands clear; ` : ""}${suggestFree(g, r, wall)}`);
  if (data.solid && !exemptCentre(w, data)) {
    const hit = centreHit(ctx, g, g.lv.level, r);
    if (hit)
      vio(ctx, w.id, "centre-clutter",
        `${w.prop} at ${at2(r.cx, r.cz)} stands in the keep-clear MIDDLE of room ${hit.room} (centre cell at ${at2(hit.at[0], hit.at[1])}): walls and corners fill first; ` +
          `put it against a wall (prefer "wall" or "corner"), or mark the room's one set piece with \`setPiece: true\``);
  }
  if (data.solid && !onPath && !stairWay) {
    const m = marginHit(g, r, ctx.opts.pathMargin);
    if (m)
      vio(ctx, w.id, "path-margin",
        `${w.prop} at ${at2(r.cx, r.cz)} is within ${f2(ctx.opts.pathMargin)} m of a walking path or stair approach (cell at ${at2(m[0], m[1])}); keep that much clear beside the walk lines here`);
  }
  const need = data.size[1] + HEAD_MARGIN;
  if (minHead < need - EPS)
    vio(ctx, w.id, "headroom", `${w.prop} is ${f2(data.size[1])} m tall but the clear height over its footprint is ${f2(minHead)} m (needs ${f2(need)}); move it under a higher ceiling or pick a lower prop`);
  const outdoor = open * 2 > cells.length;
  settingCheck(ctx, w, data, outdoor);
  if (data.solid) {
    // Stair / well / doorway / entry buffers.
    const reach = ctx.opts.warnBuffer + Math.hypot(r.hw, r.hd) + g.step;
    const [c0, r0] = g.cellOf(r.cx - reach, r.cz - reach), [c1, r1] = g.cellOf(r.cx + reach, r.cz + reach);
    const nearest = new Map<string, { d: number; p: V2 }>();
    for (let rr = r0; rr <= r1; rr++)
      for (let c = c0; c <= c1; c++) {
        const ch = g.ch(c, rr);
        if (!HAZARD_NAME[ch] && ch !== "H") continue;
        const d = g.distToCell(r, c, rr), cur = nearest.get(ch);
        if (!cur || d < cur.d) nearest.set(ch, { d, p: g.centre(c, rr) });
      }
    for (const [ch, { d, p }] of nearest) {
      if (ch === "H") {
        // Inside is refused above; within the hard buffer of it is only warned (the clearance already IS the buffer).
        if (!hearth && d < ctx.opts.hardBuffer - EPS)
          warn(ctx, w.id, "hearth-clearance", `${w.prop} is ${f2(d)} m from the hearth clearance at ${at2(p[0], p[1])}; ${f2(ctx.opts.hardBuffer)} m keeps the hearth comfortable to use`);
        continue;
      }
      if (d >= ctx.opts.warnBuffer - EPS) continue;
      const code = ch === "S" || ch === "W" ? "stair-buffer" : "doorway-buffer";
      const dx = r.cx - p[0], dz = r.cz - p[1], len = Math.hypot(dx, dz) || 1, mv = ctx.opts.warnBuffer - d;
      const away = `e.g. centre it at ${at2(r.cx + (dx / len) * mv, r.cz + (dz / len) * mv)}`;
      if (d < ctx.opts.hardBuffer - EPS)
        vio(ctx, w.id, code, `${w.prop} is ${f2(d)} m from the ${HAZARD_NAME[ch]} at ${at2(p[0], p[1])}; keep >= ${f2(ctx.opts.hardBuffer)} m: move it at least ${f2(ctx.opts.hardBuffer - d)} m away (${f2(mv)} m also clears the warning, ${away})`);
      else warn(ctx, w.id, code, `${w.prop} is ${f2(d)} m from the ${HAZARD_NAME[ch]} at ${at2(p[0], p[1])}; ${f2(ctx.opts.warnBuffer)} m is comfortable: move it ${f2(mv)} m away (${away})`);
    }
  }
  return { room: g.majorityRoom(cells), outdoor };
}

/** The name of the reserved path whose centre line runs nearest (x, z): "the way from the door to the stair". */
function pathName(g: Grid, x: number, z: number): string {
  let best = "a reserved walking path", bd = Infinity;
  for (const p of g.lv.paths ?? []) {
    const pts = p.points.length > 1 ? p.points : [p.points[0]!, p.points[0]!];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1]!, [bx, bz] = pts[i]!, dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
      const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
      if (d < bd - EPS) [best, bd] = [p.name, d];
    }
  }
  return best;
}

/** Does a footprint stand only on free floor ('.' / unroofed 'o')? Wall cells just behind a wall place read as the floor in front. */
function fitsFree(g: Grid, r: Rect, wall?: SocketWall): boolean {
  for (const [c0, r0] of g.cells(r)) {
    const [c, rr] = (wall && besideFace(g, wall, c0, r0)) || [c0, r0];
    const ch = g.ch(c, rr);
    if (ch !== "." && ch !== "o") return false;
  }
  return true;
}

/** The nearest place the same footprint fits on free floor: along its wall for a wall place, else within 3 m on the floor. */
function suggestFree(g: Grid, r: Rect, wall?: SocketWall): string {
  if (wall) {
    const { u, len } = wallFrame(wall), t0 = (r.cx - wall.a[0]) * u[0] + (r.cz - wall.a[1]) * u[1];
    const ts: number[] = [];
    for (const [a, b] of centreRanges(wall, r.hw * 2)) for (let t = a; t <= b + EPS; t += g.step / 2) ts.push(Math.min(t, b));
    ts.sort((a, b) => Math.abs(a - t0) - Math.abs(b - t0) || a - b);
    for (const t of ts) {
      if (t < -EPS || t > len + EPS) continue;
      if (fitsFree(g, { ...r, cx: r.cx + u[0] * (t - t0), cz: r.cz + u[1] * (t - t0) }, wall)) return `nearest free place on this wall: { kind: "wall", wall: "${wall.id}", t: ${f2(t)} }`;
    }
    return `no stretch of wall ${wall.id} has free floor in front of it for this piece: pick another wall`;
  }
  const n = Math.ceil(3 / g.step), offs: V2[] = [];
  for (let dr = -n; dr <= n; dr++) for (let dc = -n; dc <= n; dc++) if (Math.hypot(dc, dr) <= n) offs.push([dc, dr]);
  offs.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || a[1] - b[1] || a[0] - b[0]);
  for (const [dc, dr] of offs) {
    const cand: Rect = { ...r, cx: r.cx + dc * g.step, cz: r.cz + dr * g.step };
    if (fitsFree(g, cand)) return `nearest free place: { kind: "floor", at: [${f2(cand.cx)}, ${f2(cand.cz)}] } (same yaw)`;
  }
  return "no free floor within 3 m takes this footprint: pick a smaller piece or another room (see `dress manifest` for each room's placeable floor)";
}

function gridFor(ctx: Ctx, w: Work, level: number): Grid | undefined {
  const g = ctx.grids.get(level);
  if (!g) vio(ctx, w.id, "no-level", `level ${level} does not exist in map "${ctx.input.map.id}" (levels: ${[...ctx.grids.keys()].join(", ")})`);
  return g;
}

function floorRes(w: Work, data: DressingData, level: number, box: Box, room: string, outdoor: boolean): Res {
  const rect = rectOf(box);
  return { work: w, data, level, room, outdoor, box, origin: originOf(box, dressingOrigin(data)), ...(data.solid ? { floor: rect } : { cover: rect }), chain: [] };
}

function resolveDirect(ctx: Ctx, w: Work, data: DressingData): Res | undefined {
  const p = w.place;
  const [W, H, D] = data.size;
  if (p.kind === "floor") {
    const g = gridFor(ctx, w, p.level);
    if (!g) return undefined;
    const box: Box = { cx: p.at[0], cz: p.at[1], y0: g.y(p.at[0], p.at[1]), yaw: p.yaw * DEG, w: W, h: H, d: D };
    if (data.against === "wall" && !backOnWall(ctx, p.level, box))
      vio(ctx, w.id, "needs-wall", `${w.prop} must stand with its back to a wall; ${at2(p.at[0], p.at[1])} is open floor. Place it with \`wall\`${suggestWall(ctx, p.level, p.at[0], p.at[1], W)}`);
    const { room, outdoor } = fitFloor(ctx, w, data, g, rectOf(box));
    return floorRes(w, data, p.level, box, room, outdoor);
  }
  if (p.kind === "wall") {
    const entry = ctx.walls.get(p.wall);
    if (!entry) {
      vio(ctx, w.id, "no-wall", `wall "${p.wall}" is not in map "${ctx.input.map.id}"; walls: ${[...ctx.walls.keys()].slice(0, 24).join(", ")}`);
      return undefined;
    }
    const { wall, level } = entry, g = ctx.grids.get(level)!;
    const { u, len } = wallFrame(wall);
    if (p.t > len + EPS) vio(ctx, w.id, "no-span", `t ${f2(p.t)} is past the end of wall ${wall.id} (${f2(len)} m long)`);
    spanCheck(ctx, w, wall, p.t, W);
    const yaw = yawOf(wall.normal);
    const px = wall.a[0] + u[0] * p.t, pz = wall.a[1] + u[1] * p.t;
    const cx = px + (wall.normal[0] * D) / 2, cz = pz + (wall.normal[1] * D) / 2;
    if (data.mount === "floor") {
      if (p.height !== undefined && p.height > 0) warn(ctx, w.id, "height-ignored", `${w.prop} stands on the floor; the wall place's \`height\` is ignored`);
      if (H > wall.height + EPS) warn(ctx, w.id, "too-tall", `${w.prop} (${f2(H)} m) is taller than wall ${wall.id}'s usable height ${f2(wall.height)} m`);
      const box: Box = { cx, cz, y0: g.y(cx, cz), yaw, w: W, h: H, d: D };
      const { room, outdoor } = fitFloor(ctx, w, data, g, rectOf(box), wall);
      const res = floorRes(w, data, level, box, room || wall.room, outdoor);
      res.onWall = { wall: wall.id, t0: p.t - W / 2, t1: p.t + W / 2, y0: 0, y1: H };
      return res;
    }
    // A wall-mounted prop.
    const [hMin, hMax] = data.wallHeight;
    const height = p.height ?? (hMin + hMax) / 2;
    if (height < hMin - EPS || height > hMax + EPS)
      vio(ctx, w.id, "wall-height", `${w.prop}'s bottom edge may hang ${f2(hMin)}..${f2(hMax)} m above the floor; the plan says ${f2(height)} m`);
    if (height + H > wall.height + EPS)
      vio(ctx, w.id, "wall-height", `${w.prop} hung at ${f2(height)} m reaches ${f2(height + H)} m but wall ${wall.id} is usable to ${f2(wall.height)} m; hang it at most at ${f2(Math.max(0, wall.height - H))} m${wall.height - H < hMin ? " (below its allowed range: use another wall)" : ""}`);
    const box: Box = { cx, cz, y0: g.lv.floorY + height, yaw, w: W, h: H, d: D };
    const [c, r] = cellInFront(g, wall, px, pz);
    const outdoor = g.ch(c, r) === "o";
    settingCheck(ctx, w, data, outdoor);
    return {
      work: w,
      data,
      level,
      room: wall.room,
      outdoor,
      box,
      origin: originOf(box, dressingOrigin(data)),
      onWall: { wall: wall.id, t0: p.t - W / 2, t1: p.t + W / 2, y0: height, y1: height + H },
      chain: [],
    };
  }
  if (p.kind === "ceiling") {
    const g = gridFor(ctx, w, p.level);
    if (!g) return undefined;
    const yaw = p.yaw * DEG, rect: Rect = { cx: p.at[0], cz: p.at[1], hw: W / 2, hd: D / 2, yaw };
    const [c, r] = g.cellOf(p.at[0], p.at[1]), ch = g.ch(c, r);
    if (ch === "o") vio(ctx, w.id, "no-ceiling", `${w.prop} hangs from a ceiling but ${at2(p.at[0], p.at[1])} is unroofed ('o')`);
    else if (ch === " " || ch === "#") vio(ctx, w.id, "not-free", `${w.prop} at ${at2(p.at[0], p.at[1])} is over ${ch === "#" ? "a wall" : "no floor of this space"}; hang it over a room`);
    let head = Infinity;
    for (const [cc, rr] of g.cells(rect)) {
      const h = g.head(cc, rr);
      if (Number.isFinite(h)) head = Math.min(head, h);
    }
    if (!Number.isFinite(head)) head = 0;
    const ceilY = g.lv.floorY + head;
    if (p.drop > 0 && !data.chain) vio(ctx, w.id, "no-chain", `${w.prop} has no \`chain\`, so it mounts flush under the ceiling: set drop 0, or use a chained variant`);
    const drop = data.chain ? p.drop : 0;
    const top = ceilY - drop, bottom = top - H, maxDrop = Math.max(0, head - H - WALK_HEAD);
    if (bottom < g.lv.floorY + 0.1)
      vio(ctx, w.id, "headroom", `${w.prop} (${f2(H)} m) hung ${f2(drop)} m below a ${f2(head)} m ceiling reaches the floor; the longest drop keeping ${f2(WALK_HEAD)} m beneath it is ${f2(maxDrop)} m`);
    else if (bottom < g.lv.floorY + WALK_HEAD - EPS && WALKABLE.has(ch))
      warn(ctx, w.id, "low-hang", `${w.prop}'s bottom is ${f2(bottom - g.lv.floorY)} m above the floor (heads hit under ${f2(WALK_HEAD)} m); drop it at most ${f2(maxDrop)} m, or hang it over furniture`);
    settingCheck(ctx, w, data, false);
    const box: Box = { cx: p.at[0], cz: p.at[1], y0: bottom, yaw, w: W, h: H, d: D };
    const res: Res = { work: w, data, level: p.level, room: g.roomAt(c, r), outdoor: false, box, origin: originOf(box, dressingOrigin(data)), chain: [] };
    if (data.chain && drop > EPS) {
      const link = ctx.input.prop(data.chain);
      if (!link) warn(ctx, w.id, "chain-undeclared", `chain link "${data.chain}" has no dressing declaration; links are placed assuming its origin is at its top`);
      const lo = link ? dressingOrigin(link) : "top";
      const n = Math.ceil(drop - 1e-6);
      for (let k = 0; k < n; k++) {
        const b0 = top + k, b1 = Math.min(top + k + 1, ceilY), len = b1 - b0;
        const y = lo === "foot" ? b0 : lo === "top" ? b1 : (b0 + b1) / 2;
        const pl: DressingPlacement = { id: `${w.id}/chain-${k}`, prop: data.chain, level: p.level, room: res.room, position: [p.at[0], +y.toFixed(4), p.at[1]], yaw: +yaw.toFixed(6) };
        if (len < 1 - 1e-6) pl.scale = [1, +len.toFixed(4), 1];
        res.chain.push(pl);
      }
    }
    return res;
  }
  if (p.kind === "anchor") {
    const a = ctx.input.map.anchors.find((x) => x.id === p.anchor);
    if (!a) {
      vio(ctx, w.id, "no-anchor", `anchor "${p.anchor}" is not in map "${ctx.input.map.id}"; anchors: ${ctx.input.map.anchors.map((x) => `${x.id} (${x.kind}, ${x.mount})`).join(", ") || "none"}`);
      return undefined;
    }
    if (STAIR_MARKS.has(a.kind)) {
      vio(ctx, w.id, "stair-clearance", `anchor "${a.id}" is a ${a.kind} mark: the way on or off a stair, kept clear; nothing is placed on it (move ${w.id} elsewhere)`);
      return undefined;
    }
    const yaw = a.yaw * DEG, box = boxFromOrigin(a.position, yaw, data.size, dressingOrigin(data));
    const g = ctx.grids.get(a.level);
    let room = "";
    // an outdoor anchor of a measured site (a level with a `ground` raster) stands on that grid: its room, its footprint
    const onGrid = !a.outdoor || !!g?.lv.ground;
    if (g && onGrid) {
      const [c, r] = g.cellOf(box.cx, box.cz);
      room = g.roomAt(c, r);
      // A fixture set into a wall (a hearth, a sconce) belongs to the room it faces: its room group, its culling.
      for (let d = g.step; !room && d <= 2 + EPS; d += g.step) {
        const [c2, r2] = g.cellOf(a.position[0] + Math.sin(yaw) * d, a.position[2] + Math.cos(yaw) * d);
        room = g.roomAt(c2, r2);
      }
    }
    settingCheck(ctx, w, data, a.outdoor);
    const res: Res = { work: w, data, level: a.level, room, outdoor: a.outdoor, ...(onGrid ? {} : { outdoorAnchor: true }), box, origin: [a.position[0], a.position[1], a.position[2]], chain: [] };
    if (data.mount === "floor" && onGrid) {
      if (data.solid) res.floor = rectOf(box);
      else res.cover = rectOf(box);
    }
    return res;
  }
  return undefined; // "on" / "rel" are resolved with their host
}

/** Set members placed relative to their resolved anchor piece. */
function resolveRel(ctx: Ctx, w: Work, data: DressingData, host: Res, place: RelPlace): Res | undefined {
  const g = gridFor(ctx, w, host.level);
  if (!g) return undefined;
  const [ox, oz] = rot(host.box.yaw, place.at[0], place.at[1]);
  const box: Box = { cx: host.box.cx + ox, cz: host.box.cz + oz, y0: g.y(host.box.cx + ox, host.box.cz + oz), yaw: host.box.yaw + place.yaw * DEG, w: data.size[0], h: data.size[1], d: data.size[2] };
  let onWall: Res["onWall"];
  if (data.against === "wall") {
    const flush = backOnWall(ctx, host.level, box);
    if (!flush) vio(ctx, w.id, "needs-wall", `${w.prop} (set member) must stand with its back to a wall but lands in open floor at ${at2(box.cx, box.cz)}; turn or move the set so its back meets a wall span${suggestWall(ctx, host.level, box.cx, box.cz, box.w)}`);
    else onWall = { wall: flush.wall, t0: flush.t0, t1: flush.t1, y0: 0, y1: box.h };
  }
  const { room, outdoor } = fitFloor(ctx, w, data, g, rectOf(box), onWall ? ctx.walls.get(onWall.wall)?.wall : undefined);
  const res = floorRes(w, data, host.level, box, room, outdoor);
  if (onWall) res.onWall = onWall;
  return res;
}

// ---- sockets --------------------------------------------------------------

interface SocketItem {
  w: Work;
  data: DressingData;
  relYaw: number;
  ex: number;
  ez: number;
  offset?: V2;
}

/** Why a socket cannot take this prop, or undefined when it can (ignoring capacity). */
function socketRefusal(sock: DressingSocket, data: DressingData, relYaw: number): string | undefined {
  if (data.mount === "slot") {
    if (sock.kind !== "slot") return `is a ${sock.kind}, not a slot`;
    if (!sock.accepts.includes(data.slotKind)) return `accepts ${sock.accepts.join("/")}, not "${data.slotKind}"`;
  } else {
    if (sock.kind === "slot") return `is a slot (for ${sock.accepts.join("/")} only)`;
    if (sock.accepts.length && !data.fits.some((t) => sock.accepts.includes(t)))
      return `accepts only ${sock.accepts.join("/")} (this prop fits ${data.fits.join("/") || "nothing in particular"})`;
  }
  if (data.size[1] > sock.clearHeight + EPS) return `has ${f2(sock.clearHeight)} m clear above it, the prop is ${f2(data.size[1])} m tall`;
  if (sock.kind === "surface") {
    const c = Math.abs(Math.cos(relYaw)), s = Math.abs(Math.sin(relYaw));
    const ex = data.size[0] * c + data.size[2] * s, ez = data.size[0] * s + data.size[2] * c;
    if (ex > sock.size[0] + EPS || ez > sock.size[1] + EPS) return `is ${f2(sock.size[0])} x ${f2(sock.size[1])} m, the prop needs ${f2(ex)} x ${f2(ez)} m`;
  }
  return undefined;
}

function resolveChildren(ctx: Ctx, host: Res, kids: Work[], out: Map<string, Res>): void {
  const sockets = host.data.provides;
  const uses = new Map<string, SocketItem[]>(sockets.map((s) => [s.id, []]));
  const used = (s: DressingSocket): number => uses.get(s.id)!.length;
  for (const w of kids) {
    const data = ctx.input.prop(w.prop)!;
    const p = w.place as OnPlace;
    if (sockets.length === 0) {
      vio(ctx, w.id, "no-socket", `${host.work.prop} ("${host.work.id}") provides no sockets; put ${w.prop} on something that does (a table, a shelf)`);
      continue;
    }
    const takers = (except?: DressingSocket): string[] =>
      sockets.filter((s) => s !== except && !socketRefusal(s, data, (s.yaw + p.yaw) * DEG) && used(s) < s.capacity).map((s) => `${s.id} (${s.capacity - used(s)} free)`);
    let chosen: DressingSocket | undefined;
    if (p.socket) {
      chosen = sockets.find((s) => s.id === p.socket);
      if (!chosen) {
        vio(ctx, w.id, "no-socket", `${host.work.prop} has no socket "${p.socket}"; it has ${sockets.map((s) => `${s.id} (${s.kind})`).join(", ")}`);
        continue;
      }
      const why = socketRefusal(chosen, data, (chosen.yaw + p.yaw) * DEG);
      if (why) {
        const alt = takers(chosen);
        vio(ctx, w.id, "socket-refused", `socket ${chosen.id} on ${host.work.prop} ${why}${alt.length ? `; sockets with room that take it: ${alt.join(", ")}` : ""}`);
        continue;
      }
      if (used(chosen) >= chosen.capacity) {
        const alt = takers(chosen);
        vio(ctx, w.id, "socket-full", `socket ${chosen.id} on "${host.work.id}" is full (capacity ${chosen.capacity}); ${alt.length ? `room on: ${alt.join(", ")}` : "no other socket on it takes this prop: use another host"}`);
        continue;
      }
    } else {
      const reasons: string[] = [];
      for (const s of sockets) {
        const why = socketRefusal(s, data, (s.yaw + p.yaw) * DEG) ?? (used(s) >= s.capacity ? `is full (${s.capacity})` : undefined);
        if (!why) {
          chosen = s;
          break;
        }
        reasons.push(`${s.id} ${why}`);
      }
      if (!chosen) {
        vio(ctx, w.id, "no-socket", `no socket on ${host.work.prop} ("${host.work.id}") takes ${w.prop}: ${reasons.join("; ")}`);
        continue;
      }
    }
    const relYaw = (chosen.yaw + p.yaw) * DEG, c = Math.abs(Math.cos(relYaw)), s = Math.abs(Math.sin(relYaw));
    uses.get(chosen.id)!.push({
      w,
      data,
      relYaw,
      ex: data.size[0] * c + data.size[2] * s,
      ez: data.size[0] * s + data.size[2] * c,
      ...(p.offset ? { offset: [p.offset[0], p.offset[1]] as V2 } : {}),
    });
  }

  for (const s of sockets) {
    const items = uses.get(s.id)!;
    if (s.kind === "surface") arrange(ctx, host, s, items);
    for (const it of items) {
      if (s.kind === "surface" && !it.offset) continue; // could not be arranged; reported
      if (s.kind !== "surface" && it.offset) warn(ctx, it.w.id, "offset-ignored", `socket ${s.id} is a ${s.kind}: the item lands exactly on its point, the offset is ignored`);
      const local: V3 = s.kind === "surface" ? [s.position[0] + it.offset![0], s.position[1], s.position[2] + it.offset![1]] : [s.position[0], s.position[1], s.position[2]];
      const [dx, dz] = rot(host.box.yaw, local[0], local[2]);
      const pt: V3 = [host.origin[0] + dx, host.origin[1] + local[1], host.origin[2] + dz];
      const yaw = host.box.yaw + it.relYaw, [W, H, D] = it.data.size;
      let box: Box, origin: V3;
      if (s.kind === "slot") {
        origin = pt; // the item's origin lands exactly on the point
        box = boxFromOrigin(pt, yaw, it.data.size, dressingOrigin(it.data));
      } else {
        // surface: bottom on the board; hang: top on the hook.
        box = { cx: pt[0], cz: pt[2], y0: s.kind === "hang" ? pt[1] - H : pt[1], yaw, w: W, h: H, d: D };
        origin = originOf(box, dressingOrigin(it.data));
      }
      settingCheck(ctx, it.w, it.data, host.outdoor);
      out.set(it.w.id, { work: it.w, data: it.data, level: host.level, room: host.room, outdoor: host.outdoor, box, origin, chain: [] });
    }
  }
}

/** Surface sockets: validate explicit offsets, lay the rest out left to right. */
function arrange(ctx: Ctx, host: Res, s: DressingSocket, items: SocketItem[]): void {
  const hx = s.size[0] / 2, hz = s.size[1] / 2;
  const fixed = items.filter((i) => i.offset);
  for (const it of fixed) {
    const [ox, oz] = it.offset!, mx = hx - it.ex / 2, mz = hz - it.ez / 2;
    if (Math.abs(ox) > mx + EPS || Math.abs(oz) > mz + EPS)
      vio(ctx, it.w.id, "off-surface", `${it.w.prop} at offset [${f2(ox)}, ${f2(oz)}] overhangs socket ${s.id} (${f2(s.size[0])} x ${f2(s.size[1])} m) on "${host.work.id}"; keep the offset within x ±${f2(Math.max(0, mx))}, z ±${f2(Math.max(0, mz))}`);
  }
  for (let i = 0; i < fixed.length; i++)
    for (let j = 0; j < i; j++) {
      const a = fixed[i]!, b = fixed[j]!;
      const px = (a.ex + b.ex) / 2 - Math.abs(a.offset![0] - b.offset![0]), pz = (a.ez + b.ez) / 2 - Math.abs(a.offset![1] - b.offset![1]);
      if (px > 0.005 && pz > 0.005) vio(ctx, a.w.id, "overlap", `${a.w.prop} overlaps ${b.w.id} on socket ${s.id}; shift its offset x by ${f2(px)} m or z by ${f2(pz)} m`);
    }
  const auto = items.filter((i) => !i.offset);
  if (!auto.length) return;
  const gap = 0.02;
  if (!fixed.length) {
    // Spread evenly across the whole surface.
    const sp = (2 * hx - auto.reduce((a, i) => a + i.ex, 0)) / (auto.length + 1);
    if (sp >= 0) {
      let x = -hx + sp;
      for (const it of auto) {
        it.offset = [x + it.ex / 2, 0];
        x += it.ex + sp;
      }
      return;
    }
  }
  // Free intervals along X once the explicitly offset items are taken out; fill left to right.
  let free: V2[] = [[-hx, hx]];
  for (const it of fixed) {
    const a = it.offset![0] - it.ex / 2 - gap, b = it.offset![0] + it.ex / 2 + gap;
    free = free.flatMap(([l, r]): V2[] => (b <= l || a >= r ? [[l, r]] : ([[l, a], [b, r]] as V2[]).filter(([x0, x1]) => x1 - x0 > EPS)));
  }
  for (const it of auto) {
    const k = free.findIndex(([l, r]) => r - l >= it.ex - EPS);
    if (k < 0) {
      const left = free.reduce((m, [l, r]) => Math.max(m, r - l), 0);
      vio(ctx, it.w.id, "surface-full", `socket ${s.id} on "${host.work.id}" has only ${f2(left)} m of free width left, ${it.w.prop} needs ${f2(it.ex)} m; use another socket or host`);
      continue;
    }
    const [l, r] = free[k]!;
    it.offset = [l + it.ex / 2, 0];
    free[k] = [l + it.ex + gap, r];
  }
}

// ---- plan-level checks ----------------------------------------------------

function laneOffsets(step: number, radius: number): V2[] {
  const out: V2[] = [], n = Math.ceil(radius / step);
  for (let dr = -n; dr <= n; dr++) for (let dc = -n; dc <= n; dc++) if (Math.hypot(dc, dr) * step <= radius + 1e-9) out.push([dc, dr]);
  return out;
}

/** 4-connected components of one cell character, as flat cell indices. */
function components(g: Grid, ch: string): number[][] {
  const { columns: C, rows: R } = g.lv, seen = new Uint8Array(C * R), out: number[][] = [];
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const k = r * C + c;
      if (seen[k] || g.ch(c, r) !== ch) continue;
      const comp: number[] = [], st = [k];
      seen[k] = 1;
      while (st.length) {
        const q = st.pop()!, qc = q % C, qr = (q - qc) / C;
        comp.push(q);
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nc = qc + dc, nr = qr + dr, nk = nr * C + nc;
          if (g.inside(nc, nr) && !seen[nk] && g.ch(nc, nr) === ch) {
            seen[nk] = 1;
            st.push(nk);
          }
        }
      }
      out.push(comp);
    }
  return out;
}

/** Edge-to-point distance from a footprint rectangle (0 inside). */
function rectDist(r: Rect, x: number, z: number): number {
  const [lx, lz] = toLocal(r, x, z);
  return Math.hypot(Math.max(Math.abs(lx) - r.hw, 0), Math.max(Math.abs(lz) - r.hd, 0));
}

/** Edge-to-edge gap between two footprints (0 when they touch), sampled at the corners. */
function overlapGap(a: Rect, b: Rect): number {
  return Math.min(...corners(a).map(([x, z]) => rectDist(b, x, z)), ...corners(b).map(([x, z]) => rectDist(a, x, z)));
}

interface Lane {
  /** Lane centres the body reaches. */
  reach: Uint8Array;
  /** Cells the body sweeps (centres dilated by its radius). */
  body: Uint8Array;
}

/**
 * Where a body of radius `radius` can stand and walk from the seeds. A lane centre is a cell centre whose disc of
 * cells (`offs`) is walkable map geometry and whose distance to every solid footprint, measured edge to point
 * against the prop's real rectangle (not its raster), is at least `radius`.
 */
function laneBody(g: Grid, solids: Rect[], seeds: number[], offs: V2[], radius: number): Lane {
  const { columns: C, rows: R } = g.lv, N = C * R;
  const pass = new Uint8Array(N);
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      let ok = true;
      for (const [dc, dr] of offs) {
        const nc = c + dc, nr = r + dr;
        if (!g.inside(nc, nr) || !WALKABLE.has(g.ch(nc, nr))) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const [x, z] = g.centre(c, r);
        for (const s of solids)
          if (rectDist(s, x, z) < radius - EPS) {
            ok = false;
            break;
          }
      }
      pass[r * C + c] = ok ? 1 : 0;
    }
  const reach = new Uint8Array(N), st: number[] = [], n = Math.ceil(1.5 / g.step);
  for (const s of seeds) {
    // A seed snaps to the nearest lane cell within 1.5 m.
    const sc = s % C, sr = (s - sc) / C;
    let best = -1, bd = Infinity;
    for (let dr = -n; dr <= n; dr++)
      for (let dc = -n; dc <= n; dc++) {
        const c = sc + dc, r = sr + dr;
        if (!g.inside(c, r) || !pass[r * C + c]) continue;
        if (dc * dc + dr * dr < bd) [best, bd] = [r * C + c, dc * dc + dr * dr];
      }
    if (best >= 0 && !reach[best]) {
      reach[best] = 1;
      st.push(best);
    }
  }
  while (st.length) {
    const q = st.pop()!, qc = q % C, qr = (q - qc) / C;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = qc + dc, nr = qr + dr, nk = nr * C + nc;
      if (g.inside(nc, nr) && pass[nk] && !reach[nk]) {
        reach[nk] = 1;
        st.push(nk);
      }
    }
  }
  const body = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (!reach[k]) continue;
    const c = k % C, r = (k - c) / C;
    for (const [dc, dr] of offs) if (g.inside(c + dc, r + dr)) body[(r + dr) * C + c + dc] = 1;
  }
  return { reach, body };
}

interface RouteTarget {
  label: string;
  /** Who the finding is filed under when nothing better is known. */
  item: string;
  /** Reached when the body covers one of these cells... */
  cells?: number[];
  /** ...or when this holds for a reached lane centre (furniture: the body's edge within USE_REACH of it / its front). */
  at?: (x: number, z: number) => boolean;
  /** The furniture itself: never its own culprit. */
  self?: Res;
}

/** Where the lane starts on a level: the outside door on the lowest level, the stair arrival (its steps and head zone) on the others. */
function laneSeeds(ctx: Ctx, g: Grid, level: number): number[] {
  const lowest = Math.min(...ctx.grids.keys()), C = g.lv.columns;
  const seeds: number[] = [];
  if (level === lowest) {
    const e = ctx.input.map.entry;
    if (e) {
      for (const k of [0.3, 1.0]) {
        const [c, r] = g.cellOf(e.position[0] + e.facing[0] * k, e.position[1] + e.facing[1] * k);
        if (g.inside(c, r)) {
          seeds.push(r * C + c);
          break;
        }
      }
    } else for (const comp of components(g, "E")) seeds.push(comp[0]!);
  } else {
    for (const comp of components(g, "S")) seeds.push(...comp);
    for (const comp of components(g, "A")) seeds.push(...comp);
    if (!seeds.length) for (const comp of components(g, "W")) seeds.push(...comp);
    // an outdoor site keeps one level per area: its ways in are 'E' cells, like a ground floor without map.entry
    if (!seeds.length) for (const comp of components(g, "E")) seeds.push(comp[0]!);
  }
  return seeds;
}

/** The map's own lane targets on a level: every room, stair, doorway and stair approach/landing. */
function structuralTargets(g: Grid): RouteTarget[] {
  const C = g.lv.columns, N = C * g.lv.rows;
  const targets: RouteTarget[] = [];
  const roomCells = new Map<string, number[]>();
  for (let k = 0; k < N; k++) {
    const c = k % C, id = g.roomAt(c, (k - c) / C);
    if (id) (roomCells.get(id) ?? roomCells.set(id, []).get(id)!).push(k);
  }
  for (const room of g.lv.rooms) targets.push({ label: `room ${room.id}`, item: room.id, cells: roomCells.get(room.id) ?? [] });
  for (const [ch, name] of [["S", "stair"], ["D", "doorway"], ["A", "stair approach/landing"]] as const)
    for (const comp of components(g, ch)) {
      const k = comp[Math.floor(comp.length / 2)]!, c = k % C, [x, z] = g.centre(c, (k - c) / C);
      targets.push({ label: `the ${name} at ${at2(x, z)}`, item: "", cells: comp });
    }
  return targets;
}

/** Furniture a person uses: the body must get within USE_REACH of it; of its FRONT when it keeps a clearance. */
function useTarget(s: Res, radius: number): RouteTarget | undefined {
  if (!s.floor || !(s.data.clearance > 0 || USED_CATEGORIES.has(s.data.category))) return undefined;
  const fr = s.floor, front = s.data.clearance > 0;
  return {
    label: `${s.work.id} (${s.work.prop})${front ? " from the front" : ""}`,
    item: s.work.id,
    self: s,
    at: (x, z) => rectDist(fr, x, z) <= radius + USE_REACH + EPS && (!front || toLocal(fr, x, z)[1] > fr.hd - EPS),
  };
}

function laneHit(g: Grid, lane: Lane, t: RouteTarget): boolean {
  if (t.cells) return t.cells.some((k) => lane.body[k]);
  const C = g.lv.columns, N = C * g.lv.rows;
  for (let k = 0; k < N; k++) {
    if (!lane.reach[k]) continue;
    const c = k % C, [x, z] = g.centre(c, (k - c) / C);
    if (t.at!(x, z)) return true;
  }
  return false;
}

function routeCheck(ctx: Ctx, placed: Res[]): void {
  const lowest = Math.min(...ctx.grids.keys());
  const radius = ctx.opts.laneWidth / 2, lw = f2(ctx.opts.laneWidth);
  for (const [level, g] of ctx.grids) {
    const C = g.lv.columns;
    const seeds = laneSeeds(ctx, g, level);
    if (!seeds.length) {
      warn(ctx, "", "no-entry", `level ${level}: nothing to route from (${level === lowest ? "map.entry or 'E' cells" : "stair 'S' or well 'W' cells"}); the walkable-lane check was skipped`);
      continue;
    }
    const targets = structuralTargets(g);
    const solids = placed.filter((r) => r.level === level && r.floor);
    for (const s of solids) {
      const t = useTarget(s, radius);
      if (t) targets.push(t);
    }
    const offs = laneOffsets(g.step, radius);
    const rects = (skip?: Res): Rect[] => solids.filter((s) => s !== skip).map((s) => s.floor!);
    const hit = (lane: Lane, t: RouteTarget): boolean => laneHit(g, lane, t);
    const empty = laneBody(g, [], seeds, offs, radius);
    const now = laneBody(g, rects(), seeds, offs, radius);
    const without = new Map<Res, Lane>();
    for (const t of targets) {
      // The map alone (furniture: with only itself standing) must allow it, or the geometry is at fault, not the plan.
      const base = t.self ? laneBody(g, [t.self.floor!], seeds, offs, radius) : empty;
      if (!hit(base, t)) {
        warn(ctx, t.item, "route-geometry", `level ${level}: ${t.label} is not reachable by a ${lw} m lane even with nothing else placed (map geometry${t.self ? " or the way it faces" : ""}); not counted against the plan`);
        continue;
      }
      if (hit(now, t)) continue;
      const culprits = solids.filter((s) => {
        if (s === t.self) return false;
        if (!without.has(s)) without.set(s, laneBody(g, rects(s), seeds, offs, radius));
        return hit(without.get(s)!, t);
      });
      const tc = t.cells ?? [];
      const gap = (s: Res): number =>
        t.self ? overlapGap(s.floor!, t.self.floor!) : Math.min(...tc.map((k) => g.distToCell(s.floor!, k % C, (k - (k % C)) / C)));
      const near = solids
        .filter((s) => s !== t.self)
        .map((s) => ({ s, d: gap(s) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((x) => x.s);
      const name = (s: Res): string => `${s.work.id} (${s.work.prop})`;
      vio(
        ctx,
        culprits[0]?.work.id ?? near[0]?.work.id ?? t.item,
        t.self ? "unreachable" : "blocks-route",
        `level ${level}: ${t.self ? `nobody can get to ${t.label}` : `${t.label} is cut off`}: no ${lw} m lane (player capsule plus comfort) reaches it from the ${level === lowest ? "entry" : "stairs"}; ` +
          (culprits.length
            ? `move ${culprits.map(name).join(" or ")} to reopen it`
            : `${near.map(name).join(", ")} together close it: move one of them to open a ${lw} m gap`),
      );
    }
  }
}

function pairChecks(ctx: Ctx, placed: Res[]): void {
  // Members of one set are authored together (a chair tucked under its desk), so they may touch.
  const same = (a: Res, b: Res): boolean => a.work.group !== "" && a.work.group === b.work.group;
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i]!;
    for (let j = 0; j < i; j++) {
      const b = placed[j]!;
      if (same(a, b)) continue;
      if (a.floor && b.floor && a.level === b.level) {
        const d = overlapDepth(a.floor, b.floor);
        if (d > 0.01) vio(ctx, a.work.id, "overlap", `${a.work.prop} overlaps ${b.work.id} (${b.work.prop}) on the floor; move it at least ${f2(d)} m apart`);
      }
      if (a.onWall && b.onWall && a.onWall.wall === b.onWall.wall) {
        const dt = Math.min(a.onWall.t1, b.onWall.t1) - Math.max(a.onWall.t0, b.onWall.t0);
        const dy = Math.min(a.onWall.y1, b.onWall.y1) - Math.max(a.onWall.y0, b.onWall.y0);
        if (dt > 0.01 && dy > 0.01)
          vio(ctx, a.work.id, "overlap", `${a.work.prop} overlaps ${b.work.id} on wall ${a.onWall.wall}; shift t by ${f2(dt)} m${a.data.mount === "wall" ? ` or its height by ${f2(dy)} m` : ""}`);
      }
    }
  }
  // Clearance strips in front of floor and wall props.
  for (const a of placed) {
    const c = a.data.clearance;
    if (c <= 0 || (a.data.mount !== "floor" && a.data.mount !== "wall")) continue;
    const g = ctx.grids.get(a.level);
    if (!g) continue;
    const f = fwd(a.box.yaw), off = a.data.mount === "wall" ? c / 2 : a.box.d / 2 + c / 2;
    const base: V2 = a.data.mount === "wall" ? [a.box.cx - (f[0] * a.box.d) / 2, a.box.cz - (f[1] * a.box.d) / 2] : [a.box.cx, a.box.cz];
    const strip: Rect = { cx: base[0] + f[0] * off, cz: base[1] + f[1] * off, hw: a.box.w / 2, hd: c / 2, yaw: a.box.yaw };
    const face = a.onWall ? ctx.walls.get(a.onWall.wall)?.wall : undefined;
    // an outdoor anchor's strip is not on the map's grid (the street map measures its pitches clear); other props still count below
    const badCell = a.outdoorAnchor ? undefined : g.cells(strip).find(([cc, rr]) => !(face && besideFace(g, face, cc, rr)) && (!WALKABLE.has(g.ch(cc, rr)) || g.ch(cc, rr) === "S"));
    if (badCell) {
      const [x, z] = g.centre(badCell[0], badCell[1]);
      vio(ctx, a.work.id, "clearance", `the ${f2(c)} m kept free in front of ${a.work.prop} runs into ${CELL_NAME[g.ch(badCell[0], badCell[1])] ?? "no floor"} at ${at2(x, z)}; turn it or move it`);
    }
    for (const b of placed) {
      if (b === a || !b.floor || b.level !== a.level || same(a, b)) continue;
      const d = overlapDepth(strip, b.floor);
      if (d > 0.01) vio(ctx, b.work.id, "clearance", `${b.work.prop} stands in the ${f2(c)} m kept clear in front of ${a.work.id} (${a.work.prop}); move it ${f2(d)} m out of that strip`);
    }
  }
}

function planChecks(ctx: Ctx, placed: Res[]): void {
  const { plan } = ctx.input;
  const mapRooms = new Map<string, { area: number; level: number; placeable: number }>();
  for (const [level, g] of ctx.grids) {
    const floor = new Map(placeableFloor(g.lv).map((f) => [f.room, f.placeable]));
    for (const r of g.lv.rooms) mapRooms.set(r.id, { area: r.area, level, placeable: floor.get(r.id) ?? r.area });
  }
  for (const id of Object.keys(plan.rooms))
    if (!mapRooms.has(id)) vio(ctx, id, "unknown-room", `plan.rooms names "${id}" but map "${ctx.input.map.id}" has rooms ${[...mapRooms.keys()].join(", ")}`);
  for (const [level, g] of ctx.grids)
    for (const f of placeableFloor(g.lv))
      if (f.placeable <= EPS && f.area > 0)
        warn(ctx, f.room, "no-placeable-floor",
          `room ${f.room} (level ${level}, ${f2(f.area)} m²) has no floor left for solid furniture once its walking paths and keep-clear zones are reserved: ` +
            `furnish it with wall, hung and ceiling items and rugs only`);
  const counts = new Map<string, number>();
  for (const r of placed) if (r.room) counts.set(r.room, (counts.get(r.room) ?? 0) + 1);
  for (const [id, info] of mapRooms) {
    if (!plan.rooms[id]) vio(ctx, id, "room-missing", `room ${id} (level ${info.level}, ${f2(info.area)} m²) is not in plan.rooms: give it a role and furnish it`);
    const n = counts.get(id) ?? 0, need = ctx.opts.minItems(info.area);
    if (n === 0) vio(ctx, id, "room-empty", `room ${id} (level ${info.level}, ${f2(info.area)} m²) has no items; it needs at least ${need}`);
    else if (n < need) vio(ctx, id, "room-sparse", `room ${id} (${f2(info.area)} m²) has ${n} item${n === 1 ? "" : "s"}; it needs at least ${need}`);
    // Density: "more" is not "better". A lived-in room is mostly open floor.
    const role = plan.rooms[id]?.role ?? "";
    const here = placed.filter((r) => r.room === id && r.level === info.level && r.floor);
    const cover = here.reduce((a, r) => a + r.floor!.hw * r.floor!.hd * 4, 0);
    const maxCover = ctx.opts.maxCover ?? defaultMaxCover(role);
    const base = info.placeable;
    if (base > 0 && cover > base * maxCover + EPS) {
      const big = [...here].sort((a, b) => b.floor!.hw * b.floor!.hd - a.floor!.hw * a.floor!.hd).slice(0, 4).map((r) => `${r.work.id} ${f2(r.floor!.hw * r.floor!.hd * 4)} m²`);
      vio(ctx, id, "too-dense",
        `room ${id} (${f2(base)} m² placeable floor) has ${f2(cover)} m² of solid props (${Math.round((cover / base) * 100)}%); the ceiling is ${Math.round(maxCover * 100)}% ` +
          `(${f2(base * maxCover)} m²): leave out ${f2(cover - base * maxCover)} m² of furniture (largest: ${big.join(", ")})`);
    }
    const loose = here.filter((r) => isLooseClutter(r.data));
    const budget = ctx.opts.looseBudget(info.area, role);
    if (loose.length > budget)
      vio(ctx, id, "floor-clutter",
        `room ${id} has ${loose.length} loose containers standing on the floor (${loose.map((r) => r.work.id).join(", ")}); its budget is ${budget}` +
          `${STORE_ROLES.has(role) ? "" : " (a storage room or cellar holds more)"}: put ${loose.length - budget} on a shelf, in a storage room, or leave them out`);
  }
  for (const r of placed) {
    const spec = r.room ? plan.rooms[r.room] : undefined;
    const roles = spec ? [spec.role, ...(spec.also ?? [])] : [];
    // only things that stand, hang or mount in the room say what the room is; surface and slot items follow the furniture they sit on
    if (r.data.mount !== "floor" && r.data.mount !== "wall" && r.data.mount !== "ceiling") continue;
    if (roles.length && r.data.rooms.length && !r.data.rooms.some((x) => roles.includes(x)))
      warn(ctx, r.work.id, "room-role", `${r.work.prop} belongs in ${r.data.rooms.join("/")} rooms but ${r.room} is ${roles.join("/")}`);
  }
  for (const [level, g] of ctx.grids) {
    const fires = placed.filter((r) => r.level === level && r.data.fire);
    const hall = g.lv.rooms.some((r) => r.maxHead >= 5);
    const limit = hall ? ctx.opts.flamesLargeHall : ctx.opts.flames;
    if (fires.length > limit)
      vio(ctx, "", "flame-budget", `level ${level} has ${fires.length} flames (${fires.map((r) => r.work.id).join(", ")}); the budget is ${limit}${hall ? " (large hall)" : ""}: remove ${fires.length - limit} or use unlit props`);
  }
}

// ---- placement by intent (`auto` places) -----------------------------------

type AutoPlace = Extract<DressingPlace, { kind: "auto" }>;

/** A set member placed relative to the auto item's anchor piece. */
interface AutoMember {
  w: Work;
  data: DressingData;
  place: RelPlace;
}

/** One candidate spot: the concrete place it becomes, and the floor pieces (anchor + set members) it puts down. */
interface AutoCand {
  place: DressingPlace;
  mirror: boolean;
  pieces: Res[];
  /** Lower is better. */
  score: number;
}

/** Minimum edge gap between an auto item and anything already standing (set mates excepted). */
const AUTO_GAP = 0.15;
/** A gap this wide or wider counts as "spaced"; narrower costs score. */
const AUTO_SPACED = 0.45;
/** Spots along a wall are tried every AUTO_T metres. */
const AUTO_T = 0.125;
/** Exact lane checks tried before giving up on an item. */
const AUTO_LANE_TRIES = 40;

const mirrorRel = (p: RelPlace): RelPlace => ({ ...p, at: [-p.at[0], p.at[1]], yaw: -p.yaw });

/** The floor pieces of an item whose anchor box is `box` (members relative to it, mirrored when asked). */
function autoPieces(w: Work, data: DressingData, members: AutoMember[], box: Box, room: string, level: number, mirror: boolean): Res[] {
  const out: Res[] = [floorRes(w, data, level, box, room, false)];
  for (const m of members) {
    const p = mirror ? mirrorRel(m.place) : m.place;
    const [ox, oz] = rot(box.yaw, p.at[0], p.at[1]);
    const mb: Box = { cx: box.cx + ox, cz: box.cz + oz, y0: box.y0, yaw: box.yaw + p.yaw * DEG, w: m.data.size[0], h: m.data.size[1], d: m.data.size[2] };
    out.push(floorRes(m.w, m.data, level, mb, room, false));
  }
  return out;
}

/** Strip kept free in front of a floor/wall prop (its `clearance`), or undefined. */
function clearStrip(r: Res): Rect | undefined {
  const c = r.data.clearance;
  if (c <= 0 || (r.data.mount !== "floor" && r.data.mount !== "wall")) return undefined;
  const f = fwd(r.box.yaw), off = r.data.mount === "wall" ? c / 2 : r.box.d / 2 + c / 2;
  const base: V2 = r.data.mount === "wall" ? [r.box.cx - (f[0] * r.box.d) / 2, r.box.cz - (f[1] * r.box.d) / 2] : [r.box.cx, r.box.cz];
  return { cx: base[0] + f[0] * off, cz: base[1] + f[1] * off, hw: r.box.w / 2, hd: c / 2, yaw: r.box.yaw };
}

/**
 * Can this floor piece stand here? Undefined when it can, else a short reason. Same rules the resolver applies afterwards:
 * free floor of the room (no path, keep-clear zone, stair, doorway), headroom, its own `against`, the stair/doorway hard
 * buffer, a gap to everything already standing, nobody's clearance strip, and its own strip on walkable floor.
 */
function autoPieceRefusal(ctx: Ctx, g: Grid, room: string, p: Res, wall: SocketWall | undefined, standing: Res[]): string | undefined {
  const d = p.data, rect = rectOf(p.box);
  let face = wall;
  if (d.against === "wall" || (!wall && p.onWall)) {
    const flush = backOnWall(ctx, p.level, p.box);
    if (!flush) return "needs a wall behind it";
    face = ctx.walls.get(flush.wall)?.wall;
    p.onWall = { wall: flush.wall, t0: flush.t0, t1: flush.t1, y0: 0, y1: p.box.h };
  }
  let minHead = Infinity, open = 0, n = 0;
  for (const [c0, r0] of g.cells(rect)) {
    const [c, r] = (face && besideFace(g, face, c0, r0)) || [c0, r0];
    const ch = g.ch(c, r);
    if (d.solid ? ch !== "." && ch !== "o" : !FLOORISH.has(ch))
      return ch === "x" ? "a walking path" : ch === "H" || ch === "A" ? "a keep-clear zone" : ch === "#" || ch === " " ? "a wall" : "a stair, well or doorway";
    if (g.roomAt(c, r) !== room) return "another room";
    const h = g.head(c, r);
    minHead = Math.min(minHead, Number.isFinite(h) ? h : 0);
    if (ch === "o") open++;
    n++;
  }
  if (minHead < d.size[1] + HEAD_MARGIN - EPS) return "a ceiling too low";
  const outdoor = open * 2 > n;
  if ((d.setting === "indoor" && outdoor) || (d.setting === "outdoor" && !outdoor)) return "wrong setting";
  if (obstacleHit(ctx, p.level, p.box, AUTO_GAP)) return "placed geometry or a decal";
  if (!d.solid) return undefined;
  if (!exemptCentre(p.work, d) && centreHit(ctx, g, p.level, rect)) return "the room's keep-clear centre";
  if (marginHit(g, rect, ctx.opts.pathMargin)) return "the walk-line margin";
  // stair / well / doorway / entry hard buffer
  const reach = ctx.opts.hardBuffer + Math.hypot(rect.hw, rect.hd) + g.step;
  const [c0, r0] = g.cellOf(rect.cx - reach, rect.cz - reach), [c1, r1] = g.cellOf(rect.cx + reach, rect.cz + reach);
  for (let rr = r0; rr <= r1; rr++)
    for (let c = c0; c <= c1; c++) if (HAZARD_NAME[g.ch(c, rr)] && g.distToCell(rect, c, rr) < ctx.opts.hardBuffer - EPS) return "too close to a stair or doorway";
  for (const s of standing) {
    if (s.level !== p.level) continue;
    if (s.floor && -overlapDepth(rect, s.floor) < AUTO_GAP - EPS) return `too close to ${s.work.id}`;
    const strip = clearStrip(s);
    if (strip && overlapDepth(strip, rect) > 0.01) return `in front of ${s.work.id}`;
    if (p.onWall && s.onWall && s.onWall.wall === p.onWall.wall) {
      const dt = Math.min(s.onWall.t1, p.onWall.t1) - Math.max(s.onWall.t0, p.onWall.t0), dy = Math.min(s.onWall.y1, p.onWall.y1) - Math.max(s.onWall.y0, p.onWall.y0);
      if (dt > 0.01 && dy > 0.01) return `under ${s.work.id} on the wall`;
    }
  }
  const strip = clearStrip(p);
  if (strip) {
    for (const [cc, rr] of g.cells(strip)) {
      if (face && besideFace(g, face, cc, rr)) continue;
      const ch = g.ch(cc, rr);
      if (!WALKABLE.has(ch) || ch === "S") return "its clearance runs into a wall";
    }
    for (const s of standing) if (s.floor && s.level === p.level && overlapDepth(strip, s.floor) > 0.01) return "its clearance is blocked";
  }
  return undefined;
}

/** Soft cost of standing inside the comfortable buffers (the resolver warns there): stairs/doorways under warnBuffer, a hearth's clearance under hardBuffer. */
function autoComfort(ctx: Ctx, g: Grid, pieces: Res[]): number {
  let cost = 0;
  for (const p of pieces) {
    if (!p.floor) continue;
    const rect = p.floor, reach = ctx.opts.warnBuffer + Math.hypot(rect.hw, rect.hd) + g.step;
    const [c0, r0] = g.cellOf(rect.cx - reach, rect.cz - reach), [c1, r1] = g.cellOf(rect.cx + reach, rect.cz + reach);
    let dh = Infinity, dz = Infinity;
    for (let rr = r0; rr <= r1; rr++)
      for (let c = c0; c <= c1; c++) {
        const ch = g.ch(c, rr);
        if (HAZARD_NAME[ch]) dz = Math.min(dz, g.distToCell(rect, c, rr));
        else if (ch === "H") dh = Math.min(dh, g.distToCell(rect, c, rr));
      }
    cost += Math.max(0, ctx.opts.warnBuffer - dz) + Math.max(0, ctx.opts.hardBuffer - dh);
  }
  return cost;
}

/** Nearest gap from these pieces to anything standing (capped), for spacing scores. */
function autoGap(pieces: Res[], standing: Res[]): number {
  let gap = AUTO_SPACED;
  for (const p of pieces)
    if (p.floor)
      for (const s of standing) if (s.floor && s.level === p.level) gap = Math.min(gap, Math.max(0, -overlapDepth(p.floor, s.floor)));
  return gap;
}

/** Where `near` points: an earlier item, the door, a stair, or the nearest map anchor of that kind. */
function autoTarget(ctx: Ctx, level: number, room: string, near: string, out: Map<string, Res>, setAnchor: Map<string, string>): V2 | undefined {
  const it = out.get(near) ?? out.get(setAnchor.get(near) ?? "");
  if (it) return it.level === level ? [it.box.cx, it.box.cz] : undefined;
  const g = ctx.grids.get(level)!, rm = g.lv.rooms.find((r) => r.id === room)!;
  const lowest = Math.min(...ctx.grids.keys());
  if ((near === "door" || near === "entry") && ctx.input.map.entry && level === lowest) return [...ctx.input.map.entry.position];
  const kinds = near === "stair" ? ["stair-foot", "stair-head", "stair-approach"] : [near];
  const pts = ctx.input.map.anchors.filter((a) => a.level === level && kinds.includes(a.kind)).map((a) => [a.position[0], a.position[2]] as V2);
  if (!pts.length && near === "stair")
    for (const comp of components(g, "S")) {
      const k = comp[Math.floor(comp.length / 2)]!, c = k % g.lv.columns;
      pts.push(g.centre(c, (k - c) / g.lv.columns));
    }
  pts.sort((a, b) => Math.hypot(a[0] - rm.centre[0], a[1] - rm.centre[1]) - Math.hypot(b[0] - rm.centre[0], b[1] - rm.centre[1]));
  return pts[0];
}

/** The lane rule for a candidate: everything reached before must still be reached, and what it adds must be usable. */
function autoLaneOk(ctx: Ctx, g: Grid, level: number, before: Res[], baseLane: Lane | undefined, added: Res[]): boolean {
  if (!baseLane) return true;
  const radius = ctx.opts.laneWidth / 2, offs = laneOffsets(g.step, radius), seeds = laneSeeds(ctx, g, level);
  const solids = [...before, ...added].filter((r) => r.level === level && r.floor);
  const lane = laneBody(g, solids.map((s) => s.floor!), seeds, offs, radius);
  const old: RouteTarget[] = [...structuralTargets(g)];
  for (const s of before)
    if (s.level === level) {
      const t = useTarget(s, radius);
      if (t) old.push(t);
    }
  for (const t of old) if (laneHit(g, baseLane, t) && !laneHit(g, lane, t)) return false;
  for (const s of added) {
    const t = useTarget(s, radius);
    if (t && !laneHit(g, lane, t)) return false;
  }
  return true;
}

/**
 * Choose a spot for an `auto` item in its room and turn its place into the concrete one (`wall`, `floor` or `ceiling`), so the
 * normal resolution and every check run on it. Returns false (with a violation saying how much room was left) when nothing fits.
 */
function resolveAuto(ctx: Ctx, w: Work, data: DressingData, members: AutoMember[], out: Map<string, Res>, setAnchor: Map<string, string>): boolean {
  const p = w.place as AutoPlace;
  const what = w.group ? `set item "${w.group}"` : `${w.id} (${w.prop})`;
  let level = -1, g: Grid | undefined;
  for (const [l, gg] of ctx.grids) if (gg.lv.rooms.some((r) => r.id === p.room)) [level, g] = [l, gg];
  if (!g) {
    const all = [...ctx.grids.values()].flatMap((gg) => gg.lv.rooms.map((r) => r.id));
    vio(ctx, w.id, "auto-room", `${what}: room "${p.room}" is not in map "${ctx.input.map.id}" (rooms: ${all.join(", ")})`);
    return false;
  }
  const grid = g;
  const room = grid.lv.rooms.find((r) => r.id === p.room)!;
  const standing = [...out.values()];
  const target = p.near ? autoTarget(ctx, level, p.room, p.near, out, setAnchor) : undefined;
  if (p.near && !target) {
    vio(ctx, w.id, "auto-near",
      `${what}: \`near: "${p.near}"\` is neither an earlier item in this plan on level ${level} nor an anchor kind of this map (door, stair, ${[...new Set(ctx.input.map.anchors.map((a) => a.kind))].join(", ")})`);
    return false;
  }
  const prefer = p.prefer ?? (p.near ? "near" : data.mount === "floor" && data.against === "free" ? "open" : "wall");
  const walls = grid.lv.walls.filter((wl) => wl.room === p.room && (!p.wall || wl.id === p.wall));
  if (p.wall && !walls.length) {
    vio(ctx, w.id, "auto-wall", `${what}: wall "${p.wall}" is not a wall of room ${p.room} (its walls: ${grid.lv.walls.filter((wl) => wl.room === p.room).map((wl) => wl.id).join(", ")})`);
    return false;
  }
  const record = (place: DressingPlace, mirror: boolean): void => {
    w.place = place;
    if (mirror)
      for (const m of members) {
        m.place = mirrorRel(m.place);
        m.w.place = m.place;
      }
    ctx.autos.push({ item: w.group || w.id, place, mirror, note: `prefer ${prefer}${p.near ? ` near ${p.near}` : ""}` });
  };

  // -- ceiling props: over the room centre, or over the item they are near
  if (data.mount === "ceiling") {
    let at: V2 = target ?? room.centre;
    const [c, r] = grid.cellOf(at[0], at[1]);
    if (grid.roomAt(c, r) !== p.room) at = room.centre;
    const [cc, rr] = grid.cellOf(at[0], at[1]), head = grid.head(cc, rr);
    const drop = data.chain && Number.isFinite(head) ? Math.max(0, Math.min(1, Math.floor((head - data.size[1] - WALK_HEAD - 0.1) * 4) / 4)) : 0;
    record({ kind: "ceiling", level, at: [+at[0].toFixed(3), +at[1].toFixed(3)], yaw: 0, drop }, false);
    return true;
  }

  // -- wall-hung props: centred on the longest free stretch of the room's walls (or nearest the target)
  if (data.mount === "wall") {
    const [W, H] = data.size;
    const height = (data.wallHeight[0] + data.wallHeight[1]) / 2;
    let best: { wall: SocketWall; t: number; h: number; score: number } | undefined;
    for (const wl of walls) {
      const hh = Math.min(height, wl.height - H);
      if (hh < data.wallHeight[0] - EPS) continue;
      const ts: number[] = [];
      for (const [a, b] of centreRanges(wl, W))
        for (let t = a; t <= b + EPS; t += AUTO_T) {
          const tt = Math.min(t, b);
          const busy = standing.some(
            (s) =>
              s.onWall && s.onWall.wall === wl.id &&
              Math.min(s.onWall.t1, tt + W / 2) - Math.max(s.onWall.t0, tt - W / 2) > -0.1 &&
              Math.min(s.onWall.y1, hh + H) - Math.max(s.onWall.y0, hh) > 0.01,
          );
          if (!busy) ts.push(tt);
        }
      for (const run of runsOf(ts)) {
        const mid = (run[0]! + run[run.length - 1]!) / 2, t = run.reduce((x, y) => (Math.abs(y - mid) < Math.abs(x - mid) ? y : x));
        const { u } = wallFrame(wl), px = wl.a[0] + u[0] * t, pz = wl.a[1] + u[1] * t;
        const score = target ? Math.hypot(px - target[0], pz - target[1]) : -(run[run.length - 1]! - run[0]!);
        if (!best || score < best.score - EPS) best = { wall: wl, t, h: hh, score };
      }
    }
    if (!best) {
      vio(ctx, w.id, "auto-no-room",
        `${what} (${f2(W)} m wide, ${f2(H)} m tall) finds no free wall stretch in room ${p.room}: every wall is shorter, too low or already hung (${autoLeft(ctx, grid, p.room, standing, walls)})`);
      return false;
    }
    record({ kind: "wall", wall: best.wall.id, t: +best.t.toFixed(3), height: +best.h.toFixed(3) }, false);
    return true;
  }

  // -- floor props and sets
  const mirrors = w.group && w.mirror === undefined && members.some((m) => Math.abs(m.place.at[0]) > EPS || Math.abs(m.place.yaw) > EPS) ? [false, true] : [false];
  const role = ctx.input.plan.rooms[p.room]?.role ?? "";
  // density first: when the room's cover ceiling or loose budget is spent nothing can fit, wherever it goes
  const placeable = placeableFloor(grid.lv).find((f) => f.room === p.room)?.placeable ?? room.area;
  const capM2 = placeable * (ctx.opts.maxCover ?? defaultMaxCover(role));
  const usedM2 = standing.filter((s) => s.room === p.room && s.floor).reduce((a, s) => a + s.floor!.hw * s.floor!.hd * 4, 0);
  const proto = autoPieces(w, data, members, { cx: 0, cz: 0, y0: 0, yaw: 0, w: data.size[0], h: data.size[1], d: data.size[2] }, p.room, level, false);
  const addM2 = proto.filter((r) => r.floor).reduce((a, r) => a + r.floor!.hw * r.floor!.hd * 4, 0);
  if (usedM2 + addM2 > capM2 + EPS) {
    vio(ctx, w.id, "auto-no-room",
      `${what} needs ${f2(addM2)} m² of floor but room ${p.room} has ${f2(Math.max(0, capM2 - usedM2))} m² of its cover ceiling left (${f2(usedM2)} of ${f2(capM2)} m² used, ` +
        `${Math.round((capM2 / Math.max(placeable, EPS)) * 100)}% of ${f2(placeable)} m² placeable): leave it out or choose something smaller`);
    return false;
  }
  const loose = proto.filter((r) => isLooseClutter(r.data)).length;
  if (loose) {
    const have = standing.filter((s) => s.room === p.room && s.floor && isLooseClutter(s.data)).length, budget = ctx.opts.looseBudget(room.area, role);
    if (have + loose > budget) {
      vio(ctx, w.id, "auto-no-room", `${what} adds ${loose} loose container(s) but room ${p.room} already has ${have} of its ${budget}: put it on a shelf, in a storage room, or leave it out`);
      return false;
    }
  }

  const cands: AutoCand[] = [];
  const refused = new Map<string, number>();
  const pieceOk = (pieces: Res[], wall?: SocketWall): boolean => {
    for (let i = 0; i < pieces.length; i++) {
      const why = autoPieceRefusal(ctx, grid, p.room, pieces[i]!, i === 0 ? wall : undefined, standing);
      if (why) {
        const key = `${pieces[i]!.work.id.replace(/^.*\//, "")} on ${why}`.replace(/ on (needs|too|in front|under|its)/, " $1");
        refused.set(key, (refused.get(key) ?? 0) + 1);
        return false;
      }
    }
    return true;
  };
  const [W, H, D] = data.size;
  // wall candidates: back to a wall, every AUTO_T along each free span
  if (prefer !== "open" && data.against !== "free") {
    for (const wl of walls.filter((x) => H <= x.height + EPS))
      for (const mirror of mirrors) {
        const ok: { t: number; pieces: Res[] }[] = [];
        const { u, len } = wallFrame(wl), yaw = yawOf(wl.normal);
        for (const [a, b] of centreRanges(wl, W))
          for (let t = a; t <= b + EPS; t += AUTO_T) {
            const tt = Math.min(t, b), px = wl.a[0] + u[0] * tt, pz = wl.a[1] + u[1] * tt;
            const box: Box = { cx: px + (wl.normal[0] * D) / 2, cz: pz + (wl.normal[1] * D) / 2, y0: grid.y(px + (wl.normal[0] * D) / 2, pz + (wl.normal[1] * D) / 2), yaw, w: W, h: H, d: D };
            const pieces = autoPieces(w, data, members, box, p.room, level, mirror);
            pieces[0]!.onWall = { wall: wl.id, t0: tt - W / 2, t1: tt + W / 2, y0: 0, y1: H };
            if (pieceOk(pieces, wl)) ok.push({ t: tt, pieces });
          }
        for (const run of runsOf(ok.map((o) => o.t))) {
          const lo = run[0]!, hi = run[run.length - 1]!, span = hi - lo, mid = (lo + hi) / 2;
          for (const o of ok.filter((x) => x.t >= lo - EPS && x.t <= hi + EPS)) {
            const gap = autoGap(o.pieces, standing);
            let score: number;
            if (prefer === "corner") score = Math.min(o.t - W / 2, len - (o.t + W / 2)) * 4 - span * 0.01;
            else if (prefer === "near" && target) score = rectDist(rectOf(o.pieces[0]!.box), target[0], target[1]);
            else score = span * 0.5 + Math.abs(o.t - mid) * 2; // centred on the snuggest free stretch it fits: long stretches stay whole for later items
            score += (AUTO_SPACED - gap) * 2 + autoComfort(ctx, grid, o.pieces) * 6 + (mirror ? 0.001 : 0);
            cands.push({ place: { kind: "wall", wall: wl.id, t: +o.t.toFixed(3) }, mirror, pieces: o.pieces, score });
          }
        }
      }
  }
  // open-floor candidates: centres on the cell grid, turned to the room's axes
  if ((prefer === "open" || prefer === "near" || data.against === "free" || !cands.length) && data.against !== "wall") {
    const [x0, x1, z0, z1] = room.bbox, longX = x1 - x0 >= z1 - z0;
    for (let z = z0; z <= z1 + EPS; z += grid.step)
      for (let x = x0; x <= x1 + EPS; x += grid.step) {
        const [c, r] = grid.cellOf(x, z);
        if (grid.roomAt(c, r) !== p.room) continue;
        for (const deg of [0, 90, 180, 270])
          for (const mirror of mirrors) {
            const box: Box = { cx: x, cz: z, y0: grid.y(x, z), yaw: deg * DEG, w: W, h: H, d: D };
            const pieces = autoPieces(w, data, members, box, p.room, level, mirror);
            if (!pieceOk(pieces)) continue;
            const gap = autoGap(pieces, standing);
            // tidy: the anchor's long side along the room's long axis
            const across = (deg % 180 === 0) === (W >= D) === longX ? 0 : 0.05;
            let score: number;
            if (prefer === "near" && target) {
              const f = fwd(box.yaw), dx = target[0] - x, dz = target[1] - z, dl = Math.hypot(dx, dz) || 1;
              score = rectDist(rectOf(box), target[0], target[1]) + (1 - (f[0] * dx + f[1] * dz) / dl) * 0.2;
            } else if (roomRules(ctx, p.room).keepCentre) {
              // walls and corners fill first: the open spot nearest the room's edge (outside its keep-clear centre)
              const zd = ctx.zones.get(level)!.dist, [cc, rr] = grid.cellOf(x, z);
              score = (zd[rr * grid.lv.columns + cc] ?? 0) + across;
            } else score = -autoRoom(grid, p.room, pieces) + across + Math.hypot(x - room.centre[0], z - room.centre[1]) * 0.02;
            score += (AUTO_SPACED - gap) * 2 + autoComfort(ctx, grid, pieces) * 6 + (mirror ? 0.001 : 0) + deg * 1e-5;
            cands.push({ place: { kind: "floor", level, at: [+x.toFixed(3), +z.toFixed(3)], yaw: deg }, mirror, pieces, score });
          }
      }
  }
  cands.sort((a, b) => a.score - b.score);
  const seeds = laneSeeds(ctx, grid, level), radius = ctx.opts.laneWidth / 2;
  const baseLane = seeds.length
    ? laneBody(grid, standing.filter((s) => s.level === level && s.floor).map((s) => s.floor!), seeds, laneOffsets(grid.step, radius), radius)
    : undefined;
  let tries = 0;
  for (const c of cands) {
    if (tries++ >= AUTO_LANE_TRIES) break;
    if (!autoLaneOk(ctx, grid, level, standing, baseLane, c.pieces)) continue;
    record(c.place, c.mirror);
    return true;
  }
  const size = `${f2(W)} x ${f2(D)} m${members.length ? ` with ${members.length} member(s), ${f2(addM2)} m² in all` : ""}`;
  vio(ctx, w.id, "auto-no-room",
    `${what} (${size}${data.against === "wall" ? ", back to a wall" : ""}) does not fit in room ${p.room}${p.wall ? ` on wall ${p.wall}` : ""}` +
      `${cands.length ? ` without closing a ${f2(ctx.opts.laneWidth)} m lane` : ""}; left: ${autoLeft(ctx, grid, p.room, standing, walls)}` +
      `${refused.size ? `; spots tried were refused for ${[...refused].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`).join(", ")}` : ""}. ` +
      `Earlier items win: choose a smaller piece or another room${data.against === "wall" ? "" : ", prefer \"open\""}, or move it earlier in the plan`);
  return false;
}

/** Runs of consecutive values on the AUTO_T grid. */
function runsOf(ts: number[]): number[][] {
  const out: number[][] = [];
  for (const t of [...ts].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && t - last[last.length - 1]! <= AUTO_T + 0.01) last.push(t);
    else out.push([t]);
  }
  return out;
}

/** Open floor around the anchor's footprint: how far it grows before touching a cell nothing may stand on (capped 1.5 m). */
function autoRoom(g: Grid, room: string, pieces: Res[]): number {
  const r = rectOf(pieces[0]!.box), cap = 1.5;
  for (let d = g.step; d <= cap + EPS; d += g.step) {
    const ring: Rect = { ...r, hw: r.hw + d, hd: r.hd + d };
    for (const [c, rr] of g.cells(ring)) {
      const ch = g.ch(c, rr);
      if ((ch !== "." && ch !== "o") || g.roomAt(c, rr) !== room) return d - g.step;
    }
  }
  return cap;
}

/** What is left in a room, in words: the longest free wall stretch, the placeable floor, the cover still allowed. */
function autoLeft(ctx: Ctx, g: Grid, room: string, standing: Res[], walls: SocketWall[]): string {
  let longest = 0, where = "";
  for (const wl of walls) {
    // what stands within a metre of this wall (or hangs on it) takes its stretch, plus the gap kept to it
    const { u } = wallFrame(wl), busy: V2[] = [];
    for (const s of standing) {
      if (s.onWall?.wall === wl.id) busy.push([s.onWall.t0 - AUTO_GAP, s.onWall.t1 + AUTO_GAP]);
      else if (s.floor && ctx.walls.get(wl.id)?.level === s.level) {
        const cs = corners(s.floor), ts = cs.map(([x, z]) => (x - wl.a[0]) * u[0] + (z - wl.a[1]) * u[1]), ds = cs.map(([x, z]) => (x - wl.a[0]) * wl.normal[0] + (z - wl.a[1]) * wl.normal[1]);
        if (Math.min(...ds) < 1.0) busy.push([Math.min(...ts) - AUTO_GAP, Math.max(...ts) + AUTO_GAP]);
      }
    }
    for (const [a, b] of standStretches(g.lv, wl)) {
      const cuts = busy.filter(([t0, t1]) => t1 > a && t0 < b).sort((x, y) => x[0] - y[0]);
      let s = a;
      for (const [t0, t1] of [...cuts, [b, b] as V2]) {
        if (t0 - s > longest) [longest, where] = [t0 - s, `${wl.id} ${f2(s)}..${f2(t0)}`];
        s = Math.max(s, t1);
      }
    }
  }
  const rm = g.lv.rooms.find((r) => r.id === room)!;
  const placeable = placeableFloor(g.lv).find((f) => f.room === room)?.placeable ?? rm.area;
  const used = standing.filter((s) => s.room === room && s.floor).reduce((a, s) => a + s.floor!.hw * s.floor!.hd * 4, 0);
  const role = ctx.input.plan.rooms[room]?.role ?? "";
  const cap = placeable * (ctx.opts.maxCover ?? defaultMaxCover(role));
  return `longest free wall stretch ${f2(longest)} m${where ? ` (${where}, t left to right from inside)` : ""}, ${f2(placeable)} m² placeable floor, ${f2(Math.max(0, cap - used))} m² of the cover ceiling unused`;
}

// ---- entry point ----------------------------------------------------------

// ---- place checks: placed geometry, decals, scale, culture, set pieces; the per-room review ----

/** No prop overlaps placed geometry; no prop stands in a decal's projection (decals go on first, props keep off them). */
function obstacleChecks(ctx: Ctx, placed: Res[]): void {
  for (const r of placed) {
    if (r.outdoorAnchor) continue;
    const hit = obstacleHit(ctx, r.level, r.box);
    if (!hit) continue;
    if (hit.kind === "geometry")
      vio(ctx, r.work.id, "overlaps-geometry", `${r.work.prop} at ${at2(r.box.cx, r.box.cz)} overlaps placed geometry ${hit.id} (${hit.label}); move it clear (auto places avoid it)`);
    else
      vio(ctx, r.work.id, "decal-overlap",
        `${r.work.prop} at ${at2(r.box.cx, r.box.cz)} stands in decal ${hit.id}'s projection (${hit.label}): the decal would be sprayed over it. Decals go on BEFORE props and never under a prop's footprint: move the prop, or move the decal`);
  }
}

/** Scale and culture of every standing/hung/mounted item against its room; set pieces per room. */
function placeChecks(ctx: Ctx, placed: Res[]): void {
  const vocab = ctx.vocab, scales = new Set(vocab.scales.map((s) => s.id)), cultures = new Set(vocab.cultures.map((c) => c.id));
  const sp = ctx.input.plan.space;
  if (sp?.scale && !scales.has(sp.scale)) warn(ctx, "", "unknown-scale", `space.scale "${sp.scale}" is not in the vocabulary (${[...scales].join(", ")})`);
  for (const c of sp?.cultures ?? []) if (!cultures.has(c)) warn(ctx, "", "unknown-culture", `space culture "${c}" is not in the vocabulary (${[...cultures].join(", ")})`);
  const undeclared = new Map<string, string[]>();
  for (const r of placed) {
    const rules = roomRules(ctx, r.room), d = r.data;
    if (rules.scale) {
      if (!d.scale) (undeclared.get("scale") ?? undeclared.set("scale", []).get("scale")!).push(r.work.prop);
      else if (!scaleFits(vocab, rules.scale, d.scale))
        vio(ctx, r.work.id, "wrong-scale", `${r.work.prop} is ${d.scale}-scale but ${r.room ? `room ${r.room}` : "this place"} is ${rules.scale}-scale: pick a ${rules.scale} or any-scale prop (props menu --scale ${rules.scale})`);
    }
    if (rules.cultures.length) {
      if (!d.cultures) (undeclared.get("cultures") ?? undeclared.set("cultures", []).get("cultures")!).push(r.work.prop);
      else if (!cultureFits(vocab, rules.cultures, d.cultures))
        vio(ctx, r.work.id, "wrong-culture",
          `${r.work.prop} belongs to ${d.cultures.join("/") || "no culture"} but ${r.room ? `room ${r.room}` : "this place"} is ${rules.cultures.join("/")}: pick a prop of its people (props menu --culture ${rules.cultures[0]})`);
    }
  }
  for (const [k, list] of undeclared)
    warn(ctx, "", `${k === "scale" ? "scale" : "culture"}-undeclared`, `${[...new Set(list)].join(", ")} declare${list.length === 1 ? "s" : ""} no ${k} (catalogue it: docs/prop-cataloging.md); this place declares one`);
  // set pieces: the one thing allowed in the middle, one per room (two in a great hall)
  const pieces = new Map<string, string[]>();
  for (const r of placed) if (r.floor && r.room && (r.data.centrepiece || r.work.setPiece)) (pieces.get(r.room) ?? pieces.set(r.room, []).get(r.room)!).push(r.work.id);
  for (const [room, ids] of pieces) {
    const area = ctx.input.map.levels.flatMap((l) => l.rooms).find((x) => x.id === room)?.area ?? 0;
    const cap = area >= 300 ? 2 : 1;
    const ids2 = [...new Set(ids.map((id) => id.split("/")[0]))];
    if (ids2.length > cap) warn(ctx, room, "set-pieces", `room ${room} has ${ids2.length} set pieces (${ids2.join(", ")}); a room has ${cap}: one thing holds the middle`);
  }
}

function reviewRooms(ctx: Ctx, placed: Res[]): DressingRoomReview[] {
  const out: DressingRoomReview[] = [];
  const vioBy = (code: string, room: string): number =>
    ctx.violations.filter((v) => v.code === code && placed.some((r) => r.work.id === v.item && r.room === room)).length;
  for (const [level, g] of ctx.grids) {
    const z = ctx.zones.get(level)!, cellA = g.step * g.step;
    for (const room of g.lv.rooms) {
      const here = placed.filter((r) => r.level === level && r.room === room.id && (r.data.mount === "floor" || r.data.mount === "wall" || r.data.mount === "ceiling"));
      const furniture = here.filter((r) => r.floor || r.data.mount === "wall");
      // against a wall: backed on / hung on a wall face, or (a noised cave with no straight walls) standing within EDGE_REACH of the room edge
      const nearEdge = (r: Res): boolean => !!r.floor && g.cells(r.floor).some(([c, rr]) => g.inside(c, rr) && z.dist[rr * g.lv.columns + c]! <= EDGE_REACH);
      const walled = furniture.filter((r) => r.onWall || nearEdge(r)).length;
      const centreM2 = (z.cells.get(room.id) ?? 0) * cellA;
      const centreItems: string[] = [];
      let covered = 0;
      const solid = here.filter((r) => r.floor);
      const seen = new Set<number>();
      for (const r of solid) {
        if (r.data.centrepiece || r.work.setPiece) continue;
        let hit = false;
        for (const [c, rr] of g.cells(r.floor!)) {
          if (!g.inside(c, rr) || z.centre[rr * g.lv.columns + c] !== room.index + 1) continue;
          hit = true;
          const k = rr * g.lv.columns + c;
          if (!seen.has(k)) (seen.add(k), covered++);
        }
        if (hit) centreItems.push(r.work.id);
      }
      const centreCover = centreM2 > 0 ? (covered * cellA) / centreM2 : 0;
      const itemShare = solid.length ? centreItems.length / solid.length : 0;
      out.push({
        room: room.id,
        level,
        role: ctx.input.plan.rooms[room.id]?.role ?? "",
        area: room.area,
        items: here.length,
        furniture: furniture.length,
        wallShare: furniture.length ? +(walled / furniture.length).toFixed(2) : 1,
        centreM2: +centreM2.toFixed(1),
        centreItems,
        centreCover: +centreCover.toFixed(2),
        centreClutter: Math.round(100 * Math.min(1, itemShare * 0.6 + Math.min(1, centreCover * 4) * 0.4)),
        scaleViolations: vioBy("wrong-scale", room.id),
        cultureViolations: vioBy("wrong-culture", room.id),
        keepCentre: roomRules(ctx, room.id).keepCentre,
      });
    }
  }
  return out;
}

export function resolveDressing(input: DressingResolveInput): DressingResolveResult {
  const o = input.options ?? {};
  const dungeon = input.plan.space?.kind === "dungeon";
  const ctx: Ctx = {
    input,
    opts: {
      hardBuffer: o.hardBuffer ?? (dungeon ? 1.0 : 0.6),
      warnBuffer: o.warnBuffer ?? (dungeon ? 1.6 : 1.1),
      laneWidth: o.laneWidth ?? DEFAULT_LANE_WIDTH,
      maxCover: o.maxCover,
      looseBudget: o.looseBudget ?? defaultLooseBudget,
      flames: o.flames ?? 4,
      flamesLargeHall: o.flamesLargeHall ?? 6,
      minItems: o.minItems ?? defaultMinItems,
      pathMargin: o.pathMargin ?? (dungeon ? DUNGEON_PATH_MARGIN : 0),
    },
    grids: new Map(),
    walls: new Map(),
    violations: [],
    warnings: [],
    autos: [],
    vocab: input.vocabulary ?? mergeVocabulary(),
    dungeon,
    zones: new Map(),
    obst: [],
  };
  for (const lv of input.map.levels) {
    if (ctx.grids.has(lv.level)) vio(ctx, "", "map-invalid", `map "${input.map.id}" has level ${lv.level} twice`);
    ctx.grids.set(lv.level, new Grid(lv));
    for (const w of lv.walls) ctx.walls.set(w.id, { wall: w, level: lv.level });
  }
  for (const [level, g] of ctx.grids) ctx.zones.set(level, zonesFor(g));
  ctx.obst = obstaclesOf(ctx);

  // 1. Expand sets into a flat work list.
  const works: Work[] = [];
  const setAnchor = new Map<string, string>();
  for (const item of input.plan.items) {
    if (item.prop) {
      works.push({ id: item.id, prop: item.prop, place: item.place, group: "", ...(item.setPiece ? { setPiece: true } : {}) });
      continue;
    }
    const set = input.set(item.set);
    if (!set) {
      vio(ctx, item.id, "no-set", `dressing set "${item.set}" does not exist (authoring/dressing/sets/${item.set}.json)`);
      continue;
    }
    const [anchor, ...members] = set.items;
    if (!anchor?.prop) {
      vio(ctx, item.id, "no-set", `set "${set.id}" needs a single-prop anchor as items[0]`);
      continue;
    }
    const aid = `${item.id}/${anchor.id}`;
    setAnchor.set(item.id, aid);
    works.push({ id: aid, prop: anchor.prop, place: item.place, group: item.id, ...(item.mirror !== undefined ? { mirror: item.mirror } : {}), ...(item.setPiece ? { setPiece: true } : {}) });
    for (const m of members) {
      const id = `${item.id}/${m.id}`;
      if (m.set || !m.prop) {
        vio(ctx, id, "set-place", `set "${set.id}" member ${m.id} must be a single prop`);
        continue;
      }
      let place: WorkPlace;
      if (m.place.kind === "floor")
        place = item.mirror ? { kind: "rel", host: aid, at: [-m.place.at[0], m.place.at[1]], yaw: -m.place.yaw } : { kind: "rel", host: aid, at: m.place.at, yaw: m.place.yaw };
      else if (m.place.kind === "on") place = { ...m.place, item: `${item.id}/${m.place.item}` };
      else {
        vio(ctx, id, "set-place", `set "${set.id}" member ${m.id} uses a \`${m.place.kind}\` place; members use \`floor\` (relative to the anchor) or \`on\` (a sibling)`);
        continue;
      }
      works.push({ id, prop: m.prop, place, group: item.id, ...(item.setPiece ? { setPiece: true } : {}) });
    }
  }
  // A plan item `on` a set item lands on the set's anchor piece.
  const ids = new Set(works.map((w) => w.id));
  for (const w of works) if (w.place.kind === "on" && !ids.has(w.place.item) && setAnchor.has(w.place.item)) w.place = { ...w.place, item: setAnchor.get(w.place.item)! };

  // 2. Declarations and mount agreement.
  const ok = new Map<string, DressingData>();
  for (const w of works) {
    const data = input.prop(w.prop);
    if (!data) {
      vio(ctx, w.id, "no-prop", `"${w.prop}" has no \`dressing\` declaration on its prefab root (or the prefab does not exist); catalogue it first (docs/prop-cataloging.md)`);
      continue;
    }
    const anchor = w.place.kind === "anchor" ? input.map.anchors.find((a) => a.id === (w.place as { anchor: string }).anchor) : undefined;
    const anchorMount = anchor?.mount;
    if (data.anchorKinds.length) {
      // A flame-and-light fixture has no mesh: on a bare wall or floor it is a fire floating in the air.
      const kinds = data.anchorKinds.join("/");
      if (w.place.kind !== "anchor") {
        const here = input.map.anchors.filter((a) => data.anchorKinds.includes(a.kind)).map((a) => a.id);
        vio(ctx, w.id, "anchor-only",
          `${w.prop} is flame and light only (no mesh of its own): it fills a building's own ${kinds} and goes ONLY on a ${kinds} anchor ({ kind: "anchor", anchor }), never ${placeName(w.place)}; ` +
            (here.length ? `this map's ${kinds} anchors: ${here.join(", ")}` : `this map has no ${kinds} anchor, so leave it out or use a lit prop with its own mesh (candle, lamp, candelabra, chandelier)`));
        continue;
      }
      if (anchor && !data.anchorKinds.includes(anchor.kind)) {
        vio(ctx, w.id, "anchor-only", `${w.prop} fills only ${kinds} anchors, but anchor "${anchor.id}" is a ${anchor.kind}`);
        continue;
      }
    }
    const why = mountRefusal(data, w.place, anchorMount, w.prop);
    if (why) vio(ctx, w.id, data.mount === "part" ? "part" : "mount-mismatch", why);
    else ok.set(w.id, data);
  }

  // 3. Direct places, then dependents breadth-first from their hosts; then `auto` items in plan order, each finding a spot
  //    clear of everything resolved before it (explicit items always stand first: they are fixed).
  const out = new Map<string, Res>();
  const kids = new Map<string, Work[]>();
  const autos: Work[] = [];
  for (const w of works) {
    const data = ok.get(w.id);
    if (!data) continue;
    if (w.place.kind === "on" || w.place.kind === "rel") {
      const host = w.place.kind === "on" ? w.place.item : w.place.host;
      (kids.get(host) ?? kids.set(host, []).get(host)!).push(w);
      continue;
    }
    if (w.place.kind === "auto") {
      autos.push(w);
      continue;
    }
    const r = resolveDirect(ctx, w, data);
    if (r) out.set(w.id, r);
  }
  const visited = new Set<string>();
  const spread = (queue: string[]): void => {
    while (queue.length) {
      const hid = queue.shift()!;
      if (visited.has(hid)) continue;
      visited.add(hid);
      const host = out.get(hid), list = kids.get(hid);
      if (!host || !list) continue;
      for (const w of list.filter((x) => x.place.kind === "rel")) {
        const r = resolveRel(ctx, w, ok.get(w.id)!, host, w.place as RelPlace);
        if (r) out.set(w.id, r);
      }
      const on = list.filter((x) => x.place.kind === "on");
      if (on.length) resolveChildren(ctx, host, on, out);
      for (const w of list) if (out.has(w.id)) queue.push(w.id);
    }
  };
  spread([...out.keys()]);
  for (const w of autos) {
    const data = ok.get(w.id)!;
    const members: AutoMember[] = (kids.get(w.id) ?? [])
      .filter((m) => m.place.kind === "rel" && ok.has(m.id))
      .map((m) => ({ w: m, data: ok.get(m.id)!, place: m.place as RelPlace }));
    if (!resolveAuto(ctx, w, data, members, out, setAnchor)) continue;
    const r = resolveDirect(ctx, w, data);
    if (!r) continue;
    out.set(w.id, r);
    spread([w.id]);
  }
  // Dependents never reached: missing host, failed host, or a cycle.
  const reported = new Set(ctx.violations.map((v) => v.item));
  // hosts first: a dependent of a dependent that failed is "host-unresolved", not a cycle
  const unplaced = [...kids].flatMap(([hid, list]) => list.map((w) => ({ hid, w }))).filter(({ w }) => !out.has(w.id) && !reported.has(w.id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const { hid, w } of unplaced) {
      if (reported.has(w.id)) continue;
      if (!ids.has(hid)) vio(ctx, w.id, "no-host", `"${hid}" is not an item in this plan; \`on\` must name a plan item, a set item or a member of the same set`);
      else if (visited.has(hid) || !ok.has(hid) || reported.has(hid)) vio(ctx, w.id, "host-unresolved", `its host "${hid}" could not be placed; fix the host first`);
      else continue;
      reported.add(w.id);
      changed = true;
    }
  }
  for (const { hid, w } of unplaced)
    if (!reported.has(w.id)) vio(ctx, w.id, "cycle", `"${w.id}" and "${hid}" rest on each other (a cycle of \`on\` places); one of them must stand on the floor, a wall or the ceiling`);

  const placed = works.map((w) => out.get(w.id)).filter((r): r is Res => !!r);
  pairChecks(ctx, placed);
  obstacleChecks(ctx, placed);
  routeCheck(ctx, placed);
  planChecks(ctx, placed);
  placeChecks(ctx, placed);
  const review = reviewRooms(ctx, placed);

  const placements: DressingPlacement[] = [];
  for (const r of placed) {
    placements.push({
      id: r.work.id,
      prop: r.work.prop,
      level: r.level,
      room: r.room,
      position: [+r.origin[0].toFixed(4), +r.origin[1].toFixed(4), +r.origin[2].toFixed(4)],
      yaw: +r.box.yaw.toFixed(6),
    });
    placements.push(...r.chain);
  }
  return { placements, ...(ctx.autos.length ? { auto: ctx.autos } : {}), violations: ctx.violations, warnings: ctx.warnings, review };
}

// ---------------------------------------------------------------------------
// Circulation mask: the walking paths reserved BEFORE anything is placed
// ---------------------------------------------------------------------------

/**
 * The spine rule: no free floor of a room may be more than this many metres of open walking from a path or a
 * keep-clear zone (entry lane, stair zone, hearth clearance). A room that fails gets a SPINE first: a straight path
 * down its long axis through its centre, ending SPINE_TRIM m short of each end (a bed's length stays free at the end walls), joined to the network (skipped when a path already
 * runs most of it); then, while any floor is still more than `reach` (+ SPINE_TRIM once a spine is drawn) away, a spur
 * toward the furthest point, ending within `reach - 1` m of it (an L-shaped hall, a long wing). A room up to ~9 m across usually needs only its door/stair paths; a larger hall gets its spine.
 */
export const CIRCULATION_REACH = 4.5;
/** How far short of the room's ends (of the lane run) a spine stops, metres. */
const SPINE_TRIM = 2.0;
/** A turn costs this many cells of straight run (1.5 m at 0.25 m cells), so paths run straight along the room's axes. */
const TURN_COST = 6;
/** Metres beyond the lane radius inside which a path pays extra to run: it keeps a band along the walls for furniture. */
const WALL_SHY = 0.75;
const DIR4: readonly V2[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export interface CirculationOptions {
  /** Path width; default `DEFAULT_LANE_WIDTH`, the same lane the resolver demands. */
  laneWidth?: number;
  /** The spine rule's distance; default `CIRCULATION_REACH`. */
  reach?: number;
}

export interface RoomFloor {
  room: string;
  level: number;
  /** The room's free floor, m² (the map's `area`). */
  area: number;
  /** What is left for SOLID props after paths ('x') and keep-clear zones: its '.' and 'o' cells, m². */
  placeable: number;
}

/** Per room of a level: free floor and what is left of it for solid props once paths and keep-clear zones are out. */
export function placeableFloor(lv: SocketLevel): RoomFloor[] {
  const counts = new Map<number, number>();
  for (let r = 0; r < lv.rows; r++)
    for (let c = 0; c < lv.columns; c++) {
      const ch = lv.cells[r]?.[c], rm = lv.room[r]?.[c];
      if ((ch === "." || ch === "o") && rm !== undefined && rm !== ".") {
        const idx = parseInt(rm, 36);
        counts.set(idx, (counts.get(idx) ?? 0) + 1);
      }
    }
  return lv.rooms.map((room) => ({ room: room.id, level: lv.level, area: room.area, placeable: +((counts.get(room.index) ?? 0) * lv.step * lv.step).toFixed(2) }));
}

/** Min-heap of (cost, id), ties broken by id so every run expands in the same order. */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.v.length;
  }
  private less(i: number, j: number): boolean {
    return this.k[i]! < this.k[j]! || (this.k[i] === this.k[j] && this.v[i]! < this.v[j]!);
  }
  private swap(i: number, j: number): void {
    [this.k[i], this.k[j]] = [this.k[j]!, this.k[i]!];
    [this.v[i], this.v[j]] = [this.v[j]!, this.v[i]!];
  }
  push(key: number, val: number): void {
    this.k.push(key);
    this.v.push(val);
    for (let i = this.v.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const out: [number, number] = [this.k[0]!, this.v[0]!];
    const lk = this.k.pop()!, lv = this.v.pop()!;
    if (this.v.length) {
      this.k[0] = lk;
      this.v[0] = lv;
      for (let i = 0; ; ) {
        const a = 2 * i + 1, b = a + 1;
        let m = i;
        if (a < this.v.length && this.less(a, m)) m = a;
        if (b < this.v.length && this.less(b, m)) m = b;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return out;
  }
}

/**
 * Reserve the walking paths of every level of a socket map (its circulation mask) and return the new map; the input
 * is not changed. Per level, from the outside door's entry lane (ground floor) or the stair head (upper floors), a
 * path runs to every doorway, every stair approach/foot, the hearth's clear zone and into every room, then the spine
 * rule (`CIRCULATION_REACH`) adds paths into large rooms. A path's centre line keeps the lane radius from walls,
 * runs on 4-neighbour steps with a turn penalty (straight runs along the room's axes) and pays to hug a wall;
 * targets are taken nearest-first and each new path leaves the network already drawn. Its cells are every cell the
 * lane's body (width `laneWidth`) overlaps: free floor there becomes 'x'; keep-clear cells keep their code.
 * Deterministic: the same map gives the same paths.
 */
export function circulate(input: SocketMap, options: CirculationOptions = {}): { map: SocketMap; notes: string[] } {
  const laneWidth = options.laneWidth ?? DEFAULT_LANE_WIDTH, reach = options.reach ?? CIRCULATION_REACH, radius = laneWidth / 2;
  const map: SocketMap = structuredClone(input);
  const notes: string[] = [];
  const lowest = Math.min(...map.levels.map((l) => l.level));
  for (const lv of map.levels) {
    const C = lv.columns, R = lv.rows, N = C * R, step = lv.step;
    const cs = lv.cells.join("").replaceAll("x", ".").split("");
    const roomIdx = lv.room.join("").split("").map((ch) => (ch === "." ? -1 : parseInt(ch, 36)));
    const inside = (c: number, r: number): boolean => c >= 0 && r >= 0 && c < C && r < R;
    const centre = (k: number): V2 => [lv.origin[0] + ((k % C) + 0.5) * step, lv.origin[1] + (Math.floor(k / C) + 0.5) * step];
    const walk = (k: number): boolean => WALKABLE.has(cs[k]!);
    const offs = laneOffsets(step, radius);
    // Lane centres: the centre's disc of cells is walkable (as the resolver's lane), and not on the steps themselves.
    const pass = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      if (cs[k] === "S" || cs[k] === "W" || !walk(k)) continue;
      const c = k % C, r = (k - c) / C;
      pass[k] = offs.every(([dc, dr]) => inside(c + dc, r + dr) && walk((r + dr) * C + c + dc)) ? 1 : 0;
    }
    // Body: every cell the lane's disc overlaps (not just its centre), so a prop clear of 'x' never narrows the lane.
    const nb = Math.ceil(radius / step) + 1, bodyOffs: V2[] = [];
    for (let dr = -nb; dr <= nb; dr++)
      for (let dc = -nb; dc <= nb; dc++)
        if (Math.hypot(Math.max(Math.abs(dc) - 0.5, 0), Math.max(Math.abs(dr) - 0.5, 0)) * step < radius - 1e-9) bodyOffs.push([dc, dr]);
    // Distance to the nearest non-walkable cell (only near walls matters) -> the cost of running beside a wall.
    const shy = radius + WALL_SHY, nw = Math.ceil(shy / step) + 1, cost = new Float64Array(N).fill(1);
    for (let k = 0; k < N; k++) {
      if (!pass[k]) continue;
      const c = k % C, r = (k - c) / C;
      let d = Infinity;
      for (let dr = -nw; dr <= nw; dr++)
        for (let dc = -nw; dc <= nw; dc++) if (!inside(c + dc, r + dr) || !walk((r + dr) * C + c + dc)) d = Math.min(d, Math.hypot(dc, dr) * step);
      if (d < shy) cost[k] = 1 + ((shy - d) / step) * 0.3;
    }
    const comps = (want: (ch: string) => boolean): number[][] => {
      const seen = new Uint8Array(N), out: number[][] = [];
      for (let k = 0; k < N; k++) {
        if (seen[k] || !want(cs[k]!)) continue;
        const comp: number[] = [], st = [k];
        seen[k] = 1;
        while (st.length) {
          const q = st.pop()!, qc = q % C, qr = (q - qc) / C;
          comp.push(q);
          for (const [dc, dr] of DIR4) {
            const nk = (qr + dr) * C + qc + dc;
            if (inside(qc + dc, qr + dr) && !seen[nk] && want(cs[nk]!)) {
              seen[nk] = 1;
              st.push(nk);
            }
          }
        }
        out.push(comp.sort((a, b) => a - b));
      }
      return out;
    };
    const cellOf = (x: number, z: number): number => {
      const c = Math.floor((x - lv.origin[0]) / step), r = Math.floor((z - lv.origin[1]) / step);
      return inside(c, r) ? r * C + c : -1;
    };
    const bodyMask = (cells: number[]): Uint8Array => {
      const m = new Uint8Array(N);
      for (const k of cells) {
        const c = k % C, r = (k - c) / C;
        for (const [dc, dr] of offs) {
          const nk = (r - dr) * C + c - dc;
          if (inside(c - dc, r - dr) && pass[nk]) m[nk] = 1;
        }
      }
      return m;
    };
    const centreMask = (cells: number[]): Uint8Array => {
      const m = new Uint8Array(N);
      let any = false;
      for (const k of cells)
        if (pass[k]) {
          m[k] = 1;
          any = true;
        }
      return any ? m : bodyMask(cells);
    };

    // The network starts at the door (ground floor) or where the stair arrives (upper floors).
    const net = new Uint8Array(N), body = new Uint8Array(N);
    let netCount = 0;
    /** Join a cell to the network; a path cell also reserves its body (a start zone, already kept clear, does not). */
    const addNet = (k: number, withBody = true): void => {
      if (!net[k]) netCount++;
      net[k] = 1;
      if (!withBody) return;
      const c = k % C, r = (k - c) / C;
      for (const [dc, dr] of bodyOffs) if (inside(c + dc, r + dr)) body[(r + dr) * C + c + dc] = 1;
    };
    const aComps = comps((ch) => ch === "A");
    const sourceComps = new Set<number>();
    let origin: string;
    if (lv.level === lowest) {
      origin = "the door";
      for (let k = 0; k < N; k++) if (cs[k] === "E" && pass[k]) addNet(k, false);
      const e = map.entry;
      if (e) {
        const s = cellOf(e.position[0] + e.facing[0] * 0.5, e.position[1] + e.facing[1] * 0.5);
        let best = -1, bd = Infinity;
        const n = Math.ceil(1.5 / step);
        if (s >= 0)
          for (let dr = -n; dr <= n; dr++)
            for (let dc = -n; dc <= n; dc++) {
              const c = (s % C) + dc, r = Math.floor(s / C) + dr, k = r * C + c;
              if (inside(c, r) && pass[k] && dc * dc + dr * dr < bd) [best, bd] = [k, dc * dc + dr * dr];
            }
        if (best >= 0) addNet(best, false);
      }
    } else {
      origin = "the stair head";
      const heads = map.anchors.filter((a) => a.level === lv.level && a.kind === "stair-head").map((a) => cellOf(a.position[0], a.position[2]));
      aComps.forEach((comp, i) => {
        if (heads.some((h) => comp.includes(h))) sourceComps.add(i);
      });
      if (!sourceComps.size) aComps.forEach((_, i) => sourceComps.add(i));
      for (const i of sourceComps) for (const k of aComps[i]!) if (pass[k]) addNet(k, false);
      if (!aComps.length) {
        // No marked stair zones: start beside the first stair flight.
        const m = bodyMask(comps((ch) => ch === "S")[0] ?? []);
        for (let k = 0; k < N; k++) if (m[k]) addNet(k, false);
      }
    }
    const paths: SocketLevel["paths"] = [];
    if (!netCount) {
      notes.push(`level ${lv.level}: no ${origin} to start paths from (no entry lane or stair zone a ${f2(laneWidth)} m lane fits); no paths reserved`);
      lv.paths = [];
      continue;
    }

    /** Cheapest straight-preferring route from the network to any cell of `mask`; the cells from the join to the end. */
    const route = (mask: Uint8Array): number[] | undefined => {
      const dist = new Float64Array(N * 4).fill(Infinity), prev = new Int32Array(N * 4).fill(-1), heap = new Heap();
      for (let k = 0; k < N; k++)
        if (net[k])
          for (let d = 0; d < 4; d++) {
            dist[k * 4 + d] = 0;
            heap.push(0, k * 4 + d);
          }
      while (heap.size) {
        const [dk, s] = heap.pop();
        if (dk > dist[s]!) continue;
        const k = s >> 2, d = s & 3;
        if (mask[k] && !net[k]) {
          const out: number[] = [];
          for (let q = s; q >= 0; q = prev[q]!) out.push(q >> 2);
          return out.reverse();
        }
        const c = k % C, r = (k - c) / C;
        for (let nd = 0; nd < 4; nd++) {
          const [dc, dr] = DIR4[nd]!, nc = c + dc, nr = r + dr, nk = nr * C + nc;
          if (!inside(nc, nr) || !pass[nk] || net[nk]) continue;
          const ns = nk * 4 + nd, v = dk + cost[nk]! + (nd === d ? 0 : TURN_COST);
          if (v < dist[ns]! - 1e-9) {
            dist[ns] = v;
            prev[ns] = s;
            heap.push(v, ns);
          }
        }
      }
      return undefined;
    };
    const addPath = (name: string, cells: number[]): void => {
      for (const k of cells) addNet(k);
      // Centre line: its start, every turn, its end.
      const pts: V2[] = [];
      cells.forEach((k, i) => {
        if (i === 0 || i === cells.length - 1 || k - cells[i - 1]! !== cells[i + 1]! - k) pts.push(centre(k));
      });
      paths.push({ id: `L${lv.level}-p${paths.length + 1}`, name, width: laneWidth, points: pts.map(([x, z]) => [+x.toFixed(3), +z.toFixed(3)] as V2) });
    };
    const roomName = (idx: number): string => lv.rooms.find((r) => r.index === idx)?.id ?? "";

    // Targets: doorways, stair approaches/feet, the hearth's clear zone (a stair flight itself when no zone is marked).
    interface Target {
      name: string;
      /** Added to the name when two targets would read the same. */
      at?: string;
      mask: Uint8Array;
      done: boolean;
    }
    const targets: Target[] = [];
    for (const comp of comps((ch) => ch === "D")) {
      const rooms = new Set<number>();
      for (const k of comp) {
        const c = k % C, r = (k - c) / C;
        for (let dr = -3; dr <= 3; dr++)
          for (let dc = -3; dc <= 3; dc++) if (inside(c + dc, r + dr) && roomIdx[(r + dr) * C + c + dc]! >= 0) rooms.add(roomIdx[(r + dr) * C + c + dc]!);
      }
      const ids = [...rooms].sort((a, b) => a - b).map(roomName).filter(Boolean);
      targets.push({ name: ids.length > 1 ? `the doorway between ${ids.join(" and ")}` : `the doorway${ids[0] ? ` into ${ids[0]}` : ""}`, mask: centreMask(comp), done: false });
    }
    const stairTargets = aComps.filter((_, i) => !sourceComps.has(i));
    for (const comp of stairTargets) {
      const kinds = map.anchors.filter((a) => a.level === lv.level && STAIR_MARKS.has(a.kind) && comp.includes(cellOf(a.position[0], a.position[2]))).map((a) => a.kind);
      const what = kinds.includes("stair-foot") ? "the foot of the stair" : kinds.includes("stair-approach") ? "the stair approach" : kinds.includes("stair-head") ? "the top of the stair" : "the stair";
      const [x, z] = centre(comp[Math.floor(comp.length / 2)]!);
      targets.push({ name: what, mask: centreMask(comp), done: false, at: at2(x, z) });
    }
    if (!aComps.length && lv.level === lowest) for (const comp of comps((ch) => ch === "S")) targets.push({ name: "the stair", mask: bodyMask(comp), done: false });
    const hearths = comps((ch) => ch === "H");
    for (const comp of hearths) {
      const [x, z] = centre(comp[Math.floor(comp.length / 2)]!);
      targets.push({ name: hearths.length > 1 ? `the hearth at ${at2(x, z)}` : "the hearth", mask: bodyMask(comp), done: false });
    }
    for (const t of targets) if (t.at && targets.some((o) => o !== t && o.name === t.name)) t.name += ` at ${t.at}`;
    const sweep = (): void => {
      for (const t of targets) if (!t.done && t.mask.some((v, k) => v === 1 && net[k] === 1)) t.done = true;
    };
    sweep();
    for (;;) {
      const open = targets.filter((t) => !t.done);
      if (!open.length) break;
      const union = new Uint8Array(N);
      for (const t of open) for (let k = 0; k < N; k++) if (t.mask[k]) union[k] = 1;
      const cells = route(union);
      if (!cells) {
        for (const t of open) notes.push(`level ${lv.level}: no ${f2(laneWidth)} m path reaches ${t.name} (map geometry)`);
        break;
      }
      const end = cells[cells.length - 1]!, t = open.find((x) => x.mask[end])!;
      addPath(`the way from ${origin} to ${t.name}`, cells);
      t.done = true;
      sweep();
    }

    // Every room is entered by a path.
    const roomCells = new Map<number, number[]>();
    for (let k = 0; k < N; k++) {
      const idx = roomIdx[k]!;
      if (idx >= 0 && walk(k)) (roomCells.get(idx) ?? roomCells.set(idx, []).get(idx)!).push(k);
    }
    const rooms = [...lv.rooms].sort((a, b) => a.index - b.index);
    for (const room of rooms) {
      const cells = roomCells.get(room.index) ?? [];
      if (!cells.length || cells.some((k) => body[k] || net[k])) continue;
      const mask = new Uint8Array(N);
      for (const k of cells) if (pass[k]) mask[k] = 1;
      const got = mask.some((v) => v === 1) ? route(mask) : undefined;
      if (got) addPath(`the way from ${origin} into ${room.id}`, got);
      else notes.push(`level ${lv.level}: no ${f2(laneWidth)} m path enters room ${room.id} (map geometry)`);
    }

    // The spine rule: no free floor further than `reach` metres of open walking from a path.
    const geodesic = (seeds: number[]): Float64Array => {
      const d = new Float64Array(N).fill(Infinity), heap = new Heap();
      for (const k of seeds) {
        d[k] = 0;
        heap.push(0, k);
      }
      while (heap.size) {
        const [dk, k] = heap.pop();
        if (dk > d[k]!) continue;
        const c = k % C, r = (k - c) / C;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++) {
            if (!dc && !dr) continue;
            const nc = c + dc, nr = r + dr, nk = nr * C + nc;
            if (!inside(nc, nr) || !walk(nk)) continue;
            if (dc && dr && (!walk(r * C + nc) || !walk(nr * C + c))) continue; // no corner cutting past a wall
            const v = dk + (dc && dr ? Math.SQRT2 : 1) * step;
            if (v < d[nk]! - 1e-9) {
              d[nk] = v;
              heap.push(v, nk);
            }
          }
      }
      return d;
    };
    /** The room's long axis through its centre: the longest lane run on a line within 1 m of the centre, SPINE_TRIM short of each end. */
    const spineOf = (room: SocketLevel["rooms"][number]): number[] | undefined => {
      const [x0, x1, z0, z1] = room.bbox, alongX = x1 - x0 >= z1 - z0, k0 = cellOf(room.centre[0], room.centre[1]);
      if (k0 < 0) return undefined;
      const c0 = k0 % C, r0 = (k0 - c0) / C, span = Math.round(1 / step), trim = Math.round(SPINE_TRIM / step);
      let best: number[] = [];
      for (let i = 0; i <= 2 * span; i++) {
        const o = i % 2 ? (i + 1) / 2 : -i / 2; // 0, 1, -1, 2, -2 ...
        let run: number[] = [];
        const len = alongX ? C : R;
        for (let j = 0; j <= len; j++) {
          const c = alongX ? j : c0 + o, r = alongX ? r0 + o : j, k = r * C + c;
          if (j < len && inside(c, r) && pass[k] && roomIdx[k] === room.index) run.push(k);
          else {
            if (run.length > best.length) best = run;
            run = [];
          }
        }
      }
      const trimmed = best.slice(trim, best.length - trim);
      return trimmed.length * step >= 2 ? trimmed : undefined;
    };
    for (const room of rooms) {
      const cells = (roomCells.get(room.index) ?? []).filter((k) => cs[k] === "." || cs[k] === "o");
      let limit = reach;
      for (let round = 0; round < 8; round++) {
        const seeds: number[] = [];
        for (let k = 0; k < N; k++) if ((body[k] && walk(k)) || net[k] || cs[k] === "E" || cs[k] === "A" || cs[k] === "H") seeds.push(k);
        const d = geodesic(seeds);
        let far = -1;
        for (const k of cells) if (!body[k] && Number.isFinite(d[k]!) && (far < 0 || d[k]! > d[far]! + 1e-9)) far = k;
        if (far < 0 || d[far]! <= limit + 1e-9) break;
        if (round === 0) {
          // First a spine down the room's long axis, unless a path already runs most of it.
          const sp = spineOf(room);
          if (sp && sp.filter((k) => body[k]).length * 2 < sp.length) {
            const mask = new Uint8Array(N);
            for (const k of sp) mask[k] = 1;
            const conn = sp.some((k) => net[k]) ? [] : route(mask);
            if (conn) {
              if (conn.length > 1) addPath(`the way from ${origin} to the walk through ${room.id}`, conn);
              addPath(`the walk through ${room.id}`, sp);
              limit = reach + SPINE_TRIM; // the spine stops short of the ends on purpose: no stubs into its corners
              continue;
            }
          }
        }
        const back = geodesic([far]), mask = new Uint8Array(N);
        for (let k = 0; k < N; k++) if (pass[k] && back[k]! <= Math.max(reach - 1, 0.5) + 1e-9) mask[k] = 1;
        const got = mask.some((v) => v === 1) ? route(mask) : undefined;
        if (!got) {
          const [x, z] = centre(far);
          notes.push(`level ${lv.level}: room ${room.id}'s floor at ${at2(x, z)} is ${f2(d[far]!)} m from a path and no ${f2(laneWidth)} m path can get nearer (a nook)`);
          break;
        }
        addPath(`the walk through ${room.id}`, got);
      }
    }

    for (let k = 0; k < N; k++) if (body[k] && (cs[k] === "." || cs[k] === "o")) cs[k] = "x";
    lv.cells = Array.from({ length: R }, (_, r) => cs.slice(r * C, (r + 1) * C).join(""));
    lv.paths = paths;
    const reserved = cs.filter((ch) => ch === "x").length * step * step;
    notes.push(`level ${lv.level}: ${paths.length} path${paths.length === 1 ? "" : "s"}, ${f2(reserved)} m² of floor reserved`);
    for (const f of placeableFloor(lv))
      notes.push(
        `  room ${f.room}: ${f.placeable <= EPS ? "NOTHING placeable (only paths and keep-clear floor): wall, hung, ceiling items and rugs only" : `${f2(f.placeable)} m² placeable`} of ${f2(f.area)} m² free floor`,
      );
  }
  return { map, notes };
}

// ---------------------------------------------------------------------------
// Designer-facing summaries: free wall stretches and set shapes, in words
// ---------------------------------------------------------------------------

/**
 * Stretches of a wall a wall-backed floor piece can stand against: solid wall behind (a span) AND placeable floor
 * ('.', 'o' of the wall's room) in front, `depth` metres deep. [t0, t1] in metres from the wall's `a`, which is its
 * LEFT end as seen from inside the room facing the wall. Sampled every 0.05 m.
 */
export function standStretches(lv: SocketLevel, wall: SocketWall, depth = 0.5): [number, number][] {
  const g = new Grid(lv), { u, len } = wallFrame(wall), roomIdx = lv.rooms.find((r) => r.id === wall.room)?.index;
  const ok = (t: number): boolean => {
    if (!wall.spans.some(([a, b]) => t >= a - EPS && t <= b + EPS)) return false;
    const px = wall.a[0] + u[0] * t, pz = wall.a[1] + u[1] * t;
    for (let d = 0.08; d <= depth + EPS; d += 0.12) {
      const [c, r] = g.cellOf(px + wall.normal[0] * d, pz + wall.normal[1] * d), ch = g.ch(c, r);
      if (ch === "#" && d < g.step + 0.05) continue; // the face may sit inside the first wall cell
      if (ch !== "." && ch !== "o") return false;
      const rm = lv.room[r]?.[c];
      if (roomIdx !== undefined && (rm === undefined || parseInt(rm, 36) !== roomIdx)) return false;
    }
    return true;
  };
  const out: [number, number][] = [];
  let start = -1;
  const S = 0.05, n = Math.floor(len / S + EPS);
  for (let i = 0; i <= n + 1; i++) {
    const t = Math.min(i * S, len), good = i <= n && ok(t);
    if (good && start < 0) start = t;
    if (!good && start >= 0) {
      const end = Math.min((i - 1) * S, len);
      if (end - start >= 0.3 - EPS) out.push([+start.toFixed(2), +end.toFixed(2)]);
      start = -1;
    }
  }
  return out;
}

/** "chair" from "interior-props/chair-a"; a member id is preferred when it reads as a word. */
const shortName = (id: string): string => id.replace(/^.*\//, "").replace(/-(?:[a-z]|\d+|[nsew]\d*)$/i, "");

/**
 * Where each member of a set falls relative to its anchor, in words: left/right as seen standing in front of the anchor,
 * facing it (anchor local +X is then on the viewer's RIGHT). "chest at the foot; nightstand on the left; candle on the nightstand".
 */
export function describeSetShape(set: DressingSet, prop: (id: string) => DressingData | undefined): string {
  const [anchor, ...members] = set.items;
  if (!anchor) return "";
  const a = prop(anchor.prop), W = a?.size[0] ?? 1, D = a?.size[2] ?? 1, bed = a?.use.includes("bed") ?? false;
  const aName = shortName(anchor.id);
  const groups = new Map<string, string[]>();
  const add = (where: string, name: string): void => void (groups.get(where) ?? groups.set(where, []).get(where)!).push(name);
  const byId = new Map(set.items.map((i) => [i.id, i]));
  for (const m of members) {
    const name = shortName(m.id);
    if (m.place.kind === "on") {
      add(`on the ${shortName(byId.get(m.place.item)?.id ?? m.place.item)}`, name);
      continue;
    }
    if (m.place.kind !== "floor") continue;
    const [x, z] = m.place.at, md = prop(m.prop);
    const front = z > D / 2 - 0.05, back = z < -D / 2 + 0.05, side = Math.abs(x) > W / 2 - 0.05;
    const lr = x > 0 ? "right" : "left";
    let where: string;
    if (front && !side) where = bed ? "at the foot" : "in front";
    else if (back && !side) where = bed ? "at the head" : "behind";
    else if (side && front) where = `front ${lr}`;
    else if (side && back) where = `back ${lr}`;
    else if (side) where = `on the ${lr}`;
    else where = `at the ${aName}`;
    // facing the anchor (a chair at a table, a pew before a lectern)
    const f = fwd((m.place.yaw ?? 0) * DEG), toA = Math.hypot(x, z) || 1;
    if (Math.hypot(x, z) > 0.2 && (-(f[0] * x) - f[1] * z) / toA > 0.5 && md?.use.includes("seat")) where += ", facing it";
    add(where, name);
  }
  const words = [...groups].map(([where, names]) => {
    const n = new Map<string, number>();
    for (const x of names) n.set(x, (n.get(x) ?? 0) + 1);
    const list = [...n].map(([x, k]) => (k > 1 ? `${k} ${x}` : x)).join(", ");
    return `${list} ${where}`;
  });
  return `${aName}${words.length ? `: ${words.join("; ")}` : " alone"} (left/right as seen facing the ${aName}'s front)`;
}
