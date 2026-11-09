import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { FoliageLodSystem, type InstancedPropBatch } from "../src/foliage-lod.js";
import { InstancedProps } from "../src/instancing.js";
import { applyLodFade, isLodFadeable, markLodFadeable } from "../src/lod-fade.js";
import { prepareSharedModel } from "../src/scene-builder.js";

/** Instances along +x. A fading batch has stippling materials on every tier and an impostor. */
function batchAt(xs: number[], fading = true): InstancedPropBatch {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardNodeMaterial();
  material.alphaTest = 0.05;
  const impostor = new THREE.MeshLambertNodeMaterial();
  if (fading) {
    applyLodFade(material);
    markLodFadeable(impostor);
  }
  const near = new InstancedProps(geometry, material, xs.length);
  const far = new InstancedProps(geometry, impostor, xs.length);
  const positions = xs.map((x) => new THREE.Vector3(x, 0, 0));
  const matrices = positions.map((p) => new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
  return {
    near: [near], far, positions, matrices,
    impostor: { rotations: new Float32Array(xs.length * 4), scales: new Float32Array(xs.length).fill(1) },
  };
}

const camera = new THREE.Vector3();

describe("mesh -> impostor crossfade", () => {
  it("holds an instance in both tiers across the band, and only there", () => {
    const system = new FoliageLodSystem(100);
    // band 80..100: 10 is mesh, 90 is both, 120 is impostor
    const batch = batchAt([10, 90, 120]);
    system.register(batch);
    system.update(camera);
    expect(batch.near[0]!.instanceCount).toBe(2);
    expect(batch.far.instanceCount).toBe(2);
    expect(system.tierCounts()).toMatchObject({ near: 2, far: 2, culled: 0 });
    expect(batch.near[0]!.userData["lodFadeBand"]).toEqual([80, 100]);
  });

  it("covers the whole band while the camera moves through it, so a stippled tree never shows a hole", () => {
    const system = new FoliageLodSystem(100);
    const batch = batchAt([0]);
    system.register(batch);
    for (let d = 40; d <= 140; d += 1) {
      system.update(new THREE.Vector3(d, 0, 0));
      if (d >= 80 && d <= 100) expect([d, batch.near[0]!.instanceCount, batch.far.instanceCount]).toEqual([d, 1, 1]);
      if (d < 70) expect(batch.far.instanceCount).toBe(0);
      if (d > 110) expect(batch.near[0]!.instanceCount).toBe(0);
    }
    for (let d = 140; d >= 40; d -= 1) {
      system.update(new THREE.Vector3(d, 0, 0));
      if (d >= 80 && d <= 100) expect([d, batch.near[0]!.instanceCount, batch.far.instanceCount]).toEqual([d, 1, 1]);
    }
  });

  it("compacts each tier independently when a doubled instance leaves one of them", () => {
    const system = new FoliageLodSystem(100);
    const batch = batchAt([90, 95, 300]);
    system.register(batch);
    system.update(camera);
    expect(batch.far.instanceCount).toBe(3);
    system.update(new THREE.Vector3(30, 0, 0)); // 60, 65 from the camera: out of the far tier
    expect(batch.far.instanceCount).toBe(1);
    const m = new THREE.Matrix4();
    batch.far.getMatrixAt(0, m);
    expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(300);
    expect(batch.near[0]!.instanceCount).toBe(2);
  });

  it("takes a doubled instance out of both tiers when it is hidden or freed", () => {
    const system = new FoliageLodSystem(100);
    const batch = batchAt([90]);
    system.register(batch);
    system.update(camera);
    system.setInstanceHidden(batch, 0, 1);
    expect([batch.near[0]!.instanceCount, batch.far.instanceCount]).toEqual([0, 0]);
    system.setInstanceHidden(batch, 0, -1);
    expect([batch.near[0]!.instanceCount, batch.far.instanceCount]).toEqual([1, 1]);
  });

  it("keeps the hard swap for a batch that cannot stipple, and with the switch off", () => {
    const system = new FoliageLodSystem(100);
    const solid = batchAt([90], false), fading = batchAt([90]);
    system.register(solid);
    system.register(fading);
    system.setCrossfade(false);
    system.update(camera);
    expect([solid.near[0]!.instanceCount, solid.far.instanceCount]).toEqual([0, 1]); // first sight of it: inside hysteresis, one tier
    expect(solid.near[0]!.userData["lodFadeBand"]).toEqual([0, 0]);
    expect(fading.near[0]!.userData["lodFadeBand"]).toEqual([0, 0]);
    expect(fading.near[0]!.instanceCount + fading.far.instanceCount).toBe(1);
  });

  it("leaves an opaque material out: it cannot drop a pixel", () => {
    const opaque = new THREE.MeshStandardNodeMaterial();
    applyLodFade(opaque);
    expect(isLodFadeable(opaque)).toBe(false);
    expect(opaque.opacityNode ?? null).toBeNull();
  });
});

describe("setLodScale", () => {
  it("scales the default and the per-asset distance, and moves the band with them", () => {
    const system = new FoliageLodSystem(100);
    const ordinary = batchAt([150]), landmark = batchAt([350]);
    landmark.lodDistance = 300;
    system.register(ordinary);
    system.register(landmark);
    system.update(camera);
    expect(ordinary.near[0]!.instanceCount).toBe(0);
    expect(landmark.near[0]!.instanceCount).toBe(0);
    system.setLodScale(2);
    expect(system.farDistanceFor(ordinary)).toBe(200);
    expect(system.farDistanceFor(landmark)).toBe(600);
    expect(ordinary.near[0]!.userData["lodFadeBand"]).toEqual([160, 200]);
    system.update(camera);
    expect(ordinary.near[0]!.instanceCount).toBe(1);
    expect(landmark.near[0]!.instanceCount).toBe(1);
  });

  it("ignores a scale that is not positive", () => {
    const system = new FoliageLodSystem(100);
    system.setLodScale(0);
    system.setLodScale(Number.NaN);
    expect(system.getLodScale()).toBe(1);
  });
});

describe("prepareSharedModel", () => {
  it("settles brightness and leaf normals on the shared model, once, whoever gets there first", () => {
    const material = new THREE.MeshStandardMaterial({ alphaTest: 0.5 });
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 8), material);
    scene.add(mesh);
    const sources = [{}, { brightness: 1.4, foliageNormals: 1, foliageUp: 0.75 }];
    prepareSharedModel(scene, sources);
    prepareSharedModel(scene, sources); // the other builder, later
    expect(material.color.r).toBeCloseTo(1.4);
    const normal = mesh.geometry.getAttribute("normal");
    let up = 0;
    for (let i = 0; i < normal.count; i++) up += normal.getY(i);
    expect(up / normal.count).toBeGreaterThan(0.5); // a raw sphere averages 0
  });
});
