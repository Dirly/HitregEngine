/**
 * CONCEPT ON SITE — the pure part of `zonegen concept` (tools/zonegen/commands/concept.mts): what the bare site
 * measures (face, apron, relief, water), where the two cameras stand (first sight on the approach road at player
 * height; a far view from at least the read distance) and the repaint prompt that keeps the ground fixed.
 * No fs, no browser: the command does the IO, test/concept-site.test.ts drives these on a synthetic ground.
 */
import { READ_PX_MIN, readPixels } from "./_place-quality.mts";

type V2 = [number, number];
type V3 = [number, number, number];
export interface Ground { height(x: number, z: number): number; waterY?(x: number, z: number): number | null }

/** Read distance per size tier (the place builder's READ_BY_TIER, owner ruling 2026-10-19); a dungeon entrance
 *  reads from 300 m whatever its tier (grand-entrance: "reads from 300 m+"). */
export const READ_M = { pinpoint: 60, small: 150, medium: 300, large: 450 } as const;
export const ENTRANCE_READ_M = 300;
export function readDistance(size: string | undefined, entrance: boolean): number {
  const r = READ_M[(size ?? "medium") as keyof typeof READ_M] ?? 300;
  return entrance ? Math.max(r, ENTRANCE_READ_M) : r;
}
/** Player eye height (m) for the approach view. */
export const EYE_M = 1.7;
/** A slope steeper than this (rise over run) counts as rock face; at or under APRON_SLOPE as standable apron. */
export const FACE_SLOPE = 1.0, APRON_SLOPE = 0.25;

const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const r1 = (v: number) => Math.round(v * 10) / 10;
const wet = (g: Ground, x: number, z: number) => { const w = g.waterY?.(x, z); return w !== null && w !== undefined && w > g.height(x, z) + 0.2; };

export interface Face { height: number; bearing: number; foot: V2; top: V2; footY: number; topY: number; from: number }
export interface SiteFit {
  groundY: number;
  /** max - min ground inside the reservation radius */
  relief: number;
  /** the tallest continuous run steeper than 45 deg inside the terrain radius, and the tallest inside the radius */
  face: Face | null;
  faceAtPlace: Face | null;
  /** connected standable ground (slope <= APRON_SLOPE, dry) round the centre, inside the radius, m2 */
  apronM2: number;
  water: { atCentre: number | null; nearest: { at: V2; y: number; from: number } | null };
}

/** The tallest steep rise along 32 rays from the centre, out to `reach` (2 m steps). */
function tallestFace(g: Ground, c: V2, reach: number): Face | null {
  let best: Face | null = null;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2, dx = Math.sin(a), dz = -Math.cos(a); // bearing 0 = north (-Z), 90 = east (+X)
    let run: { foot: V2; footY: number; from: number; sign: number } | null = null;
    let prev = g.height(c[0], c[1]);
    for (let s = 2; s <= reach; s += 2) {
      const p: V2 = [c[0] + dx * s, c[1] + dz * s], h = g.height(p[0], p[1]), dh = h - prev, sign = Math.sign(dh);
      if (Math.abs(dh) / 2 > FACE_SLOPE && (!run || run.sign === sign)) {
        run ??= { foot: [c[0] + dx * (s - 2), c[1] + dz * (s - 2)], footY: prev, from: s - 2, sign };
        const height = Math.abs(h - run.footY);
        if (!best || height > best.height) {
          const up = sign > 0;
          best = { height: r1(height), bearing: Math.round((k / 32) * 360), foot: up ? run.foot : p, top: up ? p : run.foot, footY: r1(up ? run.footY : h), topY: r1(up ? h : run.footY), from: run.from };
        }
      } else run = null;
      prev = h;
    }
  }
  return best;
}

