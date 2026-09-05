/**
 * retarget — bake an FBX animation library onto a differently-rigged FBX
 * character and write one self-contained GLB the engine can stream.
 *
 *   node tools/retarget.mjs --mesh Char.fbx --anim Library.fbx --out char.glb
 *
 * WHY THIS EXISTS (and why copying the clips across does not work): an
 * animation library and a scanned/auto-rigged character almost never share a
 * skeleton. The pair this was built for differ in bone NAMES (`upperarm_l` vs
 * `CC_Base_L_Upperarm`), in bone COUNT (65 vs 83), in bone AXES, and — the one
 * that silently ruins the result — in REST POSE: the library is modelled on a
 * T-posed rig, the character is auto-rigged in a steep A-pose, arms ~70° apart.
 *
 * Copying local rotations, or three's own `SkeletonUtils.retarget` (which
 * assigns the source's world rotation to the target and assumes matched rests),
 * both give a character whose arms never leave its sides. So:
 *
 *   1. Read the source rig's rest pose.
 *   2. Pose the TARGET rig into that same rest pose, by aligning each mapped
 *      bone's aim direction (see `aim` in rig-map.mjs). Snapshot it. This is
 *      the reference the whole bake is measured against.
 *   3. For every frame, take each source bone's rotation as a DELTA from the
 *      source rest, and apply that delta to the target's aligned rest. Bones
 *      with no source (twists, share bones, face, toes) hold their bind pose.
 *   4. Transfer hip translation, scaled by the height ratio of the two rigs.
 *
 * Bone correspondences live in rig-map.mjs as data. Nothing here is specific
 * to one character.
 */
import "./node-dom-shim.mjs";
import { addTextureSearchRoot } from "./node-dom-shim.mjs";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import fs from "node:fs";
import path from "node:path";
import { RIG_MAPS, CLIP_PRESETS } from "./rig-map.mjs";

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || (!args.mesh && !args.list)) {
  console.log(`
retarget — bake an FBX animation library onto a differently-rigged character

  --mesh <file.fbx>     rigged character (skin + skeleton). Required.
  --anim <file.fbx>     animation library. Omit to export the mesh alone.
  --out  <file.glb>     output. Default: alongside --mesh, same basename.
  --rig  <id>           skeleton map id. Default: cc-base<-ue-mannequin
  --clips <preset|list> preset name(s, joined with +), or Out=Source,Out2=Source2.
                        Default: locomotion. "all" takes every source clip.
  --height <metres>     scale the character to this stature. Default 1.8.
                        Pass "none" to keep the file's own units.
  --fps <n>             resample rate for baked clips. Default 30.
  --list                print the source library's clip names and exit.
  --no-hips             don't transfer hip translation (rotation only).

Examples:
  node tools/retarget.mjs --anim UAL1.fbx --list
  node tools/retarget.mjs --mesh HumanRigged.fbx --anim UAL1.fbx \\
    --out projects/voxel-demo/assets/models/mmo/human.glb
`);
  process.exit(0);
}

// ---------------------------------------------------------------- loading

function loadFbx(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`retarget: no such file: ${abs}`);
    process.exit(1);
  }
  addTextureSearchRoot(path.dirname(abs));
  const buf = fs.readFileSync(abs);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  // Silence the loader's per-curve chatter; a 68MB library emits thousands of
  // lines about unused curves and 5-influence vertices, none actionable here.
  const warn = console.warn;
  console.warn = () => {};
  try {
    return new FBXLoader().parse(ab, path.dirname(abs) + path.sep);
  } finally {
    console.warn = warn;
  }
}

function collectBones(root) {
  const bones = new Map();
  root.traverse((o) => {
    if (o.isBone) bones.set(o.name, o);
  });
  return bones;
}

/** Bones in parent-before-child order, which every pass here depends on. */
function parentFirst(root) {
  const order = [];
  root.traverse((o) => {
    if (o.isBone) order.push(o);
  });
  return order; // Object3D.traverse is already depth-first pre-order
}

