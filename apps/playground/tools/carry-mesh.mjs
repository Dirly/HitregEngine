#!/usr/bin/env node
/**
 * An ubermesh of parts that keep the modeller's OWN UVs onto one small tiling
 * texture — the player's hair, beards and moustache on their hair swatch.
 *
 *   node tools/carry-mesh.mjs --in MMO/3d/HumanRig/Hair.obj \
 *     --parts HairBase1,HairBase3,FemaleBase1,HairStyle1,HairStyle2,FemaleStyle1,Bangs,PonyTail1,Braids,BeardBase1,BeardBase2,Mustache,Chops \
 *     --hang HairBase1,HairBase3,FemaleBase1,FemaleStyle1,Braids \
 *     --texture MMO/3d/HumanRig/Head/pasted.png --size 40 \
 *     --out projects/voxel-demo/assets/models/mmo/human-hair.glb
 *
 * Why its own mesh, not parts of the head: carried inside the head's 72px sheet
 * the swatch shrank to 17 texels (~50/m, half the body's density), a head page
 * tile is chosen per FACE so hair could not change without the face, and hair
 * colour needs a material of its own to tint. Here the swatch is resampled
 * (nearest, alpha kept — the tips are cut out) to `--size`, picked so the hair
 * lands at the body's ~109 texels/m; the tool prints what each part gets.
 *
 * The output is the same ubermesh format unwrap-weapon writes: ONE mesh, the
 * part index in uv1, the part table in the node's extras (`parts`), so a
 * character shows a style by its part mask and every hairstyle is one draw.
 * Positions are the file's, times `--source-scale` (100 for a Blockbench OBJ,
 * like unwrap-weapon's recipes), so it sockets with the head's numbers.
 *
 * `--hang Braids,PonyTail1 --hang-top 0.81 --hang-bottom 0.73` bakes a HANG
 * weight into uv1.y for those parts: 0 at or above `--hang-top` (file units,
 * +Y up — the scalp, which rides the head), easing to 1 at `--hang-bottom` (the
 * ends resting on the chest and back, which follow the mount's `hang` bone).
 * Parts not named keep 0 and ride the head whole (beards, bangs). Only hang
 * what RESTS on the body: the ponytail sticks out from the back of the head,
 * and hung it swung against the head on every step (Derek: "too bouncy").
 */
import "./node-dom-shim.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { decodePng, encodePng } from "./_png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(here, "..");
const STUDIO = path.resolve(PLAYGROUND, "../../..");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args[a.slice(2)] = true;
  else args[a.slice(2)] = process.argv[++i];
}
if (!args.in || !args.parts || !args.texture || !args.out) {
  console.error("usage: carry-mesh --in <file.obj> --parts a,b,c --texture <swatch.png> --out <model.glb> [--size 40] [--repeat Name=Name1,Name2] [--source-scale 100] [--metres-per-unit 0.019]");
  process.exit(1);
}
const fromStudio = (p) => (path.isAbsolute(p) ? p : fs.existsSync(path.resolve(p)) ? path.resolve(p) : path.join(STUDIO, p));
const SCALE = Number(args["source-scale"] ?? 100);
const SIZE = Number(args.size ?? 40);
const M_PER_UNIT = Number(args["metres-per-unit"] ?? 0.019);
const wanted = String(args.parts).split(",");
const hanging = new Set(args.hang ? String(args.hang).split(",") : []);
const HANG_TOP = Number(args["hang-top"] ?? 0.81);
const HANG_BOTTOM = Number(args["hang-bottom"] ?? 0.73);
/** 0 at the top, 1 at the bottom, smoothstepped so the bend has no crease. */
const hangWeight = (y) => {
  const t = Math.min(1, Math.max(0, (HANG_TOP - y) / (HANG_TOP - HANG_BOTTOM)));
  return t * t * (3 - 2 * t);
};
for (const h of hanging) {
  if (!wanted.includes(h)) {
    console.error(`! --hang names "${h}", which is not in --parts`);
    process.exit(1);
  }
}

// --- parts, with Blockbench's repeated names numbered in order of appearance
const group = new OBJLoader().parse(fs.readFileSync(fromStudio(String(args.in)), "utf8"));
const found = [];
group.traverse((o) => {
  if (o.isMesh) found.push(o);
});
if (args.repeat) {
  const [name, list] = String(args.repeat).split("=");
  const names = list.split(",");
  found.filter((o) => o.name === name).forEach((o, i) => {
    if (names[i]) o.name = names[i];
  });
}
const parts = wanted.map((name) => {
  const o = found.find((f) => f.name === name);
  if (!o) {
    console.error(`! the file has no part "${name}" (has: ${[...new Set(found.map((f) => f.name))].join(", ")})`);
    process.exit(1);
  }
  const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
  if (!geo.attributes.uv) {
    console.error(`! ${name} has no UVs in the file`);
    process.exit(1);
  }
  return { name, geo };
});

