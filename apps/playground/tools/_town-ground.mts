/**
 * Helper for tools/town-ground.mts: the per-town config, the shared grid routines and the KEY -> GROUND build.
 * Ported from projects/proving/authoring/towns/tidewell-ground/{_common,key,ground}.mts (the Tidewell scripts
 * stay there as the reference); the measurement logic is unchanged, the Tidewell constants became config.
 */
import fs from "node:fs";
import path from "node:path";
import { applyRecipeEdits, worldRecipeSchema } from "@hitreg/core";
// @ts-expect-error plain JS helper
import { decodePng, encodePng } from "./_png.mjs";

export type P = [number, number];
export const readJson = (f: string): any => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
export const writeJson = (f: string, v: unknown): void => fs.writeFileSync(f, `${JSON.stringify(v, null, 1)}\n`);
export const round = (v: number, d = 100): number => Math.round(v * d) / d;
export const dist = (a: P, b: P): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ------------------------------------------------------------------ config

/** `<town>-ground/ground.json`. Every constant the Tidewell scripts hard-coded. `export` writes defaults when absent. */
export interface GroundConfig {
  world: string;
  townId: string;
  /** The site window: `size` m square at 1 m samples ((size+1)^2), map image `px` wide. North (-Z) is up. */
  site: { x0: number; z0: number; size: number; px: number };
  /** The gate the square and the gate link belong to (default: the town's first gate). */
  mainGate?: string;
  /** World roads cut back to a NEW gate where they meet the town (Tidewell: the south road's loop). */
  reroutes: { road: string; cutAt: P; gate: string; keep?: "head" | "tail" }[];
  /** Reserved, levelled structure sites from the key's cyan cells (shrine, tower...): one cyan block per entry, picked by
   *  `rule` (highest, lowest, nearest-gate, farthest-gate, largest), levelled at its mean natural height. Built later as geometry. */
  sites?: { structure: string; size: [number, number]; rule: string }[];
  grades: { street: number; lane: number; stair: number };
  cell: number;
  envelope: "full" | "ground";
  /** Reserved, levelled dock site along the shoreline fit (no quay is sculpted). Omit for an inland town. */
  dock?: { structure: string; groundY: number; from: number; to: number; half: number; seaward: "+x" | "-x" | "+z" | "-z" };
  /** Levelled works site from the key's cyan cells (salt pans). */
  pans?: { structure: string; groundY: number };
  bank: number;
  blend: number;
  patchId: string;
  /** Lot -> pad assignment, in order: [lot id, rule]. Rules: chapel, hall, largest, nearest-gate, farthest-gate, on-square,
   *  nearest-quay, highest, northmost. Unlisted plan buildings follow as `largest`. */
  roles: [string, string][];
  /** The agent-written layout intent appended to the composed key prompt (`request`). */
  keyBrief?: string;
  /** Door footpaths (`doors`). */
  paths: { width: number; shoulder: number; grade: number; surface?: string; clearance: number };
}

export interface Ctx {
  project: string;
  town: string;
  projectDir: string;
  townsDir: string;
  dir: string;
  worldFile: string;
  cfg: GroundConfig;
  n: number;
  townDoc: any;
}

export function context(project: string, town: string, worldOpt?: string): Ctx {
  const projectDir = path.resolve("projects", project);
  const townsDir = path.join(projectDir, "authoring", "towns");
  const dir = path.join(townsDir, `${town}-ground`);
  const townDocFile = path.join(townsDir, `${town}.json`);
  if (!fs.existsSync(townDocFile)) throw new Error(`no town doc ${townDocFile}`);
  const townDoc = readJson(townDocFile);
  const cfgFile = path.join(dir, "ground.json");
  let cfg: GroundConfig;
  const world = worldOpt ?? townDoc.world;
  const worldFile = path.join(projectDir, "assets", "worlds", `${world}.json`);
  if (fs.existsSync(cfgFile)) cfg = readJson(cfgFile);
  else {
    // defaults: a 256 m site centred on the town
    const raw = readJson(worldFile);
    const t = raw.features.towns.find((x: any) => x.id === townDoc.town);
    if (!t) throw new Error(`town ${townDoc.town} not in ${worldFile}`);
    cfg = {
      world, townId: townDoc.town, site: { x0: Math.round(t.at[0] - 128), z0: Math.round(t.at[1] - 128), size: 256, px: 1024 },
      reroutes: [], grades: { street: 0.15, lane: 0.12, stair: 0.5 }, cell: 3.2, envelope: "full", bank: 10, blend: 16,
      patchId: `${town}-town`, roles: [], keyBrief: "key-brief.txt",
      paths: { width: 2, shoulder: 1, grade: 0.2, clearance: 0.5 },
    };
    fs.mkdirSync(dir, { recursive: true });
    writeJson(cfgFile, cfg);
    console.log(`wrote default ${path.relative(process.cwd(), cfgFile)} (edit the site window, roles, dock before the key)`);
  }
  cfg.paths ??= { width: 2, shoulder: 1, grade: 0.2, clearance: 0.5 };
  if (worldOpt && worldOpt !== cfg.world) throw new Error(`--world ${worldOpt} but ground.json is for ${cfg.world}`);
  return { project, town, projectDir, townsDir, dir, worldFile: path.join(projectDir, "assets", "worlds", `${cfg.world}.json`), cfg, n: cfg.site.size + 1, townDoc };
}

/** A recipe with the town's own shaping lifted off: no shelves, no pad, no town roads, no ground patch (the bare hill). */
export function bareRecipe(c: Ctx, raw: any): any {
  const r = structuredClone(raw);
  const T = c.cfg.townId;
  r.features.towns = r.features.towns.map((t: any) => (t.id === T ? { ...t, flatten: 0, terraces: [] } : t));
  r.features.roads = r.features.roads.filter((x: any) => !x.id.startsWith(`${T}-`));
  r.features.heightPatches = (r.features.heightPatches ?? []).filter((p: any) => p.id !== c.cfg.patchId && !p.id.startsWith(`${c.town}-`));
  return r;
}
/** keep "tail" (default): the road leaves the town (drop points before cutAt); "head": the road ENDS in the town (drop points after). */
export function reroute(road: any, cutAt: P, keep: "head" | "tail" = "tail"): any {
  const k = road.points.findIndex((p: number[]) => Math.hypot(p[0] - cutAt[0], p[1] - cutAt[1]) < 1);
  if (keep === "head" ? k < 0 || k === road.points.length - 1 : k <= 0) return road; // already cut
  const cut = (a?: number[]): number[] | undefined => (a ? (keep === "head" ? a.slice(0, k + 1) : a.slice(k)) : a);
  return { ...road, points: cut(road.points), surfaceY: cut(road.surfaceY), leftY: cut(road.leftY), rightY: cut(road.rightY) };
}
export const applyReroutes = (c: Ctx, roads: any[]): any[] =>
  roads.map((x: any) => { const rr = c.cfg.reroutes.find((q) => q.road === x.id); return rr ? reroute(x, rr.cutAt, rr.keep) : x; });
export function bareRerouted(c: Ctx, raw: any): any {
  const r = bareRecipe(c, raw);
  r.features.roads = applyReroutes(c, r.features.roads);
  return r;
}

export const CLASSES = ["white", "square", "street", "lane", "quay", "saltpan", "chapel", "hall", "pad", "stair"] as const;
export const PALETTE: [number, number, number][] = [
  [255, 255, 255], [255, 153, 153], [255, 0, 0], [255, 136, 0], [0, 0, 0], [0, 255, 255], [255, 255, 0], [255, 0, 255], [0, 0, 255], [128, 0, 255],
];

// ------------------------------------------------------------------ key (port of key.mts)

