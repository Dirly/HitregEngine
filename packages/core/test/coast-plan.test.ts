import { describe, expect, it } from "vitest";
import {
  COAST_TYPES,
  createCoastPlan,
  createSeaCliffs,
  createWorldField,
  defaultWorldRecipe,
  regionCoastSchema,
  seaCliffSchema,
  worldRecipeSchema,
  type CoastSegmentDoc,
  type WorldField,
  type WorldRecipe,
} from "../src/index.js";

// A round island with no coast warp: its shoreline is a circle, so segments can be laid along arcs by angle.
const base = defaultWorldRecipe();
function island(features: Record<string, unknown> = {}, terrain: Record<string, unknown> = {}): WorldRecipe {
  return worldRecipeSchema.parse({
    ...base,
    bounds: { continents: [{ center: [0, 0], radius: 700, falloff: 250, warp: 0 }], oceanFloor: -45, landFloor: 4 },
    terrain: { ...base.terrain, base: 20, caves: { ...base.terrain.caves, enabled: false }, ...terrain },
    // a real palette tags its roles (worldgen zone-textures reads them); the mudflat paints the `ground` role
    surfaces: base.surfaces.map((sf) => (sf.name === "dirt" ? { ...sf, role: "ground" } : sf.name === "sand" ? { ...sf, role: "accent" } : sf)),
    features,
  });
}

/** Radius of the natural shoreline (shore distance 0) along +x, by bisection. */
function shoreRadius(field: WorldField): number {
  let lo = 300, hi = 1200;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (field.shoreDistance(mid, 0) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A segment doc along the arc [a0, a1] degrees of the circle of radius r, points every ~24 m. */
function arc(id: string, type: CoastSegmentDoc["type"], r: number, a0: number, a1: number, extra: Partial<CoastSegmentDoc> = {}): CoastSegmentDoc {
  const len = ((a1 - a0) * Math.PI * r) / 180;
  const n = Math.max(2, Math.round(len / 24) + 1);
  const points: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / (n - 1)) * Math.PI) / 180;
    points.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return { id, type, points, loop: 0, exposure: "sheltered", fetch: 3000, facing: 0, slopeBehind: 0.02, concave: true, mud: false, length: len, reach: 140, reason: "", ...extra };
}

describe("the coast plan", () => {
  const plain = createWorldField(island());
  const r = shoreRadius(plain);
  const planned = createWorldField(island({
    coastSegments: [
      arc("cs-0-0", "sand-beach", r, -25, 25),
      arc("cs-0-1", "rocky-shore", r, 155, 205, { exposure: "exposed" }),
      arc("cs-0-2", "mudflat", r, 65, 115, { mud: true }),
    ],
  }));

  it("never moves the coastline and leaves shore() untouched", () => {
    let band = 0;
    for (let i = 0; i < 90; i++) {
      for (let j = 0; j < 90; j++) {
        const x = -1200 + (2400 * i) / 89;
        const z = -1200 + (2400 * j) / 89;
        expect(planned.shoreDistance(x, z)).toBe(plain.shoreDistance(x, z));
        const h = plain.height(x, z) - base.seaLevel;
        if (Math.abs(h) > 12) continue;
        band++;
        expect(Math.sign(planned.height(x, z) - base.seaLevel), `coastline moved at ${x},${z}`).toBe(Math.sign(h));
      }
    }
    expect(band).toBeGreaterThan(100);
  });

  /** Mean rise across the waterline (3 m either side of the shoreline, radially) over an arc. */
  const riseOver = (field: WorldField, a0: number, a1: number): number => {
    let sum = 0, n = 0;
    for (let a = a0; a <= a1; a += 2) {
      const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
      sum += Math.abs(field.height((r + 3) * c, (r + 3) * s) - field.height((r - 3) * c, (r - 3) * s));
      n++;
    }
    return sum / n;
  };

  it("forces the shore gentle on a sand-beach segment and steep on a rocky-shore segment", () => {
    const beachPlain = riseOver(plain, -20, 20), beach = riseOver(planned, -20, 20);
    const rockPlain = riseOver(plain, 160, 200), rock = riseOver(planned, 160, 200);
    expect(beach).toBeLessThanOrEqual(beachPlain + 1e-6);
    expect(rock).toBeGreaterThanOrEqual(rockPlain - 1e-6);
    expect(rock).toBeGreaterThan(beach * 1.5);
    // outside every segment's reach the ground is the plain world's
    const c = Math.cos((270 * Math.PI) / 180), s = Math.sin((270 * Math.PI) / 180);
    expect(planned.height(r * c, r * s)).toBeCloseTo(plain.height(r * c, r * s), 9);
  });

  it("widens the beach biome's height window on a sand-beach segment and narrows it on rock", () => {
    const beachRule = base.biomes.findIndex((b) => b.id === "beach");
    expect(beachRule).toBeGreaterThanOrEqual(0);
    const y = base.seaLevel + 3.6; // outside the natural [-2, 2.5] window, inside the x1.8 one
    const onBeach = planned.biome(r, 0, y, 0.05).weights[beachRule]!;
    const onPlain = plain.biome(r, 0, y, 0.05).weights[beachRule]!;
    expect(onBeach).toBeGreaterThan(onPlain);
    const yIn = base.seaLevel + 1.8; // inside the natural window, outside the rocky x0.35 one
    const rockX = Math.cos(Math.PI) * r, rockZ = Math.sin(Math.PI) * r;
    expect(planned.biome(rockX, rockZ, yIn, 0.05).weights[beachRule]!).toBeLessThan(plain.biome(rockX, rockZ, yIn, 0.05).weights[beachRule]!);
  });

  it("paints the ground role (mud) at the waterline of a mudflat and sand elsewhere", () => {
    const ground = base.surfaces.findIndex((sf) => sf.name === "dirt");
    const sand = base.surfaces.findIndex((sf) => sf.name === "sand");
    expect(ground).toBeGreaterThanOrEqual(0);
    expect(sand).toBeGreaterThanOrEqual(0);
    const a = (90 * Math.PI) / 180;
    const out = new Float32Array(base.surfaces.length);
    planned.splatAt(Math.cos(a) * r, base.seaLevel + 0.5, Math.sin(a) * r, 1, out, 0);
    const plainOut = new Float32Array(base.surfaces.length);
    plain.splatAt(Math.cos(a) * r, base.seaLevel + 0.5, Math.sin(a) * r, 1, plainOut, 0);
    expect(out[ground]!).toBeGreaterThan(plainOut[ground]! + 0.3);
    expect(out[sand]!).toBeLessThan(plainOut[sand]!);
  });

  it("is byte-identical to no plan when the segment list is empty", () => {
    const empty = createWorldField(island({ coastSegments: [] }));
    for (let a = 0; a < 360; a += 7) {
      const x = Math.cos((a * Math.PI) / 180) * (r - 5), z = Math.sin((a * Math.PI) / 180) * (r - 5);
      expect(empty.height(x, z)).toBe(plain.height(x, z));
    }
    expect(empty.coastPlan()).toBeNull();
    expect(planned.coastPlan()?.segments.length).toBe(3);
  });

  it("blends two segments that meet, the nearer one winning", () => {
    const plan = createCoastPlan([arc("a", "sand-beach", r, -30, 0), arc("b", "rocky-shore", r, 0, 30)]);
    const out = plan.newSample();
    plan.sample(Math.cos(-0.2) * r, Math.sin(-0.2) * r, out);
    expect(out.rugged).toBeLessThan(0.1);
    plan.sample(Math.cos(0.2) * r, Math.sin(0.2) * r, out);
    expect(out.rugged).toBeGreaterThan(0.9);
    plan.sample(r, 0, out);
    expect(out.rugged).toBeGreaterThan(0.2);
    expect(out.rugged).toBeLessThan(0.8);
    expect(plan.nearest(r, 0)?.d ?? Infinity).toBeLessThan(1);
    expect(plan.nearest(-r, 0)).toBeNull();
  });
});

