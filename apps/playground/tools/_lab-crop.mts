/**
 * _lab-crop — crop-and-work scratch labs (Derek 2026-10-30: "just take a few chunks and send it to do the work there...
 * otherwise you're gonna bloat"). A lab used to copy the WHOLE world recipe, every terrain material and the whole scene,
 * then boot and stream the entire world. A cropped lab keeps only what the job needs:
 *
 *   - `labBox`        the box: every point the job touches (pieces, patches, routes) + its shot cameras (and a stretch past
 *                     each camera's target, so a far shot still has ground behind the place) + a margin;
 *   - `cropRecipe`    the recipe with only the features that reach the box (the global generator fields are untouched), then
 *                     PROVED: heights, density, surface splat, water level, biome and zone on a grid over the box and the generated cell
 *                     docs (terrain + scatter) of every cell in it, live vs cropped. Any difference puts the dropped
 *                     features back, kind by kind, until the ground inside the box is bit-identical (never a guess);
 *   - `cropScene`     the scene's entities inside the box + the globals (world, sky, light, water, ...); the player/spawn/
 *                     camera moved into the box; the voxelWorld gets `bounds` = the box, so the streamer, the server and
 *                     physics never load a cell outside it (packages/core components/voxel.ts `bounds`).
 *
 *   - `labSpawn` /    where a lab STARTS (Derek 2026-10-31): on walkable ground where the place's approach arrives
 *     `approachArrival` (`approachArrival`), facing its centre; `cropScene` with a `target` puts the player, spawn and
 *                     camera there; `labShell` gives the lab the game shell (tools/_game-shell.mjs) so it walks like the world.
 *
 * Shared by place-build `lab` / `lab-spawn` and zonegen `concept` (the lab-makers). Outside the box the far view shows sky.
 */
import { createWorldField, voxelChunkDoc, worldRecipeSchema, type WorldField } from "@hitreg/core";
import { yawQuat } from "./_world-spawn.mts";
import { withGameShell } from "./worldgen-scene-env.mts";

export type V2 = [number, number];
export interface LabBox { min: V2; max: V2 }

/** Cells of slack round everything the job touches (48 m cells: two of them). */
export const LAB_MARGIN_M = 96;
/** How far past a fixed camera's target the box reaches, so a far shot keeps ground behind the place. */
export const LAB_PAST_TARGET_M = 160;

/** The box round a set of world [x, z] points, with a margin, snapped out to whole metres. */
export function labBox(points: readonly V2[], margin = LAB_MARGIN_M): LabBox {
  const ok = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!ok.length) throw new Error("labBox: no points to box");
  const xs = ok.map((p) => p[0]), zs = ok.map((p) => p[1]);
  return { min: [Math.floor(Math.min(...xs) - margin), Math.floor(Math.min(...zs) - margin)], max: [Math.ceil(Math.max(...xs) + margin), Math.ceil(Math.max(...zs) + margin)] };
}

/** A shot's points: its stand (x/z or camera) and, for a fixed camera, LAB_PAST_TARGET_M past its target along the look. */
export function viewPoints(v: any): V2[] {
  const out: V2[] = [];
  if (Array.isArray(v?.camera)) out.push([v.camera[0], v.camera[2]]);
  else if (Number.isFinite(v?.x) && Number.isFinite(v?.z)) out.push([v.x, v.z]);
  if (Array.isArray(v?.camera) && Array.isArray(v?.target)) {
    const dx = v.target[0] - v.camera[0], dz = v.target[2] - v.camera[2], d = Math.hypot(dx, dz) || 1;
    out.push([v.target[0], v.target[2]], [v.target[0] + (dx / d) * LAB_PAST_TARGET_M, v.target[2] + (dz / d) * LAB_PAST_TARGET_M]);
  }
  return out;
}

