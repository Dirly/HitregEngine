import { MeshoptClusterizer, MeshoptSimplifier } from "meshoptimizer";

/**
 * Cluster-DAG continuous LOD — the Nanite idea reduced to what runs well in a
 * browser without mesh shaders or 64-bit atomics: preprocessing turns a mesh
 * into a directed acyclic graph of ~128-triangle clusters where each level is
 * a simplified version of the one below, and at runtime a CPU pass picks the
 * cut through that graph whose geometric error projects below a pixel
 * threshold. No LOD authoring, no popping seams: the cut is crack-free by
 * construction, and detail follows the camera per cluster, not per mesh.
 *
 * The build (`buildClusterDag`):
 *  1. Split the mesh into leaf clusters (meshoptimizer `buildMeshlets`).
 *  2. Group adjacent clusters (by shared edges; nearest-centre fallback).
 *  3. Merge each group's triangles and simplify to ~half with
 *     `LockBorder` — vertices on the group's border can't move, so two groups
 *     sharing an edge simplify to geometry that still shares it exactly.
 *  4. Split the simplified group back into clusters: those are the group's
 *     *parents*, one level up. Their error is the group's (the simplifier's
 *     reported deviation, forced monotonic against the children's), their
 *     bounding sphere the group's (enclosing every child's) — monotonic
 *     bounds are what make the runtime cut consistent from any viewpoint.
 *  5. Repeat with the parents until one cluster remains or simplification
 *     stalls (group size grows when it does).
 *
 * The simplifier never creates vertices: every level indexes the ORIGINAL
 * vertex buffer, so a cluster is just an index list. That is what makes the
 * draw side trivial (`clustered-mesh.ts` concatenates the cut's index lists
 * into one dynamic index buffer over the untouched vertex data — one draw
 * call, any material, both backends) and it is also why the crack-free
 * guarantee holds bit-exactly rather than approximately.
 *
 * What is deliberately NOT here, per the assessment: GPU-driven selection,
 * a software rasteriser, and streaming. The selection loop is O(clusters)
 * on the CPU per mesh per frame, which is fine for hero meshes and terrain
 * patches, and not the tool for ten thousand instanced props (those have the
 * impostor tiers).
 */

export interface ClusterSphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface DagCluster {
  /** Triangle list into the shared vertex buffer. */
  indices: Uint32Array;
  /** Geometric error of this cluster's geometry vs. the original, in the
   * mesh's own units — the error of the group that produced it (0 for leaves). */
  error: number;
  /** Bounding sphere `error` is judged against — the producing group's
   * (encloses everything this cluster stands in for); leaves use their own. */
  sphere: ClusterSphere;
  /** The group this cluster is a child of (whose parents replace it), or -1
   * for a root cluster nothing coarser replaces. */
  parentGroup: number;
  /** 0 = leaf (original triangles), higher = coarser. */
  level: number;
}

export interface DagGroup {
  /** Error of this group's parents (≥ every child's own error). */
  error: number;
  /** Sphere enclosing every child's sphere. */
  sphere: ClusterSphere;
  children: number[];
  parents: number[];
}

export interface ClusterDag {
  clusters: DagCluster[];
  groups: DagGroup[];
  levels: number;
  /** Original triangle count — also the worst-case cut size (all leaves). */
  triangleCount: number;
  /** Per-level cluster counts, leaves first — for stats/tests. */
  levelCounts: number[];
}

export interface ClusterDagOptions {
  /** Max triangles per cluster. Default 128 (meshoptimizer's sweet spot). */
  maxTriangles?: number;
  /** Max vertices per cluster. Default 128. */
  maxVertices?: number;
  /** Clusters merged per group before simplifying. Default 4; doubles when a
   * level stalls, up to 32. */
  groupSize?: number;
  /** Triangle fraction each group simplifies toward. Default 0.5. */
  targetRatio?: number;
  /** Optional per-vertex normals (3 floats) / uvs (2 floats), same count as
   * positions — the quadric pass keeps their seams. */
  normals?: Float32Array;
  uvs?: Float32Array;
}

const NORMAL_WEIGHT = 0.5;
const UV_WEIGHT = 1.0;
const MAX_GROUP_SIZE = 32;
/** A level that shrinks total triangles by less than this is "stalled". */
const MIN_LEVEL_REDUCTION = 0.08;

let wasmReady = false;
const readyPromise: Promise<void> =
  MeshoptClusterizer.supported && MeshoptSimplifier.supported
    ? Promise.all([MeshoptClusterizer.ready, MeshoptSimplifier.ready]).then(
        () => {
          wasmReady = true;
        },
        (error: unknown) => {
          console.warn("[render] meshoptimizer failed to initialise; cluster LOD disabled:", error);
        },
      )
    : Promise.resolve();

