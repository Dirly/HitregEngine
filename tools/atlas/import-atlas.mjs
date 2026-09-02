/**
 * Armor-atlas importer.
 *
 * Takes a flat UV colour-key sheet plus a generated artwork sheet painted
 * loosely over it, and produces a clean, correctly-registered atlas at the
 * target resolution.
 *
 * Pipeline (the order is load-bearing):
 *   1. read the key, derive exact per-island masks (the key is flat colour)
 *   2. classify the transparency key colour on the artwork at SOURCE res, with
 *      hysteresis, so anti-aliased and shaded key pixels resolve correctly
 *   3. register each island: a global fit, then a per-island nudge
 *   4. resample the artwork into each island footprint plus a bleed margin
 *   5. area-average downsample to the target size, alpha-weighted
 *   6. bleed: dilate colour outward into gutters and inward under alpha 0
 *
 * Zero dependencies; PNG i/o is tools/atlas/png.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./png.mjs";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { slices: false, artMargin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--slices") out.slices = true;
    else if (a === "--art-margin") out.artMargin = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.key || !args.art) {
  console.error(
    "usage: node tools/atlas/import-atlas.mjs --key <key.png> --art <art.png> " +
      "[--manifest m.json] [--out dir] [--size 256] [--bleed 8] [--slices]",
  );
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(args.manifest ?? path.join(here, "manifest.json"), "utf8"));
const SIZE = Number(args.size ?? manifest.size ?? 256);
const BLEED = Number(args.bleed ?? manifest.bleed ?? 8);
const OUT = args.out ?? path.join(here, "out");
fs.mkdirSync(OUT, { recursive: true });

const keyImg = decodePng(fs.readFileSync(args.key));
const artImg = decodePng(fs.readFileSync(args.art));
if (keyImg.width !== artImg.width || keyImg.height !== artImg.height) {
  console.error(`key ${keyImg.width}x${keyImg.height} and art ${artImg.width}x${artImg.height} must match`);
  process.exit(1);
}
const W = keyImg.width;
const H = keyImg.height;
const N = W * H;

// ---------------------------------------------------------------------------
// 1. islands from the key
// ---------------------------------------------------------------------------

const hex = (r, g, b) => "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");

const islandOf = new Int16Array(N).fill(-1);
const islands = [];
const byHex = new Map();

for (let i = 0; i < N; i++) {
  const r = keyImg.data[i * 4];
  const g = keyImg.data[i * 4 + 1];
  const b = keyImg.data[i * 4 + 2];
  if (r > 245 && g > 245 && b > 245) continue; // background
  const h = hex(r, g, b);
  let id = byHex.get(h);
  if (id === undefined) {
    const slot = manifest.slots[h];
    id = islands.length;
    byHex.set(h, id);
    islands.push({
      id,
      hex: h,
      name: slot?.name ?? `unmapped-${h.slice(1)}`,
      transparency: slot?.transparency ?? false,
      known: Boolean(slot),
      px: [],
      area: 0,
      cx: 0,
      cy: 0,
      cyanHits: 0,
    });
  }
  const isl = islands[id];
  islandOf[i] = id;
  isl.px.push(i);
  isl.area++;
  isl.cx += i % W;
  isl.cy += (i / W) | 0;
}

// A nominally flat key can still have antialiased boundaries. Occasionally an
// edge blend lands exactly on another slot's key colour; those few pixels then
// become a disconnected part of the wrong island and can move its centroid or
// explode its bounding box. Keep every substantial connected component (some
// real slots have multiple pieces), but discard tiny disconnected colour
// contaminants before registration. The largest component is always retained.
const keyContaminants = [];
{
  const seen = new Uint8Array(N);
  for (const isl of islands) {
    const components = [];
    for (const start of isl.px) {
      if (seen[start]) continue;
      const component = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        component.push(i);
        const x = i % W;
        const y = (i / W) | 0;
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue;
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const next = ny * W + nx;
            if (islandOf[next] === isl.id && !seen[next]) {
              seen[next] = 1;
              stack.push(next);
            }
          }
      }
      components.push(component);
    }

    components.sort((a, b) => b.length - a.length);
    const originalArea = isl.area;
    const minFraction = Number(
      manifest.slots[isl.hex]?.minKeyComponentFraction ?? manifest.minKeyComponentFraction ?? 0.005,
    );
    const kept = [];
    let removed = 0;
    for (let c = 0; c < components.length; c++) {
      const component = components[c];
      if (c === 0 || component.length / originalArea >= minFraction) {
        kept.push(...component);
      } else {
        removed += component.length;
        for (const i of component) islandOf[i] = -1;
      }
    }
    if (removed) keyContaminants.push({ name: isl.name, pixels: removed });
    isl.px = kept;
    isl.area = kept.length;
    isl.cx = 0;
    isl.cy = 0;
    for (const i of kept) {
      isl.cx += i % W;
      isl.cy += (i / W) | 0;
    }
  }
}
for (const isl of islands) {
  isl.cx /= isl.area;
  isl.cy /= isl.area;
}
const byId = islands.slice();
islands.sort((a, b) => b.area - a.area);

// A set need not fill every slot — a kit with no robe, or no hood, simply does
// not paint those regions. Skipped islands are dropped entirely: they are not
// registered, their texels are not claimed, and the gutter around them falls to
// whichever islands remain.
const skipped = new Set(String(args.skip ?? "").split(",").map((s) => s.trim()).filter(Boolean));
if (skipped.size) {
  for (let i = 0; i < N; i++) {
    const id = islandOf[i];
    if (id >= 0 && skipped.has(byId[id].name)) islandOf[i] = -1;
  }
  for (let i = islands.length - 1; i >= 0; i--) {
    if (skipped.has(islands[i].name)) islands.splice(i, 1);
  }
  console.log(`skipping ${[...skipped].join(", ")} — not present in this set`);
}

const unmapped = islands.filter((i) => !i.known);
if (unmapped.length) {
  console.warn(`! island colours missing from the manifest: ${unmapped.map((i) => i.hex).join(", ")}`);
}

// ---------------------------------------------------------------------------
// 2. transparency pass: key colour -> alpha, at source resolution
// ---------------------------------------------------------------------------

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx <= 1e-6 ? 0 : d / mx, mx];
}

const keyHex = manifest.keyColor ?? "#00ffff";
const [KEY_HUE] = rgbToHsv(
  parseInt(keyHex.slice(1, 3), 16),
  parseInt(keyHex.slice(3, 5), 16),
  parseInt(keyHex.slice(5, 7), 16),
);

const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

const scale = W / SIZE;

// hysteresis: strong seeds, weak grows out from them
const BG_LUM = Number(args["bg-lum"] ?? manifest.bgLum ?? 200);
const BG_SAT = Number(args["bg-sat"] ?? manifest.bgSat ?? 0.18);

const strong = new Uint8Array(N);
const weak = new Uint8Array(N);
const painted = new Uint8Array(N);
const bgCandidate = new Uint8Array(N);
const bg = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const r = artImg.data[i * 4];
  const g = artImg.data[i * 4 + 1];
  const b = artImg.data[i * 4 + 2];
  const [h, s, v] = rgbToHsv(r, g, b);
  const dh = hueDist(h, KEY_HUE);
  if (dh < 15 && s > 0.55 && v > 0.55) strong[i] = 1;
  if (dh < 30 && s > 0.3 && v > 0.35) weak[i] = 1;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum > BG_LUM && s < BG_SAT) bgCandidate[i] = 1;
}

// The ground is found by FLOOD FILL from the image border, not by a per-pixel
// brightness test. Generators feather each piece into the ground through a wide
// soft band (200-235 luminance here), and a fixed threshold leaves that band
// classified as artwork — it then survives as a bright rim inside the island
// and gets copied outward by the padding as white streaks. Flooding catches the
// whole band, while connectivity keeps a specular highlight in the middle of a
// breastplate safe: bright, but not connected to the edge of the sheet.
{
  const stack = [];
  const seed = (i) => {
    if (bgCandidate[i] && !bg[i]) {
      bg[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < W; x++) {
    seed(x);
    seed((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    seed(y * W);
    seed(y * W + W - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const y = (i / W) | 0;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        seed(ny * W + nx);
      }
  }
}
for (let i = 0; i < N; i++) painted[i] = bg[i] ? 0 : 1;

const cyan = new Uint8Array(N);
{
  const stack = [];
  for (let i = 0; i < N; i++) {
    if (strong[i]) {
      cyan[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % W;
    const y = (i / W) | 0;
    if (x > 0 && weak[i - 1] && !cyan[i - 1]) { cyan[i - 1] = 1; stack.push(i - 1); }
    if (x < W - 1 && weak[i + 1] && !cyan[i + 1]) { cyan[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && weak[i - W] && !cyan[i - W]) { cyan[i - W] = 1; stack.push(i - W); }
    if (y < H - 1 && weak[i + W] && !cyan[i + W]) { cyan[i + W] = 1; stack.push(i + W); }
  }
}

/** Remove connected components smaller than minSide^2. Returns the count removed. */
function dropSpeckle(mask, minSide) {
  const seen = new Uint8Array(N);
  const minArea = minSide * minSide;
  let removed = 0;
  for (let start = 0; start < N; start++) {
    if (!mask[start] || seen[start]) continue;
    const comp = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % W;
      const y = (i / W) | 0;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; stack.push(i - W); }
      if (y < H - 1 && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; stack.push(i + W); }
    }
    if (comp.length < minArea) {
      for (const i of comp) mask[i] = 0;
      removed++;
    }
  }
  return removed;
}

