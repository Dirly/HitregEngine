import { test } from "node:test";
import assert from "node:assert/strict";
import { approachView, conceptBrief, farView, measureSite, nearObstacle, nearWall, NEAR_WALL_MAX, paintingCamera, readDistance, type View } from "../tools/_concept-site.mts";

// a site at the origin on a flat floor: a 30 m cliff rising north of it (z < -20), a 25 m hill across the road at
// x 190..230, the sea south of z 400
const ground = {
  height: (x: number, z: number) => (z < -20 ? Math.min(30, (-20 - z) * 3) : 0) + (x > 190 && x < 230 ? 25 : 0) - (z > 400 ? 3 : 0),
  waterY: (_x: number, z: number) => (z > 400 ? 0 : null),
};
const road: [number, number][] = [[600, 0], [300, 0], [20, 0]];

test("the site's numbers: the cliff behind it, the apron in front, the water", () => {
  const fit = measureSite(ground, [0, 0], 50, 120);
  assert.ok(fit.face && fit.face.height >= 28 && fit.face.height <= 30.5, `face ${JSON.stringify(fit.face)}`);
  assert.ok(Math.abs(((fit.face!.bearing + 180) % 360) - 180) <= 12, `cliff is north: ${fit.face!.bearing}`);
  assert.ok(fit.apronM2 > 4000 && fit.apronM2 < Math.PI * 50 * 50, `apron ${fit.apronM2}`);
  assert.equal(fit.water.nearest, null, "no water within 120 m");
  assert.ok(fit.relief >= 25, `relief ${fit.relief}`);
});

test("first sight on the road: the farthest point a 12 m mark reads, not behind the hill", () => {
  const v = approachView(ground, [0, 0], 12, readDistance("medium", false), [road], []);
  assert.ok(v.px >= 16, v.note);
  assert.ok(v.from >= 185 && v.from <= 232, `first sight at ${v.from} m (${v.note})`);
  assert.ok(Math.abs(v.eye[1] - (ground.height(v.eye[0], v.eye[2]) + 1.7)) < 1e-6, "player height");
  assert.match(v.note, /first sight/);
});

test("the far view stands at least the read distance out, on dry ground, and says when it had to rise", () => {
  const R = readDistance("pinpoint", true);
  assert.equal(R, 300, "an entrance reads from 300 m whatever its tier");
  const v = farView(ground, [0, 0], 20, R, [210, 0]);
  assert.ok(v.from >= R, `far ${v.from}`);
  assert.equal(ground.waterY(v.eye[0], v.eye[2]), null, "not standing in the sea");
  assert.ok(v.visible >= 3, v.note);
});

test("the repaint brief fixes the ground and carries the measured face", () => {
  const fit = measureSite(ground, [0, 0], 50, 120);
  const b = conceptBrief({ name: "The Rime Door", premise: "A giant-height cleft in the corrie wall breathing cold fog." }, fit, 20);
  assert.match(b, /FIXED/);
  assert.match(b, /Do not raise, deepen, widen or add cliffs/);
  assert.ok(b.includes(`${fit.face!.height} m`), b);
});

