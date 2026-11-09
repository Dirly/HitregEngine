/**
 * town-seated — the SEATED gate on every placed piece of a town (Derek 2026-10-31: "Why is shit floating if we have code
 * assist for placement?"; Bell Strand had no seated gate at all).
 *
 *   npx tsx tools/town-seated.mts --project <p> --town <name> [--scene <id>] [--out <file>]
 *
 * STRUCTURES (lots, the curtain, anything not dressing) get place-build's rule (tools/_place-quality.mts seatGap): measured
 * along their whole BASE OUTLINE against the WALKED ground (tools/_ground.mts walkGround: the carved voxel solid). Each
 * outline point is read at the LOWEST surface of the piece's mesh in that column: a footing storey or plinth that runs
 * down into the ground is the base there (Bell Strand's chapel read 1.26 m "clear" at its floor band while its plinth
 * stood 0.6 m in the ground all round), and a slab with an open side is daylight (the strand-town houses' footing storey
 * has no wall on one side: 0.40-0.47 m under the floor slab). Foundation skirts (`<id>--foundation*`, placement-solver
 * boxes) are ground where they stand, and each skirt's own bottom is measured.
 * DRESSING (tag `dressing` / `*-dressing`, or a catalogue footprint under 6 m2: stalls, boats, an anvil, a tree ring) is
 * judged by the FLOAT rule (float.mts seatPlaced: its catalogue contact, on the real solid including the building it
 * stands in), run here: a float fault is a seated fault. NO SILENT SKIPS: every piece is a row; a piece neither rule can
 * measure is a FAULT. Writes authoring/towns/survey/<town>-seated.json ({ ok, tolerance, counts, rows, failures }) and
 * exits 1 on a fault; `zonegen status` shows it as the town's `seated` row.
 *
 * Fixed by construction, never by a hand nudge: `town-settle --skirts` lays a foundation skirt in the piece's own
 * foundation material under every stretch of base that shows daylight (townSkirts below); dressing re-seats through
 * `float.mts scene --fix`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorldField, foundationEntity, worldRecipeSchema, worldTransforms, type FoundationSpec, type SceneDoc } from "@hitreg/core";
import { findAsset, PROJECTS } from "./_closure.mjs";
import { walkGround } from "./_ground.mts";
import { baseOutline, isLeaned, orientBase, scaleBase, seatedCounts, seatedExclusion, seatGap, SEAT_GAP_M, toWorldYaw, type BaseOutline } from "./_place-quality.mts";
import { prefabGeometry } from "./_prop-geometry.mts";
import { placeRuleFor, prefabInfo } from "./_place-solve.mts";
import { columnBottom } from "./_wall-seated.mts";
import { seatPlaced } from "./float.mts";

type V2 = [number, number];
type Ground = (x: number, z: number) => number;
export interface TownSeatRow { id: string; prefab: string; gap?: number | null; at?: V2; skirt?: string | null; ok?: boolean; excluded?: string; fault?: string; rule?: "outline" | "float" | "skirt" }
/** A placed footprint smaller than this (m2, catalogue size) is dressing (the placement solver's obstacle threshold). */
export const DRESSING_AREA_M2 = 6;
/** Skirts sit this far up into the base they carry (no face in the base's plane: the zfight gate's 2 cm). */
const SKIRT_INTO_M = 0.04;
/** How far a skirt box reaches past the base cells' centres (cells are 0.4 m: 0.2 is the outline itself). k-town3: at 0.2
 *  its sides lay ON the kit's footing faces (the lab zfight gate: 24 skirt/footing clusters, 11 m2 under the inn), and
 *  any value proud of the outline meets some plinth band or step lip; 3 cm INSIDE the outline sits in the footing's own
 *  solid, so the skirt shows only where the base is open (daylight), 3 cm back. */
export const SKIRT_PROUD_M = 0.17;

/** Is a placed town piece dressing (judged by float) rather than a structure (judged on its base outline)? Pure. */
export function isDressing(tags: readonly string[], size: [number, number, number] | null, scale = 1): boolean {
  if (tags.some((t) => t === "dressing" || t.endsWith("-dressing"))) return true;
  // a lot's building and every curtain piece (a 1.7 m kink included) is built fabric: its base outline is the rule
  if (tags.some((t) => t === "wall" || t.startsWith("lot:") || t.startsWith("town-wall:"))) return false;
  return !!size && size[0] * size[2] * scale * scale < DRESSING_AREA_M2;
}

