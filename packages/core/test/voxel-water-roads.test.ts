import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, voxelChunkDoc, worldRecipeSchema, type WorldRecipe } from "../src/index.js";
import { MIN_WATER_VOXELS, RIVER_FALL_MIN, RIVER_FREEBOARD, RIVER_RUN_GRADE, RIVER_WATER_REACH, SHORE_MAX_BUILD } from "../src/voxel/field.js";

/**
 * Where water and roads meet the carve — every case here was found by
 * walking the demo world and photographing what was wrong:
 *
 * - a row of triangular fins along every climbing trail (the per-segment
 *   value seam on the inside of each bend),
 * - a lake bed lifted above its own surface beside a road (the embankment
 *   band reaching into the water),
 * - a road that followed a river channel down and crossed under two metres
 *   of water (no ford),
 * - a river's water sheet stopping short of its banks (ribbon cut to the bed
 *   width, not the waterline).
 */

function recipe(overrides: Record<string, unknown> = {}): WorldRecipe {
  return worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24, ...overrides });
}

function noFeatures(): WorldRecipe["features"] {
  return { heightPatches: [], passages: [], rivers: [], canyons: [], ridges: [], roads: [], towns: [], lakes: [], bridges: [], fills: [], riverPaths: [], tunnels: [], blobs: [], pois: [], camps: [] };
}

const flatTerrain = { ...defaultWorldRecipe().terrain, base: 60 };
const bare = createWorldField(recipe({ terrain: flatTerrain }));

describe("the seam between two segments of one feature", () => {
  // a road climbing at 20 % that turns 90° at B: on the inside of the bend the
  // two legs are equally near along the bisector, and their interpolated
  // surface heights there differ by 0.28 m per metre out from the corner
  const bent = createWorldField(
    recipe({
      terrain: flatTerrain,
      features: {
        ...noFeatures(),
        roads: [
          {
            id: "climb",
            points: [[0, 0], [100, 0], [100, 100]],
            width: 6,
            shoulder: 4,
            smooth: 8,
            surfaceY: [60, 80, 100],
            leftY: [60, 80, 100],
            rightY: [60, 80, 100],
            flatten: 1,
            surface: "",
            surfaceEdge: 2.5,
          },
        ],
      },
    }),
  );

  it("has no vertical crack along the bisector on the inside of a bend", () => {
    // 14 m from the corner along the bisector, then across it in 0.25 m steps
    const d = 14;
    const bx = 100 - d * Math.SQRT1_2;
    const bz = d * Math.SQRT1_2;
    let worstStep = 0;
    let previous = NaN;
    for (let s = -4; s <= 4; s += 0.25) {
      const h = bent.height(bx + s * Math.SQRT1_2, bz + s * Math.SQRT1_2);
      if (!Number.isNaN(previous)) worstStep = Math.max(worstStep, Math.abs(h - previous));
      previous = h;
    }
    // the unblended seam was a ~4 m step here; a walkable bank is under 2:1
    expect(worstStep).toBeLessThan(0.5);
  });

  it("still puts the road at its own height on both legs", () => {
    expect(bent.height(50, 0)).toBeCloseTo(70, 1);
    expect(bent.height(100, 50)).toBeCloseTo(90, 1);
  });
});

describe("roads and towns yield to water", () => {
  const lakeside = createWorldField(
    recipe({
      terrain: flatTerrain,
      features: {
        ...noFeatures(),
        lakes: [
          { id: "mere", center: [0, 0], polygon: [[-100, -100], [100, -100], [100, 100], [-100, 100]], radius: 1, waterY: 50, depth: 5, bank: 15, tags: [] },
        ],
        // 8 m outside the shore, its 15 m embankment band reaching into the lake
        roads: [
          {
            id: "shore-road",
            points: [[-300, 108], [300, 108]],
            width: 6,
            shoulder: 4,
            smooth: 8,
            surfaceY: [58, 58],
            leftY: [58, 58],
            rightY: [58, 58],
            flatten: 1,
            surface: "",
            surfaceEdge: 2.5,
          },
        ],
        towns: [{ id: "port", center: [0, 130], radius: 20, falloff: 40, flatten: 1, groundY: 58, tags: [] }],
      },
    }),
  );

  it("keeps the lake bed under the surface inside the road's embankment band", () => {
    expect(lakeside.height(0, 96)).toBeLessThanOrEqual(50 - 0.6 + 1e-6);
    expect(lakeside.height(0, 92)).toBeLessThanOrEqual(50 - 0.6 + 1e-6);
  });

  it("keeps the roadway itself graded", () => {
    expect(lakeside.height(0, 108)).toBeCloseTo(58, 1);
  });

  it("does not let a town pad raise a lake either", () => {
    // the pad's falloff (radius 20 + 40) reaches z = 70, well inside the lake
    expect(lakeside.height(0, 85)).toBeLessThanOrEqual(50 - 0.6 + 1e-6);
  });
});

