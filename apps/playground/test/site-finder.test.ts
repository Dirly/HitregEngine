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

test("a peak over the sea (its summit cut away by a sea cliff) is no site; on land it is", () => {
  // one cone summit (y 120 at 0,0) on a y 20 plain; the 2D height keeps it, the real surface says sea at y 0
  const cone: FieldLike = { height: (x, z) => Math.max(20, 120 - Math.hypot(x, z) * 0.5), waterSurface: () => false };
  const run = (f: FieldLike) => findSites({ field: f, seaLevel: 0, polygon: [[-600, -600], [600, -600], [600, 600], [-600, 600]], zone: "p", roads: [{ id: "t", trail: true, points: [[300, 0], [300, -300]] }], content: [{ id: "town", kind: "town", x: 500, z: 500, radius: 60 }] }).candidates.filter((c) => c.kind === "peak");
  assert.ok(run({ ...cone, surfaceCast: (x, z) => cone.height(x, z) }).length > 0, "a summit on land is a peak");
  assert.equal(run({ ...cone, surfaceCast: () => 0 }).length, 0, "a summit over the sea is not");
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
  assert.ok(report.claim.share < 0.05 && report.claim.byTier.town.places === 1);
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

// ---- DC set pieces (docs/voxel-worlds.md §30/§30a): the field reports stacks, monuments, falls and rivers itself, and
// on planar terrain the DRAWN ground (field.ground) carries what height() lacks. A 60 m mainland west of x = 400 with a
// headland jutting to x = 560 (|z| < 50), three stacks off it and one alone far out, a mesa, and a river in a 50 m deep
// gorge that bends 45 degrees and falls 40 m.
const gorge: [number, number][] = [[-500, -300], [-200, -300], [-100, -300], [-40, -240], [20, -180], [80, -120]];
const gorgeDist = (x: number, z: number): number => {
  let d = Infinity;
  for (let i = 1; i < gorge.length; i++) {
    const [ax, az] = gorge[i - 1]!;
    const [bx, bz] = gorge[i]!;
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
    d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)));
  }
  return d;
};
const dcStacks = [
  { x: 600, z: -20, radius: 10, top: 45, arch: false },
  { x: 650, z: 40, radius: 9, top: 50, arch: true },
  { x: 700, z: -30, radius: 8, top: 40, arch: false },
  { x: 750, z: 500, radius: 10, top: 35, arch: false },
];
const onStack = (x: number, z: number) => dcStacks.find((t) => Math.hypot(x - t.x, z - t.z) < t.radius);
const mesaAt = (x: number, z: number): boolean => Math.abs(x + 300) < 80 && Math.abs(z - 300) < 60;
const dcHeight = (x: number, z: number): number => (x > 400 && !(x < 560 && Math.abs(z) < 50) ? -20 : mesaAt(x, z) ? 160 : gorgeDist(x, z) < 15 ? 10 : 60);
const dcField: FieldLike = {
  height: dcHeight,
  // stacks are in the drawn ground only, as on a real planar world
  ground: (x, z) => onStack(x, z)?.top ?? dcHeight(x, z),
  waterSurface: (x, z, out) => {
    if (gorgeDist(x, z) >= 8 || x > 400) return false;
    out.y = x < -150 ? 52 : 13;
    out.kind = "river";
    return true;
  },
  falls: [{ river: "r1", x: -150, z: -300, top: 52, bottom: 12, dirX: 1, dirZ: 0 }],
  rivers: [{ id: "r1", points: gorge }],
  seaCliffs: () => ({ stacksIn: () => dcStacks }),
  buttes: () => ({ monumentsIn: () => [{ x: -300, z: 300, kind: "mesa", radius: 70, top: 160 }, { x: 0, z: 500, kind: "spire", radius: 8, top: 150 }] }),
};
const dcReport = findSites({
  field: dcField,
  seaLevel: 0,
  polygon: [[-700, -700], [900, -700], [900, 700], [-700, 700]],
  zone: "z",
  roads: [{ id: "road", trail: false, points: [[-650, 0], [300, 0]] }],
  content: [{ id: "t", kind: "town", x: -600, z: -600, radius: 30 }],
  planar: true,
});
const ofKind = (k: string) => dcReport.candidates.filter((c) => c.kind === k);

