#!/usr/bin/env node
/**
 * clip-yaw — how far each clip in a baked GLB turns the body, and the fix for
 * the ones that spin (see _yaw.mjs for what the fix does and why).
 *
 *   node tools/clip-yaw.mjs <file.glb>                    report every clip
 *   node tools/clip-yaw.mjs <file.glb> --preset weapons   report / apply the
 *        `@yaw<deg>` modifiers the preset's selectors carry (rig-map.mjs)
 *   node tools/clip-yaw.mjs <file.glb> --clips "TwoHanded_Block:10:arms,GreatSword_Heavy:60"
 *   ... --write                                            patch the GLB in place
 *   ... --out <other.glb>                                  patch a copy instead
 *
 * `arms` (`@arms` on a selector) keeps the arms' world pose while the torso
 * squares up, so the shoulders reach instead (see _yaw.mjs).
 *
 * The patch rewrites only the hip (and, with arms, clavicle and upper-arm)
 * rotation keys, byte for byte in the binary chunk: same key count, nothing
 * else in the file touched — no re-export, so textures, extras and every
 * other clip survive exactly. A re-bake with retarget applies the same `@yaw`
 * modifiers itself; this is for a GLB that already exists. Re-running is near
 * idempotent (a conditioned clip is inside its limit already).
 *
 * Moving the hips moves the feet: re-measure clipAdvance afterwards
 * (`retarget --measure <glb>`) for any clip it changed.
 */
import "./node-dom-shim.mjs";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import fs from "node:fs";
import path from "node:path";
import { CLIP_PRESETS } from "./rig-map.mjs";
import { yawBones, measureYaw, yawSummary, conditionYaw, rotationTrack } from "./_yaw.mjs";

const argv = process.argv.slice(2);
const flag = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i < 0 ? undefined : argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};
const file = argv.find((a) => !a.startsWith("--") && /\.glb$/i.test(a));
if (!file || flag("help")) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("*/")[0]);
  process.exit(file ? 0 : 1);
}
const hipName = String(flag("hip") ?? "CC_Base_Hip");

/** clip name -> { limit (degrees), arms } */
const limits = new Map();
if (flag("preset")) {
  for (const name of String(flag("preset")).split("+")) {
    const preset = CLIP_PRESETS[name.trim()];
    if (!preset) throw new Error(`clip-yaw: no preset "${name}"`);
    for (const [out, spec] of Object.entries(preset)) {
      const mods = spec.split("@").map((m) => m.trim());
      const yaw = mods.find((m) => /^yaw\d+$/.test(m));
      if (yaw) limits.set(out, { limit: Number(yaw.slice(3)), arms: mods.includes("arms") });
    }
  }
}
if (flag("clips")) {
  for (const part of String(flag("clips")).split(",")) {
    const [name, deg, arms] = part.split(":");
    limits.set(name.trim(), { limit: Number(deg ?? 60), arms: arms?.trim() === "arms" });
  }
}

const buf = fs.readFileSync(file);
const warn = console.warn;
console.warn = () => {};
const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", res, rej),
).finally(() => (console.warn = warn));
const root = gltf.scene;
const bones = yawBones(root, hipName);
if (!bones) throw new Error(`clip-yaw: ${path.basename(file)} has no ${hipName} / upperarm / thigh bones`);

const fmt = (n) => `${n >= 0 ? " " : ""}${n.toFixed(0)}`.padStart(5);
const changed = new Map(); // clip name -> Map(bone name -> its new rotation keys)
console.log(`clip                          chest yaw: lo    hi   net  twist   (0 = facing forward, degrees)`);
for (const clip of gltf.animations) {
  const want = limits.get(clip.name);
  if (limits.size && want === undefined && !flag("all")) continue;
  const s = yawSummary(measureYaw(root, clip, bones));
  let line = `${clip.name.padEnd(30)}${fmt(s.lo)} ${fmt(s.hi)} ${fmt(s.net)} ${fmt(s.twist)}${s.spin ? "  SPIN" : ""}`;
  if (want !== undefined) {
    const res = conditionYaw(root, clip, bones, want.limit, { arms: want.arms });
    if (res) {
      const after = yawSummary(measureYaw(root, clip, bones));
      line += `   -> @yaw${want.limit}${want.arms ? "@arms" : ""}: ${fmt(after.lo)} ${fmt(after.hi)} ${fmt(after.net)}`;
      changed.set(clip.name, new Map(res.bones.map((b) => [b, rotationTrack(clip, b).values])));
    } else line += "   (no hip rotation track)";
  }
  console.log(line);
}

if (!flag("write") && !flag("out")) {
  if (changed.size) console.log(`\n${changed.size} clips would change — --write to patch ${path.basename(file)}`);
  process.exit(0);
}

// ---- patch the BIN chunk in place
const json = JSON.parse(buf.toString("utf8", 20, 20 + buf.readUInt32LE(12)));
const binStart = 20 + buf.readUInt32LE(12) + 8;
const out = Buffer.from(buf);
let patched = 0;
for (const anim of json.animations ?? []) {
  const tracks = changed.get(anim.name);
  if (!tracks) continue;
  for (const [bone, values] of tracks) {
    const node = json.nodes.findIndex((n) => n.name === bone);
    const ch = anim.channels.find((c) => c.target.node === node && c.target.path === "rotation");
    const acc = ch && json.accessors[anim.samplers[ch.sampler].output];
    if (!acc || acc.componentType !== 5126 || acc.count * 4 !== values.length)
      throw new Error(`clip-yaw: ${anim.name} ${bone} keys are not ${values.length / 4} float quaternions`);
    const view = json.bufferViews[acc.bufferView];
    const at = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = view.byteStride ?? 16;
    for (let i = 0; i < acc.count; i++)
      for (let k = 0; k < 4; k++) out.writeFloatLE(values[i * 4 + k], at + i * stride + k * 4);
  }
  patched++;
}
const dest = flag("out") ? String(flag("out")) : file;
fs.writeFileSync(dest, out);
console.log(`\npatched ${patched} clips -> ${dest}\nre-measure clipAdvance: node tools/retarget.mjs --measure ${dest}`);
