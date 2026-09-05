import * as THREE from "three/webgpu";
import { bumpShadowPassMaterials } from "./shadow-pass-material.js";
import {
  abs,
  add,
  cameraViewMatrix,
  float,
  int,
  max,
  normalWorldGeometry,
  normalize,
  normalMap,
  positionWorld,
  pow,
  sign,
  texture as tslTexture,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import type { MaterialData } from "./scene-builder.js";

/**
 * The PBR map pipeline: texture loading/sharing, colour-space discipline, the
 * one shared UV transform, detail-normal anti-tiling, world-space triplanar
 * projection, and the uniform plumbing that lets a live material edit patch a
 * *mapped* material in place instead of rebuilding the scene.
 *
 * Split out of scene-builder.ts (already ~1800 lines) because it is one
 * concern with one entry point per phase:
 *   applyMaterialCommon / makeMaterialUniforms — synchronous, no textures
 *   applyMaterialMaps                          — async, wires the node graph
 *   materialMapKey / materialUniformsOf        — what `patchMaterial` needs
 */

/**
 * TSL's fluent node API is far more permissive than @types/three can express
 * (`.xy`, `.zyx`, `.mul(anything)`, arbitrary swizzles), so node expressions
 * are built through this alias rather than fighting the declarations with a
 * cast on every term. Node graphs are validated by the shader compiler at
 * build time, which is the only thing that could check them anyway.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** A TSL uniform handle — a node whose `.value` can be written at any time. */
type ScalarUniform = THREE.Node<"float"> & { value: number };
type ColorUniform = THREE.Node<"color"> & { value: THREE.Color };
type Vec4Uniform = THREE.Node<"vec4"> & { value: THREE.Vector4 };

// ---------------------------------------------------------------------------
// map taxonomy
// ---------------------------------------------------------------------------

export type MaterialMapField =
  | "map"
  | "emissiveMap"
  | "normalMap"
  | "detailNormalMap"
  | "roughnessMap"
  | "metalnessMap"
  | "aoMap"
  | "ormMap"
  | "alphaMap";

/** Every map field, in a stable order — the key/compare order for patching. */
export const MATERIAL_MAP_FIELDS: readonly MaterialMapField[] = [
  "map",
  "emissiveMap",
  "normalMap",
  "detailNormalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "ormMap",
  "alphaMap",
];

/**
 * Colour space per map type. `map`/`emissiveMap` are authored as visible
 * colour and must be decoded from sRGB; every other map is DATA (surface
 * gradients, 0..1 scalars) and must be sampled linearly.
 *
 * Getting this backwards is the classic invisible-everywhere bug: an
 * sRGB-decoded roughness map is quietly too glossy through the midtones and a
 * linearly-sampled albedo is quietly too dark, and neither looks broken enough
 * to be noticed as a bug. So every texture gets its colour space set
 * EXPLICITLY here instead of inheriting THREE.TextureLoader's default.
 */
export function mapColorSpace(field: MaterialMapField): "srgb" | "linear" {
  return field === "map" || field === "emissiveMap" ? "srgb" : "linear";
}

/**
 * Which map fields this material actually uses, in load order — the one place
 * both gating rules live:
 *
 * - **ORM precedence** (schema contract): when `ormMap` is set,
 *   `aoMap`/`roughnessMap`/`metalnessMap` are ignored *entirely*. Not
 *   composited, not multiplied — ignored, so a material carrying both a
 *   packed map and leftover separate maps renders the same either way.
 * - **Per-shader gating**: a shader with no lighting model has nothing for a
 *   normal/roughness/AO map to do, and the procedural shaders
 *   (terrain-splat/water) drive every channel themselves.
 */
export function materialMapPlan(data: MaterialData): MaterialMapField[] {
  const shader = data.shader ?? "standard";
  if (shader === "wireframe" || shader === "terrain-splat" || shader === "water") return [];

  const lit = shader === "standard" || shader === "toon";
  const pbr = shader === "standard";
  const fields: MaterialMapField[] = [];

  if (data.map) fields.push("map");
  if (lit && data.emissiveMap) fields.push("emissiveMap");
  if (lit && data.normalMap) fields.push("normalMap");
  if (lit && data.detailNormalMap) fields.push("detailNormalMap");
  if (pbr) {
    if (data.ormMap) {
      fields.push("ormMap");
    } else {
      if (data.roughnessMap) fields.push("roughnessMap");
      if (data.metalnessMap) fields.push("metalnessMap");
      if (data.aoMap) fields.push("aoMap");
    }
  }
  if (data.alphaMap) fields.push("alphaMap");
  return fields;
}

/**
 * Identity of a material's *structure* — everything that decides the shape of
 * the compiled node graph rather than the value of a uniform. Two materials
 * with the same key differ only in numbers, which is exactly the case
 * `patchMaterial` can serve without a rebuild.
 */
export function materialMapKey(data: MaterialData): string {
  const maps = materialMapPlan(data)
    .map((field) => `${field}=${data[field] as string}`)
    .join(",");
  return [
    data.shader ?? "standard",
    maps,
    // triplanar swaps every sampler's uv source for a world-space projection
    data.triplanar === true ? "tri" : "uv",
    // filtering changes the TEXTURE OBJECT, not a uniform, so a change here has
    // to force a rebuild rather than be patched in place
    data.filter === "nearest" ? "nn" : "lin",
    // both of these change the compiled shader, not just a uniform
    data.vertexColors === true ? "vc" : "-",
    (data.alphaTest ?? 0) > 0 ? "cutout" : "-",
  ].join("|");
}

// ---------------------------------------------------------------------------
// texture cache
// ---------------------------------------------------------------------------

/**
 * url+colourspace+anisotropy -> the ONE THREE.Texture every material wanting
 * it shares. Three's backends upload one GPU texture per THREE.Texture
 * instance (they key on the texture, not on `texture.source`), so sharing the
 * instance itself is the only thing that actually keeps the same rock normal
 * used by forty materials down to one upload and one image decode.
 *
 * That is also why per-material `repeat`/`uvOffset` live in the SHADER (see
 * `uvTransformNode`) rather than on `texture.repeat`/`texture.offset`: those
 * are per-instance state, so honouring them on the texture would fork the
 * cache per tiling and undo the sharing.
 */
const textureCache = new Map<string, Promise<THREE.Texture>>();

/** Magnification style. Pixel art wants hard texel edges, photo art does not. */
export type TextureFilter = "linear" | "nearest";

// Filtering is a property of the TEXTURE OBJECT, and the cache shares one
// object per key — so it has to be part of the key, or the first material to
// ask for a texture would silently decide how every other material sees it.
function textureCacheKey(url: string, srgb: boolean, anisotropy: number, filter: TextureFilter): string {
  return `${srgb ? "s" : "l"}|${anisotropy}|${filter}|${url}`;
}

/**
 * Load (or reuse) a texture configured for the given colour space. Callers
 * use `allSettled`, so one missing map never costs a material its other maps.
 */
export function loadSharedTexture(
  url: string,
  srgb: boolean,
  maxAnisotropy = 0,
  filter: TextureFilter = "linear",
): Promise<THREE.Texture> {
  const key = textureCacheKey(url, srgb, maxAnisotropy, filter);
  let pending = textureCache.get(key);
  if (!pending) {
    pending = new THREE.TextureLoader().loadAsync(url).then((texture) => {
      configureTexture(texture, srgb, maxAnisotropy, filter);
      return texture;
    });
    // a failed load must not poison the cache forever — a texture that lands
    // late (asset still being copied in) should be retried on the next build
    pending.catch(() => {
      if (textureCache.get(key) === pending) textureCache.delete(key);
    });
    textureCache.set(key, pending);
  }
  return pending;
}

/**
 * The complete per-texture setup. Separate from loading so it is testable
 * without an image decoder, and so no texture path can be added that skips
 * the colour-space assignment.
 */
/** Every texture slot a loaded material can carry; the filter applies to all of them. */
const MODEL_TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "emissiveMap",
  "aoMap",
  "alphaMap",
  "bumpMap",
  "specularMap",
] as const;

