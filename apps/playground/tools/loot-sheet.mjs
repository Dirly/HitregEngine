#!/usr/bin/env node
/**
 * The LOOT LIBRARY: inventory icons for things that have no model (potions,
 * monster eyes and parts, ore, gems, jewellery, herbs, vendor junk), made as
 * SPRITE SHEETS rather than one generator call per item.
 *
 *   node tools/loot-sheet.mjs request --project voxel-demo [--sheets potions gems …] [--timeout 3000]
 *   node tools/loot-sheet.mjs slice   --project voxel-demo [--sheets …] [--contact <png>]
 *   node tools/loot-sheet.mjs list    --project voxel-demo [--tag potion]
 *
 * Why sheets: an icon ends up ~40 px, and a generator call makes a 1024 image.
 * One call per item throws almost all of it away; a 4x4 sheet gets sixteen
 * objects out of the same call, drawn in ONE style with one light, so the set
 * reads as a set. Recolouring (`variants`) then multiplies them: a red flask
 * becomes blue, green and gold without another call.
 *
 * Everything is described in projects/<p>/authoring/loot-sheets.json:
 *   style     one paragraph every sheet's prompt carries
 *   sheets    <name>: { tags, items: [{ id, desc }] } — 16 items, read row by
 *             row into a 4x4 grid (`grid: [cols, rows]` to change it)
 *   variants  [{ id, from, setHue | hue, sat, val, band, minSat }] — see
 *             recolor() in _icon.mjs; only coloured pixels move, so glass,
 *             cork and iron keep their colour
 *
 * `request` generates the sheets (tools/image-request.mjs gen-set, one Codex
 * session) into projects/<p>/authoring/loot-art/<sheet>.png. `slice` cuts
 * them up: the white ground is flooded away, every remaining blob goes to the
 * grid cell its centre falls in (so a sparkle or a drip stays with its
 * object), and each cell becomes one icon through the same crop / shrink /
 * hard-alpha steps as a rendered item icon. Output:
 *   assets/textures/icons/loot/<id>.png
 *   assets/textures/icons/loot/library.json   id → { icon, sheet, tags, desc, from? }
 * An item uses one by `"icon": "icons/loot/<id>.png"`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./_png.mjs";
import { groundMask, iconFromPixels, recolor, writeContactSheet } from "./_icon.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(here, "..");

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
{
  let key = null;
  for (const a of rest) {
    if (a.startsWith("--")) {
      key = a.slice(2);
      args[key] = true;
    } else if (key) args[key] = args[key] === true ? a : [].concat(args[key], a);
  }
}
const project = typeof args.project === "string" ? args.project : null;
if (!["request", "slice", "list"].includes(cmd) || !project) {
  console.error("usage: loot-sheet.mjs request|slice|list --project <p> [--sheets a b …] [--contact out.png] [--tag t]");
  process.exit(1);
}
const projectDir = path.join(PLAYGROUND, "projects", project);
const spec = JSON.parse(fs.readFileSync(path.join(projectDir, "authoring", "loot-sheets.json"), "utf8"));
const artDir = path.join(projectDir, "authoring", "loot-art");
const outDir = path.join(projectDir, "assets", "textures", "icons", "loot");
const libraryFile = path.join(outDir, "library.json");
const SIZE = Number(args.size ?? 40);
const wanted = args.sheets === undefined || args.sheets === true ? Object.keys(spec.sheets) : [].concat(args.sheets);
for (const s of wanted) if (!spec.sheets[s]) (console.error(`! no sheet "${s}" in loot-sheets.json`), process.exit(1));

const gridOf = (sheet) => sheet.grid ?? [4, 4];

// ---------------------------------------------------------------- request

function prompt(name, sheet) {
  const [cols, rows] = gridOf(sheet);
  const list = sheet.items
    .map((it, i) => `  ${i + 1}. (row ${Math.floor(i / cols) + 1}, column ${(i % cols) + 1}) ${it.desc}`)
    .join("\n");
  return [
    "NO TEXT, NO LETTERS, NO NUMBERS, NO LABELS, NO GRID LINES, NO FRAMES anywhere on the image. Background pure white #FFFFFF, flat, no shadows, no floor, no vignette.",
    "",
    `A SPRITE SHEET of ${sheet.items.length} separate inventory item icons (${name}), laid out as an invisible ${cols} x ${rows} grid of EQUAL square cells.`,
    "Each object sits CENTRED in its own cell, filling about 70% of the cell, with clear white space all around it. No object touches or overlaps another, or crosses into a neighbouring cell. Nothing in between the objects.",
    "",
    spec.style,
    "",
    "Nothing painted pure white or near-white on the objects themselves except tiny highlights; the white is the background.",
    "",
    `The objects, in reading order (row by row, left to right):`,
    list,
    "",
    `FINAL CHECK: exactly ${sheet.items.length} objects in a ${cols} x ${rows} grid, in the order above; no text or numbers; pure white background.`,
  ].join("\n");
}

if (cmd === "request") {
  fs.mkdirSync(artDir, { recursive: true });
  const images = wanted.map((name) => ({
    id: `loot-${project}-${name}`,
    target: path.relative(PLAYGROUND, path.join(artDir, `${name}.png`)).replaceAll("\\", "/"),
    size: "1024x1024",
    purpose: `loot sprite sheet: ${name}`,
    prompt: prompt(name, spec.sheets[name]),
  }));
  const manifest = path.join(PLAYGROUND, ".hitreg", `loot-sheets-${project}-${wanted.join("-")}.json`);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ images }, null, 1));
  const res = spawnSync(
    process.execPath,
    [path.join(here, "image-request.mjs"), "gen-set", "--manifest", manifest, "--timeout", String(args.timeout ?? 3000)],
    { cwd: PLAYGROUND, stdio: "inherit" },
  );
  process.exit(res.status ?? 1);
}

// ---------------------------------------------------------------- slice

/** Connected components of non-ground pixels (4-neighbour). */
function components(img, ground) {
  const { width: w, height: h } = img;
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  for (let s = 0; s < w * h; s++) {
    if (ground[s] || label[s] >= 0) continue;
    const id = comps.length;
    const c = { id, n: 0, sx: 0, sy: 0 };
    const stack = [s];
    label[s] = id;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      c.n++; c.sx += x; c.sy += y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || ground[j] || label[j] >= 0) continue;
        label[j] = id;
        stack.push(j);
      }
    }
    comps.push(c);
  }
  return { label, comps };
}

