import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import type { SceneDoc, VoxelMesh } from "@hitreg/core";
import type { BuildOptions } from "../src/scene-builder.js";

/**
 * Merge-prep invariants for `buildHlodProxy` — the half of a supercell bake
 * that used to dominate its main-thread cost.
 *
 * The load-bearing claim is that an all-indexed bucket merges INDEXED. Merging
 * requires its inputs to be *consistently* indexed, not *non*-indexed, and
 * de-indexing an imported mesh first multiplies its vertex count by 3-6x —
 * every one of which then gets copied, matrix-transformed, normal-transformed
 * and concatenated. These tests pin the two things that has to preserve: the
 * exact same triangles in the exact same world positions, and no mutation of
 * the shared glTF geometry cache.
 */

/** Stands in for a loaded glTF prop: indexed, with a spare attribute and the
 * bounding volumes GLTFLoader computes for every primitive. */
const propGeometry = new THREE.BoxGeometry(2, 2, 2);
propGeometry.setAttribute(
  "color",
  new THREE.BufferAttribute(new Float32Array(propGeometry.getAttribute("position").count * 3), 3),
);
propGeometry.computeBoundingBox();
propGeometry.computeBoundingSphere();

/** A prop with an index but NO normals — glTF's "flat shading" primitive. */
const normallessGeometry = new THREE.BoxGeometry(2, 2, 2);
normallessGeometry.deleteAttribute("normal");

function sceneOf(geometry: THREE.BufferGeometry): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x00ff00 })));
  return group;
}

const propScene = sceneOf(propGeometry);
const normallessScene = sceneOf(normallessGeometry);

vi.mock("../src/scene-builder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scene-builder.js")>();
  return {
    ...actual,
    loadGltf: vi.fn(async (url: string) => ({
      scene: url.includes("normalless") ? normallessScene : propScene,
    })) as unknown as typeof actual.loadGltf,
  };
});

const { buildHlodProxy } = await import("../src/hlod-proxy.js");