function snapshotLocals(bones) {
  const snap = new Map();
  for (const [name, b] of bones) {
    snap.set(name, {
      position: b.position.clone(),
      quaternion: b.quaternion.clone(),
      scale: b.scale.clone(),
    });
  }
  return snap;
}

function restoreLocals(bones, snap) {
  for (const [name, b] of bones) {
    const s = snap.get(name);
    if (!s) continue;
    b.position.copy(s.position);
    b.quaternion.copy(s.quaternion);
    b.scale.copy(s.scale);
  }
}

function worldPositions(root, bones) {
  root.updateMatrixWorld(true);
  const out = new Map();
  const v = new THREE.Vector3();
  for (const [name, b] of bones) out.set(name, b.getWorldPosition(v.clone()));
  return out;
}

function worldQuaternions(root, bones) {
  root.updateMatrixWorld(true);
  const out = new Map();
  for (const [name, b] of bones) out.set(name, b.getWorldQuaternion(new THREE.Quaternion()));
  return out;
}

// ------------------------------------------------- rest-pose reconciliation

/**
 * Pose the target rig into the source rig's rest pose, in place, by aligning
 * every mapped bone's aim direction parent-first. The returned world
 * quaternions are the reference the bake measures deltas against.
 *
 * Aligning one axis leaves roll about the bone's own axis undetermined, and
 * the smallest rotation that does the job is the right answer: at rest both
 * rigs' limbs are STRAIGHT, so there is no elbow or knee bend to recover a
 * roll from, and the parent chain carries it correctly in practice.
 *
 * Resolving roll from the shared world frame instead — an obvious-looking
 * improvement — was tried and is worse: it is degenerate for near-vertical
 * bones, and the neck falling into that case rotates the head 180°. Don't
 * reintroduce it without rendering the head.
 */
function alignTargetRestToSource(tgtRoot, tgtBones, rigMap, srcRestPos, report) {
  const order = parentFirst(tgtRoot);
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const curWorld = new THREE.Quaternion();
  const parentWorld = new THREE.Quaternion();

  for (const bone of order) {
    // an aim may offer several candidates — first one this rig actually has
    const aimName = [rigMap.aim[bone.name]]
      .flat()
      .find((n) => n && tgtBones.has(n) && rigMap.bones[n]);
    if (!aimName) continue;
    const child = tgtBones.get(aimName);
    const srcA = rigMap.bones[bone.name];
    const srcB = rigMap.bones[aimName];
    if (!child || !srcA || !srcB) continue;
    const sa = srcRestPos.get(srcA);
    const sb = srcRestPos.get(srcB);
    if (!sa || !sb) continue;

    tgtRoot.updateMatrixWorld(true);
    bone.getWorldPosition(pa);
    child.getWorldPosition(pb);
    const dCur = pb.clone().sub(pa);
    const dSrc = sb.clone().sub(sa);
    if (dCur.lengthSq() < 1e-12 || dSrc.lengthSq() < 1e-12) continue;
    dCur.normalize();
    dSrc.normalize();

    const angle = (Math.acos(THREE.MathUtils.clamp(dCur.dot(dSrc), -1, 1)) * 180) / Math.PI;
    if (angle > 1) report.push({ bone: bone.name, deg: angle });

    const correction = new THREE.Quaternion().setFromUnitVectors(dCur, dSrc);
    bone.getWorldQuaternion(curWorld);
    const desired = correction.multiply(curWorld);
    if (bone.parent) bone.parent.getWorldQuaternion(parentWorld);
    else parentWorld.identity();
    bone.quaternion.copy(parentWorld.invert().multiply(desired));
    bone.updateMatrixWorld(true);
  }
  return worldQuaternions(tgtRoot, tgtBones);
}

// ---------------------------------------------------------------- the bake

