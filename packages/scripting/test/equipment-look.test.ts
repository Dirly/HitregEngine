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
  type Op,
} from "@hitreg/core";
import { EventBus, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike, type ModelLook } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);
const noInput: InputLike = { isDown: () => false };

const sword = (name: string, parts: string[], texture: string) => ({
  name,
  slots: ["primary", "secondary"],
  appearance: { model: "weapons/longsword-uber.glb", parts, texture },
});

function harness() {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  assets.addDataAsset({ id: "bag", type: "item", name: "Bag", data: { name: "Bag", slots: ["bag"], bag: { cols: 4, rows: 2 } } });
  assets.addDataAsset({ id: "iron", type: "item", name: "iron", data: sword("Iron", ["Handle", "Blade1"], "weapons/iron.png") });
  assets.addDataAsset({ id: "steel", type: "item", name: "steel", data: sword("Steel", ["Handle", "Blade4"], "weapons/steel.png") });
  assets.addDataAsset({ id: "stick", type: "item", name: "stick", data: { name: "Stick", slots: ["primary"] } });
  assets.addDataAsset({
    id: "ember",
    type: "item",
    name: "ember",
    data: {
      ...sword("Ember", ["Handle", "Blade1"], "weapons/steel.png"),
      appearance: {
        model: "weapons/longsword-uber.glb",
        parts: ["Handle", "Blade1"],
        texture: "weapons/steel.png",
        glow: { color: "#ff6a1a", intensity: 2, parts: ["Blade1"] },
        effects: [{ vfx: "items/ember-motes", material: "fx/fire", anchor: { part: "Blade1", at: "tip" } }],
      },
    },
  });
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);

  const entity = (name: string, parent: string | null, script?: { name: string; params: Record<string, unknown> }) => ({
    name,
    parent,
    tags: [],
    components: { transform: {}, ...(script ? { script } : {}) },
  });
  const ops: Op[] = [
    { op: "add-entity", id: "player", entity: entity("player", null) },
    {
      op: "add-entity",
      id: "player-sheet",
      entity: entity("sheet", "player", {
        name: "character-sheet",
        params: {
          actor: "player",
          persist: false,
          startingItems: [{ itemId: "bag", equip: true }, { itemId: "iron", equip: true }, { itemId: "steel" }, { itemId: "stick" }, { itemId: "ember" }],
        },
      }),
    },
    { op: "add-entity", id: "weapon", entity: entity("weapon", "player") },
    { op: "add-entity", id: "weapon-look", entity: entity("look", "weapon", { name: "equipment-look", params: { actor: "player" } }) },
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const objects = new Map(["player", "player-sheet", "weapon", "weapon-look"].map((id) => [id, new THREE.Object3D()]));
  const netState = new NetStateStore();
  registerCharacterNetState(netState);
  const bus = new EventBus(events);
  const looks: Array<{ entityId: string; look: ModelLook }> = [];
  const runtime = new ScriptRuntime({
    doc,
    objects,
    sim: null,
    registry,
    input: noInput,
    events: bus,
    netState,
    assets,
    localPlayer: () => "player",
    setModelLook: (entityId, look) => looks.push({ entityId, look }),
  });
  runtime.start();
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60);
  };
  const sheet = () => netState.get("character/player") as CharacterSheet;
  const uidOf = (itemId: string) => Object.entries(sheet().items).find(([, s]) => s.itemId === itemId)![0];
  return { runtime, bus, tick, looks, uidOf, sheet };
}