/**
 * Re-filter every texture of a loaded model (`mesh.source.textureFilter`).
 *
 * A glTF carries its own sampler and the loader honours it, which for almost
 * every exporter means LINEAR — so a 256px character skin meant to read as
 * pixel art arrives smeared. This flips just the filters (colour space, wrap
 * and anisotropy are the file's business), with the same nearest-magnify /
 * mipmapped-minify split as {@link configureTexture} and for the same reason.
 * Textures are shared across the model's materials and across every entity
 * using the model, so each is touched once. Returns how many were changed.
 */
export function applyModelTextureFilter(root: THREE.Object3D, filter: TextureFilter): number {
  const seen = new Set<string>();
  let touched = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material) continue;
      const slots = material as unknown as Record<string, THREE.Texture | null | undefined>;
      for (const slot of MODEL_TEXTURE_SLOTS) {
        const texture = slots[slot];
        if (!texture || !texture.isTexture || seen.has(texture.uuid)) continue;
        seen.add(texture.uuid);
        if (filter === "nearest") {
          texture.magFilter = THREE.NearestFilter;
          texture.minFilter = THREE.NearestMipmapLinearFilter;
        } else {
          texture.magFilter = THREE.LinearFilter;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
        }
        texture.needsUpdate = true;
        touched += 1;
      }
    }
  });
  return touched;
}

