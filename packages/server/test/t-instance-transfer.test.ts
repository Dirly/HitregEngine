import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { RoomClient, WebSocketClientTransport, WS_HOST_ID } from "@hitreg/net";
import {
  AssetLibrary,
  createScene,
  createSheet,
  itemSchema,
  placeStack,
  registerCoreAssetTypes,
  vaultSchema,
  type CharacterSheet,
  type EntityDoc,
  type Item,
  type LootBag,
  type SceneDoc,
  type ShopState,
  type Vault,
} from "@hitreg/core";
import { serve, type ServeHandle } from "../src/serve.js";
import { PortalHarness, WORLD_MODULE, type LoadedContent, type WorldModuleMessage } from "../src/index.js";
import { serializeLoadout } from "../../../apps/playground/projects/voxel-demo/scripts/lib/combat-rules.js";
import { deriveLoadout } from "../../../apps/playground/projects/voxel-demo/scripts/lib/loadout.js";
import { eventLog } from "./event-log.js";

/**
 * Package T (voxel-demo docs/combat-build/T-instance-transfer.md): an item
 * instance — a pyre staff worn to 31 of 60 with two rolled twists — survives
 * every way it changes hands or place, over real sockets on the `field` scene
 * with the engine's character-sheet and npc builtins on the authority: dropped
 * into the dropper's own loot bag and taken back (package L), sold to a shop and bought back (by the
 * other player), stored in the vault and taken out, handed from one player to
 * another (and refused when the receiver has no room), and, in the new owner's
 * hands, its bolt still carries the twist where the hit resolves. A layer
 * transfer (the cluster's commit/load, through the portal harness) carries it
 * too, in the bags and in the vault.
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
const INSTANCE = { itemId: "pyre-staff", durability: 31, twists: TWISTS };
const items: Record<string, Item> = {};
const catalog = (id: string): Item | undefined => (items[id] ??= itemSchema.parse(JSON.parse(readFileSync(path.join(ITEMS, `${id}.json`), "utf8"))));

/** A sheet able to wield a staff, optionally carrying the twisted, worn one. */
function sheetWith(staff: boolean): CharacterSheet {
  const sheet: CharacterSheet = { ...createSheet(), coins: 100_000 };
  for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
  if (!staff) return sheet;
  const r = placeStack(sheet, { ...INSTANCE, qty: 1 }, { catalog });
  if (!r.ok) throw new Error(r.error);
  return r.sheet;
}
const staffOf = (sheet: CharacterSheet | undefined): [string, CharacterSheet["items"][string]] | undefined =>
  Object.entries(sheet?.items ?? {}).find(([, s]) => s.itemId === "pyre-staff");

let layer: ServeHandle | null = null;
try {
  layer = await serve({ playground, scene: "field", port: 0, host: "127.0.0.1", respawnSeconds: 0, log: () => undefined });
} catch (error) {
  console.warn("T instance-transfer test skipped:", error instanceof Error ? error.message : error);
}
if (layer) (layer.world.scriptRegistry.get("combat-actor") as unknown as { critRoll: () => number }).critRoll = () => 1;

