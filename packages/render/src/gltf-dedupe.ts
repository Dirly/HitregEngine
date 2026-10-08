import * as THREE from "three/webgpu";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

/**
 * Cross-file sharing for models exported without the kit tools' naming.
 *
 * `shareNamedTextures` (scene-builder) swaps every texture named
 * `hitreg-shared:<content-hash>` for the first one loaded under that name, so a
 * kit of N files embedding one atlas uploads it once. Only the WFC kit tool
 * writes that name. Town buildings exported straight from Blender embed the
 * same handful of kit PNGs in every file — 658 images, 37 distinct, across
 * the MMO's 55 town GLBs — and each embedded copy became its own GPU texture
 * and its own material, so no two houses could ever share a static batch.
 *
 * `nameEmbeddedTextures` gives such textures that name from their bytes;
 * `shareModelMaterials` then gives identical materials one object. Both are
 * scoped to the model's asset folder (`models/towns`), so a texture or
 * material is only ever shared with models from the same family — the
 * per-asset modifiers (texture filter, brightness, wind) mutate shared state
 * in place, and one family's settings must not reach another's.
 */

const PREFIX = "hitreg-shared:";

/** The asset family of a model URL: its first two path segments ("models/towns"). */
export function modelScope(url: string): string {
  let file = url;
  const query = url.indexOf("file=");
  if (query >= 0) file = decodeURIComponent(url.slice(query + 5).split("&")[0]!);
  const parts = file.replace(/^\/+/, "").split("/");
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/") || "root";
}

/** 64-bit-ish content key: two independent 32-bit hashes and the length. */
function hashBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]!;
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b + v, 0x85ebca6b) ^ (b >>> 13);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${bytes.length.toString(36)}`;
}

function samplerKey(t: THREE.Texture): string {
  return [
    t.wrapS, t.wrapT, t.magFilter, t.minFilter, t.colorSpace, t.flipY ? 1 : 0, t.channel,
    t.offset.x, t.offset.y, t.repeat.x, t.repeat.y, t.rotation, t.center.x, t.center.y,
  ].join(",");
}

function forEachTextureSlot(root: THREE.Object3D, fn: (texture: THREE.Texture) => void): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        const texture = value as THREE.Texture | null | undefined;
        if (texture && texture.isTexture === true) fn(texture);
      }
    }
  });
}

/**
 * Name every embedded/external image texture of a freshly loaded glTF by its
 * content (and sampler), unless the export already did. Returns how many
 * texture slots were named.
 */
export async function nameEmbeddedTextures(gltf: GLTF, scope: string): Promise<number> {
  const parser = gltf.parser as unknown as {
    json: { textures?: Array<{ source?: number }>; images?: Array<{ uri?: string; bufferView?: number }> };
    getDependency(type: string, index: number): Promise<unknown>;
  };
  const json = parser?.json;
  if (!json || typeof parser.getDependency !== "function") return 0; // not a GLTFLoader result (tests, hand-built)
  const keyBySource = new Map<THREE.Source<unknown>, string>();
  for (let i = 0; i < (json.textures?.length ?? 0); i++) {
    const sourceIndex = json.textures![i]!.source;
    const image = sourceIndex === undefined ? undefined : json.images?.[sourceIndex];
    if (!image) continue;
    let key: string | null = null;
    try {
      if (image.bufferView !== undefined) {
        const buffer = (await parser.getDependency("bufferView", image.bufferView)) as ArrayBuffer;
        key = hashBytes(new Uint8Array(buffer));
      } else if (image.uri && !image.uri.startsWith("data:")) {
        key = `uri:${image.uri}`;
      }
      if (!key) continue;
      const texture = (await parser.getDependency("texture", i)) as THREE.Texture | null;
      if (texture?.source) keyBySource.set(texture.source, key);
    } catch {
      // an unreadable texture keeps its own copy, as before
    }
  }
  let named = 0;
  forEachTextureSlot(gltf.scene, (texture) => {
    if (texture.name.startsWith(PREFIX)) return;
    const key = keyBySource.get(texture.source);
    if (!key) return;
    texture.name = `${PREFIX}${scope}:${key}:${samplerKey(texture)}`;
    named += 1;
  });
  return named;
}

/** Canonical material per (scope, signature). */
const sharedMaterials = new Map<string, THREE.Material>();

/**
 * Everything that can change how a material draws, or null when it holds
 * something we cannot compare (a node graph, a callback): those stay unique.
 */
function materialSignature(material: THREE.Material): string | null {
  if (material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return null;
  if (Object.keys(material.userData).length > 0) return null;
  const parts: string[] = [material.type, material.name.replace(/\.\d+$/, "")];
  for (const key of Object.keys(material).sort()) {
    if (key === "uuid" || key === "id" || key === "name" || key === "version" || key === "userData" || key.startsWith("_")) continue;
    const value = (material as unknown as Record<string, unknown>)[key];
    if (value === null || value === undefined) parts.push(`${key}=-`);
    else if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") parts.push(`${key}=${value}`);
    else if ((value as THREE.Texture).isTexture) parts.push(`${key}=t:${(value as THREE.Texture).uuid}`);
    else if ((value as THREE.Color).isColor) parts.push(`${key}=c:${(value as THREE.Color).getHexString()}`);
    else if ((value as THREE.Vector2).isVector2 || (value as THREE.Vector3).isVector3 || (value as THREE.Euler).isEuler) {
      parts.push(`${key}=v:${(value as THREE.Vector3).toArray().join(",")}`);
    } else if (typeof value === "function") continue;
    else if (Array.isArray(value) && value.every((v) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")) {
      parts.push(`${key}=[${value.join(",")}]`);
    } else if (Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as object).every((v) => v === null || ["number", "string", "boolean"].includes(typeof v))) {
      parts.push(`${key}=${JSON.stringify(value)}`); // e.g. `defines`
    } else return null; // anything else (node graphs, clipping planes, …): not comparable
  }
  return parts.join("|");
}

/**
 * Give identical materials (same signature, which includes their now-shared
 * textures) one object, so meshes from different files can batch together.
 * Skinned meshes are left alone (they get per-model rim copies). Returns how
 * many mesh material slots were re-pointed.
 */
export function shareModelMaterials(root: THREE.Object3D, scope: string): number {
  let swapped = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh || !mesh.material) return;
    const swap = (material: THREE.Material): THREE.Material => {
      const signature = materialSignature(material);
      if (!signature) return material;
      const key = `${scope}|${signature}`;
      const shared = sharedMaterials.get(key);
      if (!shared) {
        sharedMaterials.set(key, material);
        return material;
      }
      if (shared !== material) swapped += 1;
      return shared;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return swapped;
}