const PT_KEYS = ["points", "polygon", "center", "position", "origin", "at", "start", "end", "near", "path", "from", "to"];
const PAD_KEYS = ["radius", "falloff", "width", "feather", "reach", "apron", "within", "shoulder", "bank", "blend", "neck"];
function pushPoints(v: unknown, out: V2[]): void {
  if (!Array.isArray(v)) return;
  if (v.length >= 2 && v.length <= 3 && v.every((n) => typeof n === "number")) { out.push((v.length === 3 ? [v[0], v[2]] : [v[0], v[1]]) as V2); return; }
  for (const q of v) pushPoints(q, out);
}
/** A feature's [x, z] extent, padded by its own reach (radius, falloff, width, ...) — null when it carries no geometry. */
export function featureExtent(f: any): LabBox | null {
  if (!f || typeof f !== "object") return null;
  const pts: V2[] = [];
  for (const k of PT_KEYS) pushPoints(f[k], pts);
  if (Array.isArray(f.origin) && Array.isArray(f.size)) pts.push([f.origin[0] + f.size[0], f.origin[1] + f.size[1]]);
  if (!pts.length) return null;
  let pad = 0;
  for (const k of PAD_KEYS) if (typeof f[k] === "number" && Number.isFinite(f[k])) pad += Math.abs(f[k]);
  for (const k of ["widths", "depths"]) if (Array.isArray(f[k])) pad += Math.max(0, ...f[k].filter((n: unknown) => typeof n === "number"));
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  return { min: [Math.min(...xs) - pad, Math.min(...zs) - pad], max: [Math.max(...xs) + pad, Math.max(...zs) + pad] };
}
const overlaps = (a: LabBox, b: LabBox, slack = 0) => a.max[0] + slack > b.min[0] && a.min[0] - slack < b.max[0] && a.max[1] + slack > b.min[1] && a.min[1] - slack < b.max[1];

/** Slack added to every feature's own reach before it is judged outside (blends, seams, shoulders round it). */
const FEATURE_SLACK_M = 64;

export interface CropProof { ok: boolean; samples: number; cells: number; restored: string[]; worst: string | null; ms: number }

/**
 * The recipe cropped to the box: features whose extent misses it are dropped (features without geometry and every global
 * field are kept), regions too (their polygon). Then proved against the uncropped recipe (`proveCrop`); a difference
 * puts back the dropped features one kind at a time until the proof passes. Returns the cropped raw recipe.
 */
export function cropRecipe(raw: any, box: LabBox, opts: { log?: (s: string) => void; step?: number } = {}): { recipe: any; proof: CropProof; dropped: Record<string, number> } {
  const log = opts.log ?? (() => {});
  const t0 = Date.now();
  const keepOf = (f: any) => { const e = featureExtent(f); return !e || overlaps(e, box, FEATURE_SLACK_M); };
  const dropped: Record<string, any[]> = {};
  const features: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw.features ?? {})) {
    if (!Array.isArray(v)) { features[k] = v; continue; }
    const keep = v.filter(keepOf); features[k] = keep;
    if (keep.length < v.length) dropped[k] = v.filter((f) => !keepOf(f));
  }
  const regionsDropped = Array.isArray(raw.regions) ? raw.regions.filter((r: any) => !keepOf(r)) : [];
  const build = (restore: Set<string>) => {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw.features ?? {})) f[k] = restore.has(k) || !Array.isArray(v) ? v : features[k];
    const out = { ...raw, features: f };
    if (Array.isArray(raw.regions) && !restore.has("regions")) out.regions = raw.regions.filter(keepOf);
    return out;
  };
  const live = createWorldField(worldRecipeSchema.parse(raw));
  const kinds = [...Object.keys(dropped), ...(regionsDropped.length ? ["regions"] : [])];
  const restored = new Set<string>();
  let recipe = build(restored), proof = proveCrop(live, recipe, box, opts.step);
  // a difference: put the dropped kinds back one at a time (the first that makes it pass stays back), never accept a drift
  for (const k of kinds) {
    if (proof.ok) break;
    log(`  crop: ${proof.worst} -> putting back the dropped ${k}`);
    restored.add(k); recipe = build(restored); proof = proveCrop(live, recipe, box, opts.step);
  }
  if (!proof.ok) throw new Error(`cropRecipe: the cropped ground differs from live even with every feature back (${proof.worst}): a recipe field outside features depends on the crop`);
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(dropped)) if (!restored.has(k)) counts[k] = v.length;
  if (regionsDropped.length && !restored.has("regions")) counts.regions = regionsDropped.length;
  return { recipe, proof: { ...proof, restored: [...restored], ms: Date.now() - t0 }, dropped: counts };
}

