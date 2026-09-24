import * as THREE from "three/webgpu";

/**
 * The `bone-socket` arithmetic, for the host side (the editor's preview and
 * its gizmo). The script in @hitreg/scripting does the same sums with
 * type-only three; these two must stay each other's inverse and agree with it
 * — test/socket-pose.test.ts pins both.
 *
 *   world position = bone position + boneQ · offset          (offset in the BONE's axes)
 *   world rotation = boneQ · euler(rotationDeg, "XYZ")
 */
export interface SocketParams {
  offset: [number, number, number];
  rotationDeg: [number, number, number];
}

const DEG = Math.PI / 180;
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _e = new THREE.Euler();

/** Where a socket puts its item, in world space. */
export function socketWorldPose(
  bone: THREE.Object3D,
  params: SocketParams,
  outPosition: THREE.Vector3,
  outQuaternion: THREE.Quaternion,
): void {
  bone.updateWorldMatrix(true, false);
  bone.getWorldPosition(outPosition);
  bone.getWorldQuaternion(outQuaternion);
  _v.set(params.offset[0], params.offset[1], params.offset[2]).applyQuaternion(outQuaternion);
  outPosition.add(_v);
  _e.set(params.rotationDeg[0] * DEG, params.rotationDeg[1] * DEG, params.rotationDeg[2] * DEG, "XYZ");
  outQuaternion.multiply(_q.setFromEuler(_e));
}

/** The socket params that put an item at this world pose — what a gizmo drag means. */
export function socketParamsFrom(
  bone: THREE.Object3D,
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
  precision = 1e4,
): SocketParams {
  bone.updateWorldMatrix(true, false);
  const boneQ = bone.getWorldQuaternion(new THREE.Quaternion());
  const inv = boneQ.clone().invert();
  const offset = position.clone().sub(bone.getWorldPosition(new THREE.Vector3())).applyQuaternion(inv);
  const e = new THREE.Euler().setFromQuaternion(inv.multiply(quaternion), "XYZ");
  const round = (v: number, k: number): number => Math.round(v * k) / k;
  return {
    offset: [round(offset.x, precision), round(offset.y, precision), round(offset.z, precision)],
    rotationDeg: [round(e.x / DEG, 100), round(e.y / DEG, 100), round(e.z / DEG, 100)],
  };
}

/** A bone by the name a socket was given — raw, or sanitized the way GLTFLoader renames nodes. */
export function findSocketBone(root: THREE.Object3D, name: string): THREE.Object3D | null {
  return root.getObjectByName(name) ?? root.getObjectByName(name.replace(/[\s.:[\]/]/g, "")) ?? null;
}
