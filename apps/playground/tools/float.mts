/**
 * FLOAT — does anything hang in the air? One gate for every placed object, measured against the REAL solid.
 *
 *   worldgen float <world> [--project p] [--near x,z,r | --rect x0,z0,x1,z1] [--no-scene] [--no-scatter]
 *                          [--legacy-scatter] [--tol 0.05] [--json] [--out f.json] [--list]
 *   node tools/float.mts scene <project> [--scene <id|file>] [--world <recipe id>] [--near x,z,r] [--json] [--out f]
 *   node tools/float.mts scene <project> ... --fix [--drop-unsupported | --drop-unsupported-rocks] [--inverse f.json]   (writes the scene)
 *   node tools/float.mts undo <project> --inverse f.json [--scene ...]                       (applies an inverse)
 *
 * Objects: every prefab instance in the scene (props, fires, torches, lanterns, baskets, rocks, structures) with
 * its contact kind from the catalogue (`dressing.contact`, else `defaultSeatContact`), its footprint from its own
 * geometry; and, for a world, every scatter rock (`ScatterDoc.contact` embed) the runtime places in the area.
 * Solid: the voxel field's density (edits, cuts, carves, planar treads, buttes — not the drawn heightfield, which
 * misses cuts: `seated`'s old blind spot) plus every other object's triangles (DC dungeon meshes, decks, stairs,
 * box colliders). One rule decides (`seatObject`, packages/core/src/voxel/seat.ts). A fault is a contact off by
 * more than `--tol` (5 cm): floating, an embed not embedded, a hang not touching, a wall piece off its wall — or
 * no support at all. Exit 1 on any fault. `--fix` re-seats what can be re-seated through applyOps (inverse kept);
 * unsupported objects are listed (and removed only with --drop-unsupported).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyOps,
  ComponentRegistry,
  registerCoreComponents,
  createWorldField,
  defaultSeatContact,
  fieldSolidProbe,
  scatterCell,
  scatterContact,
  scatterSeatSize,
  seatObject,
  triangleSolidProbe,
  unionSolidProbe,
  worldRecipeSchema,
  type SceneDoc,
  type SeatContact,
  type SeatOptions,
  type SeatResult,
  type SolidProbe,
  type WorldField,
  type WorldRecipe,
} from "@hitreg/core";
import { prefabFile, readJson, sceneGeometry, type SceneEntityGeometry } from "./_prop-geometry.mts";
import { findAsset, PROJECTS } from "./_closure.mjs";

export interface FloatRow {
  kind: "scene" | "scatter";
  id: string;
  what: string;
  contact: SeatContact;
  x: number;
  y: number;
  z: number;
  status: SeatResult["status"];
  gap: number;
  support: number;
  reason?: string;
  fix?: { y: number | null; x?: number; z?: number };
}
export interface FloatReport {
  ok: boolean;
  /** = ok; what the dungeon pipeline's stage table reads. */
  passed: boolean;
  target: string;
  area: string;
  tol: number;
  checked: { scene: number; scatter: number; unsized: number };
  counts: { off: number; unsupported: number; byKind: Record<string, number>; byContact: Record<string, number> };
  ms: { scene: number; scatter: number; perObjectMs: number };
  rows: FloatRow[];
}

type Area = { near?: [number, number, number]; rect?: [number, number, number, number] };
const inArea = (a: Area, x: number, z: number): boolean =>
  a.near ? Math.hypot(x - a.near[0], z - a.near[1]) <= a.near[2] : a.rect ? x >= a.rect[0] && z >= a.rect[1] && x <= a.rect[2] && z <= a.rect[3] : true;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r2 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

/** Ids a scene check skips: the player, NPCs, creatures, portals — things that move or are not set down. */
const SKIP_PREFAB = /^(characters|npcs?|creatures|mobs)\//;

/** The catalogue's dressing entry of a prefab (compiled onto its root by `props sync`), or undefined. */
function dressingOf(assets: string, prefabId: string): { contact?: SeatContact; mount?: string; category?: string } | undefined {
  try {
    const doc = readJson(prefabFile(assets, prefabId));
    const ents = doc.entities ?? {};
    const root = doc.root ?? Object.keys(ents).find((k) => ents[k].parent == null);
    return root ? ents[root]?.components?.dressing : undefined;
  } catch {
    return undefined;
  }
}