export function configureTexture(
  texture: THREE.Texture,
  srgb: boolean,
  maxAnisotropy = 0,
  filter: TextureFilter = "linear",
): THREE.Texture {
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // repeat/offset are applied in the shader (see the cache comment above), so
  // the texture's own uv matrix stays identity for everyone sharing it
  texture.repeat.set(1, 1);
  texture.offset.set(0, 0);
  texture.generateMipmaps = true;
  if (filter === "nearest") {
    // Pixel art: magnify with hard texel edges so it reads chunky instead of
    // being smeared into mush the moment you stand near it.
    //
    // MINIFICATION still mipmaps (NearestMipmapLinear, not plain Nearest):
    // nearest minification of a repeating texture across a hillside is a
    // shimmering aliased mess as texels alias against pixels, which is the
    // usual reason "I set nearest and it looks worse at distance". Nearest
    // WITHIN the mip keeps the chunk; blending BETWEEN mips keeps it stable.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    // anisotropy is a minification filter and fights the crisp look; leave it
  } else {
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (maxAnisotropy > 1) texture.anisotropy = maxAnisotropy;
  }
  texture.needsUpdate = true;
  return texture;
}

/** Test/teardown hook — drops the shared texture cache. */
export function clearTextureCache(): void {
  textureCache.clear();
}

/** Distinct textures the shared cache holds (tests, diagnostics). */
export function sharedTextureCount(): number {
  return textureCache.size;
}

// ---------------------------------------------------------------------------
// uniforms
// ---------------------------------------------------------------------------

/**
 * The knobs a mapped material's node graph reads through uniforms instead of
 * baking in as literals.
 *
 * This is what makes the patch tier possible at all. With the scalars as
 * uniforms, changing `roughness`, `normalScale`, `aoIntensity` or `repeat` on
 * a material that HAS maps is a value write: no shader recompile, no scene
 * rebuild. Bake them as `float(0.7)` instead and every one of those edits
 * costs a full rebuild — which, with ~15 map-bearing fields on every serious
 * material, is what would blow the <1s hot-reload budget on a textured level.
 */
export interface MaterialUniforms {
  color: ColorUniform;
  opacity: ScalarUniform;
  emissive: ColorUniform;
  emissiveIntensity: ScalarUniform;
  roughness: ScalarUniform;
  metalness: ScalarUniform;
  normalScale: ScalarUniform;
  detailStrength: ScalarUniform;
  aoIntensity: ScalarUniform;
  /** (repeat.u, repeat.v, offset.u, offset.v) — the one shared UV transform. */
  uvTransform: Vec4Uniform;
  /** (detailRepeat.u, detailRepeat.v, offset.u, offset.v). */
  detailTransform: Vec4Uniform;
  /** World units per tile in triplanar mode. */
  triplanarScale: ScalarUniform;
}

interface MaterialState {
  uniforms: MaterialUniforms;
  /** Structural identity at build time — see `materialMapKey`. */
  mapKey: string;
  /**
   * Bumped on every `applyMaterialMaps`; texture loads that resolve after a
   * newer call started are dropped rather than interleaved into its graph.
   */
  generation: number;
}

const materialState = new WeakMap<THREE.Material, MaterialState>();
/**
 * The resolved material-asset data each cached material was built from —
 * separate from MaterialState because it must work for every shader,
 * including the procedural ones that never build a uniform block.
 */
const materialSources = new WeakMap<THREE.Material, unknown>();

/** Live uniform handles for a material built by this module, if any. */
export function materialUniformsOf(material: THREE.Material): MaterialUniforms | undefined {
  return materialState.get(material)?.uniforms;
}

/** The structural key a material was built with — `patchMaterial`'s gate. */
export function materialMapKeyOf(material: THREE.Material): string | undefined {
  return materialState.get(material)?.mapKey;
}

/** The material-asset data object a cached material was built from. */
export function materialSourceOf(material: THREE.Material): unknown {
  return materialSources.get(material);
}

/** Record which resolved asset data a cached material corresponds to. */
export function setMaterialSource(material: THREE.Material, source: unknown): void {
  materialSources.set(material, source);
}

function repeatOf(data: MaterialData): [number, number] {
  return data.repeat ?? [1, 1];
}

function offsetOf(data: MaterialData): [number, number] {
  return data.uvOffset ?? [0, 0];
}

function detailRepeatOf(data: MaterialData): [number, number] {
  return data.detailRepeat ?? [8, 8];
}

/** Create (once) and fill the uniform block for a material. */
export function makeMaterialUniforms(material: THREE.Material, data: MaterialData): MaterialUniforms {
  const existing = materialState.get(material);
  if (existing) {
    writeMaterialUniforms(existing.uniforms, data);
    existing.mapKey = materialMapKey(data);
    return existing.uniforms;
  }
  const [rx, ry] = repeatOf(data);
  const [ox, oy] = offsetOf(data);
  const [dx, dy] = detailRepeatOf(data);
  const uniforms: MaterialUniforms = {
    color: uniform(new THREE.Color(data.color)) as ColorUniform,
    opacity: uniform(data.opacity ?? 1) as ScalarUniform,
    emissive: uniform(new THREE.Color(data.emissive ?? "#000000")) as ColorUniform,
    emissiveIntensity: uniform(data.emissiveIntensity ?? 1) as ScalarUniform,
    roughness: uniform(data.roughness ?? 0.85) as ScalarUniform,
    metalness: uniform(data.metalness ?? 0.05) as ScalarUniform,
    normalScale: uniform(data.normalScale ?? 1) as ScalarUniform,
    detailStrength: uniform(data.detailStrength ?? 1) as ScalarUniform,
    aoIntensity: uniform(data.aoIntensity ?? 1) as ScalarUniform,
    uvTransform: uniform(new THREE.Vector4(rx, ry, ox, oy)) as Vec4Uniform,
    detailTransform: uniform(new THREE.Vector4(dx, dy, ox, oy)) as Vec4Uniform,
    triplanarScale: uniform(Math.max(data.triplanarScale ?? 1, 1e-4)) as ScalarUniform,
  };
  materialState.set(material, { uniforms, mapKey: materialMapKey(data), generation: 0 });
  return uniforms;
}

