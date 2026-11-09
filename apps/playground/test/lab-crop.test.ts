// _lab-crop (tools/_lab-crop.mts): a cropped lab keeps the features that reach its box, proves its ground identical to
// live inside the box (and the proof bites when it is not), and keeps only the scene inside the box plus the globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorldField, defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import { approachArrival, cropRecipe, cropScene, featureExtent, labBox, labSpawn, proveCrop, viewPoints } from "../tools/_lab-crop.mts";

const patch = (id: string, x: number, z: number, y: number) => ({ id, origin: [x, z], size: [24, 24], columns: 4, rows: 4, heights: Array(16).fill(y), blend: 4 });
function world(): any {
  const base = defaultWorldRecipe();
  return JSON.parse(JSON.stringify({ ...base, cellSize: 48, resolution: 8, scatter: [], features: { ...base.features, heightPatches: [patch("near", 20, 20, 30), patch("far", 1500, 1500, 60)] } }));
}
const box = { min: [-60, -60] as [number, number], max: [100, 100] as [number, number] };

test("crop drops features that miss the box and proves the ground inside it identical", () => {
  const raw = world();
  const { recipe, proof, dropped } = cropRecipe(raw, box, { step: 8 });
  assert.equal(proof.ok, true);
  assert.deepEqual(recipe.features.heightPatches.map((p: any) => p.id), ["near"]);
  assert.equal(dropped.heightPatches, 1);
  assert.ok(proof.cells > 0 && proof.samples > 0);
});

test("the proof bites: a feature inside the box left out is a difference", () => {
  const raw = world();
  const live = createWorldField(worldRecipeSchema.parse(raw));
  const bad = { ...raw, features: { ...raw.features, heightPatches: [] } };
  const proof = proveCrop(live, bad, box, 8);
  assert.equal(proof.ok, false);
  assert.match(proof.worst ?? "", /differs|generates differently/);
});

test("feature extents, boxes and view points", () => {
  assert.deepEqual(featureExtent({ id: "r", points: [[0, 5, 0], [10, 5, 20]], width: 4 }), { min: [-4, -4], max: [14, 24] });
  assert.deepEqual(featureExtent({ id: "p", origin: [10, 10], size: [5, 5] }), { min: [10, 10], max: [15, 15] });
  assert.equal(featureExtent({ id: "noise", frequency: 0.1 }), null);
  assert.deepEqual(labBox([[0, 0], [10, 20]], 5), { min: [-5, -5], max: [15, 25] });
  const far = viewPoints({ camera: [0, 50, 0], target: [0, 10, 100] });
  assert.deepEqual(far[0], [0, 0]);
  assert.ok(far[2]![1] > 100); // the box reaches past the target
});

test("the scene keeps globals and what stands inside the box; the player moves in; the world is bounded", () => {
  const scene = { version: 1, name: "s", entities: {
    world: { name: "world", parent: null, tags: [], components: { voxelWorld: { world: "w" } } },
    sky: { name: "sky", parent: null, tags: [], components: { sky: {} } },
    player: { name: "player", parent: null, tags: ["player"], components: { transform: { position: [5000, 60, 5000] } } },
    inside: { name: "in", parent: null, tags: [], components: { transform: { position: [10, 0, 10] } } },
    root: { name: "root", parent: null, tags: [], components: { transform: { position: [0, 0, 0] } } },
    kid: { name: "kid", parent: "root", tags: [], components: { transform: { position: [30, 0, 30] } } },
    away: { name: "away", parent: null, tags: [], components: { transform: { position: [900, 0, 900] } } },
  } };
  const { scene: out, dropped } = cropScene(scene, box, { x: 1, z: 2, groundY: 40 });
  assert.deepEqual(Object.keys(out.entities).sort(), ["inside", "kid", "player", "root", "sky", "world"]);
  assert.equal(dropped, 1);
  assert.deepEqual(out.entities.player.components.transform.position, [1, 41, 2]);
  assert.deepEqual(out.entities.world.components.voxelWorld.bounds, { min: box.min, max: box.max });
  assert.deepEqual(scene.entities.player.components.transform.position, [5000, 60, 5000]); // the source is untouched
});

