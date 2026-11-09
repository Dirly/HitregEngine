import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  compileOperator, fringeShelves, LANDMARK_MIN_VOXELS, landmarkOptions, ledgeLandmarkVolume, ledgesOperatorSchema, operatorParams, rockCover, solveLedges,
  type OperatorFieldReader,
} from "../src/index.js";

// These synchronous geometry cases can occupy a worker for over a minute
// together. Let Vitest receive its reporting acknowledgements between cases.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

/** Flat ground at 100 for x < 0, a 1.2-grade face rising to a plateau at 160 for x > 0: a cliff to dig into. */
const cliff: OperatorFieldReader = { height: (x) => 100 + Math.min(60, Math.max(0, 1.2 * x)), voxelSize: 2, seaLevel: 0, seed: 7 };
/** The same face topping out at 110: a low fin of rock, too thin to roof a 7 m bore with 6 m of cover. */
const thin: OperatorFieldReader = { height: (x) => 100 + Math.min(10, Math.max(0, 1.2 * x)), voxelSize: 2, seaLevel: 0, seed: 7 };
const flat: OperatorFieldReader = { height: () => 100, voxelSize: 2, seaLevel: 0, seed: 7 };
const cave = { id: "den", op: "cave", entry: [-1, 0], direction: [1, 0], length: 34, radius: 3.5, minCover: 6, chamber: 7 };

const refusal = (doc: Record<string, unknown>, reader: OperatorFieldReader) => {
  try { compileOperator(doc, reader); } catch (e) { return (e as Error).message; }
  return "";
};

