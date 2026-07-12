import * as THREE from "three/webgpu";
import {
  positionWorld,
  positionLocal,
  normalWorld,
  cameraPosition,
  time,
  color as tslColor,
  float,
  mix,
  smoothstep,
  saturate,
  clamp,
  add,
  sub,
  mul,
  dot,
  pow,
  sin,
  abs,
  normalize,
  uv,
  vec2,
  vec3,
  length,
  texture as tslTexture,
} from "three/tsl";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { heightmapMesh, type HeightmapParams, type SceneDoc } from "@hitreg/core";
import type { ParticlesData } from "./particles.js";
import type { BillboardData } from "./billboards.js";
import type { InstancedPropBatch } from "./foliage-lod.js";

// kits load once and instance many times
const gltfCache = new Map<string, Promise<GLTF>>();

export function loadGltf(url: string): Promise<GLTF> {
  let pending = gltfCache.get(url);
  if (!pending) {
    pending = (gltfLoader ??= new GLTFLoader()).loadAsync(url);
    gltfCache.set(url, pending);
  }
  return pending;
}

export interface BuildOptions {
  /** Resolve a mesh asset id to a fetchable glTF/GLB URL (from the AssetLibrary). */
  resolveModel?(assetId: string): string | undefined;
  /** Resolve a material asset id to its (schema-validated) material data. */
  resolveMaterial?(assetId: string): unknown | undefined;
  /** Resolve a texture asset id to a fetchable image URL. */
  resolveTexture?(assetId: string): string | undefined;
  /** Fired when an asset mesh finishes loading (animation clips included). */
  onModelLoaded?(entityId: string, root: THREE.Object3D, clips: THREE.AnimationClip[]): void;
  /** Fired for each `particles` entity — the app registers it with its
   * ParticleSystem (the builder stays free of the simulation). `group` is the
   * entity's anchor group; the system parents its InstancedMesh under it. */
  onParticles?(entityId: string, group: THREE.Object3D, data: ParticlesData): void;
  /** Fired for each `billboard` entity — the app registers it with its
   * BillboardSystem (the builder stays free of the canvas drawing). `group` is
   * the entity's anchor group; the system parents its Sprite under it. */
  onBillboard?(entityId: string, group: THREE.Object3D, data: BillboardData): void;
  /** Fired once per `renderMode: "instanced"` (assetId, node) group — the app
   * registers it with a FoliageLodSystem to drive near/far distance LOD. */
  onInstancedBatch?(batch: InstancedPropBatch): void;
  /**
   * Render a real front-view snapshot of `object` (a throwaway clone — safe to
   * reparent/mutate/dispose) at roughly `aspect`'s proportions, with a
   * transparent background, for use as a billboard proxy texture. The app
   * owns the live renderer this needs (the same render-to-texture technique
   * as the prefab/model thumbnail previews); returns null if unavailable, in
   * which case the far tier falls back to the model's own material/color.
   */
  bakeBillboardTexture?(
    object: THREE.Object3D,
    aspect: { width: number; height: number },
  ): THREE.Texture | null;
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
  roughness: number;
  metalness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
  splat?: {
    layers: SplatLayerData[];
    slopeRock?: { color: string; roughness: number; start: number; end: number };
  };
  water?: {
    shallowColor: string;
    deepColor: string;
    rimColor: string;
    waveFrequency: number;
    waveSpeed: number;
    fresnelPower: number;
  };
}

/**
 * Attach a color map to a material once the image has actually loaded — the
 * WebGPU backend crashes rendering a texture whose image is still null.
 */
function applyTextureWhenReady(
  material: THREE.Material & { map?: THREE.Texture | null },
  url: string,
  repeat: [number, number],
): void {
  new THREE.TextureLoader().load(
    url,
    (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(repeat[0], repeat[1]);
      material.map = texture;
      material.needsUpdate = true;
    },
    undefined,
    (error) => console.warn(`[render] texture failed to load: ${url}`, error),
  );
}

let gltfLoader: GLTFLoader | null = null;

