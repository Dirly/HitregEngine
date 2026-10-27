import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetLibrary, createScene, STAFF_TELEPORT_EVENT } from "@hitreg/core";
import { LoopbackHub, RoomClient } from "@hitreg/net";
import { GameServer, HeadlessWorld, type TerrainStreamer } from "../src/index.js";

/**
 * The console's /teleport on a dedicated server (core STAFF_TELEPORT_EVENT): honoured from a staff peer for its own
 * body only, held until the destination's cells are in (the join/portal-arrival wait), then landed on the first
 * collider over the column. A stub terrain stands in for the voxel streamer so the hold is deterministic.
 */
let world: HeadlessWorld, server: GameServer, hub: LoopbackHub, alice: RoomClient, bob: RoomClient;
let ready = true;
const flush = async () => { hub.flush(); await new Promise<void>(resolve => setImmediate(resolve)); hub.flush(); };
const ask = async (client: RoomClient, payload: Record<string, unknown>) => { client.sendCommand({ t: "event", name: STAFF_TELEPORT_EVENT, payload }); await flush(); server.tick(); server.tick(); await flush(); };
const stubTerrain = () => ({
  resolved: { streamer: { cellSize: 32 }, field: null, data: { world: "stub" } },
  inWorld: (cx: number, cz: number) => Math.abs(cx) < 100 && Math.abs(cz) < 100,
  has: () => true,
  groundHeight: () => 0,
  groundNear: () => 0,
  prefetch: vi.fn(() => ready),
  ensureAround: vi.fn(),
  update: () => undefined,
  cells: () => [],
  counters: { inlineMs: 0, integrateMs: 0 },
  pinned: 0,
  liveWorkers: 0,
});
let terrain: ReturnType<typeof stubTerrain>;

beforeEach(async () => {
  ready = true;
  const doc = createScene("teleport-test");
  doc.entities.player = { name: "player", parent: null, tags: ["player"], components: { transform: { position: [0, 2, 0] }, rigidbody: { kind: "dynamic", lockRotations: true }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] }, script: { name: "third-person-controller", params: {} } } };
  doc.entities.floor = { name: "floor", parent: null, tags: [], components: { transform: { position: [0, -0.5, 0] }, rigidbody: { kind: "static" }, collider: { shape: "box", size: [200, 1, 200] } } };
  // a deck over the destination: the landing is on it, not on the ground under it
  doc.entities.deck = { name: "deck", parent: null, tags: [], components: { transform: { position: [40, 4.5, 40] }, rigidbody: { kind: "static" }, collider: { shape: "box", size: [6, 1, 6] } } };
  world = await HeadlessWorld.create({ doc, assets: new AssetLibrary(), fixedHz: 10, exclude: (_id, entity) => entity.tags.includes("player") });
  hub = new LoopbackHub({ manualFlush: true });
  terrain = stubTerrain();
  server = new GameServer({
    world,
    transport: hub.connect("host"),
    terrain: terrain as unknown as TerrainStreamer,
    identityOf: peer => ({ playerId: `acct-${peer}`, characterId: peer, name: peer, saveId: peer, ...(peer === "alice" ? { role: "dev" as const } : {}) }),
  });
  alice = new RoomClient(hub.connect("alice"), "host"); bob = new RoomClient(hub.connect("bob"), "host");
  alice.join("Alice"); bob.join("Bob"); await flush(); server.tick(); await flush(); server.tick(); await flush();
});
afterEach(async () => { await server?.close(); world?.dispose(); });

describe("staff teleport on a dedicated server", () => {
  it("lands a staff peer's own body on the first collider over the destination", async () => {
    expect(world.netState.get("staff/alice")).toBe("dev");
    await ask(alice, { actorId: "player:alice", x: 40, z: 40 });
    const p = world.positionOf("player:alice")!;
    expect(p[0]).toBeCloseTo(40, 0);
    expect(p[2]).toBeCloseTo(40, 0);
    expect(p[1]).toBeGreaterThan(5); // on the deck (top 5), not the ground under it
    expect(p[1]).toBeLessThan(7.5);
    expect(server.teleportsLanded.at(-1)?.bodyId).toBe("player:alice");
  });

  it("holds the move until the destination's cells are in", async () => {
    ready = false;
    const before = world.positionOf("player:alice")!;
    await ask(alice, { actorId: "player:alice", x: -60, z: 20 });
    for (let i = 0; i < 20; i++) server.tick();
    expect(Math.abs(world.positionOf("player:alice")![0] - before[0])).toBeLessThan(1); // still waiting, not dropped into nothing
    expect(terrain.prefetch).toHaveBeenCalled();
    ready = true;
    server.tick();
    server.tick();
    const p = world.positionOf("player:alice")!;
    expect(p[0]).toBeCloseTo(-60, 0);
    expect(terrain.ensureAround).toHaveBeenCalledWith(-60, 20, 1);
  });

  it("refuses a player, and a staff peer moving someone else", async () => {
    const bobAt = world.positionOf("player:bob")!;
    await ask(bob, { actorId: "player:bob", x: 40, z: 40 });
    await ask(alice, { actorId: "player:bob", x: 40, z: 40 });
    for (let i = 0; i < 5; i++) server.tick();
    expect(Math.hypot(world.positionOf("player:bob")![0] - bobAt[0], world.positionOf("player:bob")![2] - bobAt[2])).toBeLessThan(1);
    expect(server.teleportsLanded).toHaveLength(0);
  });
});
