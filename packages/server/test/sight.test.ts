import { describe, expect, it } from "vitest";
import type { EntityDoc } from "@hitreg/core";
import { SIGHT_MAX, sightRadius } from "../src/sight.js";

/** Sight (sight.ts): a creature bigger than a person is sent to players from further away; a netObject overrides. */
const body = (components: Record<string, unknown>): EntityDoc => ({ name: "b", parent: null, tags: [], components });
const capsule = (w: number, h: number) => ({ collider: { shape: "capsule", size: [w, h, w] } });

describe("sight radius", () => {
  it("a person is seen at the interest radius", () => {
    expect(sightRadius(body(capsule(0.9, 1.7)), 250)).toBe(250);
    expect(sightRadius(body({}), 250)).toBe(250);
  });
  it("a giant is seen further, in proportion to its height, capped", () => {
    expect(sightRadius(body(capsule(1.2, 4)), 250)).toBeCloseTo((250 * 5.2) / 2.6);
    expect(sightRadius(body(capsule(3.2, 4.33)), 250)).toBe(SIGHT_MAX);
    expect(sightRadius(body({ ...capsule(0.9, 1.7), transform: { scale: [2, 2, 2] } }), 250)).toBeCloseTo((250 * 5.2) / 2.6);
  });
  it("an authored netObject wins; interest off sends everything", () => {
    expect(sightRadius(body({ ...capsule(3.2, 4.33), netObject: { relevancy: "proximity", radius: 900 } }), 250)).toBe(900);
    expect(sightRadius(body(capsule(3.2, 4.33)), 0)).toBe(0);
  });
});
