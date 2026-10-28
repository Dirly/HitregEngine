import type * as THREE from "three/webgpu";
import { clamp, float, vec4 } from "three/tsl";
import { sceneFogParts } from "./landmark-fog.js";

const installed = new WeakSet<THREE.NodeMaterial>();

/**
 * Additive light cards lose radiance through the same air as opaque surfaces.
 * Normal fog blending would ADD the fog colour over the card's whole quad,
 * including its dark skirt. Attenuate its contribution instead; the scene
 * behind the card already supplies the atmosphere's colour and scattered light.
 */
export function applyAdditiveFog(material: THREE.NodeMaterial): void {
  if (installed.has(material)) return;
  installed.add(material);
  material.fog = true;
  const baseKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${baseKey.call(material)}|additive-fog`;
  material.setupFog = (builder, outputNode) => {
    const parts = sceneFogParts(builder);
    if (!parts) return outputNode;
    // The fog graph and all its live day/night, weather and zone uniforms are
    // shared with the opaque scene, so no separate density can drift from it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transmission = float(1).sub(clamp(parts.factor as any, 0, 1));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const color = outputNode as any;
    return vec4(color.rgb.mul(transmission), color.a);
  };
}
