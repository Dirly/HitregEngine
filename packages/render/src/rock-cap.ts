import * as THREE from "three/webgpu";
import {
  attribute,
  clamp,
  float,
  floor,
  int,
  mix,
  normalWorld,
  positionWorld,
  round,
  select,
  smoothstep,
  step,
  texture as tslTexture,
  uniformArray,
  uv,
  vec3,
  vertexColor,
  vertexStage,
} from "three/tsl";
import type { RockCap, VegetationTint } from "@hitreg/core";
import { loadSharedTexture, type TextureFilter, type TextureResolver } from "./material-maps.js";
import { packLayerArray, type LayerArray } from "./terrain-splat.js";
import { VEGETATION_TINT_ATTRIBUTES } from "./vegetation-tint.js";
import type { MaterialData } from "./scene-builder.js";

/**
 * The `rock-cap` shader: ONE material for every rock of the world-kit rock kit, whatever zone it
 * stands in and whatever it wears on top.
 *
 * - BODY: `bases[base]` from one array texture, projected in the MODEL's own space along the face's
 *   dominant axis. The kit is faceted (flat triangles), so each face has exactly one axis and one
 *   fetch is a true box projection — triplanar without the three-way blend. Granite and sandstone
 *   are two slices of that array: the same mesh, the same batch.
 * - CAP: the palette layer `layer` (the world's terrain palette, the SAME packed array the ground
 *   samples — see `packLayerArray`'s cache), projected from above in WORLD space at the layer's own
 *   tile size, so the snow on a rock is the snow beside it. It covers faces whose world normal points
 *   up past a threshold that `amount` lowers (TOP faces only: ~44 degrees at amount 1), thickened over
 *   the model's top rim (TEXCOORD_1 = height fraction); the edge steps by a 2x2 ordered dither in world
 *   cells (crisp PSX steps, not blotches) and the baked occlusion keeps it out of crevices and off the
 *   ground contact. Material-only layers (`extraLayers`: moss) follow the palette in their own array.
 * - PER INSTANCE: layer, amount, base and the cap's biome tint ride in the SAME six-float slot the
 *   vegetation tint uses (`InstancedProps.enableVegetationTint`), so near, mid, far and the LOD
 *   compaction carry them without a new buffer — WebGPU allows eight vertex buffers and instanced
 *   props already use six. Encoding (`encodeRockCap`): [1 - amount, layer, -1 - base, r, g, b], so an
 *   untouched slot (all ones) is a bare rock of base 0 (the base clamps at 0).
 *
 * Cost per fragment: two texture fetches (three with extra layers), a handful of ALU. The terrain's indexed
 * splat is four triplanar layers (twelve fetches) plus two fractal noises.
 */

/** Everything the graph needs, resolved to URLs at build time. JSON-safe: it rides in `userData`, which material clones copy. */
export interface RockCapConfig {
  bases: { url: string | null; metres: number; color: string }[];
  /** The world palette's layers, then the material's own `extraLayers` (index = palette length + i). */
  palette: { url: string | null; uvScale: number; color: string; roughness: number }[];
  /** How many of `palette` are the world's (the rest are extras, packed in their own array). */
  paletteCount: number;
  paletteFilter: TextureFilter;
  filter: TextureFilter;
  anisotropy: number;
  start: number;
  softness: number;
  noise: number;
  noiseMetres: number;
  thicken: number;
  crevice: number;
  occlusion: number;
  roughness: number;
}

const FLAG = "rockCap";
const INSTANCED = "rockCapInstanced";

/** Per-instance slot encoding; see the module comment. */
export function encodeRockCap(cap: RockCap | undefined): number[] {
  if (!cap) return [1, 1, 1, 1, 1, 1];
  const tint = cap.tint ?? [1, 1, 1];
  // the third float is NEGATIVE for a rock (-1 - base): a tint is never below 0, so a shared impostor page can
  // tell a rock instance from a tree in the same draw (`rockImpostorColor`)
  return [1 - (cap.amount ?? 0), cap.layer ?? 0, -1 - (cap.base ?? 0) - 8 * wetCode(cap.wet), tint[0], tint[1], tint[2]];
}

/**
 * The WATERLINE rides in the base float: -1 - base - 8 * code, code 0 = dry, else 1 + the line in 1/200ths of the
 * model's height. The base is then the code's remainder mod 8 (bases are 0..7), and every value stays an exact
 * integer under 2048 (a half float holds it too).
 */
