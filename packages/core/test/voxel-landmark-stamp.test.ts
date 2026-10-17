import { describe, expect, it } from "vitest";
import {
  applyOperator, applyRecipeEdits, archOutline, compileLandmarkSpec, compileOperator, defaultWorldRecipe, FINE_MIN, latheMesh,
  LandmarkThinWallError, landmarkOperatorSchema, type OperatorFieldReader, type WorldRecipe,
} from "../src/index.js";

const flat: OperatorFieldReader = { height: (x) => 100 + 0.05 * x, voxelSize: 2, seaLevel: 0, seed: 7 };

/** The worked example of the handoff format (a ~25 m desert arch). */
const ARCH = {
  version: 1,
  roles: { rock: { noise: { amount: 0.8, scale: 4, octaves: 3 } } },
  parts: [
    { name: "span", shape: "arch", span: 16, rise: 12, legs: 6, thickness: 6, depth: 8, round: 1 },
    { name: "west-foot", shape: "ellipsoid", size: [10, 12, 11], at: [-13, 2, 0], blend: 2.5 },
    { name: "east-foot", shape: "ellipsoid", size: [9, 10, 10], at: [13, 1, 0.5], blend: 2.5 },
    { name: "crown", shape: "ellipsoid", size: [14, 5, 9], at: [-2, 23, 0], blend: 2 },
  ],
};
const doc = (extra: Record<string, unknown> = {}) => ({ id: "arch", op: "landmark", at: [10, 20], yaw: 25, source: { csg: ARCH }, ...extra });

describe("landmark stamp", () => {
  it("compiles a CSG spec deterministically (same nodes, same digest)", () => {
    const a = compileLandmarkSpec(ARCH, { voxel: 0.5, yaw: 25, seed: 3 });
    const b = compileLandmarkSpec(JSON.parse(JSON.stringify(ARCH)), { voxel: 0.5, yaw: 25, seed: 3 });
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
    expect(a.digest).toBe(b.digest);
    expect(a.nodes.length).toBe(4);
    expect(a.max[1]).toBeGreaterThan(24);
    expect(a.thin.refused).toBe(false);
    // a different yaw or material salt is a different bake
    expect(compileLandmarkSpec(ARCH, { voxel: 0.5, yaw: 30, seed: 3 }).digest).not.toBe(a.digest);
    expect(compileLandmarkSpec(ARCH, { voxel: 0.5, yaw: 25, seed: 3, salt: "m" }).digest).not.toBe(a.digest);
  });

  it("refuses a shell thinner than 3 voxels and accepts it flagged thinOk", () => {
    const tube = (thinOk?: boolean) => ({ version: 1, parts: [
      { name: "shell", shape: "cylinder", r: 4, h: 8, role: "masonry", ...(thinOk ? { thinOk } : {}) },
      { name: "hollow", op: "sub", shape: "cylinder", r: 3.4, h: 10, at: [0, -1, 0], role: "masonry" },
    ] });
    expect(() => compileLandmarkSpec(tube(), { voxel: 0.5 })).toThrow(LandmarkThinWallError);
    try { compileLandmarkSpec(tube(), { voxel: 0.5 }); } catch (e) { expect((e as LandmarkThinWallError).spots[0]!.part).toMatch(/shell|hollow/); }
    expect(compileLandmarkSpec(tube(true), { voxel: 0.5 }).thin.refused).toBe(false);
    // 1.6 m walls (>= 1.5 = 3 voxels) pass
    const ok = { version: 1, parts: [{ shape: "cylinder", r: 4, h: 8, role: "masonry" }, { op: "sub", shape: "cylinder", r: 2.4, h: 10, at: [0, -1, 0], role: "masonry" }] };
    expect(compileLandmarkSpec(ok, { voxel: 0.5 }).thin.refused).toBe(false);
  });

  it("closed lathe and arch outlines are valid solids", () => {
    const m = latheMesh([[0, 0], [3, 0], [2, 6], [0, 6]], 12);
    expect(m.indices.length % 3).toBe(0);
    expect(() => compileLandmarkSpec({ version: 1, parts: [{ shape: "lathe", profile: [[3, 0], [2, 6]], role: "masonry" }] }, { voxel: 0.5 })).not.toThrow();
    const o = archOutline(8, 6, 2, 2, 12);
    expect(new Set(o.map((p) => p.join())).size).toBe(o.length);
  });

  it("blends with >= 6 m terrain pieces: bury sinks the foot, pad levels an apron, none edits nothing", () => {
    expect(() => landmarkOperatorSchema.parse({ at: [0, 0], source: { csg: ARCH }, blend: { feather: 4 } })).toThrow();
    expect(() => landmarkOperatorSchema.parse({ at: [0, 0], source: { csg: ARCH }, blend: { mode: "pad", apron: 3 } })).toThrow();
    const bury = compileOperator(doc(), flat);
    const patch = bury.pieces.find((p) => p.kind === "heightPatches")!.feature as { size: [number, number]; heights: number[] };
    expect(Math.min(...patch.size)).toBeGreaterThanOrEqual(FINE_MIN);
    const lm = bury.pieces.find((p) => p.kind === "landmarks")!.feature as { id: string; position: number[]; prefab: string };
    expect(lm.id).toBe("op:arch:landmark");
    const r = bury.output.report as { footY: number; ground: { min: number } };
    expect(r.footY).toBeLessThanOrEqual(r.ground.min - 1);
    expect(lm.position[1]).toBe(r.footY);
    const pad = compileOperator(doc({ blend: { mode: "pad", apron: 6 } }), flat);
    expect(pad.pieces.some((p) => p.kind === "heightPatches")).toBe(true);
    const none = compileOperator(doc({ blend: { mode: "none" } }), flat);
    expect(none.pieces.some((p) => p.kind === "heightPatches")).toBe(false);
  });

  it("applies with an inverse that restores the recipe", () => {
    const base: WorldRecipe = defaultWorldRecipe({ cellSize: 48 });
    const first = applyOperator(base, doc(), flat);
    expect(first.recipe.features.landmarks?.length).toBe(1);
    expect(JSON.stringify(applyRecipeEdits(first.recipe, first.inverse).recipe)).toBe(JSON.stringify(base));
  });
});
