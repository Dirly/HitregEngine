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
import { EventBus, registerBuiltinScripts, ScriptRegistry, ScriptRuntime, type InputLike, type ModelLook, type ModelTables } from "../src/index.js";

const coreRegistry = new ComponentRegistry();
registerCoreComponents(coreRegistry);
const noInput: InputLike = { isDown: () => false };
const BODY = "body.glb";
const HEAD = "head.glb";
const HELM = "helm.glb";

const creation = {
  model: BODY,
  traitPicks: 0,
  archetypes: [{ id: "brawn", name: "Brawn", startingItems: [{ itemId: "plate-chest", equip: true }] }],
  appearance: [
    {
      id: "sex",
      label: "Sex",
      body: true,
      options: [
        { id: "male", label: "Male", model: BODY, texture: "base.png", parts: ["HumanMale_ChestFront", "HumanMale_Foot"], skin: true },
        {
          id: "female",
          label: "Female",
          model: BODY,
          scale: 0.96,
          texture: "base-f.png",
          parts: ["HumanFemale_ChestFront", "HumanFemale_Foot"],
          skin: true,
          remap: { prefixes: { HumanMale_: "HumanFemale_" }, sheetSuffix: "-f" },
        },
      ],
    },
    { id: "skin", label: "Skin", material: "Skin", options: [{ id: "tan", label: "Tan", color: "#a2704a" }] },
    { id: "face", label: "Face", options: [{ id: "f1", label: "F1", model: HEAD, texture: "head-f1.png", parts: ["F_HeadFace"], skin: true }] },
    { id: "outfit", label: "Outfit", preview: true, options: [{ id: "robe", label: "Robe", model: BODY, texture: "robe.png", parts: ["HumanMale_ChestFront"] }] },
  ],
  mounts: [
    { model: HEAD, socket: "Head", offset: [0, 2, 0], scale: 0.5 },
    { model: HELM, socket: "Head", offset: [0, 2, 0], scale: 0.5 },
  ],
};

const tables: Record<string, ModelTables> = {
  [BODY]: { parts: {}, tiles: ["base.png", "base-f.png", "plate.png", "plate-f.png"], rules: null },
  [HEAD]: { parts: {}, tiles: ["head-f1.png"], rules: null },
  [HELM]: { parts: {}, tiles: ["helm.png"], rules: { hides: { Visor: ["F_HeadFace"] } } },
};

function harness() {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  assets.addDataAsset({ id: "rules", type: "creation", name: "rules", data: creation });
  assets.addDataAsset({
    id: "plate-chest",
    type: "item",
    name: "plate",
    data: { name: "Plate", slots: ["chest"], appearance: { model: BODY, parts: ["HumanMale_ChestFront"], texture: "plate.png" } },
  });
  assets.addDataAsset({
    id: "visor",
    type: "item",
    name: "visor",
    data: { name: "Visor", slots: ["helm"], appearance: { model: HELM, parts: ["Visor"], texture: "helm.png" } },
  });
  const registry = new ScriptRegistry();
  registerBuiltinScripts(registry, events, assets);
  const entity = (name: string, parent: string | null, components: Record<string, unknown>) => ({ name, parent, tags: [], components: { transform: {}, ...components } });
  const look = (extra: Record<string, unknown> = {}) => ({ script: { name: "character-look", params: { actor: "player", creation: "rules", ...extra } } });
  const mesh = (assetId: string) => ({ mesh: { source: { kind: "asset", assetId } } });
  const ops: Op[] = [
    { op: "add-entity", id: "player", entity: entity("player", null, {}) },
    {
      op: "add-entity",
      id: "player-sheet",
      entity: entity("sheet", "player", { script: { name: "character-sheet", params: { actor: "player", persist: false, creation: "rules" } } }),
    },
    { op: "add-entity", id: "visual", entity: entity("visual", "player", mesh(BODY)) },
    { op: "add-entity", id: "body-look", entity: entity("body look", "visual", look()) },
    { op: "add-entity", id: "head", entity: entity("head", "visual", { ...mesh(HEAD), ...look() }) },
    { op: "add-entity", id: "helm", entity: entity("helm", "visual", { ...mesh(HELM), ...look() }) },
  ];
  const doc = applyOps(createScene("t"), ops, coreRegistry).doc;
  const objects = new Map(["player", "player-sheet", "visual", "body-look", "head", "helm"].map((id) => [id, new THREE.Object3D()]));
  const scene = new THREE.Scene();
  scene.add(objects.get("player")!);
  objects.get("player")!.add(objects.get("visual")!);
  for (const id of ["body-look", "head", "helm"]) objects.get("visual")!.add(objects.get(id)!);
  // the skinned model's head bone, 1.5 up
  const bone = new THREE.Object3D();
  bone.name = "Head";
  bone.position.set(0, 1.5, 0);
  objects.get("visual")!.add(bone);
  const netState = new NetStateStore();
  registerCharacterNetState(netState);
  // the server writes the ticket's build before the body spawns
  netState.set("build/player", { archetype: "brawn", traits: [], appearance: { sex: "female", outfit: "robe" } });
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
    modelTables: (assetId) => Promise.resolve(tables[assetId] ?? null),
  });
  runtime.start();
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) runtime.fixedUpdate(1 / 60);
  };
  const lastLook = (id: string) => looks.filter((l) => l.entityId === id).at(-1)?.look;
  const sheet = () => netState.get("character/player") as CharacterSheet;
  return { runtime, bus, tick, lastLook, sheet, objects };
}

