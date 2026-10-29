import { describe, expect, it } from "vitest";
import { auditVoxelMesh, buildVoxelMesh, createWorldField, defaultWorldRecipe, dualMeshExperiment, passageSchema, worldRecipeSchema } from "../src/index.js";

/** Ground from a 2x2 height patch (west, east edge heights), no overhangs, no noise caves. */
function recipe(west: number, east: number, features: Record<string, unknown> = {}) {
  const base = defaultWorldRecipe();
  return worldRecipeSchema.parse({
    ...base, cellSize: 48, resolution: 24, bounds: undefined,
    terrain: { ...base.terrain, overhang: { ...base.terrain.overhang, strength: 0 }, caves: { ...base.terrain.caves, enabled: false } },
    features: {
      passages: [],
      heightPatches: [{ id: "ground", origin: [-200, -200], size: [400, 400], columns: 2, rows: 2, heights: [west, east, west, east], blend: 1, feather: 1 }],
      ...features,
    },
  });
}

describe("mesher blades and seam holes", () => {
  it("never pushes a passage-roof skirt out through thin cover at a chunk border", () => {
    // roof ~3 m under the ground, crossing the x = 48 cell border: the old fixed
    // 6 m upward skirt stood ~3 m proud of the ground as a blade
    const passage = passageSchema.parse({ id: "thin", start: [20, 91, 24], axis: "x", length: 56, width: 6, height: 4, roofRise: 0, wallNoise: 0.3, connectionBand: 1, seed: 3 });
    const field = createWorldField(recipe(100, 100, { passages: [passage] }));
    expect(field.density(48, 94, 24)).toBeGreaterThan(0); // the passage is open at the border
    const audit = auditVoxelMesh(field, { cells: [0, 0, 1, 0] });
    expect(audit.skirtBladeVertices).toBe(0);
    expect(audit.openEdges).toBe(0);
    // every vertex above the ground is a genuine surface vertex (no flap tops)
    const mesh = buildVoxelMesh(field, { kind: "voxel", world: "t", cell: [0, 0] });
    for (let v = 0; v < mesh.vertexCount; v++) expect(mesh.positions[v * 3 + 1]!).toBeLessThan(100.5);
  });

  it("still hangs skirts on ordinary ground (the HLOD crack cover)", () => {
    const field = createWorldField(recipe(100, 130));
    const mesh = buildVoxelMesh(field, { kind: "voxel", world: "t", cell: [0, 0] });
    const S = 48;
    let flapEnds = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      const x = mesh.positions[v * 3]!, y = mesh.positions[v * 3 + 1]!, z = mesh.positions[v * 3 + 2]!;
      const onSide = Math.abs(x) < 1e-4 || Math.abs(x - S) < 1e-4 || Math.abs(z) < 1e-4 || Math.abs(z - S) < 1e-4;
      if (onSide && field.density(x, y, z) < -4) flapEnds++; // well below the surface: a skirt end
    }
    expect(flapEnds).toBeGreaterThan(20);
    expect(auditVoxelMesh(field, { cells: [0, 0, 1, 1] }).skirtBladeVertices).toBe(0);
  });

  it("seals a carve that crosses one cell's band floor but not its neighbour's identically on the seam", () => {
    // sloped ground: the two cells' bands end at different depths, and a hole
    // straddling x = 48 at that depth used to be capped at two heights — open edges
    const field = createWorldField(recipe(100, 160, {
      blobs: [{ id: "deep", center: [48, 106, 24], radius: 6, op: "remove", falloff: 1 }],
    }));
    const audit = auditVoxelMesh(field, { cells: [0, 0, 1, 0] });
    expect(audit.openEdges).toBe(0);
    expect(audit.skirtBladeVertices).toBe(0);
  });

  it("audits a clean flat cell as clean", () => {
    // a lone cell's outer boundary is excluded, so a clean cell reads 0 open edges
    const field = createWorldField(recipe(100, 100));
    const clean = auditVoxelMesh(field, { cells: [0, 0, 0, 0], worst: 3 });
    expect(clean.openEdges).toBe(0);
    expect(clean.bladeVertices).toBe(0);
    expect(clean.triangles).toBeGreaterThan(0);
  });
});

