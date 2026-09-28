import { describe, expect, it } from "vitest";
import {
  AssetLibrary,
  applyBuild,
  bodyModelOf,
  birthAbilities,
  characterCreationSchema,
  characterSheetSchema,
  createSheet,
  defaultBuild,
  findCreation,
  settleTraits,
  traitsFor,
  registerCoreAssetTypes,
  settleAppearance,
  validateBuild,
} from "../src/index.js";

const rules = characterCreationSchema.parse({
  model: "human.glb",
  archetypes: [
    { id: "brawn", name: "Brawn", attributes: { strength: 2, constitution: 1 } },
    { id: "cunning", name: "Cunning", attributes: { dexterity: 2 } },
    { id: "wise", name: "Wise", attributes: { wisdom: 2, intelligence: 1 } },
  ],
  traits: [
    { id: "emberborn", name: "Emberborn", ability: "firebolt" },
    { id: "frostborn", name: "Frostborn", ability: "frostNova" },
  ],
  appearance: [
    {
      id: "sex",
      label: "Sex",
      body: true,
      options: [
        { id: "male", label: "Male" },
        { id: "female", label: "Female", model: "human-f.glb" },
      ],
    },
    { id: "hair", label: "Hair", options: [{ id: "short", label: "Short" }, { id: "long", label: "Long", model: "hair-long.glb", socket: "head" }] },
    {
      id: "beard",
      label: "Beard",
      options: [
        { id: "none", label: "None" },
        { id: "full", label: "Full", requires: { sex: ["male"] } },
      ],
    },
  ],
});

