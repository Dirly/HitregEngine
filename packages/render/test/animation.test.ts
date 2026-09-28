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

/** A three-bone humanoid: root > Hips > spine_01 > upperarm_l, plus a thigh. */
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

function node(root: THREE.Object3D, name: string): THREE.Object3D {
  return root.getObjectByName(name)!;
}

/** One track per named node, ramping its X position between two values. */
function poseClip(
  name: string,
  duration: number,
  pose: Record<string, [number, number]>,
): THREE.AnimationClip {
  const tracks = Object.entries(pose).map(
    ([bone, [from, to]]) =>
      new THREE.NumberKeyframeTrack(`${bone}.position[x]`, [0, duration], [from, to]),
  );
  return new THREE.AnimationClip(name, duration, tracks);
}

function layered() {
  const root = rig();
  const system = new AnimationSystem();
  system.register(
    "hero",
    root,
    [
      poseClip("Run", 4, { thigh_l: [0, 4], spine_01: [0, 4] }),
      poseClip("Cast", 4, { spine_01: [10, 10], upperarm_l: [10, 10] }),
    ],
    { fade: 0, speed: 1 },
  );
  system.setRunning(true);
  return { system, root };
}

describe("AnimationSystem layers", () => {
  it("plays a layer on the masked bones while the base keeps the rest", () => {
    const { system, root } = layered();
    system.play("hero", "Run", 0);
    for (let i = 0; i < 60; i++) system.update(1 / 60); // 1s into the run
    expect(node(root, "thigh_l").position.x).toBeCloseTo(1, 1);
    expect(node(root, "spine_01").position.x).toBeCloseTo(1, 1);

    system.playLayer("hero", "Cast", { fade: 0 });
    for (let i = 0; i < 30; i++) system.update(1 / 60); // half a second more

    // legs still running — and running from where they were, not from frame 0
    expect(node(root, "thigh_l").position.x).toBeCloseTo(1.5, 1);
    // everything from the spine up is the cast
    expect(node(root, "spine_01").position.x).toBeCloseTo(10, 1);
    expect(node(root, "upperarm_l").position.x).toBeCloseTo(10, 1);
    // the base clip is still what the entity "is" playing; the layer rides it
    expect(system.currentClip("hero")).toBe("Run");
    expect(system.layerClip("hero")).toBe("Cast");
  });

  it("hands the whole body back when the layer clears", () => {
    const { system, root } = layered();
    system.play("hero", "Run", 0);
    system.playLayer("hero", "Cast", { fade: 0 });
    for (let i = 0; i < 60; i++) system.update(1 / 60);
    expect(node(root, "spine_01").position.x).toBeCloseTo(10, 1);

    system.clearLayer("hero", 0);
    for (let i = 0; i < 30; i++) system.update(1 / 60);
    expect(system.layerClip("hero")).toBeNull();
    // 1.5s of Run, ramping 0 -> 4 over 4s
    expect(node(root, "spine_01").position.x).toBeCloseTo(1.5, 1);
    expect(node(root, "thigh_l").position.x).toBeCloseTo(1.5, 1);
  });

  it("re-asserting the same layer does not restart it (net sends it every frame)", () => {
    const { system, root } = layered();
    system.play("hero", "Run", 0);
    system.playLayer("hero", "Cast", { fade: 0 });
    for (let i = 0; i < 30; i++) {
      system.playLayer("hero", "Cast", { fade: 0 });
      system.update(1 / 60);
    }
    // the base kept advancing under it rather than being re-synced each frame
    expect(node(root, "thigh_l").position.x).toBeCloseTo(0.5, 1);
  });

  it("splits a CC rig at the waist: the hip and the pelvis's legs stay the gait's", () => {
    // CC_Base_Hip > { CC_Base_Pelvis > thigh, CC_Base_Waist > Spine01 > arm } —
    // the MMO human's layout, where the legs hang off a SIBLING of the spine
    const root = new THREE.Object3D();
    const names = ["CC_Base_Hip", "CC_Base_Pelvis", "CC_Base_L_Thigh", "CC_Base_Waist", "CC_Base_Spine01", "CC_Base_L_Upperarm"];
    const [hip, pelvis, thigh, waist, spine, arm] = names.map((n) => Object.assign(new THREE.Object3D(), { name: n }));
    root.add(hip!);
    hip!.add(pelvis!, waist!);
    pelvis!.add(thigh!);
    waist!.add(spine!);
    spine!.add(arm!);
    const system = new AnimationSystem();
    const all = Object.fromEntries(names.map((n) => [n, [0, 4] as [number, number]]));
    const block = Object.fromEntries(names.map((n) => [n, [10, 10] as [number, number]]));
    system.register("hero", root, [poseClip("Walk", 4, all), poseClip("Block", 4, block)], { fade: 0, speed: 1 });
    system.setRunning(true);
    system.play("hero", "Walk", 0);
    system.playLayer("hero", "Block", { fade: 0 });
    for (let i = 0; i < 60; i++) system.update(1 / 60);
    for (const legs of ["CC_Base_Hip", "CC_Base_Pelvis", "CC_Base_L_Thigh"]) {
      expect(node(root, legs).position.x).toBeCloseTo(1, 1);
    }
    for (const arms of ["CC_Base_Waist", "CC_Base_Spine01", "CC_Base_L_Upperarm"]) {
      expect(node(root, arms).position.x).toBeCloseTo(10, 1);
    }
  });

  it("keeps a layer's torso on the clip's hips, not the gait's (a bladed guard over a walk)", () => {
    // Hip > Waist > Spine01 > Spine02 > Head. The guard stands bladed: hips
    // turned -60 degrees, spine twisted +60 back so the chest faces ahead. The
    // walk's hips are square — the guard's local spine alone would face +60.
    const root = new THREE.Object3D();
    const names = ["CC_Base_Hip", "CC_Base_Waist", "CC_Base_Spine01", "CC_Base_Spine02", "CC_Base_Head"];
    const bones = names.map((n) => Object.assign(new THREE.Object3D(), { name: n }));
    root.add(bones[0]!);
    for (let i = 1; i < bones.length; i++) bones[i - 1]!.add(bones[i]!);
    const yawQ = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
    const rot = (bone: string, deg: number) =>
      new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, 1], [...yawQ(deg).toArray(), ...yawQ(deg).toArray()]);
    const walk = new THREE.AnimationClip("Walk", 1, [rot("CC_Base_Hip", 0), rot("CC_Base_Waist", 0)]);
    const guard = new THREE.AnimationClip("Guard", 1, [rot("CC_Base_Hip", -60), rot("CC_Base_Waist", 20), rot("CC_Base_Spine01", 20), rot("CC_Base_Spine02", 20)]);
    const system = new AnimationSystem();
    system.register("hero", root, [walk, guard], { fade: 0, speed: 1 });
    system.setRunning(true);
    system.play("hero", "Walk", 0);
    // held like a real guard: played once, clamped on its last frame — the
    // mixer stops rewriting the bones then, and a turn that stacked on itself
    // spun the character (so run well past the clip's end)
    system.playLayer("hero", "Guard", { fade: 0, loop: false });
    for (let i = 0; i < 180; i++) system.update(1 / 60);
    const facing = (name: string) => {
      root.updateMatrixWorld(true);
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(node(root, name).getWorldQuaternion(new THREE.Quaternion()));
      return (Math.atan2(f.x, f.z) * 180) / Math.PI;
    };
    expect(facing("CC_Base_Hip")).toBeCloseTo(0, 3); // legs still the walk's
    expect(facing("CC_Base_Head")).toBeCloseTo(0, 3); // eyes ahead, as the guard authored
    // the turn is shared along the spine, not all at the waist
    expect(facing("CC_Base_Waist")).toBeCloseTo(0, 3);
    expect(facing("CC_Base_Spine01")).toBeCloseTo(0, 3);
    system.clearLayer("hero", 0);
    system.update(1 / 60);
    expect(facing("CC_Base_Head")).toBeCloseTo(0, 3); // walk's own square spine
  });

  it("falls back to a full-body play when the rig has no mask bone", () => {
    const root = new THREE.Object3D();
    const limb = new THREE.Object3D();
    limb.name = "arm";
    root.add(limb);
    const system = new AnimationSystem();
    system.register("bot", root, [poseClip("Idle", 4, { arm: [0, 4] }), poseClip("Cast", 4, { arm: [10, 10] })], {
      fade: 0,
      speed: 1,
    });
    system.setRunning(true);
    system.play("bot", "Idle", 0);
    system.playLayer("bot", "Cast", { fade: 0 });
    for (let i = 0; i < 30; i++) system.update(1 / 60);

    expect(system.layerClip("bot")).toBeNull();
    expect(system.currentClip("bot")).toBe("Cast");
    expect(node(root, "arm").position.x).toBeCloseTo(10, 1);
  });

  it("reports the caller's clip name when a masked one-shot finishes", () => {
    const { system } = layered();
    const done: string[] = [];
    system.onClipFinished = (_id, clip) => done.push(clip);
    system.play("hero", "Run", 0);
    system.playLayer("hero", "Cast", { fade: 0, loop: false });
    for (let i = 0; i < 260; i++) system.update(1 / 60); // past the 4s clip

    expect(done).toEqual(["Cast"]);
  });

  it("keeps the locomotion rate off the layer", () => {
    const { system, root } = layered();
    system.play("hero", "Run", 0);
    system.setSpeed("hero", 2);
    system.playLayer("hero", "Cast", { fade: 0 });
    for (let i = 0; i < 60; i++) system.update(1 / 60);

    // legs at double rate (2s of clip in 1s), cast at its authored rate
    expect(node(root, "thigh_l").position.x).toBeCloseTo(2, 1);
    expect(node(root, "spine_01").position.x).toBeCloseTo(10, 1);
  });
});

