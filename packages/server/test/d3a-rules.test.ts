import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditItemSkills, itemSchema, type Item } from "@hitreg/core";
import {
  CHAIN,
  CHARGE,
  CONDITIONS,
  HASTE,
  LOW_HEALTH,
  NO_FACTS,
  PAYOFF_KEYS,
  SELF_PAYOFF_KEYS,
  SHOVE,
  SLOW,
  controlSeconds,
  detonateBurst,
  evaluateSkill,
  payoffKey,
  type Condition,
  type HitFacts,
  type Payoff,
} from "../../../apps/playground/projects/voxel-demo/scripts/lib/skills.js";
import {
  ABILITIES,
  CONTROL_MAX_SECONDS,
  MOVE_MAX_METRES,
  auditAbilities,
  moveDistance,
  type Ability,
} from "../../../apps/playground/projects/voxel-demo/scripts/lib/abilities.js";
import { CONDITION_PHRASE, describeSkill, payoffPhrase } from "../../../apps/playground/projects/voxel-demo/scripts/lib/describe-skill.js";
// @ts-expect-error a plain .mjs tool, no types
import { check as checkRequires, creationProblems } from "../../../apps/playground/projects/voxel-demo/tools/item-requires.mjs";

/**
 * voxel-demo package D3a (docs/combat-build/D3a-skill-library.md), pure: the
 * eight new conditions and twelve new payoffs, describeSkill, the new audit
 * rules, the roster, the items that carry it, and the stat requirements. The
 * socket half is d3a-skills.test.ts.
 */

const game = path.resolve(__dirname, "../../../apps/playground/projects/voxel-demo");
const facts = (on: Partial<HitFacts> = {}): HitFacts => ({ ...NO_FACTS, ...on });
const a = (id: string): Ability => ABILITIES[id]!;
const ITEMS = path.join(game, "assets/items");
const items: Record<string, Item> = Object.fromEntries(
  readdirSync(ITEMS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.slice(0, -5), itemSchema.parse(JSON.parse(readFileSync(path.join(ITEMS, f), "utf8")))]),
);

const NEW_CONDITIONS: Condition[] = ["targetWarded", "targetBlocking", "targetLowHealth", "targetPoisoned", "selfStealthed", "afterPerfectWard", "selfLowHealth", "afterCharge"];

/** The package D3a roster: physical and trinket skills. */
const ROSTER = [
  "riposteCut", "wardbreaker", "lungingThrust", "finishingCut", "brandStrike", "spiritRend", "venomRupture",
  "shieldCharge", "shieldShove", "bulwarkSlam", "rebuke",
  "shadowPass", "cheapShot", "hamstring", "envenomedStab",
  "guardsplitter", "executionersSwing",
  "reapingHook", "rendingChop", "berserkChop", "leapingCleave",
  "skullcracker", "shatteringBlow", "concussiveBlow",
  "vaultingStrike", "sweepTheLegs",
  "disengage", "crippleShot", "barbedArrow",
  "backstep", "blink", "stepBehind", "sprintBurst", "chainHook",
  "bolas", "ricochetKnife", "vampiricStrike", "secondWind", "spellturnStrike", "predatorsPounce", "garrote", "ruinousTouch", "throatJab", "crushingElbow", "lastStand",
];
const MOVEMENT = ["shieldCharge", "leapingCleave", "shadowPass", "reapingHook", "chainHook", "backstep", "disengage", "blink", "stepBehind", "sprintBurst", "riposteCut", "spellturnStrike"];

