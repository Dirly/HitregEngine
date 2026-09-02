import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { applyModelTextureFilter } from "../src/material-maps.js";

/**
 * `mesh.source.textureFilter` re-filters a loaded model's textures. What has
 * to hold: every map slot is covered, a texture shared by two materials is
 * touched once, and only the filters change — the file's colour space and
 * wrap modes are not ours to second-guess.
 */
describe("applyModelTextureFilter", () => {
  const model = () => {
    const shared = new THREE.Texture();
    shared.colorSpace = THREE.SRGBColorSpace;
    shared.wrapS = THREE.ClampToEdgeWrapping;
    const normal = new THREE.Texture();
    const a = new THREE.MeshStandardMaterial({ map: shared, normalMap: normal });
    const b = new THREE.MeshStandardMaterial({ map: shared });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), a), new THREE.Mesh(new THREE.BoxGeometry(), [b, a]));
    return { root, shared, normal };
  };

  it("sets nearest magnification with mipmapped minification on every map, once per texture", () => {
    const { root, shared, normal } = model();
    expect(applyModelTextureFilter(root, "nearest")).toBe(2);
    for (const t of [shared, normal]) {
      expect(t.magFilter).toBe(THREE.NearestFilter);
      expect(t.minFilter).toBe(THREE.NearestMipmapLinearFilter);
    }
    expect(shared.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(shared.wrapS).toBe(THREE.ClampToEdgeWrapping);
  });

  it("goes back to linear", () => {
    const { root, shared } = model();
    applyModelTextureFilter(root, "nearest");
    applyModelTextureFilter(root, "linear");
    expect(shared.magFilter).toBe(THREE.LinearFilter);
    expect(shared.minFilter).toBe(THREE.LinearMipmapLinearFilter);
  });

  it("ignores materials without textures", () => {
    const root = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    expect(applyModelTextureFilter(root, "nearest")).toBe(0);
  });
});
