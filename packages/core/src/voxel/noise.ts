/**
 * Deterministic coherent noise for procedural worlds — the layer everything
 * else in `voxel/` stands on.
 *
 * Two hard requirements, both learned from `terrain.ts`'s sin-hash lattice:
 *
 * 1. **Bit-identical everywhere.** The browser meshes a chunk, Node's worldgen
 *    CLI carves a river through the same chunk, and physics cooks a collider
 *    from it — all three must agree to the last float or props float and
 *    players fall through the ground. `Math.sin` is NOT specified to the last
 *    ulp across engines, so every hash here is integer-only (`Math.imul`,
 *    xor, shifts), which IS exact everywhere JS runs.
 * 2. **No axis artifacts.** Value noise (what `terrain.ts` uses) shows visible
 *    grid alignment once you amplify it into mountains. These are gradient
 *    (Perlin) lattices with the quintic fade, which is what an open world's
 *    silhouette needs.
 *
 * Pure math: no Three.js, no DOM, no allocation in the hot path.
 */

/** Integer hash to uint32. Exact in every JS engine (no floats anywhere). */
export function hash3i(x: number, y: number, z: number, seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (y | 0), 0x165667b1);
  h ^= h >>> 13;
  h = Math.imul(h ^ (z | 0), 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** 2D specialisation of {@link hash3i} — z folded to a constant so the 2D and 3D lattices don't correlate. */
export function hash2i(x: number, y: number, seed: number): number {
  return hash3i(x, y, 0x5bf03635, seed);
}

/** Deterministic uniform [0,1) from an integer lattice cell — for jittered scatter grids. */
export function hashUnit(x: number, y: number, z: number, seed: number): number {
  return hash3i(x, y, z, seed) / 4294967296;
}

/** Quintic fade — C2 continuous, so gradients (our surface normals) stay smooth. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// 12 edge-midpoint gradients of a cube — Perlin's improved-noise set.
const GRAD3: readonly (readonly [number, number, number])[] = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function dotGrad3(hash: number, x: number, y: number, z: number): number {
  const g = GRAD3[hash % 12]!;
  return g[0] * x + g[1] * y + g[2] * z;
}

// 8 unit directions for the 2D lattice.
const R2 = 0.7071067811865476;
const GRAD2: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [R2, R2], [-R2, R2], [R2, -R2], [-R2, -R2],
];

function dotGrad2(hash: number, x: number, y: number): number {
  const g = GRAD2[hash & 7]!;
  return g[0] * x + g[1] * y;
}

/** Perlin gradient noise, 2D. Range approx [-1, 1]. */
export function perlin2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const n00 = dotGrad2(hash2i(ix, iy, seed), fx, fy);
  const n10 = dotGrad2(hash2i(ix + 1, iy, seed), fx - 1, fy);
  const n01 = dotGrad2(hash2i(ix, iy + 1, seed), fx, fy - 1);
  const n11 = dotGrad2(hash2i(ix + 1, iy + 1, seed), fx - 1, fy - 1);
  // 1.4142 renormalises the lattice's ~1/sqrt(2) peak back toward +/-1
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4142135623730951;
}

/**
 * Perlin 2D with its analytic gradient: `out = [n, dn/dx, dn/dy]`.
 *
 * The derivative is what makes EROSION affordable (see {@link fbm2}): the
 * classic trick of weighting each octave by the gradient accumulated so far
 * needs the slope of the noise at every octave, and finite differences would
 * cost three evaluations where this costs a few extra multiplies.
 */
