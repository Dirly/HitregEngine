import { cultureFits, dressingOrigin, isLooseClutter, mergeVocabulary, scaleFits, type DressingData, type DressingSocket, type DressingVocabulary } from "../components/dressing.js";
import { GROUND_STEP, GROUND_ZERO, HEAD_STEP, type ArrangementKind, type DressingArrangement, type DressingObstacle, type DressingPlace, type DressingPlan, type DressingSet, type SocketAnchor, type SocketLevel, type SocketMap, type SocketRoom, type SocketWall } from "./schema.js";

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
  /**
   * A local rotation (quaternion x, y, z, w) applied BEFORE `yaw`: a model laid on its side by its `pose` (a book lying flat
   * on a table). Omitted = none. The final rotation is yaw(about +Y) * tilt.
   */
  tilt?: [number, number, number, number];
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
  /** Fewest flames a level is allowed, however small. Default 6 (`FLAME_MIN`). */
  flames?: number;
  /** Floor area per flame: a level may burn one flame per this many m² of its rooms' floor (at least `flames`). Default 12 (`FLAME_AREA`). */
  flameArea?: number;
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
  /** Highest clear height over the room (its ridge), metres. */
  ridge?: number;
  /** A tall-roofed chapel/hall/tavern room (ridge >= TALL_RIDGE) that has its chandelier, or false when it has none; omitted for other rooms. */
  chandelier?: boolean;
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
  // per axis: both half-extents projected, less the centres' distance on it (no allocation: the resolver's hot path)
  const ac = Math.cos(a.yaw), as = Math.sin(a.yaw), bc = Math.cos(b.yaw), bs = Math.sin(b.yaw), dx = b.cx - a.cx, dz = b.cz - a.cz;
  let depth = Infinity;
  for (let i = 0; i < 4; i++) {
    const nx = i === 0 ? ac : i === 1 ? as : i === 2 ? bc : bs, nz = i === 0 ? -as : i === 1 ? ac : i === 2 ? -bs : bc;
    const d = a.hw * Math.abs(ac * nx - as * nz) + a.hd * Math.abs(as * nx + ac * nz) + b.hw * Math.abs(bc * nx - bs * nz) + b.hd * Math.abs(bs * nx + bc * nz) - Math.abs(dx * nx + dz * nz);
    if (d < depth) depth = d;
  }
  return depth;
}

// ---- level rasters --------------------------------------------------------

class Grid {
  constructor(readonly lv: SocketLevel) {}
  /** The level's own lane cells per body (laneBody), before any prop stands. */
  readonly laneBase = new Map<string, Uint8Array>();
  private sums = new Map<string, Int32Array>();
  /** How many cells of a kind (`z`: stair/well/doorway/entry, else the cell code) lie in a cell box: an O(1) summed-area lookup. */
  count(kind: string, c0: number, r0: number, c1: number, r1: number): number {
    const C = this.lv.columns, R = this.lv.rows, W = C + 1;
    let t = this.sums.get(kind);
    if (!t) {
      t = new Int32Array(W * (R + 1));
      for (let r = 0; r < R; r++)
        for (let c = 0; c < C; c++) {
          const ch = this.lv.cells[r]?.[c] ?? " ", hit = kind === "z" ? !!HAZARD_NAME[ch] : ch === kind;
          t[(r + 1) * W + c + 1] = (hit ? 1 : 0) + t[r * W + c + 1]! + t[(r + 1) * W + c]! - t[r * W + c]!;
        }
      this.sums.set(kind, t);
    }
    c0 = Math.max(0, c0); r0 = Math.max(0, r0); c1 = Math.min(C - 1, c1); r1 = Math.min(R - 1, r1);
    if (c1 < c0 || r1 < r0) return 0;
    return t[(r1 + 1) * W + c1 + 1]! - t[r0 * W + c1 + 1]! - t[(r1 + 1) * W + c0]! + t[r0 * W + c0]!;
  }
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
  private heads?: Float64Array;
  head(c: number, r: number): number {
    if (!this.inside(c, r)) return NaN;
    let hs = this.heads;
    if (!hs) {
      const C = this.lv.columns;
      hs = this.heads = new Float64Array(C * this.lv.rows);
      for (let rr = 0; rr < this.lv.rows; rr++)
        for (let cc = 0; cc < C; cc++) {
          const ch = this.lv.head[rr]?.[cc];
          const v = ch === undefined || ch === "." ? NaN : parseInt(ch, 36);
          hs[rr * C + cc] = Number.isFinite(v) ? v * HEAD_STEP : NaN;
        }
    }
    return hs[r * this.lv.columns + c]!;
  }
  private roomIds?: Map<string, string>;
  roomAt(c: number, r: number): string {
    const ch = this.inside(c, r) ? this.lv.room[r]?.[c] : undefined;
    if (ch === undefined || ch === ".") return "";
    let ids = this.roomIds;
    if (!ids) {
      ids = this.roomIds = new Map();
      for (const room of this.lv.rooms) ids.set(room.index.toString(36), room.id);
    }
    const hit = ids.get(ch);
    if (hit !== undefined) return hit;
    const idx = parseInt(ch, 36);
    return this.lv.rooms.find((room) => room.index === idx)?.id ?? "";
  }
  /** Cells whose centre lies inside the rectangle; the cell under its centre when none does. */
  cells(r: Rect): V2[] {
    const co = Math.cos(r.yaw), si = Math.sin(r.yaw), ex = r.hw * Math.abs(co) + r.hd * Math.abs(si), ez = r.hw * Math.abs(si) + r.hd * Math.abs(co);
    const { origin, step } = this.lv;
    const c0 = Math.floor((r.cx - ex - origin[0]) / step), r0 = Math.floor((r.cz - ez - origin[1]) / step);
    const c1 = Math.floor((r.cx + ex - origin[0]) / step), r1 = Math.floor((r.cz + ez - origin[1]) / step);
    const out: V2[] = [];
    for (let rr = r0; rr <= r1; rr++)
      for (let cc = c0; cc <= c1; cc++) {
        const dx = origin[0] + (cc + 0.5) * step - r.cx, dz = origin[1] + (rr + 0.5) * step - r.cz;
        if (Math.abs(dx * co - dz * si) < r.hw - 0.01 && Math.abs(dx * si + dz * co) < r.hd - 0.01) out.push([cc, rr]);
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
  /** Placed by `auto` near the hearth on purpose (fireside seating): standing at the hearth clearance's edge is the point, not a warning. */
  byHearth?: boolean;
  /** The place as the plan wrote it, before an `auto` place was turned into a concrete one. */
  asked?: WorkPlace;
  /** The outdoor vignette it was laid out in, and its part there (`arrangement` auto places). */
  vignette?: Vignette;
  vpart?: string;
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
  /** Laid on its side by its pose (DressingPlacement.tilt). */
  tilt?: [number, number, number, number];
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
  doorLines: Map<number, DoorLine[]>;
  /** Pew-row layouts, one per (level, room, what the rows face): computed for the first row item, filled by the rest. */
  rows: Map<string, RowLayout>;
  /** Graveyard layouts, one per (level, room): computed for the first grave, filled by the rest. */
  graves: Map<string, GraveLayout>;
  /** Outdoor vignettes by arrangement id (or why one could not be laid out), and the rooms already laid out. */
  vignettes: Map<string, Vignette | string>;
  vignetteRooms: Set<string>;
  /** Door / opening / hallway-mouth clear boxes per level (`opening-clear`). */
  openings: Map<number, Opening[]>;
  /** The caller set `minItems` (a test, a trial): the outdoor density floor is theirs too. */
  minItemsGiven: boolean;
}

/** Default fewest items for a room: a believable floor without padding (a 90 m² hall needs 6, a 9 m² closet 2). Fewer, better things. */
/** A pocket under 4 m² (an alcove a pillar or a noised wall cuts off a room) holds one piece; real rooms at least 2. */
export const defaultMinItems = (areaM2: number): number => (areaM2 < 4 ? 1 : Math.min(6, Math.max(2, Math.floor(areaM2 / 15))));
const STORE_ROLES = new Set(["storage", "cellar"]);

/**
 * Room roles that name a MIX of the catalogue's roles (props declare only the base ones): a cottage is a hall, a bedroom
 * and a kitchen at once; a guardroom is a hall with bunks; a living room is a hall.
 */
export const ROOM_ROLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  cottage: ["hall", "bedroom", "kitchen"],
  guardroom: ["hall", "bedroom"],
  living: ["hall"],
};
/** Roles with every alias expanded to the base roles it stands for (aliases kept, order kept, no repeats). */
export function expandRoomRoles(roles: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of roles) for (const x of [r, ...(ROOM_ROLE_ALIASES[r] ?? [])]) if (x && !out.includes(x)) out.push(x);
  return out;
}
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
  if (m === "floor")
    return `${prop} stands on the floor: place it with \`auto\`, \`floor\` or \`wall\` (back to a wall), not ${placeName(place)}` +
      (k === "on" ? `; only \`surface\` props go on a table, shelf or altar (props menu lists them under "on tables and shelves", e.g. a low candelabra instead of a standing one)` : "");
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
  // 1 mm slack: auto places record t to the millimetre, so a piece snug to a span's end may round a hair past it
  if (wall.spans.some(([a, b]) => t0 >= a - 0.001 && t1 <= b + 0.001)) return;
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
        if (!hearth && !w.byHearth && d < ctx.opts.hardBuffer - EPS)
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
    const [hMin, hMax] = wallBand(data, wall);
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
    // a sign hangs with its bottom edge on its door-sign anchor (lintel + 0.3 m), never over the door head
    // (beside a door: as high as `prefer` (the lintel) when it fits under the clear height, lower when not, never below the anchor)
    const bottom = BESIDE_ANCHORS.has(a.kind) ? a.position[1] + Math.min(a.prefer ?? 0, Math.max(0, (a.size?.[1] ?? Infinity) - data.size[1])) : a.position[1];
    const ay = hangsOnSignAnchor(a.kind, data) ? bottom + signLift(data) : a.position[1];
    const yaw = a.yaw * DEG, box = boxFromOrigin([a.position[0], ay, a.position[2]], yaw, data.size, dressingOrigin(data));
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
    const res: Res = { work: w, data, level: a.level, room, outdoor: a.outdoor, ...(onGrid ? {} : { outdoorAnchor: true }), box, origin: [a.position[0], ay, a.position[2]], chain: [] };
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
  const tilts = new Map<string, Posed>();
  const uses = new Map<string, SocketItem[]>(sockets.map((s) => [s.id, []]));
  const used = (s: DressingSocket): number => uses.get(s.id)!.length;
  const shelfHost = isShelf(host.data);
  for (const w of kids) {
    const posed = poseOf(ctx.input.prop(w.prop)!, shelfHost);
    const data = posed.data;
    const p = w.place as OnPlace;
    if (posed.upright && isBook(data) && !shelfHost)
      vio(ctx, w.id, "book-upright",
        `${w.prop} is a book standing up on ${host.work.id} (${host.work.prop}): books lie flat on tables, desks and chests and stand upright only on shelves; ` +
          `declare \`pose: { surface: "flat", shelf: "upright" }\` in its dressing sidecar (then \`props sync\`)`);
    if (posed.tilt) tilts.set(w.id, posed);
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
      const posed = tilts.get(it.w.id);
      if (posed?.tilt && s.kind !== "slot") {
        // the model's own origin, once laid down, sits off the laid box's foot: move it so the box rests on the board
        const [lx, lz] = rot(yaw, posed.lift[0], posed.lift[2]);
        origin = [box.cx + lx, box.y0 + posed.lift[1], box.cz + lz];
      }
      settingCheck(ctx, it.w, it.data, host.outdoor);
      out.set(it.w.id, { work: it.w, data: it.data, level: host.level, room: host.room, outdoor: host.outdoor, box, origin, chain: [], ...(posed?.tilt && s.kind !== "slot" ? { tilt: posed.tilt } : {}) });
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
  const { columns: C, rows: R, origin, step } = g.lv, N = C * R;
  // the map's own lane cells (the body's disc on walkable geometry) are fixed per level and body: computed once
  const key = `${radius}|${offs.length}`;
  let base = g.laneBase.get(key);
  if (!base) {
    base = new Uint8Array(N);
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
        base[r * C + c] = ok ? 1 : 0;
      }
    g.laneBase.set(key, base);
  }
  // then each solid closes the lane centres nearer than the radius to its real rectangle (only the cells around it)
  const pass = base.slice();
  for (const s of solids) {
    const co = Math.abs(Math.cos(s.yaw)), si = Math.abs(Math.sin(s.yaw));
    const ex = s.hw * co + s.hd * si + radius, ez = s.hw * si + s.hd * co + radius;
    const c0 = Math.max(0, Math.floor((s.cx - ex - origin[0]) / step)), c1 = Math.min(C - 1, Math.floor((s.cx + ex - origin[0]) / step));
    const r0 = Math.max(0, Math.floor((s.cz - ez - origin[1]) / step)), r1 = Math.min(R - 1, Math.floor((s.cz + ez - origin[1]) / step));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const k = r * C + c;
        if (pass[k] && rectDist(s, origin[0] + (c + 0.5) * step, origin[1] + (r + 0.5) * step) < radius - EPS) pass[k] = 0;
      }
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

/** A prop thinner than this (metres, across its mounting face) gets the plane-clearing standoff by default. */
export const MOUNT_THIN = 0.03;
/** Default standoff of a thin prop: its face clears the zfight gate's 2 cm plane gap (tools/zfight.mts). */
export const MOUNT_CLEAR = 0.021;
/** Default standoff of a thicker wall prop off its wall. */
export const MOUNT_WALL = 0.005;
/**
 * How far a placed prop is held off what it mounts on (`mountOffset`, else the defaults above), as a world offset:
 * a wall prop along its wall's normal, a thin floor covering or thin surface item straight up. Two coplanar faces flicker.
 */
export function mountStandoff(r: { data: DressingData; box: { yaw: number } }): V3 {
  const d = r.data;
  if (d.mount === "wall") {
    const off = d.mountOffset ?? (d.size[2] < MOUNT_THIN ? MOUNT_CLEAR : MOUNT_WALL), f = fwd(r.box.yaw);
    return [f[0] * off, 0, f[1] * off];
  }
  if (d.mount === "floor" || d.mount === "surface") return [0, d.mountOffset ?? (d.size[1] < MOUNT_THIN ? MOUNT_CLEAR : 0), 0];
  return [0, 0, 0];
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
      if (a.data.mount === "ceiling" && b.data.mount === "ceiling" && a.level === b.level) {
        const d = Math.hypot(a.box.w, a.box.d) / 2 + Math.hypot(b.box.w, b.box.d) / 2 - Math.hypot(a.box.cx - b.box.cx, a.box.cz - b.box.cz);
        if (overlapDepth(rectOf(a.box), rectOf(b.box)) > 0.01)
          vio(ctx, a.work.id, "overlap", `${a.work.prop} hangs in the same spot as ${b.work.id} (${b.work.prop}): one hanging light per spot (two z-fight); move it at least ${f2(Math.max(d, 0.01))} m apart or leave one out`);
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
    // an outdoor site's floor scales with its area (layoutChecks `site-sparse`), not a room's handful
    else if (n < need && (ctx.minItemsGiven || plan.space?.kind !== "site")) vio(ctx, id, "room-sparse", `room ${id} (${f2(info.area)} m²) has ${n} item${n === 1 ? "" : "s"}; it needs at least ${need}`);
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
    const roles = spec ? expandRoomRoles([spec.role, ...(spec.also ?? [])]) : [];
    // only things that stand, hang or mount in the room say what the room is; surface and slot items follow the furniture they sit on
    if (r.data.mount !== "floor" && r.data.mount !== "wall" && r.data.mount !== "ceiling") continue;
    if (roles.length && r.data.rooms.length && !r.data.rooms.some((x) => roles.includes(x)))
      warn(ctx, r.work.id, "room-role", `${r.work.prop} belongs in ${r.data.rooms.join("/")} rooms but ${r.room} is ${roles.join("/")}`);
  }
  for (const [level, g] of ctx.grids) {
    const fires = placed.filter((r) => r.level === level && r.data.fire);
    const area = g.lv.rooms.reduce((a, r) => a + r.area, 0), limit = Math.max(ctx.opts.flames, Math.floor(area / ctx.opts.flameArea));
    if (fires.length > limit)
      vio(ctx, "", "flame-budget",
        `level ${level} has ${fires.length} flames (${fires.map((r) => r.work.id).join(", ")}); the budget is ${limit} (one per ${ctx.opts.flameArea} m² of its ` +
          `${f2(area)} m² floor, at least ${ctx.opts.flames}): remove ${fires.length - limit} or use unlit props`);
  }
}

