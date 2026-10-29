/**
 * Pure set logic for `armor` (no IO): part choices per slot and tier, the item documents, brief lint, items lint,
 * the four prompts and the ONE gen-set manifest per set. The CLI (tools/armor.mts) and the tests share it.
 */
import { itemSchema, partProblems, partRulesSchema, type PartRules } from "@hitreg/core";
import { ornateAllowed, matchesOf, SLOT_NOUN, SLOTS, TIER_RARITIES, HELM_ORNATE, SHOULDER_ORNATE, type ArmorBrief, type Slot, type TierRarity } from "./schema.mts";

export const MODEL = { body: "mmo/human-body.glb", helm: "mmo/human-helm.glb", shoulder: "mmo/human-shoulder.glb" } as const;
export const modelOfSlot = (s: Slot): string => (s === "helm" ? MODEL.helm : s === "shoulders" ? MODEL.shoulder : MODEL.body);
/** The theme sheet ids (assets/textures/…) — also the tile keys on each model's page. */
export const sheetIds = (id: string) => ({
  body: `mmo/human-body-${id}.png`,
  bodyF: `mmo/human-body-${id}-f.png`,
  helm: `mmo/human-helm-${id}.png`,
  shoulder: `mmo/human-shoulder-${id}.png`,
});
export const textureOfSlot = (id: string, s: Slot): string => {
  const t = sheetIds(id);
  return s === "helm" ? t.helm : s === "shoulders" ? t.shoulder : t.body;
};

/** One item per slot per tier: `<set>-<slot>-<rarity>`. */
export const itemId = (set: string, slot: Slot, rarity: TierRarity): string => `${set}-${slot}-${rarity}`;
const ORNATE_PARTS = new Set<string>([...HELM_ORNATE, ...SHOULDER_ORNATE, "ChestHalo", "F_ChestHalo"]);
export const isOrnament = (part: string): boolean => ORNATE_PARTS.has(part);

/** The MALE part names an item of `slot` shows at a tier (docs/armor-sets.md → Breaking a set into items). */
export function slotParts(b: ArmorBrief, slot: Slot, ornate: boolean): string[] {
  switch (slot) {
    case "helm":
      return [b.helm.base, ...b.helm.extras, ...(ornate ? b.helm.ornate : [])];
    case "shoulders":
      return [b.shoulders.base, ...(b.shoulders.rim ? [b.shoulders.rim] : []), ...(b.shoulders.accent ? [b.shoulders.accent] : []), ...(ornate ? b.shoulders.ornate : [])];
    case "chest":
      return ["HumanMale_ChestFront", "HumanMale_ChestBack", "HumanMale_ArmOutside", "HumanMale_ArmInside", ...(ornate && b.chestHalo ? ["ChestHalo"] : [])];
    case "gloves":
      return ["HumanMale_HandFront", "HumanMale_HandPalm"];
    case "legs": {
      const extra = { robe: ["RobesFront", "RobesBack"], tasset: ["TassetFront", "TassetBack"], "robe-tasset": ["RobesFront", "RobesBack", "TassetFront"], plain: [] }[b.legs];
      return ["Human_LegsFront", "Human_LegsBack", "Belt", "Buckle", ...extra];
    }
    case "boots":
      return ["HumanMale_Foot"];
  }
}

// ---------------------------------------------------------------- numbers
const SHARE: Record<Slot, number> = { chest: 0.3, legs: 0.22, helm: 0.15, shoulders: 0.13, gloves: 0.1, boots: 0.1 };
const KG: Record<Slot, number> = { chest: 3, legs: 2, helm: 1, shoulders: 1, gloves: 0.5, boots: 1 };
const CLASS = { cloth: { base: 4, per: 0.6, kg: 0.6, dur: 40 }, leather: { base: 6, per: 0.9, kg: 1, dur: 50 }, mail: { base: 9, per: 1.2, kg: 1.8, dur: 60 }, plate: { base: 12, per: 1.5, kg: 2.6, dur: 70 } } as const;
const TIER_MULT: Record<TierRarity, number> = { common: 1, uncommon: 1.15, rare: 1.3, epic: 1.5, legendary: 1.75 };

export interface ArmorItem {
  id: string;
  doc: Record<string, unknown>;
}

