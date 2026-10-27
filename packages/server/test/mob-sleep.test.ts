import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { LoopbackHub, RoomClient } from "@hitreg/net";
import { AssetLibrary, createScene, type SceneDoc } from "@hitreg/core";
import { Script } from "@hitreg/scripting";
import { GameServer, HeadlessWorld, defaultScripts } from "../src/index.js";

/**
 * Server parity for the runtime's mob distance sleep (MobSleepRule): the dedicated server names its players to the
 * script runtime every tick, so the same 80 / 160 m bands gate mob steps here as in local play.
 */

const flush = async (hub: LoopbackHub, n = 3) => {
  for (let i = 0; i < n; i++) {
    hub.flush();
    await new Promise((r) => setTimeout(r, 0));
  }
};

class CountingBrain extends Script {
  static override scriptName = "count-steps";
  static steps = new Map<string, number>();
  override onFixedUpdate() { CountingBrain.steps.set(this.entityId, (CountingBrain.steps.get(this.entityId) ?? 0) + 1); }
}

function scene(): SceneDoc {
  const doc = createScene("sleep");
  doc.entities["floor"] = {
    name: "floor", parent: null, tags: [],
    components: {
      transform: { position: [0, -0.5, 0] },
      rigidbody: { kind: "static" },
      collider: { shape: "box", size: [800, 1, 800] },
    },
  };
  doc.entities["player"] = {
    name: "player", parent: null, tags: ["player"],
    components: {
      transform: { position: [0, 1, 0] },
      rigidbody: { kind: "dynamic", lockRotations: true },
      collider: { shape: "capsule", size: [0.8, 1.8, 0.8] },
    },
  };
  // a mob = a body over a `mob-brain`; the counting script sits on the body beside it
  for (const [id, x] of [["near", 40], ["mid", 120], ["far", 300]] as const) {
    doc.entities[id] = {
      name: id, parent: null, tags: [],
      components: {
        transform: { position: [x, 1, 0] },
        rigidbody: { kind: "dynamic", lockRotations: true },
        collider: { shape: "capsule", size: [0.8, 1.8, 0.8] },
        script: { name: "count-steps", params: {} },
      },
    };
    doc.entities[`${id}-brain`] = {
      name: `${id} brain`, parent: id, tags: [],
      components: { transform: {}, script: { name: "mob-brain", params: { leash: 0, roam: 0 } } },
    };
  }
  return doc;
}

describe("mob distance sleep on the dedicated server", { timeout: 30_000 }, () => {
  let world: HeadlessWorld;
  let server: GameServer;
  let hub: LoopbackHub;

  beforeAll(async () => {
    const assets = new AssetLibrary();
    const scripts = defaultScripts(undefined, assets);
    scripts.register(CountingBrain);
    world = await HeadlessWorld.create({ doc: scene(), assets, scripts, exclude: (_id, e) => e.tags.includes("player") });
    hub = new LoopbackHub({ manualFlush: true });
    server = new GameServer({ world, transport: hub.connect("server"), snapshotEvery: 1, reconnectGraceSeconds: 0 });
    const client = new RoomClient(hub.connect("p-1"), "server");
    client.join("Sleeper");
    await flush(hub);
    server.tick();
    await flush(hub);
  });

  afterAll(() => {
    server?.close();
    world?.dispose();
  });

  it("steps the near mob every tick, the mid one every third, the far one never", () => {
    const body = world.positionOf("player:p-1");
    expect(body).not.toBeNull();
    CountingBrain.steps.clear();
    for (let i = 0; i < 30; i++) server.tick();
    expect(world.scripts.mobBand("near-brain")).toBe("full");
    expect(world.scripts.mobBand("mid")).toBe("mid");
    expect(world.scripts.mobBand("far")).toBe("asleep");
    expect(CountingBrain.steps.get("near")).toBe(30);
    expect(CountingBrain.steps.get("mid")).toBe(10);
    expect(CountingBrain.steps.get("far") ?? 0).toBe(0);
  });
});

