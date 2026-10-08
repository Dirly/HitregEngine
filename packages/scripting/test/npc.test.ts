import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  createScene,
  EventRegistry,
  NetStateStore,
  registerCharacterNetState,
  registerCoreAssetTypes,
  registerCoreComponents,
  registerCoreEvents,
  type CharacterSheet,
  type Conversation,
  type NpcMemory,
  type Op,
  type QuestJournal,
  type ShopState,
  type Vault,
} from "@hitreg/core";
import { EventBus, parseCoins, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike } from "../src/index.js";
import { extentOf, hitRadiusPx, plateHeightPx } from "../src/npc-ui.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);
const noInput: InputLike = { isDown: () => false };

function harness() {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const add = (id: string, type: string, data: unknown) => assets.addDataAsset({ id, type, name: id, data });
  add("bread", "item", { name: "Bread", stack: 10, value: 10, kind: "consumable" });
  add("sword", "item", { name: "Sword", slots: ["primary"], value: 200, kind: "equipment", durability: 60, modifiers: { strength: 3 } });
  add("letter", "item", { name: "Letter", kind: "quest" });
  add("errand", "quest", {
    id: "errand", title: "Errand", description: "", giver: "keeper", turnIn: "keeper",
    objectives: [{ id: "a", label: "Talk to the keeper again", kind: "talk", target: "keeper" }],
    rewardXp: 20, rewardCoins: 150, rewardItems: [{ itemId: "sword", qty: 1 }],
  });
  add("hello", "quest", { id: "hello", title: "Hello", description: "", objectives: [{ id: "a", label: "Say hello", kind: "talk", target: "keeper" }], rewardCoins: 5 });
  add("keeper-talk", "dialogue", {
    start: [{ if: { quest: "errand", status: "ready" }, node: "done" }, { if: { bound: true }, node: "rest" }, { node: "hi" }],
    nodes: {
      hi: {
        text: "Hello {name}. The cove is {dir:cove}.",
        choices: [
          { text: "Work?", if: { quest: "errand", status: "available" }, do: [{ do: "acceptQuest", quest: "errand" }], goto: "hi" },
          { text: "Trade", do: [{ do: "openShop", shop: "stall" }] },
          { text: "Vault", do: [{ do: "openVault" }] },
          { text: "Bind me", if: { bound: false }, do: [{ do: "bindSoul" }], goto: "hi" },
          { text: "Repair", do: [{ do: "openRepair" }] },
          { text: "Pay me", do: [{ do: "pay", coins: 99999 }] },
          { text: "Bye" },
        ],
      },
      rest: { text: "Your soul already rests with the bell.", choices: [{ text: "Repair", do: [{ do: "openRepair", rate: 1 }] }] },
      done: { text: "Thanks.", choices: [{ text: "Here.", do: [{ do: "turnInQuest", quest: "errand" }] }] },
    },
  });
  add("town", "places", { origin: [0, 0], places: { cove: { at: [-50, -80] } } });
  add("stall", "shop", { name: "Stall", markup: 1, buyRate: 0.5, stock: [{ itemId: "bread", qty: 3, restockSeconds: 1 }] });
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);

  const entity = (id: string, parent: string | null, components: Record<string, unknown>, tags: string[] = []): Op => ({
    op: "add-entity", id, entity: { name: id, parent, tags, components: { transform: {}, ...components } },
  });
  const ops: Op[] = [
    entity("player", null, {}, ["player"]),
    entity("player-sheet", "player", { script: { name: "character-sheet", params: { actor: "player", persist: false } } }),
    entity("player-quests", "player", { script: { name: "quest-log", params: { actor: "player", autoStart: ["hello"] } } }),
    entity("keeper", null, { script: { name: "npc", params: { name: "Keeper", dialogue: "keeper-talk", places: "town", shop: "stall", vault: true, radius: 3, bindPoint: [10, 2, 10], bindName: "Testholm" } } }, ["interactable"]),
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const player = new THREE.Object3D();
  const keeper = new THREE.Object3D();
  keeper.position.set(2, 0, 0);
  const objects = new Map<string, THREE.Object3D>([
    ["player", player], ["player-sheet", new THREE.Object3D()], ["player-quests", new THREE.Object3D()], ["keeper", keeper],
  ]);
  const netState = new NetStateStore();
  registerCharacterNetState(netState);
  netState.set("name/player", "Ada");
  const bus = new EventBus(events);
  const runtime = new ScriptRuntime({ doc, objects, sim: null, registry, input: noInput, events: bus, netState, assets, localPlayer: () => "player" });
  runtime.start();
  const tick = (n = 1) => { for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60); };
  tick(2);
  const say = (name: string, payload: Record<string, unknown>, from?: string) => {
    const event = { actorId: "player", npcId: "keeper", ...payload };
    if (from) bus.injectFromPeer(from, [{ name, payload: event }]);
    else bus.emit(name, event);
    tick(20);
  };
  const conv = () => netState.get("dialogue/player") as Conversation | undefined;
  const pick = (text: string) => {
    const c = conv()!;
    const choice = c.choices.find((x) => x.text === text);
    if (!choice) throw new Error(`no choice "${text}" in ${JSON.stringify(c.choices)}`);
    say("npc.choose", { node: c.node, index: choice.index });
  };
  const sheet = () => netState.get("character/player") as CharacterSheet;
  const journal = () => netState.get("quests/player") as QuestJournal;
  return { runtime, netState, player, bus, say, pick, conv, sheet, journal, tick };
}

