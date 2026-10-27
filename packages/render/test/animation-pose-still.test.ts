import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { AnimationSystem, CROWD_POSE_LOD } from "../src/animation.js";

// Bone.position.x runs 1 -> 3 over each clip, so the bind value 0 is never a pose.
const clip = (name: string, duration = 2) =>
  new THREE.AnimationClip(name, duration, [new THREE.NumberKeyframeTrack("Bone.position[x]", [0, duration], [1, 3])]);

function harness() {
  const system = new AnimationSystem();
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = "Bone";
  root.add(bone);
  // registered as the model child of "actor", the way a character's visual delegates
  system.register("actor-model", root, [clip("idle"), clip("swing")], { play: "idle", fade: 0, speed: 1 }, "actor");
  return { system, bone };
}

describe("edit-mode poses (poseStill)", () => {
  it("holds the first frame of the declared clip instead of handing the bone back to bind", () => {
    const h = harness();
    h.system.poseStill();
    expect(h.bone.position.x).toBeCloseTo(1, 6);
    h.system.poseStill(); // every frame, unchanged
    expect(h.bone.position.x).toBeCloseTo(1, 6);
  });

  it("stands a character at a time in another clip, named by the entity that delegates to its model", () => {
    const h = harness();
    h.system.poseStill((id) => (id === "actor" ? { clip: "swing", time: 1 } : null));
    expect(h.bone.position.x).toBeCloseTo(2, 6);
    h.system.poseStill((id) => (id === "actor" ? { clip: "swing", time: 1.5 } : null));
    expect(h.bone.position.x).toBeCloseTo(2.5, 6);
    h.system.poseStill(); // back to its own clip
    expect(h.bone.position.x).toBeCloseTo(1, 6);
  });

  it("lets go of the held pose when play starts", () => {
    const h = harness();
    h.system.poseStill((id) => (id === "actor" ? { clip: "swing", time: 1 } : null));
    h.system.setRunning(true);
    h.system.update(0.5);
    expect(h.bone.position.x).toBeCloseTo(1.5, 6); // idle, half a second in
  });
});

describe("edit-mode poses skip the skeleton's matrix walk while unchanged", () => {
  function held() {
    const system = new AnimationSystem();
    system.defaultPoseLod = CROWD_POSE_LOD; // what the app sets: pose-LOD models get the bone hold
    const scene = new THREE.Group();
    const root = new THREE.Group();
    const bone = new THREE.Bone();
    bone.name = "Bone";
    root.add(bone);
    scene.add(root);
    system.register("actor-model", root, [clip("idle"), clip("swing")], { play: "idle", fade: 0, speed: 1 }, "actor");
    const frame = (clipFor?: Parameters<AnimationSystem["poseStill"]>[0]) => { system.poseStill(clipFor); scene.updateMatrixWorld(); };
    return { system, scene, root, bone, frame };
  }

  it("walks the bones on the frame a pose is set, then not again until something changes", () => {
    const h = held();
    h.frame();
    const spy = vi.spyOn(h.bone, "updateMatrix");
    for (let i = 0; i < 5; i++) h.frame();
    expect(spy).not.toHaveBeenCalled();
    expect(h.bone.matrixWorld.elements[12]).toBeCloseTo(1, 6);
    // a new pose (the scrubber) walks once
    h.frame((id) => (id === "actor" ? { clip: "swing", time: 1 } : null));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.bone.matrixWorld.elements[12]).toBeCloseTo(2, 6);
    // the character moved (a gizmo drag): the held skeleton follows
    h.root.position.z = 4;
    h.frame((id) => (id === "actor" ? { clip: "swing", time: 1 } : null));
    expect(h.bone.matrixWorld.elements[14]).toBeCloseTo(4, 6);
  });

  it("walks every frame with holdBones off", () => {
    const h = held();
    h.system.holdBones = false;
    h.frame();
    const spy = vi.spyOn(h.bone, "updateMatrix");
    for (let i = 0; i < 3; i++) h.frame();
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe("play-mode update with the host's skip hook (mob distance sleep)", () => {
  // Drives one whole update() over a mixed set with pose LOD on: the loop body has its own pose-LOD `skip`, and an
  // outer hook named the same once threw "Cannot access 'skip' before initialization" on every play frame.
  function crowd() {
    const system = new AnimationSystem();
    system.defaultPoseLod = CROWD_POSE_LOD;
    const bones = new Map<string, THREE.Bone>();
    for (const id of ["awake", "asleep", "player"]) {
      const root = new THREE.Group();
      const bone = new THREE.Bone();
      bone.name = "Bone";
      root.add(bone);
      bones.set(id, bone);
      system.register(`${id}-model`, root, [clip("idle")], { play: "idle", fade: 0, speed: 1 }, id);
    }
    system.setRunning(true);
    return { system, bones };
  }

  it("poses the awake models, holds the skipped one, and never skips the protected entity", () => {
    const h = crowd();
    h.system.skip = (id) => id === "asleep-model" || id === "player-model"; // keyed by the model entity, as in the app
    const camera = new THREE.PerspectiveCamera();
    expect(() => h.system.update(0.5, camera, "player")).not.toThrow();
    expect(h.bones.get("awake")!.position.x).toBeCloseTo(1.5, 6);
    expect(h.bones.get("player")!.position.x).toBeCloseTo(1.5, 6); // protected: the hook is not asked
    expect(h.bones.get("asleep")!.position.x).toBeCloseTo(0, 6); // never posed: time dropped, not banked
    h.system.skip = null;
    h.system.update(0.5, camera, "player");
    expect(h.bones.get("asleep")!.position.x).toBeCloseTo(1.5, 6); // wakes from where it stood, half a second in
  });
});
