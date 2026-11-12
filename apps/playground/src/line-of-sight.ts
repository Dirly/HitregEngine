import * as THREE from "three/webgpu";

/**
 * Line of sight through what the camera DRAWS (dev tools: light-shots / place-build render-batch, 2026-11-03 — batch
 * cameras stood inside tree canopy, trunks and rock faces). Rays are cast against every visible opaque mesh of the
 * scene: voxel terrain, scene meshes and colliders' visuals, and vegetation instances (InstancedMesh / BatchedMesh
 * per instance). Faces count from both sides, so a camera INSIDE a canopy or a rock is blocked by the faces around it.
 * Skipped: lines, points, sprites, non-depth-writing or see-through materials (water, fog, glow, particles), huge
 * shells (sky domes) and anything the caller ignores (the hidden player, the light references).
 */
export type V3 = [number, number, number];

export interface SightPose {
  /** Camera position. */
  camera: V3;
  /** Points the camera must see (the place centre and a small fan round it). */
  rays: V3[];
}

export interface SightHit {
  /** Distance from the camera to the first blocking face (m). */
  d: number;
  /** What blocked: the nearest named ancestor of the mesh. */
  what: string;
}

export interface SightOptions {
  /** Ignore hits this close to each ray's end (the place itself stands there). Default 25 % of the ray, 8..40 m. */
  stopShort?: (rayLength: number) => number;
  /** Objects (and their subtrees) never counted. */
  ignore?: (object: THREE.Object3D) => boolean;
  /** A pose is clear when at most this many of its rays (after the first, which must be clear) are blocked. Default 1. */
  allowBlocked?: number;
  /** A hit nearer than this to the camera blocks the pose outright (the camera is inside something). Default 2 m. */
  insideM?: number;
}

export interface SightVerdict {
  /** Index of the first clear pose in the given order, or -1. */
  clear: number;
  /** Per pose tested (in order, up to and including the clear one): rays blocked and the nearest blocker. */
  tried: { blocked: number; first: SightHit | null }[];
}

const SKY_RADIUS_M = 4000;

const defaultStopShort = (len: number): number => Math.min(40, Math.max(8, 0.25 * len));

function isOccluder(o: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh;
  if (!m.isMesh || !m.geometry) return false;
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  if (!mats.some((mat) => mat && mat.visible !== false && mat.depthWrite !== false && !(mat.transparent && mat.opacity < 0.6 && !mat.alphaTest))) return false;
  const g = m.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  if (g.boundingSphere && g.boundingSphere.radius > SKY_RADIUS_M) return false;
  return true;
}

function nameOf(o: THREE.Object3D): string {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.name) return p.name;
  return o.type;
}

/** The meshes that can block a view, collected once (visible all the way up, not ignored). */
export function occluders(scene: THREE.Object3D, ignore?: (o: THREE.Object3D) => boolean): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D): void => {
    if (!o.visible || (ignore && ignore(o))) return;
    if ((o as THREE.Line).isLine || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) return;
    if (isOccluder(o)) out.push(o);
    for (const c of o.children) walk(c);
  };
  walk(scene);
  return out;
}

/** The first face (either side) between `from` and `to` short of `far`, or null. */
export function firstHit(meshes: readonly THREE.Mesh[], from: V3, to: V3, far: number, ray = new THREE.Raycaster()): SightHit | null {
  const o = new THREE.Vector3(...from), dir = new THREE.Vector3(...to).sub(o);
  const len = dir.length();
  if (len < 1e-6 || far <= 0) return null;
  ray.set(o, dir.divideScalar(len));
  ray.near = 0;
  ray.far = Math.min(far, len);
  const hits: THREE.Intersection[] = [];
  for (const m of meshes) {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const sides = mats.map((mat) => mat.side);
    for (const mat of mats) mat.side = THREE.DoubleSide;
    try {
      m.raycast(ray, hits);
    } finally {
      mats.forEach((mat, i) => (mat.side = sides[i]!));
    }
  }
  if (!hits.length) return null;
  let best = hits[0]!;
  for (const h of hits) if (h.distance < best.distance) best = h;
  return { d: Math.round(best.distance * 10) / 10, what: nameOf(best.object) };
}

/** For each ray, the first face between `from` and a point `clearM` short of `to` (null = `to` is seen). The wash gate's
 *  far-fire rule asks this of every fire light: a flame behind a pit wall, a rim or a hill does not count as a fire the
 *  camera sees (tools/_light-wash.mts isFarFire). The fire's own logs and brazier sit within `clearM` of it. */
export function sightHits(scene: THREE.Object3D, rays: readonly { from: V3; to: V3 }[], clearM: number, opts: Pick<SightOptions, "ignore"> = {}): (SightHit | null)[] {
  const meshes = occluders(scene, opts.ignore), ray = new THREE.Raycaster();
  return rays.map(({ from, to }) => {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    return firstHit(meshes, from, to, len - clearM, ray);
  });
}

/** Test poses in order and return the first whose view is clear (see SightOptions). */
export function firstClearPose(scene: THREE.Object3D, poses: readonly SightPose[], opts: SightOptions = {}): SightVerdict {
  const meshes = occluders(scene, opts.ignore);
  const stopShort = opts.stopShort ?? defaultStopShort, allow = opts.allowBlocked ?? 1, inside = opts.insideM ?? 2;
  const ray = new THREE.Raycaster();
  const tried: SightVerdict["tried"] = [];
  for (let i = 0; i < poses.length; i++) {
    const p = poses[i]!;
    let blocked = 0, first: SightHit | null = null, fatal = false;
    for (let k = 0; k < p.rays.length; k++) {
      const to = p.rays[k]!, len = Math.hypot(to[0] - p.camera[0], to[1] - p.camera[1], to[2] - p.camera[2]);
      const hit = firstHit(meshes, p.camera, to, len - stopShort(len), ray);
      if (!hit) continue;
      blocked++;
      if (!first || hit.d < first.d) first = hit;
      if (k === 0 || hit.d < inside || blocked > allow) { fatal = true; break; }
    }
    tried.push({ blocked, first });
    if (!fatal) return { clear: i, tried };
  }
  return { clear: -1, tried };
}
