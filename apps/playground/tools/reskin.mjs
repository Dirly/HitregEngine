#!/usr/bin/env node
/**
 * reskin — put a NEW body on an already-rigged character GLB, keeping its
 * skeleton, every clip and every extra, and write it as a skinned UBERMESH.
 *
 *   node tools/reskin.mjs --rig projects/voxel-demo/assets/models/mmo/human.glb \
 *     --in MMO/3d/HumanRig/HumanBase.obj \
 *     --parts HumanMale_ChestFront,HumanMale_ChestBack,...,TassetFront,TassetBack \
 *     --mirror HumanMale_ArmOutside,HumanMale_ArmInside,HumanMale_HandPalm,HumanMale_HandFront,HumanMale_Foot \
 *     --bind TassetFront=CC_Base_Pelvis --bind TassetBack=CC_Base_Pelvis --bind ChestHalo=CC_Base_Spine02 \
 *     --texture MMO/3d/HumanRig/atlas.png \
 *     --out projects/voxel-demo/assets/models/mmo/human-body.glb
 *
 * WHY NOT RE-RIG. The character's rig is an auto-rigger's (AccuRig), and a
 * fresh auto-rig of a remodelled body means a new skeleton: its bone rolls and
 * rest pose differ, so the 87 retargeted clips, the fitted weapon grips and the
 * head socket would all have to be redone, and AccuRig's spine placement was
 * the part that went wrong last time. The modeller's new body is the old one
 * cut into pieces (nearly every vertex is where it was), so its weights can be
 * COPIED instead: each new vertex takes the weights of the closest point on the
 * old skinned surface, blended across that triangle's corners.
 *
 * `--bind Part=Bone` overrides that for rigid or hanging pieces: a back plate
 * goes wholly to the spine; a tasset goes wholly to the pelvis, so the thigh
 * no longer drags half of it forward (the warp: an auto-rigger binds a skirt to
 * the thighs) and cloth sway gives it its motion instead.
 *
 * The body is an ubermesh like held gear: the part index in TEXCOORD_1 and the
 * part table in the mesh node's extras (`parts`), so a character shows its
 * chest, trousers, robe and tassets by part mask on ONE skinned draw.
 *
 * The rig file is edited surgically — the mesh primitive's accessors are
 * replaced and the new data appended to its binary chunk — so nothing the
 * retarget wrote (clips, clipSpeeds, footfalls, bone extras) goes through an
 * exporter round trip.
 */
import "./node-dom-shim.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { decodePng, encodePng } from "./_png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PLAYGROUND = path.resolve(here, "..");
const STUDIO = path.resolve(PLAYGROUND, "../../..");

const args = { bind: [], theme: [], repeat: [], grow: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  const value = next === undefined || next.startsWith("--") ? true : process.argv[++i];
  if (key === "bind") args.bind.push(value);
  else if (key === "theme") args.theme.push(value);
  else if (key === "repeat") args.repeat.push(value);
  else if (key === "grow") args.grow.push(value);
  else args[key] = value;
}
if (!args.rig || !args.in || !args.parts || !args.out) {
  console.error(
    "usage: reskin --rig <rigged.glb> --in <body.obj> --parts a,b,c --out <out.glb> [--mirror a,b] " +
      "[--bind Part=Bone ...] [--texture <atlas.png> | --theme <sheetId>=<atlas.png> ...] [--rules <rules.json>] " +
      "[--source-scale 1] [--frame rotY:-90]",
  );
  process.exit(1);
}
const fromStudio = (p) => (path.isAbsolute(p) ? p : fs.existsSync(path.resolve(p)) ? path.resolve(p) : path.join(STUDIO, p));
const list = (v) => (v && v !== true ? String(v).split(",").filter(Boolean) : []);

