import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { AnimationSystem } from "../src/animation.js";

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
