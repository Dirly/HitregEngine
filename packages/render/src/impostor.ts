import * as THREE from "three/webgpu";
import {
  abs,
  add,
  attribute,
  cameraPosition,
  cross,
  float,
  floor,
  max,
  min,
  mix,
  modelWorldMatrixInverse,
  normalize,
  positionLocal,
  select,
  step,
  sub,
  texture as tslTexture,
  transformNormalToView,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { instancedPositionLocal } from "./instancing.js";

/**
 * Octahedral impostors for the instanced-prop far tier — the second piece of
 * "Nanite for the web" worth having (nanite-webgpu's far-range answer, in
 * spirit): instead of a fixed cross of two cards showing one front-view
 * snapshot, every far instance is ONE camera-facing quad sampling an atlas of
 * the model baked from `grid × grid` directions over the upper hemisphere.
 * The fragment shader turns the instance-local direction to the camera into
 * an atlas cell, blends the three nearest frames, and shades the result with
 * the scene's real lights using a normal atlas baked alongside the albedo —
 * so a tree looks like THAT tree from the side, from a helicopter, and
 * everywhere between, and its lighting follows the sun instead of being
 * frozen at bake time.
 *
 * Split of responsibility: this file is the render-package half — the
 * direction ⇄ atlas mapping (shared by the baker and the shader, and
 * unit-tested in JS), the quad geometry, the material, and the per-instance
 * rotation/scale side-buffers `FoliageLodSystem` fills when it moves an
 * instance into the far tier. The bake itself needs the live renderer, so
 * the app owns it (`BuildOptions.bakeImpostor`, see
 * apps/playground/src/impostor-bake.ts) and hands back an `ImpostorAtlas`.
 *
 * Why the instance's rotation and scale ride in their own instanced
 * attributes: TSL exposes the instanced `positionLocal` (so the anchor comes
 * for free — the quad's four vertices all sit at the model's centre, and
 * instancing moves that point) but not the instance matrix itself, and the
 * frame lookup needs the camera direction in MODEL space, i.e. un-rotated by
 * the instance. The LOD system already rewrites the far tier's slot when it
 * swap-compacts; writing 5 more floats per move is the cheapest place to do
 * it (see `writeImpostorSlot`).
 */

/** Frames per atlas axis: 6 × 6 = 36 views, ~20° apart. */
export const DEFAULT_IMPOSTOR_GRID = 6;
/** Pixels per frame; with the default grid that's a 576² atlas per unique
 * model (albedo + normal ≈ 2.6 MB), sized for a tier that is by definition
 * far away. */
export const DEFAULT_IMPOSTOR_FRAME_SIZE = 96;

/** Threshold past which a to-camera direction counts as "straight down the
 * pole", where the usual world-up reference for the quad's right vector
 * degenerates. The baker uses the same rule for the pole frame's camera up. */
const POLE_COS = 0.99;

export interface ImpostorAtlas {
  /** Un-lit albedo + coverage alpha, `grid × grid` frames. Linear colour. */
  albedo: THREE.Texture;
  /** Model-space normals encoded `n * 0.5 + 0.5`, same frame layout. */
  normal: THREE.Texture;
  grid: number;
  /** Whether each frame's V axis runs top-down in texel order (true for
   * WebGPU render targets, false for WebGL ones) — the baker knows which
   * backend drew it; the sampler flips accordingly. */
  flipFrames: boolean;
}

/** Per-logical-instance rotation (unit quaternion, xyzw) and uniform scale,
 * index-aligned with `InstancedPropBatch.matrices`. */
export interface ImpostorInstanceData {
  rotations: Float32Array;
  scales: Float32Array;
}

// ---- direction ⇄ atlas mapping (JS half; the shader transcribes it) -------

/**
 * Hemi-octahedral encode: a unit direction in the upper hemisphere (y ≥ 0)
 * → a point in [0,1]². The pole maps to the centre, the horizon to the
 * square's border, and the mapping is area-preserving enough that a regular
 * grid of atlas frames covers the hemisphere evenly. Directions below the
 * horizon are clamped to it (the far tier is never looked at from
 * underground in any way worth spending atlas space on).
 */
export function hemiOctEncode(dir: THREE.Vector3, out = new THREE.Vector2()): THREE.Vector2 {
  const y = Math.max(dir.y, 0);
  const s = Math.abs(dir.x) + y + Math.abs(dir.z) || 1;
  const x = dir.x / s;
  const z = dir.z / s;
  return out.set((x + z) * 0.5 + 0.5, (x - z) * 0.5 + 0.5);
}

/** Inverse of `hemiOctEncode`: a point in [0,1]² → unit direction, y ≥ 0. */
export function hemiOctDecode(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const a = u * 2 - 1;
  const b = v * 2 - 1;
  const x = (a + b) * 0.5;
  const z = (a - b) * 0.5;
  const y = 1 - Math.abs(x) - Math.abs(z);
  return out.set(x, Math.max(y, 0), z).normalize();
}

/** The bake direction of atlas frame (i, j), 0 ≤ i, j < grid — frame (i, j)
 * lives at atlas cell column i, row j. */
export function impostorFrameDirection(i: number, j: number, grid: number, out = new THREE.Vector3()): THREE.Vector3 {
  return hemiOctDecode(i / (grid - 1), j / (grid - 1), out);
}

/** Every frame's direction, row-major: index = j * grid + i. */
export function impostorFrameDirections(grid = DEFAULT_IMPOSTOR_GRID): THREE.Vector3[] {
  const dirs: THREE.Vector3[] = [];
  for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) dirs.push(impostorFrameDirection(i, j, grid));
  return dirs;
}

