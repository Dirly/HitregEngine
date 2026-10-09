import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addItem, auditItemSkills, createSheet, equip, itemSchema, parseSpell, vaultDeposit, vaultSchema, vaultWithdraw, wearEquipped, characterSheetSchema, type CharacterSheet, type Item } from "@hitreg/core";
import { NO_FACTS, evaluateSkill, type HitFacts } from "../../../apps/playground/projects/foundation/scripts/lib/skills.js";
import {
  ABILITIES,
  D3B_SPELLS,
  archetypeFor,
  auditAbilities,
  auditTwisted,
  spellDrift,
  type Ability,
} from "../../../apps/playground/projects/foundation/scripts/lib/abilities.js";
import { schoolOf } from "../../../apps/playground/projects/foundation/scripts/lib/combat-rules.js";
import { describeSkill } from "../../../apps/playground/projects/foundation/scripts/lib/describe-skill.js";
import { deriveLoadout } from "../../../apps/playground/projects/foundation/scripts/lib/loadout.js";
import {
  RARITY_TWISTS,
  TWISTS,
  composeSkill,
  parseTwisted,
  skillTags,
  twistFits,
  twistedId,
} from "../../../apps/playground/projects/foundation/scripts/lib/twists.js";
import { rollTwists, seededRandom, twistableSkills } from "../../../apps/playground/projects/foundation/scripts/lib/loot-twists.js";
// @ts-expect-error a plain .mjs tool, no types
import { STARTER_REQUIREMENT, check as checkRequires } from "../../../apps/playground/projects/foundation/tools/item-requires.mjs";

/**
 * foundation package D3b (docs/combat-build/D3b-spells-twists.md), pure: the
 * 32 spells (audit, schools, generated effects, describeSkill), the items that
 * carry them, rolled twists (composition, the audit on composed skills, the
 * seeded rarity roll, describeSkill with twists, the loadout's twisted ids),
 * twists kept by an instance through the vault and a death's wear, and the
 * starter kit's requirement. The socket half is d3b-spells.test.ts.
 */

const game = path.resolve(__dirname, "../../../apps/playground/projects/foundation");
const ITEMS = path.join(game, "assets/items");
const items: Record<string, Item> = Object.fromEntries(
  readdirSync(ITEMS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.slice(0, -5), itemSchema.parse(JSON.parse(readFileSync(path.join(ITEMS, f), "utf8")))]),
);
const catalog = (id: string): Item | undefined => items[id];
const env = { catalog };
const a = (id: string): Ability => ABILITIES[id]!;
const facts = (on: Partial<HitFacts> = {}): HitFacts => ({ ...NO_FACTS, ...on });
const SPELLS = Object.values(D3B_SPELLS).flat();
const strong = (): CharacterSheet => {
  const sheet = createSheet();
  for (const k of Object.keys(sheet.attributes) as Array<keyof typeof sheet.attributes>) sheet.attributes[k] = 20;
  return sheet;
};

