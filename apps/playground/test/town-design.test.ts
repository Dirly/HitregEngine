import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { townDesignSchema, type TownDesign } from "../tools/town-design-schema.mts";
import { checkDesign, footprintOf, polyEdges, stackedBands, terraceBands } from "../tools/town-design-check.mts";
import { climbingTown, draftBands, hill, hillSite as site, rowTown, rowTownDoc } from "./fixtures/town-designs.mts";
import { measurePlatforms, planEarthworks } from "../tools/worldgen-terrace-from-plan.mts";

/** The design round's two-shelf fixture (test/fixtures/town-designs.mts rowTown) with a lane that follows the ramp
 *  between the shelves (so each shelf carries a linked cross street and the town is no longer rows on shelves). */
function design(over: (d: Record<string, any>) => void = () => {}): TownDesign {
  const d = rowTownDoc();
  d.streets.push({ id: "ramp-lane", name: "Ramp Lane", kind: "lane", points: [[29.6, 32], [29.6, 21], [36, 14], [36, 4], [28, 2], [28.5, -10]], width: 3 });
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

test("bands: the design round's row towns fail as rows on stacked shelves; a dead stub does not save them", () => {
  // the round's own two-shelf fixture passed `rows` (two bearings over four buildings) and must fail `bands` alone
  const row = checkDesign(rowTown(), site);
  assert.deepEqual(row.faults.map((f) => f.split(":")[0]), ["bands"]);
  assert.match(row.faults[0]!, /low, high.*climbs ACROSS the levels/);
  // the propose-style draft: three stacked shelves, one street each
  assert.ok(checkDesign(draftBands(), site).faults.some((f) => /^bands: 3 terraces \(t1, t2, t3\)/.test(f)));
  assert.deepEqual(stackedBands(terraceBands(draftBands()))[0], ["t1", "t2", "t3"]);
  // a 12 m cross stub on each shelf that reaches nothing and fronts no door is not a second street
  const stub = rowTownDoc();
  stub.streets.push({ id: "stub-low", name: "Stub", kind: "close", points: [[-12, 30], [-12, 18]], width: 4 }, { id: "stub-high", name: "Stub", kind: "close", points: [[2, -12], [2, 0]], width: 4 });
  const sb = terraceBands(townDesignSchema.parse(stub));
  assert.ok(sb.every((b) => b.single), JSON.stringify(sb.map((b) => b.streets)));
});

test("bands: a town that climbs (gate square, street across the slope through a ramp, a stair lane) passes every rule", () => {
  const r = checkDesign(climbingTown(), site);
  assert.deepEqual(r.faults, []);
  assert.deepEqual(r.warnings, []);
  const bands = terraceBands(climbingTown());
  assert.ok(bands.every((b) => !b.single));
  // the climb crosses the low level well off its long axis, and the stair lane crosses the high one
  assert.ok(bands.find((b) => b.id === "low")!.streets.some((s) => s.id === "climb" && s.offAxis > 35));
  assert.ok(bands.find((b) => b.id === "high")!.streets.some((s) => s.id === "stair-lane" && s.offAxis > 60 && s.linked));
});
