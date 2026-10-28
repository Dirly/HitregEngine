import { test } from "node:test";
import assert from "node:assert/strict";
import { continentalWorldRecipe, createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import {
  autoRelief,
  measureLandWidth,
  altitudeLadder,
  biomesGatedToMissingAnchors,
  interiorLakes,
  REFERENCE_KM,
  RELIEF_MIN_M,
  reliefFindings,
  rescaleRelief,
  treeRules,
  treeSampler,
  UPLAND_RISE_M,
  UPLAND_SHARE_MIN,
  WOODLAND_DENSITY,
  woodlandShare,
} from "../tools/worldgen-relief.mts";

test("the altitude ladder reads quantiles and bands, and a plate with one spike fails the relief rule", () => {
  // 1000 samples on a 55 m plate, one 180 m cliff spike
  const plate = Array.from({ length: 1000 }, (_, i) => 50 + (i % 10));
  plate[0] = 180;
  const l = altitudeLadder(plate);
  assert.equal(l.count, 1000);
  assert.equal(l.max, 180);
  assert.ok(l.relief < RELIEF_MIN_M, `relief ${l.relief}`);
  assert.ok(l.uplandShare < UPLAND_SHARE_MIN);
  assert.ok(Math.abs(l.bands.reduce((s, [, share]) => s + share, 0) - 1) < 1e-9, "bands sum to 1");
  const findings = reliefFindings(l, "plate");
  assert.equal(findings.length, 2, findings.join("\n"));
  assert.match(findings[0]!, /a plate/);
  assert.match(findings[1]!, /no upland/);
});

test("a zone with a real upland passes the relief rule", () => {
  // 70 % lowland at 10-30 m, 30 % upland at 100-160 m
  const land = [...Array.from({ length: 700 }, (_, i) => 10 + (i % 20)), ...Array.from({ length: 300 }, (_, i) => 100 + (i % 60))];
  const l = altitudeLadder(land);
  assert.ok(l.relief >= RELIEF_MIN_M, `relief ${l.relief}`);
  assert.ok(l.uplandShare >= UPLAND_SHARE_MIN, `upland ${l.uplandShare}`);
  assert.ok(l.p10 + UPLAND_RISE_M < 100);
  assert.deepEqual(reliefFindings(l, "hills"), []);
});

test("rescaleRelief sets the landmass-scale bands from swells per landmass width and leaves the hills alone", () => {
  const recipe = worldRecipeSchema.parse(continentalWorldRecipe());
  const hills = recipe.terrain.hills.frequency;
  const { changed } = rescaleRelief(recipe, 2.3, 2);
  assert.ok(Math.abs(recipe.terrain.mountainMask.spec.frequency - 2 / 2300) < 1e-6, "two mask swells across 2.3 km");
  assert.ok(Math.abs(recipe.terrain.mountains.frequency - 3 / 2300) < 1e-6);
  assert.ok(REFERENCE_KM > 2.3);
  // idempotent: a second run at the same scale lands on the same numbers (from the preset, not compounding)
  const once = recipe.terrain.mountains.frequency;
  rescaleRelief(recipe, 2.3, 2);
  assert.equal(recipe.terrain.mountains.frequency, once);
  assert.equal(recipe.terrain.hills.frequency, hills);
  assert.ok(changed.length >= 3, changed.join(", "));
});

test("biome rules gated only to anchors the world lacks are found (the field un-gates them)", () => {
  const recipe = worldRecipeSchema.parse(continentalWorldRecipe());
  assert.deepEqual(biomesGatedToMissingAnchors(recipe), []);
  recipe.climate.zones!.anchors = recipe.climate.zones!.anchors.filter((a) => ["grassland", "forest", "moor"].includes(a.id));
  const loose = biomesGatedToMissingAnchors(recipe);
  assert.ok(loose.includes("tundra") && loose.includes("swamp") && loose.includes("fen"), loose.join(", "));
  assert.ok(!loose.includes("forest") && !loose.includes("grassland"));
  assert.ok(!loose.includes("highland"), "an ungated rule is not loose");
});

test("tree rules are the tall plants; the sampler finds woodland in a forest zone and none in the sea", () => {
  // the preset ships no scatter (a look world's rules come in with `init --from`): three rules in the firstshore shapes
  const wind = { mode: "ripple", strength: 0.05, speed: 1.5, canopy: 0.4, materials: "leaves,bush" };
  const recipe: WorldRecipe = worldRecipeSchema.parse({
    ...continentalWorldRecipe(),
    scatter: [
      { id: "pine", model: "mmo/nature/PineTree.gltf", wind, biomes: ["forest", "taiga"], biomeDensity: { forest: 0.85, taiga: 0.8 }, density: 0.024, slopeMax: 0.45, height: [3, 330], collider: "cylinder", colliderSize: [0.8, 6.8, 0.8] },
      { id: "maple", model: "mmo/nature/MapleTree.gltf", wind, biomes: ["forest", "grassland"], biomeDensity: { forest: 1, grassland: 0.09 }, density: 0.016, slopeMax: 0.42, height: [3, 200], collider: "cylinder", colliderSize: [0.9, 6.6, 0.9] },
      { id: "shrub", model: "purchased/nature/fern.gltf", wind: { ...wind, mode: "sway" }, biomes: ["forest", "grassland"], density: 0.01, slopeMax: 0.5, height: [0.6, 260], collider: "none", colliderSize: [1, 2, 1] },
      { id: "rock-medium", model: "rock-kit/boulder-m-1.glb", biomes: ["forest", "highland"], density: 0.0005, slopeMax: 0.8, collider: "box", colliderSize: [1.2, 1.2, 1.2] },
    ],
  });
  const trees = treeRules(recipe).map((t) => t.rule.id);
  assert.ok(trees.includes("pine") && trees.includes("maple"), trees.join(", "));
  assert.ok(!trees.includes("shrub") && !trees.includes("rock-medium"), trees.join(", "));
  // one landmass, one forest anchor: every column is forest
  recipe.bounds = { continents: [{ center: [0, 0], radius: 900, falloff: 300, warp: 0, warpScale: 1000, coastVariation: 0, coastVariationScale: 1000, lobes: [], lobeBlend: 100 }], oceanFloor: -45, landFloor: 4, shelf: 0.58, limit: 2000, limitFalloff: 300 };
  recipe.climate.zones!.anchors = recipe.climate.zones!.anchors.filter((a) => a.id === "forest");
  recipe.biomes = recipe.biomes.filter((b) => !b.zones || b.zones.includes("forest"));
  recipe.terrain.mountains.amplitude = 0;
  const field = createWorldField(recipe);
  const sampler = treeSampler(recipe, field);
  assert.equal(sampler.density(0, 1900), 0, "no trees in the sea");
  const inland = sampler.density(0, 0);
  assert.ok(inland >= WOODLAND_DENSITY, `forest density ${inland}`);
  const wood = woodlandShare(recipe, field, [[-600, -600], [600, -600], [600, 600], [-600, 600]], sampler, 400);
  assert.ok(wood.share > 0.5, `woodland share ${wood.share}`);
  assert.deepEqual(interiorLakes(recipe, field, [[-600, -600], [600, -600], [600, 600], [-600, 600]]), []);
});

test("autoRelief measures the largest landmass and derives the bands, the mask and the amplitude; a second run is a no-op", () => {
  const recipe = worldRecipeSchema.parse({ ...continentalWorldRecipe(), seed: 4242 });
  const measured = measureLandWidth(recipe, createWorldField(recipe));
  assert.ok(measured.widthKm > 0.5, `width ${measured.widthKm} km`);
  assert.ok(measured.landKm2 > 0, `land ${measured.landKm2} km²`);
  const lines: string[] = [];
  const res = autoRelief(recipe, { log: (l) => lines.push(l) });
  assert.equal(res.scaleKm, measured.widthKm);
  assert.ok(res.after.relief >= RELIEF_MIN_M, `relief ${res.after.relief} m after; ${lines.join(" | ")}`);
  assert.equal(recipe.terrain.mountainMask.spec.seed, (4242 * 7919 + 53) % 100000, "the mask seed follows the world seed");
  assert.ok(recipe.climate.zones ? recipe.climate.zones.anchors.every((a) => a.relief >= 0.3) : true, "every anchor keeps relief");
  const snapshot = JSON.stringify(recipe.terrain);
  const again = autoRelief(recipe);
  assert.equal(JSON.stringify(recipe.terrain), snapshot, "idempotent");
  assert.ok(Math.abs(again.after.p98 - res.after.p98) < 1e-6);
});