describe("the spells: eight per school", () => {
  it("32 distinct spells, eight per school, all magic, every one passing the audit", () => {
    expect(SPELLS).toHaveLength(32);
    expect(new Set(SPELLS).size).toBe(32);
    for (const [school, ids] of Object.entries(D3B_SPELLS)) {
      expect(ids, school).toHaveLength(8);
      for (const id of ids) {
        expect(a(id).kind, id).toBe("magic");
        // frost keeps its blue look (water) and counts as destruction
        expect(schoolOf(a(id).element), id).toBe(school);
      }
    }
    expect(auditAbilities(Object.fromEntries(SPELLS.map((id) => [id, a(id)])), {})).toEqual([]);
    expect(auditAbilities()).toEqual([]);
  });
  it("frost is destruction on the wheel and blue to the eye", () => {
    expect(a("frostShard").element).toBe("water");
    expect(a("glacialPrison").element).toBe("water");
    expect(a("frostShard").payoffs).toContainEqual({ slow: 1.5 });
    expect(a("glacialPrison").payoffs).toContainEqual({ root: 2 });
  });
  it("support: two heals on an ally, two protective buffs, a counter-cast per school", () => {
    const heals = SPELLS.filter((id) => (a(id).payload.heal ?? 0) > 0);
    expect(heals.sort()).toEqual(["radiantMend", "rejuvenate"]);
    for (const id of heals) expect(a(id).onAlly).toBeDefined();
    const buffs = SPELLS.filter((id) => a(id).onSelf && (a(id).payoffs ?? []).some((p) => "brace" in p));
    expect(buffs.sort()).toEqual(["barkskin", "sanctuary"]);
    for (const ids of Object.values(D3B_SPELLS)) {
      const counters = ids.filter((id) => (a(id).payoffs ?? []).some((p) => "interrupt" in p) && a(id).timing.kind === "projectile");
      expect(counters.length).toBeGreaterThanOrEqual(1);
    }
  });
  it("every way to land is used, and ground telegraphs only on placed areas", () => {
    const kinds = new Set(SPELLS.map((id) => a(id).timing.kind));
    expect([...kinds].sort()).toEqual(["channel", "instant", "projectile", "telegraph", "zone"]);
    expect(SPELLS.some((id) => a(id).timing.volley)).toBe(true);
    expect(SPELLS.some((id) => a(id).timing.homing)).toBe(true);
    expect(SPELLS.some((id) => a(id).delivery.shape === "cone")).toBe(true);
    expect(SPELLS.some((id) => a(id).delivery.shape === "line")).toBe(true);
    for (const id of SPELLS) {
      const t = a(id).timing.kind;
      if (t === "telegraph" || t === "zone" || t === "channel") expect(a(id).delivery.range, id).toBeGreaterThan(0);
    }
  });
  it("each has a generated spell file that matches it (seeded, the school's palette, no drift)", () => {
    for (const id of SPELLS) {
      const file = path.join(game, "assets/spells", `${a(id).spell}.json`);
      expect(existsSync(file), id).toBe(true);
      const doc = parseSpell(JSON.parse(readFileSync(file, "utf8")));
      expect(doc.element, id).toBe(a(id).element);
      expect(typeof doc.seed).toBe("number");
      expect(spellDrift(doc as never, a(id)), id).toEqual([]);
      expect(doc.archetype.effect).toBe(archetypeFor(a(id))["effect"]);
    }
    expect(archetypeFor(a("radiantMend"))).toMatchObject({ kind: "buff", effect: "heal" });
    expect(archetypeFor(a("entangle"))).toMatchObject({ kind: "area", effect: "root" });
    expect(archetypeFor(a("sunlance"))).toMatchObject({ kind: "bolt" });
  });
  it("describeSkill explains every spell, no empty part", () => {
    for (const id of SPELLS) {
      const text = describeSkill(a(id));
      expect(text.length, id).toBeGreaterThan(20);
      expect(text, id).not.toMatch(/undefined|NaN|: \.|  /);
    }
    expect(describeSkill(a("drainLife"))).toMatch(/^Channels on a spot up to 8 m away for 3 s/);
    expect(describeSkill(a("smite"))).toBe("Fires a bolt at the crosshair. If the target is marked by your side: deals ×1.5 damage.");
  });
  it("the school characters, by what the grammar says", () => {
    expect(evaluateSkill(a("smite"), facts({ targetMarked: true })).damageMult).toBe(1.5);
    expect(evaluateSkill(a("wither"), facts({ targetPoisoned: true }))).toMatchObject({ dot: 5, detonate: 8 });
    expect(evaluateSkill(a("soulHarvest"), facts({ targetLowHealth: true }))).toMatchObject({ damageMult: 1.6, mana: 15, cooldownReset: 1 });
    expect(evaluateSkill(a("hexOfSilence"), facts({ targetCasting: true }))).toMatchObject({ silence: 2.5, interrupt: 3 });
    expect(evaluateSkill(a("drainLife"), facts()).lifesteal).toBe(0.5);
    expect(evaluateSkill(a("agony"), facts({ targetMarked: true })).dot).toBe(8);
  });
});

