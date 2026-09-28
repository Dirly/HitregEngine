#!/usr/bin/env node
// Ground-cover atlas pages from generated sprites.
//
//   node tools/cover-atlas.mjs <manifest.json> [--preview <dir>]
//
// The image generator draws a plant at 256 px (or 256x512 for a tall one);
// the game draws it as a 64 px tile on a crossed billboard, many to a page,
// one page per `grass`/`cover` layer family so a meadow of five flowers is
// one draw call. This tool is the step between the two, and it is what makes
// generated art match the PSX look instead of reading as a shrunken painting:
//
//   1. crop to the opaque bounds (the generator never centres or grounds a
//      plant the way a billboard needs), then fit into the tile leaving a
//      gutter, base on the tile's bottom edge (upright) or centred (flat);
//   2. AREA-downsample, alpha-weighted, so thin stems survive as pixels
//      instead of vanishing the way nearest sampling drops them;
//   3. hard alpha (cover is an alpha CUTOUT, so a soft edge is only noise);
//   4. quantize each tile to a small palette (k-means) and then to 15-bit
//      colour — banded, the way a PSX texture is — which also restores the
//      chunky look the averaging in step 2 smoothed away;
//   5. bleed opaque colour into the transparent texels, so the minification
//      mips average toward the plant's own colour instead of a dark halo.
//
// Manifest (paths resolve against the manifest's own folder):
// {
//   "pages": [
//     { "target": "../assets/textures/cover/cover-tufts.png", "tile": [64, 64],
//       "columns": 4, "rows": 8, "orient": "upright", "colors": 14,
//       "tiles": ["cover-src/poppies.png", { "file": "cover-src/cap-poppy.png", "orient": "flat" }, ...] }
//   ]
// }
// Writes each page plus `<page>.tiles.json` (index -> source name) beside it.
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./_png.mjs";

const args = process.argv.slice(2);
const manifestPath = args.find((a) => !a.startsWith("--"));
if (!manifestPath) {
  console.error("usage: node tools/cover-atlas.mjs <manifest.json> [--preview <dir>]");
  process.exit(2);
}
const previewDir = args.includes("--preview") ? args[args.indexOf("--preview") + 1] : null;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const root = path.dirname(path.resolve(manifestPath));

/** Opaque bounds of an RGBA image (alpha > 32), or null when empty. */
function opaqueBounds(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] > 32) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * Area-resample the source rectangle into a w x h RGBA float buffer
 * (premultiplied), by supersampling each target texel on a 6x6 grid.
 */
function areaResample(img, box, w, h) {
  const out = new Float32Array(w * h * 4);
  const sx = (box.x1 - box.x0) / w;
  const sy = (box.y1 - box.y0) / h;
  const N = 6;
  for (let ty = 0; ty < h; ty++)
    for (let tx = 0; tx < w; tx++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const px = Math.min(img.width - 1, Math.floor(box.x0 + (tx + (i + 0.5) / N) * sx));
          const py = Math.min(img.height - 1, Math.floor(box.y0 + (ty + (j + 0.5) / N) * sy));
          const o = (py * img.width + px) * 4;
          const al = img.data[o + 3] / 255;
          r += img.data[o] * al;
          g += img.data[o + 1] * al;
          b += img.data[o + 2] * al;
          a += al;
        }
      const o = (ty * w + tx) * 4;
      out[o] = r / (N * N);
      out[o + 1] = g / (N * N);
      out[o + 2] = b / (N * N);
      out[o + 3] = a / (N * N);
    }
  return out;
}

/** k-means palette over the opaque texels, returned as [r,g,b][]. */
function kmeans(pixels, k) {
  if (pixels.length <= k) return pixels.map((p) => [...p]);
  // deterministic init: spread over the pixels sorted by luminance
  const sorted = [...pixels].sort((a, b) => a[0] * 0.3 + a[1] * 0.59 + a[2] * 0.11 - (b[0] * 0.3 + b[1] * 0.59 + b[2] * 0.11));
  let centres = Array.from({ length: k }, (_, i) => [...sorted[Math.floor(((i + 0.5) / k) * sorted.length)]]);
  const assign = new Int32Array(pixels.length);
  for (let iter = 0; iter < 12; iter++) {
    for (let p = 0; p < pixels.length; p++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (pixels[p][0] - centres[c][0]) ** 2 + (pixels[p][1] - centres[c][1]) ** 2 + (pixels[p][2] - centres[c][2]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[p] = best;
    }
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let p = 0; p < pixels.length; p++) {
      const s = sum[assign[p]];
      s[0] += pixels[p][0]; s[1] += pixels[p][1]; s[2] += pixels[p][2]; s[3]++;
    }
    centres = centres.map((c, i) => (sum[i][3] ? [sum[i][0] / sum[i][3], sum[i][1] / sum[i][3], sum[i][2] / sum[i][3]] : c));
  }
  return centres;
}

/** 8-bit channel to the nearest 5-bit level, back in 8-bit: PSX 15-bit colour. */
const to15 = (v) => Math.round((Math.round((v / 255) * 31) / 31) * 255);