export function measureSite(g: Ground, c: V2, radius: number, terrainRadius: number): SiteFit {
  const groundY = g.height(c[0], c[1]);
  let lo = Infinity, hi = -Infinity;
  const step = Math.max(2, Math.round(radius / 60));
  for (let x = -radius; x <= radius; x += step) for (let z = -radius; z <= radius; z += step) {
    if (x * x + z * z > radius * radius) continue;
    const h = g.height(c[0] + x, c[1] + z); lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  // apron: flood from the flattest dry cell within 10 m of the centre through standable cells (2 m grid)
  const G = 2, n = Math.ceil(radius / G), side = 2 * n + 1, seen = new Uint8Array(side * side);
  const slopeAt = (x: number, z: number) => { const hx = (g.height(x + 1, z) - g.height(x - 1, z)) / 2, hz = (g.height(x, z + 1) - g.height(x, z - 1)) / 2; return Math.hypot(hx, hz); };
  const ok = (i: number, j: number) => { const x = c[0] + (i - n) * G, z = c[1] + (j - n) * G; return (i - n) ** 2 + (j - n) ** 2 <= n * n && slopeAt(x, z) <= APRON_SLOPE && !wet(g, x, z); };
  let seed: [number, number] | null = null, seedSlope = Infinity;
  for (let i = n - 5; i <= n + 5; i++) for (let j = n - 5; j <= n + 5; j++) {
    if (i < 0 || j < 0 || i >= side || j >= side || !ok(i, j)) continue;
    const s = slopeAt(c[0] + (i - n) * G, c[1] + (j - n) * G); if (s < seedSlope) { seedSlope = s; seed = [i, j]; }
  }
  let cells = 0;
  if (seed) {
    const q: [number, number][] = [seed]; seen[seed[1] * side + seed[0]] = 1;
    while (q.length) {
      const [i, j] = q.pop()!; cells++;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= side || b >= side || seen[b * side + a]) continue;
        seen[b * side + a] = 1; if (ok(a, b)) q.push([a, b]);
      }
    }
  }
  let nearest: SiteFit["water"]["nearest"] = null;
  if (g.waterY) for (let s = 0; s <= terrainRadius && !nearest; s += 4) for (let k = 0; k < Math.max(1, Math.round(s / 4)); k++) {
    const a = (k / Math.max(1, Math.round(s / 4))) * Math.PI * 2, p: V2 = [c[0] + Math.sin(a) * s, c[1] - Math.cos(a) * s];
    if (wet(g, p[0], p[1])) { nearest = { at: [Math.round(p[0]), Math.round(p[1])], y: r1(g.waterY(p[0], p[1])!), from: s }; break; }
  }
  const atCentre = g.waterY?.(c[0], c[1]) ?? null;
  return {
    groundY: r1(groundY), relief: r1(hi - lo), face: tallestFace(g, c, terrainRadius), faceAtPlace: tallestFace(g, c, radius),
    apronM2: cells * G * G, water: { atCentre: atCentre === null ? null : r1(atCentre), nearest },
  };
}

/** Points every `step` m along a polyline, with the arc length from its start. */
export function along(points: V2[], step = 5): { p: V2; s: number }[] {
  const out: { p: V2; s: number }[] = [];
  let s = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!, b = points[i + 1]!, L = dist(a, b);
    for (let t = i === 0 ? 0 : step - (s % step); t < L; t += step) out.push({ p: [a[0] + ((b[0] - a[0]) * t) / L, a[1] + ((b[1] - a[1]) * t) / L], s: s + t });
    s += L;
  }
  if (points.length) out.push({ p: points[points.length - 1]!, s });
  return out;
}

export interface View { name: "approach" | "far"; eye: V3; target: V3; from: number; px: number; visible: number; note: string }

/**
 * The approach view: walking IN along the road(s) the reservation is reached from (each road walked both ways from
 * where it comes nearest the site, then the planned approach points), the first point at player height from which a
 * `height` m mark at the centre shows at least READ_PX_MIN px — the farthest such point within 1.25 x the read
 * distance. When none does, the best-seen point (note says so).
 */
export function approachView(g: Ground, c: V2, height: number, read: number, roads: V2[][], approach: V2[]): View {
  const foot = g.height(c[0], c[1]), top = foot + height;
  const cand: V2[] = [];
  for (const r of roads) {
    if (r.length < 2) continue;
    let k = 0;
    r.forEach((p, i) => { if (dist(p, c) < dist(r[k]!, c)) k = i; });
    for (const leg of [r.slice(0, k + 1).reverse(), r.slice(k)]) for (const { p, s } of along(leg, 5)) if (s <= read * 1.5) cand.push(p);
  }
  for (const { p } of along(approach.length ? approach : [], 5)) cand.push(p);
  const target: V3 = [c[0], foot + height * 0.4, c[1]];
  let first: View | null = null, best: View | null = null;
  for (const p of cand) {
    const d = dist(p, c);
    if (d > read * 1.25 || d < 10 || wet(g, p[0], p[1])) continue;
    const eye: V3 = [p[0], g.height(p[0], p[1]) + EYE_M, p[1]];
    const r = readPixels(g, eye, { at: c, foot, top });
    const v: View = { name: "approach", eye, target, from: Math.round(d), px: r.px, visible: r.visible, note: "" };
    if (r.px >= READ_PX_MIN && (!first || d > first.from)) first = v;
    if (!best || r.px > best.px) best = v;
  }
  if (first) return { ...first, note: `first sight on the approach (${first.px} px of a ${height} m mark)` };
  if (best) return { ...best, note: `NEVER SEEN from the approach at ${READ_PX_MIN} px: best point ${best.px} px` };
  // no road at all: stand 0.75 x read out on the side the far view does not take (south)
  const p: V2 = [c[0], c[1] + read * 0.75];
  return { name: "approach", eye: [p[0], g.height(p[0], p[1]) + EYE_M, p[1]], target, from: Math.round(read * 0.75), px: 0, visible: 0, note: "no approach road or points: a stand-in view from the south" };
}