/** Push new material data into an existing uniform block (the patch path). */
export function writeMaterialUniforms(uniforms: MaterialUniforms, data: MaterialData): void {
  const [rx, ry] = repeatOf(data);
  const [ox, oy] = offsetOf(data);
  const [dx, dy] = detailRepeatOf(data);
  uniforms.color.value.set(data.color);
  uniforms.opacity.value = data.opacity ?? 1;
  uniforms.emissive.value.set(data.emissive ?? "#000000");
  uniforms.emissiveIntensity.value = data.emissiveIntensity ?? 1;
  uniforms.roughness.value = data.roughness ?? 0.85;
  uniforms.metalness.value = data.metalness ?? 0.05;
  uniforms.normalScale.value = data.normalScale ?? 1;
  uniforms.detailStrength.value = data.detailStrength ?? 1;
  uniforms.aoIntensity.value = data.aoIntensity ?? 1;
  uniforms.uvTransform.value.set(rx, ry, ox, oy);
  uniforms.detailTransform.value.set(dx, dy, ox, oy);
  uniforms.triplanarScale.value = Math.max(data.triplanarScale ?? 1, 1e-4);
}

// ---------------------------------------------------------------------------
// non-texture material properties
// ---------------------------------------------------------------------------

const SIDES = {
  front: THREE.FrontSide,
  back: THREE.BackSide,
  double: THREE.DoubleSide,
} as const;

/**
 * `alphaTest` and `transparent` are mutually exclusive by design, not by
 * oversight: an alpha-TESTED surface discards below the threshold and keeps a
 * normal opaque depth write, which is the entire reason it sorts correctly
 * through dense foliage. Leaving `transparent` on as well would push it into
 * the back-to-front transparent queue and hand back exactly the
 * see-through-leaves sorting mess the cutout was chosen to avoid.
 *
 * So when `alphaTest > 0` the cutout wins and blending stays off — unless the
 * material is also genuinely translucent (`opacity < 1`), where the author has
 * asked for something only blending can do.
 */
export function resolveTransparency(data: MaterialData): { transparent: boolean; alphaTest: number } {
  const alphaTest = data.alphaTest ?? 0;
  const opacity = data.opacity ?? 1;
  const wantsBlend = data.transparent === true || opacity < 1;
  return { transparent: alphaTest > 0 ? opacity < 1 : wantsBlend, alphaTest };
}

/**
 * Everything that needs no texture: side, cutout, vertex colours, env
 * intensity. Safe on any material class — each property is only meaningful
 * where it exists and three ignores the rest.
 */
export function applyMaterialCommon(material: THREE.Material, data: MaterialData): void {
  const { transparent, alphaTest } = resolveTransparency(data);
  material.side = SIDES[data.side ?? "front"];
  material.transparent = transparent;
  // a LIVE material flipping between cutout and opaque changes the shadow
  // variant its casters need; the shadow-pass materials no longer notice on
  // their own (see shadow-pass-material.ts), so tell them. `version > 0`
  // means this material has been through at least one needsUpdate, i.e. it
  // is being edited rather than built.
  const cutoutFlips = material.alphaTest > 0 !== alphaTest > 0 && material.version > 0;
  material.alphaTest = alphaTest;
  if (cutoutFlips) bumpShadowPassMaterials();
  // NEVER force this to false: the poly-mesh path turns vertexColors on for
  // face-tinted meshes by cloning the material after it is built, and the
  // schema field exists for the OTHER case (imported geometry with COLOR_0).
  if (data.vertexColors === true) material.vertexColors = true;
  if ((data.shader ?? "standard") === "standard") {
    const pbr = material as THREE.Material & { envMapIntensity?: number; envMap?: THREE.Texture | null };
    pbr.envMapIntensity = data.envMapIntensity ?? 1;
    material.userData[ENV_BASE] = pbr.envMapIntensity;
    pbr.envMapIntensity *= environmentScale;
    if (currentEnvironment) pbr.envMap = currentEnvironment;
    environmentMaterials.add(material);
  }
}

// ---------------------------------------------------------------------------
// environment (IBL) seam
// ---------------------------------------------------------------------------

let currentEnvironment: THREE.Texture | null = null;

/**
 * Every PBR material this module built, so a later `setEnvironment` reaches
 * materials that already exist. Bounded by the material-asset cache (materials
 * are deduped by asset id and long-lived). Poly-mesh clones aren't registered
 * but inherit whatever `envMap` was set at the moment they were cloned.
 */
