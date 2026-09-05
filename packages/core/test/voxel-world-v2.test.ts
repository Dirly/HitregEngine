import { describe, expect, it } from "vitest";
import {
  createWorldField,
  defaultWorldRecipe,
  fbm2,
  scatterCell,
  buildVoxelMesh,
  voxelChunkDoc,
  worldRecipeSchema,
  type WorldRecipe,
} from "../src/index.js";

/**
 * The second generation of the world generator: zones, a shore profile with a
 * land floor and a world limit, a height ceiling, lakes at their own level,
 * erosion, size-aware scatter spacing, and water emitted per cell. Each test
 * here pins a property that failed silently while this was being built.
 */

function recipe(overrides: Record<string, unknown> = {}): WorldRecipe {
  return worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24, ...overrides });
}

function noFeatures(): WorldRecipe["features"] {
  return { rivers: [], canyons: [], roads: [], towns: [], lakes: [], bridges: [], fills: [], riverPaths: [], tunnels: [], blobs: [], pois: [] };
}

const ZONES = {
  size: 1200,
  jitter: 0.8,
  warp: 120,
  warpFrequency: 0.001,
  border: 150,
  latitude: { strength: 0, scale: 6000, axis: "z", flip: false },
  anchors: [
    { id: "meadow", temperature: 0.55, moisture: 0.5, weight: 1, relief: 0.1, hills: 1 },
    { id: "desert", temperature: 0.9, moisture: 0.1, weight: 1, relief: 0.1, hills: 0.5, dunes: 1 },
    { id: "peaks", temperature: 0.4, moisture: 0.5, weight: 1, relief: 1, hills: 1 },
    { id: "marsh", temperature: 0.6, moisture: 0.95, weight: 1, relief: 0, hills: 0.2, flatten: 1 },
  ],
};

