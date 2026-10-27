import { describe, expect, it } from "vitest";
import { continentalWorldRecipe, createWorldField, worldRecipeSchema, type SurfaceSample, type WorldRecipe } from "../src/index.js";

/**
 * River weirs (`river.weirs`): a river crossing a marsh zone with a water
 * table runs AT the table — the river is the fen — and drops only over its
 * declared weir. Opt-in: a river without weirs, and every other river, is
 * solved exactly as before.
 */

/** The marsh test world of voxel-marsh.test.ts: the continental preset's lowland anchors turned to marsh (table +2). */
function marshRecipe(rivers: unknown[]): WorldRecipe {
  const raw = continentalWorldRecipe();
  const marshy = new Set(["swamp", "fen", "grassland", "forest", "savanna"]);
  const anchors = raw.climate.zones!.anchors.map((a) => (marshy.has(a.id) ? { ...a, relief: 0, hills: 0.25, flatten: 1, waterTable: 2, hummocks: 1 } : a));
  return worldRecipeSchema.parse({
    ...raw,
    climate: { ...raw.climate, zones: { ...raw.climate.zones!, anchors } },
    marshMaterial: "terrain/test-marsh",
    features: { ...raw.features, rivers },
  });
}

// measured on this world: marsh from x 1600 to ~2370 along z -2000, then the coast, the sea by x 2500
const WEIR: [number, number] = [2380, -2000];
const fenRiver = (weirs?: unknown[]) => ({
  id: "fenrun",
  points: [[1600, -2000], [1800, -2005], [2000, -1995], [2200, -2000], [2380, -2000], [2500, -2000]],
  width: 12,
  depth: 3,
  bank: 12,
  maxGrade: 0,
  surface: "",
  ...(weirs ? { weirs } : {}),
});
const otherRiver = { id: "dryrun", points: [[-1000, 1000], [-800, 1010], [-600, 1000], [-400, 990]], width: 8, depth: 2, bank: 8, surface: "" };