/** A wall light (sconce) on a wall taller than TALL_WALL may hang up to TALL_WALL_LIGHT m: a hall's windows sit high. */
export const TALL_WALL = 4;
export const TALL_WALL_LIGHT: readonly [number, number] = [1.6, 2.4];
/** Where a wall prop's bottom edge may hang on this wall: its declared `wallHeight`, widened for a light on a tall wall. */
function wallBand(d: DressingData, wall: SocketWall): [number, number] {
  const [lo, hi] = d.wallHeight;
  if (wall.height <= TALL_WALL || !(d.use.includes("light") || d.fire)) return [lo, hi];
  return [Math.min(lo, TALL_WALL_LIGHT[0]), Math.max(hi, TALL_WALL_LIGHT[1])];
}

/** A level burns one flame per FLAME_AREA m² of floor, never fewer than FLAME_MIN: a big hall reads lit, a cottage stays a cottage. */
export const FLAME_AREA = 12;
export const FLAME_MIN = 6;

// ---- owner rulings 2026-10-20: chapels, door lines, books, candelabras, signs, chandeliers ----------------------

/** A room this tall under its ridge (a chapel, a hall under a big A-frame) takes a chandelier at its ceiling centre. */
export const TALL_RIDGE = 4.5;
/** Rooms smaller than this are never asked for a chandelier, however tall (a tower, a stair hall). */
const CHANDELIER_MIN_AREA = 20;
/** The rooms a chandelier belongs in when their roof is tall: the church, the house's hall, the tavern room. */
const CHANDELIER_ROLES = new Set(["chapel", "hall", "tavern"]);
/** A tall-roofed chapel, hall or tavern room (its own role, not an `also`): it hangs a chandelier at its ceiling centre. */
function wantsChandelier(ctx: Ctx, rm: SocketRoom): boolean {
  const spec = ctx.input.plan.rooms[rm.id];
  return !!spec && rm.maxHead >= TALL_RIDGE && rm.area >= CHANDELIER_MIN_AREA && expandRoomRoles([spec.role]).some((r) => CHANDELIER_ROLES.has(r));
}
/** How far a door line runs into the room past the doorway or entry lane, metres. */
export const DOOR_LINE = 3;
/** A standing candelabra keeps at least this much floor between itself and a table. */
export const CANDELABRA_TABLE_GAP = 1.2;
/** An altar's far edge stands within this of the chapel's back wall / apse. */
const ALTAR_BACK = 1.0;
/** Anchor kinds a sign hangs on: the town exterior's door-sign above each door, a building map's sign-bracket; and the
 *  floor-mount `door-sign-post` beside a door whose eave leaves no room for a board (a freestanding sign POST). */
const SIGN_ANCHORS = new Set(["door-sign", "sign-bracket", "door-sign-beside", "sign-beside", "door-sign-post"]);
/**
 * A freestanding sign POST (tags sign + post, floor mount) stands beside its door: its centre this far along the wall
 * from the door's EDGE, metres [min, max], on the window-free side. Owner ruling 2026-10-21 (Cindermoot smithy,
 * candle-shop, stables: eave at 2.42 m, no wall for a board): a sign hangs over the door, beside it, or on a post.
 */
export const SIGN_POST_REACH: readonly [number, number] = [1.0, 1.5];
/** Beside-the-door sign anchors: a projecting sign (tag `projecting`, arm out of the wall) hangs there when the wall over the door has no room. */
const BESIDE_ANCHORS = new Set(["door-sign-beside", "sign-beside"]);
/** A beside-the-door sign's bracket plate stands at most this far along the wall from the door's edge, metres. */
export const SIGN_BESIDE_REACH = 1.5;
/**
 * A sign hangs centred over its door: its box centre at most this far along the wall from the door-sign anchor (the
 * door opening's centre), metres. Owner walk 2026-10-21: "store signs are not all over the doors, some crash into windows".
 */
export const SIGN_DOOR_DX = 0.3;
/** A hanging sign on a door-sign / sign-bracket anchor HANGS ABOVE it: the anchor is the lowest point of the sign (lintel + 0.3 m). */
const hangsOnSignAnchor = (kind: string, d: DressingData): boolean => SIGN_ANCHORS.has(kind) && d.mount === "wall" && !!d.tags?.includes("sign");
/** Origin height above a sign's bottom edge, by its declared origin. */
const signLift = (d: DressingData): number => { const o = dressingOrigin(d); return o === "back" ? d.size[1] / 2 : o === "top" ? d.size[1] : 0; };

const hasTag = (d: DressingData, t: string): boolean => !!d.tags?.includes(t);
const isBook = (d: DressingData): boolean => hasTag(d, "book") || d.fits.includes("book");
/** A shelf host: boards things stand up on (a bookshelf), not a top things lie on (a table, a chest). */
const isShelf = (d: DressingData): boolean => d.use.includes("shelf") && !d.use.includes("table");
const isChandelier = (d: DressingData): boolean => hasTag(d, "chandelier") || (d.mount === "ceiling" && d.use.includes("light") && Math.max(d.size[0], d.size[2]) >= 1);
const isTable = (d: DressingData): boolean => d.mount === "floor" && d.use.includes("table") && !hasTag(d, "lectern") && !hasTag(d, "altar") && !d.neverInDoorLine;
/** A pew, or a bench-long seat standing in for one. */
const isPew = (r: Res): boolean => hasTag(r.data, "pew") || (r.data.mount === "floor" && r.data.use.includes("seat") && Math.max(r.box.w, r.box.d) >= 1.2);
function roomRoles(ctx: Ctx, room: string): string[] {
  const spec = ctx.input.plan.rooms[room];
  return spec ? expandRoomRoles([spec.role, ...(spec.also ?? [])]) : [];
}

/** A surface item's declaration as it lies on this host (its `pose`), with the rotation and origin lift that lays it down. */
interface Posed {
  data: DressingData;
  /** Stands upright as placed (taller than its thinnest horizontal side). */
  upright: boolean;
  tilt?: [number, number, number, number];
  /** The model origin's offset from the laid box's foot, in the item's yawed frame. */
  lift: V3;
}
function poseOf(d: DressingData, shelf: boolean): Posed {
  const [W, H, D] = d.size;
  const upright = H > Math.min(W, D) + EPS;
  const want = shelf ? d.pose?.shelf : d.pose?.surface;
  if (!upright || want !== "flat" || dressingOrigin(d) !== "foot") return { data: d, upright, lift: [0, 0, 0] };
  const h = Math.SQRT1_2;
  // thin across X (covers facing the sides): roll a quarter turn about its front axis (Z), a cover up
  if (W <= D) return { data: { ...d, size: [H, W, D] }, upright: false, tilt: [0, 0, h, h], lift: [H / 2, W / 2, 0] };
  // thin front to back: tip it onto its back (a quarter turn about X), its front up
  return { data: { ...d, size: [W, D, H] }, upright: false, tilt: [-h, 0, 0, h], lift: [0, D / 2, H / 2] };
}

/** A doorway's or entry lane's clear width carried DOOR_LINE m into the rooms on each side. */
interface DoorLine {
  rect: Rect;
  label: string;
}
function doorLinesOf(ctx: Ctx, level: number): DoorLine[] {
  const have = ctx.doorLines.get(level);
  if (have) return have;
  const g = ctx.grids.get(level), out: DoorLine[] = [];
  if (g) {
    const cols = g.lv.columns, ent = ctx.input.map.entry;
    const open = (c: number, r: number): boolean => WALKABLE.has(g.ch(c, r));
    for (const ch of ["E", "D"])
      for (const comp of components(g, ch)) {
        let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
        for (const k of comp) {
          const c = k % cols, r = (k - c) / cols;
          [c0, c1, r0, r1] = [Math.min(c0, c), Math.max(c1, c), Math.min(r0, r), Math.max(r1, r)];
        }
        const [x0, z0] = g.centre(c0, r0), [x1, z1] = g.centre(c1, r1);
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0 + g.step) / 2, hz = (z1 - z0 + g.step) / 2;
        // the way a player walks through it: an entry lane runs along the door's facing; a doorway joins the two sides open onto floor
        let alongX: boolean;
        if (ch === "E" && ent) alongX = Math.abs(ent.facing[0]) > Math.abs(ent.facing[1]);
        else {
          const cm = Math.round((c0 + c1) / 2), rm = Math.round((r0 + r1) / 2);
          const xOpen = open(c0 - 1, rm) && open(c1 + 1, rm), zOpen = open(cm, r0 - 1) && open(cm, r1 + 1);
          alongX = xOpen === zOpen ? hx < hz : xOpen;
        }
        const rect: Rect = alongX ? { cx, cz, hw: hx + DOOR_LINE, hd: hz, yaw: 0 } : { cx, cz, hw: hx, hd: hz + DOOR_LINE, yaw: 0 };
        out.push({ rect, label: `${ch === "E" ? "entry lane" : "doorway"} at ${at2(cx, cz)}` });
      }
  }
  ctx.doorLines.set(level, out);
  return out;
}
function doorLineHit(ctx: Ctx, level: number, r: Rect): DoorLine | undefined {
  return doorLinesOf(ctx, level).find((l) => overlapDepth(r, l.rect) > 0.02);
}

/** The room's main door and the way into the room from it: the map's entry on the ground floor, else its doorways. */
function doorOf(ctx: Ctx, level: number, room: string): { at: V2; facing: V2 } | undefined {
  const g = ctx.grids.get(level)!, ent = ctx.input.map.entry;
  if (ent && level === Math.min(...ctx.grids.keys()))
    for (let d = 0.25; d <= 6 + EPS; d += g.step) {
      const [c, r] = g.cellOf(ent.position[0] + ent.facing[0] * d, ent.position[1] + ent.facing[1] * d);
      if (g.roomAt(c, r) === room) return { at: [...ent.position], facing: [...ent.facing] };
    }
  const rm = g.lv.rooms.find((r) => r.id === room);
  if (!rm) return undefined;
  let sx = 0, sz = 0, n = 0;
  for (let r = 0; r < g.lv.rows; r++)
    for (let c = 0; c < g.lv.columns; c++) {
      if (g.ch(c, r) !== "D" || !([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dc, dr]) => g.roomAt(c + dc, r + dr) === room)) continue;
      const [x, z] = g.centre(c, r);
      [sx, sz, n] = [sx + x, sz + z, n + 1];
    }
  if (!n) return undefined;
  const at: V2 = [sx / n, sz / n], dx = rm.centre[0] - at[0], dz = rm.centre[1] - at[1], l = Math.hypot(dx, dz) || 1;
  return { at, facing: [dx / l, dz / l] };
}

