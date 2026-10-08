import { describe, expect, it } from "vitest";
import {
  clearingSchema,
  coverClumpRejects,
  coverVegetationRejects,
  createWorldField,
  defaultWorldRecipe,
  scatterCell,
  vegetationIndex,
  worldRecipeSchema,
  type VoxelScatterInstance,
  type WorldField,
} from "../src/index.js";

/**
 * Region vegetation + clearings (docs/voxel-worlds.md section 31): what grows
 * where a ZONE or PLACE says, and nothing inside a clearing — through the one
 * scatter path and the one cover gate.
 */

const GROUND = 20;
const CELL = 32;

const rule = (id: string, density: number, extra: Record<string, unknown> = {}) => ({
  id,
  prefab: `trees/${id}`,
  density,
  slopeMax: 0.9,
  scale: [1, 1],
  jitter: 0.8,
  spacing: 0.5,
  collider: "cylinder",
  colliderSize: [0.6, 4, 0.6],
  ...extra,
});

const square = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [
  [x0, z0],
  [x1, z0],
  [x1, z1],
  [x0, z1],
];

/** A flat plain over [-240, 240]², a pine wood, an unused dead-tree rule, rocks and one clumped cover layer. */
function world(extra: { regions?: unknown[]; clearings?: unknown[] } = {}): WorldField {
  const base = defaultWorldRecipe();
  return createWorldField(
    worldRecipeSchema.parse({
      ...base,
      cellSize: CELL,
      resolution: 16,
      terrain: { ...base.terrain, caves: { ...base.terrain.caves, enabled: false } },
      features: {
        ...base.features,
        heightPatches: [{ id: "plain", origin: [-240, -240], size: [480, 480], columns: 2, rows: 2, heights: [GROUND, GROUND, GROUND, GROUND], blend: 20 }],
        ...(extra.clearings ? { clearings: extra.clearings } : {}),
      },
      regions: extra.regions ?? [],
      scatter: [rule("pine", 0.02), rule("dead", 0), rule("rock", 0.01, { collider: "box", colliderSize: [1, 1, 1] })],
      cover: [
        { id: "grass", density: 2, clump: { frequency: 0.05, threshold: 0, blend: 0.3, floor: 0.2, octaves: 2, seed: 3 } },
        { id: "flowers", density: 1 },
      ],
    }),
  );
}

const cells = (field: WorldField, n = 2): VoxelScatterInstance[] => {
  const out: VoxelScatterInstance[] = [];
  for (let cz = -n; cz < n; cz++) for (let cx = -n; cx < n; cx++) {
    for (const inst of scatterCell(field, cx, cz)) out.push({ ...inst, position: [inst.position[0] + cx * CELL, inst.position[1], inst.position[2] + cz * CELL] });
  }
  return out;
};

const inBox = (i: VoxelScatterInstance, x0: number, z0: number, x1: number, z1: number) =>
  i.position[0] >= x0 && i.position[0] <= x1 && i.position[2] >= z0 && i.position[2] <= z1;

const zone = (vegetation: unknown, poly = square(-64, -64, 0, 64)) => ({ id: "zone-a", name: "Zone A", polygon: poly, vegetation });