/** Footprint of an object from its root-frame bounds and world matrix (yaw-only objects; tilt ignored). */
function footprintOf(g: SceneEntityGeometry): { x: number; y: number; z: number; halfX: number; halfZ: number; yaw: number; height: number } {
  const m = g.m;
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!), sy = Math.hypot(m[4]!, m[5]!, m[6]!), sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const cx = (g.min[0] + g.max[0]) / 2, cz = (g.min[2] + g.max[2]) / 2, by = g.min[1];
  return {
    x: m[0]! * cx + m[4]! * by + m[8]! * cz + m[12]!,
    y: m[1]! * cx + m[5]! * by + m[9]! * cz + m[13]!,
    z: m[2]! * cx + m[6]! * by + m[10]! * cz + m[14]!,
    halfX: ((g.max[0] - g.min[0]) / 2) * sx,
    halfZ: ((g.max[2] - g.min[2]) / 2) * sz,
    yaw: Math.atan2(-m[2]!, m[0]!),
    height: (g.max[1] - g.min[1]) * sy,
  };
}

/** The object's own lowest point in the world column at (x, z) from its world triangles; null where none of it is there. */
export function undersideOf(world: ArrayLike<number>): (x: number, z: number) => number | null {
  return (qx, qz) => {
    let low: number | null = null;
    for (let k = 0; k + 8 < world.length; k += 9) {
      const ax = world[k]!, az = world[k + 2]!, bx = world[k + 3]!, bz = world[k + 5]!, cx = world[k + 6]!, cz = world[k + 8]!;
      const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((bx - qx) * (cz - qz) - (cx - qx) * (bz - qz)) / d, v = ((cx - qx) * (az - qz) - (ax - qx) * (cz - qz)) / d, w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * world[k + 1]! + v * world[k + 4]! + w * world[k + 7]!;
      if (low === null || y < low) low = y;
    }
    return low;
  };
}

/** Seat every prefab instance of a scene. `field` adds the voxel world's solid under it. */
export function floatScene(assets: string, doc: SceneDoc, field: WorldField | null, area: Area, tol: number, only?: ReadonlySet<string>, seatOpts: SeatOptions = {}): { rows: FloatRow[]; checked: number; unsized: number; ms: number } {
  const t0 = performance.now();
  // only what can hold up an object in the area: geometry whose world points come within 30 m of it
  const box = area.near ? [area.near[0] - area.near[2] - 30, area.near[1] - area.near[2] - 30, area.near[0] + area.near[2] + 30, area.near[1] + area.near[2] + 30] : area.rect ? [area.rect[0] - 30, area.rect[1] - 30, area.rect[2] + 30, area.rect[3] + 30] : null;
  const geo = sceneGeometry(assets, doc as never).filter((g) => {
    if (!box) return true;
    for (let k = 0; k < g.world.length; k += 3) if (g.world[k]! >= box[0]! && g.world[k]! <= box[2]! && g.world[k + 2]! >= box[1]! && g.world[k + 2]! <= box[3]!) return true;
    return false;
  });
  const owners: number[] = [];
  const soup: number[] = [];
  geo.forEach((g, i) => {
    for (let k = 0; k < g.world.length; k += 9) owners.push(i);
    for (const v of g.world) soup.push(v);
  });
  const tris = triangleSolidProbe(soup, 1, owners);
  const fieldProbe = field ? fieldSolidProbe(field) : null;
  const rows: FloatRow[] = [];
  let checked = 0, unsized = 0;
  const contactCache = new Map<string, SeatContact>();
  geo.forEach((g, i) => {
    if (!g.prefabId || SKIP_PREFAB.test(g.prefabId) || (only && !only.has(g.id))) return;
    const fp = footprintOf(g);
    if (!inArea(area, fp.x, fp.z)) return;
    if (!(fp.height > 0.01) || !(fp.halfX > 0) || !(fp.halfZ > 0)) { unsized++; return; }
    let contact = contactCache.get(g.prefabId);
    if (!contact) contactCache.set(g.prefabId, (contact = defaultSeatContact(dressingOf(assets, g.prefabId), g.prefabId)));
    const own = tris.excluding(i);
    const probe: SolidProbe = fieldProbe ? unionSolidProbe(fieldProbe, own) : own;
    // a structure (anything over 4 m across) is seated by its base like a building: the probe reaches further down
    const big = Math.max(fp.halfX, fp.halfZ) > 2;
    // a seated figure rests where its own underside touches (hips on the seat, feet on a step)
    const r = seatObject(probe, contact === "seated" ? { ...fp, underside: undersideOf(g.world) } : fp, contact, { tol, reachDown: big ? 8 : 4, ...seatOpts });
    checked++;
    if (r.status === "ok") return;
    rows.push({
      kind: "scene", id: g.id, what: g.prefabId, contact, x: r3(fp.x), y: r3(fp.y), z: r3(fp.z), status: r.status, gap: r2(r.gap), support: r.support,
      ...(r.reason ? { reason: r.reason } : {}),
      fix: { y: r.y, ...(r.x !== undefined ? { x: r.x, z: r.z } : {}) },
    });
  });
  return { rows, checked, unsized, ms: performance.now() - t0 };
}

