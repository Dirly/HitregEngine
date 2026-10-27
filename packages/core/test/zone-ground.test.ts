import { describe, expect, it } from "vitest";
import {
  buildVoxelMesh,
  createWorldField,
  defaultWorldRecipe,
  materialSchema,
  mergeVoxelMeshes,
  recipeSplatIndexed,
  reduceSplatTop4,
  regionSchema,
  roadSchema,
  surfaceAliases,
  surfaceBaseIndex,
  worldRecipeSchema,
  zoneGroundRoles,

  SPLAT_TOP_UNUSED,
  type VoxelMesh,
} from "../src/index.js";
import { createZoneMembership as membershipOf } from "../src/voxel/zone-ground.js";

/**
 * Zone ground: a zone restyles roles (grass, ground, cliff, road, paving,
 * accent), blended by membership across its border; an indexed world meshes
 * the four layers each vertex blends.
 */

/** One flat-ish meadow biome (all grass, cliff on steep ground), a zone covering x < 0, and two zone surfaces. */
function zonedRecipe(extra: Record<string, unknown> = {}) {
  const base = defaultWorldRecipe();
  const surfaces = [
    ...base.surfaces.map((s) => (s.name === "grass" ? { ...s, role: "grass" } : s.name === "rock" ? { ...s, role: "cliff" } : s)),
    { name: "zgrass", color: "#406030", roughness: 0.9, uvScale: 4 },
    { name: "zcobble", color: "#706860", roughness: 0.9, uvScale: 3 },
  ];
  const width = surfaces.length;
  const weights = (one: number) => Array.from({ length: width }, (_, i) => (i === one ? 1 : 0));
  return worldRecipeSchema.parse({
    ...base,
    cellSize: 32,
    resolution: 16,
    surfaces,
    patches: [],
    biomes: [{ id: "meadow", surface: weights(0), cliff: weights(2) }],
    regions: [
      {
        id: "west",
        name: "West",
        polygon: [
          [-4000, -4000],
          [0, -4000],
          [0, 4000],
          [-4000, 4000],
        ],
        ground: { grass: "zgrass", paving: "zcobble" },
      },
      {
        id: "east",
        name: "East",
        polygon: [
          [0, -4000],
          [4000, -4000],
          [4000, 4000],
          [0, 4000],
        ],
      },
    ],
    ...extra,
  });
}

const GRASS = 0;
const ZGRASS = 8;
const ZCOBBLE = 9;

describe("zone ground schema", () => {
  it("validates a region's role -> surface map and rejects unknown roles", () => {
    const polygon = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    expect(regionSchema.safeParse({ id: "z", name: "Z", polygon, ground: { grass: "a", paving: "b" } }).success).toBe(true);
    expect(regionSchema.safeParse({ id: "z", name: "Z", polygon, ground: { lava: "a" } }).success).toBe(false);
    expect(regionSchema.safeParse({ id: "z", name: "Z", polygon, ground: { grass: "" } }).success).toBe(false);
  });

  it("road role is road/paving/none and optional", () => {
    expect(roadSchema.parse({ points: [[0, 0], [1, 1]] }).role).toBeUndefined();
    expect(roadSchema.parse({ points: [[0, 0], [1, 1]], role: "paving" }).role).toBe("paving");
    expect(roadSchema.safeParse({ points: [[0, 0], [1, 1]], role: "cobble" }).success).toBe(false);
  });

  it("a palette past 16 is indexed; a dense material past 16 layers is refused", () => {
    const r = zonedRecipe();
    expect(r.splat).toBe("dense");
    expect(recipeSplatIndexed(r)).toBe(false);
    expect(recipeSplatIndexed({ ...r, splat: "indexed" })).toBe(true);
    const many = Array.from({ length: 20 }, () => ({ name: "s" }));
    expect(recipeSplatIndexed({ splat: "dense", surfaces: many as never })).toBe(true);
    const layers = Array.from({ length: 20 }, () => ({ color: "#ffffff" }));
    expect(materialSchema.safeParse({ shader: "terrain-splat", splat: { source: "vertex", layers } }).success).toBe(false);
    expect(materialSchema.safeParse({ shader: "terrain-splat", splat: { source: "indexed", layers } }).success).toBe(true);
  });

  it("resolves roles, aliases and base names", () => {
    const r = zonedRecipe();
    const roles = zoneGroundRoles(r);
    expect(roles.zones.map((z) => z.id)).toEqual(["west"]);
    expect(roles.baseRole[GRASS]).toBe(0);
    expect(roles.baseRole[ZGRASS]).toBe(-1);
    expect(roles.overrideRole[ZGRASS]).toBe(0);
    expect(surfaceAliases(r, "grass")).toEqual([GRASS, ZGRASS]);
    expect(surfaceAliases(r, "sand")).toEqual([1]);
    expect(surfaceBaseIndex(r, ZGRASS)).toBe(GRASS);
    expect(surfaceBaseIndex(r, 1)).toBe(1);
    const bad = zonedRecipe({ regions: [{ id: "x", name: "X", polygon: [[0, 0], [9, 0], [9, 9]], ground: { grass: "nope" } }] });
    expect(zoneGroundRoles(bad).unresolved).toEqual(["x.grass -> nope"]);
  });
});

