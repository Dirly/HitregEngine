/**
 * The import gates of `armor import`, as numbers (docs/armor-sets.md → Making a set, step 4):
 *   - bodyHoles: transparent texels INSIDE the body's real UV triangles, per part. Only the robe and tasset hems and
 *     the back ornament may cut; a hole anywhere else is a hole through the character.
 *   - freeEdges: opaque texels on the free edges of every cut-out square (ornaments, fringe planes): paint touching
 *     an edge is a hard straight line on the model.
 *   - density: texels per metre of a sheet on its model (the house standard is 109, nearest).
 *   - femaleChest: the woman's sheet = the man's atlas with ONLY the chest-front island (+3 texel gutter) taken from
 *     her import.
 */
import type { Glb } from "./glb.mts";

export interface Img { width: number; height: number; data: Uint8Array }
const hexRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Atlas-resolution mask of key regions (any key pixel of those colours marks its texel), optionally dilated. */
export function keyMask(key: Img, hexes: string[], S: number, dilate = 0): Uint8Array {
  const cols = hexes.map(hexRgb);
  const m = new Uint8Array(S * S);
  for (let y = 0; y < key.height; y++)
    for (let x = 0; x < key.width; x++) {
      const o = (y * key.width + x) * 4;
      if (cols.some(([r, g, b]) => key.data[o] === r && key.data[o + 1] === g && key.data[o + 2] === b))
        m[Math.floor((y * S) / key.height) * S + Math.floor((x * S) / key.width)] = 1;
    }
  for (let r = 0; r < dilate; r++) {
    const c = m.slice();
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++)
        if (c[y * S + x])
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const X = x + dx, Y = y + dy;
            if (X >= 0 && Y >= 0 && X < S && Y < S) m[Y * S + X] = 1;
          }
  }
  return m;
}

/** The woman's atlas: his texels everywhere except the chest-front island (+3 gutter), which is hers. */
export function femaleChest(male: Img, femaleFull: Img, key: Img, chestHex = "#ff0000", gutter = 3): { img: Img; texels: number } {
  if (male.width !== femaleFull.width || male.height !== femaleFull.height) throw new Error("femaleChest: the two atlases differ in size");
  const S = male.width;
  const mask = keyMask(key, [chestHex], S, gutter);
  const data = male.data.slice();
  let texels = 0;
  for (let i = 0; i < S * S; i++)
    if (mask[i]) {
      data.set(femaleFull.data.subarray(i * 4, i * 4 + 4), i * 4);
      texels++;
    }
  return { img: { width: S, height: S, data }, texels };
}

/** Texel centres covered by a UV triangle on an S x S sheet. */
function rasterUv(uv: number[][], S: number, visit: (x: number, y: number) => void): void {
  const P = uv.map(([u, v]) => [u! * S, v! * S]);
  const [a, b, c] = P as [number[], number[], number[]];
  const den = (b[1]! - c[1]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[1]! - c[1]!);
  if (Math.abs(den) < 1e-9) return;
  const x0 = Math.max(0, Math.floor(Math.min(a[0]!, b[0]!, c[0]!))), x1 = Math.min(S - 1, Math.ceil(Math.max(a[0]!, b[0]!, c[0]!)));
  const y0 = Math.max(0, Math.floor(Math.min(a[1]!, b[1]!, c[1]!))), y1 = Math.min(S - 1, Math.ceil(Math.max(a[1]!, b[1]!, c[1]!)));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l1 = ((b[1]! - c[1]!) * (px - c[0]!) + (c[0]! - b[0]!) * (py - c[1]!)) / den;
      const l2 = ((c[1]! - a[1]!) * (px - c[0]!) + (a[0]! - c[0]!) * (py - c[1]!)) / den;
      if (l1 >= 0 && l2 >= 0 && 1 - l1 - l2 >= 0) visit(x, y);
    }
}

/** Parts of the body whose sheet may be cut (hems, the robe gap, the back ornament). */
export const BODY_CUT_PARTS = new Set(["RobesFront", "RobesBack", "TassetFront", "TassetBack", "ChestHalo", "F_RobesFront", "F_RobesBack", "F_TassetFront", "F_TassetBack", "F_ChestHalo"]);

/** Transparent texels (alpha < 128) inside each non-cut part's UV triangles. */
export function bodyHoles(atlas: Img, glb: Glb, cutParts = BODY_CUT_PARTS): { part: string; texels: number; holes: number }[] {
  const S = atlas.width;
  const names = Object.fromEntries(Object.entries(glb.parts).map(([n, i]) => [i, n]));
  const seen = new Map<string, Set<number>>();
  for (const t of glb.tris) {
    const name = names[t.part];
    if (!name || cutParts.has(name)) continue;
    const s = seen.get(name) ?? new Set<number>();
    seen.set(name, s);
    rasterUv(t.uv, S, (x, y) => s.add(y * S + x));
  }
  return [...seen].map(([part, s]) => {
    let holes = 0;
    for (const i of s) if (atlas.data[i * 4 + 3]! < 128) holes++;
    return { part, texels: s.size, holes };
  });
}

export interface SlotSpec { name: string; cut?: boolean | string; anchor?: string }
/**
 * Opaque texels on the free edges of every fully cut-out slot (`cut: true`): the island's boundary texels, minus
 * its base band when it is anchored at the bottom (an ornament stands on its bottom edge).
 */
export function freeEdges(atlas: Img, key: Img, slots: Record<string, SlotSpec>, baseBand = 0.2): { slot: string; edge: number; opaque: number }[] {
  const S = atlas.width;
  const out: { slot: string; edge: number; opaque: number }[] = [];
  for (const [hex, spec] of Object.entries(slots)) {
    if (spec.cut !== true) continue;
    const m = keyMask(key, [hex], S);
    let y0 = S, y1 = -1;
    for (let i = 0; i < S * S; i++) if (m[i]) { const y = Math.floor(i / S); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (y1 < 0) continue;
    const cutoff = spec.anchor === "bottom" ? y1 - Math.max(1, Math.floor((y1 - y0 + 1) * baseBand)) : S;
    let edge = 0, opaque = 0;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        if (!m[y * S + x] || y > cutoff) continue;
        const border = x === 0 || y === 0 || x === S - 1 || y === S - 1 || !m[y * S + x - 1] || !m[y * S + x + 1] || !m[(y - 1) * S + x] || !m[(y + 1) * S + x];
        if (!border) continue;
        edge++;
        if (atlas.data[(y * S + x) * 4 + 3]! >= 128) opaque++;
      }
    out.push({ slot: spec.name, edge, opaque });
  }
  return out;
}

/** Area-weighted texels per metre of a sheet of S texels on the model (positions scaled by metresPerUnit). */
export function density(glb: Glb, S: number, metresPerUnit: number, onlyParts?: Set<number>): number {
  let uvA = 0, wA = 0;
  for (const t of glb.tris) {
    if (onlyParts && !onlyParts.has(t.part)) continue;
    const [a, b, c] = t.uv as [number[], number[], number[]];
    const ua = Math.abs((b[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (b[1]! - a[1]!)) / 2;
    const [p, q, r] = t.p as [number[], number[], number[]];
    const u = [q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!], v = [r[0]! - p[0]!, r[1]! - p[1]!, r[2]! - p[2]!];
    const wa = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    if (ua < 1e-12 || wa < 1e-12) continue;
    uvA += ua * S * S;
    wA += wa * metresPerUnit * metresPerUnit;
  }
  return wA ? Math.sqrt(uvA / wA) : 0;
}
