// place-build render-batch (tools/_render-batch.mts, Derek 2026-10-31: no per-place shot runs while building; ONE batch
// render over the live world after a batch install): the spot list (iso pair first, close views, night only where lit,
// extra spots), splitting the run back into per-place evidence, the contact sheet, which evidence a shot row is judged
// from, and the install path: the shot rows (see-through, the design's sample frames) no longer block an install.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BATCH_DAY, BATCH_NIGHT, batchFresh, batchId, batchSpots, batchTimes, composeSheet, latestBatchEvidence, mergeRuns, pickBatchViews, pruneOldBatches,
  salvageRun, sheetRows, shotEvidence, skippedSpots, splitRun, TILE_H, TILE_W, type BatchPlace, type View, poseFaults, dropSpots, spotTiming, type Run,
} from "../tools/_render-batch.mts";
// @ts-ignore untyped JS module (types in _png.d.mts)
import { decodePng, encodePng } from "../tools/_png.mjs";
// @ts-ignore untyped engine tool module
import { designBlock, designFaults, installBlock, SHOT_ROWS } from "../../../tools/poi-review/job.mjs";

const iso = (name: string): View => ({ name, x: 0, z: 0, camera: [100, 80, -100], target: [0, 0, 0], review: true, times: [12] });
const views: View[] = [
  { name: "core-close-side", x: 1, z: 1, facing: 90 },
  { name: "read-1-150m", x: 150, z: 0 },
  { name: "read-2-140m", x: -140, z: 0 },
  { name: "aerial-150", x: 0, z: 0 },
  { name: "road-approach", x: 50, z: 0, camera: [50, 2, 0], target: [0, 1, 0] },
  { name: "camp-close", x: 5, z: 5, camera: [8, 2, 8], target: [0, 1, 0] },
  { name: "core-close", x: 0, z: 0, facing: 180 },
  { name: "concept-far", x: 300, z: 0, camera: [300, 9, 0], target: [0, 0, 0] },
];
const place = (patch: Partial<BatchPlace> = {}): BatchPlace => ({ id: "camp", views, iso: [iso("iso-ne"), iso("iso-sw")], readView: "read-2-140m", lit: true, ...patch });

test("pickBatchViews: the iso pair first, then core-close, the approach's read view and one owner camera", () => {
  const { iso: i, close } = pickBatchViews(place());
  assert.deepEqual(i.map((v) => v.name), ["iso-ne", "iso-sw"]);
  assert.ok(i.every((v) => v.review === true));
  // core-close before core-close-side; the read view named by the approach (not the first read-*); the first *-close
  // fixed camera (not the road arrival, not a concept frame)
  assert.deepEqual(close.map((v) => v.name), ["core-close", "read-2-140m", "camp-close"]);
  // no read view known: the first read-* view
  assert.equal(pickBatchViews(place({ readView: null })).close[1]!.name, "read-1-150m");
  // views the owner marked `batch: true` replace the fallback camera (max 2)
  const marked = views.map((v) => (["aerial-150", "concept-far", "road-approach"].includes(v.name) ? { ...v, batch: true } : v));
  assert.deepEqual(pickBatchViews(place({ views: marked })).close.map((v) => v.name), ["core-close", "read-2-140m", "aerial-150", "road-approach"]);
  // core-front when there is no core-close; iso views already in views.json win over the job's computed ones
  const noCore = views.filter((v) => v.name !== "core-close").concat([{ name: "core-front", x: 0, z: 0 }, { ...iso("iso-ne"), x: 9 }]);
  const p = pickBatchViews(place({ views: noCore }));
  assert.equal(p.close[0]!.name, "core-front");
  assert.equal(p.iso[0]!.x, 9);
});