/** The far end of a room from its main door (an apse when diagonal walls close that end): where an altar stands. */
interface Back {
  at: V2;
  facing: V2;
  door: V2;
  /** Distance along `facing` from the door to the room's farthest floor. */
  depth: number;
  apse: boolean;
}
function backOf(ctx: Ctx, level: number, room: string): Back | undefined {
  const door = doorOf(ctx, level, room);
  if (!door) return undefined;
  const g = ctx.grids.get(level)!;
  const proj = (x: number, z: number): number => (x - door.at[0]) * door.facing[0] + (z - door.at[1]) * door.facing[1];
  const cells: V2[] = [];
  let depth = -Infinity;
  for (let r = 0; r < g.lv.rows; r++)
    for (let c = 0; c < g.lv.columns; c++)
      if (g.roomAt(c, r) === room) {
        const p = g.centre(c, r);
        cells.push(p);
        depth = Math.max(depth, proj(p[0], p[1]));
      }
  if (!cells.length) return undefined;
  const end = cells.filter((p) => proj(p[0], p[1]) >= depth - 0.75);
  const at: V2 = [end.reduce((a, p) => a + p[0], 0) / end.length, end.reduce((a, p) => a + p[1], 0) / end.length];
  const apse = g.lv.walls.some(
    (w) => w.room === room && Math.abs(w.normal[0]) > 0.2 && Math.abs(w.normal[1]) > 0.2 && proj((w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2) >= depth - 4,
  );
  return { at, facing: door.facing, door: door.at, depth, apse };
}

/** The middle of a room's highest ceiling (under its ridge): where its chandelier hangs. */
function ridgeCentre(g: Grid, rm: SocketRoom): V2 {
  const cells: [number, number, number][] = [];
  let top = -Infinity;
  for (let r = 0; r < g.lv.rows; r++)
    for (let c = 0; c < g.lv.columns; c++) {
      if (g.roomAt(c, r) !== rm.id) continue;
      const h = g.head(c, r);
      if (!Number.isFinite(h)) continue;
      cells.push([c, r, h]);
      top = Math.max(top, h);
    }
  const ridge = cells.filter(([, , h]) => h >= top - 0.5);
  if (!ridge.length) return [...rm.centre];
  const pts = ridge.map(([c, r]) => g.centre(c, r));
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, mz = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  // the ridge's middle, or the ridge cell nearest it (an L-shaped hall)
  return pts.reduce((b, p) => (Math.hypot(p[0] - mx, p[1] - mz) < Math.hypot(b[0] - mx, b[1] - mz) ? p : b));
}

// ---- long halls: pew rows along the nave, a chandelier line under the ridge ------------------------------------

/** Pew rows stand this far apart, front to front (pew depth + knee gap): the tightest and the loosest. */
export const ROW_PITCH: readonly [number, number] = [1.1, 1.3];
/** The centre aisle between the two banks of pews, metres. */
export const ROW_AISLE = 1.2;
/** Side by side in one row, pews keep this gap. */
const ROW_SIDE_GAP = 0.2;
/** Rows must cover at least this share of the nave (altar step to door line), else `chapel-pews`. */
export const ROW_NAVE_SHARE = 0.5;
/** Under a tall roof a chandelier's chain lets it down until its bottom hangs this high over the floor. */
export const CHANDELIER_HANG = 4;
/** A room this much longer than wide is a long hall: its chandeliers hang in a line under the ridge. */
export const LONG_HALL = 1.6;
/** Chandeliers in a long hall hang this far apart along the ridge (room length / count, clamped). */
export const CEILING_LINE: readonly [number, number] = [6, 8];

/** The nave a row layout fills: along `axis` from `target`, from the step in front of it to the door line (DOOR_LINE in a long
 *  nave of 10 m or more, less in a shorter one: a 4 m chapel keeps only the stair/doorway buffer) or the room's end. */
function naveOf(ctx: Ctx, g: Grid, level: number, room: string, target: V2, axis: V2, front: number): { start: number; end: number } {
  let end = -Infinity;
  for (let r = 0; r < g.lv.rows; r++)
    for (let c = 0; c < g.lv.columns; c++)
      if (g.roomAt(c, r) === room) {
        const [x, z] = g.centre(c, r);
        end = Math.max(end, (x - target[0]) * axis[0] + (z - target[1]) * axis[1] + g.step / 2);
      }
  const door = doorOf(ctx, level, room);
  if (door) {
    const d = (door.at[0] - target[0]) * axis[0] + (door.at[1] - target[1]) * axis[1];
    if (d > front) end = Math.min(end, d - Math.min(DOOR_LINE, Math.max(0, (d - front - 4) / 2)));
  }
  return { start: front, end };
}

interface RowLayout {
  /** Slot centres in fill order: row by row from the front, inner seats first, alternating sides. */
  slots: { at: V2; row: number }[];
  yaw: number;
  pitch: number;
  want: number;
  nave: { start: number; end: number };
}

/** The plan items that fill one row layout: `auto` + `prefer: "row"` + the same room and `near`. */
function rowItems(ctx: Ctx, room: string, near: string): number {
  return ctx.input.plan.items.filter((it) => it.place.kind === "auto" && it.place.prefer === "row" && it.place.room === room && it.place.near === near).length;
}

/**
 * Lay out the pews of one room facing one target: rows every ROW_PITCH from the target's step back along `axis`, a
 * ROW_AISLE centre aisle on the target's line, as many seats per row as the room's free floor takes, spread over the
 * nave (the pitch loosens toward ROW_PITCH[1] when the count leaves room) and never past the door line.
 */
function rowLayout(ctx: Ctx, g: Grid, level: number, room: string, near: string, w: Work, data: DressingData, target: V2, axis: V2, front: number): RowLayout {
  const key = `${level}|${room}|${near}`, have = ctx.rows.get(key);
  if (have) return have;
  const [W, H, D] = data.size, lat: V2 = [-axis[1], axis[0]], yaw = yawOf([-axis[0], -axis[1]]);
  const want = Math.max(1, rowItems(ctx, room, near)), nave = naveOf(ctx, g, level, room, target, axis, front);
  const [x0, x1, z0, z1] = g.lv.rooms.find((r) => r.id === room)!.bbox, reach = Math.hypot(x1 - x0, z1 - z0);
  let comfy = true;
  const fits = (along: number, side: number): V2 | undefined => {
    const at: V2 = [target[0] + axis[0] * along + lat[0] * side, target[1] + axis[1] * along + lat[1] * side];
    const box: Box = { cx: at[0], cz: at[1], y0: g.y(at[0], at[1]), yaw, w: W, h: H, d: D };
    const piece = floorRes(w, data, level, box, room, false);
    // a seat squeezed against a stair or doorway buffer is left out of the rows (the apse end narrows instead), unless the
    // room is too small to seat the plan without it
    return autoPieceRefusal(ctx, g, room, piece, undefined, []) || (comfy && autoComfort(ctx, g, [piece]) > 0) ? undefined : at;
  };
  // the aisle: on the target's line, or on the walking path that runs down the nave beside it (the map keeps it clear anyway)
  let mid0 = 0, half = ROW_AISLE / 2;
  {
    const a = nave.start + (nave.end - nave.start) / 2, path: number[] = [];
    for (let s = -2; s <= 2 + EPS; s += g.step / 2) {
      const [c, r] = g.cellOf(target[0] + axis[0] * a + lat[0] * s, target[1] + axis[1] * a + lat[1] * s);
      if (g.ch(c, r) === "x") path.push(s);
    }
    if (path.length) {
      const lo = Math.min(...path) - g.step / 2, hi = Math.max(...path) + g.step / 2;
      [mid0, half] = [(lo + hi) / 2, Math.max(ROW_AISLE / 2, (hi - lo) / 2 + ctx.opts.pathMargin)];
    }
  }
  // one row's seats: from the aisle edge outward on each side, sliding past what refuses them (a pillar, a buttress)
  const row = (along: number): V2[][] => {
    const sides: V2[][] = [[], []];
    [1, -1].forEach((sgn, i) => {
      for (let s = half + W / 2; s <= reach; ) {
        const at = fits(along, mid0 + sgn * s);
        if (at) [sides[i]!.push(at), (s += W + ROW_SIDE_GAP)];
        else s += g.step;
      }
    });
    return sides;
  };
  const first = nave.start + D / 2, len = nave.end - nave.start;
  const lay = (): { slots: RowLayout["slots"]; pitch: number } => {
    // seats per row from a row in the middle of the nave (the apse end may be narrower)
    const mid = row(first + Math.max(0, (len - D) / 2)).reduce((a, s) => a + s.length, 0) || 1;
    const rows = Math.ceil(want / mid);
    const pitch = Math.min(ROW_PITCH[1], Math.max(ROW_PITCH[0], rows > 1 ? (len - D) / (rows - 1) : ROW_PITCH[1]));
    const slots: RowLayout["slots"] = [];
    // every row to the door line: the plan's count takes the front ones, the rest are spares for a slot the lane refuses
    for (let i = 0; ; i++) {
      const along = first + i * pitch;
      if (along + D / 2 > nave.end + EPS) break;
      const [a, b] = row(along);
      for (let k = 0; k < Math.max(a!.length, b!.length); k++) for (const s of [a![k], b![k]]) if (s) slots.push({ at: s, row: i });
    }
    return { slots, pitch };
  };
  let best = lay();
  if (best.slots.length < want) {
    comfy = false;
    const tight = lay();
    if (tight.slots.length > best.slots.length) best = tight;
  }
  const out: RowLayout = { slots: best.slots, yaw, pitch: best.pitch, want, nave };
  ctx.rows.set(key, out);
  return out;
}

// ---- graveyards: headstones in rows over the whole yard (owner walk 2026-10-21) ------------------------------------
// "None of these graves are spaced out, they are all clustered in the centre": a churchyard's graves stand in ROWS, head-
// stones aligned along each row, all facing the same way, the rows filling the yard with its lanes kept.

/** What a grave is, by its catalogue `tags`: a headstone, a grave cross, a tomb or a grave slab. */
export const GRAVE_TAGS = ["grave", "headstone", "cross", "tomb"] as const;
/** Grave rows stand this far apart, front to front: the loosest first, tighter when the plan asks for more graves than fit. */
export const GRAVE_PITCH: readonly [number, number] = [2.0, 2.5];
/** Headstones along one row stand this far apart, centre to centre (the same: loosest first). */
export const GRAVE_SPACING: readonly [number, number] = [1.2, 1.8];
/** A graveyard holds at least one grave per this many m² of its placeable yard (`graveyard-sparse`). */
export const GRAVE_YARD_M2 = 10;
/** `graveyard-rows`: graves clump when more than this share of them stand within GRAVE_CLUMP_R m of the yard's centroid. */
export const GRAVE_CLUMP = 0.4;
export const GRAVE_CLUMP_R = 2;
/** `graveyard-rows`: the graves must span at least this share of the yard's free extent along the rows and across them. */
export const GRAVE_SPREAD = 0.4;
/** A room with this many graves or more is a graveyard: its graves are checked as one. */
export const GRAVE_MIN = 4;
const isGrave = (d: DressingData): boolean => GRAVE_TAGS.some((t) => hasTag(d, t));

interface GraveLayout {
  /** Slot centres in fill order: the plan's graves spread over every row, then the spares. */
  slots: { at: V2; row: number }[];
  yaw: number;
  pitch: number;
  spacing: number;
  rows: number;
  capacity: number;
  want: number;
}

/** The plan's graves laid out in rows in one room (`prefer` row + a grave tag; `near` optional). */
function graveItems(ctx: Ctx, room: string): DressingData[] {
  const out: DressingData[] = [];
  for (const it of ctx.input.plan.items) {
    if (it.place.kind !== "auto" || it.place.prefer !== "row" || it.place.room !== room || !it.prop) continue;
    const d = ctx.input.prop(it.prop);
    if (d && isGrave(d)) out.push(d);
  }
  return out;
}

/** Where a yard's graves face from when the plan names nothing: the map's entry, its doorway, else its entry lanes ('E'). */
function yardFront(ctx: Ctx, g: Grid, level: number, room: string): V2 | undefined {
  const door = doorOf(ctx, level, room);
  if (door) return door.at;
  let best: number[] | undefined;
  for (const comp of components(g, "E")) if (!best || comp.length > best.length) best = comp;
  if (!best) return undefined;
  let sx = 0, sz = 0;
  for (const k of best) {
    const c = k % g.lv.columns, [x, z] = g.centre(c, (k - c) / g.lv.columns);
    [sx, sz] = [sx + x, sz + z];
  }
  return [sx / best.length, sz / best.length];
}

/**
 * The yard a graveyard fills: the room's free cells ENCLOSED by its walls (both straight lines out of the cell along x, or
 * both along z, meet a wall or a built footprint before they leave the room: the site disc may cut a walled square's corners), when the room has a walled yard (at least a third of its free
 * floor enclosed); else every free cell (an unwalled burial ground). A site area is a disc round its walls: no grave stands
 * on the knowe outside the kirkyard wall.
 */
function yardMask(g: Grid, room: string): (c: number, r: number) => boolean {
  const C = g.lv.columns, R = g.lv.rows, free = new Uint8Array(C * R);
  let n = 0;
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) {
      const ch = g.ch(c, r);
      if (g.roomAt(c, r) === room && (ch === "." || ch === "o")) [free[r * C + c], n] = [1, n + 1];
    }
  // a ray from a free cell is closed when it meets a blocked cell ('#', a built footprint) before it leaves the room
  const closed = (c: number, r: number, dc: number, dr: number): boolean => {
    for (let cc = c + dc, rr = r + dr; cc >= 0 && rr >= 0 && cc < C && rr < R; cc += dc, rr += dr) {
      if (free[rr * C + cc]) continue;
      const ch = g.ch(cc, rr);
      if (ch === "#") return true;
      if (g.roomAt(cc, rr) !== room && ch !== "x") return false;
    }
    return false;
  };
  const yard = new Uint8Array(C * R);
  let m = 0;
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++)
      if (free[r * C + c] && ((closed(c, r, 1, 0) && closed(c, r, -1, 0)) || (closed(c, r, 0, 1) && closed(c, r, 0, -1)))) [yard[r * C + c], m] = [1, m + 1];
  const walled = m >= n / 3;
  return (c, r) => g.inside(c, r) && !!(walled ? yard[r * C + c] : free[r * C + c]);
}

/**
 * Lay out a graveyard: rows across the yard every GRAVE_PITCH, headstones every GRAVE_SPACING along each row on one
 * lattice (so they line up row to row), all facing the front (the `near` target, else the yard's entry); the loosest
 * lattice that seats the plan's count, tighter only when it must. Every row of the yard takes its share of the graves,
 * spread evenly across the row, so the rows fill the yard instead of a block at one end; walking paths and keep-clear
 * zones refuse their slots (the lanes stay open).
 */
function graveLayout(ctx: Ctx, g: Grid, level: number, room: string, w: Work, target: V2 | undefined, targetYaw: number | undefined): GraveLayout {
  const key = `${level}|${room}|graves`, have = ctx.graves.get(key);
  if (have) return have;
  const rm = g.lv.rooms.find((r) => r.id === room)!;
  const items = graveItems(ctx, room), want = Math.max(1, items.length);
  const W = Math.max(...items.map((d) => d.size[0])), H = Math.max(...items.map((d) => d.size[1])), D = Math.max(...items.map((d) => d.size[2]));
  const proto = items[0]!;
  // the axis the rows run back along: the target item's own front, else from the target (or the yard's entry) into the yard
  const front = target ?? yardFront(ctx, g, level, room);
  let a: V2 = targetYaw !== undefined ? fwd(targetYaw) : front ? [rm.centre[0] - front[0], rm.centre[1] - front[1]] : [0, 1];
  if (Math.hypot(a[0], a[1]) < EPS) a = [0, 1];
  const axis: V2 = Math.abs(a[0]) >= Math.abs(a[1]) ? [Math.sign(a[0]) || 1, 0] : [0, Math.sign(a[1]) || 1];
  const lat: V2 = [-axis[1], axis[0]], yaw = yawOf([-axis[0], -axis[1]]);
  const O: V2 = front ?? rm.centre;
  // the yard's free floor in (along, across) coordinates
  const inYard = yardMask(g, room);
  let a0 = Infinity, a1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (let r = 0; r < g.lv.rows; r++)
    for (let c = 0; c < g.lv.columns; c++) {
      if (!inYard(c, r)) continue;
      const [x, z] = g.centre(c, r), al = (x - O[0]) * axis[0] + (z - O[1]) * axis[1], ac = (x - O[0]) * lat[0] + (z - O[1]) * lat[1];
      [a0, a1, t0, t1] = [Math.min(a0, al), Math.max(a1, al), Math.min(t0, ac), Math.max(t1, ac)];
    }
  // the lattice is centred on the walking path down the yard (the lane between two columns of stones), else on the front's line
  let tc = 0;
  {
    const mid = (a0 + a1) / 2, path: number[] = [];
    for (let s = t0; s <= t1 + EPS; s += g.step) {
      const [c, r] = g.cellOf(O[0] + axis[0] * mid + lat[0] * s, O[1] + axis[1] * mid + lat[1] * s);
      if (g.ch(c, r) === "x") path.push(s);
    }
    if (path.length) {
      // the path run nearest the front's line (the lane in from the entry; a creature clearing is a wide blob beside it)
      const runs: number[][] = [];
      for (const s of path) {
        const cur = runs.at(-1);
        if (cur && s - cur.at(-1)! <= g.step + EPS) cur.push(s);
        else runs.push([s]);
      }
      const mid2 = (r: number[]): number => (r[0]! + r.at(-1)!) / 2;
      tc = mid2(runs.reduce((b, r) => (Math.abs(mid2(r)) < Math.abs(mid2(b)) ? r : b)));
    }
  }
  let comfy = true;
  const fits = (along: number, side: number): V2 | undefined => {
    const at: V2 = [O[0] + axis[0] * along + lat[0] * side, O[1] + axis[1] * along + lat[1] * side];
    const box: Box = { cx: at[0], cz: at[1], y0: g.y(at[0], at[1]), yaw, w: W, h: H, d: D };
    const [cc, rr] = g.cellOf(at[0], at[1]);
    if (!inYard(cc, rr)) return undefined;
    const piece = floorRes(w, proto, level, box, room, false);
    // a stone squeezed against an entry lane or a doorway buffer is left out, unless the yard is too small for the plan without it
    return autoPieceRefusal(ctx, g, room, piece, undefined, []) || (comfy && autoComfort(ctx, g, [piece]) > 0) ? undefined : at;
  };
  const lattice = (pitch: number, spacing: number): { at: V2; t: number }[][] => {
    const rows: { at: V2; t: number }[][] = [];
    const k0 = Math.floor((t0 - tc) / spacing - 0.5), k1 = Math.ceil((t1 - tc) / spacing + 0.5);
    for (let along = a0 + Math.max(pitch / 2, D / 2 + 0.3); along <= a1 - D / 2 + EPS; along += pitch) {
      const row: { at: V2; t: number }[] = [];
      for (let k = k0; k <= k1; k++) {
        const t = tc + (k + 0.5) * spacing, at = fits(along, t);
        if (at) row.push({ at, t });
      }
      if (row.length) rows.push(row);
    }
    return rows;
  };
  const tries: [number, number][] = [
    [GRAVE_PITCH[1], GRAVE_SPACING[1]],
    [(GRAVE_PITCH[0] + GRAVE_PITCH[1]) / 2, (GRAVE_SPACING[0] + GRAVE_SPACING[1]) / 2],
    [GRAVE_PITCH[0], GRAVE_SPACING[0]],
  ];
  let rows: { at: V2; t: number }[][] = [], pitch = tries[0]![0], spacing = tries[0]![1], cap = 0;
  for (const [p, s] of tries) {
    if (s < W + 0.3 && rows.length) continue; // never closer than a hand's breadth between two stones
    const r = lattice(p, s), n = r.reduce((x, row) => x + row.length, 0);
    if (n > cap || !rows.length) [rows, pitch, spacing, cap] = [r, p, s, n];
    if (n >= want) break;
  }
  if (cap < want && comfy) {
    comfy = false;
    const [p, s] = tries.at(-1)!, r = lattice(p, s), n = r.reduce((x, row) => x + row.length, 0);
    if (n > cap) [rows, pitch, spacing, cap] = [r, p, s, n];
  }
  // the plan's count takes whole COLUMNS of the lattice (evenly spread over it), so the stones line up row to row and
  // every row of the yard is used; the fewest columns that seat the plan, the rest of the slots are spares
  const fill = Math.min(want, cap), col = (t: number): number => Math.round((t - tc) / spacing - 0.5);
  const cols = [...new Set(rows.flatMap((row) => row.map((e) => col(e.t))))].sort((x, y) => x - y);
  let chosen = new Set(cols);
  for (let m = 1; m <= cols.length; m++) {
    const set = new Set(Array.from({ length: m }, (_, j) => cols[Math.floor(((j + 0.5) * cols.length) / m)]!));
    if (rows.reduce((n, row) => n + row.filter((e) => set.has(col(e.t))).length, 0) >= fill) { chosen = set; break; }
  }
  const slots: GraveLayout["slots"] = [], spares: GraveLayout["slots"] = [];
  rows.forEach((row, i) => [...row].sort((x, y) => x.t - y.t).forEach((e) => (chosen.has(col(e.t)) ? slots : spares).push({ at: e.at, row: i })));
  const out: GraveLayout = { slots: [...slots, ...spares], yaw, pitch, spacing, rows: rows.length, capacity: cap, want };
  ctx.graves.set(key, out);
  return out;
}

/**
 * `graveyard-rows` (a violation): a yard's graves stand in 2+ rows and spread over it — not more than GRAVE_CLUMP of them
 * within GRAVE_CLUMP_R m of the yard's centroid, and spanning GRAVE_SPREAD of its free extent along the rows and across.
 * `graveyard-sparse` (a violation): a graveyard holds one grave per GRAVE_YARD_M2 m² of its placeable yard.
 */
