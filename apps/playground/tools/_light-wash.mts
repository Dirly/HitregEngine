/**
 * WASH: is a frame washed out by its lights, and do its far fires read by their flame?
 *
 * L (Red Dial 2026-10-30, Derek on the city walk: "so washed out from how bright that lighting is ... whatever we're
 * using to determine this is completely wrong"): the old far-read rule asked only that a fire show more than 4 px at
 * 450 m. An owner passed it by setting `light.glowReach` 800 on 19 beacons at glow 4: halos 10 m across at noon, the
 * near frames a sheet of orange-white. A far read is only a pass when the same frames stay inside the wash band:
 *
 *   - `lower`  mean luma (Rec.709, 0-255 sRGB) of the frame below its top 45 % (the near and middle ground, little sky);
 *   - `clip`   share of the whole frame at luma >= 250 (blown to white);
 *   - `glare`  share of the lower band at luma >= 200 (a halo or a lit fog sheet over the ground).
 *
 * The band is calibrated on accepted frames (docs/place-builder.md "wash"): every limit is in WASH_BAND.
 * A far fire (camera distance >= FAR_FIRE_M) READS when its flame peak stands FIRE_CONTRAST over the ground ring around
 * it and is warm; its GLOW is the radius (px) where the ring falls back within GLOW_EDGE of the background; far
 * fires whose MEDIAN glow is wider than FAR_GLOW_PX_MAX read by a halo, not a flame: a fault.
 */
import sharp from "sharp";

export const WASH_BAND = {
  /** day frames (06-18): mean luma of the near/mid band */
  dayLower: [25, 165] as [number, number],
  /** dusk/night frames */
  nightLower: [6, 95] as [number, number],
  /** blown-white share of the whole frame */
  clipMax: 0.004,
  /** share of the near/mid band at luma >= 200 */
  glareMaxDay: 0.06,
  glareMaxNight: 0.02,
  /** share of the frame the halos + lamp fog glow brighten by >= LIT_DELTA (light-shots --wash) */
  veilMaxDay: 0.1,
  veilMaxNight: 0.12,
};
export const FAR_FIRE_M = 300;
/** past this a standing fire's flame is not drawn (the vfx `cullDistance` the city-fires and torch prefabs set): its
 *  night light still projects, but no flame can read there, so it is not judged (Weeping Sun 2026-10-30: 7 of 15 "far
 *  fires" were other places' lights 1.9-2.4 km out) */
export const FAR_FIRE_MAX_M = 1200;
/** L (Rustgut 2026-11-10: a dungeon door at the bottom of a pit, its working fire and the lip camp's fire hidden by the pit
 *  walls and rim by design, were judged "far fires that do not read"): a fire whose flame the camera cannot see — the ray
 *  from the camera to its light hits something solid well before the fire (light-shots marks it `occluded`) — is not a
 *  far fire in that frame. Only a fire the camera can see is judged by its flame. */
export const isFarFire = (f: { d: number; occluded?: boolean }) => !f.occluded && f.d >= FAR_FIRE_M && f.d <= FAR_FIRE_MAX_M;
/** a far fire reads when its flame peak is this much over the ring around it (luma) and warm (r - b) */
export const FIRE_CONTRAST = 25;
export const FIRE_WARM = 12;
/** a pixel with every channel at or over this is the clipped white core of a cold flame: it carries no hue */
export const COLD_WHITE = 200;
/** the ring falls back to within this of the background: the glow's edge */
export const GLOW_EDGE = 10;
/** the median glow radius (px, 720p frame) of the far fires that read — a flame with a modest glow, never a halo */
export const FAR_GLOW_PX_MAX = 9;
/** share of the in-frame far fires that must read at a dusk/night hour (one behind a tree is fine) */
export const FIRE_READ_MIN_SHARE = 0.75;

export type WashMetrics = { luma: number; lower: number; clip: number; glare: number };
/** `cold`: the fire's light is blue-white (b > r: a spirit fire, the Moon's): its flame is judged by its own hue, b - r */
/** `occluded`: the camera-to-light ray hits a surface more than OCCLUDER_CLEAR_M short of the light (light-shots) */
export type FireSpot = { x: number; y: number; d: number; id?: string; cold?: boolean; occluded?: boolean };
/** a hit this close to the light is the fire's own brazier, logs or basin, never an occluder (m) */
export const OCCLUDER_CLEAR_M = 4;
export type FireRead = FireSpot & { reads: boolean; peak: number; bg: number; glowPx: number; why: string };

