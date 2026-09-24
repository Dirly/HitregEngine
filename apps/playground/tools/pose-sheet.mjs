/**
 * pose-sheet — LOOK at a character's clips with its held items in its hands,
 * with no browser: one row per clip (per view), one column per sampled frame.
 *
 *   node tools/pose-sheet.mjs --project voxel-demo --scene mmo --actor player-visual \
 *     --equip primary=iron-arming-sword,offhand=iron-heater \
 *     --clips Idle,SwordShield_Idle,SwordShield_Attack1 --frames 6 --out sheet.png
 *
 * Why: whether a sword sits IN a fist or floats beside an open palm, whether a
 * shield rides the forearm or pokes out of the knuckles, is invisible to every
 * number a bake prints and obvious in one picture. And the picture has to come
 * from the game's own data, or it proves nothing: the sockets are read from the
 * scene (every `bone-socket` child of the actor, its offset/rotation/scale, and
 * the item model on it), and the parts from the equipped items' `appearance` —
 * the same inputs the running game uses. Change a socket in the scene, re-run.
 *
 * Body grey, primary item orange, off-hand item blue. `--zoom <bone>` crops to
 * everything within --radius of that bone (a hand, to fit a grip). Views:
 * `front`, `side`, `3q` (three-quarter), `back`, comma-joined; one row each.
 * Judge poses only across the same view — see docs/character-animation.md.
 */
import "./node-dom-shim.mjs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderStrip } from "./_softrender.mjs";
import { encodePng } from "./_png.mjs";
import { drawText, GLYPH_H } from "./_font.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.project) {
  console.log(`
pose-sheet — render a character's clips with its held items, as one PNG

  --project <name>       projects/<name> (assets resolve under its assets/)
  --scene <name>         scene whose sockets to use (assets/scenes/<name>.scene.json)
  --prefab <id>          or a prefab's (assets/prefabs/<id>.json, e.g. characters/player)
  --actor <entity>       the entity carrying the character model (e.g. player-visual)
  --model <asset>        character GLB instead of the actor's mesh (e.g. a test bake)
  --equip slot=item,...  items to hold, by the slot their socket's equipment-look shows
  --clips a,b,c          clips to show (default: every clip)
  --frames <n>           samples per clip, first to last frame (default 6)
  --views front,side,3q  one row per view per clip (default 3q)
  --zoom <bone>          crop to what is within --radius (default 0.4 m) of a bone
  --tile <px>            tile size (default 220)
  --alt                  show sockets in their second pose (bone-socket altOffset/altRotationDeg)
  --override <json>      socket params to try instead of the scene's, by entity:
                         {"player-weapon":{"offset":[0,0,0],"rotationDeg":[0,0,0]}}
  --out <file.png>       output (default pose-sheet.png)
`);
  process.exit(0);
}

const projectDir = path.resolve(here, "..", "projects", args.project);
const assetsDir = path.join(projectDir, "assets");
const assetPath = (id) => path.join(assetsDir, id.startsWith("models/") ? id : path.join("models", id));

function loadGlb(file) {
  const buf = fs.readFileSync(file);
  const warn = console.warn;
  console.warn = () => {}; // textures cannot decode in Node; geometry is all we draw
  return new Promise((resolve, reject) =>
    new GLTFLoader().parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      "",
      (g) => {
        console.warn = warn;
        resolve(g);
      },
      (e) => {
        console.warn = warn;
        reject(e);
      },
    ),
  );
}

// ---- the actor and its sockets, out of the scene
const overrides = args.override ? JSON.parse(String(args.override)) : {};
let modelId = args.model ?? null;
const sockets = [];
if (args.scene || args.prefab) {
  // --prefab reads the sockets out of a prefab doc: the MMO player is prefab
  // characters/player, and its scenes only hold an instance of it
  const scene = JSON.parse(
    fs.readFileSync(
      args.prefab
        ? path.join(assetsDir, "prefabs", `${args.prefab}.json`)
        : path.join(assetsDir, "scenes", `${args.scene}.scene.json`),
      "utf8",
    ),
  );
  const ents = scene.entities ?? {};
  const actor = ents[args.actor];
  if (!actor) {
    console.error(`pose-sheet: no entity "${args.actor}" in ${args.prefab ?? args.scene}`);
    process.exit(1);
  }
  const src = actor.components?.mesh?.source;
  if (!modelId && src?.kind === "asset") modelId = src.assetId;
  const scriptsOf = (e) => [e.components?.script, ...(e.components?.scripts ?? [])].filter(Boolean);
  for (const [id, e] of Object.entries(ents)) {
    if (e.parent !== args.actor) continue;
    const sock = scriptsOf(e).find((s) => s.name === "bone-socket");
    if (!sock) continue;
    const look = Object.values(ents)
      .filter((c) => c.parent === id)
      .flatMap(scriptsOf)
      .find((s) => s.name === "equipment-look");
    const p = { ...(sock.params ?? {}), ...(overrides[id] ?? {}) };
    // --alt: show every socket in its SECOND pose where it has one
    const alt = args.alt && p.altOffset?.length === 3 && p.altRotationDeg?.length === 3;
    sockets.push({
      id,
      bone: (alt && p.altBone) || (p.bone ?? "mixamorig:RightHand"),
      offset: alt ? p.altOffset : (p.offset ?? [0, 0, 0]),
      rotationDeg: alt ? p.altRotationDeg : (p.rotationDeg ?? [0, 90, 0]),
      scale: e.components?.transform?.scale ?? [1, 1, 1],
      model: e.components?.mesh?.source?.assetId ?? null,
      slot: look?.params?.slot ?? null,
    });
  }
}
if (!modelId) {
  console.error("pose-sheet: no character model — pass --scene/--actor or --model");
  process.exit(1);
}

