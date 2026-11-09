/**
 * BATCH RENDER (Derek 2026-10-31, memory batch-renders-after-install: "do a much larger pass after everything is
 * installed, so you don't spend a bunch of time rendering and loading shaders ... we provide the locations and it just
 * hops around and takes the shots"). Places are built and geometry-gated WITHOUT shots and installed in batches; then
 * `place-build render-batch` loads the LIVE world ONCE (one light-shots run: one browser, shaders warm) and hops over
 * every place of the batch. This module is the pure part: which views each place gets, the spot list, splitting the run
 * back into per-place evidence records, the contact sheet, and the shot-dependent rows judged from that evidence.
 *
 * Per place: iso-ne, iso-sw (review-only, fog off, noon) FIRST, then the close views: core-close (else core-front), the
 * read view of the approach its footpath joins, and the views the owner marked `batch: true` in views.json (max
 * BATCH_MARKED; none marked = one owner camera: the first fixed camera named *-close, else the first fixed
 * camera BATCH_FALLBACK_SKIP does not name). 20:00 only for a place with
 * lights. `--extra <spots.json>` spots ride along (review-only, noon unless they say `times`).
 *
 * Where it lands:
 *   <job>/evidence/live/<batch-id>.json   the place's evidence record (light-shots run shape: shots[], blackFrames,
 *                                          washVerdict + batch, opsHash, skipped) — judgeRun reads it as is
 *   <job>/evidence/live/<batch-id>/       its frames, named <view>-<hh>.png (+ light layer frames), overwritten in place;
 *                                          an older batch's record and frames in evidence/live/ are removed (one
 *                                          latest batch per place: git and the zone batch index are the history)
 *   <zone>/reports/batches/<batch-id>/sheet-<place>.png + index.json { places: [{ place, frames, skipped, rows }] }
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// @ts-ignore untyped JS module (types in _png.d.mts)
import { decodePng, encodePng } from "./_png.mjs";
// @ts-ignore untyped JS module
import { drawText } from "./_font.mjs";
import type { ClearViewRecord } from "./_clear-view.mts";

type V2 = [number, number];
export type View = { name: string; x: number; z: number; review?: boolean; batch?: boolean; times?: number[]; camera?: number[]; target?: number[] } & Record<string, unknown>;
export type BatchSpot = View & { name: string; times: number[] };
export type BatchPlace = { id: string; views: View[]; iso: View[]; readView?: string | null; lit: boolean };

export const BATCH_DAY = 12, BATCH_NIGHT = 20;
/** Owner-marked close views taken per place (views.json `batch: true`). */
export const BATCH_MARKED = 2;
/** The fallback owner camera (no view marked): the first view whose name is none of these (overviews, reads, the
 *  concept frames, and the road/track arrivals that only repeat the read). */
export const BATCH_FALLBACK_SKIP = /^(iso-|read-|aerial|concept-|core-close|core-front|road-|track-)/;
/** Separates the place id from the view name in a batch spot name. */
export const SEP = "--";

/** The views a place is shot from in a batch: the iso pair, then core-close / core-front, the read view, the marked ones. */
export function pickBatchViews(p: BatchPlace): { iso: View[]; close: View[] } {
  const byName = (n: string | null | undefined) => (n ? p.views.find((v) => v.name === n) : undefined);
  const iso = ["iso-ne", "iso-sw"].map((n) => byName(n) ?? p.iso.find((v) => v.name === n)).filter((v): v is View => !!v).map((v) => ({ ...v, review: true }));
  const core = byName("core-close") ?? byName("core-front");
  const read = byName(p.readView) ?? p.views.find((v) => v.name.startsWith("read-"));
  const marked = p.views.filter((v) => v.batch === true && !/^iso-/.test(v.name)).slice(0, BATCH_MARKED);
  const cams = p.views.filter((v) => Array.isArray(v.camera) && !BATCH_FALLBACK_SKIP.test(v.name));
  const extra = marked.length ? marked : [cams.find((v) => /-close$/.test(v.name)) ?? cams[0]].filter((v): v is View => !!v);
  const close: View[] = [];
  for (const v of [core, read, ...extra]) if (v && !close.some((c) => c.name === v.name)) close.push(v);
  return { iso, close };
}

/** The batch's light-shots spot list: per place (in the order given) the iso pair at noon, then the close views at noon
 *  (+ 20:00 when the place has lights and --night is auto); then the extra spots, review-only, noon unless they say. */