/** The "up" reference a camera looking along `-dir` should use so its screen
 * axes match the runtime quad's (`right = up × dir`, `up' = dir × right`). At
 * the pole world-up is parallel to the view and a fixed substitute is used —
 * the SAME substitute the shader picks, so the pole frame isn't mirrored. */
export function impostorFrameUp(dir: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return Math.abs(dir.y) > POLE_COS ? out.set(0, 0, -1) : out.set(0, 1, 0);
}

export interface ImpostorFrameBlend {
  /** Three (column, row) atlas cells. */
  frames: [[number, number], [number, number], [number, number]];
  /** Barycentric weights, sum to 1. */
  weights: [number, number, number];
}

/**
 * Which three frames a model-space direction blends between, and how much
 * of each — the two-triangles-per-cell scheme the shader implements. Kept in
 * JS so the mapping the baker used and the one the sampler uses can be
 * checked against each other without a GPU.
 */
export function selectImpostorFrames(dirModel: THREE.Vector3, grid: number): ImpostorFrameBlend {
  const uv = hemiOctEncode(dirModel);
  const g = grid - 1;
  const cx = uv.x * g;
  const cy = uv.y * g;
  const bx = Math.min(Math.floor(cx), g - 1);
  const by = Math.min(Math.floor(cy), g - 1);
  const fx = cx - bx;
  const fy = cy - by;
  if (fx + fy <= 1) {
    return {
      frames: [
        [bx, by],
        [bx + 1, by],
        [bx, by + 1],
      ],
      weights: [1 - fx - fy, fx, fy],
    };
  }
  return {
    frames: [
      [bx + 1, by + 1],
      [bx + 1, by],
      [bx, by + 1],
    ],
    weights: [fx + fy - 1, 1 - fy, 1 - fx],
  };
}

