import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { SceneDoc } from "@hitreg/core";

export interface BuildOptions {
  /** Resolve a mesh asset id to a fetchable glTF/GLB URL (from the AssetLibrary). */
  resolveModel?(assetId: string): string | undefined;
  /** Resolve a material asset id to its (schema-validated) material data. */
  resolveMaterial?(assetId: string): unknown | undefined;
}

interface MaterialData {
  shader: "standard" | "unlit" | "toon" | "wireframe";
  color: string;
  roughness: number;
  metalness: number;
  emissive: string;
  emissiveIntensity: number;
  opacity: number;
  transparent: boolean;
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
    | { kind: "asset"; assetId: string }
    | {
        kind: "polygon";
        points: Array<[number, number]>;
        height: number;
        bevel?: { size: number; segments: number };
      };
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
}

const defaultMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa0a8,
  roughness: 0.85,
  metalness: 0.05,
});

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

function geometryFor(shape: string, size: [number, number, number]): THREE.BufferGeometry {
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
function makeMaterial(data: MaterialData): THREE.Material {
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

function resolveMaterialFor(
  meshData: MeshData,
  options: BuildOptions,
  cache: Map<string, THREE.Material>,
): THREE.Material {
  const id = meshData.material;
  if (!id) return defaultMaterial;
  const cached = cache.get(id);
  if (cached) return cached;
  const data = options.resolveMaterial?.(id) as MaterialData | undefined;
  if (!data) {
    console.warn(`[render] no material asset "${id}" — using default`);
    return defaultMaterial;
  }
  const material = makeMaterial(data);
  cache.set(id, material);
  return material;
}

export function buildScene(doc: SceneDoc, options: BuildOptions = {}): BuiltScene {
  const scene = new THREE.Scene();
  const objects = new Map<string, THREE.Object3D>();
  const materialCache = new Map<string, THREE.Material>();
  let activeCamera: THREE.PerspectiveCamera | null = null;

  for (const [id, entity] of Object.entries(doc.entities)) {
    const group = new THREE.Group();
    group.name = entity.name;
    group.userData["entityId"] = id;

    const transform = entity.components["transform"] as TransformData | undefined;
    if (transform) {
      group.position.fromArray(transform.position);
      group.quaternion.fromArray(transform.rotation);
      group.scale.fromArray(transform.scale);
    }

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

    if (meshData && meshData.source.kind === "asset") {
      const url = options.resolveModel?.(meshData.source.assetId);
      if (url) {
        // async: the model pops in when loaded; group placement is already correct
        (gltfLoader ??= new GLTFLoader()).loadAsync(url).then(
          (gltf) => {
            gltf.scene.traverse((node) => {
              if ((node as THREE.Mesh).isMesh) {
                node.castShadow = meshData.castShadow;
                node.receiveShadow = meshData.receiveShadow;
              }
              node.userData["entityId"] = id;
            });
            group.add(gltf.scene);
          },
          (error) => console.warn(`[render] failed to load model ${meshData.source.kind === "asset" ? meshData.source.assetId : ""}:`, error),
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

    const cameraData = entity.components["camera"] as CameraData | undefined;
    if (cameraData) {
      const camera = new THREE.PerspectiveCamera(
        cameraData.fov,
        1, // aspect is the renderer's business
        cameraData.near,
        cameraData.far,
      );
      group.add(camera);
      if (cameraData.active && !activeCamera) activeCamera = camera;
    }

    objects.set(id, group);
  }

  // second pass: parenting (order-independent)
  for (const [id, entity] of Object.entries(doc.entities)) {
    const object = objects.get(id)!;
    const parent = entity.parent ? objects.get(entity.parent) : undefined;
    (parent ?? scene).add(object);
  }

  return { scene, objects, activeCamera };
}
