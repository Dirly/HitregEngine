import { describe, expect, it } from "vitest";
import { carryPhaseOffset, stanceCarryFor } from "../src/index.js";

describe("carryPhaseOffset", () => {
  it("lines the upper clip's left-foot contact up with the legs'", () => {
    // Run lands its left foot at 0, TwoHanded_Run at 0.775
    expect(carryPhaseOffset([0, 0.5], [0.775, 0.254])).toBeCloseTo(0.775, 9);
    // Walk's left at 0.983, TwoHanded_Walk's at 0.217: wraps round the loop
    expect(carryPhaseOffset([0.983, 0.479], [0.217, 0.721])).toBeCloseTo(0.234, 9);
    // at every legs phase p the upper is at p + offset: the left contacts coincide
    const off = carryPhaseOffset([0.983, 0.479], [0.217, 0.721]);
    expect((0.983 + off) % 1).toBeCloseTo(0.217, 9);
  });

  it("is 0 — a plain phase match — with nothing measured", () => {
    expect(carryPhaseOffset(undefined, [0.3])).toBe(0);
    expect(carryPhaseOffset([0.3], undefined)).toBe(0);
    expect(carryPhaseOffset([], [])).toBe(0);
    expect(carryPhaseOffset([0.4], [0.4])).toBe(0);
  });
});

describe("stanceCarryFor", () => {
  const model = new Set(["TwoHanded_Run", "TwoHanded_Idle", "SwordShield_Idle", "Sword_Idle", "Axe2H_Idle"]);
  const base = { idle: "Idle", has: (c: string) => model.has(c), hold: ["SwordShield", "Shield"] };

  it("carries a stance's own clip for the gait, locked to the legs", () => {
    const carry = stanceCarryFor({
      ...base,
      gait: "Run",
      stances: ["Axe2H", "TwoHanded"],
      footfalls: { Run: [0, 0.5], TwoHanded_Run: [0.775, 0.254] },
    });
    // the axe has no run and is not a held stance: the two-handed run
    expect(carry?.clip).toBe("TwoHanded_Run");
    expect(carry?.lock).toBeCloseTo(0.775, 9);
  });

  it("holds a listed stance's idle where it has no clip for the gait", () => {
    expect(stanceCarryFor({ ...base, gait: "Walk", stances: ["SwordShield", "Sword"] })).toEqual({
      clip: "SwordShield_Idle",
      lock: null,
    });
  });

  it("carries nothing for a stance that is neither — the plain gait's own arm swing", () => {
    expect(stanceCarryFor({ ...base, gait: "Run", stances: ["Sword"] })).toBeNull();
    expect(stanceCarryFor({ ...base, gait: "Run", stances: [] })).toBeNull();
    expect(stanceCarryFor({ ...base, gait: "Run", stances: ["SwordShield"], hold: [] })).toBeNull();
  });
});
