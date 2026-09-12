/**
 * A z-buffered software rasteriser, so a tool can LOOK at what it produced with
 * no browser in the room. autorig.mjs has its own copy specialised to animation
 * frames; this one takes plain triangles with UVs and is what the mesh tools
 * use to check a texture actually lands where the unwrap says it does.
 *
 * Alpha is a hard cutout (< 128 discards), matching how the engine renders a
 * masked material — a cut-out ornament has to read here the way it will there.
 */
import * as THREE from "three";

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

function viewBasis(dir) {
  const f = V3().copy(dir).normalize();
  const r = V3().crossVectors(V3(0, 1, 0), f).normalize();
  const u = V3().crossVectors(f, r);
  return { r, u, f };
}

/**
 * @param {{ tris: { p: THREE.Vector3[], uv?: number[][], color?: number[] }[] }[]} frames
 *   one column per frame; every frame shares one projection so they compare.
 * @param {THREE.Vector3[]} views one row per view direction.
 * @param {{ width: number, height: number, rgba: Uint8Array } | null} texture
 */
export function renderStrip(frames, views, texture, tile = 340, bg = 0x18) {
  const V = views.map(viewBasis);
  const width = tile * frames.length;
  const height = tile * V.length;
  const rgba = new Uint8Array(width * height * 4).fill(bg);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  const all = frames.flatMap((f) => f.tris.flatMap((t) => t.p));
  for (const [vi, view] of V.entries()) {
    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
    for (const p of all) {
      const a = p.dot(view.r);
      const b = p.dot(view.u);
      minR = Math.min(minR, a); maxR = Math.max(maxR, a);
      minU = Math.min(minU, b); maxU = Math.max(maxU, b);
    }
    const scale = (tile * 0.9) / Math.max(maxR - minR, maxU - minU, 1e-6);
    const cx = (minR + maxR) / 2;
    const cy = (minU + maxU) / 2;
    for (const [fi, frame] of frames.entries()) {
      const ox = fi * tile;
      const oy = vi * tile;
      const zbuf = new Float32Array(tile * tile).fill(Infinity);
      for (const tri of frame.tris) {
        const proj = tri.p.map((p) => ({
          x: tile / 2 + (p.dot(view.r) - cx) * scale,
          y: tile / 2 - (p.dot(view.u) - cy) * scale,
          z: p.dot(view.f),
        }));
        const [a, b, c] = proj;
        const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
        if (Math.abs(area) < 1e-9) continue;
        const n = V3()
          .crossVectors(V3().subVectors(tri.p[1], tri.p[0]), V3().subVectors(tri.p[2], tri.p[0]))
          .normalize();
        // Two-sided lambert with a generous floor: this is a diagnostic, and a
        // dark face in shadow hides exactly what we came to look at.
        const lam = 1.35 * (0.45 + 0.55 * Math.abs(n.dot(V3(0.4, 0.75, 0.5).normalize())));
        const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
        const x1 = Math.min(tile - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
        const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
        const y1 = Math.min(tile - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5;
            const py = y + 0.5;
            const w0 = ((b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)) / area;
            const w1 = ((px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w2 * a.z + w1 * b.z + w0 * c.z;
            const at = y * tile + x;
            if (z >= zbuf[at]) continue;
            let col = tri.color ?? [190, 190, 190];
            if (texture && tri.uv) {
              const u = w2 * tri.uv[0][0] + w1 * tri.uv[1][0] + w0 * tri.uv[2][0];
              const v = w2 * tri.uv[0][1] + w1 * tri.uv[1][1] + w0 * tri.uv[2][1];
              const tx = Math.min(texture.width - 1, Math.max(0, Math.floor(u * texture.width)));
              const ty = Math.min(texture.height - 1, Math.max(0, Math.floor(v * texture.height)));
              const o = (ty * texture.width + tx) * 4;
              if (texture.rgba[o + 3] < 128) continue; // masked material, hard cutout
              col = [texture.rgba[o], texture.rgba[o + 1], texture.rgba[o + 2]];
            }
            zbuf[at] = z;
            const out = ((oy + y) * width + ox + x) * 4;
            for (let k = 0; k < 3; k++) rgba[out + k] = Math.min(255, col[k] * lam);
          }
      }
    }
  }
  return { width, height, rgba };
}
