import { describe, expect, it } from "vitest";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  createScene,
  lintPlacement,
  registerCoreComponents,
  snapPlacementOps,
  type Op,
  type SceneDoc,
} from "../src/index.js";

function registry(): ComponentRegistry {
  const r = new ComponentRegistry();
  registerCoreComponents(r);
  return r;
}

interface BoxOpts {
  parent?: string | null;
  placement?: Record<string, unknown>;
  components?: Record<string, unknown>;
}

function box(pos: [number, number, number], size: [number, number, number], opts: BoxOpts = {}) {
  return {
    name: "box",
    parent: opts.parent ?? null,
    tags: [],
    components: {
      transform: { position: pos },
      mesh: { source: { kind: "primitive", shape: "box", size } },
      ...(opts.placement ? { placement: opts.placement } : {}),
      ...(opts.components ?? {}),
    },
  };
}

function scene(entities: Record<string, ReturnType<typeof box>>): { doc: SceneDoc; reg: ComponentRegistry } {
  const reg = registry();
  const ops: Op[] = Object.entries(entities).map(([id, entity]) => ({ op: "add-entity", id, entity }));
  return { doc: applyOps(createScene("s"), ops, reg).doc, reg };
}

const posOf = (doc: SceneDoc, id: string): [number, number, number] =>
  (doc.entities[id]!.components["transform"] as { position: [number, number, number] }).position;