interface TransformData {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

interface MeshData {
  source:
    | { kind: "primitive"; shape: string; size: [number, number, number] }
    | { kind: "asset"; assetId: string; node?: string }
    | {
        kind: "polygon";
        points: Array<[number, number]>;
        height: number;
        bevel?: { size: number; segments: number };
      }
    | ({ kind: "heightmap" } & HeightmapParams);
  material?: string;
  castShadow: boolean;
  receiveShadow: boolean;
  renderMode?: "auto" | "instanced";
  lod?: boolean;
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
): THREE.Mesh {
  // defensive: production sky data is always zod-validated (top/bottom always
  // real hex strings) before it reaches here, but TSL's color() warns loudly
  // on undefined rather than the old vertex-color path's silent THREE.Color
  // fallback — stay equally tolerant of incomplete/malformed input.
  const topColor = top || "#5fa9ff";
  const bottomColor = bottom || "#101522";

  const radius = 450;
  const geometry = new THREE.SphereGeometry(radius, 32, 20);
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });

  const dir = normalize(positionLocal);
  const t = pow(clamp(mul(add(dir.y, float(0.35)), float(1 / 1.35)), 0, 1), float(0.9));
  let colorNode: THREE.Node<"vec3"> | THREE.Node<"color"> = mix(tslColor(bottomColor), tslColor(topColor), t);
  // horizon haze: lighten toward the bottom color near dir.y == 0
  const hazeAmount = sub(float(1), smoothstep(float(0), float(0.22), abs(dir.y)));
  colorNode = mix(colorNode, tslColor(bottomColor), mul(hazeAmount, float(0.6)));
  if (sun) {
    const sunDir = normalize(vec3(sun.direction[0], sun.direction[1], sun.direction[2]));
    const facing = clamp(dot(dir, sunDir), 0, 1);
    const glow = mul(pow(facing, float(1 / (1 - sun.size))), float(sun.intensity));
    const sunColorVec3 = tslColor(sun.color) as unknown as THREE.Node<"vec3">;
    colorNode = add(colorNode as THREE.Node<"vec3">, mul(sunColorVec3, glow));
  }
  material.colorNode = colorNode;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
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

