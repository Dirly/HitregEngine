#!/usr/bin/env node
/**
 * skirt-fit — MEASURE where a character's legs come out through its skirt panels (tassets, robe panels) across its
 * locomotion clips.
 *
 *   node tools/skirt-fit.mjs --glb projects/foundation/assets/models/mmo/human-body.glb            # measure
 *   node tools/skirt-fit.mjs --glb <body.glb> --robe [--calf-from 0.75 --hem-margin 2] [--write]   # fit the robe
 *
 * Run --robe --write after reskin rebuilds a body (tools/_robe-fit.mjs says what it changes and why).
 *
 * Why: panels bound wholly to the pelvis (reskin `--bind`, so the auto-rigger's thigh weights stop warping them) hang
 * straight while the legs swing, and the robes' copied thigh weights do not reach the calves: in a run the leading
 * leg came out through the front tasset and the trailing calf through the back panels, up to 50 cm on a 1.8 m body
 * (Derek 2026-11-08, glitch.mp4). Hiding the legs is not an option: robes are open at the front. A bone per panel
 * swung out of the legs' way was tried and rejected the same day: too rigid, it read as a hinged plate and lifted
 * the hem; a welded panel split between two bones tore down its middle. Derek: keep leveraging the leg bones.
 * What works (tools/_robe-fit.mjs): the backs of the legs under the robe are left out of the draw while it shows,
 * and the robe's lower part rides the calves. The measure overstates a hem flipped up by a kick: judge the sheet.
 *
 * MEASURE: each clip plays at 60 fps; at --frames moments of its second loop, every leg vertex inside a panel's
 * outline (each leg against its own half of the panel) is tested along that half's facing as posed: a back panel
 * must lie behind it, a front panel in front of it. A vertex the panel is on the wrong side of is a poke; its depth
 * is how far the leg is out through the cloth, in cm on a 1.8 m body ("thigh" or "calf": where the worst was).
 * Rows: clip, frames with a poke, worst depth, mean of the per-frame worst.
 *
 * LOOK (`--sheet out.png [--outfit tassets|robes] [--sheet-clip Sprint]`): the last measure's frames of one clip,
 * side, back, front and both front three-quarter views, legs grey, front panel orange, back panel blue (the male body).
 */
import "./node-dom-shim.mjs";
import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { renderStrip } from "./_softrender.mjs";
import { fitRobe } from "./_robe-fit.mjs";
import { encodePng } from "./_png.mjs";
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next === undefined || next.startsWith("--") ? true : process.argv[++i];
}
if (!args.glb) {
  console.error("usage: node tools/skirt-fit.mjs --glb <skinned.glb> [--clips Walk,Run,...] [--frames 24] [--sheet out.png]");
  process.exit(1);
}
const list = (v) => (v && v !== true ? String(v).split(",").filter(Boolean) : []);
const file = path.resolve(String(args.glb));
const FRAMES = Number(args.frames ?? 24);
const DEFAULT_CLIPS = "Walk,Run,Run_Bwd,Run_Left,Run_Right,Sprint,TwoHanded_Run,TwoHanded_Sprint";

// ---------------------------------------------------------------- the GLB, raw (for --write) and loaded (to pose)
const glb = fs.readFileSync(file);
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());

async function load(buf) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", res, rej));
  } finally {
    console.warn = warn;
  }
}

/** Part table (name -> index in TEXCOORD_1), from the mesh node's extras. */
function partTable(gltf) {
  let table;
  gltf.scene.traverse((o) => (table ??= o.userData?.parts));
  if (!table) {
    for (const n of json.nodes) table ??= n.extras?.parts;
  }
  if (!table) throw new Error("no `parts` table in the GLB's extras: not an ubermesh");
  return Array.isArray(table) ? Object.fromEntries(table.map((p, i) => [p.name ?? p, i])) : table;
}

