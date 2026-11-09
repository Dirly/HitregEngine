import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { advanceGrassReach, GrassSystem, type GrassData } from "../src/grass.js";

it("reveals the extra coverage after a patch swap gradually at different frame rates", () => {
  const simulate = (dt: number) => {
    let reach = 20;
    for (let time = 0; time < 900; time += dt) reach = advanceGrassReach(reach, 42, dt);
    return reach;
  };
  expect(advanceGrassReach(20, 42, 16)).toBeLessThan(22);
  expect(simulate(15)).toBeCloseTo(simulate(30), 6);
  expect(simulate(30)).toBeGreaterThan(40);
  expect(simulate(30)).toBeLessThan(42);
});

it("never fades beyond available blades or jumps outward after a stall", () => {
  expect(advanceGrassReach(42, 20, 16)).toBe(20);
  expect(advanceGrassReach(20, 42, 5000)).toBe(advanceGrassReach(20, 42, 50));
  expect(advanceGrassReach(20, 42, 0)).toBe(20);
});

describe("cover grows in at the edge of its range", () => {
  const layer = {
    bladeColor: "#ffffff", tipColor: "#ffffff", bladeWidth: 0.7, bladeHeight: 0.9, crossQuads: 2, alphaTest: 0.35,
    surfaces: [] as string[], minSurface: 0.5, slopeMax: 1, density: 1, radius: 6, windStrength: 0.05, windSpeed: 1,
    heightFadeStart: 100, heightFadeEnd: 200,
  };
  const placed = (data: GrassData) => {
    const group = new THREE.Group(), system = new GrassSystem(), camera = new THREE.PerspectiveCamera();
    system.register("cover", group, data);
    camera.position.set(0, 2, 0); camera.updateMatrixWorld(true);
    system.update(camera, () => 0, () => 3);
    return group.children[0] as THREE.InstancedMesh;
  };

  it("hands every tuft its own standing point, the pivot and the distance the shrink reads", () => {
    const mesh = placed(layer);
    const origins = mesh.geometry.getAttribute("instanceOrigin");
    const matrix = new THREE.Matrix4(), at = new THREE.Vector3();
    expect(mesh.count).toBeGreaterThan(0);
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      at.setFromMatrixPosition(matrix);
      expect([origins.getX(i), origins.getY(i), origins.getZ(i)]).toEqual([at.x, 3, at.z].map(Math.fround));
    }
  });

  it("shrinks every kind of layer in the vertex stage, as a cutout", () => {
    const kinds: GrassData[] = [layer, { ...layer, texture: "t.png" }, { ...layer, texture: "t.png", orient: "flat" }];
    for (const data of kinds) {
      const material = placed(data).material as THREE.MeshStandardNodeMaterial;
      expect(material.positionNode).toBeTruthy(); // flat cards used to have none
      expect(material.transparent).toBe(false);
    }
  });
});
