import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { AnimationSystem, flinchEnvelope } from "../src/animation.js";

/** body > model root > Hips > spine_01 > spine_02 > head — the waist split is spine_01. */
function setup() {
  const body = new THREE.Object3D();
  const root = new THREE.Object3D();
  const hips = new THREE.Object3D();
  hips.name = "Hips";
  const spine1 = new THREE.Object3D();
  spine1.name = "spine_01";
  const spine2 = new THREE.Object3D();
  spine2.name = "spine_02";
  const head = new THREE.Object3D();
  head.name = "head";
  head.position.set(0, 0.6, 0);
  spine2.position.set(0, 0.3, 0);
  body.add(root);
  root.add(hips);
  hips.add(spine1);
  spine1.add(spine2);
  spine2.add(head);
  const system = new AnimationSystem();
  // a held idle: the mixer writes the spine once and then never again
  const idle = new THREE.AnimationClip("Idle", 1, [new THREE.QuaternionKeyframeTrack("spine_01.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]);
  system.register("hero", root, [idle], { fade: 0, speed: 1 });
  system.setRunning(true);
  system.play("hero", "Idle", 0);
  const headPos = () => {
    body.updateMatrixWorld(true);
    return head.getWorldPosition(new THREE.Vector3());
  };
  return { body, system, spine1, spine2, headPos };
}

describe("hit flinch (userData.poseFlinch)", () => {
  it("tips the upper body along the blow, then puts every bone back exactly", () => {
    const { body, system, spine1, spine2, headPos } = setup();
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    system.update(1 / 60);
    const rest1 = spine1.quaternion.clone();
    const rest2 = spine2.quaternion.clone();
    const upright = headPos();
    // a blow travelling +Z, stamped on the BODY two levels above the model root
    body.userData["poseFlinch"] = { at: now, dir: [0, 0, 1], angle: 0.4, ms: 300 };
    now += 30;
    system.update(1 / 60);
    const pushed = headPos();
    expect(pushed.z).toBeGreaterThan(upright.z + 0.05); // the head goes WITH the blow
    // held pose: the flinch is not compounded frame on frame
    now += 1;
    system.update(1 / 60);
    expect(Math.abs(headPos().z - pushed.z)).toBeLessThan(0.02);
    // over: the bones hold exactly what the mixer left
    now += 400;
    system.update(1 / 60);
    expect(spine1.quaternion.angleTo(rest1)).toBeLessThan(1e-6);
    expect(spine2.quaternion.angleTo(rest2)).toBeLessThan(1e-6);
    clock.mockRestore();
  });

  it("snaps out during a hit-stop too", () => {
    const { body, system, headPos } = setup();
    let now = 5000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    system.update(1 / 60);
    const upright = headPos();
    body.userData["poseHoldUntil"] = now + 100;
    body.userData["poseFlinch"] = { at: now, dir: [1, 0, 0], angle: 0.4, ms: 300 };
    now += 20;
    system.update(1 / 60);
    expect(headPos().x).toBeGreaterThan(upright.x + 0.05);
    clock.mockRestore();
  });

  it("envelope: nothing before or after, a fast snap to the peak, an optional sway past upright", () => {
    expect(flinchEnvelope(-0.1)).toBe(0);
    expect(flinchEnvelope(1)).toBe(0);
    expect(flinchEnvelope(0.12)).toBeCloseTo(1, 5);
    expect(flinchEnvelope(0.06)).toBeGreaterThan(0.6);
    const swayed = [0.5, 0.6, 0.7, 0.8].map((t) => flinchEnvelope(t, 1));
    expect(Math.min(...swayed)).toBeLessThan(0);
  });
});
