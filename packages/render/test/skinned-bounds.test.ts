import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { enableSkinnedBounds, beginSkinnedBoundsFrame, endSkinnedBoundsFrame } from "../src/skinned-bounds.js";

function fixture(detached = false) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 2, 0, 1, 2, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, .7, .3, 0, 0, .2, .8, 0, 0, 0, 1, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const a = new THREE.Bone(), b = new THREE.Bone(); a.add(b); b.position.y = 1;
  const scene = new THREE.Scene(), parent = new THREE.Group(); scene.add(parent); parent.add(mesh);
  if (detached) { scene.add(a); mesh.bindMode = THREE.DetachedBindMode; } else mesh.add(a);
  scene.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([a, b]));
  enableSkinnedBounds(mesh);
  return { mesh, scene, parent, a, b };
}

function enclosesPose(mesh: THREE.SkinnedMesh) {
  const bounds = mesh.boundingSphere!, vertex = new THREE.Vector3();
  const worldBounds = bounds.clone().applyMatrix4(mesh.matrixWorld);
  expect(Number.isFinite(bounds.radius)).toBe(true);
  for (let i = 0; i < mesh.geometry.getAttribute("position").count; i++) {
    mesh.getVertexPosition(i, vertex);
    expect(bounds.containsPoint(vertex), `vertex ${i} outside posed bound`).toBe(true);
    expect(worldBounds.containsPoint(vertex.applyMatrix4(mesh.matrixWorld)), `vertex ${i} outside world bound`).toBe(true);
  }
}

