import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { FoliageLodSystem, type InstancedPropBatch } from "../src/foliage-lod.js";

/** A 3-instance batch (no mid tier) at x = 0, 50, 100 — spread far enough
 * apart that lodDistance=20 cleanly separates them into distinct tiers. */
function makeBatch(): InstancedPropBatch {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  const count = 3;
  const near = new THREE.InstancedMesh(geometry, material, count);
  const far = new THREE.InstancedMesh(geometry, material, count);
  const positions = [0, 50, 100].map((x) => new THREE.Vector3(x, 0, 0));
  const matrices = positions.map((p) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
  return { near: [near], far, positions, matrices };
}

function readTranslationX(mesh: THREE.InstancedMesh, slot: number): number {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(slot, m);
  return new THREE.Vector3().setFromMatrixPosition(m).x;
}

describe("FoliageLodSystem tier compaction", () => {
  it("keeps mesh.count equal to the tier's actual instance count, not the total", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = makeBatch();
    system.register(batch);

    // camera at x=0: instance 0 is near (dist 0), 1 and 2 are far (dist 50, 100)
    system.update(new THREE.Vector3(0, 0, 0));

    expect(batch.near[0]!.count).toBe(1);
    expect(batch.far.count).toBe(2);
    expect(system.tierCounts()).toEqual({ near: 1, mid: 0, far: 2 });
    expect(readTranslationX(batch.near[0]!, 0)).toBe(0);
  });

  it("swap-compacts correctly when the camera moves and tiers swap membership", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = makeBatch();
    system.register(batch);
    system.update(new THREE.Vector3(0, 0, 0)); // instance 0 near; 1, 2 far

    // camera moves to x=100: instance 2 becomes near, instance 0 becomes far,
    // instance 1 stays far — exercises swap-remove on BOTH tiers at once
    system.update(new THREE.Vector3(100, 0, 0));

    expect(batch.near[0]!.count).toBe(1);
    expect(batch.far.count).toBe(2);
    expect(system.tierCounts()).toEqual({ near: 1, mid: 0, far: 2 });
    // the near buffer must contain instance 2 (x=100), not stale instance 0 data
    expect(readTranslationX(batch.near[0]!, 0)).toBe(100);
    // the far buffer must contain exactly {instance 0, instance 1} — x in {0, 50}
    const farXs = [0, 1].map((slot) => readTranslationX(batch.far, slot)).sort((a, b) => a - b);
    expect(farXs).toEqual([0, 50]);
  });

  it("register() zeroes every mesh's count until update() classifies instances", () => {
    const system = new FoliageLodSystem();
    const batch = makeBatch();
    system.register(batch);
    expect(batch.near[0]!.count).toBe(0);
    expect(batch.far.count).toBe(0);
  });

  it("unregister() drops the batch from future updates without touching its meshes", () => {
    const system = new FoliageLodSystem(20, 0.85, 40);
    const batch = makeBatch();
    system.register(batch);
    system.update(new THREE.Vector3(0, 0, 0));
    system.unregister(batch);
    system.update(new THREE.Vector3(100, 0, 0)); // must not throw or touch `batch`
    expect(system.tierCounts()).toEqual({ near: 0, mid: 0, far: 0 });
  });
});