/**
 * Live vs cropped inside the box: height, density 1 m above and below the ground, the surface splat, biome and zone on a
 * `step` m grid, and every cell's generated doc (terrain entity + scatter). Exact equality, no tolerance.
 */
export function proveCrop(live: WorldField, croppedRaw: any, box: LabBox, step = 4): CropProof {
  const t0 = Date.now();
  const crop = createWorldField(worldRecipeSchema.parse(croppedRaw));
  const n = live.surfaceCount, a = new Float32Array(n), b = new Float32Array(n);
  let samples = 0;
  const bad = (what: string, x: number, z: number): CropProof => ({ ok: false, samples, cells: 0, restored: [], worst: `${what} differs at [${x}, ${z}]`, ms: Date.now() - t0 });
  for (let x = box.min[0]; x <= box.max[0]; x += step) {
    for (let z = box.min[1]; z <= box.max[1]; z += step) {
      samples++;
      const h = live.height(x, z);
      if (crop.height(x, z) !== h) return bad(`height (${h} vs ${crop.height(x, z)})`, x, z);
      if (crop.density(x, h + 1, z) !== live.density(x, h + 1, z) || crop.density(x, h - 1, z) !== live.density(x, h - 1, z)) return bad("density", x, z);
      live.surfaceAt(x, h, z, 1, a, 0); crop.surfaceAt(x, h, z, 1, b, 0);
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return bad("surface splat", x, z);
      if (live.waterY(x, z) !== crop.waterY(x, z)) return bad(`water level (${live.waterY(x, z)} vs ${crop.waterY(x, z)})`, x, z); // lakes, rivers, the sea (o-coast3 2026-10-31)
      if (live.biome(x, z).id !== crop.biome(x, z).id || live.zone(x, z).id !== crop.zone(x, z).id) return bad("biome/zone", x, z);
    }
  }
  const s = live.recipe.cellSize;
  let cells = 0;
  for (let cx = Math.floor(box.min[0] / s); cx * s < box.max[0]; cx++) {
    for (let cz = Math.floor(box.min[1] / s); cz * s < box.max[1]; cz++) {
      cells++;
      const A = JSON.stringify(voxelChunkDoc(live, "lab", cx, cz)), B = JSON.stringify(voxelChunkDoc(crop, "lab", cx, cz));
      if (A !== B) return { ok: false, samples, cells, restored: [], worst: `cell ${cx},${cz} generates differently`, ms: Date.now() - t0 };
    }
  }
  return { ok: true, samples, cells, restored: [], worst: null, ms: Date.now() - t0 };
}

const GLOBAL_COMPONENTS = ["voxelWorld", "sky", "postfx", "water", "fog", "weather", "chunkStreamer"];
const MOVE_TAGS = ["player", "spawn"];

/**
 * The scene cropped to the box: a root entity stays when it is global (no transform, a global component such as
 * voxelWorld / sky / water, a light) or when any entity in its tree stands inside the box (world position = the sum of
 * its ancestors' positions; the margin covers their turns). The player, its spawn and the camera are moved to `focus`
 * (on `groundY`) so the lab boots on its own ground; the voxelWorld gets `bounds` = the box.
 */