function retargetClip({
  clip,
  outName,
  srcRoot,
  srcBones,
  srcBind,
  srcRestQuat,
  srcRestPos,
  tgtRoot,
  tgtBones,
  tgtBind,
  tgtAlignedQuat,
  rigMap,
  hipScale,
  fps,
  transferHips,
}) {
  const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(frames);

  const order = parentFirst(tgtRoot);
  const tracks = new Map(); // target bone name -> Float32Array of xyzw
  for (const bone of order) {
    if (rigMap.bones[bone.name]) tracks.set(bone.name, new Float32Array(frames * 4));
  }
  const hipBone = tgtBones.get(rigMap.hip);
  const srcHipName = rigMap.bones[rigMap.hip];
  const hipValues = transferHips && hipBone && srcHipName ? new Float32Array(frames * 3) : null;
  const srcHipRestWorld = srcHipName ? srcRestPos.get(srcHipName) : null;
  // Hip travel is measured in WORLD space (that is the only frame the two rigs
  // share) and has to be converted back through the hip's parent before it can
  // be stored as a local translation. Skipping that conversion is not a subtle
  // error: a root bone carrying a Z-up correction — which auto-rigged exports
  // routinely do — sends the whole vertical bob into the forward axis instead,
  // pinning the character at one height while it slides back and forth.
  const hipParent = hipBone?.parent ?? null;
  const tgtHipRestWorld = hipBone ? hipBone.getWorldPosition(new THREE.Vector3()) : null;

  // Fresh mixer per clip: actions cache interpolation state, and we reset the
  // source rig to bind between clips anyway.
  restoreLocals(srcBones, srcBind);
  const mixer = new THREE.AnimationMixer(srcRoot);
  const action = mixer.clipAction(clip);
  action.play();

  const srcWorld = new THREE.Quaternion();
  const parentQ = new THREE.Quaternion();
  const desired = new THREE.Quaternion();
  const localQ = new THREE.Quaternion();
  const hipWorld = new THREE.Vector3();
  const worldByBone = new Map();
  const rootWorldQuat = new THREE.Quaternion();

  for (let f = 0; f < frames; f++) {
    const t = frames === 1 ? 0 : (f / (frames - 1)) * clip.duration;
    times[f] = t;
    mixer.setTime(t);
    srcRoot.updateMatrixWorld(true);

    tgtRoot.getWorldQuaternion(rootWorldQuat);
    worldByBone.clear();

    for (const bone of order) {
      const parent = bone.parent;
      const pq = parent && parent.isBone ? worldByBone.get(parent.name) : null;
      if (pq) parentQ.copy(pq);
      else parentQ.copy(rootWorldQuat);

      const srcName = rigMap.bones[bone.name];
      const srcBone = srcName ? srcBones.get(srcName) : null;
      if (srcBone) {
        srcBone.getWorldQuaternion(srcWorld);
        // delta = animated ∘ rest⁻¹, taken in world space so differing bone
        // axes between the two rigs cancel out
        desired
          .copy(srcWorld)
          .multiply(srcRestQuat.get(srcName).clone().invert())
          .multiply(tgtAlignedQuat.get(bone.name));
        localQ.copy(parentQ).invert().multiply(desired).normalize();
      } else {
        localQ.copy(tgtBind.get(bone.name).quaternion);
      }

      worldByBone.set(bone.name, parentQ.clone().multiply(localQ));

      const buf = tracks.get(bone.name);
      if (buf) {
        buf[f * 4 + 0] = localQ.x;
        buf[f * 4 + 1] = localQ.y;
        buf[f * 4 + 2] = localQ.z;
        buf[f * 4 + 3] = localQ.w;
      }
    }

    if (hipValues) {
      srcBones.get(srcHipName).getWorldPosition(hipWorld);
      hipWorld
        .sub(srcHipRestWorld)
        .multiplyScalar(hipScale)
        .add(tgtHipRestWorld);
      // The hip's parent is never a mapped bone, so its bind matrices still
      // hold and worldToLocal is exact — rotation and any baked-in root scale
      // included.
      if (hipParent) hipParent.worldToLocal(hipWorld);
      hipValues[f * 3 + 0] = hipWorld.x;
      hipValues[f * 3 + 1] = hipWorld.y;
      hipValues[f * 3 + 2] = hipWorld.z;
    }
  }

  action.stop();
  mixer.uncacheClip(clip);
  restoreLocals(srcBones, srcBind);

  const outTracks = [];
  for (const [boneName, values] of tracks) {
    outTracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values));
  }
  if (hipValues) {
    outTracks.push(new THREE.VectorKeyframeTrack(`${rigMap.hip}.position`, times, hipValues));
  }
  return new THREE.AnimationClip(outName, clip.duration, outTracks);
}

