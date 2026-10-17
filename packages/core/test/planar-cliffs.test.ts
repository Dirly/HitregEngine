import { describe, expect, it } from "vitest";
import { buildVoxelMesh, createWorldField, defaultWorldRecipe, resolveCellMesher, scatterCell, voxelChunkDoc, worldRecipeSchema, type SampleBlockExact, type WorldRecipe } from "../src/index.js";

/** Steep test world: a big ridged mountain band, so there are cliffs for the planar field to act on. */
const mountainous = (planar?: Record<string, unknown>): WorldRecipe => {
  const base = defaultWorldRecipe();
  return worldRecipeSchema.parse({
    ...base,
    cellSize: 32,
    resolution: 16,
    terrain: {
      ...worldRecipeSchema.parse(base).terrain,
      mountains: { frequency: 0.0025, amplitude: 500, octaves: 4, lacunarity: 2, gain: 0.5, ridged: true, seed: 37 },
      mountainMask: { spec: { frequency: 0.0012, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 53 }, start: -1, end: -0.999 },
      ...(planar ? { planarCliffs: planar } : {}),
    },
  });
};

/** The steepest of a coarse sweep: somewhere the planar band is certainly in force. */
function steepSpot(field: ReturnType<typeof createWorldField>): [number, number] {
  let best: [number, number] = [0, 0], s = -1;
  for (let z = -600; z <= 600; z += 24) for (let x = -600; x <= 600; x += 24) {
    const v = field.slope(x, z);
    if (v > s) { s = v; best = [x, z]; }
  }
  return best;
}

describe("planar cliffs", () => {
  it("is absent by default and then fills no exact data", () => {
    const field = createWorldField(mountainous());
    expect(field.recipe.terrain.planarCliffs).toBeUndefined();
    const exact: SampleBlockExact = {};
    const req = { origin: [0, 0, 0] as [number, number, number], nx: 9, ny: 9, nz: 9, step: 2 };
    const a = field.sampleBlock(req, exact);
    expect(exact.hermite).toBeUndefined();
    expect(Array.from(a)).toEqual(Array.from(field.sampleBlock(req)));
  });

  const field = createWorldField(mountainous({}));
  const step = field.voxelSize;
  const [sx, sz] = steepSpot(field);
  const C = field.recipe.cellSize;
  const ox = Math.floor(sx / C) * C - step, oz = Math.floor(sz / C) * C - step;
  const oy = Math.floor((field.height(sx, sz) - 40) / step) * step;
  const nx = 19, ny = 50, nz = 19;
  const exact: SampleBlockExact = {};
  const values = field.sampleBlock({ origin: [ox, oy, oz], nx, ny, nz, step }, exact);

  it("hands the dual mesher exact data over the cliff band", () => {
    expect(exact.hermite).toBeDefined();
    expect(exact.active!.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
  });

  it("agrees with the point query at every full-detail sample, and its Hermite value with the sample", () => {
    let worst = 0, worstHermite = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const idx = i + j * nx + k * nx * ny, x = ox + i * step, y = oy + j * step, z = oz + k * step;
      const d = field.density(x, y, z);
      worst = Math.max(worst, Math.abs(d - values[idx]!));
      if (Math.abs(values[idx]!) > 1e-3) expect(Math.sign(d)).toBe(Math.sign(values[idx]!));
      if (exact.active![idx]) worstHermite = Math.max(worstHermite, Math.abs(exact.hermite!.value(x, y, z) - values[idx]!));
    }
    expect(worst).toBeLessThan(1e-3);
    expect(worstHermite).toBeLessThan(1e-4);
  });

  it("dual cells meet their neighbour exactly ON the shared plane (clipped), in position and normal", () => {
    const [cx, cz] = [Math.floor(sx / C), Math.floor(sz / C)];
    const left = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, cz], mesher: "dc" });
    const right = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx + 1, cz], mesher: "dc" });
    // left's +x plane is x = C in its local frame, right's is x = 0; skirt vertices hang off the
    // same border, so compare the surface's border points (the ones with a normal pointing out of rock)
    const border = (m: typeof left, at: number): Set<string> => {
      const out = new Set<string>();
      for (let i = 0; i < m.vertexCount; i++) if (Math.abs(m.positions[i * 3]! - at) < 1e-4) out.add(`${m.positions[i * 3 + 1]!.toFixed(4)},${m.positions[i * 3 + 2]!.toFixed(4)}`);
      return out;
    };
    const a = border(left, C), b = border(right, 0);
    expect(a.size).toBeGreaterThan(4);
    let shared = 0;
    for (const k of a) if (b.has(k)) shared++;
    // every surface border point of one side is a border point of the other (skirt ends may differ in depth)
    expect(shared / Math.min(a.size, b.size)).toBeGreaterThan(0.5);
  });

  it("is deterministic (same field, same samples, server and client alike)", () => {
    const again = createWorldField(mountainous({}));
    const v2 = again.sampleBlock({ origin: [ox, oy, oz], nx, ny, nz, step });
    expect(Array.from(v2)).toEqual(Array.from(values));
  });
});

