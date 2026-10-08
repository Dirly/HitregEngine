/**
 * autorig — bind an UNRIGGED mesh to a donor rig's skeleton, so a whole
 * animation library made for one creature drives another.
 *
 *   node tools/autorig.mjs --mesh Wolf.obj --rig Dog.glb --out wolf.glb
 *
 * WHY THIS EXISTS (and why it is not retarget.mjs): retarget bakes clips from
 * one SKELETON onto another. Here the target has no skeleton at all — it is a
 * modelled mesh — so there is nothing to bake onto. Instead we take the donor's
 * skeleton itself, warp it into the target's proportions, and skin the target
 * to it. The clips then need no baking: they are the donor's, untouched.
 *
 * That last part is the whole trick, and it only works because of one rule
 * this tool never breaks: **bone ROTATIONS are the donor's, only bone OFFSETS
 * move.** An animation clip sets local rotations absolutely, so a skeleton
 * with the donor's hierarchy, the donor's rest rotations, and its own limb
 * lengths plays the donor's clips exactly — a wolf-shaped dog. Change a rest
 * rotation and every clip is silently wrong from that bone down.
 *
 * The fit is a landmark warp. Both meshes are measured for the same anatomical
 * points (ground, belly, back, nose, tail, the two leg columns, half-width),
 * and the donor's bone positions are mapped through the piecewise-linear
 * transform those landmark pairs define. The head gets its own similarity fit,
 * because a skull's height is set by where it hangs off the neck, not by the
 * torso's vertical profile.
 *
 * REST POSE IS THE ONE JUDGMENT CALL. We fit in a REFERENCE POSE, and the
 * closer that pose is to how the target was modelled, the better everything
 * lands. A rig's bind pose is often not it — this dog's bind pose has the tail
 * straight out behind, while every one of its clips lets the tail hang, and
 * the wolf is modelled with a hanging tail. So the default is `avg:<clip>`:
 * the average pose over a locomotion cycle, which for a quadruped is a
 * neutral stand with the tail where the animation actually keeps it. Fitting
 * to the bind pose instead would bind the hanging tail geometry to bones
 * pointing backwards, and the first frame of any clip would fold it under the
 * belly.
 */
import "./node-dom-shim.mjs";
import { smoothNormals } from "./_normals.mjs";
import { addTextureSearchRoot } from "./node-dom-shim.mjs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { decodePng, encodePng } from "./_png.mjs";
import { sanitizeFbx } from "./_fbx.mjs";
import { resolveChain, bakeDangle, DANGLE_DEFAULTS } from "./_dangle.mjs";
import { normalizeLoop } from "./_clips.mjs";
import { discoverLimbs, discoverSpine, buildGaitClip, buildIdleClip, GAITS, rng } from "./_gait.mjs";
import fs from "node:fs";
import path from "node:path";

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
// faces further apart than this keep a hard edge (tools/_normals.mjs); thin fins/ears stay two-sided
const CREASE = Number(args.crease ?? 100);

if (args.help || !args.mesh || !args.rig) {
  console.log(`
autorig — skin an unrigged mesh to a donor rig's skeleton and clips

  --mesh <file>        target mesh: .obj, .glb/.gltf or .fbx. No skeleton needed.
  --rig  <file>        donor: a skinned mesh with a skeleton and clips (.glb or .fbx).
  --out  <file.glb>    output. Default: alongside --mesh, same basename.
  --forward <axis>     which way the TARGET faces: +x -x +z -z. Default +z.
  --texture <file>     base colour map for the target (default: the .mtl's map_Kd).
  --pose <ref>         reference pose to fit in: "bind", "avg:Walk" (default:
                       the average over the walk, else trot, run, idle),
                       or "Walk@0.25".
  --height <m|none>    scale the result to this total height. Default: none.
  --clips <all|list>   donor clips to carry over, as names or Out=Source pairs
                       (e.g. Idle=Idle_Alert,Walk,Run). Default all.
  --dangle [bones]     re-solve a hanging chain (a tail) as a rope under
                       gravity instead of playing the donor's keyed one.
                       Bare = the first bone matching /tail/; else a
                       comma-separated list of chain-root bone names.
  --dangle-gravity <n> pull, in chain-lengths/s². Default ${DANGLE_DEFAULTS.gravity}. Higher = heavier.
  --dangle-stiffness <n> return to the rig's carried pose. Default ${DANGLE_DEFAULTS.stiffness}. 0 = dead rope.
  --dangle-damping <n> velocity bled per step, 0..1. Default ${DANGLE_DEFAULTS.damping}. This is the lag.
  --dangle-floor <none> let the chain pass through the ground.
  --gait [spec]        GENERATE locomotion from the animal's proportions instead
                       of borrowing it. Bare = Idle,Walk,Run. Otherwise
                       Name=kind pairs, kind in idle/walk/trot/bound/gallop
                       (e.g. "Idle=idle,Walk=walk,Run=bound"). Run defaults to
                       gallop; rodents and mustelids want bound, and nothing
                       measurable tells them apart, so say so.
  --gait-seed <n>      per-creature jitter in stride, lift, duty and flex.
  --gait-<name>-speed  override a generated clip's depicted speed, m/s.
                       Kinds also include lumber (bear/boar) and prowl (big cat).
  --gait-sway <deg>    roll hips and shoulders once per generated stride.
  --gait-ankle none    let the gait's IK drive the toes too (default: stop at
                       the ankle; legs are re-solved two-bone, paw on the shin).
  --death collapse[:left|right]  GENERATE Death: buckle, fold, roll onto the
                       side, head down last (--death-time s, default 1.4).
  --attack gore        GENERATE Bite as a horn/tusk drive and upward hook.
  --call roar[:Clip]   GENERATE the call clip (default Roar) as a standing roar:
                       legs planted, chest up, head raised and thrust forward
                       (--call-time s, default 2.3). For the big cats.
  --ground-fix none    skip the per-clip grounding pass (feet to the floor,
                       nothing under it; see docs, 2026-10-06).
  --ground-ik-max <deg> per-joint limit of the grounding IK. Default 20.
  --ground-swing solve borrowed clips: also solve the donor's LIFTED feet to
                       its scaled heights (default: only planted feet are
                       solved; a swinging leg keeps the donor's motion).
  --flight <[Clip:]k>  borrowed clips keep only k of the donor's foot heights
                       (a dog's gallop leaps; Run:0.5 for a horse).
  --head-pose <clip|none> neck/head/tail world rotations from this clip's
                       average when fitting in an idle (default the walk).
  --keep-ears          let Ear_* bones take weights (separate flopping ears).
  --no-midline         keep raw weights on midline verts between a limb pair.
  --hits <none>        Hit (0.4 s flinch) and Hit_Heavy (0.9 s stagger) are
                       GENERATED on every rig from its Idle (no donor has them);
                       none skips them. --hit-scale <f | Hit=f,Hit_Heavy=f>
                       scales the jerk down for a stiff-necked animal.
  --damp <[Clip:]Bone=f,…> play only f of a bone's keyed rotation (0 = held at
                       the reference pose): a heavy, short-necked head.
  --loop-fix <none>    keep the donor's key timing, hitch and all.
  --influences <n>     max bones per vertex. Default 4.
  --falloff <p>        weight falloff exponent; higher = more rigid. Default 4.
  --head-fit <mode>    "similarity" (default) or "warp".
  --no-symmetry        keep the reference pose's own left/right asymmetry.
  --relax <n>          settle joints into the target's limbs, n passes. Default 2.
  --render <file.png>  textured contact sheet (side + three-quarter) of --clip.
  --clip <a[,b,...]>   clip(s) to render; several write <file>-<Clip>.png each.
  --frames <n>         frames per sheet. Default 4.  --tile <px>: frame size, 300.
  --skip <a,b>         donor bones that may never receive weights. Default root,
                       plus every chin/jaw/nose/tongue/mouth bone (--keep-jaw
                       to allow those: only for a mesh with a separate jaw).
  --belly <between>    measure the belly between the leg columns (hoofed animals
                       standing with feet together). Default: whole torso.
  --measure-skip <Part,…> parts left out of the landmark measurement (horns,
                       antlers): an appendage is not the nose or the back.
  --ground             stand the mesh on y = 0 before fitting (a mesh modelled
                       centred on the origin).
  --bind <Part=bone,…> pin a named part (an OBJ object) whole to one donor bone;
                       Part=A|B|C blends it among those bones only (a mane
                       down a neck); Part@z>1.0@y<1.1=… only that region of
                       it (fitted frame: +Z forward, feet on y = 0).
                       An unwrap's -parts.obj also carries its part index
                       (TEXCOORD_1 + "parts") into the output, so it stays an
                       ubermesh.
  --report             print the landmark table and every fitted bone.
  --preview <clip>     ASCII side view of the skinned result, 4 frames.

Example:
  node tools/autorig.mjs --mesh Wolf.obj --rig Dog.glb --forward +x \\
    --texture Wolf.png --out projects/voxel-demo/assets/models/mmo/wolf.glb
`);
  process.exit(args.help ? 0 : 1);
}

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const f3 = (v) => `(${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)})`;

// ---------------------------------------------------------------- loading

function readBuffer(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`autorig: no such file: ${abs}`);
    process.exit(1);
  }
  addTextureSearchRoot(path.dirname(abs));
  const buf = fs.readFileSync(abs);
  // sanitizeFbx is a no-op on anything three would already have taken; see _fbx.mjs.
  const ab =
    path.extname(abs).toLowerCase() === ".fbx"
      ? sanitizeFbx(buf)
      : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { abs, buf, ab };
}

function loadGltf(file) {
  const { abs, ab } = readBuffer(file);
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(ab, path.dirname(abs) + path.sep, resolve, reject);
  });
}

/** Concatenate positions/normals/uvs into one non-indexed geometry. */
function mergeGeometries(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const count = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  // which named part (an OBJ object) each vertex came from, for --bind and the
  // ubermesh part index
  const partOf = [];
  let o = 0;
  for (const g of parts) {
    for (let i = 0; i < g.attributes.position.count; i++) partOf.push(g.userData.partName ?? "");
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(o + i) * 3] = p.getX(i);
      pos[(o + i) * 3 + 1] = p.getY(i);
      pos[(o + i) * 3 + 2] = p.getZ(i);
      if (n) {
        nrm[(o + i) * 3] = n.getX(i);
        nrm[(o + i) * 3 + 1] = n.getY(i);
        nrm[(o + i) * 3 + 2] = n.getZ(i);
      }
      if (t) {
        uv[(o + i) * 2] = t.getX(i);
        uv[(o + i) * 2 + 1] = t.getY(i);
      }
    }
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  // smooth shading, whatever the source carried (an unwrapped OBJ is flat): tools/_normals.mjs
  out.setAttribute("normal", new THREE.BufferAttribute(smoothNormals(pos, CREASE), 3));
  out.userData.partOf = partOf;
  return out;
}

/**
 * The donor rig. GLB or FBX — an animation library is as good a donor in one
 * format as the other, and most of the quadruped libraries worth borrowing from
 * ship FBX. Two things differ about an FBX donor and neither is fixable here:
 * its clips are usually named `Armature|Walk`, so `--clips` needs the full
 * name (`Walk=Armature|Walk`), and it may arrive at 100× scale — harmless,
 * because the fit is by landmark and `--height` sets the stature anyway.
 */
async function loadRig(file) {
  if (path.extname(file).toLowerCase() !== ".fbx") return loadGltf(file);
  const { abs, ab } = readBuffer(file);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const group = new FBXLoader().parse(ab, path.dirname(abs) + path.sep);
    return { scene: group, animations: group.animations ?? [] };
  } finally {
    console.warn = warn;
  }
}

/** The target mesh. Everything but the geometry and its texture is thrown away. */
async function loadTargetGeometry(file) {
  const ext = path.extname(file).toLowerCase();
  const { abs, buf, ab } = readBuffer(file);
  if (ext === ".obj") {
    const text = buf.toString("utf8");
    const group = new OBJLoader().parse(text);
    const geos = [];
    group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.userData.partName = o.name;
      geos.push(o.geometry);
    });
    if (!geos.length) {
      console.error("autorig: --mesh has no geometry");
      process.exit(1);
    }
    let texture = null;
    const mtl = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
    if (mtl) {
      const mtlPath = path.join(path.dirname(abs), mtl);
      if (fs.existsSync(mtlPath)) {
        const map = /^\s*map_Kd\s+(.+)$/m.exec(fs.readFileSync(mtlPath, "utf8"))?.[1]?.trim();
        if (map) texture = path.join(path.dirname(mtlPath), map);
      }
    }
    return { geometry: mergeGeometries(geos), texture };
  }
  if (ext === ".fbx") {
    const warn = console.warn;
    console.warn = () => {};
    let group;
    try {
      group = new FBXLoader().parse(ab, path.dirname(abs) + path.sep);
    } finally {
      console.warn = warn;
    }
    const geos = [];
    let texture = null;
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      geos.push(g);
      const m = [].concat(o.material)[0];
      if (!texture && m?.map?.image?.resolvedPath) texture = m.map.image.resolvedPath;
    });
    return { geometry: mergeGeometries(geos), texture };
  }
  const gltf = await loadGltf(file);
  const geos = [];
  let texture = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    geos.push(g);
    const m = [].concat(o.material)[0];
    if (!texture && m?.map?.image?.resolvedPath) texture = m.map.image.resolvedPath;
  });
  return { geometry: mergeGeometries(geos), texture };
}

// ---------------------------------------------------------------- poses

/** World matrix per bone in the donor's BIND pose, straight off the skin. */
function bindWorldMatrices(skinned) {
  const out = new Map();
  skinned.skeleton.bones.forEach((b, i) => {
    out.set(b.name, new THREE.Matrix4().copy(skinned.skeleton.boneInverses[i]).invert());
  });
  return out;
}

/** Sign-aligned linear average; exact enough for the small spreads of one cycle. */
function averageQuaternions(list) {
  const first = list[0];
  const sum = [0, 0, 0, 0];
  for (const q of list) {
    const s = q.dot(first) < 0 ? -1 : 1;
    sum[0] += q.x * s;
    sum[1] += q.y * s;
    sum[2] += q.z * s;
    sum[3] += q.w * s;
  }
  return new THREE.Quaternion(sum[0], sum[1], sum[2], sum[3]).normalize();
}

/**
 * The pose we fit in. `avg:<clip>` averages local TRS over a cycle — for a
 * quadruped that is a neutral stand, and (unlike the bind pose) it puts the
 * tail and head where the animation actually keeps them.
 */