function sliceSheet(name) {
  const sheet = spec.sheets[name];
  const file = path.join(artDir, `${name}.png`);
  if (!fs.existsSync(file)) {
    console.warn(`- ${name}: no art at ${path.relative(PLAYGROUND, file)} — run request first`);
    return [];
  }
  const img = decodePng(fs.readFileSync(file));
  const [cols, rows] = gridOf(sheet);
  const ground = groundMask(img);
  const { label, comps } = components(img, ground);
  // specks (jpeg-ish noise, a stray dot) are dropped; everything else goes to
  // the cell its centre is in
  const minArea = (img.width * img.height) / (cols * rows) / 400;
  const cellOf = new Map();
  for (const c of comps) {
    if (c.n < minArea) continue;
    const cx = c.sx / c.n, cy = c.sy / c.n;
    const cell = Math.min(rows - 1, Math.floor((cy / img.height) * rows)) * cols + Math.min(cols - 1, Math.floor((cx / img.width) * cols));
    cellOf.set(c.id, cell);
  }
  const out = [];
  sheet.items.forEach((item, cell) => {
    const has = [...cellOf.values()].includes(cell);
    if (!has) {
      console.warn(`  ! ${name}: cell ${cell + 1} (${item.id}) is empty — the generator left it out or put it elsewhere`);
      return;
    }
    const icon = iconFromPixels(img, (i) => label[i] >= 0 && cellOf.get(label[i]) === cell, SIZE);
    out.push({ id: item.id, icon, sheet: name, tags: sheet.tags ?? [], desc: item.desc });
  });
  const objects = new Set(cellOf.values()).size;
  if (objects !== sheet.items.length)
    console.warn(`  ! ${name}: ${objects} cells hold an object, expected ${sheet.items.length}`);
  return out;
}

if (cmd === "slice") {
  fs.mkdirSync(outDir, { recursive: true });
  const library = fs.existsSync(libraryFile) ? JSON.parse(fs.readFileSync(libraryFile, "utf8")) : {};
  const made = [];
  for (const name of wanted) {
    const icons = sliceSheet(name);
    for (const e of icons) made.push(e);
    console.log(`  ${name.padEnd(14)} ${icons.length} icons`);
  }
  // variants of anything in this run, or already in the library
  const byId = new Map(made.map((m) => [m.id, m]));
  let variants = 0;
  for (const v of spec.variants ?? []) {
    let base = byId.get(v.from);
    if (!base && library[v.from]) {
      const icon = decodePng(fs.readFileSync(path.join(outDir, path.basename(library[v.from].icon))));
      base = { ...library[v.from], id: v.from, icon: { width: icon.width, height: icon.height, data: icon.data } };
    }
    if (!base) continue;
    if (!byId.has(v.from) && !wanted.includes(library[v.from]?.sheet)) continue; // only re-tint what this run touched
    made.push({ id: v.id, icon: recolor(base.icon, v), sheet: base.sheet, tags: base.tags, desc: base.desc, from: v.from });
    variants++;
  }
  for (const m of made) {
    fs.writeFileSync(path.join(outDir, `${m.id}.png`), encodePng(m.icon.width, m.icon.height, m.icon.data));
    library[m.id] = { icon: `icons/loot/${m.id}.png`, sheet: m.sheet, tags: m.tags, desc: m.desc, ...(m.from ? { from: m.from } : {}) };
  }
  const sorted = Object.fromEntries(Object.entries(library).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(libraryFile, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`  ${made.length - variants} sliced + ${variants} variants -> ${path.relative(PLAYGROUND, outDir)} (library: ${Object.keys(sorted).length})`);
  if (typeof args.contact === "string") {
    writeContactSheet(path.resolve(args.contact), made.map((m) => m.icon), { cols: 16 });
    console.log(`  contact -> ${args.contact}`);
  }
}

// ---------------------------------------------------------------- list

if (cmd === "list") {
  const library = fs.existsSync(libraryFile) ? JSON.parse(fs.readFileSync(libraryFile, "utf8")) : {};
  const tag = typeof args.tag === "string" ? args.tag : null;
  for (const [id, e] of Object.entries(library)) {
    if (tag && !e.tags.includes(tag)) continue;
    console.log(`${id.padEnd(26)} ${e.icon.padEnd(40)} ${e.tags.join(",")}  ${e.desc}`);
  }
}