export function geometryFor(shape: string, size: [number, number, number]): THREE.BufferGeometry {
  const [x, y, z] = size;
  switch (shape) {
    case "wedge":
      return wedgeGeometry(x, y, z);
    case "box":
      return new THREE.BoxGeometry(x, y, z);
    case "sphere":
      return new THREE.SphereGeometry(x / 2, 32, 16);
    case "plane":
      return new THREE.PlaneGeometry(x, z);
    case "cylinder":
      return new THREE.CylinderGeometry(x / 2, x / 2, y, 24);
    case "capsule":
      return new THREE.CapsuleGeometry(x / 2, Math.max(0, y - x), 8, 16);
    case "cone":
      return new THREE.ConeGeometry(x / 2, y, 24);
    case "torus":
      return new THREE.TorusGeometry(x / 2, y / 4, 16, 48);
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
 * Blends `splat.layers` by world-space height (each ascending layer overtakes
 * the previous through its own [heightStart, heightEnd] band via smoothstep,
 * exactly like terrain.ts's flatRadius falloff) plus an optional slope-driven
 * rock overlay for cliffs — so a heightmap terrain built from many tiles reads
 * as one continuous material with no per-tile hard edges, without needing any
 * authored texture or extra vertex data (purely a function of the existing
 * geometry's own position/normal).
 */
function buildTerrainSplatMaterial(data: MaterialData): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({
    transparent: data.transparent || data.opacity < 1,
    opacity: data.opacity,
    metalness: 0,
  });
  const layers = data.splat?.layers ?? [];
  if (layers.length === 0) {
    material.colorNode = tslColor(data.color);
    material.roughnessNode = float(data.roughness);
    return material;
  }
  const height = positionWorld.y;
  const layerColor = (layer: SplatLayerData): THREE.Node<"vec3"> | THREE.Node<"color"> => {
    const base = tslColor(layer.color);
    if (!layer.grassy) return base;
    // cheap per-pixel mottling (two offset sine waves over world position) —
    // no texture, no extra geometry — so a flat tint reads as a grass clump
    // pattern instead of a solid color. Deliberately small-scale/subtle: this
    // is meant to be visible up close and blend into an even tone at range.
    const n1 = sin(add(mul(positionWorld.x, float(1.7)), mul(positionWorld.z, float(2.3))));
    const n2 = sin(add(mul(positionWorld.x, float(-2.9)), mul(positionWorld.z, float(1.1))));
    const tone = add(float(1), mul(add(n1, n2), float(0.06)));
    return mul(base as unknown as THREE.Node<"vec3">, tone);
  };
  let colorNode: THREE.Node<"vec3"> | THREE.Node<"color"> = layerColor(layers[0]!);
  let roughnessNode: THREE.Node<"float"> = float(layers[0]!.roughness);
  for (let i = 1; i < layers.length; i++) {
    const layer = layers[i]!;
    const t = smoothstep(float(layer.heightStart), float(layer.heightEnd), height);
    colorNode = mix(colorNode, layerColor(layer), t);
    roughnessNode = mix(roughnessNode, float(layer.roughness), t);
  }
  const slope = data.splat?.slopeRock;
  if (slope) {
    // steepness: 0 = flat (normal straight up), 1 = vertical (normal sideways)
    const steepness = clamp(sub(float(1), normalWorld.y), 0, 1);
    const t = smoothstep(float(slope.start), float(slope.end), steepness);
    colorNode = mix(colorNode, tslColor(slope.color), t);
    roughnessNode = mix(roughnessNode, float(slope.roughness), t);
  }
  material.colorNode = colorNode;
  material.roughnessNode = roughnessNode;
  return material;
}

/**
 * Procedural water: a bounded, art-directed fresnel rim + gentle shimmer
 * instead of relying on MeshStandardMaterial's physically-based specular —
 * deliberately, since an unclamped GGX highlight across a huge flat plane at
 * grazing angles is what was blowing bloom out at distance. Every term here
 * is hand-capped ([0,1] fresnel, a small shimmer band), so it can't spike.
 */
function buildWaterMaterial(data: MaterialData): THREE.MeshStandardNodeMaterial {
  const w = data.water ?? {
    shallowColor: "#3fa8c9",
    deepColor: "#0b3150",
    rimColor: "#eaf6ff",
    waveFrequency: 0.35,
    waveSpeed: 0.6,
    fresnelPower: 3,
  };
  const material = new THREE.MeshStandardNodeMaterial({
    transparent: true,
    opacity: data.opacity,
    metalness: 0,
    roughness: 0.35,
  });
  const wave1 = sin(add(mul(positionWorld.x, float(w.waveFrequency)), mul(time, float(w.waveSpeed))));
  const wave2 = sin(
    add(mul(positionWorld.z, float(w.waveFrequency * 1.3)), mul(time, float(w.waveSpeed * 0.8))),
  );
  const ripple = mul(add(wave1, wave2), float(0.5)); // [-1, 1]
  const shimmer = add(mul(ripple, float(0.05)), float(1)); // ~[0.95, 1.05], bounded
  const base = mix(tslColor(w.deepColor), tslColor(w.shallowColor), float(0.6));
  const shaded = mul(base, shimmer);
  const viewDir = normalize(sub(cameraPosition, positionWorld));
  const fresnel = pow(saturate(sub(float(1), saturate(dot(normalWorld, viewDir)))), float(w.fresnelPower));
  material.colorNode = mix(shaded, tslColor(w.rimColor), fresnel);
  material.roughnessNode = float(0.35);
  return material;
}

export function makeMaterial(data: MaterialData): THREE.Material {
  const common = {
    color: new THREE.Color(data.color),
    opacity: data.opacity,
    transparent: data.transparent || data.opacity < 1,
  };
  switch (data.shader) {
    case "unlit":
      return new THREE.MeshBasicMaterial(common);
    case "toon":
      return new THREE.MeshToonMaterial({
        ...common,
        emissive: new THREE.Color(data.emissive),
        emissiveIntensity: data.emissiveIntensity,
      });
    case "wireframe":
      return new THREE.MeshBasicMaterial({ ...common, wireframe: true });
    case "terrain-splat":
      return buildTerrainSplatMaterial(data);
    case "water":
      return buildWaterMaterial(data);
    case "standard":
    default:
      return new THREE.MeshStandardMaterial({
        ...common,
        roughness: data.roughness,
        metalness: data.metalness,
        emissive: new THREE.Color(data.emissive),
        emissiveIntensity: data.emissiveIntensity,
      });
  }
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
  const cached = cache.get(id);
  if (cached) return cached;
  const data = options.resolveMaterial?.(id) as MaterialData | undefined;
  if (!data) {
    console.warn(`[render] no material asset "${id}" — using default`);
    return defaultMaterial;
  }
  const material = makeMaterial(data);
  const mapUrl = data.map ? options.resolveTexture?.(data.map) : undefined;
  if (mapUrl && data.shader !== "wireframe") {
    applyTextureWhenReady(
      material as THREE.Material & { map?: THREE.Texture | null },
      mapUrl,
      data.repeat ?? [1, 1],
    );
  }
  cache.set(id, material);
  return material;
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
  castShadow: boolean;
  receiveShadow: boolean;
  lod: boolean;
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
  let createdCamera: THREE.PerspectiveCamera | null = null;
  {
    const meshData = entity.components["mesh"] as MeshData | undefined;
    if (meshData && meshData.source.kind === "primitive") {
      const mesh = new THREE.Mesh(
        geometryFor(meshData.source.shape, meshData.source.size),
        resolveMaterialFor(meshData, options, materialCache),
      );
      if (meshData.source.shape === "plane") mesh.rotation.x = -Math.PI / 2;
      mesh.castShadow = meshData.castShadow;
      mesh.receiveShadow = meshData.receiveShadow;
      mesh.userData["entityId"] = id;
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
      group.add(mesh);
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
      group.add(mesh);
    }

    if (meshData && meshData.source.kind === "asset" && meshData.renderMode === "instanced") {
      const assetId = meshData.source.assetId;
      const list = ctx.instancedPending.get(assetId);
      const entry: PendingInstance = {
        id,
        group,
        node: meshData.source.node,
        castShadow: meshData.castShadow,
        receiveShadow: meshData.receiveShadow,
        lod: meshData.lod ?? true,
      };
      if (list) list.push(entry);
      else ctx.instancedPending.set(assetId, [entry]);
    } else if (meshData && meshData.source.kind === "asset") {
      const url = options.resolveModel?.(meshData.source.assetId);
      const nodeName = meshData.source.node;
      if (url) {
        // async: the model pops in when loaded; group placement is already correct
        loadGltf(url).then(
          (gltf) => {
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
            group.add(instance);
            options.onModelLoaded?.(id, instance, gltf.animations ?? []);
          },
          (error) => console.warn(`[render] failed to load model:`, error),
        );
      } else {
        console.warn(`[render] no URL for mesh asset "${meshData.source.assetId}"`);
      }
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
          if (lightData.castShadow) {
            // default frustum is ~10 units — useless for a real scene
            dir.shadow.mapSize.set(2048, 2048);
            const cam = dir.shadow.camera;
            cam.left = -40;
            cam.right = 40;
            cam.top = 40;
            cam.bottom = -40;
            cam.near = 0.5;
            cam.far = 120;
            dir.shadow.bias = -0.0004;
            dir.shadow.normalBias = 0.02;
          }
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
        light.castShadow = lightData.castShadow;
        group.add(light);
      }
    }

    const skyData = entity.components["sky"] as
      | {
          top: string;
          bottom: string;
          texture?: string;
          cubemap?: { px: string; nx: string; py: string; ny: string; pz: string; nz: string };
          light: number;
          fog?: { color: string; near: number; far: number };
          sun?: { direction: [number, number, number]; color: string; size: number; intensity: number };
        }
      | undefined;
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
        group.add(buildSkyDome(skyData.top, skyData.bottom, skyData.sun));
        scene.background = new THREE.Color(skyData.bottom);
      }
      if (skyData.fog) {
        scene.fog = new THREE.Fog(new THREE.Color(skyData.fog.color), skyData.fog.near, skyData.fog.far);
      }
      if (skyData.light > 0) {
        group.add(new THREE.HemisphereLight(new THREE.Color(skyData.top), new THREE.Color(skyData.bottom), skyData.light));
      }
    }

    const particlesData = entity.components["particles"] as ParticlesData | undefined;
    if (particlesData) options.onParticles?.(id, group, particlesData);

    const billboardData = entity.components["billboard"] as BillboardData | undefined;
    if (billboardData) options.onBillboard?.(id, group, billboardData);

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
    loadGltf(url).then(
      (gltf) => {
        const byNode = new Map<string | undefined, PendingInstance[]>();
        for (const entry of entries) {
          const bucket = byNode.get(entry.node);
          if (bucket) bucket.push(entry);
          else byNode.set(entry.node, [entry]);
        }
        for (const [node, group] of byNode) instanceGltfInto(gltf, node, group, options);
      },
      (error) => console.warn(`[render] failed to load instanced model "${assetId}":`, error),
    );
  }
}

