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
}

/** 2D fBm in the recipe's terms. Deterministic for a given (spec, worldSeed). */
export function fbm2(spec: FbmSpec, x: number, z: number, worldSeed: number): number {
  const seed = (worldSeed + spec.seed) | 0;
  let freq = spec.frequency;
  let amp = 1;
  let sum = 0;
  let norm = 0;
  const octaves = Math.max(1, Math.floor(spec.octaves));
  for (let o = 0; o < octaves; o++) {
    let n = perlin2(x * freq, z * freq, (seed + o * 1013) | 0);
    if (spec.ridged) {
      n = 1 - Math.abs(n);
      n *= n;
    }
    sum += n * amp;
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
  const octaves = Math.max(1, Math.floor(spec.octaves));
  for (let o = 0; o < octaves; o++) {
    let n = perlin3(x * freq, y * freq, z * freq, (seed + o * 1013) | 0);
    if (spec.ridged) {
      n = 1 - Math.abs(n);
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