/** Seat every scatter rock (`contact: embed`) the runtime places in the area's cells. */
export function floatScatter(field: WorldField, area: Area, tol: number, legacy: boolean, skipFlat = false): { rows: FloatRow[]; checked: number; ms: number; cells: number; skipped?: number } {
  const t0 = performance.now();
  const recipe = field.recipe, size = recipe.cellSize;
  const rect = area.rect ?? (area.near ? [area.near[0] - area.near[2], area.near[1] - area.near[2], area.near[0] + area.near[2], area.near[1] + area.near[2]] : null);
  if (!rect) throw new Error("scatter needs --near or --rect (a whole world is swept in chunks: float-sweep)");
  const probe = fieldSolidProbe(field);
  const rows: FloatRow[] = [];
  let checked = 0, cells = 0, skipped = 0;
  const rocks = recipe.scatter.map((r) => scatterContact(r) === "embed");
  if (!rocks.some(Boolean)) return { rows, checked, ms: 0, cells };
  for (let cz = Math.floor(rect[1] / size); cz <= Math.floor(rect[3] / size); cz++)
    for (let cx = Math.floor(rect[0] / size); cx <= Math.floor(rect[2] / size); cx++) {
      if (field.worldLimit !== Infinity && Math.hypot((cx + 0.5) * size, (cz + 0.5) * size) > field.worldLimit + size) continue;
      // a sweep may skip cells that cannot hold a hanging rock: level (under 1.5 m of relief), no carve, no planar cliff
      if (skipFlat) {
        const x0 = cx * size, z0 = cz * size, hr = field.heightRange(x0, z0, x0 + size, z0 + size, 6);
        if (hr.max - hr.min < 1.5 && !field.carveSpan(x0, z0, x0 + size, z0 + size) && !field.planarMaskIn(x0, z0, x0 + size, z0 + size)) { skipped++; continue; }
      }
      cells++;
      for (const inst of scatterCell(field, cx, cz, legacy ? { seat: false } : {})) {
        if (!rocks[inst.ruleIndex]) continue;
        const rule = recipe.scatter[inst.ruleIndex]!;
        const x = inst.position[0] + cx * size, z = inst.position[2] + cz * size, y = inst.position[1];
        if (!inArea(area, x, z)) continue;
        const q = inst.rotation;
        const yaw = Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));
        const s = scatterSeatSize(rule, inst.scale);
        const r = seatObject(probe, { x, z, y, yaw, ...s, align: rule.alignToNormal }, "embed", { tol, embed: Math.max(0.05, -rule.yOffset * 0.5), reachDown: Math.max(4, s.height * 2) });
        checked++;
        if (r.status === "ok") continue;
        rows.push({ kind: "scatter", id: inst.id, what: rule.id, contact: "embed", x: r2(x), y: r2(y), z: r2(z), status: r.status, gap: r2(r.gap), support: r.support, ...(r.reason ? { reason: r.reason } : {}) });
      }
    }
  return { rows, checked, ms: performance.now() - t0, cells, skipped };
}