describe("river weirs hold a fen river at the marsh table", () => {
  const plain = createWorldField(marshRecipe([fenRiver(), otherRiver]));
  const held = createWorldField(marshRecipe([fenRiver([{ id: "test-weir", at: WEIR }]), otherRiver]));
  const table = held.marshTable(1800, -2000)!;
  const solved = (f: typeof plain, id: string) => f.rivers.find((r) => r.id === id)!;
  const s: SurfaceSample = { y: 0, flowX: 0, flowZ: 0, kind: "lake", floor: 0 };

  it("the test world is a marsh along the river's upper reach", () => {
    expect(table).not.toBeNull();
    for (const x of [1700, 1900, 2100, 2300]) expect(held.marshTable(x, -2000)).toBeCloseTo(table, 6);
  });

  it("without a weir the river runs in a trench under the fen (the fault the weir fixes)", () => {
    const r = solved(plain, "fenrun");
    const under = r.points.filter((p, k) => p[0] < 2300 && r.surfaceY![k]! < table - 0.5);
    expect(under.length).toBeGreaterThan(10);
  });

  it("with a weir every point above it stands at the table, and the river drops over the weir", () => {
    const r = solved(held, "fenrun");
    // the resolved level is written onto the solved doc
    expect(r.weirs![0]!.level).toBeCloseTo(table, 6);
    let lip = -1;
    r.points.forEach((p, k) => {
      if (Math.hypot(p[0] - WEIR[0], p[1] - WEIR[1]) < 0.5) lip = k;
    });
    expect(lip).toBeGreaterThan(0);
    for (let k = 0; k <= lip; k++) {
      // never under the backwater (the head comes down a hill into it), and AT it through the fen
      expect(r.surfaceY![k]!).toBeGreaterThanOrEqual(table - 0.01);
      if (r.points[k]![0] > 1640) expect(r.surfaceY![k]!).toBeCloseTo(table, 2);
    }
    // below the weir the water is lower, and the drop is a fall at the weir
    expect(r.surfaceY![lip + 1]!).toBeLessThan(table - 1);
    const fall = held.falls.find((f) => f.river === "fenrun" && Math.hypot(f.x - WEIR[0], f.z - WEIR[1]) < 8);
    expect(fall).toBeDefined();
    expect(fall!.top).toBeCloseTo(table, 1);
  });

  it("the banks merge into the fen: no levee crest between the channel and the sheet", () => {
    let wetPlain = 0;
    let wetHeld = 0;
    let n = 0;
    for (let x = 1660; x <= 2300; x += 20) {
      for (const side of [-1, 1]) {
        // where the levee crest stood: 6 m channel half + 0.7 of the 12 m bank, either side
        const z = -2000 + side * (6 + 12 * 0.7);
        n++;
        if (plain.waterSurface(x, z, s) && Math.abs(s.y - table) < 0.05 && plain.height(x, z) < table) wetPlain++;
        if (held.waterSurface(x, z, s) && Math.abs(s.y - table) < 0.05 && held.height(x, z) < table + 0.2) wetHeld++;
        // and the ground there never stands over the levee height a plain river builds
        expect(held.height(x, z)).toBeLessThan(table + 1.6);
      }
    }
    expect(wetHeld / n).toBeGreaterThan(0.6);
    expect(wetHeld).toBeGreaterThan(wetPlain);
  });

  it("every other river is solved exactly as before", () => {
    const a = solved(plain, "dryrun");
    const b = solved(held, "dryrun");
    expect(b.points).toEqual(a.points);
    expect(b.bedY).toEqual(a.bedY);
    expect(b.surfaceY).toEqual(a.surfaceY);
    for (let x = -1100; x <= -300; x += 13) for (let z = 960; z <= 1040; z += 7) expect(held.height(x, z)).toBe(plain.height(x, z));
  });

  it("a weir with no level and no marsh upstream does nothing", () => {
    const base = createWorldField(marshRecipe([otherRiver]));
    const withWeir = createWorldField(marshRecipe([{ ...otherRiver, weirs: [{ at: [-600, 1000] }] }]));
    const a = solved(base, "dryrun");
    const b = solved(withWeir, "dryrun");
    expect(b.points).toEqual(a.points);
    expect(b.bedY).toEqual(a.bedY);
    expect(b.surfaceY).toEqual(a.surfaceY);
  });

  it("an explicit level holds a river up behind its weir anywhere (a dam's reservoir)", () => {
    const base = solved(createWorldField(marshRecipe([otherRiver])), "dryrun");
    const mid = Math.floor(base.points.length / 2);
    const level = base.surfaceY![mid]! + 1.5;
    const dam = solved(createWorldField(marshRecipe([{ ...otherRiver, weirs: [{ at: base.points[mid]!, level }] }])), "dryrun");
    const k = dam.points.findIndex((p) => Math.hypot(p[0] - base.points[mid]![0], p[1] - base.points[mid]![1]) < 0.5);
    expect(dam.surfaceY![k]!).toBeCloseTo(level, 2);
    expect(dam.surfaceY![k + 1]!).toBeLessThan(level - 1);
  });
  it("weirs with a reach hold flat pools cut into the ground, stepping down only at each crest (a pool-and-rapid chain)", () => {
    const base = solved(createWorldField(marshRecipe([otherRiver])), "dryrun");
    const n = base.points.length;
    // two pools: each one well under the river's own level at its head, so only the reach can hold it
    const iA = Math.floor(n * 0.45), iB = Math.floor(n * 0.75);
    const lvA = base.surfaceY![iA]! - 0.5, lvB = lvA - 1.5;
    const along = (a: readonly number[], b: readonly number[]) => Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!);
    let reachB = 0;
    for (let k = iA; k < iB; k++) reachB += along(base.points[k]!, base.points[k + 1]!);
    const weirs = [
      { id: "a", at: base.points[iA]!, level: lvA, reach: 40 },
      { id: "b", at: base.points[iB]!, level: lvB, reach: reachB + 5 },
    ];
    const r = solved(createWorldField(marshRecipe([{ ...otherRiver, weirs }])), "dryrun");
    const kOf = (q: readonly number[]) => r.points.findIndex((p) => along(p, q) < 0.5);
    const kA = kOf(base.points[iA]!), kB = kOf(base.points[iB]!);
    expect(kA).toBeGreaterThan(0);
    expect(kB).toBeGreaterThan(kA);
    // pool B is flat from just below crest A to crest B (the reach stops at A's crest), pool A for its 40 m
    for (let k = kA + 2; k <= kB; k++) expect(r.surfaceY![k]!).toBeCloseTo(lvB, 2);
    let run = 0;
    for (let k = kA; k > 0 && run <= 38; k--) {
      expect(r.surfaceY![k]!).toBeCloseTo(lvA, 2);
      run += along(r.points[k]!, r.points[k - 1]!);
    }
    // the bed sits a channel under each pool
    for (let k = kA + 2; k <= kB; k++) expect(r.bedY![k]!).toBeLessThan(lvB - 1.5);
  });
});
