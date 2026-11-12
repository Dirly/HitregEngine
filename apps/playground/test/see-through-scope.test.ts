import { test } from "node:test";
import assert from "node:assert/strict";
import { outOfPlace, ropeRailOpening, routeDistanceXZ, sceneOwned, type V3 } from "../tools/_see-through-scope.mts";

// a route along the place's own ground; scene entities of the job
const samples: Array<{ at: V3 }> = [{ at: [0, 10, 0] }, { at: [10, 10, 0] }, { at: [20, 10, 0] }];
const scene = new Set(["poi-shed", "dress-yard-barrel-1"]);

test("a far scatter tree (world mesh only, 63 m off the route) is out of place", () => {
  assert.equal(routeDistanceXZ([20, 40, 63], samples), 63);
  assert.equal(outOfPlace({ at: [20, 40, 63], entities: ["Mesh"] }, samples, scene), true);
});

test("a world mesh close to the route still counts (the place's own ground)", () => {
  assert.equal(outOfPlace({ at: [10, 5, 12], entities: ["Mesh"] }, samples, scene), false);
});

test("anything touching a scene entity counts, however far (a prefab part label carries :<part>)", () => {
  assert.equal(sceneOwned("dress-yard-barrel-1:atlas", scene), true);
  assert.equal(outOfPlace({ at: [20, 40, 90], entities: ["Mesh", "dress-yard-barrel-1:atlas"] }, samples, scene), false);
  assert.equal(outOfPlace({ at: [20, 40, 90], entities: ["poi-shed"] }, samples, scene), false);
});

test("no world estimate or no route: always counts; --within moves the line", () => {
  assert.equal(outOfPlace({ at: null, entities: ["Mesh"] }, samples, scene), false);
  assert.equal(outOfPlace({ at: [20, 40, 63], entities: ["Mesh"] }, [], scene), false);
  assert.equal(outOfPlace({ at: [20, 40, 63], entities: ["Mesh"] }, samples, scene, 80), false);
});

test("a cutout on world meshes only (scatter foliage, a fall curtain's spray) is out of place however close; a cutout on a scene entity counts", () => {
  assert.equal(outOfPlace({ at: [10, 5, 12], entities: ["Mesh"], cause: "cutout" }, samples, scene), true);
  assert.equal(outOfPlace({ at: [10, 5, 12], entities: ["__chunk:w:-51_-22/fall_0"], cause: "cutout" }, samples, scene), true);
  assert.equal(outOfPlace({ at: [10, 5, 12], entities: ["poi-shed"], cause: "cutout" }, samples, scene), false);
  assert.equal(outOfPlace({ at: [10, 5, 12], entities: ["__chunk:w:-52_-23/lm_op:weep-chute-head:landmark"], cause: "cutout" }, samples, scene), false); // a baked landmark is the job's
  assert.equal(outOfPlace({ at: [10, 5, 12], entities: ["Mesh"], cause: "void" }, samples, scene), false); // a terrain hole by the route still counts
  assert.equal(outOfPlace({ at: [10, 5, 12], entities: ["Mesh"], cause: "cutout", causes: { cutout: 1, seam: 1 } }, samples, scene), false); // mixed with a seam: counts
});

test("a site whose every entity is a rope rail part is an allowed opening; anything else, or a hidden collider in general, stays a hole", () => {
  const names: Record<string, string> = { "rail-1": "Rope Rail", "rail-1-col": "rope_rail collider", "wall-1": "Wall", "col-9": "Hidden Collider" };
  const nameOf = (id: string) => names[id] ?? id;
  assert.equal(ropeRailOpening({ entities: ["rail-1", "rail-1-col"] }, nameOf), true);
  assert.equal(ropeRailOpening({ entities: ["stilt-village-kit/RopeRail:atlas"] }, nameOf), true);
  assert.equal(ropeRailOpening({ entities: ["rail-1", "wall-1"] }, nameOf), false); // a wall behind the rail: a hole
  assert.equal(ropeRailOpening({ entities: ["col-9"] }, nameOf), false); // hidden colliders are not covered
  assert.equal(ropeRailOpening({ entities: [] }, nameOf), false);
});

test("a rope bridge span's rope and rag parts are the rope-rail class; its tar stringers and wood segment are not", () => {
  const C = "__chunk:ph3arch:-51_-41/bs_widows-span_0";
  assert.equal(ropeRailOpening({ entities: [`${C}:mesh-rope`, `${C}:mesh-rag`] }), true);
  assert.equal(ropeRailOpening({ entities: [`${C}:mesh-rope`, `${C}:mesh-tar`] }), false); // the stringers under the deck
  assert.equal(ropeRailOpening({ entities: [C, `${C}:mesh-rope`] }), false); // the bare segment is the wood: deck, posts, lintel
  assert.equal(ropeRailOpening({ entities: ["__chunk:w:0_0/bs_old-arch_0"] }), false); // an arch span's stone
});

test("an iron railing or gate card's cutout is an allowed opening (graveyard standard, 2026-11-10); anything else on it is not", () => {
  assert.equal(ropeRailOpening({ entities: ["widows-cairn-core-iron-gate:p04-gate-leaf"], cause: "cutout" }), true);
  assert.equal(ropeRailOpening({ entities: ["widows-cairn-core-railing-25:p00-railing"], cause: "cutout" }), true);
  assert.equal(ropeRailOpening({ entities: ["widows-cairn-core-railing-25:p00-railing"], cause: "seam" }), false);
  assert.equal(ropeRailOpening({ entities: ["widows-cairn-core-railing-25:p00-railing", "Mesh"], cause: "cutout" }), false);
});
