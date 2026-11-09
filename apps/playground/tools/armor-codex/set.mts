/**
 * Pure set logic for `armor` (no IO): the pieces a brief (and, for an instance, its loot plan) ships, the item
 * documents, brief lint, cross-set pick lint, items lint, the prompts and the ONE gen-set manifest per set. The CLI
 * (tools/armor.mts) and the tests share it.
 */
import { itemSchema, partProblems, partRulesSchema, type PartRules } from "@hitreg/core";
import { ornateAllowed, matchesOf, SLOT_NOUN, SLOTS, BODY_SLOTS, TIER_RARITIES, HELM_ORNATE, SHOULDER_ORNATE, WEIGHTS, type ArmorBrief, type Slot, type TierRarity, type Weight, type Legs, type HelmPick, type ShoulderPick } from "./schema.mts";
import type { LootPlan, SheetWeights } from "./loot.mts";

export const MODEL = { body: "mmo/human-body.glb", helm: "mmo/human-helm.glb", shoulder: "mmo/human-shoulder.glb" } as const;
export const modelOfSlot = (s: Slot): string => (s === "helm" ? MODEL.helm : s === "shoulders" ? MODEL.shoulder : MODEL.body);
/** Body themes of a set: a kit's one sheet is the set id; an instance's sheets are `<set>-<key>`. */
export const bodyThemes = (b: ArmorBrief): string[] => (b.kind === "instance" ? (b.bodies ?? []).map((s) => `${b.id}-${s.key}`) : [b.id]);
export const bodyThemeOf = (b: ArmorBrief, key: string): string => (b.kind === "instance" ? `${b.id}-${key}` : b.id);
export const bodySheetId = (theme: string, female = false): string => `mmo/human-body-${theme}${female ? "-f" : ""}.png`;
/** The theme sheet ids (assets/textures/…) — also the tile keys on each model's page. `id` = the set id (kit: also its body theme). */
export const sheetIds = (id: string) => ({
  body: bodySheetId(id),
  bodyF: bodySheetId(id, true),
  helm: `mmo/human-helm-${id}.png`,
  shoulder: `mmo/human-shoulder-${id}.png`,
});
/** Every sheet a set puts on the pages. */
export const setSheets = (b: ArmorBrief): string[] => [...bodyThemes(b).flatMap((t) => [bodySheetId(t), bodySheetId(t, true)]), sheetIds(b.id).helm, sheetIds(b.id).shoulder];

const ORNATE_PARTS = new Set<string>([...HELM_ORNATE, ...SHOULDER_ORNATE, "ChestHalo", "F_ChestHalo"]);
export const isOrnament = (part: string): boolean => ORNATE_PARTS.has(part);

/** The MALE body part names of a body slot (docs/armor-sets.md → Breaking a set into items). */
export function bodyParts(slot: (typeof BODY_SLOTS)[number], legs: Legs, ornate: boolean, chestHalo = true, bareArms = false): string[] {
  switch (slot) {
    case "chest":
      return ["HumanMale_ChestFront", "HumanMale_ChestBack", ...(!bareArms ? ["HumanMale_ArmOutside", "HumanMale_ArmInside"] : []), ...(ornate && chestHalo ? ["ChestHalo"] : [])];
    case "gloves":
      return ["HumanMale_HandFront", "HumanMale_HandPalm"];
    case "legs": {
      const extra = { robe: ["RobesFront", "RobesBack"], tasset: ["TassetFront", "TassetBack"], "robe-tasset": ["RobesFront", "RobesBack", "TassetFront"], plain: [] }[legs];
      return ["Human_LegsFront", "Human_LegsBack", "Belt", "Buckle", ...extra];
    }
    case "boots":
      return ["HumanMale_Foot"];
  }
}
export const helmParts = (h: HelmPick, ornate: boolean): string[] => [h.base, ...h.extras, ...(ornate ? h.ornate : [])];
export const shoulderParts = (s: ShoulderPick, ornate: boolean): string[] => [s.base, ...(s.rim ? [s.rim] : []), ...(s.accent ? [s.accent] : []), ...(ornate ? s.ornate : [])];