function referencePose(spec, scene, skinned, clips, alt = null) {
  const legSpec = alt?.spec ?? null;
  const bones = skinned.skeleton.bones;
  if (spec === "bind") return { name: "bind", world: bindWorldMatrices(skinned) };

  const avg = spec.startsWith("avg:");
  const body = avg ? spec.slice(4) : spec;
  const [clipName, atRaw] = body.split("@");
  const clip =
    clips.find((c) => c.name === clipName) ??
    clips.find((c) => c.name.toLowerCase() === clipName.toLowerCase());
  if (!clip) {
    console.error(
      `autorig: --pose names no clip "${clipName}" (have ${clips.map((c) => c.name).join(", ")})`,
    );
    process.exit(1);
  }

  const mixer = new THREE.AnimationMixer(scene);
  mixer.clipAction(clip).play();
  const samples = avg ? 32 : 1;
  const acc = new Map(bones.map((b) => [b.name, { p: V3(), q: [], s: V3() }]));
  for (let i = 0; i < samples; i++) {
    const t = avg ? (i / samples) * clip.duration : Number(atRaw ?? 0);
    mixer.setTime(t);
    for (const b of bones) {
      const a = acc.get(b.name);
      a.p.add(b.position);
      a.s.add(b.scale);
      a.q.push(b.quaternion.clone());
    }
  }
  // alt: some bones (the neck, head and tail) take their WORLD rotation from
  // ANOTHER clip's average — world, not local: an alert idle carries its
  // chest pitched, and the walk's neck locals set on it would point the head
  // where neither clip ever holds it.
  let legClip = null;
  if (legSpec && legSpec !== "none") {
    const nm = legSpec.replace(/^avg:/, "");
    legClip = clips.find((c) => c.name === nm) ?? clips.find((c) => c.name.toLowerCase() === nm.toLowerCase());
  }
  const setBase = () => {
    for (const b of bones) {
      const a = acc.get(b.name);
      b.position.copy(a.p).multiplyScalar(1 / samples);
      b.scale.copy(a.s).multiplyScalar(1 / samples);
      b.quaternion.copy(averageQuaternions(a.q));
    }
    scene.updateMatrixWorld(true);
  };
  // stop first: stopping restores the bones the mixer touched
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);
  setBase();
  if (legClip) {
    // straight off the tracks: a mixer switched from one clip to another
    // restores, then never rewrites, a constant track (the dog's pelvis)
    const its = new Map(legClip.tracks.map((tr) => [tr.name, tr.createInterpolant()]));
    const altQ = new Map();
    for (const b of bones) {
      const iq = its.get(`${b.name}.quaternion`);
      if (!iq) continue;
      const qs = [];
      for (let i = 0; i < 32; i++) qs.push(new THREE.Quaternion().fromArray(iq.evaluate((i / 32) * legClip.duration)));
      altQ.set(b.name, averageQuaternions(qs));
    }
    for (const b of bones) if (altQ.has(b.name)) b.quaternion.copy(altQ.get(b.name));
    scene.updateMatrixWorld(true);
    const altWorld = new Map(bones.map((b) => [b.name, b.getWorldQuaternion(new THREE.Quaternion())]));
    setBase();
    for (const b of bones) {
      if (!alt.bones.has(b.name)) continue;
      const pw = b.parent.getWorldQuaternion(new THREE.Quaternion());
      b.quaternion.copy(pw.invert().multiply(altWorld.get(b.name)));
      b.updateMatrixWorld(true);
    }
    scene.updateMatrixWorld(true);
  }
  const world = new Map(bones.map((b) => [b.name, b.matrixWorld.clone()]));
  return { name: (avg ? `avg over ${clip.name}` : `${clip.name}@${atRaw ?? 0}`) + (legClip ? `, neck/head/tail avg over ${legClip.name}` : ""), world };
}

/** `Front_Leg_L` <-> `Front_Leg_R`. Null when a bone is on the midline. */
/**
 * The name of a bone's opposite number, or null if it looks like a centre bone.
 *
 * Worth covering every convention, because getting it wrong is silent and
 * catastrophic: an unrecognised side suffix means the bone finds no twin, gets
 * folded onto its own mirror, and its x averages to ZERO — both legs on one
 * side collapse onto the spine and the mesh binds to a flat skeleton. That is
 * what a Blender rig naming its bones `BackFootR` / `FrontUpLegL` did here.
 */
function mirrorName(name) {
  const flip = { L: "R", R: "L", l: "r", r: "l" };
  const sep = /^(.*)([_.\-| ])([LlRr])$/.exec(name);
  if (sep) return `${sep[1]}${sep[2]}${flip[sep[3]]}`;
  // Plain camelCase sides, with no separator at all.
  const bare = /^(.*[a-z0-9])([LR])$/.exec(name);
  if (bare) return `${bare[1]}${bare[2] === "L" ? "R" : "L"}`;
  const word = /^(.*)(Left|Right|left|right)(.*)$/.exec(name);
  if (word) {
    const w = { Left: "Right", Right: "Left", left: "right", right: "left" }[word[2]];
    return `${word[1]}${w}${word[3]}`;
  }
  return null;
}

/**
 * A bone with no twin is assumed to be on the centre line, which is what lets
 * the fold straighten a leaning spine. When it plainly is NOT — it sits out at
 * the side of the body — the pairing failed rather than the bone being central,
 * and centring it would be the destructive answer.
 */
const offCentre = (x, scale) => Math.abs(x) > 0.08 * scale;

const CENTRE_BONE = /spine|neck|head|nose|chin|jaw|tail|hips?$|pelvis$|chest|torso|stomach|belly|root|body|back$/i;
const mirrorPos = (p) => V3(-p.x, p.y, p.z);
/** Mirroring x flips the handedness of a rotation: (x,y,z,w) -> (x,-y,-z,w). */
const mirrorQuat = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);

/**
 * Fold the reference pose onto its own mirror. A pose sampled or averaged out
 * of a gait is never quite symmetric — one foreleg leads — and any asymmetry
 * left in it is baked into the bind pose, where it shows up as a permanent
 * limp on a target that was modelled standing square.
 */
function symmetrise(world) {
  const decomposed = new Map();
  for (const [name, m] of world) {
    const p = V3();
    const q = new THREE.Quaternion();
    const s = V3();
    m.decompose(p, q, s);
    decomposed.set(name, { p, q, s });
  }
  let widest = 1e-6;
  for (const { p } of decomposed.values()) widest = Math.max(widest, Math.abs(p.x));
  const orphans = [];
  for (const [name, { p, q, s }] of decomposed) {
    const other = mirrorName(name);
    const twin = other ? decomposed.get(other) : null;
    // a bone NAMED for the midline (spine, neck, head, tail…) is central
    // however far the pose has swung it: an alert idle looks round, and its
    // average leaves the chest and neck a hand's width off the centre line
    if (!twin && offCentre(p.x, widest) && !CENTRE_BONE.test(name)) {
      orphans.push(name);
      continue;
    }
    const p2 = twin ? mirrorPos(twin.p) : mirrorPos(p);
    const q2 = twin ? mirrorQuat(twin.q) : mirrorQuat(q);
    const avgP = p.clone().add(p2).multiplyScalar(0.5);
    // Half-turn apart, the average is degenerate — there is no midpoint to
    // pick, so leave that bone as it was rather than snap it to identity.
    const avgQ = Math.abs(q.dot(q2)) < 0.05 ? q : averageQuaternions([q, q2]);
    world.set(name, new THREE.Matrix4().compose(avgP, avgQ, s));
  }
  if (orphans.length) {
    console.log(
      `  ! ${orphans.length} off-centre bone(s) have no mirror twin and were left alone: ` +
        `${orphans.slice(0, 6).join(", ")}${orphans.length > 6 ? " …" : ""}`,
    );
  }
  return world;
}

/**
 * The donor's vertices, skinned into `world`. This is what gets measured.
 *
 * The bind matrix and the mesh's own placement are not bookkeeping here. A GLB
 * usually carries identity for both, so leaving them out costs nothing and
 * looks correct forever — until an FBX arrives with its mesh under a
 * transformed `Armature` node, and the whole point cloud lands somewhere the
 * bones are not. Every landmark is then measured off a body floating clear of
 * its own skeleton, the warp maps nothing onto anything, and the result is a
 * mesh bound to three bones. Same arithmetic as three's own skinning shader.
 */
function skinnedPoints(skinned, world) {
  const geo = skinned.geometry;
  const pos = geo.attributes.position;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const bones = skinned.skeleton.bones;
  const mats = bones.map((b, i) =>
    new THREE.Matrix4().multiplyMatrices(world.get(b.name), skinned.skeleton.boneInverses[i]),
  );
  const pre = skinned.bindMatrix ?? new THREE.Matrix4();
  const post = new THREE.Matrix4()
    .copy(skinned.matrixWorld)
    .multiply(skinned.bindMatrixInverse ?? new THREE.Matrix4());
  const out = [];
  const v = V3();
  const t = V3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(pre);
    const acc = V3();
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w <= 0) continue;
      t.copy(v).applyMatrix4(mats[si.getComponent(i, k)]);
      acc.addScaledVector(t, w);
      total += w;
    }
    out.push(total > 0 ? acc.multiplyScalar(1 / total).applyMatrix4(post) : v.clone().applyMatrix4(post));
  }
  return out;
}

// ---------------------------------------------------------------- landmarks

/** Exact 1-D 2-means: the split that minimises within-cluster variance. */
function split2(values) {
  const v = [...values].sort((a, b) => a - b);
  if (v.length < 2) return { lo: v, hi: v };
  const pre = [0];
  const pre2 = [0];
  for (let i = 0; i < v.length; i++) {
    pre.push(pre[i] + v[i]);
    pre2.push(pre2[i] + v[i] * v[i]);
  }
  const sse = (a, b) => {
    const n = b - a;
    if (n <= 0) return 0;
    const s = pre[b] - pre[a];
    return pre2[b] - pre2[a] - (s * s) / n;
  };
  let best = Infinity;
  let at = 1;
  for (let i = 1; i < v.length; i++) {
    const e = sse(0, i) + sse(i, v.length);
    if (e < best) {
      best = e;
      at = i;
    }
  }
  return { lo: v.slice(0, at), hi: v.slice(at) };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
};

/**
 * The same handful of numbers off any quadruped point cloud (+Z forward, Y up).
 * Both meshes go through this, and the pairs define the warp.
 */
const BELLY_LEGACY = args.belly !== "between";
function measure(points) {
  const box = new THREE.Box3().setFromPoints(points);
  const height = box.max.y - box.min.y;
  const halfWidth = Math.max(...points.map((p) => Math.abs(p.x)));

  // Leg columns: low, and off the midline — which is what keeps a hanging tail
  // (central) and a lowered head (central) out of the clustering.
  const legPts = points.filter(
    (p) => p.y < box.min.y + 0.35 * height && Math.abs(p.x) > 0.45 * halfWidth,
  );
  const { lo, hi } = split2(legPts.map((p) => p.z));
  const backLegZ = median(lo);
  const frontLegZ = median(hi);
  const legHalfX = median(legPts.map((p) => Math.abs(p.x)));

  const torso = points.filter((p) => p.z >= backLegZ && p.z <= frontLegZ);
  const backY = torso.length ? Math.max(...torso.map((p) => p.y)) : box.max.y;
  const midline = torso.filter((p) => Math.abs(p.x) < 0.3 * halfWidth);
  // The belly is looked for between the leg columns, not over them: an animal
  // standing with its hooves close together (a horse, a lion) has leg geometry
  // inside the midline band, and the minimum lands on the floor — which maps
  // the donor's belly to the ground and drops every knee and elbow to the
  // hooves. Opt in with `--belly between`; the default stays the whole-torso
  // minimum so existing rigs (lion, goat) re-bake identically.
  const span = frontLegZ - backLegZ;
  const between = midline.filter((p) => p.z > backLegZ + 0.3 * span && p.z < frontLegZ - 0.3 * span);
  const bellyPts = BELLY_LEGACY || between.length < 8 ? midline : between;
  const bellyY = bellyPts.length ? Math.min(...bellyPts.map((p) => p.y)) : box.min.y;

  const headFrom = (frontLegZ + box.max.z) / 2;
  const headPts = points.filter((p) => p.z > headFrom);
  const headBox = headPts.length ? new THREE.Box3().setFromPoints(headPts) : box.clone();

  return {
    groundY: box.min.y,
    topY: box.max.y,
    noseZ: box.max.z,
    tailZ: box.min.z,
    halfWidth,
    legHalfX,
    frontLegZ,
    backLegZ,
    bellyY,
    backY,
    headFrom,
    headBox,
    box,
  };
}

/** Piecewise-linear through the knot pairs, linear beyond the ends. */
function piecewise(from, to) {
  const pairs = from.map((v, i) => [v, to[i]]).sort((a, b) => a[0] - b[0]);
  return (x) => {
    if (x <= pairs[0][0]) {
      const [[x0, y0], [x1, y1]] = pairs;
      return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0 || 1);
    }
    for (let i = 1; i < pairs.length; i++) {
      const [x0, y0] = pairs[i - 1];
      const [x1, y1] = pairs[i];
      if (x <= x1) return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0 || 1);
    }
    const [[x0, y0], [x1, y1]] = pairs.slice(-2);
    return y1 + ((x - x1) * (y1 - y0)) / (x1 - x0 || 1);
  };
}

// ---------------------------------------------------------------- skinning

/** A bone's shape is the span to each of its children; a leaf is just a point. */
function boneSegments(nodes) {
  const segs = new Map();
  for (const n of nodes) {
    const kids = nodes.filter((c) => c.parent === n);
    segs.set(
      n.name,
      kids.length
        ? kids.map((c) => ({ a: n.worldPos, b: c.worldPos, aName: n.name, bName: c.name }))
        : [{ a: n.worldPos, b: n.worldPos, aName: n.name, bName: n.name }],
    );
  }
  return segs;
}

/**
 * Settle each joint into the middle of the geometry that surrounds it. The
 * landmark warp gets a skeleton the right SIZE; this gets it inside the limbs
 * — it is what walks the tail chain down a hanging tail the donor holds out
 * straight behind. Positions only, never rotations: a joint may be moved
 * anywhere (the bind pose is whatever we declare it to be), but a rotation
 * belongs to the donor's clips and moving one breaks every frame below it.
 */
function relaxJoints(nodes, points, passes, pinned) {
  for (let pass = 0; pass < passes; pass++) {
    const segs = boneSegments(nodes);
    const flat = nodes.flatMap((n) => segs.get(n.name));
    const buckets = new Map(nodes.map((n) => [n.name, []]));
    for (const p of points) {
      let best = null;
      for (const s of flat) {
        const d = distanceToSegment(p, s.a, s.b);
        // Credit the nearer END: a joint is settled by the geometry around IT,
        // not by everything the whole bone happens to be closest to.
        if (!best || d < best.d) {
          best = { d, name: p.distanceTo(s.a) <= p.distanceTo(s.b) ? s.aName : s.bName };
        }
      }
      if (best) buckets.get(best.name).push(p);
    }
    for (const n of nodes) {
      if (pinned.has(n.name)) continue;
      const mine = buckets.get(n.name);
      if (mine.length < 3) continue;
      const centre = mine.reduce((acc, p) => acc.add(p), V3()).multiplyScalar(1 / mine.length);
      const reach = Math.min(
        ...segs.get(n.name).map((s) => s.a.distanceTo(s.b)).filter((d) => d > 1e-6),
        n.parent ? n.parent.worldPos.distanceTo(n.worldPos) : Infinity,
      );
      const step = V3().subVectors(centre, n.worldPos).multiplyScalar(0.5);
      const cap = Number.isFinite(reach) ? reach * 0.4 : step.length();
      if (step.length() > cap) step.setLength(cap);
      n.worldPos.add(step);
    }
  }
  // Relaxing one side more than the other would reintroduce the limp.
  const byName = new Map(nodes.map((n) => [n.name, n]));
  let widest = 1e-6;
  for (const n of nodes) widest = Math.max(widest, Math.abs(n.worldPos.x));
  for (const n of nodes) {
    const twin = byName.get(mirrorName(n.name) ?? "");
    if (twin) {
      const avg = n.worldPos.clone().add(mirrorPos(twin.worldPos)).multiplyScalar(0.5);
      twin.worldPos.copy(mirrorPos(avg));
      n.worldPos.copy(avg);
    } else if (!pinned.has(n.name) && !offCentre(n.worldPos.x, widest)) {
      // Only a bone that really is near the centre line gets snapped to it.
      n.worldPos.x = 0;
    }
  }
}

function distanceToSegment(p, a, b) {
  const ab = V3().subVectors(b, a);
  const len2 = ab.lengthSq();
  if (len2 < 1e-12) return p.distanceTo(a);
  let t = V3().subVectors(p, a).dot(ab) / len2;
  t = Math.max(0, Math.min(1, t));
  return p.distanceTo(V3().copy(a).addScaledVector(ab, t));
}

// ---------------------------------------------------------------- preview

/** Fill in the triangles, so the silhouette reads as a shape and not a spray. */
function surfacePoints(points) {
  const out = [];
  const steps = 4;
  for (let t = 0; t + 2 < points.length; t += 3) {
    const [a, b, c] = [points[t], points[t + 1], points[t + 2]];
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; i + j <= steps; j++) {
        const u = i / steps;
        const v = j / steps;
        out.push(
          V3()
            .copy(a)
            .addScaledVector(V3().subVectors(b, a), u)
            .addScaledVector(V3().subVectors(c, a), v),
        );
      }
    }
  }
  return out;
}

