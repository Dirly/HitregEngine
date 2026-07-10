import { describe, expect, it } from "vitest";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  quatMultiply,
  registerCoreComponents,
  vecApplyQuat,
  worldTransforms,
  type Quat,
} from "../src/index.js";

const Y90: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2]; // 90° about +Y

function near(a: number[], b: number[], eps = 1e-6): void {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(eps));
}

describe("math", () => {
  it("rotates vectors by quaternions", () => {
    // +X rotated 90° about +Y lands on -Z
    near(vecApplyQuat([1, 0, 0], Y90), [0, 0, -1]);
  });

  it("composes quaternions", () => {
    const y180 = quatMultiply(Y90, Y90);
    near(vecApplyQuat([1, 0, 0], y180), [-1, 0, 0]);
  });

  it("resolves nested world transforms with rotation and scale", () => {
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    const { doc } = applyOps(
      createScene("s"),
      [
        {
          op: "add-entity",
          id: "parent",
          entity: {
            name: "P",
            parent: null,
            tags: [],
            components: {
              transform: { position: [10, 0, 0], rotation: Y90, scale: [2, 2, 2] },
            },
          },
        },
        {
          op: "add-entity",
          id: "child",
          entity: {
            name: "C",
            parent: "parent",
            tags: [],
            components: { transform: { position: [1, 0, 0] } },
          },
        },
      ],
      registry,
    );

    const world = worldTransforms(doc);
    // child local +X, scaled by 2, rotated 90°Y -> world offset [0,0,-2] from parent
    near(world.get("child")!.position, [10, 0, -2]);
    near(world.get("child")!.scale, [2, 2, 2]);
    near(world.get("parent")!.position, [10, 0, 0]);
  });
});
