import { describe, expect, it } from "vitest";
import {
  CREATURE_GUARD,
  DEFENCE,
  resolveDefence,
  type DefencePools,
  type GuardState,
} from "../../../apps/playground/projects/voxel-demo/scripts/lib/defence.js";
import {
  BEATS,
  SCHOOLS,
  SCHOOL_COLOR,
  WARD_REWARD,
  WARD_WRONG,
  arcOf,
  schoolOf,
  wardVerdict,
  type Arc,
  type AttackClass,
  type DamageKind,
  type GuardKind,
  type School,
} from "../../../apps/playground/projects/voxel-demo/scripts/lib/combat-rules.js";

/**
 * voxel-demo's `resolveDefence` (lib/defence.ts), pure: the whole
 * attack class x guard x arc matrix of docs/combat-plan.md, pinned without a
 * server. The socket test (defence.test.ts) proves the actor wires it up; this
 * proves what it decides. The game has no test runner of its own, so it lives
 * here and imports the game lib by path (projects/ is gitignored: on a clone
 * without voxel-demo this file fails to import, as defence.test.ts skips).
 */

const NOW = 100;
const FULL: DefencePools = { stamina: 100, mana: 100, allyMana: 100 };
/** Raised long enough ago that the perfect windows are over: a plain block / ward. */
const HELD = NOW - 1;
/** Raised this instant: inside every perfect window. */
const FRESH = NOW - 0.05;

const KIND: Record<AttackClass, DamageKind> = {
  light: "physical",
  heavy: "physical",
  unblockable: "physical",
  ranged: "physical",
  spell: "magic",
};
const CLASSES: AttackClass[] = ["light", "heavy", "unblockable", "ranged", "spell"];
const GUARDS: GuardKind[] = ["block", "parry", "ward", "none"];

function hit(attackClass: AttackClass, arc: Arc, damage = 50, control = 20) {
  return { damage, control, kind: KIND[attackClass], attackClass, arc };
}
function guard(kind: GuardKind, raisedAt: number): GuardState {
  return { kind, raisedAt };
}

/**
 * The expected outcome with full pools, front arc. `fresh` = raised inside the
 * perfect window, else held past it. Straight from the plan's table.
 */
function expected(g: GuardKind, c: AttackClass, fresh: boolean): string {
  if (g === "none" || c === "unblockable") return "clean";
  if (g === "ward") return c === "spell" ? (fresh ? "ward-perfect" : "warded") : "clean";
  if (g === "parry") return (c === "light" || c === "heavy") && fresh ? "parried" : "clean";
  // block: parry at the moment it is raised, for melee only; spells and shots are blocked
  if ((c === "light" || c === "heavy") && fresh) return "parried";
  return "blocked";
}

describe("resolveDefence: class x guard x arc", () => {
  for (const g of GUARDS) {
    for (const c of CLASSES) {
      for (const fresh of [false, true]) {
        const label = `${g} ${fresh ? "raised just now" : "held"} vs ${c}`;
        it(`front: ${label} -> ${expected(g, c, fresh)}`, () => {
          const r = resolveDefence(hit(c, "front"), guard(g, g === "none" ? 0 : fresh ? FRESH : HELD), FULL, NOW);
          expect(r.outcome).toBe(expected(g, c, fresh));
          expect(r.arc).toBe("front");
        });
        // A ward covers every side (Derek, 2026-10-04): the wheel is its skill check, not facing.
        const warded = g === "ward" && c === "spell";
        it(`flank: ${label} -> ${warded ? "the ward answers" : "clean, no bonus"}`, () => {
          const r = resolveDefence(hit(c, "flank"), guard(g, fresh ? FRESH : HELD), FULL, NOW);
          if (warded) expect(r.outcome).toBe(expected(g, c, fresh));
          else expect(r).toMatchObject({ outcome: "clean", damage: 50, control: 20, staminaSpent: 0, manaSpent: 0 });
        });
        it(`rear: ${label} -> ${warded ? "the ward answers, no rear bonus" : "clean, x rearBonus"}`, () => {
          const r = resolveDefence(hit(c, "rear"), guard(g, fresh ? FRESH : HELD), FULL, NOW);
          if (warded) {
            expect(r.outcome).toBe(expected(g, c, fresh));
            expect(r.damage).toBe(fresh ? 0 : 50 - DEFENCE.wardPower);
          } else {
            expect(r).toMatchObject({ outcome: "clean", damage: 50 * DEFENCE.rearBonus, staminaSpent: 0, manaSpent: 0 });
          }
        });
      }
    }
  }
});

