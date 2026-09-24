import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { applyModelMap, applyModelPartMask, modelPartIndex, partMaskFromNames } from "../src/ubermesh.js";

/** Three one-triangle parts in one geometry, part index in uv1 — what unwrap-weapon writes. */
function uberModel(indexed: boolean): { root: THREE.Group; mesh: THREE.Mesh; shared: THREE.BufferGeometry } {
  const positions: number[] = [];
  const part: number[] = [];
  for (let p = 0; p < 3; p++) {
    positions.push(p, 0, 0, p + 1, 0, 0, p, 1 + p, 0);
    part.push(p, 0, p, 0, p, 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv1", new THREE.Float32BufferAttribute(part, 2));
  if (indexed) geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.userData["parts"] = { Handle: 0, Blade1: 1, Blade2: 2 };
  const root = new THREE.Group();
  root.add(mesh);
  return { root, mesh, shared: geometry };
}

describe("ubermesh looks on a single model", () => {
  it("resolves part names to a mask and reports unknown ones", () => {
    const { root } = uberModel(true);
    const index = modelPartIndex(root)!;
    expect(partMaskFromNames(index, ["Handle", "Blade2"])).toEqual({ mask: 0b101, missing: [] });
    expect(partMaskFromNames(index, ["Blade1", "Pommel9"])).toEqual({ mask: 0b010, missing: ["Pommel9"] });
  });

  for (const indexed of [true, false]) {
    it(`keeps only the shown parts' triangles (${indexed ? "indexed" : "non-indexed"})`, () => {
      const { root, mesh, shared } = uberModel(indexed);
      applyModelPartMask(root, 0b101);
      expect(Array.from(mesh.geometry.getIndex()!.array)).toEqual([0, 1, 2, 6, 7, 8]);
      // the loaded geometry is shared with every other user of the asset
      expect(mesh.geometry).not.toBe(shared);
      expect(shared.getIndex()?.count ?? 9).toBe(9);
      // a later look starts from the whole model, not from the last trim
      applyModelPartMask(root, 0b010);
      expect(Array.from(mesh.geometry.getIndex()!.array)).toEqual([3, 4, 5]);
      applyModelPartMask(root, 0);
      expect(mesh.visible).toBe(false);
      applyModelPartMask(root, 0b001);
      expect(mesh.visible).toBe(true);
    });
  }

  it("ignores a model without a part index", () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    expect(applyModelPartMask(root, 1)).toBe(0);
  });

  it("swaps the map on the model's own material copy, keeping its other settings", () => {
    const { root, mesh } = uberModel(true);
    const original = mesh.material as THREE.MeshStandardMaterial;
    original.alphaTest = 0.5;
    original.side = THREE.DoubleSide;
    const base = new THREE.Texture();
    base.magFilter = THREE.NearestFilter;
    original.map = base;
    const theme = new THREE.Texture();
    applyModelMap(root, theme);
    const swapped = mesh.material as THREE.MeshStandardMaterial;
    expect(swapped).not.toBe(original);
    expect(original.map).toBe(base);
    expect(swapped.map).toBe(theme);
    expect(swapped.alphaTest).toBe(0.5);
    expect(swapped.side).toBe(THREE.DoubleSide);
    expect(theme.magFilter).toBe(THREE.NearestFilter);
    // the second swap reuses the copy rather than cloning again
    applyModelMap(root, new THREE.Texture());
    expect(mesh.material).toBe(swapped);
  });
});
