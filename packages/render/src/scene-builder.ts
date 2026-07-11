import * as THREE from "three/webgpu";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import { heightmapMesh, type HeightmapParams, type SceneDoc } from "@hitreg/core";
import type { ParticlesData } from "./particles.js";
import type { BillboardData } from "./billboards.js";

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
}

export interface MaterialData {
  shader: "standard" | "unlit" | "toon" | "wireframe";
  color: string;
  map?: string;
  repeat: [number, number];
  roughness: number;
  metalness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
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

/** Gradient dome: vertex-colored inverted sphere — no custom shaders, so it
 * renders identically on the WebGPU and WebGL backends. */
function buildSkyDome(top: string, bottom: string): THREE.Mesh {
  const radius = 450;
  const geometry = new THREE.SphereGeometry(radius, 24, 14);
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  const topColor = new THREE.Color(top);
  const bottomColor = new THREE.Color(bottom);
  const mixed = new THREE.Color();
  for (let i = 0; i < positions.count; i++) {
    const t = Math.pow(Math.max(0, (positions.getY(i) / radius + 0.35) / 1.35), 0.9);
    mixed.copy(bottomColor).lerp(topColor, t);
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    }),
  );
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

interface PopulateContext {
  options: BuildOptions;
  materialCache: Map<string, THREE.Material>;
  /** buildScene only — sky components write scene background/fog; reconcile
   * bails on sky entities before ever getting here. */
  scene: THREE.Scene | null;
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

    if (meshData && meshData.source.kind === "asset") {
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
        group.add(buildSkyDome(skyData.top, skyData.bottom));
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

export function buildScene(doc: SceneDoc, options: BuildOptions = {}): BuiltScene {
  const scene = new THREE.Scene();
  const objects = new Map<string, THREE.Object3D>();
  const cameras = new Map<string, THREE.PerspectiveCamera>();
  const materialCache = new Map<string, THREE.Material>();
  let activeCamera: THREE.PerspectiveCamera | null = null;

  for (const [id, entity] of Object.entries(doc.entities)) {
    const group = new THREE.Group();
    group.name = entity.name;
    group.userData["entityId"] = id;
    applyEntityTransform(group, entity);

    const camera = populateEntityGroup(group, id, entity, { options, materialCache, scene });
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
  populateEntityGroup(group, id, entity, { options, materialCache, scene: null });
}