const speckleRemoved = dropSpeckle(cyan, Math.max(3, Math.round(2 * scale)));

/** Grow a mask by `passes` pixels (4-connected). */
function grow(mask, passes) {
  let cur = mask;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (cur[i]) { next[i] = 1; continue; }
      const x = i % W;
      const y = (i / W) | 0;
      if ((x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) || (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) next[i] = 1;
    }
    cur = next;
  }
  return cur;
}

/** Shrink a mask by `passes` pixels (4-connected). */
function shrink(mask, passes) {
  let cur = mask;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!cur[i]) continue;
      const x = i % W;
      const y = (i / W) | 0;
      if (x === 0 || x === W - 1 || y === 0 || y === H - 1) continue;
      if (cur[i - 1] && cur[i + 1] && cur[i - W] && cur[i + W]) next[i] = 1;
    }
    cur = next;
  }
  return cur;
}

// Art pixels touching the cut are contaminated with the key colour. Mark a thin
// band as colour-invalid so the bleed refills it from clean interior colour.
const fringe = new Uint8Array(N);
{
  const grown = grow(cyan, Math.max(1, Math.round(1.5 * scale)));
  for (let i = 0; i < N; i++) if (grown[i] && !cyan[i]) fringe[i] = 1;
}

// Eroded painted mask, used only by the registration cost, so the soft
// drop-shadow halo the generator draws around each piece is not counted as
// coverage.
const paintedCore = shrink(painted, Math.max(1, Math.round(0.8 * scale)));

// The same contamination the cut edge has, but against the white ground:
// generators feather every piece into a soft halo, and a pixel inside that
// halo is a blend of garment and background. Reading one as a colour source
// drags the padding light — measured at +20 to +50 luminance over the island
// it came from. Rejecting a band inward from the ground is palette-agnostic,
// unlike a brightness threshold, which would eat a genuinely white garment.
const GROUND_FRINGE = Number(args["ground-fringe"] ?? manifest.groundFringe ?? 3);
const groundFringe = new Uint8Array(N); // contaminated: not authored, not a seed
const groundFringeSeed = new Uint8Array(N); // one band wider: not a seed either
{
  const near = grow(bg, Math.max(1, Math.round(GROUND_FRINGE * scale)));
  const wide = grow(bg, Math.max(2, Math.round((GROUND_FRINGE + 1.5) * scale)));
  for (let i = 0; i < N; i++) {
    if (near[i] && painted[i]) groundFringe[i] = 1;
    if (wide[i] && painted[i]) groundFringeSeed[i] = 1;
  }
}

// ---------------------------------------------------------------------------
// 3. registration
// ---------------------------------------------------------------------------

function samplePixels(px, count) {
  if (px.length <= count) return px;
  const step = px.length / count;
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = px[(i * step) | 0];
  return out;
}

// How far a piece is allowed to have drifted. Generators vary a lot in layout
// discipline: a well-behaved sheet lands within a few pixels, a loose one puts
// a piece 100+px from its region. Too small a range and badly-placed artwork is
// simply unreachable; too large and small islands can lock onto a neighbour.
const SEARCH = Number(args.search ?? manifest.search ?? 0.1);
const MAX_SHIFT = Math.round(SEARCH * W);

/**
 * Asymmetric coverage cost: every texel of the island must land on painted
 * artwork. Artwork spilling BEYOND the island is free — that spill is the bleed
 * margin, and on a transparency island the key-colour field is legitimately
 * larger than the island itself. Regularisers keep the nudge minimal so the fit
 * cannot cheat by shrinking the island onto a dark blob.
 */
function uncovered(sample, cx, cy, dx, dy, sx, sy) {
  let miss = 0;
  for (const p of sample) {
    const px = p % W;
    const py = (p / W) | 0;
    const ax = cx + (px - cx) / sx - dx;
    const ay = cy + (py - cy) / sy - dy;
    const ix = Math.round(ax);
    const iy = Math.round(ay);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H || !paintedCore[iy * W + ix]) miss++;
  }
  return miss / sample.length;
}

function cost(sample, cx, cy, dx, dy, sx, sy) {
  const scalePen = (Math.abs(Math.log(sx)) + Math.abs(Math.log(sy))) / Math.log(1.12);
  const shiftPen = (Math.abs(dx) + Math.abs(dy)) / MAX_SHIFT;
  return uncovered(sample, cx, cy, dx, dy, sx, sy) + 0.04 * scalePen + 0.02 * shiftPen;
}

function search(sample, cx, cy, init, stages) {
  let best = { ...init, cost: cost(sample, cx, cy, init.dx, init.dy, init.sx, init.sy) };
  for (const st of stages) {
    const b = { ...best };
    for (let dx = b.dx - st.t; dx <= b.dx + st.t + 1e-9; dx += st.ts)
      for (let dy = b.dy - st.t; dy <= b.dy + st.t + 1e-9; dy += st.ts)
        for (let sx = b.sx - st.s; sx <= b.sx + st.s + 1e-9; sx += st.ss)
          for (let sy = b.sy - st.s; sy <= b.sy + st.s + 1e-9; sy += st.ss) {
            const c = cost(sample, cx, cy, dx, dy, sx, sy);
            if (c < best.cost) best = { dx, dy, sx, sy, cost: c };
          }
  }
  return best;
}

