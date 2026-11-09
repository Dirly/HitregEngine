/**
 * The tools' side of the PLACEMENT SOLVER (@hitreg/core place-solver): what a placer knows about a prefab and a scene,
 * turned into solver requests and context, and the solver's answers turned back into ops.
 *
 * Every placer calls this before it writes ops (place-build layout pieces and its as-built re-seat, `dress apply`,
 * settle, the town builder, statue placement). An agent gives position + yaw (+ an optional host / marker); the solver
 * returns the corrected transform or drops the piece with a reason. Nothing here tunes a y by hand.
 *
 *  - placeRuleOf(project, prefab)   the prefab root's `placeRule` (null = the solver's defaults: seat foot, no foundation)
 *  - prefabInfo(project, prefab)    catalogue size, footing, height, solid, the model's markers
 *  - sceneContext(...)              obstacles (every solid placed structure: its base box) + keep-outs (doors, gates,
 *                                   stairs, hearth clearances from `<model>.markers.json`; prop `placeRule.openings`;
 *                                   lanes the caller passes) round the pieces being placed
 *  - solveScenePieces(...)          re-solve placed scene pieces on the ground AS BUILT: transform ops, foundation
 *                                   skirt entities (`<id>--foundation`), drops; one ops batch the caller applies
 */
import fs from "node:fs";
import path from "node:path";
import {
  findRepeats, docOfOps, foundationEntity, localToWorld, candidateSpots, keepOutsFromMarkers, keepOutsFromOpenings, placeRuleOf, solvePlacement, worldTransforms,
  type KeepOut, type PlaceContext, type PlaceObstacle, type PlaceRequest, type PlaceResult, type PlaceRule, type StructureMarker, type RepeatFinding,
} from "@hitreg/core";
import { findAsset, PROJECTS } from "./_closure.mjs";
import { prefabGeometry } from "./_prop-geometry.mts";

type V2 = [number, number];
const readJ = (f: string): any => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));

export interface PrefabPlaceInfo {
  prefab: string;
  /** Catalogue dressing.size [x, y, z] (unscaled). */
  size: [number, number, number] | null;
  footing: number;
  solid: boolean;
  /** The raw `placeRule` component on the prefab root (null when none is declared). */
  rule: Partial<PlaceRule> | null;
  /** The model's markers (`<model>.markers.json` beside the GLB the prefab's first asset mesh names), [] when none. */
  markers: StructureMarker[];
  /** The model asset id the markers came from. */
  model: string | null;
}

const infoCache = new Map<string, PrefabPlaceInfo | null>();
/** What the solver needs to know about a prefab (cached per project + id). */
export function prefabInfo(project: string, prefab: string): PrefabPlaceInfo | null {
  const key = `${project}|${prefab}`;
  if (infoCache.has(key)) return infoCache.get(key)!;
  let out: PrefabPlaceInfo | null = null;
  try {
    const f = findAsset(project, `prefabs/${prefab}.json`);
    if (f) {
      const d = readJ(f), ents = Object.values(d.entities ?? {}) as any[], root = d.entities?.[d.root] ?? ents.find((e) => e.parent == null) ?? ents[0];
      const dr = root?.components?.dressing ?? ents.map((e) => e?.components?.dressing).find(Boolean);
      const model = ents.map((e) => e?.components?.mesh?.source).find((s) => s?.kind === "asset" && typeof s.assetId === "string")?.assetId ?? null;
      let markers: StructureMarker[] = [];
      if (model) { const mf = findAsset(project, `models/${String(model).replace(/\.glb$/, "")}.markers.json`); if (mf) markers = readJ(mf).markers ?? []; }
      out = {
        prefab, size: Array.isArray(dr?.size) && dr.size.length >= 3 ? [dr.size[0], dr.size[1], dr.size[2]] : null, footing: Number(dr?.footing) || 0,
        solid: dr?.solid !== false, rule: root?.components?.placeRule ?? null, markers, model,
      };
    }
  } catch { out = null; }
  infoCache.set(key, out);
  return out;
}
const flatCache = new Map<string, number[]>();
/** A structure's horizontal faces near its base (prefab frame, unscaled; from its footing's bottom to 1 m up, at least
 *  0.25 m2 of them at that height): the solver keeps each out of the ground's plane. */
