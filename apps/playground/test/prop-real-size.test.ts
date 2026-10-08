import { test } from "node:test";
import assert from "node:assert/strict";
import { kindOf, kindSizes, realSizeIssue } from "../tools/_prop-real-size.mts";

const scales = [{ id: "human", height: 1.8 }, { id: "small", height: 1.2 }, { id: "giant", height: 4.5 }];
const T = kindSizes();

test("kinds come from prefab names", () => {
  assert.equal(kindOf("poi-props/barrel-a", T), "barrel");
  assert.equal(kindOf("interior-props/barrel-shelf", T), null);
  assert.equal(kindOf("town/oak-door", T), "door");
  assert.equal(kindOf("camp/hide-tent-large", T), "tent");
  assert.equal(kindOf("decor/candle", T), null);
});

test("a prop inside its kind's range at its user's scale is fine; outside is a fault", () => {
  assert.equal(realSizeIssue("x/barrel", [0.6, 0.9, 0.6], "human", scales, T), null);
  assert.match(realSizeIssue("x/barrel", [1.6, 2.4, 1.6], "human", scales, T)!, /barrel 2.4 m tall.*never scale a prop up/);
  // a door 2 m tall is right for a human, far too small for a giant; 2.4 m is too tall for small folk
  assert.equal(realSizeIssue("x/door", [1, 2, 0.1], undefined, scales, T), null);
  assert.ok(realSizeIssue("x/door", [1.2, 2.4, 0.1], "small", scales, T));
  assert.ok(realSizeIssue("x/door", [1, 2, 0.1], "giant", scales, T));
  assert.equal(realSizeIssue("x/door", [2.2, 4.8, 0.2], "giant", scales, T), null);
  assert.match(realSizeIssue("x/chain-barrier", [3, 2.2, 0.1], "human", scales, T)!, /chain/);
});

test("a project overrides or drops a kind", () => {
  const P = kindSizes({ kinds: { barrel: { range: [0.3, 3] }, door: null, cage: { match: "cage", dim: "h", range: [0.3, 2.5] } } });
  assert.equal(realSizeIssue("x/barrel", [1.6, 2.4, 1.6], "human", scales, P), null);
  assert.equal(kindOf("x/door", P), null);
  assert.ok(realSizeIssue("x/cage", [1, 3, 1], "human", scales, P));
});
