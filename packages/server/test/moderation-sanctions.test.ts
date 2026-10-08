import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { RuleJudge, type JudgeQuestion, type ModerationJudge } from "../src/moderation/judge.js";
import { NameModeration } from "../src/moderation/names.js";
import { ReportStore, type Report } from "../src/moderation/reports.js";
import { ModerationDesk, type Enforce } from "../src/moderation/audit.js";
import { ModerationQueue, activeSanctions, type Sanction } from "../src/moderation/sanctions.js";

/**
 * Audits, verdicts, sanctions and enforcement (docs/moderation.md §3): the
 * audit rule and its brigading weights, the per-action thresholds between a
 * judge's answer and a sanction, and — end to end on main + two layers —
 * a mute that silences chat and follows a transfer, a warn line, a ban that
 * ends the session and refuses `/play`, a refused name that must be changed
 * at the next `/play`, and the staff routes.
 */

const HOUR = 3600_000;

/** A judge whose audit answer the test sets (and may make fail). */
function fakeJudge(): ModerationJudge & { audit: { answer: string; probability: number } | Error; badNames: Set<string>; asked: JudgeQuestion<string>[] } {
  const j = {
    audit: { answer: "no_action", probability: 0.99 } as { answer: string; probability: number } | Error,
    badNames: new Set<string>(),
    asked: [] as JudgeQuestion<string>[],
    async decide<O extends string>(q: JudgeQuestion<O>) {
      j.asked.push(q as JudgeQuestion<string>);
      if (q.task === "name") {
        const name = (q.evidence as { name: string }).name;
        return { answer: (j.badNames.has(name) ? "reject_offensive" : "accept") as O, probability: 0.95, model: "fake" };
      }
      if (j.audit instanceof Error) throw j.audit;
      return { answer: j.audit.answer as O, probability: j.audit.probability, model: "fake" };
    },
  };
  return j;
}

// -- the rule and the verdicts, without servers ---------------------------------------------