describe("the items that carry the spells", () => {
  const STAFFS = ["pyre-staff", "rimeguard-staff", "thornwood-staff", "grovewarden-staff", "dawnbringer-staff", "lightwarden-staff", "gravecall-staff", "duskwarden-staff"];
  it("every spell has a carrier", () => {
    const carried = new Set(Object.values(items).flatMap((it) => [it.skills?.primary, it.skills?.secondary, ...(it.skills?.bar ?? [])]));
    for (const id of SPELLS) expect(carried.has(id), id).toBe(true);
    expect(auditItemSkills(items)).toEqual([]);
  });
  it("every school has a warding staff and an offensive staff: basic spell on the left, ward or counter-cast on the right, two bar spells", () => {
    for (const school of Object.keys(D3B_SPELLS)) {
      const staffs = STAFFS.map((id) => items[id]!).filter((it) => schoolOf(ABILITIES[it.skills!.primary!]!.element) === school);
      const ward = staffs.find((it) => it.skills?.guard?.kind === "ward");
      const offence = staffs.find((it) => it.skills?.guard?.kind === "none");
      expect(ward?.skills?.guard?.school, school).toBe(school);
      expect(ward?.skills?.secondary).toBe("@ward");
      expect((ABILITIES[offence!.skills!.secondary!]!.payoffs ?? []).some((p) => "interrupt" in p), school).toBe(true);
      for (const it of [ward!, offence!]) {
        expect(it.twoHanded).toBe(true);
        expect(it.skills!.bar).toHaveLength(2);
        for (const id of it.skills!.bar) expect(ABILITIES[id]!.kind).toBe("magic");
      }
    }
  });
  it("the requirement rule: offensive staffs intelligence, warding staffs and heals wisdom (the D3a lint passes)", () => {
    expect(checkRequires()).toEqual([]);
    expect(items["pyre-staff"]!.requires).toEqual({ intelligence: 12 });
    expect(items["lightwarden-staff"]!.requires).toEqual({ wisdom: 12 });
    expect(items["oakheart-charm"]!.requires).toEqual({ wisdom: 12 });
    expect(items["veilstone"]!.requires).toEqual({ intelligence: 12 });
  });
  it("a staff on the bar: basic spell, its right click, two spells", () => {
    const s = strong();
    const r = addItem(s, "thornwood-staff", 1, env);
    if (!r.ok) throw new Error(r.error);
    const e = equip(r.sheet, r.uids[0]!, "primary", env);
    if (!e.ok) throw new Error(e.error);
    expect(deriveLoadout({ sheet: e.sheet, catalog, set: 0, trait: "" })).toMatchObject({ lmb: "thornDart", rmb: "strangleVine", weapon1: "sporeVolley", weapon2: "wither" });
  });
});

describe("the starter kit (no build: 10 everywhere)", () => {
  it("every common gear piece in the player prefab's starting inventory needs 10, so a body with no build wears it", () => {
    expect(STARTER_REQUIREMENT).toBe(10);
    const prefab = JSON.parse(readFileSync(path.join(game, "assets/prefabs/characters/player.json"), "utf8"));
    const kit: Array<{ itemId: string }> = prefab.entities["player-sheet"].components.script.params.startingItems;
    const plain = createSheet();
    let worn = 0;
    for (const { itemId } of kit) {
      const it = items[itemId]!;
      if (it.rarity !== "common" || !it.tags.includes("starter-kit")) continue;
      for (const v of Object.values(it.requires).filter((x): x is number => typeof x === "number")) expect(v, itemId).toBeLessThanOrEqual(10);
      const r = addItem(plain, itemId, 1, env);
      if (!r.ok) throw new Error(r.error);
      const e = equip(r.sheet, r.uids[0]!, undefined, env);
      expect(e.ok, `${itemId}: ${e.ok ? "" : e.error}`).toBe(true);
      worn++;
    }
    expect(worn).toBeGreaterThanOrEqual(25);
  });
});

