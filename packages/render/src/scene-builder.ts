import * as THREE from "three/webgpu";
import { STATIC_BATCH_FLAG } from "./static-batch.js";
import { InstancedProps, applyInstanceUvRotation, applyInstancedProps } from "./instancing.js";
import { applyWorldUv } from "./primitive-uv.js";
import {
  positionWorld,
  positionLocal,
  positionView,
  normalWorld,
  cameraPosition,
  cameraNear,
  cameraFar,
  time,
  color as tslColor,
  float,
  mix,
  smoothstep,
  saturate,
  floor,
  clamp,
  add,
  sub,
  mul,
  div,
  dot,
  pow,
  max,
  sin,
  cos,
  abs,
  normalize,
  uv,
  vec2,
  vec3,
  vec4,
  length,
  attribute,
  normalLocal,
  modelWorldMatrix,
  cameraViewMatrix,
  hash,
  fract,
  step,
  cross,
  mx_fractal_noise_float,
  texture as tslTexture,
  uniform,
  viewportDepthTexture,
  perspectiveDepthToViewZ,
} from "three/tsl";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { applyFoliageNormals } from "./foliage-normals.js";
import { applyModelBrightness } from "./model-brightness.js";
import { applyFoliageWind, type FoliageWindOptions } from "./foliage-wind.js";
import { applyFoliageFade } from "./foliage-fade.js";
import { asNodeMaterial, cloneMaterial } from "./node-material.js";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  heightmapMesh,
  type HeightmapParams,
  type PolyMeshSource,
  type SceneDoc,
  type VoxelMesh,
  type VoxelMeshSource,
} from "@hitreg/core";
import { simplifierReady, simplifyGeometry } from "./mesh-simplify.js";
import {
  impostorGeometry,
  impostorInstanceData,
  impostorMaterial,
  impostorPageGeometry,
  impostorPageMaterial,
  writeImpostorSlot,
  type ImpostorAtlas,
  type ImpostorInstanceData,
} from "./impostor.js";
import { clusterDagReady, type ClusterDag } from "./cluster-dag.js";
import { ClusteredMesh, clusterDagFromGeometry } from "./clustered-mesh.js";
import { polyMeshGeometry } from "./poly-mesh-geometry.js";
import { horizonTint } from "./atmosphere.js";
import { buildTerrainSplatMaterial, type MacroNoiseData } from "./terrain-splat.js";
import { mergeModelSubmeshes } from "./static-batch.js";
import { voxelGeometry, voxelColliderProxyGeometry } from "./voxel-geometry.js";
import type { ParticlesData } from "./particles.js";
import type { BillboardData } from "./billboards.js";
import type { GrassData } from "./grass.js";
import type { InstancedPropBatch } from "./foliage-lod.js";
import type { InstancedPropPool } from "./prop-pool.js";
import { pathGeometry, type PathMeshSource } from "./path-mesh.js";
import { pathScatterPlacements, type PathScatterData } from "./path-scatter.js";
import { flushDecals, syncEntityDecals, type DecalData, type DecalRequest } from "./decals.js";
import { DEFAULT_SHADOW_SETTINGS, applyShadowSettings, type ShadowSettings } from "./csm.js";
import { DEFAULT_VOLUMETRIC_SETTINGS, type FogSettings, type VolumetricSettings } from "./atmosphere.js";
import type { EnvironmentSettings } from "./environment.js";
import { SceneLighting, SKY_DOME_UNIFORMS, type SkyData, type SkyDomeUniforms } from "./scene-lighting.js";
import {
  applyMaterialCommon,
  applyMaterialMaps,
  makeMaterialUniforms,
  materialMapKey,
  materialMapKeyOf,
  materialSourceOf,
  materialUniformsOf,
  resolveTransparency,
  setMaterialSource,
  writeMaterialUniforms,
  type TextureResolver,
  applyModelTextureFilter,
  type TextureFilter,
} from "./material-maps.js";

// kits load once and instance many times
const gltfCache = new Map<string, Promise<GLTF>>();
// urls currently fetching/parsing (not yet in gltfCache's resolved state) —
// the host surfaces this count so "is it stuck or just loading" is visible
// instead of a silent, indefinite freeze (see gltfLoadingCount).
const gltfPending = new Set<string>();

export function loadGltf(url: string): Promise<GLTF> {
  let pending = gltfCache.get(url);
  if (!pending) {
    gltfPending.add(url);
    pending = (gltfLoader ??= new GLTFLoader())
      .loadAsync(url)
      .then((gltf) => {
        shareNamedTextures(gltf.scene);
        return gltf;
      })
      .finally(() => gltfPending.delete(url));
    gltfCache.set(url, pending);
  }
  return pending;
}

/** Prefix the kit-import tools give a glTF texture whose bytes are shared by many files. */
export const SHARED_TEXTURE_PREFIX = "hitreg-shared:";

// name -> the first texture loaded under it; every later model swaps its own
// copy for this one
const sharedTextures = new Map<string, THREE.Texture>();

/** Once-per-asset warning for uvRotation on a render mode that ignores it. */
const uvRotationWarned = new Set<string>();

/**
 * Share textures across separately loaded models by name.
 *
 * A WFC kit is N self-contained module files (the asset bridge resolves no
 * sidecars) that all embed the SAME atlas, and GLTFLoader decodes and
 * uploads each file's copy on its own — N modules × one 2048² atlas would
 * be N GPU textures of identical bytes. The kit tools name that image
 * `hitreg-shared:<content-hash>` (GLTFLoader carries the glTF texture name,
 * else the image name, onto `texture.name`), so the first copy seen under a
 * name wins, later copies are replaced on their materials and disposed.
 * Only the texture object is swapped — the tools guarantee identical
 * sampler/colour-space settings for identical bytes. Returns how many
 * material slots were re-pointed.
 */
export function shareNamedTextures(root: THREE.Object3D): number {
  let swapped = 0;
  const disposed = new Set<THREE.Texture>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const slots = material as unknown as Record<string, unknown>;
      for (const slot of Object.keys(slots)) {
        const texture = slots[slot] as THREE.Texture | null | undefined;
        if (!texture || texture.isTexture !== true) continue;
        if (!texture.name.startsWith(SHARED_TEXTURE_PREFIX)) continue;
        const shared = sharedTextures.get(texture.name);
        if (!shared) {
          sharedTextures.set(texture.name, texture);
          continue;
        }
        if (shared === texture) continue;
        slots[slot] = shared;
        swapped += 1;
        if (!disposed.has(texture)) {
          disposed.add(texture);
          texture.dispose();
        }
        material.needsUpdate = true;
      }
    }
  });
  return swapped;
}

/** Number of glTF models currently being fetched/parsed, for a loading indicator. */
export function gltfLoadingCount(): number {
  return gltfPending.size;
}

export interface BuildOptions {
  /** Resolve a mesh asset id to a fetchable glTF/GLB URL (from the AssetLibrary). */
  resolveModel?(assetId: string): string | undefined;
  /**
   * Mesh a voxel cell off the main thread, for HLOD proxies.
   *
   * An HLOD supercell re-meshes each of its member cells on a coarser lattice
   * — a separate marching-cubes run per cell, up to 16 of them in one bake —
   * and that was the largest remaining main-thread stall while streaming.
   * Return null (or leave the hook unset) and the builder meshes inline, which
   * is what the headless tooling and the tests do.
   */
  voxelMeshAsync?(source: VoxelMeshSource): Promise<VoxelMesh | null> | null;
  /**
   * Mesh AND merge a supercell's terrain buckets off the main thread.
   *
   * Preferred over `voxelMeshAsync` for HLOD, because the merge itself — one
   * matrix multiply per vertex plus the concatenation — outweighed the meshing
   * once the meshing had moved, and doing both on the far side means one
   * transfer per material rather than one per cell. Unset (or null) and the
   * builder falls back to `voxelMeshAsync`, then to meshing inline.
   */
  voxelSupercellAsync?(
    buckets: Array<{ key: string; cells: Array<{ source: VoxelMeshSource; matrix: number[] }> }>,
  ): Promise<Array<{ key: string; mesh: VoxelMesh }>> | null;
  /**
   * How much coarser voxel cells are meshed in an HLOD proxy build (lattice
   * step multiplier). Unset: the builder's default (4). The chunk manager
   * passes a larger value for supercells that lie entirely in the FAR ring,
   * which is what lets that ring reach twice as far for the same cost.
   */
  hlodVoxelCoarsen?: number;
  /** Resolve a material asset id to its (schema-validated) material data. */
  resolveMaterial?(assetId: string): unknown | undefined;
  /** Resolve a texture asset id to a fetchable image URL. */
  resolveTexture?(assetId: string): string | undefined;
  /**
   * Hardware anisotropic filtering cap (renderer.getMaxAnisotropy()) applied
   * to material color/emissive maps, so ground/road textures stay sharp at
   * shallow viewing angles. Omit to leave three.js's default (1, i.e. off) —
   * used by lightweight preview builds (thumbnails) that don't need it.
   */
  resolveMaxAnisotropy?(): number;
  /** Fired when an asset mesh finishes loading (animation clips included). */
  onModelLoaded?(entityId: string, root: THREE.Object3D, clips: THREE.AnimationClip[]): void;
  /** Fired for each `particles` entity — the app registers it with its
   * ParticleSystem (the builder stays free of the simulation). `group` is the
   * entity's anchor group; the system parents its InstancedMesh under it. */
  onParticles?(entityId: string, group: THREE.Object3D, data: ParticlesData): void;
  /** Fired for every real light so the host can apply a camera-relative
   * dynamic-light budget without traversing the complete scene each frame. */
  onLight?(entityId: string, light: THREE.Light, importance: number): void;
  /** Fired for each `billboard` entity — the app registers it with its
   * BillboardSystem (the builder stays free of the canvas drawing). `group` is
   * the entity's anchor group; the system parents its Sprite under it. */
  onBillboard?(entityId: string, group: THREE.Object3D, data: BillboardData): void;
  /** Fired for each `grass` entity — the app registers it with its
   * GrassSystem (the builder stays free of the placement/wind simulation).
   * `group` is the entity's anchor group; the system parents its
   * InstancedMesh under it, then treats it as world-space (see GrassSystem). */
  onGrass?(entityId: string, group: THREE.Object3D, data: GrassData): void;
  /** Fired once per `renderMode: "instanced"` (assetId, node) group — the app
   * registers it with a FoliageLodSystem to drive near/far distance LOD. */
  onInstancedBatch?(batch: InstancedPropBatch): void;
  /**
   * Bake an octahedral impostor atlas of `object` (a throwaway clone — safe
   * to reparent/mutate/dispose) whose model-space bounds are `bounds`: the
   * model from a grid of directions over the upper hemisphere, as albedo +
   * model-space normals (see impostor.ts). The app owns the live renderer
   * this needs (the same render-to-texture technique as the prefab/model
   * thumbnail previews); returns null if unavailable, in which case the far
   * tier falls back to primitive proxies (cross-billboard / box) using the
   * model's own material/color.
   */
  bakeImpostor?(object: THREE.Object3D, bounds: THREE.Box3): ImpostorAtlas | null;
  /**
   * World-level instanced batches shared across builds (see prop-pool.ts).
   * With both this and `instancePoolOwner` set, `renderMode: "instanced"`
   * entities without a `uvRotation` join the pool on behalf of the owner
   * instead of getting per-build batches; the host releases the owner when
   * the build (a streamed cell) unloads.
   */
  instancePool?: InstancedPropPool;
  instancePoolOwner?: object;
  /**
   * Fired for every mesh a `renderMode: "clustered"` asset entity turned
   * into a `ClusteredMesh` (cluster-DAG continuous LOD, clustered-mesh.ts).
   * The app registers it with its `ClusterLodSystem`, which re-selects the
   * cut each frame; an unregistered ClusteredMesh still renders, at full
   * detail. Meshes dropped from the scene are pruned by the system itself.
   */
  onClusteredMesh?(entityId: string, mesh: ClusteredMesh): void;
}

export interface SplatLayerData {
  color: string;
  roughness: number;
  heightStart: number;
  heightEnd: number;
  grassy?: boolean;
}

export interface MaterialData {
  shader: "standard" | "unlit" | "toon" | "wireframe" | "terrain-splat" | "water";
  color: string;
  map?: string;
  repeat: [number, number];
  /** Shared with every other map on this material — there is no per-map offset. */
  uvOffset?: [number, number];
  roughness: number;
  metalness: number;
  normalMap?: string;
  normalScale?: number;
  /** Multiplies the `roughness` scalar, never replaces it. */
  roughnessMap?: string;
  /** Multiplies the `metalness` scalar, never replaces it. */
  metalnessMap?: string;
  aoMap?: string;
  aoIntensity?: number;
  /** Packed Occlusion/Roughness/Metalness (R/G/B). Takes precedence over the three above. */
  ormMap?: string;
  detailNormalMap?: string;
  detailRepeat?: [number, number];
  detailStrength?: number;
  /** Texture magnification: "nearest" for pixel art. See configureTexture. */
  filter?: "linear" | "nearest";
  triplanar?: boolean;
  triplanarScale?: number;
  alphaMap?: string;
  alphaTest?: number;
  envMapIntensity?: number;
  side?: "front" | "back" | "double";
  vertexColors?: boolean;
  emissive: string;
  emissiveIntensity: number;
  emissiveMap?: string;
  opacity: number;
  transparent: boolean;
  splat?: {
    layers: SplatLayerData[];
    slopeRock?: { color: string; roughness: number; start: number; end: number };
    macroNoise?: MacroNoiseData;
  };
  water?: {
    shallowColor: string;
    midColor: string;
    deepColor: string;
    rimColor: string;
    foamColor: string;
    waveFrequency: number;
    waveSpeed: number;
    waveAmplitude: number;
    fresnelPower: number;
    depthFadeDistance: number;
    foamWidth: number;
    edgeFadeStart: number;
    edgeFadeEnd: number;
    /** Scrolling surface texture added over the procedural water. */
    texture?: string;
    textureScale?: number;
    textureStrength?: number;
    foamPixel?: number;
    foamSteps?: number;
    flow?: [number, number];
    /** drift = standing water laid out in world space; channel = the geometry's `flow` attribute + metre uvs carry the current. */
    flowMode?: "drift" | "channel";
    /** false: wave normals only, no vertex motion (lake sheets, ribbons). */
    displace?: boolean;
  };
}

let gltfLoader: GLTFLoader | null = null;

interface TransformData {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

interface MeshData {
  source:
    | {
        kind: "primitive";
        shape: string;
        size: [number, number, number];
        segments?: [number, number];
        shading?: "auto" | "flat" | "smooth";
        uv?: { mode?: "stretch" | "world"; scale?: [number, number] };
      }
    | {
        kind: "asset";
        assetId: string;
        node?: string;
        foliageNormals?: number;
        foliageUp?: number;
        brightness?: number;
        textureFilter?: TextureFilter;
        wind?: FoliageWindOptions;
        cameraFade?: boolean;
        uvRotation?: number;
      }
    | {
        kind: "polygon";
        points: Array<[number, number]>;
        height: number;
        bevel?: { size: number; segments: number };
      }
    | ({ kind: "heightmap" } & HeightmapParams)
    | VoxelMeshSource
    | ({ kind: "path" } & PathMeshSource)
    | PolyMeshSource;
  material?: string;
  castShadow: boolean;
  receiveShadow: boolean;
  renderMode?: "auto" | "instanced" | "clustered";
  lod?: boolean;
  /** Authoring hint that this mesh never moves — drives static draw-call
   * batching (static-batch.ts). Read here only to tag the built mesh. */
  static?: boolean;
}

export function polygonGeometry(source: {
  points: Array<[number, number]>;
  height: number;
  bevel?: { size: number; segments: number };
}): THREE.BufferGeometry {
  const shape = new THREE.Shape(source.points.map(([x, y]) => new THREE.Vector2(x, y)));
  const bevelSize = source.bevel?.size ?? 0;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: source.height,
    bevelEnabled: bevelSize > 0,
    bevelSize,
    bevelThickness: bevelSize,
    bevelSegments: source.bevel?.segments ?? 2,
    curveSegments: 8,
  });
  // extrude runs along +Z; stand it up so it rises along +Y
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

