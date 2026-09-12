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
  /** Authored clip lengths, so the controller can FIT an action to its window. */
  durations?: Record<string, number>;
  /** What a downward ground ray finds: distance below the body, and the normal. */
  ground?: { distance: number; normal?: [number, number, number] } | null;
}) {
  const held = new Set(opts.keys ?? []);
  const input: InputLike = { isDown: (code) => held.has(code) };

  let velocity: [number, number, number] = [0, 0, 0];
  let ground = opts.ground ?? null;
  const sim: SimLike = {
    getLinvel: () => velocity,
    setLinvel: (_id, v) => {
      velocity = [...v] as [number, number, number];
    },
    applyImpulse: () => {},
    ...(opts.ground !== undefined
      ? {
          raycast: (origin: [number, number, number]) =>
            ground
              ? {
                  entityId: "ground",
                  point: [origin[0], origin[1] - ground.distance, origin[2]] as [number, number, number],
                  normal: (ground.normal ?? [0, 1, 0]) as [number, number, number],
                  distance: ground.distance,
                }
              : null,
        }
      : {}),
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

  const played: Array<{ clip: string; fade: number; loop: boolean; restart: boolean }> = [];
  /** Layer calls in order; null is a clear. */
  const layers: Array<string | null> = [];
  /** Options each layer call carried (fade, loop, speed). */
  const layerOpts: Array<Record<string, unknown>> = [];
  const rates: number[] = [];
  // The mixer's own timeScale, which starts authored (1) and only moves when
  // the controller says so — it deliberately stays quiet for a no-op change,
  // so "never called" and "called with 1" have to read the same here.
  let effectiveRate = 1;
  const obj = new THREE.Object3D();
  let clock = 0;
  let view: [number, number] = [0, -1];
  const runtime = new ScriptRuntime({
    doc,
    objects: new Map([["hero", obj]]),
    sim,
    registry: registry(),
    input,
    viewForward: () => view,
    setAnimation: (_id, clip, fade, o) =>
      played.push({ clip, fade: fade ?? 0, loop: o?.loop ?? true, restart: o?.restart ?? false }),
    ...(opts.clips ? { animationClips: () => opts.clips! } : {}),
    ...(opts.durations ? { animationDuration: (_id, clip) => opts.durations![clip] ?? null } : {}),
    setAnimationSpeed: (_id, multiplier) => {
      rates.push(multiplier);
      effectiveRate = multiplier;
    },
    setAnimationLayer: (_id, clip, o) => {
      layers.push(clip);
      layerOpts.push({ ...(o ?? {}) });
    },
    clearAnimationLayer: () => layers.push(null),
  });
  runtime.start();

  return {
    runtime,
    played,
    rates,
    layers,
    layerOpts,
    /** Move the ground the ray finds (a step down, a slope, a cliff edge). */
    setGround: (g: { distance: number; normal?: [number, number, number] } | null) => {
      ground = g;
    },
    /** The controller's runtime channels — actionClip, frozen, impulseVel … */
    ud: obj.userData as Record<string, unknown>,
    lastLayer: () => layers[layers.length - 1],
    lastLayerOpts: () => layerOpts[layerOpts.length - 1],
    lastPlayed: () => played[played.length - 1],
    object: obj,
    hold: (code: string) => held.add(code),
    release: (code: string) => held.delete(code),
    /** Force the velocity the controller reads back this tick. */
    setVelocity: (v: [number, number, number]) => {
      velocity = v;
    },
    velocity: () => velocity,
    /** Simulated seconds elapsed — what the controller reads as ctx.now(). */
    now: () => clock,
    /** Swing the camera, which is what a character in camera-facing mode follows. */
    setView: (v: [number, number]) => {
      view = v;
    },
    step: (ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        runtime.fixedUpdate(1 / 60);
        clock += 1 / 60;
      }
    },
    /**
     * Hold a measured velocity across several ticks. The controller writes the
     * velocity it wants back every tick, so a single setVelocity only survives
     * one of them — anything about sustained motion has to re-assert it.
     */
    stepAt: (v: [number, number, number], ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        velocity = [...v] as [number, number, number];
        runtime.fixedUpdate(1 / 60);
        clock += 1 / 60;
      }
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
    // rate is clamped so a slowed character never reads as slow motion.
    // Dropping a tier is a REVERSAL, so it waits out the dwell window first —
    // see "holds a gait through a reversal" below.
    h.stepAt([0, 0, -1], 20);
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

describe("third-person-controller action clips", () => {
  const moving = { clips: ALL_CLIPS, params: { walkSpeed: 2, speed: 6, sprintSpeed: 10 } };

  it("layers a cast over the gait while the character is moving", () => {
    const h = harness(moving);
    h.hold("KeyW");
    h.setVelocity([0, 0, -6]);
    h.step();
    expect(h.lastClip()).toBe("Run");

    h.ud["actionClip"] = "Cast";
    h.ud["actionUntil"] = 99;
    h.setVelocity([0, 0, -6]);
    h.step();

    expect(h.lastLayer()).toBe("Cast");
    // the legs are still the controller's: the gait never became the cast
    expect(h.played.some((p) => p.clip === "Cast")).toBe(false);
    expect(h.lastClip()).toBe("Run");
  });

  it("gives a standing cast the whole body, and clears the layer when it ends", () => {
    const h = harness(moving);
    h.setVelocity([0, 0, 0]);
    h.step();

    h.ud["actionClip"] = "Cast";
    h.ud["actionUntil"] = 99;
    h.setVelocity([0, 0, 0]);
    h.step();
    expect(h.lastClip()).toBe("Cast");
    expect(h.layers.filter((l) => l !== null)).toEqual([]); // onStart clears once

    // now the same action while running: layered, then cleared on expiry
    h.hold("KeyW");
    h.ud["actionClip"] = "Slash";
    h.setVelocity([0, 0, -6]);
    h.step();
    expect(h.lastLayer()).toBe("Slash");

    h.ud["actionClip"] = undefined;
    h.setVelocity([0, 0, -6]);
    h.step();
    expect(h.lastLayer()).toBeNull();
    expect(h.lastClip()).toBe("Run");
  });

  it("honours actionFullBody — a dodge roll is not an upper-body affair", () => {
    const h = harness(moving);
    h.hold("KeyW");
    h.ud["actionClip"] = "Dodge";
    h.ud["actionUntil"] = 99;
    h.ud["actionFullBody"] = true;
    h.setVelocity([0, 0, -6]);
    h.step();

    expect(h.layers.filter((l) => l !== null)).toEqual([]); // onStart clears once
    expect(h.lastClip()).toBe("Dodge");
  });

  it("actionBlend: full keeps the pre-layer behaviour", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, actionBlend: "full" },
    });
    h.hold("KeyW");
    h.ud["actionClip"] = "Cast";
    h.ud["actionUntil"] = 99;
    h.setVelocity([0, 0, -6]);
    h.step();

    expect(h.layers.filter((l) => l !== null)).toEqual([]); // onStart clears once
    expect(h.lastClip()).toBe("Cast");
  });

  it("actionBlend: layer keeps the legs even standing still", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, actionBlend: "layer" },
    });
    h.ud["actionClip"] = "Cast";
    h.ud["actionUntil"] = 99;
    h.setVelocity([0, 0, 0]);
    h.step();

    expect(h.lastLayer()).toBe("Cast");
    expect(h.lastClip()).toBe("Idle");
  });
});