function graveyardCheck(ctx: Ctx, level: number, rm: SocketRoom, here: Res[], placeable: number): void {
  const graves = here.filter((r) => r.floor && isGrave(r.data));
  if (graves.length < GRAVE_MIN) return;
  const g = ctx.grids.get(level)!;
  const how =
    `{ "kind": "auto", "room": "${rm.id}", "prefer": "row" } on each grave (the resolver lays them in rows ${GRAVE_PITCH[0]}-${GRAVE_PITCH[1]} m apart, ` +
    `stones ${GRAVE_SPACING[0]}-${GRAVE_SPACING[1]} m apart, over the whole yard)`;
  // the yard: its free cells' centroid and extent along the graves' facing axis and across it
  const f = fwd(graves[0]!.box.yaw);
  const axis: V2 = Math.abs(f[0]) >= Math.abs(f[1]) ? [Math.sign(f[0]) || 1, 0] : [0, Math.sign(f[1]) || 1], lat: V2 = [-axis[1], axis[0]];
  const inYard = yardMask(g, rm.id);
  let sx = 0, sz = 0, n = 0, a0 = Infinity, a1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (let r = 0; r < g.lv.rows; r++)
    for (let c = 0; c < g.lv.columns; c++) {
      if (!inYard(c, r)) continue;
      const [x, z] = g.centre(c, r), al = x * axis[0] + z * axis[1], ac = x * lat[0] + z * lat[1];
      [sx, sz, n, a0, a1, t0, t1] = [sx + x, sz + z, n + 1, Math.min(a0, al), Math.max(a1, al), Math.min(t0, ac), Math.max(t1, ac)];
    }
  if (!n) return;
  const cen: V2 = [sx / n, sz / n];
  let rows = 0, last = -Infinity;
  for (const v of graves.map((p) => p.box.cx * axis[0] + p.box.cz * axis[1]).sort((x, y) => x - y)) if (v - last > 0.6) [rows, last] = [rows + 1, v];
  const near = graves.filter((p) => Math.hypot(p.box.cx - cen[0], p.box.cz - cen[1]) <= GRAVE_CLUMP_R).length;
  const al = graves.map((p) => p.box.cx * axis[0] + p.box.cz * axis[1]), ac = graves.map((p) => p.box.cx * lat[0] + p.box.cz * lat[1]);
  const spanA = (Math.max(...al) - Math.min(...al)) / Math.max(a1 - a0, EPS), spanT = (Math.max(...ac) - Math.min(...ac)) / Math.max(t1 - t0, EPS);
  const faults: string[] = [];
  if (rows < 2) faults.push(`they stand in ${rows} row`);
  if (near / graves.length > GRAVE_CLUMP + EPS)
    faults.push(`${near} of ${graves.length} (${Math.round((near / graves.length) * 100)}%, at most ${Math.round(GRAVE_CLUMP * 100)}%) stand within ${GRAVE_CLUMP_R} m of the yard's centre ${at2(cen[0], cen[1])}`);
  if (spanA < GRAVE_SPREAD - EPS || spanT < GRAVE_SPREAD - EPS)
    faults.push(
      `they span ${Math.round(spanA * 100)}% of the yard along the rows' axis and ${Math.round(spanT * 100)}% across it ` +
        `(${f2(a1 - a0)} x ${f2(t1 - t0)} m free; at least ${Math.round(GRAVE_SPREAD * 100)}% each way)`,
    );
  if (faults.length) vio(ctx, rm.id, "graveyard-rows", `graveyard ${rm.id}'s ${graves.length} graves clump: ${faults.join("; ")}. Graves stand in rows filling the yard: ${how}`);
  const yardM2 = Math.min(placeable, n * g.step * g.step), need = Math.floor(yardM2 / GRAVE_YARD_M2);
  if (graves.length < need)
    vio(ctx, rm.id, "graveyard-sparse",
      `graveyard ${rm.id} (${f2(yardM2)} m² of placeable yard) has ${graves.length} graves; a churchyard holds at least one per ${GRAVE_YARD_M2} m² (${need}): plan ${need - graves.length} more, ${how}`);
}

/** Spots for a long hall's chandeliers: along the ridge every CEILING_LINE m (room length / count), the first at the ridge centre. */
function ceilingLine(g: Grid, rm: SocketRoom, count: number): V2[] {
  const [x0, x1, z0, z1] = rm.bbox, lx = x1 - x0, lz = z1 - z0, long = Math.max(lx, lz);
  const c = ridgeCentre(g, rm);
  if (long < LONG_HALL * Math.min(lx, lz) || count < 2) return [c];
  const axis: V2 = lx >= lz ? [1, 0] : [0, 1], gap = Math.min(CEILING_LINE[1], Math.max(CEILING_LINE[0], long / count));
  const out: V2[] = [];
  for (let k = 0; out.length < count && k <= 2 * count + 2; k++) {
    const n = k === 0 ? 0 : k % 2 ? (k + 1) / 2 : -k / 2, at: V2 = [c[0] + axis[0] * n * gap, c[1] + axis[1] * n * gap];
    const [cc, rr] = g.cellOf(at[0], at[1]);
    if (g.roomAt(cc, rr) === rm.id) out.push(at);
  }
  return out;
}
/** How many chandeliers a tall-roofed room's ceiling wants: one, or one per CEILING_LINE[1] m of a long hall. */
function chandeliersWanted(rm: SocketRoom): number {
  const [x0, x1, z0, z1] = rm.bbox, lx = x1 - x0, lz = z1 - z0, long = Math.max(lx, lz);
  return long < LONG_HALL * Math.min(lx, lz) ? 1 : Math.max(1, Math.floor(long / CEILING_LINE[1]));
}

/** A standing candelabra the plan put on a wall, in a corner or by the altar on purpose. */
function candelabraExempt(r: Res, placed: Res[]): boolean {
  const a = r.work.asked ?? r.work.place;
  if (a.kind === "wall" || a.kind === "anchor") return true;
  if (a.kind !== "auto") return false;
  if (a.prefer === "wall" || a.prefer === "corner" || a.near === "altar") return true;
  const it = a.near ? placed.find((x) => x.work.id === a.near || x.work.group === a.near) : undefined;
  return !!it && hasTag(it.data, "altar");
}

function chapelCheck(ctx: Ctx, level: number, rm: SocketRoom, here: Res[]): void {
  const back = backOf(ctx, level, rm.id);
  const where = back?.apse ? "apse" : "back-wall", whereText = back?.apse ? "apse (the rounded end)" : "back wall (the end farthest from the main door)";
  const altars = here.filter((r) => r.floor && hasTag(r.data, "altar"));
  if (!altars.length)
    warn(ctx, rm.id, "chapel-altar", `chapel ${rm.id} has no altar: add one against its ${whereText}, facing the nave ({ "kind": "auto", "room": "${rm.id}", "near": "${where}" }, an altar prop)`);
  for (const a of back ? altars : []) {
    const proj = (x: number, z: number): number => (x - back!.door[0]) * back!.facing[0] + (z - back!.door[1]) * back!.facing[1];
    const short = back!.depth - Math.max(...corners(a.floor!).map(([x, z]) => proj(x, z)));
    const f = fwd(a.box.yaw), faces = -(f[0] * back!.facing[0] + f[1] * back!.facing[1]);
    if (short > ALTAR_BACK + EPS)
      warn(ctx, a.work.id, "chapel-altar", `${a.work.prop} stands ${f2(short)} m short of chapel ${rm.id}'s ${whereText}: the altar stands against it, facing the nave ({ "kind": "auto", "room": "${rm.id}", "near": "${where}" })`);
    else if (faces < 0.7) warn(ctx, a.work.id, "chapel-altar", `${a.work.prop} at the back of chapel ${rm.id} does not face the nave (toward the main door): turn it ({ "kind": "auto", "room": "${rm.id}", "near": "${where}" } faces it right)`);
  }
  const altar = altars[0], pews = here.filter((r) => r.floor && isPew(r));
  const axis: V2 = altar ? fwd(altar.box.yaw) : back ? [-back.facing[0], -back.facing[1]] : [0, 1];
  // a pew faces the altar when it stands in front of it turned back up the nave (the outer seats of a wide front row too)
  const facing = altar
    ? pews.filter((p) => {
        const f = fwd(p.box.yaw), dx = p.box.cx - altar.box.cx, dz = p.box.cz - altar.box.cz;
        return dx * axis[0] + dz * axis[1] > 0 && f[0] * axis[0] + f[1] * axis[1] < -0.7;
      })
    : pews;
  let rows = 0, last = -Infinity;
  for (const v of facing.map((p) => p.box.cx * axis[0] + p.box.cz * axis[1]).sort((x, y) => x - y)) if (v - last > 0.4) [rows, last] = [rows + 1, v];
  if (rows < 2)
    warn(ctx, rm.id, "chapel-pews",
      `chapel ${rm.id} has ${!pews.length ? "no pews" : altar ? `${facing.length} pew(s) facing the altar in ${rows} row(s)` : `${pews.length} pew(s) and no altar to face`}: pews stand in 2+ rows, one behind ` +
        `another, facing the altar (each { "kind": "auto", "room": "${rm.id}", "prefer": "row", "near": "<the altar item>" }, after the altar)`);
  // the rows fill the nave, not a block at one end: they cover ROW_NAVE_SHARE of it from the altar step to the door line
  if (altar && facing.length) {
    const g = ctx.grids.get(level)!, at: V2 = [altar.box.cx, altar.box.cz];
    const nave = naveOf(ctx, g, level, rm.id, at, axis, altar.box.d / 2 + Math.max(altar.data.clearance, 0.3));
    const along = facing.map((p) => (p.box.cx - at[0]) * axis[0] + (p.box.cz - at[1]) * axis[1]);
    const span = Math.max(...along.map((a, i) => a + facing[i]!.box.d / 2)) - Math.min(...along.map((a, i) => a - facing[i]!.box.d / 2));
    const len = nave.end - nave.start, share = len > 0 ? span / len : 1;
    if (share < ROW_NAVE_SHARE - EPS) {
      const per = Math.max(1, Math.round(facing.length / Math.max(rows, 1))), need = Math.ceil((ROW_NAVE_SHARE * len - facing[0]!.box.d) / ROW_PITCH[1]) + 1;
      vio(ctx, rm.id, "chapel-pews",
        `chapel ${rm.id}'s ${facing.length} pews in ${rows} rows cover ${f2(span)} m of its ${f2(len)} m nave (${Math.round(share * 100)}%, altar step to the door line); ` +
          `rows fill at least ${Math.round(ROW_NAVE_SHARE * 100)}%: place them { "kind": "auto", "prefer": "row", "near": "${altar.work.group || altar.work.id}" } (the resolver spreads them ` +
          `${ROW_PITCH[0]}-${ROW_PITCH[1]} m apart) and plan about ${need * per} (${need} rows of ${per})`);
    }
  }
}

/** The owner's rulings of 2026-10-20, as checks (books are checked where they are laid, in resolveChildren). */
/**
 * `sign-over-door` (a violation): a hanging sign sits centred over its door (within SIGN_DOOR_DX of the door-sign anchor,
 * along the wall), under the eave (its top within the anchor's measured clear height, `size[1]`), and clear of every
 * window (the map's `window` anchors, with the opening's size) and every other wall prop.
 */
function signChecks(ctx: Ctx, placed: Res[]): void {
  const signAnchors = ctx.input.map.anchors.filter((a) => SIGN_ANCHORS.has(a.kind));
  const windows = ctx.input.map.anchors.filter((a) => a.kind === "window");
  const yRange = (b: Box): [number, number] => [b.y0, b.y0 + b.h];
  const yHit = (a: [number, number], b: [number, number]): boolean => Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > 0.02;
  for (const r of placed) {
    if (r.data.mount === "floor" && hasTag(r.data, "sign") && hasTag(r.data, "post")) { signPostCheck(ctx, r, windows); continue; }
    if (r.data.mount !== "wall" || !hasTag(r.data, "sign")) continue;
    const id = r.work.id, b = r.box, what = `${id} (${r.work.prop})`;
    const own = r.work.place.kind === "anchor" ? signAnchors.find((a) => a.id === (r.work.place as { anchor: string }).anchor) : undefined;
    const a = own ?? signAnchors.filter((x) => x.level === r.level).sort((p, q) => Math.hypot(p.position[0] - b.cx, p.position[2] - b.cz) - Math.hypot(q.position[0] - b.cx, q.position[2] - b.cz))[0];
    if (!a || Math.hypot(a.position[0] - b.cx, a.position[2] - b.cz) > 3) {
      if (r.outdoor) vio(ctx, id, "sign-over-door", `${what} is a hanging sign with no door-sign anchor within 3 m: a sign hangs over a building's door, beside it, or on a post; place it on its door-sign-<building> anchor`);
      continue;
    }
    const ay = a.yaw * DEG, t: V2 = [Math.cos(ay), -Math.sin(ay)];
    const along = (p: V3, q: { cx: number; cz: number } | V3): number => Array.isArray(q) ? (q[0] - p[0]) * t[0] + (q[2] - p[2]) * t[1] : (q.cx - p[0]) * t[0] + (q.cz - p[2]) * t[1];
    const projecting = hasTag(r.data, "projecting");
    if (BESIDE_ANCHORS.has(a.kind)) {
      // beside the door: a projecting sign, its bracket plate within SIGN_BESIDE_REACH of the door's edge
      if (!projecting) vio(ctx, id, "sign-over-door", `${what} hangs beside a door flat on the wall; beside a door only a PROJECTING sign (arm out of the wall, tag projecting) hangs; a flat sign goes over the door`);
      const door = ctx.input.map.anchors.find((x) => (x.kind === "door-sign" || x.kind === "sign-bracket") && x.id === a.id.replace(/-[lr]$/, ""));
      if (door) {
        const edge = Math.abs(along(door.position, a.position)) - (door.size?.[0] ?? 1.2) / 2;
        if (edge > SIGN_BESIDE_REACH + EPS) vio(ctx, id, "sign-over-door", `${what}'s bracket is ${edge.toFixed(2)} m from the edge of its door; a sign hangs over the door, or beside it within ${SIGN_BESIDE_REACH} m of its edge`);
      }
    } else {
      const dx = along(a.position, b);
      if (Math.abs(dx) > SIGN_DOOR_DX + EPS) vio(ctx, id, "sign-over-door", `${what} is ${Math.abs(dx).toFixed(2)} m along the wall from the centre of its door (anchor ${a.id}); a sign hangs centred over the door (<= ${SIGN_DOOR_DX} m) or beside it on a projecting arm: use the door-sign or door-sign-<building>-l/-r anchor`);
    }
    if (a.size && b.y0 + b.h > a.position[1] + a.size[1] + 0.01)
      vio(ctx, id, "sign-over-door", `${what} reaches ${(b.y0 + b.h - a.position[1]).toFixed(2)} m above its anchor ${a.id}, but the eave/roof overhang leaves ${a.size[1].toFixed(2)} m: hang a projecting sign beside the door (its door-sign-<building>-l/-r anchor) instead`);
    const rect = rectOf(b), ys = yRange(b);
    for (const wn of windows) {
      if (!wn.size) continue;
      // the opening plus 0.5 m in front of it: a sign hanging there covers the window
      // (a projecting sign also keeps 0.3 m to the side of a window: its board would sit across the window's edge)
      const wy = wn.yaw * DEG, f = fwd(wy), wr: Rect = { cx: wn.position[0] + f[0] * 0.25, cz: wn.position[2] + f[1] * 0.25, hw: wn.size[0] / 2 + (projecting ? 0.3 : 0), hd: 0.25, yaw: wy };
      const h = wn.size[1];
      if (overlapDepth(rect, wr) > 0.01 && yHit(ys, [wn.position[1] - h / 2, wn.position[1] + h / 2]))
        vio(ctx, id, "sign-over-door", `${what} hangs in front of window ${wn.id}: a sign hangs over or beside the door, clear of every window`);
    }
    for (const o of placed) {
      if (o === r || o.data.mount !== "wall" || o.level !== r.level) continue;
      if (overlapDepth(rect, rectOf(o.box)) > 0.01 && yHit(ys, yRange(o.box))) vio(ctx, id, "sign-over-door", `${what} runs into wall prop ${o.work.id} (${o.work.prop})`);
    }
  }
}

