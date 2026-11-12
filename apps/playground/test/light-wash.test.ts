import { test } from "node:test";
import assert from "node:assert/strict";
import { fireRead, isFarFire, oneLightPerFire, washMetrics, washRun, washVerdict, type FrameWash, type Raw } from "../tools/_light-wash.mts";

const W = 160, H = 90;
const frame = (fill: [number, number, number]): Raw => {
  const data = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) data.set(fill, i * 3);
  return { data, w: W, h: H, ch: 3 };
};
const disc = (r: Raw, cx: number, cy: number, rad: number, c: [number, number, number]) => {
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (Math.hypot(x - cx, y - cy) <= rad) r.data.set(c, (y * r.w + x) * 3);
};

test("a frame blown white by a halo fails the wash band, a plain one passes", () => {
  const plain = frame([90, 70, 60]);
  assert.equal(washVerdict(washMetrics(plain), 12).ok, true);
  const washed = frame([90, 70, 60]);
  disc(washed, 80, 70, 30, [255, 255, 255]);
  const v = washVerdict(washMetrics(washed), 12);
  assert.equal(v.ok, false);
  assert.match(v.why, /blown white/);
});

test("a far fire reads by a small warm flame; a wide halo is measured as a wide glow", () => {
  const night = frame([30, 28, 30]);
  disc(night, 40, 40, 2, [255, 170, 80]);
  const small = fireRead(night, { x: 40, y: 40, d: 450 });
  assert.equal(small.reads, true);
  assert.ok(small.glowPx <= 4, `glow ${small.glowPx}`);
  const halo = frame([30, 28, 30]);
  disc(halo, 80, 45, 20, [200, 130, 70]);
  const wide = fireRead(halo, { x: 80, y: 45, d: 450 });
  assert.ok(wide.glowPx > 9, `glow ${wide.glowPx}`);
  const none = fireRead(frame([30, 28, 30]), { x: 40, y: 40, d: 450 });
  assert.equal(none.reads, false);
});

test("a fire's several lights count once, at the lowest (the flame)", () => {
  const merged = oneLightPerFire([{ x: 100, y: 300, d: 450 }, { x: 100, y: 292, d: 451 }, { x: 400, y: 300, d: 460 }], 720);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((f) => f.x === 100)!.y, 300);
});

test("the run fails a halo veil and far fires that do not read at dusk", () => {
  const base = { wash: { luma: 50, lower: 40, clip: 0, glare: 0 }, washOk: true, washWhy: "" };
  const ok: FrameWash[] = [{ ...base, spot: "far", time: 20, fires: { far: 4, read: 4, wideGlow: 0, rows: [{ x: 1, y: 1, d: 450, reads: true, peak: 200, bg: 40, glowPx: 3, why: "" }] }, veil: { luma: 1, lit: 0.02 } }];
  assert.equal(washRun(ok, true).ok, true);
  const veiled: FrameWash[] = [{ ...base, spot: "avenue", time: 12, veil: { luma: 35, lit: 0.69 } }];
  assert.equal(washRun(veiled, false).ok, false);
  const dark: FrameWash[] = [{ ...base, spot: "far", time: 20, fires: { far: 10, read: 2, wideGlow: 0, rows: [] } }];
  assert.match(washRun(dark, true).faults.join(" "), /read by flame/);
});

test("no planner read target is a smoke column: every fire reads by its flame (owner ruling 2026-10-30)", async () => {
  const { SMOKE_READ_M } = await import("../tools/_place-archetype.mts");
  // the bonfire's flame (~4 m) is the tallest honest fire read; the pyre's 8 m column no longer counts
  for (const [prefab, top] of Object.entries(SMOKE_READ_M)) assert.ok(top <= SMOKE_READ_M["camp-props/bonfire"]!, `${prefab} reads ${top} m: a smoke column`);
  assert.equal(SMOKE_READ_M["giant-camp/landmark-pyre"], SMOKE_READ_M["camp-props/bonfire"]);
});

test("a light past the flame's cull distance is not a far fire (no flame is drawn there)", () => {
  assert.equal(isFarFire({ d: 200 }), false);
  assert.equal(isFarFire({ d: 450 }), true);
  assert.equal(isFarFire({ d: 2100 }), false);
});

test("a fire the camera cannot see (its ray blocked short of the light) is not a far fire", async () => {
  assert.equal(isFarFire({ d: 450, occluded: true }), false);
  assert.equal(isFarFire({ d: 450, occluded: false }), true);
  // the run only asks for a fire read when some far fire is SEEN
  const sharp = (await import("sharp")).default, os = await import("node:os"), path = await import("node:path");
  const file = path.join(os.tmpdir(), `light-wash-hidden-${process.pid}.png`);
  await sharp(Buffer.alloc(W * H * 3, 30), { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
  const { judgeFrame } = await import("../tools/_light-wash.mts");
  const f = await judgeFrame(file, "pit", 20, [{ x: 80, y: 45, d: 450, occluded: true }]);
  (await import("node:fs")).rmSync(file, { force: true });
  assert.equal(f.fires, undefined);
  assert.equal(f.firesHidden, 1);
});

test("sightHits: a wall between the camera and a fire blocks it; the fire's own brazier inside the clear distance does not", async () => {
  const THREE = await import("three");
  const { sightHits } = await import("../src/line-of-sight.ts");
  const scene = new THREE.Scene(), mat = new THREE.MeshBasicMaterial();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 1), mat); wall.position.set(0, 0, -100); scene.add(wall);
  const brazier = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat); brazier.position.set(30, 0, -199); scene.add(brazier);
  scene.updateMatrixWorld(true);
  const [hidden, seen] = sightHits(scene, [{ from: [0, 0, 0], to: [0, 0, -400] }, { from: [0, 0, 0], to: [30, 0, -200] }], 4);
  assert.ok(hidden && hidden.d > 98 && hidden.d < 101, "the wall hides the first fire");
  assert.equal(seen, null, "the second fire's brazier is within the clear distance");
});

test("a cold (spirit) fire reads by its own blue flame, not by warmth", () => {
  const r = frame([40, 30, 30]);
  disc(r, 80, 45, 2, [150, 190, 235]);
  assert.equal(fireRead(r, { x: 80, y: 45, d: 400 }).reads, false);
  assert.equal(fireRead(r, { x: 80, y: 45, d: 400, cold: true }).reads, true);
});

test("a cold flame with a white-hot core still reads by its blue rim", () => {
  const r = frame([50, 40, 40]);
  disc(r, 80, 45, 2, [156, 181, 206]);
  disc(r, 80, 45, 0, [214, 214, 214]);
  assert.equal(fireRead(r, { x: 80, y: 45, d: 400, cold: true }).reads, true);
});

test("a cold flame's hue comes from its coloured rim, not its clipped white core (a farGrow flame, moon 2026-10-31)", () => {
  // a 3x3-wide white core inside a 2 px blue rim: the old 3x3 mean read only the core and refused it
  const r = frame([60, 40, 36]);
  disc(r, 80, 45, 3, [120, 150, 175]);
  disc(r, 80, 45, 1, [235, 240, 238]);
  assert.equal(fireRead(r, { x: 80, y: 45, d: 310, cold: true }).reads, true);
  // a white point over red ground, with no blue round it, is no spirit flame
  const g = frame([60, 40, 36]);
  disc(g, 80, 45, 2, [175, 160, 150]);
  disc(g, 80, 45, 1, [235, 240, 238]);
  assert.equal(fireRead(g, { x: 80, y: 45, d: 310, cold: true }).reads, false);
});
