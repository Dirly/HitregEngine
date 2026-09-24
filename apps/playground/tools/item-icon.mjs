#!/usr/bin/env node
/**
 * Inventory icons for items, made from the item itself.
 *
 *   node tools/item-icon.mjs --project voxel-demo --all            # every item with an `appearance`
 *   node tools/item-icon.mjs --project voxel-demo --item steel-heater iron-heater
 *   node tools/item-icon.mjs --project voxel-demo --model weapons/shield-uber.glb   # every item on one model
 *   node tools/item-icon.mjs --project voxel-demo --item rat-tail --from-image art/rat-tail.png
 *   ... [--size 40] [--no-backdrop] [--tint #hex] [--outline] [--sheet out.png] [--dry]
 *
 * BACKDROP (default): every icon sits on an opaque ground of fractal noise
 * with a soft glow behind the object and a darker rim, outlined 1 px, so it
 * pops in the cell the way the hand-made mmo-ui icons do. Seeded by the item
 * id (the same item always gets the same ground), tinted by the item's `tint`,
 * else its rarity colour, else — common gear — whichever muted colour
 * contrasts most with the object. `--no-backdrop` gives the bare transparent
 * cut-out.
 *
 * An item with an `appearance` is RENDERED: its own ubermesh, trimmed to its
 * parts, wearing its theme sheet, lit, and shrunk to an icon. No image
 * generator, so the icon always matches what the player holds, and a new
 * theme or part pick costs one command. An item with no model (trash loot, ore,
 * potions) has nothing to render; generate a picture of it once and pass it
 * with `--from-image`, and it goes through the same crop, shrink and alpha
 * steps, so both kinds of icon come out the same size and edge style.
 *
 * Output: assets/textures/icons/<item-id>.png, and the item's `icon` field is
 * pointed at it (`--dry` writes the PNG only).
 *
 * The size matches the hand-made mmo-ui icons: cropped to the object, longest
 * side ~40 px (they run 24-36 wide by 32-44 tall). The inventory scales them
 * into the cell with `image-rendering: pixelated`, so edges are kept HARD:
 * alpha is thresholded, never feathered.
 *
 * How an item is framed is per MODEL, in projects/<p>/authoring/item-icons.json:
 *
 *   { "models": { "weapons/longsword-uber.glb": { "from": [1, 0, 0], "up": [0, 1, 0], "roll": -45 } },
 *     "items":  { "dagger": { "roll": -30 } } }
 *
 * `from` is the side of the model the camera looks at (model axes), `up` the
 * model direction that points up the icon before `roll` (degrees,
 * counter-clockwise) turns it. Swords lie on the diagonal, tip top-right, the
 * way the hand-made icons have them; shields face the camera.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng } from "./_png.mjs";
import { SS, downsample, outline, groundMask, iconFromPixels, writeContactSheet, backdrop, contrastTint, seedOf } from "./_icon.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(here, "..");

// ---------------------------------------------------------------- args

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
const project = typeof args.project === "string" ? args.project : null;
if (!project) {
  console.error("usage: item-icon --project <p> (--all | --item <id> … | --model <model id>) [--from-image <png>] [--size 40] [--outline] [--sheet out.png] [--dry]");
  process.exit(1);
}
const assets = path.join(PLAYGROUND, "projects", project, "assets");
const itemsDir = path.join(assets, "items");
const SIZE = Number(args.size ?? 40);
const OUTLINE = args.outline === true;
const DRY = args.dry === true;
const BACKDROP = args["no-backdrop"] !== true;
// RARITY_TINT in packages/core/src/character/items.ts — the cell's own accent,
// so an uncommon item's backdrop agrees with its border. Common is grey there,
// which says nothing, so common items take a tint that contrasts with the object.
const RARITY_TINT = { uncommon: "#5fd07a", rare: "#5b8cff", epic: "#b07cff", legendary: "#ffb454" };

const presetsFile = path.join(PLAYGROUND, "projects", project, "authoring", "item-icons.json");
const presets = fs.existsSync(presetsFile) ? JSON.parse(fs.readFileSync(presetsFile, "utf8")) : { models: {}, items: {} };

const readItem = (id) => JSON.parse(fs.readFileSync(path.join(itemsDir, `${id}.json`), "utf8"));
let ids = [];
if (args.all) {
  ids = fs
    .readdirSync(itemsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((id) => readItem(id).appearance?.model);
} else if (typeof args.model === "string") {
  // every item drawn from one model: what weapon-page re-renders after a bake
  ids = fs
    .readdirSync(itemsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((id) => readItem(id).appearance?.model === args.model);
  if (!ids.length) {
    console.log(`  no items use ${args.model} yet — write them, then: item-icon --project ${project} --model ${args.model}`);
    process.exit(0);
  }
} else ids = [].concat(args.item ?? []).filter((x) => typeof x === "string");
if (!ids.length) {
  console.error("! no items: pass --all or --item <id> …");
  process.exit(1);
}
if (args["from-image"] && ids.length !== 1) {
  console.error("! --from-image takes exactly one --item");
  process.exit(1);
}

// ---------------------------------------------------------------- glb

/** Positions, uv0, part index (uv1.x) and triangles of every mesh primitive. No node transforms: the ubermesh bakes them. */
function readGlb(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
  const COMP = { 5126: [Float32Array, 4], 5125: [Uint32Array, 4], 5123: [Uint16Array, 2], 5121: [Uint8Array, 1] };
  const SIZE_OF = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const accessor = (i) => {
    const a = json.accessors[i];
    const view = json.bufferViews[a.bufferView];
    const [T, bytes] = COMP[a.componentType];
    const n = SIZE_OF[a.type];
    const stride = view.byteStride ?? n * bytes;
    const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Float64Array(a.count * n);
    for (let k = 0; k < a.count; k++)
      for (let c = 0; c < n; c++) {
        const at = bin.byteOffset + base + k * stride + c * bytes;
        out[k * n + c] = new T(bin.buffer.slice(at, at + bytes))[0];
      }
    return out;
  };
  const extras = json.nodes.find((n) => n.extras?.parts)?.extras ?? {};
  const tris = [];
  for (const mesh of json.meshes)
    for (const prim of mesh.primitives) {
      const P = accessor(prim.attributes.POSITION);
      const UV = prim.attributes.TEXCOORD_0 !== undefined ? accessor(prim.attributes.TEXCOORD_0) : null;
      const PART = prim.attributes.TEXCOORD_1 !== undefined ? accessor(prim.attributes.TEXCOORD_1) : null;
      const count = P.length / 3;
      const idx = prim.indices !== undefined ? accessor(prim.indices) : Float64Array.from({ length: count }, (_, i) => i);
      for (let t = 0; t < idx.length; t += 3) {
        const v = [idx[t], idx[t + 1], idx[t + 2]];
        tris.push({
          p: v.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]),
          uv: UV ? v.map((i) => [UV[i * 2], UV[i * 2 + 1]]) : null,
          part: PART ? Math.round(PART[v[0] * 2]) : 0,
        });
      }
    }
  return { tris, parts: extras.parts ?? null };
}