// global pre-alignment (uniform scale, whole sheet)
const allPx = samplePixels(
  islands.flatMap((i) => samplePixels(i.px, 800)),
  6000,
);
const gcx = W / 2;
const gcy = H / 2;
let global = { dx: 0, dy: 0, sx: 1, sy: 1 };
{
  let best = { ...global, cost: cost(allPx, gcx, gcy, 0, 0, 1, 1) };
  const G = Math.round(MAX_SHIFT * 0.7);
  for (let dx = -G; dx <= G; dx += 8)
    for (let dy = -G; dy <= G; dy += 8)
      for (let s = 0.94; s <= 1.061; s += 0.02) {
        const c = cost(allPx, gcx, gcy, dx, dy, s, s);
        if (c < best.cost) best = { dx, dy, sx: s, sy: s, cost: c };
      }
  global = search(allPx, gcx, gcy, best, [{ t: 8, ts: 2, s: 0.02, ss: 0.01 }]);
}

for (const isl of islands) {
  const sample = samplePixels(isl.px, 3000);
  isl.sample = sample;
  isl.baseUncovered = uncovered(sample, isl.cx, isl.cy, 0, 0, 1, 1);
  const seed = {
    dx: global.dx + ((global.sx - 1) * (isl.cx - gcx)) / global.sx,
    dy: global.dy + ((global.sy - 1) * (isl.cy - gcy)) / global.sy,
    sx: global.sx,
    sy: global.sy,
  };
  const T = Math.max(18, Math.round(MAX_SHIFT * 0.5));
  isl.fit = search(sample, isl.cx, isl.cy, seed, [
    { t: T, ts: Math.max(4, Math.round(T / 5)), s: 0.04, ss: 0.02 },
    { t: 18, ts: 6, s: 0.04, ss: 0.02 },
    { t: 6, ts: 2, s: 0.02, ss: 0.01 },
    { t: 2, ts: 1, s: 0.01, ss: 0.005 },
  ]);
  isl.uncovered = uncovered(sample, isl.cx, isl.cy, isl.fit.dx, isl.fit.dy, isl.fit.sx, isl.fit.sy);
}

// ---------------------------------------------------------------------------
// contain fit
// ---------------------------------------------------------------------------
//
// Nudging assumes the generator drew a piece at roughly the right size. When it
// does not — a tasset painted twice the length of its bar, an ornament drawn
// larger than its square — nudging can only slide the island around inside the
// oversized artwork, and everything past the island is cropped away.
//
// A slot marked `"fit": "contain"` in the manifest is scaled instead: find the
// artwork belonging to this island, and map its bounding box onto the island.
// Aspect is NOT preserved by default, and that is deliberate — the island is a
// UV footprint, so a tall panel squashed into a short bar is stretched back out
// by the mesh. Use "contain-uniform" to keep aspect and letterbox instead.

// The artwork silhouette excludes the key colour: two panels sharing one
// key-colour field must read as two pieces, not one. Both the contain fit and
// the overhang scan need to tell one piece from the piece next to it.
const solid = new Uint8Array(N);
const label = new Int32Array(N).fill(-1);
const boxes = [];
{
  for (let i = 0; i < N; i++) solid[i] = painted[i] && !cyan[i] ? 1 : 0;
  const stack = new Int32Array(N);
  for (let start = 0; start < N; start++) {
    if (!solid[start] || label[start] >= 0) continue;
    const id = boxes.length;
    const box = { minX: W, minY: H, maxX: 0, maxY: 0, area: 0 };
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % W;
      const y = (i / W) | 0;
      box.area++;
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nd = ny * W + nx;
          if (solid[nd] && label[nd] < 0) {
            label[nd] = id;
            stack[sp++] = nd;
          }
        }
    }
    boxes.push(box);
  }
}

/** The solid components an island genuinely rests on. */
function componentsUnder(isl, minFrac = 0.05) {
  const hits = new Map();
  for (const p of isl.sample) {
    const px = p % W;
    const py = (p / W) | 0;
    const ax = Math.round(isl.cx + (px - isl.cx) / isl.fit.sx - isl.fit.dx);
    const ay = Math.round(isl.cy + (py - isl.cy) / isl.fit.sy - isl.fit.dy);
    if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
    const l = label[ay * W + ax];
    if (l >= 0) hits.set(l, (hits.get(l) ?? 0) + 1);
  }
  return new Set(
    [...hits.entries()].filter(([, n]) => n / isl.sample.length >= minFrac).map(([l]) => l),
  );
}