describe("sea-cliff stretches with endFade", () => {
  const field = createWorldField(island());
  const r = shoreRadius(field);
  const along = arc("x", "sheer-cliff", r, -20, 20).points;
  const ctx = { seaLevel: base.seaLevel, seed: 1, shore: (x: number, z: number) => field.shoreDistance(x, z), region: () => null, obstacles: [] };

  it("hold the full profile along the polyline and end just past its ends", () => {
    const ended = createSeaCliffs([seaCliffSchema.parse({ id: "e", along, reach: 300, fade: 100, endFade: 40, height: [60, 80] })], ctx);
    const open = createSeaCliffs([seaCliffSchema.parse({ id: "o", along, reach: 300, fade: 100, height: [60, 80] })], ctx);
    const at = (sc: ReturnType<typeof createSeaCliffs>, deg: number, radius = r): number => {
      const col = sc.newColumn();
      sc.column(Math.cos((deg * Math.PI) / 180) * radius, Math.sin((deg * Math.PI) / 180) * radius, col);
      return col.w;
    };
    expect(at(ended, 0)).toBeCloseTo(1, 3);
    expect(at(ended, 0, r - 150)).toBeCloseTo(1, 3); // 150 m inland, across the polyline, still held
    // 100 m of arc past the end (~7 degrees at this radius): the ended stretch is gone, the open one still holds
    expect(at(ended, 28)).toBe(0);
    expect(at(open, 28)).toBeGreaterThan(0.9);
  });
});

describe("the coast schema", () => {
  it("fills the zone defaults and round-trips a zone's rules", () => {
    const d = regionCoastSchema.parse({});
    expect(d.allowed).toEqual([...COAST_TYPES]);
    expect(d.tolerance).toBe(0.12);
    expect(d.maxRun).toBe(600);
    const recipe = worldRecipeSchema.parse({
      ...base,
      regions: [{ id: "shore", name: "The Shore", polygon: [[0, 0], [100, 0], [100, 100]], coast: { allowed: ["sheer-cliff", "sand-beach"], shares: { "sheer-cliff": 0.5 } } }],
    });
    expect(recipe.regions[0]!.coast?.allowed).toEqual(["sheer-cliff", "sand-beach"]);
    expect(recipe.regions[0]!.coast?.shares["sheer-cliff"]).toBe(0.5);
    expect(recipe.features.coastSegments).toBeUndefined();
  });
});
