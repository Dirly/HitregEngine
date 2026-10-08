import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import {
  addItem,
  corpseContents,
  createSheet,
  equip,
  itemSchema,
  lootBag,
  MemoryPlayerDataBackend,
  NetStateStore,
  placeStack,
  registerCharacterNetState,
  transferStack,
  unequip,
  vaultDeposit,
  vaultWithdraw,
  type CharacterSheet,
  type EntityDoc,
  type Item,
  type Vault,
} from "@hitreg/core";
import { ItemsLogCollector, ItemsLogMain, ItemsLogStore, itemClaimEvidenceFrom, type ItemLogEntry, type ItemLogFlush } from "../src/moderation/items-log.js";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * The item log (docs/moderation.md §4): the layer collector diffs the sheets and vaults the authority writes,
 * main stores per character, flags dupes and answers claims. No world, no sockets: a bare NetStateStore with the
 * character namespaces is exactly what the collector sees on a layer.
 */

const items: Record<string, Item> = {
  sword: itemSchema.parse({ name: "Sword", kind: "equipment", slots: ["primary"] }),
  helm: itemSchema.parse({ name: "Helm", kind: "equipment", slots: ["helm"] }),
  potion: itemSchema.parse({ name: "Potion", kind: "consumable", stack: 20 }),
};
const env = { catalog: (id: string) => items[id] };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
}

function rig(opts: { send?: (f: ItemLogFlush) => Promise<unknown> } = {}) {
  const ns = new NetStateStore();
  ns.setAuthority(true);
  registerCharacterNetState(ns);
  const sent: ItemLogFlush[] = [];
  let n = 0;
  const collector = new ItemsLogCollector({
    netState: ns,
    catalog: env.catalog,
    server: "layer-1",
    clock: () => 1000,
    mintId: () => `iid-${++n}`,
    send: opts.send ?? (async (f) => void sent.push(f)),
  });
  const sheet = (body: string): CharacterSheet => ns.get(`character/${body}`) as CharacterSheet;
  const uidOf = (body: string, itemId: string): string => Object.entries(sheet(body).items).find(([, s]) => s.itemId === itemId)![0];
  return { ns, collector, sent, sheet, uidOf };
}

