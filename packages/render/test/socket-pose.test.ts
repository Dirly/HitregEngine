import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { findSocketBone, socketParamsFrom, socketWorldPose } from "../src/socket-pose.js";

function rig() {
  const root = new THREE.Object3D();
  const arm = new THREE.Object3D();
  arm.position.set(0.3, 1.4, 0.1);
  arm.rotation.set(0.4, -0.7, 1.1);
  const hand = new THREE.Object3D();
  hand.name = "mixamorigRightHand";
  hand.position.set(0, 0.25, 0);
  hand.rotation.set(-0.2, 0.5, 0.3);
  arm.add(hand);
  root.add(arm);
  root.updateMatrixWorld(true);
  return { root, hand };
}

describe("socket pose", () => {
  it("matches bone-socket's sums: offset in the bone's axes, rotation after the bone's", () => {
    const { hand } = rig();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    socketWorldPose(hand, { offset: [0.1, 0, 0], rotationDeg: [0, 90, 0] }, pos, quat);
    const boneQ = hand.getWorldQuaternion(new THREE.Quaternion());
    const want = hand.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0.1, 0, 0).applyQuaternion(boneQ));
    expect(pos.distanceTo(want)).toBeLessThan(1e-6);
    const wantQ = boneQ.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)));
    expect(quat.angleTo(wantQ)).toBeLessThan(1e-6);
  });

  it("socketParamsFrom is the inverse — a gizmo drag writes back exactly what it showed", () => {
    const { hand } = rig();
    const params = { offset: [0.031, -0.12, 0.078] as [number, number, number], rotationDeg: [12.5, -40, 101.25] as [number, number, number] };
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    socketWorldPose(hand, params, pos, quat);
    const back = socketParamsFrom(hand, pos, quat);
    back.offset.forEach((v, i) => expect(v).toBeCloseTo(params.offset[i]!, 4));
    back.rotationDeg.forEach((v, i) => expect(v).toBeCloseTo(params.rotationDeg[i]!, 1));
  });

  it("finds a bone by its raw rig name or its sanitized glTF name", () => {
    const { root } = rig();
    expect(findSocketBone(root, "mixamorig:RightHand")?.name).toBe("mixamorigRightHand");
    expect(findSocketBone(root, "nope")).toBeNull();
  });
});
