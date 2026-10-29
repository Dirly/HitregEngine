/**
 * The COAST SHAPE step of `worldgen continents`, and the `shape` dogfood rule (2026-10-29 redstrand w2-shape).
 *
 * Derek: "make the continent feel unique". Ten seeds of disc + two lobes were ten rounded two-lobe blobs in a circular
 * sea: no headland, no bay, no peninsula, no sound, no islet. This step reads the laid landmass (its outline from the
 * centroid, the relief standing behind each stretch of coast) and, from the seed alone, writes:
 *
 *   capes    1-3 peninsulas reaching 15-35 % of the land width out to sea, ROOTED where the upland meets the coast
 *            (a peninsula carries the high ground on), each with a plateau spine (`features.ridges` id `cape-*`)
 *   inlets   1-3 bays / sounds cut 12-26 % of the width in, at the LOWEST stretches of coast (a valley mouth, where a
 *            river can reach the head)
 *   islets   2-4 small landmasses off the cape tips and the high coast (stacks / skerries)
 *
 * No per-world flag: every number is the seed times a share of the measured land width. `--no-shape` skips it.
 *
 * The rule (`measureShape`, judged by dogfood): the largest landmass's SOLIDITY (area / convex hull area) under
 * SOLIDITY_MAX, >= 1 peninsula (land outside the morphological opening reaching >= PENINSULA_REACH of the width) and
 * >= 1 bay (sea inside the hull >= BAY_DEPTH of the width from the hull edge), and its outline descriptor (rotation-
 * invariant Fourier magnitudes of the radial profile) at least DESCRIPTOR_MIN from every other seed's.
 */
import type { WorldField, WorldRecipe } from "@hitreg/core";

type Continent = NonNullable<WorldRecipe["bounds"]>["continents"][number];
type Ridge = WorldRecipe["features"]["ridges"][number];
type Capsule = [number, number, number, number, number, number];

/** Calibrated 2026-10-29 on six disc + lobe blobs (--no-shape): solidity 0.95-0.97, nearest descriptor 0.014-0.031. */
export const SOLIDITY_MAX = 0.85;
export const PENINSULA_REACH = 0.1;
export const BAY_DEPTH = 0.07;
export const DESCRIPTOR_MIN = 0.035;
const BEARINGS = 72;

const round = (v: number): number => Math.round(v * 10) / 10;

export interface CoastOutline {
  cx: number;
  cz: number;
  /** shore radius from the centroid per bearing (outermost land) */
  radius: number[];
  /** mean land height over the sea 150..500 m inland of the shore, per bearing */
  inland: number[];
  widthM: number;
}

/** The landmass outline seen from its centroid: shore radius and the height behind the shore per bearing. */
/** Crest width range of a cape spine (m): narrow, so the spine reads as a ridge along the arm, not a flat-topped stadium. */
export const SPINE_CREST_MIN = 18;
export const SPINE_CREST_MAX = 36;

/** A small deterministic stream for a spine's wander (mulberry32). */
function spineRandom(seed: number): () => number {
  let a = Math.floor(Math.abs(seed) * 1000) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function coastOutline(recipe: WorldRecipe, field: WorldField, widthM: number): CoastOutline {
  const sea = recipe.seaLevel;
  const limit = recipe.bounds?.limit ?? 3000;
  const step = Math.max(20, widthM / 100);
  let sx = 0, sz = 0, n = 0;
  for (let z = -limit; z <= limit; z += step * 2) for (let x = -limit; x <= limit; x += step * 2) if (field.height(x, z) > sea + 0.5) { sx += x; sz += z; n++; }
  const cx = n ? sx / n : 0, cz = n ? sz / n : 0;
  const radius: number[] = [], inland: number[] = [];
  for (let b = 0; b < BEARINGS; b++) {
    const a = (b / BEARINGS) * Math.PI * 2;
    const ux = Math.cos(a), uz = Math.sin(a);
    let last = 0;
    for (let r = 0; r < limit * 1.2; r += step) if (field.height(cx + ux * r, cz + uz * r) > sea + 0.5) last = r;
    radius.push(last);
    let sum = 0, k = 0;
    for (let d = 150; d <= 500 && d < last; d += 50) { sum += Math.max(0, field.height(cx + ux * (last - d), cz + uz * (last - d)) - sea); k++; }
    inland.push(k ? sum / k : 0);
  }
  return { cx, cz, radius, inland, widthM };
}

export interface CoastShape {
  capes: Capsule[];
  inlets: Capsule[];
  islets: Continent[];
  ridges: Ridge[];
  lines: string[];
}

const angDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % BEARINGS;
  return Math.min(d, BEARINGS - d) * (360 / BEARINGS);
};