/** One source sprite -> a finished tile (Uint8 RGBA, tw x th). */
function makeTile(srcPath, tw, th, orient, colors) {
  const img = decodePng(fs.readFileSync(srcPath));
  const box = opaqueBounds(img);
  const tile = new Uint8Array(tw * th * 4);
  if (!box) return { tile, warn: "no opaque pixels" };
  // gutter: 2 texels left/right/top; upright tiles keep their base on the
  // bottom edge, flat ones get the gutter all round
  const g = 2;
  const availW = tw - 2 * g;
  const availH = orient === "flat" ? th - 2 * g : th - g;
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const scale = Math.min(availW / bw, availH / bh);
  const w = Math.max(1, Math.round(bw * scale));
  const h = Math.max(1, Math.round(bh * scale));
  const ox = Math.floor((tw - w) / 2);
  const oy = orient === "flat" ? Math.floor((th - h) / 2) : th - h;
  const buf = areaResample(img, box, w, h);
  // hard alpha + unpremultiply
  const opaque = [];
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = buf[i * 4 + 3];
    if (a >= 0.5) {
      keep[i] = 1;
      opaque.push([buf[i * 4] / a, buf[i * 4 + 1] / a, buf[i * 4 + 2] / a]);
    }
  }
  const palette = kmeans(opaque, colors).map((c) => c.map(to15));
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!keep[i]) continue;
      const px = opaque[n++];
      let best = palette[0], bestD = Infinity;
      for (const c of palette) {
        const d = (px[0] - c[0]) ** 2 + (px[1] - c[1]) ** 2 + (px[2] - c[2]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      const o = ((oy + y) * tw + (ox + x)) * 4;
      tile[o] = best[0];
      tile[o + 1] = best[1];
      tile[o + 2] = best[2];
      tile[o + 3] = 255;
    }
  bleed(tile, tw, th);
  const coverage = keep.reduce((s, v) => s + v, 0) / (tw * th);
  return { tile, coverage, size: [w, h] };
}

/** Flood opaque colour outward into transparent texels (alpha stays 0). */
function bleed(tile, w, h) {
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = tile[i * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < 16; pass++) {
    const next = filled.slice();
    let changed = false;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, c = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!filled[j]) continue;
          r += tile[j * 4]; g += tile[j * 4 + 1]; b += tile[j * 4 + 2]; c++;
        }
        if (c) {
          tile[i * 4] = r / c; tile[i * 4 + 1] = g / c; tile[i * 4 + 2] = b / c;
          next[i] = 1;
          changed = true;
        }
      }
    filled.set(next);
    if (!changed) break;
  }
}

/** Nearest-upscaled copy on a checker, for looking at a page. */
function preview(page, w, h, scale) {
  const out = new Uint8Array(w * scale * h * scale * 4);
  for (let y = 0; y < h * scale; y++)
    for (let x = 0; x < w * scale; x++) {
      const s = (Math.floor(y / scale) * w + Math.floor(x / scale)) * 4;
      const o = (y * w * scale + x) * 4;
      const bg = ((x >> 3) + (y >> 3)) % 2 ? 90 : 120;
      const a = page[s + 3] / 255;
      out[o] = page[s] * a + bg * (1 - a);
      out[o + 1] = page[s + 1] * a + bg * (1 - a);
      out[o + 2] = page[s + 2] * a + bg * (1 - a);
      out[o + 3] = 255;
    }
  return out;
}

for (const spec of manifest.pages) {
  const [tw, th] = spec.tile;
  const pw = tw * spec.columns;
  const ph = th * spec.rows;
  const page = new Uint8Array(pw * ph * 4);
  const names = [];
  spec.tiles.forEach((entry, index) => {
    // an entry is a path, or { "file": path, "orient": "flat" } for a tile
    // that packs differently from its page (a top-down flower cap on a page of
    // upright tufts)
    const rel = typeof entry === "string" ? entry : entry.file;
    const orient = (typeof entry === "string" ? null : entry.orient) ?? spec.orient ?? "upright";
    if (index >= spec.columns * spec.rows) throw new Error(`${spec.target}: more tiles than ${spec.columns}x${spec.rows}`);
    const src = path.resolve(root, rel);
    if (!fs.existsSync(src)) {
      console.warn(`  [missing] tile ${index}: ${rel}`);
      names.push(null);
      return;
    }
    const { tile, coverage, size, warn } = makeTile(src, tw, th, orient, spec.colors ?? 14);
    if (warn) console.warn(`  [${warn}] ${rel}`);
    const col = index % spec.columns;
    const row = Math.floor(index / spec.columns);
    for (let y = 0; y < th; y++)
      page.set(tile.subarray(y * tw * 4, (y + 1) * tw * 4), ((row * th + y) * pw + col * tw) * 4);
    names.push(path.basename(rel, ".png"));
    console.log(`  tile ${String(index).padStart(2)} ${path.basename(rel, ".png").padEnd(16)} ${size?.join("x")} coverage ${(coverage * 100).toFixed(0)}%`);
  });
  const target = path.resolve(root, spec.target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(pw, ph, page));
  fs.writeFileSync(target.replace(/\.png$/, ".tiles.json"), JSON.stringify({ columns: spec.columns, rows: spec.rows, tile: spec.tile, tiles: names }, null, 2) + "\n");
  console.log(`${path.relative(process.cwd(), target)}: ${pw}x${ph}, ${names.filter(Boolean).length} tiles`);
  if (previewDir) {
    fs.mkdirSync(previewDir, { recursive: true });
    const scale = 3;
    fs.writeFileSync(path.join(previewDir, path.basename(target)), encodePng(pw * scale, ph * scale, preview(page, pw, ph, scale)));
  }
}
