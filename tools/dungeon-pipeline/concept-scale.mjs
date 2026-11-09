/**
 * concept-scale — measure a concept painting in metres, and hold the build to it.
 *
 * Rooms sized from a written room sheet came out a third of the painted size (Moon-Deep 2026-11-01: "look at the size of
 * the first concept art and compare it with what was made"; Red Dial 2026-10-30, the same fault). Each painting has a
 * figure in it. The figure is a 1.8 m ruler, and the painting's eye line gives the camera height. Every painted size is
 * then read through a pinhole camera.
 *
 *   node ../../../../tools/dungeon-pipeline/concept-scale.mjs [measure]   (from projects/<id>)
 *       authoring/concept/<painting>.marks.json  ->  authoring/concept-sizes.json  +  reports/concept-scale/<painting>.png
 *       (the painting with every mark drawn on it: LOOK at it, a mark placed by eye is only as good as the overlay)
 *   node ../../../../tools/dungeon-pipeline/concept-scale.mjs gate
 *       authoring/concept-sizes.json vs authoring/built-sizes.mjs  ->  reports/scale.json  (exit 1 when it fails)
 *
 * ---- the marks file (pixel coordinates [x, y] on the painting, y down) ----------------------------------------------
 *   { "painting": "vigil-hall", "image": "<painting path, relative to the project folder>", "room": "<plan room id>",
 *     "px": 4,              how far off an eye-placed mark may be (px; jittered for the uncertainty), default 4
 *     "horizonPx": 10,      the same for the eye line (the hardest mark), default 2.5 x px
 *     "horizon": 455,       the eye line: the row where the floor's receding lines meet (= the camera's height in the room)
 *     "vanish": [800, 455], optional: the vanishing point of the room's main axis (its x gives the camera's yaw off the axis)
 *     "figure": { "head": [x, y], "feet": [x, y], "height": [1.7, 1.9] },   the painted person (top of head, between the feet)
 *     "fov": { "vfov": 60, "unc": 10 }                  the painting's vertical field of view, a guess with its uncertainty, OR
 *     "fov": { "square": { "near": [[x, y], [x, y]], "far": [[x, y], [x, y]], "ratio": 1 } }   a floor rectangle (a floor
 *            tile, a grid bay) whose depth / width is `ratio`: its near and far edges solve the focal length
 *     "measures": [ { "key": "columnHeight", "kind": "height", "top": [x, y], "foot": [x, y], "ground": [x, y]?, "room"?, "gate"?: false, "note"? } ] }
 *
 * Measure kinds (the camera is level and the painting's verticals are vertical: a level pinhole with a shifted frame):
 *   height  a vertical from `foot` up to `top`; `ground` is a point ON THE FIGURE'S FLOOR PLANE at the same depth
 *           (default: the foot itself). Something standing on a lower or higher floor (a temple front across a pool)
 *           names the figure-floor point straight below or in front of it. h = H * (foot.y - top.y) / (ground.y - horizon)
 *   width   a level span between `a` and `b` at one depth (column spacing at mid-height, a door's width, wall to wall);
 *           `ground` as above (default: `a`, when a and b sit on the floor). w = H * |b.x - a.x| / (ground.y - horizon)
 *   floor   the distance between two points on the figure's floor plane at any depths (needs the field of view)
 *   depth   the same, along the view only (how far the far wall is behind the near one)
 * Any measure may sit on ANOTHER level: "plane": metres above the figure's floor (-1.5 = a pool rim below the figure's
 * terrace; its ground point is then on that level), "planeUnc": how sure (jittered).
 * Camera height H = figure * (feet.y - horizon) / (feet.y - head.y): the figure solves it without the field of view.
 * Heights and widths do not need the field of view at all; floor / depth and the camera's distance behind the figure do.
 * A measure with "gate": false is reported (and drawn) but never fails the gate: a guess too loose to hold a build to.
 *
 * ---- the size table (authoring/concept-sizes.json) -------------------------------------------------------------------
 *   paintings.<name>.camera: height, vfov, focal (px), pitchDeg (down), yawDeg (axis right of centre), figure distance and
 *     lateral offset (m, camera frame), each with an uncertainty; rooms.<room>.<key>: { m, lo, hi, unc, painting, kind }.
 *   lo / hi are the 5th / 95th percentiles over 600 jittered re-measures (every mark +-px, the eye line +-horizonPx, the
 *   figure over its height range, the fov over its range); unc = (hi - lo) / 2 / m.
 *
 * ---- the gate (authoring/built-sizes.mjs) ---------------------------------------------------------------------------
 *   The project exports `builtSizes()` -> { <room>: { <key>: metres | { m, why } } }: what its plan / kit actually
 *   builds, read from the same data the builder reads (never typed in twice). Every gated painted size must have a
 *   built one within +-tolerance (thresholds.json scale.tolerance, 0.15): a missing or off size FAILS the stage.
 *
 * ---- a person in the grey box ----------------------------------------------------------------------------------------
 *   paintingCamera(camera, { feet: [x, y, z], facing }) puts the solved camera behind and above a figure standing at
 *   `feet` (the place the painted figure stands in the BUILT room), the hall's axis along compass `facing` (0 = -Z north,
 *   90 = +X east): { camera, target, fov, figure, figureFacing } for a light-shots spot ("figure" stands the real player
 *   model there, tools/light-shots.mts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = 600;

/** small seeded PRNG (mulberry32): the same marks give the same uncertainty every run */
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const seedOf = (s) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Solve one painting with exact marks: the camera, then every measure. `size` = [width, height] of the image.
 * Returns { camera: {...}, values: { <i>: metres } } — pure, no I/O (the test drives it with a synthetic camera).
 */