/**
 * Plan the capes, inlets and islets for continent `main` from its measured outline. Pure: `random` is the seed's
 * stream, `o` the outline (coastOutline on the laid land with its relief).
 */
export function planCoastShape(main: Continent, o: CoastOutline, random: () => number, template: Pick<Continent, "warp">): CoastShape {
  const W = o.widthM;
  const lines: string[] = [];
  const maxIn = Math.max(1, ...o.inland);
  // smooth the inland height over +-2 bearings: one hot sample is not an upland
  const inl = o.inland.map((_, i) => {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += o.inland[(i + k + BEARINGS) % BEARINGS]!;
    return s / 5 / maxIn;
  });
  const pick = (count: number, score: (b: number) => number, ok: (b: number) => boolean): number[] => {
    const out: number[] = [];
    const order = Array.from({ length: BEARINGS }, (_, b) => b).sort((a, b) => score(b) - score(a));
    for (const b of order) {
      if (out.length >= count) break;
      if (o.radius[b]! < W * 0.15) continue;
      if (ok(b) && out.every((c) => angDist(c, b) >= 0)) out.push(b);
    }
    return out;
  };
  const jitter = Array.from({ length: BEARINGS }, () => random());
  // two capes, a third on a third of the seeds: one cape left the outline a blob on 4 of 10 seeds (solidity 0.86-0.89)
  const nCapes = 2 + (random() < 0.35 ? 1 : 0);
  const nInlets = 1 + Math.floor(random() * 2.4);
  const capeBearings: number[] = [];
  for (const b of pick(BEARINGS, (b) => inl[b]! * 0.55 + jitter[b]! * 0.45, () => true)) {
    if (capeBearings.length >= nCapes) break;
    if (capeBearings.every((c) => angDist(c, b) >= 75)) capeBearings.push(b);
  }
  const inletBearings: number[] = [];
  for (const b of pick(BEARINGS, (b) => (1 - inl[b]!) * 0.6 + jitter[(b * 7) % BEARINGS]! * 0.4, () => true)) {
    if (inletBearings.length >= nInlets) break;
    if (capeBearings.every((c) => angDist(c, b) >= 40) && inletBearings.every((c) => angDist(c, b) >= 60)) inletBearings.push(b);
  }
  const rel = (x: number, z: number): [number, number] => [round(x - main.center[0]), round(z - main.center[1])];
  const capes: Capsule[] = [];
  const ridges: Ridge[] = [];
  const islets: Continent[] = [];
  const tips: { x: number; z: number; dx: number; dz: number; hw: number }[] = [];
  capeBearings.forEach((b, i) => {
    const a = (b / BEARINGS) * Math.PI * 2;
    const ux = Math.cos(a), uz = Math.sin(a);
    const turn = (random() - 0.5) * 0.9;
    const dx = Math.cos(a + turn), dz = Math.sin(a + turn);
    const R = o.radius[b]!;
    const reach = W * (0.2 + random() * 0.15);
    const root = W * (0.1 + random() * 0.04);
    const elbowW = W * (0.06 + random() * 0.025);
    const tip = W * (0.035 + random() * 0.02);
    // two capsules with an ELBOW: a straight tapered finger reads as a pier, a bent arm as a headland
    const ax = o.cx + ux * (R - W * 0.09), az = o.cz + uz * (R - W * 0.09);
    const bend = (random() < 0.5 ? -1 : 1) * (0.12 + random() * 0.18) * reach;
    const t = 0.45 + random() * 0.2;
    const ex0 = o.cx + ux * R + dx * reach * t - dz * bend, ez0 = o.cz + uz * R + dz * reach * t + dx * bend;
    const bx = o.cx + ux * R + dx * reach, bz = o.cz + uz * R + dz * reach;
    capes.push([...rel(ax, az), ...rel(ex0, ez0), round(root), round(elbowW)]);
    capes.push([...rel(ex0, ez0), ...rel(bx, bz), round(elbowW), round(tip)]);
    const tdx = (bx - ex0) / Math.hypot(bx - ex0, bz - ez0), tdz = (bz - ez0) / Math.hypot(bx - ex0, bz - ez0);
    tips.push({ x: bx, z: bz, dx: tdx, dz: tdz, hw: tip });
    // the plateau spine: from the root along the arm to just short of the tip, crest 50-80 m over the natural ground
    const sx = o.cx + ux * (R - W * 0.04), sz = o.cz + uz * (R - W * 0.04);
    // the spine runs OUT TO THE TIP and falls into the sea there: a spine stopping short of the tip closed on itself
    const ex = bx - tdx * tip * 0.15, ez = bz - tdz * tip * 0.15;
    // a ridge, not a racetrack: 60-85 m over the cape's low ground on 45-65 m flanks, so its sides are the red cliff faces
    // the grand-entrance need wants (>= 55 m) with the cape's flat shore ground as their apron. The crest is NARROW
    // (SPINE_CREST_MAX): a 60-160 m flat top drew its flanks as a closed stadium ring round a top the colour of the
    // plain (redstrand 3039, 2026-10-29: "a long grey looping ridge shaped like a racetrack, reads man-made")
    const height = round(60 + random() * 25);
    const crest = round(SPINE_CREST_MIN + random() * (SPINE_CREST_MAX - SPINE_CREST_MIN));
    const falloff = round(45 + random() * 20);
    // the spine runs along ONE shore of the arm (the outside of the bend): a sheer side to the sea there, and on the
    // other side the arm's flat ground is the apron at the foot of a 60-85 m face (a probe on seed 2029: faces of 60-150 m
    // whose foot had 900-1580 m2 of apron with the spine on the axis, 1600 wanted)
    const side = bend > 0 ? -1 : 1;
    const nx0 = -uz * side, nz0 = ux * side, nx1 = -tdz * side, nz1 = tdx * side;
    const off = (w: number) => Math.max(0, w - crest / 2 - falloff * 0.6);
    const p0: [number, number] = [round(sx + nx0 * off(root) * 0.6), round(sz + nz0 * off(root) * 0.6)];
    const p1: [number, number] = [round(ex0 + nx1 * off(elbowW) * 0.6), round(ez0 + nz1 * off(elbowW) * 0.6)];
    const p2: [number, number] = [round(ex + nx1 * off(tip) * 0.4), round(ez + nz1 * off(tip) * 0.4)];
    // the crest WANDERS (a mid-point per leg pushed off the line) and its height rises out of the upland at the root
    // (no end cap standing on the land), peaks past the elbow and stays high to the sea cliff at the tip
    // its own stream (from the spine's root), so the outline drawn by `random` stays what it was for every seed
    const wob = spineRandom(p0[0] * 73.1 + p0[1] * 19.7 + i);
    const mid = (a: [number, number], c: [number, number], w: number): [number, number] => {
      const lx = c[0] - a[0], lz = c[1] - a[1], l = Math.hypot(lx, lz) || 1;
      const k = (wob() - 0.5) * 2 * w;
      return [round((a[0] + c[0]) / 2 - (lz / l) * k), round((a[1] + c[1]) / 2 + (lx / l) * k)];
    };
    const m0 = mid(p0, p1, Math.max(crest, off(root) * 0.3)), m1 = mid(p1, p2, Math.max(crest * 0.6, off(elbowW) * 0.2));
    const hs = [0.3, 0.7 + wob() * 0.2, 1, 0.8 + wob() * 0.15, 0.85 + wob() * 0.15].map((k) => round(height * k));
    ridges.push({ id: `cape-${i + 1}`, points: [p0, m0, p1, m1, p2], height, heights: hs, width: crest, falloff, tags: ["cape"] });
    lines.push(`cape-${i + 1}: bearing ${Math.round((b * 360) / BEARINGS)} deg (upland ${Math.round(o.inland[b]!)} m behind the coast), reaches ${Math.round(reach)} m (${Math.round((reach / W) * 100)} % of ${Math.round(W)} m), ${Math.round(root * 2)} -> ${Math.round(tip * 2)} m wide, plateau spine ${height} m`);
  });
  const inlets: Capsule[] = [];
  inletBearings.forEach((b, i) => {
    const a = (b / BEARINGS) * Math.PI * 2;
    const turn = (random() - 0.5) * 0.5;
    const ux = Math.cos(a), uz = Math.sin(a);
    const dx = Math.cos(a + turn), dz = Math.sin(a + turn);
    const R = o.radius[b]!;
    // never deeper than a third of the land along this bearing (a sound, not a strait cutting the land in two)
    const depth = Math.min(W * (0.15 + random() * 0.13), R * 0.5);
    const mouth = W * (0.055 + random() * 0.035);
    const head = W * (0.022 + random() * 0.015);
    const mx = o.cx + ux * (R + W * 0.06), mz = o.cz + uz * (R + W * 0.06);
    const hx = o.cx + ux * R - dx * depth, hz = o.cz + uz * R - dz * depth;
    inlets.push([...rel(mx, mz), ...rel(hx, hz), round(mouth), round(head)]);
    lines.push(`inlet-${i + 1}: bearing ${Math.round((b * 360) / BEARINGS)} deg (low coast: ${Math.round(o.inland[b]!)} m behind it), ${Math.round(depth)} m deep (${Math.round((depth / W) * 100)} %), mouth ${Math.round(mouth * 2)} m`);
  });
  // islets: off each cape tip (a stack / skerry trail) and off the highest stretch of coast
  const nIslets = 2 + Math.floor(random() * 2.5);
  const spots: { x: number; z: number; dx: number; dz: number; gap: number }[] = [];
  for (const t of tips) spots.push({ x: t.x, z: t.z, dx: t.dx, dz: t.dz, gap: t.hw });
  const high = pick(BEARINGS, (b) => inl[b]! + jitter[(b * 13) % BEARINGS]! * 0.5, () => true).filter((b) => capeBearings.every((c) => angDist(c, b) >= 30) && inletBearings.every((c) => angDist(c, b) >= 30));
  for (const b of high.filter((b, i, all) => all.slice(0, i).every((c) => angDist(c, b) >= 25)).slice(0, 3)) {
    const a = (b / BEARINGS) * Math.PI * 2;
    spots.push({ x: o.cx + Math.cos(a) * o.radius[b]!, z: o.cz + Math.sin(a) * o.radius[b]!, dx: Math.cos(a), dz: Math.sin(a), gap: 0 });
  }
  for (let k = 0; k < spots.length && islets.length < nIslets; k++) {
    const s = spots[k]!;
    const want = 35 + random() * 70; // land radius at the shoreline
    const falloff = 90;
    const band = falloff * 0.42;
    const off = s.gap + want + 90 + random() * 160;
    const side = (random() - 0.5) * 0.7;
    const x = s.x + (s.dx * Math.cos(side) - s.dz * Math.sin(side)) * off;
    const z = s.z + (s.dz * Math.cos(side) + s.dx * Math.sin(side)) * off;
    // a trail of stacks, not a clump: islets keep 300 m apart
    if (islets.some((c) => Math.hypot(c.center[0] - x, c.center[1] - z) < 300)) continue;
    islets.push({
      center: [round(x), round(z)],
      radius: round(Math.max(8, want - band)),
      falloff,
      warp: Math.min(0.3, template.warp),
      warpScale: 160,
      coastVariation: 0,
      coastVariationScale: 400,
      lobes: [],
      lobeBlend: 0,
      capes: [],
      inlets: [],
      shapeBlend: 0,
    });
  }
  if (islets.length) lines.push(`islets: ${islets.map((c) => `[${Math.round(c.center[0])}, ${Math.round(c.center[1])}] r${Math.round(c.radius + c.falloff * 0.42)}`).join(", ")}`);
  return { capes, inlets, islets, ridges, lines };
}

