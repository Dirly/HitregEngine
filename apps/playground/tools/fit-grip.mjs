/**
 * fit-grip — work out a `bone-socket`'s offset and rotation so a held item sits
 * IN the hand the way a hand actually holds it, from the anatomy of the
 * character and the shape of the item, instead of nudging numbers by eye.
 *
 *   node tools/fit-grip.mjs --project voxel-demo --scene mmo --actor player-visual \
 *     --socket player-weapon --grip handle --handle Handle --blade Blade1
 *   node tools/fit-grip.mjs ... --socket player-shield --grip shield --face Shield2 --bone CC_Base_L_Forearm
 *
 * Why computed: a socket's six numbers are tuned against ONE pose, and a grip
 * that looks right at idle is wrong the moment the wrist turns — the
 * "sword floating beside an open palm" look. Anatomy gives a frame that is
 * right in every pose, because the fist carries it:
 *
 *   hand     the palm centre is the centroid of the vertices skinned mainly to
 *            the hand bone; the wrist→palm direction is the hand's FORWARD;
 *            the index knuckle, off that line, is the THUMB SIDE; the palm
 *            normal is the side the index finger CURLS toward in a fist pose.
 *   handle   (a sword, an axe, a staff) runs across the fist: the blade leaves
 *            over the thumb side, tilted toward the fingers (--tilt, degrees),
 *            its flat facing the palm — which is how a hammer grip holds an
 *            edge in line with the knuckles.
 *   shield   rides the forearm: face out from the BACK of the hand, its long
 *            axis along the thumb side (a heater stands upright when the
 *            forearm is level across the chest), centred just behind the wrist.
 *
 * The item model's axes are measured too — handle centroid, handle→blade axis,
 * the blade's thinnest direction (PCA) — so a new model needs no annotation.
 * Prints the params, and with --write patches the socket entity in the scene
 * file (read the file first: the editor autosaves). Check the result with
 * pose-sheet: its sockets come from the same scene.
 */
import "./node-dom-shim.mjs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
if (args.help || !args.project || !(args.scene || args.prefab) || !args.socket) {
  console.log(`
fit-grip — compute a bone-socket's offset/rotation from hand anatomy + item shape

  --project <name> --scene <name> --actor <entity>   where the character and socket live
  --prefab <id>            instead of --scene: a prefab (assets/prefabs/<id>.json), e.g. characters/player
  --socket <entity>        the bone-socket entity to fit (its model and scale are read)
  --grip handle|shield|center|back  how the item is held (default handle): shield = strapped along
                           the forearm (carried), center = square to the fist (every guard clip),
                           back = holstered on the back (--bone a spine bone; with --as alt)
  --as alt                 write it as the socket's SECOND pose (altOffset/altRotationDeg)
  --when <key>             with --as alt: the character userData key that selects it (combatUntil)
  --hand <bone>            the hand whose anatomy frames the grip (default: the socket's bone,
                           or CC_Base_<side>_Hand for a forearm socket)
  --bone <bone>            bone to socket to (default: the socket's current bone)
  --handle <parts>         handle part name(s), '+'-joined (grip = their centroid)
  --blade <parts>          blade/head part name(s) (axis = handle -> blade)
  --face <parts>           shield body part(s) (grip shield)
  --model-frame            the model is in the placeholder frame (grip at origin, +Y up, +Z thin)
  --tilt <deg>             blade tilt toward the fingers (default 18); negative raises it toward
                           the elbow, i.e. tip UP with the arm hanging
  --lean <deg>             shield long axis swung from the thumb toward the elbow (default 0)
  --depth <m>              handle axis in front of the palm centre (default 0.028)
  --reach <m>              handle axis toward the fingertips (default 0.012)
  --standoff <m>           shield face distance out from the forearm (default 0.075)
  --back <m>               shield centre behind the wrist, toward the elbow (default 0.06)
  --fist <clip>            a clip whose first frame closes THAT hand's fist (default: Sword_Idle for the
                           right hand, SwordShield_Idle for the left — Sword_Idle leaves the left open)
  --write                  patch the socket's params into the scene file
`);
  process.exit(0);
}

const projectDir = path.resolve(here, "..", "projects", String(args.project));
const assetsDir = path.join(projectDir, "assets");
const assetPath = (id) => path.join(assetsDir, id.startsWith("models/") ? id : path.join("models", id));
// a scene, or a prefab — whose entity map is edited exactly like a scene's
const sceneFile = args.prefab
  ? path.join(assetsDir, "prefabs", `${args.prefab}.json`)
  : path.join(assetsDir, "scenes", `${args.scene}.scene.json`);

