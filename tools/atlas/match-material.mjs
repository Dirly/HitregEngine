#!/usr/bin/env node
/**
 * match-material — make a material on one imported sheet read as the SAME
 * material on another (docs/armor-sets.md → Matching materials across sheets).
 *
 *   node tools/atlas/match-material.mjs \
 *     --from tools/atlas/out/human-body/chain/atlas.png --from-key tools/atlas/sets/human-body/key.png --from-regions "#ff0000,#f800ff" \
 *     --to   tools/atlas/out/human-helm/chain/atlas.png  --to-key   tools/atlas/sets/human-helm/key.png  --to-regions "#6a00c0,#9a4ce0"
 *
 * Every sheet of a set is painted in its own generator session, and "iron
 * mail" comes back a different iron each time: measured on the chain set, the
 * coif's mail was 38% brighter than the body's with twice the contrast, so it
 * read silver-white beside it. This measures the material where it is right
 * (the body's regions, `--from`) and moves the target regions' texels onto
 * it in OKLab: lightness mean AND spread (the contrast), and the chroma/hue
 * mean. The painting itself (rings, rivets, folds) is kept; only its tone
 * changes. Run after import-atlas and before the page bake (weapon-page /
 * body-page), which read the out/ atlases. `--to-regions` are key colours of
 * slots made ENTIRELY of the material; `--strength` (0..1, default 1) eases it.
 */
import fs from "node:fs";
import { decodePng, encodePng } from "../../apps/playground/tools/_png.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[++i];
}
for (const k of ["from", "from-key", "from-regions", "to", "to-key", "to-regions"])
  if (!args[k]) {
    console.error(`match-material: --${k} is required (see the header of this file)`);
    process.exit(1);
  }
const strength = Math.max(0, Math.min(1, Number(args.strength ?? 1)));

// -- sRGB <-> OKLab ------------------------------------------------------------
const toLin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)));
function oklab(r, g, b) {
  [r, g, b] = [toLin(r), toLin(g), toLin(b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function srgb(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

// -- regions -------------------------------------------------------------------
const hexes = (list) => String(list).split(",").map((h) => [1, 3, 5].map((i) => parseInt(h.trim().slice(i, i + 2), 16)));
/** Opaque atlas texels whose key pixel is one of the colours; `inset` keeps clear of island edges (bleed, AO rims). */
function texelsOf(atlas, key, colours, inset) {
  const s = key.width / atlas.width;
  const inside = (x, y) => {
    if (x < 0 || y < 0 || x >= atlas.width || y >= atlas.height) return false;
    const k = (Math.floor((y + 0.5) * s) * key.width + Math.floor((x + 0.5) * s)) * 4;
    return colours.some(([r, g, b]) => Math.abs(key.data[k] - r) + Math.abs(key.data[k + 1] - g) + Math.abs(key.data[k + 2] - b) < 30);
  };
  const out = [];
  for (let y = 0; y < atlas.height; y++)
    for (let x = 0; x < atlas.width; x++) {
      if (!inside(x, y) || atlas.data[(y * atlas.width + x) * 4 + 3] < 128) continue;
      let ok = true;
      for (let d = 1; d <= inset && ok; d++) ok = inside(x - d, y) && inside(x + d, y) && inside(x, y - d) && inside(x, y + d);
      if (ok) out.push(y * atlas.width + x);
    }
  return out;
}
function statsOf(atlas, texels) {
  const labs = texels.map((t) => oklab(atlas.data[t * 4], atlas.data[t * 4 + 1], atlas.data[t * 4 + 2]));
  const mean = [0, 1, 2].map((c) => labs.reduce((s, v) => s + v[c], 0) / labs.length);
  const sd = [0, 1, 2].map((c) => Math.sqrt(labs.reduce((s, v) => s + (v[c] - mean[c]) ** 2, 0) / labs.length) || 1e-6);
  return { labs, mean, sd };
}
const fmt = (st) => `L ${st.mean[0].toFixed(3)}±${st.sd[0].toFixed(3)}  a ${st.mean[1].toFixed(3)}  b ${st.mean[2].toFixed(3)}`;

const from = decodePng(fs.readFileSync(args.from));
const to = decodePng(fs.readFileSync(args.to));
const src = statsOf(from, texelsOf(from, decodePng(fs.readFileSync(args["from-key"])), hexes(args["from-regions"]), 1));
const toTexels = texelsOf(to, decodePng(fs.readFileSync(args["to-key"])), hexes(args["to-regions"]), 0);
if (!src.labs.length || !toTexels.length) throw new Error(`no texels: from ${src.labs.length}, to ${toTexels.length} — check the key colours`);
const dst = statsOf(to, toTexels);

// L: mean and spread; a/b: mean shift, spread scaled (keeps the painted hue variation proportionate)
toTexels.forEach((t, i) => {
  const v = dst.labs[i];
  const m = [0, 1, 2].map((c) => (v[c] - dst.mean[c]) * (src.sd[c] / dst.sd[c]) + src.mean[c]);
  const [r, g, b] = srgb(...[0, 1, 2].map((c) => v[c] + (m[c] - v[c]) * strength));
  to.data[t * 4] = r;
  to.data[t * 4 + 1] = g;
  to.data[t * 4 + 2] = b;
});
fs.writeFileSync(args.to, encodePng(to.width, to.height, to.data));
const after = statsOf(to, toTexels);
console.log(`match-material: ${toTexels.length} texels of ${args.to}`);
console.log(`  source ${fmt(src)}\n  before ${fmt(dst)}\n  after  ${fmt(after)}`);
