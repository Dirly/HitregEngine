/**
 * THE GROUND — the one answer to "where is the ground under (x, z)" for every placer and every gate that judges a placed
 * piece (place-build plan/seat/settle, field scatter, settle, lift, the seated gate, wall seats, hero/shelter checks).
 *
 * L (t-ground, Derek 2026-10-31: "Why is shit floating if we have code assist for placement?"): placement was right on
 * the ground it read, but it read the drawn HEIGHT MAP, which runs straight over every carved hole (cave mouths,
 * burrows, pits, passages). The player walks on the voxel solid; so does this. The float gate (core voxel/seat.ts
 * `fieldSolidProbe`), dress apply (float.mts `seatPlaced`) and scatter-float (the meshed cell surface) already measure
 * that solid; everything else reads it here. Never call `field.height()` for placement or a gate: call `walkGround`.
 *
 * Rule: start at the drawn height h. Solid just under h and air just over it -> h (the common case: 2 density reads).
 * Air under h -> a HOLE: scan down in 0.25 m steps to the first solid (at most HOLE_DEPTH_M), bisected to ~4 mm.
 * Solid over h -> the surface is ABOVE the drawn height (a tread, a fill, a raised build): scan up to WALK_RISE_M for air.
 */
import { buildVoxelMesh, type WorldField } from "@hitreg/core";

/** How deep a hole is followed before the ground is called "h - HOLE_DEPTH_M" (a shaft: the piece is over a void). */
export const HOLE_DEPTH_M = 40;
/** How far above the drawn height a raised solid (a tread, a fill) is followed. */
export const WALK_RISE_M = 3;
const EPS = 0.04, STEP = 0.25;

/** The walked ground from a height and a density (negative = solid), for tests and callers without a field. */
export function walkGroundOf(height: (x: number, z: number) => number, density: (x: number, y: number, z: number) => number, depth = HOLE_DEPTH_M): (x: number, z: number) => number {
  const solid = (x: number, y: number, z: number): boolean => density(x, y, z) < 0;
  // a: solid, b: air (either order)
  const bisect = (x: number, z: number, a: number, b: number): number => { for (let i = 0; i < 6; i++) { const m = (a + b) / 2; if (solid(x, m, z)) a = m; else b = m; } return (a + b) / 2; };
  return (x, z) => {
    const h = height(x, z);
    if (solid(x, h - EPS, z)) {
      if (!solid(x, h + EPS, z)) return h;
      let prev = h + EPS;
      for (let y = h + EPS + STEP; y <= h + WALK_RISE_M + 1e-9; y += STEP) { if (!solid(x, y, z)) return bisect(x, z, prev, y); prev = y; }
      return h; // solid all the way up: under a cliff or inside rock; the drawn height stands
    }
    let prev = h - EPS;
    for (let y = h - EPS - STEP; y >= h - depth - 1e-9; y -= STEP) { if (solid(x, y, z)) return bisect(x, z, y, prev); prev = y; }
    return h - depth;
  };
}

/** The walked ground of a world field (its carved voxel solid). */
export function walkGround(field: Pick<WorldField, "height" | "density">, depth = HOLE_DEPTH_M): (x: number, z: number) => number {
  return walkGroundOf((x, z) => field.height(x, z), (x, y, z) => field.density(x, y, z), depth);
}

/** The walked ground UNDER A GIVEN HEIGHT: the floor of a carved room (a cave hall under 30 m of rock) that `walkGround`
 *  never reaches, since it starts at the drawn height (the cliff top) and finds rock all the way down to it. Starts at
 *  `yFrom` instead: air there -> scan down to the first solid (at most `depth`); solid there -> scan up to WALK_RISE_M for
 *  air. A piece on a layout cave's floor (tag `cave:<id>`) is measured on this from its own height. L (o-sunwine3 2026-10-31). */
export function walkGroundFrom(field: Pick<WorldField, "density">, yFrom: number, depth = HOLE_DEPTH_M): (x: number, z: number) => number {
  return walkGroundOf(() => yFrom, (x, y, z) => field.density(x, y, z), depth);
}