describe("npc builtin", () => {
  it("talks, gives a quest, counts the talk, and pays out on hand-in", () => {
    const h = harness();
    expect(h.journal().quests.hello?.status).toBe("active");
    h.say("npc.talk", {});
    expect(h.conv()).toMatchObject({ npc: "keeper", node: "hi", text: "Hello Ada. The cove is north-west." });
    expect((h.netState.get("npc/player") as NpcMemory).met.keeper).toBe(1);
    // the autoStarted talk quest completed on that first conversation, and paid
    expect(h.journal().quests.hello?.status).toBe("complete");
    expect(h.sheet().coins).toBe(5);

    h.pick("Work?");
    expect(h.journal().quests.errand?.status).toBe("active");
    expect(h.conv()?.choices.some((c) => c.text === "Work?")).toBe(false); // taken now
    h.pick("Bye");
    expect(h.conv()).toBeUndefined();

    // talking again satisfies the objective -> READY, and the conversation opens at the hand-in
    h.say("npc.talk", {});
    expect(h.journal().quests.errand?.status).toBe("ready");
    h.say("npc.leave", {});
    h.say("npc.talk", {});
    expect(h.conv()?.node).toBe("done");
    const xp = h.sheet().xp;
    h.pick("Here.");
    expect(h.journal().quests.errand?.status).toBe("complete");
    expect(h.sheet().coins).toBe(155);
    expect(h.sheet().xp).toBe(xp + 20);
    expect(Object.values(h.sheet().items).some((s) => s.itemId === "sword")).toBe(true);
    h.runtime.dispose();
  });

  it("refuses an action it cannot afford and keeps the conversation where it was", () => {
    const h = harness();
    h.say("npc.talk", {});
    h.pick("Pay me");
    expect(h.conv()).toMatchObject({ node: "hi", notice: "You cannot afford that." });
    h.runtime.dispose();
  });

  it("sells from a limited shelf that restocks, and buys back", () => {
    const h = harness();
    h.say("npc.talk", {});
    h.pick("Trade");
    expect(h.conv()?.panel).toEqual({ kind: "shop", shop: "stall" });
    h.say("shop.buy", { itemId: "bread", qty: 1 });
    expect(h.conv()?.notice).toMatch(/you need/i);
    h.netState.set("character/player", { ...h.sheet(), coins: 100 });
    h.say("shop.buy", { itemId: "bread", qty: 3 });
    expect(h.sheet().coins).toBe(70);
    expect((h.netState.get("shop/stall") as ShopState).stock.bread).toBe(0);
    h.tick(70); // one unit a second comes back
    expect((h.netState.get("shop/stall") as ShopState).stock.bread).toBe(1);
    const uid = Object.entries(h.sheet().items).find(([, s]) => s.itemId === "bread")![0];
    h.say("shop.sell", { uid, qty: 2 });
    expect(h.sheet().coins).toBe(80);
    expect((h.netState.get("shop/stall") as ShopState).resale).toEqual([{ itemId: "bread", qty: 2 }]);
    h.runtime.dispose();
  });

  it("keeps a vault, only for the body's owner, only in range", () => {
    const h = harness();
    h.netState.set("owner/player", "peer-a");
    h.netState.set("character/player", { ...h.sheet(), coins: 300 });
    h.say("npc.talk", {}, "peer-a");
    h.pick("Vault");
    h.say("vault.coins", { amount: 200 }, "peer-b"); // not the owner: ignored
    expect(h.sheet().coins).toBe(305); // 300 + the autoStarted talk quest's 5
    h.say("vault.coins", { amount: 200 }, "peer-a");
    expect(h.sheet().coins).toBe(105);
    expect((h.netState.get("vault/player") as Vault).coins).toBe(200);
    // walking away closes it
    h.player.position.set(30, 0, 0);
    h.tick(40);
    expect(h.conv()).toBeUndefined();
    h.say("vault.coins", { amount: -200 }, "peer-a");
    expect(h.sheet().coins).toBe(105);
    h.runtime.dispose();
  });
});

