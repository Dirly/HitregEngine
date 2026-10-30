import { test } from "node:test";
import assert from "node:assert/strict";
import { groundNeedSchema } from "@hitreg/core";
import { measureRib, needArea, solveRoadsideRib, type NeedGround } from "../tools/site-needs.mts";

// 2026-10-29 redstrand w9: dropped-hour sat on a flat road; its roadside-rib need first came out as a smooth 11 m dome
// (a 12 m feather inside a 30 m box, a 2.2 face, a 45 deg back). The rib must be a long ridge with a broken face of
// >= 60 deg toward the road (the slope that paints the cliff tile) and a gentler back.
test("roadside-rib: a long ridge with a steep broken road face, measured as a face and not a mound", () => {
  // flat ground at 50 m, a straight east-west road through the origin, the land rising gently to the north
  const natural = (x: number, z: number) => 50 + Math.max(0, -z) * 0.02;
  const flat: NeedGround = { height: natural, wet: () => false, sea: 0, roads: [{ id: "road", points: [[-200, 0], [200, 0]] }] };
  const need = groundNeedSchema.parse({ id: "rib", kind: "roadside-rib", near: [0, 0], within: 60, minHeight: 12, width: 40, apron: 7 });
  const s = solveRoadsideRib(flat, need, needArea(need.near, need.within, []));
  assert.ok(s.ok && s.patch, s.message);
  // the rising side (north, -z): the face looks south toward the road
  assert.equal(s.faces, 180);
  const p = s.patch!;
  assert.ok(p.blend <= 4, `feather ${p.blend} m`);
  // the raster drawn over the ground (bilinear, weights: raise-only) is what the measure reads
  const [ox, oz] = p.origin, [sx, sz] = p.size, cols = p.columns, rows = p.rows;
  const raster = (x: number, z: number): number => {
    const fx = ((x - ox) / sx) * (cols - 1), fz = ((z - oz) / sz) * (rows - 1);
    if (fx < 0 || fz < 0 || fx > cols - 1 || fz > rows - 1) return natural(x, z);
    const i = Math.min(cols - 2, Math.floor(fx)), j = Math.min(rows - 2, Math.floor(fz)), u = fx - i, v = fz - j;
    const h = (a: number, b: number) => (p.weights![b * cols + a]! > 0 ? p.heights[b * cols + a]! : natural(ox + (a / (cols - 1)) * sx, oz + (b / (rows - 1)) * sz));
    return Math.max(natural(x, z), h(i, j) * (1 - u) * (1 - v) + h(i + 1, j) * u * (1 - v) + h(i, j + 1) * (1 - u) * v + h(i + 1, j + 1) * u * v);
  };
  const solved = { ...need, solved: { at: s.at, faces: s.faces, height: s.height, patch: p.id, raised: s.raised, ran: "now" } };
  const m = measureRib({ ...flat, height: raster }, solved);
  assert.ok(m.met, m.message);
  assert.ok(Number(m.numbers.steepFace) >= 12 * 0.6, m.message);
  // a long ridge, not a dome: full height holds along most of its 40 m
  const crestZ = s.at[1] - 12 / 3 - 4;
  const along = [-14, -7, 0, 7, 14].map((x) => raster(x, crestZ) - 50);
  assert.ok(along.every((h) => h > 12 * 0.6), along.join(", "));
  // the back is gentler than the face
  const back = (raster(0, crestZ - 6) - raster(0, crestZ - 12)) / 6;
  assert.ok(Math.abs(back) < 1, `back rise/run ${back}`);
  // the old dome fails the face measure: the same height on a 45 deg mound
  const dome = (x: number, z: number) => 50 + Math.max(0, 12 - Math.hypot(x, z - crestZ) * 0.8);
  assert.equal(measureRib({ ...flat, height: dome }, solved).met, false);
});
