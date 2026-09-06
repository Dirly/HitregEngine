import { describe, expect, it } from "vitest";
import {
  allSharedBorders,
  classBreakdown,
  classifyChain,
  guaranteedPass,
  openRuns,
  outlineChain,
  passWidthFor,
  passesOnRun,
  regionSchema,
  ridgePieces,
  sharedBorderChains,
  simplifyPolyline,
  type BorderClass,
  type BorderSample,
  type RegionDoc,
} from "../src/index.js";

/**
 * Border geometry for the barriers stage (docs/world-editing/barriers.md):
 * shared edges sampled by proximity, open runs with single-sample bridging,
 * passes where paths cross, ridge pieces between the passes.
 */

const STEP = 15;
const west: RegionDoc = regionSchema.parse({ id: "west", name: "West", polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]] });
// east shares x=1000 from z=0..1000 but its outline is simplified differently: one extra vertex, a metre off
const east: RegionDoc = regionSchema.parse({ id: "east", name: "East", polygon: [[1000, 0], [2000, 0], [2000, 1000], [1000, 1000], [1001, 500]] });
const south: RegionDoc = regionSchema.parse({ id: "south", name: "South", polygon: [[0, 1000], [2000, 1000], [2000, 1800], [0, 1800]] });
const far: RegionDoc = regionSchema.parse({ id: "far", name: "Far", polygon: [[5000, 5000], [6000, 5000], [6000, 6000], [5000, 6000]] });

describe("shared borders", () => {
  it("finds the edge two zones share by proximity, not identity", () => {
    const chains = sharedBorderChains(west, east, STEP, 2);
    expect(chains).toHaveLength(1);
    const c = chains[0]!;
    expect(c.a).toBe("west");
    expect(c.b).toBe("east");
    expect(c.length).toBeGreaterThan(950);
    expect(c.samples.every((s) => Math.abs(s.x - 1000) < 1e-6)).toBe(true);
    // direction runs along the border
    expect(Math.abs(c.samples[0]!.dx)).toBeLessThan(1e-6);
    expect(Math.abs(c.samples[0]!.dz)).toBeCloseTo(1, 6);
    // the west/south border is the z=1000 edge; the west outline is walked so the chain is contiguous across the corner
    expect(sharedBorderChains(west, south, STEP, 2)[0]!.length).toBeGreaterThan(950);
    expect(sharedBorderChains(west, far, STEP, 2)).toEqual([]);
  });

  it("pairs every touching pair once, and a cut-out only with its parent (its whole outline)", () => {
    const town: RegionDoc = regionSchema.parse({ id: "t", name: "T", polygon: [[400, 400], [600, 400], [600, 600], [400, 600]], within: "west", tags: ["town"] });
    const chains = allSharedBorders([west, east, south, far, town], STEP, 2);
    const pairs = chains.map((c) => `${c.a}/${c.b}`);
    expect(pairs).toContain("west/east");
    expect(pairs).toContain("west/south");
    expect(pairs).toContain("east/south");
    expect(pairs).toContain("west/t");
    expect(pairs.filter((p) => p.includes("far"))).toEqual([]);
    expect(pairs.filter((p) => p === "east/t" || p === "t/east" || p === "south/t" || p === "t/south")).toEqual([]);
    const outline = chains.find((c) => c.b === "t")!;
    expect(outline.length).toBeCloseTo(800, 6);
    expect(outlineChain(town, west, 100).samples).toHaveLength(8);
  });
});

function chainOf(n: number): { a: string; b: string; samples: BorderSample[]; length: number } {
  const samples: BorderSample[] = [];
  for (let i = 0; i < n; i++) samples.push({ x: 1000, z: i * STEP, along: i * STEP, dx: 0, dz: 1 });
  return { a: "west", b: "east", samples, length: (n - 1) * STEP };
}

