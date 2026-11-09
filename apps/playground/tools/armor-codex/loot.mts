/**
 * Instance LOOT PLANS (`armor loot-plan`): what a dungeon drops, planned from the dungeon itself — its size class,
 * difficulty, level band and its SOURCES (mob groups, named mobs, mini-bosses, the boss, each tied to its creatures and
 * area) — not from a fixed kit shape. EverQuest-style by default: each source drops a short list of NAMED pieces that
 * loosely match the place (a bloodstained tunic off the crypt ghouls, a different-looking piece off the warden), the
 * dungeon as a whole covering all four armour weights. A full SET appears only when a rule in `lootRules` fires and the
 * plan names that rule (a large or hard dungeon; or a zone-spread set across several dungeons).
 *
 * Pure logic, no IO: the CLI (tools/armor.mts) reads the files, the tests call these directly.
 */
import { z } from "zod";
import { WEIGHTS, SLOTS, TIER_RARITIES, LEGS, ornateAllowed, type Weight, type Slot, type TierRarity } from "./schema.mts";

export const SIZE_CLASSES = ["small", "medium", "large"] as const;
export const DIFFICULTIES = ["normal", "hard", "raid"] as const;
export const SOURCE_KINDS = ["trash", "named", "miniboss", "boss"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a lower-case slug");
const range = z.tuple([z.number().int().min(0), z.number().int().min(0)]);

export const lootRulesSchema = z
  .object({
    setSizes: z.array(z.enum(SIZE_CLASSES)).default(["large"]).describe("Dungeon size classes big enough to carry a dungeon SET (its pieces spread over the boss and the named mobs)."),
    setDifficulties: z.array(z.enum(DIFFICULTIES)).default(["hard", "raid"]).describe("Difficulties hard enough to carry a dungeon SET whatever the size."),
    dungeonSetPieces: range.default([4, 6]).describe("A dungeon set's piece count [min, max], all from the boss, mini-bosses and named mobs (never trash)."),
    zoneSetDungeons: z.number().int().min(2).default(2).describe("A zone-spread set needs at least this many of the zone's dungeons to carry pieces of it."),
    zoneSetPiecesPerDungeon: range.default([2, 3]).describe("Pieces of a zone-spread set one dungeon carries [min, max]."),
    piecesPerSource: z
      .object({ trash: range.default([3, 6]), named: range.default([1, 2]), miniboss: range.default([1, 3]), boss: range.default([2, 4]) })
      .default({ trash: [3, 6], named: [1, 2], miniboss: [1, 3], boss: [2, 4] })
      .describe("How many pieces each kind of source drops [min, max]: trash tables are wider, a named drops one or two."),
    minWeightsPerSlot: z.number().int().min(1).default(2).describe("Every armour slot drops in at least this many weights across the dungeon (the dungeon pipeline's loot gate asks the same)."),
    levelBands: z
      .array(z.object({ maxLevel: z.number().int(), cap: z.enum(TIER_RARITIES), bossCap: z.enum(TIER_RARITIES) }))
      .default([{ maxLevel: 10, cap: "uncommon", bossCap: "rare" }, { maxLevel: 20, cap: "rare", bossCap: "rare" }, { maxLevel: 999, cap: "epic", bossCap: "legendary" }])
      .describe("Rarity caps by the dungeon's top level (tools/dungeon-pipeline/thresholds.json loot.levelBands): the boss may drop up to bossCap."),
  })
  .describe("When a dungeon gets a SET instead of loose pieces, and how much each source drops.");
export type LootRules = z.infer<typeof lootRulesSchema>;
export const LOOT_RULES: LootRules = lootRulesSchema.parse({});

export const lootSourceSchema = z
  .object({
    id: slug.describe("Source id (a bestiary group / named / boss id, or `<area>-trash`)."),
    kind: z.enum(SOURCE_KINDS).describe("trash (the packs of an area), named, miniboss or boss."),
    name: z.string().min(1).describe("Display name (\"The Seal-Breakers\", \"Oruth, Voice in the Stone\")."),
    creatures: z.array(z.string().min(1)).min(1).describe("Creature ids (bestiary `creature`/`base`) the drops come off: a drop is tied to a real mob."),
    area: z.string().min(1).describe("Where in the dungeon (or its entrance) the source stands: a real area of the dungeon design."),
    story: z.string().default("").describe("One line: who they are, so piece names can tie to them."),
  })
  .describe("One loot source of a dungeon.");
export type LootSource = z.infer<typeof lootSourceSchema>;

export const lootInputSchema = z
  .object({
    dungeon: slug.describe("Dungeon id, as the zone brief and bestiary spell it."),
    zone: z.string().min(1).describe("Zone id (`<world>/<zone>`)."),
    sizeClass: z.enum(SIZE_CLASSES).describe("Dungeon size class (dungeon-standards: a first dungeon ~23 rooms = medium; a large one about twice that)."),
    difficulty: z.enum(DIFFICULTIES).default("normal").describe("How hard the dungeon is."),
    levelBand: z.tuple([z.number().int().min(1), z.number().int().min(1)]).describe("Levels of its mobs [min, max]."),
    sources: z.array(lootSourceSchema).min(1).describe("Every source that drops loot."),
    zoneDungeons: z.array(slug).default([]).describe("The zone's other dungeons (for zone-spread sets)."),
    note: z.string().default("").describe("Where these facts came from (bestiary file, design doc; FIXTURE when the dungeon is not built)."),
  })
  .describe("What `armor loot-plan` reads about a dungeon (from its data, or a fixture when it is not built).");
export type LootInput = z.infer<typeof lootInputSchema>;

export const lootPieceSchema = z
  .object({
    id: slug.describe("Item id (`<set>-<piece-slug>`): the item file is assets/items/<id>.json."),
    name: z.string().min(1).describe("The piece's own name (\"Blood-soaked Tunic\"): never a kit name + slot noun."),
    slot: z.enum(SLOTS).describe("Equipment slot."),
    weight: z.enum(WEIGHTS).describe("Armour weight: must equal the weight its sheet paints that region / part as."),
    rarity: z.enum(TIER_RARITIES).describe("Rarity (capped by the level band; the boss one band higher)."),
    ornate: z.boolean().default(false).describe("Wear the ornaments (Ornate*, ChestHalo): rare+ only."),
    from: z.array(slug).min(1).describe("Source ids it drops from."),
    sheet: z.string().min(1).describe("Which sheet draws it: a body sheet key of the instance brief, or `helm` / `shoulder`."),
    parts: z.array(z.string().min(1)).default([]).describe("helm/shoulder pieces: the part pick (base + extras / rim + accent), ornaments added by `ornate`; body pieces leave it empty."),
    ornaments: z.array(z.string().min(1)).default([]).describe("helm/shoulder: the ornament parts shown when `ornate`."),
    legs: z.enum(LEGS).optional().describe("legs pieces: robe / tasset / robe-tasset / plain extras."),
    story: z.string().min(1).describe("One line tying the piece to its source (who wore it, why it is here)."),
    set: z.boolean().default(false).describe("Part of the plan's `set` (only when a set rule fired)."),
  })
  .describe("One named piece of the loot plan.");
export type LootPiece = z.infer<typeof lootPieceSchema>;

export const lootPlanSchema = lootInputSchema
  .extend({
    set: z
      .object({
        rule: z.enum(["dungeon-set", "zone-set"]).describe("dungeon-set: the dungeon is large or hard (lootRules.setSizes / setDifficulties); zone-set: pieces spread over several dungeons of the zone."),
        name: z.string().min(1).describe("The set's name."),
        dungeons: z.array(slug).default([]).describe("zone-set: every dungeon carrying pieces of it."),
      })
      .nullable()
      .default(null)
      .describe("null = loose pieces (the default). A set appears ONLY when its rule fires; the plan names the rule."),
    pieces: z.array(lootPieceSchema).min(1).describe("Every named piece the dungeon drops."),
  })
  .describe("A dungeon's armour loot plan: named pieces per source, the instance sheets they are drawn from.");
export type LootPlan = z.infer<typeof lootPlanSchema>;

/** Which set rule (if any) the dungeon earns. */
export function setRuleFires(p: Pick<LootInput, "sizeClass" | "difficulty" | "zoneDungeons">, rule: "dungeon-set" | "zone-set", r: LootRules = LOOT_RULES, zoneSetDungeons: string[] = []): boolean {
  if (rule === "dungeon-set") return r.setSizes.includes(p.sizeClass) || r.setDifficulties.includes(p.difficulty);
  return zoneSetDungeons.length >= r.zoneSetDungeons;
}

export function rarityCap(levelTop: number, boss: boolean, r: LootRules = LOOT_RULES): TierRarity {
  const band = r.levelBands.find((b) => levelTop <= b.maxLevel) ?? r.levelBands[r.levelBands.length - 1]!;
  return boss ? band.bossCap : band.cap;
}

/** The plan's look key: two pieces with the same key look the same on a character. */
export const lookKey = (p: LootPiece): string => `${p.sheet}|${p.slot}|${p.parts.slice().sort().join("+")}|${p.legs ?? ""}|${p.ornate ? p.ornaments.slice().sort().join("+") : ""}`;

/** What lint needs from the instance brief: which weight each sheet region / part is painted as. */
export interface SheetWeights { bodies: Record<string, Record<"chest" | "legs" | "gloves" | "boots", Weight>>; helm: Record<string, Weight>; shoulder: Record<string, Weight> }

/** Plan lint: problems block items; warnings print. */
export function lootPlanLint(plan: LootPlan, sheets: SheetWeights, r: LootRules = LOOT_RULES): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const src = new Map(plan.sources.map((s) => [s.id, s]));
  const rank = (x: TierRarity) => TIER_RARITIES.indexOf(x);
  for (const p of plan.pieces) {
    if (/\bTODO\b/.test(`${p.name} ${p.story} ${p.sheet}`)) problems.push(`${p.id}: still a TODO`);
    for (const f of p.from) if (!src.has(f)) problems.push(`${p.id}: from "${f}", which is not a source of the plan`);
    const boss = p.from.some((f) => src.get(f)?.kind === "boss");
    const cap = rarityCap(plan.levelBand[1], boss, r);
    if (rank(p.rarity) > rank(cap)) problems.push(`${p.id}: ${p.rarity} is above the level-${plan.levelBand[1]} cap (${cap}${boss ? ", boss" : ""})`);
    if (p.ornate && !ornateAllowed(p.rarity)) problems.push(`${p.id}: ornate on a ${p.rarity} piece (ornaments rare+ only)`);
    if (p.parts.some((x) => /^Ornate/.test(x))) problems.push(`${p.id}: an ornament in parts (put it in ornaments, shown when ornate)`);
    // the piece's weight is what its sheet paints there
    if (p.slot === "helm" || p.slot === "shoulders") {
      const want = p.slot === "helm" ? "helm" : "shoulder";
      if (p.sheet !== want) problems.push(`${p.id}: a ${p.slot} piece is drawn from the ${want} sheet, not "${p.sheet}"`);
      if (!p.parts.length) problems.push(`${p.id}: no parts`);
      const paint = p.slot === "helm" ? sheets.helm : sheets.shoulder;
      const base = p.parts[0];
      if (base && paint[base] && paint[base] !== p.weight) problems.push(`${p.id}: ${p.weight}, but the ${want} sheet paints ${base} as ${paint[base]}`);
      if (base && !paint[base]) problems.push(`${p.id}: ${base} has no weight in the brief's ${want}Paint`);
    } else {
      const body = sheets.bodies[p.sheet];
      if (!body) problems.push(`${p.id}: sheet "${p.sheet}" is not a body sheet of the instance brief (${Object.keys(sheets.bodies).join(", ")})`);
      else if (body[p.slot as "chest"] !== p.weight) problems.push(`${p.id}: ${p.weight}, but body sheet ${p.sheet} paints the ${p.slot} as ${body[p.slot as "chest"]}`);
      if (p.parts.length) problems.push(`${p.id}: body pieces take their parts from the slot (leave parts empty)`);
    }
  }
  // no two pieces in the dungeon with the same look
  const seen = new Map<string, string>();
  for (const p of plan.pieces) {
    const k = lookKey(p);
    if (seen.has(k)) problems.push(`${p.id} looks the same as ${seen.get(k)} (same sheet, slot and parts): pick other parts, another sheet or legs extras`);
    else seen.set(k, p.id);
  }
  const ids = plan.pieces.map((p) => p.id);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) problems.push(`piece id ${id} used twice`);
  // coverage: all four weights, every slot in 2+ weights
  for (const w of WEIGHTS) if (!plan.pieces.some((p) => p.weight === w)) problems.push(`no ${w} piece drops here: a ${w} wearer has no reason to come`);
  for (const s of SLOTS) {
    const ws = new Set(plan.pieces.filter((p) => p.slot === s).map((p) => p.weight));
    if (ws.size < r.minWeightsPerSlot) problems.push(`${s}: drops in ${ws.size ? [...ws].join(", ") : "no"} weight(s), want ${r.minWeightsPerSlot}+`);
  }
  // every source tied to a real mob and area, and dropping its share
  for (const s of plan.sources) {
    const n = plan.pieces.filter((p) => p.from.includes(s.id)).length;
    const [lo, hi] = r.piecesPerSource[s.kind];
    if (n < lo || n > hi) problems.push(`source ${s.id} (${s.kind}) drops ${n} piece(s), want ${lo}-${hi}`);
  }
  // a set only when its rule fires
  const setPieces = plan.pieces.filter((p) => p.set);
  if (!plan.set && setPieces.length) problems.push(`${setPieces.map((p) => p.id).join(", ")} marked set, but the plan has no set`);
  if (plan.set) {
    if (!setRuleFires(plan, plan.set.rule, r, plan.set.dungeons))
      problems.push(plan.set.rule === "dungeon-set" ? `a dungeon set needs a ${r.setSizes.join("/")} or ${r.setDifficulties.join("/")} dungeon; this one is ${plan.sizeClass}, ${plan.difficulty}` : `a zone set needs ${r.zoneSetDungeons}+ dungeons carrying it, has ${plan.set.dungeons.length}`);
    const [lo, hi] = plan.set.rule === "dungeon-set" ? r.dungeonSetPieces : r.zoneSetPiecesPerDungeon;
    if (setPieces.length < lo || setPieces.length > hi) problems.push(`the ${plan.set.rule} carries ${setPieces.length} piece(s) here, want ${lo}-${hi}`);
    if (plan.set.rule === "dungeon-set") for (const p of setPieces) if (p.from.some((f) => src.get(f)?.kind === "trash")) problems.push(`${p.id}: set pieces come off the boss and named mobs, not trash`);
  }
  if (!plan.sources.some((s) => s.kind === "boss")) warnings.push("no boss source");
  return { problems, warnings };
}

