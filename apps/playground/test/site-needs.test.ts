import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema, type GroundNeedDoc, type WorldRecipe } from "@hitreg/core";
import { measureNeeds, needGroundOf, needsFor, needStillMet, solveCliffFace, solveWalledNeck, needArea, unexcepted, type NeedGround } from "../tools/site-needs.mts";
import { pickFileSchema, roleOfTown } from "../tools/worldgen-site-needs.mts";
import { placePickSchema } from "../tools/zonegen/commands/reserve.mts";

/** A ground from a height function; water below sea 0. */
const ground = (h: (x: number, z: number) => number): NeedGround => ({ height: h, wet: (x, z) => h(x, z) < 0.3, sea: 0 });
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// a flat plain at 10 m with a scarp rising to the north (-Z) from z = -40: `face` m over a 1:1.5 run, a plateau behind
const scarp = (face: number) => ground((_x, z) => 10 + clamp((-40 - z) * 1.5, 0, face));

test("rock-face: the Wristgate fault — a 52 m front on a 40 m face fails, on a 60 m face it passes", () => {
  const over = { "rock-face": { frontHeight: 52 } };
  const gorge = measureNeeds(scarp(40), "grand-entrance", 0, 0, 40, over);
  assert.equal(gorge.met, false);
  const face = gorge.results[0]!;
  assert.match(face.faults.join(" "), /face 40 m, needs 57\.2 m/);
  assert.equal(face.numbers.faces, 180, "the front faces south, away from the rock");
  const cliff = measureNeeds(scarp(60), "grand-entrance", 0, 0, 40, over);
  assert.equal(cliff.met, true, cliff.results[0]!.message);
  assert.ok(Number(cliff.results[0]!.numbers.apronM2) >= 1600);
  assert.ok(Number(cliff.results[0]!.numbers.seenFrom) >= 300);
});

test("rock-face: no apron (the foot is a slope) and a dated ruling excepts a need", () => {
  const slope = ground((_x, z) => (z <= -40 ? 10 + clamp((-40 - z) * 1.5, 0, 60) : 10 - (z + 40) * 0.3));
  const r = measureNeeds(slope, "grand-entrance", 0, 0, 40);
  assert.equal(r.met, false);
  assert.ok(r.results[0]!.faults.some((f) => f.startsWith("apron")));
  assert.equal(unexcepted(r, [{ need: "rock-face", ruling: "2026-10-29 coordinator: a terraced stair stands in for the apron" }]).length, 0);
});

test("defensible: the Saltharrow fault — a town in a cove under a hill is overlooked and open", () => {
  // the pad at 8 m; a hill rising inland (+Z) at 0.5 to 80 m; the sea south of z = -70
  const cove = ground((_x, z) => (z < -70 ? -5 : 8 + clamp((z - 50) * 0.5, 0, 72)));
  const r = measureNeeds(cove, "walled-town", 0, 0, 45);
  const d = r.results.find((x) => x.need === "defensible")!;
  assert.equal(d.met, false);
  assert.ok(d.faults.some((f) => /sees .* over a 6 m wall/.test(f)), d.message);
});

test("defensible: a promontory with cliff flanks and one 60 m neck passes", () => {
  // a 40 m-high disc of radius 75 over a 0 m plain (the sea at -5 beyond 75 m), and a 60 m wide causeway running east
  const prom = ground((x, z) => {
    const d = Math.hypot(x, z);
    if (d <= 75) return 40;
    if (x > 0 && Math.abs(z) <= 30) return clamp(40 - (x - 75) * 0.15, 2, 40);
    return 2;
  });
  const r = measureNeeds(prom, "walled-town", 0, 0, 45);
  const d = r.results.find((x) => x.need === "defensible")!;
  assert.equal(d.met, true, d.message);
  assert.ok(Number(d.numbers.neckM) > 40 && Number(d.numbers.neckM) < 120, String(d.numbers.neckM));
  // the same pad on the plain: the whole ring to wall
  const plain = measureNeeds(ground(() => 10), "walled-town", 0, 0, 45).results.find((x) => x.need === "defensible")!;
  assert.equal(plain.met, false);
  assert.match(plain.faults[0]!, /of open ring to wall/);
});

test("crossroads / high-ground / overrides", () => {
  const plain = ground(() => 10);
  assert.equal(measureNeeds(plain, "capital", 0, 0, 78).met, true);
  const hill = ground((x, z) => 10 + Math.max(0, 40 - Math.hypot(x, z) * 0.12));
  assert.equal(measureNeeds(hill, "hill-town", 0, 0, 45).results.find((r) => r.need === "high-ground")!.met, true);
  assert.equal(measureNeeds(plain, "hill-town", 0, 0, 45).met, false);
  assert.equal(needsFor("grand-entrance", { "rock-face": { frontHeight: 52 } })[0]!.kind, "rock-face");
});

