import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents } from "@hitreg/core";
import {
  advanceBetween,
  advanceVelocity,
  isClipAdvance,
  peakAdvanceSpeed,
  registerBuiltinScripts,
  sampleAdvance,
  ScriptRegistry,
  ScriptRuntime,
  type ClipAdvance,
  type InputLike,
  type SimLike,
} from "../src/index.js";

describe("clip advance curves", () => {
  const lunge: ClipAdvance = { d: 1, f: [0, 0.1, 0.4, 0.8, 1] };

  it("samples linearly between points and clamps at both ends", () => {
    expect(sampleAdvance(lunge.f, 0)).toBe(0);
    expect(sampleAdvance(lunge.f, 1)).toBe(1);
    expect(sampleAdvance(lunge.f, 1.5)).toBe(1);
    expect(sampleAdvance(lunge.f, -1)).toBe(0);
    expect(sampleAdvance(lunge.f, 0.375)).toBeCloseTo(0.25); // halfway between 0.1 and 0.4
  });

  it("a one-shot adds nothing past its last frame; a loop carries on round", () => {
    expect(advanceBetween(lunge.f, 0.25, 0.5, false)).toBeCloseTo(0.3);
    expect(advanceBetween(lunge.f, 0.9, 1.4, false)).toBeCloseTo(1 - sampleAdvance(lunge.f, 0.9));
    expect(advanceBetween(lunge.f, 1.2, 1.6, false)).toBe(0);
    // looped: 0.75 -> 2.25 is the tail, one whole loop, and the head
    const looped = advanceBetween(lunge.f, 0.75, 2.25, true);
    expect(looped).toBeCloseTo(1 - 0.8 + 1 + 0.1);
  });

  it("the velocity integrates back to the curve at any playback rate", () => {
    for (const rate of [0.5, 1, 1.7]) {
      const dt = 1 / 60;
      let x = 0;
      let z = 0;
      let clock = 0;
      for (let i = 0; i < 240; i++) {
        const [vx, vz] = advanceVelocity(lunge, { clock, dt, rate, duration: 1, loop: false, yaw: 0 });
        x += vx * dt;
        z += vz * dt;
        clock += dt * rate;
      }
      expect(x).toBeCloseTo(0, 6);
      expect(z).toBeCloseTo(1, 6); // yaw 0: the model's +Z is the world's +Z
    }
  });

  it("turns the model's forward and side into the world by yaw", () => {
    const step: ClipAdvance = { f: [0, 1], s: [0, 0.5] };
    // yaw 90°: model +Z -> world +X, model +X -> world -Z
    const [vx, vz] = advanceVelocity(step, { clock: 0, dt: 1, rate: 1, duration: 1, loop: false, yaw: Math.PI / 2 });
    expect(vx).toBeCloseTo(1);
    expect(vz).toBeCloseTo(-0.5);
    const scaled = advanceVelocity(step, { clock: 0, dt: 1, rate: 1, duration: 1, loop: false, yaw: 0, scale: 2 });
    expect(scaled[1]).toBeCloseTo(2);
  });

  it("rejects malformed entries and finds the table's peak speed", () => {
    expect(isClipAdvance(lunge)).toBe(true);
    expect(isClipAdvance({ f: [0] })).toBe(false);
    expect(isClipAdvance({ f: [0, "1"] })).toBe(false);
    expect(isClipAdvance({ f: [0, 1], s: [0] })).toBe(false);
    expect(isClipAdvance(null)).toBe(false);
    // steepest span: 0.1 -> 0.4 over 0.25 s
    expect(peakAdvanceSpeed({ Lunge: lunge, junk: 3 })).toBeCloseTo(1.6);
  });
});

const core = new ComponentRegistry();
registerCoreComponents(core);

const CLIPS = ["Idle", "Walk", "Run", "Sprint", "Jump_Loop", "Lunge", "Stride", "Cast"];
const LUNGE: ClipAdvance = { d: 1, f: [0, 0.1, 0.4, 0.8, 1] };

