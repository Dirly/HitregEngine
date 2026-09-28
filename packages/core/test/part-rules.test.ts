import { describe, expect, it } from "vitest";
import { partProblems, partRulesSchema, partsHiddenBy } from "../src/index.js";

// the player headgear's table, as the human-helm recipe bakes it
const helms = ["Helm1_Base", "Helm2_Base", "Helm3_base"];
const rules = partRulesSchema.parse({
  oneOf: [[...helms, "HeadBand1"], ["NoseGuard1", "NoseGuard2"]],
  requires: {
    Helm1_Flair: ["Helm1_Base"],
    Helm2_NoBeard: ["Helm2_Base"],
    NoseGuard1: [...helms, "Hood"],
    OrnateSide: [...helms, "Hood", "Crown", "HeadBand1"],
  },
  excludes: { HeadBand1: ["NoseGuard1", "NoseGuard2"] },
});

describe("part rules", () => {
  it("accepts the looks the rules allow", () => {
    expect(partProblems(rules, ["Helm1_Base", "Helm1_Flair", "NoseGuard1", "OrnateSide", "Hood", "Crown"])).toEqual([]);
    expect(partProblems(rules, ["Hood"])).toEqual([]);
    expect(partProblems(rules, ["Hood", "NoseGuard1"])).toEqual([]);
    expect(partProblems(rules, ["HeadBand1", "OrnateSide"])).toEqual([]);
  });

  it("names each broken rule", () => {
    expect(partProblems(rules, ["Helm1_Base", "Helm2_Base"])).toEqual([
      "only one of Helm1_Base, Helm2_Base, Helm3_base, HeadBand1 (has Helm1_Base + Helm2_Base)",
    ]);
    expect(partProblems(rules, ["Helm3_base", "Helm1_Flair"])).toEqual(["Helm1_Flair needs one of Helm1_Base"]);
    expect(partProblems(rules, ["Crown", "NoseGuard1"])).toEqual([
      "NoseGuard1 needs one of Helm1_Base, Helm2_Base, Helm3_base, Hood",
    ]);
    expect(partProblems(rules, ["HeadBand1", "Hood", "NoseGuard1"])).toEqual(["HeadBand1 cannot go with NoseGuard1"]);
  });

  it("an empty table allows anything", () => {
    expect(partProblems(partRulesSchema.parse({}), ["a", "b"])).toEqual([]);
  });
});

describe("hides", () => {
  it("collects what the shown parts cover on other models", () => {
    const r = partRulesSchema.parse({
      hides: { Helm1_Base: ["HairBase1", "HairBase2"], Helm1_NoBeard: ["Mustache"], Hood: ["HairBase1"] },
    });
    expect([...partsHiddenBy(r, ["Helm1_Base", "Hood"])].sort()).toEqual(["HairBase1", "HairBase2"]);
    expect([...partsHiddenBy(r, ["Helm1_NoBeard"])]).toEqual(["Mustache"]);
    expect(partsHiddenBy(r, ["Crown"]).size).toBe(0);
  });
});
