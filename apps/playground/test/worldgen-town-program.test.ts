import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldRecipe } from "@hitreg/core";
import { PROGRAM_RULE, bandStreet, fallLine, measureShelfFlat, planProgramShelves, programFitFindings, programFromPlan } from "../tools/worldgen-town-program.mts";

// a plan of two buildings at kit sizes (3.2 m cells), one with a measured envelope
const plan = {
  buildings: [
    { id: "chapel", request: { size: [4, 8] as [number, number] } },
    { id: "house", request: { size: [5, 3] as [number, number] } },
    { id: "house-2", model: "house" },
  ],
};
const envelopes = { chapel: { full: { left: 0, right: 0, front: 1, back: 1 }, ground: { left: 0, right: 0, front: 0.5, back: 0.5 } } };

test("program area = lots x margin + streets + wall clearance, every building counted (a reused model too)", () => {
  const p = programFromPlan(plan, envelopes);
  assert.equal(p.lots, 3);
  // chapel 4 x (8 + 1 + 1) cells; house (5 + .9) x (3 + 1.3) cells with the default envelope, twice
  const chapel = 4 * 3.2 * (10 * 3.2);
  const house = (5 + 0.9) * 3.2 * ((3 + 1.3) * 3.2);
  assert.ok(Math.abs(p.lotArea / ((chapel + 2 * house) * PROGRAM_RULE.margin) - 1) < 0.01);
  const streets = (4 * 3.2 + 1 + 2 * ((5 + 0.9) * 3.2 + 1)) * (PROGRAM_RULE.street / 2) * PROGRAM_RULE.junction;
  assert.ok(Math.abs(p.streetArea / streets - 1) < 0.01);
  const base = p.lotArea + p.streetArea;
  assert.ok(Math.abs(p.area - (base + PROGRAM_RULE.wallClear * 2 * Math.sqrt(Math.PI * base) * PROGRAM_RULE.wallShare)) <= 2);
  // the chapel turns onto a cross lane: across a band it needs its SHORT side + setback
  assert.equal(p.detail.find((l) => l.id === "chapel")!.across, Math.round((4 * 3.2 + PROGRAM_RULE.setback) * 10) / 10);
});

// a straight hillside: falls 0.15 toward +z, sea at z > 120
const hill = (x: number, z: number): number => 20 - 0.15 * z + 0 * x;
const input = (over = {}) => ({
  height: hill,
  sea: 0,
  centre: [0, 60] as [number, number],
  radius: 45,
  required: 4000,
  across: 18,
  acrossTypical: 15,
  street: 5,
  riser: 5,
  maxStep: 6,
  minStep: 2.4,
  maxTerraces: 5,
  reach: 90,
  cutTol: 3,
  maxRelief: 30,
  inset: 1.5,
  ...over,
});

test("the fall line of a plane is found", () => {
  const f = fallLine(hill, [0, 60], 40);
  assert.ok(Math.abs(f.slope - 0.15) < 1e-6);
  assert.ok(Math.abs(f.downhill[0]) < 1e-6 && Math.abs(f.downhill[1] - 1) < 1e-6);
});

test("shelves are street-shaped bands along the contour that hold the program", () => {
  const p = planProgramShelves(input());
  assert.equal(p.ok, true, p.why.join("; "));
  assert.ok(p.capacity >= 4000);
  for (const b of p.bands) {
    // along the contour: the band's ends are at one height of the plane
    assert.ok(Math.abs(hill(b.a[0], b.a[1]) - hill(b.b[0], b.b[1])) < 1e-6);
    assert.ok(b.length > b.depth * 0.6);
    // one wall-high step at most between neighbours
  }
  for (let i = 1; i < p.bands.length; i++) {
    const step = p.bands[i]!.level - p.bands[i - 1]!.level;
    assert.ok(step > 2.4 && step <= 6.9, `step ${step}`);
  }
  // the lowest band holds the deepest lot + a street + the wall inset
  assert.ok(p.bands[0]!.depth >= 18 + 5 + 3);
  // and a street rides each band in its direction
  const s = bandStreet(p.bands[0]!, p.downhill, 15, 5, 1.5);
  assert.ok(Math.abs(Math.hypot(s.axis[0], s.axis[1]) - 1) < 0.02);
});

test("a bigger program gets longer or more bands, not wider ones", () => {
  const small = planProgramShelves(input({ required: 2500 }));
  const big = planProgramShelves(input({ required: 6000 }));
  assert.ok(small.ok && big.ok);
  const run = (p: typeof small) => p.bands.reduce((s, b) => s + b.length, 0);
  assert.ok(run(big) > run(small));
  assert.ok(Math.max(...big.bands.map((b) => b.depth)) <= 2 * 15 + 5 + 3 + 1e-9);
});

test("ground that cannot hold the program FAILS with the shortfall and why", () => {
  const p = planProgramShelves(input({ required: 60000, reach: 60 }));
  assert.equal(p.ok, false);
  assert.match(p.why[0]!, /short \d+ m2/);
  assert.ok(p.why.some((w) => /reach|max-terraces|relief|long/.test(w)), p.why.join("; "));
});

// ---- the gate on a recipe (a flat-topped mock field: shelves read as level at their own height)

function recipeWith(terraces: { id: string; points: [number, number][]; radius: number; groundY: number }[]) {
  return {
    name: "t",
    seaLevel: 0,
    features: { towns: [{ id: "town-1", center: [0, 0], radius: 45, falloff: 30, flatten: 0, gates: [], tags: [], terraces: terraces.map((t) => ({ ...t, falloff: 5, flatten: 1, tags: [] })), program: { area: 3000, lots: 9, across: 18, source: "recipe" } }] },
  } as unknown as WorldRecipe;
}
const fieldOf = (terraces: { points: [number, number][]; radius: number; groundY: number }[]) => ({
  height: (x: number, z: number) => {
    for (const t of terraces) {
      const [a, b] = [t.points[0]!, t.points[t.points.length - 1]!];
      const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
      if (Math.hypot(x - a[0] - dx * u, z - a[1] - dz * u) <= t.radius) return t.groundY;
    }
    return 50;
  },
  waterY: () => null,
});

test("program-fit fails a town whose shelves hold less than its program, and passes one that holds it", () => {
  const small = [{ id: "town-1-terrace-1", points: [[0, 0]] as [number, number][], radius: 20, groundY: 4 }];
  const r1 = recipeWith(small);
  const flat = measureShelfFlat(fieldOf(small), r1.features.towns[0]!, 0);
  assert.ok(flat.area > 1100 && flat.area < 1400, `disc r20 ~ ${flat.area}`);
  const f1 = programFitFindings(r1, fieldOf(small), null);
  assert.equal(f1.length, 1);
  assert.match(f1[0]!, /needs 3000 m2 .* hold \d+ m2 \(short \d+\)/);

  const bands = [
    { id: "town-1-terrace-1", points: [[-40, 0], [40, 0]] as [number, number][], radius: 13, groundY: 4 },
    { id: "town-1-terrace-2", points: [[-40, -32], [40, -32]] as [number, number][], radius: 13, groundY: 10 },
  ];
  const r2 = recipeWith(bands);
  const flat2 = measureShelfFlat(fieldOf(bands), r2.features.towns[0]!, 0);
  // a band is a street, not a capsule: 80 x 26 each, end caps not counted
  assert.ok(Math.abs(flat2.area - 2 * 80 * 26) < 2 * (80 + 26) * 2 + 100, `bands ${flat2.area}`);
  assert.deepEqual(programFitFindings(r2, fieldOf(bands), null), []);
});
