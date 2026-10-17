import { describe, expect, it } from "vitest";
import { continentalWorldRecipe, createWorldField, worldRecipeSchema, type WorldRecipe } from "../src/index.js";

/**
 * Landform profiles (anchor `landform`), ridged multifractal ranges
 * (`terrain.ridgedMultifractal`), per-anchor cliffs and the marsh `wetBias`.
 * All opt-in: voxel-marsh.test.ts holds the golden hashes of the presets
 * without them. Here: each one changes the ground, stays continuous across
 * zone borders, and keeps the bulk sampler and the point query agreeing.
 */

const FAMILIES = [
  { hummocky: { weight: 1, amplitude: 5 } },
  { drumlin: { weight: 1, amplitude: 14, stretch: 3.5 } },
  { karst: { weight: 1, amplitude: 18, towers: 0.4 } },
  { cuesta: { weight: 1, amplitude: 26, steps: 2 } },
  { wetland: { weight: 0.8, level: 2 } },
  { mesa: { weight: 1, amplitude: 50 } },
  { rolling: { weight: 1.2 } },
] as const;

function withLandforms(extra: Partial<WorldRecipe["terrain"]> = {}, cliffs = false): WorldRecipe {
  const raw = continentalWorldRecipe();
  const anchors = raw.climate.zones!.anchors.map((a, i) => ({
    ...a,
    landform: {
      ...FAMILIES[i % FAMILIES.length],
      rolling: { weight: 0.5 },
      ...(cliffs && i % 2 === 0 ? { cliffs: 1 } : {}),
      variants: [{ ...FAMILIES[(i + 3) % FAMILIES.length], weight: 1 }],
    },
  }));
  return worldRecipeSchema.parse({ ...raw, terrain: { ...raw.terrain, ...extra }, climate: { ...raw.climate, zones: { ...raw.climate.zones!, anchors } } });
}

/** Largest height step between lattice neighbours `step` apart over a box — a discontinuity shows as a spike. */
function maxStep(f: ReturnType<typeof createWorldField>, x0: number, z0: number, size: number, step: number): number {
  let worst = 0;
  const n = Math.round(size / step);
  let prevRow: number[] = [];
  for (let j = 0; j <= n; j++) {
    const row: number[] = [];
    for (let i = 0; i <= n; i++) {
      const h = f.naturalHeight(x0 + i * step, z0 + j * step);
      if (i > 0) worst = Math.max(worst, Math.abs(h - row[i - 1]!));
      if (j > 0) worst = Math.max(worst, Math.abs(h - prevRow[i]!));
      row.push(h);
    }
    prevRow = row;
  }
  return worst;
}

describe("landform profiles", () => {
  const base = createWorldField(worldRecipeSchema.parse(continentalWorldRecipe()));
  const recipe = withLandforms();
  const field = createWorldField(recipe);

  it("change the ground where they apply", () => {
    let differ = 0;
    for (let z = -3000; z <= 3000; z += 211) for (let x = -3000; x <= 3000; x += 211) if (Math.abs(field.naturalHeight(x, z) - base.naturalHeight(x, z)) > 0.5) differ++;
    expect(differ).toBeGreaterThan(100);
  });

  it("are continuous: no jump between 2 m neighbours anywhere on a long transect through several zones", () => {
    // the preset's own ridged crests already step ~15 m in 2 m; a family may add a few metres (a karst
    // tower wall), a seam would add tens
    for (const [x0, z0] of [[-2400, -300], [600, 900], [-900, -2100]] as const) expect(maxStep(field, x0, z0, 400, 2)).toBeLessThan(maxStep(base, x0, z0, 400, 2) + 6);
  }, 60000);

  it("a variant draw gives two sites of one anchor different shapes", () => {
    // at least one anchor must show its main profile in one zone and a variant in another:
    // sample zone centres; record (anchor -> distinct local roughness signatures)
    const seen = new Map<string, Set<number>>();
    for (let z = -4000; z <= 4000; z += 300) {
      for (let x = -4000; x <= 4000; x += 300) {
        const id = field.zone(x, z).id;
        const d = Math.round(Math.abs(field.naturalHeight(x, z) - base.naturalHeight(x, z)));
        (seen.get(id) ?? seen.set(id, new Set()).get(id)!).add(Math.min(d, 9));
      }
    }
    expect([...seen.values()].some((s) => s.size > 2)).toBe(true);
  });

  it("the bulk sampler and the point query agree", () => {
    const step = field.voxelSize;
    for (const [ox, oz] of [[128, -64], [-1500, 800]] as const) {
      const gy = Math.floor(field.height(ox, oz) / step) * step;
      const origin: [number, number, number] = [ox - step, gy - 6 * step, oz - step];
      const nx = 9, ny = 12, nz = 9;
      const block = field.sampleBlock({ origin, nx, ny, nz, step });
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const x = origin[0] + i * step, y = origin[1] + j * step, z = origin[2] + k * step;
        expect(field.density(x, y, z), `at ${x},${y},${z}`).toBeCloseTo(block[i + j * nx + k * nx * ny]!, 4);
      }
    }
  });

  it("a rolling-only profile at the anchor's own hills gain is the legacy ground", () => {
    const raw = continentalWorldRecipe();
    // (an anchor with a mesas gain keeps it: a landform replaces that with its own mesa family)
    const anchors = raw.climate.zones!.anchors.map((a) => (a.mesas > 0 ? a : { ...a, landform: { rolling: { weight: a.hills } } }));
    const f = createWorldField(worldRecipeSchema.parse({ ...raw, climate: { ...raw.climate, zones: { ...raw.climate.zones!, anchors } } }));
    for (let z = -3000; z <= 3000; z += 397) for (let x = -3000; x <= 3000; x += 397) expect(f.naturalHeight(x, z)).toBeCloseTo(base.naturalHeight(x, z), 6);
  });
});

