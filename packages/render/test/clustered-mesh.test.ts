import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { clusterDagReady } from "../src/cluster-dag.js";
import { ClusteredMesh, ClusterLodSystem, clusterDagFromGeometry } from "../src/clustered-mesh.js";

beforeAll(() => clusterDagReady());

function makeClustered(): { source: THREE.BufferGeometry; mesh: ClusteredMesh } {
  const source = new THREE.TorusKnotGeometry(1, 0.35, 160, 24); // ~7.7k tris
  const dag = clusterDagFromGeometry(source)!;
  expect(dag).not.toBeNull();
  return { source, mesh: new ClusteredMesh(source, new THREE.MeshBasicMaterial(), dag) };
}

function camera(distance: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
  cam.position.set(0, 0, distance);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

describe("ClusteredMesh", () => {
  it("starts at full detail with its own attribute copies", () => {
    const { source, mesh } = makeClustered();
    expect(mesh.geometry.drawRange.count).toBe(source.index!.count);
    expect(mesh.geometry.getAttribute("position")).not.toBe(source.getAttribute("position"));
    expect(mesh.geometry.getAttribute("position").count).toBe(source.getAttribute("position").count);
    expect(mesh.geometry.boundingSphere!.radius).toBeCloseTo(source.boundingSphere!.radius, 6);
  });

  it("draws fewer triangles as the camera backs away, through one index buffer", () => {
    const { source, mesh } = makeClustered();
    const scene = new THREE.Scene();
    scene.add(mesh);
    mesh.update(camera(1.5), 1080, false); // culling off: the knot spills out of the frustum this close
    const near = mesh.geometry.drawRange.count;
    expect(near).toBe(source.index!.count); // everything within 1px error → all leaves
    mesh.update(camera(40), 1080, false);
    const mid = mesh.geometry.drawRange.count;
    mesh.update(camera(2000), 1080, false);
    const far = mesh.geometry.drawRange.count;
    expect(mid).toBeLessThan(near);
    expect(far).toBeLessThan(mid);
    expect(far).toBeGreaterThan(0);
    expect(mesh.stats.triangles * 3).toBe(far);
    // every drawn index addresses a real vertex
    const array = mesh.geometry.index!.array as Uint32Array;
    const vertexCount = mesh.geometry.getAttribute("position").count;
    for (let i = 0; i < far; i++) expect(array[i]!).toBeLessThan(vertexCount);
  });

  it("skips the index upload when the cut is unchanged", () => {
    const { mesh } = makeClustered();
    new THREE.Scene().add(mesh);
    const cam = camera(30);
    mesh.update(cam, 1080);
    const version = mesh.geometry.index!.version;
    mesh.update(cam, 1080);
    expect(mesh.geometry.index!.version).toBe(version);
    mesh.update(camera(31), 1080); // a small move may or may not change the cut…
    mesh.update(camera(300), 1080); // …a big one must
    expect(mesh.geometry.index!.version).toBeGreaterThan(version);
  });

  it("culls clusters behind the camera", () => {
    const { mesh } = makeClustered();
    new THREE.Scene().add(mesh);
    const cam = camera(3);
    mesh.update(cam, 1080, false);
    const uncalled = mesh.stats.clusters;
    // look away: everything is outside the frustum
    cam.lookAt(0, 0, 100);
    cam.updateMatrixWorld();
    mesh.update(cam, 1080, true);
    expect(mesh.stats.clusters).toBe(0);
    expect(mesh.geometry.drawRange.count).toBe(0);
    // look at it again with culling: at least what was drawn before
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    mesh.update(cam, 1080, true);
    expect(mesh.stats.clusters).toBe(uncalled);
  });

  it("respects the mesh's own transform when judging distance", () => {
    const { mesh } = makeClustered();
    const scene = new THREE.Scene();
    scene.add(mesh);
    const cam = camera(2);
    mesh.update(cam, 1080);
    const close = mesh.stats.triangles;
    mesh.position.set(0, 0, -500); // now 502 units from the camera
    mesh.update(cam, 1080);
    expect(mesh.stats.triangles).toBeLessThan(close);
  });
});

describe("ClusterLodSystem", () => {
  it("updates registered meshes and prunes ones that left the scene", () => {
    const system = new ClusterLodSystem();
    const scene = new THREE.Scene();
    const a = makeClustered().mesh;
    const b = makeClustered().mesh;
    scene.add(a);
    scene.add(b);
    system.register(a);
    system.register(b);
    system.update(camera(500), 1080);
    expect(system.size).toBe(2);
    expect(system.stats().meshes).toBe(2);
    expect(a.stats.triangles).toBeGreaterThan(0);
    scene.remove(b);
    system.update(camera(500), 1080);
    expect(system.size).toBe(1);
    // an orthographic camera is a no-op rather than a crash
    system.update(new THREE.OrthographicCamera(-1, 1, 1, -1), 1080);
    expect(system.size).toBe(1);
  });
});
