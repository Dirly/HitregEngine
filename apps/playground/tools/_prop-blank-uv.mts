/**
 * BLANK UV check: does every UV island of a prop land on PAINTED texels of the page it samples?
 *
 * Derek, 2026-10-31 ("Why are our wells not skinned?"): the strand-props re-skins installed a glTF-laid-out page as an
 * engine material map. A material map loads the TextureLoader way (flipY: row = (1 - v) * H) while the glTF's own page
 * is read row = v * H, so every island sampled its mirror row: the well's roof on the blank white half of its page, the
 * trough on the page's black padding. The files existed and every other gate passed; nobody had looked at what the
 * islands actually sample.
 *
 * Unpainted = a texel inside a FLAT patch (its 3x3 neighbourhood within `flatTol` per channel) that is clear (alpha
 * < 128), near-white (luma >= 245) or near-black (luma <= 10): an atlas's empty cells and padding. Painted art always
 * carries texel noise, so a painted white plaster or a black iron tile is not flat and passes. Flat BLACK counts only
 * where it is the page's BACKGROUND (connected to the page border): Codex packs paint whole cells flat black on purpose
 * (a jar's mouth, iron bars, a slot), and those cells sit enclosed among the others. CLEAR texels are how a
 * cut-out (web, banner fringe, leaves) draws its holes, so they count only for an island that is (almost) ALL clear: an
 * island that draws nothing at all (a banner cloth whose UVs collapse onto one transparent texel).
 *
 * Sampling follows each triangle's own convention (`TexInfo.flipY`: engine material maps true, glTF pages false) and
 * the material's repeat (wrapped, as the renderer's RepeatWrapping). World-projected materials (triplanar, splat) do
 * not use the UVs and are skipped.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { PixelPage, PropGeometry, TexInfo, Tri } from "./_prop-geometry.mts";
import { decodePng } from "./_png.mjs";

export interface BlankIsland { tex: string; area: number; share: number; kind: "white" | "black" | "clear"; uv: [number, number, number, number] }
export interface BlankUv {
  /** world m2 of UV-textured triangles judged */
  texturedArea: number;
  /** world m2 (area-weighted by sample share) landing on flat white/black texels, plus islands that are all clear */
  blankArea: number;
  share: number;
  /** islands whose samples are mostly unpainted, biggest first */
  islands: BlankIsland[];
  /** textures that could not be read (not a PNG, missing): their triangles are not judged */
  unread: string[];
}
export interface BlankUvRule { islandShare: number; islandMinArea: number; totalShare: number }
/** An island at least `islandMinArea` m2 that is `islandShare` unpainted, or `totalShare` of the prop's textured area. */
export const BLANK_UV_RULE: BlankUvRule = { islandShare: 0.5, islandMinArea: 0.01, totalShare: 0.05 };
/** An island this share clear draws nothing: a cut-out's holes never cover a whole island. */
const CLEAR_ISLAND = 0.95;

const flatTol = 3;
const lumaAt = (d: Uint8Array, i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
const darkBg = new WeakMap<PixelPage, Uint8Array>();
/** The page's flat-black BACKGROUND: opaque near-black texels 4-connected to the page border (padding, not a painted cell). */
export function blackBackground(img: PixelPage): Uint8Array {
  let m = darkBg.get(img);
  if (m) return m;
  const W = img.width, H = img.height, d = img.data;
  m = new Uint8Array(W * H);
  const dark = (p: number) => d[p * 4 + 3]! >= 128 && lumaAt(d, p * 4) <= 10;
  const stack: number[] = [];
  const push = (p: number) => { if (!m![p] && dark(p)) { m![p] = 1; stack.push(p); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (stack.length) {
    const p = stack.pop()!, x = p % W, y = (p - x) / W;
    if (x > 0) push(p - 1);
    if (x < W - 1) push(p + 1);
    if (y > 0) push(p - W);
    if (y < H - 1) push(p + W);
  }
  darkBg.set(img, m);
  return m;
}
/** "white" | "black" | "clear" when texel (x, y) is unpainted, else null. */
export function unpaintedAt(img: PixelPage, x: number, y: number): "white" | "black" | "clear" | null {
  const W = img.width, H = img.height, d = img.data, i = (y * W + x) * 4;
  const a = d[i + 3]!, luma = lumaAt(d, i);
  const kind = a < 128 ? "clear" : luma >= 245 ? "white" : luma <= 10 ? "black" : null;
  if (!kind) return null;
  if (kind === "black" && !blackBackground(img)[y * W + x]) return null;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)), j = (yy * W + xx) * 4;
    if (kind === "clear") { if (d[j + 3]! >= 128) return null; continue; }
    for (let c = 0; c < 3; c++) if (Math.abs(d[j + c]! - d[i + c]!) > flatTol) return null;
  }
  return kind;
}

