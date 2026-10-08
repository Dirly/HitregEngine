import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONDITIONS,
  NO_FACTS,
  PAYOFF_KEYS,
  RIPOSTE,
  evaluateSkill,
  payoffKey,
  type Condition,
  type HitFacts,
  type Payoff,
} from "../../../apps/playground/projects/voxel-demo/scripts/lib/skills.js";
import { ABILITIES, INTERRUPT_MAX_DAMAGE, auditAbilities, type Ability } from "../../../apps/playground/projects/voxel-demo/scripts/lib/abilities.js";

/**
 * voxel-demo's skill grammar (lib/skills.ts, package D1), pure: every
 * condition, every payoff, the riposte, and the audit's bounds on the grammar.
 * combat-actor applies what `evaluateSkill` returns; skills.test.ts proves that
 * over sockets. Imports the game by path, like defence-rules.test.ts.
 */

const facts = (on: Partial<HitFacts> = {}): HitFacts => ({ ...NO_FACTS, ...on });

describe("evaluateSkill: conditions", () => {
  it.each(CONDITIONS.map((c) => [c]))("%s gates its clause, and only its clause", (cond: Condition) => {
    const rules = { when: [{ if: cond, then: [{ stamina: 10 } as Payoff] }] };
    expect(evaluateSkill(rules, facts()).stamina).toBe(0);
    const met = evaluateSkill(rules, facts({ [cond]: true }));
    expect(met.stamina).toBe(10);
    expect(met.met).toEqual([cond]);
    // every OTHER fact true leaves it shut
    const others = Object.fromEntries(CONDITIONS.filter((c) => c !== cond).map((c) => [c, true]));
    expect(evaluateSkill(rules, facts(others)).stamina).toBe(0);
  });

  it("a list of conditions needs them all", () => {
    const rules = { when: [{ if: ["fromBehind", "targetUnaware"] as Condition[], then: [{ damageMult: 3 } as Payoff] }] };
    expect(evaluateSkill(rules, facts({ fromBehind: true })).damageMult).toBe(1);
    expect(evaluateSkill(rules, facts({ fromBehind: true, targetUnaware: true })).damageMult).toBe(3);
  });

  it("unconditional payoffs always apply; clauses stack on top", () => {
    const rules = { payoffs: [{ interrupt: 4 } as Payoff], when: [{ if: "targetCasting" as Condition, then: [{ stamina: 14 } as Payoff] }] };
    expect(evaluateSkill(rules, facts())).toMatchObject({ interrupt: 4, stamina: 0 });
    expect(evaluateSkill(rules, facts({ targetCasting: true }))).toMatchObject({ interrupt: 4, stamina: 14 });
  });

  it("no rules and no riposte: nothing at all", () => {
    expect(evaluateSkill(undefined, facts())).toMatchObject({
      crit: false,
      consumeRiposte: false,
      damageMult: 1,
      stamina: 0,
      mana: 0,
      heal: 0,
      mark: 0,
      stagger: 0,
      interrupt: null,
      threat: 0,
      threatMult: 1,
      taunt: 0,
      met: [],
    });
  });
});

describe("evaluateSkill: payoffs", () => {
  const one = (p: Payoff) => evaluateSkill({ payoffs: [p] }, facts());
  it("stamina, mana and heal add up", () => {
    expect(one({ stamina: 5 }).stamina).toBe(5);
    expect(one({ mana: 7 }).mana).toBe(7);
    expect(one({ heal: 9 }).heal).toBe(9);
    expect(evaluateSkill({ payoffs: [{ stamina: 5 }, { stamina: 6 }] }, facts()).stamina).toBe(11);
  });
  it("crit forces the crit", () => {
    expect(one({ crit: true }).crit).toBe(true);
  });
  it("damageMult and threatMult multiply", () => {
    expect(evaluateSkill({ payoffs: [{ damageMult: 2 }, { damageMult: 1.5 }] }, facts()).damageMult).toBe(3);
    expect(evaluateSkill({ payoffs: [{ threatMult: 2 }, { threatMult: 2 }] }, facts()).threatMult).toBe(4);
  });
  it("mark, stagger, interrupt and taunt keep the longest", () => {
    const s = evaluateSkill({ payoffs: [{ mark: 3 }, { mark: 8 }, { stagger: 1 }, { stagger: 0.5 }, { interrupt: 2 }, { interrupt: 4 }, { taunt: 4 }, { taunt: 2 }] }, facts());
    expect(s).toMatchObject({ mark: 8, stagger: 1, interrupt: 4, taunt: 4 });
  });
  it("an interrupt of 0 seconds is still an interrupt", () => {
    expect(one({ interrupt: 0 }).interrupt).toBe(0);
  });
  it("threat is flat", () => {
    expect(one({ threat: 25 }).threat).toBe(25);
  });
  it("payoffKey accepts exactly one known key with a sane value", () => {
    for (const k of PAYOFF_KEYS) expect(payoffKey({ [k]: k === "crit" ? true : 1 })).toBe(k);
    expect(payoffKey({ stamina: 1, mana: 1 })).toBeNull();
    expect(payoffKey({ stamnia: 1 })).toBeNull();
    expect(payoffKey({ stamina: -1 })).toBeNull();
    expect(payoffKey({ crit: 1 })).toBeNull();
    expect(payoffKey({})).toBeNull();
  });
});

describe("evaluateSkill: the riposte", () => {
  it("an open riposte window crits ANY hit and spends the window", () => {
    expect(evaluateSkill(undefined, facts({ afterParry: true }))).toMatchObject({ crit: true, consumeRiposte: true });
    expect(evaluateSkill(ABILITIES["strike"], facts({ afterParry: true }))).toMatchObject({ crit: true, consumeRiposte: true });
  });
  it("lasts three seconds", () => {
    expect(RIPOSTE.seconds).toBe(3);
  });
});

