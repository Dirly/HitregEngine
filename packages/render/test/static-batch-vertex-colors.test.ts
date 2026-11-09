import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { batchStaticMeshes, mergeModelSubmeshes, STATIC_BATCH_FLAG } from "../src/static-batch.js";

/** A static mesh entity the batcher accepts: an entity-tagged mesh under a model root. */
function piece(root: THREE.Object3D, material: THREE.Material, id: string, x: number, ao?: number) {
  const g = new THREE.BoxGeometry();
  if (ao !== undefined) g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 3).fill(ao), 3));
  const model = new THREE.Group();
  model.userData["modelRoot"] = true;
  const mesh = new THREE.Mesh(g, material);
  mesh.userData["entityId"] = id;
  mesh.userData[STATIC_BATCH_FLAG] = true;
  model.add(mesh);
  model.position.x = x;
  root.add(model);
  return mesh;
}

describe("static batch and vertex colours (baked AO on kit pieces)", () => {
  it("merges AO-coloured pieces and keeps their colours when the material reads them", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ vertexColors: true });
    piece(root, material, "a", 0, 0.5);
    piece(root, material, "b", 3, 0.25);
    piece(root, material, "c", 6); // no colour stream: drawn white, as before
    const batch = batchStaticMeshes(root)!;
    expect(batch.stats.merged).toBe(3);
    const merged = batch.group.children[0] as THREE.Mesh;
    const color = merged.geometry.getAttribute("color");
    expect(color.itemSize).toBe(3);
    const values = new Set(Array.from(color.array as Float32Array).map((v) => +v.toFixed(2)));
    expect([...values].sort()).toEqual([0.25, 0.5, 1]);
    batch.dispose();
  });

  it("leaves a colour stream alone under a material that does not declare vertexColors (terrain tint read by its own node)", () => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial();
    piece(root, material, "a", 0, 0.5);
    piece(root, material, "b", 3, 0.5);
    expect(batchStaticMeshes(root)).toBeNull();
  });
});

describe.each(["scene batch", "model merge"] as const)("vertex opacity through %s", (mode) => {
  it.each([
    ["blended", { transparent: true, opacity: 0.7 }],
    ["cutout", { alphaTest: 0.4 }],
    ["dithered", { alphaHash: true }],
  ] as const)("preserves %s coverage and pads RGB-only members with opaque alpha", (_name, options) => {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, ...options });
    const shell = piece(root, material, "shell", 0);
    const source = shell.geometry;
    const colors = new Float32Array(source.getAttribute("position").count * 4);
    const coverage = [0, 0.2, 0.6, 1];
    for (let i = 0; i < colors.length / 4; i++) colors.set([0.8, 0.9, 1, coverage[i % 4]!], i * 4);
    source.setAttribute("color", new THREE.BufferAttribute(colors, 4));
    const shellVertices = source.index!.count;
    piece(root, material, "solid", 3, 0.5);

    const batch = mode === "scene batch" ? batchStaticMeshes(root)! : null;
    if (mode === "model merge") expect(mergeModelSubmeshes(root)).toBe(1);
    const merged = (batch?.group.children[0] ?? root.children.find(n => (n as THREE.Mesh).isMesh)) as THREE.Mesh;
    const color = merged.geometry.getAttribute("color");
    expect(color.itemSize).toBe(4);
    const alpha = Array.from({ length: shellVertices }, (_, i) => +color.getW(i).toFixed(2));
    expect([...new Set(alpha)].sort()).toEqual(coverage);
    for (let i = shellVertices; i < color.count; i++) expect(color.getW(i)).toBe(1);
    expect(source.getAttribute("color").array).toBe(colors);
    batch?.dispose();
  });
});