describe("a ford", () => {
  // river along x; the road is pinned just under the water it has where the
  // road crosses (what the paths stage does), whatever level the field solved
  const beck = { id: "beck", points: [[-400, 0], [400, 0]] as [number, number][], width: 8, depth: 3, bank: 10, bedY: [70, 50], water: true, surface: "", surfaceEdge: 3, taper: 0 };
  const riverOnly = createWorldField(recipe({ terrain: flatTerrain, features: { ...noFeatures(), rivers: [beck] } }));
  const fordY = riverOnly.waterY(0, 0)! - 0.4;
  const crossing = createWorldField(
    recipe({
      terrain: flatTerrain,
      features: {
        ...noFeatures(),
        rivers: [beck],
        roads: [
          {
            id: "ford-road",
            points: [[0, -200], [0, -30], [0, 30], [0, 200]],
            width: 6,
            shoulder: 4,
            smooth: 8,
            surfaceY: [bare.height(0, -200), fordY, fordY, bare.height(0, 200)],
            leftY: [bare.height(0, -200), fordY, fordY, bare.height(0, 200)],
            rightY: [bare.height(0, -200), fordY, fordY, bare.height(0, 200)],
            flatten: 1,
            surface: "",
            surfaceEdge: 2.5,
          },
        ],
      },
    }),
  );

  it("holds the roadway just under the water across the channel", () => {
    expect(crossing.height(0, 0)).toBeCloseTo(fordY, 1);
    // the road does not move the water
    expect(crossing.waterY(0, 0)).toBeCloseTo(fordY + 0.4, 5);
    expect(crossing.waterY(0, 0)!).toBeGreaterThan(crossing.height(0, 0));
  });

  it("drops the embankment band inside the channel so the road does not dam it", () => {
    // 12 m off the road's centreline, past the shoulder, still on the river's bed
    expect(crossing.height(12, 0)).toBeLessThan(fordY - 0.6);
    expect(crossing.height(-12, 0)).toBeLessThan(fordY - 0.6);
  });
});

describe("a river with per-point widths", () => {
  const tapered = createWorldField(
    recipe({
      terrain: flatTerrain,
      features: {
        ...noFeatures(),
        rivers: [
          {
            id: "broadening",
            points: [[-400, 0], [400, 0]],
            width: 24,
            widths: [24, 6],
            depth: 3,
            bank: 10,
            bedY: [70, 50],
            water: true,
            surface: "",
            surfaceEdge: 3,
            taper: 0,
          },
        ],
      },
    }),
  );

  it("carves wider where the width is wider", () => {
    // 9 m off the centreline: on the bed at the wide end, on the bank at the narrow end
    const wideCut = bare.height(-300, 9) - tapered.height(-300, 9);
    const narrowCut = bare.height(300, 9) - tapered.height(300, 9);
    // (the margin was a metre before the cut band became slope-limited; a
    // 7 m cut at the narrow end now eases over a wider band)
    expect(wideCut).toBeGreaterThan(narrowCut);
    // on the bed: at least the minimum water depth under the pool over it
    expect(tapered.height(-300, 9)).toBeLessThanOrEqual(67.5 + 0.05);
    expect(tapered.waterY(-300, 9)! - tapered.height(-300, 9)).toBeGreaterThanOrEqual(MIN_WATER_VOXELS * tapered.voxelSize - 0.05);
  });

  it("reports water out to the waterline on the bank, not just over the flat bed", () => {
    // wide end: half-width 10.9, bank 10 -> the surface meets the bank ~6 m past the bed's edge
    expect(tapered.waterY(-300, 14)).not.toBeNull();
    expect(tapered.waterY(-300, 30)).toBeNull();
  });
});

