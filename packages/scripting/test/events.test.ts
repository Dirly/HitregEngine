import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as THREE from "three";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  EventRegistry,
  registerCoreComponents,
  registerCoreEvents,
  type Op,
  type SceneDoc,
} from "@hitreg/core";
import {
  EventBus,
  Script,
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

function eventRegistry(): EventRegistry {
  const r = new EventRegistry();
  registerCoreEvents(r);
  return r;
}

const noInput: InputLike = { isDown: () => false };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EventBus", () => {
  it("emit never dispatches synchronously; drain delivers FIFO across emitters", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on("alpha", (p) => order.push(`alpha:${p as string}`));
    bus.on("beta", (p) => order.push(`beta:${p as string}`));

    // interleaved emissions from "different emitters"
    bus.emit("alpha", "1");
    bus.emit("beta", "2");
    bus.emit("alpha", "3");
    bus.emit("beta", "4");
    expect(order).toEqual([]); // queued, not dispatched

    bus.drain(1);
    expect(order).toEqual(["alpha:1", "beta:2", "alpha:3", "beta:4"]);
  });

  it("cascading emissions drain same-tick, capped at 8 passes with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bus = new EventBus();
    let delivered = 0;
    bus.on("loop", () => {
      delivered++;
      bus.emit("loop", null); // infinite feedback
    });
    bus.emit("loop", null);
    bus.drain(1);
    expect(delivered).toBe(8);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/event cascade exceeded depth/));
    // the runaway remainder was dropped — the next tick starts clean
    warn.mockClear();
    bus.drain(2);
    expect(delivered).toBe(8);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a finite cascade delivers fully in one drain", () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on("first", () => {
      order.push("first");
      bus.emit("second", null);
    });
    bus.on("second", () => order.push("second"));
    bus.emit("first", null);
    bus.drain(1);
    expect(order).toEqual(["first", "second"]);
  });

  it("drops invalid payloads of registered events; unregistered names warn once but deliver", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bus = new EventBus(eventRegistry());
    const seen: unknown[] = [];
    bus.on("collision", (p) => seen.push(p));
    bus.on("home-brew", (p) => seen.push(p));

    bus.emit("collision", { a: "x" }); // invalid (missing b) → dropped
    bus.emit("collision", { a: "x", b: "y" }); // valid
    bus.emit("home-brew", 42); // unregistered → warn once, delivered
    bus.emit("home-brew", 43); // no second warning
    bus.drain(1);

    expect(seen).toEqual([{ a: "x", b: "y" }, 42, 43]);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes("dropped"))).toHaveLength(1);
    expect(messages.filter((m) => m.includes("not registered"))).toHaveLength(1);
  });

  it("handler exceptions are caught and never break delivery", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("boom", () => {
      throw new Error("bad handler");
    });
    bus.on("boom", () => seen.push("survivor"));
    bus.emit("boom", null);
    bus.drain(1);
    expect(seen).toEqual(["survivor"]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/handler for "boom" failed/), expect.any(Error));
  });

  it("once fires a single time; on returns a working unsubscribe", () => {
    const bus = new EventBus();
    let onceCount = 0;
    let onCount = 0;
    bus.once("tap", () => onceCount++);
    const off = bus.on("tap", () => onCount++);
    bus.emit("tap", null);
    bus.emit("tap", null);
    bus.drain(1);
    expect(onceCount).toBe(1);
    expect(onCount).toBe(2);
    off();
    bus.emit("tap", null);
    bus.drain(2);
    expect(onCount).toBe(2);
  });

  it("trace is a 64-entry ring buffer of delivered { tick, name, payload }", () => {
    const bus = new EventBus();
    for (let i = 0; i < 10; i++) bus.emit("early", i);
    bus.drain(1);
    for (let i = 10; i < 70; i++) bus.emit("late", i);
    bus.drain(2);

    const trace = bus.trace();
    expect(trace).toHaveLength(64);
    // oldest surviving entry is event #6 (70 total, capacity 64)
    expect(trace[0]).toEqual({ tick: 1, name: "early", payload: 6 });
    expect(trace.at(-1)).toEqual({ tick: 2, name: "late", payload: 69 });
    // dropped events never enter the trace
    const registry = eventRegistry();
    const strict = new EventBus(registry);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    strict.emit("collision", { a: 1 }); // invalid
    strict.drain(1);
    expect(strict.trace()).toHaveLength(0);
  });
});

