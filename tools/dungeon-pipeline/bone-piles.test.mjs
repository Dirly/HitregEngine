// The recipe gate's bone cap (quality.mjs countBonePiles): skulls seated beside a bone pile are that pile's dressing
// (owner rule 2026-10-21), a skull alone still counts as a pile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countBonePiles } from "./quality.mjs";

const pile = (x) => ({ pid: "poi-props/bone-pile", p: [x, 0, 0] });
const skull = (x, pid = "poi-props/skull") => ({ pid, p: [x, 0, 0] });

test("skulls beside a pile do not add piles", () => {
  assert.equal(countBonePiles([pile(0), skull(1), skull(-1.2), skull(0.5, "poi-props/skull-surface")]), 1);
});
test("a lone skull counts as one pile", () => {
  assert.equal(countBonePiles([pile(0), skull(5)]), 2);
});
test("piles always count, skull-shaped piles included", () => {
  assert.equal(countBonePiles([pile(0), pile(1), { pid: "culture-craft/necro-skull-bone-pile", p: [0.5, 0, 0] }]), 3);
});
test("distance follows thresholds", () => {
  assert.equal(countBonePiles([pile(0), skull(2)], { skullCompanionM: 2.5 }), 1);
});