/** Every item the brief asks for, schema-shaped (validated by `itemsLint`). */
export function buildItems(b: ArmorBrief): ArmorItem[] {
  const c = CLASS[b.weight];
  const level = Math.round((b.levelBand[0] + b.levelBand[1]) / 2);
  const out: ArmorItem[] = [];
  for (const tier of b.tiers) {
    const ornate = tier.ornate && ornateAllowed(tier.rarity);
    const t = TIER_RARITIES.indexOf(tier.rarity);
    for (const slot of SLOTS) {
      const armor = Math.max(1, Math.round((c.base + c.per * level) * SHARE[slot] * TIER_MULT[tier.rarity]));
      const name = b.names[slot] ?? `${b.name} ${SLOT_NOUN[b.weight][slot]}`;
      const heavy = b.weight === "mail" || b.weight === "plate";
      const requires: Record<string, number> = { level: t >= 2 ? Math.max(b.levelBand[0], level) : b.levelBand[0] };
      if (heavy) requires.strength = 10 + Math.ceil(b.levelBand[0] / 5) + (b.weight === "plate" ? 1 : 0);
      const from = b.source.id ? ` Taken from ${b.source.id}${b.source.note ? ` (${b.source.note})` : ""}.` : "";
      out.push({
        id: itemId(b.id, slot, tier.rarity),
        doc: {
          name,
          description: `Part of the ${b.name} set.${from}`,
          kind: "equipment",
          slots: [slot],
          weight: +(c.kg * KG[slot]).toFixed(1),
          value: Math.round(armor * 60 * (level / 5 + 1) * TIER_MULT[tier.rarity]),
          rarity: tier.rarity,
          durability: c.dur + t * 10,
          requires,
          modifiers: { armor },
          appearance: { model: modelOfSlot(slot), parts: slotParts(b, slot, ornate), texture: textureOfSlot(b.id, slot) },
          tags: [...new Set(["armor", b.id, b.weight, ...b.tags])],
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- lint
/** What lint needs to know about the three models: their part tables and `rules` (read from the GLB extras). */
export interface ModelFacts {
  body: { parts: string[]; rules: PartRules; tiles: string[] };
  helm: { parts: string[]; rules: PartRules; tiles: string[] };
  shoulder: { parts: string[]; rules: PartRules; tiles: string[] };
}
export const factsOf = (m: ModelFacts, model: string) => (model === MODEL.helm ? m.helm : model === MODEL.shoulder ? m.shoulder : m.body);
export const parseRules = (x: unknown): PartRules => partRulesSchema.parse(x ?? {});

/** Brief lint: problems block the run; warnings are printed. `keys` = the key colours of each manifest. */
export function briefLint(b: ArmorBrief, m: ModelFacts, keys: { body: string[]; helm: string[]; shoulder: string[] }): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const todo = (field: string, v: string) => /\bTODO\b/.test(v) && problems.push(`${field} is still a TODO`);
  todo("subject", b.subject); todo("materials", b.materials); todo("palette", b.palette); todo("backOrnament", b.backOrnament);
  todo("helm.look", b.helm.look); todo("shoulders.look", b.shoulders.look);
  if (b.levelBand[0] > b.levelBand[1]) problems.push(`levelBand ${b.levelBand.join("-")} runs backwards`);
  const seen = new Set<string>();
  for (const t of b.tiers) {
    if (seen.has(t.rarity)) problems.push(`tier ${t.rarity} listed twice`);
    seen.add(t.rarity);
    if (t.ornate && !ornateAllowed(t.rarity)) problems.push(`tier ${t.rarity} is ornate: ornaments (Ornate*, ChestHalo) only on rare or better`);
  }
  if (b.helm.extras.some(isOrnament)) problems.push(`helm.extras carries an ornament (${b.helm.extras.filter(isOrnament).join(", ")}): ornaments go in helm.ornate, shown only on ornate tiers`);
  const helmBases = ["Helm1_Base", "Helm2_Base", "Helm3_base", "HeadBand1"];
  const bases = [b.helm.base, ...b.helm.extras].filter((p) => helmBases.includes(p));
  if (bases.length > 1) problems.push(`one helm base only (has ${bases.join(" + ")})`);
  for (const tier of [false, true]) {
    for (const slot of SLOTS) {
      if (tier && !b.tiers.some((t) => t.ornate)) continue;
      const parts = slotParts(b, slot, tier);
      const f = factsOf(m, modelOfSlot(slot));
      const missing = parts.filter((p) => !f.parts.includes(p));
      if (missing.length) problems.push(`${slot}: ${missing.join(", ")} not in ${modelOfSlot(slot)}'s part table`);
      for (const p of partProblems(f.rules, parts)) problems.push(`${slot}${tier ? " (ornate)" : ""}: ${p}`);
    }
  }
  for (const p of b.skin) if (!m.body.parts.includes(p) || !/^Human(Male)?_/.test(p)) problems.push(`skin part ${p} is not a male body part`);
  const mt = matchesOf(b);
  for (const [model, pairs] of [["helm", mt.helm], ["shoulder", mt.shoulder]] as const) {
    if (!pairs.length) warnings.push(`no ${model} match-material pass: its body-material slots keep their own generator's tone`);
    for (const pair of pairs) {
      for (const h of pair.from) if (!keys.body.includes(h)) problems.push(`match.${model}: ${h} is not a body key colour`);
      for (const h of pair.to) if (!keys[model].includes(h)) problems.push(`match.${model}: ${h} is not a ${model} key colour`);
    }
  }
  if (!b.tiers.some((t) => t.ornate)) warnings.push("no ornate tier: the back ornament and the helm/shoulder ornaments are painted but never worn");
  return { problems, warnings };
}

/** items lint: every item of the set present, schema-valid, parts on the model and within its rules, ornaments rare+, sheet on the page. */
export function itemsLint(b: ArmorBrief, read: (id: string) => unknown | null, m: ModelFacts, textureExists: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const want of buildItems(b)) {
    const raw = read(want.id);
    if (!raw) { out.push(`${want.id}: missing`); continue; }
    const r = itemSchema.safeParse(raw);
    if (!r.success) { out.push(`${want.id}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`); continue; }
    const it = r.data;
    const look = it.appearance;
    if (!look) { out.push(`${want.id}: no appearance`); continue; }
    const f = factsOf(m, look.model);
    const unknown = look.parts.filter((p) => !f.parts.includes(p));
    if (unknown.length) out.push(`${want.id}: ${unknown.join(", ")} not on ${look.model}`);
    for (const p of partProblems(f.rules, look.parts)) out.push(`${want.id}: ${p}`);
    const orn = look.parts.filter(isOrnament);
    if (orn.length && !ornateAllowed(it.rarity as TierRarity)) out.push(`${want.id}: ${orn.join(", ")} on a ${it.rarity} item (ornaments are rare+)`);
    if (!look.texture || !textureExists(look.texture)) out.push(`${want.id}: sheet ${look.texture} not in assets/textures`);
    else if (!f.tiles.includes(look.texture)) out.push(`${want.id}: sheet ${look.texture} is not a tile on ${look.model}'s page (bake first)`);
    if (!it.tags.includes(b.id)) out.push(`${want.id}: not tagged ${b.id}`);
  }
  return out;
}

// ---------------------------------------------------------------- prompts
/** The four prompt templates (the text after the `---` line of each prompt file). */
export interface Templates { body: string; female: string; helm: string; shoulder: string }
export const afterRule = (md: string): string => {
  const i = md.indexOf("\n---\n");
  return (i >= 0 ? md.slice(i + 5) : md).trim();
};

export function tierLine(b: ArmorBrief): string {
  if (b.tierNote) return b.tierNote;
  const [lo, hi] = b.levelBand;
  if (hi <= 10) return `This is LOW-LEVEL gear (character level ${lo}-${hi}, a starter zone): plain, worn, practical and modest. No glow, no gems, no gold, no grand ornament; its interest is in the story the wear tells.`;
  if (hi <= 22) return `This is MID-LEVEL gear (character level ${lo}-${hi}): sturdy, characterful and clearly better made than starter kit, but not heroic or legendary. No glow, no gold.`;
  return `This is HIGH-LEVEL gear (character level ${lo}-${hi}): masterwork, distinctive and proud, still worn and real. Restrained: no neon glow.`;
}

/** The SUBJECT block every prompt of the set carries, word for word. */
export function subjectText(b: ArmorBrief): string {
  return [
    tierLine(b),
    `${b.weight.toUpperCase()}: ${b.subject.trim()}`,
    `Materials: ${b.materials.trim()}`,
    ...(b.trim.trim() ? [`Trim: ${b.trim.trim()}`] : []),
    `The back ornament: ${b.backOrnament.trim()}`,
    `Palette: ${b.palette.trim()}`,
  ].join("\n");
}

// Derek called the 132 px helm sheets "messy" (2026-10-08): fine detail becomes speckle at that size.
export const cleanRead = (px: number): string =>
  `KEEP IT CLEAN AND READABLE - THE MOST IMPORTANT STYLE RULE ON THIS SHEET. It is shrunk to about ${px} pixels and drawn with hard pixels, so fine detail turns into noise. Paint each piece as LARGE FLAT AREAS of one material with two or three broad value steps (a lit top, a mid tone, a dark recess) and one clean edge highlight. At most ONE row of a few LARGE rivets or studs, evenly spaced. NO speckle, NO scratches, NO tiny dots or flecks, NO busy patterns, NO noise texture, NO high-contrast specks. Mail rings, stitching and wood grain are drawn BIG and sparse, never as fine noise. Seen at a quarter size every piece must read as one simple shape in one material.`;
export const MATCH_BODY =
  "TWO images are attached. The FIRST is the colour-key layout to paint over. The SECOND is the finished BODY sheet of this same outfit: match it exactly - same metals, cloth, leather, trim, rivets, palette, wear and dirt - so these pieces read as the same set. Do not copy its layout.";

export function buildPrompts(b: ArmorBrief, t: Templates): { body: string; female: string; helm: string; shoulder: string } {
  const subject = subjectText(b);
  const body = t.body.replace("{subject}", subject);
  return {
    body,
    female: `${body}\n\n${t.female}`,
    helm: [cleanRead(130), MATCH_BODY, t.helm.replace("{subject}", `${subject}\nHEADGEAR: ${b.helm.look.trim()}`)].join("\n\n"),
    shoulder: [cleanRead(110), MATCH_BODY, t.shoulder.replace("{subject}", `${subject}\nSHOULDERS: ${b.shoulders.look.trim()}`)].join("\n\n"),
  };
}

/** One gen-set image (tools/image-request.mjs manifest entry; target/ref relative to apps/playground). */
export interface GenImage { id: string; role: "body" | "female" | "helm" | "shoulder"; target: string; size: string; purpose: string; ref: string[]; prompt: string }

/** Art and key paths, relative to apps/playground (where image-request resolves them). */
export const ART = (id: string) => ({
  body: `../../tools/atlas/art/human-body/${id}.png`,
  female: `../../tools/atlas/art/human-body/${id}-f.png`,
  helm: `../../tools/atlas/art/human-helm/${id}.png`,
  shoulder: `../../tools/atlas/art/human-shoulder/${id}.png`,
});
export const KEYS = {
  body: "../../tools/atlas/sets/human-body/key.png",
  female: "../../tools/atlas/sets/human-body/key-female.png",
  helm: "../../tools/atlas/sets/human-helm/key-labelled.png",
  shoulder: "../../tools/atlas/sets/human-shoulder/key-labelled.png",
};

/** THE manifest of a set, in the doc's order: body, the woman's chest, helm, shoulders — each with its refs in order. */
export function buildManifest(b: ArmorBrief, t: Templates): { images: GenImage[] } {
  const p = buildPrompts(b, t);
  const a = ART(b.id);
  const img = (role: GenImage["role"], ref: string[], purpose: string): GenImage => ({ id: `armor-${b.id}-${role}`, role, target: a[role], size: "1254x1254", purpose, ref, prompt: p[role] });
  return {
    images: [
      img("body", [KEYS.body], `armor set ${b.id}: body sheet`),
      img("female", [KEYS.female, a.body], `armor set ${b.id}: the woman's sheet (chest front kept)`),
      img("helm", [KEYS.helm, a.body], `armor set ${b.id}: headgear sheet`),
      img("shoulder", [KEYS.shoulder, a.body], `armor set ${b.id}: shoulder sheet`),
    ],
  };
}

/**
 * One session attaches every distinct ref ONCE, in first-seen order (image-request gen-set), so in a session of
 * several images "the FIRST image" in a prompt is not attachment 1. Each prompt whose refs are not exactly the
 * session's attachments, in order, gets a line mapping its FIRST/SECOND onto attachment numbers.
 */
export function sessionImages(wave: GenImage[]): GenImage[] {
  const refs = [...new Set(wave.flatMap((i) => i.ref))];
  const ORD = ["FIRST", "SECOND", "THIRD", "FOURTH"];
  const base = (r: string) => r.split("/").slice(-3).join("/");
  return wave.map((i) => {
    if (i.ref.length === refs.length && i.ref.every((r, k) => refs[k] === r)) return i;
    const map = i.ref.map((r, k) => `the ${ORD[k]} image this prompt names is attachment ${refs.indexOf(r) + 1} (${base(r)})`).join("; ");
    return { ...i, prompt: `ATTACHMENTS FOR THIS IMAGE: this session has ${refs.length} attached images; ${map}. Ignore the other attachments for this image.\n\n${i.prompt}` };
  });
}

/**
 * Which images to request now, in sessions. Done images are skipped (unless `force`); an image whose ref is another
 * image of the set still to be made waits for a later session (the body sheet first, then everything painted to it).
 */
export function genWaves(images: GenImage[], done: (img: GenImage) => boolean, force = false, redo: readonly string[] = []): GenImage[][] {
  // `redo` roles are made again with every image painted from them (refs, transitively): a new body means new art for all
  const again = new Set(images.filter((i) => redo.includes(i.role)).map((i) => i.target));
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of images) if (!again.has(i.target) && i.ref.some((r) => again.has(r))) { again.add(i.target); grew = true; }
  }
  let todo = images.filter((i) => force || again.has(i.target) || !done(i));
  const made = new Set(images.filter((i) => !todo.includes(i)).map((i) => i.target));
  const waves: GenImage[][] = [];
  while (todo.length) {
    const ready = todo.filter((i) => i.ref.every((r) => !images.some((o) => o.target === r) || made.has(r)));
    if (!ready.length) throw new Error(`gen: circular refs among ${todo.map((i) => i.id).join(", ")}`);
    waves.push(ready);
    for (const i of ready) made.add(i.target);
    todo = todo.filter((i) => !ready.includes(i));
  }
  return waves;
}