describe("twists: composition", () => {
  it("composes the base and its twists in one pure function: id, name, payoffs, clauses; nothing else changes", () => {
    const base = a("emberBolt");
    const c = composeSkill(base, [TWISTS["leech"]!, TWISTS["breaker"]!]);
    expect(c.id).toBe("emberBolt+leech+breaker");
    expect(c.name).toBe("Ember Bolt of the Leech and the Breaker");
    expect(c.payoffs).toEqual([{ dot: 2 }, { lifesteal: 0.15 }]);
    expect(c.when).toEqual([...base.when!, { if: "targetWarded", then: [{ shatterWard: 2 }] }]);
    expect({ ...c, id: base.id, name: base.name, payoffs: base.payoffs, when: base.when }).toEqual(base);
    expect(base.payoffs).toEqual([{ dot: 2 }]); // the base is untouched
    expect(composeSkill(base, [])).toBe(base);
  });
  it("the table answers a twisted id, composed and cached; a misfit or unknown twist is no skill", () => {
    const t = ABILITIES["emberBolt+leech"];
    expect(t?.name).toBe("Ember Bolt of the Leech");
    expect(ABILITIES["emberBolt+leech"]).toBe(t);
    expect("emberBolt+leech" in ABILITIES).toBe(true);
    expect(ABILITIES["emberBolt+nonsense"]).toBeUndefined();
    expect(ABILITIES["barkskin+breaker"]).toBeUndefined(); // a clause on a skill with no target
    expect(ABILITIES["radiantMend+focus"]).toBeUndefined(); // a heal on an ally takes no twist
    expect(ABILITIES["strike+leech"]).toBeUndefined(); // nor the held swing
    expect(ABILITIES["emberBolt+leech+leech"]).toBeUndefined(); // one of each
    expect(ABILITIES["frostShard+frost"]).toBeUndefined(); // nothing new: it slows already
    expect(ABILITIES["chainLightning+hunted"]).toBeUndefined(); // it crits a marked target already
    expect(Object.keys(ABILITIES).some((k) => k.includes("+"))).toBe(false);
  });
  it("evaluates the twist's payoffs where the hit resolves: a plain copy does not", () => {
    const plain = evaluateSkill(a("emberBolt"), facts({ targetWarded: true }));
    const twisted = evaluateSkill(ABILITIES["emberBolt+leech+breaker"], facts({ targetWarded: true }));
    expect(plain).toMatchObject({ lifesteal: 0, shatterWard: 0, dot: 2 });
    expect(twisted).toMatchObject({ lifesteal: 0.15, shatterWard: 2, dot: 2 });
    expect(evaluateSkill(ABILITIES["emberBolt+leech+breaker"], facts()).shatterWard).toBe(0);
  });
  it("tags decide what fits", () => {
    expect(skillTags(a("chainLightning"))).toEqual(["harm", "shot", "magic"]);
    expect(skillTags(a("shieldCharge"))).toEqual(["harm", "strike", "physical", "move"]);
    expect(skillTags(a("barkskin"))).toEqual(["self", "magic"]);
    expect(twistFits(TWISTS["juggernaut"]!, a("shieldCharge"))).toBe(false); // it staggers after its run already
    expect(twistFits(TWISTS["juggernaut"]!, a("leapingCleave"))).toBe(true);
    expect(twistFits(TWISTS["juggernaut"]!, a("emberBolt"))).toBe(false);
    expect(twistFits(TWISTS["stormCrown"]!, a("pyroclasm"))).toBe(false); // a chain never rides a lingering volume
    expect(twistFits(TWISTS["longNight"]!, a("barkskin"))).toBe(true);
  });
});

