#!/usr/bin/env node
/**
 * Pack many finished atlases into ONE sheet, so every weapon wearing any of
 * them can share a single material — which is the whole point, because a
 * material boundary is a draw-call boundary.
 *
 *   pnpm -F playground atlas-pack --out weapons --sheets tools/atlas/out-bone/atlas.png ...
 *   pnpm -F playground atlas-pack --out weapons --dir tools/atlas --size 128
 *
 * Writes, into the playground's assets:
 *
 *   textures/<out>.png        the packed sheet
 *   textures/<out>.tiles.json label -> [uOffset, vOffset, scale]
 *
 * A mesh unwrapped for ONE sheet has UVs over 0..1 of it; a tile is addressed
 * by `uv * scale + offset`, and that triple is what a weapon carries per
 * INSTANCE. Nothing about the mesh changes, which is why one mesh can wear any
 * theme in the pack.
 *
 * Every tile is PADDED with its own edge pixels. Mip level 3 of a 128 tile is
 * 16 texels, and without a gutter the levels above that average one sword's
 * pommel into its neighbour's blade — visible as a colour shift on anything
 * more than a few metres away, and impossible to find by looking at the sheet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./_png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(here, "..");
const ENGINE = path.resolve(PLAYGROUND, "../..");

function parseArgs(argv) {
  const out = {};
  let key = null;
  for (const a of argv) {
    if (a.startsWith("--")) {
      key = a.slice(2);
      out[key] = true;
      continue;
    }
    if (!key) continue;
    out[key] = out[key] === true ? a : [].concat(out[key], a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const list = (v) => (v === undefined || v === true ? [] : [].concat(v));

const name = String(args.out && args.out !== true ? args.out : "weapons");
const PAD = Number(args.pad ?? 8);

// Gather the sheets: named files, or every out-*/atlas.png under a folder.
let files = list(args.sheets).map((f) => path.resolve(String(f)));
if (!files.length && args.dir && args.dir !== true) {
  const dir = path.resolve(String(args.dir));
  const want = args.size && args.size !== true ? Number(args.size) : null;
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry, "atlas.png");
    if (!entry.startsWith("out-") || !fs.existsSync(file)) continue;
    if (want) {
      const b = fs.readFileSync(file);
      if (b.readUInt32BE(16) !== want) continue;
    }
    files.push(file);
  }
  files.sort();
}
if (!files.length) {
  console.error("usage: atlas-pack --out <name> --sheets <a.png> [<b.png> ...]   (or --dir <folder> [--size 128])");
  process.exit(1);
}

// A label per tile, taken from the folder the sheet came out of.
const tiles = [];
for (const file of files) {
  const dir = path.basename(path.dirname(file)).replace(/^out-/, "");
  const stem = path.basename(file).replace(/\.png$/i, "");
  const label = (stem === "atlas" ? dir : stem).replace(/-128$/, "").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  if (tiles.some((t) => t.label === label)) continue; // the -128 duplicates
  tiles.push({ file, label, png: decodePng(fs.readFileSync(file)) });
}

const size = tiles[0].png.width;
const odd = tiles.filter((t) => t.png.width !== size || t.png.height !== size);
if (odd.length) {
  console.error(`! every sheet must be the same square size (${size}): ${odd.map((t) => t.label).join(", ")}`);
  process.exit(1);
}

const cols = Math.ceil(Math.sqrt(tiles.length));
const rows = Math.ceil(tiles.length / cols);
const stride = size + PAD * 2;
const W = cols * stride;
const H = rows * stride;
const out = new Uint8Array(W * H * 4);

for (const [i, t] of tiles.entries()) {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const ox = col * stride + PAD;
  const oy = row * stride + PAD;
  // The tile, then its edges smeared outward into the gutter.
  for (let y = -PAD; y < size + PAD; y++) {
    const sy = Math.min(size - 1, Math.max(0, y));
    for (let x = -PAD; x < size + PAD; x++) {
      const sx = Math.min(size - 1, Math.max(0, x));
      const s = (sy * size + sx) * 4;
      const d = ((oy + y) * W + ox + x) * 4;
      out[d] = t.png.data[s];
      out[d + 1] = t.png.data[s + 1];
      out[d + 2] = t.png.data[s + 2];
      out[d + 3] = t.png.data[s + 3];
    }
  }
  t.rect = [(ox / W), (oy / H), size / W];
}

fs.mkdirSync(path.join(PLAYGROUND, "assets", "textures"), { recursive: true });
const sheetPath = path.join(PLAYGROUND, "assets", "textures", `${name}.png`);
fs.writeFileSync(sheetPath, encodePng(W, H, out));

const manifest = {
  sheet: `${name}.png`,
  size,
  pad: PAD,
  grid: [cols, rows],
  // uv * scale + [u, v] addresses this tile. One triple per theme, and it is
  // PER INSTANCE data — the mesh never changes.
  tiles: Object.fromEntries(tiles.map((t) => [t.label, t.rect.map((v) => +v.toFixed(6))])),
};
const manifestPath = path.join(PLAYGROUND, "assets", "textures", `${name}.tiles.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(`atlas-pack: ${name}`);
console.log(`  ${tiles.length} sheets of ${size}px -> ${W}x${H} (${cols}x${rows}, ${PAD}px gutters)`);
for (const t of tiles) console.log(`    ${t.label.padEnd(24)} [${t.rect.map((v) => v.toFixed(4)).join(", ")}]`);
console.log(`  wrote ${path.relative(ENGINE, sheetPath)}`);
console.log(`  wrote ${path.relative(ENGINE, manifestPath)}`);
