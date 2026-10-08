import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { createSheet, equip, itemSchema, placeStack, type CharacterSheet, type EntityDoc, type Item, type LootBag, type LootRoll } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";

/**
 * Package L2 (voxel-demo docs/combat-build/L-loot.md, "second pass"), over real
 * sockets on the `field` scene with voxel-demo's combat scripts and the
 * engine's character-sheet: a three-player PARTY kill (need beats greed, the
 * winner's bag sent to the winner alone; all pass = the killer's; round-robin
 * below the rarity threshold; the copper split; a member out of range left
 * out), and a PLAYER kill under the new rule (all the copper, any bag
 * contents, ONE worn item, never one a soulbound slot protects (package X2: through the CORPSE); the victim's belongings
 * locked for the window; logging out mid-window saves nothing).
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

const items: Record<string, Item> = {};
const catalog = (id: string): Item | undefined => (items[id] ??= itemSchema.parse(JSON.parse(readFileSync(path.join(ITEMS, `${id}.json`), "utf8"))));
const env = { catalog };

function roomySheet(coins = 0): CharacterSheet {
  const sheet: CharacterSheet = { ...createSheet(), coins };
  for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
  return sheet;
}
/** Put stacks in a sheet; `wear` ones are equipped. Returns the sheet and each stack's uid in order. */
function dressed(sheet: CharacterSheet, stacks: Array<{ stack: { itemId: string; qty: number; [k: string]: unknown }; wear?: boolean }>): { sheet: CharacterSheet; uids: string[] } {
  let s = sheet;
  const uids: string[] = [];
  for (const { stack, wear } of stacks) {
    const r = placeStack(s, stack as never, env);
    if (!r.ok) throw new Error(r.error);
    s = r.sheet;
    const uid = r.uids[0]!;
    uids.push(uid);
    if (wear) {
      const e = equip(s, uid, undefined, env);
      if (!e.ok) throw new Error(e.error);
      s = e.sheet;
    }
  }
  return { sheet: s, uids };
}
const stacksOf = (sheet: CharacterSheet | undefined, itemId: string) => Object.entries(sheet?.items ?? {}).filter(([, s]) => s.itemId === itemId);

