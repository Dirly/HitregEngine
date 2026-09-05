import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  context,
  mat4,
  materialAO,
  materialColor,
  materialEmissive,
  materialMetalness,
  materialNormal,
  materialOpacity,
  materialRoughness,
  normalLocal,
  positionLocal,
  rotateUV,
  transformNormal,
  uv,
  vec2,
  vec4,
} from "three/tsl";

/**
 * Instanced prop batches whose SHADER does not depend on the batch.
 *
 * ## Why not `THREE.InstancedMesh`
 *
 * Three's WebGPU renderer builds shader code per "node builder state", and for
 * an `InstancedMesh` it keys that state by the OBJECT's uuid
 * (`RenderObject.getMaterialCacheKey`: `if (object.isInstancedMesh) cacheKey
 * += object.uuid`). The instance matrices are fed to the shader through nodes
 * bound to that one object's buffers, so the state cannot be shared. Every
 * `InstancedMesh` therefore runs the node builder once on first draw —
 * ~60ms of main-thread JS for a lit, shadowed `MeshStandardNodeMaterial`,
 * plus a second, cheaper build for the shadow pass — regardless of whether
 * an identical mesh was compiled a second ago.
 *
 * A streamed world creates one InstancedMesh per (cell, prop, submesh, LOD
 * tier). Measured on the voxel demo with NOTHING streaming: one rotation in
 * place cost 57 node-builder runs, 2.6s of a 3.7s lap, 49 of them instanced
 * meshes over 7 materials. Promoting a cell from HLOD proxy to real content
 * costs 3-8 of those builds, which is the stall that coincides with terrain
 * "popping in". On top of that the uniform-buffer instancing path bakes the
 * instance CAPACITY into the WGSL (`array<mat4x4<f32>, 764>`), so the compiled
 * programs multiplied by capacity too (102 vertex programs for 9 materials).
 *
 * ## What this does instead
 *
 * The instance matrices are ordinary instanced GEOMETRY attributes — four
 * `vec4` columns over one interleaved buffer — and the material reads them
 * with `attribute()` nodes. Three resolves geometry attributes per render
 * object at bind time, not at shader-build time, so the node builder state
 * is keyed by material + attribute LAYOUT and shared by every batch of the
 * same prop: one shader build per material per pass, ever. The object is a
 * plain `Mesh` (no `isInstancedMesh`, no `count` property — both re-add the
 * uuid to the cache key) whose `InstancedBufferGeometry.instanceCount` is
 * the draw count.
 *
 * The API mirrors the parts of InstancedMesh the LOD system uses
 * (`setMatrixAt`/`getMatrixAt`, `instanceMatrix.needsUpdate`, a per-object
 * bounding sphere, per-instance raycasting), with `count` renamed
 * `instanceCount`.
 *
 * INVARIANTS
 * - Never give this object a `count` property and never set `isInstancedMesh`
 *   on it: three checks both and either one puts the object uuid back into
 *   the shader cache key.
 * - Every material drawn by an `InstancedProps` must have gone through
 *   {@link applyInstancedProps} (or read {@link instanceMatrixNode} itself,
 *   as the impostor material does). A plain material draws every instance at
 *   the origin — visibly wrong, never an error.
 * - Materials are shared across batches of the same asset (that is the whole
 *   point), so nothing here may mutate a material per batch.
 */

/** Names of the four column attributes, in order. */
export const INSTANCE_MATRIX_ATTRIBUTES = [
  "instanceMatrix0",
  "instanceMatrix1",
  "instanceMatrix2",
  "instanceMatrix3",
] as const;

const FLOATS_PER_INSTANCE = 16;
const INSTANCED_FLAG = "isInstancedPropMaterial";

/**
 * TSL: the current instance's model matrix, read from the geometry.
 *
 * `Matrix4.elements` is column-major, so each 4-float slice IS a column and
 * `mat4(c0, c1, c2, c3)` reassembles it exactly as three's own instancing
 * node does from its interleaved buffer.
 */
export function instanceMatrixNode(): ReturnType<typeof mat4> {
  const [a, b, c, d] = INSTANCE_MATRIX_ATTRIBUTES;
  return mat4(
    vec4(attribute<"vec4">(a, "vec4")),
    vec4(attribute<"vec4">(b, "vec4")),
    vec4(attribute<"vec4">(c, "vec4")),
    vec4(attribute<"vec4">(d, "vec4")),
  );
}