interface LightData {
  kind: "directional" | "point" | "spot" | "ambient";
  color: string;
  intensity: number;
  range: number;
  angle: number;
  castShadow: boolean;
  importance?: number;
  /** directional + castShadow only — shadow camera ortho frustum half-width. */
  shadowSize?: number;
  /** `light.shadow`; every field optional here because old docs predate it. */
  shadow?: Partial<ShadowSettings>;
}

/**
 * Fill `light.shadow` from a doc that may predate the block entirely. The
 * defaults are the values that were hardcoded here before the schema existed,
 * so a scene with no `shadow` block renders exactly as it did.
 */
function shadowSettingsOf(data: LightData): ShadowSettings {
  const raw = data.shadow;
  if (!raw) return DEFAULT_SHADOW_SETTINGS;
  return {
    enabled: raw.enabled ?? DEFAULT_SHADOW_SETTINGS.enabled,
    mapSize: raw.mapSize ?? DEFAULT_SHADOW_SETTINGS.mapSize,
    bias: raw.bias ?? DEFAULT_SHADOW_SETTINGS.bias,
    normalBias: raw.normalBias ?? DEFAULT_SHADOW_SETTINGS.normalBias,
    radius: raw.radius ?? DEFAULT_SHADOW_SETTINGS.radius,
    cascades: raw.cascades ?? DEFAULT_SHADOW_SETTINGS.cascades,
    cascadeSplit: raw.cascadeSplit ?? DEFAULT_SHADOW_SETTINGS.cascadeSplit,
    far: raw.far ?? DEFAULT_SHADOW_SETTINGS.far,
  };
}

/**
 * Fill in the `sky` sub-blocks a doc may predate. This matters more than the
 * usual defaulting: `FogSystem` branches on `fog.mode`, and a doc written
 * before `mode` existed has none — without this it would fall through to the
 * exponential/height node and a scene that had plain linear fog yesterday
 * would not match today. The defaults here are the schema's own.
 */
function normalizeSky(sky: SkyData): SkyData {
  const rawFog = sky.fog as Partial<FogSettings> | undefined;
  const fog: FogSettings | undefined = rawFog
    ? {
        color: rawFog.color ?? "#101522",
        mode: rawFog.mode ?? "linear",
        near: rawFog.near ?? 40,
        far: rawFog.far ?? 180,
        density: rawFog.density ?? 0.015,
        heightFalloff: rawFog.heightFalloff ?? 0.15,
        baseHeight: rawFog.baseHeight ?? 0,
      }
    : undefined;
  const rawVolumetric = sky.volumetric as Partial<VolumetricSettings> | undefined;
  const volumetric: VolumetricSettings = {
    enabled: rawVolumetric?.enabled ?? DEFAULT_VOLUMETRIC_SETTINGS.enabled,
    intensity: rawVolumetric?.intensity ?? DEFAULT_VOLUMETRIC_SETTINGS.intensity,
    samples: rawVolumetric?.samples ?? DEFAULT_VOLUMETRIC_SETTINGS.samples,
    decay: rawVolumetric?.decay ?? DEFAULT_VOLUMETRIC_SETTINGS.decay,
    density: rawVolumetric?.density ?? DEFAULT_VOLUMETRIC_SETTINGS.density,
  };
  const rawEnvironment = sky.environment as Partial<EnvironmentSettings> | undefined;
  // "sky" and not "none" even when the block is absent: this is the schema
  // default, and it is the whole fix for `metalness: 1` reading near-black.
  const environment: EnvironmentSettings = {
    mode: rawEnvironment?.mode ?? "sky",
    hdri: rawEnvironment?.hdri,
    intensity: rawEnvironment?.intensity ?? 1,
    rotation: rawEnvironment?.rotation ?? 0,
  };
  return { ...sky, fog, volumetric, environment };
}

interface CameraData {
  fov: number;
  near: number;
  far: number;
  active: boolean;
}

export interface BuiltScene {
  scene: THREE.Scene;
  /** Entity id -> the Object3D representing that entity. */
  objects: Map<string, THREE.Object3D>;
  /** The camera marked active in the doc, if any. */
  activeCamera: THREE.PerspectiveCamera | null;
  /** Every camera-component entity — multi-camera switching at runtime. */
  cameras: Map<string, THREE.PerspectiveCamera>;
  /**
   * Material-asset id -> the shared THREE.Material instance built for it (the
   * build/reconcile cache, deduped by id). Reused across reconciles so an
   * instance stays stable, which lets a live material-file edit patch the
   * running material in place (see `patchMaterial`) instead of forcing a full
   * scene rebuild. Excludes GLB-embedded materials and the shared default.
   */
  materials: Map<string, THREE.Material>;
  /**
   * Fog, IBL, cascades and volumetric intent for this scene. Also reachable
   * from `sceneLighting(built.scene)` — which is how `EngineRenderer` finds it
   * without the host having to pass it anywhere.
   */
  lighting: SceneLighting;
}

const defaultMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa0a8,
  roughness: 0.85,
  metalness: 0.05,
});

/**
 * Gradient dome, procedural (per-pixel, not per-vertex): a smooth vertical
 * gradient, a horizon haze band (skies always lighten near the horizon —
 * atmospheric scattering, faked cheaply), and an optional soft sun glow. All
 * computed from the dome geometry's own local position (this mesh is
 * centered on the camera, so a point on its surface IS the view direction),
 * no textures needed. `sun` direction is fixed, not tied to any actual light
 * in the scene — see the `sky.sun` schema doc for that tradeoff.
 */
function buildSkyDome(
  top: string,
  bottom: string,
  sun?: { direction: [number, number, number]; color: string; size: number; intensity: number },
  moon?: { direction: [number, number, number]; color: string; size: number; intensity: number },
  stars?: { intensity: number; density: number; size: number },
  clouds?: { coverage: number; scale: number; speed: [number, number]; softness: number; color: string; shadow: string },
): THREE.Mesh {
  // defensive: production sky data is always zod-validated (top/bottom always
  // real hex strings) before it reaches here, but TSL's color() warns loudly
  // on undefined rather than the old vertex-color path's silent THREE.Color
  // fallback — stay equally tolerant of incomplete/malformed input.
  const topColor = top || "#5fa9ff";
  const bottomColor = bottom || "#101522";
  const radius = 450;
  const geometry = new THREE.SphereGeometry(radius, 32, 20);
  // depthWrite:false alone only means the dome never BLOCKS what's drawn
  // after it — still correct only as long as it's genuinely drawn first
  // every frame (renderOrder below) and nothing already occupies the depth
  // buffer at those pixels. depthTest:false removes that assumption
  // entirely: the dome always paints its background pixels regardless of
  // whatever the depth buffer currently holds there, so it's guaranteed
  // behind every other object unconditionally, not just by convention.
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    depthTest: false,
  });
  // Every knob is a uniform, so a day/night script can drive the sky every
  // frame without a rebuild (SceneLighting.setSkyLive). The sun and moon
  // discs are always in the shader; an intensity of 0 is how one is absent.
  const uniforms: SkyDomeUniforms = {
    top: uniform(new THREE.Color(topColor)),
    bottom: uniform(new THREE.Color(bottomColor)),
    sunDirection: uniform(new THREE.Vector3(...(sun?.direction ?? [0.4, 0.55, 0.3])).normalize()),
    sunColor: uniform(new THREE.Color(sun?.color ?? "#fff6df")),
    sunSize: uniform(sun?.size ?? 0.997),
    sunIntensity: uniform(sun?.intensity ?? 0),
    moonDirection: uniform(new THREE.Vector3(...(moon?.direction ?? [-0.4, 0.55, -0.3])).normalize()),
    moonColor: uniform(new THREE.Color(moon?.color ?? "#c9d6f2")),
    moonSize: uniform(moon?.size ?? 0.9994),
    moonIntensity: uniform(moon?.intensity ?? 0),
    starsIntensity: uniform(stars?.intensity ?? 0),
    starsDensity: uniform(stars?.density ?? 0.35),
    starsSize: uniform(stars?.size ?? 1),
    starsRotation: uniform(new THREE.Vector4(0, 0, 0, 1)),
    cloudCoverage: uniform(clouds?.coverage ?? 0),
    cloudScale: uniform(clouds?.scale ?? 1),
    cloudSpeed: uniform(new THREE.Vector2(...(clouds?.speed ?? [0.6, 0.2]))),
    cloudSoftness: uniform(clouds?.softness ?? 0.35),
    cloudColor: uniform(new THREE.Color(clouds?.color ?? "#ffffff")),
    cloudShadow: uniform(new THREE.Color(clouds?.shadow ?? "#8a94a8")),
    cloudLight: uniform(1),
  };
  // TSL's generics cannot follow uniform-typed colours through mix/pow/add;
  // the graph is the same one the constant version built, just with uniforms
  // in the leaves.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const u = uniforms as unknown as Record<keyof SkyDomeUniforms, any>;
  const dir: any = normalize(positionLocal);
  const t: any = pow(clamp(mul(add(dir.y, float(0.35)), float(1 / 1.35)), 0, 1), float(0.9));
  let colorNode: any = mix(u.bottom, u.top, t);
  // horizon haze: lighten toward the bottom color near dir.y == 0
  const hazeAmount: any = sub(float(1), smoothstep(float(0), float(0.22), abs(dir.y)));
  colorNode = mix(colorNode, u.bottom, mul(hazeAmount, float(0.6)));
  // soft sun glow: a wide falloff shaped by `size` (closer to 1 = tighter)
  const sunFacing: any = clamp(dot(dir, normalize(u.sunDirection)), 0, 1);
  const sunGlow: any = mul(pow(sunFacing, float(1).div(float(1).sub(u.sunSize))), u.sunIntensity);
  colorNode = add(colorNode, mul(u.sunColor, sunGlow));
  // moon: a tight disc plus a faint halo (a quarter of the disc's brightness,
  // a much wider falloff), so it reads as a body with a glow rather than a dot
  const moonFacing: any = clamp(dot(dir, normalize(u.moonDirection)), 0, 1);
  const moonDisc: any = pow(moonFacing, float(1).div(float(1).sub(u.moonSize)));
  const moonHalo: any = mul(pow(moonFacing, float(220)), float(0.18));
  const moonGlow: any = mul(add(moonDisc, moonHalo), u.moonIntensity);
  colorNode = add(colorNode, mul(u.moonColor, moonGlow));
  // stars: a hashed lattice on the (rotated) view direction — one candidate
  // point per cell, lit when its hash clears the density threshold, drawn as
  // a soft dot with a slow twinkle. Faded out at the horizon and under the
  // haze band, and scaled by `starsIntensity`, which a day/night script
  // raises as the sun sets. A few ALU ops per sky pixel; no texture.
  const rq: any = u.starsRotation;
  const rt: any = cross(rq.xyz, dir).mul(2);
  const dirStars: any = dir.add(rt.mul(rq.w)).add(cross(rq.xyz, rt));
  const lattice: any = dirStars.mul(float(110));
  const cell: any = floor(lattice);
  const inCell: any = sub(sub(lattice, cell), float(0.5));
  const h0: any = hash(dot(cell, vec3(1, 57, 113)));
  const h1: any = hash(h0.mul(91.3));
  const h2: any = hash(h0.mul(7.7));
  const h3: any = hash(h0.mul(3.1));
  const lit: any = step(sub(float(1), mul(u.starsDensity, float(0.25))), h0);
  const offset: any = sub(vec3(h1, h2, h3), float(0.5)).mul(0.6);
  const dist: any = length(sub(inCell, offset));
  const dot_: any = smoothstep(mul(float(0.17), u.starsSize), float(0), dist);
  const twinkle: any = add(float(0.7), mul(sin(add(mul(time, float(2)), mul(h1, float(40)))), float(0.3)));
  const starFade: any = mul(smoothstep(float(0.02), float(0.2), dir.y), sub(float(1), hazeAmount));
  const starLight: any = mul(mul(mul(mul(lit, dot_), twinkle), add(float(0.6), mul(h2, float(0.9)))), mul(u.starsIntensity, starFade));
  colorNode = add(colorNode, mul(vec3(0.85, 0.9, 1.0), starLight));
  // clouds: the view direction projected onto a plane above the camera,
  // fractal noise drifting with the wind, thresholded by coverage. Composited
  // LAST so a cloud hides the sun, the moon and the stars behind it. Thicker
  // cloud falls toward the shadow colour; `cloudLight` is what a day/night
  // script dims at night and warms at dawn. Faded out toward the horizon,
  // where the projection stretches to infinity.
  // a softened projection: a true plane stretches to infinity at the horizon,
  // which turned every cloud into a streak; blending the divisor toward a
  // constant keeps distant clouds compact
  const planeY: any = add(mul(max(dir.y, float(0)), float(0.7)), float(0.3));
  const plane: any = vec2(dir.x, dir.z).div(planeY).mul(mul(float(0.35), u.cloudScale));
  const drift: any = plane.add(mul(u.cloudSpeed, mul(time, float(0.02))));
  const noise: any = mx_fractal_noise_float(vec3(drift.x, drift.y, mul(time, float(0.01))), 4, 2.2, 0.5, 1);
  const density: any = add(mul(noise, float(0.5)), float(0.5));
  const threshold: any = sub(float(1), u.cloudCoverage);
  const cloudAlpha: any = mul(
    smoothstep(threshold, add(threshold, u.cloudSoftness), density),
    smoothstep(float(0.0), float(0.14), dir.y),
  );
  const thickness: any = smoothstep(threshold, float(1), density);
  const cloudColor: any = mul(mix(u.cloudColor, u.cloudShadow, mul(thickness, float(0.75))), u.cloudLight);
  colorNode = mix(colorNode, cloudColor, mul(cloudAlpha, float(0.96)));
  /* eslint-enable @typescript-eslint/no-explicit-any */
  material.colorNode = colorNode;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  // a fixed-radius BackSide sphere only reads as an infinite background while
  // the camera stays inside it — this mesh is never itself repositioned, so
  // the host must recenter it on the camera every frame (the standard
  // infinite-skybox trick); tag it so the host can find it after a rebuild
  // recreates the whole scene graph (main.ts: userData["skyDome"] === true).
  mesh.userData["skyDome"] = true;
  mesh.userData[SKY_DOME_UNIFORMS] = uniforms;
  return mesh;
}

