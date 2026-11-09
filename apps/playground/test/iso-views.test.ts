// place-build iso overviews (tools/_iso-views.mts, Derek 2026-10-31): iso-ne / iso-sw are made, framed to the footprint
// (every footprint point + margin inside the frame), first in views.json, noon only, and never judged by the wash.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isoViews, jobIsoViews, withIsoViews, ISO_ASPECT, ISO_MARGIN_M } from "../tools/_iso-views.mts";
import { isReviewShot, judgeRun } from "../tools/_light-wash.mts";

type V2 = [number, number];
type V3 = [number, number, number];

/** Project a world point through a lookAt camera with vertical FOV `fov` deg -> NDC [x, y] (|v| <= 1 = in frame). */
function ndc(cam: V3, target: V3, fov: number, p: V3): [number, number] {
  const f = [target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]], fl = Math.hypot(...f); const F = f.map((v) => v / fl);
  const R = [-F[2]!, 0, F[0]!], rl = Math.hypot(...R); const Rn = R.map((v) => v / rl); // right = F x up
  const U = [Rn[1]! * F[2]! - Rn[2]! * F[1]!, Rn[2]! * F[0]! - Rn[0]! * F[2]!, Rn[0]! * F[1]! - Rn[1]! * F[0]!];
  const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]], z = d[0]! * F[0]! + d[1]! * F[1]! + d[2]! * F[2]!;
  const tv = Math.tan(((fov / 2) * Math.PI) / 180);
  return [(d[0]! * Rn[0]! + d[1]! * Rn[1]! + d[2]! * Rn[2]!) / z / (tv * ISO_ASPECT), (d[0]! * U[0]! + d[1]! * U[1]! + d[2]! * U[2]!) / z / tv];
}

const foot: V2[] = [[100, 200], [160, 200], [160, 230], [100, 230], [130, 260]];

test("iso views: iso-ne and iso-sw, opposite diagonals, 35 deg up, narrow FOV, noon only, review-only", () => {
  const v = isoViews(foot, 50);
  assert.deepEqual(v.map((x) => x.name), ["iso-ne", "iso-sw"]);
  for (const x of v) {
    assert.equal(x.review, true); assert.deepEqual(x.times, [12]); assert.ok(x.fov >= 20 && x.fov <= 25);
    const dx = x.camera[0] - x.target[0], dz = x.camera[2] - x.target[2], up = x.camera[1] - x.target[1];
    assert.ok(Math.abs((Math.atan2(up, Math.hypot(dx, dz)) * 180) / Math.PI - 35) < 0.5, "35 deg elevation");
    assert.equal(x.target[1], 50);
  }
  const [ne, sw] = v as [any, any];
  assert.ok(ne.camera[0] > ne.target[0] && ne.camera[2] < ne.target[2], "iso-ne camera NE of the place (north = -Z)");
  assert.ok(sw.camera[0] < sw.target[0] && sw.camera[2] > sw.target[2], "iso-sw camera SW of the place");
});

test("iso views: framed to the footprint (every point + margin in frame, and the frame not much larger)", () => {
  for (const x of isoViews(foot, 50)) {
    let maxX = 0, maxY = 0;
    for (const p of foot) for (const [ox, oz] of [[0, 0], [ISO_MARGIN_M, 0], [-ISO_MARGIN_M, 0], [0, ISO_MARGIN_M], [0, -ISO_MARGIN_M]] as V2[]) {
      const [nx, ny] = ndc(x.camera, x.target, x.fov, [p[0] + ox, 50, p[1] + oz]);
      assert.ok(Math.abs(nx) <= 1 && Math.abs(ny) <= 1, `${x.name}: ${p} + margin in frame (${nx.toFixed(2)}, ${ny.toFixed(2)})`);
      maxX = Math.max(maxX, Math.abs(nx)); maxY = Math.max(maxY, Math.abs(ny));
    }
    assert.ok(Math.max(maxX, maxY) > 0.7, `${x.name}: the place fills the frame (${maxX.toFixed(2)}, ${maxY.toFixed(2)})`);
  }
  // a bigger place sits farther away
  const big = isoViews(foot.map(([x, z]) => [x * 3, z * 3] as V2), 50)[0]!, small = isoViews(foot, 50)[0]!;
  assert.ok(Math.hypot(big.camera[0] - big.target[0], big.camera[2] - big.target[2]) > Math.hypot(small.camera[0] - small.target[0], small.camera[2] - small.target[2]) * 2);
});