describe("npc services: soul binder + repairer", () => {
  it("binds the soul to the npc's bind point, and `bound` opens the binder's other greeting", () => {
    const h = harness();
    h.say("npc.talk", {});
    expect(h.conv()?.node).toBe("hi");
    h.pick("Bind me");
    expect(h.netState.get("bind/player")).toEqual({ at: [10, 2, 10], name: "Testholm" });
    expect(h.conv()?.choices.some((c) => c.text === "Bind me")).toBe(false); // bound here now
    h.say("npc.leave", {});
    h.say("npc.talk", {});
    expect(h.conv()).toMatchObject({ node: "rest", text: "Your soul already rests with the bell." });
    h.runtime.dispose();
  });

  it("wears worn gear on character.wear, and repairs it at the npc all-or-nothing", () => {
    const h = harness();
    h.bus.emit("inventory.give", { actorId: "player", itemId: "sword", qty: 1 });
    h.tick(2);
    const uid = Object.entries(h.sheet().items).find(([, s]) => s.itemId === "sword")![0];
    h.bus.emit("inventory.equip", { actorId: "player", uid });
    h.tick(120); // the equip takes a moment
    expect(h.sheet().equipment.primary).toBe(uid);
    // a peer cannot wear someone's gear
    h.bus.injectFromPeer("peer-x", [{ name: "character.wear", payload: { actorId: "player", fraction: 1 } }]);
    h.tick(2);
    expect(h.sheet().items[uid]!.durability).toBeUndefined();
    for (let i = 0; i < 10; i++) h.bus.emit("character.wear", { actorId: "player" });
    h.tick(2);
    expect(h.sheet().items[uid]!.durability).toBe(0); // ten deaths of 6 points: broken

    h.say("npc.talk", {});
    h.pick("Repair");
    expect(h.conv()?.panel).toEqual({ kind: "repair", rate: 0.25 });
    h.netState.set("character/player", { ...h.sheet(), coins: 49 });
    h.say("repair.all", {});
    expect(h.conv()?.notice).toBe("You need 50c to repair everything");
    expect(h.sheet().items[uid]!.durability).toBe(0);
    h.netState.set("character/player", { ...h.sheet(), coins: 60 });
    h.say("repair.item", { uid });
    expect(h.sheet().items[uid]!.durability).toBeUndefined();
    expect(h.sheet().coins).toBe(10);
    h.runtime.dispose();
  });
});

describe("npc-ui helpers", () => {
  it("parses coin amounts", () => {
    expect(parseCoins("1g 20s 5c")).toBe(12005);
    expect(parseCoins("250")).toBe(250);
    expect(parseCoins("3s")).toBe(300);
  });
});

describe("npc-ui inspect targeting", () => {
  it("aims at a low object's visible bounds, not the air 1 m over its origin", () => {
    const crate = new THREE.Group();
    crate.position.set(5, 0, 2);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8));
    box.position.y = 0.4;
    crate.add(box);
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    hidden.visible = false;
    crate.add(hidden);
    crate.updateMatrixWorld(true);
    const e = extentOf(crate)!;
    expect(e.cx).toBeCloseTo(0);
    expect(e.cy).toBeCloseTo(0.4);
    expect(e.top).toBeCloseTo(0.8);
    expect(e.r).toBeCloseTo(Math.sqrt(3) * 0.4);
  });
  it("has no bounds without meshes, and sizes the hit by the bounds", () => {
    const empty = new THREE.Group();
    empty.updateMatrixWorld(true);
    expect(extentOf(empty)).toBeNull();
    expect(hitRadiusPx(1, 1400 / 60)).toBeCloseTo(60);
    expect(hitRadiusPx(0.1, 20)).toBe(24);
    expect(hitRadiusPx(3, 2)).toBe(90);
  });
  it("lifts an NPC's icon clear of its nameplate", () => {
    expect(plateHeightPx(5, true)).toBeCloseTo(50 * 1.15);
    expect(plateHeightPx(20, true)).toBeCloseTo(37 * 0.7);
  });
});