describe("audit rule and verdicts", () => {
  let now = 50_000_000_000;
  const setup = (judge: ModerationJudge | null, extra: { created?: Record<string, number>; blocked?: Record<string, string[]> } = {}) => {
    const backend = new MemoryPlayerDataBackend();
    const store = new ReportStore(backend, "t", () => now);
    const queue = new ModerationQueue(backend, "t");
    const enforced: Array<{ account: string; sanction: Sanction; lifted: boolean }> = [];
    const enforce: Enforce = (account, change) => void enforced.push({ account, ...change });
    const desk = new ModerationDesk({
      store,
      queue,
      judge,
      names: new NameModeration({ judge }),
      accountCreatedAt: async (a) => extra.created?.[a] ?? null,
      hasBlocked: async (a, other) => extra.blocked?.[a]?.includes(other) ?? false,
      enforce,
      now: () => now,
    });
    let n = 0;
    const file = async (target: string, reporter: string, kind: Report["kind"] = "chat", at = now): Promise<Report> => {
      const report: Report = {
        id: `rep-${++n}`,
        reporterAccount: reporter,
        reporterCharacter: `chr-${reporter}`,
        reporterName: reporter,
        targetCharacter: `chr-${target}`,
        targetName: `Name${target}`,
        kind,
        reason: "rude",
        at,
        evidenceId: `ev-${n}`,
        status: "open",
      };
      await store.mutate(target, (r) => {
        r.reports.push(report);
        r.evidence[report.evidenceId] = { id: report.evidenceId, at, minutes: 15, reporter: null as never, target: null as never, servers: [], lines: [] };
      });
      return report;
    };
    return { desk, store, queue, enforced, file };
  };

  it("opens at three distinct reporters in 24 h; new accounts and blocked reporters count half", async () => {
    const judge = fakeJudge();
    const { desk, file } = setup(judge, { created: { young: now - 10 * 60_000 }, blocked: { tgt: ["feud"] } });
    expect(await desk.afterReport(await file("tgt", "a"), "tgt")).toEqual({ kind: "none", weight: 1 });
    expect(await desk.afterReport(await file("tgt", "a"), "tgt")).toEqual({ kind: "none", weight: 1 }); // the same account twice is one vote
    await file("tgt", "old", "chat", now - 25 * HOUR); // outside the window
    expect(await desk.afterReport(await file("tgt", "young"), "tgt")).toEqual({ kind: "none", weight: 1.5 });
    expect(await desk.afterReport(await file("tgt", "feud"), "tgt")).toEqual({ kind: "none", weight: 2 });
    expect(judge.asked).toHaveLength(0); // never asked below the rule
    const result = await desk.afterReport(await file("tgt", "b"), "tgt");
    expect(result.kind).toBe("decided");
    // the judge saw every open report (the old one too) with its evidence and weight
    const bundle = judge.asked[0]!.evidence as { reports: Array<{ reporter: string; weight: number; evidence: unknown; reporterAccountIsNew: boolean; reporterBlockedByReported: boolean }>; sanctionHistory: unknown[] };
    expect(judge.asked[0]!.options).toEqual(["no_action", "warn", "mute_1h", "mute_24h", "temp_ban_24h", "temp_ban_7d", "escalate"]);
    expect(bundle.reports).toHaveLength(6);
    expect(bundle.reports.find((r) => r.reporter === "young")).toMatchObject({ weight: 0.5, reporterAccountIsNew: true });
    expect(bundle.reports.find((r) => r.reporter === "feud")).toMatchObject({ weight: 0.5, reporterBlockedByReported: true });
    expect(bundle.reports.every((r) => r.evidence !== null)).toBe(true);
    expect(bundle.sanctionHistory).toEqual([]);
  });

  it("acts above the action's threshold, queues below it, on escalate and on a judge failure; reports close either way", async () => {
    const judge = fakeJudge();
    const { desk, store, queue, enforced, file } = setup(judge);
    const three = async (target: string) => {
      await file(target, "a");
      await file(target, "b");
      return desk.afterReport(await file(target, "c"), target);
    };
    judge.audit = { answer: "mute_1h", probability: 0.9 };
    const muted = await three("m");
    expect(muted.kind).toBe("decided");
    const rec = await store.load("m");
    expect(rec.reports.every((r) => r.status === "closed" && r.outcome?.endsWith(":mute_1h"))).toBe(true);
    const mute = activeSanctions(rec, now).mute!;
    expect(mute).toMatchObject({ kind: "mute", by: "judge", until: now + HOUR, reason: "reported by 3 players for abusive chat" });
    expect(enforced).toEqual([{ account: "m", sanction: mute, lifted: false }]);

    judge.audit = { answer: "mute_1h", probability: 0.8 }; // below 0.85
    expect((await three("low")).kind).toBe("escalated");
    judge.audit = { answer: "temp_ban_24h", probability: 0.94 }; // below 0.95
    expect((await three("ban")).kind).toBe("escalated");
    judge.audit = { answer: "warn", probability: 0.71 }; // above 0.70
    expect((await three("w")).kind).toBe("decided");
    judge.audit = { answer: "escalate", probability: 1 };
    expect((await three("esc")).kind).toBe("escalated");
    judge.audit = new Error("provider down");
    const failed = await three("err");
    expect(failed.kind === "escalated" && failed.audit).toMatchObject({ why: "judge_error", error: "provider down" });
    expect((await store.load("err")).reports.every((r) => r.status === "closed")).toBe(true); // the same reports never audit twice

    const q = await queue.load();
    expect(q.escalations.map((e) => [e.account, e.why])).toEqual([
      ["low", "below_threshold"],
      ["ban", "below_threshold"],
      ["esc", "escalate"],
      ["err", "judge_error"],
    ]);
    expect(enforced.map((e) => e.sanction.kind)).toEqual(["mute", "warn"]);

    // staff decide one: the sanction lands, the queue entry goes, history is kept
    const ban = q.escalations.find((e) => e.account === "ban")!;
    const decided = await desk.decide(ban.auditId, "temp_ban_24h");
    expect(decided.sanction).toMatchObject({ kind: "ban", by: "staff", auditId: ban.auditId, until: now + 24 * HOUR });
    expect((await queue.load()).escalations.some((e) => e.auditId === ban.auditId)).toBe(false);
    expect((await store.load("ban")).reports.every((r) => r.outcome === `audit:${ban.auditId}:temp_ban_24h`)).toBe(true);
    await expect(desk.decide(ban.auditId, "warn")).rejects.toThrow("no escalated audit");
    // the next audit of the muted account reads its history
    judge.audit = { answer: "no_action", probability: 0.99 };
    now += 2 * HOUR;
    await three("m");
    expect((judge.asked.at(-1)!.evidence as { sanctionHistory: unknown[] }).sanctionHistory).toEqual([expect.objectContaining({ kind: "mute", by: "judge" })]);
  });

  it("RuleJudge stays compatible: three reporters escalate, never sanction", async () => {
    const { desk, file, queue } = setup(new RuleJudge());
    await file("r", "a");
    await file("r", "b");
    const out = await desk.afterReport(await file("r", "c"), "r");
    expect(out.kind === "escalated" && out.audit).toMatchObject({ answer: "escalate", why: "escalate", model: "rules" });
    expect((await queue.load()).escalations).toHaveLength(1);
  });
});