function summarize(target: string, areaText: string, tol: number, scene: ReturnType<typeof floatScene> | null, scatter: ReturnType<typeof floatScatter> | null): FloatReport {
  const rows = [...(scene?.rows ?? []), ...(scatter?.rows ?? [])].sort((a, b) => (b.gap === Infinity ? 1e9 : b.gap) - (a.gap === Infinity ? 1e9 : a.gap));
  const byKind: Record<string, number> = {}, byContact: Record<string, number> = {};
  for (const r of rows) { byKind[r.what] = (byKind[r.what] ?? 0) + 1; byContact[r.contact] = (byContact[r.contact] ?? 0) + 1; }
  const n = (scene?.checked ?? 0) + (scatter?.checked ?? 0);
  return {
    ok: rows.length === 0, passed: rows.length === 0, target, area: areaText, tol,
    checked: { scene: scene?.checked ?? 0, scatter: scatter?.checked ?? 0, unsized: scene?.unsized ?? 0 },
    counts: { off: rows.filter((r) => r.status === "off").length, unsupported: rows.filter((r) => r.status === "unsupported").length, byKind, byContact },
    ms: { scene: Math.round(scene?.ms ?? 0), scatter: Math.round(scatter?.ms ?? 0), perObjectMs: n ? Math.round((((scene?.ms ?? 0) + (scatter?.ms ?? 0)) / n) * 100) / 100 : 0 },
    rows,
  };
}

function print(rep: FloatReport, list: boolean): void {
  console.log(`float ${rep.target} [${rep.area}]: ${rep.checked.scene} scene objects + ${rep.checked.scatter} scatter rocks checked (${rep.checked.unsized} without geometry) in ${((rep.ms.scene + rep.ms.scatter) / 1000).toFixed(1)} s (${rep.ms.perObjectMs} ms/object)`);
  if (rep.ok) { console.log(`  OK: every contact within ${rep.tol} m`); return; }
  console.log(`  FAIL: ${rep.counts.off} off by > ${rep.tol} m, ${rep.counts.unsupported} with no support   by contact ${JSON.stringify(rep.counts.byContact)}`);
  for (const r of list ? rep.rows : rep.rows.slice(0, 25))
    console.log(`    ${r.status.padEnd(11)} ${r.contact.padEnd(5)} ${r.what.padEnd(30)} ${r.id.padEnd(34)} at (${r.x}, ${r.y}, ${r.z}) gap ${r.gap} m${r.reason ? `  — ${r.reason}` : ""}`);
  if (!list && rep.rows.length > 25) console.log(`    ... ${rep.rows.length - 25} more (--list, or --out for the JSON)`);
}

// ------------------------------------------------------------------ fix / undo

/** Ops that re-seat the `off` scene rows (and remove unsupported ones with `drop`). applyOps returns the inverse. */
export function fixOps(doc: SceneDoc, rows: readonly FloatRow[], drop: boolean | "rocks"): any[] {
  const ops: any[] = [];
  for (const r of rows) {
    if (r.kind !== "scene") continue;
    const e = (doc.entities as Record<string, any>)[r.id];
    if (!e) continue;
    const t = e.components.transform;
    if (r.status === "unsupported") {
      // "rocks": only an unsupported embed (a rock or formation on an edge) goes; anything else is moved by its owner
      if (!drop || (drop === "rocks" && r.contact !== "embed")) continue;
      ops.push({ op: "remove-entity", id: r.id });
      continue;
    }
    if (!r.fix || r.fix.y === null) continue;
    // nothing to move (an uneven table already on its highest foot): no op, so a re-run stays a no-op
    if (Math.abs(r.fix.y - r.y) < 0.01 && Math.abs((r.fix.x ?? r.x) - r.x) < 0.01 && Math.abs((r.fix.z ?? r.z) - r.z) < 0.01) continue;
    // world delta -> the entity's local frame (parent rotation and scale undone)
    const dW = [(r.fix.x ?? r.x) - r.x, r.fix.y - r.y, (r.fix.z ?? r.z) - r.z];
    const local = toLocal(doc, e.parent, dW as [number, number, number]);
    const p = t.position ?? [0, 0, 0];
    ops.push({ op: "set-component", id: r.id, component: "transform", data: { ...t, position: [p[0] + local[0], p[1] + local[1], p[2] + local[2]] } });
  }
  return ops;
}