function asciiView(points, ax, ay, cols, rows, label, fixedBox) {
  const box = fixedBox ?? new THREE.Box3().setFromPoints(points);
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const span = (k) => Math.max(1e-6, box.max[k] - box.min[k]);
  for (const p of points) {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(((p[ax] - box.min[ax]) / span(ax)) * cols)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(((p[ay] - box.min[ay]) / span(ay)) * rows)));
    grid[cy][cx]++;
  }
  console.log(
    `  ${label}  ${ax}:${box.min[ax].toFixed(2)}..${box.max[ax].toFixed(2)}  ${ay}:${box.min[ay].toFixed(2)}..${box.max[ay].toFixed(2)}`,
  );
  for (let r = rows - 1; r >= 0; r--) {
    console.log("   |" + grid[r].map((n) => (n === 0 ? " " : n < 3 ? "." : n < 10 ? "o" : "#")).join(""));
  }
}

// ---------------------------------------------------------------- render
//
// A z-buffered software rasteriser, because the one thing this tool cannot do
// without is a LOOK at the result, and an agent running it has no browser. Two
// rows of frames — side on and three-quarter — is enough to catch every failure
// that matters: a limb bound to the wrong bone, a tail folding through the
// belly, a foot that leaves the ground.

const box3 = (pts) => new THREE.Box3().setFromPoints(pts);
function viewBasis(dir) {
  const f = V3().copy(dir).normalize();
  const r = V3().crossVectors(V3(0, 1, 0), f).normalize();
  const u = V3().crossVectors(f, r);
  return { r, u, f };
}

