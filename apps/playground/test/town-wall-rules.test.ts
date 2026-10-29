import { test } from "node:test";
import assert from "node:assert/strict";
import { keepOffRoads, overlook, polyDist, roadCrowding, ROAD_KEEP, TOWN_MASONRY, townOwnerOf, townWallMaterialFault, waterlineRuns, type Screen } from "../tools/_town-wall-rules.mts";

type V2 = [number, number];
// a town on flat ground at y 0 inside x,z in [-20, 20]; a straight wall along x = 30 (z -40..40); a hill rising east of it
const wallLine = (top: number): Screen => ({ id: "t-wall-1", profile: Array.from({ length: 21 }, (_, i) => [30, -40 + i * 4, top] as [number, number, number]) });
const hill = (x: number, _z: number) => (x > 32 ? (x - 32) * 0.5 : 0);
const enclosure: V2[] = [[-25, -45], [30, -45], [30, 45], [-25, 45]];
const targets = [{ name: "street #0", at: [0, 0] as V2 }, { name: "door hall", at: [10, 5] as V2 }];

test("material: a town-owned wall with no face material bakes on the cliff skin (fault); town masonry passes", () => {
  assert.match(townWallMaterialFault({ id: "t-wall-1" }) ?? "", /unset/);
  assert.match(townWallMaterialFault({ id: "t-wall-1", materials: { face: "zone-stone" } }) ?? "", /terrain skin/);
  assert.match(townWallMaterialFault({ id: "t-wall-1", materials: { face: TOWN_MASONRY.ashlar, cap: "surface:cliff" } }) ?? "", /materials.cap/);
  assert.equal(townWallMaterialFault({ id: "t-wall-1", materials: { face: TOWN_MASONRY.ashlar } }), null);
});

test("townOwnerOf: by name or inside the radius; ramps are not town walls", () => {
  const towns = [{ id: "town-1", name: "t", center: [0, 0], radius: 40 }];
  assert.equal(townOwnerOf({ id: "t-net-quay", op: "wall", points: [[500, 500]] }, towns), "town-1");
  assert.equal(townOwnerOf({ id: "x", op: "wall", points: [[50, 0]] }, towns), "town-1");
  assert.equal(townOwnerOf({ id: "x", op: "wall", variant: "ramp", points: [[0, 0]] }, towns), null);
  assert.equal(townOwnerOf({ id: "x", op: "wall", points: [[200, 0]] }, towns), null);
});

test("overlook: a 6 m wall under a hill is overlooked from the hill; a wall taller than the hill's eye in the band is not", () => {
  const low = overlook({ height: hill, screens: [wallLine(6)], enclosure, targets, sea: -5 });
  assert.ok(low.overlooking > 0 && low.worst, "the hill sees over a 6 m wall");
  assert.ok(low.worst!.at[0] > 32 && low.worst!.over > 0);
  // the hill reaches 0.5 x (90 - 32) = 29 m at the band's edge: a 31 m screen hides the town from all of it
  const tall = overlook({ height: hill, screens: [wallLine(31)], enclosure, targets, sea: -5 });
  assert.equal(tall.overlooking, 0);
});

test("waterline: a wall at the sea with its top under the shelf it fronts is a waterline run", () => {
  const screen: Screen = { id: "t-wall-2", profile: [[0, 0, 4], [4, 0, 4]] };
  const runs = waterlineRuns({ height: () => 0.5, screens: [screen], shelves: [{ groundY: 10, points: [[0, 10], [4, 10]] }], sea: 0 });
  assert.equal(runs.length, 2);
  assert.equal(waterlineRuns({ height: () => 0.5, screens: [{ id: "q", profile: [[0, 0, 12]] }], shelves: [{ groundY: 10, points: [[0, 10]] }], sea: 0 }).length, 0);
});

test(`road keep-off: a curtain within ${ROAD_KEEP} m of a road fails except inside the gatehouse disc; keepOffRoads pulls the line to the town side`, () => {
  // a road along x = 40 outside the town (centroid 0,0); a wall line that wanders over it (vertex at x 43, beyond the road)
  const road: V2[] = [[40, -60], [40, 60]];
  const line: V2[] = [[30, -40], [36, -20], [43, 0], [36, 20], [30, 40]];
  const bad = roadCrowding([{ id: "w", points: line }], [{ id: "r", points: road }], []);
  assert.equal(bad.length, 1);
  assert.ok(bad[0]!.d < 0.5, "the line crosses the road");
  // an exempt disc round the crossing alone does not excuse the 4 m stretches either side
  assert.equal(roadCrowding([{ id: "w", points: line }], [{ id: "r", points: road }], [{ at: [43, 0], r: 8 }]).length, 1);
  const fixed = keepOffRoads(line, [road], [], new Set(), [0, 0]);
  for (const q of fixed.slice(1, -1)) assert.ok(q[0] < 40 && polyDist(q, road) >= ROAD_KEEP, `vertex ${q.join(",")} on the town side, >= ${ROAD_KEEP} m off`);
  assert.deepEqual(fixed[0], line[0], "the ends stay");
  // a vertex inside a gatehouse disc stays
  assert.deepEqual(keepOffRoads(line, [road], [{ at: [43, 0], r: 3 }], new Set(), [0, 0])[2], [43, 0]);
});