test("planar ground: the stacks are sampled from field.ground, so a stack is dry and high", () => {
  const s = ofKind("sea-stack");
  assert.equal(s.length, 4);
  const arch = s.find((c) => c.detail.arch);
  assert.ok(arch && Math.hypot(arch.at[0] - 650, arch.at[1] - 40) < 2, "the arch stack");
  assert.ok(s.every((c) => c.reachable === false), "a stack is reached by a bridge or a boat");
});

test("three stacks off the headland are one cluster; the lone stack far out is not", () => {
  const cl = ofKind("stack-cluster");
  assert.equal(cl.length, 1);
  assert.equal(cl[0]!.detail.stacks.length, 3);
  assert.ok(cl[0]!.detail.headland, "near a headland");
  assert.ok(cl[0]!.detail.shore.gap <= 60, `shore gap ${cl[0]!.detail.shore.gap}`);
});

test("the headland is found where the land juts into the sea, not along the straight coast", () => {
  const h = ofKind("headland");
  assert.ok(h.length >= 1);
  assert.ok(h.some((c) => c.at[0] > 480 && Math.abs(c.at[1]) < 60), `headlands at ${h.map((c) => c.at).join(" ")}`);
  assert.ok(!h.some((c) => c.at[0] < 420 && Math.abs(c.at[1]) > 300), "no headland on the straight coast");
});

test("a mesa top is a butte-top site; a spire is not", () => {
  const b = ofKind("butte-top");
  assert.equal(b.length, 1);
  assert.ok(Math.hypot(b[0]!.at[0] + 300, b[0]!.at[1] - 300) < 2 && b[0]!.detail.rise >= 90);
});

test("a fall gives a lip and a plunge pool, and the gorge bend is a canyon bend", () => {
  const lip = ofKind("fall-lip")[0];
  const pool = ofKind("plunge-pool")[0];
  assert.ok(lip && lip.at[0] < -150 && pool && pool.at[0] > -150, `lip ${lip?.at} pool ${pool?.at}`);
  const bend = ofKind("canyon-bend");
  assert.ok(bend.length >= 1, "a bend");
  assert.ok(bend.some((c) => Math.hypot(c.at[0] + 100, c.at[1] + 300) < 60 && c.detail.depth >= 40), `bends ${bend.map((c) => c.at + ":" + c.detail.depth).join(" ")}`);
});

test("a world without DC features finds none of the DC kinds", () => {
  const dc = new Set(["fall-lip", "plunge-pool", "sea-stack", "stack-cluster", "butte-top", "canyon-bend"]);
  assert.ok(!report.candidates.some((c) => dc.has(c.kind)));
  assert.ok(!report2.candidates.some((c) => dc.has(c.kind)));
});

// ---- density as land claimed by place footprints, by size tier (not places per km2)
import { areaClaim, claimFaults, tierOfDiameter, AREA_CLAIM } from "../tools/zonegen/commands/_site-finder.mts";

test("a footprint's tier comes from its diameter (size tiers)", () => {
  assert.equal(tierOfDiameter(24), "pinpoint");
  assert.equal(tierOfDiameter(120), "small");
  assert.equal(tierOfDiameter(200), "medium");
  assert.equal(tierOfDiameter(600), "large");
});