/** The third form of `sign-over-door`: a freestanding sign post beside a door (SIGN_POST_REACH from its edge), clear of windows. */
function signPostCheck(ctx: Ctx, r: Res, windows: readonly SocketAnchor[]): void {
  const id = r.work.id, b = r.box, what = `${id} (${r.work.prop})`;
  const doors = ctx.input.map.anchors.filter((a) => a.kind === "door-sign" || a.kind === "sign-bracket");
  const own = r.work.place.kind === "anchor" ? (r.work.place as { anchor: string }).anchor.replace(/-post-[lr]$/, "") : "";
  const door = doors.find((a) => a.id === own) ?? [...doors].sort((p, q) => Math.hypot(p.position[0] - b.cx, p.position[2] - b.cz) - Math.hypot(q.position[0] - b.cx, q.position[2] - b.cz))[0];
  if (!door || Math.hypot(door.position[0] - b.cx, door.position[2] - b.cz) > 4) {
    if (r.outdoor) vio(ctx, id, "sign-over-door", `${what} is a sign post with no door within 4 m: a sign post stands beside a building's door (its door-sign-<building>-post-l/-r anchor)`);
    return;
  }
  const ay = door.yaw * DEG, t: V2 = [Math.cos(ay), -Math.sin(ay)];
  const edge = Math.abs((b.cx - door.position[0]) * t[0] + (b.cz - door.position[2]) * t[1]) - (door.size?.[0] ?? 1.2) / 2;
  if (edge < SIGN_POST_REACH[0] - EPS || edge > SIGN_POST_REACH[1] + EPS)
    vio(ctx, id, "sign-over-door", `${what} stands ${edge.toFixed(2)} m from the edge of door ${door.id}; a sign post stands ${SIGN_POST_REACH[0]}-${SIGN_POST_REACH[1]} m beside the door (its door-sign-<building>-post-l/-r anchor)`);
  const rect = rectOf(b);
  for (const wn of windows) {
    if (!wn.size || wn.position[1] - wn.size[1] / 2 > door.position[1] + 1.5) continue; // upper-floor windows are above the board
    const wy = wn.yaw * DEG, f = fwd(wy), wr: Rect = { cx: wn.position[0] + f[0] * 0.75, cz: wn.position[2] + f[1] * 0.75, hw: wn.size[0] / 2 + 0.3, hd: 0.75, yaw: wy };
    if (overlapDepth(rect, wr) > 0.01) vio(ctx, id, "sign-over-door", `${what} stands in front of window ${wn.id}: a sign post goes on the window-free side of the door`);
  }
}

function ruleChecks(ctx: Ctx, placed: Res[]): void {
  const plan = ctx.input.plan;
  for (const r of placed) {
    const d = r.data;
    if (d.neverInDoorLine && r.floor) {
      const hit = doorLineHit(ctx, r.level, r.floor);
      if (hit)
        vio(ctx, r.work.id, "door-line",
          `${r.work.prop} stands in the line of the ${hit.label} (its clear width carried ${DOOR_LINE} m into the room): a lectern or podium is never planted in front of a door; ` +
            `put it against a side wall or at the far end (auto places skip door lines)`);
    }
    if (hasTag(d, "sign") && r.room && !r.outdoor && !r.outdoorAnchor) {
      const here = ctx.input.map.anchors.filter((a) => SIGN_ANCHORS.has(a.kind) && a.mount === d.mount).map((a) => a.id);
      vio(ctx, r.work.id, "sign-indoors",
        `${r.work.prop} is a sign inside room ${r.room}: signs are exterior only and hang above a building's door (the town exterior's door-sign-<building> anchor` +
          `${here.length ? `, or this map's ${here.join(", ")}` : ""}); take it out of the room`);
    }
    if (hasTag(d, "candelabra") && d.mount === "floor" && r.floor && !candelabraExempt(r, placed))
      for (const t of placed) {
        if (t === r || !t.floor || t.level !== r.level || !isTable(t.data)) continue;
        const gap = Math.max(0, -overlapDepth(r.floor, t.floor));
        if (gap >= CANDELABRA_TABLE_GAP - EPS) continue;
        vio(ctx, r.work.id, "candelabra-table",
          `${r.work.prop} stands ${f2(gap)} m from ${t.work.id} (${t.work.prop}): a standing candelabra never stands beside a table. The table's light is the LOW candelabra ` +
            `(a surface candelabra placed { "kind": "on", "item": "${t.work.group || t.work.id}" }); a standing one goes against a wall, in a corner or by the altar (auto prefer "wall"/"corner", or near the altar)`);
        break;
      }
  }
  for (const [level, g] of ctx.grids)
    for (const rm of g.lv.rooms) {
      const spec = plan.rooms[rm.id];
      if (!spec) continue;
      const here = placed.filter((r) => r.level === level && r.room === rm.id);
      if (roomRoles(ctx, rm.id).includes("chapel")) chapelCheck(ctx, level, rm, here);
      graveyardCheck(ctx, level, rm, here, placeableFloor(g.lv).find((x) => x.room === rm.id)?.placeable ?? rm.area);
      const hung = here.filter((r) => isChandelier(r.data)).length, wanted = chandeliersWanted(rm);
      if (wantsChandelier(ctx, rm) && hung < wanted)
        warn(ctx, rm.id, "no-chandelier",
          `room ${rm.id} (${spec.role}, ${f2(rm.area)} m², ridge ${f2(rm.maxHead)} m) is tall-roofed and has ${hung ? `${hung} chandelier(s)` : "no chandelier"}: ` +
            (wanted > 1
              ? `a long hall hangs a line of ${wanted} under its ridge, ${CEILING_LINE[0]}-${CEILING_LINE[1]} m apart (each { "kind": "auto", "room": "${rm.id}", "near": "ceiling-centre" } takes the next spot)`
              : `hang one at its ceiling centre ({ "kind": "auto", "room": "${rm.id}", "near": "ceiling-centre" }, a chandelier prop)`));
    }
}

// ---- outdoor LAYOUT: vignettes (owner walk 2026-10-21) ---------------------------------------------------------------
// "Pretty much all of them just look like clutter in a small area, they don't look designed... is it looking for a small
// square place to put things?": an outdoor area went through the room resolver (prefer wall / open on its socket map), so
// its props piled into one patch. A site is laid out in VIGNETTES instead: a camp round its fire, a work line along the
// shore, a yard before a hut, a shrine, a midden at the back, a lookout on the crest; each by its own rule, spread over
// the area 6-12 m apart, 2 m off the walking lanes and door lines.

/** Unanchored vignettes stand this far apart, centre to centre (closer is refused, farther only when the area is that big). */
export const VIGNETTE_SPACING: readonly [number, number] = [6, 12];
/** A vignette's members keep this far off a walking lane's edge (the approach, the footpaths) and a door line. */
export const VIGNETTE_LANE_M = 2;
/** Camp seats/logs stand this far off the fire's edge, facing it. */
export const CAMP_SEAT_GAP: readonly [number, number] = [1.2, 1.8];
/** Camp tents/bedrolls stand this far off the fire's edge, their doors toward it. */
export const CAMP_TENT_GAP: readonly [number, number] = [3, 5];
/** A work line's racks/frames/benches stand this far apart along their edge. */
export const WORK_PITCH: readonly [number, number] = [1.5, 2.5];
/** Nothing solid stands within this many metres in front of a door, an opening or a hallway mouth (`opening-clear`), indoors and out. */
// 1.2 m until the owner walk of 2026-10-27 ("remove anything a few grid tiles away from a door in a house"): 2 m, both sides
export const OPENING_CLEAR = 2.0;
/** Outdoor density: the fewest props per 100 m² of an area's placeable ground, by area role (`site-sparse`); at least 2. */
export const SITE_DENSITY: Readonly<Record<string, number>> = { camp: 1.2, yard: 1.0, ruin: 1.0, shore: 0.6, path: 0.4, "cave-mouth": 0.8 };
/** Outdoor density cap: the most props per 100 m² of placeable ground (`site-dense`). */
export const SITE_DENSITY_CAP = 6;
/** `site-spread`: no SITE_CELL_M x SITE_CELL_M cell of an area holds more than SITE_SPREAD of its props (vignette members excepted). */
export const SITE_CELL_M = 5;
export const SITE_SPREAD = 0.35;
/** `site-clutter`: a prop in no vignette with SITE_CLUTTER_N or more others within SITE_CLUTTER_R m is clutter. */
export const SITE_CLUTTER_R = 3;
export const SITE_CLUTTER_N = 6;
/** Outdoors a loose `prefer: "open"` piece is scored up to this many metres away from what already stands (spread, not heaped). */
export const SITE_OPEN_SPREAD = 8;
/** Rough radius of each vignette kind's footprint, metres (spacing, lane keep and the centre's open-ground test). */
export const VIGNETTE_RADIUS: Readonly<Record<ArrangementKind, number>> = { camp: 6, "work-line": 5, yard: 5, shrine: 3, midden: 3, lookout: 2.5, graveyard: 0 };

/** The role an item plays in its vignette when the plan names none: read from the prop's id and declaration. */
export function arrangementPart(kind: ArrangementKind, prop: string, d: DressingData): string {
  const id = prop.toLowerCase();
  const fire = d.fire || /fire|brazier|pyre|hearth|bonfire|firepit/.test(id);
  const seat = d.use.includes("seat") || /seat|stool|log|bench|chair|stump/.test(id);
  const tent = d.category === "bedding" || /tent|bedroll|lean-to|shelter|bedding/.test(id);
  switch (kind) {
    case "camp":
      return fire ? "centre" : seat ? "seat" : tent ? "tent" : "kit";
    case "work-line":
      return isLooseClutter(d) ? "end" : "line";
    case "yard":
      return /cart|wagon|barrow/.test(id) ? "cart" : /bench|table|anvil|block|trestle/.test(id) ? "bench" : /tool|axe|saw|hammer|grind|whet/.test(id) ? "tool" : "front";
    case "shrine":
      return hasTag(d, "altar") || /altar|cairn|shrine|idol|statue|totem|standing-stone|monolith/.test(id) ? "centre" : "offering";
    case "midden":
      return "heap";
    case "lookout":
      return "seat";
    case "graveyard":
      return "grave";
  }
}

/** One laid-out vignette: where it stands, which way its front looks, and the edge it lines (work-line, yard). */
interface Vignette {
  id: string;
  kind: ArrangementKind;
  room: string;
  level: number;
  centre: V2;
  /** Unit vector its front looks along. */
  facing: V2;
  /** Radius of the thing at its centre (the fire's edge, the structure's footprint), metres. */
  core: number;
  /** The edge it lines: a point on it, its normal into the vignette, and whether the line faces the edge (water). */
  edge?: { base: V2; n: V2; faceIn: boolean };
  /** Where the walking route enters the area (the cart's gate). */
  entry: V2;
  /** A camp's tents that are STRUCTURES (site anchors `structure-*tent*|shelter|hut|lean-to`): its kit piles beside them. */
  tents: { at: V2; r: number }[];
  /** How it was placed, for the auto note. */
  how: string;
}

const nrm = (v: V2): V2 => {
  const l = Math.hypot(v[0], v[1]);
  return l < EPS ? [0, 1] : [v[0] / l, v[1] / l];
};
const segDist = (p: V2, a: V2, b: V2): number => {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
};
/** Metres from a point to the nearest walking lane's EDGE (the level's paths) and door line (a door anchor carried DOOR_LINE m out). */
function laneClearance(ctx: Ctx, level: number, p: V2): number {
  const g = ctx.grids.get(level)!;
  let d = Infinity;
  for (const path of g.lv.paths ?? []) {
    const pts = path.points;
    for (let i = 0; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i]!, pts[Math.min(i + 1, pts.length - 1)]!) - path.width / 2);
  }
  for (const a of ctx.input.map.anchors) {
    if (a.level !== level || (a.kind !== "door" && a.kind !== "cave-mouth")) continue;
    const f = fwd(a.yaw * DEG), o: V2 = [a.position[0], a.position[2]];
    d = Math.min(d, segDist(p, o, [o[0] + f[0] * DOOR_LINE, o[1] + f[1] * DOOR_LINE]) - 0.8);
  }
  return d;
}

/** The free floor cells of a room ('o' / '.'), as centres. */
function freeCells(g: Grid, room: string): V2[] {
  const out: V2[] = [];
  for (let r = 0; r < g.lv.rows; r++)
    for (let c = 0; c < g.lv.columns; c++) {
      const ch = g.ch(c, r);
      if ((ch === "o" || ch === ".") && g.roomAt(c, r) === room) out.push(g.centre(c, r));
    }
  return out;
}
/** Where the walking route enters the room: an `approach-end` anchor, else the middle of its entry ('E') cells, else its door. */
function entryPoint(ctx: Ctx, level: number, room: string): V2 | undefined {
  const g = ctx.grids.get(level)!;
  const a = ctx.input.map.anchors.find((x) => x.level === level && x.kind === "approach-end" && (x.id.startsWith(`${room}/`) || !x.id.includes("/")));
  if (a) return [a.position[0], a.position[2]];
  let sx = 0, sz = 0, n = 0;
  for (let r = 0; r < g.lv.rows; r++)
    for (let c = 0; c < g.lv.columns; c++)
      if (g.ch(c, r) === "E" && g.roomAt(c, r) === room) {
        const [x, z] = g.centre(c, r);
        [sx, sz, n] = [sx + x, sz + z, n + 1];
      }
  if (n) return [sx / n, sz / n];
  return doorOf(ctx, level, room)?.at;
}

/** A plan anchor reference -> a point, facing and size, or why not. */
function vignetteAnchor(ctx: Ctx, level: number, room: string, ref: string, out: Map<string, Res>, setAnchor: Map<string, string>): { at: V2; facing?: V2; radius: number; kind: string } | string {
  if (ref.startsWith("item:")) {
    const id = ref.slice(5), it = out.get(id) ?? out.get(setAnchor.get(id) ?? "");
    if (!it) return `anchor "${ref}": item "${id}" is not placed before this vignette's first member (items resolve in plan order)`;
    return { at: [it.box.cx, it.box.cz], facing: fwd(it.box.yaw), radius: Math.max(it.box.w, it.box.d) / 2, kind: "item" };
  }
  const anchors = ctx.input.map.anchors.filter((a) => a.level === level);
  let id = ref;
  const st = /^structure:(\S+)(\s+front)?$/.exec(ref);
  if (st) id = `${room}/${st[2] ? "front" : "structure"}-${st[1]}`;
  let a: SocketAnchor | undefined;
  if (ref.startsWith("kind:")) {
    const k = ref.slice(5), rm = ctx.grids.get(level)!.lv.rooms.find((r) => r.id === room)!;
    const mine = (x: SocketAnchor): number => (x.id.startsWith(`${room}/`) ? 0 : 1);
    const dc = (x: SocketAnchor): number => Math.hypot(x.position[0] - rm.centre[0], x.position[2] - rm.centre[1]);
    a = anchors.filter((x) => x.kind === k).sort((x, y) => mine(x) - mine(y) || dc(x) - dc(y))[0];
  } else a = anchors.find((x) => x.id === id) ?? anchors.find((x) => x.id === `${room}/${id}`);
  if (!a) {
    const near = anchors.filter((x) => x.id.startsWith(`${room}/`) && !/^(edge|path-side|hearth-seat)/.test(x.id.slice(room.length + 1))).map((x) => x.id);
    return `anchor "${ref}" is not an anchor of map "${ctx.input.map.id}" on level ${level}${near.length ? ` (room ${room} has ${near.join(", ")})` : ""}: re-measure with site-sockets or name another`;
  }
  return { at: [a.position[0], a.position[2]], facing: fwd(a.yaw * DEG), radius: a.size ? Math.max(a.size[0], a.size[2]) / 2 : 0, kind: a.kind };
}