export function parseKey(c: Ctx, file: string): string {
  const { dir } = c;
  const SITE = { ...c.cfg.site, n: c.n };
  const png = decodePng(fs.readFileSync(path.join(dir, file)));
  const W: number = png.width, H: number = png.height, px = png.data as Uint8Array;
  const classOf = (x: number, y: number): number => {
    const i = (Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4;
    let best = 0, bd = Infinity;
    for (let k = 0; k < PALETTE.length; k++) {
      const d = (px[i]! - PALETTE[k]![0]) ** 2 + (px[i + 1]! - PALETTE[k]![1]) ** 2 + (px[i + 2]! - PALETTE[k]![2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    return bd < 90 * 90 ? best : 0;
  };
  const S = W / SITE.px;
  const q = SITE.px / 1024;
  const corners: [number, number][] = [[24, 24], [1000, 24], [24, 1000], [1000, 1000]].map(([x, y]) => [x! * q, y! * q]);
  const found: [number, number][] = [];
  for (const [ex, ey] of corners) {
    let sx = 0, sy = 0, cnt = 0;
    for (let y = Math.max(0, Math.round((ey - 80 * q) * S)); y < Math.min(H, Math.round((ey + 80 * q) * S)); y++)
      for (let x = Math.max(0, Math.round((ex - 80 * q) * S)); x < Math.min(W, Math.round((ex + 80 * q) * S)); x++) {
        const i = (y * W + x) * 4;
        if (px[i]! < 60 && px[i + 1]! < 60 && px[i + 2]! < 60) { sx += x; sy += y; cnt++; }
      }
    if (cnt < 100 * S * S) throw new Error(`registration mark near (${ex},${ey}) not found (${cnt} dark px): the key is refused`);
    found.push([sx / cnt, sy / cnt]);
  }
  const solve3 = (m: number[][], b: number[]): number[] => {
    const a = m.map((r, i) => [...r, b[i]!]);
    for (let col = 0; col < 3; col++) {
      let p = col;
      for (let r = col + 1; r < 3; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[p]![col]!)) p = r;
      [a[col], a[p]] = [a[p]!, a[col]!];
      for (let r = 0; r < 3; r++) if (r !== col) { const f = a[r]![col]! / a[col]![col]!; for (let k = col; k < 4; k++) a[r]![k] = a[r]![k]! - f * a[col]![k]!; }
    }
    return [0, 1, 2].map((i) => a[i]![3]! / a[i]![i]!);
  };
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const atx = [0, 0, 0], aty = [0, 0, 0];
  found.forEach(([kx, ky], i) => {
    const row = [kx, ky, 1];
    for (let r = 0; r < 3; r++) {
      for (let cc = 0; cc < 3; cc++) ata[r]![cc] = ata[r]![cc]! + row[r]! * row[cc]!;
      atx[r] = atx[r]! + row[r]! * corners[i]![0];
      aty[r] = aty[r]! + row[r]! * corners[i]![1];
    }
  });
  const ax = solve3(ata, atx), ay = solve3(ata, aty);
  const toSite = (kx: number, ky: number): [number, number] => [ax[0]! * kx + ax[1]! * ky + ax[2]!, ay[0]! * kx + ay[1]! * ky + ay[2]!];
  const residual = Math.max(...found.map(([kx, ky], i) => Math.hypot(toSite(kx, ky)[0] - corners[i]![0], toSite(kx, ky)[1] - corners[i]![1])));
  const det = ax[0]! * ay[1]! - ax[1]! * ay[0]!;
  const toKey = (sx: number, sy: number): [number, number] => {
    const x = sx - ax[2]!, y = sy - ay[2]!;
    return [(ay[1]! * x - ax[1]! * y) / det, (-ay[0]! * x + ax[0]! * y) / det];
  };
  const n = SITE.n, Pp = SITE.px / SITE.size;
  let lab = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const votes = new Array(CLASSES.length).fill(0);
      for (let dy = -1.5; dy <= 1.5; dy++) for (let dx = -1.5; dx <= 1.5; dx++) {
        const [kx, ky] = toKey(i * Pp + dx, j * Pp + dy);
        votes[classOf(Math.round(kx), Math.round(ky))]++;
      }
      lab[i + j * n] = votes.indexOf(Math.max(...votes));
    }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if ((i < 14 || i > n - 15) && (j < 14 || j > n - 15)) lab[i + j * n] = 0; // marks
  const majority = (src: Uint8Array): Uint8Array => {
    const out = src.slice();
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const v = new Array(CLASSES.length).fill(0);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) v[src[i + di + (j + dj) * n]!]++;
      const m = v.indexOf(Math.max(...v));
      if (v[m] >= 5) out[i + j * n] = m;
    }
    return out;
  };
  lab = majority(lab);
  const morph = (src: Uint8Array, cls: number, grow: boolean): Uint8Array => {
    const out = src.slice();
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const k = i + j * n;
      let any = false, all = true;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const on = src[k + di + dj * n] === cls; any ||= on; all &&= on; }
      if (grow && src[k] === 0 && any) out[k] = cls;
      if (!grow && src[k] === cls && !all) out[k] = 0;
    }
    return out;
  };
  const CI = (cl: string): number => (CLASSES as readonly string[]).indexOf(cl);
  for (const cl of ["chapel", "hall", "pad", "saltpan"]) lab = morph(morph(lab, CI(cl), false), CI(cl), true); // open
  for (const cl of ["street", "lane", "square", "stair", "quay"]) lab = morph(morph(lab, CI(cl), true), CI(cl), false); // close
  interface Comp { cls: string; cells: number[]; area: number; centroid: [number, number]; axis: [number, number]; length: number; width: number }
  const seen = new Int32Array(n * n).fill(-1);
  const comps: Comp[] = [];
  for (let k0 = 0; k0 < n * n; k0++) {
    if (seen[k0]! >= 0 || lab[k0] === 0) continue;
    const cls = lab[k0]!, cells: number[] = [k0];
    seen[k0] = comps.length;
    for (let qq = 0; qq < cells.length; qq++) {
      const k = cells[qq]!, i = k % n, j = (k - i) / n;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const kk = ii + jj * n;
        if (seen[kk]! < 0 && lab[kk] === cls) { seen[kk] = comps.length; cells.push(kk); }
      }
    }
    let sx = 0, sz = 0;
    for (const k of cells) { sx += k % n; sz += Math.floor(k / n); }
    const cx = sx / cells.length, cz = sz / cells.length;
    let xx = 0, zz = 0, xz = 0;
    for (const k of cells) { const dx = (k % n) - cx, dz = Math.floor(k / n) - cz; xx += dx * dx; zz += dz * dz; xz += dx * dz; }
    const th = 0.5 * Math.atan2(2 * xz, xx - zz), axis: [number, number] = [Math.cos(th), Math.sin(th)];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const k of cells) { const dx = (k % n) - cx, dz = Math.floor(k / n) - cz, a = dx * axis[0] + dz * axis[1], b = -dx * axis[1] + dz * axis[0]; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    comps.push({ cls: CLASSES[cls]!, cells, area: cells.length, centroid: [SITE.x0 + cx, SITE.z0 + cz], axis, length: a1 - a0 + 1, width: b1 - b0 + 1 });
  }
  const MIN_AREA: Record<string, number> = { pad: 60, chapel: 60, hall: 60, saltpan: 30, square: 100, street: 20, lane: 15, quay: 20, stair: 8 };
  const kept = comps.filter((cp) => cp.area >= (MIN_AREA[cp.cls] ?? 20));
  for (const cp of comps) if (cp.area < (MIN_AREA[cp.cls] ?? 20)) for (const k of cp.cells) lab[k] = 0;
  fs.writeFileSync(path.join(dir, "key-labels.bin"), lab);
  writeJson(path.join(dir, "key-parse.json"), {
    key: file, keySize: [W, H], registration: { marks: found, residualSitePx: residual, affineX: ax, affineY: ay },
    counts: Object.fromEntries(CLASSES.map((cl, i) => [cl, lab.filter((v) => v === i).length])),
    components: kept.map(({ cells: _c, ...cp }) => ({ ...cp, centroid: cp.centroid.map((v) => Math.round(v * 100) / 100) })),
    dropped: comps.length - kept.length,
  });
  const map = decodePng(fs.readFileSync(path.join(dir, "site-map.png")));
  const ov = new Uint8Array(map.data);
  for (let y = 0; y < SITE.px; y++) for (let x = 0; x < SITE.px; x++) {
    const cl = lab[Math.min(n - 1, Math.round(x / Pp)) + Math.min(n - 1, Math.round(y / Pp)) * n]!;
    if (cl === 0) continue;
    const i = (x + y * SITE.px) * 4;
    for (let k = 0; k < 3; k++) ov[i + k] = Math.round(ov[i + k]! * 0.35 + PALETTE[cl]![k]! * 0.65);
  }
  fs.writeFileSync(path.join(dir, file.replace(".png", "-overlay.png")), encodePng(SITE.px, SITE.px, ov));
  return `registered (residual ${residual.toFixed(2)} site px); components: ${kept.map((cp) => `${cp.cls}:${cp.area}`).join(" ")}`;
}

