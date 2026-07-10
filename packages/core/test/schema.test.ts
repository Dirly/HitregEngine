import { describe, expect, it } from "vitest";
import {
  ComponentRegistry,
  registerCoreComponents,
  validateScene,
  createScene,
  applyOps,
} from "../src/index.js";

function setup() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  return registry;
}

describe("ComponentRegistry", () => {
  it("rejects duplicate registration", () => {
    const registry = setup();
    expect(() => registerCoreComponents(registry)).toThrow(/already registered/);
  });

  it("normalizes data by applying defaults", () => {
    const registry = setup();
    const result = registry.validate("light", { kind: "directional" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        kind: "directional",
        color: "#ffffff",
        intensity: 1,
        castShadow: false,
      });
    }
  });

  it("rejects out-of-range values with a readable error", () => {
    const registry = setup();
    const result = registry.validate("light", {
      kind: "point",
      intensity: -5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/intensity/);
  });

  it("exports JSON Schema for every registered component", () => {
    const registry = setup();
    const schemas = registry.jsonSchemas();
    expect(Object.keys(schemas).sort()).toEqual([
      "animator",
      "audio",
      "camera",
      "collider",
      "joint",
      "light",
      "mesh",
      "prefab",
      "rigidbody",
      "script",
      "transform",
    ]);
    const transform = schemas["transform"] as { properties: Record<string, unknown> };
    expect(transform.properties).toHaveProperty("position");
  });
});

describe("validateScene", () => {
  it("reports missing parents and bad components without throwing", () => {
    const registry = setup();
    const doc = createScene("bad");
    doc.entities["a"] = {
      name: "A",
      parent: "ghost",
      tags: [],
      components: { light: { kind: "nope" } },
    };
    const issues = validateScene(doc, registry);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.message).join("\n")).toMatch(/ghost/);
  });

  it("passes a document built through applyOps", () => {
    const registry = setup();
    const { doc } = applyOps(
      createScene("good"),
      [
        {
          op: "add-entity",
          id: "cam",
          entity: {
            name: "Main Camera",
            parent: null,
            tags: [],
            components: { transform: {}, camera: { active: true } },
          },
        },
      ],
      registry,
    );
    expect(validateScene(doc, registry)).toEqual([]);
  });
});