/** A kit's parts for a slot at a tier: helm/shoulders = the first piece listing that tier (or the first piece). */
export function slotParts(b: ArmorBrief, slot: Slot, ornate: boolean, rarity?: TierRarity): string[] {
  if (slot === "helm") return helmParts(entryAt(b.helms ?? [], rarity)!, ornate);
  if (slot === "shoulders") return shoulderParts(entryAt(b.shoulders ?? [], rarity)!, ornate);
  return bodyParts(slot, b.legs, ornate, b.chestHalo, b.bareArms);
}
const entryAt = <T extends { tiers: TierRarity[] }>(list: T[], rarity?: TierRarity): T | undefined => (rarity && list.find((e) => e.tiers.includes(rarity))) || list[0];

// ---------------------------------------------------------------- pieces
/** One item the set ships: what it is, what it shows, what sheet draws it. */
export interface Piece {
  id: string;
  name: string;
  slot: Slot;
  weight: Weight;
  rarity: TierRarity;
  ornate: boolean;
  parts: string[];
  texture: string;
  /** kit: the helm/shoulder entry key or the slot; instance: the loot piece id */
  key: string;
  /** body pieces: the body theme that draws them */
  bodyTheme?: string;
  story?: string;
  from?: string[];
}

/**
 * Kit: one body item per slot per tier (`<set>-<slot>-<rarity>`), and one item per helm / shoulder piece per tier it
 * lists: the first piece listing a tier keeps the plain `<set>-helm-<rarity>`, later ones are `<set>-helm-<key>-<rarity>`.
 * Instance: every piece of the loot plan, as planned.
 */