describe("ridged multifractal ranges", () => {
  const raw = continentalWorldRecipe();
  const plain = createWorldField(worldRecipeSchema.parse(raw));
  const off = createWorldField(worldRecipeSchema.parse({ ...raw, terrain: { ...raw.terrain, ridgedMultifractal: { enabled: false } } }));
  const on = createWorldField(worldRecipeSchema.parse({ ...raw, terrain: { ...raw.terrain, ridgedMultifractal: { enabled: true } } }));

  it("off is the plain band, exactly", () => {
    for (let z = -3000; z <= 3000; z += 401) for (let x = -3000; x <= 3000; x += 401) expect(off.naturalHeight(x, z)).toBe(plain.naturalHeight(x, z));
  });

  it("on keeps the band's scale (same mean height within 25%) but moves the ground", () => {
    let a = 0, b = 0, n = 0, moved = 0;
    for (let z = -4000; z <= 4000; z += 97) for (let x = -4000; x <= 4000; x += 97) {
      const p = plain.naturalHeight(x, z), q = on.naturalHeight(x, z);
      a += p; b += q; n++;
      if (Math.abs(p - q) > 1) moved++;
    }
    expect(Math.abs(b - a) / Math.abs(a)).toBeLessThan(0.25);
    expect(moved / n).toBeGreaterThan(0.05);
  });

  it("per-anchor range directions blend continuously across zone borders", () => {
    const anchors = raw.climate.zones!.anchors.map((x, i) => ({ ...x, relief: 1, landform: { rolling: { weight: x.hills }, rangeAngle: i * 0.7 } }));
    const f = createWorldField(worldRecipeSchema.parse({ ...raw, terrain: { ...raw.terrain, ridgedMultifractal: { enabled: true } }, climate: { ...raw.climate, zones: { ...raw.climate.zones!, anchors } } }));
    // ridged mountains are steep (the plain band steps ~15 m in 2 m here): never a seam beyond that
    for (const [x0, z0] of [[-2400, -300], [600, 900]] as const) expect(maxStep(f, x0, z0, 400, 2)).toBeLessThan(maxStep(plain, x0, z0, 400, 2) * 1.6 + 4);
  }, 60000);
});

describe("per-anchor cliffs", () => {
  it("terrace only the anchors that ask, even with terrain.cliffs off", () => {
    const raw = continentalWorldRecipe();
    const noCliffs = createWorldField(withLandforms({}, false));
    const someCliffs = createWorldField(withLandforms({}, true));
    let changedAsked = 0, changedOther = 0;
    for (let z = -4000; z <= 4000; z += 53) for (let x = -4000; x <= 4000; x += 53) {
      const d = Math.abs(noCliffs.naturalHeight(x, z) - someCliffs.naturalHeight(x, z));
      if (d < 0.01) continue;
      const i = raw.climate.zones!.anchors.findIndex((a) => a.id === noCliffs.zone(x, z).id);
      if (i % 2 === 0) changedAsked++;
      else changedOther++;
    }
    expect(changedAsked).toBeGreaterThan(0);
    // only border blends of asking anchors reach into the others
    expect(changedOther).toBeLessThan(changedAsked);
  });
});

