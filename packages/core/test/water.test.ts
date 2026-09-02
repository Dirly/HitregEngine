import { describe, expect, it } from "vitest";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "../src/index.js";
import { lintWater, waterFillOps } from "../src/water.js";

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

/**
 * A basin: floor slab (top at y=0.5) and four walls (y 0.5..3.5) whose inner
 * faces sit at ±4.5. Water filled to y=2 is fully contained.
 */
function basin(reg: ComponentRegistry, opts: { skipWall?: string } = {}): SceneDoc {
  const ops: Op[] = [
    { op: "add-entity", id: "floor", entity: box("floor", [0, 0, 0], [10, 1, 10]) },
    { op: "add-entity", id: "wall-n", entity: box("wall-n", [0, 2, 4.75], [10, 3, 0.5]) },
    { op: "add-entity", id: "wall-s", entity: box("wall-s", [0, 2, -4.75], [10, 3, 0.5]) },
    { op: "add-entity", id: "wall-e", entity: box("wall-e", [4.75, 2, 0], [0.5, 3, 10]) },
    { op: "add-entity", id: "wall-w", entity: box("wall-w", [-4.75, 2, 0], [0.5, 3, 10]) },
  ].filter((op) => op.id !== opts.skipWall) as Op[];
  return applyOps(createScene("basin"), ops, reg).doc;
}

describe("waterFillOps", () => {
  it("emits a tagged, collider-free surface plane filling the rect at surfaceY", () => {
    const reg = registry();
    const doc = basin(reg);
    const fill = waterFillOps(doc, reg, {
      region: { x0: -4.5, z0: -4.5, x1: 4.5, z1: 4.5 },
      surfaceY: 2,
      material: "mat-water",
    });
    expect(fill.ops).toHaveLength(1);
    const next = applyOps(doc, fill.ops, reg).doc;
    const entity = next.entities[fill.id]!;
    expect(entity.tags).toEqual(["water"]);
    expect(entity.components["collider"]).toBeUndefined();
    const mesh = entity.components["mesh"] as {
      source: { kind: string; shape: string; size: [number, number, number] };
      material: string;
      castShadow: boolean;
    };
    expect(mesh.source.kind).toBe("primitive");
    expect(mesh.source.shape).toBe("plane");
    expect(mesh.source.size[0]).toBeCloseTo(9, 6);
    expect(mesh.source.size[2]).toBeCloseTo(9, 6);
    expect(mesh.material).toBe("mat-water");
    expect(mesh.castShadow).toBe(false);
    const t = entity.components["transform"] as { position: [number, number, number] };
    expect(t.position).toEqual([0, 2, 0]);
    expect(fill.report.area).toBeCloseTo(81, 6);
  });

  it("uses the bounding rect for polygon regions and records the polygon in the report", () => {
    const reg = registry();
    const doc = createScene("s");
    const polygon: [number, number][] = [
      [0, 0],
      [4, 0],
      [2, 3],
    ];
    const fill = waterFillOps(doc, reg, { region: { polygon }, surfaceY: 1, material: "m", name: "pond" });
    expect(fill.report.rect).toEqual({ x0: 0, z0: 0, x1: 4, z1: 3 });
    expect(fill.report.polygon).toEqual(polygon);
    expect(fill.id).toBe("pond");
  });

  it("never collides with an existing entity id", () => {
    const reg = registry();
    let doc = createScene("s");
    const first = waterFillOps(doc, reg, {
      region: { x0: 0, z0: 0, x1: 2, z1: 2 },
      surfaceY: 0,
      material: "m",
    });
    doc = applyOps(doc, first.ops, reg).doc;
    const second = waterFillOps(doc, reg, {
      region: { x0: 5, z0: 5, x1: 7, z1: 7 },
      surfaceY: 0,
      material: "m",
    });
    expect(first.id).toBe("water");
    expect(second.id).toBe("water~2");
    expect(() => applyOps(doc, second.ops, reg)).not.toThrow();
  });
});

describe("lintWater", () => {
  it("finds nothing on a fully contained basin", () => {
    const reg = registry();
    const doc = basin(reg);
    const fill = waterFillOps(doc, reg, {
      region: { x0: -4.5, z0: -4.5, x1: 4.5, z1: 4.5 },
      surfaceY: 2,
      material: "mat-water",
    });
    const next = applyOps(doc, fill.ops, reg).doc;
    expect(lintWater(next, reg)).toEqual([]);
  });

  it("reports levitating water on the open side when a wall is removed", () => {
    const reg = registry();
    const doc = basin(reg, { skipWall: "wall-e" });
    const fill = waterFillOps(doc, reg, {
      region: { x0: -4.5, z0: -4.5, x1: 4.5, z1: 4.5 },
      surfaceY: 2,
      material: "mat-water",
    });
    const next = applyOps(doc, fill.ops, reg).doc;
    const findings = lintWater(next, reg);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    for (const finding of findings) {
      expect(finding.entity).toBe(fill.id);
      expect(finding.message).toContain("levitating water");
      // every unsupported edge point is on the open (+X) side
      expect(finding.at[0]).toBeGreaterThan(4.4);
      expect(finding.at[1]).toBeCloseTo(2, 5);
    }
  });

  it("matches water by name when untagged, and ignores solid props near the edge", () => {
    const reg = registry();
    let doc = basin(reg);
    // a hand-authored, untagged sheet named "Water Sheet" hanging past the basin: found by name
    doc = applyOps(
      doc,
      [
        {
          op: "add-entity",
          id: "sheet",
          entity: {
            name: "Water Sheet",
            parent: null,
            tags: [],
            components: {
              transform: { position: [20, 2, 0] },
              mesh: { source: { kind: "primitive", shape: "plane", size: [4, 1, 4] } },
            },
          },
        },
      ],
      reg,
    ).doc;
    const findings = lintWater(doc, reg);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.every((f) => f.entity === "sheet")).toBe(true);
  });
});
