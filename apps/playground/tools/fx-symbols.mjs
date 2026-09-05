/**
 * Symbol intake: turn a hand-drawn sheet of sigils / glyphs / arrows into an
 * engine spritesheet and catalog entries the spell generator can pick from.
 *
 *   node tools/fx.mjs symbols <project> <name> <source.png> [options]
 *     --roles sigil,glyph          default roles for every symbol
 *     --rows 0-2=head,3-5=stuck    roles by SOURCE row (overrides --roles)
 *     --tags rune,circle           tags on every symbol
 *     --pad 4                      pixels of air around each symbol in its cell
 *     --merge 5                    pieces closer than this (px) are one symbol
 *     --max 100                    …unless the joined symbol would exceed this (px); default page/5
 *     --min 12                     drop blobs with fewer pixels than this
 *
 * The source is white-on-black OR black-on-white, symbols anywhere on the
 * page as long as they don't touch. The tool finds every symbol (a
 * connected blob after a small dilation, so a dashed ring is one symbol),
 * orders them by row then column, and packs them one per cell into a
 * uniform grid — because a spritesheet is a grid and a `sprite` module
 * addresses a symbol as `cell: [col, row]`. Alpha is the symbol's contrast
 * against the page; RGB is white so the palette tints it.
 *
 * Writes:
 *   assets/textures/fx/symbols/<name>.png   the packed atlas
 *   assets/spritesheets/<name>.json         its grid
 *   assets/fx-catalog/symbols.json          catalog entries (replacing any
 *                                           earlier entries for this sheet)
 *
 * Every entry starts with the SAFE rules — all orientations allowed, spin
 * only when lying flat — and the lab's symbol browser is where a human
 * dictates otherwise, per symbol.
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./_png.mjs";

function parseArgs(rest) {
  const opts = { roles: ["sigil"], rows: [], tags: [], pad: 4, merge: 5, min: 12, max: 0 };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--roles") opts.roles = rest[++i].split(",").filter(Boolean);
    else if (a === "--tags") opts.tags = rest[++i].split(",").filter(Boolean);
    else if (a === "--pad") opts.pad = Number(rest[++i]);
    else if (a === "--merge") opts.merge = Number(rest[++i]);
    else if (a === "--min") opts.min = Number(rest[++i]);
    else if (a === "--max") opts.max = Number(rest[++i]);
    else if (a === "--rows") {
      opts.rows = rest[++i].split(",").map((spec) => {
        const [range, role] = spec.split("=");
        const [lo, hi] = range.split("-").map(Number);
        return { lo, hi: hi ?? lo, roles: role.split("+") };
      });
    } else positional.push(a);
  }
  return { opts, positional };
}

/** The page colour: the median of the four corners. */
function background(img) {
  const { width: w, height: h, data } = img;
  const px = (x, y) => [data[(y * w + x) * 4], data[(y * w + x) * 4 + 1], data[(y * w + x) * 4 + 2]];
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  return [0, 1, 2].map((c) => corners.map((p) => p[c]).sort((a, b) => a - b)[1]);
}

/** Contrast against the page, 0..255, with the faint halo cleaned off. */
function alphaMap(img, bg) {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = Math.max(Math.abs(data[i * 4] - bg[0]), Math.abs(data[i * 4 + 1] - bg[1]), Math.abs(data[i * 4 + 2] - bg[2]));
    const a = (data[i * 4 + 3] / 255) * d;
    out[i] = Math.max(0, Math.min(255, Math.round((a - 20) * 1.25)));
  }
  return out;
}

function dilate(mask, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** Pixel gap between two boxes (0 when they touch or overlap). */
function gap(a, b) {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
  const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
  return Math.max(dx, dy);
}

/**
 * Join pieces into symbols: two boxes closer than `merge` pixels belong to
 * the same symbol UNLESS their union would be bigger than a symbol can be
 * (`maxCell`). That is what keeps a dashed ring together without gluing it
 * to its neighbour on a tightly packed page.
 */
function mergePieces(pieces, merge, maxCell) {
  let list = pieces.map((p) => ({ ...p }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (gap(a, b) > merge) continue;
        const x0 = Math.min(a.x0, b.x0);
        const y0 = Math.min(a.y0, b.y0);
        const x1 = Math.max(a.x1, b.x1);
        const y1 = Math.max(a.y1, b.y1);
        if (Math.max(x1 - x0 + 1, y1 - y0 + 1) > maxCell) continue;
        const pixels = a.pixels + b.pixels;
        list[i] = { x0, y0, x1, y1, pixels, sx: a.sx + b.sx, sy: a.sy + b.sy };
        list.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return list;
}

/** Connected pieces (8-way) of the page, joined into symbols; boxes from the real pixels. */
function blobs(alpha, w, h, merge, minPixels, maxCell) {
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = alpha[i] > 40 ? 1 : 0;
  const grown = dilate(solid, w, h, 1);
  const label = new Int32Array(w * h).fill(-1);
  const out = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!grown[start] || label[start] >= 0) continue;
    const id = out.length;
    const box = { x0: w, y0: h, x1: -1, y1: -1, pixels: 0, sx: 0, sy: 0 };
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i - x) / w;
      if (solid[i]) {
        box.pixels++;
        box.sx += x;
        box.sy += y;
        if (x < box.x0) box.x0 = x;
        if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y;
        if (y > box.y1) box.y1 = y;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (grown[j] && label[j] < 0) {
            label[j] = id;
            stack.push(j);
          }
        }
      }
    }
    if (box.pixels > 0) out.push(box);
  }
  return mergePieces(out, merge, maxCell)
    .filter((b) => b.pixels >= minPixels)
    .map((b) => ({ ...b, cx: b.sx / b.pixels, cy: b.sy / b.pixels, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }));
}

