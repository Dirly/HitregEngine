#!/usr/bin/env node
/**
 * smooth-glb — give an already-built GLB smooth shading, in place: every
 * vertex's NORMAL becomes the area-weighted average of the faces meeting at
 * its position that lie within --crease degrees (default 100) of its own
 * current normal. Thin fins/wings/ears (two sides ~180° apart) stay two-sided.
 *
 *   node tools/smooth-glb.mjs <file.glb> [more.glb ...] [--crease 100]
 *
 * Surgical: only the NORMAL accessors' bytes are rewritten (same size, same
 * place), so skins, clips, extras and textures are untouched. For models no
 * rigger here builds (reskin's human-rig mobs, imported rigs). The riggers
 * themselves smooth with the same rule (tools/_normals.mjs).
 */
import fs from "node:fs";
const args = process.argv.slice(2);
const ci = args.indexOf("--crease");
const crease = ci >= 0 ? Number(args.splice(ci, 2)[1]) : 100;
const cos = Math.cos((crease * Math.PI) / 180);
for (const f of args) {
  const b = fs.readFileSync(f);
  const jl = b.readUInt32LE(12), j = JSON.parse(b.subarray(20, 20 + jl).toString()), bs = 20 + jl + 8;
  const view = (ai, n) => {
    const a = j.accessors[ai], v = j.bufferViews[a.bufferView];
    if (a.componentType !== 5126 || (v.byteStride && v.byteStride !== n * 4)) return null;
    return new Float32Array(b.buffer, b.byteOffset + bs + (v.byteOffset || 0) + (a.byteOffset || 0), a.count * n);
  };
  const idx = (ai, count) => {
    if (ai === undefined) return Uint32Array.from({ length: count }, (_, i) => i);
    const a = j.accessors[ai], v = j.bufferViews[a.bufferView];
    const T = a.componentType === 5125 ? Uint32Array : a.componentType === 5123 ? Uint16Array : Uint8Array;
    return new T(b.buffer.slice(b.byteOffset + bs + (v.byteOffset || 0) + (a.byteOffset || 0), b.byteOffset + bs + (v.byteOffset || 0) + (a.byteOffset || 0) + a.count * T.BYTES_PER_ELEMENT));
  };
  let changed = 0, prims = 0;
  for (const m of j.meshes) for (const p of m.primitives) {
    if (p.attributes.NORMAL === undefined || (p.mode ?? 4) !== 4) continue;
    const P = view(p.attributes.POSITION, 3), N = view(p.attributes.NORMAL, 3);
    if (!P || !N) continue;
    const n = P.length / 3, I = idx(p.indices, n);
    const faces = [], at = new Map();
    const key = (i) => `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;
    for (let t = 0; t < I.length; t += 3) {
      const [a, c, d] = [I[t], I[t + 1], I[t + 2]];
      const ux = P[c * 3] - P[a * 3], uy = P[c * 3 + 1] - P[a * 3 + 1], uz = P[c * 3 + 2] - P[a * 3 + 2];
      const vx = P[d * 3] - P[a * 3], vy = P[d * 3 + 1] - P[a * 3 + 1], vz = P[d * 3 + 2] - P[a * 3 + 2];
      const fn = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      faces.push(fn);
      for (const i of [a, c, d]) { const k = key(i); if (!at.has(k)) at.set(k, new Set()); at.get(k).add(faces.length - 1); }
    }
    const out = new Float32Array(N.length);
    for (let i = 0; i < n; i++) {
      const own = [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
      let sx = 0, sy = 0, sz = 0;
      for (const fi of at.get(key(i)) ?? []) {
        const fn = faces[fi], l = Math.hypot(...fn) || 1;
        if ((fn[0] * own[0] + fn[1] * own[1] + fn[2] * own[2]) / l >= cos) { sx += fn[0]; sy += fn[1]; sz += fn[2]; }
      }
      const l = Math.hypot(sx, sy, sz);
      if (l < 1e-20) { out.set(own, i * 3); continue; }
      out[i * 3] = sx / l; out[i * 3 + 1] = sy / l; out[i * 3 + 2] = sz / l;
      if (Math.abs(out[i * 3] - own[0]) + Math.abs(out[i * 3 + 1] - own[1]) + Math.abs(out[i * 3 + 2] - own[2]) > 1e-3) changed++;
    }
    N.set(out); prims++;
  }
  fs.writeFileSync(f, b);
  console.log(`${f}: ${prims} primitive(s), ${changed} normals smoothed (crease ${crease}°)`);
}
