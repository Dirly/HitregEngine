import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { LoopbackHub, RoomClient, type Transport } from "@hitreg/net";
import {
  GameServer,
  HeadlessWorld,
  TerrainStreamer,
  defaultEvents,
  defaultRegistry,
  defaultScripts,
  loadContent,
  loadProjectScripts,
  playgroundRoots,
  resolveServerVoxelWorld,
  WORLD_MODULE,
  type WorldModuleMessage,
} from "../src/index.js";

/**
 * The combat-demo `field` scene (a streamed voxel world + the combat roster)
 * hosted headless: a client joins over the in-memory hub, gets a body, walks,
 * and lands a cast on a dummy — the whole movement + combat loop with no
 * browser in the room.
 *
 * Skipped when the project is not checked out (it is gitignored).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const content = loadContent(playgroundRoots(playground));
const field = content.scenes.get("field");

const flush = async (hub: LoopbackHub, n = 3) => {
  for (let i = 0; i < n; i++) {
    hub.flush();
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe.skipIf(!field)("combat-demo field, headless", () => {
  let world: HeadlessWorld;
  let server: GameServer;
  let hub: LoopbackHub;
  let clientTransport: Transport;
  let client: RoomClient;
  const snapshots: unknown[] = [];
  const worldMsgs: WorldModuleMessage[] = [];
  const stateSyncs: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    const registry = defaultRegistry();
    const events = defaultEvents();
    const scripts = defaultScripts();
    const report = await loadProjectScripts(content.scriptDirs, scripts, events, content.assets);
    expect(report.registered).toContain("combat-actor");
    expect(report.registered).toContain("combat-caster");
    expect(report.registered).toContain("dummy-brain");
    world = await HeadlessWorld.create({
      doc: field!,
      assets: content.assets,
      registry,
      events,
      scripts,
      exclude: (_id, e) => e.tags.includes("player"),
    });
    const voxel = resolveServerVoxelWorld(world.base, 1);
    expect(voxel).not.toBeNull();
    const terrain = new TerrainStreamer(world, voxel!, { loadsPerStep: 4 });
    hub = new LoopbackHub({ manualFlush: true });
    const hostTransport = hub.connect("server");
    server = new GameServer({ world, transport: hostTransport, terrain, snapshotEvery: 1, reconnectGraceSeconds: 0 });
    clientTransport = hub.connect("p-alice");
    client = new RoomClient(clientTransport, "server");
    client.onSnapshot((s) => snapshots.push(s.state));
    client.onModule(WORLD_MODULE, (m) => worldMsgs.push(m as WorldModuleMessage));
    client.onState((sync) => {
      if (sync.full) stateSyncs.push(sync.full);
    });
    client.join("Alice");
    await flush(hub);
  }, 60_000);

  afterAll(() => {
    server?.close();
    world?.dispose();
  });

  it("boots the roster without the scene's own player", () => {
    expect(world.findByTag("player")).toEqual([]);
    expect(world.entities.has("hero0")).toBe(true);
    expect(world.entities.has("dummy0")).toBe(true);
    // combat-actor wrote the dummies' pools on start
    expect(world.netState.get("combat/dummy0.hp")).toBe(400);
  });

  it("spawns a body for the joiner, sends the docs, and streams ground under it", async () => {
    expect(client.state).toBe("joined");
    server.tick();
    await flush(hub);
    const bodyId = "player:p-alice";
    expect(world.entities.has(bodyId)).toBe(true);
    expect(world.findByTag("player")).toEqual([bodyId]);
    // children came along, re-pointed at the new body
    const caster = world.entities.get(`${bodyId}/player-caster`);
    expect((caster?.components["script"] as { params: { actor: string } }).params.actor).toBe(bodyId);
    // the server body has no client controller; the client doc keeps it
    expect(world.entities.get(bodyId)?.components["script"]).toBeUndefined();
    const spawnMsg = worldMsgs.find((m) => m.t === "spawn" && m.self === bodyId);
    expect(spawnMsg).toBeDefined();
    const clientBody = (spawnMsg as { entities: Record<string, { components: Record<string, unknown> }> }).entities[bodyId]!;
    expect((clientBody.components["script"] as { name: string }).name).toBe("third-person-controller");
    // ownership in netState, and the joiner got a full state sync
    expect(world.netState.get(`owner/${bodyId}`)).toBe("p-alice");
    expect(world.netState.get("player/p-alice")).toBe(bodyId);
    expect(stateSyncs.length).toBeGreaterThan(0);
    expect(world.netState.get(`combat/${bodyId}.hp`)).toBe(220);
    // terrain colliders exist around the spawn
    expect(server.terrain!.cells().length).toBeGreaterThan(0);
  });

  it("moves the body from movement intent and reports it back", async () => {
    const before = world.positionOf("player:p-alice")!;
    // let it settle onto the ground first
    for (let i = 0; i < 30; i++) server.tick();
    const settled = world.positionOf("player:p-alice")!;
    expect(settled[1]).toBeGreaterThan(before[1] - 10); // did not fall through the world
    for (let i = 0; i < 60; i++) {
      client.sendCommand({ t: "input", seq: i + 1, v: [4, 0], jump: false, yaw: 0.5, p: settled });
      await flush(hub, 1);
      server.tick();
    }
    await flush(hub);
    const after = world.positionOf("player:p-alice")!;
    expect(after[0] - settled[0]).toBeGreaterThan(2);
    const last = snapshots[snapshots.length - 1] as { players: Record<string, { position: number[]; seq: number }>; entities: { managed: string[] } };
    expect(last.players["p-alice"]!.position[0]).toBeCloseTo(after[0], 1);
    expect(last.players["p-alice"]!.seq).toBe(60);
    // own body is never in the managed (suspend) set; NPCs are
    expect(last.entities.managed).not.toContain("player:p-alice");
    expect(last.entities.managed).toContain("hero0");
    // speed is clamped: a claimed 100 m/s intent moves at the sprint cap at most
    const p0 = world.positionOf("player:p-alice")!;
    for (let i = 0; i < 60; i++) {
      client.sendCommand({ t: "input", seq: 100 + i, v: [100, 0], jump: false, yaw: 0, p: p0 });
      await flush(hub, 1);
      server.tick();
    }
    const p1 = world.positionOf("player:p-alice")!;
    expect(p1[0] - p0[0]).toBeLessThan(11); // 60 ticks = 1s; sprint ~9.5 m/s * 1.05
  });

  it("validates a cast request from the owner and damages a dummy", async () => {
    const bodyId = "player:p-alice";
    // stand the player right next to dummy0 and aim at it
    const dummy = world.positionOf("dummy0")!;
    world.sim.setPosition(bodyId, [dummy[0] - 1.5, dummy[1] + 0.2, dummy[2]]);
    for (let i = 0; i < 5; i++) server.tick();
    const hpBefore = world.netState.get("combat/dummy0.hp") as number;
    client.sendCommand({
      t: "event",
      name: "combat.cast.request",
      payload: { casterId: bodyId, abilityId: "strike", aim: [1, 0] },
    });
    await flush(hub, 1);
    server.tick(); // the request drains this tick: validated, resources spent
    // stamina was spent on the server, not claimed by the client
    expect(world.netState.get(`combat/${bodyId}.stamina`) as number).toBeLessThan(100);
    for (let i = 0; i < 90; i++) server.tick(); // windup + resolve
    const hpAfter = world.netState.get("combat/dummy0.hp") as number;
    expect(hpAfter).toBeLessThan(hpBefore);
  });

  it("drops a cast request naming a body the sender does not own", async () => {
    const hpBefore = world.netState.get("combat/dummy1.hp") as number;
    // hero0 stands wherever it stands; pretend to be it and swing at dummy1
    client.sendCommand({
      t: "event",
      name: "combat.cast.request",
      payload: { casterId: "hero0", abilityId: "strike", aim: [1, 0] },
    });
    await flush(hub, 1);
    const staminaBefore = world.netState.get("combat/hero0.stamina") as number;
    for (let i = 0; i < 30; i++) server.tick();
    expect(world.netState.get("combat/dummy1.hp")).toBe(hpBefore);
    expect(world.netState.get("combat/hero0.stamina") as number).toBeGreaterThanOrEqual(staminaBefore - 0.01);
  });

  it("tears the body down when the peer leaves", async () => {
    client.leave();
    await flush(hub);
    server.tick();
    expect(world.entities.has("player:p-alice")).toBe(false);
    expect(world.netState.get("owner/player:p-alice")).toBeUndefined();
    expect(world.netState.keys("combat/player:p-alice.")).toEqual([]);
  });
});