describe("zone ground in the field", () => {
  const field = createWorldField(zonedRecipe());
  const at = (x: number, z: number) => field.biome(x, z, 10, 0).surface;

  it("deep inside the zone its grass replaces the base grass; outside nothing changes", () => {
    const inside = at(-600, 40);
    expect(inside[GRASS]).toBeCloseTo(0, 4);
    expect(inside[ZGRASS]).toBeCloseTo(1, 4);
    const outside = at(600, 40);
    expect(outside[GRASS]).toBeCloseTo(1, 4);
    expect(outside[ZGRASS]).toBeCloseTo(0, 4);
  });

  it("blends across the border gradually: monotone, no step larger than a sliver", () => {
    let prev = 1;
    let mid = 0;
    for (let x = -260; x <= 260; x += 4) {
      const share = at(x, 40)[ZGRASS]!;
      expect(share).toBeLessThanOrEqual(prev + 0.02);
      expect(Math.abs(share - prev)).toBeLessThan(0.12);
      if (x === 0) mid = share;
      prev = share;
    }
    expect(mid).toBeGreaterThan(0.1);
    expect(mid).toBeLessThan(0.9);
  });

  it("paving roads paint the zone's cobble inside it and their own surface outside", () => {
    const road = (role: "road" | "paving") => ({ id: `r-${role}`, points: [[-900, 0], [900, 0]], width: 8, surface: "dirt", role, flatten: 0 });
    const paved = createWorldField(zonedRecipe({ features: { roads: [road("paving")] } }));
    const west = paved.biome(-600, 0, 10, 0).surface;
    expect(west[ZCOBBLE]).toBeGreaterThan(0.9);
    const east = paved.biome(600, 0, 10, 0).surface;
    expect(east[ZCOBBLE]).toBeCloseTo(0, 4);
    expect(east[4]).toBeGreaterThan(0.9); // dirt
    // a `road` road keeps its dirt: the zone overrides paving, not road
    const plain = createWorldField(zonedRecipe({ features: { roads: [road("road")] } }));
    expect(plain.biome(-600, 0, 10, 0).surface[4]).toBeGreaterThan(0.9);
  });
});

/** Every triangle's three corners carry the same ordered layer set. */
function expectTriangleConsistent(mesh: VoxelMesh): void {
  const ids = mesh.layerIndex!;
  for (let t = 0; t < mesh.triangleCount; t++) {
    const a = mesh.indices[t * 3]!;
    for (let c = 1; c < 3; c++) {
      const b = mesh.indices[t * 3 + c]!;
      for (let k = 0; k < 4; k++) expect(ids[b * 4 + k]).toBe(ids[a * 4 + k]);
    }
  }
}