describe("ScriptRuntime + EventBus", () => {
  class Probe extends Script {
    static override scriptName = "probe";
    static received: string[] = [];
    override onStart(): void {
      this.ctx.events?.on("ping", () => Probe.received.push(this.entityId));
    }
  }

  function probeRuntime(bus: EventBus, sim: SimLike | null = null): ScriptRuntime {
    Probe.received = [];
    const registry = new ScriptRegistry();
    registry.register(Probe);
    const probeEntity = (id: string): Op => ({
      op: "add-entity",
      id,
      entity: {
        name: id,
        parent: null,
        tags: [],
        components: { transform: {}, script: { name: "probe" } },
      },
    });
    return new ScriptRuntime({
      doc: scene([probeEntity("a"), probeEntity("b")]),
      objects: new Map([
        ["a", new THREE.Object3D()],
        ["b", new THREE.Object3D()],
      ]),
      sim,
      registry,
      input: noInput,
      events: bus,
    });
  }

  it("script subscriptions auto-unsubscribe on removeEntities and dispose", () => {
    const bus = new EventBus(eventRegistry());
    vi.spyOn(console, "warn").mockImplementation(() => undefined); // "ping" is unregistered
    const runtime = probeRuntime(bus);
    runtime.start();

    bus.emit("ping", null);
    runtime.fixedUpdate(1 / 60);
    expect(Probe.received).toEqual(["a", "b"]);

    runtime.removeEntities(["a"]);
    bus.emit("ping", null);
    runtime.fixedUpdate(1 / 60);
    expect(Probe.received).toEqual(["a", "b", "b"]);

    runtime.dispose();
    bus.emit("ping", null);
    bus.drain(99);
    expect(Probe.received).toEqual(["a", "b", "b"]); // nobody left listening
  });

  it("emits entity.spawned for runtime additions and entity.destroyed for removals", () => {
    const bus = new EventBus(eventRegistry());
    const runtime = probeRuntime(bus);
    const lifecycle: unknown[] = [];
    bus.on("entity.spawned", (p) => lifecycle.push(["spawned", p]));
    bus.on("entity.destroyed", (p) => lifecycle.push(["destroyed", p]));

    runtime.start();
    runtime.fixedUpdate(1 / 60);
    expect(lifecycle).toEqual([]); // play start is NOT spawning

    const streamed = scene([
      {
        op: "add-entity",
        id: "npc",
        entity: { name: "Npc", parent: null, tags: [], components: { transform: {} } },
      },
    ]);
    runtime.addEntities(streamed, new Map([["npc", new THREE.Object3D()]]));
    runtime.removeEntities(["npc"]);
    runtime.fixedUpdate(1 / 60);
    expect(lifecycle).toEqual([
      ["spawned", { entityId: "npc" }],
      ["destroyed", { entityId: "npc" }],
    ]);
  });

  it("routes physics pairs: sensors get trigger.enter/exit, the rest get collision", () => {
    const bus = new EventBus(eventRegistry());
    let tick = 0;
    const sim: SimLike = {
      getLinvel: () => null,
      setLinvel: () => undefined,
      applyImpulse: () => undefined,
      takeCollisions: () =>
        tick === 0
          ? [
              ["zone", "ball"],
              ["ball", "wall"],
            ]
          : [],
      takeCollisionEnds: () => (tick === 1 ? [["ball", "zone"]] : []),
      isTrigger: (id) => id === "zone",
    };
    const runtime = probeRuntime(bus, sim);
    const seen: Array<[string, unknown]> = [];
    for (const name of ["collision", "trigger.enter", "trigger.exit"]) {
      bus.on(name, (p) => seen.push([name, p]));
    }
    runtime.start();
    runtime.fixedUpdate(1 / 60); // tick 0: started pairs
    tick = 1;
    runtime.fixedUpdate(1 / 60); // tick 1: ended pair
    expect(seen).toEqual([
      ["trigger.enter", { trigger: "zone", other: "ball" }],
      ["collision", { a: "ball", b: "wall" }],
      ["trigger.exit", { trigger: "zone", other: "ball" }],
    ]);
  });
});

