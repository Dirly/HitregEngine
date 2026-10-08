import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { InstancedProps } from "../src/instancing.js";
import { hideNonRenderingBranches, restoreNonRenderingBranches } from "../src/empty-batches.js";

describe("non-rendering branches during rendering", () => {
  const mesh = () => new InstancedProps(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 4);

  it("skips empty batches, restores visibility and immediately renders repopulated tiers", () => {
    const scene = new THREE.Scene(), batch = mesh(); scene.add(batch);
    batch.instanceCount = 0;
    const hidden = hideNonRenderingBranches(scene);
    expect(batch.visible).toBe(false);
    restoreNonRenderingBranches(hidden);
    expect(batch.visible).toBe(true);
    batch.instanceCount = 2;
    expect(hideNonRenderingBranches(scene)).toEqual([]);
    expect(batch.visible).toBe(true);
  });

  it("preserves authored visibility, layers, children and ordinary geometry", () => {
    const scene = new THREE.Scene(), hidden = mesh(), withLight = mesh(), empty = mesh();
    hidden.visible = false; hidden.instanceCount = 0; withLight.instanceCount = 0; empty.instanceCount = 0;
    withLight.add(new THREE.PointLight()); empty.layers.set(29);
    const ordinary = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    scene.add(hidden, withLight, empty, ordinary);
    const culled = hideNonRenderingBranches(scene);
    expect(culled).toEqual([empty]);
    expect(withLight.visible).toBe(true); expect(ordinary.visible).toBe(true);
    restoreNonRenderingBranches(culled);
    expect(hidden.visible).toBe(false); expect(empty.layers.mask).toBe(1 << 29);
  });

  it("prunes a whole empty rig without changing its bones, then sees newly attached content", () => {
    const scene = new THREE.Scene(), rig = new THREE.Group(), hip = new THREE.Bone(), hand = new THREE.Bone();
    scene.add(rig); rig.add(hip); hip.add(hand);
    hip.position.x = 3; hand.position.x = 2; scene.updateMatrixWorld();
    const hidden = hideNonRenderingBranches(scene);
    expect(hidden).toEqual([rig]);
    expect(hip.visible).toBe(true); expect(hand.visible).toBe(true);
    expect(hand.matrixWorld.elements[12]).toBe(5);
    expect(scene.visible).toBe(true);
    restoreNonRenderingBranches(hidden);
    const attachment = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    attachment.layers.set(29); hand.add(attachment);
    expect(hideNonRenderingBranches(scene)).toEqual([]);
    hand.remove(attachment);
    expect(hideNonRenderingBranches(scene)).toEqual([rig]);
  });

  it("keeps lights, lines, points, sprites and hidden branches with their original flags", () => {
    const scene = new THREE.Scene();
    const roots = [new THREE.PointLight(), new THREE.Line(), new THREE.Points(), new THREE.Sprite()].map(content => {
      const group = new THREE.Group(); group.add(content); scene.add(group); return group;
    });
    const alreadyHidden = new THREE.Group(), child = new THREE.Group();
    alreadyHidden.visible = false; alreadyHidden.add(child); scene.add(alreadyHidden);
    const hidden = hideNonRenderingBranches(scene);
    expect(hidden).toEqual([]);
    for (const root of roots) expect(root.visible).toBe(true);
    restoreNonRenderingBranches(hidden);
    expect(alreadyHidden.visible).toBe(false); expect(child.visible).toBe(true);
  });

  it("leaves LOD and bundle subtrees intact for their per-camera visibility policies", () => {
    const scene = new THREE.Scene(), lod = new THREE.LOD();
    const level = new THREE.Group(); lod.addLevel(level, 0);
    const bundle = new THREE.Group() as THREE.Group & { isBundleGroup: boolean };
    bundle.isBundleGroup = true; bundle.add(new THREE.Group()); scene.add(lod, bundle);
    expect(hideNonRenderingBranches(scene)).toEqual([]);
    expect(level.visible).toBe(true); expect(bundle.children[0]!.visible).toBe(true);
  });

  it("invalidates cached bone branches on deep attachments, removals and reparenting", () => {
    const scene = new THREE.Scene(), a = new THREE.Bone(), b = new THREE.Bone(), hand = new THREE.Bone();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    scene.add(a, b); a.add(hand);
    restoreNonRenderingBranches(hideNonRenderingBranches(scene)); // warm bone-only cache
    hand.add(mesh);
    let hidden = hideNonRenderingBranches(scene);
    expect(hidden).toEqual([b]); restoreNonRenderingBranches(hidden);
    b.add(hand);
    hidden = hideNonRenderingBranches(scene);
    expect(hidden).toEqual([a]); restoreNonRenderingBranches(hidden);
    hand.remove(mesh);
    hidden = hideNonRenderingBranches(scene);
    expect(hidden).toEqual([a, b]); restoreNonRenderingBranches(hidden);
  });

  it("prunes zero-layer content but retains shadow-only content and visible descendants", () => {
    const scene = new THREE.Scene(), zero = new THREE.Mesh(), shadow = new THREE.Mesh();
    zero.layers.mask = 0; shadow.layers.set(29); scene.add(zero, shadow);
    let hidden = hideNonRenderingBranches(scene);
    expect(hidden).toEqual([zero]); restoreNonRenderingBranches(hidden);
    zero.add(new THREE.PointLight());
    expect(hideNonRenderingBranches(scene)).toEqual([]);
  });

});