export type Raw = { data: Buffer; w: number; h: number; ch: number };
export async function readRaw(file: string): Promise<Raw> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}
const lumaAt = (r: Raw, x: number, y: number) => { const i = (y * r.w + x) * r.ch; return 0.2126 * r.data[i]! + 0.7152 * r.data[i + 1]! + 0.0722 * r.data[i + 2]!; };

export function washMetrics(r: Raw): WashMetrics {
  const y0 = Math.round(r.h * 0.45);
  let all = 0, low = 0, nLow = 0, clip = 0, glare = 0;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const l = lumaAt(r, x, y);
    all += l;
    if (l >= 250) clip++;
    if (y >= y0) { low += l; nLow++; if (l >= 200) glare++; }
  }
  const n = r.w * r.h;
  return { luma: +(all / n).toFixed(1), lower: +(low / nLow).toFixed(1), clip: +(clip / n).toFixed(4), glare: +(glare / nLow).toFixed(4) };
}

export const nightHour = (t: number | null | undefined) => typeof t !== "number" || !Number.isFinite(t) || t >= 19 || t < 6; // no clock (an interior) = the dark band

export function washVerdict(m: WashMetrics, hour: number | null | undefined): { ok: boolean; why: string } {
  const night = nightHour(hour);
  const [lo, hi] = night ? WASH_BAND.nightLower : WASH_BAND.dayLower;
  const glareMax = night ? WASH_BAND.glareMaxNight : WASH_BAND.glareMaxDay;
  const bad: string[] = [];
  if (m.lower > hi) bad.push(`near/mid luma ${m.lower} > ${hi}`);
  if (m.lower < lo) bad.push(`near/mid luma ${m.lower} < ${lo}`);
  if (m.clip > WASH_BAND.clipMax) bad.push(`${(m.clip * 100).toFixed(2)} % blown white > ${(WASH_BAND.clipMax * 100).toFixed(2)} %`);
  if (m.glare > glareMax) bad.push(`${(m.glare * 100).toFixed(1)} % of the ground band >= 200 > ${(glareMax * 100).toFixed(1)} %`);
  return { ok: !bad.length, why: bad.length ? bad.join(", ") : `near/mid ${m.lower}, white ${(m.clip * 100).toFixed(2)} %, glare ${(m.glare * 100).toFixed(1)} %` };
}

/** One projected fire on a frame: does its flame read, and how wide is its glow. */
export function fireRead(r: Raw, f: FireSpot): FireRead {
  const cx = Math.round(f.x), cy = Math.round(f.y);
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < r.w && y < r.h;
  if (!inside(cx, cy)) return { ...f, reads: false, peak: 0, bg: 0, glowPx: 0, why: "off frame" };
  // the flame sits on and above the light (the light is at the flame's middle): search a small box for the peak
  let peak = 0, px = cx, py = cy;
  for (let y = cy - 4; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) if (inside(x, y)) { const l = lumaAt(r, x, y); if (l > peak) { peak = l; px = x; py = y; } }
  // the ring MEDIAN: a neighbouring fire, its lit tower face or the lit ground under it fills a few samples, a halo all
  const ringMean = (rad: number) => { const v: number[] = []; for (let a = 0; a < 24; a++) { const x = Math.round(px + Math.cos((a / 24) * Math.PI * 2) * rad), y = Math.round(py + Math.sin((a / 24) * Math.PI * 2) * rad); if (inside(x, y)) v.push(lumaAt(r, x, y)); } return v.length ? v.sort((p, q) => p - q)[v.length >> 1]! : 0; };
  // background: the median of rings far out (60-80 px), so a wide halo cannot raise its own background
  const far: number[] = []; for (let rad = 60; rad <= 80; rad += 5) far.push(ringMean(rad));
  const bg = far.sort((a, b) => a - b)[far.length >> 1]!;
  let glowPx = 0; for (let rad = 1; rad <= 60; rad++) { if (ringMean(rad) <= bg + GLOW_EDGE) { glowPx = rad; break; } glowPx = rad; }
  const i = (py * r.w + px) * r.ch;
  // a cold (spirit) flame burns WHITE at its core (Moon 2026-10-30: 214,214,214 inside a blue 156,181,206 rim): its hue is
  // the mean b - r of the flame's own coloured pixels round the peak, its lit (>= bg + FIRE_CONTRAST) and unclipped (some
  // channel under COLD_WHITE) ones in a 7x7. Moon 2026-10-31: a farGrow flame's white core filled the old 3x3 while a 2-3 px
  // blue rim (b - r +25..+58) sat round it. A warm flame keeps the peak pixel's own r - b.
  let coldHue = 0;
  if (f.cold) {
    let n = 0;
    for (let y = py - 3; y <= py + 3; y++) for (let x = px - 3; x <= px + 3; x++) {
      if (!inside(x, y)) continue;
      const j = (y * r.w + x) * r.ch, R = r.data[j]!, G = r.data[j + 1]!, B = r.data[j + 2]!;
      if (lumaAt(r, x, y) < bg + FIRE_CONTRAST || Math.min(R, G, B) >= COLD_WHITE) continue;
      coldHue += B - R; n++;
    }
    coldHue = n ? coldHue / n : 0;
  }
  const warm = f.cold ? coldHue : r.data[i]! - r.data[i + 2]!;
  const reads = peak - bg >= FIRE_CONTRAST && warm >= FIRE_WARM;
  return { ...f, reads, peak: Math.round(peak), bg: Math.round(bg), glowPx, why: reads ? `flame ${Math.round(peak)} over ${Math.round(bg)}, glow ${glowPx} px` : peak - bg < FIRE_CONTRAST ? `flame ${Math.round(peak)} only ${Math.round(peak - bg)} over the ground` : f.cold ? "not cold (no spirit flame there)" : "not warm (no flame there)" };
}