/** Triangular prism rising toward +Z — the graybox ramp. */
function wedgeGeometry(w: number, h: number, d: number): THREE.BufferGeometry {
  const x = w / 2;
  const z = d / 2;
  // prettier-ignore
  const positions = new Float32Array([
    // bottom (y=0)
    -x, 0, -z,  x, 0,  z,  x, 0, -z,
    -x, 0, -z, -x, 0,  z,  x, 0,  z,
    // back vertical face (z=+z)
    -x, 0,  z, -x, h,  z,  x, h,  z,
    -x, 0,  z,  x, h,  z,  x, 0,  z,
    // slope (from front-bottom edge to back-top edge)
    -x, 0, -z,  x, h,  z, -x, h,  z,
    -x, 0, -z,  x, 0, -z,  x, h,  z,
    // left triangle (x=-x)
    -x, 0, -z, -x, h,  z, -x, 0,  z,
    // right triangle (x=+x)
     x, 0, -z,  x, 0,  z,  x, h,  z,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function geometryFor(
  shape: string,
  size: [number, number, number],
  segments?: [number, number],
  shading?: "auto" | "flat" | "smooth",
  uv?: { mode?: "stretch" | "world"; scale?: [number, number] },
): THREE.BufferGeometry {
  const geometry = buildPrimitive(shape, size, segments);
  // World UVs are generated before any flat-shading split: toNonIndexed copies
  // the uv attribute along with the rest, and doing it here means the split
  // (which triples the vertex count) happens once over already-correct data.
  if (uv?.mode === "world") applyWorldUv(geometry, shape, size, uv.scale ?? [1, 1]);
  if (shading !== "flat") return geometry;
  // Three generates ANALYTIC normals around a ring, so an 8-sided cylinder
  // renders as a faceted outline with a perfectly smooth gradient across it —
  // the authored low-poly form still reads as a smooth cylinder. Un-indexing
  // splits shared vertices so computeVertexNormals() gives each triangle its
  // own face normal, which is what makes the flats catch different light
  // values. Vertex count becomes 3x the triangle count, hence the schema's
  // warning against using this on dense meshes.
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  geometry.dispose();
  return flat;
}

/**
 * Apply the size axes a round primitive's constructor cannot express.
 *
 * three's round generators take a RADIUS (plus a height), so they can only make
 * shapes with a circular cross-section — the remaining `size` components have
 * nowhere to go and used to be dropped on the floor. Scaling the finished
 * geometry recovers them. `applyMatrix4` transforms normals through the normal
 * matrix, so a squashed sphere still lights correctly rather than keeping the
 * normals of the ball it was built as.
 *
 * `heightIsExact` marks the shapes whose constructor already consumed `y` as a
 * real height (cylinder/cone/capsule): those only need their DEPTH corrected.
 * A sphere consumed nothing but `x`, so it needs both.
 */
function ellipsoidal(
  geometry: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  heightIsExact = false,
): THREE.BufferGeometry {
  if (!(x > 0)) return geometry;
  const sy = heightIsExact ? 1 : y / x;
  const sz = z / x;
  // exact 1s are the overwhelmingly common case (a real sphere, a round
  // column); skip the matrix entirely so nothing moves by a float epsilon
  if (sy === 1 && sz === 1) return geometry;
  geometry.scale(1, Number.isFinite(sy) && sy > 0 ? sy : 1, Number.isFinite(sz) && sz > 0 ? sz : 1);
  return geometry;
}

function buildPrimitive(
  shape: string,
  size: [number, number, number],
  segments?: [number, number],
): THREE.BufferGeometry {
  const [x, y, z] = size;
  // `segments` used to be read by `plane` alone, which made every round
  // primitive a fixed high-poly form: a 24-sided cylinder, a 32x16 sphere.
  // That silently blocks a deliberately faceted low-poly art direction — there
  // was no way to author an 8-sided column, and the tessellation is exactly
  // the thing such a style needs to control. Each shape now reads the segment
  // counts it actually has, DEFAULTING TO THE PREVIOUS LITERALS so existing
  // content tessellates identically.
  //
  // The subtlety: `segments` is schema-DEFAULTED to [1, 1], so it is always
  // present after validation and "absent" cannot be detected. For a flat plane
  // or box [1, 1] is a legitimate value (one quad), but for a round shape a
  // 1-segment ring is degenerate — so on those, anything below `min` means
  // "not authored" and falls back to the historical literal. That keeps every
  // existing document, which carries a literal [1, 1], tessellating exactly as
  // it did before.
  const seg = (i: 0 | 1, fallback: number, min = 1): number => {
    const v = segments?.[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    const n = Math.floor(v);
    return n >= min ? n : fallback;
  };
  /** Radial rings need >= 3 to enclose anything. */
  const RING = 3;
  switch (shape) {
    case "wedge":
      return wedgeGeometry(x, y, z);
    case "box":
      // Flat shape: [1, 1] is a legitimate authored value (one quad per face),
      // so no RING floor. Depth follows width — the schema has two numbers.
      return new THREE.BoxGeometry(x, y, z, seg(0, 1), seg(1, 1), seg(0, 1));
    case "sphere":
      // A sphere used to take its radius from size[0] and SILENTLY DISCARD
      // size[1] and size[2], so `[1.7, 0.55, 1.5]` — an author asking for a low
      // dome — rendered as a 1.7m ball, three times too tall, with nothing
      // logged. `size` is documented as [x, y, z] and now means it on every
      // shape: the round axes are applied as a scale about the origin. Equal
      // values reduce to exactly the old geometry, so existing content that
      // authored a real sphere is untouched.
      return ellipsoidal(
        new THREE.SphereGeometry(x / 2, seg(0, 32, RING), seg(1, 16, 2)),
        x,
        y,
        z,
      );
    case "plane":
      return new THREE.PlaneGeometry(x, z, seg(0, 1), seg(1, 1));
    case "cylinder":
      // [radial, height]. Radial is the style control: 6-12 gives visible
      // flats, 24+ reads as smooth. z scales the cross-section's depth, so an
      // oval pier is authorable; z === x is the circular case and unchanged.
      return ellipsoidal(
        new THREE.CylinderGeometry(x / 2, x / 2, y, seg(0, 24, RING), seg(1, 1)),
        x,
        y,
        z,
        true,
      );
    case "capsule":
      return ellipsoidal(
        new THREE.CapsuleGeometry(x / 2, Math.max(0, y - x), seg(1, 8, 2), seg(0, 16, RING)),
        x,
        y,
        z,
        true,
      );
    case "cone":
      return ellipsoidal(
        new THREE.ConeGeometry(x / 2, y, seg(0, 24, RING), seg(1, 1)),
        x,
        y,
        z,
        true,
      );
    case "torus":
      return new THREE.TorusGeometry(x / 2, y / 4, seg(1, 16, RING), seg(0, 48, RING));
    default:
      return new THREE.BoxGeometry(x, y, z);
  }
}

/**
 * Build a Three.js scene graph from an EXPANDED scene doc (prefabs already
 * resolved via expandScene). Each entity becomes a Group; component visuals
 * hang off it, so transform updates touch only the group.
 */

/**
 * Procedural water: real vertex-displaced waves (not just a color shimmer),
 * a toon-banded shallow/mid/deep depth ramp with a crisp shoreline foam
 * edge (hard-ish cutoffs, not smooth gradients — the stylized-water look
 * this was asked to read as), plus the original bounded, art-directed
 * fresnel rim (deliberately hand-capped, not MeshStandardMaterial's
 * physically-based specular: an unclamped GGX highlight across a huge flat
 * plane at grazing angles is what was blowing bloom out at distance).
 *
 * Depth-based color/foam read `viewportDepthTexture()` — the already-
 * rendered OPAQUE scene's depth at this fragment's screen position — and
 * compare it to this fragment's own view-space depth (`positionView.z`) to
 * get how much water is between the surface and the seafloor/terrain along
 * this view ray (the standard real-time approximation: view-ray depth, not
 * literal vertical depth, but reads correctly for any camera angle a flight
 * game actually uses). This needs NO renderer changes — `viewportDepthTexture`
 * is a self-contained TSL node backed by a shared depth texture that Three's
 * WebGPU renderer populates automatically from ordinary opaque rendering, as
 * long as this material renders AFTER the opaque pass (already true: it's
 * `transparent: true`, and three.js always draws the transparent queue after
 * the opaque one). Needs REAL geometry — terrain/seafloor — actually beneath
 * the surface to compare against; open water with nothing in view behind it
 * just reads as "very deep," which is the correct fallback.
 *
 * A large-but-finite water plane always has a physical edge somewhere; rather
 * than chase that edge with an ever-bigger mesh (or recentering the whole
 * plane on the camera every frame, which would also need the wave phases
 * compensated for the resulting motion so they don't visibly "swim"), opacity
 * fades to fully transparent by `edgeFadeEnd` — comfortably inside the
 * mesh's actual bounds — so the edge itself is never in view from any
 * direction the camera can approach it from.
 *
 * Wave displacement is phased in WORLD space and applied along the surface's
 * own normal, so one material serves the ocean plane (rotated flat), the
 * per-cell lake sheets and the river ribbons alike, and sheets streamed in
 * separate cells agree exactly along a shared edge (see the waves block for
 * the gap this replaced). Two summed waves at different frequencies/
 * directions/speeds read as far less mechanical than one; the surface normal
 * is perturbed by each wave's own analytic partial derivative (closed-form,
 * not numerically sampled) so lighting responds to the bumps instead of the
 * surface staying flat-shaded. `flowMode: "channel"` swaps the world axes
 * for the ribbon's metre uv and its `flow` attribute: moving water.
 */
function buildWaterMaterial(data: MaterialData, options?: TextureResolver): THREE.MeshStandardNodeMaterial {
  const w = data.water ?? {
    shallowColor: "#3fa8c9",
    midColor: "#1f6f96",
    deepColor: "#0b3150",
    rimColor: "#eaf6ff",
    foamColor: "#eaf6ff",
    waveFrequency: 0.35,
    waveSpeed: 0.6,
    waveAmplitude: 0.15,
    fresnelPower: 3,
    depthFadeDistance: 6,
    foamWidth: 0.5,
    edgeFadeStart: 400,
    edgeFadeEnd: 600,
    textureScale: 24,
    textureStrength: 0.9,
    foamPixel: 0.7,
    foamSteps: 3,
    flow: [0.012, 0.008] as [number, number],
  };
  const material = new THREE.MeshStandardNodeMaterial({
    transparent: true,
    opacity: data.opacity,
    metalness: 0,
    roughness: 0.35,
  });

  // -- waves: vertex displacement + analytic normal -------------------------
  //
  // Measured in WORLD space and displaced along the surface's OWN normal.
  // The first version phased the waves by the mesh's local x/y and lifted
  // vertices along local z, which is right for one big plane lying flat
  // (local z is world up) and wrong for everything else: a lake sheet or a
  // river ribbon is authored flat in local XZ, so its "local y" is constant
  // and its "local z" is HORIZONTAL — every sheet slid sideways by its own
  // phase, and where two streamed cells met, the two sheets slid by
  // different amounts and tore open a gap along the seam. World-space
  // phase makes neighbouring sheets agree to the millimetre along a shared
  // edge; the normal makes the lift vertical for a flat sheet and
  // perpendicular for a falling one.
  //
  // `channel` water (river ribbons) measures "along" on the ribbon's metre
  // uv instead of world x, so the waves travel down the channel, around
  // its bends and over its falls, and never break at a cell seam because
  // the uv is continuous across pieces (`uvAlong`).
  const channel = w.flowMode === "channel";
  const worldXZ = vec2(positionWorld.x, positionWorld.z);
  const flowAttribute = attribute("flow", "vec3") as unknown as THREE.Node<"vec3">;
  const flowWorld = channel ? modelWorldMatrix.mul(vec4(flowAttribute, float(0))).xyz : null;
  const flowSpeed = flowWorld ? length(flowWorld) : null;
  // a still vertex (speed 0) must not divide by zero: nudge before normalising
  const flowDir = flowWorld ? normalize(add(vec2(flowWorld.x, flowWorld.z), vec2(float(1e-4), float(0)))) : null;
  const along = channel ? uv().y : positionWorld.x;
  const across = channel ? uv().x : positionWorld.z;

  const kA = float(w.waveFrequency);
  const ampA = float(w.waveAmplitude);
  const phaseA = sub(mul(along, kA), mul(time, float(w.waveSpeed)));
  const heightA = mul(sin(phaseA), ampA);

  const kB = float(w.waveFrequency * 1.7);
  const ampB = float(w.waveAmplitude * 0.5);
  const dirB = float(0.7071);
  const phaseB = sub(mul(add(mul(along, dirB), mul(across, dirB)), kB), mul(time, float(w.waveSpeed * 1.3)));
  const heightB = mul(sin(phaseB), ampB);

  const waveHeight = add(heightA, heightB);
  // a coarse sheet (a lake's polygon fan, a two-wide ribbon) keeps its
  // vertices still: lifting them tilts whole triangles into faceted streaks
  material.positionNode = w.displace === false ? positionLocal : add(positionLocal, mul(normalLocal, waveHeight));

  // slope of the wave surface in the (along, across) frame, then rotated into
  // world XZ: the frame is the flow direction for a channel, world axes otherwise
  const dhAlong = add(mul(mul(ampA, kA), cos(phaseA)), mul(mul(mul(ampB, kB), dirB), cos(phaseB)));
  const dhAcross = mul(mul(mul(ampB, kB), dirB), cos(phaseB));
  const alongDir = flowDir ?? vec2(float(1), float(0));
  const acrossDir = flowDir ? vec2(mul(flowDir.y, float(-1)), flowDir.x) : vec2(float(0), float(1));
  const slopeX = add(mul(dhAlong, alongDir.x), mul(dhAcross, acrossDir.x));
  const slopeZ = add(mul(dhAlong, alongDir.y), mul(dhAcross, acrossDir.y));
  // bend the geometry's own world normal (up for a sheet, sideways for a
  // fall) by the slope, then into view space, which is what normalNode is
  const bumpedWorld = normalize(add(normalWorld, vec3(mul(slopeX, float(-1)), float(0), mul(slopeZ, float(-1)))));
  material.normalNode = normalize(cameraViewMatrix.mul(vec4(bumpedWorld, float(0))).xyz);

  // -- toon-banded depth color: hard-ish steps, not a smooth gradient --
  const sceneViewZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
  const waterDepth = max(sub(positionView.z, sceneViewZ), float(0)); // world units, >= 0
  const depthFadeDist = float(w.depthFadeDistance);
  const bandWidth = mul(depthFadeDist, float(0.06)); // narrow = crisp but still anti-aliased
  const shallowToMid = mul(depthFadeDist, float(0.35));
  const t1 = smoothstep(sub(shallowToMid, bandWidth), add(shallowToMid, bandWidth), waterDepth);
  const t2 = smoothstep(sub(depthFadeDist, bandWidth), add(depthFadeDist, bandWidth), waterDepth);
  let base: THREE.Node<"vec3"> | THREE.Node<"color"> = mix(tslColor(w.shallowColor), tslColor(w.midColor), t1);
  base = mix(base as THREE.Node<"vec3">, tslColor(w.deepColor), t2);

  // set by the texture block below and read by the foam; null when this water
  // has no surface texture, in which case the foam keeps its plain band
  let foamBreakup: THREE.Node<"float"> | null = null;

  // -- scrolling surface texture: the SURFACE, not a tint over it -----------
  //
  // Applied here, between the depth bands and the foam, so it becomes the
  // water's actual colour while everything downstream — shoreline foam,
  // shimmer, fresnel rim — still paints over it.
  //
  // Two samples, not one. A single scrolling tile reads as a photograph being
  // dragged sideways, because the eye locks onto both the repeat and its
  // direction. Sampling twice at different scales, drifting near-perpendicular
  // at different rates, and averaging destroys both cues — the standard
  // flow-map-free ocean trick.
  //
  // Coordinates are WORLD XZ, not UV: this surface is a 7 km plane whose UVs
  // stretch one tile across the whole ocean, and world space also makes tiling
  // independent of how the mesh happens to be unwrapped or scaled.
  if (waterTextureId(data)) {
    const map = new THREE.Texture();
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    const scale = float(1 / Math.max(0.01, w.textureScale ?? 24));
    const flow = w.flow ?? [0.012, 0.008];
    const world = worldXZ;
    let uvA: THREE.Node<"vec2">;
    let uvB: THREE.Node<"vec2">;
    if (channel && flowSpeed) {
      // A channel samples on the ribbon's METRE uv — x across the centreline,
      // y along the river — so the tile follows the bends and runs down a
      // fall instead of being smeared onto a vertical face by a world-XZ
      // projection, and it scrolls along y at the vertex's own speed. The
      // second layer runs slower and wanders a little across, which keeps
      // the two from reading as one sliding photograph.
      const ribbon = uv();
      const travelled = mul(time, flowSpeed);
      uvA = mul(vec2(ribbon.x, sub(ribbon.y, travelled)), scale);
      uvB = mul(
        vec2(add(ribbon.x, mul(sin(mul(time, float(0.37))), float(0.6))), sub(ribbon.y, mul(travelled, float(0.72)))),
        mul(scale, float(1.59)),
      );
    } else {
      uvA = add(mul(world, scale), vec2(mul(time, float(flow[0])), mul(time, float(flow[1]))));
      uvB = add(
        mul(world, mul(scale, float(1.59))),
        vec2(mul(time, float(-flow[1] * 1.4)), mul(time, float(flow[0] * 1.4))),
      );
    }
    const detail = tslTexture(map, uvA).xyz.add(tslTexture(map, uvB).xyz).mul(float(0.5));
    // Depth reads as a BRIGHTNESS ramp only — no hue shift.
    //
    // Two earlier attempts got this wrong in different ways. Multiplying the
    // tile by the near-black `deepColor` crushed the surface to nothing past
    // the shelf. Mixing toward a scaled-up `deepColor` instead kept it visible
    // but pushed deep water blue against a teal tile, and a hue that disagrees
    // with the texture reads as "off" even when the brightness is fine. So the
    // texture's own colour is left alone and only its level moves: lifted in
    // the shallows, very slightly down in deep water.
    const litByDepth = mul(detail, mix(float(1.35), float(1.05), t2));
    base = mix(base as THREE.Node<"vec3">, litByDepth, float(w.textureStrength ?? 0.35));
    // A SNAPPED sample for the foam edge. Sampling the same continuous tile
    // gives a smoothly wandering border — organic, but not pixelated. Snapping
    // the lookup to a world grid makes the breakup constant across each cell,
    // so the band steps in squares at the same scale as the terrain's texels.
    const pixel = Math.max(0, w.foamPixel ?? 0.7);
    // a channel's foam rides its own metre uv too, so it moves with the water
    const foamBasis = channel ? uv() : world;
    const foamWorld = pixel > 0
      ? mul(floor(div(foamBasis, float(pixel))), float(pixel))
      : foamBasis;
    const foamScroll =
      channel && flowSpeed
        ? vec2(float(0), mul(mul(time, flowSpeed), float(-0.6)))
        : vec2(mul(time, float(flow[0] * 0.6)), mul(time, float(flow[1] * 0.6)));
    const foamUv = add(mul(foamWorld, mul(scale, float(2.3))), foamScroll);
    const foamSample = tslTexture(map, foamUv);
    foamBreakup = foamSample.x.add(foamSample.y).add(foamSample.z).mul(float(1 / 3));
    void loadWaterTexture(map, data, options);
  }

  // Shoreline foam. Two things stop it reading as a drawn contour line:
  //
  // 1. The band's distance is PERTURBED by the surface texture's own moving
  //    luminance, so the edge wanders with the water instead of tracing a
  //    clean offset of the shoreline.
  // 2. The result is QUANTISED into a few steps. A smoothstep gives a soft
  //    airbrushed gradient, which is exactly wrong next to nearest-filtered
  //    pixel-art terrain; stepping it produces chunky bands that sit with the
  //    rest of the world's resolution.
  const foamWidth = float(Math.max(w.foamWidth, 0.001));
  const foamJitter = foamBreakup
    ? mul(sub(foamBreakup, float(0.42)), mul(foamWidth, float(2.6)))
    : float(0);
  const foamDepth = add(waterDepth, foamJitter);
  const foamRaw = sub(float(1), smoothstep(mul(foamWidth, float(0.15)), foamWidth, foamDepth));
  const foamSteps = float(Math.max(1, Math.round(w.foamSteps ?? 3)));
  // top step deliberately short of 1: solid white froth reads as a painted
  // ring, and the shore should still show water through the foam
  // `foamSteps` levels, top step short of solid white so water still shows
  // through the froth rather than a painted ring
  const foamEdge = saturate(mul(floor(mul(foamRaw, foamSteps)), float(0.8).div(max(sub(foamSteps, float(1)), float(1)))));
  base = mix(base as THREE.Node<"vec3">, tslColor(w.foamColor), foamEdge);

  // gentle shimmer driven by the SAME wave phases, so the color motion reads
  // as coming from the same waves that are actually moving the geometry
  const ripple = mul(add(sin(phaseA), sin(phaseB)), float(0.5)); // [-1, 1]
  const shimmer = add(mul(ripple, float(0.05)), float(1)); // ~[0.95, 1.05], bounded
  const shaded: THREE.Node<"vec3"> = mul(base as THREE.Node<"vec3">, shimmer);

  const viewDir = normalize(sub(cameraPosition, positionWorld));
  const fresnel = pow(saturate(sub(float(1), saturate(dot(normalWorld, viewDir)))), float(w.fresnelPower));
  // the rim is the sky reflected at a grazing angle, so it takes the sky's
  // colour at the horizon: bright by day, dark at dusk like the land around
  // it, instead of a constant near-white that floated over a fogged-out hill
  const rim = (tslColor(w.rimColor) as unknown as THREE.Node<"vec3">).mul(horizonTint as unknown as THREE.Node<"vec3">);
  material.colorNode = mix(shaded as THREE.Node<"vec3">, rim, fresnel);

  // -- edge fade: opacity to 0 well before the mesh's own physical boundary --
  const camDist = length(sub(cameraPosition, positionWorld));
  const edgeFade = sub(float(1), smoothstep(float(w.edgeFadeStart), float(w.edgeFadeEnd), camDist));
  material.opacityNode = mul(float(data.opacity), edgeFade);
  material.roughnessNode = float(0.35);
  return material;
}


/** The water surface texture's asset id, if this material asks for one. */
function waterTextureId(data: MaterialData): string | undefined {
  return data.water?.texture;
}

/**
 * Fill the water's surface texture in place once it arrives.
 *
 * Built against an empty `THREE.Texture` and populated on load rather than
 * rewiring `colorNode` afterwards: a node material recompiles its whole
 * pipeline on any graph change, and the ocean is one of the largest meshes in
 * the scene to recompile mid-frame.
 */
async function loadWaterTexture(
  map: THREE.Texture,
  data: MaterialData,
  options: TextureResolver | undefined,
): Promise<void> {
  const assetId = waterTextureId(data);
  if (!assetId) return;
  const url = options?.resolveTexture?.(assetId);
  if (!url) {
    console.warn(`[render] no texture asset "${assetId}" for the water surface — it renders untextured`);
    return;
  }
  try {
    const loaded = await new THREE.TextureLoader().loadAsync(url);
    map.image = loaded.image;
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    // linear + mipmaps here, unlike the pixel-art terrain: this is a
    // photographic tile scrolling continuously, and nearest would crawl
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.magFilter = THREE.LinearFilter;
    map.generateMipmaps = true;
    map.needsUpdate = true;
    loaded.dispose();
  } catch (error) {
    console.warn(`[render] water texture failed to load: ${url}`, error);
  }
}

/**
 * Build the THREE material for a material asset. Textures are NOT attached
 * here — `materialForId` drives `applyMaterialMaps` for that, because texture
 * loading is async and needs the BuildOptions resolvers. Callers that build a
 * material directly (the thumbnail previewer) get a correct untextured
 * material and may attach their own maps.
 *
 * `standard`/`toon` are node materials rather than the classic classes so the
 * map pipeline has somewhere to hang its node overrides — three converts the
 * classic ones to node materials at draw time anyway, so this only removes a
 * per-build conversion, it doesn't add a layer.
 */
export function makeMaterial(data: MaterialData, options?: TextureResolver): THREE.Material {
  const common = {
    color: new THREE.Color(data.color),
    opacity: data.opacity,
    transparent: resolveTransparency(data).transparent,
  };
  switch (data.shader) {
    case "unlit": {
      // MeshBasicMaterial has no emissive concept at all (it's not lit, so
      // its own color already IS its brightness) — the bloom pipeline's MRT
      // split (renderer.ts) only samples a material's `emissiveNode`, which
      // plain MeshBasicMaterial never populates. Use the Node variant instead
      // and set emissiveNode explicitly so `emissive`/`emissiveIntensity`
      // (otherwise inert for a shader lighting never touches) can still
      // drive bloom — e.g. a neon sign or energy shield that glows without
      // ever being lit.
      const material = new THREE.MeshBasicNodeMaterial(common);
      const uniforms = makeMaterialUniforms(material, data);
      // @types/three only declares `emissiveNode` on MeshStandardNodeMaterialNodeProperties,
      // but NodeMaterial's own setupOutgoingLight() (materials/nodes/NodeMaterial.js) reads
      // `this.emissiveNode` generically off any subclass — a type-decl gap, not a runtime one.
      // Driven from uniforms so a live emissive tweak stays a uniform write.
      (material as THREE.MeshBasicNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode = (
        uniforms.emissive as unknown as THREE.Node<"color">
      ).mul(uniforms.emissiveIntensity as unknown as THREE.Node<"float">) as unknown as THREE.Node;
      applyMaterialCommon(material, data);
      return material;
    }
    case "toon": {
      const material = new THREE.MeshToonNodeMaterial({
        ...common,
        emissive: new THREE.Color(data.emissive),
        emissiveIntensity: data.emissiveIntensity,
      });
      applyMaterialCommon(material, data);
      return material;
    }
    case "wireframe":
      return new THREE.MeshBasicMaterial({ ...common, wireframe: true });
    case "terrain-splat":
      // the only shader that resolves its OWN textures (one triplanar set per
      // splat layer), so it needs the resolver the generic map pass gets
      return buildTerrainSplatMaterial(data, options);
    case "water":
      return buildWaterMaterial(data, options);
    case "standard":
    default: {
      const material = new THREE.MeshStandardNodeMaterial({
        ...common,
        roughness: data.roughness,
        metalness: data.metalness,
        emissive: new THREE.Color(data.emissive),
        emissiveIntensity: data.emissiveIntensity,
      });
      applyMaterialCommon(material, data);
      return material;
    }
  }
}

/**
 * Update an existing material instance in place to match new material data —
 * the cheap tier for a live material-file edit that shouldn't tear down the
 * whole scene. Returns false to decline, meaning the caller should take the
 * full rebuild.
 *
 * The decision boundary, and why it sits where it does:
 *
 * | change                                                    | result |
 * |-----------------------------------------------------------|--------|
 * | scalars — color/opacity/emissive/roughness/metalness,      | PATCH  |
 * | normalScale/detailStrength/aoIntensity/envMapIntensity,     |        |
 * | repeat/uvOffset/detailRepeat/triplanarScale                 |        |
 * | `side`                                                      | PATCH  |
 * | any map asset id added, removed or changed                  | rebuild|
 * | `triplanar` toggled                                         | rebuild|
 * | `vertexColors` / `alphaTest` crossing zero                  | rebuild|
 * | shader changed (different material class)                   | rebuild|
 * | terrain-splat / water (procedural, colours baked as consts) | rebuild|
 *
 * The important line is the FIRST row: it patches even on a material that
 * already has maps. The old rule ("anything involving a texture map declines")
 * was affordable when a material had at most `map` + `emissiveMap`; with the
 * full PBR set nearly every real material carries maps, so that rule would
 * have sent essentially every material tweak through a whole-scene rebuild
 * and blown the <1s hot-reload budget. It works because every scalar in the
 * node graph is a uniform (see MaterialUniforms) — patching them recompiles
 * nothing at all, which is a tier cheaper than the old classic-material patch
 * that set `needsUpdate` on every edit.
 *
 * Anything in the rebuild rows genuinely changes the shape of the compiled
 * graph (or needs an async texture load), which `materialMapKey` captures in
 * one comparable string.
 */
export function patchMaterial(existing: THREE.Material, data: MaterialData): boolean {
  const shader = data.shader ?? "standard";
  // procedural shaders bake their colours/bands into the node graph as
  // constants — there are no uniforms to write, so they always decline
  if (shader === "terrain-splat" || shader === "water") return false;

  const uniforms = materialUniformsOf(existing);
  const builtKey = materialMapKeyOf(existing);
  // A material this module didn't build (or built before a structural change)
  // has nothing to patch through; wireframe has no uniforms by design.
  if (shader !== "wireframe") {
    if (!uniforms || builtKey === undefined) return false;
    if (builtKey !== materialMapKey(data)) return false;
  }

  const classOk =
    shader === "standard"
      ? (existing as { isMeshStandardNodeMaterial?: boolean }).isMeshStandardNodeMaterial === true
      : shader === "toon"
        ? (existing as { isMeshToonNodeMaterial?: boolean }).isMeshToonNodeMaterial === true
        : shader === "unlit"
          ? existing instanceof THREE.MeshBasicNodeMaterial
          : existing instanceof THREE.MeshBasicMaterial;
  if (!classOk) return false;

  const { transparent } = resolveTransparency(data);
  const target = existing as THREE.Material & {
    color?: THREE.Color;
    emissive?: THREE.Color;
    emissiveIntensity?: number;
    roughness?: number;
    metalness?: number;
    envMapIntensity?: number;
  };
  target.color?.set(data.color);
  target.opacity = data.opacity;
  target.side = data.side === "double" ? THREE.DoubleSide : data.side === "back" ? THREE.BackSide : THREE.FrontSide;
  if (target.emissive) target.emissive.set(data.emissive);
  if ("emissiveIntensity" in target) target.emissiveIntensity = data.emissiveIntensity;
  if (shader === "standard") {
    target.roughness = data.roughness;
    target.metalness = data.metalness;
    target.envMapIntensity = data.envMapIntensity ?? 1;
  }
  if (uniforms) writeMaterialUniforms(uniforms, data);

  // `transparent` moves the mesh between the opaque and transparent render
  // queues, which three only re-evaluates on a material version bump — the one
  // property here that still costs a recompile, and only when it actually flips
  if (existing.transparent !== transparent) {
    existing.transparent = transparent;
    existing.needsUpdate = true;
  }
  return true;
}

/**
 * Resolve a material asset id to a Three material, caching per build. Undefined
 * id (or a missing asset) returns the shared engine default. Color maps attach
 * asynchronously once their image loads. Shared by the scene builder and the
 * HLOD proxy merge so both honor the same material/texture pipeline.
 */
export function materialForId(
  id: string | undefined,
  options: BuildOptions,
  cache: Map<string, THREE.Material>,
): THREE.Material {
  if (!id) return defaultMaterial;
  const data = options.resolveMaterial?.(id) as MaterialData | undefined;
  const cached = cache.get(id);
  // The build cache is module-level and outlives a rebuild (it's what stops
  // every newly-streamed chunk recompiling pipelines other chunks already
  // compiled — see sharedAssetMaterialCache). That means a rebuild triggered
  // by a material EDIT would otherwise hand back the pre-edit material and the
  // edit would silently never appear. So the cache entry is keyed on the
  // resolved asset data as well: identity first (the AssetLibrary hands out
  // the same object until the asset is replaced, so this is the O(1) common
  // case), falling back to a structural compare for hosts that rebuild the
  // object each call.
  if (cached && data && materialsMatch(materialSourceOf(cached), data)) return cached;
  if (cached && !data) return cached;
  if (!data) {
    console.warn(`[render] no material asset "${id}" — using default`);
    return defaultMaterial;
  }
  const material = makeMaterial(data, options);
  setMaterialSource(material, data);
  // Every map (color, emissive, normal, roughness/metalness/AO or packed ORM,
  // detail normal, alpha) resolves and attaches here, in one pass — see
  // material-maps.ts for the colour-space, sharing and UV-transform rules.
  applyMaterialMaps(material, data, options);
  cache.set(id, material);
  return material;
}

/**
 * Cheap equality for a resolved material asset: reference identity, then a
 * structural compare. Only reached on a cache hit, so the slow branch runs at
 * most once per material per rebuild.
 */
function materialsMatch(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (previous === undefined) return false;
  try {
    return JSON.stringify(previous) === JSON.stringify(next);
  } catch {
    return false;
  }
}

function resolveMaterialFor(
  meshData: MeshData,
  options: BuildOptions,
  cache: Map<string, THREE.Material>,
): THREE.Material {
  return materialForId(meshData.material, options, cache);
}

/**
 * Set an entity group's local transform from its (optional) transform
 * component. No component means identity — reconcile relies on that reset
 * when a transform component is removed.
 */
export function applyEntityTransform(
  group: THREE.Object3D,
  entity: { components: Record<string, unknown> },
): void {
  const transform = entity.components["transform"] as TransformData | undefined;
  if (transform) {
    group.position.fromArray(transform.position);
    group.quaternion.fromArray(transform.rotation);
    group.scale.fromArray(transform.scale);
  } else {
    group.position.set(0, 0, 0);
    group.quaternion.identity();
    group.scale.set(1, 1, 1);
  }
}

interface PendingInstance {
  id: string;
  group: THREE.Object3D;
  node?: string;
  /** Leaf-card normal reshaping for this model; see foliage-normals.ts. */
  foliageNormals?: number;
  foliageUp?: number;
  brightness?: number;
  textureFilter?: TextureFilter;
  wind?: FoliageWindOptions;
  cameraFade?: boolean;
  /** `mesh.source.uvRotation`, degrees — see INSTANCE_UV_ROTATION_ATTRIBUTE. */
  uvRotation?: number;
  castShadow: boolean;
  receiveShadow: boolean;
  lod: boolean;
  /**
   * Where the eventual shared InstancedMesh(es) get parented — `ctx.scene`
   * for a whole build (buildScene), or the entity's own group for a single-
   * entity rebuild (reconcile, ctx.scene: null). Captured at accumulation
   * time: by the time the async gltf load resolves and actually creates the
   * InstancedMesh, the caller has already reparented `ctx.scene` (a chunk's
   * `built.scene` gets added under the chunk's own group, which gets added
   * under the live THREE.Scene) — walking `.parent` at that point would climb
   * past the intended anchor to whatever it's since been attached under,
   * landing the batch outside the chunk's own subtree so unloading the chunk
   * never finds it to dispose (a leak, and a lingering-ghost-props bug).
   */
  anchor: THREE.Object3D;
}

interface PopulateContext {
  options: BuildOptions;
  materialCache: Map<string, THREE.Material>;
  /** buildScene only — sky components write scene background/fog; reconcile
   * bails on sky entities before ever getting here. */
  scene: THREE.Scene | null;
  /**
   * `mesh.renderMode: "instanced"` asset entities register here instead of
   * loading+cloning individually — collected across the WHOLE build so every
   * entity sharing an assetId collapses into one `THREE.InstancedMesh` per
   * submesh (see `flushInstancedPending`), rather than one full mesh each.
   */
  instancedPending: Map<string, PendingInstance[]>;
  /**
   * `decal` entities queue here instead of projecting on the spot: fitted
   * decal geometry reads OTHER entities' world matrices, which only exist
   * once the whole build's parenting pass has run (see flushDecals).
   */
  decalPending: DecalRequest[];
  /** null on a single-entity reconcile of a scene built before this existed. */
  lighting: SceneLighting | null;
  /**
   * The winning `sky` payload, stashed rather than applied on the spot: IBL has
   * to reach materials that later entities in the same build create, so the
   * environment is pushed once, after the whole build.
   */
  sky?: SkyData | null;
}

/**
 * `pathScatter`: one InstancedMesh holding every placement along the curve —
 * one draw call regardless of instance count. Primitive props build
 * synchronously; asset props load the glTF once and use its FIRST mesh found
 * (single-mesh scatter props — fence posts, vine segments — are the common
 * case; a multi-mesh model only contributes its first submesh here).
 */
function buildPathScatter(
  data: PathScatterData,
  group: THREE.Object3D,
  id: string,
  options: BuildOptions,
  materialCache: Map<string, THREE.Material>,
  epoch: number,
): void {
  const placements = pathScatterPlacements(data);
  if (placements.length === 0) return;

  const attach = (geometry: THREE.BufferGeometry) => {
    // an instanced CLONE of the asset material: the instance transform is a
    // vertex node on the material, and the shared asset material also draws
    // plain meshes
    const material = cachedInstancedMaterial(`pathScatter#${data.material}`, materialForId(data.material, options, materialCache));
    const instanced = new InstancedProps(geometry, material, placements.length);
    instanced.castShadow = data.castShadow;
    instanced.receiveShadow = data.receiveShadow;
    instanced.userData["entityId"] = id;
    const matrix = new THREE.Matrix4();
    const scaleVec = new THREE.Vector3();
    placements.forEach((placement, i) => {
      scaleVec.set(placement.scale, placement.scale, placement.scale);
      matrix.compose(placement.position, placement.quaternion, scaleVec);
      instanced.setMatrixAt(i, matrix);
    });
    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
  };

  if (data.prop.kind === "primitive") {
    attach(geometryFor(data.prop.shape, data.prop.size));
    return;
  }
  const url = options.resolveModel?.(data.prop.assetId);
  if (!url) {
    console.warn(`[render] pathScatter: no URL for mesh asset "${data.prop.assetId}"`);
    return;
  }
  loadGltf(url).then(
    (gltf) => {
      if (group.userData["visualsEpoch"] !== epoch) return;
      const root = data.prop.kind === "asset" && data.prop.node ? gltf.scene.getObjectByName(data.prop.node) : gltf.scene;
      let found: THREE.BufferGeometry | undefined;
      root?.traverse((node) => {
        if (!found && (node as THREE.Mesh).isMesh) found = (node as THREE.Mesh).geometry;
      });
      if (!found) {
        console.warn(`[render] pathScatter: no mesh found in ${url}`);
        return;
      }
      attach(found);
    },
    (error) => console.warn(`[render] pathScatter: failed to load model:`, error),
  );
}

/**
 * Create one entity's component visuals under its anchor group. Shared by the
 * full build and per-entity reconcile. Returns the created camera, if any.
 *
 * Async model loads are epoch-guarded: rebuilding an entity's visuals bumps
 * `visualsEpoch` on the group, so a load that started before the rebuild
 * discards itself instead of double-attaching.
 */
function populateEntityGroup(
  group: THREE.Object3D,
  id: string,
  entity: { components: Record<string, unknown> },
  ctx: PopulateContext,
): THREE.PerspectiveCamera | null {
  const { options, materialCache, scene } = ctx;
  const epoch = ((group.userData["visualsEpoch"] as number | undefined) ?? 0) + 1;
  group.userData["visualsEpoch"] = epoch;
  const visibility = entity.components["visibility"] as { visible?: boolean } | undefined;
  group.visible = visibility?.visible ?? true;
  let createdCamera: THREE.PerspectiveCamera | null = null;
  {
    const meshData = entity.components["mesh"] as MeshData | undefined;
    if (meshData && meshData.source.kind === "primitive") {
      const mesh = new THREE.Mesh(
        geometryFor(
          meshData.source.shape,
          meshData.source.size,
          meshData.source.segments,
          meshData.source.shading,
          meshData.source.uv,
        ),
        resolveMaterialFor(meshData, options, materialCache),
      );
      if (meshData.source.shape === "plane") mesh.rotation.x = -Math.PI / 2;
      mesh.castShadow = meshData.castShadow;
      mesh.receiveShadow = meshData.receiveShadow;
      mesh.userData["entityId"] = id;
      mesh.userData[STATIC_BATCH_FLAG] = meshData.static === true;
      group.add(mesh);
    }
    if (meshData && meshData.source.kind === "polygon") {
      const mesh = new THREE.Mesh(
        polygonGeometry(meshData.source),
        resolveMaterialFor(meshData, options, materialCache),
      );
      mesh.castShadow = meshData.castShadow;
      mesh.receiveShadow = meshData.receiveShadow;
      mesh.userData["entityId"] = id;
      mesh.userData[STATIC_BATCH_FLAG] = meshData.static === true;
      group.add(mesh);
    }

    if (meshData && meshData.source.kind === "poly") {
      const { geometry, compiled } = polyMeshGeometry(meshData.source);
      // one material per slot; slot 0 (or an empty slot) is the component's own
      // material. Face tints need vertexColors on, which a shared cached
      // material can't carry — clone per entity only when a tint exists.
      const slots = Math.max(1, ...compiled.groups.map((g) => g.materialIndex + 1));
      const materials: THREE.Material[] = [];
      for (let slot = 0; slot < slots; slot++) {
        const id = meshData.source.materials?.[slot] || meshData.material;
        let material = materialForId(id, options, materialCache);
        if (compiled.colors) {
          material = material.clone();
          material.vertexColors = true;
        }
        materials.push(material);
      }
      const mesh = new THREE.Mesh(geometry, materials.length === 1 ? materials[0]! : materials);
      mesh.castShadow = meshData.castShadow;
      mesh.receiveShadow = meshData.receiveShadow;
      mesh.userData["entityId"] = id;
      mesh.userData[STATIC_BATCH_FLAG] = meshData.static === true;
      mesh.userData["polyMesh"] = true;
      group.add(mesh);
    }

    if (meshData && meshData.source.kind === "path") {
      const mesh = new THREE.Mesh(
        pathGeometry(meshData.source),
        resolveMaterialFor(meshData, options, materialCache),
      );
      mesh.castShadow = meshData.castShadow;
      mesh.receiveShadow = meshData.receiveShadow;
      mesh.userData["entityId"] = id;
      mesh.userData[STATIC_BATCH_FLAG] = meshData.static === true;
      // marks this mesh for ctx.setPathPoints (main.ts) — a live-simulated
      // rope/chain rebuilds its geometry every tick from new control points,
      // reusing every OTHER field (crossSection/width/radius/...) from the
      // entity's authored source, which the doc never changes at runtime
      mesh.userData["pathMesh"] = true;
      mesh.userData["pathSource"] = meshData.source;
      group.add(mesh);
    }

    if (meshData && meshData.source.kind === "voxel") {
      // the SAME mesh physics cooks and placement snaps against (core/voxel) —
      // one cached cell, three consumers, so they cannot drift
      const geometry = voxelGeometry(meshData.source);
      if (geometry) {
        const mesh = new THREE.Mesh(geometry, resolveMaterialFor(meshData, options, materialCache));
        mesh.castShadow = meshData.castShadow;
        mesh.receiveShadow = meshData.receiveShadow;
        mesh.userData["entityId"] = id;
        mesh.userData[STATIC_BATCH_FLAG] = meshData.static === true;
        mesh.userData["voxelSource"] = meshData.source;
        // No camera-collision proxy here, unlike the heightmap branch below.
        // `refreshCameraColliders` only walks the BASE scene document's static
        // entities, and streamed chunk content is never in that document — so
        // a proxy built here would be meshed, uploaded and kept for a consumer
        // that cannot see it. It cost a second marching-cubes pass and a second
        // geometry for every cell in the world, which is also what was
        // thrashing the cell cache. If chunk terrain is ever wired into camera
        // collision, build the proxy there, on demand, for the few cells in range.
        group.add(mesh);
      }
    }

    if (meshData && meshData.source.kind === "heightmap") {
      // the SAME grid the physics trimesh is cooked from (core/terrain.ts)
      const grid = heightmapMesh(meshData.source);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(grid.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(grid.indices, 1));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, resolveMaterialFor(meshData, options, materialCache));
      mesh.castShadow = meshData.castShadow;
      mesh.receiveShadow = meshData.receiveShadow;
      mesh.userData["entityId"] = id;
      mesh.userData[STATIC_BATCH_FLAG] = meshData.static === true;
      // main.ts's refreshCameraColliders() raycasts static geometry every
      // frame for camera dolly-collision (no acceleration structure) — doing
      // that against full render resolution (up to 256x256) is expensive even
      // for just the 1-2 tiles typically in range, and gets MUCH worse while
      // flying across multiple tiles at once. Same height FUNCTION, far fewer
      // samples: visually identical terrain SHAPE for "don't clip through the
      // ground" purposes, a small fraction of the raycast cost. Tagged, not
      // added to the group directly — refreshCameraColliders swaps it in for
      // the real mesh instead of adding both.
      const proxyRes = Math.max(4, Math.min(16, meshData.source.resolution));
      const proxyGrid = heightmapMesh({ ...meshData.source, resolution: proxyRes });
      const proxyGeometry = new THREE.BufferGeometry();
      proxyGeometry.setAttribute("position", new THREE.BufferAttribute(proxyGrid.positions, 3));
      proxyGeometry.setIndex(new THREE.BufferAttribute(proxyGrid.indices, 1));
      const colliderProxy = new THREE.Mesh(proxyGeometry);
      colliderProxy.visible = false;
      colliderProxy.userData["isColliderProxy"] = true;
      mesh.userData["hasColliderProxy"] = true;
      group.add(colliderProxy); // same group as `mesh` — inherits the same transform
      group.add(mesh);
    }

    if (meshData && meshData.source.kind === "asset" && meshData.renderMode === "instanced") {
      const assetId = meshData.source.assetId;
      const list = ctx.instancedPending.get(assetId);
      const entry: PendingInstance = {
        id,
        group,
        node: meshData.source.node,
        foliageNormals: meshData.source.foliageNormals,
        foliageUp: meshData.source.foliageUp,
        brightness: meshData.source.brightness,
        textureFilter: meshData.source.textureFilter,
        wind: meshData.source.wind,
        cameraFade: meshData.source.cameraFade,
        uvRotation: meshData.source.uvRotation,
        castShadow: meshData.castShadow,
        receiveShadow: meshData.receiveShadow,
        lod: meshData.lod ?? true,
        anchor: scene ?? group,
      };
      if (list) list.push(entry);
      else ctx.instancedPending.set(assetId, [entry]);
    } else if (meshData && meshData.source.kind === "asset") {
      const assetId = meshData.source.assetId;
      const url = options.resolveModel?.(assetId);
      const nodeName = meshData.source.node;
      const clustered = meshData.renderMode === "clustered";
      if (meshData.source.uvRotation !== undefined && !uvRotationWarned.has(assetId)) {
        uvRotationWarned.add(assetId);
        console.warn(
          `[render] mesh.source.uvRotation on "${assetId}" is only honoured with renderMode "instanced"; ignored`,
        );
      }
      if (url) {
        // async: the model pops in when loaded; group placement is already correct
        // (a clustered mesh also waits for the clusterizer's WASM, once per session)
        Promise.all([loadGltf(url), clustered ? clusterDagReady() : undefined]).then(
          ([gltf]) => {
            // the entity's visuals were rebuilt while we loaded — stand down
            if (group.userData["visualsEpoch"] !== epoch) return;
            let source: THREE.Object3D = gltf.scene;
            if (nodeName) {
              const found = gltf.scene.getObjectByName(nodeName);
              if (!found) {
                console.warn(`[render] node "${nodeName}" not found in ${url}`);
                return;
              }
              source = found;
            }
            // the cache shares one loaded scene: always instance a skeleton-safe clone
            const instance = skeletonClone(source);
            if (nodeName) {
              // detached part: the entity's transform governs placement
              instance.position.set(0, 0, 0);
              instance.quaternion.identity();
              instance.scale.set(1, 1, 1);
            }
            instance.userData["modelRoot"] = true;
            instance.traverse((node) => {
              if ((node as THREE.Mesh).isMesh) {
                node.castShadow = meshData.castShadow;
                node.receiveShadow = meshData.receiveShadow;
                // skinned bounds stay at the bind pose, so a moved/teleported
                // character would be frustum-culled while plainly on screen
                if ((node as THREE.SkinnedMesh).isSkinnedMesh) node.frustumCulled = false;
              }
              node.userData["entityId"] = id;
            });
            // leaf cards before anything downstream sees the geometry: the
            // LOD/impostor bakes read normals, so this has to land first
            const foliage = meshData.source.kind === "asset" ? meshData.source.foliageNormals : undefined;
            const foliageUp = meshData.source.kind === "asset" ? meshData.source.foliageUp : undefined;
            if (foliage !== undefined) applyFoliageNormals(instance, { blend: foliage, up: foliageUp });
            const lift = meshData.source.kind === "asset" ? meshData.source.brightness : undefined;
            if (lift !== undefined) applyModelBrightness(instance, lift);
            const textureFilter = meshData.source.kind === "asset" ? meshData.source.textureFilter : undefined;
            if (textureFilter) applyModelTextureFilter(instance, textureFilter);
            const wind = meshData.source.kind === "asset" ? meshData.source.wind : undefined;
            if (wind) applyFoliageWind(instance, wind);
            if (meshData.source.kind === "asset" && meshData.source.cameraFade) applyFoliageFade(instance);
            if (clustered) clusterizeModel(instance, assetId, nodeName, id, options);
            // A kit-exported prop arrives as dozens of tiny same-material
            // submeshes, and each one costs a draw call in the main pass and in
            // every shadow cascade. Only safe when nothing addresses the nodes
            // by name afterwards: an animation clip does, and the cluster path
            // has already built its own representation from them.
            if (!clustered && (gltf.animations?.length ?? 0) === 0) {
              mergeModelSubmeshes(instance);
            }
            group.add(instance);
            options.onModelLoaded?.(id, instance, gltf.animations ?? []);
          },
          (error) => console.warn(`[render] failed to load model:`, error),
        );
      } else {
        console.warn(`[render] no URL for mesh asset "${meshData.source.assetId}"`);
      }
    }

    const pathScatterData = entity.components["pathScatter"] as PathScatterData | undefined;
    if (pathScatterData) {
      buildPathScatter(pathScatterData, group, id, options, materialCache, epoch);
    }

    const lightData = entity.components["light"] as LightData | undefined;
    if (lightData) {
      const color = new THREE.Color(lightData.color);
      let light: THREE.Light | null = null;
      switch (lightData.kind) {
        case "ambient":
          light = new THREE.AmbientLight(color, lightData.intensity);
          break;
        case "point":
          light = new THREE.PointLight(color, lightData.intensity, lightData.range);
          break;
        case "directional": {
          const dir = new THREE.DirectionalLight(color, lightData.intensity);
          dir.target.position.set(0, -1, 0);
          group.add(dir.target);
          // The single-map defaults (1024², ±shadowSize ortho, near 0.5,
          // far max(120, size*3), bias -0.0004, normalBias 0.02) now live in
          // DEFAULT_SHADOW_SETTINGS + shadowFarPlane, and `cascades: 1` takes
          // exactly that path — so a scene with no `shadow` block is unchanged.
          // 1024 (not 2048) is still deliberate: confirmed fill-rate-bound via
          // real frame timing, and cost scales with the SQUARE of it.
          light = dir;
          break;
        }
        case "spot": {
          const spot = new THREE.SpotLight(
            color,
            lightData.intensity,
            lightData.range,
            lightData.angle,
          );
          spot.target.position.set(0, -1, 0);
          group.add(spot.target);
          light = spot;
          break;
        }
      }
      if (light) {
        // Cascades are directional-only; SceneLighting owns that branch. The
        // single-map defaults reproduce what was hardcoded here before the
        // `light.shadow` schema existed, so an unchanged scene is unchanged.
        const shadow = shadowSettingsOf(lightData);
        const shadowSize = lightData.shadowSize ?? 40;
        if (ctx.lighting) ctx.lighting.registerLight(light, lightData.castShadow, shadow, shadowSize);
        else applyShadowSettings(light, lightData.castShadow, shadow, shadowSize);
        light.userData["runtimeEnabled"] = true;
        light.userData["lightImportance"] = lightData.importance ?? 1;
        group.add(light);
        options.onLight?.(id, light, lightData.importance ?? 1);
      }
    }

    const skyData = entity.components["sky"] as SkyData | undefined;
    if (skyData && scene && !scene.background) {
      const cubemapUrls = skyData.cubemap
        ? (["px", "nx", "py", "ny", "pz", "nz"] as const).map((face) =>
            options.resolveTexture?.(skyData.cubemap![face]),
          )
        : undefined;
      const panoramaUrl = skyData.texture ? options.resolveTexture?.(skyData.texture) : undefined;
      if (cubemapUrls?.every((url): url is string => !!url)) {
        scene.background = new THREE.Color(skyData.bottom); // until the faces land
        new THREE.CubeTextureLoader().load(
          cubemapUrls,
          (cubeTexture) => {
            cubeTexture.colorSpace = THREE.SRGBColorSpace;
            scene.background = cubeTexture;
          },
          undefined,
          (error) => console.warn(`[render] sky cubemap failed`, error),
        );
      } else if (panoramaUrl) {
        scene.background = new THREE.Color(skyData.bottom); // until the image lands
        new THREE.TextureLoader().load(
          panoramaUrl,
          (texture) => {
            texture.mapping = THREE.EquirectangularReflectionMapping;
            texture.colorSpace = THREE.SRGBColorSpace;
            scene.background = texture;
          },
          undefined,
          (error) => console.warn(`[render] sky texture failed: ${panoramaUrl}`, error),
        );
      } else {
        const dome = buildSkyDome(skyData.top, skyData.bottom, skyData.sun, skyData.moon, skyData.stars, skyData.clouds);
        group.add(dome);
        scene.background = new THREE.Color(skyData.bottom);
        ctx.lighting?.attachSkyDome(dome);
      }
      // Fog, IBL and volumetric intent are all deferred to SceneLighting, which
      // buildScene applies once the whole scene exists — IBL has to reach
      // materials built by entities that come after this one.
      ctx.sky = normalizeSky(skyData);
      if (skyData.light > 0) {
        const hemisphere = new THREE.HemisphereLight(new THREE.Color(skyData.top), new THREE.Color(skyData.bottom), skyData.light);
        hemisphere.userData["skyHemisphere"] = true;
        group.add(hemisphere);
        ctx.lighting?.attachSkyHemisphere(hemisphere);
      }
    }

    const particlesData = entity.components["particles"] as ParticlesData | undefined;
    if (particlesData) options.onParticles?.(id, group, particlesData);

    const billboardData = entity.components["billboard"] as BillboardData | undefined;
    if (billboardData) options.onBillboard?.(id, group, billboardData);

    const grassData = entity.components["grass"] as GrassData | undefined;
    if (grassData) options.onGrass?.(id, group, grassData);

    const decalData = entity.components["decal"] as DecalData | undefined;
    if (decalData) ctx.decalPending.push({ id, group, data: decalData });

    const cameraData = entity.components["camera"] as CameraData | undefined;
    if (cameraData) {
      const camera = new THREE.PerspectiveCamera(
        cameraData.fov,
        1, // aspect is the renderer's business
        cameraData.near,
        cameraData.far,
      );
      group.add(camera);
      createdCamera = camera;
    }
  }
  return createdCamera;
}

// Cluster DAGs are a one-time preprocess per unique (asset, node, mesh) —
// ~90 ms per 16k triangles on the main thread — so they're cached with the
// same stable string key discipline as the mid-tier decimation: a chunk-
// streamed world that places the same hero model in several cells builds
// its DAG once. `null` records "not worth clustering" so it isn't retried.
const clusterDagCache = new Map<string, ClusterDag | null>();

/**
 * Replace every eligible mesh under `root` (a fresh clone of a loaded model)
 * with a `ClusteredMesh` driving the same material through the model's
 * cluster DAG. Skinned/morphing meshes are left alone — the DAG indexes fixed
 * vertex positions, and those move theirs on the GPU.
 */
function clusterizeModel(
  root: THREE.Object3D,
  assetId: string,
  node: string | undefined,
  entityId: string,
  options: BuildOptions,
): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (mesh.geometry.morphAttributes && Object.keys(mesh.geometry.morphAttributes).length > 0) return;
    meshes.push(mesh);
  });
  meshes.forEach((mesh, ordinal) => {
    const key = `${assetId}#${node ?? ""}#cluster#${ordinal}`;
    let dag = clusterDagCache.get(key);
    if (dag === undefined) {
      dag = clusterDagFromGeometry(mesh.geometry);
      clusterDagCache.set(key, dag);
    }
    if (!dag) return;
    const clustered = new ClusteredMesh(mesh.geometry, mesh.material, dag);
    clustered.name = mesh.name;
    clustered.position.copy(mesh.position);
    clustered.quaternion.copy(mesh.quaternion);
    clustered.scale.copy(mesh.scale);
    clustered.castShadow = mesh.castShadow;
    clustered.receiveShadow = mesh.receiveShadow;
    clustered.userData["entityId"] = entityId;
    for (const child of [...mesh.children]) clustered.add(child);
    const parent = mesh.parent;
    if (parent) {
      parent.add(clustered);
      parent.remove(mesh);
    }
    options.onClusteredMesh?.(entityId, clustered);
  });
}

/**
 * Turn every `renderMode: "instanced"` asset request collected this build
 * into real `THREE.InstancedMesh`es — one per (assetId, node, submesh)
 * combination, sized to however many entities asked for it, instead of one
 * full mesh clone per entity. Geometry/material are CLONED off the shared
 * glTF cache (not referenced directly): entities disposing their group later
 * (chunk unload) call `.dispose()` on whatever they find, and the cache's
 * loaded scene — and every OTHER build's instances of the same model — must
 * survive that. Async (glTF load is cached but still a Promise), so this
 * always resolves after the caller's synchronous pass has parented every
 * entity group; each entity's `matrixWorld` is current by then.
 */
function flushInstancedPending(pending: Map<string, PendingInstance[]>, options: BuildOptions): void {
  for (const [assetId, entries] of pending) {
    const url = options.resolveModel?.(assetId);
    if (!url) {
      console.warn(`[render] no URL for instanced mesh asset "${assetId}"`);
      continue;
    }
    // the simplifier's WASM is awaited here (not at first use) so the mid tier
    // is built synchronously alongside the near/far ones — no batch ever gets
    // registered without its mid tier and then patched later
    Promise.all([loadGltf(url), simplifierReady()]).then(
      ([gltf]) => {
        // Leaf normals FIRST, on the shared cached scene, before anything
        // clones or derives from it — the mid-tier decimation and the impostor
        // bake both read normals, and both are cached by (assetId, node), so a
        // batch built from the authored normals would pin the bad ones for the
        // whole session. Foliage normals are a property of the MODEL, so any
        // entry that asks for them settles it for the asset.
        const asked = entries.find((e) => e.foliageNormals !== undefined);
        if (asked) applyFoliageNormals(gltf.scene, { blend: asked.foliageNormals, up: asked.foliageUp });
        const lift = entries.find((e) => e.brightness !== undefined)?.brightness;
        if (lift !== undefined) applyModelBrightness(gltf.scene, lift);
        const textureFilter = entries.find((e) => e.textureFilter !== undefined)?.textureFilter;
        if (textureFilter) applyModelTextureFilter(gltf.scene, textureFilter);
        // Wind and camera-fade both swap the material for a node material, so
        // they must land BEFORE instanceGltfInto clones and caches it — a
        // clone taken first would pin the plain material for the session.
        const wind = entries.find((e) => e.wind !== undefined)?.wind;
        if (wind) applyFoliageWind(gltf.scene, wind);
        if (entries.some((e) => e.cameraFade)) applyFoliageFade(gltf.scene);
        const byNode = new Map<string | undefined, PendingInstance[]>();
        for (const entry of entries) {
          const bucket = byNode.get(entry.node);
          if (bucket) bucket.push(entry);
          else byNode.set(entry.node, [entry]);
        }
        for (const [node, group] of byNode) instanceGltfInto(assetId, gltf, node, group, options);
      },
      (error) => console.warn(`[render] failed to load instanced model "${assetId}":`, error),
    );
  }
}

const instanceMatrixScratch = new THREE.Matrix4();
const identityScratch = new THREE.Matrix4();
const sourceInverseScratch = new THREE.Matrix4();

// Below this vertex count, a submesh's own vertex-shader cost is already
// cheap enough that decimating it isn't worth the one-time simplification
// pass (rocks, mushrooms, small clutter) — those stay a plain near/far swap.
const MID_TIER_MIN_VERTS = 1500;
// Keep ~35% of the original triangles for the mid tier — enough to still read
// as a real 3D tree at the range it's used (between the near and far
// thresholds), while cutting the per-instance vertex-shader cost roughly 3x.
// WHERE that range starts is no longer a constant: the simplifier reports
// the geometric error of what it produced, and FoliageLodSystem turns that
// into the distance at which the error is sub-pixel (see `midError`).
const MID_TIER_KEEP_RATIO = 0.35;

// Decimation is cheap now (meshoptimizer WASM — single-digit ms per model,
// see mesh-simplify.ts) but still cached by a stable (assetId, node, submesh
// index) key, not the source geometry OBJECT: a chunk-streamed world flushes
// this same (assetId, node) group once per CHUNK CELL that references it
// (every cell independently loads its own glTF instances), so an
// object-identity cache silently stops deduping the moment those calls don't
// happen to observe the exact same geometry instance — and the cached
// geometry is SHARED across every chunk's mid-tier batch (each InstancedProps
// wraps it without copying the arrays), so identity here is what keeps one
// decimation per unique submesh instead of one per cell.
export interface MidTier {
  geometry: THREE.BufferGeometry;
  /** Geometric deviation from the near-tier geometry, in submesh-local units. */
  error: number;
}
const midTierGeometryCache = new Map<string, MidTier | null>();
// bakeImpostor is a real GPU render-to-texture pass (72 small renders per
// model) — cache by the same (assetId, node) key so a chunk-streamed world's
// far tier only ever bakes each unique model once, not once per chunk cell.
// The impostor material is cached alongside for the usual reason: one
// compiled pipeline per unique model, never one per chunk.
const impostorCache = new Map<string, ImpostorAtlas | null>();
const impostorMaterialCache = new Map<string, THREE.Material>();

/**
 * The impostor atlas + material for one (asset, node), baked on first use and
 * cached forever after (see the caches above for why). Null when the host has
 * no baker (headless) or the bake failed, in which case callers fall back to
 * whatever cheaper proxy they have.
 */
export function cachedImpostor(
  assetId: string,
  node: string | undefined,
  source: THREE.Object3D,
  bounds: THREE.Box3,
  options: BuildOptions,
): { atlas: ImpostorAtlas; material: THREE.Material } | null {
  const key = `${assetId}#${node ?? ""}`;
  let atlas: ImpostorAtlas | null;
  if (impostorCache.has(key)) {
    atlas = impostorCache.get(key)!;
  } else {
    // a throwaway clone, never the shared cached `source` itself
    atlas = options.bakeImpostor?.(source.clone(true), bounds) ?? null;
    impostorCache.set(key, atlas);
  }
  if (!atlas) return null;
  let material = impostorMaterialCache.get(key);
  if (!material) {
    material = impostorMaterial(atlas, bounds);
    impostorMaterialCache.set(key, material);
  }
  return { atlas, material };
}

/**
 * One draw call of impostor quads for `matrices.length` placements of a
 * model — every instance active, no LOD tracking. This is what the HLOD
 * supercells use for their trees: a merged full-geometry tree in the far
 * ring was 1,400 vertices per instance that read as a few pixels, and every
 * species' every submesh was its own merged bucket. As quads it is four
 * vertices per tree, one draw per species per supercell, and the same atlas
 * the near ring's far tier already baked. Null without a baker.
 */
/** One model's placements, for `impostorPageBatchFor`. */
export interface ImpostorPageItem {
  assetId: string;
  node: string | undefined;
  gltf: GLTF;
  submeshes: GltfSubmesh[];
  matrices: readonly THREE.Matrix4[];
}

const impostorPageMaterialCache = new Map<string, THREE.Material>();

/**
 * Impostor quads for MANY models in as few draws as the atlases allow: every
 * model whose atlas lives on the same shared page (see the app's baker) goes
 * into one `InstancedProps` over that page's material, carrying its region,
 * radius and centre per instance. A supercell of five tree species is then
 * one draw instead of five. Models with no atlas, or with a page of their
 * own, come back in `unpaged` for the caller to batch per model.
 */
export function impostorPageBatchFor(
  items: readonly ImpostorPageItem[],
  options: BuildOptions,
): { batches: InstancedProps[]; unpaged: ImpostorPageItem[] } {
  const byPage = new Map<string, { page: ImpostorAtlas; entries: Array<{ item: ImpostorPageItem; atlas: ImpostorAtlas; bounds: THREE.Box3 }> }>();
  const unpaged: ImpostorPageItem[] = [];
  for (const item of items) {
    if (item.matrices.length === 0) continue;
    const source: THREE.Object3D = item.node ? (item.gltf.scene.getObjectByName(item.node) ?? item.gltf.scene) : item.gltf.scene;
    const bounds = submeshBounds(item.submeshes);
    const baked = cachedImpostor(item.assetId, item.node, source, bounds, options);
    if (!baked || !baked.atlas.region) {
      unpaged.push(item);
      continue;
    }
    const key = baked.atlas.albedo.uuid;
    let group = byPage.get(key);
    if (!group) {
      group = { page: baked.atlas, entries: [] };
      byPage.set(key, group);
    }
    group.entries.push({ item, atlas: baked.atlas, bounds });
  }
  const batches: InstancedProps[] = [];
  for (const [key, group] of byPage) {
    let material = impostorPageMaterialCache.get(key);
    if (!material) {
      material = impostorPageMaterial(group.page);
      impostorPageMaterialCache.set(key, material);
    }
    const total = group.entries.reduce((n, e) => n + e.item.matrices.length, 0);
    const batch = new InstancedProps(impostorPageGeometry(total), material, total);
    const regions = new Float32Array(total * 3);
    const radii = new Float32Array(total);
    const centers = new Float32Array(total * 3);
    const matrices: THREE.Matrix4[] = [];
    const center = new THREE.Vector3();
    let i = 0;
    for (const { item, atlas, bounds } of group.entries) {
      const region = atlas.region!;
      const radius = bounds.getSize(center).length() / 2;
      bounds.getCenter(center);
      for (const matrix of item.matrices) {
        matrices.push(matrix);
        regions[i * 3] = region.u;
        regions[i * 3 + 1] = region.v;
        regions[i * 3 + 2] = region.scale;
        radii[i] = radius;
        centers[i * 3] = center.x;
        centers[i * 3 + 1] = center.y;
        centers[i * 3 + 2] = center.z;
        i++;
      }
    }
    const data: ImpostorInstanceData = { ...impostorInstanceData(matrices), regions, radii, centers };
    // the anchor is the centre ATTRIBUTE, so the geometry's own bounds are a
    // point at the origin — give the batch a sphere over its placements
    const sphere = new THREE.Sphere();
    const point = new THREE.Vector3();
    let maxRadius = 0;
    for (let k = 0; k < total; k++) {
      batch.setMatrixAt(k, matrices[k]!);
      writeImpostorSlot(batch, data, k, k);
      point.set(centers[k * 3]!, centers[k * 3 + 1]!, centers[k * 3 + 2]!).applyMatrix4(matrices[k]!);
      if (k === 0) sphere.center.copy(point);
      else sphere.expandByPoint(point);
      maxRadius = Math.max(maxRadius, radii[k]! * data.scales[k]!);
    }
    sphere.radius += maxRadius;
    batch.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    batch.boundingSphere = sphere;
    batch.instanceCount = total;
    batch.instanceMatrix.needsUpdate = true;
    batch.castShadow = false;
    batch.receiveShadow = false;
    batches.push(batch);
  }
  return { batches, unpaged };
}

export function impostorBatchFor(
  assetId: string,
  node: string | undefined,
  gltf: GLTF,
  submeshes: GltfSubmesh[],
  matrices: readonly THREE.Matrix4[],
  options: BuildOptions,
): InstancedProps | null {
  if (matrices.length === 0) return null;
  const source: THREE.Object3D = node ? (gltf.scene.getObjectByName(node) ?? gltf.scene) : gltf.scene;
  const bounds = submeshBounds(submeshes);
  const impostor = cachedImpostor(assetId, node, source, bounds, options);
  if (!impostor) return null;
  const far = new InstancedProps(impostorGeometry(bounds, matrices.length), impostor.material, matrices.length);
  const data = impostorInstanceData(matrices);
  for (let i = 0; i < matrices.length; i++) {
    far.setMatrixAt(i, matrices[i]!);
    writeImpostorSlot(far, data, i, i);
  }
  far.instanceCount = matrices.length;
  far.instanceMatrix.needsUpdate = true;
  far.computeBoundingSphere();
  far.castShadow = false;
  far.receiveShadow = false;
  return far;
}
// near/mid-tier instanced materials, keyed like midTierGeometryCache — CPU
// profiling (a real ~40-53% of frame-time spikes during sustained flight)
// found instanceGltfInto's per-submesh `sub.material.clone()` was creating a
// BRAND NEW Material object — and therefore forcing a fresh WebGPU shader
// pipeline compile — every single time a chunk streamed in, even for the
// exact same tree/rock asset already compiled for a different chunk minutes
// earlier. The source glTF (and its embedded materials) is already cached
// forever by loadGltf's gltfCache; caching the CLONE too means the actual
// compiled pipeline is reused across every chunk that ever needs it.
const instancedMaterialCache = new Map<string, THREE.Material | THREE.Material[]>();

/** Returns a cached clone of `source` for (near/mid tier, one submesh) —
 * cloned once ever per key, not once per chunk build. Exported so
 * hlod-proxy.ts's static merge path shares the exact same cache/key scheme
 * — a supercell's merged copy of a model and any nearby instanced copy of
 * the same model use the identical compiled material, never two pipelines
 * for what's visually one material. */
/**
 * Per-asset material clones for MERGED geometry (HLOD proxies): the same
 * sharing rationale as {@link cachedInstancedMaterial}, minus the instance
 * transform node — merged geometry carries no instance attributes, and a
 * material that reads them draws every vertex at the origin. Keyed separately
 * so an HLOD bake can strip wind from its clone without touching the batch's.
 */
const mergedMaterialCache = new Map<string, THREE.Material | THREE.Material[]>();
export function cachedMergedMaterial(
  cacheKey: string,
  source: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  const cached = mergedMaterialCache.get(cacheKey);
  if (cached) return cached;
  const cloned = Array.isArray(source) ? source.map(cloneMaterial) : cloneMaterial(source);
  mergedMaterialCache.set(cacheKey, cloned);
  return cloned;
}

export function cachedInstancedMaterial(
  cacheKey: string,
  source: THREE.Material | THREE.Material[],
  options: { uvRotation?: boolean } = {},
): THREE.Material | THREE.Material[] {
  const cached = instancedMaterialCache.get(cacheKey);
  if (cached) return cached;
  // Cloned so the instance transform node never lands on a material a plain
  // mesh shares; converted to a NodeMaterial first because that node IS the
  // instancing (see applyInstancedProps) — a non-node clone would draw every
  // instance at the origin.
  const instancedClone = (m: THREE.Material): THREE.Material => {
    const clone = asNodeMaterial(cloneMaterial(m));
    applyInstancedProps(clone);
    // a material that binds the uv-rotation attribute is only ever handed to
    // batches that allocate it, hence its own cache key (see instanceGltfInto)
    if (options.uvRotation) applyInstanceUvRotation(clone);
    return clone;
  };
  const cloned = Array.isArray(source) ? source.map(instancedClone) : instancedClone(source);
  instancedMaterialCache.set(cacheKey, cloned);
  return cloned;
}

/**
 * Decimated stand-in for a submesh's near-tier geometry, used at the "mid"
 * LOD distance — a genuinely lower triangle count instead of just relying on
 * mipmapped textures (which only cut sampling cost, not the per-instance
 * vertex-shader cost that dominates at high instance counts). Returns null
 * for geometry too small to bother with, or that meshoptimizer couldn't
 * meaningfully reduce — never throws (interleaved glTF attributes, the thing
 * that used to crash three's SimplifyModifier here, are handled inside
 * simplifyGeometry). Requires `simplifierReady()` to have resolved, which
 * flushInstancedPending awaits alongside the glTF load.
 */
export function buildMidTier(cacheKey: string, geometry: THREE.BufferGeometry): MidTier | null {
  const cached = midTierGeometryCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const vertexCount = geometry.attributes["position"]?.count ?? 0;
  let tier: MidTier | null = null;
  if (vertexCount >= MID_TIER_MIN_VERTS) {
    const simplified = simplifyGeometry(geometry, { targetRatio: MID_TIER_KEEP_RATIO });
    if (simplified) tier = { geometry: simplified.geometry, error: simplified.error };
  }
  midTierGeometryCache.set(cacheKey, tier);
  return tier;
}

/**
 * Cheap distance-LOD stand-in for a whole model, sized/centered to the
 * model's own bounding box so the SAME instance matrix that places the real
 * geometry places this correctly too.
 *
 * Squat props (rocks) get a box — a primitive box already reads fine as "a
 * simplified rock" at range. Tall props (trees, bushes) get a CROSS-BILLBOARD
 * instead of a single cone: two vertical quads at 90° to each other, the
 * classic cheap-foliage-impostor trick — no per-instance camera-facing shader
 * needed (that's the bigger, still-open upgrade), but from most angles at
 * least one card faces close enough to camera to read as foliage rather than
 * a bare geometric primitive. Paired with `buildFarProxyMaterial`, which
 * gives the tall case a soft round alpha mask instead of the quads' hard
 * rectangular edges.
 */
/** Model-space bounds of a whole model: every submesh's box through its own
 * local transform. */
export function submeshBounds(submeshes: Array<{ geometry: THREE.BufferGeometry; localMatrix: THREE.Matrix4 }>): THREE.Box3 {
  const bbox = new THREE.Box3();
  const scratchBox = new THREE.Box3();
  for (const sub of submeshes) {
    sub.geometry.computeBoundingBox();
    scratchBox.copy(sub.geometry.boundingBox!).applyMatrix4(sub.localMatrix);
    bbox.union(scratchBox);
  }
  return bbox;
}

export function buildLodProxyGeometry(
  submeshes: Array<{ geometry: THREE.BufferGeometry; localMatrix: THREE.Matrix4 }>,
): { geometry: THREE.BufferGeometry; isTall: boolean; width?: number; height?: number } {
  const bbox = submeshBounds(submeshes);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bbox.getSize(size);
  bbox.getCenter(center);
  const isTall = size.y > Math.max(size.x, size.z) * 1.2;
  if (!isTall) {
    const geometry = new THREE.BoxGeometry(
      Math.max(size.x, 0.1),
      Math.max(size.y, 0.1),
      Math.max(size.z, 0.1),
    );
    geometry.translate(center.x, center.y, center.z);
    return { geometry, isTall: false };
  }
  const width = Math.max(size.x, size.z, 0.1) * 1.15;
  const height = Math.max(size.y, 0.1);
  const cardA = new THREE.PlaneGeometry(width, height);
  const cardB = new THREE.PlaneGeometry(width, height);
  cardB.rotateY(Math.PI / 2);
  const geometry = mergeGeometries([cardA, cardB]);
  geometry.translate(center.x, center.y, center.z);
  return { geometry, isTall: true, width, height };
}

export interface MaterialLook {
  color: THREE.Color;
  /** The model's ACTUAL color/detail texture, when it has one — most nature
   * assets get their real look from this, not a flat `.color` tint (which
   * defaults to white on a textured material, i.e. exactly the "gray blob"
   * a color-only proxy produces). */
  map: THREE.Texture | null;
}

export function materialLook(material: THREE.Material | THREE.Material[]): MaterialLook {
  const m = (Array.isArray(material) ? material[0] : material) as
    | (THREE.Material & { color?: THREE.Color; map?: THREE.Texture | null })
    | undefined;
  return {
    color: m?.color ? m.color.clone() : new THREE.Color(0x6a7a4a),
    map: m?.map ?? null,
  };
}

/**
 * Rocks (squat proxies) keep a plain opaque material — a box reads fine as
 * "a simplified rock". Trees (cross-billboard proxies) get a soft round
 * alpha mask instead of the quads' hard rectangular silhouette, so a field of
 * them at range reads as foliage clumps rather than a grid of visible cards.
 *
 * This is the FALLBACK far tier, used only when no impostor atlas could be
 * baked (headless builds, or an app that opted out — see `bakeImpostor` in
 * BuildOptions); with a bake, the far tier is an octahedral impostor quad
 * (impostor.ts) and none of this runs.
 */
/**
 * Far-proxy materials, keyed by look: one per (shape, texture-or-color), shared
 * by every batch that resolves to it. Built fresh per batch they would each be
 * a distinct object with its own shader build (see instancing.ts).
 */
const farProxyMaterialCache = new Map<string, THREE.MeshLambertNodeMaterial>();
export function instancedFarProxyMaterial(isTall: boolean, look: MaterialLook): THREE.MeshLambertNodeMaterial {
  const key = `${isTall ? "tall" : "flat"}#${look.map ? look.map.uuid : look.color.getHexString()}`;
  let material = farProxyMaterialCache.get(key);
  if (!material) {
    material = buildFarProxyMaterial(isTall, look);
    applyInstancedProps(material);
    farProxyMaterialCache.set(key, material);
  }
  return material;
}

function buildFarProxyMaterial(isTall: boolean, look: MaterialLook): THREE.MeshLambertNodeMaterial {
  const base = look.map
    ? { colorNode: tslTexture(look.map, uv()) }
    : { color: look.color };
  if (!isTall) return new THREE.MeshLambertNodeMaterial(base);
  const material = new THREE.MeshLambertNodeMaterial({
    ...base,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // fake "mostly up" normal — a flat vertical card's REAL normal only ever
  // faces one fixed horizontal direction, so whichever of the cross's two
  // cards happens to face away from the sun goes to near-zero diffuse and
  // reads as a near-black silhouette. A synthetic up-facing normal (same
  // trick as grass) lights both cards consistently from the sun's elevation.
  material.normalNode = vec3(0, 1, 0);
  const centered = sub(uv(), vec2(0.5, 0.5));
  const dist = length(centered);
  const roundMask = sub(float(1), smoothstep(float(0.3), float(0.5), dist));
  // real textures often already carry their own alpha cutout (leaf clusters,
  // grass blades) — combine it with the round mask instead of replacing it,
  // so a textured card keeps its natural silhouette AND loses hard corners
  const textureAlpha = look.map ? tslTexture(look.map, uv()).a : float(1);
  material.opacityNode = mul(roundMask, textureAlpha);
  return material;
}

export interface GltfSubmesh {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** This submesh's own transform relative to the model root (or `node`, if
   * given) — compose with a placement's world matrix to get the submesh's
   * final position, whether that's one instance's matrix or a static merge's
   * baked-in-place geometry. */
  localMatrix: THREE.Matrix4;
}

/**
 * Every real (non-skinned) mesh under a loaded glTF's scene (or a named
 * `node` within it), each with its OWN transform relative to that root —
 * shared by the instancing path (`instanceGltfInto`) and HLOD static
 * merging (`hlod-proxy.ts`), so both bake submesh-local transforms
 * identically. Returns `null` if `node` doesn't resolve (caller warns).
 */
export function extractGltfSubmeshes(gltf: GLTF, node: string | undefined): GltfSubmesh[] | null {
  let source: THREE.Object3D = gltf.scene;
  if (node) {
    const found = gltf.scene.getObjectByName(node);
    if (!found) return null;
    source = found;
  }
  source.updateWorldMatrix(true, true);
  sourceInverseScratch.copy(source.matrixWorld).invert();

  const submeshes: GltfSubmesh[] = [];
  source.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      console.warn(`[render] skipping skinned submesh — instancing doesn't support skeletal animation`);
      return;
    }
    submeshes.push({
      geometry: mesh.geometry,
      material: mesh.material,
      localMatrix: new THREE.Matrix4().copy(sourceInverseScratch).multiply(mesh.matrixWorld),
    });
  });
  return submeshes;
}