// ---------------------------------------------------------------- the rule

export interface ShapeReport {
  widthM: number;
  solidity: number;
  peninsulas: number[];
  bays: number[];
  islets: number;
  /** rotation-invariant outline descriptor */
  descriptor: number[];
}

/** Distance transform (8-neighbour chamfer, metres per cell = 1) from the cells where `seed` is 1. */
function chamfer(seed: Uint8Array, nx: number, nz: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(nx * nz);
  for (let i = 0; i < d.length; i++) d[i] = seed[i] ? 0 : INF;
  const D = Math.SQRT2;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const i = x + z * nx;
    let v = d[i]!;
    if (x > 0) v = Math.min(v, d[i - 1]! + 1);
    if (z > 0) {
      v = Math.min(v, d[i - nx]! + 1);
      if (x > 0) v = Math.min(v, d[i - nx - 1]! + D);
      if (x < nx - 1) v = Math.min(v, d[i - nx + 1]! + D);
    }
    d[i] = v;
  }
  for (let z = nz - 1; z >= 0; z--) for (let x = nx - 1; x >= 0; x--) {
    const i = x + z * nx;
    let v = d[i]!;
    if (x < nx - 1) v = Math.min(v, d[i + 1]! + 1);
    if (z < nz - 1) {
      v = Math.min(v, d[i + nx]! + 1);
      if (x < nx - 1) v = Math.min(v, d[i + nx + 1]! + D);
      if (x > 0) v = Math.min(v, d[i + nx - 1]! + D);
    }
    d[i] = v;
  }
  return d;
}

