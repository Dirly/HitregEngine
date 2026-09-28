import { describe, expect, it } from "vitest";
import {
  archetypeStartingItems,
  buildAppearance,
  characterCreationSchema,
  composeModelLook,
  dressCharacter,
  mountFor,
  partRulesSchema,
  placementOf,
  remapPart,
  remapSheet,
  validateBuild,
} from "../src/index.js";

const BODY = "body.glb";
const HEAD = "head.glb";
const HAIR = "hair.glb";
const HELM = "helm.glb";
const PAD = "pad.glb";

const femaleRemap = {
  parts: { Belt: "F_Belt", Buckle: "F_Buckle" },
  prefixes: { HumanMale_: "HumanFemale_", Human_Legs: "HumanFemale_Legs" },
  sheetSuffix: "-f",
};

const creation = characterCreationSchema.parse({
  model: BODY,
  traitPicks: 0,
  archetypes: [
    { id: "brawn", name: "Brawn", startingItems: [{ itemId: "vanguard-chest", equip: true }] },
    { id: "wise", name: "Wise" },
  ],
  appearance: [
    {
      id: "sex",
      label: "Sex",
      body: true,
      options: [
        { id: "male", label: "Male", model: BODY, texture: "base.png", parts: ["HumanMale_ChestFront", "Human_LegsFront"], skin: true },
        {
          id: "female",
          label: "Female",
          model: BODY,
          scale: 0.96,
          texture: "base-f.png",
          parts: ["HumanFemale_ChestFront", "HumanFemale_LegsFront"],
          skin: true,
          remap: femaleRemap,
        },
      ],
    },
    { id: "skin", label: "Skin", material: "Skin", options: [{ id: "tan", label: "Tan", color: "#a2704a" }, { id: "ebony", label: "Ebony", color: "#482c20" }] },
    {
      id: "face",
      label: "Face",
      options: [
        { id: "m1", label: "M1", model: HEAD, texture: "head-m1.png", parts: ["HeadFace"], requires: { sex: ["male"] }, skin: true },
        { id: "f1", label: "F1", model: HEAD, texture: "head-f1.png", parts: ["F_HeadFace"], requires: { sex: ["female"] }, skin: true },
      ],
    },
    { id: "hair", label: "Hair", options: [{ id: "short", label: "Short", model: HAIR, parts: ["HairShort"] }, { id: "bald", label: "Bald" }] },
    { id: "hair-colour", label: "Hair colour", tintModels: [HAIR], options: [{ id: "red", label: "Red", color: "#7c3b22" }] },
    {
      id: "outfit",
      label: "Outfit (preview)",
      preview: true,
      options: [{ id: "none", label: "None" }, { id: "plate", label: "Plate", model: BODY, texture: "plate.png", parts: ["HumanMale_ChestFront"] }],
    },
  ],
  mounts: [
    { model: HEAD, socket: "Head", offset: [0, 1, 0], scale: 0.01 },
    { model: HAIR, socket: "Head", offset: [0, 1, 0], scale: 0.01 },
    { model: HELM, socket: "Head", offset: [0, 1, 0], scale: 0.01 },
    {
      model: PAD,
      socket: "L_Clavicle",
      offset: [0.7, 0.3, 0],
      scale: 0.0104,
      requires: { sex: ["male"] },
      mirrorTo: { socket: "R_Clavicle", offset: [-0.7, 0.3, 0], rotationDeg: [0, 0, 0] },
    },
    { model: PAD, socket: "L_Clavicle", offset: [0.68, 0.28, 0], scale: 0.01 },
  ],
});

const helmRules = partRulesSchema.parse({ hides: { Helm: ["HairShort"], Visor: ["HeadFace", "F_HeadFace"] } });

describe("sex remap", () => {
  it("maps part names by exact name, then the longest prefix", () => {
    expect(remapPart("Belt", femaleRemap as never)).toBe("F_Belt");
    expect(remapPart("HumanMale_ChestFront", femaleRemap as never)).toBe("HumanFemale_ChestFront");
    expect(remapPart("Human_LegsBack", femaleRemap as never)).toBe("HumanFemale_LegsBack");
    expect(remapPart("RobesFront", femaleRemap as never)).toBe("RobesFront");
    expect(remapPart("HumanFemale_Foot", femaleRemap as never)).toBe("HumanFemale_Foot");
  });

  it("uses the -f sheet only when the page has it", () => {
    const sheets = new Set(["mmo/v.png", "mmo/v-f.png", "mmo/r.png"]);
    expect(remapSheet("mmo/v.png", femaleRemap as never, sheets)).toBe("mmo/v-f.png");
    expect(remapSheet("mmo/r.png", femaleRemap as never, sheets)).toBe("mmo/r.png");
    expect(remapSheet("mmo/v.png", femaleRemap as never, null)).toBe("mmo/v.png");
    expect(remapSheet(null, femaleRemap as never, sheets)).toBeNull();
  });

  it("composes items written for the man onto the woman's parts and sheets", () => {
    const look = composeModelLook(
      [{ model: BODY, parts: ["HumanMale_ChestFront", "Belt"], texture: "v.png" }],
      BODY,
      { remap: femaleRemap as never, sheets: new Set(["v.png", "v-f.png"]) },
    );
    expect(look).toEqual({ parts: ["HumanFemale_ChestFront", "F_Belt"], groups: [{ parts: ["HumanFemale_ChestFront", "F_Belt"], texture: "v-f.png" }] });
  });
});

