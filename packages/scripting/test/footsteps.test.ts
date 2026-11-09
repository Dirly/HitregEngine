import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents } from "@hitreg/core";
import { registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike, type SimLike, type RuntimeVfxFrame } from "../src/index.js";

const core = new ComponentRegistry();
registerCoreComponents(core);

const CLIPS = ["Idle", "Walk", "Run", "Sprint", "Jump_Loop", "Sword_Dash"];
const DURATION = 0.9; // every clip, for the stand-in playhead

/**
 * The controller with footsteps on, a stand-in animation host whose playhead
 * advances at whatever rate the controller sets, and a log of every sound.
 */
function harness(params: Record<string, unknown> = {}, opts: { phase?: boolean; dust?: boolean; raycast?: SimLike["raycast"]; object?: THREE.Object3D } = {}) {
  const held = new Set<string>(["KeyW"]);
  const input: InputLike = { isDown: (code) => held.has(code) };
  let velocity: [number, number, number] = [0, 0, 0];
  const sim: SimLike = {
    getLinvel: () => velocity,
    setLinvel: () => {},
    applyImpulse: () => {},
    ...(opts.raycast ? { raycast: opts.raycast } : {}),
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
            collider: { shape: "capsule", size: [0.8, 1.8, 0.8] },
            script: {
              name: "third-person-controller",
              params: {
                walkSpeed: 2,
                speed: 6,
                sprintSpeed: 10,
                footsteps: true,
                footstepSounds: { dirt: "step.mp3" },
                clipSpeeds: { Walk: 2, Run: 6, Sprint: 10 },
                clipFootfalls: { Walk: [0.48, 0.98], Run: [0, 0.5] },
                ...params,
              },
            },
          },
        },
      },
    ],
    core,
  ).doc;
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  let clip = "Idle";
  let playhead = 0;
  let rate = 1;
  const sounds: Array<{ id: string; volume: number; t: number }> = [];
  const puffs: Array<{ effect: unknown; frame: RuntimeVfxFrame; ground: number | null }> = [];
  let clock = 0;
  const runtime = new ScriptRuntime({
    doc,
    objects: new Map([["hero", opts.object ?? new THREE.Object3D()]]),
    sim,
    registry,
    input,
    viewForward: () => [0, -1],
    localPlayer: () => "hero",
    ...(opts.dust ? { vfx: {
      play: (effect: unknown, frame: RuntimeVfxFrame) => {
        // Resolve the ground query just as the particle module's ground anchor does.
        const [x, y, z] = frame.origin;
        puffs.push({ effect, frame, ground: frame.ground?.(x, z, y + 1) ?? null });
        return { done: false, stop: () => {} };
      },
      playSpell: () => { throw new Error("unexpected spell"); },
      stopAll: () => {},
    } } : {}),
    setAnimation: (_id, next) => {
      if (next !== clip) playhead = 0;
      clip = next;
    },
    animationClips: () => CLIPS,
    animationDuration: () => DURATION,
    ...(opts.phase === false ? {} : { animationPhase: () => ({ clip, t01: (playhead / DURATION) % 1 }) }),
    setAnimationSpeed: (_id, m) => {
      rate = m;
    },
    playSound: (_id, id, o) => {
      sounds.push({ id: id ?? "", volume: o?.volume ?? 1, t: clock });
    },
  });
  runtime.start();
  return {
    sounds,
    puffs,
    clip: () => clip,
    release: (code: string) => held.delete(code),
    /** Hold a velocity for `ticks` fixed steps, advancing the playhead at the controller's rate. */
    run: (v: [number, number, number], ticks: number) => {
      for (let i = 0; i < ticks; i++) {
        velocity = [...v] as [number, number, number];
        runtime.fixedUpdate(1 / 60);
        clock += 1 / 60;
        playhead += rate / 60;
      }
    },
  };
}

