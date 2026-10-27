import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLandmarkMesh, compileLandmarkOperator, wallLandmarkParams, type OperatorFieldReader } from "@hitreg/core";
import { columnBottom, wallSeatOf } from "../tools/_wall-seated.mts";

// a palisade (the Reedholt shape) climbing a lumpy slope: 0.35 m ripples every ~3.7 m ride a 0.3 rise per metre, so the
// ground dips between the wall's 1 m stations and the drawn 2 m lattice sags under the field on every crest
const field = (x: number, z: number) => 10 + 0.3 * x + 0.35 * Math.sin(x * 1.7) + 0.2 * Math.cos(z * 1.3);
const lattice = (x: number, z: number, v = 2) => {
const x0 = Math.floor(x / v) * v, z0 = Math.floor(z / v) * v, u = (x - x0) / v, w = (z - z0) / v;
return (field(x0, z0) * (1 - u) + field(x0 + v, z0) * u) * (1 - w) + (field(x0, z0 + v) * (1 - u) + field(x0 + v, z0 + v) * u) * w;
};
const drawnGround = (x: number, z: number) => Math.min(field(x, z), lattice(x, z));
const reader = (h = field): OperatorFieldReader => ({ height: h, voxelSize: 2, seaLevel: 0, seed: 7 });
const palisade = {
  variant: "free", scale: "human", face: "left", smooth: false, points: [[0, 0], [40, 6], [60, 30]],
height: 3.6, heightMode: "follow", thickness: 0.6, batter: 0, cap: null, footing: { depth: 0.6, projection: 0.5, plinth: 0.35 },
openings: [{ name: "gate", at: 30, width: 4.6, height: 3, arch: false }],
ends: { start: "terrain", end: "pier", pierProjection: 0.3, pierRise: 0.5 }, irregularity: { height: 0.35, lean: 1.2, thickness: 0.05, segment: 1.6 },
};

test("a wall on a lumpy slope is seated on the DRAWN ground in every <= 4 m segment (no daylight under it)", () => {
  const r = wallSeatOf("pal", palisade, reader(), drawnGround);
  assert.ok(r.samples > 100);
  assert.ok(r.segments.length >= Math.ceil(r.length / 4) - 1, "one segment per <= 4 m (the gate span has none)");
  for (const s of r.segments) assert.ok(s.to - s.from <= 4.01);
  assert.equal(r.bad, 0, JSON.stringify(r.segments.filter((s) => s.gap > 0.05)));
  assert.equal(r.ok, true);
  // a buried skirt: the foot runs >= 0.5 m under the lowest drawn ground along the whole line
  assert.ok(r.worst <= -0.5, `worst ${r.worst}`);
});

test("fails the segment where the ground was lowered after the wall was built (stale wall, daylight under it)", () => {
  // built on the ground as it was; a 1.2 m drain dug under 18..22 m of the first leg afterwards
  const dug = (x: number, z: number) => drawnGround(x, z) - (x > 18 && x < 22 && z < 6 ? 1.2 : 0);
  const r = wallSeatOf("pal", palisade, reader(), dug);
  assert.equal(r.ok, false);
  const bad = r.segments.filter((s) => s.gap > 0.05);
  assert.ok(bad.length >= 1);
  for (const s of bad) assert.ok(s.at[0] > 17 && s.at[0] < 23, `fault at ${s.at}`);
});

test("keeps the declared gate opening clear: nothing under the lintel within the opening, the posts either side seated", () => {
  const p = wallLandmarkParams(palisade, reader(), { id: "pal" });
  const c = compileLandmarkOperator(p, reader(), { id: "pal" })!;
  const b = buildLandmarkMesh(c.compiled);
  const pos: number[] = [], idx: number[] = [];
  for (const g of b.groups) { const base = pos.length / 3; for (let v = 0; v < g.vertexCount; v++) pos.push(g.positions[v * 3]! + c.at[0], g.positions[v * 3 + 1]! + (c.footY ?? 0), g.positions[v * 3 + 2]! + c.at[1]); for (const i of g.indices) idx.push(i + base); }
  const bottom = columnBottom(pos, idx);
  // the gate at s = 30 on the first leg (length ~40.4): its centre and +-1.5 m (clear of the footing returning 0.5 m round
// the reveals) are open to >= 2.5 m over the ground
  const L0 = Math.hypot(40, 6), dir = [40 / L0, 6 / L0];
  for (const ds of [-1.5, 0, 1.5]) {
    const x = dir[0]! * (30 + ds), z = dir[1]! * (30 + ds);
    const yb = bottom(x, z);
    if (yb !== null) assert.ok(yb - drawnGround(x, z) > 2.5, `gate column ${ds}: ${yb}`);
  }
  for (const ds of [-3, 3]) {
    const x = dir[0]! * (30 + ds), z = dir[1]! * (30 + ds);
    const yb = bottom(x, z);
    assert.notEqual(yb, null);
    assert.ok(yb! - drawnGround(x, z) < 0, `post ${ds} seated`);
  }
});