export function perlin2d(x: number, y: number, seed: number, out: Float64Array): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fade(fx);
  const v = fade(fy);
  const du = 30 * fx * fx * (fx * (fx - 2) + 1);
  const dv = 30 * fy * fy * (fy * (fy - 2) + 1);
  const g00 = GRAD2[hash2i(ix, iy, seed) & 7]!;
  const g10 = GRAD2[hash2i(ix + 1, iy, seed) & 7]!;
  const g01 = GRAD2[hash2i(ix, iy + 1, seed) & 7]!;
  const g11 = GRAD2[hash2i(ix + 1, iy + 1, seed) & 7]!;
  const a = g00[0] * fx + g00[1] * fy;
  const b = g10[0] * (fx - 1) + g10[1] * fy;
  const c = g01[0] * fx + g01[1] * (fy - 1);
  const d = g11[0] * (fx - 1) + g11[1] * (fy - 1);
  const k1 = b - a;
  const k2 = c - a;
  const k3 = a - b - c + d;
  const n = a + u * k1 + v * k2 + u * v * k3;
  // d/dx of the bilinear blend: the fade's own slope times the corner
  // differences, plus the blend of the corner gradients' x components
  const gx =
    du * (k1 + v * k3) +
    (g00[0] + u * (g10[0] - g00[0]) + v * (g01[0] - g00[0]) + u * v * (g00[0] - g10[0] - g01[0] + g11[0]));
  const gy =
    dv * (k2 + u * k3) +
    (g00[1] + u * (g10[1] - g00[1]) + v * (g01[1] - g00[1]) + u * v * (g00[1] - g10[1] - g01[1] + g11[1]));
  const s = 1.4142135623730951;
  out[0] = n * s;
  out[1] = gx * s;
  out[2] = gy * s;
}

/** Perlin gradient noise, 3D. Range approx [-1, 1]. */
export function perlin3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const n000 = dotGrad3(hash3i(ix, iy, iz, seed), fx, fy, fz);
  const n100 = dotGrad3(hash3i(ix + 1, iy, iz, seed), fx - 1, fy, fz);
  const n010 = dotGrad3(hash3i(ix, iy + 1, iz, seed), fx, fy - 1, fz);
  const n110 = dotGrad3(hash3i(ix + 1, iy + 1, iz, seed), fx - 1, fy - 1, fz);
  const n001 = dotGrad3(hash3i(ix, iy, iz + 1, seed), fx, fy, fz - 1);
  const n101 = dotGrad3(hash3i(ix + 1, iy, iz + 1, seed), fx - 1, fy, fz - 1);
  const n011 = dotGrad3(hash3i(ix, iy + 1, iz + 1, seed), fx, fy - 1, fz - 1);
  const n111 = dotGrad3(hash3i(ix + 1, iy + 1, iz + 1, seed), fx - 1, fy - 1, fz - 1);
  const x00 = lerp(n000, n100, u);
  const x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u);
  const x11 = lerp(n011, n111, u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 1.1547005383792515;
}

/**
 * One fractal noise band. This is the unit a world recipe is written in:
 * "continents" is one of these, "mountains" is another with `ridged` on.
 */
export interface FbmSpec {
  /** Feature size: cycles per world unit. 0.001 = continent-scale, 0.05 = boulders. */
  frequency: number;
  /** Output is scaled to roughly +/-amplitude (ridged: 0..amplitude). */
  amplitude: number;
  /** Octave count. Each adds detail at `lacunarity` x the frequency for `gain` x the weight. */
  octaves: number;
  lacunarity: number;
  gain: number;
  /** Ridged multifractal: (1 - |n|) squared — sharp crests, flat valleys. Mountains. */
  ridged: boolean;
  /** Added to the world seed so two bands with identical settings still differ. */
  seed: number;
  /**
   * Erosion, 0..1. Weights each octave by the slope accumulated so far, so
   * detail piles up on ridges and is damped in the valleys — the difference
   * between fBm's uniform crinkle and a landscape that reads as weathered.
   * Costs ~40% over plain fBm (derivative noise). 0 (or absent) = off.
   */
  erosion?: number;
  /**
   * Crest rounding for a ridged band, 0..1. The ridged fold `1 - |n|` has a
   * crease at every crest of every octave — a knife edge, which is what a
   * range built from it looks like up close: every ridgeline and summit meets
   * at a corner the voxel mesh cannot round off. `crest` swaps |n| for a
   * smooth absolute value, so each crest arrives at its top on a curve over
   * roughly `crest` of the band's swing. 0 (or absent) keeps the knife edge.
   * Ignored for non-ridged bands.
   */
  crest?: number;
}

/**
 * The ridged fold with a rounded crest: `1 - |n|`, but through a smooth
 * absolute value so the peak at n = 0 is a curve rather than a corner.
 * Subtracting `c` keeps the crest at exactly 1, so the band's range and the
 * summit line it feeds do not move.
 */
function ridge(n: number, crest: number): number {
  if (crest <= 0) return 1 - Math.abs(n);
  return 1 - (Math.sqrt(n * n + crest * crest) - crest);
}