// ---- per-batch data ---------------------------------------------------------

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/** Decompose each instance's world matrix into what the shader needs. */
export function impostorInstanceData(matrices: readonly THREE.Matrix4[]): ImpostorInstanceData {
  const rotations = new Float32Array(matrices.length * 4);
  const scales = new Float32Array(matrices.length);
  for (let i = 0; i < matrices.length; i++) {
    matrices[i]!.decompose(_pos, _quat, _scale);
    rotations[i * 4] = _quat.x;
    rotations[i * 4 + 1] = _quat.y;
    rotations[i * 4 + 2] = _quat.z;
    rotations[i * 4 + 3] = _quat.w;
    scales[i] = Math.max(Math.abs(_scale.x), Math.abs(_scale.y), Math.abs(_scale.z)) || 1;
  }
  return { rotations, scales };
}

/**
 * The far-tier quad for one batch. All four vertices sit at the model's
 * bounds centre — the shader spreads them out to face the camera, so
 * geometry positions only matter as the instancing anchor. Bounds are set
 * explicitly (a degenerate point would let `InstancedMesh` frustum-cull a
 * quad whose centre is just off-screen), and the two instanced attributes
 * `FoliageLodSystem` writes per far slot are allocated here, sized to the
 * batch. Cheap enough to be per batch; the material is what's cached.
 */
export function impostorGeometry(bounds: THREE.Box3, count: number): THREE.BufferGeometry {
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(12);
  for (let k = 0; k < 4; k++) positions.set([center.x, center.y, center.z], k * 3);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const rotation = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(count, 1) * 4), 4);
  const scale = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(count, 1)), 1);
  rotation.setUsage(THREE.DynamicDrawUsage);
  scale.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("impostorRotation", rotation);
  geometry.setAttribute("impostorScale", scale);
  geometry.boundingSphere = new THREE.Sphere(center, radius);
  geometry.boundingBox = new THREE.Box3(
    center.clone().subScalar(radius),
    center.clone().addScalar(radius),
  );
  return geometry;
}

/** Copy logical instance `i`'s rotation/scale into far-tier buffer slot
 * `slot` — called by the LOD system wherever it writes a far-tier matrix. A
 * batch without impostor data (primitive fallback proxy) is a no-op. */
export function writeImpostorSlot(
  far: { geometry: THREE.BufferGeometry },
  data: ImpostorInstanceData | undefined,
  slot: number,
  i: number,
): void {
  if (!data) return;
  const rotation = far.geometry.getAttribute("impostorRotation") as THREE.InstancedBufferAttribute | undefined;
  const scale = far.geometry.getAttribute("impostorScale") as THREE.InstancedBufferAttribute | undefined;
  if (!rotation || !scale) return;
  (rotation.array as Float32Array).set(data.rotations.subarray(i * 4, i * 4 + 4), slot * 4);
  (scale.array as Float32Array)[slot] = data.scales[i]!;
  rotation.needsUpdate = true;
  scale.needsUpdate = true;
}

// ---- material ---------------------------------------------------------------

/** Rotate `v` by the unit quaternion `q` (xyzw): v + 2·(q.w·t + q.xyz × t), t = q.xyz × v. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rotateByQuat(v: any, qxyz: any, qw: any): any {
  const t = cross(qxyz, v).mul(2);
  return v.add(t.mul(qw)).add(cross(qxyz, t));
}

/**
 * One material per unique (model, atlas): a camera-facing quad in the vertex
 * stage, hemi-octahedral 3-frame blend in the fragment stage, Lambert-lit
 * through the baked normal. Alpha-tested and depth-writing (not blended):
 * a far forest is hundreds of overlapping quads in one instanced draw with no
 * per-instance sort, and cut-outs compose correctly where blending would
 * show the draw order.
 */
