import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { townDesignSchema, type TownDesign } from "../tools/town-design-schema.mts";
import { checkDesign, footprintOf, polyEdges, siteFall } from "../tools/town-design-check.mts";
import { measurePlatforms, planEarthworks } from "../tools/worldgen-terrace-from-plan.mts";

// a planar hillside: 20 m at z = 0, rising 0.15 m per metre toward -Z
const RISE = 0.15;
const hill = (_x: number, z: number) => 20 - z * RISE;
const site = { height: hill, sea: 0, ...siteFall(hill, [0, 10], 40) };
const house = { system: "common", size: [5, 3], storeys: 2, roof: "gable", features: ["fireplace"] };

/** Two platforms on the hillside, a bank between them, a ramp round the east end, four lots on two streets. */
function design(over: (d: Record<string, any>) => void = () => {}): TownDesign {
  const d: Record<string, any> = {
    town: "t", world: "w", name: "fixture", status: "approved",
    gate: { at: [0, 38], facing: [0, 1] },
    terraces: [
      { id: "low", level: 16.2, polygon: [[-30, 14], [30, 14], [30, 38], [-30, 38]], buildings: ["h1", "h2"] },
      { id: "high", level: 18.6, polygon: [[-30, -18], [30, -18], [30, 8], [-30, 8]], buildings: ["h3", "h4"] },
    ],
    streets: [
      { id: "low-street", name: "Low Street", kind: "main", points: [[-28, 32], [28, 32]], width: 5 },
      { id: "high-street", name: "High Street", kind: "lane", points: [[-28, -14], [28, -14]], width: 5 },
    ],
    squares: [{ id: "gate-square", name: "Gate Square", terrace: "low", polygon: [[-8, 28], [8, 28], [8, 35], [-8, 35]] }],
    connections: [{ id: "ramp", kind: "ramp", from: "low", to: "high", points: [[28, 20], [36, 14], [36, 4], [28, 2]], width: 4 }],
    landmark: { building: "h3", height: 12 },
    buildings: [
      { id: "h1", name: "H1", at: [-18, 21.94], facing: [0, 1], street: "low-street", request: house },
      { id: "h2", name: "H2", at: [18, 21.94], facing: [0, 1], street: "low-street", request: house },
      { id: "h3", name: "H3", at: [-16, -3.94], facing: [0, -1], street: "high-street", request: house },
      { id: "h4", name: "H4", at: [16, -3.94], facing: [0, -1], street: "high-street", model: "h3" },
    ],
  };
  over(d);
  return townDesignSchema.parse(d);
}

test("schema: a design parses; duplicate ids and a building with no request or model are refused", () => {
  assert.equal(design().terraces.length, 2);
  assert.throws(() => design((d) => d.terraces.push({ ...d.terraces[0] })), /duplicate terraces id/);
  assert.throws(() => design((d) => delete d.buildings[3].model), /needs a request or a model/);
  assert.throws(() => design((d) => (d.status = "frozen")));
});

test("geometry: outward normals whatever the winding; footprints are town-layout's (front on the street)", () => {
  for (const poly of [[[0, 0], [1, 0], [1, 1], [0, 1]], [[0, 0], [0, 1], [1, 1], [1, 0]]] as [number, number][][]) {
    for (const e of polyEdges(poly)) {
      const mid = [(e.a[0] + e.b[0]) / 2 + e.normal[0] * 0.1, (e.a[1] + e.b[1]) / 2 + e.normal[1] * 0.1];
      assert.ok(mid[0]! < 0 || mid[0]! > 1 || mid[1]! < 0 || mid[1]! > 1, "normal points out");
    }
  }
  const d = design();
  const f = footprintOf(d, d.buildings[0]!);
  // 5 x 3 cells, facing +z: 16 m along x, 9.6 m deep; the front envelope edge 1.76 m (0.55 cell) past the facade
  assert.deepEqual(f.size, [5, 3]);
  assert.ok(Math.abs(f.front[1] - (21.94 + 4.8 + 1.76)) < 0.01);
  assert.equal(footprintOf(d, d.buildings[3]!).model, "h3");
});

test("check: the fixture town passes every rule, banks for its risers (no wall the rule does not ask for)", () => {
  const r = checkDesign(design(), site);
  assert.deepEqual(r.faults, []);
  assert.ok(r.landmark?.visible);
  // the low shelf's seaward edge drops 2.35 m to the hill: a 1 : 2 bank fits (no lot or street within 3 m of its top)
  const sea = r.edges.find((e) => e.terrace === "low" && e.edge === 2)!;
  assert.equal(sea.kind, "drop");
  assert.equal(sea.treatment, "bank");
  assert.ok(r.edges.every((e) => e.treatment === "bank"));
  assert.ok(r.facts.some((f) => /connection ramp: ramp low -> high, 2.4 m in 28 m \(\d+ %\)/.test(f)), r.facts.join("\n"));
});

