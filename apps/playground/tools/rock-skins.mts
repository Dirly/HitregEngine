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
 */
import fs from "node:fs";
import path from "node:path";
import { applyOps, ComponentRegistry, createRockCapResolver, createWorldField, registerCoreComponents, rockSkinProbe, scatterCell, worldRecipeSchema, type WorldField, type WorldRecipe } from "@hitreg/core";
import { fileURLToPath } from "node:url";
import { decodePng } from "./_png.mjs";
import { findAsset } from "./_closure.mjs";
import { worldChunks } from "./float.mts";

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

interface RockMaterial { id: string; bases: { map: string; color?: string }[]; tones: ([number, number, number] | null)[] }

/** The rock-cap materials the world's scatter rules draw with (by asset id). */
function rockMaterials(project: string, recipe: WorldRecipe, override?: readonly { map: string; color?: string }[]): Map<string, RockMaterial> {
  const out = new Map<string, RockMaterial>();
  for (const rule of recipe.scatter) {
    const id = (rule as { material?: string }).material;
    if (!id || out.has(id)) continue;
    const file = findAsset(project, `materials/${id}.json`);
    if (!file) continue;
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc.shader !== "rock-cap" || !doc.rockCap?.bases) continue;
    const bases = (override ?? doc.rockCap.bases) as { map: string; color?: string }[];
    out.set(id, { id, bases, tones: bases.map((b) => textureMean(project, b.map, b.color && b.color !== "#ffffff" ? b.color : undefined)) });
  }
  return out;
}

// ------------------------------------------------------------------ placed rocks (scenes)

export interface PlacedRock {
  id: string;
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
      out.push({ id, what: pf.prefabId, prefabId: pf.prefabId, root: p.root, x, y, z, material, rockCap, modelBase: material ? null : modelBaseOf(project, p.mesh.source?.assetId ?? "") });
      continue;
    }
    const mesh = e.components?.mesh;
    if (!mesh?.source?.rockCap) continue;
    const [x, y, z] = worldPosition(ents, id);
    out.push({ id, what: String(mesh.source.assetId ?? e.name ?? id), prefabId: null, root: null, x, y, z, material: mesh.material ?? null, rockCap: mesh.source.rockCap, modelBase: null });
  }
  return out;
}

/**
 * The ops that give placed rocks their place's skin and cap: each rock-kit prefab instance draws with the world's
 * rock material (the one its scatter rocks use: one batch per model, the skin rides per instance) and carries the
 * rockCap the scatter resolver gives a rock at that spot. Idempotent: an instance already right gets no op.
 * `ids` limits it to freshly placed entities (dress apply).
 */