describe("third-person-controller footsteps", () => {
  it("grounds dust on the floor rather than the player's capsule crown", () => {
    const object = new THREE.Object3D();
    object.position.y = 0.9;
    const h = harness({ groundProbe: 0 }, { dust: true, object, raycast: (from, _dir, _reach, opts) => {
      const floor = opts?.exclude?.includes("hero");
      const y = floor ? 0 : 1.8;
      return { entityId: floor ? "floor" : "hero", point: [from[0], y, from[2]], normal: [0, 1, 0], distance: from[1] - y };
    } });
    h.run([0, 0, -6], 120);
    expect(h.puffs.length).toBeGreaterThan(2);
    for (const puff of h.puffs) {
      expect(puff.ground).toBe(0);
      expect(puff.frame.caster).toBe(object);
      expect(puff.frame.origin[1]).toBeCloseTo(0);
    }
    const before = h.puffs.length;
    h.run([0, -8, -6], 60);
    expect(h.puffs.length).toBe(before);
  });

  it("falls back to world-space feet with a translated parent and scaled collider", () => {
    const parent = new THREE.Object3D();
    parent.position.set(10, 4, -3);
    parent.scale.setScalar(2);
    const object = new THREE.Object3D();
    object.position.set(1, 0.9, 2);
    parent.add(object);
    const h = harness({ groundProbe: 0 }, { dust: true, object, raycast: () => null });
    h.run([0, 0, -6], 120);
    expect(h.puffs.length).toBeGreaterThan(2);
    for (const puff of h.puffs) {
      expect(puff.ground).toBeNull();
      expect(puff.frame.origin[0]).toBeCloseTo(12);
      expect(puff.frame.origin[1]).toBeCloseTo(4);
      expect(puff.frame.origin[2]).toBeCloseTo(1);
    }
  });

  it("steps on the clip's own contacts: two per cycle, whatever the speed", () => {
    const h = harness();
    h.run([0, 0, -6], 60); // settle into the run
    const before = h.sounds.length;
    h.run([0, 0, -6], 120); // 2 s at rate 1 of a 0.9 s cycle = 2.2 cycles
    expect(h.clip()).toBe("Run");
    const steps = h.sounds.length - before;
    expect(steps).toBeGreaterThanOrEqual(4);
    expect(steps).toBeLessThanOrEqual(5);
  });

  it("ties the step rate to the clip's playback, not a fixed cadence", () => {
    // walking at 2 m/s on a clip authored at 1 m/s plays it at double rate —
    // the old distance counter gave the same 3.1 steps/s either way
    const slow = harness({ walkSpeed: 2 });
    slow.run([0, 0, -2], 60);
    const s0 = slow.sounds.length;
    slow.run([0, 0, -2], 180);
    const fast = harness({ clipSpeeds: { Walk: 1, Run: 6, Sprint: 10 } });
    fast.run([0, 0, -2], 60);
    const f0 = fast.sounds.length;
    fast.run([0, 0, -2], 180);
    expect(slow.clip()).toBe("Walk");
    expect(fast.sounds.length - f0).toBeGreaterThanOrEqual(2 * (slow.sounds.length - s0) - 1);
  });

  it("varies each step's volume by about ±12% and never exceeds footstepVolume", () => {
    const h = harness({ footstepVolume: 0.5 });
    h.run([0, 0, -6], 600);
    const vols = h.sounds.map((s) => s.volume);
    expect(vols.length).toBeGreaterThan(10);
    for (const v of vols) {
      expect(v).toBeLessThanOrEqual(0.5);
      expect(v).toBeGreaterThanOrEqual(0.5 * 0.88 * 0.88 - 1e-9);
    }
    expect(new Set(vols).size).toBeGreaterThan(1);
  });

  it("does not step while airborne", () => {
    const h = harness();
    h.run([0, 0, -6], 60);
    // off the ground from the first tick — the coyote window included, which
    // is a jump grace, not a foot on the floor
    const before = h.sounds.length;
    h.run([0, -8, -6], 60);
    expect(h.sounds.length).toBe(before);
  });

  it("sounds a landing only after a real fall", () => {
    const h = harness({ landSoundAir: 0.25 });
    h.release("KeyW");
    h.run([0, 0, 0], 30);
    // a curb: 0.15 s of falling, past coyote time but not a fall
    h.run([0, -8, 0], 9);
    const curb = h.sounds.length;
    h.run([0, 0, 0], 30);
    expect(h.sounds.length).toBe(curb);
    // a ledge: 0.5 s
    h.run([0, -8, 0], 30);
    const ledge = h.sounds.length;
    h.run([0, 0, 0], 10);
    expect(h.sounds.length).toBe(ledge + 1);
  });

  it("falls back to a distance cadence for a gait clip with no footfall data", () => {
    const h = harness({ clipFootfalls: {} });
    h.run([0, 0, -6], 120);
    expect(h.sounds.length).toBeGreaterThan(2);
  });

  it("falls back to the cadence on a host with no playhead", () => {
    const h = harness({}, { phase: false });
    h.run([0, 0, -6], 120);
    expect(h.sounds.length).toBeGreaterThan(2);
  });
});