/** A base outline read at its TRUE bottom: each cell at the lowest surface of the mesh in its column (a footing that runs
 *  down into the ground is the base there), never higher than the band-cut outline. Pure. */
export function trueBase(b: BaseOutline, bottom: (x: number, z: number) => number | null): BaseOutline {
  const low = ([x, z, y]: [number, number, number]): [number, number, number] => { const t = bottom(x, z); return [x, z, t === null ? y : Math.min(y, t)]; };
  return { ...b, cells: b.cells.map(low), perimeter: b.perimeter.map(low) };
}

/** A skirt entity's world hull, top and bottom. Pure. */
export function skirtOf(e: any, w: { position: number[]; rotation: number[] } | undefined): { hull: V2[]; top: number; bottom: number } | null {
  const pos = e?.components?.mesh?.source?.positions as number[] | undefined;
  if (!pos?.length || !w) return null;
  const q = w.rotation, yaw = 2 * Math.atan2(q[1]!, q[3]!), c = Math.cos(yaw), s = Math.sin(yaw);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) { x0 = Math.min(x0, pos[i]!); x1 = Math.max(x1, pos[i]!); y0 = Math.min(y0, pos[i + 1]!); y1 = Math.max(y1, pos[i + 1]!); z0 = Math.min(z0, pos[i + 2]!); z1 = Math.max(z1, pos[i + 2]!); }
  const at = (x: number, z: number): V2 => [w.position[0]! + x * c + z * s, w.position[2]! - x * s + z * c];
  return { hull: [at(x0, z0), at(x1, z0), at(x1, z1), at(x0, z1), at(x0, z0)], top: w.position[1]! + y1, bottom: w.position[1]! + y0 };
}
const inHull = (h: V2[], q: V2, reach = 0): boolean => {
  let c = false; for (let i = 0, j = h.length - 1; i < h.length; j = i++) { const a = h[i]!, b = h[j]!; if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; }
  if (c || reach <= 0) return c;
  for (let i = 0; i + 1 < h.length; i++) { const a = h[i]!, b = h[i + 1]!, dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / L)); if (Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dz) <= reach) return true; }
  return false;
};
/** The ground a piece stands on: the walked ground, raised to a skirt's top inside (or within `reach` of) any of its skirts. */
const groundWithSkirts = (ground: Ground, skirts: { hull: V2[]; top: number }[], reach = 0.3): Ground =>
  !skirts.length ? ground : (x, z) => { let g = ground(x, z); for (const s of skirts) if (inHull(s.hull, [x, z], reach)) g = Math.max(g, s.top); return g; };

/** A structure's axis-aligned wall face, prefab frame: the plane x = at (axis 0) or z = at (axis 2), spanning s0..s1 on
 *  the other plan axis and y0..y1. */
export interface WallFace { axis: 0 | 2; at: number; s0: number; s1: number; y0: number; y1: number }
/** Skirt side offsets tried in turn (m past the base cells' centres): the first whose four sides keep ZFIGHT_CLEAR_M off
 *  every parallel wall face of the structure wins (k-town6: at 0.17 a barracks plinth band and a house-s step lay
 *  5-16 mm from a skirt side, 0.24 m2 each in the zfight gate). */
export const SKIRT_PROUD_TRY = [SKIRT_PROUD_M, 0.13, 0.21, 0.09, 0.25];
const ZFIGHT_CLEAR_M = 0.025;
/** Does a skirt box (prefab frame, centre c, half h, local band y0..y1) put a side within ZFIGHT_CLEAR_M of a parallel wall face? Pure. */
export function skirtClashes(c: V2, h: V2, y0: number, y1: number, walls: readonly WallFace[], k = 1): boolean {
  const tol = ZFIGHT_CLEAR_M / k;
  for (const w of walls) {
    if (w.y1 <= y0 + 1e-3 || w.y0 >= y1 - 1e-3) continue;
    const [ax, bx, lo, hi] = w.axis === 0 ? [c[0] - h[0], c[0] + h[0], c[1] - h[1], c[1] + h[1]] : [c[1] - h[1], c[1] + h[1], c[0] - h[0], c[0] + h[0]];
    if (Math.min(hi, w.s1) - Math.max(lo, w.s0) < 0.05) continue;
    if (Math.abs(w.at - ax) < tol || Math.abs(w.at - bx) < tol) return true;
  }
  return false;
}