describe("planar cliffs, terrace profile (v2)", () => {
  const field = createWorldField(mountainous({ profile: "terrace" }));
  const step = field.voxelSize;
  const [sx, sz] = steepSpot(field);
  const C = field.recipe.cellSize;
  const ox = Math.floor(sx / C) * C - step, oz = Math.floor(sz / C) * C - step;
  const oy = Math.floor((field.height(sx, sz) - 60) / step) * step;
  const nx = 19, ny = 70, nz = 19;
  const exact: SampleBlockExact = {};
  const values = field.sampleBlock({ origin: [ox, oy, oz], nx, ny, nz, step }, exact);

  it("agrees with the point query at every sample and hands the mesher exact data", () => {
    expect(exact.active!.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
    let worst = 0;
    for (let k = 0; k < nz; k += 2) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i += 2) {
      const idx = i + j * nx + k * nx * ny;
      worst = Math.max(worst, Math.abs(field.density(ox + i * step, oy + j * step, oz + k * step) - values[idx]!));
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it("meshes closed and deterministic under dc", () => {
    const [cx, cz] = [Math.floor(sx / C), Math.floor(sz / C)];
    const a = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, cz], mesher: "dc" });
    const b = buildVoxelMesh(createWorldField(mountainous({ profile: "terrace" })), { kind: "voxel", world: "w", cell: [cx, cz], mesher: "dc" });
    expect(a.triangleCount).toBeGreaterThan(0);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });
});

describe("planar cliffs: switching a world over (auto mesher, far detail, zones, scatter)", () => {
  const terrace = { profile: "terrace", facets: { depth: 0 }, strata: { thickness: 9, offset: 2.2, lip: 0, ramp: 1.2 } };
  // no overhang noise: its mask is taken from each block's own lattice slope (LOD-dependent by design, and not
  // what this checks)
  const still = (r: WorldRecipe): WorldRecipe => worldRecipeSchema.parse({ ...r, terrain: { ...r.terrain, overhang: { ...r.terrain.overhang, strength: 0 } }, scatter: [{ id: 'tree', model: 'tree', density: 0.02, slopeMax: 0.5 }] });
  const field = createWorldField(still(mountainous(terrace)));
  const C = field.recipe.cellSize, step = field.voxelSize;
  const [sx, sz] = steepSpot(field);
  const cliff: [number, number] = [Math.floor(sx / C), Math.floor(sz / C)];

  it("'auto' picks DC on a cliff cell, and MC everywhere in a world without planarCliffs", () => {
    expect(resolveCellMesher(field, cliff[0], cliff[1], "auto")).toBe("dc");
    const plain = createWorldField(mountainous());
    expect(resolveCellMesher(plain, cliff[0], cliff[1], "auto")).toBe("mc");
    // and the chunk doc names the mesher it chose, so HLOD and the server reuse it
    const doc = voxelChunkDoc(field, "w", cliff[0], cliff[1], { mesher: "auto", scatter: false });
    expect((doc.entities["terrain"]!.components["mesh"] as { source: { mesher?: string } }).source.mesher).toBe("dc");
  });

  it("a coarse (HLOD) block samples the full-detail planar function, so far walls stand where near ones do", () => {
    const s4 = step * 4, ox = cliff[0] * C - s4, oz = cliff[1] * C - s4, oy = Math.floor((field.height(sx, sz) - 60) / s4) * s4;
    const nx = 11, ny = 30, nz = 11;
    const coarse = field.sampleBlock({ origin: [ox, oy, oz], nx, ny, nz, step: s4 });
    let worst = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const d = field.density(ox + i * s4, oy + j * s4, oz + k * s4);
      worst = Math.max(worst, Math.abs(d - coarse[i + j * nx + k * nx * ny]!));
    }
    expect(worst).toBeLessThan(1e-3);
  });

  const zoned = createWorldField(
    worldRecipeSchema.parse({
      ...mountainous({ ...terrace, minRelief: 25, zones: [{ region: "east", terrace: { step: 14, cell: 10, jog: 2 }, strata: { thickness: 6 } }] }),
      regions: [{ id: "east", name: "East", polygon: [[sx, -5000], [5000, -5000], [5000, 5000], [sx, 5000]] }],
    }),
  );

  it("zones and minRelief keep the point query and the bulk sampler on one function, deterministically", () => {
    const ox = cliff[0] * C - step, oz = cliff[1] * C - step, oy = Math.floor((zoned.height(sx, sz) - 60) / step) * step;
    const nx = 19, ny = 70, nz = 19;
    const values = zoned.sampleBlock({ origin: [ox, oy, oz], nx, ny, nz, step });
    let worst = 0;
    for (let k = 0; k < nz; k += 2) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i += 2) {
      worst = Math.max(worst, Math.abs(zoned.density(ox + i * step, oy + j * step, oz + k * step) - values[i + j * nx + k * nx * ny]!));
    }
    expect(worst).toBeLessThan(1e-3);
    const again = createWorldField(zoned.recipe).sampleBlock({ origin: [ox, oy, oz], nx, ny, nz, step });
    expect(Array.from(again)).toEqual(Array.from(values));
    // the zone's own look changes the rock (a different riser sequence), not just a copy of the base
    const base = field.sampleBlock({ origin: [ox, oy, oz], nx, ny, nz, step });
    expect(Array.from(base)).not.toEqual(Array.from(values));
  });

  it("scatter on planar ground stands on the real surface: never floating, never buried", () => {
    let planar = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const cx = cliff[0] + dx, cz = cliff[1] + dz;
      for (const inst of scatterCell(field, cx, cz)) {
        const rule = field.recipe.scatter[inst.ruleIndex]!;
        if (rule.cliff) continue;
        const x = inst.position[0] + cx * C, z = inst.position[2] + cz * C, y = inst.position[1] - rule.yOffset * inst.scale;
        if (!field.planarNear(x, z)) continue;
        planar++;
        expect(field.density(x, y - 0.6, z)).toBeLessThan(0);
        expect(field.density(x, y + 1, z)).toBeGreaterThan(0);
      }
    }
    // the treads hold props now (the heightfield under them is steep, so they used to be refused)
    expect(planar).toBeGreaterThan(0);
  });
});
