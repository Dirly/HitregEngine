/**
 * Collision geometry for asset-mesh colliders on the server, read off disk.
 *
 * The browser cooks a `collider.shape: "trimesh" | "convex"` on an asset mesh
 * from the GLB its renderer loaded. The server used to have no provider at
 * all, so every such collider fell back to a `collider.size` box (1 m by
 * default) at the entity ORIGIN — a baked rock formation whose vertices are
 * in world space was simply absent on the authority. The client predicted its
 * player standing on the rock and the server, simulating the same body on the
 * terrain underneath, pulled it back down into the geometry.
 *
 * This provider reads the model's bytes synchronously (server content URLs
 * are file paths, see assets.ts) and extracts the same triangles the browser
 * does (@hitreg/physics `gltfCollisionGeometry`), memoized per (file, node).
 */

import fs from "node:fs";
import path from "node:path";
import { gltfCollisionGeometry, type MeshGeometryData } from "@hitreg/physics";

export function fileMeshGeometry(
  resolveFile: (assetId: string) => string | undefined,
): (assetId: string, node?: string) => MeshGeometryData | null {
  const cooked = new Map<string, MeshGeometryData | null>();
  return (assetId, node) => {
    const file = resolveFile(assetId);
    if (!file) return null;
    const key = `${file}\0${node ?? ""}`;
    const hit = cooked.get(key);
    if (hit !== undefined) return hit;
    let geometry: MeshGeometryData | null = null;
    try {
      geometry = gltfCollisionGeometry(fs.readFileSync(file), {
        ...(node !== undefined ? { node } : {}),
        loadBuffer: (uri) => fs.readFileSync(path.resolve(path.dirname(file), uri)),
      });
    } catch (error) {
      console.warn(`[server] collision geometry for "${assetId}" failed: ${(error as Error).message}`);
    }
    cooked.set(key, geometry);
    return geometry;
  };
}