export function baseFlats(project: string, prefab: string, footing: number): number[] {
  const key = `${project}|${prefab}`;
  if (flatCache.has(key)) return flatCache.get(key)!;
  const area = new Map<number, number>();
  try {
    for (const t of prefabGeometry(path.join(PROJECTS, project, "assets"), prefab).tris) {
      if (Math.abs(t.a[1] - t.b[1]) > 1e-3 || Math.abs(t.a[1] - t.c[1]) > 1e-3 || t.a[1] < -footing - 0.1 || t.a[1] > 1) continue;
      const a = Math.abs((t.b[0] - t.a[0]) * (t.c[2] - t.a[2]) - (t.c[0] - t.a[0]) * (t.b[2] - t.a[2])) / 2, y = Math.round(t.a[1] * 1000) / 1000;
      area.set(y, (area.get(y) ?? 0) + a);
    }
  } catch { /* unreadable geometry: no flats */ }
  const out = [...area].filter(([, a]) => a >= 0.25).map(([y]) => y);
  flatCache.set(key, out);
  return out;
}

/** Plan cell size (m) of a structure's solid columns. */
export const SOLID_CELL_M = 0.5;
const cellCache = new Map<string, V2[] | null>();
/**
 * A structure's SOLID columns, prefab frame (unscaled): the 0.5 m plan cells where its mesh has a surface between its
 * footing's bottom and 1.5 m over its base (a wall's top or underside, a pier, a floor slab), so an open court's yard and
 * the street between two walls are not solid while its walls are. Null when the geometry cannot be read (the box is then
 * the obstacle).
 */
export function solidCells(project: string, prefab: string): V2[] | null {
  const key = `${project}|${prefab}`;
  if (cellCache.has(key)) return cellCache.get(key)!;
  let out: V2[] | null = null;
  try {
    const g = prefabGeometry(path.join(PROJECTS, project, "assets"), prefab);
    if (g.tris.length) {
      const y0 = g.min[1] - 0.01, y1 = Math.max(0, 0) + 1.5, c = SOLID_CELL_M;
      const nx = Math.max(1, Math.ceil((g.max[0] - g.min[0]) / c)), nz = Math.max(1, Math.ceil((g.max[2] - g.min[2]) / c));
      const solid = new Uint8Array(nx * nz);
      for (const t of g.tris) {
        const ys = [t.a[1], t.b[1], t.c[1]];
        if (Math.max(...ys) < y0 || Math.min(...ys) > y1) continue;
        const x0 = Math.min(t.a[0], t.b[0], t.c[0]), x1 = Math.max(t.a[0], t.b[0], t.c[0]), z0 = Math.min(t.a[2], t.b[2], t.c[2]), z1 = Math.max(t.a[2], t.b[2], t.c[2]);
        // a vertical face (a wall's side) marks the cells it stands in too: its plan footprint is a line
        for (let i = Math.max(0, Math.floor((x0 - g.min[0]) / c)); i <= Math.min(nx - 1, Math.floor((x1 - g.min[0]) / c)); i++)
          for (let j = Math.max(0, Math.floor((z0 - g.min[2]) / c)); j <= Math.min(nz - 1, Math.floor((z1 - g.min[2]) / c)); j++) {
            const cx = g.min[0] + (i + 0.5) * c, cz = g.min[2] + (j + 0.5) * c;
            if (segDistToTri2D(cx, cz, t) <= c * 0.5) solid[i * nz + j] = 1;
          }
      }
      out = [];
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) if (solid[i * nz + j]) out.push([g.min[0] + (i + 0.5) * c, g.min[2] + (j + 0.5) * c]);
    }
  } catch { out = null; }
  cellCache.set(key, out);
  return out;
}
/** Plan distance from a point to a triangle (0 inside it). */
function segDistToTri2D(x: number, z: number, t: { a: number[]; b: number[]; c: number[] }): number {
  const P = [[t.a[0]!, t.a[2]!], [t.b[0]!, t.b[2]!], [t.c[0]!, t.c[2]!]] as const;
  const cross = (o: readonly number[], p: readonly number[]) => (p[0]! - o[0]!) * (z - o[1]!) - (p[1]! - o[1]!) * (x - o[0]!);
  const s0 = cross(P[0], P[1]), s1 = cross(P[1], P[2]), s2 = cross(P[2], P[0]);
  if ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0)) {
    // inside, or a degenerate (vertical) triangle: fall through to the edge distance for the latter
    const area = Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]));
    if (area > 1e-9) return 0;
  }
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const a = P[k]!, b = P[(k + 1) % 3]!, dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    const u = L > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L)) : 0;
    best = Math.min(best, Math.hypot(x - a[0] - u * dx, z - a[1] - u * dz));
  }
  return best;
}

