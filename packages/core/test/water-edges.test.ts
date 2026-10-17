import { describe, expect, it } from "vitest";
import { classifyOutline, classifyEdges, clipWaterToSolid, meshOutline, openStretches, waterSchema, type SolidProbe } from "../src/index.js";

/** A room: walls where |x| > 5 or |z| > 5, the floor at -2; a corridor out east (|z| < 1) and a hole in the floor. */
function room(opts: { corridor?: boolean; hole?: [number, number, number, number] } = {}): SolidProbe {
  const solid = (x: number, y: number, z: number): boolean => {
    if (opts.hole && x > opts.hole[0] && x < opts.hole[1] && z > opts.hole[2] && z < opts.hole[3]) return false;
    if (y < -2) return true;
    const inRoom = Math.abs(x) <= 5 && Math.abs(z) <= 5;
    const inCorridor = !!opts.corridor && x > 0 && Math.abs(z) <= 1;
    return !(inRoom || inCorridor);
  };
  return {
    floor(x, z, hi, lo) {
      if (solid(x, hi, z)) return hi;
      for (let y = hi; y >= lo; y -= 0.05) if (solid(x, y, z)) return y;
      return null;
    },
    wall(x, y, z, dx, dz, reach) {
      for (let d = 0; d <= reach; d += 0.05) if (solid(x + dx * d, y, z + dz * d)) return d;
      return null;
    },
  };
}
const rect = (x0: number, z0: number, x1: number, z1: number): [number, number][] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

describe("water edge classifier", () => {
  it("calls the sea running to the world's edge horizon, not open, and keeps a real open edge inside it a fault", () => {
    // an open sea (no solid anywhere above -40): a 2 km sheet, its rim past a 900 m world boundary
    const sea: SolidProbe = { floor: (_x, _z, hi, lo) => (lo <= -40 ? Math.min(hi, -40) : null) };
    const pastLimit = (x: number, z: number): boolean => Math.hypot(x, z) >= 900;
    const ocean = classifyOutline(sea, rect(-1000, -1000, 1000, 1000), 0, [], { horizon: pastLimit, bedDepth: 50 });
    expect(ocean.open).toBe(0);
    expect(ocean.horizon).toBe(16000);
    expect(ocean.runs.length).toBe(0);
    // the same sea, its rim cut short inside the boundary on the east: that stretch is open (a shelf over the sea bed)
    const short = classifyOutline(sea, rect(-1000, -1000, 600, 1000), 0, [], { horizon: pastLimit, bedDepth: 50 });
    expect(short.runs.length).toBeGreaterThan(0);
    expect(short.runs.every((r) => r.mid[0] > 590)).toBe(true);
    // no horizon given (a placed pond): every edge open, and the long outline groups fast into one ring of stretches
    const t0 = performance.now();
    const pond = classifyOutline(sea, rect(-1000, -1000, 1000, 1000), 0, [], { bedDepth: 50 });
    expect(pond.open).toBe(16000);
    expect(pond.runs.reduce((s, r) => s + r.length, 0)).toBe(8000);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it("buries edges under walls and leaves a sheet stopping mid-room open (shelf)", () => {
    expect(classifyOutline(room(), rect(-5.1, -5.1, 5.1, 5.1), 0).open).toBe(0);
    const rep = classifyOutline(room(), rect(-3, -3, 3, 3), 0);
    expect(rep.buried).toBe(0);
    expect(rep.runs[0]!.why).toBe("shelf");
  });
  it("calls water ending over a hole in the floor a drop", () => {
    const rep = classifyOutline(room({ hole: [3, 6, -6, 6] }), rect(-5.1, -5.1, 3, 5.1), 0);
    expect(rep.runs.some((r) => r.why === "drop")).toBe(true);
  });
  it("accepts a declared finish over the open stretch", () => {
    const rep = classifyOutline(room(), rect(-5.1, -5.1, 3, 5.1), 0, [{ kind: "dark", from: [3, -5], to: [3, 5] }]);
    expect(rep.open).toBe(0);
    expect(rep.finished).toBeGreaterThan(0);
  });
});

describe("clipWaterToSolid", () => {
  it("fills a pool to its walls with a buried rim: no open edge left", () => {
    const clip = clipWaterToSolid(room(), { x0: -3, z0: -3, x1: 3, z1: 3 }, 0);
    expect(clip.open).toEqual([]);
    expect(clip.bounds.x1).toBeGreaterThan(5);
    const rep = classifyEdges(room(), meshOutline(clip.positions, clip.indices, clip.origin), 0);
    expect(rep.open).toBe(0);
  });
  it("leaves a channel running on past its reach as one open stretch to finish", () => {
    const clip = clipWaterToSolid(room({ corridor: true }), { x0: -3, z0: -3, x1: 3, z1: 3 }, 0, { grow: 10 });
    const st = openStretches(clip.open);
    expect(st.length).toBe(1);
    expect(st[0]!.why).toBe("run-on");
    expect(st[0]!.length).toBeCloseTo(2, 0);
    expect(st[0]!.out).toEqual([1, 0]);
  });
});

describe("water finishes schema", () => {
  it("validates a finish", () => {
    const w = waterSchema.parse({ finishes: [{ kind: "dark", from: [0, 0], to: [1, 0], entity: "x" }] });
    expect(w.finishes![0]!.kind).toBe("dark");
    expect(() => waterSchema.parse({ finishes: [{ kind: "pipe", from: [0, 0], to: [1, 0] }] })).toThrow();
  });
});
