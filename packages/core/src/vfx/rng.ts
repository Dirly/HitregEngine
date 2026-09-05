/**
 * Seeded randomness for the spell generator.
 *
 * Everything the generator does must be reproducible from a seed — a spell is
 * regenerated from `{ seed, archetype, element }` every time the archetype is
 * tweaked, and a human who liked what they saw at seed 4127 has to get seed
 * 4127 back. Math.random is banned inside the generator for that reason.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** Weighted pick; zero-weight items are never chosen. */
  weighted<T>(items: ReadonlyArray<{ w: number; v: T }>): T;
  /** Fork a child stream so one phase's draws never shift another's. */
  fork(label: string): Rng;
}

/** Deterministic 32-bit hash of any label — for seeds and forks. */
export function hashSeed(input: string | number): number {
  const s = String(input);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, and good enough for choosing between presets. */
export function makeRng(seed: number | string): Rng {
  let state = (typeof seed === "number" ? seed : hashSeed(seed)) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    pick: (items) => {
      if (items.length === 0) throw new Error("rng.pick: empty list");
      return items[Math.min(items.length - 1, Math.floor(next() * items.length))]!;
    },
    chance: (p) => next() < p,
    weighted: (items) => {
      let total = 0;
      for (const it of items) total += Math.max(0, it.w);
      if (total <= 0) throw new Error("rng.weighted: no positive weights");
      let r = next() * total;
      for (const it of items) {
        r -= Math.max(0, it.w);
        if (r <= 0) return it.v;
      }
      return items[items.length - 1]!.v;
    },
    fork: (label) => makeRng((hashSeed(label) ^ Math.floor(next() * 4294967296)) >>> 0),
  };
  return rng;
}
