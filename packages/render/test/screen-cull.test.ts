import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { hideNonRenderingBranches, restoreNonRenderingBranches } from "../src/empty-batches.js";
import { freezeStaticSubtree } from "../src/static-transforms.js";

// pxPerUnit for a 900-px-tall view at 70° fov
const PX = 900 / 2 / Math.tan((70 * Math.PI) / 360);
const cullAt = (eye: THREE.Vector3, minRadiusPx = 2.5) => ({ eye, pxPerUnit: PX, minRadiusPx });
const box = (size = 1) => {
  const geometry = new THREE.BoxGeometry(size, size, size);
  geometry.computeBoundingSphere();
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
};

describe("screen-size cull", () => {
  it("hides a tiny far mesh for the frame only and keeps a near one", () => {
    const scene = new THREE.Scene(), near = box(), far = box();
    near.position.set(0, 0, -10); far.position.set(0, 0, -2000);
    scene.add(near, far); scene.updateMatrixWorld();
    const hidden = hideNonRenderingBranches(scene, undefined, cullAt(new THREE.Vector3()));
    expect(far.visible).toBe(false);
    expect(near.visible).toBe(true);
    restoreNonRenderingBranches(hidden);
    expect(far.visible).toBe(true);
  });

  it("never judges an instanced forest by one tree's geometry sphere", () => {
    const scene = new THREE.Scene();
    const forest = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 2);
    forest.geometry.computeBoundingSphere();
    // instances spread 400 m apart: the geometry sphere alone looks like a 1 m box
    forest.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-200, 0, 0));
    forest.setMatrixAt(1, new THREE.Matrix4().makeTranslation(200, 0, 0));
    forest.position.set(0, 0, -2000);
    scene.add(forest); scene.updateMatrixWorld();
    const eye = new THREE.Vector3();
    // no own sphere yet: never size-culled
    let hidden = hideNonRenderingBranches(scene, undefined, cullAt(eye));
    expect(forest.visible).toBe(true);
    restoreNonRenderingBranches(hidden);
    // with its own (instance-covering) sphere it is judged by that, and is big enough
    forest.computeBoundingSphere();
    hidden = hideNonRenderingBranches(scene, undefined, cullAt(eye));
    expect(forest.visible).toBe(true);
    restoreNonRenderingBranches(hidden);
  });

  it("culls a whole far static group in one test, but never one holding a visible light", () => {
    const scene = new THREE.Scene();
    const lamp = new THREE.Group(); lamp.add(box(0.5), box(0.3));
    const lit = new THREE.Group(); lit.add(box(0.5), new THREE.PointLight());
    lamp.position.set(0, 0, -3000); lit.position.set(5, 0, -3000);
    scene.add(lamp, lit); scene.updateMatrixWorld();
    freezeStaticSubtree(lamp); freezeStaticSubtree(lit);
    const hidden = hideNonRenderingBranches(scene, undefined, cullAt(new THREE.Vector3()));
    expect(hidden).toContain(lamp);
    expect(lit.visible).toBe(true);
    restoreNonRenderingBranches(hidden);
    expect(lamp.visible).toBe(true);
  });

  it("collects caster-free branches for shadow passes, leaving casters and lights", () => {
    const scene = new THREE.Scene();
    const caster = box(); caster.castShadow = true;
    const plain = new THREE.Group(); plain.add(box());
    const withLight = new THREE.Group(); withLight.add(box(), new THREE.PointLight());
    scene.add(caster, plain, withLight);
    const shadowless: THREE.Object3D[] = [];
    const hidden = hideNonRenderingBranches(scene, shadowless);
    // the plain group, and the non-casting mesh beside the light; never the
    // caster, the light or the group that holds it
    expect(shadowless).toEqual([plain, withLight.children[0]]);
    expect(shadowless).not.toContain(caster);
    expect(shadowless).not.toContain(withLight);
    restoreNonRenderingBranches(hidden);
  });
});

describe("frozen-subtree verdict reuse", () => {
  it("re-tests a frozen group's props against the camera only every few walks, never a moved one", async () => {
    const { freezeStaticSubtree, refreshStaticSubtree } = await import("../src/static-transforms.js");
    const { resetFrozenVerdicts, frozenVerdictLife } = await import("../src/empty-batches.js");
    resetFrozenVerdicts();
    const scene = new THREE.Scene();
    const town = new THREE.Group();
    const prop = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshBasicMaterial());
    const big = new THREE.Mesh(new THREE.BoxGeometry(50, 50, 50), new THREE.MeshBasicMaterial()); // keeps the group itself un-culled
    prop.geometry.computeBoundingSphere(); big.geometry.computeBoundingSphere();
    town.add(prop, big); scene.add(town);
    scene.updateMatrixWorld(true);
    freezeStaticSubtree(town);
    const far = new THREE.Vector3(0, 0, 400), near = new THREE.Vector3(0, 0, 1);
    // far: the tiny prop is under 2.5 px and hidden
    let hidden = hideNonRenderingBranches(scene, undefined, cullAt(far));
    expect(hidden).toContain(prop);
    restoreNonRenderingBranches(hidden);
    // the camera steps up to it: the cached verdict still hides it while it lives (staggered per root)...
    if (frozenVerdictLife(town) > 1) {
      hidden = hideNonRenderingBranches(scene, undefined, cullAt(near));
      expect(hidden).toContain(prop);
      restoreNonRenderingBranches(hidden);
    }
    // ...and within four walks it is re-tested and drawn
    let shown = false;
    for (let i = 0; i < 4 && !shown; i++) {
      hidden = hideNonRenderingBranches(scene, undefined, cullAt(near));
      shown = !hidden.includes(prop);
      restoreNonRenderingBranches(hidden);
    }
    expect(shown).toBe(true);
    // a change inside the subtree (its version bumps) is seen on the very next walk
    hidden = hideNonRenderingBranches(scene, undefined, cullAt(far));
    restoreNonRenderingBranches(hidden);
    prop.scale.setScalar(400);
    refreshStaticSubtree(town);
    hidden = hideNonRenderingBranches(scene, undefined, cullAt(far));
    expect(hidden).not.toContain(prop);
    restoreNonRenderingBranches(hidden);
  });
});
