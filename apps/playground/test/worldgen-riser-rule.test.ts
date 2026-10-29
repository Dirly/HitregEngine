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
