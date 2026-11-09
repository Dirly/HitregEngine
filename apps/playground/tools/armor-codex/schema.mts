/**
 * The armor set BRIEF: one file per set (projects/<p>/authoring/armor-sets/<id>.json) that the whole
 * `armor` pipeline reads — prompts, imports, bakes, items and the review sheet all come from it.
 * Every field carries `.describe()`: `armor brief schema` prints the JSON Schema (the self-describing contract).
 *
 * Two kinds (docs/armor-sets.md):
 * - `kit`: one uniform outfit of one weight (town, faction, vendor gear): one body sheet, one item per body slot per
 *   tier, normally 2-4 named helm pieces and 2-4 shoulder pieces. One multi-tier helm is valid when the look is shared.
 * - `instance`: a DUNGEON's loot (the default for dungeon drops): one theme, 1-2 MIXED body sheets whose regions each
 *   carry an armour weight, ONE helm and ONE shoulder sheet painted part by part in several weights, and named pieces
 *   from a loot plan (`armor loot-plan`, loot.mts) so one instance drops all four weights without four kits.
 */
import { z } from "zod";

export const WEIGHTS = ["cloth", "leather", "mail", "plate"] as const;
export type Weight = (typeof WEIGHTS)[number];
export const TIER_RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;
export type TierRarity = (typeof TIER_RARITIES)[number];
/** Ornaments mark rarity (docs/armor-sets.md): `Ornate*` / `ChestHalo` only from rare up. */
export const ORNATE_FROM: TierRarity = "rare";
export const ornateAllowed = (r: TierRarity): boolean => TIER_RARITIES.indexOf(r) >= TIER_RARITIES.indexOf(ORNATE_FROM);

export const HELM_BASES = ["Helm1_Base", "Helm2_Base", "Helm3_base", "HeadBand1", "Hood", "FacecoverTotal", "Bandana", "Crown", "PeasantCap"] as const;
export const HELM_ORNATE = ["OrnateSide", "OrnateTop", "OrnateTop2"] as const;
export const SHOULDER_BASES = ["ShoulderBase1", "ShoulderBase2", "ShoulderBase3", "ShoulderBase4"] as const;
export const SHOULDER_ORNATE = ["Ornate", "Ornate2"] as const;
export const SLOTS = ["helm", "shoulders", "chest", "gloves", "legs", "boots"] as const;
export type Slot = (typeof SLOTS)[number];
export const BODY_SLOTS = ["chest", "gloves", "legs", "boots"] as const;
export type BodySlot = (typeof BODY_SLOTS)[number];
export const LEGS = ["robe", "tasset", "robe-tasset", "plain"] as const;
export type Legs = (typeof LEGS)[number];

const hex = z.string().regex(/^#[0-9a-f]{6}$/, "a lower-case #rrggbb key colour");
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a lower-case slug");
const matchPair = z
  .object({
    from: z.array(hex).min(1).describe("Body key colours (tools/atlas/sets/human-body/key.png) where the material is right, e.g. chest + arms."),
    to: z.array(hex).min(1).describe("Key colours of the helm/shoulder slots made ENTIRELY of that material (their own key)."),
  })
  .describe("One match-material pass: the `to` slots take the measured tone of the body's `from` regions (an instance set measures its FIRST body sheet).");
export type MatchPair = z.infer<typeof matchPair>;

const pickTiers = z.array(z.enum(TIER_RARITIES)).min(1);
export const helmPick = z
  .object({
    key: slug.describe("Short slug of the piece (coif, nasal-helm): a second piece at a tier gets the id `<set>-helm-<key>-<rarity>`."),
    name: z.string().min(1).describe('The item name of this piece ("Warder\'s Mail Coif", "Warder\'s Nasal Helm").'),
    base: z.enum(HELM_BASES).describe("THE one base piece (a helm, the hood, a headband, the face cover, a bandana, a crown)."),
    texture: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:]+\.png$/).optional().describe("Optional existing native tile on the helm page, for a part whose UVs use its own paint. PeasantCap uses mmo/peasant-cap-cloth.png (or an authored variant); ordinary helm-key parts use the set sheet by default. All parts of this pick must use the selected tile's layout."),
    extras: z.array(z.string().min(1)).default([]).describe("Pieces worn with it: nose guard, flared neck guard (Helm1_Flair), rear skull coverage (Helm1RearCap), mouth plate (Helm*_NoBeard), a hood under a helm, or a bandana. Use HoodCrown over Hood; Crown keeps its bare-head fit."),
    ornate: z.array(z.enum(HELM_ORNATE)).default([]).describe("Ornaments added on this piece's ornate (rare+) tiers."),
    tiers: pickTiers.describe("The set tiers this piece drops at. The FIRST piece listing a tier keeps the plain id `<set>-helm-<rarity>`."),
  })
  .describe("One helm piece of a kit: a full part pick, its tiers and its name.");