export function batchSpots(places: BatchPlace[], extra: View[] = [], o: { night?: "auto" | "off" } = {}): BatchSpot[] {
  const night = o.night !== "off";
  const out: BatchSpot[] = [];
  for (const p of places) {
    if (p.id.includes(SEP)) throw new Error(`place id ${p.id} contains "${SEP}"`);
    const { iso, close } = pickBatchViews(p);
    for (const v of iso) out.push({ ...v, name: `${p.id}${SEP}${v.name}`, review: true, times: [BATCH_DAY] });
    // a rig view (no fixed camera) must see the place: `aim` = the place centre (the iso framing's target), which
    // light-shots' clear-view step casts to (tools/_clear-view.mts); a fixed camera is checked against its own target
    const aim = iso.find((v) => Array.isArray(v.target))?.target;
    for (const v of close) { const { review: _r, batch: _b, ...rest } = v; out.push({ ...rest, ...(aim && !Array.isArray(v.camera) && !rest.aim ? { aim } : {}), name: `${p.id}${SEP}${v.name}`, times: night && p.lit ? [BATCH_DAY, BATCH_NIGHT] : [BATCH_DAY] }); }
  }
  for (const v of extra) out.push({ ...v, name: `extra${SEP}${v.name}`, review: true, times: Array.isArray(v.times) && v.times.length ? v.times : [BATCH_DAY] });
  return out;
}

/** The --times light-shots needs: every hour any spot asks for. */
export const batchTimes = (spots: readonly BatchSpot[]) => [...new Set(spots.flatMap((s) => s.times))].sort((a, b) => a - b);

/** The batch id: --batch, else <date>-<6 hex of the sorted places + extra file> (the same batch re-run the same day overwrites). */
export function batchId(places: readonly string[], extra: string | undefined, date = new Date()): string {
  const h = crypto.createHash("sha1").update([...places].sort().join(",") + "|" + (extra ? path.basename(extra) : "")).digest("hex").slice(0, 6);
  return `${date.toISOString().slice(0, 10)}-${h}`;
}

type Shot = { spot: string; time?: number | null; file: string; layers?: Record<string, string>; review?: boolean } & Record<string, unknown>;
export type Run = { shots?: Shot[]; blackFrames?: string[] } & Record<string, unknown>;

/** Spots of the list with no frame in the run (skipped by the spot timeout, failed twice, or the run died). */
export function skippedSpots(spots: readonly { name: string }[], runs: readonly Run[]): string[] {
  const got = new Set(runs.flatMap((r) => (r.shots ?? []).map((s) => s.spot)));
  return spots.map((s) => s.name).filter((n) => !got.has(n));
}

/** One owner's part of the batch run (prefix `<owner>--`), spot names and frame files without the prefix; files are
 *  `<dir>/<frame>` (dir = the record's frame folder, relative to the record). Returns the copies to make (from = the
 *  run's relative file). */
export function splitRun(run: Run, owner: string, dir: string): { shots: Shot[]; blackFrames: string[]; copies: { from: string; to: string }[] } {
  const pre = `${owner}${SEP}`, copies: { from: string; to: string }[] = [];
  const strip = (f: string) => { const b = path.posix.basename(f.replace(/\\/g, "/")); return b.startsWith(pre) ? b.slice(pre.length) : b; };
  const take = (f: string) => { const to = `${dir}/${strip(f)}`; if (!copies.some((c) => c.from === f)) copies.push({ from: f, to }); return to; };
  const shots = (run.shots ?? []).filter((s) => s.spot.startsWith(pre)).map((s) => ({
    ...s, spot: s.spot.slice(pre.length), file: take(s.file),
    ...(s.layers ? { layers: Object.fromEntries(Object.entries(s.layers).map(([k, f]) => [k, take(f)])) } : {}),
  }));
  const blackFrames = (run.blackFrames ?? []).filter((b) => b.startsWith(pre)).map((b) => b.slice(pre.length));
  return { shots, blackFrames, copies };
}

/** A run killed before light-shots wrote its <scene>.json (t-batch 2026-10-31: the cap killed a 28-spot run at 57 min
 *  and every frame was lost): the frames already on disk (<out>/<scene>/<spot>-<hh>.png, layer frames
 *  <spot>-<hh>-<layer>.png) as a run. No fires / measures (the far-fire read then has nothing to judge). */