describe.skipIf(!layer)("T: a twisted, worn item survives every transfer, over real sockets", { timeout: 120_000 }, () => {
  const transports: WebSocketClientTransport[] = [];
  const clients = new Map<string, RoomClient>();
  afterAll(async () => {
    for (const c of clients.values()) c.leave();
    for (const t of transports) t.close();
    await layer?.close();
  });

  const world = () => layer!.world;
  const net = () => world().netState;
  const bus = () => world().eventBus;
  const numOf = (key: string): number => (net().get(key) as number) ?? 0;
  const hp = (id: string) => numOf(`combat/${id}.hp`);
  const maxHp = (id: string) => numOf(`combat/${id}.maxHp`);
  // every delivered event of a name (./event-log.ts: never index into the 64-entry trace ring)
  const log = eventLog(() => bus());
  const events = (name: string) => log.payloads(name);
  const sheet = (id: string) => net().get(`character/${id}`) as CharacterSheet | undefined;
  const refusals = (id: string) => events("character.refused").filter((e) => e.actorId === id).map((e) => e.error);

  function join(peerId: string): Promise<string> {
    const transport = new WebSocketClientTransport(layer!.url, { peerId });
    const client = new RoomClient(transport, WS_HOST_ID);
    const spawned: string[] = [];
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
      return spawned[0]!;
    });
  }
  /** A request from the body's own client, over its socket (the server injects it as from that peer). */
  const ask = (bodyId: string, name: string, payload: Record<string, unknown>): void =>
    clients.get(bodyId)!.sendCommand({ t: "event", name, payload: { actorId: bodyId, ...payload } });

  const xz = (id: string): [number, number] => {
    const e = world().objects.get(id)!.matrixWorld.elements;
    return [e[12]!, e[14]!];
  };
  let ana = "";
  let bo = "";
  let y = 0;
  const place = (id: string, dx: number, dz: number): void => {
    const [ax, az] = xz(ana);
    world().sim.setPosition(id, [ax + dx, y, az + dz]);
  };
  const ent = (components: Record<string, unknown>, tags: string[] = []): EntityDoc => ({ name: "t", parent: null, tags, components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, ...components } });

  it("sets up: two players, each with the engine's character sheet; a shopkeeper-banker beside them", async () => {
    ana = await join("ana");
    bo = await join("bram");
    y = world().objects.get(ana)!.position.y + 0.3;
    const assets = world().assets;
    assets.addDataAsset({ id: "t-shop", type: "shop", name: "t-shop", data: { name: "T Stall", buyRate: 0.25, buys: [], resale: 6, stock: [] } });
    assets.addDataAsset({
      id: "t-talk",
      type: "dialogue",
      name: "t-talk",
      data: {
        start: [{ node: "hi" }],
        nodes: {
          hi: {
            text: "Well?",
            choices: [
              { text: "Trade", do: [{ do: "openShop", shop: "t-shop" }], goto: "end" },
              { text: "My vault", do: [{ do: "openVault" }], goto: "end" },
            ],
          },
        },
      },
    });
    const [ax, az] = xz(ana);
    const npc = ent({ script: { name: "npc", params: { name: "Tess", dialogue: "t-talk", shop: "t-shop", vault: true, radius: 8, face: false } } }, ["interactable"]);
    (npc.components["transform"] as { position: number[] }).position = [ax, y, az];
    world().addEntities({
      ...world().base,
      entities: {
        "t-sheet-ana": ent({ script: { name: "character-sheet", params: { actor: ana, persist: false } } }),
        "t-sheet-bo": ent({ script: { name: "character-sheet", params: { actor: bo, persist: false } } }),
        "t-npc": npc,
      },
    });
    await until(() => sheet(ana) !== undefined && sheet(bo) !== undefined, 5000, "sheets");
    expect(net().set(`character/${ana}`, sheetWith(true))).toBe(true);
    expect(net().set(`character/${bo}`, sheetWith(false))).toBe(true);
    place(bo, 1.5, 0);
    await wait(400);
    expect(staffOf(sheet(ana))![1]).toMatchObject({ ...INSTANCE, container: expect.any(String) });
  });

  it("dropped, it lies whole in the dropper's own loot bag (package L), and the dropper takes back the same item", async () => {
    const [uid] = staffOf(sheet(ana))!;
    ask(ana, "inventory.drop", { uid });
    await until(() => net().keys("lootbag/").length === 1, 4000, "in a bag");
    const key = net().keys("lootbag/")[0]!;
    expect(net().get(key) as LootBag).toMatchObject({ owner: ana, items: [{ ...INSTANCE, qty: 1 }] });
    expect(staffOf(sheet(ana))).toBeUndefined();
    expect(events("inventory.dropped").at(-1)).toMatchObject({ actorId: ana, ...INSTANCE, bagId: key.slice("lootbag/".length) });

    // only its owner may take from it: another player is refused as if it were not there
    place(bo, 1, 0);
    await wait(300);
    ask(bo, "inventory.loot", { bagId: key.slice("lootbag/".length), index: 0 });
    await until(() => refusals(bo).includes("it is gone"), 3000, "refused to another player");
    expect(net().get(key)).toBeDefined();
    // the dropper has it back, worn and twisted as it fell, and hands it to Bo (the transfer path)
    ask(ana, "inventory.loot", { bagId: key.slice("lootbag/".length), index: 0 });
    await until(() => staffOf(sheet(ana)) !== undefined, 3000, "taken back");
    expect(staffOf(sheet(ana))![1]).toMatchObject(INSTANCE);
    expect(net().get(key)).toBeUndefined();
    bus().emit("inventory.transfer", { actorId: ana, toActorId: bo, uid: staffOf(sheet(ana))![0] });
    await until(() => staffOf(sheet(bo)) !== undefined, 3000, "handed over");
    expect(staffOf(sheet(bo))![1]).toMatchObject(INSTANCE);
  });

  it("sold to a shop, it waits on the buy-back shelf whole; the other player buys it back intact", async () => {
    // Bo sells it
    ask(bo, "npc.talk", { npcId: "t-npc" });
    await until(() => (net().get(`dialogue/${bo}`) as { node?: string } | undefined)?.node === "hi", 3000, "talking");
    ask(bo, "npc.choose", { npcId: "t-npc", node: "hi", index: 0 });
    await until(() => (net().get(`dialogue/${bo}`) as { panel?: { kind: string } | null } | undefined)?.panel?.kind === "shop", 3000, "shop open");
    const coins = sheet(bo)!.coins;
    ask(bo, "shop.sell", { npcId: "t-npc", uid: staffOf(sheet(bo))![0] });
    await until(() => staffOf(sheet(bo)) === undefined, 3000, "sold");
    expect(sheet(bo)!.coins).toBe(coins + 300); // 1200 x 0.25
    expect((net().get("shop/t-shop") as ShopState).resale).toEqual([{ ...INSTANCE, qty: 1 }]);

    // Ana buys that exact entry
    ask(ana, "npc.talk", { npcId: "t-npc" });
    await until(() => (net().get(`dialogue/${ana}`) as { node?: string } | undefined)?.node === "hi", 3000, "talking");
    ask(ana, "npc.choose", { npcId: "t-npc", node: "hi", index: 0 });
    await until(() => (net().get(`dialogue/${ana}`) as { panel?: { kind: string } | null } | undefined)?.panel?.kind === "shop", 3000, "shop open");
    ask(ana, "shop.buy", { npcId: "t-npc", itemId: "pyre-staff", qty: 1, resale: 0 });
    await until(() => staffOf(sheet(ana)) !== undefined, 3000, "bought back");
    expect(staffOf(sheet(ana))![1]).toMatchObject(INSTANCE);
    expect((net().get("shop/t-shop") as ShopState).resale).toEqual([]);
  });

  it("stored in the vault and taken out, it is the same item", async () => {
    ask(ana, "npc.choose", { npcId: "t-npc", node: "hi", index: 1 });
    await until(() => (net().get(`dialogue/${ana}`) as { panel?: { kind: string } | null } | undefined)?.panel?.kind === "vault", 3000, "vault open");
    ask(ana, "vault.deposit", { npcId: "t-npc", uid: staffOf(sheet(ana))![0] });
    await until(() => staffOf(sheet(ana)) === undefined, 3000, "deposited");
    expect((net().get(`vault/${ana}`) as Vault).items[0]).toEqual({ ...INSTANCE, qty: 1 });
    ask(ana, "vault.withdraw", { npcId: "t-npc", index: 0 });
    await until(() => staffOf(sheet(ana)) !== undefined, 3000, "withdrawn");
    expect(staffOf(sheet(ana))![1]).toMatchObject(INSTANCE);
    expect((net().get(`vault/${ana}`) as Vault).items).toEqual([]);
    ask(ana, "npc.leave", { npcId: "t-npc" });
    ask(bo, "npc.leave", { npcId: "t-npc" });
  });

  it("player to player: the authority moves it intact; a client cannot ask for it; no room is refused, nothing moves", async () => {
    const [uid] = staffOf(sheet(ana))!;
    // a peer cannot send the authority-internal transfer (dropped by the event bus)
    ask(ana, "inventory.transfer", { toActorId: bo, uid });
    await wait(300);
    expect(staffOf(sheet(ana))![0]).toBe(uid);

    // Bo's bags full: refused, both sheets unchanged
    const roomy = sheet(bo)!;
    let crammed = roomy;
    for (;;) {
      const r = placeStack(crammed, { itemId: "pyre-staff", qty: 1 }, { catalog });
      if (!r.ok) break;
      crammed = r.sheet;
    }
    expect(net().set(`character/${bo}`, crammed)).toBe(true);
    const before = sheet(ana)!;
    bus().emit("inventory.transfer", { actorId: ana, toActorId: bo, uid });
    await until(() => refusals(ana).includes("no room in their bags"), 3000, "refused for room");
    expect(sheet(ana)).toEqual(before);
    expect(sheet(bo)).toEqual(crammed);

    // out of range: refused
    expect(net().set(`character/${bo}`, roomy)).toBe(true);
    place(bo, 20, 0);
    await wait(300);
    bus().emit("inventory.transfer", { actorId: ana, toActorId: bo, uid });
    await until(() => refusals(ana).includes("too far away"), 3000, "refused for range");

    // side by side: moved, whole
    place(bo, 1.5, 0);
    await wait(300);
    bus().emit("inventory.transfer", { actorId: ana, toActorId: bo, uid });
    await until(() => staffOf(sheet(bo)) !== undefined, 3000, "transferred");
    expect(staffOf(sheet(ana))).toBeUndefined();
    expect(staffOf(sheet(bo))![1]).toMatchObject(INSTANCE);
    expect(events("inventory.transferred").at(-1)).toMatchObject({ actorId: ana, toActorId: bo, ...INSTANCE, qty: 1 });
  });

  it("in its new owner's hands it is still the twisted staff: the bar names the twist and the bolt heals its caster", async () => {
    ask(bo, "inventory.equip", { uid: staffOf(sheet(bo))![0], slot: "primary" });
    await until(() => sheet(bo)!.equipment.primary === staffOf(sheet(bo))![0], 6000, "equipped");
    const loadout = deriveLoadout({ sheet: sheet(bo)!, catalog, set: 0, trait: "" });
    expect(loadout).toMatchObject({ lmb: "emberBolt+leech", weapon2: "chainLightning+executioner" });
    net().set(`combat/${bo}.loadout`, serializeLoadout(loadout));

    // a dummy to hit (a hero subtree, as the D3b tests do)
    for (const h of ["hero0", "hero1", "hero2"]) net().set(`combat/${h}.dead`, true);
    const subtree: Record<string, EntityDoc> = {};
    for (const id of ["hero0", "hero0-visual", "hero0-combat", "hero0-caster"]) subtree[id] = structuredClone(world().expanded.entities[id]!) // the authored doc: the server builds no drawing-only children;
    layer!.npcs.register("t-dummy", subtree);
    const [bx, bz] = xz(bo);
    expect(layer!.npcs.spawn("t-dummy", [bx + 5, world().objects.get(bo)!.position.y + 0.3, bz], { id: "t-foe" })).not.toBeNull();
    await until(() => hp("t-foe") > 0, 10_000, "the dummy's bars");
    await wait(800);
    net().set(`combat/${bo}.hp`, maxHp(bo) - 40);
    net().set(`combat/${bo}.mana`, numOf(`combat/${bo}.maxMana`));
    const seen = events("combat.healed").length;
    const [fx, fz] = xz("t-foe");
    const [ox, oz] = xz(bo);
    const d = Math.hypot(fx - ox, fz - oz) || 1;
    bus().emit("combat.cast.request", { casterId: bo, abilityId: "emberBolt+leech", aim: [(fx - ox) / d, (fz - oz) / d] });
    await until(() => events("combat.healed").slice(seen).some((e) => e.targetId === bo && e.abilityId === "emberBolt+leech"), 5000, "the leech heals its new owner");
    expect(events("combat.healed").slice(seen).find((e) => e.targetId === bo)!.amount as number).toBeGreaterThan(0);
    expect(events("combat.damage").some((e) => e.targetId === "t-foe" && e.sourceId === bo && e.abilityId === "emberBolt+leech")).toBe(true);
  });
});

