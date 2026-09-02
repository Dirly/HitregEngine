import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  DEFAULT_VOLUMETRIC_SETTINGS,
  FogSystem,
  VOLUMETRIC_RESOLUTION_SCALE,
  decayToDistanceAttenuation,
  densityToGodrayDensity,
  fogFactor,
  heightFogAttenuation,
  volumetricLightCandidates,
  volumetricPlanKey,
  volumetricSampleCost,
  volumetricSignature,
  type FogSettings,
} from "../src/atmosphere.js";

const LINEAR: FogSettings = {
  color: "#101522",
  mode: "linear",
  near: 40,
  far: 180,
  density: 0.015,
  heightFalloff: 0.15,
  baseHeight: 0,
};

describe("fog", () => {
  it("keeps linear fog byte-identical to the THREE.Fog that shipped before", () => {
    // The regression that matters: `mode` appearing with a `linear` default
    // must not move a single pixel in an existing scene.
    const scene = new THREE.Scene();
    const system = new FogSystem();
    system.apply(scene, LINEAR);
    const fog = scene.fog as THREE.Fog;
    expect(fog).toBeInstanceOf(THREE.Fog);
    expect(fog.near).toBe(40);
    expect(fog.far).toBe(180);
    expect(fog.color.getHexString()).toBe("101522");
    // a fogNode would override scene.fog in three's node pipeline
    expect(scene.fogNode).toBeNull();
  });

  it("retunes linear fog in place rather than swapping the object", () => {
    const scene = new THREE.Scene();
    const system = new FogSystem();
    system.apply(scene, LINEAR);
    const first = scene.fog;
    system.apply(scene, { ...LINEAR, near: 10, far: 90, color: "#223344" });
    expect(scene.fog).toBe(first);
    expect((scene.fog as THREE.Fog).near).toBe(10);
    expect((scene.fog as THREE.Fog).far).toBe(90);
  });

  it("clears both fog channels when there is no fog", () => {
    const scene = new THREE.Scene();
    const system = new FogSystem();
    system.apply(scene, LINEAR);
    system.apply(scene, null);
    expect(scene.fog).toBeNull();
    expect(scene.fogNode).toBeNull();
  });

  it("leaves a descriptor FogExp2 alongside the node for non-node consumers", () => {
    const scene = new THREE.Scene();
    const system = new FogSystem();
    system.apply(scene, { ...LINEAR, mode: "height", density: 0.02 });
    // HLOD fade and far-plane tint read scene.fog.color without knowing nodes
    expect(scene.fog).toBeInstanceOf(THREE.FogExp2);
    expect((scene.fog as THREE.FogExp2).density).toBe(0.02);
    expect(scene.fogNode).not.toBeNull();
    system.dispose(scene);
    expect(scene.fogNode).toBeNull();
  });

  it("matches three's rangeFogFactor for linear mode", () => {
    expect(fogFactor(LINEAR, 20)).toBe(0);
    expect(fogFactor(LINEAR, 200)).toBe(1);
    expect(fogFactor(LINEAR, 110)).toBeCloseTo(THREE.MathUtils.smoothstep(110, 40, 180), 10);
  });

  it("degenerates height fog to plain exponential at heightFalloff 0", () => {
    const height: FogSettings = { ...LINEAR, mode: "height", heightFalloff: 0 };
    const exponential: FogSettings = { ...LINEAR, mode: "exponential" };
    for (const distance of [1, 25, 400]) {
      for (const y of [-30, 0, 12]) {
        expect(fogFactor(height, distance, y, y + 3)).toBeCloseTo(
          fogFactor(exponential, distance, y, y + 3),
          12,
        );
      }
    }
  });

  it("thins height fog with altitude and never saturates below the base", () => {
    const settings: FogSettings = { ...LINEAR, mode: "height", heightFalloff: 0.2, baseHeight: 0 };
    const low = fogFactor(settings, 60, 1, 1);
    const high = fogFactor(settings, 60, 1, 40);
    expect(high).toBeLessThan(low);
    // the exp() clamp is what stops a camera far below the base painting flat
    const deep = heightFogAttenuation(0.2, 0, -5000, -5000);
    expect(Number.isFinite(deep)).toBe(true);
    expect(deep).toBeCloseTo(Math.exp(4), 6);
  });

  it("has a removable singularity at k*dy == 0", () => {
    expect(heightFogAttenuation(0.2, 0, 5, 5)).toBeCloseTo(Math.exp(-0.2 * 5), 10);
  });
});

