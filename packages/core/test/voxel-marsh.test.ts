import { describe, expect, it } from "vitest";
import {
  continentalWorldRecipe,
  createWorldField,
  defaultWorldRecipe,
  worldRecipeSchema,
  type SurfaceSample,
  type WorldRecipe,
} from "../src/index.js";

/**
 * Marsh water tables (zone anchor `waterTable`) and the wandering summit line
 * (`terrain.ceiling.variation`). Both are opt-in: a recipe that sets neither
 * must give exactly the ground, water and surfaces it gave before they existed.
 */

/** FNV over height, waterY and waterSurface on a coarse lattice: any change to the ground or the water changes it. */
function fieldHash(recipe: unknown): string {
  const f = createWorldField(worldRecipeSchema.parse(recipe));
  let h = 2166136261 >>> 0;
  const buf = new Float64Array(1);
  const u = new Uint32Array(buf.buffer);
  const s: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
  for (let z = -6000; z <= 6000; z += 97) {
    for (let x = -6000; x <= 6000; x += 97) {
      buf[0] = f.height(x, z);
      h = Math.imul(h ^ u[0]!, 16777619) >>> 0;
      h = Math.imul(h ^ u[1]!, 16777619) >>> 0;
      buf[0] = f.waterY(x, z) ?? -1e9;
      h = Math.imul(h ^ u[0]!, 16777619) >>> 0;
      h = Math.imul(h ^ (f.waterSurface(x, z, s) ? 1 : 0), 16777619) >>> 0;
    }
  }
  return h.toString(16);
}

function marshRecipe(): WorldRecipe {
  const raw = continentalWorldRecipe();
  // the preset deals no swamp on its land: turn its lowland anchors into marsh
  const marshy = new Set(["swamp", "fen", "grassland", "forest", "savanna"]);
  const anchors = raw.climate.zones!.anchors.map((a) => (marshy.has(a.id) ? { ...a, relief: 0, hills: 0.25, flatten: 1, waterTable: 2, hummocks: 1 } : a));
  return worldRecipeSchema.parse({ ...raw, climate: { ...raw.climate, zones: { ...raw.climate.zones!, anchors } }, marshMaterial: "terrain/test-marsh" });
}

describe("opt-in terrain fields leave existing worlds byte-identical", () => {
  // Golden hashes taken from the field BEFORE waterTable / hummocks /
  // ceiling.variation existed (same lattice, same recipes). A failure here
  // means a recipe that never asked for a marsh or a wandering ceiling got
  // different ground or water — fix the opt-in gate, do not re-golden.
  it("the continental preset (swamp and fen anchors, no waterTable)", () => {
    expect(fieldHash(continentalWorldRecipe())).toBe("fb9901f2");
  });
  it("the default preset", () => {
    expect(fieldHash(defaultWorldRecipe())).toBe("7aa84d64");
  });
  it("no marsh anywhere without a waterTable", () => {
    const f = createWorldField(worldRecipeSchema.parse(continentalWorldRecipe()));
    const s: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
    for (let z = -5000; z <= 5000; z += 250) {
      for (let x = -5000; x <= 5000; x += 250) {
        expect(f.marshTable(x, z)).toBeNull();
        if (f.waterSurface(x, z, s)) expect(s.kind).not.toBe("marsh");
      }
    }
  });
});