// -------------------------------------------------- authored ground speed

/**
 * The speed each baked locomotion clip depicts, in units/sec.
 *
 * In-place clips carry no translation, but the speed is still recoverable:
 * while a foot is PLANTED it slides backwards under the hip at exactly the
 * speed the character is meant to be travelling. So measure that slip, over
 * frames where the toe is genuinely on the ground.
 *
 * Absolute ground height is what makes this work — "the lowest 25% of this
 * foot's own range" calls a sprint's flight frames stance and reads back half
 * the real speed. A sprint's feet are in the air most of the cycle.
 *
 * Without these numbers a controller has to assume every clip was authored at
 * whatever speed its gait happens to be tuned to, and every gap between the
 * two is skating feet.
 */
function measureClipSpeeds(root, bones, clips, rigMap, groundY) {
  const hip = bones.get(rigMap.hip);
  const contacts = (rigMap.contacts ?? []).map((n) => bones.get(n)).filter(Boolean);
  if (!hip || contacts.length === 0) return {};

  const mixer = new THREE.AnimationMixer(root);
  const out = {};
  for (const clip of clips) {
    const N = 120;
    const dt = clip.duration / N;
    if (!(dt > 0)) continue;
    const action = mixer.clipAction(clip);
    action.play();

    const hips = [];
    const feet = contacts.map(() => []);
    for (let i = 0; i <= N; i++) {
      mixer.setTime(clip.duration * (i / N) * 0.999);
      root.updateMatrixWorld(true);
      hips.push(hip.getWorldPosition(new THREE.Vector3()));
      contacts.forEach((c, k) => feet[k].push(c.getWorldPosition(new THREE.Vector3())));
    }
    action.stop();
    mixer.uncacheClip(clip);

    const slips = [];
    for (const track of feet) {
      for (let i = 0; i < track.length - 1; i++) {
        if (track[i].y > groundY || track[i + 1].y > groundY) continue;
        // planted foot, measured against the hip: what is left is the ground
        // sliding past, which is the speed the clip depicts
        const d = track[i].clone().sub(hips[i]).sub(track[i + 1].clone().sub(hips[i + 1]));
        d.y = 0;
        slips.push(d.length() / dt);
      }
    }
    if (slips.length < 6) continue;
    slips.sort((a, b) => a - b);
    const median = slips[Math.floor(slips.length / 2)];
    // Below walking pace it isn't locomotion — it's a turn, a landing or an
    // idle shuffle, where a planted foot pivoting reads as a trickle of slip.
    // Reporting those invites them into a controller that never plays them.
    if (median > 0.5) out[clip.name] = Number(median.toFixed(2));
  }
  return out;
}

// ---------------------------------------------------------------- main

const rigId = args.rig || "cc-base<-ue-mannequin";
const rigMap = RIG_MAPS[rigId];
if (!rigMap) {
  console.error(`retarget: unknown rig map "${rigId}". Known: ${Object.keys(RIG_MAPS).join(", ")}`);
  process.exit(1);
}

let animGroup = null;
if (args.anim) {
  process.stdout.write(`reading ${path.basename(args.anim)} … `);
  const t0 = Date.now();
  animGroup = loadFbx(args.anim);
  console.log(`${animGroup.animations.length} clips (${Date.now() - t0}ms)`);
}

if (args.list) {
  if (!animGroup) {
    console.error("retarget: --list needs --anim");
    process.exit(1);
  }
  for (const c of [...animGroup.animations].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`${c.duration.toFixed(2).padStart(6)}s  ${c.name}`);
  }
  process.exit(0);
}

process.stdout.write(`reading ${path.basename(args.mesh)} … `);
const meshGroup = loadFbx(args.mesh);
const tgtBones = collectBones(meshGroup);
console.log(`${tgtBones.size} bones`);

