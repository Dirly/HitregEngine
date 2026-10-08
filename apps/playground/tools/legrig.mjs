/**
 * legrig — rig an unrigged MANY-LEGGED or SPRAWLING creature from its own
 * geometry and GENERATE its clips, for bodies no donor fits.
 *
 *   node tools/legrig.mjs --creature spider --texture <atlas.png> --out <file.glb>
 *
 * WHY THIS EXISTS (and why it is not autorig.mjs): autorig warps a donor's
 * skeleton into the target and plays the donor's clips, which needs a donor
 * with the same body plan. There is no eight-legged donor, and a dog's legs
 * hang straight down where an alligator's sprawl out sideways — fitted to the
 * dog, the gator's legs barely moved and its elbows sheared. So this tool
 * reads the skeleton off the mesh instead: the creature is already cut into
 * named parts by the unwrap (`unwrap-weapon --recipe <name>` writes
 * `<Mob>-unwrapped-parts.obj`), every leg part becomes a two-bone chain from
 * where it meets the body (root), through its bend (knee), to its tip (foot),
 * and the trunk becomes a chain along the body axis.
 *
 * Locomotion is IK, not keyed rotations: each foot follows a stance/swing
 * cycle on the ground and the two leg bones are solved to reach it, so feet
 * stay planted and the depicted speed is exact — stride / (duty x period) —
 * and goes straight into the controller's `clipSpeeds`.
 *
 * The output is an UBERMESH like the unwrap's: each vertex's part index in
 * TEXCOORD_1 and the `parts` table (read from the unwrap's -parts.json) in
 * the mesh node's extras, so `mesh.source.partMask` or a model look's
 * `parts` shows or hides a part (the alligator's sail) on one draw.
 *
 * Everything faces +Z on output (the engine's mob convention, same as autorig);
 * the unwrap's sources face +X and are turned on load.
 */
import "./node-dom-shim.mjs";
import { addTextureSearchRoot } from "./node-dom-shim.mjs";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { renderStrip } from "./_softrender.mjs";
import { decodePng, encodePng } from "./_png.mjs";
import { smoothNormals } from "./_normals.mjs";
import fs from "node:fs";
import path from "node:path";

const STUDIO = path.resolve(import.meta.dirname, "../../../..");
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------- creatures
//
// `trunk` lists the parts skinned to the body chain, `joints` the chain's
// stations as fractions of the trunk's length from tail tip (0) to snout (1).
// `legs` lists leg parts; each is found twice (mirrorCopy built both sides)
// and split by side. `pole` is where a knee bends toward: "out" (sprawl, the
// elbow points out and up) or "up" (a spider's apex).
const CREATURES = {
  alligator: {
    mesh: "MMO/3d/Mobs/Dragon/Alligator-unwrapped-parts.obj",
    // a big old swamp alligator: 3.6 m snout to tail
    length: 3.6,
    plan: "sprawl",
    // Gator_Sail rides the spine; it is an optional part (part mask)
    trunk: ["Gator_Tail", "Gator_Body", "Gator_Head", "Gator_Sail"],
    // measured for the spine's height; a sail would lift every station
    profile: ["Gator_Tail", "Gator_Body", "Gator_Head"],
    // dead on its back it rests on its back: the sail goes through the ground
    groundIgnore: ["Gator_Sail"],
    // short legs: the struck paw lifts and steps less than a long-legged walker's
    hit: { light: { paw: 0.02, pitch: 0.025, back: 0.012 }, heavy: { paw: 0.03, step: 0.02, pitch: 0.035, dip: 0.004, sway: 0.008, roll: 0.04, back: 0.016 } },
    // tail tip .. tail .. hips .. chest .. neck .. skull .. snout
    joints: [
      { name: "tail4", at: 0.12 },
      { name: "tail3", at: 0.24 },
      { name: "tail2", at: 0.36 },
      { name: "tail1", at: 0.46 },
      { name: "hips", at: 0.54 },
      { name: "chest", at: 0.68 },
      { name: "neck", at: 0.76 },
      { name: "head", at: 0.82 },
    ],
    hub: "hips",
    legs: [
      // the elbow and the knee by hand (the search found corners of the shoulder and the thigh),
      // bent the way the model bends them
      { part: "Gator_LegFront", name: "front", parent: "chest", pole: "rest", kneeAt: [0.4, 0.22, 0.75], kneeBand: 0.3 },
      { part: "Gator_LegBack", name: "back", parent: "hips", pole: "rest", kneeAt: [0.43, 0.33, -0.1], kneeBand: 0.3 },
    ],
    // diagonal pairs, the lizard trot; phases in cycles
    phase: { "front.L": 0, "back.R": 0, "front.R": 0.5, "back.L": 0.5 },
    gaits: {
      // `girdle`: shoulders and hips turn with the legs (the lizard S), `roll` onto the stance legs
      // strides fit the short legs (0.62 m reached past them: the IK went straight and the skin
      // stretched), the cadence quicker to keep the same speeds
      Walk: { period: 1.11429, stride: 0.36, duty: 0.66, lift: 0.07, sway: 0.12, bob: 0.01, girdle: 0.18, roll: 0.03 },
      Run: { period: 0.42, stride: 0.42, duty: 0.5, lift: 0.08, sway: 0.16, bob: 0.02, girdle: 0.3, roll: 0.05 },
    },
  },
  dragon: {
    mesh: "MMO/3d/Mobs/Dragon/Dragon-unwrapped-parts.obj",
    // 7 m snout to tail tip
    length: 7,
    // a body that moves with its legs, a gallop, a roar (Derek: rework)
    plan: "quad",
    trunk: ["Dragon_Tail", "Dragon_Body", "Dragon_Neck", "Dragon_Head"],
    // pieces that ride one bone whole: they must not bend with the chain
    rigid: { Dragon_Horn: "head", Dragon_Spike: "chest" },
    joints: [
      { name: "tail4", at: 0.05 },
      { name: "tail3", at: 0.15 },
      { name: "tail2", at: 0.26 },
      { name: "tail1", at: 0.38 },
      { name: "hips", at: 0.5 },
      { name: "chest", at: 0.72 },
      { name: "neck", at: 0.8 },
      { name: "head", at: 0.88, parts: ["Dragon_Head"] },
    ],
    hub: "hips",
    // the knee bends the way the model's knee already bends
    legs: [
      // the legs hang straight down: root at the TOP (the innermost tenth was the toes, so the
      // "foot" was the shoulder and the real feet rode the body), the knee by hand, a cut-off foot
      // that stays flat on the ground (the toes were tipping into it)
      { part: "Dragon_LegFront", name: "front", parent: "chest", pole: "rest", rootAt: [0.37, 1.65, 1.72], kneeAt: [0.34, 1.12, 1.76], foot: 0.27, kneeBand: 0.25 },
      { part: "Dragon_LegBack", name: "back", parent: "hips", pole: "rest", root: "top", kneeAt: [0.32, 0.9, -0.15], foot: 0.27, kneeBand: 0.25 },
    ],
    wings: [{ part: "Dragon_Wing", name: "wing", parent: "chest" }],
    // lying dead it rests on its body: wings, back spikes and horns go where they fall
    groundIgnore: ["Dragon_Wing", "Dragon_Spike", "Dragon_Horn"],
    // standing clips crouch a little (the forelegs are near straight in the model)
    quad: { crouch: 0.08, roarPitch: 0.2, deathRoll: 0.18 },
    // a 7 m animal: the struck body recoils a few cm, not a few % of 7 m (its feet left the ground)
    hit: { light: { back: 0.01, pitch: 0.025, paw: 0.025 }, heavy: { back: 0.016, pitch: 0.04, paw: 0.035, step: 0.03, sway: 0.008 } },
    blend: [{ part: "Dragon_Neck", axis: "y", bones: ["chest", "neck", "head"] }],
    phase: { "front.L": 0, "back.R": 0, "front.R": 0.5, "back.L": 0.5 },
    gaits: {
      // heavy: crouched a little (`raise` < 0: the straight forelegs need the slack to reach), the
      // shoulders rolling over each planted foreleg, the head nodding against the step, the tail swinging
      Walk: { period: 1.5, stride: 0.95, duty: 0.66, lift: 0.2, sway: 0.05, bob: 0.05, raise: -0.1, pitch: 0.04, roll: 0.06, nod: 0.09, tail: 0.14 },
      // a gallop: the fronts land together, then the hinds; the back flexes
      // (the stride fits the legs: 1.9 m reached far past them, the feet skated; same speed, quicker bounds)
      Run: { period: 0.57933, stride: 1.1, duty: 0.3, lift: 0.3, sway: 0.03, bob: 0.1, raise: -0.08, gallop: true, pitch: 0.09, roll: 0.03, nod: 0.12, tail: 0.14,
        wingLift: 0.04, wingFlap: 0.04, phase: { "front.L": 0, "front.R": 0.1, "back.L": 0.5, "back.R": 0.6 } },
    },
  },
  lion: {
    mesh: "MMO/3d/Mobs/Dragon/Lion-unwrapped-parts.obj",
    // 2.8 m snout to tail tip
    length: 2.8,
    plan: "sprawl",
    trunk: ["Lion_Tail", "Lion_Body", "Lion_Head"],
    // the mane rides the neck whole (hidden, it is a lioness)
    rigid: { Lion_Mane: "neck" },
    joints: [
      { name: "tail4", at: 0.06 },
      { name: "tail3", at: 0.14 },
      { name: "tail2", at: 0.22 },
      { name: "tail1", at: 0.3 },
      { name: "hips", at: 0.38 },
      { name: "chest", at: 0.74 },
      { name: "neck", at: 0.86 },
      { name: "head", at: 0.92 },
    ],
    hub: "hips",
    legs: [
      { part: "Lion_LegFront", name: "front", parent: "chest", pole: "rest" },
      { part: "Lion_LegBack", name: "back", parent: "hips", pole: "rest" },
    ],
    // a cat's four-beat walk: hind, fore, other hind, other fore
    phase: { "back.L": 0, "front.L": 0.25, "back.R": 0.5, "front.R": 0.75 },
    gaits: {
      Walk: { period: 1.1, stride: 0.45, duty: 0.65, lift: 0.07, sway: 0.05, bob: 0.015 },
      Run: { period: 0.48, stride: 0.95, duty: 0.42, lift: 0.12, sway: 0.04, bob: 0.05 },
    },
  },
  goat: {
    mesh: "MMO/3d/Mobs/Dragon/Goat-unwrapped-parts.obj",
    // 1.6 m snout to tail tip
    length: 1.6,
    plan: "sprawl",
    trunk: ["Goat_Tail", "Goat_Body", "Goat_Neck", "Goat_Head"],
    rigid: { Goat_Horn: "head", Goat_Ear: "head", Goat_Beard: "head" },
    joints: [
      { name: "tail2", at: 0.04 },
      { name: "tail1", at: 0.13 },
      { name: "hips", at: 0.28 },
      { name: "chest", at: 0.68 },
      { name: "neck", at: 0.8, parts: ["Goat_Neck"] },
      { name: "head", at: 0.9, parts: ["Goat_Head"] },
    ],
    hub: "hips",
    legs: [
      { part: "Goat_LegFront", name: "front", parent: "chest", pole: "rest" },
      { part: "Goat_LegBack", name: "back", parent: "hips", pole: "rest" },
    ],
    phase: { "back.L": 0, "front.L": 0.25, "back.R": 0.5, "front.R": 0.75 },
    gaits: {
      Walk: { period: 0.9, stride: 0.32, duty: 0.65, lift: 0.06, sway: 0.03, bob: 0.012 },
      Run: { period: 0.42, stride: 0.7, duty: 0.42, lift: 0.1, sway: 0.03, bob: 0.04 },
    },
  },
  ant: {
    mesh: "MMO/3d/Mobs/Dragon/Ant-unwrapped-parts.obj",
    // 1.8 m overall, antenna tip to hind leg tip
    span: 1.8,
    plan: "arachnid",
    // the queen's gaster and the soldier's jaws are the unwrap's scaledCopy
    // alternatives, shown instead of the worker's by part mask
    trunk: ["Ant_Head", "Ant_Thorax", "Ant_Abdomen", "Ant_AbdomenQueen"],
    profile: ["Ant_Head", "Ant_Thorax", "Ant_Abdomen"],
    // (and the army ant's stag-beetle jaws, split-ant.mjs's own part)
    alternatives: ["Ant_AbdomenQueen", "Ant_MandibleSoldier", "Ant_MandibleArmy"],
    rigid: { Ant_Antenna: "head", Ant_Mandible: "head", Ant_MandibleSoldier: "head", Ant_MandibleArmy: "head" },
    joints: [
      { name: "abdomen", at: 0.33, parts: ["Ant_Abdomen", "Ant_AbdomenQueen"] },
      { name: "thorax", at: 0.56, parts: ["Ant_Thorax"] },
      { name: "head", at: 0.76, parts: ["Ant_Head"] },
    ],
    hub: "thorax",
    legs: [
      { part: "Ant_Leg1", name: "leg1", parent: "thorax", pole: "up" },
      { part: "Ant_Leg2", name: "leg2", parent: "thorax", pole: "up" },
      { part: "Ant_Leg3", name: "leg3", parent: "thorax", pole: "up" },
    ],
    // the alternating tripod: L1 R2 L3 together, then the other three
    phase: { "leg1.L": 0, "leg2.R": 0, "leg3.L": 0, "leg1.R": 0.5, "leg2.L": 0.5, "leg3.R": 0.5 },
    gaits: {
      Walk: { period: 0.8, stride: 0.28, duty: 0.6, lift: 0.08, sway: 0, bob: 0.01 },
      Run: { period: 0.36, stride: 0.45, duty: 0.5, lift: 0.1, sway: 0, bob: 0.015 },
    },
  },
  trout: {
    mesh: "MMO/3d/Mobs/Dragon/Trout-unwrapped-parts.obj",
    // a 1.2 m giant trout. No legs: Walk and Run are swimming, the trunk's
    // travelling wave doing all the work (stride / duty set the speed printed)
    length: 1.2,
    plan: "sprawl",
    trunk: ["Trout_Body"],
    rigid: { Trout_Fins: "hips" },
    joints: [
      { name: "tail3", at: 0.1 },
      { name: "tail2", at: 0.25 },
      { name: "tail1", at: 0.4 },
      { name: "hips", at: 0.52 },
      { name: "chest", at: 0.65 },
      { name: "neck", at: 0.78 },
      { name: "head", at: 0.88 },
    ],
    hub: "hips",
    legs: [],
    phase: {},
    gaits: {
      Walk: { period: 1.0, stride: 1.0, duty: 1, lift: 0, sway: 0.22, bob: 0.01 },
      Run: { period: 0.45, stride: 1.4, duty: 1, lift: 0, sway: 0.3, bob: 0.015 },
    },
  },
  spider: {
    mesh: "MMO/3d/Mobs/Dragon/Spider-unwrapped-parts.obj",
    // a giant cave spider: 2.4 m across the legs
    span: 2.4,
    plan: "arachnid",
    trunk: ["Spider_Head", "Spider_Abdomen"],
    joints: [
      { name: "abdomen", at: 0.62, parts: ["Spider_Abdomen"] },
      { name: "thorax", at: 0.84, parts: ["Spider_Head"] },
    ],
    hub: "thorax",
    legs: [
      { part: "Spider_Leg1", name: "leg1", parent: "thorax", pole: "up" },
      { part: "Spider_Leg2", name: "leg2", parent: "thorax", pole: "up" },
      { part: "Spider_Leg3", name: "leg3", parent: "thorax", pole: "up" },
      { part: "Spider_Leg4", name: "leg4", parent: "thorax", pole: "up" },
    ],
    // alternating tetrapod: L1 R2 L3 R4 together, then the other four
    phase: {
      "leg1.L": 0, "leg2.R": 0, "leg3.L": 0, "leg4.R": 0,
      "leg1.R": 0.5, "leg2.L": 0.5, "leg3.R": 0.5, "leg4.L": 0.5,
    },
    gaits: {
      Walk: { period: 0.9, stride: 0.34, duty: 0.6, lift: 0.1, sway: 0, bob: 0.015 },
      Run: { period: 0.42, stride: 0.5, duty: 0.5, lift: 0.12, sway: 0, bob: 0.02 },
    },
  },
};

// ---------------------------------------------------------------- args
const args = {};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2), n = a[i + 1];
    if (n === undefined || n.startsWith("--")) args[k] = true;
    else { args[k] = n; i++; }
  }
}
// a creature may also be a JSON spec file beside its cut (MMO/3d/Mobs/Dragon/work/rigs/<creature>.json),
// or any file given with --spec — same fields as a CREATURES entry
{
  const file = args.spec ? path.resolve(String(args.spec)) : path.join(STUDIO, "MMO/3d/Mobs/Dragon/work/rigs", `${args.creature}.json`);
  if (!CREATURES[args.creature] && fs.existsSync(file)) CREATURES[args.creature] = JSON.parse(fs.readFileSync(file, "utf8"));
}
const spec = CREATURES[args.creature];
if (!spec || !args.out) {
  console.log(`
legrig — rig a sprawling or many-legged creature from its own parts, with
generated Idle / Walk / Run / Bite / Death clips

  --creature <name>   ${Object.keys(CREATURES).join(" | ")}
  --out <file.glb>    output
  --texture <png>     the atlas (an unwrap bake's atlas-seamblend.png)
  --render <dir>      write a contact sheet per clip (side + top, 6 frames)
  --tile <px>         contact sheet tile size (default 300)
  --full              sheets span the whole clip (a flyer's otherwise show one wing beat)
  --verbose           print where each leg's and wing's joints landed
  --spec <file.json>  a creature spec as JSON (default: work/rigs/<creature>.json)
`);
  process.exit(spec ? 1 : 0);
}

// ---------------------------------------------------------------- mesh
const meshFile = path.join(STUDIO, spec.mesh);
const obj = new OBJLoader().parse(fs.readFileSync(meshFile, "utf8"));
const partGeo = new Map();
obj.traverse((o) => { if (o.isMesh) partGeo.set(o.name, o.geometry.index ? o.geometry.toNonIndexed() : o.geometry); });
// `regions` re-tag pieces of a part for RIGGING only (the part bit in TEXCOORD_1
// stays the unwrap's): a raven's tail tip cut into its leg part, a dragonfly's
// fore and hind wings in one wing part. `as` is the rig-only part name.
const virtualParts = new Set((spec.regions ?? []).map((r) => r.as));
for (const name of [...spec.trunk, ...spec.legs.map((l) => l.part), ...Object.keys(spec.rigid ?? {}), ...(spec.wings ?? []).map((w) => w.part), ...(spec.chains ?? []).map((c) => c.part)])
  if (!partGeo.has(name) && !virtualParts.has(name)) { console.error(`legrig: ${spec.mesh} has no part ${name}`); process.exit(1); }
// the part bits are the unwrap's, so a mask means the same thing on both meshes
const partsFile = meshFile.replace(/-parts.obj$/, "-parts.json");
const partIndex = fs.existsSync(partsFile)
  ? JSON.parse(fs.readFileSync(partsFile, "utf8")).parts
  : Object.fromEntries([...partGeo.keys()].map((n, i) => [n, i]));