/** The controller on a stand-in sim that integrates the velocity it is handed. */
function harness(params: Record<string, unknown> = {}, ahead?: { z: number; kind: string; x?: number }) {
  const held = new Set<string>();
  const input: InputLike = { isDown: (code) => held.has(code) };
  let velocity: [number, number, number] = [0, 0, 0];
  const pos: [number, number, number] = [0, 0, 0];
  const sim: SimLike = {
    getLinvel: () => velocity,
    setLinvel: (_id, v) => {
      velocity = [v[0], 0, v[2]]; // flat ground: vertical is not this test's business
    },
    applyImpulse: () => {},
  };
  const doc = applyOps(
    createScene("t"),
    [
      {
        op: "add-entity",
        id: "hero",
        entity: {
          name: "Hero",
          parent: null,
          tags: ["player"],
          components: {
            transform: {},
            script: {
              name: "third-person-controller",
              params: { walkSpeed: 2, speed: 6, sprintSpeed: 10, clipAdvance: { Lunge: LUNGE, Stride: { d: 1, f: [0, 2.5] } }, ...params },
            },
          },
        },
      },
      {
        op: "add-entity",
        id: "ahead",
        entity: {
          name: "Ahead",
          parent: null,
          tags: [],
          components: { transform: {}, ...(ahead ? { rigidbody: { kind: ahead.kind } } : {}), collider: { shape: "capsule", size: [0.8, 1.8, 0.8] } },
        },
      },
    ],
    core,
  ).doc;
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  const object = new THREE.Object3D();
  // something standing on the +Z line at `ahead.z` (its collider 0.4 m round). Not in
  // the sim at all, as a server's creature is not in a net peer's physics.
  const other = new THREE.Object3D();
  other.position.set(ahead?.x ?? 0, 0, ahead?.z ?? 100);
  const runtime = new ScriptRuntime({
    doc,
    objects: new Map([["hero", object], ["ahead", other]]),
    sim,
    registry,
    input,
    viewForward: () => [0, 1],
    localPlayer: () => "hero",
    setAnimation: () => {},
    animationClips: () => CLIPS,
    animationDuration: () => 1,
    setAnimationLayer: () => {},
    clearAnimationLayer: () => {},
    setAnimationSpeed: () => {},
  });
  runtime.start();
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) {
      runtime.fixedUpdate(1 / 60);
      pos[0] += velocity[0] / 60;
      pos[2] += velocity[2] / 60;
      object.position.set(pos[0], 0, pos[2]);
    }
  };
  return {
    ud: object.userData as Record<string, unknown>,
    pos,
    held,
    now: () => runtime.now() / 1000,
    tick,
    setVelocity: (v: [number, number, number]) => {
      velocity = v;
    },
  };
}