describe("volumetrics", () => {
  it("maps the schema knobs onto three's defaults at the schema defaults", () => {
    expect(decayToDistanceAttenuation(DEFAULT_VOLUMETRIC_SETTINGS.decay)).toBeCloseTo(2, 10);
    expect(densityToGodrayDensity(DEFAULT_VOLUMETRIC_SETTINGS.density)).toBeCloseTo(0.7, 10);
    // decay's sense is inverted relative to three's attenuation
    expect(decayToDistanceAttenuation(0.5)).toBeGreaterThan(decayToDistanceAttenuation(0.99));
  });

  function shadowedLight<T extends THREE.Light>(light: T): T {
    const shadow = (light as unknown as { shadow: { map: unknown } }).shadow;
    light.castShadow = true;
    shadow.map = {} as never;
    return light;
  }

  it("accepts only shadow-mapped directional and point lights", () => {
    const directional = shadowedLight(new THREE.DirectionalLight());
    const point = shadowedLight(new THREE.PointLight());
    // three's GodraysNode throws at shader-build time on a SpotLight, which in
    // this renderer permanently retires the pass — it must never reach it.
    const spot = shadowedLight(new THREE.SpotLight());
    const ambient = new THREE.AmbientLight();
    const noShadow = new THREE.DirectionalLight();
    const hidden = shadowedLight(new THREE.PointLight());
    hidden.visible = false;
    const unmapped = new THREE.DirectionalLight();
    unmapped.castShadow = true;

    const picked = volumetricLightCandidates(
      [directional, point, spot, ambient, noShadow, hidden, unmapped],
      10,
    );
    expect(picked).toEqual([directional, point]);
  });

  it("excludes a cascaded light, which owns no shadow map of its own", () => {
    const light = shadowedLight(new THREE.DirectionalLight());
    (light.shadow as unknown as { shadowNode: unknown }).shadowNode = {};
    expect(volumetricLightCandidates([light], 1)).toEqual([]);
  });

  it("ranks by importance x intensity and caps the count", () => {
    const dim = shadowedLight(new THREE.PointLight(0xffffff, 1));
    const bright = shadowedLight(new THREE.PointLight(0xffffff, 8));
    const hero = shadowedLight(new THREE.PointLight(0xffffff, 2));
    hero.userData["lightImportance"] = 10;
    expect(volumetricLightCandidates([dim, bright, hero], 1)).toEqual([hero]);
    expect(volumetricLightCandidates([dim, bright, hero], 2)).toEqual([hero, bright]);
    expect(volumetricLightCandidates([dim, bright, hero], 0)).toEqual([]);
  });

  it("separates structural changes from retunable ones", () => {
    const a = shadowedLight(new THREE.DirectionalLight());
    const b = shadowedLight(new THREE.DirectionalLight());
    const on = { settings: { ...DEFAULT_VOLUMETRIC_SETTINGS, enabled: true }, lights: [a], signature: volumetricSignature([a]) };
    expect(volumetricPlanKey(null)).toBe("off");
    expect(volumetricPlanKey({ ...on, settings: DEFAULT_VOLUMETRIC_SETTINGS })).toBe("off");
    expect(volumetricPlanKey({ ...on, lights: [] })).toBe("off");
    expect(volumetricPlanKey({ ...on, settings: { ...on.settings, intensity: 0 } })).toBe("off");
    // samples/decay/density are uniforms — they must NOT force a rebuild
    expect(volumetricPlanKey({ ...on, settings: { ...on.settings, samples: 128, decay: 0.1 } })).toBe(
      volumetricPlanKey(on),
    );
    // a different light set must
    const other = { ...on, lights: [b], signature: volumetricSignature([b]) };
    expect(volumetricPlanKey(other)).not.toBe(volumetricPlanKey(on));
  });

  it("prices the raymarch by pixel count, not by resolution", () => {
    const full = volumetricSampleCost(1920, 1080, 32, 1);
    const reduced = volumetricSampleCost(1920, 1080, 32, VOLUMETRIC_RESOLUTION_SCALE);
    expect(reduced / full).toBeCloseTo(VOLUMETRIC_RESOLUTION_SCALE ** 2, 3);
    expect(reduced).toBeLessThan(full * 0.13);
  });
});