const containIslands = islands.filter((i) => manifest.slots[i.hex]?.fit?.startsWith("contain"));
{
  for (const isl of containIslands) {
    // island bounding box in key space
    let ix0 = W;
    let iy0 = H;
    let ix1 = 0;
    let iy1 = 0;
    for (const p of isl.px) {
      const x = p % W;
      const y = (p / W) | 0;
      if (x < ix0) ix0 = x;
      if (x > ix1) ix1 = x;
      if (y < iy0) iy0 = y;
      if (y > iy1) iy1 = y;
    }

    // which artwork components does the island currently sit on?
    const hits = new Map();
    for (const p of isl.sample) {
      const px = p % W;
      const py = (p / W) | 0;
      const ax = Math.round(isl.cx + (px - isl.cx) / isl.fit.sx - isl.fit.dx);
      const ay = Math.round(isl.cy + (py - isl.cy) / isl.fit.sy - isl.fit.dy);
      if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
      const l = label[ay * W + ax];
      if (l >= 0) hits.set(l, (hits.get(l) ?? 0) + 1);
    }
    // keep only components the island genuinely rests on, so a neighbouring
    // piece clipped by the sample window cannot drag the box open
    const keep = [...hits.entries()].filter(([, n]) => n / isl.sample.length >= 0.05);
    if (!keep.length) {
      isl.containSkipped = "no artwork found under the island";
      continue;
    }
    let bx0 = W;
    let by0 = H;
    let bx1 = 0;
    let by1 = 0;
    for (const [l] of keep) {
      const b = boxes[l];
      if (b.minX < bx0) bx0 = b.minX;
      if (b.minY < by0) by0 = b.minY;
      if (b.maxX > bx1) bx1 = b.maxX;
      if (b.maxY > by1) by1 = b.maxY;
    }

    // Clip to a window around where the island actually sits. A component can
    // be long, or merged with its neighbour, and an unclipped box drags a piece
    // from the far end of the sheet into this island's fit.
    {
      const expand = Number(manifest.slots[isl.hex].fitSearch ?? manifest.fitSearch ?? 2.5);
      let sx0 = W;
      let sy0 = H;
      let sx1 = 0;
      let sy1 = 0;
      for (const p of isl.sample) {
        const px = p % W;
        const py = (p / W) | 0;
        const ax = Math.round(isl.cx + (px - isl.cx) / isl.fit.sx - isl.fit.dx);
        const ay = Math.round(isl.cy + (py - isl.cy) / isl.fit.sy - isl.fit.dy);
        if (ax < sx0) sx0 = ax;
        if (ax > sx1) sx1 = ax;
        if (ay < sy0) sy0 = ay;
        if (ay > sy1) sy1 = ay;
      }
      const mx = (sx0 + sx1) / 2;
      const my = (sy0 + sy1) / 2;
      const hw = ((sx1 - sx0) * expand) / 2;
      const hh = ((sy1 - sy0) * expand) / 2;
      bx0 = Math.max(bx0, mx - hw);
      bx1 = Math.min(bx1, mx + hw);
      by0 = Math.max(by0, my - hh);
      by1 = Math.min(by1, my + hh);
    }

    const slot = manifest.slots[isl.hex];

    // Inset: the artwork is deliberately fitted SMALLER than its island. A cut
    // piece needs clear key-colour all round it — if the ring touches the
    // island edge there is no transparent margin, and the padding pass has
    // nothing to work with at that edge.
    // Capped per axis: a flat inset is fine on a big island and ruinous on a
    // narrow one — 3 texels each side of a 15-texel tasset bar eats 40% of its
    // width and the artwork ends up a sliver.
    // Inset exists so a CUT piece has clear key colour around it. An opaque
    // piece wants none: insetting it just trades authored art for padding, and
    // on a thin island — a belt bar is 8 texels tall at 256 — it eats a third
    // of the region.
    const want = Number(slot.fitPadding ?? manifest.fitPadding ?? (isl.transparency ? 3 : 0)) * scale;
    const insetX = Math.min(want, 0.15 * (ix1 - ix0));
    const insetY = Math.min(want, 0.15 * (iy1 - iy0));
    const iw = Math.max(1, ix1 - ix0 - 2 * insetX);
    const ih = Math.max(1, iy1 - iy0 - 2 * insetY);
    const bw = Math.max(1, bx1 - bx0);
    const bh = Math.max(1, by1 - by0);
    let sx = iw / bw;
    let sy = ih / bh;
    if (slot.fit === "contain-uniform") {
      const s = Math.min(sx, sy);
      sx = s;
      sy = s;
    }

    // Anchor: which point of the artwork is pinned to which point of the
    // island. A tasset hangs from the belt, so it anchors "top" — the attached
    // edge stays put and any size error is absorbed at the free hem instead of
    // being split half and half.
    const anchor = String(slot.anchor ?? "center").toLowerCase();
    const has = (t) => anchor.includes(t);
    const pick = (lo, hi, artLo, artHi, low, high, pad) =>
      low ? [lo + pad, artLo] : high ? [hi - pad, artHi] : [(lo + hi) / 2, (artLo + artHi) / 2];
    const [iax, bax] = pick(ix0, ix1, bx0, bx1, has("left"), has("right"), insetX);
    const [iay, bay] = pick(iy0, iy1, by0, by1, has("top"), has("bottom"), insetY);

    isl.fit = {
      sx,
      sy,
      dx: isl.cx + (iax - isl.cx) / sx - bax,
      dy: isl.cy + (iay - isl.cy) / sy - bay,
      cost: 0,
    };
    if (process.env.ATLAS_DEBUG) console.error(`[fit] ${isl.name} keep=${keep.map(([l,n])=>l+":"+n).join(",")} art=[${Math.round(bx0)},${Math.round(by0)}..${Math.round(bx1)},${Math.round(by1)}] bw=${Math.round(bx1-bx0)} bh=${Math.round(by1-by0)} island=[${ix0},${iy0}..${ix1},${iy1}]`);
    // A contain fit declares "this island shows exactly this box of artwork".
    // Outside it there is nothing — and without the clamp the inset margin
    // extrapolates straight into whatever is painted next door. That is how the
    // tasset margin ended up sampling the neighbouring panel and coming back
    // opaque gold where it should have been cut.
    isl.artClip = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    isl.contained = {
      sx: +sx.toFixed(3),
      sy: +sy.toFixed(3),
      anchor,
      insetX: +(insetX / scale).toFixed(1),
      insetY: +(insetY / scale).toFixed(1),
    };
    isl.uncovered = uncovered(isl.sample, isl.cx, isl.cy, isl.fit.dx, isl.fit.dy, isl.fit.sx, isl.fit.sy);
  }
}

// ---------------------------------------------------------------------------
// anchor without resize
// ---------------------------------------------------------------------------
//
// An anchor is not only a contain-fit concern. A tasset hangs from the belt, so
// its attached edge has to meet the top of its island whether or not the piece
// was rescaled — otherwise a nudge that is optimal on average still leaves a
// gap at the waist and eats the hem. This pins the anchored edge, keeping the
// translation the registration found on the free axis and its scale untouched.

for (const isl of islands) {
  const slot = manifest.slots[isl.hex];
  if (!slot?.anchor || isl.contained) continue;
  const anchor = String(slot.anchor).toLowerCase();

  let ix0 = W;
  let iy0 = H;
  let ix1 = 0;
  let iy1 = 0;
  for (const p of isl.px) {
    const x = p % W;
    const y = (p / W) | 0;
    if (x < ix0) ix0 = x;
    if (x > ix1) ix1 = x;
    if (y < iy0) iy0 = y;
    if (y > iy1) iy1 = y;
  }

  // island footprint in artwork space under the fit the registration chose
  let ax0 = W;
  let ay0 = H;
  let ax1 = 0;
  let ay1 = 0;
  for (const p of isl.sample) {
    const px = p % W;
    const py = (p / W) | 0;
    const ax = Math.round(isl.cx + (px - isl.cx) / isl.fit.sx - isl.fit.dx);
    const ay = Math.round(isl.cy + (py - isl.cy) / isl.fit.sy - isl.fit.dy);
    if (ax < ax0) ax0 = ax;
    if (ax > ax1) ax1 = ax;
    if (ay < ay0) ay0 = ay;
    if (ay > ay1) ay1 = ay;
  }
  if (ax1 < ax0) continue;

  const mine = componentsUnder(isl);
  if (!mine.size) continue;
  const density = (fixed, axis, from, to) => {
    let hit = 0;
    let total = 0;
    for (let v = from; v <= to; v++) {
      const i = axis === "row" ? fixed * W + v : v * W + fixed;
      if (i < 0 || i >= N) continue;
      total++;
      if (solid[i] && mine.has(label[i])) hit++;
    }
    return total ? hit / total : 0;
  };

  /** first line, scanning in `step`, where this island's artwork actually starts */
  const findEdge = (from, limit, step, axis, lo, hi) => {
    for (let v = from; step > 0 ? v <= limit : v >= limit; v += step) {
      if (density(v, axis, lo, hi) >= 0.3) return v;
    }
    return null;
  };

  const want = Number(slot.fitPadding ?? manifest.fitPadding ?? (isl.transparency ? 3 : 0)) * scale;
  const insetX = Math.min(want, 0.15 * (ix1 - ix0));
  const insetY = Math.min(want, 0.15 * (iy1 - iy0));
  const spanY = iy1 - iy0;
  const spanX = ix1 - ix0;
  let moved = null;

  if (anchor.includes("top")) {
    const e = findEdge(Math.max(0, ay0 - spanY), ay1, 1, "row", ax0, ax1);
    if (e !== null) {
      isl.fit.dy = isl.cy + (iy0 + insetY - isl.cy) / isl.fit.sy - e;
      moved = `top -> ${e}`;
    }
  } else if (anchor.includes("bottom")) {
    const e = findEdge(Math.min(H - 1, ay1 + spanY), ay0, -1, "row", ax0, ax1);
    if (e !== null) {
      isl.fit.dy = isl.cy + (iy1 - insetY - isl.cy) / isl.fit.sy - e;
      moved = `bottom -> ${e}`;
    }
  }
  if (anchor.includes("left")) {
    const e = findEdge(Math.max(0, ax0 - spanX), ax1, 1, "col", ay0, ay1);
    if (e !== null) {
      isl.fit.dx = isl.cx + (ix0 + insetX - isl.cx) / isl.fit.sx - e;
      moved = `${moved ? moved + ", " : ""}left -> ${e}`;
    }
  } else if (anchor.includes("right")) {
    const e = findEdge(Math.min(W - 1, ax1 + spanX), ax0, -1, "col", ay0, ay1);
    if (e !== null) {
      isl.fit.dx = isl.cx + (ix1 - insetX - isl.cx) / isl.fit.sx - e;
      moved = `${moved ? moved + ", " : ""}right -> ${e}`;
    }
  }

  if (moved) {
    isl.anchored = anchor;
    isl.uncovered = uncovered(isl.sample, isl.cx, isl.cy, isl.fit.dx, isl.fit.dy, isl.fit.sx, isl.fit.sy);
  }
}