test("batchSpots: <place>--<view> names, iso noon review-only, 20:00 only where lit, --night off, extras ride along", () => {
  const spots = batchSpots([place(), place({ id: "den", lit: false })], [{ name: "chapel", x: 1, z: 2, camera: [1, 60, 2], target: [0, 60, 0] }]);
  assert.deepEqual(spots.slice(0, 5).map((s) => s.name), ["camp--iso-ne", "camp--iso-sw", "camp--core-close", "camp--read-2-140m", "camp--camp-close"]);
  assert.deepEqual(spots.filter((s) => s.name.startsWith("camp--iso")).map((s) => [s.review, s.times]), [[true, [BATCH_DAY]], [true, [BATCH_DAY]]]);
  assert.deepEqual(spots.find((s) => s.name === "camp--core-close")!.times, [BATCH_DAY, BATCH_NIGHT]);
  assert.equal(spots.find((s) => s.name === "camp--core-close")!.review, undefined, "a close view is judged by the wash (no review flag)");
  assert.deepEqual(spots.find((s) => s.name === "den--core-close")!.times, [BATCH_DAY], "no lights: noon only");
  const x = spots.at(-1)!;
  assert.equal(x.name, "extra--chapel"); assert.equal(x.review, true); assert.deepEqual(x.times, [BATCH_DAY]);
  assert.deepEqual(batchTimes(spots), [12, 20]);
  const off = batchSpots([place()], [], { night: "off" });
  assert.ok(off.every((s) => s.times.length === 1 && s.times[0] === BATCH_DAY));
  assert.deepEqual(batchTimes(off), [12]);
  assert.throws(() => batchSpots([place({ id: "a--b" })]), /contains/);
});

test("batchId: date + a hash of the sorted places (the same batch the same day overwrites)", () => {
  const d = new Date("2026-10-31T12:00:00Z");
  assert.match(batchId(["b", "a"], undefined, d), /^2026-10-31-[0-9a-f]{6}$/);
  assert.equal(batchId(["b", "a"], undefined, d), batchId(["a", "b"], undefined, d));
  assert.notEqual(batchId(["a", "b"], undefined, d), batchId(["a", "b"], "x/spots.json", d));
});

test("splitRun / skippedSpots / mergeRuns: per-place records with the prefix stripped, layers kept, stalls listed", () => {
  const run = { shots: [
    { spot: "camp--core-close", time: 12, file: "/t/run/redstrand/camp--core-close-12.png", layers: { "no-veil": "/t/run/redstrand/camp--core-close-12-no-veil.png" } },
    { spot: "camp--iso-ne", time: 12, review: true, file: "/t/run/redstrand/camp--iso-ne-12.png" },
    { spot: "den--core-close", time: 12, file: "/t/run/redstrand/den--core-close-12.png" },
  ], blackFrames: ["camp--core-close@20", "den--core-close@12"] };
  const s = splitRun(run, "camp", "2026-10-31-abc123");
  assert.deepEqual(s.shots.map((x) => [x.spot, x.file]), [["core-close", "2026-10-31-abc123/core-close-12.png"], ["iso-ne", "2026-10-31-abc123/iso-ne-12.png"]]);
  assert.equal(s.shots[0]!.layers!["no-veil"], "2026-10-31-abc123/core-close-12-no-veil.png");
  assert.equal(s.copies.length, 3);
  assert.deepEqual(s.blackFrames, ["core-close@20"]);
  const spots = [{ name: "camp--core-close" }, { name: "camp--iso-ne" }, { name: "camp--read-1" }, { name: "den--core-close" }];
  assert.deepEqual(skippedSpots(spots, [run]), ["camp--read-1"]);
  const retry = { shots: [{ spot: "camp--read-1", time: 12, file: "/t/retry/redstrand/camp--read-1-12.png" }] };
  const m = mergeRuns(run, retry);
  assert.deepEqual(skippedSpots(spots, [m]), []);
  assert.equal(m.shots!.length, 4);
  assert.deepEqual(mergeRuns(run, null), run);
});

