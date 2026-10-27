import { describe, expect, it } from "vitest";
import { compileOperator, type OperatorFieldReader } from "../src/index.js";

/** A dug canal: a straight trench along +x, water at 10, bed 7, banks rising at 1:1 from |z| = 8 to a moor at 22. */
const canalH = (_x: number, z: number) => { const a = Math.abs(z); return a < 8 ? 7 : Math.min(22, 7 + (a - 8)); };
const canal: OperatorFieldReader = { height: canalH, voxelSize: 2, seaLevel: 0, seed: 3, scatterRules: ["rock-medium", "rock-big"] };
const doc = {
  id: "b", op: "riverbank", line: [[0, 0], [200, 0]], level: [10, 10],
  sides: [{ at: 0, steep: "left" }, { at: 120, steep: "right" }], breaks: [60], keep: [[170, -20, 6]],
};
type Patch = { origin: number[]; size: number[]; columns: number; rows: number; heights: number[]; weights: number[]; afterRivers: boolean };

describe("riverbank operator", () => {
  const a = compileOperator(doc, canal);
  const patch = a.pieces.find((p) => p.kind === "heightPatches")!.feature as unknown as Patch;
  const at = (x: number, z: number) => {
    const i = Math.round(((x - patch.origin[0]!) / patch.size[0]!) * (patch.columns - 1)), j = Math.round(((z - patch.origin[1]!) / patch.size[1]!) * (patch.rows - 1));
    const k = j * patch.columns + i;
    return { h: patch.heights[k]!, w: patch.weights[k]! };
  };

  it("compiles to an afterRivers bank patch and margin boulders, deterministically", () => {
    expect(a.pieces.map((p) => `${p.kind}/${p.feature.id}`).sort()).toEqual(["heightPatches/op:b:banks", "rockSets/op:b:rocks"]);
    expect(patch.afterRivers).toBe(true);
    expect(JSON.stringify(compileOperator(structuredClone(doc), canal).pieces)).toBe(JSON.stringify(a.pieces));
  });

  it("never touches the water or the edge band", () => {
    for (const x of [20, 90, 160]) for (const z of [-10, -5, 0, 5, 10]) expect(at(x, z).w).toBe(0);
  });

  it("left (north, -z) is the steep shoulder before the swap, the right shelves; after the swap they trade", () => {
    // before the swap: the north bank is raised above the old bank, the south bank cut down toward the water
    expect(at(30, -24).h).toBeGreaterThan(canalH(30, -24) + 2);
    expect(at(30, 18).h).toBeLessThan(canalH(30, 18) - 2);
    expect(at(30, 19).h).toBeLessThan(14); // a low shelf, the old bank stood at 18 there
    // after it
    expect(at(170, 24).h).toBeGreaterThan(canalH(170, 24) + 2);
    expect(at(150, -16).h).toBeLessThan(canalH(150, -16) - 2);
  });

  it("drops the shoulder at a break and keeps a kept disc untouched", () => {
    const shoulder = (x: number) => at(x, -24).h - canalH(x, -24);
    expect(shoulder(60)).toBeLessThan(shoulder(30) * 0.5);
    expect(at(170, -20).w).toBe(0);
  });

  it("puts boulders on both margins and a cluster at the break", () => {
    const rocks = (a.pieces.find((p) => p.kind === "rockSets")!.feature as unknown as { rocks: { at: [number, number] }[] }).rocks;
    expect(rocks.some((r) => r.at[1] < -6)).toBe(true);
    expect(rocks.some((r) => r.at[1] > 6)).toBe(true);
    expect(rocks.filter((r) => Math.abs(r.at[0] - 60) <= 9).length).toBeGreaterThanOrEqual(5);
    for (const r of rocks) expect(Math.abs(r.at[1])).toBeLessThan(13); // in the margins, never up on the bank
  });

  it("draws no wall across the slope where the old bank is ragged (lips: <= 1.6 rise/run between 2 m samples)", () => {
    const ragged = (x: number, z: number) => canalH(x, z + 2.5 * Math.sin(x / 5) * Math.sign(z));
    const r = compileOperator(doc, { ...canal, height: ragged });
    const p = r.pieces.find((q) => q.kind === "heightPatches")!.feature as unknown as Patch;
    const H = (i: number, j: number) => p.heights[j * p.columns + i]!;
    // the lips STEP rule: two 2 m neighbours more than 3.2 m apart, 0.5 m beyond what the old ground had
    const walls: string[] = [];
    for (let j = 0; j + 2 < p.rows; j += 2) for (let i = 0; i + 2 < p.columns; i += 2) {
      const x = p.origin[0]! + i, z = p.origin[1]! + j;
      for (const [di, dj] of [[2, 0], [0, 2]] as const) {
        const de = Math.abs(H(i + di, j + dj) - H(i, j)), dr = Math.abs(ragged(x + di, z + dj) - ragged(x, z));
        if (de > 3.2 && de > dr + 0.5) walls.push(`${x},${z} ${de.toFixed(2)} (was ${dr.toFixed(2)})`);
      }
    }
    expect(walls.slice(0, 6)).toEqual([]);
  });

  it("adds no shoulder on top of a bank that is already a cliff", () => {
    const cliffy = (x: number, z: number) => (z < 0 ? Math.min(40, canalH(x, z) + Math.max(0, -z - 10) * 1.5) : canalH(x, z));
    const r = compileOperator(doc, { ...canal, height: cliffy });
    const p = r.pieces.find((q) => q.kind === "heightPatches")!.feature as unknown as Patch;
    const i = Math.round(30 - p.origin[0]!), j = Math.round(-24 - p.origin[1]!);
    expect(p.heights[j * p.columns + i]! - cliffy(30, -24)).toBeLessThan(1.5);
    // nor a shelf cut into it after the swap
    const k = Math.round(150 - p.origin[0]!), m = Math.round(-24 - p.origin[1]!);
    expect(cliffy(150, -24) - p.heights[m * p.columns + k]!).toBeLessThan(1.5);
  });
});
