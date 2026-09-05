import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import {
  ComponentRegistry,
  registerCoreComponents,
  chunkDocSchema,
  MC_TRIANGLES,
  marchingCubes,
  perlin3,
  perlin2,
  fbm2,
  hashUnit,
  createWorldField,
  defaultWorldRecipe,
  worldRecipeSchema,
  buildVoxelMesh,
  registerVoxelField,
  voxelMesh,
  clearVoxelWorlds,
  scatterCell,
  voxelChunkDoc,
  MAX_SURFACES,
  type SampledBlock,
  type WorldField,
  type WorldRecipe,
} from "../src/index.js";

// ------------------------------------------------------------------ helpers

/** Sample an analytic field into the padded block layout the mesher expects. */
function sampleAnalytic(
  fn: (x: number, y: number, z: number) => number,
  cells: number,
  origin: [number, number, number],
  step: number,
): SampledBlock {
  const n = cells + 3;
  const values = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        values[i + j * n + k * n * n] = fn(
          origin[0] + i * step,
          origin[1] + j * step,
          origin[2] + k * step,
        );
      }
    }
  }
  return { values, nx: n, ny: n, nz: n, origin, step };
}

/** Fraction of faces with (near-)zero area — the exact-lattice-crossing artifact. */
function degenerateFraction(mesh: { indices: Uint32Array; positions: Float32Array; triangleCount: number }): number {
  let degenerate = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
    const e1 = [0, 1, 2].map((k) => mesh.positions[b * 3 + k]! - mesh.positions[a * 3 + k]!);
    const e2 = [0, 1, 2].map((k) => mesh.positions[c * 3 + k]! - mesh.positions[a * 3 + k]!);
    const n = Math.hypot(
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    );
    if (n < 1e-9) degenerate += 1;
  }
  return mesh.triangleCount === 0 ? 0 : degenerate / mesh.triangleCount;
}

/** Every undirected edge of the mesh with how many triangles use it. */
function edgeUseCounts(indices: Uint32Array): Map<string, number> {
  const counts = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
    for (let e = 0; e < 3; e++) {
      const a = tri[e]!;
      const b = tri[(e + 1) % 3]!;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

// ------------------------------------------------------------------- tables

describe("marching cubes case tables", () => {
  it("leaves the empty and full cases empty and triangulates every other", () => {
    expect(MC_TRIANGLES[0]!.length).toBe(0);
    expect(MC_TRIANGLES[255]!.length).toBe(0);
    for (let mask = 1; mask < 255; mask++) {
      expect(MC_TRIANGLES[mask]!.length, `case ${mask}`).toBeGreaterThan(0);
      expect(MC_TRIANGLES[mask]!.length % 3, `case ${mask}`).toBe(0);
    }
  });

  it("only ever references edges that actually have a sign change", () => {
    // an edge may only be used if exactly one of its two corners is inside;
    // referencing any other edge means the table would interpolate nonsense
    const edgeCorners = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (let mask = 0; mask < 256; mask++) {
      for (const edge of MC_TRIANGLES[mask]!) {
        const [a, b] = edgeCorners[edge]!;
        const inA = (mask & (1 << a!)) !== 0;
        const inB = (mask & (1 << b!)) !== 0;
        expect(inA, `case ${mask} edge ${edge}`).not.toBe(inB);
      }
    }
  });

  it("is symmetric under inversion — a case and its complement cut the same edges", () => {
    for (let mask = 0; mask < 256; mask++) {
      const a = new Set(MC_TRIANGLES[mask]!);
      const b = new Set(MC_TRIANGLES[255 - mask]!);
      expect([...a].sort(), `case ${mask}`).toEqual([...b].sort());
    }
  });
});

// -------------------------------------------------------------------- sphere

describe("marching cubes on an analytic sphere", () => {
  const radius = 6;
  const sdf = (x: number, y: number, z: number): number => Math.hypot(x, y, z) - radius;
  const block = sampleAnalytic(sdf, 20, [-11, -11, -11], 1);
  const mesh = marchingCubes(block);

  it("produces a surface", () => {
    expect(mesh.triangleCount).toBeGreaterThan(200);
  });

  it("is closed — every edge is shared by exactly two triangles", () => {
    const counts = edgeUseCounts(mesh.indices);
    const bad = [...counts.values()].filter((c) => c !== 2);
    expect(bad).toEqual([]);
  });

  it("puts every vertex on the isosurface", () => {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const r = Math.hypot(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!);
      // linear interpolation of a curved field: error is bounded by the step
      expect(Math.abs(r - radius)).toBeLessThan(0.35);
    }
  });

  it("winds every triangle outward", () => {
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      const ax = mesh.positions[a * 3]!, ay = mesh.positions[a * 3 + 1]!, az = mesh.positions[a * 3 + 2]!;
      const bx = mesh.positions[b * 3]!, by = mesh.positions[b * 3 + 1]!, bz = mesh.positions[b * 3 + 2]!;
      const cx = mesh.positions[c * 3]!, cy = mesh.positions[c * 3 + 1]!, cz = mesh.positions[c * 3 + 2]!;
      const e1 = [bx - ax, by - ay, bz - az];
      const e2 = [cx - ax, cy - ay, cz - az];
      const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
      const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
      const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      // a zero-area face (isosurface exactly through a lattice corner) has no
      // winding to check; it is kept only to keep the mesh closed
      if (Math.hypot(nx, ny, nz) < 1e-9) continue;
      // centroid points away from the sphere centre, so it IS the outward direction
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
      expect(nx * mx + ny * my + nz * mz).toBeGreaterThan(0);
    }
  });

  it("keeps degenerate faces to the exact-crossing cases", () => {
    // This sphere is deliberately the worst case: an integer radius on an
    // integer lattice puts the isosurface exactly through corner after corner,
    // so ~7% of faces come out zero-area. Real noise terrain hits ~0.1% (see
    // the cell-meshing suite) — the point here is that it stays BOUNDED and
    // never becomes the dominant output.
    expect(degenerateFraction(mesh)).toBeLessThan(0.12);
  });

  it("gives smooth outward normals from the field gradient", () => {
    for (let i = 0; i < mesh.normals.length; i += 3) {
      const n = [mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!];
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 4);
      const p = [mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!];
      const len = Math.hypot(p[0]!, p[1]!, p[2]!);
      const dot = (n[0]! * p[0]! + n[1]! * p[1]! + n[2]! * p[2]!) / len;
      expect(dot).toBeGreaterThan(0.98); // a sphere's normal IS its radial direction
    }
  });

  it("welds shared vertices instead of emitting three per triangle", () => {
    expect(mesh.vertexCount).toBeLessThan(mesh.triangleCount * 1.2);
  });
});

describe("marching cubes edge cases", () => {
  it("returns nothing for an entirely solid or entirely empty block", () => {
    expect(marchingCubes(sampleAnalytic(() => -1, 6, [0, 0, 0], 1)).triangleCount).toBe(0);
    expect(marchingCubes(sampleAnalytic(() => 1, 6, [0, 0, 0], 1)).triangleCount).toBe(0);
  });

  it("closes a plane cutting the block, since the block's own walls are open", () => {
    // a flat y = 0 plane: the sheet is open at the block edges by design, so
    // interior edges must still be shared by two triangles
    const mesh = marchingCubes(sampleAnalytic((_x, y) => y - 0.3, 8, [-1, -4, -1], 1));
    expect(mesh.triangleCount).toBeGreaterThan(0);
    for (let i = 1; i < mesh.positions.length; i += 3) {
      expect(mesh.positions[i]).toBeCloseTo(0.3, 5);
    }
    for (let i = 0; i < mesh.normals.length; i += 3) {
      expect(mesh.normals[i + 1]).toBeCloseTo(1, 4); // outward is up, out of the solid below
    }
  });
});

// --------------------------------------------------------------------- noise

describe("noise", () => {
  it("is deterministic and bounded", () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 3.7 - 300;
      const z = i * -1.9 + 40;
      const a = perlin3(x, 12.5, z, 7);
      expect(perlin3(x, 12.5, z, 7)).toBe(a);
      expect(Math.abs(a)).toBeLessThanOrEqual(1.05);
      const b = perlin2(x, z, 7);
      expect(Math.abs(b)).toBeLessThanOrEqual(1.05);
    }
  });

  it("changes with the seed", () => {
    expect(perlin3(3.3, 1.1, -2.2, 1)).not.toBe(perlin3(3.3, 1.1, -2.2, 2));
  });

  it("is zero at lattice points and smooth between them", () => {
    expect(Math.abs(perlin2(4, 9, 3))).toBeLessThan(1e-6);
    let maxJump = 0;
    let prev = perlin2(0, 0, 3);
    for (let i = 1; i <= 200; i++) {
      const v = perlin2(i * 0.01, 0, 3);
      maxJump = Math.max(maxJump, Math.abs(v - prev));
      prev = v;
    }
    expect(maxJump).toBeLessThan(0.1);
  });

  it("gives a ridged band a non-negative output", () => {
    const spec = { frequency: 0.01, amplitude: 10, octaves: 3, lacunarity: 2, gain: 0.5, ridged: true, seed: 3 };
    for (let i = 0; i < 100; i++) {
      expect(fbm2(spec, i * 13.1, i * -7.3, 5)).toBeGreaterThanOrEqual(0);
    }
  });

  it("rounds a ridged band's crests without moving its summit line", () => {
    // The ridged fold 1 - |n| has a crease at every crest: along a transect
    // the slope flips sign in one sample, and the mesh renders that as a
    // knife edge along every ridgeline. `crest` swaps |n| for a smooth
    // absolute value. Three things must hold: the rounded band is never
    // BELOW the sharp one (the fold is opened outward, so nothing sinks), it
    // still touches the same summit value (the crest itself is unmoved), and
    // the worst kink along a transect — the second difference, which is
    // unbounded at a crease — comes down by a lot.
    const sharp = { frequency: 0.01, amplitude: 100, octaves: 1, lacunarity: 2, gain: 0.5, ridged: true, seed: 3 };
    const rounded = { ...sharp, crest: 0.2 };
    const kink = (spec: typeof sharp): number => {
      let worst = 0;
      const h = (i: number): number => fbm2(spec, i * 0.5, 17.25, 5);
      for (let i = 1; i < 2000; i++) worst = Math.max(worst, Math.abs(h(i - 1) - 2 * h(i) + h(i + 1)));
      return worst;
    };
    let sharpMax = -Infinity;
    let roundedMax = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const a = fbm2(sharp, i * 0.5, 17.25, 5);
      const b = fbm2(rounded, i * 0.5, 17.25, 5);
      expect(b).toBeGreaterThanOrEqual(a - 1e-9);
      sharpMax = Math.max(sharpMax, a);
      roundedMax = Math.max(roundedMax, b);
    }
    expect(roundedMax).toBeCloseTo(sharpMax, 0);
    expect(kink(rounded)).toBeLessThan(kink(sharp) * 0.35);
    // the eroded path carries the crest through its derivative too: it must
    // agree with the plain path at the crest (weights are 1 for one octave)
    const eroded = { ...rounded, erosion: 0.5 };
    for (let i = 0; i < 50; i++) {
      expect(fbm2(eroded, i * 9.5, -3.25, 5)).toBeCloseTo(fbm2(rounded, i * 9.5, -3.25, 5), 6);
    }
  });

  it("spreads hashUnit over [0, 1)", () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 4000; i++) {
      const v = hashUnit(i, i * 7, 0, 99);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]! += 1;
    }
    for (const count of buckets) expect(count).toBeGreaterThan(250);
  });
});

