import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { SceneDoc } from "@hitreg/core";
import {
  buildScene,
  cachedInstancedMaterial,
  extractGltfSubmeshes,
  geometryFor,
  loadGltf,
  materialForId,
  polygonGeometry,
  type BuildOptions,
} from "./scene-builder.js";

/**
 * Build a cheap "HLOD proxy" render group from a static build document
 * (open-world-streaming-plan §7, consumed at the `hlod`/`far` rings). The build
 * doc — produced by @hitreg/core's `assembleHlodBuildDoc` — is a flat set of
 * static, parentless entities whose transforms are already baked into
 * supercell-local space. This is the Three.js half of the bake: geometry that
 * would cost one draw call per entity collapses into ONE merged mesh per
 * material, so a distant town of a hundred boxes — or a hundred trees — draws
 * in a handful of calls with no scripts, physics, or entity picking.
 *
 * Primitive/polygon geometry AND glTF (asset) meshes both merge here — a
 * supercell's worth of the same tree model collapses into one real draw call,
 * not just one InstancedMesh per supercell (this used to defer glTF entities
 * to the normal, un-merged instancing path entirely; real content is
 * overwhelmingly imported models, not primitives, so that made merging nearly
 * useless in practice). What still can't merge: skinned meshes (instancing/
 * merging don't support skeletal animation — though animated entities are
 * already excluded upstream by `isStaticRenderEntity`), a glTF whose asset id
 * has no resolvable URL, or a named `node` that doesn't exist in the model —
 * those fall back to the normal, un-merged build path (still script/
 * physics-free). Heightmaps never reach here (terrain has its own LOD
 * pyramid, and the core assembler already excludes them); path meshes defer
 * too (arc-length UVs and per-curve winding don't merge cleanly, and roads/
 * rivers are usually few enough that one draw call each is cheap).
 */

interface ProxyMesh {
  source:
    | { kind: "primitive"; shape: string; size: [number, number, number] }
    | { kind: "polygon"; points: Array<[number, number]>; height: number; bevel?: { size: number; segments: number } }
    | { kind: "asset"; assetId: string; node?: string }
    | { kind: "heightmap" }
    | { kind: "path" };
  material?: string;
}

interface ProxyTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface HlodProxyStats {
  /** Merged draw calls produced — one per distinct material/submesh group. */
  mergedDrawCalls: number;
  /** Meshes (primitive/polygon/glTF submeshes) folded into those draw calls. */
  mergedSources: number;
  /** Entities rendered un-merged via the normal build path (no resolvable
   * model URL, unknown node, heightmap, or path geometry). */
  deferred: number;
}

export interface HlodProxy {
  /** Root group; position it at the supercell origin (build doc is origin-local). */
  group: THREE.Group;
  stats: HlodProxyStats;
}

/**
 * Normalize a geometry so a batch of them can merge: non-indexed, and carrying
 * exactly position/normal/uv (mergeGeometries rejects mismatched attribute sets,
 * e.g. the uv-less wedge next to a boxes' uvs).
 */
function prepForMerge(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    const count = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  }
  return g;
}