// ---------------------------------------------------------------- vector bits

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// ---------------------------------------------------------------- render

/**
 * Orthographic, z-buffered, textured, supersampled. Returns an RGBA image
 * cropped to the object with a 1 px margin, longest side SIZE.
 */
function renderItem(model, look, frame) {
  const { tris, parts } = readGlb(model);
  let shown = tris;
  if (look.parts?.length && parts) {
    const want = new Set(look.parts.map((n) => parts[n]).filter((i) => i !== undefined));
    const missing = look.parts.filter((n) => parts[n] === undefined);
    if (missing.length) console.warn(`  ! parts not in the model: ${missing.join(", ")}`);
    shown = tris.filter((t) => want.has(t.part));
  }
  if (!shown.length) throw new Error("no triangles left after the part filter");
  const tex = look.texture ? decodePng(fs.readFileSync(path.join(assets, "textures", look.texture))) : null;

  // camera: looks FROM `from`, i.e. along -from
  const from = norm(frame.from ?? [1, 0, 0]);
  const f = scale(from, -1);
  let up0 = frame.up ?? [0, 1, 0];
  up0 = norm(sub(up0, scale(from, dot(up0, from))));
  const right0 = norm(cross(f, up0));
  const a = ((frame.roll ?? 0) * Math.PI) / 180;
  const right = add(scale(right0, Math.cos(a)), scale(up0, Math.sin(a)));
  const up = add(scale(up0, Math.cos(a)), scale(right0, -Math.sin(a)));
  // light from the upper left, a little in front
  const L = norm(add(add(scale(up, 0.7), scale(right, -0.45)), scale(from, 0.8)));

  // fit: longest side of the projected object = SIZE-2 icon px (1 px margin)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of shown)
    for (const p of t.p) {
      const x = dot(p, right), y = dot(p, up);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  const k = ((SIZE - 2) * SS) / Math.max(x1 - x0, y1 - y0);
  const W = Math.ceil((x1 - x0) * k) + 2 * SS;
  const H = Math.ceil((y1 - y0) * k) + 2 * SS;
  const rgba = new Float32Array(W * H * 4);
  const zbuf = new Float32Array(W * H).fill(Infinity);

  for (const t of shown) {
    const s = t.p.map((p) => [(dot(p, right) - x0) * k + SS, (y1 - dot(p, up)) * k + SS, dot(p, f)]);
    const area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    let n = norm(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0])));
    if (dot(n, from) < 0) n = scale(n, -1); // double-sided: light the face we see
    const lit = Math.min(1.15, 0.5 + 0.7 * Math.max(0, dot(n, L)));
    const bx0 = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0])));
    const bx1 = Math.min(W - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
    const by0 = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1])));
    const by1 = Math.min(H - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((s[1][0] - px) * (s[2][1] - py) - (s[2][0] - px) * (s[1][1] - py)) / area;
        const w1 = ((s[2][0] - px) * (s[0][1] - py) - (s[0][0] - px) * (s[2][1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * s[0][2] + w1 * s[1][2] + w2 * s[2][2];
        const at = y * W + x;
        if (z >= zbuf[at]) continue;
        let c = [180, 180, 180, 255];
        if (tex && t.uv) {
          const u = w0 * t.uv[0][0] + w1 * t.uv[1][0] + w2 * t.uv[2][0];
          const v = w0 * t.uv[0][1] + w1 * t.uv[1][1] + w2 * t.uv[2][1];
          // glTF counts V from the top, and so do PNG rows: no flip
          const tx = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
          const ty = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
          const o = (ty * tex.width + tx) * 4;
          if (tex.data[o + 3] < 128) continue; // cut-out ornament
          c = [tex.data[o], tex.data[o + 1], tex.data[o + 2], 255];
        }
        zbuf[at] = z;
        for (let q = 0; q < 3; q++) rgba[at * 4 + q] = Math.min(255, c[q] * lit);
        rgba[at * 4 + 3] = 255;
      }
  }
  return downsample({ width: W, height: H, rgba });
}

// ---------------------------------------------------------------- main

const made = [];
for (const id of ids) {
  const item = readItem(id);
  let icon;
  if (args["from-image"]) {
    const src = decodePng(fs.readFileSync(path.resolve(String(args["from-image"]))));
    const ground = groundMask(src);
    icon = iconFromPixels(src, (i) => !ground[i], SIZE);
  } else {
    const look = item.appearance;
    if (!look?.model) {
      console.warn(`- ${id}: no appearance.model — generate a picture and pass --from-image (docs/item-icons.md)`);
      continue;
    }
    const frame = { ...(presets.models?.[look.model] ?? {}), ...(presets.items?.[id] ?? {}) };
    icon = renderItem(path.join(assets, "models", look.model), look, frame);
  }
  if (BACKDROP) {
    const seed = seedOf(id);
    const tint = typeof args.tint === "string" ? args.tint : item.tint ?? RARITY_TINT[item.rarity] ?? contrastTint(icon, seed);
    icon = backdrop(icon, { seed, tint });
  } else if (OUTLINE) icon = outline(icon);
  const rel = `icons/${id}.png`;
  const out = path.join(assets, "textures", rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePng(icon.width, icon.height, icon.data));
  if (!DRY && item.icon !== rel) {
    item.icon = rel;
    fs.writeFileSync(path.join(itemsDir, `${id}.json`), JSON.stringify(item, null, 2) + "\n");
  }
  made.push({ id, icon });
  console.log(`  ${id.padEnd(22)} ${String(icon.width).padStart(2)}x${String(icon.height).padEnd(2)} -> textures/${rel}${DRY ? " (dry: item not changed)" : ""}`);
}

// a zoomed contact sheet on a slot-dark ground, for looking at them
if (typeof args.sheet === "string" && made.length) {
  writeContactSheet(path.resolve(args.sheet), made.map((m) => m.icon));
  console.log(`  sheet -> ${args.sheet}`);
}