function renderStrip(frames, geo, texture, tile = 300, groundY = null) {
  const uv = geo.attributes.uv;
  const views = [viewBasis(V3(1, 0.12, 0.001)), viewBasis(V3(0.75, 0.35, 0.62))];
  const width = tile * frames.length;
  const height = tile * views.length;
  const rgba = new Uint8Array(width * height * 4).fill(0x14);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  // One projection for every frame, so motion reads as motion.
  const all = frames.flatMap((f) => f.pts);
  const allBox = box3(all);
  for (const [vi, view] of views.entries()) {
    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
    for (const p of all) {
      const a = p.dot(view.r), b = p.dot(view.u);
      minR = Math.min(minR, a); maxR = Math.max(maxR, a);
      minU = Math.min(minU, b); maxU = Math.max(maxU, b);
    }
    const scale = (tile * 0.88) / Math.max(maxR - minR, maxU - minU);
    const cx = (minR + maxR) / 2, cy = (minU + maxU) / 2;

    for (const [fi, frame] of frames.entries()) {
      const ox = fi * tile, oy = vi * tile;
      const zbuf = new Float32Array(tile * tile).fill(Infinity);
      // the floor line (y = ground, under the body's centre line), drawn first
      if (groundY !== null) {
        const zs = [allBox.min.z, allBox.max.z];
        for (let s = 0; s <= 400; s++) {
          const z = zs[0] + ((zs[1] - zs[0]) * (s / 400 - 0.5)) * 1.6 + (zs[1] - zs[0]) * 0.3;
          for (const x of [-0.3, 0, 0.3].map((k) => k * (zs[1] - zs[0]))) {
            const q = V3(x, groundY, z);
            const px = Math.round(tile / 2 + (q.dot(view.r) - cx) * scale), py = Math.round(tile / 2 - (q.dot(view.u) - cy) * scale);
            if (px < 0 || py < 0 || px >= tile || py >= tile) continue;
            const o = ((oy + py) * width + ox + px) * 4;
            rgba[o] = 70; rgba[o + 1] = 90; rgba[o + 2] = 120;
          }
        }
      }
      const pts = frame.pts;
      const proj = pts.map((p) => ({
        x: tile / 2 + (p.dot(view.r) - cx) * scale,
        y: tile / 2 - (p.dot(view.u) - cy) * scale,
        z: p.dot(view.f),
      }));
      for (let t = 0; t + 2 < pts.length; t += 3) {
        const [a, b, c] = [proj[t], proj[t + 1], proj[t + 2]];
        const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
        if (Math.abs(area) < 1e-9) continue;
        const n = V3()
          .crossVectors(V3().subVectors(pts[t + 1], pts[t]), V3().subVectors(pts[t + 2], pts[t]))
          .normalize();
        // Generous ambient and a lift on top: this is a diagnostic, and a dark
        // texture under honest lighting hides exactly what we came to look at.
        const lambert = 1.5 * (0.5 + 0.5 * Math.max(0, n.dot(V3(0.4, 0.75, 0.5).normalize())));
        const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
        const x1 = Math.min(tile - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
        const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
        const y1 = Math.min(tile - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            let w0 = ((b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)) / area;
            let w1 = ((px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w2 * a.z + w1 * b.z + w0 * c.z;
            const at = y * tile + x;
            if (z >= zbuf[at]) continue;
            zbuf[at] = z;
            let col = [200, 200, 200];
            if (texture && uv) {
              const u = w2 * uv.getX(t) + w1 * uv.getX(t + 1) + w0 * uv.getX(t + 2);
              const v = w2 * uv.getY(t) + w1 * uv.getY(t + 1) + w0 * uv.getY(t + 2);
              const tx = Math.min(texture.width - 1, Math.max(0, Math.floor(u * texture.width)));
              const ty = Math.min(texture.height - 1, Math.max(0, Math.floor(v * texture.height)));
              const o = (ty * texture.width + tx) * 4;
              col = [texture.rgba[o], texture.rgba[o + 1], texture.rgba[o + 2]];
            }
            const out = ((oy + y) * width + ox + x) * 4;
            // under the floor shows RED: a sunk foot or body is seen, not guessed
            const wy = w2 * pts[t].y + w1 * pts[t + 1].y + w0 * pts[t + 2].y;
            if (groundY !== null && wy < groundY - 0.01) col = [255, 40, 40];
            for (let k = 0; k < 3; k++) rgba[out + k] = Math.min(255, col[k] * lambert);
          }
        }
      }
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- main

const gltf = await loadRig(args.rig);
let donor = null;
gltf.scene.traverse((o) => {
  if (o.isSkinnedMesh && !donor) donor = o;
});
if (!donor) {
  console.error("autorig: --rig has no skinned mesh");
  process.exit(1);
}
gltf.scene.updateMatrixWorld(true);
console.log(
  `rig  ${path.basename(args.rig)}: ${donor.skeleton.bones.length} bones, ${gltf.animations.length} clips`,
);

const target = await loadTargetGeometry(args.mesh);
const geo = target.geometry;
console.log(`mesh ${path.basename(args.mesh)}: ${geo.attributes.position.count} verts`);

// ---- orient the target the way the donor faces (+Z)
const facing = String(args.forward ?? "+z").toLowerCase();
const turn = { "+z": 0, "-x": Math.PI / 2, "-z": Math.PI, "+x": -Math.PI / 2 }[facing];
if (turn === undefined) {
  console.error("autorig: --forward must be one of +x -x +z -z");
  process.exit(1);
}
if (turn) geo.applyMatrix4(new THREE.Matrix4().makeRotationY(turn));
// --ground: a mesh modelled centred on the origin (the goat) would be fitted,
// skinned and shipped standing half under the floor; stand it on y = 0 first
if (args.ground) {
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
}

const tgtPoints = [];
{
  const pos = geo.attributes.position;
  const v = V3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    tgtPoints.push(v.clone());
  }
}

// ---- reference pose + the two measurements
let poseSpec = args.pose;
if (!poseSpec) {
  // A run averages to a crouch with the feet off the ground. An idle's head
  // is wherever the donor was looking (folded square by the symmetry pass).
  const loco =
    // IDLE FIRST (2026-10-06). Every mesh we rig is modelled standing square
    // on straight legs, and joints are fitted into those legs in this pose: a
    // walk's average has the knees bent, fits every leg too long, and each
    // clip that straightens one drives the foot through the floor — fitted in
    // avg:Walk the rhino's Idle stood 53 cm deep, the lion's 29, the bear's
    // 14; in avg:Idle_Alert 2 cm proud, 6 and 2 deep. (The grounding pass
    // below fixes what is left, but it is IK on top of a bad fit otherwise.)
    // BACK TO THE WALK (2026-10-06, same day): fitted in the idle, every
    // borrowed gallop flung the hind legs up level behind the body (the wolf,
    // the horse, the elk: "all forms of fucked"); the dog's legs only play
    // right on bones fitted in a pose they move through. The depth the walk
    // fit leaves is now the grounding pass's job (planted feet solved, swing
    // legs left as the donor keys them). `--pose avg:Idle_Alert` for the old.
    ["walk", "trot", "run", "idle"]
      .map((k) => gltf.animations.find((c) => new RegExp(k, "i").test(c.name)))
      .find(Boolean) ?? gltf.animations[0];
  poseSpec = loco ? `avg:${loco.name}` : "bind";
}
// --head-pose: the neck, head and tail from another clip's average (default
// the walk's, when the reference is an idle). The idle is right for the legs
// and the trunk, but an alert idle holds the head HIGH and the tail up, and a
// mesh modelled with its head level then binds to a skull pitched up: every
// clip plays star-gazing (the pig's Bite). "none" keeps the one pose.
const headAlt = (() => {
  const want = args["head-pose"] ?? (args.pose || !/idle/i.test(poseSpec) ? "none" : gltf.animations.find((c) => /walk/i.test(c.name))?.name ?? "none");
  if (want === "none") return null;
  const bones = donor.skeleton.bones;
  const set = new Set();
  const head = bones.find((b) => /^head$/i.test(b.name));
  if (head) {
    head.traverse((o) => o.isBone && set.add(o.name));
    // up the neck to (not including) the bone the forelegs hang from
    for (let b = head.parent; b?.isBone; b = b.parent) {
      if (b.children.some((c) => c.isBone && c !== head && !set.has(c.name) && /leg|arm|shoulder|clav/i.test(c.name))) break;
      set.add(b.name);
    }
  }
  for (const b of bones) if (/tail/i.test(b.name)) set.add(b.name);
  return set.size ? { spec: String(want), bones: set } : null;
})();
const ref = referencePose(String(poseSpec), gltf.scene, donor, gltf.animations, headAlt);
if (!args["no-symmetry"]) symmetrise(ref.world);
const donorPoints = skinnedPoints(donor, ref.world);
const D = measure(donorPoints);
// --measure-skip Part,…: an appendage that is not body — a rhino's horn, an
// elk's antlers — would be read as the nose or the top of the animal and
// stretch the warp (and the head fit) to reach it. Landmarks are measured on
// the rest; the skipped parts are still skinned (usually --bind to the skull).
const measureSkip = new Set(String(args["measure-skip"] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const T = measure(
  measureSkip.size ? tgtPoints.filter((_, i) => !measureSkip.has(geo.userData.partOf?.[i] ?? "")) : tgtPoints,
);
if (measureSkip.size) {
  // the floor is the floor of the whole model (feet), whatever was skipped
  T.groundY = Math.min(T.groundY, new THREE.Box3().setFromPoints(tgtPoints).min.y);
}
console.log(`pose ${ref.name}`);

if (args.report) {
  console.log("landmarks:");
  for (const k of [
    "groundY", "bellyY", "backY", "topY",
    "tailZ", "backLegZ", "frontLegZ", "noseZ",
    "halfWidth", "legHalfX",
  ]) {
    console.log(
      `  ${k.padEnd(11)} donor ${D[k].toFixed(3).padStart(8)}   target ${T[k].toFixed(3).padStart(8)}`,
    );
  }
}

// ---- the warp
const wz = piecewise(
  [D.tailZ, D.backLegZ, D.frontLegZ, D.noseZ],
  [T.tailZ, T.backLegZ, T.frontLegZ, T.noseZ],
);
const wy = piecewise([D.groundY, D.bellyY, D.backY, D.topY], [T.groundY, T.bellyY, T.backY, T.topY]);
const xScale = T.halfWidth / D.halfWidth;
const warp = (p) => V3(p.x * xScale, wy(p.y), wz(p.z));

// The skull hangs off the neck; its height has nothing to do with the torso's
// vertical profile, so it gets a similarity fit to the target's head instead.
const headFit = (() => {
  if ((args["head-fit"] ?? "similarity") !== "similarity") return null;
  const ds = D.headBox.getSize(V3());
  const ts = T.headBox.getSize(V3());
  const s = [ts.x / (ds.x || 1), ts.y / (ds.y || 1), ts.z / (ds.z || 1)].sort((a, b) => a - b)[1];
  const dc = D.headBox.getCenter(V3());
  const tc = T.headBox.getCenter(V3());
  return (p) => V3().subVectors(p, dc).multiplyScalar(s).add(tc);
})();

// ---- build the fitted skeleton: donor rotations, target offsets
const skip = new Set(
  String(args.skip ?? "root")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const donorBones = donor.skeleton.bones;
// Jaw/chin/nose/tongue bones never take weights unless --keep-jaw: no mesh we
// rig has a separate lower jaw, so a donor's mouth bones only tear the head
// open on Bite/Howl, and the nearest-bone blend even hands them CHEST
// vertices, which then stretch with every head bob (Derek, the wolf's chest).
if (!args["keep-jaw"]) for (const b of donorBones) if (/^(chin|jaw|nose|tongue|mouth)/i.test(b.name)) skip.add(b.name);
// EARS likewise (--keep-ears to allow them): every mesh we rig has its ears
// modelled INTO the head, or as a separate piece --bind pins to Head. Left
// bindable, the dog's Ear_* bones took the top of the skull (the pig: 220 head
// vertices), and their keyed flicks bounced and stretched it (Derek, the pig).
if (!args["keep-ears"]) for (const b of donorBones) if (/^ear/i.test(b.name)) skip.add(b.name);
// …and everything hanging off a skipped mouth/ear bone: the dog's Headtip
// and both ears are children of its Nose, so a skipped Nose still swung the
// whole snout (Headtip led 296 of the pig's head vertices). A top-level anchor
// (root) does not pass its skip on — the whole skeleton hangs off it.
{
  const bound = new Set(String(args.bind ?? "").split(",").flatMap((p) => (p.split("=")[1] ?? "").split("|")).map((s) => s.trim()));
  for (const b of donorBones) {
    const p = b.parent;
    if (p?.isBone && p.parent?.isBone && skip.has(p.name) && !bound.has(b.name)) skip.add(b.name);
  }
}
const nodes = donorBones.map((b) => {
  const p = V3();
  const q = new THREE.Quaternion();
  const s = V3();
  ref.world.get(b.name).decompose(p, q, s);
  const head = !!headFit && p.z > D.headFrom;
  // A skipped TOP-LEVEL bone is an armature anchor, not anatomy: leave it
  // where it is, so root motion and the hip track stay measured from the same
  // origin. A skipped bone inside the body (the dog's Nose, its ears) is still
  // fitted: left at the donor's position it sat outside the target's head,
  // and anything still parented under it swung about that point.
  const anchor = skip.has(b.name) && !b.parent?.isBone;
  const worldPos = anchor ? p.clone() : head ? headFit(p) : warp(p);
  return { name: b.name, refPos: p, refQuat: q, worldPos, head, bone: new THREE.Bone(), parent: null };
});
const byName = new Map(nodes.map((n) => [n.name, n]));
donorBones.forEach((b, i) => {
  if (b.parent?.isBone) nodes[i].parent = byName.get(b.parent.name) ?? null;
});
for (const n of nodes) {
  n.bone.name = n.name;
  if (n.parent) n.parent.bone.add(n.bone);
}
const rootNodes = nodes.filter((n) => !n.parent);

const passes = Math.max(0, Number(args.relax ?? 2));
if (passes) relaxJoints(nodes, tgtPoints, passes, skip);

// Local TRS from the fitted world positions and the donor's world rotations.
const worldOf = new Map(
  nodes.map((n) => [n.name, new THREE.Matrix4().compose(n.worldPos, n.refQuat, V3(1, 1, 1))]),
);
for (const n of nodes) {
  const parentW = n.parent ? worldOf.get(n.parent.name) : new THREE.Matrix4();
  const local = new THREE.Matrix4().copy(parentW).invert().multiply(worldOf.get(n.name));
  local.decompose(n.bone.position, n.bone.quaternion, n.bone.scale);
}

const skeleton = new THREE.Skeleton(
  nodes.map((n) => n.bone),
  nodes.map((n) => new THREE.Matrix4().copy(worldOf.get(n.name)).invert()),
);

if (args.report) {
  console.log("fitted bones (donor -> target):");
  for (const n of nodes) {
    console.log(`  ${n.name.padEnd(22)} ${f3(n.refPos)} -> ${f3(n.worldPos)}${n.head ? "  [head]" : ""}`);
  }
}

// ---- weights
const bindable = nodes.filter((n) => !skip.has(n.name));
const segs = boneSegments(nodes);
const maxInf = Math.max(1, Math.min(4, Number(args.influences ?? 4)));
const falloff = Number(args.falloff ?? 4);
const vcount = geo.attributes.position.count;
const skinIndex = new Uint16Array(vcount * 4);
const skinWeight = new Float32Array(vcount * 4);
const usage = new Map(nodes.map((n) => [n.name, 0]));
{
  const v = V3();
  const pos = geo.attributes.position;
  const eps = new THREE.Box3().setFromPoints(tgtPoints).getSize(V3()).length() * 1e-3;
  for (let i = 0; i < vcount; i++) {
    v.fromBufferAttribute(pos, i);
    const scored = bindable.map((n) => {
      let d = Infinity;
      for (const s of segs.get(n.name)) d = Math.min(d, distanceToSegment(v, s.a, s.b));
      return { n, w: Math.pow(1 / (d + eps), falloff) };
    });
    scored.sort((a, b) => b.w - a.w);
    const top = scored.slice(0, maxInf);
    const total = top.reduce((s, e) => s + e.w, 0);
    top.forEach((e, k) => {
      skinIndex[i * 4 + k] = nodes.indexOf(e.n);
      skinWeight[i * 4 + k] = e.w / total;
    });
    usage.set(top[0].n.name, usage.get(top[0].n.name) + 1);
  }
}
// MIDLINE: a vertex on the centre line between a pair of limbs (the chest
// between the forelegs, the belly between the hind legs) is nearest the two
// legs, not the spine high above — and took them 50/50 with nothing on the
// body. Legs moving opposite each other cancel, so a walk hides it; folding
// together they drag it out like taffy (the bison's chest stretched x18 on
// its death). Whatever a vertex holds of BOTH sides of a pair goes to the
// central bone they hang from. --no-midline keeps the raw blend.
if (!args["no-midline"]) {
  const idxOf = new Map(nodes.map((n, i) => [n.name, i]));
  const centralOf = (i) => {
    for (let n = nodes[i]; n; n = n.parent) if (!mirrorName(n.name) || !idxOf.has(mirrorName(n.name))) return idxOf.get(n.name);
    return i;
  };
  let moved = 0;
  for (let v = 0; v < vcount; v++) {
    const w = new Map();
    for (let k = 0; k < 4; k++) if (skinWeight[v * 4 + k] > 0) w.set(skinIndex[v * 4 + k], (w.get(skinIndex[v * 4 + k]) ?? 0) + skinWeight[v * 4 + k]);
    let changed = false;
    for (const [bi, wb] of [...w]) {
      const m = mirrorName(nodes[bi].name);
      const mi = m ? idxOf.get(m) : undefined;
      if (mi === undefined || !w.has(mi) || !w.has(bi) || bi > mi) continue;
      const shared = Math.min(wb, w.get(mi));
      if (shared < 0.05) continue;
      const c = centralOf(bi);
      w.set(bi, wb - shared);
      w.set(mi, w.get(mi) - shared);
      w.set(c, (w.get(c) ?? 0) + 2 * shared);
      changed = true;
    }
    if (!changed) continue;
    moved++;
    const top = [...w].filter(([, x]) => x > 1e-6).sort((a, b) => b[1] - a[1]).slice(0, maxInf);
    const total = top.reduce((t, [, x]) => t + x, 0) || 1;
    skinIndex.set([0, 0, 0, 0], v * 4);
    skinWeight.set([0, 0, 0, 0], v * 4);
    top.forEach(([bi, x], k) => { skinIndex[v * 4 + k] = bi; skinWeight[v * 4 + k] = x / total; });
  }
  if (moved) console.log(`midline: ${moved} vertices shared by both sides of a limb pair moved to the bone between them`);
}
// --bind Part=bone: a piece that must ride one bone whole — a horn on the
// skull, a wing on the shoulders — instead of taking the nearest bones' blend
const partOf = geo.userData.partOf ?? [];
for (const pair of String(args.bind ?? "").split(",").filter(Boolean)) {
  const [partSpec, boneName] = pair.split("=");
  // `Part@z>1.0` (any of x y z, < or >, chainable) narrows the bind to the
  // part's vertices in that region, in the fitted frame (+Z forward, metres,
  // feet on y = 0): a grazer's throat hangs below every neck bone and is
  // otherwise taken by the forelegs, which tear it open as they reach.
  const [part, ...regions] = partSpec.split("@");
  const tests = regions.map((r) => {
    const m = /^([xyz])([<>])(-?[\d.]+)$/.exec(r.trim());
    if (!m) {
      console.error(`autorig: --bind ${pair}: bad region "${r}" (want e.g. z>1.2)`);
      process.exit(1);
    }
    const [, axis, op, val] = m;
    return (p) => (op === ">" ? p[axis] > Number(val) : p[axis] < Number(val));
  });
  // `Part=A|B|C` keeps a piece on a SET of bones, blended by distance among
  // them only: a horse's mane runs down the neck, so it must bend with the
  // neck and ride the skull, but never be pulled by a shoulder.
  const names = boneName.split("|").map((s) => s.trim()).filter(Boolean);
  const set = names.map((nm) => nodes.findIndex((n) => n.name === nm));
  const missing = names.filter((_, j) => set[j] < 0);
  if (missing.length) {
    console.error(`autorig: --bind ${pair}: no bone ${missing.join(", ")}`);
    process.exit(1);
  }
  let k = 0;
  const v = V3();
  const pos = geo.attributes.position;
  const eps = new THREE.Box3().setFromPoints(tgtPoints).getSize(V3()).length() * 1e-3;
  for (let i = 0; i < vcount; i++) {
    if (partOf[i] !== part) continue;
    v.fromBufferAttribute(pos, i);
    if (tests.length && !tests.every((t) => t(v))) continue;
    if (set.length === 1) {
      skinIndex.set([set[0], 0, 0, 0], i * 4);
      skinWeight.set([1, 0, 0, 0], i * 4);
    } else {
      const scored = set.map((bi) => {
        let d = Infinity;
        for (const s of segs.get(nodes[bi].name)) d = Math.min(d, distanceToSegment(v, s.a, s.b));
        return { bi, w: Math.pow(1 / (d + eps), falloff) };
      });
      scored.sort((a, b) => b.w - a.w);
      const top = scored.slice(0, maxInf);
      const total = top.reduce((s, e) => s + e.w, 0);
      skinIndex.set([0, 0, 0, 0], i * 4);
      skinWeight.set([0, 0, 0, 0], i * 4);
      top.forEach((e, j) => {
        skinIndex[i * 4 + j] = e.bi;
        skinWeight[i * 4 + j] = e.w / total;
      });
    }
    k++;
  }
  console.log(`  bound ${k} vertices of ${part} to ${boneName}`);
}
geo.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
geo.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
// an unwrap's -parts.obj has a -parts.json beside it: carry the part index
// (TEXCOORD_1 + the `parts` table) so the rigged mob is still an ubermesh and
// a prefab can show or hide a mane, horns or wings by partMask
{
  const pj = path.resolve(args.mesh).replace(/-parts.obj$/i, "-parts.json");
  if (/-parts.obj$/i.test(args.mesh) && fs.existsSync(pj)) {
    const index = JSON.parse(fs.readFileSync(pj, "utf8")).parts;
    geo.setAttribute("uv1", new THREE.BufferAttribute(new Float32Array(partOf.flatMap((p) => [index[p] ?? 0, 0])), 2));
    geo.userData.parts = index;
    console.log(`  part index: ${Object.keys(index).length} parts from ${path.basename(pj)}`);
  }
}

// SEAM WELD: vertices of different parts at the same position (a leg's top
// ring on the chest, the neck on the head) must move together, or the seam
// opens as the limb swings — the wolf's chest tore x4 at the armpit, the body
// side on the shoulder bone and the leg side on the upper leg. Every such
// group takes the AVERAGE of its members' weights (top 4, renormalised).
// --no-weld keeps the per-part weights.
if (!args["no-weld"]) {
  const pos = geo.attributes.position, groups = new Map();
  for (let i = 0; i < vcount; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  let welded = 0;
  for (const ids of groups.values()) {
    if (ids.length < 2 || new Set(ids.map((i) => partOf[i] ?? "")).size < 2) continue;
    const sum = new Map();
    for (const i of ids) for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k];
      if (w > 0) sum.set(skinIndex[i * 4 + k], (sum.get(skinIndex[i * 4 + k]) ?? 0) + w / ids.length);
    }
    const top = [...sum].sort((a, b) => b[1] - a[1]).slice(0, maxInf);
    const total = top.reduce((s, [, w]) => s + w, 0) || 1;
    for (const i of ids) {
      skinIndex.set([0, 0, 0, 0], i * 4);
      skinWeight.set([0, 0, 0, 0], i * 4);
      top.forEach(([bi, w], k) => { skinIndex[i * 4 + k] = bi; skinWeight[i * 4 + k] = w / total; });
    }
    welded += ids.length;
  }
  if (welded) console.log(`welded ${welded} seam vertices across parts to shared weights`);
}
const led = bindable.filter((n) => usage.get(n.name) > 0);
console.log(
  `weights: ${maxInf} influences, falloff ${falloff}; ${led.length}/${bindable.length} bones lead at least one vertex`,
);
if (args.report) {
  const idle = bindable.filter((n) => usage.get(n.name) === 0).map((n) => n.name);
  if (idle.length) console.log(`  no vertices lead by: ${idle.join(", ")}`);
  // which bones actually carry each named part (after --bind): the first
  // place to look when a piece tears away or a jaw opens that should not
  if (partOf.some(Boolean)) {
    const per = new Map();
    for (let i = 0; i < vcount; i++) {
      let lead = 0;
      for (let k = 1; k < 4; k++) if (skinWeight[i * 4 + k] > skinWeight[i * 4 + lead]) lead = k;
      const part = partOf[i] || "(none)";
      if (!per.has(part)) per.set(part, new Map());
      const m = per.get(part);
      const bn = nodes[skinIndex[i * 4 + lead]].name;
      m.set(bn, (m.get(bn) ?? 0) + 1);
    }
    console.log("  lead bone by part:");
    for (const [part, m] of per) {
      const list = [...m].sort((a, b) => b[1] - a[1]).map(([b, c]) => `${b} ${c}`);
      console.log(`    ${part}: ${list.join(", ")}`);
    }
  }
}

// ---- material
const material = new THREE.MeshStandardMaterial({
  name: path.basename(args.out ?? args.mesh).replace(/\.[^.]+$/, ""),
  color: 0xffffff,
  roughness: 0.9,
  metalness: 0,
});
const texFile = args.texture ? path.resolve(String(args.texture)) : target.texture;
if (texFile && fs.existsSync(texFile)) {
  addTextureSearchRoot(path.dirname(texFile));
  const tex = new THREE.TextureLoader().load(texFile);
  tex.colorSpace = THREE.SRGBColorSpace;
  // glTF images are top-left origin; flipping the UV attribute is the same
  // transform as flipping the image, and lets the PNG land in the GLB as-is.
  tex.flipY = false;
  material.map = tex;
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  uv.needsUpdate = true;
  console.log(`texture ${path.basename(texFile)}`);
} else if (args.texture) {
  console.log(`  ! texture not found: ${args.texture}`);
}

const mesh = new THREE.SkinnedMesh(geo, material);
if (geo.userData.parts) mesh.userData.parts = geo.userData.parts;
delete geo.userData.partOf;
mesh.name = material.name;
for (const n of rootNodes) mesh.add(n.bone);
mesh.bind(skeleton);
mesh.frustumCulled = false;

// ---- scale. Needed before the gaits, which derive speed in metres.
const modelScale = args.height && args.height !== "none" ? Number(args.height) / (T.topY - T.groundY) : 1;

// ---- clips: the donor's, verbatim. Only translation tracks are remapped,
// because a metre of hip travel on the donor is not a metre on the target.
const wanted =
  !args.clips || args.clips === true || args.clips === "all"
    ? gltf.animations.map((c) => ({ as: c.name, clip: c }))
    : String(args.clips)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => {
          // `Out=Source` renames on the way through, so a donor's "Idle_Alert"
          // can land as the "Idle" the controller looks for by default.
          const [as, src] = pair.split("=");
          const from = (src ?? as).trim();
          const clip =
            gltf.animations.find((c) => c.name === from) ??
            gltf.animations.find((c) => c.name.toLowerCase() === from.toLowerCase());
          if (!clip) console.log(`  ! no clip "${from}"`);
          return clip ? { as: as.trim(), clip } : null;
        })
        .filter(Boolean);

const outClips = wanted.map(({ as, clip }) => {
  const tracks = clip.tracks.map((track) => {
    if (!track.name.endsWith(".position")) return track.clone();
    const node = byName.get(track.name.slice(0, -".position".length));
    if (!node) return track.clone();
    // Positions are local to the parent. Lift to world through the parent's
    // REFERENCE rotation, warp there, and drop back — the parent's rotation is
    // the donor's either way, so only the offset changes.
    const parentQ = node.parent ? node.parent.refQuat : new THREE.Quaternion();
    const inv = parentQ.clone().invert();
    const parentPos = node.parent ? node.parent.refPos : V3();
    const newParentPos = node.parent ? node.parent.worldPos : V3();
    const values = Float32Array.from(track.values);
    const p = V3();
    for (let i = 0; i < values.length; i += 3) {
      p.set(values[i], values[i + 1], values[i + 2]).applyQuaternion(parentQ).add(parentPos);
      const w = node.head && headFit ? headFit(p) : warp(p);
      w.sub(newParentPos).applyQuaternion(inv);
      values[i] = w.x;
      values[i + 1] = w.y;
      values[i + 2] = w.z;
    }
    return new THREE.VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(values));
  });
  const out = new THREE.AnimationClip(as, clip.duration, tracks);
  // where it came from, so the grounding pass can read the donor's own feet
  out.userData = { source: clip.name, shift: 0 };
  return out;
});
console.log(`clips: ${outClips.map((c) => `${c.name} ${c.duration.toFixed(2)}s`).join(", ")}`);

// ---- loop hygiene: keys to zero, and one frame for the wrap to happen in
if (args["loop-fix"] !== "none") {
  const notes = [];
  for (let i = 0; i < outClips.length; i++) {
    const r = normalizeLoop(outClips[i]);
    outClips[i] = r.clip;
    outClips[i].userData.shift = (outClips[i].userData.shift ?? 0) + (r.shifted > 0 ? r.shifted : 0);
    notes.push(
      `${r.clip.name} ${r.kind} (ends ${r.ratio.toFixed(1)} frames apart` +
        `${r.shifted > 0 ? `, head trimmed ${(r.shifted * 1000).toFixed(0)}ms` : ""})`,
    );
  }
  console.log(`loops: ${notes.join(", ")}`);
}

// ---- --damp: play part of a bone's keyed motion, not all of it. A dog
// throws its head back as it dies and swings it as it runs; on a short-necked,
// big-skulled animal (a rhino, a bison) the same arc tears the throat and
// reads as weightless. `Bone=f` slerps every key of that bone's rotation
// toward its reference-pose rotation by f (0 = held still, 1 = the donor's);
// `Clip:Bone=f` limits it to one clip. Rotations of the TRACKS only — the rest
// pose is never touched, the same rule as everywhere else in this tool.
if (args.damp) {
  const notes = [];
  for (const spec of String(args.damp).split(",").map((s) => s.trim()).filter(Boolean)) {
    const [lhs, f] = spec.split("=");
    const [clipName, boneName] = lhs.includes(":") ? lhs.split(":") : [null, lhs];
    const node = byName.get(boneName);
    const k = Number(f);
    if (!node || !Number.isFinite(k)) {
      console.log(`  ! --damp ${spec}: no bone "${boneName}" or bad factor`);
      continue;
    }
    const rest = node.bone.quaternion.clone();
    let hit = 0;
    for (const clip of outClips) {
      if (clipName && clip.name !== clipName) continue;
      for (const track of clip.tracks) {
        if (track.name !== `${boneName}.quaternion`) continue;
        const q = new THREE.Quaternion();
        for (let i = 0; i < track.values.length; i += 4) {
          q.fromArray(track.values, i);
          q.copy(rest.clone().slerp(q, k));
          q.toArray(track.values, i);
        }
        hit++;
      }
    }
    notes.push(`${lhs}×${k} (${hit} tracks)`);
  }
  console.log(`damp: ${notes.join(", ")}`);
}

// Two more footfall tables for the heavy and the stalking, registered beside
// _gait.mjs's own (same fields; see GAITS there). A LUMBER is a bear's or a
// boar's walk: short, low steps, a long time on each foot, the body heaving;
// a PROWL is a big cat's: long low strides, the body held level and still.
GAITS.lumber ??= { ...GAITS.walk, duty: 0.7, froude: 0.26, stride: 1.15, lift: 0.1, bob: 0.05, flex: 0.05, pitch: 0.035 };
GAITS.prowl ??= { ...GAITS.walk, duty: 0.7, froude: 0.3, stride: 1.55, lift: 0.11, bob: 0.015, flex: 0.04, pitch: 0.01 };

/** --gait-sway: roll the hips one way and the shoulders the other, once per stride. */
function swayClip(clip, amp, spine, limbs) {
  const front = limbs.find((l) => l.key.startsWith("F"));
  const shoulder = front?.root.parent ?? spine[spine.length - 1];
  const hipNode = nodes.find((n) => !skip.has(n.name));
  skeleton.pose();
  mesh.updateMatrixWorld(true);
  const cycle = clip.duration;
  for (const [node, k] of [[hipNode, 1], [shoulder, -1.6]]) {
    if (!node) continue;
    const tr = clip.tracks.find((t) => t.name === `${node.name}.quaternion`);
    if (!tr) continue;
    // the world forward axis, in this bone's parent frame at rest
    const pw = node.bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const axis = V3(0, 0, 1).applyQuaternion(pw.invert());
    const q = new THREE.Quaternion();
    for (let i = 0; i < tr.times.length; i++) {
      // hind left planted at phase 0 (the walk's BL touchdown): lean onto it
      const a = k * amp * Math.sin((2 * Math.PI * tr.times[i]) / cycle);
      q.fromArray(tr.values, i * 4).premultiply(new THREE.Quaternion().setFromAxisAngle(axis, a));
      q.toArray(tr.values, i * 4);
    }
  }
}

// ---- gaits generated from the animal's own proportions, not borrowed
if (args.gait) {
  const skipSet = new Set(String(args.skip ?? "root").split(",").map((s) => s.trim()));
  const hip = nodes.find((n) => !skipSet.has(n.name));
  const tailNames = new Set();
  {
    // Whatever we are about to hang is not a leg, however close to the floor
    // its tip sits.
    const roots =
      args.dangle === true
        ? [skeleton.bones.find((b) => /tail/i.test(b.name))?.name].filter(Boolean)
        : args.dangle
          ? String(args.dangle).split(",").map((s) => s.trim()).filter(Boolean)
          : [];
    for (const r of roots) for (const b of resolveChain(skeleton.bones, r) ?? []) tailNames.add(b.name);
  }
  const limbs = discoverLimbs(nodes, T, tailNames);
  if (!limbs || !hip) {
    console.log("  ! --gait: could not find four legs in this rig; leaving the donor's clips alone");
  } else {
    const limbSet = new Set(limbs.flatMap((l) => l.chain));
    const { spine, head } = discoverSpine(nodes, hip, limbSet, tailNames);
    skeleton.pose();
    mesh.updateMatrixWorld(true);
    const rest = new Map(
      skeleton.bones.map((b) => [b.name, { position: b.position.clone(), quaternion: b.quaternion.clone() }]),
    );
    // --gait-ankle: solve each leg to its ANKLE, not its toe tip. The gait's
    // IK drives every bone down to the tip, so in swing it curls the paw (the
    // bear's and lion's hind feet folded flat back, a paw snapping ~110° in
    // one frame); stopped at the ankle the paw rides the shin as modelled.
    const ankleLimbs = args["gait-ankle"] !== "none"
      ? limbs.map((l) => {
          const top = l.root.worldPos.y, floor = l.foot.worldPos.y;
          let a = l.chain.findIndex((n, i) => i > 0 && n.worldPos.y < floor + 0.25 * (top - floor));
          // root + two long bones at least (scapula/pelvis, humerus/thigh, forearm/shin):
    // a low-slung fit can put the elbow under the 25% line
    if (a < 3) a = Math.min(3, l.chain.length - 1);
          const chain = l.chain.slice(0, a + 1), ankle = chain[chain.length - 1];
          let reach = 0;
          for (let i = 1; i < chain.length; i++) reach += chain[i].worldPos.distanceTo(chain[i - 1].worldPos);
          return { ...l, chain, foot: ankle, reach, neutral: V3(ankle.worldPos.x, ankle.worldPos.y, ankle.worldPos.z) };
        })
      : limbs;
    // --gait-sway <deg>: the hips roll side to side once per stride and the
    // shoulders the other way — the lumber of a heavy animal (a bear)
    const ctx = { mesh, skeleton, limbs: ankleLimbs, spine, head, hip, rest, T, modelScale };

    // Which run — bound or gallop? DELIBERATELY NOT DERIVED. Bounding belongs
    // to long-backed, short-legged animals (rodents, mustelids, rabbits) and
    // galloping to long-legged ones, so shape ought to say which. It doesn't,
    // measurably: trunk-between-the-hips over leg length comes out 0.35 for
    // this rat and 0.36 for the wolf, because the fitted skeleton puts leg
    // roots in much the same relative place whatever the animal. Size is worse
    // — it calls a dire rat a wolf. So `Run` defaults to gallop and a rodent
    // asks for `Run=bound` in as many words. Do not put a threshold back here
    // without two animals it actually separates.
    const hipHeightM = (hip.worldPos.y - T.groundY) * modelScale;
    const autoRun = "gallop";
    const spec =
      args.gait === true
        ? [["Idle", "idle"], ["Walk", "walk"], ["Run", autoRun]]
        : String(args.gait)
            .split(",")
            .map((p) => {
              const [as, src] = p.split("=");
              return [as.trim(), (src ?? as).trim().toLowerCase()];
            });

    const jitter = rng(Number(args["gait-seed"] ?? 1));
    const made = [];
    for (const [as, kind] of spec) {
      const r =
        kind === "idle"
          ? buildIdleClip(ctx, as, { jitter })
          : GAITS[kind]
            ? buildGaitClip(ctx, as, kind, { jitter, speed: args[`gait-${as.toLowerCase()}-speed`] ? Number(args[`gait-${as.toLowerCase()}-speed`]) : undefined })
            : null;
      if (!r) {
        console.log(`  ! --gait: no gait "${kind}" (have ${Object.keys(GAITS).join(", ")}, idle)`);
        continue;
      }
      const sway = THREE.MathUtils.degToRad(Number(args["gait-sway"] ?? 0));
      if (sway && kind !== "idle") swayClip(r.clip, sway, spine, limbs);
      const at = outClips.findIndex((c) => c.name === as);
      if (at >= 0) outClips[at] = r.clip;
      else outClips.push(r.clip);
      made.push(`${as}=${kind} ${r.cycle.toFixed(2)}s${r.speed ? ` @${r.speed.toFixed(2)}m/s` : ""}`);
    }
    console.log(
      `gait legs ${limbs.map((l) => `${l.key}:${l.chain.length}`).join(" ")}` +
        `  spine ${spine.length}${head ? "+head" : ""}  hip ${hipHeightM.toFixed(2)}m` +
        `  run=${autoRun} (say Run=bound for a rodent)`,
    );
    console.log(`  generated: ${made.join(", ")}`);
  }
}

// ---- GROUNDING: every clip's feet on the floor, nothing under it.
// The fit gets each bone's REST position right, but a leg's length is fitted
// in the reference pose (a walk's average, knees bent) onto a mesh modelled
// standing straight, and its hip track is warped through the torso's vertical
// profile — two scalings that never quite agree. Played straight, a borrowed
// clip then pushes the feet through the floor wherever the donor straightens
// a leg (the rhino's Idle stood 44-55 cm deep, the lion's 25-29 cm) or leaves
// them hanging. So each clip is re-sampled at 30 fps and, frame by frame:
//  - every foot is given the height the DONOR's same foot has above its own
//    floor at that instant, scaled by leg length (generated clips, which have
//    no donor, keep their own arcs and are shifted so the lowest point of
//    each foot's cycle is its rest height);
//  - the hips move up or down by the mean error, then each leg is solved to
//    its height by IK of the bones above the ankle — the ankle and the foot
//    keep the clip's own orientation, so a hoof lands as it was keyed;
//  - anything still under the floor (a rump on a sit, a toe) lifts the body.
// A death keeps its legs as keyed and instead matches the DONOR's lowest
// point — so a body that lies on the ground lies on it, not 40 cm into it.
// Rotations of the TRACKS only: the rest pose is untouched, as everywhere.
//   --ground-fix none   skip it.
function groundingSetup() {
  const tailNames = new Set();
  const roots =
    args.dangle === true
      ? [skeleton.bones.find((b) => /tail/i.test(b.name))?.name].filter(Boolean)
      : args.dangle
        ? String(args.dangle).split(",").map((s) => s.trim()).filter(Boolean)
        : [];
  for (const r of roots) for (const b of resolveChain(skeleton.bones, r) ?? []) tailNames.add(b.name);
  // a tail, dangled or not, is never a leg and never "the body under the floor"
  for (const n of nodes) if (/tail/i.test(n.name)) tailNames.add(n.name);
  const limbs = discoverLimbs(nodes, T, tailNames);
  const hip = nodes.find((n) => !skip.has(n.name));
  if (!limbs || !hip) return null;
  for (const l of limbs) {
    const top = l.root.worldPos.y, floor = l.foot.worldPos.y;
    // the ankle: the first bone below a quarter of the leg's height
    let a = l.chain.findIndex((n, i) => i > 0 && n.worldPos.y < floor + 0.25 * (top - floor));
    // root + two long bones at least (scapula/pelvis, humerus/thigh, forearm/shin):
    // a low-slung fit can put the elbow under the 25% line
    if (a < 3) a = Math.min(3, l.chain.length - 1);
    l.gIK = l.chain.slice(1, a + 1).map((n) => n.bone); // driven..., effector = ankle
    l.gIKw = l.chain.slice(0, a + 1).map((n) => n.bone); // the same from the shoulder/pelvis (gait re-solve)
    l.gLock = l.chain.slice(a).map((n) => n.bone); // ankle and below keep their world rotation
    l.gScale = (top - floor) / Math.max(1e-6, l.root.refPos.y - l.foot.refPos.y);
  }
  // vertices that count for "under the floor": everything but a DANGLED
  // tail (the rope has its own floor); an undangled tail sinks like a leg
  const dangledNames = new Set();
  for (const r of roots) for (const b of resolveChain(skeleton.bones, r) ?? []) dangledNames.add(b.name);
  const body = [];
  const H = T.topY - T.groundY;
  const leadOf = (i) => {
    let lead = 0;
    for (let k = 1; k < 4; k++) if (skinWeight[i * 4 + k] > skinWeight[i * 4 + lead]) lead = k;
    return nodes[skinIndex[i * 4 + lead]].name;
  };
  for (let i = 0; i < vcount; i++) if (!dangledNames.has(leadOf(i))) body.push(i);
  // each foot is measured by its SOLE (the vertices on the floor at rest that
  // ride this leg), not its toe bone: a hoof or paw tipped by the shin puts
  // its heel through the floor while the toe bone reads clear
  const pos = geo.attributes.position;
  for (const l of limbs) {
    const mine = new Set(l.chain.map((n) => n.name));
    l.sole = [];
    for (let i = 0; i < vcount; i++) if (pos.getY(i) < T.groundY + 0.03 * H && mine.has(leadOf(i))) l.sole.push(i);
  }
  // the donor's planted height per foot bone: its lowest point over the walk
  const donorBone = new Map(donor.skeleton.bones.map((b) => [b.name, b]));
  const dMixer = new THREE.AnimationMixer(gltf.scene);
  const walk = gltf.animations.find((c) => /walk/i.test(c.name)) ?? gltf.animations[0];
  const dGround = new Map(limbs.map((l) => [l.foot.name, Infinity]));
  if (walk) {
    const act = dMixer.clipAction(walk);
    act.play();
    for (let i = 0; i <= 30; i++) {
      dMixer.setTime((walk.duration * i) / 30 * 0.999);
      gltf.scene.updateMatrixWorld(true);
      for (const l of limbs) {
        const b = donorBone.get(l.foot.name);
        if (b) dGround.set(l.foot.name, Math.min(dGround.get(l.foot.name), b.getWorldPosition(V3()).y));
      }
    }
    dMixer.stopAllAction();
    dMixer.uncacheRoot(gltf.scene);
  }
  skeleton.pose();
  const restLocal = new Map(skeleton.bones.map((b) => [b.name, b.quaternion.clone()]));
  return { limbs, hip, body, donorBone, dMixer, dGround, tailNames, restLocal };
}

/**
 * Pose the skeleton at clip time t straight from the tracks. NOT a mixer after
 * skeleton.pose(): three's PropertyMixer only writes a value when it CHANGED
 * since its last write, so a constant track (a dog's Hips held through a whole
 * Howl) is written once and then left at whatever skeleton.pose() reset it to
 * — every frame after the first silently loses that bone's key.
 */
const sampleCache = new WeakMap();
function sampleClip(clip, t) {
  let list = sampleCache.get(clip);
  if (!list) {
    const byBone = new Map(skeleton.bones.map((b) => [b.name, b]));
    list = clip.tracks
      .map((tr) => {
        const dot = tr.name.lastIndexOf(".");
        const bone = byBone.get(tr.name.slice(0, dot));
        const prop = tr.name.slice(dot + 1);
        return bone && ["quaternion", "position", "scale"].includes(prop) ? { bone, prop, it: tr.createInterpolant() } : null;
      })
      .filter(Boolean);
    sampleCache.set(clip, list);
  }
  skeleton.pose();
  const tt = Math.max(0, Math.min(t, clip.duration));
  for (const { bone, prop, it } of list) bone[prop].fromArray(it.evaluate(tt));
  mesh.updateMatrixWorld(true);
}

const IK_MAX = THREE.MathUtils.degToRad(Number(args["ground-ik-max"] ?? 20));
function groundClip(G, clip) {
  const { limbs, hip, body, donorBone, dMixer, dGround } = G;
  const H = T.topY - T.groundY;
  const death = /death|die|dead/i.test(clip.name);
  const src = clip.userData?.source && !clip.userData?.generated
    ? gltf.animations.find((c) => c.name === clip.userData.source) : null;
  const shift = clip.userData?.shift ?? 0;
  const flightK = (() => {
    let k = 1;
    for (const part of String(args.flight ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      const [lhs, v] = part.includes(":") ? part.split(":") : [null, part];
      if (lhs === null || lhs === clip.name) k = Number(v);
    }
    return Number.isFinite(k) ? k : 1;
  })();
  const sy = (T.backY - T.groundY) / Math.max(1e-6, D.backY - D.groundY);
  const mixer = new THREE.AnimationMixer(mesh);
  const action = mixer.clipAction(clip);
  action.play();
  let dAction = null;
  if (src) {
    dAction = dMixer.clipAction(src);
    dAction.play();
  }
  // 30 fps, 60 for a fast cycle: between keys the slerped joints of a gallop
  // cut a corner through the floor (the bear's Run dipped 9 cm mid-frame)
  // a generated gait is sampled at ITS OWN keys: between them its legs
  // interpolate through whatever branch-flip the solver made, and the foot
  // positions read there are garbage
  const gaitKeys = clip.userData?.generated && GAITS[clip.userData.generated]
    ? Array.from(clip.tracks.find((t) => t.name.endsWith(".quaternion"))?.times ?? []) : null;
  const frames = gaitKeys?.length > 2 ? gaitKeys.length - 1 : Math.max(2, Math.round(clip.duration * (clip.duration < 1.2 ? 60 : 30)));
  const timeAt = (f) => (gaitKeys?.length > 2 ? gaitKeys[f] : (f / frames) * clip.duration);
  const posTracks = new Set(clip.tracks.filter((t) => t.name.endsWith(".position")).map((t) => t.name.slice(0, -".position".length)));
  posTracks.add(hip.name);
  const posBones = skeleton.bones.filter((b) => posTracks.has(b.name));
  const footY = (l) => {
    if (!l.sole?.length) return l.foot.bone.getWorldPosition(V3()).y;
    skeleton.update();
    let m = Infinity;
    const v = V3();
    for (const i of l.sole) m = Math.min(m, mesh.getVertexPosition(i, v).y);
    return m;
  };
  const restFoot = (l) => (l.sole?.length ? T.groundY : l.foot.worldPos.y);
  // GENERATED gaits: the legs are re-solved here, analytically. The gait's own
  // IK is CCD from the rest pose every frame, and now and then it lands on the
  // other branch — the bear's foreleg (and its shoulder) spun 172° between two
  // frames of its gallop, paws snapped ~110° — and it drives the toes too, so
  // swing curls a paw flat back. Here: the gait's ankle position is kept, the
  // leg root and everything below it go back to the rest pose, and the two
  // long bones are aimed in the plane of the rest knee (two-bone IK) — the
  // same answer every frame for the same foot, the paw riding the shin.
  const gaitMode = !!(clip.userData?.generated && GAITS[clip.userData.generated]);
  const aimLeg = (l, target) => {
    const bones = l.gIKw;
    for (const b of [...bones, ...l.gLock]) b.quaternion.copy(G.restLocal.get(b.name));
    bones[0].updateMatrixWorld(true);
    const U = bones[1], K = bones[2], E = bones[bones.length - 1];
    const hipP = U.getWorldPosition(V3()), knee0 = K.getWorldPosition(V3()), eff0 = E.getWorldPosition(V3());
    const a = hipP.distanceTo(knee0), b = knee0.distanceTo(eff0);
    const to = target.clone().sub(hipP);
    const d = Math.min(Math.max(to.length(), Math.abs(a - b) + 1e-4), (a + b) * 0.999);
    const u = to.normalize();
    const restU = eff0.clone().sub(hipP).normalize();
    // the knee bends toward where it bends at rest; a leg fitted nearly
    // straight has no such side to speak of (and a sliver of one flips from
    // frame to frame), so then the anatomical one: elbow back, stifle forward,
    // in the body's frame as the leg root carries it
    // (and either, once the leg swings near its line, is another sliver:
    // the anatomical side carries some "up" so it never lines up with a leg
    // reaching out level in a gallop)
    const pole = knee0.clone().sub(hipP);
    pole.addScaledVector(restU, -pole.dot(restU));
    pole.addScaledVector(u, -pole.dot(u));
    if (pole.length() < 0.3 * a) {
      const rootNow = bones[0].getWorldQuaternion(new THREE.Quaternion());
      const delta = rootNow.multiply(l.root.refQuat.clone().invert());
      pole.set(0, 0.7, l.key.startsWith("F") ? -1 : 1).applyQuaternion(delta);
      pole.addScaledVector(u, -pole.dot(u));
    }
    pole.normalize();
    const x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a * a - x * x));
    const knee = hipP.clone().addScaledVector(u, x).addScaledVector(pole, h);
    const foot = hipP.clone().addScaledVector(u, d);
    const aim = (bone, from, dirTo) => {
      const R = new THREE.Quaternion().setFromUnitVectors(from.normalize(), dirTo.normalize());
      const pw = bone.parent.getWorldQuaternion(new THREE.Quaternion());
      const bw = bone.getWorldQuaternion(new THREE.Quaternion());
      bone.quaternion.copy(pw.invert().multiply(R).multiply(bw));
      bone.updateMatrixWorld(true);
    };
    aim(U, knee0.clone().sub(hipP), knee.clone().sub(hipP));
    const k1 = K.getWorldPosition(V3()), e1 = E.getWorldPosition(V3());
    aim(K, e1.sub(k1), foot.clone().sub(k1));
  };
  const pose = (t) => {
    sampleClip(clip, t);
    if (gaitMode) {
      const targets = limbs.map((l) => l.gIKw[l.gIKw.length - 1].getWorldPosition(V3()));
      limbs.forEach((l, i) => aimLeg(l, targets[i]));
      mesh.updateMatrixWorld(true);
    }
  };
  const meshMin = () => {
    skeleton.update();
    let m = Infinity;
    const v = V3();
    for (const i of body) m = Math.min(m, mesh.getVertexPosition(i, v).y);
    return m;
  };
  const moveHip = (dy) => {
    if (!dy) return;
    const hb = hip.bone;
    const w = hb.getWorldPosition(V3());
    w.y += dy;
    hb.position.copy(hb.parent.worldToLocal(w));
    mesh.updateMatrixWorld(true);
  };
  const turnTo = (b, worldQ) => {
    const pw = b.parent.getWorldQuaternion(new THREE.Quaternion());
    b.quaternion.copy(pw.invert().multiply(worldQ));
    b.updateMatrixWorld(true);
  };
  const solveLeg = (l, want) => {
    const eff = l.gIK[l.gIK.length - 1];
    const target = eff.getWorldPosition(V3());
    target.y += want - footY(l);
    if (gaitMode) aimLeg(l, target);
    else solveTo(l, target, IK_MAX);
  };
  const solveTo = (l, target, cap, list = l.gIK) => {
    const lockQ = l.gLock.map((b) => b.getWorldQuaternion(new THREE.Quaternion()));
    const eff = list[list.length - 1];
    const driven = list.slice(0, -1);
    const start = driven.map((b) => b.quaternion.clone());
    const bp = V3(), ep = V3(), pq = new THREE.Quaternion(), q = new THREE.Quaternion();
    for (let it = 0; it < 16; it++) {
      for (let i = driven.length - 1; i >= 0; i--) {
        const bone = driven[i];
        bone.getWorldPosition(bp);
        eff.getWorldPosition(ep);
        const toE = ep.sub(bp), toT = target.clone().sub(bp);
        if (toE.lengthSq() < 1e-10 || toT.lengthSq() < 1e-10) continue;
        q.setFromUnitVectors(toE.normalize(), toT.normalize()).slerp(new THREE.Quaternion(), 0.4);
        bone.parent.getWorldQuaternion(pq);
        bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq));
        // a correction, not a new pose: no joint turns more than IK_MAX from
        // the clip's own angle. A thigh carries rump flesh, and swinging it
        // 40° to put a sitting foot down drags the haunch up off the floor;
        // a foot left a little short of the ground is the lesser fault
        const k = driven.indexOf(bone), ang = start[k].angleTo(bone.quaternion);
        if (ang > cap) bone.quaternion.copy(start[k]).slerp(bone.quaternion.clone(), cap / ang);
        bone.updateMatrixWorld(true);
      }
    }
    l.gLock.forEach((b, i) => turnTo(b, lockQ[i]));
  };
  // generated clips: each foot's lowest point in the cycle goes to its rest height
  const own = new Map();
  if (!src && !death) {
    for (const l of limbs) own.set(l, Infinity);
    for (let f = 0; f <= frames; f++) {
      pose(timeAt(f));
      for (const l of limbs) own.set(l, Math.min(own.get(l), footY(l)));
    }
  }
  // BORROWED clips (2026-10-06, Derek: "the wolf animation is all forms of fucked"): only the
  // feet the donor has PLANTED are solved to the floor. A foot the donor has in the air keeps
  // the donor's own leg (the hip shift carries it): solving a swinging hind paw to "the donor's
  // height x leg scale" folded the wolf's and the horse's hind legs up behind the body mid-gallop.
  // The hips move by the planted feet's mean error; frames with none planted (a gallop's flight)
  // take the shift interpolated between their neighbours. `--ground-swing solve` restores the old.
  const swingKeep = !!src && !death && args["ground-swing"] !== "solve";
  const donorLift = (l) => {
    const b = donorBone.get(l.foot.name), g = dGround.get(l.foot.name);
    return b && Number.isFinite(g) ? (b.getWorldPosition(V3()).y - g) * l.gScale * flightK : 0;
  };
  const planted = (lift) => lift < 0.035 * H;
  let hipAt = null;
  if (swingKeep) {
    const raw = [];
    for (let f = 0; f <= frames; f++) {
      const t = timeAt(f);
      pose(t);
      dMixer.setTime(Math.min(src.duration * 0.9999, t + shift));
      gltf.scene.updateMatrixWorld(true);
      const errs = [];
      for (const l of limbs) { const lift = donorLift(l); if (planted(lift)) errs.push(restFoot(l) + lift - footY(l)); }
      raw.push(errs.length ? errs.reduce((s, e) => s + e, 0) / errs.length : null);
    }
    const known = raw.map((h, f) => (h === null ? -1 : f)).filter((f) => f >= 0);
    const n = frames; // frame n is frame 0 again (a cycle)
    hipAt = raw.map((h, f) => {
      if (h !== null || !known.length) return h ?? 0;
      const a = known.filter((k) => k < f).at(-1) ?? known.at(-1) - n;
      const b = known.find((k) => k > f) ?? known[0] + n;
      const ha = raw[((a % n) + n) % n] ?? raw[known.at(-1)], hb = raw[b % n] ?? raw[known[0]];
      return ha + ((hb - ha) * (f - a)) / Math.max(1e-6, b - a);
    });
  }
  const times = [], quats = new Map(skeleton.bones.map((b) => [b.name, []])), poss = new Map(posBones.map((b) => [b.name, []]));
  let before = Infinity, after = Infinity, hipMove = 0;
  for (let f = 0; f <= frames; f++) {
    const t = timeAt(f);
    times.push(t);
    pose(t);
    before = Math.min(before, meshMin());
    let dMin = null;
    if (src) {
      dMixer.setTime(Math.min(src.duration * 0.9999, t + shift));
      gltf.scene.updateMatrixWorld(true);
      if (death) {
        const world = new Map(donor.skeleton.bones.map((b) => [b.name, b.matrixWorld.clone()]));
        dMin = Math.min(...skinnedPoints(donor, world).map((p) => p.y));
      }
    }
    if (death) {
      // match the donor's lowest point (a body lying on its floor lies on ours)
      const want = dMin === null ? 0 : Math.max(0, (dMin - D.groundY) * sy) + T.groundY;
      const m = meshMin();
      const dy = want - m;
      // only lower a body the donor has on the floor; never into it
      moveHip(dy);
      hipMove = Math.max(hipMove, Math.abs(dy));
    } else if (swingKeep) {
      const lifts = limbs.map(donorLift);
      moveHip(hipAt[f]);
      hipMove = Math.max(hipMove, Math.abs(hipAt[f]));
      // planted feet to the floor; a swinging foot only if the shift put it under the floor
      limbs.forEach((l, i) => {
        if (planted(lifts[i])) solveLeg(l, restFoot(l) + lifts[i]);
        else if (footY(l) < restFoot(l)) solveLeg(l, restFoot(l));
      });
      const m = meshMin();
      if (m < T.groundY - 0.003 * H) moveHip(T.groundY - m);
    } else {
      const want = limbs.map((l) => {
        if (src) {
          const b = donorBone.get(l.foot.name);
          const g = dGround.get(l.foot.name);
          // --flight <[Clip:]k>: a fraction of the donor's foot heights. The
          // dog's gallop throws the whole body clear of the floor; scaled to a
          // horse that was a 78 cm leap every stride
          if (b && Number.isFinite(g)) return restFoot(l) + (b.getWorldPosition(V3()).y - g) * l.gScale * flightK;
        }
        // a hit or an attack stands on the Idle's feet: whatever is planted
        // (near the floor) goes TO the floor, a lifted paw stays lifted —
        // offsetting by the clip's lowest point floated the whole rhino 10 cm
        // whenever the lunge had dropped a sole for a moment
        if (clip.userData?.generated === "hit") {
          const y = footY(l);
          return y < restFoot(l) + 0.025 * H ? restFoot(l) : y;
        }
        const o = own.get(l);
        return Number.isFinite(o) ? footY(l) + (restFoot(l) - o) : footY(l);
      });
      const err = limbs.map((l, i) => want[i] - footY(l));
      const h = err.reduce((s, e) => s + e, 0) / err.length;
      moveHip(h);
      hipMove = Math.max(hipMove, Math.abs(h));
      limbs.forEach((l, i) => solveLeg(l, want[i]));
      // a leg that cannot reach down holds the body up: lower it, re-solve
      const high = Math.max(...limbs.map((l, i) => footY(l) - want[i]));
      if (high > 0.004 * H) {
        moveHip(-high);
        limbs.forEach((l, i) => solveLeg(l, want[i]));
      }
      // whatever is still under the floor (a rump on a sit, a toe) lifts the body
      const m = meshMin();
      if (m < T.groundY - 0.003 * H) moveHip(T.groundY - m);
    }
    after = Math.min(after, meshMin());
    for (const b of skeleton.bones) quats.get(b.name).push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    for (const b of posBones) poss.get(b.name).push(b.position.x, b.position.y, b.position.z);
  }
  action.stop();
  mixer.stopAllAction();
  mixer.uncacheRoot(mesh);
  if (dAction) {
    dMixer.stopAllAction();
    dMixer.uncacheRoot(gltf.scene);
  }
  skeleton.pose();
  mesh.updateMatrixWorld(true);
  if (gaitMode) {
    // close the cycle exactly: the last key IS the first
    for (const arr of quats.values()) arr.splice(arr.length - 4, 4, ...arr.slice(0, 4));
    for (const arr of poss.values()) arr.splice(arr.length - 3, 3, ...arr.slice(0, 3));
  }
  const tracks = skeleton.bones.map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, quats.get(b.name)));
  for (const b of posBones) tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.position`, times, poss.get(b.name)));
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  out.userData = { ...(clip.userData ?? {}), grounded: true };
  const cm = (v) => `${((v - T.groundY) * modelScale * 100).toFixed(1)}`;
  return { clip: out, note: `${clip.name} ${cm(before)}->${cm(after)}cm` };
}

const grounding = args["ground-fix"] === "none" ? null : groundingSetup();
if (args["ground-fix"] !== "none" && !grounding) console.log("  ! grounding: could not find four legs; clips left as keyed");
if (grounding) {
  const notes = [];
  for (let i = 0; i < outClips.length; i++) {
    const r = groundClip(grounding, outClips[i]);
    outClips[i] = r.clip;
    notes.push(r.note);
  }
  console.log(`ground (lowest point, before->after): ${notes.join(", ")}`);
}

// ---- hit reactions, GENERATED: `Hit` (a light flinch, 0.4 s) and `Hit_Heavy`
// (a stagger, 0.9 s). No donor we borrow from has one (the dog has no hit
// clip), so they are made on the fitted skeleton from the clip the animal
// stands in: every frame is the Idle's pose, struck from the front — the hips
// recoil back a few % of the body's length and pitch nose-up, the trunk
// compresses and twists, the neck and head jerk back and up a beat behind,
// a front paw lifts (the heavy one stumbles a step back on it, sways and
// shakes its head) — and the feet are put back where the Idle had them by IK,
// so they stay planted. Everything eases out onto the Idle again, so the clip
// blends back cleanly. Rotations are applied in WORLD axes (the donor's bone
// frames are its own), and only bone rotations plus the hip's position are
// keyed, like every other clip here. Made before --dangle, so a hung tail
// swings through the recoil like it does through everything else.
//   --hits none   skip them.
if (args.hits !== "none") {
  const skipSet = new Set(String(args.skip ?? "root").split(",").map((s) => s.trim()));
  const hip = nodes.find((n) => !skipSet.has(n.name));
  const tailNames = new Set();
  {
    const roots =
      args.dangle === true
        ? [skeleton.bones.find((b) => /tail/i.test(b.name))?.name].filter(Boolean)
        : args.dangle
          ? String(args.dangle).split(",").map((s) => s.trim()).filter(Boolean)
          : [];
    for (const r of roots) for (const b of resolveChain(skeleton.bones, r) ?? []) tailNames.add(b.name);
  }
  const limbs = discoverLimbs(nodes, T, tailNames);
  const idle = outClips.find((c) => c.name === "Idle") ?? null;
  if (!hip) console.log("  ! hits: no hip bone");
  else {
    const limbSet = new Set((limbs ?? []).flatMap((l) => l.chain));
    const found = discoverSpine(nodes, hip, limbSet, tailNames);
    // the skull is the bone called Head where there is one: the path to the nose
    // can run on through a --skip bone (the dog's Nose is left at the DONOR's
    // position, unwarped), and turning that swings the snout about a point
    // outside the head
    const head = nodes.find((n) => /^head$/i.test(n.name) && !skip.has(n.name)) ?? found.head;
    const above = new Set();
    for (let n = head?.parent; n; n = n.parent) above.add(n);
    const spine = head ? [...above].reverse().filter((n) => n !== hip && !skip.has(n.name) && nodes.indexOf(n) > nodes.indexOf(hip)) : found.spine;
    // the neck is the spine past the bone the forelegs hang from
    const frontLimbs = (limbs ?? []).filter((l) => l.key.startsWith("F"));
    const shoulderAt = frontLimbs.length ? spine.indexOf(frontLimbs[0].root.parent) : -1;
    const trunk = shoulderAt >= 0 ? spine.slice(0, shoulderAt + 1) : spine.slice(0, Math.max(0, spine.length - 2));
    const neckBones = spine.slice(trunk.length);
    const L = Math.max(1e-3, T.noseZ - T.backLegZ) * 1.3; // body length, nose to rump
    const legLen = limbs ? limbs.reduce((s, l) => s + l.length, 0) / limbs.length : L * 0.4;
    const pawLimb = (limbs ?? []).find((l) => l.key === "FL") ?? null;
    const braceLimb = (limbs ?? []).find((l) => l.key === "FR") ?? null;
    const sss = (x, a, b) => THREE.MathUtils.smootherstep(x, a, b);
    const env = (u, peak, hold) => (u <= 0 ? 0 : u < peak ? Math.sin((Math.PI / 2) * (u / peak)) : u < hold ? 1 : 1 - sss(u, hold, 1));
    const bump = (u, a, b) => (u <= a || u >= b ? 0 : Math.sin((Math.PI * (u - a)) / (b - a)) ** 2);
    const X = V3(1, 0, 0), Y = V3(0, 1, 0), Z = V3(0, 0, 1);
    const qa = (axis, a) => new THREE.Quaternion().setFromAxisAngle(axis, a);
    /** rotate bone `b` by the WORLD rotation `R` about its own origin */
    const turnWorld = (b, R) => {
      b.updateMatrixWorld(true);
      const pw = b.parent.getWorldQuaternion(new THREE.Quaternion());
      const bw = b.getWorldQuaternion(new THREE.Quaternion());
      b.quaternion.copy(pw.invert().multiply(R).multiply(bw));
      b.updateMatrixWorld(true);
    };
    // damped CCD (as _gait.mjs), started from the Idle's own bend
    const ccd = (bones, target) => {
      const eff = bones[bones.length - 1], driven = bones.slice(0, -1);
      const bp = V3(), ep = V3(), pq = new THREE.Quaternion(), q = new THREE.Quaternion();
      for (let it = 0; it < 12; it++) {
        for (let i = driven.length - 1; i >= 0; i--) {
          const bone = driven[i];
          bone.getWorldPosition(bp);
          eff.getWorldPosition(ep);
          const toE = ep.sub(bp), toT = target.clone().sub(bp);
          if (toE.lengthSq() < 1e-10 || toT.lengthSq() < 1e-10) continue;
          q.setFromUnitVectors(toE.normalize(), toT.normalize()).slerp(new THREE.Quaternion(), 0.35);
          bone.parent.getWorldQuaternion(pq);
          bone.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq));
          bone.updateMatrixWorld(true);
        }
      }
    };
    const posTracks = new Set((idle?.tracks ?? []).filter((t) => t.name.endsWith(".position")).map((t) => t.name.slice(0, -".position".length)));
    posTracks.add(hip.name);
    const posBones = skeleton.bones.filter((b) => posTracks.has(b.name));
    const mixer = new THREE.AnimationMixer(mesh);
    const action = idle ? mixer.clipAction(idle) : null;
    action?.play();

    const make = (name, dur, k) => {
      const frames = Math.max(4, Math.round(dur * 30));
      const times = [], quats = new Map(skeleton.bones.map((b) => [b.name, []])), poss = new Map(posBones.map((b) => [b.name, []]));
      for (let f = 0; f <= frames; f++) {
        const t = (f / frames) * dur, u = t / dur;
        times.push(t);
        // from the tracks, not the mixer (see sampleClip: constant tracks)
        if (idle) sampleClip(idle, Math.min(t, idle.duration * 0.999));
        else skeleton.pose();
        mesh.updateMatrixWorld(true);
        const feet = (limbs ?? []).map((l) => l.foot.bone.getWorldPosition(V3()));

        const e = env(u, k.peak, k.hold), eh = env(u - k.lag, k.peak, k.hold - k.lag);
        const sway = k.sway ? Math.sin(2 * Math.PI * 1.5 * u) * (1 - sss(u, 0.35, 1)) * sss(u, 0, 0.12) : 0;
        const shake = k.shake ? bump(u, 0.3, 0.85) * Math.sin(2 * Math.PI * 4 * u) : 0;
        // the hips: back, down, sideways; nose-up and a roll
        const hb = hip.bone;
        const hw = hb.getWorldPosition(V3()).add(V3(L * k.sway * sway, -legLen * k.dip * e, -L * k.back * e));
        hb.position.copy(hb.parent.worldToLocal(hw));
        turnWorld(hb, qa(Z, k.roll * (e + sway)).multiply(qa(X, -k.pitch * e)));
        // the trunk takes back most of the hips' pitch (so the forequarters do
        // not dive) and compresses and twists toward the blow
        trunk.forEach((s, i) => turnWorld(s.bone, qa(Y, (k.twist * e) / trunk.length).multiply(qa(X, ((k.pitch * 0.6 + k.compress) * e) / Math.max(1, trunk.length)))));
        // the neck and the head jerk back and up, a beat later, and shake
        // toss: a gore's upward hook of the head after the drive (0 for a hit)
        const toss = k.toss ? bump(u, 0.36, 0.98) : 0;
        neckBones.forEach((s) => turnWorld(s.bone, qa(Y, (k.shake * 0.5 * shake) / neckBones.length).multiply(qa(X, (-k.neck * eh - (k.toss ?? 0) * 0.5 * toss) / neckBones.length))));
        if (head) turnWorld(head.bone, qa(Y, k.shake * shake).multiply(qa(Z, k.tilt * eh)).multiply(qa(X, -k.head * eh - (k.toss ?? 0) * toss)));
        mesh.updateMatrixWorld(true);
        // the feet go back where the Idle had them (a paw lifts / steps)
        (limbs ?? []).forEach((l, i) => {
          const p = feet[i].clone();
          if (l === pawLimb) {
            if (k.step) {
              p.z -= L * k.step * (sss(u, 0.1, 0.3) - sss(u, 0.6, 0.85));
              p.y += legLen * k.paw * (bump(u, 0.08, 0.32) + bump(u, 0.58, 0.87));
            } else {
              const lift = bump(u, 0.04, 0.75);
              p.y += legLen * k.paw * lift;
              p.z -= L * 0.03 * lift; // drawn in under the chest
            }
          } else if (l === braceLimb && k.brace) p.x += Math.sign(p.x || -1) * legLen * 0.08 * e;
          const chain = l.chain.map((n) => n.bone);
          ccd(chain.length > 3 ? chain.slice(1) : chain, p);
        });
        for (const b of skeleton.bones) quats.get(b.name).push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        for (const b of posBones) poss.get(b.name).push(b.position.x, b.position.y, b.position.z);
      }
      const tracks = skeleton.bones.map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, quats.get(b.name)));
      for (const b of posBones) tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.position`, times, poss.get(b.name)));
      const clip = new THREE.AnimationClip(name, dur, tracks);
      clip.userData = { generated: "hit" };
      const at = outClips.findIndex((c) => c.name === name);
      if (at >= 0) outClips[at] = clip;
      else outClips.push(clip);
    };
    const light = { peak: 0.15, hold: 0.3, lag: 0.06, back: 0.035, dip: 0.03, pitch: 0.07, roll: 0.04, compress: 0.04, twist: 0.08,
      neck: 0.3, head: 0.18, tilt: 0.08, shake: 0, sway: 0, paw: 0.22, step: 0, brace: false };
    const heavy = { ...light, peak: 0.12, hold: 0.42, back: 0.06, dip: 0.06, pitch: 0.11, roll: 0.07, compress: 0.06, twist: 0.14,
      neck: 0.42, head: 0.25, tilt: 0.12, shake: 0.2, sway: 0.025, paw: 0.25, step: 0.05, brace: true };
    // `--hit-scale f` (or Hit=f,Hit_Heavy=f) scales a stiff-necked animal's jerk down
    const scaleOf = (name) => {
      const s = String(args["hit-scale"] ?? "1");
      const m = s.split(",").map((p) => p.split("=")).find((p) => p.length === 2 && p[0] === name);
      return Number(m ? m[1] : s.includes("=") ? 1 : s);
    };
    const scaled = (k, f) => ({ ...k, back: k.back * f, pitch: k.pitch * f, compress: k.compress * f, twist: k.twist * f, neck: k.neck * f, head: k.head * f, tilt: k.tilt * f, shake: k.shake * f });
    make("Hit", 0.4, scaled(light, scaleOf("Hit")));
    make("Hit_Heavy", 0.9, scaled(heavy, scaleOf("Hit_Heavy")));
    // --attack gore: the attack clip (Bite, what mob abilities play) GENERATED
    // for a horned or tusked heavy animal: the hips drive forward and down,
    // the head drops and thrusts, then hooks UP through the target — feet
    // planted by the same IK as the hits. The dog's Bite on a rhino crouched
    // its hind legs backwards under it and read as a dog snapping.
    if (String(args.attack ?? "") === "gore") {
      const gore = { ...light, peak: 0.3, hold: 0.36, lag: 0.05, back: -0.07, dip: 0.05, pitch: -0.1, roll: 0, compress: 0.03, twist: 0.04,
        neck: -0.35, head: -0.25, tilt: 0.05, shake: 0, sway: 0, paw: 0, step: 0, brace: true, toss: 0.6 };
      make("Bite", Number(args["attack-time"] ?? 0.9), gore);
      const b = outClips.find((c) => c.name === "Bite");
      if (b) b.userData.generated = "hit";
      console.log(`attack: Bite = generated gore ${Number(args["attack-time"] ?? 0.9).toFixed(2)}s`);
    }
    // --call roar[:Clip]: the call clip GENERATED as a STANDING roar (2026-10-06, Derek on
    // the lions' roars: "really really messed up" — the dog's Howl sits a lion down on its
    // haunches and points its nose at the sky). Legs planted by the hits' IK, the weight
    // settles back and down, the chest comes up, the neck rises and the head thrusts
    // forward and holds there with a low rumble of a shake, then it all eases back.
    {
      const m = /^roar(?::(\w+))?$/i.exec(String(args.call ?? ""));
      if (m) {
        const name = m[1] ?? "Roar", dur = Number(args["call-time"] ?? 2.3);
        const roar = { ...light, peak: 0.22, hold: 0.78, lag: 0.08, back: -0.03, dip: 0.03, pitch: 0.15, roll: 0, compress: -0.04, twist: 0,
          neck: 0.9, head: -0.5, tilt: 0, shake: 0.06, sway: 0, paw: 0, step: 0, brace: true };
        make(name, dur, roar);
        console.log(`call: ${name} = generated standing roar ${dur.toFixed(2)}s`);
      }
    }
    action?.stop();
    mixer.stopAllAction();
    mixer.uncacheRoot(mesh);
    skeleton.pose();
    mesh.updateMatrixWorld(true);
    // the recoil drops and pitches the hips over feet put back by IK: ground it
    // like a generated gait (each foot's lowest point to its rest height)
    if (grounding) {
      for (let i = 0; i < outClips.length; i++) {
        if (outClips[i].userData?.generated !== "hit") continue;
        outClips[i] = groundClip(grounding, outClips[i]).clip;
      }
    }
    console.log(
      `hits: Hit 0.40s, Hit_Heavy 0.90s on ${idle ? "Idle" : "the rest pose"}` +
        `  (trunk ${trunk.map((s) => s.name).join(" ")}, neck ${neckBones.map((s) => s.name).join(" ")}${head ? ` + ${head.name}` : ""}, legs ${limbs ? limbs.map((l) => l.key).join(" ") : "none found: no IK"})`,
    );
  }
}