export function wetCode(wet: number | undefined): number {
  return wet === undefined || !(wet > 0) ? 0 : 1 + Math.round(Math.min(1, wet) * 200);
}

/** The slot's integer code (base + 8 * wet code) from the third float. */
const slotCode = (z: N): N => round(float(-1).sub(z));

/**
 * A rock cap as the vegetation-tint-shaped record the instancing paths already carry (bark = the
 * first three floats, leaves = the last three). Only the rock-cap shader reads it this way; on any
 * other material the slot is a tint and a rock never has a bark/leaf role, so nothing else sees it.
 */
export function rockCapAsInstanceTint(cap: RockCap | undefined): VegetationTint | undefined {
  if (!cap) return undefined;
  const e = encodeRockCap(cap);
  return { bark: [e[0]!, e[1]!, e[2]!], leaves: [e[3]!, e[4]!, e[5]!] };
}

/** The instance slot a mesh source asks for: its vegetation tint, else its rock cap. */
export function instanceTintOf(source: { vegetationTint?: VegetationTint; rockCap?: RockCap }): VegetationTint | undefined {
  return source.vegetationTint ?? rockCapAsInstanceTint(source.rockCap);
}

export function isRockCapMaterial(material: THREE.Material): boolean {
  return !!material.userData[FLAG];
}

type Resolver = TextureResolver & { resolveMaterial?(assetId: string): unknown };

/** Resolve a `rock-cap` material doc (its palette material included) into a config. */
export function rockCapConfig(data: MaterialData, options?: Resolver): RockCapConfig | null {
  const rc = (data as MaterialData & { rockCap?: Record<string, unknown> }).rockCap as
    | {
        bases: { map: string; metres?: number; color?: string }[];
        palette: string;
        extraLayers?: { name: string; map: string; uvScale?: number; color?: string; roughness?: number }[];
        start?: number;
        thicken?: number;
        softness?: number;
        noise?: number;
        noiseMetres?: number;
        crevice?: number;
        occlusion?: number;
      }
    | undefined;
  if (!rc) return null;
  const palette = options?.resolveMaterial?.(rc.palette) as MaterialData | undefined;
  if (!palette?.splat) console.warn(`[render] rock-cap: palette material "${rc.palette}" not found or not a terrain-splat; caps stay bare`);
  const layers = (palette?.splat?.layers ?? []) as Array<{ map?: string; uvScale?: number; color: string; roughness: number }>;
  return {
    bases: rc.bases.map((b) => ({ url: options?.resolveTexture?.(b.map) ?? null, metres: b.metres ?? 6.4, color: b.color ?? "#ffffff" })),
    palette: [
      ...layers.map((l) => ({ url: l.map ? (options?.resolveTexture?.(l.map) ?? null) : null, uvScale: Math.max(l.uvScale ?? 4, 1e-3), color: l.color, roughness: l.roughness })),
      ...(rc.extraLayers ?? []).map((l) => ({ url: options?.resolveTexture?.(l.map) ?? null, uvScale: Math.max(l.uvScale ?? 3.2, 1e-3), color: l.color ?? "#ffffff", roughness: l.roughness ?? 0.95 })),
    ],
    paletteCount: layers.length,
    paletteFilter: ((palette?.filter as TextureFilter | undefined) ?? "linear"),
    filter: ((data.filter as TextureFilter | undefined) ?? "nearest"),
    anisotropy: options?.resolveMaxAnisotropy?.() ?? 0,
    start: rc.start ?? 0.72,
    softness: rc.softness ?? 0.06,
    noise: rc.noise ?? 0.04,
    noiseMetres: rc.noiseMetres ?? 0.25,
    thicken: rc.thicken ?? 0.55,
    crevice: rc.crevice ?? 0.7,
    occlusion: rc.occlusion ?? 0.35,
    roughness: data.roughness ?? 0.95,
  };
}

interface RockCapTextures {
  bases?: LayerArray;
  caps?: LayerArray;
  extras?: LayerArray;
}
const textureCache = new Map<string, Promise<RockCapTextures>>();
const settled = new Map<string, RockCapTextures>();
const keyOf = (config: RockCapConfig) => JSON.stringify([config.bases, config.palette, config.filter, config.paletteFilter, config.anisotropy]);

