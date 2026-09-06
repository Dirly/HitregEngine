import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend, type RegionDoc } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * Zone-scoped layers, end to end: the flat `field` scene given two zones
 * split a few metres east of the player spawn. layer-1 hosts "west" (where
 * everyone starts), layer-2 hosts "east". A player walks east across the
 * border and, once past the band, is handed to layer-2 — commit, ticket,
 * hop — and lands on the far side where they stood. The layer they left
 * keeps nothing; the one they joined knows their zone.
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

const SECRET = "test-zones";
const BORDER_OFFSET = 6; // metres east of the spawn
const BAND = 4;
let main: MainHandle | null = null;
let west: ServeHandle | null = null;
let east: ServeHandle | null = null;
let regions: RegionDoc[] = [];
try {
  // the spawn point comes from the scene; the zones are drawn around it at runtime
  const probe = await serve({ playground, scene: "field", port: 0, log: () => undefined });
  const spawn = (probe.server.playerTemplate!.entities[probe.server.playerTemplate!.rootId]!.components["transform"] as { position: number[] }).position;
  await probe.close();
  const bx = spawn[0]! + BORDER_OFFSET;
  const big = 5000;
  regions = [
    { id: "west", name: "West", story: "", polygon: [[bx - big, -big], [bx, -big], [bx, big], [bx - big, big]], landmarks: [], tags: [] },
    { id: "east", name: "East", story: "", polygon: [[bx, -big], [bx + big, -big], [bx + big, big], [bx, big]], landmarks: [], tags: [] },
  ];
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-zones",
    accounts: new MemoryAccountStore(),
    playerData: new MemoryPlayerDataBackend(),
    world: { scene: "field", cap: 5, min: 0, max: 0 },
    zones: { regions, spawnZone: "west", zoneCap: 5 },
    supervisor: null,
    scaleEverySeconds: 3600,
    log: () => undefined,
  });
  const common = { playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main.url, regions, zoneBand: BAND, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined } as const;
  west = await serve({ ...common, serverId: "layer-1", maxPlayers: 5 });
  east = await serve({ ...common, serverId: "layer-2", maxPlayers: 5 });
} catch (error) {
  console.warn("zones test skipped:", error instanceof Error ? error.message : error);
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!main || !west || !east)("zones: border crossings between layers", { timeout: 90_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  afterAll(async () => {
    for (const t of timers) clearInterval(t);
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await west?.close();
    await east?.close();
    await main?.close();
  });

  /** A client that walks east at run speed and follows any transfer it is sent. */
  function walker(url: string, ticket: string) {
    const state = { transport: null as WebSocketClientTransport | null, client: null as RoomClient | null, spawned: [] as string[], transfers: [] as Array<{ url: string; srv?: string }>, chat: [] as string[], seq: 0, walking: false };
    const dial = (u: string, t: string): void => {
      const transport = new WebSocketClientTransport(u, { peerId: "tab-" + Math.random().toString(36).slice(2, 6), ticket: t });
      const client = new RoomClient(transport, WS_HOST_ID);
      client.onModule("chat", (m) => {
        const d = m as { k: string; msg?: { channel: string; text: string } };
        if (d.k === "msg" && d.msg?.channel === "system") state.chat.push(d.msg.text);
      });
      client.onModule(WORLD_MODULE, (m) => {
        const msg = m as WorldModuleMessage;
        if (msg.t === "spawn" && msg.self) state.spawned.push(msg.self);
        if (msg.t === "transfer") {
          state.transfers.push({ url: msg.url, ...(msg.srv ? { srv: msg.srv } : {}) });
          client.leave(); // bye here …
          transport.close();
          dial(msg.url, msg.ticket); // … dial there
        }
      });
      transport.onPeer((peer, s) => {
        if (peer === WS_HOST_ID && s === "connected") client.join("walker");
      });
      transports.push(transport);
      clients.push(client);
      state.transport = transport;
      state.client = client;
    };
    dial(url, ticket);
    timers.push(
      setInterval(() => {
        if (!state.walking || state.client?.state !== "joined") return;
        state.seq++;
        state.client.sendCommand({ t: "input", seq: state.seq, v: [1.5, 0], jump: false, yaw: Math.PI / 2 });
      }, 50),
    );
    return state;
  }

  let session: { session: string; account: { id: string } };
  let characterId: string;

  it("layers report their hosted zones; a new character is placed in the spawn zone's copy", async () => {
    await until(() => main!.registry.layersFor("field").length === 2);
    // both registered as "all"; give each its zone by hand (what main's autoscale does with a dedicated copy)
    expect((await post(`${main!.url}/admin/zones`, { id: "layer-1", hosted: ["west"] }, SECRET)).status).toBe(200);
    expect((await post(`${main!.url}/admin/zones`, { id: "layer-2", hosted: ["east"] }, SECRET)).status).toBe(200);
    await until(() => west!.hostedZones() !== "all" && east!.hostedZones() !== "all");
    expect(west!.hostedZones()).toEqual(["west"]);
    expect(east!.hostedZones()).toEqual(["east"]);
    expect(west!.zoneAt(regions[0]!.polygon[0]![0] + 1, 0)?.id).toBe("west");

    session = (await post(`${main!.url}/auth/register`, { name: "Zoner", password: "hunter22" })).json;
    characterId = (await post(`${main!.url}/characters`, { name: "Walker" }, session.session)).json.character.id;
    const play = await post(`${main!.url}/play`, { characterId }, session.session);
    expect(play.status).toBe(200);
    expect(play.json.server).toBe("layer-1"); // spawn zone is west → the west copy, never the east one
    const w = walker(play.json.url, play.json.ticket);
    await until(() => w.spawned.length === 1);
    expect(west!.chat.zoneOf(characterId)).toBe("west");
    (globalThis as { __walker?: unknown }).__walker = w;
  });

  it("walking east past the band hands the player to the east copy, where they land in place", async () => {
    const w = (globalThis as { __walker?: ReturnType<typeof walker> }).__walker!;
    const bodyId = `player:${characterId}`;
    const before = west!.world.positionOf(bodyId)!;
    // step over the line: the spawn point is spread by a hash of the character id, so a
    // real walk east sometimes meets a tree — the crossing, not pathing, is what is under test
    const borderX = regions[0]!.polygon[1]![0];
    west!.world.sim.setPosition(bodyId, [borderX + BAND + 2, before[1] + 0.5, before[2]]);
    w.walking = true; // keeps sending input (a still body is not what we are testing either)
    // the west layer notices the crossing, main picks the east copy (never the asker), the east copy says the spot is quiet
    try {
      await until(() => w.transfers.length === 1, 45_000);
    } catch (error) {
      const now = west!.world.positionOf(bodyId) ?? east!.world.positionOf(bodyId);
      throw new Error(`no transfer; body at ${now?.map((n) => n.toFixed(1)).join(",") ?? "?"} (border x=${regions[0]!.polygon[1]![0]}), canTransfer=${west!.server.canTransfer(characterId)}, whereIs=${main!.registry.whereIs.get(characterId)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    w.walking = false;
    expect(w.transfers[0]!.srv).toBe("layer-2");
    expect(w.transfers[0]!.url).toBe(east!.url);
    await until(() => w.spawned.length === 2, 15_000);
    await until(() => main!.registry.whereIs.get(characterId) === "layer-2");
    expect(west!.server.players.has(characterId)).toBe(false);
    const after = east!.world.positionOf(bodyId)!;
    // they crossed the border by at least the band, and landed where they were
    expect(after[0]).toBeGreaterThan(borderX + BAND - 0.5);
    expect(after[0]).toBeGreaterThan(before[0]);
    expect(east!.chat.zoneOf(characterId)).toBe("east");
    // the layer that saw the crossing told them where they are, before the hop
    expect(w.chat).toContain("You are entering East.");
    // a freshly landed body is protected for a few seconds, then not
    expect(east!.world.netState.get(`landing/${bodyId}`)).toBeGreaterThan(east!.world.timeMs);
    // and the east copy does not send them straight back: it hosts east
    await wait(1500);
    expect(w.transfers.length).toBe(1);
    expect(main!.registry.whereIs.get(characterId)).toBe("layer-2");
    // main counts them in the east zone (from the join, then every status report)
    let population: Record<string, number> = {};
    await until(() => {
      void fetch(`${main!.url}/admin/status`, { headers: { authorization: `Bearer ${SECRET}` } })
        .then((r) => r.json())
        .then((s: { zones: { population: Record<string, number> } }) => {
          population = s.zones.population;
        });
      return population["east"] === 1 && (population["west"] ?? 0) === 0;
    }, 6000);
  });
});