export function salvageRun(out: string, scene: string, spots: readonly { name: string; review?: boolean }[]): Run | null {
  const d = path.join(out, scene);
  if (!fs.existsSync(d)) return null;
  const names = new Set(spots.map((s) => s.name)), review = new Set(spots.filter((s) => s.review).map((s) => s.name));
  const shots = new Map<string, Shot>();
  const files = fs.readdirSync(d).filter((f) => f.endsWith(".png")).sort();
  for (const f of files) { const m = /^(.*)-(\d\d)\.png$/.exec(f); if (m && names.has(m[1]!)) shots.set(`${m[1]}@${m[2]}`, { spot: m[1]!, time: +m[2]!, file: path.join(d, f), ...(review.has(m[1]!) ? { review: true } : {}) }); }
  for (const f of files) { const m = /^(.*)-(\d\d)-([a-z-]+)\.png$/.exec(f); const s = m && shots.get(`${m[1]}@${m[2]}`); if (s) (s.layers ??= {})[m![3]!] = path.join(d, f); }
  return shots.size ? { shots: [...shots.values()], salvaged: true } : null;
}

/** How far (m, horizontal) a frame's body / camera may stand from its spot before the frame is someone else's place. */
export const POSE_TOL_M = 6;
/** Frames whose recorded pose (light-shots shot.camera: pos = the camera, target = the body pivot) is not at their spot
 *  (t-batch2 2026-10-31: after one fixed-camera spot the body stopped following travel and every later camera-less view
 *  shot Red Dial). A fixed-camera spot: the camera at spot.camera, the body at the spot's x,z or at its camera (the
 *  streams-from-the-camera rule moves it there). A rig spot: the body at x,z and the camera within its orbit distance.
 *  Returns one fault per wrong frame; a frame without a recorded pose (a salvaged run) is not judged. */
export function poseFaults(spots: readonly View[], run: Run, tol = POSE_TOL_M): { spot: string; time: number | null; detail: string }[] {
  const by = new Map(spots.map((s) => [s.name, s])), out: { spot: string; time: number | null; detail: string }[] = [];
  const h = (a: readonly number[], x: number, z: number) => Math.hypot(a[0]! - x, a[2]! - z);
  for (const s of run.shots ?? []) {
    const sp = by.get(s.spot), cam = (s as any).camera as { pos?: number[]; target?: number[]; distance?: number } | undefined;
    if (!sp || !cam?.pos || !cam.target) continue;
    const body = h(cam.target, sp.x, sp.z), bad: string[] = [];
    // light-shots moved the camera out of canopy/rock to the nearest clear pose (tools/_clear-view.mts): judged there
    const cleared = (s as any).clearView as ClearViewRecord | undefined;
    if (cleared && "moved" in cleared) {
      const c = Math.hypot(cam.pos[0]! - cleared.to[0], cam.pos[1]! - cleared.to[1], cam.pos[2]! - cleared.to[2]);
      if (c > tol) bad.push(`camera ${c.toFixed(1)} m off its cleared pose`);
      if (body > tol && h(cam.target, sp.camera?.[0] ?? sp.x, sp.camera?.[2] ?? sp.z) > tol) bad.push(`body ${body.toFixed(1)} m from the spot`);
    } else if (Array.isArray(sp.camera) && Array.isArray(sp.target)) {
      const c = Math.hypot(cam.pos[0]! - sp.camera[0]!, cam.pos[1]! - sp.camera[1]!, cam.pos[2]! - sp.camera[2]!);
      if (c > tol) bad.push(`camera ${c.toFixed(1)} m off its fixed pose`);
      if (body > tol && h(cam.target, sp.camera[0]!, sp.camera[2]!) > tol) bad.push(`body ${body.toFixed(1)} m from the spot (the world streamed around [${cam.target.map((v) => Math.round(v)).join(", ")}])`);
    } else {
      if (body > tol) bad.push(`body ${body.toFixed(1)} m from the spot, at [${cam.target.map((v) => Math.round(v)).join(", ")}]`);
      const orbit = h(cam.pos, cam.target[0]!, cam.target[2]!), want = Number(sp.distance ?? cam.distance ?? 4);
      if (orbit > want + tol) bad.push(`camera ${orbit.toFixed(1)} m from the body (orbit ${want} m)`);
    }
    if (bad.length) out.push({ spot: s.spot, time: (s.time as number | null | undefined) ?? null, detail: bad.join("; ") });
  }
  return out;
}

/** Per-spot timing from light-shots' run records (spots[].timing: travel, settle, frames, total seconds and any settle
 *  that hit --settle-max), in shooting order; a later run (the retry) is tagged. */
export function spotTiming(runs: readonly (Run | null | undefined)[]): Array<{ spot: string; retry?: true } & Record<string, unknown>> {
  const out: Array<{ spot: string; retry?: true } & Record<string, unknown>> = [];
  runs.forEach((r, i) => { for (const s of ((r as any)?.spots ?? []) as any[]) if (s?.timing) out.push({ spot: s.name, ...s.timing, ...(i > 0 ? { retry: true as const } : {}) }); });
  return out;
}