/** Steep ridged mountains (the planar-cliffs test world); `planar` switches the DC cliff band on. */
function mountains(planar?: Record<string, unknown>) {
  const base = defaultWorldRecipe();
  return worldRecipeSchema.parse({
    ...base, cellSize: 32, resolution: 16,
    terrain: {
      ...worldRecipeSchema.parse(base).terrain,
      mountains: { frequency: 0.0025, amplitude: 500, octaves: 4, lacunarity: 2, gain: 0.5, ridged: true, seed: 37 },
      mountainMask: { spec: { frequency: 0.0012, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 53 }, start: -1, end: -0.999 },
      ...(planar ? { planarCliffs: planar } : {}),
    },
  });
}
/** A 3x3 block of cells around the steepest point of a coarse sweep. */
function steepBlock(field: ReturnType<typeof createWorldField>): [number, number, number, number] {
  let best: [number, number] = [0, 0], s = -1;
  for (let z = -600; z <= 600; z += 24) for (let x = -600; x <= 600; x += 24) {
    const v = field.slope(x, z);
    if (v > s) { s = v; best = [x, z]; }
  }
  const C = field.recipe.cellSize, cx = Math.floor(best[0] / C), cz = Math.floor(best[1] / C);
  return [cx - 1, cz - 1, cx + 1, cz + 1];
}
function withLatticeOnlySkirts<T>(run: () => T): T {
  dualMeshExperiment.skirtSection = false;
  try { return run(); } finally { dualMeshExperiment.skirtSection = true; }
}

const TERRACE = { profile: "terrace", facets: { depth: 0 }, strata: { thickness: 9, offset: 2.2, lip: 0, ramp: 1.2 } };

describe("skirts stay inside the rendered rock on steep faces (pale blades)", () => {
  // Terraced planar cliffs: risers, shelves and undercuts crossing cell planes at every angle. Lattice-only skirts
  // (the old clamp) stand proud of them; the section clamp must leave none in air and keep the crack cover.
  const field = createWorldField(mountains(TERRACE));
  const cells = steepBlock(field);

  it("MC: a wall's skirts go into the wall, not down along its face", () => {
    const before = withLatticeOnlySkirts(() => auditVoxelMesh(field, { cells, mesher: "mc" }));
    const after = auditVoxelMesh(field, { cells, mesher: "mc" });
    expect(before.skirtExposed).toBeGreaterThan(20); // the audit sees the fault
    expect(after.skirtExposed).toBe(0);
    expect(after.openEdges).toBe(before.openEdges);
    expect(after.skirtTriangles).toBeGreaterThan(before.skirtTriangles * 0.8); // the HLOD crack cover is still there
  });

  it("DC: no skirt stands proud of a riser or cuts across a shelf's undercut", () => {
    const before = withLatticeOnlySkirts(() => auditVoxelMesh(field, { cells, mesher: "dc" }));
    const after = auditVoxelMesh(field, { cells, mesher: "dc" });
    expect(before.skirtExposed).toBeGreaterThan(20);
    expect(before.skirtPale).toBeGreaterThan(0);
    expect(after.skirtExposed).toBe(0);
    expect(after.openEdges).toBe(before.openEdges);
    expect(after.skirtTriangles).toBeGreaterThan(before.skirtTriangles * 0.8);
  }, 30_000); // two full DC audits: ~2 s alone, past the 5 s default under a parallel suite
});

/**
 * Visible holes at a 1:4 LOD join (the voxel-seams tool's `holes`, ported small): every open border edge of the two
 * cells' surfaces that stands off the other cell's surface is probed through the middle of its gap, along the gap's
 * normal; a hole is a probe that meets no triangle of either cell, skirts included.
 */