describe("open runs", () => {
  it("classifies through the callback and totals metres by class", () => {
    const chain = chainOf(20);
    const classified = classifyChain(chain, (s) => (s.z < 150 ? "water" : "open"));
    expect(classBreakdown(classified, STEP)).toMatchObject({ water: 150, open: 150 });
    expect(classified[0]!.cls).toBe("water");
  });

  it("keeps runs of at least minRun, bridging a single non-open sample but not two", () => {
    const chain = chainOf(40);
    const cls = (i: number): BorderClass => (i === 10 ? "water" : i === 25 || i === 26 ? "steep" : i >= 36 ? "coast" : "open");
    const classified = classifyChain(chain, (s) => cls(Math.round(s.along / STEP)));
    const runs = openRuns(classified, STEP, 60);
    // one run 0..24 (the puddle at 10 bridged), one 27..35 (135 m, kept), nothing after 36
    expect(runs.map((r) => [r.start, r.end])).toEqual([
      [0, 24],
      [27, 35],
    ]);
    expect(runs[0]!.length).toBe(25 * STEP);
    // a short run is dropped
    expect(openRuns(classified, STEP, 200).map((r) => [r.start, r.end])).toEqual([[0, 24]]);
    // a puddle at the very end is not bridged into thin air
    const tail = classifyChain(chainOf(10), (s) => (s.along >= 9 * STEP ? "water" : "open"));
    expect(openRuns(tail, STEP, 60).map((r) => [r.start, r.end])).toEqual([[0, 8]]);
  });
});

describe("passes and ridge pieces", () => {
  const ridge = { width: 24, falloff: 60 };
  const path = { width: 2.4, shoulder: 8 };
  const passWidth = passWidthFor(ridge, path);
  const chain = chainOf(100); // 1.5 km of border along z at x=1000
  const run = openRuns(classifyChain(chain, () => "open"), STEP, 60)[0]!;

  it("sizes the pass so the path's tread and shoulders sit on natural ground", () => {
    expect(passWidth).toBeCloseTo(24 + 120 + 2.4 + 16, 6);
  });

  it("puts a pass where a path crosses (or comes within half a pass width), merging near ones", () => {
    const paths = [
      { id: "path-1", points: [[900, 300], [1100, 320]] as [number, number][] }, // crosses near z≈310
      { id: "path-2", points: [[900, 400], [1100, 400]] as [number, number][] }, // 90 m on: merges with path-1
      { id: "trail-9", points: [[950, 1200], [1050, 1200]] as [number, number][] }, // crosses at z=1200, far away
      { id: "path-3", points: [[0, 0], [0, 2000]] as [number, number][] }, // nowhere near
    ];
    const passes = passesOnRun(run, paths, passWidth);
    expect(passes).toHaveLength(2);
    expect(passes[0]!.paths.sort()).toEqual(["path-1", "path-2"]);
    expect(passes[0]!.along).toBeGreaterThan(300);
    expect(passes[0]!.along).toBeLessThan(400);
    expect(passes[0]!.source).toBe("path");
    expect(passes[1]!.paths).toEqual(["trail-9"]);
    expect(passes[1]!.along).toBeCloseTo(1200, 0);
    // walked along the path: heading is the path's
    expect(Math.abs(passes[1]!.dx)).toBeCloseTo(1, 6);
  });

  it("cuts the run into ridge pieces around the passes, dropping stubs", () => {
    const passes = passesOnRun(run, [{ id: "p", points: [[900, 600], [1100, 600]] }], passWidth);
    const pieces = ridgePieces(run, passes, STEP, 60);
    expect(pieces).toHaveLength(2);
    const [before, after] = pieces;
    expect(before![before!.length - 1]!.along).toBeLessThan(600 - passWidth / 2 + 1e-6);
    expect(after![0]!.along).toBeGreaterThan(600 + passWidth / 2 - 1e-6);
    // a pass wider than the run leaves nothing
    const short = openRuns(classifyChain(chainOf(8), () => "open"), STEP, 60)[0]!;
    expect(ridgePieces(short, [{ ...guaranteedPass(short, passWidth) }], STEP)).toEqual([]);
  });

  it("a pair with no crossing gets one pass at the run's midpoint, walked across the border", () => {
    const g = guaranteedPass(run, passWidth);
    expect(g.source).toBe("guaranteed");
    expect(g.along).toBeCloseTo(50 * STEP, 6);
    expect(Math.abs(g.dx)).toBeCloseTo(1, 6); // across a border that runs along z
    expect(g.paths).toEqual([]);
  });

  it("simplifies a sampled run to a few points, keeping both ends", () => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 40; i++) pts.push([i * 10, Math.sin(i / 6) * 30]);
    const simple = simplifyPolyline(pts, 4);
    expect(simple.length).toBeLessThan(pts.length / 2);
    expect(simple[0]).toEqual(pts[0]);
    expect(simple[simple.length - 1]).toEqual(pts[pts.length - 1]);
    expect(simplifyPolyline([[0, 0], [100, 0]], 5)).toEqual([[0, 0], [100, 0]]);
  });
});