let layer: ServeHandle | null = null;
try {
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", respawnSeconds: 0, reconnectGraceSeconds: 1, log: () => undefined });
} catch (error) {
  console.warn("L2 loot test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;
const sheetScript = layer ? (layer.world.scriptRegistry.get("character-sheet") as unknown as { rollD100: () => number }) : null;

describe.skipIf(!layer)("L2: party loot rolls and looting a killed player, over real sockets", { timeout: 120_000 }, () => {
  const transports = new Map<string, WebSocketClientTransport>();
  const clients = new Map<string, RoomClient>();
  const views = new Map<string, Map<string, unknown>>();
  afterAll(async () => {
    for (const c of clients.values()) c.leave();
    for (const t of transports.values()) t.close();
    await layer?.close();
  });

  const world = () => layer!.world;
  const net = () => world().netState;
  const bus = () => world().eventBus;
  const log = eventLog(() => bus());
  const events = (name: string) => log.payloads(name);
  const sheet = (id: string) => net().get(`character/${id}`) as CharacterSheet | undefined;
  const refusals = (id: string, request = "loot") => events("character.refused").filter((e) => e.actorId === id && e.request === request).map((e) => e.error as string);
  const bagsOf = (owner: string): Array<[string, LootBag]> =>
    net()
      .keys("lootbag/")
      .map((k) => [k.slice("lootbag/".length), net().get(k) as LootBag] as [string, LootBag])
      .filter(([, b]) => b.owner === owner);
  const rolls = (): Array<[string, LootRoll]> => net().keys("lootroll/").map((k) => [k.slice("lootroll/".length), net().get(k) as LootRoll]);
  const seen = (body: string, key: string) => views.get(body)!.has(key);

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
    transports.set(peerId, transport);
    return until(() => spawned.length === 1, 10_000, `${peerId} spawn`).then(() => {
      clients.set(spawned[0]!, client);
      views.set(spawned[0]!, view);
      return spawned[0]!;
    });
  }
  const ask = (bodyId: string, name: string, payload: Record<string, unknown>): void =>
    clients.get(bodyId)!.sendCommand({ t: "event", name, payload: { actorId: bodyId, ...payload } });
  const hit = (targetId: string, sourceId: string, amount: number): void => {
    bus().emit("combat.damage", { targetId, sourceId, amount, control: 0, point: [0, 1, 0] });
  };
  const ent = (components: Record<string, unknown>): EntityDoc => ({ name: "l2", parent: null, tags: [], components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...components } });
  const posOf = (id: string): [number, number, number] => {
    const e = world().objects.get(id)!.matrixWorld.elements;
    return [e[12]!, e[13]!, e[14]!];
  };
  const standAt = (id: string, at: readonly number[], dx: number, dz = 0): void => world().sim.setPosition(id, [at[0]! + dx, at[1]! + 1, at[2]! + dz]);

  let ana = "";
  let bo = "";
  let cy = "";
  let spawnAt: [number, number, number] = [0, 0, 0];
  let foes = 0;

  /** Spawn a creature 5 m east of Ana that drops `loot` and `coins`, and return its id. */
  async function creature(loot: string, coins: string): Promise<string> {
    const subtree: Record<string, EntityDoc> = {};
    for (const id of ["hero0", "hero0-visual", "hero0-combat"]) subtree[id] = structuredClone(world().expanded.entities[id]!) // the authored doc: the server builds no drawing-only children;
    const combat = subtree["hero0-combat"]!.components["script"] as { params: Record<string, unknown> };
    combat.params["loot"] = loot;
    combat.params["lootCoins"] = coins;
    const name = `l2-foe-${++foes}`;
    layer!.npcs.register(name, subtree);
    const id = `l2-wolf-${foes}`;
    expect(layer!.npcs.spawn(name, [spawnAt[0] + 5, spawnAt[1] + 0.3, spawnAt[2]], { id })).not.toBeNull();
    await until(() => ((net().get(`combat/${id}.hp`) as number) ?? 0) > 0, 10_000, "the creature's bars");
    await wait(300);
    return id;
  }

  it("sets up: three players in one party, each with the engine's character sheet", async () => {
    ana = await join("ana");
    bo = await join("bram");
    cy = await join("cyd");
    world().addEntities({
      ...world().base,
      entities: Object.fromEntries([ana, bo, cy].map((id, i) => [`l2-sheet-${i}`, ent({ script: { name: "character-sheet", params: { actor: id, persist: false } } })])),
    });
    await until(() => [ana, bo, cy].every((id) => sheet(id) !== undefined), 5000, "sheets");
    for (const id of [ana, bo, cy]) expect(net().set(`character/${id}`, roomySheet())).toBe(true);
    for (const h of ["hero0", "hero1", "hero2"]) net().set(`combat/${h}.dead`, true);
    for (const peer of ["ana", "bram", "cyd"]) net().set(`comms.party/${peer}`, "l2-party");
    spawnAt = posOf(ana);
    standAt(bo, spawnAt, 0, 3);
    standAt(cy, spawnAt, 0, -3);
    await wait(300);
  });

  it("a party kill: need beats greed (the winner's bag goes to the winner alone), all pass = the killer's, round-robin below uncommon, the copper split", async () => {
    const wolf = await creature("pyre-staff:1:1,gravecall-staff:1:1,health-potion:3:1,bandage:1:1,iron-helm:1:1", "301");
    const before = rolls().length;
    hit(wolf, ana, 10_000);
    await until(() => rolls().length === before + 2, 4000, "two rolls (the uncommon staffs)");
    const [pyreId, pyre] = rolls().find(([, r]) => r.item.itemId === "pyre-staff")!;
    const [graveId, grave] = rolls().find(([, r]) => r.item.itemId === "gravecall-staff")!;
    expect([...pyre.eligible].sort()).toEqual([ana, bo, cy].sort());
    expect(pyre.killer).toBe(ana);
    expect(pyre.until - world().timeMs).toBeGreaterThan(40_000); // rollSeconds: 45
    // every member's client is asked
    for (const id of [ana, bo, cy]) await until(() => seen(id, `lootroll/${pyreId}`), 3000, `${id} sees the roll`);

    // below the threshold: round-robin in body-id order from the party's first turn; the copper split 101/100/100
    const order = [ana, bo, cy].sort();
    await until(() => order.every((id) => bagsOf(id).length === 1), 3000, "a share bag each");
    const share = (id: string) => bagsOf(id)[0]![1];
    expect(order.map((id) => share(id).items.map((s) => s.itemId))).toEqual([["health-potion"], ["bandage"], ["iron-helm"]]);
    expect(share(ana).coins).toBe(101); // the odd copper from the killer on
    expect(share(bo).coins).toBe(100);
    expect(share(cy).coins).toBe(100);
    // each share bag reaches its owner's client alone
    const boBag = bagsOf(bo)[0]![0];
    await until(() => seen(bo, `lootbag/${boBag}`), 3000, "bo's share sent to bo");
    expect(seen(ana, `lootbag/${boBag}`) || seen(cy, `lootbag/${boBag}`)).toBe(false);

    // the pyre staff: Ana greed, Bo NEED, Cy greed — the dice favour the greeds, need still wins
    sheetScript!.rollD100 = () => 100;
    ask(ana, "loot.roll", { rollId: pyreId, choice: "greed" });
    ask(cy, "loot.roll", { rollId: pyreId, choice: "greed" });
    await until(() => Object.keys((net().get(`lootroll/${pyreId}`) as LootRoll).choices).length === 2, 3000, "two answers");
    ask(cy, "loot.roll", { rollId: pyreId, choice: "need" }); // once only
    await until(() => refusals(cy, "roll").includes("you have already chosen"), 3000, "a second answer refused");
    sheetScript!.rollD100 = () => 7;
    ask(bo, "loot.roll", { rollId: pyreId, choice: "need" });
    await until(() => net().get(`lootroll/${pyreId}`) === undefined, 3000, "settled on the last answer");
    const won = events("loot.rolled").find((e) => e.rollId === pyreId)!;
    expect(won).toMatchObject({ itemId: "pyre-staff", winner: bo, choice: "need", roll: 7 });
    expect((won.rolls as Array<{ actorId: string; choice: string }>).map((r) => [r.actorId, r.choice]).sort()).toEqual([[ana, "greed"], [bo, "need"], [cy, "greed"]].sort());
    // the winner's item lies in a NEW bag of their own at the corpse (bags are take-only), rolled data and all;
    // nobody else is sent it
    await until(() => bagsOf(bo).length === 2, 3000, "a bag for bo's win");
    const [wonBag, wonIn] = bagsOf(bo).find(([, b]) => b.items.some((s) => s.itemId === "pyre-staff"))!;
    expect(wonIn.items).toEqual([pyre.item]);
    expect(Math.hypot(wonIn.at[0] - pyre.at[0], wonIn.at[2] - pyre.at[2])).toBeLessThan(0.01);
    expect(bagsOf(ana).some(([, b]) => b.items.some((s) => s.itemId === "pyre-staff"))).toBe(false);
    expect(bagsOf(bo).find(([id]) => id === boBag)![1].items.map((s) => s.itemId)).toEqual(["bandage"]); // the share bag untouched
    await until(() => seen(bo, `lootbag/${wonBag}`), 3000, "bo's replica has it");
    expect(seen(ana, `lootbag/${wonBag}`) || seen(cy, `lootbag/${wonBag}`)).toBe(false);
    // nobody's bags were filled directly
    for (const id of [ana, bo, cy]) expect(Object.keys(sheet(id)!.items)).toHaveLength(0);

    // the gravecall staff: everyone passes — the killer's
    for (const id of [ana, bo, cy]) ask(id, "loot.roll", { rollId: graveId, choice: "pass" });
    await until(() => net().get(`lootroll/${graveId}`) === undefined, 3000, "all passed");
    expect(events("loot.rolled").find((e) => e.rollId === graveId)).toMatchObject({ winner: ana, choice: "pass", roll: null });
    await until(() => bagsOf(ana).some(([, b]) => b.items.some((s) => s.itemId === "gravecall-staff")), 3000, "in the killer's bag");
    expect(grave.item.itemId).toBe("gravecall-staff");
  });

  it("a member out of range shares nothing; no answer by the time limit counts as pass", async () => {
    for (const id of [ana, bo, cy]) for (const [bagId] of bagsOf(id)) net().delete(`lootbag/${bagId}`);
    standAt(cy, spawnAt, -100, 0); // 100 m off: outside partyRange (60)
    await wait(300);
    const wolf = await creature("bandage:1:1,iron-helm:1:1,pyre-staff:1:1", "50");
    hit(wolf, bo, 10_000);
    await until(() => bagsOf(ana).length === 1 && bagsOf(bo).length === 1, 4000, "two shares");
    expect(bagsOf(cy)).toEqual([]);
    expect(bagsOf(bo)[0]![1].coins).toBe(25);
    expect(bagsOf(ana)[0]![1].coins).toBe(25);
    const [rollId, roll] = rolls().find(([, r]) => r.killer === bo)!;
    expect([...roll.eligible].sort()).toEqual([ana, bo].sort());
    // the authority's sheet settles it once its time is up, answered or not
    ask(ana, "loot.roll", { rollId, choice: "greed" });
    await until(() => (net().get(`lootroll/${rollId}`) as LootRoll).choices[ana] === "greed", 3000, "ana answered");
    net().set(`lootroll/${rollId}`, { ...(net().get(`lootroll/${rollId}`) as LootRoll), until: world().timeMs + 200 });
    await until(() => net().get(`lootroll/${rollId}`) === undefined, 4000, "settled by time");
    expect(events("loot.rolled").find((e) => e.rollId === rollId)).toMatchObject({ winner: ana, choice: "greed" });
    standAt(cy, spawnAt, 0, -3);
    for (const id of [ana, bo, cy]) for (const [bagId] of bagsOf(id)) net().delete(`lootbag/${bagId}`);
    await wait(200);
  });

  /** A killing blow; a downed player (package X1) releases at once, so the death lands with the blow's credit. */
  async function kill(victim: string, killer: string): Promise<void> {
    hit(victim, killer, 100_000);
    await until(() => net().get(`combat/${victim}.dead`) === true || ((net().get(`combat/${victim}.downed`) as number | undefined) ?? 0) > 0, 4000, `${victim} falls`);
    if (net().get(`combat/${victim}.dead`) !== true) bus().emit("combat.release.request", { casterId: victim });
    await until(() => net().get(`combat/${victim}.dead`) === true, 4000, `${victim} dies`);
  }

  it("a player kill (package X2): the corpse holds ALL the copper and the bags' contents for the killer; ONE worn item, never one a soulbound slot protects; a second refused", async () => {
    const s = dressed(roomySheet(4321), [
      { stack: { itemId: "pyre-staff", qty: 1, durability: 40, twists: ["emberBolt+leech"] }, wear: true },
      { stack: { itemId: "iron-helm", qty: 1 }, wear: true },
      { stack: { itemId: "leather-gloves", qty: 1 }, wear: true },
      { stack: { itemId: "health-potion", qty: 2 } },
      { stack: { itemId: "bandage", qty: 1 } },
      { stack: { itemId: "gravecall-staff", qty: 1 } },
    ]);
    const [staffUid, helmUid, glovesUid] = s.uids as [string, string, string];
    // the helm is worn in its soulbound slot: protected
    expect(net().set(`character/${cy}`, { ...s.sheet, soulslots: { helm: helmUid } })).toBe(true);
    standAt(cy, spawnAt, 2, 0);
    standAt(ana, spawnAt, 3, 0);
    await wait(300);

    await kill(cy, ana);
    await until(() => bagsOf(ana).some(([, b]) => b.corpse === cy), 4000, "the corpse");
    const [id, bag] = bagsOf(ana).find(([, b]) => b.corpse === cy)!;
    expect(bag).toMatchObject({ owner: ana, corpse: cy, takes: 1, coins: 4321 });
    expect([...bag.offer!].sort()).toEqual([staffUid, glovesUid].sort()); // never the protected helm
    // the bags' contents left the victim into the corpse; carried items are never protected
    expect(bag.items.map((st) => st.itemId).sort()).toEqual(["bandage", "gravecall-staff", "health-potion"]);
    expect(sheet(cy)!.coins).toBe(0);
    expect(stacksOf(sheet(cy), "bandage")).toEqual([]);
    expect(net().get(`lootlock/${cy}`)).toMatchObject({ by: ana, bag: id });
    await until(() => seen(ana, `lootbag/${id}`), 3000, "sent to the killer");
    expect(seen(cy, `lootbag/${id}`)).toBe(false);

    // the victim's worn gear cannot move during the window
    ask(cy, "inventory.unequip", { slot: "helm" });
    await until(() => refusals(cy, "unequip").length > 0, 3000, "the victim refused");
    expect(refusals(cy, "unequip").at(-1)).toMatch(/being looted/);
    expect(sheet(cy)!.equipment.helm).toBe(helmUid);
    expect(bagsOf(cy)).toEqual([]);

    // the money
    standAt(ana, bag.at, 1, 0);
    await wait(250);
    ask(ana, "inventory.loot", { bagId: id, coins: true });
    await until(() => sheet(ana)!.coins === 4321, 3000, "the copper");
    // the protected helm, named anyway: not offered
    ask(ana, "inventory.loot", { bagId: id, uid: helmUid });
    await until(() => refusals(ana).includes("you may not take that"), 3000, "protected refused");
    expect(sheet(cy)!.equipment.helm).toBe(helmUid);
    // ONE worn item: the twisted staff, intact
    ask(ana, "inventory.loot", { bagId: id, uid: staffUid });
    await until(() => stacksOf(sheet(ana), "pyre-staff").length === 1, 3000, "the worn staff");
    expect(stacksOf(sheet(ana), "pyre-staff")[0]![1]).toMatchObject({ twists: ["emberBolt+leech"] });
    expect(sheet(cy)!.equipment.primary).toBeUndefined();
    // a second worn one is refused (the corpse is still open for the rest)
    ask(ana, "inventory.loot", { bagId: id, uid: glovesUid });
    await until(() => refusals(ana).includes("you have already taken your one piece of their gear"), 3000, "second worn refused");
    expect(sheet(cy)!.equipment.gloves).toBe(glovesUid);
    expect(net().get(`lootbag/${id}`)).toBeDefined();
    // everything in it
    ask(ana, "inventory.loot", { bagId: id, all: true });
    await until(() => stacksOf(sheet(ana), "health-potion").length === 1 && stacksOf(sheet(ana), "bandage").length === 1 && stacksOf(sheet(ana), "gravecall-staff").length === 1, 3000, "the bags' contents");
    expect(stacksOf(sheet(ana), "health-potion")[0]![1].qty).toBe(2);
    // nothing left for anyone: the corpse goes and the lock lifts
    await until(() => net().get(`lootbag/${id}`) === undefined, 3000, "spent and gone");
    await until(() => net().get(`lootlock/${cy}`) === undefined, 3000, "the lock lifted");
    expect(sheet(cy)!.equipment.helm).toBe(helmUid);
    // free again: the victim may move their own things
    ask(cy, "inventory.unequip", { slot: "helm" });
    await until(() => sheet(cy)!.equipment.helm === undefined || sheet(cy)!.inventoryAction !== undefined, 3000, "unequip accepted");
  });

  it("the victim logs out inside the killer's minute: the body (and sheet) stays, the killer still takes, the victim comes back locked; Leave the rest gives them their corpse", async () => {
    const s = dressed(roomySheet(900), [
      { stack: { itemId: "pyre-staff", qty: 1, durability: 33 }, wear: true },
      { stack: { itemId: "iron-helm", qty: 1 }, wear: true },
      { stack: { itemId: "bandage", qty: 1 } },
    ]);
    expect(net().set(`character/${bo}`, s.sheet)).toBe(true);
    standAt(bo, spawnAt, 2, 2);
    standAt(ana, spawnAt, 3, 2);
    await wait(300);
    await kill(bo, ana);
    await until(() => bagsOf(ana).some(([, b]) => b.corpse === bo), 4000, "the corpse");
    const [id, bag] = bagsOf(ana).find(([, b]) => b.corpse === bo)!;

    // Bo's tab closes
    clients.get(bo)!.leave();
    transports.get("bram")!.close();
    clients.delete(bo);
    await wait(2500); // past the 1 s reconnect grace
    expect(layer!.server.players.has("bram")).toBe(true); // held: being looted
    expect(sheet(bo)).toBeDefined();

    standAt(ana, bag.at, 1, 0);
    await wait(250);
    ask(ana, "inventory.loot", { bagId: id, uid: s.uids[0]! });
    await until(() => stacksOf(sheet(ana), "pyre-staff").length === 2, 3000, "the staff taken from the logged-out victim");
    expect(sheet(bo)!.items[s.uids[0]!]).toBeUndefined();
    expect(net().get(`lootbag/${id}`)).toBeDefined(); // the copper and the bandage still in it

    // Bo comes back inside the window: the same body, without what was taken, still locked
    const back = await join("bram");
    expect(back).toBe(bo);
    expect(stacksOf(sheet(bo), "pyre-staff")).toEqual([]);
    expect(sheet(bo)!.coins).toBe(0); // the copper is in the corpse
    ask(bo, "inventory.unequip", { slot: "helm" });
    await until(() => refusals(bo, "unequip").some((e) => /being looted/.test(e)), 3000, "still locked after coming back");
    // the killer leaves the rest: the corpse is Bo's now, the lock lifts
    ask(ana, "inventory.loot", { bagId: id, done: true });
    await until(() => (net().get(`lootbag/${id}`) as LootBag | undefined)?.owner === bo, 3000, "Bo's corpse");
    await until(() => net().get(`lootlock/${bo}`) === undefined, 3000, "unlocked");
    await until(() => seen(bo, `lootbag/${id}`), 3000, "sent to Bo");
    standAt(bo, bag.at, 0.5, 0);
    await wait(250);
    ask(bo, "inventory.loot", { bagId: id });
    await until(() => net().get(`lootbag/${id}`) === undefined, 3000, "taken back");
    expect(sheet(bo)!.coins).toBe(900);
    expect(stacksOf(sheet(bo), "bandage")).toHaveLength(1);
    // once it is over, a logout is an ordinary one again
    clients.get(bo)!.leave();
    transports.get("bram")!.close();
    await until(() => !layer!.server.players.has("bram"), 6000, "torn down after the window");
  });


  it("dropping is not storage: each drop is its own short-lived bag, and a sixth live one is refused, nothing destroyed", async () => {
    for (const [bagId] of bagsOf(ana)) net().delete(`lootbag/${bagId}`);
    const s = dressed(roomySheet(), Array.from({ length: 6 }, () => ({ stack: { itemId: "pyre-staff", qty: 1 } })));
    expect(net().set(`character/${ana}`, s.sheet)).toBe(true);
    for (const uid of s.uids.slice(0, 5)) {
      const n = bagsOf(ana).length;
      ask(ana, "inventory.drop", { uid });
      await until(() => bagsOf(ana).length === n + 1, 3000, "a new drop bag");
    }
    for (const [, b] of bagsOf(ana)) {
      expect(b.dropped).toBe(true);
      expect(b.items).toHaveLength(1); // never added to
      expect(b.until! - world().timeMs).toBeLessThanOrEqual(600_000); // dropSeconds: 600, not the earned 3 days
    }
    ask(ana, "inventory.drop", { uid: s.uids[5]! });
    await until(() => refusals(ana, "drop").some((e) => /already have 5 bags of dropped items/.test(e)), 3000, "the sixth refused");
    expect(sheet(ana)!.items[s.uids[5]!]).toBeDefined();
    expect(bagsOf(ana)).toHaveLength(5);
  });
});
