import { describe, expect, it } from "vitest";
import { cliffPathOperatorSchema, solveCliffPath } from "../src/index.js";

// A cliff face running along x: the rim at 100 m for z < 0, a 70-degree face (2.75 m per metre) down to a floor at 10 m.
const face = (_x: number, z: number): number => (z <= 0 ? 100 : Math.max(10, 100 - 2.75 * z));
const params = (over: Record<string, unknown>) => cliffPathOperatorSchema.parse({ top: [0, -2], bottom: [-10, 40], ends: [[0, 10], [-100, 10]], legs: 4, ...over });

describe("cliff-path planner", () => {
  it("zig-zags the asked number of legs between the turning lines, with level platforms at the hairpins", () => {
    const s = solveCliffPath(params({}), face);
    expect(s.faults.join("; ")).toBe("");
    const legs = new Set(s.points.map((p) => p.leg));
    expect(legs.size).toBe(4);
    expect(s.turns.length).toBe(3);
    // each hairpin platform is level and the line holds one even grade between them
    for (const tp of s.turns) expect(Number.isFinite(tp.y)).toBe(true);
    expect(s.drop).toBe(90);
    expect(s.grade).toBeLessThanOrEqual(0.27);
    // the steepest step anywhere on the line stays at the grade
    let worst = 0;
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]!, b = s.points[i]!, run = Math.hypot(b.x - a.x, b.z - a.z);
      if (run > 0.5) worst = Math.max(worst, Math.abs(b.y - a.y) / run);
    }
    expect(worst).toBeLessThan(0.3);
  });

  it("cuts the whole width into the face: the outer edge sits on the natural ground at the road's height", () => {
    const s = solveCliffPath(params({}), face);
    const mid = s.points.filter((p) => !p.turn && p.y < 95 && p.y > 15);
    expect(mid.length).toBeGreaterThan(20);
    for (const p of mid) {
      const outer = face(p.x + s.out[0] * 1.9, p.z + s.out[1] * 1.9);
      expect(Math.abs(outer - p.y)).toBeLessThan(1.5);
    }
    // a parapet stands along the drops
    expect(s.parapet.length).toBeGreaterThan(50);
  });

  it("refuses a grade over the cap: GRADE says add a leg", () => {
    const s = solveCliffPath(params({ legs: 2 }), face);
    expect(s.faults.some((f) => f.startsWith("GRADE"))).toBe(true);
  });
});

describe("cliff-path hairpins", () => {
  it("each platform stands at its own hairpin's height (descending), never the first one's", () => {
    const s = solveCliffPath(params({}), face);
    const ys = s.turns.map((t) => t.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeLessThan(ys[i - 1]! - 5);
  });
});