// ---- --death collapse: a GENERATED death in place of the donor's. The dog's
// Death rears up onto its hind legs and goes over backwards, head thrown back
// — a dog's stage death, and on a bear, a boar or a rhino it reads as a
// circus trick (and the throw tears a short neck). A heavy animal goes DOWN:
// the forelegs buckle and the chest drops, the hindquarters fold after it,
// the body rolls onto its side, and the head comes down last and lies on the
// ground. Built from the Idle's first frame, in WORLD axes like the hits;
// grounded afterwards (lowest point on the floor every frame).
//   --death collapse[:left|right]   default side left; --death-time <s> (1.4)
if (args.death && String(args.death).startsWith("collapse") && grounding) {
  const side = /right/i.test(String(args.death)) ? -1 : 1;
  const dur = Number(args["death-time"] ?? 1.4);
  const idle = outClips.find((c) => c.name === "Idle") ?? null;
  const { limbs, hip } = grounding;
  const headN = nodes.find((n) => /^head$/i.test(n.name) && !skip.has(n.name));
  const above = [];
  for (let n = headN?.parent; n && n !== hip; n = n.parent) above.unshift(n);
  const front = limbs.filter((l) => l.key.startsWith("F")), back = limbs.filter((l) => l.key.startsWith("B"));
  const shoulderAt = front.length ? above.indexOf(front[0].root.parent) : -1;
  const trunk = shoulderAt >= 0 ? above.slice(0, shoulderAt + 1) : above.slice(0, Math.max(0, above.length - 2));
  const neck = above.slice(trunk.length);
  const X = V3(1, 0, 0), Z = V3(0, 0, 1);
  const qa = (axis, a) => new THREE.Quaternion().setFromAxisAngle(axis, a);
  const sss = (x, a, b) => THREE.MathUtils.smootherstep(x, a, b);
  const turnWorld = (b, R) => {
    b.updateMatrixWorld(true);
    const pw = b.parent.getWorldQuaternion(new THREE.Quaternion());
    const bw = b.getWorldQuaternion(new THREE.Quaternion());
    b.quaternion.copy(pw.invert().multiply(R).multiply(bw));
    b.updateMatrixWorld(true);
  };
  const tailRoot = nodes.find((n) => /tail/i.test(n.name) && !/tail/i.test(n.parent?.name ?? ""));
  const legH = limbs.reduce((s, l) => s + (l.root.worldPos.y - l.foot.worldPos.y), 0) / limbs.length;
  // fold a leg: the upper bone swings, the next one folds back the other way
  const fold = (l, a) => {
    const c = l.chain.map((n) => n.bone);
    if (c.length < 3) return;
    const sgn = l.key.startsWith("F") ? 1 : -1; // forelegs fold back at the knee, hind legs forward at the hock
    turnWorld(c[1], qa(X, -sgn * a * 0.45));
    turnWorld(c[2], qa(X, sgn * a * 1.1));
  };
  const frames = Math.max(8, Math.round(dur * 30));
  const times = [], quats = new Map(skeleton.bones.map((b) => [b.name, []])), hipPos = [];
  for (let f = 0; f <= frames; f++) {
    const t = (f / frames) * dur, u = t / dur;
    times.push(t);
    if (idle) sampleClip(idle, 0);
    else { skeleton.pose(); mesh.updateMatrixWorld(true); }
    const buckle = sss(u, 0.0, 0.32); // forelegs give
    const hind = sss(u, 0.18, 0.5); // then the hind legs
    const roll = sss(u, 0.3, 0.72); // over onto the side
    const flop = sss(u, 0.55, 0.92); // head down last, legs go slack
    const hb = hip.bone;
    const w = hb.getWorldPosition(V3());
    w.y -= legH * (0.55 * hind + 0.2 * buckle);
    hb.position.copy(hb.parent.worldToLocal(w));
    // nose-down as the front drops, back to level as the rear follows; then the roll
    turnWorld(hb, qa(Z, side * 1.45 * roll).multiply(qa(X, 0.22 * buckle * (1 - hind))));
    for (const s of trunk) turnWorld(s.bone, qa(X, (0.12 * buckle * (1 - hind)) / Math.max(1, trunk.length)));
    // the neck sags toward the ground once the body is down (the roll's side)
    // (pitching down in WORLD X: the body lies along Z, so this lowers the head)
    for (const s of neck) turnWorld(s.bone, qa(X, (0.35 * buckle * (1 - flop) + 0.55 * flop) / Math.max(1, neck.length)));
    if (headN) turnWorld(headN.bone, qa(X, 0.25 * flop));
    // the tail goes limp (and so --dangle reads this as a one-shot, not a cycle)
    if (tailRoot) turnWorld(tailRoot.bone, qa(X, 0.5 * flop));
    for (const l of front) fold(l, 1.1 * buckle * (1 - 0.6 * flop));
    for (const l of back) fold(l, 0.9 * hind * (1 - 0.5 * flop));
    mesh.updateMatrixWorld(true);
    for (const b of skeleton.bones) quats.get(b.name).push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    hipPos.push(hb.position.x, hb.position.y, hb.position.z);
  }
  const tracks = skeleton.bones.map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, quats.get(b.name)));
  tracks.push(new THREE.VectorKeyframeTrack(`${hip.name}.position`, times, hipPos));
  let clip = new THREE.AnimationClip("Death", dur, tracks);
  clip.userData = { generated: "death" };
  clip = groundClip(grounding, clip).clip;
  const at = outClips.findIndex((c) => c.name === "Death");
  if (at >= 0) outClips[at] = clip;
  else outClips.push(clip);
  skeleton.pose();
  mesh.updateMatrixWorld(true);
  console.log(`death: collapse ${dur.toFixed(2)}s onto the ${side > 0 ? "left" : "right"} (trunk ${trunk.map((n) => n.name).join(" ")}, neck ${neck.map((n) => n.name).join(" ")})`);
}

