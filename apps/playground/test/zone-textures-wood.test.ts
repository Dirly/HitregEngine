import { test } from "node:test";
import assert from "node:assert/strict";
import { nestedRegionGround, woodenStreetFaults } from "../tools/worldgen-zone-textures.mts";
import { groundPaletteSchema } from "../tools/zonegen/schemas.mts";

test("zone-textures: a road or paving tile that is planks/boards/decking is a fault; a note never excuses it", () => {
  const plank = groundPaletteSchema.parse({
    id: "fen",
    ground: { grass: "zones/fen/grass.png", road: "mmo/Peat.png", paving: { texture: "mmo/WoodPlanks.png", uvScale: 3, note: "boardwalk town" }, accent: "mmo/deck-moss.png" },
  });
  const faults = woodenStreetFaults(plank);
  assert.equal(faults.length, 1, faults.join("\n"));
  assert.match(faults[0]!, /^fen\.paving: tile mmo\/WoodPlanks\.png is wood/);
  assert.equal((plank.ground.paving as { note?: string }).note, "boardwalk town", "the note is kept (schema allows it), and excuses nothing");
  for (const t of ["zones/x/Boardwalk.png", "props/deck-01.png"]) assert.equal(woodenStreetFaults(groundPaletteSchema.parse({ id: "p", ground: { road: t } })).length, 1, t);
  assert.deepEqual(woodenStreetFaults(groundPaletteSchema.parse({ id: "ok", ground: { road: "mmo/Gravel.png", paving: "zones/ok/paving.png" } })), []);
});

test("zone-textures --region: a corridor keeps every role its zone restyles and overrides only its own", () => {
  const zone = { grass: "z-grass", ground: "z-ground", cliff: "z-cliff", road: "z-road", accent: "z-accent", paving: "z-paving" };
  const g = nestedRegionGround(zone, { cliff: "g-cliff", accent: "g-accent" });
  assert.deepEqual(g, { ...zone, cliff: "g-cliff", accent: "g-accent" });
  assert.deepEqual(nestedRegionGround(undefined, { cliff: "g" }), { cliff: "g" });
});