test("contact sheet: the iso pair on top, a row per close view, a dark tile naming a skipped or missing frame", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-sheet-"));
  const png = (f: string, rgb: number[]) => { const px = new Uint8Array(1280 * 720 * 4); for (let i = 0; i < 1280 * 720; i++) px.set([...rgb, 255], i * 4); fs.writeFileSync(f, encodePng(1280, 720, px)); };
  png(path.join(dir, "iso-ne-12.png"), [200, 0, 0]); png(path.join(dir, "iso-sw-12.png"), [0, 200, 0]); png(path.join(dir, "core-close-12.png"), [0, 0, 200]);
  const spots = batchSpots([place()]);
  const frameOf = (v: string, h: number) => { const f = path.join(dir, `${v}-${h}.png`); return fs.existsSync(f) ? f : null; };
  const rows = sheetRows(spots, "camp", frameOf, new Set(["camp--camp-close"]), new Set());
  assert.deepEqual(rows.map((r) => r.map((t) => t.label)), [["iso-ne 12:00", "iso-sw 12:00"], ["core-close 12:00", "core-close 20:00"], ["read-2-140m 12:00", "read-2-140m 20:00"], ["camp-close 12:00", "camp-close 20:00"]]);
  assert.equal(rows[3]![0]!.note, "SKIPPED (stalled)");
  assert.equal(rows[1]![1]!.note, "NO FRAME");
  const out = path.join(dir, "sheet-camp.png");
  composeSheet("camp | batch test", rows, out);
  const img = decodePng(fs.readFileSync(out));
  assert.equal(img.width, 8 + 2 * (TILE_W + 8));
  assert.ok(img.height > 4 * TILE_H);
  const at = (x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
  assert.deepEqual(at(8 + 100, 34 + 100), [200, 0, 0], "iso-ne top left");
  assert.deepEqual(at(8 + TILE_W + 8 + 100, 34 + 100), [0, 200, 0], "iso-sw top right");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shot rows read the latest batch evidence when it is current for the ops, else a fresh lab run, else deferred", () => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), "rb-job-"));
  const old = new Date(Date.now() - 3600e3), now = new Date();
  for (const f of ["ops.json", "world-ops.json", "operators.json", "clearings.json"]) { fs.writeFileSync(path.join(job, f), "[]"); fs.utimesSync(path.join(job, f), now, now); }
  const lab = path.join(job, "evidence", "pbcamp.json");
  assert.deepEqual(shotEvidence(job, lab), { kind: "deferred", why: "no batch evidence yet" });
  fs.mkdirSync(path.dirname(lab), { recursive: true }); fs.writeFileSync(lab, "{}"); fs.utimesSync(lab, old, old);
  assert.equal(shotEvidence(job, lab).kind, "deferred", "a lab run older than the ops is no evidence");
  fs.utimesSync(lab, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(shotEvidence(job, lab).kind, "lab");
  const LD = path.join(job, "evidence", "live");
  fs.mkdirSync(path.join(LD, "b-old"), { recursive: true }); fs.mkdirSync(path.join(LD, "b-new"), { recursive: true });
  fs.writeFileSync(path.join(LD, "b-old.json"), JSON.stringify({ source: "render-batch", batch: "b-old", at: old.toISOString() }));
  assert.match((shotEvidence(job, path.join(job, "none.json")) as { why: string }).why, /batch b-old predates the ops/);
  fs.writeFileSync(path.join(LD, "b-new.json"), JSON.stringify({ source: "render-batch", batch: "b-new", at: new Date(Date.now() + 5000).toISOString() }));
  const ev = shotEvidence(job, lab);
  assert.equal(ev.kind, "batch"); assert.equal((ev as { rec: { batch: string } }).rec.batch, "b-new");
  assert.equal(latestBatchEvidence(job)!.rec.batch, "b-new");
  assert.equal(batchFresh({ at: old.toISOString() }, now.getTime()), false);
  // one latest batch per place: the older record and its frames go
  pruneOldBatches(job, "b-new");
  assert.deepEqual(fs.readdirSync(LD).sort(), ["b-new", "b-new.json"]);
  fs.rmSync(job, { recursive: true, force: true });
});

/** A minimal job the geometry gates pass: a pinpoint shrine with one BUILT wall (a mesh: gate 8 applies), Derek's owner
 *  approval, and float / rock-skins / water-edges / walk / art reports newer than the ops. No see-through report. */
function geometryCleanJob(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-install-"));
  const w = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof v === "string" ? v : JSON.stringify(v)); };
  w("progress.json", { version: 1, poiId: "t", ownerAgentId: "POI-T", stage: "detail", evidence: {}, viewpoints: [], fixes: [], finalReview: null, ownerApproval: { by: "derek", note: "walked it, ship" } });
  w("brief.json", { id: "t", adventureSize: "pinpoint" });
  w("handoff.json", { integration: { sceneOps: "ops.json", worldOps: "world-ops.json + clearings.json" }, measurements: { measuredCombinedUsableAreaM2: 200, features: [{ id: "shrine", kind: "landmark" }], approaches: [{ from: "road-1" }] } });
  w("ops.json", [{ op: "add-entity", id: "wall", components: { transform: { position: [100, 0, 50] }, mesh: { source: { kind: "asset", assetId: "x/wall.glb" } } } }]);
  w("world-ops.json", []);
  w("clearings.json", [{ id: "shrine-yard", center: [100, 50], radius: 10 }]);
  const later = new Date(Date.now() + 5000);
  for (const [f, v] of [["float", { ok: true, counts: {} }], ["rock-skins", { ok: true, counts: {} }], ["water-edges", { ok: true, rows: [] }], ["walk", { ok: true, partial: null, counts: {}, faults: [] }], ["art-check", { ok: true, materialPolicy: "architecture", counts: {}, faults: [] }]] as const) {
    w(`reports/${f}.json`, v); fs.utimesSync(path.join(dir, "reports", `${f}.json`), later, later);
  }
  return dir;
}

