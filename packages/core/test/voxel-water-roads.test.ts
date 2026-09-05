import { describe, expect, it } from "vitest";
import { createWorldField, defaultWorldRecipe, voxelChunkDoc, worldRecipeSchema, type WorldRecipe } from "../src/index.js";

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
  return { rivers: [], canyons: [], roads: [], towns: [], lakes: [], bridges: [], fills: [], riverPaths: [], tunnels: [], blobs: [], pois: [] };
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
  // river along x with its bed at 60 and its water at 62.1 where the road crosses
  const crossing = createWorldField(
    recipe({
      terrain: flatTerrain,
      features: {
        ...noFeatures(),
        rivers: [
          { id: "beck", points: [[-400, 0], [400, 0]], width: 8, depth: 3, bank: 10, bedY: [70, 50], water: true, surface: "", surfaceEdge: 3, taper: 0 },
        ],
        roads: [
          {
            id: "ford-road",
            points: [[0, -200], [0, -30], [0, 30], [0, 200]],
            width: 6,
            shoulder: 4,
            smooth: 8,
            surfaceY: [bare.height(0, -200), 61.7, 61.7, bare.height(0, 200)],
            leftY: [bare.height(0, -200), 61.7, 61.7, bare.height(0, 200)],
            rightY: [bare.height(0, -200), 61.7, 61.7, bare.height(0, 200)],
            flatten: 1,
            surface: "",
            surfaceEdge: 2.5,
          },
        ],
      },
    }),
  );

  it("holds the roadway just under the water across the channel", () => {
    expect(crossing.height(0, 0)).toBeCloseTo(61.7, 1);
    expect(crossing.waterY(0, 0)).toBeCloseTo(62.1, 5);
    expect(crossing.waterY(0, 0)!).toBeGreaterThan(crossing.height(0, 0));
  });

  it("drops the embankment band inside the channel so the road does not dam it", () => {
    // 12 m off the road's centreline, past the shoulder, still on the river's bed
    expect(crossing.height(12, 0)).toBeLessThan(61);
    expect(crossing.height(-12, 0)).toBeLessThan(61);
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
    expect(tapered.height(-300, 9)).toBeCloseTo(67.5, 0);
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
    for (let x = 80; x <= 120; x += 0.5) {
      const h = shelf.height(x, 0);
      if (!Number.isNaN(previous)) worst = Math.max(worst, Math.abs(h - previous));
      previous = h;
    }
    expect(worst).toBeLessThan(0.5);
    // outside the outline the shelf is untouched (the sheet covers it)
    expect(shelf.height(110, 0)).toBeCloseTo(bare.height(110, 0), 3);
    // and it reports as water a full bank out (the sheet is drawn that wide,
    // to cover the bank band an inlet's carve lowers), so nothing scatters onto it
    expect(shelf.waterY(106, 0)).toBe(50);
    expect(shelf.waterY(110, 0)).toBe(50);
    expect(shelf.waterY(114, 0)).toBeNull();
  });
});