test("three big districts fill a zone that thirty cairns leave empty; overlaps count once, for the bigger tier", () => {
  // 2 x 2 km of land on a 10 m grid
  const grid = { nx: 201, nz: 201, x0: 0, z0: 0, step: 10, land: new Uint8Array(201 * 201).fill(1) };
  const districts = [[400, 400], [1500, 600], [900, 1500]].map(([x, z]) => ({ x: x!, z: z!, radius: 300, tier: "large" as const }));
  const big = areaClaim(grid, districts);
  assert.ok(big.share > 0.18 && big.share < 0.25, `share ${big.share}`);
  assert.equal(big.bigShare, big.share);
  assert.deepEqual(claimFaults(big), []);
  const cairns = Array.from({ length: 30 }, (_, i) => ({ x: 100 + (i % 6) * 350, z: 100 + Math.floor(i / 6) * 400, radius: 15, tier: "pinpoint" as const }));
  const finds = areaClaim(grid, cairns);
  assert.ok(finds.share < 0.01);
  assert.deepEqual(claimFaults(finds).map((x) => x.code), ["sparse", "no-big-places"]);
  // a door (pinpoint) inside its district adds no land and is credited to the district
  const both = areaClaim(grid, [...districts, { x: 400, z: 400, radius: 12, tier: "pinpoint" }]);
  assert.equal(both.share, big.share);
  assert.equal(both.byTier.pinpoint.share, 0);
  assert.equal(both.byTier.pinpoint.places, 1);
  // water is not land: the same districts on a half-flooded zone claim a bigger share of what is left
  const wet = { ...grid, land: grid.land.map((_, k) => (k % 201 < 100 ? 1 : 0)) };
  assert.ok(areaClaim(wet, districts).landKm2 < 2.1);
  // wall-to-wall places are crowded
  const crowd = areaClaim(grid, [{ x: 1000, z: 1000, radius: 1000, tier: "large" }]);
  assert.ok(crowd.share > AREA_CLAIM.max);
  assert.deepEqual(claimFaults(crowd).map((x) => x.code), ["crowded"]);
});


// ---- crossings: a river in a 70 m gorge running east-west; its south rim is 30 m higher east of x = 100, a road
// reaches each rim at x = -200, and a creek in the north plain is too narrow to be one
test("a crossing spans the gorge rim to rim where the banks match and both banks have a road", () => {
  const rim = (x: number, z: number): number => (z > 0 && x > 100 ? 110 : 80);
  const gorgeH = (x: number, z: number): number => {
    const d = Math.abs(z);
    return d < 20 ? 8 : d < 40 ? 8 + ((d - 20) / 20) * (rim(x, z) - 8) : rim(x, z);
  };
  const creek = (x: number, z: number): boolean => Math.abs(z + 400) < 3;
  const f: FieldLike = {
    height: (x, z) => (creek(x, z) ? 78 : gorgeH(x, z)),
    waterSurface: (x, z, out) => {
      if (Math.abs(z) < 10) (out.y = 12), (out.kind = "river");
      else if (creek(x, z)) (out.y = 79), (out.kind = "river");
      else return false;
      return true;
    },
    rivers: [{ id: "deep", points: [[-700, 0], [700, 0]] }, { id: "creek", points: [[-700, -400], [700, -400]] }],
  };
  const rep = findSites({
    field: f,
    seaLevel: -100,
    polygon: [[-700, -600], [700, -600], [700, 600], [-700, 600]],
    zone: "z",
    roads: [
      { id: "north", trail: true, points: [[-200, -500], [-200, -90]] },
      { id: "south", trail: true, points: [[-200, 500], [-200, 90]] },
    ],
    content: [{ id: "t", kind: "town", x: 600, z: 550, radius: 30 }],
  });
  const xs = rep.candidates.filter((c) => c.kind === "crossing");
  assert.ok(xs.length >= 1, "a crossing");
  assert.ok(xs.every((c) => c.detail.river === "deep"), "the creek is too narrow");
  const top = xs[0]!;
  assert.ok(top.at[0] < 100 && Math.abs(top.at[0] + 200) < 160, `best crossing where the banks match, near the roads: ${top.at}`);
  assert.ok(top.detail.span >= 60 && top.detail.span <= 100, `span ${top.detail.span}`);
  assert.ok(top.detail.depth >= 60 && top.detail.match <= 1, `depth ${top.detail.depth} match ${top.detail.match}`);
  assert.ok(Math.abs(top.detail.waterWidth - 20) <= 8, `water ${top.detail.waterWidth}`);
  assert.deepEqual(top.detail.banks.map((b: { road: string }) => b.road).sort(), ["north", "south"]);
  assert.ok(top.y >= 79, "the candidate stands at deck height");
  const east = xs.find((c) => c.at[0] > 200);
  assert.ok(!east || east.score < top.score, "the mismatched banks score lower");
});