// one vertex list for the whole animal, each vertex tagged with its part;
// turned from +X forward to +Z forward
const turn = new THREE.Matrix4().makeRotationY(-Math.PI / 2);
const verts = [], uvs = [], tags = [], partTags = [];
for (const [name, g] of partGeo) {
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    verts.push(V3(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(turn));
    uvs.push(uv ? [uv.getX(i), uv.getY(i)] : [0, 0]);
    tags.push(name);
    partTags.push(name);
  }
}
// regions, tested in the SOURCE frame (x forward, y up, z side, as the -parts.obj
// stores it): per triangle centroid, or per connected shell with `by: "shell"`
for (const R of spec.regions ?? []) {
  const src = (v) => [v.z, v.y, -v.x]; // undo the turn: verts are (-z, y, x) of the source
  const inside = (c) => ["x", "y", "z"].every((a, k) => !R[a] || (c[k] >= R[a][0] && c[k] <= R[a][1]));
  const triIds = [];
  for (let t = 0; t < verts.length; t += 3) if (partTags[t] === R.part) triIds.push(t);
  let groups;
  if (R.by === "shell") {
    const key = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
    const par = new Map();
    const find = (k) => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
    for (const t of triIds) {
      for (let j = 0; j < 3; j++) { const k = key(verts[t + j]); if (!par.has(k)) par.set(k, k); }
      for (let j = 1; j < 3; j++) par.set(find(key(verts[t + j])), find(key(verts[t])));
    }
    const m = new Map();
    for (const t of triIds) { const r = find(key(verts[t])); if (!m.has(r)) m.set(r, []); m.get(r).push(t); }
    groups = [...m.values()];
  } else groups = triIds.map((t) => [t]);
  let n = 0;
  for (const g of groups) {
    const c = [0, 0, 0];
    for (const t of g) for (let j = 0; j < 3; j++) src(verts[t + j]).forEach((v, k) => (c[k] += v / (g.length * 3)));
    if (!inside(c)) continue;
    for (const t of g) for (let j = 0; j < 3; j++) tags[t + j] = R.as;
    n += g.length;
  }
  console.log(`region ${R.part} -> ${R.as}: ${n} tris`);
}
// `flank: true` on a wing: the wing was cut out of the body's own side (a
// raven's folded wing; the body is hollow under it), so spreading it would open
// the body. A folded COPY of its triangles stays on the body (its parent bone)
// as the flank, and the original flies. Same UVs and part bit: still one draw.
for (const W of spec.wings ?? []) {
  if (!W.flank) continue;
  const n = verts.length;
  for (let i = 0; i < n; i++) if (tags[i] === W.part) {
    verts.push(verts[i].clone()); uvs.push(uvs[i]); partTags.push(partTags[i]); tags.push(`${W.part}#flank`);
  }
  (spec.rigid ??= {})[`${W.part}#flank`] = W.parent;
}
// scale to metres and stand it on the ground, measured on the base animal:
// an alternative part (a queen's gaster) must not shrink everything else
const box = new THREE.Box3().setFromPoints(verts.filter((_, i) => !spec.alternatives?.includes(tags[i])));
const size = box.getSize(V3());
const scale = spec.length ? spec.length / size.z : spec.span / Math.max(size.x, size.z);
for (const v of verts) v.sub(V3((box.min.x + box.max.x) / 2, box.min.y, 0)).multiplyScalar(scale);
const B = new THREE.Box3().setFromPoints(verts);
console.log(`mesh ${path.basename(meshFile)}: ${verts.length / 3} tris, ${B.getSize(V3()).toArray().map((v) => v.toFixed(2)).join(" x ")} m (x${scale.toFixed(4)})`);

// ---------------------------------------------------------------- skeleton
const bones = new Map();
function bone(name, worldPos, parentName) {
  const b = new THREE.Bone();
  b.name = name;
  b.userData.rest = worldPos.clone();
  const parent = parentName ? bones.get(parentName) : null;
  b.position.copy(parent ? worldPos.clone().sub(parent.userData.rest) : worldPos);
  if (parent) parent.add(b);
  bones.set(name, b);
  return b;
}
const root = bone("root", V3(0, 0, 0), null);

// trunk stations: z from tail tip to snout, y the centre of the slice there
const trunkIdx = verts.map((_, i) => i).filter((i) => spec.trunk.includes(tags[i]));
const spanIdx = spec.profile ? trunkIdx.filter((i) => spec.profile.includes(tags[i])) : trunkIdx;
const zMin = Math.min(...spanIdx.map((i) => verts[i].z)), zMax = Math.max(...spanIdx.map((i) => verts[i].z));
function sliceCentreY(z, parts) {
  const band = 0.04 * (zMax - zMin);
  let lo = Infinity, hi = -Infinity;
  for (const i of trunkIdx) {
    if (parts && !parts.includes(tags[i])) continue;
    if (spec.profile && !spec.profile.includes(tags[i])) continue;
    if (Math.abs(verts[i].z - z) < band) { lo = Math.min(lo, verts[i].y); hi = Math.max(hi, verts[i].y); }
  }
  return lo === Infinity ? null : (lo + hi) / 2;
}
const hubJoint = spec.joints.find((j) => j.name === spec.hub);
const stations = spec.joints.map((j) => {
  // `pin: [x, y, z]` places a station by hand, in output metres (a serpent's
  // upright neck: its stations run up, not along the body's z)
  if (j.pin) return { ...j, pos: V3(...j.pin) };
  const z = zMin + j.at * (zMax - zMin);
  return { ...j, pos: V3(0, sliceCentreY(z, j.parts) ?? 0, z) };
});
// the hub hangs off the root; the chain runs both ways from it
const hubIdx = stations.findIndex((s) => s.name === spec.hub);
bone(stations[hubIdx].name, stations[hubIdx].pos, "root");
for (let k = hubIdx + 1; k < stations.length; k++) bone(stations[k].name, stations[k].pos, stations[k - 1].name);
for (let k = hubIdx - 1; k >= 0; k--) bone(stations[k].name, stations[k].pos, stations[k + 1].name);

// legs: root where the part meets the body, foot at its far end, knee the
// point furthest off the root-foot line (on the pole's side)
const legs = [];
for (const L of spec.legs) {
  for (const side of ["L", "R"]) {
    const sgn = side === "L" ? 1 : -1; // +X is the creature's left when it faces +Z
    const idx = verts.map((_, i) => i).filter((i) => tags[i] === L.part && Math.sign(verts[i].x || 1e-9) === sgn);
    if (!idx.length) { console.error(`legrig: ${L.part} has no ${side} side — did the unwrap mirrorCopy it?`); process.exit(1); }
    const all = idx.map((i) => verts[i]);
    // root: the centroid of the innermost tenth (a sprawler's leg leaves the
    // body sideways), or of the topmost tenth for a leg that hangs straight
    // down (`root: "top"`: a biped's, a bird's)
    // `pins: { root, knee, ankle }` place joints by hand, each [forward, up] in
    // the SOURCE frame (the -parts.obj's x and y); the side offset is read off
    // the leg's own vertices at that height. For a leg whose joints the search
    // below cannot find (a theropod's: the thigh is inside the body part)
    const pin = (a) => {
      if (!a) return null;
      const y = (a[1] - box.min.y) * scale, z = a[0] * scale;
      const near = [...all].sort((p, q) => Math.abs(p.y - y) - Math.abs(q.y - y)).slice(0, Math.max(3, Math.floor(all.length * 0.1)));
      return V3(sgn * near.reduce((s, p) => s + Math.abs(p.x), 0) / near.length, y, z);
    };
    const P = L.pins ?? {};
    // `rootAt: [out, up, fwd]` (output metres, out mirrored): the shoulder by hand, e.g. inside the
    // body when the leg part only starts at the elbow (the dragon's forelegs)
    const rootP = (L.rootAt && V3(sgn * L.rootAt[0], L.rootAt[1], L.rootAt[2])) ?? pin(P.root) ?? limbRoot(all, L.root ?? "inner");
    // `foot: f` (a fraction of the root's height) cuts a FOOT off the leg at
    // the ankle: the IK reaches the ankle and the foot stays flat on the
    // ground through stance, instead of tilting with the shin
    let pts = all, ankle = null;
    if (P.ankle) {
      ankle = pin(P.ankle);
      L.foot = ankle.y / rootP.y;
      pts = all.filter((p) => p.y >= ankle.y);
    } else if (L.foot) {
      const fy = L.foot * rootP.y, band = 0.04 * rootP.y;
      const ring = all.filter((p) => Math.abs(p.y - fy) < band);
      ankle = ring.reduce((s, p) => s.add(p), V3()).divideScalar(ring.length);
      pts = all.filter((p) => p.y >= fy);
    }
    // foot: farthest from the root
    let foot = ankle ?? pts[0];
    if (!ankle) for (const p of pts) if (p.distanceTo(rootP) > foot.distanceTo(rootP)) foot = p;
    // knee: off the line, toward the pole
    const dir = foot.clone().sub(rootP).normalize();
    let knee = null, best = -Infinity;
    for (const p of pts) {
      const off = p.clone().sub(rootP);
      const along = off.dot(dir) / rootP.distanceTo(foot);
      const perp = off.sub(dir.clone().multiplyScalar(off.dot(dir)));
      // "up": the apex, but not the hip of a leg that slopes down off the body
      const score = L.pole === "up" || L.pole === "body" ? (along < 0.2 ? -Infinity : p.y + 0.3 * perp.length()) : perp.length();
      if (score > best) { best = score; knee = p; }
    }
    // the knee sits inside the limb, not on its skin: average the ring there
    const ring = pts.filter((p) => p.distanceTo(knee) < 0.08 * rootP.distanceTo(foot));
    // `kneeAt: [out, up, fwd]` puts the knee by hand in OUTPUT metres (out mirrored per side): the
    // search below finds a corner of the root on a short sprawler's leg (the gator's "elbow" sat
    // 0.12 m from its shoulder, so the whole leg swung from the shoulder and the skin there pinched)
    const kneeC = (L.kneeAt && V3(sgn * L.kneeAt[0], L.kneeAt[1], L.kneeAt[2])) ?? pin(P.knee) ?? ring.reduce((s, p) => s.add(p), V3()).divideScalar(ring.length);
    // the way this knee already bends, kept for the IK
    const kOff = kneeC.clone().sub(rootP);
    const poleRest = kOff.sub(dir.clone().multiplyScalar(kOff.dot(dir))).normalize();
    const tipName = `${L.name}.${side}`;
    const upper = bone(`${tipName}.upper`, rootP, L.parent);
    const lower = bone(`${tipName}.lower`, kneeC, upper.name);
    const end = bone(`${tipName}.end`, foot, lower.name);
    let footBone = null, footY = 0;
    if (ankle) {
      // the foot hangs off the ankle (`end`), its tip the farthest point forward
      let toe = all[0];
      for (const p of all) if (p.y < L.foot * rootP.y && p.z > toe.z) toe = p;
      footBone = end;
      bone(`${tipName}.toe`, toe, end.name);
      footY = L.foot * rootP.y;
    }
    legs.push({ key: tipName, idx, upper, lower, end, pole: L.pole, poleRest, sgn, footBone, footY, tuck: L.tuck,
      kneeBand: L.kneeBand, fold: L.fold, biteFold: L.biteFold, deadFold: L.deadFold, poleDir: L.poleDir, n: spec.legs.indexOf(L),
      a: rootP.distanceTo(kneeC), b: kneeC.distanceTo(foot), foot0: foot.clone() });
    if (args.verbose) console.log(`  ${tipName}: root ${fmt(rootP)} knee ${fmt(kneeC)} foot ${fmt(foot)}`);
  }
}
function limbRoot(pts, mode) {
  const score = mode === "top" ? (p) => -p.y : mode === "front" ? (p) => -p.z : (p) => Math.abs(p.x);
  const s = pts.map(score).sort((a, b) => a - b);
  const cut = s[Math.floor(s.length * 0.1)];
  const sel = pts.filter((p) => score(p) <= cut);
  return sel.reduce((acc, p) => acc.add(p), V3()).divideScalar(sel.length);
}
function fmt(v) { return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`; }
// wings: a two-bone chain from where the wing meets the body to its tip, the
// membrane split at half way, so it can spread, flap and fold
const wings = [];
for (const W of spec.wings ?? []) {
  for (const side of ["L", "R"]) {
    const sgn = side === "L" ? 1 : -1;
    const idx = verts.map((_, i) => i).filter((i) => tags[i] === W.part && Math.sign(verts[i].x || 1e-9) === sgn);
    const pts = idx.map((i) => verts[i]);
    // the root: innermost tenth (a wing that leaves the body sideways), or the
    // front tenth (`root: "front"`, a bird's wing folded back along its side)
    const rootP = limbRoot(pts, W.root ?? "inner");
    let tip = pts[0];
    for (const p of pts) if (p.distanceTo(rootP) > tip.distanceTo(rootP)) tip = p;
    const mid = rootP.clone().lerp(tip, 0.5);
    const key = `${W.name}.${side}`;
    const upper = bone(`${key}.upper`, rootP, W.parent);
    const lower = bone(`${key}.lower`, mid, upper.name);
    bone(`${key}.end`, tip, lower.name);
    // the wing's plane at rest: its normal is the least-spread direction across
    // the root-tip line, turned to face out/up (it becomes the TOP face in flight)
    const restDir = tip.clone().sub(rootP).normalize();
    const c = pts.reduce((s, p) => s.add(p), V3()).divideScalar(pts.length);
    let xx = 0, xy = 0, yy = 0;
    const e1 = Math.abs(restDir.y) < 0.9 ? V3(0, 1, 0) : V3(1, 0, 0);
    const u = e1.sub(restDir.clone().multiplyScalar(e1.dot(restDir))).normalize(), v = restDir.clone().cross(u);
    for (const p of pts) { const d = p.clone().sub(c); const a = d.dot(u), b = d.dot(v); xx += a * a; xy += a * b; yy += b * b; }
    const th = 0.5 * Math.atan2(2 * xy, xx - yy); // the in-plane axis of most spread
    const wide = u.clone().multiplyScalar(Math.cos(th)).add(v.clone().multiplyScalar(Math.sin(th)));
    const restN = restDir.clone().cross(wide).normalize();
    if (restN.dot(V3(sgn, 1, 0)) < 0) restN.negate();
    wings.push({ key, idx, upper, lower, sgn, rootP, tip, restDir, restN, phase: W.phase ?? 0, spec: W });
    if (args.verbose) console.log(`  ${key}: root ${fmt(rootP)} tip ${fmt(tip)} normal ${fmt(restN)}`);
  }
}
// chains: a part that bends along its OWN length however it curls (a scorpion's
// tail, back, up and over; its arms). `{ part, name, parent, bones: N, sides }`.
// Each vertex is placed by its distance ALONG THE SURFACE from where the part
// meets the body (the seam it shares with a trunk part, else the end nearest the
// parent bone), so a curled tail is cut into segments down its curve, not by
// height or depth. Bones `<name>1..N` (`.L`/`.R` with `sides`) sit on the curve
// (the centroid of the slice there), `<name>.end` at the tip.
const chains = [];
for (const C of spec.chains ?? []) {
  const key = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
  const trunkKeys = new Set();
  verts.forEach((v, i) => { if (spec.trunk.includes(tags[i]) && tags[i] !== C.part) trunkKeys.add(key(v)); });
  for (const side of C.sides ? ["L", "R"] : [""]) {
    const sgn = side === "L" ? 1 : side === "R" ? -1 : 0;
    const sfx = side ? `.${side}` : "";
    const idx = verts.map((_, i) => i).filter((i) => tags[i] === C.part && (!sgn || Math.sign(verts[i].x || 1e-9) === sgn));
    if (!idx.length) { console.error(`legrig: chain ${C.part} has no vertices${side ? ` on side ${side}` : ""}`); process.exit(1); }
    // welded positions and the surface's edges
    const pid = new Map(), pos = [], vp = new Map();
    for (const i of idx) { const k = key(verts[i]); if (!pid.has(k)) { pid.set(k, pos.length); pos.push(verts[i]); } vp.set(i, pid.get(k)); }
    const adj = pos.map(() => []);
    for (const i of idx) if (i % 3 === 0 && vp.has(i + 1) && vp.has(i + 2))
      for (const [a, b] of [[i, i + 1], [i + 1, i + 2], [i + 2, i]]) {
        const pa = vp.get(a), pb = vp.get(b), d = pos[pa].distanceTo(pos[pb]);
        adj[pa].push([pb, d]); adj[pb].push([pa, d]);
      }
    let base = pos.map((_, k) => k).filter((k) => trunkKeys.has(key(pos[k])));
    if (base.length < 3) {
      const P = bones.get(C.parent).userData.rest;
      const order = pos.map((_, k) => k).sort((a, b) => pos[a].distanceTo(P) - pos[b].distanceTo(P));
      base = order.slice(0, Math.max(3, Math.floor(pos.length * 0.06)));
    }
    // Dijkstra from the base (a few hundred positions: the plain O(n^2) form)
    const dist = pos.map(() => Infinity), done = pos.map(() => false);
    for (const k of base) dist[k] = 0;
    for (;;) {
      let u = -1;
      for (let k = 0; k < pos.length; k++) if (!done[k] && dist[k] < Infinity && (u < 0 || dist[k] < dist[u])) u = k;
      if (u < 0) break;
      done[u] = true;
      for (const [w, d] of adj[u]) if (dist[u] + d < dist[w]) dist[w] = dist[u] + d;
    }
    const maxD = Math.max(...dist.filter((d) => d < Infinity));
    const sOf = (k) => (dist[k] < Infinity ? dist[k] / maxD : 1);
    const N = C.bones ?? 4;
    const centroid = (ks) => ks.reduce((a, k) => a.add(pos[k]), V3()).divideScalar(ks.length);
    const joints = [], radius = [];
    for (let j = 0; j <= N; j++) {
      let ks;
      if (j === 0) ks = base;
      else for (let bw = 0.15 / N; ; bw *= 1.5) {
        ks = pos.map((_, k) => k).filter((k) => (j === N ? sOf(k) >= 1 - bw : Math.abs(sOf(k) - j / N) < bw));
        if (ks.length >= 3 || bw > 1) break;
      }
      const c = centroid(ks);
      joints.push(c);
      radius.push(ks.reduce((a, k) => a + pos[k].distanceTo(c), 0) / ks.length);
    }
    const list = [];
    for (let j = 0; j < N; j++) list.push(bone(`${C.name}${j + 1}${sfx}`, joints[j], j ? list[j - 1].name : C.parent));
    const end = bone(`${C.name}.end${sfx}`, joints[N], list[N - 1].name);
    chains.push({ key: C.name + sfx, spec: C, sgn, idx, bones: list, end, s: idx.map((i) => sOf(vp.get(i))),
      radius: radius.slice(1, -1).reduce((a, r) => a + r, 0) / Math.max(1, N - 1), length: maxD });
    console.log(`chain ${C.name}${sfx}: ${N} bones along ${maxD.toFixed(2)} m of surface from ${base.length} base points`);
    if (args.verbose) console.log("  " + joints.map(fmt).join(" "));
  }
}
console.log(`skeleton: ${bones.size} bones — trunk ${stations.map((s) => s.name).join(" ")}, ${legs.length} legs${wings.length ? `, ${wings.length} wings` : ""}`);

// ---------------------------------------------------------------- weights
const skinIndex = new Uint16Array(verts.length * 4);
const skinWeight = new Float32Array(verts.length * 4);
const boneList = [...bones.values()];
const bi = (b) => boneList.indexOf(b);
function setW(i, pairs) {
  const tot = pairs.reduce((s, p) => s + p[1], 0);
  // clear all four slots first: a later pass (blend) writing fewer bones than
  // an earlier one must not leave stale weights behind (they summed past 1)
  skinIndex.fill(0, i * 4, i * 4 + 4);
  skinWeight.fill(0, i * 4, i * 4 + 4);
  pairs.slice(0, 4).forEach(([b, w], k) => { skinIndex[i * 4 + k] = bi(b); skinWeight[i * 4 + k] = w / tot; });
}
// trunk: blend between the two stations either side along z, each bone owning
// the span from its own joint toward the next station out from the hub
const sorted = [...stations].sort((a, b) => a.pos.z - b.pos.z);
for (let i = 0; i < verts.length; i++) {
  // `{S}` in the bone name is the vertex's side: a claw rides `leg.{S}.end`
  const to = spec.rigid?.[tags[i]]?.replace("{S}", verts[i].x >= 0 ? "L" : "R");
  if (to && !bones.has(to)) { console.error(`legrig: rigid ${tags[i]} -> no bone ${to}`); process.exit(1); }
  if (to) setW(i, [[bones.get(to), 1]]);
}
for (const W of wings) {
  const ab = W.tip.clone().sub(W.rootP);
  for (const i of W.idx) {
    const t = THREE.MathUtils.clamp(verts[i].clone().sub(W.rootP).dot(ab) / ab.lengthSq(), 0, 1);
    const k = THREE.MathUtils.smoothstep(t, 0.4, 0.6);
    setW(i, [[W.upper, 1 - k], [W.lower, k]].filter((x) => x[1] > 0));
  }
}
for (const i of trunkIdx) {
  const z = verts[i].z;
  const own = spec.joints.filter((j) => j.parts?.includes(tags[i]));
  if (own.length === 1) { setW(i, [[bones.get(own[0].name), 1]]); continue; }
  if (z <= sorted[0].pos.z) { setW(i, [[bones.get(sorted[0].name), 1]]); continue; }
  if (z >= sorted.at(-1).pos.z) { setW(i, [[bones.get(sorted.at(-1).name), 1]]); continue; }
  const k = sorted.findIndex((s, n) => n + 1 < sorted.length && z >= s.pos.z && z < sorted[n + 1].pos.z);
  const t = (z - sorted[k].pos.z) / (sorted[k + 1].pos.z - sorted[k].pos.z);
  setW(i, [[bones.get(sorted[k].name), 1 - t], [bones.get(sorted[k + 1].name), t]]);
}
// `blend`: a part that runs along another axis than the body (a dragon's neck
// rises nearly upright) is weighted along THAT axis, through a list of bones,
// so it bends from chest to neck to head instead of moving as one block
for (const B of spec.blend ?? []) {
  const a = { x: "x", y: "y", z: "z" }[B.axis ?? "y"];
  const idx = verts.map((_, i) => i).filter((i) => tags[i] === B.part);
  const lo = Math.min(...idx.map((i) => verts[i][a])), hi = Math.max(...idx.map((i) => verts[i][a]));
  const chain = B.bones.map((n) => bones.get(n));
  for (const i of idx) {
    const t = THREE.MathUtils.clamp((verts[i][a] - lo) / (hi - lo), 0, 1) * (chain.length - 1);
    const k = Math.min(chain.length - 2, Math.floor(t)), r = t - k;
    setW(i, [[chain[k], 1 - r], [chain[k + 1], r]].filter((x) => x[1] > 0));
  }
}
// `hood: { part, bone, at: [x, y, z], parent, width: [inner, outer] m, maxZ }`: a cobra's hood
// spreads. Its sides (|x - at.x| past `inner`, fully by `outer`, behind z = maxZ)
// ride a leaf bone that the clips SCALE sideways (a scale track, the only one)
if (spec.hood) {
  const Hd = spec.hood;
  const hb = bone(Hd.bone ?? "hood", V3(...Hd.at), Hd.parent ?? "head");
  hb.userData.scaled = true;
  boneList.push(hb);
  const [w0, w1] = Hd.width ?? [0.06, 0.18];
  let n = 0;
  for (let i = 0; i < verts.length; i++) {
    if (tags[i] !== Hd.part || (Hd.maxZ !== undefined && verts[i].z > Hd.maxZ)) continue;
    const f = THREE.MathUtils.smoothstep(Math.abs(verts[i].x - Hd.at[0]), w0, w1);
    if (f <= 0) continue;
    const pairs = [];
    for (let k = 0; k < 4; k++) if (skinWeight[i * 4 + k] > 0) pairs.push([boneList[skinIndex[i * 4 + k]], skinWeight[i * 4 + k] * (1 - f)]);
    pairs.push([hb, f]);
    pairs.sort((a, b) => b[1] - a[1]);
    setW(i, pairs.filter((p) => p[1] > 0));
    n++;
  }
  console.log(`hood: ${n} vertices spread by ${hb.name}`);
}
// legs: by position along the root-knee-foot polyline, blended over a short
// band round the knee; the very root blends into the body bone
function along(p, a, b) {
  const ab = b.clone().sub(a), t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  return { t, d: a.clone().add(ab.multiplyScalar(t)).distanceTo(p) };
}
for (const L of legs) {
  const R = L.upper.userData.rest, K = L.lower.userData.rest, F = L.end.userData.rest;
  const body = L.upper.parent;
  for (const i of L.idx) {
    const p = verts[i];
    if (L.footBone) {
      // below the ankle: the foot, blended into the shin over a short band
      const band = 0.25 * L.footY;
      const k = THREE.MathUtils.clamp((L.footY + band / 2 - p.y) / band, 0, 1);
      if (k >= 1) { setW(i, [[L.footBone, 1]]); continue; }
      if (k > 0) { setW(i, [[L.footBone, k], [L.lower, 1 - k]]); continue; }
    }
    const u = along(p, R, K), l = along(p, K, F);
    // `kneeBand` (spec leg): the share of each bone blended across the knee (a short, thick
    // sprawler leg folding at the elbow pinched there with the default 0.12)
    const band = L.kneeBand ?? 0.12;
    if (u.d <= l.d) {
      const nearKnee = Math.max(0, (u.t - (1 - band)) / band) * 0.5;
      // all body at the very root, where the leg was cut off the body's shell
      const nearRoot = Math.max(0, (0.2 - u.t) / 0.2);
      setW(i, [[L.upper, 1 - nearKnee - nearRoot], [L.lower, nearKnee], [body, nearRoot]].filter((x) => x[1] > 0));
    } else {
      const nearKnee = Math.max(0, (band - l.t) / band) * 0.5;
      setW(i, [[L.lower, 1 - nearKnee], [L.upper, nearKnee]].filter((x) => x[1] > 0));
    }
  }
}

// chains: by distance along the part, each segment its bone's, blended over a
// band round every joint; the base blends into the parent (the body)
for (const c of chains) {
  // `band` (0..0.5) is the share of each link blended into its neighbours: 0.5 blends all the
  // way (a long thin body bending everywhere: the serpent), 0.3 keeps a limb's segments firm
  const N = c.bones.length, bw = c.spec.band ?? 0.3, parent = c.bones[0].parent;
  c.idx.forEach((i, n) => {
    const x = Math.min(c.s[n] * N, N - 1e-6), k = Math.floor(x), f = x - k;
    if (f < bw) {
      const prev = k ? c.bones[k - 1] : parent, w = k ? 0.5 + 0.5 * f / bw : f / bw;
      setW(i, [[c.bones[k], w], [prev, 1 - w]].filter((p) => p[1] > 0));
    } else if (f > 1 - bw && k < N - 1) {
      const w = 0.5 * (f - (1 - bw)) / bw;
      setW(i, [[c.bones[k], 1 - w], [c.bones[k + 1], w]]);
    } else setW(i, [[c.bones[k], 1]]);
  });
}

// `junction: { parts, below, at, above, band: [lo, hi], radius }`: where an upright part grows
// out of a chain (a cobra's neck out of its body) the cut is ragged: neck slivers hang down
// beside the chain's first link and body vertices sit on the seam, each weighted wholly to its
// own side, so the first bend tore the seam open. Every vertex of `parts` within `radius` of the
// line below -> at -> above (three bones' rest joints) is given a parameter u along it (0 at
// `below`, 1 at `at`, 2 at `above`) and blends from the lower side's weights (a body vertex
// keeps its chain weights, a neck vertex takes `at`'s bone) to the upper side's (a neck
// vertex keeps its own, a body vertex takes `at`'s parent) across u = band
for (const Jn of spec.junction ? [spec.junction].flat() : []) {
  const [b0, b1, b2] = [Jn.below, Jn.at, Jn.above].map((n) => bones.get(n));
  if (!b0 || !b1 || !b2) { console.error(`legrig: junction needs bones ${Jn.below}, ${Jn.at}, ${Jn.above}`); process.exit(1); }
  const [p0, p1, p2] = [b0, b1, b2].map((b) => b.userData.rest);
  const [lo, hi] = Jn.band ?? [0.6, 1.4], R = Jn.radius ?? 0.35, upper0 = b1.parent;
  const lowerPart = Jn.parts[1] ?? null; // the chain's part (keeps its own weights below the seam)
  let n = 0;
  for (let i = 0; i < verts.length; i++) {
    if (!Jn.parts.includes(tags[i])) continue;
    const a = along(verts[i], p0, p1), b = along(verts[i], p1, p2);
    const u = a.d <= b.d ? a.t : 1 + b.t;
    if (Math.min(a.d, b.d) > R) continue;
    const w = THREE.MathUtils.smoothstep(u, lo, hi);
    const own = [];
    for (let k = 0; k < 4; k++) if (skinWeight[i * 4 + k] > 0) own.push([boneList[skinIndex[i * 4 + k]], skinWeight[i * 4 + k]]);
    const isLower = tags[i] === lowerPart;
    // (a body vertex ON the ragged seam has chain distance 0, so the chain gave it to the parent)
    const lower = isLower && !own.some(([bn]) => bn === upper0) ? own : [[b1, 1]], upper = isLower ? [[upper0, 1]] : own;
    const m = new Map();
    for (const [bn, x] of lower) m.set(bn, (m.get(bn) ?? 0) + x * (1 - w));
    for (const [bn, x] of upper) m.set(bn, (m.get(bn) ?? 0) + x * w);
    setW(i, [...m].sort((p, q) => q[1] - p[1]).filter((p) => p[1] > 1e-4));
    n++;
  }
  console.log(`junction ${Jn.at}: ${n} vertices blended across the seam`);
}
// the parts were cut out of ONE shell, so a body vertex and a leg vertex can
// share a position along the cut; give every vertex there the limb's weights
// or the seam opens into slivers as soon as the leg moves
{
  // a flanked wing is not welded: its edges were the body's, and the flank copy keeps them
  const limbParts = new Set([...spec.legs.map((l) => l.part), ...(spec.wings ?? []).filter((w) => !w.flank).map((w) => w.part), ...(spec.chains ?? []).map((c) => c.part)]);
  const at = new Map();
  const key = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
  verts.forEach((v, i) => { const k = key(v); if (!at.has(k)) at.set(k, []); at.get(k).push(i); });
  let welded = 0;
  for (const group of at.values()) {
    const limb = group.find((i) => limbParts.has(tags[i]));
    if (limb === undefined || group.every((i) => limbParts.has(tags[i]))) continue;
    for (const i of group) {
      if (limbParts.has(tags[i])) continue;
      skinIndex.set(skinIndex.subarray(limb * 4, limb * 4 + 4), i * 4);
      skinWeight.set(skinWeight.subarray(limb * 4, limb * 4 + 4), i * 4);
      welded++;
    }
  }
  if (welded) console.log(`welded ${welded} seam vertices to their limb's weights`);
}