function instanceGltfInto(
  assetId: string,
  gltf: GLTF,
  node: string | undefined,
  entries: PendingInstance[],
  options: BuildOptions,
): void {
  const submeshes = extractGltfSubmeshes(gltf, node);
  if (submeshes === null) {
    console.warn(`[render] node "${node}" not found in instanced model`);
    return;
  }
  if (submeshes.length === 0) return;
  // extractGltfSubmeshes already validated `node` resolves when given, so this
  // repeats a cheap lookup rather than threading the resolved root back out of
  // a function shared with hlod-proxy.ts (which never needs it).
  const source: THREE.Object3D = node ? gltf.scene.getObjectByName(node)! : gltf.scene;

  // Streamed cells pool their props world-wide (prop-pool.ts) — one set of
  // tiers per model however many cells are resident — unless an entry needs
  // the per-instance uv-rotation attribute, which the pool does not carry.
  const pool = options.instancePool;
  const owner = options.instancePoolOwner;
  if (pool && owner && !entries.some((entry) => entry.uvRotation !== undefined)) {
    if (!pool.isLive(owner)) return; // the cell unloaded while its model was loading
    const first = entries[0]!;
    const placed = entries.map((entry) => {
      entry.group.updateWorldMatrix(true, false);
      return { id: entry.id, matrix: entry.group.matrixWorld.clone() };
    });
    pool.add(
      assetId,
      node,
      gltf,
      submeshes,
      { castShadow: first.castShadow, receiveShadow: first.receiveShadow, lod: first.lod },
      placed,
      owner,
      options,
    );
    return;
  }

  // per-instance world matrix/position, computed ONCE and shared by every
  // tier (near submeshes AND the far proxy all place identically)
  const matrices: THREE.Matrix4[] = [];
  const positions: THREE.Vector3[] = [];
  for (const entry of entries) {
    entry.group.updateWorldMatrix(true, false);
    matrices.push(entry.group.matrixWorld.clone());
    positions.push(new THREE.Vector3().setFromMatrixPosition(entry.group.matrixWorld));
  }

  const first = entries[0]!;
  // the anchor captured when this entry was queued (buildScene's own `scene`
  // container, or the rebuilding entity's own group) — NOT a live `.parent`
  // walk, which by now would climb past it to wherever the caller has since
  // reparented that container (a chunk's `built.scene` under the chunk's own
  // group under the live THREE.Scene), landing outside the subtree a chunk
  // unload actually traverses to dispose. Every entry here shares one anchor
  // (accumulated within a single buildScene/rebuildEntityVisuals call).
  const root = first.anchor;

  // Per-instance texture rotation (WFC kit floors). A batch where ANY entry
  // sets it draws with a material variant that binds the attribute, keyed
  // apart from the plain clone so batches of the same asset without it keep
  // their plain shader and never bind an attribute they did not allocate.
  const rotated = entries.some((entry) => entry.uvRotation !== undefined);
  const materialKeySuffix = rotated ? "#uvrot" : "";
  const uvRotations = rotated
    ? Float32Array.from(entries, (entry) => THREE.MathUtils.degToRad(entry.uvRotation ?? 0))
    : undefined;
  const applyUvRotations = (instanced: InstancedProps): void => {
    if (!uvRotations) return;
    instanced.enableUvRotation();
    for (let i = 0; i < uvRotations.length; i++) instanced.setUvRotationAt(i, uvRotations[i]!);
  };

  const nearMeshes: InstancedProps[] = [];
  for (let index = 0; index < submeshes.length; index++) {
    const sub = submeshes[index]!;
    const instanced = new InstancedProps(
      sub.geometry,
      cachedInstancedMaterial(`${assetId}#${node ?? ""}#${index}${materialKeySuffix}`, sub.material, { uvRotation: rotated }),
      entries.length,
    );
    instanced.castShadow = first.castShadow;
    instanced.receiveShadow = first.receiveShadow;
    instanced.userData["instancedEntityIds"] = entries.map((e) => e.id);
    for (let i = 0; i < entries.length; i++) {
      instanceMatrixScratch.copy(matrices[i]!).multiply(sub.localMatrix);
      instanced.setMatrixAt(i, instanceMatrixScratch);
    }
    applyUvRotations(instanced);
    instanced.instanceMatrix.needsUpdate = true;
    // InstancedMesh's bounding sphere defaults to null (unlike a plain Mesh's
    // geometry bounds) — frustum culling silently does nothing without this,
    // which would render every instance every frame regardless of view.
    // Computed once over the REAL placement (before any LOD zeroing), which
    // stays valid: a zeroed instance only shrinks toward a point already
    // inside that volume, never outside it.
    instanced.computeBoundingSphere();
    root.add(instanced);
    nearMeshes.push(instanced);
  }

  // props too small/cheap to benefit from a distance swap (grass, small
  // clutter) skip the far tier and LOD tracking entirely — always full
  // detail, still batched (the draw-call win), no proxy-vs-real downgrade
  if (!first.lod) return;

  // mid tier: a decimated stand-in for whichever submeshes are heavy enough
  // to be worth it (see MID_TIER_MIN_VERTS) — cheap submeshes (a thin bark
  // cylinder next to a dense leaf canopy) just reuse their near geometry
  // rather than being decimated pointlessly. Only built at all when at least
  // one submesh actually qualifies, so light props (rocks, mushrooms) keep
  // the exact 2-tier near/far behavior they had before.
  const midTiers = submeshes.map((sub, index) => buildMidTier(`${assetId}#${node ?? ""}#${index}`, sub.geometry));
  const midMeshes: InstancedProps[] | undefined = midTiers.some((t) => t !== null)
    ? submeshes.map((sub, index) => {
        // when a decimated geometry exists, it came from midTierGeometryCache
        // — shared across every chunk that ever builds this (assetId, node,
        // submesh). InstancedProps wraps it in per-batch attribute objects over
        // the same arrays, so a chunk unload disposes only its own buffers.
        const cachedTier = midTiers[index];
        const geometry = cachedTier?.geometry ?? sub.geometry;
        const instanced = new InstancedProps(
          geometry,
          cachedInstancedMaterial(`${assetId}#${node ?? ""}#${index}${materialKeySuffix}`, sub.material, { uvRotation: rotated }),
          entries.length,
        );
        // mid tier is already a distance-culled compromise — a decimated
        // shadow caster at this range reads as roughly the same dark blob a
        // real one would, for the cost of a whole extra shadow-pass draw per
        // instance. Only the near tier is close enough for the shadow shape
        // itself to be worth the GPU pass (matches far tier's castShadow=false).
        instanced.castShadow = false;
        instanced.receiveShadow = first.receiveShadow;
        for (let i = 0; i < entries.length; i++) {
          instanceMatrixScratch.copy(matrices[i]!).multiply(sub.localMatrix);
          instanced.setMatrixAt(i, instanceMatrixScratch);
        }
        applyUvRotations(instanced);
        instanced.instanceMatrix.needsUpdate = true;
        instanced.computeBoundingSphere();
        root.add(instanced);
        return instanced;
      })
    : undefined;

  // far tier: one cheap proxy standing in for the whole model. Preferred: an
  // octahedral impostor — a single camera-facing quad sampling an atlas of
  // the model baked from 36 directions over the upper hemisphere (see
  // impostor.ts), so a tree still looks like THAT tree from the side, from a
  // helicopter, and everywhere between. The bake is a real GPU render pass,
  // so it's cached by (assetId, node) the same way buildMidTier caches its
  // decimation and for the same reason: a chunk-streamed world flushes this
  // same (assetId, node) group once per CELL that references it — without
  // caching, splitting one world into N chunks turns one bake into N bakes.
  // Without a baker (headless build, or the app opted out) the primitive
  // proxies stand in: a cross-billboard for tall props, a box for squat ones.
  const bounds = submeshBounds(submeshes);
  const impostor = cachedImpostor(assetId, node, source, bounds, options);
  let far: InstancedProps;
  let impostorData: ImpostorInstanceData | undefined;
  if (impostor) {
    far = new InstancedProps(impostorGeometry(bounds, entries.length), impostor.material, entries.length);
    impostorData = impostorInstanceData(matrices);
  } else {
    const { geometry: farGeometry, isTall } = buildLodProxyGeometry(submeshes);
    // the fallback's look comes from the LARGEST submesh by vertex count, not
    // the first — a tree's bark is typically submesh 0 but a thin sliver next
    // to the leaf canopy, which is what actually reads as "this is a tree"
    const dominantSubmesh = submeshes.reduce((a, b) =>
      b.geometry.attributes["position"]!.count > a.geometry.attributes["position"]!.count ? b : a,
    );
    far = new InstancedProps(farGeometry, instancedFarProxyMaterial(isTall, materialLook(dominantSubmesh.material)), entries.length);
  }
  far.castShadow = false; // a rough blob casting a shadow reads worse than no shadow
  far.receiveShadow = first.receiveShadow;
  for (let i = 0; i < entries.length; i++) far.setMatrixAt(i, matrices[i]!);
  far.instanceMatrix.needsUpdate = true;
  far.computeBoundingSphere();
  root.add(far);

  // the batch's mid-tier error is its worst submesh's, in model units (each
  // submesh's own localMatrix scale folded in; a submesh that reuses its near
  // geometry contributes nothing) — FoliageLodSystem projects it to pixels
  const midError = midMeshes
    ? submeshes.reduce((worst, sub, index) => {
        const tier = midTiers[index];
        return tier ? Math.max(worst, tier.error * sub.localMatrix.getMaxScaleOnAxis()) : worst;
      }, 0)
    : undefined;
  const localMatrices = submeshes.map((sub) => sub.localMatrix);
  const batch: InstancedPropBatch = {
    near: nearMeshes,
    mid: midMeshes,
    far,
    positions,
    matrices,
    ...(localMatrices.some((m) => !m.equals(identityScratch)) ? { localMatrices } : {}),
    ...(midError !== undefined ? { midError } : {}),
    ...(impostorData ? { impostor: impostorData } : {}),
    ...(uvRotations ? { uvRotations } : {}),
  };
  for (const mesh of nearMeshes) mesh.userData["foliageLodBatch"] = batch;
  if (midMeshes) for (const mesh of midMeshes) mesh.userData["foliageLodBatch"] = batch;
  far.userData["foliageLodBatch"] = batch;
  options.onInstancedBatch?.(batch);
}

