import { describe, expect, it } from "vitest";
import { createScene } from "@hitreg/core";
import { Object3D, Scene } from "three";
import { MOB_SLEEP, Script, ScriptRegistry, ScriptRuntime } from "../src/index.js";

/** A stand-in brain: counts its steps, keeps a roam clock that must survive a sleep, and walks +x. */
class Brain extends Script {
  static override scriptName = "mob-brain";
  steps = 0;
  dts: number[] = [];
  roamed = 0;
  override onFixedUpdate(dt: number) { this.steps++; this.dts.push(dt); this.roamed += dt; }
}
class Body extends Script {
  static override scriptName = "body-step";
  steps = 0;
  late = 0;
  override onFixedUpdate() { this.steps++; }
  override onLateUpdate() { this.late++; }
}
class Other extends Script {
  static override scriptName = "not-a-mob";
  steps = 0;
  override onFixedUpdate() { this.steps++; }
}

function world() {
  const registry = new ScriptRegistry();
  registry.register(Brain); registry.register(Body); registry.register(Other);
  const doc = createScene("t");
  doc.entities.mob = { name: "mob", parent: null, tags: [], components: { rigidbody: { kind: "dynamic" }, script: { name: "body-step", params: {} } } } as never;
  doc.entities.brain = { name: "brain", parent: "mob", tags: [], components: { script: { name: "mob-brain", params: {} } } } as never;
  doc.entities.lamp = { name: "lamp", parent: null, tags: [], components: { script: { name: "not-a-mob", params: {} } } } as never;
  const scene = new Scene();
  const objects = new Map<string, Object3D>();
  for (const id of ["mob", "brain", "lamp"]) objects.set(id, new Object3D());
  scene.add(objects.get("mob")!, objects.get("lamp")!);
  objects.get("mob")!.add(objects.get("brain")!);
  const linvel = new Map<string, [number, number, number]>([["mob", [3, -1, 2]]]);
  const sim = {
    getLinvel: (id: string) => linvel.get(id) ?? null,
    setLinvel: (id: string, v: [number, number, number]) => void linvel.set(id, v),
    applyImpulse: () => {},
  };
  const runtime = new ScriptRuntime({ doc, objects, sim: sim as never, input: { isDown: () => false }, registry });
  runtime.start();
  const script = <T,>(id: string) => (runtime as unknown as { instances: Map<string, T> }).instances.get(id)!;
  return { runtime, objects, linvel, brain: script<Brain>("brain"), mob: script<Body>("mob"), lamp: script<Other>("lamp") };
}

const at = (x: number): Array<[number, number]> => [[x, 0]];

describe("mob distance sleep (MobSleepRule)", () => {
  it("is off until the host names the players: every mob steps every tick", () => {
    const w = world();
    for (let i = 0; i < 6; i++) w.runtime.fixedUpdate(1 / 60);
    expect(w.brain.steps).toBe(6);
    expect(w.runtime.mobBand("brain")).toBeNull();
  });

  it("sleeps a mob farther than 160 m from every player (subtree included), stops it, and wakes it within one step", () => {
    const w = world();
    w.runtime.setPlayerFoci([[500, 0], [-400, 0]]);
    for (let i = 0; i < 6; i++) w.runtime.fixedUpdate(1 / 60);
    expect(w.brain.steps).toBe(0);
    expect(w.mob.steps).toBe(0);
    expect(w.lamp.steps).toBe(6); // not a mob: never gated
    expect(w.runtime.mobBand("brain")).toBe("asleep");
    expect(w.linvel.get("mob")).toEqual([0, -1, 0]); // stopped where it stands, still falls
    w.runtime.lateUpdate(1 / 60);
    expect(w.mob.late).toBe(0);
    // a player walks inside 80 m: the very next step runs at full rate
    w.runtime.setPlayerFoci(at(50));
    w.runtime.fixedUpdate(1 / 60);
    expect(w.brain.steps).toBe(1);
    expect(w.runtime.mobBand("mob")).toBe("full");
  });

  it("steps a mob 80-160 m away every third tick with the elapsed time", () => {
    const w = world();
    w.runtime.setPlayerFoci(at(120));
    for (let i = 0; i < 30; i++) w.runtime.fixedUpdate(1 / 60);
    expect(w.brain.steps).toBe(10);
    expect(w.brain.dts.every((dt) => Math.abs(dt - 3 / 60) < 1e-9)).toBe(true);
    expect(w.runtime.mobBand("brain")).toBe("mid");
    expect(MOB_SLEEP).toEqual({ near: 80, far: 160, midEvery: 3 });
  });

  it("resumes the brain's own state after a sleep (nothing restarted, no clock banked)", () => {
    const w = world();
    w.runtime.setPlayerFoci(at(10));
    for (let i = 0; i < 60; i++) w.runtime.fixedUpdate(1 / 60);
    const roamed = w.brain.roamed;
    const brain = w.brain;
    w.runtime.setPlayerFoci(at(1000));
    for (let i = 0; i < 600; i++) w.runtime.fixedUpdate(1 / 60);
    w.runtime.setPlayerFoci(at(10));
    w.runtime.fixedUpdate(1 / 60);
    const now = (w.runtime as unknown as { instances: Map<string, Brain> }).instances.get("brain");
    expect(now).toBe(brain); // the same instance: roam/leash state intact
    expect(brain.roamed).toBeCloseTo(roamed + 1 / 60, 9);
  });

  it("follows the body when it moves: a mob walking out of range falls asleep", () => {
    const w = world();
    w.runtime.setPlayerFoci(at(0));
    w.runtime.fixedUpdate(1 / 60);
    expect(w.runtime.mobBand("brain")).toBe("full");
    w.objects.get("mob")!.position.x = 200;
    w.runtime.fixedUpdate(1 / 60);
    expect(w.runtime.mobBand("brain")).toBe("asleep");
  });
});
