import { describe, expect, it } from "vitest";
import {
  applyOperator,
  centripetalCatmullRom,
  compileOperator,
  createWorldField,
  defaultWorldRecipe,
  fitRibbon,
  quantizeStair,
  operatorSpecs,
  pathParamsSchema,
  ribbonArc,
  ribbonMesh,
  ribbonPatch,
  ribbonSurfaces,
  ribbonMaterialId,
  ribbonVerge,
  ribbonJoins,
  wallFaceOffset,
  wallSkinOverrides,
  RIBBON_WALL_TURN_CLEAR,
  solveProfile,
  voxelChunkDoc,
  worldRecipeSchema,
  RIBBON_LIFT,
  RIBBON_STAIR_FOOT,
  stairRamp,
  type OperatorFieldReader,
  type RibbonDoc,
} from "../src/index.js";

const reader = (h: (x: number, z: number) => number): OperatorFieldReader => ({ height: h, voxelSize: 2, seaLevel: 0, seed: 3 });
/** Rolling ground: bumps a carved path would draw as lumpy treads. */
const rolling = reader((x, z) => 40 + 1.2 * Math.sin(x * 0.21) + 0.8 * Math.sin(z * 0.17 + x * 0.05));
/** A 60 % slope rising toward +x (steeper than any ramp). */
const steep = reader((x) => 40 + 0.6 * Math.max(0, Math.min(40, x)));
/** A side slope: ground falls toward +z at 45 %. */
const sideSlope = reader((_x, z) => 40 - 0.45 * z);

const lane = { points: [[0, 0], [30, 8], [60, 0], [90, 10]] as [number, number][], width: 3 };

describe("path spline", () => {
  it("passes through every control point at an even ~1 m step", () => {
    const c = centripetalCatmullRom(lane.points, 1);
    for (const [px, pz] of lane.points) {
      const d = Math.min(...c.x.map((x, i) => Math.hypot(x - px, c.z[i]! - pz)));
      expect(d).toBeLessThan(0.6);
    }
    for (let i = 1; i < c.s.length; i++) {
      const step = Math.hypot(c.x[i]! - c.x[i - 1]!, c.z[i]! - c.z[i - 1]!);
      expect(step).toBeGreaterThan(0.85);
      expect(step).toBeLessThan(1.05);
    }
  });

  it("does not overshoot on uneven spacing (centripetal)", () => {
    const c = centripetalCatmullRom([[0, 0], [1, 0], [40, 0], [41, 1]], 1);
    expect(Math.max(...c.x)).toBeLessThan(41.6);
    expect(Math.min(...c.x)).toBeGreaterThan(-0.6);
  });
});

describe("path profile", () => {
  it("never exceeds the grade and balances cut and fill", () => {
    const s = Array.from({ length: 201 }, (_, i) => i);
    const target = s.map((v) => 10 + (v > 100 ? 8 : 0)); // a 8 m step in the ground
    const y = solveProfile(s, target, new Array(200).fill(0.1), 6);
    for (let i = 1; i < y.length; i++) expect(Math.abs(y[i]! - y[i - 1]!)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(y[0]).toBeCloseTo(10, 1);
    expect(y[200]).toBeCloseTo(18, 1);
    expect(y[100]! - 10).toBeGreaterThan(2); // the ramp straddles the step
    expect(18 - y[101]!).toBeGreaterThan(2);
  });

  it("follows gentle rolling ground within maxGrade, with no steps", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ ...lane, maxGrade: 0.15 }), rolling);
    expect(fit.ribbon.flights).toEqual([]);
    expect(fit.report.maxGrade).toBeLessThanOrEqual(0.15 + 1e-6);
    expect(fit.report.cut).toBeLessThan(1.2);
    expect(fit.report.fill).toBeLessThan(1.2);
  });
});