const environmentMaterials = new Set<THREE.Material>();

/**
 * Hand the material pipeline the scene's image-based-lighting environment.
 * This is the seam for `environment.ts` — IBL generation lives there, not
 * here. Pass any equirect or cube texture (three PMREM-filters it internally
 * and caches the result per renderer), or null to clear.
 *
 * Why per-material `envMap` rather than just `scene.environment`: three
 * resolves a material's env intensity as
 * `material.envMap ? material.envMapIntensity : scene.environmentIntensity`
 * (nodes/accessors/MaterialProperties.js). Supply the environment only
 * through the scene and EVERY material's own `envMapIntensity` is silently
 * ignored. Setting `scene.environment` as well is correct and worth doing —
 * it covers materials this module didn't build, e.g. glTF-embedded ones — but
 * this call is what makes the per-material knob mean anything.
 */
let environmentScale = 1;
const ENV_BASE = "hitregEnvBase";

/**
 * Scale every environment-lit material's IBL at once, on top of its authored
 * `envMapIntensity` — three ignores `scene.environmentIntensity` for a
 * material that carries its own envMap (see `setEnvironment`), so a
 * day/night script dims reflections here. A plain uniform write per
 * material; nothing recompiles.
 */
export function setEnvironmentScale(scale: number): void {
  environmentScale = Math.max(0, scale);
  for (const material of environmentMaterials) applyEnvironmentScale(material);
}

function applyEnvironmentScale(material: THREE.Material): void {
  const pbr = material as THREE.Material & { envMapIntensity?: number };
  if (pbr.envMapIntensity === undefined) return;
  const base = (material.userData[ENV_BASE] as number | undefined) ?? pbr.envMapIntensity;
  material.userData[ENV_BASE] = base;
  pbr.envMapIntensity = base * environmentScale;
}

export function setEnvironment(environment: THREE.Texture | null): void {
  currentEnvironment = environment;
  for (const material of environmentMaterials) {
    const pbr = material as THREE.Material & { envMap?: THREE.Texture | null };
    if (pbr.envMap === environment) continue;
    pbr.envMap = environment;
    // an envMap appearing/disappearing adds or removes an EnvironmentNode, so
    // this one genuinely does need the recompile
    material.needsUpdate = true;
  }
}

/** The environment currently handed to materials, if any. */
export function currentMaterialEnvironment(): THREE.Texture | null {
  return currentEnvironment;
}

// ---------------------------------------------------------------------------
// UV / triplanar sampling
// ---------------------------------------------------------------------------

/**
 * Sharpness of the triplanar blend. Higher = narrower transition bands (less
 * of the surface paying for two or three visible projections at once), but
 * past ~8 the seams start to alias on curved geometry.
 */
const TRIPLANAR_SHARPNESS = 6;

/** uv * repeat + offset — ONE transform, shared by every map on the material. */
function uvTransformNode(uniforms: MaterialUniforms): N {
  const t: N = uniforms.uvTransform;
  return (uv() as N).mul(t.xy).add(t.zw);
}

/** uv * detailRepeat + offset — the one independently-tiled map. */
function detailUvNode(uniforms: MaterialUniforms): N {
  const t: N = uniforms.detailTransform;
  return (uv() as N).mul(t.xy).add(t.zw);
}

export interface TriplanarBasis {
  blend: N;
  uvX: N;
  uvY: N;
  uvZ: N;
  normal: N;
}

/**
 * A triplanar basis for an arbitrary world-units-per-tile scale, independent
 * of any material's uniforms.
 *
 * Exported for the terrain splat shader, which needs one basis PER LAYER (a
 * grass tile and a cliff tile want very different real-world scales) rather
 * than the single per-material basis {@link triplanarBasis} builds.
 */
export function worldTriplanarBasis(scale: N, warp?: N | null): TriplanarBasis {
  // The warp displaces the SAMPLING POSITION only. The blend weights below
  // still come from the true geometric normal, so a warped projection cannot
  // change which of the three planes a fragment reads from — only where in
  // that plane it reads. Warping the normal too would make the blend seams
  // crawl, which looks far worse than the tiling it is fixing.
  const world: N = warp ? (positionWorld as N).add(warp) : (positionWorld as N);
  const p: N = world.div(scale);
  const n: N = normalWorldGeometry;
  const weights: N = pow(abs(n), float(TRIPLANAR_SHARPNESS));
  const blend: N = weights.div(max(weights.dot(vec3(1, 1, 1)), float(1e-4)));
  const s: N = sign(n);
  return {
    blend,
    uvX: vec2(p.z.mul(s.x), p.y),
    uvY: vec2(p.x.mul(s.y), p.z),
    uvZ: vec2(p.x.mul(s.z.negate()), p.y),
    normal: n,
  };
}

/** Blend three axis samples of one texture by a basis's weights. */
export function sampleTriplanar(basis: TriplanarBasis, texture: THREE.Texture): N {
  return triplanarSample(basis, texture);
}

