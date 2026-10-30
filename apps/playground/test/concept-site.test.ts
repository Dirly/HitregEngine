import { test } from "node:test";
import assert from "node:assert/strict";
import { approachView, conceptBrief, farView, measureSite, readDistance } from "../tools/_concept-site.mts";

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
