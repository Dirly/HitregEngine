import * as THREE from "three/webgpu";

type Attribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
interface InfluenceBounds {
  attributes: Attribute[];
  versions: number[];
  boxes: Map<number, THREE.Box3>;
  morphs: (Map<number, THREE.Box3> | null)[];
  relative: boolean;
  minWeight: number;
  maxWeight: number;
}
const cache = new WeakMap<THREE.BufferGeometry, InfluenceBounds>();
const installed = new WeakSet<THREE.SkinnedMesh>();
const version = (a: Attribute): number => "data" in a ? a.data.version : a.version;
let renderFrame = 0, nextRenderFrame = 0;

/** EngineRenderer calls this AFTER its matrix walk: every pass uses one pose. */
export function beginSkinnedBoundsFrame(): number {
  const previous = renderFrame;
  renderFrame = ++nextRenderFrame;
  return previous;
}

/** Restore a nested renderer's caller, or leave render scope (0). */
export function endSkinnedBoundsFrame(previous: number): void { renderFrame = previous; }

// Skinning matrices are affine: center/extents need one transform instead of
// eight corner transforms. Keep Three's general path for unusual matrices.
function transformBox(box: THREE.Box3, matrix: THREE.Matrix4): THREE.Box3 {
  const e = matrix.elements;
  if (e[3] !== 0 || e[7] !== 0 || e[11] !== 0 || e[15] !== 1) return box.applyMatrix4(matrix);
  const x = (box.min.x + box.max.x) * .5, y = (box.min.y + box.max.y) * .5, z = (box.min.z + box.max.z) * .5;
  const dx = (box.max.x - box.min.x) * .5, dy = (box.max.y - box.min.y) * .5, dz = (box.max.z - box.min.z) * .5;
  const cx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
  const cy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
  const cz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
  const hx = Math.abs(e[0]!) * dx + Math.abs(e[4]!) * dy + Math.abs(e[8]!) * dz;
  const hy = Math.abs(e[1]!) * dx + Math.abs(e[5]!) * dy + Math.abs(e[9]!) * dz;
  const hz = Math.abs(e[2]!) * dx + Math.abs(e[6]!) * dy + Math.abs(e[10]!) * dz;
  box.min.set(cx - hx, cy - hy, cz - hz); box.max.set(cx + hx, cy + hy, cz + hz);
  return box;
}

/** Bounds in source-vertex space, shared by every clone using this geometry. */
function influences(geometry: THREE.BufferGeometry): InfluenceBounds | null {
  const morphs = geometry.morphAttributes["position"] ?? [];
  const indexAttribute = geometry.getIndex();
  const attributes = [geometry.getAttribute("position"), geometry.getAttribute("skinIndex"), geometry.getAttribute("skinWeight"), ...morphs, ...(indexAttribute ? [indexAttribute] : [])];
  const [position, indices, weights] = attributes;
  if (!position || !indices || !weights || indices.itemSize !== 4 || weights.itemSize !== 4 ||
      position.count !== indices.count || position.count !== weights.count) return null;
  const previous = cache.get(geometry);
  if (previous && previous.relative === geometry.morphTargetsRelative && attributes.length === previous.attributes.length &&
      attributes.every((a, i) => a === previous.attributes[i] && version(a) === previous.versions[i])) return previous;
  const result: InfluenceBounds = { attributes, versions: attributes.map(version), boxes: new Map(),
    morphs: morphs.map(m => m.count === position.count && m.itemSize === 3 ? new Map() : null),
    relative: geometry.morphTargetsRelative, minWeight: Infinity, maxWeight: 0 };
  const point = new THREE.Vector3(), delta = new THREE.Vector3();
  // Ubermesh masks retain the shared vertex buffers and replace only the
  // index. Unreferenced parts can contain unweighted placeholder vertices.
  const seen = new Uint8Array(position.count);
  for (let entry = 0; entry < (indexAttribute?.count ?? position.count); entry++) {
    const v = indexAttribute?.getX(entry) ?? entry;
    if (!Number.isInteger(v) || v < 0 || v >= position.count) return null;
    if (seen[v]) continue;
    seen[v] = 1;
    point.fromBufferAttribute(position, v);
    if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
    let sum = 0;
    for (let lane = 0; lane < 4; lane++) {
      const weight = weights.getComponent(v, lane), index = indices.getComponent(v, lane);
      if (!Number.isFinite(weight) || weight < 0) return null;
      if (weight === 0) continue;
      if (!Number.isInteger(index) || index < 0) return null;
      let box = result.boxes.get(index);
      if (!box) { box = new THREE.Box3(); result.boxes.set(index, box); }
      box.expandByPoint(point);
      for (let m = 0; m < morphs.length; m++) {
        const map = result.morphs[m];
        if (!map) continue;
        delta.fromBufferAttribute(morphs[m]!, v);
        if (!result.relative) delta.sub(point);
        if (![delta.x, delta.y, delta.z].every(Number.isFinite)) { result.morphs[m] = null; continue; }
        let bounds = map.get(index);
        if (!bounds) { bounds = new THREE.Box3(); map.set(index, bounds); }
        bounds.expandByPoint(delta);
      }
      sum += weight;
    }
    if (!(sum > 0) || !Number.isFinite(sum)) return null;
    result.minWeight = Math.min(result.minWeight, sum);
    result.maxWeight = Math.max(result.maxWeight, sum);
  }
  if (result.boxes.size === 0) return null;
  cache.set(geometry, result);
  return result;
}