export function piecesOf(b: ArmorBrief, plan?: LootPlan | null): Piece[] {
  if (b.kind === "instance") {
    if (!plan) return [];
    return plan.pieces.map((p) => {
      const helmOrSh = p.slot === "helm" || p.slot === "shoulders";
      const theme = helmOrSh ? undefined : bodyThemeOf(b, p.sheet);
      const parts = helmOrSh ? [...p.parts, ...(p.ornate ? p.ornaments : [])] : bodyParts(p.slot as "chest", p.legs ?? "plain", p.ornate, b.chestHalo);
      return { id: p.id, name: p.name, slot: p.slot, weight: p.weight, rarity: p.rarity, ornate: p.ornate, parts, texture: p.slot === "helm" ? sheetIds(b.id).helm : p.slot === "shoulders" ? sheetIds(b.id).shoulder : bodySheetId(theme!), key: p.id, bodyTheme: theme, story: p.story, from: p.from };
    });
  }
  const weight = b.weight ?? "cloth";
  const out: Piece[] = [];
  for (const tier of b.tiers) {
    const ornate = tier.ornate && ornateAllowed(tier.rarity);
    for (const slot of SLOTS) {
      if (slot === "helm" || slot === "shoulders") {
        const list: (HelmPick | ShoulderPick)[] = (slot === "helm" ? b.helms : b.shoulders) ?? [];
        const at = list.filter((e) => e.tiers.includes(tier.rarity));
        at.forEach((e, k) =>
          out.push({
            id: k === 0 ? `${b.id}-${slot}-${tier.rarity}` : `${b.id}-${slot}-${e.key}-${tier.rarity}`,
            name: e.name,
            slot,
            weight,
            rarity: tier.rarity,
            ornate,
            parts: slot === "helm" ? helmParts(e as HelmPick, ornate) : shoulderParts(e as ShoulderPick, ornate),
            texture: slot === "helm" ? (e as HelmPick).texture ?? sheetIds(b.id).helm : sheetIds(b.id).shoulder,
            key: e.key,
          }),
        );
      } else
        out.push({ id: `${b.id}-${slot}-${tier.rarity}`, name: b.names[slot] ?? `${b.name} ${SLOT_NOUN[weight][slot]}`, slot, weight, rarity: tier.rarity, ornate, parts: bodyParts(slot, b.legs, ornate, b.chestHalo, b.bareArms), texture: sheetIds(b.id).body, key: slot, bodyTheme: b.id });
    }
  }
  return out;
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

/** Every item the brief (and its loot plan) asks for, schema-shaped (validated by `itemsLint`). */
export function buildItems(b: ArmorBrief, plan?: LootPlan | null): ArmorItem[] {
  const level = Math.round((b.levelBand[0] + b.levelBand[1]) / 2);
  return piecesOf(b, plan).map((p) => {
    const c = CLASS[p.weight];
    const t = TIER_RARITIES.indexOf(p.rarity);
    const armor = Math.max(1, Math.round((c.base + c.per * level) * SHARE[p.slot] * TIER_MULT[p.rarity]));
    const heavy = p.weight === "mail" || p.weight === "plate";
    const requires: Record<string, number> = { level: t >= 2 ? Math.max(b.levelBand[0], level) : b.levelBand[0] };
    if (heavy) requires.strength = 10 + Math.ceil(b.levelBand[0] / 5) + (p.weight === "plate" ? 1 : 0);
    const from = b.source.id ? ` Taken from ${b.source.id}${b.source.note ? ` (${b.source.note})` : ""}.` : "";
    const description = b.kind === "instance" ? `${p.story ?? ""} Found in ${b.name}.`.trim() : `Part of the ${b.name} set.${from}`;
    return {
      id: p.id,
      doc: {
        name: p.name,
        description,
        kind: "equipment",
        slots: [p.slot],
        weight: +(c.kg * KG[p.slot]).toFixed(1),
        value: Math.round(armor * 60 * (level / 5 + 1) * TIER_MULT[p.rarity]),
        rarity: p.rarity,
        durability: c.dur + t * 10,
        requires,
        modifiers: { armor },
        appearance: { model: modelOfSlot(p.slot), parts: p.parts, texture: p.texture },
        tags: [...new Set(["armor", b.id, p.weight, ...b.tags])],
      },
    };
  });
}

// ---------------------------------------------------------------- lint
/** What lint needs to know about the three models: their part tables, `rules` and triangles per part (GLB). */
export interface ModelFact { parts: string[]; rules: PartRules; tiles: string[]; tris?: Record<string, number> }
export interface ModelFacts { body: ModelFact; helm: ModelFact; shoulder: ModelFact }
export const factsOf = (m: ModelFacts, model: string) => (model === MODEL.helm ? m.helm : model === MODEL.shoulder ? m.shoulder : m.body);
export const parseRules = (x: unknown): PartRules => partRulesSchema.parse(x ?? {});

/** Two picks read as different pieces when the parts they do NOT share cover at least this share of their triangles. */
export const DISTINCT_SHARE = 0.25;
/** Share of the two picks' triangles (ornaments left out) in the parts only one of them has: 0 = identical, 1 = nothing shared. */
export function pickDifference(a: string[], b: string[], tris: Record<string, number> = {}): number {
  const A = new Set(a.filter((p) => !isOrnament(p))), B = new Set(b.filter((p) => !isOrnament(p)));
  const w = (p: string) => tris[p] ?? 1;
  let all = 0, diff = 0;
  for (const p of new Set([...A, ...B])) { all += w(p); if (!(A.has(p) && B.has(p))) diff += w(p); }
  return all ? diff / all : 0;
}

/** Brief lint: problems block the run; warnings are printed. `keys` = the key colours of each manifest. */
export function briefLint(b: ArmorBrief, m: ModelFacts, keys: { body: string[]; helm: string[]; shoulder: string[] }): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const todo = (field: string, v: string) => /\bTODO\b/.test(v) && problems.push(`${field} is still a TODO`);
  todo("subject", b.subject); todo("materials", b.materials); todo("palette", b.palette); todo("backOrnament", b.backOrnament);
  todo("helmLook", b.helmLook); todo("shoulderLook", b.shoulderLook);
  if (b.levelBand[0] > b.levelBand[1]) problems.push(`levelBand ${b.levelBand.join("-")} runs backwards`);
  const helmBases = ["Helm1_Base", "Helm2_Base", "Helm3_base", "HeadBand1"];
  const rulesHold = (what: string, model: string, parts: string[]) => {
    const f = factsOf(m, model);
    const missing = parts.filter((p) => !f.parts.includes(p));
    if (missing.length) problems.push(`${what}: ${missing.join(", ")} not in ${model}'s part table`);
    for (const p of partProblems(f.rules, parts)) problems.push(`${what}: ${p}`);
  };
  if (b.kind === "kit") {
    if (!b.weight) problems.push("a kit needs its `weight`");
    if (!b.tiers.length) problems.push("a kit needs at least one tier");
    if (!b.helms?.length || !b.shoulders?.length) problems.push("a kit needs `helms` (1-4 pieces) and `shoulders` (2-4 pieces)");
    if (b.bodies || b.helmPaint || b.shoulderPaint || b.loot) problems.push("bodies / helmPaint / shoulderPaint / loot are instance fields");
    const seen = new Set<string>();
    for (const t of b.tiers) {
      if (seen.has(t.rarity)) problems.push(`tier ${t.rarity} listed twice`);
      seen.add(t.rarity);
      if (t.ornate && !ornateAllowed(t.rarity)) problems.push(`tier ${t.rarity} is ornate: ornaments (Ornate*, ChestHalo) only on rare or better`);
    }
    const ornateTier = (r: TierRarity) => b.tiers.find((t) => t.rarity === r)?.ornate === true;
    for (const [slot, list, model] of [["helm", b.helms ?? [], MODEL.helm], ["shoulders", b.shoulders ?? [], MODEL.shoulder]] as const) {
      const keysSeen = new Set<string>();
      for (const e of list as (HelmPick | ShoulderPick)[]) {
        const what = `${slot} ${e.key}`;
        if (keysSeen.has(e.key)) problems.push(`${what}: key used twice`);
        keysSeen.add(e.key);
        todo(`${what} name`, e.name);
        for (const r of e.tiers) if (!b.tiers.some((t) => t.rarity === r)) problems.push(`${what}: tier ${r} is not a tier of the set`);
        const extras = slot === "helm" ? (e as HelmPick).extras : [];
        if (extras.some(isOrnament)) problems.push(`${what}: extras carry an ornament (${extras.filter(isOrnament).join(", ")}): ornaments go in ornate, shown only on ornate tiers`);
        const parts = slot === "helm" ? helmParts(e as HelmPick, false) : shoulderParts(e as ShoulderPick, false);
        const bases = parts.filter((p) => helmBases.includes(p));
        if (slot === "helm" && bases.length > 1) problems.push(`${what}: one helm base only (has ${bases.join(" + ")})`);
        rulesHold(what, model, parts);
        if (e.ornate.length) {
          if (e.tiers.some(ornateTier)) rulesHold(`${what} (ornate)`, model, slot === "helm" ? helmParts(e as HelmPick, true) : shoulderParts(e as ShoulderPick, true));
          else warnings.push(`${what}: has ornaments but none of its tiers (${e.tiers.join(", ")}) is ornate: they are never worn`);
        }
      }
      for (const t of b.tiers) if (!list.some((e) => e.tiers.includes(t.rarity))) problems.push(`${slot}: no piece drops at the ${t.rarity} tier`);
      // distinct within the set
      const f = factsOf(m, model);
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const pa = slot === "helm" ? helmParts(list[i] as HelmPick, false) : shoulderParts(list[i] as ShoulderPick, false);
          const pb = slot === "helm" ? helmParts(list[j] as HelmPick, false) : shoulderParts(list[j] as ShoulderPick, false);
          const d = pickDifference(pa, pb, f.tris);
          if (d < DISTINCT_SHARE) problems.push(`${slot} ${list[i]!.key} and ${list[j]!.key} read as the same piece: the parts they do not share are ${(d * 100).toFixed(0)}% of their triangles (want ${DISTINCT_SHARE * 100}%+): another base, or clearly different extras`);
        }
      const names = list.map((e) => e.name);
      for (const n of new Set(names.filter((x, i) => names.indexOf(x) !== i))) problems.push(`${slot}: two pieces are both named "${n}"`);
    }
    for (const tier of [false, true]) {
      if (tier && !b.tiers.some((t) => t.ornate)) continue;
      for (const slot of BODY_SLOTS) rulesHold(`${slot}${tier ? " (ornate)" : ""}`, MODEL.body, bodyParts(slot, b.legs, tier, b.chestHalo));
    }
    if (!b.tiers.some((t) => t.ornate)) warnings.push("no ornate tier: the back ornament and the helm/shoulder ornaments are painted but never worn");
  } else {
    if (b.reusePartPicks) problems.push("reusePartPicks is only for a kit's practical wardrobe; instance loot must keep distinct picks");
    if (b.helms || b.shoulders || b.tiers.length) problems.push("an instance names its pieces and rarities in the loot plan, not helms / shoulders / tiers");
    if (!b.bodies?.length) problems.push("an instance needs 1-2 mixed `bodies`");
    if (!b.loot) problems.push("an instance needs its `loot` plan file");
    for (const s of b.bodies ?? []) {
      todo(`bodies.${s.key}.subject`, s.subject);
      if (new Set(Object.values(s.weights)).size < 2) warnings.push(`body sheet ${s.key} paints every region one weight: an instance sheet mixes weights`);
    }
    const keysB = (b.bodies ?? []).map((s) => s.key);
    for (const k of new Set(keysB.filter((x, i) => keysB.indexOf(x) !== i))) problems.push(`body sheet key ${k} used twice`);
    for (const [what, paint, model] of [["helmPaint", b.helmPaint, MODEL.helm], ["shoulderPaint", b.shoulderPaint, MODEL.shoulder]] as const) {
      if (!paint?.length) { problems.push(`an instance needs ${what} (the weight of every part of the one sheet)`); continue; }
      const f = factsOf(m, model);
      const all = paint.flatMap((l) => l.parts);
      for (const p of all) if (!f.parts.includes(p)) problems.push(`${what}: ${p} not in ${model}'s part table`);
      for (const p of new Set(all.filter((x, i) => all.indexOf(x) !== i))) problems.push(`${what}: ${p} painted twice (a region is painted once)`);
      for (const p of f.parts) if (!all.includes(p)) problems.push(`${what}: ${p} has no weight (the sheet paints every part)`);
      for (const l of paint) todo(`${what} ${l.parts.join("+")}`, l.look);
    }
    const ws = new Set([...(b.bodies ?? []).flatMap((s) => Object.values(s.weights)), ...(b.helmPaint ?? []).map((l) => l.weight), ...(b.shoulderPaint ?? []).map((l) => l.weight)]);
    for (const w of WEIGHTS) if (!ws.has(w)) problems.push(`no sheet region is painted ${w}: the instance cannot drop ${w}`);
  }
  for (const p of b.skin) if (!m.body.parts.includes(p) || !/^Human(Male)?_/.test(p)) problems.push(`skin part ${p} is not a male body part`);
  const mt = matchesOf(b);
  for (const [model, pairs] of [["helm", mt.helm], ["shoulder", mt.shoulder]] as const) {
    if (!pairs.length && b.kind === "kit") warnings.push(`no ${model} match-material pass: its body-material slots keep their own generator's tone`);
    for (const pair of pairs) {
      for (const h of pair.from) if (!keys.body.includes(h)) problems.push(`match.${model}: ${h} is not a body key colour`);
      for (const h of pair.to) if (!keys[model].includes(h)) problems.push(`match.${model}: ${h} is not a ${model} key colour`);
    }
  }
  return { problems, warnings };
}