export function skinPlacedOps(project: string, scene: any, field: WorldField, ids?: ReadonlySet<string>): { ops: any[]; changed: string[] } {
  const recipe = field.recipe;
  const template = recipe.scatter.find((r) => r.cap && (r as { material?: string }).material && rockMaterials(project, recipe).has((r as { material?: string }).material!));
  if (!template) return { ops: [], changed: [] };
  const material = (template as { material?: string }).material!;
  const rule = { ...template, cap: "auto", capAmount: 0.6 } as typeof template;
  const resolve = createRockCapResolver(field);
  const ops: any[] = [], changed: string[] = [];
  const ents = scene.entities as Record<string, any>;
  for (const r of placedRocks(project, scene)) {
    if (!r.prefabId || !r.root || (ids && !ids.has(r.id))) continue;
    const cap = resolve(rule, r.x, r.y, r.z);
    if (!cap) continue;
    const want: Record<string, unknown> = { [`${r.root}/components/mesh/material`]: material, [`${r.root}/components/mesh/source/rockCap`]: cap };
    const pf = ents[r.id].components.prefab;
    const overrides = [...(pf.overrides ?? [])] as { path: string; value: unknown }[];
    let dirty = false;
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

export function rockSkinsGate(opts: { project: string; recipe: WorldRecipe; field?: WorldField; area: Area | null; areaText: string; scene?: any; toneLimit?: number; /** Rock material bases to judge with instead of the file's (a plan not yet written). */ bases?: readonly { map: string; color?: string }[]; /** scatterCell results by "cx,cz", shared with a caller sweeping the same field. */ cells?: Map<string, ReturnType<typeof scatterCell>> }): RockSkinReport {
  const t0 = performance.now();
  const { project, recipe } = opts;
  const toneLimit = opts.toneLimit ?? 9;
  const field = opts.field ?? createWorldField(recipe);
  const probe = rockSkinProbe(field);
  const names = recipe.surfaces.map((s) => s.name);
  const surfaceTone = (i: number) => textureMean(project, (recipe.surfaces[i] as { map?: string }).map, (recipe.surfaces[i] as { map?: string }).map ? undefined : (recipe.surfaces[i] as { color?: string }).color);
  const materials = rockMaterials(project, recipe, opts.bases);
  const mainMaterial = [...materials.values()][0] ?? null;
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
  const judge = (kind: "scatter" | "scene", what: string, id: string, x: number, y: number, z: number, cap: { layer?: number; amount?: number; base?: number }, material: RockMaterial | null, inWater?: { x: number; z: number }) => {
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
      const g = probe.groundBand(x, y, z);
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
            judge("scatter", rule.id, inst.id, x, inst.position[1], z, inst.rockCap, materials.get((rule as { material?: string }).material ?? "") ?? null, wet);
          }
        }
    }
  }

  // ---- rocks placed in the world's scene (POIs): rock-kit prefab instances and meshes with a rockCap
  if (opts.scene) {
    for (const r of placedRocks(project, opts.scene)) {
      if (opts.area && !inArea(opts.area, r.x, r.z)) continue;
      checkedScene++;
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
  const sceneFile = opt(argv, "scene") ?? path.join(assets, "scenes", `${recipe.name}.scene.json`);
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
export function planRockSkins(project: string, recipe: WorldRecipe, bases: readonly { map: string; metres?: number; color?: string }[], prefer: Record<string, string> = {}): RockSkinPlan {
  const out = bases.map((b) => ({ ...b }));
  const rockSkins: Record<string, number> = { ...((recipe as { rockSkins?: Record<string, number> }).rockSkins ?? {}) };
  const added: string[] = [], flagged: string[] = [];
  const stones: string[] = [];
  for (const r of (recipe as { regions?: any[] }).regions ?? []) if (r.ground?.cliff && !stones.includes(r.ground.cliff)) stones.push(r.ground.cliff);
  const zoneStones = new Set(stones);
  for (const s of recipe.surfaces) if (((s as { role?: string }).role === "cliff" || s.name === "rock" || s.name === "cliff") && !stones.includes(s.name)) stones.push(s.name);
  for (const name of stones) {
    const s = recipe.surfaces.find((q) => q.name === name) as { map?: string } | undefined;
    if (!s?.map) { flagged.push(`${name}: no texture to derive a rock skin from`); continue; }
    const sibling = `${path.posix.dirname(s.map)}/rock.png`;
    // a zone's own folder may carry a dedicated rock skin beside its cliff tile (never a shared folder: mmo/Rock.png is no zone's)
    const texture = prefer[name] ?? (zoneStones.has(name) && s.map.includes("/") && findAsset(project, `textures/${sibling}`) ? sibling : s.map);
    let slice = out.findIndex((b) => b.map === texture);
    if (slice < 0) {
      if (out.length >= 8) { flagged.push(`${name}: the rock material has no free slice (8 bases) for ${texture}`); continue; }
      const px = pngWidth(findAsset(project, `textures/${texture}`)) || 256;
      out.push({ map: texture, metres: Math.round((px / 40) * 10) / 10 });
      slice = out.length - 1;
      added.push(`${name} -> ${texture} (slice ${slice}, ${out[slice]!.metres} m/tile)`);
    }
    rockSkins[name] = slice;
  }
  return { rockSkins, bases: out, added, flagged };
}

const PROJECTS_DIR = path.resolve(import.meta.dirname, "..", "projects");

/** The rock-cap material the world's scatter draws with, when it lives in `project` itself (so it may be written). */
export function ownRockMaterial(project: string, recipe: WorldRecipe): { id: string; file: string; doc: any } | null {
  for (const rule of recipe.scatter) {
    const id = (rule as { material?: string }).material;
    if (!id) continue;
    const file = findAsset(project, `materials/${id}.json`);
    if (!file) continue;
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (doc.shader !== "rock-cap") continue;
    return path.resolve(file).startsWith(path.resolve(PROJECTS_DIR, project) + path.sep) ? { id, file, doc } : null;
  }
  return null;
}

/**
 * The template step (`worldgen init`, `zone-textures`): plan the skins onto the recipe (in memory) and write the
 * world's own rock material when its bases change. Prints what it did; returns the plan.
 */
export function writeRockSkinTemplate(project: string, recipe: WorldRecipe, prefer: Record<string, string> = {}): RockSkinPlan | null {
  const material = project ? ownRockMaterial(project, recipe) : null;
  if (!material) return null;
  const plan = planRockSkins(project, recipe, material.doc.rockCap.bases, prefer);
  (recipe as { rockSkins?: Record<string, number> }).rockSkins = plan.rockSkins;
  if (JSON.stringify(material.doc.rockCap.bases) !== JSON.stringify(plan.bases)) {
    material.doc.rockCap.bases = plan.bases;
    fs.writeFileSync(material.file, JSON.stringify(material.doc, null, 2) + "\n");
  }
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
    // rock-skins install <project> --world w [--prefer surface=texture,...] [--inverse f] [--dry]
    const prefer = Object.fromEntries((opt(argv, "prefer") ?? "").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]));
    const raw = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
    const recipe = readRecipe(recipeFile);
    const material = ownRockMaterial(project, recipe) ?? fail(`${world}: no rock-cap material of ${project}'s own to write`);
    const before = { rockSkins: raw.rockSkins ?? null, bases: JSON.parse(JSON.stringify(material.doc.rockCap.bases)), scene: [] as unknown[] };
    const plan = planRockSkins(project, recipe, material.doc.rockCap.bases, prefer);
    console.log(`rock skins for ${world}: ${Object.entries(plan.rockSkins).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    for (const a of plan.added) console.log(`  + ${a}`);
    for (const f of plan.flagged) console.log(`  ! ${f}`);
    // the scene's placed rocks, under the NEW table (a field built from the planned recipe)
    const scene = fs.existsSync(sceneFile) ? JSON.parse(fs.readFileSync(sceneFile, "utf8")) : null;
    const skin = scene ? skinPlacedOps(project, scene, createWorldField({ ...recipe, rockSkins: plan.rockSkins } as WorldRecipe)) : { ops: [], changed: [] };
    console.log(`  scene: ${skin.changed.length} placed rock(s) to skin`);
    const same = JSON.stringify(raw.rockSkins ?? null) === JSON.stringify(plan.rockSkins) && JSON.stringify(before.bases) === JSON.stringify(plan.bases);
    if (same && !skin.ops.length) { console.log("  nothing to do (already installed)"); return; }
    if (argv.includes("--dry")) { console.log("  DRY RUN: nothing written"); return; }
    raw.rockSkins = plan.rockSkins;
    fs.writeFileSync(recipeFile, JSON.stringify(raw, null, 2) + "\n");
    material.doc.rockCap.bases = plan.bases;
    fs.writeFileSync(material.file, JSON.stringify(material.doc, null, 2) + "\n");
    if (scene && skin.ops.length) {
      const reg = new ComponentRegistry();
      registerCoreComponents(reg);
      const res = applyOps(scene, skin.ops as never, reg);
      fs.writeFileSync(sceneFile, JSON.stringify(res.doc, null, 2));
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
    const raw = JSON.parse(fs.readFileSync(recipeFile, "utf8"));
    const material = ownRockMaterial(project, readRecipe(recipeFile));
    if (before.rockSkins === null) delete raw.rockSkins;
    else raw.rockSkins = before.rockSkins;
    fs.writeFileSync(recipeFile, JSON.stringify(raw, null, 2) + "\n");
    if (material && before.bases) { material.doc.rockCap.bases = before.bases; fs.writeFileSync(material.file, JSON.stringify(material.doc, null, 2) + "\n"); }
    if (before.scene?.length && fs.existsSync(sceneFile)) {
      const reg = new ComponentRegistry();
      registerCoreComponents(reg);
      const res = applyOps(JSON.parse(fs.readFileSync(sceneFile, "utf8")), before.scene, reg);
      fs.writeFileSync(sceneFile, JSON.stringify(res.doc, null, 2));
    }
    fs.rmSync(inv);
    console.log(`rock-skins undo: restored ${world}'s rockSkins, rock material bases${before.scene?.length ? " and placed rocks" : ""}`);
    return;
  }
  fail("usage: rock-skins install <project> [--world w] [--prefer s=tex] [--inverse f] [--dry] | undo <project> --inverse f | chunks <project> --dir d");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