export interface TownLook { walls?: (p: string) => WallFace[]; base: (p: string) => BaseOutline | null; bottom: (p: string) => ((x: number, z: number) => number | null) | null; hung: (p: string) => string | null; size: (p: string) => [number, number, number] | null }

/** The pieces of a town (entity ids tagged `town:<town>` placing a prefab), split structure / dressing. */
export function townPieces(doc: SceneDoc, town: string, look: Pick<TownLook, "size">): { structures: string[]; dressing: string[]; skirts: string[] } {
  const out = { structures: [] as string[], dressing: [] as string[], skirts: [] as string[] }, wt = worldTransforms(doc);
  for (const [id, e] of Object.entries(doc.entities as Record<string, any>)) {
    const tags: string[] = e?.tags ?? [];
    if (!tags.includes(`town:${town}`)) continue;
    if (/--foundation(-\d+)?$/.test(id)) { out.skirts.push(id); continue; }
    const p = e?.components?.prefab?.prefabId as string | undefined; if (!p) continue;
    (isDressing(tags, look.size(p), wt.get(id)?.scale[0] ?? 1) ? out.dressing : out.structures).push(id);
  }
  return out;
}

/** The skirts laid under a piece (`<id>--foundation`, `<id>--foundation-2`, ...). */
const skirtIds = (doc: SceneDoc, id: string): string[] => Object.keys(doc.entities).filter((k) => k === `${id}--foundation` || k.startsWith(`${id}--foundation-`));

/** The outline rule's rows for a town's structures and skirts. Pure over its lookups. */
export function structureRows(doc: SceneDoc, ids: readonly string[], skirts: readonly string[], look: TownLook, ground: Ground, tol = SEAT_GAP_M): TownSeatRow[] {
  const E = doc.entities as Record<string, any>, wt = worldTransforms(doc), rows: TownSeatRow[] = [];
  for (const id of ids) {
    const e = E[id], tags: string[] = e.tags ?? [], prefab = e.components.prefab.prefabId as string;
    const ex = seatedExclusion(tags, look.hung(prefab)); if (ex) { rows.push({ id, prefab, excluded: ex }); continue; }
    const b0 = look.base(prefab), bot = look.bottom(prefab);
    if (!b0 || !bot) { rows.push({ id, prefab, gap: null, rule: "outline", fault: "no base outline (no triangles or the prefab is missing): not measured, so not passed" }); continue; }
    const w = wt.get(id)!, q = w.rotation as never, k = w.scale[0] ?? 1, leaned = isLeaned(q), tb = scaleBase(trueBase(b0, bot), k);
    const base = leaned ? orientBase(tb, q) : tb, yaw = leaned ? 0 : 2 * Math.atan2(w.rotation[1]!, w.rotation[3]!);
    const own = skirtIds(doc, id).map((s) => skirtOf(E[s], wt.get(s))).filter((s): s is NonNullable<typeof s> => !!s);
    const m = seatGap(base, [w.position[0]!, w.position[2]!], w.position[1]!, yaw, groundWithSkirts(ground, own));
    rows.push({ id, prefab, gap: m.gap, at: m.at, skirt: own.length ? `${own.length} skirt(s)` : null, rule: "outline", ok: m.gap <= tol });
  }
  for (const id of skirts) {
    const sk = skirtOf(E[id], wt.get(id));
    if (!sk) { rows.push({ id, prefab: "foundation", rule: "skirt", fault: "foundation without mesh positions: not measured, so not passed" }); continue; }
    let gap = -Infinity, at: V2 = sk.hull[0]!;
    for (let i = 0; i < 4; i++) { const a = sk.hull[i]!, b = sk.hull[i + 1]!; for (let n = 0; n <= 8; n++) { const x = a[0] + ((b[0] - a[0]) * n) / 8, z = a[1] + ((b[1] - a[1]) * n) / 8, g = sk.bottom - ground(x, z); if (g > gap) { gap = g; at = [x, z]; } } }
    rows.push({ id, prefab: "foundation", gap: Math.round(gap * 1000) / 1000, at: [Math.round(at[0] * 10) / 10, Math.round(at[1] * 10) / 10], rule: "skirt", ok: gap <= tol });
  }
  return rows;
}

