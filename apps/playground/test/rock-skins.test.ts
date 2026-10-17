import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { planRockSkins, placedRocks, rockSkinsGate, toneDistance } from "../tools/rock-skins.mts";
import { riverWaterDoc } from "../tools/_river-water.mts";
import { rockSkinsBlock } from "../../../tools/poi-review/job.mjs";

const HAG_CLIFF = "zones/skelmorrow-hagsheer/cliff.png";

test("tone distance reads tone, not brightness: grey slate vs brown granite is far, two reds are near", () => {
  const granite = [0x5e, 0x53, 0x46], slate = [0x52, 0x5a, 0x5f], sandstone = [0x70, 0x51, 0x43], redCliff = [0x6b, 0x44, 0x39];
  assert.ok(toneDistance(granite, slate) > 9);
  assert.ok(toneDistance(sandstone, redCliff) < 9);
  // brightness alone moves nothing much
  assert.ok(toneDistance([60, 60, 60], [160, 160, 160]) < 1);
});

/** A small world on the skelmorrow project's real textures and rock material: one zone (x < 0) in Hagsheer slate. */
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
    scatter: [{ id: "rocks", model: "rock-kit/boulder-s-1.glb", material: "terrain/skelmorrow-rock", cap: "auto", density: 0.02, slopeMax: 1, collider: "box", colliderSize: [1, 0.6, 0.9] }],
    regions: [{ id: "hag", name: "Hag", polygon: [[-3000, -3000], [0, -3000], [0, 3000], [-3000, 3000]], ground: { cliff: "hag-cliff" } }],
    ...patch,
  });
}
const BASES = [{ map: "rock-kit/granite.png", metres: 6.4 }, { map: "zones/skelmorrow-rustmarch/sandstone.png", metres: 6.4 }, { map: "mmo/Clif.png", metres: 20 }, { map: "mmo/RockGrey.png", metres: 11 }];

test("the template gives every stone surface a slice of its own texture, idempotently, at 40 texels/m", () => {
  const plan = planRockSkins("skelmorrow", world(), BASES);
  assert.equal(plan.rockSkins["rock"], 3, "the base rock reuses the slice that already carries its tile");
  const slice = plan.rockSkins["hag-cliff"]!;
  assert.equal(slice, 4);
  assert.deepEqual(plan.bases[4], { map: HAG_CLIFF, metres: 12.8 });
  assert.equal(plan.flagged.length, 0);
  const again = planRockSkins("skelmorrow", world({ rockSkins: plan.rockSkins }), plan.bases);
  assert.deepEqual(again.bases, plan.bases);
  assert.deepEqual(again.rockSkins, plan.rockSkins);
  assert.equal(again.added.length, 0);
  // a zone's own rock texture wins over its cliff tile
  const preferred = planRockSkins("skelmorrow", world(), BASES, { "hag-cliff": "zones/skelmorrow-rustmarch/sandstone.png" });
  assert.equal(preferred.rockSkins["hag-cliff"], 1);
  // eight slices at most: a ninth stone is flagged, not dropped silently
  const full = planRockSkins("skelmorrow", world(), [...BASES, ...BASES].map((b, i) => ({ ...b, map: `${b.map}?${i}` })));
  assert.ok(full.flagged.some((f) => f.includes("no free slice")));
});

test("the gate: no table is a recipe fault; a granite skin on slate is a skin fault; the zone's own slice passes", () => {
  const none = rockSkinsGate({ project: "skelmorrow", recipe: world(), area: { near: [-700, 0, 120] }, areaText: "t" });
  assert.equal(none.ok, false);
  assert.ok(none.rows.some((r) => r.fault === "recipe" && /no rockSkins table/.test(r.detail)));
  // every rock in the slate zone mapped to granite (slice 0): skin faults by tone
  const wrong = rockSkinsGate({ project: "skelmorrow", recipe: world({ rockSkins: { "hag-cliff": 0, rock: 3 } }), area: { near: [-700, 0, 120] }, areaText: "t" });
  assert.ok(wrong.checked.scatter > 0);
  assert.ok(wrong.counts.recipe >= 1, "the zone row names the wrong tone");
  assert.ok(wrong.counts.skin > 0);
  assert.ok(wrong.rows.filter((r) => r.fault === "skin").every((r) => (r.tone ?? 0) > 9));
  // RockGrey (slice 3) is within tone of the slate: clean
  const right = rockSkinsGate({ project: "skelmorrow", recipe: world({ rockSkins: { "hag-cliff": 3, rock: 3 } }), area: { near: [-700, 0, 120] }, areaText: "t" });
  assert.equal(right.counts.skin, 0, JSON.stringify(right.rows.slice(0, 3)));
  assert.equal(right.counts.cap, 0, JSON.stringify(right.rows.slice(0, 3)));
  assert.equal(right.counts.recipe, 0, JSON.stringify(right.rows.slice(0, 3)));
});

test("placed rock-kit props are read with their overrides; one drawing its own granite is a skin fault", () => {
  const scene = {
    entities: {
      g: { name: "g", parent: null, components: { transform: { position: [-700, 0, 0] } } },
      a: { name: "a", parent: "g", components: { transform: { position: [5, 12, 3] }, prefab: { prefabId: "rock-kit/boulder-s-2", props: {}, overrides: [] } } },
      b: { name: "b", parent: "g", components: { transform: { position: [9, 12, 3] }, prefab: { prefabId: "rock-kit/boulder-s-2", props: {}, overrides: [{ path: "rock/components/mesh/material", value: "terrain/skelmorrow-rock" }, { path: "rock/components/mesh/source/rockCap", value: { layer: 0, amount: 0, base: 3 } }] } } },
    },
  };
  const rocks = placedRocks("skelmorrow", scene);
  assert.equal(rocks.length, 2);
  assert.deepEqual([rocks[0]!.x, rocks[0]!.z], [-695, 3]);
  assert.equal(rocks[0]!.material, null);
  assert.equal(rocks[1]!.rockCap?.base, 3);
  const rep = rockSkinsGate({ project: "skelmorrow", recipe: world({ rockSkins: { "hag-cliff": 3, rock: 3 } }), area: null, areaText: "t", scene });
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