// ------------------------------------------------------------------ grid routines

export function grid(n: number) {
  const N = n * n;
  function boxBlur(src: Float32Array, r: number): Float32Array {
    let a = src.slice(), b = new Float32Array(N);
    for (const horiz of [true, false]) {
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        let s = 0, c = 0;
        for (let d = -r; d <= r; d++) { const ii = horiz ? i + d : i, jj = horiz ? j : j + d; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue; s += a[ii + jj * n]!; c++; }
        b[i + j * n] = s / c;
      }
      [a, b] = [b, a];
    }
    return a;
  }
  /** Chamfer distance (8-neighbour, 1 / 1.414) from seed cells, carrying the nearest seed; `pass` limits where it may travel. */
  function chamfer(seeds: number[], pass: (k: number) => boolean = () => true): { dist: Float32Array; src: Int32Array } {
    const dst = new Float32Array(N).fill(Infinity), src = new Int32Array(N).fill(-1);
    for (const s of seeds) { dst[s] = 0; src[s] = s; }
    const nb = [[-1, -1, 1.4142], [0, -1, 1], [1, -1, 1.4142], [-1, 0, 1]] as const;
    for (let it = 0; it < 3; it++) {
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = i + j * n; if (!pass(k)) continue;
        for (const [di, dj, w] of nb) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= n) continue; const kk = ii + jj * n; if (dst[kk]! + w < dst[k]!) { dst[k] = dst[kk]! + w; src[k] = src[kk]!; } }
      }
      for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
        const k = i + j * n; if (!pass(k)) continue;
        for (const [di, dj, w] of nb) { const ii = i - di, jj = j - dj; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue; const kk = ii + jj * n; if (dst[kk]! + w < dst[k]!) { dst[k] = dst[kk]! + w; src[k] = src[kk]!; } }
      }
    }
    return { dist: dst, src };
  }
  function components(pred: (k: number) => boolean): number[][] {
    const seen = new Uint8Array(N), out: number[][] = [];
    for (let k0 = 0; k0 < N; k0++) {
      if (seen[k0] || !pred(k0)) continue;
      const cells = [k0]; seen[k0] = 1;
      for (let q = 0; q < cells.length; q++) {
        const k = cells[q]!, i = k % n, j = (k - i) / n;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue; const kk = ii + jj * n; if (!seen[kk] && pred(kk)) { seen[kk] = 1; cells.push(kk); } }
      }
      out.push(cells);
    }
    return out;
  }
  /** Dijkstra inside a cell set (8-neighbour), cost per step * w(cell). */
  function dijkstra(set: Set<number>, from: number[], w: (k: number) => number): { dist: Map<number, number>; prev: Map<number, number> } {
    const dst = new Map<number, number>(), prev = new Map<number, number>();
    const heap = new Heap();
    for (const f of from) { dst.set(f, 0); heap.push(0, f); }
    while (heap.size) {
      const [d, k] = heap.pop(); if (d > dst.get(k)!) continue;
      const i = k % n, j = (k - i) / n;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const kk = i + di + (j + dj) * n; if (!set.has(kk)) continue;
        const nd = d + Math.hypot(di, dj) * w(kk);
        if (nd < (dst.get(kk) ?? Infinity)) { dst.set(kk, nd); prev.set(kk, k); heap.push(nd, kk); }
      }
    }
    return { dist: dst, prev };
  }
  return { N, boxBlur, chamfer, components, dijkstra };
}
export class Heap {
  private h: [number, number][] = [];
  get size(): number { return this.h.length; }
  push(d: number, k: number): void { const h = this.h; h.push([d, k]); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (h[p]![0] <= h[i]![0]) break; [h[p], h[i]] = [h[i]!, h[p]!]; i = p; } }
  pop(): [number, number] { const h = this.h; const top = h[0]!, last = h.pop()!; if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && h[l]![0] < h[m]![0]) m = l; if (r < h.length && h[r]![0] < h[m]![0]) m = r; if (m === i) break; [h[m], h[i]] = [h[i]!, h[m]!]; i = m; } } return top; }
}
export function resample(pts: P[], step: number): P[] {
  const out: P[] = [pts[0]!]; let carry = 0;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!, b = pts[k]!, l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= l) { out.push([a[0] + ((b[0] - a[0]) * t) / l, a[1] + ((b[1] - a[1]) * t) / l]); t += step; }
    carry = l - (t - step);
  }
  if (Math.hypot(out.at(-1)![0] - pts.at(-1)![0], out.at(-1)![1] - pts.at(-1)![1]) > 0.3) out.push(pts.at(-1)!);
  return out;
}
export const segDist = (pts: P[], x: number, z: number): number => { let best = Infinity; for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1]!, [bx, bz] = pts[i]!, dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)); best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t)); } return best; };
/** Model envelope pre-rotation: the envelope's sides relative to the door side. */
export const PRE: Record<string, (e: any) => any> = {
  "-y": (e) => e, "+x": (e) => ({ front: e.right, left: e.front, back: e.left, right: e.back }),
  "-x": (e) => ({ front: e.left, right: e.front, back: e.right, left: e.back }), "+y": (e) => ({ front: e.back, back: e.front, left: e.right, right: e.left }),
};
export const DEFAULT_EXT = { full: { left: 0.45, right: 0.45, front: 0.75, back: 0.55 }, ground: { left: 0.4, right: 0.4, front: 0.55, back: 0.55 } };
export const envelopeOf = (env: any, model: string): any => env[`bh_${model.replace(/-/g, "_")}`] ?? env[model] ?? DEFAULT_EXT;

// ------------------------------------------------------------------ build (port of ground.mts)

export interface BuildResult { edits: any[]; inverse: any[]; recipe: any; report: any; heights: number[]; summary: string; writePlan: () => void }

