import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import { createSheet, equip, itemSchema, lootClock, placeStack, type CharacterSheet, type EntityDoc, type Item, type LootBag } from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { WORLD_MODULE, type WorldModuleMessage } from "../src/index.js";
import { eventLog } from "./event-log.js";
import { bodyLootOffer } from "../../../apps/playground/projects/foundation/scripts/lib/loot-rules.js";

/**
 * Package X2 (foundation docs/combat-build/X2-corpse-soulbind.md), over real
 * sockets on the `field` scene with the foundation's combat scripts, the engine's
 * character-sheet and npc builtins and the real Tidewell dialogues: every
 * player death leaves a CORPSE (the bags' contents and the money; worn gear and
 * entrusted items stay on the character); a killing player holds it alone for a
 * minute (contents, money, ONE worn item that no soulbound slot protects), then
 * it is the victim's alone; plundered; soulbound slots chosen and paid for at
 * the soul binder; the hearth bind at the innkeeper; a shop's limited stock.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const playground = path.resolve(here, "../../../apps/playground");
// items live in the foundation project, the world's dialogues and shops in the proving world (voxel-demo)
const PROJECTS = ["projects/proving/assets", "projects/foundation/assets"].map((p) => path.join(playground, p));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 10_000, what = ""): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting ${what}`);
    await wait(15);
  }
}
const json = (rel: string): unknown =>
  JSON.parse(readFileSync(PROJECTS.map((p) => path.join(p, rel)).find((f) => existsSync(f)) ?? path.join(PROJECTS[0]!, rel), "utf8"));

const PARCEL = { name: "Sealed Parcel", kind: "quest", entrusted: true, entrustedQuest: "x2-deliver", value: 50 };
const items: Record<string, Item> = { "x2-parcel": itemSchema.parse(PARCEL) };
const catalog = (id: string): Item | undefined => (items[id] ??= itemSchema.parse(json(`items/${id}.json`)));
const env = { catalog };

function roomySheet(coins = 0): CharacterSheet {
  const sheet: CharacterSheet = { ...createSheet(), coins };
  for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
  return sheet;
}
/** Put stacks in a sheet; `wear` ones are equipped. Returns the sheet and each stack's uid in order. */
function dressed(sheet: CharacterSheet, stacks: Array<{ stack: { itemId: string; qty: number }; wear?: boolean }>): { sheet: CharacterSheet; uids: string[] } {
  let s = sheet;
  const uids: string[] = [];
  for (const { stack, wear } of stacks) {
    const r = placeStack(s, stack, env);
    if (!r.ok) throw new Error(r.error);
    s = r.sheet;
    uids.push(r.uids[0]!);
    if (wear) {
      const e = equip(s, r.uids[0]!, undefined, env);
      if (!e.ok) throw new Error(e.error);
      s = e.sheet;
    }
  }
  return { sheet: s, uids };
}
const count = (sheet: CharacterSheet | undefined, itemId: string): number =>
  Object.values(sheet?.items ?? {}).filter((s) => s.itemId === itemId).reduce((n, s) => n + s.qty, 0);

