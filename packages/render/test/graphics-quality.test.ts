import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { GrassSystem, type GrassData } from "../src/index.js";
import { scaledShadowMapSize } from "../src/csm.js";
import { HorizonTerrain } from "../src/horizon-terrain.js";

/** The render half of the player's Graphics settings (apps/playground/src/graphics-settings.ts). */

const DATA: GrassData = {
  bladeColor: "#ffffff", tipColor: "#ffffff", bladeWidth: 0.7, bladeHeight: 0.9, crossQuads: 2, alphaTest: 0.35, surfaces: [], minSurface: 0.5,
  slopeMax: 1, density: 1, radius: 24, windStrength: 0.05, windSpeed: 1, heightFadeStart: 100, heightFadeEnd: 200,
};

function field() {
  const group = new THREE.Object3D();
  const system = new GrassSystem();
  system.register("cover", group, DATA);
  const camera = new THREE.PerspectiveCamera();
  const mesh = (): THREE.InstancedMesh => group.children[0] as THREE.InstancedMesh;
  const pump = (frames = 3): void => { for (let i = 0; i < frames; i++) system.update(camera, () => 0, () => 0, Infinity); };
  const spots = (): Set<string> => {
    const out = new Set<string>();
    const m = new THREE.Matrix4();
    for (let i = 0; i < mesh().count; i++) {
      mesh().getMatrixAt(i, m);
      out.add(`${m.elements[12]!.toFixed(3)},${m.elements[14]!.toFixed(3)}`);
    }
    return out;
  };
  return { group, system, mesh, pump, spots };
}

describe("grass setting", () => {
  it("thins the same field: fewer blades, and every one left stood there before", () => {
    const f = field();
    f.pump();
    const full = f.spots();
    expect(full.size).toBeGreaterThan(500);
    f.system.setQuality(0.35, 1);
    f.pump();
    const thin = f.spots();
    expect(thin.size / full.size).toBeGreaterThan(0.28);
    expect(thin.size / full.size).toBeLessThan(0.42);
    for (const spot of thin) expect(full.has(spot)).toBe(true);
  });

  it("shortens the disc with reach and comes back whole", () => {
    const f = field();
    f.pump();
    const full = f.mesh().count;
    f.system.setQuality(1, 0.5);
    f.pump();
    expect(f.mesh().count / full).toBeLessThan(0.35);
    f.system.setQuality(1, 1);
    f.pump();
    expect(f.mesh().count).toBe(full);
  });

  it("at none, draws nothing and does no placement, then returns when turned up", () => {
    const f = field();
    f.pump();
    const full = f.mesh().count;
    f.system.setQuality(0, 0.6);
    f.pump();
    expect(f.mesh().visible).toBe(false);
    f.system.setQuality(1, 1);
    f.pump();
    expect(f.mesh().visible).toBe(true);
    expect(f.mesh().count).toBe(full);
  });

  it("holds for a layer registered later (a scene rebuild, a recipe edit)", () => {
    const f = field();
    f.system.setQuality(0, 0.6);
    const later = new THREE.Object3D();
    f.system.register("late", later, DATA);
    f.pump();
    expect((later.children[0] as THREE.InstancedMesh).visible).toBe(false);
  });
});

describe("shadow setting", () => {
  it("scales the authored map size with a floor", () => {
    expect(scaledShadowMapSize(1024, 1)).toBe(1024);
    expect(scaledShadowMapSize(1024, 2)).toBe(2048);
    expect(scaledShadowMapSize(1024, 0.5)).toBe(512);
    expect(scaledShadowMapSize(256, 0.5)).toBe(256);
  });
});

describe("draw distance", () => {
  it("moves the horizon's hole on the next update", () => {
    const land = new HorizonTerrain(1200, 48);
    const position = new Float32Array([0, 50, 0, 900, 50, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = land as any;
    state.mesh = new THREE.Mesh(geometry);
    state.surface = position.slice();
    land.update(0, 0);
    const inHole = position[4]!;
    land.setRing(600);
    land.update(0, 0);
    expect(position[4]!).toBeGreaterThan(inHole);
  });
});
