import * as THREE from "three/webgpu";
import { abs, float, max, positionWorld, smoothstep, uniform, vec3 } from "three/tsl";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Interior lights stay inside their building.
 *
 * A room's point lights have no shadow maps (a cube map per candle is not
 * affordable), so before this a hearth lit the street through the wall it
 * stood against: the cobbles along the house, the neighbour's facing wall and
 * the next house's rooms all took its light (Bell Strand 2026-11-08, the
 * WFC-kit row houses — whose walls are open double-sided sheets, so nothing
 * but the wall's own facing ever stopped it). A wall's OWN outer face was
 * already dark (its normal faces away from a light behind it); everything
 * beyond the wall was not.
 *
 * So a light under a `culling.interior` room is CONFINED to the box of the
 * structure that encloses the room (the room root's parent in the scene doc:
 * core `interiorEnclosures`). The box is the structure's own geometry bounds
 * in its own frame (yaw-aligned, so a house turned 45° gets a tight box, not
 * its world AABB), and every way the light reaches the screen respects it:
 *
 * - its forward slot light multiplies its colour by the box mask at the
 *   shaded fragment (`confinedSlotColor`, the slot's `colorNode`);
 * - its screen-space pool (light-pools.ts) masks the rebuilt surface the same way;
 * - its halo is not pushed toward a camera outside the box (it would poke
 *   through the wall it hangs on), and its glow in the fog fades out once the
 *   camera stands outside the box.
 *
 * The mask is a few ALU per light per fragment (no matrix: yaw only), and the
 * box is a uniform, so the renderer's light set and cache keys never change.
 */
export interface LightConfine {
  /** Box centre, world. */
  center: THREE.Vector3;
  /** Half extents in the box's own (yawed) frame. */
  half: THREE.Vector3;
  /** cos / sin of the box's yaw about +Y. */
  cos: number;
  sin: number;
}

/** Diagnostic switch (A/B in one session): false = no light is confined. */
export const lightConfine = { enabled: true };
/** Metres outside the box over which a confined light fades to nothing (anti-aliases the cut at a wall's outer face). */
export const CONFINE_SOFT_EDGE = 0.12;
/** Half extent meaning "not confined": every fragment is inside. */
export const UNCONFINED_HALF = 1e6;

/** World point in the confine's frame, as its excess past the box (<= 0 inside, metres). */
export function confineOutside(confine: LightConfine, p: THREE.Vector3): number {
  const dx = p.x - confine.center.x;
  const dz = p.z - confine.center.z;
  const lx = confine.cos * dx - confine.sin * dz;
  const lz = confine.sin * dx + confine.cos * dz;
  const ly = p.y - confine.center.y;
  return Math.max(Math.abs(lx) - confine.half.x, Math.abs(ly) - confine.half.y, Math.abs(lz) - confine.half.z);
}

/** Shader twin of {@link confineOutside} with the soft edge: 1 inside, 0 past CONFINE_SOFT_EDGE. `a` = centre + cos, `b` = half + sin. */
export function confineMask(world: N, a: N, b: N): N {
  const d: N = world.sub(a.xyz);
  const lx: N = a.w.mul(d.x).sub(b.w.mul(d.z));
  const lz: N = b.w.mul(d.x).add(a.w.mul(d.z));
  const excess: N = max(max(abs(lx).sub(b.x), abs(d.y).sub(b.y)), abs(lz).sub(b.z));
  return float(1).sub(smoothstep(0, CONFINE_SOFT_EDGE, excess));
}

/** Pack a confine (or none) into the two vec4s the shaders read. */
export function packConfine(confine: LightConfine | null, a: THREE.Vector4, b: THREE.Vector4): void {
  if (!confine) {
    a.set(0, 0, 0, 1);
    b.set(UNCONFINED_HALF, UNCONFINED_HALF, UNCONFINED_HALF, 0);
    return;
  }
  a.set(confine.center.x, confine.center.y, confine.center.z, confine.cos);
  b.set(confine.half.x, confine.half.y, confine.half.z, confine.sin);
}

/** A slot light's colour × intensity, masked by its current source's confine. Written per frame; never re-created. */
export interface ConfinedSlotColor {
  color: { value: THREE.Color };
  a: { value: THREE.Vector4 };
  b: { value: THREE.Vector4 };
  node: N;
}

export function confinedSlotColor(): ConfinedSlotColor {
  const color = uniform(new THREE.Color(0, 0, 0));
  const a = uniform(new THREE.Vector4(0, 0, 0, 1));
  const b = uniform(new THREE.Vector4(UNCONFINED_HALF, UNCONFINED_HALF, UNCONFINED_HALF, 0));
  const node = vec3(color as N).mul(confineMask(positionWorld, a, b));
  return { color: color as never, a: a as never, b: b as never, node };
}

const boxCache = new WeakMap<THREE.Object3D, { confine: LightConfine | null; at: number; first: number }>();
/** A structure is measured again this often while its models may still be landing… */
const RETRY_MS = 1000;
/** …for this long after it first had geometry; after that its box is final. */
const SETTLE_MS = 20000;
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _box = new THREE.Box3();

/**
 * The structure's geometry bounds in its own yawed frame, cached per object. A structure whose world rotation is not
 * a pure yaw is measured axis-aligned instead (still a box that contains it). Null while it has no geometry.
 */
export function structureConfine(structure: THREE.Object3D, now = performance.now()): LightConfine | null {
  if (!lightConfine.enabled) return null;
  const cached = boxCache.get(structure);
  if (cached && (now - cached.at < RETRY_MS || (cached.confine && now - cached.first > SETTLE_MS))) return cached.confine;
  structure.updateWorldMatrix(true, true);
  structure.matrixWorld.decompose(_v, _q, new THREE.Vector3());
  _e.setFromQuaternion(_q, "YXZ");
  const yawOnly = Math.abs(_e.x) < 1e-3 && Math.abs(_e.z) < 1e-3;
  const yaw = yawOnly ? _e.y : 0;
  // the frame: the structure's position, turned by its yaw only (scale is measured, not assumed)
  _inv.makeRotationY(yaw).setPosition(_v).invert();
  _box.makeEmpty();
  let meshes = 0;
  structure.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    // the room's own glow cards and light helpers are not the building
    if ((mesh.material as THREE.Material | undefined)?.blending === THREE.AdditiveBlending) return;
    const geometry = mesh.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    if (!bb || bb.isEmpty()) return;
    meshes++;
    _m.multiplyMatrices(_inv, mesh.matrixWorld);
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(_m);
      _box.expandByPoint(_v);
    }
  });
  let confine: LightConfine | null = null;
  if (meshes > 0 && !_box.isEmpty()) {
    const localCentre = _box.getCenter(new THREE.Vector3());
    const half = _box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const center = localCentre.applyMatrix4(_m.copy(_inv).invert());
    // world -> local is the inverse yaw: local.x = cos·dx − sin·dz, local.z = sin·dx + cos·dz (three's makeRotationY)
    confine = { center, half, cos: Math.cos(yaw), sin: Math.sin(yaw) };
  }
  boxCache.set(structure, { confine, at: now, first: cached?.confine ? cached.first : now });
  return confine;
}

