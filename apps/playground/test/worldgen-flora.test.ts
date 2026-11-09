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
  assert.deepEqual(keep.rules.sort(), [WOODLAND_RULE.canopy, WOODLAND_RULE.understory, WOODLAND_RULE.oasis, "oasis-palm-grove"].sort());
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

// owner ruling 2026-10-30 (redstrand): "the weeping willows really shouldn't be there. Palm trees along the lakes, yeah."
// A dry world's water edge (dry ground and the oasis ribbon) grows palms, a bank row and a sparser grove behind it; a
// willow stands only by upland water.
test("woodland: a dry world's desert and oasis water grows palms; willows only by upland water", async () => {
  const { applyWoodland, WOODLAND_RULE, OASIS_GROVE_RULE } = await import("../tools/worldgen-flora.mts");
  const w = world(true);
  applyFlora(w); // the borrowed tropical palm rule out first
  const notes = applyWoodland(w);
  const willow = w.scatter.find((r) => r.id === WOODLAND_RULE.shore)!;
  for (const b of ["savanna", "badlands", "forest"]) assert.ok(!willow.biomes.includes(b), `willow in ${b}: ${notes.join("\n")}`);
  assert.ok(willow.biomes.includes("highland"), willow.biomes.join(","));
  const palm = w.scatter.find((r) => r.id === WOODLAND_RULE.oasis)!;
  assert.equal((palm as { model?: string }).model, "mmo/nature/PalmTree.gltf");
  for (const b of ["savanna", "badlands", "forest"]) assert.ok(palm.biomes.includes(b), `palm missing ${b}`);
  assert.ok(!palm.biomes.includes("highland"));
  // the grove stands further back and thinner: the density falls off away from the water
  const grove = w.scatter.find((r) => r.id === OASIS_GROVE_RULE)! as unknown as { density: number; water: { wade: [number, number]; mode: string } };
  const bank = palm as unknown as { density: number; water: { wade: [number, number]; mode: string } };
  assert.equal(bank.water.mode, "shore");
  assert.ok(grove.density < bank.density);
  assert.ok(grove.water.wade[0] < bank.water.wade[0] && grove.water.wade[1] <= bank.water.wade[0]);
  assert.deepEqual(floraFindings(w), []);
  // a palm AWAY from water is still tropical-only; a willow by desert water is a finding
  w.scatter.push({ ...palm, id: "dry-palm", water: undefined } as never);
  w.scatter.push({ ...willow, id: "desert-willow", biomes: ["savanna"] } as never);
  const got = floraFindings(w).map((f) => `${f.rule}@${f.biome}`).filter((x) => /dry-palm@savanna|desert-willow@savanna/.test(x)).sort();
  assert.deepEqual(got, ["desert-willow@savanna", "dry-palm@savanna"]);
  // a temperate world writes no oasis palms
  const t = world(false);
  applyWoodland(t);
  assert.equal(t.scatter.some((r) => r.id === WOODLAND_RULE.oasis || r.id === OASIS_GROVE_RULE), false);
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

// owner ruling 2026-10-30 (redstrand): "we have this wheat-looking grass, which honestly a desert wouldn't have; now the
// farm would have some crops." Cover kinds come from the tiles a layer draws.
test("cover: wheat is a crop (fields only); wheat-looking and lush cover leave a dry world's dry ground for desert cover", async () => {
  const { applyCoverFlora, coverFloraFindings, coverKindsOf } = await import("../tools/worldgen-flora.mts");
  const names = ["wheat", "tallgrass", "cattails", "reeds", "papyrus", "foxglove", "thistle", "elephantear", "bamboo", "junglefern", "savannatall"];
  const tufts: (string | null)[] = ["poppies", "daisies", ...Array<null>(13).fill(null), "savannagrass", null, null, null, "desertscrub", "pricklypear", "agave"];
  const tileNames = (t: string) => (t === "cover/cover-tall.png" ? names : t === "cover/cover-tufts.png" ? tufts : null);
  const w = world(true);
  w.cover = [
    { id: "wheat-fields", texture: "cover/cover-tall.png", tiles: [0], biomes: ["savanna"], surfaces: ["drygrass"], density: 2, clump: { frequency: 0.005, octaves: 2, threshold: 0.3, blend: 0.1, floor: 0, seed: 2 } },
    { id: "savanna-grass", texture: "cover/cover-tall.png", tiles: [10], biomes: ["savanna"], surfaces: ["drygrass", "grass"], density: 0.9 },
    { id: "tall-grass", texture: "cover/cover-tall.png", tiles: [1], biomes: ["foothills", "highland"], surfaces: ["grass"], density: 0.5 },
    { id: "dry-tufts", texture: "cover/cover-tufts.png", tiles: [15, 19], biomes: ["savanna", "badlands"], surfaces: ["drygrass", "sand"], density: 0.3 },
    { id: "desert-plants", texture: "cover/cover-tufts.png", tiles: [19, 20, 21], biomes: ["badlands"], surfaces: ["sand", "dirt"], density: 0.035 },
  ] as never;
  assert.deepEqual([...coverKindsOf(w.cover[1] as never, tileNames)], ["grain"]);
  const found = coverFloraFindings(w, tileNames).map((f) => `${f.layer}@${f.biome}`).sort();
  // tall grass grows on the upland (foothills, highland): not dry ground, not a finding
  assert.deepEqual(found, ["savanna-grass@savanna", "wheat-fields@(wild)"]);
  const notes = applyCoverFlora(w, tileNames);
  assert.deepEqual(coverFloraFindings(w, tileNames), [], notes.join("\n"));
  const L = (id: string) => (w.cover as unknown as { id: string; biomes: string[]; surfaces: string[]; fields?: boolean; clump?: unknown }[]).find((l) => l.id === id);
  // the crop stays, but only in declared fields: no biome, surface or clump gate (the field decides)
  assert.equal(L("wheat-fields")!.fields, true);
  assert.deepEqual([L("wheat-fields")!.biomes, L("wheat-fields")!.surfaces, L("wheat-fields")!.clump], [[], [], undefined]);
  // the wheat-looking plume is gone; the desert layers grow on the savanna, on the ground it stood on
  assert.equal(L("savanna-grass"), undefined);
  assert.ok(L("desert-plants")!.biomes.includes("savanna"));
  assert.ok(L("desert-plants")!.surfaces.includes("drygrass"));
  assert.deepEqual(L("tall-grass")!.biomes, ["foothills", "highland"]);
  assert.deepEqual(applyCoverFlora(w, tileNames), []);
});

// owner ruling 2026-10-30 (Derek): "grass always needs to match the colour of the grass tile."
test("cover colour: blades read as the ground tile they stand on, per zone; the fit re-tints a layer onto its tiles", async () => {
  const { coverColourFindings, fitCoverColours } = await import("../tools/worldgen-cover-colour.mts");
  const raw = world(true);
  const surfaces = raw.surfaces.map((s) => ({ ...s }));
  const grassIdx = surfaces.findIndex((s) => s.name === "grass");
  (surfaces[grassIdx] as { role?: string }).role = "grass";
  surfaces.push({ ...surfaces[grassIdx]!, name: "zone-grass", map: "zones/z/grass.png", role: undefined } as never);
  const zonePoly: [number, number][] = [[-9e3, -9e3], [9e3, -9e3], [9e3, 9e3], [-9e3, 9e3]];
  const tuftLayer = { texture: "cover/tufts.png", atlas: { columns: 1, rows: 1 }, tiles: [0], biomes: [], density: 1 };
  const w = worldRecipeSchema.parse({
    ...raw,
    surfaces,
    regions: [{ id: "zone-red", name: "Red", polygon: zonePoly, ground: { grass: "zone-grass" } }],
    cover: [
      { ...tuftLayer, id: "carpet", surfaces: ["grass"], bladeColor: "#ffffff" },
      { ...tuftLayer, id: "reeds", surfaces: [], water: { mode: "shore", level: [-0.5, 0.5], reach: 4, depth: [0.2, 2], kinds: ["lake"], maxFlow: 0.5 } },
    ],
  });
  // a green sprite over a red-brown zone tile (the redstrand fault)
  const src = {
    sprite: (): [number, number, number] => [90, 140, 60],
    tile: (m: string): [number, number, number] | null => (m === "zones/z/grass.png" ? [115, 78, 52] : null),
  };
  const f = coverColourFindings(w, src);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.deepEqual([f[0]!.layer, f[0]!.tile, f[0]!.where], ["carpet", "zone-grass", "zone-red"]);
  assert.ok(f[0]!.hueOff > 25);
  const notes = fitCoverColours(w, src);
  assert.ok(/carpet bladeColor #ffffff -> #/.test(notes[0]!), notes.join("\n"));
  assert.ok(!/STILL/.test(notes[0]!), notes[0]);
  assert.deepEqual(coverColourFindings(w, src), []);
  // a zone that denies the layer is not judged against its tile
  const denied = worldRecipeSchema.parse({
    ...w,
    cover: w.cover.map((l) => ({ ...l, bladeColor: "#ffffff" })),
    regions: [{ ...w.regions[0]!, vegetation: { cover: { deny: ["carpet"] } } }],
  });
  assert.deepEqual(coverColourFindings(denied, src), []);
});
