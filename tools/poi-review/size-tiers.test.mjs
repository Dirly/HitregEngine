import { test } from "node:test";
import assert from "node:assert/strict";
import { measurementFaults, POI_SIZE_TIERS, reservationTierFault, SIZE_NAMES, sizeTiersSchema, tierFor, tierSummary, tierTargetsText } from "./size-tiers.mjs";
import { prepareCreatorJob } from "./creator/brief.mjs";
import fs from "node:fs";

test("the tiers are one validated table, growing with each step, large = the owner's 300-600 m district", () => {
  assert.doesNotThrow(() => sizeTiersSchema.parse(POI_SIZE_TIERS));
  assert.deepEqual(POI_SIZE_TIERS.tiers.map((t) => t.id), SIZE_NAMES);
  for (let i = 1; i < SIZE_NAMES.length; i++) {
    const a = POI_SIZE_TIERS.tiers[i - 1], b = POI_SIZE_TIERS.tiers[i];
    assert.ok(b.footprintDiameterM.min >= a.footprintDiameterM.min && b.minUsableAreaM2 > a.minUsableAreaM2 && b.minLinkedFeatures >= a.minLinkedFeatures && b.minCreatureGroups >= a.minCreatureGroups, `${b.id} >= ${a.id}`);
  }
  const large = tierFor("large");
  assert.deepEqual(large.footprintDiameterM, { min: 300, max: 600 });
  assert.ok(large.minLinkedFeatures >= 3 && large.minCreatureGroups >= 3 && large.terrainShaping);
  assert.ok(large.requiredFeatureKinds.includes("landmark") && large.oneOfFeatureKinds.includes("water") && large.oneOfFeatureKinds.includes("cave"));
  // "small" is what was built as medium/large before (the old 1,573 m2 small reference x4 = 6,292 m2 large)
  assert.ok(tierFor("small").minUsableAreaM2 >= 1573 * 2);
  assert.throws(() => tierFor("huge"), /unknown POI size/);
  assert.match(tierSummary(), /large 300-600 m across/);
});

test("a reservation smaller than its tier is refused; approaches count", () => {
  assert.match(reservationTierFault("large", { radius: 100, approaches: 3 }), /large place needs 300-600 m across; the reservation is 200 m/);
  assert.match(reservationTierFault("large", { radius: 200, approaches: 1 }), /3\+ distinct approaches/);
  assert.equal(reservationTierFault("large", { radius: 200, approaches: 3 }), null);
  assert.match(reservationTierFault("small", { radius: 30 }), /small place needs 100-150 m/);
  assert.equal(reservationTierFault("pinpoint", { radius: 15 }), null);
});

test("measured faults name every shortfall", () => {
  const m = { tier: "medium", footprintDiameterM: 120, footprintHullAreaM2: 9000, usableAreaM2: 4000, features: [{ id: "tower", kind: "landmark", linkedTo: [] }], creatureGroups: 1, approaches: 1, terrainEdits: 0 };
  const f = measurementFaults(m).join(" | ");
  for (const re of [/footprint 120 m/, /usable area 4000/, /0 linked feature/, /1 creature group/, /1 approach/, /no terrain shaping/]) assert.match(f, re);
  assert.deepEqual(measurementFaults({ ...m, footprintDiameterM: 200, footprintHullAreaM2: 30000, usableAreaM2: 12000, features: [{ id: "tower", kind: "landmark", linkedTo: ["pond", "yard"] }, { id: "pond", kind: "water", linkedTo: [] }, { id: "yard", kind: "camp", linkedTo: [] }], creatureGroups: 2, approaches: 2, terrainEdits: 1 }), []);
});

test("the creator brief, its owner prompt and handoff carry the tier targets", () => {
  const input = JSON.parse(fs.readFileSync(new URL("./creator/brief.example.json", import.meta.url), "utf8"));
  const job = prepareCreatorJob({ ...input, sizeTargets: { ...tierFor("pinpoint") } });
  assert.equal(job.brief.adventureSize, "large");
  assert.deepEqual(job.brief.sizeTargets, tierFor("large")); // an input value is replaced
  assert.ok(job.prompt.includes(tierTargetsText("large")));
  assert.match(job.prompt, /install REFUSES below them/);
  assert.match(job.prompt, /Reviewer: <their agent id>/);
  assert.equal(job.handoff.measurements.targetCombinedUsableAreaM2, tierFor("large").minUsableAreaM2);
  assert.deepEqual(job.handoff.measurements.features, []);
});

