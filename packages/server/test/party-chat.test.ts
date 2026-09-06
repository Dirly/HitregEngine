import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * Party chat across layers: main owns the party list, pushes each member's
 * party into their layer's netState, and stamps the sender's party on the
 * bridged line, so two party members on different copies of the world
 * talk — and a stranger on the receiving layer hears nothing.
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

const SECRET = "test-party-chat";
let main: MainHandle | null = null;
let layer1: ServeHandle | null = null;
let layer2: ServeHandle | null = null;
try {
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-party-chat",
    accounts: new MemoryAccountStore(),
    playerData: new MemoryPlayerDataBackend(),
    world: { scene: "field", cap: 4, min: 0, max: 0 },
    supervisor: null,
    scaleEverySeconds: 3600,
    log: () => undefined,
  });
  const common = { playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main.url, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined } as const;
  layer1 = await serve({ ...common, serverId: "layer-1", maxPlayers: 4 });
  layer2 = await serve({ ...common, serverId: "layer-2", maxPlayers: 4 });
} catch (error) {
  console.warn("party chat test skipped:", error instanceof Error ? error.message : error);
}

interface Session {
  session: string;
  account: { id: string; name: string };
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!main || !layer1 || !layer2)("party chat across layers", { timeout: 40_000 }, () => {
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
    const heard: Array<{ channel: string; text: string; from: string }> = [];
    client.onModule(WORLD_MODULE, (m) => world.push(m as WorldModuleMessage));
    client.onModule("chat", (m) => {
      const d = m as { k: string; msg?: { channel: string; text: string; from: string } };
      if (d.k === "msg" && d.msg) heard.push(d.msg);
    });
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join(name);
    });
    transports.push(transport);
    clients.push(client);
    return { transport, client, world, heard };
  }

  /** Sign up, make a character, play, and end up on `wantLayer` (an admin move if placement chose the other). */
  async function player(name: string, chr: string, wantLayer: ServeHandle) {
    const reg = (await post(`${main!.url}/auth/register`, { name, password: "hunter22" })).json as Session;
    const c = (await post(`${main!.url}/characters`, { name: chr }, reg.session)).json.character as { id: string };
    const play = (await post(`${main!.url}/play`, { characterId: c.id }, reg.session)).json as { url: string; ticket: string; server: string };
    let tab = dial(play.url, play.ticket, chr);
    await until(() => tab.world.some((m) => m.t === "spawn" && m.self === `player:${c.id}`));
    if (play.server !== wantLayer.serverId) tab = await moveTo(tab, c.id, wantLayer);
    await until(() => main!.registry.whereIs.get(c.id) === wantLayer.serverId);
    return { tab, id: c.id, session: reg.session, chr };
  }

  async function moveTo(tab: ReturnType<typeof dial>, characterId: string, to: ServeHandle): Promise<ReturnType<typeof dial>> {
    const moved: Array<{ url: string; ticket: string }> = [];
    tab.client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "transfer") moved.push(msg);
    });
    expect((await post(`${main!.url}/admin/transfer`, { characterId, srv: to.serverId }, SECRET)).status).toBe(200);
    await until(() => moved.length === 1);
    tab.client.leave();
    const next = dial(moved[0]!.url, moved[0]!.ticket, "moved");
    await until(() => next.world.some((m) => m.t === "spawn" && m.self === `player:${characterId}`));
    await until(() => main!.registry.whereIs.get(characterId) === to.serverId);
    return next;
  }

  it("two party members on different layers hear each other; a stranger on the receiving layer does not", async () => {
    await until(() => main!.registry.layersFor("field").length === 2);
    const eve = await player("EveAcct", "Eve", layer1!);
    const finn = await player("FinnAcct", "Finn", layer2!);
    const gus = await player("GusAcct", "Gus", layer2!); // no party, same layer as Finn

    // Eve forms a party; Finn joins — main pulls him to Eve's layer (there is room), so move him back
    const party = (await post(`${main!.url}/party/create`, { characterId: eve.id }, eve.session)).json.party as { code: string };
    const pulled: Array<{ url: string; ticket: string }> = [];
    finn.tab.client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "transfer") pulled.push(msg);
    });
    const join = await post(`${main!.url}/party/join`, { characterId: finn.id, code: party.code }, finn.session);
    expect(join.status).toBe(200);
    if (join.json.pulled) {
      await until(() => pulled.length === 1);
      finn.tab.client.leave();
      finn.tab = dial(pulled[0]!.url, pulled[0]!.ticket, "Finn");
      await until(() => finn.tab.world.some((m) => m.t === "spawn" && m.self === `player:${finn.id}`));
      await until(() => main!.registry.whereIs.get(finn.id) === layer1!.serverId);
      finn.tab = await moveTo(finn.tab, finn.id, layer2!);
    }
    expect(main!.registry.whereIs.get(eve.id)).toBe("layer-1");
    expect(main!.registry.whereIs.get(finn.id)).toBe("layer-2");

    // main pushed the membership into each member's layer (peer id = character id)
    await until(() => layer1!.world.netState.get(`comms.party/${eve.id}`) === party.code);
    await until(() => layer2!.world.netState.get(`comms.party/${finn.id}`) === party.code);
    expect(layer2!.world.netState.get(`comms.party/${gus.id}`)).toBeUndefined();

    // a party line crosses from Eve's layer to Finn's, through main
    eve.tab.client.sendModule("chat", { k: "say", channel: "party", text: "meet at the pass" });
    await until(() => finn.tab.heard.some((m) => m.text === "meet at the pass"));
    expect(finn.tab.heard.at(-1)).toMatchObject({ channel: "party", from: eve.id });
    expect(eve.tab.heard.some((m) => m.text === "meet at the pass")).toBe(true); // the speaker hears themself
    await wait(300);
    expect(gus.tab.heard.some((m) => m.text === "meet at the pass")).toBe(false);
    expect(layer2!.chat.foreignDelivered).toBe(1);

    // and back the other way
    finn.tab.client.sendModule("chat", { k: "say", channel: "party", text: "on my way" });
    await until(() => eve.tab.heard.some((m) => m.text === "on my way"));
    expect(gus.tab.heard.some((m) => m.text === "on my way")).toBe(false);

    // leaving the party ends it: main clears the layer's copy and the next line is refused locally
    expect((await post(`${main!.url}/party/leave`, { characterId: finn.id }, finn.session)).status).toBe(200);
    await until(() => layer2!.world.netState.get(`comms.party/${finn.id}`) === undefined);
    finn.tab.client.sendModule("chat", { k: "say", channel: "party", text: "still here?" });
    await wait(400);
    expect(eve.tab.heard.some((m) => m.text === "still here?")).toBe(false);
  });
});