test("check: door, cut/fill, grade, reach, overlap, riser, square and rows faults", () => {
  const faults = (over: (d: Record<string, any>) => void) => checkDesign(design(over), site).faults;
  // a door 8 m back from its street
  assert.ok(faults((d) => (d.buildings[0].at = [-18, 17.5])).some((f) => f.startsWith("door: h1")));
  // the high shelf dropped to 12 m: fills over 6 m above the hill
  assert.ok(faults((d) => (d.terraces[1].level = 12)).some((f) => f.startsWith("cutfill: high")));
  // a straight ramp: 2.4 m in 18 m is 13 %
  assert.ok(faults((d) => (d.connections[0].points = [[28, 20], [28, 2]])).some((f) => /^reach: ramp: a ramp at 13 %/.test(f)));
  // no ramp at all: the high shelf cannot be reached
  assert.ok(faults((d) => (d.connections = [])).some((f) => /high is not reachable/.test(f)));
  // two lots on one spot
  assert.ok(faults((d) => (d.buildings[1].at = [-10, 21.94])).some((f) => /h1 and h2: ground envelopes/.test(f)));
  // a bank asked for where the street runs within 3 m of the top edge: the riser rule says wall (b)
  assert.ok(
    faults((d) => {
      d.streets[0].points = [[-28, 35], [28, 35]];
      d.terraces[0].edges = [{ edge: 2, treatment: "bank" }];
    }).some((f) => /riser: low edge 2: asked for a bank, the riser rule says wall .*\(b\) street low-street/.test(f)),
  );
  // the square moved away from the gate
  assert.ok(faults((d) => (d.squares[0].polygon = [[-29, 15], [-24, 15], [-24, 18], [-29, 18]])).some((f) => f.startsWith("square: no square within 30 m")));
  // six lots all facing one way: rows
  assert.ok(
    faults((d) => {
      d.terraces[0].polygon = [[-60, 14], [60, 14], [60, 36], [-60, 36]];
      d.streets[0].points = [[-58, 32], [58, 32]];
      for (const [i, x] of [-50, -32, 32, 50].entries()) {
        d.buildings.push({ id: `r${i}`, name: `R${i}`, at: [x, 21.94], facing: [0, 1], street: "low-street", model: "h3" });
        d.terraces[0].buildings.push(`r${i}`);
      }
    }).some((f) => f.startsWith("rows:")),
  );
});

/** The fixture hillside as a world: no noise, a planar height patch (terrace-walls.test's fixture). */
function fixtureWorld(): WorldRecipe {
  const recipe = worldRecipeSchema.parse({
    ...defaultWorldRecipe(),
    version: 1,
    name: "town-design-test",
    seed: 3,
    terrain: {
      base: 20,
      warp: { strength: 0, frequency: 0.001 },
      continent: { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: 1 },
      hills: { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: 2 },
      mountains: { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: 3 },
      detail: { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false, seed: 4 },
    },
  });
  recipe.terrain.overhang.strength = 0;
  recipe.terrain.caves.enabled = false;
  const n = 101, size = 200;
  const heights: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights.push(hill(0, -100 + (j * size) / (n - 1)));
  recipe.features.heightPatches.push({ id: "slope", origin: [-100, -100], size: [size, size], columns: n, rows: n, heights, blend: 8, filter: 0 });
  return recipe;
}

test("from-plan cut on a fixture world: level platforms, a 1 : 2 bank, a ramp at its grade", () => {
  const recipe = fixtureWorld();
  const bare = createWorldField(recipe);
  // the patch + streets of the cut (walls need the kit; the fitter has terrace-walls.test): an all-bank design
  const d = design();
  const plan = planEarthworks(d, { height: (x, z) => bare.heightfield(x, z), sea: recipe.seaLevel });
  assert.deepEqual(plan.report.faults, []);
  assert.equal(plan.patch.id, "town-plan-t");
  recipe.features.heightPatches.push(plan.patch);
  recipe.features.roads.push(...plan.roads);
  const field = createWorldField(recipe);
  for (const m of measurePlatforms(field, d)) assert.ok(m.share >= 0.95, `${m.id}: ${m.share}`);
  // the low shelf's seaward bank (x = 0, z 38 -> 43): about 1 : 2, never a step
  for (let z = 38.5; z < 43; z += 0.5) assert.ok(Math.abs(field.height(0, z + 0.5) - field.height(0, z)) / 0.5 <= 0.7, `bank at z ${z}`);
  // the ramp corridor climbs at about its grade (9 %), not in a step
  const ramp = plan.roads.find((r) => r.id === "t-ramp-ramp")!;
  for (let i = 1; i < ramp.points.length; i++) {
    const a = ramp.points[i - 1]!, b = ramp.points[i]!;
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    assert.ok(Math.abs(field.height(b[0], b[1]) - field.height(a[0], a[1])) / run <= 0.2, `ramp segment ${i}`);
  }
  // the town's records: flatten-0 shelves tagged plan, street roads at their levels
  assert.ok(plan.terraces.every((t) => t.flatten === 0 && t.tags.includes("plan")));
  assert.deepEqual([...new Set(plan.roads.find((r) => r.id === "t-street-low-street")!.surfaceY)], [16.2]);
});