// asset-id-keyed material cache (primitive/heightmap/polygon/path meshes,
// via materialForId) — module-level for the SAME reason as
// instancedMaterialCache above: buildScene() runs once per chunk cell, and a
// per-call cache meant every newly-streamed chunk recompiled a WebGPU shader
// pipeline for materials (terrain-splat, road, etc.) already compiled for a
// different chunk. Shared across every buildScene()/reconcile call now.
const sharedAssetMaterialCache = new Map<string, THREE.Material>();

export function buildScene(doc: SceneDoc, options: BuildOptions = {}): BuiltScene {
  const scene = new THREE.Scene();
  const objects = new Map<string, THREE.Object3D>();
  const cameras = new Map<string, THREE.PerspectiveCamera>();
  const materialCache = sharedAssetMaterialCache;
  const instancedPending = new Map<string, PendingInstance[]>();
  const decalPending: DecalRequest[] = [];
  const lighting = new SceneLighting(scene, { resolveTexture: options.resolveTexture });
  const populateCtx: PopulateContext = {
    options,
    materialCache,
    scene,
    instancedPending,
    decalPending,
    lighting,
    sky: null,
  };
  let activeCamera: THREE.PerspectiveCamera | null = null;

  for (const [id, entity] of Object.entries(doc.entities)) {
    const group = new THREE.Group();
    group.name = entity.name;
    group.userData["entityId"] = id;
    applyEntityTransform(group, entity);

    const camera = populateEntityGroup(group, id, entity, populateCtx);
    if (camera) {
      cameras.set(id, camera);
      const cameraData = entity.components["camera"] as CameraData | undefined;
      if (cameraData?.active && !activeCamera) activeCamera = camera;
    }

    objects.set(id, group);
  }

  // second pass: parenting (order-independent)
  for (const [id, entity] of Object.entries(doc.entities)) {
    const object = objects.get(id)!;
    const parent = entity.parent ? objects.get(entity.parent) : undefined;
    (parent ?? scene).add(object);
  }

  // every entity is placed now, so instanced batches can read stable matrixWorlds
  flushInstancedPending(instancedPending, options);

  // decals likewise need every receiver's real world matrix before projecting
  flushDecals(scene, decalPending, options);

  // Applied last, and applied even when there is NO sky: the material-side IBL
  // seam is module-global (materials are shared across builds), so a scene
  // without a sky has to actively clear it or it inherits the previous scene's.
  lighting.applySky(populateCtx.sky ?? null);

  return { scene, objects, activeCamera, cameras, materials: materialCache, lighting };
}

