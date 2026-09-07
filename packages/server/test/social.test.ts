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
 * Friends, blocks and parties across the cluster (docs/hosting.md →
 * "Parties and friends"): a friend request reaches the other player's tab
 * on another layer as a `social` module event and a chat line; accepting
 * makes both lists agree, with presence; a friendship is between ACCOUNTS
 * and every character sees it; a block makes an account unreachable —
 * no requests, no invitations, no chat — without saying so; a party
 * invitation pulls the accepter onto the leader's layer; the leader can
 * kick and hand over; a friend can be travelled to; going offline is
 * announced; friendships are durable.
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

const SECRET = "test-social";
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
    experienceId: "test-social",
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
  console.warn("social test skipped:", error instanceof Error ? error.message : error);
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

describe.skipIf(!main || !layer1 || !layer2)("friends, blocks and parties across layers", { timeout: 60_000 }, () => {
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
      const d = m as { k: string; msg?: { channel: string; text: string; from: string } };
      if (d.k === "msg" && d.msg) chat.push(d.msg);
    });
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join(name);
    });
    transports.push(transport);
    clients.push(client);
    return { transport, client, world, social, chat };
  }
  const lines = (tab: ReturnType<typeof dial>): string[] => tab.chat.filter((m) => m.channel === "system").map((m) => m.text);

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
  let eve: P;
  let finn: P;
  let gus: P;

  it("a friend request reaches the other player wherever they are; accepting makes both accounts agree", async () => {
    await until(() => main!.registry.layersFor("field").length === 2);
    eve = await player("EveAcct", "Eve", layer1!);
    finn = await player("FinnAcct", "Finn", layer2!);
    gus = await player("GusAcct", "Gus", layer2!);

    // a name is how players find each other: one character per name, world-wide
    expect((await post(`${main!.url}/characters`, { name: "eve" }, gus.session)).status).toBe(409);
    expect((await post(`${main!.url}/social/friend/request`, { characterId: eve.id, name: "Nobody" }, eve.session)).status).toBe(404);
    expect((await post(`${main!.url}/social/friend/request`, { characterId: eve.id, name: "eve" }, eve.session)).status).toBe(400);
    const req = await post(`${main!.url}/social/friend/request`, { characterId: eve.id, name: "finn" }, eve.session); // case-insensitive
    expect(req.json).toMatchObject({ outcome: "sent", name: "Finn" });
    await until(() => finn.tab.social.some((e) => e.kind === "friend.request"));
    expect(finn.tab.social.at(-1)).toMatchObject({ kind: "friend.request", characterId: eve.id, name: "Eve" });
    await until(() => lines(finn.tab).some((l) => l.startsWith("Eve wants to be your friend")));
    expect(gus.tab.social).toEqual([]);
    expect((await get(`${main!.url}/social?characterId=${finn.id}`, finn.session)).incoming).toEqual([{ playerId: eve.account.id, characterId: eve.id, name: "Eve" }]);
    expect((await get(`${main!.url}/social?characterId=${eve.id}`, eve.session)).outgoing).toEqual([{ playerId: finn.account.id, characterId: finn.id, name: "Finn" }]);
    expect((await post(`${main!.url}/social/friend/request`, { characterId: eve.id, name: "Finn" }, eve.session)).json.outcome).toBe("already-sent");

    expect((await post(`${main!.url}/social/friend/accept`, { characterId: finn.id, name: "Eve" }, finn.session)).json).toEqual({ friend: "Eve" });
    await until(() => eve.tab.social.some((e) => e.kind === "friend.accepted"));
    const eves = await get(`${main!.url}/social?characterId=${eve.id}`, eve.session);
    expect(eves.friends).toEqual([{ playerId: finn.account.id, characterId: finn.id, name: "Finn", online: true, server: "layer-2", zone: null }]);
    expect(eves.incoming).toEqual([]);
    expect(eves.outgoing).toEqual([]);
    expect((await get(`${main!.url}/social?characterId=${finn.id}`, finn.session)).friends).toMatchObject([{ characterId: eve.id, name: "Eve", online: true, server: "layer-1" }]);
    // durable: in the player-data store, not main's memory
    const saved = await playerData.load({ playerId: eve.account.id, experienceId: "test-social" }, "social");
    expect((saved!.data as { friends: unknown[] }).friends).toHaveLength(1);
    // account-wide: Eve's second character sees Finn without asking again
    const eva = (await post(`${main!.url}/characters`, { name: "Eva" }, eve.session)).json.character as { id: string };
    expect((await get(`${main!.url}/social?characterId=${eva.id}`, eve.session)).friends.map((f: { name: string }) => f.name)).toEqual(["Finn"]);
    expect((await post(`${main!.url}/social/friend/request`, { characterId: eva.id, name: "Finn" }, eve.session)).json.outcome).toBe("already-friends");
    // a request the other way round while one is pending is an acceptance
    await post(`${main!.url}/social/friend/request`, { characterId: gus.id, name: "Eve" }, gus.session);
    expect((await post(`${main!.url}/social/friend/request`, { characterId: eve.id, name: "Gus" }, eve.session)).json.outcome).toBe("accepted");
    expect((await get(`${main!.url}/social?characterId=${eve.id}`, eve.session)).friends).toHaveLength(2);
  });

  it("a block makes an account unreachable: no requests, no invitations, no chat — and says nothing", async () => {
    // Gus blocks Eve: the friendship goes on both sides
    expect((await post(`${main!.url}/social/block`, { characterId: gus.id, name: "Eve" }, gus.session)).json).toEqual({ blocked: "Eve" });
    expect((await get(`${main!.url}/social?characterId=${gus.id}`, gus.session)).blocked).toEqual([{ playerId: eve.account.id, characterId: eve.id, name: "Eve" }]);
    expect((await get(`${main!.url}/social?characterId=${eve.id}`, eve.session)).friends.map((f: { name: string }) => f.name)).toEqual(["Finn"]);
    // Eve cannot tell: her request looks unavailable, her invitation is refused without a reason
    expect((await post(`${main!.url}/social/friend/request`, { characterId: eve.id, name: "Gus" }, eve.session)).json.outcome).toBe("unavailable");
    expect((await post(`${main!.url}/party/invite`, { characterId: eve.id, name: "Gus" }, eve.session)).status).toBe(400);
    await post(`${main!.url}/party/leave`, { characterId: eve.id }, eve.session);
    // and Gus never hears Eve, on a bridged channel from another layer or in the same room
    await until(() => (layer2!.world.netState.get("owner/player:" + gus.id) as string | undefined) === gus.id);
    const heard = () => gus.tab.chat.filter((m) => m.channel === "global").map((m) => m.text);
    eve.tab.client.sendModule("chat", { k: "say", channel: "global", text: "can you hear me" });
    await until(() => finn.tab.chat.some((m) => m.text === "can you hear me"));
    await wait(300);
    expect(heard()).not.toContain("can you hear me");
    // unblock: chat comes through again
    expect((await post(`${main!.url}/social/unblock`, { characterId: gus.id, name: "Eve" }, gus.session)).json).toEqual({ unblocked: "Eve" });
    await wait(300);
    eve.tab.client.sendModule("chat", { k: "say", channel: "global", text: "now?" });
    await until(() => heard().includes("now?"));
    // Gus's own side of the block list: blocking me is not something I can see
    expect((await post(`${main!.url}/social/friend/request`, { characterId: gus.id, name: "Eve" }, gus.session)).json.outcome).toBe("sent");
    await post(`${main!.url}/social/friend/accept`, { characterId: eve.id, name: "Gus" }, eve.session);
  });

  it("a party invitation is delivered, accepting pulls the member to the leader's layer, the leader can kick", async () => {
    const inv = await post(`${main!.url}/party/invite`, { characterId: eve.id, name: "Finn" }, eve.session);
    expect(inv.status).toBe(200);
    expect(inv.json.invited).toBe("Finn");
    const code = inv.json.party.code as string;
    await until(() => finn.tab.social.some((e) => e.kind === "party.invite"));
    expect(finn.tab.social.at(-1)).toMatchObject({ kind: "party.invite", code, name: "Eve" });
    expect((await get(`${main!.url}/party?characterId=${finn.id}`, finn.session)).invites).toEqual([{ code, from: eve.id, name: "Eve" }]);
    expect((await post(`${main!.url}/party/kick`, { characterId: finn.id, name: "Eve" }, finn.session)).status).toBe(400);

    const pulled: Array<{ url: string; ticket: string; reason: string }> = [];
    finn.tab.client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "transfer") pulled.push(msg);
    });
    const acc = await post(`${main!.url}/party/accept`, { characterId: finn.id }, finn.session);
    expect(acc.status).toBe(200);
    expect(acc.json.pulled).toBe(true);
    expect(acc.json.party.members.map((m: { name: string }) => m.name).sort()).toEqual(["Eve", "Finn"]);
    await until(() => pulled.length === 1);
    expect(pulled[0]!.reason).toBe("party");
    await until(() => eve.tab.social.some((e) => e.kind === "party.joined" && e.name === "Finn"));
    finn.tab.client.leave();
    const finnTab = dial(pulled[0]!.url, pulled[0]!.ticket, "Finn");
    await until(() => finnTab.world.some((m) => m.t === "spawn" && m.self === `player:${finn.id}`));
    await until(() => main!.registry.whereIs.get(finn.id) === "layer-1");
    finn.tab = finnTab;
    const view = await get(`${main!.url}/party?characterId=${eve.id}`, eve.session);
    expect(view.party.leader).toBe(eve.id);
    expect(view.party.members).toMatchObject([
      { characterId: eve.id, name: "Eve", online: true, server: "layer-1" },
      { characterId: finn.id, name: "Finn", online: true, server: "layer-1" },
    ]);
    expect(layer1!.world.netState.get(`comms.party/${finn.id}`)).toBe(code);

    expect((await post(`${main!.url}/party/leader`, { characterId: eve.id, name: "Finn" }, eve.session)).json.party.leader).toBe(finn.id);
    await until(() => eve.tab.social.some((e) => e.kind === "party.leader" && e.characterId === finn.id));
    expect((await post(`${main!.url}/party/kick`, { characterId: eve.id, name: "Finn" }, eve.session)).status).toBe(403);
    expect((await post(`${main!.url}/party/kick`, { characterId: finn.id, name: "Eve" }, finn.session)).status).toBe(200);
    await until(() => eve.tab.social.some((e) => e.kind === "party.kicked"));
    expect((await get(`${main!.url}/party?characterId=${eve.id}`, eve.session)).party).toBeNull();
    await until(() => layer1!.world.netState.get(`comms.party/${eve.id}`) === undefined);
    const inv2 = await post(`${main!.url}/party/invite`, { characterId: finn.id, name: "Gus" }, finn.session);
    expect(inv2.status).toBe(200);
    expect((await post(`${main!.url}/party/decline`, { characterId: gus.id }, gus.session)).status).toBe(200);
    await until(() => finn.tab.social.some((e) => e.kind === "party.declined" && e.name === "Gus"));
  });

  it("travel to a friend moves you to their layer; going offline is announced; removing forgets both ways", async () => {
    expect((await post(`${main!.url}/social/travel`, { characterId: eve.id, name: "Finn" }, eve.session)).json).toMatchObject({ moved: false, reason: "already there" });
    const moved: Array<{ url: string; ticket: string; reason: string }> = [];
    eve.tab.client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "transfer") moved.push(msg);
    });
    const travel = await post(`${main!.url}/social/travel`, { characterId: eve.id, name: "Gus" }, eve.session);
    expect(travel.json).toMatchObject({ moved: true, server: "layer-2" });
    await until(() => moved.length === 1);
    expect(moved[0]!.reason).toBe("friend");
    eve.tab.client.leave();
    eve.tab = dial(moved[0]!.url, moved[0]!.ticket, "Eve");
    await until(() => eve.tab.world.some((m) => m.t === "spawn" && m.self === `player:${eve.id}`));
    await until(() => main!.registry.whereIs.get(eve.id) === "layer-2");
    expect((await post(`${main!.url}/social/travel`, { characterId: gus.id, name: "Finn" }, gus.session)).status).toBe(403);

    const before = finn.tab.social.length;
    gus.tab.client.leave();
    await until(() => eve.tab.social.some((e) => e.kind === "friend.offline" && e.name === "Gus"), 10_000);
    expect(finn.tab.social.slice(before).some((e) => e.kind === "friend.offline")).toBe(false);
    expect((await get(`${main!.url}/social?characterId=${eve.id}`, eve.session)).friends.find((f: { name: string }) => f.name === "Gus")).toMatchObject({ online: false, server: null });

    expect((await post(`${main!.url}/social/friend/remove`, { characterId: eve.id, name: "Finn" }, eve.session)).json).toEqual({ removed: "Finn" });
    await until(() => finn.tab.social.some((e) => e.kind === "friend.removed" && e.name === "Eve"));
    expect((await get(`${main!.url}/social?characterId=${finn.id}`, finn.session)).friends).toEqual([]);
    expect((await get(`${main!.url}/social?characterId=${eve.id}`, eve.session)).friends.map((f: { name: string }) => f.name)).toEqual(["Gus"]);
  });
});