let skinned = null;
meshGroup.traverse((o) => {
  if (o.isSkinnedMesh && !skinned) skinned = o;
});
if (!skinned) {
  console.error("retarget: --mesh has no skinned mesh.");
  process.exit(1);
}

const tgtBind = snapshotLocals(tgtBones);

// ---- material: FBX gives us Phong, glTF speaks Standard.
const materials = Array.isArray(skinned.material) ? skinned.material : [skinned.material];
const converted = materials.map((m) => {
  const std = new THREE.MeshStandardMaterial({
    name: m.name,
    color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
    map: m.map ?? null,
    normalMap: m.normalMap ?? null,
    roughness: 0.85,
    metalness: 0,
  });
  // glTF stores images top-left-origin; three's FBX textures are bottom-left.
  // Flipping the 3k-vertex UV attribute is the same transform as flipping a
  // 1024² image, minus an image codec — and it lets the PNG land in the GLB
  // byte-for-byte.
  for (const map of [std.map, std.normalMap]) if (map) map.flipY = false;
  return std;
});
skinned.material = Array.isArray(skinned.material) ? converted : converted[0];

const uv = skinned.geometry.attributes.uv;
if (uv) {
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  uv.needsUpdate = true;
}

// ---- scale to a real-world stature
const wrapper = new THREE.Group();
wrapper.name = path.basename(args.out || args.mesh).replace(/\.(glb|gltf|fbx)$/i, "");
wrapper.add(meshGroup);
meshGroup.updateMatrixWorld(true);
const bbox = new THREE.Box3().setFromObject(meshGroup);
const rawHeight = bbox.max.y - bbox.min.y;
let modelScale = 1;
if (args.height !== "none") {
  const wanted = Number(args.height ?? 1.8);
  if (!Number.isFinite(wanted) || wanted <= 0) {
    console.error(`retarget: --height must be a positive number or "none"`);
    process.exit(1);
  }
  modelScale = wanted / rawHeight;
  wrapper.scale.setScalar(modelScale);
  console.log(
    `scale: model is ${rawHeight.toFixed(3)} units tall -> x${modelScale.toFixed(3)} for ${wanted}m`,
  );
}