/** A stand-in brain that walks its body +x every step it is given (so a step shows on the wire as a new position). */
class WalkingBrain extends Script {
  static override scriptName = "walk-steps";
  override onFixedUpdate() {
    const body = this.entityId;
    const v = this.ctx.sim?.getLinvel(body);
    this.ctx.sim?.setLinvel(body, [1, v?.[1] ?? 0, 0]);
  }
}

function crowd(): SceneDoc {
  const doc = createScene("crowd");
  doc.entities["floor"] = {
    name: "floor", parent: null, tags: [],
    components: { transform: { position: [250, -0.5, 0] }, rigidbody: { kind: "static" }, collider: { shape: "box", size: [1400, 1, 600] } },
  };
  doc.entities["player"] = {
    name: "player", parent: null, tags: ["player"],
    components: { transform: { position: [500, 1, 0] }, rigidbody: { kind: "dynamic", lockRotations: true }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] } },
  };
  for (let i = 0; i < 200; i++) {
    const id = `m${i}`;
    doc.entities[id] = {
      name: id, parent: null, tags: [],
      components: {
        transform: { position: [(i % 20) * 3 - 30, 1, Math.floor(i / 20) * 3 - 15] },
        rigidbody: { kind: "dynamic", lockRotations: true },
        collider: { shape: "capsule", size: [0.8, 1.8, 0.8] },
        script: { name: "walk-steps", params: {} },
      },
    };
    // the brain on a child, as real mobs carry it: it is what makes the body a mob
    doc.entities[`${id}-brain`] = { name: `${id} brain`, parent: id, tags: [], components: { transform: {}, script: { name: "mob-brain", params: { leash: 0, roam: 0 } } } };
  }
  return doc;
}

describe("an asleep crowd is quiet on the wire", { timeout: 60_000 }, () => {
  let world: HeadlessWorld;
  let server: GameServer;
  let hub: LoopbackHub;
  const mobUpdates: string[] = [];

  beforeAll(async () => {
    const assets = new AssetLibrary();
    const scripts = defaultScripts(undefined, assets);
    scripts.register(WalkingBrain);
    world = await HeadlessWorld.create({ doc: crowd(), assets, scripts, exclude: (_id, e) => e.tags.includes("player") });
    hub = new LoopbackHub({ manualFlush: true });
    // interest off (everything to everyone): only the sleep can keep a far mob off the wire
    server = new GameServer({ world, transport: hub.connect("server"), snapshotEvery: 1, reconnectGraceSeconds: 0, interestRadius: 0 });
    const client = new RoomClient(hub.connect("p-1"), "server");
    client.onSnapshot((s) => {
      const st = s.state as { entities?: { updates?: Record<string, unknown> } } | null;
      for (const id of Object.keys(st?.entities?.updates ?? {})) if (/^m\d+$/.test(id)) mobUpdates.push(id);
    });
    client.join("Watcher");
    await flush(hub);
    server.tick();
    await flush(hub);
  });

  afterAll(() => {
    server?.close();
    world?.dispose();
  });

  it("sends no mob state for 60 ticks with the only player 500 m away, then resumes within one step of approach", async () => {
    const body = "player:p-1";
    world.sim.setPosition(body, [500, 1, 0]);
    // settle: every mob is sent once on entering the view (and once more as it stops)
    for (let i = 0; i < 120; i++) { server.tick(); await flush(hub, 1); }
    expect(world.scripts.mobBand("m0")).toBe("asleep");
    expect(world.scripts.mobBand("m199")).toBe("asleep");
    mobUpdates.length = 0;
    for (let i = 0; i < 60; i++) { server.tick(); await flush(hub, 1); }
    expect(mobUpdates).toEqual([]); // not even the once-a-second refresh
    // the player walks up to 100 m of the crowd: the next step wakes it, the one after shows it moving
    world.sim.setPosition(body, [100, 1, 0]);
    server.tick(); await flush(hub, 1);
    server.tick(); await flush(hub, 1);
    expect(world.scripts.mobBand("m0")).not.toBe("asleep");
    expect(world.scripts.mobBand("m199")).not.toBe("asleep");
    // awake (a mid-band mob steps every 3rd tick): within 3 more steps every one has moved and been sent
    for (let i = 0; i < 3; i++) { server.tick(); await flush(hub, 1); }
    expect(new Set(mobUpdates).size).toBe(200);
  });
});
