/**
 * ROCK SKINS — is every rock made of the stone of its place, and does its top wear the ground beside it?
 *
 *   worldgen rock-skins <world> [--project p] [--near x,z,r | --rect x0,z0,x1,z1 | --stamp] [--no-scene]
 *                               [--tone 9] [--json] [--out f.json] [--list]
 *
 * One gate for scatter rocks, boulders, cliff masses (the rock-cap material's instances) and rocks placed in the
 * world's scene (`mesh.source.rockCap`). Two faults:
 *
 * - SKIN: the body slice a rock wears is not the stone of the place. Measured by TONE, independently of the recipe's
 *   own table: the slice's texture (rock material `rockCap.bases[base]`) against the stone surface the terrain draws
 *   where the rock stands (its zone's cliff, or the sea cliff / butte it leans on: `cliffSurfaceAt`), as the a*b*
 *   distance of their mean colours in CIELAB (tone, not brightness: zones differ by colour tone). Over `--tone` = fault.
 * - CAP: the cap disagrees with the ground band beside the rock (`groundBand`, packages/core voxel/rock-cap.ts): a cap
 *   on stone ground, anything but the climate band's own surface (snow above the snow line) where one holds the
 *   ground, a cover that is not cap-worthy.
 *
 * Without an area it checks the recipe only (every zone's cliff has a skin of its own tone; no rule draws with the
 * rock material without resolving one; no fall-site formation names a foreign wall surface). `--near`/`--rect` adds
 * the sampled rocks there; `--stamp` sweeps every land chunk and, clean, stamps the `rock-skins` stage.
 * Fix: `recipe.rockSkins` (cliff surface -> slice) and the rock material's `bases` (docs/voxel-worlds.md "Rock skins").
 *
 * SMALL ROCKS: a piece under SMALL_ROCK_METRES (4 m) wears the world's SMALL rock material (`<rock material>-small`,
 * the rules' `smallMaterial`): the same shader with `bases` parallel to the main material's (so the per-instance slice
 * is unchanged), each zone slot holding the zone's grainy small-rock tile (`rock-small.png` beside its cliff tile, or
 * the palette's `rockSmall`) at 40 texels/m. A cliff's strata tile on a 1 m boulder projects a different patch of its
 * courses on every facet (a checker). The gate faults a rule whose small pieces have no small material, a small
 * material whose slots are not parallel or off the texel standard, and a placed small rock wearing the main material.
 *
 * LARGE ROCKS: a FREE-STANDING piece from 4 m up to LARGE_ROCK_MAX_METRES (16 m: boulders, fins, tors) wears the
 * world's LARGE rock material (`<rock material>-large`, the rules' `largeMaterial`), built the same way with each zone
 * slot holding the zone's boulder tile (`rock-large.png` beside its cliff tile, or the palette's `rockLarge`). The cliff
 * tile is painted for 100 m faces and reads as a patchwork on a 5-20 m boulder. Rules placed ON cliffs (`cliff`) are
 * the cliff face and keep the cliff tile (no `largeMaterial`), as do pieces of 16 m and more. The gate faults a
 * free-standing rule whose 4-16 m pieces have no large material, a cliff rule that has one, a large material off
 * parallel / 40 texels/m / tone, and a placed 4-16 m rock wearing the main material.
 */
import fs from "node:fs";
import path from "node:path";
import { applyOps, ComponentRegistry, createRockCapResolver, createWorldField, LARGE_ROCK_MAX_METRES, registerCoreComponents, rockSkinProbe, scatterCell, scatterMaterialOf, SMALL_ROCK_METRES, worldRecipeSchema, type WorldField, type WorldRecipe } from "@hitreg/core";
import { fileURLToPath } from "node:url";
import { decodePng } from "./_png.mjs";
import { modelBounds } from "./_gltf-bounds.mjs";
import { findAsset, projectsRoot } from "./_closure.mjs";
import { worldChunks } from "./float.mts";
import { applyOpsToSceneFile, updateJsonFile } from "./_scene-write.mts";
import { zonePalette } from "./_zone-palette.mts";

type Area = { near?: [number, number, number]; rect?: [number, number, number, number] };
const inArea = (a: Area, x: number, z: number): boolean =>
  a.near ? Math.hypot(x - a.near[0], z - a.near[1]) <= a.near[2] : a.rect ? x >= a.rect[0] && z >= a.rect[1] && x <= a.rect[2] && z <= a.rect[3] : true;
const r1 = (v: number): number => Math.round(v * 10) / 10;

export interface RockSkinRow {
  kind: "scatter" | "scene" | "recipe";
  fault: "skin" | "cap" | "recipe";
  what: string;
  id: string;
  x?: number;
  y?: number;
  z?: number;
  detail: string;
  /** Tone distance for a skin fault. */
  tone?: number;
}

export interface RockSkinReport {
  ok: boolean;
  target: string;
  area: string;
  toneLimit: number;
  checked: { scatter: number; scene: number; zones: number };
  counts: { skin: number; cap: number; recipe: number; byRule: Record<string, number>; bySkin: Record<string, number> };
  zones: { id: string; cliff: string | null; skin: number | null; tone: number | null }[];
  worst: { at: [number, number]; skin: number; cap: number }[];
  rows: RockSkinRow[];
  ms: number;
}

// ------------------------------------------------------------------ tone

/** sRGB hex/bytes -> CIELAB. */
export function lab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
/** Tone distance: the a*b* (hue + chroma) distance, brightness ignored. */
export function toneDistance(p: readonly number[], q: readonly number[]): number {
  const a = lab(p[0]!, p[1]!, p[2]!), b = lab(q[0]!, q[1]!, q[2]!);
  return Math.hypot(a[1] - b[1], a[2] - b[2]);
}
const hex = (h: string): [number, number, number] => { const v = parseInt(h.replace("#", "").slice(0, 6), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

const meanCache = new Map<string, [number, number, number] | null>();
/** Mean sRGB of a PNG texture (`textures/<id>` in the project's closure), times `color`; null when unreadable. */
function textureMean(project: string, id: string | undefined, color?: string): [number, number, number] | null {
  const key = `${project}|${id}|${color}`;
  if (meanCache.has(key)) return meanCache.get(key)!;
  let out: [number, number, number] | null = null;
  const file = id ? findAsset(project, `textures/${id}`) : null;
  if (file && file.endsWith(".png")) {
    try {
      const im = decodePng(fs.readFileSync(file));
      const d: Uint8Array = im.data ?? im.rgba ?? im.pixels;
      const ch = Math.round(d.length / (im.width * im.height));
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += ch * 7) { r += d[i]!; g += d[i + 1]!; b += d[i + 2]!; n++; }
      out = [r / n, g / n, b / n];
    } catch { out = null; }
  }
  if (!out && color) out = hex(color);
  else if (out && color) { const m = hex(color); out = [out[0] * m[0] / 255, out[1] * m[1] / 255, out[2] * m[2] / 255]; }
  meanCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ the gate

interface RockMaterial { id: string; bases: { map: string; metres?: number; color?: string }[]; tones: ([number, number, number] | null)[]; small: boolean; large: boolean }

/** The rock-cap materials the world's scatter rules draw with (by asset id): each rule's `material`, then its `smallMaterial` and `largeMaterial`. */
function rockMaterials(project: string, recipe: WorldRecipe, override?: readonly { map: string; color?: string }[]): Map<string, RockMaterial> {
  const out = new Map<string, RockMaterial>();
  for (const rule of recipe.scatter)
    for (const [id, kind] of [[rule.material, "main"], [rule.smallMaterial, "small"], [rule.largeMaterial, "large"]] as const) {
      if (!id || out.has(id)) continue;
      const file = findAsset(project, `materials/${id}.json`);
      if (!file) continue;
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (doc.shader !== "rock-cap" || !doc.rockCap?.bases) continue;
      const bases = (kind !== "main" ? doc.rockCap.bases : override ?? doc.rockCap.bases) as { map: string; metres?: number; color?: string }[];
      out.set(id, { id, bases, small: kind === "small", large: kind === "large", tones: bases.map((b) => textureMean(project, b.map, b.color && b.color !== "#ffffff" ? b.color : undefined)) });
    }
  return out;
}

/** Which material a placed or scattered piece of this size (m) draws with: small under 4 m, large up to 16 m, else main. */
export function rockMaterialForSize(size: number | null, ids: { main: string; small?: string; large?: string }): string {
  if (size === null) return ids.main;
  if (size < SMALL_ROCK_METRES) return ids.small ?? ids.main;
  if (size < LARGE_ROCK_MAX_METRES) return ids.large ?? ids.main;
  return ids.main;
}

/** Largest piece (m) a rule can scatter: its biggest collider box (rule or variant) times its top scale. */
function ruleExtent(rule: WorldRecipe["scatter"][number]): { least: number; most: number } {
  const boxes = [rule.colliderSize, ...(rule.modelVariants ?? []).map((v) => v.colliderSize)].filter((b): b is [number, number, number] => !!b).map((b) => Math.max(...b));
  return { least: Math.min(...boxes) * (rule.scale?.[0] ?? 1), most: Math.max(...boxes) * (rule.scale?.[1] ?? rule.scale?.[0] ?? 1) };
}

/** The model-space collider box of a scatter instance: its own, its variant's, else the rule's. */
function scatterBox(rule: WorldRecipe["scatter"][number], inst: { colliderSize?: readonly number[]; variant?: number }): readonly number[] | undefined {
  return inst.colliderSize ?? (inst.variant !== undefined ? rule.modelVariants?.[inst.variant]?.colliderSize : undefined) ?? rule.colliderSize;
}

// ------------------------------------------------------------------ placed rocks (scenes)

export interface PlacedRock {
  id: string;
  /** A stone piece of a BUILT structure (entity tag `stone:<material id>`: a weighting stone in a basin): it draws with that
   *  structure's stone, never the zone's scatter skin, and carries no cap (RETTING 2026-10-23: blue cliff-skinned boulders in a
   *  masonry pit). */
  builtStone?: string;
  what: string;
  prefabId: string | null;
  /** The prefab's root entity id (override paths start with it), or null for a plain mesh entity. */
  root: string | null;
  x: number;
  y: number;
  z: number;
  material: string | null;
  rockCap: { layer?: number; amount?: number; base?: number; tint?: number[] } | null;
  /** The model's own body texture (rock-kit GLB extras `rockKit.bases[0]`), when it draws without a rock material. */
  modelBase: string | null;
  /** Largest world extent (m): the model's bounds x the instance's world scale; null when the model is unreadable. */
  size: number | null;
  /** The instance's world scale (largest axis): the rock-cap body is projected in MODEL metres, so texels/m divide by it. */
  scale: number;
}

const modelSizeCache = new Map<string, number | null>();
/** Largest model-space extent of a model (m), or null. */
function modelSizeOf(project: string, assetId: string): number | null {
  const key = `${project}|${assetId}`;
  if (modelSizeCache.has(key)) return modelSizeCache.get(key)!;
  let out: number | null = null;
  const file = assetId ? findAsset(project, `models/${assetId}`) : null;
  if (file) { try { const b = modelBounds(file); out = Math.max(b.size[0], b.size[1], b.size[2]); } catch { out = null; } }
  modelSizeCache.set(key, out);
  return out;
}
/** Largest world scale factor of an entity (parent chain composed). */
function worldScale(ents: Record<string, any>, id: string): number {
  let s = 1;
  for (let cur: string | undefined = id; cur && ents[cur]; cur = ents[cur].parent) { const v = ents[cur].components?.transform?.scale ?? [1, 1, 1]; s *= Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])); }
  return s;
}