/** The weights an instance brief's sheets paint, for the loot plan lint. */
export function sheetWeights(b: ArmorBrief): SheetWeights {
  const paint = (l: ArmorBrief["helmPaint"]) => Object.fromEntries((l ?? []).flatMap((x) => x.parts.map((p) => [p, x.weight])));
  return { bodies: Object.fromEntries((b.bodies ?? []).map((s) => [s.key, s.weights])), helm: paint(b.helmPaint), shoulder: paint(b.shoulderPaint) };
}

/**
 * Across ALL sets: two sets shipping the IDENTICAL helm or shoulder pick (same parts, same ornaments as worn) is a
 * problem; explicit civilian wardrobe reuse is a warning, as is sharing a base.
 */
export function crossSetLint(sets: { b: ArmorBrief; plan?: LootPlan | null }[]): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const reusable = new Set(sets.filter(({ b }) => b.kind === "kit" && (b.reusePartPicks?.trim().length ?? 0) >= 60).map(({ b }) => b.id));
  for (const slot of ["helm", "shoulders"] as const) {
    const looks = new Map<string, string[]>();
    const bases = new Map<string, Set<string>>();
    for (const { b, plan } of sets) {
      const mine = new Set<string>();
      for (const p of piecesOf(b, plan).filter((x) => x.slot === slot)) {
        const k = p.parts.slice().sort().join("+");
        if (mine.has(k)) continue; // the same piece at another tier
        mine.add(k);
        looks.set(k, [...(looks.get(k) ?? []), `${b.id}:${p.key}`]);
        const base = p.parts[0]!;
        bases.set(base, (bases.get(base) ?? new Set()).add(b.id));
      }
    }
    for (const [k, who] of looks) {
      const owners = new Set(who.map((w) => w.split(":")[0]!));
      if (owners.size > 1) {
        const strict = [...owners].filter((id) => !reusable.has(id));
        if (strict.length > 1) problems.push(`${slot}: identical pick ${k} in ${who.filter((w) => strict.includes(w.split(":")[0]!)).join(", ")}: change the extras / rim / accent or the ornaments of one`);
        if ([...owners].some((id) => reusable.has(id))) warnings.push(`${slot}: shared wardrobe pick ${k} in ${who.join(", ")} (explicit reusePartPicks rationale; painted identities require visual review)`);
      }
    }
    for (const [base, who] of bases) if (who.size > 1) warnings.push(`${slot} base ${base} shared by ${who.size} sets: ${[...who].join(", ")}`);
  }
  return { problems, warnings };
}

