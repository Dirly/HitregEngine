import { describe, expect, it } from "vitest";
import { ComponentRegistry, cullingProfileSchema, lightSchema, materialSchema, registerCoreComponents } from "../src/index.js";

describe("matte by default (owner ruling 2026-10-06)", () => {
  it("a material with no roughness/metalness is fully matte and non-metal", () => {
    const m = materialSchema.parse({ color: "#808080" });
    expect(m.roughness).toBe(1);
    expect(m.metalness).toBe(0);
  });
});

describe("interior readability + culling schemas", () => {
  it("ambient light accepts a hemisphere groundColor", () => {
    expect(lightSchema.parse({ kind: "ambient", color: "#c0c8d8", groundColor: "#403830", intensity: 1.5 }).groundColor).toBe("#403830");
  });
  it("cullingProfile is a registered component with optional fields", () => {
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    expect(registry.has("cullingProfile")).toBe(true);
    expect(cullingProfileSchema.parse({ interiorReveal: 60, maxMinScreenPx: 0, occlusion: false })).toEqual({ interiorReveal: 60, maxMinScreenPx: 0, occlusion: false });
    expect(() => cullingProfileSchema.parse({ interiorReveal: -1 })).toThrow();
  });
});
