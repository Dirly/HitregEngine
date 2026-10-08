import type * as THREE from "three/webgpu";
import { frozenSubtreeVersion, isFrozenStaticSubtree } from "./static-transforms.js";

/** Prune branches with no render work once, before the main/shadow passes.
 * Bone-only rigs, empty entity groups and empty instance tiers otherwise get
 * projected again for every cascade. Matrices must already be current: bones
 * still drive skinning even though they do not draw anything themselves.
 * Borrow visibility only until the synchronous render finishes; never freeze
 * gameplay, retain visibility verdicts between frames, or change authored flags.
 *
 * With `cull`, also a screen-size cull for this walk: a mesh whose bounding
 * sphere would cover fewer than `minRadiusPx` pixels of radius at `eye` is
 * treated as drawing nothing (hidden for this frame only, restored with the
 * rest). A town 300 m away was ~250 of 310 main-pass draws at under 10 px
 * each, and a draw costs the CPU the same whether it covers one pixel or a
 * million. `pxPerUnit` = (viewport height / 2) / tan(fov / 2).
 */
export interface ScreenCull {
  eye: THREE.Vector3;
  pxPerUnit: number;
  minRadiusPx: number;
}
let screenCull: ScreenCull | null = null;

export function hideNonRenderingBranches(root: THREE.Object3D, shadowless?: THREE.Object3D[], cull?: ScreenCull | null): THREE.Object3D[] {
  screenCull = cull && cull.pxPerUnit > 0 && cull.minRadiusPx > 0 ? cull : null;
  const hidden: THREE.Object3D[] = [];
  collectEmpty(root, root, hidden, shadowless ?? null);
  for (const object of hidden) object.visible = false;
  return hidden;
}

/** collectEmpty's verdict bits for a branch. */
const DRAWS = 1;
/** Holds a shadow caster, a light, or something we cannot see into (LOD, bundle). */
const SHADOW = 2;

type RenderNode = THREE.Object3D & {
  isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean;
  isLight?: boolean; isLOD?: boolean; isBundleGroup?: boolean;
  isBone?: boolean; isGroup?: boolean;
  isInstancedProps?: boolean; instanceCount?: number; isInstancedMesh?: boolean; isBatchedMesh?: boolean;
};

/**
 * The world-space-ish sphere to judge an object's screen size by, or null to
 * never size-cull it. Anything drawing many instances (InstancedMesh, the
 * engine's InstancedProps, BatchedMesh, instanced geometry) counts only by
 * its OWN instance-covering sphere: its geometry's sphere is one tree at the
 * origin, and judging a forest by it hid every distant tree. A skinned mesh
 * uses its geometry (bind pose) — reading its live `boundingSphere` would run
 * the skinned-bounds pass this is meant to save.
 */
function sizeSphereOf(object: RenderNode, geometry: THREE.BufferGeometry): THREE.Sphere | null {
  const many = object.isInstancedMesh || object.isInstancedProps || object.isBatchedMesh ||
    (geometry as { isInstancedBufferGeometry?: boolean }).isInstancedBufferGeometry === true;
  if (many) return (object as { boundingSphere?: THREE.Sphere | null }).boundingSphere ?? null;
  return geometry.boundingSphere;
}

// A bone-only branch cannot draw, regardless of its animated transforms or
// visibility. Cache that structural fact; attachment/reparent events invalidate
// every cached bone ancestor before the next render. Weak keys and listeners
// attached to their own node do not retain unloaded characters.
const boneOnly = new WeakMap<THREE.Object3D, boolean>();
const watchedBones = new WeakSet<THREE.Object3D>();
function invalidateBones(this: THREE.Object3D): void {
  for (let node: RenderNode | null = this; node?.isBone; node = node.parent) boneOnly.delete(node);
}
function onlyBones(object: RenderNode): boolean {
  const cached = boneOnly.get(object);
  if (cached !== undefined) return cached;
  if (!watchedBones.has(object)) {
    object.addEventListener("childadded", invalidateBones);
    object.addEventListener("childremoved", invalidateBones);
    watchedBones.add(object);
  }
  let result = true;
  // Visit every child even after a non-bone attachment: all bone descendants
  // need their invalidation listeners before caching an ancestor's verdict.
  for (const child of object.children as RenderNode[]) {
    if (!child.isBone || !onlyBones(child)) result = false;
  }
  boneOnly.set(object, result);
  return result;
}