// ------------------------------------------------------------------ the rig
const glb = fs.readFileSync(fromStudio(String(args.rig)));
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const bin = glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLen));

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
function readAccessor(i) {
  const acc = json.accessors[i];
  const view = json.bufferViews[acc.bufferView];
  const n = COMPONENTS[acc.type];
  const T = ARRAYS[acc.componentType];
  const stride = view.byteStride ?? n * T.BYTES_PER_ELEMENT;
  const out = new Float64Array(acc.count * n);
  const dv = new DataView(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0));
  const get = {
    5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true),
    5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true),
  }[acc.componentType];
  for (let e = 0; e < acc.count; e++)
    for (let c = 0; c < n; c++) out[e * n + c] = get(e * stride + c * T.BYTES_PER_ELEMENT);
  if (acc.normalized && acc.componentType === 5121) for (let k = 0; k < out.length; k++) out[k] /= 255;
  if (acc.normalized && acc.componentType === 5123) for (let k = 0; k < out.length; k++) out[k] /= 65535;
  return out;
}

const meshNodeIndex = json.nodes.findIndex((n) => n.mesh !== undefined && n.skin !== undefined);
if (meshNodeIndex < 0) throw new Error("the rig has no skinned mesh");
const meshNode = json.nodes[meshNodeIndex];
const skin = json.skins[meshNode.skin];
const prim = json.meshes[meshNode.mesh].primitives[0];

// node world matrices at rest
const parent = new Map();
json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
const localOf = (n) => {
  const m = new THREE.Matrix4();
  if (n.matrix) return m.fromArray(n.matrix);
  return m.compose(
    new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
    new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
    new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
  );
};
const worldCache = new Map();
function worldOf(i) {
  if (worldCache.has(i)) return worldCache.get(i);
  const m = localOf(json.nodes[i]);
  if (parent.has(i)) m.premultiply(worldOf(parent.get(i)));
  worldCache.set(i, m);
  return m;
}
// geometry space -> world at rest: joint world x inverse bind, the same for
// every joint of a mesh bound at its rest pose (checked, not assumed)
const ibm = readAccessor(skin.inverseBindMatrices);
const jointToWorld = skin.joints.map((j, k) => worldOf(j).clone().multiply(new THREE.Matrix4().fromArray(ibm.slice(k * 16, k * 16 + 16))));
const toWorld = jointToWorld[0];
const drift = Math.max(...jointToWorld.map((m) => Math.max(...m.elements.map((e, k) => Math.abs(e - toWorld.elements[k])))));
if (drift > 1e-3) console.warn(`! the rig's joints disagree on the bind frame by ${drift.toFixed(4)} — weights still copy, positions may be off`);
const fromWorld = toWorld.clone().invert();
const boneIndex = new Map(skin.joints.map((j, k) => [json.nodes[j].name, k]));

const oldPos = readAccessor(prim.attributes.POSITION);
const oldJoints = readAccessor(prim.attributes.JOINTS_0);
const oldWeights = readAccessor(prim.attributes.WEIGHTS_0);
const oldIndex = prim.indices !== undefined ? readAccessor(prim.indices) : Float64Array.from({ length: oldPos.length / 3 }, (_, i) => i);
const oldWorld = [];
for (let i = 0; i < oldPos.length / 3; i++)
  oldWorld.push(new THREE.Vector3(oldPos[i * 3], oldPos[i * 3 + 1], oldPos[i * 3 + 2]).applyMatrix4(toWorld));