describe("steep stretches", () => {
  it("lays steps with flights and landings where the ground is steeper than a ramp", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[-30, 0], [70, 0]], width: 2.4, maxGrade: 0.15, steep: "steps" }), steep);
    expect(fit.ribbon.flights.length).toBeGreaterThan(0);
    const f = fit.ribbon.flights[0]!;
    expect(f.rise).toBeGreaterThan(0.12);
    expect(f.rise).toBeLessThan(0.21);
    for (const [s0, s1] of f.treads) expect(s1 - s0).toBeGreaterThanOrEqual(0.28 - 1e-6);
    // the ramp sections either side still hold the grade
    expect(fit.report.maxGrade).toBeLessThanOrEqual(0.15 + 1e-6);
  });

  it("ends every path on a level run-out: the last 2 m hold the grade and no stair reaches them", () => {
    for (const end of [30, 20, 70]) {
      const fit = fitRibbon(pathParamsSchema.parse({ points: [[-30, 0], [end, 0]], width: 2.4, maxGrade: 0.15, steep: "steps" }), steep);
      const sm = fit.ribbon.samples;
      const tail: number[] = [];
      let len = 0;
      for (let i = sm.length - 1; i > 0 && len < 2; i--) {
        len += Math.hypot(sm[i]![0] - sm[i - 1]![0], sm[i]![2] - sm[i - 1]![2]);
        tail.push(i);
      }
      for (const i of tail) {
        const run = Math.hypot(sm[i]![0] - sm[i - 1]![0], sm[i]![2] - sm[i - 1]![2]) || 1;
        expect(Math.abs(sm[i]![1] - sm[i - 1]![1]) / run).toBeLessThanOrEqual(0.15 + 1e-6);
      }
      const total = fit.ribbon.flights.length ? fit.ribbon.flights[fit.ribbon.flights.length - 1]!.to : 0;
      expect(total).toBeLessThan(sm.length - 1 - 1);
    }
  });

  it("slopes each tread's sides down to the ramp beside the flight (no lip to snag on, no shaded line)", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[-30, 0], [70, 0]], width: 2.4, maxGrade: 0.15, steep: "steps" }), steep);
    const r = { id: "st", ...fit.ribbon } as RibbonDoc;
    const m = ribbonMesh(r, -1000, -1000, 1000, 1000, 4);
    const P = m.positions, hw = r.width / 2;
    let flanks = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
      const u = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!], v = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
      // the flight runs along x: a face turned toward the side (z) lies back at least 1.5:1 across the flight, never stands up
      if (Math.abs(n[2]!) / l > 0.3) { expect(Math.abs(n[2]!) / Math.abs(n[1]!)).toBeLessThan(0.67); flanks++; }
    }
    expect(flanks).toBeGreaterThan(0);
    // and every flank foot reaches the graded ramp beside the flight
    const f = r.flights[0]!;
    for (const [sa, , top] of f.treads) {
      const x = r.samples[0]![0] + sa;
      const feet = Array.from({ length: P.length / 3 }, (_, k) => k).filter((k) => Math.abs(P[k * 3]! - x) < 1e-3 && Math.abs(P[k * 3 + 2]!) > hw + 0.3 && P[k * 3 + 1]! > top - 3);
      for (const k of feet) expect(P[k * 3 + 1]!).toBeLessThanOrEqual(stairRamp(r, f, sa) - RIBBON_STAIR_FOOT + 1e-3);
    }
  });

  it("never winds a stair through a tight turn: the turn lands, the rise moves to the straights", () => {
    const s = Array.from({ length: 21 }, (_, i) => i), y = s.map((v) => v * 0.2);
    const level = s.map((i) => (i >= 8 && i <= 12 ? 0 : 1));
    const st = quantizeStair(s, y, 0, 20, level);
    const inTurn = st.treads.filter(([s0, s1]) => s1 > 8.05 && s0 < 11.95);
    expect(inTurn.length).toBe(1); // one landing across the whole turn
    expect(st.treads[st.treads.length - 1]![2]).toBeCloseTo(4, 6);
    expect(st.tread).toBeGreaterThanOrEqual(0.25);
  });

  it("detours as a switchback inside a corridor instead", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[-30, 0], [70, 0]], width: 2.4, maxGrade: 0.15, corridor: 14 }), steep);
    expect(fit.ribbon.switchbacks).toBeGreaterThan(0);
    expect(fit.report.length).toBeGreaterThan(130);
  });

  it("never zig-zags a winding steep stretch along its chord: the path keeps its own line", () => {
    // an L-shaped line up the same steep slope: one long steep stretch whose chord cuts the corner
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[-30, 0], [40, 0], [40, 70]], width: 2.4, maxGrade: 0.15, corridor: 6 }), reader((x, z) => 40 + 0.6 * (Math.max(-30, Math.min(40, x)) + 30) + 0.6 * Math.max(0, Math.min(70, z))));
    // every centre sample stays near the authored L (within the corridor), never on the diagonal across it
    const near = (x: number, z: number) => Math.min(Math.abs(z) + Math.max(0, x - 40, -30 - x), Math.abs(x - 40) + Math.max(0, -z, z - 70));
    for (const sm of fit.ribbon.samples) expect(near(sm[0], sm[2])).toBeLessThan(8);
    expect(fit.ribbon.warnings.some((w) => /winds/.test(w))).toBe(true);
  });

  it("quantises a profile into whole risers, landing where it flattens", () => {
    const s = Array.from({ length: 31 }, (_, i) => i);
    const y = s.map((v) => (v < 10 ? v * 0.4 : v < 16 ? 4 : 4 + (v - 16) * 0.4)); // climb, landing, climb
    const st = quantizeStair(s, y, 0, 30);
    expect(st.treads[st.treads.length - 1]![2]).toBeCloseTo(y[30]!);
    expect(st.treads[st.treads.length - 1]![1]).toBeCloseTo(30);
    for (let k = 1; k < st.treads.length; k++) expect(Math.abs(st.treads[k]![2] - st.treads[k - 1]![2])).toBeCloseTo(st.rise);
    expect(st.tread).toBeGreaterThanOrEqual(0.28);
    expect(st.treads.some(([a, b]) => b - a > 5)).toBe(true); // the landing
  });
});

