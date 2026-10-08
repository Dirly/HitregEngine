import * as THREE from "three/webgpu";
import { attribute, dFdx, dFdy, fract, texture, uv, vec4 } from "three/tsl";

/**
 * Runtime half of `apps/playground/tools/town-atlas.mjs`.
 *
 * An atlased town GLB has ONE kit material (glTF extras `hitregAtlas`) whose
 * base colour is the town's atlas page, and every folded primitive carries
 * `_ATLASRECT` = (u0, v0, du, dv): the tile its original texture occupies on
 * the page. The original UVs are kept untouched — kit walls tile (UVs up to
 * 9+) — so the material samples `rect.xy + fract(uv) * rect.zw` per fragment.
 * Gradients come from the UNWRAPPED uv scaled to the tile, so the mip level
 * stays continuous across the fract seam instead of jumping to the smallest
 * mip on a one-pixel line; the packer's wrap gutter covers the filter taps.
 *
 * Every atlased mesh of a town gets the SAME material object (one per page
 * texture), which is what lets the static batcher merge a whole street.
 */

/** glTF `_ATLASRECT` arrives lowercased (GLTFLoader keeps custom semantics as-is, lowercased). */
export const ATLAS_RECT_ATTRIBUTE = "_atlasrect";

const atlasMaterials = new Map<THREE.Texture, THREE.Material>();

function atlasMaterialFor(source: THREE.MeshStandardMaterial): THREE.Material {
  const map = source.map!;
  const cached = atlasMaterials.get(map);
  if (cached) return cached;
  const material = new THREE.MeshPhysicalNodeMaterial({
    name: source.name,
    roughness: 1,
    metalness: 0,
    side: source.side,
    // the kit's matte setup (KHR_materials_specular specularFactor 0)
    specularIntensity: (source as THREE.MeshPhysicalMaterial).specularIntensity ?? 0,
  });
  // keep `map` set: per-asset tooling (texture filter) reaches the page through it
  material.map = map;
  const rect = vec4(attribute<"vec4">(ATLAS_RECT_ATTRIBUTE, "vec4"));
  const tiled = uv();
  const inTile = rect.xy.add(fract(tiled).mul(rect.zw));
  const gradUv = tiled.mul(rect.zw);
  material.colorNode = texture(map, inTile).grad(dFdx(gradUv), dFdy(gradUv));
  material.userData["hitregAtlas"] = source.userData["hitregAtlas"];
  atlasMaterials.set(map, material);
  return material;
}

/**
 * Swap every atlased primitive's material for its town's shared atlas
 * material. Call after textures are shared by name, so one page is one
 * texture object across all of a town's files. Returns meshes re-pointed.
 */
export function applyAtlasMaterials(root: THREE.Object3D): number {
  let swapped = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (!material?.userData?.["hitregAtlas"] || !material.map) return;
    if (!mesh.geometry.getAttribute(ATLAS_RECT_ATTRIBUTE)) return;
    mesh.material = atlasMaterialFor(material);
    swapped++;
  });
  return swapped;
}