export function solve(marks, size) {
  const [W, Hpx] = size, cx = W / 2, cy = Hpx / 2, h = marks.horizon;
  const fig = marks.figure, figH = typeof fig.height === "number" ? fig.height : 1.8;
  const below = (y) => y - h; // rows below the eye line (the floor is below it)
  const H = figH * below(fig.feet[1]) / (fig.feet[1] - fig.head[1]);
  // focal length (px): from a floor rectangle of known proportions, else from the guessed vertical fov
  let f;
  const sq = marks.fov?.square;
  if (sq) {
    const yn = (sq.near[0][1] + sq.near[1][1]) / 2, yf = (sq.far[0][1] + sq.far[1][1]) / 2;
    const wNear = H * Math.abs(sq.near[1][0] - sq.near[0][0]) / below(yn);
    f = (wNear * (sq.ratio ?? 1)) / (H * (1 / below(yf) - 1 / below(yn)));
  } else f = cy / Math.tan(((marks.fov?.vfov ?? 60) * Math.PI) / 360);
  // a measure on another floor level (a pool rim below the figure's terrace) names it: plane = metres above the figure's floor
  const floorPt = (p, plane = 0) => { const d = below(p[1]), k = H - plane; return { x: (k * (p[0] - cx)) / d, z: (f * k) / d }; };
  const values = (marks.measures ?? []).map((m) => {
    const ground = m.ground ?? (m.kind === "height" ? m.foot : m.a);
    const k = H - (m.plane ?? 0);
    if (m.kind === "height") return (k * (m.foot[1] - m.top[1])) / below(ground[1]);
    if (m.kind === "width") return (k * Math.abs(m.b[0] - m.a[0])) / below(ground[1]);
    const a = floorPt(m.a, m.plane), b = floorPt(m.b, m.plane);
    if (m.kind === "floor") return Math.hypot(b.x - a.x, b.z - a.z);
    if (m.kind === "depth") return Math.abs(b.z - a.z);
    throw new Error(`measure ${m.key}: unknown kind ${m.kind} (height | width | floor | depth)`);
  });
  const feet = floorPt(fig.feet);
  const vfov = (2 * Math.atan(cy / f) * 180) / Math.PI;
  const pitchDeg = (Math.atan((cy - h) / f) * 180) / Math.PI; // + = looking down (eye line above the frame's centre)
  const yawDeg = marks.vanish ? (Math.atan((marks.vanish[0] - cx) / f) * 180) / Math.PI : 0; // + = the axis runs right of centre
  return { camera: { height: H, focal: f, vfov, pitchDeg, yawDeg, figureDistance: feet.z, figureLateral: feet.x }, values };
}