/** Cover a set of grid cells (centres on a `cell` lattice) with few rectangles: greedy row runs merged downward. Pure. */
export function coverCells(cells: V2[], cell = 0.5): { x0: number; x1: number; z0: number; z1: number }[] {
  const key = (i: number, j: number) => `${i},${j}`, set = new Set<string>(), used = new Set<string>();
  const ij = cells.map(([x, z]) => [Math.round(x / cell), Math.round(z / cell)] as const);
  for (const [i, j] of ij) set.add(key(i, j));
  const out: { x0: number; x1: number; z0: number; z1: number }[] = [];
  for (const [i0, j0] of [...ij].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    if (used.has(key(i0, j0))) continue;
    let i1 = i0; while (set.has(key(i1 + 1, j0)) && !used.has(key(i1 + 1, j0))) i1++;
    let j1 = j0; const rowFree = (j: number) => { for (let i = i0; i <= i1; i++) if (!set.has(key(i, j)) || used.has(key(i, j))) return false; return true; };
    while (rowFree(j1 + 1)) j1++;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) used.add(key(i, j));
    out.push({ x0: i0 * cell, x1: i1 * cell, z0: j0 * cell, z1: j1 * cell });
  }
  return out;
}

/**
 * THE CONSTRUCTOR: a foundation skirt under every stretch of a structure's base that shows daylight. The base's cells
 * (true bottom) standing more than `tol` over the walked ground are grouped by their bottom level (0.15 m bands) and
 * covered with rectangles; each is a placement-solver foundation box (core foundationEntity: static surface + trimesh
 * collider, planar UVs) in the piece's declared foundation material, from SKIRT_INTO_M up into the base down to the
 * lowest ground under it - `depth`, no cap (the base covers it). Replaces the piece's earlier skirts. Pure over lookups.
 */
