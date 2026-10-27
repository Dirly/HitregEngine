import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { defaultWorldRecipe, worldRecipeSchema, type RoadDoc, type WorldRecipe } from "@hitreg/core";
import { commandRoad, densify, inAvoid, roadEdits, routeAnchors } from "../tools/worldgen-road.mts";
import { solveProfile } from "../tools/worldgen-routing.mts";

// `worldgen road`: one carved+painted road along a drawn line, never re-routed, idempotent, stage-owned ids refused
const base = worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24 });
const withRoads = (roads: Partial<RoadDoc>[]): WorldRecipe => worldRecipeSchema.parse({ ...base, features: { ...base.features, roads } });
const INV = path.join(os.tmpdir(), `worldgen-road-test.${process.pid}.json`);
process.on("exit", () => fs.rmSync(INV, { force: true }));
const run = (recipe: WorldRecipe, argv: string[]) => {
  let written: WorldRecipe | null = null;
  const log = console.log;
  console.log = () => {};
  try {
    commandRoad({
      argv: [...argv, "--inverse", INV],
      loadRecipe: () => ({ recipe, file: "scratch/world.json" }),
      writeRecipe: (r) => { written = r; },
      fail: (m) => { throw new Error(m); },
      grade: (id, points, _field, o) => ({
        roads: [{ id, points, width: o.width, shoulder: 4, smooth: 8, surfaceY: points.map(() => 1), flatten: 1, surface: "dirt", surfaceEdge: 2.5 } as RoadDoc],
        bridges: [],
      }),
    });
  } finally { console.log = log; }
  return written as WorldRecipe | null;
};

test("densify keeps the drawn ends and spaces the line", () => {
  const d = densify([[0, 0], [10, 0]], 2);
  assert.equal(d.length, 6);
  assert.deepEqual(d[0], [0, 0]);
  assert.deepEqual(d.at(-1), [10, 0]);
});

test("road adds one road and leaves every other road alone", () => {
  const r = run(withRoads([{ id: "path-a-b", points: [[0, 0], [9, 9]] }]), ["--id", "road-x", "--points", "0,0;0,40", "--width", "6", "--keep-landforms"])!;
  assert.deepEqual(r.features.roads.map((x) => x.id), ["path-a-b", "road-x"]);
  const x = r.features.roads[1]!;
  assert.equal(x.width, 6);
  assert.equal(x.keepLandforms, true);
  assert.deepEqual(x.points[0], [0, 0]);
  assert.deepEqual(x.points.at(-1), [0, 40]);
});

test("re-running replaces the road of that id instead of adding a second", () => {
  const once = run(withRoads([]), ["--id", "road-x", "--points", "0,0;0,40"])!;
  const twice = run(once, ["--id", "road-x", "--points", "0,0;0,40"])!;
  assert.equal(twice.features.roads.filter((x) => x.id === "road-x").length, 1);
  assert.equal(roadEdits(twice, "road-x", [], []).length, 1);
});

test("stage-owned ids are refused (the paths/trails stages rewrite them)", () => {
  assert.throws(() => run(withRoads([]), ["--id", "path-x", "--points", "0,0;0,40"]), /must start with road-/);
  assert.throws(() => run(withRoads([]), ["--id", "trail-x", "--points", "0,0;0,40"]), /must start with road-/);
});

test("--remove takes the road out", () => {
  const once = run(withRoads([]), ["--id", "road-x", "--points", "0,0;0,40"])!;
  const gone = run(once, ["--remove", "road-x"])!;
  assert.equal(gone.features.roads.length, 0);
});

test("solveProfile grades up to a pinned end instead of stepping up to it", () => {
  // flat then a hill: the end is pinned 8 m up, 20 points of 2 m at a 0.4 cap
  const natural = Array.from({ length: 21 }, (_, i) => (i < 10 ? 0 : (i - 10) * 0.8));
  const spans = natural.map((_, i) => (i === 0 ? 0 : 2));
  const y = solveProfile(natural, spans, { maxGrade: 0.4, maxFill: 0.5, maxCut: 3, finalClamp: "grade" }, { end: 8 });
  assert.equal(y.at(-1), 8);
  for (let i = 1; i < y.length; i++) assert.ok(Math.abs(y[i]! - y[i - 1]!) <= 0.8 + 1e-6, `step ${i}: ${y[i - 1]} -> ${y[i]}`);
});

test("--route goes round an avoid disc and keeps its anchors (a built place is a wall)", () => {
  const flat = { ground: () => 10, wet: () => false };
  const avoid = { discs: [[0, 50, 20]] as [number, number, number][] };
  const r = routeAnchors([[0, 0], [0, 100]], flat, { avoid, pad: 60 });
  assert.ok("points" in r, JSON.stringify(r));
  const pts = (r as { points: [number, number][] }).points;
  assert.deepEqual(pts[0], [0, 0]);
  assert.deepEqual(pts.at(-1), [0, 100]);
  for (const [x, z] of pts) assert.ok(!inAvoid(avoid, x, z), `route point ${x},${z} inside the avoid disc`);
});

test("--route never crosses water and fails a leg it cannot join", () => {
  const moat = { ground: () => 10, wet: (_x: number, z: number) => z > 40 && z < 60 };
  const r = routeAnchors([[0, 0], [0, 100]], moat, { pad: 30 });
  assert.ok("error" in r, "a leg across a moat with no dry way must fail");
  const ford = { ground: () => 10, wet: (x: number, z: number) => z > 40 && z < 60 && x < 40 };
  const ok = routeAnchors([[0, 0], [0, 100]], ford, { pad: 70 });
  assert.ok("points" in ok);
  for (const [x, z] of (ok as { points: [number, number][] }).points) assert.ok(!ford.wet(x, z), `route point ${x},${z} in the water`);
});

test("--role sets the painted class of the tread", () => {
  const r = run(withRoads([]), ["--id", "road-x", "--points", "0,0;0,40", "--role", "paving"])!;
  assert.equal(r.features.roads[0]!.role, "paving");
  assert.throws(() => run(withRoads([]), ["--id", "road-x", "--points", "0,0;0,40", "--role", "planks"]), /--role/);
});