/** A world field whose `height` IS the walked ground (every other member untouched): hand it to a placer written
 *  against `field.height` (place-build's lab re-seat, routes, sinks) so it reads the carved solid. */
export function walkField<T extends Pick<WorldField, "height" | "density">>(field: T): T {
  return { ...field, height: walkGround(field) };
}

/** THE DRAWN GROUND: the height of the voxel MESH the player sees (the cell's triangles, the streamer's mesher), the hit
 *  nearest the walked ground at (x, z); the walked ground where no triangle covers it. The field and its mesh differ by a
 *  few cm between lattice points: a placer that must keep a face off the drawn ground (a thin prop's layers vs the zfight
 *  gate, place-build thinTiltSeat) reads this. Cell meshes are built once per sampler.
 *  `ref` + `window`: the hit nearest `ref` within `window` m instead of the walked ground within 0.5 m: a cave floor (ref =
 *  walkGroundFrom under the rock), where the mesher draws a carved tube's floor up to ~1.6 m off the field's. L (o-sunwine4
 *  2026-11-01: the walk gate's body walked the Sunwine bore 1.6 m over the field floor its route points read). */
export function drawnGround(field: Pick<WorldField, "height" | "density" | "recipe">, mesher: string = "auto"): (x: number, z: number, ref?: number, window?: number) => number {
  const walk = walkGround(field), C = field.recipe.cellSize, cells = new Map<string, { p: ArrayLike<number>; idx: ArrayLike<number>; buckets: number[][]; n: number }>();
  const cellOf = (cx: number, cz: number) => {
    const key = `${cx},${cz}`; let c = cells.get(key); if (c) return c;
    const m = buildVoxelMesh(field as WorldField, { kind: "voxel", world: field.recipe.name, cell: [cx, cz], lodStep: 1, mesher } as never), p = m.positions, idx = m.indices, n = Math.ceil(C);
    const buckets: number[][] = Array.from({ length: n * n }, () => []);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * 3, b = idx[t + 1]! * 3, d = idx[t + 2]! * 3;
      const x0 = Math.max(0, Math.floor(Math.min(p[a]!, p[b]!, p[d]!))), x1 = Math.min(n - 1, Math.floor(Math.max(p[a]!, p[b]!, p[d]!)));
      const z0 = Math.max(0, Math.floor(Math.min(p[a + 2]!, p[b + 2]!, p[d + 2]!))), z1 = Math.min(n - 1, Math.floor(Math.max(p[a + 2]!, p[b + 2]!, p[d + 2]!)));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) buckets[x + z * n]!.push(t);
    }
    cells.set(key, (c = { p, idx, buckets, n })); return c;
  };
  return (x, z, ref, window = 0.5) => {
    const w = ref ?? walk(x, z), cx = Math.floor(x / C), cz = Math.floor(z / C), c = cellOf(cx, cz), lx = x - cx * C, lz = z - cz * C, bx = Math.floor(lx), bz = Math.floor(lz);
    if (bx < 0 || bz < 0 || bx >= c.n || bz >= c.n) return w;
    let best = w, bd = window; const p = c.p, idx = c.idx;
    for (const t of c.buckets[bx + bz * c.n]!) {
      const a = idx[t]! * 3, b = idx[t + 1]! * 3, d = idx[t + 2]! * 3, ax = p[a]!, az = p[a + 2]!, bxp = p[b]!, bzp = p[b + 2]!, cxp = p[d]!, czp = p[d + 2]!;
      const den = (bzp - czp) * (ax - cxp) + (cxp - bxp) * (az - czp); if (Math.abs(den) < 1e-9) continue;
      const u = ((bzp - czp) * (lx - cxp) + (cxp - bxp) * (lz - czp)) / den, v = ((czp - az) * (lx - cxp) + (ax - cxp) * (lz - czp)) / den, k = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || k < -1e-6) continue;
      const y = u * p[a + 1]! + v * p[b + 1]! + k * p[d + 1]!; if (Math.abs(y - w) < bd) { bd = Math.abs(y - w); best = y; }
    }
    return best;
  };
}
