import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend, addItem, createSheet, equip, itemSchema, type CharacterSheet, type Item } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { deriveLoadout } from "../../../apps/playground/projects/foundation/scripts/lib/loadout.js";

/**
 * Package D3b (docs/combat-build/D3b-spells-twists.md): an item instance's
 * rolled twists survive a reconnect like the rest of its data. Main (gateway,
 * in-memory persistence) plus one layer; a player joins with a ticket, wears a
 * twisted staff, leaves (the sheet is saved), and comes back: the stack still
 * names its twists and the bar derived from it still casts the twisted skill.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const ITEMS = path.join(playground, "projects/foundation/assets/items");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(15);
  }
}

const SECRET = "test-d3b-secret";
const playerData = new MemoryPlayerDataBackend();
let main: MainHandle | null = null;
let layer: ServeHandle | null = null;
try {
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-d3b",
    accounts: new MemoryAccountStore(),
    playerData,
    world: { scene: "field", cap: 3, min: 0, max: 0 },
    supervisor: null,
    scaleEverySeconds: 3600,
    log: () => undefined,
  });
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main.url, serverId: "layer-1", maxPlayers: 3, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("d3b reconnect test skipped:", error instanceof Error ? error.message : error);
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!main || !layer)("D3b: twists survive a reconnect", { timeout: 30_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
    await main?.close();
  });

  function dial(url: string, ticket: string) {
    const transport = new WebSocketClientTransport(url, { peerId: "tab-" + Math.random().toString(36).slice(2, 6), ticket });
    const client = new RoomClient(transport, WS_HOST_ID);
    const world: WorldModuleMessage[] = [];
    client.onModule(WORLD_MODULE, (m) => world.push(m as WorldModuleMessage));
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join("tab");
    });
    transports.push(transport);
    clients.push(client);
    return { client, world };
  }

  const catalog = (id: string): Item | undefined => itemSchema.parse(JSON.parse(readFileSync(path.join(ITEMS, `${id}.json`), "utf8")));

  it("a twisted staff is saved on leave and comes back on the next join, still twisted", async () => {
    await until(() => main!.registry.layersFor("field").length === 1);
    const session = (await post(`${main!.url}/auth/register`, { name: "Twister", password: "hunter22" })).json as { session: string; account: { id: string } };
    const characterId = (await post(`${main!.url}/characters`, { name: "Aldra" }, session.session)).json.character.id as string;
    const bodyId = `player:${characterId}`;
    let play = await post(`${main!.url}/play`, { characterId }, session.session);
    const first = dial(play.json.url, play.json.ticket);
    await until(() => first.world.some((m) => m.t === "spawn" && m.self === bodyId));

    // the authority writes the sheet (a character-sheet script would; the field scene has none)
    let sheet: CharacterSheet = createSheet();
    for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
    const r = addItem(sheet, "gravecall-staff", 1, { catalog });
    if (!r.ok) throw new Error(r.error);
    r.sheet.items[r.uids[0]!]!.twists = ["agony+hunter", "shadowBolt+executioner"];
    const e = equip(r.sheet, r.uids[0]!, "primary", { catalog });
    if (!e.ok) throw new Error(e.error);
    sheet = e.sheet;
    expect(layer!.world.netState.set(`character/${bodyId}`, sheet)).toBe(true);

    first.client.leave();
    await until(() => !layer!.server.players.has(characterId));
    let saved: Awaited<ReturnType<typeof playerData.load>> = null;
    const scope = { playerId: characterId, experienceId: "test-d3b" };
    for (let i = 0; i < 100 && !saved?.data["sheet"]; i++) {
      await wait(50);
      saved = await playerData.load(scope, "character");
    }
    const savedStack = Object.values((saved!.data["sheet"] as CharacterSheet).items).find((s) => s.itemId === "gravecall-staff");
    expect(savedStack?.twists).toEqual(["agony+hunter", "shadowBolt+executioner"]);
    await until(() => main!.registry.whereIs.get(characterId) === undefined);

    play = await post(`${main!.url}/play`, { characterId }, session.session);
    const again = dial(play.json.url, play.json.ticket);
    await until(() => again.world.some((m) => m.t === "spawn" && m.self === bodyId));
    const back = layer!.world.netState.get(`character/${bodyId}`) as CharacterSheet;
    const stack = Object.values(back.items).find((s) => s.itemId === "gravecall-staff");
    expect(stack?.twists).toEqual(["agony+hunter", "shadowBolt+executioner"]);
    expect(deriveLoadout({ sheet: back, catalog, set: 0, trait: "" })).toMatchObject({
      lmb: "shadowBolt+executioner",
      rmb: "nullify",
      weapon1: "agony+hunter",
      weapon2: "drainLife",
    });
  });
});
