import { test } from "node:test";
import assert from "node:assert/strict";
import { RISER_RULE, riserRule } from "../tools/worldgen-riser-rule.mts";

const m = (o: Partial<Parameters<typeof riserRule>[0]>) => ({ id: "t-riser-2", k: 1, height: 2, need: 4, clear: null, blocker: null, top: null, ...o });

test("a short riser with room and nothing at its top edge is a bank", () => {
  const v = riserRule(m({}));
  assert.equal(v.kind, "bank");
  assert.equal(v.tiers, 0);
});
test("(c) a drop over 2.5 m (one 5 m street of run at 1 : 2) is built, as low walls", () => {
  assert.equal(RISER_RULE.tallBank, RISER_RULE.street / RISER_RULE.bankRun);
  const v = riserRule(m({ height: 6, need: 12 }));
  assert.equal(v.kind, "wall");
  assert.equal(v.tiers, 3);
  assert.match(v.why, /\(c\)/);
});
test("(b) a street at the top edge needs a wall", () => {
  const v = riserRule(m({ top: "street town-1-lane-x" }));
  assert.equal(v.kind, "wall");
  assert.match(v.why, /\(b\) street/);
});
test("(a) a bank whose run reaches a pad is built", () => {
  const v = riserRule(m({ clear: 2.5, blocker: "building pad drew-house" }));
  assert.equal(v.kind, "wall");
  assert.match(v.why, /\(a\).*drew-house/);
  assert.equal(riserRule(m({ clear: 4 })).kind, "bank");
});

test("a built riser is a DC riser by default; a kit wall only where something stands on its crest", () => {
  const tall = riserRule(m({ height: 6, need: 12 }));
  assert.equal(tall.face, "dc");
  assert.match(tall.why, /DC riser/);
  // a street 3 m back from the edge: clear of the 2.5 m crest -> DC
  assert.equal(riserRule(m({ top: "street a", topGap: 2.8 })).face, "dc");
  // a street 1 m back: kit wall (its coping holds a clean walkable edge)
  const near = riserRule(m({ top: "street a", topGap: 1 }));
  assert.equal(near.face, "kit");
  assert.match(near.why, /KIT wall: street a 1\.0 m from the top edge/);
  // not measured (an old caller): kit, as before
  assert.equal(riserRule(m({ top: "building b" })).face, "kit");
  assert.equal(riserRule(m({})).face, undefined);
});

test("RISER_RULE.dcEdge covers the crest a DC riser actually leaves on the field (measured)", async () => {
  const { createWorldField, defaultWorldRecipe, dcRiserSchema, worldRecipeSchema } = await import("@hitreg/core");
  const { measureDcCrest } = await import("../tools/worldgen-riser-rule.mts");
  const base = worldRecipeSchema.parse(defaultWorldRecipe());
  const x = 4 * 48 + 24, z = 4 * 48 + 24, h = Math.round(createWorldField(base).height(x, z));
  for (const seed of [1, 2, 3]) {
    const doc = dcRiserSchema.parse({ id: "r", points: [[x - 30, z], [x + 30, z]], top: h + 3, foot: h - 3, seed, back: 8 }); // the riser holds 8 m of shelf (a town shelf does in a world)
    const field = createWorldField(worldRecipeSchema.parse({ ...base, features: { ...base.features, dcRisers: [doc] } }));
    const lost = measureDcCrest(field, doc);
    assert.ok(lost > 0.5, `seed ${seed}: the crest steps (${lost} m)`);
    assert.ok(lost <= RISER_RULE.dcEdge + 0.25, `seed ${seed}: crest reaches ${lost} m behind the edge, over dcEdge ${RISER_RULE.dcEdge}`);
  }
});