/** jitter every mark; return the nominal solve plus 5th / 95th percentiles of each output */
export function measure(marks, size) {
  const nominal = solve(marks, size);
  const px = marks.px ?? 4, hpx = marks.horizonPx ?? px * 2.5;
  const fh = Array.isArray(marks.figure.height) ? marks.figure.height : [marks.figure.height ?? 1.7, marks.figure.height ?? 1.9];
  const rand = rng(seedOf(marks.painting ?? "painting"));
  const j = (p) => (Array.isArray(p) && typeof p[0] === "number" ? [p[0] + (rand() * 2 - 1) * px, p[1] + (rand() * 2 - 1) * px] : Array.isArray(p) ? p.map(j) : p);
  const jitter = (o) => (Array.isArray(o) ? j(o) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, jitter(v)])) : o);
  const cams = [], vals = (marks.measures ?? []).map(() => []);
  for (let s = 0; s < SAMPLES; s++) {
    const m = jitter({ ...marks, figure: { head: marks.figure.head, feet: marks.figure.feet } });
    m.horizon = marks.horizon + (rand() * 2 - 1) * hpx;
    m.figure.height = fh[0] + rand() * (fh[1] - fh[0]);
    m.measures = m.measures?.map((q, i) => (marks.measures[i].planeUnc ? { ...q, plane: (marks.measures[i].plane ?? 0) + (rand() * 2 - 1) * marks.measures[i].planeUnc } : q));
    if (marks.fov && !marks.fov.square) m.fov = { vfov: (marks.fov.vfov ?? 60) + (rand() * 2 - 1) * (marks.fov.unc ?? 10) };
    else if (!marks.fov) m.fov = { vfov: 60 + (rand() * 2 - 1) * 15 };
    try { const r = solve(m, size); if (![r.camera.height, r.camera.focal].every((v) => Number.isFinite(v) && v > 0)) continue; cams.push(r.camera); r.values.forEach((v, i) => Number.isFinite(v) && v > 0 && vals[i].push(v)); } catch { /* a jitter across the eye line: skip */ }
  }
  const band = (nom, xs) => { const lo = pct(xs, 0.05), hi = pct(xs, 0.95); return { m: r2(nom), lo: r2(lo), hi: r2(hi), unc: r2((hi - lo) / 2 / Math.abs(nom || 1)) }; };
  const camera = Object.fromEntries(Object.keys(nominal.camera).map((k) => [k, band(nominal.camera[k], cams.map((c) => c[k]))]));
  const measures = (marks.measures ?? []).map((m, i) => ({ key: m.key, kind: m.kind, room: m.room ?? marks.room, gate: m.gate !== false, note: m.note, ...band(nominal.values[i], vals[i]) }));
  return { camera, measures };
}

/**
 * The solved painting camera put into a built room: behind and above a figure standing at `feet` [x, y, z], the room's
 * axis along compass `facing` (deg: 0 = -Z, 90 = +X). `camera` is a concept-sizes.json painting camera ({ height: {m},
 * ... } or plain numbers). Returns a light-shots fixed-camera spot body: { camera, target, fov, figure, figureFacing }.
 */
export function paintingCamera(camera, { feet, facing = 0 }) {
  const v = (k) => (typeof camera[k] === "number" ? camera[k] : camera[k].m);
  const look = ((facing - v("yawDeg")) * Math.PI) / 180; // the camera turns away from the axis the painting sees off-centre
  const fx = Math.sin(look), fz = -Math.cos(look), rx = -fz, rz = fx;
  const Z = v("figureDistance"), X = v("figureLateral");
  const cam = [feet[0] - fx * Z - rx * X, feet[1] + v("height"), feet[2] - fz * Z - rz * X];
  const down = Math.tan((v("pitchDeg") * Math.PI) / 180) * 20;
  return { camera: cam.map(r2), target: [r2(cam[0] + fx * 20), r2(cam[1] - down), r2(cam[2] + fz * 20)], fov: r2(v("vfov")), figure: feet.map(r2), figureFacing: r2(((facing % 360) + 360) % 360) };
}

