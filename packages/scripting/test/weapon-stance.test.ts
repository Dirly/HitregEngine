import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  createScene,
  EventRegistry,
  itemSchema,
  NetStateStore,
  registerCharacterNetState,
  registerCoreAssetTypes,
  registerCoreComponents,
  registerCoreEvents,
  type CharacterSheet,
  type Op,
} from "@hitreg/core";
import { EventBus, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike } from "../src/index.js";
import { WeaponStance } from "../src/weapon-stance.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);
const noInput: InputLike = { isDown: () => false };

const item = (stance: string[], slots: string[]) => itemSchema.parse({ name: "x", slots, stance });

describe("weapon-stance", () => {
  it("combines an off-hand stance as a suffix on each main-hand stance, then the main hand alone", () => {
    const sword = item(["Sword"], ["primary"]);
    const axe = item(["Axe2H", "TwoHanded"], ["primary"]);
    const shield = item(["Shield"], ["offhand"]);
    expect(WeaponStance.combine(sword, shield)).toEqual(["SwordShield", "Sword"]);
    expect(WeaponStance.combine(axe, undefined)).toEqual(["Axe2H", "TwoHanded"]);
    expect(WeaponStance.combine(undefined, shield)).toEqual(["Shield"]);
    expect(WeaponStance.combine(item([], ["primary"]), undefined)).toEqual([]);
  });

  it("writes the equipped stance to the body, follows the sheet, and /stance previews without the item", () => {
    const events = new EventRegistry();
    registerCoreEvents(events);
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    const add = (id: string, data: object) => assets.addDataAsset({ id, type: "item", name: id, data });
    add("sword", { name: "Sword", slots: ["primary"], stance: ["Sword"] });
    add("shield", { name: "Shield", slots: ["offhand"], stance: ["Shield"] });
    add("greataxe", { name: "Greataxe", slots: ["primary"], stance: ["Axe2H", "TwoHanded"] });
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
            startingItems: [{ itemId: "sword", equip: true }, { itemId: "shield", equip: true }, { itemId: "greataxe" }],
          },
        }),
      },
      { op: "add-entity", id: "player-stance", entity: entity("stance", "player", { name: "weapon-stance", params: { actor: "player", console: true } }) },
    ];
    const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
    const objects = new Map(["player", "player-sheet", "player-stance"].map((id) => [id, new THREE.Object3D()]));
    const netState = new NetStateStore();
    registerCharacterNetState(netState);
    const bus = new EventBus(events);
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
    });
    runtime.start();
    const tick = (n = 1) => {
      for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60);
    };
    const body = objects.get("player")!;
    const sheet = () => netState.get("character/player") as CharacterSheet;
    const uidOf = (itemId: string) => Object.entries(sheet().items).find(([, s]) => s.itemId === itemId)![0];

    tick();
    expect(body.userData["stance"]).toEqual(["SwordShield", "Sword"]);

    bus.emit("inventory.unequip", { actorId: "player", slot: "offhand" });
    bus.emit("inventory.equip", { actorId: "player", uid: uidOf("greataxe"), slot: "primary" });
    tick(120);
    expect(body.userData["stance"]).toEqual(["Axe2H", "TwoHanded"]);

    expect(runtime.runConsoleCommand("stance", ["Staff"])).toEqual({ ok: true, text: "stance: Staff (forced)" });
    expect(body.userData["stance"]).toEqual(["Staff"]);
    runtime.runConsoleCommand("stance", ["off"]);
    expect(body.userData["stance"]).toEqual(["Axe2H", "TwoHanded"]);

    bus.emit("inventory.unequip", { actorId: "player", slot: "primary" });
    tick(120);
    expect(body.userData["stance"]).toBeUndefined();
    runtime.dispose();
  });

  it("G holsters: the flag replicates, the weapons move to the back after the swap delay, and a fight draws", () => {
    const events = new EventRegistry();
    registerCoreEvents(events);
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    assets.addDataAsset({ id: "sword", type: "item", name: "sword", data: { name: "Sword", slots: ["primary"], stance: ["Sword"] } });
    const registry = new ScriptRegistry();
    registerBuiltinScripts(registry, events, assets);
    const entity = (name: string, parent: string | null, script?: { name: string; params: Record<string, unknown> }) => ({
      name, parent, tags: [], components: { transform: {}, ...(script ? { script } : {}) },
    });
    const doc = applyOps(createScene("t"), [
      { op: "add-entity", id: "player", entity: entity("player", null) },
      { op: "add-entity", id: "player-sheet", entity: entity("sheet", "player", { name: "character-sheet", params: { actor: "player", persist: false, startingItems: [{ itemId: "sword", equip: true }] } }) },
      { op: "add-entity", id: "player-stance", entity: entity("stance", "player", { name: "weapon-stance", params: { actor: "player", holsterKey: "KeyG", swapDelay: 0.3 } }) },
    ] as Op[], coreRegistry).doc;
    const objects = new Map(["player", "player-sheet", "player-stance"].map((id) => [id, new THREE.Object3D()]));
    const netState = new NetStateStore();
    registerCharacterNetState(netState);
    const held = new Set<string>();
    const runtime = new ScriptRuntime({
      doc, objects, sim: null, registry, input: { isDown: (c) => held.has(c) }, events: new EventBus(events), netState, assets,
      localPlayer: () => "player",
    });
    runtime.start();
    const tick = (n = 1) => { for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60); };
    const body = objects.get("player")!;
    tick();
    expect(body.userData["holstered"]).toBeUndefined();
    // a fight that is still lingering when G goes down does not undo it
    body.userData["combatUntil"] = 3;

    held.add("KeyG"); tick(); held.delete("KeyG"); tick();
    expect(netState.get("holster/player")).toBe(true);
    expect(body.userData["actionClip"]).toBe("Sheathe"); // the arm goes back first…
    expect(body.userData["holstered"]).toBeUndefined(); // …the weapon has not moved yet
    tick(30); // 0.5 s: past the swap delay
    expect(body.userData["holstered"]).toBe(true);
    expect(netState.get("holster/player")).toBe(true);

    // a swing / block / hit marks the body in combat: that draws
    body.userData["actionClip"] = undefined;
    body.userData["combatUntil"] = 1e9;
    tick();
    expect(netState.get("holster/player")).toBe(false);
    expect(body.userData["actionClip"]).toBe("Draw");
    tick(30);
    expect(body.userData["holstered"]).toBeUndefined();
    runtime.dispose();
  });
});