describe("cave operator", () => {
  it("digs a flared, covered bore with a chamber into a face", () => {
    const { pieces, output } = compileOperator(cave, cliff);
    const ids = pieces.map((p) => `${p.kind}/${p.feature.id}`);
    expect(ids).toContain("tunnels/op:den:cave-bore");
    expect(ids).toContain("tunnels/op:den:mouth-flare");
    expect(ids).toContain("blobs/op:den:chamber");
    expect(ids.filter((i) => i.includes("mouth-notch")).length).toBeGreaterThanOrEqual(2);
    expect(output.report.minCover as number).toBeGreaterThanOrEqual(6);
    expect(output.report.coverSource).toBe("heightfield");
  });

  it("skins the chosen route: wall band over the floor band per bore step, plus the chamber; refuses an unknown surface", () => {
    const skinned = { ...cave, wall: "hive-wall", floor: "hive-floor" };
    const { pieces, output } = compileOperator(skinned, { ...cliff, surfaces: ["grass", "hive-wall", "hive-floor"] });
    const paints = pieces.filter((p) => p.kind === "groundPaints").map((p) => p.feature as any);
    expect(paints.some((p) => p.id === "op:den:skin-wall-chamber")).toBe(true);
    const walls = paints.filter((p) => p.surface === "hive-wall"), floors = paints.filter((p) => p.surface === "hive-floor");
    expect(walls.length).toBe(floors.length);
    for (const w of walls) { expect(w.faces).toBe(true); expect(w.height[0]).toBeGreaterThan(floors.find((q) => q.id === w.id.replace("wall", "floor")).height[0]); }
    // the ground over the bore (>= minCover over the roof) is above every band
    for (const p of paints) expect(p.height[1]).toBeLessThan(100 + 2 * 3.5 + 6 + 2 * 7 + 30);
    expect(output.report.minCover as number).toBeGreaterThanOrEqual(6);
    expect(refusal(skinned, { ...cliff, surfaces: ["grass"] })).toMatch(/not in this world's palette/);
  });

  it("leaves the mouth's open steps unskinned: no band reaches the surface as a box", () => {
    const { pieces } = compileOperator({ ...cave, wall: "hive-wall", floor: "hive-floor" }, { ...cliff, surfaces: ["hive-wall", "hive-floor"] });
    const paints = pieces.filter((p) => p.kind === "groundPaints").map((p) => p.feature as any).filter((p) => p.polygon);
    expect(paints.length).toBeGreaterThan(0);
    // every skinned step's band top (+ its 1.5 m fade) is under the ground at all of its quad's corners
    for (const p of paints) for (const [x] of p.polygon) expect(cliff.height(x, 0)).toBeGreaterThanOrEqual(p.height[1] + 1.5 - 1e-6);
    // the first steps (the flared mouth, on the open approach) carry no skin
    expect(paints.some((p) => p.id === "op:den:skin-wall-1")).toBe(false);
  });

  it("cave-link joins two points underground, cover-checked between its join ends; refuses thin rock and sub-6 m bores", () => {
    const link = { id: "loop", op: "cave-link", points: [[40, 110, -10], [48, 110, 0], [40, 110, 10]], radius: 4, minCover: 6, join: 4 };
    const { pieces, output } = compileOperator(link, cliff);
    expect(pieces.map((p) => `${p.kind}/${p.feature.id}`)).toContain("tunnels/op:loop:link-bore");
    expect(output.report.minCover as number).toBeGreaterThanOrEqual(6);
    expect(refusal({ ...link, points: [[2, 100, -10], [2, 100, 10]] }, cliff)).toMatch(/thin rock/);
    expect(refusal({ ...link, radius: 2 }, cliff)).toMatch(/6 m rule/);
  });

  it("keeps every piece at least 6 m in its smallest dimension", () => {
    for (const p of compileOperator(cave, cliff).pieces.filter((q) => q.kind !== "groundPaints")) {
      const f = p.feature as { radius: number; endRadius?: number };
      expect(Math.min(f.radius, f.endRadius ?? f.radius) * 2).toBeGreaterThanOrEqual(6);
    }
  });

  it("keeps the mouth flare above the sea when the mouth floor is above it and the ground outside is under it", () => {
    // a sheer face out of the sea: sea bed at -16 for x < 0, the face rising to 120 for x > 0; the cave floor at 2.6 (a landing)
    const seaCliff: OperatorFieldReader = { height: (x) => (x < 0 ? -16 : Math.min(120, -16 + 6 * x)), voxelSize: 2, seaLevel: 0, seed: 7 };
    const { pieces } = compileOperator({ ...cave, entry: [-1, 0], y: 2.6, chamber: undefined }, seaCliff);
    const flare = pieces.find((q) => q.feature.id === "op:den:mouth-flare")!.feature as unknown as { points: number[][]; radius: number };
    expect(flare.points[0]![1]! - flare.radius).toBeGreaterThanOrEqual(0);
  });
  it("is deterministic", () => {
    expect(JSON.stringify(compileOperator(cave, cliff).pieces)).toBe(JSON.stringify(compileOperator(cave, cliff).pieces));
  });

  it("refuses thin rock, a sub-6 m bore and ground with no face, saying why", () => {
    expect(refusal(cave, thin)).toMatch(/thin rock.*< minCover 6/);
    expect(refusal({ ...cave, radius: 2.5 }, cliff)).toMatch(/radius 2.5 m < 3 m.*6 m rule/);
    expect(refusal(cave, flat)).toMatch(/no slope or face/);
  });

  it("estimates cover from the heightfield and from the volume", () => {
    const src = { surface: () => 100, step: 2 };
    expect(rockCover(src, [0, 90, 0], 3, 20)).toBeCloseTo(7, 5);
    expect(rockCover({ ...src, density: (_x: number, y: number) => y - 100 }, [0, 90, 0], 3, 20)).toBeCloseTo(7, 5);
    // an overhang the heightfield cannot see: air in a pocket 5 m to the side
    const pocket = (x: number, y: number, z: number) => (Math.hypot(x - 5, y - 90, z) < 1 ? 1 : y - 100);
    expect(rockCover({ ...src, density: pocket }, [0, 90, 0], 3, 20)).toBeLessThanOrEqual(2);
    // the cave reads density when the reader has it
    const withDensity: OperatorFieldReader = { ...cliff, density: (x, y) => y - cliff.height(x, 0) };
    expect(compileOperator(cave, withDensity).output.report.coverSource).toBe("density");
  });

  it("hall is optional and default-off: caves without it compile byte-identical to before it existed", () => {
    const sha = (doc: Record<string, unknown>) => createHash("sha256").update(JSON.stringify(compileOperator(doc, { ...cliff, surfaces: ["hive-wall", "hive-floor"] }).pieces)).digest("hex");
    // hashes taken from the operator source before `hall` was added (o-sunwine2 2026-10-31)
    expect(sha(cave)).toBe("87132b18e82ad251a2d5a120e54bd32de7e5a240d2044f0401929e0461354aac");
    expect(sha({ id: "bore", op: "cave", entry: [-1, 0], direction: [1, 0.1], length: 40, radius: 4, minCover: 6, wall: "hive-wall", floor: "hive-floor" })).toBe("5b1d0063649e3a7649ae8c76abe5da8873665ef5793733b540c6a1d85ca959d5");
    // a chamber wins over a hall
    expect(sha({ ...cave, hall: { width: 20, length: 24 } })).toBe(sha(cave));
  });

  it("hall compiles a flat-floored elliptical passage on the bore-end floor, cover-checked and skinned", () => {
    const deep: OperatorFieldReader = { height: (x) => 100 + Math.min(90, Math.max(0, 1.2 * x)), voxelSize: 2, seaLevel: 0, seed: 7, surfaces: ["hive-wall", "hive-floor"] };
    const doc = { ...cave, chamber: undefined, hall: { width: 22, length: 28, height: 9, roofRise: 5 }, wall: "hive-wall", floor: "hive-floor" };
    const { pieces, output } = compileOperator(doc, deep);
    const hall = pieces.find((q) => q.kind === "passages")!.feature as Record<string, unknown>;
    expect(hall.id).toBe("op:den:hall");
    expect(hall).toMatchObject({ footprint: "ellipse", axis: "x", direction: 1, width: 22, length: 28, height: 9, roofRise: 5 });
    const end = output.report.end as number[], start = hall.start as number[];
    expect(start[1]).toBeCloseTo(end[1]!, 1); // the hall floor IS the bore-end floor (flat, no bowl)
    expect(end[0]! - start[0]!).toBeCloseTo(4, 0); // joins the bore 4 m before its end
    expect(pieces.some((q) => q.kind === "blobs" && String((q.feature as { id: string }).id).endsWith(":chamber"))).toBe(false);
    expect(pieces.some((q) => String((q.feature as { id: string }).id) === "op:den:skin-wall-hall")).toBe(true);
    expect(output.report.hall).toBeTruthy();
    // the cliff that roofs a plain bore is too thin for a 15.5 m vault: refused as thin rock, never cut through
    expect(refusal({ ...doc, wall: undefined, floor: undefined }, { ...cliff, height: (x) => 100 + Math.min(18, Math.max(0, 1.2 * x)) })).toMatch(/thin rock/);
  });

  it("flatFloor: a level bore floored by box passages per step, the hall on the same datum (o-sunwine5)", () => {
    const deep: OperatorFieldReader = { height: (x) => 100 + Math.min(90, Math.max(0, 1.2 * x)), voxelSize: 2, seaLevel: 0, seed: 7 };
    const doc = { id: "hold", op: "cave", entry: [-1, 0], direction: [1, 0.15], length: 36, radius: 5, minCover: 6, grade: 0.1, bend: 6, hall: { width: 22, length: 28, height: 10, roofRise: 5 }, flatFloor: true };
    const { pieces, output } = compileOperator(doc, deep);
    const pass = pieces.filter((q) => q.kind === "passages").map((q) => q.feature as Record<string, any>);
    const boxes = pass.filter((q) => String(q.id).startsWith("op:hold:bore-floor-")), hall = pass.find((q) => q.id === "op:hold:hall")!;
    const y0 = (output.report.entry as number[])[1]!;
    expect(output.report.grade).toBe(0); // the asked 0.1 climb is overridden: level
    expect(boxes.length).toBe(Math.ceil(36 / 6));
    for (const b of boxes) { expect(b.footprint).toBe("box"); expect(b.start[1]).toBeCloseTo(y0, 1); expect(b.width).toBeGreaterThanOrEqual(7); expect(b.height).toBe(6); }
    expect(hall.start[1]).toBeCloseTo(y0, 1); // no step down into the hall
    expect((output.report.end as number[])[1]).toBeCloseTo(y0, 1);
    expect(output.report.flatFloor).toMatchObject({ boxes: boxes.length });
    // the boxes cover the bore end to end along its axis
    const xs = boxes.map((b) => [b.start[0], b.start[0] + b.direction * b.length]).flat();
    expect(Math.min(...xs)).toBeLessThanOrEqual(-1 + 0.01);
    expect(Math.max(...xs)).toBeGreaterThan(-1 + 36 * 0.95);
  });
});

/** A steep 1.3-grade cliff band rising toward +x, flat below and above. */
const band: OperatorFieldReader = { height: (x) => 100 + 1.3 * Math.min(70, Math.max(-70, x)), voxelSize: 2, seaLevel: 0, seed: 7 };

/** Independent walk: flood the compiled ground over 2 m steps under 50 degrees, plus each cave link mouth-to-mouth. */
function reachAll(doc: Record<string, unknown>, reader: OperatorFieldReader, useLinks = true) {
  const { pieces, output } = compileOperator(doc, reader);
  const hp = pieces.find((p) => p.kind === "heightPatches")!.feature as { origin: [number, number]; columns: number; rows: number; size: [number, number]; heights: number[]; weights: number[] };
  const g = hp.size[0] / (hp.columns - 1), cols = hp.columns, rows = hp.rows;
  const Y = hp.heights.map((h, i) => {
    const x = hp.origin[0] + (i % cols) * g, z = hp.origin[1] + Math.floor(i / cols) * g;
    const H = reader.height(x, z);
    return H + hp.weights[i]! * (h - H);
  });
  const cell = (x: number, z: number) => Math.round((z - hp.origin[1]) / g) * cols + Math.round((x - hp.origin[0]) / g);
  const links = new Map<number, number[]>();
  for (const l of useLinks ? (output.report.caveLinks as { a: number[]; b: number[] }[]) : []) {
    const a = cell(l.a[0]!, l.a[2]!), b = cell(l.b[0]!, l.b[2]!);
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  }
  const anchors = output.report.shelfAnchors as number[][];
  const seen = new Uint8Array(Y.length), stack = [cell(anchors[0]![0]!, anchors[0]![1]!)];
  seen[stack[0]!] = 1;
  const maxStep = g * Math.tan((50 * Math.PI) / 180);
  while (stack.length) {
    const i = stack.pop()!, c = i % cols, r = Math.floor(i / cols);
    const next = [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1]
      .filter((j) => j >= 0 && Math.abs(Y[j]! - Y[i]!) <= maxStep);
    for (const j of [...next, ...(links.get(i) ?? [])]) if (!seen[j]) { seen[j] = 1; stack.push(j); }
  }
  return { anchors, reached: anchors.filter((a) => seen[cell(a[0]!, a[1]!)]).length, output, pieces };
}

describe("ledges operator", { timeout: 30_000 }, () => { // 2-4 s each alone: the default 5 s fails under a full-suite load
  // these checks walk the 2.5D height output; the landmark mode has its own block below
  const ledges = { id: "crag", op: "ledges", center: [0, 0], radius: 45, links: "cave", mode: "height" };

  it("links every ledge, through climbing caves where asked, and a walk reaches them all", () => {
    const { anchors, reached, output, pieces } = reachAll(ledges, band);
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    expect(output.report.unlinked).toEqual([]);
    expect((output.report.caveLinks as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(pieces.some((p) => p.kind === "tunnels" && String(p.feature.id).endsWith("-bore"))).toBe(true);
    expect(reached).toBe(anchors.length);
  });

  it("without links the risers alone do not connect the ledges (the walk check has teeth)", () => {
    const doc = { ...ledges, links: "ramp", rampGrade: 0.08, rampWidth: 16 };
    const { anchors, reached } = reachAll(doc, band);
    expect(reached).toBeLessThan(anchors.length);
  });

  it("is deterministic and keeps the 6 m rule on its links", () => {
    const a = compileOperator(ledges, band).pieces, b = compileOperator(ledges, band).pieces;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const p of a.filter((q) => q.kind !== "heightPatches")) expect((p.feature.radius as number) * 2).toBeGreaterThanOrEqual(6);
  });
  /** The compiled ground (patch over the reader) with every tunnel capsule and remove blob cut out — a hard-edged density. */
  const carved = (pieces: { kind: string; feature: Record<string, unknown> }[], reader: OperatorFieldReader) => {
    const hp = pieces.find((p) => p.kind === "heightPatches")!.feature as { origin: [number, number]; columns: number; rows: number; size: [number, number]; heights: number[]; weights: number[] };
    const g = hp.size[0] / (hp.columns - 1);
    const ground = (x: number, z: number) => {
      const c = Math.round((x - hp.origin[0]) / g), r = Math.round((z - hp.origin[1]) / g);
      const H = reader.height(x, z);
      if (c < 0 || r < 0 || c >= hp.columns || r >= hp.rows) return H;
      const i = r * hp.columns + c;
      return H + hp.weights[i]! * (hp.heights[i]! - H);
    };
    const tubes = pieces.filter((p) => p.kind === "tunnels").map((p) => p.feature as { points: number[][]; radius: number; endRadius?: number });
    const blobs = pieces.filter((p) => p.kind === "blobs").map((p) => p.feature as { center: number[]; radius: number; scaleX?: number; scaleZ?: number });
    const inTube = (q: number[]) => tubes.some((t) => t.points.slice(1).some((b, k) => {
      const a = t.points[k]!, last = t.points.length - 1;
      const ra = t.endRadius === undefined ? t.radius : t.radius + (t.endRadius - t.radius) * (k / last);
      const rb = t.endRadius === undefined ? t.radius : t.radius + (t.endRadius - t.radius) * ((k + 1) / last);
      const d = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], L = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2 || 1;
      const u = Math.max(0, Math.min(1, ((q[0]! - a[0]!) * d[0]! + (q[1]! - a[1]!) * d[1]! + (q[2]! - a[2]!) * d[2]!) / L));
      return Math.hypot(q[0]! - a[0]! - u * d[0]!, q[1]! - a[1]! - u * d[1]!, q[2]! - a[2]! - u * d[2]!) < ra + (rb - ra) * u;
    }));
    const inBlob = (q: number[]) => blobs.some((b) => Math.hypot((q[0]! - b.center[0]!) / (b.scaleX ?? 1), q[1]! - b.center[1]!, (q[2]! - b.center[2]!) / (b.scaleZ ?? 1)) < b.radius);
    return (x: number, y: number, z: number) => y < ground(x, z) && !inTube([x, y, z]) && !inBlob([x, y, z]);
  };

  it("keeps the floor of every cave link under 50 degrees from mouth to mouth (no pit or step at a mouth)", () => {
    const { pieces } = compileOperator(ledges, band);
    const solid = carved(pieces, band);
    const bores = pieces.filter((p) => p.kind === "tunnels" && String(p.feature.id).endsWith("-bore")).map((p) => p.feature as { points: number[][]; radius: number });
    expect(bores.length).toBeGreaterThanOrEqual(1);
    for (const t of bores) {
      let prev: number | null = null, worst = 0;
      for (let k = 1; k < t.points.length; k++) {
        const a = t.points[k - 1]!, b = t.points[k]!, steps = Math.ceil(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!));
        for (let s = 0; s < steps; s++) {
          const p = [0, 1, 2].map((j) => a[j]! + ((b[j]! - a[j]!) * s) / steps);
          let y = p[1]!;
          while (y > p[1]! - 14 && !solid(p[0]!, y, p[2]!)) y -= 0.25;
          if (prev !== null) worst = Math.max(worst, Math.abs(y - prev));
          prev = y;
        }
      }
      expect((Math.atan(worst) * 180) / Math.PI).toBeLessThan(50);
    }
  });

  /** Shelf components (full-weight cells grouped by nearest level) and the share of the face's width each spans. */
  const spans = (doc: Record<string, unknown>) => {
    const { pieces, output } = compileOperator(doc, band);
    const hp = pieces.find((p) => p.kind === "heightPatches")!.feature as { columns: number; rows: number; heights: number[]; weights: number[] };
    const levels = output.report.levels as number[], cols = hp.columns, rows = hp.rows;
    const L = hp.heights.map((y, i) => (hp.weights[i]! >= 0.999 ? levels.reduce((b, l) => (Math.abs(l - y) < Math.abs(b - y) ? l : b), levels[0]!) : NaN));
    const seen = new Uint8Array(L.length), out: number[] = [];
    // the face's width across the slope (the band runs along z): the widest column of full-weight ground
    let face = 1;
    for (let c = 0; c < cols; c++) { let z0 = Infinity, z1 = -Infinity; for (let r = 0; r < rows; r++) if (!Number.isNaN(L[r * cols + c]!)) { z0 = Math.min(z0, r); z1 = Math.max(z1, r); } if (z1 >= z0) face = Math.max(face, z1 - z0); }
    for (let s = 0; s < L.length; s++) {
      if (seen[s] || Number.isNaN(L[s]!)) continue;
      const st = [s];
      seen[s] = 1;
      let zmin = Infinity, zmax = -Infinity, cnt = 0;
      while (st.length) {
        const i = st.pop()!, c = i % cols, r = Math.floor(i / cols);
        zmin = Math.min(zmin, r); zmax = Math.max(zmax, r); cnt++;
        for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, r > 0 ? i - cols : -1, r < rows - 1 ? i + cols : -1]) if (j >= 0 && !seen[j] && L[j] === L[i]) { seen[j] = 1; st.push(j); }
      }
      if (cnt < 20) continue;
      out.push((zmax - zmin) / face);
    }
    return out;
  };

  it("staggers its ledges: they end, step and overlap across the face instead of one band spanning it", () => {
    // cave links: a ramp is cut along its shelf and splits that band's height on its own, which would hide the stagger
    const staggered = spans({ ...ledges, links: "cave" });
    expect(staggered.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...staggered)).toBeLessThan(0.9);
    // teeth: with the stagger off the plain contour bands run the whole width
    expect(Math.max(...spans({ ...ledges, links: "cave", staggerAmount: 0, pinch: 0 }))).toBeGreaterThanOrEqual(0.8);
  });

  it("can leave a ledge reachable ONLY through its cave (the caves matter)", () => {
    const withCaves = reachAll(ledges, band), without = reachAll(ledges, band, false);
    expect((withCaves.output.report.caveLinks as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(withCaves.reached).toBe(withCaves.anchors.length);
    expect(without.reached).toBeLessThan(without.anchors.length);
  });
});