describe("snapPlacementOps", () => {
  it("settles a prop onto the floor below, sunk by `sink`", () => {
    const { doc, reg } = scene({
      floor: box([0, 0, 0], [20, 1, 20]),
      prop: box([0, 5, 0], [1, 1, 1], { placement: {} }),
    });
    const { ops, results } = snapPlacementOps(doc, reg, ["prop"]);
    expect(results[0]!.action).toBe("snapped");
    expect(results[0]!.support).toBe("floor");
    const next = applyOps(doc, ops, reg).doc;
    // floor top 0.5 + half height 0.5 - sink 0.02
    expect(posOf(next, "prop")[1]).toBeCloseTo(0.98, 5);
    expect(posOf(next, "prop")[0]).toBeCloseTo(0, 5);
  });

  it("reports no-support and leaves the entity alone when nothing is below", () => {
    const { doc, reg } = scene({
      floor: box([0, 0, 0], [20, 1, 20]),
      prop: box([100, 5, 100], [1, 1, 1], { placement: {} }),
    });
    const { ops, results } = snapPlacementOps(doc, reg, ["prop"]);
    expect(ops).toHaveLength(0);
    expect(results[0]!.action).toBe("no-support");
  });

  it("hangs a ceiling prop against the slab above", () => {
    const { doc, reg } = scene({
      slab: box([0, 10, 0], [20, 1, 20]),
      lamp: box([0, 5, 0], [1, 1, 1], { placement: { snap: "ceiling" } }),
    });
    const { ops } = snapPlacementOps(doc, reg, ["lamp"]);
    const next = applyOps(doc, ops, reg).doc;
    // slab underside 9.5 - half height 0.5 + sink 0.02
    expect(posOf(next, "lamp")[1]).toBeCloseTo(9.02, 5);
  });

  it("backs a wall prop against the nearest wall and faces it into the room", () => {
    const { doc, reg } = scene({
      wall: box([5, 5, 0], [1, 10, 20]),
      sconce: box([0, 5, 0], [1, 1, 1], { placement: { snap: "wall" } }),
    });
    const { ops } = snapPlacementOps(doc, reg, ["sconce"]);
    const next = applyOps(doc, ops, reg).doc;
    const t = next.entities["sconce"]!.components["transform"] as {
      position: [number, number, number];
      rotation: [number, number, number, number];
    };
    // wall face at x=4.5, half depth 0.5, sink 0.02 -> center at 4.02
    expect(t.position[0]).toBeCloseTo(4.02, 4);
    expect(t.position[1]).toBeCloseTo(5, 5); // wall snap keeps authored height
    // +Z rotated onto the wall normal (-1,0,0): yaw -90deg
    expect(t.rotation[1]).toBeCloseTo(-Math.SQRT1_2, 4);
    expect(t.rotation[3]).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it("writes parent-local transforms for parented entities", () => {
    const reg = registry();
    const ops: Op[] = [
      { op: "add-entity", id: "floor", entity: box([0, 0, 0], [40, 1, 40]) },
      {
        op: "add-entity",
        id: "group",
        entity: { name: "group", parent: null, tags: [], components: { transform: { position: [10, 0, 0] } } },
      },
      { op: "add-entity", id: "prop", entity: box([0, 5, 0], [1, 1, 1], { parent: "group", placement: {} }) },
    ];
    const doc = applyOps(createScene("s"), ops, reg).doc;
    const snap = snapPlacementOps(doc, reg, ["prop"]);
    const next = applyOps(doc, snap.ops, reg).doc;
    expect(posOf(next, "prop")[0]).toBeCloseTo(0, 5); // still local to the group
    expect(posOf(next, "prop")[1]).toBeCloseTo(0.98, 5);
  });

  it("jitters deterministically per seed", () => {
    const make = () =>
      scene({
        floor: box([0, 0, 0], [20, 1, 20]),
        prop: box([0, 5, 0], [1, 1, 1], { placement: { rotJitter: "y", scaleJitter: [0.9, 1.1] } }),
      });
    const a = make();
    const one = snapPlacementOps(a.doc, a.reg, ["prop"], { seed: 7 });
    const two = snapPlacementOps(a.doc, a.reg, ["prop"], { seed: 7 });
    const three = snapPlacementOps(a.doc, a.reg, ["prop"], { seed: 8 });
    expect(JSON.stringify(one.ops)).toBe(JSON.stringify(two.ops));
    expect(JSON.stringify(one.ops)).not.toBe(JSON.stringify(three.ops));
    const data = (one.ops[0] as { data: { scale: number[] } }).data;
    expect(data.scale[0]).toBeGreaterThanOrEqual(0.9);
    expect(data.scale[0]).toBeLessThanOrEqual(1.1);
  });

  it("buries a fixed embed fraction of the entity's height", () => {
    const { doc, reg } = scene({
      floor: box([0, 0, 0], [20, 1, 20]),
      rock: box([0, 5, 0], [1, 1, 1], { placement: { embed: [0.3, 0.3] } }),
    });
    const { ops } = snapPlacementOps(doc, reg, ["rock"]);
    const next = applyOps(doc, ops, reg).doc;
    // floor top 0.5 + half height 0.5 - sink 0.02 - 30% of height 1
    expect(posOf(next, "rock")[1]).toBeCloseTo(0.68, 5);
  });

  it("draws embed from the range, seeded and bounded", () => {
    const make = () =>
      scene({
        floor: box([0, 0, 0], [20, 1, 20]),
        rock: box([0, 5, 0], [1, 1, 1], { placement: { embed: [0.1, 0.4] } }),
      });
    const a = make();
    const one = snapPlacementOps(a.doc, a.reg, ["rock"], { seed: 4 });
    const two = snapPlacementOps(a.doc, a.reg, ["rock"], { seed: 4 });
    expect(JSON.stringify(one.ops)).toBe(JSON.stringify(two.ops));
    const y = (one.ops[0] as { data: { position: number[] } }).data.position[1]!;
    // bottom sits between 10% and 40% (plus 2cm sink) below the floor top
    expect(y).toBeLessThanOrEqual(0.98 - 0.1);
    expect(y).toBeGreaterThanOrEqual(0.98 - 0.4);
  });

  it("requirePlacement skips entities without the component", () => {
    const { doc, reg } = scene({
      floor: box([0, 0, 0], [20, 1, 20]),
      prop: box([0, 5, 0], [1, 1, 1]),
    });
    const { ops, results } = snapPlacementOps(doc, reg, ["prop"], { requirePlacement: true });
    expect(ops).toHaveLength(0);
    expect(results[0]!.action).toBe("skipped-no-placement");
  });

  it("snaps a prefab instance whose root carries the placement component", () => {
    const reg = registry();
    const assets = new AssetLibrary();
    assets.addPrefab("kit/crate", {
      version: 1,
      name: "Crate",
      root: "root",
      entities: {
        root: {
          name: "Crate",
          parent: null,
          tags: [],
          components: {
            transform: {},
            mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } },
            placement: {},
          },
        },
      },
      props: {},
    });
    const ops: Op[] = [
      { op: "add-entity", id: "floor", entity: box([0, 0, 0], [20, 1, 20]) },
      {
        op: "add-entity",
        id: "crate1",
        entity: {
          name: "crate",
          parent: null,
          tags: [],
          components: { transform: { position: [2, 4, 3] }, prefab: { prefabId: "kit/crate" } },
        },
      },
    ];
    const doc = applyOps(createScene("s"), ops, reg).doc;
    const snap = snapPlacementOps(doc, reg, ["crate1"], { assets, requirePlacement: true });
    expect(snap.results[0]!.action).toBe("snapped");
    const next = applyOps(doc, snap.ops, reg).doc;
    expect(posOf(next, "crate1")[1]).toBeCloseTo(0.98, 5);
  });

  it("settles onto procedural heightmap terrain", () => {
    const reg = registry();
    const ops: Op[] = [
      {
        op: "add-entity",
        id: "terrain",
        entity: {
          name: "terrain",
          parent: null,
          tags: [],
          components: {
            transform: {},
            mesh: { source: { kind: "heightmap", size: [40, 40], amplitude: 0, resolution: 16, frequency: 0.08, seed: 1 } },
          },
        },
      },
      { op: "add-entity", id: "prop", entity: box([3, 5, -2], [1, 1, 1], { placement: {} }) },
    ];
    const doc = applyOps(createScene("s"), ops, reg).doc;
    const snap = snapPlacementOps(doc, reg, ["prop"]);
    const next = applyOps(doc, snap.ops, reg).doc;
    // flat (amplitude 0) terrain surface at y=0: 0 + 0.5 - 0.02
    expect(posOf(next, "prop")[1]).toBeCloseTo(0.48, 4);
  });
});

