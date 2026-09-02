import { describe, expect, it } from "vitest";
import { geometryFor } from "../src/scene-builder.js";

/**
 * `mesh.source.segments` is schema-DEFAULTED to [1, 1], so it is always present
 * after validation and "the author didn't set it" is not directly detectable.
 * Round primitives therefore treat sub-ring values as unset. These tests pin
 * that, because getting it wrong turns every existing cylinder in every scene
 * into a degenerate 1-sided sliver — silently, since nothing throws.
 */
const radialCount = (g: { attributes: { position: { count: number } } }) =>
  g.attributes.position.count;

describe("geometryFor segments", () => {
  it("treats the schema default [1,1] as unset on round shapes", () => {
    const authored = geometryFor("cylinder", [1, 1, 1], [1, 1]);
    const omitted = geometryFor("cylinder", [1, 1, 1], undefined);
    expect(radialCount(authored)).toBe(radialCount(omitted));
  });

  it("honours a real facet count", () => {
    const faceted = geometryFor("cylinder", [1, 1, 1], [8, 1]);
    const smooth = geometryFor("cylinder", [1, 1, 1], [24, 1]);
    expect(radialCount(faceted)).toBeLessThan(radialCount(smooth));
  });

  it("keeps [1,1] meaningful on flat shapes", () => {
    const one = geometryFor("plane", [1, 1, 1], [1, 1]);
    const many = geometryFor("plane", [1, 1, 1], [4, 4]);
    expect(radialCount(many)).toBeGreaterThan(radialCount(one));
  });

  it("still builds every shape with the default segments", () => {
    for (const shape of ["box", "sphere", "plane", "cylinder", "capsule", "cone", "torus", "wedge"]) {
      const g = geometryFor(shape, [1, 1, 1], [1, 1]);
      expect(radialCount(g)).toBeGreaterThan(2);
    }
  });
});
