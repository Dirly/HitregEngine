import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { ChatBuffer, mergeEvidenceLines, toEvidenceLine, type BufferedChatLine } from "../src/moderation/chat-buffer.js";
import { EVIDENCE_TTL_MS, EvidenceRequests, ReportIntake, ReportStore, listOpenReports } from "../src/moderation/reports.js";

/**
 * Chat history and report intake (docs/moderation.md §2): the rolling chat
 * buffers on layers and main, the `evidence.request` round trip, and
 * `POST /reports` storing a report with its evidence in the reported
 * account's `moderation` record — only the two characters' own lines.
 */

const line = (over: Partial<BufferedChatLine> & { at: number }): BufferedChatLine => ({
  id: `x:${over.at}`,
  channel: "zone",
  from: "a",
  account: null,
  name: "A",
  text: "hi",
  position: null,
  zone: "vale",
  origin: "layer-1",
  to: [],
  ...over,
});

describe("chat buffer", () => {
  it("keeps 15 minutes and a line cap, oldest out first", () => {
    let now = 1_000_000;
    const buf = new ChatBuffer({ now: () => now, maxLines: 3 });
    buf.push(line({ at: now, text: "one" }));
    now += 10 * 60_000;
    buf.push(line({ at: now, text: "two" }));
    expect(buf.size).toBe(2);
    now += 6 * 60_000; // "one" is now 16 minutes old
    buf.prune();
    expect(buf.all().map((l) => l.text)).toEqual(["two"]);
    buf.push(line({ at: now, text: "three" }));
    buf.push(line({ at: now, text: "four" }));
    buf.push(line({ at: now, text: "five" }));
    expect(buf.all().map((l) => l.text)).toEqual(["three", "four", "five"]); // the cap
  });

  it("evidence holds only what the two said, with whether each heard it", () => {
    const now = 5_000_000;
    const buf = new ChatBuffer({ now: () => now });
    buf.push(line({ at: now - 20 * 60_000, from: "t", text: "too old" }));
    buf.push(line({ at: now - 60_000, from: "t", text: "insult", to: ["r", "c"] }));
    buf.push(line({ at: now - 50_000, from: "c", text: "bystander", to: ["r", "t"] }));
    buf.push(line({ at: now - 40_000, from: "r", text: "stop it", to: ["c"] }));
    const lines = buf.involving("r", "t", 15).map((l) => toEvidenceLine(l, "r", "t", "layer-1"));
    expect(lines.map((l) => l.text)).toEqual(["insult", "stop it"]);
    expect(lines[0]).toMatchObject({ reporterHeard: true, targetHeard: true, recipients: 2 });
    expect(lines[1]).toMatchObject({ reporterHeard: true, targetHeard: false });
    expect(JSON.stringify(lines)).not.toContain('"c"'); // no third party ids
    // the same bridged line from its origin and from main is one entry
    const fromMain = toEvidenceLine({ ...buf.all()[0]!, to: null, account: "acct-t", position: null }, "r", "t", "main");
    const merged = mergeEvidenceLines(lines, [fromMain]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ text: "insult", account: "acct-t", source: "layer-1+main", recipients: 2 });
  });
});

