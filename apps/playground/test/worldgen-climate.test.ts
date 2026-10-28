import { test } from "node:test";
import assert from "node:assert/strict";
import { continentalWorldRecipe } from "@hitreg/core";
import { BIOME_SHARE_MAX, CLIMATE_CELL_MIN_M, climateCellSize, legalPair } from "../tools/worldgen-climate.mts";

const t = continentalWorldRecipe().climate.transitions;
const anchor = (id: string, temperature: number, moisture: number, waterTable?: number) => ({ id, temperature, moisture, weight: 1, relief: 0.15, hills: 1, dunes: 0, mesas: 0, flatten: 0, ...(waterTable !== undefined ? { waterTable } : {}) }) as any;

test("keeps desert away from a wetland and tundra away from jungle, lets grassland sit between", () => {
  const desert = anchor("desert", 0.92, 0.08);
  const swamp = anchor("swamp", 0.62, 0.95, 2);
  const grassland = anchor("grassland", 0.58, 0.42);
  const tundra = anchor("tundra", 0.08, 0.45);
  const jungle = anchor("jungle", 0.88, 0.9);
  assert.equal(legalPair(desert, swamp, t).legal, false);
  assert.equal(legalPair(tundra, jungle, t).legal, false);
  assert.equal(legalPair(desert, grassland, t).legal, true);
  assert.equal(legalPair(grassland, swamp, t).legal, true);
  assert.equal(legalPair(desert, swamp, { ...t, allow: [["swamp", "desert"]] }).legal, true);
  assert.equal(legalPair(desert, grassland, { ...t, forbid: [["desert", "grassland"]] }).legal, false);
});
test("sizes the climate lattice from the land area so a landmass carries several cells", () => {
  assert.equal(climateCellSize(5), 1200);
  assert.equal(climateCellSize(0.5), CLIMATE_CELL_MIN_M);
  assert.ok(climateCellSize(50) > climateCellSize(5));
  assert.ok(BIOME_SHARE_MAX < 1);
});