function components(mask: Uint8Array, nx: number, nz: number): number[][] {
  const seen = new Uint8Array(mask.length);
  const out: number[][] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const x = c % nx, z = (c / nx) | 0;
      if (x > 0 && mask[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (x < nx - 1 && mask[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (z > 0 && mask[c - nx] && !seen[c - nx]) { seen[c - nx] = 1; stack.push(c - nx); }
      if (z < nz - 1 && mask[c + nx] && !seen[c + nx]) { seen[c + nx] = 1; stack.push(c + nx); }
    }
    out.push(comp);
  }
  return out;
}

function hull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

/**
 * Measure a land mask (1 = land) on an nx x nz grid: the largest landmass's solidity, its peninsulas (reach, as a
 * share of the width) and bays (depth share), the islet count, and the outline descriptor. Pure, so the tests run it on
 * drawn masks.
 */
export function measureShapeMask(land: Uint8Array, nx: number, nz: number): ShapeReport {
  const comps = components(land, nx, nz).sort((a, b) => b.length - a.length);
  const main = comps[0] ?? [];
  const islets = comps.slice(1).filter((c) => c.length >= 2).length;
  const L = new Uint8Array(nx * nz);
  let x0 = nx, x1 = 0, z0 = nz, z1 = 0;
  for (const c of main) { L[c] = 1; const x = c % nx, z = (c / nx) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const W = Math.max(1, Math.max(x1 - x0, z1 - z0) + 1);
  if (main.length < 10) return { widthM: W, solidity: 1, peninsulas: [], bays: [], islets, descriptor: [] };
  // convex hull (of the cell corners' centres) rasterised
  const edge: [number, number][] = [];
  for (const c of main) {
    const x = c % nx, z = (c / nx) | 0;
    if (x === 0 || z === 0 || x === nx - 1 || z === nz - 1 || !L[c - 1] || !L[c + 1] || !L[c - nx] || !L[c + nx]) edge.push([x, z]);
  }
  const H = hull(edge);
  const inHull = new Uint8Array(nx * nz);
  let hullCells = 0;
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    let inside = true;
    for (let i = 0; i < H.length && inside; i++) {
      const a = H[i]!, b = H[(i + 1) % H.length]!;
      if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < -0.5) inside = false;
    }
    if (inside || L[x + z * nx]) { inHull[x + z * nx] = 1; hullCells++; }
  }
  const solidity = main.length / Math.max(1, hullCells);
  // peninsulas: land outside the opening by a disc of 0.09 W, reaching >= PENINSULA_REACH W from the opened body
  const notL = new Uint8Array(nx * nz);
  for (let i = 0; i < notL.length; i++) notL[i] = L[i] ? 0 : 1;
  const dIn = chamfer(notL, nx, nz);
  const r = W * 0.09;
  const eroded = new Uint8Array(nx * nz);
  for (let i = 0; i < eroded.length; i++) eroded[i] = L[i] && dIn[i]! > r ? 1 : 0;
  const dEr = chamfer(eroded, nx, nz);
  const opened = new Uint8Array(nx * nz);
  for (let i = 0; i < opened.length; i++) opened[i] = L[i] && dEr[i]! <= r ? 1 : 0;
  const dOp = chamfer(opened, nx, nz);
  const rest = new Uint8Array(nx * nz);
  for (let i = 0; i < rest.length; i++) rest[i] = L[i] && !opened[i] ? 1 : 0;
  const peninsulas: number[] = [];
  for (const c of components(rest, nx, nz)) {
    let reach = 0;
    for (const i of c) reach = Math.max(reach, dOp[i]!);
    if (reach / W >= PENINSULA_REACH) peninsulas.push(Math.round((reach / W) * 100) / 100);
  }
  // bays: sea inside the hull, depth = distance to the hull's outside
  const outHull = new Uint8Array(nx * nz);
  for (let i = 0; i < outHull.length; i++) outHull[i] = inHull[i] ? 0 : 1;
  const dHull = chamfer(outHull, nx, nz);
  const water = new Uint8Array(nx * nz);
  for (let i = 0; i < water.length; i++) water[i] = inHull[i] && !L[i] ? 1 : 0;
  const bays: number[] = [];
  for (const c of components(water, nx, nz)) {
    let depth = 0;
    for (const i of c) depth = Math.max(depth, dHull[i]!);
    if (depth / W >= BAY_DEPTH) bays.push(Math.round((depth / W) * 100) / 100);
  }
  // descriptor: radial profile from the centroid (outermost land per bearing), Fourier magnitudes 1..8 / mean
  let mx = 0, mz = 0;
  for (const c of main) { mx += c % nx; mz += (c / nx) | 0; }
  mx /= main.length; mz /= main.length;
  const N = 64;
  const prof: number[] = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    let last = 0;
    for (let t = 0; t < W * 1.5; t += 0.5) {
      const x = Math.round(mx + Math.cos(a) * t), z = Math.round(mz + Math.sin(a) * t);
      if (x < 0 || z < 0 || x >= nx || z >= nz) break;
      if (L[x + z * nx]) last = t;
    }
    prof.push(last);
  }
  const mean = prof.reduce((a, b) => a + b, 0) / N || 1;
  const descriptor: number[] = [];
  for (let h = 1; h <= 8; h++) {
    let re = 0, im = 0;
    for (let k = 0; k < N; k++) { re += (prof[k]! / mean) * Math.cos((2 * Math.PI * h * k) / N); im += (prof[k]! / mean) * Math.sin((2 * Math.PI * h * k) / N); }
    descriptor.push(Math.round((Math.hypot(re, im) / N) * 1000) / 1000);
  }
  return { widthM: W, solidity: Math.round(solidity * 100) / 100, peninsulas, bays, islets, descriptor };
}