describe("AnimationSystem clip fitting", () => {
  it("reports a clip's authored length, and null for one it does not have", () => {
    const system = systemWith([clip("cast", 1.4)]);
    expect(system.clipDuration("hero", "cast")).toBeCloseTo(1.4, 3);
    expect(system.clipDuration("hero", "nope")).toBeNull();
    expect(system.clipDuration("nobody", "cast")).toBeNull();
  });

  it("plays a layer at its own rate, and retunes it without restarting", () => {
    const { system, root } = layered();
    system.play("hero", "Run", 0);
    // half rate: a two-second cast clip stretched over four seconds
    system.playLayer("hero", "Cast", { fade: 0, loop: false, speed: 0.5 });
    expect(system.layerSpeedOf("hero")).toBeCloseTo(0.5, 3);
    for (let i = 0; i < 60; i++) system.update(1 / 60);
    // still the cast on the masked bones, just paid out more slowly
    expect(node(root, "upperarm_l").position.x).toBeCloseTo(10, 1);

    // re-asserted (net replication does this every snapshot) with a new rate:
    // the clip must slow down where it stands, not start over
    system.playLayer("hero", "Cast", { fade: 0, loop: false, speed: 0.25 });
    expect(system.layerSpeedOf("hero")).toBeCloseTo(0.25, 3);
    expect(system.layerClip("hero")).toBe("Cast");
  });

  it("the base rate is reported back, so a host can replicate it", () => {
    const system = systemWith([clip("run")]);
    system.play("hero", "run", 0);
    system.setSpeed("hero", 1.4);
    expect(system.speedOf("hero")).toBeCloseTo(1.4, 3);
  });

  it("restart replays a one-shot that has already clamped on its last frame", () => {
    const done: string[] = [];
    const system = systemWith([clip("cast")]);
    system.onClipFinished = (_id, name) => done.push(name);

    system.play("hero", "cast", 0, false);
    for (let i = 0; i < 70; i++) system.update(1 / 60);
    expect(done).toEqual(["cast"]);

    // the same clip again, with nothing else played in between: without
    // restart it is already "current" and the character holds the last pose
    system.play("hero", "cast", 0, false);
    system.play("hero", "cast", 0, false, true);
    for (let i = 0; i < 70; i++) system.update(1 / 60);
    expect(done).toEqual(["cast", "cast"]);
  });
});