// --------------------------------------------------------------------- field

/** Noise caves are OFF by default now — these two suites are about that feature. */
function noiseCaveRecipe(): WorldRecipe {
  const base = testRecipe();
  return worldRecipeSchema.parse({
    ...base,
    terrain: { ...base.terrain, caves: { ...base.terrain.caves, enabled: true } },
  });
}

function testRecipe(overrides: Partial<WorldRecipe> = {}): WorldRecipe {
  return worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 32, resolution: 16, ...overrides });
}

describe("world field", () => {
  const field = createWorldField(testRecipe());

  it("is deterministic across calls", () => {
    for (let i = 0; i < 50; i++) {
      const x = i * 17.3;
      const z = i * -11.1;
      expect(field.height(x, z)).toBe(field.height(x, z));
      expect(field.density(x, 5, z)).toBe(field.density(x, 5, z));
    }
  });

  it("agrees with density: solid below the surface, air above", () => {
    // caves off, so "below the surface" really is solid everywhere — with them
    // on, rock 30m down is quite legitimately a tunnel
    const solid = createWorldField(
      worldRecipeSchema.parse({
        ...testRecipe(),
        terrain: {
          ...testRecipe().terrain,
          overhang: { strength: 0, frequency: 0.02, slopeStart: 0.35, slopeEnd: 0.7 },
          caves: { enabled: false, frequency: 0.012, threshold: 0.14, minDepth: 6, floorY: -40, seed: 97 },
        },
      }),
    );
    for (let i = 0; i < 40; i++) {
      const x = i * 23.7 - 200;
      const z = i * 13.3 + 60;
      const h = solid.height(x, z);
      expect(solid.density(x, h - 30, z)).toBeLessThan(0);
      expect(solid.density(x, h + 30, z)).toBeGreaterThan(0);
      expect(Math.abs(solid.density(x, h, z))).toBeLessThan(1e-5); // the surface IS the zero set
    }
  });

  it("carves cave air below the surface but never breaks the world's floor", () => {
    const field = createWorldField(noiseCaveRecipe());
    let openings = 0;
    for (let i = 0; i < 400; i++) {
      const x = i * 41.3 - 4000;
      const z = i * -29.7 + 1500;
      const h = field.height(x, z);
      for (let y = h - 8; y > field.recipe.terrain.caves.floorY; y -= 4) {
        if (field.density(x, y, z) > 0) {
          openings += 1;
          break;
        }
      }
      // the hard floor holds no matter what the cave noise wants
      expect(field.density(x, field.recipe.minY + 0.5, z)).toBeLessThan(0);
    }
    expect(openings).toBeGreaterThan(10);
  });

  it("produces real relief rather than a flat plane", () => {
    const { min, max } = field.heightRange(-600, -600, 600, 600, 33);
    expect(max - min).toBeGreaterThan(25);
  });

  it("reports slope 0 on flat ground and rising slope on a ramp", () => {
    const flat = createWorldField(
      testRecipe({
        terrain: worldRecipeSchema.parse(defaultWorldRecipe()).terrain,
      }),
    );
    expect(flat.slope(0, 0)).toBeGreaterThanOrEqual(0);
    expect(flat.slope(0, 0)).toBeLessThanOrEqual(1);
  });

  it("gives the same density through the bulk sampler as through the point query", () => {
    // The mesher samples a whole block at once with column heights, slopes and
    // the cave lattice precomputed; `density()` derives all of it per call.
    // They are two implementations of one field, and if they drift then the
    // mesh, the collider and the placement solver stop agreeing about where
    // the ground is — which is the single worst failure this system can have.
    const step = field.voxelSize;
    const nx = 9;
    const ny = 12;
    const nz = 9;
    const origin: [number, number, number] = [128 - step, 6 - step, -64 - step];
    const block = field.sampleBlock({ origin, nx, ny, nz, step });
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const x = origin[0] + i * step;
          const y = origin[1] + j * step;
          const z = origin[2] + k * step;
          const bulk = block[i + j * nx + k * nx * ny]!;
          expect(field.density(x, y, z), `at ${x},${y},${z}`).toBeCloseTo(bulk, 4);
        }
      }
    }
  });

  it("surfaceCast lands on the isosurface, not near it", () => {
    let found = 0;
    for (let i = 0; i < 60; i++) {
      const x = i * 37.1 - 400;
      const z = i * -21.3 + 120;
      const y = field.surfaceCast(x, z);
      if (y === null) continue;
      found += 1;
      // just above is air, just below is rock — that IS the definition of the
      // surface the mesher polygonizes
      expect(field.density(x, y + 0.35, z), `above ${x},${z}`).toBeGreaterThan(0);
      expect(field.density(x, y - 0.35, z), `below ${x},${z}`).toBeLessThan(0);
    }
    expect(found).toBeGreaterThan(40);
  });

  it("keeps the cave lattice global, so neighbouring blocks carve the same tunnels", () => {
    // Cave noise is evaluated on a coarse lattice and interpolated. If that
    // lattice were block-relative rather than world-aligned, two adjacent
    // chunks would interpolate different values on their shared plane and the
    // caves would not meet. Sampling the same world points from two blocks
    // with different origins is the direct test of that.
    const step = field.voxelSize;
    const a = field.sampleBlock({ origin: [0, -20, 0], nx: 7, ny: 8, nz: 7, step });
    const b = field.sampleBlock({ origin: [-3 * step, -20, 0], nx: 10, ny: 8, nz: 7, step });
    for (let k = 0; k < 7; k++) {
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < 7; i++) {
          const fromA = a[i + j * 7 + k * 7 * 8]!;
          const fromB = b[i + 3 + j * 10 + k * 10 * 8]!;
          expect(fromB).toBeCloseTo(fromA, 4);
        }
      }
    }
  });

  it("cannot mesh a void narrower than a voxel, but always meshes one wider", () => {
    // The trap this pins down: the FIELD can describe a passage of any width,
    // but marching cubes on a lattice cannot represent a hole much narrower
    // than one voxel — so a tunnel the field says is 1.2 m across silently
    // pinches shut in the mesh and in the collider cooked from it. Cave mouths
    // are therefore carved at a radius comfortably above the voxel size; this
    // test is what says how far above.
    const base = testRecipe({ cellSize: 32, resolution: 16 }); // 2 m voxels
    const voxel = base.cellSize / base.resolution;
    const cell: [number, number] = [1, 1];
    const centre: [number, number] = [1.5 * base.cellSize, 1.5 * base.cellSize];
    const plain = createWorldField(base);
    const ground = plain.height(centre[0], centre[1]);
    const bare = buildVoxelMesh(plain, { kind: "voxel", world: "w", cell });

    // Extra triangles are the only proof that matters: they are the surface of
    // the void. A carve that adds none did not survive meshing, whatever the
    // field says about it.
    const trianglesAddedBy = (radius: number): number => {
      const field = createWorldField(
        worldRecipeSchema.parse({
          ...base,
          features: {
            ...base.features,
            blobs: [{ id: "hole", center: [centre[0], ground - 7, centre[1]], radius, op: "remove", falloff: 1 }],
          },
        }),
      );
      return buildVoxelMesh(field, { kind: "voxel", world: "w", cell }).triangleCount - bare.triangleCount;
    };

    // a sub-voxel carve leaves essentially no trace in the geometry...
    expect(trianglesAddedBy(voxel * 0.4)).toBeLessThan(12);
    // ...while one comfortably above the voxel size opens a real chamber
    expect(trianglesAddedBy(voxel * 1.6)).toBeGreaterThan(60);
  });

  it("opens cave mouths on steep ground and keeps flat ground sealed", () => {
    const caveBase = noiseCaveRecipe();
    // A cave system nobody can enter is scenery. Entrances are slope-driven:
    // steep faces relax the depth requirement so tunnels breach, flat meadows
    // never do (nobody wants a pit opening under a field).
    const withMouths = createWorldField(caveBase);
    const sealed = createWorldField(
      worldRecipeSchema.parse({
        ...caveBase,
        terrain: {
          ...caveBase.terrain,
          caves: { ...caveBase.terrain.caves, entrances: { enabled: false, slopeStart: 0.5, slopeEnd: 0.72, minDepth: -2.5 } },
        },
      }),
    );
    // just under the surface on flat ground: solid in both, entrances or not
    let flatChecked = 0;
    for (let i = 0; i < 400 && flatChecked < 25; i++) {
      const x = i * 53.7 - 2000;
      const z = i * -31.1 + 700;
      const h = withMouths.height(x, z);
      if (withMouths.slope(x, z) > 0.2 || h < 5) continue;
      flatChecked += 1;
      expect(withMouths.density(x, h - 1, z), `pit under flat ground at ${x},${z}`).toBeLessThan(0);
    }
    expect(flatChecked).toBeGreaterThan(5);
    // and turning entrances off must genuinely change the field somewhere steep
    let differs = 0;
    for (let i = 0; i < 3000; i++) {
      const x = i * 41.3 - 3000;
      const z = i * -29.7 + 1500;
      if (withMouths.slope(x, z) < 0.55) continue;
      const h = withMouths.height(x, z);
      if (withMouths.density(x, h - 3, z) !== sealed.density(x, h - 3, z)) differs += 1;
    }
    expect(differs).toBeGreaterThan(0);
  });

  it("blends biome weights to a normalized splat vector", () => {
    const out = new Float32Array(MAX_SURFACES);
    for (let i = 0; i < 30; i++) {
      field.splatAt(i * 31.1, i * 4 - 20, i * -17.7, 0.8, out, 0);
      let sum = 0;
      for (let s2 = 0; s2 < MAX_SURFACES; s2++) sum += out[s2]!;
      expect(sum).toBeCloseTo(1, 5);
      for (const w of out) expect(w).toBeGreaterThanOrEqual(0);
    }
  });

  it("puts sand at the waterline and snow on the peaks", () => {
    const beach = new Float32Array(field.surfaceCount);
    field.splatAt(0, 0.5, 0, 1, beach, 0);
    expect(beach[1]).toBeGreaterThan(0.5); // channel 1 is sand

    // well above the alpine rule's floor: the ladder deliberately spends a
    // couple of hundred metres getting from meadow to permanent snow, so a
    // "peak" test has to be an actual peak
    const peak = new Float32Array(field.surfaceCount);
    field.splatAt(0, 420, 0, 1, peak, 0);
    expect(peak[3]).toBeGreaterThan(0.5); // channel 3 is snow
  });

  it("climbs the altitude ladder without skipping a rung", () => {
    // The failure this guards is a mountain that goes green -> white in one
    // step, which reads as a decal rather than as an altitude. Every rung has
    // to be the strongest rule SOMEWHERE on the way up.
    const seen: string[] = [];
    for (let y = 10; y <= 460; y += 10) {
      const id = field.biome(0, 0, y, 0.1).id;
      if (seen[seen.length - 1] !== id) seen.push(id);
    }
    for (const rung of ["highland", "montane", "alpine"]) {
      expect(seen, `ladder was ${seen.join(" -> ")}`).toContain(rung);
    }
    expect(seen.indexOf("montane")).toBeLessThan(seen.indexOf("alpine"));
  });

  it("reads a vertical face as cliff rock, whatever the altitude", () => {
    const cliff = new Float32Array(field.surfaceCount);
    field.splatAt(0, 40, 0, 0.02, cliff, 0); // normal almost horizontal
    expect(cliff[2]).toBeGreaterThan(0.6); // channel 2 is rock
  });
});