describe("region vegetation", () => {
  const plain = cells(world());

  it("a region without vegetation, or one far away, changes nothing", () => {
    expect(JSON.stringify(cells(world({ regions: [zone(undefined)] })))).toBe(JSON.stringify(plain));
    expect(JSON.stringify(cells(world({ regions: [zone({ scatter: { deny: ["pine"] } }, square(1000, 1000, 1100, 1100))] })))).toBe(JSON.stringify(plain));
  });

  it("deny removes a species inside the polygon only", () => {
    const got = cells(world({ regions: [zone({ scatter: { deny: ["pine"] } })] }));
    expect(got.some((i) => i.rule === "pine" && inBox(i, -63, -63, -1, 63))).toBe(false);
    const outside = (list: VoxelScatterInstance[]) => list.filter((i) => i.position[0] > 2).map((i) => i.id).sort();
    expect(outside(got)).toEqual(outside(plain));
    // rocks untouched, inside too
    expect(got.filter((i) => i.rule === "rock").length).toBe(plain.filter((i) => i.rule === "rock").length);
  });

  it("allow is a whitelist; density thins", () => {
    const only = cells(world({ regions: [zone({ scatter: { allow: ["rock"] } })] }));
    expect(only.some((i) => i.rule === "pine" && inBox(i, -63, -63, -1, 63))).toBe(false);
    const thin = cells(world({ regions: [zone({ scatter: { density: 0.25 } })] }));
    const count = (l: VoxelScatterInstance[]) => l.filter((i) => i.rule === "pine" && inBox(i, -63, -63, -1, 63)).length;
    expect(count(thin)).toBeGreaterThan(0);
    expect(count(thin)).toBeLessThan(count(plain) * 0.5);
  });

  it("replace swaps the species at the same spots, ids stay unique", () => {
    const got = cells(world({ regions: [zone({ scatter: { replace: { pine: "dead" } } })] }));
    const dead = got.filter((i) => i.rule === "dead");
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.every((i) => i.ruleIndex === 1 && i.id.startsWith("pine_"))).toBe(true);
    const pinesThere = plain.filter((i) => i.rule === "pine" && inBox(i, -63, -63, -1, 63)).map((i) => i.id).sort();
    expect(dead.map((i) => i.id).filter((id) => pinesThere.includes(id)).length).toBeGreaterThan(pinesThere.length * 0.9);
    expect(new Set(got.map((i) => i.id)).size).toBe(got.length);
  });

  it("resolves most-specific first, field by field; deny is unioned", () => {
    const regions = [
      zone({ scatter: { deny: ["rock"], replace: { pine: "dead" } } }),
      { id: "place-a", name: "Place", polygon: square(-48, -48, -16, 48), within: "zone-a", tags: ["place"], vegetation: { scatter: { density: 0.5, allow: ["pine", "rock"] } } },
    ];
    const field = world({ regions });
    const index = vegetationIndex(field.recipe);
    const place = index.planAt(-30, 0)!;
    expect(place.region).toBe("place-a");
    expect(place.ruleKeep[0]).toBeCloseTo(0.5); // the place's density
    expect(place.ruleKeep[2]).toBe(0); // the zone's deny survives the place's allow
    expect(place.replace[0]).toBe(1); // inherited swap
    expect(index.planAt(-58, 0)!.region).toBe("zone-a");
    expect(index.planAt(10, 0)).toBeNull();
    expect(index.warnings).toEqual([]);
  });

  it("margin reaches past a waterline border, never into another region", () => {
    const regions = [
      zone({ margin: 20, scatter: { deny: ["pine"] } }),
      { id: "zone-b", name: "Zone B", polygon: square(-64, 70, 0, 120) },
    ];
    const index = vegetationIndex(world({ regions }).recipe);
    expect(index.planAt(-30, -70)?.region).toBe("zone-a"); // 6 m outside, no region there
    expect(index.planAt(-30, -90)).toBeNull(); // past the margin
    expect(index.planAt(-30, 75)).toBeNull(); // inside zone-b, which has no vegetation
    expect(index.planAt(10, 0)?.region).toBe("zone-a");
  });

  it("lean tilts the trees toward the wind", () => {
    const got = cells(world({ regions: [zone({ scatter: { lean: { degrees: 20, toward: [1, 0], jitter: 0 } } })] }));
    const pine = got.find((i) => i.rule === "pine" && inBox(i, -60, -60, -4, 60))!;
    const [x, y, z, w] = pine.rotation;
    // the rotated up axis
    const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    expect(up[0]).toBeCloseTo(Math.sin((20 * Math.PI) / 180), 3);
    expect(up[2]).toBeCloseTo(0, 3);
    const rock = got.find((i) => i.rule === "rock" && inBox(i, -60, -60, -4, 60))!;
    expect(rock.rotation[0]).toBeCloseTo(0, 6); // only trees (cylinder colliders) lean by default
  });
});

describe("clearings", () => {
  const plain = cells(world());

  it("clear a polygon of scatter, feathered outside it", () => {
    const got = cells(world({ clearings: [{ id: "pad", polygon: square(-40, -40, 40, 40), feather: 6 }] }));
    expect(got.some((i) => inBox(i, -40, -40, 40, 40))).toBe(false);
    // well away from it, untouched
    const far = (l: VoxelScatterInstance[]) => l.filter((i) => Math.abs(i.position[0]) > 60 || Math.abs(i.position[2]) > 60).map((i) => i.id).sort();
    expect(far(got)).toEqual(far(plain));
  });

  it("a circle with keep thins rather than clears", () => {
    const field = world({ clearings: [{ id: "glade", center: [0, 0], radius: 50, keep: 0.4, feather: 0 }] });
    const got = cells(field);
    const inside = (l: VoxelScatterInstance[]) => l.filter((i) => Math.hypot(i.position[0], i.position[2]) < 30).length;
    expect(inside(got)).toBeGreaterThan(0);
    expect(inside(got)).toBeLessThan(inside(plain));
  });

  it("cover: same gate as the clump mask where nothing applies; clears inside a clearing; a denied layer is gone", () => {
    const field = world({
      clearings: [{ id: "pad", center: [100, 100], radius: 20, scatter: false }],
      regions: [zone({ cover: { deny: ["flowers"] } })],
    });
    const recipe = field.recipe;
    const [grass, flowers] = recipe.cover;
    for (let x = 150; x < 200; x += 1.7) {
      expect(coverVegetationRejects(recipe, grass!, x, 150)).toBe(coverClumpRejects(grass!, recipe.seed, x, 150));
    }
    for (let x = 85; x < 115; x += 1.3) expect(coverVegetationRejects(recipe, flowers!, x, 100)).toBe(true);
    for (let x = -60; x < -4; x += 2.1) expect(coverVegetationRejects(recipe, flowers!, x, 10)).toBe(true);
    expect(coverVegetationRejects(recipe, flowers!, 20, 10)).toBe(false);
    // scatter: false leaves the props
    expect(vegetationIndex(recipe).clearingKeep(100, 100, 0)).toBe(1);
  });

  it("schema: polygon OR circle", () => {
    expect(clearingSchema.safeParse({ id: "a", center: [0, 0], radius: 3 }).success).toBe(true);
    expect(clearingSchema.safeParse({ id: "a", polygon: square(0, 0, 1, 1), center: [0, 0], radius: 3 }).success).toBe(false);
    expect(clearingSchema.safeParse({ id: "a" }).success).toBe(false);
  });
});
