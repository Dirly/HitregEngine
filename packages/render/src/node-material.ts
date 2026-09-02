import * as THREE from "three/webgpu";

/** Marks a material this module produced, so a second pass reuses it. */
const CONVERTED = "isConvertedNodeMaterial";

/**
 * Re-home a loaded material onto its NodeMaterial equivalent, so TSL nodes
 * (`positionNode`, `opacityNode`, ...) can be attached to it.
 *
 * GLTFLoader builds plain `MeshStandardMaterial`s. Under WebGPURenderer those
 * still RENDER — the renderer wraps each one in a node material internally —
 * but the wrapper is not the object you are holding, so assigning
 * `material.positionNode` to a loaded model's material does nothing at all,
 * silently. Anything that wants to edit a loaded model's shader has to swap in
 * a real node material first. That is the whole job of this function.
 *
 * `copy()` carries almost everything across. The exception is worth the
 * explicit line below, because it fails silently and destructively:
 * **`copy()` does not carry `alphaTest`**. On a cutout leaf card, losing it is
 * the difference between a tree and a tree wearing opaque grey rectangles.
 */
export function asNodeMaterial(source: THREE.Material): THREE.NodeMaterial {
  if ((source as THREE.NodeMaterial).isNodeMaterial) return source as THREE.NodeMaterial;
  const converted =
    (source as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial === true
      ? new THREE.MeshPhysicalNodeMaterial()
      : (source as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
        ? new THREE.MeshStandardNodeMaterial()
        : (source as THREE.MeshBasicMaterial).isMeshBasicMaterial === true
          ? new THREE.MeshBasicNodeMaterial()
          : new THREE.MeshStandardNodeMaterial();
  converted.copy(source as never);
  // the one `copy()` drops — see above
  converted.alphaTest = source.alphaTest;
  converted.name = source.name;
  converted.userData = { ...source.userData, [CONVERTED]: true };
  return converted as THREE.NodeMaterial;
}

/**
 * Run `edit` over every material on every mesh under `root`, swapping each one
 * for a node material first. `edit` returns false to leave a material alone
 * (it is not foliage, it is already done, ...). Returns how many it changed.
 *
 * Materials are shared by the glTF cache across every user of a model, so an
 * edit here is a property of the MODEL, not of one entity — the same
 * granularity `applyFoliageNormals` and `applyModelBrightness` already work at.
 */
export function editMeshMaterials(
  root: THREE.Object3D,
  edit: (material: THREE.NodeMaterial, mesh: THREE.Mesh) => boolean,
): number {
  let touched = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const out = list.map((m) => {
      const node = asNodeMaterial(m);
      if (edit(node, mesh)) {
        touched += 1;
        return node;
      }
      // untouched: hand back the ORIGINAL, so a model whose materials we
      // decided against does not pay for a needless pipeline swap
      return m;
    });
    mesh.material = Array.isArray(mesh.material) ? out : out[0]!;
  });
  return touched;
}

/**
 * Clone a material, keeping `alphaTest`.
 *
 * `Material.clone()` is `new (constructor)().copy(this)`, and NodeMaterial's
 * `copy()` does not carry `alphaTest` — so cloning a converted cutout material
 * silently produces an OPAQUE one. It is the same trap as {@link asNodeMaterial},
 * one step further down the pipeline, and it bites exactly where it is hardest
 * to see: the per-submesh clone that the instanced path caches. A field of
 * bushes rendered as solid boxes with no warning anywhere.
 */
export function cloneMaterial(source: THREE.Material): THREE.Material {
  const clone = source.clone();
  clone.alphaTest = source.alphaTest;
  return clone;
}