describe("AnimationSystem gait changes", () => {
  function actionOf(system: AnimationSystem, name: string): THREE.AnimationAction {
    const entry = (system as unknown as { entries: Map<string, { actions: Map<string, THREE.AnimationAction> }> })
      .entries.get("hero")!;
    return entry.actions.get(name)!;
  }

  it("carries the stride's phase into the next cycle when asked to", () => {
    const system = systemWith([clip("walk", 1), clip("run", 2)]);
    system.play("hero", "walk", 0);
    for (let i = 0; i < 15; i++) system.update(1 / 60); // a quarter of the way through
    system.play("hero", "run", 0.25, true, false, true);
    // a quarter of a 2 s cycle, not frame 0 and not the walk's 0.25 s
    expect(actionOf(system, "run").time).toBeCloseTo(0.5, 2);
  });

  it("starts at the top without it", () => {
    const system = systemWith([clip("walk", 1), clip("run", 2)]);
    system.play("hero", "walk", 0);
    for (let i = 0; i < 15; i++) system.update(1 / 60);
    system.play("hero", "run", 0.25);
    expect(actionOf(system, "run").time).toBe(0);
  });

  it("leaves the outgoing clip at its own rate when the new rate is set after the play", () => {
    const system = systemWith([clip("walk", 1), clip("run", 2)]);
    system.play("hero", "walk", 0);
    system.setSpeed("hero", 2);
    system.play("hero", "run", 0.25, true, false, true);
    system.setSpeed("hero", 0.8);
    expect(actionOf(system, "walk").timeScale).toBe(2);
    expect(actionOf(system, "run").timeScale).toBe(0.8);
  });
});