// ------------------------------------------------------------------ the new body
const SCALE = Number(args["source-scale"] ?? 1);
const group = new OBJLoader().parse(fs.readFileSync(fromStudio(String(args.in)), "utf8"));
const wanted = list(args.parts);
const mirror = new Set(list(args.mirror));
const found = [];
group.traverse((o) => o.isMesh && found.push(o));
// `--repeat Name=A,B`: Blockbench lets several objects share a name (the
// female body's robe and the male's are both `RobesFront`); name them in
// file order.
for (const r of args.repeat) {
  const [name, list] = String(r).split("=");
  const names = list.split(",");
  const hits = found.filter((o) => o.name === name);
  if (hits.length !== names.length) console.warn(`! --repeat ${name}: the file has ${hits.length}, named ${names.length}`);
  hits.forEach((o, i) => {
    if (names[i]) o.name = names[i];
  });
}
// `--grow factor:a,b`: store these parts scaled about the OBJ origin (the
// floor between the feet). The female body is the male's at 0.96, so her
// pieces are stored at MALE size — they then fit the one skeleton, take the
// male surface's weights, and share every outfit sheet — and a female
// character draws the whole model at 0.96, which brings her head and
// shoulders down with the bones.
const grow = new Map();
for (const g of args.grow) {
  const [factor, list] = String(g).split(":");
  for (const n of list.split(",")) grow.set(n, Number(factor));
}
const parts = wanted.map((name) => {
  // Blockbench can export one part as several objects under one name
  const hits = found.filter((o) => o.name === name);
  const k = grow.get(name) ?? 1;
  if (!hits.length) {
    console.error(`! the file has no part "${name}"`);
    process.exit(1);
  }
  const pos = [];
  const uv = [];
  for (const o of hits) {
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const P = g.attributes.position;
    const U = g.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      pos.push(new THREE.Vector3(P.getX(i), P.getY(i), P.getZ(i)).multiplyScalar(SCALE * k));
      uv.push([U ? U.getX(i) : 0, U ? 1 - U.getY(i) : 0]); // glTF V runs from the top
    }
  }
  if (mirror.has(name)) {
    const n = pos.length;
    for (let t = 0; t < n; t += 3)
      for (const s of [0, 2, 1]) {
        const v = pos[t + s].clone();
        v.z = -v.z;
        pos.push(v);
        uv.push(uv[t + s]);
      }
  }
  return { name, pos, uv };
});
for (const m of mirror) if (!wanted.includes(m)) console.warn(`! --mirror ${m} is not in --parts`);

// OBJ frame -> the rig's world. Blockbench models face +X; the rig faces +Z,
// and its world is the OBJ's times the model root's scale. Fitted, not
// guessed: the scale is the ratio of the two bodies' arm spans (heights differ
// when the old mesh carries a head the new body leaves to the head module).
const yaw = (Number(String(args.frame ?? "rotY:-90").split(":")[1]) * Math.PI) / 180;
const bboxOf = (vs) => new THREE.Box3().setFromPoints(vs);
const newBox = bboxOf(parts.flatMap((p) => p.pos));
const oldBox = bboxOf(oldWorld);
const span = (b) => Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
const s = args.scale ? Number(args.scale) : span(oldBox) / span(newBox);
const objToWorld = new THREE.Matrix4().makeRotationY(yaw).premultiply(new THREE.Matrix4().makeScale(s, s, s));
objToWorld.premultiply(new THREE.Matrix4().makeTranslation(0, oldBox.min.y - newBox.min.y * s, 0));

// ------------------------------------------------------------------ weights
const tris = [];
for (let t = 0; t < oldIndex.length; t += 3) tris.push([oldIndex[t], oldIndex[t + 1], oldIndex[t + 2]]);
const tri = new THREE.Triangle();
const closest = new THREE.Vector3();
const bary = new THREE.Vector3();
function weightsAt(p) {
  let best = Infinity;
  let bestTri = null;
  let bestBary = null;
  for (const [a, b, c] of tris) {
    tri.set(oldWorld[a], oldWorld[b], oldWorld[c]);
    tri.closestPointToPoint(p, closest);
    const d = closest.distanceToSquared(p);
    if (d < best) {
      best = d;
      bestTri = [a, b, c];
      tri.getBarycoord(closest, bary);
      bestBary = [bary.x, bary.y, bary.z];
    }
  }
  const acc = new Map();
  bestTri.forEach((v, k) => {
    for (let c = 0; c < 4; c++) {
      const w = oldWeights[v * 4 + c] * bestBary[k];
      if (w > 0) acc.set(oldJoints[v * 4 + c], (acc.get(oldJoints[v * 4 + c]) ?? 0) + w);
    }
  });
  const top = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
  const sum = top.reduce((q, [, w]) => q + w, 0) || 1;
  return { joints: top.map(([j]) => j), weights: top.map(([, w]) => w / sum), dist: Math.sqrt(best) };
}

const binds = new Map(
  args.bind.map((b) => {
    const [part, bone] = String(b).split("=");
    if (!boneIndex.has(bone)) {
      console.error(`! --bind ${b}: the rig has no bone "${bone}" (has ${[...boneIndex.keys()].slice(0, 8).join(", ")}, …)`);
      process.exit(1);
    }
    if (!wanted.includes(part)) console.warn(`! --bind ${part} is not in --parts`);
    return [part, boneIndex.get(bone)];
  }),
);

