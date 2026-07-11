import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "@hitreg/core";
import { Script, ScriptRegistry, ScriptRuntime, type InputLike } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

function scene(ops: Op[]): SceneDoc {
  return applyOps(createScene("t"), ops, coreRegistry).doc;
}

const noInput: InputLike = { isDown: () => false };

function entity(id: string, scriptName: string): Op {
  return {
    op: "add-entity",
    id,
    entity: {
      name: id,
      parent: null,
      tags: [],
      components: { transform: {}, script: { name: scriptName } },
    },
  };
}

/** Drive `ticks` fixed steps at 60 Hz (the runtime's replay-safe clock). */
function run(runtime: ScriptRuntime, ticks: number): void {
  for (let i = 0; i < ticks; i++) runtime.fixedUpdate(1 / 60);
}

function runtimeFor(doc: SceneDoc, registry: ScriptRegistry, objects?: Map<string, THREE.Object3D>) {
  return new ScriptRuntime({
    doc,
    objects: objects ?? new Map(Object.keys(doc.entities).map((id) => [id, new THREE.Object3D()])),
    sim: null,
    registry,
    input: noInput,
  });
}

describe("ctx timers", () => {
  it("after fires once at ~the requested sim time, then never again", () => {
    const fired: number[] = [];
    class OneShot extends Script {
      static override scriptName = "one-shot";
      override onStart(): void {
        this.ctx.after(0.5, () => fired.push(this.ctx.now()));
      }
    }
    const registry = new ScriptRegistry();
    registry.register(OneShot);
    const runtime = runtimeFor(scene([entity("a", "one-shot")]), registry);
    runtime.start();

    run(runtime, 29); // 29/60 s ≈ 483ms — not yet due
    expect(fired).toHaveLength(0);
    run(runtime, 1); // crosses 500ms
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBeCloseTo(500, 0);
    run(runtime, 120); // two more seconds — one-shot must not repeat
    expect(fired).toHaveLength(1);
  });

  it("every repeats on a fixed period and stops when cancelled", () => {
    let ticks = 0;
    class Ping extends Script {
      static override scriptName = "ping";
      cancel: (() => void) | null = null;
      override onStart(): void {
        this.cancel = this.ctx.every(0.25, () => ticks++);
      }
      override onFixedUpdate(): void {
        if (ticks === 3) this.cancel?.(); // cancel from inside a callback-adjacent path
      }
    }
    const registry = new ScriptRegistry();
    registry.register(Ping);
    const runtime = runtimeFor(scene([entity("a", "ping")]), registry);
    runtime.start();

    run(runtime, 60); // 1s / 0.25s = 4 fires, but cancel trips at 3
    expect(ticks).toBe(3);
    run(runtime, 120);
    expect(ticks).toBe(3);
  });

  it("sub-tick intervals fire at most once per tick (no catch-up storm)", () => {
    let count = 0;
    class Fast extends Script {
      static override scriptName = "fast";
      override onStart(): void {
        this.ctx.every(0, () => count++); // degenerate: as fast as possible
      }
    }
    const registry = new ScriptRegistry();
    registry.register(Fast);
    const runtime = runtimeFor(scene([entity("a", "fast")]), registry);
    runtime.start();
    run(runtime, 10);
    expect(count).toBe(10); // exactly one per tick, never a spiral
  });

  it("auto-cancels a script's timers when it is disposed", () => {
    let count = 0;
    class Leaky extends Script {
      static override scriptName = "leaky";
      override onStart(): void {
        this.ctx.every(0.1, () => count++);
      }
    }
    const registry = new ScriptRegistry();
    registry.register(Leaky);
    const runtime = runtimeFor(scene([entity("a", "leaky")]), registry);
    runtime.start();
    run(runtime, 30); // ~5 fires
    const atDispose = count;
    expect(atDispose).toBeGreaterThan(0);
    runtime.dispose();
    run(runtime, 120);
    expect(count).toBe(atDispose); // no fires after the script died
  });

  it("net-suspending an entity cancels its pending timers", () => {
    let fired = false;
    class Delayed extends Script {
      static override scriptName = "delayed";
      override onStart(): void {
        this.ctx.after(1, () => {
          fired = true;
        });
      }
    }
    const registry = new ScriptRegistry();
    registry.register(Delayed);
    const runtime = runtimeFor(scene([entity("a", "delayed")]), registry);
    runtime.start();
    run(runtime, 10);
    runtime.suspendEntities(["a"]); // the authority took over this entity
    run(runtime, 120);
    expect(fired).toBe(false);
  });

  it("a throwing timer callback is caught and never stops other timers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let survived = 0;
    class Boom extends Script {
      static override scriptName = "boom";
      override onStart(): void {
        this.ctx.after(0.1, () => {
          throw new Error("bad timer");
        });
        this.ctx.after(0.1, () => survived++);
      }
    }
    const registry = new ScriptRegistry();
    registry.register(Boom);
    const runtime = runtimeFor(scene([entity("a", "boom")]), registry);
    runtime.start();
    run(runtime, 30);
    expect(survived).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/timer callback failed/), expect.any(Error));
    warn.mockRestore();
  });
});