/**
 * The instance transform applied to `positionLocal`: what a vertex node that
 * wants "this instance's placed position" (the impostor quad anchor) reads.
 */
export function instancedPositionLocal(): ReturnType<typeof vec4>["xyz"] {
  return instanceMatrixNode().mul(vec4(positionLocal, 1)).xyz;
}

/**
 * Make a node material draw {@link InstancedProps} batches. Idempotent.
 *
 * Runs the instance transform FIRST and then any position node the material
 * already had (foliage wind, water waves), so those nodes see the placed
 * position exactly as they did under `InstancedMesh`, whose instancing also
 * ran before `positionNode`. `normalLocal` gets the matching normal
 * transform when the geometry has normals, again mirroring three.
 */
export function applyInstancedProps(material: THREE.Material): void {
  const node = material as THREE.NodeMaterial;
  if (node.isNodeMaterial !== true) {
    console.warn(`[render] applyInstancedProps: ${material.type} is not a NodeMaterial; instances will all draw at the origin`);
    return;
  }
  if (node.userData[INSTANCED_FLAG] === true) return;
  const inner = node.positionNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node.positionNode = (Fn as any)((_: unknown, builder: { hasGeometryAttribute(name: string): boolean }) => {
    const m = instanceMatrixNode();
    positionLocal.assign(m.mul(vec4(positionLocal, 1)).xyz);
    if (builder.hasGeometryAttribute("normal")) normalLocal.assign(transformNormal(normalLocal, m));
    return inner ?? positionLocal;
  })();
  node.userData[INSTANCED_FLAG] = true;
  node.needsUpdate = true;
}

/** True when {@link applyInstancedProps} has been applied to the material. */
export function isInstancedPropMaterial(material: THREE.Material): boolean {
  return material.userData[INSTANCED_FLAG] === true;
}

/**
 * Per-instance texture rotation, in RADIANS, as an optional instanced float
 * attribute (see {@link InstancedProps.enableUvRotation}).
 *
 * Why it exists: a WFC kit floor module placed at a 90° grid variant would
 * turn its planks with it. The tool writes the counter-rotation on the
 * entity (`mesh.source.uvRotation`, degrees) and it lands here, so every
 * floor of a generated building runs along the building's own axis while
 * every floor of every building still shares ONE material and ONE shader.
 */
export const INSTANCE_UV_ROTATION_ATTRIBUTE = "instanceUvRotation";

const UV_ROTATION_FLAG = "isInstanceUvRotationMaterial";

/**
 * Make an {@link applyInstancedProps} material read
 * {@link INSTANCE_UV_ROTATION_ATTRIBUTE} and rotate every texture map's UVs
 * by it, counter-clockwise (u right, v up — exactly three's `rotateUV`).
 * Idempotent.
 *
 * The rotation CENTRE is the geometry's `uv1` attribute (glTF TEXCOORD_1)
 * when it has one, else (0.5, 0.5). Kit modules are atlased, so a floor's
 * UVs occupy a sub-rectangle of a 2048 page and turning them about the page
 * centre would swing them into other islands; the kit import therefore
 * writes, into every vertex's uv1, the UV of the part's own local origin
 * (constant per part), and the rotation pivots there. Decided at shader
 * build time per attribute layout, so one material serves both kinds of
 * geometry.
 *
 * Nothing about the material's own shading is rebuilt: each map slot keeps
 * its stock `material*` node (colour × map with the map's alpha for
 * alphaTest cutouts, emissive × emissiveMap, ...) wrapped in a node
 * `context` whose `getUV` hook `TextureNode.setup` consults for any texture
 * node that has no explicit UV. A slot the material already customised is
 * wrapped as-is rather than replaced. The attribute is read in the fragment
 * stage, which TSL auto-varies from the vertex attribute.
 *
 * Every batch drawn with this material MUST have enabled the attribute (a
 * missing vertex attribute is a pipeline error, not a fallback) — which is
 * why scene-builder keys such materials separately from plain instanced
 * clones of the same asset.
 */
