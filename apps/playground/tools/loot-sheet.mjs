#!/usr/bin/env node
/**
 * The LOOT LIBRARY: inventory icons for things that have no model (potions,
 * monster eyes and parts, ore, gems, jewellery, herbs, vendor junk), made as
 * SPRITE SHEETS rather than one generator call per item.
 *
 *   node tools/loot-sheet.mjs request --project foundation [--sheets potions gems …] [--timeout 3000]
 *   node tools/loot-sheet.mjs slice   --project foundation [--sheets …] [--contact <png>]
 *   node tools/loot-sheet.mjs list    --project foundation [--tag potion]
 *   node tools/loot-sheet.mjs audit   --project foundation
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
 * An item uses one by `"icon": "icons/loot/<id>.png"`. Each icon is put on
 * the same seeded backdrop a rendered item icon gets (`--no-backdrop` for the
 * bare cut-out), and every sliced sheet leaves a 6x zoomed contact sheet at
 * authoring/loot-art/contact/<sheet>.png: LOOK at it before pointing an item
 * at a cell.
 *
 * `audit` lists every item whose icon is missing or broken, and how to get
 * one: a model → tools/item-icon.mjs; no model → the category sheet whose
 * tags it shares. It also flags a modelled item wearing loot art, and a loot
 * icon on an item that lacks its sheet's category tag. Exit 1 when anything
 * needs fixing; a content drop ships only on a clean audit.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./_png.mjs";
import { groundMask, iconFromPixels, recolor, writeContactSheet, backdrop, contrastTint, seedOf } from "./_icon.mjs";

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
if (!["request", "slice", "list", "audit"].includes(cmd) || !project) {
  console.error("usage: loot-sheet.mjs request|slice|list|audit --project <p> [--sheets a b …] [--contact out.png] [--tag t] [--no-backdrop]");
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

/**
 * Peel the pale anti-aliased rim the generator paints where an object meets
 * the white ground (min channel > `lum`, touching ground): left in, it
 * shrinks to a light halo round the icon. A few passes; light objects lose a
 * source pixel or two, which is nothing at 40 px.
 */
function peelHalo(img, ground, { lum = 190, passes = 3 } = {}) {
  const { width: w, height: h, data } = img;
  for (let p = 0; p < passes; p++) {
    const peel = [];
    for (let i = 0; i < w * h; i++) {
      if (ground[i] || Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) <= lum) continue;
      const x = i % w, y = (i / w) | 0;
      if ((x > 0 && ground[i - 1]) || (x < w - 1 && ground[i + 1]) || (y > 0 && ground[i - w]) || (y < h - 1 && ground[i + w])) peel.push(i);
    }
    if (!peel.length) break;
    for (const i of peel) ground[i] = 1;
  }
  return ground;
}

/**
 * White ground the border flood can't reach: the hole in a coiled rope, a
 * sausage ring, a pot's bail or a flask handle. An enclosed near-white region
 * of at least `minArea` pixels whose surroundings (a ring 4 px out) are DARK
 * is a hole: the style outlines every silhouette dark. A highlight fades into
 * light paint (ring luminance ~170-240 on gems and glass, holes ~50-150), so it
 * stays paint.
 */
