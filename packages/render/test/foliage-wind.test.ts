import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  applyFoliageFade,
  applyFoliageWind,
  asNodeMaterial,
  cloneMaterial,
  setFoliageFade,
  FOLIAGE_FADE,
  FOLIAGE_WIND,
  windMaterialMatches,
} from "../src/index.js";

/** A stand-in for a Blockbench plant: cutout material, standing on its base. */
function plant(alphaTest = 0.05): THREE.Object3D {
  const geometry = new THREE.BoxGeometry(1, 2, 1);
  geometry.translate(0, 1, 0); // base on y=0, like a normalized model pivot
  const material = new THREE.MeshStandardMaterial({ alphaTest, side: THREE.DoubleSide });
  material.color.setHex(0x4488ff);
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, material));
  return root;
}

describe("node-material conversion", () => {
  it("swaps a loaded standard material for its node equivalent", () => {
    const source = new THREE.MeshStandardMaterial();
    expect((source as unknown as { isNodeMaterial?: boolean }).isNodeMaterial).toBeFalsy();
    const converted = asNodeMaterial(source);
    expect(converted.isNodeMaterial).toBe(true);
    expect(converted.type).toBe("MeshStandardNodeMaterial");
  });

  /**
   * The one property `Material.copy()` silently drops. On a leaf card losing it
   * turns every cutout into an opaque rectangle, and nothing warns.
   */
  it("carries alphaTest across, which copy() does not", () => {
    const source = new THREE.MeshStandardMaterial({ alphaTest: 0.42 });
    expect(new THREE.MeshStandardNodeMaterial().copy(source).alphaTest).toBe(0); // the trap
    expect(asNodeMaterial(source).alphaTest).toBe(0.42); // what we do instead
  });

  /**
   * The same trap one step down the pipeline, and the one that actually shipped
   * a bug: the instanced path caches a per-submesh CLONE, so a cutout model
   * arrived on screen as solid boxes with nothing logged anywhere.
   */
  it("keeps alphaTest across a clone of a converted material", () => {
    const converted = asNodeMaterial(new THREE.MeshStandardMaterial({ alphaTest: 0.05 }));
    expect(converted.clone().alphaTest).toBe(0); // the trap
    expect(cloneMaterial(converted).alphaTest).toBe(0.05); // what we do instead
  });

  it("leaves a material that is already a node material alone", () => {
    const already = new THREE.MeshStandardNodeMaterial();
    expect(asNodeMaterial(already)).toBe(already);
  });
});

describe("foliage wind", () => {
  it("attaches a vertex displacement and tags the material", () => {
    const root = plant();
    expect(applyFoliageWind(root, { mode: "sway", strength: 0.1, speed: 1 })).toBe(1);
    const mesh = root.children[0] as THREE.Mesh;
    const material = mesh.material as THREE.NodeMaterial;
    expect(material.isNodeMaterial).toBe(true);
    expect(material.positionNode).toBeTruthy();
    expect(material.userData[FOLIAGE_WIND]).toBe(true);
  });

  it("is idempotent, so a shared glTF is never wired twice", () => {
    const root = plant();
    expect(applyFoliageWind(root, { mode: "ripple", strength: 0.05, speed: 1 })).toBe(1);
    expect(applyFoliageWind(root, { mode: "ripple", strength: 0.05, speed: 1 })).toBe(0);
  });

  it("does nothing at zero strength rather than compiling a dead graph", () => {
    const root = plant();
    expect(applyFoliageWind(root, { mode: "sway", strength: 0, speed: 1 })).toBe(0);
    expect((root.children[0] as THREE.Mesh).material).toBeInstanceOf(THREE.MeshStandardMaterial);
  });

  it("keeps the cutout alive — the whole point of preserving alphaTest", () => {
    const root = plant(0.3);
    applyFoliageWind(root, { mode: "sway", strength: 0.1, speed: 1 });
    expect(((root.children[0] as THREE.Mesh).material as THREE.Material).alphaTest).toBe(0.3);
  });
});

describe("foliage camera fade", () => {
  it("wires an opacity node onto cutout materials", () => {
    const root = plant();
    expect(applyFoliageFade(root)).toBe(1);
    const material = (root.children[0] as THREE.Mesh).material as THREE.NodeMaterial;
    expect(material.opacityNode).toBeTruthy();
    expect(material.userData[FOLIAGE_FADE]).toBe(true);
  });

  /**
   * Scoped to cutouts on purpose: a solid trunk or wall between camera and
   * character is an occlusion the player reads correctly, and dissolving it
   * would put holes in the level.
   */
  it("skips opaque materials", () => {
    const root = plant(0);
    expect(applyFoliageFade(root)).toBe(0);
  });

  it("stacks with wind on the same material", () => {
    const root = plant();
    applyFoliageWind(root, { mode: "sway", strength: 0.1, speed: 1 });
    expect(applyFoliageFade(root)).toBe(1);
    const material = (root.children[0] as THREE.Mesh).material as THREE.NodeMaterial;
    expect(material.positionNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
  });

  it("takes a player position and an enable flag without throwing", () => {
    expect(() =>
      setFoliageFade({ enabled: true, player: new THREE.Vector3(1, 2, 3), radius: 2, strength: 0.9 }),
    ).not.toThrow();
    setFoliageFade({ enabled: false });
  });
});

describe("foliage wind material filter", () => {
  /** A tree the way Blockbench exports one: trunk and leaves as two materials, only the leaf TEXTURE named. */
  function tree(): THREE.Object3D {
    const root = new THREE.Group();
    const trunk = new THREE.MeshStandardMaterial({ alphaTest: 0.05 });
    trunk.map = new THREE.Texture();
    trunk.map.name = "pasted";
    const leaves = new THREE.MeshStandardMaterial({ alphaTest: 0.05 });
    leaves.map = new THREE.Texture();
    leaves.map.name = "Leaves";
    root.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 4, 0.3), trunk));
    root.add(new THREE.Mesh(new THREE.BoxGeometry(3, 2, 3), leaves));
    return root;
  }

  it("moves only the materials whose texture name matches, by name not by height", () => {
    const root = tree();
    expect(applyFoliageWind(root, { mode: "ripple", strength: 0.05, speed: 1, materials: "leaves" })).toBe(1);
    const trunk = (root.children[0] as THREE.Mesh).material as THREE.Material;
    const leaves = (root.children[1] as THREE.Mesh).material as THREE.NodeMaterial;
    expect(trunk.userData[FOLIAGE_WIND]).toBeUndefined();
    expect(leaves.userData[FOLIAGE_WIND]).toBe(true);
  });

  it("matches a material's own name too, and nothing when nothing is named", () => {
    const named = new THREE.MeshStandardMaterial();
    named.name = "Tree_Leaves_Mat";
    expect(windMaterialMatches(named, "leaves")).toBe(true);
    const root = tree();
    expect(applyFoliageWind(root, { mode: "ripple", strength: 0.05, speed: 1, materials: "needles" })).toBe(0);
  });
});
