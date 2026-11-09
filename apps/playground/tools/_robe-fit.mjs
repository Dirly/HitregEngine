/**
 * Fit a human body's robe for running (shared by skirt-fit; run it after reskin rebuilds a body). Every human body
 * model is the same mesh (outfits are textures), so one fit serves every outfit; nothing here moves a vertex or
 * touches a UV.
 *
 * The robe back hangs ~1 cm off the backs of the legs, and a run kicks the heel nearly to the hip: the thigh and calf
 * came out through it every stride (Derek 2026-11-08). Two changes:
 *
 * - COVERS: the leg triangles above the robe's hem that face backward (normal . back > `facing`) AND that no
 *   front-side view can see (the standing body, robe on, rastered from 14 directions: straight on, 25-75° to either
 *   side, level and from above: the camera never looks up under the hips) are left out of the draw while the robe back shows (the model's `covers` extras:
 *   `{ RobesBack: [triangles] }`, honoured by @hitreg/render applyModelPartMask). Those are never seen from the
 *   front (the leg's front is in the way, the robe hangs right behind them) and are what pokes out of the back in a
 *   run. Inner thighs, sides and fronts stay: hiding the whole back of the legs left holes visible through the open
 *   front, even standing (Derek). Those the front DOES see, and every inner-thigh triangle between the hip joints, get uv1.y = -1
 *   instead (the hang-weight channel, which only reads > 0) and hide only while the camera is behind the hips
 *   (`depthPull.back`): from behind the robe is over them, so all they can do there is poke through. A new part could not carry this: the body uses all 32 part bits.
 * - CALF: from `calfFrom` of the way down to the knee, the robe hands over to its own side's calf, all of it just
 *   below the knee (left side the left calf, right the right, blended across the middle), so the hem rides up with a
 *   kicking heel and covers the shin, the way an MMO robe does with the run unchanged. The weights are a function of
 *   position only and are written to the back panel AND the front flaps alike, so points the panels share stay
 *   welded (moving only the back opened its side seams).
 *
 * Tried and rejected the same day: a bone per panel swung by a solver (too rigid), copying the leg surface's weights
 * (creased into the knee), a subdivided robe, pushing the back panel off the legs (opened the seams, still poked).
 * Reads the robe as reskin wrote it; a fitted body is refused (extras `robeFit`).
 */
import * as THREE from "three";

export const ROBE_FIT_DEFAULTS = { calf: 1, calfFrom: 0.75, middle: 0.8, hemMarginCm: 2, facing: 0, pullCm: 3 };

/**
 * Triangle ids (vertex index / 3) seen in a z-buffered orthographic raster of `tris` from `dir` (looking along it).
 * `tris`: [{ id, p: [a, b, c] }]. Everything in `tris` occludes; only ids that win a pixel are returned.
 */
function seenFrom(tris, dir, size = 640) {
  const f = dir.clone().normalize();
  const r = new THREE.Vector3().crossVectors(Math.abs(f.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), f).normalize();
  const u = new THREE.Vector3().crossVectors(f, r);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const proj = tris.map((t) => t.p.map((p) => { const x = p.dot(r), y = p.dot(u); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); return [x, y, p.dot(f)]; }));
  const scale = (size - 2) / Math.max(x1 - x0, y1 - y0);
  const z = new Float32Array(size * size).fill(Infinity);
  const id = new Int32Array(size * size).fill(-1);
  proj.forEach((pp, k) => {
    const q = pp.map(([x, y, d]) => [(x - x0) * scale + 1, (y - y0) * scale + 1, d]);
    const [a, b, c] = q;
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-12) return;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
      const w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const d = w0 * a[2] + w1 * b[2] + w2 * c[2];
      const i = y * size + x;
      if (d < z[i]) { z[i] = d; id[i] = tris[k].id; }
    }
  });
  return new Set(id);
}