/** The prefab root's `placeRule`, or null when it declares none. */
export const placeRuleFor = (project: string, prefab: string): Partial<PlaceRule> | null => prefabInfo(project, prefab)?.rule ?? null;
/** A host's named markers (for a piece `on` it), own frame. */
export const markerTable = (project: string, prefab: string): Record<string, { position: [number, number, number] }> =>
  Object.fromEntries((prefabInfo(project, prefab)?.markers ?? []).map((m) => [m.id, { position: m.position }]));

/** yaw (radians, three.js about +Y) of a quaternion that is a pure yaw (place-build writes nothing else for solver pieces). */
export const yawOf = (q: number[] | undefined): number => (q ? 2 * Math.atan2(q[1] ?? 0, q[3] ?? 1) : 0);
const yawQuat = (yaw: number): number[] => [0, Math.round(Math.sin(yaw / 2) * 1e4) / 1e4, 0, Math.round(Math.cos(yaw / 2) * 1e4) / 1e4];
const scaleOf = (s: unknown): number => (Array.isArray(s) ? Number(s[0]) || 1 : typeof s === "number" ? s : 1);

/** The request for one piece at a world spot. Null when the catalogue gives no size (the solver cannot judge it). */
export function requestFor(project: string, id: string, prefab: string, at: V2, yaw: number, scale = 1, extra: Partial<PlaceRequest> = {}): PlaceRequest | null {
  const info = prefabInfo(project, prefab);
  if (!info?.size) return null;
  // a STRUCTURE (solid, >= 6 m2) collides by its own solid cells: an open court's yard may hold a fire basin
  const cells = info.solid && info.size[0] * info.size[2] * scale * scale >= 6 ? solidCells(project, prefab) : null;
  return { id, prefab, at, yaw, scale, half: [(info.size[0] * scale) / 2, (info.size[2] * scale) / 2], height: info.size[1] * scale, footing: info.footing * scale, rule: info.rule,
    ...(cells?.length ? { cells: cells.map((c) => [c[0] * scale, c[1] * scale] as V2), cell: SOLID_CELL_M * scale } : {}),
    ...(cells?.length ? { flats: baseFlats(project, prefab, info.footing).map((f) => f * scale) } : {}), ...extra };
}

export interface SceneContextOptions {
  /** Only structures/keep-outs within this plan distance of a placed piece count (m). */
  reach?: number;
  /** Entities never treated as obstacles (the pieces being placed, their children). */
  exclude?: Set<string>;
  /** Extra keep-outs (lanes, town lot doors). */
  keepOuts?: KeepOut[];
  /** Footprint area (m2) from which a placed prefab is a STRUCTURE obstacle (smaller = dressing, judged by dress check). */
  minObstacleArea?: number;
}

