import { describe, expect, it } from "vitest";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents, vecApplyQuat, waterExclusionSchema, waterExclusions, waterExcluded, WaterIndex, waterQuery, type SceneDoc, type Vec3, type WorldTransform } from "../src/index.js";

function ship(): SceneDoc {
  const reg = new ComponentRegistry(); registerCoreComponents(reg);
  return applyOps(createScene("dry hold"), [{ op: "add-entity", id: "hull", entity: {
    name: "hull", parent: null, tags: [], components: { transform: {}, waterExclusion: {
      min: [-3, 0.5, -10], max: [3, 4, 10],
      // Narrow bow: at z=10 the dry width is 1m; at z=0 it is 3m.
      planes: [[1, 0, 0.2, 3], [-1, 0, 0.2, 3]],
    } },
  } }], reg).doc;
}

describe("watertight interiors", () => {
  it("removes both authored and procedural water only inside the finite hull", () => {
    const exclusions = waterExclusions(ship());
    const index = new WaterIndex([{ entity: "ocean", surfaceY: 2, floorY: -20, x0: -100, x1: 100, z0: -100, z1: 100, swim: true, current: [0, 0] }], exclusions);
    const at = waterQuery({ index, field: { waterY: () => 2.5, height: () => -20, worldLimit: Infinity } });
    expect(index.sampleAt(0, 1, 0)).toBeNull();
    expect(at(0, 1, 0)).toBeNull();
    expect(at(2, 1, 9)?.depth).toBe(1.5); // beside tapered bow, inside its broad bounds
    expect(at(0, 0, 0)?.depth).toBe(2.5); // below keel remains swimmable
    expect(at(0, 4.1, 0)?.surfaceY).toBe(2.5); // above the gunwale remains water
    expect(at(3.1, 1, 0)?.surfaceY).toBe(2.5);
  });

  it("follows parent translation, pitch, yaw and nonuniform/mirrored scale", () => {
    const doc = ship();
    doc.entities["parent"] = { name: "parent", parent: null, tags: [], components: { transform: {
      position: [1818, -2.3, 646], rotation: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)], scale: [2, 1, 0.75],
    } } };
    doc.entities["hull"]!.parent = "parent";
    doc.entities["hull"]!.components["transform"] = { position: [8, 0, -3], rotation: [Math.sin(0.12), 0, 0, Math.cos(0.12)], scale: [-1, 1.2, 1] };
    const world = (point: Vec3) => {
      let p = point;
      for (const id of ["hull", "parent"]) {
        const t = doc.entities[id]!.components["transform"] as WorldTransform;
        const q = vecApplyQuat(p.map((v, i) => v * t.scale[i]!) as Vec3, t.rotation);
        p = q.map((v, i) => v + t.position[i]!) as Vec3;
      }
      return p;
    };
    const volumes = waterExclusions(doc);
    expect(waterExcluded(volumes, ...world([0, 1, 0]))).toBe(true);
    expect(waterExcluded(volumes, ...world([2, 1, 9]))).toBe(false);
    expect(waterExcluded(volumes, ...world([0, 0, 0]))).toBe(false);
    expect(waterExcluded(volumes, ...world([0, 4.1, 0]))).toBe(false);
  });

  it("updates from fresh transforms and disappears when the component is removed", () => {
    const doc = ship();
    doc.entities["hull"]!.components["transform"] = { position: [50, 0, 0] };
    const volumes = waterExclusions(doc);
    expect(waterExcluded(volumes, 0, 1, 0)).toBe(false);
    expect(waterExcluded(volumes, 50, 1, 0)).toBe(true);
    delete doc.entities["hull"]!.components["waterExclusion"];
    expect(waterExclusions(doc)).toEqual([]);
  });

  it("rejects inverted bounds, nonfinite or zero planes instead of erasing arbitrary sea", () => {
    expect(waterExclusionSchema.safeParse({ min: [0, 0, 0], max: [0, 1, 1] }).success).toBe(false);
    expect(waterExclusionSchema.safeParse({ min: [0, 0, 0], max: [1, 1, 1], planes: [[0, 0, 0, 1]] }).success).toBe(false);
    expect(waterExclusionSchema.safeParse({ min: [0, 0, 0], max: [1, 1, 1], planes: [[1, 0, 0, Infinity]] }).success).toBe(false);
  });
});