describe("EventBus net replication (outbox / injectRemote)", () => {
  function replicatingBus(): EventBus {
    const registry = new EventRegistry();
    registerCoreEvents(registry); // player.joined/left replicate; collision does not
    return new EventBus(registry);
  }

  it("replicate-flagged local events land in the outbox once delivered", () => {
    const bus = replicatingBus();
    bus.emit("player.joined", { peerId: "p-1", name: "derek" });
    bus.emit("collision", { a: "x", b: "y" }); // local-only
    expect(bus.takeOutbox()).toEqual([]); // queued events are not yet delivered
    bus.drain(5);
    expect(bus.takeOutbox()).toEqual([
      { name: "player.joined", payload: { peerId: "p-1", name: "derek" } },
    ]);
    expect(bus.takeOutbox()).toEqual([]); // take drains
  });

  it("remote-injected events deliver locally but never echo to the outbox", () => {
    const bus = replicatingBus();
    const seen: unknown[] = [];
    bus.on("player.joined", (p) => seen.push(p));
    bus.injectRemote([{ name: "player.joined", payload: { peerId: "p-2", name: "kai" } }]);
    bus.drain(9);
    expect(seen).toEqual([{ peerId: "p-2", name: "kai" }]);
    expect(bus.takeOutbox()).toEqual([]); // no replication loop
  });

  it("remote payloads pass the same schema gate — invalid ones drop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = replicatingBus();
    const seen: unknown[] = [];
    bus.on("player.joined", (p) => seen.push(p));
    bus.injectRemote([{ name: "player.joined", payload: { peerId: 42 } }]);
    bus.drain(1);
    expect(seen).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("EventBus peer→authority requests (to-authority events)", () => {
  function requestBus(role: "local" | "authority" | "peer"): EventBus {
    const registry = new EventRegistry();
    registerCoreEvents(registry);
    registry.register(
      "npc.hit",
      z.object({ npc: z.string(), damage: z.number().min(0).max(100) }),
      { replicate: "to-authority" },
    );
    const bus = new EventBus(registry);
    bus.setNetRole(role);
    return bus;
  }

  it("a peer's emit routes to the command outbox, NOT local delivery", () => {
    const bus = requestBus("peer");
    const seen: unknown[] = [];
    bus.on("npc.hit", (p) => seen.push(p));
    bus.emit("npc.hit", { npc: "wolf-1", damage: 10 });
    bus.drain(1);
    expect(seen).toEqual([]); // the authoritative handler runs on the HOST
    expect(bus.takeCommandOutbox()).toEqual([
      { name: "npc.hit", payload: { npc: "wolf-1", damage: 10 } },
    ]);
    expect(bus.takeCommandOutbox()).toEqual([]); // take drains
  });

  it("authority and single-player deliver to-authority events locally", () => {
    for (const role of ["authority", "local"] as const) {
      const bus = requestBus(role);
      const seen: unknown[] = [];
      bus.on("npc.hit", (p) => seen.push(p));
      bus.emit("npc.hit", { npc: "wolf-1", damage: 10 });
      bus.drain(1);
      expect(seen).toEqual([{ npc: "wolf-1", damage: 10 }]);
      expect(bus.takeCommandOutbox()).toEqual([]);
    }
  });

  it("injectFromPeer delivers with meta.from and enforces direction + schema", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = requestBus("authority");
    const seen: Array<{ p: unknown; from?: string }> = [];
    bus.on("npc.hit", (p, meta) => seen.push({ p, from: meta?.from }));
    bus.on("player.joined", (p) => seen.push({ p }));
    bus.injectFromPeer("p-abc", [
      { name: "npc.hit", payload: { npc: "wolf-1", damage: 12 } },
      { name: "player.joined", payload: { peerId: "x", name: "spoof" } }, // to-peers: rejected
      { name: "npc.hit", payload: { npc: "wolf-1", damage: 9999 } }, // schema: rejected
    ]);
    bus.drain(3);
    expect(seen).toEqual([{ p: { npc: "wolf-1", damage: 12 }, from: "p-abc" }]);
    expect(warn).toHaveBeenCalled();
    // an authoritative to-authority delivery never re-broadcasts to peers
    expect(bus.takeOutbox()).toEqual([]);
  });

  it("peer emissions of invalid request payloads never leave the machine", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = requestBus("peer");
    bus.emit("npc.hit", { npc: "wolf-1", damage: -5 });
    expect(bus.takeCommandOutbox()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});