const pageCache = new Map<string, PixelPage | null>();
/** A texture's RGBA8 pixels (material file or glTF-embedded PNG bytes), cached by content. */
const byBytes = new WeakMap<Buffer, string>();
export function texPixels(t: TexInfo): PixelPage | null {
  let key = t.file;
  if (!key && t.bytes) { key = byBytes.get(t.bytes); if (!key) { key = crypto.createHash("sha1").update(t.bytes).digest("hex"); byBytes.set(t.bytes, key); } }
  key ??= t.key;
  if (!pageCache.has(key)) {
    let page: PixelPage | null = null;
    try {
      const b = t.file ? fs.readFileSync(t.file) : t.bytes;
      if (b && b.length > 8 && b.readUInt32BE(0) === 0x89504e47) page = decodePng(b);
    } catch { page = null; }
    pageCache.set(key, page);
  }
  return pageCache.get(key)!;
}

const triArea = (t: Tri) => {
  const e1 = [t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]], e2 = [t.c[0] - t.a[0], t.c[1] - t.a[1], t.c[2] - t.a[2]];
  return Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2;
};

export function blankUv(geo: PropGeometry, opts: { pixels?: (t: TexInfo) => PixelPage | null; projected?: (t: Tri) => number | null } = {}): BlankUv {
  const pixels = opts.pixels ?? texPixels;
  const out: BlankUv = { texturedArea: 0, blankArea: 0, share: 0, islands: [], unread: [] };
  // islands: union-find over quantized UV vertices, per texture
  const parent: number[] = [], vid = new Map<string, number>();
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const id = (tex: string, u: number, v: number) => {
    const k = `${tex}|${Math.round(u * 8192)}|${Math.round(v * 8192)}`;
    let n = vid.get(k);
    if (n === undefined) { n = parent.length; parent.push(n); vid.set(k, n); }
    return n;
  };
  const per: { root: number; tex: string; area: number; blank: number; clear: number; kinds: Record<string, number>; uv: [number, number][] }[] = [];
  const unread = new Set<string>();
  for (const t of geo.tris) {
    if (!t.tex || !t.uv || opts.projected?.(t) != null) continue;
    const A = triArea(t);
    if (!(A > 1e-9)) continue;
    const img = pixels(t.tex);
    if (!img) { unread.add(t.tex.key); continue; }
    const [rx, ry] = t.tex.repeat;
    const uvs = t.uv.map(([u, v]) => [u * rx, v * ry] as [number, number]);
    const uvA = Math.abs((uvs[1]![0] - uvs[0]![0]) * (uvs[2]![1] - uvs[0]![1]) - (uvs[1]![1] - uvs[0]![1]) * (uvs[2]![0] - uvs[0]![0])) / 2;
    const n = Math.max(2, Math.min(12, Math.ceil(Math.sqrt(uvA * img.width * img.height * 2) / 3)));
    let samples = 0, blank = 0, clear = 0;
    const kinds: Record<string, number> = {};
    for (let i = 0; i < n; i++) for (let j = 0; i + j < n; j++) {
      const s = (i + 1 / 3) / n, r = (j + 1 / 3) / n;
      const u = uvs[0]![0] * (1 - s - r) + uvs[1]![0] * s + uvs[2]![0] * r, v = uvs[0]![1] * (1 - s - r) + uvs[1]![1] * s + uvs[2]![1] * r;
      let fu = u - Math.floor(u), fv = v - Math.floor(v);
      if (t.atlas) {
        // a town-atlas tile: the shader samples rect.xy + fract(authored uv) * rect.zw (render/town-atlas.ts)
        const a = t.atlas.uv, [x0, y0, w, h] = t.atlas.rect;
        const au = a[0]![0] * (1 - s - r) + a[1]![0] * s + a[2]![0] * r, av = a[0]![1] * (1 - s - r) + a[1]![1] * s + a[2]![1] * r;
        fu = x0 + (au - Math.floor(au)) * w; fv = y0 + (av - Math.floor(av)) * h;
      }
      const x = Math.min(img.width - 1, Math.floor(fu * img.width)), y = Math.min(img.height - 1, Math.floor((t.tex.flipY ? 1 - fv : fv) * img.height));
      samples++;
      const k = unpaintedAt(img, x, y);
      if (k === "clear") clear++;
      else if (k) blank++;
      if (k) kinds[k] = (kinds[k] ?? 0) + 1;
    }
    out.texturedArea += A;
    out.blankArea += A * (blank / samples);
    const vs = uvs.map(([u, v]) => id(t.tex!.key, u, v));
    for (const k of vs.slice(1)) { const a = find(vs[0]!), b = find(k); if (a !== b) parent[b] = a; }
    per.push({ root: vs[0]!, tex: t.tex.key, area: A, blank: A * (blank / samples), clear: A * (clear / samples), kinds, uv: uvs });
  }
  const isl = new Map<number, { tex: string; area: number; blank: number; clear: number; kinds: Record<string, number>; box: [number, number, number, number] }>();
  for (const p of per) {
    const r = find(p.root);
    const e = isl.get(r) ?? { tex: p.tex, area: 0, blank: 0, clear: 0, kinds: {}, box: [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number] };
    e.area += p.area; e.blank += p.blank; e.clear += p.clear;
    for (const [k, c] of Object.entries(p.kinds)) e.kinds[k] = (e.kinds[k] ?? 0) + c;
    for (const [u, v] of p.uv) { e.box[0] = Math.min(e.box[0], u); e.box[1] = Math.min(e.box[1], v); e.box[2] = Math.max(e.box[2], u); e.box[3] = Math.max(e.box[3], v); }
    isl.set(r, e);
  }
  for (const e of isl.values()) {
    const clear = e.area ? e.clear / e.area : 0, opaque = e.area ? e.blank / e.area : 0;
    const share = clear >= CLEAR_ISLAND ? clear : opaque;
    if (share < BLANK_UV_RULE.islandShare) continue;
    if (clear >= CLEAR_ISLAND) { out.blankArea += e.clear; e.kinds = { clear: 1 }; }
    const kind = (Object.entries(e.kinds).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "white") as BlankIsland["kind"];
    out.islands.push({ tex: e.tex, area: e.area, share, kind, uv: e.box.map((v) => +v.toFixed(3)) as [number, number, number, number] });
  }
  out.islands.sort((a, b) => b.area - a.area);
  out.share = out.texturedArea ? out.blankArea / out.texturedArea : 0;
  out.unread = [...unread];
  return out;
}

/** The fault line for `props status`, or null when every island lands on paint. */
export function blankUvFault(r: BlankUv, rule: BlankUvRule = BLANK_UV_RULE): string | null {
  const big = r.islands.filter((i) => i.area >= rule.islandMinArea);
  if (!big.length && r.share < rule.totalShare) return null;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const list = big.slice(0, 3).map((i) => `${i.area.toFixed(2)} m2 ${pct(i.share)} ${i.kind} at uv ${i.uv.join(",")} of ${i.tex}`).join("; ");
  return `blank-uv: ${pct(r.share)} of the textured area samples UNPAINTED texels (empty atlas cells / padding)${list ? ` - ${list}` : ""}. A re-skin page must keep the source page's layout AND its row convention (engine material map = flipY, glTF page = not): render it and look`;
}