describe("equipment-look builtin", () => {
  it("shows the equipped item's parts and sheet on its parent's model, and follows every change", () => {
    const h = harness();
    h.tick();
    expect(h.looks.at(-1)).toEqual({
      entityId: "weapon",
      look: { parts: ["Handle", "Blade1"], texture: "weapons/iron.png", glow: null, effects: [] },
    });

    h.bus.emit("inventory.equip", { actorId: "player", uid: h.uidOf("steel"), slot: "primary" });
    h.tick(120);
    expect(h.sheet().equipment.primary).toBe(h.uidOf("steel"));
    expect(h.looks.at(-1)?.look).toEqual({ parts: ["Handle", "Blade4"], texture: "weapons/steel.png", glow: null, effects: [] });

    // glow and anchored effects ride along with the parts, schema defaults filled
    h.bus.emit("inventory.equip", { actorId: "player", uid: h.uidOf("ember"), slot: "primary" });
    h.tick(120);
    expect(h.looks.at(-1)?.look).toMatchObject({
      glow: { color: "#ff6a1a", intensity: 2, parts: ["Blade1"] },
      effects: [{ vfx: "items/ember-motes", material: "fx/fire", anchor: { part: "Blade1", at: "tip", offset: [0, 0, 0] }, cullDistance: 40 }],
    });

    // an item with no appearance, and an empty hand, both hide every part
    h.bus.emit("inventory.equip", { actorId: "player", uid: h.uidOf("stick"), slot: "primary" });
    h.tick(120);
    expect(h.looks.at(-1)?.look).toEqual({ partMask: 0, glow: null, effects: [] });
    const count = h.looks.length;
    h.bus.emit("inventory.unequip", { actorId: "player", slot: "primary" });
    h.tick(120);
    expect(h.sheet().equipment.primary).toBeUndefined();
    // stick → empty is still "nothing shown": no redundant look
    expect(h.looks.length).toBe(count);
    h.runtime.dispose();
  });

  it("with one entity per model on a slot, only the item's own model shows it", () => {
    const events = new EventRegistry();
    registerCoreEvents(events);
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    assets.addDataAsset({ id: "iron", type: "item", name: "iron", data: sword("Iron", ["Handle", "Blade1"], "weapons/iron.png") });
    assets.addDataAsset({
      id: "axe",
      type: "item",
      name: "axe",
      data: { name: "Axe", slots: ["primary"], appearance: { model: "weapons/greataxe-uber.glb", parts: ["Rod", "AxeHead1"] } },
    });
    const registry = new ScriptRegistry();
    registerBuiltinScripts(registry, events, assets);
    const held = (id: string, assetId: string): Op[] => [
      {
        op: "add-entity",
        id,
        entity: { name: id, parent: "player", tags: [], components: { transform: {}, mesh: { source: { kind: "asset", assetId } } } },
      },
      {
        op: "add-entity",
        id: `${id}-look`,
        entity: { name: "look", parent: id, tags: [], components: { transform: {}, script: { name: "equipment-look", params: { actor: "player" } } } },
      },
    ];
    const ops: Op[] = [
      { op: "add-entity", id: "player", entity: { name: "player", parent: null, tags: [], components: { transform: {} } } },
      {
        op: "add-entity",
        id: "player-sheet",
        entity: {
          name: "sheet",
          parent: "player",
          tags: [],
          components: {
            transform: {},
            script: { name: "character-sheet", params: { actor: "player", persist: false, startingItems: [{ itemId: "iron", equip: true }, { itemId: "axe" }] } },
          },
        },
      },
      ...held("sword", "weapons/longsword-uber.glb"),
      ...held("axe", "weapons/greataxe-uber.glb"),
    ];
    const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
    const ids = ["player", "player-sheet", "sword", "sword-look", "axe", "axe-look"];
    const netState = new NetStateStore();
    registerCharacterNetState(netState);
    const bus = new EventBus(events);
    const latest = new Map<string, ModelLook>();
    const runtime = new ScriptRuntime({
      doc,
      objects: new Map(ids.map((id) => [id, new THREE.Object3D()])),
      sim: null,
      registry,
      input: noInput,
      events: bus,
      netState,
      assets,
      localPlayer: () => "player",
      setModelLook: (entityId, look) => latest.set(entityId, look),
    });
    runtime.start();
    runtime.fixedUpdate(1 / 60);
    expect(latest.get("sword")).toMatchObject({ parts: ["Handle", "Blade1"] });
    expect(latest.get("axe")).toEqual({ partMask: 0, glow: null, effects: [] });

    const sheet = netState.get("character/player") as CharacterSheet;
    const axeUid = Object.entries(sheet.items).find(([, s]) => s.itemId === "axe")![0];
    bus.emit("inventory.equip", { actorId: "player", uid: axeUid, slot: "primary" });
    for (let i = 0; i < 120; i++) runtime.fixedUpdate(1 / 60);
    expect(latest.get("axe")).toMatchObject({ parts: ["Rod", "AxeHead1"] });
    expect(latest.get("sword")).toEqual({ partMask: 0, glow: null, effects: [] });
    runtime.dispose();
  });

  it("/give puts an item in this tab's own inventory", () => {
    const h = harness();
    h.tick();
    expect(h.runtime.runConsoleCommand("give", ["steel", "1"])).toEqual({ ok: true, text: "giving 1 steel to player" });
    h.tick();
    expect(Object.values(h.sheet().items).filter((s) => s.itemId === "steel")).toHaveLength(2);
    expect(h.runtime.runConsoleCommand("give", ["nope"])?.ok).toBe(false);
    h.runtime.dispose();
  });
});