describe("character-look builtin", () => {
  it("dresses a fresh character from its build and archetype kit: body, face, mount, sex remap, no preview rows", async () => {
    const h = harness();
    h.tick();
    await new Promise((r) => setTimeout(r, 0)); // the model tables arrive
    // the archetype's starting set is worn, the preview row was never saved
    expect(Object.values(h.sheet().items).map((s) => s.itemId)).toEqual(["plate-chest"]);
    expect(h.sheet().build?.appearance.outfit).toBeUndefined();
    expect(h.lastLook("visual")).toEqual({
      parts: ["HumanFemale_Foot", "HumanFemale_ChestFront"],
      groups: [
        { parts: ["HumanFemale_Foot"], texture: "base-f.png" },
        { parts: ["HumanFemale_ChestFront"], texture: "plate-f.png" },
      ],
      skinTint: "#a2704a",
      skinSheets: [{ texture: "base.png" }, { texture: "base-f.png" }],
      scale: 0.96,
    });
    expect(h.lastLook("head")).toMatchObject({ parts: ["F_HeadFace"], groups: [{ parts: ["F_HeadFace"], texture: "head-f1.png" }], skinTint: "#a2704a" });
    expect(h.lastLook("helm")).toMatchObject({ parts: [], groups: [] });
    // the head rides its bone in the bone's space: 1.5 + 2 up, at the mount's scale
    h.runtime.lateUpdate(1 / 60);
    const head = h.objects.get("head")!;
    expect(head.position.y).toBeCloseTo(3.5);
    expect(head.scale.x).toBeCloseTo(0.5);
    h.runtime.dispose();
  });

  it("takes what an equipped helm hides off the head, and keeps drawing a body this tab does not simulate", async () => {
    const h = harness();
    h.tick();
    h.bus.emit("inventory.give", { actorId: "player", itemId: "visor", qty: 1 });
    h.tick();
    const uid = Object.entries(h.sheet().items).find(([, s]) => s.itemId === "visor")![0];
    h.bus.emit("inventory.equip", { actorId: "player", uid, slot: "helm" });
    h.tick(120);
    await new Promise((r) => setTimeout(r, 0));
    h.tick();
    expect(h.sheet().equipment.helm).toBe(uid);
    expect(h.lastLook("helm")).toMatchObject({ parts: ["Visor"], groups: [{ parts: ["Visor"], texture: "helm.png" }] });
    expect(h.lastLook("head")).toMatchObject({ parts: [], groups: [] });
    // suspension (another player's body on a peer) leaves presentation running
    h.runtime.suspendEntities(["head", "player-sheet"]);
    h.bus.emit("inventory.unequip", { actorId: "player", slot: "helm" });
    h.tick(120);
    expect(h.lastLook("head")).toMatchObject({ parts: [], groups: [] }); // the sheet's authority was suspended: nothing changed
    h.runtime.resumeEntities(["player-sheet"]);
    h.bus.emit("inventory.unequip", { actorId: "player", slot: "helm" });
    h.tick(120);
    expect(h.lastLook("head")).toMatchObject({ parts: ["F_HeadFace"] });
    h.runtime.dispose();
  });
});
