import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { SceneDoc, VoxelMeshSource } from "@hitreg/core";
import { FOLIAGE_WIND } from "./foliage-wind.js";
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
import { voxelGeometry, voxelGeometryFromMesh } from "./voxel-geometry.js";

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
    | {
        kind: "primitive";
        shape: string;
        size: [number, number, number];
        segments?: [number, number];
        uv?: { mode?: "stretch" | "world"; scale?: [number, number] };
      }
    | { kind: "polygon"; points: Array<[number, number]>; height: number; bevel?: { size: number; segments: number } }
    | { kind: "asset"; assetId: string; node?: string }
    | { kind: "voxel"; world: string; cell: [number, number]; lodStep?: number; yRange?: [number, number] }
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
/**
 * Strip vertex wind from a merged far proxy.
 *
 * The wind shader reads `positionGeometry` to work out how far up the plant a
 * vertex is. In a supercell merge those coordinates are no longer model-local
 * — every vertex has been baked into supercell space — so the height weight
 * saturates and the whole proxy shifts as one. Wind is invisible at proxy
 * range anyway, so the honest answer is to drop it rather than to feed the
 * shader coordinates it cannot interpret.
 */
function withoutFoliageWind(material: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
  const clear = (m: THREE.Material): THREE.Material => {
    const node = m as THREE.NodeMaterial;
    if (node.userData[FOLIAGE_WIND] && node.positionNode) {
      node.positionNode = null;
      node.userData[FOLIAGE_WIND] = false;
      node.needsUpdate = true;
    }
    return m;
  };
  if (Array.isArray(material)) return material.map(clear);
  return clear(material);
}

/** Bucket the cells by material and hand each its world matrix, for the worker. */
function groupVoxelCells(
  cells: Array<{ entity: SceneDoc["entities"][string]; source: VoxelMeshSource; key: string }>,
  transformOf: (entity: SceneDoc["entities"][string]) => THREE.Matrix4,
): Array<{ key: string; cells: Array<{ source: VoxelMeshSource; matrix: number[] }> }> {
  const byKey = new Map<string, Array<{ source: VoxelMeshSource; matrix: number[] }>>();
  for (const cell of cells) {
    const entry = {
      source: cell.source,
      // column-major, matching what mergeVoxelMeshes expects
      matrix: [...transformOf(cell.entity).elements],
    };
    const list = byKey.get(cell.key);
    if (list) list.push(entry);
    else byKey.set(cell.key, [entry]);
  }
  return [...byKey].map(([key, list]) => ({ key, cells: list }));
}

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

/**
 * How much coarser a voxel cell is meshed for its HLOD proxy. 2 quarters the
 * triangle count per cell while keeping the silhouette close enough that the
 * swap at the ring boundary does not read as a pop; 4 is cheaper still and
 * starts to visibly flatten ridgelines.
 */
const HLOD_VOXEL_COARSEN = 2;

/**
 * Merge-prep that KEEPS the terrain's splat weights and biome tint. Safe only
 * within an all-voxel bucket, where every geometry has the same attributes.
 */