/**
 * The body and cap arrays, loaded once per config. The cap array is packed exactly as the indexed
 * terrain packs its palette (same textures from the URL cache, same filter, anisotropy and depth),
 * so `packLayerArray` hands back the terrain's own array object, not a copy.
 */
function loadTextures(config: RockCapConfig): Promise<RockCapTextures> {
  const key = keyOf(config);
  let pending = textureCache.get(key);
  if (pending) return pending;
  const load = async (urls: (string | null)[], filter: TextureFilter): Promise<{ index: number; texture: THREE.Texture }[]> => {
    const out: { index: number; texture: THREE.Texture }[] = [];
    const results = await Promise.allSettled(urls.map((url) => (url ? loadSharedTexture(url, true, config.anisotropy, filter) : Promise.reject(new Error("no map")))));
    results.forEach((r, index) => {
      if (r.status !== "fulfilled") return;
      r.value.wrapS = THREE.RepeatWrapping;
      r.value.wrapT = THREE.RepeatWrapping;
      out.push({ index, texture: r.value });
    });
    return out;
  };
  pending = (async () => {
    const out: RockCapTextures = {};
    try {
      const bases = await load(config.bases.map((b) => b.url), config.filter);
      if (bases.length) out.bases = packLayerArray(bases, config.filter, config.anisotropy, config.bases.length);
      const world = config.palette.slice(0, config.paletteCount);
      const caps = await load(world.map((p) => p.url), config.paletteFilter);
      if (caps.length) out.caps = packLayerArray(caps, config.paletteFilter, config.anisotropy, world.length);
      const extra = config.palette.slice(config.paletteCount);
      const extras = extra.length ? await load(extra.map((p) => p.url), config.filter) : [];
      if (extras.length) out.extras = packLayerArray(extras, config.filter, config.anisotropy, extra.length);
    } catch (error) {
      console.warn("[render] rock-cap textures failed to pack; drawing flat colours", error);
    }
    settled.set(key, out);
    return out;
  })();
  textureCache.set(key, pending);
  return pending;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Wire (or re-wire, once textures land) the colour/roughness graph of one material object. */
function wire(material: THREE.MeshStandardNodeMaterial, config: RockCapConfig, instanced: boolean): void {
  const textures = settled.get(keyOf(config)) ?? {};
  const slot0: N = instanced ? vertexStage(vec3(attribute<"vec3">(VEGETATION_TINT_ATTRIBUTES[0], "vec3"))) : vec3(1, 0, 1);
  const slot1: N = instanced ? vertexStage(vec3(attribute<"vec3">(VEGETATION_TINT_ATTRIBUTES[1], "vec3"))) : vec3(1, 1, 1);
  const amount: N = clamp(float(1).sub(slot0.x), 0, 1);
  const lastBase = Math.max(0, config.bases.length - 1);
  const code: N = slotCode(slot0.z);
  const base: N = int(clamp(code.mod(8), float(0), float(lastBase)));

  // BODY: object-space box projection by the face's dominant axis (faceted kit: one axis per face, one fetch);
  // the kit bakes that projection into TEXCOORD_0 (metres / 6.4, per face): read it rather than re-deriving it
  const projected: N = uv().mul(6.4);
  const metres: N = uniformArray(config.bases.map((b) => b.metres), "float").element(base);
  const baseTint: N = uniformArray(config.bases.map((b) => new THREE.Color(b.color)), "color").element(base);
  const fallback = new THREE.Color("#7c7972");
  let body: N = textures.bases ? tslTexture(textures.bases.texture, projected.div(metres)).depth(base).rgb.mul(baseTint) : vec3(fallback.r, fallback.g, fallback.b).mul(baseTint);
  const ao: N = vertexColor().r;
  body = body.mul(mix(float(1), ao, float(config.occlusion)));
  // WET STONE at the waterline (cap `wet`, water rules only): darker and glossier under the line and a band over
  // it, the band's edge stepped by the same world-cell dither as the cap. Height fraction = TEXCOORD_1.x.
  let wetMask: N = float(0);
  if (instanced) {
    const wq: N = floor(code.div(8));
    const line: N = wq.sub(1).div(200);
    const cellW: N = floor(positionWorld.div(float(config.noiseMetres)));
    const bayerW: N = cellW.x.mod(2).mul(0.5).add(cellW.y.add(cellW.z).mod(2).mul(0.25));
    wetMask = step(uv(1).x, line.add(0.07).add(bayerW.sub(0.375).mul(0.06))).mul(step(0.5, wq));
    body = mix(body, body.mul(0.52), wetMask);
  }
  let color: N = body;
  let roughness: N = mix(float(config.roughness), float(0.45), wetMask);

  if (instanced && config.palette.length > 0) {
    const last = config.palette.length - 1;
    const P = config.paletteCount;
    const layer: N = int(clamp(round(slot0.y), float(0), float(last)));
    // a 2x2 ORDERED dither per world cell (0, .25, .5, .75): the edge steps crisply in PSX pixels, never blotches
    const cell: N = floor(positionWorld.div(float(config.noiseMetres)));
    const bayer: N = cell.x.mod(2).mul(0.5).add(cell.y.add(cell.z).mod(2).mul(0.25));
    const dither: N = bayer.sub(0.375);
    // TOP only: amount 0 puts the threshold past straight up; amount 1 lowers it to `start` (~44 degrees)
    const threshold: N = mix(float(1.05), float(config.start), amount);
    // thickening: near the model's highest point the threshold drops, so the cap wraps over the top rim
    const topness: N = smoothstep(0.82, 1.0, uv(1).x);
    const facing: N = normalWorld.y.add(topness.mul(config.thicken).mul(amount)).add(dither.mul(config.softness * 2 + config.noise));
    let cover: N = step(threshold, facing);
    // crevices and the ground contact stay rock (baked occlusion, dithered)
    cover = cover.mul(step(float(0.6 * config.crevice).add(dither.mul(0.2)), ao));
    cover = cover.mul(step(0.001, amount));
    // no cap under the waterline
    cover = cover.mul(float(1).sub(wetMask));
    const scales: N = uniformArray(config.palette.map((l) => l.uvScale), "float");
    const tints: N = uniformArray(config.palette.map((l) => new THREE.Color(l.color)), "color");
    const roughs: N = uniformArray(config.palette.map((l) => l.roughness), "float");
    const capUv: N = positionWorld.xz.div(scales.element(layer));
    const worldCap: N = textures.caps ? tslTexture(textures.caps.texture, capUv).depth(int(clamp(round(slot0.y), float(0), float(Math.max(0, P - 1))))).rgb : vec3(1, 1, 1);
    let capAlbedo: N = worldCap;
    if (config.palette.length > P) {
      const extraCap: N = textures.extras ? tslTexture(textures.extras.texture, capUv).depth(int(clamp(round(slot0.y).sub(P), float(0), float(last - P)))).rgb : vec3(1, 1, 1);
      capAlbedo = select(slot0.y.lessThan(P - 0.5), worldCap, extraCap);
    }
    const cap: N = capAlbedo.mul(tints.element(layer)).mul(slot1);
    color = mix(body, cap, cover);
    roughness = mix(roughness, roughs.element(layer), cover);
  }
  material.colorNode = color;
  material.roughnessNode = roughness;
  material.needsUpdate = true;
}

function wireWhenReady(material: THREE.MeshStandardNodeMaterial, config: RockCapConfig, instanced: boolean): void {
  wire(material, config, instanced);
  if (settled.has(keyOf(config))) return;
  void loadTextures(config).then(() => {
    // the material may have been re-wired as instanced since; honour its current role
    wire(material, config, material.userData[INSTANCED] === true);
  });
}

/** Build a `shader: "rock-cap"` material (non-instanced form: bare base 0; instanced clones add the cap). */
export function buildRockCapMaterial(data: MaterialData, options?: Resolver): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0, roughness: data.roughness ?? 0.95 });
  material.name = "rock-cap";
  const config = rockCapConfig(data, options);
  if (!config) {
    material.color = new THREE.Color(data.color);
    return material;
  }
  material.userData[FLAG] = config;
  wireWhenReady(material, config, false);
  return material;
}