/**
 * The far view: from [read, 1.15 read] on 36 bearings, the dry spot that shows most of a `height` m mark at player
 * height, ties to the side nearest `prefer` (the approach). Raised 10 m at a time (to 60 m) when nothing shows 3 m.
 */
export function farView(g: Ground, c: V2, height: number, read: number, prefer: V2 | null): View {
  const foot = g.height(c[0], c[1]), top = foot + height, target: V3 = [c[0], foot + height * 0.4, c[1]];
  for (let lift = EYE_M; lift <= 60; lift = lift === EYE_M ? 10 : lift + 10) {
    let best: (View & { score: number }) | null = null;
    for (let k = 0; k < 36; k++) for (const f of [1, 1.07, 1.15]) {
      const a = (k / 36) * Math.PI * 2, d = read * f, p: V2 = [c[0] + Math.sin(a) * d, c[1] - Math.cos(a) * d];
      if (wet(g, p[0], p[1])) continue;
      const eye: V3 = [p[0], g.height(p[0], p[1]) + lift, p[1]], r = readPixels(g, eye, { at: c, foot, top });
      const near = prefer ? 1 - dist(p, prefer) / (2 * d + 1) : 0;
      const score = r.visible + near * 2;
      if (!best || score > best.score) best = { name: "far", eye, target, from: Math.round(d), px: r.px, visible: r.visible, note: "", score };
    }
    if (best && best.visible >= 3) { const { score: _s, ...v } = best; return { ...v, note: lift === EYE_M ? `best read from ${v.from} m at player height` : `RAISED ${lift} m: nothing shows 3 m at player height from ${Math.round(read)} m` }; }
    if (lift >= 60 && best) { const { score: _s, ...v } = best; return { ...v, note: `HIDDEN: under 3 m shows from ${Math.round(read)} m even raised 60 m` }; }
  }
  throw new Error("unreachable");
}

export interface PromptText { name: string; premise: string; read?: string; landmark?: string; setPiece?: string; mood?: string; needs?: string[]; zoneTone?: string; zoneMood?: string; style?: string }

/** The shared repaint brief: the ground is fixed, only the built place is added; then the place and the style. */
export function conceptBrief(t: PromptText, fit: SiteFit, height: number): string {
  const face = fit.face ? `${fit.face.height} m (bearing ${fit.face.bearing} deg, ${fit.face.from} m from the centre)` : "none";
  return [
    `Each attached image is an IN-GAME RENDER of the real, bare site where "${t.name}" will be built. The ground in it is FIXED and already built: keep the camera, the horizon line, every rock and cliff height, the water line and the slope of the land exactly as rendered. Do not raise, deepen, widen or add cliffs, hills, gorges, falls or water. Add ONLY the built place (structures, walls, paths, props, light, smoke) standing on this ground at a believable scale; vegetation may be thinned where the place clears it.`,
    `Measured ground (judge scale by it): the tallest rock face here is ${face}; the place's own ground has ${fit.relief} m of relief and ${fit.apronM2} m2 of standable apron; the tallest thing the place should show is about ${height} m. A structure taller than the face it stands on is wrong.`,
    `The place: ${t.premise}`,
    t.read ? `What draws a passer-by: ${t.read}` : "",
    t.landmark ? `Landmark: ${t.landmark}` : "",
    t.setPiece ? `Set piece: ${t.setPiece}` : "",
    t.needs?.length ? `It needs: ${t.needs.join("; ")}.` : "",
    t.mood ? `Place mood: ${t.mood}` : "",
    t.zoneTone ? `Zone tone: ${t.zoneTone}` : "",
    t.zoneMood ? `Zone air and light: ${t.zoneMood}` : "",
    t.style ?? "Style: dark high fantasy concept painting for a classic-MMO world built of very simple geometry with texture-led PSX-era surfaces: big readable silhouettes, painted stone, timber and rock textures carrying the detail, no fine modelled ornament; foreboding, colour by tone not by darkness, readable.",
    "No text, no letters, no labels, no UI, no border, no watermark. No people or creatures in the foreground.",
  ].filter(Boolean).join("\n\n");
}