/** Which panels to test against which legs: tassets/robes of each sex against that sex's leg parts. */
function pairings(table) {
  const names = Object.keys(table);
  const panels = names.filter((n) => /(Tasset|Robes)(Front|Back)$/.test(n));
  const female = (n) => /^(F_|HumanFemale_)/.test(n);
  return panels.map((panel) => ({
    panel,
    back: /Back$/.test(panel),
    legs: names.filter((n) => /Legs(Front|Back)$/.test(n) && female(n) === female(panel)),
  }));
}

function skinnedOf(gltf) {
  let mesh;
  gltf.scene.traverse((o) => (mesh ??= o.isSkinnedMesh ? o : undefined));
  return mesh;
}

const SHEET_PARTS = {
  tassets: { TassetFront: [235, 140, 50], TassetBack: [70, 130, 230] },
  robes: { RobesFront: [235, 140, 50], RobesBack: [70, 130, 230] },
  "robes+tasset": { RobesFront: [235, 140, 50], RobesBack: [70, 130, 230], TassetFront: [200, 60, 60] },
};
const SHEET_BODY = ["Human_LegsFront", "Human_LegsBack", "HumanMale_Foot", "Belt"];

async function measure(buf, label) {
  const gltf = await load(buf);
  const root = gltf.scene;
  const mesh = skinnedOf(gltf);
  const table = partTable(gltf);
  const pid = mesh.geometry.getAttribute("uv1") ?? mesh.geometry.getAttribute("uv2");
  const indexed = mesh.geometry.getIndex();
  const index = indexed ?? { count: pid.count, getX: (i) => i };
  const partOf = (v) => Math.round(pid.getX(v));
  const vertsOf = (name) => {
    const id = table[name];
    const out = [];
    for (let v = 0; v < pid.count; v++) if (partOf(v) === id) out.push(v);
    return out;
  };
  const trisOf = (name) => {
    const id = table[name];
    const out = [];
    for (let t = 0; t < index.count; t += 3) if (partOf(index.getX(t)) === id) out.push(index.getX(t), index.getX(t + 1), index.getX(t + 2));
    return out;
  };
  // the robe back's `covers` (tools/_robe-fit.mjs): leg triangles the game leaves out while that robe shows
  let covers = null;
  root.traverse((n) => (covers ??= n.userData?.covers ?? null));
  // and its `depthPull` (robe drawn nearer the camera), drawn on the sheet as the game draws it
  let depthPull = null;
  root.traverse((n) => (depthPull ??= n.userData?.depthPull ?? null));
  const coveredBy = (panel) => {
    if (!covers || !/Robes(Front|Back)$/.test(panel)) return null;
    const list = covers[/^F_/.test(panel) ? "F_RobesBack" : "RobesBack"];
    return list ? new Set(list) : null;
  };
  const pairsWhole = pairings(table).map((p) => {
    const hidden = coveredBy(p.panel);
    return { ...p, tris: trisOf(p.panel), legVerts: p.legs.flatMap(vertsOf).filter((v) => !hidden?.has(Math.floor(v / 3))) };
  });

  root.updateMatrixWorld(true);
  const bone = (n) => mesh.skeleton.bones.find((b) => b.name === n);
  const wp = (n) => bone(n).getWorldPosition(new THREE.Vector3());
  // body frame at rest: up from feet to head, left from the right thigh to the left, forward = left x up
  const up = wp("CC_Base_Head").sub(wp("CC_Base_Pelvis")).normalize();
  const left = wp("CC_Base_L_Thigh").sub(wp("CC_Base_R_Thigh"));
  left.addScaledVector(up, -left.dot(up)).normalize();
  const forward = new THREE.Vector3().crossVectors(left, up).normalize();
  // which way is forward really: the toes are in front of the ankles
  if (wp("CC_Base_L_ToeBase").sub(wp("CC_Base_L_Foot")).dot(forward) < 0) forward.negate();
  const box = new THREE.Box3().setFromObject(mesh);
  if (process.env.SKIRT_DEBUG) console.log("up", up.toArray(), "left", left.toArray(), "forward", forward.toArray());
  const toCm = 180 / (box.max.clone().sub(box.min).dot(up) || 1);

  // rest height of each leg vertex, in hip-to-knee lengths below the hip joints (-1 = the knee): where a poke is
  const hipL = wp("CC_Base_L_Thigh"), hipR = wp("CC_Base_R_Thigh"), hipMid = hipL.clone().add(hipR).multiplyScalar(0.5);
  const legLen = hipMid.distanceTo(wp("CC_Base_L_Calf").add(wp("CC_Base_R_Calf")).multiplyScalar(0.5));
  // one test per side: each leg against its own half of a panel (a robe's halves swing apart, each with its own leg)
  const restPos = (i) => new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), i).applyMatrix4(mesh.matrixWorld);
  const lateral = (p) => p.clone().sub(hipMid).dot(left);
  const pairs = pairsWhole.flatMap((p) =>
    [1, -1].map((sign) => {
      const tris = [];
      for (let k = 0; k < p.tris.length; k += 3) {
        const c = restPos(p.tris[k]).add(restPos(p.tris[k + 1])).add(restPos(p.tris[k + 2])).multiplyScalar(1 / 3);
        if (Math.sign(lateral(c)) === sign) tris.push(p.tris[k], p.tris[k + 1], p.tris[k + 2]);
      }
      return { ...p, tris, legVerts: p.legVerts.filter((i) => Math.sign(lateral(restPos(i))) === sign) };
    }),
  );
  const rest = new Map();
  for (const pair of pairs) for (const i of pair.legVerts) rest.set(i, new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute("position"), i).applyMatrix4(mesh.matrixWorld).sub(hipMid).dot(up) / legLen);
  const mixer = new THREE.AnimationMixer(root);
  const clips = list(args.clips ?? DEFAULT_CLIPS).map((n) => (n === "rest" ? { name: "rest", duration: 0, rest: true } : gltf.animations.find((c) => c.name === n))).filter(Boolean);
  const ray = new THREE.Raycaster();
  const rows = [];
  const sheetFrames = [];
  for (const clip of clips) {
    mixer.stopAllAction();
    const action = clip.rest ? null : mixer.clipAction(clip);
    action?.play();
    const row = { clip: clip.name, frames: 0, worst: 0, sum: 0, byPanel: {} };
    // play one loop to settle the cloth, then step to each sampled moment of the second
    const STEP = 1 / 60;
    let clock = 0;
    const advanceTo = (t) => {
      while (clock + 1e-9 < t) {
        const h = Math.min(STEP, t - clock);
        mixer.update(h);
        clock += h;
      }
    };
    mixer.setTime(0);
    for (let f = 0; f < FRAMES; f++) {
      advanceTo(clip.duration * (1 + f / FRAMES));
      root.updateMatrixWorld(true);
      const posed = new Map();
      const at = (i) => {
        let p = posed.get(i);
        if (!p) posed.set(i, (p = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld)));
        return p;
      };
      if (args.sheet && clip.name === String(args["sheet-clip"] ?? "Sprint")) {
        const colors = SHEET_PARTS[String(args.outfit ?? "tassets")];
        const tris = [];
        for (const name of [...SHEET_BODY, ...Object.keys(colors)]) {
          const hidden = String(args.outfit ?? "tassets").startsWith("robes") && !args["show-covered"] ? coveredBy("RobesBack") : null;
          const ids = trisOf(name).filter((v, k, all) => !hidden?.has(Math.floor(all[k - (k % 3)] / 3)));
          const bias = !args["show-covered"] && depthPull?.parts.includes(name) ? Number(args["pull-preview"] ?? depthPull.cm) / 100 : 0;
          const hang = mesh.geometry.getAttribute("uv1");
          const backWorld = hidden && depthPull?.back ? new THREE.Vector3(...depthPull.back).transformDirection(mesh.matrixWorld) : null;
          for (let k = 0; k < ids.length; k += 3) tris.push({ hideFrom: backWorld && hang.getY(ids[k]) < -0.5 ? backWorld : null, p: [at(ids[k]), at(ids[k + 1]), at(ids[k + 2])].map((p) => p.clone()), color: colors[name] ?? (args["leg-colors"] && /LegsFront$/.test(name) ? [220, 60, 60] : args["leg-colors"] && /LegsBack$/.test(name) ? [60, 200, 90] : [170, 170, 165]), bias });
        }
        sheetFrames.push({ tris });
      }
      let frameWorst = 0;
      for (const pair of pairs) {
        const pos = new Float32Array(pair.tris.length * 3);
        pair.tris.forEach((i, k) => at(i).toArray(pos, k * 3));
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const panel = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
        // outward: away from the body through this panel, along the panel's own facing as posed (a panel swung far
        // round is no longer square to the body's forward axis)
        const out = forward.clone().multiplyScalar(pair.back ? -1 : 1);
        const facing = new THREE.Vector3();
        const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
        for (let k = 0; k < pos.length; k += 9) {
          e1.set(pos[k + 3] - pos[k], pos[k + 4] - pos[k + 1], pos[k + 5] - pos[k + 2]);
          e2.set(pos[k + 6] - pos[k], pos[k + 7] - pos[k + 1], pos[k + 8] - pos[k + 2]);
          nrm.crossVectors(e1, e2);
          facing.addScaledVector(nrm, Math.sign(nrm.dot(out)) || 1);
        }
        if (facing.lengthSq() > 0) out.copy(facing.normalize());
        const inward = out.clone().negate();
        let worst = 0;
        let worstAt = 0;
        for (const i of pair.legVerts) {
          const p = at(i);
          ray.set(p, out);
          if (ray.intersectObject(panel).length) continue; // the panel is outside the leg here: covered
          ray.set(p, inward);
          const hit = ray.intersectObject(panel)[0];
          if (hit && hit.distance * toCm > worst) {
            worst = hit.distance * toCm;
            worstAt = (rest.get(i) ?? 0);
          }
        }
        geo.dispose();
        if (worst > 0.3) {
          const b = (row.byPanel[pair.panel] ??= { frames: 0, worst: 0 });
          b.frames++;
          if (worst > b.worst) b.at = worstAt;
          b.worst = Math.max(b.worst, worst);
          frameWorst = Math.max(frameWorst, worst);
        }
      }
      if (frameWorst > 0) {
        row.frames++;
        row.sum += frameWorst;
        row.worst = Math.max(row.worst, frameWorst);
      }
    }
    action?.stop();
    rows.push(row);
  }
  console.log(`\n${label}: legs out through skirt panels (cm on a 1.8 m body; ${FRAMES} frames per clip)`);
  for (const r of rows) {
    const panels = Object.entries(r.byPanel).map(([n, b]) => `${n} ${b.frames}f ${b.worst.toFixed(1)}${b.at < -0.85 ? " calf" : " thigh"}`).join(", ");
    console.log(`  ${r.clip.padEnd(18)} ${String(r.frames).padStart(2)}/${FRAMES} frames  worst ${r.worst.toFixed(1).padStart(5)}  mean ${(r.frames ? r.sum / r.frames : 0).toFixed(1).padStart(5)}  ${panels}`);
  }
  if (args.sheet && sheetFrames.length) {
    const side = forward.clone().cross(up).normalize();
    const views = [side, forward.clone(), forward.clone().negate(), side.clone().sub(forward).normalize(), side.clone().negate().sub(forward).normalize()];
    const img = renderStrip(sheetFrames, views, null, 220);
    fs.writeFileSync(String(args.sheet), encodePng(img.width, img.height, img.rgba));
  }
  return { rows };
}

await measure(glb, path.basename(file));
if (args.robe) {
  const num = (k) => (args[k] !== undefined ? Number(args[k]) : undefined);
  const { glb: fixed, report } = fitRobe(glb, { calf: num("calf"), calfFrom: num("calf-from"), middle: num("middle"), hemMarginCm: num("hem-margin"), facing: num("facing"), pullCm: num("pull") });
  for (const line of report) console.log(`  ${line}`);
  await measure(fixed, `${path.basename(file)} robe fitted`);
  if (args.write) {
    fs.writeFileSync(file, fixed);
    console.log(`\nwrote ${path.relative(process.cwd(), file)}`);
  } else console.log("\n(dry run: --write to save the GLB)");
}
