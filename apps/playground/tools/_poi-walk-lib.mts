/**
 * poi-walk, the pure half: what a POI job declares and implies a player must be able to walk (routes + targets),
 * and how one walked leg is judged. No world, no physics: tests drive these directly (test/poi-walk.test.ts).
 *
 * Routes (each walked both ways, from a cold start):
 *   - handoff.json `navigation.routes` (or `navigation` as a bare array): { id, points: [[x,y,z] | [x,z]], drops?:
 *     [leg index...], jump?: false }. REQUIRED: a job with none fails NO-ROUTES (the old `navigation: []`).
 *   - every `path` world op the job lays (its centreline, XZ).
 *   - every landmark operator with two or more `targets`, through them in declared order (planner legs).
 * Targets (derived, never hand-listed):
 *   - landmark `targets` and `openings` (an opening is walked THROUGH: 3 m out on its axis -> it -> 2 m in);
 *   - every WFC doorway part (tag wfc-part:doorway* / door* / arch* / gate*) under the POI: 4 m out on the door axis
 *     -> the door -> the cell centre;
 *   - every `portal` script under the POI (walk to the anchor, then the portal must send: a travel event);
 *   - every dressing area centre (handoff.siteDressing), every circular clearing the job delivers (encounter grounds),
 *     handoff.populateClearings, every quest/interactable entity under the POI (within its interaction radius).
 */
import fs from "node:fs";
import path from "node:path";
import { deliveredOps } from "../../../tools/poi-review/job.mjs";

export type P3 = [number, number, number];
export type P2 = [number, number];
/** A route/target point; y null = "whatever floor is there" (no height check). */
export type Pt = [number, number | null, number];

export interface Route {
  id: string;
  source: "handoff" | "path" | "landmark";
  points: Pt[];
  /** Leg indices (leg k = points[k] -> points[k+1], forward numbering) allowed to drop more than FALL_M. */
  drops: number[];
  jump: boolean;
  /** "stick": hold the stick along the declared line; "planner": the ground planner between the points (resident colliders only). */
  driver: "stick" | "planner";
}

export type TargetKind = "landmark-target" | "opening" | "door" | "portal" | "area" | "clearing" | "quest";
export interface Target {
  id: string;
  kind: TargetKind;
  at: Pt;
  /** XZ distance that counts as reached. */
  tolXZ: number;
  /** Walk THROUGH: start here, pass `at`, end at `through` (doors, openings). */
  from?: P3;
  through?: P3;
  portal?: { entityId: string; trigger: boolean; sealed?: string; /** the trigger box's smaller horizontal half extent (m) */ half?: number; /** the trigger box centre when it stands off the anchor (portal-cover --fit offset); no height */ box?: [number, null, number] };
  /** Walked with the stick only, never jumping (a door: the way in must be steps, not a jump onto a raised sill). */
  noJump?: boolean;
  /** Bog/open water: reached within this XZ distance when the point is under water. */
  wadeXZ?: number;
}

export type FaultKind = "NO-ROUTES" | "FALL" | "STUCK" | "MISS" | "ONE-WAY" | "SHADOW" | "STREAM" | "PORTAL" | "BODY";
export interface Fault { kind: FaultKind; what: string; at?: P3; detail?: string }

/** Thresholds (the QA-B proposal): a drop over FALL_M in FALL_WINDOW_S is a fall; no progress for STUCK_S is stuck. */
export const FALL_M = 2;
export const FALL_WINDOW_S = 0.5;
/**
 * A drop is a fall only when the body left the ground during it: some sample of the window stood over AIR_M above
 * the surface under its feet. A stair or a steep ramp walked down at run speed sinks FALL_M in FALL_WINDOW_S while
 * the feet never leave the treads (a riser is well under AIR_M); a body through a missing collider or off a ledge is
 * metres over whatever is below.
 */
export const AIR_M = 0.75;
export const STUCK_S = 3;
export const MISS_XZ = 1;
export const MISS_Y = 0.75;

const readJson = (f: string): unknown => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const tryJson = (f: string): unknown => { try { return fs.existsSync(f) ? readJson(f) : null; } catch { return null; } };
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r2 = (v: number): number => Math.round(v * 100) / 100;

// ------------------------------------------------------------------------------------------------ job files

export interface JobFiles {
  dir: string;
  poiId: string;
  handoff: Record<string, unknown>;
  brief: Record<string, unknown> | null;
  sceneOps: Array<Record<string, unknown>>;
  worldOps: Array<Record<string, unknown>>;
  clearings: Array<Record<string, unknown>>;
  /** Delivered ops files (job.mjs deliveredOps), for the report's freshness. */
  files: string[];
}

/** Read a job directory: handoff, brief and every delivered ops file sorted into scene ops / world ops / clearings. */
export function readJob(dir: string): JobFiles {
  const handoff = (tryJson(path.join(dir, "handoff.json")) ?? {}) as Record<string, unknown>;
  const brief = tryJson(path.join(dir, "brief.json")) as Record<string, unknown> | null;
  const files = deliveredOps(dir) as string[];
  const job: JobFiles = { dir, poiId: String(handoff["poiId"] ?? brief?.["id"] ?? path.basename(dir)), handoff, brief, sceneOps: [], worldOps: [], clearings: [], files };
  for (const f of files) {
    const j = tryJson(path.join(dir, f));
    const list = Array.isArray(j) ? j : Array.isArray((j as { ops?: unknown[] } | null)?.ops) ? (j as { ops: unknown[] }).ops : [];
    sortOps(list, job);
  }
  return job;
}

export function sortOps(list: unknown[], job: Pick<JobFiles, "sceneOps" | "worldOps" | "clearings">): void {
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    if (r["op"] === "add-entity") job.sceneOps.push(r);
    else if (typeof r["op"] === "string") job.worldOps.push(r);
    else if (r["center"] || r["polygon"]) job.clearings.push(r);
  }
}

// ------------------------------------------------------------------------------------------------ geometry

