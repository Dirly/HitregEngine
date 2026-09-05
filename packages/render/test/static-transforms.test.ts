import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import {
  freezeStaticSubtree,
  isFrozenStaticSubtree,
  refreshStaticSubtree,
  thawStaticSubtree,
} from "../src/index.js";

/** A scene → group → mesh chain, the shape every streamed chunk has. */
function chain(): { scene: THREE.Scene; group: THREE.Group; leaf: THREE.Object3D } {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const leaf = new THREE.Object3D();
  group.add(leaf);
  scene.add(group);
  group.position.set(10, 0, 0);
  leaf.position.set(1, 2, 3);
  return { scene, group, leaf };
}

const worldX = (o: THREE.Object3D): number => o.matrixWorld.elements[12]!;

describe("freezeStaticSubtree", () => {
  it("lays the subtree out once and then prunes it from the renderer's per-frame walk", () => {
    const { scene, group, leaf } = chain();
    freezeStaticSubtree(group);
    expect(isFrozenStaticSubtree(group)).toBe(true);
    expect(worldX(leaf)).toBe(11);
    // the renderer's walk: an unforced call on the scene, which three turns
    // into a forced one for every child because the Scene's own
    // `updateMatrix()` flags it as changed
    leaf.position.x = 100;
    scene.updateMatrixWorld();
    expect(worldX(leaf)).toBe(11); // pruned — the frozen contract
  });

  it("recomputes when an ancestor really moves", () => {
    const { scene, group, leaf } = chain();
    freezeStaticSubtree(group);
    scene.position.x = 5;
    scene.updateMatrixWorld();
    expect(worldX(group)).toBe(15); // the root itself, despite matrixWorldAutoUpdate being off
    expect(worldX(leaf)).toBe(16);
    // and settles again: a later unforced walk no longer touches the leaf
    leaf.position.x = 100;
    scene.updateMatrixWorld();
    expect(worldX(leaf)).toBe(16);
  });

  it("refreshStaticSubtree picks up changes inside the subtree without the parent moving", () => {
    const { scene, group, leaf } = chain();
    freezeStaticSubtree(group);
    const added = new THREE.Object3D();
    added.position.set(0, 0, 7);
    group.add(added);
    leaf.position.x = 100;
    group.position.x = 20;
    refreshStaticSubtree(group);
    expect(worldX(group)).toBe(20);
    expect(worldX(leaf)).toBe(120);
    expect(added.matrixWorld.elements[14]).toBe(7);
    expect(isFrozenStaticSubtree(group)).toBe(true);
    scene.updateMatrixWorld();
    expect(worldX(leaf)).toBe(120);
  });

  it("thawStaticSubtree returns the subtree to per-frame updates", () => {
    const { scene, group, leaf } = chain();
    freezeStaticSubtree(group);
    thawStaticSubtree(group);
    expect(isFrozenStaticSubtree(group)).toBe(false);
    leaf.position.x = 100;
    scene.updateMatrixWorld();
    expect(worldX(leaf)).toBe(110);
  });
});
