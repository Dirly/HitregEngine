/**
 * SMOOTH normals for a triangle soup (every triangle its own three vertices,
 * which is what the riggers build): three's computeVertexNormals would give
 * every face its own flat normal and a low-poly creature reads as a faceted
 * cage (Derek: "all mobs need smooth shading"). Each vertex averages the
 * area-weighted normals of every face meeting at its POSITION — so seams
 * between parts and UV islands weld too — but only faces within `creaseDeg`
 * of its own face, so the two sides of a thin fin, wing or ear (~180° apart)
 * stay separate instead of cancelling to nothing.
 *
 * Shared by legrig.mjs and autorig.mjs.
 *
 * @param {ArrayLike<number>} pos  xyz per vertex, 9 per triangle
 * @param {number} creaseDeg       faces further apart than this stay sharp
 * @returns {Float32Array}         xyz normal per vertex
 */
export function smoothNormals(pos, creaseDeg = 100) {
  const n = pos.length / 9, cos = Math.cos((creaseDeg * Math.PI) / 180);
  const face = new Float64Array(n * 3); // un-normalised: length = 2 x area
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    face[t * 3] = uy * vz - uz * vy; face[t * 3 + 1] = uz * vx - ux * vz; face[t * 3 + 2] = ux * vy - uy * vx;
  }
  const unit = (t) => { const x = face[t * 3], y = face[t * 3 + 1], z = face[t * 3 + 2], l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
  const key = (i) => `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
  const at = new Map();
  for (let i = 0; i < n * 3; i++) { const k = key(i); if (!at.has(k)) at.set(k, []); at.get(k).push(i); }
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n * 3; i++) {
    const own = unit(Math.floor(i / 3));
    let sx = 0, sy = 0, sz = 0;
    for (const j of at.get(key(i))) {
      const t = Math.floor(j / 3), u = unit(t);
      if (u[0] * own[0] + u[1] * own[1] + u[2] * own[2] >= cos) { sx += face[t * 3]; sy += face[t * 3 + 1]; sz += face[t * 3 + 2]; }
    }
    const l = Math.hypot(sx, sy, sz);
    if (l < 1e-20) { out[i * 3] = own[0]; out[i * 3 + 1] = own[1]; out[i * 3 + 2] = own[2]; }
    else { out[i * 3] = sx / l; out[i * 3 + 1] = sy / l; out[i * 3 + 2] = sz / l; }
  }
  return out;
}
