import * as THREE from "three/webgpu";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { attribute, float, mul } from "three/tsl";
import { loadSharedTexture } from "./material-maps.js";

/**
 * Projected decals — the `decal` component (see @hitreg/core
 * components/decal.ts). The doc carries intent (texture, size, projection);
 * this module turns it into fitted geometry with three's DecalGeometry:
 * collect the static meshes whose world AABB intersects the projection box,
 * clip-project each, merge, and parent the result under the decal entity's
 * own group (so selection/gizmos/visibility work like any other visual, and
 * the visuals-rebuild strip pass cleans it up for free).
 *
 * Re-projection contract (wired in scene-builder.ts / reconcile.ts):
 * - initial build          -> flushDecals after the parenting pass
 * - decal component edited -> visuals rebuild -> syncEntityDecals
 * - decal entity moved     -> reconcile escalates transform to a visuals
 *                             rebuild (fitted geometry is baked against world
 *                             space) -> syncEntityDecals
 * - nearby geometry edited -> syncEntityDecals re-fits neighbouring decals
 * - nearby geometry moved  -> reconcile's transform patch calls
 *                             reprojectDecalsAround
 *
 * v1 limits (deliberate): only meshes present at projection time receive
 * decals — async glTF models that pop in later, InstancedMesh batches and
 * skinned meshes are skipped; and a chunk-cell build only projects onto its
 * own cell's content.
 */

/** Mirrors the core `decal` schema (post-validation shape). */
export interface DecalData {
  texture: string;
  size: [number, number];
  depth: number;
  rotation: number;
  direction: [number, number, number];
  opacity: number;
  color: string;
  fadeDepth?: number;
  sortOffset?: number;
}

/** One entity's pending decal, accumulated during populate, flushed after parenting. */
export interface DecalRequest {
  id: string;
  group: THREE.Object3D;
  data: DecalData;
}

/** The slice of BuildOptions decal projection actually needs. */
export interface DecalBuildOptions {
  resolveTexture?(assetId: string): string | undefined;
  resolveMaxAnisotropy?(): number;
}

interface LiveDecal {
  id: string;
  group: THREE.Object3D;
  data: DecalData;
  /** World AABB of the projection box — the "does this edit affect me" test. */
  box: THREE.Box3;
  /** Entity ids the projection actually landed on last time. */
  targets: Set<string>;
  /** Kept across re-projections so a dragged wall doesn't recompile pipelines. */
  material: THREE.Material;
}

// Per-built-scene decal registry. WeakMap so an unloaded chunk's whole build
// (and its registry) is GC'd with the scene object, nothing to unhook.
const decalRegistries = new WeakMap<THREE.Object3D, Map<string, LiveDecal>>();

function registryFor(root: THREE.Object3D): Map<string, LiveDecal> {
  let registry = decalRegistries.get(root);
  if (!registry) {
    registry = new Map();
    decalRegistries.set(root, registry);
  }
  return registry;
}

// Decal textures clamp instead of repeat: the projected UVs stay in [0,1],
// but the shared texture cache configures RepeatWrapping — filtering at the
// sticker's border would then bleed the opposite edge in. Cloning shares the
// decoded image (one decode) at the cost of a second GPU upload, cached per
// url so many decals share one clamped instance.
const decalTextureCache = new Map<string, Promise<THREE.Texture>>();

function loadDecalTexture(url: string, maxAnisotropy: number): Promise<THREE.Texture> {
  const key = `${maxAnisotropy}|${url}`;
  let pending = decalTextureCache.get(key);
  if (!pending) {
    pending = loadSharedTexture(url, true, maxAnisotropy).then((shared) => {
      const clamped = shared.clone();
      clamped.wrapS = THREE.ClampToEdgeWrapping;
      clamped.wrapT = THREE.ClampToEdgeWrapping;
      clamped.needsUpdate = true;
      return clamped;
    });
    // a failed load must not poison the cache forever (same rule as the shared cache)
    pending.catch(() => {
      if (decalTextureCache.get(key) === pending) decalTextureCache.delete(key);
    });
    decalTextureCache.set(key, pending);
  }
  return pending;
}

/** World AABB of the oriented projection box (its 8 corners, expanded). */
function projectorWorldBox(
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  size: THREE.Vector3,
): THREE.Box3 {
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    corner
      .set(
        (i & 1 ? 0.5 : -0.5) * size.x,
        (i & 2 ? 0.5 : -0.5) * size.y,
        (i & 4 ? 0.5 : -0.5) * size.z,
      )
      .applyQuaternion(quaternion)
      .add(position);
    box.expandByPoint(corner);
  }
  return box;
}

const targetBoxScratch = new THREE.Box3();