const kinds = (entries: ItemLogEntry[]): string[] => entries.map((e) => `${e.t}:${e.itemId}${e.instanceId ? `#${e.instanceId}` : ""}x${e.count}${e.detail ? `(${e.detail})` : ""}`);

describe("item log — layer collector (sheet diff)", () => {
  it("stamps unique items, baselines silently, then logs pickup / equip / unequip / lost", async () => {
    const { ns, collector, sheet, uidOf } = rig();
    let s = ok(addItem(createSheet(), "sword", 1, env)).sheet;
    s = ok(addItem(s, "potion", 3, env)).sheet;
    ns.set("character/b1", s);
    collector.track("b1", "c1");
    await tick();
    // the unique sword got an instance id; the potions did not
    const sword = sheet("b1").items[uidOf("b1", "sword")]!;
    expect(sword.iid).toBe("iid-1");
    expect(sheet("b1").items[uidOf("b1", "potion")]!.iid).toBeUndefined();
    expect(collector.pendingEntries("c1")).toEqual([]); // the baseline is not news

    ns.set("character/b1", ok(addItem(sheet("b1"), "helm", 1, env)).sheet); // pickup
    await tick();
    ns.set("character/b1", ok(equip(sheet("b1"), uidOf("b1", "sword"), "primary", env)).sheet);
    await tick();
    ns.set("character/b1", ok(unequip(sheet("b1"), "primary", undefined, env)).sheet);
    await tick();
    ns.set("character/b1", ok(addItem(sheet("b1"), "potion", 2, env)).sheet); // goods by count
    await tick();
    // death: the carried things go into the corpse (core corpseContents)
    const dead = corpseContents(sheet("b1"), env);
    ns.set("lootbag/corpse-1", { ...lootBag("b1", [0, 0, 0], dead.items), corpse: "b1" });
    ns.set("character/b1", dead.sheet);
    await tick();
    expect(kinds(collector.pendingEntries("c1"))).toEqual([
      "pickup:helm#iid-2x1",
      "equip:sword#iid-1x1",
      "unequip:sword#iid-1x1",
      "pickup:potionx2",
      "lost:sword#iid-1x1(death)",
      "lost:helm#iid-2x1(death)",
      "lost:potionx5(death)",
    ]);
    expect(collector.pendingEntries("c1").every((e) => e.server === "layer-1" && e.at === 1000)).toBe(true);
  });

  it("sees vault moves as moves, and a hand-over between two characters as lost/pickup naming each other", async () => {
    const { ns, collector, sheet, uidOf } = rig();
    ns.set("character/a", ok(addItem(createSheet(), "sword", 1, env)).sheet);
    ns.set("character/b", createSheet());
    ns.set("vault/a", { capacity: 24, coins: 0, items: [] });
    collector.track("a", "char-a");
    collector.track("b", "char-b");
    await tick();
    // a reducer that writes the sheet and the vault in one go is one move
    const dep = ok(vaultDeposit(sheet("a"), ns.get("vault/a") as Vault, uidOf("a", "sword"), undefined, env));
    ns.set("character/a", dep.sheet);
    ns.set("vault/a", dep.vault);
    await tick();
    const wd = ok(vaultWithdraw(sheet("a"), ns.get("vault/a") as Vault, 0, undefined, env));
    ns.set("character/a", wd.sheet);
    ns.set("vault/a", wd.vault);
    await tick();
    // the instance keeps its id through the vault
    expect(sheet("a").items[uidOf("a", "sword")]!.iid).toBe("iid-1");
    // looting a body: both sheets in one pass
    const t = ok(transferStack(sheet("a"), sheet("b"), uidOf("a", "sword"), undefined, env, { allowWorn: true }));
    ns.set("character/a", t.from);
    ns.set("character/b", t.to);
    await tick();
    expect(sheet("b").items[uidOf("b", "sword")]!.iid).toBe("iid-1");
    expect(kinds(collector.pendingEntries("char-a"))).toEqual(["vault_in:sword#iid-1x1", "vault_out:sword#iid-1x1", "lost:sword#iid-1x1(to char-b)"]);
    expect(kinds(collector.pendingEntries("char-b"))).toEqual(["pickup:sword#iid-1x1(from char-a)"]);
  });

  it("batches every character into one flush, sends the holding snapshot once, and keeps a failed send for the next", async () => {
    let fail = true;
    const got: ItemLogFlush[] = [];
    const { ns, collector, sheet } = rig({ send: async (f) => (fail ? Promise.reject(new Error("main down")) : void got.push(f)) });
    ns.set("character/a", ok(addItem(createSheet(), "sword", 1, env)).sheet);
    collector.track("a", "char-a");
    await tick();
    ns.set("character/a", ok(addItem(sheet("a"), "helm", 1, env)).sheet);
    await collector.flush(); // fails: kept
    expect(collector.unsent).toBe(1);
    ns.set("character/a", ok(addItem(sheet("a"), "potion", 1, env)).sheet);
    fail = false;
    await collector.flush();
    expect(collector.unsent).toBe(0);
    expect(got).toHaveLength(2);
    expect(got[0]!.batches).toEqual([{ characterId: "char-a", entries: [expect.objectContaining({ t: "pickup", itemId: "helm" })], holding: ["iid-1"] }]);
    expect(got[1]!.batches[0]!.holding).toBeUndefined();
    expect(kinds(got[1]!.batches[0]!.entries)).toEqual(["pickup:potionx1"]);
    expect(got[0]!.batchId).not.toBe(got[1]!.batchId);
  });

  it("a body cleared away on leave is not a loss", async () => {
    const { ns, collector } = rig();
    ns.set("character/a", ok(addItem(createSheet(), "sword", 1, env)).sheet);
    collector.track("a", "char-a");
    await tick();
    ns.delete("character/a");
    collector.untrack("a");
    await tick();
    expect(collector.pendingEntries()).toEqual([]);
  });
});

const entry = (t: ItemLogEntry["t"], instanceId: string | null, itemId: string, at: number, count = 1): ItemLogEntry => ({ t, instanceId, itemId, count, server: "layer-1", at });

describe("item log — main", () => {
  it("appends per character and rotates past the hot cap into a ring of archives", async () => {
    const backend = new MemoryPlayerDataBackend();
    const store = new ItemsLogStore(backend, "exp", { hotMax: 4, archives: 2 });
    for (let i = 0; i < 10; i++) await store.append("c1", [entry("pickup", null, `ore-${i}`, i)]);
    const hot = await backend.load({ playerId: "c1", experienceId: "exp" }, "items-log");
    expect((hot!.data["entries"] as unknown[]).length).toBeLessThanOrEqual(4);
    // 10 entries, hot 4 + 2 archives of 2: the oldest chunk was overwritten (rotation)
    const all = await store.read("c1");
    expect(all.map((e) => e.itemId)).toEqual(["ore-2", "ore-3", "ore-4", "ore-5", "ore-6", "ore-7", "ore-8", "ore-9"]);
    expect((await store.read("c1", { limit: 3 })).map((e) => e.itemId)).toEqual(["ore-7", "ore-8", "ore-9"]);
    expect((await store.read("c1", { item: "ore-3" })).map((e) => e.at)).toEqual([3]);
    expect(await store.read("nobody")).toEqual([]);
  });

  it("flags an instance that arrives twice without leaving — once — and applies a resent batch once", async () => {
    const main = new ItemsLogMain({ backend: new MemoryPlayerDataBackend(), experienceId: "exp", log: () => undefined });
    const flush: ItemLogFlush = { batchId: "layer-1:1", batches: [{ characterId: "c1", entries: [entry("pickup", "X", "sword", 1)] }] };
    await main.ingest("layer-1", flush);
    await main.ingest("layer-1", flush); // a resend after a lost answer
    expect(await main.dupes()).toEqual([]);
    expect(await main.lookup("c1")).toHaveLength(1);
    // lost then picked up again (a buy-back): fine
    await main.ingest("layer-1", { batchId: "layer-1:2", batches: [{ characterId: "c1", entries: [entry("lost", "X", "sword", 2), entry("pickup", "X", "sword", 3)] }] });
    expect(await main.dupes()).toEqual([]);
    // arrives again while held: a case, and only one however often it is seen
    await main.ingest("layer-1", { batchId: "layer-1:3", batches: [{ characterId: "c1", entries: [entry("pickup", "X", "sword", 4)] }] });
    await main.ingest("layer-1", { batchId: "layer-1:4", batches: [{ characterId: "c1", entries: [entry("pickup", "X", "sword", 5)] }] });
    const cases = await main.dupes();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ kind: "arrived-twice", instanceId: "X", itemId: "sword", characters: ["c1"], status: "open" });
    // staff close it
    expect(await main.closeDupe(cases[0]!.id)).toBe(true);
    expect(await main.dupes()).toEqual([]);
    expect(await main.dupes({ all: true })).toHaveLength(1);
  });

  it("flags an instance on two characters at once after the grace, but not a hand-over whose leave arrives late", async () => {
    let now = 0;
    const main = new ItemsLogMain({ backend: new MemoryPlayerDataBackend(), experienceId: "exp", graceMs: 1000, clock: () => now, log: () => undefined });
    await main.ingest("layer-1", { batchId: "1", batches: [{ characterId: "a", entries: [entry("pickup", "X", "sword", 0), entry("pickup", "Y", "helm", 0)] }] });
    // a hand-over reported arrival-first (two layers' flushes crossed): the leave follows within the grace
    await main.ingest("layer-2", { batchId: "2", batches: [{ characterId: "b", entries: [entry("pickup", "X", "sword", 1)] }] });
    now = 500;
    await main.ingest("layer-1", { batchId: "3", batches: [{ characterId: "a", entries: [entry("lost", "X", "sword", 1)] }] });
    now = 5000;
    expect(await main.dupes()).toEqual([]);
    expect(main.holderOf("X")).toBe("b");
    // a rolled-back save: "c" arrives on a layer still holding Y, which "a" never let go of
    await main.ingest("layer-3", { batchId: "4", batches: [{ characterId: "c", entries: [], holding: ["Y"] }] });
    expect(await main.dupes()).toEqual([]); // inside the grace
    now = 7000;
    const cases = await main.dupes();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ kind: "two-characters", instanceId: "Y", characters: ["a", "c"] });
  });

  it("a holding snapshot that arrives before the old layer's last entries is not a dupe", async () => {
    const main = new ItemsLogMain({ backend: new MemoryPlayerDataBackend(), experienceId: "exp", log: () => undefined });
    await main.ingest("layer-2", { batchId: "1", batches: [{ characterId: "a", entries: [], holding: ["Z"] }] });
    await main.ingest("layer-1", { batchId: "2", batches: [{ characterId: "a", entries: [entry("pickup", "Z", "sword", 1)] }] });
    expect(await main.dupes()).toEqual([]);
    expect(main.holderOf("Z")).toBe("a");
  });

  it("answers a claim from the log, and a restore writes `restored`", async () => {
    const main = new ItemsLogMain({ backend: new MemoryPlayerDataBackend(), experienceId: "exp", log: () => undefined });
    await main.ingest("layer-1", {
      batchId: "1",
      batches: [{ characterId: "c1", entries: [entry("pickup", "X", "sword", 1), entry("equip", "X", "sword", 2), entry("lost", "X", "sword", 3), entry("pickup", null, "ore", 4, 5)] }],
    });
    const claim = await main.claimEvidence("c1", "X");
    expect(claim.entries.map((e) => e.t)).toEqual(["pickup", "equip", "lost"]);
    expect(claim.holds).toBe(false);
    expect(claim.lastLeft?.at).toBe(3);
    expect(claim.dupeCases).toEqual([]);
    expect((await main.claimEvidence("c1", "ore")).holds).toBe(5);
    expect((await main.claimEvidence("c1", "nothing")).holds).toBeNull();
    await main.restore("c1", { instanceId: "X", itemId: "sword", detail: "claim granted" });
    expect((await main.claimEvidence("c1", "X")).holds).toBe(true);
    // the admin route
    const r = await main.admin("GET", "/admin/items-log/c1", new URLSearchParams("item=sword"));
    expect(r?.status).toBe(200);
    expect((r?.body as { entries: ItemLogEntry[] }).entries.map((e) => e.t)).toEqual(["pickup", "equip", "lost", "restored"]);
    expect(await main.admin("GET", "/admin/elsewhere", new URLSearchParams())).toBeNull();
    expect(itemClaimEvidenceFrom("c1", "X", []).holds).toBeNull();
  });
});