function openHoles(img, ground, minArea, lum = 240, holeLum = 160) {
  const { width: w, height: h, data } = img;
  const white = (i) => !ground[i] && Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) > lum;
  const seen = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !white(s)) continue;
    const region = [s];
    seen[s] = 1;
    for (let k = 0; k < region.length; k++) {
      const i = region[k], x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
        if (j >= 0 && !seen[j] && white(j)) (seen[j] = 1), region.push(j);
    }
    if (region.length < minArea) continue;
    const inRegion = new Set(region);
    const ring = new Set();
    let front = region;
    for (let d = 0; d < 4; d++) {
      const next = [];
      for (const i of front) {
        const x = i % w, y = (i / w) | 0;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
          if (j >= 0 && !inRegion.has(j) && !ring.has(j)) (ring.add(j), next.push(j));
      }
      front = next;
    }
    let lum = 0;
    for (const j of ring) lum += (data[j * 4] + data[j * 4 + 1] + data[j * 4 + 2]) / 3;
    if (lum / ring.size < holeLum) for (const i of region) ground[i] = 1;
  }
  return ground;
}

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
  const cellArea = (img.width * img.height) / (cols * rows);
  const ground = peelHalo(img, openHoles(img, groundMask(img), cellArea / 800));
  const { label, comps } = components(img, ground);
  // specks (jpeg-ish noise, a stray dot) are dropped; everything else goes to
  // the cell its centre is in
  const minArea = cellArea / 200; // ~1 icon pixel
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
    // only re-tint what this run sliced: the written icons carry a backdrop,
    // so a variant is always cut from the bare cell
    const base = byId.get(v.from);
    if (!base) continue;
    made.push({ id: v.id, icon: recolor(base.icon, v), sheet: base.sheet, tags: base.tags, desc: base.desc, from: v.from });
    variants++;
  }
  const BACKDROP = args["no-backdrop"] !== true;
  for (const m of made) {
    if (BACKDROP) {
      const seed = seedOf(m.id);
      m.icon = backdrop(m.icon, { seed, tint: contrastTint(m.icon, seed) });
    }
    fs.writeFileSync(path.join(outDir, `${m.id}.png`), encodePng(m.icon.width, m.icon.height, m.icon.data));
    library[m.id] = { icon: `icons/loot/${m.id}.png`, sheet: m.sheet, tags: m.tags, desc: m.desc, ...(m.from ? { from: m.from } : {}) };
  }
  const sorted = Object.fromEntries(Object.entries(library).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(libraryFile, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`  ${made.length - variants} sliced + ${variants} variants -> ${path.relative(PLAYGROUND, outDir)} (library: ${Object.keys(sorted).length})`);
  // one zoomed contact sheet per sheet (its cells in grid order, then its variants)
  const contactDir = path.join(artDir, "contact");
  fs.mkdirSync(contactDir, { recursive: true });
  for (const name of wanted) {
    const icons = made.filter((m) => m.sheet === name).map((m) => m.icon);
    if (!icons.length) continue;
    const file = path.join(contactDir, `${name}.png`);
    writeContactSheet(file, icons, { cols: gridOf(spec.sheets[name])[0] });
    console.log(`  contact ${name.padEnd(14)} -> ${path.relative(PLAYGROUND, file)}`);
  }
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

// ---------------------------------------------------------------- audit

if (cmd === "audit") {
  const library = fs.existsSync(libraryFile) ? JSON.parse(fs.readFileSync(libraryFile, "utf8")) : {};
  const itemsDir = path.join(projectDir, "assets", "items");
  const texDir = path.join(projectDir, "assets", "textures");
  const fixes = [];
  for (const f of fs.readdirSync(itemsDir).filter((f) => f.endsWith(".json")).sort()) {
    const id = f.slice(0, -5);
    const item = JSON.parse(fs.readFileSync(path.join(itemsDir, f), "utf8"));
    const model = item.appearance?.model;
    const tags = item.tags ?? [];
    const icon = typeof item.icon === "string" ? item.icon : null;
    const exists = icon && fs.existsSync(path.join(texDir, icon));
    const isLoot = icon?.startsWith("icons/loot/");
    if (exists && !(isLoot && model)) {
      if (isLoot) {
        const e = library[path.basename(icon, ".png")];
        const cat = e ? spec.sheets[e.sheet]?.tags ?? e.tags : [];
        if (e && cat.length && !cat.some((t) => tags.includes(t)))
          fixes.push(`${id.padEnd(24)} tags lack the category of sheet "${e.sheet}" — add one of: ${cat.join(", ")}`);
      }
      continue;
    }
    const why = !icon ? "no icon" : !exists ? `icon missing: ${icon}` : "has a model but wears loot art";
    if (model) {
      fixes.push(`${id.padEnd(24)} ${why} -> RENDER: node tools/item-icon.mjs --project ${project} --item ${id}`);
      continue;
    }
    if (library[id]) {
      fixes.push(`${id.padEnd(24)} ${why} -> sliced icon exists: "icon": "${library[id].icon}"`);
      continue;
    }
    const sheets = Object.entries(spec.sheets)
      .filter(([, sh]) => (sh.tags ?? []).some((t) => tags.includes(t)))
      .map(([n]) => n);
    fixes.push(
      `${id.padEnd(24)} ${why} -> ${sheets.length ? `sheet ${sheets.join(" | ")}: reuse a cell/variant or add the object and re-request` : "no sheet shares its tags: tag it with a category, or start a <category> sheet"}`,
    );
  }
  for (const l of fixes) console.log(l);
  console.log(fixes.length ? `
${fixes.length} item(s) to fix (docs/item-icons.md "Adding an item: which icon route")` : "audit: every item has a working icon on the right route");
  process.exit(fixes.length ? 1 : 0);
}