/** A landmark operator's local point -> world (the bake's own transform, tools/landmark.mts reach). */
export function landmarkToWorld(op: Record<string, unknown>, l: readonly number[]): P3 {
  const at = op["at"] as number[];
  const footY = isNum(op["y"]) ? op["y"] : 0;
  const scale = isNum(op["scale"]) ? op["scale"] : 1;
  const yaw = ((isNum(op["yaw"]) ? op["yaw"] : 0) * Math.PI) / 180;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const x = l[0]! * scale, z = l[2]! * scale;
  return [at[0]! + x * c + z * s, footY + l[1]! * scale, at[1]! - x * s + z * c];
}

/** Rotate v by quaternion q = [x, y, z, w]. */
export function rotate(q: readonly number[], v: readonly number[]): P3 {
  const [qx, qy, qz, qw] = q as [number, number, number, number];
  const [vx, vy, vz] = v as [number, number, number];
  const ix = qw * vx + qy * vz - qz * vy, iy = qw * vy + qz * vx - qx * vz, iz = qw * vz + qx * vy - qy * vx, iw = -qx * vx - qy * vy - qz * vz;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

const pt = (p: readonly number[]): Pt => (p.length >= 3 ? [p[0]!, isNum(p[1]) ? p[1] : null, p[2]!] : [p[0]!, null, p[1]!]);

// ------------------------------------------------------------------------------------------------ routes

/** handoff.navigation: { routes: [...] } or a bare array of routes. Malformed entries are skipped. */
export function declaredRoutes(handoff: Record<string, unknown>): Route[] {
  const nav = handoff["navigation"];
  const list = Array.isArray(nav) ? nav : Array.isArray((nav as { routes?: unknown[] } | null)?.routes) ? (nav as { routes: unknown[] }).routes : [];
  const out: Route[] = [];
  list.forEach((r, i) => {
    const o = r as { id?: string; points?: number[][]; drops?: number[]; jump?: boolean; driver?: string };
    const pts = (o?.points ?? []).filter((p) => Array.isArray(p) && p.length >= 2 && p.every((v) => v === null || isNum(v)));
    if (pts.length < 2) return;
    out.push({ id: o.id ?? `route-${i + 1}`, source: "handoff", points: pts.map(pt), drops: Array.isArray(o.drops) ? o.drops.filter(isNum) : [], jump: o.jump !== false, driver: o.driver === "planner" ? "planner" : "stick" });
  });
  return out;
}

/** Routes the job's world ops imply: every landmark's targets in declared order. (Footpaths are carved + painted tracks
 *  since ribbons were removed 2026-10-30: their walk routes are the handoff's own, laid on the track as built by
 *  place-build build — routeOnTrack.) */
export function derivedRoutes(worldOps: Array<Record<string, unknown>>): Route[] {
  const out: Route[] = [];
  for (const op of worldOps) {
    const targets = Array.isArray(op["targets"]) ? (op["targets"] as Array<{ at: number[] }>) : [];
    if (op["op"] === "landmark" && Array.isArray(op["at"]) && targets.length >= 2) {
      out.push({ id: `landmark:${op["id"]}`, source: "landmark", points: targets.map((t) => landmarkToWorld(op, t.at)), drops: [], jump: true, driver: "planner" });
    }
  }
  return out;
}


/** Split a route's points into stick legs no longer than `step` metres (the stick aims at the next point). */
export function densifyPts(points: Pt[], step: number): Pt[] {
  const out: Pt[] = [points[0]!];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!, b = points[k]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / step));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      out.push([a[0] + (b[0] - a[0]) * t, s === n ? b[1] : a[1] !== null && b[1] !== null ? a[1] + (b[1] - a[1]) * t : null, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

/** The route walked the other way: points reversed, a drop leg k becomes leg (n-2-k). */
export function reverseRoute(r: Route): Route {
  const n = r.points.length;
  return { ...r, points: [...r.points].reverse(), drops: r.drops.map((k) => n - 2 - k) };
}

// ------------------------------------------------------------------------------------------------ targets

/** Targets the job's files declare: landmark targets + openings, dressing areas, circular clearings, populate clearings. */
export function fileTargets(job: Pick<JobFiles, "handoff" | "worldOps" | "clearings">): Target[] {
  const out: Target[] = [];
  for (const op of job.worldOps) {
    if (!Array.isArray(op["at"])) continue;
    for (const t of (op["targets"] as Array<{ name: string; at: number[] }> | undefined) ?? []) {
      if (!Array.isArray(t?.at)) continue;
      out.push({ id: `${op["id"]}/${t.name}`, kind: "landmark-target", at: landmarkToWorld(op, t.at), tolXZ: MISS_XZ });
    }
    for (const o of (op["openings"] as Array<{ name: string; at: number[]; depth?: number; yaw?: number }> | undefined) ?? []) {
      if (!Array.isArray(o?.at)) continue;
      const depth = isNum(o.depth) ? o.depth : 2;
      const oy = ((isNum(o.yaw) ? o.yaw : 0) * Math.PI) / 180;
      const ox = Math.sin(oy), oz = Math.cos(oy); // local "out of the opening" (+z, turned by the opening's yaw)
      const a = o.at;
      const loc = (k: number): number[] => [a[0]! + ox * k, a[1]!, a[2]! + oz * k];
      out.push({ id: `${op["id"]}/opening ${o.name}`, kind: "opening", at: landmarkToWorld(op, a), tolXZ: MISS_XZ, from: landmarkToWorld(op, loc(depth / 2 + 3)), through: landmarkToWorld(op, loc(-(depth / 2 + 2))) });
    }
  }
  const sd = job.handoff["siteDressing"];
  const areas = Array.isArray(sd) ? sd : Array.isArray((sd as { areas?: unknown[] } | null)?.areas) ? (sd as { areas: unknown[] }).areas : [];
  // `reach` [x,y,z]: where a body stands to visit the area (settle writes it for stilt households: just inside the hut
  // door) — the centre is the middle of the area's footprints and can lie on a bed or a chest
  for (const a of areas as Array<{ id?: string; centre?: number[]; center?: number[]; floorY?: number; reach?: number[] }>) {
    if (Array.isArray(a?.reach) && a.reach.length === 3) { out.push({ id: `area:${a.id ?? out.length}`, kind: "area", at: [a.reach[0]!, a.reach[1]!, a.reach[2]!], tolXZ: 2, wadeXZ: 6 }); continue; }
    const c = a?.centre ?? a?.center;
    if (!Array.isArray(c) || c.length < 2) continue;
    const p = pt(c);
    if (isNum(a.floorY)) p[1] = a.floorY;
    out.push({ id: `area:${a.id ?? out.length}`, kind: "area", at: p, tolXZ: 2, wadeXZ: 6 });
  }
  const circles = [...job.clearings, ...((job.handoff["populateClearings"] as Array<Record<string, unknown>> | undefined) ?? [])];
  const seen = new Set<string>();
  for (const c of circles) {
    const ctr = c["center"] as number[] | undefined;
    // `walk: false` (place-build): ground cleared under a structure, not a spot a body stands on
    if (!Array.isArray(ctr) || seen.has(String(c["id"])) || c["walk"] === false) continue;
    seen.add(String(c["id"]));
    out.push({ id: `clearing:${c["id"]}`, kind: "clearing", at: pt(ctr), tolXZ: 2, wadeXZ: 6 });
  }
  return out;
}

/** One entity of the booted world, as the target finder needs it. */
export interface EntityView {
  id: string;
  parent: string | null;
  tags: readonly string[];
  position: P3 | null;
  quaternion: [number, number, number, number] | null;
  /** World scale (the transform scales multiplied up the parent chain); a portal's box is scaled by it. */
  scale?: P3;
  components: Record<string, unknown>;
}

/** Ids of `roots` and every descendant (by parent links). */
export function descendants(entities: ReadonlyMap<string, { parent?: string | null }>, roots: Iterable<string>): Set<string> {
  const kids = new Map<string, string[]>();
  for (const [id, e] of entities) if (e.parent) { const l = kids.get(e.parent) ?? []; l.push(id); kids.set(e.parent, l); }
  const out = new Set<string>();
  const stack = [...roots].filter((r) => entities.has(r));
  while (stack.length) { const id = stack.pop()!; if (out.has(id)) continue; out.add(id); for (const k of kids.get(id) ?? []) stack.push(k); }
  return out;
}

export const DOOR_PART_RE = /^wfc-part:(doorway|door|arch|gate)/;
/** Metres from a WFC cell centre to the face a doorway part stands on (half the kit's 4 m cell, less the wall). */
export const DOOR_FACE_M = 1.8;

/**
 * Targets the POI's entities imply: WFC doorway parts (walked through from 4 m out on the door axis to the cell
 * centre), portals (walk to the anchor, the portal must send), quest / interactable entities.
 */
export function entityTargets(views: EntityView[], doorsOfAsset?: (assetId: string) => { id: string; position: readonly number[]; yaw: number }[]): Target[] {
  const out: Target[] = [];
  // every CATALOGUED BUILDING's door (its model's `door` markers): walked in from 4 m outside, through the door to 2.5 m
  // inside, without jumping. L (Marrow's Farm 2026-10-30, Derek: "you can't get into the farm house, it's raised too high")
  if (doorsOfAsset) for (const v of views) {
    const asset = (v.components["mesh"] as { source?: { assetId?: unknown } } | undefined)?.source?.assetId;
    if (typeof asset !== "string" || !v.position || !v.quaternion) continue;
    for (const d of doorsOfAsset(asset)) {
      const at = rotate(v.quaternion, d.position), ly = (d.yaw * Math.PI) / 180, o = rotate(v.quaternion, [Math.sin(ly), 0, Math.cos(ly)]);
      const l = Math.hypot(o[0], o[2]); if (l < 1e-6) continue;
      const nx = o[0] / l, nz = o[2] / l, door: P3 = [v.position[0] + at[0], v.position[1] + at[1], v.position[2] + at[2]];
      out.push({ id: `door:${v.id}/${d.id}`, kind: "door", at: door, tolXZ: MISS_XZ, from: [door[0] + nx * 4, door[1], door[2] + nz * 4], through: [door[0] - nx * 2.5, door[1], door[2] - nz * 2.5], noJump: true });
    }
  }
  const byId = new Map(views.map((v) => [v.id, v]));
  for (const v of views) {
    const parentIsDoor = v.parent ? (byId.get(v.parent)?.tags ?? []).some((t) => DOOR_PART_RE.test(t)) : false;
    if (v.tags.some((t) => DOOR_PART_RE.test(t)) && !parentIsDoor && v.position && v.quaternion) {
      const cell = v.parent ? byId.get(v.parent) : undefined;
      const c = cell?.position ?? v.position;
      // the door's face: a box collider's offset (the kit's AABB collider), else the part's slot in the cell's own
      // frame (kit.mjs names a part `<part>-<slot>`, slot px/nx/pz/nz = the cell face it stands on)
      const coll = v.components["collider"] as { shape?: string; offset?: number[] } | undefined;
      const slot = /-(px|nx|pz|nz)(?:-\d+)?$/.exec(v.id)?.[1];
      let w: P3 | null = null;
      if (coll?.shape === "box" && coll.offset && Math.hypot(coll.offset[0]!, coll.offset[2]!) > 0.2) w = rotate(v.quaternion, coll.offset);
      else if (slot) w = rotate(cell?.quaternion ?? [0, 0, 0, 1], [slot === "px" ? DOOR_FACE_M : slot === "nx" ? -DOOR_FACE_M : 0, 0, slot === "pz" ? DOOR_FACE_M : slot === "nz" ? -DOOR_FACE_M : 0]);
      if (!w) continue; // no way to tell which face the doorway is on
      const door: P3 = [v.position[0] + w[0], c[1], v.position[2] + w[2]];
      let nx = door[0] - c[0], nz = door[2] - c[2];
      const l = Math.hypot(nx, nz);
      if (l < 0.2) continue; // a doorway at the cell centre has no axis to walk
      nx /= l; nz /= l;
      out.push({ id: `door:${cell ? cell.id : v.id}${slot ? `/${slot}` : ""}`, kind: "door", at: [door[0], c[1], door[2]], tolXZ: MISS_XZ, from: [door[0] + nx * 4, c[1], door[2] + nz * 4], through: [c[0], c[1], c[2]] });
    }
    const script = v.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
    if (script?.name === "portal" && v.position) {
      const trigger = script.params?.["mode"] === "trigger";
      // a SEALED door (no scene, a refusal: a dungeon that opens in a later round) must refuse with its own words, not send
      const sealed = !script.params?.["scene"] && typeof script.params?.["refusal"] === "string" ? (script.params["refusal"] as string) : undefined;
      const he = script.params?.["halfExtents"];
      const sc = v.scale ?? [1, 1, 1];
      const half = Array.isArray(he) && isNum(he[0]) && isNum(he[2]) ? Math.min((he[0] as number) * sc[0], (he[2] as number) * sc[2]) : undefined;
      // the walk-in goes to the BOX, not the entity origin: portal-cover --fit sets the box `offset` onto the passage's
      // narrowest closed section, which can stand metres behind the anchor (Weeping Stair 2026-11-01: box 0.65-2.35 m
      // behind it, "reached the anchor, the portal did not send"). The reach and hold stay on the anchor (its floor);
      // the walk-in heads for the box centre (`box`, no height: a sloped bore falls 1.3 m under it).
      const off = script.params?.["offset"];
      const shift: P3 = Array.isArray(off) && isNum(off[0]) && isNum(off[2]) && v.quaternion ? rotate(v.quaternion, [(off[0] as number) * sc[0], 0, (off[2] as number) * sc[2]]) : [0, 0, 0];
      const box: [number, null, number] | undefined = Math.hypot(shift[0], shift[2]) > 0.1 ? [v.position[0] + shift[0], null, v.position[2] + shift[2]] : undefined;
      out.push({ id: `portal:${v.id}`, kind: "portal", at: [v.position[0], v.position[1], v.position[2]], tolXZ: 3, portal: { entityId: v.id, trigger, ...(sealed ? { sealed } : {}), ...(half !== undefined ? { half } : {}), ...(box ? { box } : {}) } });
    } else if (v.position && (v.tags.includes("quest-object") || v.tags.includes("interactable") || script?.name === "npc")) {
      const r = isNum(script?.params?.["radius"]) ? (script!.params!["radius"] as number) : 3;
      out.push({ id: `quest:${v.id}`, kind: "quest", at: [v.position[0], null, v.position[2]], tolXZ: Math.min(Math.max(r - 0.5, 1), 3) });
    }
  }
  return out;
}

/**
 * The job's declared navigation NETWORK: `navigation.network` polylines ([{ id, points }]) — ways through the place a
 * body may take to reach a target, not walked as routes of their own (a stilt village's way to every hut and deck).
 */
export function declaredNetwork(handoff: Record<string, unknown>): Route[] {
  const nav = handoff["navigation"] as { network?: unknown[] } | null | undefined;
  const list = Array.isArray(nav?.network) ? nav!.network : [];
  return declaredRoutes({ navigation: { routes: list } }).map((r) => ({ ...r, id: `network:${r.id}` }));
}

/** The declared walk lines (navigation routes + network) as kept-clear legs for the dressing (site-sockets): one per leg, its
 *  height the mean of its ends' declared floors (null: a 2D leg on the ground). A dresser's prop on a line poi-walk walks is a STUCK
 *  (widows-arch 2026-10-21: two pews, a creel and a boulder on the chapel deck's line). */
/** An area that declares a floor height and no surface kind (site-sockets): built when a fair share of its grid found a top there
 *  standing clear of the terrain, a cave floor when that height is more than CAVE_UNDER_M under the ground at its centre (kirk-stair
 *  2026-10-21: the tide cave at y 1.6 was measured on the heath at 148 and its psalter stood on the moor), else the ground. */
export const CAVE_UNDER_M = 3;
export function declaredFloorKind(hits: number, cells: number, declaredY: number, groundY: number): "ground" | "cave" | "built" {
  if (hits >= 3 && hits >= 0.1 * cells) return "built";
  return declaredY < groundY - CAVE_UNDER_M ? "cave" : "ground";
}
export const ROUTE_KEEP_W = 2;
export function routeLegKeeps(handoff: Record<string, unknown>, width = ROUTE_KEEP_W): Array<{ id: string; points: [number, number][]; width: number; y: number | null }> {
  const out: Array<{ id: string; points: [number, number][]; width: number; y: number | null }> = [];
  for (const r of [...declaredRoutes(handoff), ...declaredNetwork(handoff)]) for (let i = 0; i + 1 < r.points.length; i++) {
    const a = r.points[i]!, b = r.points[i + 1]!;
    out.push({ id: `${r.id}#${i}`, points: [[a[0], a[2]], [b[0], b[2]]], width, y: a[1] !== null && b[1] !== null ? (a[1] + b[1]) / 2 : (a[1] ?? b[1]) });
  }
  return out;
}
/** Whether a route leg at height `y` bears on an area dressed at `floorY` (built/cave) or on the open ground at `groundY`: a leg
 *  with no height is a ground route; one more than 3 m off the floor (a stair down a shaft under a heath area, a deck walk over a
 *  cave) is another level's. */
export function legOnLevel(y: number | null, surface: "ground" | "built" | "cave", floorY: number | null | undefined, groundY: number): boolean {
  if (y === null) return surface !== "cave";
  return Math.abs(y - (surface === "ground" ? groundY : (floorY ?? groundY))) <= 3;
}
/**
 * A way to `goal` along the navigation graph: every declared route and network polyline (densified to 2 m), points of
 * different lines within 0.8 m (XZ) and 0.5 m (Y) of each other joined. From the first point of the first line (the
 * place's way in) to the graph point nearest the goal (one on the goal's level when it has a height: within 0.8 m Y,
 * else the nearest at all), shortest by XZ length. The last hop (graph point -> goal) is left to the walker. Null when
 * no graph point is within `maxM` of the goal or the graph does not join up.
 */
export function networkPath(lines: Route[], goal: Pt, maxM = 12): Pt[] | null {
  const pts: Pt[] = [], adj: Array<Array<{ to: number; w: number }>> = [];
  const add = (p: Pt): number => { pts.push(p); adj.push([]); return pts.length - 1; };
  const link = (a: number, b: number): void => { const w = Math.hypot(pts[a]![0] - pts[b]![0], pts[a]![2] - pts[b]![2]); adj[a]!.push({ to: b, w }); adj[b]!.push({ to: a, w }); };
  const lineOf: number[] = [];
  lines.forEach((r, li) => { let prev = -1; for (const p of densifyPts(r.points, 2)) { const k = add(p); lineOf.push(li); if (prev >= 0) link(prev, k); prev = k; } });
  if (!pts.length) return null;
  const yOk = (a: number | null, b: number | null): boolean => a === null || b === null || Math.abs(a - b) <= 0.5;
  for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) if (lineOf[a] !== lineOf[b] && Math.hypot(pts[a]![0] - pts[b]![0], pts[a]![2] - pts[b]![2]) <= 0.8 && yOk(pts[a]![1], pts[b]![1])) link(a, b);
  const dXZ = (k: number): number => Math.hypot(pts[k]![0] - goal[0], pts[k]![2] - goal[2]);
  const onLevel = (k: number): boolean => goal[1] === null || pts[k]![1] === null || Math.abs(pts[k]![1]! - goal[1]) <= 0.8;
  let end = -1;
  for (const level of [true, false]) { for (let k = 0; k < pts.length; k++) if ((!level || onLevel(k)) && dXZ(k) <= maxM && (end < 0 || dXZ(k) < dXZ(end))) end = k; if (end >= 0) break; }
  if (end < 0) return null;
  const dist = new Float64Array(pts.length).fill(Infinity), prev = new Int32Array(pts.length).fill(-1), done = new Uint8Array(pts.length);
  dist[0] = 0;
  for (;;) {
    let u = -1; for (let k = 0; k < pts.length; k++) if (!done[k] && dist[k]! < Infinity && (u < 0 || dist[k]! < dist[u]!)) u = k;
    if (u < 0) return null;
    if (u === end) break;
    done[u] = 1;
    for (const e of adj[u]!) if (dist[u]! + e.w < dist[e.to]!) { dist[e.to] = dist[u]! + e.w; prev[e.to] = u; }
  }
  const out: Pt[] = [];
  for (let k = end; k >= 0; k = prev[k]!) { out.unshift(pts[k]!); if (k === 0) break; }
  return out;
}

/** The route point nearest a target (XZ), or null when none is within `maxM`. */
/** The route point nearest `at` (XZ). With `surfaceY` and a target with no height (a clearing on the open ground), points whose
 *  declared floor lies more than BURIED_M under the surface there (a spiral-stair corner down a shaft, a cave floor) are passed over
 *  while a surface point is within reach: the planner cannot climb out of a shaft (kirk-stair 2026-10-21: the waymark clearing was
 *  reached from a stair corner 15 m down, STUCK at once). */
export const BURIED_M = 3;
export function nearestRoutePoint(routes: Route[], at: Pt, maxM = 260, surfaceY?: (x: number, z: number) => number): Pt | null {
  const pick = (ok: (p: Pt) => boolean): Pt | null => {
    let best: Pt | null = null, bd = maxM;
    for (const r of routes) for (const p of densifyPts(r.points, 4)) { if (!ok(p)) continue; const d = Math.hypot(p[0] - at[0], p[2] - at[2]); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  if (surfaceY && at[1] === null) { const s = pick((p) => p[1] === null || p[1] >= surfaceY(p[0], p[2]) - BURIED_M); if (s) return s; }
  return pick(() => true);
}

// ------------------------------------------------------------------------------------------------ judging

/**
 * One tick of a walked leg: feet position and time (s), and `air`: the feet's height over the first surface under
 * them (Infinity: nothing within reach). Without `air` (not measured) every drop counts.
 */
export interface Sample { x: number; y: number; z: number; t: number; air?: number }
export interface LegResult { ok: boolean; faults: Fault[]; end: P3; dXZ: number; dY: number | null; seconds: number; worstDrop: number }

/** The worst drop within any FALL_WINDOW_S window in which the body was airborne (see AIR_M), and where it ended. */
export function worstDrop(samples: Sample[], window = FALL_WINDOW_S): { drop: number; at: P3 | null } {
  let drop = 0, at: P3 | null = null, j = 0;
  // max over i of (max y in [t_i - window, t_i]) - y_i, with a monotone deque of indices; a second deque keeps the
  // window's highest `air` (a window that never left the ground is a stair, not a fall)
  const dq: number[] = [], aq: number[] = [];
  const air = (k: number): number => samples[k]!.air ?? Infinity;
  for (let i = 0; i < samples.length; i++) {
    while (dq.length && samples[dq[dq.length - 1]!]!.y <= samples[i]!.y) dq.pop();
    dq.push(i);
    while (aq.length && air(aq[aq.length - 1]!) <= air(i)) aq.pop();
    aq.push(i);
    while (samples[i]!.t - samples[j]!.t > window) j++;
    while (dq[0]! < j) dq.shift();
    while (aq[0]! < j) aq.shift();
    if (air(aq[0]!) <= AIR_M) continue;
    const d = samples[dq[0]!]!.y - samples[i]!.y;
    if (d > drop) { drop = d; at = [samples[i]!.x, samples[i]!.y, samples[i]!.z]; }
  }
  return { drop, at };
}

/**
 * Judge one walked leg: FALL (a drop over FALL_M within FALL_WINDOW_S, unless the leg is a declared drop), STUCK
 * (the driver gave up: no progress for STUCK_S after its jumps), MISS (ended over tolXZ from the goal, or more than
 * MISS_Y from its height when the goal has one; a wading goal under water counts within wadeXZ).
 */
export function judgeLeg(what: string, samples: Sample[], goal: Pt, o: { tolXZ?: number; drop?: boolean; stuckAt?: P3 | null; wet?: boolean; wadeXZ?: number; tolY?: number } = {}): LegResult {
  const last = samples[samples.length - 1];
  const end: P3 = last ? [last.x, last.y, last.z] : [NaN, NaN, NaN];
  const faults: Fault[] = [];
  const wd = worstDrop(samples);
  if (!o.drop && wd.drop > FALL_M) faults.push({ kind: "FALL", what, at: wd.at!, detail: `fell ${r2(wd.drop)} m in ${FALL_WINDOW_S} s` });
  if (o.stuckAt) faults.push({ kind: "STUCK", what, at: o.stuckAt, detail: `no progress for ${STUCK_S} s` });
  const dXZ = last ? Math.hypot(end[0] - goal[0], end[2] - goal[2]) : Infinity;
  const dY = last && goal[1] !== null ? end[1] - goal[1] : null;
  const tol = o.wet && o.wadeXZ ? Math.max(o.wadeXZ, o.tolXZ ?? MISS_XZ) : o.tolXZ ?? MISS_XZ;
  const tolY = o.tolY ?? MISS_Y;
  if (dXZ > tol) faults.push({ kind: "MISS", what, at: end, detail: `ended ${r2(dXZ)} m from the goal (allowed ${tol})` });
  else if (dY !== null && Math.abs(dY) > tolY && !o.wet) faults.push({ kind: "MISS", what, at: end, detail: `ended ${r2(Math.abs(dY))} m ${dY < 0 ? "below" : "above"} the goal height (allowed ${tolY})` });
  return { ok: faults.length === 0, faults, end, dXZ: r2(dXZ), dY: dY === null ? null : r2(dY), seconds: last ? r2(last.t - samples[0]!.t) : 0, worstDrop: r2(wd.drop) };
}

/**
 * The height a leg's goal is judged at. A route point's declared height is the TERRAIN under it (handoff routes are
 * measured on the field), but a body arriving on a built surface over that point (stair treads, a footpath ribbon's
 * steps, a deck) stands on the surface, not the ground beneath: "ended 2.65 m above the goal height" was the walk
 * comparing to the terrain under the stairs. The goal is the walkable surface of the goal column (the declared ground
 * or any collider top cast there) nearest the body's end height; no declared height stays null.
 */
export function goalSurface(declared: number | null, surfaces: number[], endY: number): number | null {
  if (declared === null) return null;
  return [declared, ...surfaces].reduce((m, s) => (Math.abs(s - endY) < Math.abs(m - endY) ? s : m), declared);
}

/** ONE-WAY: a route leg fine one way and failing the other (legs numbered forward; `back[k]` is the same leg walked back). */
export function oneWayFaults(route: string, fwd: Array<{ ok: boolean; from: Pt; to: Pt } | undefined>, back: Array<{ ok: boolean } | undefined>): Fault[] {
  const out: Fault[] = [];
  fwd.forEach((f, k) => {
    const b = back[k];
    if (!f || !b || f.ok === b.ok) return;
    out.push({ kind: "ONE-WAY", what: `${route} leg ${k}`, at: [f.to[0], f.to[1] ?? NaN, f.to[2]], detail: f.ok ? "walks forward, fails coming back" : "fails forward, walks coming back" });
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ streaming

/**
 * STREAM: points of a collider footprint where a body standing there would NOT have the collider loaded. `carriers` are
 * the chunk keys whose loaded entities include the collider; `ring(x, z)` the keys the server keeps around a body.
 */
export function uncoveredPoints(footprint: P3[], carriers: ReadonlySet<string>, ring: (x: number, z: number) => Iterable<string>): P3[] {
  const out: P3[] = [];
  for (const p of footprint) {
    let covered = false;
    for (const k of ring(p[0], p[2])) if (carriers.has(k)) { covered = true; break; }
    if (!covered) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ shadowing

export interface AssetRef { kind: "prefabs" | "models" | "materials"; id: string }

/** Every prefab / model / material id a JSON value references (prefabId, assetId, material strings). */
export function assetRefs(value: unknown, out = new Map<string, AssetRef>()): Map<string, AssetRef> {
  const add = (kind: AssetRef["kind"], id: string): void => {
    const file = kind === "prefabs" || kind === "materials" ? `${id}.json` : id;
    out.set(`${kind}/${file}`, { kind, id: file });
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "prefabId" && typeof x === "string") add("prefabs", x);
      else if (k === "assetId" && typeof x === "string") add("models", x);
      else if (k === "material" && typeof x === "string" && !x.startsWith("auto:")) add("materials", x);
      else walk(x);
    }
  };
  walk(value);
  return out;
}

/**
 * SHADOW: an asset id whose bytes differ between the project the server resolves it from (the first closure root
 * holding it) and any other project of the playground. `fingerprint(file)` hashes a file (injected for tests).
 */
/**
 * SHADOW: an asset the POI uses whose bytes differ under the same id in another project. `pending` (a job's own delivery,
 * FIX-OK4): the job folder holds the asset with the SERVED bytes and its installer replaces the copy in its home project
 * (the install target), so a lab served copy that differs from the not-yet-updated home copy is the pending install, not a
 * shadow; a third project with other bytes still is.
 */
export function shadowFaults(refs: Iterable<AssetRef>, closure: string[], allProjects: string[], fingerprint: (file: string) => string | null, pending?: { home: string; jobAssets: string }): Fault[] {
  const out: Fault[] = [];
  for (const r of refs) {
    const rel = path.join("assets", r.kind, r.id);
    const winner = closure.find((root) => fingerprint(path.join(root, rel)) !== null);
    if (!winner) continue;
    const mine = fingerprint(path.join(winner, rel));
    // (a job folder keeps its delivery under assets/<kind>/ or straight under <kind>/, e.g. materials/hagsheer-weep/x.json)
    const delivered = !!pending && [path.join(pending.jobAssets, r.kind, r.id), path.join(path.dirname(pending.jobAssets), r.kind, r.id)].some((p) => fingerprint(p) === mine);
    const others = allProjects.filter((p) => path.resolve(p) !== path.resolve(winner) && !(delivered && path.resolve(p) === path.resolve(pending!.home)) && fingerprint(path.join(p, rel)) !== null && fingerprint(path.join(p, rel)) !== mine);
    if (others.length) out.push({ kind: "SHADOW", what: `${r.kind}/${r.id}`, detail: `served from ${path.basename(winner)}; different bytes under the same id in ${others.map((p) => path.basename(p)).join(", ")} (an unscoped tool walks the wrong copy)` });
  }
  return out;
}

/** Steepest surface (normal y) a dropped body is expected to stand on: about 50 degrees. */
export const WALKABLE_NY = 0.64;
/**
 * The highest WALKABLE surface in a column, from top-down ray hits (first = highest): the first hit whose normal faces
 * up enough to stand on (a pole top or a wall edge is skipped), else the terrain height. A height-less target is judged
 * against it (no free pass: dressing centres, clearings and quest entities declare no y).
 */
export function highestWalkable(hits: Array<{ y: number; ny: number }>, groundY: number): number {
  for (const h of hits) if (h.ny >= WALKABLE_NY && h.y >= groundY - 0.25) return h.y;
  return groundY;
}
/**
 * The drop test of a height-less target: the body was dropped from above onto `surfaceY` (highestWalkable); it must
 * stand within `tolY` of it (water forgives: the body floats). A body that ended below fell through or slid off.
 */
export function dropHoldFault(id: string, feet: P3, surfaceY: number, wet: boolean, tolY = MISS_Y): Fault | null {
  if (wet || Math.abs(feet[1] - surfaceY) <= tolY) return null;
  return { kind: "MISS", what: `${id} hold`, at: feet, detail: `no declared height: dropped onto the highest walkable surface at y ${r2(surfaceY)}, it ended at y ${r2(feet[1])} (${r2(Math.abs(feet[1] - surfaceY))} m ${feet[1] < surfaceY ? "below" : "above"}, allowed ${tolY})` };
}

/**
 * A portal target, after the reach. The caller starts watching BEFORE the reach: a walk-through (trigger) portal sends
 * the moment the body walks into its box, which is on the reach itself; a watch cleared after the reach never saw a
 * send (and a body already standing in the box has no entering edge to send on). Not sent yet: a trigger portal is
 * stepped out of and walked into again once, an interact portal gets [E]. Only THIS portal's travels count.
 */
export interface PortalSteps { stepOut(): void; walkIn(): void; interact(): void; idle(): void }
/**
 * Where a trigger portal's walk-in stops: on the portal plane, just inside the box's near face (toward `from`, the side the
 * walk came from), not at the anchor. Aimed at the anchor, a body running in coasts past it, and in a shallow sealed recess
 * it ran into the back wall: moon 2026-10-31, a BODY at the recess back wall 1.7 m past the anchor, 2 m behind the
 * portal plane. `half` is the box's smaller horizontal half extent; the stop is `PORTAL_INSIDE_M` inside its face.
 */
export const PORTAL_INSIDE_M = 0.25;
export function portalWalkInPoint(at: P3 | readonly [number, number | null, number], from: readonly [number, number | null, number], half: number | undefined): [number, number | null, number] {
  const ux = from[0] - at[0], uz = from[2] - at[2], l = Math.hypot(ux, uz);
  const back = half !== undefined && l > 1e-6 ? Math.max(0, half - PORTAL_INSIDE_M) : 0;
  return back > 0 ? [at[0] + (ux / l) * back, at[1], at[2] + (uz / l) * back] : [at[0], at[1], at[2]];
}
export function portalSentAfterReach(portal: { entityId: string; trigger: boolean }, travels: ReadonlyArray<unknown>, steps: PortalSteps): boolean {
  const sent = (): boolean => travels.some((t) => (t as { portalId?: unknown } | null)?.portalId === portal.entityId);
  if (sent()) return true;
  if (portal.trigger) { steps.stepOut(); steps.idle(); steps.walkIn(); } else steps.interact();
  steps.idle();
  return sent();
}

/**
 * Stop the leg here? True right after a > FALL_M drop within the last 0.5 s with the feet off the ground (the body is
 * somewhere else now). Never on a declared `drops` leg: running down a steep flight the body flies tread to tread, and
 * stopping it mid-flight ended the leg metres short of its goal (FIX-HW4: weeping-stair forward leg 14, MISS 3.3 m).
 */
export function fellJustNow(trace: readonly Sample[], dt: number, drop = false): boolean {
  if (drop) return false;
  const n = trace.length, w = Math.round(FALL_WINDOW_S / dt);
  if (n <= w || trace[n - 1 - w]!.y - trace[n - 1]!.y <= FALL_M) return false;
  for (let i = n - 1 - w; i < n; i++) if ((trace[i]!.air ?? Infinity) > AIR_M) return true;
  return false;
}

// ---- BODY: no visible mesh may cross the walking player's body
/** The player body volume: a vertical capsule of `radius` from `bottom` (over a riser: treads and floor boards are not
 *  the body's business) to `top` above the feet; a triangle counts when it reaches `tol` inside it. */
export const BODY = { radius: 0.4, bottom: 0.5, top: 1.8, tol: 0.1 } as const;   // bottom: over a stair riser and its tread board (0.4 + 0.1: the body stands at a riser foot); tol: under 0.1 m is the body sliding along a wall or post it collides with
/** Distance from p to triangle abc (closest point: Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriDist(p: P3, a: P3, b: P3, c: P3): number {
  const sub = (u: P3, v: P3): P3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u: P3, v: P3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const at = (q: P3): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const on = (o: P3, d: P3, t: number): P3 => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(on(a, ab, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(on(a, ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return at(on(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}
/**
 * BODY faults: every visible mesh (world-space triangles, nine numbers each) that crosses the player's body volume
 * (BODY) at any walked feet position — a visual-only board standing across a passage, a set post in the way, a prop
 * whose collider lets the body walk into its mesh. One fault per mesh: where it cut deepest and at how many points.
 */
/** Meshes the walking body passes through by design (BODY skips them): an instance boundary / portal veil, and the scene's
 *  own player avatar (tag `player`: the spawn puppet the server replaces with the walker; it stood at a lab's spawn = the
 *  route's start and read as "a visible mesh crosses the player's body", FIX-OK5). */
export const WALK_THROUGH_TAGS: ReadonlySet<string> = new Set(["zone-boundary", "portal-veil", "walk-through", "player"]);
/** An entity BODY never judges: hidden, no mesh/prefab, a WALK_THROUGH_TAGS piece, or anything carried by a MOVING body — itself or an
 *  ancestor with a non-fixed rigidbody or tagged npc/populate (a creature or NPC: it walks off its spawn and its own collider
 *  shoves the player; widows-arch 2026-10-21: the widow's and the hierophant's spawn spots on the route were 4 BODY faults). */
export function bodySkip(entities: Record<string, any>, id: string): boolean {
  const e = entities[id];
  if (!e || !(e.components?.mesh || e.components?.prefab) || e.components?.visibility?.visible === false || e.components?.mesh?.visible === false) return true;
  // a WATER sheet (a `water` component: still water a body wades through, a layout `waters` sheet) is waded, never a clash.
  // L (w-temple10 2026-11-03: the sunken temple stair passage's own dark water flagged BODY at every wading step)
  if (e.components?.water) return true;
  for (let cur: any = e, n = 0; cur && n < 64; cur = cur.parent ? entities[cur.parent] : null, n++) {
    const tags: string[] = cur.tags ?? [];
    if (tags.some((t) => WALK_THROUGH_TAGS.has(t) || t === "npc" || t === "populate")) return true;
    const kind = cur.components?.rigidbody?.kind;
    if (kind && kind !== "fixed" && kind !== "static") return true;
  }
  return false;
}
export function bodyClashes(feet: readonly P3[], meshes: ReadonlyArray<{ id: string; world: ArrayLike<number> }>, o: { radius: number; bottom: number; top: number; tol: number } = BODY): Fault[] {
  const CELL = 1, key = (i: number, k: number): string => `${i},${k}`;
  const grid = new Map<string, number[]>();
  feet.forEach((p, n) => { const k = key(Math.floor(p[0] / CELL), Math.floor(p[2] / CELL)); const l = grid.get(k); if (l) l.push(n); else grid.set(k, [n]); });
  const r = o.radius, y0 = o.bottom + r, y1 = Math.max(y0, o.top - r), steps = Math.max(1, Math.ceil((y1 - y0) / 0.1));
  const out: Fault[] = [];
  for (const m of meshes) {
    const w = m.world, hit = new Set<number>();
    let worst = 0, at: P3 | null = null;
    for (let t = 0; t + 8 < w.length; t += 9) {
      const a: P3 = [w[t]!, w[t + 1]!, w[t + 2]!], b: P3 = [w[t + 3]!, w[t + 4]!, w[t + 5]!], c: P3 = [w[t + 6]!, w[t + 7]!, w[t + 8]!];
      const i0 = Math.floor((Math.min(a[0], b[0], c[0]) - r) / CELL), i1 = Math.floor((Math.max(a[0], b[0], c[0]) + r) / CELL);
      const k0 = Math.floor((Math.min(a[2], b[2], c[2]) - r) / CELL), k1 = Math.floor((Math.max(a[2], b[2], c[2]) + r) / CELL);
      if ((i1 - i0 + 1) * (k1 - k0 + 1) > 4096) continue;   // a triangle over 60 m across is no body-sized thing
      const ylo = Math.min(a[1], b[1], c[1]) - r, yhi = Math.max(a[1], b[1], c[1]) + r;
      for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) for (const n of grid.get(key(i, k)) ?? []) {
        const f = feet[n]!;
        if (yhi < f[1] + y0 || ylo > f[1] + y1) continue;
        for (let s = 0; s <= steps; s++) {
          const d = pointTriDist([f[0], f[1] + y0 + ((y1 - y0) * s) / steps, f[2]], a, b, c);
          if (d < r - o.tol) { hit.add(n); if (r - d > worst) { worst = r - d; at = f; } break; }
        }
      }
    }
    if (hit.size) out.push({ kind: "BODY", what: m.id, at: at!, detail: `a visible mesh crosses the player's body (capsule r ${r} m, ${o.bottom}-${o.top} m over the feet) at ${hit.size} walked point(s), up to ${worst.toFixed(2)} m deep: cut it back to the walls or give it a collider` });
  }
  return out;
}
/** Walked feet for BODY: on the ground (air under 0.5 m), at least `gap` metres apart. */
export function bodyTrail(samples: ReadonlyArray<Sample>, gap = 0.25, into: P3[] = []): P3[] {
  for (const s of samples) {
    if ((s.air ?? 0) > 0.5) continue;
    const l = into[into.length - 1];
    if (l && Math.hypot(s.x - l[0], s.y - l[1], s.z - l[2]) < gap) continue;
    into.push([s.x, s.y, s.z]);
  }
  return into;
}