describe("slopes", () => {
  const params = { walkSpeed: 2, speed: 6, sprintSpeed: 10 };

  it("running downhill is not falling, however fast the ground drops away", () => {
    // 6 m/s down a 30° slope descends at 3.5 m/s with both feet on the
    // ground — well past any fixed fallSpeed, which is why the threshold
    // scales with travel speed instead of sitting still.
    const h = harness({ clips: ALL_CLIPS, params });
    h.hold("KeyW");
    h.stepAt([0, -3.5, -6], 40);
    expect(h.lastClip()).toBe("Run");
  });

  it("takes the ground's word for it when a ray is available", () => {
    const h = harness({ clips: ALL_CLIPS, params, ground: { distance: 1 } });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 10); // calibrates the resting distance

    // a drop steep enough that velocity alone would call it a fall — but the
    // ray still finds ground right under the feet, so it is a slope
    h.setGround({ distance: 1.1 });
    h.stepAt([0, -9, -6], 40);
    expect(h.lastClip()).toBe("Run");

    // and off a ledge, where velocity alone would call it a slope
    h.setGround({ distance: 3.5 });
    h.stepAt([0, -4, -6], 40);
    expect(h.lastClip()).toBe("Jump_Loop");
  });

  it("leans the body onto the ground, capped", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { ...params, slopeAlign: 1, slopeAlignMax: 25 },
      ground: { distance: 1, normal: [0, Math.SQRT1_2, Math.SQRT1_2] }, // 45°
    });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 60);

    // 45° of ground, leaned all the way, still stops at the 25° ceiling
    expect(h.object.rotation.x).toBeCloseTo(-(25 * Math.PI) / 180, 2);
    // the slope runs fore-and-aft relative to the facing, so nothing rolls
    expect(h.object.rotation.z).toBeCloseTo(0, 3);
  });

  it("stands upright on flat ground", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { ...params, slopeAlign: 1 },
      ground: { distance: 1 },
    });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 60);
    expect(h.object.rotation.x).toBeCloseTo(0, 3);
    expect(h.object.rotation.z).toBeCloseTo(0, 3);
  });
});