// -- end to end: one layer, main, the real cluster link ----------------------------------------------------------

const playground = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/playground");
const SECRET = "test-items-log-secret";
let e2eMain: MainHandle | null = null;
let e2eLayer: ServeHandle | null = null;
try {
  e2eMain = await startMain({
    port: 0, host: "127.0.0.1", secret: SECRET, experienceId: "test-items-log", accounts: new MemoryAccountStore(), playerData: new MemoryPlayerDataBackend(),
    world: { scene: "field", cap: 4, min: 0, max: 0 }, supervisor: null, scaleEverySeconds: 3600, log: () => undefined,
  });
  e2eLayer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: e2eMain.url, serverId: "layer-1", maxPlayers: 4, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("item-log e2e skipped:", error instanceof Error ? error.message : error);
}

describe.skipIf(!e2eMain || !e2eLayer)("item log — end to end through main", { timeout: 60_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  afterAll(async () => {
    for (const t of transports) t.close();
    await e2eLayer?.close();
    await e2eMain?.close();
  });
  const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> => {
    const start = Date.now();
    while (!(await cond())) {
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const post = async (url: string, body: unknown, token?: string): Promise<any> =>
    (await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();

  it("a pickup on a layer reaches main's log with a stamped instance id, and the staff routes answer", async () => {
    const main = e2eMain!, layer = e2eLayer!;
    const net = layer.world.netState;
    const s = await post(`${main.url}/auth/register`, { name: "loggy", password: "hunter22" });
    const characterId = (await post(`${main.url}/characters`, { name: "Loggy" }, s.session)).character.id as string;
    const body = `player:${characterId}`;
    const play = await post(`${main.url}/play`, { characterId }, s.session);
    const transport = new WebSocketClientTransport(play.url, { peerId: "tab-log", ticket: play.ticket });
    transports.push(transport);
    const client = new RoomClient(transport, WS_HOST_ID);
    const msgs: WorldModuleMessage[] = [];
    client.onModule(WORLD_MODULE, (m) => msgs.push(m as WorldModuleMessage));
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join("tab");
    });
    await until(() => msgs.some((m) => m.t === "spawn" && m.self === body), "spawn");
    const ent: EntityDoc = { name: "il-sheet", parent: null, tags: [], components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, script: { name: "character-sheet", params: { actor: body, persist: false } } } };
    layer.world.addEntities({ ...layer.world.base, entities: { "il-sheet": ent } });
    await until(() => net.get(`character/${body}`) !== undefined, "a sheet");
    await new Promise((r) => setTimeout(r, 50));
    // something the authority puts on the sheet: a pickup (the staff is unique: stack 1)
    const placed = placeStack(net.get(`character/${body}`) as CharacterSheet, { itemId: "pyre-staff", qty: 1 }, { catalog: (id) => (layer.world.assets.getDataAsset(id)?.data as Item | undefined) });
    expect(placed.ok).toBe(true);
    net.set(`character/${body}`, (placed as { sheet: CharacterSheet }).sheet);
    await until(() => Object.values((net.get(`character/${body}`) as CharacterSheet).items).some((x) => x.itemId === "pyre-staff" && typeof x.iid === "string"), "the iid stamp");
    // leaving commits — and the commit carries the log
    client.leave();
    transport.close();
    await until(async () => (await main.itemsLog.lookup(characterId)).length > 0, "main's log");
    const entries = await main.itemsLog.lookup(characterId, { item: "pyre-staff" });
    expect(entries).toEqual([expect.objectContaining({ t: "pickup", itemId: "pyre-staff", count: 1, server: "layer-1", instanceId: expect.any(String) })]);
    expect(main.itemsLog.holderOf(entries[0]!.instanceId!)).toBe(characterId);
    // the staff routes, bearer-authenticated
    const auth = { authorization: `Bearer ${SECRET}` };
    const logRes = await fetch(`${main.url}/admin/items-log/${characterId}?item=pyre-staff`, { headers: auth });
    expect(logRes.status).toBe(200);
    expect(((await logRes.json()) as { entries: unknown[] }).entries).toHaveLength(1);
    const dupes = await fetch(`${main.url}/admin/moderation/dupes`, { headers: auth });
    expect(await dupes.json()).toEqual({ cases: [] });
    expect((await fetch(`${main.url}/admin/moderation/dupes`)).status).toBe(401);
  });
});