// --- the swatch at the density the body is drawn at
const src = decodePng(fs.readFileSync(fromStudio(String(args.texture))));
const px = new Uint8Array(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++)
  for (let x = 0; x < SIZE; x++) {
    const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) / SIZE) * src.width));
    const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) / SIZE) * src.height));
    px.set(src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * SIZE + x) * 4);
  }
const swatch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "carry-mesh-")), "swatch.png");
fs.writeFileSync(swatch, encodePng(SIZE, SIZE, px));

// --- one welded mesh, part index in uv1
let n = 0;
for (const p of parts) n += p.geo.attributes.position.count;
const pos = new Float32Array(n * 3);
const uv = new Float32Array(n * 2);
const uv1 = new Float32Array(n * 2);
let at = 0;
console.log(`carry-mesh: ${parts.length} parts on a ${SIZE}px swatch`);
for (const [index, p] of parts.entries()) {
  const P = p.geo.attributes.position;
  const U = p.geo.attributes.uv;
  let world = 0, uvArea = 0;
  for (let i = 0; i < P.count; i++) {
    pos.set([P.getX(i) * SCALE, P.getY(i) * SCALE, P.getZ(i) * SCALE], (at + i) * 3);
    // glTF V runs from the top, OBJ's from the bottom
    uv.set([U.getX(i), 1 - U.getY(i)], (at + i) * 2);
    uv1[(at + i) * 2] = index;
    if (hanging.has(p.name)) uv1[(at + i) * 2 + 1] = hangWeight(P.getY(i));
  }
  for (let t = 0; t < P.count; t += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(P, t), b = new THREE.Vector3().fromBufferAttribute(P, t + 1), c = new THREE.Vector3().fromBufferAttribute(P, t + 2);
    world += b.sub(a).cross(c.sub(a)).length() / 2;
    uvArea += Math.abs((U.getX(t + 1) - U.getX(t)) * (U.getY(t + 2) - U.getY(t)) - (U.getX(t + 2) - U.getX(t)) * (U.getY(t + 1) - U.getY(t))) / 2;
  }
  const metres = SCALE * M_PER_UNIT;
  const perMetre = (SIZE * Math.sqrt(uvArea / world)) / metres;
  let hangMax = 0;
  for (let i = 0; i < P.count; i++) hangMax = Math.max(hangMax, uv1[(at + i) * 2 + 1]);
  const hangNote = hanging.has(p.name) ? `  hangs (weight up to ${hangMax.toFixed(2)})` : "";
  console.log(`  ${p.name.padEnd(12)} ${String(P.count / 3).padStart(4)} tris  ${perMetre.toFixed(0)} texels/m${hangNote}`);
  at += P.count;
}
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
geo.computeVertexNormals();

const map = new THREE.TextureLoader().load(swatch);
map.flipY = false;
map.colorSpace = THREE.SRGBColorSpace;
map.magFilter = THREE.NearestFilter;
map.minFilter = THREE.NearestMipmapLinearFilter;
const mesh = new THREE.Mesh(
  geo,
  new THREE.MeshStandardMaterial({
    name: `${path.basename(String(args.out), ".glb")}`,
    color: 0xffffff,
    map,
    roughness: 1, // matte, like every character piece
    metalness: 0,
    // hair cards are single planes with cut-out tips
    side: THREE.DoubleSide,
    alphaTest: 0.5,
  }),
);
mesh.name = path.basename(String(args.out), ".glb");
mesh.userData.parts = Object.fromEntries(parts.map((p, i) => [p.name, i]));
const wrap = new THREE.Group();
wrap.name = mesh.name;
wrap.add(mesh);
wrap.updateMatrixWorld(true);
const glb = await new GLTFExporter().parseAsync(wrap, { binary: true, onlyVisible: false });
const out = path.resolve(String(args.out));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(glb));
console.log(`  wrote ${path.relative(PLAYGROUND, out)} — ${(glb.byteLength / 1024).toFixed(0)} KB, 1 mesh, ${n / 3} triangles, part index in uv1`);
