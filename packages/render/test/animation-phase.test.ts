import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { AnimationSystem } from "../src/animation.js";

function clip(name: string, duration: number): THREE.AnimationClip {
  const track = new THREE.NumberKeyframeTrack(".position[x]", [0, duration], [0, 1]);
  return new THREE.AnimationClip(name, duration, [track]);
}

function systemWith(clips: THREE.AnimationClip[]) {
  const system = new AnimationSystem();
  system.register("hero", new THREE.Object3D(), clips, { fade: 0, speed: 1 });
  system.setRunning(true);
  return system;
}

describe("AnimationSystem.baseClipPhase", () => {
  it("is null with nothing playing", () => {
    expect(new AnimationSystem().baseClipPhase("hero")).toBeNull();
    expect(systemWith([clip("walk", 1)]).baseClipPhase("hero")).toBeNull();
  });

  it("reports the base clip's playhead as a fraction, wrapping each loop and following the rate", () => {
    const system = systemWith([clip("walk", 2)]);
    system.play("hero", "walk", 0);
    system.update(0.5);
    expect(system.baseClipPhase("hero")?.clip).toBe("walk");
    expect(system.baseClipPhase("hero")?.t01).toBeCloseTo(0.25, 5);
    system.update(2);
    expect(system.baseClipPhase("hero")?.t01).toBeCloseTo(0.25, 5);
    system.setSpeed("hero", 2);
    system.update(0.5);
    expect(system.baseClipPhase("hero")?.t01).toBeCloseTo(0.75, 5);
  });

  it("names the heavier clip of a held blend", () => {
    const system = systemWith([clip("walk", 1), clip("wade", 1)]);
    system.playBlend("hero", "walk", "wade", 0.3, 0);
    system.update(0.1);
    expect(system.baseClipPhase("hero")?.clip).toBe("walk");
    system.playBlend("hero", "walk", "wade", 0.7, 0);
    system.update(0.1);
    expect(system.baseClipPhase("hero")?.clip).toBe("wade");
  });
});