describe("report store and intake", () => {
  const party = (n: string) => ({ account: `acct-${n}`, characterId: `chr-${n}`, name: n });

  it("rate-limits a reporter, prunes evidence after 30 days, lists open reports", async () => {
    let now = 10_000_000_000;
    const backend = new MemoryPlayerDataBackend();
    const store = new ReportStore(backend, "test", () => now);
    const intake = new ReportIntake({
      store,
      mainBuffer: new ChatBuffer({ now: () => now }),
      requests: new EvidenceRequests(() => false),
      whereIs: () => undefined,
      perHour: 2,
      now: () => now,
    });
    await intake.file({ reporter: party("r"), target: party("a"), kind: "chat", reason: "rude" });
    await expect(intake.file({ reporter: party("r"), target: party("a"), kind: "chat", reason: "again" })).rejects.toThrow("already reported a in the last hour");
    await intake.file({ reporter: party("r"), target: party("b"), kind: "name", reason: "bad name" });
    await expect(intake.file({ reporter: party("r"), target: party("c"), kind: "other", reason: "x" })).rejects.toThrow("2 reports in the last hour");
    await expect(intake.file({ reporter: party("s"), target: party("c"), kind: "spam", reason: "x" })).rejects.toThrow("kind must be one of");
    await expect(intake.file({ reporter: party("s"), target: party("c"), kind: "chat", reason: "  " })).rejects.toThrow("needs a reason");
    await expect(intake.file({ reporter: party("s"), target: party("s"), kind: "chat", reason: "me" })).rejects.toThrow("cannot report yourself");

    const open = await listOpenReports(store, "acct-a");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reporterAccount: "acct-r", targetCharacter: "chr-a", kind: "chat", reason: "rude", status: "open" });
    expect(await store.evidence("acct-a", open[0]!.evidenceId)).not.toBeNull();

    // an hour later the pair may report again; 31 days on, the first evidence is gone on the next write
    now += 3600_000 + 1;
    await intake.file({ reporter: party("r"), target: party("a"), kind: "chat", reason: "still rude" });
    now += EVIDENCE_TTL_MS + 1;
    await store.mutate("acct-a", () => undefined);
    const record = await store.load("acct-a");
    expect(record.reports).toHaveLength(2); // reports stay for the record
    expect(Object.keys(record.evidence)).toHaveLength(0);
  });
});

// -- end to end: main + two layers ---------------------------------------------------------

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