describe("the water ribbon in a chunk", () => {
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

  it("is cut to the waterline with a width per point, continuous across the cell seam", () => {
    const left = voxelChunkDoc(field, "w", 0, 0, { scatter: false });
    const right = voxelChunkDoc(field, "w", 1, 0, { scatter: false });
    interface Ribbon {
      points: number[][];
      width: number;
      widths: number[];
      trim: [number, number];
      uvAlong: number[];
      uvMetres: boolean;
      flowSpeed: number;
    }
    const ribbonOf = (doc: typeof left): Ribbon => {
      const entity = Object.values(doc.entities).find((e) => e.tags?.includes("river"));
      expect(entity).toBeDefined();
      return (entity!.components["mesh"] as { source: Ribbon }).source;
    };
    const a = ribbonOf(left);
    const b = ribbonOf(right);
    expect(a.widths.length).toBe(a.points.length);
    expect(a.uvAlong.length).toBe(a.points.length);
    expect(a.width).toBe(Math.max(...a.widths));
    // wider than the bed: bed (12 at x=-400 tapering to 6) plus 1.3 × the LOCAL
    // bank (min(bank, 0.7 × width + 3): a narrow reach gets narrow banks)
    // ... times 0.75: the ribbon ends inside the levee the field builds at 0.85 of the bank
    for (const w of a.widths) expect(w).toBeGreaterThan(6 + Math.min(10, 0.7 * 6 + 3) * 0.75 - 1e-6);
    // each piece carries the control point beyond each of its ends as an
    // undrawn phantom neighbour, so the pieces share a tangent at the seam
    expect(a.trim).toEqual([1, 1]);
    expect(b.trim).toEqual([1, 1]);
    // the seam: the left cell's last DRAWN point is the right cell's first —
    // same place (cell-local, 48 m apart), same width, same distance along
    const aEnd = a.points.length - 1 - a.trim[1];
    const bStart = b.trim[0];
    expect(a.points[aEnd]![0]).toBeCloseTo(b.points[bStart]![0]! + 48, 6);
    expect(a.points[aEnd]![1]).toBeCloseTo(b.points[bStart]![1]!, 6);
    expect(a.widths[aEnd]).toBeCloseTo(b.widths[bStart]!, 6);
    expect(a.uvAlong[aEnd]).toBeCloseTo(b.uvAlong[bStart]!, 6);
    // and the channel narrows downstream
    expect(a.widths[a.trim[0]]!).toBeGreaterThan(b.widths[b.widths.length - 1 - b.trim[1]]!);
    // moving water: a current and metre uvs for the channel water shader
    expect(a.flowSpeed).toBeGreaterThan(0);
    expect(a.uvMetres).toBe(true);
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

  it("raises the ground to the bed inside the channel and leaves it alone beyond the bank", () => {
    expect(raised.height(0, 0)).toBeCloseTo(64, 1);
    expect(raised.height(0, 3)).toBeCloseTo(64, 1);
    expect(raised.height(0, 40)).toBeCloseTo(raised.naturalHeight(0, 40), 1);
    // and the water sits on the floor it built, not in mid-air over a pit
    expect(raised.waterY(0, 0)).toBeCloseTo(64 + 3 * 0.7, 1);
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
    // while outside the lake the floor is built to 56 in the channel, cut below the 60 ground
    expect(through.height(200, 0)).toBeCloseTo(56, 1);
    expect(through.height(200, 0)).toBeLessThan(60);
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

  it("stops its ribbon at the shore instead of running under the sheet", () => {
    // the cell holding the lake, and the cells on each side of it
    const cells = [-2, -1, 0, 1, 2].map((cx) => voxelChunkDoc(field, "w", cx, 0, { scatter: false }));
    const ribbons = cells.flatMap((doc, k) =>
      Object.values(doc.entities)
        .filter((e) => e.tags?.includes("river"))
        .map((e) => ({
          cx: [-2, -1, 0, 1, 2][k]!,
          source: (e.components["mesh"] as { source: { points: number[][]; trim: [number, number] } }).source,
        })),
    );
    expect(ribbons.length).toBeGreaterThan(0);
    // no DRAWN ribbon point lies more than a few metres inside the sheet as
    // drawn (outline -20..68 plus half a bank = -24..72): the ribbon dives
    // under the edge and stops
    for (const { cx, source } of ribbons) {
      const drawn = source.points.slice(source.trim[0], source.points.length - source.trim[1]);
      for (const p of drawn) {
        const wx = p[0]! + cx * 48;
        expect(wx > -20 && wx < 68).toBe(false);
      }
    }
    // the river still has water on both sides of the lake
    const west = ribbons.filter((r) => r.cx < 0);
    const east = ribbons.filter((r) => r.cx > 0);
    expect(west.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);
    // and the lake sheet itself is emitted in the lake's cell
    expect(Object.values(cells[2]!.entities).some((e) => e.tags?.includes("lake"))).toBe(true);
  });
});