function toLocal(doc: SceneDoc, parent: string | null | undefined, d: [number, number, number]): [number, number, number] {
  const chain: any[] = [];
  for (let p = parent; p; p = (doc.entities as Record<string, any>)[p]?.parent) chain.push((doc.entities as Record<string, any>)[p]?.components?.transform ?? {});
  let v = d;
  for (const t of chain.reverse()) {
    const q = t.rotation ?? [0, 0, 0, 1], s = t.scale ?? [1, 1, 1];
    // rotate by the conjugate (v' = v + 2w(u x v) + 2u x (u x v), u = -q.xyz), then unscale
    const ux = -q[0], uy = -q[1], uz = -q[2], w = q[3];
    const [vx, vy, vz] = v;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const rx = vx + 2 * (w * cx + uy * cz - uz * cy), ry = vy + 2 * (w * cy + uz * cx - ux * cz), rz = vz + 2 * (w * cz + ux * cy - uy * cx);
    v = [rx / s[0], ry / s[1], rz / s[2]];
  }
  return v;
}

// ------------------------------------------------------------------ CLI

function registry(): ComponentRegistry { const reg = new ComponentRegistry(); registerCoreComponents(reg); return reg; }
const opt = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
function parseArea(argv: string[], fail: (m: string) => never): { area: Area; text: string } {
  const near = opt(argv, "near"), rect = opt(argv, "rect");
  if (near) { const v = near.split(",").map(Number); if (v.length !== 3 || !v.every(Number.isFinite)) fail("--near wants x,z,r"); return { area: { near: v as never }, text: `near ${near}` }; }
  if (rect) { const v = rect.split(",").map(Number); if (v.length !== 4 || !v.every(Number.isFinite)) fail("--rect wants x0,z0,x1,z1"); return { area: { rect: v as never }, text: `rect ${rect}` }; }
  return { area: {}, text: "whole scene" };
}
function emit(rep: FloatReport, argv: string[]): void {
  const out = opt(argv, "out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1)); }
  if (argv.includes("--json")) console.log(JSON.stringify({ ...rep, rows: rep.rows.slice(0, 50) }));
  else print(rep, argv.includes("--list"));
  if (!rep.ok) process.exitCode = 1;
}

/** The project directory and assets dir a world recipe file lives in. */
function projectOfRecipe(file: string): { dir: string; assets: string } {
  const assets = path.dirname(path.dirname(path.resolve(file)));
  return { dir: path.dirname(assets), assets };
}

/**
 * The land of a world cut into `size`-metre squares (row-major), open sea skipped: what a whole-world sweep walks,
 * one chunk per job (`float-sweep`), or all of them for `--stamp`.
 */
export function worldChunks(field: WorldField, size = 384): [number, number, number, number][] {
  const r = field.recipe as any;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const c of r.bounds?.continents ?? []) {
    const pad = (c.radius ?? 0) + (c.falloff ?? 0);
    x0 = Math.min(x0, c.center[0] - pad); z0 = Math.min(z0, c.center[1] - pad); x1 = Math.max(x1, c.center[0] + pad); z1 = Math.max(z1, c.center[1] + pad);
    for (const l of c.lobes ?? []) { x0 = Math.min(x0, l[0] - l[2] - (c.falloff ?? 0)); z0 = Math.min(z0, l[1] - l[2] - (c.falloff ?? 0)); x1 = Math.max(x1, l[0] + l[2] + (c.falloff ?? 0)); z1 = Math.max(z1, l[1] + l[2] + (c.falloff ?? 0)); }
  }
  if (!Number.isFinite(x0)) { const L = Number.isFinite(field.worldLimit) ? field.worldLimit : 1024; x0 = z0 = -L; x1 = z1 = L; }
  const out: [number, number, number, number][] = [];
  const sea = (r.seaLevel ?? 0) - 10;
  for (let z = Math.floor(z0 / size) * size; z < z1; z += size)
    for (let x = Math.floor(x0 / size) * size; x < x1; x += size) {
      let land = false;
      for (let i = 0; i <= 4 && !land; i++) for (let k = 0; k <= 4 && !land; k++) if (field.height(x + (size * i) / 4, z + (size * k) / 4) > sea) land = true;
      if (land) out.push([x, z, x + size, z + size]);
    }
  return out;
}

