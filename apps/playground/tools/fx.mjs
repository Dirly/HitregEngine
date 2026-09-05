/**
 * FX intake: turn a purchased 2D effect library into engine spritesheets.
 *
 * The source library ships one PNG per effect, already laid out as a grid of
 * 64px cells: COLUMNS are the animation timeline, ROWS are colour variants of
 * the same effect. That is exactly the engine's `spritesheet` grid, and
 * exactly what `billboard.flipbook` plays — so intake is a copy plus a small
 * JSON, never a re-pack. Picking a colour at runtime is `flipbook.row`, which
 * is why a generated ability can be tinted without a second texture.
 *
 *   node tools/fx.mjs catalog <out.png>            # contact sheet of every effect
 *   node tools/fx.mjs strip <set:idx,...> <out.png> # filmstrips of candidates
 *   node tools/fx.mjs import <project> <name>=<set>:<idx> ...
 *
 * `import` writes assets/textures/fx/<name>.png + assets/spritesheets/<name>.json.
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "./_png.mjs";

const ROOT = process.env.HITREG_FX_ROOT ?? "D:/Users/Derek/Desktop/HitRegStudios/MMO/Effect and FX";
const CELL = 64;

function sets() {
  const out = [];
  for (let s = 1; ; s++) {
    const dir = path.join(ROOT, `Effects ${s}`);
    if (!fs.existsSync(dir)) break;
    out.push({ set: s, dir, files: fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort() });
  }
  return out;
}

function effectPath(set, index) {
  const dir = path.join(ROOT, `Effects ${set}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
  if (index < 0 || index >= files.length)
    throw new Error(`Effects ${set} has ${files.length} effects; index ${index} is out of range`);
  return path.join(dir, files[index]);
}

/** Composite one 64px cell of `img` onto `buf` at (ox, oy), over dark ground. */
function blit(img, col, row, buf, W, ox, oy) {
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const si = ((row * CELL + y) * img.width + (col * CELL + x)) * 4;
      const di = ((oy + y) * W + (ox + x)) * 4;
      const a = img.data[si + 3] / 255;
      for (let c = 0; c < 3; c++) buf[di + c] = img.data[si + c] * a + buf[di + c] * (1 - a);
    }
  }
}

function ground(buf, r = 16, g = 18, b = 24) {
  for (let i = 0; i < buf.length; i += 4) { buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255; }
}

function cmdCatalog(out) {
  const all = sets();
  const COLS = 25;
  let row = 0;
  const rowOf = {};
  const laid = [];
  for (const s of all) {
    rowOf[s.set] = row;
    s.files.forEach((f, i) => laid.push({ p: path.join(s.dir, f), cell: row * COLS + i }));
    row += Math.ceil(s.files.length / COLS);
  }
  const W = COLS * CELL, H = row * CELL;
  const buf = new Uint8Array(W * H * 4);
  ground(buf);
  for (const e of laid) {
    const img = decodePng(fs.readFileSync(e.p));
    const cols = Math.round(img.width / CELL);
    blit(img, Math.min(cols - 1, Math.round(cols * 0.42)), 0, buf, W, (e.cell % COLS) * CELL, Math.floor(e.cell / COLS) * CELL);
  }
  for (const s of all.slice(1)) {
    const y = rowOf[s.set] * CELL;
    for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; buf[i] = 90; buf[i+1] = 100; buf[i+2] = 130; }
  }
  fs.writeFileSync(out, encodePng(W, H, buf));
  console.log(`${laid.length} effects -> ${out} (${COLS} cols)`);
  for (const s of all) console.log(`  Effects ${String(s.set).padStart(2)}: ${s.files.length} effects, starts at row ${rowOf[s.set]}`);
}

function cmdStrip(spec, out) {
  const picks = spec.split(",").map((t) => t.split(":").map(Number));
  const FRAMES = 8;
  const W = FRAMES * CELL, H = picks.length * CELL;
  const buf = new Uint8Array(W * H * 4);
  ground(buf);
  picks.forEach(([set, idx], r) => {
    const img = decodePng(fs.readFileSync(effectPath(set, idx)));
    const cols = Math.round(img.width / CELL);
    for (let f = 0; f < FRAMES; f++)
      blit(img, Math.min(cols - 1, Math.round((f / (FRAMES - 1)) * (cols - 1))), 0, buf, W, f * CELL, r * CELL);
    console.log(`  row ${r}: Effects ${set}[${idx}] — ${cols} frames x ${Math.round(img.height / CELL)} colours`);
  });
  fs.writeFileSync(out, encodePng(W, H, buf));
  console.log(`${picks.length} filmstrips -> ${out}`);
}

