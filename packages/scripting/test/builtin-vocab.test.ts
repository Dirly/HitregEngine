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

const noInput: InputLike = { isDown: () => false };

function step(runtime: ScriptRuntime, ticks: number): void {
  for (let i = 0; i < ticks; i++) runtime.fixedUpdate(1 / 60);
}

describe("platform-mover", () => {
  it("ping-pongs between start and start+distance with dwell at the ends", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "lift",
        entity: {
          name: "Lift",
          parent: null,
          tags: [],
          // travel = |4|/2 = 2s per leg, 1s dwell → 6s cycle
          components: {
            transform: {},
            script: { name: "platform-mover", params: { distance: [0, 4, 0], speed: 2, dwell: 1 } },
          },
        },
      },
    ]);
    const lift = new THREE.Object3D();
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map([["lift", lift]]),
      sim: null,
      registry: registry(),
      input: noInput,
    });
    runtime.start();

    step(runtime, 60); // t=1s: dwell at A just ended, still at start
    expect(lift.position.y).toBeCloseTo(0, 1);
    step(runtime, 60); // t=2s: 1s into the A→B leg → halfway
    expect(lift.position.y).toBeCloseTo(2, 1);
    step(runtime, 60); // t=3s: reached B
    expect(lift.position.y).toBeCloseTo(4, 1);
    step(runtime, 120); // t=5s: 1s into B→A → halfway back
    expect(lift.position.y).toBeCloseTo(2, 1);
  });

  it("stays put when speed or distance is zero", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "stuck",
        entity: {
          name: "Stuck",
          parent: null,
          tags: [],
          components: {
            transform: { position: [5, 0, 0] },
            script: { name: "platform-mover", params: { distance: [0, 4, 0], speed: 0 } },
          },
        },
      },
    ]);
    const obj = new THREE.Object3D();
    obj.position.set(5, 0, 0);
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map([["stuck", obj]]),
      sim: null,
      registry: registry(),
      input: noInput,
    });
    runtime.start();
    step(runtime, 120);
    expect(obj.position.toArray()).toEqual([5, 0, 0]);
  });
});

describe("door", () => {
  it("opens while a tagged opener is in range and closes when it leaves", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "door",
        entity: {
          name: "Door",
          parent: null,
          tags: [],
          components: {
            transform: {},
            script: { name: "door", params: { move: [0, 3, 0], speed: 3, range: 3 } },
          },
        },
      },
      {
        op: "add-entity",
        id: "hero",
        entity: { name: "Hero", parent: null, tags: ["player"], components: { transform: {} } },
      },
    ]);
    const door = new THREE.Object3D();
    const hero = new THREE.Object3D();
    hero.position.set(10, 0, 0); // far away — door stays shut
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map([["door", door], ["hero", hero]]),
      sim: null,
      registry: registry(),
      input: noInput,
    });
    runtime.start();

    step(runtime, 30);
    expect(door.position.y).toBeCloseTo(0, 2); // shut

    hero.position.set(1, 0, 0); // step into range (dist 1 < 3)
    step(runtime, 30); // 0.5s at speed 3 → fully open (needs 1/3 s)
    expect(door.position.y).toBeCloseTo(3, 2); // fully open

    hero.position.set(10, 0, 0); // walk away
    step(runtime, 30);
    expect(door.position.y).toBeCloseTo(0, 2); // shut again
  });

  it("spins about Y instead of sliding when rotateY is set", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "gate",
        entity: {
          name: "Gate",
          parent: null,
          tags: [],
          components: {
            transform: {},
            script: { name: "door", params: { move: [0, 0, 0], rotateY: 90, speed: 10, range: 3 } },
          },
        },
      },
      {
        op: "add-entity",
        id: "hero",
        entity: { name: "Hero", parent: null, tags: ["player"], components: { transform: {} } },
      },
    ]);
    const gate = new THREE.Object3D();
    const hero = new THREE.Object3D(); // at origin → within range
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map([["gate", gate], ["hero", hero]]),
      sim: null,
      registry: registry(),
      input: noInput,
    });
    runtime.start();
    step(runtime, 30); // speed 10 → open well before 30 ticks
    expect(gate.rotation.y).toBeCloseTo(Math.PI / 2, 2);
    expect(gate.position.y).toBeCloseTo(0, 5);
  });
});

