import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { townDesignSchema, type TownDesign } from "../tools/town-design-schema.mts";
import { checkDesign, footprintOf, polyEdges, stackedBands, terraceBands } from "../tools/town-design-check.mts";
import { climbingTown, draftBands, hill, hillSite as site, rowTown, rowTownDoc } from "./fixtures/town-designs.mts";
import { clipForeignRoads, measurePlatforms, planEarthworks } from "../tools/worldgen-terrace-from-plan.mts";

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

test("rows: neighbours of one row need the exact pitch, one front line and a pair the kit's row-fit proof measured", async () => {
  const { rowPairFault } = await import("../tools/town-design-check.mts");
  const req = { system: "stone", size: [3, 4], storeys: 2, roof: "gable", party: ["-x", "+x"] };
  const house = (id: string, x: number, prefab = "kit/house-a", over: Record<string, unknown> = {}) =>
    ({ id, name: id, district: "d", at: [x, 0], facing: [0, 1], street: "s", row: "r", prefab, request: req, ...over }) as any;
  const fp = (b: any) => ({ centre: b.at, facing: b.facing, size: [3, 4] }) as any;
  const proof = (p: string) => (p.startsWith("kit/") ? new Set(["house-a | house-b", "house-a | house-a"]) : null);
  const judge = (a: any, b: any) => rowPairFault({ buildings: [a, b] }, a, b, fp(a), fp(b), proof);
  // 3 cells x 3.2 m: the pitch is 9.6 m
  assert.equal(judge(house("a", 0), house("b", 9.6, "kit/house-b")), null);
  assert.match(judge(house("a", 0), house("b", 9.7, "kit/house-b"))!, /row pitch is 9\.60/);
  assert.match(judge(house("b", 0, "kit/house-b"), house("a", 9.6))!, /not in the kit's row-fit proof/);
  assert.match(judge(house("a", 0, "other/house-a"), house("b", 9.6, "other/house-b"))!, /has no row-fit proof/);
  assert.match(judge(house("a", 0), house("b", 9.6, "kit/house-b", { request: { ...req, party: [] } }))!, /party-wall/);
  assert.match(judge(house("a", 0), house("b", 9.6, "kit/house-b", { at: [9.6, 0.3] }))!, /out of line/);
  assert.equal(judge(house("a", 0), house("b", 30, "kit/house-b")), "apart");
});

test("from-plan: a design's own stone (design.paving) lays its intramural paving streets too, not the zone's paving", () => {
  // e-paving 2026-11-02: as role "paving" the streets took the zone's red flag and painted it over the pale terraces
  const bare = createWorldField(fixtureWorld());
  const site2 = { height: (x: number, z: number) => bare.heightfield(x, z), sea: 0 };
  const plain = planEarthworks(design((d) => { for (const s of d.streets) s.surface = "paving"; }), site2);
  const own = planEarthworks(design((d) => {
    for (const s of d.streets) s.surface = "paving";
    d.paving = { surface: "pale-flag", map: "built/pale.png", color: "#ffffff", uvScale: 3.2 };
  }), site2);
  const streets = (p: typeof own) => p.roads.filter((r) => r.id.startsWith("t-street-"));
  assert.ok(streets(plain).length > 0);
  assert.ok(streets(plain).every((r) => r.role === "paving" && r.surface === "gravel"));
  assert.ok(streets(own).every((r) => r.role === "none" && r.surface === "pale-flag"), JSON.stringify(streets(own).map((r) => [r.id, r.role, r.surface])));
});

test("clipForeignRoads: a world path routed to the town centre ends at the intramural paving's edge (i-town 2026-11-02)", () => {
  const design = { town: "t", terraces: [{ id: "in", polygon: [[0, 0], [40, 0], [40, 40], [0, 40]] }, { id: "yard", extramural: true, polygon: [[40, 0], [80, 0], [80, 40], [40, 40]] }] } as unknown as TownDesign;
  const road = { id: "path-t-site", points: [[20, 20], [100, 20], [140, 20]], surfaceY: [10, 18, 22], leftY: [10, 18, 22], width: 4, surfaceEdge: 1 };
  const own = { id: "t-street-main", points: [[5, 5], [35, 5]], surfaceY: [10, 10], width: 4, surfaceEdge: 1 };
  const recipe = { features: { roads: [road, own] } } as unknown as WorldRecipe;
  const log = clipForeignRoads(recipe, design);
  assert.equal(log.length, 1);
  assert.equal(road.points.length, 3);
  const end = road.points[0]!;
  assert.ok(end[0] >= 40 + 3 - 0.01 && end[0] <= 40 + 3 + 0.05, `end pulled back off the paving by half the tread + verge: ${end}`);
  assert.ok(Math.abs(road.surfaceY[0]! - (10 + (end[0] - 20) / 80 * 8)) < 0.02 && road.leftY.length === 3, "profiles interpolated with the cut");
  assert.deepEqual(own.points, [[5, 5], [35, 5]], "the town's own streets are left alone");
});

test("rows packed by plan type: a corner ends the row on its +x, proven pairs only, the pitch from the proof's lots (k-town9)", async () => {
  const { rowPairFault } = await import("../tools/town-design-check.mts");
  const { packRow } = await import("../tools/town-row-pack.mts");
  const types = {
    row: { id: "row", lot: 6.4, party: ["-x", "+x"], depth: 9.6, storeys: 1 },
    wide: { id: "wide", lot: 9.6, party: ["-x", "+x"], depth: 6.4, storeys: 1 },
    corner: { id: "corner", lot: 10.4, party: ["-x"], depth: 9.6, storeys: 1 },
  };
  const all = ["row", "wide", "corner"];
  const pairs = new Set(all.flatMap((a) => all.map((b) => `${a} | ${b}`)).filter((p) => p !== "wide | wide" && !p.startsWith("corner")));
  const seq = packRow(33.0, types, { pool: ["row", "wide", "corner"], pairs });
  assert.ok(Math.abs(seq.reduce((s, id) => s + types[id as keyof typeof types].lot, 0) - 32.8) < 1e-6, seq.join(","));
  assert.equal(seq[seq.length - 1], "corner");
  for (let i = 1; i < seq.length; i++) assert.ok(pairs.has(`${seq[i - 1]} | ${seq[i]}`), seq.join(","));
  // a shallow row (backed on the curtain) takes only the shallow type; never wide beside wide
  const shallow = packRow(30, types, { pool: all, pairs, maxDepth: 7, corner: false });
  assert.deepEqual(shallow, ["wide"]);
  // the town check: the pitch is half the two proven lots; a corner meets its neighbour on its -x only
  const req = (party: string[], size: number[]) => ({ system: "common", size, storeys: 1, roof: "steep", party });
  const h = (id: string, x: number, prefab: string, party: string[], size: number[]) => ({ id, name: id, district: "d", at: [x, 0], facing: [0, 1], street: "s", row: "r", prefab, request: req(party, size) }) as any;
  const fp = (b: any) => ({ centre: b.at, facing: b.facing, size: b.request.size }) as any;
  const proof = (() => { const s = new Set(["row | corner"]) as Set<string> & { lots?: Record<string, number> }; s.lots = { row: 6.4, corner: 10.4 }; return s; });
  const judge = (a: any, b: any) => rowPairFault({ buildings: [a, b] }, a, b, fp(a), fp(b), proof);
  const row = h("a", 0, "kit/row", ["-x", "+x"], [2, 3]);
  assert.equal(judge(row, h("b", 8.4, "kit/corner", ["-x"], [3, 3])), null); // (6.4 + 10.4) / 2: facing +z, the corner on the row house's +x
  assert.match(judge(row, h("b", 8.0, "kit/corner", ["-x"], [3, 3]))!, /row pitch is 8\.40/);
});
