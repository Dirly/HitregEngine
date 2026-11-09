// concept-scale: a synthetic painting (a known level camera with a shifted frame) is marked by projecting known points;
// the solve must give the camera and every size back, and paintingCamera must put the camera where it was.
import test from "node:test";
import assert from "node:assert/strict";
import { solve, measure, paintingCamera } from "./concept-scale.mjs";

const W = 1600, H = 900, F = 900, CAM_H = 3.2, SHIFT = -40; // horizon 40 px above the centre
const proj = ([x, y, z]) => [W / 2 + (F * x) / z, H / 2 + SHIFT + (F * (CAM_H - y)) / z]; // camera at height CAM_H, looking +z
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

const marks = {
  painting: "synthetic", horizon: H / 2 + SHIFT, vanish: [W / 2, H / 2 + SHIFT],
  figure: { head: proj([-1, 1.8, 9]), feet: proj([-1, 0, 9]), height: 1.8 },
  fov: { square: { near: [proj([-3, 0, 12]), proj([3, 0, 12])], far: [proj([-3, 0, 18]), proj([3, 0, 18])], ratio: 1 } },
  measures: [
    { key: "columnHeight", kind: "height", foot: proj([6, 0, 20]), top: proj([6, 13, 20]) },
    { key: "span", kind: "width", a: proj([-20, 0, 30]), b: proj([20, 0, 30]) },
    { key: "doorH", kind: "height", foot: proj([0, 1.2, 40]), top: proj([0, 9.2, 40]), ground: proj([0, 0, 40]) },
    { key: "bay", kind: "depth", a: proj([6, 0, 20]), b: proj([6, 0, 28]) },
    { key: "diag", kind: "floor", a: proj([0, 0, 10]), b: proj([3, 0, 14]) },
  ],
};

test("solve recovers the camera and the sizes exactly", () => {
  const r = solve(marks, [W, H]);
  near(r.camera.height, CAM_H, 1e-9, "camera height");
  near(r.camera.focal, F, 1e-6, "focal");
  near(r.camera.figureDistance, 9, 1e-6, "figure distance");
  near(r.camera.figureLateral, -1, 1e-6, "figure lateral");
  near(r.camera.pitchDeg, (Math.atan(-SHIFT / F) * 180) / Math.PI, 1e-9, "pitch");
  [13, 40, 8, 8, 5].forEach((want, i) => near(r.values[i], want, 1e-6, marks.measures[i].key));
});

test("measure brackets the true value and reports an uncertainty", () => {
  const r = measure({ ...marks, px: 3 }, [W, H]);
  const col = r.measures[0];
  assert.ok(col.lo <= 13 && col.hi >= 13 && col.unc > 0 && col.unc < 0.2, JSON.stringify(col));
  assert.equal(r.camera.height.m, 3.2);
});

test("paintingCamera stands the camera behind and above the figure", () => {
  const cam = solve(marks, [W, H]).camera;
  const s = paintingCamera(cam, { feet: [0, -12, -100], facing: 0 }); // the hall runs north (-z)
  near(s.camera[1], -12 + CAM_H, 0.01, "eye height");
  near(s.camera[2], -100 + 9, 0.01, "9 m behind (south of) the figure");
  near(s.camera[0], 1, 0.01, "the figure stands 1 m left of the view centre");
  assert.ok(s.target[2] < s.camera[2] && s.target[1] < s.camera[1], "looks north and a little down");
});
