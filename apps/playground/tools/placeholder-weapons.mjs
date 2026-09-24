/**
 * placeholder-weapons — chunky stand-in models for every held-weapon kind, so
 * sockets can be placed and stances played before the real art exists.
 *
 *   node tools/placeholder-weapons.mjs --project voxel-demo
 *   node tools/placeholder-weapons.mjs --project voxel-demo --only bow,staff
 *
 * Writes assets/models/weapons/placeholders/<kind>.glb. Each one is shaped for
 * the SAME path real gear takes — a part table (glTF extras `parts` + a `uv1`
 * part id per vertex), one material, one palette texture — so it draws through
 * the batched `mesh.moving` system, trims by part, and shows through
 * `equipment-look` like any ubermesh. Part names are unique per model
 * ("GreatswordBlade", not "Blade"): a look naming them shows on the slot that
 * draws THIS model and nowhere else, which is what lets one slot per weapon
 * kind watch the same hand.
 *
 * Every model shares one frame, which fit-grip reads with `--model-frame`:
 *   origin  the centre of the hand's grip
 *   +Y      up the weapon from the grip (blade, head, upper limb, pistol grip top)
 *   +Z      the thin direction (a blade's flat, a bow's side)
 *   metres  — the socket's scale stays 1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "./_png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]] : [])),
);
if (!args.project) {
  console.log("usage: node tools/placeholder-weapons.mjs --project <name> [--only kind,kind]");
  process.exit(1);
}

// ---- palette: one 4x4 page, a colour per cell
const PALETTE = {
  steel: [170, 176, 186],
  darkSteel: [96, 102, 112],
  wood: [122, 84, 52],
  darkWood: [84, 56, 34],
  leather: [70, 44, 30],
  brass: [196, 156, 70],
  string: [226, 220, 200],
  gem: [90, 170, 220],
};
const names = Object.keys(PALETTE);
const cellUv = (colour) => {
  const i = names.indexOf(colour);
  return [((i % 4) + 0.5) / 4, (Math.floor(i / 4) + 0.5) / 4];
};
function palettePng() {
  const size = 16; // 4 px per cell: nearest filtering keeps it flat
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = PALETTE[names[Math.floor(y / 4) * 4 + Math.floor(x / 4)]] ?? [255, 0, 255];
      const o = (y * size + x) * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  return encodePng(size, size, rgba);
}

// ---- geometry: boxes, optionally rotated about Z (a bow's limbs, an axe's beard)
function box(out, part, colour, [cx, cy, cz], [sx, sy, sz], rotZ = 0) {
  const [u, v] = cellUv(colour);
  const c = Math.cos(rotZ);
  const s = Math.sin(rotZ);
  const tf = ([x, y, z]) => [cx + x * c - y * s, cy + x * s + y * c, cz + z];
  const tn = ([x, y, z]) => [x * c - y * s, x * s + y * c, z];
  const h = [sx / 2, sy / 2, sz / 2];
  const faces = [
    [[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]],
    [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  ];
  for (const [n, corners] of faces) {
    const base = out.pos.length / 3;
    for (const k of corners) {
      out.pos.push(...tf([k[0] * h[0], k[1] * h[1], k[2] * h[2]]));
      out.nrm.push(...tn(n));
      out.uv0.push(u, v);
      out.uv1.push(part, 0);
    }
    out.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Each kind: parts in order (their index is the part id) and the boxes that make them. */