/** Drop the named spots' frames from a run (pose faults: re-shot, never kept as evidence). */
export function dropSpots(run: Run, names: ReadonlySet<string>): Run {
  return { ...run, shots: (run.shots ?? []).filter((s) => !names.has(s.spot)), blackFrames: (run.blackFrames ?? []).filter((b) => !names.has(b.replace(/@[^@]*$/, ""))) };
}

/** Merge a retry run into the first: the retry's spots replace (none overlap by construction; a later record wins). */
export function mergeRuns(a: Run, b: Run | null): Run {
  if (!b) return a;
  const again = new Set((b.shots ?? []).map((s) => s.spot));
  return { ...a, shots: [...(a.shots ?? []).filter((s) => !again.has(s.spot)), ...(b.shots ?? [])], blackFrames: [...(a.blackFrames ?? []).filter((x) => !again.has(x.replace(/@[^@]*$/, ""))), ...(b.blackFrames ?? [])] };
}

/** The latest batch evidence record of a job (evidence/live/<batch-id>.json, newest `at`), or null. */
export function latestBatchEvidence(job: string): { file: string; rec: any } | null {
  const d = path.join(job, "evidence", "live");
  if (!fs.existsSync(d)) return null;
  let best: { file: string; rec: any } | null = null;
  for (const f of fs.readdirSync(d).filter((f) => f.endsWith(".json"))) {
    try { const rec = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); if (rec?.source === "render-batch" && (!best || String(rec.at) > String(best.rec.at))) best = { file: path.join(d, f), rec }; } catch { /* not a record */ }
  }
  return best;
}

/** Remove every OTHER batch's record and frame folder from a job's evidence/live/ (one latest batch per place). */
export function pruneOldBatches(job: string, keep: string): void {
  const d = path.join(job, "evidence", "live");
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) if (f !== keep && f !== `${keep}.json`) fs.rmSync(path.join(d, f), { recursive: true, force: true });
}

/** A shot-dependent row (wash, place read, design sample, see-through): judged from the latest batch evidence; never on
 *  the install path. `deferred` = nothing to judge yet (no batch, or the batch predates the ops). */
export type ShotRow = { row: "wash" | "read" | "design-sample" | "see-through"; state: "ok" | "fault" | "deferred"; detail: string };

/** Is the batch evidence current for the job's ops (taken after the newest delivered file)? */
export function batchFresh(rec: { at?: string } | null | undefined, newestOpsMs: number): boolean {
  return !!rec?.at && Date.parse(rec.at) >= newestOpsMs;
}

/** Which evidence a shot row (place-build's wash / place rows) is judged from: the latest batch record when it is current
 *  for the ops, else a lab shots run (`labRun`, light-shots <scene>.json) newer than the ops, else DEFERRED (nothing to
 *  judge yet: ok, never an install block; the batch render after the install judges it). */
export function shotEvidence(job: string, labRun: string): { kind: "batch"; file: string; rec: any } | { kind: "lab"; file: string } | { kind: "deferred"; why: string } {
  const newest = newestOpsMs(job), batch = latestBatchEvidence(job);
  if (batch && batchFresh(batch.rec, newest)) return { kind: "batch", ...batch };
  if (fs.existsSync(labRun) && fs.statSync(labRun).mtimeMs >= newest) return { kind: "lab", file: labRun };
  return { kind: "deferred", why: batch ? `batch ${batch.rec.batch} predates the ops` : "no batch evidence yet" };
}

// -- contact sheet ------------------------------------------------------------------------------------------------------
export const TILE_W = 640, TILE_H = 360, PAD = 8, HEAD = 34, LABEL = 22;
type Img = { width: number; height: number; data: Uint8Array };
function half(img: Img): Img {
  const w = Math.max(1, Math.floor(img.width / 2)), h = Math.max(1, Math.floor(img.height / 2)), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    const i = (yy: number, xx: number) => img.data[((Math.min(img.height - 1, yy) * img.width) + Math.min(img.width - 1, xx)) * 4 + c]!;
    out[(y * w + x) * 4 + c] = (i(2 * y, 2 * x) + i(2 * y, 2 * x + 1) + i(2 * y + 1, 2 * x) + i(2 * y + 1, 2 * x + 1)) >> 2;
  }
  return { width: w, height: h, data: out };
}
/** Fit an image into the tile (halved while bigger, then nearest-sampled to the tile). */
function fit(img: Img): Img {
  let m = img; while (m.width >= TILE_W * 2 && m.height >= TILE_H * 2) m = half(m);
  if (m.width === TILE_W && m.height === TILE_H) return m;
  const out = new Uint8Array(TILE_W * TILE_H * 4);
  for (let y = 0; y < TILE_H; y++) for (let x = 0; x < TILE_W; x++) { const sx = Math.floor((x * m.width) / TILE_W), sy = Math.floor((y * m.height) / TILE_H); out.set(m.data.subarray((sy * m.width + sx) * 4, (sy * m.width + sx) * 4 + 4), (y * TILE_W + x) * 4); }
  return { width: TILE_W, height: TILE_H, data: out };
}
export type SheetTile = { label: string; file?: string | null; note?: string };
/** A contact sheet: a title line, then rows of tiles (the iso pair is row 0 by the caller's order). A missing frame is a
 *  dark tile saying why. */