let layer: ServeHandle | null = null;
try {
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", respawnSeconds: 0, reconnectGraceSeconds: 1, log: () => undefined });
} catch (error) {
  console.warn("X2 corpse test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

describe.skipIf(!layer)("X2: corpses, the killer's minute, plundered, soulbound slots, the hearth, entrusted items, limited stock", { timeout: 120_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients = new Map<string, RoomClient>();
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
  const sheet = (id: string) => net().get(`character/${id}`) as CharacterSheet | undefined;
  const refusals = (id: string, request = "loot") =>
    log.payloads("character.refused").filter((e) => e.actorId === id && e.request === request).map((e) => e.error as string);
  const corpsesOf = (victim: string): Array<[string, LootBag]> =>
    net()
      .keys("lootbag/")
      .map((k) => [k.slice("lootbag/".length), net().get(k) as LootBag] as [string, LootBag])
      .filter(([, b]) => b.corpse === victim);
  const seen = (body: string, key: string) => views.get(body)!.has(key);
  const notice = (id: string) => (net().get(`dialogue/${id}`) as { notice?: string } | undefined)?.notice ?? "";
  const panel = (id: string) => (net().get(`dialogue/${id}`) as { panel?: { kind: string } | null } | undefined)?.panel?.kind;
  const node = (id: string) => (net().get(`dialogue/${id}`) as { node?: string } | undefined)?.node;

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
  const ask = (bodyId: string, name: string, payload: Record<string, unknown>): void =>
    clients.get(bodyId)!.sendCommand({ t: "event", name, payload: { actorId: bodyId, ...payload } });
  const ent = (components: Record<string, unknown>, tags: string[] = []): EntityDoc => ({
    name: "x2",
    parent: null,
    tags,
    components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...components },
  });
  const posOf = (id: string): [number, number, number] => {
    const e = world().objects.get(id)!.matrixWorld.elements;
    return [e[12]!, e[13]!, e[14]!];
  };
  const standAt = (id: string, at: readonly number[], dx: number, dz = 0): void => world().sim.setPosition(id, [at[0]! + dx, at[1]! + 1, at[2]! + dz]);
  /** A killing blow; a downed player (X1) releases at once, so the death lands with the blow's credit. */
  async function kill(victim: string, sourceId: string): Promise<void> {
    bus().emit("combat.damage", { targetId: victim, sourceId, amount: 100_000, control: 0, point: [0, 1, 0] });
    await until(() => net().get(`combat/${victim}.dead`) === true || ((net().get(`combat/${victim}.downed`) as number | undefined) ?? 0) > 0, 4000, `${victim} falls`);
    if (net().get(`combat/${victim}.dead`) !== true) bus().emit("combat.release.request", { casterId: victim });
    await until(() => net().get(`combat/${victim}.dead`) === true, 4000, `${victim} dies`);
  }

  let ana = "";
  let bo = "";
  let cy = "";
  let dee = "";
  let spawnAt: [number, number, number] = [0, 0, 0];

  it("sets up: four players with the engine's character sheet; the soul binder, the innkeeper and two shops", async () => {
    ana = await join("ana");
    bo = await join("bram");
    cy = await join("cyd");
    dee = await join("dee");
    spawnAt = posOf(ana);
    const assets = world().assets;
    assets.addDataAsset({ id: "x2-parcel", type: "item", name: "x2-parcel", data: PARCEL });
    for (const id of ["tidewell/binder-awen", "tidewell/innkeeper-marl"]) {
      if (!assets.getDataAsset(id)) assets.addDataAsset({ id, type: "dialogue", name: id, data: json(`dialogues/${id}.json`) });
    }
    for (const id of ["tidewell/cotters-chandlery", "tidewell/gull-and-barrel"]) {
      if (!assets.getDataAsset(id)) assets.addDataAsset({ id, type: "shop", name: id, data: json(`shops/${id}.json`) });
    }
    assets.addDataAsset({ id: "x2-quick", type: "shop", name: "x2-quick", data: { name: "Quick", stock: [{ itemId: "rousing-charm", qty: 1, price: 10, restockSeconds: 1 }] } });
    assets.addDataAsset({
      id: "x2-talk",
      type: "dialogue",
      name: "x2-talk",
      data: {
        start: [{ node: "hi" }],
        nodes: {
          hi: {
            text: "Well?",
            choices: [
              { text: "Chandlery", do: [{ do: "openShop", shop: "tidewell/cotters-chandlery" }] },
              { text: "My vault", do: [{ do: "openVault" }] },
            ],
          },
        },
      },
    });
    assets.addDataAsset({ id: "x2-quick-talk", type: "dialogue", name: "x2-quick-talk", data: { start: [{ node: "hi" }], nodes: { hi: { text: "?", choices: [{ text: "Shop", do: [{ do: "openShop", shop: "x2-quick" }] }] } } } });
    const npc = (params: Record<string, unknown>, dx: number) => {
      const e = ent({ script: { name: "npc", params: { radius: 8, face: false, ...params } } }, ["interactable"]);
      (e.components["transform"] as { position: number[] }).position = [spawnAt[0] + dx, spawnAt[1], spawnAt[2] + 30];
      return e;
    };
    world().addEntities({
      ...world().base,
      entities: {
        ...Object.fromEntries([ana, bo, cy, dee].map((id, i) => [`x2-sheet-${i}`, ent({ script: { name: "character-sheet", params: { actor: id, persist: false } } })])),
        "x2-binder": npc({ name: "Sister Awen", dialogue: "tidewell/binder-awen" }, 0),
        "x2-inn": npc({ name: "Marl Tull", dialogue: "tidewell/innkeeper-marl", shop: "tidewell/gull-and-barrel", bindName: "Tidewell" }, 4),
        "x2-chandler": npc({ name: "Pim", dialogue: "x2-talk", shop: "tidewell/cotters-chandlery", vault: true }, -4),
        "x2-quick": npc({ name: "Quick", dialogue: "x2-quick-talk", shop: "x2-quick" }, -8),
      },
    });
    await until(() => [ana, bo, cy, dee].every((id) => sheet(id) !== undefined), 5000, "sheets");
    for (const id of [ana, bo, cy, dee]) expect(net().set(`character/${id}`, roomySheet())).toBe(true);
    for (const h of ["hero0", "hero1", "hero2"]) net().set(`combat/${h}.dead`, true);
    standAt(bo, spawnAt, 0, 3);
    standAt(cy, spawnAt, 0, -3);
    standAt(dee, spawnAt, 3, 0);
    await wait(300);
  });

  it("a creature's kill: the corpse holds the bags' contents and the copper, worn gear and the entrusted parcel stay; it is the victim's alone, for 15 minutes", async () => {
    const d = dressed(roomySheet(1234), [{ stack: { itemId: "iron-helm", qty: 1 }, wear: true }, { stack: { itemId: "health-potion", qty: 3 } }, { stack: { itemId: "x2-parcel", qty: 1 } }]);
    expect(net().set(`character/${cy}`, d.sheet)).toBe(true);
    const [helm, , parcel] = d.uids;
    await wait(100);
    await kill(cy, "x2-wolf");
    await until(() => corpsesOf(cy).length === 1, 4000, "the corpse");
    const [id, corpse] = corpsesOf(cy)[0]!;
    expect(corpse).toMatchObject({ owner: cy, corpse: cy, coins: 1234, items: [{ itemId: "health-potion", qty: 3 }] });
    expect(corpse.claimUntil).toBeUndefined();
    expect(Math.abs(corpse.until! - world().timeMs - 900_000)).toBeLessThan(2000); // combat-actor corpseSeconds: 900
    const after = sheet(cy)!;
    expect(after.coins).toBe(0);
    expect(count(after, "health-potion")).toBe(0);
    expect(after.equipment.helm).toBe(helm);
    expect(after.items[parcel!]).toBeDefined(); // entrusted: kept through the death
    expect(Math.hypot(corpse.at[0] - posOf(cy)[0], corpse.at[2] - posOf(cy)[2])).toBeLessThan(1.5);
    // owner-only: only the victim's socket has it; anyone else standing on it is told it is gone
    await until(() => seen(cy, `lootbag/${id}`), 3000, "sent to the victim");
    expect(seen(ana, `lootbag/${id}`)).toBe(false);
    standAt(ana, corpse.at, 1);
    await wait(250);
    const before = refusals(ana).length;
    ask(ana, "inventory.loot", { bagId: id });
    await until(() => refusals(ana).length > before, 3000, "refused");
    expect(refusals(ana).at(-1)).toBe("it is gone");
    // the victim walks back and takes it all
    standAt(cy, corpse.at, 0.5);
    await wait(250);
    ask(cy, "inventory.loot", { bagId: id });
    await until(() => net().get(`lootbag/${id}`) === undefined, 3000, "emptied");
    expect(sheet(cy)!.coins).toBe(1234);
    expect(count(sheet(cy), "health-potion")).toBe(3);
    standAt(ana, spawnAt, 0);
  });

  it("an entrusted item cannot be dropped, stored or sold", async () => {
    const d = dressed(roomySheet(100), [{ stack: { itemId: "x2-parcel", qty: 1 } }]);
    expect(net().set(`character/${dee}`, d.sheet)).toBe(true);
    await wait(100);
    ask(dee, "inventory.drop", { uid: d.uids[0] });
    await until(() => refusals(dee, "drop").length > 0, 3000, "drop refused");
    expect(refusals(dee, "drop").at(-1)).toMatch(/entrusted/);
    standAt(dee, [spawnAt[0] - 4, spawnAt[1], spawnAt[2] + 30], 0, -1.5);
    await wait(300);
    ask(dee, "npc.talk", { npcId: "x2-chandler" });
    await until(() => node(dee) === "hi", 3000, "talking");
    ask(dee, "npc.choose", { npcId: "x2-chandler", node: "hi", index: 1 });
    await until(() => panel(dee) === "vault", 3000, "vault");
    ask(dee, "vault.deposit", { npcId: "x2-chandler", uid: d.uids[0] });
    await until(() => /entrusted/.test(notice(dee)), 3000, "vault refused");
    ask(dee, "npc.leave", { npcId: "x2-chandler" });
    await until(() => node(dee) === undefined, 3000, "left");
    ask(dee, "npc.talk", { npcId: "x2-chandler" });
    await until(() => node(dee) === "hi", 3000, "talking again");
    ask(dee, "npc.choose", { npcId: "x2-chandler", node: "hi", index: 0 });
    await until(() => panel(dee) === "shop", 3000, "shop");
    ask(dee, "shop.sell", { npcId: "x2-chandler", uid: d.uids[0] });
    await until(() => /entrusted/.test(notice(dee)), 3000, "sale refused");
    expect(sheet(dee)!.items[d.uids[0]!]).toBeDefined();
    ask(dee, "npc.leave", { npcId: "x2-chandler" });
  });

  it("a DOWNED character gets no NPC service (package X1's state)", async () => {
    standAt(dee, [spawnAt[0] - 4, spawnAt[1], spawnAt[2] + 30], 0, -1.5);
    await wait(300);
    expect(net().set(`combat/${dee}.downed`, world().timeMs / 1000 + 60)).toBe(true);
    ask(dee, "npc.talk", { npcId: "x2-chandler" });
    await until(() => refusals(dee, "talk").some((e) => /you are down/.test(e)), 3000, "refused while down");
    expect(node(dee)).toBeUndefined();
    net().delete(`combat/${dee}.downed`);
  });

  it("the chandlery's rousing charms: limited stock sells out; a limited shelf restocks over time", async () => {
    expect(net().set(`character/${dee}`, roomySheet(20_000))).toBe(true);
    await wait(100);
    ask(dee, "npc.talk", { npcId: "x2-chandler" });
    await until(() => node(dee) === "hi", 3000, "talking");
    ask(dee, "npc.choose", { npcId: "x2-chandler", node: "hi", index: 0 });
    await until(() => panel(dee) === "shop", 3000, "shop");
    for (let i = 0; i < 2; i++) ask(dee, "shop.buy", { npcId: "x2-chandler", itemId: "rousing-charm", qty: 1 });
    await until(() => count(sheet(dee), "rousing-charm") === 2, 3000, "two charms");
    expect(sheet(dee)!.coins).toBe(20_000 - 2 * 4000);
    ask(dee, "shop.buy", { npcId: "x2-chandler", itemId: "rousing-charm", qty: 1 });
    await until(() => notice(dee) === "Sold out", 3000, "sold out");
    expect(count(sheet(dee), "rousing-charm")).toBe(2);
    ask(dee, "npc.leave", { npcId: "x2-chandler" });
    // a shelf that restocks every second
    standAt(dee, [spawnAt[0] - 8, spawnAt[1], spawnAt[2] + 30], 0, -1.5);
    await wait(300);
    ask(dee, "npc.talk", { npcId: "x2-quick" });
    await until(() => node(dee) === "hi", 3000, "talking");
    ask(dee, "npc.choose", { npcId: "x2-quick", node: "hi", index: 0 });
    await until(() => panel(dee) === "shop", 3000, "shop");
    ask(dee, "shop.buy", { npcId: "x2-quick", itemId: "rousing-charm", qty: 1 });
    await until(() => (net().get("shop/x2-quick") as { stock: Record<string, number> } | undefined)?.stock["rousing-charm"] === 0, 3000, "sold out");
    await until(() => (net().get("shop/x2-quick") as { stock: Record<string, number> }).stock["rousing-charm"] === 1, 4000, "restocked");
    ask(dee, "npc.leave", { npcId: "x2-quick" });
  });

  it("the soul binder: the real Tidewell dialogue opens the window; a first choice and re-attuning the same slot are free, a change costs 50s", async () => {
    const d = dressed(roomySheet(6000), [{ stack: { itemId: "iron-helm", qty: 1 }, wear: true }, { stack: { itemId: "pyre-staff", qty: 1 }, wear: true }]);
    expect(net().set(`character/${ana}`, d.sheet)).toBe(true);
    standAt(ana, [spawnAt[0], spawnAt[1], spawnAt[2] + 30], 0, -1.5);
    await wait(300);
    ask(ana, "npc.talk", { npcId: "x2-binder" });
    await until(() => node(ana) === "first", 3000, "met");
    ask(ana, "npc.choose", { npcId: "x2-binder", node: "first", index: 0 }); // Tell me about binding my gear.
    await until(() => node(ana) === "soul-offer", 3000, "the offer");
    ask(ana, "npc.choose", { npcId: "x2-binder", node: "soul-offer", index: 0 }); // Bind what I wear.
    await until(() => panel(ana) === "soulbind", 3000, "the window");
    expect(net().get(`dialogue/${ana}`)).toMatchObject({ panel: { kind: "soulbind", slots: 3, price: 5000 } });
    ask(ana, "soul.attune", { npcId: "x2-binder", slots: ["helm"] });
    await until(() => sheet(ana)!.soulslots?.helm === d.uids[0], 3000, "attuned");
    expect(sheet(ana)!.coins).toBe(6000);
    ask(ana, "soul.attune", { npcId: "x2-binder", slots: ["helm"] });
    await wait(300);
    expect(sheet(ana)!.coins).toBe(6000);
    ask(ana, "soul.attune", { npcId: "x2-binder", slots: ["helm", "primary"] });
    await until(() => sheet(ana)!.soulslots?.primary === d.uids[1], 3000, "two slots");
    expect(sheet(ana)!.coins).toBe(1000);
    ask(ana, "soul.attune", { npcId: "x2-binder", slots: ["primary"] });
    await until(() => /cannot afford/.test(notice(ana)), 3000, "too poor to change");
    expect(Object.keys(sheet(ana)!.soulslots!).sort()).toEqual(["helm", "primary"]);
    ask(ana, "npc.leave", { npcId: "x2-binder" });
  });

  it("the innkeeper keeps the hearth: bindSoul from the real Tidewell dialogue binds the respawn at the inn", async () => {
    standAt(ana, [spawnAt[0] + 4, spawnAt[1], spawnAt[2] + 30], 0, -1.5);
    await wait(300);
    ask(ana, "npc.talk", { npcId: "x2-inn" });
    await until(() => node(ana) === "first", 3000, "met");
    const offered = (net().get(`dialogue/${ana}`) as { choices: Array<{ index: number; text: string }> }).choices;
    const hearth = offered.find((c) => /hearth/.test(c.text))!;
    ask(ana, "npc.choose", { npcId: "x2-inn", node: "first", index: hearth.index });
    await until(() => node(ana) === "hearth-offer", 3000, "the offer");
    ask(ana, "npc.choose", { npcId: "x2-inn", node: "hearth-offer", index: 0 });
    await until(() => node(ana) === "hearth-done", 3000, "bound");
    const bind = net().get(`bind/${ana}`) as { at: number[]; name: string };
    expect(bind.name).toBe("Tidewell");
    expect(Math.hypot(bind.at[0]! - (spawnAt[0] + 4), bind.at[2]! - (spawnAt[2] + 30))).toBeLessThan(0.5);
    ask(ana, "npc.leave", { npcId: "x2-inn" });
    standAt(ana, spawnAt, 0);
  });

  it("a player kill: the killer's minute — contents, copper, ONE worn item no soulbound slot protects; the victim locked and sent nothing; then it passes to the victim", async () => {
    expect(net().set(`character/${ana}`, roomySheet())).toBe(true);
    const d = dressed(roomySheet(4321), [
      { stack: { itemId: "iron-helm", qty: 1 }, wear: true },
      { stack: { itemId: "pyre-staff", qty: 1 }, wear: true },
      { stack: { itemId: "leather-gloves", qty: 1 }, wear: true },
      { stack: { itemId: "bandage", qty: 1 } },
      { stack: { itemId: "health-potion", qty: 2 } },
    ]);
    const [helm, staff, gloves] = d.uids;
    // the helm is worn in its attuned slot (protected); the staff was swapped into a slot attuned to another item
    expect(net().set(`character/${bo}`, { ...d.sheet, soulslots: { helm: helm!, primary: "i999" } })).toBe(true);
    standAt(bo, spawnAt, 0, 3);
    await wait(300);
    const t0 = world().timeMs;
    await kill(bo, ana);
    await until(() => corpsesOf(bo).length === 1, 4000, "the corpse");
    const [id, corpse] = corpsesOf(bo)[0]!;
    expect(corpse).toMatchObject({ owner: ana, corpse: bo, coins: 4321, takes: 1, plunder: 900 });
    expect([...corpse.offer!].sort()).toEqual([staff, gloves].sort()); // never the protected helm
    expect(corpse.items.map((s) => s.itemId).sort()).toEqual(["bandage", "health-potion"]);
    expect(Math.abs(corpse.claimUntil! - t0 - 60_000)).toBeLessThan(5000); // combat-actor bodyLootSeconds: 60
    expect(net().get(`lootlock/${bo}`)).toMatchObject({ by: ana, bag: id });
    await until(() => seen(ana, `lootbag/${id}`), 3000, "sent to the killer");
    expect(seen(bo, `lootbag/${id}`)).toBe(false);
    // the victim cannot take from it, nor unequip while locked
    standAt(bo, corpse.at, 0.5);
    standAt(ana, corpse.at, 1);
    await wait(250);
    let before = refusals(bo).length;
    ask(bo, "inventory.loot", { bagId: id });
    await until(() => refusals(bo).length > before, 3000, "refused to the victim");
    expect(refusals(bo).at(-1)).toBe("it is gone");
    ask(bo, "inventory.unequip", { slot: "gloves" });
    await until(() => refusals(bo, "unequip").length > 0, 3000, "locked");
    // the protected helm, asked for anyway: refused
    ask(ana, "inventory.loot", { bagId: id, uid: helm });
    await until(() => refusals(ana).includes("you may not take that"), 3000, "not offered");
    // the copper, one carried stack and the staff
    ask(ana, "inventory.loot", { bagId: id, coins: true });
    await until(() => sheet(ana)!.coins === 4321, 3000, "copper");
    ask(ana, "inventory.loot", { bagId: id, index: corpse.items.findIndex((s) => s.itemId === "bandage") });
    await until(() => count(sheet(ana), "bandage") === 1, 3000, "the bandage");
    ask(ana, "inventory.loot", { bagId: id, uid: staff });
    await until(() => count(sheet(ana), "pyre-staff") === 1, 3000, "the staff");
    expect(sheet(bo)!.equipment.primary).toBeUndefined();
    expect(sheet(bo)!.plunderedUntil! - lootClock.now()).toBeGreaterThan(890_000);
    // one worn item only
    before = refusals(ana).length;
    ask(ana, "inventory.loot", { bagId: id, uid: gloves });
    await until(() => refusals(ana).length > before, 3000, "a second worn item");
    expect(refusals(ana).at(-1)).toBe("you have already taken your one piece of their gear");
    expect(sheet(bo)!.equipment.gloves).toBe(gloves);
    // Leave the rest: it passes to the victim (their socket gets it, the killer's loses it) and the lock lifts
    ask(ana, "inventory.loot", { bagId: id, done: true });
    await until(() => (net().get(`lootbag/${id}`) as LootBag | undefined)?.owner === bo, 3000, "released");
    expect(net().get(`lootbag/${id}`)).toMatchObject({ owner: bo, corpse: bo, items: [{ itemId: "health-potion", qty: 2 }] });
    expect((net().get(`lootbag/${id}`) as LootBag).offer).toBeUndefined();
    await until(() => seen(bo, `lootbag/${id}`) && !seen(ana, `lootbag/${id}`), 3000, "moved between replicas");
    expect(net().get(`lootlock/${bo}`)).toBeUndefined();
    ask(bo, "inventory.loot", { bagId: id });
    await until(() => net().get(`lootbag/${id}`) === undefined, 3000, "the victim took the rest");
    expect(count(sheet(bo), "health-potion")).toBe(2);
  });

  it("plundered: the next killer is offered no worn item and cannot take one; a claim that runs out passes the corpse to the victim", async () => {
    const victim = sheet(bo)!;
    const gloves = victim.equipment.gloves!;
    expect(bodyLootOffer(victim).worn).toEqual([]); // the game offers nothing while plundered
    expect(bodyLootOffer(victim, victim.plunderedUntil! + 1).worn).toEqual([gloves]);
    const d = dressed(victim, [{ stack: { itemId: "bandage", qty: 1 } }]);
    expect(net().set(`character/${bo}`, d.sheet)).toBe(true);
    await wait(100);
    // a second killer's claim that names the gloves anyway (the engine re-checks)
    standAt(dee, posOf(bo), 1);
    await wait(200);
    bus().emit("inventory.corpse", { actorId: bo, at: posOf(bo), killer: dee, claimSeconds: 2, offer: [gloves], takes: 1, plunder: 900, from: bo });
    await until(() => corpsesOf(bo).length === 1, 3000, "the corpse");
    const [id] = corpsesOf(bo)[0]!;
    ask(dee, "inventory.loot", { bagId: id, uid: gloves });
    await until(() => refusals(dee).length > 0, 3000, "refused");
    expect(refusals(dee).at(-1)).toMatch(/plundered/);
    expect(sheet(bo)!.equipment.gloves).toBe(gloves);
    // the claim runs out: the corpse is the victim's
    await until(() => (net().get(`lootbag/${id}`) as LootBag | undefined)?.owner === bo, 5000, "released on time");
    expect(net().get(`lootlock/${bo}`)).toBeUndefined();
  });

  it("a corpse lasts its lifetime, then it and what is left are gone", async () => {
    const d = dressed(sheet(cy)!, [{ stack: { itemId: "bandage", qty: 1 } }]);
    expect(net().set(`character/${cy}`, d.sheet)).toBe(true);
    await wait(100);
    const had = corpsesOf(cy).length;
    bus().emit("inventory.corpse", { actorId: cy, at: posOf(cy), seconds: 1 });
    await until(() => corpsesOf(cy).length === had + 1, 3000, "a short corpse");
    expect(count(sheet(cy), "bandage")).toBe(0);
    await until(() => corpsesOf(cy).length === had, 4000, "gone");
    expect(count(sheet(cy), "bandage")).toBe(0);
  });
});
