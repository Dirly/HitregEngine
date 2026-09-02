/**
 * Marching-cubes case tables — **derived, not transcribed**.
 *
 * The canonical 256x16 triangle table is 4,096 hand-typed integers, and a
 * single wrong digit produces a hole that only shows up as a flicker of
 * skybox through a hillside in one cube configuration out of 256. So this
 * module *computes* the table at load (once, ~256 tiny loops) from first
 * principles, which is both auditable and testable:
 *
 * 1. A cube face is a quad whose 4 corners are each inside or outside. Walk
 *    its boundary in CCW order **as seen from outside the cube**. Every
 *    inside→outside crossing starts a surface segment on that face; every
 *    outside→inside crossing ends one. Pair each start with the next end in
 *    walk order.
 * 2. An intersected cube edge is shared by exactly two faces, which traverse
 *    it in opposite directions — so it is a segment START on one and an END
 *    on the other. Chaining start→end therefore always closes into loops.
 * 3. Fan-triangulate each loop.
 *
 * Two properties fall out for free, and both are asserted in the tests:
 *
 * - **Watertight across cells.** The ambiguous 4-crossing face (two diagonal
 *   inside corners) is resolved by walk order, and the neighbouring cube
 *   walks that same face reversed — which provably yields the *same* pairing.
 *   No crack, no per-cell decision to keep consistent.
 * - **Outward winding.** The loop direction that falls out of "inside on the
 *   left" gives triangles whose normal points from solid into air, matching
 *   the convention in {@link ./marching-cubes.ts} (negative density = solid).
 */

/** Cube corner offsets, in the standard marching-cubes numbering. */
export const CORNER_OFFSETS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], // 0
  [1, 0, 0], // 1
  [1, 0, 1], // 2
  [0, 0, 1], // 3
  [0, 1, 0], // 4
  [1, 1, 0], // 5
  [1, 1, 1], // 6
  [0, 1, 1], // 7
];

/** The 12 cube edges as corner pairs, in the standard numbering. */
export const EDGE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Each edge expressed on the sample lattice as `[dx, dy, dz, axis]`: the
 * lower lattice point it springs from plus the axis it runs along (0=x,
 * 1=y, 2=z). This is what makes vertices weld — two cubes sharing an edge
 * derive the same lattice key for it, so they share one vertex, which is
 * what keeps normals smooth and the mesh manifold.
 */
export const EDGE_LATTICE: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 0, 0], // 0: 0-1 along x
  [1, 0, 0, 2], // 1: 1-2 along z
  [0, 0, 1, 0], // 2: 3-2 along x
  [0, 0, 0, 2], // 3: 0-3 along z
  [0, 1, 0, 0], // 4: 4-5 along x
  [1, 1, 0, 2], // 5: 5-6 along z
  [0, 1, 1, 0], // 6: 7-6 along x
  [0, 1, 0, 2], // 7: 4-7 along z
  [0, 0, 0, 1], // 8: 0-4 along y
  [1, 0, 0, 1], // 9: 1-5 along y
  [1, 0, 1, 1], // 10: 2-6 along y
  [0, 0, 1, 1], // 11: 3-7 along y
];

/**
 * The six faces, corners listed CCW **viewed from outside the cube** (so the
 * right-hand rule over the listed order gives the outward face normal), plus
 * the cube-edge index joining each consecutive corner pair.
 */
const FACES: readonly { corners: readonly number[]; edges: readonly number[] }[] = [
  { corners: [0, 1, 2, 3], edges: [0, 1, 2, 3] }, // -Y (bottom)
  { corners: [4, 7, 6, 5], edges: [7, 6, 5, 4] }, // +Y (top)
  { corners: [0, 4, 5, 1], edges: [8, 4, 9, 0] }, // -Z (front)
  { corners: [3, 2, 6, 7], edges: [2, 10, 6, 11] }, // +Z (back)
  { corners: [0, 3, 7, 4], edges: [3, 11, 7, 8] }, // -X (left)
  { corners: [1, 5, 6, 2], edges: [9, 5, 10, 1] }, // +X (right)
];

/** Directed surface segments on one face for a given inside-corner mask. */
function faceSegments(mask: number, face: (typeof FACES)[number]): [number, number][] {
  const { corners, edges } = face;
  const inside = corners.map((c) => (mask & (1 << c)) !== 0);
  // Crossings in walk order, tagged start (leaving the solid) or end
  // (re-entering it), so "pair each start with the NEXT end" is one ordered
  // pass — the 4-crossing ambiguous face strictly alternates.
  const ordered: { edge: number; start: boolean }[] = [];
  for (let i = 0; i < 4; i++) {
    const a = inside[i]!;
    const b = inside[(i + 1) % 4]!;
    if (a === b) continue;
    ordered.push({ edge: edges[i]!, start: a && !b });
  }
  if (ordered.length === 0) return [];
  const segments: [number, number][] = [];
  for (let i = 0; i < ordered.length; i++) {
    const from = ordered[i]!;
    if (!from.start) continue;
    // the next crossing in cyclic walk order is always the matching end
    const to = ordered[(i + 1) % ordered.length]!;
    segments.push([from.edge, to.edge]);
  }
  return segments;
}

/** Chain this case's face segments into closed loops of cube-edge indices. */
function caseLoops(mask: number): number[][] {
  const next = new Map<number, number>();
  for (const face of FACES) {
    for (const [from, to] of faceSegments(mask, face)) next.set(from, to);
  }
  const loops: number[][] = [];
  const visited = new Set<number>();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let edge = start;
    // guard: a malformed case can't spin forever (12 edges max)
    for (let guard = 0; guard < 13; guard++) {
      if (visited.has(edge)) break;
      visited.add(edge);
      loop.push(edge);
      const step = next.get(edge);
      if (step === undefined) break;
      edge = step;
      if (edge === start) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function buildTable(): Int8Array[] {
  const table: Int8Array[] = [];
  for (let mask = 0; mask < 256; mask++) {
    const tris: number[] = [];
    for (const loop of caseLoops(mask)) {
      for (let i = 1; i + 1 < loop.length; i++) {
        tris.push(loop[0]!, loop[i]!, loop[i + 1]!);
      }
    }
    table.push(Int8Array.from(tris));
  }
  return table;
}

/**
 * `MC_TRIANGLES[cornerMask]` = flat triples of cube-edge indices, one triple
 * per triangle. `cornerMask` bit i is set when corner i is INSIDE (density
 * below the isolevel). Empty for the all-in/all-out cases.
 */
export const MC_TRIANGLES: readonly Int8Array[] = buildTable();

/** `MC_EDGE_MASK[cornerMask]` = bitfield of the cube edges this case intersects. */
export const MC_EDGE_MASK: Uint16Array = (() => {
  const out = new Uint16Array(256);
  for (let mask = 0; mask < 256; mask++) {
    let bits = 0;
    for (const edge of MC_TRIANGLES[mask]!) bits |= 1 << edge;
    out[mask] = bits;
  }
  return out;
})();