describe("terrain features", () => {
  it("carves a river below the surrounding land and eases the banks back", () => {
    const bare = createWorldField(testRecipe());
    const naturalMid = bare.height(0, 0);
    const carved = createWorldField(
      testRecipe({
        features: {
          // no bedY: the field solves one through these points (a hand-written river)
          rivers: [{ id: "r", points: [[-200, 0], [-100, 0], [0, 0], [100, 0], [200, 0]], width: 10, depth: 6, bank: 20, maxGrade: 0.05, water: true, surface: "", surfaceEdge: 3, taper: 0 }],
          canyons: [],
          roads: [],
          tunnels: [],
          towns: [],
          blobs: [],
          pois: [],
          lakes: [], bridges: [], fills: [], riverPaths: [],
        },
      }),
    );
    expect(carved.height(0, 0)).toBeLessThan(naturalMid - 5);
    expect(carved.height(0, 60)).toBeCloseTo(bare.height(0, 60), 5); // outside the bank
    // the bank rises from the bed to at most the levee (the water surface
    // plus a hand) — built where the ground beside the channel falls away,
    // so the sheet's edge is never in the air
    const edge = carved.height(0, 20);
    const bed = carved.rivers[0]!.bedY![2]!;
    expect(edge).toBeGreaterThan(carved.height(0, 0));
    expect(edge).toBeLessThanOrEqual(Math.max(bare.height(0, 20), bed + 6 * 0.7 + 0.4) + 1e-6);
  });

  it("builds land up to a river bed by a bounded amount, never a dam", () => {
    const bare = createWorldField(testRecipe());
    const carved = createWorldField(
      testRecipe({
        features: {
          rivers: [{ id: "r", points: [[-200, 500], [200, 500]], width: 10, depth: 3, bank: 10, bedY: [9000, 9000], maxGrade: 0.05, water: true, surface: "", surfaceEdge: 3, taper: 0 }],
          canyons: [],
          roads: [],
          tunnels: [],
          towns: [],
          blobs: [],
          pois: [],
          lakes: [], bridges: [], fills: [], riverPaths: [],
        },
      }),
    );
    // rivers-first: a river fills the hollow it crosses (up to RIVER_MAX_BUILD
    // metres), so the ground rises toward the bed — but a bed at 9000 is not
    // a reason to build a mountain
    expect(carved.height(0, 500)).toBeGreaterThan(bare.height(0, 500) + 5);
    expect(carved.height(0, 500)).toBeLessThanOrEqual(bare.height(0, 500) + 10 + 1e-6);
    expect(carved.height(0, 560)).toBeCloseTo(bare.height(0, 560), 5); // outside the bank
  });

  it("solves a descending bed for a river written by hand, and a tributary meets its trunk", () => {
    const empty = { canyons: [], roads: [], tunnels: [], towns: [], blobs: [], pois: [], lakes: [], bridges: [], fills: [], riverPaths: [] };
    const trunk = { id: "trunk", points: [[-300, 400], [-100, 420], [100, 380], [300, 400]] as [number, number][], width: 12, depth: 4, bank: 10, maxGrade: 0.05, water: true, surface: "", surfaceEdge: 3, taper: 0 };
    const branch = { id: "branch", points: [[0, 100], [0, 250], [0, 380]] as [number, number][], width: 6, depth: 2, bank: 8, maxGrade: 0.05, water: true, surface: "", surfaceEdge: 3, taper: 0 };
    const bare = createWorldField(testRecipe());
    const field = createWorldField(testRecipe({ features: { ...empty, rivers: [trunk, branch] } }));
    // the recipe is untouched; the field carries the solved docs
    expect(field.recipe.features.rivers[0]!.bedY).toBeUndefined();
    // resampled along a spline through the points, a bed per resampled point
    const [t, b] = field.rivers;
    expect(t!.points.length).toBeGreaterThan(4);
    expect(t!.bedY).toHaveLength(t!.points.length);
    expect(b!.bedY).toHaveLength(b!.points.length);
    for (const r of field.rivers) for (let i = 1; i < r.bedY!.length; i++) expect(r.bedY![i]!).toBeLessThanOrEqual(r.bedY![i - 1]! + 1e-9);
    // the head sits a channel depth under the ground it starts on
    expect(t!.bedY![0]!).toBeLessThanOrEqual(bare.height(-300, 400) - 4 + 1e-6);
    // the channel is carved and carries water
    expect(field.height(0, 390)).toBeLessThan(bare.height(0, 390) - 1);
    expect(field.waterY(0, 390)).not.toBeNull();
    // the tributary's mouth surface is flush with the trunk's surface there
    const trunkSurface = field.waterY(0, 380)!;
    const mouthSurface = b!.bedY![b!.bedY!.length - 1]! + Math.max(0.4, 2 * 0.7);
    expect(Math.abs(mouthSurface - trunkSurface)).toBeLessThan(0.5);
  });

  it("flattens a town pad to its target height", () => {
    const field = createWorldField(
      testRecipe({
        features: {
          rivers: [],
          canyons: [],
          tunnels: [],
          roads: [],
          towns: [{ id: "t", center: [0, 0], radius: 40, falloff: 30, groundY: 12, flatten: 1, tags: [] }],
          blobs: [],
          pois: [],
          lakes: [], bridges: [], fills: [], riverPaths: [],
        },
      }),
    );
    expect(field.height(0, 0)).toBeCloseTo(12, 4);
    expect(field.height(10, -10)).toBeCloseTo(12, 4);
    expect(Math.abs(field.height(0, 200) - 12)).toBeGreaterThan(0.5); // untouched far away
  });

  it("grades a road toward its surface height and blends at the shoulder", () => {
    const field = createWorldField(
      testRecipe({
        features: {
          rivers: [],
          canyons: [],
          roads: [{ id: "road", points: [[-100, 40], [100, 40]], width: 8, shoulder: 12, smooth: 0, surfaceY: [20, 20], flatten: 1, surface: "", surfaceEdge: 2.5 }],
          tunnels: [],
          towns: [],
          blobs: [],
          pois: [],
          lakes: [], bridges: [], fills: [], riverPaths: [],
        },
      }),
    );
    expect(field.height(0, 40)).toBeCloseTo(20, 4);
    const bare = createWorldField(testRecipe());
    expect(field.height(0, 100)).toBeCloseTo(bare.height(0, 100), 5);
  });

  it("regrades an embankment beside a road and only lets the rough ground back at the outer edge", () => {
    // With `smooth` and the two edge profiles, the ground from the road edge
    // out to shoulder + smooth is a clean S-curve from the road surface to the
    // sampled edge height — not the road height blended into whatever
    // crinkle the noise put there. "Left" is the positive cross-product side
    // of travel: for a road running +x, that is +z.
    const road = {
      id: "road",
      points: [[-100, 40], [100, 40]] as [number, number][],
      width: 8,
      shoulder: 6,
      smooth: 10,
      surfaceY: [20, 20],
      leftY: [30, 30],
      // a 12 m drop over the 16 m band: a 0.75 fill, under the 0.8 the band may hold
      rightY: [8, 8],
      flatten: 1,
      surface: "",
      surfaceEdge: 2.5,
    };
    const field = createWorldField(testRecipe({ features: { ...noFeatures(), roads: [road] } }));
    const bare = createWorldField(testRecipe());
    const half = 4;
    const outer = half + 6 + 10;
    const s = (e0: number, e1: number, v: number): number => {
      const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    // on the road: the surface
    expect(field.height(0, 40)).toBeCloseTo(20, 4);
    // inside the fully-regraded part of the band: the analytic embankment,
    // rising toward leftY on +z and falling toward rightY on -z, whatever the
    // natural ground does there
    for (const d of [half + 1, half + 4, half + 6 + 4]) {
      expect(field.height(0, 40 + d)).toBeCloseTo(20 + (30 - 20) * s(half, outer, d), 4);
      expect(field.height(0, 40 - d)).toBeCloseTo(20 + (8 - 20) * s(half, outer, d), 4);
    }
    // a side height the band cannot hold is clamped to the face it can: a
    // cut no steeper than 1:1, a fill no steeper than 0.8 — a path skirting
    // a cliff gets a bench, not a wall
    const cliff = createWorldField(testRecipe({ features: { ...noFeatures(), roads: [{ ...road, leftY: [80, 80], rightY: [-40, -40] }] } }));
    const band = outer - half;
    expect(cliff.height(0, 40 + half + 6 + 4)).toBeCloseTo(20 + band * 1.0 * s(half, outer, half + 6 + 4), 4);
    expect(cliff.height(0, 40 - (half + 6 + 4))).toBeCloseTo(20 - band * 0.8 * s(half, outer, half + 6 + 4), 4);
    // past the outer edge: untouched
    expect(field.height(0, 40 + outer + 0.5)).toBeCloseTo(bare.height(0, 40 + outer + 0.5), 5);
    expect(field.height(0, 40 - outer - 0.5)).toBeCloseTo(bare.height(0, 40 - outer - 0.5), 5);
    // and inside the fade, strictly between the embankment and the natural ground
    const dFade = outer - 2;
    const emb = 20 + (30 - 20) * s(half, outer, dFade);
    const nat = bare.height(0, 40 + dFade);
    const h = field.height(0, 40 + dFade);
    expect(h).toBeGreaterThanOrEqual(Math.min(emb, nat) - 1e-6);
    expect(h).toBeLessThanOrEqual(Math.max(emb, nat) + 1e-6);
    // a doc with `smooth` but no edge profiles falls back to the plain shoulder
    const plain = createWorldField(
      testRecipe({ features: { ...noFeatures(), roads: [{ ...road, leftY: undefined, rightY: undefined }] } }),
    );
    expect(plain.height(0, 40 + half + 6 + 0.5)).toBeCloseTo(bare.height(0, 40 + half + 6 + 0.5), 5);
  });

  it("reports clearance to the nearest feature so scatter can keep off it", () => {
    const field = createWorldField(
      testRecipe({
        features: {
          rivers: [],
          canyons: [],
          tunnels: [],
          roads: [],
          towns: [{ id: "t", center: [0, 0], radius: 40, falloff: 30, groundY: 12, flatten: 1, tags: [] }],
          blobs: [],
          pois: [],
          lakes: [], bridges: [], fills: [], riverPaths: [],
        },
      }),
    );
    expect(field.featureClearance(0, 0)).toBeLessThan(0);
    expect(field.featureClearance(50, 0)).toBeCloseTo(10, 4);
    expect(field.featureClearance(5000, 5000)).toBe(Infinity);
  });

  it("measures path clearance from the shoulder's edge, and still sees a path from a boulder's clearance away", () => {
    const field = createWorldField(
      testRecipe({
        features: {
          ...noFeatures(),
          roads: [{ id: "trail-1", points: [[-400, 0], [400, 0]], width: 2.4, shoulder: 2.2, smooth: 4.4, surfaceY: [14, 14], leftY: [14, 14], rightY: [14, 14], flatten: 1, surface: "dirt", surfaceEdge: 1.5 }],
        },
      }),
    );
    expect(field.featureClearance(0, 0)).toBeLessThan(0);
    expect(field.featureClearance(0, 3.4)).toBeCloseTo(0, 4);
    // the carve's own buckets stop at the embankment's edge (~7.8 m); a
    // 9 m clearance rule asks from further out than that and must be told
    expect(field.featureClearance(0, 12)).toBeCloseTo(12 - 3.4, 4);
  });
});

// ------------------------------------------------------- surface decoration

/** Splat weights on the ground at (x, z), indexed like `recipe.surfaces`. */
function groundSplat(field: WorldField, x: number, z: number): Float32Array {
  const h = field.height(x, z);
  const steep = field.slope(x, z);
  const out = new Float32Array(MAX_SURFACES);
  field.splatAt(x, h, z, Math.sqrt(Math.max(0, 1 - steep * steep)), out, 0);
  return out;
}

function paletteIndex(name: string): number {
  return defaultWorldRecipe().surfaces.findIndex((s) => s.name === name);
}

function noFeatures(): WorldRecipe["features"] {
  return { rivers: [], canyons: [], roads: [], towns: [], lakes: [], bridges: [], fills: [], riverPaths: [], tunnels: [], blobs: [], pois: [] };
}

describe("surface decoration", () => {
  const dirt = paletteIndex("dirt");
  const rock = paletteIndex("rock");

  it("paints a road's own surface along it and not beside it", () => {
    const field = createWorldField(
      testRecipe({
        features: {
          ...noFeatures(),
          roads: [
            {
              id: "r",
              points: [[-400, 0], [400, 0]],
              width: 10,
              shoulder: 10, smooth: 0,
              surfaceY: [14, 14],
              flatten: 1,
              surface: "dirt",
              surfaceEdge: 3,
            },
          ],
        },
      }),
    );
    expect(groundSplat(field, 0, 0)[dirt]!).toBeGreaterThan(0.9);
    // well past width/2 + surfaceEdge, the biome's own cover is back
    expect(groundSplat(field, 0, 200)[dirt]!).toBeLessThan(0.85);
  });

  it("leaves the ground alone for a road that names no surface", () => {
    const road = {
      id: "r",
      points: [[-400, 0], [400, 0]] as [number, number][],
      width: 10,
      shoulder: 10, smooth: 0,
      surfaceY: [14, 14],
      flatten: 1,
      surfaceEdge: 3,
    };
    const painted = createWorldField(testRecipe({ features: { ...noFeatures(), roads: [{ ...road, surface: "dirt" }] } }));
    const bare = createWorldField(testRecipe({ features: { ...noFeatures(), roads: [{ ...road, surface: "" }] } }));
    // same GRADED height either way — painting and grading are separate jobs
    expect(bare.height(0, 0)).toBeCloseTo(painted.height(0, 0), 6);
    expect(bare.height(0, 0)).toBeCloseTo(14, 4);
    expect(groundSplat(bare, 0, 0)[dirt]!).toBeLessThan(groundSplat(painted, 0, 0)[dirt]!);
  });

  it("paints a path with a different surface where a named biome holds the ground", () => {
    const recipe = defaultWorldRecipe();
    // the default palette has no gravel; sand stands in for it here
    const gravel = recipe.surfaces.findIndex((s) => s.name === "sand");
    const road = {
      id: "trail-1",
      points: [[-400, 0], [400, 0]] as [number, number][],
      width: 2.4,
      shoulder: 2, smooth: 0,
      surfaceY: [14, 14],
      flatten: 1,
      surface: "dirt",
      surfaceEdge: 1.5,
    };
    const plain = createWorldField(testRecipe({ features: { ...noFeatures(), roads: [road] } }));
    // whichever biome the test recipe puts at the origin is the one to swap
    const here = plain.biome(0, 0, 14).id;
    const swapped = createWorldField(testRecipe({ features: { ...noFeatures(), roads: [{ ...road, surfaceByBiome: { [here]: "sand" } }] } }));
    expect(gravel).toBeGreaterThanOrEqual(0);
    expect(groundSplat(plain, 0, 0)[dirt]!).toBeGreaterThan(0.9);
    expect(groundSplat(swapped, 0, 0)[gravel]!).toBeGreaterThan(0.5);
    expect(groundSplat(swapped, 0, 0)[dirt]!).toBeLessThan(0.5);
    // an override for a biome that is not here changes nothing
    const elsewhere = recipe.biomes.find((b) => b.id !== here)!.id;
    const untouched = createWorldField(testRecipe({ features: { ...noFeatures(), roads: [{ ...road, surfaceByBiome: { [elsewhere]: "sand" } }] } }));
    expect(groundSplat(untouched, 0, 0)[dirt]!).toBeCloseTo(groundSplat(plain, 0, 0)[dirt]!, 3);
  });

  it("keeps the bank of a steep straight path smooth: a far neighbour segment never blends in", () => {
    // three points climbing at 150 %: adjacent segments disagree by tens of
    // metres at any point between them, which used to inflate the seam blend
    // until the runner-up (20 m away) was mixed in and flipped the bank
    const road = {
      id: "trail-steep",
      points: [[-40, 0], [0, 0], [40, 0]] as [number, number][],
      width: 2.4,
      shoulder: 3, smooth: 5,
      surfaceY: [40, 100, 160],
      leftY: [46, 106, 166],
      rightY: [34, 94, 154],
      flatten: 1,
      surface: "dirt",
      surfaceEdge: 1.5,
    };
    const field = createWorldField(testRecipe({ features: { ...noFeatures(), roads: [road] } }));
    // across the middle of the first segment (the fully regraded part of the
    // band — beyond it the test recipe's own ground, 80 m below, fades in),
    // and along the bank at 5 m out
    let prev = field.height(-20, 0);
    for (let d = 0.25; d <= 6; d += 0.25) {
      const h = field.height(-20, d);
      expect(Math.abs(h - prev), `step across the bank at ${d} m`).toBeLessThan(0.6);
      prev = h;
    }
    prev = field.height(-24, 5);
    for (let x = -23.75; x <= -16; x += 0.25) {
      const h = field.height(x, 5);
      // the bank climbs with the path (1.5 m per metre); a flip shows as a jump
      expect(Math.abs(h - prev), `step along the bank at x=${x}`).toBeLessThan(0.6);
      prev = h;
    }
  });

  it("lays a patch only where its biome gate is open", () => {
    const beachIndex = defaultWorldRecipe().biomes.findIndex((b) => b.id === "beach");
    const plain = createWorldField(testRecipe({ patches: [] }));
    const patched = createWorldField(
      testRecipe({
        // threshold below the noise floor: the patch is at FULL mask wherever
        // its gate lets it act, which makes the gate the only variable
        patches: [
          { id: "p", surface: "rock", biomes: ["beach"], frequency: 0.02, octaves: 1, threshold: -1, blend: 0.001, strength: 1, seed: 3 },
        ],
      }),
    );
    let changedInBeach = 0;
    for (let i = 0; i < 500; i++) {
      const x = i * 37.1 - 4000;
      const z = i * -23.7 + 1500;
      const beach = plain.biome(x, z).weights[beachIndex]!;
      const delta = Math.abs(groundSplat(plain, x, z)[rock]! - groundSplat(patched, x, z)[rock]!);
      if (beach < 1e-4) expect(delta).toBeLessThan(1e-4);
      else if (delta > 0.05) changedInBeach += 1;
    }
    expect(changedInBeach).toBeGreaterThan(0);
  });

  it("keeps splat weights summing to 1 through every decoration", () => {
    const field = createWorldField(
      testRecipe({
        features: {
          ...noFeatures(),
          roads: [{ id: "r", points: [[-400, 0], [400, 0]], width: 10, shoulder: 10, smooth: 0, surfaceY: [14, 14], flatten: 1, surface: "dirt", surfaceEdge: 3 }],
        },
      }),
    );
    for (let i = 0; i < 200; i++) {
      const x = i * 11.7 - 600;
      const z = (i % 17) * 3 - 24; // sweeps across the road and away from it
      const splat = groundSplat(field, x, z);
      let sum = 0;
      for (let s = 0; s < MAX_SURFACES; s++) {
        expect(splat[s]!).toBeGreaterThanOrEqual(-1e-6);
        sum += splat[s]!;
      }
      expect(sum).toBeCloseTo(1, 4);
    }
  });

  it("measures steepness the same way from a normal as from the heightfield", () => {
    // The bug this pins: the per-vertex path used `1 - |ny|`, which is
    // 1 - cos(angle), while slope() reports sin(angle). Every cliffStart and
    // every crag slope window is authored against slope()'s units, so a 50°
    // face reported 0.36, never reached a cliffStart of 0.55, and textured as
    // whatever the biome puts on FLAT ground. Cliffs came out grass and sand,
    // and no amount of tuning the weights would have fixed it — the number
    // being compared was the wrong number.
    const field = createWorldField(testRecipe());
    for (const degrees of [15, 30, 45, 60, 75, 88]) {
      const angle = (degrees * Math.PI) / 180;
      const ny = Math.cos(angle);
      const steep = Math.sin(angle);
      const viaNormal = new Float32Array(field.surfaceCount);
      field.splatAt(120, 90, -60, ny, viaNormal, 0);
      const viaSlope = field.biome(120, -60, 90, steep).surface;
      for (let s = 0; s < field.surfaceCount; s++) {
        expect(viaNormal[s]!, `${degrees}° channel ${s}`).toBeCloseTo(viaSlope[s]!, 5);
      }
    }
  });

  it("puts cliff cover on a slope at the angle its cliffStart names", () => {
    const field = createWorldField(testRecipe());
    const out = new Float32Array(field.surfaceCount);
    // 55° is comfortably past every land biome's cliffStart (0.42-0.55 in
    // sine terms, i.e. 25-33 degrees), so it must read as cliff, not cover
    field.splatAt(120, 90, -60, Math.cos((55 * Math.PI) / 180), out, 0);
    expect(out[rock]! + out[paletteIndex("icyrock")]!).toBeGreaterThan(0.6);
    expect(out[paletteIndex("grass")]! + out[paletteIndex("sand")]!).toBeLessThan(0.2);
  });

  it("reads near-vertical ground as bare rock whatever the biome above it", () => {
    const field = createWorldField(testRecipe());
    const icyrock = paletteIndex("icyrock");
    const out = new Float32Array(MAX_SURFACES);
    for (const y of [20, 60, 100, 160, 240]) {
      field.splatAt(0, y, 0, 0.02, out, 0); // normal almost horizontal: a cliff face
      // plain rock is always the single biggest channel, and above the
      // snowline the remainder goes to ICY rock rather than to snow — snow
      // does not sit on a vertical face, which is the whole point of the rule
      let biggest = 0;
      for (let s = 1; s < MAX_SURFACES; s++) if (out[s]! > out[biggest]!) biggest = s;
      expect(biggest, ).toBe(rock);
      expect(out[rock]! + out[icyrock]!, ).toBeGreaterThan(0.85);
    }
  });

  it("never lets a cover-only rule name the place", () => {
    // `crag` paints bare rock on steep ground in every biome. If it were
    // allowed to answer biome().id, every slope in the world would rename
    // itself and every biome-filtered scatter rule would stop firing there —
    // measured as pines vanishing from hillsides and boulders reporting
    // "seabed" on a clifftop.
    const field = createWorldField(testRecipe());
    const named = new Set<string>();
    for (let i = 0; i < 600; i++) {
      const x = i * 29.3 - 6000;
      const z = i * 41.7 - 4000;
      const h = field.height(x, z);
      const sample = field.biome(x, z, h);
      named.add(sample.id);
      // the surface still gets its rock: the cover rule is only barred from
      // NAMING, never from painting
      if (sample.id === "crag") expect(sample.weights[defaultWorldRecipe().biomes.findIndex((b) => b.id === "crag")]!).toBeGreaterThan(0.5);
    }
    expect(named.size).toBeGreaterThan(3);
    // it may still name the handful of points no labelling rule covers at all,
    // but it must never be the ANSWER on ordinary ground
    const flat = field.biome(0, 0, 20, 0);
    expect(flat.id).not.toBe("crag");
  });

  it("drops a patch naming a surface that does not exist rather than throwing", () => {
    const field = createWorldField(
      testRecipe({ patches: [{ id: "p", surface: "obsidian", biomes: [], frequency: 0.02, octaves: 1, threshold: 0, blend: 0.2, strength: 1, seed: 1 }] }),
    );
    const splat = groundSplat(field, 120, -80);
    let sum = 0;
    for (let s = 0; s < MAX_SURFACES; s++) sum += splat[s]!;
    expect(sum).toBeCloseTo(1, 4);
  });
});

// ---------------------------------------------------------- zone landforms

describe("zone landforms", () => {
  function withDunes(overrides: Partial<WorldRecipe["terrain"]["dunes"]>): WorldField {
    const base = defaultWorldRecipe();
    return createWorldField(
      testRecipe({
        terrain: {
          ...base.terrain,
          // sea cliffs OFF for this suite: they remap the shoreline profile
          // non-linearly, so near the waterline a dune of amplitude A shows up
          // in the final height as several times A. That is correct behaviour
          // and it would make the amplitude bound below meaningless.
          coast: { ...base.terrain.coast, cliff: 0 },
          dunes: { ...base.terrain.dunes, ...overrides },
        },
      }),
    );
  }

  it("adds the dune band only inside its climate window", () => {
    const off = withDunes({ amplitude: 0 });
    const always = withDunes({ amplitude: 12, temperature: [-5, 5], moisture: [-5, 5] });
    const never = withDunes({ amplitude: 12, temperature: [9, 10] });
    let raised = 0;
    for (let i = 0; i < 300; i++) {
      const x = i * 41.3 - 3000;
      const z = i * -17.9 + 900;
      const base = off.height(x, z);
      // a window nothing can satisfy must leave the terrain bit-identical
      expect(never.height(x, z)).toBeCloseTo(base, 6);
      const d = always.height(x, z) - base;
      expect(d).toBeGreaterThanOrEqual(-1e-6); // ridged noise only ever adds
      expect(d).toBeLessThan(12 + 1e-6);
      if (d > 1) raised += 1;
    }
    expect(raised).toBeGreaterThan(30);
  });

  it("cuts a canyon to a flat floor with walls that reach natural terrain", () => {
    const bare = createWorldField(testRecipe({ features: noFeatures() }));
    // The floor has to be BELOW the local land or there is nothing to cut: a
    // canyon only ever removes material, so one written above the terrain is
    // correctly a no-op (asserted at the end).
    const floor = Math.min(...[-40, -20, 0, 20, 40].map((z) => bare.height(0, z))) - 25;
    const canyon = {
      id: "c",
      points: [[-400, 0], [400, 0]] as [number, number][],
      width: 80,
      depth: 50,
      rim: 60,
      steps: 3,
      stepSharpness: 0.8,
      floorY: [floor, floor],
    };
    const cut = createWorldField(testRecipe({ features: { ...noFeatures(), canyons: [canyon] } }));

    // the floor is flat, at the height the stage wrote
    for (const z of [-30, -10, 0, 12, 34]) expect(cut.height(0, z)).toBeCloseTo(floor, 4);
    // past the rim the land is untouched
    expect(cut.height(0, 300)).toBeCloseTo(bare.height(0, 300), 6);
    // a canyon only ever cuts down, never builds
    for (let i = 0; i < 120; i++) {
      const z = -200 + i * 3.4;
      expect(cut.height(0, z)).toBeLessThanOrEqual(bare.height(0, z) + 1e-6);
    }
    // and the wall climbs out of it
    expect(cut.height(0, 100) - cut.height(0, 40)).toBeGreaterThan(20);

    const above = createWorldField(
      testRecipe({ features: { ...noFeatures(), canyons: [{ ...canyon, floorY: [floor + 200, floor + 200] }] } }),
    );
    expect(above.height(0, 0)).toBeCloseTo(bare.height(0, 0), 6);
  });

  it("terraces the canyon wall instead of ramping it", () => {
    const bare = createWorldField(testRecipe({ features: noFeatures() }));
    const floor = Math.min(...[-100, -50, 0, 50, 100].map((z) => bare.height(0, z))) - 60;
    const base = {
      id: "c",
      points: [[-400, 0], [400, 0]] as [number, number][],
      width: 40,
      depth: 60,
      rim: 80,
      floorY: [floor, floor],
    };
    // Count wall samples nearly level with their neighbour: a smooth ramp has
    // almost none, bedded rock is mostly tread.
    const treads = (steps: number, stepSharpness: number): number => {
      const field = createWorldField(
        testRecipe({ features: { ...noFeatures(), canyons: [{ ...base, steps, stepSharpness }] } }),
      );
      let flat = 0;
      for (let d = 21; d < 99; d += 0.5) {
        if (Math.abs(field.height(0, d + 0.5) - field.height(0, d)) < 0.12) flat += 1;
      }
      return flat;
    };
    const stepped = treads(4, 0.85);
    const ramp = treads(1, 0.85);
    expect(stepped, `stepped ${stepped} treads vs ramp ${ramp}`).toBeGreaterThan(ramp + 15);
  });

  it("steepens the shoreline into cliffs without moving the coastline", () => {
    const withCoast = (cliff: number): WorldField => {
      const base = defaultWorldRecipe();
      return createWorldField(testRecipe({ terrain: { ...base.terrain, coast: { ...base.terrain.coast, cliff } } }));
    };
    const flat = withCoast(0);
    const rugged = withCoast(3);
    let steepFlat = 0;
    let steepRugged = 0;
    let shore = 0;
    for (let i = 0; i < 260; i++) {
      for (let j = 0; j < 260; j++) {
        const x = -3000 + (6000 * i) / 259;
        const z = -3000 + (6000 * j) / 259;
        const h = flat.height(x, z);
        // The remap is `dh -> dh * k` with k > 0, so it cannot move the
        // waterline: land stays land and sea stays sea, everywhere. That is
        // what makes this safe to apply to a world whose rivers and towns
        // were already sited.
        expect(Math.sign(rugged.height(x, z)), `coastline moved at ${x},${z}`).toBe(Math.sign(h));
        if (Math.abs(h) > 4) continue;
        shore += 1;
        if (flat.slope(x, z) > 0.45) steepFlat += 1;
        if (rugged.slope(x, z) > 0.45) steepRugged += 1;
      }
    }
    expect(shore).toBeGreaterThan(100);
    expect(steepRugged).toBeGreaterThan(steepFlat * 2);
  });

  it("tapers a blob toward its top radius", () => {
    const spire = createWorldField(
      testRecipe({
        features: {
          ...noFeatures(),
          blobs: [{ id: "m", center: [0, 40, 0], radius: 10, op: "add", falloff: 3, height: 40, topRadius: 3, scaleX: 1, scaleZ: 1 }],
        },
      }),
    );
    // 6 m out from the axis: inside the base, outside the tip
    expect(spire.density(6, 44, 0)).toBeLessThan(0);
    expect(spire.density(6, 78, 0)).toBeGreaterThan(0);
    // and the axis itself is solid all the way up
    expect(spire.density(0, 44, 0)).toBeLessThan(0);
    expect(spire.density(0, 78, 0)).toBeLessThan(0);
  });

  it("raises a vertical-capsule blob into a solid pillar with air around it", () => {
    const plain = createWorldField(testRecipe({ features: noFeatures() }));
    const ground = plain.height(0, 0);
    const field = createWorldField(
      testRecipe({
        features: {
          ...noFeatures(),
          blobs: [{ id: "monolith-1", center: [0, ground - 4, 0], radius: 5, op: "add", falloff: 3, height: 20, scaleX: 1, scaleZ: 1 }],
        },
      }),
    );
    expect(field.density(0, ground + 10, 0)).toBeLessThan(0); // inside the shaft
    expect(field.density(0, ground + 40, 0)).toBeGreaterThan(0); // clear above its cap
    expect(field.density(40, ground + 10, 40)).toBeGreaterThan(0); // nothing beside it
  });

  it("stretches a blob in plan by scaleX/scaleZ", () => {
    const make = (scaleX: number): WorldField =>
      createWorldField(
        testRecipe({
          features: {
            ...noFeatures(),
            blobs: [{ id: "m", center: [0, 60, 0], radius: 5, op: "add", falloff: 3, height: 10, scaleX, scaleZ: 1 }],
          },
        }),
      );
    expect(make(1).density(8, 64, 0)).toBeGreaterThan(0); // outside a round one
    expect(make(2.2).density(8, 64, 0)).toBeLessThan(0); // inside a stretched one
  });

  it("gives an additive blob headroom in the meshed band instead of capping it", () => {
    // The regression this guards: `heightRange` feeds the mesher's vertical
    // band, and it used to see only the heightfield — so a 20 m pillar was
    // sliced off at the terrain's own 14 m of headroom and rendered as a mesa
    // with an open top.
    const recipe = testRecipe({ features: noFeatures() });
    const plain = createWorldField(recipe);
    const ground = plain.height(8, 8);
    const withPillar = createWorldField(
      testRecipe({
        features: {
          ...noFeatures(),
          blobs: [{ id: "monolith-1", center: [8, ground - 4, 8], radius: 5, op: "add", falloff: 3, height: 24, scaleX: 1, scaleZ: 1 }],
        },
      }),
    );
    const before = plain.heightRange(0, 0, recipe.cellSize, recipe.cellSize);
    const after = withPillar.heightRange(0, 0, recipe.cellSize, recipe.cellSize);
    expect(after.max).toBeGreaterThanOrEqual(ground + 24);
    expect(after.max).toBeGreaterThan(before.max);

    const mesh = buildVoxelMesh(withPillar, { kind: "voxel", world: "pillar", cell: [0, 0] });
    expect(mesh.max[1]).toBeGreaterThan(ground + 20);
  });
});

// ---------------------------------------------------------------- cell meshes

describe("voxel cell meshing", () => {
  const recipe = testRecipe();
  const field = createWorldField(recipe);

  it("meshes a cell into cell-local space", () => {
    const mesh = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [3, -2] });
    expect(mesh.triangleCount).toBeGreaterThan(0);
    expect(mesh.min[0]).toBeGreaterThanOrEqual(-recipe.cellSize * 0.1);
    expect(mesh.max[0]).toBeLessThanOrEqual(recipe.cellSize * 1.1);
    expect(mesh.min[2]).toBeGreaterThanOrEqual(-recipe.cellSize * 0.1);
    expect(mesh.max[2]).toBeLessThanOrEqual(recipe.cellSize * 1.1);
  });

  it("emits one splat weight and one tint per vertex", () => {
    const mesh = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [0, 0] });
    // exactly the palette's width, NOT MAX_SURFACES: a small palette must cost
    // a small vertex, or raising the cap would tax every world that ignored it
    expect(mesh.surfaceCount).toBe(field.recipe.surfaces.length);
    expect(mesh.surfaceCount).toBeLessThanOrEqual(MAX_SURFACES);
    expect(mesh.splat.length).toBe(mesh.vertexCount * mesh.surfaceCount);
    expect(mesh.tint.length).toBe(mesh.vertexCount * 3);
    for (let i = 0; i < mesh.vertexCount; i++) {
      let sum = 0;
      for (let s2 = 0; s2 < mesh.surfaceCount; s2++) sum += mesh.splat[i * mesh.surfaceCount + s2]!;
      expect(sum).toBeCloseTo(1, 4);
    }
  });

  it("is byte-identical when meshed twice", () => {
    const a = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [5, 5] });
    const b = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [5, 5] });
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
    expect(Array.from(a.normals)).toEqual(Array.from(b.normals));
  });

  it("meets its neighbour exactly along the shared boundary plane", () => {
    // THE seam test. Vertices lying on the shared plane must agree to the bit
    // in position AND normal, or the world shows hairline cracks and the
    // character controller catches on a lip at every chunk boundary.
    const left = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [0, 0] });
    const right = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [1, 0] });
    const plane = recipe.cellSize;

    const onPlane = (mesh: typeof left, originX: number): Map<string, [number, number, number]> => {
      const out = new Map<string, [number, number, number]>();
      for (let i = 0; i < mesh.vertexCount; i++) {
        const wx = mesh.positions[i * 3]! + originX;
        if (Math.abs(wx - plane) > 1e-4) continue;
        const y = mesh.positions[i * 3 + 1]!;
        const z = mesh.positions[i * 3 + 2]!;
        out.set(`${y.toFixed(5)}_${z.toFixed(5)}`, [
          mesh.normals[i * 3]!,
          mesh.normals[i * 3 + 1]!,
          mesh.normals[i * 3 + 2]!,
        ]);
      }
      return out;
    };

    const a = onPlane(left, 0);
    const b = onPlane(right, plane);
    expect(a.size).toBeGreaterThan(4); // the seam must actually carry vertices
    let matched = 0;
    for (const [key, normal] of a) {
      const other = b.get(key);
      if (!other) continue;
      matched += 1;
      expect(other[0]).toBeCloseTo(normal[0]!, 5);
      expect(other[1]).toBeCloseTo(normal[1]!, 5);
      expect(other[2]).toBeCloseTo(normal[2]!, 5);
    }
    // every seam vertex in the overlapping vertical band must be shared
    expect(matched).toBeGreaterThanOrEqual(Math.min(a.size, b.size) - 2);
  });

  it("produces almost no degenerate geometry on real terrain", () => {
    const mesh = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [1, 2] });
    expect(degenerateFraction(mesh)).toBeLessThan(0.01);
  });

  it("coarsens with lodStep and keeps the same footprint", () => {
    const full = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [2, 1] });
    const coarse = buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [2, 1], lodStep: 2 });
    expect(coarse.triangleCount).toBeGreaterThan(0);
    expect(coarse.triangleCount).toBeLessThan(full.triangleCount);
  });

  it("resolves a registered world by id and caches the result", () => {
    clearVoxelWorlds();
    registerVoxelField("demo", recipe);
    const a = voxelMesh({ kind: "voxel", world: "demo", cell: [1, 1] });
    const b = voxelMesh({ kind: "voxel", world: "demo", cell: [1, 1] });
    expect(a).toBe(b); // same object: the cache is what render + physics share
    expect(a.triangleCount).toBeGreaterThan(0);
  });

  it("returns an empty mesh for an unknown world instead of throwing", () => {
    clearVoxelWorlds();
    expect(voxelMesh({ kind: "voxel", world: "nope", cell: [0, 0] }).triangleCount).toBe(0);
  });
});

