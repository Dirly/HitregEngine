import * as THREE from "three/webgpu";
import { dot, float, normalize, normalView, positionView, pow, saturate, texture, uniform } from "three/tsl";
import { nightLevel } from "./daylight.js";

/**
 * A cold edge light on CHARACTERS (players, NPCs — everything drawn through
 * the shared appearance materials, ubermesh or not), so a figure stays
 * readable against a dark world. Not a light: a view-dependent emissive term
 * (Fresnel), one dot and a pow per fragment of a character, no shadow, no
 * light slot. Driven scene-wide by `sky.rim`; strength 0 leaves it in the
 * shader multiplied out, which is cheaper than a recompile when it changes.
 */
const rim = {
  color: uniform(new THREE.Color("#8fa6d8")),
  strength: uniform(0),
  /** Extra strength at full night, on top of `strength`. */
  night: uniform(0),
  power: uniform(3),
};

export interface RimSettings {
  color: string;
  strength: number;
  night: number;
  power: number;
}

/** Apply a scene's `sky.rim` (null = off). A uniform write. */
export function setRimLight(settings: RimSettings | null | undefined): void {
  rim.color.value.set(settings?.color ?? "#8fa6d8");
  rim.strength.value = Math.max(0, settings?.strength ?? 0);
  rim.night.value = Math.max(0, settings?.night ?? 0);
  rim.power.value = Math.max(0.5, settings?.power ?? 3);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The rim term, to ADD to a character material's emissive. */
export function rimLightNode(): any {
  const facing: any = saturate(dot(normalView, normalize(positionView.negate())));
  const edge: any = pow(float(1).sub(facing), rim.power);
  return rim.color.mul(edge.mul(rim.strength.add(rim.night.mul(nightLevel))));
}

/**
 * A node-material copy of a skinned model's own (glTF) material with the rim
 * added — how MOBS get it, whose materials never pass through the appearance
 * path. Converted once per source material on the cached glTF scene, so every
 * wolf shares one. Copies the surface the glTF loader sets; anything exotic
 * stays on the original (returned unchanged).
 */
const rimmed = new WeakMap<THREE.Material, THREE.Material>();
export function rimmedCopy(source: THREE.Material): THREE.Material {
  const done = rimmed.get(source);
  if (done) return done;
  if ((source as THREE.NodeMaterial).isNodeMaterial === true) {
    addRimLight(source);
    return source;
  }
  const m = source as THREE.MeshStandardMaterial;
  if (m.type !== "MeshStandardMaterial" && m.type !== "MeshPhysicalMaterial") return source;
  const copy = new THREE.MeshStandardNodeMaterial();
  copy.name = m.name;
  copy.color.copy(m.color);
  copy.map = m.map;
  copy.normalMap = m.normalMap;
  copy.normalScale.copy(m.normalScale);
  copy.roughness = m.roughness;
  copy.roughnessMap = m.roughnessMap;
  copy.metalness = m.metalness;
  copy.metalnessMap = m.metalnessMap;
  copy.aoMap = m.aoMap;
  copy.emissive.copy(m.emissive);
  copy.emissiveMap = m.emissiveMap;
  copy.emissiveIntensity = m.emissiveIntensity;
  copy.alphaMap = m.alphaMap;
  copy.alphaTest = m.alphaTest;
  copy.transparent = m.transparent;
  copy.opacity = m.opacity;
  copy.side = m.side;
  copy.vertexColors = m.vertexColors;
  copy.flatShading = m.flatShading;
  copy.userData = { ...m.userData };
  addRimLight(copy);
  rimmed.set(source, copy);
  return copy;
}

/**
 * Give a character material its rim, keeping whatever emissive it already had
 * (an item glow set earlier, or its own authored emissive colour). Idempotent.
 */
export function addRimLight(material: THREE.Material): void {
  const node = material as THREE.NodeMaterial & { emissiveNode?: any; emissive?: THREE.Color; emissiveIntensity?: number; emissiveMap?: THREE.Texture | null };
  if (node.isNodeMaterial !== true || node.userData["hitregRim"] === true) return;
  // whatever emissive it already had: an explicit node, else its colour (times its map, when it has one)
  let own: any = node.emissiveNode ?? null;
  if (!own && node.emissive && (node.emissive.r + node.emissive.g + node.emissive.b > 0 || node.emissiveMap)) {
    own = uniform(node.emissive.clone()).mul(float(node.emissiveIntensity ?? 1));
    if (node.emissiveMap) own = own.mul(texture(node.emissiveMap).rgb);
  }
  node.emissiveNode = own ? own.add(rimLightNode()) : rimLightNode();
  node.userData["hitregRim"] = true;
  node.needsUpdate = true;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
