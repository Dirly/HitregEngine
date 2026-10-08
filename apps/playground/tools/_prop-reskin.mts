/**
 * Reskin one prop of an atlas KIT (a catalog collection whose rows record `tile: [u, v, scale]` on one shared
 * square page, e.g. the interior kit) so that it reaches the project's texel density, keeping the kit ONE page and
 * ONE material (every repeat still instances). Used by `props reskin`; the routes come from `props reskin-plan`:
 *
 *   a  re-pack: the prop's own source art, resampled to the size its UV layout needs (the source was downscaled)
 *   b  detail: the prop's own colours, modulated by a town material role's tile projected onto it in metres
 *   c  new art: a generated picture laid on the prop's single UV island, sized to the island's world extent
 *
 * The page is enlarged by a whole factor (nearest) only when a slot is too small for the new art: every other
 * tile keeps its normalized place and its pixels (blown up, which `texelDensity` counts at their real detail),
 * so no other prop's model changes. Backups (`.bak-2026-10-01`) are written beside the page and the model once.
 */
import fs from "node:fs";
import type { Tri, V3, PixelPage } from "./_prop-geometry.mts";

export const BAK = ".bak-2026-10-01";
export interface Role { page: PixelPage; rect: number[]; metres: number; /** only texels of this colour family take the detail (a bed's linen keeps its own) */ mask?: "wood" | "grey" }
export interface ReskinJob {
  route: "a" | "b" | "c";
  /** kit page PNG (absolute), and the kit's atlas record (size, tile, gutter) */
  pageFile: string;
  atlas: { size: number[]; tile: number; gutter: number };
  /** the prop's kit row tile [u, v, scale] (normalized, v measured from the top row) */
  tile: number[];
  /** the prop's model (absolute) and its triangles in metres with page UVs (props geometry) */
  modelFile: string;
  tris: Tri[];
  /** content size in texels the target asks for (a, b); target texels/m (c) */
  need: number;
  target: number;
  /** a: the source art; b: source art (colours) + the role; c: the generated art */
  source?: PixelPage;
  role?: Role;
  art?: PixelPage;
  encode: (w: number, h: number, rgba: Uint8Array) => Uint8Array;
  decode: (b: Buffer) => PixelPage;
}
export interface ReskinResult { page: { before: number; after: number; enlarged: number }; content: [number, number]; tile: number[]; slot: number; backups: string[] }

const backup = (file: string, out: string[]) => { const b = file + BAK; if (!fs.existsSync(b)) { fs.copyFileSync(file, b); out.push(b); } };
export function resample(src: PixelPage, w: number, h: number, rotate = false): PixelPage {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // rotate: the source's vertical runs along the output's horizontal
    const fx = rotate ? (h - 1 - y + 0.5) / h : (x + 0.5) / w, fy = rotate ? (x + 0.5) / w : (y + 0.5) / h;
    const sx = Math.min(src.width - 1, Math.floor(fx * src.width)), sy = Math.min(src.height - 1, Math.floor(fy * src.height));
    out.set(src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * w + x) * 4);
    out[(y * w + x) * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}
function enlarge(p: PixelPage, k: number): PixelPage {
  const W = p.width * k, H = p.height * k, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.set(p.data.subarray(((Math.floor(y / k)) * p.width + Math.floor(x / k)) * 4, ((Math.floor(y / k)) * p.width + Math.floor(x / k)) * 4 + 4), (y * W + x) * 4);
  return { width: W, height: H, data: out };
}