/** `worldgen float <world>`: the world's scene objects and its scatter rocks, on the field's solid. */
export function commandFloat(host: { argv: string[]; loadRecipe(): { recipe: WorldRecipe; file: string }; fail(m: string): never; writeRecipe?(recipe: WorldRecipe, file: string): void }): FloatReport {
  const { argv } = host;
  const { recipe, file } = host.loadRecipe();
  const tol = Number(opt(argv, "tol") ?? 0.05);
  const { area, text } = parseArea(argv, host.fail);
  const field = createWorldField(recipe);
  const { assets } = projectOfRecipe(file);
  const sceneFile = opt(argv, "scene") ?? path.join(assets, "scenes", `${recipe.name}.scene.json`);
  const scene = !argv.includes("--no-scene") && fs.existsSync(sceneFile) ? floatScene(assets, readJson(sceneFile), field, area, tol) : null;
  const legacy = argv.includes("--legacy-scatter");
  const stamp = argv.includes("--stamp");
  if (stamp && (area.near || area.rect)) host.fail("--stamp sweeps the whole world; drop --near/--rect");
  let scatter: ReturnType<typeof floatScatter> | null = null;
  if (!argv.includes("--no-scatter")) {
    if (area.near || area.rect) scatter = floatScatter(field, area, tol, legacy);
    else if (stamp) {
      // every land chunk; one report
      scatter = { rows: [], checked: 0, ms: 0, cells: 0 };
      for (const rect of worldChunks(field)) {
        const s = floatScatter(field, { rect }, tol, legacy);
        scatter.rows.push(...s.rows); scatter.checked += s.checked; scatter.ms += s.ms; scatter.cells += s.cells;
      }
    }
  }
  const rep = summarize(recipe.name, text + (scatter ? "" : " (scene only; scatter rocks need --near/--rect, or --stamp for the whole world)"), tol, scene, scatter);
  emit(rep, argv);
  // the `float` stage of `worldgen status`: stamped only by a clean whole-world sweep
  if (stamp && rep.ok && host.writeRecipe) { host.writeRecipe(recipe, file); console.log("  stamped stage float"); }
  return rep;
}

function sceneTarget(argv: string[], fail: (m: string) => never): { project: string; assets: string; file: string; doc: SceneDoc; field: WorldField | null } {
  const project = argv[1];
  if (!project) fail("usage: float scene <project> [--scene <id|file>] [--world <recipe id>]");
  const dir = path.join(PROJECTS, project!);
  const assets = path.join(dir, "assets");
  const s = opt(argv, "scene");
  let file = s && fs.existsSync(s) ? s : path.join(assets, "scenes", `${s ?? project}.scene.json`);
  if (!fs.existsSync(file)) {
    const any = fs.existsSync(path.join(assets, "scenes")) ? fs.readdirSync(path.join(assets, "scenes")).filter((f) => f.endsWith(".scene.json")) : [];
    if (any.length !== 1) fail(`no scene ${file}; pass --scene (have: ${any.join(", ") || "none"})`);
    file = path.join(assets, "scenes", any[0]!);
  }
  const doc = readJson(file) as SceneDoc;
  return { project: project!, assets, file, doc, field: fieldOfScene(project!, doc, opt(argv, "world")) };
}

/** The voxel world under a scene (named, or the scene's own voxelWorld component), through the project's closure. */
export function fieldOfScene(project: string, doc: SceneDoc, worldId?: string): WorldField | null {
  if (!worldId) for (const e of Object.values(doc.entities as Record<string, any>)) if (e.components?.voxelWorld?.world) worldId = e.components.voxelWorld.world;
  if (!worldId) return null;
  const rf = findAsset(project, `worlds/${worldId}.json`);
  return rf ? createWorldField(worldRecipeSchema.parse(readJson(rf))) : null;
}

/**
 * Seat freshly placed entities (a placer's last step): measure `ids` in `doc` on the real solid and return the
 * re-seating ops (base/legs/embed y, a wall piece's plan move) plus the rows that have no support at all.
 */