export function applyInstanceUvRotation(material: THREE.Material): void {
  const node = material as THREE.NodeMaterial & Record<string, unknown>;
  if (node.isNodeMaterial !== true) {
    console.warn(`[render] applyInstanceUvRotation: ${material.type} is not a NodeMaterial; texture rotation ignored`);
    return;
  }
  if (node.userData[UV_ROTATION_FLAG] === true) return;
  const angle = attribute(INSTANCE_UV_ROTATION_ATTRIBUTE, "float");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rotated = (Fn as any)((_: unknown, builder: { hasGeometryAttribute(name: string): boolean }) => {
    const center = builder.hasGeometryAttribute("uv1") ? uv(1) : vec2(0.5, 0.5);
    return rotateUV(uv(), angle, center);
  })();
  const hook = { getUV: () => rotated };
  const slots: Array<[map: string, slot: string, stock: unknown]> = [
    ["map", "colorNode", materialColor],
    ["emissiveMap", "emissiveNode", materialEmissive],
    ["normalMap", "normalNode", materialNormal],
    ["roughnessMap", "roughnessNode", materialRoughness],
    ["metalnessMap", "metalnessNode", materialMetalness],
    ["alphaMap", "opacityNode", materialOpacity],
    ["aoMap", "aoNode", materialAO],
  ];
  for (const [map, slot, stock] of slots) {
    const texture = node[map] as THREE.Texture | null | undefined;
    if (!texture || texture.isTexture !== true) continue;
    const existing = node[slot] as THREE.Node | null | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node[slot] = (context as any)(existing ?? stock, hook);
  }
  node.userData[UV_ROTATION_FLAG] = true;
  node.needsUpdate = true;
}

/** True when {@link applyInstanceUvRotation} has been applied to the material. */
export function isInstanceUvRotationMaterial(material: THREE.Material): boolean {
  return material.userData[UV_ROTATION_FLAG] === true;
}

/**
 * A per-batch `InstancedBufferGeometry` over a shared base geometry.
 *
 * Attribute OBJECTS are new (so disposing this batch frees only its own GPU
 * buffers, never a buffer another batch still binds) but the typed arrays
 * are shared — no CPU copy per cell, unlike the `geometry.clone()` the near
 * tier used to pay. Interleaved sources are de-interleaved into their own
 * array by three's clone; instanced attributes already on the base (the
 * impostor's per-instance rotation/scale) are per batch by construction and
 * are kept as-is.
 */