// ---- bake
const outClips = [];
if (animGroup) {
  const srcBones = collectBones(animGroup);
  const srcBind = snapshotLocals(srcBones);
  const srcRestQuat = worldQuaternions(animGroup, srcBones);
  const srcRestPos = worldPositions(animGroup, srcBones);

  const missingT = Object.keys(rigMap.bones).filter((b) => !tgtBones.has(b));
  const missingS = Object.values(rigMap.bones).filter((b) => !srcBones.has(b));
  if (missingT.length) console.log(`  note: target lacks ${missingT.length} mapped bones: ${missingT.join(", ")}`);
  if (missingS.length) console.log(`  note: source lacks ${missingS.length} mapped bones: ${missingS.join(", ")}`);

  const drivenCount = Object.keys(rigMap.bones).filter((b) => tgtBones.has(b) && srcBones.has(rigMap.bones[b])).length;
  console.log(`driving ${drivenCount}/${tgtBones.size} target bones; the rest hold their bind pose`);

  // height ratio, so hip translation lands in proportion
  const span = (bones, pos, m) => {
    const top = pos.get(m.top);
    const bottom = pos.get(m.bottom);
    return top && bottom ? Math.abs(top.y - bottom.y) : 1;
  };
  const tgtRestPos = worldPositions(meshGroup, tgtBones);
  // Both spans are world-space, because that is the frame hip travel is
  // measured and re-applied in (see retargetClip). The conversion down into
  // the hip's local axes happens there, per frame.
  const tgtSpan = span(tgtBones, tgtRestPos, rigMap.measure);
  const srcSpan = span(srcBones, srcRestPos, rigMap.sourceMeasure);
  const hipScale = tgtSpan / srcSpan;
  console.log(`rig spans: target ${tgtSpan.toFixed(3)} / source ${srcSpan.toFixed(3)} -> hip x${hipScale.toFixed(3)}`);

  const alignReport = [];
  const tgtAlignedQuat = alignTargetRestToSource(meshGroup, tgtBones, rigMap, srcRestPos, alignReport);
  restoreLocals(tgtBones, tgtBind);
  meshGroup.updateMatrixWorld(true);
  alignReport.sort((a, b) => b.deg - a.deg);
  console.log(
    `rest alignment: ${alignReport.length} bones corrected, largest ` +
      alignReport.slice(0, 4).map((r) => `${r.bone} ${r.deg.toFixed(0)}°`).join(", "),
  );

  // which clips
  let wanted;
  const preset = args.clips ?? "locomotion";
  if (preset === "all") {
    wanted = Object.fromEntries(
      animGroup.animations.map((c) => [c.name.replace(/^Armature\|/, ""), c.name]),
    );
  } else if (String(preset).split("+").every((n) => CLIP_PRESETS[n.trim()])) {
    // "locomotion+combat" merges presets left-to-right; later wins on collision.
    wanted = Object.assign(
      {},
      ...String(preset)
        .split("+")
        .map((n) => CLIP_PRESETS[n.trim()]),
    );
  } else {
    wanted = Object.fromEntries(
      String(preset)
        .split(",")
        .map((pair) => {
          const [out, src] = pair.split("=");
          return [out.trim(), (src ?? out).trim()];
        }),
    );
  }

  const byName = new Map(animGroup.animations.map((c) => [c.name, c]));
  const fps = Number(args.fps ?? 30);
  const transferHips = !args["no-hips"];
  for (const [outName, srcName] of Object.entries(wanted)) {
    const clip = byName.get(srcName) ?? byName.get(`Armature|${srcName}`);
    if (!clip) {
      console.log(`  ! skipped "${outName}" — no source clip "${srcName}"`);
      continue;
    }
    const baked = retargetClip({
      clip,
      outName,
      srcRoot: animGroup,
      srcBones,
      srcBind,
      srcRestQuat,
      srcRestPos,
      tgtRoot: meshGroup,
      tgtBones,
      tgtBind,
      tgtAlignedQuat,
      rigMap,
      hipScale,
      fps,
      transferHips,
    });
    outClips.push(baked);
    console.log(
      `  ${outName.padEnd(18)} ${baked.duration.toFixed(2)}s  ${baked.tracks.length} tracks  <- ${srcName}`,
    );
  }
  restoreLocals(tgtBones, tgtBind);
  meshGroup.updateMatrixWorld(true);

  // What speed does each clip actually depict? The controller needs this to
  // play them at the right rate; without it the feet skate by exactly the
  // ratio between the clip and whatever the gait is tuned to.
  const groundY = new THREE.Box3().setFromObject(meshGroup).min.y + 0.06 * modelScale;
  const speeds = measureClipSpeeds(meshGroup, tgtBones, outClips, rigMap, groundY);
  restoreLocals(tgtBones, tgtBind);
  meshGroup.updateMatrixWorld(true);
  if (Object.keys(speeds).length) {
    console.log("\nauthored ground speed per clip (units/sec):");
    for (const [name, v] of Object.entries(speeds)) console.log(`  ${name.padEnd(18)} ${v}`);
    console.log(
      "\npaste into the third-person-controller's clipSpeeds param:\n  " +
        JSON.stringify(speeds),
    );
  }
}

// ---- export
const outPath = path.resolve(
  args.out || path.join(path.dirname(args.mesh), path.basename(args.mesh).replace(/\.fbx$/i, ".glb")),
);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const exporter = new GLTFExporter();
const gltf = await exporter.parseAsync(wrapper, {
  binary: true,
  onlyVisible: false,
  animations: outClips,
  maxTextureSize: 4096,
});
fs.writeFileSync(outPath, Buffer.from(gltf));
console.log(
  `\nwrote ${path.relative(process.cwd(), outPath)} — ${(gltf.byteLength / 1024 / 1024).toFixed(2)} MB, ` +
    `${outClips.length} clips: ${outClips.map((c) => c.name).join(", ")}`,
);