export function impostorMaterial(atlas: ImpostorAtlas, bounds: THREE.Box3): THREE.MeshLambertNodeMaterial {
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  const grid = atlas.grid;

  // (wrapped in conversion nodes: @types/three's `attribute()` return type
  // has no swizzles, and the node itself is the same either way)
  const rotation = vec4(attribute<"vec4">("impostorRotation", "vec4"));
  const instanceScale = float(attribute<"float">("impostorScale", "float"));
  const qxyz = rotation.xyz;
  const qw = rotation.w;
  const qxyzInv = qxyz.negate();

  // -- vertex: spread the four centre-anchored vertices into a quad facing the camera
  // this instance's model centre, placed: the batch is an InstancedProps, whose
  // instance transform lives in geometry attributes rather than in three's
  // InstancedMesh path — see instancing.ts
  const anchor = instancedPositionLocal();
  const cameraLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const toCamera = normalize(sub(cameraLocal, anchor));
  // world-up reference for the quad's right vector, with the same pole
  // substitute the baker used (see impostorFrameUp) so frames aren't mirrored
  const upRef = select(abs(toCamera.y).greaterThan(POLE_COS), vec3(0, 0, -1), vec3(0, 1, 0));
  const right = normalize(cross(upRef, toCamera));
  const up = cross(toCamera, right);
  const corner = sub(uv(), vec2(0.5, 0.5)).mul(2); // [-1, 1]²
  const half = float(radius).mul(instanceScale);
  const quadPosition = anchor.add(right.mul(corner.x.mul(half))).add(up.mul(corner.y.mul(half)));

  // -- fragment: which frames, how much of each
  // direction to the camera in MODEL space: undo the instance rotation
  const dirModel = rotateByQuat(toCamera, qxyzInv, qw);
  const dirHemi = vec3(dirModel.x, max(dirModel.y, 0), dirModel.z); // clamp below-horizon views to the horizon
  const l1 = add(add(abs(dirHemi.x), dirHemi.y), abs(dirHemi.z));
  const n = dirHemi.div(l1);
  const octUv = vec2(n.x.add(n.z), n.x.sub(n.z)).mul(0.5).add(0.5);
  const g = float(grid - 1);
  const cell = octUv.mul(g);
  const base = min(floor(cell), g.sub(1));
  const f = cell.sub(base);
  const lower = step(f.x.add(f.y), 1); // 1 → lower-left triangle of the cell, 0 → upper-right
  const frame0 = mix(base.add(1), base, lower);
  const frame1 = base.add(vec2(1, 0));
  const frame2 = base.add(vec2(0, 1));
  const w0 = mix(f.x.add(f.y).sub(1), float(1).sub(f.x).sub(f.y), lower);
  const w1 = mix(float(1).sub(f.y), f.x, lower);
  const w2 = mix(float(1).sub(f.x), f.y, lower);

  // in-frame uv: the quad's own uv, V flipped when the atlas was drawn top-down
  const inner = atlas.flipFrames ? vec2(uv().x, sub(float(1), uv().y)) : uv();
  const invGrid = float(1 / grid);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const frameUv = (frame: any) => frame.add(inner).mul(invGrid);
  const uv0 = frameUv(frame0);
  const uv1 = frameUv(frame1);
  const uv2 = frameUv(frame2);

  const a0 = tslTexture(atlas.albedo, uv0);
  const a1 = tslTexture(atlas.albedo, uv1);
  const a2 = tslTexture(atlas.albedo, uv2);
  const albedo = a0.mul(w0).add(a1.mul(w1)).add(a2.mul(w2));

  const n0 = tslTexture(atlas.normal, uv0).xyz;
  const n1 = tslTexture(atlas.normal, uv1).xyz;
  const n2 = tslTexture(atlas.normal, uv2).xyz;
  const normalModel = n0.mul(w0).add(n1.mul(w1)).add(n2.mul(w2)).mul(2).sub(1);
  // baked normals are model-space: re-apply the instance rotation, then let
  // three take the mesh-local result into view space like any other normal
  const normalLocal = normalize(rotateByQuat(normalModel, qxyz, qw));

  const material = new THREE.MeshLambertNodeMaterial({
    side: THREE.DoubleSide,
    transparent: false,
    depthWrite: true,
    alphaTest: 0.4,
  });
  material.positionNode = quadPosition;
  material.colorNode = albedo.rgb;
  material.opacityNode = albedo.a;
  material.normalNode = transformNormalToView(normalLocal);
  return material;
}