/**
 * Candidate receivers: every plain static mesh whose world AABB intersects
 * the projection box. Instanced/skinned meshes, other decals, collider
 * proxies, the sky dome and the decal entity's own meshes are excluded.
 */
function collectTargetMeshes(root: THREE.Object3D, worldBox: THREE.Box3, selfId: string): THREE.Mesh[] {
  const targets: THREE.Mesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    if ((mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    if ((mesh as unknown as { isInstancedProps?: boolean }).isInstancedProps) return;
    if ((mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (mesh.userData["decal"] === true) return;
    if (mesh.userData["isColliderProxy"] === true || mesh.userData["skyDome"] === true) return;
    if (mesh.userData["entityId"] === selfId) return;
    const position = mesh.geometry?.getAttribute("position");
    if (!position || position.count === 0) return;
    if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
    targetBoxScratch.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
    if (targetBoxScratch.intersectsBox(worldBox)) targets.push(mesh);
  });
  return targets;
}

/**
 * Per-vertex alpha falloff toward the projection box's front/back planes
 * (projector-space |z| running from `depth/2 - fadeDepth` to `depth/2`), so
 * wrapped edges feather out instead of ending in a hard clip. Must run while
 * the geometry is still in world space.
 */
function writeFadeAttribute(
  geometry: THREE.BufferGeometry,
  projectorInverse: THREE.Matrix4,
  depth: number,
  fadeDepth: number,
): void {
  const positionAttr = geometry.getAttribute("position");
  if (!positionAttr) return;
  const fade = new Float32Array(positionAttr.count);
  const v = new THREE.Vector3();
  const half = depth / 2;
  const start = Math.max(0, half - fadeDepth);
  for (let i = 0; i < positionAttr.count; i++) {
    v.fromBufferAttribute(positionAttr, i).applyMatrix4(projectorInverse);
    fade[i] = 1 - THREE.MathUtils.smoothstep(Math.abs(v.z), start, half);
  }
  geometry.setAttribute("decalFade", new THREE.BufferAttribute(fade, 1));
}

function makeDecalMaterial(
  data: DecalData,
  url: string,
  options: DecalBuildOptions,
  group: THREE.Object3D,
): THREE.Material {
  const material = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(data.color),
    roughness: 0.9,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    opacity: data.opacity,
  });
  if (data.fadeDepth !== undefined && data.fadeDepth > 0) {
    // NodeMaterial multiplies opacityNode with the color map's own alpha, so
    // the sticker silhouette survives the depth feathering.
    material.opacityNode = mul(float(data.opacity), float(attribute<"float">("decalFade", "float")));
  }
  const epoch = group.userData["visualsEpoch"] as number | undefined;
  loadDecalTexture(url, options.resolveMaxAnisotropy?.() ?? 0).then(
    (texture) => {
      // the entity's visuals were rebuilt while the image decoded — a newer
      // material owns the decal now
      if (group.userData["visualsEpoch"] !== epoch) return;
      material.map = texture;
      material.needsUpdate = true;
    },
    (error) => console.warn(`[render] decal texture failed to load: ${url}`, error),
  );
  return material;
}

/**
 * Project one decal entity onto the geometry behind it and parent the fitted
 * mesh under the entity's group. Registers the decal (even when nothing was
 * hit — geometry moved into the box later must still re-fit it). Missing
 * texture id: warn and skip. Zero candidate meshes: register, no mesh, no
 * crash. Requires `root`'s matrixWorlds to be current (callers update once).
 */