// ---------------------------------------------------------------------------
// artwork overhang
// ---------------------------------------------------------------------------
//
// The importer crops silently. If the generator paints a piece much larger than
// its island — a tasset drawn twice the length of its bar, say — everything
// past the island is discarded, and nothing in the output shows that it
// happened; the fray simply never arrives. Measure how far each island's
// artwork runs past the island so it becomes a warning instead of a mystery.

const OVERHANG_LIMIT = Number(args.overhang ?? manifest.overhangLimit ?? BLEED);
{
  // Scan outward from each island edge and count how far the artwork keeps
  // going. Connected components are the wrong tool here: pieces that touch, or
  // a pair of panels sharing one key-colour field, merge into a single blob and
  // report each other's extent as overhang.
  const DENSITY = 0.3; // a row still counts as artwork above this fill fraction

  // every island's footprint in artwork space, so a scan can tell when it has
  // wandered into the piece next door
  for (const isl of islands) {
    let ax0 = W;
    let ay0 = H;
    let ax1 = 0;
    let ay1 = 0;
    for (const p of isl.px) {
      const px = p % W;
      const py = (p / W) | 0;
      const ax = Math.round(isl.cx + (px - isl.cx) / isl.fit.sx - isl.fit.dx);
      const ay = Math.round(isl.cy + (py - isl.cy) / isl.fit.sy - isl.fit.dy);
      if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
      if (ax < ax0) ax0 = ax;
      if (ax > ax1) ax1 = ax;
      if (ay < ay0) ay0 = ay;
      if (ay > ay1) ay1 = ay;
    }
    isl.artBox = ax1 < ax0 ? null : { ax0, ay0, ax1, ay1 };
  }

  for (const isl of islands) {
    if (!isl.artBox) {
      isl.overhang = { left: 0, right: 0, top: 0, bottom: 0, max: 0 };
      continue;
    }
    const { ax0, ay0, ax1, ay1 } = isl.artBox;

    /** true once a scan line has crossed into another island's footprint */
    const foreign = (fixed, axis, from, to) => {
      for (const other of islands) {
        if (other === isl || !other.artBox) continue;
        const b = other.artBox;
        if (axis === "row") {
          if (fixed < b.ay0 || fixed > b.ay1) continue;
          if (Math.min(to, b.ax1) - Math.max(from, b.ax0) > 0.4 * (to - from)) return true;
        } else {
          if (fixed < b.ax0 || fixed > b.ax1) continue;
          if (Math.min(to, b.ay1) - Math.max(from, b.ay0) > 0.4 * (to - from)) return true;
        }
      }
      return false;
    };

    // Only this island's own artwork counts. Without the component filter the
    // scan walks straight off the chest into the pants above it and reports
    // the neighbour's height as overhang.
    const mine = componentsUnder(isl);
    const density = (fixed, axis, from, to) => {
      let hit = 0;
      let total = 0;
      for (let v = from; v <= to; v++) {
        const i = axis === "row" ? fixed * W + v : v * W + fixed;
        total++;
        if (solid[i] && mine.has(label[i])) hit++;
      }
      return total ? hit / total : 0;
    };

    const run = (step, limit, probe) => {
      let k = 0;
      while (k < limit && probe(k + 1) >= DENSITY) k++;
      return Math.round(k / scale);
    };

    const vLimit = Math.round(0.35 * H);
    const hLimit = Math.round(0.35 * W);
    const probeRow = (y) =>
      y < 0 || y >= H || foreign(y, "row", ax0, ax1) ? 0 : density(y, "row", ax0, ax1);
    const probeCol = (x) =>
      x < 0 || x >= W || foreign(x, "col", ay0, ay1) ? 0 : density(x, "col", ay0, ay1);
    const o = {
      top: run(-1, vLimit, (k) => probeRow(ay0 - k)),
      bottom: run(1, vLimit, (k) => probeRow(ay1 + k)),
      left: run(-1, hLimit, (k) => probeCol(ax0 - k)),
      right: run(1, hLimit, (k) => probeCol(ax1 + k)),
    };
    o.max = Math.max(o.left, o.right, o.top, o.bottom);
    isl.overhang = o;
  }
}

// ---------------------------------------------------------------------------
// 4. resample into each island footprint + margin
// ---------------------------------------------------------------------------

const MARGIN = Math.ceil(BLEED * scale);
const ART_MARGIN = Boolean(args.artMargin);

// Source footprint each destination pixel covers under this island's fit. At
// scale 1 it is a single sample; a contain fit that halves the artwork makes it
// a 3x3 average, which is what keeps a shrunk fray from aliasing away.
for (const isl of islands) {
  isl.boxW = Math.max(1, Math.round(1 / isl.fit.sx)) | 1;
  isl.boxH = Math.max(1, Math.round(1 / isl.fit.sy)) | 1;
}

// grow the island map by MARGIN so real painted colour lands in the gutter
const grownOf = Int16Array.from(islandOf);
{
  let frontier = [];
  for (let i = 0; i < N; i++) if (islandOf[i] >= 0) frontier.push(i);
  for (let pass = 0; pass < MARGIN && frontier.length; pass++) {
    const next = [];
    for (const i of frontier) {
      const x = i % W;
      const y = (i / W) | 0;
      const id = grownOf[i];
      const push = (j) => {
        if (grownOf[j] < 0) {
          grownOf[j] = id;
          next.push(j);
        }
      };
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
    }
    frontier = next;
  }
}

const srcRGB = new Uint8Array(N * 3);
const srcAlpha = new Uint8Array(N);
const srcColorOk = new Uint8Array(N); // usable colour — kept as authored art
const srcColorClean = new Uint8Array(N); // uncontaminated — may seed the padding

const rgbTmp = new Float64Array(3);
function bilinear(x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  rgbTmp[0] = rgbTmp[1] = rgbTmp[2] = 0;
  for (let dy = 0; dy <= 1; dy++)
    for (let dx = 0; dx <= 1; dx++) {
      const sx = Math.min(W - 1, Math.max(0, x0 + dx));
      const sy = Math.min(H - 1, Math.max(0, y0 + dy));
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      const s = (sy * W + sx) * 4;
      rgbTmp[0] += artImg.data[s] * w;
      rgbTmp[1] += artImg.data[s + 1] * w;
      rgbTmp[2] += artImg.data[s + 2] * w;
    }
}

