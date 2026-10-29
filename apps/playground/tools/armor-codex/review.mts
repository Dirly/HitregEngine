/**
 * `armor review`: the dressed character in its bind pose, both sexes, front and back, one row per tier, plus the
 * icon strip — drawn in software from the installed models, the set's sheets and the creation asset's mounts (the
 * same bones, offsets and mirror the creator preview uses: src/creation-preview.ts `mount`). No browser, no GPU,
 * no dev server: it can run beside world owners without taking a heavy slot.
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, encodePng } from "../_png.mjs";
// @ts-expect-error plain JS module
import { drawText, textWidth } from "../_font.mjs";
import { readGlb, mul, compose, eulerXYZ, apply, type Glb, type M4 } from "./glb.mts";
import type { Img } from "./measure.mts";

export interface Mount { model: string; socket: string; offset?: number[]; rotationDeg?: number[]; scale?: number; mirrorTo?: { socket: string; offset?: number[]; rotationDeg?: number[] }; requires?: { sex?: string[] } }
export interface Piece { glb: Glb; parts: string[]; tex: Img | null; at: M4 }
export type Sex = "male" | "female";

const holder = (at: { offset?: number[]; rotationDeg?: number[] }, scale: number, mirror: boolean): M4 =>
  compose(at.offset ?? [0, 0, 0], eulerXYZ(at.rotationDeg ?? [0, 0, 0]), [scale, scale, mirror ? -scale : scale]);

/** World matrices a mounted model is drawn at on the body (one, or two with its mirrored copy). */
export function mountMatrices(body: Glb, mounts: Mount[], model: string, sex: Sex): M4[] {
  const m = mounts.find((x) => x.model === model && (!x.requires?.sex || x.requires.sex.includes(sex)));
  if (!m) return [];
  const out: M4[] = [];
  const bone = body.joints[m.socket];
  if (bone) out.push(mul(bone, holder(m, m.scale ?? 1, false)));
  if (m.mirrorTo && body.joints[m.mirrorTo.socket]) out.push(mul(body.joints[m.mirrorTo.socket]!, holder(m.mirrorTo, m.scale ?? 1, true)));
  return out;
}

/** Orthographic, z-buffered, textured, lit render of pieces looking along -`dir` (dir = the side the camera is on). */
export function renderView(pieces: Piece[], dir: number[], heightPx: number, bg: number[] = [34, 32, 38]): Img {
  const SS = 3;
  type T = { p: number[][]; uv: number[][]; tex: Img | null };
  const tris: T[] = [];
  for (const pc of pieces) {
    const want = new Set(pc.parts.map((n) => pc.glb.parts[n]).filter((i): i is number => i !== undefined));
    for (const t of pc.glb.tris) if (want.has(t.part)) tris.push({ p: t.p.map((p) => apply(pc.at, p)), uv: t.uv, tex: pc.tex });
  }
  const right = [dir[2]!, 0, -dir[0]!]; // up = +Y; right = up x dir
  const up = [0, 1, 0];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of tris) for (const p of t.p) { const x = dot(p, right), y = dot(p, up); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const H = heightPx * SS, k = (H * 0.94) / (y1 - y0), W = Math.ceil((x1 - x0) * k + H * 0.06);
  const ox = (W - (x1 - x0) * k) / 2, oy = H * 0.03;
  const col = new Float32Array(W * H * 3), z = new Float32Array(W * H).fill(Infinity);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) col[i * 3 + c] = bg[c]!;
  const L = [0.35 * dir[0]! - 0.3 * right[0]!, 0.75, 0.35 * dir[2]! - 0.3 * right[2]!];
  const ll = Math.hypot(L[0]!, L[1]!, L[2]!);
  for (const t of tris) {
    const s = t.p.map((p) => [(dot(p, right) - x0) * k + ox, (y1 - dot(p, up)) * k + oy, -dot(p, dir)]);
    const [a, b, c] = s as [number[], number[], number[]];
    const area = (b[0]! - a[0]!) * (c[1]! - a[1]!) - (c[0]! - a[0]!) * (b[1]! - a[1]!);
    if (Math.abs(area) < 1e-9) continue;
    const e1 = t.p[1]!.map((v, i) => v - t.p[0]![i]!), e2 = t.p[2]!.map((v, i) => v - t.p[0]![i]!);
    let n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const nl = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    n = n.map((v) => v / nl);
    if (dot(n, dir) < 0) n = n.map((v) => -v);
    const lit = Math.min(1.15, 0.55 + 0.6 * Math.max(0, dot(n, L) / ll));
    const bx0 = Math.max(0, Math.floor(Math.min(a[0]!, b[0]!, c[0]!))), bx1 = Math.min(W - 1, Math.ceil(Math.max(a[0]!, b[0]!, c[0]!)));
    const by0 = Math.max(0, Math.floor(Math.min(a[1]!, b[1]!, c[1]!))), by1 = Math.min(H - 1, Math.ceil(Math.max(a[1]!, b[1]!, c[1]!)));
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0]! - px) * (c[1]! - py) - (c[0]! - px) * (b[1]! - py)) / area;
        const w1 = ((c[0]! - px) * (a[1]! - py) - (a[0]! - px) * (c[1]! - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * a[2]! + w1 * b[2]! + w2 * c[2]!;
        const at = y * W + x;
        if (d >= z[at]!) continue;
        let rgb = [170, 170, 170];
        if (t.tex) {
          const u = w0 * t.uv[0]![0]! + w1 * t.uv[1]![0]! + w2 * t.uv[2]![0]!, v = w0 * t.uv[0]![1]! + w1 * t.uv[1]![1]! + w2 * t.uv[2]![1]!;
          const tx = Math.min(t.tex.width - 1, Math.max(0, Math.floor(u * t.tex.width))), ty = Math.min(t.tex.height - 1, Math.max(0, Math.floor(v * t.tex.height)));
          const o = (ty * t.tex.width + tx) * 4;
          if (t.tex.data[o + 3]! < 128) continue;
          rgb = [t.tex.data[o]!, t.tex.data[o + 1]!, t.tex.data[o + 2]!];
        }
        z[at] = d;
        for (let q = 0; q < 3; q++) col[at * 3 + q] = Math.min(255, rgb[q]! * lit);
      }
  }
  const w = Math.floor(W / SS), h = heightPx, data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      for (let q = 0; q < 3; q++) {
        let s = 0;
        for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) s += col[((y * SS + dy) * W + x * SS + dx) * 3 + q]!;
        data[(y * w + x) * 4 + q] = Math.round(s / (SS * SS));
      }
      data[(y * w + x) * 4 + 3] = 255;
    }
  return { width: w, height: h, data };
}