test("a town's NEAR set: gate on the road outside the wall, street and square inside, stakes on the plan", async () => {
  const { townStakePlan, townNearViews, stakeLines, seenOverGround, GATE_VIEW_M } = await import("../tools/_concept-site.mts");
  const flat = { height: () => 10, waterY: () => null };
  // the road comes in from the east and ends at the centre
  const plan = townStakePlan(flat, [0, 0], 45, [[0, 0], [200, 0]]);
  assert.ok(Math.abs(Math.hypot(...plan.gate) - 45) < 1.5 && plan.gate[0] > 0, `gate on the ring where the road crosses it: ${plan.gate}`);
  assert.ok(plan.out[0] > 0.99, "outward along the road");
  assert.ok(plan.stakes.some((s) => s.kind === "wall") && plan.stakes.some((s) => s.kind === "gatehouse"));
  const lots = plan.stakes.filter((s) => s.kind === "lot");
  assert.ok(lots.length >= 6, `lots ${lots.length}`);
  assert.ok(lots.every((l) => l.points.every((p) => Math.hypot(...p) <= 42)), "every lot inside the wall");
  const [gate, street, square] = townNearViews(flat, plan);
  const d = (v: { eye: number[] }) => Math.hypot(v.eye[0]!, v.eye[2]!);
  assert.equal(gate!.name, "gate");
  assert.ok(d(gate!) > 45 + 35 && d(gate!) < 45 + 75, `gate eye 40-70 m out from the gate: ${d(gate!)}`);
  assert.ok(GATE_VIEW_M.includes(gate!.from), `from ${gate!.from}`);
  assert.ok(d(street!) < 45 && d(square!) < 45, "street and square eyes inside the wall");
  for (const v of [gate!, street!, square!]) assert.ok(Math.abs(v.eye[1] - 11.7) < 1e-6, `${v.name} at player height`);
  assert.ok(street!.target[0] < street!.eye[0], "the street looks in, toward the square");
  const lines = stakeLines(flat, plan);
  assert.ok(lines.some((l) => l.kind === "wall" && l.pts.every((p) => Math.abs(p[1] - 16) < 1e-6)), "a wall top line 6 m up");
  // a ridge between the eye and a stake hides it
  const ridge = { height: (x: number) => (x > 40 && x < 44 ? 30 : 0) };
  assert.equal(seenOverGround(ridge, [60, 1.7, 0], [0, 0.1, 0]), false);
  assert.equal(seenOverGround(flat, [60, 11.7, 0], [0, 10.1, 0]), true);
});

test("no road: the gate faces away from the water", async () => {
  const { townStakePlan } = await import("../tools/_concept-site.mts");
  const plan = townStakePlan({ height: () => 0 }, [0, 0], 40, null, [0, -80]);
  assert.ok(plan.gate[1] > 39, `gate south, the lake north: ${plan.gate}`);
});

// 2026-10-30 w15: the Moon's sheet named the 128 m sea cliff dropping away behind the block, not the face over its door
test("an entrance's face is the one RISING from its door, never a drop behind it", () => {
  // a door at the origin under a 30 m face to the north; 60 m south the ground drops 80 m to the sea
  const g = { height: (_x: number, z: number) => (z < -20 ? Math.min(30, (-20 - z) * 3) : 0) - (z > 60 ? Math.min(80, (z - 60) * 3) : 0), waterY: () => null };
  assert.ok(measureSite(g, [0, 0], 120, 120).face!.height > 70, "the plain probe takes the drop");
  const up = measureSite(g, [0, 0], 120, 120, { rising: true }).face!;
  assert.ok(up.height >= 28 && up.height <= 30.5 && Math.abs(((up.bearing + 180) % 360) - 180) <= 12, JSON.stringify(up));
});

// 2026-10-30 w15: the Moon's approach camera was a 16 px first sight from 252 m, round the side of the block
test("an entrance's approach frames its front, not a far glimpse from the side", () => {
  // the face rises north of the door (front looks south, +Z); the road runs in from the east then passes the front
  const g = { height: (_x: number, z: number) => (z < -20 ? Math.min(30, (-20 - z) * 3) : 0), waterY: () => null };
  const road: [number, number][] = [[300, -40], [120, -40], [60, 60], [0, 80], [-200, 80]];
  const side = approachView(g, [0, 0], 12, 300, [road], []);
  const framed = approachView(g, [0, 0], 12, 300, [road], [], undefined, undefined, 10, [0, 1]);
  assert.ok(framed.px >= 48 && framed.eye[2] > 0, framed.note);
  assert.ok(framed.from < side.from, `${framed.from} vs first sight ${side.from}`);
  assert.match(framed.note, /frames the front/);
});

// 2026-10-30 w15: the Sun's far camera stood against a rock flank that filled half the frame
test("the far view does not stand against a wall that fills the frame", () => {
  // the site at the origin; a 40 m rock wall runs east-west just north of the west eyes (z -30..-5, x -360..-250),
  // beside their sight line, and the approach is out west, so the far view prefers those eyes
  const g = { height: (x: number, z: number) => (x > -360 && x < -250 && z > -30 && z < -5 ? 40 : 0) + (Math.hypot(x, z) < 30 ? 15 : 0), waterY: () => null };
  const boxed: [number, number, number] = [-300, 1.7, 0];
  assert.ok(nearWall(g, boxed, [0, 6, 0]) > NEAR_WALL_MAX, "the west eye is boxed in");
  const v = farView(g, [0, 0], 20, 300, [-400, 0]);
  assert.ok(nearWall(g, v.eye, v.target) <= NEAR_WALL_MAX, `eye ${v.eye.map(Math.round)} boxed in`);
});

