import * as THREE from "three/webgpu";

/**
 * Lift an imported model's albedo.
 *
 * Why this exists, and what it is NOT a substitute for: an authoring tool like
 * Blockbench previews a model essentially unlit, showing its texture at close
 * to full brightness. A renderer applies real lighting, so the same model
 * arrives darker — correctly. That gap widens for imported models
 * specifically, because they are box-shaped and have faces pointing in every
 * direction, while terrain mostly faces the sun. It widens again when a scene
 * has no image-based lighting, since a face turned away from the sun then has
 * nothing left but flat ambient.
 *
 * So this is a grading knob, not a lighting fix. It multiplies the material's
 * base colour, which lifts the lit and the unlit sides alike. The real answer
 * for "the shadowed side is dead" is an environment/IBL pass; this is for
 * "this asset was authored brighter than it renders".
 *
 * A plain colour multiply is used deliberately in preference to faking bounce
 * light with an emissive term: the bloom pipeline samples `emissiveNode`, so
 * an emissive fill would make every imported prop glow.
 */
const BRIGHTNESS = "modelBrightness";

/** Multiply every standard material under `root`. Idempotent per material. */
export function applyModelBrightness(root: THREE.Object3D, brightness: number): number {
  if (!(brightness > 0) || brightness === 1) return 0;
  let touched = 0;
  const seen = new Set<string>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const pbr = material as THREE.MeshStandardMaterial;
      if (!pbr || !pbr.color || seen.has(pbr.uuid)) continue;
      seen.add(pbr.uuid);
      // Materials are shared across every instance of a model by the loader
      // cache, so applying twice would square the lift. Tag and skip.
      if (pbr.userData[BRIGHTNESS] !== undefined) continue;
      pbr.userData[BRIGHTNESS] = brightness;
      pbr.color.multiplyScalar(brightness);
      pbr.needsUpdate = true;
      touched += 1;
    }
  });
  return touched;
}
