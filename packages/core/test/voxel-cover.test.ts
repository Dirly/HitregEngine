import { describe, expect, it } from "vitest";
import {
  coverClumpKeep,
  coverEdgeClearance,
  coverClumpRejects,
  coverScratch,
  coverWaterGate,
  coverWaterLevel,
  grassSchema,
  worldRecipeSchema,
  defaultWorldRecipe,
  type SurfaceSample,
  type WorldField,
} from "../src/index.js";

/**
 * A stub world for the water gates: sea level 0, one round lake (surface
 * y = 10, radius 20) at the origin, a river strip along x in [100, 110]
 * flowing fast, and dry land everywhere else.
 */
function stubField(): WorldField {
  const lake = (x: number, z: number) => Math.hypot(x, z) <= 20;
  const river = (x: number) => x >= 100 && x <= 110;
  const field = {
    recipe: { seaLevel: 0, seed: 7 },
    waterY: (x: number, z: number) => (lake(x, z) ? 10 : river(x) ? 5 : null),
    waterSurface: (x: number, z: number, out: SurfaceSample) => {
      if (lake(x, z)) {
        Object.assign(out, { y: 10, flowX: 0, flowZ: 0, kind: "lake", floor: -Infinity });
        return true;
      }
      if (river(x)) {
        Object.assign(out, { y: 5, flowX: 2, flowZ: 0, kind: "river", floor: 3 });
        return true;
      }
      return false;
    },
    waterNear: (x0: number, z0: number, x1: number, z1: number) =>
      (x1 >= -20 && x0 <= 20 && z1 >= -20 && z0 <= 20) || (x1 >= 100 && x0 <= 110),
    shoreDistance: () => Infinity,
  };
  return field as unknown as WorldField;
}

const layer = (extra: Record<string, unknown>) => grassSchema.parse(extra);

describe("cover water gate", () => {
  const field = stubField();
  const scratch = coverScratch();

  it("keeps ordinary cover out of lakes, rivers and the sea", () => {
    const plain = layer({});
    expect(coverWaterGate(field, plain, 0, 0, 9.5, 9.6, scratch)).toBeNull(); // lake bed
    expect(coverWaterGate(field, plain, 105, 0, 4, 4.1, scratch)).toBeNull(); // river bed
    expect(coverWaterGate(field, plain, 500, 500, -2, -1.9, scratch)).toBeNull(); // under the sea
    expect(coverWaterGate(field, plain, 60, 60, 12, 12.1, scratch)).toBe(12); // dry land
  });

  it("grows a shore layer only inside its band of the nearest water line", () => {
    const reeds = layer({ water: { mode: "shore", level: [-0.5, 1], reach: 5 } });
    // just outside the lake edge (r = 22), ground 10.5: half a metre above the water
    expect(coverWaterGate(field, reeds, 22, 0, 10.4, 10.5, scratch)).toBe(10.4);
    // in the shallows, 0.3 m under the surface: emergent reeds are allowed
    expect(coverWaterGate(field, reeds, 18, 0, 9.6, 9.7, scratch)).toBe(9.6);
    // too far above the water
    expect(coverWaterGate(field, reeds, 22, 0, 13, 13, scratch)).toBeNull();
    // too deep
    expect(coverWaterGate(field, reeds, 5, 0, 7, 7, scratch)).toBeNull();
    // no water within reach at all
    expect(coverWaterGate(field, reeds, 60, 60, 10.3, 10.3, scratch)).toBeNull();
  });

  it("finds the water line from dry ground within reach", () => {
    expect(coverWaterLevel(field, 23, 0, 5, ["lake", "river"], scratch)).toBe(10);
    expect(coverWaterLevel(field, 23, 0, 5, ["river"], scratch)).toBeNaN();
    expect(coverWaterLevel(field, 60, 60, 5, ["lake", "river"], scratch)).toBeNaN();
  });

  it("floats a surface layer on calm water of the right depth, a hand above the sheet", () => {
    const lilies = layer({ orient: "flat", water: { mode: "surface", depth: [0.3, 2.5] } });
    const y = coverWaterGate(field, lilies, 10, 0, 0, 9, scratch);
    expect(y).not.toBeNull();
    expect(y!).toBeGreaterThan(10);
    expect(y!).toBeLessThan(10.1);
    expect(coverWaterGate(field, lilies, 10, 0, 0, 9.9, scratch)).toBeNull(); // 0.1 m: too shallow
    expect(coverWaterGate(field, lilies, 10, 0, 0, 4, scratch)).toBeNull(); // 6 m: too deep
    // the river flows at 2 m/s, past maxFlow
    expect(coverWaterGate(field, lilies, 105, 0, 0, 4.5, scratch)).toBeNull();
    // dry land
    expect(coverWaterGate(field, lilies, 60, 60, 0, 12, scratch)).toBeNull();
  });
});