// 2026-10-30 w15: the Sun's far camera stood 10 m from a 32 m hoodoo that filled half the frame
test("a camera never stands against a tall scatter object in its frame", () => {
  const flat = { height: (x: number, z: number) => (Math.hypot(x, z) < 30 ? 15 : 0), waterY: () => null };
  const hoodoo = { x: -290, y: 0, z: -8, r: 7, h: 32 };
  assert.ok(nearObstacle([-300, 1.7, 0], [0, 6, 0], [hoodoo]), "hoodoo 10 m off the sight line");
  assert.ok(!nearObstacle([-300, 1.7, 0], [0, 6, 0], [{ ...hoodoo, x: -330 }]), "behind the eye");
  const v = farView(flat, [0, 0], 20, 300, [-300, 0], undefined, undefined, [hoodoo]);
  assert.ok(!nearObstacle(v.eye, v.target, [hoodoo]), `eye ${v.eye.map(Math.round)}`);
});

// 2026-10-30 w15: road-moon reaches the Moon round the lake; its frontal stretch is 600 m along the road but 250 m off
test("a framing point may lie far along the road when it is near the front", () => {
  const g = { height: (_x: number, z: number) => (z < -20 ? Math.min(30, (-20 - z) * 3) : 0), waterY: () => null };
  // in front (south) at 150 m, then a 700 m loop east and back, arriving from the east side
  const road: [number, number][] = [[-100, 150], [100, 150], [600, 150], [600, -60], [60, -10], [15, -5]];
  const v = approachView(g, [0, 0], 12, 300, [road], [], undefined, undefined, 10, [0, 1]);
  assert.match(v.note, /frames the front/);
  assert.ok(v.eye[2] > 100, `eye ${v.eye.map(Math.round)}`);
});

// r-found 2026-10-31: a --renders-only after a road trim recomputed "first sight", moved Red Dial's approach 42 m and its
// far camera onto another bearing, and the bare frames no longer matched the paintings. A painted view keeps its camera.
test("paintingCamera: a painted view re-renders from the painting's own camera, from a manifest or a views.json", () => {
  const fresh: View = { name: "approach", eye: [1284.5, 101, -41.5], target: [1346, 105.2, -138], from: 114, px: 40.4, visible: 1, note: "first sight" };
  const site = { renders: { approach: { camera: [1307.8, 100.8, -76.5], target: [1346, 105.2, -138], px: 38, note: "first sight then" } } };
  const kept = paintingCamera(fresh, site, true, [1346, -138]);
  assert.deepEqual(kept.eye, [1307.8, 100.8, -76.5]);
  assert.deepEqual(kept.target, [1346, 105.2, -138]);
  assert.equal(kept.from, 72);
  assert.equal(kept.px, 38);
  assert.match(kept.note, /painting's own camera/);
  // a place-build views.json names it concept-<view>
  const views = [{ name: "core-close", camera: [0, 0, 0], target: [1, 0, 0] }, { name: "concept-approach", camera: [1307.8, 100.8, -76.5], target: [1346, 105.2, -138] }];
  assert.deepEqual(paintingCamera(fresh, views, true, [1346, -138]).eye, [1307.8, 100.8, -76.5]);
  // no painting (a first render) or no recorded camera: the computed view stands
  assert.equal(paintingCamera(fresh, site, false, [1346, -138]), fresh);
  assert.equal(paintingCamera(fresh, { renders: { far: site.renders.approach } }, true, [1346, -138]), fresh);
  assert.equal(paintingCamera(fresh, null, true, [1346, -138]), fresh);
  assert.equal(paintingCamera(fresh, { renders: { approach: { camera: [1, 2], target: [1, 2, 3] } } }, true, [1346, -138]), fresh);
});
