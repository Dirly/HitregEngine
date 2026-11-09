import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { color } from "three/tsl";
import { skySchema } from "@hitreg/core";
import { addModelFill } from "../src/model-fill.js";
import { applyModelEmissive } from "../src/ubermesh.js";
import { cloneMaterial } from "../src/node-material.js";
import { applyInstanceGlow } from "../src/instancing.js";
import { buildScene } from "../src/scene-builder.js";

describe("shared model readability fill", () => {
  it("keeps the painted graph and authored emission, and installs only once", () => {
    const m = new THREE.MeshStandardNodeMaterial();
    const paint = color("#361c12"), emission = color("#102030");
    m.colorNode = paint;
    m.emissiveNode = emission;
    addModelFill(m);
    const filled = m.emissiveNode, version = m.version;
    expect(filled).not.toBe(emission);
    expect(m.colorNode).toBe(paint);
    addModelFill(m);
    expect(m.emissiveNode).toBe(filled);
    expect(m.version).toBe(version);
    expect(cloneMaterial(m).userData.hitregModelFill).toBe(true);
    expect((cloneMaterial(m) as THREE.NodeMaterial).emissiveNode).toBe(filled);
  });

  it("ignores unlit effects", () => {
    const m = new THREE.MeshBasicNodeMaterial();
    const version = m.version;
    const emission = m.emissiveNode;
    addModelFill(m);
    expect(m.emissiveNode).toBe(emission);
    expect(m.version).toBe(version);
  });

  it("covers a named skinned monster without changing its source or recompiling each glow", () => {
    const source = new THREE.MeshStandardNodeMaterial();
    const paint = color("#46281b");
    source.colorNode = paint;
    const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), source);
    applyModelEmissive(mesh, null);
    const own = mesh.material as THREE.MeshStandardNodeMaterial;
    expect(own).not.toBe(source);
    expect(source.emissiveNode).toBeNull();
    expect(own.userData.hitregModelFill).toBe(true);
    expect(own.colorNode).toBe(paint);
    const node = own.emissiveNode, version = own.version;
    applyModelEmissive(mesh, { color: "#ff0000", intensity: 1 });
    applyModelEmissive(mesh, null);
    expect(mesh.material).toBe(own);
    expect(own.emissiveNode).toBe(node);
    expect(own.version).toBe(version);
  });

  it("keeps the shared scene control opt-in and bounded", () => {
    expect(skySchema.parse({}).modelFill).toBeUndefined();
    expect(skySchema.parse({ modelFill: .035 }).modelFill).toBe(.035);
    expect(skySchema.safeParse({ modelFill: -.01 }).success).toBe(false);
    expect(skySchema.safeParse({ modelFill: .26 }).success).toBe(false);
  });

  it("covers rigid moving entities through their existing glow material", () => {
    const m = new THREE.MeshStandardNodeMaterial();
    applyInstanceGlow(m);
    expect(m.userData.hitregModelFill).toBe(true);
    const graph = m.emissiveNode, version = m.version;
    applyInstanceGlow(m);
    expect(m.emissiveNode).toBe(graph);
    expect(m.version).toBe(version);
  });

  it("reclaims the drawn scene's fill after a portrait or another world draws", () => {
    const m = new THREE.MeshStandardNodeMaterial();
    addModelFill(m);
    const value = () => {
      const json = m.emissiveNode!.toJSON() as unknown as { nodes: Array<{ type: string; value: unknown }> };
      return json.nodes.find(n => n.type === "UniformNode")!.value;
    };
    const make = (modelFill: number) => buildScene({ version: 1, name: "fill", entities: {
      sky: { name: "sky", parent: null, tags: [], components: {
        sky: skySchema.parse({ modelFill, environment: { mode: "none" } }),
      } },
    } });
    const world = make(.035), portrait = make(0), camera = new THREE.PerspectiveCamera();
    world.lighting.frame(camera);
    expect(value()).toBe(.035);
    portrait.lighting.frame(camera);
    expect(value()).toBe(0);
    world.lighting.frame(camera);
    expect(value()).toBe(.035);
    world.lighting.dispose();
    portrait.lighting.dispose();
  });
});
