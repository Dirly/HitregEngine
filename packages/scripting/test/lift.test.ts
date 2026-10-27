import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, type Op } from "@hitreg/core";
import {
  isClockDrivenScript,
  liftCycle,
  liftProgress,
  registerBuiltinScripts,
  ScriptRegistry,
  ScriptRuntime,
  type SimLike,
} from "../src/index.js";

const core = new ComponentRegistry();
registerCoreComponents(core);

function deck(id: string, params: Record<string, unknown>, y = 30): Op[] {
  return [
    {
      op: "add-entity",
      id,
      entity: {
        name: id,
        parent: null,
        tags: [],
        components: {
          transform: { position: [0, y, 0] },
          rigidbody: { kind: "kinematic" },
          collider: { shape: "box", size: [3, 0.2, 3] },
          script: { name: "lift", params },
        },
      },
    },
    {
      op: "add-entity",
      id: `${id}/rope`,
      entity: { name: "rope", parent: id, tags: ["lift-rope"], components: { transform: { position: [0, 0.1, 0] } } },
    },
  ];
}

function run(ops: Op[], ids: string[]) {
  const doc = applyOps(createScene("lift"), ops, core).doc;
  const objects = new Map<string, THREE.Object3D>();
  const root = new THREE.Scene();
  for (const id of ids) {
    const o = new THREE.Object3D();
    o.name = id;
    o.position.set(0, 30, 0);
    const rope = new THREE.Object3D();
    rope.name = `${id}/rope`;
    rope.position.set(0, 0.1, 0);
    o.add(rope);
    root.add(o);
    objects.set(id, o);
    objects.set(`${id}/rope`, rope);
  }
  const targets = new Map<string, number>();
  const sim = {
    getLinvel: () => [0, 0, 0],
    setLinvel: () => undefined,
    applyImpulse: () => undefined,
    setKinematicTarget: (id: string, p: [number, number, number]) => {
      targets.set(id, p[1]);
      objects.get(id)!.position.set(p[0], p[1], p[2]); // what the physics readback does
    },
  } as unknown as SimLike;
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry);
  const runtime = new ScriptRuntime({ doc, objects, sim, registry, input: { isDown: () => false } });
  runtime.start();
  return { runtime, targets, objects, registry };
}

describe("lift", () => {
  it("cycles top → bottom → top on the clock with a dwell at each landing", () => {
    // 24 m at 3 m/s = 8 s a leg, 2 s dwell → 20 s cycle
    expect(liftCycle(24, 3, 2)).toBe(20);
    expect(liftProgress(1, 24, 3, 2, 0)).toBe(0); // waiting at the top
    expect(liftProgress(6, 24, 3, 2, 0)).toBeCloseTo(0.5); // halfway down
    expect(liftProgress(11, 24, 3, 2, 0)).toBe(1); // waiting at the bottom
    expect(liftProgress(16, 24, 3, 2, 0)).toBeCloseTo(0.5); // halfway up
    expect(liftProgress(1, 24, 3, 2, 10)).toBe(1); // half a cycle out: the other end
  });

  it("drives its kinematic deck by target from its authored spot (the top landing) down `drop` metres", () => {
    const { runtime, targets } = run(deck("a", { drop: 24, speed: 3, dwell: 2 }), ["a"]);
    for (let i = 0; i < 60 * 6; i++) runtime.fixedUpdate(1 / 60);
    expect(targets.get("a")).toBeCloseTo(30 - 12, 1);
    for (let i = 0; i < 60 * 5; i++) runtime.fixedUpdate(1 / 60);
    expect(targets.get("a")).toBeCloseTo(6, 1);
  });

  it("an inclined lift runs out along its facing while it drops, staying level", () => {
    // 24 down + 7 out = 25 m of line at 2.5 m/s = 10 s a leg
    const { runtime, objects } = run(deck("a", { drop: 24, run: 7, speed: 2.5, dwell: 0 }), ["a"]);
    for (let i = 0; i < 60 * 5; i++) runtime.fixedUpdate(1 / 60);
    const p = objects.get("a")!.position;
    expect(p.y).toBeCloseTo(18, 1);
    expect(p.z).toBeCloseTo(3.5, 1);
    expect(p.x).toBeCloseTo(0, 5);
  });

  it("two lifts half a cycle apart alternate", () => {
    const ops = [...deck("a", { drop: 24, speed: 3, dwell: 2 }), ...deck("b", { drop: 24, speed: 3, dwell: 2, phase: 10 })];
    const { runtime, targets } = run(ops, ["a", "b"]);
    for (let i = 0; i < 60; i++) runtime.fixedUpdate(1 / 60);
    expect(targets.get("a")).toBeCloseTo(30, 1);
    expect(targets.get("b")).toBeCloseTo(6, 1);
  });

  it("stretches its lift-rope children up to the headframe wheel", () => {
    const { runtime, objects } = run(deck("a", { drop: 24, speed: 3, dwell: 2, ropeTo: [0, 8, 0] }), ["a"]);
    for (let i = 0; i < 60 * 11; i++) runtime.fixedUpdate(1 / 60);
    runtime.lateUpdate(1 / 60);
    // deck at 6, rope base at 6.1, wheel at 30 + 8 = 38
    expect(objects.get("a/rope")!.scale.y).toBeCloseTo(31.9, 1);
  });

  it("is clock-driven: never replicated, so riders on clients stand on a real body", () => {
    const registry = new ScriptRegistry();
    registerBuiltinScripts(registry);
    expect(isClockDrivenScript(registry.get("lift"))).toBe(true);
    expect(isClockDrivenScript(registry.get("platform-mover"))).toBe(false);
  });
});