/** Obstacles + keep-outs of a scene document round `centres` (world plan). */
export function sceneContext(project: string, doc: any, ground: PlaceContext["ground"], centres: V2[], o: SceneContextOptions = {}): PlaceContext {
  const wt = worldTransforms(doc), reach = o.reach ?? 60, minA = o.minObstacleArea ?? 6, obstacles: PlaceObstacle[] = [], keepOuts: KeepOut[] = [...(o.keepOuts ?? [])];
  const near = (p: V2) => centres.some((c) => Math.hypot(c[0] - p[0], c[1] - p[1]) <= reach);
  for (const [id, e] of Object.entries(doc.entities ?? {}) as [string, any][]) {
    const prefab = e?.components?.prefab?.prefabId;
    if (typeof prefab !== "string" || o.exclude?.has(id)) continue;
    const t = wt.get(id); if (!t) continue;
    // a piece standing ON another (a fire bowl on a pillar, a beacon in a court: tags on:<host> / slot:fire) is part of its
    // host, never an obstacle to it; its markers still make keep-outs
    const hosted = (e.tags ?? []).some((g: string) => g.startsWith("on:") || g === "slot:fire");
    const at: V2 = [t.position[0], t.position[2]];
    if (!near(at)) continue;
    const info = prefabInfo(project, prefab); if (!info?.size) continue;
    const k = scaleOf(t.scale), yaw = yawOf(t.rotation as number[]);
    const half: V2 = [(info.size[0] * k) / 2, (info.size[2] * k) / 2];
    if (info.solid && !hosted && 4 * half[0] * half[1] >= minA) {
      // the structure's own solid columns (walls, piers, slabs): an open court's yard is not solid, its walls are
      const cells = solidCells(project, prefab);
      const world = cells?.map((c) => localToWorld(at, yaw, [c[0] * k, c[1] * k]));
      if (!cells || cells.length) obstacles.push({ id, box: { c: at, half, yaw }, band: [t.position[1] - info.footing * k, t.position[1] + info.size[1] * k], ...(world ? { cells: world, cell: SOLID_CELL_M * k } : {}) });
    }
    if (info.markers.length) keepOuts.push(...keepOutsFromMarkers(id, { at, yaw, y: t.position[1], k }, info.markers));
    const openings = (info.rule as { openings?: unknown[] } | null)?.openings;
    if (Array.isArray(openings) && openings.length) keepOuts.push(...keepOutsFromOpenings(id, { at, yaw, y: t.position[1], k }, openings as never));
  }
  return { ground, obstacles, keepOuts };
}

export interface SolveRow { id: string; prefab: string; status: PlaceResult["status"]; reason?: string; notes: string[]; dy?: number; moved?: number; foundation?: { top: number; bottom: number; material: string } }

/**
 * Re-solve placed scene pieces (`ids`) on the ground AS BUILT. Pieces are judged where they stand (xz kept unless
 * `movable`), y set by their rule, a foundation skirt written (or re-written) for each one that needs it, and a piece
 * the solver drops is reported (removed only with `removeDropped`). Returns ONE ops batch and a row per piece.
 */
export function solveScenePieces(project: string, doc: any, ground: PlaceContext["ground"], ids: Iterable<string>, o: {
  movable?: boolean; removeDropped?: boolean; ctx?: SceneContextOptions;
  /** Keep each piece's own height (its seat was measured on the real floor by the caller: dress apply's voxel seat); the
   *  solver then judges only plan rules (keep-outs, structures) and moves or drops. */
  keepY?: boolean;
  /** Hold each piece's height and only lay its foundation skirt where daylight shows under it (core holdY; r-found 2026-10-30). */
  holdY?: boolean; only?: (id: string, prefab: string, rule: Partial<PlaceRule> | null) => boolean; foundationParent?: (id: string) => string | null; tags?: (id: string) => string[];
} = {}): { ops: any[]; rows: SolveRow[] } {
  const wt = worldTransforms(doc), list = [...ids].filter((id) => doc.entities?.[id]?.components?.prefab?.prefabId);
  const centres = list.map((id) => { const p = wt.get(id)?.position ?? [0, 0, 0]; return [p[0], p[2]] as V2; });
  const ctx = sceneContext(project, doc, ground, centres, { ...o.ctx, exclude: new Set([...(o.ctx?.exclude ?? []), ...list]) });
  const ops: any[] = [], rows: SolveRow[] = [];
  for (const id of list) {
    const e = doc.entities[id], prefab = e.components.prefab.prefabId as string, t = e.components.transform ?? {};
    const info = prefabInfo(project, prefab);
    if (o.only && !o.only(id, prefab, info?.rule ?? null)) continue;
    const w = wt.get(id)!, k = scaleOf(t.scale), yaw = yawOf(w.rotation as number[]);
    const req = requestFor(project, id, prefab, [w.position[0], w.position[2]], yaw, k, { y: w.position[1], movable: o.movable ?? false, ...(o.keepY ? { seat: "float-ok" as const } : {}), ...(o.holdY ? { holdY: w.position[1] } : {}) });
    if (!req) continue;
    const r = solvePlacement(req, o.keepY ? { ...ctx, ground: () => w.position[1] } : ctx);
    const old = `${id}--foundation`;
    if (r.status === "dropped") {
      rows.push({ id, prefab, status: r.status, reason: r.reason ?? "", notes: r.notes });
      // L (r-found 2026-10-31): a refused re-solve keeps the piece AND its foundation as they stand (the skirt was taken off
      // and the street wall floated 0.94 m); only a removed piece loses its skirt
      if (o.removeDropped) { ops.push({ op: "remove-entity", id }); if (doc.entities[old]) ops.push({ op: "remove-entity", id: old }); }
      continue;
    }
    if (doc.entities[old]) ops.push({ op: "remove-entity", id: old });
    // world -> the entity's own parent frame: parents are translated (place roots), never turned, in every placer we write
    const pp = e.parent ? wt.get(e.parent)?.position ?? [0, 0, 0] : [0, 0, 0];
    const pos = [Math.round((r.x! - pp[0]) * 1000) / 1000, Math.round((r.y! - pp[1]) * 1000) / 1000, Math.round((r.z! - pp[2]) * 1000) / 1000];
    const q = t.position ?? [0, 0, 0], dy = Math.round((r.y! - w.position[1]) * 1000) / 1000;
    if (Math.abs(pos[0] - q[0]) > 1e-3 || Math.abs(pos[1] - q[1]) > 1e-3 || Math.abs(pos[2] - q[2]) > 1e-3 || (r.yaw !== undefined && Math.abs(r.yaw - yaw) > 1e-4))
      ops.push({ op: "set-component", id, component: "transform", data: { ...t, position: pos, ...(r.yaw !== undefined && Math.abs(r.yaw - yaw) > 1e-4 ? { rotation: yawQuat(r.yaw - (e.parent ? yawOf(wt.get(e.parent)?.rotation as number[]) : 0)) } : {}) } });
    if (r.foundation) {
      const parent = o.foundationParent ? o.foundationParent(id) : e.parent ?? null, po = parent ? wt.get(parent)?.position ?? [0, 0, 0] : [0, 0, 0];
      ops.push({ op: "add-entity", id: old, entity: foundationEntity(r.foundation, { parent, origin: po as [number, number, number], tags: [...(e.tags ?? []).filter((g: string) => /^poi:|^dress:|^town:/.test(g)), ...(o.tags?.(id) ?? [])] }) });
    }
    rows.push({ id, prefab, status: r.status, notes: r.notes, dy, ...(r.moved ? { moved: r.moved } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.foundation ? { foundation: { top: r.foundation.top, bottom: r.foundation.bottom, material: r.foundation.material } } : {}) });
  }
  return { ops, rows };
}