const equip = Object.fromEntries(
  String(args.equip ?? "")
    .split(",")
    .filter(Boolean)
    .map((p) => p.split("=").map((s) => s.trim())),
);

// ---- load
const charPath = fs.existsSync(modelId) ? modelId : assetPath(modelId);
const character = await loadGlb(charPath);
const root = character.scene;
const skinned = [];
root.traverse((o) => {
  if (o.isSkinnedMesh) skinned.push(o);
});

const held = [];
for (const [k, sock] of sockets.entries()) {
  const itemId = sock.slot ? equip[sock.slot] : null;
  if (!itemId || !sock.model) continue;
  const item = JSON.parse(fs.readFileSync(path.join(assetsDir, "items", `${itemId}.json`), "utf8"));
  // as equipment-look does: an item for ANOTHER model is not drawn by this slot
  if (item.appearance?.model && item.appearance.model !== sock.model) continue;
  // one socket per model on a slot (sword + greataxe in one hand): as in
  // equipment-look, only the socket drawing the item's own model shows it
  if (item.appearance?.model && item.appearance.model !== sock.model) continue;
  const gltf = await loadGlb(assetPath(sock.model));
  let parts = null;
  gltf.scene.traverse((o) => {
    if (o.userData?.parts) parts = o.userData.parts;
  });
  const wanted = new Set((item.appearance?.parts ?? []).map((n) => parts?.[n]).filter((n) => n !== undefined));
  const bone = root.getObjectByName(sock.bone) ?? root.getObjectByName(sock.bone.replace(/[\s.:[\]/]/g, ""));
  if (!bone) {
    console.error(`pose-sheet: ${sock.id}: no bone "${sock.bone}" on the character`);
    continue;
  }
  const r = sock.rotationDeg.map((d) => (d * Math.PI) / 180);
  held.push({
    sock,
    bone,
    scene: gltf.scene,
    wanted,
    offsetQ: new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2])),
    color: k === 0 || sock.slot === "primary" ? [235, 150, 60] : [90, 150, 235],
  });
}

// ---- triangles for one moment
const v = new THREE.Vector3();
function bodyTris(out) {
  for (const mesh of skinned) {
    const pos = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    const world = [];
    for (let i = 0; i < pos.count; i++) {
      mesh.getVertexPosition(i, v); // skinned, in the mesh's local space
      world.push(v.clone().applyMatrix4(mesh.matrixWorld));
    }
    for (let t = 0; t < count; t += 3) {
      const a = index ? index.getX(t) : t;
      const b = index ? index.getX(t + 1) : t + 1;
      const c = index ? index.getX(t + 2) : t + 2;
      out.push({ p: [world[a], world[b], world[c]], color: [175, 175, 170] });
    }
  }
}

function heldTris(h, out) {
  // exactly bone-socket's arithmetic: bone world pose, offset in bone axes,
  // rotation offset after the bone's, then the socket entity's own scale
  const bp = h.bone.getWorldPosition(new THREE.Vector3());
  const bq = h.bone.getWorldQuaternion(new THREE.Quaternion());
  const o = h.sock.offset;
  bp.add(new THREE.Vector3(o[0], o[1], o[2]).applyQuaternion(bq));
  const m = new THREE.Matrix4().compose(bp, bq.clone().multiply(h.offsetQ), new THREE.Vector3(...h.sock.scale));
  h.scene.updateMatrixWorld(true);
  h.scene.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const pos = g.getAttribute("position");
    const part = g.getAttribute("uv1");
    const index = g.getIndex();
    const count = index ? index.count : pos.count;
    const mm = m.clone().multiply(mesh.matrixWorld);
    for (let t = 0; t < count; t += 3) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k));
      if (part && h.wanted.size && !h.wanted.has(Math.round(part.getX(ids[0])))) continue;
      out.push({ p: ids.map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mm)), color: h.color });
    }
  });
}