describe("conservative skinned bounds", () => {
  it("refreshes between render frames, nested renders and out-of-render queries", () => {
    const { mesh, b, scene } = fixture();
    const frame = beginSkinnedBoundsFrame();
    try {
      const before = mesh.boundingSphere!.clone();
      b.position.x = 20; scene.updateMatrixWorld(true);
      const nested = beginSkinnedBoundsFrame();
      try { enclosesPose(mesh); expect(mesh.boundingSphere!.center.x).toBeGreaterThan(before.center.x); }
      finally { endSkinnedBoundsFrame(nested); }
      enclosesPose(mesh);
    } finally { endSkinnedBoundsFrame(frame); }
    b.position.x = -20; scene.updateMatrixWorld(true); enclosesPose(mesh);
    const next = beginSkinnedBoundsFrame();
    try { enclosesPose(mesh); } finally { endSkinnedBoundsFrame(next); }
  });
  for (const detached of [false, true]) it(`encloses blended poses, nonuniform scales and teleports (${detached ? "detached" : "attached"})`, () => {
    const { mesh, scene, parent, a, b } = fixture(detached);
    for (let i = 0; i < 40; i++) {
      parent.position.set(4100 + i * 300, 20, -2200);
      parent.rotation.y = i * .2; parent.scale.set(.8, 1.9, 1.1);
      mesh.rotation.z = i * .12; mesh.scale.set(1.3, .7, .9);
      a.rotation.z = i * .17; b.rotation.set(i * .21, i * .1, -i * .19);
      b.scale.set(.6 + i * .04, 1.2, .8); b.position.x = Math.sin(i) * 8;
      scene.updateMatrixWorld(true); enclosesPose(mesh);
    }
  });

  it("culls off-screen characters, then reveals them after teleport or an extended pose", () => {
    const { mesh, scene, parent, b } = fixture();
    const camera = new THREE.PerspectiveCamera(55, 1, .1, 100);
    camera.position.set(0, 1, 10); camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    parent.position.x = 50; scene.updateMatrixWorld(true); expect(frustum.intersectsObject(mesh)).toBe(false);
    b.position.x = -50; scene.updateMatrixWorld(true); expect(frustum.intersectsObject(mesh)).toBe(true); enclosesPose(mesh);
    b.position.x = 0; parent.position.x = 0; scene.updateMatrixWorld(true); expect(frustum.intersectsObject(mesh)).toBe(true);
  });

  it("refreshes geometry edits and accepts positive non-normalized weights", () => {
    const { mesh, scene, parent, b } = fixture();
    parent.position.set(6000, 10, -3000); b.rotation.z = 1; scene.updateMatrixWorld(true); enclosesPose(mesh);
    const position = mesh.geometry.getAttribute("position"), weights = mesh.geometry.getAttribute("skinWeight");
    position.setXYZ(3, 40, 30, 12); position.needsUpdate = true;
    weights.setXYZW(2, .3, .9, 0, 0); weights.needsUpdate = true;
    enclosesPose(mesh);
    // Match the shader's vec4 arithmetic, including an unnormalized w.
    const source = new THREE.Vector4(position.getX(2), position.getY(2), position.getZ(2), 1).applyMatrix4(mesh.bindMatrix);
    const result = new THREE.Vector4(0, 0, 0, 0), indices = mesh.geometry.getAttribute("skinIndex");
    for (let lane = 0; lane < 4; lane++) {
      const bone = indices.getComponent(2, lane);
      result.add(source.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(mesh.skeleton.bones[bone]!.matrixWorld, mesh.skeleton.boneInverses[bone]!)).multiplyScalar(weights.getComponent(2, lane)));
    }
    result.applyMatrix4(mesh.bindMatrixInverse);
    expect(mesh.boundingSphere!.containsPoint(new THREE.Vector3(result.x, result.y, result.z))).toBe(true);
  });

  it("does not share posed bounds between skeleton clones using one geometry", () => {
    const one = fixture(), two = fixture(); two.mesh.geometry = one.mesh.geometry;
    one.b.position.x = 20; two.b.position.x = -20;
    one.scene.updateMatrixWorld(true); two.scene.updateMatrixWorld(true);
    enclosesPose(one.mesh); enclosesPose(two.mesh);
    expect(one.mesh.boundingSphere!.center.x).toBeGreaterThan(0);
    expect(two.mesh.boundingSphere!.center.x).toBeLessThan(0);
  });

  for (const relative of [false, true]) it(`encloses changing, mixed morphs before skinning (relative=${relative})`, () => {
    const { mesh, scene, parent, b } = fixture();
    mesh.geometry.morphTargetsRelative = relative;
    const first = mesh.geometry.getAttribute("position").clone(), second = first.clone();
    first.setXYZ(0, -15, 3, 4); second.setXYZ(3, 30, 12, -8);
    mesh.geometry.morphAttributes["position"] = [first, second]; mesh.updateMorphTargets();
    parent.position.set(4500, 30, -2200); b.rotation.z = .7;
    scene.updateMatrixWorld(true);
    for (const weight of [-2, -.5, 0, .5, 1, 2]) {
      mesh.morphTargetInfluences![0] = weight; mesh.morphTargetInfluences![1] = 1.2;
      enclosesPose(mesh);
    }
    first.setXYZ(1, -90, 22, 32); first.needsUpdate = true; enclosesPose(mesh);
    // Changing the attribute list or its interpretation invalidates the cache.
    mesh.geometry.morphAttributes["position"] = [second]; mesh.updateMorphTargets();
    mesh.morphTargetInfluences![0] = 1; mesh.geometry.morphTargetsRelative = !relative; enclosesPose(mesh);
  });

  it("keeps invalid weights and unknown shader deformation always drawable", () => {
    const first = fixture(); first.mesh.material = new THREE.MeshBasicNodeMaterial();
    first.mesh.material.positionNode = {} as THREE.Node;
    expect(first.mesh.boundingSphere!.radius).toBe(Infinity);
    const second = fixture(); const weights = second.mesh.geometry.getAttribute("skinWeight"); weights.setX(0, -1); weights.needsUpdate = true;
    expect(second.mesh.boundingSphere!.radius).toBe(Infinity);
  });

  it("fails open only while an incomplete imported morph is active", () => {
    const { mesh } = fixture();
    mesh.geometry.morphAttributes["position"] = [new THREE.Float32BufferAttribute([0, 1, 0], 3)];
    mesh.updateMorphTargets();
    enclosesPose(mesh);
    mesh.morphTargetInfluences![0] = 1; expect(mesh.boundingSphere!.radius).toBe(Infinity);
    mesh.morphTargetInfluences![0] = 0; enclosesPose(mesh);
  });

  it("ignores unreferenced placeholder vertices and refreshes when the index changes", () => {
    const { mesh } = fixture();
    mesh.geometry.setIndex([0, 1, 2]);
    const weights = mesh.geometry.getAttribute("skinWeight"); weights.setXYZW(3, 0, 0, 0, 0); weights.needsUpdate = true;
    expect(Number.isFinite(mesh.boundingSphere!.radius)).toBe(true);
    mesh.geometry.getIndex()!.setX(2, 3); mesh.geometry.getIndex()!.needsUpdate = true;
    expect(mesh.boundingSphere!.radius).toBe(Infinity);
    mesh.geometry.setIndex([0, 1, 2]); expect(Number.isFinite(mesh.boundingSphere!.radius)).toBe(true);
  });
});