/** items lint: every item of the set present, schema-valid, parts on the model and within its rules, ornaments rare+, sheet on the page. */
export function itemsLint(b: ArmorBrief, read: (id: string) => unknown | null, m: ModelFacts, textureExists: (id: string) => boolean, plan?: LootPlan | null): string[] {
  const out: string[] = [];
  const want = buildItems(b, plan);
  if (!want.length) out.push(`${b.id}: no items (an instance needs its loot plan)`);
  for (const w of want) {
    const raw = read(w.id);
    if (!raw) { out.push(`${w.id}: missing`); continue; }
    const r = itemSchema.safeParse(raw);
    if (!r.success) { out.push(`${w.id}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`); continue; }
    const it = r.data;
    const look = it.appearance;
    if (!look) { out.push(`${w.id}: no appearance`); continue; }
    const f = factsOf(m, look.model);
    const unknown = look.parts.filter((p) => !f.parts.includes(p));
    if (unknown.length) out.push(`${w.id}: ${unknown.join(", ")} not on ${look.model}`);
    for (const p of partProblems(f.rules, look.parts)) out.push(`${w.id}: ${p}`);
    const orn = look.parts.filter(isOrnament);
    if (orn.length && !ornateAllowed(it.rarity as TierRarity)) out.push(`${w.id}: ${orn.join(", ")} on a ${it.rarity} item (ornaments are rare+)`);
    if (!look.texture || !textureExists(look.texture)) out.push(`${w.id}: sheet ${look.texture} not in assets/textures`);
    else if (!f.tiles.includes(look.texture)) out.push(`${w.id}: sheet ${look.texture} is not a tile on ${look.model}'s page (bake first)`);
    if (look.model === MODEL.body && look.texture && !f.tiles.includes(look.texture.replace(/\.png$/, "-f.png"))) out.push(`${w.id}: no woman's sheet ${look.texture!.replace(/\.png$/, "-f.png")} on the body page`);
    if (!it.tags.includes(b.id)) out.push(`${w.id}: not tagged ${b.id}`);
    if (!it.tags.some((t) => (WEIGHTS as readonly string[]).includes(t))) out.push(`${w.id}: no weight tag`);
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
    `${b.kind === "instance" ? "INSTANCE LOOT, SEVERAL ARMOUR WEIGHTS OF ONE PLACE" : (b.weight ?? "cloth").toUpperCase()}: ${b.subject.trim()}`,
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


/** What each model part is called in its prompt's REGION KEY (tools/atlas/sets/<set>/prompt.md). */
export const REGION_LABEL: Record<string, string> = {
  Helm1_Base: "HELM1", Helm1_Flair: "HELM1's FLARED NECK GUARD", Helm1_NoBeard: "HELM1's WHOLE FRONT (the face plate)", Helm2_Base: "HELM2 (and the top of HELM2's WHOLE FRONT)",
  Helm2_NoBeard: "HELM2's JAW GUARD", Helm3_base: "HELM3", Hood: "HOOD", FacecoverTotal: "FACE COVER", Bandana: "BANDANA", Crown: "CROWN", HeadBand1: "BAND",
  NoseGuard1: "NOSE1", NoseGuard2: "NOSE2", OrnateSide: "the SIDE ornament", OrnateTop: "the low front CREST", OrnateTop2: "the tall front CREST",
  ShoulderBase1: "BASE1", ShoulderBase2: "BASE2", ShoulderBase3: "BASE3", ShoulderBase4: "BASE4", Rim1: "RIM", Accent1: "ACCENT", PlanerRim: "RIM FRINGE", PlanerAccent: "ACCENT FRINGE", Ornate: "ORN", Ornate2: "ORN2",
};
const paintText = (lines: ArmorBrief["helmPaint"]): string =>
  `EACH REGION IS ITS OWN ARMOUR WEIGHT. This one sheet carries several weights of the same place's gear; paint every region as the weight and material below, all in the SUBJECT's palette so they read as one place, never as one uniform kit:\n${(lines ?? []).map((l) => `- ${l.parts.map((p) => REGION_LABEL[p] ?? p).join(", ")}: ${l.weight.toUpperCase()}, ${l.look.trim()}`).join("\n")}`;
const REGION_NAME = { chest: "CHEST AND ARMS", legs: "TROUSERS, ROBE PANELS, TASSET AND BELT", gloves: "HANDS", boots: "BOOTS" } as const;

/** The prompts of one set: one body + female prompt per body theme, one helm and one shoulder prompt. */
export function buildPrompts(b: ArmorBrief, t: Templates): { bodies: { theme: string; body: string; female: string }[]; helm: string; shoulder: string } {
  const subject = subjectText(b);
  const bodies =
    b.kind === "instance"
      ? (b.bodies ?? []).map((s) => {
          const weights = BODY_SLOTS.map((k) => `${REGION_NAME[k]}: ${s.weights[k].toUpperCase()}`).join("; ");
          const body = t.body.replace("{subject}", `${subject}\nTHIS SHEET, MIXED WEIGHTS (one place's gear, not a uniform kit; each region is its own armour weight: ${weights}): ${s.subject.trim()}`);
          return { theme: bodyThemeOf(b, s.key), body, female: `${body}\n\n${t.female}` };
        })
      : [{ theme: b.id, body: t.body.replace("{subject}", subject), female: `${t.body.replace("{subject}", subject)}\n\n${t.female}` }];
  const helmSubject = `${subject}\nHEADGEAR: ${b.helmLook.trim()}${b.kind === "instance" ? `\n${paintText(b.helmPaint)}` : ""}`;
  const shSubject = `${subject}\nSHOULDERS: ${b.shoulderLook.trim()}${b.kind === "instance" ? `\n${paintText(b.shoulderPaint)}` : ""}`;
  return {
    bodies,
    helm: [cleanRead(130), MATCH_BODY, t.helm.replace("{subject}", helmSubject)].join("\n\n"),
    shoulder: [cleanRead(110), MATCH_BODY, t.shoulder.replace("{subject}", shSubject)].join("\n\n"),
  };
}

/** One gen-set image (tools/image-request.mjs manifest entry; target/ref relative to apps/playground). `role` = body|female|helm|shoulder, `body:<theme>` / `female:<theme>` on an instance. */
export interface GenImage { id: string; role: string; target: string; size: string; purpose: string; ref: string[]; prompt: string }
export const roleKind = (role: string): string => role.split(":")[0]!;

/** Art and key paths, relative to apps/playground (where image-request resolves them). */
export const ART = (id: string, bodyTheme = id) => ({
  body: `../../tools/atlas/art/human-body/${bodyTheme}.png`,
  female: `../../tools/atlas/art/human-body/${bodyTheme}-f.png`,
  helm: `../../tools/atlas/art/human-helm/${id}.png`,
  shoulder: `../../tools/atlas/art/human-shoulder/${id}.png`,
});
export const KEYS = {
  body: "../../tools/atlas/sets/human-body/key.png",
  female: "../../tools/atlas/sets/human-body/key-female.png",
  helm: "../../tools/atlas/sets/human-helm/key-labelled.png",
  shoulder: "../../tools/atlas/sets/human-shoulder/key-labelled.png",
};

/** THE manifest of a set, in the doc's order: each body sheet, each woman's chest, helm, shoulders — refs in order. Helm and shoulders are painted to the FIRST body sheet. */
export function buildManifest(b: ArmorBrief, t: Templates): { images: GenImage[] } {
  const p = buildPrompts(b, t);
  const inst = b.kind === "instance";
  const images: GenImage[] = [];
  for (const s of p.bodies) {
    const a = ART(b.id, s.theme);
    images.push({ id: `armor-${inst ? s.theme : b.id}-body`, role: inst ? `body:${s.theme}` : "body", target: a.body, size: "1254x1254", purpose: `armor set ${b.id}: body sheet${inst ? ` ${s.theme}` : ""}`, ref: [KEYS.body], prompt: s.body });
  }
  for (const s of p.bodies) {
    const a = ART(b.id, s.theme);
    images.push({ id: `armor-${inst ? s.theme : b.id}-female`, role: inst ? `female:${s.theme}` : "female", target: a.female, size: "1254x1254", purpose: `armor set ${b.id}: the woman's sheet${inst ? ` ${s.theme}` : ""} (chest front kept)`, ref: [KEYS.female, a.body], prompt: s.female });
  }
  const first = ART(b.id, p.bodies[0]?.theme ?? b.id);
  images.push({ id: `armor-${b.id}-helm`, role: "helm", target: first.helm, size: "1254x1254", purpose: `armor set ${b.id}: headgear sheet`, ref: [KEYS.helm, first.body], prompt: p.helm });
  images.push({ id: `armor-${b.id}-shoulder`, role: "shoulder", target: first.shoulder, size: "1254x1254", purpose: `armor set ${b.id}: shoulder sheet`, ref: [KEYS.shoulder, first.body], prompt: p.shoulder });
  return { images };
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
  const again = new Set(images.filter((i) => redo.includes(i.role) || redo.includes(roleKind(i.role))).map((i) => i.target));
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