function joinHoles(field: ReturnType<typeof createWorldField>, fine: [number, number], coarse: [number, number]): number {
  type T = { p: number[][]; skirt: boolean };
  const C = field.recipe.cellSize;
  const tris = (cell: [number, number], lodStep: number): T[] => {
    const m = buildVoxelMesh(field, { kind: "voxel", world: "t", cell, lodStep, mesher: "dc" });
    const out: T[] = [];
    for (let t = 0; t < m.indices.length / 3; t++) {
      const p = [0, 1, 2].map((k) => { const v = m.indices[t * 3 + k]!; return [m.positions[v * 3]! + cell[0] * C, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]! + cell[1] * C]; });
      const onPlane = [0, 2].some((ax) => p.every((q) => Math.abs(q[ax]! - Math.round(q[ax]! / C) * C) < 1e-4 && Math.abs(q[ax]! - p[0]![ax]!) < 1e-4));
      out.push({ p, skirt: onPlane });
    }
    return out;
  };
  const A = tris(fine, 1), B = tris(coarse, 4);
  const plane = Math.max(fine[0], coarse[0]) * C;
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]!);
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const closest = (q: number[], t: number[][]): number[] => {
    // nearest point on a triangle by dense barycentric sampling is enough for a 1 cm gap test
    let best = t[0]!, bd = Infinity;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8 - i; j++) {
      const u = i / 8, v = j / 8, w = 1 - u - v;
      const c = [0, 1, 2].map((k) => t[0]![k]! * w + t[1]![k]! * u + t[2]![k]! * v);
      const d = Math.hypot(...sub(c, q));
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };
  const hits = (o: number[], d: number[], maxT: number): boolean => [...A, ...B].some(({ p }) => {
    const e1 = sub(p[1]!, p[0]!), e2 = sub(p[2]!, p[0]!), h = cross(d, e2), a = dot(e1, h);
    if (Math.abs(a) < 1e-12) return false;
    const s = sub(o, p[0]!), u = dot(s, h) / a; if (u < 0 || u > 1) return false;
    const q = cross(s, e1), v = dot(d, q) / a; if (v < 0 || u + v > 1) return false;
    const t = dot(e2, q) / a; return t >= 0 && t <= maxT;
  });
  const key = (p: number[]) => p.map((v) => v.toFixed(4)).join(",");
  const edges = new Map<string, { n: number; p: number[]; q: number[]; from: T[] }>();
  for (const [list, other] of [[A, B], [B, A]] as const) for (const { p, skirt } of list) {
    if (skirt) continue;
    for (const [x, y] of [[p[0]!, p[1]!], [p[1]!, p[2]!], [p[2]!, p[0]!]] as const) {
      const k = [key(x), key(y)].sort().join("|");
      const e = edges.get(k);
      if (e) e.n++; else edges.set(k, { n: 1, p: x, q: y, from: other });
    }
  }
  let holes = 0;
  for (const e of edges.values()) {
    if (e.n !== 1 || Math.abs(e.p[0]! - plane) > 8.01 || Math.abs(e.q[0]! - plane) > 8.01) continue;
    const m = e.p.map((v, i) => (v + e.q[i]!) / 2);
    if (m[2]! < fine[1] * C + 8 || m[2]! > (fine[1] + 1) * C - 8) continue;
    let gap = Infinity, qb = m;
    for (const { p, skirt } of e.from) {
      if (skirt || Math.min(...p.map((q) => Math.hypot(...sub(q, m)))) > 20) continue;
      const c = closest(m, p), d = Math.hypot(...sub(c, m));
      if (d < gap) { gap = d; qb = c; }
    }
    if (!(gap > 0.01) || !Number.isFinite(gap)) continue;
    const along = sub(e.q, e.p), al = Math.hypot(...along), u = along.map((x) => x / al), g = sub(qb, m);
    let pn = cross(u, g); const pl = Math.hypot(...pn);
    pn = pl < 1e-6 ? [1, 0, 0] : pn.map((x) => x / pl);
    const p = m.map((v, i) => v + g[i]! * 0.5);
    if (!hits(p.map((v, i) => v - pn[i]!), pn, 2)) holes++;
  }
  return holes;
}

describe("skirts at a 1:4 LOD join on terraced cliffs (DC)", () => {
  it("leave no more visible holes than the lattice-only skirts did", () => {
    const field = createWorldField(mountains({ profile: "terrace", facets: { depth: 0 }, strata: { thickness: 9, offset: 2.2, lip: 0, ramp: 1.2 } }));
    const [cx0, cz0] = steepBlock(field);
    let before = 0, after = 0;
    for (let fz = cz0; fz <= cz0 + 2; fz++) for (let fx = cx0; fx <= cx0 + 1; fx++) for (const flip of [false, true]) {
      // both orientations: the fine cell west of the coarse one, then east of it
      const fine: [number, number] = flip ? [fx + 1, fz] : [fx, fz], coarse: [number, number] = flip ? [fx, fz] : [fx + 1, fz];
      before += withLatticeOnlySkirts(() => joinHoles(field, fine, coarse));
      after += joinHoles(field, fine, coarse);
    }
    expect(after).toBeLessThanOrEqual(before);
  }, 120_000);
});
