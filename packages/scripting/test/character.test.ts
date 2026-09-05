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
import { EventBus, InputService, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);

const noInput: InputLike = { isDown: () => false };

function harness(startingItems: Array<{ itemId: string; qty?: number }> = []) {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  assets.addDataAsset({
    id: "helm",
    type: "item",
    name: "helm",
    data: { name: "Iron Helm", slots: ["helm"], size: [2, 2], weight: 2, modifiers: { armor: 5, constitution: 2 } },
  });
  assets.addDataAsset({
    id: "potion",
    type: "item",
    name: "potion",
    data: { name: "Potion", stack: 5, size: [1, 1], weight: 0.5, kind: "consumable" },
  });
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);

  const ops: Op[] = [
    {
      op: "add-entity",
      id: "player",
      entity: {
        name: "player",
        parent: null,
        tags: ["player"],
        components: { transform: { position: [1, 2, 3] } },
      },
    },
    {
      op: "add-entity",
      id: "player-sheet",
      entity: {
        name: "sheet",
        parent: "player",
        tags: [],
        components: {
          transform: {},
          script: { name: "character-sheet", params: { actor: "player", startingItems, persist: false } },
        },
      },
    },
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const player = new THREE.Object3D();
  player.position.set(1, 2, 3);
  const objects = new Map([
    ["player", player],
    ["player-sheet", new THREE.Object3D()],
  ]);
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
  const heard: Array<{ name: string; payload: unknown }> = [];
  for (const name of ["character.leveled", "character.refused", "inventory.dropped"]) {
    bus.on(name, (payload) => heard.push({ name, payload }));
  }
  runtime.start();
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60);
  };
  const sheet = () => netState.get("character/player") as CharacterSheet;
  return { runtime, bus, netState, events, heard, tick, sheet, objects };
}

describe("character-sheet builtin", () => {
  it("registers its request contracts with their network direction", () => {
    const { events } = harness();
    expect(events.replicationOf("inventory.move")).toBe("to-authority");
    expect(events.replicationOf("character.allocate")).toBe("to-authority");
    expect(events.replicationOf("character.xp")).toBe("none");
    expect(events.replicationOf("inventory.give")).toBe("none");
    expect(events.replicationOf("character.leveled")).toBe("to-peers");
    expect(events.replicationOf("character.refused")).toBe("to-peers");
  });

  it("seeds a fresh sheet into netState with the starting items and publishes derived stats on the body", () => {
    const { sheet, objects } = harness([{ itemId: "helm" }, { itemId: "potion", qty: 3 }]);
    const s = sheet();
    expect(s.level).toBe(1);
    expect(Object.values(s.items).map((x) => x.itemId).sort()).toEqual(["helm", "potion"]);
    const derived = objects.get("player")!.userData["character"] as { stats: { maxHp: number }; weight: number };
    expect(derived.stats.maxHp).toBe(200);
    expect(derived.weight).toBe(3.5);
  });

  it("applies requests on the authority and refuses bad ones", () => {
    const { bus, tick, sheet, heard, objects } = harness([{ itemId: "helm" }]);
    bus.emit("inventory.equip", { actorId: "player", uid: "i1" });
    tick();
    expect(sheet().equipment.helm).toBe("i1");
    expect((objects.get("player")!.userData["character"] as { stats: { armor: number } }).stats.armor).toBe(5);

    bus.emit("character.allocate", { actorId: "player", attribute: "strength" });
    tick();
    expect(heard.at(-1)).toMatchObject({ name: "character.refused", payload: { error: "no unspent points" } });

    bus.emit("character.xp", { actorId: "player", amount: 100 });
    tick();
    expect(sheet().level).toBe(2);
    expect(heard.at(-1)).toMatchObject({ name: "character.leveled", payload: { actorId: "player", level: 2, unspent: 1 } });
    bus.emit("character.allocate", { actorId: "player", attribute: "strength" });
    tick();
    expect(sheet().attributes.strength).toBe(11);
    expect(sheet().unspent).toBe(0);
  });

  it("dropping announces the stack at the body's position", () => {
    const { bus, tick, sheet, heard } = harness([{ itemId: "potion", qty: 4 }]);
    bus.emit("inventory.drop", { actorId: "player", uid: "i1", qty: 3 });
    tick();
    expect(sheet().items["i1"]!.qty).toBe(1);
    expect(heard.at(-1)).toMatchObject({
      name: "inventory.dropped",
      payload: { actorId: "player", itemId: "potion", qty: 3, at: [1, 2, 3] },
    });
  });

  it("a peer may only act on a body it owns", () => {
    const { bus, tick, sheet, heard, netState } = harness([{ itemId: "helm" }]);
    bus.setNetRole("authority");
    netState.set("owner/player", "peer-a");
    bus.injectFromPeer("peer-b", [{ name: "inventory.equip", payload: { actorId: "player", uid: "i1" } }]);
    tick();
    expect(sheet().equipment.helm).toBeUndefined();
    expect(heard.at(-1)).toMatchObject({ name: "character.refused", payload: { error: /not your character/ } });
    bus.injectFromPeer("peer-a", [{ name: "inventory.equip", payload: { actorId: "player", uid: "i1" } }]);
    tick();
    expect(sheet().equipment.helm).toBe("i1");
    // grants never come from a peer, whoever they are
    bus.injectFromPeer("peer-a", [{ name: "character.xp", payload: { actorId: "player", amount: 5000 } }]);
    tick();
    expect(sheet().level).toBe(1);
  });

  it("ignores requests for other bodies and does nothing on a peer", () => {
    const { bus, tick, sheet, netState } = harness([{ itemId: "helm" }]);
    bus.emit("inventory.equip", { actorId: "somebody-else", uid: "i1" });
    tick();
    expect(sheet().equipment.helm).toBeUndefined();
    netState.setAuthority(false);
    bus.emit("inventory.equip", { actorId: "player", uid: "i1" });
    tick();
    expect(sheet().equipment.helm).toBeUndefined();
  });
});

describe("InputService keyboard capture", () => {
  it("hides keys from gameplay while a menu owns the keyboard, without losing them", () => {
    const listeners = new Map<string, (e: unknown) => void>();
    const fakeWindow = {
      addEventListener: (type: string, cb: (e: unknown) => void) => listeners.set(type, cb),
      removeEventListener: () => undefined,
    } as unknown as Window;
    const input = new InputService(fakeWindow);
    listeners.get("keydown")!({ code: "KeyW", target: null });
    expect(input.isDown("KeyW")).toBe(true);
    input.captureKeyboard("inventory", true);
    expect(input.isDown("KeyW")).toBe(false);
    input.captureKeyboard("other-menu", true);
    input.captureKeyboard("inventory", false);
    expect(input.isDown("KeyW")).toBe(false); // the other menu still holds it
    input.captureKeyboard("other-menu", false);
    expect(input.isDown("KeyW")).toBe(true); // still held down underneath
  });
});
