import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { LoopbackHub, RoomClient, type Transport } from "@hitreg/net";
import { AssetLibrary, createScene, type SceneDoc } from "@hitreg/core";
import { GameServer, HeadlessWorld, defaultRegistry } from "../src/index.js";

/**
 * Swimming ON THE AUTHORITY.
 *
 * The client predicts its own swim; the server moves the body everyone else
 * sees, and if only one of the two knows the water is there the authority wins
 * by dragging the swimmer to the bed. So this checks the half that cannot be
 * checked by reading the client: a body dropped into a pool on a server with
 * no renderer, no model and no input floats at its waterline, answers the dive
 * key, and walks out on the other side.
 *
 * The pool is AUTHORED (a `water` component), which is also the path a
 * dungeon takes — no voxel world is involved.
 */

const flush = async (hub: LoopbackHub, n = 3) => {
  for (let i = 0; i < n; i++) {
    hub.flush();
    await new Promise((r) => setTimeout(r, 0));
  }
};

/** A 40x40 floor at y=0, a pool of water 6 m deep over it, and a player body above. */
function poolScene(): SceneDoc {
  const doc = createScene("pool");
  doc.entities["floor"] = {
    name: "floor",
    parent: null,
    tags: [],
    components: {
      transform: { position: [0, -6, 0] },
      mesh: { source: { kind: "primitive", shape: "box", size: [40, 1, 40] } },
      rigidbody: { kind: "static" },
      collider: { shape: "box", size: [40, 1, 40] },
    },
  };
  doc.entities["pool"] = {
    name: "pool",
    parent: null,
    tags: ["water"],
    components: {
      transform: { position: [0, 0, 0] },
      mesh: { source: { kind: "primitive", shape: "plane", size: [30, 1, 30] } },
      water: { depth: 6 },
    },
  };
  doc.entities["player"] = {
    name: "player",
    parent: null,
    tags: ["player"],
    components: {
      transform: { position: [0, 3, 0] },
      rigidbody: { kind: "dynamic", lockRotations: true },
      collider: { shape: "capsule", size: [0.8, 1.8, 0.8] },
      script: { name: "third-person-controller", params: { swimSpeed: 3, swimClimbSpeed: 2.6 } },
    },
  };
  return doc;
}

describe("swimming on the authority", { timeout: 30_000 }, () => {
  let world: HeadlessWorld;
  let server: GameServer;
  let hub: LoopbackHub;
  let transport: Transport;
  let client: RoomClient;
  const bodyId = "player:p-swimmer";

  /**
   * Run `seconds` of server time, feeding the same intent every tick.
   *
   * The intent is re-sent every tick even when it is "nothing", because a
   * command stays fresh for two seconds of WALL clock and these ticks run in
   * microseconds: without it, letting go of a key would leave the last one
   * held for the whole rest of the test.
   */
  function run(seconds: number, input: { v?: [number, number]; vy?: number } = {}): void {
    const ticks = Math.round(seconds / world.fixedDt);
    for (let i = 0; i < ticks; i++) {
      (server as unknown as { onCommand(peer: string, input: unknown): void }).onCommand("p-swimmer", {
        t: "input",
        seq: i + 1,
        v: input.v ?? [0, 0],
        vy: input.vy ?? 0,
        yaw: 0,
        p: [0, 0, 0],
      });
      server.tick();
    }
  }

  const bodyY = (): number => world.positionOf(bodyId)![1];

  beforeAll(async () => {
    world = await HeadlessWorld.create({
      doc: poolScene(),
      assets: new AssetLibrary(),
      registry: defaultRegistry(),
      exclude: (_id, e) => e.tags.includes("player"), // the template, not a body
    });
    hub = new LoopbackHub({ manualFlush: true });
    server = new GameServer({ world, transport: hub.connect("server"), snapshotEvery: 1, reconnectGraceSeconds: 0 });
    transport = hub.connect("p-swimmer");
    client = new RoomClient(transport, "server");
    client.join("Swimmer");
    await flush(hub);
    server.tick();
    await flush(hub);
    expect(world.entities.has(bodyId)).toBe(true);
  });

  afterAll(() => {
    server?.close();
    world?.dispose();
  });

  it("floats at its waterline instead of sinking to the bed", () => {
    // dropped in from above with nobody asking for anything
    run(4);
    const y = bodyY();
    // The float line is quoted at the FEET, which sit half a capsule (0.9)
    // below the body's origin: 0.1 m of water over them puts the origin at
    // +0.8, i.e. the character floating at the surface the way its clips are
    // authored to. Generous bounds, because the point of the assertion is that
    // it settles AT the waterline and not on the bed at y ≈ -4.6.
    expect(y).toBeGreaterThan(0.5);
    expect(y).toBeLessThan(1.1);
  });

  it("dives when asked and comes back up when let go", () => {
    const floating = bodyY();
    run(1.5, { vy: -1 });
    const dived = bodyY();
    expect(dived).toBeLessThan(floating - 1);
    run(4);
    expect(bodyY()).toBeGreaterThan(dived + 0.5);
    expect(bodyY()).toBeCloseTo(floating, 0);
  });

  it("plays a swim clip other clients can see, and treads when it stops", () => {
    run(0.5, { v: [3, 0] });
    const stroking = world.anims.get(bodyId);
    run(2);
    const treading = world.anims.get(bodyId);
    expect(stroking).toBeTruthy();
    expect(treading).toBeTruthy();
    // no swim clips were declared on the controller, so both fall back to
    // clips every model has rather than to a name nothing can play
    expect(stroking).toBe("Run");
    expect(treading).toBe("Idle");
  });

  it("stops swimming once the water is too shallow to float in", () => {
    // walk out past the pool's edge (the sheet is 30 m across)
    run(8, { v: [6, 0] });
    const at = world.positionOf(bodyId)!;
    expect(at[0]).toBeGreaterThan(15);
    // on the floor now: the body's origin rests about a capsule's half-height
    // over it, not at the waterline
    expect(at[1]).toBeLessThan(-4);
    expect(world.anims.get(bodyId)).not.toBe("Idle");
  });
});
