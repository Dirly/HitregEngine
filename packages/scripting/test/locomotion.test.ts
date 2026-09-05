import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "@hitreg/core";
import {
  registerBuiltinScripts,
  ScriptRegistry,
  ScriptRuntime,
  type InputLike,
  type SimLike,
} from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

function scene(ops: Op[]): SceneDoc {
  return applyOps(createScene("t"), ops, coreRegistry).doc;
}

function registry(): ScriptRegistry {
  const r = new ScriptRegistry();
  registerBuiltinScripts(r);
  return r;
}

/** Keys the test holds down, and the velocity the "sim" reports back. */
function harness(opts: {
  params?: Record<string, unknown>;
  clips?: string[];
  keys?: string[];
}) {
  const held = new Set(opts.keys ?? []);
  const input: InputLike = { isDown: (code) => held.has(code) };

  let velocity: [number, number, number] = [0, 0, 0];
  const sim: SimLike = {
    getLinvel: () => velocity,
    setLinvel: (_id, v) => {
      velocity = [...v] as [number, number, number];
    },
    applyImpulse: () => {},
  };

  const doc = scene([
    {
      op: "add-entity",
      id: "hero",
      entity: {
        name: "Hero",
        parent: null,
        tags: ["player"],
        components: {
          transform: {},
          script: { name: "third-person-controller", params: opts.params ?? {} },
        },
      },
    },
  ]);

  const played: Array<{ clip: string; fade: number }> = [];
  const rates: number[] = [];
  // The mixer's own timeScale, which starts authored (1) and only moves when
  // the controller says so — it deliberately stays quiet for a no-op change,
  // so "never called" and "called with 1" have to read the same here.
  let effectiveRate = 1;
  const obj = new THREE.Object3D();
  const runtime = new ScriptRuntime({
    doc,
    objects: new Map([["hero", obj]]),
    sim,
    registry: registry(),
    input,
    viewForward: () => [0, -1],
    setAnimation: (_id, clip, fade) => played.push({ clip, fade: fade ?? 0 }),
    ...(opts.clips ? { animationClips: () => opts.clips! } : {}),
    setAnimationSpeed: (_id, multiplier) => {
      rates.push(multiplier);
      effectiveRate = multiplier;
    },
  });
  runtime.start();

  return {
    runtime,
    played,
    rates,
    hold: (code: string) => held.add(code),
    release: (code: string) => held.delete(code),
    /** Force the velocity the controller reads back this tick. */
    setVelocity: (v: [number, number, number]) => {
      velocity = v;
    },
    velocity: () => velocity,
    step: (ticks = 1) => {
      for (let i = 0; i < ticks; i++) runtime.fixedUpdate(1 / 60);
    },
    lastClip: () => played[played.length - 1]?.clip,
    rate: () => effectiveRate,
    yaw: () => obj.rotation.y,
  };
}

const ALL_CLIPS = ["Idle", "Walk", "Run", "Sprint", "Jump_Loop", "Run_Bwd", "Run_Left", "Run_Right"];