export async function buildHlodProxy(doc: SceneDoc, options: BuildOptions = {}): Promise<HlodProxy> {
  const group = new THREE.Group();
  group.name = "hlod-proxy";
  const materialCache = new Map<string, THREE.Material>();
  const buckets = new Map<string, { material: THREE.Material | THREE.Material[]; geoms: THREE.BufferGeometry[] }>();
  const deferred: SceneDoc["entities"] = {};

  const matrix = new THREE.Matrix4();
  const entityMatrix = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  let mergedSources = 0;

  const entityTransform = (entity: SceneDoc["entities"][string]): THREE.Matrix4 => {
    const t = entity.components["transform"] as ProxyTransform | undefined;
    if (t) {
      p.fromArray(t.position);
      q.fromArray(t.rotation);
      s.fromArray(t.scale);
    } else {
      p.set(0, 0, 0);
      q.identity();
      s.set(1, 1, 1);
    }
    return entityMatrix.compose(p, q, s);
  };
  const addToBucket = (key: string, material: THREE.Material | THREE.Material[], geometry: THREE.BufferGeometry): void => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material, geoms: [] };
      buckets.set(key, bucket);
    }
    bucket.geoms.push(geometry);
    mergedSources += 1;
  };

  // glTF (asset) entities: group by (assetId, node) so each unique model is
  // only loaded once per supercell bake, regardless of how many entities
  // place it (loadGltf itself also caches by URL across bakes).
  const assetEntities = new Map<string, Array<[string, SceneDoc["entities"][string]]>>();
  for (const [id, entity] of Object.entries(doc.entities)) {
    const mesh = entity.components["mesh"] as ProxyMesh | undefined;
    if (!mesh || mesh.source.kind !== "asset") continue;
    const key = `${mesh.source.assetId}#${mesh.source.node ?? ""}`;
    let list = assetEntities.get(key);
    if (!list) {
      list = [];
      assetEntities.set(key, list);
    }
    list.push([id, entity]);
  }
  for (const [key, entities] of assetEntities) {
    const first = entities[0]![1].components["mesh"] as ProxyMesh & { source: { kind: "asset" } };
    const { assetId, node } = first.source;
    const url = options.resolveModel?.(assetId);
    if (!url) {
      for (const [id, entity] of entities) deferred[id] = entity;
      continue;
    }
    let submeshes: ReturnType<typeof extractGltfSubmeshes>;
    try {
      const gltf = await loadGltf(url);
      submeshes = extractGltfSubmeshes(gltf, node);
    } catch (error) {
      console.warn(`[render] hlod merge: failed to load "${assetId}":`, error);
      submeshes = null;
    }
    if (submeshes === null || submeshes.length === 0) {
      for (const [id, entity] of entities) deferred[id] = entity;
      continue;
    }
    for (const [, entity] of entities) {
      const placement = entityTransform(entity).clone();
      submeshes.forEach((sub, index) => {
        const prepped = prepForMerge(sub.geometry.clone());
        prepped.applyMatrix4(matrix.copy(placement).multiply(sub.localMatrix));
        const bucketKey = `gltf:${key}#${index}`;
        const material = cachedInstancedMaterial(bucketKey, sub.material);
        addToBucket(bucketKey, material, prepped);
      });
    }
  }

  for (const [id, entity] of Object.entries(doc.entities)) {
    const mesh = entity.components["mesh"] as ProxyMesh | undefined;
    if (!mesh || mesh.source.kind === "asset") continue; // handled above
    if (mesh.source.kind === "heightmap" || mesh.source.kind === "path") {
      deferred[id] = entity;
      continue;
    }

    let geometry: THREE.BufferGeometry;
    if (mesh.source.kind === "primitive") {
      geometry = geometryFor(mesh.source.shape, mesh.source.size);
      // a plane's mesh is laid flat by a -90° X rotation in the scene builder;
      // bake that into the geometry so the merged copy matches.
      if (mesh.source.shape === "plane") geometry.rotateX(-Math.PI / 2);
    } else {
      geometry = polygonGeometry(mesh.source);
    }

    const prepped = prepForMerge(geometry);
    prepped.applyMatrix4(entityTransform(entity));

    const key = mesh.material ?? "__default";
    const material = materialForId(mesh.material, options, materialCache);
    addToBucket(key, material, prepped);
  }

  let mergedDrawCalls = 0;
  for (const bucket of buckets.values()) {
    const merged =
      bucket.geoms.length === 1 ? bucket.geoms[0]! : mergeGeometries(bucket.geoms, false);
    if (!merged) continue; // mismatched attributes despite prep — skip rather than crash
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    mergedDrawCalls += 1;
  }

  const deferredCount = Object.keys(deferred).length;
  if (deferredCount > 0) {
    const built = buildScene({ version: 1, name: `${doc.name}:deferred`, entities: deferred }, options);
    group.add(built.scene);
  }

  return { group, stats: { mergedDrawCalls, mergedSources, deferred: deferredCount } };
}