// ---- overlay: the marks drawn on the painting ------------------------------------------------------------------------
async function overlay(sharp, img, marks, res, out) {
  const meta = await sharp(img).metadata(), W = meta.width, Hh = meta.height;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const COLORS = ["#ff5a5a", "#ffb02e", "#5ad1ff", "#7dff6a", "#ff7af0", "#c9a2ff", "#ffe14d", "#4dffd2", "#ff9c6b", "#9cb8ff"];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}" font-family="DejaVu Sans, Arial" font-size="15">`;
  const label = (x, y, t, c) => { const w = t.length * 8.4 + 8; s += `<rect x="${x}" y="${y - 15}" width="${w}" height="20" fill="#000" fill-opacity="0.72"/><text x="${x + 4}" y="${y}" fill="${c}">${esc(t)}</text>`; };
  const dot = (p, c) => { s += `<circle cx="${p[0]}" cy="${p[1]}" r="5" fill="none" stroke="${c}" stroke-width="2"/>`; };
  const line = (a, b, c, dash = "") => { s += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="3" ${dash ? `stroke-dasharray="${dash}"` : ""}/>`; };
  line([0, marks.horizon], [W, marks.horizon], "#00e5ff", "14 8");
  const cam = res.camera;
  label(8, marks.horizon - 6, `eye line: camera ${cam.height.m} m (${cam.height.lo}-${cam.height.hi}), vfov ${cam.vfov.m} deg, pitch ${cam.pitchDeg.m} deg`, "#00e5ff");
  if (marks.vanish) dot(marks.vanish, "#00e5ff");
  line(marks.figure.head, marks.figure.feet, "#ffffff"); dot(marks.figure.head, "#fff"); dot(marks.figure.feet, "#fff");
  label(marks.figure.feet[0] + 10, marks.figure.feet[1], `figure 1.8 m, ${cam.figureDistance.m} m away`, "#ffffff");
  const sq = marks.fov?.square;
  if (sq) { const [n0, n1] = sq.near, [f0, f1] = sq.far; s += `<polygon points="${[n0, n1, f1, f0].map((p) => p.join(",")).join(" ")}" fill="#7dff6a" fill-opacity="0.18" stroke="#7dff6a" stroke-width="2"/>`; label(f1[0] + 6, f1[1], `fov square (ratio ${sq.ratio ?? 1})`, "#7dff6a"); }
  (marks.measures ?? []).forEach((m, i) => {
    const c = COLORS[i % COLORS.length], r = res.measures[i], txt = `${m.key} ${r.m} m (${r.lo}-${r.hi})${r.gate ? "" : " [advisory]"}`;
    const [a, b] = m.kind === "height" ? [m.foot, m.top] : [m.a, m.b];
    line(a, b, c, m.kind === "floor" || m.kind === "depth" ? "6 5" : ""); dot(a, c); dot(b, c);
    if (m.ground) { line(m.ground, m.kind === "height" ? m.foot : m.a, c, "2 6"); dot(m.ground, c); }
    const lx = Math.min(W - txt.length * 8.4 - 12, Math.max(4, (a[0] + b[0]) / 2 + 8)), ly = Math.max(18, Math.min(Hh - 6, (a[1] + b[1]) / 2 + (i % 3) * 18));
    label(lx, ly, txt, c);
  });
  s += "</svg>";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(img).composite([{ input: Buffer.from(s), left: 0, top: 0 }]).png().toFile(out);
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const tolerance = () => { try { return readJson(path.join(HERE, "thresholds.json")).scale?.tolerance ?? 0.15; } catch { return 0.15; } };

/** measure every authoring/concept/*.marks.json of a project into authoring/concept-sizes.json (+ overlays) */
export async function measureProject(root, { overlays = true } = {}) {
  const dir = path.join(root, "authoring/concept");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".marks.json")).sort() : [];
  const sharp = (await import(new URL("../../apps/playground/node_modules/sharp/lib/index.js", import.meta.url).href)).default;
  const paintings = {}, rooms = {};
  for (const f of files) {
    const marks = readJson(path.join(dir, f)), name = marks.painting ?? f.replace(/\.marks\.json$/, "");
    const img = path.resolve(root, marks.image);
    const meta = await sharp(img).metadata();
    const res = measure(marks, [meta.width, meta.height]);
    paintings[name] = { room: marks.room, image: marks.image, size: [meta.width, meta.height], camera: res.camera, overlay: `reports/concept-scale/${name}.png` };
    for (const m of res.measures) (rooms[m.room] ??= {})[m.key] = { m: m.m, lo: m.lo, hi: m.hi, unc: m.unc, kind: m.kind, painting: name, ...(m.gate ? {} : { gate: false }), ...(m.note ? { note: m.note } : {}) };
    if (overlays) await overlay(sharp, img, marks, res, path.join(root, "reports/concept-scale", `${name}.png`));
  }
  const out = { about: "painted sizes in metres, measured through each painting's camera with its figure as a 1.8 m ruler (tools/dungeon-pipeline/concept-scale.mjs); lo/hi = 5th/95th percentile over jittered marks", at: new Date().toISOString(), tolerance: tolerance(), paintings, rooms };
  fs.writeFileSync(path.join(root, "authoring/concept-sizes.json"), JSON.stringify(out, null, 1) + "\n");
  return out;
}

/** the gate: built sizes vs painted sizes -> reports/scale.json ({ passed, failures, rows }) */
export async function gateProject(root) {
  const tol = tolerance(), report = path.join(root, "reports/scale.json");
  const write = (j) => { fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), tolerance: tol, ...j }, null, 1) + "\n"); return j; };
  const sizesF = path.join(root, "authoring/concept-sizes.json"), builtF = path.join(root, "authoring/built-sizes.mjs");
  if (!fs.existsSync(sizesF)) return write({ passed: false, failures: [{ what: "no authoring/concept-sizes.json: mark each painting (authoring/concept/<painting>.marks.json) and run concept-scale.mjs measure" }], rows: [] });
  if (!fs.existsSync(builtF)) return write({ passed: false, failures: [{ what: "no authoring/built-sizes.mjs (export builtSizes(): { room: { key: metres } } from the plan / kit data)" }], rows: [] });
  const painted = readJson(sizesF);
  const built = await (await import(new URL(`file:///${builtF.split(path.sep).join("/")}?t=${Date.now()}`).href)).builtSizes();
  const rows = [], failures = [];
  for (const [room, keys] of Object.entries(painted.rooms ?? {})) for (const [key, p] of Object.entries(keys)) {
    const b = built?.[room]?.[key], bm = typeof b === "number" ? b : b?.m;
    const ratio = Number.isFinite(bm) ? bm / p.m : null, ok = ratio !== null && Math.abs(ratio - 1) <= tol;
    rows.push({ room, key, painted: p.m, lo: p.lo, hi: p.hi, built: Number.isFinite(bm) ? r2(bm) : null, ratio: ratio === null ? null : r2(ratio), gate: p.gate !== false, ok, painting: p.painting, ...(b?.why ? { why: b.why } : {}) });
    if (!ok && p.gate !== false) failures.push({ what: ratio === null ? `${room}.${key}: painted ${p.m} m (${p.painting}), built size not reported by built-sizes.mjs` : `${room}.${key}: built ${r2(bm)} m vs painted ${p.m} m (${p.lo}-${p.hi}, ${p.painting}): ${ratio > 1 ? "+" : ""}${Math.round((ratio - 1) * 100)}%, outside +-${Math.round(tol * 100)}%` });
  }
  if (!rows.length) failures.push({ what: "concept-sizes.json measures nothing" });
  return write({ passed: failures.length === 0, failures, rows });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? "measure", root = process.cwd();
  if (cmd === "measure") {
    const out = await measureProject(root, { overlays: !process.argv.includes("--no-overlays") });
    for (const [n, p] of Object.entries(out.paintings)) {
      const c = p.camera;
      console.log(`${n} (${p.room}): camera ${c.height.m} m (${c.height.lo}-${c.height.hi}), vfov ${c.vfov.m}, pitch ${c.pitchDeg.m}, figure ${c.figureDistance.m} m ahead  -> ${p.overlay}`);
    }
    for (const [room, keys] of Object.entries(out.rooms)) for (const [k, v] of Object.entries(keys)) console.log(`  ${room.padEnd(14)} ${k.padEnd(18)} ${String(v.m).padStart(7)} m  (${v.lo}-${v.hi}, +-${Math.round(v.unc * 100)}%)${v.gate === false ? "  advisory" : ""}`);
    if (!Object.keys(out.paintings).length) { console.log("no authoring/concept/*.marks.json"); process.exit(1); }
  } else if (cmd === "gate") {
    const r = await gateProject(root);
    for (const row of r.rows) console.log(`${row.ok ? "ok  " : row.gate ? "FAIL" : "adv "} ${row.room.padEnd(14)} ${row.key.padEnd(18)} painted ${String(row.painted).padStart(6)}  built ${String(row.built ?? "-").padStart(6)}  ${row.ratio === null ? "" : `x${row.ratio}`}`);
    console.log(r.passed ? "scale: PASSED" : `scale: FAILED (${r.failures.length})\n${r.failures.map((f) => `  - ${f.what}`).join("\n")}`);
    process.exit(r.passed ? 0 : 1);
  } else { console.error("usage: concept-scale.mjs [measure [--no-overlays] | gate]   (from projects/<id>)"); process.exit(2); }
}
