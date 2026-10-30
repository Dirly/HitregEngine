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

// 2026-10-29 redstrand w9-world: Derek's woodland ruling. The woodland-botany species join through the climate rule:
// great-canopy stands (clumped, with edges) in the moister biomes, willows by water, ferns under the canopy; jungle
// species refused outside the tropics; an owner-excluded model is never picked; the places keep their footprints.
test("woodland: roles from the climate and the curation, stands with edges, keep-outs round the places", async () => {
  const { applyWoodland, woodlandFindings, WOODLAND_RULE, WOODLAND_CLUMP } = await import("../tools/worldgen-flora.mts");
  const w = world(true);
  const excluded = (id: string) => (id === "woodland-botany/weeping-willow" ? "test: excluded" : null);
  const places = [{ id: "keep", center: [10, 20] as [number, number], radius: 50 }];
  const notes = applyWoodland(w, { excluded, places });
  const canopy = w.scatter.find((r) => r.id === WOODLAND_RULE.canopy)!;
  assert.equal((canopy as { model?: string }).model, "woodland-botany/great-canopy.glb");
  // woods: the riparian ribbon's biome, never the dry anchors
  assert.ok(canopy.biomes.includes("forest"));
  assert.ok(!canopy.biomes.includes("savanna") && !canopy.biomes.includes("badlands"));
  // stands with edges: no density survives outside the clump; the understory shares the same mask
  assert.equal(canopy.clump!.floor, 0);
  const under = w.scatter.find((r) => r.id === WOODLAND_RULE.understory)!;
  assert.deepEqual(under.clump, canopy.clump);
  assert.deepEqual(canopy.clump, { ...WOODLAND_CLUMP, octaves: canopy.clump!.octaves });
  // jungle species refused in a dry climate, the excluded willow refused: no shore rule
  assert.ok(notes.some((n) => /vine-hung-jungle refused \(jungle in a dry climate/.test(n)), notes.join("\n"));
  assert.ok(notes.some((n) => /weeping-willow refused \(owner curation/.test(n)), notes.join("\n"));
  assert.equal(w.scatter.some((r) => r.id === WOODLAND_RULE.shore), false);
  // keep-outs clear only the woodland rules
  const keep = (w.features as unknown as { clearings: { id: string; rules: string[]; cover: boolean }[] }).clearings.find((c) => c.id === "woodland-keep-keep")!;
  assert.deepEqual(keep.rules.sort(), [WOODLAND_RULE.canopy, WOODLAND_RULE.understory].sort());
  assert.equal(keep.cover, false);
  assert.deepEqual(woodlandFindings(w, { excluded, places }), []);
  // an excluded model in any scatter rule is a finding; so is a place with no keep-out
  w.scatter.push({ ...canopy, id: "hand-reeds", model: "woodland-botany/cattail-reeds.glb" } as never);
  const f = woodlandFindings(w, { excluded: (id) => (id.endsWith("cattail-reeds") ? "owner: no" : null), places: [...places, { id: "new", center: [0, 0], radius: 10 }] });
  assert.deepEqual(f.map((x) => x.why.slice(0, 20)).sort(), ["no woodland keep-out", "places woodland-bota"]);
  // idempotent: one rule per role
  applyWoodland(w, { excluded, places });
  assert.equal(w.scatter.filter((r) => r.id === WOODLAND_RULE.canopy).length, 1);
});

test("woodland: a willow by water is allowed in a dry climate (broadleaf only by water)", async () => {
  const { applyWoodland, WOODLAND_RULE } = await import("../tools/worldgen-flora.mts");
  const w = world(true);
  applyWoodland(w);
  const shore = w.scatter.find((r) => r.id === WOODLAND_RULE.shore)!;
  assert.ok(shore.biomes.includes("savanna"));
  assert.deepEqual(floraFindings(w).filter((f) => f.rule === WOODLAND_RULE.shore), []);
});

test("cover: papyrus is tropical; a dry world's shore reeds take its biomes", async () => {
  const { applyCoverFlora, coverFloraFindings } = await import("../tools/worldgen-flora.mts");
  const w = world(true);
  const shoreWater = { mode: "shore", level: [-0.6, 0.8], reach: 5, depth: [0.25, 2.5], kinds: ["lake", "river"], maxFlow: 0.6 };
  w.cover = [
    { id: "shore-reeds", biomes: ["forest"], density: 1, water: shoreWater },
    { id: "shore-papyrus", biomes: ["savanna", "badlands"], density: 1, water: shoreWater },
  ] as never;
  assert.equal(coverFloraFindings(w).length, 2);
  applyCoverFlora(w);
  assert.deepEqual(coverFloraFindings(w), []);
  const reeds = (w.cover as unknown as { id: string; biomes: string[] }[]).find((l) => l.id === "shore-reeds")!;
  assert.deepEqual(reeds.biomes, ["forest", "savanna", "badlands"]);
  assert.equal((w.cover as unknown as { id: string }[]).some((l) => l.id === "shore-papyrus"), false);
});
