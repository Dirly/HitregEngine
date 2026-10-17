import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend, type RegionDoc } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import type { Supervisor } from "../src/main/supervisor.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * A border crossing into a zone nobody hosts yet starts ONE copy of that zone.
 * The crossing layer re-asks main every 2 s while that copy boots; main must
 * wait for the copy it is already booting, not start another per ask (a live
 * skelmorrow crossing started three rustmarch copies, 2026-10-12). The fake
 * supervisor boots each copy in-process after a delay longer than the re-ask.
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

const SECRET = "test-zone-boot";
const BAND = 4;
const BOOT_DELAY_MS = 5000;
let main: MainHandle | null = null;
let west: ServeHandle | null = null;
const copies: ServeHandle[] = [];
const spawned: Array<{ id: string; zones: unknown }> = [];
let regions: RegionDoc[] = [];
let common: Record<string, unknown> = {};
try {
  const probe = await serve({ playground, scene: "field", port: 0, log: () => undefined });
  const spawn = (probe.server.playerTemplate!.entities[probe.server.playerTemplate!.rootId]!.components["transform"] as { position: number[] }).position;
  await probe.close();
  const bx = spawn[0]! + 6;
  const big = 5000;
  regions = [
    { id: "west", name: "West", story: "", polygon: [[bx - big, -big], [bx, -big], [bx, big], [bx - big, big]], landmarks: [], tags: [] },
    { id: "east", name: "East", story: "", polygon: [[bx, -big], [bx + big, -big], [bx + big, big], [bx, big]], landmarks: [], tags: [] },
  ];
  const supervisor = {
    spawn: (_kind: string, _scene: string, id: string, options: { zones?: unknown } = {}) => {
      if (!options.zones) return { id }; // main's own first layer: this test serves layer-1 in-process itself
      spawned.push({ id, zones: options.zones });
      setTimeout(() => {
        void serve({ ...(common as object), serverId: id, maxPlayers: 5 } as Parameters<typeof serve>[0]).then((h) => copies.push(h));
      }, BOOT_DELAY_MS);
      return { id };
    },
    list: () => [],
  } as unknown as Supervisor;
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-zone-boot",
    accounts: new MemoryAccountStore(),
    playerData: new MemoryPlayerDataBackend(),
    world: { scene: "field", cap: 5, min: 0, max: 4 },
    zones: { regions, spawnZone: "west", zoneCap: 5 },
    supervisor,
    scaleEverySeconds: 3600,
    log: () => undefined,
  });
  common = { playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main.url, regions, zoneBand: BAND, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined };
  west = await serve({ ...(common as object), serverId: "layer-1", maxPlayers: 5 } as Parameters<typeof serve>[0]);
} catch (error) {
  console.warn("zone-copy-boot test skipped:", error instanceof Error ? error.message : error);
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!main || !west)("zones: a crossing into an unhosted zone boots one copy", { timeout: 90_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await west?.close();
    for (const c of copies) await c.close();
    await main?.close();
  });

  it("re-asks while the copy boots start no further copies", async () => {
    await until(() => main!.registry.layersFor("field").length === 1);
    expect((await post(`${main!.url}/admin/zones`, { id: "layer-1", hosted: ["west"] }, SECRET)).status).toBe(200);
    await until(() => west!.hostedZones() !== "all");
    const session = (await post(`${main!.url}/auth/register`, { name: "Booter", password: "hunter22" })).json;
    const characterId = (await post(`${main!.url}/characters`, { name: "Crosser" }, session.session)).json.character.id;
    const play = await post(`${main!.url}/play`, { characterId }, session.session);
    expect(play.json.server).toBe("layer-1");
    const transfers: string[] = [];
    let spawns = 0;
    const dial = (url: string, ticket: string): void => {
      const transport = new WebSocketClientTransport(url, { peerId: "tab-" + Math.random().toString(36).slice(2, 6), ticket });
      const client = new RoomClient(transport, WS_HOST_ID);
      client.onModule(WORLD_MODULE, (m) => {
        const msg = m as WorldModuleMessage;
        if (msg.t === "spawn" && msg.self) spawns++;
        if (msg.t === "transfer") {
          transfers.push(msg.srv ?? "?");
          client.leave();
          transport.close();
          dial(msg.url, msg.ticket);
        }
      });
      transport.onPeer((peer, s) => { if (peer === WS_HOST_ID && s === "connected") client.join("crosser"); });
      transports.push(transport);
      clients.push(client);
    };
    dial(play.json.url, play.json.ticket);
    await until(() => spawns === 1);
    const bodyId = `player:${characterId}`;
    const before = west!.world.positionOf(bodyId)!;
    west!.world.sim.setPosition(bodyId, [regions[0]!.polygon[1]![0] + BAND + 2, before[1] + 0.5, before[2]]);
    await until(() => transfers.length === 1, 45_000);
    expect(spawned.length, JSON.stringify(spawned)).toBe(1);
    expect(spawned[0]!.zones).toEqual(["east"]);
    expect(transfers[0]).toBe(spawned[0]!.id);
    await wait(2500);
    expect(spawned.length).toBe(1);
  });
});