describe("third-person-controller clip advance", () => {
  it("moves a standing body along its facing by the clip's travel", () => {
    const h = harness();
    h.tick(5);
    Object.assign(h.ud, { actionClip: "Lunge", actionUntil: h.now() + 1, actionFullBody: false });
    h.tick(75); // the whole window, and a little after
    expect(h.pos[2]).toBeGreaterThan(0.93); // one tick of lag at the start, none added at the end
    expect(h.pos[2]).toBeLessThan(1.02);
    expect(Math.abs(h.pos[0])).toBeLessThan(1e-6);
    expect(h.ud["advanceVel"]).toBeUndefined(); // cleared once the lunge is over
  });

  it("follows the fitted playback rate: a half-length window covers the ground in half the time", () => {
    const h = harness();
    h.tick(5);
    Object.assign(h.ud, { actionClip: "Lunge", actionUntil: h.now() + 0.5 });
    h.tick(20);
    const early = h.pos[2];
    h.tick(20);
    expect(early).toBeGreaterThan(0.3);
    expect(h.pos[2]).toBeGreaterThan(0.93);
    expect(h.pos[2]).toBeLessThan(1.02);
  });

  it("publishes the advance so the claimed velocity carries it to the authority", () => {
    const h = harness();
    h.tick(5);
    Object.assign(h.ud, { actionClip: "Lunge", actionUntil: h.now() + 1 });
    h.tick(30);
    const adv = h.ud["advanceVel"] as [number, number] | undefined;
    expect(adv).toBeDefined();
    expect(adv![1]).toBeGreaterThan(0.5);
  });

  it("does not advance a clip with no curve, a rooted body, a dash, or advanceScale 0", () => {
    const run = (setup: (h: ReturnType<typeof harness>) => void, params: Record<string, unknown> = {}) => {
      const h = harness(params);
      h.tick(5);
      setup(h);
      h.tick(60);
      return Math.hypot(h.pos[0], h.pos[2]);
    };
    expect(run((h) => Object.assign(h.ud, { actionClip: "Cast", actionUntil: h.now() + 1 }))).toBeLessThan(1e-6);
    expect(
      run((h) => Object.assign(h.ud, { actionClip: "Lunge", actionUntil: h.now() + 1, speedMult: 0 })),
    ).toBeLessThan(1e-6);
    expect(
      run((h) => Object.assign(h.ud, { actionClip: "Lunge", actionUntil: h.now() + 1 }), { advanceScale: 0 }),
    ).toBeLessThan(1e-6);
    // a dash owns horizontal velocity: its own, exactly, and no lunge on top
    const h = harness();
    h.tick(5);
    Object.assign(h.ud, {
      actionClip: "Lunge",
      actionUntil: h.now() + 1,
      actionFullBody: true,
      impulseVel: [3, 0],
      impulseUntil: h.now() + 0.5,
    });
    h.tick(28); // inside the impulse's half second
    expect(Math.abs(h.pos[2])).toBeLessThan(1e-6);
    expect(h.pos[0]).toBeCloseTo(3 * (28 / 60), 1);
  });

  it("chains: the next swing of a combo, started mid-lunge, is full-body and lunges too", () => {
    const h = harness();
    h.tick(5);
    // 2.5 m/s of lunge — well past the walk line (walkSpeed 2 -> 1 m/s)
    Object.assign(h.ud, { actionClip: "Stride", actionUntil: h.now() + 0.5 });
    h.tick(30);
    const z0 = h.pos[2];
    expect(z0).toBeGreaterThan(1);
    Object.assign(h.ud, { actionClip: "Lunge", actionUntil: h.now() + 1 });
    h.tick(62);
    // the whole of the second clip's travel: it was not laid on a layer
    expect(h.pos[2] - z0).toBeGreaterThan(0.93);
  });

  it("stops at a body in front instead of walking through it (advanceStop), physics or not, but not at static geometry", () => {
    const lunge = (ahead?: { z: number; kind: string; x?: number }, params: Record<string, unknown> = {}) => {
      const h = harness({ ...params }, ahead);
      h.tick(5);
      Object.assign(h.ud, { actionClip: "Stride", actionUntil: h.now() + 1 });
      h.tick(75);
      return h.pos[2];
    };
    expect(lunge()).toBeGreaterThan(2.3); // nothing there: the whole 2.5 m
    // a dummy 3 m ahead (0.4 m round): the hero (0.4 m) plants once it stands engaged with it,
    // a metre past the 0.5 m gap, 2.3 m centre to centre
    const stopped = lunge({ z: 3, kind: "dynamic" });
    expect(stopped).toBeGreaterThan(0.6);
    expect(stopped).toBeLessThan(0.85);
    expect(lunge({ z: 3, kind: "kinematic" })).toBeLessThan(0.85);
    // static geometry is physics' to stop, not this check's
    expect(lunge({ z: 3, kind: "static" })).toBeGreaterThan(2.3);
    expect(lunge({ z: 3, kind: "dynamic" }, { advanceStop: 0 })).toBeGreaterThan(2.3);
    // one standing off to the side of the swing's line is no stop
    expect(lunge({ z: 1.6, kind: "dynamic", x: 2 } as { z: number; kind: string })).toBeGreaterThan(2.3);
  });

  it("gives an upper-body layer over a run no advance — the legs are running", () => {
    const h = harness();
    h.held.add("KeyW");
    h.setVelocity([0, 0, 6]);
    h.tick(30);
    const z0 = h.pos[2];
    Object.assign(h.ud, { actionClip: "Lunge", actionUntil: h.now() + 1 });
    h.tick(60);
    // exactly the gait's 6 m/s for the second — nothing added
    expect(h.pos[2] - z0).toBeCloseTo(6, 1);
  });
});