/**
 * Triplanar sample of ONE slice of a 2D array texture.
 *
 * A palette of sixteen ground textures cannot be sixteen bindings: WebGPU
 * guarantees only 16 sampled textures and 16 samplers per shader stage, and
 * the shadow map and the rest of the material need some of those, so the
 * terrain pipeline simply failed to build past twelve layers. An array is one
 * binding and one sampler however deep it is — the fetch count per fragment
 * is unchanged, the binding count is what this fixes.
 */
export function sampleTriplanarLayer(basis: TriplanarBasis, texture: THREE.DataArrayTexture, layer: number): N {
  const depth = int(layer);
  const x: N = (tslTexture(texture, basis.uvX) as N).depth(depth).mul(basis.blend.x);
  const y: N = (tslTexture(texture, basis.uvY) as N).depth(depth).mul(basis.blend.y);
  const z: N = (tslTexture(texture, basis.uvZ) as N).depth(depth).mul(basis.blend.z);
  return add(x, y, z);
}

/** Triplanar tangent-space normal samples -> one world normal (whiteout blend). */
export function triplanarNormalToWorld(basis: TriplanarBasis, samples: [N, N, N]): N {
  return triplanarWorldNormal(basis, samples);
}

/** Decode a tangent-space normal texture sample to [-1, 1], scaling its xy. */
export function decodeNormalSample(sample: N, strength: N): N {
  return decodeNormal(sample, strength);
}

/** World-space normal -> the view-space vector `material.normalNode` expects. */
export function worldNormalToViewNode(worldNormal: N): N {
  return worldNormalToView(worldNormal);
}

/**
 * The per-material triplanar basis: blend weights plus the three projected uv
 * sets. Built ONCE per material and reused by every map, so the (not free)
 * pow/normalize/sign work is paid once rather than per sampler.
 *
 * COST: every map sampled through this is 3 texture fetches instead of 1. A
 * material with albedo + normal + ORM goes from 3 fetches to 9 (12 with a
 * detail normal). That is the price of needing no UV unwrap at all, which is
 * why the schema restricts it to organic rock/cave geometry and warns it off
 * props and anything instanced in the thousands.
 *
 * `normalWorldGeometry`, not `normalWorld`, is deliberate: `normalWorld` is
 * the SHADED normal — the output of the normal map — so feeding it into the
 * thing that computes the normal map would be circular.
 */
function triplanarBasis(uniforms: MaterialUniforms, scaleDivisor?: N): TriplanarBasis {
  // The axis-sign flips inside worldTriplanarBasis keep the three projections'
  // tangent frames consistent with one another. Without them two of the three
  // faces sample mirrored, which is invisible on albedo and catastrophic on a
  // normal map.
  return worldTriplanarBasis(scaleDivisor ?? uniforms.triplanarScale);
}

/** Blend three axis samples of one texture by the triplanar weights. */
function triplanarSample(basis: TriplanarBasis, texture: THREE.Texture): N {
  const x: N = (tslTexture(texture, basis.uvX) as N).mul(basis.blend.x);
  const y: N = (tslTexture(texture, basis.uvY) as N).mul(basis.blend.y);
  const z: N = (tslTexture(texture, basis.uvZ) as N).mul(basis.blend.z);
  return add(x, y, z);
}

/** Decode a tangent-space normal sample to [-1,1] and scale its xy. */
function decodeNormal(sample: N, strength: N): N {
  const n: N = sample.xyz.mul(2).sub(1);
  return vec3(n.xy.mul(strength), n.z);
}

/**
 * Reoriented Normal Mapping (Barré-Brisebois & Hill) — the correct way to lay
 * a detail normal over a base normal.
 *
 * A naive lerp or add between two normals pulls the result toward flat: the
 * base map's shape washes out exactly where the detail is strongest, so a
 * wall gains fine grain and loses its bricks. RNM instead treats the detail
 * normal as living in the tangent frame DEFINED BY the base normal, so the
 * base's shape survives and the detail only perturbs around it.
 *
 * Both inputs are decoded normals in [-1, 1].
 */
function reorientNormal(base: N, detail: N): N {
  const t: N = vec3(base.x, base.y, base.z.add(1));
  const u: N = vec3(detail.x.negate(), detail.y.negate(), detail.z);
  return normalize(t.mul(t.dot(u)).sub(u.mul(t.z)));
}

/** Re-encode a [-1,1] normal to [0,1] for three's NormalMapNode. */
function encodeNormal(n: N): N {
  return n.mul(0.5).add(0.5);
}

/**
 * Triplanar tangent-space normals -> a WORLD normal, via the "whiteout" blend.
 *
 * This is the part of triplanar mapping that is almost always wrong. Sampling
 * a tangent-space normal map on three world-axis projections yields three
 * normals expressed in three DIFFERENT tangent frames, two of which have the
 * opposite handedness from the third. Averaging them directly (or pushing
 * them through a single TBN) gives lighting that is inverted on two thirds of
 * the surface — and it reads as "the light must be coming from over there"
 * rather than as an obvious bug, which is why it ships so often.
 *
 * The fix (Golus): flip each projection's u axis by the sign of the matching
 * world-normal component so all three frames agree (done in `triplanarBasis`),
 * fold the geometric normal into each sample's xy (the whiteout blend), then
 * swizzle each result into world space — zyx / xzy / xyz — before blending.
 */