export type HelmPick = z.infer<typeof helmPick>;
export const shoulderPick = z
  .object({
    key: slug.describe("Short slug of the piece (mantle, lamed-pauldron)."),
    name: z.string().min(1).describe("The item name of this piece."),
    base: z.enum(SHOULDER_BASES).describe("The pad (one of four bases)."),
    rim: z.enum(["Rim1", "PlanerRim", "CuffRim"]).optional().describe("Optional raised rim plate (Rim1), original crossed fringe cards (PlanerRim), or consistently aligned crossed cuff cards (CuffRim)."),
    accent: z.enum(["Accent1", "PlanerAccent", "CuffAccent"]).optional().describe("Optional leaning accent plate (Accent1), original crossed fringe cards (PlanerAccent), or consistently aligned crossed cuff cards (CuffAccent)."),
    ornate: z.array(z.enum(SHOULDER_ORNATE)).default([]).describe("Plume ornaments added on this piece's ornate (rare+) tiers."),
    tiers: pickTiers.describe("The set tiers this piece drops at. The FIRST piece listing a tier keeps the plain id `<set>-shoulders-<rarity>`."),
  })
  .describe("One shoulder piece of a kit.");
export type ShoulderPick = z.infer<typeof shoulderPick>;

export const bodySheet = z
  .object({
    key: slug.describe("Sheet key: the theme is `<set>-<key>` (mmo/human-body-<set>-<key>.png and its -f copy)."),
    weights: z
      .object({ chest: z.enum(WEIGHTS), legs: z.enum(WEIGHTS), gloves: z.enum(WEIGHTS), boots: z.enum(WEIGHTS) })
      .describe("The armour weight each region of this sheet is painted as: chest (chest + arms), legs (trousers, robe, tasset, belt), gloves, boots."),
    subject: z
      .string()
      .min(60)
      .describe("THIS sheet piece by piece, each region in its weight's material (a plate breastplate, leather trousers, mail mitts, cloth wraps): appended to the instance SUBJECT on this sheet's body and female prompts."),
  })
  .describe("One mixed-weight body sheet of an instance set.");
export type BodySheet = z.infer<typeof bodySheet>;
export const paintLine = z
  .object({
    parts: z.array(z.string().min(1)).min(1).describe("Model part names painted this way (Helm2_Base, Helm2_NoBeard …)."),
    weight: z.enum(WEIGHTS).describe("The armour weight these regions are painted as."),
    look: z.string().min(1).describe("What they are made of, one line."),
  })
  .describe("One per-part weight line of an instance helm or shoulder sheet.");
export type PaintLine = z.infer<typeof paintLine>;

