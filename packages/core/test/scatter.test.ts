import { describe, expect, it } from "vitest";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  createScene,
  lintPlacement,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "../src/index.js";
import {
  pointInPolygon,
  polygonEdgeDistance,
  scatterOps,
  type ScatterEntry,
  type ScatterOptions,
} from "../src/scatter.js";

function registry(): ComponentRegistry {
  const r = new ComponentRegistry();
  registerCoreComponents(r);
  return r;
}

function box(name: string, pos: [number, number, number], size: [number, number, number]) {
  return {
    name,
    parent: null,
    tags: [],
    components: {
      transform: { position: pos },
      mesh: { source: { kind: "primitive", shape: "box", size } },
    },
  };
}

/** Floor slab (top at y=0.5) with four walls whose inner faces sit at ±4.5. */
function walledRoom(): { doc: SceneDoc; reg: ComponentRegistry } {
  const reg = registry();
  const ops: Op[] = [
    { op: "add-entity", id: "floor", entity: box("floor", [0, 0, 0], [12, 1, 12]) },
    { op: "add-entity", id: "wall-n", entity: box("wall-n", [0, 2, 4.75], [10, 3, 0.5]) },
    { op: "add-entity", id: "wall-s", entity: box("wall-s", [0, 2, -4.75], [10, 3, 0.5]) },
    { op: "add-entity", id: "wall-e", entity: box("wall-e", [4.75, 2, 0], [0.5, 3, 10]) },
    { op: "add-entity", id: "wall-w", entity: box("wall-w", [-4.75, 2, 0], [0.5, 3, 10]) },
  ];
  return { doc: applyOps(createScene("room"), ops, reg).doc, reg };
}

const REGION = {
  polygon: [
    [-4.3, -4.3],
    [4.3, -4.3],
    [4.3, 4.3],
    [-4.3, 4.3],
  ] as [number, number][],
  y: 0.5,
};

const crate: ScatterEntry = {
  entity: {
    name: "crate",
    parent: null,
    tags: [],
    components: {
      transform: {},
      mesh: { source: { kind: "primitive", shape: "box", size: [0.6, 0.6, 0.6] } },
    },
  },
  weight: 2,
  radius: 0.45,
};

const rock: ScatterEntry = {
  entity: {
    name: "rock",
    parent: null,
    tags: [],
    components: {
      transform: {},
      mesh: { source: { kind: "primitive", shape: "sphere", size: [0.5, 0.5, 0.5] } },
    },
  },
  weight: 1,
  radius: 0.35,
  placement: { rotJitter: "full", embed: [0.1, 0.3] },
};

