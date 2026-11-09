import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { applyFoliageWind, WIND_LOCAL_ATTRIBUTE } from "../src/foliage-wind.js";
import { batchStaticMeshes, STATIC_BATCH_FLAG } from "../src/static-batch.js";

function plant(x: number, id: string): THREE.Group {
  const entity = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial({ name: "Leaves" }));
  mesh.position.y = 1;
  mesh.userData["entityId"] = id;
  mesh.userData[STATIC_BATCH_FLAG] = true;
  entity.add(mesh);
  entity.position.x = x;
  return entity;
}

describe("static batch: foliage wind", () => {
  it("merges wind plants sharing one material and keeps each vertex's model-local position", () => {
    const scene = new THREE.Scene();
    const a = plant(0, "a"), b = plant(10, "b");
    applyFoliageWind(a, { mode: "sway", strength: 0.1, speed: 1 });
    // a second placed copy shares the edited material (one material per model + wind)
    const shared = (a.children[0] as THREE.Mesh).material;
    (b.children[0] as THREE.Mesh).material = shared;
    scene.add(a, b);
    scene.updateMatrixWorld(true);
    const batch = batchStaticMeshes(scene)!;
    expect(batch.stats.merged).toBe(2);
    const merged = batch.group.children[0] as THREE.Mesh;
    expect(merged.material).toBe(shared);
    const local = merged.geometry.getAttribute(WIND_LOCAL_ATTRIBUTE);
    const world = merged.geometry.getAttribute("position");
    expect(local).toBeDefined();
    // the second plant's vertices sit at x ~ 10 in world space but keep their model-local x (|x| <= 0.5)
    let maxLocal = 0, maxWorld = 0;
    for (let i = 0; i < local.count; i++) {
      maxLocal = Math.max(maxLocal, Math.abs(local.getX(i)));
      maxWorld = Math.max(maxWorld, world.getX(i));
    }
    expect(maxLocal).toBeCloseTo(0.5);
    expect(maxWorld).toBeCloseTo(10.5);
    batch.dispose();
  });

  it("still skips other vertex-moving materials", () => {
    const scene = new THREE.Scene();
    const a = plant(0, "a"), b = plant(10, "b");
    const moving = new THREE.MeshStandardNodeMaterial();
    (moving as unknown as { positionNode: unknown }).positionNode = {};
    for (const p of [a, b]) (p.children[0] as THREE.Mesh).material = moving;
    scene.add(a, b);
    scene.updateMatrixWorld(true);
    expect(batchStaticMeshes(scene)).toBeNull();
  });
});
