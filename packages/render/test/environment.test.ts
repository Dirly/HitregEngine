import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  EnvironmentSystem,
  SKY_ENVIRONMENT_SIZE,
  applyEnvironment,
  averageLuminance,
  environmentCacheKey,
  skyEquirectData,
  type EnvironmentSettings,
  type SkyEnvironmentSource,
} from "../src/environment.js";

const SKY: SkyEnvironmentSource = {
  top: "#39598f",
  bottom: "#101522",
  sun: { direction: [0.4, 0.55, 0.3], color: "#fff6df", size: 0.997, intensity: 1.5 },
};

const SETTINGS: EnvironmentSettings = { mode: "sky", intensity: 1, rotation: 0 };

describe("environment cache key", () => {
  it("ignores intensity and rotation, which are applied without rebuilding", () => {
    const base = environmentCacheKey(SKY, SETTINGS);
    expect(environmentCacheKey(SKY, { ...SETTINGS, intensity: 4 })).toBe(base);
    expect(environmentCacheKey(SKY, { ...SETTINGS, rotation: 2.1 })).toBe(base);
  });

  it("changes with anything that changes the pixels", () => {
    const base = environmentCacheKey(SKY, SETTINGS);
    expect(environmentCacheKey({ ...SKY, top: "#000000" }, SETTINGS)).not.toBe(base);
    expect(
      environmentCacheKey({ ...SKY, sun: { ...SKY.sun!, intensity: 3 } }, SETTINGS),
    ).not.toBe(base);
  });

  it("follows the background's own source priority", () => {
    const cubemap = { px: "a", nx: "b", py: "c", ny: "d", pz: "e", nz: "f" };
    expect(environmentCacheKey({ ...SKY, cubemap, texture: "pano" }, SETTINGS)).toMatch(/^cube:/);
    expect(environmentCacheKey({ ...SKY, texture: "pano" }, SETTINGS)).toBe("equirect:pano");
    expect(environmentCacheKey(SKY, { ...SETTINGS, mode: "none" })).toBe("none");
    expect(environmentCacheKey(SKY, { ...SETTINGS, mode: "hdri", hdri: "sunset" })).toBe("hdri:sunset");
    expect(environmentCacheKey(null, SETTINGS)).toBe("none");
  });
});

describe("generated sky environment", () => {
  it("carries real energy — the difference between a metal and a black hole", () => {
    const data = skyEquirectData(SKY);
    expect(data).toHaveLength(SKY_ENVIRONMENT_SIZE.width * SKY_ENVIRONMENT_SIZE.height * 4);
    expect(averageLuminance(data)).toBeGreaterThan(0.01);
    // brighter sky, brighter reflections
    const bright = skyEquirectData({ ...SKY, top: "#ffffff", bottom: "#cccccc" });
    expect(averageLuminance(bright)).toBeGreaterThan(averageLuminance(data));
  });

  it("is bright at the zenith and dark at the nadir, matching the dome gradient", () => {
    const { width } = SKY_ENVIRONMENT_SIZE;
    const data = skyEquirectData({ top: "#ffffff", bottom: "#000000" });
    const luminanceAt = (row: number) => {
      const offset = (row * width + Math.floor(width / 2)) * 4;
      return data[offset]! + data[offset + 1]! + data[offset + 2]!;
    };
    expect(luminanceAt(0)).toBeGreaterThan(luminanceAt(SKY_ENVIRONMENT_SIZE.height - 1));
  });

  it("puts the sun's energy in the sun's direction", () => {
    const { width, height } = SKY_ENVIRONMENT_SIZE;
    const sun = { direction: [0, 1, 0] as [number, number, number], color: "#ffffff", size: 0.99, intensity: 4 };
    const data = skyEquirectData({ top: "#000000", bottom: "#000000", sun });
    const top = data[Math.floor(width / 2) * 4]!;
    const bottom = data[((height - 1) * width + Math.floor(width / 2)) * 4]!;
    expect(top).toBeGreaterThan(1);
    expect(bottom).toBeLessThan(0.01);
  });

  it("keeps every sample finite and non-negative", () => {
    const data = skyEquirectData(SKY);
    let bad = 0;
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i]!) || data[i]! < 0) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("EnvironmentSystem", () => {
  it("returns the SAME texture object when nothing that matters changed", () => {
    const system = new EnvironmentSystem();
    const first = system.update(SKY, SETTINGS);
    expect(first.texture).not.toBeNull();
    // three PMREM-prefilters by texture identity; a new object per call would
    // silently re-run the whole chain every frame
    const again = system.update(SKY, { ...SETTINGS, intensity: 2.5, rotation: 1 });
    expect(again.texture).toBe(first.texture);
    expect(again.intensity).toBe(2.5);
    expect(again.rotation).toBe(1);
    system.dispose();
  });

  it("rebuilds when the sky itself changes", () => {
    const system = new EnvironmentSystem();
    const first = system.update(SKY, SETTINGS);
    const second = system.update({ ...SKY, top: "#ff0000" }, SETTINGS);
    expect(second.texture).not.toBe(first.texture);
    expect(second.texture).not.toBeNull();
    system.dispose();
    expect(system.current.texture).toBeNull();
  });

  it("mode none yields no IBL at all", () => {
    const system = new EnvironmentSystem();
    system.update(SKY, SETTINGS);
    const off = system.update(SKY, { ...SETTINGS, mode: "none" });
    expect(off.texture).toBeNull();
    system.dispose();
  });

  it("warns and stays null for an hdri with no resolvable URL", () => {
    const system = new EnvironmentSystem({ resolveTexture: () => undefined });
    const result = system.update(SKY, { ...SETTINGS, mode: "hdri", hdri: "missing" });
    expect(result.texture).toBeNull();
    system.dispose();
  });

  it("applies to a scene as texture + intensity + Y rotation", () => {
    const scene = new THREE.Scene();
    const system = new EnvironmentSystem();
    const result = system.update(SKY, { ...SETTINGS, intensity: 1.5, rotation: 0.75 });
    applyEnvironment(scene, result);
    expect(scene.environment).toBe(result.texture);
    expect(scene.environmentIntensity).toBe(1.5);
    expect(scene.environmentRotation.y).toBe(0.75);
    expect(scene.environmentRotation.x).toBe(0);
    system.dispose();
  });
});