/** Resolves once `buildClusterDag` can run synchronously (never rejects). */
export function clusterDagReady(): Promise<void> {
  return readyPromise;
}

export function clusterDagSupported(): boolean {
  return wasmReady;
}

function edgeKey(a: number, b: number, vertexCount: number): number {
  return a < b ? a * vertexCount + b : b * vertexCount + a;
}

/** Sphere enclosing a set of spheres (meshoptimizer's minimal-ish bound). */
function enclosingSphere(spheres: ClusterSphere[]): ClusterSphere {
  if (spheres.length === 1) return { ...spheres[0]! };
  const centers = new Float32Array(spheres.length * 3);
  const radii = new Float32Array(spheres.length);
  for (let i = 0; i < spheres.length; i++) {
    centers[i * 3] = spheres[i]!.x;
    centers[i * 3 + 1] = spheres[i]!.y;
    centers[i * 3 + 2] = spheres[i]!.z;
    radii[i] = spheres[i]!.r;
  }
  const b = MeshoptClusterizer.computeSphereBounds(centers, 3, radii, 1); // strides in elements, not bytes
  // computeSphereBounds is not guaranteed to be exactly enclosing at float
  // precision — pad by the largest deviation so the monotonic-bounds
  // invariant the runtime relies on holds strictly
  let r = b.radius;
  for (const s of spheres) {
    const d = Math.hypot(s.x - b.centerX, s.y - b.centerY, s.z - b.centerZ) + s.r;
    if (d > r) r = d;
  }
  return { x: b.centerX, y: b.centerY, z: b.centerZ, r };
}

/** Split an index list into ≤ maxTriangles clusters; returns global index lists + spheres. */
function clusterize(
  indices: Uint32Array,
  positions: Float32Array,
  maxVertices: number,
  maxTriangles: number,
): Array<{ indices: Uint32Array; sphere: ClusterSphere }> {
  const buffers = MeshoptClusterizer.buildMeshlets(indices, positions, 3, maxVertices, maxTriangles, 0);
  const bounds = MeshoptClusterizer.computeMeshletBounds(buffers, positions, 3);
  const out: Array<{ indices: Uint32Array; sphere: ClusterSphere }> = [];
  for (let m = 0; m < buffers.meshletCount; m++) {
    const meshlet = MeshoptClusterizer.extractMeshlet(buffers, m);
    const tris = meshlet.triangles.length;
    const global = new Uint32Array(tris);
    for (let k = 0; k < tris; k++) global[k] = meshlet.vertices[meshlet.triangles[k]!]!;
    const b = bounds[m]!;
    out.push({ indices: global, sphere: { x: b.centerX, y: b.centerY, z: b.centerZ, r: b.radius } });
  }
  return out;
}

/**
 * Group the given clusters (ids into `clusters`) into sets of ~groupSize by
 * shared-edge adjacency, greedily: grow each group by the ungrouped cluster
 * sharing the most edges with any member; when nothing is adjacent, take the
 * nearest ungrouped cluster by sphere centre (keeps island geometry from
 * ending up as unsimplifiable singletons).
 */
