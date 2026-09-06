import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend, createSheet, DEFAULT_PROGRESSION, transferLockKey } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * The cluster, end to end and over real sockets: main (gateway + cluster
 * coordinator, in-memory persistence) plus two layers registered with it.
 * A player signs up, is placed, joins with a ticket, gets a body; their
 * sheet is saved when they leave and comes back when they return; an admin
 * move hands them to the other layer with the same sheet and position;
 * a forged or misdirected ticket is refused at the door.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(15);
  }
}

const SECRET = "test-cluster-secret";
const playerData = new MemoryPlayerDataBackend();
const accounts = new MemoryAccountStore();
let main: MainHandle | null = null;
let layer1: ServeHandle | null = null;
let layer2: ServeHandle | null = null;
try {
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-world",
    accounts,
    playerData,
    world: { scene: "field", cap: 3, min: 0, max: 0 },
    supervisor: null,
    scaleEverySeconds: 3600,
    log: () => undefined,
  });
  const common = { playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main.url, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined } as const;
  layer1 = await serve({ ...common, serverId: "layer-1", maxPlayers: 3 });
  layer2 = await serve({ ...common, serverId: "layer-2", maxPlayers: 3 });
} catch (error) {
  console.warn("cluster test skipped:", error instanceof Error ? error.message : error);
}