describe("ledges landmark", () => {
  const doc = { id: "crag", op: "ledges", center: [0, 0], radius: 45, links: "cave", boulders: 6 };
  const build = () => {
    const p = ledgesOperatorSchema.parse(operatorParams(doc));
    return ledgeLandmarkVolume(solveLedges(p, band, { id: "crag" }).grid, landmarkOptions(p, band));
  };

  // four full ledge solves (~46 s alone on the dev box); 60 s timed out under a parallel full-suite run (t-triage 2026-11-03)
  it("compiles to one ground patch + one landmark piece, deterministically", { timeout: 180000 }, () => {
    const a = compileOperator(doc, band), b = compileOperator(doc, band);
    expect(a.pieces.map((p) => p.kind).sort()).toEqual(["heightPatches", "landmarks"]);
    expect(JSON.stringify(a.pieces)).toBe(JSON.stringify(b.pieces));
    expect(build().digest).toBe(build().digest);
  });

  it("stacks rock masses, never pillars or brows; every notch end joins its shelf; boulders low and wide", { timeout: 60000 }, () => {
    const lm = build();
    expect(lm.report.masses).toBeGreaterThanOrEqual(2);
    expect(lm.report.pillars).toBe(0);
    expect(lm.nodes.some((n) => n.op === "add" && (n.shape === "capsule" || n.shape === "cylinder"))).toBe(false);
    expect(lm.nodes.some((n) => n.id.startsWith("brow-"))).toBe(false);
    expect(lm.voxel * LANDMARK_MIN_VOXELS).toBeGreaterThan(0);
    expect(lm.report.unjoined).toBe(lm.unjoinedEnds.length);
    for (const n of lm.nodes.filter((n) => n.id.startsWith("boulder-"))) {
      expect(n.size[1]).toBeLessThanOrEqual(2.2);
      expect(Math.min(n.size[0], n.size[2])).toBeGreaterThan(n.size[1]);
    }
  });
});