/**
 * A pose that follows a CONTINUOUS quantity — how deep the water a character
 * is wading through is — needs two clips held at a weight, not a crossfade
 * that always finishes. These are the rules that makes that readable as one
 * gait rather than as two characters sharing a body.
 */
describe("AnimationSystem held blend", () => {
  /** Every action the mixer is actually running, with its weight. */
  function weights(system: AnimationSystem): Record<string, number> {
    const entry = (system as unknown as { entries: Map<string, { mixer: THREE.AnimationMixer; actions: Map<string, THREE.AnimationAction> }> })
      .entries.get("hero")!;
    const out: Record<string, number> = {};
    for (const [name, action] of entry.actions) {
      if (action.isRunning() && action.weight > 0.001) out[name] = +action.weight.toFixed(3);
    }
    return out;
  }

  it("holds both clips at complementary weights", () => {
    const system = systemWith([clip("walk"), clip("wade", 2)]);
    system.playBlend("hero", "walk", "wade", 0.25, 0);
    system.update(1 / 60);
    expect(weights(system)).toEqual({ walk: 0.75, wade: 0.25 });

    // …and follows the quantity, tick after tick, without restarting anything
    system.playBlend("hero", "walk", "wade", 0.8, 0);
    system.update(1 / 60);
    expect(weights(system)).toEqual({ walk: 0.2, wade: 0.8 });
  });

  it("phase-matches the two cycles, so the strides land together", () => {
    const system = systemWith([clip("walk"), clip("wade", 2)]); // 1s and 2s
    system.playBlend("hero", "walk", "wade", 0.5, 0);
    for (let i = 0; i < 20; i++) {
      system.update(1 / 60);
      system.playBlend("hero", "walk", "wade", 0.5, 0); // re-asserted every tick
    }
    const entry = (system as unknown as { entries: Map<string, { actions: Map<string, THREE.AnimationAction> }> })
      .entries.get("hero")!;
    const walk = entry.actions.get("walk")!;
    const wade = entry.actions.get("wade")!;
    // same phase, not the same time: a 2 s cycle is half way through when a
    // 1 s cycle is
    expect(wade.time / 2).toBeCloseTo(walk.time / 1, 3);
  });

  it("collapses to a plain play at either end, and a single clip ends it", () => {
    const system = systemWith([clip("walk"), clip("wade", 2)]);
    system.playBlend("hero", "walk", "wade", 1, 0);
    system.update(1 / 60);
    expect(weights(system)).toEqual({ wade: 1 });

    system.playBlend("hero", "walk", "wade", 0, 0);
    system.update(1 / 60);
    expect(weights(system)).toEqual({ walk: 1 });

    // a blend, then an ordinary play: the held half has to let go
    system.playBlend("hero", "walk", "wade", 0.5, 0);
    system.update(1 / 60);
    system.play("hero", "walk", 0);
    system.update(1 / 60);
    expect(weights(system)).toEqual({ walk: 1 });
  });

  it("declines under a masked action layer rather than guessing", () => {
    // A real rig this time: the layer needs a mask bone to be a LAYER at all,
    // and it is the masked case that cannot carry a blend underneath it (the
    // base's complement is built from one clip).
    const { system } = layered();
    system.playBlend("hero", "Run", "Cast", 0.9, 0);
    system.update(1 / 60);
    system.playLayer("hero", "Cast", { fade: 0 });
    system.update(1 / 60);
    expect(system.layerClip("hero")).toBe("Cast");

    // asked for a blend while the layer is up: the dominant clip takes it, and
    // the layer is still the layer
    system.playBlend("hero", "Run", "Cast", 0.9, 0);
    system.update(1 / 60);
    expect(system.layerClip("hero")).toBe("Cast");
    expect(system.currentClip("hero")).toBe("Cast"); // 0.9 → the wade half won
  });
});