function loadGlb(file) {
  const buf = fs.readFileSync(file);
  const warn = console.warn;
  console.warn = () => {};
  return new Promise((resolve, reject) =>
    new GLTFLoader().parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      "",
      (g) => ((console.warn = warn), resolve(g)),
      (e) => ((console.warn = warn), reject(e)),
    ),
  );
}

const scene = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
const ents = scene.entities ?? {};
const actor = ents[args.actor];
const sockEnt = ents[args.socket];
if (!actor || !sockEnt) {
  console.error(`fit-grip: need --actor and --socket entities that exist in ${args.scene}`);
  process.exit(1);
}
const sockScript = [sockEnt.components?.script, ...(sockEnt.components?.scripts ?? [])].find((s) => s?.name === "bone-socket");
const boneName = String(args.bone ?? sockScript?.params?.bone ?? "CC_Base_R_Hand");
const side = /_L_|Left|_l$/.test(boneName) ? "L" : "R";
const handName = String(args.hand ?? (/Hand/.test(boneName) ? boneName : `CC_Base_${side}_Hand`));
const scale = sockEnt.components?.transform?.scale?.[0] ?? 1;
const itemModel = sockEnt.components?.mesh?.source?.assetId;

const character = await loadGlb(assetPath(actor.components.mesh.source.assetId));
const root = character.scene;
root.updateMatrixWorld(true);
const bone = root.getObjectByName(boneName);
const hand = root.getObjectByName(handName);
const index1 = root.getObjectByName(`CC_Base_${side}_Index1`);
if (!bone || !hand || !index1) {
  console.error(`fit-grip: the character lacks ${[!bone && boneName, !hand && handName, !index1 && "an index finger"].filter(Boolean).join(", ")}`);
  process.exit(1);
}

// ---- hand anatomy, at bind
// (x, y, z) must be FORWARDED: a V() that dropped them made every V(1, 0, 0)
// a zero vector, and the blade-flat and shield axes all silently zero.
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const handPos = hand.getWorldPosition(V());
let skinned = null;
root.traverse((o) => {
  if (o.isSkinnedMesh && !skinned) skinned = o;
});
const handIndex = skinned.skeleton.bones.indexOf(hand);
const si = skinned.geometry.getAttribute("skinIndex");
const sw = skinned.geometry.getAttribute("skinWeight");
const palm = V();
let count = 0;
for (let i = 0; i < si.count; i++) {
  let best = -1;
  let bw = 0;
  for (let k = 0; k < 4; k++) {
    if (sw.getComponent(i, k) > bw) {
      bw = sw.getComponent(i, k);
      best = si.getComponent(i, k);
    }
  }
  if (best !== handIndex) continue;
  palm.add(skinned.getVertexPosition(i, V()).applyMatrix4(skinned.matrixWorld));
  count++;
}
if (!count) {
  console.error(`fit-grip: no vertices are skinned mainly to ${handName}`);
  process.exit(1);
}
palm.divideScalar(count);
const forward = palm.clone().sub(handPos).normalize();
// Palm normal: the way the index finger CURLS in a closed fist, taken in
// hand-local terms (which no pose changes) and brought back at bind. Thumb
// side: the thumb bone, with its palm-ward share removed. Both are strong
// signals; the index knuckle, used first, sits ~1 cm off the hand's axis on
// this rig and pointed the "thumb side" the wrong way — blades down the leg.
const handQ = hand.getWorldQuaternion(new THREE.Quaternion());
const thumb1 = root.getObjectByName(`CC_Base_${side}_Thumb1`);
const tip = root.getObjectByName(`CC_Base_${side}_Index3`);
const fist = character.animations.find((c) => c.name === String(args.fist ?? (side === "L" ? "SwordShield_Idle" : "Sword_Idle")));
if (!thumb1 || !tip || !fist) {
  console.error(`fit-grip: need CC_Base_${side}_Thumb1, CC_Base_${side}_Index3 and a fist clip ("${args.fist ?? "Sword_Idle"}")`);
  process.exit(1);
}
let curlLocal;
{
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(fist).play();
  mixer.setTime(0);
  root.updateMatrixWorld(true);
  curlLocal = tip.getWorldPosition(V()).sub(index1.getWorldPosition(V())).applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()).invert());
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  root.traverse((o) => o.isSkinnedMesh && o.skeleton.pose()); // back to bind
  root.updateMatrixWorld(true);
}
const curl = curlLocal.applyQuaternion(handQ);
const palmNormal = curl.sub(forward.clone().multiplyScalar(curl.dot(forward))).normalize();
const thumbOff = thumb1.getWorldPosition(V()).sub(handPos);
const thumbSide = thumbOff
  .sub(forward.clone().multiplyScalar(thumbOff.dot(forward)))
  .sub(palmNormal.clone().multiplyScalar(thumbOff.dot(palmNormal)))
  .normalize();