function tooSmall(object: RenderNode, cull: ScreenCull): boolean {
  // only plain frustum-culled geometry: sky domes, water sheets, lights and
  // anything that opted out of frustum culling are never size-culled
  if (object.isLight || object.frustumCulled === false) return false;
  const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (!geometry) return false;
  const sphere = sizeSphereOf(object, geometry);
  if (!sphere) return false; // never computed: three will, on its first frustum test; skip until then
  const e = object.matrixWorld.elements;
  const c = sphere.center;
  const x = e[0]! * c.x + e[4]! * c.y + e[8]! * c.z + e[12]! - cull.eye.x;
  const y = e[1]! * c.x + e[5]! * c.y + e[9]! * c.z + e[13]! - cull.eye.y;
  const z = e[2]! * c.x + e[6]! * c.y + e[10]! * c.z + e[14]! - cull.eye.z;
  const scale = Math.sqrt(Math.max(
    e[0]! * e[0]! + e[1]! * e[1]! + e[2]! * e[2]!,
    e[4]! * e[4]! + e[5]! * e[5]! + e[6]! * e[6]!,
    e[8]! * e[8]! + e[9]! * e[9]! + e[10]! * e[10]!,
  ));
  const r = sphere.radius * scale * cull.pxPerUnit;
  const limit = cull.minRadiusPx;
  // radius_px = r / distance < limit  <=>  r^2 < limit^2 * d^2 (no sqrt)
  return r * r < limit * limit * (x * x + y * y + z * z);
}

/**
 * World-space bounds of a static subtree (everything under a frozen root),
 * cached against that root's version and built bottom-up from the children's
 * cached bounds, so the first frame costs one visit per node. A `blocked`
 * subtree is never size-culled: it holds a light, an LOD/bundle, a skinned or
 * unsized object. An empty one (no extent) adds nothing to its parent.
 */
interface SubtreeBounds {
  version: number; frozen: THREE.Object3D; blocked: boolean;
  minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  x: number; y: number; z: number; r: number;
}
const subtreeBounds = new WeakMap<THREE.Object3D, SubtreeBounds>();

/** Extend `into` by `o`'s own geometry; false when `o` must block culling. */
function addLeaf(o: RenderNode, into: SubtreeBounds): boolean {
  // A hidden light is a light-budget SOURCE (the budget hides every authored
  // point light for good and lights the scene from its own slot pool), so
  // hiding the lamp around it changes nothing; a visible one blocks.
  if (o.isLight) return !o.visible;
  if (o.isLOD || o.isBundleGroup || (o as unknown as THREE.SkinnedMesh).isSkinnedMesh) return false;
  const geometry = (o as unknown as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (!geometry) return true; // structural: no extent of its own
  if (o.frustumCulled === false) return false;
  const many = o.isInstancedMesh || o.isInstancedProps || o.isBatchedMesh ||
    (geometry as { isInstancedBufferGeometry?: boolean }).isInstancedBufferGeometry === true;
  let sphere = sizeSphereOf(o, geometry);
  if (!sphere && !many) { geometry.computeBoundingSphere(); sphere = geometry.boundingSphere; }
  if (!sphere) return false; // an instanced batch with no own sphere yet blocks culling
  const e = o.matrixWorld.elements;
  const c = sphere.center;
  const x = e[0]! * c.x + e[4]! * c.y + e[8]! * c.z + e[12]!;
  const y = e[1]! * c.x + e[5]! * c.y + e[9]! * c.z + e[13]!;
  const z = e[2]! * c.x + e[6]! * c.y + e[10]! * c.z + e[14]!;
  const r = sphere.radius * Math.sqrt(Math.max(
    e[0]! * e[0]! + e[1]! * e[1]! + e[2]! * e[2]!,
    e[4]! * e[4]! + e[5]! * e[5]! + e[6]! * e[6]!,
    e[8]! * e[8]! + e[9]! * e[9]! + e[10]! * e[10]!,
  ));
  if (x - r < into.minX) into.minX = x - r;
  if (y - r < into.minY) into.minY = y - r;
  if (z - r < into.minZ) into.minZ = z - r;
  if (x + r > into.maxX) into.maxX = x + r;
  if (y + r > into.maxY) into.maxY = y + r;
  if (z + r > into.maxZ) into.maxZ = z + r;
  return true;
}

/** Cullable bounds of a static subtree, or null when it is blocked or empty. */
function boundsOf(node: RenderNode, frozen: THREE.Object3D): SubtreeBounds | null {
  const b = subtreeBoundsOf(node, frozen);
  return b.blocked || b.minX === Infinity ? null : b;
}

function subtreeBoundsOf(node: RenderNode, frozen: THREE.Object3D): SubtreeBounds {
  const version = frozenSubtreeVersion(frozen);
  const cached = subtreeBounds.get(node);
  if (cached && cached.version === version && cached.frozen === frozen) return cached;
  const b: SubtreeBounds = {
    version, frozen, blocked: false,
    minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
    x: 0, y: 0, z: 0, r: 0,
  };
  if (!addLeaf(node, b)) b.blocked = true;
  for (const child of node.children as RenderNode[]) {
    if (b.blocked) break;
    const cb = subtreeBoundsOf(child, isFrozenStaticSubtree(child) ? child : frozen);
    if (cb.blocked) { b.blocked = true; break; }
    if (cb.minX === Infinity) continue; // empty: no extent
    if (cb.minX < b.minX) b.minX = cb.minX;
    if (cb.minY < b.minY) b.minY = cb.minY;
    if (cb.minZ < b.minZ) b.minZ = cb.minZ;
    if (cb.maxX > b.maxX) b.maxX = cb.maxX;
    if (cb.maxY > b.maxY) b.maxY = cb.maxY;
    if (cb.maxZ > b.maxZ) b.maxZ = cb.maxZ;
  }
  if (b.minX !== Infinity) {
    b.x = (b.minX + b.maxX) / 2; b.y = (b.minY + b.maxY) / 2; b.z = (b.minZ + b.maxZ) / 2;
    b.r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) / 2;
  }
  subtreeBounds.set(node, b);
  return b;
}

