#!/usr/bin/env node
/**
 * Bake a weapon type's HELD-weapon model: the ubermesh with ONE packed page of
 * every theme inside it, plus the tables that let an item name its look.
 *
 *   pnpm -F playground weapon-page --recipe longsword --project foundation \
 *     --themes iron-common iron-rusted steel [--model weapons/longsword-uber.glb]
 *
 * Why a page: every held weapon of one type is ONE draw call (a `mesh.moving`
 * instanced batch, see packages/render/src/moving-instances.ts). A draw is one
 * (geometry, material) pair, so every theme has to live on one texture, and an
 * instance picks its tile. Adding a theme means re-running this, never adding
 * a material.
 *
 * What it does, in the order that matters:
 *   1. seam-blends (unless --no-seam-blend) each theme's `tools/atlas/out/<recipe>/<theme>/atlas.png`
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
 * `--with <recipe> --with-themes <a> <b> …` puts a SECOND recipe's mesh into the
 * same model and its themes on the same page: the player's head is the male and
 * the female head in ONE mesh, so a face of either sex is a tile of one page and
 * every head is one draw. Its parts join the part table after the first
 * recipe's; the sheets must be the same size.
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
import { assertSquarePage, squareGrid } from "./_page.mjs";

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
const withRecipe = typeof args.with === "string" ? args.with : null;
const withThemes = args["with-themes"] === undefined || args["with-themes"] === true ? [] : [].concat(args["with-themes"]);
if (withRecipe && withThemes.length === 0) {
  console.error("--with needs --with-themes");
  process.exit(1);
}
// --no-seam-blend: pack the painted sheets as they are (the blend rewrites texels along every island edge)
const seamBlend = args["no-seam-blend"] !== true;
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
const unwrapOf = (name, extra) =>
  execFileSync(process.execPath, [path.join(here, "unwrap-weapon.mjs"), "--recipe", name, "--no-check", ...extra], {
    cwd: PLAYGROUND,
    stdio: "pipe",
  }).toString();
const unwrap = (extra) => unwrapOf(recipe, extra);

// the set's committed files, restored at the end (unwrap-weapon rewrites them)
const setBackup = new Map();
for (const dir of [setDir, ...(withRecipe ? [path.join(ENGINE, "tools", "atlas", "sets", withRecipe)] : [])])
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) setBackup.set(p, fs.readFileSync(p));
  }

try {
  // 1. blend each theme against the key it was painted over
  const sheets = themes.map((theme) => {
    const atlas = path.join(outDir, theme, "atlas.png");
    if (!fs.existsSync(atlas)) throw new Error(`no atlas for theme "${theme}" at ${path.relative(ENGINE, atlas)} — import-atlas it first`);
    if (!seamBlend) return { theme, id: `${textureDir}/${recipe}-${theme}.png`, file: atlas };
    unwrap(["--atlas", atlas, "--out-mesh", path.join(work, `blend-${theme}`)]);
    const blended = path.join(outDir, theme, "atlas-seamblend.png");
    return { theme, id: `${textureDir}/${recipe}-${theme}.png`, file: fs.existsSync(blended) ? blended : atlas };
  });
  for (const theme of withThemes) {
    const dir = path.join(ENGINE, "tools", "atlas", "out", withRecipe, theme);
    const atlas = path.join(dir, "atlas.png");
    if (!fs.existsSync(atlas)) throw new Error(`no atlas for ${withRecipe} theme "${theme}" at ${path.relative(ENGINE, atlas)}`);
    unwrapOf(withRecipe, ["--atlas", atlas, "--out-mesh", path.join(work, `blend-with-${theme}`)]);
    const blended = path.join(dir, "atlas-seamblend.png");
    sheets.push({ theme, id: `${textureDir}/${withRecipe}-${theme}.png`, file: fs.existsSync(blended) ? blended : atlas });
  }

  // 2. pack
  const PAD = 8;
  const decoded = sheets.map((s) => ({ ...s, png: decodePng(fs.readFileSync(s.file)) }));
  const size = decoded[0].png.width;
  for (const d of decoded) {
    if (d.png.width !== size || d.png.height !== size) throw new Error(`${d.theme}: ${d.png.width}px, the page is ${size}px — one sheet size per page`);
  }
  const { cols, stride, W, H } = squareGrid(decoded.length, size, PAD);
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
  assertSquarePage(W, H, `weapon-page ${recipe}`);
  fs.writeFileSync(pagePath, encodePng(W, H, page));

  // 3. bake it into the ubermesh
  unwrap(["--atlas", pagePath, "--seam-blend", "0", "--out-mesh", path.join(work, "baked")]);
  let uber = path.join(work, "baked-uber.glb");
  if (withRecipe) {
    unwrapOf(withRecipe, ["--atlas", pagePath, "--seam-blend", "0", "--out-mesh", path.join(work, "baked-with")]);
    uber = path.join(work, "baked-merged.glb");
    fs.writeFileSync(uber, mergeUber(fs.readFileSync(path.join(work, "baked-uber.glb")), fs.readFileSync(path.join(work, "baked-with-uber.glb"))));
  }

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

/**
 * The second ubermesh's triangles appended to the first's primitive: its part
 * indices (uv1) moved past the first's and its part table merged in. Both were
 * baked with the same page, so the first's material serves both.
 */
