import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { poiSchema, SANCTUARIES_KEY, type PoiDoc, type RegionDoc } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * Sanctuaries and zone crossings on one layer, over real sockets
 * (docs/world-editing/barriers.md → "Runtime"): the flat `field` scene is
 * given two zones split east of the spawn and one waystation sanctuary ON
 * the spawn. The layer publishes `sanctuaries/list`; voxel-demo's
 * combat-actor refuses a player-on-player hit while either body stands in
 * the circle, still takes an NPC's hit there, and damages normally outside;
 * a body that walks into the other zone gets a `zone.entered` event and a
 * "you are entering" chat line.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(20);
  }
}

const BORDER_OFFSET = 60;
const RADIUS = 35;
let layer: ServeHandle | null = null;
let spawn: number[] = [0, 0, 0];
let regions: RegionDoc[] = [];
let pois: PoiDoc[] = [];
try {
  const probe = await serve({ playground, scene: "field", port: 0, log: () => undefined });
  spawn = (probe.server.playerTemplate!.entities[probe.server.playerTemplate!.rootId]!.components["transform"] as { position: number[] }).position;
  await probe.close();
  const bx = spawn[0]! + BORDER_OFFSET;
  const big = 5000;
  regions = [
    { id: "west", name: "West Marches", story: "", polygon: [[bx - big, -big], [bx, -big], [bx, big], [bx - big, big]], landmarks: [], tags: [] },
    { id: "east", name: "East Fells", story: "", polygon: [[bx, -big], [bx + big, -big], [bx + big, big], [bx, big]], landmarks: [], tags: [] },
  ];
  pois = [
    poiSchema.parse({ id: "pass-west-east-1", kind: "waystation", position: [spawn[0], spawn[1], spawn[2]], radius: RADIUS, tags: ["pass", "safe", "zone:west", "zone:east"] }),
    poiSchema.parse({ id: "peak-1", kind: "peak", position: [900, 200, 900], tags: [] }),
  ];
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", regions, pois, respawnSeconds: 0, reconnectGraceSeconds: 1, log: () => undefined });
} catch (error) {
  console.warn("sanctuary test skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!layer)("sanctuaries and zone crossings on a layer", { timeout: 60_000 }, () => {
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
    const chat: Array<{ channel: string; text: string }> = [];
    client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "spawn" && msg.self) spawned.push(msg.self);
    });
    client.onModule("chat", (m) => {
      const d = m as { k: string; msg?: { channel: string; text: string } };
      if (d.k === "msg" && d.msg) chat.push(d.msg);
    });
    transport.onPeer((peer, s) => {
      if (peer === WS_HOST_ID && s === "connected") client.join(peerId);
    });
    transports.push(transport);
    clients.push(client);
    return { client, spawned, chat };
  }

  const hp = (bodyId: string): number => layer!.world.netState.get(`combat/${bodyId}.hp`) as number;
  const hit = (targetId: string, sourceId: string): void => {
    layer!.world.eventBus.emit("combat.damage", { targetId, sourceId, amount: 50, control: 0, point: [0, 1, 0] });
  };

  let a: ReturnType<typeof join>;
  let b: ReturnType<typeof join>;
  const bodyA = "player:alice";
  const bodyB = "player:bob";

  it("publishes every safe poi as a sanctuary circle at boot", async () => {
    expect(layer!.sanctuaries).toEqual([[spawn[0], spawn[2], RADIUS, spawn[1]]]);
    expect(layer!.world.netState.get(SANCTUARIES_KEY)).toEqual([[spawn[0], spawn[2], RADIUS, spawn[1]]]);
    a = join("alice");
    b = join("bob");
    await until(() => a.spawned.length === 1 && b.spawned.length === 1);
    expect(a.spawned[0]).toBe(bodyA);
    expect(layer!.world.netState.get(`owner/${bodyA}`)).toBe("alice");
    await until(() => typeof hp(bodyA) === "number" && typeof hp(bodyB) === "number"); // the combat-actor scripts seeded their bars
  });

  it("refuses a player-on-player hit while either stands in the sanctuary, but not an NPC's", async () => {
    const before = hp(bodyA);
    expect(before).toBeGreaterThan(0);
    hit(bodyA, bodyB); // both on the spawn, inside the circle
    await wait(400);
    expect(hp(bodyA)).toBe(before);
    // the attacker steps out, the target stays in: still refused
    layer!.world.sim.setPosition(bodyB, [spawn[0]! + RADIUS + 10, spawn[1]! + 0.5, spawn[2]!]);
    await wait(300);
    hit(bodyA, bodyB);
    await wait(400);
    expect(hp(bodyA)).toBe(before);
    // an NPC hits a player inside the circle: lands (hero0 is authored in the field scene, no owner)
    expect(layer!.world.netState.get("owner/hero0")).toBeUndefined();
    hit(bodyA, "hero0");
    await until(() => hp(bodyA) < before, 5000);
    expect(hp(bodyA)).toBeCloseTo(before - 50, 0);
  });

  it("damages normally once both are outside, and announces the zone a body walks into", async () => {
    const out = spawn[0]! + BORDER_OFFSET + 30; // past the border, well outside the circle
    const events: Array<{ bodyId: string; zone: string; from: string | null }> = [];
    layer!.world.eventBus.on("zone.entered", (payload) => events.push(payload as { bodyId: string; zone: string; from: string | null }));
    layer!.world.sim.setPosition(bodyA, [out, spawn[1]! + 0.5, spawn[2]!]);
    layer!.world.sim.setPosition(bodyB, [out + 3, spawn[1]! + 0.5, spawn[2]!]);
    await until(() => events.length >= 2, 8000);
    expect(events.map((e) => e.zone)).toEqual(["east", "east"]);
    expect(events[0]!.from).toBe("west");
    await until(() => a.chat.some((m) => m.channel === "system" && m.text === "You are entering East Fells."), 5000);
    expect(b.chat.filter((m) => m.text.startsWith("You are entering"))).toHaveLength(1);
    expect(layer!.chat.zoneOf("alice")).toBe("east");
    const before = hp(bodyA);
    hit(bodyA, bodyB);
    await until(() => hp(bodyA) < before, 5000);
    expect(hp(bodyA)).toBeCloseTo(before - 50, 0);
    // walking back announces the other zone once, not on every tick
    layer!.world.sim.setPosition(bodyA, [spawn[0]!, spawn[1]! + 0.5, spawn[2]!]);
    await until(() => events.length === 3, 8000);
    expect(events[2]).toMatchObject({ bodyId: bodyA, zone: "west", from: "east" });
    await wait(1200);
    expect(events).toHaveLength(3);
  });
});