describe("character creation rules", () => {
  it("rejects rules that contradict themselves", () => {
    expect(characterCreationSchema.safeParse({ archetypes: [] }).success).toBe(false);
    expect(
      characterCreationSchema.safeParse({ archetypes: [{ id: "a", name: "A" }, { id: "a", name: "B" }] }).success,
    ).toBe(false);
    expect(characterCreationSchema.safeParse({ archetypes: [{ id: "a", name: "A" }], traitPicks: 1 }).success).toBe(false);
  });

  it("defaults to the first of everything", () => {
    expect(defaultBuild(rules)).toEqual({
      archetype: "brawn",
      traits: ["emberborn"],
      appearance: { sex: "male", hair: "short", beard: "none" },
    });
  });

  it("validates a build and fills slots the player never touched", () => {
    const r = validateBuild(rules, { archetype: "wise", traits: ["frostborn"], appearance: { sex: "female" } });
    expect(r).toEqual({ ok: true, build: { archetype: "wise", traits: ["frostborn"], appearance: { sex: "female", hair: "short", beard: "none" } } });
  });

  it("refuses unknown ids, wrong trait counts and options whose requirements fail", () => {
    const bad = (build: unknown) => {
      const r = validateBuild(rules, build);
      return r.ok ? "" : r.error;
    };
    expect(bad({ archetype: "bard", traits: ["emberborn"] })).toMatch(/unknown archetype/);
    expect(bad({ archetype: "brawn", traits: ["sunborn"] })).toMatch(/unknown birth trait/);
    expect(bad({ archetype: "brawn", traits: [] })).toMatch(/pick 1/);
    expect(bad({ archetype: "brawn", traits: ["emberborn", "emberborn"] })).toMatch(/twice/);
    expect(bad({ archetype: "brawn", traits: ["emberborn"], appearance: { hair: "mullet" } })).toMatch(/unknown hair/);
    expect(bad({ archetype: "brawn", traits: ["emberborn"], appearance: { sex: "female", beard: "full" } })).toMatch(/not available/);
    expect(bad("brawn")).toMatch(/^build:/);
  });

  it("settles a slot whose choice stopped being offered", () => {
    expect(settleAppearance(rules, { sex: "female", beard: "full" }).beard).toBe("none");
    expect(settleAppearance(rules, { sex: "male", beard: "full" }).beard).toBe("full");
  });

  it("applies the archetype lean once and records the build on the sheet", () => {
    const sheet = createSheet();
    const build = defaultBuild(rules);
    const built = applyBuild(sheet, rules, build);
    expect(built.attributes.strength).toBe(sheet.attributes.strength + 2);
    expect(built.attributes.constitution).toBe(sheet.attributes.constitution + 1);
    expect(built.attributes.wisdom).toBe(sheet.attributes.wisdom);
    expect(built.build).toEqual(build);
    expect(applyBuild(built, rules, build)).toBe(built); // never twice
    expect(characterSheetSchema.safeParse(built).success).toBe(true);
  });

  it("names the born abilities and the body model", () => {
    expect(birthAbilities(rules, { traits: ["frostborn"] })).toEqual(["frostNova"]);
    expect(bodyModelOf(rules, { appearance: { sex: "male" } })).toBe("human.glb");
    expect(bodyModelOf(rules, { appearance: { sex: "female" } })).toBe("human-f.glb");
  });

  it("offers each archetype its own birth traits and swaps them when the archetype changes", () => {
    const per = characterCreationSchema.parse({
      archetypes: [{ id: "brawn", name: "Brawn" }, { id: "wise", name: "Wise" }],
      traits: [
        { id: "ironhide", name: "Ironhide", ability: "ironhide", archetypes: ["brawn"] },
        { id: "bullborn", name: "Bull-born", ability: "bullrush", archetypes: ["brawn"] },
        { id: "emberborn", name: "Emberborn", ability: "firebolt", archetypes: ["wise"] },
        { id: "lucky", name: "Lucky", ability: "luck" },
      ],
    });
    expect(traitsFor(per, "brawn").map((t) => t.id)).toEqual(["ironhide", "bullborn", "lucky"]);
    expect(traitsFor(per, "wise").map((t) => t.id)).toEqual(["emberborn", "lucky"]);
    expect(defaultBuild(per).traits).toEqual(["ironhide"]);
    expect(settleTraits(per, "wise", ["ironhide"])).toEqual(["emberborn"]);
    expect(settleTraits(per, "wise", ["lucky"])).toEqual(["lucky"]);
    const r = validateBuild(per, { archetype: "wise", traits: ["ironhide"] });
    expect(r.ok ? "" : r.error).toMatch(/not a birth trait of that archetype/);
    expect(validateBuild(per, { archetype: "wise", traits: ["emberborn"] }).ok).toBe(true);
    expect(
      characterCreationSchema.safeParse({ archetypes: [{ id: "a", name: "A" }], traits: [{ id: "t", name: "T", ability: "x", archetypes: ["zzz"] }], traitPicks: 0 }).success,
    ).toBe(false);
  });

  it("keeps colour choices (skin, lips) and drops a lip colour on a body that is not offered one", () => {
    const c = characterCreationSchema.parse({
      archetypes: [{ id: "brawn", name: "Brawn" }],
      traitPicks: 0,
      appearance: [
        { id: "sex", label: "Sex", body: true, options: [{ id: "male", label: "Male" }, { id: "female", label: "Female" }] },
        { id: "skin", label: "Skin", material: "Skin", options: [{ id: "fair", label: "Fair", color: "#e2b596" }, { id: "umber", label: "Umber", color: "#6a432e" }] },
        { id: "lips", label: "Lips", material: "Lips", options: [{ id: "berry", label: "Berry", color: "#7a2c44", requires: { sex: ["female"] } }] },
      ],
    });
    expect(defaultBuild(c).appearance).toEqual({ sex: "male", skin: "fair" });
    const her = validateBuild(c, { archetype: "brawn", traits: [], appearance: { sex: "female", skin: "umber", lips: "berry" } });
    expect(her.ok && her.build.appearance).toEqual({ sex: "female", skin: "umber", lips: "berry" });
    const him = validateBuild(c, { archetype: "brawn", appearance: { sex: "male", lips: "berry" } });
    expect(him.ok ? "" : him.error).toMatch(/not available/);
    expect(settleAppearance(c, { sex: "male", lips: "berry" })).toEqual({ sex: "male", skin: "fair" });
    expect(characterCreationSchema.safeParse({ archetypes: [{ id: "a", name: "A" }], appearance: [{ id: "skin", label: "Skin", options: [{ id: "x", label: "X", color: "tan" }] }] }).success).toBe(false);
  });

  it("carries a head module's placement, page tile, parts and the body bones it hides", () => {
    const option = {
      id: "m-young",
      label: "Youth",
      model: "mmo/human-head.glb",
      socket: "CC_Base_Head",
      offset: [0, -0.79, 0.2],
      rotationDeg: [-84, -89, -69],
      scale: 0.01,
      texture: "mmo/human-head-m-young.png",
      parts: ["HeadFace", "HeadCrown"],
      hideBones: ["CC_Base_Head"],
    };
    const parsed = characterCreationSchema.parse({
      archetypes: [{ id: "a", name: "A" }],
      traitPicks: 0,
      appearance: [{ id: "face", label: "Face", options: [option] }],
    });
    expect(parsed.appearance[0]!.options[0]).toMatchObject(option);
    expect(
      characterCreationSchema.safeParse({
        archetypes: [{ id: "a", name: "A" }],
        traitPicks: 0,
        appearance: [{ id: "face", label: "Face", options: [{ ...option, scale: 0 }] }],
      }).success,
    ).toBe(false);
  });

  it("is a registered data-asset type and findable by id or as the only one", () => {
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    expect(findCreation(assets)).toBeNull();
    assets.addDataAsset({ id: "game-creation", type: "creation", name: "game-creation", data: rules });
    expect(findCreation(assets)?.archetypes).toHaveLength(3);
    expect(findCreation(assets, "game-creation")).not.toBeNull();
    expect(findCreation(assets, "nope")).toBeNull();
    expect(() => assets.addDataAsset({ id: "broken", type: "creation", name: "broken", data: { archetypes: [] } })).toThrow();
  });
});