function triplanarWorldNormal(basis: TriplanarBasis, samples: [N, N, N]): N {
  const n: N = basis.normal;
  const [tx, ty, tz] = samples;
  const bx: N = vec3(tx.x.add(n.z), tx.y.add(n.y), tx.z.abs().mul(n.x));
  const by: N = vec3(ty.x.add(n.x), ty.y.add(n.z), ty.z.abs().mul(n.y));
  const bz: N = vec3(tz.x.add(n.x), tz.y.add(n.y), tz.z.abs().mul(n.z));
  return normalize(
    bx.zyx
      .mul(basis.blend.x)
      .add(by.xzy.mul(basis.blend.y))
      .add(bz.xyz.mul(basis.blend.z)),
  );
}

/** World-space normal -> view space, which is what `material.normalNode` wants. */
function worldNormalToView(worldNormal: N): N {
  return worldNormal.transformNormalByViewMatrix(cameraViewMatrix).normalize();
}

// ---------------------------------------------------------------------------
// node graph wiring
// ---------------------------------------------------------------------------

export type MaterialTextures = Partial<Record<MaterialMapField, THREE.Texture>>;

/**
 * mix(1, occlusion, intensity), written the way three writes it
 * (`(ao - 1) * intensity + 1`).
 *
 * On uv2: three's *node* materials sample `aoMap` at `uv(texture.channel)` —
 * channel 0 unless something sets otherwise — so unlike the old WebGL
 * renderer there is no second-uv-set requirement to satisfy and nothing to
 * synthesise on meshes that lack uv2. Driving AO through `aoNode` at the
 * material's shared uv transform sidesteps the question entirely.
 */
function aoNodeFrom(occlusion: N, uniforms: MaterialUniforms): N {
  return occlusion.sub(1).mul(uniforms.aoIntensity).add(1);
}

/**
 * Attach loaded textures to a material's node graph.
 *
 * Everything goes through explicit nodes rather than three's `material.map` /
 * `material.normalMap` slots because each of those slots carries its OWN uv
 * transform (`texture.repeat`/`offset`) while the schema promises one shared
 * transform per material — and because the slots have no way to express a
 * detail overlay, a world-space projection, or a single-fetch ORM unpack.
 */
