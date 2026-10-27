/**
 * Texel density of a glTF/GLB model at scale 1: per textured primitive, sqrt(UV area x texture px^2 / surface m^2) —
 * texels per metre as drawn. A scattered or placed piece at scale s draws at density / s, so a tree or rock scaled up
 * 3x shows its texture as blocks three times as coarse (Hagsheer 2026-10-21: a dead tree scaled x3.3 read as a
 * "pixel-block rock pillar" by the road). Zero dependencies; node transforms are ignored (density is scale-free per
 * node unless a node itself scales, which the kit and the nature packs do not).
 *
 *   modelTexel(file) -> { min, byPrimitive: [{ material, px: [w, h], txm }] } | null
 */
import fs from "node:fs";
import path from "node:path";

function parse(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x46546c67) {
    let offset = 12, json = null, bin = null;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
      const chunk = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
      else if (type === 0x004e4942) bin = chunk;
      offset += 8 + length;
    }
    return { json, buffers: [bin] };
  }
  const json = JSON.parse(bytes.toString("utf8"));
  const buffers = (json.buffers ?? []).map((b) =>
    b.uri?.startsWith("data:") ? Buffer.from(b.uri.split(",")[1], "base64") : b.uri ? fs.readFileSync(path.join(path.dirname(file), decodeURIComponent(b.uri))) : null,
  );
  return { json, buffers };
}

function imageSize(g, buffers, file, imageIndex) {
  const img = g.images?.[imageIndex];
  if (!img) return null;
  let b = null;
  try {
    if (img.uri?.startsWith("data:")) b = Buffer.from(img.uri.split(",")[1], "base64");
    else if (img.uri) b = fs.readFileSync(path.join(path.dirname(file), decodeURIComponent(img.uri)));
    else if (img.bufferView !== undefined) { const bv = g.bufferViews[img.bufferView]; b = buffers[bv.buffer ?? 0].subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength); }
  } catch { return null; }
  if (!b || b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null; // PNG only
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function accessor(g, buffers, i) {
  const a = g.accessors[i], bv = g.bufferViews[a.bufferView], buf = buffers[bv.buffer ?? 0];
  const n = { VEC4: 4, VEC3: 3, VEC2: 2, SCALAR: 1 }[a.type], size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
  const stride = bv.byteStride || size * n, off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const read = (o) => (a.componentType === 5126 ? buf.readFloatLE(o) : a.componentType === 5125 ? buf.readUInt32LE(o) : a.componentType === 5123 ? buf.readUInt16LE(o) : buf.readUInt8(o));
  const out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = read(off + k * stride + c * size);
  return { data: out, n, count: a.count };
}

const cache = new Map();
export function modelTexel(file) {
  if (cache.has(file)) return cache.get(file);
  let res = null;
  try {
    const { json: g, buffers } = parse(file);
    const rows = [];
    for (const mesh of g.meshes ?? [])
      for (const prim of mesh.primitives ?? []) {
        if (prim.attributes?.TEXCOORD_0 === undefined || prim.attributes?.POSITION === undefined) continue;
        const mat = g.materials?.[prim.material ?? -1];
        const texIndex = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
        const source = texIndex !== undefined ? g.textures?.[texIndex]?.source : undefined;
        const px = source !== undefined ? imageSize(g, buffers, file, source) : null;
        if (!px) continue;
        const P = accessor(g, buffers, prim.attributes.POSITION), U = accessor(g, buffers, prim.attributes.TEXCOORD_0);
        const I = prim.indices !== undefined ? accessor(g, buffers, prim.indices).data : Float64Array.from({ length: P.count }, (_, i) => i);
        let pa = 0, ua = 0;
        for (let t = 0; t + 2 < I.length; t += 3) {
          const a = I[t], b = I[t + 1], c = I[t + 2];
          const ux = P.data[b * 3] - P.data[a * 3], uy = P.data[b * 3 + 1] - P.data[a * 3 + 1], uz = P.data[b * 3 + 2] - P.data[a * 3 + 2];
          const vx = P.data[c * 3] - P.data[a * 3], vy = P.data[c * 3 + 1] - P.data[a * 3 + 1], vz = P.data[c * 3 + 2] - P.data[a * 3 + 2];
          pa += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
          ua += Math.abs((U.data[b * 2] - U.data[a * 2]) * (U.data[c * 2 + 1] - U.data[a * 2 + 1]) - (U.data[c * 2] - U.data[a * 2]) * (U.data[b * 2 + 1] - U.data[a * 2 + 1])) / 2;
        }
        if (pa > 1e-6 && ua > 1e-9) rows.push({ material: mat?.name ?? String(prim.material), px, txm: Math.sqrt((ua * px[0] * px[1]) / pa) });
      }
    if (rows.length) res = { min: Math.min(...rows.map((r) => r.txm)), byPrimitive: rows };
  } catch { res = null; }
  cache.set(file, res);
  return res;
}
