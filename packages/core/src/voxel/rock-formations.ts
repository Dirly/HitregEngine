import type { WorldField } from "./field.js";
import { createVolume, encodeHeightfieldValues, type VolumeDoc } from "./csg.js";

/**
 * ROCK FORMATIONS — faceted bedrock masses for a waterfall site, generated.
 *
 * A marching-cubes gorge is smooth by construction: it can carve a cascade's
 * bowls and benches but never an EDGE, and scattering rock props over the
 * walls only reads as "a field of rocks on a slope". Real cascades pour
 * between rock shoulders, past buttresses, into pools rimmed by bedrock
 * blocks. This module reads a solved fall site (its tiers, its channel, the
 * ground either side) and writes those masses as ONE dual-contoured volume
 * document, so the edges stay edges and the whole set is a single draw.
 *
 * Nothing here is hand-placed; everything is a function of the field and a
 * seed hashed from the site id, so regenerating after the gorge changes is
 * one command, not an agent session:
 *
 * - WHERE: a shoulder either side of every curtain (the headwall the water
 *   pours between), buttresses along both walls at a jittered spacing, a
 *   second, higher outcrop where a wall is tall, and low bedrock blocks at the
 *   pools' waterline. Each mass is sunk into the wall it stands on (its centre
 *   at the ground surface, so its back half is buried in the terrain) and its
 *   top is capped at the ground behind it plus `rimAllowance`, so nothing
 *   stands proud of the natural rim.
 * - SHAPE: a few blended "orbs" (ellipsoids plus a rounded box core, smooth
 *   union) with bounded noise for lumps, then PLANES cut through them —
 *   a leaning front face, a bedding-tilted top, oblique corner facets, and
 *   step-backs at site-wide strata levels so ledges line up from mass to mass.
 *   Dual contouring solves where those planes meet, which is the whole point.
 * - WATER: the last node subtracts a keep-out prism along the channel — the
 *   measured water width either side plus `margin`, full height — so no mass
 *   can reach into a channel, a curtain or over a pool; where a mass meets it
 *   the cut leaves a clean vertical rock face at the water's edge.
 * - SURFACE: the palette IS the world's surface list (the same splat layers
 *   the terrain material draws), rock on every face, and per-mass paint
 *   strokes put the rim's own ground cover (grass over dirt, sampled from the
 *   field) on the upward faces. `tint` carries the biome tint the terrain has
 *   there, so the volume and the ground it is fused with match.
 */

export interface RockFormationSite {
  /** Site id (seeds the generator). */
  id: string;
  /** The site's course through the tiers (a fall site doc's `course`); picks which falls belong to it. */
  course?: readonly (readonly [number, number])[];
  /** Fallback anchor when there is no course. */
  at?: readonly [number, number];
  /** Restrict to this river's falls. */
  river?: string;
}

export interface RockFormationOptions {
  /** Extra seed mixed into the site-id hash. */
  seed?: number;
  /** Volume lattice spacing, metres. */
  voxelSize?: number;
  /** Clearance (m) past the measured water edge that no rock may enter. */
  margin?: number;
  /** Mean spacing (m) of wall buttresses along each side. */
  spacing?: number;
  /** Scales every mass. */
  scale?: number;
  /** How far (m) a mass may stand above the ground behind it. */
  rimAllowance?: number;
  /** Split into several documents when one would exceed this many lattice samples. */
  maxSamples?: number;
  /** Volume name prefix. */
  name?: string;
  /** World surface (by name) for the formations' faces; default "rock", the terrain's own slope rock, so a mass reads as part of the wall. */
  wallSurface?: string;
  /** Surface (by name) brushed faintly onto some front faces for variation; default "cliff" when the world has it. "" for none. */
  accentSurface?: string;
  /** Trim the parts buried in the terrain (default true). Off for callers that only need the solid, e.g. scree support. */
  trim?: boolean;
  /**
   * The ground the trim is measured from: the top of the terrain AS MESHED at (x, z)
   * (fall-site-rocks' `meshDensity(...).down`). Defaults to `field.height`, which on steep
   * ground is up to a lattice cell off the marching-cubes surface — a trim cut from it can end
   * ABOVE the real ground and leave the cut face showing as a hole under the rock. The bake passes it.
   */
  groundAt?: (x: number, z: number) => number;
}

export interface RockMass {
  kind: "shoulder" | "buttress" | "outcrop" | "block";
  tier: number;
  side: -1 | 1;
  center: [number, number, number];
  /** Along the wall, height, depth (out of the wall). */
  size: [number, number, number];
  /** Unit horizontal direction the mass faces (out of the wall). */
  front: [number, number];
}

export interface RockFormationResult {
  river: string;
  tiers: number;
  masses: RockMass[];
  /** One document normally; several when the lattice budget forces a split (by tier). */
  docs: VolumeDoc[];
}

type V3 = [number, number, number];

function hashString(text: string, seed: number): number {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** mulberry32: small, seeded, identical in every host. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Euler XYZ (the CSG node convention, R = Rz·Ry·Rx) of the rotation whose columns are ax, ay, az. */
function eulerFromBasis(ax: V3, ay: V3, az: V3): V3 {
  // R row-major: R[r][c] = column c's component r
  const r20 = ax[2], r21 = ay[2], r22 = az[2], r10 = ax[1], r00 = ax[0];
  const y = Math.asin(Math.max(-1, Math.min(1, -r20)));
  const x = Math.atan2(r21, r22);
  const z = Math.atan2(r10, r00);
  return [x, y, z];
}

function distanceToPolyline(pts: readonly (readonly [number, number])[], x: number, z: number): number {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k]!, [bx, bz] = pts[k + 1]!;
    const sx = bx - ax, sz = bz - az, l2 = sx * sx + sz * sz;
    const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / l2));
    best = Math.min(best, Math.hypot(x - ax - sx * t, z - az - sz * t));
  }
  if (pts.length === 1) best = Math.hypot(x - pts[0]![0], z - pts[0]![1]);
  return best;
}