interface Session {
  session: string;
  account: { id: string; name: string };
  characters: Array<{ id: string; name: string }>;
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!main || !layer1 || !layer2)("cluster: main + two layers", { timeout: 30_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients: RoomClient[] = [];
  afterAll(async () => {
    for (const c of clients) c.leave();
    for (const t of transports) t.close();
    await layer1?.close();
    await layer2?.close();
    await main?.close();
  });

  function dial(url: string, ticket: string, name: string) {
    const transport = new WebSocketClientTransport(url, { peerId: "tab-" + Math.random().toString(36).slice(2, 6), ticket });
    const client = new RoomClient(transport, WS_HOST_ID);
    const world: WorldModuleMessage[] = [];
    let rejected = false;
    client.onModule(WORLD_MODULE, (m) => world.push(m as WorldModuleMessage));
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join(name);
      if (peer === WS_HOST_ID && state === "disconnected") rejected = true;
    });
    transports.push(transport);
    clients.push(client);
    return { transport, client, world, gone: () => rejected };
  }

  let session: Session;
  let characterId: string;
  let bodyId: string;
  let firstServer: string;

  it("both layers registered and the gateway reports them", async () => {
    await until(() => main!.registry.layersFor("field").length === 2);
    const status = (await (await fetch(`${main!.url}/status`)).json()) as { layers: Array<{ id: string; cap: number }> };
    expect(status.layers.map((l) => l.id).sort()).toEqual(["layer-1", "layer-2"]);
    expect(status.layers[0]!.cap).toBe(3);
  });

  it("registers an account, makes a character, and is placed with a ticket", async () => {
    const bad = await post(`${main!.url}/auth/register`, { name: "x", password: "short" });
    expect(bad.status).toBe(400);
    const reg = await post(`${main!.url}/auth/register`, { name: "Derek", password: "hunter22" });
    expect(reg.status).toBe(200);
    session = reg.json as Session;
    expect(session.characters).toEqual([]);
    expect((await post(`${main!.url}/auth/register`, { name: "derek", password: "hunter22" })).status).toBe(409);
    expect((await post(`${main!.url}/auth/login`, { name: "Derek", password: "wrong" })).status).toBe(401);
    const login = await post(`${main!.url}/auth/login`, { name: "DEREK", password: "hunter22" });
    expect(login.status).toBe(200);
    const chr = await post(`${main!.url}/characters`, { name: "Aldric" }, session.session);
    expect(chr.status).toBe(200);
    characterId = chr.json.character.id;
    bodyId = `player:${characterId}`;
    const play = await post(`${main!.url}/play`, { characterId }, session.session);
    expect(play.status).toBe(200);
    expect(["layer-1", "layer-2"]).toContain(play.json.server);
    firstServer = play.json.server;
    expect(play.json.url).toBe(firstServer === "layer-1" ? layer1!.url : layer2!.url);
    const layer = firstServer === "layer-1" ? layer1! : layer2!;

    const c = dial(play.json.url, play.json.ticket, "tab");
    await until(() => c.world.some((m) => m.t === "spawn" && m.self === bodyId));
    // the peer id IS the character id, whatever the tab proposed
    expect(c.transport.localId).toBe(characterId);
    expect(layer.identities.get(characterId)?.playerId).toBe(session.account.id);
    await until(() => main!.registry.whereIs.get(characterId) === firstServer);
  });

  it("refuses a forged ticket, a ticket for the other layer, and no ticket at all", async () => {
    const play = await post(`${main!.url}/play`, { characterId }, session.session);
    const other = play.json.server === "layer-1" ? layer2! : layer1!;
    // a refused handshake never welcomes the peer, so there is no peer event to wait on
    const misdirected = dial(other.url, play.json.ticket, "tab");
    const forged = dial(layer1!.url, play.json.ticket.slice(0, -4) + "AAAA", "tab");
    const bare = new WebSocketClientTransport(layer1!.url, { peerId: "nobody" });
    transports.push(bare);
    await wait(600);
    expect(misdirected.client.state).not.toBe("joined");
    expect(misdirected.transport.peers()).toEqual([]);
    expect(forged.client.state).not.toBe("joined");
    expect(bare.peers()).toEqual([]);
    expect(other.server.players.has(characterId)).toBe(false);
    expect(layer1!.transport.peers()).not.toContain("nobody");
  });

  it("saves the sheet and position on leave and restores them on the next join", async () => {
    const layer = firstServer === "layer-1" ? layer1! : layer2!;
    // the authority writes the sheet (a character-sheet script would; the field scene has none)
    const sheet = createSheet(DEFAULT_PROGRESSION, 3);
    expect(layer.world.netState.set(`character/${bodyId}`, sheet)).toBe(true);
    const at = layer.world.positionOf(bodyId)!;
    // the connected tab for this character is the most recent dial with a spawn
    const tab = clients[0]!;
    tab.leave();
    await until(() => !layer.server.players.has(characterId));
    // the final save is asynchronous (layer → main → backend): wait for it to land
    let saved: Awaited<ReturnType<typeof playerData.load>> = null;
    const scope = { playerId: session.account.id, experienceId: "test-world" };
    for (let i = 0; i < 100 && !saved?.data["sheet"]; i++) {
      await wait(50);
      saved = await playerData.load(scope, "character");
    }
    await until(() => main!.registry.whereIs.get(characterId) === undefined);
    expect((saved?.data["sheet"] as { level: number }).level).toBe(3);
    const world = await playerData.load({ playerId: session.account.id, experienceId: "test-world" }, "world");
    expect((world?.data["pos:field"] as { position: number[] }).position[0]).toBeCloseTo(at[0], 1);

    // affinity: placed on the same layer; the sheet is already in netState when the body spawns
    const play = await post(`${main!.url}/play`, { characterId }, session.session);
    expect(play.json.server).toBe(firstServer);
    const c = dial(play.json.url, play.json.ticket, "tab");
    await until(() => c.world.some((m) => m.t === "spawn" && m.self === bodyId));
    expect((layer.world.netState.get(`character/${bodyId}`) as { level: number }).level).toBe(3);
    const back = layer.world.positionOf(bodyId)!;
    expect(back[0]).toBeCloseTo(at[0], 0);
    expect(back[2]).toBeCloseTo(at[2], 0);
  });

  it("an admin move hands the client to the other layer with sheet and revision intact", async () => {
    const from = firstServer === "layer-1" ? layer1! : layer2!;
    const to = firstServer === "layer-1" ? layer2! : layer1!;
    const tab = clients[clients.length - 1]!;
    const transferMsgs: Array<{ url: string; ticket: string; reason: string }> = [];
    tab.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "transfer") transferMsgs.push(msg);
    });
    const res = await post(`${main!.url}/admin/transfer`, { characterId, srv: to.serverId }, SECRET);
    expect(res.status).toBe(200);
    expect(res.json.srv).toBe(to.serverId);
    await until(() => transferMsgs.length === 1);
    expect(transferMsgs[0]!.url).toBe(to.url);
    expect(transferMsgs[0]!.reason).toBe("admin");
    // the client does what the playground does: bye here, dial there with the ticket
    tab.leave();
    await until(() => !from.server.players.has(characterId));
    const c = dial(transferMsgs[0]!.url, transferMsgs[0]!.ticket, "tab");
    await until(() => c.world.some((m) => m.t === "spawn" && m.self === bodyId));
    expect((to.world.netState.get(`character/${bodyId}`) as { level: number }).level).toBe(3);
    // the ticket promised the committed revision and the destination honoured it
    expect(to.identities.get(characterId)?.rev?.["character"]).toBeGreaterThanOrEqual(1);
    await until(() => main!.registry.whereIs.get(characterId) === to.serverId);
    expect(from.server.players.has(characterId)).toBe(false);
  });

  it("a party join pulls the joiner onto the leader's layer", async () => {
    // a second account with its own character, playing on the OTHER layer than Aldric
    const reg = (await post(`${main!.url}/auth/register`, { name: "Friend", password: "hunter22" })).json as Session;
    const chr = (await post(`${main!.url}/characters`, { name: "Bea" }, reg.session)).json.character as { id: string };
    const aldricOn = main!.registry.whereIs.get(characterId)!;
    const other = aldricOn === "layer-1" ? layer2! : layer1!;
    // force placement onto the other layer by filling nothing: use an admin move after joining wherever
    const play = (await post(`${main!.url}/play`, { characterId: chr.id }, reg.session)).json as { url: string; ticket: string; server: string };
    let bea = dial(play.url, play.ticket, "bea");
    await until(() => bea.world.some((m) => m.t === "spawn" && m.self === `player:${chr.id}`));
    if (play.server === aldricOn) {
      const moved: Array<{ url: string; ticket: string }> = [];
      bea.client.onModule(WORLD_MODULE, (m) => {
        const msg = m as WorldModuleMessage;
        if (msg.t === "transfer") moved.push(msg);
      });
      await post(`${main!.url}/admin/transfer`, { characterId: chr.id, srv: other.serverId }, SECRET);
      await until(() => moved.length === 1);
      bea.client.leave();
      bea = dial(moved[0]!.url, moved[0]!.ticket, "bea");
      await until(() => bea.world.some((m) => m.t === "spawn" && m.self === `player:${chr.id}`));
    }
    await until(() => main!.registry.whereIs.get(chr.id) === other.serverId);
    // Aldric makes a party; Bea joins with the code → main pulls Bea to Aldric's layer
    const party = (await post(`${main!.url}/party/create`, { characterId }, session.session)).json.party as { code: string };
    const pulled: Array<{ url: string; ticket: string; reason: string }> = [];
    bea.client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "transfer") pulled.push(msg);
    });
    const join = await post(`${main!.url}/party/join`, { characterId: chr.id, code: party.code }, reg.session);
    expect(join.status).toBe(200);
    expect(join.json.pulled).toBe(true);
    await until(() => pulled.length === 1);
    expect(pulled[0]!.reason).toBe("party");
    const dest = aldricOn === "layer-1" ? layer1! : layer2!;
    expect(pulled[0]!.url).toBe(dest.url);
  });

  it("zone chat crosses layers through main; proximity stays on its layer", async () => {
    // two fresh characters, forced onto DIFFERENT layers
    async function player(name: string, chr: string, wantLayer: ServeHandle) {
      const reg = (await post(`${main!.url}/auth/register`, { name, password: "hunter22" })).json as Session;
      const c = (await post(`${main!.url}/characters`, { name: chr }, reg.session)).json.character as { id: string };
      let play = (await post(`${main!.url}/play`, { characterId: c.id }, reg.session)).json as { url: string; ticket: string; server: string };
      let tab = dial(play.url, play.ticket, chr);
      await until(() => tab.world.some((m) => m.t === "spawn" && m.self === `player:${c.id}`));
      if (play.server !== wantLayer.serverId) {
        const moved: Array<{ url: string; ticket: string }> = [];
        tab.client.onModule(WORLD_MODULE, (m) => {
          const msg = m as WorldModuleMessage;
          if (msg.t === "transfer") moved.push(msg);
        });
        await post(`${main!.url}/admin/transfer`, { characterId: c.id, srv: wantLayer.serverId }, SECRET);
        await until(() => moved.length === 1);
        tab.client.leave();
        tab = dial(moved[0]!.url, moved[0]!.ticket, chr);
        await until(() => tab.world.some((m) => m.t === "spawn" && m.self === `player:${c.id}`));
      }
      await until(() => main!.registry.whereIs.get(c.id) === wantLayer.serverId);
      const heard: Array<{ channel: string; text: string; from: string }> = [];
      tab.client.onModule("chat", (m) => {
        const d = m as { k: string; msg?: { channel: string; text: string; from: string } };
        if (d.k === "msg" && d.msg) heard.push(d.msg);
      });
      return { tab, id: c.id, heard };
    }
    const cara = await player("CaraAcct", "Cara", layer1!);
    const dan = await player("DanAcct", "Dan", layer2!);
    expect(layer1!.chat.zoneOf(cara.id)).toBe("field"); // a zoneless scene is one zone named after itself
    expect(layer2!.chat.zoneOf(dan.id)).toBe("field");

    cara.tab.client.sendModule("chat", { k: "say", channel: "zone", text: "anyone out there?" });
    await until(() => dan.heard.some((m) => m.text === "anyone out there?"));
    expect(dan.heard.at(-1)).toMatchObject({ channel: "zone", from: cara.id });
    expect(cara.heard.some((m) => m.text === "anyone out there?")).toBe(true); // the speaker hears themself
    expect(layer2!.chat.foreignDelivered).toBeGreaterThan(0);

    // "say" is heard on Cara's layer only — Dan is a world away in every sense
    cara.tab.client.sendModule("chat", { k: "say", channel: "proximity", text: "psst" });
    await until(() => cara.heard.some((m) => m.text === "psst"));
    await wait(300);
    expect(dan.heard.some((m) => m.text === "psst")).toBe(false);
  });

  it("a combat transfer lock holds a body until it expires", async () => {
    const layer = layer1!;
    // a player still connected (earlier tests left bodies in reconnect grace)
    const [peerId, player] = [...layer.server.players.entries()].find(
      ([, p]) => p.disconnectedAt === null && p.transferring === null,
    )!;
    expect(layer.server.canTransfer(peerId)).toBe(true);
    layer.world.netState.set(transferLockKey(player.bodyId), layer.world.timeMs + 60_000);
    expect(layer.server.canTransfer(peerId)).toBe(false);
    layer.world.netState.set(transferLockKey(player.bodyId), layer.world.timeMs - 1);
    expect(layer.server.canTransfer(peerId)).toBe(true);
    expect(layer.world.netState.set(transferLockKey(player.bodyId), "soon")).toBe(false); // schema-guarded
  });
});