describe("evaluateSkill: the D3a conditions", () => {
  it("are known, eight of them, and keep the six that existed", () => {
    for (const c of NEW_CONDITIONS) expect(CONDITIONS).toContain(c);
    for (const c of ["targetCasting", "fromBehind", "targetUnaware", "afterParry", "targetStaggered", "targetMarked"]) expect(CONDITIONS).toContain(c);
    expect(CONDITIONS.length).toBe(14);
  });
  it("each gates only its own clause", () => {
    const rules = { when: NEW_CONDITIONS.map((c, i) => ({ if: c, then: [{ threat: 1 + i } as Payoff] })) };
    NEW_CONDITIONS.forEach((c, i) => {
      const out = evaluateSkill(rules, facts({ [c]: true }));
      expect(out.met, c).toEqual([c]);
      expect(out.threat, c).toBe(1 + i);
    });
    expect(evaluateSkill(rules, facts()).met).toEqual([]);
  });
  it("combine with the old ones in one clause (all must hold)", () => {
    const rules = { when: [{ if: ["afterCharge", "targetBlocking"] as Condition[], then: [{ stagger: 1 }] }] };
    expect(evaluateSkill(rules, facts({ afterCharge: true })).stagger).toBe(0);
    expect(evaluateSkill(rules, facts({ afterCharge: true, targetBlocking: true })).stagger).toBe(1);
  });
});

describe("evaluateSkill: the D3a payoffs", () => {
  const one = (p: Payoff) => evaluateSkill({ payoffs: [p] }, facts());
  it("are known keys with valid values", () => {
    for (const k of ["shatterWard", "stealWard", "knockback", "pull", "slow", "root", "silence", "cooldownReset", "lifesteal", "chain", "detonate", "haste"]) {
      expect(PAYOFF_KEYS).toContain(k);
      expect(payoffKey({ [k]: 1 }), k).toBe(k);
      expect(payoffKey({ [k]: -1 }), k).toBeNull();
    }
    expect(SELF_PAYOFF_KEYS).toContain("haste");
  });
  it("seconds keep the longest", () => {
    for (const k of ["shatterWard", "slow", "root", "silence", "haste"] as const) {
      const out = evaluateSkill({ payoffs: [{ [k]: 2 } as Payoff, { [k]: 5 } as Payoff, { [k]: 3 } as Payoff] }, facts());
      expect(out[k], k).toBe(5);
    }
  });
  it("a shove keeps the furthest, capped at SHOVE.maxMetres", () => {
    expect(one({ knockback: 3 }).knockback).toBe(3);
    expect(one({ pull: 99 }).pull).toBe(SHOVE.maxMetres);
    expect(evaluateSkill({ payoffs: [{ knockback: 2 }, { knockback: 4 }] }, facts()).knockback).toBe(4);
  });
  it("shares add up to one; steal and chain keep the largest; detonate adds", () => {
    expect(evaluateSkill({ payoffs: [{ lifesteal: 0.4 }, { lifesteal: 0.4 }] }, facts()).lifesteal).toBeCloseTo(0.8);
    expect(evaluateSkill({ payoffs: [{ cooldownReset: 0.7 }, { cooldownReset: 0.7 }] }, facts()).cooldownReset).toBe(1);
    expect(evaluateSkill({ payoffs: [{ stealWard: 10 }, { stealWard: 25 }] }, facts()).stealWard).toBe(25);
    expect(evaluateSkill({ payoffs: [{ chain: 4 }, { chain: 6 }] }, facts()).chain).toBe(6);
    expect(evaluateSkill({ payoffs: [{ detonate: 5 }, { detonate: 5 }] }, facts()).detonate).toBe(10);
  });
  it("nothing by default", () => {
    const out = evaluateSkill(undefined, facts());
    for (const k of ["shatterWard", "stealWard", "knockback", "pull", "slow", "root", "silence", "cooldownReset", "lifesteal", "chain", "detonate", "haste"] as const) expect(out[k], k).toBe(0);
  });
  it("a detonation sets off a mark, a poison and what the poison had left", () => {
    expect(detonateBurst(10, false, 0)).toBe(0);
    expect(detonateBurst(10, true, 0)).toBe(10);
    expect(detonateBurst(10, false, 12)).toBe(22);
    expect(detonateBurst(10, true, 12)).toBe(32);
    expect(detonateBurst(0, true, 12)).toBe(0);
  });
  it("crowd control is counted in seconds: stagger, root, silence in full, half a slow, a shove's length", () => {
    expect(controlSeconds({ payoffs: [{ stagger: 1 }, { root: 1 }, { silence: 1 }, { slow: 2 }, { knockback: 3 }] })).toBeCloseTo(4 + SHOVE.seconds);
    expect(controlSeconds({ when: [{ if: "fromBehind", then: [{ root: 2 }] }] })).toBe(2);
  });
  it("first values", () => {
    expect(LOW_HEALTH.share).toBe(0.35);
    expect(CHARGE.minDistance).toBe(5);
    expect(SLOW.speedMult).toBe(0.5);
    expect(HASTE.speedMult).toBe(1.4);
    expect(CHAIN.share).toBe(0.6);
  });
});