test("install path: the shot rows (see-through, design sample) never block an install; shots: true still asks for them", () => {
  assert.deepEqual(SHOT_ROWS, ["see-through", "design-sample"]);
  const dir = geometryCleanJob();
  assert.equal(installBlock(dir), null, "built structures, no see-through report: still installable (judged after, from the batch)");
  assert.match(installBlock(dir, { shots: true }) ?? "", /no see-through gate evidence \(gate 8\)/);
  // a geometry gate still blocks
  fs.writeFileSync(path.join(dir, "reports", "float.json"), JSON.stringify({ ok: false, counts: { off: 2 } }));
  assert.match(installBlock(dir) ?? "", /float gate failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("install path: gate 16 asks for no sample frames (they come from the batch render), every other design line still counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-design-"));
  fs.writeFileSync(path.join(dir, "brief.json"), JSON.stringify({ id: "t", adventureSize: "pinpoint" }));
  fs.writeFileSync(path.join(dir, "design.json"), JSON.stringify({ version: 1, premise: "ruins", journey: ["x"], elements: [], areas: [], sample: { area: "yard", shots: ["evidence/live/b/yard-12.png"] }, reference: [], concept: [] }));
  const withSample = designFaults(dir) as string[], without = designFaults(dir, undefined, { sample: false }) as string[];
  assert.ok(withSample.some((f) => /sample shot .* does not exist/.test(f)));
  assert.ok(!without.some((f) => /^sample/.test(f)), without.join(" | "));
  assert.ok(without.some((f) => /premise/.test(f)), "the premise line still counts");
  // designBlock names the first four faults and counts the rest: the two sample lines are gone from the install path's count
  assert.ok((designBlock(dir, {}) ?? "").includes(`+${withSample.length - 4} more`));
  assert.ok((designBlock(dir, {}, { sample: false }) ?? "").includes(`+${without.length - 4} more`));
  assert.equal(withSample.length - without.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("salvageRun: a run killed before its record keeps the frames on disk (layers attached, unknown files ignored)", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rb-salvage-")), d = path.join(out, "redstrand");
  fs.mkdirSync(d);
  for (const f of ["camp--iso-ne-12.png", "camp--read-1-157m-12.png", "camp--read-1-157m-12-no-veil.png", "camp--read-1-157m-12-no-veil-on.png", "camp--read-1-157m-20.png", "other-12.png"]) fs.writeFileSync(path.join(d, f), "png");
  const run = salvageRun(out, "redstrand", [{ name: "camp--iso-ne", review: true }, { name: "camp--read-1-157m" }, { name: "camp--core-close" }])!;
  assert.deepEqual(run.shots!.map((s) => `${s.spot}@${s.time}`).sort(), ["camp--iso-ne@12", "camp--read-1-157m@12", "camp--read-1-157m@20"]);
  const r12 = run.shots!.find((s) => s.spot === "camp--read-1-157m" && s.time === 12)!;
  assert.deepEqual(Object.keys(r12.layers!).sort(), ["no-veil", "no-veil-on"]);
  assert.equal(run.shots!.find((s) => s.spot === "camp--iso-ne")!.review, true);
  assert.deepEqual(skippedSpots([{ name: "camp--iso-ne" }, { name: "camp--core-close" }], [run]), ["camp--core-close"]);
  assert.equal(salvageRun(path.join(out, "none"), "redstrand", []), null);
  fs.rmSync(out, { recursive: true, force: true });
});

test("poseFaults: a frame shot from another place fails its spot (t-batch2 2026-10-31: camera-less views all showed Red Dial)", () => {
  // the 44f067 batch as recorded: after red-dial--avenue the body stayed at [1310.6, 99.8, -85.9]
  const spots: View[] = [
    { name: "red-dial--avenue", x: 1310.62, z: -85.88, camera: [1310.62, 101.32, -85.88], target: [1346.02, 108.62, -138.03] },
    { name: "hermits-rise--iso-ne", x: 1440, z: -470, camera: [1506.44, 168.66, -531.79], target: [1437.4, 100.3, -462.75], review: true },
    { name: "hermits-rise--core-close", x: 1426.15, z: -464.23, facing: 67, distance: 1 },
    { name: "hermits-rise--camp-close", x: 1427.77, z: -468.15, camera: [1427.77, 102, -468.15], target: [1440, 101.5, -470] },
    { name: "red-dial--read-3-455m", x: 1001.98, z: 157.46, facing: 49, distance: 1 },
  ];
  const stuck = [1310.62, 99.84, -85.88];
  const run: Run = { shots: [
    { spot: "red-dial--avenue", time: 12, file: "a", camera: { pos: [1310.62, 101.32, -85.88], target: stuck, distance: 4 } },
    { spot: "hermits-rise--iso-ne", time: 12, file: "b", camera: { pos: [1506.44, 168.66, -531.79], target: stuck, distance: 4 } },
    { spot: "hermits-rise--core-close", time: 12, file: "c", camera: { pos: [1309.7, 100.47, -85.49], target: stuck, distance: 1 } },
    { spot: "hermits-rise--core-close", time: 20, file: "d", camera: { pos: [1309.7, 100.47, -85.49], target: stuck, distance: 1 } },
    { spot: "hermits-rise--camp-close", time: 12, file: "e", camera: { pos: [1427.77, 102, -468.15], target: stuck, distance: 4 } },
    // a good rig frame: body at the spot, camera on its 1 m orbit
    { spot: "red-dial--read-3-455m", time: 12, file: "f", camera: { pos: [1001.22, 126.23, 158.1], target: [1001.98, 125.6, 157.45], distance: 1 } },
    { spot: "unposed", time: 12, file: "g" }, // a salvaged frame: nothing to judge
  ] };
  const f = poseFaults(spots, run);
  assert.deepEqual(f.map((x) => `${x.spot}@${x.time}`), ["hermits-rise--iso-ne@12", "hermits-rise--core-close@12", "hermits-rise--core-close@20", "hermits-rise--camp-close@12"]);
  assert.match(f[1]!.detail, /body \d+\.\d m from the spot/);
  // a fixed camera whose body was moved to the camera (streams-from-the-camera rule) is fine
  assert.equal(poseFaults([{ name: "far", x: 0, z: 0, camera: [200, 5, 0], target: [0, 0, 0] }], { shots: [{ spot: "far", time: 12, file: "x", camera: { pos: [200, 5, 0], target: [200, 1, 0], distance: 4 } }] }).length, 0);
  // a rig camera far off its orbit fails
  assert.equal(poseFaults([{ name: "r", x: 0, z: 0, distance: 1 }], { shots: [{ spot: "r", time: 12, file: "x", camera: { pos: [30, 2, 0], target: [0, 1, 0], distance: 1 } }] }).length, 1);
  // ...unless light-shots moved it to a clear pose and the run record says so (r-batch 2026-11-03: the record dropped
  // clearView and every cleared read view was skipped as a pose fault)
  const moved = { moved: true as const, from: [1, 2, 0] as [number, number, number], to: [30, 2, 0] as [number, number, number], target: [0, 1, 0] as [number, number, number], dYawDeg: 0, dElevDeg: 5, pull: 0.55, blockedBy: "prop-pool", blockedAtM: 11 };
  assert.equal(poseFaults([{ name: "r", x: 0, z: 0, distance: 1 }], { shots: [{ spot: "r", time: 12, file: "x", camera: { pos: [30, 2, 0], target: [0, 1, 0], distance: 1 }, clearView: moved } as any] }).length, 0);
  const kept = dropSpots({ ...run, blackFrames: ["hermits-rise--core-close@20", "red-dial--avenue@12"] }, new Set(f.map((x) => x.spot)));
  assert.deepEqual([...new Set(kept.shots!.map((s) => s.spot))], ["red-dial--avenue", "red-dial--read-3-455m", "unposed"]);
  assert.deepEqual(kept.blackFrames, ["red-dial--avenue@12"]);
  assert.deepEqual(skippedSpots(spots, [kept]), ["hermits-rise--iso-ne", "hermits-rise--core-close", "hermits-rise--camp-close"]);
});

test("spotTiming: per-spot seconds from the run records, the retry tagged", () => {
  const a = { spots: [{ name: "p--core-close", timing: { travelS: 9, placeSettleS: 11, framesS: 12, totalS: 32 } }, { name: "p--read", timing: { travelS: 50, travelCapped: "draw calls changing", totalS: 80 } }] } as Run;
  const b = { spots: [{ name: "p--iso-ne", timing: { totalS: 20 } }] } as Run;
  const t = spotTiming([a, null, b]);
  assert.deepEqual(t.map((x) => x.spot), ["p--core-close", "p--read", "p--iso-ne"]);
  assert.equal(t[1]!.travelCapped, "draw calls changing");
  assert.equal(t[2]!.retry, true);
  assert.equal(t[0]!.retry, undefined);
});