describe("lintPlacement", () => {
  it("flags a floating prop and passes a resting one", () => {
    const { doc, reg } = scene({
      floor: box([0, 0, 0], [20, 1, 20]),
      floating: box([0, 3, 0], [1, 1, 1]),
      resting: box([5, 0.98, 5], [1, 1, 1]),
    });
    const findings = lintPlacement(doc, reg);
    const floating = findings.filter((f) => f.kind === "floating");
    expect(floating).toHaveLength(1);
    expect(floating[0]!.entity).toBe("floating");
    expect(floating[0]!.value).toBeCloseTo(2.0, 2);
  });

  it("flags coincident coplanar faces (z-fight) and, opt-in, deep overlap", () => {
    const { doc, reg } = scene({
      floor: box([0, 0, 0], [20, 1, 20]),
      a: box([0, 0.98, 0], [1, 1, 1]),
      b: box([0, 0.98, 0], [1, 1, 1]),
    });
    const findings = lintPlacement(doc, reg);
    expect(findings.some((f) => f.kind === "z-fight" && [f.entity, f.other].includes("a") && [f.entity, f.other].includes("b"))).toBe(true);
    // overlap is opt-in: graybox construction interpenetrates on purpose
    expect(findings.some((f) => f.kind === "overlap")).toBe(false);
    const withOverlap = lintPlacement(doc, reg, { overlapTol: 0.15 });
    expect(withOverlap.some((f) => f.kind === "overlap" && [f.entity, f.other].includes("a") && [f.entity, f.other].includes("b"))).toBe(true);
  });

  it("does not flag dynamic rigidbodies or declared wall/ceiling props as floating", () => {
    const { doc, reg } = scene({
      floor: box([0, 0, 0], [20, 1, 20]),
      ball: box([0, 4, 0], [1, 1, 1], { components: { rigidbody: {} } }),
      sconce: box([3, 4, 0], [0.4, 0.4, 0.4], { placement: { snap: "wall" } }),
    });
    const findings = lintPlacement(doc, reg);
    expect(findings.filter((f) => f.kind === "floating")).toHaveLength(0);
  });

  it("exempts butt-jointed neighbours from overlap and z-fight", () => {
    // two wall segments meeting flush at x=0: share a plane but face opposite
    // ways, and their AABBs touch without penetrating
    const { doc, reg } = scene({
      floor: box([0, 0, 0], [20, 1, 20]),
      wallA: box([-2, 2, 0], [4, 3, 0.5]),
      wallB: box([2, 2, 0], [4, 3, 0.5]),
    });
    const findings = lintPlacement(doc, reg).filter((f) => f.kind !== "floating");
    expect(findings).toHaveLength(0);
  });
});