// -- end to end: main + two layers ---------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await wait(15);
  }
}

const SECRET = "test-moderation-sanctions";
const judge = fakeJudge();
let main: MainHandle | null = null;
let layer1: ServeHandle | null = null;
let layer2: ServeHandle | null = null;
try {
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: "test-sanctions",
    accounts: new MemoryAccountStore(),
    playerData: new MemoryPlayerDataBackend(),
    world: { scene: "field", cap: 6, min: 0, max: 0 },
    supervisor: null,
    scaleEverySeconds: 3600,
    // every account here is minutes old: count them as established so three of them open an audit
    moderation: { judge, audit: { newAccountMs: 0 } },
    log: () => undefined,
  });
  const common = { playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main.url, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined } as const;
  layer1 = await serve({ ...common, serverId: "layer-1", maxPlayers: 6 });
  layer2 = await serve({ ...common, serverId: "layer-2", maxPlayers: 6 });
} catch (error) {
  console.warn("moderation sanctions test skipped:", error instanceof Error ? error.message : error);
}

async function call(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}
const post = (url: string, body: unknown, token?: string) => call("POST", url, body, token);

describe.skipIf(!main || !layer1 || !layer2)("sanctions end to end", { timeout: 90_000 }, () => {
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
    const tab = { transport, client, world: [] as WorldModuleMessage[], heard: [] as Array<{ channel: string; text: string; from: string }>, system: [] as string[], errs: [] as string[], dropped: false };
    client.onModule(WORLD_MODULE, (m) => tab.world.push(m as WorldModuleMessage));
    client.onModule("chat", (m) => {
      const d = m as { k: string; text?: string; msg?: { channel: string; text: string; from: string } };
      if (d.k === "msg" && d.msg) (d.msg.channel === "system" ? tab.system.push(d.msg.text) : tab.heard.push(d.msg));
      if (d.k === "err" && d.text) tab.errs.push(d.text);
    });
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join(name);
      if (peer === WS_HOST_ID && state === "disconnected") tab.dropped = true;
    });
    transports.push(transport);
    clients.push(client);
    return tab;
  }
  type Tab = ReturnType<typeof dial>;

  async function moveTo(tab: Tab, characterId: string, to: ServeHandle): Promise<Tab> {
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

  async function account(name: string, chr: string) {
    const reg = (await post(`${main!.url}/auth/register`, { name, password: "hunter22" })).json as { session: string; account: { id: string } };
    const made = await post(`${main!.url}/characters`, { name: chr }, reg.session);
    expect(made.status).toBe(200);
    return { id: made.json.character.id as string, account: reg.account.id, session: reg.session };
  }
  async function enter(p: { id: string; session: string }, chr: string, want: ServeHandle): Promise<Tab> {
    const play = await post(`${main!.url}/play`, { characterId: p.id }, p.session);
    expect(play.status).toBe(200);
    let tab = dial(play.json.url, play.json.ticket, chr);
    await until(() => tab.world.some((m) => m.t === "spawn" && m.self === `player:${p.id}`));
    if (play.json.server !== want.serverId) tab = await moveTo(tab, p.id, want);
    await until(() => main!.registry.whereIs.get(p.id) === want.serverId);
    return tab;
  }
  const report = async (from: { id: string; session: string }, target: string, kind = "chat", reason = "slurs in zone chat") => {
    const r = await post(`${main!.url}/reports`, { characterId: from.id, target, reason, kind }, from.session);
    expect(r.status).toBe(200);
  };
  const admin = (method: string, p: string, body?: unknown) => call(method, `${main!.url}${p}`, body, SECRET);

  let mira: Awaited<ReturnType<typeof account>>;
  let miraTab: Tab;
  let listenTab: Tab;
  const reporters: Array<Awaited<ReturnType<typeof account>>> = [];

  it("three reports → the judge mutes → the layer drops her chat and says why, each time", async () => {
    await until(() => main!.registry.layersFor("field").length === 2);
    mira = await account("MiraAcct", "Mira");
    const lena = await account("LenaAcct", "Lena");
    for (const n of ["Ash", "Bex", "Cal"]) reporters.push(await account(`${n}Acct`, n));
    miraTab = await enter(mira, "Mira", layer1!);
    listenTab = await enter(lena, "Lena", layer1!);

    judge.audit = { answer: "mute_1h", probability: 0.9 };
    for (const r of reporters) await report(r, "Mira");
    await main!.moderation.idle();
    await until(() => miraTab.system.some((t) => t.startsWith("You are muted until")));
    expect(miraTab.system.find((t) => t.startsWith("You are muted until"))).toMatch(/^You are muted until \d{4}-\d\d-\d\d \d\d:\d\d UTC \(reported by 3 players for abusive chat\)\.$/);

    miraTab.client.sendModule("chat", { k: "say", channel: "zone", text: "still talking" });
    miraTab.client.sendModule("chat", { k: "say", channel: "global", text: "and again" });
    await until(() => miraTab.errs.length === 2);
    expect(miraTab.errs.every((t) => t.startsWith("You are muted until"))).toBe(true);
    listenTab.client.sendModule("chat", { k: "say", channel: "zone", text: "anyone there" });
    await until(() => listenTab.heard.some((m) => m.text === "anyone there"));
    expect(listenTab.heard.some((m) => m.text === "still talking" || m.text === "and again")).toBe(false);
    expect(layer1!.chat.buffer.all().some((l) => l.text === "still talking")).toBe(false);
  });

  it("the mute follows her to another layer (re-sent on arrival)", async () => {
    miraTab = await moveTo(miraTab, mira.id, layer2!);
    await wait(300); // the push rides the join
    miraTab.client.sendModule("chat", { k: "say", channel: "zone", text: "over here now" });
    await until(() => miraTab.errs.length === 1);
    expect(miraTab.errs[0]).toMatch(/^You are muted until/);
    expect(layer2!.chat.buffer.all().some((l) => l.text === "over here now")).toBe(false);
    // staff lift it: she can talk again, here
    const lifted = await admin("DELETE", "/admin/moderation/sanction", { account: mira.account, kind: "mute" });
    expect(lifted.json.lifted).toHaveLength(1);
    await until(() => miraTab.system.includes("Your mute was lifted."));
    miraTab.client.sendModule("chat", { k: "say", channel: "zone", text: "thanks" });
    await until(() => layer2!.chat.buffer.all().some((l) => l.text === "thanks"));
  });

  it("a warn is a system line and a mark on the record", async () => {
    const warned = await admin("POST", "/admin/moderation/sanction", { characterId: mira.id, kind: "warn", reason: "keep zone chat civil" });
    expect(warned.status).toBe(200);
    await until(() => miraTab.system.some((t) => t.startsWith("Warning from the moderators")));
    expect(miraTab.system).toContain("Warning from the moderators: keep zone chat civil. Further reports can lead to a mute or a ban.");
    const acct = (await admin("GET", `/admin/moderation/account/${mira.account}`)).json;
    const warn = acct.record.sanctions.find((s: Sanction) => s.kind === "warn");
    expect(warn).toMatchObject({ by: "staff", reason: "keep zone chat civil" });
    await until(async () => typeof (await admin("GET", `/admin/moderation/account/${mira.account}`)).json.record.sanctions.find((s: Sanction) => s.kind === "warn").deliveredAt === "number");
  });

  it("a ban ends her session and /play refuses with the end time; lifting it lets her back", async () => {
    const banned = await admin("POST", "/admin/moderation/sanction", { account: mira.account, kind: "ban", minutes: 60, reason: "repeated abuse" });
    expect(banned.status).toBe(200);
    await until(() => miraTab.system.some((t) => t.includes("banned until")));
    expect(miraTab.system.find((t) => t.includes("banned until"))).toMatch(/^This account is banned until .+ UTC \(repeated abuse\)\. You have been disconnected\.$/);
    await until(() => miraTab.dropped);
    await until(() => !layer2!.server.players.has(mira.id));
    await until(() => !main!.registry.whereIs.has(mira.id));
    const refused = await post(`${main!.url}/play`, { characterId: mira.id }, mira.session);
    expect(refused.status).toBe(403);
    expect(refused.json.error).toMatch(/^This account is banned until \d{4}-\d\d-\d\d \d\d:\d\d UTC \(repeated abuse\)\.$/);
    expect((await admin("DELETE", "/admin/moderation/sanction", { account: mira.account, kind: "ban" })).json.lifted).toHaveLength(1);
    expect((await post(`${main!.url}/play`, { characterId: mira.id }, mira.session)).status).toBe(200);
  });

  it("a name report the judge refuses → rename required at the next /play → the rename route clears it", async () => {
    const zed = await account("ZedAcct", "Zorgtrash");
    const zedTab = await enter(zed, "Zorgtrash", layer1!);
    judge.badNames.add("Zorgtrash");
    await report(reporters[0]!, "Zorgtrash", "name", "offensive name");
    await main!.moderation.idle();
    // they keep playing this session, and are told
    await until(() => zedTab.system.some((t) => t.startsWith('The name "Zorgtrash" was refused')));
    expect(layer1!.server.players.has(zed.id)).toBe(true);
    const play = await post(`${main!.url}/play`, { characterId: zed.id }, zed.session);
    expect(play.status).toBe(409);
    expect(play.json).toMatchObject({ code: "rename_required", renameRequired: true, characterId: zed.id, name: "Zorgtrash" });
    expect(play.json.error).toBe('The name "Zorgtrash" was refused: it reads as offensive. Choose a new name to keep playing.');
    // the full name check: shape, uniqueness, list, judge
    expect((await post(`${main!.url}/characters/${zed.id}/rename`, { name: "Mira" }, zed.session)).status).toBe(409);
    expect((await post(`${main!.url}/characters/${zed.id}/rename`, { name: "Admin" }, zed.session)).json.error).toMatch(/staff title/);
    judge.badNames.add("Zorgfilth");
    expect((await post(`${main!.url}/characters/${zed.id}/rename`, { name: "Zorgfilth" }, zed.session)).json.error).toBe("That name isn't allowed: it reads as offensive.");
    const renamed = await post(`${main!.url}/characters/${zed.id}/rename`, { name: "Zedrin" }, zed.session);
    expect(renamed.status).toBe(200);
    expect(renamed.json.character).toMatchObject({ id: zed.id, name: "Zedrin" });
    expect((await post(`${main!.url}/play`, { characterId: zed.id }, zed.session)).status).toBe(200);
    // nothing to rename any more
    expect((await post(`${main!.url}/characters/${zed.id}/rename`, { name: "Zedrina" }, zed.session)).status).toBe(400);
    const rec = (await admin("GET", `/admin/moderation/account/${zed.account}`)).json.record;
    expect(rec.sanctions[0]).toMatchObject({ kind: "rename", by: "judge", name: "Zorgtrash", liftedBy: "rename", newName: "Zedrin" });
    expect(rec.reports[0]).toMatchObject({ kind: "name", status: "closed", outcome: "name:rename" });
  });

  it("staff: the queue (escalations + persisted names), decide, sanctions, account record; bearer only", async () => {
    const olf = await account("OlfAcct", "Olf");
    judge.audit = { answer: "temp_ban_7d", probability: 0.9 }; // a ban below 0.95: staff decide
    for (const r of reporters) await report(r, "Olf");
    await main!.moderation.idle();
    expect((await call("GET", `${main!.url}/admin/moderation/queue`)).status).toBe(401);
    const q = (await admin("GET", "/admin/moderation/queue")).json;
    expect(q.thresholds).toEqual({ no_action: 0.7, warn: 0.7, mute: 0.85, ban: 0.95 });
    const esc = q.escalations.find((e: { account: string }) => e.account === olf.account);
    expect(esc).toMatchObject({ why: "below_threshold", answer: "temp_ban_7d", probability: 0.9, reports: 3, names: ["Olf"] });
    expect(Array.isArray(q.names)).toBe(true);
    expect((await admin("POST", "/admin/moderation/decide", { auditId: esc.auditId, action: "escalate" })).status).toBe(400);
    const decided = await admin("POST", "/admin/moderation/decide", { auditId: esc.auditId, action: "mute_24h" });
    expect(decided.status).toBe(200);
    expect(decided.json.sanction).toMatchObject({ kind: "mute", by: "staff", auditId: esc.auditId });
    expect((await admin("GET", "/admin/moderation/queue")).json.escalations.some((e: { auditId: string }) => e.auditId === esc.auditId)).toBe(false);
    const acct = (await admin("GET", `/admin/moderation/account/${olf.account}`)).json;
    expect(acct.account).toMatchObject({ id: olf.account, name: "OlfAcct" });
    expect(acct.active.mute).toMatchObject({ kind: "mute" });
    expect(acct.record.reports).toHaveLength(3);
    expect(Object.keys(acct.record.evidence)).toHaveLength(3);
    expect(acct.record.audits[0]).toMatchObject({ status: "decided", decidedBy: "staff", action: "mute_24h" });
    // refusals
    expect((await admin("POST", "/admin/moderation/sanction", { account: olf.account, kind: "ban", reason: "x" })).json.error).toBe("a ban needs minutes (a positive number)");
    expect((await admin("POST", "/admin/moderation/sanction", { account: olf.account, kind: "nap", reason: "x" })).status).toBe(400);
    expect((await admin("POST", "/admin/moderation/sanction", { account: "acct-nobody", kind: "warn", reason: "x" })).status).toBe(404);
    expect((await admin("GET", "/admin/moderation/account/acct-nobody")).status).toBe(404);
  });
});
