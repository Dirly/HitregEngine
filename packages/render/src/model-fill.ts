import * as THREE from "three/webgpu";
import { Fn, materialColor, materialEmissive, uniform } from "three/tsl";

// Shared by every character/creature and moving model material, including
// appearance pages and named corpse overrides. Zero preserves authored light.
const fill = uniform(0);
export function setModelFill(value: number | undefined): void {
  fill.value = Math.min(0.25, Math.max(0, value ?? 0));
}

/** A matte, texture-coloured readability floor. No view-angle/Fresnel term.
 * Resolve the FINAL colour graph at shader-build time: appearance can replace
 * it and named maps can arrive asynchronously after this hook is installed.
 */
export function addModelFill(material: THREE.Material): void {
  const node = material as THREE.MeshStandardNodeMaterial;
  if (!node.isMeshStandardNodeMaterial || node.userData.hitregModelFill) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const painted = (Fn as any)((_: unknown, builder: { material: { colorNode?: any } }) =>
    (builder.material.colorNode ?? materialColor).rgb)();
  const own = node.emissiveNode as typeof materialEmissive | null;
  // Native material emission (including its map) must survive the floor.
  // materialEmissive is evaluated against the actual drawn material/clone.
  // A tiny neutral floor also reaches coal-black paint. Without it those
  // texels quantise to the same near-black output even when fill increases.
  // The painted variation is retained; this term never approaches bloom.
  node.emissiveNode = (own ?? materialEmissive).add(painted.add(0.08).mul(fill));
  node.userData.hitregModelFill = true;
  node.needsUpdate = true;
}
