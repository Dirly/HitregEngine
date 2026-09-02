import { describe, expect, it } from "vitest";
import {
  ComponentRegistry,
  registerCoreComponents,
  materialSchema,
  postfxSchema,
  skySchema,
  lightSchema,
} from "../src/index.js";

function setup() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  return registry;
}

/**
 * These schemas gained a large surface at once (full PBR map set, a real post
 * stack, atmosphere, shadow quality). The bar that matters is that NONE of it
 * is observable to content authored before it existed — so every block below
 * pairs "the new defaults are what we said" with "a pre-existing minimal doc
 * still parses to exactly what it used to".
 */

describe("materialSchema — PBR texture set", () => {
  it("defaults every new map field to absent and every new scalar to a no-op", () => {
    const m = materialSchema.parse({});
    // Optional texture ids stay absent — an unset map must never become "".
    for (const key of [
      "normalMap",
      "roughnessMap",
      "metalnessMap",
      "aoMap",
      "ormMap",
      "detailNormalMap",
      "alphaMap",
    ]) {
      expect(m).not.toHaveProperty(key);
    }
    expect(m).toMatchObject({
      normalScale: 1,
      aoIntensity: 1,
      detailRepeat: [8, 8],
      detailStrength: 1,
      triplanar: false,
      triplanarScale: 1,
      alphaTest: 0,
      envMapIntensity: 1,
      uvOffset: [0, 0],
      side: "front",
      vertexColors: false,
    });
  });

  it("leaves a pre-existing material doc's own values untouched", () => {
    const legacy = {
      shader: "standard",
      color: "#8a8378",
      map: "rock-albedo",
      repeat: [4, 4],
      roughness: 0.45,
      metalness: 0.9,
      emissive: "#000000",
      opacity: 1,
      transparent: false,
    };
    const m = materialSchema.parse(legacy);
    expect(m).toMatchObject(legacy);
  });

  it("rejects out-of-range PBR values", () => {
    expect(() => materialSchema.parse({ normalScale: 9 })).toThrow(/normalScale/);
    expect(() => materialSchema.parse({ aoIntensity: 1.5 })).toThrow(/aoIntensity/);
    expect(() => materialSchema.parse({ detailStrength: -1 })).toThrow(/detailStrength/);
    expect(() => materialSchema.parse({ alphaTest: 2 })).toThrow(/alphaTest/);
    expect(() => materialSchema.parse({ triplanarScale: 0 })).toThrow(/triplanarScale/);
    expect(() => materialSchema.parse({ side: "both" })).toThrow(/side/);
  });
});

describe("postfxSchema — post stack", () => {
  it("defaults every new block to disabled, except tonemap", () => {
    const p = postfxSchema.parse({});
    expect(p).toEqual({
      bloom: { enabled: false, strength: 0.5, radius: 0.4, threshold: 0.85 },
      // tonemap defaults ON with mode "aces": that is what the renderer already
      // did unconditionally, so anything else would be a silent look change.
      tonemap: { enabled: true, mode: "aces", exposure: 1 },
      ao: { enabled: false, intensity: 1, radius: 0.5, distanceFalloff: 1, samples: 16, denoise: true },
      grade: {
        enabled: false,
        contrast: 1,
        saturation: 1,
        temperature: 0,
        tint: 0,
        lift: "#808080",
        gamma: "#808080",
        gain: "#808080",
      },
      vignette: { enabled: false, amount: 0.5, radius: 0.75, smoothness: 0.4 },
      grain: { enabled: false, amount: 0.06, size: 1 },
      chromaticAberration: { enabled: false, amount: 0.005 },
      dof: { enabled: false, focusDistance: 10, focalLength: 35, bokehScale: 2, maxBlur: 0.5 },
      antialias: { mode: "fxaa" },
      motionBlur: { enabled: false, amount: 0.3, samples: 12 },
      sharpen: { enabled: false, amount: 0.4 },
    });
  });

  it("keeps an existing bloom-only postfx doc byte-identical in its bloom block", () => {
    const registry = setup();
    const result = registry.validate("postfx", {
      bloom: { enabled: true, strength: 1.2, radius: 0.6, threshold: 0.7 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as { bloom: unknown }).bloom).toEqual({
        enabled: true,
        strength: 1.2,
        radius: 0.6,
        threshold: 0.7,
      });
    }
  });

  it("rejects out-of-range post values", () => {
    expect(() => postfxSchema.parse({ tonemap: { exposure: 20 } })).toThrow(/exposure/);
    expect(() => postfxSchema.parse({ tonemap: { mode: "filmic" } })).toThrow(/mode/);
    expect(() => postfxSchema.parse({ ao: { intensity: 5 } })).toThrow(/intensity/);
    expect(() => postfxSchema.parse({ ao: { samples: 3 } })).toThrow(/samples/);
    expect(() => postfxSchema.parse({ ao: { samples: 16.5 } })).toThrow(/samples/);
    expect(() => postfxSchema.parse({ grade: { lift: "grey" } })).toThrow(/lift/);
    expect(() => postfxSchema.parse({ grade: { temperature: -2 } })).toThrow(/temperature/);
    expect(() => postfxSchema.parse({ vignette: { amount: 1.5 } })).toThrow(/amount/);
    expect(() => postfxSchema.parse({ antialias: { mode: "msaa" } })).toThrow(/mode/);
    expect(() => postfxSchema.parse({ motionBlur: { samples: 1 } })).toThrow(/samples/);
  });
});