/** The covering robe part and the leg part it covers, per sex. */
const COVERS = [
  ["RobesBack", ["Human_LegsBack", "Human_LegsFront"]],
  ["F_RobesBack", ["HumanFemale_LegsBack", "HumanFemale_LegsFront"]],
];
/** Every robe part that takes the calf weights. */
const ROBE_PARTS = /Robes(Front|Back)$/;

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const SIZES = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** @returns {{ glb: Buffer, report: string[] }} */
export function fitRobe(glb, options = {}) {
  const o = { ...ROBE_FIT_DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
  const binStart = 20 + jsonLen + 8;
  const out = Buffer.from(glb);
  const viewOf = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const n = COMPONENTS[a.type];
    const size = SIZES[a.componentType];
    return { a, n, size, base: binStart + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), stride: v.byteStride ?? n * size };
  };
  const get = (V, e, c) => {
    const at = V.base + e * V.stride + c * V.size;
    return V.a.componentType === 5126 ? out.readFloatLE(at) : V.size === 2 ? out.readUInt16LE(at) : V.size === 1 ? out.readUInt8(at) : out.readUInt32LE(at);
  };

  const meshNode = json.nodes.find((n) => n.mesh !== undefined && n.skin !== undefined);
  if (!meshNode) throw new Error("no skinned mesh");
  if (meshNode.extras?.robeFit) throw new Error(`already fitted (${JSON.stringify(meshNode.extras.robeFit)}): run on reskin's output`);
  const skin = json.skins[meshNode.skin];
  const prim = json.meshes[meshNode.mesh].primitives[0];
  if (prim.indices !== undefined) throw new Error("expects a non-indexed primitive (reskin's ubermesh)");
  const at = prim.attributes;
  const ids = meshNode.extras?.parts;
  if (!ids) throw new Error("no `parts` table on the mesh node");
  const names = Object.fromEntries(Object.entries(ids).map(([n, i]) => [i, n]));
  const P = viewOf(at.POSITION);
  const N = viewOf(at.NORMAL);
  const U = viewOf(at.TEXCOORD_1);
  const J = viewOf(at.JOINTS_0);
  const W = viewOf(at.WEIGHTS_0);
  if (J.a.componentType !== 5123 || W.a.componentType !== 5126) throw new Error("expects ushort joints and float weights");
  const count = P.a.count;
  const pos = (v) => new THREE.Vector3(get(P, v, 0), get(P, v, 1), get(P, v, 2));
  const partOf = (v) => Math.round(get(U, v, 0));

  // the body's frame at bind, geometry space
  const ibm = viewOf(skin.inverseBindMatrices);
  const jointOf = (name) => {
    const k = skin.joints.findIndex((j) => json.nodes[j].name === name);
    if (k < 0) throw new Error(`the skin has no joint "${name}"`);
    return k;
  };
  const originOf = (name) =>
    new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(Array.from({ length: 16 }, (_, i) => get(ibm, jointOf(name), i))).invert());
  const lHip = originOf("CC_Base_L_Thigh");
  const rHip = originOf("CC_Base_R_Thigh");
  const hips = lHip.clone().add(rHip).multiplyScalar(0.5);
  const knees = originOf("CC_Base_L_Calf").add(originOf("CC_Base_R_Calf")).multiplyScalar(0.5);
  const legLength = knees.distanceTo(hips);
  const down = knees.clone().sub(hips).normalize();
  const left = lHip.clone().sub(rHip);
  const band = (left.length() / 2) * o.middle;
  left.addScaledVector(down, -left.dot(down)).normalize();
  const ankles = originOf("CC_Base_L_Foot").add(originOf("CC_Base_R_Foot")).multiplyScalar(0.5);
  const perCm = ankles.distanceTo(hips) / 84; // hip to ankle ~84 cm on a 1.8 m body
  const [lCalf, rCalf] = ["CC_Base_L_Calf", "CC_Base_R_Calf"].map(jointOf);
  const heightOf = (p) => p.clone().sub(hips).dot(down);
  // straight back, from the toes (in front of the ankles)
  const forward = new THREE.Vector3().crossVectors(down, left).normalize();
  if (originOf("CC_Base_L_ToeBase").sub(originOf("CC_Base_L_Foot")).dot(forward) < 0) forward.negate();
  const facingBack = (t) => {
    const n = new THREE.Vector3();
    for (let v = t; v < t + 3; v++) n.add(new THREE.Vector3(get(N, v, 0), get(N, v, 1), get(N, v, 2)));
    return n.normalize().dot(forward) < -o.facing;
  };

  const report = [];
  // what the front can see: the body as worn with the robe (no tassets), from the front half all round
  const allTris = [];
  const wornParts = new Set(Object.keys(ids).filter((n) => !/Tasset|ChestHalo|Buckle/.test(n)).map((n) => ids[n]));
  for (let t = 0; t + 2 < count; t += 3) if (wornParts.has(partOf(t))) allTris.push({ id: t / 3, female: /^(F_|HumanFemale_)/.test(names[partOf(t)]), p: [pos(t), pos(t + 1), pos(t + 2)] });
  const seen = new Set();
  const upAxis = down.clone().negate();
  for (const female of [false, true]) {
    const body = allTris.filter((t) => t.female === female);
    for (const yaw of [-75, -50, -25, 0, 25, 50, 75]) for (const pitch of [0, 25]) {
      // a camera in front looking back at the body: the view direction runs from the front toward the back
      const dir = forward.clone().negate().applyAxisAngle(upAxis, (yaw * Math.PI) / 180);
      const side = new THREE.Vector3().crossVectors(dir, upAxis).normalize();
      dir.applyAxisAngle(side, (pitch * Math.PI) / 180);
      for (const i of seenFrom(body, dir)) seen.add(i);
    }
  }
  // COVERS: leg triangles wholly above the robe back's hem, facing back, never seen from the front
  const covers = {};
  const innerHalf = lHip.distanceTo(rHip) / 2;
  for (const [robe, legs] of COVERS) {
    if (ids[robe] === undefined) continue;
    const legIds = new Set(legs.map((l) => ids[l]).filter((i) => i !== undefined));
    let hem = -Infinity;
    for (let v = 0; v < count; v++) if (partOf(v) === ids[robe]) hem = Math.max(hem, heightOf(pos(v)));
    const limit = hem - o.hemMarginCm * perCm;
    const triangles = [];
    let behind = 0;
    for (let t = 0; t + 2 < count; t += 3) {
      if (!legIds.has(partOf(t))) continue;
      if (![t, t + 1, t + 2].every((v) => heightOf(pos(v)) < limit)) continue;
      // between the hip joints: the inner thighs, front or back, which a run swings through the robe's middle
      const inner = [t, t + 1, t + 2].every((v) => Math.abs(pos(v).sub(hips).dot(left)) < innerHalf);
      if (!facingBack(t) && !inner) continue;
      if (facingBack(t) && !seen.has(t / 3)) triangles.push(t / 3);
      else {
        // seen from the front (the inner thighs, through the open robe): hidden only while the camera is behind
        for (let v = t; v < t + 3; v++) out.writeFloatLE(-1, U.base + v * U.stride + 4);
        behind++;
      }
    }
    covers[robe] = triangles;
    report.push(`${robe} covers ${triangles.length} leg triangles above its hem that face back and no front view sees; ${behind} more (seen from the front) only while the camera is behind`);
  }

  // CALF: the robe's lower part onto its own side's calf (back panel and front flaps alike)
  let weighted = 0;
  for (let v = 0; v < count; v++) {
    if (!ROBE_PARTS.test(names[partOf(v)] ?? "")) continue;
    const p = pos(v);
    const k = o.calf * smooth(o.calfFrom, 1.1, heightOf(p) / legLength);
    if (k <= 0) continue;
    const toLeft = smooth(-band, band, p.clone().sub(hips).dot(left));
    const mix = new Map();
    for (let c = 0; c < 4; c++) {
      const w = get(W, v, c);
      if (w > 0) mix.set(get(J, v, c), (mix.get(get(J, v, c)) ?? 0) + w * (1 - k));
    }
    mix.set(lCalf, (mix.get(lCalf) ?? 0) + k * toLeft);
    mix.set(rCalf, (mix.get(rCalf) ?? 0) + k * (1 - toLeft));
    const kept = [...mix].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = kept.reduce((s, [, w]) => s + w, 0);
    while (kept.length < 4) kept.push([0, 0]);
    for (let c = 0; c < 4; c++) {
      out.writeUInt16LE(kept[c][0], J.base + v * J.stride + c * 2);
      out.writeFloatLE(kept[c][1] / (sum || 1), W.base + v * W.stride + c * 4);
    }
    weighted++;
  }
  report.push(`${weighted} robe vertices onto the calves below ${o.calfFrom} of the thigh`);

  // DEPTH PULL: the robe drawn as if pullCm nearer the camera (@hitreg/render applyModelDepthPull), so a leg that
  // the welded sheet averages a little way through stays behind it
  const depthPull = {
    parts: Object.keys(ids).filter((n) => ROBE_PARTS.test(n)),
    cm: o.pullCm,
    // geometry space: uv1.y = -1 triangles hide while the camera is on this side of the hips (and a robe back shows)
    back: forward.clone().negate().toArray().map((x) => +x.toFixed(5)),
    origin: hips.toArray().map((x) => +x.toFixed(5)),
  };
  report.push(`robe parts drawn ${o.pullCm} cm nearer the camera: ${depthPull.parts.join(", ")}`);
  meshNode.extras = { ...meshNode.extras, covers, depthPull, robeFit: { calf: o.calf, calfFrom: o.calfFrom, middle: o.middle, hemMarginCm: o.hemMarginCm, facing: o.facing, pullCm: o.pullCm } };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const bin = out.subarray(binStart);
  const h = Buffer.alloc(12);
  h.writeUInt32LE(0x46546c67, 0);
  h.writeUInt32LE(2, 4);
  h.writeUInt32LE(28 + js.length + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(js.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return { glb: Buffer.concat([h, jh, js, bh, bin]), report };
}