// ---- the item's own axes
const item = await loadGlb(assetPath(itemModel));
let partIds = null;
item.scene.traverse((o) => {
  if (o.userData?.parts) partIds = o.userData.parts;
});
item.scene.updateMatrixWorld(true);
function partPoints(names) {
  const want = new Set(String(names).split("+").map((n) => partIds?.[n]).filter((n) => n !== undefined));
  if (!want.size) {
    console.error(`fit-grip: no parts "${names}" in ${itemModel} (has: ${Object.keys(partIds ?? {}).join(", ")})`);
    process.exit(1);
  }
  const pts = [];
  item.scene.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.getAttribute("position");
    const part = m.geometry.getAttribute("uv1");
    for (let i = 0; i < pos.count; i++) {
      if (part && !want.has(Math.round(part.getX(i)))) continue;
      pts.push(V().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    }
  });
  return pts;
}
const centroid = (pts) => pts.reduce((a, p) => a.add(p), V()).divideScalar(pts.length);
/** The axis along which `pts` are thinnest (power iteration on the inverse is overkill: 3x3 Jacobi). */
function thinnest(pts, orthoTo) {
  const c = centroid(pts);
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = p.clone().sub(c);
    if (orthoTo) d.sub(orthoTo.clone().multiplyScalar(d.dot(orthoTo)));
    const a = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += a[i] * a[j];
  }
  // smallest eigenvector by sampling directions finely (robust, no library)
  let best = null;
  let bestV = Infinity;
  for (let t = 0; t < 180; t += 1)
    for (let p = -90; p <= 90; p += 1) {
      const th = (t * Math.PI) / 180;
      const ph = (p * Math.PI) / 180;
      const v = V(Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th));
      if (orthoTo && Math.abs(v.dot(orthoTo)) > 0.02) continue;
      const a = [v.x, v.y, v.z];
      let q = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) q += a[i] * m[i * 3 + j] * a[j];
      if (q < bestV) {
        bestV = q;
        best = v;
      }
    }
  return best.normalize();
}

const grip = String(args.grip ?? "handle");
let gripM; // model-space grip centre
let axisM; // model-space primary axis (blade / shield up)
let normalM; // model-space secondary axis (blade flat / shield face)
let axisW; // world target for axisM
let normalW; // world target for normalM
let gripW; // world target for gripM
const tilt = (Number(args.tilt ?? 18) * Math.PI) / 180;

