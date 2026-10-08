import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { createSheet, equip, itemSchema, placeStack, type CharacterSheet, type EntityDoc, type Item, type LootBag } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";

/**
 * Package L (voxel-demo docs/combat-build/L-loot.md): loot bags, over real
 * sockets on the `field` scene with voxel-demo's combat scripts and the
 * engine's character-sheet on the authority. A creature's drops lie in a bag
 * at the corpse that only the killer is SENT (the other client's replica never
 * holds the key) and only the killer may take from; an item that does not fit
 * stays in the bag until room is made (a part of a stack takes what fits); a
 * bag expires; a dropped item becomes the dropper's own bag; a player killed
 * by a player leaves the killer the choice of ONE worn item, intact, which
 * nobody else can take, and the chance ends with the time limit.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
const ITEMS = path.join(playground, "projects/voxel-demo/assets/items");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 10_000, what = ""): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting ${what}`);
    await wait(15);
  }
}

const TWISTS = ["emberBolt+leech", "chainLightning+executioner"];
const STAFF = { itemId: "pyre-staff", durability: 31, twists: TWISTS };
const items: Record<string, Item> = {};
const catalog = (id: string): Item | undefined => (items[id] ??= itemSchema.parse(JSON.parse(readFileSync(path.join(ITEMS, `${id}.json`), "utf8"))));
const env = { catalog };

/** A sheet strong enough to wear anything, with a satchel's worth of room. */
function roomySheet(): CharacterSheet {
  const sheet: CharacterSheet = { ...createSheet(), coins: 0 };
  for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
  return sheet;
}
/** `sheet` with every free cell filled by plain staffs (nothing more fits), optionally leaving a potion stack one short. */
function crammed(sheet: CharacterSheet, potionsShortByOne = false): CharacterSheet {
  let s = sheet;
  if (potionsShortByOne) {
    const r = placeStack(s, { itemId: "health-potion", qty: 4 }, env);
    if (!r.ok) throw new Error(r.error);
    s = r.sheet;
  }
  for (;;) {
    const r = placeStack(s, { itemId: "pyre-staff", qty: 1 }, env);
    if (!r.ok) return s;
    s = r.sheet;
  }
}
const stacksOf = (sheet: CharacterSheet | undefined, itemId: string) => Object.entries(sheet?.items ?? {}).filter(([, s]) => s.itemId === itemId);