describe("third-person-controller gait ladder", () => {
  it("picks idle, walk, run and sprint from measured speed, not from the key held", () => {
    const h = harness({ clips: ALL_CLIPS, params: { walkSpeed: 2, speed: 6, sprintSpeed: 10 } });

    // standing still
    h.setVelocity([0, 0, 0]);
    h.step();
    expect(h.lastClip()).toBe("Idle");

    // the same key (W) at each of the three speeds the sim reports back
    h.hold("KeyW");
    h.setVelocity([0, 0, -2]);
    h.step();
    expect(h.lastClip()).toBe("Walk");

    h.setVelocity([0, 0, -6]);
    h.step();
    expect(h.lastClip()).toBe("Run");

    h.setVelocity([0, 0, -10]);
    h.step();
    expect(h.lastClip()).toBe("Sprint");
  });

  it("drives the requested speed from the walk and sprint modifiers", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, sprintKey: "ShiftLeft", walkKey: "AltLeft" },
    });
    h.hold("KeyW");

    h.step();
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(6, 3);

    h.hold("AltLeft");
    h.step();
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(2, 3);

    h.release("AltLeft");
    h.hold("ShiftLeft");
    h.step();
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(10, 3);
  });

  it("falls back to the run clip on a model that shipped without walk or sprint", () => {
    const h = harness({
      clips: ["Idle", "Run"], // a two-clip model, as before this ladder existed
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10 },
    });
    h.hold("KeyW");

    h.setVelocity([0, 0, -2]);
    h.step();
    expect(h.lastClip()).toBe("Run");

    h.setVelocity([0, 0, -10]);
    h.step();
    expect(h.lastClip()).toBe("Run");
  });

  it("scales playback to the ground covered so the feet stay planted", () => {
    const h = harness({ clips: ALL_CLIPS, params: { walkSpeed: 2, speed: 6, sprintSpeed: 10 } });
    h.hold("KeyW");

    // exactly the clip's authored speed → authored rate
    h.setVelocity([0, 0, -6]);
    h.step();
    expect(h.rate()).toBeCloseTo(1, 2);

    // dragged below the run clip's authored speed, but still above the
    // walk/run threshold (4) → run cycle, slowed to match the ground
    h.setVelocity([0, 0, -4.8]);
    h.step();
    expect(h.lastClip()).toBe("Run");
    expect(h.rate()).toBeCloseTo(0.8, 2);

    // crawling: half the walk clip's authored speed would be 0.5, but the
    // rate is clamped so a slowed character never reads as slow motion
    h.setVelocity([0, 0, -1]);
    h.step();
    expect(h.lastClip()).toBe("Walk");
    expect(h.rate()).toBeCloseTo(0.6, 2);
  });

  it("leaves playback alone when syncClipSpeed is off", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, syncClipSpeed: false },
    });
    h.hold("KeyW");
    h.setVelocity([0, 0, -4]);
    h.step();
    expect(h.rate()).toBe(1);
  });

  it("plays the air clip while off the ground", () => {
    const h = harness({ clips: ALL_CLIPS, params: { walkSpeed: 2, speed: 6, sprintSpeed: 10 } });
    h.hold("KeyW");
    // Sustained, not a single frame: one tick of upward velocity is exactly the
    // contact jitter a resting body produces, and treating that as airborne is
    // the bug that pinned the character in a falling pose.
    for (let i = 0; i < 12; i++) {
      h.setVelocity([0, 4, -6]);
      h.step();
    }
    expect(h.lastClip()).toBe("Jump_Loop");
  });

  it("plays a clip at the speed it was AUTHORED at, not at the gait's tuning", () => {
    // the case that reads as gliding: a 1 m/s walk cycle driven at 1.5 m/s
    const h = harness({
      clips: ALL_CLIPS,
      params: {
        walkSpeed: 1.5,
        speed: 6,
        sprintSpeed: 10,
        clipSpeeds: { Walk: 1.0, Run: 6.0 },
      },
    });
    h.hold("KeyW");

    h.setVelocity([0, 0, -1.5]);
    h.step();
    expect(h.lastClip()).toBe("Walk");
    expect(h.rate()).toBeCloseTo(1.5, 2); // 1.5 travelled / 1.0 authored

    h.setVelocity([0, 0, -6]);
    h.step();
    expect(h.lastClip()).toBe("Run");
    expect(h.rate()).toBeCloseTo(1, 2);
  });

  it("backs up facing forward instead of spinning round, and uses the back clip", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, face: "movement", sideSpeedMult: 0.5 },
    });
    // camera looks along -Z, so S drives the character toward +Z
    h.hold("KeyS");
    h.step();
    const back = Math.hypot(h.velocity()[0], h.velocity()[2]);
    expect(back).toBeCloseTo(3, 3); // 6 * 0.5
    expect(h.velocity()[2]).toBeGreaterThan(0); // travelling backwards

    h.setVelocity([0, 0, 3]);
    h.step(90); // let the turn settle
    expect(h.lastClip()).toBe("Run_Bwd");
    // kept facing the camera's forward (-Z, i.e. yaw pi) rather than turning
    // round to face the +Z it is travelling toward
    expect(Math.abs(h.yaw())).toBeCloseTo(Math.PI, 1);
  });

  it("turns to face travel when backpedal is off", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, face: "movement", backpedal: false },
    });
    h.hold("KeyS");
    h.step(90); // let the turn settle
    // spun round to face the +Z it is travelling toward, which is yaw 0
    expect(Math.abs(h.yaw())).toBeLessThan(0.1);
    expect(h.lastClip()).toBe("Run");
  });

  it("strafes with the side clips when the character faces the camera", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, face: "camera" },
    });
    h.hold("KeyD");
    h.step(60); // settle the facing on the camera aim
    h.setVelocity([5, 0, 0]);
    h.step();
    // facing the camera's forward (-Z), travel toward +X is the character's RIGHT
    expect(h.lastClip()).toBe("Run_Right");
  });

  it("keeps the pre-ladder two-clip behaviour when the host publishes no clip list", () => {
    // no animationClips hook at all — the old hosts, and the old defaults
    const h = harness({ params: { walkSpeed: 2, speed: 6, sprintSpeed: 10 } });
    h.hold("KeyW");
    h.setVelocity([0, 0, -6]);
    h.step();
    expect(h.lastClip()).toBe("Run");
  });
});

