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
  add("sword", "item", { name: "Sword", slots: ["primary"], value: 200, kind: "equipment" });
  add("letter", "item", { name: "Letter", kind: "quest" });
  add("errand", "quest", {
    id: "errand", title: "Errand", description: "", giver: "keeper", turnIn: "keeper",
    objectives: [{ id: "a", label: "Talk to the keeper again", kind: "talk", target: "keeper" }],
    rewardXp: 20, rewardCoins: 150, rewardItems: [{ itemId: "sword", qty: 1 }],
  });
  add("hello", "quest", { id: "hello", title: "Hello", description: "", objectives: [{ id: "a", label: "Say hello", kind: "talk", target: "keeper" }], rewardCoins: 5 });
  add("keeper-talk", "dialogue", {
    start: [{ if: { quest: "errand", status: "ready" }, node: "done" }, { node: "hi" }],
    nodes: {
      hi: {
        text: "Hello {name}. The cove is {dir:cove}.",
        choices: [
          { text: "Work?", if: { quest: "errand", status: "available" }, do: [{ do: "acceptQuest", quest: "errand" }], goto: "hi" },
          { text: "Trade", do: [{ do: "openShop", shop: "stall" }] },
          { text: "Vault", do: [{ do: "openVault" }] },
          { text: "Pay me", do: [{ do: "pay", coins: 99999 }] },
          { text: "Bye" },
        ],
      },
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
    entity("keeper", null, { script: { name: "npc", params: { name: "Keeper", dialogue: "keeper-talk", places: "town", shop: "stall", vault: true, radius: 3 } } }, ["interactable"]),
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
  return { runtime, netState, player, say, pick, conv, sheet, journal, tick };
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

describe("npc-ui helpers", () => {
  it("parses coin amounts", () => {
    expect(parseCoins("1g 20s 5c")).toBe(12005);
    expect(parseCoins("250")).toBe(250);
    expect(parseCoins("3s")).toBe(300);
  });
});