// smooth normals: tools/_normals.mjs (shared with autorig)

// ---------------------------------------------------------------- mesh object
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.Float32BufferAttribute(verts.flatMap((v) => v.toArray()), 3));
// glTF images are top-left origin; flip the OBJ's v instead of the image
geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs.flatMap(([u, v]) => [u, 1 - v]), 2));
geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
geo.setAttribute("uv1", new THREE.Float32BufferAttribute(partTags.flatMap((t) => [partIndex[t] ?? 0, 0]), 2));
geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
geo.setAttribute("normal", new THREE.Float32BufferAttribute(smoothNormals(verts.flatMap((v) => v.toArray()), spec.crease ?? 100), 3));
const material = new THREE.MeshStandardMaterial({ name: args.creature, color: 0xffffff, roughness: 0.9, metalness: 0 });
let texImage = null;
if (args.texture) {
  const texFile = path.resolve(String(args.texture));
  addTextureSearchRoot(path.dirname(texFile));
  const tex = new THREE.TextureLoader().load(texFile);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  material.map = tex;
  const png = decodePng(fs.readFileSync(texFile));
  texImage = { width: png.width, height: png.height, rgba: png.data };
}
const skeleton = new THREE.Skeleton(boneList);
const mesh = new THREE.SkinnedMesh(geo, material);
mesh.name = args.creature;
mesh.userData.parts = partIndex;
mesh.add(root);
mesh.bind(skeleton);
mesh.frustumCulled = false;

// ---------------------------------------------------------------- posing
// an insect's wing beat needs more keys than a dog's stride: `fps` in the spec
const FPS = spec.fps ?? 30;
const upAxis = V3(0, 1, 0), fwd = V3(0, 0, 1), side = V3(1, 0, 0);
function resetPose() {
  for (const b of boneList) { b.quaternion.identity(); b.scale.set(1, 1, 1); b.position.copy(b.parent?.isBone ? b.userData.rest.clone().sub(b.parent.userData.rest) : b.userData.rest); }
}
const worldQ = (o) => o.getWorldQuaternion(new THREE.Quaternion());
const worldP = (o) => o.getWorldPosition(V3());
/** turn bone `b` so its child at rest offset points along `dir` (world) */
function aim(b, child, dir) {
  const restDir = child.userData.rest.clone().sub(b.userData.rest).normalize();
  const want = new THREE.Quaternion().setFromUnitVectors(restDir, dir.clone().normalize());
  b.quaternion.copy(worldQ(b.parent).invert().multiply(want));
  b.updateMatrixWorld(true);
}
/** two-bone IK: put the leg's foot on `target`, knee bent toward the pole */
function solveLeg(L, target, poleBias = V3(), footPitch = 0) {
  solveLeg2(L, target, poleBias);
  // a cut-off foot keeps its rest attitude to the body's root (flat on the
  // ground in stance), pitched toe-down by `footPitch` through a swing
  if (L.footBone) {
    const want = worldQ(root).multiply(rotAbout(side, footPitch));
    L.footBone.quaternion.copy(worldQ(L.footBone.parent).invert().multiply(want));
    L.footBone.updateMatrixWorld(true);
  }
}
function solveLeg2(L, target, poleBias) {
  L.upper.parent.updateMatrixWorld(true);
  const H = worldP(L.upper);
  const d0 = target.clone().sub(H);
  const d = THREE.MathUtils.clamp(d0.length(), Math.abs(L.a - L.b) + 1e-4, L.a + L.b - 1e-4);
  const dir = d0.normalize();
  const pole = (L.pole === "up" ? V3(0, 1, 0)
    : L.pole === "rest" ? L.poleRest.clone().applyQuaternion(worldQ(L.upper.parent))
    // "body": the knee toward the body's own up and out (`poleDir` [out, up, fwd] in the
    // parent's frame) whatever the body's attitude: a flying insect's folded legs
    : L.pole === "body" ? V3(L.sgn * (L.poleDir?.[0] ?? 0.8), L.poleDir?.[1] ?? 1, L.poleDir?.[2] ?? 0).applyQuaternion(worldQ(L.upper.parent))
    : V3(L.sgn * 0.8, 1, 0)).add(poleBias);
  const perp = pole.sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  const x = (L.a * L.a - L.b * L.b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L.a * L.a - x * x));
  const K = H.clone().add(dir.clone().multiplyScalar(x)).add(perp.multiplyScalar(h));
  const F = H.clone().add(dir.multiplyScalar(d));
  // aim each bone with a whole FRAME — its direction AND the plane the leg bends
  // in — not a minimal rotation of its direction alone: that lets the bone roll
  // about itself as the leg swings, and the roll twists the polygons at the
  // shoulder and the hip (Derek, on the alligator's walk)
  const R0 = REST_OF(L.upper), K0 = REST_OF(L.lower), F0 = REST_OF(L.end);
  const n0 = K0.clone().sub(R0).cross(F0.clone().sub(K0));
  const n = K.clone().sub(H).cross(F.clone().sub(K));
  if (n0.lengthSq() < 1e-12 || n.lengthSq() < 1e-12) {
    aim(L.upper, L.lower, K.clone().sub(H));
    aim(L.lower, L.end, F.clone().sub(K));
    return;
  }
  framed(L.upper, K0.clone().sub(R0), n0, K.clone().sub(H), n);
  framed(L.lower, F0.clone().sub(K0), n0, F.clone().sub(K), n);
}
const REST_OF = (b) => b.userData.rest.clone();
/** rotate bone `b` so (restDir, restNormal) lands on (dir, normal), as world frames */
function framed(b, restDir, restN, dir, n) {
  const frame = (a, m) => {
    const x = a.clone().normalize(), y = m.clone().sub(x.clone().multiplyScalar(m.dot(x))).normalize();
    return new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y));
  };
  const want = new THREE.Quaternion().setFromRotationMatrix(frame(dir, n).multiply(frame(restDir, restN).transpose()));
  b.quaternion.copy(worldQ(b.parent).invert().multiply(want));
  b.updateMatrixWorld(true);
}
const rotAbout = (axis, ang) => new THREE.Quaternion().setFromAxisAngle(axis, ang);

// ---------------------------------------------------------------- clips
/**
 * Bake a clip by calling `pose(t)` at FPS and recording every bone. `pose`
 * resets nothing itself; the frame starts from rest.
 */