/** A room's floor is its lowest furnishing; the confine's bottom sits this far under it. */
export const FLOOR_MARGIN = 0.2;
const floorCache = new WeakMap<THREE.Object3D, { floor: number | null; at: number; first: number }>();
const roomCache = new WeakMap<THREE.Object3D, { base: LightConfine; floor: number; confine: LightConfine }>();

/** World height of the lowest geometry under a room (its floor: furniture stands on it), or null while it has none. */
export function roomFloor(room: THREE.Object3D, now = performance.now()): number | null {
  const cached = floorCache.get(room);
  if (cached && (now - cached.at < RETRY_MS || (cached.floor !== null && now - cached.first > SETTLE_MS))) return cached.floor;
  room.updateWorldMatrix(true, true);
  let floor = Infinity;
  room.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if ((mesh.material as THREE.Material | undefined)?.blending === THREE.AdditiveBlending) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb || bb.isEmpty()) return;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(mesh.matrixWorld);
      if (_v.y < floor) floor = _v.y;
    }
  });
  const value = Number.isFinite(floor) ? floor : null;
  floorCache.set(room, { floor: value, at: now, first: cached?.floor != null ? cached.first : now });
  return value;
}

/**
 * The box a room's light is held to: its structure's box, floored at the room's floor. The floor is what keeps the
 * street dark: a house's box reaches past its walls (pilasters, jetties, eaves, the plinth) and the cobbles along its
 * foot sat inside it, lit through the wall; town floors stand above the street (raised foundations), so a bottom at
 * the room's floor leaves them out. An upper room's lamp no longer lights the room below through the floorboards.
 */
export function roomConfine(structure: THREE.Object3D, room: THREE.Object3D | null | undefined, now = performance.now()): LightConfine | null {
  const base = structureConfine(structure, now);
  if (!base || !room) return base;
  const floor = roomFloor(room, now);
  if (floor === null) return base;
  const cached = roomCache.get(room);
  if (cached && cached.base === base && cached.floor === floor) return cached.confine;
  const top = base.center.y + base.half.y;
  const bottom = Math.min(top - 0.5, Math.max(base.center.y - base.half.y, floor - FLOOR_MARGIN));
  const confine: LightConfine = {
    center: new THREE.Vector3(base.center.x, (top + bottom) / 2, base.center.z),
    half: new THREE.Vector3(base.half.x, (top - bottom) / 2, base.half.z),
    cos: base.cos,
    sin: base.sin,
  };
  roomCache.set(room, { base, floor, confine });
  return confine;
}