interface Sample {
  s: number;
  x: number;
  z: number;
  /** Unit tangent (downstream). */
  tx: number;
  tz: number;
  level: number;
  /** Clearance from the centreline, per side (index 0 = left/+normal, 1 = right). */
  clear: [number, number];
  tier: number;
}

/** Generate the rock formations of one fall site as volume document(s). */
export function rockFormations(field: WorldField, site: RockFormationSite, opts: RockFormationOptions = {}): RockFormationResult {
  const voxelSize = opts.voxelSize ?? 1;
  const margin = opts.margin ?? 1.5;
  const spacing = opts.spacing ?? 8;
  const scale = opts.scale ?? 1;
  const rimAllowance = opts.rimAllowance ?? 0.8;
  const maxSamples = opts.maxSamples ?? 24e6;
  const rand = rng(hashString(site.id, opts.seed ?? 1));
  const between = (a: number, b: number) => a + (b - a) * rand();

  // ---- the site's tiers: falls on the course, the river owning most of them
  const anchor: (readonly [number, number])[] = site.course && site.course.length > 0 ? [...site.course] : site.at ? [site.at] : [];
  if (anchor.length === 0) throw new Error(`rockFormations: site "${site.id}" has no course or anchor`);
  const near = field.falls.filter((f) => (!site.river || f.river === site.river) && distanceToPolyline(anchor, f.x, f.z) <= 12);
  if (near.length === 0) throw new Error(`rockFormations: no falls near site "${site.id}"`);
  const tally = new Map<string, number>();
  for (const f of near) tally.set(f.river, (tally.get(f.river) ?? 0) + 1);
  const riverId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const falls = near.filter((f) => f.river === riverId).sort((a, b) => b.top - a.top);
  const river = field.rivers.find((r) => r.id === riverId);
  if (!river) throw new Error(`rockFormations: river "${riverId}" not in the field`);

  // centreline with arc length
  const P = river.points;
  const along: number[] = [0];
  for (let k = 1; k < P.length; k++) along.push(along[k - 1]! + Math.hypot(P[k]![0] - P[k - 1]![0], P[k]![1] - P[k - 1]![1]));
  const project = (x: number, z: number): number => {
    let best = Infinity, s = 0;
    for (let k = 0; k + 1 < P.length; k++) {
      const [ax, az] = P[k]!, [bx, bz] = P[k + 1]!;
      const sx = bx - ax, sz = bz - az, l2 = sx * sx + sz * sz;
      const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / l2));
      const d = Math.hypot(x - ax - sx * t, z - az - sz * t);
      if (d < best) { best = d; s = along[k]! + Math.sqrt(l2) * t; }
    }
    return s;
  };
  const pointAt = (s: number): { x: number; z: number; tx: number; tz: number } => {
    let k = 0;
    while (k < P.length - 2 && along[k + 1]! < s) k++;
    const [ax, az] = P[k]!, [bx, bz] = P[k + 1]!;
    const L = along[k + 1]! - along[k]! || 1;
    const t = Math.max(0, Math.min(1, (s - along[k]!) / L));
    return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx: (bx - ax) / L, tz: (bz - az) / L };
  };
  // Each fall's (x, z) is the river point at the FOOT of its lip segment; the lip is the point before it.
  const tiers = falls.map((f) => {
    const foot = project(f.x, f.z);
    let k = 0;
    let best = Infinity;
    for (let i = 0; i < P.length; i++) {
      const d = Math.hypot(P[i]![0] - f.x, P[i]![1] - f.z);
      if (d < best) { best = d; k = i; }
    }
    const lip = k > 0 ? along[k - 1]! : foot - 3;
    return { fall: f, lip, foot: along[k]! };
  });
  const last = tiers[tiers.length - 1]!;
  const s0 = tiers[0]!.lip - 10;
  const s1 = last.foot + 32;
  const tierAt = (s: number): number => {
    let t = -1;
    for (let i = 0; i < tiers.length; i++) if (s >= tiers[i]!.lip + 1.5) t = i;
    return t;
  };
  const levelAt = (s: number): number => {
    const t = tierAt(s);
    return t < 0 ? tiers[0]!.fall.top : tiers[t]!.fall.bottom;
  };

  // ---- sample the channel: water width each side, the level, the clearance
  const samples: Sample[] = [];
  for (let s = s0 - 6; s <= s1 + 6; s += 1) {
    const p = pointAt(s);
    const nx = -p.tz, nz = p.tx;
    const level = levelAt(s);
    const clear: [number, number] = [0, 0];
    const t = tierAt(s);
    const half = (t < 0 ? tiers[0]!.fall.width : tiers[t]!.fall.width) / 2;
    for (let side = 0; side < 2; side++) {
      const sg = side === 0 ? 1 : -1;
      let d = 0;
      for (; d < 30; d += 0.5) {
        const x = p.x + nx * sg * d, z = p.z + nz * sg * d;
        const w = field.waterY(x, z);
        if (w === null || field.height(x, z) > w + 0.05) break;
      }
      clear[side] = Math.max(half, d) + margin;
    }
    samples.push({ s, x: p.x, z: p.z, tx: p.tx, tz: p.tz, level, clear, tier: t });
  }
  // widen the clearance over ±5 m, never below the raw value: the cut face is not a sawtooth, and a
  // plunge bowl that flares past the lip (measured only on normals) is still inside the keep-out
  for (let side = 0; side < 2; side++) {
    const raw = samples.map((q) => q.clear[side]!);
    for (let i = 0; i < samples.length; i++) {
      let m = raw[i]!;
      for (let j = Math.max(0, i - 5); j <= Math.min(raw.length - 1, i + 5); j++) m = Math.max(m, raw[j]!);
      samples[i]!.clear[side] = m;
    }
  }
  const sampleAt = (s: number): Sample => samples[Math.max(0, Math.min(samples.length - 1, Math.round(s - samples[0]!.s)))]!;

  /** Ground heights out from the centreline on one side: toe and rim of the wall. */
  const wallProbe = (s: number, sg: 1 | -1) => {
    const q = sampleAt(s);
    const nx = -q.tz * sg, nz = q.tx * sg;
    const c = q.clear[sg > 0 ? 0 : 1]!;
    const hAt = (d: number) => field.height(q.x + nx * d, q.z + nz * d);
    let toe = c;
    while (toe < c + 30 && hAt(toe) < q.level + 1) toe += 0.5;
    // the rim: the highest ground within reach (benches pause the climb, they do not end it)
    let rim = toe;
    let rimH = hAt(toe);
    for (let d = toe; d <= toe + 35; d += 1) {
      const h = hAt(d);
      if (h > rimH + 0.3) { rimH = h; rim = d; }
    }
    return { q, nx, nz, clear: c, toe, rim, rimH, hAt };
  };

  // ---- place masses
  const masses: RockMass[] = [];
  /**
   * Seat a mass against the ground it stands on. (ax, az) is any point on the
   * line the mass sits on and (fx, fz) the way it faces (out of the wall, into
   * the open). Walking along that line from deep inside the wall, u(y) is where
   * the ground first drops below height y: the wall's face at that height.
   * The front goes where the face is at `foot` of the mass's height (a
   * quarter for a mass that rises from the water or a ledge: its foot is
   * buried in the lower ground, the rest stands proud of the slope; zero for
   * an outcrop high on a wall, so no underside hangs out over the slope),
   * and the back two metres behind where the face is at its TOP — so the top
   * always runs into the wall, never stands free of it. That depth is the
   * mass's depth, clamped; a gentle slope makes a deep block, a cliff a slab.
   */
  const seat = (ax: number, az: number, fx: number, fz: number, bottom: number, top: number, minDepth: number, maxDepth: number, foot = 0.25) => {
    const back0 = -30;
    const u = (y: number): number => {
      for (let t = back0; t < 40; t += 0.5) if (field.height(ax + fx * t, az + fz * t) < y) return t;
      return 40;
    };
    const H = top - bottom;
    const uFront = u(bottom + H * foot) + between(0.2, 1.2) * foot * 4;
    let uBack = u(top) - 2;
    if (uFront - uBack < minDepth) uBack = uFront - minDepth;
    if (uFront - uBack > maxDepth) uBack = uFront - maxDepth;
    const mid = (uFront + uBack) / 2;
    return { x: ax + fx * mid, z: az + fz * mid, depth: uFront - uBack };
  };
  const push = (kind: RockMass["kind"], tier: number, side: -1 | 1, x: number, z: number, bottom: number, top: number, L: number, D: number, fx: number, fz: number) =>
    masses.push({ kind, tier, side, center: [x, (top + bottom) / 2, z], size: [L, top - bottom, D], front: [fx, fz] });

  // shoulders: either side of every curtain, facing downstream off the headwall
  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti]!;
    const f = tier.fall;
    for (const sg of [1, -1] as const) {
      const q = sampleAt(tier.lip);
      const nx = -q.tz * sg, nz = q.tx * sg;
      const c = Math.max(q.clear[sg > 0 ? 0 : 1]!, sampleAt(tier.foot + 3).clear[sg > 0 ? 0 : 1]!);
      const wide = between(8, 13) * scale;
      // inner edge in the keep-out, so the cut makes the face the curtain pours past
      const lat = c + wide * between(0.3, 0.42);
      const rimH = wallProbe(tier.foot + 4, sg).rimH;
      const bottom = f.bottom - 1.5;
      const top = Math.min(f.top + between(1, 2.2), rimH) + rimAllowance * 0.5;
      if (top - bottom < 3) continue;
      const at = seat(q.x + nx * lat, q.z + nz * lat, q.tx, q.tz, bottom, top, 6 * scale, 14 * scale);
      push("shoulder", ti, sg, at.x, at.z, bottom, top, wide, at.depth, q.tx, q.tz);
      // a second, lower step of the shoulder further out on the headwall
      if (rand() < 0.75) {
        const lat2 = lat + wide * between(0.55, 0.8);
        const top2 = bottom + (top - bottom) * between(0.45, 0.75);
        const at2 = seat(q.x + nx * lat2, q.z + nz * lat2, q.tx, q.tz, bottom, top2, 5 * scale, 12 * scale);
        push("shoulder", ti, sg, at2.x, at2.z, bottom, top2, between(6, 10) * scale, at2.depth, q.tx, q.tz);
      }
    }
  }

  // wall buttresses, a higher outcrop on tall walls, waterline blocks at the pools
  const nearLip = (s: number, r: number) => tiers.some((t) => Math.abs(s - (t.lip + 1)) < r);
  for (const sg of [1, -1] as const) {
    let s = s0 + between(0, spacing);
    while (s < s1) {
      const step = spacing * between(0.7, 1.3) * scale;
      if (nearLip(s, 6 * scale)) { s += step * 0.5; continue; }
      const w = wallProbe(s, sg);
      const wallH = w.rimH - w.q.level;
      // faces the channel: back along the probe's outward normal
      const fx = -w.nx, fz = -w.nz;
      const ax = w.q.x + w.nx * w.toe, az = w.q.z + w.nz * w.toe;
      if (wallH >= 3) {
        const H = Math.max(5, Math.min(20, wallH * between(0.55, 0.95))) * scale;
        const bottom = w.q.level - 1;
        const top = Math.min(bottom + H, w.rimH + rimAllowance);
        if (top - bottom >= 3) {
          const at = seat(ax, az, fx, fz, bottom, top, 4 * scale, 14 * scale);
          push("buttress", w.q.tier, sg, at.x, at.z, bottom, top, between(7, 14) * scale, at.depth, fx, fz);
        }
        if (wallH > 12) {
          // a ledge band rather than a box: long along the wall, its foot run
          // well down into the slope so no underside shows
          const H2 = between(4, 7) * scale;
          const y2 = w.q.level + wallH * between(0.55, 0.8);
          const top2 = Math.min(y2 + H2 / 2, w.rimH + rimAllowance);
          const bot2 = y2 - H2;
          if (top2 - bot2 >= 3) {
            const s2 = s + step * between(0.3, 0.7);
            const w2 = wallProbe(s2, sg);
            const at2 = seat(w2.q.x + w2.nx * w2.toe, w2.q.z + w2.nz * w2.toe, -w2.nx, -w2.nz, bot2, top2, 4 * scale, 12 * scale, 0);
            push("outcrop", w2.q.tier, sg, at2.x, at2.z, bot2, top2, between(10, 17) * scale, at2.depth, -w2.nx, -w2.nz);
          }
        }
      }
      // low bedrock block at the pool's waterline, between buttresses
      if (w.q.tier >= 0 && rand() < 0.5) {
        const sb = s + step * between(0.35, 0.65);
        if (!nearLip(sb, 5 * scale) && sb < s1) {
          const wb = wallProbe(sb, sg);
          // on the bank, its water face ON the keep-out line (the cut makes it a clean face at the pool)
          const bottom = wb.q.level - 1.5;
          const top = Math.min(wb.q.level + between(2.5, 5), wb.rimH + rimAllowance);
          if (top - bottom >= 2.5) {
            const D = between(4, 7) * scale;
            const lat = wb.clear + D * between(0.3, 0.45);
            push("block", wb.q.tier, sg, wb.q.x + wb.nx * lat, wb.q.z + wb.nz * lat, bottom, top, between(5, 9) * scale, D, -wb.nx, -wb.nz);
          }
        }
      }
      s += step;
    }
  }

  // ---- surfaces: the world's own palette, rock faces, the rim's cover on top
  const names = field.recipe.surfaces.map((s) => s.name);
  const count = field.surfaceCount;
  const scratch = new Float32Array(count + 3);
  const acc = { wall: new Float64Array(count + 3), wallN: 0, rim: new Float64Array(count + 3), rimN: 0 };
  for (const m of masses) {
    const [x, , z] = m.center;
    const [fx, fz] = m.front;
    // the wall face just in front of the mass, and the flat ground behind the rim
    const wx = x + fx * m.size[2] * 0.5, wz = z + fz * m.size[2] * 0.5;
    field.surfaceAt(wx, field.height(wx, wz), wz, 0.5, scratch, 0);
    for (let i = 0; i < count + 3; i++) acc.wall[i]! += scratch[i]!;
    acc.wallN++;
    for (let back = 10; back <= 40; back += 10) {
      const rx = x - fx * back, rz = z - fz * back;
      if (field.slope(rx, rz) > 0.25) continue;
      field.surfaceAt(rx, field.height(rx, rz), rz, 0.98, scratch, 0);
      for (let i = 0; i < count + 3; i++) acc.rim[i]! += scratch[i]!;
      acc.rimN++;
      break;
    }
  }
  const avg = (a: Float64Array, n: number) => Array.from(a, (v) => v / Math.max(1, n));
  const wallAvg = avg(acc.wall, acc.wallN);
  const rimAvg = avg(acc.rim, acc.rimN);
  const ranked = (w: number[]) => w.slice(0, count).map((v, i) => [i, v] as const).sort((a, b) => b[1] - a[1]);
  const rockIndex = names.indexOf("rock") >= 0 ? names.indexOf("rock") : ranked(wallAvg)[0]![0];
  // faces: the terrain's own slope rock, so a mass reads as part of the wall
  // it is fused with (a contrasting cliff texture made every ledge read as a
  // separate box stuck on the wall); a faint accent brushes some fronts
  const wallName = opts.wallSurface ?? "rock";
  const accentName = opts.accentSurface ?? (names.includes("cliff") ? "cliff" : "");
  const accentIndex = accentName ? names.indexOf(accentName) : -1;
  const wallIndex = names.indexOf(wallName) >= 0 ? names.indexOf(wallName) : acc.wallN ? ranked(wallAvg)[0]![0] : rockIndex;
  const rimRank = ranked(rimAvg).filter(([i]) => i !== rockIndex && i !== names.indexOf("cliff"));
  const coverIndex = acc.rimN ? rimRank[0]![0] : Math.max(0, names.indexOf("grass"));
  const dirtIndex = names.indexOf("dirt") >= 0 ? names.indexOf("dirt") : acc.rimN && rimRank[1] ? rimRank[1][0] : coverIndex;
  const wallTint: V3 = acc.wallN ? [r3(wallAvg[count]!), r3(wallAvg[count + 1]!), r3(wallAvg[count + 2]!)] : [1, 1, 1];
  const coverTint: V3 = acc.rimN ? [r3(rimAvg[count]!), r3(rimAvg[count + 1]!), r3(rimAvg[count + 2]!)] : wallTint;

  // ---- shapes
  // site-wide bedding: one gentle dip shared by every mass, and strata levels
  // that are WORLD heights, so ledges run on from one mass to the next
  const dipAz = rand() * Math.PI * 2;
  const dip = between(0.04, 0.12);
  const bedUp = norm([Math.sin(dip) * Math.cos(dipAz), Math.cos(dip), Math.sin(dip) * Math.sin(dipAz)]);
  const strataStep = between(2.6, 3.6);
  const strataBase = rand() * strataStep;

  type Node = Record<string, unknown>;
  const massNodes = (m: RockMass, index: number): { nodes: Node[]; paint: Record<string, unknown>[] } => {
    const nodes: Node[] = [];
    const [L, H, D] = m.size;
    const C = m.center;
    const f: V3 = norm([m.front[0], 0, m.front[1]]);
    const up: V3 = [0, 1, 0];
    const ax: V3 = norm(cross(up, f)); // along the wall
    const yaw = Math.atan2(f[0], f[2]);
    const minDim = Math.min(L, H, D);
    const at = (lx: number, ly: number, lz: number): V3 => [C[0] + ax[0] * lx + f[0] * lz, C[1] + ly, C[2] + ax[2] * lx + f[2] * lz];
    const id = `m${index}`;
    const noise = { amount: r3(Math.min(0.8, 0.09 * minDim + 0.15)), scale: r3(Math.max(1.8, 0.4 * minDim)), seed: Math.floor(rand() * 1e6) };
    // Blocks, not orbs, underneath: the core and the satellite columns have VERTICAL sides and run
    // down into the ground under their own footprint (the trim then clips them 1.5 m under it), so
    // nothing has an underside hanging over the gorge. Measured: rounded (ellipsoid) bottoms were
    // every overhang the support check found, up to 3 m out over a pool. The lumpy ellipsoid rides
    // on top and within the core's plan.
    const ground = opts.groundAt ?? ((x: number, z: number) => field.height(x, z));
    const footGround = (lx: number, lz: number, w: number, d: number, spin: number) => {
      let g = Infinity;
      const cs = Math.cos(spin), sn = Math.sin(spin);
      for (const [u, v] of [[0, 0], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5], [0, -0.5], [0, 0.5], [-0.5, 0], [0.5, 0]] as const) {
        const ox = u * w * cs + v * d * sn, oz = -u * w * sn + v * d * cs;
        const q = at(lx + ox, 0, lz + oz);
        g = Math.min(g, ground(q[0], q[2]));
      }
      return g - 1.5;
    };
    nodes.push({ id: `${id}-orb`, op: "add", shape: "ellipsoid", position: at(0, H * 0.05, -D * 0.03).map(r3), rotation: [r3(between(-0.06, 0.06)), r3(yaw), r3(between(-0.06, 0.06))], size: [r3(L * 0.9), r3(H), r3(D * 0.9)], blend: r3(minDim * 0.2), noise });
    {
      const w = L * between(0.82, 0.95), d = D * 0.95, spin = between(-0.2, 0.2);
      const lx = between(-0.06, 0.06) * L, lz = between(-0.04, 0.02) * D;
      const top = C[1] + H * 0.475, bottom = Math.min(C[1] - H / 2, footGround(lx, lz, w, d, spin));
      const q = at(lx, 0, lz);
      nodes.push({ id: `${id}-core`, op: "add", shape: "box", position: [r3(q[0]), r3((top + bottom) / 2), r3(q[2])], rotation: [0, r3(yaw + spin), 0], size: [r3(w), r3(top - bottom), r3(d)], round: r3(minDim * 0.12), blend: r3(minDim * 0.2) });
    }
    const sats = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < sats; i++) {
      // a jointed column beside the core, from the ground to a varied height
      const w = L * between(0.3, 0.5), d = D * between(0.5, 0.85), spin = between(-0.4, 0.4);
      const lx = (rand() < 0.5 ? -1 : 1) * between(0.28, 0.45) * L, lz = between(-0.2, 0.05) * D;
      const top = C[1] + (H / 2) * between(-0.1, 0.75), bottom = Math.min(C[1] - H / 2, footGround(lx, lz, w, d, spin));
      if (top - bottom < 1.5) continue;
      const q = at(lx, 0, lz);
      nodes.push({ id: `${id}-sat${i}`, op: "add", shape: "box", position: [r3(q[0]), r3((top + bottom) / 2), r3(q[2])], rotation: [0, r3(yaw + spin), 0], size: [r3(w), r3(top - bottom), r3(d)], round: r3(Math.min(w, d) * 0.18), blend: r3(minDim * 0.25) });
    }
    // a planar cut: everything past the plane (normal n through point p) goes, within the mass's reach
    const reach = Math.max(L, H, D) * 1.15;
    /**
     * A planar cut: everything of THIS mass past the plane (normal n through
     * p) goes. The box is sized to the mass's own extent in the plane's frame
     * — just past its far side along n, just past its width across — because
     * a sub node carves everything before it, and an oversized box would
     * erase the neighbours this mass is fused with.
     */
    const cut = (name: string, n: V3, p: V3) => {
      const ay = norm(n);
      const ref: V3 = Math.abs(ay[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const bx = norm(cross(ref, ay));
      const bz = cross(bx, ay);
      const off = (p[0] - C[0]) * ay[0] + (p[1] - C[1]) * ay[1] + (p[2] - C[2]) * ay[2];
      const T = Math.max(0.5, support(ay) - off + minDim * 0.25);
      // the box's lateral centre is the mass centre projected onto the plane
      const q: V3 = [C[0] + ay[0] * off, C[1] + ay[1] * off, C[2] + ay[2] * off];
      const wx = 2 * support(bx) * 1.15 + 1, wz = 2 * support(bz) * 1.15 + 1;
      nodes.push({ id: `${id}-${name}`, op: "sub", shape: "box", position: [r3(q[0] + ay[0] * T / 2), r3(q[1] + ay[1] * T / 2), r3(q[2] + ay[2] * T / 2)], rotation: eulerFromBasis(bx, ay, bz).map(r3), size: [r3(wx), r3(T), r3(wz)] });
    };
    const local = (lx: number, ly: number, lz: number): V3 => norm([ax[0] * lx + f[0] * lz, ly, ax[2] * lx + f[2] * lz]);
    const support = (n: V3) => {
      // half-extent of the ellipsoid along a world direction
      const lx = n[0] * ax[0] + n[2] * ax[2], lz = n[0] * f[0] + n[2] * f[2];
      return Math.hypot((L / 2) * lx, (H / 2) * n[1], (D / 2) * lz);
    };
    // leaning front face (top set back), bedding top, two oblique corners
    const front = local(between(-0.3, 0.3), between(0, 0.25), 1);
    cut("front", front, at(0, 0, D * 0.5 * between(0.8, 0.92)));
    const topN = norm([bedUp[0] + between(-0.08, 0.08), bedUp[1], bedUp[2] + between(-0.08, 0.08)]);
    cut("top", topN, [C[0], C[1] + H * 0.5 * between(0.7, 0.88), C[2]]);
    for (const sx of [-1, 1]) {
      const n = local(sx, between(-0.15, 0.5), between(0.3, 1));
      const e = support(n);
      const k = between(0.62, 0.82);
      cut(`side${sx > 0 ? "R" : "L"}`, n, [C[0] + n[0] * e * k, C[1] + n[1] * e * k, C[2] + n[2] * e * k]);
    }
    // strata: above each world-height level the front steps back a little more
    const bottom = C[1] - H / 2, top = C[1] + H / 2;
    // the front starts about where the front facet is and retreats at most ~0.3 of the depth in all,
    // skipping some levels so the steps are irregular (a staircase of equal treads reads as masonry)
    let setback = D * 0.5 * 0.85;
    let retreat = D * 0.3;
    for (let y = Math.ceil((bottom + 1.2 - strataBase) / strataStep) * strataStep + strataBase; y < top - 1 && retreat > 0.3; y += strataStep) {
      if (rand() < 0.35) continue;
      const delta = Math.min(retreat, between(0.5, 1.3));
      retreat -= delta;
      setback -= delta;
      const hTop = top + 2 - y;
      // box: from level y up past the top, and from the set-back plane outward
      const depthOut = D / 2 - setback + 1;
      const bx0 = at(0, 0, setback + depthOut / 2);
      nodes.push({ id: `${id}-bed${Math.round(y)}`, op: "sub", shape: "box", position: [r3(bx0[0]), r3(y + hTop / 2), r3(bx0[2])], rotation: [r3(dip * Math.cos(dipAz)), r3(yaw + between(-0.12, 0.12)), r3(dip * Math.sin(dipAz))], size: [r3(L * 1.2), r3(hTop), r3(depthOut)] });
    }
    // cover on the upward faces: dirt, then grass in from its edge
    const R = Math.max(L, D) * 0.65 + 1;
    const paint: Record<string, unknown>[] = [];
    if (accentIndex >= 0 && accentIndex !== wallIndex && rand() < 0.45) {
      const c = at(between(-0.2, 0.2) * L, between(-0.2, 0.2) * H, D / 2);
      paint.push({ id: `${id}-accent`, center: c.map(r3), radius: r3(Math.max(L, H) * between(0.4, 0.65)), strength: r3(between(0.2, 0.4)), layer: accentIndex, normal: f.map(r3), maxAngle: 60 });
    }
    paint.push(
      { id: `${id}-dirt`, center: [r3(C[0]), r3(top), r3(C[2])], radius: r3(Math.max(R, H * 0.8)), strength: 0.85, layer: dirtIndex, normal: [0, 1, 0], maxAngle: 42, tint: coverTint },
      { id: `${id}-cover`, center: [r3(C[0]), r3(top), r3(C[2])], radius: r3(R * 0.85), strength: 0.9, layer: coverIndex, normal: [0, 1, 0], maxAngle: 30, tint: coverTint },
    );
    return { nodes, paint };
  };

  // ---- the water keep-out: a prism along the channel, full height
  let minY = Infinity, maxY = -Infinity;
  for (const m of masses) {
    minY = Math.min(minY, m.center[1] - m.size[1]);
    maxY = Math.max(maxY, m.center[1] + m.size[1]);
  }
  const keepOut = (): Node[] => {
    // one box per ~3 m stretch of channel, spanning the clearance either side
    // (asymmetric: centred between the two edges) and the full height. Boxes
    // overlap a metre so the cut face is continuous; each is small in plan, so
    // the mesher only evaluates the ones near a block.
    const out: Node[] = [];
    const run = 3;
    const height = maxY - minY + 20;
    for (let i = 0; i + 1 < samples.length; i += run) {
      const a = samples[i]!, b = samples[Math.min(samples.length - 1, i + run)]!;
      const cl = Math.max(a.clear[0], b.clear[0]);
      const cr = Math.max(a.clear[1], b.clear[1]);
      const tx = b.x - a.x, tz = b.z - a.z, len = Math.hypot(tx, tz) || 1;
      const ux = tx / len, uz = tz / len, nx = -uz, nz = ux;
      const off = (cl - cr) / 2;
      const mx = (a.x + b.x) / 2 + nx * off, mz = (a.z + b.z) / 2 + nz * off;
      out.push({
        id: `keep-out-${out.length}`,
        op: "sub",
        shape: "box",
        position: [r3(mx), r3((minY + maxY) / 2), r3(mz)],
        // local X along the channel: yaw maps local X to (cos, -sin)
        rotation: [0, r3(Math.atan2(-uz, ux)), 0],
        size: [r3(len + 1.2), r3(height), r3(cl + cr)],
      });
    }
    return out;
  };

  /**
   * Trim what the terrain hides: intersect with a slab from `bury` metres
   * under the ground up. A mass is seated with its back well inside the wall
   * so it reads as fused, and without this every buried back would be meshed,
   * shadowed and collided — measured at four fifths of the triangles. What is
   * left under the ground is a thin skin, so no seam opens where the terrain's
   * marching cubes and the volume's dual contour disagree by a voxel.
   */
  const bury = 1.5;
  const ground = opts.groundAt ?? ((x: number, z: number) => field.height(x, z));
  let trimFloor = -Infinity;
  const buriedTrim = (group: RockMass[]): Node | null => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const m of group) {
      const r = Math.max(...m.size) * 0.75 + 2;
      x0 = Math.min(x0, m.center[0] - r);
      x1 = Math.max(x1, m.center[0] + r);
      z0 = Math.min(z0, m.center[2] - r);
      z1 = Math.max(z1, m.center[2] + r);
    }
    if (!Number.isFinite(x0)) return null;
    const cell = 1.5;
    const width = Math.min(2048, Math.ceil((x1 - x0) / cell) + 1);
    const depth = Math.min(2048, Math.ceil((z1 - z0) / cell) + 1);
    const sx = (x1 - x0) / (width - 1), sz = (z1 - z0) / (depth - 1);
    const heights = new Float32Array(width * depth);
    let lowest = Infinity;
    for (let k = 0; k < depth; k++)
      for (let i = 0; i < width; i++) {
        const x = x0 + i * sx, z = z0 + k * sz;
        // the lowest ground in the cell's neighbourhood, so a steep wall is never trimmed proud of itself
        let h = Infinity;
        for (const [dx, dz] of [[0, 0], [sx * 0.5, sz * 0.5], [-sx * 0.5, -sz * 0.5], [sx * 0.5, -sz * 0.5], [-sx * 0.5, sz * 0.5]] as const) h = Math.min(h, ground(x + dx, z + dz));
        heights[k * width + i] = h;
        lowest = Math.min(lowest, h);
      }
    trimFloor = lowest - bury;
    const base = Math.min(minY, lowest) - 10;
    const values = heights.map((h) => r3(Math.max(0, h - bury - base)));
    return {
      id: "trim-buried",
      op: "intersect",
      shape: "heightfield",
      position: [r3((x0 + x1) / 2), r3(base), r3((z0 + z1) / 2)],
      size: [r3(x1 - x0), r3(maxY - base + 20), r3(z1 - z0)],
      heightfield: { width, depth, mode: "ceiling", values: encodeHeightfieldValues(values) },
    };
  };



  /**
   * Re-seat what hangs. The masses carve each other (a small mass's cut boxes come after a big
   * mass and can take a slab out of its foot), which leaves rock with open air under it: an
   * underside out over the gorge, a ledge standing free. On a 1 m grid over every mass, find the
   * lowest rock in each column that has air (not terrain, not rock) beneath it more than half a
   * metre above the ground, and fill that column down into the ground with a vertical box —
   * appended after every cut, so nothing carves it again (only the water keep-out and the buried
   * trim, which leave no underside). Runs of neighbouring columns share one box.
   */
  const underfill = (group: RockMass[], built: Node[]): Node[] => {
    const probe = createVolume({ voxelSize, palette: names, nodes: [...built, ...keepOut()] });
    const cellSize = 8;
    const samplers = new Map<string, (x: number, y: number, z: number) => number>();
    const rockAt = (x: number, y: number, z: number) => {
      const key = `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
      let f = samplers.get(key);
      if (!f) {
        const lo: [number, number, number] = [Math.floor(x / cellSize) * cellSize, Math.floor(y / cellSize) * cellSize, Math.floor(z / cellSize) * cellSize];
        const hi: [number, number, number] = [lo[0] + cellSize, lo[1] + cellSize, lo[2] + cellSize];
        f = probe.solidMayReach && !probe.solidMayReach(lo, hi) ? () => 1 : probe.sampler(lo, hi);
        samplers.set(key, f);
      }
      return f(x, y, z) < 0;
    };
    const ground = opts.groundAt ?? ((x: number, z: number) => field.height(x, z));
    // columns: (ix, iz) -> height the fill must reach
    const tops = new Map<string, { ix: number; iz: number; top: number; floor: number }>();
    for (const m of group) {
      const r = Math.max(...m.size) * 0.62 + 1;
      const yTop = m.center[1] + m.size[1] / 2 + 1;
      for (let ix = Math.floor(m.center[0] - r); ix <= Math.ceil(m.center[0] + r); ix++)
        for (let iz = Math.floor(m.center[2] - r); iz <= Math.ceil(m.center[2] + r); iz++) {
          const key = `${ix},${iz}`;
          if (tops.has(key)) continue;
          const x = ix + 0.5, z = iz + 0.5, g = ground(x, z);
          // the LOWEST hanging rock in the column: walking down, a solid sample over an air one
          let hang = -Infinity;
          let above = false;
          for (let y = yTop; y > g + 0.5; y -= 0.5) {
            const solid = rockAt(x, y, z);
            if (above && !solid) hang = y + 0.5;
            above = solid;
          }
          if (hang > -Infinity) tops.set(key, { ix, iz, top: hang + 0.3, floor: g - 1.5 });
        }
    }
    // merge runs along x with a similar top into one box
    const out: Node[] = [];
    const cols = [...tops.values()].sort((a, b) => a.iz - b.iz || a.ix - b.ix);
    for (let i = 0; i < cols.length; ) {
      const a = cols[i]!;
      let j = i + 1, top = a.top, floor = a.floor;
      while (j < cols.length && cols[j]!.iz === a.iz && cols[j]!.ix === cols[j - 1]!.ix + 1 && Math.abs(cols[j]!.top - a.top) < 0.75) {
        top = Math.max(top, cols[j]!.top);
        floor = Math.min(floor, cols[j]!.floor);
        j++;
      }
      const n = j - i;
      out.push({ id: `fill-${out.length}`, op: "add", shape: "box", position: [r3(a.ix + n / 2), r3((top + floor) / 2), r3(a.iz + 0.5)], size: [r3(n + 0.1), r3(top - floor), 1.1] });
      i = j;
    }
    return out;
  };

  const buildDoc = (group: RockMass[], suffix: string): VolumeDoc => {
    const nodes: Node[] = [];
    const paint: Record<string, unknown>[] = [];
    // biggest first: a mass's cuts carve everything before it, so the small ones go last,
    // where their small cut boxes can only nick the big masses they are fused with
    const volumeOf = (m: RockMass) => m.size[0] * m.size[1] * m.size[2];
    [...group].sort((a, b) => volumeOf(b) - volumeOf(a)).forEach((m) => {
      const out = massNodes(m, masses.indexOf(m));
      nodes.push(...out.nodes);
      paint.push(...out.paint);
    });
    nodes.push(...underfill(group, nodes));
    nodes.push(...keepOut());
    // the lattice spans exactly what the ADD nodes can reach (createVolume's own derivation, with its
    // closing margin), taken before the trim: that slab is unbounded in height. A hand-estimated box
    // clipped the plinths that run down to the ground and left the solid open along the cut.
    const addBounds = createVolume({ voxelSize, palette: names, nodes: nodes.filter((n) => n.op === "add") });
    const trim = opts.trim === false ? null : buriedTrim(group);
    if (trim) {
      nodes.push(trim);
      // nothing survives the trim below the lowest ground under it minus the bury depth
      addBounds.min[1] = Math.max(addBounds.min[1], trimFloor - voxelSize * 3);
    }
    return {
      name: `${opts.name ?? "rock formations"} ${site.id}${suffix}`,
      voxelSize,
      // explicit: the trim slab is unbounded in height and would otherwise set the lattice
      bounds: { min: addBounds.min.map(r3), max: addBounds.max.map(r3) },
      palette: names,
      surface: { floor: rockIndex, wall: wallIndex, ceiling: wallIndex },
      tint: wallTint,
      nodes,
      paint,
    } as unknown as VolumeDoc;
  };
  const samplesOf = (group: RockMass[]) => {
    let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const m of group) {
      const r = Math.max(...m.size) * 0.75 + 1;
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a]!, m.center[a]! - r);
        hi[a] = Math.max(hi[a]!, m.center[a]! + r);
      }
    }
    return ((hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])) / voxelSize ** 3;
  };
  let docs: VolumeDoc[];
  if (masses.length === 0) docs = [];
  else if (samplesOf(masses) <= maxSamples) docs = [buildDoc(masses, "")];
  else {
    docs = [];
    for (let t = -1; t < tiers.length; t++) {
      const group = masses.filter((m) => m.tier === t);
      if (group.length) docs.push(buildDoc(group, ` tier ${t + 1}`));
    }
  }
  return { river: riverId, tiers: tiers.length, masses, docs };
}

/**
 * The formations of a site as a SOLID to query — what the scree dressing
 * (fall-site-rocks.ts) rests on and keeps out of. Same generator, same seed,
 * same options as the placed volume, minus the buried-part trim (under the
 * terrain it is solid either way). Queries go through per-8 m-cell samplers,
 * so each point pays only for the few nodes that can reach it. Null when the
 * generator places nothing.
 */
export interface RockFormationSolid {
  min: [number, number, number];
  max: [number, number, number];
  /** Signed distance-ish field of the formations; negative inside, and in open cells a conservative distance (a tracer may step it). */
  density(x: number, y: number, z: number): number;
}

export function rockFormationSolid(field: WorldField, site: RockFormationSite, opts: RockFormationOptions = {}): RockFormationSolid | null {
  const result = rockFormations(field, site, { ...opts, trim: false, maxSamples: Infinity });
  const doc = result.docs[0];
  if (!doc) return null;
  const volume = createVolume(doc);
  const cell = 8;
  const min = volume.min, max = volume.max;
  const n = [0, 1, 2].map((a) => Math.max(1, Math.ceil((max[a]! - min[a]!) / cell)));
  const samplers = new Map<number, (x: number, y: number, z: number) => number>();
  return {
    min: [...min] as [number, number, number],
    max: [...max] as [number, number, number],
    density(x, y, z) {
      if (x < min[0] || y < min[1] || z < min[2] || x > max[0] || y > max[1] || z > max[2]) return 1e9;
      const i = Math.min(n[0]! - 1, Math.floor((x - min[0]) / cell));
      const j = Math.min(n[1]! - 1, Math.floor((y - min[1]) / cell));
      const k = Math.min(n[2]! - 1, Math.floor((z - min[2]) / cell));
      const key = i + n[0]! * (j + n[1]! * k);
      let f = samplers.get(key);
      if (!f) {
        const lo: [number, number, number] = [min[0] + i * cell, min[1] + j * cell, min[2] + k * cell];
        const hi: [number, number, number] = [lo[0] + cell, lo[1] + cell, lo[2] + cell];
        // most of the site box is open air: no add node reaches the cell, nothing to evaluate
        // (there, the distance to the cell's own faces is a true lower bound on the distance to any rock: a tracer can step it)
        f = volume.solidMayReach && !volume.solidMayReach(lo, hi)
          ? (px: number, py: number, pz: number) => 0.05 + Math.min(px - lo[0], hi[0] - px, py - lo[1], hi[1] - py, pz - lo[2], hi[2] - pz)
          : volume.sampler(lo, hi);
        samplers.set(key, f);
      }
      return f(x, y, z);
    },
  };
}
