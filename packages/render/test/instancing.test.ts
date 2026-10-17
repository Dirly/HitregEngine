import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { INSTANCE_MATRIX_ATTRIBUTES, InstancedProps, applyInstancedProps, isInstancedPropMaterial, mirrorSignOf } from "../src/instancing.js";

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

  it("reports placed instance bounds to Box3, including the parent's transform", () => {
    const mesh = new InstancedProps(base, material, 2);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(20, 10, -30));
    mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(-40, 50, 60));
    mesh.position.set(100, 200, 300);
    const box = new THREE.Box3().setFromObject(mesh);
    expect(box.min.toArray()).toEqual([59, 209, 269]);
    expect(box.max.toArray()).toEqual([121, 251, 361]);
  });

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

/**
 * A mirrored instance (negative determinant: the right shoulder pad is the
 * left one at scale z = -1) reverses its triangles' winding, and a batch is
 * one draw with one front face. The shader pre-negates such an instance's
 * normal (instanceMirrorSign) so a double-sided material's back-face
 * negation lands it on the true normal. This replays that pipeline on the
 * CPU: winding -> GPU facing -> negateOnBackSide -> the normal lighting sees.
 */
describe("mirrored instances", () => {
  /** Right pad as character-look mounts it: rotated, scaled, z mirrored, through a moved group. */
  function rightPadMatrix(): THREE.Matrix4 {
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(0.12, 0.05, -0.02),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 0.4)),
      new THREE.Vector3(1.05, 1.05, -1.05),
    );
    // the slot group decomposes it (character-look) and the batch recomposes it
    const group = new THREE.Object3D();
    local.decompose(group.position, group.quaternion, group.scale);
    group.position.add(new THREE.Vector3(4, 1.4, -7));
    group.updateMatrixWorld(true);
    return group.matrixWorld.clone();
  }

  /** The normal lighting sees for the face a camera at `eye` looks at, as the GPU draws instance `m`. */
  function shadedNormal(m: THREE.Matrix4, eye: THREE.Vector3, sign: number): { normal: THREE.Vector3; toEye: THREE.Vector3 } {
    // one triangle of a pad, CCW about its outward normal +z (local)
    const tri = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)].map((v) => v.applyMatrix4(m));
    const centre = tri[0]!.clone().add(tri[1]!).add(tri[2]!).divideScalar(3);
    const toEye = eye.clone().sub(centre).normalize();
    const winding = new THREE.Vector3().subVectors(tri[1]!, tri[0]!).cross(new THREE.Vector3().subVectors(tri[2]!, tri[0]!));
    const gpuFront = winding.dot(toEye) > 0; // the batch's front face is CCW for every instance
    // transformNormal = inverse-transpose; then the instance sign; then negateOnBackSide (DoubleSide)
    const normal = new THREE.Vector3(0, 0, 1).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(m)).multiplyScalar(sign);
    if (!gpuFront) normal.negate();
    return { normal, toEye };
  }

  it("signs a matrix by its determinant, as three's plain-mesh front-face flip does", () => {
    const right = rightPadMatrix();
    expect(mirrorSignOf(right)).toBe(-1);
    expect(Math.sign(right.determinant())).toBe(-1);
    expect(mirrorSignOf(new THREE.Matrix4().makeRotationY(2).scale(new THREE.Vector3(2, 2, 2)))).toBe(1);
    expect(mirrorSignOf(new THREE.Matrix4().makeScale(-1, -1, 1))).toBe(1); // two flips are a rotation
    expect(mirrorSignOf(new THREE.Matrix4().makeScale(-1, 1, 1))).toBe(-1);
  });

  it("shades a mirrored instance's outer face toward the viewer (it shaded inside out before)", () => {
    const m = rightPadMatrix();
    // the camera on the outer side of the mirrored pad
    const outward = new THREE.Vector3(0, 0, 1).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(m));
    const at = new THREE.Vector3().setFromMatrixPosition(m);
    for (const eye of [at.clone().addScaledVector(outward, 3), at.clone().addScaledVector(outward.clone().negate(), 3)]) {
      const fixed = shadedNormal(m, eye, mirrorSignOf(m));
      expect(fixed.normal.dot(fixed.toEye)).toBeGreaterThan(0);
      const before = shadedNormal(m, eye, 1);
      expect(before.normal.dot(before.toEye)).toBeLessThan(0);
    }
  });

  it("leaves an unmirrored instance as it was", () => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(1, 2, 3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.1, 0.4)), new THREE.Vector3(1, 1, 1));
    const eye = new THREE.Vector3(0, 0, 1).applyMatrix4(m).multiplyScalar(4);
    expect(mirrorSignOf(m)).toBe(1);
    const s = shadedNormal(m, eye, mirrorSignOf(m));
    expect(s.normal.dot(s.toEye)).toBeGreaterThan(0);
  });
});
