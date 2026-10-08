import { test } from "node:test";
import assert from "node:assert/strict";
import { findSites, type FieldLike } from "../tools/zonegen/commands/_site-finder.mts";

// A synthetic zone: a high flat plateau (y 90) cut by a trench (y 10) running east from x = 0 (a canyon with its closed
// end at x = 0 and its mouth to the east), a lake (surface 50) sunk into the plateau, and a path that climbs out of
// the trench onto the plateau and stops there.
const inLake = (x: number, z: number): boolean => x > 600 && x < 900 && z > 200 && z < 500;
const field: FieldLike = {
  height: (x, z) => (inLake(x, z) ? 30 : Math.abs(z) < 40 && x > 0 ? 10 : 90),
  waterSurface: (x, z, out) => {
    if (!inLake(x, z)) return false;
    out.y = 50;
    out.kind = "lake";
    return true;
  },
};
const report = findSites({
  field,
  seaLevel: -100,
  polygon: [[-600, -800], [1400, -800], [1400, 800], [-600, 800]],
  zone: "z",
  roads: [{ id: "trail-up", trail: true, points: [[1000, 0], [1000, -60], [1000, -300]] }],
  content: [{ id: "town", kind: "town", x: 1300, z: 600, radius: 60 }],
});

test("finds the closed end of the trench, mouth to the east, back wall at its foot", () => {
  const end = report.candidates.find((c) => c.kind === "canyon-end");
  assert.ok(end, "a canyon end");
  assert.ok(end.at[0] < 80 && Math.abs(end.at[1]) < 40, `at the closed end, got ${end.at}`);
  assert.equal(end.detail.mouth, "E");
  assert.ok(end.detail.backWall && end.detail.backWall[0] <= end.at[0]);
});

test("finds a perch on the cliff over the lake", () => {
  const cliff = report.candidates.find((c) => c.kind === "cliff-water");
  assert.ok(cliff, "a cliff over water");
  assert.ok(cliff.detail.drop >= 35, `drop ${cliff.detail.drop}`);
});

test("a path that climbs and stops leads nowhere", () => {
  const dead = report.paths.find((p) => p.road === "trail-up" && p.kind === "dead-end" && p.at[1] < -200);
  assert.ok(dead, "the dead end");
  assert.ok(dead.climb >= 60 && dead.leadsTo === null);
});

test("the empty plateau is a large landform nobody uses, and the largest empty disc is big", () => {
  assert.ok(report.landforms.some((l) => l.areaHa > 100 && l.covered < 0.25));
  assert.ok(report.largestEmpty && report.largestEmpty.radius > 450);
  assert.ok(report.perKm2 < 1);
});

// ---- world-standards sites.md: hostile places off town-to-town roads, lake islands, access devices
import { hostileOnMainRoads, mainRoads } from "../tools/zonegen/commands/_site-finder.mts";

test("a hostile place on a town-to-town road is flagged; a lookout and a trail are not", () => {
  const content = [
    { id: "a", kind: "town" as const, x: 0, z: 0, radius: 50 },
    { id: "b", kind: "town" as const, x: 2000, z: 0, radius: 50 },
    { id: "camp", kind: "reservation" as const, x: 1000, z: 40, radius: 30, hostile: true },
    { id: "watch", kind: "reservation" as const, x: 600, z: -50, radius: 20, hostile: true, overlooksRoad: true },
    { id: "farm", kind: "reservation" as const, x: 1400, z: 10, radius: 30 },
    { id: "den", kind: "reservation" as const, x: 1000, z: 600, radius: 30, hostile: true },
  ];
  const roads = [
    { id: "path-a-b", trail: false, points: [[60, 0], [1940, 0]] as [number, number][] },
    { id: "trail-peak-1", trail: true, points: [[1000, 0], [1000, 560]] as [number, number][] },
  ];
  assert.deepEqual(mainRoads(roads, content).map((r) => r.id), ["path-a-b"]);
  const hits = hostileOnMainRoads(content, roads);
  assert.deepEqual(hits.map((h) => [h.place, h.lookout]), [["camp", false], ["watch", true]]);
  assert.ok(hits[0]!.gap <= 10);
});

// a lake (surface 20, floor 0) round a 60x60 m island (ground 30), on a 60 m high mesa ringed by cliffs, with a road
// along the low ground (y 0)
const isle = (x: number, z: number): boolean => Math.abs(x - 300) < 30 && Math.abs(z) < 30;
const lake = (x: number, z: number): boolean => Math.abs(x - 300) < 150 && Math.abs(z) < 150 && !isle(x, z);
const mesa = (x: number, z: number): boolean => Math.hypot(x + 400, z) < 120;
const field2: FieldLike = {
  height: (x, z) => (isle(x, z) ? 30 : lake(x, z) ? 0 : mesa(x, z) ? 60 : 4),
  waterSurface: (x, z, out) => {
    if (!lake(x, z)) return false;
    out.y = 20;
    out.kind = "lake";
    return true;
  },
};
const report2 = findSites({
  field: field2,
  seaLevel: -100,
  polygon: [[-800, -600], [800, -600], [800, 600], [-800, 600]],
  zone: "z",
  roads: [{ id: "road", trail: false, points: [[-750, -300], [750, -300]] }],
  // (a zone with no content at all never finishes its empty-land search: keep one town)
  content: [{ id: "t", kind: "town", x: 700, z: 500, radius: 30 }],
});

test("an island in a lake is a candidate", () => {
  const island = report2.candidates.find((c) => c.kind === "island");
  assert.ok(island, "an island");
  assert.ok(Math.abs(island.at[0] - 300) <= 30 && Math.abs(island.at[1]) <= 30, `at ${island.at}`);
  assert.equal(island.reachable, false);
});

test("strong sites with no walkable way up get an access device candidate", () => {
  const plateau = report2.candidates.find((c) => c.kind === "plateau" && Math.hypot(c.at[0] + 400, c.at[1]) < 120);
  assert.ok(plateau, "the mesa plateau");
  assert.equal(plateau.reachable, false);
  const access = report2.candidates.filter((c) => c.kind === "access");
  const up = access.find((a) => a.detail.for === plateau.id);
  assert.ok(up, "an access device for the mesa");
  assert.ok(["lift", "cliff-stair", "rope-way"].includes(up.detail.device), up.detail.device);
  assert.ok(up.detail.rise >= 40);
  const isl = report2.candidates.find((c) => c.kind === "island")!;
  const boat = access.find((a) => a.detail.for === isl.id);
  assert.ok(boat, "an access device for the island");
  assert.equal(boat.detail.device, "bridge-or-ferry");
});
