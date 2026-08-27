import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { MeshoptSimplifier } from "meshoptimizer";
import {
  buildClusterDag,
  clusterDagReady,
  cutTriangleCount,
  selectClusterCut,
  type ClusterDag,
  type CutView,
} from "../src/cluster-dag.js";

beforeAll(() => clusterDagReady());

function arraysOf(geometry: THREE.BufferGeometry): { indices: Uint32Array; positions: Float32Array } {
  return {
    indices: Uint32Array.from(geometry.index!.array as ArrayLike<number>),
    positions: Float32Array.from(geometry.getAttribute("position").array as ArrayLike<number>),
  };
}

let dag: ClusterDag;
let source: { indices: Uint32Array; positions: Float32Array };
let buildMs = 0;

beforeAll(() => {
  // a closed manifold with a uv seam (duplicate vertices along it) — ~16k tris
  source = arraysOf(new THREE.TorusKnotGeometry(1, 0.35, 256, 32));
  const t0 = performance.now();
  dag = buildClusterDag(source.indices, source.positions)!;
  buildMs = performance.now() - t0;
  console.log(
    `cluster DAG: ${source.indices.length / 3} tris → ${dag.clusters.length} clusters, levels ${dag.levelCounts.join("→")}, ${buildMs.toFixed(0)} ms`,
  );
});

function triangleKey(a: number, b: number, c: number): string {
  return [a, b, c].sort((x, y) => x - y).join(",");
}

/** Undirected edges of a triangle list with their occurrence counts, over
 * POSITION-welded vertex ids (a uv seam is not a border to the simplifier). */