describe("describeSkill", () => {
  it("Derek's example reads as a sentence per part", () => {
    expect(describeSkill(a("kidneyPunch"))).toBe("Strikes in a narrow cone. If the target is casting: interrupts it and locks that school for 4 s and returns 14 stamina.");
  });
  it("every condition and every payoff has its own phrase", () => {
    for (const c of CONDITIONS) expect(CONDITION_PHRASE[c], c).toMatch(/\w/);
    for (const k of PAYOFF_KEYS) expect(payoffPhrase({ [k]: k === "crit" ? true : 2 } as Payoff), k).toMatch(/\w/);
  });
  it("says how a skill lands and moves", () => {
    expect(describeSkill(a("shieldCharge"))).toMatch(/^Charges up to 10 m and hits the first enemy in the way\. A heavy blow/);
    expect(describeSkill(a("shieldCharge"))).toContain("If your run-in covered 5 m or more: staggers it for 1.2 s.");
    expect(describeSkill(a("leapingCleave"))).toMatch(/^Leaps to a spot up to 10 m away/);
    expect(describeSkill(a("shadowPass"))).toMatch(/^Dashes 5 m through everything in a line\./);
    expect(describeSkill(a("backstep"))).toBe("Hops you 3.5 m straight back.");
    expect(describeSkill(a("disengage"))).toMatch(/then hops you 6 m back\. Every hit knocks it back 2 m and slows it to 50% speed for 3 s\.$/);
    expect(describeSkill(a("blink"))).toMatch(/^Blinks you to the spot under your crosshair, up to 8 m away/);
    expect(describeSkill(a("stepBehind"))).toMatch(/^Steps you out behind the enemy under your crosshair/);
    expect(describeSkill(a("sprintBurst"))).toBe("On yourself. It speeds you up 40% for 5 s.");
    expect(describeSkill(a("chainHook"))).toBe("Fires a shot at the crosshair. Every hit pulls it 5 m toward you. If the target is casting: interrupts it and locks that school for 3 s.");
  });
  it("a combined clause reads both conditions", () => {
    expect(describeSkill(a("ambush"))).toContain("If the target has not noticed you and you strike from behind: is a certain critical hit.");
  });
  it("every skill in the table explains itself without an empty part", () => {
    for (const ab of Object.values(ABILITIES)) {
      const text = describeSkill(ab);
      expect(text, ab.id).toMatch(/\.$/);
      expect(text, ab.id).not.toMatch(/undefined|NaN|: \.|  /);
    }
  });
});