function instancedGeometryFrom(base: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  if (base.index) geometry.setIndex(new THREE.BufferAttribute(base.index.array, 1));
  for (const [name, attr] of Object.entries(base.attributes)) {
    if ((attr as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) {
      geometry.setAttribute(name, attr);
    } else if ((attr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) {
      geometry.setAttribute(name, (attr as THREE.InterleavedBufferAttribute).clone() as unknown as THREE.BufferAttribute);
    } else {
      const source = attr as THREE.BufferAttribute;
      const copy = new THREE.BufferAttribute(source.array, source.itemSize, source.normalized);
      copy.gpuType = source.gpuType;
      geometry.setAttribute(name, copy);
    }
  }
  for (const group of base.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.boundingSphere = base.boundingSphere ? base.boundingSphere.clone() : null;
  geometry.boundingBox = base.boundingBox ? base.boundingBox.clone() : null;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  return geometry;
}

const _matrix = new THREE.Matrix4();
const _worldMatrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _mesh = new THREE.Mesh();
const _hits: THREE.Intersection[] = [];

/** See the module comment. */
export class InstancedProps extends THREE.Mesh {
  readonly isInstancedProps = true;
  declare geometry: THREE.InstancedBufferGeometry;
  /**
   * Column-major 4x4 per instance. `setMatrixAt` marks the touched range;
   * set `needsUpdate = true` afterwards to upload, exactly as with
   * `InstancedMesh.instanceMatrix`.
   */
  readonly instanceMatrix: THREE.InstancedInterleavedBuffer;
  /** Slots allocated; `instanceCount` may only ever be at most this. */
  readonly capacity: number;
  /** Culling volume over the placed instances; null until computed. */
  boundingSphere: THREE.Sphere | null = null;
  /** Per-instance UV rotation (radians); null until {@link enableUvRotation}. */
  private uvRotation: THREE.InstancedBufferAttribute | null = null;

  constructor(base: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], count: number) {
    const capacity = Math.max(count, 1);
    const geometry = instancedGeometryFrom(base);
    const buffer = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * FLOATS_PER_INSTANCE), FLOATS_PER_INSTANCE, 1);
    INSTANCE_MATRIX_ATTRIBUTES.forEach((name, column) => {
      geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(buffer, 4, column * 4));
    });
    geometry.instanceCount = count;
    super(geometry, material);
    this.instanceMatrix = buffer;
    this.capacity = capacity;
  }

  /** Instances drawn: the first `instanceCount` slots of the buffer. */
  get instanceCount(): number {
    return this.geometry.instanceCount;
  }
  set instanceCount(value: number) {
    this.geometry.instanceCount = Math.max(0, Math.min(this.capacity, value));
  }

  setMatrixAt(index: number, matrix: THREE.Matrix4): void {
    const start = index * FLOATS_PER_INSTANCE;
    matrix.toArray(this.instanceMatrix.array as Float32Array, start);
    // Coalesce with a directly preceding range so a sequential fill (every
    // batch build) uploads as one write instead of one per instance.
    const ranges = this.instanceMatrix.updateRanges;
    const last = ranges[ranges.length - 1];
    if (last && last.start + last.count === start) last.count += FLOATS_PER_INSTANCE;
    else this.instanceMatrix.addUpdateRange(start, FLOATS_PER_INSTANCE);
  }

  getMatrixAt(index: number, matrix: THREE.Matrix4): THREE.Matrix4 {
    return matrix.fromArray(this.instanceMatrix.array as Float32Array, index * FLOATS_PER_INSTANCE);
  }

  /**
   * Allocate the {@link INSTANCE_UV_ROTATION_ATTRIBUTE} side buffer (one
   * float per slot, radians, zero-filled). Only batches drawn with an
   * {@link applyInstanceUvRotation} material need it, and every such batch
   * must call this — the shader binds the attribute unconditionally.
   */
  enableUvRotation(): void {
    if (this.uvRotation) return;
    this.uvRotation = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.geometry.setAttribute(INSTANCE_UV_ROTATION_ATTRIBUTE, this.uvRotation);
  }

  /** True once {@link enableUvRotation} has run. */
  get hasUvRotation(): boolean {
    return this.uvRotation !== null;
  }

  /** Per-slot texture rotation in radians; marks the attribute for upload. */
  setUvRotationAt(index: number, radians: number): void {
    if (!this.uvRotation) {
      console.warn("[render] InstancedProps.setUvRotationAt before enableUvRotation(); ignored");
      return;
    }
    (this.uvRotation.array as Float32Array)[index] = radians;
    this.uvRotation.needsUpdate = true;
  }

  getUvRotationAt(index: number): number {
    return this.uvRotation ? (this.uvRotation.array as Float32Array)[index]! : 0;
  }

  /**
   * Bounds over the first `instanceCount` instances — call once the batch
   * is fully placed, before the LOD system starts compacting tiers (a
   * compacted tier only ever holds a subset of that placement, so the
   * volume stays valid; see scene-builder).
   */
  computeBoundingSphere(): void {
    const geometry = this.geometry;
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    const base = geometry.boundingSphere!;
    const sphere = (this.boundingSphere ??= new THREE.Sphere());
    sphere.makeEmpty();
    for (let i = 0; i < this.instanceCount; i++) {
      this.getMatrixAt(i, _matrix);
      _sphere.copy(base).applyMatrix4(_matrix);
      sphere.union(_sphere);
    }
  }

  /** Per-instance hits, `instanceId` set, as `InstancedMesh.raycast` reports them. */
  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    if (this.boundingSphere === null) this.computeBoundingSphere();
    _sphere.copy(this.boundingSphere!).applyMatrix4(this.matrixWorld);
    if (!raycaster.ray.intersectsSphere(_sphere)) return;
    _mesh.geometry = this.geometry;
    _mesh.material = this.material;
    for (let i = 0; i < this.instanceCount; i++) {
      this.getMatrixAt(i, _matrix);
      _worldMatrix.multiplyMatrices(this.matrixWorld, _matrix);
      _mesh.matrixWorld = _worldMatrix;
      _mesh.raycast(raycaster, _hits);
      for (const hit of _hits) {
        hit.instanceId = i;
        hit.object = this;
        intersects.push(hit);
      }
      _hits.length = 0;
    }
  }

  /** Frees this batch's GPU buffers (instance matrices and its attribute copies). */
  dispose(): void {
    this.geometry.dispose();
  }
}

/** Type guard for the dispose/merge/decal paths that must treat batches specially. */
export function isInstancedProps(object: THREE.Object3D): object is InstancedProps {
  return (object as InstancedProps).isInstancedProps === true;
}