describe("gait stability", () => {
  const params = { walkSpeed: 2, speed: 6, sprintSpeed: 10 };

  it("holds a gait through a reversal, so a body near a threshold does not flicker", () => {
    const h = harness({ clips: ALL_CLIPS, params });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 10);
    const from = h.played.length;

    // hovering either side of the walk/run boundary (4 m/s), a fifth of a
    // second either way — the shape of running along a hillside
    for (let i = 0; i < 12; i++) h.stepAt([0, 0, i % 2 ? -3.9 : -4.2], 2);
    expect(h.played.length - from).toBeLessThanOrEqual(1);
  });

  it("still speeds up immediately — only reversals wait", () => {
    const h = harness({ clips: ALL_CLIPS, params });
    h.hold("KeyW");
    h.stepAt([0, 0, -2], 1);
    expect(h.lastClip()).toBe("Walk");
    h.stepAt([0, 0, -6], 1);
    expect(h.lastClip()).toBe("Run");
    h.stepAt([0, 0, -10], 1);
    expect(h.lastClip()).toBe("Sprint");
  });
});

describe("action clips fit their window", () => {
  const params = { walkSpeed: 2, speed: 6, sprintSpeed: 10 };

  it("slows a layered cast to fill its cast time instead of repeating it", () => {
    const h = harness({
      clips: [...ALL_CLIPS, "Cast"],
      params,
      durations: { Cast: 1.2 },
    });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 1);

    h.ud["actionClip"] = "Cast";
    h.ud["actionUntil"] = h.now() + 3; // a three-second cast
    h.stepAt([0, 0, -6], 1);

    expect(h.lastLayer()).toBe("Cast");
    expect(h.lastLayerOpts()!["loop"]).toBe(false);
    expect(h.lastLayerOpts()!["speed"] as number).toBeCloseTo(1.2 / 3, 2);
  });

  it("slows a standing cast the same way, and replays it on a second press", () => {
    const h = harness({ clips: [...ALL_CLIPS, "Cast"], params, durations: { Cast: 1 } });
    h.stepAt([0, 0, 0], 1);

    const until = (): number => h.now() + 2;
    h.ud["actionClip"] = "Cast";
    h.ud["actionUntil"] = until();
    h.stepAt([0, 0, 0], 1);
    expect(h.lastClip()).toBe("Cast");
    expect(h.lastPlayed()!.loop).toBe(false);
    expect(h.rate()).toBeCloseTo(0.5, 2);

    // the action lapses, then the SAME clip is asked for again: it has to be
    // restarted, or it holds the clamped last frame of the first cast
    h.ud["actionClip"] = undefined;
    h.stepAt([0, 0, 0], 2);
    h.ud["actionClip"] = "Cast";
    h.ud["actionUntil"] = until();
    h.stepAt([0, 0, 0], 1);
    expect(h.lastClip()).toBe("Cast");
    expect(h.lastPlayed()!.restart).toBe(true);
  });

  it("loops a channel too long for even the slowest playback", () => {
    const h = harness({ clips: [...ALL_CLIPS, "Channel"], params, durations: { Channel: 1 } });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 1);

    h.ud["actionClip"] = "Channel";
    h.ud["actionUntil"] = h.now() + 20;
    h.stepAt([0, 0, -6], 1);
    expect(h.lastLayerOpts()!["loop"]).toBe(true);
    expect(h.lastLayerOpts()!["speed"] as number).toBeCloseTo(0.35, 2);
  });

  it("keeps looping when nobody can say how long the clip is", () => {
    const h = harness({ clips: [...ALL_CLIPS, "Cast"], params });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 1);
    h.ud["actionClip"] = "Cast";
    h.ud["actionUntil"] = h.now() + 3;
    h.stepAt([0, 0, -6], 1);
    expect(h.lastLayerOpts()!["loop"]).toBe(true);
    expect(h.lastLayerOpts()!["speed"]).toBe(1);
  });
});