describe("twists: the audit on composed skills", () => {
  it("every twist on every skill it fits either passes or is refused by a named rule", () => {
    let passed = 0;
    for (const base of Object.values(ABILITIES)) {
      for (const t of Object.values(TWISTS)) {
        if (!twistFits(t, base)) continue;
        const v = auditTwisted(composeSkill(base, [t]), base);
        if (v.length === 0) passed++;
        else for (const x of v) expect(["twist-sum", "twist-mult", "control", "bounded", "interrupt", "chain", "self", "stealth", "opener", "dot"]).toContain(x.rule);
      }
    }
    expect(passed).toBeGreaterThan(1000);
  });
  it("refuses a twist that pushes a payoff past its bound, or the damage past ×2.5, or the crowd control past 4 s", () => {
    // vampiric strike already drains 0.4 (0.8 when low): the leech would take it past 0.5
    expect(auditTwisted(composeSkill(a("vampiricStrike"), [TWISTS["leech"]!]), a("vampiricStrike")).map((v) => v.rule)).toContain("twist-sum");
    // ambush is x2.5 on an unaware target already
    expect(auditTwisted(composeSkill(a("ambush"), [TWISTS["executioner"]!]), a("ambush")).map((v) => v.rule)).toContain("twist-mult");
    // glacial prison roots 2 and slows 3 (3.5 s); the hangman's root would pass 4 s
    expect(auditTwisted(composeSkill(a("glacialPrison"), [TWISTS["hangman"]!]), a("glacialPrison")).map((v) => v.rule)).toContain("control");
    expect(ABILITIES["glacialPrison+hangman"]).toBeUndefined();
    // and a plain good one passes
    expect(auditTwisted(composeSkill(a("frostShard"), [TWISTS["executioner"]!]), a("frostShard"))).toEqual([]);
  });
});

describe("twists: the rarity roll", () => {
  const staff = items["pyre-staff"]!;
  it("is seeded and deterministic", () => {
    const r = seededRandom("seed-1");
    const s = seededRandom("seed-1");
    for (let i = 0; i < 5; i++) expect(r()).toBe(s());
    for (const rarity of Object.keys(RARITY_TWISTS)) {
      expect(rollTwists({ ...staff, rarity }, "drop-7")).toEqual(rollTwists({ ...staff, rarity }, "drop-7"));
    }
  });
  it("by rarity: common none, uncommon one small, rare one conditional, epic two, legendary one unique", () => {
    const tierOf = (e: string): string => TWISTS[parseTwisted(e).twists[0]!]!.tier;
    for (let i = 0; i < 40; i++) {
      const seed = `drop-${i}`;
      expect(rollTwists({ ...staff, rarity: "common" }, seed)).toEqual([]);
      expect(rollTwists({ ...staff, rarity: "uncommon" }, seed).map(tierOf)).toEqual(["small"]);
      expect(rollTwists({ ...staff, rarity: "rare" }, seed).map(tierOf)).toEqual(["conditional"]);
      expect(rollTwists({ ...staff, rarity: "epic" }, seed).map(tierOf)).toEqual(["conditional", "small"]);
      expect(rollTwists({ ...staff, rarity: "legendary" }, seed).map(tierOf)).toEqual(["unique"]);
    }
  });
  it("lands only on the item's own twistable skills, and every rolled instance passes the audit as cast", () => {
    const seen = new Set<string>();
    for (const [id, item] of Object.entries(items)) {
      const skills = twistableSkills(item);
      for (const rarity of ["uncommon", "rare", "epic", "legendary"]) {
        for (let i = 0; i < 6; i++) {
          const entries = rollTwists({ ...item, rarity }, `${id}:${rarity}:${i}`);
          for (const e of entries) {
            expect(skills).toContain(parseTwisted(e).base);
            seen.add(parseTwisted(e).twists[0]!);
          }
          for (const skill of skills) {
            const cast = twistedId(skill, entries);
            expect(ABILITIES[cast], `${id} ${cast}`).toBeDefined();
          }
        }
      }
    }
    // the table is wide: most twists come up somewhere
    expect(seen.size).toBeGreaterThan(Object.keys(TWISTS).length * 0.75);
  });
  it("an item with only a self skill falls back to a small twist when a rare roll has no clause to fit", () => {
    const veil = items["veilstone"]!;
    const rolled = rollTwists({ ...veil, rarity: "rare" }, "x");
    expect(rolled).toHaveLength(1);
    expect(TWISTS[parseTwisted(rolled[0]!).twists[0]!]!.tier).toBe("small");
    expect(twistableSkills(items["iron-arming-sword"]!)).toEqual(["cleave"]); // the swing is never twisted
    expect(twistableSkills(items["lightwarden-staff"]!)).toEqual(["sanctuary", "smite"]); // nor the heal on an ally
  });
});