for (let i = 0; i < N; i++) {
  const id = grownOf[i];
  if (id < 0) continue;
  const isl = byId[id];
  const px = i % W;
  const py = (i / W) | 0;
  const ax = isl.cx + (px - isl.cx) / isl.fit.sx - isl.fit.dx;
  const ay = isl.cy + (py - isl.cy) / isl.fit.sy - isl.fit.dy;
  const ix = Math.round(ax);
  const iy = Math.round(ay);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
  const s = iy * W + ix;

  const clip = isl.artClip;
  if (clip && (ax < clip.x0 || ax > clip.x1 || ay < clip.y0 || ay > clip.y1)) {
    srcAlpha[i] = isl.transparency ? 0 : 255;
    srcColorOk[i] = 0;
    srcColorClean[i] = 0;
    if (islandOf[i] >= 0 && isl.transparency) isl.cyanHits++;
    continue;
  }

  // Inside a cut-capable island, anything that is not artwork is a hole —
  // whether the generator marked it with the key colour or simply left it as
  // bare ground. Generators routinely key the outside of a piece and forget
  // the gaps between the fray teeth; this makes those cut anyway.
  const hole = (j) => (isl.transparency && (cyan[j] || bg[j]) ? 1 : 0);

  // When a contain fit shrinks the artwork, one source sample per destination
  // pixel throws away most of it and the alpha mask aliases — a frayed hem
  // fitted at 0.48 loses every second tooth before the downsample ever runs.
  // Average over the source footprint the fit implies instead.
  if (isl.boxW > 1 || isl.boxH > 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let holes = 0;
    let ok = 0;
    let clean = 0;
    let total = 0;
    const hx = (isl.boxW - 1) / 2;
    const hy = (isl.boxH - 1) / 2;
    for (let oy = -hy; oy <= hy; oy++)
      for (let ox = -hx; ox <= hx; ox++) {
        const sx2 = Math.min(W - 1, Math.max(0, Math.round(ax + ox)));
        const sy2 = Math.min(H - 1, Math.max(0, Math.round(ay + oy)));
        const j = sy2 * W + sx2;
        total++;
        holes += hole(j);
        if (painted[j] && !cyan[j] && !fringe[j] && !groundFringe[j]) {
          r += artImg.data[j * 4];
          g += artImg.data[j * 4 + 1];
          b += artImg.data[j * 4 + 2];
          ok++;
          if (!groundFringeSeed[j]) clean++;
        }
      }
    if (ok > 0) {
      srcRGB[i * 3] = Math.round(r / ok);
      srcRGB[i * 3 + 1] = Math.round(g / ok);
      srcRGB[i * 3 + 2] = Math.round(b / ok);
    } else {
      bilinear(ax, ay);
      srcRGB[i * 3] = rgbTmp[0];
      srcRGB[i * 3 + 1] = rgbTmp[1];
      srcRGB[i * 3 + 2] = rgbTmp[2];
    }
    srcAlpha[i] = Math.round(255 * (1 - holes / total));
    const trustBox = ART_MARGIN ? grownOf[i] >= 0 : islandOf[i] >= 0;
    srcColorOk[i] = trustBox && ok / total >= 0.5 ? 1 : 0;
    srcColorClean[i] = srcColorOk[i] && clean / total >= 0.5 ? 1 : 0;
    if (islandOf[i] >= 0 && holes / total >= 0.5) isl.cyanHits++;
    continue;
  }

  bilinear(ax, ay);
  srcRGB[i * 3] = rgbTmp[0];
  srcRGB[i * 3 + 1] = rgbTmp[1];
  srcRGB[i * 3 + 2] = rgbTmp[2];
  const isHole = hole(s) === 1;
  srcAlpha[i] = isHole ? 0 : 255;
  // Colour is only trusted INSIDE the true island. Generators draw a soft
  // drop-shadow halo around each piece, and sampling that into the gutter
  // bleeds white instead of garment colour. The margin is synthesised by the
  // bleed pass instead — unless the sheet was generated against a DILATED key,
  // in which case the over-painted margin is real artwork and worth keeping.
  const trustColour = ART_MARGIN ? grownOf[i] >= 0 : islandOf[i] >= 0;
  // A pixel inside the ground fringe is a blend with the background, not
  // garment — it is neither kept as authored art nor allowed to seed the
  // padding. Seeds are held one band further in again.
  srcColorOk[i] = trustColour && painted[s] && !cyan[s] && !fringe[s] && !groundFringe[s] ? 1 : 0;
  srcColorClean[i] = srcColorOk[i] && !groundFringeSeed[s] ? 1 : 0;
  if (islandOf[i] >= 0 && isHole) isl.cyanHits++;
}
for (const isl of islands) isl.cyanPct = isl.area ? (100 * isl.cyanHits) / isl.area : 0;

// ---------------------------------------------------------------------------
// 5. area-average downsample
// ---------------------------------------------------------------------------

const S = SIZE;
const SN = S * S;
const accRGB = new Float64Array(SN * 3);
const accRGBW = new Float64Array(SN);
const accClean = new Float64Array(SN * 3);
const accCleanW = new Float64Array(SN);
const accAlpha = new Float64Array(SN);
const accAlphaW = new Float64Array(SN);
const island256 = new Int16Array(SN).fill(-1);
const texelArea = (W / S) * (H / S);

// Area-weighted box by default: at a 4.9x reduction, nearest discards ~96% of
// the pixels and aliases hard. `--filter nearest` is there to compare — the
// chunky look comes from the target resolution and the palette, not the filter.
// The island map is always a majority vote; it is geometry, not colour.
const NEAREST = args.filter === "nearest";

for (let dy = 0; dy < S; dy++) {
  const y0 = (dy * H) / S;
  const y1 = ((dy + 1) * H) / S;
  const cy = Math.min(H - 1, Math.floor((y0 + y1) / 2));
  for (let dx = 0; dx < S; dx++) {
    const x0 = (dx * W) / S;
    const x1 = ((dx + 1) * W) / S;
    const cx = Math.min(W - 1, Math.floor((x0 + x1) / 2));
    const d = dy * S + dx;
    const votes = new Map();
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
      const wyFull = Math.min(y1, sy + 1) - Math.max(y0, sy);
      if (wyFull <= 0) continue;
      for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
        const wxFull = Math.min(x1, sx + 1) - Math.max(x0, sx);
        if (wxFull <= 0) continue;
        const s = sy * W + sx;
        const w = NEAREST ? (sx === cx && sy === cy ? 1 : 0) : wxFull * wyFull;
        if (w === 0) {
          const idOnly = islandOf[s];
          if (idOnly >= 0) votes.set(idOnly, (votes.get(idOnly) ?? 0) + wxFull * wyFull);
          continue;
        }
        if (srcColorOk[s]) {
          accRGB[d * 3] += srcRGB[s * 3] * w;
          accRGB[d * 3 + 1] += srcRGB[s * 3 + 1] * w;
          accRGB[d * 3 + 2] += srcRGB[s * 3 + 2] * w;
          accRGBW[d] += w;
          if (srcColorClean[s]) {
            accClean[d * 3] += srcRGB[s * 3] * w;
            accClean[d * 3 + 1] += srcRGB[s * 3 + 1] * w;
            accClean[d * 3 + 2] += srcRGB[s * 3 + 2] * w;
            accCleanW[d] += w;
          }
        }
        // Alpha is authored INSIDE the island only. The margin is derived from
        // it by the bleed pass, so a cut region belonging to a neighbouring
        // island can never reach across the gutter and erode this island edge
        // under bilinear filtering.
        if (islandOf[s] >= 0) {
          accAlpha[d] += srcAlpha[s] * w;
          accAlphaW[d] += w;
        }
        const id = islandOf[s];
        if (id >= 0) votes.set(id, (votes.get(id) ?? 0) + wxFull * wyFull);
      }
    }
    let bestId = -1;
    let bestW = 0;
    let total = 0;
    for (const [id, w] of votes) {
      total += w;
      if (w > bestW) {
        bestW = w;
        bestId = id;
      }
    }
    if (total / texelArea >= 0.5) island256[d] = bestId;
  }
}