describe("skySchema — atmosphere", () => {
  it("defaults volumetric off and the environment to the sky itself", () => {
    const s = skySchema.parse({});
    expect(s).toMatchObject({
      volumetric: { enabled: false, intensity: 1, samples: 32, decay: 0.95, density: 0.5 },
      environment: { mode: "sky", intensity: 1, rotation: 0 },
    });
    expect(s.environment).not.toHaveProperty("hdri");
    // fog is still opt-in: absent means no fog at all, unchanged.
    expect(s).not.toHaveProperty("fog");
  });

  it("keeps a legacy linear-fog sky doc parsing to the same near/far", () => {
    const s = skySchema.parse({
      top: "#39598f",
      bottom: "#101522",
      light: 0.5,
      fog: { color: "#101522", near: 20, far: 90 },
    });
    expect(s.fog).toEqual({
      color: "#101522",
      mode: "linear",
      near: 20,
      far: 90,
      density: 0.015,
      heightFalloff: 0.15,
      baseHeight: 0,
    });
  });

  it("accepts height fog and rejects bad atmosphere values", () => {
    const s = skySchema.parse({ fog: { mode: "height", density: 0.04, heightFalloff: 0.2, baseHeight: -12 } });
    expect(s.fog).toMatchObject({ mode: "height", density: 0.04, heightFalloff: 0.2, baseHeight: -12 });
    expect(() => skySchema.parse({ fog: { mode: "radial" } })).toThrow(/mode/);
    expect(() => skySchema.parse({ fog: { density: -1 } })).toThrow(/density/);
    expect(() => skySchema.parse({ volumetric: { samples: 4 } })).toThrow(/samples/);
    expect(() => skySchema.parse({ volumetric: { decay: 2 } })).toThrow(/decay/);
    expect(() => skySchema.parse({ environment: { mode: "cubemap" } })).toThrow(/mode/);
    expect(() => skySchema.parse({ environment: { intensity: -1 } })).toThrow(/intensity/);
  });
});

describe("lightSchema — shadow quality", () => {
  it("defaults the shadow block to exactly what the renderer hardcoded", () => {
    const l = lightSchema.parse({ kind: "directional" });
    expect(l.shadow).toEqual({
      enabled: true,
      mapSize: 1024,
      bias: -0.0004,
      normalBias: 0.02,
      radius: 1,
      cascades: 1,
      cascadeSplit: 0.5,
      far: 0,
    });
    // castShadow is still the gate, and still defaults off.
    expect(l.castShadow).toBe(false);
    expect(l.shadowSize).toBe(40);
  });

  it("leaves an existing light doc's shadow behaviour unchanged", () => {
    const registry = setup();
    const result = registry.validate("light", {
      kind: "directional",
      intensity: 2.4,
      castShadow: true,
      shadowSize: 300,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        castShadow: true,
        shadowSize: 300,
        shadow: { enabled: true, mapSize: 1024, far: 0 },
      });
    }
  });

  it("rejects out-of-range shadow values", () => {
    expect(() => lightSchema.parse({ kind: "directional", shadow: { mapSize: 3000 } })).toThrow(/mapSize/);
    expect(() => lightSchema.parse({ kind: "directional", shadow: { cascades: 5 } })).toThrow(/cascades/);
    expect(() => lightSchema.parse({ kind: "directional", shadow: { cascades: 2.5 } })).toThrow(/cascades/);
    expect(() => lightSchema.parse({ kind: "directional", shadow: { cascadeSplit: 1.2 } })).toThrow(/cascadeSplit/);
    expect(() => lightSchema.parse({ kind: "directional", shadow: { normalBias: -1 } })).toThrow(/normalBias/);
  });
});