const instanceMatrixScratch = new THREE.Matrix4();
const sourceInverseScratch = new THREE.Matrix4();

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
function buildLodProxyGeometry(
  submeshes: Array<{ geometry: THREE.BufferGeometry; localMatrix: THREE.Matrix4 }>,
): { geometry: THREE.BufferGeometry; isTall: boolean; width?: number; height?: number } {
  const bbox = new THREE.Box3();
  const scratchBox = new THREE.Box3();
  for (const sub of submeshes) {
    sub.geometry.computeBoundingBox();
    scratchBox.copy(sub.geometry.boundingBox!).applyMatrix4(sub.localMatrix);
    bbox.union(scratchBox);
  }
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

interface MaterialLook {
  color: THREE.Color;
  /** The model's ACTUAL color/detail texture, when it has one — most nature
   * assets get their real look from this, not a flat `.color` tint (which
   * defaults to white on a textured material, i.e. exactly the "gray blob"
   * a color-only proxy produces). */
  map: THREE.Texture | null;
}

function materialLook(material: THREE.Material | THREE.Material[]): MaterialLook {
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
 * When a real baked snapshot of the model is available (`bakedTexture` — a
 * render-to-texture front view, see `bakeBillboardTexture` in BuildOptions),
 * that wins outright: it already has a correct, natural silhouette from its
 * own alpha channel, so the round mask (meant to soften an arbitrary flat
 * texture sample) would only clip real detail near the card edges. Absent a
 * bake, this falls back to the model's own material texture/color.
 */
function buildFarProxyMaterial(
  isTall: boolean,
  look: MaterialLook,
  bakedTexture: THREE.Texture | null,
): THREE.MeshLambertNodeMaterial {
  if (bakedTexture) {
    // render-target textures come out V-flipped relative to a normal loaded
    // image (the same top-left-vs-bottom-up row-order gotcha the prefab
    // thumbnail readback has to correct for) — flip the sample here rather
    // than fight the renderer's own convention.
    const flippedUv = vec2(uv().x, sub(float(1), uv().y));
    const sampled = tslTexture(bakedTexture, flippedUv);
    const material = new THREE.MeshLambertNodeMaterial({
      colorNode: sampled,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    material.opacityNode = sampled.a;
    return material;
  }
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

function instanceGltfInto(
  gltf: GLTF,
  node: string | undefined,
  entries: PendingInstance[],
  options: BuildOptions,
): void {
  let source: THREE.Object3D = gltf.scene;
  if (node) {
    const found = gltf.scene.getObjectByName(node);
    if (!found) {
      console.warn(`[render] node "${node}" not found in instanced model`);
      return;
    }
    source = found;
  }
  source.updateWorldMatrix(true, true);
  sourceInverseScratch.copy(source.matrixWorld).invert();

  const submeshes: Array<{
    geometry: THREE.BufferGeometry;
    material: THREE.Material | THREE.Material[];
    localMatrix: THREE.Matrix4;
  }> = [];
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
  if (submeshes.length === 0) return;

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
  let root: THREE.Object3D = first.group;
  while (root.parent) root = root.parent;

  const nearMeshes: THREE.InstancedMesh[] = [];
  for (const sub of submeshes) {
    const instanced = new THREE.InstancedMesh(
      sub.geometry.clone(),
      Array.isArray(sub.material) ? sub.material.map((m) => m.clone()) : sub.material.clone(),
      entries.length,
    );
    instanced.castShadow = first.castShadow;
    instanced.receiveShadow = first.receiveShadow;
    instanced.userData["instancedEntityIds"] = entries.map((e) => e.id);
    for (let i = 0; i < entries.length; i++) {
      instanceMatrixScratch.copy(matrices[i]!).multiply(sub.localMatrix);
      instanced.setMatrixAt(i, instanceMatrixScratch);
    }
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

  // far tier: one cheap proxy standing in for the whole model. Its look comes
  // from the LARGEST submesh by vertex count, not just the first one — a
  // tree's bark/trunk material is typically submesh 0 but a thin sliver next
  // to the leaf canopy, which is what actually reads as "this is a tree".
  const { geometry: farGeometry, isTall, width, height } = buildLodProxyGeometry(submeshes);
  const dominantSubmesh = submeshes.reduce((a, b) =>
    b.geometry.attributes["position"]!.count > a.geometry.attributes["position"]!.count ? b : a,
  );
  // a real snapshot of the model (see bakeBillboardTexture) beats any texture
  // guess — pass a throwaway clone, never the shared cached `source` itself
  const bakedTexture =
    isTall && width && height
      ? (options.bakeBillboardTexture?.(source.clone(true), { width, height }) ?? null)
      : null;
  const farMaterial = buildFarProxyMaterial(isTall, materialLook(dominantSubmesh.material), bakedTexture);
  const far = new THREE.InstancedMesh(farGeometry, farMaterial, entries.length);
  far.castShadow = false; // a rough blob casting a shadow reads worse than no shadow
  far.receiveShadow = first.receiveShadow;
  for (let i = 0; i < entries.length; i++) far.setMatrixAt(i, matrices[i]!);
  far.instanceMatrix.needsUpdate = true;
  far.computeBoundingSphere();
  root.add(far);

  const batch: InstancedPropBatch = { near: nearMeshes, far, positions, matrices };
  for (const mesh of nearMeshes) mesh.userData["foliageLodBatch"] = batch;
  far.userData["foliageLodBatch"] = batch;
  options.onInstancedBatch?.(batch);
}

export function buildScene(doc: SceneDoc, options: BuildOptions = {}): BuiltScene {
  const scene = new THREE.Scene();
  const objects = new Map<string, THREE.Object3D>();
  const cameras = new Map<string, THREE.PerspectiveCamera>();
  const materialCache = new Map<string, THREE.Material>();
  const instancedPending = new Map<string, PendingInstance[]>();
  let activeCamera: THREE.PerspectiveCamera | null = null;

  for (const [id, entity] of Object.entries(doc.entities)) {
    const group = new THREE.Group();
    group.name = entity.name;
    group.userData["entityId"] = id;
    applyEntityTransform(group, entity);

    const camera = populateEntityGroup(group, id, entity, { options, materialCache, scene, instancedPending });
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

  return { scene, objects, activeCamera, cameras };
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
    group.remove(child);
  }
  applyEntityTransform(group, entity);
  const instancedPending = new Map<string, PendingInstance[]>();
  populateEntityGroup(group, id, entity, { options, materialCache, scene: null, instancedPending });
  // a single entity's own group is already fully placed — flush immediately
  flushInstancedPending(instancedPending, options);
}