/** What a light layer adds: the frame minus the same frame with the layer off — mean luma added, and the net share of
 *  the picture it brightens by LIT_DELTA or more (a halo veil over the ground, a fog sheet). */
export const LIT_DELTA = 20;
export async function layerDelta(withFile: string, withoutFile: string, againFile?: string): Promise<{ luma: number; lit: number }> {
  const a = await readRaw(withFile), b = await readRaw(withoutFile), c = againFile ? await readRaw(againFile) : null;
  // NET: pixels brightened by >= LIT_DELTA minus pixels darkened by as much. Two frames 0.6 s apart differ by moving
  // cloud, grain and flicker in BOTH directions (a far noon frame: 17 % up and 15 % down in its sky rows); a light layer
  // only brightens, so the symmetric noise cancels and the veil remains. With `againFile` (the layer back ON after the
  // off frame) a pixel counts only by what BOTH on-frames agree on: a cloud shadow drifting over the ground between the
  // frames (Red Dial noon: 60-80 % of the ground rows "brightened") moves one way in time and drops out
  let s = 0, up = 0, down = 0; const n = Math.min(a.w * a.h, b.w * b.h);
  for (let i = 0; i < n; i++) { const x = i % a.w, y = (i / a.w) | 0; const off = lumaAt(b, x, y), d0 = lumaAt(a, x, y) - off, d = c ? (Math.sign(d0) === Math.sign(lumaAt(c, x, y) - off) ? Math.sign(d0) * Math.min(Math.abs(d0), Math.abs(lumaAt(c, x, y) - off)) : 0) : d0; s += d; if (d >= LIT_DELTA) up++; else if (d <= -LIT_DELTA) down++; }
  return { luma: +(s / n).toFixed(1), lit: +(Math.max(0, up - down) / n).toFixed(4) };
}

/** One fire carries several lights (the flame vfx light, a prefab beacon light metres above it): lights within
 *  FIRE_MERGE_M of each other (same distance, screen gap under that span at vfov 60) are one fire, judged at the LOWEST
 *  (the flame; the beacon light hangs over it). */
export const FIRE_MERGE_M = 8;
export function oneLightPerFire(fires: FireSpot[], frameH: number): FireSpot[] {
  const focal = frameH / 2 / Math.tan(Math.PI / 6), out: FireSpot[] = [];
  for (const f of [...fires].sort((a, b) => b.y - a.y)) {
    const span = (FIRE_MERGE_M * focal) / Math.max(1, f.d) + 2;
    if (!out.some((g) => Math.abs(g.d - f.d) < FIRE_MERGE_M && Math.hypot(g.x - f.x, g.y - f.y) < span)) out.push(f);
  }
  return out;
}

export type FrameWash = { spot: string; time: number | null; wash: WashMetrics; washOk: boolean; washWhy: string; firesHidden?: number; fires?: { far: number; read: number; wideGlow: number; rows: FireRead[] }; veil?: { luma: number; lit: number } };