// Feet-on-the-floor alignment is only close: settle the offset on the
// surfaces themselves. Most new vertices ARE old ones, so the median gap to the
// old surface is the offset left over (a couple of passes, like ICP's
// translation step).
{
  const sample = parts.flatMap((p) => p.pos.filter((_, i) => i % 3 === 0));
  for (let pass = 0; pass < 3; pass++) {
    const gaps = [[], [], []];
    for (const v of sample) {
      const w = v.clone().applyMatrix4(objToWorld);
      let best = Infinity;
      const hit = new THREE.Vector3();
      for (let t = 0; t < oldIndex.length; t += 3) {
        tri.set(oldWorld[oldIndex[t]], oldWorld[oldIndex[t + 1]], oldWorld[oldIndex[t + 2]]);
        tri.closestPointToPoint(w, closest);
        const d = closest.distanceToSquared(w);
        if (d < best) {
          best = d;
          hit.copy(closest);
        }
      }
      const g = hit.sub(w);
      gaps[0].push(g.x);
      gaps[1].push(g.y);
      gaps[2].push(g.z);
    }
    const med = gaps.map((a) => a.sort((x, y) => x - y)[a.length >> 1]);
    objToWorld.premultiply(new THREE.Matrix4().makeTranslation(med[0], med[1], med[2]));
  }
}

const worldH = oldBox.max.y - oldBox.min.y;
console.log(`reskin: ${parts.length} parts onto ${path.basename(String(args.rig))} (${skin.joints.length} joints), OBJ x ${s.toFixed(4)}`);
for (const part of parts) {
  part.world = part.pos.map((v) => v.clone().applyMatrix4(objToWorld));
  part.joints = [];
  part.weights = [];
  let far = 0;
  let sumD = 0;
  for (const w of part.world) {
    if (binds.has(part.name)) {
      part.joints.push([binds.get(part.name), 0, 0, 0]);
      part.weights.push([1, 0, 0, 0]);
      continue;
    }
    const got = weightsAt(w);
    while (got.joints.length < 4) {
      got.joints.push(0);
      got.weights.push(0);
    }
    part.joints.push(got.joints);
    part.weights.push(got.weights);
    far = Math.max(far, got.dist);
    sumD += got.dist;
  }
  const how = binds.has(part.name)
    ? `bound to ${[...boneIndex.entries()].find(([, k]) => k === binds.get(part.name))[0]}`
    : `copied, mean ${((100 * sumD) / part.world.length / worldH).toFixed(2)}% / max ${((100 * far) / worldH).toFixed(2)}% of height from the old surface`;
  console.log(`  ${part.name.padEnd(22)} ${String(part.world.length / 3).padStart(4)} tris  ${how}`);
}