/**
 * Rebuild ONE entity's component visuals in place: strip everything under its
 * anchor group that isn't a child entity's group, then repopulate from the
 * entity doc. The group object itself survives, so selections, gizmo
 * attachments, physics-body bindings, and child entities are undisturbed.
 */
export function rebuildEntityVisuals(
  built: BuiltScene,
  id: string,
  entity: { components: Record<string, unknown> },
  options: BuildOptions,
  materialCache: Map<string, THREE.Material>,
): void {
  const group = built.objects.get(id);
  if (!group) return;
  for (const child of [...group.children]) {
    const childEntity = child.userData["entityId"] as string | undefined;
    // a child whose entityId maps back to itself IS an entity group — keep it;
    // everything else (meshes, lights + targets, model roots, debug viz) goes
    if (typeof childEntity === "string" && built.objects.get(childEntity) === child) continue;
    // A light dropped without releasing leaves its CSMShadowNode (and its
    // shadow-pass cost) in the system, refitting a light no longer in scene.
    if ((child as THREE.Light).isLight === true) built.lighting.releaseLight(child as THREE.Light);
    group.remove(child);
  }
  applyEntityTransform(group, entity);
  const instancedPending = new Map<string, PendingInstance[]>();
  const decalPending: DecalRequest[] = [];
  populateEntityGroup(group, id, entity, {
    options,
    materialCache,
    scene: null,
    instancedPending,
    decalPending,
    lighting: built.lighting,
  });
  // a single entity's own group is already fully placed — flush immediately
  flushInstancedPending(instancedPending, options);
  // rebuild this entity's own decal, and re-fit neighbouring decals over its
  // changed geometry (see decals.ts for the re-projection contract)
  syncEntityDecals(built.scene, id, group, decalPending, options);
}
