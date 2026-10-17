import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { cachedImpostor } from "../src/scene-builder.js";
import type { ImpostorAtlas } from "../src/impostor.js";

/**
 * The late-maps bug (instanced-material-late-maps.test.ts) was a material COPY taken before the
 * asset's textures were wired. The impostor path takes no copy: the bake renders the glTF's own
 * materials (whose embedded/external images GLTFLoader has already awaited), never the batch's
 * material override, and a rock-cap override only contributes its per-instance look, which
 * `rockImpostorLook` fills in place when the rock textures land. Pinned here so a later change
 * that bakes the override (or clones it) has to answer the late-texture question.
 */
describe("impostor bake source", () => {
  it("bakes the model's own materials, not the (possibly still loading) override", () => {
    const own = new THREE.MeshStandardMaterial({ name: "granite", map: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
    const scene = new THREE.Group();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), own));
    const override = new THREE.MeshStandardNodeMaterial({ name: "rock-cap" });
    override.userData["rockCap"] = {
      bases: [{ url: null, metres: 6.4, color: "#ffffff" }],
      palette: [],
      paletteCount: 0,
      paletteFilter: "linear",
      filter: "nearest",
      anisotropy: 0,
      start: 0.72,
      softness: 0.06,
      noise: 0.04,
      noiseMetres: 0.25,
      thicken: 0.55,
      crevice: 0.7,
      occlusion: 0.35,
      roughness: 0.95,
    };
    const baked: THREE.Material[] = [];
    const atlas: ImpostorAtlas = {
      albedo: new THREE.DataTexture(new Uint8Array(4), 1, 1),
      normal: new THREE.DataTexture(new Uint8Array(4), 1, 1),
      grid: 6,
      flipFrames: true,
    };
    const options = {
      bakeImpostor: (object: THREE.Object3D) => {
        object.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.isMesh) baked.push(mesh.material as THREE.Material);
        });
        return atlas;
      },
    };
    const bounds = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
    const result = cachedImpostor("bake-source/rock", undefined, scene, bounds, options as never, override);
    expect(result).not.toBeNull();
    expect(baked).toEqual([own]); // the same object, textures and all: no copy, no override
    expect(result!.material.name).toBe("rock-cap-impostor");
    // the override itself is untouched
    expect(override.colorNode ?? null).toBeNull();
  });
});