/** Order blobs by row (clustered on centre y) then by x, and number the rows. */
function order(list) {
  const byY = [...list].sort((a, b) => a.cy - b.cy);
  const heights = byY.map((b) => b.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 32;
  const rows = [];
  for (const b of byY) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(b.cy - row.cy) < medianH * 0.6) {
      row.items.push(b);
      row.cy = row.items.reduce((s, it) => s + it.cy, 0) / row.items.length;
    } else rows.push({ cy: b.cy, items: [b] });
  }
  const out = [];
  rows.forEach((row, r) => {
    row.items.sort((a, b) => a.cx - b.cx);
    row.items.forEach((b, c) => out.push({ ...b, sourceRow: r, sourceCol: c }));
  });
  return out;
}

function roundUp(v, step) {
  return Math.ceil(v / step) * step;
}

export function cmdSymbols(project, name, source, rest) {
  const { opts } = parseArgs(rest);
  const img = decodePng(fs.readFileSync(source));
  const bg = background(img);
  const alpha = alphaMap(img, bg);
  // a symbol is never wider than a fifth of the page unless told otherwise
  const maxCell = opts.max > 0 ? opts.max : Math.round(Math.min(img.width, img.height) / 5);
  const found = order(blobs(alpha, img.width, img.height, opts.merge, opts.min, maxCell));
  if (found.length === 0) throw new Error(`no symbols found in ${source} (page colour ${bg.join(",")})`);
  const biggest = Math.max(...found.map((b) => Math.max(b.w, b.h)));
  const cell = Math.max(32, roundUp(biggest + opts.pad * 2, 8));
  const cols = Math.max(1, Math.ceil(Math.sqrt(found.length)));
  const rows = Math.ceil(found.length / cols);
  const W = cols * cell;
  const H = rows * cell;
  const atlas = new Uint8Array(W * H * 4);
  found.forEach((b, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ox = col * cell + Math.floor((cell - b.w) / 2);
    const oy = row * cell + Math.floor((cell - b.h) / 2);
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const a = alpha[(b.y0 + y) * img.width + (b.x0 + x)];
        if (!a) continue;
        const di = ((oy + y) * W + (ox + x)) * 4;
        atlas[di] = 255;
        atlas[di + 1] = 255;
        atlas[di + 2] = 255;
        atlas[di + 3] = a;
      }
    }
    b.cell = [col, row];
    b.aspect = Math.max(0.25, Math.min(4, b.w / Math.max(1, b.h)));
  });

  const base = path.join("projects", project, "assets");
  const texDir = path.join(base, "textures", "fx", "symbols");
  const sheetDir = path.join(base, "spritesheets");
  const catalogDir = path.join(base, "fx-catalog");
  for (const d of [texDir, sheetDir, catalogDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(texDir, `${name}.png`), encodePng(W, H, atlas));
  fs.writeFileSync(
    path.join(sheetDir, `${name}.json`),
    JSON.stringify(
      {
        texture: `fx/symbols/${name}.png`,
        grid: { cols, rows, frameWidth: cell, frameHeight: cell, margin: 0, spacing: 0 },
        frames: {},
      },
      null,
      2,
    ) + "\n",
  );

  const rolesFor = (b) => {
    const byRow = opts.rows.find((r) => b.sourceRow >= r.lo && b.sourceRow <= r.hi);
    return byRow ? byRow.roles : opts.roles;
  };
  const entries = found.map((b, i) => ({
    id: `${name}:${i}`,
    sheet: name,
    cell: b.cell,
    roles: rolesFor(b),
    tags: [...opts.tags, `row${b.sourceRow}`],
    // the safe defaults: any orientation, turning only when lying flat
    orient: ["ground", "facing", "billboard", "vertical", "velocity"],
    spin: "ground",
    enabled: true,
    aspect: Math.round(b.aspect * 100) / 100,
  }));
  const catalogPath = path.join(catalogDir, "symbols.json");
  let catalog = { version: 1, symbols: [] };
  if (fs.existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    } catch {
      /* start over */
    }
  }
  const kept = (catalog.symbols ?? []).filter((s) => s.sheet !== name);
  catalog = { version: 1, symbols: [...kept, ...entries] };
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");

  console.log(`${found.length} symbols from ${path.basename(source)} (page ${bg.join(",")}) -> ${cols}x${rows} cells of ${cell}px`);
  console.log(`  ${path.join(texDir, `${name}.png`)}  ${W}x${H}`);
  console.log(`  ${path.join(sheetDir, `${name}.json`)}`);
  console.log(`  ${catalogPath}: ${entries.length} entries for "${name}" (${kept.length} kept from other sheets)`);
  const byRow = new Map();
  for (const e of entries) {
    const r = e.tags.find((t) => t.startsWith("row"));
    byRow.set(r, (byRow.get(r) ?? 0) + 1);
  }
  for (const [r, n] of byRow) console.log(`    ${r}: ${n} symbols, roles ${rolesFor(found[entries.findIndex((e) => e.tags.includes(r))]).join("+")}`);
}
