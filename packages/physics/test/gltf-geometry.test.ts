import { beforeAll, describe, expect, it } from "vitest";
import { applyOps, ComponentRegistry, createScene, registerCoreComponents } from "@hitreg/core";
import { gltfCollisionGeometry, initPhysics, PhysicsSim } from "../src/index.js";

/** Minimal GLB writer: one BIN chunk, the JSON given, accessors appended by `add`. */
function glb(build: (add: (data: ArrayBufferView, acc: Record<string, unknown>) => number) => Record<string, unknown>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const bufferViews: unknown[] = [];
  const accessors: unknown[] = [];
  let length = 0;
  const add = (data: ArrayBufferView, acc: Record<string, unknown>): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    accessors.push({ bufferView: bufferViews.length - 1, ...acc });
    chunks.push(padded);
    length += padded.length;
    return accessors.length - 1;
  };
  const json = { asset: { version: "2.0" }, ...build(add), buffers: [{ byteLength: length }], bufferViews, accessors };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = Math.ceil(text.length / 4) * 4;
  const jsonChunk = new Uint8Array(pad).fill(0x20);
  jsonChunk.set(text);
  text = jsonChunk;
  const out = new Uint8Array(12 + 8 + text.length + 8 + length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  let at = 20 + text.length;
  dv.setUint32(at, length, true);
  dv.setUint32(at + 4, 0x004e4942, true);
  at += 8;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A 2x2 quad at y=0 in the node's local space, u16 indices. */
function quad(add: (data: ArrayBufferView, acc: Record<string, unknown>) => number) {
  const position = add(new Float32Array([-1, 0, -1, 1, 0, -1, -1, 0, 1, 1, 0, 1]), {
    componentType: 5126, count: 4, type: "VEC3", min: [-1, 0, -1], max: [1, 0, 1],
  });
  const indices = add(new Uint16Array([0, 2, 1, 1, 2, 3]), { componentType: 5123, count: 6, type: "SCALAR" });
  return { attributes: { POSITION: position }, indices };
}

describe("gltfCollisionGeometry (headless collision cooking)", () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it("bakes node transforms (TRS and matrix, nested) into the vertices", () => {
    const bytes = glb((add) => ({
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: "Root", translation: [100, 20, -50], scale: [2, 2, 2], children: [1] },
        // 90° about Y, then up 3 (column-major matrix)
        { name: "Top", mesh: 0, matrix: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 3, 0, 1] },
      ],
      meshes: [{ primitives: [quad(add)] }],
    }));
    const geom = gltfCollisionGeometry(bytes)!;
    expect(geom.indices.length).toBe(6);
    const ys = new Set<number>();
    for (let i = 1; i < geom.positions.length; i += 3) ys.add(geom.positions[i]!);
    expect([...ys]).toEqual([26]); // (0 + 3) * 2 + 20
    const xs: number[] = [];
    for (let i = 0; i < geom.positions.length; i += 3) xs.push(geom.positions[i]!);
    expect(Math.min(...xs)).toBeCloseTo(98);
    expect(Math.max(...xs)).toBeCloseTo(102);
  });

  it("a named node extracts its subtree relative to itself", () => {
    const bytes = glb((add) => ({
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: "Root", translation: [100, 0, 0], children: [1] },
        { name: "Rock A", translation: [0, 5, 0], mesh: 0, children: [2] },
        { name: "Cap", translation: [0, 1, 0], mesh: 0 },
      ],
      meshes: [{ primitives: [quad(add)] }],
    }));
    // Three sanitizes "Rock A" to "Rock_A"; either spelling finds it
    for (const name of ["Rock A", "Rock_A"]) {
      const geom = gltfCollisionGeometry(bytes, { node: name })!;
      expect(geom.indices.length).toBe(12);
      const ys = [...new Set(Array.from(geom.positions).filter((_, i) => i % 3 === 1))].sort();
      expect(ys).toEqual([0, 1]); // own transform excluded, child's kept
    }
    expect(gltfCollisionGeometry(bytes, { node: "missing" })).toBeNull();
  });

  it("dequantizes normalized positions and rejects compressed files", () => {
    const bytes = glb((add) => ({
      extensionsUsed: ["KHR_mesh_quantization"],
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{
        primitives: [{
          attributes: {
            POSITION: add(new Int16Array([-32767, 0, -32767, 32767, 0, -32767, -32767, 32767, 32767, 0]), {
              componentType: 5122, normalized: true, count: 3, type: "VEC3",
            }),
          },
        }],
      }],
    }));
    const geom = gltfCollisionGeometry(bytes)!;
    expect(Array.from(geom.indices)).toEqual([0, 1, 2]);
    expect(geom.positions[7]).toBeCloseTo(1);
    const draco = glb(() => ({ extensionsRequired: ["KHR_draco_mesh_compression"], scenes: [{ nodes: [] }], nodes: [] }));
    expect(() => gltfCollisionGeometry(draco)).toThrow(/compressed/);
  });

  it("a trimesh cooked from it is hit exactly where the mesh is (world-space vertices)", () => {
    const bytes = glb((add) => ({
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: [5360, 40, -3900], scale: [10, 1, 10] }],
      meshes: [{ primitives: [quad(add)] }],
    }));
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    const doc = applyOps(createScene("t"), [{
      op: "add-entity",
      id: "rock",
      entity: {
        name: "rock",
        parent: null,
        tags: [],
        components: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          mesh: { source: { kind: "asset", assetId: "rock.glb" } },
          collider: { shape: "trimesh" },
        },
      },
    }], registry).doc;
    const sim = new PhysicsSim(doc, undefined, { meshGeometry: () => gltfCollisionGeometry(bytes) });
    const hit = sim.raycast([5365, 100, -3895], [0, -1, 0], 200);
    expect(hit?.entityId).toBe("rock");
    expect(hit!.point[1]).toBeCloseTo(40, 4);
    // nothing at the entity origin, where the old box fallback sat
    expect(sim.raycast([0, 10, 0], [0, -1, 0], 20)).toBeNull();
    sim.free();
  });
});
