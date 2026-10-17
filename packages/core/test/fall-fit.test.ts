import { describe, expect, it } from "vitest";
import { fallFace, fieldSolidProbe, measureFallLip, fitFall, curtainFit, curtainColumns, shoreFoamOnBank, foamLinedBank, type RiverFall } from "../src/index.js";

/** A river at 10 m on a bed at 7 m, ending at a cliff at x = lip; the pool below at 1 m on a floor at 0. */
function cliff(lip: number, overhang?: { below: number; back: number }) {
  const ground = (x: number): number => (x < lip ? 7 : 0);
  return {
    voxelSize: 1,
    height: ground,
    density(x: number, y: number, _z: number): number {
      // an undercut: under `below`, the face stands `back` metres further upstream
      const edge = overhang && y < overhang.below ? lip - overhang.back : lip;
      return x < edge && y < 7 ? -1 : y - (x < edge ? 7 : 0);
    },
  };
}
// the solved fall: its foot 3 m past the lip line, the lip line at x = 20
const fall: RiverFall = { river: "r", x: 23, z: 0, top: 10, bottom: 1, dirX: 1, dirZ: 0, width: 6, reach: 8 };

describe("measureFallLip", () => {
  it("finds a lip that was cut back upstream of the solved one", () => {
    const lip = measureFallLip(cliff(12), fall, 3);
    expect(lip.found).toBe(true);
    expect(lip.shift).toBeCloseTo(-8, 0);
    const fitted = fitFall(cliff(12), fall, 3);
    expect(fitted.x - 3).toBeCloseTo(12, 0);
  });
  it("leaves a lip where it was solved", () => {
    const lip = measureFallLip(cliff(20), fall, 3);
    expect(Math.abs(lip.shift)).toBeLessThan(0.3);
  });
  it("measures a lip reaching further out, but the fit only follows a cut-back one", () => {
    const field = cliff(24);
    expect(measureFallLip(field, fall, 3).shift).toBeCloseTo(4, 0);
    expect(fitFall(field, fall, 3)).toBe(fall);
  });
});

describe("fallFace", () => {
  it("finds the face at a height and reports a landing on rock", () => {
    const f = fallFace(cliff(12), fall, 12, 0, 0, 5, -7.5, 4);
    expect(f.face).toBeCloseTo(0, 0);
    expect(f.landed).toBe(false);
    const floor = fallFace(cliff(12), fall, 12, 0, 0, -0.5, -7.5, 4);
    expect(floor.landed).toBe(true);
  });
});

describe("curtainFit", () => {
  const rows = (x: number | ((y: number) => number)): number[] => {
    const p: number[] = [];
    for (const y of [10, 9.6, 8, 6, 4, 2, 0.2]) for (const z of [-2, 0, 2]) p.push(typeof x === "number" ? x : x(y), y, z);
    return p;
  };
  const water = [11.9, 10, -2, 11.9, 10, 0, 11.9, 10, 2];
  it("passes a curtain hugging the face from the river's edge", () => {
    const probe = fieldSolidProbe(cliff(12));
    const fit = curtainFit(probe, rows(12.3), fall, water);
    expect(fit.faults, fit.faults.join("; ")).toEqual([]);
    expect(fit.faceGap).toBeLessThan(0.5);
  });
  it("fails a curtain standing off its cliff with the river stopping short of it (the Weeping Stair)", () => {
    const probe = fieldSolidProbe(cliff(12));
    const fit = curtainFit(probe, rows(20), fall, water);
    expect(fit.topGap).toBeGreaterThan(5);
    expect(fit.free, "8 m off its cliff: no rock within the 6 m reach behind").toBeGreaterThan(0);
    expect(fit.faults.length).toBeGreaterThanOrEqual(2);
  });
  it("lets a curtain bulge over an overhang (the envelope)", () => {
    const probe = fieldSolidProbe(cliff(12, { below: 5, back: 2 }));
    const fit = curtainFit(probe, rows(12.3), fall, water);
    expect(fit.faceGap).toBeLessThan(0.5);
  });
  it("reports a curtain inside rock", () => {
    const probe = fieldSolidProbe(cliff(12));
    const fit = curtainFit(probe, rows(11), fall, water);
    expect(fit.inRock).toBeGreaterThan(0);
  });
});

describe("curtainFit rows (the brink's two level rows)", () => {
  // as fallCurtain writes it: the top row and the next both at the river level (the brink holds level for a hand),
  // the last row 0.8 m under the pool. Counting the level run as one row read every curtain as landing on a ledge.
  const ys = [10, 10, 9.6, 8, 6, 4, 2, 0.2];
  const zs = [-2, -1, 0, 1, 2];
  const pos: number[] = [];
  const uv1: number[] = [];
  ys.forEach((y, r) => zs.forEach((z, c) => { pos.push(r === 0 ? 12 : r === 1 ? 12.25 : 12.3, y, z); uv1.push(c / (zs.length - 1), r / ys.length); }));
  const water = [11.9, 10, -2, 11.9, 10, 0, 11.9, 10, 2];
  it("reads the columns from the mesh's uv1s", () => {
    expect(curtainColumns(uv1)).toBe(5);
  });
  it("finds the rows by geometry too, and reports no ledge for a curtain ending in its pool", () => {
    const probe = fieldSolidProbe(cliff(12));
    for (const options of [{}, { cols: curtainColumns(uv1) }]) {
      const fit = curtainFit(probe, pos, fall, water, options);
      expect(fit.rows).toBe(ys.length);
      expect(fit.landed, fit.faults.join("; ")).toBe(0);
    }
  });
  it("still reports a curtain that really ends on a ledge", () => {
    const probe = fieldSolidProbe(cliff(12));
    const high = pos.map((v, i) => (i % 3 === 1 && v < 3 ? 4 : v));
    expect(curtainFit(probe, high, fall, water, { cols: 5 }).landed).toBe(5);
  });
});

describe("shore foam on steep banks (the pale strips along river banks)", () => {
  it("keeps foam on a gentle bed and drops it on a steep bank or a rock", () => {
    expect(shoreFoamOnBank(0.98)).toBe(1);
    expect(shoreFoamOnBank(0.3)).toBe(0);
    expect(shoreFoamOnBank(0.65)).toBeGreaterThan(0);
    expect(shoreFoamOnBank(0.65)).toBeLessThan(1);
  });
  it("the gate counts a band that lines steep banks, and passes the wet line", () => {
    const banks = [...Array(20).fill(0.2), ...Array(10).fill(0.95)];
    // the old band: foam on every bank whatever its slope ([0, 0])
    expect(foamLinedBank({ foamWidth: 0.6, shoreFoam: { steep: [0, 0] } }, banks)).toBe(20);
    expect(foamLinedBank({ foamWidth: 0.6 }, banks)).toBe(0);
    expect(foamLinedBank({ foamWidth: 0, shoreFoam: { steep: [0, 0] } }, banks)).toBe(0);
  });
});