function bake(name, duration, pose) {
  const n = Math.max(2, Math.round(duration * FPS) + 1);
  const times = [], q = new Map(boneList.map((b) => [b, []])), rootPos = [];
  const scaled = boneList.filter((b) => b.userData.scaled), sc = new Map(scaled.map((b) => [b, []]));
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1)) * duration;
    resetPose();
    mesh.updateMatrixWorld(true);
    pose(t);
    times.push(t);
    for (const b of boneList) q.get(b).push(...b.quaternion.toArray());
    for (const b of scaled) sc.get(b).push(...b.scale.toArray());
    rootPos.push(...root.position.toArray());
  }
  const tracks = boneList.map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, q.get(b)));
  tracks.push(new THREE.VectorKeyframeTrack("root.position", times, rootPos));
  for (const b of scaled) tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.scale`, times, sc.get(b)));
  return new THREE.AnimationClip(name, duration, tracks);
}
const hub = bones.get(spec.hub);
const trunkBones = sorted.map((s) => bones.get(s.name));
const hubZ = hub.userData.rest.z;

/** wings: `raise` lifts both about the body axis (+ up), `fold` sweeps them back */
function wingPose(raise, fold = 0) {
  for (const W of wings) {
    W.upper.quaternion.multiply(rotAbout(fwd, W.sgn * raise)).multiply(rotAbout(upAxis, -W.sgn * fold));
    W.lower.quaternion.multiply(rotAbout(fwd, W.sgn * raise * 0.6));
  }
}
/**
 * A walker's wings FOLDED (the dragon): `wings[].fold: { upper, lower, n }` are the folded arm's
 * two directions and the membrane's normal in the BODY's frame ([out, up, fwd], out mirrored per
 * side; defaults lay the arm back along the top of the flank and the membrane down over it).
 * `wingFold(k)` slerps each wing from the model's pose (k = 0, a dragon's: raised high) to
 * folded (k = 1); `lift` (rad) then raises the folded wing a little about the body's long axis
 * (a shuffle, a flinch). The model's raised wings flapped and hung in every stride (Derek: wings
 * "FOLDED tight against the body while walking — not flapping or hanging").
 */
const foldQ = new Map();
function wingFoldQ(W) {
  if (foldQ.has(W)) return foldQ.get(W);
  const F = W.spec.fold ?? {};
  const m = (a) => V3(W.sgn * a[0], a[1], a[2]).normalize();
  const dU = m(F.upper ?? [0.22, 0.12, -1]), dL = m(F.lower ?? [0.14, -0.08, -1]), n = m(F.n ?? [1, 0.25, 0]);
  const frame = (a, b) => {
    const x = a.clone().normalize(), y = b.clone().sub(x.clone().multiplyScalar(b.dot(x))).normalize();
    return new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y));
  };
  // world rotations at rest (the parent at rest is unrotated), then the lower one relative to the upper
  const qU = new THREE.Quaternion().setFromRotationMatrix(frame(dU, n).multiply(frame(W.restDir, W.restN).transpose()));
  const qLw = new THREE.Quaternion().setFromRotationMatrix(frame(dL, n).multiply(frame(W.restDir, W.restN).transpose()));
  const out = { upper: qU, lower: qU.clone().invert().multiply(qLw) };
  foldQ.set(W, out);
  return out;
}
function wingFold(k, lift = 0) {
  for (const W of wings) {
    const q = wingFoldQ(W);
    W.upper.quaternion.slerp(q.upper, k).premultiply(rotAbout(fwd, W.sgn * lift));
    W.lower.quaternion.slerp(q.lower, k);
  }
}
/**
 * Dead wings: splayed out over the ground from where the shoulders now are, the arm sloping down
 * to the ground and the outer half lying on it, the membrane flat, top up. `s` slerps from the
 * wing's current pose. Call after the body is posed.
 */
function wingSplay(s, spread = [0.85, -0.55], lie = 0.06) {
  if (s <= 0) return;
  for (const W of wings) {
    const Lu = W.rootP.distanceTo(W.tip) / 2;
    for (const [b, child, isUpper] of [[W.upper, W.lower, true], [W.lower, null, false]]) {
      mesh.updateMatrixWorld(true);
      const P = worldP(b);
      const want = isUpper ? 0.35 : lie; // the elbow just off the ground, the tip on it
      const dy = THREE.MathUtils.clamp((want - P.y) / Lu, -0.95, 0.4);
      const h = V3(W.sgn * spread[0], 0, spread[1] - (isUpper ? 0 : 0.35)).normalize().multiplyScalar(Math.sqrt(1 - dy * dy));
      const dir = h.setY(dy);
      const from = b.quaternion.clone();
      framed(b, W.restDir, W.restN, dir, V3(0, 1, 0));
      b.quaternion.copy(from.slerp(b.quaternion, s));
      b.updateMatrixWorld(true);
    }
  }
}
/** the trunk's lateral wave: each station yaws by a sine travelling tail-ward */
function sway(t, period, amp) {
  if (!amp) return;
  for (const b of trunkBones) {
    if (b === hub) continue;
    const dz = b.userData.rest.z - hubZ;
    const k = dz / (zMax - zMin); // + toward the head, - toward the tail
    const lag = -k * 1.4; // the wave runs head to tail
    const a = amp * (k < 0 ? 0.6 + Math.abs(k) * 1.6 : 0.5);
    b.quaternion.multiply(rotAbout(upAxis, a * Math.sin(2 * Math.PI * (t / period + lag)) * (k < 0 ? 1 : -1)));
  }
  hub.quaternion.premultiply(rotAbout(upAxis, amp * 0.5 * Math.sin((2 * Math.PI * t) / period)));
}
/** a foot's offset along its stride at time t: +1/2 (forward, touching down) .. -1/2 (back, lifting off) */
function legOff(L, g, t) {
  const ph = ((t / g.period + (g.phase?.[L.key] ?? spec.phase[L.key] ?? 0)) % 1 + 1) % 1;
  return ph < g.duty ? 0.5 - ph / g.duty : -0.5 + (ph - g.duty) / (1 - g.duty);
}
/**
 * `girdle` (rad, a sprawler's gait): the trunk bends WITH the legs instead of in a free wave.
 * Each girdle (the bone a leg pair hangs off: chest, hips) yaws so the shoulder of the leg that
 * is reaching forward goes forward with it, and rolls a little (`roll`) onto the leg in stance.
 * With a trot's diagonal pairs that bends the body into the lizard's standing S (shoulders one
 * way, hips the other) and takes a good share of each stride out of the upper leg: without it
 * the free wave turned the shoulders AGAINST the reaching leg and the whole stride came out of
 * the shoulder joint, which twisted and pinched the skin there (Derek, the gators' run). The
 * neck and head turn back against the chest so the head stays on line; the tail swings a beat
 * behind the hips, link by link.
 */
function girdle(t, g) {
  const sm = (x) => Math.sin(THREE.MathUtils.clamp(x, -1, 1) * Math.PI / 2); // a triangle's corners rounded
  const yawOf = new Map(), rollOf = new Map();
  for (const gb of new Set(legs.map((L) => L.upper.parent))) {
    const l = legs.find((L) => L.upper.parent === gb && L.sgn > 0), r = legs.find((L) => L.upper.parent === gb && L.sgn < 0);
    if (!l || !r) continue;
    const s = sm(legOff(l, g, t) - legOff(r, g, t));
    // rotating about +y by a negative angle carries the left (+x) shoulder forward
    yawOf.set(gb, -g.girdle * s * (gb === hub ? (g.hipShare ?? 0.8) : 1));
    rollOf.set(gb, (g.roll ?? 0) * s);
  }
  const hubYaw = yawOf.get(hub) ?? 0;
  hub.quaternion.premultiply(rotAbout(upAxis, hubYaw)).multiply(rotAbout(fwd, rollOf.get(hub) ?? 0));
  // girdles further out along the trunk (the chest): their world yaw, less what the chain above them turned
  let acc = hubYaw;
  for (const b of trunkBones.filter((b) => b.userData.rest.z > hubZ).sort((p, q) => p.userData.rest.z - q.userData.rest.z)) {
    if (yawOf.has(b)) { b.quaternion.multiply(rotAbout(upAxis, yawOf.get(b) - acc)).multiply(rotAbout(fwd, rollOf.get(b) ?? 0)); acc = yawOf.get(b); }
    else { const back = -acc * (b.name === "head" ? 0.5 : 0.7); b.quaternion.multiply(rotAbout(upAxis, back)); acc += back; }
  }
  // the tail: swings behind the hips, each link later and wider
  const tail = tailChain(); // tip .. base
  tail.forEach((b, j) => {
    const fromBase = tail.length - 1 - j;
    b.quaternion.multiply(rotAbout(upAxis, -hubYaw * 0.6 + (g.sway ?? 0) * (0.5 + 0.35 * fromBase) * Math.sin((2 * Math.PI * t) / g.period - 0.9 * (fromBase + 1))));
  });
}
/** foot position for a gait at time t: stance drags it back, swing lifts it forward */
function footAt(L, g, t) {
  const ph = ((t / g.period + (g.phase?.[L.key] ?? spec.phase[L.key] ?? 0)) % 1 + 1) % 1;
  const p = L.foot0.clone();
  let off, lift = 0;
  if (ph < g.duty) off = 0.5 - ph / g.duty; // +1/2 stride -> -1/2
  else {
    const s = (ph - g.duty) / (1 - g.duty);
    off = -0.5 + s;
    lift = Math.sin(Math.PI * s) * g.lift;
  }
  p.z += off * g.stride;
  p.y += lift;
  return p;
}
/**
 * A "quad" body moves with its legs: hips and chest pitch against each other
 * (twice a stride walking, once galloping, the back flexing), the body rolls
 * its weight from side to side, the neck nods against the head so the eyes stay
 * level, and the tail follows a beat behind, link by link.
 */
function quadBody(t, g) {
  const w = (2 * Math.PI * t) / g.period;
  const f = g.gallop ? 1 : 2;
  const chest = bones.get("chest"), neck = bones.get("neck"), head = bones.get("head");
  const tail = sorted.filter((st) => st.pos.z < hubZ).map((st) => bones.get(st.name));
  const P = g.pitch ?? 0.04, R = g.roll ?? 0.03, N = g.nod ?? 0.06;
  hub.quaternion.multiply(rotAbout(side, P * Math.sin(f * w))).multiply(rotAbout(fwd, R * Math.sin(w)));
  chest.quaternion.multiply(rotAbout(side, -P * 1.5 * Math.sin(f * w + 0.8))).multiply(rotAbout(fwd, -R * 1.2 * Math.sin(w)));
  neck.quaternion.multiply(rotAbout(side, N * Math.sin(f * w + 1.6))).multiply(rotAbout(upAxis, R * 0.8 * Math.sin(w + 0.5)));
  head.quaternion.multiply(rotAbout(side, -N * 0.8 * Math.sin(f * w + 2.3)));
  tail.forEach((b, k) => b.quaternion
    .multiply(rotAbout(upAxis, (g.tail ?? 0.08) * (1 + k * 0.45) * Math.sin(w - (k + 1) * 0.75)))
    .multiply(rotAbout(side, 0.03 * Math.sin(f * w - (k + 1) * 0.6))));
}
function gait(name, g) {
  if (spec.plan === "serpent") return serpent.gait(name, g);
  if (spec.plan === "biped") return bipedGait(name, g);
  if (spec.plan === "flyer") return flyGait(name, g);
  const duration = g.period;
  return bake(name, duration, (t) => {
    root.position.y += (g.raise ?? 0) + g.bob * Math.cos(((g.gallop ? 2 : 4) * Math.PI * t) / g.period);
    if (g.girdle && legs.length) girdle(t, g); else sway(t, g.period, g.sway);
    if (spec.plan === "quad") quadBody(t, g);
    sting?.walk(t, g);
    // a walker with wings (the dragon) keeps them folded, shifting a little with the stride
    if (spec.plan === "quad" && wings.length) wingFold(g.wingFold ?? 1, (g.wingLift ?? 0) + (g.wingFlap ?? 0.02) * Math.sin((2 * Math.PI * t) / g.period));
    else wingPose((g.wingLift ?? 0) + (g.wingFlap ?? 0.06) * Math.sin((4 * Math.PI * t) / g.period), 0.15);
    mesh.updateMatrixWorld(true);
    for (const L of legs) solveLeg(L, footAt(L, g, t));
  });
}
const planted = () => { mesh.updateMatrixWorld(true); for (const L of legs) solveLeg(L, L.foot0); };

/** the lowest skinned point of the posed animal */
const tmpV = V3();
// `groundIgnore: [parts]`: parts that never hold the body up when it lies down (the sail, back
// spines, horns): grounding puts the BODY on y = 0 and lets those go through the ground. A gator
// rolled on its back rests on its back, not balanced on the tips of its sail (Derek)
const groundSkip = new Set(spec.groundIgnore ?? []);
function skinnedMinY() {
  mesh.updateMatrixWorld(true);
  let m = Infinity;
  for (let i = 0; i < verts.length; i++) {
    if (groundSkip.has(partTags[i]) || groundSkip.has(tags[i])) continue;
    const y = mesh.applyBoneTransform(i, tmpV.copy(verts[i])).y;
    if (y < m) m = y;
  }
  return m;
}
/** never through the ground; `settle` (0..1) also lowers it onto the ground (a body lying dead) */
function ground(settle = 0) {
  const m = skinnedMinY();
  root.position.y += m < 0 ? -m : -m * settle;
  mesh.updateMatrixWorld(true);
}
/**
 * Turn the body on its OWN centre (2026-10-06, Derek: "shouldn't it be a turn on their center
 * axis instead of the off center roll?"). The root sits on the ground under the body, so a
 * root rotation rolls the animal about a point on the floor and swings it out off its spot.
 * After setting `root.quaternion`, call this: the root moves so the trunk's centre (its long
 * axis through the centroid, at body height) stays where it was; grounding settles it after.
 */
const trunkC = (() => {
  const c = V3();
  for (const i of trunkIdx) c.add(verts[i]);
  return c.divideScalar(Math.max(1, trunkIdx.length)).setX(0);
})();
function pivotRoot(c = trunkC) {
  root.position.add(c.clone().sub(c.clone().applyQuaternion(root.quaternion)));
}
const opt = (n) => bones.get(n) ?? null;
const tailChain = () => sorted.filter((st) => st.pos.z < hubZ).map((st) => bones.get(st.name));
// a contact sheet may show less than the whole clip (one wing beat of an insect)
const sheetSpan = new Map();

// ---------------------------------------------------------------- biped
/**
 * A "biped" (a T-rex) walks on two legs: the weight shifts over the stance
 * foot and the body rolls onto it, the hips yaw with the leg that is forward,
 * the body is highest at mid-stance, and the long tail and the heavy head
 * counter-swing a beat behind. Phases: the left foot's stance starts at its
 * `phase`; the cycle variable `c` is 0 at the left foot's mid-stance.
 */
function bipedCycle(t, g) {
  const Lf = legs.find((L) => L.sgn > 0);
  const phL = g.phase?.[Lf.key] ?? spec.phase[Lf.key] ?? 0;
  return (2 * Math.PI * t) / g.period - 2 * Math.PI * (g.duty / 2 - phL);
}
function bipedBody(t, g) {
  const c = bipedCycle(t, g);
  const S = g.shift ?? 0, R = g.roll ?? 0, Y = g.yaw ?? 0, P = g.pitch ?? 0, N = g.nod ?? 0;
  root.position.x += S * Math.cos(c);
  root.position.y += (g.raise ?? 0) + g.bob * Math.cos(2 * c);
  hub.quaternion
    .multiply(rotAbout(upAxis, Y * Math.sin(c)))
    .multiply(rotAbout(fwd, -R * Math.cos(c)))
    .multiply(rotAbout(side, (g.lean ?? 0) + P * Math.cos(2 * c + 0.6)));
  const chest = opt("chest"), neck = opt("neck"), head = opt("head");
  chest?.quaternion.multiply(rotAbout(upAxis, -Y * 0.45 * Math.sin(c - 0.3))).multiply(rotAbout(fwd, R * 0.4 * Math.cos(c)));
  neck?.quaternion.multiply(rotAbout(upAxis, -Y * 0.4 * Math.sin(c - 0.6))).multiply(rotAbout(side, -(g.lean ?? 0) * 0.5 + N * Math.cos(2 * c + 1.2)));
  head?.quaternion.multiply(rotAbout(side, -(g.lean ?? 0) * 0.4 - N * 0.7 * Math.cos(2 * c + 1.8))).multiply(rotAbout(fwd, R * 0.6 * Math.cos(c)));
  tailChain().forEach((b, k) => b.quaternion
    .multiply(rotAbout(upAxis, (g.tail ?? 0.05) * (1 + k * 0.4) * Math.sin(c - (k + 1) * 0.6)))
    .multiply(rotAbout(side, -(g.lean ?? 0) * 0.25 + 0.025 * Math.cos(2 * c - (k + 1) * 0.7))));
}
/** the foot's toe-down pitch through a swing (rolls off the toes, lands flat) */
function footPitchAt(L, g, t) {
  const ph = ((t / g.period + (g.phase?.[L.key] ?? spec.phase[L.key] ?? 0)) % 1 + 1) % 1;
  if (ph < g.duty) return (g.toe ?? 0) * 0.5 * THREE.MathUtils.smoothstep(ph, g.duty - 0.12, g.duty);
  const s = (ph - g.duty) / (1 - g.duty);
  return (g.toe ?? 0) * (s < 0.3 ? 0.5 + 0.5 * (s / 0.3) : Math.max(0, 1 - (s - 0.3) / 0.55));
}
function bipedGait(name, g) {
  return bake(name, g.period, (t) => {
    bipedBody(t, g);
    mesh.updateMatrixWorld(true);
    // a toe-down foot pitch turns the foot about the ANKLE, which drove the toes (and the claws
    // riding the foot) a quarter metre into the ground at toe-off: lift the ankle by as much
    for (const L of legs) {
      const pitch = footPitchAt(L, g, t), p = footAt(L, g, t);
      const toe = L.footBone && bones.get(`${L.key}.toe`);
      if (toe && pitch > 0) p.y += Math.sin(pitch) * Math.hypot(toe.position.z, toe.position.y);
      solveLeg(L, p, V3(), pitch);
    }
  });
}

// ---------------------------------------------------------------- flyer
/**
 * A "flyer" (bat, raven, dragonfly, hornet): Idle / Walk / Run are flight
 * loops. Each wing is set as a whole FRAME, its root-tip direction and the
 * plane of its membrane: `spread` 0..1 blends from the model's rest wing (a
 * raven's folded along its side, a bat's drooping) to the flight wing, straight
 * out sideways with its top face up; on top of that the wing `flap`s about the
 * body's forward axis, `sweep`s back about its up axis, its outer half (`lower`)
 * flaps further behind the beat, and an insect's wing `twist`s about its own
 * length. `flight`: { hover (m), pitch (rad, + nose down, the body's flight
 * attitude), head (rad, the head's counter-pitch), dead (the wing pose a
 * dead flyer ends in), roll (death roll, rad) }. A gait: { period, beats (whole
 * wing beats in the period), flap (amplitude), lift (mid-stroke offset, +
 * up), lower, sweep, sweepFlap, twist, glide (the share of the period spent
 * gliding, wings held), bob (m), pitch, pitchBeat, roll, tailBeat, speed }.
 */
const FL = spec.flight ?? {};
function flyWing(W, p) {
  const Qp = worldQ(W.upper.parent);
  // the flight frame in the parent's frame, undoing the body's flight attitude
  const att = rotAbout(side, -(FL.pitch ?? 0));
  const fDir = V3(W.sgn, 0, 0).applyQuaternion(att), fN = V3(0, 1, 0).applyQuaternion(att);
  const frame = (a, m) => {
    const x = a.clone().normalize(), y = m.clone().sub(x.clone().multiplyScalar(m.dot(x))).normalize();
    return new THREE.Matrix4().makeBasis(x, y, x.clone().cross(y));
  };
  const qs = new THREE.Quaternion().setFromRotationMatrix(frame(fDir, fN).multiply(frame(W.restDir, W.restN).transpose()));
  const base = new THREE.Quaternion().slerp(qs, p.spread ?? 1);
  const fwdL = V3(0, 0, 1).applyQuaternion(att), upL = V3(0, 1, 0).applyQuaternion(att);
  const q = rotAbout(fwdL, W.sgn * (p.flap ?? 0)).multiply(rotAbout(upL, W.sgn * (p.sweep ?? 0))).multiply(base);
  const dir = W.restDir.clone().applyQuaternion(q);
  const n = W.restN.clone().applyQuaternion(q).applyAxisAngle(dir, W.sgn * (p.twist ?? 0));
  framed(W.upper, W.restDir, W.restN, dir.clone().applyQuaternion(Qp), n.clone().applyQuaternion(Qp));
  const ql = rotAbout(fwdL, W.sgn * (p.lower ?? 0));
  framed(W.lower, W.restDir, W.restN, dir.applyQuaternion(ql).applyQuaternion(Qp), n.applyQuaternion(ql).applyQuaternion(Qp));
}
/** where a gait's wing beat is at time t: phi (null while gliding) */
function beatPhase(g, t, offset = 0) {
  const u = (((t / g.period) % 1) + 1) % 1, glide = g.glide ?? 0;
  if (glide && u >= 1 - glide) return { phi: null, s: (u - (1 - glide)) / glide };
  return { phi: 2 * Math.PI * ((g.beats ?? 1) * u / (1 - glide) + offset) };
}
function wingBeat(g, t, W) {
  const { phi, s } = beatPhase(g, t, W?.phase ?? 0);
  if (phi === null) // a glide: wings held a little above level, barely moving
    return { spread: 1, flap: (g.lift ?? 0) + 0.04 * Math.sin(Math.PI * s), sweep: g.sweep ?? 0, lower: 0.03 * Math.sin(Math.PI * s), twist: 0 };
  // a quicker downstroke than upstroke: the phase runs faster through the bottom
  const sk = phi + (g.skew ?? 0) * Math.sin(phi);
  return {
    spread: 1,
    flap: (g.lift ?? 0) + (g.flap ?? 0.6) * Math.sin(sk),
    sweep: (g.sweep ?? 0) + (g.sweepFlap ?? 0) * Math.cos(sk),
    lower: (g.lower ?? 0) * Math.sin(sk - 0.9),
    twist: (g.twist ?? 0) * Math.cos(sk),
  };
}
function mixWing(a, b, k) {
  const o = {};
  for (const key of ["spread", "flap", "sweep", "lower", "twist"]) o[key] = (a[key] ?? 0) * (1 - k) + (b[key] ?? (key === "spread" ? 1 : 0)) * k;
  return o;
}
/** the flying body: hovering height and bob with the beats, attitude, head held level, tail, legs tucked */
function flyBody(t, g, extraPitch = 0) {
  const { phi } = beatPhase(g, t);
  const y = phi === null ? -(g.bob ?? 0) * Math.sin(2 * Math.PI * (g.beats ?? 1) - 0.4) : -(g.bob ?? 0) * Math.sin(phi - 0.4);
  root.position.y += (FL.hover ?? 0) + y;
  const pb = phi === null ? 0 : (g.pitchBeat ?? 0) * Math.cos(phi);
  root.quaternion.copy(rotAbout(side, (FL.pitch ?? 0) + (g.pitch ?? 0) + pb + extraPitch))
    .multiply(rotAbout(fwd, (g.roll ?? 0) * Math.sin((2 * Math.PI * t) / g.period)));
  opt("head")?.quaternion.multiply(rotAbout(side, (FL.head ?? 0) - 0.6 * ((g.pitch ?? 0) + pb)));
  tailChain().forEach((b, k) => b.quaternion.multiply(rotAbout(side, (g.tailBeat ?? 0) * (phi === null ? 0 : Math.sin(phi - (k + 1) * 0.7)))));
  // an insect's abdomen / a dragonfly's long tail, alive: held curled (`curl`, rad
  // per link, + down), pumping (`pump` rad, `pumps` per period) and swaying
  // (`tailSway` rad, `sways` per period), each link a little behind the last
  if (g.curl || g.pump || g.tailSway) {
    const tc = tailChain(), w = (2 * Math.PI * t) / g.period;
    tc.forEach((b, k) => {
      const j = tc.length - k; // 1 at the link next to the hub
      b.quaternion
        .multiply(rotAbout(side, -(g.curl ?? 0) - (g.pump ?? 0) * Math.sin((g.pumps ?? 1) * w - 0.7 * j)))
        .multiply(rotAbout(upAxis, (g.tailSway ?? 0) * Math.sin((g.sways ?? 1) * w - 0.8 * j)));
    });
  }
  for (const L of legs) if (L.tuck) {
    L.upper.quaternion.multiply(rotAbout(side, L.tuck[0]));
    L.lower.quaternion.multiply(rotAbout(side, L.tuck[1]));
  }
}
/**
 * A flying insect's legs (`fold` on a leg: [out, up, fwd] of the foot from the
 * leg's root, in the body's frame, in leg lengths): folded up under the thorax
 * by IK, the knee toward the body's up (`pole: "body"`), dangling a little
 * (`legSwing` leg lengths, `legSwings` per period, each pair behind the last).
 * `mix` [fold, k] blends toward another fold (the bite's grab, the dead curl).
 */
function foldTarget(L, f, sw) {
  const P = L.upper.parent, len = L.a + L.b;
  const p = L.upper.userData.rest.clone().add(V3(L.sgn * f[0], f[1] + 0.35 * sw, f[2] + sw).multiplyScalar(len));
  return p.sub(P.userData.rest).applyMatrix4(P.matrixWorld);
}
function flyLegs(t, g, mix = null, swingScale = 1) {
  for (const L of legs) {
    if (!L.fold) continue;
    let f = L.fold;
    if (mix?.[0]?.(L)) { const m = mix[0](L), k = mix[1]; f = f.map((v, i) => v * (1 - k) + m[i] * k); }
    const sw = swingScale * (g.legSwing ?? 0) * Math.sin((2 * Math.PI * (g.legSwings ?? 1) * t) / g.period - 0.9 * L.n - (L.sgn > 0 ? 0 : 0.5));
    solveLeg(L, foldTarget(L, f, sw));
  }
}
function flyGait(name, g) {
  const clip = bake(name, g.period, (t) => {
    flyBody(t, g);
    mesh.updateMatrixWorld(true);
    flyLegs(t, g);
    for (const W of wings) flyWing(W, wingBeat(g, t, W));
  });
  // six frames spread over several whole beats all land on the same phase:
  // the sheet shows one beat (or the whole beat-and-glide cycle)
  sheetSpan.set(clip, g.sheet ?? (g.glide ? g.period : g.period / (g.beats ?? 1)));
  return clip;
}

// ---------------------------------------------------------------- scorpion
/**
 * `sting` (an arachnid with a `chains` tail and `chains` arms: the scorpion).
 * { tail: chain name (default "tail"), arms: chain name ("claw"), reach (m past
 * the body's front where the stinger lands), height (m, the stinger's height
 * there), body: the part whose front and belly are measured (trunk[0]) }.
 * The strike pose is SOLVED, not keyed: the tail swings up and over from its
 * base (`w`, most at the base) while its end hooks the stinger down (`v`), the
 * two amounts searched so the stinger's tip lands at the target. A chain bends
 * about its bones' own side axis (the tail lies in the body's mid plane).
 */
const ss = (x, a, b) => THREE.MathUtils.smootherstep(x, a, b);
/** aim a chain's links down onto the ground one by one, base to tip (a limp tail,
 * a dead claw): each link keeps the last one's heading turned by `yawStep` and
 * drops its far end to the chain's own radius; `k` blends from the current pose */
function flatten(c, k, yawStep = 0) {
  if (k <= 0) return;
  const all = [...c.bones, c.end];
  let heading = null;
  for (let j = 0; j < c.bones.length; j++) {
    const b = c.bones[j], child = all[j + 1];
    mesh.updateMatrixWorld(true);
    const P = worldP(b), C = worldP(child), len = C.distanceTo(P);
    const cur = C.sub(P).normalize();
    if (!heading) {
      heading = V3(cur.x, 0, cur.z);
      if (heading.lengthSq() < 1e-6) heading.set(0, 0, -1);
      heading.normalize();
    } else heading.applyAxisAngle(upAxis, yawStep);
    const vy = THREE.MathUtils.clamp((c.radius - P.y) / len, -0.95, 0.95);
    const want = heading.clone().multiplyScalar(Math.sqrt(1 - vy * vy)).add(V3(0, vy, 0));
    aim(b, child, cur.lerp(want, k).normalize());
  }
}
function makeSting() {
  const S = spec.sting;
  const tc = chains.find((c) => c.key === (S.tail ?? "tail"));
  const arms = chains.filter((c) => c.spec.name === (S.arms ?? "claw"));
  if (!tc) { console.error(`legrig: sting needs a chain named ${S.tail ?? "tail"}`); process.exit(1); }
  const N = tc.bones.length;
  const bend = (d) => tc.bones.forEach((b, k) => b.quaternion.multiply(rotAbout(side, d[k] ?? 0)));
  const w = tc.bones.map((_, k) => 1 - 0.5 * k / Math.max(1, N - 1));
  const v = tc.bones.map((_, k) => (k / Math.max(1, N - 1)) ** 2);
  // cocked: the base rears the tail more upright, the end draws the stinger back
  const cockShape = tc.bones.map((_, k) => 0.35 - 0.85 * k / Math.max(1, N - 1));
  const bodyIdx = verts.map((_, i) => i).filter((i) => tags[i] === (S.body ?? spec.trunk[0]));
  const front = Math.max(...bodyIdx.map((i) => verts[i].z));
  const belly = Math.min(...bodyIdx.map((i) => verts[i].y));
  const T = V3(0, S.height ?? 0.12, front + (S.reach ?? 0.2));
  // the body strikes too: it lunges (`lunge` m), pitches nose down (`pitch` rad)
  // and arches, the abdomen lifting the tail's base (`rear` rad); the tail is
  // solved WITH that pose, so the stinger lands on a target fixed in the world
  const abdomen = tc.bones[0].parent;
  const strikeBody = (h, cock = 0) => {
    root.position.z += -0.03 * cock + (S.lunge ?? 0.06) * h;
    root.position.y -= 0.01 * h;
    root.quaternion.copy(rotAbout(side, -0.07 * cock + (S.pitch ?? 0.1) * h));
    abdomen.quaternion.multiply(rotAbout(side, 0.08 * cock + (S.rear ?? 0.2) * h));
  };
  const tipFor = (a, b) => { resetPose(); strikeBody(1); bend(w.map((x, k) => a * x + b * v[k])); mesh.updateMatrixWorld(true); return worldP(tc.end); };
  let best = [0, 0, Infinity];
  for (let a = 0; a <= 3.2; a += 0.04) for (let b = -3; b <= 2.5; b += 0.04) {
    const d = tipFor(a, b).distanceTo(T);
    if (d < best[2]) best = [a, b, d];
  }
  resetPose(); mesh.updateMatrixWorld(true);
  const [A, Bv] = best;
  console.log(`sting: strike lands ${best[2].toFixed(3)} m from ${fmt(T)} (swing ${A.toFixed(2)}, hook ${Bv.toFixed(2)})`);
  const strikeShape = w.map((x, k) => A * x + Bv * v[k]);
  /** the tail: `cock` 0..1, `strike` per link (a function of the link index: the base leads) */
  const tail = (cock, strike) => bend(tc.bones.map((_, k) => cockShape[k] * cock + strikeShape[k] * strike(k)));
  /** an arm: `yaw` + spreads it out, `lift` + raises it, `snap` + flicks the pincer in */
  const arm = (c, yaw, lift, snap) => {
    c.bones[0].quaternion.multiply(rotAbout(upAxis, c.sgn * yaw)).multiply(rotAbout(side, -lift));
    if (c.bones.length > 2) c.bones[1].quaternion.multiply(rotAbout(upAxis, c.sgn * yaw * 0.5));
    c.bones.at(-1).quaternion.multiply(rotAbout(upAxis, -c.sgn * snap));
  };
  // one strike's curve for a link: up and over fast, held in, pulled back with a recoil
  const strikeCurve = (x, at, hold = 0.12, back = 0.4) =>
    x < at - 0.15 ? 0 : x < at ? ss(x, at - 0.15, at) : x < at + hold ? 1
      : 1 - ss(x, at + hold, at + hold + back) - 0.12 * Math.sin(Math.PI * THREE.MathUtils.clamp((x - at - hold) / back, 0, 1));
  const cockCurve = (x, at) => (x < at - 0.15 ? ss(x, at - 0.45, at - 0.17) : Math.max(0, 1 - (x - at + 0.15) / 0.12));
  const lag = 0.02;
  return {
    idle(t, period) {
      const wv = (2 * Math.PI * t) / period;
      tc.bones.forEach((b, k) => b.quaternion
        .multiply(rotAbout(side, 0.04 * Math.sin(wv - 0.6 * k)))
        .multiply(rotAbout(upAxis, 0.05 * Math.sin(wv + 1 - 0.5 * k))));
      for (const c of arms) arm(c, 0.05 * Math.sin(wv + c.sgn), 0.03 * Math.sin(2 * wv + c.sgn), 0.35 * Math.max(0, Math.sin(2 * wv + (c.sgn > 0 ? 0 : 2))) ** 6);
    },
    walk(t, g) {
      const wv = (2 * Math.PI * t) / g.period;
      tc.bones.forEach((b, k) => b.quaternion
        .multiply(rotAbout(side, 0.03 * Math.sin(2 * wv - 0.7 * k)))
        .multiply(rotAbout(upAxis, 0.05 * Math.sin(wv - 0.6 * k))));
      for (const c of arms) arm(c, 0.04 * Math.sin(wv + (c.sgn > 0 ? 0 : Math.PI)), 0.02 * Math.sin(2 * wv), 0);
    },
    clips() {
      // Bite: the tail STRIKE. Cock the tail and spread the claws, then whip the
      // tail up and over the back, the stinger stabbing down past the head (the
      // hit at ~45%), held in, pulled back out with a recoil; the claws close on it
      clips.push(bake("Bite", 1.1, (t) => {
        const u = t / 1.1;
        const cock = cockCurve(u, 0.45), hit = strikeCurve(u, 0.45);
        strikeBody(hit, cock);
        tail(cock, (k) => strikeCurve(u - lag * (k - (N - 1) / 2), 0.45));
        for (const c of arms) arm(c, 0.22 * cock - 0.1 * hit, 0.12 * cock, 0.45 * ss(u, 0.42, 0.5) * (1 - ss(u, 0.75, 0.95)));
        planted();
      }));
      // Heavy: the claws seize (spread, lunge, snap shut and hold), then the
      // tail drives the sting into what they hold, twice
      clips.push(bake("Heavy", 1.7, (t) => {
        const u = t / 1.7;
        const spread = ss(u, 0, 0.18) * (1 - ss(u, 0.2, 0.3));
        const grab = ss(u, 0.2, 0.3) * (1 - ss(u, 0.85, 1));
        const cock = cockCurve(u, 0.5);
        const hit = Math.max(strikeCurve(u, 0.5, 0.06, 0.12), strikeCurve(u, 0.72, 0.08, 0.25));
        strikeBody(hit, cock);
        root.position.z += -0.04 * spread + 0.03 * grab;
        tail(cock, (k) => Math.max(strikeCurve(u - lag * (k - (N - 1) / 2), 0.5, 0.06, 0.12), strikeCurve(u - lag * (k - (N - 1) / 2), 0.72, 0.08, 0.25)));
        for (const c of arms) arm(c, 0.35 * spread - 0.22 * grab, 0.18 * spread + 0.06 * grab, 0.55 * grab);
        planted();
      }));
      // Pinch: the claws snap, one then the other
      clips.push(bake("Pinch", 0.8, (t) => {
        const u = t / 0.8;
        root.position.z += 0.03 * Math.sin(Math.PI * u);
        for (const c of arms) {
          const at = c.sgn > 0 ? 0.3 : 0.55;
          const reach = Math.exp(-(((u - at) / 0.14) ** 2));
          const snap = ss(u, at - 0.03, at + 0.03) * (1 - ss(u, at + 0.12, at + 0.25));
          arm(c, 0.25 * reach * (1 - snap) - 0.18 * snap, 0.12 * reach, 0.9 * snap);
        }
        tc.bones.forEach((b, k) => b.quaternion.multiply(rotAbout(side, 0.05 * Math.sin(2 * Math.PI * u - 0.6 * k))));
        planted();
      }));
      // Death: a spasm (tail jerks up, claws flail), the legs give and splay, it
      // settles belly-down tipped onto one side, and the tail and the claws fall
      // limp ALONG the ground, the legs curling in last. Never onto its back: a
      // scorpion on its back would rest on its own raised tail
      clips.push(bake("Death", 1.6, (t) => {
        const u = t / 1.6;
        const spasm = u < 0.3 ? Math.sin(Math.PI * u / 0.3) : 0;
        const fall = ss(u, 0.1, 0.5), limp = ss(u, 0.2, 0.8), curl = ss(u, 0.5, 1);
        root.quaternion.copy(rotAbout(fwd, (S.deathRoll ?? 0.18) * fall)).multiply(rotAbout(side, -0.08 * spasm));
        pivotRoot();
        root.position.y -= belly * fall;
        tail(0.7 * spasm, () => 0);
        for (const c of arms) arm(c, 0.3 * spasm, 0.2 * spasm, 0.5 * spasm);
        mesh.updateMatrixWorld(true);
        flatten(tc, limp, S.tailLimp ?? 0.18);
        for (const c of arms) flatten(c, limp, c.sgn * 0.12);
        mesh.updateMatrixWorld(true);
        for (const L of legs) {
          const p = L.foot0.clone();
          p.x *= 1 + 0.18 * fall - 0.3 * curl;
          p.z += 0.04 * fall * Math.sign(p.z);
          p.y += 0.04 * curl;
          solveLeg(L, p);
        }
        ground(ss(u, 0.5, 0.75));
      }));
    },
  };
}
const sting = spec.sting ? makeSting() : null;

// ---------------------------------------------------------------- serpent
/**
 * `plan: "serpent"` (the cobra): a legless body that lies on the ground as one
 * `chains` part (`serpent.body`, default "body": many bones down its own
 * curve, base at the raised neck) and an upright front (trunk stations pinned
 * up the neck: chest -> neck -> head, a `hood` that spreads).
 *
 * The body is never keyed bone by bone: every clip says where the body's
 * CENTRE LINE lies, as a world polyline, and `follow` lays the chain along it
 * from the base, link by link at its own length, each link turned with a
 * level frame (belly down, never rolled). So:
 *  - Idle / Bite / Hit keep the model's coil where it lies (the rest line);
 *    a lunge pulls the body along its own line, never sideways.
 *  - Walk / Run are a SERPENTINE: the line is a sine track fixed to the ground
 *    that scrolls back at exactly the clip speed, so every bit of the body
 *    passes through the same points the head did: the wave travels back as the
 *    snake moves forward and nothing slides sideways. stride = the track's
 *    wavelength, `amp` its half-width; the front third stays raised, swaying.
 *  - Death: the raised front collapses onto the ground beside the coil
 *    (`serpent.deathDir` [x, z], the way it falls), the coil stays put.
 */
function makeSerpent() {
  const S = spec.serpent ?? {};
  const c = chains.find((ch) => ch.key === (S.body ?? "body"));
  if (!c) { console.error(`legrig: a serpent needs a chain named ${S.body ?? "body"}`); process.exit(1); }
  const all = [...c.bones, c.end];
  const rest = all.map((b) => b.userData.rest.clone());
  const N = c.bones.length;
  const segLen = c.bones.map((_, j) => rest[j].distanceTo(rest[j + 1]));
  const arc = [0];
  for (const l of segLen) arc.push(arc.at(-1) + l);
  // the lying body's centre height (its radius); the links from the base down to the
  // first joint at about that height are the rise up to the neck
  const ys = rest.slice(1).map((p) => p.y).sort((a, b) => a - b);
  const lieR = ys[Math.floor(ys.length / 2)];
  let jG = 1;
  while (jG < N && rest[jG].y > 1.6 * lieR) jG++;
  const lieAt = (s) => {
    const k = arc.findIndex((a) => a > s);
    if (k < 0) return Math.min(rest[N].y, lieR);
    const f = (s - arc[k - 1]) / (arc[k] - arc[k - 1]);
    return Math.min(lieR, rest[k - 1].y * (1 - f) + rest[k].y * f);
  };
  const chest = bones.get(spec.hub), neck = opt("neck"), head = opt("head"), hood = opt(spec.hood?.bone ?? "hood");
  const flare = (k) => hood?.scale.set(1 + k, 1, 1 + 0.15 * k);
  const up = V3(0, 1, 0);
  console.log(`serpent: body ${arc[N].toFixed(2)} m in ${N} links, lying at ${lieR.toFixed(3)} m, rise to the neck ${arc[jG].toFixed(2)} m (${jG} links)`);

  /** link j's direction, level-framed (belly down) */
  function aimFlat(j, dir) {
    const restDir = rest[j + 1].clone().sub(rest[j]).normalize(), d = dir.clone().normalize();
    if (Math.abs(restDir.y) > 0.995 || Math.abs(d.y) > 0.995) return aim(c.bones[j], all[j + 1], d);
    framed(c.bones[j], restDir, up, d, up);
  }
  /** lay the body along a world polyline, from the base (where the chest put it), link by link */
  function follow(line) {
    // densified, so a link end never has to land exactly on a corner of a coarse line
    const path = [line[0]];
    for (let k = 1; k < line.length; k++) {
      const n = Math.max(1, Math.ceil(line[k].distanceTo(line[k - 1]) / 0.02));
      for (let i = 1; i <= n; i++) path.push(line[k - 1].clone().lerp(line[k], i / n));
    }
    mesh.updateMatrixWorld(true);
    let P = worldP(c.bones[0]), seg = 0;
    for (let j = 0; j < N; j++) {
      const len = segLen[j];
      let Q = null;
      // the first point further along the line that is a link's length away: the first
      // segment that crosses out of the link's sphere
      for (; seg < path.length - 1; seg++) {
        const A = path[seg], B = path[seg + 1];
        if (A.distanceTo(P) > len + 1e-3 || B.distanceTo(P) < len - 1e-3) continue;
        const d = B.clone().sub(A), f = A.clone().sub(P), a = d.dot(d);
        if (a < 1e-14) continue;
        const b = 2 * f.dot(d), cc = f.dot(f) - len * len;
        const t = THREE.MathUtils.clamp((-b + Math.sqrt(Math.max(0, b * b - 4 * a * cc))) / (2 * a), 0, 1);
        Q = A.clone().addScaledVector(d, t);
        break;
      }
      // past the end of the line: carry straight on
      if (!Q) { const n = path.length; Q = P.clone().addScaledVector(path[n - 1].clone().sub(path[n - 2]).normalize(), len); }
      // the last `serpent.stiffTip` links keep their modelled bend (a hooked tail tip: pulled
      // straight along a track, its skin stretched to spikes)
      if (j >= N - (S.stiffTip ?? 0)) { c.bones[j].quaternion.identity(); c.bones[j].updateMatrixWorld(true); }
      else aimFlat(j, Q.clone().sub(P));
      P = worldP(all[j + 1]);
    }
  }
  /** the coil where it lies, from wherever the base is now; the tail's end swung by `flick` rad */
  function restLine(flick = 0) {
    mesh.updateMatrixWorld(true);
    const pts = [worldP(c.bones[0]), ...rest.slice(1).map((p) => p.clone())];
    const pv = Math.max(jG + 1, N - 5);
    for (let j = pv + 1; j <= N; j++) pts[j] = pts[j].sub(rest[pv]).applyAxisAngle(up, flick * (j - pv) / (N - pv)).add(rest[pv]);
    return pts;
  }
  /**
   * the coil stays planted and only the front `serpent.anchor` links (default 6) give: they
   * reach from wherever the base is now to rest joint `anchor` (FABRIK, every link its own
   * length, kept off the ground), so a lunge or a recoil bends the front of the body instead
   * of dragging the whole snake along its line. Out of reach, the body slides along its line.
   */
  let unreached = 0;
  function anchored(line = restLine()) {
    const m = Math.min(S.anchor ?? 6, N - 1);
    const P0 = line[0], T = line[m];
    const total = segLen.slice(0, m).reduce((a, b) => a + b, 0);
    if (P0.distanceTo(T) >= total * 0.999) { unreached++; return follow(line); }
    const J = line.slice(0, m + 1).map((p) => p.clone());
    const floor = (j) => Math.min(rest[j].y, lieR);
    for (let it = 0; it < 40; it++) {
      J[m].copy(T);
      for (let j = m - 1; j >= 0; j--) J[j] = J[j + 1].clone().add(J[j].clone().sub(J[j + 1]).setLength(segLen[j]));
      J[0].copy(P0);
      for (let j = 1; j <= m; j++) {
        J[j] = J[j - 1].clone().add(J[j].clone().sub(J[j - 1]).setLength(segLen[j - 1]));
        if (j < m) J[j].y = Math.max(J[j].y, floor(j));
      }
    }
    follow([...J, ...line.slice(m + 1)]);
  }
  const x0 = S.centre ?? rest[0].x;
  /** the serpentine track: rise from the base to the ground, then the sine track scrolling back */
  function track(g, t) {
    const v = g.stride / g.period, k = (2 * Math.PI) / g.stride;
    const X = (z) => x0 + g.amp * Math.sin(k * (z + v * t));
    mesh.updateMatrixWorld(true);
    const B = worldP(c.bones[0]);
    const rise = arc[jG], h = B.y - lieR;
    const run = Math.sqrt(Math.max(0.04 * rise * rise, rise * rise - h * h)) * 0.9;
    const zG = B.z - run;
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      const z = B.z - run * s;
      pts.push(V3(X(z) + (B.x - X(B.z)) * (1 - ss(s, 0, 1)), lieR + h * (1 + Math.cos(Math.PI * s)) / 2, z));
    }
    let s = rise;
    for (let z = zG - 0.02; s < arc[N] + 1; z -= 0.02) {
      const p = V3(X(z), lieAt(s), z);
      s += p.distanceTo(pts.at(-1));
      p.y = lieAt(s);
      pts.push(p);
    }
    return { pts, X, zG };
  }
  return {
    gait(name, g) {
      const lean = g.lean ?? 0;
      return bake(name, g.period, (t) => {
        const w = (2 * Math.PI * t) / g.period;
        const v = g.stride / g.period, k = (2 * Math.PI) / g.stride;
        // the neck rides the track (the head made it), the head counter-turns to keep looking ahead
        const sx = g.amp * Math.sin(k * (rest[0].z + v * t));
        root.position.x += sx * (g.ride ?? 0.7);
        root.position.y += (g.bob ?? 0.01) * Math.sin(2 * w);
        const yaw = -Math.atan(g.amp * k * Math.cos(k * (rest[0].z + v * t))) * 0.5;
        chest.quaternion.multiply(rotAbout(side, lean)).multiply(rotAbout(upAxis, yaw)).multiply(rotAbout(fwd, -0.6 * sx));
        neck?.quaternion.multiply(rotAbout(side, -0.3 * lean)).multiply(rotAbout(fwd, 0.5 * sx)).multiply(rotAbout(upAxis, -0.5 * yaw));
        head?.quaternion.multiply(rotAbout(side, -0.7 * lean + 0.03 * Math.sin(2 * w))).multiply(rotAbout(upAxis, -0.5 * yaw)).multiply(rotAbout(fwd, 0.4 * sx));
        flare(g.flare ?? 0);
        follow(track(g, t).pts);
      });
    },
    clips() {
      // Idle: coiled, the hood up and swaying, the head counter-turning to stay level, breathing, the tail tip flicks
      clips.push(bake("Idle", 4, idlePose = (t) => {
        const w = (2 * Math.PI * t) / 4;
        chest.quaternion.multiply(rotAbout(fwd, 0.09 * Math.sin(w))).multiply(rotAbout(upAxis, 0.1 * Math.sin(w + 0.4))).multiply(rotAbout(side, 0.03 * Math.sin(2 * w)));
        neck?.quaternion.multiply(rotAbout(fwd, 0.07 * Math.sin(w - 0.5))).multiply(rotAbout(upAxis, 0.08 * Math.sin(w - 0.2)));
        head?.quaternion.multiply(rotAbout(fwd, -0.12 * Math.sin(w - 0.9))).multiply(rotAbout(upAxis, 0.1 * Math.sin(w - 0.8))).multiply(rotAbout(side, -0.04 * Math.sin(2 * w + 1)));
        flare(0.04 + 0.04 * Math.sin(2 * w));
        follow(restLine(0.2 * Math.sin(w * 2) * Math.max(0, Math.sin(w))));
      }));
      // one strike: coil back (the S drawn, the hood spread), a fast lunge forward and down, the bite
      // at `at`, held a beat, back up. Returns the pose for 0..1 of its own span
      const strikePose = (u, at, reach = 1) => {
        const back = ss(u, at - 0.42, at - 0.14) * (1 - ss(u, at - 0.14, at - 0.04));
        const hit = ss(u, at - 0.14, at) * (1 - ss(u, at + 0.12, at + 0.5));
        return { back, hit: hit * reach };
      };
      const strike = ({ back, hit }, sp = 1) => {
        root.position.z += -0.12 * back + 0.45 * hit;
        root.position.y += 0.04 * back - 0.14 * hit;
        chest.quaternion.multiply(rotAbout(side, -0.22 * back + 0.62 * hit)).multiply(rotAbout(upAxis, 0.05 * sp * back));
        neck?.quaternion.multiply(rotAbout(side, -0.55 * back + 0.5 * hit));
        head?.quaternion.multiply(rotAbout(side, 0.7 * back - 0.8 * hit));
      };
      // Bite: the strike lands at 45%
      clips.push(bake("Bite", 1.0, (t) => {
        const u = t / 1.0;
        strike(strikePose(u, 0.45));
        flare(0.35 * ss(u, 0, 0.25) * (1 - ss(u, 0.65, 1)));
        anchored();
      }));
      // Heavy: two strikes, the second further
      clips.push(bake("Heavy", 1.5, (t) => {
        const u = t / 1.5;
        const a = strikePose(u, 0.35, 0.8), b = strikePose(u, 0.7, 1.15);
        strike({ back: Math.max(a.back, b.back), hit: Math.max(a.hit, b.hit) }, -1);
        flare(0.4 * ss(u, 0, 0.2) * (1 - ss(u, 0.8, 1)));
        anchored();
      }));
      // Hit / Hit_Heavy: the hood is knocked back and spreads, the head jerks up a beat later,
      // the heavy one twists away and shakes the head; the coil stays where it lies
      const env = (u, peak, hold) => (u <= 0 ? 0 : u < peak ? Math.sin((Math.PI / 2) * (u / peak)) : u < hold ? 1 : 1 - ss(u, hold, 1));
      const hitClip = (name, dur, k) => bake(name, dur, (t) => {
        const u = t / dur, e = env(u, k.peak, k.hold), eh = env(u - 0.06, k.peak, k.hold - 0.06);
        const shake = k.shake * (u > 0.25 && u < 0.85 ? Math.sin(Math.PI * (u - 0.25) / 0.6) ** 2 : 0) * Math.sin(2 * Math.PI * 4 * u);
        idlePose(t);
        root.position.z -= k.back * e;
        chest.quaternion.premultiply(rotAbout(side, -k.pitch * e)).multiply(rotAbout(upAxis, k.twist * e)).multiply(rotAbout(fwd, k.roll * e));
        neck?.quaternion.multiply(rotAbout(side, -k.neck * eh));
        head?.quaternion.multiply(rotAbout(side, -k.head * eh)).multiply(rotAbout(upAxis, shake));
        flare(0.04 + k.flare * e);
        anchored(restLine(k.tail * e * Math.sin(2 * Math.PI * 2 * u)));
      });
      clips.push(hitClip("Hit", 0.4, { peak: 0.15, hold: 0.3, back: 0.06, pitch: 0.22, twist: 0.12, roll: 0.06, neck: 0.25, head: 0.3, shake: 0, flare: 0.2, tail: 0.25 }));
      clips.push(hitClip("Hit_Heavy", 0.9, { peak: 0.12, hold: 0.45, back: 0.12, pitch: 0.3, twist: 0.25, roll: 0.15, neck: 0.3, head: 0.22, shake: 0.3, flare: 0.35, tail: 0.4 }));
      // Death: rears back and thrashes, then the raised front topples onto the ground beside the coil
      // and lies along it, the head last, rolled a little onto its side; the hood folds; the tail twitches out
      {
        const dd = V3((S.deathDir ?? [1, 0])[0], 0, (S.deathDir ?? [1, 0])[1]).normalize();
        // the base link comes down onto the ground from where the coil starts, laid toward `dd` too, so the
        // neck carries straight on out of it (laid any other way, the seam folds and tears)
        const Bdead = rest[1].clone().addScaledVector(dd, segLen[0] * 0.95).setY(S.deathBase ?? lieR);
        const rootDead = Bdead.clone().sub(rest[0]);
        const trunkMinY = () => { mesh.updateMatrixWorld(true); let m = Infinity; for (const i of trunkIdx) m = Math.min(m, mesh.applyBoneTransform(i, tmpV.copy(verts[i])).y); return m; };
        // the dead attitudes: each piece's long axis along the ground toward `dd` (bent a little
        // more at each joint), the belly (+z at rest) down, the head rolled `deathRoll`
        resetPose(); root.position.copy(rootDead); mesh.updateMatrixWorld(true);
        const lay = (b, child, restN, dir, n) => framed(b, child.userData.rest.clone().sub(b.userData.rest), restN, dir, n);
        // `deathBend` turns each joint further round (rad); `deathPitch` [chest, neck, head] tips each
        // piece up (+) or down (-): a neck can cross back over its own coil and the head drop beyond it
        const bend = S.deathBend ?? 0.35, [p1, p2, p3] = S.deathPitch ?? [-0.08, -0.08, -0.15];
        const dirAt = (k, p) => dd.clone().applyAxisAngle(up, k * bend).setY(p).normalize();
        lay(chest, neck, V3(0, 0, 1), dirAt(0, p1), V3(0, -1, 0));
        lay(neck, head, V3(0, 0, 1), dirAt(1, p2), V3(0, -1, 0));
        // the head drops (from `p3` down) until its lowest point is as low as the rest of the fallen
        // neck: it hangs over its own coil onto the ground, not on top of it in the air
        const headParts = spec.joints.find((j) => j.name === "head")?.parts ?? [];
        const minOf = (keep) => { mesh.updateMatrixWorld(true); let m = Infinity; for (const i of trunkIdx) if (keep(tags[i])) m = Math.min(m, mesh.applyBoneTransform(i, tmpV.copy(verts[i])).y); return m; };
        const neckLow = minOf((t) => !headParts.includes(t));
        let p = p3;
        for (; p > -1.4; p -= 0.05) {
          const d3 = dirAt(2, p);
          framed(head, V3(0, 0, 1), V3(0, 1, 0), d3, up.clone().applyAxisAngle(d3, S.deathRoll ?? 0.5));
          if (!headParts.length || minOf((t) => headParts.includes(t)) <= neckLow + 0.01) break;
        }
        console.log(`serpent: dead head pitched ${p.toFixed(2)}`);
        const qDead = [chest, neck, head].map((b) => b.quaternion.clone());
        const sink = trunkMinY();
        rootDead.y -= sink; // the lowest point of the fallen neck and head ON the ground, not in it
        console.log(`serpent: dead neck lifted ${(-sink).toFixed(3)} m onto the ground`);
        resetPose(); mesh.updateMatrixWorld(true);
        clips.push(bake("Death", 1.8, (t) => {
          const u = t / 1.8;
          const rear = ss(u, 0, 0.18) * (1 - ss(u, 0.22, 0.4));
          const thrash = Math.sin(2 * Math.PI * 3.5 * u) * ss(u, 0.05, 0.15) * (1 - ss(u, 0.3, 0.5));
          const fall = ss(u, 0.28, 0.62) ** 1.6; // slow to tip, fast to land
          const head2 = ss(u, 0.34, 0.7);
          const settle = Math.sin(Math.PI * ss(u, 0.62, 0.82)) * 0.04; // a small bounce as it lands
          root.position.copy(rootDead).multiplyScalar(fall);
          root.position.y += settle * (1 - ss(u, 0.75, 0.9));
          const q0 = [
            rotAbout(side, -0.35 * rear).multiply(rotAbout(fwd, 0.25 * thrash)),
            rotAbout(side, -0.3 * rear).multiply(rotAbout(upAxis, 0.3 * thrash)),
            rotAbout(side, 0.4 * rear).multiply(rotAbout(upAxis, -0.4 * thrash)),
          ];
          [chest, neck, head].forEach((b, i) => b.quaternion.copy(q0[i]).slerp(qDead[i], i === 2 ? head2 : fall));
          flare(0.3 * rear * (1 - fall));
          const twitch = 0.35 * Math.sin(2 * Math.PI * 2.5 * u) * ss(u, 0.1, 0.25) * (1 - ss(u, 0.55, 0.95));
          anchored(restLine(twitch));
        }));
      }
      if (unreached) console.log(`serpent: ${unreached} frames slid the body along its line (the front could not reach its anchor)`);
    },
  };
}
const serpent = spec.plan === "serpent" ? makeSerpent() : null;

const clips = [];
// the standing Idle's pose function (walkers): a hit reaction is that pose, struck
let idlePose = null;
const sp = {};
for (const [name, g] of Object.entries(spec.gaits)) {
  clips.push(gait(name, g));
  // a flyer's speed is its own (no feet to slide); a walker's is its stride
  const v = +(g.speed ?? g.stride / (g.duty * g.period)).toFixed(2);
  if (v > 0) sp[name] = v; // a flyer's hovering Idle has no speed
}

if (spec.plan === "biped") {
  const tail = tailChain();
  const neck = bones.get("neck"), head = bones.get("head"), chest = bones.get("chest");
  const size = zMax - zMin;
  // breathing, the weight drifting between the feet, a slow look round, the tail swaying
  clips.push(bake("Idle", 6, idlePose = (t) => {
    const w = (2 * Math.PI * t) / 6;
    root.position.x += 0.012 * size * Math.sin(w);
    root.position.y += 0.004 * size * Math.sin(3 * w);
    hub.quaternion.multiply(rotAbout(fwd, -0.02 * Math.sin(w)));
    chest.quaternion.multiply(rotAbout(side, -0.025 * Math.sin(3 * w)));
    neck.quaternion.multiply(rotAbout(upAxis, 0.25 * Math.sin(w + 0.5))).multiply(rotAbout(side, 0.05 * Math.sin(2 * w + 1)));
    head.quaternion.multiply(rotAbout(upAxis, 0.15 * Math.sin(w + 1.1))).multiply(rotAbout(side, -0.06 * Math.sin(2 * w)));
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(upAxis, 0.05 * (1 + k * 0.4) * Math.sin(w * 2 - k * 0.8))));
    planted();
  }));
  // rear the head back, then lunge: the body pitches forward over the hips
  // (the tail lifting to balance), the knees sink, the head strikes down
  // and forward (the hit at ~45%), then it recovers
  clips.push(bake("Bite", 1.2, (t) => {
    const u = t / 1.2;
    const coil = u < 0.33 ? Math.sin((Math.PI / 2) * (u / 0.33)) : Math.max(0, 1 - (u - 0.33) / 0.12);
    const strike = u < 0.33 ? 0 : Math.sin(Math.PI * Math.min(1, (u - 0.33) / 0.67)) ** 0.8;
    root.position.z += size * (-0.02 * coil + 0.06 * strike);
    root.position.y -= size * 0.025 * strike;
    hub.quaternion.multiply(rotAbout(side, -0.08 * coil + 0.2 * strike));
    chest.quaternion.multiply(rotAbout(side, -0.06 * coil + 0.08 * strike));
    neck.quaternion.multiply(rotAbout(side, -0.25 * coil + 0.18 * strike));
    head.quaternion.multiply(rotAbout(side, -0.3 * coil + 0.22 * strike));
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(side, -0.04 * strike)).multiply(rotAbout(upAxis, 0.06 * strike * Math.sin(u * 6 - k))));
    planted();
  }));
  // rear up and throw the head to the sky, then bring it down and forward and
  // roar at the target, the head shaking
  clips.push(bake("Roar", 2.6, (t) => {
    const u = t / 2.6;
    const up = THREE.MathUtils.smoothstep(u, 0, 0.25) * (1 - THREE.MathUtils.smoothstep(u, 0.35, 0.5));
    const out = THREE.MathUtils.smoothstep(u, 0.35, 0.5) * (1 - THREE.MathUtils.smoothstep(u, 0.8, 1));
    const shake = out * Math.sin(u * 2 * Math.PI * 9);
    root.position.z -= size * 0.015 * up;
    root.position.y -= size * 0.015 * out;
    hub.quaternion.multiply(rotAbout(side, -0.14 * up + 0.12 * out));
    chest.quaternion.multiply(rotAbout(side, -0.1 * up + 0.05 * out));
    neck.quaternion.multiply(rotAbout(side, -0.3 * up + 0.1 * out)).multiply(rotAbout(upAxis, 0.08 * shake));
    head.quaternion.multiply(rotAbout(side, -0.45 * up - 0.05 * out)).multiply(rotAbout(fwd, 0.08 * shake));
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(side, 0.05 * up - 0.05 * out)).multiply(rotAbout(upAxis, 0.08 * out * Math.sin(u * 14 - k))));
    planted();
  }));
  // Death: staggers back a step, the head thrown up, the knees go and it sinks, then it topples
  // onto its side (rolling about its feet, so 3 m of body comes down like a falling tree), the
  // head and the long tail slam down after it and lie along the ground, the legs fold up against
  // the belly. The legs fold in the BODY's frame (IK targets carried with the roll: rotated
  // bones left them sticking out stiff into the air), and the neck and tail are bent toward the
  // ground by a search until they rest on it. Grounded on the body (`groundIgnore`)
  {
    const D = spec.death ?? {};
    const rollTo = -(D.roll ?? 1.45); // about +z: the left side (+x) goes down
    const legLen = legs.length ? legs[0].a + legs[0].b : size * 0.25;
    const fold = (k) => {
      mesh.updateMatrixWorld(true);
      for (const L of legs) {
        // the foot drawn up toward the belly and forward, in the body's (root's) frame
        // (and dropped toward the ground: the body's +x once it lies on its left side)
        const p = L.foot0.clone().add(V3((0.1 * L.sgn + (D.legDrop ?? 0.45)) * legLen * k, 0.5 * legLen * k, 0.3 * legLen * k));
        solveLeg(L, p.applyMatrix4(root.matrixWorld), V3(), 0.4 * k);
      }
    };
    const headParts = spec.joints.find((j) => j.name === "head")?.parts ?? [];
    const tailParts = D.tail ?? spec.trunk.filter((p) => /Tail/.test(p));
    const pose = (u, nd, td) => {
      const stagger = Math.sin(Math.PI * Math.min(1, u / 0.3));
      const sink = ss(u, 0.12, 0.45);
      const fall = ss(u, 0.3, 0.72) ** 2; // slow to go, fast to land
      const slam = ss(u, 0.5, 0.82) ** 1.5;
      root.quaternion.copy(rotAbout(fwd, rollTo * fall)).multiply(rotAbout(upAxis, 0.1 * stagger * (1 - fall)));
      pivotRoot(); // on its own centre, not about its feet: it goes down where it stood
      root.position.z -= size * 0.03 * Math.min(1, u / 0.3);
      root.position.y -= legLen * 0.25 * sink * (1 - fall);
      hub.quaternion.multiply(rotAbout(side, -0.1 * stagger * (1 - fall) + 0.08 * fall));
      neck.quaternion.multiply(rotAbout(side, -0.3 * stagger * (1 - fall))).multiply(rotAbout(upAxis, nd * slam));
      head.quaternion.multiply(rotAbout(side, -0.25 * stagger * (1 - fall) + 0.1 * slam)).multiply(rotAbout(upAxis, 0.4 * nd * slam));
      // the tail bends toward the ground (down is the body's +x once it lies on its left side)
      tail.forEach((b, k) => b.quaternion.multiply(rotAbout(upAxis, -td * slam))
        .multiply(rotAbout(side, 0.04 * stagger * (1 - fall))));
      fold(Math.max(0.5 * sink, ss(u, 0.35, 0.8)));
    };
    const minOf = (keep) => { mesh.updateMatrixWorld(true); let m = Infinity; for (let i = 0; i < verts.length; i++) if (keep(tags[i])) m = Math.min(m, mesh.applyBoneTransform(i, tmpV.copy(verts[i])).y); return m; };
    const bodyPart = D.body ?? spec.trunk.find((p) => /Body/.test(p)) ?? spec.trunk[0];
    let nd = 0, td = 0;
    for (; nd < 1.2; nd += 0.03) { resetPose(); pose(1, nd, 0); if (minOf((t) => headParts.includes(t)) <= minOf((t) => t === bodyPart) + 0.05) break; }
    // the TIP down: the tail's base touches long before its end does
    const tipZ = zMin + 0.12 * (zMax - zMin);
    const tipMin = () => { mesh.updateMatrixWorld(true); let m = Infinity; for (let i = 0; i < verts.length; i++) if (tailParts.includes(tags[i]) && verts[i].z < tipZ) m = Math.min(m, mesh.applyBoneTransform(i, tmpV.copy(verts[i])).y); return m; };
    for (; td < 0.6; td += 0.01) { resetPose(); pose(1, nd, td); if (!tailParts.length || tipMin() <= minOf((t) => t === bodyPart) + 0.08) break; }
    console.log(`death: on its side, neck bent ${nd.toFixed(2)} rad and tail ${td.toFixed(2)} rad down onto the ground`);
    resetPose(); mesh.updateMatrixWorld(true);
    clips.push(bake("Death", 2.6, (t) => {
      const u = t / 2.6;
      pose(u, nd, td);
      ground(Math.max(ss(u, 0.3, 0.72) ** 2, ss(u, 0.55, 0.78))); // toppling on its centre, it comes down as it turns (not a drop at the end)
    }));
  }
} else if (spec.plan === "flyer") {
  const size = zMax - zMin;
  const B = spec.bite ?? {};
  const fast = spec.gaits.Run ?? spec.gaits.Walk;
  // a dart: draw back, then shoot forward and strike (the peck, the sting) at
  // ~45%, wings beating hard all the while, and back off
  const biteDur = B.duration ?? 0.9;
  const bg = { ...fast, period: biteDur, beats: B.beats ?? Math.max(1, Math.round((fast.beats ?? 1) * biteDur / fast.period)), glide: 0 };
  const bite = bake("Bite", biteDur, (t) => {
    const u = t / biteDur;
    const back = u < 0.3 ? Math.sin((Math.PI / 2) * (u / 0.3)) : Math.max(0, 1 - (u - 0.3) / 0.15);
    const dart = u < 0.3 ? 0 : Math.sin(Math.PI * Math.min(1, (u - 0.3) / 0.7)) ** 0.7;
    root.position.z += size * ((B.back ?? 0.12) * -back + (B.lunge ?? 0.45) * dart);
    root.position.y += size * (B.dip ?? 0) * -dart;
    flyBody(t, bg, (B.pitch ?? 0.3) * dart - (B.pitch ?? 0.3) * 0.5 * back);
    for (const [name, a] of Object.entries(B.bones ?? {})) bones.get(name).quaternion.multiply(rotAbout(side, a * dart - 0.4 * a * back));
    mesh.updateMatrixWorld(true);
    flyLegs(t, bg, [(L) => L.biteFold, dart]);
    for (const W of wings) flyWing(W, wingBeat(bg, t, W));
  });
  if (B.sheet) sheetSpan.set(bite, B.sheet);
  clips.push(bite);
  // the wings fail and fold, the body tips over and drops out of the air,
  // and lies on the ground
  const idle = spec.gaits.Idle ?? spec.gaits.Walk;
  const dead = FL.dead ?? { spread: 0 };
  clips.push(bake("Death", 1.8, (t) => {
    const u = t / 1.8;
    const k = THREE.MathUtils.smoothstep(u, 0, 0.45); // wings: flailing -> folded
    const drop = Math.min(1, u / 0.6) ** 2; // falls, accelerating
    const roll = THREE.MathUtils.smoothstep(u, 0.05, 0.65);
    root.position.y += (FL.hover ?? 0) * (1 - drop);
    root.quaternion.copy(rotAbout(fwd, (FL.roll ?? 1.5) * roll))
      .multiply(rotAbout(side, (FL.pitch ?? 0) * (1 - roll) + (FL.deadPitch ?? 0) * roll + 0.25 * Math.sin(Math.PI * Math.min(1, u / 0.5))));
    pivotRoot();
    opt("head")?.quaternion.multiply(rotAbout(side, (FL.head ?? 0) * (1 - roll) + 0.3 * roll));
    // the tail curls toward the belly (`deadCurl` per link: a many-link abdomen wants less)
    tailChain().forEach((b) => b.quaternion.multiply(rotAbout(side, (FL.deadCurl ?? -0.15) * roll)));
    for (const L of legs) if (L.tuck) {
      const d = L.dead ?? spec.legs.find((s) => L.key.startsWith(s.name + "."))?.dead ?? [0.3, -1.2];
      L.upper.quaternion.multiply(rotAbout(side, L.tuck[0] * (1 - roll) + d[0] * roll));
      L.lower.quaternion.multiply(rotAbout(side, L.tuck[1] * (1 - roll) + d[1] * roll));
    }
    mesh.updateMatrixWorld(true);
    // folded legs kick, then curl up dead (`deadFold`, toward the belly: the sky by now)
    flyLegs(t, { ...idle, legSwing: (idle.legSwing ?? 0) * 3, legSwings: 3, period: 1.8 }, [(L) => L.deadFold, roll], 1 - roll);
    const flail = { ...idle, flap: (idle.flap ?? 0.6) * 1.3, period: 1.8, beats: Math.max(2, Math.round((idle.beats ?? 1) * 1.8 / idle.period)), glide: 0 };
    for (const W of wings) flyWing(W, mixWing(wingBeat(flail, t, W), dead, k));
    ground(THREE.MathUtils.smoothstep(u, 0.55, 0.7));
  }));
} else if (spec.plan === "quad") {
  const tail = sorted.filter((st) => st.pos.z < hubZ).map((st) => bones.get(st.name));
  const neck = bones.get("neck"), head = bones.get("head"), chest = bones.get("chest");
  const front = legs.filter((L) => L.key.startsWith("front"));
  const Q = spec.quad ?? {};
  const crouch = Q.crouch ?? 0; // standing clips sink this much (straight forelegs need slack to stay planted)
  const bump = (u, a, b) => (u <= a || u >= b ? 0 : Math.sin((Math.PI * (u - a)) / (b - a)) ** 2);
  // Idle: breathing (the chest heaves, the body rises and falls), a slow look round with the
  // long neck, the tail curled to one side and never still, and once a wing shuffle (the folded
  // wings half lift, settle with a shake, fold again)
  clips.push(bake("Idle", 6, idlePose = (t) => {
    const u = t / 6, w = 2 * Math.PI * u, breath = Math.sin(3 * w);
    root.position.y += -crouch + 0.025 * breath;
    hub.quaternion.multiply(rotAbout(side, -0.01 * breath));
    chest.quaternion.multiply(rotAbout(side, 0.03 * breath));
    neck.quaternion.multiply(rotAbout(upAxis, 0.22 * Math.sin(w))).multiply(rotAbout(side, -0.04 + 0.05 * Math.sin(2 * w + 1) - 0.02 * breath));
    head.quaternion.multiply(rotAbout(upAxis, 0.15 * Math.sin(w + 0.6))).multiply(rotAbout(side, 0.05 * Math.sin(2 * w)));
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(upAxis, 0.05 + (0.05 + 0.025 * k) * Math.sin(2 * w - 0.8 * k))));
    const sh = bump(u, 0.55, 0.8);
    wingFold(1 - 0.4 * sh, 0.16 * sh + 0.05 * sh * Math.sin(2 * Math.PI * 8 * u));
    planted();
  }));
  // Bite: rear the neck back and up (the wings lifting a little off the back), then strike down and
  // forward, the chest dropping into it (the hit at ~45%), and recover
  clips.push(bake("Bite", 1.1, (t) => {
    const u = t / 1.1;
    const coil = u < 0.35 ? Math.sin((Math.PI / 2) * (u / 0.35)) : Math.max(0, 1 - (u - 0.35) / 0.1);
    const strike = u < 0.35 ? 0 : Math.sin(Math.PI * Math.min(1, (u - 0.35) / 0.65));
    root.position.y += -crouch - 0.12 * strike;
    root.position.z += -0.06 * coil + 0.15 * strike;
    hub.quaternion.multiply(rotAbout(side, -0.03 * coil + 0.04 * strike));
    chest.quaternion.multiply(rotAbout(side, -0.1 * coil + 0.16 * strike));
    neck.quaternion.multiply(rotAbout(side, -0.5 * coil + 0.6 * strike));
    head.quaternion.multiply(rotAbout(side, -0.3 * coil + 0.35 * strike));
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(upAxis, 0.12 * strike * Math.sin(u * 7 - k))));
    wingFold(1, 0.18 * coil + 0.06 * strike);
    planted();
  }));
  // Roar: rise on the forelegs (the body pitched up about the shoulders, the hind legs bending
  // under it), neck thrown up, jaws to the sky, wings half spread and beating, the head shaking
  const shoulder = front.reduce((s, L) => s.add(L.upper.userData.rest), V3()).divideScalar(Math.max(1, front.length)).setX(0);
  clips.push(bake("Roar", 2.6, (t) => {
    const u = t / 2.6;
    const up = ss(u, 0, 0.25) * (1 - ss(u, 0.78, 1));
    const shake = up * Math.sin(u * 2 * Math.PI * 9) * ss(u, 0.3, 0.4);
    root.quaternion.copy(rotAbout(side, -(Q.roarPitch ?? 0.2) * up));
    root.position.copy(shoulder.clone().sub(shoulder.clone().applyQuaternion(root.quaternion)));
    root.position.y += -crouch * (1 - up);
    chest.quaternion.multiply(rotAbout(side, -0.06 * up));
    neck.quaternion.multiply(rotAbout(side, -0.45 * up)).multiply(rotAbout(upAxis, 0.06 * shake));
    head.quaternion.multiply(rotAbout(side, -0.4 * up)).multiply(rotAbout(fwd, 0.08 * shake));
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(side, 0.05 * up)).multiply(rotAbout(upAxis, 0.1 * up * Math.sin(u * 14 - k))));
    wingFold(1 - 0.55 * up, 0.12 * up + 0.12 * up * Math.sin(u * 2 * Math.PI * 3));
    planted();
  }));
  // Death: a stagger, the legs buckle and splay, the body crashes onto its belly rolled a little
  // onto one side, the neck and head slam down after it and lie along the ground turned aside,
  // the tail goes limp along the ground, the wings crumple open and splay out over the ground.
  // Grounded on the BODY (`groundIgnore`: wings, spikes, horns go where they fall); the neck and
  // the tail are bent down by a search until they rest on the ground, not hang above it
  {
    const bodyPart = Q.body ?? spec.trunk.find((p) => /Body/.test(p)) ?? spec.trunk[0];
    let belly = Infinity;
    verts.forEach((v, i) => { if (tags[i] === bodyPart) belly = Math.min(belly, v.y); });
    const headParts = spec.joints.find((j) => j.name === "head")?.parts ?? [];
    const tailParts = Q.tail ?? spec.trunk.filter((p) => /Tail/.test(p));
    const roll = Q.deathRoll ?? 0.18;
    const deadPose = (k, nd, td, s) => {
      // k: the collapse 0..1, nd / td: how far the neck / tail bend down, s: the wings' splay
      root.position.y += -belly * k;
      root.quaternion.copy(rotAbout(fwd, roll * k));
      pivotRoot();
      hub.quaternion.multiply(rotAbout(side, 0.04 * k));
      chest.quaternion.multiply(rotAbout(side, 0.06 * k)).multiply(rotAbout(fwd, -0.05 * k));
      neck.quaternion.multiply(rotAbout(side, nd)).multiply(rotAbout(upAxis, -0.35 * k));
      // the head turned back level against the neck's drop: it lies on its jaw, not on its snout
      head.quaternion.multiply(rotAbout(side, -0.55 * nd)).multiply(rotAbout(upAxis, -0.25 * k)).multiply(rotAbout(fwd, 0.35 * k));
      // (about +x a tail pointing back tips UP: down is negative)
      tail.forEach((b, j) => b.quaternion.multiply(rotAbout(side, -td * k * (j === tail.length - 1 ? 1 : 0.35))).multiply(rotAbout(upAxis, 0.12 * k * (j % 2 ? 1 : -1))));
      mesh.updateMatrixWorld(true);
      for (const L of legs) {
        const p = L.foot0.clone();
        p.x += L.sgn * (L.key.startsWith("front") ? 0.45 : 0.55) * k;
        p.z += (L.key.startsWith("front") ? 0.35 : -0.45) * k;
        solveLeg(L, p);
      }
      wingFold(1 - 0.3 * s);
      wingSplay(s);
    };
    const minOf = (keep) => { mesh.updateMatrixWorld(true); let m = Infinity; for (let i = 0; i < verts.length; i++) if (keep(tags[i])) m = Math.min(m, mesh.applyBoneTransform(i, tmpV.copy(verts[i])).y); return m; };
    const isBody = (t) => !groundSkip.has(t) && !headParts.includes(t) && !tailParts.includes(t) && !spec.legs.some((l) => l.part === t);
    let nd = 0.2, td = 0;
    for (; nd < 1.6; nd += 0.05) { resetPose(); deadPose(1, nd, 0, 0); if (minOf((t) => headParts.includes(t)) <= minOf(isBody) + 0.04) break; }
    for (; td < 0.8; td += 0.03) { resetPose(); deadPose(1, nd, td, 0); if (!tailParts.length || minOf((t) => tailParts.includes(t)) <= minOf(isBody) + 0.03) break; }
    console.log(`death: neck down ${nd.toFixed(2)} rad, tail down ${td.toFixed(2)} rad, belly ${belly.toFixed(2)} m`);
    resetPose(); mesh.updateMatrixWorld(true);
    clips.push(bake("Death", 2.8, (t) => {
      const u = t / 2.8;
      const stagger = Math.sin(Math.PI * Math.min(1, u / 0.3)) * (1 - ss(u, 0.25, 0.45));
      const k = ss(u, 0.18, 0.55) ** 1.5; // the legs go, slow then fast: the crash
      const kn = ss(u, 0.3, 0.68) ** 1.8; // the neck slams down after the body
      const s = ss(u, 0.45, 0.85);
      root.position.x += 0.12 * stagger;
      root.position.y += -crouch * (1 - k);
      neck.quaternion.multiply(rotAbout(side, -0.35 * stagger)).multiply(rotAbout(upAxis, 0.2 * stagger));
      head.quaternion.multiply(rotAbout(side, -0.25 * stagger));
      deadPose(k, nd * kn, td, s);
      ground(ss(u, 0.5, 0.7));
    }));
  }
} else if (spec.plan === "serpent") {
  serpent.clips();
} else if (spec.plan === "sprawl") {
  const tail = sorted.filter((s) => s.pos.z < hubZ).map((s) => bones.get(s.name));
  const neck = bones.get("neck"), head = bones.get("head"), chest = bones.get("chest");
  clips.push(bake("Idle", 4, idlePose = (t) => {
    const w = (2 * Math.PI * t) / 4;
    root.position.y += 0.006 * Math.sin(2 * w);
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(upAxis, 0.05 * Math.sin(w - k * 0.6))));
    head.quaternion.multiply(rotAbout(side, -0.04 - 0.03 * Math.sin(w)));
    wingPose(0.04 * Math.sin(w), 0.1 + 0.05 * Math.sin(w));
    planted();
  }));
  if (!legs.length) {
    // a fish (no legs): attacks are swims. Distances scale with body length.
    const len = Math.abs(bones.get("head").getWorldPosition(new THREE.Vector3()).z - tail[tail.length - 1].getWorldPosition(new THREE.Vector3()).z) || 1;
    const whip = (amp, ph) => tail.forEach((b, k) => b.quaternion.multiply(rotAbout(upAxis, amp * Math.sin(ph - k * 0.9) * (0.5 + 0.25 * k))));
    // Bite: coil the tail, surge forward with the snout lifting (the jaw
    // showing), snap down on the hit (~45%), shake the head, glide back
    clips.push(bake("Bite", 1.0, (t) => {
      const u = t / 1.0;
      const coil = u < 0.25 ? Math.sin((Math.PI / 2) * (u / 0.25)) : Math.max(0, 1 - (u - 0.25) / 0.1);
      const surge = u < 0.25 ? 0 : Math.sin(Math.PI * Math.min(1, (u - 0.25) / 0.75));
      const lift = u < 0.25 ? 0 : u < 0.42 ? (u - 0.25) / 0.17 : Math.max(0, 1 - (u - 0.42) / 0.06);
      const shake = u > 0.45 && u < 0.8 ? Math.sin((u - 0.45) * 2 * Math.PI * 5) * Math.sin(Math.PI * (u - 0.45) / 0.35) : 0;
      root.position.z += len * (-0.05 * coil + 0.3 * surge);
      root.position.y += len * 0.03 * surge;
      chest.quaternion.multiply(rotAbout(side, -0.12 * lift)).multiply(rotAbout(upAxis, 0.12 * shake));
      neck.quaternion.multiply(rotAbout(side, -0.2 * lift)).multiply(rotAbout(upAxis, 0.18 * shake));
      head.quaternion.multiply(rotAbout(side, -0.3 * lift + 0.15 * Math.max(0, surge - lift))).multiply(rotAbout(upAxis, 0.25 * shake));
      whip(0.35 * coil + 0.3 * surge, u * 2 * Math.PI * 2.5);
      wingPose(0.3 * coil, 0);
    }));
    // Heavy: a ram, then a thrashing barrel twist (the death roll) and recover
    clips.push(bake("Heavy", 1.6, (t) => {
      const u = t / 1.6;
      const coil = u < 0.2 ? Math.sin((Math.PI / 2) * (u / 0.2)) : Math.max(0, 1 - (u - 0.2) / 0.08);
      const ram = u < 0.2 ? 0 : Math.sin(Math.PI * Math.min(1, (u - 0.2) / 0.8));
      const roll = u < 0.32 ? 0 : u < 0.8 ? Math.sin(Math.PI * (u - 0.32) / 0.48) : 0;
      root.position.z += len * (-0.08 * coil + 0.45 * ram);
      root.quaternion.copy(rotAbout(fwd, 1.1 * roll * Math.sin((u - 0.32) * 2 * Math.PI * 2.1)));
      pivotRoot(); // the death roll spins on the body's own axis
      chest.quaternion.multiply(rotAbout(side, -0.15 * ram * (1 - roll)));
      head.quaternion.multiply(rotAbout(side, -0.25 * ram * (1 - roll))).multiply(rotAbout(upAxis, 0.3 * roll * Math.sin(u * 2 * Math.PI * 6)));
      whip(0.4 * coil + 0.35 * ram + 0.2 * roll, u * 2 * Math.PI * 3.5);
      wingPose(0.3 * coil + 0.3 * roll, 0);
    }));
  } else
  // a lunge: rear back, throw the front half forward and snap the head down
  // (the hit lands at ~45% of the clip), then settle
  clips.push(bake("Bite", 0.9, (t) => {
    const u = t / 0.9;
    const back = Math.sin(Math.PI * Math.min(1, u / 0.3)) * (u < 0.3 ? 1 : 0);
    const lunge = u < 0.3 ? 0 : Math.sin(Math.PI * Math.min(1, (u - 0.3) / 0.7));
    root.position.z += -0.06 * back + 0.22 * lunge;
    chest.quaternion.multiply(rotAbout(side, -0.12 * back - 0.08 * lunge));
    neck.quaternion.multiply(rotAbout(side, -0.25 * back + 0.05 * lunge));
    head.quaternion.multiply(rotAbout(side, -0.35 * back + 0.3 * Math.max(0, lunge - 0.2)));
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(upAxis, 0.18 * lunge * Math.sin(u * 6 - k))));
    wingPose(0.55 * back + 0.25 * lunge, -0.2 * back);
    planted();
  }));
  // roll onto the back and stay there
  clips.push(bake("Death", 1.4, (t) => {
    const u = THREE.MathUtils.smoothstep(t / 1.1, 0, 1);
    root.quaternion.copy(rotAbout(fwd, Math.PI * 0.85 * u));
    pivotRoot(); // rolls over on its own axis; ground() below lets it down onto its back
    tail.forEach((b, k) => b.quaternion.multiply(rotAbout(upAxis, 0.12 * u * (k % 2 ? 1 : -1))));
    head.quaternion.multiply(rotAbout(side, 0.25 * u));
    wingPose(-0.5 * u, 0.3 * u);
    for (const L of legs) {
      L.upper.quaternion.multiply(rotAbout(fwd, -L.sgn * 0.9 * u));
      L.lower.quaternion.multiply(rotAbout(fwd, -L.sgn * 0.7 * u));
    }
    ground(Math.max(u, THREE.MathUtils.smoothstep(t / 1.4, 0.55, 0.8))); // rolling on its axis it stays in touch with the ground
  }));
} else {
  const abdomen = bones.get("abdomen"), thorax = bones.get("thorax");
  const front = legs.filter((L) => L.key.startsWith("leg1"));
  clips.push(bake("Idle", 3, idlePose = (t) => {
    const w = (2 * Math.PI * t) / 3;
    root.position.y += 0.008 * Math.sin(w);
    abdomen.quaternion.multiply(rotAbout(side, 0.04 * Math.sin(w + 1)));
    sting?.idle(t, 3);
    mesh.updateMatrixWorld(true);
    for (const L of legs) {
      const p = L.foot0.clone();
      // the front pair taps, one then the other
      if (L.key.startsWith("leg1")) {
        const tap = Math.max(0, Math.sin(2 * w + (L.sgn > 0 ? 0 : Math.PI)));
        p.y += 0.06 * tap * tap;
      }
      solveLeg(L, p);
    }
  }));
  // a scorpion: tail-strike Bite, claw Heavy and Pinch, a belly-down Death
  if (sting) sting.clips();
  // rear up, front legs raised high, then strike down and forward
  else clips.push(bake("Bite", 1.0, (t) => {
    const u = t / 1.0;
    const rear = u < 0.4 ? Math.sin((Math.PI / 2) * (u / 0.4)) : Math.max(0, 1 - (u - 0.4) / 0.15);
    const strike = u < 0.4 ? 0 : Math.sin(Math.PI * Math.min(1, (u - 0.4) / 0.6));
    root.position.y += 0.12 * rear;
    root.position.z += 0.25 * strike - 0.05 * rear;
    root.quaternion.copy(rotAbout(side, -0.7 * rear + 0.15 * strike));
    abdomen.quaternion.multiply(rotAbout(side, 0.25 * rear));
    mesh.updateMatrixWorld(true);
    for (const L of legs) {
      const p = L.foot0.clone();
      if (front.includes(L)) {
        p.y += 0.8 * rear;
        p.z += 0.15 * rear + 0.2 * strike;
        p.x *= 1 - 0.35 * rear;
      } else p.z += 0.18 * strike;
      solveLeg(L, p);
    }
  }));
  // flip onto the back, legs curling in over the belly
  if (!sting) clips.push(bake("Death", 1.5, (t) => {
    const u = THREE.MathUtils.smoothstep(t / 1.0, 0, 1);
    const c = THREE.MathUtils.smoothstep(t / 1.5, 0.2, 1);
    root.quaternion.copy(rotAbout(fwd, Math.PI * u));
    pivotRoot(); // flips over on its own axis; ground() below lets it down onto its back
    for (const L of legs) {
      // toward the belly, which is the sky by now
      L.upper.quaternion.multiply(rotAbout(fwd, -L.sgn * 0.9 * c));
      L.lower.quaternion.multiply(rotAbout(fwd, -L.sgn * 1.5 * c));
    }
    ground(THREE.MathUtils.smoothstep(t / 1.5, 0.5, 0.7));
  }));
}
// ---------------------------------------------------------------- hit reactions
/**
 * `Hit` (a light flinch, ~0.4 s) and `Hit_Heavy` (a stagger, ~0.9 s), every
 * plan. combat-actor plays `Hit` on an ordinary blow (hitClip) and `Hit_Heavy`
 * when the stability pool breaks (staggerClip). Both are the creature's own
 * Idle struck from the front: the body recoils back a few % of its length, the
 * neck and head jerk back and up a beat behind it, the spine compresses and
 * twists, the tail whips, and the feet stay where they were (the plan's own IK)
 * — then it all settles back onto the Idle, so the clip blends out cleanly.
 * Per plan: a quadruped lifts a front paw (and stumbles a step back on the
 * heavy one), an arachnid/insect pulls its legs in, a biped rocks back on its
 * heels with the tail swinging, a legless swimmer jerks sideways with a tail
 * kick, and a flyer jolts back, drops and misses a wing beat.
 */
if (spec.plan !== "serpent") {
  const size = zMax - zMin;
  const chest = opt("chest"), neck = opt("neck"), head = opt("head");
  const tail = tailChain();
  const trunkFront = trunkBones.filter((b) => b !== hub && b.userData.rest.z > hubZ && b !== head);
  /** 0 -> 1 fast (by `peak`), held to `hold`, eased back to 0 by the end */
  const env = (u, peak, hold) => (u <= 0 ? 0 : u < peak ? Math.sin((Math.PI / 2) * (u / peak)) : u < hold ? 1 : 1 - ss(u, hold, 1));
  /** a smooth bump over [a, b] */
  const bump = (u, a, b) => (u <= a || u >= b ? 0 : Math.sin((Math.PI * (u - a)) / (b - a)) ** 2);
  // `hit` in the spec: { style: "strike" } gives a legless creature that rears (a cobra) the
  // walkers' recoil instead of a swimmer's sideways jerk; { light, heavy } override the numbers below
  const H = spec.hit ?? {};
  const swimmer = !legs.length && spec.plan === "sprawl" && H.style !== "strike";
  const pairOf = (L) => L.key.split(".")[0];
  const frontKey = legs.length ? pairOf(legs.reduce((a, b) => (b.foot0.z > a.foot0.z ? b : a))) : null;
  const firstPair = legs.filter((L) => pairOf(L) === frontKey);
  const frontPaw = firstPair.find((L) => L.sgn > 0) ?? firstPair[0];
  const legMidZ = legs.length ? legs.reduce((s, L) => s + L.foot0.z, 0) / legs.length : 0;
  const pairIndex = [...new Set(legs.map(pairOf))].sort((a, b) =>
    Math.max(...legs.filter((L) => pairOf(L) === b).map((L) => L.foot0.z)) - Math.max(...legs.filter((L) => pairOf(L) === a).map((L) => L.foot0.z)));

  // the body, struck: `e` the recoil, `eh` the head's (a beat later), `shake` a head shake, `sway` a sideways stumble
  const strike = (k, e, eh, shake, sway, u) => {
    root.position.z -= size * k.back * e;
    root.position.y -= size * k.dip * e;
    root.position.x += size * k.sway * sway;
    hub.quaternion.multiply(rotAbout(side, -k.pitch * e)).multiply(rotAbout(fwd, k.roll * (e + sway)));
    for (const b of trunkFront) {
      if (b === neck) continue;
      b.quaternion.multiply(rotAbout(side, k.compress * e)).multiply(rotAbout(upAxis, k.twist * e));
    }
    neck?.quaternion.multiply(rotAbout(side, -k.neck * eh)).multiply(rotAbout(upAxis, k.shake * 0.6 * shake));
    head?.quaternion.multiply(rotAbout(side, -k.head * eh)).multiply(rotAbout(fwd, k.tilt * eh)).multiply(rotAbout(upAxis, k.shake * shake));
    // tail[] runs tip -> base; the base link takes back the hips' pitch (a tail
    // lying on the ground must not be driven into it) and lifts a little
    tail.forEach((b, j) => {
      const fromBase = tail.length - 1 - j;
      b.quaternion
        .multiply(rotAbout(upAxis, k.tail * e * (1 + 0.4 * fromBase) * Math.sin(2 * Math.PI * u * k.tailBeats - 0.7 * (fromBase + 1))))
        .multiply(rotAbout(side, ((fromBase === 0 ? k.pitch : 0) + k.tailLift) * e));
    });
    wingPose(k.wings * e, -0.1 * e);
  };

  const hitClip = (name, dur, k) => bake(name, dur, (t) => {
    const u = t / dur;
    const e = env(u, k.peak, k.hold);
    const eh = env(u - k.lag, k.peak, k.hold - k.lag);
    const shake = k.shakeAt ? bump(u, k.shakeAt[0], k.shakeAt[1]) * Math.sin(2 * Math.PI * k.shakes * u) : 0;
    const sway = k.sway ? Math.sin(2 * Math.PI * k.swayBeats * u) * (1 - ss(u, 0.35, 1)) * ss(u, 0, 0.12) : 0;
    idlePose?.(t);
    if (swimmer) {
      // a swimmer: jerked sideways, the body bending into a C away from the blow, a tail kick
      root.position.z -= size * k.back * e;
      root.position.x += size * (k.side * e + k.sway * sway);
      if (k.roll) root.quaternion.multiply(rotAbout(fwd, k.roll * Math.sin(2 * Math.PI * 1.5 * u) * e));
      hub.quaternion.multiply(rotAbout(upAxis, -k.bend * e));
      for (const b of trunkFront) b.quaternion.multiply(rotAbout(upAxis, -k.bend * 0.6 * e)).multiply(rotAbout(side, -k.neck * 0.5 * eh));
      head?.quaternion.multiply(rotAbout(side, -k.head * eh)).multiply(rotAbout(upAxis, k.shake * shake));
      tail.forEach((b, j) => b.quaternion.multiply(rotAbout(upAxis, (k.bend * 0.7 * e + k.kick * Math.sin(2 * Math.PI * k.tailBeats * u - 0.9 * j) * e) * (0.6 + 0.3 * j))));
      wingPose(k.wings * e, 0);
      return;
    }
    strike(k, e, eh, shake, sway, u);
    mesh.updateMatrixWorld(true);
    for (const L of legs) {
      const p = L.foot0.clone();
      let pitch = 0;
      if (spec.plan === "arachnid") {
        // legs drawn in under the body, pair by pair, front pair first
        const pull = env(u - 0.03 * pairIndex.indexOf(pairOf(L)), k.peak, k.hold) * k.pull;
        p.x *= 1 - pull;
        p.z += (legMidZ - p.z) * pull * 0.6;
        p.y += size * 0.08 * pull;
      } else if (spec.plan === "biped") {
        // back on the heels (toes up); the heavy one stumbles a step back on one foot
        pitch = -k.heels * e;
        if (k.step && L.sgn > 0) {
          const s = ss(u, 0.1, 0.3) - ss(u, 0.6, 0.85);
          p.z -= size * k.step * s;
          p.y += size * 0.04 * (bump(u, 0.08, 0.32) + bump(u, 0.58, 0.87));
        }
      } else if (L === frontPaw) {
        // a front paw lifts off the ground; the heavy one steps back on it and steps up again
        const s = k.step ? ss(u, 0.1, 0.3) - ss(u, 0.6, 0.85) : 0;
        p.z -= size * k.step * s;
        p.y += size * k.paw * (k.step ? bump(u, 0.08, 0.32) + bump(u, 0.58, 0.87) : bump(u, 0.04, 0.75));
      } else if (k.brace && firstPair.includes(L)) {
        p.x *= 1 + 0.15 * e; // the other forefoot braces out
      }
      solveLeg(L, p, V3(), pitch);
    }
  });

  if (spec.plan === "flyer") {
    const g = spec.gaits.Idle ?? spec.gaits.Walk;
    const stall = { spread: 0.8, flap: 0.55, sweep: 0.25, lower: -0.25, twist: 0 };
    const flyHit = (name, dur, k) => bake(name, dur, (t) => {
      const u = t / dur;
      const e = env(u, k.peak, k.hold);
      const tumble = k.tumble * Math.sin(2 * Math.PI * 1.5 * u) * (1 - ss(u, 0.5, 1));
      flyBody(t, g, -k.pitch * e);
      root.position.z -= size * k.back * e;
      root.position.y -= size * k.drop * e;
      root.quaternion.multiply(rotAbout(fwd, k.roll * e + tumble));
      head?.quaternion.multiply(rotAbout(side, -k.head * env(u - 0.04, k.peak, k.hold)))
        .multiply(rotAbout(upAxis, k.shake * bump(u, 0.25, 0.8) * Math.sin(2 * Math.PI * 4 * u)));
      tail.forEach((b, j) => b.quaternion.multiply(rotAbout(side, 0.2 * e * Math.sin(2 * Math.PI * 2 * u - 0.7 * j))));
      mesh.updateMatrixWorld(true);
      flyLegs(t, g, null, 1 + 3 * e);
      // the beat stalls (wings thrown up and back) — a missed beat — then picks up again
      const gb = k.flail ? { ...g, flap: (g.flap ?? 0.6) * 1.4 } : g;
      for (const W of wings) flyWing(W, mixWing(wingBeat(gb, t, W), stall, e * k.stall));
    });
    clips.push(flyHit("Hit", 0.42, { peak: 0.14, hold: 0.3, back: 0.12, drop: 0.08, pitch: 0.35, roll: 0.15, head: 0.3, shake: 0, tumble: 0, stall: 0.9 }));
    clips.push(flyHit("Hit_Heavy", 0.95, { peak: 0.12, hold: 0.4, back: 0.2, drop: 0.3, pitch: 0.5, roll: 0.2, head: 0.4, shake: 0.25, tumble: 0.35, stall: 1, flail: true }));
  } else if (swimmer) {
    clips.push(hitClip("Hit", 0.4, { peak: 0.15, hold: 0.3, lag: 0.05, back: 0.04, side: 0.08, bend: 0.16, neck: 0.2, head: 0.25, kick: 0.25, tailBeats: 2, shake: 0, sway: 0, swayBeats: 1, roll: 0, wings: 0.2 }));
    clips.push(hitClip("Hit_Heavy", 0.9, { peak: 0.12, hold: 0.4, lag: 0.05, back: 0.07, side: 0.12, bend: 0.24, neck: 0.3, head: 0.35, kick: 0.35, tailBeats: 3, shake: 0.25, shakeAt: [0.3, 0.85], shakes: 4, sway: 0.05, swayBeats: 1.5, roll: 0.35, wings: 0.3 }));
  } else {
    const biped = spec.plan === "biped", arach = spec.plan === "arachnid";
    const light = { peak: 0.15, hold: 0.3, lag: 0.06, back: 0.035, dip: 0.006, pitch: biped ? 0.09 : 0.05, roll: 0.04, compress: 0.05, twist: 0.07,
      neck: 0.3, head: 0.22, tilt: 0.08, tail: biped ? 0.14 : 0.1, tailLift: 0.04, tailBeats: 1.5, wings: 0.3, shake: 0, sway: 0, swayBeats: 1,
      paw: 0.035, step: 0, heels: 0.35, pull: 0.12, brace: false };
    const heavy = { ...light, peak: 0.12, hold: 0.42, back: 0.06, dip: 0.015, pitch: biped ? 0.14 : 0.08, roll: 0.07, compress: 0.08, twist: 0.12,
      neck: 0.42, head: 0.3, tilt: 0.12, tail: biped ? 0.22 : 0.16, tailBeats: 2.5, wings: 0.5, shake: 0.22, shakeAt: [0.3, 0.85], shakes: 4,
      sway: 0.025, swayBeats: 1.5, paw: 0.05, step: arach ? 0 : 0.05, heels: 0.5, pull: 0.25, brace: true };
    clips.push(hitClip("Hit", 0.4, { ...light, ...H.light }));
    clips.push(hitClip("Hit_Heavy", 0.9, { ...heavy, ...H.heavy }));
  }
}
console.log(`clips: ${clips.map((c) => `${c.name} ${c.duration.toFixed(2)}s`).join(", ")}`);
console.log(`clipSpeeds (m/s, paste into third-person-controller): ${JSON.stringify(sp)}`);

// ---------------------------------------------------------------- render
if (args.render) {
  const dir = path.resolve(String(args.render));
  fs.mkdirSync(dir, { recursive: true });
  const mixer = new THREE.AnimationMixer(mesh);
  for (const clip of clips) {
    const action = mixer.clipAction(clip);
    action.reset().play();
    const frames = [];
    for (let k = 0; k < 6; k++) {
      // `--full`: the whole clip even where the sheet would show one wing beat
      // (the abdomen's pump and the legs' dangle are slower than the wings)
      const span = (!args.full && sheetSpan.get(clip)) || clip.duration;
      mixer.setTime((k / (clip.name === "Death" ? 5 : 6)) * span * (clip.name === "Death" ? 0.999 : 1));
      mesh.updateMatrixWorld(true);
      skeleton.update();
      const tris = [];
      const v = V3();
      for (let i = 0; i < verts.length; i += 3) {
        const p = [0, 1, 2].map((j) => mesh.applyBoneTransform(i + j, v.fromBufferAttribute(geo.attributes.position, i + j)).clone());
        tris.push({ p, uv: [0, 1, 2].map((j) => [geo.attributes.uv.getX(i + j), geo.attributes.uv.getY(i + j)]), color: [170, 170, 160] });
      }
      frames.push({ tris });
    }
    action.stop();
    // a flyer also gets a view from the front, where a wing beat reads
    const views = [V3(-1, -0.15, 0), V3(-0.6, -0.5, -0.65)];
    if (spec.plan === "flyer" || spec.plan === "biped") views.push(V3(0, -0.2, -1));
    if (spec.plan === "serpent") views.push(V3(0, -1, 0.001));
    const img = renderStrip(frames, views, texImage, +(args.tile ?? 300));
    fs.writeFileSync(path.join(dir, `${args.creature}-${clip.name}.png`), encodePng(img.width, img.height, img.rgba));
  }
  resetPose();
  mesh.updateMatrixWorld(true);
  console.log(`rendered ${clips.length} contact sheets to ${dir}`);
}

// ---------------------------------------------------------------- export
resetPose();
// userData exports as glTF extras; the rest positions were only for building
for (const b of boneList) delete b.userData.rest;
const wrapper = new THREE.Group();
wrapper.name = args.creature;
wrapper.add(mesh);
const outPath = path.resolve(String(args.out));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const glb = await new GLTFExporter().parseAsync(wrapper, { binary: true, onlyVisible: false, animations: clips, maxTextureSize: 4096 });
fs.writeFileSync(outPath, Buffer.from(glb));
console.log(`wrote ${outPath} — ${(glb.byteLength / 1024).toFixed(0)} KB`);