// ---- a death turns on the body's own centre (2026-10-06, Derek: "shouldn't it be a turn on
// their center axis instead of the off center roll?"). Whatever the Death does — the dog's
// rear-up-and-over, the generated collapse rolling about the hip joint — the TRUNK's centre
// (the vertices riding the hips and the spine up to the shoulders) is held over the spot it
// stood on: every frame the hips move horizontally by however far that centre has drifted.
// That is the same as turning about the trunk's centre axis; heights stay as grounded.
//   --death-hold none   keep the drift.
if (args["death-hold"] !== "none" && grounding) {
  const at = outClips.findIndex((c) => /^death$/i.test(c.name));
  const clip = at >= 0 ? outClips[at] : null;
  const hb = grounding.hip.bone;
  const hipTrack = clip?.tracks.find((t) => t.name === `${hb.name}.position`);
  if (clip && hipTrack) {
    const headN = nodes.find((n) => /^head$/i.test(n.name) && !skip.has(n.name));
    const above = [];
    for (let n = headN?.parent; n && n !== grounding.hip; n = n.parent) above.unshift(n);
    const front = grounding.limbs.filter((l) => l.key.startsWith("F"));
    const shoulderAt = front.length ? above.indexOf(front[0].root.parent) : -1;
    const trunkBones = new Set([grounding.hip, ...(shoulderAt >= 0 ? above.slice(0, shoulderAt + 1) : above.slice(0, Math.max(0, above.length - 2)))].map((n) => nodes.indexOf(n)));
    // the unwrap's BODY part where there is one (the whole barrel, neck root and haunches
    // included); else the vertices led by the hips and the spine
    // (partOf: the per-vertex part names kept above, before geo.userData.partOf was dropped)
    const ids = [];
    if (partOf) for (let i = 0; i < vcount; i++) if (/body/i.test(partOf[i] ?? "")) ids.push(i);
    if (ids.length < 50) ids.length = 0;
    if (!ids.length) for (let i = 0; i < vcount; i++) {
      let lead = 0;
      for (let k = 1; k < 4; k++) if (skinWeight[i * 4 + k] > skinWeight[i * 4 + lead]) lead = k;
      if (trunkBones.has(skinIndex[i * 4 + lead])) ids.push(i);
    }
    const centre = () => {
      skeleton.update();
      const c = V3(), v = V3();
      for (const i of ids) c.add(mesh.getVertexPosition(i, v));
      return c.divideScalar(Math.max(1, ids.length));
    };
    let c0 = null, maxBefore = 0;
    const times = hipTrack.times;
    for (let f = 0; f < times.length; f++) {
      sampleClip(clip, times[f]);
      const c = centre();
      if (!c0) c0 = c.clone();
      const d = V3(c0.x - c.x, 0, c0.z - c.z);
      maxBefore = Math.max(maxBefore, d.length());
      const w = hb.getWorldPosition(V3()).add(d);
      const local = hb.parent.worldToLocal(w);
      hipTrack.values[f * 3] = local.x;
      hipTrack.values[f * 3 + 1] = local.y;
      hipTrack.values[f * 3 + 2] = local.z;
    }
    skeleton.pose();
    mesh.updateMatrixWorld(true);
    console.log(`death: trunk centre held over its footprint (it drifted ${(maxBefore * modelScale * 100).toFixed(1)} cm; ${ids.length} trunk vertices)`);
  }
}