const KINDS = {
  greatsword: (b) => {
    b("GreatswordHandle", "leather", [0, 0.02, 0], [0.036, 0.3, 0.036]);
    b("GreatswordPommel", "brass", [0, -0.16, 0], [0.06, 0.05, 0.05]);
    b("GreatswordGuard", "darkSteel", [0, 0.2, 0], [0.32, 0.045, 0.06]);
    b("GreatswordBlade", "steel", [0, 0.78, 0], [0.07, 1.1, 0.012]);
    b("GreatswordBlade", "steel", [0, 1.36, 0], [0.035, 0.06, 0.012]);
  },
  staff: (b) => {
    b("StaffShaft", "darkWood", [0, 0.1, 0], [0.035, 1.75, 0.035]);
    b("StaffWrap", "leather", [0, 0, 0], [0.045, 0.16, 0.045]);
    b("StaffHead", "brass", [0, 1.0, 0], [0.09, 0.08, 0.09]);
    b("StaffHead", "gem", [0, 1.08, 0], [0.07, 0.09, 0.07]);
  },
  bow: (b) => {
    b("BowGrip", "leather", [0, 0, 0], [0.04, 0.14, 0.035]);
    b("BowLimbs", "wood", [-0.02, 0.3, 0], [0.03, 0.48, 0.022], 0.12);
    b("BowLimbs", "wood", [-0.02, -0.3, 0], [0.03, 0.48, 0.022], -0.12);
    b("BowLimbs", "darkWood", [-0.06, 0.56, 0], [0.025, 0.1, 0.02], 0.35);
    b("BowLimbs", "darkWood", [-0.06, -0.56, 0], [0.025, 0.1, 0.02], -0.35);
    b("BowString", "string", [-0.1, 0, 0], [0.006, 1.2, 0.006]);
  },
  crossbow: (b) => {
    // a pistol grip: +Y up the grip, the stock runs FORWARD along +X
    b("CrossbowGrip", "darkWood", [0, 0, 0], [0.035, 0.12, 0.03]);
    b("CrossbowStock", "wood", [0.2, 0.09, 0], [0.62, 0.06, 0.05]);
    b("CrossbowProd", "darkSteel", [0.48, 0.1, 0], [0.04, 0.03, 0.62]);
    b("CrossbowString", "string", [0.38, 0.11, 0], [0.005, 0.005, 0.56]);
    b("CrossbowBolt", "steel", [0.36, 0.13, 0], [0.34, 0.012, 0.012]);
  },
  axe: (b) => {
    b("AxeHaft", "wood", [0, 0.16, 0], [0.034, 0.62, 0.034]);
    b("AxeHead", "darkSteel", [0.07, 0.42, 0], [0.12, 0.09, 0.025]);
    b("AxeHead", "steel", [0.14, 0.42, 0], [0.04, 0.2, 0.018]);
  },
  mace: (b) => {
    b("MaceHaft", "wood", [0, 0.14, 0], [0.034, 0.56, 0.034]);
    b("MaceHead", "darkSteel", [0, 0.46, 0], [0.11, 0.13, 0.11]);
    b("MaceHead", "steel", [0, 0.46, 0], [0.15, 0.05, 0.05]);
    b("MaceHead", "steel", [0, 0.46, 0], [0.05, 0.05, 0.15]);
    b("MaceHead", "steel", [0, 0.54, 0], [0.04, 0.05, 0.04]);
  },
  greathammer: (b) => {
    // two hands on a long haft, like the greataxe: grip a third of the way up
    b("GreathammerHaft", "darkWood", [0, 0.28, 0], [0.045, 1.25, 0.045]);
    b("GreathammerHead", "darkSteel", [0, 0.86, 0], [0.34, 0.18, 0.18]);
    b("GreathammerHead", "steel", [0.19, 0.86, 0], [0.05, 0.2, 0.2]);
    b("GreathammerHead", "steel", [-0.19, 0.86, 0], [0.05, 0.2, 0.2]);
    b("GreathammerCap", "brass", [0, -0.36, 0], [0.06, 0.06, 0.06]);
  },
  wand: (b) => {
    b("WandShaft", "darkWood", [0, 0.1, 0], [0.018, 0.34, 0.018]);
    b("WandGrip", "leather", [0, 0, 0], [0.026, 0.1, 0.026]);
    b("WandTip", "gem", [0, 0.29, 0], [0.035, 0.05, 0.035]);
  },
  dagger: (b) => {
    b("DaggerHandle", "leather", [0, 0, 0], [0.028, 0.11, 0.028]);
    b("DaggerGuard", "brass", [0, 0.07, 0], [0.11, 0.025, 0.035]);
    b("DaggerBlade", "steel", [0, 0.21, 0], [0.04, 0.26, 0.01]);
    b("DaggerBlade", "steel", [0, 0.355, 0], [0.018, 0.03, 0.01]);
  },
};

// ---- a minimal GLB writer: one node, one mesh, one material, one texture
function writeGlb(file, kind, geo, parts, png) {
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
  const chunks = [];
  const views = [];
  let offset = 0;
  const addView = (buf, target) => {
    const pad = (4 - (buf.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf, Buffer.alloc(pad));
    offset += buf.length + pad;
    return views.length - 1;
  };
  const n = geo.pos.length / 3;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], geo.pos[i * 3 + k]);
      max[k] = Math.max(max[k], geo.pos[i * 3 + k]);
    }
  const accessors = [
    { bufferView: addView(f32(geo.pos), 34962), componentType: 5126, count: n, type: "VEC3", min, max },
    { bufferView: addView(f32(geo.nrm), 34962), componentType: 5126, count: n, type: "VEC3" },
    { bufferView: addView(f32(geo.uv0), 34962), componentType: 5126, count: n, type: "VEC2" },
    { bufferView: addView(f32(geo.uv1), 34962), componentType: 5126, count: n, type: "VEC2" },
    { bufferView: addView(Buffer.from(new Uint16Array(geo.idx).buffer), 34963), componentType: 5123, count: geo.idx.length, type: "SCALAR" },
  ];
  const imageView = addView(png);
  const json = {
    asset: { version: "2.0", generator: "hitreg placeholder-weapons" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: `placeholder-${kind}`, mesh: 0, extras: { parts } }],
    meshes: [
      {
        name: kind,
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, TEXCOORD_1: 3 }, indices: 4, material: 0 }],
      },
    ],
    materials: [
      {
        name: `placeholder-${kind}`,
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0.1, roughnessFactor: 0.7 },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: imageView, mimeType: "image/png" }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  const bin = Buffer.concat(chunks);
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const ch = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  fs.writeFileSync(file, Buffer.concat([header, ch(jsonBuf.length, 0x4e4f534a), jsonBuf, ch(bin.length, 0x004e4942), bin]));
}

const outDir = path.resolve(here, "..", "projects", String(args.project), "assets", "models", "weapons", "placeholders");
fs.mkdirSync(outDir, { recursive: true });
const png = palettePng();
const only = args.only ? String(args.only).split(",") : Object.keys(KINDS);
for (const kind of only) {
  const build = KINDS[kind];
  if (!build) {
    console.error(`placeholder-weapons: no kind "${kind}" (have: ${Object.keys(KINDS).join(", ")})`);
    process.exit(1);
  }
  const geo = { pos: [], nrm: [], uv0: [], uv1: [], idx: [] };
  const parts = {};
  build((name, colour, at, size, rotZ) => {
    if (!(name in parts)) parts[name] = Object.keys(parts).length;
    box(geo, parts[name], colour, at, size, rotZ);
  });
  const file = path.join(outDir, `${kind}.glb`);
  writeGlb(file, kind, geo, parts, png);
  console.log(`${path.relative(process.cwd(), file)}  parts: ${Object.keys(parts).join(", ")}`);
}