let layer: ServeHandle | null = null;
try {
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", respawnSeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("L loot test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

describe.skipIf(!layer)("L: loot bags only their owner sees and takes, over real sockets", { timeout: 120_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients = new Map<string, RoomClient>();
  /** What each client's replica holds (body id → netState as received over its socket). */
  const views = new Map<string, Map<string, unknown>>();
  afterAll(async () => {
    for (const c of clients.values()) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
  });

  const world = () => layer!.world;
  const net = () => world().netState;
  const bus = () => world().eventBus;
  const log = eventLog(() => bus());
  const events = (name: string) => log.payloads(name);
  const sheet = (id: string) => net().get(`character/${id}`) as CharacterSheet | undefined;
  const refusals = (id: string) => events("character.refused").filter((e) => e.actorId === id && e.request === "loot").map((e) => e.error);
  const bagsOf = (owner: string): Array<[string, LootBag]> =>
    net()
      .keys("lootbag/")
      .map((k) => [k.slice("lootbag/".length), net().get(k) as LootBag] as [string, LootBag])
      .filter(([, b]) => b.owner === owner);
  const seen = (body: string, bagId: string) => views.get(body)!.has(`lootbag/${bagId}`);
  const seenAny = (body: string) => [...views.get(body)!.keys()].some((k) => k.startsWith("lootbag/"));

  function join(peerId: string): Promise<string> {
    const transport = new WebSocketClientTransport(layer!.url, { peerId });
    const client = new RoomClient(transport, WS_HOST_ID);
    const spawned: string[] = [];
    const view = new Map<string, unknown>();
    client.onState((s) => {
      if (s.full) {
        view.clear();
        for (const [k, v] of Object.entries(s.full)) view.set(k, v);
      }
      if (s.delta) {
        for (const [k, v] of Object.entries(s.delta.set)) view.set(k, v);
        for (const k of s.delta.removed) view.delete(k);
      }
    });
    client.onModule(WORLD_MODULE, (m) => {
      const msg = m as WorldModuleMessage;
      if (msg.t === "spawn" && msg.self) spawned.push(msg.self);
    });
    transport.onPeer((peer, s) => {
      if (peer === WS_HOST_ID && s === "connected") client.join(peerId);
    });
    transports.push(transport);
    return until(() => spawned.length === 1, 10_000, `${peerId} spawn`).then(() => {
      clients.set(spawned[0]!, client);
      views.set(spawned[0]!, view);
      return spawned[0]!;
    });
  }
  /** A request from the body's own client, over its socket. */
  const ask = (bodyId: string, name: string, payload: Record<string, unknown>): void =>
    clients.get(bodyId)!.sendCommand({ t: "event", name, payload: { actorId: bodyId, ...payload } });
  const hit = (targetId: string, sourceId: string, amount: number): void => {
    bus().emit("combat.damage", { targetId, sourceId, amount, control: 0, point: [0, 1, 0] });
  };
  const ent = (components: Record<string, unknown>): EntityDoc => ({ name: "l", parent: null, tags: [], components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...components } });
  const posOf = (id: string): [number, number, number] => {
    const e = world().objects.get(id)!.matrixWorld.elements;
    return [e[12]!, e[13]!, e[14]!];
  };
  /** Stand `id` this far (m) east of a point, at body height. */
  const standBy = (id: string, at: readonly number[], dx: number): void => world().sim.setPosition(id, [at[0]! + dx, at[1]! + 1, at[2]!]);

  let ana = "";
  let bo = "";

  it("sets up: two players with the engine's character sheet, nobody else fighting", async () => {
    ana = await join("ana");
    bo = await join("bram");
    world().addEntities({
      ...world().base,
      entities: {
        "l-sheet-ana": ent({ script: { name: "character-sheet", params: { actor: ana, persist: false } } }),
        "l-sheet-bo": ent({ script: { name: "character-sheet", params: { actor: bo, persist: false } } }),
      },
    });
    await until(() => sheet(ana) !== undefined && sheet(bo) !== undefined, 5000, "sheets");
    expect(net().set(`character/${ana}`, roomySheet())).toBe(true);
    expect(net().set(`character/${bo}`, roomySheet())).toBe(true);
    for (const h of ["hero0", "hero1", "hero2"]) net().set(`combat/${h}.dead`, true);
    await wait(300);
  });

  let bagId = "";
  let foeAt: [number, number, number] = [0, 0, 0];

  it("a creature's drops go into a bag at the corpse that only the killer is sent and only the killer can loot", async () => {
    const subtree: Record<string, EntityDoc> = {};
    for (const id of ["hero0", "hero0-visual", "hero0-combat"]) subtree[id] = structuredClone(world().expanded.entities[id]!) // the authored doc: the server builds no drawing-only children;
    const combat = subtree["hero0-combat"]!.components["script"] as { params: Record<string, unknown> };
    combat.params["loot"] = "pyre-staff:1:1,health-potion:3:1";
    layer!.npcs.register("l-foe", subtree);
    const [ax, ay, az] = posOf(ana);
    expect(layer!.npcs.spawn("l-foe", [ax + 6, ay + 0.3, az], { id: "l-wolf" })).not.toBeNull();
    await until(() => ((net().get("combat/l-wolf.hp") as number) ?? 0) > 0, 10_000, "the creature's bars");
    await wait(500);
    foeAt = posOf("l-wolf");
    const before = sheet(ana)!;

    hit("l-wolf", ana, 10_000);
    await until(() => bagsOf(ana).length === 1, 4000, "the bag");
    let bag: LootBag;
    [bagId, bag] = bagsOf(ana)[0]!;
    expect(bag.items.map((s) => [s.itemId, s.qty])).toEqual([["pyre-staff", 1], ["health-potion", 3]]);
    expect(Math.hypot(bag.at[0] - foeAt[0], bag.at[2] - foeAt[2])).toBeLessThan(1); // beside the corpse, a step toward the killer
    expect(bag.until! - world().timeMs).toBeGreaterThan(590_000); // the sheet's bagSeconds: 600
    // nothing went straight into the killer's bags
    expect(sheet(ana)!.items).toEqual(before.items);

    // only the killer's client is sent it; the other client's replica never holds it
    await until(() => seen(ana, bagId), 3000, "ana's client receives it");
    await wait(300);
    expect(seenAny(bo)).toBe(false);

    // the other player cannot take from it, even standing on it
    standBy(bo, bag.at, 0.5);
    await wait(250);
    ask(bo, "inventory.loot", { bagId });
    await until(() => refusals(bo).includes("it is gone"), 3000, "refused to bo");
    expect(net().get(`lootbag/${bagId}`)).toEqual(bag);
    // nor can a client make itself a bag (authority-internal)
    ask(bo, "inventory.bag", { at: bag.at, items: [{ itemId: "pyre-staff", qty: 1 }] });
    await wait(300);
    expect(bagsOf(bo)).toEqual([]);

    // the killer out of reach: refused
    standBy(ana, bag.at, 12);
    await wait(250);
    ask(ana, "inventory.loot", { bagId, index: 0 });
    await until(() => refusals(ana).includes("too far away"), 3000, "refused at 12 m");
  });

  it("an item that does not fit stays in the bag; part of a stack takes what fits; after making room it all comes in, intact", async () => {
    const bag0 = net().get(`lootbag/${bagId}`) as LootBag;
    standBy(ana, bag0.at, 1);
    await wait(250);
    // full bags: the staff is refused and stays; take-all is refused and everything stays
    const roomy = sheet(ana)!;
    expect(net().set(`character/${ana}`, crammed(roomy, true))).toBe(true);
    const full = sheet(ana)!;
    ask(ana, "inventory.loot", { bagId, index: 0 });
    await until(() => refusals(ana).some((e) => /^no room for /.test(e as string)), 3000, "no room for the staff");
    expect(net().get(`lootbag/${bagId}`)).toEqual(bag0);
    expect(sheet(ana)).toEqual(full);

    // three potions, room for one (a stack of 4 of 5): one comes in, two stay
    ask(ana, "inventory.loot", { bagId, index: 1 });
    await until(() => (net().get(`lootbag/${bagId}`) as LootBag).items[1]?.qty === 2, 3000, "part of the stack");
    expect(stacksOf(sheet(ana), "health-potion").map(([, s]) => s.qty)).toEqual([5]);
    await until(() => refusals(ana).includes("no room for the rest"), 3000, "told the rest stayed");

    // room made: take all — the staff with its rolled data, the two potions; the bag is gone
    expect(net().set(`character/${ana}`, roomy)).toBe(true);
    const staffInBag = (net().get(`lootbag/${bagId}`) as LootBag).items[0]!;
    ask(ana, "inventory.loot", { bagId });
    await until(() => net().get(`lootbag/${bagId}`) === undefined, 3000, "emptied");
    const staffs = stacksOf(sheet(ana), "pyre-staff");
    expect(staffs).toHaveLength(1);
    expect(staffs[0]![1]).toMatchObject(staffInBag);
    expect(stacksOf(sheet(ana), "health-potion").map(([, s]) => s.qty)).toEqual([2]);
    await until(() => !seen(ana, bagId), 3000, "removed from ana's replica");
    // a second take finds nothing
    ask(ana, "inventory.loot", { bagId });
    await until(() => refusals(ana).filter((e) => e === "it is gone").length >= 1, 3000, "gone");
  });

  it("a bag expires with what is left in it", async () => {
    const at = posOf(ana);
    bus().emit("inventory.bag", { actorId: ana, at, items: [{ itemId: "health-potion", qty: 2 }], seconds: 1 });
    await until(() => bagsOf(ana).length === 1, 3000, "a short bag");
    const [id] = bagsOf(ana)[0]!;
    await until(() => seen(ana, id), 3000, "sent");
    await until(() => net().get(`lootbag/${id}`) === undefined, 4000, "expired");
    await until(() => !seen(ana, id), 3000, "removed from ana's replica");
    expect(seenAny(bo)).toBe(false);
  });

  it("a dropped item becomes the dropper's own bag at their feet, whole; nobody else sees or takes it", async () => {
    const s0 = placeStack(sheet(ana)!, { ...STAFF, qty: 1 }, env);
    if (!s0.ok) throw new Error(s0.error);
    expect(net().set(`character/${ana}`, s0.sheet)).toBe(true);
    const uid = stacksOf(sheet(ana), "pyre-staff").find(([, s]) => s.twists?.join() === TWISTS.join())![0];
    ask(ana, "inventory.drop", { uid });
    await until(() => bagsOf(ana).length === 1, 3000, "the drop bag");
    const [id, bag] = bagsOf(ana)[0]!;
    expect(bag.items).toEqual([{ ...STAFF, qty: 1 }]);
    expect(events("inventory.dropped").at(-1)).toMatchObject({ actorId: ana, ...STAFF, bagId: id });
    await until(() => seen(ana, id), 3000, "sent to ana");
    await wait(200);
    expect(seenAny(bo)).toBe(false);
    standBy(bo, bag.at, 0.5);
    await wait(250);
    const before = refusals(bo).length;
    ask(bo, "inventory.loot", { bagId: id, index: 0 });
    await until(() => refusals(bo).length > before, 3000, "refused to bo");
    expect(refusals(bo).at(-1)).toBe("it is gone");
    // bags are take-only (L2): a second drop is a second bag, never added to the first; drops are short-lived
    expect(bag.dropped).toBe(true);
    expect(bag.until! - world().timeMs).toBeLessThan(601_000); // character-sheet dropSeconds: 600
    const other = stacksOf(sheet(ana), "health-potion")[0]![0];
    ask(ana, "inventory.drop", { uid: other });
    await until(() => bagsOf(ana).length === 2, 3000, "a second bag");
    expect((net().get(`lootbag/${id}`) as LootBag).items).toHaveLength(1);
    // the dropper takes the staff back, worn and twisted as it fell
    standBy(ana, bag.at, 0.5);
    await wait(250);
    ask(ana, "inventory.loot", { bagId: id, index: 0 });
    await until(() => stacksOf(sheet(ana), "pyre-staff").some(([, s]) => s.twists?.join() === TWISTS.join()), 3000, "taken back");
    expect(stacksOf(sheet(ana), "pyre-staff").find(([, s]) => s.twists?.join() === TWISTS.join())![1]).toMatchObject(STAFF);
    await until(() => net().get(`lootbag/${id}`) === undefined, 3000, "the emptied drop bag is gone");
  });

  it("a player killed by a player: the killer takes exactly ONE worn item of their choice, intact; nobody else can; then it is over", async () => {
    // Bo wears the twisted staff and a helm
    let s = roomySheet();
    for (const stack of [{ ...STAFF, qty: 1 }, { itemId: "iron-helm", qty: 1 }]) {
      const r = placeStack(s, stack, env);
      if (!r.ok) throw new Error(r.error);
      const e = equip(r.sheet, r.uids[0]!, undefined, env);
      if (!e.ok) throw new Error(e.error);
      s = e.sheet;
    }
    expect(net().set(`character/${bo}`, s)).toBe(true);
    const staffUid = s.equipment.primary!;
    const helmUid = s.equipment.helm!;
    standBy(bo, foeAt, -4);
    await wait(300);
    const boAt = posOf(bo);

    hit(bo, ana, 100_000);
    // 0 health is DOWN first (package X1): giving up is the death; the credit stays the downer's
    await until(() => (net().get(`combat/${bo}.downed`) as number) > 0, 3000, "bo down");
    bus().emit("combat.release.request", { casterId: bo });
    // package X2: the corpse, held by the killer for their minute (Bo carried nothing: only the worn choice)
    await until(() => bagsOf(ana).some(([, b]) => b.corpse === bo), 4000, "the corpse");
    const [id, bag] = bagsOf(ana).find(([, b]) => b.corpse === bo)!;
    expect(bag).toMatchObject({ owner: ana, corpse: bo, takes: 1, items: [] });
    expect([...bag.offer!].sort()).toEqual([staffUid, helmUid].sort());
    expect(Math.hypot(bag.at[0] - boAt[0], bag.at[2] - boAt[2])).toBeLessThan(1);
    expect(Math.abs(bag.claimUntil! - world().timeMs - 60_000)).toBeLessThan(1500); // combat-actor bodyLootSeconds: 60
    await until(() => seen(ana, id), 3000, "sent to the killer");
    await wait(200);
    expect(seen(bo, id)).toBe(false);

    // the victim cannot take from it; the killer cannot take what is not offered
    standBy(bo, bag.at, 0.5);
    standBy(ana, bag.at, 1);
    await wait(250);
    let before = refusals(bo).length;
    ask(bo, "inventory.loot", { bagId: id, uid: staffUid });
    await until(() => refusals(bo).length > before, 3000, "refused to the victim");
    expect(refusals(bo).at(-1)).toBe("it is gone");
    ask(ana, "inventory.loot", { bagId: id, uid: "nope" });
    await until(() => refusals(ana).includes("you may not take that"), 3000, "not offered");

    // the killer with full bags: refused, nothing moves, the chance stays open
    const roomy = sheet(ana)!;
    expect(net().set(`character/${ana}`, crammed(roomy))).toBe(true);
    before = refusals(ana).length;
    ask(ana, "inventory.loot", { bagId: id, uid: staffUid });
    await until(() => refusals(ana).length > before, 3000, "no room");
    expect(refusals(ana).at(-1)).toBe("no room in your bags");
    expect(sheet(bo)!.equipment.primary).toBe(staffUid);
    expect(net().get(`lootbag/${id}`)).toBeDefined();

    // room made: the staff moves, worn (the death's wear) and twisted as Bo wore it
    expect(net().set(`character/${ana}`, roomy)).toBe(true);
    const worn = { ...sheet(bo)!.items[staffUid]! };
    expect(worn.twists).toEqual(TWISTS);
    const mine = stacksOf(sheet(ana), "pyre-staff").length;
    ask(ana, "inventory.loot", { bagId: id, uid: staffUid });
    await until(() => stacksOf(sheet(ana), "pyre-staff").length === mine + 1, 3000, "taken");
    const got = stacksOf(sheet(ana), "pyre-staff").find(([, st]) => st.durability === worn.durability && st.twists?.join() === TWISTS.join());
    expect(got).toBeDefined();
    expect(sheet(bo)!.items[staffUid]).toBeUndefined();
    expect(sheet(bo)!.equipment.primary).toBeUndefined();
    expect(events("inventory.transferred").at(-1)).toMatchObject({ actorId: bo, toActorId: ana, itemId: "pyre-staff", twists: TWISTS });
    // exactly one: the corpse (nothing else in it) is gone and the helm stays on Bo
    await until(() => net().get(`lootbag/${id}`) === undefined, 3000, "closed after one");
    await until(() => !seen(ana, id), 3000, "removed from the killer's replica");
    ask(ana, "inventory.loot", { bagId: id, uid: helmUid });
    await wait(300);
    expect(sheet(bo)!.equipment.helm).toBe(helmUid);
  });

  it("(engine primitive, still supported) a body bag's chance ends with the time limit", async () => {
    const helmUid = sheet(bo)!.equipment.helm!;
    const at = posOf(ana);
    bus().emit("inventory.bag", { actorId: ana, at, body: bo, offer: [helmUid], takes: 1, seconds: 1, from: bo });
    await until(() => bagsOf(ana).some(([, b]) => b.body === bo), 3000, "a short body bag");
    const [id] = bagsOf(ana).find(([, b]) => b.body === bo)!;
    await until(() => net().get(`lootbag/${id}`) === undefined, 4000, "the window closed");
    const before = refusals(ana).length;
    ask(ana, "inventory.loot", { bagId: id, uid: helmUid });
    await until(() => refusals(ana).length > before, 3000, "refused after the limit");
    expect(refusals(ana).at(-1)).toBe("it is gone");
    expect(sheet(bo)!.equipment.helm).toBe(helmUid);
  });
});