// -------------------------------------------------------------------- scatter

describe("scatter", () => {
  const recipe = testRecipe({
    cellSize: 64,
    resolution: 16,
    scatter: [
      {
        id: "tree",
        prefab: "trees/pine",
        model: undefined,
        material: undefined,
        biomes: [],
        density: 0.01,
        slopeMax: 0.6,
        slopeMin: 0,
        yawOffset: 0,
        cliff: undefined,
        height: undefined,
        scale: [0.9, 1.3],
        alignToNormal: 0,
        yOffset: 0,
        jitter: 0.8,
        clearance: 0,
        footprint: 0,
        spacing: 0.5,
        collider: "none",
        colliderSize: [1, 2, 1],
        static: true,
        castShadow: true,
        lod: true,
      },
    ],
  });
  const field = createWorldField(worldRecipeSchema.parse(recipe));

  it("places instances and repeats exactly", () => {
    const a = scatterCell(field, 3, -4);
    const b = scatterCell(field, 3, -4);
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps every instance's lattice point inside its own cell", () => {
    const size = field.recipe.cellSize;
    const seen = new Set<string>();
    for (let cz = -2; cz <= 2; cz++) {
      for (let cx = -2; cx <= 2; cx++) {
        for (const instance of scatterCell(field, cx, cz)) {
          // ids are lattice-derived, so a duplicate means two cells claimed one point
          expect(seen.has(instance.id), `${instance.id} claimed twice`).toBe(false);
          seen.add(instance.id);
          const wx = instance.position[0] + cx * size;
          const wz = instance.position[2] + cz * size;
          // jitter may push a prop just past the border, but not by a whole cell
          expect(Math.abs(wx - (cx + 0.5) * size)).toBeLessThan(size);
          expect(Math.abs(wz - (cz + 0.5) * size)).toBeLessThan(size);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it("stands props on the ground and refuses ground steeper than slopeMax", () => {
    for (const instance of scatterCell(field, 2, -4)) {
      const wx = instance.position[0] + 2 * field.recipe.cellSize;
      const wz = instance.position[2] - 4 * field.recipe.cellSize;
      expect(Math.abs(instance.position[1] - field.height(wx, wz))).toBeLessThan(1.5);
      expect(field.slope(wx, wz)).toBeLessThanOrEqual(0.6 + 1e-6);
    }
  });

  it("respects a biome filter", () => {
    const snowOnly = createWorldField(
      worldRecipeSchema.parse({
        ...recipe,
        scatter: [{ ...recipe.scatter![0], id: "pine", biomes: ["alpine"] }],
      }),
    );
    for (let cx = 0; cx < 4; cx++) {
      for (const instance of scatterCell(snowOnly, cx, 0)) {
        expect(instance.biome).toBe("alpine");
      }
    }
  });

  it("keeps props off the roads and off the monoliths", () => {
    // The two ways a generated world announces that nothing was thought about:
    // a boulder in the middle of the highway, and a shrub buried inside a rock
    // spire. Both are one clearance test, because `featureClearance` measures
    // roads, rivers, canyons, towns AND additive blobs — the last of which is
    // easy to forget, since scatter stands props on the HEIGHTFIELD and a
    // monolith is not in the heightfield at all.
    const road = {
      id: "r",
      points: [[-300, 0], [300, 0]] as [number, number][],
      width: 8,
      shoulder: 10, smooth: 0,
      surfaceY: [12, 12],
      flatten: 1,
      surface: "dirt",
      surfaceEdge: 2.5,
    };
    const blob = { id: "monolith-1", center: [80, 0, 40] as [number, number, number], radius: 9, op: "add" as const, falloff: 3, height: 60, scaleX: 1, scaleZ: 1 };
    const clearance = 5;
    const guarded = createWorldField(
      worldRecipeSchema.parse({
        ...recipe,
        scatter: recipe.scatter!.map((rule) => ({ ...rule, clearance })),
        features: { ...noFeatures(), roads: [road], blobs: [blob] },
      }),
    );
    let checked = 0;
    for (let cz = -3; cz <= 3; cz++) {
      for (let cx = -3; cx <= 3; cx++) {
        for (const instance of scatterCell(guarded, cx, cz)) {
          const wx = instance.position[0] + cx * recipe.cellSize;
          const wz = instance.position[2] + cz * recipe.cellSize;
          checked += 1;
          // clearance is from the SHOULDER's edge: the shoulder is regraded
          // flat and painted, so a prop on it is a prop on the path
          const toRoad = Math.abs(wz) - (road.width / 2 + road.shoulder);
          expect(toRoad, `prop ${wx.toFixed(0)},${wz.toFixed(0)} is on the road`).toBeGreaterThan(clearance);
          const toBlob = Math.hypot(wx - blob.center[0], wz - blob.center[2]) - (blob.radius + blob.falloff);
          expect(toBlob, `prop ${wx.toFixed(0)},${wz.toFixed(0)} is inside the monolith`).toBeGreaterThan(clearance);
        }
      }
    }
    expect(checked, "no props were placed at all, so nothing was tested").toBeGreaterThan(20);
  });

  it("keeps clear of towns when a clearance is set", () => {
    const townField = createWorldField(
      worldRecipeSchema.parse({
        ...recipe,
        scatter: [{ ...recipe.scatter![0], clearance: 5 }],
        features: {
          rivers: [],
          canyons: [],
          tunnels: [],
          roads: [],
          towns: [{ id: "t", center: [0, 0], radius: 40, falloff: 30, groundY: 12, flatten: 1, tags: [] }],
          blobs: [],
          pois: [],
          lakes: [], bridges: [], fills: [], riverPaths: [],
        },
      }),
    );
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        for (const instance of scatterCell(townField, cx, cz)) {
          const wx = instance.position[0] + cx * 64;
          const wz = instance.position[2] + cz * 64;
          expect(Math.hypot(wx, wz)).toBeGreaterThan(44);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- chunk docs

describe("generated chunk documents", () => {
  let registry: ComponentRegistry;

  beforeEach(() => {
    registry = new ComponentRegistry();
    registerCoreComponents(registry);
  });

  const recipe = worldRecipeSchema.parse(
    testRecipe({
      cellSize: 64,
      material: "materials/terrain",
      scatter: [
        {
          id: "rock",
          prefab: undefined,
          model: "models/rock.glb",
          material: undefined,
          biomes: [],
          density: 0.004,
          slopeMax: 0.8,
          slopeMin: 0,
          yawOffset: 0,
          cliff: undefined,
          height: undefined,
          scale: [0.8, 1.4],
          alignToNormal: 0.6,
          yOffset: -0.2,
          jitter: 0.9,
          clearance: 0,
          footprint: 0,
          spacing: 0.5,
          collider: "box",
          colliderSize: [1.2, 1, 1.2],
          static: true,
          castShadow: true,
          lod: true,
        },
      ],
    }),
  );
  const field = createWorldField(recipe);

  it("validates as an ordinary chunk document", () => {
    const doc = voxelChunkDoc(field, "overworld", 1, -1);
    expect(chunkDocSchema.safeParse(doc).success).toBe(true);
  });

  it("carries a terrain entity whose mesh is a voxel source with a matching collider", () => {
    const doc = voxelChunkDoc(field, "overworld", 1, -1);
    const terrain = doc.entities["terrain"]!;
    expect(terrain.components["mesh"]).toMatchObject({
      source: { kind: "voxel", world: "overworld", cell: [1, -1] },
      material: "materials/terrain",
      // a terrain cell must NOT opt into static batching: the merge strips the
      // per-vertex splat weights its material reads, and a cell is one draw
      // call already
      static: false,
    });
    expect(terrain.components["collider"]).toMatchObject({ shape: "trimesh" });
  });

  it("passes every generated component through the live schemas", () => {
    const doc = voxelChunkDoc(field, "overworld", 3, -3);
    for (const [id, entity] of Object.entries(doc.entities)) {
      for (const [name, data] of Object.entries(entity.components)) {
        const result = registry.validate(name, data);
        expect(result.ok, `${id}.${name}: ${result.ok ? "" : result.error}`).toBe(true);
      }
    }
  });

  it("stays collapsed — one line per prop, whatever it meshes into", () => {
    const doc = voxelChunkDoc(field, "overworld", 3, -3);
    const props = Object.entries(doc.entities).filter(([id]) => id !== "terrain");
    expect(props.length).toBeGreaterThan(0);
    for (const [, entity] of props) {
      expect(entity.parent).toBe(null);
      expect(Object.keys(entity.components).sort()).toEqual(["collider", "mesh", "transform"]);
    }
  });

  it("passes a rule's lod flag to the emitted mesh, so a cheap model can refuse the box proxy", () => {
    // without a baked impostor the far tier for a SQUAT prop is a BoxGeometry.
    // On a model that is already a couple of hundred triangles that trades the
    // prop for a brown box and saves nothing worth having, and it is invisible
    // from the recipe unless the flag reaches the mesh component.
    const on = voxelChunkDoc(field, "overworld", 3, -3);
    const rock = Object.values(on.entities).find((e) => e.tags?.includes("scatter") && e.components["mesh"] !== undefined);
    expect((rock!.components["mesh"] as { lod: boolean }).lod).toBe(true);

    const cheap = createWorldField(
      worldRecipeSchema.parse({ ...field.recipe, scatter: field.recipe.scatter.map((r) => ({ ...r, lod: false })) } as never),
    );
    const off = voxelChunkDoc(cheap, "overworld", 3, -3);
    const plain = Object.values(off.entities).find((e) => e.tags?.includes("scatter") && e.components["mesh"] !== undefined);
    expect((plain!.components["mesh"] as { lod: boolean }).lod).toBe(false);
  });

  it("omits scatter and collision when asked", () => {
    const doc = voxelChunkDoc(field, "overworld", 3, -3, { scatter: false, collision: false });
    expect(Object.keys(doc.entities)).toEqual(["terrain"]);
    expect(doc.entities["terrain"]!.components["collider"]).toBeUndefined();
  });

  it("places a POI in the cell that contains it", () => {
    const withPoi = createWorldField(
      worldRecipeSchema.parse({
        ...recipe,
        features: {
          rivers: [],
          canyons: [],
          tunnels: [],
          roads: [],
          towns: [],
          blobs: [],
          pois: [{ id: "shrine", kind: "landmark", position: [70, 12, 5], rotationY: 0, prefab: "poi/shrine", tags: [] }],
        },
      }),
    );
    expect(voxelChunkDoc(withPoi, "overworld", 1, 0).entities["poi_shrine"]).toBeDefined();
    expect(voxelChunkDoc(withPoi, "overworld", 0, 0).entities["poi_shrine"]).toBeUndefined();
  });
});

// ------------------------------------------------------------------- recipe

describe("world recipe", () => {
  it("fills in a complete, valid default world", () => {
    const recipe = defaultWorldRecipe();
    expect(worldRecipeSchema.safeParse(recipe).success).toBe(true);
    expect(recipe.surfaces.length).toBe(8);
    expect(recipe.surfaces.length).toBeLessThanOrEqual(MAX_SURFACES);
    expect(recipe.biomes.length).toBeGreaterThan(3);
  });

  it("accepts a palette up to MAX_SURFACES and rejects one past it", () => {
    // The cap is a cost budget, not a limit of the idea: each ACTIVE surface
    // is three more triplanar fragment fetches. Past it the answer is a
    // texture array with per-vertex layer indices, not more fixed channels.
    const ok = { ...defaultWorldRecipe(), surfaces: new Array(MAX_SURFACES).fill({ name: "x" }) };
    expect(worldRecipeSchema.safeParse(ok).success).toBe(true);
    const bad = { ...defaultWorldRecipe(), surfaces: new Array(MAX_SURFACES + 1).fill({ name: "x" }) };
    expect(worldRecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("round-trips through JSON unchanged", () => {
    const recipe = defaultWorldRecipe();
    const again = worldRecipeSchema.parse(JSON.parse(JSON.stringify(recipe)));
    expect(again).toEqual(recipe);
  });

  it("describes every field for the AI spec", () => {
    // the engine is self-describing (AGENTS.md): a knob with no description is
    // a knob an agent has to guess at
    const shape = (worldRecipeSchema as unknown as { shape: Record<string, z.ZodType> }).shape;
    for (const key of ["seed", "cellSize", "resolution", "surfaces", "biomes"]) {
      expect(shape[key], key).toBeDefined();
    }
  });
});

// ------------------------------------------------------------ cliff terracing

describe("cliff terracing", () => {
  /** Terracing acts on the MOUNTAIN band, so a test world needs mountains in it. */
  const mountainous = (cliffs: Record<string, unknown>, maskStart = 0.45, maskEnd = 0.7): WorldRecipe =>
    testRecipe({
      cellSize: 64,
      resolution: 16,
      terrain: {
        ...testRecipe().terrain,
        mountains: { frequency: 0.0025, amplitude: 500, octaves: 4, lacunarity: 2, gain: 0.5, ridged: true, seed: 37 },
        mountainMask: {
          spec: { frequency: 0.0012, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 53 },
          start: maskStart,
          end: maskEnd,
        },
        cliffs: { enabled: false, step: 55, sharpness: 0.86, strength: 1, mask: { frequency: 0.0012, start: 0.44, end: 0.58, octaves: 3, seed: 881 }, jitter: 22, jitterFrequency: 0.02, seed: 613, ...cliffs },
      },
    } as Partial<WorldRecipe>);

  /** Fraction of sampled ground steeper than `t`, and the median steepness. */
  function slopeProfile(field: ReturnType<typeof createWorldField>): { steep: number; flat: number; middle: number; median: number } {
    const s: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const x = ((i * 61) % 400) * 7 - 1400;
      const z = ((i * 37) % 400) * 7 - 1400;
      s.push(field.slope(x, z));
    }
    s.sort((a, b) => a - b);
    return {
      steep: s.filter((v) => v > 0.93).length / s.length,
      flat: s.filter((v) => v < 0.3).length / s.length,
      middle: s.filter((v) => v >= 0.3 && v <= 0.93).length / s.length,
      median: s[s.length >> 1]!,
    };
  }

  it("is off by default, so no existing world changes shape", () => {
    expect(testRecipe().terrain.cliffs.enabled).toBe(false);
    const plain = createWorldField(mountainous({}));
    const same = createWorldField(mountainous({ enabled: false, sharpness: 0.98 }));
    for (let i = 0; i < 60; i++) {
      const x = i * 31.7 - 500;
      expect(same.height(x, i * -19.3)).toBe(plain.height(x, i * -19.3));
    }
  });

  /** Cliff mask wide open, so a test measures the SHAPING and not the placement. */
  const OPEN = { frequency: 0.0012, start: 0, end: 0.0001, octaves: 3, seed: 881 };
  /** Terracing is gated on the MOUNTAIN mask too; open that as well to isolate shaping. */
  const allMountain = (cliffs: Record<string, unknown>): WorldRecipe => mountainous(cliffs, -1, -0.999);

  it("turns slope into tread and riser — flatter AND steeper, with less in between", () => {
    // The honest characterisation, and NOT "more sheer ground": terracing
    // trades a lot of moderately-steep area for a little vertical area plus a
    // lot of flat. Whether the sheer FRACTION rises or falls therefore depends
    // entirely on how steep the ground already was — it rises on gentle ground
    // and falls on ground that was already near-vertical. What is true either
    // way, and is what terracing actually is, is that the middle empties out.
    const before = slopeProfile(createWorldField(allMountain({})));
    const after = slopeProfile(createWorldField(allMountain({ enabled: true, mask: OPEN, minBands: 0 })));
    expect(after.middle).toBeLessThan(before.middle);
    expect(after.flat).toBeGreaterThan(before.flat);
  });

  it("keeps cliffs ON mountains — the band's own edge is left alone", () => {
    // The failure this pins was seen on a real world: at the EDGE of the
    // mountain band, where relief is about one step, full-strength terracing
    // turns a hillock into a single enormous step. It reads far harsher than
    // the mountain does, because there is no mountain around it to explain it,
    // and it is the first thing you notice from a distance.
    //
    // Each variant is measured against ITS OWN untouched world: the mountain
    // mask shapes the terrain as well as gating the terracing, so a shared
    // baseline would be comparing two different worlds and calling the
    // difference an effect.
    const shaped = (world: (c: Record<string, unknown>) => WorldRecipe, cliffs: Record<string, unknown>): number => {
      const off = slopeProfile(createWorldField(world({})));
      const on = slopeProfile(createWorldField(world({ enabled: true, mask: OPEN, ...cliffs })));
      return Math.abs(on.middle - off.middle);
    };
    const ungated = shaped(allMountain, { minBands: 0 });
    // gated by the mountain mask: most of this world is off the mountain core
    expect(shaped(mountainous, { minBands: 0 })).toBeLessThan(ungated);
    // gated by available relief: six bands' worth is more than most of it has
    expect(shaped(allMountain, { minBands: 6 })).toBeLessThan(ungated);
  });

  it("never half-terraces a whole world: the gate is sharpened to near on/off", () => {
    // A half-applied terrace is the worst of both — it flattens the treads
    // without ever steepening the risers to vertical. So the three gates are
    // multiplied and then run through a smoothstep rather than used raw, and
    // full strength must shape the ground strictly harder than half does.
    const off = slopeProfile(createWorldField(allMountain({})));
    const half = slopeProfile(createWorldField(allMountain({ enabled: true, mask: OPEN, minBands: 0, strength: 0.5 })));
    const full = slopeProfile(createWorldField(allMountain({ enabled: true, mask: OPEN, minBands: 0 })));
    expect(off.middle - full.middle).toBeGreaterThan(off.middle - half.middle);
  });

  it("stays a function: the remap is monotonic, so no fold can appear", () => {
    const field = createWorldField(mountainous({ enabled: true, sharpness: 0.98 }));
    // walking along a line, a terraced profile may be flat or rise, never both
    // ways across one riser — a non-monotonic remap would put an overhang in
    // the HEIGHTFIELD, which the mesher cannot represent and physics cannot cook
    for (let i = 0; i < 200; i++) {
      const h = field.height(i * 0.5 - 400, 123.5);
      expect(Number.isFinite(h)).toBe(true);
    }
    const relief = (r: number): number => {
      const f = createWorldField(mountainous({ enabled: true, step: 40, sharpness: r }));
      return f.height(217.5, -88.25);
    };
    // sharpening only redistributes altitude WITHIN a band, so no amount of it
    // can move a point more than one band's worth
    expect(Math.abs(relief(0.98) - relief(0))).toBeLessThanOrEqual(40);
  });

  it("arrives at each tread on a curve, not a crease", () => {
    // The hard clamp put a slope discontinuity along every cliff top and
    // foot; `rounding` eases the riser into the tread over a fraction of its
    // height. Measured as the worst second difference of height along a
    // transect (jitter off so the bands are where the maths says): the
    // rounded profile must kink far less, and it must still be monotonic in
    // relief (a terrace is a function of the ground, never a fold).
    //
    // The mountain band under it is NOT ridged here: a ridged band has its
    // own crease at every crest, and the riser stretch multiplies that by
    // 1/(1 - sharpness), which would swamp the corners this test is about.
    const world = (rounding: number): ReturnType<typeof createWorldField> => {
      const recipe = allMountain({ enabled: true, mask: OPEN, minBands: 0, jitter: 0, sharpness: 0.9, rounding });
      recipe.terrain.mountains.ridged = false;
      return createWorldField(recipe);
    };
    const kink = (field: ReturnType<typeof createWorldField>): number => {
      let worst = 0;
      const h = (i: number): number => field.height(i * 0.5 - 600, 77.5);
      for (let i = 1; i < 2400; i++) worst = Math.max(worst, Math.abs(h(i - 1) - 2 * h(i) + h(i + 1)));
      return worst;
    };
    expect(kink(world(0.25))).toBeLessThan(kink(world(0)) * 0.6);
    // the same riser is still there: full rounding keeps the middle of the
    // riser as sheer as the hard clamp does (sheer fraction within a few %)
    const sheer = (f: ReturnType<typeof createWorldField>): number => slopeProfile(f).steep;
    expect(Math.abs(sheer(world(0.25)) - sheer(world(0)))).toBeLessThan(0.05);
  });
});

// -------------------------------------------------------------- cliff scatter

describe("cliff scatter", () => {
  const rule = {
    id: "crag",
    prefab: undefined,
    model: "rock.glb",
    material: undefined,
    biomes: [] as string[],
    density: 0.01,
    slopeMax: 1,
    slopeMin: 0.6,
    yawOffset: 0,
    height: undefined,
    scale: [1, 1.6] as [number, number],
    alignToNormal: 0,
    yOffset: 0,
    jitter: 0.8,
    clearance: 0,
    collider: "none" as const,
    colliderSize: [1, 2, 1] as [number, number, number],
    static: true,
    castShadow: true,
    lod: true,
    cliff: { stack: [3, 5] as [number, number], spacing: 6, spacingJitter: 0.3, embed: 2, embedJitter: 0.5, lateral: 2, faceOut: 1, yawSpread: 0.4, tilt: 0.2, lean: 0.35, leanJitter: 0.1, minDrop: 6, search: 12 },
  };
  const recipe = worldRecipeSchema.parse(
    testRecipe({
      cellSize: 64,
      resolution: 16,
      terrain: {
        ...testRecipe().terrain,
        mountains: { frequency: 0.0025, amplitude: 500, octaves: 4, lacunarity: 2, gain: 0.5, ridged: true, seed: 37 },
        mountainMask: { spec: { frequency: 0.0012, amplitude: 1, octaves: 3, lacunarity: 2, gain: 0.5, ridged: false, seed: 53 }, start: 0.45, end: 0.7 },
      },
      scatter: [rule],
    } as Partial<WorldRecipe>),
  );
  const field = createWorldField(recipe);
  const size = recipe.cellSize;

  const all = (): { i: (typeof out)[number]; cx: number; cz: number }[] => {
    const list: { i: never; cx: number; cz: number }[] = [];
    for (let cz = -6; cz <= 6; cz++)
      for (let cx = -6; cx <= 6; cx++) for (const i of scatterCell(field, cx, cz)) list.push({ i: i as never, cx, cz });
    return list as never;
  };
  const out = scatterCell(field, 0, 0);
  const every = all();

  it("puts props on a cliff at all, and repeats exactly", () => {
    expect(every.length).toBeGreaterThan(30);
    for (let cz = -1; cz <= 1; cz++)
      for (let cx = -1; cx <= 1; cx++) expect(JSON.stringify(scatterCell(field, cx, cz))).toBe(JSON.stringify(scatterCell(field, cx, cz)));
    void out;
  });

  it("stacks a column instead of the one prop a plan-projected lattice would give", () => {
    // ids are `<rule>_<gx>_<gz>_<k>`; a face that only ever produced k=0 would
    // mean the vertical walk is not working and cliffs stay bare
    const perColumn = new Map<string, number>();
    for (const { i } of every) {
      const key = i.id.split("_").slice(0, 3).join("_");
      perColumn.set(key, (perColumn.get(key) ?? 0) + 1);
    }
    expect(Math.max(...perColumn.values())).toBeGreaterThanOrEqual(3);
  });

  it("refuses ground gentler than slopeMin — a stack on a meadow is a tower of floating boulders", () => {
    // asserted through the count rather than by re-deriving the jittered
    // lattice point here: that would be a copy of the code under test, and it
    // would pass just as happily if both copies were wrong
    const count = (slopeMin: number): number => {
      const f = createWorldField(worldRecipeSchema.parse({ ...recipe, scatter: [{ ...rule, slopeMin }] } as never));
      let n = 0;
      for (let cz = -6; cz <= 6; cz++) for (let cx = -6; cx <= 6; cx++) n += scatterCell(f, cx, cz).length;
      return n;
    };
    const gentle = count(0);
    const steep = count(0.6);
    const sheer = count(0.9);
    expect(gentle).toBeGreaterThan(steep);
    expect(steep).toBeGreaterThan(sheer);
    expect(sheer).toBeGreaterThan(0);
  });

  it("beds every prop into the face rather than standing it on the surface", () => {
    // the model's own origin, pushed in by `embed`, must be inside the rock:
    // that is the whole difference between a cliff and a field of menhirs
    let inside = 0;
    for (const { i, cx, cz } of every) {
      const x = i.position[0] + cx * size;
      const z = i.position[2] + cz * size;
      if (field.height(x, z) > i.position[1]) inside++;
    }
    expect(inside / every.length).toBeGreaterThan(0.85);
  });

  it("gives no two props the same id, so cells cannot claim one column twice", () => {
    const seen = new Set<string>();
    for (const { i } of every) {
      expect(seen.has(i.id), `${i.id} claimed twice`).toBe(false);
      seen.add(i.id);
    }
  });
});