/** The world's land mask on a grid (cells `step` m) and its measured shape. */
export function measureShape(recipe: WorldRecipe, field: WorldField, step = 25): ShapeReport {
  const limit = Math.min(recipe.bounds?.limit ?? 3000, field.worldLimit === Infinity ? 3000 : field.worldLimit);
  const n = Math.ceil((limit * 2) / step);
  const land = new Uint8Array(n * n);
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const wx = -limit + (x + 0.5) * step, wz = -limit + (z + 0.5) * step;
    if (field.height(wx, wz) > recipe.seaLevel + 0.5) land[x + z * n] = 1;
  }
  const r = measureShapeMask(land, n, n);
  return { ...r, widthM: r.widthM * step };
}

export function descriptorDistance(a: readonly number[], b: readonly number[]): number {
  if (!a.length || !b.length) return 0;
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += (a[i]! - b[i]!) ** 2;
  return Math.round(Math.sqrt(s) * 1000) / 1000;
}

/** The shape rule's findings for one seed (`nearest` = descriptor distance to the most similar other seed, or null). */
export function shapeFindings(r: ShapeReport, nearest: number | null): string[] {
  const out: string[] = [];
  if (r.solidity > SOLIDITY_MAX) out.push(`solidity ${r.solidity} > ${SOLIDITY_MAX}: the outline is a rounded blob`);
  if (r.peninsulas.length < 1) out.push(`no peninsula reaching ${PENINSULA_REACH * 100} % of the width`);
  if (r.bays.length < 1) out.push(`no bay ${BAY_DEPTH * 100} % of the width deep`);
  if (nearest !== null && nearest < DESCRIPTOR_MIN) out.push(`outline like another seed's (descriptor distance ${nearest} < ${DESCRIPTOR_MIN})`);
  return out;
}

export function describeShape(r: ShapeReport): string {
  return `shape solidity ${r.solidity}, peninsulas ${r.peninsulas.length}${r.peninsulas.length ? ` (${r.peninsulas.join("/")})` : ""}, bays ${r.bays.length}${r.bays.length ? ` (${r.bays.join("/")})` : ""}, islets ${r.islets}`;
}
