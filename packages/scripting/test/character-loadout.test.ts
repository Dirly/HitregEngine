import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { z } from "zod";
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
  type HandState,
  type Op,
} from "@hitreg/core";
import { EventBus, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

/** A body with a sheet (combat lock on `fight/<id>`) and a stance script, 60 Hz. */
function harness(startingItems: Array<{ itemId: string; qty?: number; equip?: boolean }>, keys: Set<string> = new Set()) {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const item = (id: string, data: Record<string, unknown>) => assets.addDataAsset({ id, type: "item", name: id, data });
  item("sword", { name: "Sword", slots: ["primary", "secondary"], stance: ["Sword"], equipSeconds: 0.5 });
  item("bow", { name: "Bow", slots: ["primary", "secondary"], twoHanded: true, stance: ["Bow"] });
  item("shield", { name: "Shield", slots: ["offhand"], stance: ["Shield"], equipSeconds: 2 });
  item("potion", { name: "Potion", kind: "consumable", slots: ["consumable"], stack: 5, skills: { use: "drink" } });
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);
  const ops: Op[] = [
    { op: "add-entity", id: "player", entity: { name: "player", parent: null, tags: ["player"], components: { transform: {} } } },
    {
      op: "add-entity",
      id: "player-sheet",
      entity: {
        name: "sheet",
        parent: "player",
        tags: [],
        components: {
          transform: {},
          script: { name: "character-sheet", params: { actor: "player", startingItems, persist: false, combatLock: "fight", swapSeconds: 0.8, useCooldown: 8 } },
        },
      },
    },
    {
      op: "add-entity",
      id: "player-stance",
      entity: {
        name: "stance",
        parent: "player",
        tags: [],
        components: { transform: {}, script: { name: "weapon-stance", params: { actor: "player", swapKey: "KeyX" } } },
      },
    },
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const player = new THREE.Object3D();
  const objects = new Map([
    ["player", player],
    ["player-sheet", new THREE.Object3D()],
    ["player-stance", new THREE.Object3D()],
  ]);
  const netState = new NetStateStore();
  registerCharacterNetState(netState);
  netState.define("fight", z.number());
  const bus = new EventBus(events);
  const input: InputLike = { isDown: (k) => keys.has(k) };
  const runtime = new ScriptRuntime({ doc, objects, sim: null, registry, input, events: bus, netState, assets, localPlayer: () => "player" });
  const heard: Array<{ name: string; payload: unknown }> = [];
  for (const name of ["character.refused", "inventory.used"]) bus.on(name, (payload) => heard.push({ name, payload }));
  runtime.start();
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60);
  };
  const sheet = () => netState.get("character/player") as CharacterSheet;
  const hand = () => (netState.get("hand/player") ?? { set: 0 }) as HandState;
  const now = () => runtime.now();
  return { runtime, bus, netState, heard, tick, sheet, hand, now, player, keys };
}

describe("gear changes take time and stop in combat", () => {
  it("times an equip by the item's equipSeconds", () => {
    const h = harness([{ itemId: "shield" }]);
    h.bus.emit("inventory.equip", { actorId: "player", uid: "i1" });
    h.tick(100);
    expect(h.sheet().equipment.offhand).toBeUndefined();
    expect(h.sheet().inventoryAction?.duration).toBe(2);
    h.tick(30);
    expect(h.sheet().equipment.offhand).toBe("i1");
    h.runtime.dispose();
  });

  it("refuses equip and unequip while the combat lock is in the future, and cancels one under way", () => {
    const h = harness([{ itemId: "sword", equip: true }, { itemId: "shield" }]);
    h.netState.set("fight/player", h.now() + 5000);
    h.bus.emit("inventory.equip", { actorId: "player", uid: "i2" });
    h.bus.emit("inventory.unequip", { actorId: "player", slot: "primary" });
    h.tick();
    expect(h.heard.filter((e) => e.name === "character.refused")).toHaveLength(2);
    expect(h.sheet().inventoryAction).toBeUndefined();
    // a fight that starts mid-equip interrupts it; the shield stays carried
    h.netState.set("fight/player", 0);
    h.bus.emit("inventory.equip", { actorId: "player", uid: "i2" });
    h.tick(30);
    h.netState.set("fight/player", h.now() + 5000);
    h.tick(200);
    expect(h.sheet().equipment.offhand).toBeUndefined();
    expect(h.sheet().items.i2?.container).toBeDefined();
    expect(h.heard.at(-1)).toMatchObject({ payload: { error: /interrupted/ } });
    h.runtime.dispose();
  });
});

describe("weapon sets", () => {
  it("swaps on the key after swapSeconds, in combat, and the stance follows", () => {
    const h = harness([{ itemId: "sword", equip: true }, { itemId: "shield", equip: true }, { itemId: "bow" }]);
    expect(h.player.userData["stance"]).toEqual(["SwordShield", "Sword"]);
    // nothing in the secondary slot: refused
    h.bus.emit("character.swap", { actorId: "player" });
    h.tick();
    expect(h.heard.at(-1)).toMatchObject({ payload: { error: /secondary/ } });
    h.bus.emit("inventory.equip", { actorId: "player", uid: "i3", slot: "secondary" });
    h.tick(120);
    expect(h.sheet().equipment.secondary).toBe("i3");
    h.netState.set("fight/player", h.now() + 60000);
    h.keys.add("KeyX");
    h.tick();
    h.keys.delete("KeyX");
    expect(h.hand().swapTo).toBe(1);
    h.tick(30);
    expect(h.hand().set).toBe(0);
    h.tick(30);
    expect(h.hand()).toEqual({ set: 1 });
    expect(h.player.userData["stance"]).toEqual(["Bow"]);
    h.runtime.dispose();
  });
});

describe("the belt", () => {
  it("drinks one from a belt slot in combat, announces it, and shares a cooldown", () => {
    const h = harness([{ itemId: "potion", qty: 3 }]);
    h.bus.emit("inventory.equip", { actorId: "player", uid: "i1", slot: "consumable2" });
    h.tick(2);
    expect(h.sheet().equipment.consumable2).toBe("i1");
    h.netState.set("fight/player", h.now() + 60000);
    h.bus.emit("inventory.use", { actorId: "player", slot: "consumable2" });
    h.tick();
    expect(h.sheet().items.i1?.qty).toBe(2);
    expect(h.heard.at(-1)).toMatchObject({ name: "inventory.used", payload: { itemId: "potion", skill: "drink", slot: "consumable2" } });
    h.bus.emit("inventory.use", { actorId: "player", slot: "consumable2" });
    h.tick();
    expect(h.sheet().items.i1?.qty).toBe(2);
    expect(h.heard.at(-1)).toMatchObject({ name: "character.refused" });
    h.tick(60 * 8);
    h.bus.emit("inventory.use", { actorId: "player", slot: "consumable2" });
    h.tick();
    expect(h.sheet().items.i1?.qty).toBe(1);
    h.runtime.dispose();
  });
});
