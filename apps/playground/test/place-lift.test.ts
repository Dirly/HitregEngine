import { test } from "node:test";
import assert from "node:assert/strict";
import { LIFT_DEFAULTS, planLift, sceneObstacles, type LiftSpec } from "../tools/_place-lift.mts";

// A sheer cliff: moor at 50 m for z < 0, the sea floor at 0 beyond the edge.
const cliff = (_x: number, z: number): number => (z < 0 ? 50 : 0);
// A 70 degree slope: 50 m at z <= 0 falling 2.75 m per metre to 0 at z ~ 18, then flat.
const slope = (_x: number, z: number): number => (z <= 0 ? 50 : Math.max(0, 50 - 2.75 * z));
const spec = (over: Partial<LiftSpec>): LiftSpec => ({ ...LIFT_DEFAULTS, id: "t", top: [0, 2], bottom: [0, 2], exit: "front", ...over });

test("lift plan: a plumb shaft off a sheer cliff — drop, a gangway over the gap, deck + rails on the lift builtin", () => {
  const p = planLift("world-kit", spec({ facing: 0 }), cliff);
  assert.deepEqual(p.faults, []);
  assert.equal(p.drop, 50);
  assert.equal(p.run, 0);
  assert.ok(Math.abs(p.edge - 0.5) < 0.11, `edge ${p.edge}`); // deck back edge at z 0.5, the ground ends at z 0
  assert.equal(p.gangway, true);
  const deck = p.ops.find((o) => o.id === "lift-t-deck");
  assert.equal(deck.entity.components.script.name, "lift");
  assert.equal(deck.entity.components.script.params.drop, 50);
  assert.equal(deck.entity.components.rigidbody.kind, "kinematic");
  assert.equal(p.ops.filter((o) => o.entity.components.script?.name === "lift").length, 3); // deck + two rails
  assert.ok(p.ops.find((o) => o.id === "lift-t-rope").entity.tags.includes("lift-rope"));
  // the cradle and rope follow the deck on a client: their catalogued static meshes are overridden to moving
  for (const k of ["lift-t-rope", "lift-t-cradle"]) assert.ok(p.ops.find((o) => o.id === k).entity.components.prefab.overrides.some((v: any) => v.path.endsWith("mesh/moving") && v.value === true), k);
  assert.ok(p.ops.some((o) => o.id === "lift-t-gangway"));
  assert.equal(p.headframe.at[1], 50); // behind the gap, on the moor
  assert.ok(p.headframe.at[2] < 0);
});

test("lift plan: a plumb shaft against a slope runs into the ground — SHAFT", () => {
  const p = planLift("world-kit", spec({ facing: 0, bottomY: 0 }), slope);
  assert.ok(p.faults.some((f) => f.startsWith("SHAFT")), p.faults.join("; "));
});

test("lift plan: an inclined line out to the slope's foot clears it and runs out along its facing", () => {
  const p = planLift("world-kit", spec({ top: [0, 2], bottom: [0, 21] }), slope);
  assert.deepEqual(p.faults, []);
  assert.equal(p.run, 19);
  assert.ok(p.shaftClear.min >= 0.3);
});

test("lift plan: a deck too far off the edge for a gangway — EDGE", () => {
  const p = planLift("world-kit", spec({ top: [0, 8], bottom: [0, 8], facing: 0 }), cliff);
  assert.ok(p.faults.some((f) => f.startsWith("EDGE")), p.faults.join("; "));
});

test("lift plan: a scene structure on the top deck or the walk on is a STRUCTURE fault (the bell-cote case); one beside it is not", () => {
  const scene = { entities: {
    wall: { parent: null, components: { transform: { position: [0, 52, 1.5] }, collider: { shape: "box", size: [1.3, 4, 1] } } },
    post: { parent: null, components: { transform: { position: [6, 51, -3] }, collider: { shape: "box", size: [0.4, 2, 0.4] } } },
    veil: { parent: null, components: { transform: { position: [0, 51, 2] }, collider: { shape: "box", size: [3, 3, 3], isTrigger: true } } },
  } };
  const obs = sceneObstacles(scene, [0, 2], 40, "t");
  assert.equal(obs.length, 2); // the trigger is not a structure
  const p = planLift("world-kit", spec({ facing: 0 }), cliff, undefined, obs);
  assert.ok(p.faults.some((f) => f.startsWith("STRUCTURE")), p.faults.join("; "));
  assert.ok(p.blocked.some((b) => b.startsWith("wall in")), p.blocked.join("; "));
  assert.ok(!p.blocked.some((b) => b.startsWith("post")), p.blocked.join("; "));
  const clear = planLift("world-kit", spec({ facing: 0 }), cliff, undefined, obs.filter((o) => o.id === "post"));
  assert.deepEqual(clear.faults, []);
});
