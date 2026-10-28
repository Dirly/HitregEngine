import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorldField, defaultWorldRecipe, LARGE_ROCK_MAX_METRES, scatterMaterialOf, SMALL_ROCK_METRES, worldRecipeSchema } from "@hitreg/core";
import { largeRockMaterialId, mergeRockSkinFields, planRockSkins, siblingTile, placedRocks, rockMaterialForSize, rockSkinsGate, skinPlacedOps, smallRockMaterialId, toneDistance, writeLargeRockMaterial, writeSmallRockMaterial } from "../tools/rock-skins.mts";
import { groundPaletteSchema } from "../tools/zonegen/schemas.mts";
import { riverWaterDoc } from "../tools/_river-water.mts";
import { rockSkinsBlock } from "../../../tools/poi-review/job.mjs";

import { FIXTURE_PROJECT as PROJECT, useRockSkinsFixture } from "./fixtures/rock-skins/build.mts";

after(useRockSkinsFixture());

const HAG_CLIFF = "zones/fixture-slate/cliff.png";

test("tone distance reads tone, not brightness: grey slate vs brown granite is far, two reds are near", () => {
  const granite = [0x5e, 0x53, 0x46], slate = [0x52, 0x5a, 0x5f], sandstone = [0x70, 0x51, 0x43], redCliff = [0x6b, 0x44, 0x39];
  assert.ok(toneDistance(granite, slate) > 9);
  assert.ok(toneDistance(sandstone, redCliff) < 9);
  // brightness alone moves nothing much
  assert.ok(toneDistance([60, 60, 60], [160, 160, 160]) < 1);
});

/** A small world on the fixture project's textures and rock material: one zone (x < 0) in fixture slate. */
function world(patch: Record<string, unknown> = {}) {
  const base = defaultWorldRecipe();
  const surfaces = [
    ...base.surfaces.map((s) => (s.name === "rock" ? { ...s, role: "cliff", map: "mmo/RockGrey.png" } : s.name === "grass" ? { ...s, role: "grass" } : s)),
    { name: "hag-cliff", color: "#525a5f", roughness: 0.9, map: HAG_CLIFF, uvScale: 18 },
  ];
  return worldRecipeSchema.parse({
    ...base,
    name: "rock-skins-test",
    cellSize: 32,
    resolution: 16,
    surfaces,
    scatter: [{ id: "rocks", model: "rock-kit/boulder-s-1.glb", material: "terrain/fixture-world-rock", cap: "auto", density: 0.02, slopeMax: 1, collider: "box", colliderSize: [1, 0.6, 0.9] }],
    regions: [{ id: "hag", name: "Hag", polygon: [[-3000, -3000], [0, -3000], [0, 3000], [-3000, 3000]], ground: { cliff: "hag-cliff" } }],
    ...patch,
  });
}
const BASES = [{ map: "rock-kit/granite.png", metres: 6.4 }, { map: "zones/fixture-rust/sandstone.png", metres: 6.4 }, { map: "mmo/Clif.png", metres: 20 }, { map: "mmo/RockGrey.png", metres: 11 }];

test("the template gives every stone surface a slice of its own texture, idempotently, at 40 texels/m", () => {
  const plan = planRockSkins(PROJECT, world(), BASES);
  assert.equal(plan.rockSkins["rock"], 3, "the base rock reuses the slice that already carries its tile");
  const slice = plan.rockSkins["hag-cliff"]!;
  assert.equal(slice, 4);
  assert.deepEqual(plan.bases[4], { map: HAG_CLIFF, metres: 12.8 });
  assert.equal(plan.flagged.length, 0);
  const again = planRockSkins(PROJECT, world({ rockSkins: plan.rockSkins }), plan.bases);
  assert.deepEqual(again.bases, plan.bases);
  assert.deepEqual(again.rockSkins, plan.rockSkins);
  assert.equal(again.added.length, 0);
  // a zone's own rock texture wins over its cliff tile
  const preferred = planRockSkins(PROJECT, world(), BASES, { "hag-cliff": "zones/fixture-rust/sandstone.png" });
  assert.equal(preferred.rockSkins["hag-cliff"], 1);
  // eight slices at most: a ninth stone is flagged, not dropped silently
  const full = planRockSkins(PROJECT, world(), [...BASES, ...BASES].map((b, i) => ({ ...b, map: `${b.map}?${i}` })));
  assert.ok(full.flagged.some((f) => f.includes("no free slice")));
});

