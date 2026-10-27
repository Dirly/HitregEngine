// The one-water-level gate (quality.mjs measureWaterLevels): every plan.water body at one surface height.
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureWaterLevels, measureWaterRule } from "./quality.mjs";

test("one level: nothing off", () => {
  const m = measureWaterLevels({ water: [{ id: "a", surfaceZ: -4.6, x: [0, 10], y: [0, 10] }, { id: "b", surfaceZ: -4.61, x: [0, 2], y: [0, 2] }] });
  assert.equal(m.level, -4.6);
  assert.deepEqual(m.off, []);
});

test("bodies off the shared level are named (the level is the one most bodies share)", () => {
  const m = measureWaterLevels({ water: [
    { id: "flood", surfaceZ: -4.6, x: [0, 20], y: [0, 50] }, { id: "sump", surfaceZ: -4.6, x: [0, 5], y: [0, 5] },
    { id: "pool", surfaceZ: -8.2, x: [0, 23], y: [0, 23] }, { id: "channel", surfaceZ: -2.15, x: [0, 2], y: [0, 22] },
  ] });
  assert.equal(m.level, -4.6);
  assert.deepEqual(m.off.map((b) => b.id).sort(), ["channel", "pool"]);
});

test("no water: no level, nothing off", () => {
  assert.deepEqual(measureWaterLevels({}).off, []);
});

// 2026-10-25 owner rule: ONE STILL level at the BOTTOM — the lowest and static checks (measureWaterRule)
test("lowest: a body standing above a dry floor is named; a flooded room (its centre in a body at that height) is not", () => {
  const plan = {
    water: [{ id: "pool", surfaceZ: -1.9, x: [-42, -26], y: [47, 65] }, { id: "pot", surfaceZ: 2.95, x: [20, 25], y: [96.5, 101.5] }],
    spaces: [
      { id: "pool-room", floor: -2.6, centre: [-34, 56] }, // flooded: under the pool surface, centre inside the pool
      { id: "cave", floor: 0, centre: [0, 0] },            // dry but above the pool: fine
      { id: "stair-foot", floor: 2.5, centre: [16, 96] },  // dry and under the pot surface: the pot would run here
      { id: "tunnel", centre: [5, 5] },                    // no floor: not judged
    ],
  };
  const m = measureWaterRule(plan);
  assert.deepEqual(m.off.map((b) => b.id), ["pot"]);
  assert.deepEqual(m.dryBelow.map((d) => `${d.water}>${d.space}`).sort(), ["pot>cave", "pot>pool-room", "pot>stair-foot"]);
  assert.deepEqual(m.moving, []);
});

test("static: moving-water/waterfall tags, path water meshes and sloping water surfaces fail; a level pool plane passes", () => {
  const plan = { water: [{ id: "pool", surfaceZ: -1.9, x: [0, 10], y: [0, 10] }], spaces: [] };
  const ents = {
    pool: { tags: ["water"], components: { mesh: { source: { kind: "primitive", shape: "plane", size: [10, 1, 10] } } } },
    fall: { tags: ["moving-water"], components: { mesh: { source: { kind: "path", points: [[0, 20, 0], [0, 10, 1]] } } } },
    sheet: { tags: ["waterfall"], components: { mesh: { source: { kind: "surface", points: [[0, 5, 0], [1, 0, 0]] } } } },
    channel: { tags: ["water"], components: { mesh: { source: { kind: "path", points: [[0, 0, 0], [5, -1, 0]] } } } },
    slope: { tags: ["water"], components: { mesh: { source: { kind: "surface", points: [[0, 0, 0], [4, 0, 0], [4, 0.6, 4], [0, 0.6, 4]] } } } },
    flat: { tags: ["water"], components: { mesh: { source: { kind: "surface", points: [[0, 0, 0], [4, 0, 0], [4, 0.02, 4], [0, 0.02, 4]] } } } },
    rock: { tags: ["static"], components: { mesh: { source: { kind: "path", points: [[0, 0, 0], [1, 1, 1]] } } } },
  };
  const m = measureWaterRule(plan, ents);
  assert.deepEqual(m.moving.map((x) => x.id).sort(), ["channel", "fall", "sheet", "slope"]);
  assert.deepEqual(m.dryBelow, []);
});
