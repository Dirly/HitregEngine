import { describe, expect, it } from "vitest";
import { materialSchema } from "../src/components/core.js";

describe("material overlay schema", () => {
  it("is absent unless asked for, and defaults to a PSX ember-bed heat", () => {
    expect(materialSchema.parse({}).overlay).toBeUndefined();
    expect(materialSchema.parse({ overlay: {} }).overlay).toEqual({
      color: "#ffc040",
      opacity: 1.5,
      scale: 3,
      speed: [0.04, 0.1],
      threshold: 0.3,
      mask: "map",
      maskStrength: 0.75,
      maskCutoff: 0,
      pixel: 32,
      steps: 4,
      frameRate: 12,
    });
  });

  it("rejects a bad mask", () => {
    expect(materialSchema.safeParse({ overlay: { mask: "alpha" } }).success).toBe(false);
  });
});