function buildDecal(
  root: THREE.Object3D,
  request: DecalRequest,
  options: DecalBuildOptions,
  reuseMaterial?: THREE.Material,
): void {
  const { id, group, data } = request;
  const url = options.resolveTexture?.(data.texture);
  if (!url) {
    console.warn(`[render] decal "${id}": no texture asset "${data.texture}" — skipping`);
    return;
  }

  group.updateWorldMatrix(true, false);
  const position = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld);
  const projectorQuat = group.getWorldQuaternion(new THREE.Quaternion());
  // aim the projector's -Z along the authored LOCAL direction, then roll
  // `rotation` degrees around the projection axis
  const direction = new THREE.Vector3(data.direction[0], data.direction[1], data.direction[2]);
  if (direction.lengthSq() < 1e-10) direction.set(0, 0, -1);
  direction.normalize();
  projectorQuat
    .multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction))
    .multiply(
      new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        THREE.MathUtils.degToRad(data.rotation ?? 0),
      ),
    );
  const orientation = new THREE.Euler().setFromQuaternion(projectorQuat);
  const size = new THREE.Vector3(
    Math.max(data.size[0], 0.01),
    Math.max(data.size[1], 0.01),
    Math.max(data.depth, 0.01),
  );
  const worldBox = projectorWorldBox(position, projectorQuat, size);

  const targets = collectTargetMeshes(root, worldBox, id);
  const targetIds = new Set<string>();
  const pieces: THREE.BufferGeometry[] = [];
  for (const mesh of targets) {
    // DecalGeometry emits WORLD-space triangles clipped to the projector box,
    // with UVs spread across the box's x/y
    const piece = new DecalGeometry(mesh, position, orientation, size);
    if ((piece.getAttribute("position")?.count ?? 0) === 0) {
      piece.dispose();
      continue;
    }
    // sources without normals (defensive — engine meshes all carry them)
    // would break the merge below and light wrongly
    if (!piece.getAttribute("normal")) piece.computeVertexNormals();
    pieces.push(piece);
    const entityId = mesh.userData["entityId"];
    if (typeof entityId === "string") targetIds.add(entityId);
  }

  const material = reuseMaterial ?? makeDecalMaterial(data, url, options, group);
  registryFor(root).set(id, { id, group, data, box: worldBox, targets: targetIds, material });
  if (pieces.length === 0) return; // nothing behind the projector

  const projectorMatrix = new THREE.Matrix4().makeRotationFromEuler(orientation).setPosition(position);
  const projectorInverse = projectorMatrix.clone().invert();
  const groupInverse = group.matrixWorld.clone().invert();
  const attach = (geometry: THREE.BufferGeometry): void => {
    if (data.fadeDepth !== undefined && data.fadeDepth > 0) {
      writeFadeAttribute(geometry, projectorInverse, size.z, data.fadeDepth);
    }
    // world -> entity-local, so the fitted mesh rides the entity's group like
    // any other visual (and the strip pass in rebuildEntityVisuals removes it)
    geometry.applyMatrix4(groupInverse);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = data.sortOffset ?? 0;
    mesh.userData["entityId"] = id;
    mesh.userData["decal"] = true;
    group.add(mesh);
  };
  const merged = pieces.length === 1 ? pieces[0]! : mergeGeometries(pieces, false);
  if (merged) {
    if (pieces.length > 1) for (const piece of pieces) piece.dispose();
    attach(merged);
  } else {
    // attribute mismatch the normalization above didn't cover — degrade to
    // one mesh per receiver rather than dropping the decal
    for (const piece of pieces) attach(piece);
  }
}

function stripDecalMeshes(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    if (child.userData["decal"] === true) {
      group.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
  }
}

/** Re-fit one live decal in place (its material survives). */
function reprojectDecal(root: THREE.Object3D, live: LiveDecal, options: DecalBuildOptions): void {
  stripDecalMeshes(live.group);
  buildDecal(root, { id: live.id, group: live.group, data: live.data }, options, live.material);
}

/**
 * Project every pending decal of a build. Called by buildScene after the
 * parenting pass (world matrices must be real before projecting).
 */
export function flushDecals(
  root: THREE.Object3D,
  requests: DecalRequest[],
  options: DecalBuildOptions,
): void {
  if (requests.length === 0) return;
  root.updateMatrixWorld(true);
  for (const request of requests) buildDecal(root, request, options);
}

/**
 * Geometry under `id` moved or changed shape — re-fit every decal it might
 * affect: any decal that previously landed on it, or whose projection box
 * intersects its current bounds. Cheap no-op for scenes with no decals.
 */
export function reprojectDecalsAround(
  root: THREE.Object3D,
  id: string,
  group: THREE.Object3D,
  options: DecalBuildOptions,
): void {
  const registry = decalRegistries.get(root);
  if (!registry || registry.size === 0) return;
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  for (const live of [...registry.values()]) {
    if (live.group === group) continue; // its own decal is handled by the visuals path
    if (live.targets.has(id) || (!bounds.isEmpty() && live.box.intersectsBox(bounds))) {
      reprojectDecal(root, live, options);
    }
  }
}

/**
 * After one entity's visuals were rebuilt in place (rebuildEntityVisuals):
 * rebuild its own decal from `requests` (empty when the component was
 * removed — the stale registry entry is dropped; the stale meshes were
 * already stripped), then re-fit neighbouring decals over its new geometry.
 */
export function syncEntityDecals(
  root: THREE.Object3D,
  id: string,
  group: THREE.Object3D,
  requests: DecalRequest[],
  options: DecalBuildOptions,
): void {
  const registry = decalRegistries.get(root);
  if (registry && !requests.some((request) => request.id === id)) registry.delete(id);
  flushDecals(root, requests, options);
  reprojectDecalsAround(root, id, group, options);
}