/**
 * Make an instanced clone of a rock-cap material read the per-instance slot. Called by
 * `cachedInstancedMaterial` in place of the vegetation-tint hook (same slot, rock semantics).
 * Every batch drawn with it must have called `enableVegetationTint()`.
 */
export function applyInstanceRockCap(material: THREE.Material): void {
  const config = material.userData[FLAG] as RockCapConfig | undefined;
  const node = material as THREE.MeshStandardNodeMaterial;
  if (!config || !node.isNodeMaterial || material.userData[INSTANCED]) return;
  material.userData[INSTANCED] = true;
  wireWhenReady(node, config, true);
}

/**
 * What a rock impostor needs to keep its body texture and its cap at distance: a colour RATIO per
 * base (the baked atlas is the model's own granite; sandstone is granite x mean(sandstone)/mean(granite))
 * and a flat colour per cap layer (the palette layer's mean colour x its tint). Filled in place when
 * the textures land, so the impostor material can be built before they do.
 */
export interface RockImpostorLook {
  key: string;
  baseRatio: THREE.Color[];
  capColor: THREE.Color[];
  start: number;
  softness: number;
}
const looks = new Map<string, RockImpostorLook>();

export function rockImpostorLook(material: THREE.Material | THREE.Material[] | null | undefined): RockImpostorLook | null {
  const first = Array.isArray(material) ? material[0] : material;
  const config = first?.userData[FLAG] as RockCapConfig | undefined;
  if (!config) return null;
  const key = `${keyOf(config)}#${config.start}#${config.softness}`;
  let look = looks.get(key);
  if (look) return look;
  look = {
    key,
    baseRatio: config.bases.map(() => new THREE.Color(1, 1, 1)),
    capColor: config.palette.map((l) => new THREE.Color(l.color)),
    start: config.start,
    softness: config.softness,
  };
  looks.set(key, look);
  const filled = look;
  void loadTextures(config).then((t) => {
    const mean = (array: LayerArray | undefined, i: number) => array?.averages?.get(i);
    const b0 = mean(t.bases, 0);
    const tint0 = new THREE.Color(config.bases[0]!.color);
    config.bases.forEach((b, i) => {
      const bi = mean(t.bases, i);
      const tint = new THREE.Color(b.color);
      if (!b0 || !bi) return;
      filled.baseRatio[i]!.setRGB(
        (bi.r * tint.r) / Math.max(1e-3, b0.r * tint0.r),
        (bi.g * tint.g) / Math.max(1e-3, b0.g * tint0.g),
        (bi.b * tint.b) / Math.max(1e-3, b0.b * tint0.b),
      );
    });
    config.palette.forEach((l, i) => {
      const m = i < config.paletteCount ? mean(t.caps, i) : mean(t.extras, i - config.paletteCount);
      if (m) filled.capColor[i]!.copy(m).multiply(new THREE.Color(l.color));
    });
  });
  return look;
}

