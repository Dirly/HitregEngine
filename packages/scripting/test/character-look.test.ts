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
    { model: HEAD, socket: "Head", offset: [0, 2, 0], scale: 0.5, hang: { socket: "Chest" } },
    { model: HELM, socket: "Head", offset: [0, 2, 0], scale: 0.5 },
  ],
};

const tables: Record<string, ModelTables> = {
  [BODY]: { parts: {}, tiles: ["base.png", "base-f.png", "plate.png", "plate-f.png"], rules: null },
  [HEAD]: { parts: {}, tiles: ["head-f1.png"], rules: null },
  [HELM]: { parts: {}, tiles: ["helm.png"], rules: { hides: { Visor: ["F_HeadFace"] } } },
};

function harness(hang: { socket?: string } = { socket: "Chest" }) {
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  const mounts = creation.mounts.map((m) => (m.model === HEAD ? { ...m, hang } : m));
  assets.addDataAsset({ id: "rules", type: "creation", name: "rules", data: { ...creation, mounts } });
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
  // the skinned model: a chest bone 1.2 up, its head bone 0.3 above that (1.5 up)
  const chest = new THREE.Bone();
  chest.name = "Chest";
  chest.position.set(0, 1.2, 0);
  const bone = new THREE.Bone();
  bone.name = "Head";
  bone.position.set(0, 0.3, 0);
  chest.add(bone);
  const skinned = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  skinned.add(chest);
  objects.get("visual")!.add(skinned);
  scene.updateMatrixWorld(true);
  skinned.bind(new THREE.Skeleton([chest, bone]));
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
  return { runtime, bus, tick, lastLook, sheet, objects, chest, head: bone };
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

  it("hands a moving batch the hang placement: a hanging end stays with the chest while the head turns", async () => {
    const h = harness();
    h.tick();
    await new Promise((r) => setTimeout(r, 0));
    const head = h.objects.get("head")!;
    // at the bind pose the two placements agree
    h.runtime.lateUpdate(1 / 60);
    const identity = new THREE.Matrix4().elements;
    (head.userData["hangDelta"] as THREE.Matrix4).elements.forEach((e, i) => expect(e).toBeCloseTo(identity[i]!, 5));
    // a braid tip on the chest, where the socket carries it at rest
    const tip = new THREE.Vector3(0.1, 1.3, 0.2);
    const onHead = h.head.matrixWorld.clone().invert();
    const tipInHead = tip.clone().applyMatrix4(onHead);
    // the head turns 60° and nods: the socket swings the tip through the body, the hang puts it back
    h.head.rotation.set(0.4, Math.PI / 3, 0);
    h.runtime.lateUpdate(1 / 60);
    const swung = tipInHead.clone().applyMatrix4(h.head.matrixWorld);
    expect(swung.distanceTo(tip)).toBeGreaterThan(0.1);
    const hung = swung.applyMatrix4(head.userData["hangDelta"] as THREE.Matrix4);
    expect(hung.distanceTo(tip)).toBeCloseTo(0, 5);
    // the body leans: the tip rides the chest, not the head
    const chestRest = h.chest.matrixWorld.clone();
    h.chest.rotation.set(0.5, 0, 0);
    h.runtime.lateUpdate(1 / 60);
    const tipOnChest = tip.clone().applyMatrix4(chestRest.invert()).applyMatrix4(h.chest.matrixWorld);
    const viaSocket = tipInHead.clone().applyMatrix4(h.head.matrixWorld);
    expect(viaSocket.applyMatrix4(head.userData["hangDelta"] as THREE.Matrix4).distanceTo(tipOnChest)).toBeCloseTo(0, 5);
    h.runtime.dispose();
  });

  it("skips socket upkeep while the animation system holds the pose, and follows a moved parent or a new pose", async () => {
    const h = harness();
    h.tick();
    await new Promise((r) => setTimeout(r, 0));
    const head = h.objects.get("head")!;
    const model = h.chest.parent!;
    model.userData["poseVersion"] = 1;
    h.runtime.lateUpdate(1 / 60);
    const placed = head.quaternion.clone();
    // the bone changes without a new pose version (only a test does this): held, so the piece stays
    h.head.rotation.set(0, Math.PI / 2, 0);
    h.runtime.lateUpdate(1 / 60);
    expect(head.quaternion.angleTo(placed)).toBeCloseTo(0, 6);
    // a new pose: followed
    model.userData["poseVersion"] = 2;
    h.runtime.lateUpdate(1 / 60);
    expect(head.quaternion.angleTo(placed)).toBeGreaterThan(1);
    // the parent moves under a held pose: recomputed in the parent's frame
    const local = head.position.clone();
    const hangBefore = (head.userData["hangDelta"] as THREE.Matrix4).clone();
    h.objects.get("visual")!.position.set(5, 0, 0);
    h.runtime.lateUpdate(1 / 60);
    expect(head.position.distanceTo(local)).toBeCloseTo(0, 6);
    // the world-space hang was recomputed for the moved body, not left behind
    expect((head.userData["hangDelta"] as THREE.Matrix4).equals(hangBefore)).toBe(false);
    h.runtime.dispose();
  });

  it("hangs the ends plumb when the mount names no hang bone: a nod bends them, a hunched chest does not drag them", async () => {
    const h = harness({});
    h.tick();
    await new Promise((r) => setTimeout(r, 0));
    const head = h.objects.get("head")!;
    h.runtime.lateUpdate(1 / 60);
    const identity = new THREE.Matrix4().elements;
    (head.userData["hangDelta"] as THREE.Matrix4).elements.forEach((e, i) => expect(e).toBeCloseTo(identity[i]!, 5));
    const tip = new THREE.Vector3(0.1, 1.3, 0.2);
    const tipInHead = tip.clone().applyMatrix4(h.head.matrixWorld.clone().invert());
    const pivot = h.head.getWorldPosition(new THREE.Vector3());
    // the head nods forward and the chest hunches: the tip keeps its offset below the head's pivot, as modelled
    h.head.rotation.set(0.5, 0, 0);
    h.chest.rotation.set(0.3, 0, 0);
    h.runtime.lateUpdate(1 / 60);
    const pivotNow = h.head.getWorldPosition(new THREE.Vector3());
    const hung = tipInHead.clone().applyMatrix4(h.head.matrixWorld).applyMatrix4(head.userData["hangDelta"] as THREE.Matrix4);
    expect(hung.clone().sub(pivotNow).distanceTo(tip.clone().sub(pivot))).toBeCloseTo(0, 5);
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