// ------------------------------------------------------------------ geometry
let n = 0;
for (const p of parts) n += p.world.length;
const POS = new Float32Array(n * 3);
const NRM = new Float32Array(n * 3);
const UV0 = new Float32Array(n * 2);
const UV1 = new Float32Array(n * 2);
const JNT = new Uint16Array(n * 4);
const WGT = new Float32Array(n * 4);
const IDX = new Uint32Array(n);
{
  // SMOOTH normals, welded across pieces: a body's skin pieces (chest, arms,
  // hands, legs, feet) share one surface, so a vertex on the seam between the
  // chest and an arm averages the faces of BOTH (Derek: the pieces shaded as
  // hard facets). `--smooth-group` regexes pick the groups (default: the male
  // and the female body); every other part (robe, tasset, belt) smooths on its
  // own so cloth never bends the body's normals. Faces more than `--smooth`
  // degrees apart (default 88) never average: a double wall or a thin edge keeps
  // its crease instead of cancelling.
  let at = 0;
  const cos = Math.cos((Number(args.smooth ?? 88) * Math.PI) / 180);
  const groupsRe = String(args["smooth-group"] ?? "^(HumanMale_|Human_);^HumanFemale_").split(";").map((r) => new RegExp(r));
  const groupOf = (name) => {
    const g = groupsRe.findIndex((r) => r.test(name));
    return g < 0 ? `part:${name}` : `group:${g}`;
  };
  const key = (g, v) => `${g}|${Math.round(v.x * 1e3)},${Math.round(v.y * 1e3)},${Math.round(v.z * 1e3)}`;
  const locals = parts.map((part) => part.world.map((w) => w.clone().applyMatrix4(fromWorld)));
  const faces = locals.map((local) => {
    const out = [];
    for (let t = 0; t < local.length; t += 3) {
      const nn = new THREE.Vector3().subVectors(local[t + 1], local[t]).cross(new THREE.Vector3().subVectors(local[t + 2], local[t]));
      const area = nn.length();
      out.push({ n: area > 1e-12 ? nn.clone().normalize() : nn, area });
    }
    return out;
  });
  const byPos = new Map();
  parts.forEach((part, pi) => {
    const g = groupOf(part.name);
    locals[pi].forEach((v, i) => {
      const k = key(g, v);
      if (!byPos.has(k)) byPos.set(k, []);
      byPos.get(k).push(faces[pi][Math.floor(i / 3)]);
    });
  });
  for (const [pi, part] of parts.entries()) {
    const local = locals[pi];
    const g = groupOf(part.name);
    local.forEach((v, i) => {
      const own = faces[pi][Math.floor(i / 3)].n;
      const acc = new THREE.Vector3();
      for (const f of byPos.get(key(g, v))) if (f.n.dot(own) >= cos) acc.addScaledVector(f.n, f.area);
      (acc.lengthSq() > 1e-12 ? acc.normalize() : own).toArray(NRM, (at + i) * 3);
      v.toArray(POS, (at + i) * 3);
      UV0[(at + i) * 2] = part.uv[i][0];
      UV0[(at + i) * 2 + 1] = part.uv[i][1];
      UV1[(at + i) * 2] = pi;
      JNT.set(part.joints[i], (at + i) * 4);
      WGT.set(part.weights[i], (at + i) * 4);
      IDX[at + i] = at + i;
    });
    at += local.length;
  }
}

// ------------------------------------------------------------------ write
const chunks = [bin];
let offset = bin.length;
function append(array, target) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    offset += pad;
  }
  const buf = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
  chunks.push(buf);
  offset += buf.length;
  return json.bufferViews.length - 1;
}
function accessor(array, type, componentType, target, extra = {}) {
  const view = append(array, target);
  json.accessors.push({ bufferView: view, componentType, count: array.length / COMPONENTS[type], type, ...extra });
  return json.accessors.length - 1;
}
const minMax = (arr) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i += 3)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], arr[i + c]);
      max[c] = Math.max(max[c], arr[i + c]);
    }
  return { min, max };
};
prim.attributes = {
  POSITION: accessor(POS, "VEC3", 5126, 34962, minMax(POS)),
  NORMAL: accessor(NRM, "VEC3", 5126, 34962),
  TEXCOORD_0: accessor(UV0, "VEC2", 5126, 34962),
  TEXCOORD_1: accessor(UV1, "VEC2", 5126, 34962),
  JOINTS_0: accessor(JNT, "VEC4", 5123, 34962),
  WEIGHTS_0: accessor(WGT, "VEC4", 5126, 34962),
};
prim.indices = accessor(IDX, "SCALAR", 5125, 34963);
meshNode.extras = { ...(meshNode.extras ?? {}), parts: Object.fromEntries(parts.map((p, i) => [p.name, i])) };