describe("the D3a roster", () => {
  it("about 45 skills, all present, all distinct ideas (no two share the same grammar and delivery)", () => {
    expect(ROSTER.length).toBe(45);
    const seen = new Map<string, string>();
    for (const id of ROSTER) {
      const ab = a(id);
      expect(ab, id).toBeDefined();
      const sig = JSON.stringify([ab.delivery.shape, ab.lunge?.style ?? (ab.lunge ? "lunge" : ""), ab.leap ? "leap" : "", ab.blink ?? "", ab.payoffs ?? [], ab.when ?? []]);
      expect(seen.get(sig), `${id} repeats ${seen.get(sig)}`).toBeUndefined();
      seen.set(sig, id);
    }
  });
  it("the whole table passes the audit", () => {
    expect(auditAbilities()).toEqual([]);
  });
  it("movement is a family of its own: gap closers, escapes, repositioning, speed", () => {
    for (const id of MOVEMENT) {
      const ab = a(id);
      const moves = moveDistance(ab) > 0 || [...(ab.payoffs ?? []), ...(ab.when ?? []).flatMap((c) => c.then)].some((p) => "pull" in p || "haste" in p);
      expect(moves, id).toBe(true);
      expect(ab.cooldown, id).toBeGreaterThan(0);
      expect(ab.cost.stamina + ab.cost.mana, id).toBeGreaterThan(0);
    }
    expect(a("shieldCharge").lunge?.style).toBe("charge");
    expect(a("leapingCleave").leap).toBeDefined();
    expect(a("shadowPass").lunge?.style).toBe("through");
    expect(a("backstep").lunge?.style).toBe("back");
    expect(a("disengage").lunge?.style).toBe("back");
    expect(a("blink").blink).toBe("point");
    expect(a("stepBehind").blink).toBe("behind");
    expect(a("riposteCut").when?.[0]?.if).toBe("afterParry");
    expect(a("spellturnStrike").when?.[0]?.if).toBe("afterPerfectWard");
  });
  it("nothing in the table grants invulnerability (no field for it exists, and no movement skill skips a hit)", () => {
    for (const ab of Object.values(ABILITIES)) expect(Object.keys(ab), ab.id).not.toContain("invulnerable");
  });
  it("every new condition and payoff is used by at least one skill", () => {
    const used = new Set<string>();
    for (const id of ROSTER) {
      const ab = a(id);
      for (const c of ab.when ?? []) for (const x of Array.isArray(c.if) ? c.if : [c.if]) used.add(x);
      for (const p of [...(ab.payoffs ?? []), ...(ab.when ?? []).flatMap((c) => c.then)]) used.add(payoffKey(p) ?? "");
    }
    for (const c of NEW_CONDITIONS) expect(used, c).toContain(c);
    for (const k of ["shatterWard", "stealWard", "knockback", "pull", "slow", "root", "silence", "cooldownReset", "lifesteal", "chain", "detonate", "haste"]) expect(used, k).toContain(k);
  });
});

describe("auditAbilities: the D3a rules", () => {
  const audit = (x: Partial<Ability>, base = "wardbreaker") => auditAbilities({ x: { ...a(base), id: "x", ...x } }, {}).map((v) => v.rule);
  it("payoffs are bounded", () => {
    expect(audit({ payoffs: [{ root: 2.5 }] })).toEqual([]);
    expect(audit({ payoffs: [{ root: 3 }] })).toContain("bounded");
    expect(audit({ payoffs: [{ lifesteal: 0.6 }] })).toContain("bounded");
    expect(audit({ payoffs: [{ silence: 4 }] })).toContain("bounded");
    expect(audit({ payoffs: [{ chain: 9 }] })).toContain("bounded");
  });
  it("total crowd control per skill is capped", () => {
    expect(audit({ payoffs: [{ root: 2 }, { silence: 2 }] })).toEqual([]);
    expect(audit({ payoffs: [{ root: 2 }, { silence: 2 }], when: [{ if: "fromBehind", then: [{ stagger: 1 }] }] })).toContain("control");
    expect(CONTROL_MAX_SECONDS).toBe(4);
  });
  it("a charge has the heavy tell", () => {
    expect(audit({}, "shieldCharge")).toEqual([]);
    expect(audit({ attackClass: "light" }, "shieldCharge")).toContain("charge");
    expect(audit({ timing: { ...a("shieldCharge").timing, windup: 0.7 } }, "shieldCharge")).toContain("charge");
  });
  it("movement is bounded, paid for and timed", () => {
    expect(audit({ lunge: { distance: MOVE_MAX_METRES + 1, duration: 0.3 } })).toContain("move");
    expect(audit({ lunge: { distance: 3, duration: 0.3 }, cooldown: 0 })).toContain("move");
    expect(audit({ lunge: { distance: 3, duration: 0.6 } })).toContain("move");
    expect(audit({ delivery: { ...a("blink").delivery, range: 20 } }, "blink")).toContain("move");
    expect(audit({ onSelf: undefined }, "blink")).toContain("blink");
  });
  it("a dash through is the swept line; a leap is placed; a chain is a single hit", () => {
    expect(audit({ delivery: { shape: "cone", radius: 6, angle: 30, range: 0, height: 2 } }, "shadowPass")).toContain("through");
    expect(audit({ delivery: { shape: "circle", radius: 2, range: 0, height: 2 } }, "leapingCleave")).toContain("leap");
    expect(audit({ payoffs: [{ chain: 4 }], timing: { kind: "zone", windup: 1, recovery: 0.3, commit: 0.8, duration: 2, ticksPerSecond: 1 } })).toContain("chain");
  });
});