/**
 * Conservative pose bounds without skinning every vertex every frame.
 * Each influenced vertex lies in its bone's box. Non-negative skin weights
 * form a convex combination of those transformed boxes (scaled by the weight
 * sum), so their union also encloses blended joints and arbitrary bone poses.
 *
 * The sphere is evaluated when Three asks for it, AFTER the scene's matrix
 * walk. Doing this inside a mesh's updateMatrixWorld can read sibling bones
 * from the previous pose. Matrix comparisons reuse it across shadow passes.
 * Unsupported deformation keeps the old always-draw behavior.
 */
export function enableSkinnedBounds(mesh: THREE.SkinnedMesh): void {
  if (installed.has(mesh)) return;
  let sphere = new THREE.Sphere(), data: InfluenceBounds | null = null;
  let skeleton: THREE.Skeleton | null = null, valid = false;
  let lastRenderFrame = -1;
  const morphWeights: number[] = [];
  const bind = new THREE.Matrix4(), inverseBind = new THREE.Matrix4(), world = new THREE.Matrix4();
  const pose = new Map<number, { world: THREE.Matrix4; inverse: THREE.Matrix4 }>();
  const matrix = new THREE.Matrix4(), transformed = new THREE.Box3(), union = new THREE.Box3();
  const unbounded = (): THREE.Sphere => { valid = false; sphere.center.set(0, 0, 0); sphere.radius = Infinity; return sphere; };
  Object.defineProperty(mesh, "boundingSphere", {
    configurable: true,
    get: (): THREE.Sphere => {
      // The engine renders its main view and cascades at one simulation instant.
      // Do not re-compare every bone matrix on each pass. Outside that scope
      // (raycasts, editor tools, bare Three rendering), retain dependency checks.
      if (renderFrame !== 0 && lastRenderFrame === renderFrame && valid) return sphere;
      const currentMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (currentMaterials.some(m => (m as THREE.NodeMaterial).positionNode)) return unbounded();
      const next = influences(mesh.geometry);
      if (!next) return unbounded();
      if (next !== data || mesh.skeleton !== skeleton) { data = next; skeleton = mesh.skeleton; valid = false; pose.clear(); }
      let changed = !valid || !bind.equals(mesh.bindMatrix) || !inverseBind.equals(mesh.bindMatrixInverse) || !world.equals(mesh.matrixWorld);
      for (let m = 0; m < data.morphs.length; m++) {
        const weight = mesh.morphTargetInfluences?.[m] ?? 0;
        if (!Number.isFinite(weight)) return unbounded();
        // A disabled morph does not affect the shader. Some imported ubermeshes
        // retain targets from before parts were appended; only fail open when
        // such an incomplete target is actually used.
        if (weight !== 0 && !data.morphs[m]) return unbounded();
        if (morphWeights[m] !== weight) changed = true;
        morphWeights[m] = weight;
      }
      for (const index of data.boxes.keys()) {
        const bone = skeleton.bones[index], inverse = skeleton.boneInverses[index];
        if (!bone || !inverse) return unbounded();
        const last = pose.get(index);
        if (!last || !last.world.equals(bone.matrixWorld) || !last.inverse.equals(inverse)) changed = true;
      }
      if (!changed) { lastRenderFrame = renderFrame; return sphere; }
      union.makeEmpty();
      for (const [index, box] of data.boxes) {
        const bone = skeleton.bones[index]!, inverse = skeleton.boneInverses[index]!;
        matrix.multiplyMatrices(bone.matrixWorld, inverse).multiply(mesh.bindMatrix);
        transformed.copy(box);
        // Morphs run before skinning. Sum their delta intervals in source
        // space; negative weights and extrapolation above 1 are valid too.
        for (let m = 0; m < data.morphs.length; m++) {
          const weight = morphWeights[m]!;
          if (weight === 0) continue;
          const delta = data.morphs[m]!.get(index)!;
          for (const axis of ["x", "y", "z"] as const) {
            transformed.min[axis] += Math.min(delta.min[axis] * weight, delta.max[axis] * weight);
            transformed.max[axis] += Math.max(delta.min[axis] * weight, delta.max[axis] * weight);
          }
        }
        union.union(transformBox(transformed, matrix));
        let last = pose.get(index);
        if (!last) { last = { world: new THREE.Matrix4(), inverse: new THREE.Matrix4() }; pose.set(index, last); }
        last.world.copy(bone.matrixWorld); last.inverse.copy(inverse);
      }
      // Usually sums are 1 (up to Float32 roundoff), but support positive
      // unnormalised weights too. Scale before the final inverse-bind affine.
      for (const axis of ["x", "y", "z"] as const) {
        const lo = union.min[axis], hi = union.max[axis], a = data.minWeight, b = data.maxWeight;
        union.min[axis] = Math.min(lo * a, lo * b, hi * a, hi * b);
        union.max[axis] = Math.max(lo * a, lo * b, hi * a, hi * b);
      }
      const magnitude = Math.max(union.min.length(), union.max.length());
      if (!Number.isFinite(magnitude)) return unbounded();
      union.expandByScalar(1e-4 + magnitude * 2e-6).applyMatrix4(mesh.bindMatrixInverse);
      // GPU skinning retains the weight sum in homogeneous w, whereas
      // getVertexPosition applies inverse-bind with w=1. Cover both for
      // non-normalized inputs (normally only Float32 roundoff differs).
      const inverseElements = mesh.bindMatrixInverse.elements;
      const low = Math.min(0, data.minWeight - 1), high = Math.max(0, data.maxWeight - 1);
      for (const [axis, i] of [["x", 12], ["y", 13], ["z", 14]] as const) {
        const translation = inverseElements[i]!;
        union.min[axis] += Math.min(translation * low, translation * high);
        union.max[axis] += Math.max(translation * low, translation * high);
      }
      union.getBoundingSphere(sphere);
      // Three transforms spheres by the largest column length. That is exact
      // for ordinary TRS, but can underestimate shear from nested nonuniform
      // scales. A row-sum bound on A^T A safely covers that case as well.
      const e = mesh.matrixWorld.elements;
      const dot = (a: number, b: number): number => e[a]! * e[b]! + e[a + 1]! * e[b + 1]! + e[a + 2]! * e[b + 2]!;
      const xx = dot(0, 0), yy = dot(4, 4), zz = dot(8, 8);
      const xy = Math.abs(dot(0, 4)), xz = Math.abs(dot(0, 8)), yz = Math.abs(dot(4, 8));
      const scale2 = Math.max(xx, yy, zz);
      if (scale2 > 0) sphere.radius *= Math.sqrt(Math.max(xx + xy + xz, yy + xy + yz, zz + xz + yz) / scale2);
      bind.copy(mesh.bindMatrix); inverseBind.copy(mesh.bindMatrixInverse); world.copy(mesh.matrixWorld); valid = true; lastRenderFrame = renderFrame;
      return sphere;
    },
    set: (value: THREE.Sphere | null): void => { sphere = value ?? new THREE.Sphere(); valid = false; },
  });
  installed.add(mesh);
  mesh.frustumCulled = true;
}