export function townSkirts(doc: SceneDoc, ids: readonly string[], look: TownLook, ground: Ground, foundation: (p: string) => { material: string; tile: number; depth: number }, tol = SEAT_GAP_M): { ops: any[]; rows: { id: string; skirts: number; worst: number }[] } {
  const E = doc.entities as Record<string, any>, wt = worldTransforms(doc), ops: any[] = [], rows: { id: string; skirts: number; worst: number }[] = [];
  for (const id of ids) {
    const e = E[id], prefab = e.components.prefab.prefabId as string, b0 = look.base(prefab), bot = look.bottom(prefab);
    for (const s of skirtIds(doc, id)) ops.push({ op: "remove-entity", id: s });
    if (!b0 || !bot || seatedExclusion(e.tags ?? [], look.hung(prefab))) continue;
    const w = wt.get(id)!; if (isLeaned(w.rotation as never)) continue; // a leaned piece is judged on its turned outline: no box under it
    const k = w.scale[0] ?? 1, yaw = 2 * Math.atan2(w.rotation[1]!, w.rotation[3]!), at: V2 = [w.position[0]!, w.position[2]!], tb = trueBase(b0, bot);
    const open = tb.cells.filter(([x, z, y]) => { const p = toWorldYaw(at, yaw, x * k, z * k); return w.position[1]! + y * k - ground(p[0], p[1]) > tol * 0.5; });
    if (!open.length) continue;
    const bands = new Map<number, typeof open>();
    for (const c of open) { const b = Math.floor((c[2] * k) / 0.15); bands.set(b, [...(bands.get(b) ?? []), c]); }
    const parent = e.parent ? wt.get(e.parent) : undefined, og = parent?.position ?? [0, 0, 0];
    if (parent && Math.abs(parent.rotation[1]!) > 1e-6) throw new Error(`town-seated skirts: ${id}'s parent is turned (skirts are written in a translated frame only)`);
    const f = foundation(prefab); let n = 0, worst = 0;
    for (const band of bands.values()) {
      const hi = Math.max(...band.map((c) => c[2])) * k; // the band's highest bottom: the skirt reaches up into every cell's base
      const walls = look.walls?.(prefab) ?? [];
      for (const r of coverCells(band.map((c) => [c[0], c[1]] as V2))) {
        const yTop = hi / k + SKIRT_INTO_M / k, yBot = yTop - 1.5; // the skirt's band in the prefab frame (its visible part)
        const proud = SKIRT_PROUD_TRY.find((p) => !skirtClashes([(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2], [(r.x1 - r.x0) / 2 + p, (r.z1 - r.z0) / 2 + p], yBot, yTop, walls, k)) ?? SKIRT_PROUD_M;
        const half: V2 = [((r.x1 - r.x0) / 2 + proud) * k, ((r.z1 - r.z0) / 2 + proud) * k], cl: V2 = [((r.x0 + r.x1) / 2) * k, ((r.z0 + r.z1) / 2) * k];
        const c = toWorldYaw(at, yaw, cl[0], cl[1]);
        let lo = Infinity;
        for (let i = 0; i <= Math.ceil(half[0] * 4); i++) for (let j = 0; j <= Math.ceil(half[1] * 4); j++) { const p = toWorldYaw(c, yaw, -half[0] + (2 * half[0] * i) / Math.ceil(half[0] * 4), -half[1] + (2 * half[1] * j) / Math.ceil(half[1] * 4)); lo = Math.min(lo, ground(p[0], p[1])); }
        const top = w.position[1]! + hi + SKIRT_INTO_M, bottom = lo - f.depth;
        worst = Math.max(worst, top - lo);
        const spec: FoundationSpec = { of: id, box: { c, half, yaw }, top: Math.round(top * 1000) / 1000, bottom: Math.round(bottom * 1000) / 1000, material: f.material, tile: f.tile, cap: false };
        const sid = n === 0 ? `${id}--foundation` : `${id}--foundation-${n + 1}`; n++;
        ops.push({ op: "add-entity", id: sid, entity: foundationEntity(spec, { parent: e.parent ?? null, origin: [og[0]!, og[1]!, og[2]!], tags: (e.tags ?? []).filter((t: string) => t.startsWith("town")) }) });
      }
    }
    rows.push({ id, skirts: n, worst: Math.round(worst * 100) / 100 });
  }
  return { ops, rows };
}

/** What the gate and the constructor read for a project (cached per prefab). */
export function townLook(project: string): TownLook & { foundation: (p: string) => { material: string; tile: number; depth: number } } {
  const assets = path.join(PROJECTS, project, "assets"), tris = new Map<string, any[] | null>(), bases = new Map<string, BaseOutline | null>(), bots = new Map<string, ((x: number, z: number) => number | null) | null>();
  const triOf = (p: string) => { if (!tris.has(p)) { let t: any[] | null = null; try { t = prefabGeometry(assets, p).tris; } catch { t = null; } tris.set(p, t?.length ? t : null); } return tris.get(p)!; };
  const wallsOf = new Map<string, WallFace[]>();
  return {
    walls: (p) => { if (!wallsOf.has(p)) { const out: WallFace[] = []; for (const t of triOf(p) ?? []) for (const ax of [0, 2] as const) {
      const v = [t.a[ax], t.b[ax], t.c[ax]]; if (Math.max(...v) - Math.min(...v) > 1e-3) continue; const o = ax === 0 ? 2 : 0, s = [t.a[o], t.b[o], t.c[o]], y = [t.a[1], t.b[1], t.c[1]];
      if (Math.max(...s) - Math.min(...s) < 1e-3) continue; out.push({ axis: ax, at: v[0], s0: Math.min(...s), s1: Math.max(...s), y0: Math.min(...y), y1: Math.max(...y) }); } wallsOf.set(p, out); } return wallsOf.get(p)!; },
    base: (p) => { if (!bases.has(p)) { const t = triOf(p); bases.set(p, t ? baseOutline(t) : null); } return bases.get(p)!; },
    bottom: (p) => { if (!bots.has(p)) { const t = triOf(p); if (!t) bots.set(p, null); else { const pos: number[] = [], idx: number[] = []; for (const x of t) for (const v of [x.a, x.b, x.c]) { idx.push(pos.length / 3); pos.push(v[0], v[1], v[2]); } bots.set(p, columnBottom(pos, idx)); } } return bots.get(p)!; },
    hung: (p) => { const f = findAsset(project, `prefabs/${p}.json`); if (!f) return null; try { const m = Object.values(JSON.parse(fs.readFileSync(f, "utf8")).entities ?? {}).map((e: any) => e?.components?.dressing?.mount).find(Boolean); return m === "wall" || m === "ceiling" ? (m as string) : null; } catch { return null; } },
    size: (p) => prefabInfo(project, p)?.size ?? null,
    foundation: (p) => { const f = (placeRuleFor(project, p) as any)?.foundation; return { material: f?.material ?? "foundations/badland-rubble", tile: f?.tile ?? 3.2, depth: f?.depth ?? 0.3 }; },
  };
}

/** The town's scene doc, its id and the walked ground of its world. */
export function townContext(project: string, town: string, scene?: string): { doc: SceneDoc; sceneId: string; sceneFile: string; ground: Ground } {
  const dir = path.join(PROJECTS, project), tdoc = JSON.parse(fs.readFileSync(path.join(dir, "authoring/towns", `${town}.json`), "utf8"));
  const sceneId = scene ?? tdoc.scene ?? project, sceneFile = path.join(dir, "assets/scenes", `${sceneId}.scene.json`);
  const doc = JSON.parse(fs.readFileSync(sceneFile, "utf8")) as SceneDoc;
  const worldId = tdoc.world ?? Object.values(doc.entities as Record<string, any>).map((e) => e?.components?.voxelWorld?.world).find(Boolean);
  if (!worldId) throw new Error(`town-seated: no world (the town doc names none and scene ${sceneId} has no voxelWorld)`);
  const wf = findAsset(project, `worlds/${worldId}.json`) ?? path.join(dir, "assets/worlds", `${worldId}.json`);
  return { doc, sceneId, sceneFile, ground: walkGround(createWorldField(worldRecipeSchema.parse(JSON.parse(fs.readFileSync(wf, "utf8"))))) };
}

/** The gate on a project's town. */
export function townSeated(project: string, town: string, o: { scene?: string; doc?: SceneDoc } = {}) {
  const ctx = townContext(project, town, o.scene), doc = o.doc ?? ctx.doc, look = townLook(project);
  const parts = townPieces(doc, town, look);
  const rows = structureRows(doc, parts.structures, parts.skirts, look, ctx.ground);
  // dressing: the float rule on the real solid (the building it stands in included), every id a row
  if (parts.dressing.length) {
    const f = seatPlaced(project, doc, new Set(parts.dressing)), bad = new Map(f.rows.map((r) => [r.id, r]));
    for (const id of parts.dressing) {
      const r = bad.get(id), prefab = (doc.entities as Record<string, any>)[id].components.prefab.prefabId;
      rows.push(r ? { id, prefab, rule: "float", gap: Number.isFinite(r.gap) ? r.gap : null, at: [r.x, r.z], ok: false, fault: `float: ${r.status}${r.reason ? ` (${r.reason})` : ""}, gap ${r.gap} m (float.mts scene --fix re-seats it)` } : { id, prefab, rule: "float", ok: true });
    }
  }
  const bad = rows.filter((r) => r.fault || r.ok === false), counts = seatedCounts(rows);
  return { ok: !bad.length && counts.judged > 0, town, scene: ctx.sceneId, tolerance: SEAT_GAP_M, counts: { ...counts, structures: parts.structures.length, dressing: parts.dressing.length, skirts: parts.skirts.length }, worst: Math.max(0, ...rows.map((r) => r.gap ?? 0)), rows, bad };
}

function main(): void {
  const argv = process.argv.slice(2);
  const opt = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const project = opt("project"), town = opt("town");
  if (!project || !town) { console.error("usage: town-seated --project <p> --town <name> [--scene <id>] [--out <file>]"); process.exit(2); }
  const r = townSeated(project, town, { scene: opt("scene") });
  const out = path.resolve(opt("out") ?? path.join(PROJECTS, project, "authoring/towns/survey", `${town}-seated.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { bad, ...rep } = r;
  fs.writeFileSync(out, `${JSON.stringify({ ...rep, at: new Date().toISOString(), failures: bad.map((b) => (b.fault ? `${b.id}: ${b.fault}` : `${b.id} (${b.prefab}) stands ${b.gap} m clear at ${b.at}`)) }, null, 1)}\n`);
  for (const b of bad.sort((a, c) => (c.gap ?? 99) - (a.gap ?? 99))) console.log(`  FAIL ${b.fault ? `${b.id}: ${b.fault}` : `${b.id} (${b.prefab}) ${b.gap} m clear at ${b.at}${b.skirt ? ` (${b.skirt})` : ""}`}`);
  const c = r.counts;
  console.log(`seated ${town} [${r.scene}]: ${c.pieces} row(s): ${c.structures} structure(s) on their base outline, ${c.dressing} dressing by the float rule, ${c.skirts} skirt(s); ${c.excluded} excluded, ${c.faults} fault(s), worst ${r.worst.toFixed(2)} m (<= ${SEAT_GAP_M}) -> ${path.relative(process.cwd(), out)}`);
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