/**
 * The impostor half of the rock-cap shader: body = baked albedo x the instance's base ratio; cap =
 * the layer's mean colour x tint over faces whose (instance-rotated, baked) normal points up past
 * the same threshold the near shader uses. No noise or crevice term: at impostor range the edge is a
 * pixel or two. Reads the same per-instance slot (impostor batches enable it). `slots` are the
 * two slot vec3s already carried to the fragment stage by the caller (the impostor shader packs
 * them with its other per-instance terms); omitted, they become two varyings of their own.
 */
export function rockImpostorColor(look: RockImpostorLook, albedo: N, normalUp: N, mixed = false, slots?: [N, N]): N {
  const slot0: N = slots?.[0] ?? vertexStage(vec3(attribute<"vec3">(VEGETATION_TINT_ATTRIBUTES[0], "vec3")));
  const slot1: N = slots?.[1] ?? vertexStage(vec3(attribute<"vec3">(VEGETATION_TINT_ATTRIBUTES[1], "vec3")));
  const amount: N = clamp(float(1).sub(slot0.x), 0, 1);
  const base: N = int(clamp(slotCode(slot0.z).mod(8), float(0), float(Math.max(0, look.baseRatio.length - 1))));
  const layer: N = int(clamp(round(slot0.y), float(0), float(Math.max(0, look.capColor.length - 1))));
  const body: N = albedo.mul(uniformArray(look.baseRatio, "color").element(base));
  if (look.capColor.length === 0) return body;
  const threshold: N = mix(float(1 + look.softness + 0.2), float(look.start), amount);
  // the near shader caps whole noise cells; at impostor range that is a coverage fraction
  const cover: N = smoothstep(threshold.sub(look.softness), threshold.add(look.softness), normalUp).mul(step(0.001, amount));
  const capColors: N = uniformArray(look.capColor, "color");
  const cap: N = capColors.element(layer).mul(slot1);
  const rock: N = mix(body, cap, cover);
  // on a shared page the same draw holds trees: only an instance whose slot says rock (z < 0) is recoloured
  return mixed ? mix(albedo, rock, step(slot0.z, float(-0.5))) : rock;
}
