import * as THREE from "three/webgpu";
import type Node from "three/src/nodes/core/Node.js";
import { attribute, materialColor, mix, vec3, vec4, vertexStage } from "three/tsl";
import type { VegetationTint } from "@hitreg/core";

export const VEGETATION_TINT_ATTRIBUTES = ["instanceBarkTint", "instanceLeafTint"] as const;
export type VegetationRole = "bark" | "leaves";

/** Match named material roles, including glTF texture names (original MMO materials are unnamed). */
export function vegetationMaterialRole(material: THREE.Material): VegetationRole | undefined {
  const map = (material as THREE.Material & { map?: THREE.Texture }).map;
  const name = `${material.name} ${map?.name ?? ""}`.toLowerCase();
  if (/leaves|leaf|foliage|branch|bush/.test(name)) return "leaves";
  if (/bark|trunk|wood|log/.test(name)) return "bark";
  return undefined;
}

/** White defaults ensure pooled slots reused by untinted trees never inherit old colours. */
export function encodeVegetationTint(tint?: VegetationTint): number[] {
  return [...(tint?.bark ?? [1, 1, 1]), ...(tint?.leaves ?? [1, 1, 1])];
}

export function vegetationTintNode(role: VegetationRole) {
  return vertexStage(vec3(attribute<"vec3">(VEGETATION_TINT_ATTRIBUTES[role === "bark" ? 0 : 1], "vec3")));
}

/** The normal atlas alpha carries 0=other, .5=bark, 1=leaves; interpolate at filtered edges. */
export function vegetationMaskTintNode(mask: Node<"float">) {
  const barkWeight = mask.mul(2).min(mask.oneMinus().mul(2)).clamp(0, 1);
  const leafWeight = mask.mul(2).sub(1).clamp(0, 1);
  return mix(vec3(1), vegetationTintNode("bark"), barkWeight)
    .add(vegetationTintNode("leaves").sub(vec3(1)).mul(leafWeight));
}

export function applyInstanceVegetationTint(material: THREE.Material): void {
  const role = vegetationMaterialRole(material);
  const node = material as THREE.NodeMaterial;
  if (!role || !node.isNodeMaterial || node.userData["instanceVegetationTint"]) return;
  node.colorNode = vec4((node.colorNode ?? materialColor) as Node<"vec4">).mul(vec4(vegetationTintNode(role), 1));
  node.userData["instanceVegetationTint"] = role;
}