/**
 * Returns DRAWS|SHADOW bits. With `shadowless`, also collects the highest
 * branches that draw but hold no shadow caster and no light: a shadow pass
 * can skip them whole. Each cascade otherwise walks and frustum-tests the
 * entire visible scene to find the dozen casters inside its range.
 *
 * `frozen` is the nearest frozen-static root above (or at) `object`: under
 * one, a whole group can be size-culled from its cached bounds without
 * visiting what is inside — a far town's lamps and props go in one test.
 */
function collectEmpty(
  object: RenderNode,
  root: THREE.Object3D,
  hidden: THREE.Object3D[],
  shadowless: THREE.Object3D[] | null,
  frozen: THREE.Object3D | null = null,
): number {
  if (!object.visible) return 0;
  // LOD changes child visibility while Three projects EACH camera. Bundles own
  // cached render lists. Do not change anything inside either special subtree.
  if (object.isLOD || object.isBundleGroup) return DRAWS | SHADOW;
  if (object.isBone && onlyBones(object)) {
    if (object !== root) hidden.push(object);
    return 0;
  }
  if (isFrozenStaticSubtree(object)) frozen = object;
  if (screenCull && frozen && object !== root && object.children.length > 0 &&
      (object.isGroup || object.type === "Object3D")) {
    const b = boundsOf(object, frozen);
    if (b) {
      const dx = b.x - screenCull.eye.x, dy = b.y - screenCull.eye.y, dz = b.z - screenCull.eye.z;
      const r = b.r * screenCull.pxPerUnit;
      const limit = screenCull.minRadiusPx;
      if (r * r < limit * limit * (dx * dx + dy * dy + dz * dz)) {
        hidden.push(object);
        return 0;
      }
    }
  }
  const draws = !(object.isGroup || object.isBone) && object.layers.mask !== 0 &&
    !!(object.isMesh || object.isLine || object.isPoints || object.isSprite || object.isLight) &&
    !(object.isInstancedProps && object.instanceCount === 0) &&
    !(screenCull && tooSmall(object, screenCull));
  let bits = draws ? DRAWS : 0;
  if (object.isLight || (draws && object.castShadow)) bits |= SHADOW;
  const start = hidden.length;
  const shadowStart = shadowless ? shadowless.length : 0;
  for (const child of object.children) bits |= collectEmpty(child, root, hidden, shadowless, frozen);
  if (!(bits & DRAWS) && object !== root) {
    // Hide only the highest empty ancestor, not every bone in a rig. Leave
    // descendant flags untouched for callbacks and restore in O(branches).
    hidden.length = start;
    hidden.push(object);
    if (shadowless) shadowless.length = shadowStart;
  } else if (shadowless && !(bits & SHADOW) && object !== root) {
    // same rule: keep only the highest shadowless branch
    shadowless.length = shadowStart;
    shadowless.push(object);
  }
  return bits;
}

export function restoreNonRenderingBranches(hidden: readonly THREE.Object3D[]): void {
  for (const object of hidden) object.visible = true;
}