describe("resolveDefence: the numbers", () => {
  it("absent kind, class and arc = a magic spell from the front", () => {
    const blocked = resolveDefence({ damage: 50, control: 0 }, guard("block", HELD), FULL, NOW);
    expect(blocked).toMatchObject({ outcome: "blocked", arc: "front", damage: 50 - DEFENCE.blockPower / 2 });
    const warded = resolveDefence({ damage: 50, control: 0 }, guard("ward", HELD), FULL, NOW);
    expect(warded.outcome).toBe("warded");
  });

  it("a light block absorbs blockPower and charges stamina for it", () => {
    const r = resolveDefence(hit("light", "front"), guard("block", HELD), FULL, NOW);
    expect(r.damage).toBe(50 - DEFENCE.blockPower);
    expect(r.staminaSpent).toBeCloseTo(DEFENCE.blockPower * DEFENCE.blockStaminaPerDamage);
    expect(r.control).toBeCloseTo(20 * (1 - DEFENCE.blockPower / 50));
  });

  it("a heavy block costs double stamina, and breaks a guard a light would not", () => {
    const r = resolveDefence(hit("heavy", "front"), guard("block", HELD), FULL, NOW);
    expect(r.staminaSpent).toBeCloseTo(DEFENCE.blockPower * DEFENCE.blockStaminaPerDamage * DEFENCE.heavyBlockCost);
    const pools = { ...FULL, stamina: 40 }; // light costs 27.2, heavy 54.4
    expect(resolveDefence(hit("light", "front"), guard("block", HELD), pools, NOW).outcome).toBe("blocked");
    const broken = resolveDefence(hit("heavy", "front"), guard("block", HELD), pools, NOW);
    expect(broken).toMatchObject({ outcome: "guard-broken", damage: 50, staggerSelf: DEFENCE.guardBreakStagger });
  });

  // E1: the shield warden "parried" a greatsword's heavy with a guard it had
  // just re-raised between its own swings. A creature's guard is a shield only.
  it("a creature's guard never parries, and a heavy breaks it however it is held", () => {
    const creature = { ...DEFENCE, ...CREATURE_GUARD };
    for (const at of [FRESH, HELD, NOW]) {
      expect(resolveDefence(hit("light", "front"), guard("block", at), FULL, NOW, creature).outcome).toBe("blocked");
      const heavy = resolveDefence(hit("heavy", "front"), guard("block", at), FULL, NOW, creature);
      expect(heavy).toMatchObject({ outcome: "guard-broken", damage: 50, staggerSelf: DEFENCE.guardBreakStagger, staggerAttacker: 0 });
    }
    // a rear blow still walks round it, with the bonus
    expect(resolveDefence(hit("heavy", "rear"), guard("block", FRESH), FULL, NOW, creature)).toMatchObject({ outcome: "clean", damage: 50 * DEFENCE.rearBonus });
  });

  it("a parried heavy staggers the attacker longer than a parried light", () => {
    const light = resolveDefence(hit("light", "front"), guard("parry", FRESH), FULL, NOW);
    const heavy = resolveDefence(hit("heavy", "front"), guard("parry", FRESH), FULL, NOW);
    expect(light).toMatchObject({ damage: 0, control: 0, staggerAttacker: DEFENCE.parryStagger });
    expect(heavy.staggerAttacker).toBeCloseTo(DEFENCE.parryStagger * DEFENCE.heavyParryStagger);
  });

  it("a parry needs stamina: without it a shield blocks and a blade misses", () => {
    const pools = { ...FULL, stamina: DEFENCE.parryStamina - 1 };
    expect(resolveDefence(hit("light", "front"), guard("block", FRESH), pools, NOW).outcome).toBe("guard-broken");
    expect(resolveDefence(hit("light", "front"), guard("parry", FRESH), pools, NOW).outcome).toBe("clean");
  });

  it("a shield answers a spell at half strength and never parries it", () => {
    const r = resolveDefence(hit("spell", "front"), guard("block", FRESH), FULL, NOW);
    expect(r).toMatchObject({ outcome: "blocked", damage: 50 - DEFENCE.blockPower / 2, staggerAttacker: 0 });
  });

  it("a shot is blocked in full by a shield and never parried", () => {
    const r = resolveDefence(hit("ranged", "front"), guard("block", FRESH), FULL, NOW);
    expect(r).toMatchObject({ outcome: "blocked", damage: 50 - DEFENCE.blockPower, staggerAttacker: 0 });
  });

  it("a held ward absorbs wardPower for mana; a perfect one cancels the spell for wardPerfectMana", () => {
    const held = resolveDefence(hit("spell", "front"), guard("ward", HELD), FULL, NOW);
    expect(held).toMatchObject({ outcome: "warded", damage: 50 - DEFENCE.wardPower, staminaSpent: 0 });
    expect(held.manaSpent).toBeCloseTo(DEFENCE.wardPower * DEFENCE.wardManaPerDamage);
    const fresh = resolveDefence(hit("spell", "front"), guard("ward", FRESH), FULL, NOW);
    expect(fresh).toMatchObject({ outcome: "ward-perfect", damage: 0, control: 0, manaSpent: DEFENCE.wardPerfectMana });
  });

  it("a ward that cannot pay collapses and the spell lands whole, with no stagger", () => {
    const r = resolveDefence(hit("spell", "front"), guard("ward", HELD), { ...FULL, mana: 3 }, NOW);
    expect(r).toMatchObject({ outcome: "ward-broken", damage: 50, manaSpent: 3, staggerSelf: 0 });
  });

  it("an ally's thrown ward answers a spell, perfect from its stamp, paid from the thrower's mana", () => {
    const g: GuardState = { kind: "block", raisedAt: 0, allyWard: { at: FRESH } };
    const perfect = resolveDefence(hit("spell", "front"), g, FULL, NOW);
    expect(perfect).toMatchObject({ outcome: "ward-perfect", damage: 0, byAlly: true, manaSpent: 0 });
    expect(perfect.allyManaSpent).toBe(DEFENCE.wardPerfectMana);
    const late = resolveDefence(hit("spell", "front"), { ...g, allyWard: { at: NOW - 0.6 } }, FULL, NOW);
    expect(late).toMatchObject({ outcome: "warded", byAlly: true, manaSpent: 0 });
    // the thrower's item numbers win
    const strong = resolveDefence(hit("spell", "front"), { ...g, allyWard: { at: NOW - 0.6, power: 50 } }, FULL, NOW);
    expect(strong.damage).toBe(0);
  });

  it("an ally's ward expires, does nothing to physical blows, and covers every side", () => {
    const g: GuardState = { kind: "none", raisedAt: 0, allyWard: { at: NOW - DEFENCE.allyWardSeconds - 0.1 } };
    expect(resolveDefence(hit("spell", "front"), g, FULL, NOW).outcome).toBe("clean");
    const live: GuardState = { ...g, allyWard: { at: FRESH } };
    expect(resolveDefence(hit("light", "front"), live, FULL, NOW).outcome).toBe("clean");
    expect(resolveDefence(hit("spell", "rear"), live, FULL, NOW)).toMatchObject({ outcome: "ward-perfect", byAlly: true });
    expect(resolveDefence(hit("spell", "flank"), live, FULL, NOW)).toMatchObject({ outcome: "ward-perfect", byAlly: true });
    // a physical blow from behind still gets past it, and with the bonus
    expect(resolveDefence(hit("light", "rear"), live, FULL, NOW).damage).toBe(50 * DEFENCE.rearBonus);
  });

  // a holy ward: right against shadow (holy beats shadow), wrong against nature (nature beats holy),
  // plain against holy and destruction (same school, across the wheel)
  const spell = (element: string, arc: Arc = "front") => ({ ...hit("spell", arc), element });
  const holyWard = (raisedAt: number, extra: Partial<GuardState> = {}): GuardState => ({
    kind: "ward",
    raisedAt,
    school: "holy",
    ...extra,
  });

  it("right: absorbs held; just in time cancels and pays the reward", () => {
    const held = resolveDefence(spell("shadow"), holyWard(HELD, { reward: "mana" }), FULL, NOW);
    expect(held).toMatchObject({ outcome: "warded", verdict: "right", damage: 50 - DEFENCE.wardPower });
    expect(held.reward).toBeUndefined(); // only the perfect catch pays
    const fresh = resolveDefence(spell("shadow"), holyWard(FRESH, { reward: "mana" }), FULL, NOW);
    expect(fresh).toMatchObject({ outcome: "ward-perfect", verdict: "right", damage: 0 });
    expect(fresh.reward).toEqual({ kind: "mana", mana: DEFENCE.wardPerfectMana + 50 * WARD_REWARD.manaPerDamage });
    const power = resolveDefence(spell("shadow"), holyWard(FRESH, { reward: "power" }), FULL, NOW);
    expect(power.reward).toEqual({ kind: "power" });
    // no reward on the item = just the cancel
    expect(resolveDefence(spell("shadow"), holyWard(FRESH), FULL, NOW).reward).toBeUndefined();
  });

  it("plain: absorbs, a perfect catch still cancels, but pays no reward", () => {
    for (const element of ["holy", "destruction", "water"]) {
      const held = resolveDefence(spell(element), holyWard(HELD, { reward: "power" }), FULL, NOW);
      expect(held).toMatchObject({ outcome: "warded", verdict: "plain", damage: 50 - DEFENCE.wardPower });
      const fresh = resolveDefence(spell(element), holyWard(FRESH, { reward: "power" }), FULL, NOW);
      expect(fresh).toMatchObject({ outcome: "ward-perfect", verdict: "plain", damage: 0, manaSpent: DEFENCE.wardPerfectMana });
      expect(fresh.reward).toBeUndefined();
    }
    // a ward with no school, or a spell with none, is plain
    expect(resolveDefence(spell("nature"), holyWard(FRESH, { school: undefined, reward: "mana" }), FULL, NOW)).toMatchObject({ outcome: "ward-perfect", verdict: "plain" });
    expect(resolveDefence(hit("spell", "front"), holyWard(FRESH, { reward: "mana" }), FULL, NOW).reward).toBeUndefined();
  });

  it("wrong: absorbs nothing, costs nothing more, the spell lands harder, timed or not", () => {
    for (const at of [FRESH, HELD]) {
      const r = resolveDefence(spell("nature"), holyWard(at, { reward: "power" }), FULL, NOW);
      expect(r).toMatchObject({ outcome: "ward-wrong", verdict: "wrong", damage: 50 * WARD_WRONG.damageMult, control: 20, manaSpent: 0 });
      expect(r.reward).toBeUndefined();
    }
  });

  it("a ward answers from every arc; a wrong one from behind keeps the rear bonus under its penalty", () => {
    for (const arc of ["front", "flank", "rear"] as Arc[]) {
      expect(resolveDefence(spell("shadow", arc), holyWard(FRESH), FULL, NOW)).toMatchObject({ outcome: "ward-perfect", damage: 0 });
      expect(resolveDefence(spell("holy", arc), holyWard(HELD), FULL, NOW)).toMatchObject({ outcome: "warded", damage: 50 - DEFENCE.wardPower });
    }
    expect(resolveDefence(spell("nature", "rear"), holyWard(HELD), FULL, NOW).damage).toBeCloseTo(50 * DEFENCE.rearBonus * WARD_WRONG.damageMult);
    expect(resolveDefence(spell("nature", "flank"), holyWard(HELD), FULL, NOW).damage).toBeCloseTo(50 * WARD_WRONG.damageMult);
  });

  it("an ally's ward is judged by the THROWER's school and pays the thrower's reward", () => {
    const g = (school: string): GuardState => ({
      kind: "ward",
      raisedAt: 0,
      school: "nature",
      reward: "mana",
      allyWard: { at: FRESH, school, reward: "power" },
    });
    expect(resolveDefence(spell("shadow"), g("holy"), FULL, NOW)).toMatchObject({
      outcome: "ward-perfect",
      verdict: "right",
      byAlly: true,
      reward: { kind: "power" },
    });
    expect(resolveDefence(spell("shadow"), g("destruction"), FULL, NOW)).toMatchObject({
      outcome: "ward-wrong",
      byAlly: true,
      damage: 50 * WARD_WRONG.damageMult,
    });
  });

  it("an item's own window and power replace the defaults", () => {
    const buckler = { ...DEFENCE, parryWindow: 0.6, blockPower: 10 };
    const r = resolveDefence(hit("light", "front"), guard("block", NOW - 0.5), FULL, NOW, buckler);
    expect(r.outcome).toBe("parried");
    const late = resolveDefence(hit("light", "front"), guard("block", NOW - 0.7), FULL, NOW, buckler);
    expect(late.damage).toBe(40);
  });
});