/**
 * The plan skeleton `armor loot-plan` writes for a dungeon: per source, its share of pieces with slot / weight /
 * rarity / sheet assigned so the dungeon covers every slot in two weights and all four weights, names and stories
 * left as TODO for the author (lint refuses TODOs). Deterministic: the same input writes the same skeleton.
 */
export function planSkeleton(input: LootInput, setId: string, sheets: SheetWeights, r: LootRules = LOOT_RULES): LootPlan {
  // what the sheets can draw: per slot, the weights some sheet paints there (helm/shoulder: by base part)
  const BASE = { helm: ["Helm1_Base", "Helm2_Base", "Helm3_base", "Hood", "FacecoverTotal", "Crown", "HeadBand1", "Bandana"], shoulders: ["ShoulderBase1", "ShoulderBase2", "ShoulderBase3", "ShoulderBase4"] };
  const can = (slot: Slot): Weight[] =>
    WEIGHTS.filter((w) =>
      slot === "helm" || slot === "shoulders"
        ? BASE[slot].some((p) => (slot === "helm" ? sheets.helm : sheets.shoulder)[p] === w)
        : Object.values(sheets.bodies).some((b) => b[slot as "chest"] === w),
    );
  // every slot in minWeightsPerSlot weights, rotated by slot so all four weights come up
  const wants: { slot: Slot; weight: Weight }[] = SLOTS.flatMap((slot, i) => {
    const ws = can(slot);
    const rot = ws.map((_, k) => ws[(i + k) % ws.length]!);
    return rot.slice(0, Math.max(r.minWeightsPerSlot, 1)).map((weight) => ({ slot, weight }));
  });
  // each source's share: its minimum, trash a little more; then top up until every want is dealt out
  const order = [...input.sources].sort((a, b) => SOURCE_KINDS.indexOf(a.kind) - SOURCE_KINDS.indexOf(b.kind));
  const share = new Map(order.map((s) => [s.id, Math.max(r.piecesPerSource[s.kind][0], s.kind === "trash" ? Math.min(4, r.piecesPerSource.trash[1]) : 0)]));
  for (let total = () => [...share.values()].reduce((a, b) => a + b, 0), guard = 0; total() < wants.length && guard < 100; guard++) {
    const s = order.find((x) => share.get(x.id)! < r.piecesPerSource[x.kind][1] && x.kind === "trash") ?? order.find((x) => share.get(x.id)! < r.piecesPerSource[x.kind][1]);
    if (!s) break;
    share.set(s.id, share.get(s.id)! + 1);
  }
  const usedHelm = new Set<string>(), usedSh = new Set<string>();
  const pieces: LootPiece[] = [];
  let w = 0;
  for (const s of order) {
    for (let k = 0; k < share.get(s.id)!; k++) {
      const want = wants[w++ % wants.length]!;
      const boss = s.kind === "boss";
      const rarity = boss ? rarityCap(input.levelBand[1], true, r) : s.kind === "trash" ? "common" : rarityCap(input.levelBand[1], false, r);
      const helmOrSh = want.slot === "helm" || want.slot === "shoulders";
      const paint = want.slot === "helm" ? sheets.helm : sheets.shoulder;
      const used = want.slot === "helm" ? usedHelm : usedSh;
      const base = helmOrSh ? BASE[want.slot as "helm"].find((p) => paint[p] === want.weight && !used.has(p)) : undefined;
      if (base) used.add(base);
      const body = Object.entries(sheets.bodies).find(([, b]) => b[want.slot as "chest"] === want.weight)?.[0];
      pieces.push({
        id: `${setId}-${s.id}-${want.slot}-${k + 1}`,
        name: "TODO",
        slot: want.slot,
        weight: want.weight,
        rarity,
        ornate: false,
        from: [s.id],
        sheet: want.slot === "helm" ? "helm" : want.slot === "shoulders" ? "shoulder" : body ?? "TODO",
        parts: base ? [base] : [],
        ornaments: [],
        ...(want.slot === "legs" ? { legs: "tasset" as const } : {}),
        story: "TODO",
        set: false,
      });
    }
  }
  return lootPlanSchema.parse({ ...input, set: null, pieces });
}