describe("twists on an instance", () => {
  const twisted = (): { sheet: CharacterSheet; uid: string } => {
    const r = addItem(strong(), "pyre-staff", 1, env);
    if (!r.ok) throw new Error(r.error);
    const uid = r.uids[0]!;
    r.sheet.items[uid]!.twists = ["emberBolt+leech", "chainLightning+executioner"];
    return { sheet: r.sheet, uid };
  };
  it("the loadout binds each skill as the instance casts it; a second plain copy binds the plain skill", () => {
    const { sheet, uid } = twisted();
    const e = equip(sheet, uid, "primary", env);
    if (!e.ok) throw new Error(e.error);
    expect(deriveLoadout({ sheet: e.sheet, catalog, set: 0, trait: "" })).toMatchObject({
      lmb: "emberBolt+leech",
      rmb: "spellSnap",
      weapon1: "pyroclasm",
      weapon2: "chainLightning+executioner",
    });
    const plain = addItem(strong(), "pyre-staff", 1, env);
    if (!plain.ok) throw new Error(plain.error);
    const p = equip(plain.sheet, plain.uids[0]!, "primary", env);
    if (!p.ok) throw new Error(p.error);
    expect(deriveLoadout({ sheet: p.sheet, catalog, set: 0, trait: "" })).toMatchObject({ lmb: "emberBolt", weapon2: "chainLightning" });
  });
  it("the sheet schema keeps them (a save, a reconnect), and so do the vault and a death's wear", () => {
    const { sheet, uid } = twisted();
    expect(characterSheetSchema.parse(JSON.parse(JSON.stringify(sheet))).items[uid]!.twists).toEqual(["emberBolt+leech", "chainLightning+executioner"]);
    const vault = vaultSchema.parse({});
    const dep = vaultDeposit(sheet, vault, uid, undefined, env);
    if (!dep.ok) throw new Error(dep.error);
    expect(dep.vault.items[0]).toMatchObject({ itemId: "pyre-staff", twists: ["emberBolt+leech", "chainLightning+executioner"] });
    expect(vaultSchema.parse(JSON.parse(JSON.stringify(dep.vault))).items[0]!.twists).toHaveLength(2);
    const back = vaultWithdraw(dep.sheet, dep.vault, 0, undefined, env);
    if (!back.ok) throw new Error(back.error);
    const stack = Object.values(back.sheet.items).find((s) => s.itemId === "pyre-staff")!;
    expect(stack.twists).toEqual(["emberBolt+leech", "chainLightning+executioner"]);
    const e = equip(sheet, uid, "primary", env);
    if (!e.ok) throw new Error(e.error);
    const worn = wearEquipped(e.sheet, env, 0.1).sheet;
    expect(worn.items[uid]!.durability).toBeLessThan(60);
    expect(worn.items[uid]!.twists).toEqual(["emberBolt+leech", "chainLightning+executioner"]);
  });
  it("describeSkill with twists: the twisted name, then the base text with the twists' sentences", () => {
    const t = ABILITIES[twistedId("chainLightning", ["chainLightning+executioner", "emberBolt+leech"])]!;
    expect(t.name).toBe("Chain Lightning of the Executioner");
    expect(describeSkill(t)).toBe(
      "Fires a bolt at the crosshair. Every hit jumps to another enemy within 7 m at 60%. If the target is marked by your side: is a certain critical hit. If the target is below 35% health: deals ×1.3 damage.",
    );
    const u = ABILITIES["frostShard+embers+executioner"]!;
    expect(u.name).toBe("Frost Shard of Embers and the Executioner");
    expect(describeSkill(u)).toBe(
      "Fires a bolt at the crosshair. Every hit slows it to 50% speed for 1.5 s and poisons it for 2 a second over 6 s. If the target is below 35% health: deals ×1.3 damage.",
    );
  });
});
