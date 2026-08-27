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

/** Same 3-instance layout (x = 0, 50, 100) WITH a mid tier, optionally
 * reporting the mid tier's geometric error and a uniform instance scale. */
function makeMidBatch(midError?: number, scale = 1): InstancedPropBatch {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  const count = 3;
  const near = new THREE.InstancedMesh(geometry, material, count);
  const mid = new THREE.InstancedMesh(geometry, material, count);
  const far = new THREE.InstancedMesh(geometry, material, count);
  const positions = [0, 50, 100].map((x) => new THREE.Vector3(x, 0, 0));
  const matrices = positions.map((p) =>
    new THREE.Matrix4().compose(p, new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)),
  );
  return { near: [near], mid: [mid], far, positions, matrices, ...(midError !== undefined ? { midError } : {}) };
}

describe("FoliageLodSystem error-driven near→mid threshold", () => {
  const origin = new THREE.Vector3(0, 0, 0);

  it("falls back to the fixed nearDistance for a batch that reports no mid-tier error", () => {
    const system = new FoliageLodSystem(200, 0.85, 60);
    const batch = makeMidBatch();
    system.register(batch);
    system.update(origin);
    // 0 and 50 are inside 60 → near; 100 is between 60 and 200 → mid
    expect(system.tierCounts()).toEqual({ near: 2, mid: 1, far: 0 });
    expect(system.nearThresholdFor(batch)).toBe(60);
  });

  it("switches to the mid tier where its geometric error projects below the pixel budget", () => {
    // viewport 1000 px, fov 90° (tan 45° = 1), 2 px budget ⇒ d = error·1000 / (2·1·2) = 250·error
    const system = new FoliageLodSystem(200, 0.85, 60, 2);
    system.setProjection(1000, 90);
    const batch = makeMidBatch(0.3); // ⇒ 75 m: further out than the 60 m fallback
    system.register(batch);
    expect(system.nearThresholdFor(batch)).toBeCloseTo(75, 6);
    system.update(origin);
    expect(system.tierCounts()).toEqual({ near: 2, mid: 1, far: 0 });
  });

  it("re-derives every threshold when the projection changes", () => {
    const system = new FoliageLodSystem(200, 0.85, 60, 2);
    system.setProjection(1000, 90);
    const batch = makeMidBatch(0.3); // 75 m
    system.register(batch);
    system.update(origin); // near: 0, 50; mid: 100

    // half the viewport height ⇒ the same error is half as many pixels ⇒ 37.5 m
    system.setProjection(500, 90);
    expect(system.nearThresholdFor(batch)).toBeCloseTo(37.5, 6);
    system.update(origin);
    // instance at 50 was near; 50² > 37.5² so it drops to mid despite hysteresis
    expect(system.tierCounts()).toEqual({ near: 1, mid: 2, far: 0 });
  });

  it("scales the error by the largest instance scale in the batch", () => {
    const system = new FoliageLodSystem(200, 0.85, 60, 2);
    system.setProjection(1000, 90);
    const batch = makeMidBatch(0.15, 2); // 0.15 model units × scale 2 = 0.3 world ⇒ 75 m
    system.register(batch);
    expect(system.nearThresholdFor(batch)).toBeCloseTo(75, 6);
  });

  it("clamps: a mid tier too rough to ever be sub-pixel never displaces the near tier before lodDistance", () => {
    const system = new FoliageLodSystem(200, 0.85, 60, 2);
    system.setProjection(1000, 90);
    const batch = makeMidBatch(10); // ⇒ 2500 m, clamped to lodDistance
    system.register(batch);
    expect(system.nearThresholdFor(batch)).toBe(200);
    system.update(origin);
    expect(system.tierCounts()).toEqual({ near: 3, mid: 0, far: 0 });
  });

  it("clamps: a near-perfect mid tier still yields the real geometry right at the camera", () => {
    const system = new FoliageLodSystem(200, 0.85, 60, 2);
    system.setProjection(1000, 90);
    const batch = makeMidBatch(0.001); // ⇒ 0.25 m, floored
    system.register(batch);
    expect(system.nearThresholdFor(batch)).toBe(5);
  });
});
