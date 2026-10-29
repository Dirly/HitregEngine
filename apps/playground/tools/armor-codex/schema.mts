/**
 * The armor set BRIEF: one file per set (projects/<p>/authoring/armor-sets/<id>.json) that the whole
 * `armor` pipeline reads — prompts, imports, bakes, items and the review sheet all come from it.
 * Every field carries `.describe()`: `armor brief schema` prints the JSON Schema (the self-describing contract).
 */
import { z } from "zod";

export const WEIGHTS = ["cloth", "leather", "mail", "plate"] as const;
export const TIER_RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type TierRarity = (typeof TIER_RARITIES)[number];
/** Ornaments mark rarity (docs/armor-sets.md): `Ornate*` / `ChestHalo` only from rare up. */
export const ORNATE_FROM: TierRarity = "rare";
export const ornateAllowed = (r: TierRarity): boolean => TIER_RARITIES.indexOf(r) >= TIER_RARITIES.indexOf(ORNATE_FROM);

export const HELM_BASES = ["Helm1_Base", "Helm2_Base", "Helm3_base", "HeadBand1", "Hood", "FacecoverTotal", "Bandana", "Crown"] as const;
export const HELM_ORNATE = ["OrnateSide", "OrnateTop", "OrnateTop2"] as const;
export const SHOULDER_BASES = ["ShoulderBase1", "ShoulderBase2", "ShoulderBase3", "ShoulderBase4"] as const;
export const SHOULDER_ORNATE = ["Ornate", "Ornate2"] as const;
export const SLOTS = ["helm", "shoulders", "chest", "gloves", "legs", "boots"] as const;
export type Slot = (typeof SLOTS)[number];

const hex = z.string().regex(/^#[0-9a-f]{6}$/, "a lower-case #rrggbb key colour");
const matchPair = z
  .object({
    from: z.array(hex).min(1).describe("Body key colours (tools/atlas/sets/human-body/key.png) where the material is right, e.g. chest + arms."),
    to: z.array(hex).min(1).describe("Key colours of the helm/shoulder slots made ENTIRELY of that material (their own key)."),
  })
  .describe("One match-material pass: the `to` slots take the measured tone of the body's `from` regions.");
export type MatchPair = z.infer<typeof matchPair>;

export const armorBriefSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).describe("Set id = theme id on every sheet (mmo/human-body-<id>.png …) and the tag on every item."),
    name: z.string().min(1).describe('Display name, the first words of every item name ("Wrackmoor Binder").'),
    weight: z.enum(WEIGHTS).describe("Armor weight class: decides the armor numbers, the slot nouns and the default material matches."),
    subject: z
      .string()
      .min(60)
      .describe(
        "The SUBJECT paragraph: what the outfit is, piece by piece (chest, arms, trousers, boots, gloves, robe, tasset, belt). Reused WORD FOR WORD in the body, female, helm and shoulder prompts: consistency comes from the words.",
      ),
    materials: z.string().min(1).describe("The materials, one line (appended to the SUBJECT as `Materials:`)."),
    palette: z.string().min(1).describe("Four or five muted tones the whole set is painted in (`Palette:`)."),
    trim: z.string().default("").describe("Trim, rivets, stitching and wear shared by every piece (`Trim:`); empty = said in the subject."),
    backOrnament: z.string().min(1).describe("The thin cut-out iron object behind the shoulders (`The back ornament:`), shown on ornate tiers as ChestHalo."),
    levelBand: z.tuple([z.number().int().min(1), z.number().int().min(1)]).describe("Character levels the set drops for, [min, max]; sets the gear-tier line of the prompt and the item numbers."),
    tierNote: z.string().optional().describe('Overrides the gear-tier line the level band writes ("This is LOW-LEVEL gear ...").'),
    tiers: z
      .array(
        z.object({
          rarity: z.enum(TIER_RARITIES).describe("Item rarity of this tier."),
          ornate: z.boolean().default(false).describe("Add the ornaments (Ornate* on helm/shoulders, ChestHalo on the chest). Only allowed from rare up."),
        }),
      )
      .min(1)
      .describe("Rarity tiers to emit: one item per slot per tier."),
    helm: z
      .object({
        base: z.enum(HELM_BASES).describe("THE one base piece of the helm item (a helm, the hood, a headband, the face cover, a bandana, a crown)."),
        extras: z.array(z.string().min(1)).default([]).describe("Optional pieces with it: nose guard, flared neck guard (Helm1_Flair), mouth plate (Helm*_NoBeard), a hood under a helm, a crown."),
        ornate: z.array(z.enum(HELM_ORNATE)).default(["OrnateTop"]).describe("Ornaments added on ornate tiers."),
        look: z.string().min(1).describe("What the headgear is made of, one line, appended to the SUBJECT as `HEADGEAR:` on the helm prompt."),
      })
      .describe("The helm item and its sheet's headgear line."),
    shoulders: z
      .object({
        base: z.enum(SHOULDER_BASES).describe("The pad (one of four bases)."),
        rim: z.enum(["Rim1", "PlanerRim"]).optional().describe("Optional raised rim plate (Rim1) or rim fringe planes (PlanerRim)."),
        accent: z.enum(["Accent1", "PlanerAccent"]).optional().describe("Optional leaning accent plate (Accent1) or its fringe planes (PlanerAccent)."),
        ornate: z.array(z.enum(SHOULDER_ORNATE)).default(["Ornate"]).describe("Plume ornaments added on ornate tiers."),
        look: z.string().min(1).describe("What the pads are made of, one line, appended to the SUBJECT as `SHOULDERS:` on the shoulder prompt."),
      })
      .describe("The shoulders item and its sheet's line."),
    legs: z
      .enum(["robe", "tasset", "robe-tasset", "plain"])
      .default("tasset")
      .describe("Legs item extras: robe (RobesFront+Back), tasset (TassetFront+Back), robe-tasset (robe + front tasset), plain (trousers and belt only)."),
    chestHalo: z.boolean().default(true).describe("Ornate tiers' chest carries the back ornament (ChestHalo)."),
    skin: z
      .array(z.string().min(1))
      .default([])
      .describe("MALE body part names whose painted texels are bare skin (fingerless gloves: HumanMale_HandFront): the creator option's `skin` list."),
    match: z
      .object({ helm: z.array(matchPair).optional(), shoulder: z.array(matchPair).optional() })
      .default({})
      .describe("match-material passes run after import (docs/armor-sets.md, Matching materials). Absent = the weight class default (hood and soft pad from chest+arms; a plate set's from the trousers)."),
    names: z.partialRecord(z.enum(SLOTS), z.string().min(1)).default({}).describe("Item names per slot; absent = `<name> <slot noun of the weight class>`."),
    tags: z.array(z.string().min(1)).default([]).describe("Extra item tags (the set id and `armor` are always added)."),
    source: z
      .object({
        kind: z.enum(["dungeon", "zone", "vendor", "quest", "starter", "other"]).describe("Where the set drops or is sold."),
        id: z.string().default("").describe("Dungeon / zone / vendor id, as its project spells it."),
        note: z.string().default("").describe("Free text: which boss, which quest."),
      })
      .describe("Drop source, for loot tables (recorded in the brief and the ledger)."),
    existingArt: z.boolean().default(false).describe("The sheets were generated before this brief: gen skips every target that exists (the prompts it would send are still the brief's)."),
  })
  .describe("An armor set brief: matching body, helm and shoulder sheets for both sexes and the items cut from them (docs/armor-sets.md).");