describe("a traced lake trusts the terrain (carve: false)", () => {
  const square: Array<[number, number]> = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
  const lakeOn = (base: number, carve: boolean) =>
    createWorldField(
      recipe({
        terrain: { ...flatTerrain, base },
        features: {
          ...noFeatures(),
          lakes: [{ id: "tarn", center: [0, 0], polygon: square, radius: 100, waterY: 50, depth: 6, bank: 16, carve, surface: "", shore: 8, tags: [] }],
        },
      }),
    );

  // the "flat" terrain still carries a few metres of noise, so every
  // expectation is against the same ground without the lake
  const groundOn = (base: number) => createWorldField(recipe({ terrain: { ...flatTerrain, base }, features: noFeatures() }));

  it("leaves ground that stands well above the surface alone, inside and outside the outline", () => {
    // the outline overshot onto a ~60 m hillside: no crater, no terrace
    const hill = lakeOn(60, false);
    const bare = groundOn(60);
    for (const x of [0, 60, 95, 104, 112]) expect(hill.height(x, 0)).toBeCloseTo(bare.height(x, 0), 3);
    // the hand-placed default still digs the basin outright
    const dug = lakeOn(60, true);
    expect(dug.height(0, 0)).toBeLessThan(50 - 6 + 0.01);
    expect(dug.height(108, 0)).toBeLessThan(bare.height(108, 0));
  });

  it("deepens ground that is under the surface into a bowl with no step at the outline", () => {
    // ground a few metres under the surface everywhere
    const shelf = lakeOn(42, false);
    const bare = groundOn(42);
    // at least 0.6 m of water right at the shore, the full depth two banks in
    expect(shelf.height(99, 0)).toBeLessThanOrEqual(50 - 0.6 + 0.05);
    expect(shelf.height(0, 0)).toBeCloseTo(Math.min(bare.height(0, 0), 50 - 0.6 - 6), 1);
    // and a slope, not a wall: no 0.5 m step in half a metre anywhere across the shore
    let previous = NaN;
    let worst = 0;
    for (let x = 80; x <= 106; x += 0.5) {
      const h = shelf.height(x, 0);
      if (!Number.isNaN(previous)) worst = Math.max(worst, Math.abs(h - previous));
      previous = h;
    }
    expect(worst).toBeLessThan(0.5);
    // Past the outline the shelf is metres under the lake's level. The rim
    // outside the sheet lifts it a hand at most (SHORE_MAX_BUILD) — never a
    // wall round the lake — and nothing inside the sheet is lifted at all.
    expect(shelf.height(110, 0)).toBeCloseTo(bare.height(110, 0), 3); // inside the sheet's reach: untouched
    expect(shelf.height(114, 0)).toBeGreaterThan(bare.height(114, 0) + 0.5); // just past it: the rim
    expect(shelf.height(114, 0)).toBeLessThanOrEqual(bare.height(114, 0) + SHORE_MAX_BUILD + 1e-6);
    expect(shelf.height(106, 0)).toBeLessThan(50);
    // and it reports as water a full bank out (the sheet is drawn that wide,
    // to cover the bank band an inlet's carve lowers), so nothing scatters onto it
    expect(shelf.waterY(106, 0)).toBe(50);
    expect(shelf.waterY(110, 0)).toBe(50);
    expect(shelf.waterY(114, 0)).toBeNull();
  });
});

/** Every water mesh of a chunk as world-space vertices, with its triangles. */
function waterOf(doc: ReturnType<typeof voxelChunkDoc>, cx: number, cz: number, size = 48) {
  const out: { entity: string; material: string | undefined; vertices: [number, number, number][]; uvs: number[]; indices: number[] }[] = [];
  for (const [id, entity] of Object.entries(doc.entities)) {
    // the surface clipped from the terrain; a fall's curtain is its own mesh
    if (!entity.tags?.includes("water") || entity.tags.includes("waterfall")) continue;
    const mesh = entity.components["mesh"] as { material?: string; source: { kind: string; positions: number[]; indices: number[]; uvs: number[] } };
    expect(mesh.source.kind).toBe("surface");
    const vertices: [number, number, number][] = [];
    for (let i = 0; i < mesh.source.positions.length; i += 3) {
      vertices.push([mesh.source.positions[i]! + cx * size, mesh.source.positions[i + 1]!, mesh.source.positions[i + 2]! + cz * size]);
    }
    out.push({ entity: id, material: mesh.material, vertices, uvs: mesh.source.uvs, indices: mesh.source.indices });
  }
  return out;
}