/** Which way the body's chest faces in world space (+Z or -Z), from the chest front vs back part centroids. */
export function frontDir(body: Glb): number[] {
  const c = (name: string) => {
    const i = body.parts[name];
    let s = 0, n = 0;
    for (const t of body.tris) if (t.part === i) for (const p of t.p) { s += apply(body.meshWorld, p)[2]!; n++; }
    return n ? s / n : 0;
  };
  return c("HumanMale_ChestFront") >= c("HumanMale_ChestBack") ? [0, 0, 1] : [0, 0, -1];
}

/** Map an item's MALE parts to the woman's (the female body option's `remap`). */
export function femaleParts(parts: string[], remap: { parts?: Record<string, string>; prefixes?: Record<string, string> }): string[] {
  return parts.map((p) => {
    if (remap.parts?.[p]) return remap.parts[p]!;
    for (const [from, to] of Object.entries(remap.prefixes ?? {})) if (p.startsWith(from)) return to + p.slice(from.length);
    return p;
  });
}

export interface Sheet { rows: { label: string; views: Img[] }[]; icons: Img[]; title: string }
/** Compose the review PNG: one labelled row per tier, then the icon strip at 3x. */
export function composeSheet(s: Sheet): Img {
  const GAP = 10, LABEL = 16;
  const rowW = (r: { views: Img[] }) => r.views.reduce((a, v) => a + v.width + GAP, GAP);
  const iconZ = 3, iconW = s.icons.reduce((a, i) => a + i.width * iconZ + 4, GAP);
  const W = Math.max(...s.rows.map(rowW), iconW, 420);
  const iconH = s.icons.length ? Math.max(...s.icons.map((i) => i.height)) * iconZ + GAP * 2 + LABEL : 0;
  const H = LABEL + GAP + s.rows.reduce((a, r) => a + LABEL + Math.max(...r.views.map((v) => v.height)) + GAP, 0) + iconH;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([20, 19, 23, 255], i * 4);
  const plot = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < W && y < H) data.set([225, 220, 210, 255], (y * W + x) * 4); };
  const blit = (img: Img, ox: number, oy: number, zoom = 1) => {
    for (let y = 0; y < img.height * zoom; y++)
      for (let x = 0; x < img.width * zoom; x++) {
        const o = (((y / zoom) | 0) * img.width + ((x / zoom) | 0)) * 4;
        if (img.data[o + 3]! < 128) continue;
        const X = ox + x, Y = oy + y;
        if (X < W && Y < H) data.set(img.data.subarray(o, o + 3), (Y * W + X) * 4);
      }
  };
  drawText(s.title, GAP, 4, 2, plot);
  let y = LABEL + GAP;
  for (const r of s.rows) {
    drawText(r.label, GAP, y, 1, plot);
    y += LABEL - 4;
    let x = GAP;
    for (const v of r.views) { blit(v, x, y); x += v.width + GAP; }
    y += Math.max(...r.views.map((v) => v.height)) + GAP;
  }
  if (s.icons.length) {
    drawText("icons", GAP, y, 1, plot);
    y += LABEL - 4;
    let x = GAP;
    for (const ic of s.icons) { blit(ic, x, y, iconZ); x += ic.width * iconZ + 4; }
  }
  void textWidth;
  return { width: W, height: H, data };
}

export const readPng = (f: string): Img | null => (fs.existsSync(f) ? decodePng(fs.readFileSync(f)) : null);
export const writePng = (f: string, img: Img): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, encodePng(img.width, img.height, img.data));
};