describe("arcOf", () => {
  const at = { x: 0, z: 0 };
  const north = { x: 0, z: -1 };
  it("splits front 140, flank, rear 120", () => {
    expect(arcOf(at, north, { x: 0, z: -5 })).toBe("front");
    expect(arcOf(at, north, { x: 5, z: -5 })).toBe("front"); // 45 degrees
    expect(arcOf(at, north, { x: 5, z: 0 })).toBe("flank"); // 90
    expect(arcOf(at, north, { x: 0, z: 5 })).toBe("rear");
    expect(arcOf(at, north, { x: 5, z: 5 })).toBe("rear"); // 135
    expect(arcOf(at, north, at)).toBe("front");
  });
});

describe("schools and the wheel", () => {
  it("has four schools; water is destruction for every combat rule", () => {
    expect([...SCHOOLS].sort()).toEqual(["destruction", "holy", "nature", "shadow"]);
    expect(schoolOf("water")).toBe("destruction");
    for (const s of SCHOOLS) expect(schoolOf(s)).toBe(s);
    expect(schoolOf("frost")).toBeNull();
    expect(schoolOf(undefined)).toBeNull();
    for (const s of SCHOOLS) expect(SCHOOL_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("the wheel: destruction > nature > holy > shadow > destruction", () => {
    expect(BEATS).toEqual({ destruction: "nature", nature: "holy", holy: "shadow", shadow: "destruction" });
  });

  // all 16 pairs, written out rather than derived, so the table IS the ruling
  const TABLE: Record<School, Record<School, "right" | "plain" | "wrong">> = {
    destruction: { destruction: "plain", nature: "right", holy: "plain", shadow: "wrong" },
    nature: { destruction: "wrong", nature: "plain", holy: "right", shadow: "plain" },
    holy: { destruction: "plain", nature: "wrong", holy: "plain", shadow: "right" },
    shadow: { destruction: "right", nature: "plain", holy: "wrong", shadow: "plain" },
  };
  for (const w of SCHOOLS) {
    for (const s of SCHOOLS) {
      it(`a ${w} ward against a ${s} spell is ${TABLE[w][s]}`, () => {
        expect(wardVerdict(w, s)).toBe(TABLE[w][s]);
      });
    }
  }

  it("frost counts as destruction on the wheel; no school is plain", () => {
    expect(wardVerdict("shadow", "water")).toBe("right");
    expect(wardVerdict("nature", "water")).toBe("wrong");
    expect(wardVerdict(undefined, "shadow")).toBe("plain");
    expect(wardVerdict("holy", undefined)).toBe("plain");
  });
});