// -- a layer transfer: the cluster's commit and load, through the portal harness -----------------------

const ent2 = (name: string, components: Record<string, unknown>, tags: string[] = []): EntityDoc => ({ name, parent: null, tags, components });
const floor = (x: number) => ent2("floor", { transform: { position: [x, -0.5, 0] }, rigidbody: { kind: "static" }, collider: { shape: "box", size: [40, 1, 40] } });
const player = (at: [number, number, number]) =>
  ent2("player", { transform: { position: at }, rigidbody: { kind: "dynamic", lockRotations: true }, collider: { shape: "capsule", size: [0.8, 1.8, 0.8] } }, ["player"]);

function content(): LoadedContent {
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  assets.addDataAsset({ id: "pyre-staff", type: "item", name: "pyre-staff", data: JSON.parse(readFileSync(path.join(ITEMS, "pyre-staff.json"), "utf8")) });
  const surface = createScene("surface");
  surface.entities["floor"] = floor(0);
  surface.entities["player"] = player([0, 1.2, 8]);
  surface.entities["gate"] = ent2("gate", { transform: { position: [0, 0, 0] }, script: { name: "portal", params: { scene: "dungeon", anchor: "entry" } } }, ["interactable"]);
  const dungeon = createScene("dungeon");
  dungeon.entities["floor"] = floor(100);
  dungeon.entities["player"] = player([100, 1.2, 10]);
  dungeon.entities["entry"] = ent2("entry", { transform: { position: [100, 0, 0] } }, ["anchor"]);
  const scenes = new Map<string, SceneDoc>([["surface", surface], ["dungeon", dungeon]]);
  return { assets, scenes, sceneFiles: new Map(), worlds: [], worldFiles: new Map(), scriptDirs: [], warnings: [] };
}

describe("T: a layer transfer carries the instance, in the bags and in the vault", { timeout: 60_000 }, () => {
  it("the twisted, worn staff and a twisted copy in the vault arrive whole, and the save holds them", async () => {
    const vault: Vault = vaultSchema.parse({ items: [{ ...INSTANCE, qty: 1, durability: 7 }] });
    const h = await PortalHarness.start({ content: content(), scene: "surface", at: [0, 1.2, 2.5], sheet: sheetWith(true), records: { vault }, projectScripts: false, terrain: false });
    h.step(20);
    const trip = await h.interact("gate");
    expect(trip).toMatchObject({ from: "surface", to: "dungeon" });
    expect(staffOf(h.sheet())![1]).toMatchObject(INSTANCE);
    expect((h.record("vault") as Vault).items[0]).toEqual({ ...INSTANCE, qty: 1, durability: 7 });
    await h.commit();
    const saved = await h.load("dungeon");
    expect(staffOf(saved.sheet as CharacterSheet)![1]).toMatchObject(INSTANCE);
    expect((saved.records["vault"] as Vault).items[0]).toMatchObject({ twists: TWISTS, durability: 7 });
    await h.close();
  });
});