test("pick file schema refuses a row with no why", () => {
  assert.equal(pickFileSchema.safeParse({ towns: [{ role: "walled-town", candidate: "walled-town-1", why: "" }] }).success, false);
  assert.equal(pickFileSchema.safeParse({ towns: [{ role: "walled-town", candidate: "walled-town-1", why: "the only spur with a neck" }] }).success, true);
});

/** A flat world at 20 m (no noise) shaped only by height patches. */
function flatWorld(): WorldRecipe {
  const flat = { frequency: 0.001, amplitude: 0, octaves: 1, lacunarity: 2, gain: 0.5, ridged: false };
  const recipe = worldRecipeSchema.parse({
    ...defaultWorldRecipe(),
    version: 1,
    name: "site-needs-test",
    seed: 3,
    terrain: { base: 20, warp: { strength: 0, frequency: 0.001 }, continent: { ...flat, seed: 1 }, hills: { ...flat, seed: 2 }, mountains: { ...flat, seed: 3 }, detail: { ...flat, seed: 4 } },
  });
  recipe.terrain.overhang.strength = 0;
  recipe.terrain.caves.enabled = false;
  return recipe;
}

test("worldgen needs: cliff-face on flat ground writes a scarp the rock-face need then measures", () => {
  const recipe = flatWorld();
  const g0 = needGroundOf(createWorldField(recipe), recipe.seaLevel);
  const need = { id: "wristgate-face", kind: "cliff-face", for: "wristgate", near: [0, 0], within: 120, minHeight: 50, width: 90, apron: 40, radius: 45, neck: 60, flankDrop: 12 } as GroundNeedDoc;
  const s = solveCliffFace(g0, need, needArea(need.near, need.within, []));
  assert.equal(s.ok, true, s.message);
  assert.ok(s.patch, "a patch is written");
  recipe.features.heightPatches.push(s.patch!);
  const g1 = needGroundOf(createWorldField(recipe), recipe.seaLevel);
  const after = needStillMet(g1, { ...need, solved: { at: s.at, faces: s.faces, height: s.height, patch: s.patch!.id, raised: s.raised, ran: "" } })!;
  assert.equal(after.met, true, after.message);
  assert.ok(Number(after.numbers.face) >= 47, String(after.numbers.face));
});

test("worldgen needs: walled-neck on flat ground raises a defensible promontory", () => {
  const recipe = flatWorld();
  const g0 = needGroundOf(createWorldField(recipe), recipe.seaLevel);
  const need = { id: "keep-spur", kind: "walled-neck", for: "walled-town", near: [0, 0], within: 60, minHeight: 55, width: 90, apron: 40, radius: 40, neck: 60, flankDrop: 12 } as GroundNeedDoc;
  const s = solveWalledNeck(g0, need, needArea(need.near, need.within, []));
  assert.equal(s.ok, true, s.message);
  recipe.features.heightPatches.push(s.patch!);
  const g1 = needGroundOf(createWorldField(recipe), recipe.seaLevel);
  const after = needStillMet(g1, { ...need, solved: { at: s.at, faces: s.faces, height: s.height, patch: s.patch!.id, raised: s.raised, ran: "" } })!;
  assert.equal(after.met, true, after.message);
});

test("town roles: siteRole wins, else coastal / gated / capital / town", () => {
  const t = (x: Record<string, unknown>) => ({ id: "t", center: [0, 0], radius: 45, gates: [], terraces: [], tags: [], ...x }) as never;
  assert.equal(roleOfTown(t({ siteRole: "hill-town", coastal: true })), "hill-town");
  assert.equal(roleOfTown(t({ coastal: true })), "harbour-town");
  assert.equal(roleOfTown(t({ gates: [{}] })), "walled-town");
  assert.equal(roleOfTown(t({ tier: "capital" })), "capital");
  assert.equal(roleOfTown(t({})), "town");
});

test("reserve --pick file: a ruling must carry its date", () => {
  const row = { location: "wristgate-door", candidate: "foot-2", why: "62 m face over a level shelf" };
  assert.equal(placePickSchema.safeParse({ places: [row] }).success, true);
  assert.equal(placePickSchema.safeParse({ places: [{ ...row, rulings: [{ need: "rock-face", ruling: "coordinator says so" }] }] }).success, false);
  assert.equal(placePickSchema.safeParse({ places: [{ ...row, rulings: [{ need: "rock-face", ruling: "2026-10-29 the stair stands in for the apron" }] }] }).success, true);
});
