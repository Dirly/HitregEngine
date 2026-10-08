import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetLibrary, createScene, PLAYER_LOGOUT_EVENT, transferLockKey } from "@hitreg/core";
import { LoopbackHub, RoomClient, type Transport } from "@hitreg/net";
import { GameServer, HeadlessWorld, WORLD_MODULE, type WorldModuleMessage, type PlayerPersistence } from "../src/index.js";

let world: HeadlessWorld, server: GameServer, hub: LoopbackHub, alice: RoomClient, bob: RoomClient;
let persistence: PlayerPersistence;
let aliceTransport: Transport;
let messages: WorldModuleMessage[], otherMessages: WorldModuleMessage[];
const flush = async () => { hub.flush(); await new Promise<void>(resolve => setImmediate(resolve)); hub.flush(); };
const request = async (client = alice, payload: unknown = {}) => { client.sendCommand({ t: "event", name: PLAYER_LOGOUT_EVENT, payload }); await flush(); server.tick(); await flush(); };
const advance = (seconds: number) => { for (let i = 0; i < Math.round(seconds / world.fixedDt); i++) server.tick(); };
beforeEach(async () => {
  const doc = createScene("camp-test");
  doc.entities.player = { name: "player", parent: null, tags: ["player"], components: { transform: { position: [0, 2, 0] }, rigidbody: { kind: "dynamic", lockRotations: true }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] }, script: { name: "third-person-controller", params: {} } } };
  doc.entities.floor = { name: "floor", parent: null, tags: [], components: { transform: { position: [0, -0.5, 0] }, rigidbody: { kind: "static" }, collider: { shape: "box", size: [100, 1, 100] } } };
  world = await HeadlessWorld.create({ doc, assets: new AssetLibrary(), fixedHz: 10, exclude: (_id, entity) => entity.tags.includes("player") });
  hub = new LoopbackHub({ manualFlush: true });
  persistence = { load: async () => ({ sheet: null, records: {}, position: null, yaw: 0, rev: {} }), commit: vi.fn(async () => ({ character: 1, world: 1 })) };
  server = new GameServer({ world, transport: hub.connect("host"), persistence, identityOf: peer => ({ playerId: "acct-test", characterId: peer, name: peer, saveId: peer }), commitEverySeconds: 0 });
  messages = []; otherMessages = [];
  aliceTransport = hub.connect("alice"); alice = new RoomClient(aliceTransport, "host"); bob = new RoomClient(hub.connect("bob"), "host");
  alice.onModule(WORLD_MODULE, raw => messages.push(raw as WorldModuleMessage)); bob.onModule(WORLD_MODULE, raw => otherMessages.push(raw as WorldModuleMessage));
  alice.join("Alice"); bob.join("Bob"); await flush(); server.tick(); await flush(); server.tick(); await flush();
  advance(2); await flush(); messages.length = 0; otherMessages.length = 0;
});
afterEach(async () => { await server?.close(); world?.dispose(); });

describe("authoritative camp and logout", () => {
  it("requires 20 seconds, waits for the save, and removes only the requesting body without respawning", async () => {
    let saved!: (value: Record<string, number>) => void;
    persistence.commit = vi.fn(() => new Promise<Record<string, number>>(resolve => { saved = resolve; }));
    await request();
    expect(messages).toContainEqual({ t: "camp", remaining: 20 });
    expect(otherMessages.some(m => m.t === "camp")).toBe(false);
    advance(19.9); await flush(); expect(persistence.commit).not.toHaveBeenCalled();
    advance(0.2); await flush(); expect(persistence.commit).toHaveBeenCalledTimes(1);
    expect(server.players.has("alice")).toBe(true); expect(messages.some(m => m.t === "logout")).toBe(false);
    saved({ character: 1, world: 1 }); await flush();
    expect(messages.some(m => m.t === "logout")).toBe(true);
    expect(server.players.has("alice")).toBe(false); expect(world.entities.has("player:alice")).toBe(false);
    expect(server.players.has("bob")).toBe(true);
    server.tick(); expect(server.players.has("alice")).toBe(false);
    persistence.commit = vi.fn(async () => ({}));
  });
  it("cancels movement and combat, without allowing another peer to cancel the caller's camp", async () => {
    await request(); await request(bob, { cancel: true, actorId: "player:alice" });
    expect(messages.filter(m => m.t === "camp" && m.remaining === null)).toHaveLength(0);
    alice.sendCommand({ t: "input", v: [1, 0], jump: false }); await flush();
    expect(messages).toContainEqual({ t: "camp", remaining: null, reason: "Camp cancelled by movement." });
    alice.sendCommand({ t: "input", v: [0, 0] }); await flush();
    await request();
    world.netState.set(transferLockKey("player:alice"), world.timeMs + 5000); server.tick(); await flush();
    expect(messages).toContainEqual({ t: "camp", remaining: null, reason: "Camp cancelled by combat." });
    advance(21); await flush(); expect(messages.some(m => m.t === "logout")).toBe(false); expect(server.players.has("alice")).toBe(true);
  });
  it("keeps the player connected if saving fails", async () => {
    persistence.commit = vi.fn(async () => { throw Error("database unavailable"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await request(); advance(20.1); await flush();
    expect(server.players.has("alice")).toBe(true); expect(messages.some(m => m.t === "logout")).toBe(false);
    expect(messages.some(m => m.t === "camp" && m.remaining === null && m.reason?.includes("could not be saved"))).toBe(true);
    warn.mockRestore(); persistence.commit = vi.fn(async () => ({}));
  });
  it("uses a full 60-second disconnect grace rather than treating bye as a successful camp", async () => {
    await request(); alice.leave(); await flush(); server.tick(); await flush();
    advance(59); expect(server.players.has("alice")).toBe(true);
    expect(messages.some(m => m.t === "logout")).toBe(false);
    advance(1.2); await flush(); expect(server.players.has("alice")).toBe(false);
  });
  it("returns the same body on a reconnect inside the 60-second window", async () => {
    const original = server.players.get("alice"); alice.leave(); await flush(); server.tick(); advance(40);
    // A hello from the same authenticated peer reclaims its existing body.
    alice = new RoomClient(aliceTransport, "host"); alice.join("Alice"); await flush(); server.tick(); await flush();
    expect(server.players.get("alice")).toBe(original); expect(original!.disconnectedAt).toBeNull();
  });
});