describe("the D3a items", () => {
  const carriers = (skill: string): string[] => Object.entries(items).filter(([, it]) => it.skills?.bar.slice(0, it.twoHanded ? 2 : 1).includes(skill)).map(([id]) => id);
  it("every roster skill has a carrier, and every item fits its hands", () => {
    for (const id of ROSTER) expect(carriers(id).length, id).toBeGreaterThan(0);
    expect(auditItemSkills(items)).toEqual([]);
  });
  it("items of one type carry different skills", () => {
    const of = (pred: (id: string, it: Item) => boolean): Set<string> =>
      new Set(Object.entries(items).filter(([id, it]) => pred(id, it)).map(([, it]) => JSON.stringify(it.skills?.bar)));
    const swords = Object.entries(items).filter(([, it]) => it.tags.includes("longsword-family") && !it.twoHanded);
    expect(of((_, it) => it.tags.includes("longsword-family") && !it.twoHanded).size).toBeGreaterThanOrEqual(swords.length - 1);
    expect(of((_, it) => it.tags.includes("shield")).size).toBeGreaterThanOrEqual(5);
    expect(of((_, it) => it.tags.includes("greatsword-family")).size).toBe(4);
    expect(of((_, it) => it.tags.includes("greataxe-family")).size).toBe(3);
  });
  it("one skill for a one-hander, an offhand item and a trinket; two for a two-hander", () => {
    for (const [id, it] of Object.entries(items)) {
      if (!it.skills?.bar.length) continue;
      expect(it.skills.bar.length, id).toBe(it.twoHanded ? 2 : 1);
    }
  });
  it("the new trinkets use existing icons", () => {
    for (const id of ROSTER) {
      for (const c of carriers(id).filter((c) => items[c]!.slots.includes("trinket"))) {
        expect(() => readFileSync(path.join(game, "assets/textures", items[c]!.icon!)), c).not.toThrow();
      }
    }
  });
});

describe("stat requirements", () => {
  it("every equippable item carries the rule's requirement (tools/item-requires.mjs)", () => {
    expect(checkRequires()).toEqual([]);
  });
  it("every archetype can wear its starting kit at creation", () => {
    expect(creationProblems()).toEqual([]);
  });
  it("a base item needs 11 or 12; rarity raises it", () => {
    // package D3b: the player prefab's own starting kit (tag starter-kit) needs 10, what a body with no build has
    expect(items["iron-arming-sword"]!.requires).toEqual({ strength: 10 });
    expect(items["rusted-sword"]!.requires).toEqual({ strength: 10 });
    expect(items["chain-shirt"]!.requires).toEqual({ strength: 12 });
    expect(items["ranger-chest"]!.requires).toEqual({ dexterity: 11 });
    expect(items["magus-chest"]!.requires).toEqual({ intelligence: 11 });
    expect(items["training-staff"]!.requires).toEqual({ wisdom: 10 });
    expect(items["hedge-staff"]!.requires).toEqual({ wisdom: 12 });
    expect(items["warden-staff"]!.requires).toEqual({ wisdom: 14 });
    expect(items["menders-sun-disc"]!.requires).toEqual({ wisdom: 12 });
    expect(items["gravewarden-aegis"]!.requires).toEqual({ strength: 18 });
    expect(items["steel-longsword"]!.requires).toEqual({ strength: 11 }); // one-handed: "strength, lower"
  });
});