describe("face-target", () => {
  function turretScene(params: Record<string, unknown>, targets: Array<[string, [number, number, number]]>) {
    const ops: Op[] = [
      {
        op: "add-entity",
        id: "turret",
        entity: {
          name: "Turret",
          parent: null,
          tags: [],
          components: { transform: {}, script: { name: "face-target", params } },
        },
      },
    ];
    const objects = new Map<string, THREE.Object3D>([["turret", new THREE.Object3D()]]);
    for (const [id, pos] of targets) {
      ops.push({
        op: "add-entity",
        id,
        entity: { name: id, parent: null, tags: ["player"], components: { transform: {} } },
      });
      const obj = new THREE.Object3D();
      obj.position.set(...pos);
      objects.set(id, obj);
    }
    const runtime = new ScriptRuntime({
      doc: scene(ops),
      objects,
      sim: null,
      registry: registry(),
      input: noInput,
    });
    return { runtime, objects };
  }

  it("snaps its yaw to point local -Z at the target (turnSpeed 0)", () => {
    const { runtime, objects } = turretScene({}, [["mark", [5, 0, 0]]]); // +X
    runtime.start();
    step(runtime, 1);
    expect(objects.get("turret")!.rotation.y).toBeCloseTo(-Math.PI / 2, 4);
  });

  it("picks the nearest tagged target", () => {
    const { runtime, objects } = turretScene({}, [
      ["far", [0, 0, -20]], // -Z, distance 20
      ["near", [-3, 0, 0]], // -X, distance 3 → wins
    ]);
    runtime.start();
    step(runtime, 1);
    expect(objects.get("turret")!.rotation.y).toBeCloseTo(Math.PI / 2, 4); // faces -X
  });

  it("ignores targets beyond range and holds heading", () => {
    const { runtime, objects } = turretScene({ range: 5 }, [["mark", [10, 0, 0]]]);
    runtime.start();
    step(runtime, 5);
    expect(objects.get("turret")!.rotation.y).toBe(0); // never turned
  });

  it("eases toward the target at turnSpeed rad/sec along the shortest arc", () => {
    const { runtime, objects } = turretScene({ turnSpeed: 1 }, [["mark", [5, 0, 0]]]);
    runtime.start();
    step(runtime, 30); // 0.5s at 1 rad/s → 0.5 rad toward -π/2, not there yet
    expect(objects.get("turret")!.rotation.y).toBeCloseTo(-0.5, 2);
  });
});

describe("damageable", () => {
  function hazardScene(params: Record<string, unknown>) {
    const doc = scene([
      {
        op: "add-entity",
        id: "mob",
        entity: {
          name: "Mob",
          parent: null,
          tags: [],
          components: {
            transform: {},
            billboard: {},
            script: { name: "damageable", params },
          },
        },
      },
      {
        op: "add-entity",
        id: "spike",
        entity: { name: "Spike", parent: null, tags: ["hazard"], components: { transform: {} } },
      },
      {
        op: "add-entity",
        id: "leaf",
        entity: { name: "Leaf", parent: null, tags: ["decor"], components: { transform: {} } },
      },
    ]);
    let pending: Array<[string, string]> = [];
    const sim: SimLike = {
      getLinvel: () => null,
      setLinvel: () => undefined,
      applyImpulse: () => undefined,
      takeCollisions: () => {
        const p = pending;
        pending = [];
        return p;
      },
    };
    const fills: number[] = [];
    const mob = new THREE.Object3D();
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map([
        ["mob", mob],
        ["spike", new THREE.Object3D()],
        ["leaf", new THREE.Object3D()],
      ]),
      sim,
      registry: registry(),
      input: noInput,
      setBillboard: (_id, opts) => {
        if (opts.fill !== undefined) fills.push(opts.fill);
      },
    });
    const hit = (otherId: string) => {
      pending = [["mob", otherId]];
    };
    return { runtime, mob, fills, hit };
  }

  it("takes damage from a hazard collider and drives its health bar", () => {
    const { runtime, fills, hit } = hazardScene({ maxHp: 100, damagePerHit: 25, invulnMs: 500 });
    runtime.start();
    expect(fills).toEqual([1]); // full on start

    hit("spike");
    step(runtime, 1);
    expect(fills.at(-1)).toBeCloseTo(0.75, 5);
  });

  it("ignores repeat hits during i-frames, then takes damage again after they lapse", () => {
    const { runtime, fills, hit } = hazardScene({ maxHp: 100, damagePerHit: 25, invulnMs: 500 });
    runtime.start();

    hit("spike");
    step(runtime, 1); // → 0.75
    hit("spike");
    step(runtime, 1); // still in i-frames → no change
    expect(fills.at(-1)).toBeCloseTo(0.75, 5);

    step(runtime, 31); // ~0.52s → i-frames (timer) lapse
    hit("spike");
    step(runtime, 1);
    expect(fills.at(-1)).toBeCloseTo(0.5, 5);
  });

  it("hides the entity at zero hp", () => {
    const { runtime, mob, fills, hit } = hazardScene({ maxHp: 30, damagePerHit: 30, invulnMs: 0 });
    runtime.start();
    hit("spike");
    step(runtime, 1);
    expect(fills.at(-1)).toBe(0);
    expect(mob.visible).toBe(false);
  });

  it("ignores collisions from non-hazard entities", () => {
    const { runtime, fills, hit } = hazardScene({ maxHp: 100, damagePerHit: 25, invulnMs: 500 });
    runtime.start();
    hit("leaf"); // tagged "decor", not "hazard"
    step(runtime, 1);
    expect(fills).toEqual([1]); // untouched
  });
});
