import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { INSTANCE_MATRIX_ATTRIBUTES, InstancedProps, applyInstancedProps, isInstancedPropMaterial } from "../src/instancing.js";

/**
 * Pins the properties that make an InstancedProps batch share one shader
 * build per material instead of one per object (see the module comment):
 * no `count`/`isInstancedMesh` on the object, the instance transform living in
 * geometry attributes with a batch-independent layout, and per-batch
 * attribute objects over shared arrays so disposal stays local.
 */
describe("InstancedProps", () => {
  const base = new THREE.BoxGeometry(2, 2, 2);
  const material = new THREE.MeshStandardNodeMaterial();

  it("never exposes the properties three keys its shader cache on", () => {
    const mesh = new InstancedProps(base, material, 5);
    expect((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh).toBeUndefined();
    // three keys the shader cache on `count > 1`; a Mesh carries the default 1
    expect((mesh as unknown as { count: number }).count).toBe(1);
    expect(mesh.isInstancedProps).toBe(true);
    expect(mesh.instanceCount).toBe(5);
    expect(mesh.geometry.instanceCount).toBe(5);
  });

  it("carries the instance matrix as four interleaved vec4 geometry attributes", () => {
    const mesh = new InstancedProps(base, material, 3);
    for (const [column, name] of INSTANCE_MATRIX_ATTRIBUTES.entries()) {
      const attr = mesh.geometry.getAttribute(name) as THREE.InterleavedBufferAttribute;
      expect(attr.isInterleavedBufferAttribute).toBe(true);
      expect(attr.itemSize).toBe(4);
      expect(attr.offset).toBe(column * 4);
      expect(attr.data).toBe(mesh.instanceMatrix);
      expect((attr.data as THREE.InstancedInterleavedBuffer).isInstancedInterleavedBuffer).toBe(true);
    }
    // the layout a batch of 3 and a batch of 700 present to the renderer is identical
    const big = new InstancedProps(base, material, 700);
    const layout = (m: InstancedProps) =>
      Object.keys(m.geometry.attributes).sort().map((n) => {
        const a = m.geometry.getAttribute(n) as THREE.InterleavedBufferAttribute;
        return `${n}:${a.itemSize}:${a.data?.stride ?? 0}:${a.offset ?? 0}`;
      }).join(",");
    expect(layout(big)).toBe(layout(mesh));
  });

  it("round-trips matrices and tracks the written range for upload", () => {
    const mesh = new InstancedProps(base, material, 4);
    const m = new THREE.Matrix4().makeTranslation(1, 2, 3);
    mesh.setMatrixAt(2, m);
    mesh.setMatrixAt(3, m);
    const out = new THREE.Matrix4();
    expect(mesh.getMatrixAt(2, out).equals(m)).toBe(true);
    // two sequential writes coalesce into one upload range
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 32, count: 32 }]);
    mesh.setMatrixAt(0, m);
    expect(mesh.instanceMatrix.updateRanges).toHaveLength(2);
  });

  it("clamps instanceCount to the allocated capacity and allows zero", () => {
    const mesh = new InstancedProps(base, material, 4);
    mesh.instanceCount = 0;
    expect(mesh.instanceCount).toBe(0);
    mesh.instanceCount = 99;
    expect(mesh.instanceCount).toBe(4);
  });

  it("shares vertex arrays with the base geometry but owns its attribute objects", () => {
    const mesh = new InstancedProps(base, material, 1);
    const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    expect(position).not.toBe(base.getAttribute("position"));
    expect(position.array).toBe(base.getAttribute("position").array);
    expect(mesh.geometry.index).not.toBe(base.index);
    expect(mesh.geometry.index!.array).toBe(base.index!.array);
    // per-batch instanced attributes on the base (impostor rotation/scale) stay as-is
    const withInstanced = base.clone();
    const rot = new THREE.InstancedBufferAttribute(new Float32Array(4), 4);
    withInstanced.setAttribute("impostorRotation", rot);
    expect(new InstancedProps(withInstanced, material, 1).geometry.getAttribute("impostorRotation")).toBe(rot);
  });

  it("computes a bounding sphere over the placed instances only", () => {
    const mesh = new InstancedProps(base, material, 2);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 0));
    mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(10, 0, 0));
    mesh.computeBoundingSphere();
    expect(mesh.boundingSphere!.center.x).toBeCloseTo(5, 5);
    expect(mesh.boundingSphere!.radius).toBeGreaterThan(5);
    mesh.instanceCount = 1;
    mesh.computeBoundingSphere();
    expect(mesh.boundingSphere!.center.x).toBeCloseTo(0, 5);
  });

  it("raycasts per instance with instanceId", () => {
    const mesh = new InstancedProps(base, material, 2);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 0, 0));
    mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(10, 0, 0));
    mesh.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(10, 0, 20), new THREE.Vector3(0, 0, -1));
    const hits: THREE.Intersection[] = [];
    mesh.raycast(ray, hits);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.instanceId).toBe(1);
    expect(hits[0]!.object).toBe(mesh);
  });

  it("applyInstancedProps installs the instance transform once and keeps an existing position node", () => {
    const plain = new THREE.MeshStandardNodeMaterial();
    applyInstancedProps(plain);
    expect(isInstancedPropMaterial(plain)).toBe(true);
    expect(plain.positionNode).not.toBeNull();
    const first = plain.positionNode;
    applyInstancedProps(plain);
    expect(plain.positionNode).toBe(first);
    const windy = new THREE.MeshStandardNodeMaterial();
    const wind = new THREE.Node("vec3");
    windy.positionNode = wind;
    applyInstancedProps(windy);
    expect(windy.positionNode).not.toBe(wind);
  });
});
