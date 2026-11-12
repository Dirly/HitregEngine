// Place = fit (tools/_contact.mts, tools/_structure-fit.mts): contacts prove against real triangles, misses reject, the
// shoring fitter measures a tunnel and only accepts a frame whose every contact lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { surfaces, type SurfaceTri, type V3 } from "../tools/_contact.mts";
import { fitSpots, measureHeadTree, measureShoring, type Job } from "../tools/_structure-fit.mts";

/** an axis-aligned box's six faces, normals pointing INTO the box (a tunnel: the air is inside) */
function tunnel(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): SurfaceTri[] {
  const q = (a: V3, b: V3, c: V3, d: V3): SurfaceTri[] => [{ a, b, c, owner: "rock" }, { a, b: c, c: d, owner: "rock" }];
  return [
    ...q([x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]), // floor, normal +y
    ...q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]), // roof, normal -y
    ...q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), // left wall, normal +x
    ...q([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]), // right wall, normal -x
  ];
}

test("prove: an anchor on a surface is met, one short of it or deep inside is missed with the reason", () => {
  const S = surfaces(tunnel(-5, 5, 0, 8, -20, 20));
  const p = S.prove([{ id: "on", at: [0, 0.02, 0] }, { id: "embedded", at: [0, -0.08, 0] }, { id: "short", at: [0, 0.3, 0] }, { id: "deep", at: [0, -0.4, 0] }]);
  assert.equal(p.ok, false);
  assert.deepEqual(p.contacts.map((c) => c.id), ["on", "embedded"]);
  assert.deepEqual(p.missed.map((m) => m.id), ["short", "deep"]);
  assert.match(p.missed[0]!.why, /short/);
});

test("prove: terrain counts as a surface where there is no mesh", () => {
  const S = surfaces([], { ground: () => 2 });
  assert.equal(S.prove([{ id: "foot", at: [3, 2.03, 3] }]).ok, true);
  assert.equal(S.prove([{ id: "foot", at: [3, 2.5, 3] }]).ok, false);
});

test("ray: first hit up, down and sideways", () => {
  const S = surfaces(tunnel(-5, 5, 0, 8, -20, 20));
  assert.equal(Math.round(S.ray([0, 1, 0], [0, 1, 0], 20)!.p[1] * 100) / 100, 8);
  assert.equal(Math.round(S.ray([0, 1, 0], [0, -1, 0], 20)!.p[1] * 100) / 100, 0);
  assert.equal(Math.round(S.ray([0, 1, 0], [1, 0, 0], 20)!.t * 100) / 100, 5);
});

test("measureShoring: a 10 m tunnel 8 m high measures in range; an open hall is rejected", () => {
  const S = surfaces(tunnel(-5, 5, 0, 8, -20, 20));
  const m = measureShoring(S, [1, 0, 0], 0, { id: "f", piece: "shoring", at: [1, 0, 0] });
  assert.ok(!("why" in m), JSON.stringify(m));
  if ("why" in m) return;
  assert.equal(m.origin[0], 0); // centred between the walls, not on the asked spot
  assert.equal(m.args[1], "8.9"); // 10 m clear less 0.15 + 0.4 each side
  const wide = surfaces(tunnel(-30, 30, 0, 8, -20, 20));
  const r = measureShoring(wide, [0, 0, 0], 0, { id: "g", piece: "shoring", at: [0, 0, 0] });
  assert.ok("why" in r && /no rock wall/.test(r.why));
});

test("fitSpots: a stretched frame is placed only when every contact lands; a fixed piece that misses is rejected", () => {
  const S = surfaces(tunnel(-5, 5, 0, 8, -20, 20));
  // a stand-in kit fitter: posts at +-(W/2 + 0.4) on the floor, cribbing contacts at the measured roof
  const kitFit = (_k: string, id: string, args: string[]) => {
    const W = Number(args[1]), X = W / 2 + 0.4;
    return { prefabId: `fit/${id}`, shift: [0, 0, 0] as V3, job: { kind: "carries-roof", contacts: [{ what: "roof", at: [-X, 8, 0] }, { what: "roof", at: [X, 8, 0] }, { what: "floor", at: [-X, 0, 0] }, { what: "floor", at: [X, 0, 0] }] } as Job };
  };
  const jobs = new Map<string, Job>([["kit/walkway", { kind: "spans", contacts: [{ what: "support", at: [0, 0, -3.6] }, { what: "support", at: [0, 0, 3.6] }] }], ["kit/high-beam", { kind: "spans", contacts: [{ what: "support", at: [0, 3, -3.6] }, { what: "support", at: [0, 3, 3.6] }] }]]);
  const res = fitSpots(S, [
    { id: "frame", piece: "shoring", at: [0, 0, 0] },
    { id: "walk", piece: "kit/walkway", at: [0, 0, 0] },
    { id: "beam", piece: "kit/high-beam", at: [0, 0, 0], search: false },
  ], jobs, kitFit);
  assert.deepEqual(res.placed.map((p) => p.id), ["frame", "walk"]);
  assert.equal(res.rejected[0]!.id, "beam");
  assert.ok(res.rejected[0]!.missed!.length === 2);
});

test("measureHeadTree: one trunk stands against the chosen wall, its cap turned along the wall", () => {
  const S = surfaces(tunnel(-5, 5, 0, 8, -20, 20));
  const m = measureHeadTree(S, [0, 0, 0], 0, { id: "h", piece: "head-tree", at: [0, 0, 0], side: "left" });
  assert.ok(!("why" in m), JSON.stringify(m));
  if ("why" in m) return;
  assert.ok(m.origin[0] < -3 && m.origin[0] > -4.5, String(m.origin[0])); // 1.3 m-girth trunk off the left wall at x -5
  assert.equal(Math.round((m.yaw * 180) / Math.PI), 90);
  assert.ok(m.args.includes("--capped"));
});
