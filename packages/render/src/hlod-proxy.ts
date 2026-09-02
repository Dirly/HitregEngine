import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { SceneDoc, VoxelMeshSource } from "@hitreg/core";
import { FOLIAGE_WIND } from "./foliage-wind.js";
import {
  buildScene,
  extractGltfSubmeshes,
  geometryFor,
  loadGltf,
  materialForId,
  polygonGeometry,
  type BuildOptions, cachedMergedMaterial } from "./scene-builder.js";
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

/** The only attributes a merged PROP bucket carries (see `prepForMerge`). */
const MERGE_ATTRIBUTES = ["position", "normal", "uv"] as const;

type AnyAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute | THREE.GLBufferAttribute;

/**
 * A private copy of one attribute — de-interleaved if the source was
 * interleaved (glTF accessors sharing a strided bufferView routinely are).
 *
 * `BufferAttribute.clone()` would do for the plain case, but
 * `InterleavedBufferAttribute.clone()` de-interleaves through a plain JS array
 * *and logs to the console every time*, which at a supercell's worth of props
 * is its own measurable cost.
 */
function ownedAttribute(attr: AnyAttribute): THREE.BufferAttribute {
  const interleaved = attr as THREE.InterleavedBufferAttribute;
  const itemSize = attr.itemSize;
  if (interleaved.isInterleavedBufferAttribute) {
    const data = interleaved.data.array;
    const stride = interleaved.data.stride;
    // same typed-array class as the interleaved buffer, so a quantized /
    // normalized attribute stays byte-for-byte what it was
    const ctor = data.constructor as unknown as Float32ArrayConstructor;
    const out = new ctor(interleaved.count * itemSize);
    for (let i = 0, o = 0, base = interleaved.offset; i < interleaved.count; i++, base += stride) {
      for (let c = 0; c < itemSize; c++) out[o++] = data[base + c]!;
    }
    return new THREE.BufferAttribute(out, itemSize, interleaved.normalized);
  }
  const plain = attr as THREE.BufferAttribute;
  const copy = new THREE.BufferAttribute(plain.array.slice(), itemSize, plain.normalized);
  copy.gpuType = plain.gpuType;
  return copy;
}

/**
 * Normalize a geometry so a batch of them can merge: carrying exactly
 * position/normal/uv (mergeGeometries rejects mismatched attribute sets, e.g.
 * the uv-less wedge next to a boxes' uvs), owned by us so the caller can bake
 * the placement in with `applyMatrix4`, and with NO bounding volumes.
 *
 * Three things this deliberately does not do, each of which used to be most of
 * the cost of a supercell bake (measured at ~11% of all main-thread time over
 * a 30s flight, before this):
 *
 * 1. **It does not de-index.** `mergeGeometries` requires its inputs to be
 *    *consistently* indexed or non-indexed — not necessarily non-indexed.
 *    De-indexing an imported mesh multiplies its vertex count by 3-6x (indices
 *    are 3 per triangle; a welded mesh has roughly half a vertex per triangle),
 *    and every one of those vertices is then copied, matrix-transformed,
 *    normal-transformed and merged. The bucket decides at merge time
 *    (`mergeBucket`), so only a bucket that genuinely MIXES indexed and
 *    non-indexed sources pays the flattening.
 * 2. **It does not copy attributes it is about to throw away.** The old shape
 *    was `prepForMerge(sub.geometry.clone())`: `clone()` duplicated every
 *    attribute (tangent, uv2, color, joints/weights...), `toNonIndexed()`
 *    expanded all of them again, and only then were they deleted. Now only
 *    position/normal/uv are ever touched, and exactly once.
 * 3. **It leaves `boundingBox`/`boundingSphere` null.** `applyMatrix4`
 *    recomputes whichever volume is already set — and GLTFLoader sets BOTH on
 *    every primitive it loads, so every prop walked its vertices twice more
 *    for bounds that the merge throws away. The renderer computes the merged
 *    result's bounds once, lazily, which is all anything actually reads.
 *
 * `shared` says the input came from the glTF cache and must not be mutated or
 * disposed: other chunks and other instances of the same model hold the same
 * object. Freshly built primitive/polygon geometry passes `false` and is
 * adapted in place, so it costs no copy at all.
 */