if (grip === "handle") {
  if (args["model-frame"]) {
    // a model authored in the placeholder frame (placeholder-weapons.mjs):
    // grip at the origin, +Y up the weapon, +Z its thin side — nothing to measure
    gripM = V(0, 0, 0);
    axisM = V(0, 1, 0);
    normalM = V(0, 0, 1);
  } else {
    const handle = partPoints(args.handle ?? "Handle");
    const blade = partPoints(args.blade ?? "Blade1");
    gripM = centroid(handle);
    axisM = centroid(blade).sub(gripM).normalize();
    normalM = thinnest(blade, axisM);
  }
  axisW = thumbSide.clone().multiplyScalar(Math.cos(tilt)).add(forward.clone().multiplyScalar(Math.sin(tilt))).normalize();
  normalW = palmNormal.clone().sub(axisW.clone().multiplyScalar(palmNormal.dot(axisW))).normalize();
  gripW = palm
    .clone()
    .add(palmNormal.clone().multiplyScalar(Number(args.depth ?? 0.028)))
    .add(forward.clone().multiplyScalar(Number(args.reach ?? 0.012)));
} else if (grip === "hip") {
  // HOLSTERED at the LEFT hip, off the pelvis, for a right hand to cross-draw.
  // Faces +Z at bind, so the left side is +X. A blade hangs point-down and
  // raked back like a scabbard, flat against the thigh; an axe or mace
  // (--head-up) hangs head-up from the belt with the haft down the thigh.
  if (args["model-frame"]) {
    gripM = V(0, 0, 0);
    axisM = V(0, 1, 0);
    normalM = V(0, 0, 1);
  } else {
    const handle = partPoints(args.handle ?? "Handle");
    const blade = partPoints(args.blade ?? "Blade1");
    gripM = centroid(handle);
    axisM = centroid(blade).sub(gripM).normalize();
    normalM = thinnest(blade, axisM);
  }
  // --right: the RIGHT hip instead — where an off-hand weapon hangs, for the
  // left hand to cross-draw. The same hang, mirrored across the body.
  const headUp = Boolean(args["head-up"]);
  const m = args.right ? -1 : 1;
  const pelvis = bone.getWorldPosition(V());
  axisW = headUp ? V(0.05 * m, 1, -0.25).normalize() : V(0.08 * m, -1, -0.55).normalize();
  normalW = V(m, 0, 0);
  gripW = pelvis
    .clone()
    .add(V(0.19 * m, Number(args.up ?? (headUp ? -0.12 : 0.02)), Number(args.forward ?? 0.04)));
} else if (grip === "back") {
  // HOLSTERED on the back, off a spine bone. The character faces +Z at bind
  // (the controller's convention), so its back is -Z and its right is -X.
  // Weapons hang diagonally, grip up behind the right shoulder and the blade
  // flat to the back; shields sit centred, face out. Starting points to be
  // placed by eye.
  const spine = bone.getWorldPosition(V());
  const back = V(0, 0, -1);
  if (args.face) {
    const face = partPoints(args.face);
    const c = centroid(face);
    normalM = thinnest(face);
    const rimBack = face.reduce((acc, p) => acc + p.clone().sub(c).dot(normalM), 0);
    if (rimBack > 0) normalM.negate();
    axisM = V(0, 1, 0).sub(normalM.clone().multiplyScalar(normalM.y)).normalize();
    gripM = c;
    axisW = V(0, 1, 0);
    normalW = back.clone();
    gripW = spine.clone().add(back.clone().multiplyScalar(Number(args.standoff ?? 0.17))).add(V(0, 0.02, 0));
  } else {
    if (args["model-frame"]) {
      gripM = V(0, 0, 0);
      axisM = V(0, 1, 0);
      normalM = V(0, 0, 1);
    } else {
      const handle = partPoints(args.handle ?? "Handle");
      const blade = partPoints(args.blade ?? "Blade1");
      gripM = centroid(handle);
      axisM = centroid(blade).sub(gripM).normalize();
      normalM = thinnest(blade, axisM);
    }
    // a sword hangs blade DOWN toward the left hip, grip over the right
    // shoulder; an axe, a staff or a mace (--head-up) the other way round —
    // head over the right shoulder, grip low at the left
    const headUp = Boolean(args["head-up"]);
    axisW = headUp ? V(-0.4, 1, 0).normalize() : V(0.4, -1, 0).normalize();
    normalW = back.clone();
    gripW = spine
      .clone()
      .add(V(headUp ? 0.1 : -0.12, Number(args.up ?? (headUp ? -0.12 : 0.22)), 0))
      .add(back.clone().multiplyScalar(Number(args.standoff ?? 0.2)));
  }
} else if (grip === "shield" || grip === "center") {
  const face = partPoints(args.face ?? "Shield2");
  const c = centroid(face);
  // face normal: the thinnest direction; out = away from the grip side, taken
  // as the side the centroid of the whole shield is NOT on (straps and the
  // boss's back sit behind the face)
  normalM = thinnest(face);
  // long axis: the widest spread within the face plane
  let bestA = null;
  let bestS = -1;
  for (let t = 0; t < 360; t++) {
    const u = V(1, 0, 0);
    if (Math.abs(u.dot(normalM)) > 0.9) u.set(0, 1, 0);
    const e1 = u.sub(normalM.clone().multiplyScalar(u.dot(normalM))).normalize();
    const e2 = V().crossVectors(normalM, e1);
    const a = e1.multiplyScalar(Math.cos((t * Math.PI) / 180)).add(e2.multiplyScalar(Math.sin((t * Math.PI) / 180)));
    let s = 0;
    for (const p of face) s += p.clone().sub(c).dot(a) ** 2;
    if (s > bestS) {
      bestS = s;
      bestA = a.clone();
    }
  }
  axisM = bestA.normalize();
  // a heater is widest at the TOP: the bounding middle sits below the centroid
  const along = face.map((p) => p.clone().sub(c).dot(axisM));
  const mid = (Math.max(...along) + Math.min(...along)) / 2;
  if (mid > 0) axisM.negate();
  // the face is convex outward: the rim sits BEHIND the centre point
  const rimBack = face.reduce((s, p) => s + p.clone().sub(c).dot(normalM), 0);
  if (rimBack > 0) normalM.negate();
  gripM = c;
  // "shield": strapped along the forearm, face out from the back of the hand
  // (how it is CARRIED). "center": held in the fist like a centre-grip round
  // shield, face out along the knuckles (how every guard clip in the
  // libraries holds it — arm pushed forward, shield square to the arm).
  const back = grip === "center" ? forward.clone() : palmNormal.clone().negate();
  // --lean swings the long axis from the thumb toward the ELBOW: at 0 a
  // heater stands upright only with the forearm level across the chest (a
  // guard), and lies on its side with the arm hanging — which is most of the
  // time. Between the two it reads right both walking and blocking.
  const lean = (Number(args.lean ?? 0) * Math.PI) / 180;
  axisW = thumbSide.clone().multiplyScalar(Math.cos(lean)).add(forward.clone().multiplyScalar(-Math.sin(lean))).normalize();
  normalW = back.sub(axisW.clone().multiplyScalar(back.dot(axisW))).normalize();
  gripW =
    grip === "center"
      ? palm.clone().add(normalW.clone().multiplyScalar(Number(args.standoff ?? 0.07)))
      : handPos
          .clone()
          .add(forward.clone().multiplyScalar(-Number(args.back ?? 0.06)))
          .add(normalW.clone().multiplyScalar(Number(args.standoff ?? 0.075)));
} else {
  console.error(`fit-grip: --grip must be handle, shield, center, back or hip`);
  process.exit(1);
}