const rgb = new Uint8Array(SN * 3);
const alpha = new Uint8Array(SN);
const colorOk = new Uint8Array(SN);
const colorClean = new Uint8Array(SN);
const alphaOk = new Uint8Array(SN);
for (let d = 0; d < SN; d++) {
  // prefer the uncontaminated average where the texel has one
  if (accCleanW[d] > 0) {
    rgb[d * 3] = Math.round(accClean[d * 3] / accCleanW[d]);
    rgb[d * 3 + 1] = Math.round(accClean[d * 3 + 1] / accCleanW[d]);
    rgb[d * 3 + 2] = Math.round(accClean[d * 3 + 2] / accCleanW[d]);
    colorOk[d] = 1;
    colorClean[d] = accCleanW[d] / texelArea >= 0.5 ? 1 : 0;
  } else if (accRGBW[d] > 0) {
    rgb[d * 3] = Math.round(accRGB[d * 3] / accRGBW[d]);
    rgb[d * 3 + 1] = Math.round(accRGB[d * 3 + 1] / accRGBW[d]);
    rgb[d * 3 + 2] = Math.round(accRGB[d * 3 + 2] / accRGBW[d]);
    colorOk[d] = 1;
  }
  if (accAlphaW[d] > 0) {
    alpha[d] = Math.round(accAlpha[d] / accAlphaW[d]);
    alphaOk[d] = 1;
  }
}

// ---------------------------------------------------------------------------
// 6. bleed
// ---------------------------------------------------------------------------
//
// Padding is nearest-source, not neighbour-averaging. Averaging washes the
// gutter out a little more on every pass — the first version of this drifted
// the padding 20-50 luminance units lighter than the island it came from,
// because the outermost ring of a painted piece fades toward the ground and
// each pass re-averaged that drift outward. Copying the nearest source texel
// keeps the padding a hard continuation of the edge colour.
//
// Padding is also partitioned per island. Every gutter texel belongs to exactly
// one island, so colour can never cross a gutter from a neighbour, and a cut
// region is only ever filled from its own island.
//
// Transparency islands claim nothing but a thin pad of their own. Their
// silhouette is defined by alpha, so smearing their metal across the sheet is
// pointless, and keeping them out of the gutter means their neighbours cannot
// reach them either.

const PAD_TRANSPARENT = Math.min(2, BLEED);

/** Nearest-island ownership of the gutter, by level-synchronous BFS. */
const owner = new Int16Array(SN).fill(-1);
const ownDist = new Int32Array(SN);
const minGap = new Map(); // "a|b" -> smallest observed gap in texels

{
  let frontier = [];
  for (let d = 0; d < SN; d++) {
    if (island256[d] >= 0) {
      owner[d] = island256[d];
      frontier.push(d);
    }
  }
  while (frontier.length) {
    const next = [];
    for (const d of frontier) {
      const island = byId[owner[d]];
      const configuredLimit = manifest.slots[island.hex]?.padLimit;
      const limit = configuredLimit === undefined
        ? island.transparency ? PAD_TRANSPARENT : Infinity
        : Math.max(0, Number(configuredLimit));
      if (ownDist[d] >= limit) continue;
      const x = d % S;
      const y = (d / S) | 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const nd = ny * S + nx;
          if (island256[nd] >= 0) continue; // a real island is never overwritten
          if (owner[nd] >= 0) {
            if (owner[nd] !== owner[d]) {
              const a = byId[owner[nd]].name;
              const b = byId[owner[d]].name;
              const k = a < b ? `${a}|${b}` : `${b}|${a}`;
              const gap = ownDist[nd] + ownDist[d] + 1;
              if (gap < (minGap.get(k) ?? Infinity)) minGap.set(k, gap);
            }
            continue;
          }
          owner[nd] = owner[d];
          ownDist[nd] = ownDist[d] + 1;
          next.push(nd);
        }
    }
    frontier = next;
  }
}

/**
 * Copy `values` outward from seed texels to every texel its owner island
 * reaches, nearest source first.
 */
function padNearest(values, stride, authored, seedOf) {
  const src = new Int32Array(SN).fill(-1);
  let frontier = [];
  for (let d = 0; d < SN; d++) {
    if (seedOf(d)) {
      src[d] = d;
      frontier.push(d);
    }
  }
  let filled = 0;
  while (frontier.length) {
    const next = [];
    for (const d of frontier) {
      const island = island256[src[d]];
      const x = d % S;
      const y = (d / S) | 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const nd = ny * S + nx;
          // Traverse THROUGH authored texels (they are not overwritten below) —
          // otherwise the clean core of an island cannot reach past its own
          // authored edge ring to pad the gutter.
          if (src[nd] >= 0) continue;
          if (owner[nd] !== island) continue; // never cross into another island
          src[nd] = src[d];
          next.push(nd);
        }
    }
    frontier = next;
  }
  for (let d = 0; d < SN; d++) {
    if (authored[d] || src[d] < 0 || src[d] === d) continue;
    for (let c = 0; c < stride; c++) values[d * stride + c] = values[src[d] * stride + c];
    filled++;
  }
  return filled;
}

// colour: authored where the island holds trustworthy opaque paint; a cut texel
// is never a colour source, only a destination
const colorAuthored = new Uint8Array(SN);
const colorSeed = new Uint8Array(SN);
for (let d = 0; d < SN; d++) {
  const inside = island256[d] >= 0 && alpha[d] > 0;
  colorAuthored[d] = inside && colorOk[d] ? 1 : 0;
  colorSeed[d] = inside && colorClean[d] ? 1 : 0;
}
// Fall back to the loose set for any island with no clean interior at all,
// so a tiny island cannot end up with nothing to pad from.
for (const isl of islands) {
  let seeds = 0;
  for (let d = 0; d < SN; d++) if (island256[d] === isl.id && colorSeed[d]) seeds++;
  if (seeds > 0) continue;
  for (let d = 0; d < SN; d++) if (island256[d] === isl.id && colorAuthored[d]) colorSeed[d] = 1;
}
const colorFilled = padNearest(rgb, 3, colorAuthored, (d) => colorSeed[d] === 1);

// alpha: authored inside the island, derived outward from there
const alphaAuthored = new Uint8Array(SN);
for (let d = 0; d < SN; d++) alphaAuthored[d] = island256[d] >= 0 && alphaOk[d] ? 1 : 0;
const alphaFilled = padNearest(alpha, 1, alphaAuthored, (d) => alphaAuthored[d] === 1);