describe("indexed top-4 packing", () => {
  it("keeps the heaviest four per triangle, sorted, unused slots 255, weights summing to 255", () => {
    // two triangles sharing an edge; vertex 1 and 2 are shared, and the sets differ
    const S = 6;
    const splat = new Float32Array([
      // v0: layers 0,1,2,3
      0.4, 0.3, 0.2, 0.1, 0, 0,
      // v1
      0.5, 0, 0, 0, 0.5, 0,
      // v2
      1, 0, 0, 0, 0, 0,
      // v3: layer 5 only
      0, 0, 0, 0, 0, 1,
    ]);
    const mesh: VoxelMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
      splat,
      surfaceCount: S,
      tint: new Float32Array(12).fill(1),
      min: [0, 0, 0],
      max: [1, 0, 1],
      vertexCount: 4,
      triangleCount: 2,
    };
    const out = reduceSplatTop4(mesh);
    expect(out.triangleCount).toBe(2);
    // v1 and v2 are duplicated (two different sets meet on their edge)
    expect(out.vertexCount).toBe(6);
    expectTriangleConsistent(out);
    const t0 = [...out.layerIndex!.subarray(out.indices[0]! * 4, out.indices[0]! * 4 + 4)];
    expect(t0).toEqual([0, 1, 2, 4]); // layer 3 (0.1) is the lightest of five
    const t1 = [...out.layerIndex!.subarray(out.indices[5]! * 4, out.indices[5]! * 4 + 4)];
    expect(t1).toEqual([0, 4, 5, SPLAT_TOP_UNUSED]);
    for (let v = 0; v < out.vertexCount; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += out.layerWeight![v * 4 + k]!;
      expect(Math.abs(sum - 255)).toBeLessThanOrEqual(2);
      // duplicates sit exactly where their source did
      expect(out.positions[v * 3 + 1]).toBe(0);
    }
  });

  it("hands dropped weight to a kept layer of the same role group", () => {
    const S = 6;
    const one = (w: number[]) => Float32Array.from(w);
    const mesh: VoxelMesh = {
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      splat: Float32Array.from([...one([0.3, 0.2, 0.2, 0.2, 0.1, 0]), ...one([0.3, 0.2, 0.2, 0.2, 0.1, 0]), ...one([0.3, 0.2, 0.2, 0.2, 0.1, 0])]),
      surfaceCount: S,
      tint: new Float32Array(9).fill(1),
      min: [0, 0, 0],
      max: [0, 0, 0],
      vertexCount: 3,
      triangleCount: 1,
    };
    const roleGroup = Int8Array.from([0, -1, -1, -1, 0, -1]);
    const out = reduceSplatTop4(mesh, { roleGroup });
    // layer 4 (0.1) is dropped; its group sibling layer 0 takes it: 0.4 of 1.0
    expect([...out.layerIndex!.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
    expect(out.layerWeight![0]).toBe(Math.round(0.4 * 255));
  });

  it("an indexed world meshes consistent sets, merges them, and a dense world carries none", () => {
    const dense = createWorldField(zonedRecipe());
    const plain = buildVoxelMesh(dense, { kind: "voxel", world: "w", cell: [-1, 0] });
    expect(plain.layerIndex).toBeUndefined();

    const field = createWorldField(zonedRecipe({ splat: "indexed" }));
    // straddle the border so both grasses (and their blend) are in the cell set
    const meshes = [-2, -1, 0, 1].map((cx) => buildVoxelMesh(field, { kind: "voxel", world: "w", cell: [cx, 0] }));
    for (const mesh of meshes) {
      expect(mesh.triangleCount).toBeGreaterThan(0);
      expect(mesh.layerIndex!.length).toBe(mesh.vertexCount * 4);
      expect(mesh.layerWeight!.length).toBe(mesh.vertexCount * 4);
      expectTriangleConsistent(mesh);
    }
    const ids = new Set<number>();
    for (const mesh of meshes) for (let i = 0; i < mesh.layerIndex!.length; i++) if (mesh.layerWeight![i]! > 0) ids.add(mesh.layerIndex![i]!);
    expect(ids.has(GRASS) || ids.has(ZGRASS)).toBe(true);
    const merged = mergeVoxelMeshes(meshes.map((mesh) => ({ mesh, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })));
    expect(merged!.layerIndex!.length).toBe(merged!.vertexCount * 4);
    expectTriangleConsistent(merged!);
  });
});

describe("nested region flat-cliff rule", () => {
  it("a region nested in a palette zone sends its cliff weight on the flat to its own accent, like the zone", () => {
    const recipe = {
      seed: 1,
      surfaces: [
        { name: "grass", role: "grass" },
        { name: "rock", role: "cliff" },
        { name: "sand", role: "accent" },
        { name: "zcliff" },
        { name: "zaccent" },
        { name: "gcliff" },
        { name: "gaccent" },
      ],
      regions: [
        { id: "zone", polygon: [[0, 0], [100, 0], [100, 100]] as [number, number][], ground: { cliff: "zcliff", accent: "zaccent" }, palette: { cliff: ["zcliff", "gcliff"] } },
        { id: "gorge", within: "zone", polygon: [[10, 10], [20, 10], [20, 20]] as [number, number][], ground: { cliff: "gcliff", accent: "gaccent" } },
        { id: "plain", polygon: [[200, 0], [300, 0], [300, 100]] as [number, number][], ground: { cliff: "zcliff", accent: "zaccent" } },
      ],
    };
    const roles = zoneGroundRoles(recipe as never);
    const by = Object.fromEntries(roles.zones.map((z) => [z.id, z]));
    expect(by["zone"]!.flatCliff).toBe(4);
    expect(by["gorge"]!.parent).toBe(0);
    expect(by["gorge"]!.flatCliff).toBe(6);
    expect(by["plain"]!.flatCliff).toBe(-1);
  });
});

describe("per-region ground band", () => {
  it("a region's groundBand narrows its own blend; others keep the world band", () => {
    const sq = (x0: number, x1: number) => [[x0, -1000], [x1, -1000], [x1, 1000], [x0, 1000]] as [number, number][];
    const recipe = {
      seed: 3,
      surfaces: [{ name: "grass", role: "grass" }, { name: "a" }, { name: "b" }],
      zoneGround: { band: 150, jitter: 0 },
      regions: [
        { id: "wide", polygon: sq(-2000, 0), ground: { grass: "a" } },
        { id: "narrow", polygon: sq(1000, 3000), ground: { grass: "b" }, groundBand: 20 },
      ],
    };
    const roles = zoneGroundRoles(recipe as never);
    const at = membershipOf(recipe as never, roles);
    const out = new Float32Array(2);
    at(-40, 0, out); // 40 m inside the wide zone: still blending over its 150 m band
    expect(out[0]!).toBeGreaterThan(0.6);
    expect(out[0]!).toBeLessThan(0.95);
    at(1024, 0, out); // 24 m inside the narrow one: full
    expect(out[1]!).toBeGreaterThan(0.99);
    at(976, 0, out); // 24 m outside: nothing
    expect(out[1]!).toBeLessThan(0.01);
  });
});
