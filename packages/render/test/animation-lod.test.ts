import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { AnimationSystem } from "../src/animation.js";

afterEach(() => vi.restoreAllMocks());
const clip = (name: string, duration = 2) => new THREE.AnimationClip(name, duration,
  [new THREE.NumberKeyframeTrack("Bone.position[x]", [0, duration], [0, duration])]);
function harness(lod = true) {
  const system = new AnimationSystem(), root = new THREE.Group(), bone = new THREE.Bone(), camera = new THREE.PerspectiveCamera();
  bone.name = "Bone"; root.add(bone); root.position.x = 150;
  system.register("resident-visual", root, [clip("idle"), clip("walk"), clip("attack", 0.2)], {
    fade: 0, speed: 1, ...(lod ? { poseLod: [{ distance: 40, fps: 20 }, { distance: 100, fps: 10 }] } : {}),
  }, "resident");
  system.setRunning(true); system.play("resident", "idle", 0);
  const mixer = vi.spyOn(THREE.AnimationMixer.prototype, "update");
  return { system, root, bone, camera, mixer, tick: (dt = 1 / 60) => system.update(dt, camera) };
}

describe("distance-based looping pose evaluation", () => {
  it("reduces distant pose evaluations while preserving playback time, and catches up immediately nearby", () => {
    const h = harness(); for (let i = 0; i < 60; i++) h.tick();
    expect(h.mixer.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(h.mixer.mock.calls.length).toBeLessThanOrEqual(12);
    expect(h.system.baseClipPhase("resident")!.t01).toBeCloseTo(0.5, 8);
    h.camera.position.x = 149; h.mixer.mockClear(); h.tick();
    expect(h.mixer).toHaveBeenCalledTimes(1);
    expect(h.bone.position.x).toBeCloseTo(1 + 1 / 60, 8);
    for (let i = 0; i < 10; i++) h.tick();
    expect(h.mixer).toHaveBeenCalledTimes(11);
  });

  it("retains full-rate defaults and works without a camera", () => {
    const h = harness(false); for (let i = 0; i < 30; i++) h.tick();
    expect(h.mixer).toHaveBeenCalledTimes(30); h.mixer.mockClear();
    const opted = harness(); opted.mixer.mockClear();
    for (let i = 0; i < 30; i++) opted.system.update(1 / 60);
    expect(opted.mixer).toHaveBeenCalledTimes(30);
  });

  it("protects the followed character through the parent entity delegate", () => {
    const h = harness(); for (let i = 0; i < 30; i++) h.system.update(1 / 60, h.camera, "resident");
    expect(h.mixer).toHaveBeenCalledTimes(30);
  });

  it("uses the middle distance tier and catches up when the camera teleports", () => {
    const h = harness(); h.camera.position.x = 75;
    for (let i = 0; i < 60; i++) h.tick();
    expect(h.mixer.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(h.mixer.mock.calls.length).toBeLessThanOrEqual(22);
    h.camera.position.x = 150; h.tick(0.01);
    expect(h.bone.position.x).toBeCloseTo(1.01, 8);
  });

  it("spreads a distant crowd's updates rather than evaluating every NPC on the same frame", () => {
    const system = new AnimationSystem(), camera = new THREE.PerspectiveCamera();
    for (let i = 0; i < 48; i++) {
      const root = new THREE.Group(), bone = new THREE.Bone(); bone.name = "Bone"; root.add(bone); root.position.x = 150;
      system.register(`resident-${i}`, root, [clip("idle")], { play: "idle", fade: 0, speed: 1, poseLod: [{ distance: 100, fps: 10 }] });
    }
    system.setRunning(true); const mixer = vi.spyOn(THREE.AnimationMixer.prototype, "update");
    system.update(1 / 60, camera); // every model gets its initial pose
    const counts: number[] = [];
    for (let i = 0; i < 12; i++) { mixer.mockClear(); system.update(1 / 60, camera); counts.push(mixer.mock.calls.length); }
    expect(counts.filter(n => n > 0).length).toBeGreaterThan(4);
    expect(Math.max(...counts)).toBeLessThan(48);
  });

  it("flushes old elapsed time before a one-shot and preserves completion timing", () => {
    const h = harness(), completed: string[] = [];
    h.system.onClipFinished = (_id, name) => completed.push(name);
    h.tick(0.001); h.tick(0.001);
    h.system.play("resident", "attack", 0, false); h.mixer.mockClear();
    for (let i = 0; i < 19; i++) h.tick(0.01);
    expect(completed).toEqual([]); expect(h.mixer).toHaveBeenCalledTimes(19);
    h.tick(0.011); expect(completed).toEqual(["attack"]);
  });

  it("evaluates fades and upper-body layers every frame", () => {
    const h = harness(); h.tick(); h.system.play("resident", "walk", 0.4); h.mixer.mockClear();
    for (let i = 0; i < 20; i++) h.tick(); expect(h.mixer).toHaveBeenCalledTimes(20);
    h.system.playLayer("resident", "attack", { mask: "Bone", loop: true, fade: 0 }); h.mixer.mockClear();
    for (let i = 0; i < 30; i++) h.tick(); expect(h.mixer).toHaveBeenCalledTimes(30);
  });

  it("accounts for old speed before a rate change, and discards old pose debt when stopped", () => {
    const h = harness(); h.tick(0.001); h.tick(0.001);
    h.system.setSpeed("resident", 2); h.tick(0.01);
    expect(h.system.baseClipPhase("resident")!.t01).toBeCloseTo(0.011, 8);
    h.system.setRunning(false); h.system.setRunning(true); h.system.play("resident", "idle", 0); h.tick(0.01);
    expect(h.system.baseClipPhase("resident")!.t01).toBeCloseTo(0.01, 8);
  });
});

describe("held poses skip the skeleton's matrix walk", () => {
  const walk = (h: ReturnType<typeof harness>, frames: number) => {
    const spy = vi.spyOn(h.bone, "updateMatrix");
    for (let i = 0; i < frames; i++) { h.tick(); h.root.updateMatrixWorld(); }
    return spy.mock.calls.length;
  };

  it("walks a distant resident's bones only on frames that evaluated a pose", () => {
    const h = harness(); h.tick(); h.root.updateMatrixWorld();
    h.mixer.mockClear();
    const walks = walk(h, 60);
    expect(walks).toBe(h.mixer.mock.calls.length);
    expect(walks).toBeLessThanOrEqual(12);
    expect(h.root.userData["poseVersion"]).toBeGreaterThan(0);
  });

  it("still follows a parent that moves under a held pose", () => {
    const h = harness(); walk(h, 3);
    h.root.position.z = 7; h.root.updateMatrix();
    h.root.updateMatrixWorld();
    expect(h.bone.matrixWorld.elements[14]).toBeCloseTo(7, 8);
  });

  it("walks every frame near the camera, with the hold off, or once a non-bone hangs under the skeleton", () => {
    const near = harness(); near.camera.position.x = 149;
    expect(walk(near, 30)).toBe(30);
    const off = harness(); off.system.holdBones = false;
    expect(walk(off, 30)).toBe(30);
    const holder = harness(); holder.bone.add(new THREE.Object3D()); walk(holder, 2);
    expect(walk(holder, 30)).toBe(30);
  });
});