export function cropScene(scene: any, box: LabBox, focus: { x: number; z: number; groundY: number; target?: V2 }): { scene: any; kept: number; dropped: number } {
  const E = scene.entities as Record<string, any>;
  const kids = new Map<string, string[]>();
  for (const [id, e] of Object.entries(E)) if (e.parent) (kids.get(e.parent) ?? kids.set(e.parent, []).get(e.parent)!).push(id);
  const inBox = (x: number, z: number) => x >= box.min[0] && x <= box.max[0] && z >= box.min[1] && z <= box.max[1];
  const anyInside = (id: string, ox: number, oz: number): boolean => {
    const p = E[id]?.components?.transform?.position ?? [0, 0, 0], x = ox + (p[0] ?? 0), z = oz + (p[2] ?? 0);
    if (E[id]?.components?.transform && inBox(x, z)) return true;
    return (kids.get(id) ?? []).some((k) => anyInside(k, x, z));
  };
  // L (o-coast3 2026-10-31, Derek: "build it with the water layer in those separate chunks"): the world's OCEAN is one
  // 11.2 km primitive plane whose transform stands at [0, 0, 0], outside every coast lab's box, so the crop dropped it and
  // coves, anchored ships and shoals were built and shot against dry sea bed. A root whose primitive mesh REACHES the box
  // (its position +- half its size) stays, whatever its origin.
  const reaches = (e: any): boolean => {
    const t = e?.components?.transform, src = e?.components?.mesh?.source, sz = src?.size;
    if (!t || src?.kind !== "primitive" || !Array.isArray(sz)) return false;
    const p = t.position ?? [0, 0, 0], s = t.scale ?? [1, 1, 1], hx = Math.abs((sz[0] ?? 0) * (s[0] ?? 1)) / 2, hz = Math.abs((sz[2] ?? sz[1] ?? 0) * (s[2] ?? 1)) / 2;
    return p[0] + hx >= box.min[0] && p[0] - hx <= box.max[0] && p[2] + hz >= box.min[1] && p[2] - hz <= box.max[1];
  };
  const keep = new Set<string>();
  const addTree = (id: string) => { keep.add(id); for (const k of kids.get(id) ?? []) addTree(k); };
  for (const [id, e] of Object.entries(E)) {
    if (e.parent && E[e.parent]) continue;
    const c = e.components ?? {}, tags: string[] = e.tags ?? [];
    const global = !c.transform || GLOBAL_COMPONENTS.some((k) => c[k]) || !!c.light || !!c.camera || MOVE_TAGS.some((t) => tags.includes(t));
    if (global || reaches(e) || anyInside(id, 0, 0)) addTree(id);
  }
  const out = { ...scene, entities: {} as Record<string, any> };
  for (const id of Object.keys(E)) if (keep.has(id)) out.entities[id] = structuredClone(E[id]);
  // the player, its spawn and the camera onto the box's own ground (they stood at the world's spawn, outside it)
  let dy: number | null = null;
  for (const [id, e] of Object.entries(out.entities) as [string, any][]) {
    const tags: string[] = e.tags ?? [], t = e.components?.transform;
    if (!t || e.parent) continue;
    const isMover = MOVE_TAGS.some((g) => tags.includes(g)) || !!e.components?.camera || id === "player" || id === "spawn";
    if (!isMover) continue;
    const p = t.position ?? [0, 0, 0];
    // with a target (the place's centre) the lab ALWAYS starts at the place, facing it (Derek 2026-10-31: "the camera
    // already centred on those locations"); without one, only movers outside the box are pulled in
    if (inBox(p[0], p[2]) && !focus.target) continue;
    if (focus.target) {
      const d = unit2([focus.target[0] - focus.x, focus.target[1] - focus.z]), cam = !!e.components?.camera;
      t.position = cam ? [r2(focus.x - d[0] * 7), r2(focus.groundY + 3.6), r2(focus.z - d[1] * 7)] : [r2(focus.x), r2(focus.groundY + (tags.includes("spawn") || id === "spawn" ? 0 : 1.1)), r2(focus.z)];
      if (!cam) t.rotation = yawQuat(d);
      continue;
    }
    const rel = dy ?? (dy = p[1]);
    t.position = [focus.x + (e.components?.camera ? 6 : 0), Math.round((focus.groundY + 1 + (p[1] - rel)) * 100) / 100, focus.z + (e.components?.camera ? 6 : 0)];
  }
  for (const e of Object.values(out.entities) as any[]) if (e.components?.voxelWorld) e.components.voxelWorld.bounds = { min: [...box.min], max: [...box.max] };
  return { scene: out, kept: keep.size, dropped: Object.keys(E).length - keep.size };
}

