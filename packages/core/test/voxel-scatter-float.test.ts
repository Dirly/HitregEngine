import { describe, expect, it } from "vitest";
import {
  createWorldField,
  defaultWorldRecipe,
  editedGround,
  scatterCell,
  scatterFooting,
  worldRecipeSchema,
  type WorldField,
} from "../src/index.js";

/**
 * Plants over terrain EDITS (docs/voxel-worlds.md, "Scatter"): a passage,
 * tunnel or subtracting blob only exists in the density, so a placement that
 * reads the heightfield leaves the plant standing where the ground USED to be.
 */

const GROUND = 20;

/** A flat plain at y = GROUND over [-240, 240]², optional passages cut into it. */
function flatWorld(passages: unknown[] = [], overhang = 4): WorldField {
  const base = defaultWorldRecipe();
  const recipe = worldRecipeSchema.parse({
    ...base,
    cellSize: 32,
    resolution: 16,
    terrain: {
      ...base.terrain,
      overhang: { ...base.terrain.overhang, strength: overhang },
      caves: { ...base.terrain.caves, enabled: false },
    },
    features: {
      ...base.features,
      heightPatches: [{ id: "plain", origin: [-240, -240], size: [480, 480], columns: 2, rows: 2, heights: [GROUND, GROUND, GROUND, GROUND], blend: 20 }],
      passages,
    },
    scatter: [
      {
        id: "tree",
        prefab: "trees/pine",
        biomes: [],
        biomeDensity: {},
        density: 0.04,
        slopeMax: 0.95,
        slopeMin: 0,
        yawOffset: 0,
        scale: [1, 1.4],
        alignToNormal: 0,
        yOffset: 0,
        jitter: 0.8,
        clearance: 0,
        footprint: 0.6,
        spacing: 0.3,
        collider: "cylinder",
        colliderSize: [0.8, 6, 0.8],
        static: true,
        castShadow: true,
        lod: true,
      },
    ],
  });
  return createWorldField(recipe);
}

/** Open trench along z: floor at y 8, 12 m below the plain, roof far above it (open sky). */
const TRENCH = { id: "trench", start: [0, 8, -40], axis: "z", direction: 1, length: 80, width: 10, height: 30, falloff: 4 };
/** A chamber whose roof is 1.2 m under the plain: a lintel no plant may stand on. */
const LINTEL = { id: "lintel", start: [60, 14, -10], axis: "z", direction: 1, length: 20, width: 12, height: 4.8, falloff: 2 };

function instancesNear(field: WorldField, x0: number, z0: number, x1: number, z1: number) {
  const size = field.recipe.cellSize;
  const out: { x: number; y: number; z: number; scale: number; id: string }[] = [];
  for (let cz = Math.floor(z0 / size); cz <= Math.floor(z1 / size); cz++) {
    for (let cx = Math.floor(x0 / size); cx <= Math.floor(x1 / size); cx++) {
      for (const i of scatterCell(field, cx, cz)) {
        out.push({ x: i.position[0] + cx * size, y: i.position[1], z: i.position[2] + cz * size, scale: i.scale, id: i.id });
      }
    }
  }
  return out;
}

/** Topmost solid surface at (x, z) by a fine density march — independent of the code under test. */
function realSurface(field: WorldField, x: number, z: number, from = 45, to = 0): number | null {
  for (let y = from; y > to; y -= 0.25) {
    if (field.density(x, y, z) >= 0) continue;
    let lo = y, hi = y + 0.25; // solid at lo, air at hi
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (field.density(x, mid, z) < 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  return null;
}

describe("scatter over terrain edits", () => {
  for (const overhang of [4, 0]) {
    it(`stands every plant on the carved surface, never over the cut (overhang ${overhang})`, () => {
      const field = flatWorld([TRENCH], overhang);
      const plants = instancesNear(field, -30, -30, 30, 30);
      expect(plants.length).toBeGreaterThan(50);
      let inTrench = 0;
      for (const p of plants) {
        const real = realSurface(field, p.x, p.z);
        expect(real, `${p.id} has nothing under it`).not.toBeNull();
        // base within a few cm of the real ground under its own point
        expect(Math.abs(p.y - real!), `${p.id} at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) y ${p.y.toFixed(2)} over ${real!.toFixed(2)}`).toBeLessThan(0.2);
        if (Math.abs(p.x) < 4 && Math.abs(p.z) < 30) {
          inTrench++;
          expect(p.y).toBeLessThan(9);
        }
        // the trunk's whole footing is supported: no ring point drops into the cut
        const r = 0.4 * p.scale;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const g = realSurface(field, p.x + Math.cos(a) * r, p.z + Math.sin(a) * r);
          expect(g).not.toBeNull();
          expect(p.y - g!, `${p.id} overhangs the lip`).toBeLessThan(1 + 1.2 * r);
        }
      }
      expect(inTrench).toBeGreaterThan(0); // the floor is real ground: plants grow there
    }, 60_000);
  }

  it("drops plants standing on a lintel over a void", () => {
    const field = flatWorld([LINTEL]);
    for (const p of instancesNear(field, 40, -30, 80, 30)) {
      const over = Math.abs(p.x - 60) < 5 && p.z > -9 && p.z < 9;
      expect(over, `${p.id} stands on a 1.2 m slab at (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).toBe(false);
    }
  });

  it("editedGround: undefined off any carve, the floor in a cut, null on a lip or a lintel", () => {
    const field = flatWorld([TRENCH, LINTEL]);
    expect(editedGround(field, -100, 0, 0.5)).toBeUndefined();
    expect(editedGround(field, 0, 0, 0.5)).toBeCloseTo(8, 0);
    // centre on the plain right at the trench rim: the ring falls 12 m
    expect(editedGround(field, 5.2, 0, 0.6)).toBeNull();
    expect(editedGround(field, 60, 0, 0.3)).toBeNull();
  });

  it("leaves placements away from every carve exactly as they were", () => {
    const plain = flatWorld([]);
    const cut = flatWorld([TRENCH, LINTEL]);
    // cells at least 40 m from either carve's footprint
    for (const [cx, cz] of [[-5, -3], [-4, 2], [4, -5], [5, 3], [-3, 4]] as const) {
      expect(JSON.stringify(scatterCell(cut, cx, cz))).toBe(JSON.stringify(scatterCell(plain, cx, cz)));
    }
  });

  it("scatterFooting is the trunk, not the canopy claim", () => {
    const rule = flatWorld().recipe.scatter[0]!;
    expect(scatterFooting(rule, 2)).toBeCloseTo(0.8);
    expect(scatterFooting({ ...rule, collider: "none" }, 2)).toBeCloseTo(0.6);
    expect(scatterFooting({ ...rule, collider: "box", colliderSize: [2, 1, 1] }, 1)).toBeCloseTo(0.5);
  });

  it("carveSpan reports only carves that reach the rectangle", () => {
    const field = flatWorld([TRENCH]);
    expect(field.carveSpan(-100, -10, -90, 0)).toBeNull();
    const span = field.carveSpan(-1, -1, 1, 1)!;
    expect(span.min).toBeLessThanOrEqual(8);
    expect(span.max).toBeGreaterThanOrEqual(38);
  });
});
