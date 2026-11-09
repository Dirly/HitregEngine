import { test } from "node:test";
import assert from "node:assert/strict";
import { circleLine, kitWallFindings, layKitWall, STRAND_WALL, worldFootprint, type V2 } from "../tools/_kit-wall.mts";

test("an r 57 ring with 12 towers: every piece joins, no gap over 5 cm, no overlap", () => {
  const ring = circleLine(57, 12, [100, -40]);
  const lay = layKitWall(ring, { closed: true, towers: [...Array(12).keys()] });
  const f = kitWallFindings(lay, { closed: true });
  assert.deepEqual(f, []);
  assert.equal(lay.pieces.filter((p) => p.kind === "tower").length, 12);
  assert.equal(lay.pieces.filter((p) => p.kind === "kink").length, 12);
  assert.ok(lay.pieces.every((p) => p.kind !== "kink" || p.prefab.endsWith("-in-30")), "a convex 12-gon turns 30 deg inward at every vertex");
  // the parapet (local +z) faces away from the ring's centre on every run
  for (const p of lay.pieces.filter((q) => q.kind === "run" || q.kind === "infill")) {
    const out: V2 = [Math.sin(p.yaw * Math.PI / 180), Math.cos(p.yaw * Math.PI / 180)];
    const rad: V2 = [p.at[0] - 100, p.at[1] + 40];
    assert.ok(out[0] * rad[0] + out[1] * rad[1] > 0, `${p.prefab} parapet faces the field`);
  }
});

test("the same ring walked the other way, and a dense 40-gon (6-12 deg turns), still close", () => {
  const ring = circleLine(57, 12).reverse();
  assert.deepEqual(kitWallFindings(layKitWall(ring, { closed: true, towers: [0, 3, 6, 9] }), { closed: true }), []);
  const dense = circleLine(80, 40);
  assert.deepEqual(kitWallFindings(layKitWall(dense, { closed: true, towers: [0, 10, 20, 30] }), { closed: true }), []);
});

test("an irregular curve: bearings off the 2 deg grid are re-aimed per leg, legs closed by least squares", () => {
  const blob: V2[] = Array.from({ length: 24 }, (_, i) => { const a = (2 * Math.PI * i) / 24; const j = [0.4, -1.1, 0.7, 1.3, -0.6, 0.2][i % 6]!; return [(70 + j) * Math.cos(a), (50 - j) * Math.sin(a)]; });
  const lay = layKitWall(blob, { closed: true, towers: [0, 6, 12] });
  assert.deepEqual(kitWallFindings(lay, { closed: true }), []);
  // a turn sharper than the kinks is refused by name, never laid with a hole
  const sharp = layKitWall([[0, 0], [40, 0], [40 + 30 * Math.cos(-1.0), 30 * Math.sin(-1.0)]], { closed: false });
  assert.ok(sharp.notes.some((x) => /5[78] deg turn toward the town has no piece/.test(x)), sharp.notes.join("; "));
});

test("a 90 deg inward turn takes the corner piece; an open line ends on its tower", () => {
  const line: V2[] = [[0, 0], [60, 0], [60, -50]];
  const lay = layKitWall(line, { closed: false, towers: [2] });
  assert.ok(lay.pieces.some((p) => p.kind === "corner"));
  assert.deepEqual(kitWallFindings(lay, { closed: false }), []);
});

test("the check fails a gap and an overlap", () => {
  const lay = layKitWall(circleLine(57, 12), { closed: true, towers: [0, 4, 8] });
  const run = lay.pieces.find((p) => p.kind === "run")!;
  const moved = { ...lay, pieces: lay.pieces.map((p) => (p === run ? { ...p, at: [p.at[0] + 0.3 * Math.cos(-p.yaw * Math.PI / 180), p.at[1] + 0.3 * Math.sin(-p.yaw * Math.PI / 180)] as V2 } : p)) };
  const f = kitWallFindings(moved, { closed: true });
  assert.ok(f.some((x) => x.startsWith("gap:")), f.join("\n"));
  assert.ok(f.some((x) => x.startsWith("overlap:")), f.join("\n"));
  // footprints have the wall thickness
  const fp = worldFootprint(run)[0]!;
  assert.ok(Math.abs(Math.hypot(fp[3]![0] - fp[0]![0], fp[3]![1] - fp[0]![1]) - STRAND_WALL.thick) < 1e-9);
});

test("a gatehouse is centred on a straight-through vertex and the runs butt its side faces", () => {
  // a 16-gon with a mid-leg vertex inserted for the gate (no turn there)
  const ring = circleLine(57, 16);
  const a = ring[0]!, b = ring[1]!;
  const line: V2[] = [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ...ring.slice(1)];
  const lay = layKitWall(line, { closed: true, gates: [1], towers: [4, 10] });
  assert.deepEqual(kitWallFindings(lay, { closed: true }), []);
  const g = lay.pieces.filter((p) => p.kind === "gate");
  assert.equal(g.length, 1);
  const off = Math.hypot(g[0]!.at[0] - line[1]![0], g[0]!.at[1] - line[1]![1]);
  assert.ok(off < 0.5, `centred on its vertex (the bearings are re-aimed to the 2 deg grid, so the vertex moves a little): ${off}`);
  // a gate on a turning vertex is refused by name
  const bad = layKitWall(ring, { closed: true, gates: [3] });
  assert.ok(bad.notes.some((x) => /gatehouse needs a straight-through vertex/.test(x)), bad.notes.join("; "));
});