const SECRET = "test-moderation-reports";
const playerData = new MemoryPlayerDataBackend();
let main: MainHandle | null = null;
let layer1: ServeHandle | null = null;
let layer2: ServeHandle | null = null;
try {
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-moderation",
    accounts: new MemoryAccountStore(),
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
  console.warn("moderation reports test skipped:", error instanceof Error ? error.message : error);
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

describe.skipIf(!main || !layer1 || !layer2)("reports end to end", { timeout: 60_000 }, () => {
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

  async function player(name: string, chr: string, wantLayer: ServeHandle) {
    const reg = (await post(`${main!.url}/auth/register`, { name, password: "hunter22" })).json as Session;
    const made = await post(`${main!.url}/characters`, { name: chr }, reg.session);
    expect(made.status).toBe(200);
    const c = made.json.character as { id: string };
    const play = (await post(`${main!.url}/play`, { characterId: c.id }, reg.session)).json as { url: string; ticket: string; server: string };
    let tab = dial(play.url, play.ticket, chr);
    await until(() => tab.world.some((m) => m.t === "spawn" && m.self === `player:${c.id}`));
    if (play.server !== wantLayer.serverId) tab = await moveTo(tab, c.id, wantLayer);
    await until(() => main!.registry.whereIs.get(c.id) === wantLayer.serverId);
    return { tab, id: c.id, account: reg.account.id, session: reg.session };
  }

  it("files a report with the two characters' lines from the layers and main, and refuses what it should", async () => {
    await until(() => main!.registry.layersFor("field").length === 2);
    const rena = await player("RenaAcct", "Rena", layer1!); // the reporter
    const tolk = await player("TolkAcct", "Tolk", layer1!); // reported, same layer
    const cass = await player("CassAcct", "Cass", layer1!); // a bystander
    const vorn = await player("VornAcct", "Vorn", layer2!); // reported, other layer

    tolk.tab.client.sendModule("chat", { k: "say", channel: "zone", text: "you are trash" });
    await until(() => rena.tab.heard.some((m) => m.text === "you are trash"));
    cass.tab.client.sendModule("chat", { k: "say", channel: "zone", text: "bystander talk" });
    await until(() => rena.tab.heard.some((m) => m.text === "bystander talk"));
    rena.tab.client.sendModule("chat", { k: "say", channel: "zone", text: "please stop" });
    vorn.tab.client.sendModule("chat", { k: "say", channel: "global", text: "global abuse" });
    await until(() => rena.tab.heard.some((m) => m.text === "global abuse"));

    // the layer buffered what it delivered, with the sender's account and position
    const buffered = layer1!.chat.buffer.all().find((l) => l.text === "you are trash")!;
    expect(buffered).toMatchObject({ from: tolk.id, account: tolk.account, origin: "layer-1" });
    expect(typeof buffered.zone).toBe("string");
    expect(buffered.position).not.toBeNull();
    expect(buffered.to).toContain(rena.id);
    // the evidence call a layer answers: only the two characters' own lines
    const direct = layer1!.chat.evidence(rena.id, tolk.id, 15);
    expect(direct.lines.map((l) => l.text)).toEqual(["you are trash", "please stop"]);
    expect(direct.reporter).toMatchObject({ here: true, zone: buffered.zone });

    // the report: main asks layer-1 over the cluster link (evidence.request → evidence.result)
    const filed = await post(`${main!.url}/reports`, { characterId: rena.id, target: "tolk", reason: "abusive in zone chat", kind: "chat" }, rena.session);
    expect(filed.status).toBe(200);
    expect(filed.json).toMatchObject({ ok: true, name: "Tolk" });
    const store = new ReportStore(playerData, "test-moderation");
    const [report] = await listOpenReports(store, tolk.account);
    expect(report).toMatchObject({ reporterAccount: rena.account, reporterCharacter: rena.id, targetCharacter: tolk.id, kind: "chat", reason: "abusive in zone chat" });
    const bundle = (await store.evidence(tolk.account, report!.evidenceId))!;
    expect(bundle.servers).toEqual([{ id: "layer-1", answered: true }]);
    expect(bundle.reporter).toMatchObject({ server: "layer-1", zone: buffered.zone });
    expect(bundle.target.position).not.toBeNull();
    expect(bundle.lines.map((l) => l.text)).toEqual(["you are trash", "please stop"]);
    expect(bundle.lines[0]).toMatchObject({ from: tolk.id, account: tolk.account, reporterHeard: true, source: "layer-1+main" });
    expect(JSON.stringify(bundle)).not.toContain("bystander talk");

    // a reported character on another layer: both servers asked, main's bridged copy merged in
    const cross = await post(`${main!.url}/reports`, { characterId: rena.id, target: "Vorn", reason: "slurs in global", kind: "chat" }, rena.session);
    expect(cross.status).toBe(200);
    const [vornReport] = await listOpenReports(store, vorn.account);
    const vornBundle = (await store.evidence(vorn.account, vornReport!.evidenceId))!;
    expect(vornBundle.servers.map((s) => s.id).sort()).toEqual(["layer-1", "layer-2"]);
    expect(vornBundle.servers.every((s) => s.answered)).toBe(true);
    const abuse = vornBundle.lines.find((l) => l.text === "global abuse")!;
    expect(abuse).toMatchObject({ from: vorn.id, account: vorn.account, origin: "layer-2", reporterHeard: true });
    expect(abuse.position).not.toBeNull(); // from the origin layer
    expect(vornBundle.lines.filter((l) => l.text === "global abuse")).toHaveLength(1);

    // refusals: the same pair inside the hour, an unknown name, a bad kind, no session
    const again = await post(`${main!.url}/reports`, { characterId: rena.id, target: "Tolk", reason: "again", kind: "chat" }, rena.session);
    expect(again.status).toBe(429);
    expect(again.json.error).toBe("you already reported Tolk in the last hour");
    const nobody = await post(`${main!.url}/reports`, { characterId: rena.id, target: "Nobodyhere", reason: "x", kind: "chat" }, rena.session);
    expect(nobody.status).toBe(404);
    expect(nobody.json.error).toBe('no character called "Nobodyhere"');
    const badKind = await post(`${main!.url}/reports`, { characterId: rena.id, target: "Cass", reason: "x", kind: "vibes" }, rena.session);
    expect(badKind.status).toBe(400);
    expect((await post(`${main!.url}/reports`, { characterId: rena.id, target: "Cass", reason: "x", kind: "chat" })).status).toBe(401);
  });
});
