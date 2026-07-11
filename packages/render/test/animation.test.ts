import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { AnimationSystem } from "../src/animation.js";

/** A 1-second clip that nudges the root's X — enough for the mixer to run. */
function clip(name: string, duration = 1): THREE.AnimationClip {
  const track = new THREE.NumberKeyframeTrack(
    ".position[x]",
    [0, duration],
    [0, 1],
  );
  return new THREE.AnimationClip(name, duration, [track]);
}

function systemWith(clips: THREE.AnimationClip[]) {
  const system = new AnimationSystem();
  const root = new THREE.Object3D();
  system.register("hero", root, clips, { fade: 0, speed: 1 });
  system.setRunning(true);
  return system;
}

describe("AnimationSystem one-shot completion", () => {
  it("raises onClipFinished with entity + clip when a one-shot ends", () => {
    const done: Array<[string, string]> = [];
    const system = systemWith([clip("attack")]);
    system.onClipFinished = (id, name) => done.push([id, name]);

    system.play("hero", "attack", 0, false); // one-shot
    // step past the 1s clip in 60Hz increments
    for (let i = 0; i < 70; i++) system.update(1 / 60);

    expect(done).toEqual([["hero", "attack"]]);
  });

  it("never fires for a looping clip, however long it runs", () => {
    const done: string[] = [];
    const system = systemWith([clip("run")]);
    system.onClipFinished = (_id, name) => done.push(name);

    system.play("hero", "run", 0, true); // default loop
    for (let i = 0; i < 300; i++) system.update(1 / 60); // 5 seconds

    expect(done).toEqual([]);
  });

  it("an action reused as one-shot then loop stops finishing", () => {
    const done: string[] = [];
    const system = systemWith([clip("emote"), clip("idle")]);
    system.onClipFinished = (_id, name) => done.push(name);

    system.play("hero", "emote", 0, false);
    for (let i = 0; i < 70; i++) system.update(1 / 60);
    expect(done).toEqual(["emote"]);

    // replay the SAME action looping — LoopOnce must not linger on it
    system.play("hero", "idle", 0, true); // move off emote first
    system.play("hero", "emote", 0, true); // now loop it
    for (let i = 0; i < 200; i++) system.update(1 / 60);
    expect(done).toEqual(["emote"]); // no second completion
  });
});