function groupClusters(ids: number[], clusters: DagCluster[], vertexCount: number, groupSize: number): number[][] {
  // edge → clusters (in this level) containing it
  const edgeOwners = new Map<number, number[]>();
  for (const id of ids) {
    const idx = clusters[id]!.indices;
    for (let t = 0; t < idx.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const key = edgeKey(idx[t + e]!, idx[t + ((e + 1) % 3)]!, vertexCount);
        const owners = edgeOwners.get(key);
        if (owners) {
          if (owners[owners.length - 1] !== id) owners.push(id);
        } else edgeOwners.set(key, [id]);
      }
    }
  }
  // adjacency weights
  const adjacency = new Map<number, Map<number, number>>();
  const bump = (a: number, b: number) => {
    let row = adjacency.get(a);
    if (!row) adjacency.set(a, (row = new Map()));
    row.set(b, (row.get(b) ?? 0) + 1);
  };
  for (const owners of edgeOwners.values()) {
    if (owners.length < 2) continue;
    for (let i = 0; i < owners.length; i++) {
      for (let j = 0; j < owners.length; j++) if (i !== j) bump(owners[i]!, owners[j]!);
    }
  }

  const grouped = new Set<number>();
  const groups: number[][] = [];
  // seed from the least-connected clusters first so islands get partners
  // while partners are still free
  const order = [...ids].sort((a, b) => (adjacency.get(a)?.size ?? 0) - (adjacency.get(b)?.size ?? 0));
  for (const seed of order) {
    if (grouped.has(seed)) continue;
    const group = [seed];
    grouped.add(seed);
    while (group.length < groupSize) {
      let best = -1;
      let bestWeight = 0;
      for (const member of group) {
        const row = adjacency.get(member);
        if (!row) continue;
        for (const [other, weight] of row) {
          if (!grouped.has(other) && weight > bestWeight) {
            best = other;
            bestWeight = weight;
          }
        }
      }
      if (best < 0 && group.length < 2) {
        // island: nearest ungrouped cluster by centre
        const s = clusters[seed]!.sphere;
        let bestDist = Infinity;
        for (const other of ids) {
          if (grouped.has(other)) continue;
          const o = clusters[other]!.sphere;
          const d = (o.x - s.x) ** 2 + (o.y - s.y) ** 2 + (o.z - s.z) ** 2;
          if (d < bestDist) {
            bestDist = d;
            best = other;
          }
        }
      }
      if (best < 0) break;
      group.push(best);
      grouped.add(best);
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Build the cluster DAG for an indexed triangle mesh. `positions` is the full
 * vertex buffer (3 floats per vertex, tightly packed); `indices` its triangle
 * list. Synchronous — await `clusterDagReady()` first; returns null when the
 * WASM isn't available or the mesh is too small to bother with.
 */
export function buildClusterDag(
  indices: Uint32Array,
  positions: Float32Array,
  options: ClusterDagOptions = {},
): ClusterDag | null {
  if (!wasmReady) return null;
  const maxTriangles = options.maxTriangles ?? 128;
  const maxVertices = options.maxVertices ?? 128;
  const targetRatio = options.targetRatio ?? 0.5;
  let groupSize = options.groupSize ?? 4;
  const vertexCount = positions.length / 3;
  const triangleCount = Math.floor(indices.length / 3);
  if (triangleCount < 2 || vertexCount < 3) return null;
  if (indices.length !== triangleCount * 3) indices = indices.subarray(0, triangleCount * 3);

  const scale = MeshoptSimplifier.getScale(positions, 3);

  // optional attributes for the quadric pass, interleaved once
  const normals = options.normals && options.normals.length === vertexCount * 3 ? options.normals : null;
  const uvs = options.uvs && options.uvs.length === vertexCount * 2 ? options.uvs : null;
  const attrStride = (normals ? 3 : 0) + (uvs ? 2 : 0);
  let attrs: Float32Array | null = null;
  const weights: number[] = [];
  if (attrStride > 0) {
    attrs = new Float32Array(vertexCount * attrStride);
    let offset = 0;
    if (normals) {
      for (let i = 0; i < vertexCount; i++) attrs.set(normals.subarray(i * 3, i * 3 + 3), i * attrStride + offset);
      weights.push(NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT);
      offset += 3;
    }
    if (uvs) {
      for (let i = 0; i < vertexCount; i++) attrs.set(uvs.subarray(i * 2, i * 2 + 2), i * attrStride + offset);
      weights.push(UV_WEIGHT, UV_WEIGHT);
    }
  }
  const simplify = (merged: Uint32Array, target: number): [Uint32Array, number] =>
    attrs
      ? MeshoptSimplifier.simplifyWithAttributes(merged, positions, 3, attrs, attrStride, weights, null, target, 1, [
          "LockBorder",
        ])
      : MeshoptSimplifier.simplify(merged, positions, 3, target, 1, ["LockBorder"]);

  const clusters: DagCluster[] = [];
  const groups: DagGroup[] = [];
  const levelCounts: number[] = [];

  // level 0: leaves
  let current: number[] = [];
  for (const leaf of clusterize(indices, positions, maxVertices, maxTriangles)) {
    current.push(clusters.length);
    clusters.push({ indices: leaf.indices, error: 0, sphere: leaf.sphere, parentGroup: -1, level: 0 });
  }
  levelCounts.push(current.length);

  let level = 0;
  while (current.length > 1) {
    level++;
    const next: number[] = [];
    let trianglesBefore = 0;
    let trianglesAfter = 0;
    for (const members of groupClusters(current, clusters, vertexCount, groupSize)) {
      let total = 0;
      let childError = 0;
      const childSpheres: ClusterSphere[] = [];
      for (const id of members) {
        const c = clusters[id]!;
        total += c.indices.length;
        childError = Math.max(childError, c.error);
        childSpheres.push(c.sphere);
      }
      const merged = new Uint32Array(total);
      let cursor = 0;
      for (const id of members) {
        merged.set(clusters[id]!.indices, cursor);
        cursor += clusters[id]!.indices.length;
      }
      trianglesBefore += total / 3;
      const target = Math.max(3, Math.floor((total * targetRatio) / 3) * 3);
      const [simplified, relativeError] = simplify(merged, target);
      trianglesAfter += simplified.length / 3;
      const groupId = groups.length;
      const group: DagGroup = {
        error: Math.max(relativeError * scale, childError),
        sphere: enclosingSphere(childSpheres),
        children: members,
        parents: [],
      };
      groups.push(group);
      for (const id of members) clusters[id]!.parentGroup = groupId;
      // the group's parents: the simplified geometry re-clustered
      for (const parent of clusterize(simplified, positions, maxVertices, maxTriangles)) {
        const id = clusters.length;
        clusters.push({ indices: parent.indices, error: group.error, sphere: group.sphere, parentGroup: -1, level });
        group.parents.push(id);
        next.push(id);
      }
    }
    levelCounts.push(next.length);
    const reduction = trianglesBefore > 0 ? 1 - trianglesAfter / trianglesBefore : 0;
    current = next;
    if (reduction < MIN_LEVEL_REDUCTION) {
      if (groupSize >= MAX_GROUP_SIZE) break; // can't make progress: these are the roots
      groupSize = Math.min(groupSize * 2, MAX_GROUP_SIZE);
    }
  }

  return { clusters, groups, levels: level + 1, triangleCount, levelCounts };
}

// ---- runtime selection --------------------------------------------------------

export interface CutView {
  /** Camera position in the mesh's local space. */
  x: number;
  y: number;
  z: number;
  viewportHeight: number;
  tanHalfFov: number;
  /** Largest acceptable projected error, in pixels. */
  thresholdPx: number;
  /** Distances below this (camera inside/at a sphere) clamp here. */
  near?: number;
  /** Optional local-space frustum: 6 planes × (a, b, c, d), inside where
   * a·x + b·y + c·z + d ≥ 0 — clusters whose sphere is fully outside are
   * skipped (culled), which is the other half of what a cluster hierarchy
   * buys you. */
  planes?: ArrayLike<number>;
}

function projectedError(error: number, s: ClusterSphere, view: CutView): number {
  const dx = s.x - view.x;
  const dy = s.y - view.y;
  const dz = s.z - view.z;
  const distance = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz) - s.r, view.near ?? 0.05);
  return (error * view.viewportHeight) / (2 * view.tanHalfFov * distance);
}