const IDENTITY = {
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function entity(
  name: string,
  position: [number, number, number],
  mesh: Record<string, unknown>,
): SceneDoc["entities"][string] {
  return {
    name,
    parent: null,
    tags: ["hlod"],
    components: { transform: { position, ...IDENTITY }, mesh },
  };
}

const prop = (position: [number, number, number], assetId = "prop"): SceneDoc["entities"][string] =>
  entity("Prop", position, { source: { kind: "asset", assetId } });

const box = (position: [number, number, number]): SceneDoc["entities"][string] =>
  entity("Box", position, { source: { kind: "primitive", shape: "box", size: [2, 2, 2] }, material: "red" });

const wedge = (position: [number, number, number]): SceneDoc["entities"][string] =>
  entity("Wedge", position, { source: { kind: "primitive", shape: "wedge", size: [2, 2, 2] }, material: "red" });

const voxelCell = (position: [number, number, number]): SceneDoc["entities"][string] =>
  entity("Terrain", position, { source: { kind: "voxel", world: "w", cell: [0, 0] } });

/** A two-triangle quad standing in for a meshed voxel cell. */
function fakeVoxelMesh(offsetX: number): VoxelMesh {
  const at = (x: number): number => x + offsetX;
  return {
    positions: new Float32Array([at(0), 0, 0, at(1), 0, 0, at(0), 1, 0, at(1), 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
    splat: new Float32Array(4 * 4),
    surfaceCount: 4,
    tint: new Float32Array(4 * 3),
    min: [at(0), 0, 0],
    max: [at(1), 1, 0],
    vertexCount: 4,
    triangleCount: 2,
  };
}

function doc(entities: SceneDoc["entities"]): SceneDoc {
  return { version: 1, name: "hlod-merge-prep", entities };
}

const options: BuildOptions = {
  resolveMaterial: () => ({
    shader: "standard",
    color: "#ff0000",
    repeat: [1, 1],
    roughness: 0.8,
    metalness: 0,
    emissive: "#000000",
    emissiveIntensity: 1,
    opacity: 1,
    transparent: false,
  }),
  resolveModel: (id) => `fake://${id}.glb`,
};

function mergedMesh(group: THREE.Object3D): THREE.Mesh {
  const mesh = group.children.find((c) => (c as THREE.Mesh).isMesh);
  expect(mesh).toBeDefined();
  return mesh as THREE.Mesh;
}

/** The triangle stream a merged geometry actually rasterises. */
function triangleVertices(geometry: THREE.BufferGeometry): Float32Array {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  return flat.getAttribute("position").array as Float32Array;
}

describe("HLOD merge prep", () => {
  it("merges an all-indexed prop bucket without de-indexing it", async () => {
    const proxy = await buildHlodProxy(doc({ a: prop([0, 0, 0]), b: prop([10, 0, 0]) }), options);
    expect(proxy.stats).toEqual({ mergedDrawCalls: 1, mergedSources: 2, deferred: 0 });
    const geometry = mergedMesh(proxy.group).geometry;
    expect(geometry.index).not.toBeNull();
    // 2 x 24 welded box vertices, NOT 2 x 36 de-indexed ones
    expect(geometry.getAttribute("position").count).toBe(48);
    expect(geometry.index!.count).toBe(72);
    // merging strips everything past position/normal/uv, or terrain (which
    // carries splat weights) could never share a merge path with props
    expect(Object.keys(geometry.attributes).sort()).toEqual(["normal", "position", "uv"]);
  });

  it("puts merged vertices in exactly the world positions the de-indexed merge did", async () => {
    const proxy = await buildHlodProxy(doc({ a: prop([0, 0, 0]), b: prop([10, 0, 0]) }), options);
    const actual = triangleVertices(mergedMesh(proxy.group).geometry);

    // reference: the same box, de-indexed and translated, concatenated in
    // placement order — i.e. what this file produced before it stayed indexed
    const flat = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
    const near = flat.getAttribute("position").array as Float32Array;
    const far = Float32Array.from(near, (v, i) => (i % 3 === 0 ? v + 10 : v));
    const expected = Float32Array.from([...near, ...far]);

    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 5);
  });

  it("leaves the shared glTF geometry unmutated and unaliased", async () => {
    const before = {
      index: propGeometry.index,
      position: propGeometry.getAttribute("position"),
      count: propGeometry.getAttribute("position").count,
      boundingSphere: propGeometry.boundingSphere,
    };
    const proxy = await buildHlodProxy(doc({ a: prop([0, 0, 0]), b: prop([10, 0, 0]) }), options);

    // the cache entry every other chunk and every un-merged instance holds
    expect(propGeometry.index).toBe(before.index);
    expect(propGeometry.getAttribute("position")).toBe(before.position);
    expect(propGeometry.getAttribute("position").count).toBe(before.count);
    expect(propGeometry.getAttribute("color")).toBeDefined();
    expect(propGeometry.boundingSphere).toBe(before.boundingSphere);
    // still model-local — the placement was baked into the COPY
    propGeometry.computeBoundingBox();
    expect(propGeometry.boundingBox!.max.x).toBeCloseTo(1, 5);

    // ChunkManager.disposeGroup() disposes proxy geometry, so the merged
    // result must not share a single buffer with the cached source
    const geometry = mergedMesh(proxy.group).geometry;
    expect(geometry.index).not.toBe(before.index);
    expect(geometry.getAttribute("position")).not.toBe(before.position);
    expect((geometry.getAttribute("position").array as Float32Array).buffer).not.toBe(
      (before.position.array as Float32Array).buffer,
    );
  });

  it("leaves the merged geometry's bounding volumes for the renderer to compute once", async () => {
    const proxy = await buildHlodProxy(doc({ a: prop([0, 0, 0]), b: prop([10, 0, 0]) }), options);
    const geometry = mergedMesh(proxy.group).geometry;
    // applyMatrix4 recomputes whichever volume is already set — over every
    // vertex, twice, per source geometry — for a value only the final merged
    // buffer's is ever read
    expect(geometry.boundingBox).toBeNull();
    expect(geometry.boundingSphere).toBeNull();
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.x).toBeCloseTo(-1, 5);
    expect(geometry.boundingBox!.max.x).toBeCloseTo(11, 5);
  });

  it("flattens a bucket that mixes indexed and non-indexed sources", async () => {
    // box primitives are indexed; the wedge is built non-indexed and uv-less
    const proxy = await buildHlodProxy(doc({ b: box([0, 0, 0]), w: wedge([4, 0, 0]) }), options);
    expect(proxy.stats.mergedDrawCalls).toBe(1);
    expect(proxy.stats.mergedSources).toBe(2);
    const geometry = mergedMesh(proxy.group).geometry;
    expect(geometry.index).toBeNull();
    // 36 de-indexed box vertices + the wedge's 24
    expect(geometry.getAttribute("position").count).toBe(60);
    expect(Object.keys(geometry.attributes).sort()).toEqual(["normal", "position", "uv"]);
  });

  it("still de-indexes a source with no normals, so they stay flat", async () => {
    // glTF gives a primitive with no NORMAL flat, per-face shading. Computing
    // normals on the INDEXED geometry would smooth them across shared
    // vertices instead — visibly different, so this case keeps de-indexing.
    const proxy = await buildHlodProxy(
      doc({ a: prop([0, 0, 0], "normalless"), b: prop([10, 0, 0], "normalless") }),
      options,
    );
    const geometry = mergedMesh(proxy.group).geometry;
    expect(geometry.index).toBeNull();
    expect(geometry.getAttribute("position").count).toBe(72);
    const normals = geometry.getAttribute("normal");
    // every box face normal is an axis-aligned unit vector, and all three
    // corners of a triangle share it
    for (let t = 0; t < normals.count; t += 3) {
      const n = new THREE.Vector3().fromBufferAttribute(normals, t);
      expect(n.length()).toBeCloseTo(1, 5);
      expect(Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z)).toBeCloseTo(1, 5);
      for (let c = 1; c < 3; c++) {
        const m = new THREE.Vector3().fromBufferAttribute(normals, t + c);
        expect(m.distanceTo(n)).toBeCloseTo(0, 5);
      }
    }
    expect(normallessGeometry.index).not.toBeNull();
    expect(normallessGeometry.getAttribute("normal")).toBeUndefined();
  });

  it("keeps the terrain proxy indexed, splatted and pre-bounded on the async supercell path", async () => {
    const proxy = await buildHlodProxy(doc({ t: voxelCell([0, 0, 0]) }), {
      ...options,
      voxelSupercellAsync: async () => [{ key: "__default", mesh: fakeVoxelMesh(0) }],
    });
    const geometry = mergedMesh(proxy.group).geometry;
    // the worker already merged and baked every cell transform, so this bucket
    // holds ONE geometry and never merges again — de-indexing it here bought
    // nothing and tripled the biggest vertex buffer in the scene
    expect(geometry.index).not.toBeNull();
    expect(geometry.getAttribute("position").count).toBe(4);
    // splat weights + biome tint survive, or distant terrain flattens to one
    // colour and the LOD swap pops
    expect(geometry.getAttribute("splatWeight")).toBeDefined();
    expect(geometry.getAttribute("color")).toBeDefined();
    expect(geometry.getAttribute("uv")).toBeDefined();
    // nothing transformed it, so the mesher's own bounds are still exact —
    // which spares the renderer a computeBoundingSphere over the whole buffer
    expect(geometry.boundingSphere).not.toBeNull();
    expect(geometry.boundingBox!.max.x).toBeCloseTo(1, 5);
  });

  it("merges the per-cell terrain fallback indexed, with the cell transforms baked in", async () => {
    const proxy = await buildHlodProxy(doc({ a: voxelCell([0, 0, 0]), b: voxelCell([10, 0, 0]) }), {
      ...options,
      voxelSupercellAsync: () => null,
      voxelMeshAsync: async () => fakeVoxelMesh(0),
    });
    const geometry = mergedMesh(proxy.group).geometry;
    expect(geometry.index).not.toBeNull();
    expect(geometry.getAttribute("position").count).toBe(8);
    expect(geometry.index!.count).toBe(12);
    expect(geometry.getAttribute("splatWeight").count).toBe(8);
    // the mesher's bounds are stale once a cell transform is baked in, so they
    // are dropped rather than recomputed per cell by applyMatrix4
    expect(geometry.boundingBox).toBeNull();
    geometry.computeBoundingBox();
    expect(geometry.boundingBox!.min.x).toBeCloseTo(0, 5);
    expect(geometry.boundingBox!.max.x).toBeCloseTo(11, 5);
  });

  it("gives a uv-less source zero uvs rather than failing the merge", async () => {
    const proxy = await buildHlodProxy(doc({ w: wedge([0, 0, 0]), x: wedge([4, 0, 0]) }), options);
    expect(proxy.stats.mergedDrawCalls).toBe(1);
    const uv = mergedMesh(proxy.group).geometry.getAttribute("uv");
    expect(uv.count).toBe(48);
    expect(Array.from(uv.array as Float32Array).every((v) => v === 0)).toBe(true);
  });
});