/** 2D fBm in the recipe's terms. Deterministic for a given (spec, worldSeed). */
export function fbm2(spec: FbmSpec, x: number, z: number, worldSeed: number): number {
  const erosion = spec.erosion ?? 0;
  if (erosion > 0) return fbm2Eroded(spec, x, z, worldSeed, erosion);
  const seed = (worldSeed + spec.seed) | 0;
  let freq = spec.frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  const crest = spec.crest ?? 0;
  const octaves = Math.max(1, Math.floor(spec.octaves));
  for (let o = 0; o < octaves; o++) {
    let n = perlin2(x * freq, z * freq, (seed + o * 1013) | 0);
    if (spec.ridged) {
      n = ridge(n, crest);
      n *= n;
    }
    sum += n * amp;
    norm += amp;
    freq *= spec.lacunarity;
    amp *= spec.gain;
  }
  return (sum / (norm || 1)) * spec.amplitude;
}

const erodeScratch = new Float64Array(3);

/**
 * fBm with slope-weighted octaves (Quilez's "erosion" fBm).
 *
 * Each octave's contribution is divided by `1 + k * |grad|²` where the
 * gradient is the sum of every octave so far, expressed in the FIRST octave's
 * units so the knob means the same thing whatever the frequency. Steep ground
 * therefore stops collecting fine detail — which is what makes valleys smooth
 * and walkable while ridgelines stay crisp, instead of every slope in the
 * world carrying the same 30 m crinkle.
 *
 * Ridged bands erode too: the fold happens before the weighting, so a crest
 * keeps its edge and the flanks below it are calmed.
 */
function fbm2Eroded(spec: FbmSpec, x: number, z: number, worldSeed: number, erosion: number): number {
  const seed = (worldSeed + spec.seed) | 0;
  const baseFreq = spec.frequency;
  let freq = baseFreq;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let dx = 0;
  let dz = 0;
  const k = erosion * 2.5;
  const crest = spec.crest ?? 0;
  const octaves = Math.max(1, Math.floor(spec.octaves));
  for (let o = 0; o < octaves; o++) {
    perlin2d(x * freq, z * freq, (seed + o * 1013) | 0, erodeScratch);
    let n = erodeScratch[0]!;
    // gradient relative to the base octave: a fine octave's steep slope counts
    // for exactly as much relief as it actually adds
    const scale = (freq / baseFreq) * amp;
    let gx = erodeScratch[1]! * scale;
    let gz = erodeScratch[2]! * scale;
    if (spec.ridged) {
      const r = ridge(n, crest);
      // d/dn of ridge(n)^2 = -2 r * d|n|/dn, and the smooth |n| has slope
      // n / sqrt(n^2 + c^2) — which is sign(n) when c = 0
      const dabs = crest > 0 ? n / Math.sqrt(n * n + crest * crest) : n < 0 ? -1 : 1;
      gx *= -2 * dabs * r;
      gz *= -2 * dabs * r;
      n = r * r;
    }
    // weighted by the slope of everything BELOW this octave: the base band
    // keeps its full relief (weighting it by its own gradient flattened every
    // range by a third), and each finer band is damped where the ground it
    // sits on is already steep
    const w = o === 0 ? 1 : 1 / (1 + k * (dx * dx + dz * dz));
    dx += gx;
    dz += gz;
    sum += n * amp * w;
    norm += amp;
    freq *= spec.lacunarity;
    amp *= spec.gain;
  }
  return (sum / (norm || 1)) * spec.amplitude;
}

/** 3D fBm — the overhang/cave bands, where the field genuinely needs a volume. */
export function fbm3(spec: FbmSpec, x: number, y: number, z: number, worldSeed: number): number {
  const seed = (worldSeed + spec.seed) | 0;
  let freq = spec.frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  const crest = spec.crest ?? 0;
  const octaves = Math.max(1, Math.floor(spec.octaves));
  for (let o = 0; o < octaves; o++) {
    let n = perlin3(x * freq, y * freq, z * freq, (seed + o * 1013) | 0);
    if (spec.ridged) {
      n = ridge(n, crest);
      n *= n;
    }
    sum += n * amp;
    norm += amp;
    freq *= spec.lacunarity;
    amp *= spec.gain;
  }
  return (sum / (norm || 1)) * spec.amplitude;
}

/** Smoothstep — the engine's one blend curve (matches terrain.ts and the TSL splat). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** mulberry32 — the engine's standard seeded PRNG (the same one placement/scatter use). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
