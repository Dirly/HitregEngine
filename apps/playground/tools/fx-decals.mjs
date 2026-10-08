/**
 * Decal intake: turn a sheet of ground marks (cracks, frost, sprouting
 * growth…) drawn light-on-dark in a grid into a DECAL PAGE the `decal`
 * module grows in from the strike point.
 *
 *   node tools/fx.mjs decals <project> <name> <sheet.png> [options]
 *     --grid 3x3                   how the source page is laid out (cols x rows)
 *     --downsample 2               box-filter the page down first (as symbols do)
 *     --elements nature            the school(s) these marks belong to
 *     --tags scar                  tags on every decal
 *     --cells "crack;vine,leaf;…"  per-cell tags, reading order, ';' between cells
 *     --pad 3                      pixels of air around each mark in its cell
 *
 * A decal page is DATA, not art — the module samples it raw:
 *   R  WHEN the texel appears, 0 (at the strike) .. 255 (last)
 *   G  the drawn brightness (the art's own shading)
 *   A  coverage
 *
 * The timing is a distance measured ALONG the mark: a shortest path through
 * covered texels from the texel nearest the cell centre, so a crack races
 * down its own line and a vine creeps along its stem instead of the whole
 * mark wiping in as a circle. A piece that does not touch the rest (a hail
 * stone, a separate leaf) starts when a circle from the centre reaches its
 * nearest texel, then grows along itself from there.
 *
 * Writes assets/textures/fx/decals/<name>.png, assets/spritesheets/<name>.json
 * and the entries in assets/fx-catalog/decals.json (replacing this sheet's).
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./_png.mjs";
import { alphaMap, background, downsample } from "./fx-symbols.mjs";

function parseArgs(rest) {
  const opts = { grid: [3, 3], downsample: 1, elements: [], tags: [], cells: [], pad: 3 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--grid") opts.grid = rest[++i].split("x").map(Number);
    else if (a === "--downsample") opts.downsample = Math.max(1, Math.round(Number(rest[++i])));
    else if (a === "--elements") opts.elements = rest[++i].split(",").filter(Boolean);
    else if (a === "--tags") opts.tags = rest[++i].split(",").filter(Boolean);
    else if (a === "--cells") opts.cells = rest[++i].split(";").map((c) => c.split(",").map((t) => t.trim()).filter(Boolean));
    else if (a === "--pad") opts.pad = Number(rest[++i]);
  }
  return opts;
}

/** Tight box of covered texels inside a region; null when empty. */
function box(alpha, W, x0, y0, x1, y1) {
  let bx0 = x1, by0 = y1, bx1 = -1, by1 = -1;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (alpha[y * W + x] > 24) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
  return bx1 < 0 ? null : { x0: bx0, y0: by0, x1: bx1, y1: by1, w: bx1 - bx0 + 1, h: by1 - by0 + 1 };
}

/** Binary-heap Dijkstra over covered texels; sources carry their own start distance. */
function reveal(cov, w, h, sources) {
  // Float64: a float32 store rounds below the float64 key it was pushed with, and
  // the stale-entry check then discards every settled texel
  const dist = new Float64Array(w * h).fill(Infinity);
  const heap = [];
  const push = (d, i) => {
    heap.push([d, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  for (const [i, d] of sources) if (d < dist[i]) { dist[i] = d; push(d, i); }
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const x = i % w, y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (!cov[j]) continue;
        const nd = d + (dx && dy ? Math.SQRT2 : 1);
        if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
      }
  }
  return dist;
}

/** Connected pieces (8-way) of the covered texels. */
function pieces(cov, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const out = [];
  for (let s = 0; s < w * h; s++) {
    if (!cov[s] || label[s] >= 0) continue;
    const id = out.length;
    const members = [];
    const stack = [s];
    label[s] = id;
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (cov[j] && label[j] < 0) { label[j] = id; stack.push(j); }
        }
    }
    out.push(members);
  }
  return out;
}

