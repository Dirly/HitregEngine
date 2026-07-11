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
  InputService,
  registerBuiltinScripts,
  ScriptRegistry,
  ScriptRuntime,
  type InputLike,
  type SimLike,
} from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

function scriptRegistry(): ScriptRegistry {
  const r = new ScriptRegistry();
  registerBuiltinScripts(r);
  return r;
}

function scene(ops: Op[]): SceneDoc {
  return applyOps(createScene("t"), ops, coreRegistry).doc;
}

const noInput: InputLike = { isDown: () => false };

describe("ScriptRegistry", () => {
  it("rejects duplicates and exposes param specs", () => {
    const r = scriptRegistry();
    expect(() => registerBuiltinScripts(r)).toThrow(/already registered/);
    expect(r.names()).toContain("player-controller");
    expect(r.defaultParams("spinner")).toEqual({ speed: 1.5 });
    expect(r.describe()["collectible"]!["collectorTag"]!.default).toBe("player");
  });
});

describe("ScriptRuntime", () => {
  it("spinner rotates its object; params override defaults", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "a",
        entity: {
          name: "A",
          parent: null,
          tags: [],
          components: { transform: {}, script: { name: "spinner", params: { speed: 1 } } },
        },
      },
    ]);
    const objects = new Map([["a", new THREE.Object3D()]]);
    const runtime = new ScriptRuntime({
      doc,
      objects,
      sim: null,
      registry: scriptRegistry(),
      input: noInput,
    });
    runtime.start();
    for (let i = 0; i < 60; i++) runtime.fixedUpdate(1 / 60);
    // 1 rad stays below the Euler-wrap threshold (pi/2), so .rotation.y is direct
    expect(objects.get("a")!.rotation.y).toBeCloseTo(1, 1);
  });

  it("player-controller drives velocity from input", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "player",
        entity: {
          name: "P",
          parent: null,
          tags: ["player"],
          components: { transform: {}, script: { name: "player-controller" } },
        },
      },
    ]);
    const setCalls: Array<[string, [number, number, number]]> = [];
    const sim: SimLike = {
      getLinvel: () => [0, 0, 0],
      setLinvel: (id, v) => setCalls.push([id, v]),
      applyImpulse: () => undefined,
      takeCollisions: () => [],
    };
    const input: InputLike = { isDown: (code) => code === "KeyW" };
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map([["player", new THREE.Object3D()]]),
      sim,
      registry: scriptRegistry(),
      input,
    });
    runtime.start();
    runtime.fixedUpdate(1 / 60);
    const [, v] = setCalls.at(-1)!;
    expect(v[2]).toBeLessThan(0); // W moves toward -Z
    expect(v[0]).toBe(0);
  });

  it("collectible hides itself when a tagged collector touches it", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "orb",
        entity: {
          name: "Orb",
          parent: null,
          tags: [],
          components: { transform: {}, script: { name: "collectible" } },
        },
      },
      {
        op: "add-entity",
        id: "hero",
        entity: { name: "Hero", parent: null, tags: ["player"], components: { transform: {} } },
      },
    ]);
    const orb = new THREE.Object3D();
    let served = false;
    const sim: SimLike = {
      getLinvel: () => null,
      setLinvel: () => undefined,
      applyImpulse: () => undefined,
      takeCollisions: () => {
        if (served) return [];
        served = true;
        return [["orb", "hero"]];
      },
    };
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map([["orb", orb], ["hero", new THREE.Object3D()]]),
      sim,
      registry: scriptRegistry(),
      input: noInput,
    });
    runtime.start();
    expect(orb.visible).toBe(true);
    runtime.fixedUpdate(1 / 60);
    expect(orb.visible).toBe(false);
  });

  it("oscillator moves around its start position using sim time", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "lift",
        entity: {
          name: "Lift",
          parent: null,
          tags: [],
          components: {
            transform: { position: [0, 2, 0] },
            script: { name: "oscillator", params: { amplitude: 2, period: 2 } },
          },
        },
      },
    ]);
    const lift = new THREE.Object3D();
    lift.position.set(0, 2, 0);
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map([["lift", lift]]),
      sim: null,
      registry: scriptRegistry(),
      input: noInput,
    });
    runtime.start();
    // quarter period = peak of sine = +amplitude
    for (let i = 0; i < 30; i++) runtime.fixedUpdate(1 / 60);
    expect(lift.position.y).toBeCloseTo(4, 1);
  });
});

describe("InputService", () => {
  it("is constructible and disposable in a browserless env via injected target", () => {
    const listeners = new Map<string, (e: unknown) => void>();
    const fakeWindow = {
      addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
      removeEventListener: (t: string) => listeners.delete(t),
    } as unknown as Window;
    const input = new InputService(fakeWindow);
    listeners.get("keydown")!({ code: "KeyW", target: null });
    expect(input.isDown("KeyW")).toBe(true);
    listeners.get("keyup")!({ code: "KeyW", target: null });
    expect(input.isDown("KeyW")).toBe(false);
    input.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe("ScriptRuntime object-map ownership", () => {
  it("removeEntities never mutates the caller's render-object map", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "npc",
        entity: {
          name: "NPC",
          parent: null,
          tags: [],
          components: { transform: {}, script: { name: "spinner" } },
        },
      },
    ]);
    const renderObjects = new Map([["npc", new THREE.Object3D()]]);
    const runtime = new ScriptRuntime({
      doc,
      objects: renderObjects,
      sim: null,
      registry: scriptRegistry(),
      input: noInput,
    });
    runtime.start();
    // net suspension path: scripts stop, but the RENDERER (and the net
    // ghost-writer) must keep the object — aliasing the map broke this
    runtime.removeEntities(["npc"], { silent: true });
    expect(renderObjects.has("npc")).toBe(true);

    // and resuming from the same map finds the object again
    runtime.addEntities(doc, renderObjects, { silent: true });
    for (let i = 0; i < 60; i++) runtime.fixedUpdate(1 / 60);
    expect(renderObjects.get("npc")!.rotation.y).not.toBe(0); // spinner runs again
  });
});

describe("ScriptRuntime net suspension (suspend/resume)", () => {
  it("suspended entities stop simulating but stay targetable; resume restarts", () => {
    const doc = scene([
      {
        op: "add-entity",
        id: "npc",
        entity: {
          name: "NPC",
          parent: null,
          tags: ["rpg-enemy"],
          components: { transform: {}, script: { name: "spinner", params: { speed: 1 } } },
        },
      },
    ]);
    const objects = new Map([["npc", new THREE.Object3D()]]);
    const runtime = new ScriptRuntime({
      doc,
      objects,
      sim: null,
      registry: scriptRegistry(),
      input: noInput,
    });
    runtime.start();
    runtime.suspendEntities(["npc"]);
    for (let i = 0; i < 30; i++) runtime.fixedUpdate(1 / 60);
    expect(objects.get("npc")!.rotation.y).toBe(0); // script is not running

    // still visible to other scripts: interactions/targeting keep working
    expect(runtime.findByTag("rpg-enemy")).toContain("npc");

    runtime.resumeEntities(["npc"]);
    for (let i = 0; i < 30; i++) runtime.fixedUpdate(1 / 60);
    expect(objects.get("npc")!.rotation.y).not.toBe(0); // spinning again
  });
});