/** A light-shots frame: its wash and its far fires. */
export async function judgeFrame(file: string, spot: string, time: number | null, fires: FireSpot[] = []): Promise<FrameWash> {
  const r = await readRaw(file);
  const wash = washMetrics(r), v = washVerdict(wash, time);
  const far = oneLightPerFire(fires.filter(isFarFire), r.h);
  const out: FrameWash = { spot, time, wash, washOk: v.ok, washWhy: v.why };
  const hidden = fires.filter((f) => f.occluded && f.d >= FAR_FIRE_M && f.d <= FAR_FIRE_MAX_M).length;
  if (hidden) out.firesHidden = hidden;
  if (far.length) {
    const rows = far.map((f) => fireRead(r, f));
    out.fires = { far: far.length, read: rows.filter((x) => x.reads).length, wideGlow: rows.filter((x) => x.reads && x.glowPx > FAR_GLOW_PX_MAX).length, rows };
  }
  return out;
}

/**
 * The verdict over a run: every frame inside the band, and wherever far fires are in frame at a dusk/night hour, at
 * least FIRE_READ_MIN_SHARE of them read by their flame with no wide glow. `wantFireRead` = the place must read by fire
 * from afar (it has fires and far views).
 */
export function washRun(frames: FrameWash[], wantFireRead: boolean): { ok: boolean; faults: string[]; fireLine: string; veilLine: string } {
  const faults = frames.filter((f) => !f.washOk).map((f) => `${f.spot}@${f.time ?? "-"}: ${f.washWhy}`);
  // the veil: what the halos + lamp fog glow alone brighten (the -no-veil frame)
  const veiled = frames.filter((f) => f.veil);
  for (const f of veiled) {
    const max = nightHour(f.time) ? WASH_BAND.veilMaxNight : WASH_BAND.veilMaxDay;
    if (f.veil!.lit > max) faults.push(`${f.spot}@${f.time ?? "-"}: halos + fog glow brighten ${(f.veil!.lit * 100).toFixed(1)} % of the frame by >= ${LIT_DELTA} > ${(max * 100).toFixed(1)} % (a halo wash: lower light.glow, drop glowReach)`);
  }
  const veilLine = veiled.length ? `veil max ${(Math.max(...veiled.map((f) => f.veil!.lit)) * 100).toFixed(1)} % of a frame` : "no veil frames (light-shots --wash)";
  const night = frames.filter((f) => f.fires && nightHour(f.time));
  let fireLine = "no far fires in frame";
  if (night.length) {
    const far = night.reduce((s, f) => s + f.fires!.far, 0), read = night.reduce((s, f) => s + f.fires!.read, 0);
    // the MEDIAN glow of the reading fires: the nearest few legitimately light the haze round them (lamp fog glow, ~20 px
    // at 350-420 m); a halo model shows in every fire (Red Dial before: median ~19 px, after: 3 px)
    const glows = night.flatMap((f) => f.fires!.rows.filter((r) => r.reads).map((r) => r.glowPx)).sort((a, b) => a - b);
    const glowMedian = glows.length ? glows[glows.length >> 1]! : 0;
    fireLine = `far fires at dusk/night: ${read}/${far} read by flame, median glow ${glowMedian} px`;
    if (read < far * FIRE_READ_MIN_SHARE) faults.push(`${fireLine} (< ${Math.round(FIRE_READ_MIN_SHARE * 100)} %): a beacon reads by its FLAME (a bigger fire, a higher seat), never by its halo`);
    if (glowMedian > FAR_GLOW_PX_MAX) faults.push(`far fires read by a glow ${glowMedian} px wide (median) > ${FAR_GLOW_PX_MAX} px: a halo, not a flame (lower light.glow)`);
  } else if (wantFireRead && frames.some((f) => nightHour(f.time))) faults.push("no far fire in any dusk/night frame: the place's fires do not show from its far views");
  return { ok: !faults.length, faults, fireLine, veilLine };
}

/** A REVIEW-ONLY view or shot record (Derek 2026-10-31: place-build's iso-* overviews, high cameras showing the whole
 *  place): flagged `review: true` (light-shots copies a spot's flag onto its records) or named iso-*. Never judged by the
 *  wash band, the far-fire read, the failed-render or the missing-view checks. */