test("parented jobs: a door is a pinpoint child; the parent's tier is judged over the parent plus its children", async () => {
  const { aggregateMeasurement, parentedTierFault, measurementFaults, PARENTED_TIER } = await import("./size-tiers.mjs");
  assert.equal(PARENTED_TIER, "pinpoint");
  assert.equal(parentedTierFault("pinpoint", "old-kings"), null);
  assert.match(parentedTierFault("small", "old-kings"), /pinpoint child/);
  const place = { tier: "large", footprintDiameterM: 0, footprintHullAreaM2: 0, usableAreaM2: 28000, features: [{ id: "barrow", kind: "landmark", linkedTo: ["lake"] }, { id: "lake", kind: "water", linkedTo: [] }], creatureGroups: 2, approaches: 3, terrainEdits: 5 };
  const door = { job: "first-kings-door", usableAreaM2: 2500, features: [{ id: "door", kind: "cave", linkedTo: ["barrow"] }], creatureGroups: 1, approaches: 1, terrainEdits: 2 };
  const agg = aggregateMeasurement("large", [place, door], { diameter: 420, hullArea: 90000 });
  assert.equal(agg.usableAreaM2, 30500);
  assert.equal(agg.creatureGroups, 3);
  assert.equal(agg.approaches, 3);
  assert.deepEqual(agg.features.map((f) => f.id), ["barrow", "lake", "door"]);
  assert.deepEqual(measurementFaults(agg), []); // the place alone is short (28000 m2, 2 groups); with its door it meets large
  assert.ok(measurementFaults({ ...place, footprintDiameterM: 420, footprintHullAreaM2: 90000 }).length >= 2);
  // colliding feature ids keep both, the child's prefixed with its job
  assert.deepEqual(aggregateMeasurement("large", [place, { ...door, features: [{ id: "lake", kind: "water", linkedTo: [] }] }], { diameter: 1, hullArea: 1 }).features.map((f) => f.id), ["barrow", "lake", "first-kings-door/lake"]);
});

test("crossing tier: a bridge job is judged by span, seating, both approach reads and its end landmark, not by area", async () => {
  const { CROSSING_TIER, TIER_NAMES } = await import("./size-tiers.mjs");
  assert.deepEqual(TIER_NAMES, [...SIZE_NAMES, "crossing"]);
  assert.equal(tierFor("crossing"), CROSSING_TIER);
  assert.ok(!SIZE_NAMES.includes("crossing")); // outside the ordered sizes: site-finder and the growth test never see it
  const read = (name, end, distanceM, picture = true) => ({ name, end, distanceM, picture });
  // The Lych Span as measured: 839 m2 usable, no features linked, no creature groups
  const bridge = { tier: "crossing", footprintDiameterM: 331, footprintHullAreaM2: 42784, usableAreaM2: 839, features: [{ id: "bridge", kind: "landmark", linkedTo: [] }], creatureGroups: 0, approaches: 2, terrainEdits: 4,
    crossing: { spanM: 119.8, clearanceM: 106.5, seated: true, reads: [read("read-south", "start", 319), read("read-north", "end", 346)], endHeightM: 21, roads: 2 } };
  assert.deepEqual(measurementFaults(bridge), []);
  const f = measurementFaults({ ...bridge, crossing: { spanM: 40, clearanceM: 1, seated: false, reads: [read("read-south", "start", 120), read("read-north", "end", 340, false)], endHeightM: 2, roads: 1 }, approaches: 1 }).join(" | ");
  for (const re of [/span 40 m/, /1 m over the ground/, /not seated/, /no read from the start approach.*read-south 120 m/, /no read from the end approach.*no picture/, /no landmark >= 6 m/, /1 approach road/]) assert.match(f, re);
  assert.match(measurementFaults({ ...bridge, crossing: undefined })[0], /no crossing measurement/);
  // the same numbers judged as a medium place still fail on area, features and creatures
  const camp = measurementFaults({ ...bridge, tier: "medium", crossing: undefined }).join(" | ");
  for (const re of [/usable area 839 m2/, /creature group/]) assert.match(camp, re);
  assert.match(tierTargetsText("crossing"), /span >= 60 m.*read-\* view >= 300 m/);
  assert.equal(reservationTierFault("crossing", { radius: 60, approaches: 2 }), null);
  assert.match(reservationTierFault("crossing", { radius: 60, approaches: 1 }), /2\+ distinct approaches/);
});