export function wireMaterialMaps(
  material: THREE.Material,
  data: MaterialData,
  textures: MaterialTextures,
): void {
  const uniforms = makeMaterialUniforms(material, data);
  const target = material as THREE.Material & {
    colorNode?: unknown;
    normalNode?: unknown;
    roughnessNode?: unknown;
    metalnessNode?: unknown;
    aoNode?: unknown;
    opacityNode?: unknown;
    emissiveNode?: unknown;
  };
  const triplanar = data.triplanar === true;
  const basis = triplanar ? triplanarBasis(uniforms) : null;
  const baseUv = triplanar ? null : uvTransformNode(uniforms);
  const sample = (texture: THREE.Texture): N =>
    basis ? triplanarSample(basis, texture) : (tslTexture(texture, baseUv) as N);

  // -- albedo -------------------------------------------------------------
  if (textures.map) {
    // color * vec4, mirroring three's own materialColor composition, so the
    // map's alpha still reaches diffuseColor.a the way it always did
    target.colorNode = (uniforms.color as N).mul(sample(textures.map));
  }

  // -- opacity mask -------------------------------------------------------
  if (textures.alphaMap) {
    // .g matches three's and glTF's greyscale-mask convention; a greyscale png
    // decodes to r == g == b, so the channel only matters for packed masks
    target.opacityNode = (uniforms.opacity as N).mul(sample(textures.alphaMap).g);
  }

  // -- emissive -----------------------------------------------------------
  if (textures.emissiveMap) {
    // The bloom pipeline's MRT split (renderer.ts) samples the `emissive`
    // output ONLY. Keep writing it through emissiveNode — a material that
    // stops populating emissive silently drops out of bloom.
    target.emissiveNode = (uniforms.emissive as N)
      .mul(uniforms.emissiveIntensity)
      .mul(sample(textures.emissiveMap).rgb);
  }

  // -- normals ------------------------------------------------------------
  const normalTexture = textures.normalMap;
  const detailTexture = textures.detailNormalMap;
  if (normalTexture || detailTexture) {
    if (basis) {
      // detail tiling in world space: `detailRepeat` is a UV-space number, so
      // in triplanar mode it is read as a DIVISOR on triplanarScale, and only
      // its u component — a world projection has no separate v axis to tile.
      const detailBasis = detailTexture
        ? triplanarBasis(
            uniforms,
            (uniforms.triplanarScale as N).div(max((uniforms.detailTransform as N).x, float(1e-4))),
          )
        : null;
      const axisUvs = [basis.uvX, basis.uvY, basis.uvZ];
      const detailUvs = detailBasis ? [detailBasis.uvX, detailBasis.uvY, detailBasis.uvZ] : null;
      const axisNormals = axisUvs.map((axisUv, i) => {
        let n: N = normalTexture
          ? decodeNormal(tslTexture(normalTexture, axisUv) as N, uniforms.normalScale)
          : null;
        if (detailTexture && detailUvs) {
          const d = decodeNormal(
            tslTexture(detailTexture, detailUvs[i]) as N,
            uniforms.detailStrength,
          );
          n = n ? reorientNormal(n, d) : d;
        }
        return n;
      }) as [N, N, N];
      target.normalNode = worldNormalToView(triplanarWorldNormal(basis, axisNormals));
    } else {
      let tangentNormal: N = normalTexture
        ? decodeNormal(tslTexture(normalTexture, baseUv) as N, uniforms.normalScale)
        : null;
      if (detailTexture) {
        const d = decodeNormal(
          tslTexture(detailTexture, detailUvNode(uniforms)) as N,
          uniforms.detailStrength,
        );
        tangentNormal = tangentNormal ? reorientNormal(tangentNormal, d) : d;
      }
      // Hand the blended normal back to three's NormalMapNode so TBN
      // construction (including its derivative fallback for geometry with no
      // tangent attribute) stays three's problem. The per-map strengths are
      // already applied above, hence the identity scale here.
      target.normalNode = normalMap(encodeNormal(tangentNormal), vec2(1, 1) as N);
    }
  }

  // -- roughness / metalness / AO ----------------------------------------
  if (textures.ormMap) {
    // ONE node instance, read three times: TSL emits a single fetch into a
    // temp and takes .r/.g/.b off it, which is the saving the schema promises.
    // Channels are the glTF convention: Occlusion R, Roughness G, Metalness B.
    const orm = sample(textures.ormMap);
    target.roughnessNode = (uniforms.roughness as N).mul(orm.g);
    target.metalnessNode = (uniforms.metalness as N).mul(orm.b);
    target.aoNode = aoNodeFrom(orm.r, uniforms);
  } else {
    // MULTIPLY, never replace (glTF/three semantics). The trap that creates is
    // documented on the schema: `roughness` defaults to 0.85 and `metalness`
    // to 0.05, so a map added without raising its scalar is mostly muted —
    // correct behaviour, not a bug to paper over.
    if (textures.roughnessMap) {
      target.roughnessNode = (uniforms.roughness as N).mul(sample(textures.roughnessMap).g);
    }
    if (textures.metalnessMap) {
      target.metalnessNode = (uniforms.metalness as N).mul(sample(textures.metalnessMap).b);
    }
    if (textures.aoMap) {
      target.aoNode = aoNodeFrom(sample(textures.aoMap).r, uniforms);
    }
  }

  material.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// async entry point
// ---------------------------------------------------------------------------

export interface TextureResolver {
  resolveTexture?(assetId: string): string | undefined;
  resolveMaxAnisotropy?(): number;
}

/**
 * Resolve every map this material uses and wire them once they have all
 * settled. The graph is wired in ONE pass rather than per texture: a node
 * material's compiled shader is keyed on its node graph, so attaching six
 * maps one at a time would mean six pipeline recompiles per material.
 *
 * Until the textures land the material renders as its flat colour — the same
 * pop-in the single-`map` path always had.
 */
export function applyMaterialMaps(
  material: THREE.Material,
  data: MaterialData,
  options: TextureResolver,
): void {
  makeMaterialUniforms(material, data);
  const state = materialState.get(material)!;
  const generation = ++state.generation;

  const fields = materialMapPlan(data);
  if (fields.length === 0) return;

  const maxAnisotropy = options.resolveMaxAnisotropy?.() ?? 0;
  const filter = (data.filter ?? "linear") as TextureFilter;
  const requests = fields.flatMap((field) => {
    const assetId = data[field] as string | undefined;
    const url = assetId ? options.resolveTexture?.(assetId) : undefined;
    if (!url) {
      if (assetId) console.warn(`[render] no texture asset "${assetId}" for material ${field}`);
      return [];
    }
    return [{ field, url, srgb: mapColorSpace(field) === "srgb" }];
  });
  if (requests.length === 0) return;

  void Promise.allSettled(
    requests.map((request) => loadSharedTexture(request.url, request.srgb, maxAnisotropy, filter)),
  ).then((results) => {
    // a newer applyMaterialMaps started while these were in flight — its graph
    // is the current one, so drop these instead of interleaving the two
    if (state.generation !== generation) return;
    const textures: MaterialTextures = {};
    results.forEach((result, i) => {
      const request = requests[i]!;
      if (result.status === "fulfilled") textures[request.field] = result.value;
      else console.warn(`[render] texture failed to load: ${request.url}`, result.reason);
    });
    if (Object.keys(textures).length === 0) return;
    wireMaterialMaps(material, data, textures);
  });
}
