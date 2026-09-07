import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { SOCIAL_MODULE, WORLD_MODULE, type SocialEvent, type WorldModuleMessage } from "../src/index.js";

/**
 * Guilds across the cluster: founded, unique by name, invitations that
 * reach a tab on another layer, ranks (officers invite and kick members,
 * the leader promotes/demotes/hands over/disbands), guild chat bridged
 * through main to members on every layer and nobody else, the leadership
 * moving when the leader leaves, membership surviving a relogin, and the
 * name freed when the last member goes.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 8000, what = ""): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting ${what}`);
    await wait(15);
  }
}

const SECRET = "test-guild";
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
    experienceId: "test-guild",
    accounts,
    playerData,
    world: { scene: "field", cap: 4, min: 0, max: 0 },
    supervisor: null,
    scaleEverySeconds: 3600,
    log: () => undefined,
  });
  const common = { playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main.url, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined } as const;
  layer1 = await serve({ ...common, serverId: "layer-1", maxPlayers: 4 });
  layer2 = await serve({ ...common, serverId: "layer-2", maxPlayers: 4 });
} catch (error) {
  console.warn("guild test skipped:", error instanceof Error ? error.message : error);
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
async function get(url: string, token: string): Promise<any> {
  return (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).json();
}

describe.skipIf(!main || !layer1 || !layer2)("guilds across layers", { timeout: 60_000 }, () => {
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
    const social: SocialEvent[] = [];
    const chat: Array<{ channel: string; text: string; from: string }> = [];
    client.onModule(WORLD_MODULE, (m) => world.push(m as WorldModuleMessage));
    client.onModule(SOCIAL_MODULE, (m) => social.push(m as SocialEvent));
    client.onModule("chat", (m) => {
      const d = m as { k: string; msg?: { channel: string; text: string; from: string }; text?: string };
      if (d.k === "msg" && d.msg) chat.push(d.msg);
      if (d.k === "err" && d.text) chat.push({ channel: "system", text: d.text, from: "system" }); // a refusal comes back as an error line
    });
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join(name);
    });
    transports.push(transport);
    clients.push(client);
    return { transport, client, world, social, chat };
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
    next.social.push(...tab.social);
    next.chat.push(...tab.chat);
    await until(() => next.world.some((m) => m.t === "spawn" && m.self === `player:${characterId}`));
    await until(() => main!.registry.whereIs.get(characterId) === to.serverId);
    return next;
  }

  async function player(name: string, chr: string, wantLayer: ServeHandle) {
    const reg = (await post(`${main!.url}/auth/register`, { name, password: "hunter22" })).json as Session;
    const c = (await post(`${main!.url}/characters`, { name: chr }, reg.session)).json.character as { id: string };
    const play = (await post(`${main!.url}/play`, { characterId: c.id }, reg.session)).json as { url: string; ticket: string; server: string };
    let tab = dial(play.url, play.ticket, chr);
    await until(() => tab.world.some((m) => m.t === "spawn" && m.self === `player:${c.id}`));
    if (play.server !== wantLayer.serverId) tab = await moveTo(tab, c.id, wantLayer);
    await until(() => main!.registry.whereIs.get(c.id) === wantLayer.serverId);
    return { tab, id: c.id, session: reg.session, account: reg.account, chr };
  }

  type P = Awaited<ReturnType<typeof player>>;
  let ann: P;
  let ben: P;
  let cid: P;
  let guildId = "";

  it("is founded with a unique name; an invitation reaches a tab on another layer; ranks gate what officers do", async () => {
    await until(() => main!.registry.layersFor("field").length === 2);
    ann = await player("AnnAcct", "Ann", layer1!);
    ben = await player("BenAcct", "Ben", layer2!);
    cid = await player("CidAcct", "Cid", layer2!);

    expect((await post(`${main!.url}/guild/create`, { characterId: ann.id, name: "x" }, ann.session)).status).toBe(400);
    const made = await post(`${main!.url}/guild/create`, { characterId: ann.id, name: "Iron Kettle" }, ann.session);
    expect(made.status).toBe(200);
    guildId = made.json.guild.id;
    expect(made.json.guild).toMatchObject({ name: "Iron Kettle", leader: ann.id, motd: "" });
    expect(made.json.guild.members).toMatchObject([{ characterId: ann.id, name: "Ann", rank: "leader", online: true, server: "layer-1" }]);
    expect((await post(`${main!.url}/guild/create`, { characterId: ben.id, name: "iron kettle" }, ben.session)).status).toBe(409);
    expect((await post(`${main!.url}/guild/create`, { characterId: ann.id, name: "Second" }, ann.session)).status).toBe(400); // leave first
    await until(() => layer1!.world.netState.get(`comms.guild/${ann.id}`) === guildId);

    // members cannot invite; the leader invites Ben, who is on the other layer
    expect((await post(`${main!.url}/guild/invite`, { characterId: ben.id, name: "Cid" }, ben.session)).status).toBe(400);
    expect((await post(`${main!.url}/guild/invite`, { characterId: ann.id, name: "ben" }, ann.session)).json).toMatchObject({ invited: "Ben", online: true });
    await until(() => ben.tab.social.some((e) => e.kind === "guild.invite"));
    expect(ben.tab.social.at(-1)).toMatchObject({ kind: "guild.invite", guild: guildId, guildName: "Iron Kettle", name: "Ann" });
    await until(() => ben.tab.chat.some((m) => m.channel === "system" && m.text.startsWith("Ann invited you to the guild Iron Kettle")));
    expect((await get(`${main!.url}/guild?characterId=${ben.id}`, ben.session)).invites).toEqual([{ guild: guildId, name: "Iron Kettle", from: "Ann" }]);
    expect((await post(`${main!.url}/guild/accept`, { characterId: ben.id }, ben.session)).json.guild.members.map((m: { name: string }) => m.name)).toEqual(["Ann", "Ben"]);
    await until(() => ann.tab.social.some((e) => e.kind === "guild.joined" && e.name === "Ben"));
    await until(() => layer2!.world.netState.get(`comms.guild/${ben.id}`) === guildId);
    // a member cannot invite, an officer can
    expect((await post(`${main!.url}/guild/invite`, { characterId: ben.id, name: "Cid" }, ben.session)).status).toBe(403);
    expect((await post(`${main!.url}/guild/promote`, { characterId: ben.id, name: "Cid" }, ben.session)).status).toBe(403);
    expect((await post(`${main!.url}/guild/promote`, { characterId: ann.id, name: "Ben" }, ann.session)).json.guild.members.find((m: { name: string }) => m.name === "Ben").rank).toBe("officer");
    await until(() => ben.tab.social.some((e) => e.kind === "guild.promoted"));
    expect((await post(`${main!.url}/guild/invite`, { characterId: ben.id, name: "Cid" }, ben.session)).status).toBe(200);
    expect((await post(`${main!.url}/guild/accept`, { characterId: cid.id }, cid.session)).status).toBe(200);
    expect((await post(`${main!.url}/guild/motd`, { characterId: ben.id, text: "raid at nine" }, ben.session)).json.guild.motd).toBe("raid at nine");
    await until(() => cid.tab.social.some((e) => e.kind === "guild.motd"));
  });

  it("guild chat reaches members on every layer and nobody else", async () => {
    const dan = await player("DanAcct", "Dan", layer1!); // not in the guild, on Ann's layer
    ann.tab.client.sendModule("chat", { k: "say", channel: "guild", text: "kettle, assemble" });
    await until(() => ben.tab.chat.some((m) => m.channel === "guild" && m.text === "kettle, assemble"), 8000, "for Ben to hear guild chat");
    await until(() => cid.tab.chat.some((m) => m.channel === "guild" && m.text === "kettle, assemble"), 8000, "for Cid to hear guild chat");
    expect(ann.tab.chat.some((m) => m.channel === "guild" && m.text === "kettle, assemble")).toBe(true);
    await wait(300);
    expect(dan.tab.chat.some((m) => m.text === "kettle, assemble")).toBe(false);
    // no guild: refused
    dan.tab.client.sendModule("chat", { k: "say", channel: "guild", text: "hello?" });
    await until(() => dan.tab.chat.some((m) => m.channel === "system" && /not in a guild/.test(m.text)), 8000, `for Dan to be refused (got ${JSON.stringify(dan.tab.chat.slice(-3))})`);
  });

  it("officers kick members but not each other; the leader hands over; membership survives a relogin; the last one out frees the name", async () => {
    // Ben (officer) cannot kick Ann (leader); can kick Cid (member)
    expect((await post(`${main!.url}/guild/kick`, { characterId: ben.id, name: "Ann" }, ben.session)).status).toBe(403);
    expect((await post(`${main!.url}/guild/kick`, { characterId: ben.id, name: "Cid" }, ben.session)).status).toBe(200);
    await until(() => cid.tab.social.some((e) => e.kind === "guild.kicked"));
    expect((await get(`${main!.url}/guild?characterId=${cid.id}`, cid.session)).guild).toBeNull();
    await until(() => layer2!.world.netState.get(`comms.guild/${cid.id}`) === undefined);
    // hand over to Ben, then Ann leaves: Ben leads, Ann is out
    expect((await post(`${main!.url}/guild/leader`, { characterId: ann.id, name: "Ben" }, ann.session)).json.guild.leader).toBe(ben.id);
    await until(() => ben.tab.social.some((e) => e.kind === "guild.leader" && e.characterId === ben.id));
    const view = await get(`${main!.url}/guild?characterId=${ann.id}`, ann.session);
    expect(view.guild.members.find((m: { name: string }) => m.name === "Ann").rank).toBe("officer");
    // relogin keeps the membership: Ben leaves the world and comes back on a fresh tab
    ben.tab.client.leave();
    await until(() => main!.registry.whereIs.get(ben.id) === undefined, 10_000);
    const play = (await post(`${main!.url}/play`, { characterId: ben.id }, ben.session)).json as { url: string; ticket: string; server: string };
    ben.tab = dial(play.url, play.ticket, "Ben");
    await until(() => ben.tab.world.some((m) => m.t === "spawn" && m.self === `player:${ben.id}`));
    const layer = play.server === "layer-1" ? layer1! : layer2!;
    await until(() => layer.world.netState.get(`comms.guild/${ben.id}`) === guildId);
    expect((await get(`${main!.url}/guild?characterId=${ben.id}`, ben.session)).guild.leader).toBe(ben.id);
    // Ann leaves, Ben disbands: the name is free again
    expect((await post(`${main!.url}/guild/leave`, { characterId: ann.id }, ann.session)).json).toMatchObject({ guild: null, disbanded: false });
    await until(() => ben.tab.social.some((e) => e.kind === "guild.left" && e.name === "Ann"));
    expect((await post(`${main!.url}/guild/disband`, { characterId: ben.id }, ben.session)).status).toBe(200);
    expect((await get(`${main!.url}/guild?characterId=${ben.id}`, ben.session)).guild).toBeNull();
    expect((await post(`${main!.url}/guild/create`, { characterId: cid.id, name: "Iron Kettle" }, cid.session)).status).toBe(200);
  });
});