describe("grading patch", () => {
  it("is at least 6 m wide everywhere and levelled just under the ribbon", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ ...lane, width: 1.6 }), rolling);
    const r = { id: "t", ...fit.ribbon } as RibbonDoc;
    const p = ribbonPatch(r, 1);
    expect(p.minWidth).toBeGreaterThanOrEqual(6);
    expect(Math.min(...p.size)).toBeGreaterThanOrEqual(6);
    // at a centre sample the patch asks for the walk level minus the lift, at full weight
    const mid = r.samples[40]!;
    const col = Math.round(mid[0] - p.origin[0]), row = Math.round(mid[2] - p.origin[1]);
    expect(p.weights[row * p.columns + col]).toBe(1);
    expect(Math.abs(p.heights[row * p.columns + col]! - (mid[1] - RIBBON_LIFT))).toBeLessThan(0.15);
  });

  it("puts a retaining wall on a high side drop instead of a bank", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[0, 0], [40, 0]], width: 2.4 }), sideSlope);
    expect(fit.ribbon.pieces.some((p) => p.prefab.startsWith("retaining-wall/common-h") && p.prefab.endsWith("straight-2"))).toBe(true);
    expect(fit.ribbon.cuts.length).toBeGreaterThan(0);
    // the wall is on the falling (+z = right) side: its shoulder is negative (a face) there
    expect(fit.ribbon.samples.filter((s) => s[4] < 0).length).toBeGreaterThan(10);
  });
});

