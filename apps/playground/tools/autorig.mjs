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

if (args.help || !args.mesh || !args.rig) {
  console.log(`
autorig — skin an unrigged mesh to a donor rig's skeleton and clips

  --mesh <file>        target mesh: .obj, .glb/.gltf or .fbx. No skeleton needed.
  --rig  <file>        donor: a skinned mesh with a skeleton and clips (.glb or .fbx).
  --out  <file.glb>    output. Default: alongside --mesh, same basename.
  --forward <axis>     which way the TARGET faces: +x -x +z -z. Default +z.
  --texture <file>     base colour map for the target (default: the .mtl's map_Kd).
  --pose <ref>         reference pose to fit in: "bind", "avg:Walk" (default:
                       the average over the first locomotion-looking clip),
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
  --loop-fix <none>    keep the donor's key timing, hitch and all.
  --influences <n>     max bones per vertex. Default 4.
  --falloff <p>        weight falloff exponent; higher = more rigid. Default 4.
  --head-fit <mode>    "similarity" (default) or "warp".
  --no-symmetry        keep the reference pose's own left/right asymmetry.
  --relax <n>          settle joints into the target's limbs, n passes. Default 2.
  --skip <a,b>         donor bones that may never receive weights. Default root.
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
  let o = 0;
  for (const g of parts) {
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
  if (!parts.some((g) => g.attributes.normal)) out.computeVertexNormals();
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
      if (o.isMesh) geos.push(o.geometry);
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
function referencePose(spec, scene, skinned, clips) {
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
  for (const b of bones) {
    const a = acc.get(b.name);
    b.position.copy(a.p).multiplyScalar(1 / samples);
    b.scale.copy(a.s).multiplyScalar(1 / samples);
    b.quaternion.copy(averageQuaternions(a.q));
  }
  scene.updateMatrixWorld(true);
  const world = new Map(bones.map((b) => [b.name, b.matrixWorld.clone()]));
  return { name: avg ? `avg over ${clip.name}` : `${clip.name}@${atRaw ?? 0}`, world };
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
    if (!twin && offCentre(p.x, widest)) {
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
  const bellyY = midline.length ? Math.min(...midline.map((p) => p.y)) : box.min.y;

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

function viewBasis(dir) {
  const f = V3().copy(dir).normalize();
  const r = V3().crossVectors(V3(0, 1, 0), f).normalize();
  const u = V3().crossVectors(f, r);
  return { r, u, f };
}

function renderStrip(frames, geo, texture, tile = 300) {
  const uv = geo.attributes.uv;
  const views = [viewBasis(V3(1, 0.12, 0.001)), viewBasis(V3(0.75, 0.35, 0.62))];
  const width = tile * frames.length;
  const height = tile * views.length;
  const rgba = new Uint8Array(width * height * 4).fill(0x14);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;

  // One projection for every frame, so motion reads as motion.
  const all = frames.flatMap((f) => f.pts);
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
  // A walk is the steadiest neutral a quadruped rig offers: a run averages to
  // a crouch with the feet off the ground, an idle to whatever it was looking at.
  const loco =
    ["walk", "trot", "run", "idle"]
      .map((k) => gltf.animations.find((c) => new RegExp(k, "i").test(c.name)))
      .find(Boolean) ?? gltf.animations[0];
  poseSpec = loco ? `avg:${loco.name}` : "bind";
}
const ref = referencePose(String(poseSpec), gltf.scene, donor, gltf.animations);
if (!args["no-symmetry"]) symmetrise(ref.world);
const donorPoints = skinnedPoints(donor, ref.world);
const D = measure(donorPoints);
const T = measure(tgtPoints);
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
const nodes = donorBones.map((b) => {
  const p = V3();
  const q = new THREE.Quaternion();
  const s = V3();
  ref.world.get(b.name).decompose(p, q, s);
  const head = !!headFit && p.z > D.headFrom;
  // A skipped bone is an armature anchor, not anatomy: leave it where it is,
  // so root motion and the hip track stay measured from the same origin.
  const worldPos = skip.has(b.name) ? p.clone() : head ? headFit(p) : warp(p);
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
geo.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
geo.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));

const led = bindable.filter((n) => usage.get(n.name) > 0);
console.log(
  `weights: ${maxInf} influences, falloff ${falloff}; ${led.length}/${bindable.length} bones lead at least one vertex`,
);
if (args.report) {
  const idle = bindable.filter((n) => usage.get(n.name) === 0).map((n) => n.name);
  if (idle.length) console.log(`  no vertices lead by: ${idle.join(", ")}`);
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
  return new THREE.AnimationClip(as, clip.duration, tracks);
});
console.log(`clips: ${outClips.map((c) => `${c.name} ${c.duration.toFixed(2)}s`).join(", ")}`);

// ---- loop hygiene: keys to zero, and one frame for the wrap to happen in
if (args["loop-fix"] !== "none") {
  const notes = [];
  for (let i = 0; i < outClips.length; i++) {
    const r = normalizeLoop(outClips[i]);
    outClips[i] = r.clip;
    notes.push(
      `${r.clip.name} ${r.kind} (ends ${r.ratio.toFixed(1)} frames apart` +
        `${r.shifted > 0 ? `, head trimmed ${(r.shifted * 1000).toFixed(0)}ms` : ""})`,
    );
  }
  console.log(`loops: ${notes.join(", ")}`);
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
    const ctx = { mesh, skeleton, limbs, spine, head, hip, rest, T, modelScale };

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
    for (let i = 0; i < outClips.length; i++) {
      outClips[i] = bakeDangle(mesh, mixer, outClips[i], chain, restQuat, restPos, opts);
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
      n.worldPos.y < T.groundY + 0.12 * height,
  );
  if (hip && contacts.length) {
    const mixer = new THREE.AnimationMixer(mesh);
    const speeds = {};
    for (const clip of outClips) {
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
if (args.preview || args.render) {
  const pick = String(args.preview === true ? "" : (args.preview ?? args.clip ?? "")).toLowerCase();
  const clip = outClips.find((c) => c.name.toLowerCase() === pick) ?? outClips[0];
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
    const img = renderStrip(raw, geo, tex);
    const file = path.resolve(String(args.render === true ? "autorig.png" : args.render));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePng(img.width, img.height, img.rgba));
    console.log(`rendered ${clip.name} to ${path.relative(process.cwd(), file)} (${img.width}x${img.height})`);
  }
}

// ---- export
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
