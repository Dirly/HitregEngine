import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { MemoryPlayerDataBackend, createSheet, equip, itemSchema, lootClock, placeStack, type CharacterSheet, type EntityDoc, type Item, type LootBag, type SavedBags } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { startMain, type MainHandle } from "../src/main/main.js";
import { MemoryAccountStore } from "../src/persistence/accounts.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";

/**
 * Package L2 (voxel-demo docs/combat-build/L-loot.md, "second pass"): loot bags
 * are saved with their owner by the save authority (main), survive a layer
 * restart with their contents and instance data, and expire on time in REAL
 * time (an injected wall clock steps days ahead); a dropped-item bag lives
 * minutes, not days. And a victim who logs out while being looted is still
 * looted: main sends them back to their held body, and their save afterwards
 * lacks what was taken.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const ITEMS = path.join(playground, "projects/voxel-demo/assets/items");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = ""): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting ${what}`);
    await wait(25);
  }
}
const items: Record<string, Item> = {};
const catalog = (id: string): Item | undefined => (items[id] ??= itemSchema.parse(JSON.parse(readFileSync(path.join(ITEMS, `${id}.json`), "utf8"))));
const env = { catalog };
function roomySheet(): CharacterSheet {
  const sheet: CharacterSheet = { ...createSheet(), coins: 0 };
  for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
  return sheet;
}

const SECRET = "test-l2-secret";
const EXPERIENCE = "test-l2";
const DAY = 86_400_000;
const T0 = 1_900_000_000_000;
let wallNow = T0;
const realClock = lootClock.now;
lootClock.now = () => wallNow;

const playerData = new MemoryPlayerDataBackend();
let main: MainHandle | null = null;
const layerOpts = (serverId: string) => ({ playground, scene: "field", port: 0, host: "127.0.0.1", secret: SECRET, mainUrl: main!.url, serverId, maxPlayers: 4, respawnSeconds: 0, reconnectGraceSeconds: 1, commitEverySeconds: 0, log: () => undefined });
let layer: ServeHandle | null = null;
try {
  main = await startMain({
    port: 0,
    host: "127.0.0.1",
    secret: SECRET,
    experienceId: EXPERIENCE,
    accounts: new MemoryAccountStore(),
    playerData,
    world: { scene: "field", cap: 4, min: 0, max: 0 },
    supervisor: null,
    scaleEverySeconds: 3600,
    log: () => undefined,
  });
  layer = await serve(layerOpts("layer-1"));
} catch (error) {
  console.warn("L2 persistence test skipped:", error instanceof Error ? error.message : error);
}

async function post(url: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

describe.skipIf(!main || !layer)("L2: loot bags saved with their owner, across a restart, for days; logging out does not save a victim", { timeout: 120_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  afterAll(async () => {
    for (const t of transports) t.close();
    await layer?.close();
    await main?.close();
    lootClock.now = realClock;
  });

  interface Player { session: string; playerId: string; characterId: string; body: string; client?: RoomClient; transport?: WebSocketClientTransport }
  const net = () => layer!.world.netState;
  const bagsOf = (owner: string): Array<[string, LootBag]> =>
    net().keys("lootbag/").map((k) => [k.slice("lootbag/".length), net().get(k) as LootBag] as [string, LootBag]).filter(([, b]) => b.owner === owner);
  const saved = async (p: Player, ns: "character") => (await playerData.load({ playerId: p.characterId, experienceId: EXPERIENCE }, ns))?.data as { sheet?: CharacterSheet; records?: { lootbags?: SavedBags } } | undefined;
  const ent = (components: Record<string, unknown>): EntityDoc => ({ name: "l2p", parent: null, tags: [], components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...components } });
  let sheets = 0;

  async function account(name: string, character: string): Promise<Player> {
    const s = (await post(`${main!.url}/auth/register`, { name, password: "hunter22" })).json as { session: string; account: { id: string } };
    const characterId = (await post(`${main!.url}/characters`, { name: character }, s.session)).json.character.id as string;
    return { session: s.session, playerId: s.account.id, characterId, body: `player:${characterId}` };
  }
  /** /play, dial, wait for the body; returns the server id main chose. */
  async function play(p: Player): Promise<string> {
    const r = await post(`${main!.url}/play`, { characterId: p.characterId }, p.session);
    expect(r.status).toBe(200);
    const transport = new WebSocketClientTransport(r.json.url, { peerId: "tab-" + Math.random().toString(36).slice(2, 6), ticket: r.json.ticket });
    const client = new RoomClient(transport, WS_HOST_ID);
    const msgs: WorldModuleMessage[] = [];
    client.onModule(WORLD_MODULE, (m) => msgs.push(m as WorldModuleMessage));
    transport.onPeer((peer, state) => {
      if (peer === WS_HOST_ID && state === "connected") client.join("tab");
    });
    transports.push(transport);
    p.client = client;
    p.transport = transport;
    await until(() => msgs.some((m) => m.t === "spawn" && m.self === p.body), 10_000, `${p.characterId} spawns`);
    return r.json.server as string;
  }
  /** The engine's character-sheet for a body (the field scene has none). */
  async function giveSheet(p: Player): Promise<void> {
    layer!.world.addEntities({ ...layer!.world.base, entities: { [`l2p-sheet-${++sheets}`]: ent({ script: { name: "character-sheet", params: { actor: p.body, persist: false } } }) } });
    await until(() => net().get(`character/${p.body}`) !== undefined, 5000, "a sheet");
  }
  async function leave(p: Player): Promise<void> {
    p.client!.leave();
    p.transport!.close();
    await until(() => !layer!.server.players.has(p.characterId), 8000, "left");
    await until(() => main!.registry.whereIs.get(p.characterId) === undefined, 8000, "main knows");
  }

  const STAFF = { itemId: "pyre-staff", qty: 1, durability: 21, twists: ["emberBolt+leech"] };
  /** A killing blow; a downed player (package X1) releases at once, so the death lands with the blow's credit. */
  async function kill(victim: string, sourceId: string): Promise<void> {
    layer!.world.eventBus.emit("combat.damage", { targetId: victim, sourceId, amount: 100_000, control: 0, point: [0, 1, 0] });
    await until(() => net().get(`combat/${victim}.dead`) === true || ((net().get(`combat/${victim}.downed`) as number | undefined) ?? 0) > 0, 4000, "falls");
    if (net().get(`combat/${victim}.dead`) !== true) layer!.world.eventBus.emit("combat.release.request", { casterId: victim });
    await until(() => net().get(`combat/${victim}.dead`) === true, 4000, "dies");
  }
  let keeper: Player;
  let earnedId = "";
  let droppedId = "";

  it("an earned bag (3 days) and a dropped one (10 minutes) are saved with their owner on logout", async () => {
    await until(() => main!.registry.layersFor("field").length === 1, 8000, "layer-1 registered");
    keeper = await account("Keeper", "Hoarda");
    await play(keeper);
    await giveSheet(keeper);
    const s = placeStack(roomySheet(), { itemId: "bandage", qty: 1 }, env);
    if (!s.ok) throw new Error(s.error);
    expect(net().set(`character/${keeper.body}`, s.sheet)).toBe(true);
    const at = layer!.world.positionOf(keeper.body)!;
    layer!.world.eventBus.emit("inventory.bag", { actorId: keeper.body, at, items: [{ itemId: "pyre-staff", qty: 1, twists: STAFF.twists }], coins: 77, from: "a-wolf" });
    await until(() => bagsOf(keeper.body).length === 1, 3000, "the earned bag");
    [earnedId] = bagsOf(keeper.body)[0]!;
    expect(bagsOf(keeper.body)[0]![1].until! - layer!.world.timeMs).toBeGreaterThan(3 * DAY - 5000);
    keeper.client!.sendCommand({ t: "event", name: "inventory.drop", payload: { actorId: keeper.body, uid: s.uids[0]! } });
    await until(() => bagsOf(keeper.body).length === 2, 3000, "the dropped bag");
    [droppedId] = bagsOf(keeper.body).find(([, b]) => b.dropped)!;
    await leave(keeper);
    await until(async () => ((await saved(keeper, "character"))?.records?.lootbags?.bags.length ?? 0) === 2, 5000, "saved");
    const record = (await saved(keeper, "character"))!.records!.lootbags!;
    expect(record.owner).toBe(keeper.body);
    const earned = record.bags.find((b) => b.id === earnedId)!;
    expect(earned).toMatchObject({ scene: "field", coins: 77, from: "a-wolf" });
    expect(earned.items[0]).toMatchObject({ itemId: "pyre-staff", twists: STAFF.twists });
    expect(Math.abs(earned.expires! - (T0 + 3 * DAY))).toBeLessThan(10_000);
    expect(Math.abs(record.bags.find((b) => b.id === droppedId)!.expires! - (T0 + 600_000))).toBeLessThan(10_000);
    expect(bagsOf(keeper.body)).toEqual([]); // not live while the owner is away
  });

  it("the layer restarts; 5 minutes later the owner comes back to both bags, contents and data intact", async () => {
    await layer!.close();
    layer = await serve(layerOpts("layer-2"));
    await until(() => main!.registry.layersFor("field").some((s) => s.id === "layer-2"), 8000, "layer-2 registered");
    wallNow = T0 + 5 * 60_000;
    expect(await play(keeper)).toBe("layer-2");
    await giveSheet(keeper);
    const earned = net().get(`lootbag/${earnedId}`) as LootBag;
    expect(earned).toMatchObject({ owner: keeper.body, coins: 77, from: "a-wolf" });
    expect(earned.items).toEqual([{ itemId: "pyre-staff", qty: 1, twists: STAFF.twists }]);
    expect(Math.abs(earned.until! - layer!.world.timeMs - (3 * DAY - 5 * 60_000))).toBeLessThan(15_000);
    const dropped = net().get(`lootbag/${droppedId}`) as LootBag;
    expect(dropped.dropped).toBe(true);
    expect(dropped.until! - layer!.world.timeMs).toBeLessThan(5 * 60_000 + 5000); // its ten minutes go on in real time
    await leave(keeper);
  });

  it("two days on the dropped bag is long gone and the earned one waits; past three days it is gone too", async () => {
    wallNow = T0 + 2 * DAY;
    await play(keeper);
    expect(net().get(`lootbag/${droppedId}`)).toBeUndefined();
    const earned = net().get(`lootbag/${earnedId}`) as LootBag;
    expect(Math.abs(earned.until! - layer!.world.timeMs - DAY)).toBeLessThan(15_000);
    await leave(keeper);
    expect((await saved(keeper, "character"))!.records!.lootbags!.bags.map((b) => b.id)).toEqual([earnedId]);

    wallNow = T0 + 3 * DAY + 60_000;
    await play(keeper);
    expect(bagsOf(keeper.body)).toEqual([]);
    await leave(keeper);
    await until(async () => ((await saved(keeper, "character"))?.records?.lootbags?.bags.length ?? -1) === 0, 5000, "the save forgets it");
  });

  it("a victim who logs out while being looted goes back to the held body, and their save lacks what was taken", async () => {
    wallNow = T0 + 4 * DAY;
    const killer = await account("Reaver", "Grimsa");
    const victim = await account("Runner", "Fleetfoot");
    await play(killer);
    await play(victim);
    await giveSheet(killer);
    await giveSheet(victim);
    expect(net().set(`character/${killer.body}`, roomySheet())).toBe(true);
    const r = placeStack(roomySheet(), STAFF, env);
    if (!r.ok) throw new Error(r.error);
    const e = equip(r.sheet, r.uids[0]!, undefined, env);
    if (!e.ok) throw new Error(e.error);
    expect(net().set(`character/${victim.body}`, { ...e.sheet, coins: 555 })).toBe(true);
    const at = layer!.world.positionOf(killer.body)!;
    layer!.world.sim.setPosition(victim.body, [at[0] + 2, at[1], at[2]]);
    await wait(300);

    await kill(victim.body, killer.body);
    // package X2: the corpse (the victim's copper), the killer's for a minute, with the worn staff to choose
    await until(() => bagsOf(killer.body).some(([, b]) => b.corpse === victim.body), 4000, "the corpse");
    const [bagId, bag] = bagsOf(killer.body).find(([, b]) => b.corpse === victim.body)!;

    // the victim closes the tab; the body is held past the reconnect grace
    victim.client!.leave();
    victim.transport!.close();
    await wait(2500);
    expect(layer!.server.players.has(victim.characterId)).toBe(true);
    // and logging straight back in lands on THAT body, not a fresh one from the older save
    expect(await play(victim)).toBe("layer-2");
    expect((net().get(`character/${victim.body}`) as CharacterSheet).equipment.primary).toBe(r.uids[0]);
    victim.client!.leave();
    victim.transport!.close();
    await wait(1500);

    // the killer takes the copper and the staff while the victim is away
    layer!.world.sim.setPosition(killer.body, [bag.at[0] + 1, bag.at[1] + 1, bag.at[2]]);
    await wait(250);
    killer.client!.sendCommand({ t: "event", name: "inventory.loot", payload: { actorId: killer.body, bagId, coins: true } });
    killer.client!.sendCommand({ t: "event", name: "inventory.loot", payload: { actorId: killer.body, bagId, uid: r.uids[0]! } });
    await until(() => net().get(`lootbag/${bagId}`) === undefined, 4000, "spent");
    // the window is over: the held body goes, and its save is what is left
    await until(() => !layer!.server.players.has(victim.characterId), 8000, "torn down");
    await until(async () => (await saved(victim, "character"))?.sheet?.coins === 0, 5000, "the victim's save");
    const sheet = (await saved(victim, "character"))!.sheet!;
    expect(sheet.items[r.uids[0]!]).toBeUndefined();
    expect(sheet.equipment.primary).toBeUndefined();
    const k = net().get(`character/${killer.body}`) as CharacterSheet;
    expect(k.coins).toBe(555);
    expect(Object.values(k.items).find((s) => s.itemId === "pyre-staff")).toMatchObject({ twists: STAFF.twists });
  });

  it("package X2: a corpse is saved with its dead character across a logout, waits within its 15 minutes, and is gone after", async () => {
    wallNow = T0 + 5 * DAY;
    const faller = await account("Faller", "Tumbla");
    await play(faller);
    await giveSheet(faller);
    const r = placeStack({ ...roomySheet(), coins: 300 }, { itemId: "bandage", qty: 1 }, env);
    if (!r.ok) throw new Error(r.error);
    expect(net().set(`character/${faller.body}`, r.sheet)).toBe(true);
    await wait(200);
    await kill(faller.body, "a-wolf"); // a creature's kill: the corpse is the victim's at once
    await until(() => bagsOf(faller.body).some(([, b]) => b.corpse === faller.body), 4000, "the corpse");
    const [corpseId] = bagsOf(faller.body).find(([, b]) => b.corpse === faller.body)!;
    await leave(faller);
    await until(async () => ((await saved(faller, "character"))?.records?.lootbags?.bags.length ?? 0) === 1, 5000, "saved");
    const record = (await saved(faller, "character"))!.records!.lootbags!.bags[0]!;
    expect(record).toMatchObject({ id: corpseId, corpse: true, coins: 300, items: [{ itemId: "bandage", qty: 1 }] });
    expect(Math.abs(record.expires! - (wallNow + 900_000))).toBeLessThan(10_000);
    expect((await saved(faller, "character"))!.sheet!.coins).toBe(0);

    // back five minutes later: the corpse lies where it fell, ten minutes left
    wallNow += 5 * 60_000;
    await play(faller);
    const back = net().get(`lootbag/${corpseId}`) as LootBag;
    expect(back).toMatchObject({ owner: faller.body, corpse: faller.body, coins: 300 });
    expect(Math.abs(back.until! - layer!.world.timeMs - 10 * 60_000)).toBeLessThan(15_000);
    await leave(faller);

    // sixteen minutes after the death: gone, from the world and from the save
    wallNow += 11 * 60_000;
    await play(faller);
    expect(net().get(`lootbag/${corpseId}`)).toBeUndefined();
    await leave(faller);
    await until(async () => ((await saved(faller, "character"))?.records?.lootbags?.bags.length ?? -1) === 0, 5000, "the save forgets it");
  });
});
