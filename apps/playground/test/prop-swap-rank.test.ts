// The prop editor's Swap list (src/prop-swap-rank.ts): a barrel is offered barrels and crates first, never bonfires
// and lean-tos (owner walkthrough 2026-10-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankSwaps, sizeWithin, type SwapProp } from "../src/prop-swap-rank.ts";

const catalog: SwapProp[] = [
  { id: "house-interior/barrel-a", size: [0.6, 0.9, 0.6], category: "container", mount: "floor", scale: "human", cultures: ["any"] },
  { id: "house-interior/barrel-b", size: [0.65, 1.0, 0.65], category: "container", mount: "floor", scale: "human", cultures: ["any"] },
  { id: "poi-props/crate", size: [0.7, 0.7, 0.7], category: "container", mount: "floor", scale: "human", cultures: ["human"] },
  { id: "poi-props/stool", size: [0.5, 0.6, 0.5], category: "furniture", mount: "floor", scale: "human", cultures: ["any"] },
  { id: "camp-props/bonfire", size: [4.81, 3.53, 5.1], category: "light", mount: "floor", scale: "human", cultures: ["any"] },
  { id: "variant-props/hide-lean-to", size: [3.2, 2.4, 2.8], category: "structure", mount: "floor", scale: "human", cultures: ["any"] },
  { id: "fixtures/sconce", size: [0.3, 0.5, 0.3], category: "light", mount: "wall", scale: "human", cultures: ["any"] },
];

test("size within +-50% first, then category and mount, then culture; the far-off sizes last", () => {
  const ids = rankSwaps(catalog, "house-interior/barrel-a", { scale: "human", cultures: ["any"] }).map((r) => r.id);
  assert.deepEqual(ids.slice(0, 2), ["house-interior/barrel-b", "poi-props/crate"]);
  assert.equal(ids[2], "poi-props/stool"); // same size, other category
  assert.ok(ids.indexOf("camp-props/bonfire") > ids.indexOf("fixtures/sconce") || ids.indexOf("camp-props/bonfire") >= ids.length - 2);
  assert.ok(ids.slice(-2).every((id) => /bonfire|lean-to/.test(id)), `last: ${ids.slice(-2).join(", ")}`);
});

test("sizeWithin compares footprint long/short side and height, whichever way the prop is turned", () => {
  assert.ok(sizeWithin([0.6, 0.9, 0.6], [0.8, 1.2, 0.5]));
  assert.ok(!sizeWithin([0.6, 0.9, 0.6], [4.8, 3.5, 5.1]));
  assert.ok(sizeWithin([2, 1, 0.5], [0.5, 1, 2])); // turned 90 degrees
});