function edgeCounts(indices: Uint32Array, remap: Uint32Array): Map<string, number> {
  const counts = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = remap[indices[t + e]!]!;
      const b = remap[indices[t + ((e + 1) % 3)]!]!;
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function borderEdges(indices: Uint32Array, remap: Uint32Array): Set<string> {
  const out = new Set<string>();
  for (const [key, n] of edgeCounts(indices, remap)) if (n === 1) out.add(key);
  return out;
}

function concat(dagRef: ClusterDag, ids: number[]): Uint32Array {
  let n = 0;
  for (const id of ids) n += dagRef.clusters[id]!.indices.length;
  const out = new Uint32Array(n);
  let c = 0;
  for (const id of ids) {
    out.set(dagRef.clusters[id]!.indices, c);
    c += dagRef.clusters[id]!.indices.length;
  }
  return out;
}

describe("buildClusterDag", () => {
  it("builds in a time that fits a one-off preprocess, not a per-frame budget", () => {
    expect(buildMs).toBeLessThan(5000);
  });

  it("leaves cover every source triangle exactly once, ≤ 128 triangles each", () => {
    const seen = new Map<string, number>();
    for (const c of dag.clusters) {
      if (c.level !== 0) continue;
      expect(c.indices.length / 3).toBeLessThanOrEqual(128);
      expect(c.error).toBe(0);
      for (let t = 0; t < c.indices.length; t += 3) {
        const key = triangleKey(c.indices[t]!, c.indices[t + 1]!, c.indices[t + 2]!);
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    expect(seen.size).toBe(source.indices.length / 3);
    for (const n of seen.values()) expect(n).toBe(1);
  });

  it("coarsens level by level down to a handful of root clusters", () => {
    expect(dag.levels).toBeGreaterThanOrEqual(4);
    for (let l = 1; l < dag.levelCounts.length; l++) expect(dag.levelCounts[l]!).toBeLessThan(dag.levelCounts[l - 1]!);
    const roots = dag.clusters.filter((c) => c.parentGroup < 0);
    expect(roots.length).toBeLessThanOrEqual(4);
    let rootTris = 0;
    for (const r of roots) rootTris += r.indices.length / 3;
    expect(rootTris).toBeLessThan(dag.triangleCount / 20);
  });

  it("keeps error and bounds monotonic up the DAG", () => {
    for (const g of dag.groups) {
      for (const id of g.children) {
        const c = dag.clusters[id]!;
        expect(g.error).toBeGreaterThanOrEqual(c.error);
        const d = Math.hypot(c.sphere.x - g.sphere.x, c.sphere.y - g.sphere.y, c.sphere.z - g.sphere.z) + c.sphere.r;
        expect(d).toBeLessThanOrEqual(g.sphere.r + 1e-4);
      }
      for (const id of g.parents) {
        const p = dag.clusters[id]!;
        expect(p.error).toBe(g.error);
        expect(p.sphere).toEqual(g.sphere);
      }
      expect(g.error).toBeGreaterThan(0);
    }
  });

  it("is crack-free: every group's parents keep the exact border edges of its children", () => {
    const remap = MeshoptSimplifier.generatePositionRemap(source.positions, 3);
    let checked = 0;
    for (const g of dag.groups) {
      const before = borderEdges(concat(dag, g.children), remap);
      const after = borderEdges(concat(dag, g.parents), remap);
      expect(after.size).toBe(before.size);
      for (const e of before) expect(after.has(e)).toBe(true);
      checked++;
    }
    expect(checked).toBe(dag.groups.length);
  });

  it("returns null for meshes too small to cluster, and never throws", () => {
    expect(buildClusterDag(new Uint32Array([0, 1, 2]), new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))).toBeNull();
    expect(buildClusterDag(new Uint32Array(0), new Float32Array(0))).toBeNull();
  });
});

describe("selectClusterCut", () => {
  const view = (distance: number, thresholdPx = 1, planes?: number[]): CutView => ({
    x: distance,
    y: 0,
    z: 0,
    viewportHeight: 1080,
    tanHalfFov: Math.tan((50 * Math.PI) / 360),
    thresholdPx,
    ...(planes ? { planes } : {}),
  });

  /** Every leaf is represented exactly once: either drawn itself, or its
   * group's parents are all (recursively) represented — and never both sides
   * of one group. */
  function assertValidCut(cut: Int32Array, count: number): void {
    const inCut = new Set<number>();
    for (let i = 0; i < count; i++) inCut.add(cut[i]!);
    for (const g of dag.groups) {
      const childDrawn = g.children.some((id) => inCut.has(id));
      const parentDrawn = g.parents.some((id) => inCut.has(id));
      expect(childDrawn && parentDrawn).toBe(false);
    }
    const memo = new Map<number, boolean>();
    const represented = (id: number): boolean => {
      if (inCut.has(id)) return true;
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      const c = dag.clusters[id]!;
      const ok = c.parentGroup >= 0 && dag.groups[c.parentGroup]!.parents.every(represented);
      memo.set(id, ok);
      return ok;
    };
    for (const c of dag.clusters) if (c.level === 0) expect(represented(dag.clusters.indexOf(c))).toBe(true);
  }

  it("draws every leaf up close and only roots from far away, with valid cuts in between", () => {
    const cut = new Int32Array(dag.clusters.length);
    const near = selectClusterCut(dag, view(1.2), cut);
    expect(cutTriangleCount(dag, cut, near)).toBe(dag.triangleCount);
    assertValidCut(cut, near);

    const far = selectClusterCut(dag, view(5000), cut);
    const roots = dag.clusters.filter((c) => c.parentGroup < 0).length;
    expect(far).toBe(roots);
    assertValidCut(cut, far);

    let previous = Infinity;
    for (const d of [3, 8, 20, 60, 200, 800]) {
      const n = selectClusterCut(dag, view(d), cut);
      const tris = cutTriangleCount(dag, cut, n);
      expect(tris).toBeLessThanOrEqual(previous);
      expect(tris).toBeLessThan(dag.triangleCount);
      expect(n).toBeGreaterThan(0);
      assertValidCut(cut, n);
      previous = tris;
    }
  });

  it("a tighter pixel threshold keeps more detail", () => {
    const cut = new Int32Array(dag.clusters.length);
    const loose = cutTriangleCount(dag, cut, selectClusterCut(dag, view(20, 4), cut));
    const tight = cutTriangleCount(dag, cut, selectClusterCut(dag, view(20, 0.5), cut));
    expect(tight).toBeGreaterThan(loose);
  });

  it("frustum planes cull clusters entirely outside", () => {
    const cut = new Int32Array(dag.clusters.length);
    // a "frustum" that is the half-space x ≥ 10: nothing of a radius-~1.4 knot at the origin qualifies
    const nothing = selectClusterCut(dag, view(20, 1, [1, 0, 0, -10, 1, 0, 0, -10, 1, 0, 0, -10, 1, 0, 0, -10, 1, 0, 0, -10, 1, 0, 0, -10]), cut);
    expect(nothing).toBe(0);
    // the half-space x ≥ 0 keeps roughly half of the LEAF clusters (small
    // spheres; coarse clusters straddle the plane and rightly survive)
    const halfSpace = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    const half = selectClusterCut(dag, view(1.2, 1, halfSpace), cut);
    for (let i = 0; i < half; i++) {
      const s = dag.clusters[cut[i]!]!.sphere;
      expect(s.x + s.r).toBeGreaterThanOrEqual(0);
    }
    const all = selectClusterCut(dag, view(1.2, 1), cut);
    expect(half).toBeGreaterThan(all * 0.3);
    expect(half).toBeLessThan(all * 0.8);
  });
});