export type ArmorBrief = z.infer<typeof armorBriefSchema>;
export type ArmorBriefInput = z.input<typeof armorBriefSchema>;

/** Key colours (tools/atlas/sets/<set>/manifest.json) the default matches use. */
export const KEY = {
  body: { chestFront: "#ff0000", chestBack: "#a80000", armsFront: "#f800ff", armsBack: "#760079", pantsFront: "#1f00ff", pantsBack: "#11008a", ornament: "#ff8b8b" },
  helm: { hood: "#6a00c0", hoodBack: "#400080" },
  shoulder: { base4: "#6a00c0" },
} as const;

export function defaultMatch(weight: ArmorBrief["weight"]): { helm: MatchPair[]; shoulder: MatchPair[] } {
  const b = KEY.body;
  const torso = [b.chestFront, b.chestBack, b.armsFront, b.armsBack];
  // a plate set's soft material (the hood, the quilted pad) is its trousers' hide or cloth, not the plates
  const soft = weight === "plate" ? [b.pantsFront, b.pantsBack] : torso;
  return { helm: [{ from: soft, to: [KEY.helm.hood, KEY.helm.hoodBack] }], shoulder: [{ from: soft, to: [KEY.shoulder.base4] }] };
}
export const matchesOf = (b: ArmorBrief): { helm: MatchPair[]; shoulder: MatchPair[] } => {
  const d = defaultMatch(b.weight);
  return { helm: b.match.helm ?? d.helm, shoulder: b.match.shoulder ?? d.shoulder };
};

export const SLOT_NOUN: Record<ArmorBrief["weight"], Record<Slot, string>> = {
  cloth: { helm: "Hood", shoulders: "Mantle", chest: "Coat", gloves: "Wraps", legs: "Breeches", boots: "Shoes" },
  leather: { helm: "Cap", shoulders: "Pauldrons", chest: "Jerkin", gloves: "Gloves", legs: "Leggings", boots: "Boots" },
  mail: { helm: "Coif", shoulders: "Mantle", chest: "Hauberk", gloves: "Mitts", legs: "Chausses", boots: "Boots" },
  plate: { helm: "Helm", shoulders: "Pauldrons", chest: "Breastplate", gloves: "Gauntlets", legs: "Greaves", boots: "Sabatons" },
};

/** A fresh brief to fill in (`armor brief new`): valid against the schema, every text a TODO (brief lint refuses TODOs). */
export function briefTemplate(id: string): ArmorBriefInput {
  return {
    id,
    name: id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    weight: "cloth",
    subject: "TODO: what the outfit is, piece by piece: chest and arms, trousers, boots, gloves, the robe panels, the tasset, the belt and buckle. One paragraph.",
    materials: "TODO",
    palette: "TODO: four or five muted tones",
    trim: "",
    backOrnament: "TODO: one thin cut-out iron object",
    levelBand: [1, 10],
    tiers: [{ rarity: "common", ornate: false }, { rarity: "rare", ornate: true }],
    helm: { base: "Hood", extras: [], ornate: ["OrnateTop"], look: "TODO: the headgear's materials" },
    shoulders: { base: "ShoulderBase4", ornate: ["Ornate"], look: "TODO: the pads' materials" },
    legs: "tasset",
    chestHalo: true,
    skin: [],
    names: {},
    tags: [],
    source: { kind: "other", id: "", note: "" },
  };
}