export function buildGround(c: Ctx, opts: { dry: boolean }): BuildResult {
  const { cfg, dir } = c;
  const { x0, z0 } = cfg.site;
  const n = c.n;
  const { N, boxBlur, chamfer, components, dijkstra } = grid(n);
  const GRADE = cfg.grades.street, LANE_GRADE = cfg.grades.lane, PAN_Y = cfg.pans?.groundY ?? 1.4, CELL = cfg.cell;
  const FORESHORE_Y = cfg.dock?.groundY ?? 1.5;
  const ENVELOPE = cfg.envelope;
  const TOWN = cfg.townId;
  const nat = new Float32Array(fs.readFileSync(path.join(dir, "site.f32")).buffer.slice(0));
  if (nat.length !== N) throw new Error(`site.f32 has ${nat.length} samples, the site window needs ${N}: re-run export`);
  const lab = new Uint8Array(fs.readFileSync(path.join(dir, "key-labels.bin")));
  const C = Object.fromEntries(CLASSES.map((cl, i) => [cl, i])) as Record<(typeof CLASSES)[number], number>;
  const raw = readJson(c.worldFile);
  const town = raw.features.towns.find((t: any) => t.id === TOWN);
  const rrGate = (id?: string): any => { const r = cfg.reroutes.find((q) => q.gate === id); return r ? { id: r.gate, at: r.cutAt } : undefined; };
  const northGate = (cfg.mainGate && (town.gates.find((g: any) => g.id === cfg.mainGate) ?? rrGate(cfg.mainGate))) || town.gates[0] || rrGate(cfg.reroutes[0]?.gate);
  const planFile = path.join(c.townsDir, `${c.town}-plan.json`);
  const plan = readJson(planFile);
  const env = readJson(path.join(c.townsDir, `${c.town}-envelopes.json`));
  const W2 = (k: number): P => [x0 + (k % n), z0 + Math.floor(k / n)];
  const K = (x: number, z: number): number => { const i = Math.round(x - x0), j = Math.round(z - z0); return i < 0 || j < 0 || i >= n || j >= n ? -1 : i + j * n; };
  // shoreline fit (the reserved dock): per 1 m row the seaward-most sample still >= groundY; a line fit along the shore
  const dock = cfg.dock ? (() => {
    const D = cfg.dock!;
    const alongX = D.seaward === "+z" || D.seaward === "-z"; // the shore runs along x when the sea is north/south
    const sgn = D.seaward[0] === "+" ? 1 : -1;
    const rows: P[] = []; // [across coordinate, along coordinate]
    for (let a = D.from; a <= D.to; a++) {
      const fixedIdx = alongX ? a - x0 : a - z0;
      for (let s = 0; s < n; s++) {
        const v = sgn > 0 ? n - 1 - s : s;
        const k = alongX ? fixedIdx + v * n : v + fixedIdx * n;
        if (nat[k]! >= FORESHORE_Y) { rows.push([(alongX ? z0 : x0) + v, a]); break; }
      }
    }
    const ma = rows.reduce((t, p) => t + p[1], 0) / rows.length, mc = rows.reduce((t, p) => t + p[0], 0) / rows.length;
    let sca = 0, saa = 0; for (const [cc, a] of rows) { sca += (cc - mc) * (a - ma); saa += (a - ma) ** 2; }
    const b = sca / saa;
    // (across, along) frame -> world. For "+x" this is exactly ground.mts: x = a + b z.
    const toW = (across: number, along: number): P => (alongX ? [along, across] : [across, along]);
    const alongV0 = toW(b / Math.hypot(b, 1), 1 / Math.hypot(b, 1));
    const along: P = alongV0;
    const across: P = D.seaward === "+x" ? [along[1], -along[0]] : D.seaward === "-x" ? [-along[1], along[0]] : D.seaward === "+z" ? [-along[1], along[0]] : [along[1], -along[0]];
    const ac = (D.from + D.to) / 2, centre: P = toW(mc + b * (ac - ma), ac), length = (D.to - D.from) * Math.hypot(b, 1);
    const corners = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([s, t]) => [centre[0] + along[0] * s * length / 2 + across[0] * t * D.half, centre[1] + along[1] * s * length / 2 + across[1] * t * D.half] as P);
    return { centre, along, across, length, width: 2 * D.half, corners };
  })() : null;
  const inDock = (x: number, z: number, grow = 0): boolean => {
    if (!dock) return false;
    const dx = x - dock.centre[0], dz = z - dock.centre[1];
    return Math.abs(dx * dock.along[0] + dz * dock.along[1]) <= dock.length / 2 + grow && Math.abs(dx * dock.across[0] + dz * dock.across[1]) <= cfg.dock!.half + grow;
  };
  const isNet = (cl: number): boolean => cl === C.square || cl === C.street || cl === C.lane || cl === C.stair;
  const smoothstep = (a: number, b: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const argmax = (m: Map<number, number>): number => { let b = -1, bd = -1; for (const [k, d] of m) if (d > bd) { bd = d; b = k; } return b; };
  const walkBack = (prev: Map<number, number>, k: number): number[] => { const out = [k]; while (prev.has(out.at(-1)!)) out.push(prev.get(out.at(-1)!)!); return out; };
  const smoothLine = (cells: number[]): P[] => {
    const pts = cells.map(W2);
    return pts.map((_, i) => { let sx = 0, sz = 0, cnt = 0; for (let d = -2; d <= 2; d++) { const q = pts[Math.max(0, Math.min(pts.length - 1, i + d))]!; sx += q[0]; sz += q[1]; cnt++; } return [sx / cnt, sz / cnt] as P; });
  };
  const gateAnchors: P[] = cfg.reroutes.map((r) => r.cutAt);

  // ---- 1. streets
  const natS = boxBlur(nat, 3);
  const hNet = new Float32Array(N).fill(NaN);
  const squares = components((k) => lab[k] === C.square);
  const squareInfo = squares.map((cells) => {
    const L = cells.reduce((s, k) => s + natS[k]!, 0) / cells.length;
    for (const k of cells) hNet[k] = round(L);
    return { cells, level: round(L) };
  });
  const quayCells: number[] = []; for (let k = 0; k < N; k++) if (lab[k] === C.quay) quayCells.push(k);
  const quayDist = chamfer(quayCells).dist;
  const quayCentroid: P = quayCells.length ? [quayCells.reduce((s, k) => s + W2(k)[0], 0) / quayCells.length, quayCells.reduce((s, k) => s + W2(k)[1], 0) / quayCells.length] : (dock?.centre ?? [x0 + cfg.site.size / 2, z0 + cfg.site.size / 2]);
  interface Line { id: string; cls: "street" | "lane" | "stair"; pts: P[]; h: number[]; width: number; anchors: string[] }
  const lines: Line[] = [];
  const streetComps = components((k) => lab[k] === C.street || lab[k] === C.lane || lab[k] === C.stair)
    .map((cells) => ({ cells, cls: (lab[cells[0]!] === C.lane ? "lane" : lab[cells[0]!] === C.stair ? "stair" : "street") as Line["cls"] }))
    .sort((a, b) => Math.min(...a.cells.map((k) => quayDist[k]!)) - Math.min(...b.cells.map((k) => quayDist[k]!)));
  const notInComp = (set: Set<number>): number[] => { const out: number[] = []; for (let k = 0; k < N; k++) if (!set.has(k)) out.push(k); return out; };
  function profile(pts: P[], anchorsAt: (p: P, idx: number) => number | null, G: number): { h: number[]; anchors: string[] } {
    const L = pts.length, t = pts.map((p) => { const k = K(p[0], p[1]); return k >= 0 ? natS[k]! : 0; });
    const ts = t.map((_, i) => { let s = 0, cnt = 0; for (let d = -4; d <= 4; d++) { const q = t[Math.max(0, Math.min(L - 1, i + d))]!; s += q; cnt++; } return s / cnt; });
    const anchors: { i: number; y: number }[] = [];
    pts.forEach((p, i) => { const y = anchorsAt(p, i); if (y !== null) anchors.push({ i, y }); });
    const step = pts.length > 1 ? Math.hypot(pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1]) : 1;
    const h = ts.map((v, i) => {
      let lo = -Infinity, hi = Infinity;
      for (const a of anchors) { const d = Math.abs(i - a.i) * step * G; lo = Math.max(lo, a.y - d); hi = Math.min(hi, a.y + d); }
      return lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v));
    });
    for (const a of anchors) h[a.i] = a.y;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 1; i < L; i++) h[i] = Math.max(h[i - 1]! - G * step, Math.min(h[i - 1]! + G * step, h[i]!));
      for (let i = L - 2; i >= 0; i--) h[i] = Math.max(h[i + 1]! - G * step, Math.min(h[i + 1]! + G * step, h[i]!));
    }
    return { h: h.map((v) => round(v)), anchors: anchors.map((a) => `${a.i}:${round(a.y)}`) };
  }
  let streetNo = 0, laneNo = 0;
  for (const comp of streetComps) {
    const set = new Set(comp.cells);
    const edge = chamfer(notInComp(set)).dist;
    const w = (k: number): number => 1 / (0.4 + edge[k]!);
    const a = argmax(dijkstra(set, [comp.cells[0]!], w).dist);
    const fromA = dijkstra(set, [a], w);
    const b = argmax(fromA.dist);
    const paths: number[][] = [walkBack(fromA.prev, b).reverse()];
    for (let guard = 0; guard < 8; guard++) {
      const onPath = new Set(paths.flat());
      const reach = dijkstra(set, [...onPath], () => 1);
      let far = -1, fd = 6;
      for (const k of comp.cells) { const d = reach.dist.get(k) ?? 0; if (d > fd && edge[k]! >= 1.5) { fd = d; far = k; } }
      if (far < 0) break;
      const br = dijkstra(set, [...onPath], w);
      paths.push(walkBack(br.prev, far).reverse());
    }
    const width = Math.max(comp.cls === "street" ? 5 : 3.5, Math.min(8, 2 * [...set].map((k) => edge[k]!).sort((p, q) => q - p)[Math.floor(set.size * 0.1)]!));
    paths.forEach((cells, pi) => {
      const pts = resample(smoothLine(cells), 1);
      const G = comp.cls === "lane" ? LANE_GRADE : comp.cls === "stair" ? cfg.grades.stair : GRADE;
      const anchorsAt = (p: P, i: number): number | null => {
        const k = K(p[0], p[1]);
        const end = i === 0 || i === pts.length - 1;
        if (!end) return null;
        if (k >= 0 && (quayDist[k]! <= 3 || inDock(p[0], p[1], 3))) return FORESHORE_Y;
        for (const s of squareInfo) if (s.cells.some((cc) => Math.hypot(W2(cc)[0] - p[0], W2(cc)[1] - p[1]) < 5)) return s.level;
        for (const g of gateAnchors) if (Math.hypot(p[0] - g[0], p[1] - g[1]) < 4) { const kk = K(...g); return natS[kk]!; }
        let best: number | null = null, bd = 7;
        for (const l of lines) l.pts.forEach((q, qi) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = l.h[qi]!; } });
        return best;
      };
      const { h, anchors } = profile(pts, anchorsAt, G);
      const id = comp.cls === "street" ? `street-${++streetNo}` : `lane-${++laneNo}`;
      lines.push({ id, cls: comp.cls, pts, h, width: pi === 0 ? width : Math.max(3.5, width - 1), anchors });
    });
    const seeds: number[] = [], seedH = new Map<number, number>();
    for (const l of lines.slice(lines.length - paths.length)) l.pts.forEach((p, i) => { const k = K(p[0], p[1]); if (k >= 0 && set.has(k)) { seeds.push(k); seedH.set(k, l.h[i]!); } });
    const nearest = chamfer(seeds, (k) => set.has(k)).src;
    for (const k of comp.cells) hNet[k] = seedH.get(nearest[k]!) ?? natS[k]!;
  }

  // ---- 3. buildings
  const parse = readJson(path.join(dir, "key-parse.json"));
  interface Pad { cls: string; centroid: P; area: number }
  const pads: Pad[] = parse.components.filter((cp: any) => ["pad", "chapel", "hall"].includes(cp.cls)).map((cp: any) => ({ cls: cp.cls, centroid: cp.centroid, area: cp.area }));
  const netCells: number[] = []; for (let k = 0; k < N; k++) if (isNet(lab[k]!) && !Number.isNaN(hNet[k]!)) netCells.push(k);
  const netNear = chamfer(netCells).src;
  const squareOf = (k: number): number => squareInfo.findIndex((s) => s.cells.includes(k));
  type Front = { edge: P; facing: P; cell: number; onSquare: boolean };
  function frontAt(k: number, p: P): Front {
    const cc = W2(k);
    let f: P = [cc[0] - p[0], cc[1] - p[1]];
    const sq = squareOf(k);
    if (sq >= 0) f = Math.abs(f[0]) > Math.abs(f[1]) ? [Math.sign(f[0]), 0] : [0, Math.sign(f[1])];
    else {
      const near = netCells.filter((q) => { const w = W2(q); return Math.hypot(w[0] - cc[0], w[1] - cc[1]) <= 4 && squareOf(q) < 0; });
      let mx = 0, mz = 0; for (const q of near) { mx += W2(q)[0]; mz += W2(q)[1]; } mx /= near.length; mz /= near.length;
      let xx = 0, zz = 0, xz = 0; for (const q of near) { const dx = W2(q)[0] - mx, dz = W2(q)[1] - mz; xx += dx * dx; zz += dz * dz; xz += dx * dz; }
      const th = 0.5 * Math.atan2(2 * xz, xx - zz), nrm: P = [-Math.sin(th), Math.cos(th)];
      f = nrm[0] * f[0] + nrm[1] * f[1] >= 0 ? nrm : [-nrm[0], -nrm[1]];
    }
    const l = Math.hypot(f[0], f[1]) || 1; f = [f[0] / l, f[1] / l];
    return { edge: [cc[0] - f[0] * 0.5, cc[1] - f[1] * 0.5], facing: f, cell: k, onSquare: sq >= 0 };
  }
  const frontOf = (p: P): Front => frontAt(netNear[K(p[0], p[1])]!, p);
  const byId = (id: string): any => plan.buildings.find((b: any) => b.id === id);
  const left = pads.map((p, i) => ({ ...p, i }));
  type Cand = (typeof left)[number];
  const take = (pred: (p: Cand) => boolean, score: (p: Cand) => number): Cand | null => {
    const cnd = left.filter(pred).sort((a, b) => score(a) - score(b))[0] ?? null;
    if (cnd) left.splice(left.indexOf(cnd), 1);
    return cnd;
  };
  const blue = (p: Pad): boolean => p.cls === "pad";
  const RULES: Record<string, () => Cand | null> = {
    chapel: () => take((p) => p.cls === "chapel", (p) => -p.area) ?? take(blue, (p) => -p.area),
    hall: () => take((p) => p.cls === "hall", (p) => -p.area) ?? take(blue, (p) => (squareInfo.length ? dist(p.centroid, W2(squareInfo[0]!.cells[0]!)) : 0)),
    largest: () => take(blue, (p) => -p.area),
    "nearest-gate": () => take(blue, (p) => dist(p.centroid, northGate.at)),
    "farthest-gate": () => take(blue, (p) => -dist(p.centroid, northGate.at)),
    "on-square": () => take(blue, (p) => (frontOf(p.centroid).onSquare ? 0 : 1000) + dist(p.centroid, northGate.at) * 0.01),
    "nearest-quay": () => take(blue, (p) => dist(p.centroid, quayCentroid)),
    highest: () => take(blue, (p) => -(natS[K(...p.centroid)] ?? 0)),
    northmost: () => take(blue, (p) => p.centroid[1]),
  };
  const roles: [string, string][] = [...cfg.roles];
  for (const b of plan.buildings) if (!roles.some(([id]) => id === b.id)) roles.push([b.id, "largest"]);
  const assign: [string, Pad | null][] = roles.map(([id, rule]) => {
    const near = /^near:(-?[\d.]+),(-?[\d.]+)$/.exec(rule); // an explicit spot (world x,z): the remaining pad nearest it
    if (near) { const q: P = [Number(near[1]), Number(near[2])]; return [id, take((p) => p.cls === "pad" || p.cls === "chapel" || p.cls === "hall", (p) => dist(p.centroid, q))]; }
    if (!RULES[rule]) throw new Error(`unknown role rule "${rule}" for ${id} (${Object.keys(RULES).join(", ")})`);
    return [id, RULES[rule]!()];
  });
  const missing = assign.filter(([, p]) => !p).map(([id]) => id);
  if (missing.length) throw new Error(`the key has too few pads for: ${missing.join(", ")}`);

  const worldRoads = raw.features.roads.filter((r: any) => !r.id.startsWith(`${TOWN}-`) && r.points.some((q: P) => q[0] > x0 - 30 && q[0] < x0 + cfg.site.size + 30 && q[1] > z0 - 30 && q[1] < z0 + cfg.site.size + 30));
  const worldRoadsR = applyReroutes(c, worldRoads);
  const gatesAt: P[] = [...town.gates.map((g: any) => g.at as P), ...gateAnchors];
  const taken = new Uint8Array(N);
  const hPad = new Float32Array(N).fill(NaN);
  const placed: any[] = [];
  const rejects: Record<string, Record<string, number>> = {};
  function geometry(id: string, fr: Front) {
    const b = byId(id);
    const model = b.model ?? b.id;
    const rawExt = envelopeOf(env, model);
    const door = rawExt.door ?? "-y";
    const g = PRE[door]!(rawExt[ENVELOPE] ?? rawExt.ground);
    const [w0, d0] = b.request.size as [number, number];
    const [w, d] = door === "+x" || door === "-x" ? [d0, w0] : [w0, d0];
    const Wm = w * CELL, Dm = d * CELL;
    const setback = round(g.front * CELL + 1.8);
    const setbackUsed = Math.max(setback, g.front * CELL + 0.5);
    let hsh = 0; for (const ch of b.id as string) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    const jit = (((hsh % 1000) / 1000) * 2 - 1) * ((6 * Math.PI) / 180);
    const cs = Math.cos(jit), sn = Math.sin(jit), f = fr.facing;
    const facing0: P = [f[0] * cs + f[1] * sn, -f[0] * sn + f[1] * cs];
    const v: P = [-facing0[0], -facing0[1]], u: P = [v[1], -v[0]];
    const a = fr.edge, centreV = 0.01 + setbackUsed + Dm / 2;
    const centre: P = [a[0] + v[0] * centreV, a[1] + v[1] * centreV];
    const right: P = [f[1], -f[0]];
    const env0 = { r0: -Wm / 2 - g.left * CELL, r1: Wm / 2 + g.right * CELL, f0: -Dm / 2 - g.back * CELL, f1: Dm / 2 + g.front * CELL };
    const padRect = { r0: env0.r0 - 1.5, r1: env0.r1 + 1.5, f0: env0.f0 - 1.5, f1: Dm / 2 + setbackUsed + 0.6 };
    const cellsIn = (r: { r0: number; r1: number; f0: number; f1: number }, grow: number): number[] => {
      const out: number[] = [];
      const R = Math.hypot(Math.max(-r.r0, r.r1), Math.max(-r.f0, r.f1)) + grow + 1;
      for (let jj = Math.max(0, Math.floor(centre[1] - z0 - R)); jj <= Math.min(n - 1, Math.ceil(centre[1] - z0 + R)); jj++)
        for (let ii = Math.max(0, Math.floor(centre[0] - x0 - R)); ii <= Math.min(n - 1, Math.ceil(centre[0] - x0 + R)); ii++) {
          const dx = x0 + ii - centre[0], dz = z0 + jj - centre[1], ra = dx * right[0] + dz * right[1], fw = dx * f[0] + dz * f[1];
          if (ra >= r.r0 - grow && ra <= r.r1 + grow && fw >= r.f0 - grow && fw <= r.f1 + grow) out.push(ii + jj * n);
        }
      return out;
    };
    return { b, model, g, Wm, Dm, setback, setbackUsed, centreV, centre, right, f, u, a, env0, padRect, cellsIn };
  }
  function why(id: string, fr: Front): string | null {
    const G = geometry(id, fr);
    for (const k of G.cellsIn(G.env0, 0.6)) {
      if (isNet(lab[k]!) || lab[k] === C.saltpan) return "street";
      if (taken[k]) return "lot";
      if (nat[k]! < 0.6) return "sea";
      const [x, z] = W2(k);
      if (inDock(x, z, 1)) return "dock";
      for (const r of worldRoadsR) if (segDist(r.points, x, z) < r.width / 2 + 2) return "world-road";
      for (const l of lines) if (segDist(l.pts, x, z) < l.width / 2 + 1.5) return "street";
      for (const g of gatesAt) if (Math.hypot(g[0] - x, g[1] - z) < 5) return "gate";
    }
    return null;
  }
  for (const [id, pad] of assign) {
    const p = pad!.centroid;
    const first = frontOf(p);
    const cands = [first.cell, ...netCells.filter((k) => k !== first.cell && dist(W2(k), p) <= 80).sort((a, b) => dist(W2(a), p) - dist(W2(b), p))];
    let fr: Front | null = null;
    rejects[id] = {};
    const tries = cands.flatMap((k) => { const cc = W2(k); return [[k, p], [k, [2 * cc[0] - p[0], 2 * cc[1] - p[1]] as P]] as [number, P][]; });
    for (const [k, side] of tries) {
      const cf = frontAt(k, side);
      const e = K(cf.edge[0] - cf.facing[0] * 1, cf.edge[1] - cf.facing[1] * 1);
      if (e < 0 || isNet(lab[e]!)) { rejects[id]!["inside"] = (rejects[id]!["inside"] ?? 0) + 1; continue; }
      const w = why(id, cf);
      if (!w) { fr = cf; break; }
      rejects[id]![w] = (rejects[id]![w] ?? 0) + 1;
    }
    if (!fr && process.env.TOWN_GROUND_SKIP) { console.warn(`SKIP no lot for ${id} within 80 m of its pad: ${JSON.stringify(rejects[id])}`); continue; } // planning aid: --dry runs only
    if (!fr) throw new Error(`no lot for ${id} within 80 m of its pad: ${JSON.stringify(rejects[id])}`);
    const G = geometry(id, fr);
    const mine = new Set(G.cellsIn(G.env0, 0.5));
    for (const k of mine) taken[k] = 1;
    const y = hNet[fr.cell]!;
    let over = 0;
    for (const k of G.cellsIn(G.padRect, 0)) {
      if (isNet(lab[k]!)) continue;
      if (taken[k] && !mine.has(k)) continue;
      const [x, z] = W2(k), dx = x - G.centre[0], dz = z - G.centre[1], fw = dx * G.f[0] + dz * G.f[1];
      if (!Number.isNaN(hPad[k]!)) over++;
      if (fw > G.env0.f1) {
        const t = Math.min(1, (fw - G.env0.f1) / Math.max(0.5, G.padRect.f1 - G.env0.f1));
        const sh = hNet[netNear[k]!]!;
        hPad[k] = round(y + 0.05 + (sh - y - 0.05) * t);
      } else hPad[k] = round(y + 0.05);
    }
    const a = G.a, u = G.u;
    placed.push({
      id, model: G.model, padFrom: pad, keyFront: fr.cell === first.cell, frontCell: W2(fr.cell), edge: a.map((q) => round(q)), facing: G.f.map((q) => round(q, 1000)),
      centre: G.centre.map((q) => round(q)), padY: round(y + 0.05), setback: G.setback, onSquare: fr.onSquare, overlapsOtherPad: over, rejected: rejects[id],
      terrace: { id: `${TOWN}-lot-${id}`, radius: Math.max(40, Math.ceil(Math.hypot(G.centreV - G.env0.f0, Math.max(0, Math.max(-G.env0.r0, G.env0.r1) - 4))) + 2), points: [[a[0] - u[0] * 4, a[1] - u[1] * 4], a, [a[0] + u[0] * 4, a[1] + u[1] * 4]].map((q) => q.map((v2) => round(v2, 1000))) },
    });
  }

  // ---- 3b. structure sites (cyan blocks): reserved and levelled only
  const siteY = new Float32Array(N).fill(NaN);
  const siteComps = (cfg.sites ?? []).length ? components((k) => lab[k] === C.saltpan).map((cells) => {
    const level = round(cells.reduce((s, k) => s + natS[k]!, 0) / cells.length);
    const cs = cells.map(W2);
    return { cells, level, centroid: [round(cs.reduce((s, q) => s + q[0], 0) / cs.length), round(cs.reduce((s, q) => s + q[1], 0) / cs.length)] as P,
      bbox: [Math.min(...cs.map((q) => q[0])), Math.min(...cs.map((q) => q[1])), Math.max(...cs.map((q) => q[0])), Math.max(...cs.map((q) => q[1]))] };
  }) : [];
  const SITE_RULES: Record<string, (s: (typeof siteComps)[number]) => number> = {
    highest: (s) => -s.level, lowest: (s) => s.level, largest: (s) => -s.cells.length,
    "nearest-gate": (s) => dist(s.centroid, northGate.at), "farthest-gate": (s) => -dist(s.centroid, northGate.at),
  };
  const sites: { structure: string; level: number; centroid: P; bbox: number[]; area: number }[] = [];
  for (const st of cfg.sites ?? []) {
    if (!SITE_RULES[st.rule]) throw new Error(`unknown site rule "${st.rule}" for ${st.structure} (${Object.keys(SITE_RULES).join(", ")})`);
    const s = siteComps.sort((a, b) => SITE_RULES[st.rule]!(a) - SITE_RULES[st.rule]!(b)).shift();
    if (!s) throw new Error(`the key has too few cyan site blocks for: ${st.structure}`);
    for (const k of s.cells) siteY[k] = s.level;
    sites.push({ structure: st.structure, level: s.level, centroid: s.centroid, bbox: s.bbox, area: s.cells.length });
  }

  // ---- 4/5. the patch: constraints + harmonic banks
  const cons = new Float32Array(N).fill(NaN);
  for (let k = 0; k < N; k++) {
    if (!Number.isNaN(hNet[k]!)) cons[k] = hNet[k]!;
    else if (!Number.isNaN(hPad[k]!)) cons[k] = hPad[k]!;
    else if (inDock(...W2(k))) cons[k] = FORESHORE_Y;
    else if (!Number.isNaN(siteY[k]!)) cons[k] = siteY[k]!;
    else if (cfg.pans && lab[k] === C.saltpan) cons[k] = PAN_Y;
  }
  const seeds: number[] = []; for (let k = 0; k < N; k++) if (!Number.isNaN(cons[k]!)) seeds.push(k);
  const near = chamfer(seeds);
  const BANK = cfg.bank;
  const res = new Float32Array(N);
  const fixed = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (!Number.isNaN(cons[k]!)) { res[k] = cons[k]! - nat[k]!; fixed[k] = 1; }
    else if (near.dist[k]! >= BANK) fixed[k] = 1;
    else res[k] = (cons[near.src[k]!]! - nat[k]!) * (1 - smoothstep(0, BANK, near.dist[k]!));
  }
  for (let it = 0; it < 600; it++)
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const k = i + j * n;
      if (fixed[k]) continue;
      res[k] = (res[k - 1]! + res[k + 1]! + res[k - n]! + res[k + n]!) / 4;
    }
  const heights = new Array<number>(N);
  let maxChange = 0;
  for (let k = 0; k < N; k++) {
    const y = nat[k]! + res[k]!;
    heights[k] = round(y);
    maxChange = Math.max(maxChange, Math.abs(y - nat[k]!));
  }
  const patch = { id: cfg.patchId, origin: [x0, z0], size: [cfg.site.size, cfg.site.size], columns: n, rows: n, heights, blend: cfg.blend };
  const hAt = (x: number, z: number): number => heights[K(x, z)] ?? 0;

  // ---- recipe edits
  const streetRoads: any[] = lines.map((l) => {
    const pts = resample(l.pts, 3);
    return {
      id: `${TOWN}-street-${l.id}`, points: pts.map((p) => p.map((q) => round(q))), width: round(l.width, 10), shoulder: 1,
      surfaceY: pts.map((p) => round(hAt(p[0], p[1]))), flatten: 1, surface: l.cls === "street" ? "gravel" : "dirt", surfaceEdge: 1, role: "paving",
    };
  });
  for (const [si, s] of squareInfo.entries()) {
    const cs = s.cells.map(W2), mx = cs.reduce((a, q) => a + q[0], 0) / cs.length, mz = cs.reduce((a, q) => a + q[1], 0) / cs.length;
    const wide = Math.max(...cs.map((q) => q[0])) - Math.min(...cs.map((q) => q[0])), deep = Math.max(...cs.map((q) => q[1])) - Math.min(...cs.map((q) => q[1]));
    const alongX = wide >= deep;
    const roadW = Math.min(wide, deep) - 2;
    const half = Math.max(0.5, (alongX ? wide : deep) / 2 - roadW / 2 - 0.5);
    const ends: P[] = alongX ? [[mx - half, mz], [mx + half, mz]] : [[mx, mz - half], [mx, mz + half]];
    if (dist(northGate.at, [mx, mz]) < Math.max(wide, deep)) {
      const e = dist(northGate.at, ends[0]!) < dist(northGate.at, ends[1]!) ? ends[0]! : ends[1]!;
      streetRoads.push({ id: `${TOWN}-street-gate-link`, points: [northGate.at, e].map((p: P) => p.map((q) => round(q))), width: 4, shoulder: 1, surfaceY: [s.level, s.level], flatten: 1, surface: "gravel", surfaceEdge: 1, role: "paving" });
    }
    streetRoads.push({ id: `${TOWN}-street-square-${si + 1}`, points: ends.map((p) => p.map((q) => round(q))), width: round(roadW, 10), shoulder: 1, surfaceY: ends.map(() => s.level), flatten: 1, surface: "gravel", surfaceEdge: 1, role: "paving" });
  }
  const newGates = cfg.reroutes.map((rr) => {
    const r = raw.features.roads.find((x: any) => x.id === rr.road);
    const cut = reroute(r, rr.cutAt, rr.keep);
    const [p0, p1] = rr.keep === "head" ? [...cut.points].reverse() : cut.points; const l = dist(p0, p1);
    return { id: rr.gate, at: rr.cutAt, facing: [(p1[0] - p0[0]) / l, (p1[1] - p0[1]) / l], width: 6, approach: 10, tags: [] };
  }).filter((g, i, a) => a.findIndex((x) => x.id === g.id) === i); // two roads cut at one gate make one gate
  const newTown = {
    ...town,
    terraces: placed.map((p) => ({ id: p.terrace.id, points: p.terrace.points, radius: p.terrace.radius ?? 40, falloff: 0, groundY: p.padY, flatten: 0, tags: ["lot-frame"] })),
    gates: [...town.gates.filter((g: any) => !newGates.some((ng) => ng.id === g.id)), ...newGates],
  };
  const recipe = worldRecipeSchema.parse(raw);
  const edits: any[] = [];
  for (const r of recipe.features.roads) if (r.id.startsWith(`${TOWN}-stair-`) || r.id.startsWith(`${TOWN}-lane-`) || r.id.startsWith(`${TOWN}-street-`)) edits.push({ edit: "remove-feature", kind: "roads", id: r.id });
  for (const rr of cfg.reroutes) edits.push({ edit: "update-feature", kind: "roads", id: rr.road, feature: reroute(recipe.features.roads.find((r) => r.id === rr.road), rr.cutAt, rr.keep) });
  for (const r of streetRoads) edits.push({ edit: "add-feature", kind: "roads", feature: r });
  edits.push({ edit: "update-feature", kind: "towns", id: TOWN, feature: newTown });
  const old = (recipe.features.heightPatches ?? []).find((p) => p.id === patch.id);
  edits.push(old ? { edit: "update-feature", kind: "heightPatches", id: patch.id, feature: patch } : { edit: "add-feature", kind: "heightPatches", feature: patch });
  const result = applyRecipeEdits(recipe, edits);

  // ---- report + review map
  const grades = streetRoads.map((r) => {
    let max = 0, at: P = [0, 0];
    const d = resample(r.points as P[], 1);
    for (let i = 2; i < d.length; i++) { const g = Math.abs(hAt(...d[i]!) - hAt(...d[i - 2]!)) / 2; if (g > max) { max = g; at = d[i]!; } }
    return { id: r.id, metres: d.length, width: r.width, from: r.surfaceY[0], to: r.surfaceY.at(-1), maxGrade2m: round(max, 1000), at };
  });
  const report = {
    key: parse.key, grade: { street: GRADE, lane: LANE_GRADE }, envelope: ENVELOPE, dockSite: dock ? { ...dock, groundY: FORESHORE_Y } : null, squares: squareInfo.map((s) => ({ level: s.level, cells: s.cells.length })),
    lines: lines.map((l) => ({ id: l.id, cls: l.cls, metres: l.pts.length, width: l.width, anchors: l.anchors, from: l.h[0], to: l.h.at(-1) })),
    grades, sites, buildings: placed.map(({ terrace: _t, ...p }) => p), maxHeightChange: round(maxChange), constrainedCells: seeds.length,
  };
  {
    const S = 4, M = n * S, img = new Uint8Array(M * M * 4);
    const hh = (i: number, j: number): number => heights[Math.max(0, Math.min(n - 1, i)) + Math.max(0, Math.min(n - 1, j)) * n]!;
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const i = Math.floor(x / S), j = Math.floor(y / S), k = i + j * n, hv = hh(i, j);
      const sx = hh(i + 1, j) - hh(i - 1, j), sz = hh(i, j + 1) - hh(i, j - 1), slope = Math.hypot(sx, sz) / 2;
      let col = hv < 0 ? [70, 110, 170] : [140 + Math.min(80, hv * 2.5), 160 + Math.min(60, hv * 1.5), 120];
      col = col.map((v) => v * Math.max(0.55, Math.min(1.2, 1 - (sx + sz) * 0.15)));
      if (lab[k] === C.square || lab[k] === C.street || lab[k] === C.lane) col = [150, 150, 150].map((v) => v * Math.max(0.6, Math.min(1.2, 1 - (sx + sz) * 0.15)));
      if (!Number.isNaN(hPad[k]!)) col = [col[0]! * 0.6, col[1]! * 0.6, 200];
      if (inDock(...W2(k))) col = [200, 170, 110];
      if (lab[k] === C.saltpan) col = [120, 220, 230];
      if (hv >= 0) { if (slope > 0.84) col = [220, 40, 40]; else if (slope > 0.36) col = [235, 140, 40]; else if (slope > 0.16 && !Number.isNaN(hNet[k]!)) col = [240, 220, 60]; }
      if (Math.floor(hv / 2) !== Math.floor(hh(i + 1, j) / 2) && x % S === 0) col = col.map((v) => v * 0.7);
      img.set([...col.map((v) => Math.max(0, Math.min(255, Math.round(v)))), 255], (x + y * M) * 4);
    }
    const dot = (p: P, r: number, colr: number[]): void => { const cx = (p[0] - x0) * S, cy = (p[1] - z0) * S; for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if (x >= 0 && y >= 0 && x < M && y < M && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) img.set([...colr, 255], (x + y * M) * 4); };
    const seg = (a: P, b: P, colr: number[]): void => { const l = Math.ceil(dist(a, b) * S); for (let t = 0; t <= l; t++) dot([a[0] + ((b[0] - a[0]) * t) / l, a[1] + ((b[1] - a[1]) * t) / l], 1.2, colr); };
    for (const p of placed) {
      const b = byId(p.id), rawExt = envelopeOf(env, p.model), door = rawExt.door ?? "-y";
      const [w0, d0] = b.request.size as [number, number], [w, d] = door === "+x" || door === "-x" ? [d0, w0] : [w0, d0];
      const f = p.facing as P, r: P = [f[1], -f[0]], c0 = p.centre as P, Wm = (w * CELL) / 2, Dm = (d * CELL) / 2;
      const q = [[-Wm, Dm], [Wm, Dm], [Wm, -Dm], [-Wm, -Dm]].map(([a, bb]) => [c0[0] + r[0] * a! + f[0] * bb!, c0[1] + r[1] * a! + f[1] * bb!] as P);
      for (let e = 0; e < 4; e++) seg(q[e]!, q[(e + 1) % 4]!, [10, 10, 10]);
      dot([c0[0] + f[0] * (Dm + 1.5), c0[1] + f[1] * (Dm + 1.5)], 3, [255, 255, 255]);
    }
    for (const g of newTown.gates) dot(g.at as P, 6, [255, 255, 255]);
    fs.writeFileSync(path.join(dir, opts.dry ? "ground-map-dry.png" : "ground-map.png"), encodePng(M, M, img));
  }
  const summary = [
    ...grades.map((g) => `${g.id} ${g.metres} m ${g.from}->${g.to} max ${(g.maxGrade2m * 100).toFixed(0)}%`),
    ...placed.map((p) => `${p.id.padEnd(16)} pad y ${p.padY} ${p.onSquare ? "square" : "street"} overlaps ${p.overlapsOtherPad}`),
    `patch ${n}x${n}, ${streetRoads.length} street roads, ${placed.length} lots; max height change ${round(maxChange)} m`,
  ].join("\n");

  // the plan: one frame terrace and one zero-width front lane per lot (town-layout re-derives these exact lots)
  const writePlan = (): void => {
    for (const p of placed) {
      const b = byId(p.id);
      Object.assign(b, { district: p.onSquare ? "square" : "harbour-street", terrace: p.terrace.id, u: 4, side: "east", setback: p.setback, street: `front-${p.id}` });
    }
    plan.lanes = placed.map((p) => ({ id: `front-${p.id}`, terrace: p.terrace.id, v: 0, width: 0.02, placementOnly: true, note: "the street edge this lot fronts (placed by tools/town-ground.mts build from the key)" }));
    const sp = parse.components.find((cp: any) => cp.cls === "saltpan"), qp = parse.components.find((cp: any) => cp.cls === "quay");
    for (const s of plan.structures ?? []) {
      if (dock && s.id === cfg.dock!.structure) {
        s.at = dock.centre.map((q) => round(q));
        s.site = { ...(s.site ?? {}), kind: "reserved-rect", groundY: FORESHORE_Y, centre: dock.centre.map((q) => round(q)), along: dock.along.map((q) => round(q, 1000)), length: round(dock.length), width: dock.width,
          corners: dock.corners.map((cc) => cc.map((q) => round(q))), keyJetty: qp ? qp.centroid : null };
      }
      if (cfg.pans && s.id === cfg.pans.structure && sp) { s.at = sp.centroid; s.site = { ...(s.site ?? {}), kind: "levelled-key-area", groundY: PAN_Y }; }
    }
    for (const st of sites) {
      const s = (plan.structures ?? []).find((q: any) => q.id === st.structure);
      if (s) { s.at = st.centroid; s.site = { ...(s.site ?? {}), kind: "levelled-key-area", groundY: st.level, centre: st.centroid, bbox: st.bbox, area: st.area, note: "reserved and levelled by tools/town-ground.mts build from the key's cyan block; the structure is real geometry built later" }; }
    }
    writeJson(planFile, plan);
  };
  return { edits, inverse: result.inverse, recipe: result.recipe, report, heights, summary, writePlan };
}