describe("jumps and landings", () => {
  const params = { walkSpeed: 2, speed: 6, sprintSpeed: 10, jump: 8 };
  const clips = [...ALL_CLIPS, "Jump_Start", "Jump_Land"];
  const durations = { Jump_Start: 0.4, Jump_Land: 0.3 };

  it("pushes off, then loops the air clip, then absorbs the landing", () => {
    const h = harness({ clips, params, durations });
    h.stepAt([0, 0, 0], 5);
    expect(h.lastClip()).toBe("Idle");

    h.hold("Space");
    // the jump is taken on one tick and read on the next: the clip is picked
    // from the velocity the sim reports back, which is the point of the ladder
    h.step(2);
    expect(h.lastClip()).toBe("Jump_Start");
    expect(h.lastPlayed()!.loop).toBe(false); // a push-off happens once
    h.release("Space");

    h.stepAt([0, 4, 0], 30); // half a second in the air
    expect(h.lastClip()).toBe("Jump_Loop");
    expect(h.lastPlayed()!.loop).toBe(true);

    h.stepAt([0, 0, 0], 1); // touchdown
    expect(h.lastClip()).toBe("Jump_Land");
    h.stepAt([0, 0, 0], 30);
    expect(h.lastClip()).toBe("Idle");
  });

  it("does not stop to absorb a hop, or a landing taken at a run", () => {
    const h = harness({ clips, params, durations });
    h.hold("KeyW");
    h.stepAt([0, 3, -6], 10); // a short hop
    h.stepAt([0, 0, -6], 5);
    expect(h.lastClip()).toBe("Run");

    h.stepAt([0, 4, -6], 40); // a real drop, but landed at a run
    h.stepAt([0, 0, -6], 5);
    expect(h.lastClip()).toBe("Run");
  });

  it("keeps looping the air clip on a model with no push-off clip", () => {
    const h = harness({ clips: ALL_CLIPS, params });
    h.hold("Space");
    h.step(2);
    h.release("Space");
    expect(h.lastClip()).toBe("Jump_Loop");
    expect(h.lastPlayed()!.loop).toBe(true);
  });
});

describe("turning on the spot", () => {
  const params = { walkSpeed: 2, speed: 6, sprintSpeed: 10, face: "camera" };
  const clips = [...ALL_CLIPS, "Turn_L", "Turn_R"];

  it("plays a turn clip while the camera swings a standing character round", () => {
    const h = harness({ clips, params });
    // settle first: a character spawned facing away from the camera pivots to
    // it, and that pivot is itself a turn
    h.stepAt([0, 0, 0], 60);
    expect(h.lastClip()).toBe("Idle");

    h.setView([0.6, -0.8]); // camera swung right
    h.stepAt([0, 0, 0], 2);
    expect(h.lastClip()).toBe("Turn_R");

    // and back to idle once the pivot stops
    h.stepAt([0, 0, 0], 30);
    expect(h.lastClip()).toBe("Idle");

    h.setView([-0.6, -0.8]);
    h.stepAt([0, 0, 0], 2);
    expect(h.lastClip()).toBe("Turn_L");
  });

  it("leaves a model without turn clips on its idle", () => {
    const h = harness({ clips: ALL_CLIPS, params });
    h.stepAt([0, 0, 0], 60);
    h.setView([0.6, -0.8]);
    h.stepAt([0, 0, 0], 2);
    expect(h.lastClip()).toBe("Idle");
  });
});