describe("grading edge on a sidehill (lattice-safe)", () => {
  // the side drop grows along the path: a fill wall starts part-way, so the shoulder goes feathered -> walled
  const growing = reader((x, z) => 40 - (0.15 + 0.5 * Math.min(1, Math.max(0, (x - 15) / 20))) * z);
  const at = (p: ReturnType<typeof ribbonPatch>, x: number, z: number) => {
    const col = Math.round((x - p.origin[0])), row = Math.round((z - p.origin[1]));
    return { w: p.weights[row * p.columns + col]!, h: p.heights[row * p.columns + col]! };
  };

  it("fades a wall run's end into the next feathered shoulder (no step ALONG the path past a wall end)", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[0, 0], [70, 0]], width: 3, shoulder: 6, wallDrop: 1.2 }), growing);
    const r = { id: "t", ...fit.ribbon } as RibbonDoc;
    expect(r.samples.some((s) => s[4] < 0) && r.samples.some((s) => s[4] > 0)).toBe(true);
    const p = ribbonPatch(r, 1);
    // along the fill side, every metre out to the shoulder's far edge: the weight never jumps (was 0.7 -> 0 at the end)
    for (const d of [4, 5, 6, 7, 8]) {
      let worst = 0;
      for (let x = 2; x < 68; x++) worst = Math.max(worst, Math.abs(at(p, x + 1, d).w - at(p, x, d).w));
      expect(worst).toBeLessThan(0.3);
    }
  });

  it("keeps every shoulder off a fill wall's face cut (the field reads the wall foot there: no trench edge)", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[0, 0], [70, 0]], width: 3, shoulder: 6, wallDrop: 1.2 }), growing);
    const r = { id: "t", ...fit.ribbon } as RibbonDoc;
    const fills = r.cuts.filter((c) => c.kind === "face" && c.n[1] >= 2.4); // fill walls cut 2.5 m out (a cut wall's lies under the path)
    expect(fills.length).toBeGreaterThan(3);
    const p = ribbonPatch(r, 1);
    for (const c of fills) {
      const s = (c.s[0] + c.s[1]) / 2, n = c.n[1] / 2;
      const x = c.origin[0] + c.dir[0] * s - c.dir[1] * n, z = c.origin[1] + c.dir[1] * s + c.dir[0] * n;
      expect(at(p, x, z).w).toBeLessThan(0.05);
    }
  });

  it("levels a sharp turn continuously: the inside never steps where the nearest arm flips", () => {
    // a 90 degree corner climbing at the grade: the two arms' levels differ by grade x arc
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[0, 0], [30, 0], [30.5, 0.5], [30.5, 30]], width: 3, maxGrade: 0.15 }), reader((x, z) => 40 + 0.14 * (x + z)));
    const p = ribbonPatch({ id: "t", ...fit.ribbon } as RibbonDoc, 1);
    let worst = 0;
    for (let a = 24; a < 30; a++) for (let b = 0; b < 6; b++) {
      const q = at(p, a, b), qx = at(p, a + 1, b), qz = at(p, a, b + 1);
      if (q.w < 1 || qx.w < 1 || qz.w < 1) continue;
      worst = Math.max(worst, Math.abs(qx.h - q.h), Math.abs(qz.h - q.h));
    }
    expect(worst).toBeLessThan(0.35);
  });
});

describe("ribbon mesh", () => {
  const fit = fitRibbon(pathParamsSchema.parse({ points: [[-30, 0], [70, 0]], width: 2.4, steep: "steps" }), steep);
  const r = { id: "m", ...fit.ribbon } as RibbonDoc;

  it("is deterministic and splits across cells without loss or overlap", () => {
    const whole = ribbonMesh(r, -1000, -1000, 1000, 1000, 4);
    const again = ribbonMesh(structuredClone(r), -1000, -1000, 1000, 1000, 4);
    expect(JSON.stringify(again)).toBe(JSON.stringify(whole));
    let tris = 0;
    for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) tris += ribbonMesh(r, cx * 48, cz * 48, cx * 48 + 48, cz * 48 + 48, 4).indices.length;
    expect(tris).toBe(whole.indices.length);
    // every triangle faces up or sideways (never down): CCW seen from above
    const P = whole.positions;
    for (let t = 0; t < whole.indices.length; t += 3) {
      const [a, b, c] = [whole.indices[t]! * 3, whole.indices[t + 1]! * 3, whole.indices[t + 2]! * 3];
      const ux = P[b]! - P[a]!, uz = P[b + 2]! - P[a + 2]!, vx = P[c]! - P[a]!, vz = P[c + 2]! - P[a + 2]!;
      expect(uz * vx - ux * vz).toBeGreaterThanOrEqual(-1e-6);
    }
    expect(ribbonArc(r).length).toBe(r.samples.length);
  });
});

