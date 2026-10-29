import { test } from "node:test";
import assert from "node:assert/strict";
import { continentalWorldRecipe, createWorldField, worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { assignClimateSites, SPREAD_ANCHORS } from "../tools/worldgen-climate.mts";
import { autoRelief } from "../tools/worldgen-relief.mts";

/**
 * The climate assignment for a DRY world (2026-10-29 redstrand: red scrub behind sea cliffs, a river oasis, pine
 * highlands). Before: every cell of a 3-4 km island read wet (all near the sea), so badlands/savanna never won a cell;
 * the cells' altitude averaged into 0.24..0.58, so the upland anchor landed on the lowest cell; and an "unused" bonus in
 * the greedy pass handed anchors to whichever cell came first.
 */
function dryIsland(o: { aridity?: number; warmth?: number; riparian?: boolean }): WorldRecipe {
  const raw = continentalWorldRecipe();
  const keep = new Set(["badlands", "savanna", "foothills", "forest"]);
  const anchors = raw.climate.zones!.anchors.filter((a) => keep.has(a.id));
  assert.equal(anchors.length, 4, "the continental preset carries the four anchors");
  const recipe = worldRecipeSchema.parse({
    ...raw,
    seed: 2029,
    climate: {
      ...raw.climate,
      zones: {
        ...raw.climate.zones!,
        anchors,
        size: 1500,
        aridity: o.aridity ?? 0,
        warmth: o.warmth ?? 0,
        ...(o.riparian ? { riparian: { anchor: "forest" } } : {}),
      },
    },
  });
  autoRelief(recipe);
  return recipe;
}

function shares(recipe: WorldRecipe): { sites: ReturnType<typeof assignClimateSites>; by: Map<string, number> } {
  const sites = assignClimateSites(recipe, createWorldField(recipe));
  const by = new Map<string, number>();
  for (const s of sites) by.set(s.anchor, (by.get(s.anchor) ?? 0) + 1);
  return { sites, by };
}

test("a dry, warm climate puts dry anchors on the land; the riparian anchor never takes a cell", () => {
  const wet = shares(dryIsland({}));
  const dry = shares(dryIsland({ aridity: 0.5, warmth: 0.1, riparian: true }));
  assert.ok(dry.sites.length >= 3, `${dry.sites.length} cells with land`);
  const dryCells = (dry.by.get("badlands") ?? 0) + (dry.by.get("savanna") ?? 0);
  const wetDryCells = (wet.by.get("badlands") ?? 0) + (wet.by.get("savanna") ?? 0);
  assert.ok(dryCells > wetDryCells, `dry anchors on ${dryCells} cells (aridity 0: ${wetDryCells})`);
  assert.equal(dry.by.get("forest") ?? 0, 0, "the oasis anchor is a ribbon, never a cell");
});

test("the spread pass carries min(SPREAD_ANCHORS, anchors) kinds, and the stretched altitude spans 0..1", () => {
  const { sites, by } = shares(dryIsland({ aridity: 0.5, warmth: 0.1, riparian: true }));
  const pickable = 3; // forest is riparian
  assert.equal(by.size, Math.min(SPREAD_ANCHORS, pickable, sites.length), `anchors ${[...by.keys()].join(", ")}`);
  const alts = sites.map((s) => s.alt01);
  assert.equal(Math.min(...alts), 0);
  assert.equal(Math.max(...alts), 1);
});