export function composeSheet(title: string, rows: SheetTile[][], out: string): void {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const W = PAD + cols * (TILE_W + PAD), H = HEAD + rows.length * (TILE_H + LABEL + PAD) + PAD;
  const px = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { px[i * 4] = 18; px[i * 4 + 1] = 19; px[i * 4 + 2] = 22; px[i * 4 + 3] = 255; }
  const text = (s: string, x: number, y: number, scale: number, rgb: [number, number, number]) => drawText(s, x, y, scale, (X: number, Y: number) => { if (X < 0 || Y < 0 || X >= W || Y >= H) return; const i = (Y * W + X) * 4; px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; });
  text(title.slice(0, Math.floor((W - 2 * PAD) / 18)), PAD, 9, 3, [230, 230, 235]);
  rows.forEach((row, r) => row.forEach((t, c) => {
    const x0 = PAD + c * (TILE_W + PAD), y0 = HEAD + r * (TILE_H + LABEL + PAD);
    let img: Img | null = null;
    if (t.file && fs.existsSync(t.file)) { try { img = fit(decodePng(fs.readFileSync(t.file))); } catch { img = null; } }
    if (img) for (let y = 0; y < TILE_H; y++) px.set(img.data.subarray(y * TILE_W * 4, (y + 1) * TILE_W * 4), ((y0 + y) * W + x0) * 4);
    else { for (let y = 0; y < TILE_H; y++) for (let x = 0; x < TILE_W; x++) { const i = ((y0 + y) * W + x0 + x) * 4; px[i] = 40; px[i + 1] = 30; px[i + 2] = 30; } text(t.note ?? "NO FRAME", x0 + 20, y0 + TILE_H / 2 - 10, 3, [235, 120, 110]); }
    const lab = `${t.label}${t.note && img ? `  ${t.note}` : ""}`;
    text(lab.slice(0, Math.floor(TILE_W / 12)), x0, y0 + TILE_H + 5, 2, t.note ? [235, 170, 110] : [200, 200, 205]);
  }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePng(W, H, px));
}
/** The sheet rows of one place: the iso pair first, then one row per close view (noon, then 20:00 when shot). */
export function sheetRows(spots: readonly BatchSpot[], owner: string, frameOf: (view: string, hour: number) => string | null, skipped: ReadonlySet<string>, blank: ReadonlySet<string>): SheetTile[][] {
  const mine = spots.filter((s) => s.name.startsWith(`${owner}${SEP}`)).map((s) => ({ ...s, view: s.name.slice(owner.length + SEP.length) }));
  const tile = (s: { view: string; name: string }, h: number): SheetTile => {
    const f = frameOf(s.view, h), label = `${s.view} ${String(h).padStart(2, "0")}:00`;
    if (skipped.has(s.name)) return { label, file: null, note: "SKIPPED (stalled)" };
    if (!f) return { label, file: null, note: "NO FRAME" };
    return { label, file: f, ...(blank.has(`${s.view}@${h}`) ? { note: "BLANK RENDER" } : {}) };
  };
  const iso = mine.filter((s) => s.review), close = mine.filter((s) => !s.review);
  const rows: SheetTile[][] = [];
  if (iso.length) rows.push(iso.map((s) => tile(s, s.times[0] ?? BATCH_DAY)));
  for (const s of close) rows.push(s.times.map((h) => tile(s, h)));
  return rows;
}
/** The newest mtime of a job's delivered files (what the batch evidence must be newer than). */
export function newestOpsMs(job: string): number {
  return Math.max(0, ...["ops.json", "world-ops.json", "operators.json", "clearings.json"].map((f) => { try { return fs.statSync(path.join(job, f)).mtimeMs; } catch { return 0; } }));
}
export type { V2 };