describe("ledges fringe rule", () => {
  it("a shelf more than half in the fade band is hillside: flagged fringe, no anchor, not a reach target", () => {
    // comp 0: 4 cells, 3 full -> a shelf; comp 1: 4 cells, 1 full -> fringe; comp 2: 2 cells, 1 full (exactly half) -> a shelf
    const comp = Int32Array.from([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, -1]);
    const W = Float64Array.from([1, 1, 1, 0.6, 1, 0.9, 0.7, 0.5, 1, 0.8, 0]);
    expect(fringeShelves(comp, W, 3)).toEqual([false, true, false]);
  });
  it("the solve reports fringe shelves apart and anchors only the core ones; the landmark repairs every core shelf", () => {
    const p = ledgesOperatorSchema.parse({ id: "fr", op: "ledges", center: [40, 0], radius: 26, mode: "landmark", links: "cave" });
    const out = solveLedges(p, cliff, { id: "fr" });
    const rep = out.report as { fringe: { level: number; area: number }[]; shelfAnchors: number[][] };
    const g = out.grid, n = Math.max(...g.comp) + 1, fr = fringeShelves(g.comp, g.W, n);
    expect(rep.fringe.length).toBe(fr.filter(Boolean).length);
    expect(rep.shelfAnchors.length).toBe(fr.filter((f, k) => !f && g.comp.some((c, i) => c === k && g.W[i]! >= 0.999)).length);
    const lm = ledgeLandmarkVolume(g, landmarkOptions(p, cliff));
    expect(lm.report.fringe).toBe(rep.fringe.length);
    expect(lm.report.unreachable).toBe(0);
    expect(lm.repairs.length).toBe(lm.report.repairs);
  });
});