/** Rewrite TEXCOORD_0 of every primitive in a GLB in place (min/max kept true). */
export function remapGlbUvs(file: string, fn: (u: number, v: number) => [number, number]): Buffer {
  const b = Buffer.from(fs.readFileSync(file));
  let o = 12, json: any = null, jsonAt = 0, jsonLen = 0, binAt = 0;
  while (o + 8 <= b.length) {
    const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4);
    if (type === 0x4e4f534a) { json = JSON.parse(b.subarray(o + 8, o + 8 + len).toString("utf8")); jsonAt = o; jsonLen = len; }
    else if (type === 0x004e4942) binAt = o + 8;
    o += 8 + len + ((4 - (len % 4)) % 4);
  }
  const done = new Set<number>();
  for (const m of json.meshes) for (const p of m.primitives) {
    const ai = p.attributes.TEXCOORD_0;
    if (ai == null || done.has(ai)) continue;
    done.add(ai);
    const a = json.accessors[ai], v = json.bufferViews[a.bufferView];
    if (a.componentType !== 5126 || v.buffer !== 0) throw Error(`${file}: TEXCOORD_0 is not float in the GLB buffer`);
    const stride = v.byteStride ?? 8, base = binAt + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
    for (let k = 0; k < a.count; k++) {
      const at = base + k * stride, [u, w] = fn(b.readFloatLE(at), b.readFloatLE(at + 4));
      b.writeFloatLE(u, at); b.writeFloatLE(w, at + 4);
      const ru = b.readFloatLE(at), rv = b.readFloatLE(at + 4);
      mn[0] = Math.min(mn[0], ru); mn[1] = Math.min(mn[1], rv); mx[0] = Math.max(mx[0], ru); mx[1] = Math.max(mx[1], rv);
    }
    if (a.min) a.min = mn;
    if (a.max) a.max = mx;
  }
  // rewrite the JSON chunk (padded with spaces to the same 4-byte rule)
  let text = JSON.stringify(json);
  while ((Buffer.byteLength(text) % 4) !== 0) text += " ";
  const jbuf = Buffer.from(text, "utf8");
  const head = b.subarray(0, jsonAt), tail = b.subarray(jsonAt + 8 + jsonLen + ((4 - (jsonLen % 4)) % 4));
  const chunkHead = Buffer.alloc(8); chunkHead.writeUInt32LE(jbuf.length, 0); chunkHead.writeUInt32LE(0x4e4f534a, 4);
  const out = Buffer.concat([head, chunkHead, jbuf, tail]);
  out.writeUInt32LE(out.length, 8);
  return out;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function reskin(job: ReskinJob): ReskinResult {
  const backups: string[] = [];
  let page = job.decode(fs.readFileSync(job.pageFile));
  const before = page.width;
  if (page.width !== job.atlas.size[0]) throw Error(`page is ${page.width}px but the kit records ${job.atlas.size[0]}`);
  const [t0, t1, ts] = job.tile;
  // local tile coords of a page UV (0..1 across the prop's old tile; y down)
  const local = (u: number, v: number): [number, number] => [(u - t0) / ts, (1 - v - t1) / ts];

  // content size
  let cw = job.need, ch = job.need, rotate = false, island: number[] | null = null;
  if (job.route === "a") {
    const src = job.source!.width;
    cw = ch = Math.abs(src - job.need) / src <= 0.05 ? src : Math.min(src, job.need);
  }
  if (job.route === "c") ({ cw, ch, rotate, island } = islandFit(job.tris, local, job.target, job.art!));
  const need = Math.max(cw, ch);
  // enlarge the page by a whole factor when the slot is too small (keeps every other tile's place and pixels)
  const slot0 = Math.round(ts * page.width);
  const k = need <= slot0 ? 1 : Math.ceil(need / slot0);
  if (k > 2) throw Error(`needs ${need}px in a ${slot0}px slot: more than a 2x page; give the kit generator per-prop tile sizes instead`);
  if (k > 1) page = enlarge(page, k);
  const W = page.width, slot = Math.round(ts * W), gut = Math.round(job.atlas.gutter * (W / job.atlas.size[0])), ox = Math.round(t0 * W), oy = Math.round(t1 * W);

  // build the content
  let content: PixelPage;
  if (job.route === "a") content = resample(job.source!, cw, ch);
  else if (job.route === "c") content = resample(job.art!, cw, ch, rotate);
  else { content = resample(job.source!, cw, ch); roleOverlay(content, job.tris, local, job.role!); }
  // write it at the slot's corner; the rest of the slot and its gutter clamp to the content's edge
  for (let y = -gut; y < slot + gut; y++) for (let x = -gut; x < slot + gut; x++) {
    const sx = Math.min(cw - 1, Math.max(0, x)), sy = Math.min(ch - 1, Math.max(0, y));
    page.data.set(content.data.subarray((sy * cw + sx) * 4, (sy * cw + sx) * 4 + 4), ((oy + y) * W + ox + x) * 4);
  }
  backup(job.pageFile, backups);
  fs.writeFileSync(job.pageFile, Buffer.from(job.encode(W, W, page.data)));
  // the prop's UVs: its old tile -> the content rectangle (route c: the island's bounds -> the whole content)
  backup(job.modelFile, backups);
  const glb = remapGlbUvs(job.modelFile, (u, v) => {
    let [x, y] = local(u, v);
    if (island) { x = (x - island[0]) / (island[2] - island[0]); y = (y - island[1]) / (island[3] - island[1]); }
    return [(ox + x * cw) / W, 1 - (oy + y * ch) / W];
  });
  fs.writeFileSync(job.modelFile, glb);
  return { page: { before, after: W, enlarged: k }, content: [cw, ch], tile: [+(ox / W).toFixed(6), +(oy / W).toFixed(6), +(need / W).toFixed(6)], slot, backups };
}

type Local = (u: number, v: number) => [number, number];
/**
 * Route c: one UV island laid out at the target density. Its local bounds, and the metres along each UV axis
 * (dP/du, dP/dv per triangle, area-weighted) give the content size; the art turns so its long axis follows the island's.
 */