function sphereOutside(s: ClusterSphere, planes: ArrayLike<number>): boolean {
  for (let p = 0; p < 6; p++) {
    const k = p * 4;
    if (planes[k]! * s.x + planes[k + 1]! * s.y + planes[k + 2]! * s.z + planes[k + 3]! < -s.r) return true;
  }
  return false;
}

/**
 * Pick the cut: a cluster is drawn when its own error projects within the
 * threshold AND its parent group's does not (so the coarser replacement
 * isn't good enough yet). Because a group's children all test the same
 * (error, sphere) pair that the group's parents test as their "own", exactly
 * one side of every group is ever drawn — from any camera position, with no
 * seams. Writes cluster ids into `out` and returns how many.
 */
export function selectClusterCut(
  dag: ClusterDag,
  view: CutView,
  out: Int32Array,
  stats?: { culled: number },
): number {
  const τ = view.thresholdPx;
  const planes = view.planes;
  let n = 0;
  let culled = 0;
  for (let i = 0; i < dag.clusters.length; i++) {
    const c = dag.clusters[i]!;
    if (c.error > 0 && projectedError(c.error, c.sphere, view) > τ) continue; // too coarse here
    if (c.parentGroup >= 0) {
      const g = dag.groups[c.parentGroup]!;
      if (projectedError(g.error, g.sphere, view) <= τ) continue; // the parents cover this
    }
    if (planes && sphereOutside(c.sphere, planes)) {
      culled++; // part of the cut, but off-screen
      continue;
    }
    out[n++] = i;
  }
  if (stats) stats.culled = culled;
  return n;
}

/** Total triangles in a cut (for stats). */
export function cutTriangleCount(dag: ClusterDag, cut: Int32Array, count: number): number {
  let tris = 0;
  for (let i = 0; i < count; i++) tris += dag.clusters[cut[i]!]!.indices.length / 3;
  return tris;
}