describe("preview rows", () => {
  it("are never saved into a build, and never drawn from an old build that saved one", () => {
    const v = validateBuild(creation, { archetype: "brawn", traits: [], appearance: { sex: "male", outfit: "plate" } });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.build.appearance.outfit).toBeUndefined();
    expect(v.build.appearance.sex).toBe("male");
    expect(buildAppearance(creation, { appearance: { outfit: "plate" } }).outfit).toBeUndefined();
    const dressed = dressCharacter({ creation, appearance: { sex: "male", outfit: "plate" }, items: [] });
    expect(dressed.models.get(BODY)!.groups).toEqual([{ parts: ["HumanMale_ChestFront", "Human_LegsFront"], texture: "base.png" }]);
  });
});

describe("mounts", () => {
  it("place a model per wearer: the first mount whose requires holds", () => {
    expect(mountFor(creation, PAD, { sex: "male" })?.scale).toBe(0.0104);
    expect(mountFor(creation, PAD, { sex: "male" })?.mirrorTo?.socket).toBe("R_Clavicle");
    expect(mountFor(creation, PAD, { sex: "female" })?.offset).toEqual([0.68, 0.28, 0]);
    expect(mountFor(creation, "nothing.glb", {})).toBeNull();
  });

  it("an option with no socket of its own takes its model's mount; one naming the body dresses it", () => {
    const face = creation.appearance.find((s) => s.id === "face")!.options[0]!;
    expect(placementOf(creation, face, { sex: "male" })?.socket).toBe("Head");
    const plate = creation.appearance.find((s) => s.id === "outfit")!.options[1]!;
    expect(placementOf(creation, plate, { sex: "male" })).toBeNull();
  });
});

describe("dressCharacter", () => {
  it("draws the unequipped layer under equipped items, with the skin tone and the hair colour", () => {
    const dressed = dressCharacter({
      creation,
      appearance: { sex: "male", skin: "ebony", face: "m1", hair: "short", "hair-colour": "red" },
      items: [{ model: BODY, parts: ["HumanMale_ChestFront"], texture: "vanguard.png" }],
    });
    expect(dressed.body).toBe(BODY);
    expect(dressed.scale).toBe(1);
    const body = dressed.models.get(BODY)!;
    expect(body.groups).toEqual([
      { parts: ["Human_LegsFront"], texture: "base.png" },
      { parts: ["HumanMale_ChestFront"], texture: "vanguard.png" },
    ]);
    expect(body.tint).toBe("#482c20");
    expect(body.skinSheets).toEqual([{ texture: "base.png" }, { texture: "base-f.png" }]);
    const head = dressed.models.get(HEAD)!;
    expect(head.groups).toEqual([{ parts: ["HeadFace"], texture: "head-m1.png" }]);
    expect(head.tint).toBe("#482c20");
    expect(head.mount?.socket).toBe("Head");
    const hair = dressed.models.get(HAIR)!;
    expect(hair).toMatchObject({ parts: ["HairShort"], tint: "#7c3b22", tintWhole: true });
    // a mounted model nobody wears is still listed, empty — its entity hides
    expect(dressed.models.get(PAD)).toMatchObject({ parts: [], groups: [] });
  });

  it("maps a woman's items onto her body and scales her", () => {
    const dressed = dressCharacter({
      creation,
      appearance: { sex: "female", face: "f1" },
      items: [{ model: BODY, parts: ["HumanMale_ChestFront", "Belt"], texture: "vanguard.png" }],
      sheets: () => new Set(["base.png", "base-f.png", "vanguard.png", "vanguard-f.png"]),
    });
    expect(dressed.scale).toBe(0.96);
    expect(dressed.models.get(BODY)!.groups).toEqual([
      { parts: ["HumanFemale_LegsFront"], texture: "base-f.png" },
      { parts: ["HumanFemale_ChestFront", "F_Belt"], texture: "vanguard-f.png" },
    ]);
  });

  it("takes what a worn helm hides off the other models", () => {
    const dressed = dressCharacter({
      creation,
      appearance: { sex: "male", face: "m1", hair: "short" },
      items: [{ model: HELM, parts: ["Helm", "Visor"], texture: "helm-v.png" }],
      rules: (model) => (model === HELM ? helmRules : null),
    });
    expect(dressed.models.get(HAIR)!.parts).toEqual([]);
    expect(dressed.models.get(HEAD)!.parts).toEqual([]);
    expect(dressed.models.get(HEAD)!.groups).toEqual([]);
    expect(dressed.models.get(HELM)!.parts).toEqual(["Helm", "Visor"]);
  });

  it("falls back to the default appearance with no build", () => {
    const dressed = dressCharacter({ creation, appearance: null, items: [] });
    expect(dressed.models.get(HEAD)!.parts).toEqual(["HeadFace"]);
  });
});

describe("archetype starting items", () => {
  it("are listed per archetype", () => {
    expect(archetypeStartingItems(creation, "brawn")).toEqual([{ itemId: "vanguard-chest", qty: 1, equip: true }]);
    expect(archetypeStartingItems(creation, "wise")).toEqual([]);
    expect(archetypeStartingItems(creation, "nobody")).toEqual([]);
  });
});
