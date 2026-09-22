import { describe, expect, it } from "vitest";
import { vfxComponentSchema } from "../src/components/core.js";
import { paletteFor, paletteFromMaterial } from "../src/vfx/elements.js";

describe("vfx component", () => {
  it("needs an effect and defaults the rest", () => {
    expect(vfxComponentSchema.safeParse({}).success).toBe(false);
    expect(vfxComponentSchema.parse({ effect: "env/fire-torch" })).toEqual({
      effect: "env/fire-torch",
      playing: true,
      cullDistance: 60,
    });
  });
});

describe("paletteFromMaterial", () => {
  it("reads the body from color and the hot core from emissive", () => {
    const p = paletteFromMaterial({ color: "#3080FF", emissive: "#d0e8ff" });
    expect(p.primary).toBe("#3080ff");
    expect(p.glow).toBe("#d0e8ff");
    // secondary is the body pulled 65% toward black
    expect(p.secondary).toBe("#112d59");
  });

  it("lightens the body when emissive is black", () => {
    expect(paletteFromMaterial({ color: "#ff0000", emissive: "#000000" }).glow).toBe("#ff9999");
  });

  it("falls back to the fire palette when the material is missing or malformed", () => {
    expect(paletteFromMaterial(undefined)).toEqual(paletteFor("fire"));
    expect(paletteFromMaterial({ color: "orange" })).toEqual(paletteFor("fire"));
  });
});