describe("zones", () => {
  const field = createWorldField(recipe({ climate: { zones: ZONES } }));

  it("gives every point a full membership that sums to one", () => {
    for (let i = 0; i < 200; i++) {
      const x = (i * 731.3) % 9000 - 4500;
      const z = (i * 419.7) % 9000 - 4500;
      const zone = field.zone(x, z);
      let sum = 0;
      for (const w of zone.weights) sum += w;
      expect(sum).toBeCloseTo(1, 5);
      expect(ZONES.anchors.some((a) => a.id === zone.id)).toBe(true);
    }
  });

  it("makes regions, not patches: a zone's neighbourhood is overwhelmingly one anchor", () => {
    // sample a grid at a spacing well under the zone size and count how often
    // a point's zone differs from its neighbour's — with 1200 m zones and a
    // 150 m border, only a sliver of the world is anything but one anchor
    let same = 0;
    let total = 0;
    for (let z = -4000; z <= 4000; z += 100) {
      let prev = field.zone(-4000, z).id;
      for (let x = -3900; x <= 4000; x += 100) {
        const id = field.zone(x, z).id;
        if (id === prev) same++;
        total++;
        prev = id;
      }
    }
    expect(same / total).toBeGreaterThan(0.85);
  });

  it("uses every anchor somewhere", () => {
    const seen = new Set<string>();
    for (let z = -6000; z <= 6000; z += 300) for (let x = -6000; x <= 6000; x += 300) seen.add(field.zone(x, z).id);
    for (const a of ZONES.anchors) expect(seen.has(a.id)).toBe(true);
  });

  it("hands the anchor's climate to the biome rules", () => {
    let desertPoints = 0;
    let checked = 0;
    for (let z = -6000; z <= 6000; z += 250) {
      for (let x = -6000; x <= 6000; x += 250) {
        const zone = field.zone(x, z);
        if (zone.id !== "desert" || zone.weights[1]! < 0.98) continue;
        const c = field.climate(x, z);
        checked++;
        if (c.temperature > 0.7 && c.moisture < 0.3) desertPoints++;
      }
    }
    expect(checked).toBeGreaterThan(20);
    // altitude (lapse rate) and edge jitter move a few, never most
    expect(desertPoints / checked).toBeGreaterThan(0.85);
  });

  it("sorts anchors by latitude when asked", () => {
    const sorted = createWorldField(
      recipe({
        climate: {
          zones: {
            ...ZONES,
            latitude: { strength: 1, scale: 8000, axis: "z", flip: false },
            anchors: [
              { id: "cold", temperature: 0.1, moisture: 0.5, latitude: 0 },
              { id: "hot", temperature: 0.9, moisture: 0.5, latitude: 1 },
            ],
          },
        },
      }),
    );
    let coldNorth = 0;
    let n = 0;
    for (let x = -4000; x <= 4000; x += 400) {
      n++;
      if (sorted.zone(x, -3500).id === "cold") coldNorth++;
    }
    let hotSouth = 0;
    for (let x = -4000; x <= 4000; x += 400) if (sorted.zone(x, 3500).id === "hot") hotSouth++;
    expect(coldNorth / n).toBeGreaterThan(0.8);
    expect(hotSouth / n).toBeGreaterThan(0.8);
  });

  it("gates a biome rule to its zones", () => {
    const base = recipe({ climate: { zones: ZONES } });
    const gated = createWorldField(
      worldRecipeSchema.parse({
        ...base,
        biomes: [
          ...base.biomes,
          { id: "bog", zones: ["marsh"], weight: 50, surface: [0, 0, 0, 0, 1, 0, 0, 0] },
        ],
      }),
    );
    let bogInMarsh = 0;
    let marsh = 0;
    let bogElsewhere = 0;
    let elsewhere = 0;
    for (let z = -6000; z <= 6000; z += 250) {
      for (let x = -6000; x <= 6000; x += 250) {
        const zone = gated.zone(x, z);
        const id = gated.biome(x, z).id;
        if (zone.id === "marsh" && zone.weights[3]! > 0.98) {
          marsh++;
          if (id === "bog") bogInMarsh++;
        } else if (zone.weights[3]! < 0.02) {
          elsewhere++;
          if (id === "bog") bogElsewhere++;
        }
      }
    }
    expect(marsh).toBeGreaterThan(10);
    expect(bogInMarsh / marsh).toBeGreaterThan(0.9);
    expect(bogElsewhere).toBe(0);
    void elsewhere;
  });

  it("shapes the ground per zone: a mountain zone is taller, a flattened zone is low and level", () => {
    const stats = new Map<string, { n: number; sum: number; max: number }>();
    for (let z = -6000; z <= 6000; z += 120) {
      for (let x = -6000; x <= 6000; x += 120) {
        const zone = field.zone(x, z);
        const best = zone.weights[ZONES.anchors.findIndex((a) => a.id === zone.id)]!;
        if (best < 0.98) continue;
        const h = field.naturalHeight(x, z);
        const s = stats.get(zone.id) ?? { n: 0, sum: 0, max: -Infinity };
        s.n++;
        s.sum += h;
        s.max = Math.max(s.max, h);
        stats.set(zone.id, s);
      }
    }
    const peaks = stats.get("peaks")!;
    const meadow = stats.get("meadow")!;
    const marsh = stats.get("marsh")!;
    expect(peaks.max).toBeGreaterThan(meadow.max + 100);
    expect(marsh.max).toBeLessThan(meadow.max);
    expect(marsh.sum / marsh.n).toBeLessThan(meadow.sum / meadow.n);
  });
});