function cmdImport(project, specs) {
  const base = path.join("projects", project, "assets");
  const texDir = path.join(base, "textures", "fx");
  const sheetDir = path.join(base, "spritesheets");
  fs.mkdirSync(texDir, { recursive: true });
  fs.mkdirSync(sheetDir, { recursive: true });
  for (const spec of specs) {
    const [name, loc] = spec.split("=");
    const [set, idx] = loc.split(":").map(Number);
    const src = effectPath(set, idx);
    const img = decodePng(fs.readFileSync(src));
    const cols = Math.round(img.width / CELL);
    const rows = Math.round(img.height / CELL);
    fs.copyFileSync(src, path.join(texDir, `${name}.png`));
    fs.writeFileSync(
      path.join(sheetDir, `${name}.json`),
      JSON.stringify(
        {
          // Data assets are FLAT documents: the loader validates the file
          // itself against the type's schema, exactly as a material does.
          // Wrapping it in {type, data} makes every field read as missing.
          texture: `fx/${name}.png`,
          grid: { cols, rows, frameWidth: CELL, frameHeight: CELL, margin: 0, spacing: 0 },
          frames: {},
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`  ${name}: Effects ${set}[${path.basename(src)}] ${cols} frames x ${rows} colours`);
  }
  console.log(`imported ${specs.length} effects into projects/${project}`);
}

/** Every colour row of one effect at its peak frame — the flipbook.row menu. */
function cmdColors(loc, out) {
  const [set, idx] = loc.split(":").map(Number);
  const img = decodePng(fs.readFileSync(effectPath(set, idx)));
  const cols = Math.round(img.width / CELL);
  const rows = Math.round(img.height / CELL);
  const W = CELL * 3, H = rows * CELL;
  const buf = new Uint8Array(W * H * 4);
  ground(buf);
  for (let r = 0; r < rows; r++)
    for (let f = 0; f < 3; f++)
      blit(img, Math.min(cols - 1, Math.round(((f + 1) / 4) * (cols - 1))), r, buf, W, f * CELL, r * CELL);
  fs.writeFileSync(out, encodePng(W, H, buf));
  console.log(`Effects ${set}[${idx}]: ${rows} colour rows -> ${out}`);
}

/**
 * Export ONE colour row of an effect as a single-row strip, for use as a
 * particle sub-UV sheet.
 *
 * A particle sheet has to be one row: `subUV` walks cells left-to-right and
 * top-to-bottom, so handing it the full nine-colour sheet would animate a
 * puff of smoke through every hue in the library. Row 5 is the greyscale one,
 * which is what you want — the particle system tints it per emitter.
 */
function cmdParticleSheet(project, specs, row) {
  const texDir = path.join("projects", project, "assets", "textures", "fx");
  fs.mkdirSync(texDir, { recursive: true });
  for (const spec of specs) {
    const [name, loc] = spec.split("=");
    const [set, idx] = loc.split(":").map(Number);
    const img = decodePng(fs.readFileSync(effectPath(set, idx)));
    const cols = Math.round(img.width / CELL);
    const rows = Math.round(img.height / CELL);
    const pick = Math.min(Math.max(0, row), rows - 1);
    const out = new Uint8Array(cols * CELL * CELL * 4);
    for (let y = 0; y < CELL; y++) {
      const sy = pick * CELL + y;
      for (let x = 0; x < cols * CELL; x++) {
        const si = (sy * img.width + x) * 4;
        const di = (y * cols * CELL + x) * 4;
        out[di] = img.data[si];
        out[di + 1] = img.data[si + 1];
        out[di + 2] = img.data[si + 2];
        out[di + 3] = img.data[si + 3];
      }
    }
    fs.writeFileSync(path.join(texDir, `${name}.png`), encodePng(cols * CELL, CELL, out));
    console.log(`  ${name}: row ${pick} of Effects ${set}[${idx}] -> ${cols} frames (subUV cols ${cols}, rows 1)`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "catalog") cmdCatalog(rest[0] ?? "fx-catalog.png");
else if (cmd === "strip") cmdStrip(rest[0], rest[1] ?? "fx-strip.png");
else if (cmd === "particle-sheet") {
  const rowFlag = rest.indexOf("--row");
  const row = rowFlag >= 0 ? Number(rest[rowFlag + 1]) : 5;
  const specs = rest.slice(1).filter((a, i) => {
    const at = i + 1;
    return a !== "--row" && rest[at - 1] !== "--row" && a.includes("=");
  });
  cmdParticleSheet(rest[0], specs, row);
} else if (cmd === "colors") cmdColors(rest[0], rest[1] ?? "fx-colors.png");
else if (cmd === "import") cmdImport(rest[0], rest.slice(1));
else if (cmd === "masks") {
  const sizeFlag = rest.indexOf("--size");
  const { cmdMasks } = await import("./fx-masks.mjs");
  cmdMasks(rest[0], sizeFlag >= 0 ? Number(rest[sizeFlag + 1]) : 48);
} else if (cmd === "symbols") {
  const { cmdSymbols } = await import("./fx-symbols.mjs");
  cmdSymbols(rest[0], rest[1], rest[2], rest.slice(3));
} else {
  console.error(`usage:
  node tools/fx.mjs catalog <out.png>
  node tools/fx.mjs strip <set:idx,set:idx,...> <out.png>
  node tools/fx.mjs colors <set:idx> <out.png>
  node tools/fx.mjs particle-sheet <project> <name>=<set>:<idx> [--row 5]
  node tools/fx.mjs import <project> <name>=<set>:<idx> ...
  node tools/fx.mjs masks <project> [--size 48]     # PSX black/white masks for ring textures
  node tools/fx.mjs symbols <project> <name> <sheet.png> [--roles sigil,glyph] [--rows 0-2=head,3-5=stuck] [--tags ...]
                                                    # slice a hand-drawn symbol sheet into a grid + catalog entries`);
  process.exit(1);
}