function mergeUber(a, b) {
  const read = (glb) => {
    const jl = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jl).toString());
    const bin = glb.subarray(28 + jl, 28 + jl + glb.readUInt32LE(20 + jl));
    const node = json.nodes.find((n) => n.mesh !== undefined);
    const prim = json.meshes[node.mesh].primitives[0];
    const count = json.accessors[prim.attributes.POSITION].count;
    let order = Array.from({ length: count }, (_, i) => i);
    if (prim.indices !== undefined) {
      const acc = json.accessors[prim.indices];
      const view = json.bufferViews[acc.bufferView];
      const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const size = { 5121: 1, 5123: 2, 5125: 4 }[acc.componentType];
      order = Array.from({ length: acc.count }, (_, i) =>
        size === 1 ? bin[start + i] : size === 2 ? bin.readUInt16LE(start + i * 2) : bin.readUInt32LE(start + i * 4),
      );
    }
    // an attribute flattened to the triangle list, `shift` added to its first component
    const flat = (name, shift = 0) => {
      const acc = json.accessors[prim.attributes[name]];
      if (acc.componentType !== 5126) throw new Error(`mergeUber: ${name} is not float`);
      const view = json.bufferViews[acc.bufferView];
      const n = { VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
      const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const stride = view.byteStride ?? n * 4;
      const res = new Float32Array(order.length * n);
      order.forEach((v, i) => {
        for (let c = 0; c < n; c++) res[i * n + c] = bin.readFloatLE(start + v * stride + c * 4) + (c === 0 ? shift : 0);
      });
      return { res, n, type: acc.type };
    };
    return { json, bin, node, prim, flat };
  };
  const A = read(a);
  const B = read(b);
  const offset = Object.keys(A.node.extras.parts).length;
  const chunks = [A.bin];
  let at = A.bin.length;
  const attributes = {};
  for (const name of Object.keys(A.prim.attributes)) {
    if (B.prim.attributes[name] === undefined) throw new Error(`mergeUber: the second mesh has no ${name}`);
    const x = A.flat(name);
    const y = B.flat(name, name === "TEXCOORD_1" ? offset : 0);
    const data = new Float32Array(x.res.length + y.res.length);
    data.set(x.res);
    data.set(y.res, x.res.length);
    const pad = (4 - (at % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      at += pad;
    }
    const buf = Buffer.from(data.buffer);
    A.json.bufferViews.push({ buffer: 0, byteOffset: at, byteLength: buf.length, target: 34962 });
    chunks.push(buf);
    at += buf.length;
    const acc = { bufferView: A.json.bufferViews.length - 1, componentType: 5126, count: data.length / x.n, type: x.type };
    if (name === "POSITION") {
      acc.min = [Infinity, Infinity, Infinity];
      acc.max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < acc.count; i++)
        for (let c = 0; c < 3; c++) {
          acc.min[c] = Math.min(acc.min[c], data[i * 3 + c]);
          acc.max[c] = Math.max(acc.max[c], data[i * 3 + c]);
        }
    }
    A.json.accessors.push(acc);
    attributes[name] = A.json.accessors.length - 1;
  }
  A.prim.attributes = attributes;
  delete A.prim.indices;
  for (const [name, i] of Object.entries(B.node.extras.parts)) {
    if (A.node.extras.parts[name] !== undefined) throw new Error(`mergeUber: both meshes have a part "${name}"`);
    A.node.extras.parts[name] = i + offset;
  }
  const bin = Buffer.concat(chunks);
  const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  A.json.buffers[0].byteLength = binPad.length;
  let js = Buffer.from(JSON.stringify(A.json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + js.length + 8 + binPad.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(js.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(binPad.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jh, js, bh, binPad]);
}