// Derek 2026-10-31: "build it with the water layer in those separate chunks": the ocean plane (origin far outside the box)
test("the crop keeps a primitive plane that REACHES the box (the world ocean), and drops one that does not", () => {
  const plane = (pos: number[], size: number) => ({ parent: null, tags: ["water"], components: { transform: { position: pos }, mesh: { source: { kind: "primitive", shape: "plane", size: [size, 1, size] }, material: "terrain/w-water" } } });
  const scene = { version: 1, name: "s", entities: {
    world: { name: "world", parent: null, tags: [], components: { voxelWorld: { world: "w" } } },
    ocean: { name: "Ocean", ...plane([3000, 0, 3000], 11200) },
    pond: { name: "pond", ...plane([900, 0, 900], 40) },
  } };
  const { scene: out } = cropScene(scene, box, { x: 1, z: 2, groundY: 40 });
  assert.deepEqual(Object.keys(out.entities).sort(), ["ocean", "world"]);
});

// Derek 2026-10-31: "it would be nice if the camera was already centred on those locations in those temp scenes"
test("a lab starts at the place: approach arrival, walkable stand facing the centre, camera behind", () => {
  // an approach road from far west to the centre: it arrives at the reservation's rim (radius 40 + 10 m)
  const arrival = approachArrival([[[-300, 0], [-100, 0], [0, 0]]], [0, 0], 40)!;
  assert.ok(arrival[0] <= -48 && arrival[0] >= -52 && arrival[1] === 0, `arrival ${arrival}`);
  // no line comes that near: the nearest point of the line
  assert.deepEqual(approachArrival([[[-300, 200], [300, 200]]], [0, 0], 40), [0, 200]);
  assert.equal(approachArrival([], [0, 0], 40), null);
  // a field: a steep bank west of x = -40, flat dry ground east of it
  const field = { slope: (x: number) => (x < -40 ? 0.9 : 0.05), waterY: () => null, surfaceCast: () => 12, height: () => 12 } as any;
  const sp = labSpawn(field, [-50, 0], [0, 0], "t");
  assert.ok(sp.position[0] >= -40 && sp.position[0] <= -38, `walks off the bank: ${sp.position}`);
  assert.equal(sp.position[1], 13.1);
  // facing +X: yaw 90 deg about Y
  assert.ok(Math.abs(sp.rotation[1] - Math.SQRT1_2) < 1e-5 && Math.abs(sp.rotation[3] - Math.SQRT1_2) < 1e-5, `rotation ${sp.rotation}`);
  // cropScene with a target moves the player even when it already stood in the box, faces it, and the camera sits behind
  const scene = { version: 1, name: "s", entities: {
    world: { name: "world", parent: null, tags: [], components: { voxelWorld: { world: "w" } } },
    player: { name: "player", parent: null, tags: ["player"], components: { transform: { position: [90, 60, 90] } } },
    spawn: { name: "spawn", parent: null, tags: ["spawn"], components: { transform: { position: [90, 59, 90] } } },
    camera: { name: "camera", parent: null, tags: [], components: { transform: { position: [95, 62, 95] }, camera: { active: true } } },
  } };
  const out = cropScene(scene, box, { x: sp.position[0], z: sp.position[2], groundY: sp.ground, target: sp.target }).scene;
  assert.deepEqual(out.entities.player.components.transform.position, [sp.position[0], 13.1, 0]);
  assert.deepEqual(out.entities.player.components.transform.rotation, sp.rotation);
  assert.deepEqual(out.entities.spawn.components.transform.position, [sp.position[0], 12, 0]);
  const cam = out.entities.camera.components.transform.position;
  assert.ok(Math.abs(cam[0] - (sp.position[0] - 7)) < 0.01 && cam[2] === 0 && cam[1] > 13, `camera behind: ${cam}`);
});

// w-temple8 2026-11-03: a concept view from a swimmer's eye across a lake has no dry ground between eye and target; the
// scratch started on the lake bed with the camera under water and its frame never drew (near-black)
test("a lab whose eye-to-target line is all water starts on the nearest dry ground, never on the lake bed", () => {
  // a lake south of z = 10 (water 20, bed 12), dry flat shore north of it at height 22
  const wet = (z: number) => z < 10;
  const field = { slope: () => 0.05, waterY: (_x: number, z: number) => (wet(z) ? 20 : null), surfaceCast: (_x: number, z: number) => (wet(z) ? 12 : 22), height: (_x: number, z: number) => (wet(z) ? 12 : 22) } as any;
  const sp = labSpawn(field, [0, 0], [0, -40], "t");
  assert.ok(sp.position[2] >= 10 && sp.position[2] <= 14, `on the shore: ${sp.position}`);
  assert.equal(sp.ground, 22);
  assert.equal(sp.position[1], 23.1);
  // still faces the target (south, -Z) from the shore
  const fz = sp.target[1] - sp.position[2];
  assert.ok(fz < 0, `target south of the stand: ${fz}`);
});