export const armorBriefSchema = z
  .object({
    id: slug.describe("Set id = theme id on every sheet (mmo/human-body-<id>.png …) and the tag on every item."),
    kind: z
      .enum(["kit", "instance"])
      .default("kit")
      .describe("kit = one uniform outfit of one weight (town / faction / vendor gear). instance = a DUNGEON's loot: mixed-weight sheets and named pieces from a loot plan, never four full kits (the default for dungeon loot)."),
    name: z.string().min(1).describe('Display name, the first words of kit item names ("Wrackmoor Binder").'),
    weight: z.enum(WEIGHTS).optional().describe("KIT sets: the armor weight class (armor numbers, slot nouns, default material matches). Instance sets give a weight per region and per piece."),
    subject: z
      .string()
      .min(60)
      .describe(
        "The SUBJECT paragraph: what the outfit is, piece by piece (chest, arms, trousers, boots, gloves, robe, tasset, belt); for an instance, the place's shared theme. Reused WORD FOR WORD in the body, female, helm and shoulder prompts: consistency comes from the words.",
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
      .default([])
      .describe("KIT sets: rarity tiers, one body item per slot per tier (helm and shoulder pieces name their own tiers). Instance sets take rarities from the loot plan."),
    helmLook: z.string().min(1).describe("What the headgear is made of, one line, appended to the SUBJECT as `HEADGEAR:` on the helm prompt. The sheet paints EVERY helm part; an instance also lists each region's weight from `helmPaint`."),
    helms: z
      .array(helmPick)
      .min(1)
      .max(4)
      .optional()
      .describe("KIT sets: 1-4 helm PIECES, usually 2-4; one piece may span multiple tiers when the authored look is shared. Each has a full part pick, tiers and a name. Multiple pieces must differ by >= 25% of their triangles (ornaments not counted). Instance pieces live in the loot plan."),
    shoulderLook: z.string().min(1).describe("What the pads are made of, one line, appended to the SUBJECT as `SHOULDERS:` on the shoulder prompt."),
    shoulders: z
      .array(shoulderPick)
      .min(2)
      .max(4)
      .optional()
      .describe("KIT sets: the 2-4 shoulder PIECES the set ships (base + rim + accent), same distinctness rule as `helms`."),
    bodies: z
      .array(bodySheet)
      .min(1)
      .max(2)
      .optional()
      .describe("INSTANCE sets: the 1-2 MIXED body sheets (each made with its woman's `-f` copy)."),
    helmPaint: z.array(paintLine).optional().describe("INSTANCE sets: the armour weight each helm region is painted as: the per-part weight split of the ONE helm sheet."),
    shoulderPaint: z.array(paintLine).optional().describe("INSTANCE sets: the armour weight each shoulder region is painted as."),
    loot: z.string().optional().describe("INSTANCE sets: the loot plan (relative to authoring/armor-sets/, e.g. `loot/shackle-halls.json`) whose pieces become this set's items."),
    legs: z.enum(LEGS).default("tasset").describe("KIT legs item extras: robe (RobesFront+Back), tasset (TassetFront+Back), robe-tasset (robe + front tasset), plain (trousers and belt only)."),
    chestHalo: z.boolean().default(true).describe("Ornate tiers' chest carries the back ornament (ChestHalo)."),
    bareArms: z.boolean().default(false).describe("Kit chest items cover chest front/back only, leaving the creation body's bare arms visible with its skin tint. Gloves remain independent."),
    reusePartPicks: z.string().trim().min(60).optional().describe("KIT only: explicit art-direction reason for sharing helm/shoulder geometry with other sets (at least 60 characters). For practical civilian wardrobes with distinct painted cuts/materials; avoids inventing armor or ornaments just to vary a cap. Cross-set duplicates become warnings for this kit; within-set distinctness, model rules, rarity and all texture/import gates still apply."),
    skin: z
      .array(z.string().min(1))
      .default([])
      .describe("MALE body part names whose painted texels are bare skin (fingerless gloves: HumanMale_HandFront): the creator option's `skin` list."),
    bodyManifest: z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\:]+\.json$/).optional().describe("Optional import-atlas body manifest, relative to this project's root, for measured garment-specific registration corrections. Used for both male and full female imports; keep the standard body key layout, cutout contract and density. Its bytes participate in import staleness. Omit for the shared manifest."),
    match: z
      .object({ helm: z.array(matchPair).optional(), shoulder: z.array(matchPair).optional() })
      .default({})
      .describe("match-material passes run after import (docs/armor-sets.md, Matching materials). Absent = the weight class default for a kit (hood and soft pad from chest+arms; a plate set's from the trousers), none for an instance (its regions are several materials)."),
    names: z.partialRecord(z.enum(BODY_SLOTS), z.string().min(1)).default({}).describe("KIT body item names per slot; absent = `<name> <slot noun of the weight class>`. Helm and shoulder pieces carry their own names."),
    tags: z.array(z.string().min(1)).default([]).describe("Extra item tags (the set id, `armor` and the item's weight are always added)."),
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

export function defaultMatch(weight: Weight): { helm: MatchPair[]; shoulder: MatchPair[] } {
  const b = KEY.body;
  const torso = [b.chestFront, b.chestBack, b.armsFront, b.armsBack];
  // a plate set's soft material (the hood, the quilted pad) is its trousers' hide or cloth, not the plates
  const soft = weight === "plate" ? [b.pantsFront, b.pantsBack] : torso;
  return { helm: [{ from: soft, to: [KEY.helm.hood, KEY.helm.hoodBack] }], shoulder: [{ from: soft, to: [KEY.shoulder.base4] }] };
}
export const matchesOf = (b: ArmorBrief): { helm: MatchPair[]; shoulder: MatchPair[] } => {
  const d = b.kind === "kit" && b.weight ? defaultMatch(b.weight) : { helm: [], shoulder: [] };
  return { helm: b.match.helm ?? d.helm, shoulder: b.match.shoulder ?? d.shoulder };
};

export const SLOT_NOUN: Record<Weight, Record<Slot, string>> = {
  cloth: { helm: "Hood", shoulders: "Mantle", chest: "Coat", gloves: "Wraps", legs: "Breeches", boots: "Shoes" },
  leather: { helm: "Cap", shoulders: "Pauldrons", chest: "Jerkin", gloves: "Gloves", legs: "Leggings", boots: "Boots" },
  mail: { helm: "Coif", shoulders: "Mantle", chest: "Hauberk", gloves: "Mitts", legs: "Chausses", boots: "Boots" },
  plate: { helm: "Helm", shoulders: "Pauldrons", chest: "Breastplate", gloves: "Gauntlets", legs: "Greaves", boots: "Sabatons" },
};

/** A fresh kit brief to fill in (`armor brief new`): valid against the schema, every text a TODO (brief lint refuses TODOs). */
export function briefTemplate(id: string): ArmorBriefInput {
  return {
    id,
    kind: "kit",
    name: id.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    weight: "cloth",
    subject: "TODO: what the outfit is, piece by piece: chest and arms, trousers, boots, gloves, the robe panels, the tasset, the belt and buckle. One paragraph.",
    materials: "TODO",
    palette: "TODO: four or five muted tones",
    trim: "",
    backOrnament: "TODO: one thin cut-out iron object",
    levelBand: [1, 10],
    tiers: [{ rarity: "common", ornate: false }, { rarity: "rare", ornate: true }],
    helmLook: "TODO: the headgear's materials",
    helms: [
      { key: "hood", name: "TODO Hood", base: "Hood", extras: [], ornate: [], tiers: ["common"] },
      { key: "crowned-hood", name: "TODO Crowned Hood", base: "Hood", extras: ["HoodCrown"], ornate: ["OrnateTop"], tiers: ["rare"] },
    ],
    shoulderLook: "TODO: the pads' materials",
    shoulders: [
      { key: "mantle", name: "TODO Mantle", base: "ShoulderBase4", ornate: [], tiers: ["common"] },
      { key: "pauldrons", name: "TODO Pauldrons", base: "ShoulderBase1", rim: "Rim1", ornate: ["Ornate"], tiers: ["rare"] },
    ],
    legs: "tasset",
    chestHalo: true,
    skin: [],
    names: {},
    tags: [],
    source: { kind: "other", id: "", note: "" },
  };
}