describe("marsh water table", () => {
  const recipe = marshRecipe();
  const field = createWorldField(recipe);
  const floorY = recipe.seaLevel + (recipe.bounds?.landFloor ?? 0);
  const s: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };
  // every marsh point on a 40 m lattice
  const marsh: { x: number; z: number; table: number; ground: number }[] = [];
  for (let z = -6000; z <= 6000; z += 40) {
    for (let x = -6000; x <= 6000; x += 40) {
      const table = field.marshTable(x, z);
      if (table !== null) marsh.push({ x, z, table, ground: field.height(x, z) });
    }
  }

  it("the preset has marsh ground, at the anchors' table", () => {
    expect(marsh.length).toBeGreaterThan(200);
    for (const m of marsh) expect(m.table).toBeCloseTo(floorY + 2, 6);
  });

  it("islands and pools mix, and the pools are wading water", () => {
    const wet = marsh.filter((m) => m.ground < m.table);
    const share = wet.length / marsh.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.75);
    // pools soft-capped at maxDepth (1.1 m default); the preset has no features to dig deeper
    for (const m of wet) expect(m.table - m.ground).toBeLessThan(1.2);
    // and the dry part is low: hummocks, not hills
    const dry = marsh.filter((m) => m.ground >= m.table).map((m) => m.ground - m.table).sort((a, b) => a - b);
    expect(dry[Math.floor(dry.length / 2)]!).toBeLessThan(2);
  });

  it("waterSurface reports a still marsh sheet at the table, waterY only where the ground is under it", () => {
    for (const m of marsh.slice(0, 400)) {
      expect(field.waterSurface(m.x, m.z, s)).toBe(true);
      expect(s.kind).toBe("marsh");
      expect(s.y).toBe(m.table);
      expect(s.flowX).toBe(0);
      expect(s.material).toBe("terrain/test-marsh");
      const w = field.waterY(m.x, m.z);
      if (m.ground < m.table) expect(w).toBe(m.table);
      else expect(w === null || w < m.table).toBe(true);
    }
    expect(field.waterNear(marsh[0]!.x, marsh[0]!.z, marsh[0]!.x, marsh[0]!.z)).toBe(true);
  });

  it("the sheet never ends in the air: ground at the marsh's edge stands over the table", () => {
    // walk 2 m steps from each marsh point toward the nearest non-marsh
    // neighbour; the last marsh sample before the edge must be dry ground
    let edges = 0;
    for (const m of marsh) {
      for (const [dx, dz] of [[40, 0], [-40, 0], [0, 40], [0, -40]] as const) {
        if (field.marshTable(m.x + dx, m.z + dz) !== null) continue;
        let lastX = m.x;
        let lastZ = m.z;
        for (let t = 2; t <= 40; t += 2) {
          const x = m.x + (dx * t) / 40;
          const z = m.z + (dz * t) / 40;
          if (field.marshTable(x, z) === null) break;
          lastX = x;
          lastZ = z;
        }
        const table = field.marshTable(lastX, lastZ)!;
        expect(field.height(lastX, lastZ)).toBeGreaterThan(table);
        edges++;
      }
    }
    expect(edges).toBeGreaterThan(10);
  });

  it("is a pure function of position: a second field agrees exactly (chunk seams, server/client)", () => {
    const again = createWorldField(marshRecipe());
    for (const m of marsh.slice(0, 300)) {
      expect(again.height(m.x, m.z)).toBe(m.ground);
      expect(again.marshTable(m.x, m.z)).toBe(m.table);
    }
  });
});

describe("ceiling variation", () => {
  function heights(variation: number | undefined): number[] {
    const raw = continentalWorldRecipe();
    const ceiling = { ...raw.terrain.ceiling!, ...(variation === undefined ? {} : { variation }) };
    const f = createWorldField(worldRecipeSchema.parse({ ...raw, terrain: { ...raw.terrain, ceiling } }));
    const out: number[] = [];
    for (let z = -6000; z <= 6000; z += 60) for (let x = -6000; x <= 6000; x += 60) out.push(f.height(x, z));
    return out;
  }
  it("0 is the flat ceiling; a wander lets some summits stand over it and keeps every one under height + variation", () => {
    const top = continentalWorldRecipe().terrain.ceiling!.height;
    const flat = heights(undefined);
    expect(heights(0)).toEqual(flat);
    expect(Math.max(...flat)).toBeLessThan(top);
    const wandering = heights(120);
    expect(Math.max(...wandering)).toBeGreaterThan(top);
    expect(Math.max(...wandering)).toBeLessThan(top + 120);
    // only the summit band moves: almost all of the land is untouched
    const same = flat.filter((h, i) => wandering[i] === h).length;
    expect(same / flat.length).toBeGreaterThan(0.8);
  });
});