function prepForMerge(geometry: THREE.BufferGeometry, shared: boolean): THREE.BufferGeometry {
  // The one case that still has to de-index: a source with no normals. The old
  // path computed them AFTER de-indexing, which yields flat, per-triangle
  // normals — what glTF specifies for a primitive with no NORMAL. Computing
  // them on the indexed geometry would smooth across shared vertices instead,
  // a visible change, so this (rare) case keeps the old shape exactly.
  const source = geometry.index && !geometry.getAttribute("normal") ? geometry.toNonIndexed() : geometry;
  // `toNonIndexed` already handed back a fresh geometry; anything else is only
  // ours to mutate when the caller said so.
  const owned = source !== geometry || !shared;

  const count = source.getAttribute("position").count;
  let g: THREE.BufferGeometry;
  if (owned) {
    g = source;
    for (const name of Object.keys(g.attributes)) {
      if (!(MERGE_ATTRIBUTES as readonly string[]).includes(name)) g.deleteAttribute(name);
    }
  } else {
    g = new THREE.BufferGeometry();
    if (source.index) g.setIndex(ownedAttribute(source.index));
    for (const name of MERGE_ATTRIBUTES) {
      const attr = source.getAttribute(name);
      if (attr) g.setAttribute(name, ownedAttribute(attr));
    }
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  if (!g.getAttribute("uv")) {
    g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  g.boundingBox = null;
  g.boundingSphere = null;
  return g;
}

/**
 * Merge one bucket, keeping the index when every member has one.
 *
 * `mergeGeometries` handles indexed input, but through a path that pushes
 * every merged index into a plain JS array and then re-scans and re-types it —
 * new cost that would eat into what staying indexed just saved. `mergeIndexed`
 * writes the typed arrays directly and hands back to `mergeGeometries` for
 * anything it doesn't recognise, so the fallback is always the old behaviour.
 */
function mergeBucket(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geoms.length === 1) return geoms[0]!;
  let indexed = 0;
  for (const g of geoms) if (g.index) indexed += 1;
  if (indexed === geoms.length) return mergeIndexed(geoms) ?? mergeGeometries(geoms, false);
  if (indexed > 0) {
    // A bucket that genuinely mixes — an indexed box primitive next to a
    // non-indexed extrusion, same material. mergeGeometries needs one or the
    // other, so flatten, exactly as this file used to do unconditionally.
    return mergeGeometries(
      geoms.map((g) => (g.index ? g.toNonIndexed() : g)),
      false,
    );
  }
  return mergeGeometries(geoms, false);
}

/**
 * Concatenate a set of consistently-shaped INDEXED geometries into one.
 *
 * Returns null — caller falls back to `mergeGeometries` — for anything outside
 * the shape this file produces: a missing index, a differing attribute set,
 * interleaved or normalized or differently-typed attributes. Nothing here
 * reads or writes a shared object; every buffer is freshly allocated.
 */
function mergeIndexed(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  const first = geoms[0]!;
  const names = Object.keys(first.attributes);
  if (!names.includes("position")) return null;
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geoms) {
    if (!g.index) return null;
    if (Object.keys(g.attributes).length !== names.length) return null;
    const vertices = g.attributes["position"]?.count;
    if (vertices === undefined) return null;
    for (const name of names) {
      // every attribute must span the same vertices, or the per-geometry
      // offsets below would drift apart from the index remapping
      if (g.attributes[name]?.count !== vertices) return null;
      const attr = g.attributes[name] as THREE.BufferAttribute | undefined;
      const ref = first.attributes[name] as THREE.BufferAttribute;
      if (!attr || (attr as AnyAttribute as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return null;
      if (attr.normalized || ref.normalized) return null;
      if (attr.itemSize !== ref.itemSize) return null;
      if (attr.array.constructor !== ref.array.constructor) return null;
      if (attr.gpuType !== ref.gpuType) return null;
    }
    vertexCount += vertices;
    indexCount += g.index.count;
  }
  const merged = new THREE.BufferGeometry();
  for (const name of names) {
    const ref = first.attributes[name] as THREE.BufferAttribute;
    const ctor = ref.array.constructor as unknown as Float32ArrayConstructor;
    const out = new ctor(vertexCount * ref.itemSize);
    let offset = 0;
    for (const g of geoms) {
      const attr = g.attributes[name] as THREE.BufferAttribute;
      out.set(attr.array as unknown as ArrayLike<number>, offset);
      offset += attr.count * ref.itemSize;
    }
    const attribute = new THREE.BufferAttribute(out, ref.itemSize, false);
    attribute.gpuType = ref.gpuType;
    merged.setAttribute(name, attribute);
  }
  // 65536 distinct vertices is exactly what a Uint16 index can address
  const index = vertexCount > 65536 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const g of geoms) {
    const src = g.index!;
    const array = src.array;
    for (let i = 0; i < src.count; i++) index[indexOffset + i] = array[i]! + vertexOffset;
    vertexOffset += g.attributes["position"]!.count;
    indexOffset += src.count;
  }
  merged.setIndex(new THREE.BufferAttribute(index, 1));
  return merged;
}

/**
 * How much coarser a voxel cell is meshed for its HLOD proxy.
 *
 * 4 rather than 2: measured on the voxel demo it cut resident vertex memory
 * from 291MB to 247MB. It barely moved draw CPU — frustum culling already
 * discards most far-ring geometry before it is submitted, so raw triangle
 * counts out there overstate what is actually drawn — but the memory is real
 * and the detail is not visible: the far ring starts beyond the point where
 * this scene's height fog is ~85% opaque. Push further only if ridgelines
 * start to read as flat at the ring boundary.
 */
const HLOD_VOXEL_COARSEN = 4;

/**
 * Merge-prep that KEEPS the terrain's splat weights and biome tint. Safe only
 * within an all-voxel bucket, where every geometry has the same attributes.
 *
 * The geometry is ours outright (`voxelGeometryFromMesh` just built it from
 * this cell's mesh), so this adapts it in place — and, as of the same pass that
 * stopped de-indexing props, it STAYS INDEXED. Voxel geometry is indexed by
 * construction, so a whole bucket is consistently indexed and merges fine that
 * way. On the preferred async-supercell path the bucket holds exactly one
 * geometry and never merges at all, which made the old `toNonIndexed()` here
 * pure waste: ~3x the vertices, in CPU time and in resident VRAM, on the
 * single largest geometry in the scene.
 */
function prepVoxelForMerge(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!geometry.getAttribute("uv")) {
    // triplanar terrain never samples uv, but mergeGeometries requires every
    // input to declare the same set of attributes
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geometry;
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
        // `sub.geometry` belongs to the shared glTF cache — every other chunk
        // and every un-merged instance of this model holds the same object, so
        // prepForMerge copies rather than touches it (and copies ONCE, which
        // the old `prepForMerge(sub.geometry.clone())` did not: clone()
        // duplicated every attribute, then toNonIndexed() expanded them again).
        const prepped = prepForMerge(sub.geometry, true);
        prepped.applyMatrix4(matrix.copy(placement).multiply(sub.localMatrix));
        const bucketKey = `gltf:${key}#${index}`;
        // merged geometry, so the MERGED cache: the instanced clones carry the
        // InstancedProps transform node and expect instance attributes
        const material = withoutFoliageWind(cachedMergedMaterial(bucketKey, sub.material));
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
      // The merge already baked every cell's transform in, so this is only the
      // uv-declaration prep that mergeGeometries used to need — no
      // `applyMatrix4`, which means the exact bounds the mesher handed back
      // survive onto the mesh. That saves the renderer a lazy
      // `computeBoundingSphere()` over the biggest vertex buffer in the scene
      // the first time the supercell is culled.
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
      // `applyMatrix4` recomputes whichever bounding volume is already set, and
      // `geometryFrom` sets BOTH from the mesher's own min/max. Those are stale
      // the moment the cell transform is baked in, and the merged result gets
      // its own bounds from the renderer anyway — so drop them rather than pay
      // two extra full walks of the cell's vertices for a value nobody reads.
      prepped.boundingBox = null;
      prepped.boundingSphere = null;
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

    // freshly built above and referenced by nothing else, so prepForMerge can
    // adapt it in place instead of copying
    const prepped = prepForMerge(geometry, false);
    prepped.applyMatrix4(entityTransform(entity));

    const key = mesh.material ?? "__default";
    const material = materialForId(mesh.material, options, materialCache);
    addToBucket(key, material, prepped);
  }

  let mergedDrawCalls = 0;
  for (const [key, geoms] of voxelBuckets) {
    const merged = mergeBucket(geoms);
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
    const merged = mergeBucket(bucket.geoms);
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