function prepVoxelForMerge(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (!g.getAttribute("uv")) {
    // triplanar terrain never samples uv, but mergeGeometries requires every
    // input to declare the same set of attributes
    const count = g.getAttribute("position").count;
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return g;
}

/**
 * Asset-id-keyed material cache, MODULE-level — the same reasoning, and the
 * same bug, as `sharedAssetMaterialCache` in scene-builder.ts.
 *
 * This used to be created inside `buildHlodProxy`, i.e. once per supercell
 * bake. Every bake therefore built brand-new Material objects for terrain and
 * props that a dozen other supercells had already compiled, and each new
 * material is a new WebGPU render pipeline — a synchronous shader compile on
 * the main thread. Flying across the world bakes supercells continuously, so
 * the compiles never stopped: a 1200-unit flight took the renderer from 177 to
 * 630 live programs and produced main-thread stalls of 400-1050ms, which is
 * exactly the "it hitches when a chunk loads in" symptom. Geometry counts
 * stayed flat over the same flight, which is what pinned it on materials.
 *
 * docs/performance-lessons.md calls this "the one that mattered most" and it
 * had been fixed in scene-builder.ts but never here.
 *
 * SAFE TO SHARE because nothing disposes it: ChunkManager.disposeGroup()
 * deliberately never calls `material.dispose()` (see its comment), precisely
 * so one cell unloading cannot break every other cell holding the same
 * Material and its compiled pipeline.
 */
const sharedHlodMaterialCache = new Map<string, THREE.Material>();

export async function buildHlodProxy(doc: SceneDoc, options: BuildOptions = {}): Promise<HlodProxy> {
  const group = new THREE.Group();
  group.name = "hlod-proxy";
  const materialCache = sharedHlodMaterialCache;
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
        const material = withoutFoliageWind(cachedInstancedMaterial(bucketKey, sub.material));
        addToBucket(bucketKey, material, prepped);
      });
    }
  }

  // Voxel terrain gets its own bucket, for two reasons that both matter.
  //
  // First, it is generated: the proxy is re-meshed from the world field at a
  // COARSER lattice rather than merging the full-detail cell, so the far ring
  // costs a fraction of the triangles instead of the same ones in one draw
  // call. Merging alone would fix draw calls and nothing else, and terrain is
  // where the triangles actually are.
  //
  // Second, it carries per-vertex splat weights and a biome tint, which
  // `prepForMerge` strips (it must, or merging terrain with props would fail
  // on mismatched attributes). Every member of this bucket is terrain, so they
  // are all consistent and the attributes can be kept — without them the
  // distant terrain would render as a single flat layer and the LOD swap would
  // be a visible colour pop.
  const voxelBuckets = new Map<string, THREE.BufferGeometry[]>();
  // Gather first, mesh second. A supercell holds up to 16 member cells and
  // each needs its own marching-cubes run at the coarse lattice; meshing them
  // one at a time inside the loop would serialise the worker pool and give
  // back most of what moving off-thread just bought, so every cell is
  // requested at once and the pool fans them across its workers.
  const voxelCells: Array<{ entity: (typeof doc.entities)[string]; source: VoxelMeshSource; key: string }> = [];
  for (const entity of Object.values(doc.entities)) {
    const mesh = entity.components["mesh"] as ProxyMesh | undefined;
    if (mesh?.source.kind !== "voxel") continue;
    voxelCells.push({
      entity,
      source: {
        ...mesh.source,
        lodStep: Math.max(mesh.source.lodStep ?? 1, 1) * HLOD_VOXEL_COARSEN,
      },
      key: mesh.material ?? "__default",
    });
  }
  // Preferred path: the worker meshes every member cell AND merges each
  // material's cells into one geometry, so nothing but the finished buffers
  // crosses back.
  const supercellRequest = voxelCells.length > 0 ? groupVoxelCells(voxelCells, entityTransform) : [];
  const offSupercell =
    supercellRequest.length > 0 ? options.voxelSupercellAsync?.(supercellRequest) : null;
  if (offSupercell) {
    for (const { key, mesh } of await offSupercell) {
      const geometry = voxelGeometryFromMesh(mesh);
      if (!geometry) continue;
      // the merge already baked every cell's transform in, so this is only the
      // uv-declaration prep that mergeGeometries used to need
      voxelBuckets.set(key, [prepVoxelForMerge(geometry)]);
      mergedSources += 1;
    }
  } else {
    const meshed = await Promise.all(
      voxelCells.map(async (cell) => {
        const off = options.voxelMeshAsync?.(cell.source);
        if (off) {
          const mesh = await off;
          return mesh ? voxelGeometryFromMesh(mesh) : null;
        }
        return voxelGeometry(cell.source);
      }),
    );
    for (let i = 0; i < voxelCells.length; i++) {
      const geometry = meshed[i];
      if (!geometry) continue;
      const cell = voxelCells[i]!;
      const prepped = prepVoxelForMerge(geometry);
      prepped.applyMatrix4(entityTransform(cell.entity));
      const list = voxelBuckets.get(cell.key);
      if (list) list.push(prepped);
      else voxelBuckets.set(cell.key, [prepped]);
      mergedSources += 1;
    }
  }

  for (const [id, entity] of Object.entries(doc.entities)) {
    const mesh = entity.components["mesh"] as ProxyMesh | undefined;
    if (!mesh || mesh.source.kind === "asset") continue; // handled above
    if (mesh.source.kind === "voxel") continue; // handled just above
    if (mesh.source.kind === "heightmap" || mesh.source.kind === "path") {
      deferred[id] = entity;
      continue;
    }
    // Anything else with no merge path here — editable poly meshes, and any
    // future source kind — is DEFERRED, not guessed at. Falling through to
    // polygonGeometry() with a source that has no `points` threw, and a throw
    // in here loses the whole supercell, terrain included.
    if (mesh.source.kind !== "primitive" && mesh.source.kind !== "polygon") {
      deferred[id] = entity;
      continue;
    }

    let geometry: THREE.BufferGeometry;
    if (mesh.source.kind === "primitive") {
      geometry = geometryFor(
        mesh.source.shape,
        mesh.source.size,
        mesh.source.segments,
        undefined,
        // a proxy that dropped world UVs would tile differently from the mesh it
        // replaces, so the swap-in would pop the texture scale.
        mesh.source.uv,
      );
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
  for (const [key, geoms] of voxelBuckets) {
    const merged = geoms.length === 1 ? geoms[0]! : mergeGeometries(geoms, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, materialForId(key === "__default" ? undefined : key, options, materialCache));
    // distant terrain neither casts nor receives: shadow cascades do not reach
    // the far ring, and rasterising a supercell of terrain into them is pure cost
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    mergedDrawCalls += 1;
  }

  for (const bucket of buckets.values()) {
    const merged =
      bucket.geoms.length === 1 ? bucket.geoms[0]! : mergeGeometries(bucket.geoms, false);
    if (!merged) continue; // mismatched attributes despite prep — skip rather than crash
    const mesh = new THREE.Mesh(merged, bucket.material);
    // Same reasoning as the voxel buckets above, which this block used to
    // contradict: a proxy only exists for cells in the FAR ring, and the
    // shadow cascades stop at `shadowFarPlane()` (120 world units by default)
    // well inside it. Casting from here bought no visible shadow and cost a
    // draw call per bucket per cascade — measured at 26% of all triangles
    // submitted per frame in the voxel demo, for nothing.
    mesh.castShadow = false;
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