describe("scatterOps", () => {
  it("places 20 props resting on the floor, inside the polygon, with non-overlapping claims", () => {
    const { doc, reg } = walledRoom();
    const result = scatterOps(doc, reg, { region: REGION, table: [crate, rock], count: 20, seed: 7 });

    expect(result.placed + result.dropped + result.report.unplaced).toBe(20);
    expect(result.placed).toBe(20); // full floor under the region: everything snaps
    expect(result.ops).toHaveLength(20);

    const next = applyOps(doc, result.ops, reg).doc;

    // every placement rests on real geometry: the placement linter finds nothing floating
    const floating = lintPlacement(next, reg).filter((f) => f.kind === "floating");
    expect(floating).toHaveLength(0);

    // polygon containment: nothing outside
    for (const p of result.report.placements) {
      expect(pointInPolygon(p.position[0], p.position[2], REGION.polygon)).toBe(true);
    }

    // claim discs never overlap
    const placements = result.report.placements;
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i]!;
        const b = placements[j]!;
        const dist = Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2]);
        expect(dist).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-6);
      }
    }

    // spawned entities carry the placement metadata that produced the solve
    for (const p of placements) {
      const entity = next.entities[p.id]!;
      expect(entity.tags).toContain("scatter");
      expect(entity.components["placement"]).toBeDefined();
      // settled below spawn height (region.y + 1) and above the floor slab bottom
      const t = entity.components["transform"] as { position: [number, number, number] };
      expect(t.position[1]).toBeLessThan(1.5);
      expect(t.position[1]).toBeGreaterThan(0.4);
    }
  });

  it("is deterministic: same inputs produce identical ops; a different seed differs", () => {
    const { doc, reg } = walledRoom();
    const options: ScatterOptions = { region: REGION, table: [crate, rock], count: 15, seed: 42, wallBias: 0.3 };
    const a = scatterOps(doc, reg, options);
    const b = scatterOps(doc, reg, options);
    expect(a.ops).toEqual(b.ops);
    expect(a.report).toEqual(b.report);

    const c = scatterOps(doc, reg, { ...options, seed: 43 });
    expect(JSON.stringify(c.ops)).not.toEqual(JSON.stringify(a.ops));
  });

  it("wallBias measurably shifts the distribution toward the polygon edge", () => {
    const { doc, reg } = walledRoom();
    const pebble: ScatterEntry = { ...rock, radius: 0.15, placement: undefined };
    const spread = scatterOps(doc, reg, { region: REGION, table: [pebble], count: 40, seed: 11, wallBias: 0 });
    const hugging = scatterOps(doc, reg, { region: REGION, table: [pebble], count: 40, seed: 11, wallBias: 0.85 });
    expect(spread.placed).toBeGreaterThan(30);
    expect(hugging.placed).toBeGreaterThan(30);

    const meanEdgeDist = (r: typeof spread): number => {
      const ds = r.report.placements.map((p) => polygonEdgeDistance(p.position[0], p.position[2], REGION.polygon));
      return ds.reduce((s, d) => s + d, 0) / ds.length;
    };
    const nearWallFraction = (r: typeof spread): number =>
      r.report.placements.filter((p) => polygonEdgeDistance(p.position[0], p.position[2], REGION.polygon) <= 1.5)
        .length / r.report.placements.length;

    expect(meanEdgeDist(hugging)).toBeLessThan(meanEdgeDist(spread));
    expect(nearWallFraction(hugging)).toBeGreaterThan(nearWallFraction(spread));
  });

  it("drops placements with no support instead of leaving them floating", () => {
    // floor covers only x in [-6, 0]; the region extends to x = 4
    const reg = registry();
    const doc = applyOps(
      createScene("half"),
      [{ op: "add-entity", id: "floor", entity: box("floor", [-3, 0, 0], [6, 1, 12]) }],
      reg,
    ).doc;
    const region = {
      polygon: [
        [-4, -4],
        [4, -4],
        [4, 4],
        [-4, 4],
      ] as [number, number][],
      y: 0.5,
    };
    const result = scatterOps(doc, reg, { region, table: [crate], count: 24, seed: 3 });
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.placed).toBeGreaterThan(0);
    expect(result.placed + result.dropped + result.report.unplaced).toBe(24);
    // everything kept actually stands over the floor
    for (const p of result.report.placements) expect(p.position[0]).toBeLessThanOrEqual(0);
    for (const d of result.report.dropped) expect(d.reason).toBe("no-support");
    // and the emitted batch is clean: applying it yields zero floating findings
    const next = applyOps(doc, result.ops, reg).doc;
    expect(lintPlacement(next, reg).filter((f) => f.kind === "floating")).toHaveLength(0);
  });

  it("scatters prefabs through the solver; a vignette's own placement metadata is preserved", () => {
    const { doc, reg } = walledRoom();
    const assets = new AssetLibrary();
    assets.addPrefab("barrel", {
      version: 1,
      name: "barrel",
      root: "root",
      entities: {
        root: {
          name: "barrel",
          parent: null,
          tags: [],
          components: {
            transform: {},
            mesh: { source: { kind: "primitive", shape: "cylinder", size: [0.6, 0.9, 0.6] } },
          },
        },
      },
      props: {},
    });
    // a vignette: prefab root carries richer placement metadata of its own
    assets.addPrefab("rubble-vignette", {
      version: 1,
      name: "rubble-vignette",
      root: "root",
      entities: {
        root: {
          name: "rubble",
          parent: null,
          tags: [],
          components: {
            transform: {},
            mesh: { source: { kind: "primitive", shape: "sphere", size: [0.8, 0.5, 0.8] } },
            placement: { snap: "ground", rotJitter: "full", embed: [0.2, 0.4] },
          },
        },
      },
      props: {},
    });

    const result = scatterOps(doc, reg, {
      region: REGION,
      table: [
        { prefabId: "barrel", weight: 1, radius: 0.4 },
        { prefabId: "rubble-vignette", weight: 1, radius: 0.5 },
      ],
      count: 10,
      seed: 9,
      assets,
    });
    expect(result.placed).toBe(10);

    const next = applyOps(doc, result.ops, reg).doc;
    expect(lintPlacement(next, reg, { assets }).filter((f) => f.kind === "floating")).toHaveLength(0);

    let sawVignette = false;
    for (const p of result.report.placements) {
      const entity = next.entities[p.id]!;
      const prefab = entity.components["prefab"] as { prefabId: string };
      if (prefab.prefabId === "rubble-vignette") {
        sawVignette = true;
        // scatter must NOT clobber the vignette root's own placement metadata
        expect(entity.components["placement"]).toBeUndefined();
      } else {
        expect(entity.components["placement"]).toMatchObject({ snap: "ground", rotJitter: "y" });
      }
    }
    expect(sawVignette).toBe(true);
  });

  it("derives count from density when count is omitted", () => {
    const { doc, reg } = walledRoom();
    const result = scatterOps(doc, reg, { region: REGION, table: [rock], density: 0.15, seed: 5 });
    // area = 8.6^2 = 73.96 -> round(0.15 * 73.96) = 11
    expect(result.report.requested).toBe(11);
    expect(result.report.area).toBeCloseTo(73.96, 5);
  });

  it("rejects a table row with both prefabId and entity, or neither", () => {
    const { doc, reg } = walledRoom();
    expect(() =>
      scatterOps(doc, reg, { region: REGION, table: [{ weight: 1, radius: 0.3 }], count: 1, seed: 1 }),
    ).toThrow(/exactly one/);
    expect(() =>
      scatterOps(doc, reg, {
        region: REGION,
        table: [{ prefabId: "x", entity: crate.entity, weight: 1, radius: 0.3 }],
        count: 1,
        seed: 1,
      }),
    ).toThrow(/exactly one/);
  });
});