// ---- a hanging chain stops being keyed and starts hanging
const dangled = new Set();
if (args.dangle) {
  const roots =
    args.dangle === true
      ? [skeleton.bones.find((b) => /tail/i.test(b.name))?.name].filter(Boolean)
      : String(args.dangle)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  if (!roots.length) console.log("  ! --dangle: no bone matching /tail/ in this rig");
  const mixer = new THREE.AnimationMixer(mesh);
  const opts = {
    gravity: Number(args["dangle-gravity"] ?? DANGLE_DEFAULTS.gravity),
    stiffness: Number(args["dangle-stiffness"] ?? DANGLE_DEFAULTS.stiffness),
    damping: Number(args["dangle-damping"] ?? DANGLE_DEFAULTS.damping),
    // The floor is what makes a rat read as a rat: the tail reaches the ground
    // and stays on it, rather than hanging in an arc that ends in mid-air.
    floorY: args["dangle-floor"] === "none" ? null : T.groundY,
  };
  for (const rootName of roots) {
    const chain = resolveChain(skeleton.bones, rootName);
    if (!chain || chain.length < 2) {
      console.log(`  ! --dangle: no chain of two or more bones at "${rootName}"`);
      continue;
    }
    // The rig's own rest locals, read off the bind pose before any mixer has
    // touched the skeleton. Both the spring's target and the frame every
    // emitted rotation is measured against.
    skeleton.pose();
    mesh.updateMatrixWorld(true);
    for (const b of chain) dangled.add(b.name);
    const restQuat = chain.map((b) => b.quaternion.clone());
    const restPos = chain.map((b) => b.position.clone());
    // the floor is for the tail's SKIN, not its bones: raised by the tail's
    // own thickness (the rat's lay half under the ground, 5-17 cm in red)
    let floorY = opts.floorY;
    if (floorY !== null) {
      const names = new Set(chain.map((b) => b.name)), d = [];
      const pos = geo.attributes.position, v = V3();
      for (let i = 0; i < vcount; i++) {
        let lead = 0;
        for (let k = 1; k < 4; k++) if (skinWeight[i * 4 + k] > skinWeight[i * 4 + lead]) lead = k;
        const n = nodes[skinIndex[i * 4 + lead]];
        if (!names.has(n.name)) continue;
        v.fromBufferAttribute(pos, i);
        let m = Infinity;
        for (const sg of segs.get(n.name)) m = Math.min(m, distanceToSegment(v, sg.a, sg.b));
        d.push(m);
      }
      d.sort((a, b) => a - b);
      if (d.length) floorY += d[Math.floor(d.length * 0.9)];
    }
    for (let i = 0; i < outClips.length; i++) {
      outClips[i] = bakeDangle(mesh, mixer, outClips[i], chain, restQuat, restPos, { ...opts, floorY });
    }
    console.log(
      `dangle ${chain.map((b) => b.name).join(" → ")}` +
        `  (g ${opts.gravity}, k ${opts.stiffness}, damp ${opts.damping}` +
        `${opts.floorY === null ? ", no floor" : ""})`,
    );
    // A clip mis-read as a one-shot opens with an unsettled tail; one mis-read
    // as a cycle has its ending overwritten by its beginning. The seam figure
    // is what to look at when either happens — it is the fraction of the
    // chain's reach between the clip's first pose and its last.
    console.log(
      `  cycles: ${outClips
        .map((c) => `${c.name} ${c.userData.looped ? "loop" : "once"} (seam ${(c.userData.seam * 100).toFixed(1)}%)`)
        .join(", ")}`,
    );
  }
  // Drop every binding this mixer made. Leaving them attached lets three
  // restore ITS captured "original" values under the next mixer on the same
  // skeleton, which silently zeroes the clip-speed measurement below.
  mixer.stopAllAction();
  mixer.uncacheRoot(mesh);
  skeleton.pose();
  mesh.updateMatrixWorld(true);
}