describe("the D1 skills", () => {
  const a = (id: string): Ability => ABILITIES[id]!;
  it("all exist and pass the whole audit", () => {
    for (const id of ["pummel", "kick", "shieldBash", "kidneyPunch", "counterCast", "backstab", "mend", "taunt", "markTarget"]) expect(a(id), id).toBeDefined();
    expect(auditAbilities()).toEqual([]);
  });
  it("kidney punch: interrupt + stamina on a caster, a plain hit otherwise", () => {
    expect(evaluateSkill(a("kidneyPunch"), facts())).toMatchObject({ interrupt: null, stamina: 0 });
    expect(evaluateSkill(a("kidneyPunch"), facts({ targetCasting: true }))).toMatchObject({ interrupt: 4, stamina: 14 });
  });
  it("pummel, kick, shield bash and counter-cast always interrupt; the counter-cast is magic", () => {
    for (const id of ["pummel", "kick", "shieldBash", "counterCast"]) expect(evaluateSkill(a(id), facts()).interrupt, id).toBe(4);
    expect(a("counterCast")).toMatchObject({ kind: "magic", attackClass: "spell" });
    expect(a("pummel").kind).toBe("physical");
  });
  it("backstab: plain from the front, x1.75 from behind, a crit on a marked target", () => {
    expect(evaluateSkill(a("backstab"), facts()).damageMult).toBe(1);
    expect(evaluateSkill(a("backstab"), facts({ fromBehind: true })).damageMult).toBe(1.75);
    expect(evaluateSkill(a("backstab"), facts({ targetMarked: true })).crit).toBe(true);
  });
  it("mend heals an ally and carries no harm; taunt and mark do nothing but their payoff", () => {
    expect(a("mend")).toMatchObject({ onAlly: { range: 20 }, payload: { damage: 0, control: 0, heal: 40 } });
    expect(evaluateSkill(a("taunt"), facts())).toMatchObject({ taunt: 4, mark: 0, interrupt: null });
    expect(evaluateSkill(a("markTarget"), facts())).toMatchObject({ mark: 8, taunt: 0 });
    for (const id of ["taunt", "markTarget"]) expect(a(id).payload, id).toMatchObject({ damage: 0, control: 0 });
  });
});

describe("auditAbilities: the grammar's bounds", () => {
  const base = ABILITIES["pummel"]!;
  const rules = (a: Partial<Ability>) => auditAbilities({ x: { ...base, id: "x", ...a } }, {}).map((v) => v.rule);
  it("an interrupt may not also be a heavy nuke", () => {
    expect(rules({})).toEqual([]);
    expect(rules({ payload: { damage: INTERRUPT_MAX_DAMAGE + 1, control: 0 } })).toContain("interrupt");
    expect(rules({ attackClass: "heavy" })).toContain("interrupt");
    expect(rules({ payoffs: [], when: [{ if: "targetCasting", then: [{ interrupt: 4 }] }], payload: { damage: 30, control: 0 } })).toContain("interrupt");
  });
  it("a heal has no damage and lands on an ally", () => {
    expect(rules({ payoffs: [], payload: { damage: 0, control: 0, heal: 20 }, onAlly: { range: 10 } })).toEqual([]);
    expect(rules({ payoffs: [], payload: { damage: 5, control: 0, heal: 20 }, onAlly: { range: 10 } })).toContain("heal");
    expect(rules({ payoffs: [], payload: { damage: 0, control: 0, heal: 20 } })).toContain("heal");
  });
  it("every conditional payoff names a known condition and a known payoff", () => {
    expect(rules({ when: [{ if: "targetSleepy" as Condition, then: [{ stamina: 5 }] }] })).toContain("condition");
    expect(rules({ when: [{ if: "targetCasting", then: [{ stamnia: 5 } as unknown as Payoff] }] })).toContain("payoff");
    expect(rules({ when: [{ if: "targetCasting", then: [] }] })).toContain("payoff");
  });
});

describe("the D1 items", () => {
  const items = path.resolve(__dirname, "../../../apps/playground/projects/voxel-demo/assets/items");
  const read = (id: string) => JSON.parse(readFileSync(path.join(items, `${id}.json`), "utf8")) as { skills?: { secondary?: string; bar?: string[] }; icon?: string; tags?: string[] };
  it("every shield carries one skill; the iron heater and tower keep the shield bash (package D3a spread the rest)", () => {
    const shields = readdirSync(items).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => read(id).tags?.includes("shield"));
    expect(shields.length).toBeGreaterThanOrEqual(10);
    for (const id of shields) expect(read(id).skills?.bar?.length, id).toBe(1);
    for (const id of ["iron-heater", "iron-tower"]) expect(read(id).skills?.bar, id).toEqual(["shieldBash"]);
    expect(new Set(shields.map((id) => read(id).skills!.bar![0])).size).toBeGreaterThanOrEqual(5);
  });
  it("the offensive staff's right click is the counter-cast", () => {
    expect(read("cinder-staff").skills?.secondary).toBe("counterCast");
  });
  it("one trinket per support skill, each with an existing icon", () => {
    const want: Record<string, string> = {
      "brawlers-bangle": "pummel",
      "mule-bone-charm": "kick",
      "cutpurse-ring": "kidneyPunch",
      "menders-sun-disc": "mend",
      "challengers-torc": "taunt",
      "hunters-amulet": "markTarget",
    };
    for (const [id, skill] of Object.entries(want)) {
      const item = read(id);
      expect(item.skills?.bar, id).toEqual([skill]);
      expect(() => readFileSync(path.join(items, "../textures", item.icon!)), id).not.toThrow();
    }
  });
});