test("an assigned slice is reclaimed for a corridor stone; the stone that held it keeps the slice and is reported", () => {
  const full = [...BASES, { map: HAG_CLIFF, metres: 12.8 }, { map: "a.png", metres: 6.4 }, { map: "b.png", metres: 6.4 }, { map: "c.png", metres: 6.4 }];
  const plan = planRockSkins(PROJECT, world({ rockSkins: { rock: 3, "hag-cliff": 4 } }), full, { "hag-cliff": "zones/fixture-slate/rock-large.png" }, {}, {}, { "hag-cliff": 3 });
  assert.equal(plan.rockSkins["hag-cliff"], 3);
  assert.equal(plan.rockSkins["rock"], 3, "the base rock keeps its (reclaimed) slice");
  assert.equal(plan.bases[3]!.map, "zones/fixture-slate/rock-large.png");
  assert.equal(plan.bases.length, 8);
  assert.ok(plan.added.some((a) => a.includes("reclaimed from mmo/RockGrey.png") && a.includes("rock now wear")));
  assert.ok(!plan.flagged.some((f) => f.includes("no free slice")));
});

test("the gate: no table is a recipe fault; a granite skin on slate is a skin fault; the zone's own slice passes", () => {
  const none = rockSkinsGate({ project: PROJECT, recipe: world(), area: { near: [-700, 0, 120] }, areaText: "t" });
  assert.equal(none.ok, false);
  assert.ok(none.rows.some((r) => r.fault === "recipe" && /no rockSkins table/.test(r.detail)));
  // every rock in the slate zone mapped to granite (slice 0): skin faults by tone
  const wrong = rockSkinsGate({ project: PROJECT, recipe: world({ rockSkins: { "hag-cliff": 0, rock: 3 } }), area: { near: [-700, 0, 120] }, areaText: "t" });
  assert.ok(wrong.checked.scatter > 0);
  assert.ok(wrong.counts.recipe >= 1, "the zone row names the wrong tone");
  assert.ok(wrong.counts.skin > 0);
  assert.ok(wrong.rows.filter((r) => r.fault === "skin").every((r) => (r.tone ?? 0) > 9));
  // RockGrey (slice 3) is within tone of the slate: clean
  const right = rockSkinsGate({ project: PROJECT, recipe: world({ rockSkins: { "hag-cliff": 3, rock: 3 } }), area: { near: [-700, 0, 120] }, areaText: "t" });
  assert.equal(right.counts.skin, 0, JSON.stringify(right.rows.slice(0, 3)));
  assert.equal(right.counts.cap, 0, JSON.stringify(right.rows.slice(0, 3)));
  // its only recipe fault is the small-rock one: 0.9 m boulders on the main material's cliff tiles
  assert.deepEqual(right.rows.filter((r) => r.fault === "recipe").map((r) => r.id), ["rocks"], JSON.stringify(right.rows.slice(0, 3)));
  assert.match(right.rows[0]!.detail, /pieces down to 0\.\d m wear terrain\/fixture-world-rock's cliff tiles.*smallMaterial/);
});

test("small rocks: the plan puts the zone's grainy small-rock tile in the zone's slot of a parallel material, at 40 texels/m", () => {
  const SMALL = "zones/fixture-slate/accent.png"; // 128 px: 3.2 m at 40 texels/m
  const plan = planRockSkins(PROJECT, world(), BASES, {}, { "hag-cliff": SMALL });
  const slice = plan.rockSkins["hag-cliff"]!;
  assert.equal(plan.smallBases.length, plan.bases.length, "slots run parallel: the per-instance slice is shared");
  assert.deepEqual(plan.smallBases[slice], { map: SMALL, metres: 3.2 });
  plan.smallBases.forEach((b, i) => { if (i !== slice) assert.equal(b.map, plan.bases[i]!.map, `slot ${i} keeps the main texture`); });
  assert.equal(plan.smallBases[2]!.metres, 12.8, "every slot at the texel standard (Clif.png 512 px: 12.8 m, not the main 20 m)");
  // without a preference: `rock-small.png` beside the zone's cliff tile, else flagged by name
  const fallback = planRockSkins(PROJECT, world(), BASES);
  assert.equal(fallback.smallBases[slice]!.map, "zones/fixture-slate/rock-small.png");
});

test("small rocks: scatter pieces under 4 m draw the small material; placed rocks pick it by their scaled size", () => {
  const rule = { material: "m", smallMaterial: "m-small" };
  assert.equal(scatterMaterialOf(rule, [1, 0.6, 0.9], 1.8), "m-small");
  assert.equal(scatterMaterialOf(rule, [1.5, 1.1, 1.4], 1.7), "m-small", "a 2.6 m boulder-m takes the small tile too");
  assert.equal(scatterMaterialOf(rule, [2.6, 2.0, 2.4], 1.7), "m", "a 4.4 m boulder keeps the main material");
  assert.equal(scatterMaterialOf({ material: "m" }, [1, 0.6, 0.9], 1), "m");
  assert.equal(SMALL_ROCK_METRES, 4);
  // the writer: a copy of the main material with the small bases, and every main-material rule pointed at it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rock-small-"));
  const main = { id: "terrain/w-rock", file: path.join(dir, "w-rock.json"), doc: { shader: "rock-cap", rockCap: { bases: [{ map: "a.png", metres: 12.8 }], start: 0.7 } } };
  const rules = [{ id: "r1", material: "terrain/w-rock" }, { id: "tree", material: "bark" }] as { id: string; material?: string; smallMaterial?: string }[];
  const w = writeSmallRockMaterial(main, [{ map: "a-small.png", metres: 6.4 }], rules);
  assert.equal(w.id, smallRockMaterialId(main.id));
  assert.deepEqual(JSON.parse(fs.readFileSync(w.file, "utf8")).rockCap, { bases: [{ map: "a-small.png", metres: 6.4 }], start: 0.7 });
  assert.deepEqual(rules.map((r) => r.smallMaterial ?? null), ["terrain/w-rock-small", null]);
  assert.equal(writeSmallRockMaterial(main, [{ map: "a-small.png", metres: 6.4 }], rules).wrote, false, "idempotent");
  // placed rocks: a 1.2 m boulder takes the small material, a 4.9 m boulder-xl the main one
  const recipe = world({ rockSkins: { "hag-cliff": 3, rock: 3 }, scatter: [{ id: "rocks", model: "rock-kit/boulder-s-1.glb", material: "terrain/fixture-world-rock", smallMaterial: "terrain/fixture-world-rock-small", cap: "auto", density: 0.02, slopeMax: 1, collider: "box", colliderSize: [1, 0.6, 0.9] }] });
  const scene = {
    entities: {
      s: { name: "s", parent: null, components: { transform: { position: [-700, 10, 3] }, prefab: { prefabId: "rock-kit/boulder-s-2", props: {}, overrides: [] } } },
      x: { name: "x", parent: null, components: { transform: { position: [-690, 10, 3] }, prefab: { prefabId: "rock-kit/boulder-xl-2", props: {}, overrides: [] } } },
    },
  };
  const rocks = placedRocks(PROJECT, scene);
  assert.ok(rocks.every((r) => r.size !== null));
  const { ops } = skinPlacedOps(PROJECT, scene, createWorldField(recipe));
  const mat = (id: string) => ops.find((o) => o.id === id)?.data.overrides.find((o: { path: string }) => o.path.endsWith("/components/mesh/material"))?.value;
  assert.equal(mat("s"), "terrain/fixture-world-rock-small");
  assert.equal(mat("x"), "terrain/fixture-world-rock");
});

test("large rocks: free-standing 4-16 m pieces draw the zone's boulder tile; cliff rules and cliff masses keep the cliff tile", () => {
  // the core pick: small under 4 m, large from 4 to 16 m, main beyond (cliff masses) and when the rule has no large material
  const rule = { material: "m", smallMaterial: "m-small", largeMaterial: "m-large" };
  assert.equal(scatterMaterialOf(rule, [1.5, 1.1, 1.4], 1.7), "m-small");
  assert.equal(scatterMaterialOf(rule, [2.6, 2.0, 2.4], 1.7), "m-large", "a 4.4 m boulder takes the boulder tile");
  assert.equal(scatterMaterialOf(rule, [6.6, 17.7, 5.2], 1), "m", "a 17.7 m buttress is a cliff mass");
  assert.equal(scatterMaterialOf({ material: "m", smallMaterial: "m-small" }, [2.6, 2.0, 2.4], 1.7), "m");
  assert.equal(scatterMaterialOf({ material: "m", largeMaterial: "m-large" }, [1, 0.6, 0.9], 1), "m", "no small material: main");
  assert.equal(LARGE_ROCK_MAX_METRES, 16);
  assert.deepEqual([1.2, 4, 15.9, 16, null].map((z) => rockMaterialForSize(z, { main: "m", small: "s", large: "l" })), ["s", "l", "l", "m", "m"]);
  // the plan: a parallel large material, the zone's boulder tile in the zone's slot at 40 texels/m
  const LARGE = "zones/fixture-slate/cliff.png"; // stands in for rock-large.png: 512 px -> 12.8 m
  const plan = planRockSkins(PROJECT, world(), BASES, {}, { "hag-cliff": "zones/fixture-slate/accent.png" }, { "hag-cliff": LARGE });
  const slice = plan.rockSkins["hag-cliff"]!;
  assert.equal(plan.largeBases.length, plan.bases.length);
  assert.deepEqual(plan.largeBases[slice], { map: LARGE, metres: 12.8 });
  plan.largeBases.forEach((b, i) => { if (i !== slice) assert.equal(b.map, plan.bases[i]!.map); });
  // the writer: free-standing rules take the large material; a cliff rule keeps (and loses a stray) large material
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rock-large-"));
  const main = { id: "terrain/w-rock", file: path.join(dir, "w-rock.json"), doc: { shader: "rock-cap", rockCap: { bases: [{ map: "a.png", metres: 12.8 }] } } };
  const rules = [{ id: "big", material: "terrain/w-rock" }, { id: "buttress", material: "terrain/w-rock", cliff: { mode: "face" }, largeMaterial: "terrain/w-rock-large" }, { id: "tree", material: "bark" }] as { id: string; material?: string; largeMaterial?: string; cliff?: unknown }[];
  const w = writeLargeRockMaterial(main, [{ map: "a-large.png", metres: 12.8 }], rules);
  assert.equal(w.id, largeRockMaterialId(main.id));
  assert.ok(fs.existsSync(path.join(dir, "w-rock-large.json")));
  assert.deepEqual(rules.map((r) => r.largeMaterial ?? null), ["terrain/w-rock-large", null, null]);
  assert.deepEqual(w.rules, ["big", "-buttress"]);
  assert.equal(writeLargeRockMaterial(main, [{ map: "a-large.png", metres: 12.8 }], rules).wrote, false, "idempotent");
  // the gate: 4.4 m free-standing pieces without a large material, and a cliff rule with one, are recipe faults
  const big = { id: "big", model: "rock-kit/boulder-xl-1.glb", material: "terrain/fixture-world-rock", smallMaterial: "terrain/fixture-world-rock-small", cap: "auto", density: 0.001, scale: [0.9, 1.5], collider: "box", colliderSize: [4.4, 3.5, 3.7] };
  const crag = { id: "crag", model: "rock-kit/crag-1.glb", material: "terrain/fixture-world-rock", smallMaterial: "terrain/fixture-world-rock-small", largeMaterial: "terrain/fixture-world-rock-large", cap: "auto", density: 0.001, scale: [1, 1], collider: "box", colliderSize: [5.2, 5.2, 3], cliff: { mode: "crest" } };
  const rep = rockSkinsGate({ project: PROJECT, recipe: world({ rockSkins: { "hag-cliff": 3, rock: 3 }, scatter: [big, crag] }), area: null, areaText: "t" });
  const recipeRows = rep.rows.filter((r) => r.fault === "recipe" && r.what === "rule");
  assert.ok(recipeRows.some((r) => r.id === "big" && /free-standing pieces up to 6\.\d m .*largeMaterial/.test(r.detail)), JSON.stringify(recipeRows));
  assert.ok(recipeRows.some((r) => r.id === "crag" && /cliff faces keep the cliff tile/.test(r.detail)), JSON.stringify(recipeRows));
  // placed: a 4.9 m boulder-xl takes the large material once a free-standing rule has one
  const placedRecipe = world({ rockSkins: { "hag-cliff": 3, rock: 3 }, scatter: [{ ...big, largeMaterial: "terrain/fixture-world-rock-large" }] });
  const scene = { entities: { x: { name: "x", parent: null, components: { transform: { position: [-690, 10, 3] }, prefab: { prefabId: "rock-kit/boulder-xl-2", props: {}, overrides: [] } } } } };
  const { ops } = skinPlacedOps(PROJECT, scene, createWorldField(placedRecipe));
  assert.equal(ops[0]?.data.overrides.find((o: { path: string }) => o.path.endsWith("/components/mesh/material"))?.value, "terrain/fixture-world-rock-large");
  // the palette names its boulder tile
  assert.equal(groundPaletteSchema.parse({ id: "p", ground: {}, rockLarge: "zones/p/rock-large.png" }).rockLarge, "zones/p/rock-large.png");
});

test("placed rock-kit props are read with their overrides; one drawing its own granite is a skin fault", () => {
  const scene = {
    entities: {
      g: { name: "g", parent: null, components: { transform: { position: [-700, 0, 0] } } },
      a: { name: "a", parent: "g", components: { transform: { position: [5, 12, 3] }, prefab: { prefabId: "rock-kit/boulder-s-2", props: {}, overrides: [] } } },
      b: { name: "b", parent: "g", components: { transform: { position: [9, 12, 3] }, prefab: { prefabId: "rock-kit/boulder-s-2", props: {}, overrides: [{ path: "rock/components/mesh/material", value: "terrain/fixture-world-rock" }, { path: "rock/components/mesh/source/rockCap", value: { layer: 0, amount: 0, base: 3 } }] } } },
    },
  };
  const rocks = placedRocks(PROJECT, scene);
  assert.equal(rocks.length, 2);
  assert.deepEqual([rocks[0]!.x, rocks[0]!.z], [-695, 3]);
  assert.equal(rocks[0]!.material, null);
  assert.equal(rocks[1]!.rockCap?.base, 3);
  const rep = rockSkinsGate({ project: PROJECT, recipe: world({ rockSkins: { "hag-cliff": 3, rock: 3 } }), area: null, areaText: "t", scene });
  const scene_ = rep.rows.filter((r) => r.kind === "scene");
  assert.equal(scene_.length, 1);
  assert.equal(scene_[0]!.id, "a");
  assert.match(scene_[0]!.detail, /model's own rock-kit\/granite\.png/);
});

test("poi-review gate 6 reads the rock-skins report", () => {
  assert.match(rockSkinsBlock("/nonexistent-job-dir") ?? "", /no rock-skins gate evidence/);
});

test("init template: river water takes the flowing and FALL tiles from the dependsOn closure", () => {
  const base = { color: "#224455", water: { texture: "mmo/Water.png", textureScale: 26 } };
  const closure = new Set(["mmo/Water.png", "mmo/WaterFlowing.png", "mmo/WaterFall.png"]);
  const doc = riverWaterDoc(base, (t) => closure.has(t)) as { water: Record<string, unknown> };
  assert.equal(doc.water["texture"], "mmo/WaterFlowing.png");
  assert.equal(doc.water["fallTexture"], "mmo/WaterFall.png");
  assert.equal(doc.water["fallTextureScale"], 4);
  assert.equal(doc.water["fallSpeed"], 7);
  assert.equal(doc.water["stillTexture"], "mmo/Water.png");
  // nothing in reach: no fall tile, and the base texture stands
  const bare = riverWaterDoc(base, () => false) as { water: Record<string, unknown> };
  assert.equal(bare.water["fallTexture"], undefined);
  assert.equal(bare.water["texture"], "mmo/Water.png");
});

test("mergeRockSkinFields: install writes only its own fields onto a fresh recipe read (features added meanwhile survive)", () => {
  const stale = { rockSkins: { a: "x" }, features: { passages: [] }, scatter: [{ id: "r1", material: "m", smallMaterial: "m-small" }, { id: "r2", material: "m", largeMaterial: undefined }] };
  const fresh = { rockSkins: null, features: { passages: [{ id: "widows-stair-cut-1" }] }, scatter: [{ id: "r1", material: "m" }, { id: "r2", material: "m", largeMaterial: "old" }, { id: "r3", material: "n" }] };
  const out = mergeRockSkinFields(fresh, stale);
  assert.deepEqual(out.features.passages, [{ id: "widows-stair-cut-1" }]);
  assert.deepEqual(out.rockSkins, { a: "x" });
  assert.equal(out.scatter[0].smallMaterial, "m-small");
  assert.equal("largeMaterial" in out.scatter[1], false);
  assert.deepEqual(out.scatter[2], { id: "r3", material: "n" });
});

test("a corridor cliff tile <prefix>cliff.png finds its <prefix>rock-small/-large tiles; a plain cliff.png falls back", () => {
  assert.equal(siblingTile(PROJECT, "zones/fixture-slate/gorge-cliff.png", "rock-small.png"), "zones/fixture-slate/gorge-rock-small.png");
  assert.equal(siblingTile(PROJECT, "zones/fixture-slate/gorge-cliff.png", "rock.png"), null);
  assert.equal(siblingTile(PROJECT, HAG_CLIFF, "rock-small.png"), null);
});

test("a stone of a built structure (tag stone:<material>) takes its structure's stone, never the zone skin; the gate judges it against that stone (RETTING)", () => {
  const recipe = world({ rockSkins: { "hag-cliff": 3, rock: 3 }, scatter: [{ id: "rocks", model: "rock-kit/boulder-s-1.glb", material: "terrain/fixture-world-rock", smallMaterial: "terrain/fixture-world-rock-small", cap: "auto", density: 0.02, slopeMax: 1, collider: "box", colliderSize: [1, 0.6, 0.9] }] });
  const scene = {
    entities: {
      w: { name: "w", parent: null, tags: ["stone:fixture-keep/face"], components: { transform: { position: [-700, 10, 3] }, prefab: { prefabId: "rock-kit/boulder-s-2", props: {}, overrides: [{ path: "rock/components/mesh/source/rockCap", value: { layer: 0, amount: 0, base: 3 } }] } } },
      n: { name: "n", parent: null, components: { transform: { position: [-695, 10, 3] }, prefab: { prefabId: "rock-kit/boulder-s-2", props: {}, overrides: [] } } },
    },
  };
  const rocks = placedRocks(PROJECT, scene);
  assert.equal(rocks.find((r) => r.id === "w")?.builtStone, "fixture-keep/face");
  const { ops } = skinPlacedOps(PROJECT, scene, createWorldField(recipe));
  const ov = (id: string) => ops.find((o) => o.id === id)?.data.overrides as { path: string; value: unknown }[];
  assert.equal(ov("w").find((o) => o.path.endsWith("/components/mesh/material"))?.value, "fixture-keep/face");
  assert.ok(!ov("w").some((o) => o.path.endsWith("/rockCap")), "no cap on a built stone");
  assert.equal(ov("n").find((o) => o.path.endsWith("/components/mesh/material"))?.value, "terrain/fixture-world-rock-small", "a loose rock keeps the zone skin");
  // the gate: a built stone wearing the zone skin is a fault; wearing its structure's stone passes
  const gate = (overrides: unknown[]) => rockSkinsGate({ project: PROJECT, recipe, area: null, areaText: "t", scene: { entities: { w: { ...scene.entities.w, components: { ...scene.entities.w.components, prefab: { prefabId: "rock-kit/boulder-s-2", props: {}, overrides } } } } } }).rows.filter((r) => r.kind === "scene");
  assert.match(gate([{ path: "rock/components/mesh/material", value: "terrain/fixture-world-rock-small" }])[0]?.detail ?? "", /not its structure's fixture-keep\/face/);
  assert.deepEqual(gate([{ path: "rock/components/mesh/material", value: "fixture-keep/face" }]), []);
});
