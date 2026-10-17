// node --test tools/mesh-dc/thin-walls.test.mjs
// The thin-walls pre-bake gate: a room shell thinner than 3 voxels fails; a thick one passes; a thin plank, shelf
// or hull standing INSIDE the room (a room on both sides) passes by construction; a thin piece tagged plank/decal/
// hull-skin (or dc_thin_ok) is exempt even where it looks out of the map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { thinWallsGate, EXEMPT_NAMES } from "./thin-walls.mjs";

/** One axis-aligned box as a closed solid (outward winding) appended to a stamp mesh. */
function addBox(mesh, [x0, y0, z0], [x1, y1, z1], name = "stone") {
  const o = mesh.positions.length / 3;
  for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) mesh.positions.push(x, y, z);
  // v = x + 2y + 4z
  const q = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  for (const [a, b, c, d] of q) mesh.indices.push(o + a, o + b, o + c, o + a, o + c, o + d);
  mesh.solidTriangleCounts.push(12);
  mesh.solidObjects.push(name);
}
/** A closed 8 x 3 x 6 m room of six slabs, the east wall `east` thick, the rest `t`. */
function room(t, east = t) {
  const m = { name: "room", positions: [], indices: [], solidTriangleCounts: [], solidObjects: [] };
  addBox(m, [-t, -t, -t], [8 + t, 0, 6 + t], "floor");
  addBox(m, [-t, 3, -t], [8 + t, 3 + t, 6 + t], "roof");
  addBox(m, [-t, 0, -t], [0, 3, 6 + t], "wall-w");
  addBox(m, [8, 0, -t], [8 + east, 3, 6 + t], "wall-e");
  addBox(m, [0, 0, -t], [8, 3, 0], "wall-s");
  addBox(m, [0, 0, 6], [8, 3, 6 + t], "wall-n");
  return m;
}
const gate = (meshes, opts = {}) => thinWallsGate({ meshes }, { voxel: 0.12, ...opts });

test("a shell under 3 voxels fails, with where it is", () => {
  const r = gate([room(0.5, 0.2)]);
  assert.equal(r.passed, false);
  const g = r.groups.room;
  assert.ok(g.minThickness > 0.19 && g.minThickness < 0.21, String(g.minThickness));
  assert.ok(g.spots.every((s) => s.at[0] > 7.9 && s.at[0] < 8.3), JSON.stringify(g.spots.slice(0, 3)));
  assert.equal(g.spots[0].object, "wall-e");
  assert.match(r.failures[0].what, /room: .* m2 of shell under 3 voxels/);
});

test("a shell of 3 voxels or more passes", () => {
  assert.equal(gate([room(0.36)]).passed, true);
  assert.equal(gate([room(0.5)]).passed, true);
});

test("thin pieces standing inside the room pass (a room on both sides)", () => {
  const m = room(0.5);
  addBox(m, [2, 1, 2], [5, 1.04, 3], "shelf");          // a 4 cm shelf
  addBox(m, [3, 0, 4], [3.05, 2.2, 5.5], "partition");  // a 5 cm screen
  const r = gate([m]);
  assert.equal(r.passed, true, JSON.stringify(r.failures));
  assert.ok(r.groups.room.interiorThinArea > 1, "the shelf and the screen are thin, but interior");
  // --all (the old diagnostic) still counts them
  assert.equal(gate([m], { all: true }).passed, false);
});

test("the shell test sees every group: a thin wall backed by a neighbour group is not a shell", () => {
  const a = room(0.5, 0.1);
  const b = { name: "annex", positions: [], indices: [], solidTriangleCounts: [], solidObjects: [] };
  addBox(b, [8.1, -0.5, -0.5], [12, 3.5, 6.5], "annex-rock"); // solid rock right behind the thin east wall
  assert.equal(gate([a, b]).passed, true);
  assert.equal(gate([a]).passed, false);
});

test("tagged standalone thin pieces are exempt: plank, decal, hull skin, dc_thin_ok, --exempt", () => {
  for (const n of ["wreck.plank.3", "hull-skin", "decal_painted_01", "flat-art slab", "herald.planks.12"]) assert.ok(EXEMPT_NAMES.test(n), n);
  for (const n of ["crypt.wall.2", "vault", "second-king.voussoir.3", "skinner-hall.wall.1"]) assert.ok(!EXEMPT_NAMES.test(n), n);
  const m = room(0.5);
  addBox(m, [-3, 0, 2], [-2.98, 2, 3], "door.plank.1"); // a plank leaning outside, open to the void
  assert.equal(gate([m]).passed, true);
  const k = room(0.5);
  addBox(k, [-3, 0, 2], [-2.98, 2, 3], "sign");
  assert.equal(gate([k]).passed, false);
  k.solidThinOk = k.solidObjects.map((n) => (n === "sign" ? 1 : 0));
  assert.equal(gate([k]).passed, true);
  delete k.solidThinOk;
  assert.equal(gate([k], { exempt: /^sign$/ }).passed, true);
});

test("a face buried inside another solid (overlapping walls at a corner) is no surface: it passes", () => {
  // a 0.4 m pier wholly inside the west wall's corner: its faces are buried, the bake never sees them
  const m = room(0.5);
  addBox(m, [-0.45, 0, -0.45], [-0.05, 3, -0.05], "wall-w-pier");
  const r = gate([m], { voxel: 0.15 });
  assert.equal(r.passed, true, JSON.stringify(r.failures));
  // a 0.4 m slab standing apart outside the room is still a thin shell
  const n = room(0.5);
  addBox(n, [-2, 0, 1], [-1.6, 3, 2], "wall-w-fin");
  assert.equal(gate([n], { voxel: 0.15 }).passed, false);
});