export function cmdDecals(project, name, source, rest) {
  const opts = parseArgs(rest);
  const img = downsample(decodePng(fs.readFileSync(source)), opts.downsample);
  const bg = background(img);
  const alpha = alphaMap(img, bg);
  const [gc, gr] = opts.grid;
  const W = img.width;
  const cw = Math.floor(img.width / gc), ch = Math.floor(img.height / gr);

  // find each mark inside its grid cell
  const marks = [];
  for (let r = 0; r < gr; r++)
    for (let c = 0; c < gc; c++) {
      const b = box(alpha, W, c * cw, r * ch, (c + 1) * cw, (r + 1) * ch);
      if (b) marks.push({ c, r, b, index: r * gc + c });
    }
  if (marks.length === 0) throw new Error(`no marks found in ${source}`);
  const biggest = Math.max(...marks.map((m) => Math.max(m.b.w, m.b.h)));
  const cell = Math.ceil((biggest + opts.pad * 2) / 8) * 8;
  const cols = gc, rows = Math.ceil(marks.length / gc);
  const PW = cols * cell, PH = rows * cell;
  const page = new Uint8Array(PW * PH * 4);
  for (let i = 0; i < PW * PH; i++) page[i * 4] = 255; // uncovered = "never"

  const entries = [];
  marks.forEach((m, n) => {
    const { b } = m;
    const w = b.w, h = b.h;
    const a = new Uint8Array(w * h);
    let peak = 1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = alpha[(b.y0 + y) * W + b.x0 + x];
        a[y * w + x] = v;
        if (v > peak) peak = v;
      }
    const cov = a.map((v) => (v > 8 ? 1 : 0));
    // the strike point: the middle of the mark
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const sources = pieces(cov, w, h).map((members) => {
      let best = members[0], bd = Infinity;
      for (const i of members) {
        const x = i % w, y = (i - x) / w;
        const d = Math.hypot(x - cx, y - cy);
        if (d < bd) { bd = d; best = i; }
      }
      return [best, bd];
    });
    const dist = reveal(cov, w, h, sources);
    let maxD = 1;
    for (let i = 0; i < w * h; i++) if (cov[i] && Number.isFinite(dist[i]) && dist[i] > maxD) maxD = dist[i];
    const col = n % cols, row = Math.floor(n / cols);
    const ox = col * cell + Math.floor((cell - w) / 2), oy = row * cell + Math.floor((cell - h) / 2);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!cov[i]) continue;
        const di = ((oy + y) * PW + ox + x) * 4;
        page[di] = Math.round(Math.min(1, dist[i] / maxD) * 255);
        page[di + 1] = Math.round((a[i] / peak) * 255);
        page[di + 2] = 255;
        page[di + 3] = a[i];
      }
    entries.push({
      id: `${name}:${n}`,
      sheet: name,
      cell: [col, row],
      tags: [...opts.tags, ...(opts.cells[m.index] ?? [])],
      ...(opts.elements.length ? { elements: opts.elements } : {}),
      enabled: true,
      aspect: Math.round(Math.max(0.25, Math.min(4, w / h)) * 100) / 100,
    });
  });

  const base = path.join("projects", project, "assets");
  const texDir = path.join(base, "textures", "fx", "decals");
  const sheetDir = path.join(base, "spritesheets");
  const catalogDir = path.join(base, "fx-catalog");
  for (const d of [texDir, sheetDir, catalogDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(texDir, `${name}.png`), encodePng(PW, PH, page));
  fs.writeFileSync(
    path.join(sheetDir, `${name}.json`),
    JSON.stringify({ texture: `fx/decals/${name}.png`, grid: { cols, rows, frameWidth: cell, frameHeight: cell, margin: 0, spacing: 0 }, frames: {} }, null, 2) + "\n",
  );
  const catalogPath = path.join(catalogDir, "decals.json");
  let catalog = { version: 1, decals: [] };
  if (fs.existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    } catch {
      /* start over */
    }
  }
  const kept = (catalog.decals ?? []).filter((d) => d.sheet !== name);
  fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, decals: [...kept, ...entries] }, null, 2) + "\n");
  console.log(`${entries.length} decals from ${path.basename(source)} -> ${cols}x${rows} cells of ${cell}px (${PW}x${PH})`);
  for (const e of entries) console.log(`  ${e.id} [${e.cell}] ${e.tags.join(",")}`);
}
