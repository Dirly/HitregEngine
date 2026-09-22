import { describe, expect, it } from "vitest";
import { ToolRegistry, toolFileValueSchema } from "../src/index.js";

const definition = {
  version: 1 as const,
  id: "hitreg.example",
  name: "Example",
  description: "A small registered tool.",
  category: "Assets/Generate",
  surfaces: ["assets" as const],
  permissions: ["assets.write:textures"],
  inputs: {
    name: {
      kind: "string" as const,
      label: "Name",
      pattern: "^[a-z-]+$",
      default: "example",
    },
    size: {
      kind: "number" as const,
      label: "Size",
      integer: true,
      min: 64,
      max: 1024,
      default: 256,
    },
    source: {
      kind: "file" as const,
      label: "Source",
      accept: ["image/png"],
    },
  },
};

describe("ToolRegistry", () => {
  it("applies defaults and validates uploaded inputs", () => {
    const registry = new ToolRegistry();
    registry.register(definition);
    const result = registry.validate("hitreg.example", {
      source: { name: "source.png", mediaType: "image/png", data: "aGVsbG8=" },
    });
    expect(result).toEqual({
      ok: true,
      data: {
        name: "example",
        size: 256,
        source: { name: "source.png", mediaType: "image/png", data: "aGVsbG8=" },
      },
    });
  });

  it("rejects undeclared, invalid, and wrong-media inputs", () => {
    const registry = new ToolRegistry();
    registry.register(definition);
    expect(
      registry.validate("hitreg.example", {
        name: "BAD NAME",
        size: 12,
        source: { name: "source.jpg", mediaType: "image/jpeg", data: "aGVsbG8=" },
        surprise: true,
      }).ok,
    ).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const registry = new ToolRegistry();
    registry.register(definition);
    expect(() => registry.register(definition)).toThrow(/already registered/);
  });

  it("accepts a multi-megabyte file without overflowing the regexp stack", () => {
    const registry = new ToolRegistry();
    const maxBytes = 8 * 1024 * 1024;
    registry.register({ ...definition, inputs: { ...definition.inputs, source: { ...definition.inputs.source, maxBytes } } });
    const file = { name: "large.png", mediaType: "image/png", data: Buffer.alloc(maxBytes, 42).toString("base64") };
    expect(registry.validate(definition.id, { source: file }).ok).toBe(true);
    expect(toolFileValueSchema.safeParse(file).success).toBe(true);
    expect(registry.validate(definition.id, { source: { ...file, data: file.data + "AAAA" } }).ok).toBe(false);
  });

  it("rejects malformed base64 padding and truncated groups", () => {
    const registry = new ToolRegistry(); registry.register(definition);
    for (const data of ["A", "AAA", "AAAA=", "AAAA===", "AA=A", "====", "AA A", "AA-_", "AA==AAAA"]) {
      const file = { name: "source.png", mediaType: "image/png", data };
      expect(registry.validate(definition.id, { source: file }).ok, data).toBe(false);
      expect(toolFileValueSchema.safeParse(file).success, data).toBe(false);
    }
  });
});
