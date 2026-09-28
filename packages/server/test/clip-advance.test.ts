import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { LoopbackHub, RoomClient, type Transport } from "@hitreg/net";
import { AssetLibrary, createScene, type SceneDoc } from "@hitreg/core";
import { GameServer, HeadlessWorld, defaultRegistry } from "../src/index.js";

/**
 * A swing that steps in (the controller's `clipAdvance`) ON THE AUTHORITY.
 *
 * The client adds the lunge to the velocity it claims, so the server only has
 * to let it through: a committed swing slows the body (speedMult well under
 * 1) and the plain speed cap would clip the lunge as a speed hack, pinning
 * the swinger in place on everyone else's screen. And the action other
 * clients see must stay full-body while the lunge carries it past the walk
 * line — decided when the swing starts, as the controller decides it.
 */

const flush = async (hub: LoopbackHub, n = 3) => {
  for (let i = 0; i < n; i++) {
    hub.flush();
    await new Promise((r) => setTimeout(r, 0));
  }
};

function floorScene(): SceneDoc {
  const doc = createScene("floor");
  doc.entities["floor"] = {
    name: "floor",
    parent: null,
    tags: [],
    components: {
      transform: { position: [0, -0.5, 0] },
      mesh: { source: { kind: "primitive", shape: "box", size: [200, 1, 200] } },
      rigidbody: { kind: "static" },
      collider: { shape: "box", size: [200, 1, 200] },
    },
  };
  doc.entities["player"] = {
    name: "player",
    parent: null,
    tags: ["player"],
    components: {
      transform: { position: [0, 1, 0] },
      rigidbody: { kind: "dynamic", lockRotations: true },
      collider: { shape: "capsule", size: [0.8, 1.8, 0.8] },
      script: {
        name: "third-person-controller",
        // 2 m over a 1 s clip: a peak of 2 m/s, so a 6 m/s allowance at the fastest fit
        params: { speed: 6.5, sprintSpeed: 9.5, clipAdvance: { Lunge: { d: 1, f: [0, 2] } } },
      },
    },
  };
  return doc;
}

describe("clip advance on the authority", { timeout: 30_000 }, () => {
  let world: HeadlessWorld;
  let server: GameServer;
  let hub: LoopbackHub;
  let transport: Transport;
  let client: RoomClient;
  const bodyId = "player:p-lunger";
  let seq = 0;

  function run(seconds: number, v: [number, number] = [0, 0]): void {
    const ticks = Math.round(seconds / world.fixedDt);
    for (let i = 0; i < ticks; i++) {
      (server as unknown as { onCommand(peer: string, input: unknown): void }).onCommand("p-lunger", {
        t: "input",
        seq: ++seq,
        v,
        yaw: 0,
        p: [0, 0, 0],
      });
      server.tick();
    }
  }

  const z = (): number => world.positionOf(bodyId)![2];
  const ud = (): Record<string, unknown> => world.objects.get(bodyId)!.userData as Record<string, unknown>;
  const simNow = (): number => world.timeMs / 1000;

  beforeAll(async () => {
    world = await HeadlessWorld.create({
      doc: floorScene(),
      assets: new AssetLibrary(),
      registry: defaultRegistry(),
      exclude: (_id, e) => e.tags.includes("player"),
    });
    hub = new LoopbackHub({ manualFlush: true });
    server = new GameServer({ world, transport: hub.connect("server"), snapshotEvery: 1, reconnectGraceSeconds: 0 });
    transport = hub.connect("p-lunger");
    client = new RoomClient(transport, "server");
    client.join("Lunger");
    await flush(hub);
    server.tick();
    await flush(hub);
    expect(world.entities.has(bodyId)).toBe(true);
    run(1); // settle on the floor
  });

  afterAll(() => {
    server?.close();
    world?.dispose();
  });

  it("clips a slowed body's claim to its slowed cap when no action plays", () => {
    ud()["speedMult"] = 0.1; // cap ~1 m/s
    const z0 = z();
    run(1, [0, 3]);
    expect(z() - z0).toBeLessThan(1.2);
  });

  it("lets a committed swing's lunge through while the action plays", () => {
    ud()["speedMult"] = 0.1;
    // started standing still: full-body
    Object.assign(ud(), { actionClip: "Lunge", actionUntil: simNow() + 2, actionFullBody: false });
    run(0.1);
    const z0 = z();
    run(1, [0, 3]); // the client claims the lunge on top of nothing
    expect(z() - z0).toBeGreaterThan(2.5);
    // and everyone else still sees the swing, not a run with a swing on its arms
    expect(world.anims.get(bodyId)).toBe("Lunge");
  });

  it("keeps the next swing of a chain full-body although the claim still carries the lunge", () => {
    ud()["speedMult"] = 0.85;
    Object.assign(ud(), { actionClip: "Lunge", actionUntil: simNow() + 0.5, actionFullBody: false });
    run(0.3);
    run(0.2, [0, 3]); // mid-lunge: the claim is well past the walk line
    Object.assign(ud(), { actionClip: "Lunge2", actionUntil: simNow() + 0.5 });
    run(0.1, [0, 3]);
    expect(world.anims.get(bodyId)).toBe("Lunge2");
    // a swing started from a real run, nothing chained, is still a layer
    Object.assign(ud(), { actionClip: undefined, actionUntil: 0 });
    run(1, [0, 6]);
    Object.assign(ud(), { actionClip: "Lunge", actionUntil: simNow() + 0.5 });
    run(0.1, [0, 6]);
    expect(world.anims.get(bodyId)).not.toBe("Lunge");
  });

  it("gives a rooted body (speedMult 0) no allowance", () => {
    ud()["speedMult"] = 0;
    Object.assign(ud(), { actionClip: "Lunge", actionUntil: simNow() + 2 });
    const z0 = z();
    run(0.5, [0, 3]);
    expect(Math.abs(z() - z0)).toBeLessThan(0.1);
  });
});