test("iso views go FIRST in views.json and replace older iso-* entries", () => {
  const iso = isoViews(foot, 50);
  const r = withIsoViews([{ name: "core-close", x: 1, z: 2 }, { name: "iso-ne", x: 0, z: 0 }, { name: "aerial-150", x: 1, z: 2 }], iso);
  assert.deepEqual(r.views.map((v) => v.name), ["iso-ne", "iso-sw", "core-close", "aerial-150"]);
  assert.equal(r.changed, true);
  assert.equal(withIsoViews(r.views, iso).changed, false);
});

test("jobIsoViews reads a job's footprint (areas, built entities, operators), pad height and aerial body", () => {
  const J = fs.mkdtempSync(path.join(os.tmpdir(), "iso-job-"));
  try {
    const w = (f: string, d: unknown) => { fs.mkdirSync(path.dirname(path.join(J, f)), { recursive: true }); fs.writeFileSync(path.join(J, f), JSON.stringify(d)); };
    w("handoff.json", { siteDressing: { areas: [{ id: "core", centre: [730, -140], radius: 23 }] } });
    w("ops.json", [{ op: "add-entity", id: "root", entity: { parent: null, components: { transform: { position: [730, 63.7, -140] } } } }, { op: "add-entity", id: "house", entity: { parent: "root", components: { transform: { position: [0, 0.8, 12] } } } }]);
    w("operators.json", [{ op: "wall", id: "dyke", points: [[751, -157], [768, -157], [768, -124]] }]);
    w("reports/plan.json", { padY: 63.68, pockets: [{ id: "core", at: [730, -140] }] });
    w("views.json", [{ name: "aerial-150", x: 730, z: -148 }]);
    const v = jobIsoViews(J);
    assert.deepEqual(v.map((x) => x.name), ["iso-ne", "iso-sw"]);
    assert.equal(v[0]!.target[1], 63.68); assert.equal(v[0]!.x, 730); assert.equal(v[0]!.z, -148);
    for (const x of v) { const [nx, ny] = ndc(x.camera, x.target, x.fov, [768, 63.68, -157]); assert.ok(Math.abs(nx) <= 1 && Math.abs(ny) <= 1, "the dyke corner is in frame"); }
  } finally { fs.rmSync(J, { recursive: true, force: true }); }
});

test("iso views are excluded from the wash: isReviewShot, and judgeRun never reads their frames", async () => {
  assert.equal(isReviewShot({ spot: "iso-ne" }), true);
  assert.equal(isReviewShot({ name: "core-close", review: true }), true);
  assert.equal(isReviewShot({ spot: "core-close" }), false);
  assert.equal(isReviewShot({ spot: "iso-ne@12" }), true); // a blackFrames entry
  const D = fs.mkdtempSync(path.join(os.tmpdir(), "iso-wash-"));
  try {
    // the run names only an iso frame whose file does not exist: judged, it would throw
    fs.writeFileSync(path.join(D, "run.json"), JSON.stringify({ shots: [{ spot: "iso-ne", review: true, time: 12, file: "missing/iso-ne-12.png", fires: [{ x: 1, y: 1, d: 400 }] }] }));
    const r = await judgeRun(path.join(D, "run.json"));
    assert.equal(r.frames.length, 0); assert.equal(r.wantFireRead, false);
  } finally { fs.rmSync(D, { recursive: true, force: true }); }
});