/** Repeat-lint the entities an ops batch adds (tools emit prefab references, never repeated inline assemblies). */
export function repeatsInOps(ops: readonly any[]): RepeatFinding[] {
  return findRepeats(docOfOps(ops), { scope: "scene" }).filter((f) => !f.ids.every((id) => /--foundation$/.test(id)));
}

/** The dressing resolver's site-spread cell (m) and the count a moved prop may never make in one (3: the resolver's rule). */
export const SPREAD_CELL_M = 5;
export const SPREAD_MAX = 3;
/**
 * Relocation offsets for a prop at `at` (world plan) among the plan's `others`, nearest first within `move` m: only spots
 * where no SPREAD_CELL_M cell, however the resolver's grid falls, would hold SPREAD_MAX or more of them with this one
 * (conservative: fewer than SPREAD_MAX - 1 others within a cell's width on both axes). Empty = drop it.
 */
export function spreadSpots(at: V2, others: V2[], move = 1.5, cell = SPREAD_CELL_M, max = SPREAD_MAX): V2[] {
  const crowd = (q: V2) => others.filter((o) => Math.abs(o[0] - q[0]) < cell && Math.abs(o[1] - q[1]) < cell).length;
  return candidateSpots(move, 0).slice(1).map(([dx, dz]) => [dx, dz] as V2).filter(([dx, dz]) => crowd([at[0] + dx, at[1] + dz]) < max - 1);
}

/** One line per solver row for a log. */
export const solveLine = (r: SolveRow): string =>
  `${r.status.padEnd(7)} ${r.id} (${r.prefab})${r.dy ? ` dy ${r.dy}` : ""}${r.moved ? ` moved ${r.moved} m` : ""}${r.foundation ? ` foundation ${Math.round((r.foundation.top - r.foundation.bottom) * 100) / 100} m` : ""}${r.reason ? `: ${r.reason}` : ""}${r.notes.length ? ` [${r.notes.join("; ")}]` : ""}`;

export const PLACE_SOLVE_FILE = (dir: string) => path.join(dir, "reports", "place-solve.json");