export function seatPlaced(project: string, doc: SceneDoc, ids: ReadonlySet<string>, tol = 0.05, seatOpts: SeatOptions = {}): { ops: any[]; rows: FloatRow[]; unsupported: FloatRow[] } {
  const assets = path.join(PROJECTS, project, "assets");
  const { rows } = floatScene(assets, doc, fieldOfScene(project, doc), {}, tol, ids, seatOpts);
  return { ops: fixOps(doc, rows, false), rows, unsupported: rows.filter((r) => r.status === "unsupported") };
}

export function main(argv: string[]): void {
  const fail = (m: string): never => { console.error(m); process.exit(2); };
  const cmd = argv[0];
  if (cmd === "scene") {
    const t = sceneTarget(argv, fail);
    const tol = Number(opt(argv, "tol") ?? 0.05);
    const { area, text } = parseArea(argv, fail);
    const scene = floatScene(t.assets, t.doc, t.field, area, tol);
    const rep = summarize(`${t.project}/${path.basename(t.file)}`, text, tol, scene, null);
    if (argv.includes("--fix")) {
      // a few passes: a book seated on a table that itself moved is re-seated on the table's new top
      const drop = argv.includes("--drop-unsupported") ? true : argv.includes("--drop-unsupported-rocks") ? "rocks" : false;
      let next = t.doc, rows = rep.rows, inverse: any[] = [], total = 0;
      for (let pass = 0; pass < 4; pass++) {
        const ops = fixOps(next, rows, drop);
        if (!ops.length) break;
        const res = applyOps(next, ops as never, registry());
        next = res.doc; inverse = [...res.inverse, ...inverse]; total += ops.length;
        rows = floatScene(t.assets, next, t.field, area, tol).rows;
      }
      if (!total) { console.log("float --fix: nothing to re-seat (idempotent: already applied)"); return; }
      fs.writeFileSync(t.file, JSON.stringify(next, null, 2));
      console.log(`float --fix: ${rows.length} still off or unsupported after re-seating (listed by the next plain run)`);
      const inv = opt(argv, "inverse") ?? path.join(path.dirname(t.file), `../../authoring/sweeps/float-fix.inverse.json`);
      fs.mkdirSync(path.dirname(inv), { recursive: true });
      fs.writeFileSync(inv, JSON.stringify(inverse, null, 1));
      console.log(`float --fix: ${total} ops applied to ${t.file}; inverse ${inv}`);
      return;
    }
    emit(rep, argv);
    return;
  }
  if (cmd === "chunks") {
    // float chunks <project> <world> --dir <out> [--from i] [--budget-s 200] [--legacy-scatter] [--skip-flat]
    // one heavy-lock job: scatter rocks chunk by chunk (worldChunks) until the time budget, one JSON per chunk
    const [, project, world] = argv;
    const rf = findAsset(project!, `worlds/${world}.json`);
    if (!rf) fail(`no world ${world} in ${project}'s closure`);
    const field = createWorldField(worldRecipeSchema.parse(readJson(rf!)));
    const dir = opt(argv, "dir") ?? fail("--dir <out dir>");
    fs.mkdirSync(dir!, { recursive: true });
    const chunks = worldChunks(field);
    const budget = Number(opt(argv, "budget-s") ?? 200) * 1000, t0 = Date.now();
    let i = Number(opt(argv, "from") ?? 0);
    for (; i < chunks.length && Date.now() - t0 < budget; i++) {
      const s = floatScatter(field, { rect: chunks[i]! }, Number(opt(argv, "tol") ?? 0.05), argv.includes("--legacy-scatter"), argv.includes("--skip-flat"));
      fs.writeFileSync(path.join(dir!, `chunk-${String(i).padStart(4, "0")}.json`), JSON.stringify({ rect: chunks[i], ...s }));
    }
    console.log(JSON.stringify({ next: i, total: chunks.length }));
    return;
  }
  if (cmd === "undo") {
    const t = sceneTarget(argv, fail);
    const inv = opt(argv, "inverse");
    if (!inv || !fs.existsSync(inv)) fail("undo needs --inverse <file>");
    const { doc: next } = applyOps(t.doc, readJson(inv!) as never, registry());
    fs.writeFileSync(t.file, JSON.stringify(next, null, 2));
    console.log(`float undo: applied ${inv}`);
    return;
  }
  fail("usage: float scene <project> [...] | float undo <project> --inverse f   (worlds: worldgen float <world>)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