// ---- where a lab starts: at the place, on walkable ground, facing it (Derek 2026-10-31) --------------------------------
const r2 = (v: number) => Math.round(v * 100) / 100;
const unit2 = (v: V2): V2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };

/**
 * Where an approach ARRIVES at a place: walking each approach line from its far end, the first point (2 m steps) within
 * `radius` + 10 m of the centre; with none, the line point nearest the centre. Null with no lines.
 */
export function approachArrival(lines: readonly (readonly V2[])[], center: V2, radius: number): V2 | null {
  let best: V2 | null = null, bestD = Infinity;
  for (const line of lines) {
    if (line.length < 2) continue;
    const far = Math.hypot(line[0]![0] - center[0], line[0]![1] - center[1]) >= Math.hypot(line[line.length - 1]![0] - center[0], line[line.length - 1]![1] - center[1]);
    const pts = far ? line : [...line].reverse();
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!, b = pts[i + 1]!, n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
      for (let k = 0; k <= n; k++) {
        const q: V2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], d = Math.hypot(q[0] - center[0], q[1] - center[1]);
        if (d <= radius + 10) return [r2(q[0]), r2(q[1])];
        if (d < bestD) { bestD = d; best = [r2(q[0]), r2(q[1])]; }
      }
    }
  }
  return best;
}

/**
 * A lab's start: from `at` toward `target` in 2 m steps, the first dry point under 24 deg (slope 0.4) is the stand (else
 * `at`); its ground from the field. The spawn shape the game shell takes (tools/_game-shell.mjs).
 */
export function labSpawn(field: WorldField, at: V2, target: V2, why: string): { position: [number, number, number]; rotation: [number, number, number, number]; from: string; ground: number; target: V2 } {
  const d = unit2([target[0] - at[0], target[1] - at[1]]), span = Math.hypot(target[0] - at[0], target[1] - at[1]);
  const dry = (q: V2) => { const w = field.waterY(q[0], q[1]), g = field.surfaceCast(q[0], q[1]) ?? field.height(q[0], q[1]); return field.slope(q[0], q[1]) < 0.4 && (w === null || w < g - 0.2); };
  let stand: V2 | null = null;
  for (let m = 0; m <= span && !stand; m += 2) { const q: V2 = [at[0] + d[0] * m, at[1] + d[1] * m]; if (dry(q)) stand = [r2(q[0]), r2(q[1])]; }
  // L (w-temple8 2026-11-03: the drowned temple's `shelf` concept view, a swimmer's eye across a lake): with no dry stand
  // between the eye and its target the lab started ON THE LAKE BED, camera under the water, and that scratch's frame never
  // drew (near-black, the WebGPU pipelines failing); the nearest dry, gentle ground round `at` is the stand instead
  for (let r = 2; r <= 120 && !stand; r += 2) for (let k = 0, n = Math.max(8, Math.round(r * 1.5)); k < n && !stand; k++) {
    const a = (k / n) * Math.PI * 2, q: V2 = [at[0] + Math.cos(a) * r, at[1] + Math.sin(a) * r];
    if (dry(q)) stand = [r2(q[0]), r2(q[1])];
  }
  stand ??= at;
  const ground = field.surfaceCast(stand[0], stand[1]) ?? field.height(stand[0], stand[1]);
  const face = unit2([target[0] - stand[0], target[1] - stand[1]]);
  return { position: [stand[0], r2(ground + 1.1), stand[1]], rotation: yawQuat(face), from: why, ground, target };
}

/** The lab scene playable like the world: the closure's game shell (tools/_game-shell.mjs), its player at `spawn`. */
export function labShell(labProject: string, scene: any, spawn: ReturnType<typeof labSpawn> | null): { scene: any; added: string[] } {
  const r = withGameShell(labProject, scene, spawn ? { position: spawn.position, rotation: spawn.rotation, from: spawn.from } : null);
  return { scene: r.doc, added: r.added };
}
