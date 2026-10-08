import { describe, expect, it } from "vitest";
import {
  buildVoxelMesh, createWorldField, defaultWorldRecipe, marchingCubes, worldRecipeSchema,
  type SampledBlock, type VoxelMeshSource, type WorldField,
} from "../src/index.js";

const base = defaultWorldRecipe();
const recipe = worldRecipeSchema.parse({
  ...base, cellSize: 48, resolution: 24, minY: -100,
  bounds: { continents: [{ center: [0, 0], radius: 100, falloff: 60, warp: 0 }], oceanFloor: -45, landFloor: 4 },
  terrain: { ...base.terrain, caves: { ...base.terrain.caves, enabled: false } },
  biomes: [{ id: "seabed", surface: [0, 1, 0, 0, 0, 0, 0, 0] }], patches: [], features: {},
});
const source: VoxelMeshSource = { kind: "voxel", world: "flat", cell: [20, 20] };

function pair(field: WorldField, src = source) {
  let block!: SampledBlock;
  const mesh = buildVoxelMesh({ ...field, sampleBlock(request) {
    const values = field.sampleBlock(request); block = { ...request, values }; return values;
  } }, src);
  const reference = marchingCubes(block, { attributes: { surface: {
    size: field.surfaceCount + 3,
    compute: (x, y, z, _nx, ny, _nz, out, offset) => field.surfaceAt(x, y, z, ny, out, offset),
  } } });
  return { mesh, reference };
}

describe("uniform flat voxel cells", () => {
  it("collapses the interior while retaining every boundary sample and its attributes", () => {
    const field = createWorldField(recipe), { mesh, reference } = pair(field);
    expect(reference.triangleCount).toBe(2 * 24 * 24);
    expect(mesh.triangleCount).toBe(12 * 24); // 96 top faces + 192 skirt faces
    expect(mesh.vertexCount).toBe(12 * 24 + 1);
    const boundary = new Map<string, number>();
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = mesh.positions[i * 3]!, y = mesh.positions[i * 3 + 1]!, z = mesh.positions[i * 3 + 2]!;
      if (y === -45 && (x === 0 || z === 0 || x === 48 || z === 48)) boundary.set(`${x},${z}`, i);
    }
    expect(boundary.size).toBe(96);
    for (let i = 0; i < reference.vertexCount; i++) {
      const x = reference.positions[i * 3]! - 960, z = reference.positions[i * 3 + 2]! - 960;
      if (x !== 0 && z !== 0 && x !== 48 && z !== 48) continue;
      const at = boundary.get(`${x},${z}`)!; expect(at).toBeDefined();
      expect(Array.from(mesh.normals.slice(at * 3, at * 3 + 3))).toEqual(Array.from(reference.normals.slice(i * 3, i * 3 + 3)));
      expect(Array.from(mesh.splat.slice(at * field.surfaceCount, (at + 1) * field.surfaceCount)))
        .toEqual(Array.from(reference.attributes.surface!.slice(i * 11, i * 11 + 8)));
      expect(Array.from(mesh.tint.slice(at * 3, at * 3 + 3)))
        .toEqual(Array.from(reference.attributes.surface!.slice(i * 11 + 8, i * 11 + 11)));
    }
    // Every top triangle faces up and together they cover the complete cell.
    let area = 0;
    for (let i = 0; i < 96 * 3; i += 3) {
      const [a, b, c] = Array.from(mesh.indices.slice(i, i + 3)).map(v => [mesh.positions[v * 3]!, mesh.positions[v * 3 + 2]!] as const);
      const twice = (b![1] - a![1]) * (c![0] - a![0]) - (b![0] - a![0]) * (c![1] - a![1]);
      expect(twice).toBeGreaterThan(0); area += twice / 2;
    }
    expect(area).toBe(48 * 48);
  });

  it("welds equal-LOD neighbors and retains the same surface across LOD steps", () => {
    const field = createWorldField(recipe);
    for (const lodStep of [1, 2, 4, 8]) {
      const a = buildVoxelMesh(field, { ...source, lodStep });
      const b = buildVoxelMesh(field, { ...source, cell: [21, 20], lodStep });
      const seam = (m: typeof a, x: number) => {
        const out = [];
        for (let i = 0; i < m.vertexCount; i++) if (m.positions[i * 3] === x && m.positions[i * 3 + 1] === -45) out.push(m.positions[i * 3 + 2]);
        return out.sort((x, y) => x! - y!);
      };
      expect(seam(a, 48)).toEqual(seam(b, 0));
      expect(a.max).toEqual([48, -45, 48]); expect(a.min).toEqual([0, -45 - 6 * lodStep, 0]);
      expect(a.triangleCount).toBe(12 * (24 / lodStep));
    }
  });

  it("keeps an interior cave even when all four corners are the same flat floor", () => {
    const field = createWorldField(worldRecipeSchema.parse({ ...recipe, features: {
      blobs: [{ id: "underwater-cave", center: [984, -57, 984], radius: 6, op: "remove" }],
    } }));
    const { mesh, reference } = pair(field);
    expect(mesh.triangleCount).toBeGreaterThan(reference.triangleCount);
    expect(mesh.triangleCount).toBeGreaterThan(1344);
    expect(Array.from(mesh.normals).some((value, i) => i % 3 === 1 && value < -0.9)).toBe(true);
  });

  it("preserves an isolated height edit inside an otherwise uniform cell", () => {
    const field = createWorldField(worldRecipeSchema.parse({ ...recipe, features: {
      heightPatches: [{ id: "seabed-mound", origin: [974, 974], size: [20, 20], columns: 3, rows: 3,
        heights: [-45, -45, -45, -45, -35, -45, -45, -45, -45], blend: 3 }],
    } }));
    const { mesh, reference } = pair(field);
    expect(mesh.max[1]).toBeGreaterThan(-40);
    expect(mesh.triangleCount).toBeGreaterThanOrEqual(reference.triangleCount);
  });

  it("preserves interior material and tint changes even when the geometry is flat", () => {
    const plain = createWorldField(recipe);
    for (const channel of [0, plain.surfaceCount]) {
      const field: WorldField = { ...plain, surfaceAt(x, y, z, ny, out, offset) {
        plain.surfaceAt(x, y, z, ny, out, offset);
        if (x === 984 && z === 984) out[offset + channel] = 0.5;
      } };
      const { mesh } = pair(field);
      expect(mesh.triangleCount).toBe(1344);
      expect(Array.from(channel === 0 ? mesh.splat : mesh.tint)).toContain(0.5);
    }
  });

  it("does not collapse multiple horizontal surfaces, and handles empty vertical sections", () => {
    const plain = createWorldField(recipe);
    const field: WorldField = { ...plain, sampleBlock(request) {
      const values = plain.sampleBlock(request), { nx, ny, nz, origin, step } = request;
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const at = i + j * nx + k * nx * ny;
        values[at] = Math.max(values[at]!, 4 - Math.abs(origin[1] + j * step + 58));
      }
      return values;
    } };
    const { mesh, reference } = pair(field);
    expect(reference.triangleCount).toBeGreaterThan(1152);
    expect(mesh.triangleCount).toBeGreaterThan(reference.triangleCount);
    expect(buildVoxelMesh(plain, { ...source, yRange: [-20, 0] }).triangleCount).toBe(0);
  });
});
