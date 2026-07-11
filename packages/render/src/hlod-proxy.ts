import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { SceneDoc } from "@hitreg/core";
import {
  buildScene,
  geometryFor,
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
 * material, so a distant town of a hundred boxes draws in a handful of calls
 * with no scripts, physics, or entity picking.
 *
 * Primitive and polygon geometry merge synchronously here. Asset (glTF) meshes
 * can't merge without loading and are rendered un-merged via the normal build
 * path (still script/physics-free) — model-LOD/instanced baking for those is a
 * later step (§7 "Model LODs"). Heightmaps never reach here (terrain has its
 * own LOD pyramid, and the core assembler already excludes them).
 */

interface ProxyMesh {
  source:
    | { kind: "primitive"; shape: string; size: [number, number, number] }
    | { kind: "polygon"; points: Array<[number, number]>; height: number; bevel?: { size: number; segments: number } }
    | { kind: "asset"; assetId: string; node?: string }
    | { kind: "heightmap" };
  material?: string;
}

interface ProxyTransform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
}

export interface HlodProxyStats {
  /** Merged draw calls produced — one per distinct material. */
  mergedDrawCalls: number;
  /** Primitive/polygon meshes folded into those draw calls. */
  mergedSources: number;
  /** Asset (glTF) entities rendered un-merged via the normal build path. */
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

export function buildHlodProxy(doc: SceneDoc, options: BuildOptions = {}): HlodProxy {
  const group = new THREE.Group();
  group.name = "hlod-proxy";
  const materialCache = new Map<string, THREE.Material>();
  const buckets = new Map<string, { material: THREE.Material; geoms: THREE.BufferGeometry[] }>();
  const deferred: SceneDoc["entities"] = {};

  const matrix = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  let mergedSources = 0;

  for (const [id, entity] of Object.entries(doc.entities)) {
    const mesh = entity.components["mesh"] as ProxyMesh | undefined;
    if (!mesh) continue;
    if (mesh.source.kind === "asset" || mesh.source.kind === "heightmap") {
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
    prepped.applyMatrix4(matrix.compose(p, q, s));

    const key = mesh.material ?? "__default";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { material: materialForId(mesh.material, options, materialCache), geoms: [] };
      buckets.set(key, bucket);
    }
    bucket.geoms.push(prepped);
    mergedSources += 1;
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