describe("path operator in a world", () => {
  const path = { id: "lane", op: "path", points: [[-40, 5], [0, -6], [40, 8]], width: 3, style: "cobble" };

  it("is self-describing and compiles to one ribbon + one grade patch", () => {
    expect(JSON.stringify(operatorSpecs().path?.schema)).toMatch(/maxGrade/);
    const { pieces } = compileOperator(path, rolling);
    expect(pieces.map((p) => `${p.kind}/${p.feature.id}`).sort()).toEqual(["heightPatches/op:lane:grade", "ribbons/op:lane:ribbon"]);
  });

  it("`calm` makes the grade patch built ground (no overhang noise over a benched path); omitted leaves it natural", () => {
    const grade = (doc: Record<string, unknown>) => compileOperator(doc, rolling).pieces.find((p) => p.kind === "heightPatches")!.feature;
    expect(grade(path)).not.toHaveProperty("calm");
    expect(grade({ ...path, calm: true })).toMatchObject({ calm: true });
    const base = defaultWorldRecipe({ cellSize: 48 });
    const field0 = createWorldField(base);
    const ground: OperatorFieldReader = { height: (x, z) => field0.height(x, z), voxelSize: 2, seaLevel: base.seaLevel, seed: 1 };
    expect(worldRecipeSchema.safeParse(applyOperator(base, { ...path, calm: true }, ground).recipe).success).toBe(true);
  });

  it("streams a ribbon with a trimesh collider, over ground graded within 5 cm of it", () => {
    const base = defaultWorldRecipe({ cellSize: 48 });
    const field0 = createWorldField(base);
    const ground: OperatorFieldReader = { height: (x, z) => field0.height(x, z), voxelSize: 2, seaLevel: base.seaLevel, seed: 1 };
    const { recipe } = applyOperator(base, path, ground);
    expect(worldRecipeSchema.safeParse(recipe).success).toBe(true);
    const field = createWorldField(recipe);
    const r = recipe.features.ribbons![0]!;
    // graded ground matches the walk level less the lift, on every ramp sample away from the ends
    let checked = 0;
    for (let i = 3; i < r.samples.length - 3; i += 1) {
      if (r.flights.some((fl) => i >= fl.from - 2 && i <= fl.to + 2)) continue; // a stair stands on the ramp below its treads
      checked++;
      const [x, y, z] = r.samples[i]!;
      expect(Math.abs(field.height(x, z) - (y - RIBBON_LIFT))).toBeLessThan(0.05);
    }
    expect(checked).toBeGreaterThan(3);
    const [mx, , mz] = r.samples[Math.floor(r.samples.length / 2)]!;
    const doc = voxelChunkDoc(field, "w", Math.floor(mx / 48), Math.floor(mz / 48), { water: false, scatter: false });
    const ent = Object.values(doc.entities).find((e) => e.tags?.includes("ribbon"));
    expect(ent).toBeDefined();
    expect((ent!.components.collider as { shape: string }).shape).toBe("trimesh");
    expect((ent!.components.mesh as { source: { kind: string } }).source.kind).toBe("surface");
  });
});