describe("a frozen body", () => {
  const params = { walkSpeed: 2, speed: 6, sprintSpeed: 10 };

  it("plays its death clip once, fitted, instead of looping it", () => {
    const h = harness({ clips: [...ALL_CLIPS, "Death"], params, durations: { Death: 2 } });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 5);

    h.ud["frozen"] = true;
    h.ud["actionClip"] = "Death";
    h.ud["actionUntil"] = h.now() + 4;
    h.stepAt([0, 0, 0], 1);

    expect(h.lastClip()).toBe("Death");
    expect(h.lastPlayed()!.loop).toBe(false);
    expect(h.rate()).toBeCloseTo(0.5, 2); // a 2s clip over a 4s window
  });

  it("still stops the legs", () => {
    const h = harness({ clips: ALL_CLIPS, params });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 5);
    h.ud["frozen"] = true;
    h.step(2);
    expect(Math.hypot(h.velocity()[0], h.velocity()[2])).toBeCloseTo(0, 3);
    expect(h.lastClip()).toBe("Idle");
  });
});

describe("following the ground", () => {
  const params = { walkSpeed: 2, speed: 6, sprintSpeed: 10, jump: 8 };
  // a plane descending 25° in the direction of travel (the camera looks -Z)
  const DOWN25: [number, number, number] = [0, Math.cos(0.4363), -Math.sin(0.4363)];

  it("rides a crest down instead of launching off it", () => {
    const h = harness({ clips: ALL_CLIPS, params, ground: { distance: 1 } });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 10); // flat: settles, and measures the resting distance
    expect(h.velocity()[1]).toBeCloseTo(0, 2);

    // the ground now falls away under the same run — the crest of a hill
    h.setGround({ distance: 1, normal: DOWN25 });
    h.stepAt([0, 0, -6], 5);
    // 6 m/s down a 25° slope descends at 2.80 m/s, and that is what it is told
    // to do rather than travelling straight on and falling
    expect(h.velocity()[1]).toBeCloseTo(-6 * Math.tan(0.4363), 1);
    expect(h.lastClip()).toBe("Run");
  });

  it("climbs one without being thrown off the top", () => {
    const up: [number, number, number] = [0, Math.cos(0.4363), Math.sin(0.4363)];
    const h = harness({ clips: ALL_CLIPS, params, ground: { distance: 1 } });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 10);
    h.setGround({ distance: 1, normal: up });
    h.stepAt([0, 0, -6], 5);
    expect(h.velocity()[1]).toBeCloseTo(6 * Math.tan(0.4363), 1); // rising with the hill

    // over the top: flat ground again, and the climb does NOT carry on upward
    h.setGround({ distance: 1 });
    h.step(4);
    expect(h.velocity()[1]).toBeCloseTo(0, 1);
    expect(h.lastClip()).toBe("Run"); // never read as airborne
  });

  it("leaves a jump alone", () => {
    const h = harness({ clips: ALL_CLIPS, params, ground: { distance: 1 } });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 10);
    h.hold("Space");
    h.step();
    expect(h.velocity()[1]).toBeCloseTo(8, 3); // the jump survives untouched
  });

  it("lets a real drop fall", () => {
    const h = harness({ clips: ALL_CLIPS, params, ground: { distance: 1 } });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 10);
    h.setGround({ distance: 3 }); // ran off a ledge: nothing within reach
    h.stepAt([0, -5, -6], 20);
    expect(h.velocity()[1]).toBeCloseTo(-5, 3); // gravity keeps it
    expect(h.lastClip()).toBe("Jump_Loop");
  });

  it("is off when groundStick is 0", () => {
    const h = harness({
      clips: ALL_CLIPS,
      params: { ...params, groundStick: 0 },
      ground: { distance: 1 },
    });
    h.hold("KeyW");
    h.stepAt([0, 0, -6], 10);
    h.setGround({ distance: 1, normal: DOWN25 });
    h.stepAt([0, 0, -6], 5);
    expect(h.velocity()[1]).toBeCloseTo(0, 3);
  });
});
