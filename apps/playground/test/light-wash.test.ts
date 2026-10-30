import { test } from "node:test";
import assert from "node:assert/strict";
import { fireRead, oneLightPerFire, washMetrics, washRun, washVerdict, type FrameWash, type Raw } from "../tools/_light-wash.mts";

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