describe("marsh wetBias", () => {
  it("drowns more of a marsh, monotonically", () => {
    const raw = continentalWorldRecipe();
    const marshy = new Set(["swamp", "fen", "grassland", "forest", "savanna"]);
    const anchors = raw.climate.zones!.anchors.map((a) => (marshy.has(a.id) ? { ...a, relief: 0, hills: 0.25, flatten: 1, waterTable: 2, hummocks: 1 } : a));
    const share = (bias: number): number => {
      const f = createWorldField(worldRecipeSchema.parse({ ...raw, climate: { ...raw.climate, zones: { ...raw.climate.zones!, anchors, marsh: { wetBias: bias } } } }));
      let all = 0, wet = 0;
      for (let z = -6000; z <= 6000; z += 80) for (let x = -6000; x <= 6000; x += 80) {
        const t = f.marshTable(x, z);
        if (t === null) continue;
        all++;
        if (f.height(x, z) < t) wet++;
      }
      return wet / all;
    };
    const s0 = share(0), s1 = share(0.15), s2 = share(0.3);
    expect(s1).toBeGreaterThan(s0 + 0.03);
    expect(s2).toBeGreaterThan(s1);
  });
});

describe("river valleys", () => {
  it("lower the ground beside an authored river, never under its floor, continuously", () => {
    const raw = continentalWorldRecipe();
    const river = { id: "r", points: [[-600, -200], [-300, -150], [0, -260], [300, -120], [600, -200]], width: 12, depth: 2, bank: 6, bedY: [30, 28, 26, 24, 22], surface: "dirt" };
    const make = (valley: boolean) => {
      const anchors = raw.climate.zones!.anchors.map((a) => ({ ...a, landform: { rolling: { weight: a.hills }, ...(valley ? { valley: { shape: "V" as const, width: 14, depth: 30 } } : {}) } }));
      return createWorldField(worldRecipeSchema.parse({ ...raw, features: { ...raw.features, rivers: [river] }, climate: { ...raw.climate, zones: { ...raw.climate.zones!, anchors } } }));
    };
    const plain = make(false), withValley = make(true);
    let lowered = 0;
    for (let z = -300; z <= -60; z += 6) for (let x = -500; x <= 500; x += 6) {
      const a = plain.height(x, z), b = withValley.height(x, z);
      expect(b).toBeLessThanOrEqual(a + 1e-6);
      if (a - b > 0.5) lowered++;
    }
    expect(lowered).toBeGreaterThan(50);
    // no seam on the inside of the bends: 2 m neighbours stay within the hills' own slope + a margin
    let worst = 0;
    for (let z = -400; z <= 0; z += 2) { let prev = withValley.height(-200, z); for (let x = -198; x <= 200; x += 2) { const h = withValley.height(x, z); worst = Math.max(worst, Math.abs(h - prev)); prev = h; } }
    expect(worst).toBeLessThan(4);
  });
});

describe("landform calm discs", () => {
  it("inside a disc the ground is exactly the world without profiles; outside it is not", () => {
    const raw = continentalWorldRecipe();
    const base = createWorldField(worldRecipeSchema.parse(raw));
    const shaped = withLandforms({}, true);
    const calmed = createWorldField(worldRecipeSchema.parse({ ...shaped, features: { ...shaped.features, landformCalm: [{ id: "t", center: [-1200, 400], radius: 300, falloff: 100 }] } }));
    const free = createWorldField(shaped);
    let outsideDiffers = 0;
    for (let z = 100; z <= 700; z += 23) for (let x = -1500; x <= -900; x += 23) {
      const d = Math.hypot(x + 1200, z - 400);
      if (d < 300) expect(calmed.naturalHeight(x, z)).toBe(base.naturalHeight(x, z));
    }
    for (let z = -2000; z <= -1000; z += 97) for (let x = 1000; x <= 2000; x += 97) {
      expect(calmed.naturalHeight(x, z)).toBe(free.naturalHeight(x, z));
      if (Math.abs(free.naturalHeight(x, z) - base.naturalHeight(x, z)) > 0.5) outsideDiffers++;
    }
    expect(outsideDiffers).toBeGreaterThan(5);
  });
});