// `--theme id=file` (repeated) packs every theme sheet onto ONE page, the way
// weapon-page does for held gear: the body is one draw whatever outfit a
// character wears, and an outfit picks its TILE (`tiles` in the node's extras,
// keyed by sheet id). The first theme is also the default look, through
// KHR_texture_transform, so a host that sets no tile still shows one outfit.
let pagePng = null;
let firstTile = null;
if (args.theme.length) {
  const sheets = args.theme.map((t) => {
    const [id, file] = String(t).split("=");
    return { id, png: decodePng(fs.readFileSync(fromStudio(file))) };
  });
  const size = sheets[0].png.width;
  for (const sh of sheets)
    if (sh.png.width !== size || sh.png.height !== size) throw new Error(`${sh.id}: ${sh.png.width}px, the page is ${size}px — one sheet size per page`);
  const PAD = 8;
  const cols = Math.ceil(Math.sqrt(sheets.length));
  const rows = Math.ceil(sheets.length / cols);
  const stride = size + PAD * 2;
  const W = cols * stride;
  const H = cols * stride; // square: a tile carries ONE scale
  const page = new Uint8Array(W * H * 4);
  const tiles = {};
  sheets.forEach((sh, i) => {
    const ox = (i % cols) * stride + PAD;
    const oy = Math.floor(i / cols) * stride + PAD;
    for (let y = -PAD; y < size + PAD; y++) {
      const sy = Math.min(size - 1, Math.max(0, y));
      for (let x = -PAD; x < size + PAD; x++) {
        const sx = Math.min(size - 1, Math.max(0, x));
        page.set(sh.png.data.subarray((sy * size + sx) * 4, (sy * size + sx) * 4 + 4), ((oy + y) * W + ox + x) * 4);
      }
    }
    tiles[sh.id] = [ox / W, oy / H, size / W].map((v) => +v.toFixed(6));
  });
  if (rows > cols) throw new Error("page layout");
  pagePng = encodePng(W, H, page);
  firstTile = tiles[sheets[0].id];
  meshNode.extras.tiles = tiles;
  console.log(`  page ${W}x${H}: ${Object.keys(tiles).join(", ")}`);
}
if (args.rules) {
  meshNode.extras.rules = JSON.parse(fs.readFileSync(fromStudio(String(args.rules)), "utf8"));
}

if (args.texture || pagePng) {
  const png = pagePng ?? fs.readFileSync(fromStudio(String(args.texture)));
  const tex = json.materials[prim.material].pbrMetallicRoughness.baseColorTexture;
  const image = json.images[json.textures[tex.index].source];
  delete image.uri;
  image.mimeType = "image/png";
  image.bufferView = append(new Uint8Array(png.buffer, png.byteOffset, png.length));
  // the body's texels are hard pixels, like every other piece of the look
  json.samplers[json.textures[tex.index].sampler ?? 0] = { magFilter: 9728, minFilter: 9986, wrapS: 10497, wrapT: 10497 };
  if (firstTile) {
    tex.extensions = { ...(tex.extensions ?? {}), KHR_texture_transform: { offset: [firstTile[0], firstTile[1]], scale: [firstTile[2], firstTile[2]] } };
    json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "KHR_texture_transform"])];
  }
  // Cut-outs are authored in the sheet's alpha (a robe's frayed hem, the back
  // ornament's open ring), so the material masks and draws both faces of
  // those single-sided panels. Without it the ornament is a solid square.
  const mat = json.materials[prim.material];
  // matte: no specular on the character (PSX look)
  mat.pbrMetallicRoughness = { ...mat.pbrMetallicRoughness, roughnessFactor: 1, metallicFactor: 0 };
  mat.alphaMode = "MASK";
  mat.alphaCutoff = 0.5;
  mat.doubleSided = true;
}

// the old accessors stay in the binary unreferenced; drop nothing else
const newBin = Buffer.concat(chunks);
const binPadded = Buffer.concat([newBin, Buffer.alloc((4 - (newBin.length % 4)) % 4)]);
json.buffers[0].byteLength = binPadded.length;
let js = Buffer.from(JSON.stringify(json));
js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + js.length + 8 + binPadded.length, 8);
const jsHead = Buffer.alloc(8);
jsHead.writeUInt32LE(js.length, 0);
jsHead.writeUInt32LE(0x4e4f534a, 4);
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(binPadded.length, 0);
binHead.writeUInt32LE(0x004e4942, 4);
const out = path.resolve(String(args.out));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, jsHead, js, binHead, binPadded]));
console.log(`  wrote ${path.relative(PLAYGROUND, out)} — ${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${n / 3} triangles, ${parts.length} parts in uv1`);