const prefabCache = new Map<string, { root: string; mesh: any; tags: string[] } | null>();
function rockPrefab(project: string, id: string): { root: string; mesh: any; tags: string[] } | null {
  const key = `${project}|${id}`;
  if (prefabCache.has(key)) return prefabCache.get(key)!;
  let out: { root: string; mesh: any; tags: string[] } | null = null;
  const file = findAsset(project, `prefabs/${id}.json`);
  if (file) {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const root = doc.root as string;
    const e = doc.entities?.[root];
    const mesh = e?.components?.mesh;
    const tags: string[] = e?.tags ?? [];
    const asset: string = mesh?.source?.assetId ?? "";
    if (mesh && (tags.includes("rock-kit") || /^rock-kit\//.test(asset)) && !/^rock-kit\/shelf-/.test(asset)) out = { root, mesh, tags };
  }
  prefabCache.set(key, out);
  return out;
}
const glbBaseCache = new Map<string, string | null>();
function modelBaseOf(project: string, assetId: string): string | null {
  if (glbBaseCache.has(assetId)) return glbBaseCache.get(assetId)!;
  let out: string | null = null;
  const file = findAsset(project, `models/${assetId}`);
  if (file?.endsWith(".glb")) {
    try {
      const b = fs.readFileSync(file);
      const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString("utf8"));
      out = json.materials?.[0]?.extras?.rockKit?.bases?.[0] ?? null;
    } catch { out = null; }
  }
  glbBaseCache.set(assetId, out);
  return out;
}

/** World position of a scene entity (parent chain composed). */
function worldPosition(ents: Record<string, any>, id: string): [number, number, number] {
  let p: [number, number, number] = [0, 0, 0];
  for (let cur: string | undefined = id; cur && ents[cur]; cur = ents[cur].parent) {
    const t = ents[cur].components?.transform ?? {};
    const q = t.rotation ?? [0, 0, 0, 1], s = t.scale ?? [1, 1, 1], o = t.position ?? [0, 0, 0];
    const v = [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
    const [qx, qy, qz, qw] = q;
    const cx = qy * v[2]! - qz * v[1]!, cy = qz * v[0]! - qx * v[2]!, cz = qx * v[1]! - qy * v[0]!;
    p = [v[0]! + 2 * (qw * cx + qy * cz - qz * cy) + o[0], v[1]! + 2 * (qw * cy + qz * cx - qx * cz) + o[1], v[2]! + 2 * (qw * cz + qx * cy - qy * cx) + o[2]];
  }
  return p;
}

/** Every rock placed in a scene: rock-kit prefab instances (with their overrides) and meshes carrying a rockCap. */
export function placedRocks(project: string, scene: any): PlacedRock[] {
  const ents = scene.entities as Record<string, any>;
  const out: PlacedRock[] = [];
  for (const [id, e] of Object.entries(ents)) {
    const pf = e.components?.prefab;
    if (pf?.prefabId) {
      const p = rockPrefab(project, pf.prefabId);
      if (!p) continue;
      const ov = new Map<string, unknown>((pf.overrides ?? []).map((o: { path: string; value: unknown }) => [o.path, o.value]));
      const material = (ov.get(`${p.root}/components/mesh/material`) as string | undefined) ?? p.mesh.material ?? null;
      const rockCap = (ov.get(`${p.root}/components/mesh/source/rockCap`) as PlacedRock["rockCap"]) ?? p.mesh.source?.rockCap ?? null;
      const [x, y, z] = worldPosition(ents, id);
      const ms = modelSizeOf(project, p.mesh.source?.assetId ?? ""), builtStone = ((e.tags ?? []) as string[]).find((t) => t.startsWith("stone:"))?.slice(6);
      out.push({ id, ...(builtStone ? { builtStone } : {}), what: pf.prefabId, prefabId: pf.prefabId, root: p.root, x, y, z, material, rockCap, modelBase: material ? null : modelBaseOf(project, p.mesh.source?.assetId ?? ""), size: ms === null ? null : ms * worldScale(ents, id), scale: worldScale(ents, id) });
      continue;
    }
    const mesh = e.components?.mesh;
    if (!mesh?.source?.rockCap) continue;
    const [x, y, z] = worldPosition(ents, id);
    const ms = modelSizeOf(project, String(mesh.source.assetId ?? ""));
    out.push({ id, what: String(mesh.source.assetId ?? e.name ?? id), prefabId: null, root: null, x, y, z, material: mesh.material ?? null, rockCap: mesh.source.rockCap, modelBase: null, size: ms === null ? null : ms * worldScale(ents, id), scale: worldScale(ents, id) });
  }
  return out;
}

/**
 * The ops that give placed rocks their place's skin and cap: each rock-kit prefab instance draws with the world's
 * rock material (the one its scatter rocks use: one batch per model, the skin rides per instance) and carries the
 * rockCap the scatter resolver gives a rock at that spot. A piece under SMALL_ROCK_METRES draws with the rule's
 * `smallMaterial` (the zone's small-rock tile) when the world has one, a free-standing one up to LARGE_ROCK_MAX_METRES
 * the free-standing rules' `largeMaterial` (the zone's boulder tile). Idempotent: an instance already right gets no op.
 * `ids` limits it to freshly placed entities (dress apply).
 */
export function skinPlacedOps(project: string, scene: any, field: WorldField, ids?: ReadonlySet<string>): { ops: any[]; changed: string[] } {
  const recipe = field.recipe;
  const template = recipe.scatter.find((r) => r.cap && r.material && rockMaterials(project, recipe).has(r.material));
  if (!template) return { ops: [], changed: [] };
  const mainId = template.material!;
  const sameMain = recipe.scatter.filter((r) => r.material === mainId);
  const smallId = sameMain.find((r) => r.smallMaterial)?.smallMaterial;
  const largeId = sameMain.find((r) => r.largeMaterial && !r.cliff)?.largeMaterial;
  const rule = { ...template, cap: "auto", capAmount: 0.6 } as typeof template;
  const resolve = createRockCapResolver(field);
  const ops: any[] = [], changed: string[] = [];
  const ents = scene.entities as Record<string, any>;
  for (const r of placedRocks(project, scene)) {
    if (!r.prefabId || !r.root || (ids && !ids.has(r.id))) continue;
    const cap = r.builtStone ? null : resolve(rule, r.x, r.y, r.z);
    if (!cap && !r.builtStone) continue;
    const material = r.builtStone ?? rockMaterialForSize(r.size, { main: mainId, small: smallId, large: largeId });
    const want: Record<string, unknown> = r.builtStone ? { [`${r.root}/components/mesh/material`]: material } : { [`${r.root}/components/mesh/material`]: material, [`${r.root}/components/mesh/source/rockCap`]: cap };
    const pf = ents[r.id].components.prefab;
    const overrides = ([...(pf.overrides ?? [])] as { path: string; value: unknown }[]).filter((o) => !(r.builtStone && o.path === `${r.root}/components/mesh/source/rockCap`));
    let dirty = overrides.length !== (pf.overrides ?? []).length;
    for (const [p, v] of Object.entries(want)) {
      const i = overrides.findIndex((o) => o.path === p);
      if (i >= 0 && JSON.stringify(overrides[i]!.value) === JSON.stringify(v)) continue;
      dirty = true;
      if (i >= 0) overrides[i] = { path: p, value: v };
      else overrides.push({ path: p, value: v });
    }
    if (!dirty) continue;
    ops.push({ op: "set-component", id: r.id, component: "prefab", data: { ...pf, overrides } });
    changed.push(r.id);
  }
  return { ops, changed };
}

/** Texels per metre a small-rock tile must hold (the town standard, 40), with this much slack either way. */
const SMALL_TEXEL = 40, SMALL_TEXEL_SLACK = 8;

/**
 * The small-rock recipe faults: a rule drawing with the main rock material whose pieces go under SMALL_ROCK_METRES
 * without a `smallMaterial`, and a small material whose slots do not run parallel to the main one's (count, tone) or
 * leave the 40 texel/m standard.
 */
function smallRockFaults(project: string, recipe: WorldRecipe, materials: Map<string, RockMaterial>, toneLimit: number): RockSkinRow[] {
  const rows: RockSkinRow[] = [];
  const main = [...materials.values()].find((m) => !m.small && !m.large);
  if (!main) return rows;
  for (const rule of recipe.scatter) {
    if (rule.material !== main.id) continue;
    const { least, most } = ruleExtent(rule);
    const small = rule.smallMaterial, large = rule.largeMaterial;
    if (Number.isFinite(least) && least < SMALL_ROCK_METRES && !small)
      rows.push({ kind: "recipe", fault: "recipe", what: "rule", id: rule.id, detail: `pieces down to ${least.toFixed(1)} m wear ${main.id}'s cliff tiles (a checker on a small boulder): give it smallMaterial (rock-skins install)` });
    else if (small && !materials.has(small))
      rows.push({ kind: "recipe", fault: "recipe", what: "rule", id: rule.id, detail: `smallMaterial ${small} is not a rock-cap material in the closure` });
    // large: free-standing pieces of 4-16 m wear the zone's boulder tile; a rule ON a cliff is the cliff face and keeps the cliff tile
    if (rule.cliff) {
      if (large) rows.push({ kind: "recipe", fault: "recipe", what: "rule", id: rule.id, detail: `a cliff-placed rule draws its big pieces with ${large}: cliff faces keep the cliff tile (drop largeMaterial; rock-skins install)` });
    } else if (Number.isFinite(most) && most >= SMALL_ROCK_METRES && least < LARGE_ROCK_MAX_METRES && !large)
      rows.push({ kind: "recipe", fault: "recipe", what: "rule", id: rule.id, detail: `free-standing pieces up to ${most.toFixed(1)} m wear ${main.id}'s cliff tiles (a patchwork on a boulder): give it largeMaterial (rock-skins install)` });
    else if (large && !materials.has(large))
      rows.push({ kind: "recipe", fault: "recipe", what: "rule", id: rule.id, detail: `largeMaterial ${large} is not a rock-cap material in the closure` });
  }
  for (const m of materials.values()) {
    if (!m.small && !m.large) continue;
    const what = m.small ? "small-material" : "large-material";
    if (m.bases.length !== main.bases.length) rows.push({ kind: "recipe", fault: "recipe", what, id: m.id, detail: `${m.bases.length} bases, ${main.id} has ${main.bases.length}: slots must run parallel (the per-instance slice is shared)` });
    m.bases.forEach((b, i) => {
      const px = pngWidth(findAsset(project, `textures/${b.map}`));
      const texel = px && b.metres ? px / b.metres : null;
      if (texel !== null && Math.abs(texel - SMALL_TEXEL) > SMALL_TEXEL_SLACK) rows.push({ kind: "recipe", fault: "recipe", what, id: m.id, detail: `slot ${i} ${b.map} at ${texel.toFixed(0)} texels/m (want ${SMALL_TEXEL})` });
      const a = m.tones[i], c = main.tones[i];
      const tone = a && c ? r1(toneDistance(a, c)) : null;
      if (tone !== null && tone > toneLimit) rows.push({ kind: "recipe", fault: "recipe", what, id: m.id, tone, detail: `slot ${i} ${b.map} is tone ${tone} off ${main.bases[i]?.map ?? "?"} (the same stone, ${m.small ? "smaller" : "as a boulder"})` });
    });
  }
  return rows;
}

export function rockSkinsGate(opts: { project: string; recipe: WorldRecipe; field?: WorldField; area: Area | null; areaText: string; scene?: any; toneLimit?: number; /** Rock material bases to judge with instead of the file's (a plan not yet written). */ bases?: readonly { map: string; color?: string }[]; /** scatterCell results by "cx,cz", shared with a caller sweeping the same field. */ cells?: Map<string, ReturnType<typeof scatterCell>> }): RockSkinReport {
  const t0 = performance.now();
  const { project, recipe } = opts;
  const toneLimit = opts.toneLimit ?? 9;
  const field = opts.field ?? createWorldField(recipe);
  const probe = rockSkinProbe(field);
  const names = recipe.surfaces.map((s) => s.name);
  const surfaceTone = (i: number) => textureMean(project, (recipe.surfaces[i] as { map?: string }).map, (recipe.surfaces[i] as { map?: string }).map ? undefined : (recipe.surfaces[i] as { color?: string }).color);
  const materials = rockMaterials(project, recipe, opts.bases);
  const mainMaterial = [...materials.values()].find((m) => !m.small && !m.large) ?? null;
  const rows: RockSkinRow[] = [];
  const skins = (recipe as { rockSkins?: Record<string, number> }).rockSkins;

  // ---- recipe: every zone's cliff has a skin of its own tone
  const zones: RockSkinReport["zones"] = [];
  const regions = (recipe as { regions?: any[] }).regions ?? [];
  const cliffOf = (r: any): string | null => {
    for (let hop = 0, cur = r; cur && hop < 4; hop++, cur = regions.find((q) => q.id === cur.within)) if (cur.ground?.cliff) return cur.ground.cliff;
    return null;
  };
  if (mainMaterial) {
    if (!skins) rows.push({ kind: "recipe", fault: "recipe", what: "rockSkins", id: recipe.name, detail: "the world has no rockSkins table: every rock wears its rule's fixed base, whatever zone it stands in" });
    // a table row naming a stone the recipe does not have, or a slice the material does not have (init --from copies)
    for (const [stone, slice] of Object.entries(skins ?? {})) {
      if (stone !== "*" && !names.includes(stone)) rows.push({ kind: "recipe", fault: "recipe", what: "rockSkins", id: stone, detail: `rockSkins names ${stone}, no surface of ${recipe.name} (inherited from another world?): rock-skins install drops it` });
      else if (slice >= mainMaterial.tones.length) rows.push({ kind: "recipe", fault: "recipe", what: "rockSkins", id: stone, detail: `rockSkins maps ${stone} to slice ${slice}; ${mainMaterial.id ?? "the rock material"} has ${mainMaterial.tones.length} bases` });
    }
    // a rule's own cliff->slice map naming stones the recipe does not have (copied with the rule from another world)
    for (const rule of recipe.scatter) {
      const foreign = Object.keys(rule.rockBaseByCliff ?? {}).filter((k) => k !== "*" && !names.includes(k));
      if (foreign.length) rows.push({ kind: "recipe", fault: "recipe", what: "rule", id: rule.id, detail: `rockBaseByCliff names ${foreign.join(", ")}, no surface of ${recipe.name} (inherited from another world?): rock-skins install drops it` });
    }
    for (const r of regions.filter((q) => !q.within)) {
      const cliff = cliffOf(r);
      const ci = cliff ? names.indexOf(cliff) : -1;
      const slice = skins ? (cliff && skins[cliff] !== undefined ? skins[cliff]! : (skins["*"] ?? null)) : null;
      const st = ci >= 0 ? surfaceTone(ci) : null, bt = slice !== null ? mainMaterial.tones[slice] ?? null : null;
      const tone = st && bt ? r1(toneDistance(st, bt)) : null;
      zones.push({ id: r.id, cliff, skin: slice, tone });
      if (!cliff) { rows.push({ kind: "recipe", fault: "recipe", what: "zone", id: r.id, detail: "zone has no ground.cliff: no zone stone to derive a rock skin from (worldgen zone-textures)" }); continue; }
      if (skins && (skins[cliff] === undefined)) rows.push({ kind: "recipe", fault: "recipe", what: "zone", id: r.id, detail: `cliff ${cliff} has no rockSkins entry (falls back to ${skins["*"] ?? "the rules' bases"})` });
      if (slice !== null && slice >= mainMaterial.bases.length) rows.push({ kind: "recipe", fault: "recipe", what: "zone", id: r.id, detail: `rockSkins ${cliff} -> ${slice}, but ${mainMaterial.id} has ${mainMaterial.bases.length} bases` });
      else if (tone !== null && tone > toneLimit) rows.push({ kind: "recipe", fault: "recipe", what: "zone", id: r.id, tone, detail: `skin ${mainMaterial.bases[slice!]!.map} is tone ${tone} off its cliff ${cliff}` });
    }
    for (const rule of recipe.scatter) {
      const m = (rule as { material?: string }).material;
      if (m && materials.has(m) && !rule.cap && rule.rockBase === undefined && !rule.rockBaseByCliff)
        rows.push({ kind: "recipe", fault: "recipe", what: "rule", id: rule.id, detail: `draws with ${m} but never resolves a skin (give it cap or rockBase)` });
    }
    rows.push(...smallRockFaults(project, recipe, materials, toneLimit));
    const smallM = [...materials.values()].find((m) => m.small), largeM = [...materials.values()].find((m) => m.large);
    for (const detail of paletteSkinFaults(recipe, skins, mainMaterial.bases, smallM?.bases, largeM?.bases))
      rows.push({ kind: "recipe", fault: "recipe", what: "palette", id: detail.split(":")[0]!, detail });
  }
  for (const site of (recipe.features as { fallSites?: any[] }).fallSites ?? []) {
    const wall = site.formations?.wallSurface;
    if (!wall || !site.at) continue;
    const at = site.at as [number, number];
    const ci = probe.cliffSurfaceAt(at[0], field.height(at[0], at[1]), at[1]);
    if (ci >= 0 && names[ci] !== wall) {
      const a = surfaceTone(ci), b = names.indexOf(wall) >= 0 ? surfaceTone(names.indexOf(wall)) : null;
      const tone = a && b ? r1(toneDistance(a, b)) : null;
      if (tone === null || tone > toneLimit) rows.push({ kind: "recipe", fault: "recipe", what: "fall-site", id: site.id, x: at[0], z: at[1], ...(tone !== null ? { tone } : {}), detail: `formations.wallSurface ${wall} on a ${names[ci]} wall (drop it: the masses take the zone's cliff)` });
    }
  }

  // ---- one rock: its skin and its cap
  let checkedScatter = 0, checkedScene = 0;
  const mixScratch = new Float32Array(field.surfaceCount + 3);
  /** Stone surfaces holding at least a quarter of the strongest stone's weight on a face at (x, y, z). */
  const mixedStones = (x: number, y: number, z: number): number[] => {
    field.surfaceAt(x, y, z, 0, mixScratch, 0);
    let max = 0;
    for (const i of probe.stone) max = Math.max(max, mixScratch[i]!);
    return [...probe.stone].filter((i) => max > 0 && mixScratch[i]! >= 0.25 * max);
  };
  /**
   * `inWater`: a rock standing in water (a rule with `water`) is judged against the stone of its nearest BANKS, at its
   * formation's anchor (members share the anchor's skin), with no border leniency: the bed under it blends the zones a
   * river divides, and "matches some stone there" passed a slate slab in a red pool (Skelmorrow's ochreburn fall).
   */
  const judge = (kind: "scatter" | "scene", what: string, id: string, x: number, y: number, z: number, cap: { layer?: number; amount?: number; base?: number }, material: RockMaterial | null, inWater?: { x: number; z: number }, capY = y) => {
    const base = cap.base ?? 0;
    const bank = inWater ? probe.bankStoneAt(inWater.x, inWater.z).surface : -1;
    const ci = bank >= 0 ? bank : probe.cliffSurfaceAt(x, y, z);
    if (material && ci >= 0) {
      const st = surfaceTone(ci), bt = material.tones[base] ?? null;
      if (st && bt) {
        const tone = r1(toneDistance(st, bt));
        // across a zone border the stones blend (zoneGround.band) and a formation's members share their anchor's skin:
        // a skin that matches ANY stone holding a quarter of the face there is that place's stone
        if (tone > toneLimit && bank < 0 && mixedStones(x, y, z).some((i) => { const t = surfaceTone(i); return t && toneDistance(t, bt) <= toneLimit; })) return judgeCap();
        if (tone > toneLimit) rows.push({ kind, fault: "skin", what, id, x: r1(x), y: r1(y), z: r1(z), tone, detail: `wears ${material.bases[base]?.map ?? `base ${base}`} ${bank >= 0 ? "in water by" : "on"} ${names[ci]} ${bank >= 0 ? "banks" : "ground"} (tone ${tone})` });
      }
    }
    judgeCap();
    function judgeCap(): void {
      const amount = cap.amount ?? 0;
      if (amount <= 0) return;
      const g = probe.groundBand(x, capY, z);
      const layer = cap.layer ?? 0;
      const capName = layer < names.length ? names[layer]! : `extra layer ${layer - names.length}`;
      // a margin over the resolver's own thresholds: a formation's members share their anchor's cap (one formation reads
      // as one), so a member a step over the 50% line is not a fault; a rock clearly on stone or in the snow is
      if (g.band === "bare" && g.bare >= 0.6) rows.push({ kind, fault: "cap", what, id, x: r1(x), y: r1(y), z: r1(z), detail: `${capName} cap on stone ground (${Math.round(g.bare * 100)}% stone)` });
      else if (g.band === "climate" && g.share >= 0.45 && (!g.worthy || layer !== g.surface)) rows.push({ kind, fault: "cap", what, id, x: r1(x), y: r1(y), z: r1(z), detail: `${capName} cap where ${names[g.surface]} holds the ground` });
    }
  };

  // ---- scatter rocks in the area
  if (opts.area && (opts.area.near || opts.area.rect)) {
    const a = opts.area, size = recipe.cellSize;
    const rect = a.rect ?? [a.near![0] - a.near![2], a.near![1] - a.near![2], a.near![0] + a.near![2], a.near![1] + a.near![2]];
    const capped = recipe.scatter.map((r) => !!(r.cap || r.rockBase !== undefined || r.rockBaseByCliff));
    if (capped.some(Boolean)) {
      for (let cz = Math.floor(rect[1] / size); cz <= Math.floor(rect[3] / size); cz++)
        for (let cx = Math.floor(rect[0] / size); cx <= Math.floor(rect[2] / size); cx++) {
          if (field.worldLimit !== Infinity && Math.hypot((cx + 0.5) * size, (cz + 0.5) * size) > field.worldLimit + size) continue;
          let insts = opts.cells?.get(`${cx},${cz}`);
          if (!insts) { insts = scatterCell(field, cx, cz); opts.cells?.set(`${cx},${cz}`, insts); }
          // a formation's anchor (members are "<anchor id>_f<i>", emitted in the anchor's cell)
          const anchors = new Map<string, { x: number; z: number }>();
          for (const inst of insts) if (!/_f\d+$/.test(inst.id)) anchors.set(inst.id, { x: inst.position[0] + cx * size, z: inst.position[2] + cz * size });
          for (const inst of insts) {
            if (!capped[inst.ruleIndex] || !inst.rockCap) continue;
            const rule = recipe.scatter[inst.ruleIndex]!;
            const x = inst.position[0] + cx * size, z = inst.position[2] + cz * size;
            if (!inArea(a, x, z)) continue;
            checkedScatter++;
            const wet = rule.water ? (anchors.get(inst.id.replace(/_f\d+$/, "")) ?? { x, z }) : undefined;
            // the cap is judged at the GROUND, as the placer chose it (withRockCap reads the ground y): a rock bedded deeper than
            // its heightfield seat (SEAT_PROBE_MARGIN) read a shore band 0.25 m down as the ground
            judge("scatter", rule.id, inst.id, x, inst.position[1], z, inst.rockCap, materials.get(scatterMaterialOf(rule, scatterBox(rule, inst), inst.scale) ?? "") ?? null, wet, field.ground(x, z));
          }
        }
    }
  }

  // ---- rocks placed in the world's scene (POIs): rock-kit prefab instances and meshes with a rockCap
  if (opts.scene) {
    for (const r of placedRocks(project, opts.scene)) {
      if (opts.area && !inArea(opts.area, r.x, r.z)) continue;
      checkedScene++;
      // a built structure's stone piece: judged against its structure's stone, not the zone skin
      if (r.builtStone) { if (r.material !== r.builtStone) rows.push({ kind: "scene", fault: "skin", what: r.what, id: r.id, x: r1(r.x), y: r1(r.y), z: r1(r.z), detail: `a stone of a built structure wears ${r.material ?? "its model's own texture"}, not its structure's ${r.builtStone} (rock-skins install)` }); continue; }
      const mat = r.material ? materials.get(r.material) ?? null : null;
      if (!mat) {
        // the model's own texture (the kit's first base, granite): not the world's stone anywhere it differs
        const own = r.modelBase ? textureMean(project, r.modelBase) : null;
        const ci = probe.cliffSurfaceAt(r.x, r.y, r.z);
        const st = ci >= 0 ? surfaceTone(ci) : null;
        const tone = own && st ? r1(toneDistance(own, st)) : null;
        if (mainMaterial && (tone === null || tone > toneLimit))
          rows.push({ kind: "scene", fault: "skin", what: r.what, id: r.id, x: r1(r.x), y: r1(r.y), z: r1(r.z), ...(tone !== null ? { tone } : {}), detail: `draws the model's own ${r.modelBase ?? "texture"}, not ${mainMaterial.id}, on ${ci >= 0 ? names[ci] : "?"} ground${tone !== null ? ` (tone ${tone})` : ""}` });
        continue;
      }
      // a small placed rock on the main material wears the cliff's strata tile: the checker on a 1 m boulder
      const small = [...materials.values()].find((q) => q.small);
      if (small && !mat.small && r.size !== null && r.size < SMALL_ROCK_METRES)
        rows.push({ kind: "scene", fault: "skin", what: r.what, id: r.id, x: r1(r.x), y: r1(r.y), z: r1(r.z), detail: `a ${r.size.toFixed(1)} m rock wears ${mat.id}, not the small-rock ${small.id} (rock-skins install)` });
      // a free-standing 4-16 m placed rock on the main material wears the 100 m cliff tile: a patchwork on a boulder
      const large = [...materials.values()].find((q) => q.large);
      if (large && !mat.small && !mat.large && r.size !== null && r.size >= SMALL_ROCK_METRES && r.size < LARGE_ROCK_MAX_METRES)
        rows.push({ kind: "scene", fault: "skin", what: r.what, id: r.id, x: r1(r.x), y: r1(r.y), z: r1(r.z), detail: `a ${r.size.toFixed(1)} m rock wears ${mat.id}'s cliff tile, not the boulder ${large.id} (rock-skins install)` });
      judge("scene", r.what, r.id, r.x, r.y, r.z, r.rockCap ?? {}, mat);
    }
  }

  const skin = rows.filter((r) => r.fault === "skin"), cap = rows.filter((r) => r.fault === "cap"), recipeRows = rows.filter((r) => r.fault === "recipe");
  const byRule: Record<string, number> = {}, bySkin: Record<string, number> = {};
  for (const r of rows) if (r.kind !== "recipe") byRule[r.what] = (byRule[r.what] ?? 0) + 1;
  for (const r of skin) { const k = r.detail.replace(/ \(tone.*$/, "").replace(/^wears /, ""); bySkin[k] = (bySkin[k] ?? 0) + 1; }
  // worst places: faults binned on a 128 m grid
  const bins = new Map<string, { at: [number, number]; skin: number; cap: number }>();
  for (const r of [...skin, ...cap]) {
    const bx = Math.floor(r.x! / 128), bz = Math.floor(r.z! / 128), k = `${bx},${bz}`;
    const b = bins.get(k) ?? { at: [bx * 128 + 64, bz * 128 + 64] as [number, number], skin: 0, cap: 0 };
    b[r.fault as "skin" | "cap"]++;
    bins.set(k, b);
  }
  const worst = [...bins.values()].sort((a, b) => b.skin + b.cap - (a.skin + a.cap)).slice(0, 12);
  return {
    ok: rows.length === 0, target: recipe.name, area: opts.areaText, toneLimit,
    checked: { scatter: checkedScatter, scene: checkedScene, zones: zones.length },
    counts: { skin: skin.length, cap: cap.length, recipe: recipeRows.length, byRule, bySkin },
    zones, worst,
    rows: [...recipeRows, ...skin.sort((a, b) => (b.tone ?? 0) - (a.tone ?? 0)), ...cap],
    ms: Math.round(performance.now() - t0),
  };
}

// ------------------------------------------------------------------ CLI

const opt = (argv: string[], name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

function print(rep: RockSkinReport, list: boolean): void {
  console.log(`rock-skins ${rep.target} (${rep.area}): ${rep.ok ? "ok" : "FAILED"} — ${rep.counts.skin} skin, ${rep.counts.cap} cap, ${rep.counts.recipe} recipe faults; checked ${rep.checked.scatter} scatter + ${rep.checked.scene} scene rocks, ${rep.checked.zones} zones (tone limit ${rep.toneLimit}, ${rep.ms} ms)`);
  for (const z of rep.zones) console.log(`  zone ${z.id}: cliff ${z.cliff ?? "-"} -> skin ${z.skin ?? "-"}${z.tone !== null ? ` (tone ${z.tone})` : ""}`);
  for (const r of rep.rows.filter((q) => q.fault === "recipe")) console.log(`  RECIPE ${r.what} ${r.id}: ${r.detail}`);
  if (Object.keys(rep.counts.byRule).length) console.log(`  by rule: ${Object.entries(rep.counts.byRule).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const w of rep.worst.slice(0, 6)) console.log(`  worst near ${w.at.join(",")}: ${w.skin} skin, ${w.cap} cap`);
  if (list) for (const r of rep.rows.filter((q) => q.fault !== "recipe").slice(0, 60)) console.log(`  ${r.fault.toUpperCase()} ${r.kind} ${r.what} ${r.id} @ ${r.x},${r.y},${r.z}: ${r.detail}`);
}

export function commandRockSkins(host: { argv: string[]; loadRecipe(): { recipe: WorldRecipe; file: string }; fail(m: string): never; writeRecipe?(recipe: WorldRecipe, file: string): void }): RockSkinReport {
  const { argv } = host;
  const { recipe, file } = host.loadRecipe();
  const near = opt(argv, "near"), rectArg = opt(argv, "rect");
  let area: Area | null = null, text = "recipe only";
  if (near) { const v = near.split(",").map(Number); if (v.length !== 3 || !v.every(Number.isFinite)) host.fail("--near wants x,z,r"); area = { near: v as never }; text = `near ${near}`; }
  else if (rectArg) { const v = rectArg.split(",").map(Number); if (v.length !== 4 || !v.every(Number.isFinite)) host.fail("--rect wants x0,z0,x1,z1"); area = { rect: v as never }; text = `rect ${rectArg}`; }
  const stamp = argv.includes("--stamp");
  if (stamp && area) host.fail("--stamp sweeps the whole world; drop --near/--rect");
  const assets = path.dirname(path.dirname(path.resolve(file)));
  const project = path.basename(path.dirname(assets));
  // L (bar-watch 2026-10-21): the scene is named for the WORLD FILE; a place-build lab copies the recipe (name skelmorrow)
  // into world pbbarwatch, so the recipe name found no scene and the lab gate checked 0 scene rocks (a granite ledge passed)
  const byFile = path.join(assets, "scenes", `${path.basename(file).replace(/\.json$/, "")}.scene.json`);
  const sceneFile = opt(argv, "scene") ?? (fs.existsSync(byFile) ? byFile : path.join(assets, "scenes", `${recipe.name}.scene.json`));
  const scene = !argv.includes("--no-scene") && fs.existsSync(sceneFile) ? JSON.parse(fs.readFileSync(sceneFile, "utf8")) : undefined;
  const toneLimit = Number(opt(argv, "tone") ?? 9);
  const field = createWorldField(recipe);
  let rep: RockSkinReport;
  if (stamp) {
    const parts = worldChunks(field).map((rect) => rockSkinsGate({ project, recipe, field, area: { rect }, areaText: "", toneLimit }));
    const whole = rockSkinsGate({ project, recipe, field, area: null, areaText: "whole world", scene, toneLimit });
    for (const p of parts) { whole.rows.push(...p.rows.filter((r) => r.fault !== "recipe")); whole.checked.scatter += p.checked.scatter; whole.counts.skin += p.counts.skin; whole.counts.cap += p.counts.cap; }
    whole.ok = whole.rows.length === 0;
    rep = whole;
  } else rep = rockSkinsGate({ project, recipe, field, area, areaText: text, scene, toneLimit });
  const out = opt(argv, "out");
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rep, null, 1)); }
  if (argv.includes("--json")) console.log(JSON.stringify({ ...rep, rows: rep.rows.slice(0, 50) }));
  else print(rep, argv.includes("--list"));
  if (!rep.ok) process.exitCode = 1;
  if (stamp && rep.ok && host.writeRecipe) { host.writeRecipe(recipe, file); console.log("  stamped stage rock-skins"); }
  return rep;
}

// ------------------------------------------------------------------ the template: zone rock skins

export interface RockSkinPlan {
  /** The recipe's `rockSkins` (stone surface name -> slice). */
  rockSkins: Record<string, number>;
  /** The rock material's `rockCap.bases` after the plan (existing slices kept in place, new ones appended). */
  bases: { map: string; metres?: number; color?: string }[];
  /**
   * The SMALL rock material's bases, parallel to `bases`: a zone stone's slot holds the zone's small-rock tile
   * (`preferSmall[surface]`, else `rock-small.png` beside its cliff tile), every other slot the main slot's own
   * texture; all at 40 texels/m.
   */
  smallBases: { map: string; metres?: number; color?: string }[];
  /**
   * The LARGE rock material's bases, parallel to `bases`: a zone stone's slot holds the zone's boulder tile
   * (`preferLarge[surface]`, else `rock-large.png` beside its cliff tile), every other slot the main slot's own texture;
   * all at 40 texels/m.
   */
  largeBases: { map: string; metres?: number; color?: string }[];
  added: string[];
  /** Stone surfaces left without a slice of their own (no texture, or all eight slices taken). */
  flagged: string[];
}

/** Pixel width of a PNG (IHDR), or 0. */
function pngWidth(file: string | null): number {
  if (!file) return 0;
  try { return fs.readFileSync(file).readUInt32BE(16); } catch { return 0; }
}

/**
 * Every stone surface the world draws (each zone's `ground.cliff` and the base palette's cliff-role surfaces) gets a
 * body slice of the world's rock material: `prefer[surface]` (a zone's own rock texture, e.g. a palette's `rock`), else
 * a `rock.png` beside a zone's cliff tile, else the cliff tile itself, at the 40 texels/m standard. A slice already carrying
 * that texture is reused, so the plan is idempotent and never reorders slices.
 */
/** The fields rock-skins install owns, laid onto a FRESH read of the recipe (rockSkins + each scatter rule's small/large material by
 *  id). install plans for seconds on its own read; writing that stale copy back dropped every feature another tool added meanwhile
 *  (widows-arch's 551 passages/operators/paints, 2026-10-21). Mutates and returns `fresh`. */
/**
 * A rule's `rockBaseByCliff` with the stones this world does not have taken out; undefined (the rule follows the world's
 * `rockSkins`) when what is left names none of its own stones, only "*" or the generic "cliff": a map copied from
 * another world sent every rock of the rule to its "*" slice (redstrand cliff-buttress: proving's map, 2026-10-29).
 */
export function ownRockBaseByCliff(map: Record<string, number> | undefined, names: readonly string[]): Record<string, number> | undefined {
  if (!map) return undefined;
  const kept = Object.fromEntries(Object.entries(map).filter(([k]) => k === "*" || names.includes(k)));
  return Object.keys(kept).some((k) => k !== "*" && k !== "cliff") ? kept : undefined;
}
export function mergeRockSkinFields(fresh: any, mine: any): any {
  fresh.rockSkins = mine.rockSkins;
  const byId = new Map<string, any>((mine.scatter ?? []).map((r: any) => [r.id, r]));
  for (const r of fresh.scatter ?? []) {
    const m = byId.get(r.id);
    if (!m) continue;
    for (const k of ["smallMaterial", "largeMaterial", "rockBaseByCliff"]) { if (m[k] === undefined) delete r[k]; else r[k] = m[k]; }
  }
  return fresh;
}
/**
 * The rock tile that goes with a cliff tile: `<prefix>${file}` beside `<prefix>cliff.png` (a corridor's
 * `gorge-cliff.png` -> `gorge-rock-small.png`), else null (the caller falls back to the folder's plain `${file}`).
 */
export function siblingTile(project: string, cliffMap: string, file: string): string | null {
  const base = path.posix.basename(cliffMap);
  const m = /^(.+-)cliff.png$/.exec(base);
  if (!m) return null;
  const t = `${path.posix.dirname(cliffMap)}/${m[1]}${file}`;
  return findAsset(project, `textures/${t}`) ? t : null;
}

export function planRockSkins(project: string, recipe: WorldRecipe, bases: readonly { map: string; metres?: number; color?: string }[], prefer: Record<string, string> = {}, preferSmall: Record<string, string> = {}, preferLarge: Record<string, string> = {}, assign: Record<string, number> = {}): RockSkinPlan {
  const out = bases.map((b) => ({ ...b }));
  const rockSkins: Record<string, number> = { ...((recipe as { rockSkins?: Record<string, number> }).rockSkins ?? {}) };
  const added: string[] = [], flagged: string[] = [];
  // a stone the recipe no longer has (a world made with `init --from` inherits its source's zone cliffs: firstshore kept
  // proving's five, pointing at slices its own material never had) is dropped, so it cannot hold or alias a slice
  for (const name of Object.keys(rockSkins))
    if (name !== "*" && !recipe.surfaces.some((q) => q.name === name)) {
      delete rockSkins[name];
      added.push(`${name}: dropped (no such surface in the recipe)`);
    }
  // a stone ASSIGNED a slice (the 8 slices are full: a corridor's own stone reclaims one whose stone the world hardly
  // draws, by ruling): that slice takes its texture; every other stone on the slice now wears it (reported)
  for (const [name, slice] of Object.entries(assign)) {
    const s = recipe.surfaces.find((q) => q.name === name) as { map?: string } | undefined;
    const texture = prefer[name] ?? s?.map;
    if (!texture || !Number.isInteger(slice) || slice < 0 || slice >= 8) { flagged.push(`${name}: cannot assign slice ${slice}`); continue; }
    while (out.length <= slice) out.push({ ...out[0]! });
    if (out[slice]!.map !== texture) {
      const px = pngWidth(findAsset(project, `textures/${texture}`)) || 256;
      const others = Object.entries(rockSkins).filter(([n, v]) => v === slice && n !== name).map(([n]) => n);
      added.push(`${name} -> ${texture} (slice ${slice} reclaimed from ${out[slice]!.map}${others.length ? `; ${others.join(", ")} now wear it` : ""})`);
      out[slice] = { map: texture, metres: Math.round((px / 40) * 10) / 10 };
    }
    rockSkins[name] = slice;
  }
  const stones: string[] = [];
  for (const r of (recipe as { regions?: any[] }).regions ?? []) if (r.ground?.cliff && !stones.includes(r.ground.cliff)) stones.push(r.ground.cliff);
  const zoneStones = new Set(stones);
  for (const s of recipe.surfaces) if (((s as { role?: string }).role === "cliff" || s.name === "rock" || s.name === "cliff") && !stones.includes(s.name)) stones.push(s.name);
  for (const name of stones) {
    if (assign[name] !== undefined) continue;
    const s = recipe.surfaces.find((q) => q.name === name) as { map?: string } | undefined;
    if (!s?.map) { flagged.push(`${name}: no texture to derive a rock skin from`); continue; }
    const sibling = siblingTile(project, s.map, "rock.png") ?? `${path.posix.dirname(s.map)}/rock.png`;
    // a zone's own folder may carry a dedicated rock skin beside its cliff tile (never a shared folder: mmo/Rock.png is no zone's)
    const texture = prefer[name] ?? (zoneStones.has(name) && s.map.includes("/") && findAsset(project, `textures/${sibling}`) ? sibling : s.map);
    let slice = out.findIndex((b) => b.map === texture);
    if (slice < 0 && rockSkins[name] !== undefined && Object.values(assign).includes(rockSkins[name]!)) continue; // its slice was reclaimed: keeps it
    if (slice < 0) {
      if (out.length >= 8) { flagged.push(`${name}: the rock material has no free slice (8 bases) for ${texture}`); continue; }
      const px = pngWidth(findAsset(project, `textures/${texture}`)) || 256;
      out.push({ map: texture, metres: Math.round((px / 40) * 10) / 10 });
      slice = out.length - 1;
      added.push(`${name} -> ${texture} (slice ${slice}, ${out[slice]!.metres} m/tile)`);
    }
    rockSkins[name] = slice;
  }
  // the small and large materials: the same slots, each zone stone's grainy small-rock tile / boulder tile in place
  // of its cliff tile
  const atTexel = (map: string, color?: string) => ({ map, metres: Math.round(((pngWidth(findAsset(project, `textures/${map}`)) || 256) / SMALL_TEXEL) * 10) / 10, ...(color ? { color } : {}) });
  const variant = (file: string, preferred: Record<string, string>, what: string) => {
    const vb = out.map((b) => atTexel(b.map, b.color));
    const claimed = new Map<number, string>();
    for (const name of stones) {
      if (!zoneStones.has(name) || rockSkins[name] === undefined) continue;
      const s = recipe.surfaces.find((q) => q.name === name) as { map?: string } | undefined;
      const sibling = s?.map && s.map.includes("/") ? (siblingTile(project, s.map, file) ?? `${path.posix.dirname(s.map)}/${file}`) : null;
      const tile = preferred[name] ?? (sibling && findAsset(project, `textures/${sibling}`) ? sibling : null);
      const slice = rockSkins[name]!;
      if (!tile) { flagged.push(`${name}: no ${what} tile (draw ${sibling ?? `<zone>/${file}`}): its ${what === "small-rock" ? "small rocks" : "boulders"} wear ${out[slice]!.map}`); continue; }
      if (claimed.has(slice) && claimed.get(slice) !== tile) { flagged.push(`${name}: slice ${slice} already takes ${claimed.get(slice)} for its ${what} tile`); continue; }
      claimed.set(slice, tile);
      vb[slice] = atTexel(tile);
    }
    return vb;
  };
  const smallBases = variant("rock-small.png", preferSmall, "small-rock");
  const largeBases = variant("rock-large.png", preferLarge, "large-rock");
  return { rockSkins, bases: out, smallBases, largeBases, added, flagged };
}

/** The small rock material's id beside a main rock material's: `<id>-small`. */
export const smallRockMaterialId = (id: string): string => `${id}-small`;

/**
 * Write the world's SMALL rock material (a copy of the main one with `smallBases`) beside the main material's file and
 * point every rule that draws with the main material at it (`smallMaterial`, in `rules`). Returns the file written, or
 * null when it was already right.
 */
export function writeSmallRockMaterial(material: { id: string; file: string; doc: any }, smallBases: RockSkinPlan["smallBases"], rules: { material?: string; smallMaterial?: string }[]): { id: string; file: string; wrote: boolean; rules: string[] } {
  const { id, file, wrote } = writeVariantMaterial(material, smallBases, "small");
  const changed: string[] = [];
  for (const r of rules) if (r.material === material.id && r.smallMaterial !== id) { r.smallMaterial = id; changed.push((r as { id?: string }).id ?? "?"); }
  return { id, file, wrote, rules: changed };
}

/** The large rock material's id beside a main rock material's: `<id>-large`. */
export const largeRockMaterialId = (id: string): string => `${id}-large`;

/** The file of a main rock material's `-small` / `-large` sibling. */
export const variantMaterialFile = (material: { id: string; file: string }, kind: "small" | "large"): string => path.join(path.dirname(material.file), `${path.basename(material.id)}-${kind}.json`);

/** A variant rock material's text: the main material's doc with its own bases. */
export const variantMaterialText = (doc: any, bases: RockSkinPlan["bases"]): string => JSON.stringify({ ...doc, rockCap: { ...doc.rockCap, bases } }, null, 2) + "\n";

function writeVariantMaterial(material: { id: string; file: string; doc: any }, bases: RockSkinPlan["bases"], kind: "small" | "large"): { id: string; file: string; wrote: boolean } {
  const id = `${material.id}-${kind}`;
  const file = variantMaterialFile(material, kind);
  const text = variantMaterialText(material.doc, bases);
  const wrote = !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text;
  if (wrote) fs.writeFileSync(file, text);
  return { id, file, wrote };
}

/**
 * Write the world's LARGE rock material (a copy of the main one with `largeBases`) beside the main material's file and
 * point every FREE-STANDING rule that draws with the main material at it (`largeMaterial`); a rule placed on cliffs
 * (`cliff`) is the cliff face and loses any `largeMaterial` it had (listed as "-<id>").
 */
export function writeLargeRockMaterial(material: { id: string; file: string; doc: any }, largeBases: RockSkinPlan["largeBases"], rules: { material?: string; largeMaterial?: string; cliff?: unknown }[]): { id: string; file: string; wrote: boolean; rules: string[] } {
  const { id, file, wrote } = writeVariantMaterial(material, largeBases, "large");
  const changed: string[] = [];
  for (const r of rules) {
    if (r.material !== material.id) continue;
    if (r.cliff) { if (r.largeMaterial !== undefined) { delete r.largeMaterial; changed.push(`-${(r as { id?: string }).id ?? "?"}`); } }
    else if (r.largeMaterial !== id) { r.largeMaterial = id; changed.push((r as { id?: string }).id ?? "?"); }
  }
  return { id, file, wrote, rules: changed };
}

/** The rock-cap material the world's scatter draws with, when it lives in `project` itself (so it may be written). */
export function ownRockMaterial(project: string, recipe: WorldRecipe): { id: string; file: string; doc: any } | null {
  for (const rule of recipe.scatter) {
    const id = (rule as { material?: string }).material;
    if (!id) continue;
    const file = findAsset(project, `materials/${id}.json`);
    if (!file) continue;
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc.shader !== "rock-cap") continue;
    return path.resolve(file).startsWith(path.resolve(projectsRoot(), project) + path.sep) ? { id, file, doc } : null;
  }
  return null;
}

/**
 * The template step (`worldgen init`, `zone-textures`): plan the skins onto the recipe (in memory) and write the
 * world's own rock material when its bases change. Prints what it did; returns the plan.
 */
export function writeRockSkinTemplate(project: string, recipe: WorldRecipe, prefer: Record<string, string> = {}, preferSmall: Record<string, string> = {}, preferLarge: Record<string, string> = {}, assign: Record<string, number> = {}): RockSkinPlan | null {
  const material = project ? ownRockMaterial(project, recipe) : null;
  if (!material) return null;
  const plan = planRockSkins(project, recipe, material.doc.rockCap.bases, prefer, preferSmall, preferLarge, assign);
  (recipe as { rockSkins?: Record<string, number> }).rockSkins = plan.rockSkins;
  if (JSON.stringify(material.doc.rockCap.bases) !== JSON.stringify(plan.bases)) {
    material.doc.rockCap.bases = plan.bases;
    fs.writeFileSync(material.file, JSON.stringify(material.doc, null, 2) + "\n");
  }
  writeSmallRockMaterial(material, plan.smallBases, recipe.scatter as never);
  writeLargeRockMaterial(material, plan.largeBases, recipe.scatter as never);
  console.log(`rock skins: ${Object.entries(plan.rockSkins).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}${plan.added.length ? `; added ${plan.added.join("; ")}` : ""}${plan.flagged.length ? `; ! ${plan.flagged.join("; ")}` : ""}`);
  return plan;
}

// ------------------------------------------------------------------ CLI (install / undo / chunks)

function readRecipe(file: string): WorldRecipe { return worldRecipeSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))); }

function main(argv: string[]): void {
  const fail = (m: string): never => { console.error(m); process.exit(2); };
  const cmd = argv[0];
  const project = argv[1] ?? fail("usage: rock-skins install|undo|chunks <project> ...");
  const world = opt(argv, "world") ?? project;
  const recipeFile = findAsset(project, `worlds/${world}.json`) ?? fail(`no world ${world} in ${project}'s closure`);
  const sceneFile = opt(argv, "scene") ?? path.join(path.dirname(path.dirname(recipeFile)), "scenes", `${world}.scene.json`);
  if (cmd === "chunks") {
    // rock-skins chunks <project> --world w --dir <out> [--from i] [--budget-s 200]: one heavy-lock job, one JSON per chunk
    const recipe = readRecipe(recipeFile);
    const field = createWorldField(recipe);
    const dir = opt(argv, "dir") ?? fail("--dir <out dir>");
    fs.mkdirSync(dir, { recursive: true });
    const chunks = worldChunks(field);
    const budget = Number(opt(argv, "budget-s") ?? 200) * 1000, t0 = Date.now();
    let i = Number(opt(argv, "from") ?? 0);
    for (; i < chunks.length && Date.now() - t0 < budget; i++) {
      const rep = rockSkinsGate({ project, recipe, field, area: { rect: chunks[i]! }, areaText: `rect ${chunks[i]!.join(",")}`, toneLimit: Number(opt(argv, "tone") ?? 9) });
      fs.writeFileSync(path.join(dir, `chunk-${String(i).padStart(4, "0")}.json`), JSON.stringify({ rect: chunks[i], ...rep, rows: rep.rows.filter((r) => r.fault !== "recipe") }));
    }
    console.log(JSON.stringify({ next: i, total: chunks.length }));
    return;
  }
  if (cmd === "install") {
    // rock-skins install <project> --world w [--prefer surface=texture,...] [--prefer-small surface=texture,...] [--prefer-large surface=texture,...] [--inverse f] [--dry]
    const kv = (s: string | undefined) => Object.fromEntries((s ?? "").split(",").filter(Boolean).map((p) => p.split("=") as [string, string]));
    const prefer = kv(opt(argv, "prefer")), preferSmall = kv(opt(argv, "prefer-small")), preferLarge = kv(opt(argv, "prefer-large"));
    const raw = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
    const recipe = readRecipe(recipeFile);
    const material = ownRockMaterial(project, recipe) ?? fail(`${world}: no rock-cap material of ${project}'s own to write`);
    const smallFile = variantMaterialFile(material, "small"), largeFile = variantMaterialFile(material, "large");
    const before = {
      rockSkins: raw.rockSkins ?? null, bases: JSON.parse(JSON.stringify(material.doc.rockCap.bases)), scene: [] as unknown[],
      smallMaterial: fs.existsSync(smallFile) ? fs.readFileSync(smallFile, "utf8") : null,
      smallRules: Object.fromEntries((raw.scatter ?? []).map((r: any) => [r.id, r.smallMaterial ?? null])),
      largeMaterial: fs.existsSync(largeFile) ? fs.readFileSync(largeFile, "utf8") : null,
      largeRules: Object.fromEntries((raw.scatter ?? []).map((r: any) => [r.id, r.largeMaterial ?? null])),
    };
    const plan = planRockSkins(project, recipe, material.doc.rockCap.bases, prefer, preferSmall, preferLarge);
    console.log(`rock skins for ${world}: ${Object.entries(plan.rockSkins).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    for (const a of plan.added) console.log(`  + ${a}`);
    for (const f of plan.flagged) console.log(`  ! ${f}`);
    const palFaults = paletteSkinFaults(recipe, plan.rockSkins, plan.bases, plan.smallBases, plan.largeBases);
    for (const f of palFaults) console.log(`  PALETTE ${f}`);
    if (palFaults.length && !argv.includes("--allow-off-palette")) fail(`rock-skins install REFUSED: ${palFaults.length} slice(s) outside a zone palette (regions[].palette; --allow-off-palette with a ruling)`);
    console.log(`  small rocks (< ${SMALL_ROCK_METRES} m): ${plan.smallBases.map((b, i) => (b.map !== plan.bases[i]!.map ? `${i}=${b.map}` : null)).filter(Boolean).join(", ") || "(no zone small-rock tiles)"}`);
    console.log(`  large rocks (${SMALL_ROCK_METRES}-${LARGE_ROCK_MAX_METRES} m, free-standing): ${plan.largeBases.map((b, i) => (b.map !== plan.bases[i]!.map ? `${i}=${b.map}` : null)).filter(Boolean).join(", ") || "(no zone large-rock tiles)"}`);
    // the scene's placed rocks, under the NEW table (a field built from the planned recipe) and the small/large materials
    const smallId = smallRockMaterialId(material.id), largeId = largeRockMaterialId(material.id);
    const planned = { ...recipe, rockSkins: plan.rockSkins, scatter: recipe.scatter.map((r) => (r.material === material.id ? { ...r, smallMaterial: smallId, ...(r.cliff ? { largeMaterial: undefined } : { largeMaterial: largeId }) } : r)) } as WorldRecipe;
    const scene = fs.existsSync(sceneFile) ? JSON.parse(fs.readFileSync(sceneFile, "utf8")) : null;
    // --rect x0,z0,x1,z1: skin only the placed rocks there (a corridor install leaves the rest of the scene to its owners)
    const rect = opt(argv, "rect")?.split(",").map(Number) as [number, number, number, number] | undefined;
    const only = scene && rect ? new Set(placedRocks(project, scene).filter((r) => inArea({ rect }, r.x, r.z)).map((r) => r.id)) : undefined;
    const skin = scene ? skinPlacedOps(project, scene, createWorldField(planned), only) : { ops: [], changed: [] };
    console.log(`  scene: ${skin.changed.length} placed rock(s) to skin${rect ? `: ${skin.changed.join(", ")}` : ""}`);
    const planDoc = { ...material.doc, rockCap: { ...material.doc.rockCap, bases: plan.bases } };
    const smallSame = before.smallMaterial === variantMaterialText(planDoc, plan.smallBases) && (raw.scatter ?? []).every((r: any) => r.material !== material.id || r.smallMaterial === smallId);
    const largeSame = before.largeMaterial === variantMaterialText(planDoc, plan.largeBases) && (raw.scatter ?? []).every((r: any) => r.material !== material.id || (r.cliff ? r.largeMaterial === undefined : r.largeMaterial === largeId));
    const surfaceNames = recipe.surfaces.map((q) => q.name);
    let byCliffChanged = 0;
    for (const r of raw.scatter ?? []) {
      const own = ownRockBaseByCliff(r.rockBaseByCliff, surfaceNames);
      if (JSON.stringify(own) === JSON.stringify(r.rockBaseByCliff)) continue;
      byCliffChanged++;
      console.log(`  ${r.id}: rockBaseByCliff ${own ? `-> ${JSON.stringify(own)}` : "dropped (follows rockSkins)"}`);
      if (own) r.rockBaseByCliff = own; else delete r.rockBaseByCliff;
    }
    const same = !byCliffChanged && JSON.stringify(raw.rockSkins ?? null) === JSON.stringify(plan.rockSkins) && JSON.stringify(before.bases) === JSON.stringify(plan.bases) && smallSame && largeSame;
    if (same && !skin.ops.length) { console.log("  nothing to do (already installed)"); return; }
    if (argv.includes("--dry")) { console.log("  DRY RUN: nothing written"); return; }
    raw.rockSkins = plan.rockSkins;
    const small = writeSmallRockMaterial({ ...material, doc: planDoc }, plan.smallBases, raw.scatter ?? []);
    if (small.rules.length) console.log(`  smallMaterial ${small.id} on ${small.rules.length} rule(s): ${small.rules.join(", ")}`);
    const large = writeLargeRockMaterial({ ...material, doc: planDoc }, plan.largeBases, raw.scatter ?? []);
    if (large.rules.length) console.log(`  largeMaterial ${large.id} on ${large.rules.length} rule(s): ${large.rules.join(", ")}`);
    // onto a FRESH read: another tool may have written the recipe while this one planned
    updateJsonFile(recipeFile, (fresh) => ({ doc: mergeRockSkinFields(fresh, raw) }), { label: "rock-skins install" }); // under the recipe's lock
    material.doc.rockCap.bases = plan.bases;
    fs.writeFileSync(material.file, JSON.stringify(material.doc, null, 2) + "\n");
    if (scene && skin.ops.length) {
      const reg = new ComponentRegistry();
      registerCoreComponents(reg);
      // fresh read under the scene's lock (tools/_scene-write.mts): same race as the recipe
      let res: ReturnType<typeof applyOps>;
      try { res = applyOpsToSceneFile(sceneFile, skin.ops, (d, o) => applyOps(d, o as never, reg), { label: "rock-skins install", indent: 2, trailer: "" }); }
      catch (e) { fail(`rock-skins: ${(e as Error).message}: re-run`); }
      before.scene = res.inverse as unknown[];
    }
    const inv = opt(argv, "inverse");
    // keep the FIRST inverse: a re-run must still undo to the pre-install state
    if (inv && !fs.existsSync(inv)) { fs.mkdirSync(path.dirname(inv), { recursive: true }); fs.writeFileSync(inv, JSON.stringify(before, null, 1)); }
    console.log(`  wrote ${path.relative(process.cwd(), recipeFile)}, ${path.relative(process.cwd(), material.file)}${scene && skin.ops.length ? `, ${path.relative(process.cwd(), sceneFile)}` : ""}${inv ? `; inverse ${inv}` : ""}`);
    return;
  }
  if (cmd === "undo") {
    const inv = opt(argv, "inverse") ?? fail("undo needs --inverse <file>");
    if (!fs.existsSync(inv)) { console.log(`rock-skins undo: no ${inv} (not installed)`); return; }
    const before = JSON.parse(fs.readFileSync(inv, "utf8"));
    const material = ownRockMaterial(project, readRecipe(recipeFile));
    updateJsonFile(recipeFile, (raw: any) => { // one read-modify-write under the recipe's lock (tools/_scene-write.mts)
      if (before.rockSkins === null) delete raw.rockSkins;
      else raw.rockSkins = before.rockSkins;
      if (before.smallRules) for (const r of raw.scatter ?? []) if (r.id in before.smallRules) { if (before.smallRules[r.id] === null) delete r.smallMaterial; else r.smallMaterial = before.smallRules[r.id]; }
      if (before.largeRules) for (const r of raw.scatter ?? []) if (r.id in before.largeRules) { if (before.largeRules[r.id] === null) delete r.largeMaterial; else r.largeMaterial = before.largeRules[r.id]; }
      return { doc: raw };
    }, { label: "rock-skins undo" });
    if (material && before.bases) { material.doc.rockCap.bases = before.bases; fs.writeFileSync(material.file, JSON.stringify(material.doc, null, 2) + "\n"); }
    for (const kind of ["small", "large"] as const) {
      const key = `${kind}Material`;
      if (!material || !(key in before)) continue;
      const file = variantMaterialFile(material, kind);
      if (before[key] === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, before[key]);
    }
    if (before.scene?.length && fs.existsSync(sceneFile)) {
      const reg = new ComponentRegistry();
      registerCoreComponents(reg);
      applyOpsToSceneFile(sceneFile, before.scene, (d, o) => applyOps(d, o as never, reg), { label: "rock-skins undo", trailer: "" });
    }
    fs.rmSync(inv);
    console.log(`rock-skins undo: restored ${world}'s rockSkins, rock material bases${before.scene?.length ? " and placed rocks" : ""}`);
    return;
  }
  fail("usage: rock-skins install <project> [--world w] [--prefer s=tex] [--prefer-small s=tex] [--prefer-large s=tex] [--inverse f] [--dry] | undo <project> --inverse f | chunks <project> --dir d");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));

/**
 * The zone palette (regions[].palette) against a rock-skin table: each zone's cliff slice must wear one of its palette
 * cliff tiles, its small-rock slot one of `rockSmall`, its large-rock slot one of `rockLarge` (an empty list = not
 * declared, not checked). `rock-skins install` refuses a plan with any; the gate lists them as recipe faults.
 */
export function paletteSkinFaults(recipe: WorldRecipe, rockSkins: Record<string, number> | undefined, bases: readonly { map: string }[], smallBases?: readonly { map: string }[], largeBases?: readonly { map: string }[]): string[] {
  const out: string[] = [];
  const regions = ((recipe as { regions?: any[] }).regions ?? []).filter((r) => !r.within);
  const mapOf = (n: string) => (recipe.surfaces.find((s) => s.name === n) as { map?: string } | undefined)?.map ?? n;
  for (const r of regions) {
    const p = zonePalette(recipe, r.id);
    const cliff = r.ground?.cliff as string | undefined;
    if (!p || !cliff || !rockSkins) continue;
    const slice = rockSkins[cliff] ?? rockSkins["*"];
    if (slice === undefined) continue;
    const okCliff = new Set(p.cliff.flatMap((n) => [n, mapOf(n)]));
    const main = bases[slice]?.map;
    if (p.cliff.length && main && !okCliff.has(main)) out.push(`${r.id}: rock skin ${main} (slice ${slice}) is not a palette cliff tile [${p.cliff.map(mapOf).join(", ")}]`);
    const small = smallBases?.[slice]?.map;
    if (p.rockSmall.length && small && !p.rockSmall.includes(small)) out.push(`${r.id}: small-rock slot ${small} not in palette rockSmall [${p.rockSmall.join(", ")}]`);
    const large = largeBases?.[slice]?.map;
    if (p.rockLarge.length && large && !p.rockLarge.includes(large)) out.push(`${r.id}: large-rock slot ${large} not in palette rockLarge [${p.rockLarge.join(", ")}]`);
  }
  return out;
}
