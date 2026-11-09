import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { terraceWallSchema } from "@hitreg/core";
import { masonryKey, MASONRY_PALETTES, townWallStyle, zoneCliffAt } from "../tools/worldgen-terrace-walls.mts";

// k-town2 (Derek 2026-10-30): "why is there grey brick below the chapel, why is it not the same stone found in the region?"
test("a town's retaining walls are its own stone: the buildings' kit style picks the palette", () => {
  assert.equal(townWallStyle({ tier: "town", tags: ["town"] }, { kitStyles: ["strand-lime", "strand-lime", "strand-rubble", undefined] }), "masonry-strand");
  assert.equal(townWallStyle({ tier: "town", tags: ["town", "kit:badland-render"] }), "masonry-strand");
  // a `walls:` tag still wins; a town with no palette keeps the system rule
  assert.equal(townWallStyle({ tier: "town", tags: ["walls:stone"] }, { kitStyles: ["strand-lime"] }), "masonry-stone");
  assert.equal(townWallStyle({ tier: "capital", tags: [] }, { kitStyles: ["timber-town"] }), "masonry-stone");
  assert.equal(townWallStyle({ tier: "town", tags: [] }), "masonry-common");
});

test("no kit style: the zone's stone (the region's cliff surface) picks it", () => {
  const recipe = { regions: [
    { polygon: [[0, 0], [100, 0], [100, 100], [0, 100]], ground: { cliff: "redstrand-cliff" } },
    { polygon: [[200, 0], [300, 0], [300, 100], [200, 100]], ground: { cliff: "brinehold-cliff" } },
  ] };
  assert.equal(zoneCliffAt(recipe, [50, 50]), "redstrand-cliff");
  assert.equal(townWallStyle({ tags: [] }, { zoneCliff: zoneCliffAt(recipe, [50, 50]) }), "masonry-strand");
  assert.equal(townWallStyle({ tags: [] }, { zoneCliff: zoneCliffAt(recipe, [250, 50]) }), "masonry-common");
});

test("the retaining-wall kit carries every palette's pieces and the schema accepts the style", () => {
  const lookup = JSON.parse(fs.readFileSync(path.join("projects", "world-kit", "authoring", "retaining-wall", "lookup.json"), "utf8")) as { styles: Record<string, Record<string, Record<string, string>>> };
  for (const p of MASONRY_PALETTES) {
    const s = lookup.styles[masonryKey(p.masonry)];
    assert.ok(s, `lookup has style ${masonryKey(p.masonry)}`);
    assert.deepEqual(Object.keys(s!).sort(), Object.keys(lookup.styles.common!).sort(), "every height the common style has");
    for (const H of Object.keys(s!)) assert.deepEqual(Object.keys(s![H]!).sort(), Object.keys(lookup.styles.common![H]!).sort());
  }
  assert.equal(terraceWallSchema.parse({ id: "t", style: "masonry-strand", footprint: [[0, 0], [8, 0], [8, 8]], topY: 3 }).style, "masonry-strand");
});

test("the Redstrand town resolves to the strand masonry (its zone's red rock: its design names no kit style)", () => {
  const f = path.join("projects", "redstrand", "authoring", "towns", "town-1-design.json"), w = path.join("projects", "redstrand", "assets", "worlds", "redstrand.json");
  if (!fs.existsSync(f) || !fs.existsSync(w)) return;      // the game project is its own repo
  const d = JSON.parse(fs.readFileSync(f, "utf8")) as { buildings: { request?: { style?: string } }[] };
  const recipe = JSON.parse(fs.readFileSync(w, "utf8")) as { regions: never[]; features: { towns: { id: string; tier?: string; tags: string[]; center: number[] }[] } };
  const town = recipe.features.towns.find((t) => t.id === "town-1")!;
  assert.equal(townWallStyle(town, { kitStyles: d.buildings.map((b) => b.request?.style), zoneCliff: zoneCliffAt(recipe, town.center) }), "masonry-strand");
});