describe("grounded detection", () => {
  /**
   * The regression this exists to prevent: a resting dynamic body never has a
   * vertical velocity of exactly zero — gravity moves it ~0.16 m/s in one 60Hz
   * tick — so a tight |vy| test reads airborne almost every frame and pins the
   * character in a falling pose while it slides along the ground.
   */
  it("stays grounded through the vertical jitter of resting on a surface", () => {
    const h = harness({ clips: ALL_CLIPS, params: { walkSpeed: 2, speed: 6, sprintSpeed: 10 } });
    h.hold("KeyW");
    for (let i = 0; i < 40; i++) {
      // alternating settle/contact jitter, well inside what Rapier reports
      h.setVelocity([0, i % 2 ? -0.4 : 0.05, -6]);
      h.step();
    }
    expect(h.lastClip()).toBe("Run");
  });

  it("still goes airborne for a real fall", () => {
    const h = harness({ clips: ALL_CLIPS, params: { walkSpeed: 2, speed: 6, sprintSpeed: 10 } });
    h.hold("KeyW");
    for (let i = 0; i < 30; i++) {
      h.setVelocity([0, -8, -6]); // unambiguously dropping
      h.step();
    }
    expect(h.lastClip()).toBe("Jump_Loop");
  });

  it("walking down a slope is not falling", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, fallSpeed: 2 },
    });
    h.hold("KeyW");
    for (let i = 0; i < 40; i++) {
      h.setVelocity([0, -1.5, -6]); // descending, but under fallSpeed
      h.step();
    }
    expect(h.lastClip()).toBe("Run");
  });
});

describe("auto-run", () => {
  it("latches forward on the key's press edge, not once per held tick", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, autoRunKey: "NumLock" },
    });
    h.step();
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(0, 3);

    h.hold("NumLock");
    h.step(10); // held for ten ticks: must toggle ONCE, not ten times
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(6, 3);
    h.release("NumLock");
    h.step(5);
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(6, 3);
  });

  it("is cancelled by asking to go backwards", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, autoRunKey: "NumLock" },
    });
    h.hold("NumLock");
    h.step();
    h.release("NumLock");
    h.step();
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(6, 3);

    h.hold("KeyS");
    h.step();
    h.release("KeyS");
    h.step(3);
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(0, 3);
  });
});
