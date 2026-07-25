import * as THREE from "three/webgpu";
import type { BodyState } from "@hitreg/physics";

const bodyWorldPos = new THREE.Vector3();
const parentQuat = new THREE.Quaternion();
const bodyQuat = new THREE.Quaternion();

export function applyBodyState(object: THREE.Object3D, state: BodyState): void {
  const parent = object.parent;
  if (!parent) return;
  parent.updateWorldMatrix(true, false);
  object.position.copy(
    parent.worldToLocal(bodyWorldPos.set(state.position[0], state.position[1], state.position[2])),
  );
  parent.getWorldQuaternion(parentQuat).invert();
  object.quaternion.copy(
    parentQuat.multiply(bodyQuat.set(state.rotation[0], state.rotation[1], state.rotation[2], state.rotation[3])),
  );
}
