import { describe, expect, it } from "vitest";
import { decalSchema, registerDecalComponent } from "../src/components/decal.js";
import { ComponentRegistry } from "../src/components/registry.js";

describe("decalSchema", () => {
  it("defaults everything but the texture", () => {
    const decal = decalSchema.parse({ texture: "moss-patch" });
    expect(decal).toMatchObject({
      texture: "moss-patch",
      size: [1, 1],
      depth: 0.25,
      rotation: 0,
      direction: [0, 0, -1],
      opacity: 1,
      color: "#ffffff",
    });
    // Optional fields stay absent — an unset fade must never become 0.
    expect(decal).not.toHaveProperty("fadeDepth");
    expect(decal).not.toHaveProperty("sortOffset");
  });

  it("requires a texture id", () => {
    expect(decalSchema.safeParse({}).success).toBe(false);
    expect(decalSchema.safeParse({ texture: "" }).success).toBe(false);
  });

  it("keeps authored values untouched", () => {
    const authored = {
      texture: "carved-rune",
      size: [2, 0.5] as [number, number],
      depth: 0.4,
      rotation: 45,
      direction: [0, -1, 0] as [number, number, number],
      opacity: 0.8,
      color: "#88aa66",
      fadeDepth: 0.1,
      sortOffset: 2,
    };
    expect(decalSchema.parse(authored)).toEqual(authored);
  });

  it("rejects out-of-range and malformed fields", () => {
    const base = { texture: "scorch" };
    expect(decalSchema.safeParse({ ...base, opacity: 1.5 }).success).toBe(false);
    expect(decalSchema.safeParse({ ...base, opacity: -0.1 }).success).toBe(false);
    expect(decalSchema.safeParse({ ...base, color: "red" }).success).toBe(false);
    expect(decalSchema.safeParse({ ...base, color: "#ff8800" }).success).toBe(true);
    expect(decalSchema.safeParse({ ...base, size: [0, 1] }).success).toBe(false);
    expect(decalSchema.safeParse({ ...base, size: [-1, 1] }).success).toBe(false);
    expect(decalSchema.safeParse({ ...base, size: [1, 1, 1] }).success).toBe(false);
    expect(decalSchema.safeParse({ ...base, depth: 0 }).success).toBe(false);
    expect(decalSchema.safeParse({ ...base, fadeDepth: 0 }).success).toBe(false);
    expect(decalSchema.safeParse({ ...base, direction: [0, 0] }).success).toBe(false);
  });

  it("documents every field for the AI-facing spec", () => {
    const shape = decalSchema.shape;
    const descriptions: string[] = [];
    for (const [key, field] of Object.entries(shape)) {
      const description = (field as { description?: string }).description ?? "";
      expect(description.length, `decal.${key} needs a .describe()`).toBeGreaterThan(20);
      descriptions.push(description);
    }
    const all = [decalSchema.description ?? "", ...descriptions].join(" ");
    // the two facts the schema must state outright: placement-solver
    // positioning, and that the renderer re-projects on change
    expect(all).toMatch(/placement/i);
    expect(all).toMatch(/snap/i);
    expect(all).toMatch(/re-?project|regenerat/i);
  });
});

describe("registerDecalComponent", () => {
  it("registers, validates and normalizes through the registry", () => {
    const registry = new ComponentRegistry();
    registerDecalComponent(registry);
    expect(registry.has("decal")).toBe(true);

    const valid = registry.validate("decal", { texture: "scorch", rotation: 45 });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.data).toMatchObject({ rotation: 45, depth: 0.25, opacity: 1 });

    const invalid = registry.validate("decal", { texture: "scorch", opacity: 2 });
    expect(invalid.ok).toBe(false);
  });

  it("exports a JSON Schema that carries the documentation", () => {
    const registry = new ComponentRegistry();
    registerDecalComponent(registry);
    const json = JSON.stringify(registry.jsonSchemas()["decal"]);
    expect(json).toContain("texture");
    expect(json.toLowerCase()).toContain("placement");
  });
});
