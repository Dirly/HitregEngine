import { describe, expect, it } from "vitest";
import {
  ARMOR,
  armorFor,
  armorReduction,
  critChance,
  critFromStat,
  damageBeforeGuard,
} from "../../../apps/playground/projects/foundation/scripts/lib/damage-math.js";

/**
 * the foundation's crit and armour maths, pinned against the World of Warcraft
 * numbers they are taken from. Pure: no server, no sockets.
 */
describe("damage maths (WoW formulas)", () => {
  it("armour: 5500 is half against a level 60, less against a boss", () => {
    expect(armorReduction(5500, 60)).toBeCloseTo(5500 / (5500 + 400 + 85 * (60 + 4.5)), 6);
    expect(armorReduction(5500, 59)).toBeCloseTo(5500 / (5500 + 400 + 85 * 59), 6);
    expect(armorReduction(5500, 63)).toBeLessThan(armorReduction(5500, 60));
    expect(armorReduction(0, 60)).toBe(0);
    expect(armorReduction(1e9, 60)).toBe(ARMOR.cap);
  });

  it("armorFor is the inverse of armorReduction", () => {
    for (const level of [1, 20, 59, 63]) {
      expect(armorReduction(armorFor(0.4, level), level)).toBeCloseTo(0.4, 6);
    }
  });

  it("crit: a higher-level defender suppresses it 1% a level, a lower one adds 0.2%", () => {
    expect(critChance(0.2, 60, 60)).toBeCloseTo(0.2, 6);
    expect(critChance(0.2, 60, 63)).toBeCloseTo(0.17, 6);
    expect(critChance(0.2, 63, 60)).toBeCloseTo(0.206, 6);
    expect(critChance(0.01, 1, 60)).toBe(0);
  });

  it("crit from a stat costs more of the stat per percent as level rises", () => {
    expect(critFromStat(20, 60)).toBeCloseTo(0.01, 6);
    expect(critFromStat(20, 30)).toBeCloseTo(0.02, 6);
  });

  it("one hit: crit, then the rear bonus, then armour; magic ignores armour", () => {
    const base = { damage: 100, crit: true, rearBonus: 1.5, armor: armorFor(0.5, 20), attackerLevel: 20 };
    expect(damageBeforeGuard({ ...base, kind: "physical" })).toBeCloseTo(100 * 2 * 1.5 * 0.5, 4);
    expect(damageBeforeGuard({ ...base, kind: "magic" })).toBeCloseTo(100 * 1.5 * 1.5, 4);
  });
});
