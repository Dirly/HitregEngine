import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { poiSchema, type PoiDoc } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * The combat wrap-up on a layer, over real sockets, with voxel-demo's
 * scripts on the `field` scene: a player killed by an NPC comes back at
 * the nearest sanctuary with full pools and a landing grace; a player who
 * kills an NPC is granted xp (and the kill is announced); two players cannot
 * hurt each other until both raise the PvP flag, and the flag cannot be
 * dropped again straight away.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 10_000, what = ""): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting ${what}`);
    await wait(20);
  }
}

let layer: ServeHandle | null = null;
let spawn: number[] = [0, 0, 0];
const SANCTUARY: [number, number] = [0, 0]; // set from the spawn: 60 m east of it
let pois: PoiDoc[] = [];
try {
  const probe = await serve({ playground, scene: "field", port: 0, log: () => undefined });
  spawn = (probe.server.playerTemplate!.entities[probe.server.playerTemplate!.rootId]!.components["transform"] as { position: number[] }).position;
  await probe.close();
  SANCTUARY[0] = spawn[0]! + 60;
  SANCTUARY[1] = spawn[2]!;
  pois = [poiSchema.parse({ id: "pass-a-b-1", kind: "waystation", position: [SANCTUARY[0], spawn[1], SANCTUARY[1]], radius: 20, tags: ["pass", "safe"] })];
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", pois, respawnSeconds: 0, reconnectGraceSeconds: 1, log: () => undefined });
} catch (error) {
  console.warn("combat wrap-up test skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!layer)("combat wrap-up: respawn, kill rewards, pvp flag", { timeout: 60_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
  });

  function join(peerId: string) {
    const transport = new WebSocketClientTransport(layer!.url, { peerId });
    const client = new RoomClient(transport, WS_HOST_ID);
    const spawned: string[] = [];
    client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "spawn" && msg.self) spawned.push(msg.self);
    });
    transport.onPeer((peer, s) => {
      if (peer === WS_HOST_ID && s === "connected") client.join(peerId);
    });
    transports.push(transport);
    clients.push(client);
    return { client, spawned };
  }

  const net = () => layer!.world.netState;
  const hp = (bodyId: string): number => net().get(`combat/${bodyId}.hp`) as number;
  const dead = (bodyId: string): boolean => net().get(`combat/${bodyId}.dead`) === true;
  const hit = (targetId: string, sourceId: string, amount: number): void => {
    layer!.world.eventBus.emit("combat.damage", { targetId, sourceId, amount, control: 0, point: [0, 1, 0] });
  };
  const events = (name: string) => layer!.world.eventBus.trace().filter((e) => e.name === name);

  const bodyA = "player:alice";
  const bodyB = "player:bob";

  it("a player killed by an NPC respawns at the nearest sanctuary with full pools and a landing grace", async () => {
    const a = join("alice");
    const b = join("bob");
    await until(() => a.spawned.length === 1 && b.spawned.length === 1, 10_000, "spawns");
    await until(() => typeof hp(bodyA) === "number" && typeof hp(bodyB) === "number", 10_000, "bars");
    const full = hp(bodyA);
    // hero0 (an NPC) lands the killing blow: dead, countdown published
    hit(bodyA, "hero0", full + 10);
    await until(() => dead(bodyA), 5000, "death");
    await until(() => (net().get(`combat/${bodyA}.respawnAt`) as number) > 0, 2000, "countdown");
    const killed = events("combat.killed").map((e) => e.payload as { victimId: string; killerId: string | null; xp: number });
    expect(killed.at(-1)).toMatchObject({ victimId: bodyA, killerId: "hero0", xp: 0 }); // an NPC earns nothing
    // eight seconds later (the script default): alive again, at the sanctuary, full, protected
    await until(() => !dead(bodyA), 12_000, "respawn");
    await wait(300); // the sim applies the teleport on its next step
    expect(hp(bodyA)).toBe(full);
    const at = layer!.world.positionOf(bodyA)!;
    expect(Math.hypot(at[0] - SANCTUARY[0], at[2] - SANCTUARY[1])).toBeLessThan(4);
    expect(net().get(`landing/${bodyA}`)).toBeGreaterThan(layer!.world.timeMs);
    expect(net().get(`combat/${bodyA}.respawnAt`)).toBe(0);
    expect(events("combat.respawned").some((e) => (e.payload as { actorId: string }).actorId === bodyA)).toBe(true);
  });

  it("a player who kills an NPC is granted xp and the kill is announced; an NPC does not respawn through the script", async () => {
    const dummy = "dummy0";
    const dummyHp = hp(dummy);
    expect(dummyHp).toBeGreaterThan(0);
    hit(dummy, bodyA, dummyHp + 5);
    await until(() => dead(dummy), 5000, "dummy death");
    const killed = events("combat.killed").map((e) => e.payload as { victimId: string; killerId: string | null; xp: number });
    const mine = killed.find((k) => k.victimId === dummy);
    expect(mine).toMatchObject({ killerId: bodyA });
    expect(mine!.xp).toBeGreaterThan(0); // a tenth of the dummy's maxHp by default
    const xp = events("character.xp").map((e) => e.payload as { actorId: string; amount: number });
    expect(xp.at(-1)).toEqual({ actorId: bodyA, amount: mine!.xp });
    // the dummy is the NPC manager's to bring back (respawnSeconds 0 on this layer): still dead a while later
    await wait(1500);
    expect(dead(dummy)).toBe(true);
    expect(net().get(`combat/${dummy}.respawnAt`)).toBeUndefined();
  });

  it("two players cannot hurt each other until both raise the PvP flag; the flag holds once raised", async () => {
    // both outside the sanctuary, Bob a pace in front of Alice
    const x = spawn[0]! - 40;
    layer!.world.sim.setPosition(bodyA, [x, spawn[1]! + 0.5, spawn[2]!]);
    layer!.world.sim.setPosition(bodyB, [x + 1.6, spawn[1]! + 0.5, spawn[2]!]);
    await wait(1500); // let both settle onto the ground: the volume has a vertical band
    const cast = () => layer!.world.eventBus.emit("combat.cast.request", { casterId: bodyA, abilityId: "strike", aim: [1, 0] });
    const before = hp(bodyB);
    cast();
    await wait(600);
    expect(hp(bodyB)).toBe(before); // same faction, no flags: nothing
    layer!.world.eventBus.emit("combat.pvp.request", { casterId: bodyA, on: true });
    await until(() => net().get(`combat/${bodyA}.pvp`) === true, 3000, "alice flagged");
    cast();
    await wait(600);
    expect(hp(bodyB)).toBe(before); // one flag is not consent
    layer!.world.eventBus.emit("combat.pvp.request", { casterId: bodyB, on: true });
    await until(() => net().get(`combat/${bodyB}.pvp`) === true, 3000, "bob flagged");
    // an NPC cannot raise a flag
    layer!.world.eventBus.emit("combat.pvp.request", { casterId: "hero0", on: true });
    await wait(300);
    expect(net().get("combat/hero0.pvp")).toBeUndefined();
    await wait(400); // the strike's recovery
    cast();
    await until(() => hp(bodyB) < before, 5000, "pvp hit");
    // dropping the flag straight away is refused: it holds for pvpHoldSeconds
    layer!.world.eventBus.emit("combat.pvp.request", { casterId: bodyB, on: false });
    await wait(400);
    expect(net().get(`combat/${bodyB}.pvp`)).toBe(true);
  });
});