export function islandFit(tris: Tri[], local: Local, target: number, art: PixelPage): { cw: number; ch: number; rotate: boolean; island: number[] } {
  const island = [Infinity, Infinity, -Infinity, -Infinity];
  let du = 0, dv = 0, wsum = 0;
  for (const t of tris) {
    if (!t.uv) continue;
    const L = t.uv.map(([u, v]) => local(u, v));
    for (const [x, y] of L) { island[0] = Math.min(island[0], x); island[1] = Math.min(island[1], y); island[2] = Math.max(island[2], x); island[3] = Math.max(island[3], y); }
    const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a), s1 = [L[1][0] - L[0][0], L[1][1] - L[0][1]], s2 = [L[2][0] - L[0][0], L[2][1] - L[0][1]];
    const det = s1[0] * s2[1] - s1[1] * s2[0];
    if (Math.abs(det) < 1e-12) continue;
    const dPdu = [0, 1, 2].map((k) => (e1[k] * s2[1] - e2[k] * s1[1]) / det), dPdv = [0, 1, 2].map((k) => (e2[k] * s1[0] - e1[k] * s2[0]) / det);
    const A = Math.hypot(...cross(e1, e2)) / 2;
    du += Math.hypot(...dPdu) * A; dv += Math.hypot(...dPdv) * A; wsum += A;
  }
  const wm = (du / wsum) * (island[2] - island[0]), hm = (dv / wsum) * (island[3] - island[1]);
  return { cw: Math.max(4, Math.round(wm * target)), ch: Math.max(4, Math.round(hm * target)), rotate: (wm > hm) !== (art.width > art.height), island };
}
/** Colour family of a texel, by the same rule `props reskin-plan` classifies a prop with. */
export function family(r: number, g: number, b: number): "wood" | "grey" | "other" {
  const R = r / 255, G = g / 255, B = b / 255, mx = Math.max(R, G, B), mn = Math.min(R, G, B), sat = mx ? (mx - mn) / mx : 0;
  let hue = 0;
  if (mx !== mn) hue = mx === R ? 60 * (((G - B) / (mx - mn)) % 6) : mx === G ? 60 * ((B - R) / (mx - mn) + 2) : 60 * ((R - G) / (mx - mn) + 4);
  if (hue < 0) hue += 360;
  if (sat < 0.22 || mx < 0.1) return "grey";
  if (hue >= 8 && hue <= 50 && sat >= 0.3 && mx <= 0.9) return "wood";
  return "other";
}
/**
 * Route b: modulate the content (the prop's own colours) by a town role tile projected onto the prop in METRES,
 * per triangle along its dominant axis, so the grain lands at the role's density whatever the UV layout.
 */
export function roleOverlay(content: PixelPage, tris: Tri[], local: Local, role: Role): void {
  const cw = content.width, ch = content.height, [rx, ry, rw, rh] = role.rect, ppm = rw / role.metres;
  const lum = (x: number, y: number) => { const i = ((ry + y) * role.page.width + rx + x) * 4; return 0.299 * role.page.data[i] + 0.587 * role.page.data[i + 1] + 0.114 * role.page.data[i + 2]; };
  let mean = 0; for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) mean += lum(x, y); mean /= rw * rh;
  const mod = (Lm: number) => 1 + 0.85 * (Lm / mean - 1);
  const orig = Uint8Array.from(content.data);
  for (const t of tris) {
    if (!t.uv) continue;
    const P = t.uv.map(([u, v]) => { const [x, y] = local(u, v); return [x * cw, y * ch]; });
    const N = cross(sub(t.b, t.a), sub(t.c, t.a)), ax = N.map(Math.abs);
    const plane = (p: V3): [number, number] => ax[1] >= ax[0] && ax[1] >= ax[2] ? [p[0], -p[2]] : ax[0] >= ax[2] ? [p[2], p[1]] : [p[0], p[1]];
    const d = (P[1][1] - P[2][1]) * (P[0][0] - P[2][0]) + (P[2][0] - P[1][0]) * (P[0][1] - P[2][1]);
    if (Math.abs(d) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))), x1 = Math.min(cw - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
    const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))), y1 = Math.min(ch - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l1 = ((P[1][1] - P[2][1]) * (px - P[2][0]) + (P[2][0] - P[1][0]) * (py - P[2][1])) / d, l2 = ((P[2][1] - P[0][1]) * (px - P[2][0]) + (P[0][0] - P[2][0]) * (py - P[2][1])) / d, l3 = 1 - l1 - l2;
      if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
      const i = (y * cw + x) * 4;
      if (role.mask && family(orig[i], orig[i + 1], orig[i + 2]) !== role.mask) continue;
      const w: V3 = [0, 1, 2].map((c) => t.a[c] * l1 + t.b[c] * l2 + t.c[c] * l3) as V3;
      const [a, b] = plane(w);
      const tx = ((Math.floor(a * ppm) % rw) + rw) % rw, ty = ((Math.floor(-b * ppm) % rh) + rh) % rh;
      const m = mod(lum(tx, ty));
      for (let c = 0; c < 3; c++) content.data[i + c] = Math.max(0, Math.min(255, Math.round(orig[i + c] * m)));
    }
  }
}
