import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { AnimationSystem } from "../src/animation.js";

/** root > Hips > (spine_01 > upperarm_l, thigh_l) — the waist split is spine_01. */
function rig(): THREE.Object3D {
  const root = new THREE.Object3D();
  const hips = new THREE.Object3D();
  hips.name = "Hips";
  const spine = new THREE.Object3D();
  spine.name = "spine_01";
  const arm = new THREE.Object3D();
  arm.name = "upperarm_l";
  const thigh = new THREE.Object3D();
  thigh.name = "thigh_l";
  root.add(hips);
  hips.add(spine, thigh);
  spine.add(arm);
  return root;
}

/** A clip whose bones' X position IS its normalised phase (0 → 1 across the clip). */
function phaseClip(name: string, duration: number, bones: string[]): THREE.AnimationClip {
  const tracks = bones.map((b) => new THREE.NumberKeyframeTrack(`${b}.position[x]`, [0, duration], [0, 1]));
  return new THREE.AnimationClip(name, duration, tracks);
}

function setup() {
  const root = rig();
  const system = new AnimationSystem();
  system.register(
    "hero",
    root,
    [
      phaseClip("Run", 0.9, ["thigh_l", "spine_01", "upperarm_l"]),
      // a stance's run: a different length from the legs' clip
      phaseClip("TwoHanded_Run", 0.7, ["thigh_l", "spine_01", "upperarm_l"]),
      phaseClip("SwordShield_Idle", 2, ["spine_01", "upperarm_l"]),
    ],
    { fade: 0, speed: 1 },
  );
  system.setRunning(true);
  const x = (bone: string) => root.getObjectByName(bone)!.position.x;
  return { system, x };
}

describe("AnimationSystem phase-locked layer (stance carry)", () => {
  it("holds the layer at the base's phase plus the offset, whatever either clip's length or the base rate", () => {
    const { system, x } = setup();
    system.play("hero", "Run", 0);
    system.playLayer("hero", "TwoHanded_Run", { fade: 0, loop: true, phaseLock: 0.25 });
    system.setSpeed("hero", 1.7);
    for (let i = 0; i < 97; i++) {
      system.update(1 / 60);
      const legs = x("thigh_l");
      const arms = x("upperarm_l");
      const expected = (legs + 0.25) % 1;
      // the same point of the stride (mod the loop seam)
      const d = Math.abs(arms - expected);
      expect(Math.min(d, 1 - d)).toBeLessThan(0.02);
    }
    expect(system.layerPhaseLock("hero")).toBe(0.25);
  });

  it("re-aims the lock on a re-assert and lets it run free when dropped", () => {
    const { system, x } = setup();
    system.play("hero", "Run", 0);
    system.playLayer("hero", "TwoHanded_Run", { fade: 0, loop: true, phaseLock: 0 });
    system.update(0.2);
    system.playLayer("hero", "TwoHanded_Run", { fade: 0, loop: true, phaseLock: 0.5 });
    system.update(1 / 60);
    const d = Math.abs(x("upperarm_l") - ((x("thigh_l") + 0.5) % 1));
    expect(Math.min(d, 1 - d)).toBeLessThan(0.02);
    system.playLayer("hero", "TwoHanded_Run", { fade: 0, loop: true });
    expect(system.layerPhaseLock("hero")).toBeNull();
    const before = x("upperarm_l");
    system.setSpeed("hero", 3); // the legs speed up; a free layer does not
    system.update(0.07);
    expect(x("upperarm_l") - before).toBeCloseTo(0.1, 2); // 0.07 s of a 0.7 s clip at rate 1
  });

  it("an unlocked carry (a held idle) runs at its own pace over the gait", () => {
    const { system, x } = setup();
    system.play("hero", "Run", 0);
    system.playLayer("hero", "SwordShield_Idle", { fade: 0, loop: true, speed: 1 });
    system.update(0.5);
    expect(x("upperarm_l")).toBeCloseTo(0.25, 2); // half a second of a 2 s idle
    expect(x("thigh_l")).toBeCloseTo(0.5 / 0.9, 2); // the legs keep the run
    expect(system.layerPhaseLock("hero")).toBeNull();
  });
});
