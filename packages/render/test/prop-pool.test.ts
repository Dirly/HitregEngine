import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { FoliageLodSystem, type InstancedPropBatch } from "../src/foliage-lod.js";
import { InstancedProps } from "../src/instancing.js";

/** A dynamic (pool-page style) batch of `capacity` empty logical slots. */
function makePage(capacity: number, withLocal = false): InstancedPropBatch {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  const near = new InstancedProps(geometry, material, capacity);
  const far = new InstancedProps(geometry, material, capacity);
  const positions = Array.from({ length: capacity }, () => new THREE.Vector3());
  const matrices = Array.from({ length: capacity }, () => new THREE.Matrix4());
  return {
    near: [near],
    far,
    positions,
    matrices,
    dynamic: true,
    ...(withLocal ? { localMatrices: [new THREE.Matrix4().makeTranslation(0, 5, 0)] } : {}),
  };
}

function place(batch: InstancedPropBatch, i: number, x: number): void {
  batch.matrices[i]!.makeTranslation(x, 0, 0);
  batch.positions[i]!.set(x, 0, 0);
}

function xAt(mesh: InstancedProps, slot: number): number {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(slot, m);
  return new THREE.Vector3().setFromMatrixPosition(m).x;
}

describe("FoliageLodSystem dynamic batches", () => {
  it("draws nothing for a page with no live instances, however many slots it has", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = makePage(8);
    system.register(batch);
    system.update(new THREE.Vector3());
    expect(batch.near[0]!.instanceCount).toBe(0);
    expect(batch.far.instanceCount).toBe(0);
  });

  it("classifies an added instance immediately against the last camera", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = makePage(8);
    system.register(batch);
    system.update(new THREE.Vector3(0, 0, 0));
    place(batch, 3, 5);
    system.addInstance(batch, 3);
    place(batch, 5, 500);
    system.addInstance(batch, 5);
    // no update() in between: both are already in their tiers
    expect(batch.near[0]!.instanceCount).toBe(1);
    expect(batch.far.instanceCount).toBe(1);
    expect(xAt(batch.near[0]!, 0)).toBe(5);
    expect(xAt(batch.far, 0)).toBe(500);
  });

  it("removing an instance compacts its tier and frees the slot for reuse", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = makePage(8);
    system.register(batch);
    system.update(new THREE.Vector3(0, 0, 0));
    for (const [i, x] of [[0, 1], [1, 2], [2, 3]] as const) {
      place(batch, i, x);
      system.addInstance(batch, i);
    }
    expect(batch.near[0]!.instanceCount).toBe(3);
    system.removeInstance(batch, 0); // the first slot: the last occupant swaps in
    expect(batch.near[0]!.instanceCount).toBe(2);
    const xs = [0, 1].map((slot) => xAt(batch.near[0]!, slot)).sort();
    expect(xs).toEqual([2, 3]);
    // the round-robin never resurrects a dead slot
    for (let n = 0; n < 5; n++) system.update(new THREE.Vector3(0, 0, 0));
    expect(batch.near[0]!.instanceCount).toBe(2);
    // re-adding the same logical index works
    place(batch, 0, 9);
    system.addInstance(batch, 0);
    expect(batch.near[0]!.instanceCount).toBe(3);
    expect(system.logicalIndexAt(batch, batch.near[0]!, 2)).toBe(0);
  });

  it("applies a submesh's local matrix to near slots but not to the far proxy", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = makePage(4, true);
    system.register(batch);
    system.update(new THREE.Vector3(0, 0, 0));
    place(batch, 0, 1);
    system.addInstance(batch, 0);
    place(batch, 1, 300);
    system.addInstance(batch, 1);
    const near = new THREE.Matrix4();
    batch.near[0]!.getMatrixAt(0, near);
    expect(new THREE.Vector3().setFromMatrixPosition(near).y).toBe(5);
    const far = new THREE.Matrix4();
    batch.far.getMatrixAt(0, far);
    expect(new THREE.Vector3().setFromMatrixPosition(far).y).toBe(0);
  });

  it("alwaysNear batches never leave the near tier", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = { ...makePage(4), alwaysNear: true };
    system.register(batch);
    system.update(new THREE.Vector3(0, 0, 0));
    place(batch, 0, 1000);
    system.addInstance(batch, 0);
    system.update(new THREE.Vector3(0, 0, 0));
    expect(batch.near[0]!.instanceCount).toBe(1);
    expect(batch.far.instanceCount).toBe(0);
  });
});