/**
 * `renderStrip` takes screen-right as up × forward, which is camera-LEFT: its
 * pictures are mirror images. Harmless for a symmetric prop; fatal for asking
 * "is the sword in the right hand". Flip each tile back.
 */
function unmirror(img, tileW) {
  const { width, height, rgba } = img;
  for (let y = 0; y < height; y++)
    for (let x0 = 0; x0 < width; x0 += tileW)
      for (let x = 0; x < tileW / 2; x++) {
        const a = (y * width + x0 + x) * 4;
        const b = (y * width + x0 + tileW - 1 - x) * 4;
        for (let k = 0; k < 4; k++) [rgba[a + k], rgba[b + k]] = [rgba[b + k], rgba[a + k]];
      }
  return img;
}

// ---- sample
const VIEWS = {
  front: new THREE.Vector3(0, -0.15, -1),
  back: new THREE.Vector3(0, -0.15, 1),
  side: new THREE.Vector3(-1, -0.15, 0),
  "3q": new THREE.Vector3(-0.75, -0.25, -1),
};
const views = String(args.views ?? "3q")
  .split(",")
  .map((n) => VIEWS[n.trim()] ?? (console.error(`pose-sheet: unknown view "${n}"`), process.exit(1)));
const viewNames = String(args.views ?? "3q").split(",");
const frameCount = Math.max(1, Number(args.frames ?? 6));
const tile = Number(args.tile ?? 220);
const zoomBone = args.zoom ? root.getObjectByName(String(args.zoom)) : null;
if (args.zoom && !zoomBone) {
  console.error(`pose-sheet: no bone "${args.zoom}"`);
  process.exit(1);
}
const radius = Number(args.radius ?? 0.4);

const wantedClips = args.clips ? String(args.clips).split(",").map((s) => s.trim()) : character.animations.map((c) => c.name);
const mixer = new THREE.AnimationMixer(root);
const rows = []; // { label, img }
for (const name of wantedClips) {
  const clip = character.animations.find((c) => c.name === name);
  if (!clip) {
    console.log(`  ! no clip "${name}"`);
    continue;
  }
  const action = mixer.clipAction(clip);
  action.play();
  const frames = [];
  const times = [];
  for (let f = 0; f < frameCount; f++) {
    const t = frameCount === 1 ? 0 : (f / (frameCount - 1)) * clip.duration * 0.999;
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    const tris = [];
    bodyTris(tris);
    for (const h of held) heldTris(h, tris);
    if (zoomBone) {
      const c = zoomBone.getWorldPosition(new THREE.Vector3());
      frames.push({ tris: tris.filter((tr) => tr.p.every((p) => p.distanceTo(c) < radius)) });
    } else frames.push({ tris });
    times.push(t);
  }
  action.stop();
  mixer.uncacheClip(clip);
  for (const [vi, view] of views.entries()) {
    rows.push({ label: `${name} ${viewNames[vi]}`, times, img: unmirror(renderStrip(frames, [view], null, tile), tile) });
  }
}
if (!rows.length) process.exit(1);

// ---- compose, labelled
const width = Math.max(...rows.map((r) => r.img.width));
const height = rows.reduce((s, r) => s + r.img.height, 0);
const rgba = new Uint8Array(width * height * 4);
for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
let y0 = 0;
for (const row of rows) {
  for (let y = 0; y < row.img.height; y++) {
    rgba.set(row.img.rgba.subarray(y * row.img.width * 4, (y + 1) * row.img.width * 4), ((y0 + y) * width) * 4);
  }
  const plot = (color) => (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = (y * width + x) * 4;
    rgba[o] = color[0];
    rgba[o + 1] = color[1];
    rgba[o + 2] = color[2];
  };
  drawText(row.label.replace(/[()]/g, ""), 6, y0 + 6, 2, plot([255, 235, 120]));
  row.times.forEach((t, i) => drawText(t.toFixed(2), i * tile + 6, y0 + row.img.height - GLYPH_H * 2 - 6, 2, plot([150, 200, 150])));
  for (let x = 0; x < width; x++) plot([70, 70, 70])(x, y0); // row divider
  y0 += row.img.height;
}
const out = path.resolve(args.out ?? "pose-sheet.png");
fs.writeFileSync(out, encodePng(width, height, rgba));
console.log(`wrote ${out} — ${rows.length} rows x ${frameCount} frames`);