export const isReviewShot = (s: { review?: unknown; spot?: unknown; name?: unknown }) => s.review === true || /^iso-/.test(String(s.spot ?? s.name ?? ""));
/** Judge a light-shots run (its <stem>.json beside the frames) or a folder of <spot>-<hh>.png frames (iso-* skipped). */
export async function judgeRun(target: string): Promise<{ frames: FrameWash[]; wantFireRead: boolean }> {
  const fs = await import("node:fs"), path = await import("node:path");
  const frames: FrameWash[] = [];
  if (target.endsWith(".json")) {
    const run = JSON.parse(fs.readFileSync(target, "utf8"));
    for (const s of run.shots ?? []) {
      if (isReviewShot(s)) continue; // a review-only overview (iso-*): not player-height evidence
      const file = path.join(path.dirname(target), s.file), f = await judgeFrame(file, s.spot, s.time ?? null, s.fires ?? []);
      if (s.layers?.["no-veil"]) f.veil = await layerDelta(file, path.join(path.dirname(target), s.layers["no-veil"]), s.layers["no-veil-on"] ? path.join(path.dirname(target), s.layers["no-veil-on"]) : undefined);
      frames.push(f);
    }
    return { frames, wantFireRead: (run.shots ?? []).some((s: any) => !isReviewShot(s) && (s.fires ?? []).some(isFarFire)) };
  }
  for (const f of fs.readdirSync(target).filter((f: string) => /-\d\d\.png$/.test(f) && !isReviewShot({ spot: f })).sort()) {
    const m = /^(.*)-(\d\d)\.png$/.exec(f)!;
    frames.push(await judgeFrame(path.join(target, f), m[1]!, +m[2]!));
  }
  return { frames, wantFireRead: false };
}

// CLI: npx tsx tools/_light-wash.mts <run.json | frames dir> [...]  — the wash band per frame, then the run verdict
if (process.argv[1] && /_light-wash\.mts$/.test(process.argv[1])) {
  let bad = 0;
  for (const t of process.argv.slice(2)) {
    const { frames, wantFireRead } = await judgeRun(t);
    console.log(t);
    for (const f of frames) console.log(`  ${f.washOk ? "ok  " : "WASH"} ${(f.spot + "@" + (f.time ?? "-")).padEnd(28)} luma ${String(f.wash.luma).padStart(5)}  near/mid ${String(f.wash.lower).padStart(5)}  white ${(f.wash.clip * 100).toFixed(2).padStart(5)} %  glare ${(f.wash.glare * 100).toFixed(1).padStart(5)} %${f.veil ? `  veil ${(f.veil.lit * 100).toFixed(1)} %` : ""}${f.fires ? `  far fires ${f.fires.read}/${f.fires.far} read, glow px ${f.fires.rows.filter((r) => r.reads).map((r) => r.glowPx).join(",")}` : ""}`);
    const v = washRun(frames, wantFireRead);
    console.log(`  => ${v.ok ? "ok" : "FAIL"}: ${v.fireLine}; ${v.veilLine}`);
    for (const f of v.faults.slice(0, 8)) console.log(`     ${f}`);
    if (!v.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

/**
 * Dated wash rulings (a place's quality-exceptions.json rows with gates ["wash"]): r-found 2026-10-31, the wash gate never
 * read them although the place / scale / zfight gates do, so Red Dial's two 2026-10-30 coordinator rulings (an evidence
 * close-up looking into two beacons; far fires behind the woodland Derek wants) failed it every run. A row EXCUSES:
 *   match { spot: "<view>" }      every fault of that view's frames ("<view>@<hour>: ...")
 *   match { rule: "far-fires" }   the far-fire read ("far fires ..." / "no far fire ...")
 * Only rows with a dated `ruling` count; excused faults are returned to be reported, never dropped silently.
 */
export type WashRuling = { id?: string; gates?: string[]; ruling?: string; match?: { spot?: string; rule?: string } };
export function excuseWashFaults(faults: readonly string[], rows: readonly WashRuling[]): { faults: string[]; excused: { fault: string; by: string }[] } {
  const dated = rows.filter((r) => (r.gates ?? []).includes("wash") && typeof r.ruling === "string" && /\b20\d\d-\d\d-\d\d\b/.test(r.ruling) && r.match && (r.match.spot || r.match.rule === "far-fires"));
  const by = (f: string) => dated.find((r) => (r.match!.spot && f.startsWith(`${r.match!.spot}@`)) || (r.match!.rule === "far-fires" && /^(far fires|no far fire)/.test(f)));
  const out: string[] = [], excused: { fault: string; by: string }[] = [];
  for (const f of faults) { const r = by(f); if (r) excused.push({ fault: f, by: r.id ?? "?" }); else out.push(f); }
  return { faults: out, excused };
}
