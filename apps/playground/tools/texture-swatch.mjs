#!/usr/bin/env node
/**
 * texture-swatch — LOOK at a tiling texture the way the world will show it before it is used: the tile repeated 4 x 4
 * into one swatch PNG, so a mark that is fine on one tile but lines up into a pattern across tiles (owner walk
 * 2026-10-21: a lichen spot on the Hagsheer accent tile repeated into rows of PLUS signs, the rocks read as health packs)
 * is seen at once. It also measures the tile's MOTIF: the brightest or darkest compact blob against the tile's own
 * median, and how close its centre sits to the tile's centre or a seam crossing — a lone mark at a regular spot
 * repeats as a grid of identical icons. `motif` (score >= 1) is a finding: repaint, re-roll, or pick another tile.
 *
 *   node tools/texture-swatch.mjs <tile.png> [<tile.png> ...] [--out <dir>] [--tiles 4] [--json]
 *
 * Writes <out>/<name>-swatch.png (default out: the scratch dir given, else beside the tile under a `swatches/`
 * folder that tools never read) and prints one line per tile: size, motif score, verdict. Exit 1 when any tile
 * has a motif. Zone/kit texture intake runs it on every new tile (tools/worldgen-zone-textures.mts) and the
 * world-standards skill says: look at the swatch before a tile is used. Pure parts tested in test/texture-swatch.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decodePng, encodePng } from "./_png.mjs";

/** Repeat an RGBA tile n x n. */
export function tileSwatch(w, h, rgba, n = 4) {
  const W = w * n, H = h * n, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = ((y % h) * w + (x % w)) * 4, d = (y * W + x) * 4;
    out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2]; out[d + 3] = rgba.length === w * h * 4 ? rgba[s + 3] : 255;
  }
  return { width: W, height: H, rgba: out };
}

/**
 * The tile's lone MARK: pixels at least 0.22 (of full range) brighter, or darker, than the tile median, joined into
 * components (4-connected, wrapped across the seams). A motif is a SOLID blob (fills >= 45% of its box) of 0.3-5% of
 * the tile, on a tile with at most 3 such blobs of that sign (a texture with many - pebbles, highlights - has no lone
 * mark; one with a single clover of lichen does, and 4 x 4 tiles make a grid of icons). Score = the blob's contrast
 * / 0.22 when it qualifies, else 0.
 */
export function motifScore(w, h, rgba) {
  const stride = rgba.length / (w * h), n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = (0.2126 * rgba[i * stride] + 0.7152 * rgba[i * stride + 1] + 0.0722 * rgba[i * stride + 2]) / 255;
  const med = Float32Array.from(lum).sort()[n >> 1];
  let best = { score: 0, contrast: 0, share: 0, blobs: 0, at: [0, 0] };
  for (const sign of [1, -1]) {
    const on = (i) => sign * (lum[i] - med) >= 0.22, seen = new Uint8Array(n), blobs = [];
    for (let s0 = 0; s0 < n; s0++) {
      if (seen[s0] || !on(s0)) continue;
      const q = [s0];
      seen[s0] = 1;
      let x0 = w, x1 = -1, y0 = h, y1 = -1, peak = 0, sx = 0, sy = 0;
      for (let k = 0; k < q.length; k++) {
        const c = q[k], x = c % w, y = (c / w) | 0;
        peak = Math.max(peak, sign * (lum[c] - med)); sx += x; sy += y;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = ((y + dy + h) % h) * w + ((x + dx + w) % w);
          if (!seen[nc] && on(nc)) { seen[nc] = 1; q.push(nc); }
        }
      }
      const area = q.length / n, fill = q.length / ((x1 - x0 + 1) * (y1 - y0 + 1));
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (area >= 0.003) blobs.push({ area, fill, aspect: Math.max(bw, bh) / Math.min(bw, bh), peak, at: [Math.round(sx / q.length), Math.round(sy / q.length)] });
    }
    // a MARK is a solid, roughly round blob (not a highlight line along a block edge, not a wash over half the tile)
    const marks = blobs.filter((b) => b.area <= 0.05 && b.fill >= 0.45 && b.aspect <= 2.2);
    if (!marks.length || marks.length > 3) continue;
    const top = marks.sort((p, r) => r.peak - p.peak)[0];
    const score = +(top.peak / 0.22).toFixed(2);
    if (score > best.score) best = { score, contrast: +top.peak.toFixed(3), share: +top.area.toFixed(3), blobs: marks.length, at: top.at };
  }
  return best;
}

function main() {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  const skip = new Set([opt("out"), opt("tiles")].filter(Boolean));
  const files = a.filter((x) => !x.startsWith("--") && !skip.has(x));
  if (!files.length) { console.error("usage: node tools/texture-swatch.mjs <tile.png>... [--out dir] [--tiles 4] [--json]"); process.exit(2); }
  const n = Number(opt("tiles") ?? 4), rows = [];
  for (const f of files) {
    const img = decodePng(fs.readFileSync(f));
    const sw = tileSwatch(img.width, img.height, img.rgba ?? img.data, n);
    const dir = opt("out") ?? path.join(path.dirname(f), "swatches");
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, `${path.basename(f, ".png")}-swatch.png`);
    fs.writeFileSync(out, encodePng(sw.width, sw.height, sw.rgba));
    const m = motifScore(img.width, img.height, img.rgba ?? img.data);
    rows.push({ file: f, swatch: out, size: [img.width, img.height], ...m, verdict: m.score >= 1 ? "MOTIF" : "ok" });
  }
  if (a.includes("--json")) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) console.log(`${r.verdict.padEnd(6)} ${r.file} ${r.size.join("x")} motif ${r.score} (contrast ${r.contrast}, share ${r.share}, blobs ${r.blobs}) -> ${r.swatch}  LOOK at it before use`);
  if (rows.some((r) => r.verdict !== "ok")) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