/** Lay out every vignette of a room once: anchored ones on their anchors, the rest spread along the room's long axis. */
function vignettesOf(ctx: Ctx, level: number, room: string, out: Map<string, Res>, setAnchor: Map<string, string>): void {
  const key = `${level}|${room}`;
  if (ctx.vignetteRooms.has(key)) return;
  ctx.vignetteRooms.add(key);
  const g = ctx.grids.get(level)!, rm = g.lv.rooms.find((r) => r.id === room)!;
  const specs = (ctx.input.plan.arrangements ?? []).filter((a) => a.room === room);
  const entry = entryPoint(ctx, level, room) ?? ([rm.centre[0], rm.centre[1] - 1] as V2);
  const free = freeCells(g, room);
  const placed: V2[] = [];
  const facingOf = (spec: DressingArrangement, c: V2, anchorFacing?: V2): V2 => {
    const f = spec.facing ?? (spec.kind === "lookout" ? "out" : spec.kind === "midden" ? "in" : (spec.kind === "yard" || spec.kind === "work-line") && anchorFacing ? "anchor" : "approach");
    if (Array.isArray(f)) return nrm(f as V2);
    if (f === "anchor" && anchorFacing) return nrm(anchorFacing);
    const toC = nrm([rm.centre[0] - c[0], rm.centre[1] - c[1]]);
    if (f === "in") return toC;
    if (f === "out") return [-toC[0], -toC[1]];
    const e: V2 = [entry[0] - c[0], entry[1] - c[1]];
    return Math.hypot(e[0], e[1]) < 1 ? toC : nrm(e);
  };
  const placedR: number[] = [];
  const tentsNear = (c: V2): { at: V2; r: number }[] =>
    ctx.input.map.anchors
      .filter((a) => a.level === level && a.kind === "structure" && /tent|shelter|hut|lean-to/.test(a.id) && Math.hypot(a.position[0] - c[0], a.position[2] - c[1]) < 10)
      .map((a) => ({ at: [a.position[0], a.position[2]] as V2, r: a.size ? Math.max(a.size[0], a.size[2]) / 2 : 1.5 }));
  const set = (spec: DressingArrangement, v: Omit<Vignette, "id" | "kind" | "room" | "level" | "entry" | "tents">): void => {
    ctx.vignettes.set(spec.id, { id: spec.id, kind: spec.kind, room, level, entry, tents: spec.kind === "camp" ? tentsNear(v.centre) : [], ...v });
    placed.push(v.centre);
    placedR.push(VIGNETTE_RADIUS[spec.kind] + v.core);
  };
  // anchored (or fixed) first
  for (const spec of specs) {
    if (spec.kind === "graveyard") {
      ctx.vignettes.set(spec.id, { id: spec.id, kind: spec.kind, room, level, entry, tents: [], centre: rm.centre, facing: [0, 1], core: 0, how: "graves in rows" });
      continue;
    }
    if (spec.at) {
      set(spec, { centre: [spec.at[0], spec.at[1]], facing: facingOf(spec, spec.at as V2), core: 0, how: `at ${at2(spec.at[0], spec.at[1])}` });
      continue;
    }
    if (!spec.anchor) continue;
    const a = vignetteAnchor(ctx, level, room, spec.anchor, out, setAnchor);
    if (typeof a === "string") {
      ctx.vignettes.set(spec.id, a);
      continue;
    }
    const lining = spec.kind === "work-line" || spec.kind === "yard";
    // a water-edge pitch faces the water: the line's normal points back from it and its racks face the water
    const water = a.kind === "water-edge";
    const n: V2 = a.facing ? (water ? [-a.facing[0], -a.facing[1]] : a.facing) : nrm([rm.centre[0] - a.at[0], rm.centre[1] - a.at[1]]);
    const centre: V2 = lining ? [a.at[0] + n[0] * 2.5, a.at[1] + n[1] * 2.5] : a.at;
    set(spec, { centre, facing: facingOf(spec, centre, n), core: a.radius, ...(lining ? { edge: { base: a.at, n, faceIn: water } } : {}), how: `on ${spec.anchor}` });
  }
  // the rest spread along the long axis (a midden at the back edge, a lookout on the crest)
  const rest = specs.filter((s) => s.kind !== "graveyard" && !s.anchor && !s.at);
  if (!rest.length) return;
  let mx = 0, mz = 0;
  for (const p of free) [mx, mz] = [mx + p[0], mz + p[1]];
  const N = Math.max(1, free.length);
  [mx, mz] = [mx / N, mz / N];
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of free) {
    const dx = p[0] - mx, dz = p[1] - mz;
    [sxx, szz, sxz] = [sxx + dx * dx, szz + dz * dz, sxz + dx * dz];
  }
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz), ax: V2 = [Math.cos(th), Math.sin(th)], lat: V2 = [-ax[1], ax[0]];
  const along = free.map((p) => (p[0] - mx) * ax[0] + (p[1] - mz) * ax[1]).sort((a, b) => a - b);
  const a0 = along[Math.floor(along.length * 0.05)] ?? 0, a1 = along[Math.floor(along.length * 0.95)] ?? 0;
  const openShare = (c: V2, r: number): number => {
    let n = 0, ok = 0;
    for (let dz = -r; dz <= r + EPS; dz += 0.5)
      for (let dx = -r; dx <= r + EPS; dx += 0.5) {
        if (dx * dx + dz * dz > r * r) continue;
        n++;
        const [cc, rr] = g.cellOf(c[0] + dx, c[1] + dz), ch = g.ch(cc, rr);
        if ((ch === "o" || ch === ".") && g.roomAt(cc, rr) === room) ok++;
      }
    return n ? ok / n : 0;
  };
  const samples = free.filter((_, i) => i % 3 === 0);
  const back = nrm([mx - entry[0], mz - entry[1]]);
  rest.forEach((spec, i) => {
    const R = VIGNETTE_RADIUS[spec.kind];
    const t = rest.length === 1 ? (a0 + a1) / 2 : a0 + ((i + 0.5) / rest.length) * (a1 - a0);
    const target: V2 = [mx + ax[0] * t, mz + ax[1] * t];
    let best: V2 | undefined, bestS = Infinity;
    for (const p of samples) {
      const lane = laneClearance(ctx, level, p);
      if (lane < VIGNETTE_LANE_M + 1 - EPS) continue;
      const share = openShare(p, Math.min(2, R * 0.5));
      if (share < 0.6) continue;
      // spacing: centre to centre, and clear of each placed vignette's own footprint (a camp's ring reaches past 6 m)
      const nearest = placed.length ? Math.min(...placed.map((q) => Math.hypot(q[0] - p[0], q[1] - p[1]))) : Infinity;
      const crowd = placed.length ? Math.max(...placed.map((q, j) => (placedR[j]! + R) * 0.7 - Math.hypot(q[0] - p[0], q[1] - p[1]))) : -Infinity;

      let s: number;
      if (spec.kind === "midden") s = -((p[0] - entry[0]) * back[0] + (p[1] - entry[1]) * back[1]); // the back edge: farthest from the approach
      else if (spec.kind === "lookout") s = -((p[0] - mx) * back[0] + (p[1] - mz) * back[1]) - 0.3 * Math.hypot(p[0] - mx, p[1] - mz); // the crest: out past the far side
      else s = Math.hypot(p[0] - target[0], p[1] - target[1]) * 0.5 + Math.abs((p[0] - mx) * lat[0] + (p[1] - mz) * lat[1]) * 0.2;
      if (nearest < VIGNETTE_SPACING[0]) s += 100 + (VIGNETTE_SPACING[0] - nearest) * 10;
      else if (nearest > VIGNETTE_SPACING[1] && Number.isFinite(nearest)) s += (nearest - VIGNETTE_SPACING[1]) * 0.5;
      if (crowd > 0) s += 50 + crowd * 10;
      s += (1 - share) * 4 - Math.min(lane, 6) * 0.2;
      if (s < bestS) [best, bestS] = [p, s];
    }
    if (!best) {
      ctx.vignettes.set(spec.id, `vignette "${spec.id}" (${spec.kind}) finds no open ground in room ${room} ${VIGNETTE_LANE_M + 1} m off every walking lane and door line: anchor it (\`anchor\`) or widen the area`);
      return;
    }
    const b = best, near = placed.length ? Math.min(...placed.map((q) => Math.hypot(q[0] - b[0], q[1] - b[1]))) : Infinity;
    set(spec, { centre: b, facing: facingOf(spec, b), core: 0, how: `spread${Number.isFinite(near) ? `, ${f2(near)} m from the next` : " on the long axis"}` });
  });
}

/** The vignette an item belongs to (laid out with its room's others on first use), or why it cannot be. */
function vignetteFor(ctx: Ctx, level: number, room: string, id: string, out: Map<string, Res>, setAnchor: Map<string, string>): Vignette | string {
  const spec = (ctx.input.plan.arrangements ?? []).find((a) => a.id === id);
  if (!spec) return `arrangement "${id}" is not in plan.arrangements`;
  if (spec.room !== room) return `arrangement "${id}" stands in room ${spec.room}, not ${room}`;
  vignettesOf(ctx, level, room, out, setAnchor);
  return ctx.vignettes.get(id) ?? `arrangement "${id}" was not laid out`;
}

/** This member's index among its vignette's members of the same part (plan order), and how many the plan has. */
function partIndex(ctx: Ctx, w: Work, v: Vignette, part: string): { k: number; n: number } {
  let k = -1, n = 0;
  for (const it of ctx.input.plan.items) {
    const p = it.place;
    if (p.kind !== "auto" || p.arrangement !== v.id) continue;
    const d = it.prop ? ctx.input.prop(it.prop) : undefined;
    const pt = p.part ?? (d ? arrangementPart(v.kind, it.prop, d) : "kit");
    if (pt !== part) continue;
    if (it.id === (w.group || w.id)) k = n;
    n++;
  }
  return { k: Math.max(0, k), n: Math.max(1, n) };
}

/** Candidate spots (map XZ + yaw radians) for one vignette member, best first. */
function vignetteSlots(v: Vignette, part: string, k: number, n: number, d: DressingData, mates: Res[]): { at: V2; yaw: number }[] {
  const out: { at: V2; yaw: number }[] = [];
  const c = v.centre, f = v.facing, side: V2 = [f[1], -f[0]], depth = Math.max(d.size[0], d.size[2]) / 2;
  const ang0 = Math.atan2(f[1], f[0]);
  const polar = (r: number, a: number): V2 => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
  const facingC = (p: V2): number => yawOf([c[0] - p[0], c[1] - p[1]]);
  // member k of n takes its share of the arc first, then the neighbouring angles
  const ring = (radii: number[], arc0: number, arc1: number): void => {
    const base = arc0 + ((k + 0.5) / n) * (arc1 - arc0), steps = [0, 1, -1, 2, -2, 3, -3, 4, -4, 6, -6, 8, -8, 10, -10, 12];
    for (const s of steps)
      for (const r of radii) {
        const p = polar(r, base + s * (Math.PI / 24));
        out.push({ at: p, yaw: facingC(p) });
      }
  };
  const lineAt = (base: V2, n0: V2, off: number, t: number, yaw: number): { at: V2; yaw: number } => {
    const u: V2 = [n0[1], -n0[0]];
    return { at: [base[0] + n0[0] * off + u[0] * t, base[1] + n0[1] * off + u[1] * t], yaw };
  };
  const core = Math.max(v.core, ...mates.filter((m) => m.work.vpart === "centre").map((m) => Math.max(m.box.w, m.box.d) / 2));
  switch (v.kind) {
    case "camp": {
      if (part === "centre") {
        for (let r = 0; r <= 3; r += 0.5) for (let i = 0; i < (r ? 8 : 1); i++) out.push({ at: polar(r, ang0 + (i * Math.PI) / 4), yaw: yawOf(f) });
        break;
      }
      // the approach side (its front) stays open: seats round the far 240 degrees, tents round the back half
      if (part === "seat") {
        ring([1.5, 1.3, 1.7, 1.2, 1.8].map((x) => core + depth + x), ang0 + Math.PI / 3, ang0 + (5 * Math.PI) / 3);
        break;
      }
      if (part === "tent") {
        ring([4, 3.5, 4.5, 3, 5].map((x) => core + depth + x), ang0 + Math.PI / 2, ang0 + (3 * Math.PI) / 2);
        break;
      }
      // kit: beside a tent (a placed tent member, else a tent that is a structure), else on the tent ring
      const tents = [...mates.filter((m) => m.work.vpart === "tent").map((m) => ({ at: [m.box.cx, m.box.cz] as V2, r: Math.max(m.box.w, m.box.d) / 2 })), ...v.tents];
      for (let i = 0; i < tents.length; i++) {
        const t = tents[(k + i) % tents.length]!, r = Math.hypot(t.at[0] - c[0], t.at[1] - c[1]), a = Math.atan2(t.at[1] - c[1], t.at[0] - c[0]);
        const off = (t.r + depth + 0.6) / Math.max(r, 1);
        for (const s of [1, -1, 1.5, -1.5]) {
          const p = polar(r, a + s * off);
          out.push({ at: p, yaw: facingC(p) });
        }
      }
      ring([3.2, 3.8, 2.8, 4.4].map((x) => core + depth + x), ang0 + Math.PI / 2, ang0 + (3 * Math.PI) / 2);
      break;
    }
    case "work-line":
    case "yard": {
      const e = v.edge ?? { base: [c[0] - f[0] * 2.5, c[1] - f[1] * 2.5] as V2, n: f, faceIn: false };
      const face = e.faceIn ? yawOf([-e.n[0], -e.n[1]]) : yawOf(e.n);
      if (v.kind === "work-line" || part === "front") {
        const pitches = v.kind === "work-line" ? [2, 1.75, 2.25, 1.5, 2.5] : [1.1, 1.3, 1.6];
        // member k's own slot on the line first; where the edge is blocked the whole line slides along it a slot at a time
        // (the members keep the pitch between them), then steps out from the edge
        const lineN = mates.filter((m) => m.work.vpart === "line").length || 1;
        for (const shift of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5])
          for (const off of [0.6, 1.0, 1.5, 2.2])
            for (const pitch of pitches) {
              const t = part === "end" ? (k % 2 ? -1 : 1) * (((lineN - 1) / 2) * 2 + 1.6 + Math.floor(k / 2) * 1.1) + shift * pitch : (k - (n - 1) / 2 + shift) * pitch;
              out.push(lineAt(e.base, e.n, off + d.size[2] / 2, t, face));
            }
        break;
      }
      if (part === "cart") {
        const into = nrm([c[0] - v.entry[0], c[1] - v.entry[1]]), sd: V2 = [into[1], -into[0]];
        for (const dIn of [3.5, 4.5, 5.5, 2.8, 6.5]) for (const s of [2.6, -2.6, 3.4, -3.4, 4.2, -4.2]) out.push({ at: [v.entry[0] + into[0] * dIn + sd[0] * s, v.entry[1] + into[1] * dIn + sd[1] * s], yaw: yawOf(into) });
        break;
      }
      const bench = mates.find((m) => m.work.vpart === "bench");
      if (part === "tool" && bench) {
        const b: V2 = [bench.box.cx, bench.box.cz], u = fwd(bench.box.yaw + Math.PI / 2), off = bench.box.w / 2 + depth + 0.4;
        for (const s of [1, -1, 1.6, -1.6]) out.push({ at: [b[0] + u[0] * off * s, b[1] + u[1] * off * s], yaw: bench.box.yaw });
      }
      for (const sgn of [1, -1]) for (const dd of [2.5, 3.2, 4]) out.push(lineAt(e.base, e.n, dd, sgn * (2.5 + k * 1.2), face));
      break;
    }
    case "shrine": {
      if (part === "centre") {
        for (let r = 0; r <= 2; r += 0.5) for (let i = 0; i < (r ? 8 : 1); i++) out.push({ at: polar(r, ang0 + (i * Math.PI) / 4), yaw: yawOf(f) });
        break;
      }
      ring([1.6, 1.3, 2.0, 2.2].map((x) => core + depth + x), ang0 - Math.PI / 3, ang0 + Math.PI / 3);
      break;
    }
    case "midden": {
      const ga = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < 40; i++) {
        const j = (k + i) % 40, r = 1.1 * Math.sqrt(j + 0.3) + depth * 0.5;
        out.push({ at: polar(r, j * ga), yaw: yawOf(f) + j * 0.8 });
      }
      break;
    }
    case "lookout": {
      for (const s of [0, 1, -1, 2, -2, 3, -3])
        for (const back of [0, 0.6, 1.2]) {
          const t = (k - (n - 1) / 2 + s) * 1.4;
          out.push({ at: [c[0] + side[0] * t - f[0] * back, c[1] + side[1] * t - f[1] * back], yaw: yawOf(f) });
        }
      break;
    }
    case "graveyard":
      break;
  }
  return out;
}