describe("the water in a chunk", () => {
  const watery = recipe({
    terrain: flatTerrain,
    waterMaterial: "terrain/test-water",
    features: {
      ...noFeatures(),
      rivers: [
        {
          id: "beck",
          points: [[-400, 20], [400, 20]],
          width: 12,
          widths: [12, 6],
          depth: 3,
          bank: 10,
          bedY: [70, 50],
          water: true,
          surface: "",
          surfaceEdge: 3,
          taper: 0,
        },
      ],
    },
  });
  const field = createWorldField(watery);
  const left = waterOf(voxelChunkDoc(field, "w", 0, 0, { scatter: false }), 0, 0);
  const right = waterOf(voxelChunkDoc(field, "w", 1, 0, { scatter: false }), 1, 0);

  it("is clipped from the terrain: it fills the bed and stops under the bank", () => {
    expect(left.length).toBe(1);
    const { vertices, indices } = left[0]!;
    expect(indices.length).toBeGreaterThan(0);
    // across the whole bed: from one side of the channel to the other
    const zs = vertices.map((v) => v[2]);
    expect(Math.min(...zs)).toBeLessThan(20 - 5);
    expect(Math.max(...zs)).toBeGreaterThan(20 + 5);
    // every shoreline vertex (on an edge used by one triangle, off the cell
    // border) is where the ground meets the water, a hand under the bank —
    // never in the air over lower ground
    const uses = new Map<string, number>();
    for (let k = 0; k < indices.length; k += 3) {
      for (let m = 0; m < 3; m++) {
        const a = indices[k + m]!;
        const b = indices[k + ((m + 1) % 3)]!;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }
    const shore = new Set<number>();
    for (const [key, n] of uses) if (n === 1) for (const v of key.split("_")) shore.add(Number(v));
    let checked = 0;
    const step = field.voxelSize;
    // the terrain is drawn from the lattice: compare against it, bilinear
    const drawn = (x: number, z: number): number => {
      const i = Math.floor(x / step);
      const j = Math.floor(z / step);
      const u = x / step - i;
      const v = z / step - j;
      const h = (a: number, b: number): number => field.height(a * step, b * step);
      return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
    };
    // (a waterfall's lip and sides pour over their edge: not a shore)
    const beckSolved = field.rivers[0]!;
    const fallXs: number[] = [];
    for (let k = 1; k < beckSolved.points.length; k++) {
      const len = Math.hypot(beckSolved.points[k]![0] - beckSolved.points[k - 1]![0], beckSolved.points[k]![1] - beckSolved.points[k - 1]![1]);
      if (len <= 3.5 && beckSolved.surfaceY![k - 1]! - beckSolved.surfaceY![k]! >= 1) fallXs.push(beckSolved.points[k]![0]);
    }
    for (const v of shore) {
      const [x, y, z] = vertices[v]!;
      if (x < 0.01 || x > 47.99 || z < 0.01 || z > 47.99) continue;
      if (fallXs.some((fx) => Math.abs(fx - x) < 13)) continue;
      expect(drawn(x, z)).toBeGreaterThan(y - 0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(4);
  });

  it("is level across the channel and meets its neighbour vertex for vertex at the seam", () => {
    // a pool is flat across: every vertex over one cross-section at one height
    const at = (x: number) => left[0]!.vertices.filter((v) => Math.abs(v[0] - x) < 1e-6).map((v) => v[1]);
    // (a cross-section through a rapid may lean a little where the carve's
    // seam blend mixes the two samples either side of it; a pool is exact)
    let level = 0;
    const sections = [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44];
    const lips = field.falls.map((f) => f.x);
    for (const x of sections) {
      if (lips.some((fx) => Math.abs(fx - x) < 6)) continue;
      const ys = at(x);
      expect(ys.length).toBeGreaterThan(2);
      const tilt = Math.max(...ys) - Math.min(...ys);
      expect(tilt).toBeLessThan(0.5);
      if (tilt < 0.05) level++;
    }
    // (this beck is written ABOVE noisy flat ground, so its pools follow a
    // bank cap and are short — still, whole sections stand level)
    expect(level).toBeGreaterThanOrEqual(2);
    // the seam at x = 48: the same vertices from both cells
    const seam = (cells: typeof left) =>
      cells
        .flatMap((m) => m.vertices)
        .filter((v) => Math.abs(v[0] - 48) < 1e-6)
        .map((v) => `${v[1].toFixed(2)},${v[2].toFixed(2)}`)
        .sort();
    expect(seam(left).length).toBeGreaterThan(2);
    expect(seam(left)).toEqual(seam(right));
  });

  it("carries the current downstream in uv, and only ever steps down", () => {
    const { uvs } = left[0]!;
    for (let i = 0; i < uvs.length; i += 2) expect(uvs[i]!).toBeGreaterThan(0);
    const beck = field.rivers[0]!;
    expect(beck.surfaceY!.length).toBe(beck.points.length);
    for (let k = 1; k < beck.surfaceY!.length; k++) {
      const fall = beck.surfaceY![k - 1]! - beck.surfaceY![k]!;
      expect(fall).toBeGreaterThanOrEqual(0);
    }
    // and the channel holds level pools, not a tilted sheet: most samples do not fall at all
    const still = beck.surfaceY!.filter((y, k) => k > 0 && y === beck.surfaceY![k - 1]).length;
    expect(still).toBeGreaterThan(beck.surfaceY!.length / 2);
    // and never brims: every level stands the freeboard under the land beside it
    const bareField = createWorldField(recipe({ terrain: flatTerrain }));
    beck.points.forEach(([x, z], k) => {
      const bank = Math.min(bareField.height(x, z + 13), bareField.height(x, z - 13), bareField.height(x, z));
      // (the cap is smoothed along the river, never more than half a metre over the bank)
      expect(beck.surfaceY![k]!).toBeLessThanOrEqual(bank - RIVER_FREEBOARD + 0.55);
    });
  });
});

describe("rivers first: a river builds its floor as well as cutting it", () => {
  // flat ground at 60; a river whose bed runs ABOVE it (a channel crossing a
  // hollow the drainage fill raised) and one whose bed runs below
  const raised = createWorldField(
    recipe({
      terrain: flatTerrain,
      features: {
        ...noFeatures(),
        rivers: [
          {
            id: "perched",
            points: [[-300, 0], [300, 0]],
            width: 10,
            depth: 3,
            bank: 10,
            bedY: [64, 64],
            water: true,
            surface: "",
            surfaceEdge: 3,
            taper: 0,
          },
        ],
      },
    }),
  );

  it("cuts a bed that runs above the ground DOWN under its banks, and leaves the land beyond alone", () => {
    // A bed written above the ground used to be built up to, and the water
    // then brimmed at the top of a levee. Now the water may not stand over
    // the lower bank less the freeboard, and the bed is cut the minimum
    // water depth under that.
    const water = raised.waterY(0, 0)!;
    expect(water).toBeLessThanOrEqual(raised.naturalHeight(0, 14) - RIVER_FREEBOARD + 0.3);
    expect(raised.height(0, 0)).toBeCloseTo(water - MIN_WATER_VOXELS * raised.voxelSize, 1);
    expect(raised.height(0, 3)).toBeCloseTo(water - MIN_WATER_VOXELS * raised.voxelSize, 1);
    expect(raised.height(0, 40)).toBeCloseTo(raised.naturalHeight(0, 40), 1);
  });

  it("never builds a sill where a tributary joins a deeper river", () => {
    const meet = createWorldField(
      recipe({
        terrain: flatTerrain,
        features: {
          ...noFeatures(),
          rivers: [
            {
              id: "main",
              points: [[-300, 0], [300, 0]],
              width: 16,
              depth: 4,
              bank: 12,
              bedY: [50, 50],
              water: true,
              surface: "",
              surfaceEdge: 3,
              taper: 0,
            },
            {
              id: "trib",
              points: [[0, 200], [0, 0]],
              width: 6,
              depth: 2,
              bank: 6,
              bedY: [58, 55],
              water: true,
              surface: "",
              surfaceEdge: 3,
              taper: 0,
            },
          ],
        },
      }),
    );
    // on the main channel's centreline, right where the tributary arrives, the
    // floor is the MAIN bed: the higher tributary bed does not win
    expect(meet.height(0, 0)).toBeLessThan(50.5);
    expect(meet.height(0, -2)).toBeLessThan(50.5);
  });

  it("does not build across a lake", () => {
    const through = createWorldField(
      recipe({
        terrain: flatTerrain,
        features: {
          ...noFeatures(),
          lakes: [
            {
              id: "tarn",
              center: [0, 0],
              radius: 80,
              waterY: 58,
              depth: 8,
              bank: 12,
              carve: true,
              surface: "",
              shore: 4,
              tags: [],
            },
          ],
          rivers: [
            {
              id: "inlet",
              points: [[-300, 0], [300, 0]],
              width: 8,
              depth: 2,
              bank: 8,
              bedY: [56, 56],
              water: true,
              surface: "",
              surfaceEdge: 3,
              taper: 0,
            },
          ],
        },
      }),
    );
    // the lake bed (about 50 in the middle) is not lifted to the river bed at 56
    expect(through.height(0, 0)).toBeLessThan(52);
    // while outside the lake the channel runs on no higher than the lake it
    // left, under its banks, over a bed cut the minimum water depth under it
    const water = through.waterY(200, 0)!;
    expect(water).toBeLessThanOrEqual(58 + 1e-6);
    expect(water).toBeLessThanOrEqual(through.naturalHeight(200, 12) - RIVER_FREEBOARD + 0.3);
    expect(through.height(200, 0)).toBeCloseTo(water - MIN_WATER_VOXELS * through.voxelSize, 1);
  });
});

describe("a filled hollow", () => {
  const square: [number, number][] = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
  const filled = createWorldField(
    recipe({
      terrain: flatTerrain,
      features: { ...noFeatures(), fills: [{ id: "flat", polygon: square, y: 70, bank: 12, tags: [] }] },
    }),
  );
  it("raises the ground to its level inside and eases out over the bank", () => {
    expect(filled.height(0, 0)).toBeCloseTo(70, 1);
    expect(filled.height(99, 0)).toBeCloseTo(70, 1);
    const mid = filled.height(106, 0);
    expect(mid).toBeGreaterThan(61);
    expect(mid).toBeLessThan(69);
    expect(filled.height(130, 0)).toBeCloseTo(filled.naturalHeight(130, 0), 1);
  });
  it("never lowers ground that already stands above it", () => {
    const tall = createWorldField(
      recipe({
        terrain: { ...flatTerrain, base: 80 },
        features: { ...noFeatures(), fills: [{ id: "flat", polygon: square, y: 70, bank: 12, tags: [] }] },
      }),
    );
    expect(tall.height(0, 0)).toBeCloseTo(tall.naturalHeight(0, 0), 1);
  });
});

describe("a bridge in a chunk", () => {
  const bridged = recipe({
    terrain: flatTerrain,
    waterMaterial: "terrain/test-water",
    bridgeMaterial: "terrain/test-timber",
    features: {
      ...noFeatures(),
      rivers: [
        {
          id: "river",
          points: [[24, -300], [24, 300]],
          width: 14,
          depth: 4,
          bank: 12,
          bedY: [54, 52],
          water: true,
          surface: "",
          surfaceEdge: 3,
          taper: 0,
        },
      ],
      roads: [
        {
          id: "west",
          points: [[-100, 24], [0, 24]],
          width: 6,
          shoulder: 4,
          smooth: 8,
          surfaceY: [60, 60],
          leftY: [60, 60],
          rightY: [60, 60],
          flatten: 1,
          surface: "",
          surfaceEdge: 2.5,
        },
      ],
      bridges: [{ id: "span", points: [[0, 24], [48, 24]], width: 6, deckY: 60, thickness: 0.6, river: "river", waterY: 56, tags: [] }],
    },
  });
  const field = createWorldField(bridged);

  it("emits a walkable deck and piers, clipped to the cell like the water", () => {
    const left = voxelChunkDoc(field, "w", 0, 0, { scatter: false });
    const decks = Object.values(left.entities).filter((e) => e.tags?.includes("deck"));
    expect(decks.length).toBe(1);
    const deck = decks[0]!.components as {
      mesh: { source: { kind: string; thickness: number; width: number; points: number[][] } };
      collider: { shape: string };
    };
    expect(deck.mesh.source.kind).toBe("path");
    expect(deck.mesh.source.thickness).toBeCloseTo(0.6, 6);
    expect(deck.mesh.source.width).toBe(6);
    expect(deck.collider.shape).toBe("trimesh");
    // the curve is the underside at deckY - thickness; the slab rises to deckY
    for (const p of deck.mesh.source.points) expect(p[1]).toBeCloseTo(59.4, 6);
    // a 48 m span stands on piers in the water, their tops in the deck
    const piers = Object.values(left.entities).filter((e) => e.tags?.includes("pier"));
    expect(piers.length).toBeGreaterThan(2);
    for (const pier of piers) {
      const c = pier.components as {
        transform: { position: number[] };
        mesh: { source: { size: number[] } };
        collider: { shape: string; size: number[] };
      };
      const top = c.transform.position[1]! + c.mesh.source.size[1]! / 2;
      expect(top).toBeGreaterThan(59.3);
      expect(top).toBeLessThan(59.6);
      expect(c.collider.shape).toBe("box");
    }
  });

  it("leaves the water running under the deck", () => {
    expect(field.waterY(24, 24)).not.toBeNull();
    expect(field.height(24, 24)).toBeLessThan(56);
  });
});

describe("a river running through a lake", () => {
  const through = recipe({
    terrain: flatTerrain,
    waterMaterial: "terrain/test-water",
    features: {
      ...noFeatures(),
      lakes: [
        {
          id: "mere",
          center: [24, 24],
          polygon: [[-20, -20], [68, -20], [68, 68], [-20, 68]],
          radius: 44,
          waterY: 57,
          depth: 6,
          bank: 8,
          carve: true,
          surface: "",
          shore: 4,
          tags: [],
        },
      ],
      rivers: [
        {
          id: "brook",
          points: [[-400, 24], [-100, 24], [-40, 24], [24, 24], [90, 24], [200, 24], [400, 24]],
          width: 8,
          depth: 2,
          bank: 8,
          bedY: [60, 58, 56, 55.5, 55, 54, 52],
          water: true,
          surface: "",
          surfaceEdge: 3,
          taper: 0,
        },
      ],
    },
  });
  const field = createWorldField(through);

  it("is one water surface with the lake: flush inside it, never a second sheet over it", () => {
    const cxs = [-2, -1, 0, 1, 2];
    const cells = cxs.map((cx) => waterOf(voxelChunkDoc(field, "w", cx, 0, { scatter: false }), cx, 0));
    // one material here (the river falls back to the lake's), so ONE mesh per cell
    for (const cell of cells) expect(cell.length).toBeLessThanOrEqual(1);
    // inside the lake's reach (the outline -20..68 plus most of a bank) the
    // water is the lake's level, wherever the river runs
    const lakeCell = cells[2]![0]!;
    for (const [x, y, z] of lakeCell.vertices) {
      if (x > -20 && x < 68 && z > -20 && z < 68) expect(y).toBeCloseTo(57, 5);
    }
    // the river has water on both sides of the lake: entering at or above
    // the lake's level, leaving at or below it
    const west = cells[1]![0]!.vertices.filter((v) => v[0] < -30);
    const east = cells[3]![0]!.vertices.filter((v) => v[0] > 80);
    expect(west.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);
    // (a hair under it where the bank cap stands below the lake on this flat test ground)
    for (const v of west) expect(v[1]).toBeGreaterThanOrEqual(57 - 0.3);
    for (const v of east) expect(v[1]).toBeLessThanOrEqual(57 + 1e-6);
  });
});

describe("a steep river", () => {
  // a bed written falling 10 % across flat ground: far steeper than a river runs
  const field = createWorldField(
    recipe({
      terrain: flatTerrain,
      features: {
        ...noFeatures(),
        rivers: [{ id: "torrent", points: [[-400, 0], [400, 0]], width: 8, depth: 3, bank: 10, bedY: [58, -20], water: true, surface: "", surfaceEdge: 3, taper: 0 }],
      },
    }),
  );
  const r = field.rivers[0]!;

  it("runs gently and keeps ONE waterfall, over a short lip, at its sharpest drop", () => {
    let falls = 0;
    for (let k = 1; k < r.points.length; k++) {
      const len = Math.hypot(r.points[k]![0] - r.points[k - 1]![0], r.points[k]![1] - r.points[k - 1]![1]);
      const drop = r.surfaceY![k - 1]! - r.surfaceY![k]!;
      expect(drop).toBeGreaterThanOrEqual(-1e-6);
      if (len <= 3.5) {
        // a lip: the whole fall over three metres
        if (drop > 0.5) {
          falls++;
          expect(drop).toBeGreaterThanOrEqual(RIVER_FALL_MIN - 1e-6);
        }
      } else if (r.surfaceY![k]! > 0.5) {
        // a run never falls faster than the run grade (the last reach to the sea excepted)
        expect(drop / len).toBeLessThanOrEqual(RIVER_RUN_GRADE + 0.02);
      }
    }
    expect(falls).toBeLessThanOrEqual(1);
  });
});

describe("a crafted fall site", () => {
  // a river written over a 30 m scarp-like drop in its bed: one solved fall
  const base = {
    terrain: flatTerrain,
    features: {
      ...noFeatures(),
      rivers: [{ id: "scarp", points: [[-400, 0], [-10, 0], [-2, 0], [400, 0]] as [number, number][], width: 8, depth: 3, bank: 10, bedY: [70, 70, 40, 39], water: true, surface: "", surfaceEdge: 3, taper: 0 }],
    },
  };
  const plain = createWorldField(recipe(base));
  const fall = plain.falls.find((f) => f.top - f.bottom > 20)!;

  it("splits the solved fall into tiers with level pools when a cascade site names it", () => {
    expect(fall).toBeDefined();
    const crafted = createWorldField(
      recipe({ ...base, features: { ...base.features, fallSites: [{ id: "s", at: [fall.x, fall.z], template: "cascade", tiers: [{ share: 1, pool: 16 }, { share: 1, pool: 16 }, { share: 1, pool: 16 }], rocks: [] }] } }),
    );
    const tiers = crafted.falls.filter((f) => Math.hypot(f.x - fall.x, f.z - fall.z) < 60);
    expect(tiers.length).toBe(3);
    for (const t of tiers) expect(t.top - t.bottom).toBeGreaterThan(5);
    // the same total drop, top to bottom
    const top = Math.max(...tiers.map((t) => t.top));
    const bottom = Math.min(...tiers.map((t) => t.bottom));
    expect(top).toBeCloseTo(fall.top, 1);
    expect(bottom).toBeLessThanOrEqual(fall.bottom + 0.5);
    // a middle pool holds water over raised ground (the ledge), not a gorge
    const mid = tiers.sort((a, b) => b.top - a.top)[1]!;
    const y = crafted.waterY(mid.x - mid.dirX * 8, mid.z - mid.dirZ * 8);
    expect(y).not.toBeNull();
    expect(y! - crafted.height(mid.x - mid.dirX * 8, mid.z - mid.dirZ * 8)).toBeLessThan(6);
  });

  it("fills each plunge bowl with its pool, out to where the bowl's ground rises out of it, and necks back to the channel at the lips", () => {
    const site = (bowl: number) =>
      createWorldField(
        recipe({ ...base, features: { ...base.features, fallSites: [{ id: "s", at: [fall.x, fall.z], template: "cascade", tiers: [{ share: 1, pool: 16 }, { share: 1, pool: 16 }, { share: 1, pool: 16 }], rocks: [], gorge: { bowl } }] } }),
      );
    const s = { y: 0, flowX: 0, flowZ: 0, kind: "river" as const, floor: 0 };
    // half-width of the pool's water (standing over the ground) across the flow at x (the river runs along +x on z = 0)
    const waterHalf = (field: ReturnType<typeof createWorldField>, x: number, level: number): number => {
      let edge = 0;
      for (let z = 0; z < 40; z += 0.25) {
        if (field.waterSurface(x, z, s) && Math.abs(s.y - level) < 0.5 && s.y > field.height(x, z)) edge = z;
        else if (z > 6) break;
      }
      return edge;
    };
    // the channel's own water: half the bed plus the bank's waterline
    const channel = 4 + Math.min(10, 0.7 * 8 + 3) * RIVER_WATER_REACH;
    const wide = site(2.5);
    const narrow = site(1);
    const tiers = wide.falls.filter((f) => Math.hypot(f.x - fall.x, f.z - fall.z) < 60).sort((a, b) => b.top - a.top);
    expect(tiers.length).toBe(3);
    for (const t of tiers) {
      const lip = t.x - t.dirX * 3;
      let widest = 0;
      let at = lip;
      let narrowWidest = 0;
      for (let r = 1; r < 16; r += 0.5) {
        const w = waterHalf(wide, lip + r, t.bottom);
        if (w > widest) [widest, at] = [w, lip + r];
        narrowWidest = Math.max(narrowWidest, waterHalf(narrow, lip + r, t.bottom));
      }
      // bowl 1 is the channel's own water; bowl 2.5 reads as a pool, well past it
      expect(narrowWidest).toBeLessThan(channel + 1);
      expect(widest).toBeGreaterThan(channel * 1.35);
      // ...and it is the bowl that holds it: just past the water's edge the ground stands over the pool
      expect(wide.height(at, widest + 1)).toBeGreaterThan(t.bottom);
      // at the lip the pool is the channel again (the curtain's span)
      expect(waterHalf(wide, lip + 1, t.bottom)).toBeLessThan(channel + 1);
    }
  });
});