// anything no island reached (far background) is never sampled by a UV, but
// leave it a flat neutral rather than white so a stray sample is obvious
for (let d = 0; d < SN; d++) {
  if (owner[d] >= 0) continue;
  rgb[d * 3] = rgb[d * 3 + 1] = rgb[d * 3 + 2] = 0;
  alpha[d] = 0;
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const outRGBA = new Uint8Array(SN * 4);
for (let d = 0; d < SN; d++) {
  outRGBA[d * 4] = rgb[d * 3];
  outRGBA[d * 4 + 1] = rgb[d * 3 + 1];
  outRGBA[d * 4 + 2] = rgb[d * 3 + 2];
  outRGBA[d * 4 + 3] = alpha[d];
}
fs.writeFileSync(path.join(OUT, "atlas.png"), encodePng(S, S, outRGBA));

// preview: alpha over a checker, so cut regions are visible at a glance
const preview = new Uint8Array(SN * 4);
for (let d = 0; d < SN; d++) {
  const x = d % S;
  const y = (d / S) | 0;
  const checker = ((x >> 3) + (y >> 3)) & 1 ? 214 : 168;
  const a = alpha[d] / 255;
  for (let c = 0; c < 3; c++) preview[d * 4 + c] = Math.round(rgb[d * 3 + c] * a + checker * (1 - a));
  preview[d * 4 + 3] = 255;
}
fs.writeFileSync(path.join(OUT, "atlas-preview.png"), encodePng(S, S, preview));

if (args.slices) {
  const dir = path.join(OUT, "slices");
  fs.mkdirSync(dir, { recursive: true });
  for (const isl of islands) {
    let x0 = S;
    let y0 = S;
    let x1 = -1;
    let y1 = -1;
    for (let d = 0; d < SN; d++) {
      if (island256[d] !== isl.id) continue;
      const x = d % S;
      const y = (d / S) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < x0) continue;
    x0 = Math.max(0, x0 - BLEED);
    y0 = Math.max(0, y0 - BLEED);
    x1 = Math.min(S - 1, x1 + BLEED);
    y1 = Math.min(S - 1, y1 + BLEED);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const buf = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const s = (y0 + y) * S + (x0 + x);
        const t = (y * w + x) * 4;
        buf[t] = rgb[s * 3];
        buf[t + 1] = rgb[s * 3 + 1];
        buf[t + 2] = rgb[s * 3 + 2];
        buf[t + 3] = alpha[s];
      }
    fs.writeFileSync(path.join(dir, `${isl.name}.png`), encodePng(w, h, buf));
  }
}

// ---------------------------------------------------------------------------
// QA report
// ---------------------------------------------------------------------------

const report = {
  source: { key: args.key, art: args.art, size: `${W}x${H}` },
  output: {
    size: `${S}x${S}`,
    bleed: BLEED,
    filter: NEAREST ? "nearest" : "box",
    artMargin: ART_MARGIN,
    colorTexelsPadded: colorFilled,
    alphaTexelsPadded: alphaFilled,
  },
  gutters: [...minGap.entries()]
    .map(([pair, gap]) => ({ pair, gap }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, 8),
  transparency: { keyColor: keyHex, speckleComponentsRemoved: speckleRemoved },
  keyCleanup: { contaminantsRemoved: keyContaminants },
  globalFit: { dx: +global.dx.toFixed(2), dy: +global.dy.toFixed(2), scale: +global.sx.toFixed(4) },
  islands: [],
  warnings: [],
};

console.log(`\nkey ${W}x${H}  ->  atlas ${S}x${S}    ${NEAREST ? "nearest" : "box"} filter, ${colorFilled} texels padded`);
console.log(`global pre-align  dx ${global.dx.toFixed(1)}  dy ${global.dy.toFixed(1)}  scale ${global.sx.toFixed(3)}\n`);
console.log("island            area%     dx     dy     sx     sy   uncovered(before)   cut%  overhang");
console.log("-".repeat(92));

for (const isl of islands) {
  const f = isl.fit;
  const row = {
    name: isl.name,
    hex: isl.hex,
    transparency: isl.transparency,
    areaPct: +((100 * isl.area) / N).toFixed(2),
    dx: +f.dx.toFixed(1),
    dy: +f.dy.toFixed(1),
    sx: +f.sx.toFixed(3),
    sy: +f.sy.toFixed(3),
    uncoveredPct: +(100 * isl.uncovered).toFixed(2),
    uncoveredBeforePct: +(100 * isl.baseUncovered).toFixed(2),
    cutPct: +isl.cyanPct.toFixed(1),
    overhang: isl.overhang,
    contained: isl.contained ?? null,
  };
  report.islands.push(row);
  if (isl.overhang.max > OVERHANG_LIMIT) {
    const sides = ["left", "right", "top", "bottom"]
      .filter((k) => isl.overhang[k] > OVERHANG_LIMIT)
      .map((k) => `${k} ${isl.overhang[k]}`)
      .join(", ");
    report.warnings.push(
      `${isl.name}: artwork runs ${sides} texels past the island — that much is being cropped away`,
    );
  }
  if (!isl.transparency && isl.cyanPct > 0.5) {
    report.warnings.push(`${isl.name}: ${isl.cyanPct.toFixed(1)}% key colour on an opaque island`);
  }
  // "Unpainted" is not a defect on a cut island: bare ground inside one is a
  // legitimate hole, and a generator that keys the outline rather than flooding
  // the surround leaves most of the region as ground by design. Those islands
  // are judged by cut% and overhang instead. On a contain fit some padding is
  // structural too — the art box is rectangular, the artwork inside it is not.
  const limit = isl.transparency ? Infinity : isl.contained ? 50 : 2;
  if (row.uncoveredPct > limit) {
    report.warnings.push(`${isl.name}: ${row.uncoveredPct}% of the island is unpainted after registration`);
  }
  const flag = (!isl.transparency && isl.cyanPct > 0.5) || row.uncoveredPct > 2 ? "  <-- check" : "";
  console.log(
    `${isl.name.padEnd(16)} ${row.areaPct.toFixed(2).padStart(5)} ` +
      `${row.dx.toFixed(1).padStart(6)} ${row.dy.toFixed(1).padStart(6)} ` +
      `${row.sx.toFixed(3).padStart(6)} ${row.sy.toFixed(3).padStart(6)} ` +
      `${row.uncoveredPct.toFixed(2).padStart(8)}% (${row.uncoveredBeforePct.toFixed(1).padStart(5)}%) ` +
      `${row.cutPct.toFixed(1).padStart(6)}% ${String(isl.overhang.max).padStart(6)}${
        isl.overhang.max > OVERHANG_LIMIT ? " <-- cropped" : flag
      }`,
  );
}

// Gutter spacing. Two islands closer than 2x the bleed share padding space and
// neither gets a full margin. A transparency island wants more room still: its
// cut edge is exactly where a neighbour's padding would show through.
const gutters = [...minGap.entries()].sort((a, b) => a[1] - b[1]);
console.log("\ntightest gutters (texels at 256)");
for (const [pair, gap] of gutters.slice(0, 5)) {
  const [a, b] = pair.split("|");
  const cut = islands.some((i) => i.transparency && (i.name === a || i.name === b));
  const need = cut ? 2 * BLEED + 2 : 2 * BLEED;
  const short = gap < need;
  console.log(`  ${pair.replace("|", " <-> ").padEnd(34)} ${String(gap).padStart(3)}  (want ${need})${short ? "  <-- tight" : ""}`);
  if (short) {
    report.warnings.push(
      `gutter ${a} <-> ${b} is ${gap} texels, want ${need}${cut ? " (transparency island)" : ""}`,
    );
  }
}

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.warnings.length} warning(s). wrote atlas.png, atlas-preview.png, report.json to ${OUT}`);
for (const w of report.warnings) console.log(`  ! ${w}`);
