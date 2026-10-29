import { test } from "node:test";
import assert from "node:assert/strict";
import { continentalWorldRecipe, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { applyFlora, floraClimate, floraFindings, floraKindOf } from "../tools/worldgen-flora.mts";

// 2026-10-29 redstrand w5-ground: `init --from proving` carried proving's species rules into a dry red-sandstone world —
// palms on every beach and in the savanna, pine in the oasis ribbon. Species follow the climate.
const tree = (id: string, model: string, biomes: string[], biomeDensity: Record<string, number> = {}, density = 0.02) =>
  ({ id, model, biomes, biomeDensity, density });

function world(dry: boolean): WorldRecipe {
  const raw = continentalWorldRecipe();
  const zones = raw.climate.zones!;
  if (dry) {
    zones.anchors = zones.anchors.filter((a) => ["savanna", "forest", "foothills", "badlands"].includes(a.id));
    zones.aridity = 0.5;
    zones.riparian = { anchor: "forest", reach: 140, rise: 14, strength: 1 };
  }
  return worldRecipeSchema.parse({
    ...raw,
    scatter: [
      tree("palm", "mmo/nature/PalmTree.gltf", ["beach", "savanna", "jungle"], { savanna: 0.1, beach: 0.5 }),
      tree("pine", "mmo/nature/PineTree.gltf", ["forest", "foothills", "highland"]),
      tree("maple", "mmo/nature/MapleTree.gltf", ["forest", "foothills"]),
      tree("dead-dried-tree", "mmo/nature/DeadDriedTree.gltf", ["badlands"], {}, 0.004),
      tree("dry-brush", "purchased/nature/DeadBushWorldUp.glb", ["savanna", "badlands"]),
      tree("stump", "mmo/nature/Stump.gltf", ["forest"]),
    ],
  });
}

test("rule kinds come from the id and model", () => {
  const w = world(false);
  assert.deepEqual(w.scatter.map((r) => floraKindOf(r)), ["palm", "pine", "broadleaf", "scrub-tree", null, null]);
});

test("a world with a jungle anchor is tropical: palms are fine", () => {
  const w = world(false);
  assert.equal(floraClimate(w), "tropical");
  assert.deepEqual(floraFindings(w), []);
});

test("a dry world bans palms, oasis pines; applyFlora hands their density on and the row goes clean", () => {
  const w = world(true);
  assert.equal(floraClimate(w), "dry");
  const found = floraFindings(w).map((f) => `${f.rule}@${f.biome}`).sort();
  // jungle: the biome is gated to an anchor this world dropped, so the field grows it anywhere — still a palm biome
  assert.deepEqual(found, ["palm@beach", "palm@jungle", "palm@savanna", "pine@forest"]);
  const notes = applyFlora(w);
  assert.ok(notes.length >= 3, notes.join("\n"));
  assert.deepEqual(floraFindings(w), []);
  // palms are gone: no biome of a dry climate grows them, so the rule is dropped
  assert.equal(w.scatter.some((r) => r.id === "palm"), false);
  // pine stays on the upland (foothills, highland), out of the oasis ribbon
  assert.deepEqual(w.scatter.find((r) => r.id === "pine")!.biomes, ["foothills", "highland"]);
  // the savanna keeps sparse trees: the scrub tree at the palm's density (0.02 x 0.1 / 0.004 = 0.5)
  const scrub = w.scatter.find((r) => r.id === "dead-dried-tree")!;
  assert.ok(scrub.biomes.includes("savanna"));
  assert.equal(scrub.biomeDensity!.savanna, 0.5);
  // nothing else moved
  assert.deepEqual(w.scatter.find((r) => r.id === "dry-brush")!.biomes, ["savanna", "badlands"]);
  // idempotent
  assert.deepEqual(applyFlora(w), []);
});

test("a rule left with no live biome is dropped, never left growing anywhere", () => {
  const w = world(true);
  w.scatter = w.scatter.map((r) => (r.id === "palm" ? { ...r, biomes: ["beach", "savanna"] } : r));
  applyFlora(w);
  assert.equal(w.scatter.some((r) => r.id === "palm"), false);
});
