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

  it("defaults postfx bloom to disabled with tuned parameters", () => {
    const registry = setup();
    const result = registry.validate("postfx", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        bloom: { enabled: false, strength: 0.5, radius: 0.4, threshold: 0.85 },
      });
    }
  });

  it("rejects out-of-range postfx bloom values", () => {
    const registry = setup();
    const result = registry.validate("postfx", { bloom: { enabled: true, radius: 2 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/radius/);
  });

  it("defaults particles to a ready-to-use additive emitter", () => {
    const registry = setup();
    const result = registry.validate("particles", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        emitting: true,
        rate: 20,
        max: 200,
        lifetime: [0.8, 1.6],
        shape: "point",
        shapeSize: [0.2, 0.2, 0.2],
        coneAngle: 25,
        direction: [0, 1, 0],
        speed: [1, 2],
        gravity: 0,
        drag: 0,
        sizeStart: 0.15,
        sizeEnd: 0.02,
        spin: 0,
        colorStart: "#ffffff",
        colorEnd: "#ffffff",
        opacityStart: 1,
        opacityEnd: 0,
        blending: "additive",
        space: "world",
      });
    }
  });

  it("hard-caps particles max at 2000 and rejects bad shapes", () => {
    const registry = setup();
    const capped = registry.validate("particles", { max: 5000 });
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.error).toMatch(/max/);
    const badShape = registry.validate("particles", { shape: "torus" });
    expect(badShape.ok).toBe(false);
    if (!badShape.ok) expect(badShape.error).toMatch(/shape/);
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
      "particles",
      "postfx",
      "prefab",
      "rigidbody",
      "script",
      "sky",
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