describe("ribbon look", () => {
  const doc = (pts: [number, number][], extra: Partial<RibbonDoc> = {}): RibbonDoc => {
    const c = centripetalCatmullRom(pts, 1);
    return { id: "look", width: 2.4, style: "dirt", edge: "verge", seed: 7, samples: c.x.map((x, i) => [x, 10, c.z[i]!, 3.5, 3.5] as [number, number, number, number, number]), flights: [], switchbacks: 0, pieces: [], cuts: [], warnings: [], ...extra };
  };
  const verts = (m: ReturnType<typeof ribbonMesh>) => Array.from({ length: m.positions.length / 3 }, (_, v) => ({ x: m.positions[v * 3]!, z: m.positions[v * 3 + 2]!, a: m.colors[v * 4 + 3]! }));

  it("tapers, rounds and fades both ends (no square end)", () => {
    const r = doc([[0, 0], [40, 0]]);
    const m = ribbonMesh(r, -100, -100, 100, 100, 4);
    expect(m.colors.length).toBe((m.positions.length / 3) * 4);
    const V = verts(m).map((v) => ({ ...v, x: v.x - 100, z: v.z - 100 }));
    // a round cap reaches past the last sample
    const past = V.filter((v) => v.x > 40.05);
    expect(past.length).toBeGreaterThan(4);
    expect(Math.max(...past.map((v) => v.x))).toBeGreaterThan(40.5);
    // the end ring is narrower than the middle (taper) and fades
    const halfAt = (x0: number) => Math.max(...V.filter((v) => Math.abs(v.x - x0) < 0.01).map((v) => Math.abs(v.z)));
    expect(halfAt(40)).toBeLessThan(halfAt(20) * 0.75);
    const aAt = (x0: number) => Math.max(...V.filter((v) => Math.abs(v.x - x0) < 0.01).map((v) => v.a));
    expect(aAt(40)).toBeLessThan(aAt(20));
    // the fan rim fades to nothing
    expect(Math.max(...past.filter((v) => Math.hypot(v.x - 40, v.z) > 0.3).map((v) => v.a))).toBe(0);
  });

  it("wears a deterministic verge 0.3-0.6 m past the walk edge, faded to the ground", () => {
    const r = doc([[0, 0], [60, 0]]);
    const a = Array.from({ length: 60 }, (_, s) => ribbonVerge(r, s, 1));
    expect(JSON.stringify(Array.from({ length: 60 }, (_, s) => ribbonVerge(structuredClone(r), s, 1)))).toBe(JSON.stringify(a));
    const out = a.map((v) => v.outer - r.width / 2);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0.29);
    expect(Math.max(...out)).toBeLessThanOrEqual(0.61);
    expect(Math.max(...out) - Math.min(...out)).toBeGreaterThan(0.08); // it wanders
    expect(JSON.stringify(ribbonVerge({ ...r, seed: 8 }, 10, 1))).not.toBe(JSON.stringify(ribbonVerge(r, 10, 1)));
    expect(JSON.stringify(ribbonVerge(r, 10, -1))).not.toBe(JSON.stringify(ribbonVerge(r, 10, 1)));
    expect(ribbonVerge({ ...r, edge: "hard" }, 10, 1)).toEqual({ inner: 1.2, outer: 1.2 });
    // the outer verge vertices are alpha 0, the walk surface alpha 1
    const m = ribbonMesh(r, -100, -100, 100, 100, 4);
    const mid = verts(m).filter((v) => Math.abs(v.x - 130) < 0.01);
    expect(Math.min(...mid.map((v) => v.a))).toBe(0);
    expect(Math.max(...mid.map((v) => v.a))).toBe(1);
  });

  it("rounds a hairpin: no flipped or creased triangle, the turn resampled", () => {
    const r = doc([[0, 0], [20, 0], [23, 2.2], [20, 4.4], [0, 4.4]]);
    const m = ribbonMesh(r, -100, -100, 100, 100, 4);
    const P = m.positions;
    let n = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
      const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
      const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      expect(ny / (Math.hypot(nx, ny, nz) || 1)).toBeGreaterThan(0.5); // up, never a fold or a crease
      n++;
    }
    expect(n).toBeGreaterThan((r.samples.length - 1) * 8 + 40); // extra rings round the turn
  });

  it("cuts two ribbons laid end to end flush on the joint: one surface, no overlapping ends (z-fight)", () => {
    const A = { ...doc([[0, 0], [30, 0]]), id: "a" }, B = { ...doc([[30, 0], [55, 12]]), id: "b", seed: 3 };
    const joins = ribbonJoins([A, B]);
    expect(joins.get("a")?.end).toBeDefined();
    expect(joins.get("b")?.start).toBeDefined();
    expect(joins.get("a")!.end).toBeCloseTo(joins.get("b")!.start!, 6); // the same cross-section
    const tris = (m: ReturnType<typeof ribbonMesh>) => {
      const P = m.positions, out: [number, number][][] = [];
      for (let t = 0; t < m.indices.length; t += 3) out.push([0, 1, 2].map((q) => [P[m.indices[t + q]! * 3]!, P[m.indices[t + q]! * 3 + 2]!] as [number, number]));
      return out;
    };
    const inside = (p: [number, number], t: [number, number][]) => {
      const c = (a: [number, number], b: [number, number]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      const d1 = c(t[0]!, t[1]!), d2 = c(t[1]!, t[2]!), d3 = c(t[2]!, t[0]!);
      return (d1 > 1e-6 && d2 > 1e-6 && d3 > 1e-6) || (d1 < -1e-6 && d2 < -1e-6 && d3 < -1e-6);
    };
    const overlap = (ma: ReturnType<typeof ribbonMesh>, mb: ReturnType<typeof ribbonMesh>) => {
      const ta = tris(ma);
      return tris(mb).filter((t) => { const c: [number, number] = [(t[0]![0] + t[1]![0] + t[2]![0]) / 3, (t[0]![1] + t[1]![1] + t[2]![1]) / 3]; return ta.some((u) => inside(c, u)); }).length;
    };
    const free = [ribbonMesh(A, -100, -100, 100, 100, 4), ribbonMesh(B, -100, -100, 100, 100, 4)];
    expect(overlap(free[0]!, free[1]!)).toBeGreaterThan(0); // two rounded ends over each other: the z-fight
    const cut = [ribbonMesh(A, -100, -100, 100, 100, 4, undefined, joins.get("a")), ribbonMesh(B, -100, -100, 100, 100, 4, undefined, joins.get("b"))];
    expect(overlap(cut[0]!, cut[1]!)).toBe(0);
    // a junction (three ends on one point) keeps its round ends
    expect(ribbonJoins([A, B, { ...doc([[30, 0], [30, -20]]), id: "c" }]).size).toBe(0);
  });

  it("dresses wall pieces in the zone stone; kit keeps its own", () => {
    expect(wallSkinOverrides({ prefab: "retaining-wall/common-h150-straight-2", role: "straight-2" }, "red-cliff")).toEqual([{ path: "piece/components/mesh/material", value: "ribbon-wall/red-cliff-rubble" }]);
    expect(wallSkinOverrides({ prefab: "retaining-wall/common-cap-2", role: "cap" }, "red-cliff")[0]!.value).toBe("ribbon-wall/red-cliff-ashlar");
    expect(wallSkinOverrides({ prefab: "retaining-wall/common-h150-end-l", role: "end-l" }, "red-cliff").map((o) => o.path)).toContain("trim-ashlar/components/mesh/material");
    expect(wallSkinOverrides({ prefab: "retaining-wall/stone-h150-straight-2", role: "straight-2" }, null)).toEqual([]);
    const base = defaultWorldRecipe({ cellSize: 48 });
    const cliff = base.surfaces[0]!.name, ground = base.surfaces[1]!.name, road = base.surfaces[2]!.name;
    const recipe = { ...base, regions: [{ id: "red", name: "Red", polygon: [[-500, -500], [500, -500], [500, 500], [-500, 500]], tags: [], ground: { cliff, ground, road } }] } as never;
    const res = ribbonSurfaces(recipe);
    const walled = doc([[0, 0], [40, 0]], { pieces: [{ prefab: "retaining-wall/common-h150-straight-2", role: "straight-2", position: [0, 0, 0], yaw: 0 }] });
    expect(res.wallSkinOf!(walled)).toBe(cliff);
    expect(res.wallSkinOf!({ ...walled, wallSkin: "kit" })).toBeNull();
    // dirt is trodden earth: the zone's road tile (never the ground or grass it lies on), drawn by a --trodden material
    expect(res.surfaceOf(walled)).toBe(road);
    expect(res.troddenToward!(walled)).toBe(road);
    expect(ribbonMaterialId(res.surfaceOf(walled), res.troddenToward!(walled))).toBe(`ribbon/${road}--trodden`);
    const noRoad = ribbonSurfaces({ ...base, regions: [{ id: "red", name: "Red", polygon: [[-500, -500], [500, -500], [500, 500], [-500, 500]], tags: [], ground: { cliff, ground } }] } as never);
    expect(noRoad.surfaceOf(walled)).toBe(ground);
  });

  it("keeps wall faces clear of the walk on the inside of turns and off other legs", () => {
    const hw = 1.2, face = hw + 0.65;
    expect(wallFaceOffset(hw, face, 0)).toBe(face);
    expect(wallFaceOffset(hw, face, 1 / 8)).toBeGreaterThanOrEqual(hw + RIBBON_WALL_TURN_CLEAR + 36 / 64 - 1e-9); // R = 8 m
    expect(wallFaceOffset(hw, face, 1 / 2.5)).toBe(Infinity); // a hairpin's inside takes no wall
    // a switchback up a steep slope: every wall face stays clear of every centre sample of the path
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[-30, 0], [70, 0]], width: 2.4, maxGrade: 0.15, corridor: 14, wallDrop: 0.8 }), steep);
    const S = fit.ribbon.samples;
    for (const p of fit.ribbon.pieces) {
      if (p.role === "cap") continue;
      const rad = (p.yaw * Math.PI) / 180, ux = Math.cos(rad), uz = -Math.sin(rad);
      for (const t of [0, 1, 2]) {
        const fx = p.position[0] + ux * t, fz = p.position[2] + uz * t;
        expect(Math.min(...S.map((q) => Math.hypot(q[0] - fx, q[2] - fz)))).toBeGreaterThan(hw + 0.5);
      }
    }
  });

  it("never bridges a wall run across a turn too tight for a wall (the hairpin OOM): finite, bounded pieces", () => {
    // a kink whose inside curvature spikes for ONE sample: closing the 1-sample gap put a face at Infinity -> an
    // endless run of modules (hg-kelp-road-3 ran 4 GB out of memory)
    let calls = 0;
    const g = reader((_x, z) => { if (++calls > 2e5) throw new Error("runaway wall run"); return 40 - 0.5 * z; });
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[0, 0], [20, 0], [22.3, 1.93], [25.77, 21.62]], width: 3.4, wallDrop: 0.8, wallCut: 0.8 }), g);
    expect(fit.ribbon.pieces.length).toBeLessThan(fit.ribbon.samples.length * 2);
    for (const p of fit.ribbon.pieces) expect(p.position.every(Number.isFinite)).toBe(true);
    // a routed line with a corridor (switchback detour) over the same kinks finishes too
    const routed = fitRibbon(pathParamsSchema.parse({ points: [[0, 0], [20, 0], [22.3, 1.93], [25.77, 21.62], [27, 24], [10, 30]], width: 3.4, corridor: 8, wallDrop: 0.8, wallCut: 0.8 }), steep);
    expect(routed.ribbon.samples.every((s) => s.every(Number.isFinite))).toBe(true);
  });

  it("walls a high uphill cut too and steps every run down at its ends", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[0, 0], [40, 0]], width: 2.4 }), reader((_x, z) => 40 - 0.6 * z));
    const roles = fit.ribbon.pieces.map((p) => p.role);
    expect(fit.ribbon.samples.filter((s) => s[3] < 0).length).toBeGreaterThan(10); // the cut (uphill, -z = left) side
    expect(fit.ribbon.samples.filter((s) => s[4] < 0).length).toBeGreaterThan(10); // the fill side
    expect(roles.filter((r) => r === "end-l").length).toBe(roles.filter((r) => r === "end-r").length);
    expect(roles.filter((r) => r === "end-l").length).toBeGreaterThanOrEqual(2);
    expect(fit.ribbon.pieces.every((p) => p.prefab.endsWith(p.role === "cap" ? "cap-2" : p.role))).toBe(true);
  });
});

describe("grading patch raster (net-green 2026-10-20)", () => {
  it("gives every cell beside a weighted one a real height: the stepped foot's fan is inside the raster's reach", () => {
    const fit = fitRibbon(pathParamsSchema.parse({ points: [[-30, 0], [70, 0]], width: 2.4, steep: "steps" }), steep);
    expect(fit.ribbon.flights.length).toBeGreaterThan(0);
    const p = ribbonPatch({ id: "f", ...fit.ribbon } as RibbonDoc, 1);
    let bad = 0;
    for (let row = 1; row < p.rows - 1; row++) for (let col = 1; col < p.columns - 1; col++) {
      if (!(p.weights[row * p.columns + col]! > 0)) continue;
      for (const [a, b] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]] as const)
        if (p.heights[(row + b) * p.columns + col + a]! < 30) bad++; // the ground is >= 40: a 0 is a cell never given a height
    }
    expect(bad).toBe(0);
  });
});