describe("cover on the lake bed", () => {
  const field = stubField();
  const scratch = coverScratch();
  it("grows under calm water of the right depth, never on dry land or in a torrent", () => {
    const weed = layer({ water: { mode: "bed", depth: [0.5, 3] } });
    expect(coverWaterGate(field, weed, 5, 0, 8.4, 8.5, scratch)).toBe(8.4); // 1.5 m under the lake
    expect(coverWaterGate(field, weed, 5, 0, 9.7, 9.8, scratch)).toBeNull(); // too shallow
    expect(coverWaterGate(field, weed, 5, 0, 2, 2, scratch)).toBeNull(); // 8 m: too deep to see
    expect(coverWaterGate(field, weed, 60, 60, 8, 8, scratch)).toBeNull(); // dry land
    expect(coverWaterGate(field, weed, 105, 0, 3.9, 4, scratch)).toBeNull(); // 2 m/s river
  });

  it("never lets a weed card poke out of the water", () => {
    const tall = layer({ bladeHeight: 1.2, scaleRange: [0.8, 1], water: { mode: "bed", depth: [0.5, 3] } });
    expect(coverWaterGate(field, tall, 5, 0, 8.9, 9, scratch)).toBeNull(); // 1 m deep: a 1.2 m card breaks the surface
    expect(coverWaterGate(field, tall, 5, 0, 8.4, 8.5, scratch)).toBe(8.4); // 1.5 m: fits under
  });
});

describe("ragged clearance edge", () => {
  it("stays inside [base, base + band] and actually wanders", () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 3000; i++) {
      const c = coverEdgeClearance(9, i * 0.37, i * 0.91, 1, 1.8);
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
    expect(lo).toBeGreaterThanOrEqual(1);
    expect(hi).toBeLessThanOrEqual(2.8 + 1e-9);
    expect(hi - lo).toBeGreaterThan(1.2);
  });
});

describe("cover clumps", () => {
  it("keeps everything without a clump, and only thins with one", () => {
    expect(coverClumpKeep(undefined, 1, 5, 5)).toBe(1);
    const clump = layer({ clump: { frequency: 0.02, threshold: 0.1, floor: 0.2 } }).clump!;
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < 2000; i++) {
      const k = coverClumpKeep(clump, 1, i * 13.7, i * 7.3);
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
    expect(lo).toBeGreaterThanOrEqual(0.2 - 1e-9); // the floor survives between patches
    expect(lo).toBeLessThan(0.25);
    expect(hi).toBeGreaterThan(0.95); // and inside a patch everything does
  });

  it("forms patches: nearby candidates agree far more often than chance", () => {
    const l = layer({ clump: { frequency: 0.02, threshold: 0.1, floor: 0 } });
    let same = 0;
    let total = 0;
    for (let x = 0; x < 400; x += 5)
      for (let z = 0; z < 400; z += 5) {
        const a = coverClumpKeep(l.clump, 3, x, z) > 0.5;
        const b = coverClumpKeep(l.clump, 3, x + 2, z) > 0.5;
        if (a === b) same++;
        total++;
      }
    expect(same / total).toBeGreaterThan(0.9);
    // and the rejection is deterministic per point
    expect(coverClumpRejects(l, 3, 12.5, 40.25)).toBe(coverClumpRejects(l, 3, 12.5, 40.25));
  });
});

describe("recipe cover", () => {
  it("parses a cover layer with grass defaults plus its id", () => {
    const recipe = worldRecipeSchema.parse({
      ...defaultWorldRecipe(),
      cover: [{ id: "meadow", texture: "cover/tufts.png", atlas: { columns: 4, rows: 8 }, tiles: [0, 1], biomes: ["meadow"] }],
    });
    const meadow = recipe.cover[0]!;
    expect(meadow.id).toBe("meadow");
    expect(meadow.orient).toBe("upright");
    expect(meadow.scaleRange).toEqual([0.7, 1.3]);
    expect(meadow.density).toBe(5); // the grass component's own default
    expect(meadow.atlas).toEqual({ columns: 4, rows: 8 });
  });

  it("defaults to no cover, so existing worlds are unchanged", () => {
    expect(worldRecipeSchema.parse(defaultWorldRecipe()).cover).toEqual([]);
  });
});