// ---- rotation carrying the model frame onto the hand frame, then the socket
const frame = (a, n) => {
  const b = V().crossVectors(a, n).normalize();
  const nn = V().crossVectors(b, a).normalize();
  return new THREE.Matrix4().makeBasis(a.clone().normalize(), nn, b);
};
const R = new THREE.Quaternion().setFromRotationMatrix(frame(axisW, normalW).multiply(frame(axisM, normalM).transpose()));
const boneQ = bone.getWorldQuaternion(new THREE.Quaternion());
const bonePos = bone.getWorldPosition(V());
const offsetQ = boneQ.clone().invert().multiply(R);
const offset = gripW
  .clone()
  .sub(bonePos)
  .applyQuaternion(boneQ.clone().invert())
  .sub(gripM.clone().multiplyScalar(scale).applyQuaternion(offsetQ));
const e = new THREE.Euler().setFromQuaternion(offsetQ, "XYZ");
const round = (v, k = 1000) => Math.round(v * k) / k;
const fitted = {
  offset: [offset.x, offset.y, offset.z].map((v) => round(v)),
  rotationDeg: [e.x, e.y, e.z].map((r) => round((r * 180) / Math.PI, 10)),
};
// --as alt: this is the socket's SECOND pose (bone-socket altOffset /
// altRotationDeg), eased in while its altWhen holds — the guard of a shield
// whose main pose is how it is carried
const params =
  args.as === "alt"
    ? { altBone: boneName, altOffset: fitted.offset, altRotationDeg: fitted.rotationDeg, ...(args.when ? { altWhen: String(args.when) } : {}) }
    : { bone: boneName, ...fitted };
console.log(`hand ${handName}: palm centre from ${count} verts; grip "${grip}" on ${boneName}`);
console.log(JSON.stringify(params));

if (args.write) {
  // A scene mutation is an ops batch (CLAUDE.md), validated against the
  // component schema — not a hand patch of the JSON. Re-read first: the
  // editor autosaves.
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(new URL("../package.json", import.meta.url));
  // node-dom-shim defines a global `document` for three's loaders, and tsx's
  // CJS bundle takes that as "in a browser" and builds its own URL from
  // document.currentScript — which throws. Hide it for the import.
  const shimDoc = globalThis.document;
  delete globalThis.document;
  const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
  const core = await tsImport("../../../packages/core/src/index.ts", import.meta.url);
  globalThis.document = shimDoc;
  const registry = new core.ComponentRegistry();
  core.registerCoreComponents(registry);
  core.registerChunkComponents?.(registry);
  const file = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
  const doc = args.prefab ? { version: 1, name: "prefab", entities: file.entities } : file;
  const current = doc.entities[args.socket].components.script;
  const ops = [{ op: "set-component", id: args.socket, component: "script", data: { ...current, params: { ...(current.params ?? {}), ...params } } }];
  const next = core.applyOps(doc, ops, registry).doc;
  if (args.prefab) {
    file.entities = next.entities;
    core.validatePrefab(file);
  }
  fs.writeFileSync(sceneFile, JSON.stringify(args.prefab ? file : next, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), sceneFile)} → ${args.socket}`);
}
