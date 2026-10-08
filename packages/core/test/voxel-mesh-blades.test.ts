import { describe, expect, it } from "vitest";
import { auditVoxelMesh, buildVoxelMesh, createWorldField, defaultWorldRecipe, passageSchema, worldRecipeSchema } from "../src/index.js";

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