// What ground speed does each clip DEPICT? Without this the controller plays a
// walk at whatever pace its gait is tuned to and the feet skate by the ratio —
// the same trap retarget.mjs measures its way out of.
{
  const height = T.topY - T.groundY;
  const hip = nodes.find((n) => !skip.has(n.name));
  // A ground-level leaf bone is a foot — unless it is the end of a chain we
  // just hung, in which case it is a tail tip lying on the floor. Those slide
  // and lift on their own schedule, and letting one vote turns the median
  // ground speed into noise or drops the sample count below the floor.
  const contacts = nodes.filter(
    (n) =>
      !nodes.some((c) => c.parent === n) &&
      !dangled.has(n.name) &&
      // a --skip bone carries no flesh (a grazer's chin tip left unrelaxed
      // can sit near the floor); it is not a foot either
      !skip.has(n.name) &&
      n.worldPos.y < T.groundY + 0.12 * height,
  );
  if (args.report) console.log(`  contacts (speed is measured on): ${contacts.map((n) => n.name).join(", ")}`);
  if (hip && contacts.length) {
    const mixer = new THREE.AnimationMixer(mesh);
    const speeds = {};
    for (const clip of outClips) {
      // a hit reaction recoils the hips over planted feet: not locomotion
      if (/^Hit(_|$)/.test(clip.name)) continue;
      // a GENERATED gait depicts exactly the speed it was built for (stride / stance time);
      // measuring its slip reads the paws' roll (the pig's Run measured 1.86 for a 4.46 gallop)
      if (clip.userData?.speed > 0) {
        speeds[clip.name] = Number(clip.userData.speed.toFixed(2));
        continue;
      }
      const N = 120;
      const dt = clip.duration / N;
      if (!(dt > 0)) continue;
      const action = mixer.clipAction(clip);
      action.play();
      const hips = [];
      const feet = contacts.map(() => []);
      for (let i = 0; i <= N; i++) {
        mixer.setTime(clip.duration * (i / N) * 0.999);
        mesh.updateMatrixWorld(true);
        hips.push(hip.bone.getWorldPosition(V3()));
        contacts.forEach((c, k) => feet[k].push(c.bone.getWorldPosition(V3())));
      }
      action.stop();
      mixer.uncacheClip(clip);
      const slips = [];
      for (const track of feet) {
        // A foot is planted at the BOTTOM OF ITS OWN ARC in this clip, not at
        // some absolute height above the ground. A gallop lifts the whole body
        // — this dog's Run carries its hips a fifth of a body-height higher
        // than its Walk — so against a fixed line the feet of a running animal
        // never touch and the clip cannot be measured at all. Per-foot,
        // per-clip, the stance phase is always found.
        let lowest = Infinity;
        for (const p of track) lowest = Math.min(lowest, p.y);
        const planted = lowest + 0.06 * height;
        for (let i = 0; i < track.length - 1; i++) {
          if (track[i].y > planted || track[i + 1].y > planted) continue;
          // A planted foot measured against the hip: what is left is the ground
          // sliding past, which is the speed the clip depicts.
          const d = track[i].clone().sub(hips[i]).sub(track[i + 1].clone().sub(hips[i + 1]));
          d.y = 0;
          slips.push((d.length() / dt) * modelScale);
        }
      }
      if (slips.length < 6) continue;
      slips.sort((a, b) => a - b);
      const mid = slips[Math.floor(slips.length / 2)];
      // Below walking pace it is not locomotion — it is a turn or an idle
      // shuffle, where a pivoting foot reads as a trickle of slip.
      if (mid > 0.4) speeds[clip.name] = Number(mid.toFixed(2));
    }
    mixer.stopAllAction();
    skeleton.pose();
    mesh.updateMatrixWorld(true);
    if (Object.keys(speeds).length) {
      console.log(`clipSpeeds (m/s, paste into third-person-controller): ${JSON.stringify(speeds)}`);
    }
  }
}

const wrapper = new THREE.Group();
wrapper.name = path.basename(args.out ?? args.mesh).replace(/\.[^.]+$/, "");
wrapper.add(mesh);
if (modelScale !== 1) {
  wrapper.scale.setScalar(modelScale);
  console.log(
    `scale: ${(T.topY - T.groundY).toFixed(3)} units tall -> x${modelScale.toFixed(3)} for ${args.height}m`,
  );
}

// ---- look at it
// `--clip` (or --preview) may name several clips, comma-separated: each one
// renders to its own sheet, <render>-<Clip>.png, so one bake is looked at whole.
const lookPicks = String(args.preview === true || args.preview === undefined ? (args.clip ?? "") : args.preview)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const lookClips = lookPicks.map((p) => outClips.find((c) => c.name.toLowerCase() === p)).filter(Boolean);
if (!lookClips.length && outClips.length) lookClips.push(outClips[0]);
if (args.preview || args.render) for (const clip of lookClips) {
  const renderTo =
    lookClips.length > 1
      ? String(args.render === true ? "autorig.png" : args.render).replace(/(\.png)?$/i, `-${clip.name}.png`)
      : String(args.render === true ? "autorig.png" : args.render);
  const mixer = new THREE.AnimationMixer(mesh);
  mixer.clipAction(clip).play();
  const count = Number(args.frames ?? 4);
  const raw = [];
  for (let k = 0; k < count; k++) {
    const t = (k / count) * clip.duration;
    mixer.setTime(t);
    mesh.updateMatrixWorld(true);
    const world = new Map(nodes.map((n) => [n.name, n.bone.matrixWorld.clone()]));
    raw.push({ t, pts: skinnedPoints(mesh, world) });
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(mesh);
  skeleton.pose();
  mesh.updateMatrixWorld(true);

  if (args.preview) {
    console.log(`\npreview: ${clip.name}`);
    const filled = raw.map((f) => ({ t: f.t, pts: surfacePoints(f.pts) }));
    // One box for every frame, or a leg swinging forward reads as the whole
    // animal sliding backwards.
    const box = new THREE.Box3();
    for (const f of filled) for (const p of f.pts) box.expandByPoint(p);
    for (const f of filled) asciiView(f.pts, "z", "y", 64, 20, `t=${f.t.toFixed(2)}`, box);
  }
  if (args.render) {
    let tex = null;
    if (texFile && fs.existsSync(texFile)) {
      const png = decodePng(fs.readFileSync(texFile));
      tex = { width: png.width, height: png.height, rgba: png.data ?? png.rgba };
    }
    const img = renderStrip(raw, geo, tex, Number(args.tile ?? 300), T.groundY);
    const file = path.resolve(renderTo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(img.width, img.height, img.rgba));
    console.log(`rendered ${clip.name} to ${path.relative(process.cwd(), file)} (${img.width}x${img.height})`);
  }
}

// ---- export
// a NaN in one key is an invisible mesh in the game: refuse to ship it
for (const c of outClips) for (const t of c.tracks) if (Array.from(t.values).some((v) => !Number.isFinite(v))) {
  console.error(`autorig: clip ${c.name} track ${t.name} has a non-finite key — not writing`);
  process.exit(1);
}
const outPath = path.resolve(
  args.out || path.join(path.dirname(args.mesh), path.basename(args.mesh).replace(/\.[^.]+$/, ".glb")),
);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const glb = await new GLTFExporter().parseAsync(wrapper, {
  binary: true,
  onlyVisible: false,
  animations: outClips,
  maxTextureSize: 4096,
});
fs.writeFileSync(outPath, Buffer.from(glb));
console.log(`\nwrote ${path.relative(process.cwd(), outPath)} — ${(glb.byteLength / 1024).toFixed(0)} KB`);