describe("bounds: shore profile, land floor, world limit", () => {
  const bounded = recipe({
    terrain: { ...defaultWorldRecipe().terrain, base: 40 },
    bounds: {
      continents: [{ center: [0, 0], radius: 1500, falloff: 600, warp: 0.4, warpScale: 900, coastVariation: 0.5 }],
      oceanFloor: -40,
      landFloor: 4,
      shelf: 0.58,
      limit: 3200,
      limitFalloff: 500,
    },
  });
  const field = createWorldField(bounded);

  it("holds the whole interior above the sea, so no inland hollow becomes ocean", () => {
    let inland = 0;
    for (let z = -1400; z <= 1400; z += 60) {
      for (let x = -1400; x <= 1400; x += 60) {
        if (field.shoreDistance(x, z) < 400) continue;
        inland++;
        expect(field.height(x, z)).toBeGreaterThanOrEqual(bounded.seaLevel + 4 - 2.5);
      }
    }
    expect(inland).toBeGreaterThan(100);
  });

  it("puts the waterline exactly where the shore distance crosses zero", () => {
    let checked = 0;
    for (let a = 0; a < Math.PI * 2; a += 0.17) {
      // walk outward from the centre until the signed shore distance flips
      let prev = field.shoreDistance(0, 0);
      for (let r = 20; r < 2600; r += 4) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const s = field.shoreDistance(x, z);
        if (prev > 0 && s <= 0) {
          checked++;
          expect(Math.abs(field.naturalHeight(x, z) - bounded.seaLevel)).toBeLessThan(2.5);
          break;
        }
        prev = s;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("is open ocean at the floor beyond the world limit", () => {
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const x = Math.cos(a) * 3400;
      const z = Math.sin(a) * 3400;
      expect(field.height(x, z)).toBeLessThan(bounded.seaLevel - 20);
      expect(field.shoreDistance(x, z)).toBeLessThan(0);
    }
    expect(field.worldLimit).toBe(3200);
  });

  it("keeps the coast's slope continuous across the waterline (the beach continues under water)", () => {
    let checked = 0;
    for (let a = 0.1; a < Math.PI * 2; a += 0.41) {
      let prev = field.shoreDistance(0, 0);
      for (let r = 20; r < 2600; r += 4) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const s = field.shoreDistance(x, z);
        if (prev > 0 && s <= 0) {
          const dx = Math.cos(a) * 3;
          const dz = Math.sin(a) * 3;
          const inland = field.naturalHeight(x - dx, z - dz) - field.naturalHeight(x, z);
          const seaward = field.naturalHeight(x, z) - field.naturalHeight(x + dx, z + dz);
          // both sides descend seaward, and by a similar amount
          expect(inland).toBeGreaterThan(-0.5);
          expect(seaward).toBeGreaterThan(-0.5);
          expect(Math.abs(inland - seaward)).toBeLessThan(2.5);
          checked++;
          break;
        }
        prev = s;
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  it("unions lobes into one landmass with one continuous shoreline", () => {
    const lobed = createWorldField(
      recipe({
        terrain: { ...defaultWorldRecipe().terrain, base: 40 },
        bounds: {
          continents: [{ center: [0, 0], radius: 900, falloff: 500, warp: 0, warpScale: 900, lobes: [[1800, 0, 900]], lobeBlend: 400 }],
          oceanFloor: -40,
          landFloor: 4,
          shelf: 0.58,
        },
      }),
    );
    // the lobe centre is as inland as the main centre; the saddle between them is land
    expect(lobed.shoreDistance(1800, 0)).toBeCloseTo(lobed.shoreDistance(0, 0), 3);
    expect(lobed.shoreDistance(900, 0)).toBeGreaterThan(0);
    expect(lobed.height(900, 0)).toBeGreaterThan(lobed.recipe.seaLevel + 3);
    // and far off the lobe's side it is still sea
    expect(lobed.height(1800, 1600)).toBeLessThan(lobed.recipe.seaLevel);
    // the shore distance is continuous across the saddle: no crease jumps
    let prev = lobed.shoreDistance(0, 700);
    for (let x = 20; x <= 1800; x += 20) {
      const s = lobed.shoreDistance(x, 700);
      expect(Math.abs(s - prev)).toBeLessThan(25);
      prev = s;
    }
  });

  it("keeps the legacy blend for a recipe without a land floor", () => {
    const legacy = createWorldField(
      recipe({
        bounds: { continents: [{ center: [0, 0], radius: 1500, falloff: 600 }], oceanFloor: -40 },
      }),
    );
    // well inland: untouched noise; far out: ocean floor exactly
    expect(legacy.height(100, 100)).toBeCloseTo(createWorldField(recipe()).height(100, 100), 4);
    expect(legacy.height(5000, 5000)).toBeCloseTo(-40, 4);
  });
});

describe("height ceiling", () => {
  it("compresses every peak under the ceiling without flattening anything below the band", () => {
    const tall = recipe({
      terrain: { ...defaultWorldRecipe().terrain, mountains: { ...defaultWorldRecipe().terrain.mountains, amplitude: 1500 }, ceiling: { height: 400, softness: 120 } },
    });
    const capped = createWorldField(tall);
    const free = createWorldField(recipe({ terrain: { ...tall.terrain, ceiling: undefined } }));
    let max = -Infinity;
    let touched = 0;
    for (let z = -5000; z <= 5000; z += 90) {
      for (let x = -5000; x <= 5000; x += 90) {
        const h = capped.naturalHeight(x, z);
        const raw = free.naturalHeight(x, z);
        max = Math.max(max, h);
        expect(h).toBeLessThan(400);
        if (raw < 280) expect(h).toBeCloseTo(raw, 6);
        else {
          expect(h).toBeLessThanOrEqual(raw + 1e-6);
          touched++;
        }
      }
    }
    expect(max).toBeGreaterThan(330); // the ceiling is approached, not avoided
    expect(touched).toBeGreaterThan(20);
  });
});

describe("lakes", () => {
  const lakeRecipe = recipe({
    terrain: { ...defaultWorldRecipe().terrain, base: 60 },
    features: {
      ...noFeatures(),
      lakes: [{ id: "tarn", center: [300, 300], radius: 80, waterY: 55, depth: 8, bank: 20, tags: [] }],
      rivers: [
        { id: "beck", points: [[-400, 0], [400, 0]], width: 8, depth: 3, bank: 10, bedY: [70, 50], water: true, surface: "", surfaceEdge: 3, taper: 0 },
      ],
    },
  });
  const field = createWorldField(lakeRecipe);
  const bare = createWorldField(recipe({ terrain: { ...defaultWorldRecipe().terrain, base: 60 } }));

  it("carves the basin below its surface and leaves the land past the bank alone", () => {
    expect(field.height(300, 300)).toBeLessThanOrEqual(55 - 8 + 1e-6);
    expect(field.height(360, 300)).toBeLessThanOrEqual(55 - 0.6 + 1e-6); // shore edge, under water
    expect(field.height(300, 450)).toBeCloseTo(bare.height(300, 450), 5); // 150 m out: untouched
  });

  it("reports the lake and river surface heights, and the sea, through waterY", () => {
    expect(field.waterY(300, 300)).toBe(55);
    expect(field.waterY(300, 450)).toBeNull();
    expect(field.waterY(0, 0)).toBeCloseTo(60 + 3 * 0.7, 5); // river bed 60 at x=0, plus 70% of depth
    expect(field.waterY(0, 40)).toBeNull(); // beside the channel
  });

  it("accepts a polygon outline", () => {
    const poly = createWorldField(
      recipe({
        terrain: { ...defaultWorldRecipe().terrain, base: 60 },
        features: {
          ...noFeatures(),
          lakes: [
            { id: "mere", center: [0, 0], polygon: [[-100, -60], [120, -80], [90, 70], [-80, 90]], radius: 1, waterY: 50, depth: 5, bank: 15, tags: [] },
          ],
        },
      }),
    );
    expect(poly.waterY(0, 0)).toBe(50);
    expect(poly.height(0, 0)).toBeLessThan(50);
    expect(poly.waterY(200, 200)).toBeNull();
    expect(poly.featureClearance(0, 0)).toBeLessThan(0);
    expect(poly.featureClearance(0, 200)).toBeGreaterThan(100);
  });
});

describe("erosion", () => {
  const plain = { frequency: 0.002, amplitude: 100, octaves: 5, lacunarity: 2, gain: 0.5, ridged: true, seed: 7 };
  const eroded = { ...plain, erosion: 0.6 };

  it("is deterministic, bounded, and different from plain fBm", () => {
    let differs = 0;
    for (let i = 0; i < 400; i++) {
      const x = i * 13.7;
      const z = i * -7.3;
      const a = fbm2(eroded, x, z, 1);
      expect(a).toBe(fbm2(eroded, x, z, 1));
      expect(a).toBeGreaterThanOrEqual(-1e-6);
      expect(a).toBeLessThanOrEqual(100 + 1e-6);
      if (Math.abs(a - fbm2(plain, x, z, 1)) > 1e-3) differs++;
    }
    expect(differs).toBeGreaterThan(300);
  });

  it("calms the fine detail on steep ground more than on flat ground", () => {
    // split samples by how steep the COARSE octaves are there; erosion should damp
    // the 6 m detail far more on the steep half — that is what makes flanks
    // walkable while the ridgelines keep their edge
    const base = { ...plain, octaves: 3 };
    const rows: { steep: number; fineP: number; fineE: number }[] = [];
    for (let i = 0; i < 3000; i++) {
      const x = (i % 60) * 29.3;
      const z = Math.floor(i / 60) * 31.7;
      const g = Math.hypot(fbm2(base, x + 2, z, 1) - fbm2(base, x - 2, z, 1), fbm2(base, x, z + 2, 1) - fbm2(base, x, z - 2, 1)) / 4;
      const fineP = Math.abs(fbm2(plain, x + 6, z, 1) - fbm2(plain, x, z, 1));
      const fineE = Math.abs(fbm2(eroded, x + 6, z, 1) - fbm2(eroded, x, z, 1));
      if (fineP < 0.05) continue;
      rows.push({ steep: g, fineP, fineE });
    }
    rows.sort((p, q) => p.steep - q.steep);
    const half = Math.floor(rows.length / 2);
    const ratio = (list: typeof rows): number =>
      list.reduce((s, r) => s + r.fineE, 0) / list.reduce((s, r) => s + r.fineP, 0);
    const flat = ratio(rows.slice(0, half));
    const steep = ratio(rows.slice(half));
    expect(steep).toBeLessThan(flat * 0.85);
    expect(steep).toBeLessThan(0.75);
  });
});

describe("size-aware scatter spacing", () => {
  const spaced = recipe({
    terrain: { ...defaultWorldRecipe().terrain, base: 40 },
    scatter: [
      { id: "oak", prefab: "trees/oak", density: 0.02, slopeMax: 0.9, scale: [1, 1], jitter: 1, footprint: 2.5, spacing: 0.5, collider: "none" },
      { id: "fern", prefab: "plants/fern", density: 0.08, slopeMax: 0.9, scale: [1, 1], jitter: 1, footprint: 0.4, spacing: 0.3, collider: "none" },
    ],
  });
  const field = createWorldField(spaced);
  const size = spaced.cellSize;

  function worldInstances(cx: number, cz: number): { x: number; z: number; r: number; gap: number; rule: string }[] {
    return scatterCell(field, cx, cz, { fastGround: true }).map((i) => {
      const rule = spaced.scatter[i.ruleIndex]!;
      return { x: i.position[0] + cx * size, z: i.position[2] + cz * size, r: rule.footprint * i.scale, gap: rule.spacing, rule: rule.id };
    });
  }

  it("keeps every pair apart by the sum of their footprints plus spacing, across cell seams too", () => {
    const all: ReturnType<typeof worldInstances> = [];
    for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) all.push(...worldInstances(cx, cz));
    expect(all.filter((i) => i.rule === "oak").length).toBeGreaterThan(20);
    expect(all.filter((i) => i.rule === "fern").length).toBeGreaterThan(50);
    let overlaps = 0;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d < a.r + b.r + Math.max(a.gap, b.gap) - 1e-6) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });

  it("lets the big rule claim ground first whatever the array order", () => {
    const reversed = createWorldField(worldRecipeSchema.parse({ ...spaced, scatter: [spaced.scatter[1], spaced.scatter[0]] }));
    const a = scatterCell(field, 1, 1, { fastGround: true }).filter((i) => i.rule === "oak").length;
    const b = scatterCell(reversed, 1, 1, { fastGround: true }).filter((i) => i.rule === "oak").length;
    expect(b).toBe(a);
  });
});

describe("skirts at the LOD boundary", () => {
  const world = createWorldField(recipe({ terrain: { ...defaultWorldRecipe().terrain, base: 40 } }));
  const size = world.recipe.cellSize;

  it("hangs a strip from every boundary edge, on both a fine cell and its coarse neighbour", () => {
    for (const lodStep of [1, 4]) {
      const mesh = buildVoxelMesh(world, { kind: "voxel", world: "w", cell: [3, -4], lodStep });
      const step = world.voxelSize * lodStep;
      // skirt vertices: on a side plane, sitting exactly 3 steps under a surface vertex on the same plane
      const onPlane = (i: number): boolean =>
        [0, size].some((p) => Math.abs(mesh.positions[i * 3]! - p) < 1e-4 || Math.abs(mesh.positions[i * 3 + 2]! - p) < 1e-4);
      const surfaceYs = new Map<string, number[]>();
      for (let i = 0; i < mesh.vertexCount; i++) {
        if (!onPlane(i)) continue;
        const key = `${mesh.positions[i * 3]!.toFixed(3)},${mesh.positions[i * 3 + 2]!.toFixed(3)}`;
        (surfaceYs.get(key) ?? surfaceYs.set(key, []).get(key)!).push(mesh.positions[i * 3 + 1]!);
      }
      let skirted = 0;
      for (const ys of surfaceYs.values()) {
        ys.sort((a, b) => a - b);
        for (let k = 1; k < ys.length; k++) if (Math.abs(ys[k]! - ys[k - 1]! - 3 * step) < 1e-3) skirted++;
      }
      expect(skirted).toBeGreaterThan(10);
      // splat weights on every vertex, skirt included, still sum to 1
      for (let i = 0; i < mesh.vertexCount; i++) {
        let sum = 0;
        for (let s = 0; s < mesh.surfaceCount; s++) sum += mesh.splat[i * mesh.surfaceCount + s]!;
        expect(sum).toBeCloseTo(1, 4);
      }
    }
  });

  it("covers the crack between a fine cell and a 4x-coarser neighbour", () => {
    // sample the shared plane x = 4*size: the fine cell's surface height there
    // versus the coarse neighbour's; the higher side's skirt must reach below
    // the lower surface at every sample
    const fine = buildVoxelMesh(world, { kind: "voxel", world: "w", cell: [3, -4], lodStep: 1 });
    const coarse = buildVoxelMesh(world, { kind: "voxel", world: "w", cell: [4, -4], lodStep: 4 });
    const profile = (mesh: ReturnType<typeof buildVoxelMesh>, plane: number, offset: number): Map<number, { top: number; bottom: number }> => {
      const out = new Map<number, { top: number; bottom: number }>();
      for (let i = 0; i < mesh.vertexCount; i++) {
        if (Math.abs(mesh.positions[i * 3]! - plane) > 1e-4) continue;
        const z = Math.round((mesh.positions[i * 3 + 2]! + offset) * 2) / 2;
        const y = mesh.positions[i * 3 + 1]!;
        const e = out.get(z) ?? { top: -Infinity, bottom: Infinity };
        e.top = Math.max(e.top, y);
        e.bottom = Math.min(e.bottom, y);
        out.set(z, e);
      }
      return out;
    };
    const f = profile(fine, size, 0);
    const c = profile(coarse, 0, 0);
    let compared = 0;
    for (const [z, fe] of f) {
      const ce = c.get(z);
      if (!ce) continue;
      compared++;
      const higher = fe.top > ce.top ? fe : ce;
      const lower = fe.top > ce.top ? ce : fe;
      expect(higher.bottom).toBeLessThanOrEqual(lower.top + 1e-3);
    }
    expect(compared).toBeGreaterThan(3);
  });
});

describe("water in chunk documents", () => {
  const watery = recipe({
    terrain: { ...defaultWorldRecipe().terrain, base: 60 },
    waterMaterial: "terrain/test-water",
    features: {
      ...noFeatures(),
      rivers: [{ id: "beck", points: [[-400, 20], [400, 20]], width: 8, depth: 3, bank: 10, bedY: [70, 50], water: true, surface: "", surfaceEdge: 3, taper: 0 }],
      lakes: [{ id: "tarn", center: [40, 120], radius: 60, waterY: 55, depth: 8, bank: 20, tags: [] }],
    },
  });
  const field = createWorldField(watery);

  it("emits a river ribbon in the cells the channel crosses and nowhere else", () => {
    const crossed = voxelChunkDoc(field, "w", 0, 0, { scatter: false });
    const ribbon = Object.values(crossed.entities).find((e) => e.tags?.includes("river"));
    expect(ribbon).toBeDefined();
    const mesh = ribbon!.components["mesh"] as { source: { kind: string; points: number[][] }; material: string };
    expect(mesh.source.kind).toBe("path");
    expect(mesh.material).toBe("terrain/test-water");
    expect(mesh.source.points.length).toBeGreaterThanOrEqual(2);
    // the surface rides above the bed: bed 60 at x = 0, plus 70% of depth
    const ys = mesh.source.points.map((p) => p[1]!);
    expect(Math.min(...ys)).toBeGreaterThan(50);
    expect(Math.max(...ys)).toBeLessThan(73);
    const dry = voxelChunkDoc(field, "w", 0, 5, { scatter: false });
    expect(Object.values(dry.entities).some((e) => e.tags?.includes("river"))).toBe(false);
  });

  it("emits one flat lake sheet per overlapped cell, clipped to the cell", () => {
    const cells = [
      [0, 2],
      [1, 2],
      [0, 1],
      [1, 1],
    ] as const;
    let sheets = 0;
    for (const [cx, cz] of cells) {
      const doc = voxelChunkDoc(field, "w", cx, cz, { scatter: false });
      const sheet = Object.values(doc.entities).find((e) => e.tags?.includes("lake"));
      if (!sheet) continue;
      sheets++;
      const mesh = sheet.components["mesh"] as { source: { kind: string; vertices: number[][]; faces: { v: number[] }[] } };
      expect(mesh.source.kind).toBe("poly");
      for (const v of mesh.source.vertices) {
        expect(v[1]).toBe(55);
        expect(v[0]).toBeGreaterThanOrEqual(-1e-6);
        expect(v[0]).toBeLessThanOrEqual(watery.cellSize + 1e-6);
        expect(v[2]).toBeGreaterThanOrEqual(-1e-6);
        expect(v[2]).toBeLessThanOrEqual(watery.cellSize + 1e-6);
      }
      expect(mesh.source.faces[0]!.v.length).toBe(mesh.source.vertices.length);
    }
    expect(sheets).toBeGreaterThanOrEqual(3);
    // a cell the lake does not reach gets none
    const far = voxelChunkDoc(field, "w", 5, 5, { scatter: false });
    expect(Object.values(far.entities).some((e) => e.tags?.includes("lake"))).toBe(false);
  });

  it("emits nothing wet without a water material", () => {
    const dryField = createWorldField(worldRecipeSchema.parse({ ...watery, waterMaterial: undefined }));
    const doc = voxelChunkDoc(dryField, "w", 0, 0, { scatter: false });
    expect(Object.values(doc.entities).some((e) => e.tags?.includes("water"))).toBe(false);
  });
});
