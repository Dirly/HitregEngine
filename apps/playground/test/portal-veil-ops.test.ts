import { test } from "node:test";
import assert from "node:assert/strict";
import { portalVeilOps } from "../tools/_portal-veil-ops.mts";

test("portalVeilOps: a measured queue reaches a plain anchor that has no portalAnchor component yet (Weeping Stair 2026-11-01)", () => {
  const doc = { entities: { ret: { name: "ret", parent: null, tags: ["anchor", "portal-anchor"], components: { transform: {} } } } } as never;
  const { ops } = portalVeilOps(doc, "s", { s: { ret: { queue: [0.4, null] } } }, { only: new Set(["ret"]) });
  assert.deepEqual(ops, [{ op: "set-component", id: "ret", component: "portalAnchor", data: { corridor: 0, queue: [0.4, null] } }]);
  const same = portalVeilOps({ entities: { ret: { name: "ret", parent: null, tags: [], components: { portalAnchor: { corridor: 2, queue: [0.4, null] } } } } } as never, "s", { s: { ret: { queue: [0.4, null] } } });
  assert.equal(same.ops.length, 0, "an unchanged queue writes nothing");
});
