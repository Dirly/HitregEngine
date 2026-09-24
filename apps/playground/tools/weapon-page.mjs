#!/usr/bin/env node
/**
 * Bake a weapon type's HELD-weapon model: the ubermesh with ONE packed page of
 * every theme inside it, plus the tables that let an item name its look.
 *
 *   pnpm -F playground weapon-page --recipe longsword --project voxel-demo \
 *     --themes iron-common iron-rusted steel [--model weapons/longsword-uber.glb]
 *
 * Why a page: every held weapon of one type is ONE draw call (a `mesh.moving`
 * instanced batch, see packages/render/src/moving-instances.ts). A draw is one
 * (geometry, material) pair, so every theme has to live on one texture, and an
 * instance picks its tile. Adding a theme means re-running this, never adding
 * a material.
 *
 * What it does, in the order that matters:
 *   1. seam-blends each theme's `tools/atlas/out/<recipe>/<theme>/atlas.png`
 *      ON ITS OWN. The blend reads the key's UV layout, so running it on a
 *      packed page writes into the wrong texels.
 *   2. packs the blended sheets into one page (8px gutters of edge pixels).
 *   3. bakes the page into the ubermesh (`unwrap-weapon --atlas … --seam-blend 0`).
 *   4. writes `parts` (name → bit) and `tiles` (theme texture id → [u, v, scale])
 *      into the mesh node's glTF extras, which is what `ctx.setModelLook` and the
 *      moving batches resolve an item's `appearance` against.
 *   5. installs the model into projects/<project>/assets/models/<model>, and
 *      each blended theme sheet into assets/textures/<dir>/<recipe>-<theme>.png.
 *      Those sheet ids are the tile keys, and a host without the moving
 *      system still draws the look from them.
 *   6. re-renders the inventory icon of every item drawn from the model
 *      (item-icon.mjs --model), so icons follow the bake.
 *
 * unwrap-weapon also rewrites the recipe's key files in tools/atlas/sets/ as a
 * side effect. This tool puts them back as they were.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./_png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(here, "..");
const ENGINE = path.resolve(PLAYGROUND, "../..");

const args = {};
{
  let key = null;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--")) {
      key = a.slice(2);
      args[key] = true;
    } else if (key) args[key] = args[key] === true ? a : [].concat(args[key], a);
  }
}
const recipe = typeof args.recipe === "string" ? args.recipe : null;
const project = typeof args.project === "string" ? args.project : null;
const themes = args.themes === undefined || args.themes === true ? [] : [].concat(args.themes);
if (!recipe || !project || themes.length === 0) {
  console.error("usage: weapon-page --recipe <name> --project <project> --themes <a> <b> … [--model weapons/<recipe>-uber.glb]");
  process.exit(1);
}
const modelId = typeof args.model === "string" ? args.model : `weapons/${recipe}-uber.glb`;
const textureDir = path.posix.dirname(modelId);
const assets = path.join(PLAYGROUND, "projects", project, "assets");
if (!fs.existsSync(assets)) {
  console.error(`! no project assets at ${assets}`);
  process.exit(1);
}
const outDir = path.join(ENGINE, "tools", "atlas", "out", recipe);
const setDir = path.join(ENGINE, "tools", "atlas", "sets", recipe);
const work = fs.mkdtempSync(path.join(os.tmpdir(), `weapon-page-${recipe}-`));
const unwrap = (extra) =>
  execFileSync(process.execPath, [path.join(here, "unwrap-weapon.mjs"), "--recipe", recipe, "--no-check", ...extra], {
    cwd: PLAYGROUND,
    stdio: "pipe",
  }).toString();

// the set's committed files, restored at the end (unwrap-weapon rewrites them)
const setBackup = new Map();
for (const f of fs.existsSync(setDir) ? fs.readdirSync(setDir) : []) {
  const p = path.join(setDir, f);
  if (fs.statSync(p).isFile()) setBackup.set(p, fs.readFileSync(p));
}

try {
  // 1. blend each theme against the key it was painted over
  const sheets = themes.map((theme) => {
    const atlas = path.join(outDir, theme, "atlas.png");
    if (!fs.existsSync(atlas)) throw new Error(`no atlas for theme "${theme}" at ${path.relative(ENGINE, atlas)} — import-atlas it first`);
    unwrap(["--atlas", atlas, "--out-mesh", path.join(work, `blend-${theme}`)]);
    const blended = path.join(outDir, theme, "atlas-seamblend.png");
    return { theme, id: `${textureDir}/${recipe}-${theme}.png`, file: fs.existsSync(blended) ? blended : atlas };
  });

  // 2. pack
  const PAD = 8;
  const decoded = sheets.map((s) => ({ ...s, png: decodePng(fs.readFileSync(s.file)) }));
  const size = decoded[0].png.width;
  for (const d of decoded) {
    if (d.png.width !== size || d.png.height !== size) throw new Error(`${d.theme}: ${d.png.width}px, the page is ${size}px — one sheet size per page`);
  }
  const cols = Math.ceil(Math.sqrt(decoded.length));
  const rows = Math.ceil(decoded.length / cols);
  const stride = size + PAD * 2;
  const W = cols * stride;
  const H = rows * stride;
  const page = new Uint8Array(W * H * 4);
  const tiles = {};
  decoded.forEach((d, i) => {
    const ox = (i % cols) * stride + PAD;
    const oy = Math.floor(i / cols) * stride + PAD;
    for (let y = -PAD; y < size + PAD; y++) {
      const sy = Math.min(size - 1, Math.max(0, y));
      for (let x = -PAD; x < size + PAD; x++) {
        const sx = Math.min(size - 1, Math.max(0, x));
        const s = (sy * size + sx) * 4;
        page.set(d.png.data.subarray(s, s + 4), ((oy + y) * W + ox + x) * 4);
      }
    }
    // glTF UVs run V from the top, like the page's rows
    tiles[d.id] = [ox / W, oy / H, size / W].map((v) => +v.toFixed(6));
  });
  const pagePath = path.join(work, `${recipe}-page.png`);
  fs.writeFileSync(pagePath, encodePng(W, H, page));

  // 3. bake it into the ubermesh
  unwrap(["--atlas", pagePath, "--seam-blend", "0", "--out-mesh", path.join(work, "baked")]);
  const uber = path.join(work, "baked-uber.glb");

  // 4. part + tile tables into the mesh node's extras
  const glb = fs.readFileSync(uber);
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
  const rest = glb.subarray(20 + jsonLen);
  const node = json.nodes.find((n) => n.mesh !== undefined);
  if (!node?.extras?.parts) throw new Error("the baked ubermesh has no part table — is unwrap-weapon older than the extras change?");
  node.extras.tiles = tiles;
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + js.length + rest.length, 8);
  header.writeUInt32LE(js.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);

  // 5. install
  const modelPath = path.join(assets, "models", ...modelId.split("/"));
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  fs.writeFileSync(modelPath, Buffer.concat([header, js, rest]));
  for (const s of sheets) {
    const dest = path.join(assets, "textures", ...s.id.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(s.file, dest);
  }

  console.log(`weapon-page: ${recipe} — ${sheets.length} themes on a ${W}x${H} page (${size}px tiles)`);
  for (const [id, t] of Object.entries(tiles)) console.log(`  ${id.padEnd(40)} [${t.join(", ")}]`);
  console.log(`  parts: ${Object.keys(node.extras.parts).join(", ")}`);
  console.log(`  wrote ${path.relative(ENGINE, modelPath)}`);
  console.log(`  items name a theme by its sheet id, e.g. "texture": "${sheets[0].id}"`);

  // 6. inventory icons: every item drawn from this model is re-rendered from
  // the fresh bake, so an icon never shows last bake's theme or parts
  // (docs/item-icons.md). Items written after the bake need their own run.
  execFileSync(process.execPath, [path.join(here, "item-icon.mjs"), "--project", project, "--model", modelId], {
    cwd: PLAYGROUND,
    stdio: "inherit",
  });
} finally {
  for (const [p, bytes] of setBackup) fs.writeFileSync(p, bytes);
  fs.rmSync(work, { recursive: true, force: true });
}