/** The yaw a vignette member should face by its part's rule (`facing-sense`), radians; undefined when its part has none. */
function partFacing(v: Vignette, part: string, at: V2): { yaw: number; what: string } | undefined {
  const toC = yawOf([v.centre[0] - at[0], v.centre[1] - at[1]]);
  if (v.kind === "camp" && (part === "seat" || part === "tent")) return { yaw: toC, what: "the fire" };
  if (v.kind === "shrine" && part === "offering") return { yaw: toC, what: "the shrine" };
  if (v.kind === "lookout") return { yaw: yawOf(v.facing), what: "the view" };
  if (v.kind === "work-line" && part === "line" && v.edge) return { yaw: yawOf(v.edge.faceIn ? [-v.edge.n[0], -v.edge.n[1]] : v.edge.n), what: v.edge.faceIn ? "the water" : "square off its edge" };
  return undefined;
}
const angleOff = (a: number, b: number): number => Math.abs((((a - b + 3 * Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);

// ---- openings: nothing in front of a door, an opening or a hallway mouth, indoors and out ---------------------------
// Derek saw props in front of hallway openings in dungeons too: the doorway hard buffer (0.6 m all round) let a crate stand
// in a doorway's walk line. OPENING_CLEAR m in front of every doorway ('D'), building entry, and outdoor door / cave mouth
// is clear of solid props.
interface Opening {
  rect: Rect;
  label: string;
}
function openingsOf(ctx: Ctx, level: number): Opening[] {
  const have = ctx.openings.get(level);
  if (have) return have;
  const g = ctx.grids.get(level), out: Opening[] = [];
  if (g) {
    const site = ctx.input.plan.space?.kind === "site" || !!g.lv.ground;
    for (const l of doorLinesOf(ctx, level)) {
      if (site && l.label.startsWith("entry")) continue; // an outdoor area's rim entry is its approach lane (the lanes keep it)
      // a door line carries DOOR_LINE m along its walk axis: cut back to OPENING_CLEAR
      const r = l.rect, cut = DOOR_LINE - OPENING_CLEAR;
      out.push({ rect: r.hw > r.hd ? { ...r, hw: r.hw - cut } : { ...r, hd: r.hd - cut }, label: l.label });
    }
    for (const a of ctx.input.map.anchors) {
      if (a.level !== level || (a.kind !== "door" && a.kind !== "cave-mouth")) continue;
      const f = fwd(a.yaw * DEG), half = a.kind === "cave-mouth" ? 2 : 1, mid = (OPENING_CLEAR - 0.5) / 2;
      // the anchor stands just outside the opening: the clear box runs from 0.5 m behind it to OPENING_CLEAR in front
      out.push({ rect: { cx: a.position[0] + f[0] * mid, cz: a.position[2] + f[1] * mid, hw: half, hd: (OPENING_CLEAR + 0.5) / 2, yaw: a.yaw * DEG }, label: `${a.kind} ${a.id}` });
    }
  }
  ctx.openings.set(level, out);
  return out;
}
function openingHit(ctx: Ctx, level: number, r: Rect): Opening | undefined {
  return openingsOf(ctx, level).find((o) => overlapDepth(r, o.rect) > 0.05);
}

/**
 * `opening-clear` everywhere; vignette `facing-sense`; and on an outdoor site (plan `space.kind` "site"): density by area
 * (`site-sparse` / `site-dense`), spread (`site-spread`) and loose clutter (`site-clutter`).
 */
function layoutChecks(ctx: Ctx, placed: Res[]): void {
  for (const r of placed) {
    if (!r.floor || !r.data.solid) continue;
    const hit = openingHit(ctx, r.level, r.floor);
    if (hit)
      vio(ctx, r.work.id, "opening-clear",
        `${r.work.prop} stands within ${OPENING_CLEAR} m in front of the ${hit.label}: a door, opening or hallway mouth keeps its front clear (auto places skip it); move it aside`);
  }
  for (const r of placed) {
    if (!r.work.vignette || !r.work.vpart) continue;
    const want = partFacing(r.work.vignette, r.work.vpart, [r.box.cx, r.box.cz]);
    if (!want) continue;
    const off = angleOff(r.box.yaw, want.yaw);
    if (off > Math.PI / 4 + EPS)
      vio(ctx, r.work.id, "facing-sense", `${r.work.prop} (${r.work.vignette.kind} ${r.work.vpart}) faces ${Math.round(off / DEG)} deg off ${want.what}: ${r.work.vpart === "seat" ? "seats face the fire" : `it faces ${want.what}`}`);
  }
  if (ctx.input.plan.space?.kind !== "site") return;
  for (const [level, g] of ctx.grids)
    for (const rm of g.lv.rooms) {
      const spec = ctx.input.plan.rooms[rm.id];
      if (!spec) continue;
      const here = placed.filter((r) => r.level === level && r.room === rm.id && (r.data.mount === "floor" || r.data.mount === "wall"));
      const placeable = placeableFloor(g.lv).find((x) => x.room === rm.id)?.placeable ?? rm.area;
      if (!ctx.minItemsGiven) {
        const per = SITE_DENSITY[spec.role] ?? 1, need = Math.max(2, Math.ceil((per * placeable) / 100)), cap = Math.max(need, Math.floor((SITE_DENSITY_CAP * placeable) / 100));
        if (here.length && here.length < need)
          vio(ctx, rm.id, "site-sparse", `site area ${rm.id} (${spec.role}, ${f2(placeable)} m² placeable) has ${here.length} props; an outdoor area holds at least ${per} per 100 m² (${need}): add a vignette or members`);
        if (here.length > cap) vio(ctx, rm.id, "site-dense", `site area ${rm.id} (${f2(placeable)} m² placeable) has ${here.length} props; at most ${SITE_DENSITY_CAP} per 100 m² (${cap})`);
      }
      // spread: no 5 m cell holds more than 35% of the area's props, vignette members excepted (they cluster by design)
      if (here.length >= 4) {
        const x0 = rm.bbox[0], z0 = rm.bbox[2], cells = new Map<string, Res[]>();
        for (const r of here) {
          const k = `${Math.floor((r.box.cx - x0) / SITE_CELL_M)},${Math.floor((r.box.cz - z0) / SITE_CELL_M)}`;
          (cells.get(k) ?? cells.set(k, []).get(k)!).push(r);
        }
        for (const [k, list] of cells) {
          const loose = list.filter((r) => !r.work.vignette);
          if (loose.length >= 3 && loose.length > SITE_SPREAD * here.length + EPS)
            vio(ctx, rm.id, "site-spread",
              `site area ${rm.id}: ${loose.length} of its ${here.length} props (${Math.round((loose.length / here.length) * 100)}%, at most ${Math.round(SITE_SPREAD * 100)}%) stand in one ${SITE_CELL_M} m cell ` +
                `(${k}: ${loose.map((r) => r.work.id).join(", ")}) and in no vignette: lay the area out in vignettes (plan \`arrangements\`: camp, work-line, yard, shrine, midden, lookout) spread over it`);
        }
      }
      for (const r of here) {
        if (r.work.vignette) continue;
        const near = here.filter((o) => o !== r && Math.hypot(o.box.cx - r.box.cx, o.box.cz - r.box.cz) <= SITE_CLUTTER_R).length;
        if (near >= SITE_CLUTTER_N)
          vio(ctx, r.work.id, "site-clutter", `${r.work.prop} is in no vignette and has ${near} props within ${SITE_CLUTTER_R} m: a heap of things is clutter, not a design; give it a vignette (\`arrangement\`) or leave it out`);
      }
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
const AUTO_LANE_TRIES = 100;
/** Of those, the first ones tried strictly in score order before the tries spread out (AUTO_LANE_SPREAD). */
const AUTO_LANE_EXACT = 40;
/** Score added to a spot inside a stair/doorway warn buffer or a hearth's comfort buffer (see autoComfort). */
const AUTO_UNCOMFORTABLE = 20;
/** A spot this close (metres) to one whose lane check failed is skipped untried: the tries spread over the room. */
const AUTO_LANE_SPREAD = 0.6;

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
  if (openingHit(ctx, p.level, rect)) return "in front of a door or opening";
  if (d.neverInDoorLine && doorLineHit(ctx, p.level, rect)) return "a door line";
  // stair / well / doorway / entry hard buffer
  const reach = ctx.opts.hardBuffer + Math.hypot(rect.hw, rect.hd) + g.step;
  const [c0, r0] = g.cellOf(rect.cx - reach, rect.cz - reach), [c1, r1] = g.cellOf(rect.cx + reach, rect.cz + reach);
  if (g.count("z", c0, r0, c1, r1))
    for (let rr = r0; rr <= r1; rr++)
      for (let c = c0; c <= c1; c++) if (HAZARD_NAME[g.ch(c, rr)] && g.distToCell(rect, c, rr) < ctx.opts.hardBuffer - EPS) return "too close to a stair or doorway";
  const reachP = Math.hypot(rect.hw, rect.hd);
  for (const s of standing) {
    if (s.level !== p.level) continue;
    // far apart (centres beyond both footprints, the other's clearance strip and 1.5x the gap: a separation measured on the
    // rectangles' own axes is at least the true distance / sqrt 2): nothing below can hit
    const rs = Math.max(Math.hypot(s.box.w, s.box.d) / 2, s.floor ? Math.hypot(s.floor.hw, s.floor.hd) : 0) + Math.max(0, s.data.clearance);
    const far = Math.hypot(s.box.cx - rect.cx, s.box.cz - rect.cz) > reachP + rs + AUTO_GAP * 1.5 + 0.05;
    if (!far) {
      if (s.floor && -overlapDepth(rect, s.floor) < AUTO_GAP - EPS) return `too close to ${s.work.id}`;
      const strip = clearStrip(s);
      if (strip && overlapDepth(strip, rect) > 0.01) return `in front of ${s.work.id}`;
    }
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
function autoComfort(ctx: Ctx, g: Grid, pieces: Res[], hearthOk = false): number {
  let cost = 0;
  for (const p of pieces) {
    if (!p.floor) continue;
    const rect = p.floor, reach = ctx.opts.warnBuffer + Math.hypot(rect.hw, rect.hd) + g.step;
    const [c0, r0] = g.cellOf(rect.cx - reach, rect.cz - reach), [c1, r1] = g.cellOf(rect.cx + reach, rect.cz + reach);
    let dh = Infinity, dz = Infinity;
    if (!g.count("z", c0, r0, c1, r1) && (hearthOk || !g.count("H", c0, r0, c1, r1))) continue;
    for (let rr = r0; rr <= r1; rr++)
      for (let c = c0; c <= c1; c++) {
        const ch = g.ch(c, rr);
        if (HAZARD_NAME[ch]) dz = Math.min(dz, g.distToCell(rect, c, rr));
        else if (ch === "H") dh = Math.min(dh, g.distToCell(rect, c, rr));
      }
    cost += Math.max(0, ctx.opts.warnBuffer - dz) + (hearthOk ? 0 : Math.max(0, ctx.opts.hardBuffer - dh));
  }
  // any intrusion ranks behind every comfortable spot: a set is never squeezed against a hearth or door while the room has room
  return cost > EPS ? AUTO_UNCOMFORTABLE + cost : 0;
}

/** Nearest gap from these pieces to anything standing (capped), for spacing scores. */
function autoGap(pieces: Res[], standing: Res[]): number {
  let gap = AUTO_SPACED;
  for (const p of pieces)
    if (p.floor) {
      const reach = Math.hypot(p.floor.hw, p.floor.hd) + AUTO_SPACED * 1.5; // axis separation >= distance / sqrt 2
      for (const s of standing)
        if (s.floor && s.level === p.level && Math.hypot(s.floor.cx - p.floor.cx, s.floor.cz - p.floor.cz) <= reach + Math.hypot(s.floor.hw, s.floor.hd))
          gap = Math.min(gap, Math.max(0, -overlapDepth(p.floor, s.floor)));
    }
  return gap;
}

/** Where `near` points: an earlier item, the door, a stair, or the nearest map anchor of that kind. */
function autoTarget(ctx: Ctx, level: number, room: string, near: string, out: Map<string, Res>, setAnchor: Map<string, string>): V2 | undefined {
  const it = out.get(near) ?? out.get(setAnchor.get(near) ?? "");
  if (it) return it.level === level ? [it.box.cx, it.box.cz] : undefined;
  const g = ctx.grids.get(level)!, rm = g.lv.rooms.find((r) => r.id === room)!;
  if (near === "back-wall" || near === "apse") return backOf(ctx, level, room)?.at;
  if (near === "ceiling-centre") return ridgeCentre(g, rm);
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
  w.asked ??= w.place;
  let p = w.place as AutoPlace;
  const what = w.group ? `set item "${w.group}"` : `${w.id} (${w.prop})`;
  // a sign hangs outside over a door: the first free door-sign / sign-bracket anchor (the one whose id holds `near`, when given)
  if (hasTag(data, "sign")) {
    const taken = new Set([...out.values()].map((r) => (r.work.place.kind === "anchor" ? r.work.place.anchor : "")));
    const projecting = hasTag(data, "projecting");
    const free = ctx.input.map.anchors.filter((a) => SIGN_ANCHORS.has(a.kind) && a.mount === data.mount && !taken.has(a.id) && BESIDE_ANCHORS.has(a.kind) === projecting);
    const a = (p.near ? free.find((x) => x.id === p.near || x.id.includes(p.near!)) : undefined) ?? free[0];
    if (!a) {
      vio(ctx, w.id, "sign-indoors",
        `${what} is a sign: signs hang outside above a door, never in a room; map "${ctx.input.map.id}" has no free ${data.mount}-mount door-sign anchor, ` +
          `so place it on the town exterior's door-sign-<building> anchor ({ kind: "anchor", anchor }) or leave it out`);
      return false;
    }
    w.place = { kind: "anchor", anchor: a.id };
    ctx.autos.push({ item: w.group || w.id, place: w.place, mirror: false, note: "sign: over the door" });
    return true;
  }
  if (!p.near && hasTag(data, "altar") && roomRoles(ctx, p.room).includes("chapel")) p = { ...p, near: "back-wall" };
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
  // outdoor LAYOUT: a vignette member is laid out by its arrangement's rule (floor props; a graveyard's graves in rows)
  let vig: Vignette | undefined, vpart = "";
  if (p.arrangement) {
    const v = vignetteFor(ctx, level, p.room, p.arrangement, out, setAnchor);
    if (typeof v === "string") {
      vio(ctx, w.id, "arrangement", `${what}: ${v}`);
      return false;
    }
    vpart = p.part ?? arrangementPart(v.kind, w.prop, data);
    w.vignette = v;
    w.vpart = vpart;
    if (v.kind === "graveyard") p = { ...p, prefer: "row" };
    else if (data.mount === "floor") vig = v;
  }
  const prefer = p.prefer ?? (p.near ? "near" : data.mount === "floor" && data.against === "free" ? "open" : "wall");
  // against the back wall / in the apse: it faces back down the room toward the door (an altar faces its nave)
  const back = p.near === "back-wall" || p.near === "apse" ? backOf(ctx, level, p.room) : undefined;
  // graves in rows need no target: they face the yard's entry and fill the whole yard (graveLayout)
  const graveMode = prefer === "row" && isGrave(data) && data.against !== "wall";
  if (prefer === "row" && !target && !graveMode) {
    vio(ctx, w.id, "auto-near", `${what}: \`prefer: "row"\` needs \`near\` (what the rows face: an altar item, the hearth...)`);
    return false;
  }
  // rows face back along one axis: the target item's own front (a lectern faces its congregation), else from the anchor
  // into the room, snapped to the room's axes
  let rowAxis: V2 | undefined, rowFront = 0.5;
  if (prefer === "row" && target && !graveMode) {
    const it = out.get(p.near!) ?? out.get(setAnchor.get(p.near!) ?? "");
    if (it) rowFront = it.box.d / 2 + Math.max(it.data.clearance, 0.3);
    const a: V2 = it ? fwd(it.box.yaw) : [room.centre[0] - target[0], room.centre[1] - target[1]];
    rowAxis = Math.abs(a[0]) >= Math.abs(a[1]) ? [Math.sign(a[0]) || 1, 0] : [0, Math.sign(a[1]) || 1];
  }
  // fireside seating stands at the hearth clearance's edge on purpose
  const hearthOk = p.near === "hearth";
  // a free-standing piece goes to a wall when the designer says so (a lectern, a vat): "free" only means it needs no wall
  const wallAsked = p.prefer === "wall" || p.prefer === "corner";
  const walls = grid.lv.walls.filter((wl) => wl.room === p.room && (!p.wall || wl.id === p.wall));
  if (p.wall && !walls.length) {
    vio(ctx, w.id, "auto-wall", `${what}: wall "${p.wall}" is not a wall of room ${p.room} (its walls: ${grid.lv.walls.filter((wl) => wl.room === p.room).map((wl) => wl.id).join(", ")})`);
    return false;
  }
  const record = (place: DressingPlace, mirror: boolean): void => {
    w.place = place;
    if (hearthOk) {
      w.byHearth = true;
      for (const m of members) m.w.byHearth = true;
    }
    if (mirror)
      for (const m of members) {
        m.place = mirrorRel(m.place);
        m.w.place = m.place;
      }
    ctx.autos.push({ item: w.group || w.id, place, mirror, note: vig ? `${vig.kind} ${vig.id}: ${vpart} (${vig.how})` : `prefer ${prefer}${p.near ? ` near ${p.near}` : ""}` });
  };

  // -- ceiling props: over the room centre, or over the item they are near
  if (data.mount === "ceiling") {
    let at: V2 = target ?? (isChandelier(data) && room.maxHead >= TALL_RIDGE ? ridgeCentre(grid, room) : room.centre);
    const [c, r] = grid.cellOf(at[0], at[1]);
    if (grid.roomAt(c, r) !== p.room) at = room.centre;
    // never two hanging things in one spot (two chandeliers on the room centre z-fight): the nearest cell of the room clear
    // of every ceiling prop already hung on this level
    const radius = Math.hypot(data.size[0], data.size[2]) / 2;
    const hung = standing.filter((s) => s.level === level && s.data.mount === "ceiling");
    const clear = (x: number, z: number): boolean => hung.every((s) => Math.hypot(x - s.box.cx, z - s.box.cz) >= radius + Math.hypot(s.box.w, s.box.d) / 2 + 0.25);
    // a long hall's chandeliers hang in a line under the ridge: this one takes the first free spot of the line
    if (isChandelier(data) && (p.near === "ceiling-centre" || (!p.near && room.maxHead >= TALL_RIDGE))) {
      const count = ctx.input.plan.items.filter((it) => {
        if (it.place.kind !== "auto" || it.place.room !== p.room || (it.place.near && it.place.near !== "ceiling-centre")) return false;
        const d = it.prop ? ctx.input.prop(it.prop) : undefined;
        return !!d && isChandelier(d);
      }).length;
      const spot = ceilingLine(grid, room, count).find(([x, z]) => {
        const [ci, ri] = grid.cellOf(x, z), h = grid.head(ci, ri);
        return clear(x, z) && !(Number.isFinite(h) && h < data.size[1] + WALK_HEAD);
      });
      if (spot) at = spot;
    }
    if (!clear(at[0], at[1])) {
      let best: V2 | undefined, bestD = Infinity;
      const [x0, x1, z0, z1] = room.bbox;
      for (let z = z0; z <= z1 + EPS; z += grid.step)
        for (let x = x0; x <= x1 + EPS; x += grid.step) {
          const [ci, ri] = grid.cellOf(x, z);
          if (grid.roomAt(ci, ri) !== p.room || !clear(x, z)) continue;
          const h = grid.head(ci, ri);
          if (Number.isFinite(h) && h < data.size[1] + WALK_HEAD) continue;
          const dd = Math.hypot(x - at[0], z - at[1]);
          if (dd < bestD - EPS) [best, bestD] = [[x, z], dd];
        }
      if (!best) {
        vio(ctx, w.id, "auto-no-room", `${what} finds no spot under the ceiling of room ${p.room} clear of ${hung.map((s) => s.work.id).join(", ")}: one hanging light per spot; leave it out or use a wall or standing light`);
        return false;
      }
      at = best;
    }
    // the lowest ceiling over its footprint (a narrow ridge: the slopes either side are lower than the cell at its centre)
    let head = Infinity;
    for (const [c2, r2] of grid.cells({ cx: at[0], cz: at[1], hw: data.size[0] / 2, hd: data.size[2] / 2, yaw: 0 })) {
      const h = grid.head(c2, r2);
      if (Number.isFinite(h)) head = Math.min(head, h);
    }
    // a chain of up to 1 m; under a tall roof a chandelier comes down on its chain to CHANDELIER_HANG m over the floor (lit from
    // 10 m up, a nave stays black)
    const avail = Math.floor((head - data.size[1] - WALK_HEAD - 0.1) * 4) / 4, low = Math.floor((head - data.size[1] - CHANDELIER_HANG) * 4) / 4;
    const drop = data.chain && Number.isFinite(head) ? Math.max(0, Math.min(Math.max(1, isChandelier(data) ? low : 0), avail)) : 0;
    record({ kind: "ceiling", level, at: [+at[0].toFixed(3), +at[1].toFixed(3)], yaw: 0, drop }, false);
    return true;
  }

  // -- wall-hung props: centred on the longest free stretch of the room's walls (or nearest the target)
  if (data.mount === "wall") {
    const [W, H] = data.size;
    let best: { wall: SocketWall; t: number; h: number; score: number } | undefined;
    for (const wl of walls) {
      const [lo, hi] = wallBand(data, wl), hh = Math.min((lo + hi) / 2, wl.height - H);
      if (hh < lo - EPS) continue;
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
  // a vignette member: its part's slots, in order (its share of the ring / line first); 2 m off the lanes when it can
  if (vig) {
    const v = vig, mates = standing.filter((s) => s.work.vignette?.id === v.id);
    const { k, n } = partIndex(ctx, w, v, vpart);
    vignetteSlots(v, vpart, k, n, data, mates).forEach((s, i) => {
      const box: Box = { cx: s.at[0], cz: s.at[1], y0: grid.y(s.at[0], s.at[1]), yaw: s.yaw, w: W, h: H, d: D };
      const pieces = autoPieces(w, data, members, box, p.room, level, false);
      if (!pieceOk(pieces)) return;
      const lane = laneClearance(ctx, level, s.at) - Math.max(W, D) / 2;
      const deg = +((((s.yaw / DEG) % 360) + 360) % 360).toFixed(1);
      cands.push({ place: { kind: "floor", level, at: [+s.at[0].toFixed(3), +s.at[1].toFixed(3)], yaw: deg }, mirror: false, pieces, score: i * 0.01 + (lane < VIGNETTE_LANE_M ? 5 + VIGNETTE_LANE_M - lane : 0) });
    });
  }
  // wall candidates: back to a wall, every AUTO_T along each free span
  if (!vig && prefer !== "open" && prefer !== "row" && (data.against !== "free" || wallAsked)) {
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
            score += (AUTO_SPACED - gap) * 2 + autoComfort(ctx, grid, o.pieces, hearthOk) * 6 + (mirror ? 0.001 : 0);
            cands.push({ place: { kind: "wall", wall: wl.id, t: +o.t.toFixed(3) }, mirror, pieces: o.pieces, score });
          }
        }
      }
  }
  // rows (pews before an altar): the slots of the room's row layout, front row first; the first free one wins
  const rowMode = !graveMode && prefer === "row" && !!target && !!rowAxis && data.against !== "wall";
  const nearItem = graveMode && p.near ? out.get(p.near) ?? out.get(setAnchor.get(p.near) ?? "") : undefined;
  const glay = graveMode ? graveLayout(ctx, grid, level, p.room, w, target, nearItem?.box.yaw) : undefined;
  if (glay)
    glay.slots.forEach((s, i) => {
      const box: Box = { cx: s.at[0], cz: s.at[1], y0: grid.y(s.at[0], s.at[1]), yaw: glay.yaw, w: W, h: H, d: D };
      const pieces = autoPieces(w, data, members, box, p.room, level, false);
      if (pieceOk(pieces)) cands.push({ place: { kind: "floor", level, at: [+s.at[0].toFixed(3), +s.at[1].toFixed(3)], yaw: (Math.round(glay.yaw / DEG) + 360) % 360 }, mirror: false, pieces, score: i });
    });
  const lay = rowMode ? rowLayout(ctx, grid, level, p.room, p.near!, w, data, target!, rowAxis!, rowFront) : undefined;
  if (lay)
    lay.slots.forEach((s, i) => {
      const box: Box = { cx: s.at[0], cz: s.at[1], y0: grid.y(s.at[0], s.at[1]), yaw: lay.yaw, w: W, h: H, d: D };
      const pieces = autoPieces(w, data, members, box, p.room, level, false);
      if (pieceOk(pieces)) cands.push({ place: { kind: "floor", level, at: [+s.at[0].toFixed(3), +s.at[1].toFixed(3)], yaw: (Math.round(lay.yaw / DEG) + 360) % 360 }, mirror: false, pieces, score: i });
    });
  // open-floor candidates: centres on the cell grid, turned to the room's axes (for rows, when every row seat is taken or
  // would close a lane: any free spot behind the target facing it, short of the door line)
  const siteOpen = ctx.input.plan.space?.kind === "site" && prefer === "open" && !p.near;
  const openCands = (): void => {
    const [x0, x1, z0, z1] = room.bbox, longX = x1 - x0 >= z1 - z0;
    // a lone piece with no clearance strip stands on the same floor turned half way round (only its facing differs)
    const symmetric = !members.length && data.clearance <= 0 && mirrors.length === 1;
    for (let z = z0; z <= z1 + EPS; z += grid.step)
      for (let x = x0; x <= x1 + EPS; x += grid.step) {
        const [c, r] = grid.cellOf(x, z);
        if (grid.roomAt(c, r) !== p.room) continue;
        const half: ({ gap: number; comfort: number } | null)[] = [];
        for (const deg of [0, 90, 180, 270])
          for (const mirror of mirrors) {
            const box: Box = { cx: x, cz: z, y0: grid.y(x, z), yaw: deg * DEG, w: W, h: H, d: D };
            const pieces = autoPieces(w, data, members, box, p.room, level, mirror);
            const same = symmetric && deg >= 180 ? half[(deg - 180) / 90] : undefined;
            if (same === null) continue;
            if (same === undefined && !pieceOk(pieces)) {
              if (symmetric && deg < 180) half[deg / 90] = null;
              continue;
            }
            const gap = same ? same.gap : autoGap(pieces, standing), comfort = same ? same.comfort : autoComfort(ctx, grid, pieces, hearthOk);
            if (symmetric && deg < 180) half[deg / 90] = { gap, comfort };
            // tidy: the anchor's long side along the room's long axis
            const across = (deg % 180 === 0) === (W >= D) === longX ? 0 : 0.05;
            let score: number;
            if (lay && target && rowAxis) {
              const f = fwd(box.yaw);
              if (f[0] * rowAxis[0] + f[1] * rowAxis[1] > -0.99) continue;
              const dx = x - target[0], dz = z - target[1], along = dx * rowAxis[0] + dz * rowAxis[1];
              if (along - D / 2 < rowFront - EPS || along + D / 2 > lay.nave.end + EPS) continue; // behind the step, short of the door line
              if (gap < AUTO_SPACED - EPS) continue; // room to sit between rows
              score = along + Math.abs(dx * rowAxis[1] - dz * rowAxis[0]) * 0.35;
            } else if (prefer === "near" && target && back) {
              const f = fwd(box.yaw);
              if (-(f[0] * back.facing[0] + f[1] * back.facing[1]) < 0.7) continue; // faces the nave, never the wall
              score = rectDist(rectOf(box), target[0], target[1]);
            } else if (prefer === "near" && target) {
              const f = fwd(box.yaw), dx = target[0] - x, dz = target[1] - z, dl = Math.hypot(dx, dz) || 1;
              score = rectDist(rectOf(box), target[0], target[1]) + (1 - (f[0] * dx + f[1] * dz) / dl) * 0.2;
            } else if (roomRules(ctx, p.room).keepCentre) {
              // walls and corners fill first: the open spot nearest the room's edge (outside its keep-clear centre)
              const zd = ctx.zones.get(level)!.dist, [cc, rr] = grid.cellOf(x, z);
              score = (zd[rr * grid.lv.columns + cc] ?? 0) + across;
            } else if (siteOpen) {
              // outdoors a loose piece goes where the site is emptiest: away from what already stands (never a heap; `site-clutter`)
              const near = standing.reduce((m, s) => (s.level === level && s.floor ? Math.min(m, Math.hypot(s.box.cx - x, s.box.cz - z)) : m), Infinity);
              score = -autoRoom(grid, p.room, pieces) + across - Math.min(near, SITE_OPEN_SPREAD) * 0.6 + Math.hypot(x - room.centre[0], z - room.centre[1]) * 0.02;
            } else score = -autoRoom(grid, p.room, pieces) + across + Math.hypot(x - room.centre[0], z - room.centre[1]) * 0.02;
            score += (lay ? 0 : (AUTO_SPACED - gap) * 2) + comfort * 6 + (mirror ? 0.001 : 0) + deg * 1e-5;
            cands.push({ place: { kind: "floor", level, at: [+x.toFixed(3), +z.toFixed(3)], yaw: deg }, mirror, pieces, score });
          }
      }
  };
  if (!vig && !lay && !glay && (prefer === "open" || prefer === "near" || (data.against === "free" && !wallAsked) || !cands.length) && data.against !== "wall") openCands();
  const seeds = laneSeeds(ctx, grid, level), radius = ctx.opts.laneWidth / 2;
  const baseLane = seeds.length
    ? laneBody(grid, standing.filter((s) => s.level === level && s.floor).map((s) => s.floor!), seeds, laneOffsets(grid.step, radius), radius)
    : undefined;
  if (pick()) return true;
  if (vig) {
    vio(ctx, w.id, "auto-no-room",
      `${what} (${f2(W)} x ${f2(D)} m) finds no ${vpart} spot in ${vig.kind} "${vig.id}" (${vig.how}, centre ${at2(vig.centre[0], vig.centre[1])})` +
        `${refused.size ? `: spots tried were refused for ${[...refused].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`).join(", ")}` : cands.length ? " without closing a lane" : ""}. ` +
        `Anchor the vignette elsewhere, give it fewer members, or choose a smaller piece`);
    return false;
  }
  if (lay) {
    cands.length = 0;
    openCands();
    if (pick()) return true;
  }
  const size = `${f2(W)} x ${f2(D)} m${members.length ? ` with ${members.length} member(s), ${f2(addM2)} m² in all` : ""}`;
  vio(ctx, w.id, "auto-no-room",
    `${what} (${size}${data.against === "wall" ? ", back to a wall" : ""}) does not fit in room ${p.room}${p.wall ? ` on wall ${p.wall}` : ""}` +
      (glay ? ` (the yard's rows: ${glay.capacity} grave slots in ${glay.rows} rows, ${f2(glay.pitch)} m apart, stones ${f2(glay.spacing)} m apart; the plan asks for ${glay.want})` : "") +
      (lay ? ` (its rows: ${lay.slots.length} seats every ${f2(lay.pitch)} m over ${f2(lay.nave.end - lay.nave.start)} m of nave, the door line kept clear; the plan asks for ${lay.want})` : "") +
      `${cands.length ? ` without closing a ${f2(ctx.opts.laneWidth)} m lane` : ""}; left: ${autoLeft(ctx, grid, p.room, standing, walls)}` +
      `${refused.size ? `; spots tried were refused for ${[...refused].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`).join(", ")}` : ""}. ` +
      `Earlier items win: choose a smaller piece or another room${data.against === "wall" ? "" : ", prefer \"open\""}, or move it earlier in the plan`);
  return false;

  /** The best candidate that keeps every lane open, recorded; false when none does. */
  function pick(): boolean {
    cands.sort((a, b) => a.score - b.score);
    let tries = 0;
    const failed: [number, number, boolean][] = [];
  for (const c of cands) {
    const at = c.pieces[0]!.box, along = Math.abs(Math.sin(at.yaw)) < 0.5;
    // the best AUTO_LANE_EXACT spots are tried in order; after that the tries spread over the room (a spot near one
    // that closed a lane would close it too)
    if (tries >= AUTO_LANE_EXACT && failed.some(([x, z, a]) => a === along && Math.hypot(at.cx - x, at.cz - z) < AUTO_LANE_SPREAD)) continue;
    if (tries++ >= AUTO_LANE_TRIES) break;
    if (!autoLaneOk(ctx, grid, level, standing, baseLane, c.pieces)) { failed.push([at.cx, at.cz, along]); continue; }
    record(c.place, c.mirror);
    if (autoComfort(ctx, grid, c.pieces, hearthOk) > 0)
      warn(ctx, w.id, "auto-tight",
        `${what} (${f2(W)} x ${f2(D)} m${members.length ? `, ${f2(addM2)} m² with its set` : ""}) has no spot in room ${p.room} that keeps ${f2(ctx.opts.hardBuffer)} m off the hearth clearance and ` +
          `${f2(ctx.opts.warnBuffer)} m off stairs and doorways, so it stands at the best one left (the warnings below say how close). Accept it, or ` +
          `${members.length ? "place its pieces as single items (each finds its own spot), " : ""}choose a smaller piece, or move it earlier in the plan`);
    return true;
  }
    return false;
  }
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
        ridge: room.maxHead,
        ...(wantsChandelier(ctx, room) ? { chandelier: placed.some((r) => r.level === level && r.room === room.id && isChandelier(r.data)) } : {}),
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
      flames: o.flames ?? FLAME_MIN,
      flameArea: o.flameArea ?? FLAME_AREA,
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
    doorLines: new Map(),
    rows: new Map(),
    graves: new Map(),
    vignettes: new Map(),
    vignetteRooms: new Set(),
    openings: new Map(),
    minItemsGiven: !!o.minItems,
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
  ruleChecks(ctx, placed);
  signChecks(ctx, placed);
  layoutChecks(ctx, placed);
  const review = reviewRooms(ctx, placed);

  const placements: DressingPlacement[] = [];
  for (const r of placed) {
    const [ox, oy, oz] = mountStandoff(r);
    placements.push({
      id: r.work.id,
      prop: r.work.prop,
      level: r.level,
      room: r.room,
      position: [+(r.origin[0] + ox).toFixed(4), +(r.origin[1] + oy).toFixed(4), +(r.origin[2] + oz).toFixed(4)],
      yaw: +r.box.yaw.toFixed(6),
      ...(r.tilt ? { tilt: r.tilt } : {}),
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
