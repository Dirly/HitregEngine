import { describe, expect, it } from "vitest";
import {
  chunkDocSchema,
  chunkFileName,
  chunkToSceneDoc,
  parseChunkCoords,
  registerChunkComponents,
  subsceneToSceneDoc,
  ComponentRegistry,
  validateScene,
  registerCoreComponents,
} from "../src/index.js";

describe("chunk files", () => {
  it("parses grid coords from filenames (negatives included)", () => {
    expect(parseChunkCoords("demo/3_-2.chunk.json")).toEqual([3, -2]);
    expect(parseChunkCoords("-1_0.chunk.json")).toEqual([-1, 0]);
    expect(parseChunkCoords("demo/nope.json")).toBeNull();
    expect(parseChunkCoords(chunkFileName(4, 7))).toEqual([4, 7]);
  });

  it("validates chunk docs with the scene entity schema", () => {
    const ok = chunkDocSchema.safeParse({
      version: 1,
      entities: { a: { name: "A", components: {} } },
    });
    expect(ok.success).toBe(true);
    expect(chunkDocSchema.safeParse({ version: 1, entities: { a: { name: "" } } }).success).toBe(
      false,
    );
  });

  it("re-roots chunk entities onto a positioned origin with prefixed ids", () => {
    const chunk = chunkDocSchema.parse({
      version: 1,
      entities: {
        ground: { name: "Ground", components: {} },
        child: { name: "Child", parent: "ground", components: {} },
      },
    });
    const { doc, rootId } = chunkToSceneDoc("demo", 2, -1, 16, chunk);
    expect(rootId).toBe("__chunk:demo:2_-1");
    const root = doc.entities[rootId]!;
    expect((root.components["transform"] as { position: number[] }).position).toEqual([
      32, 0, -16,
    ]);
    expect(doc.entities[`${rootId}/ground`]!.parent).toBe(rootId);
    expect(doc.entities[`${rootId}/child`]!.parent).toBe(`${rootId}/ground`);
    // the result is a structurally valid scene
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    registerChunkComponents(registry);
    expect(validateScene(doc, registry)).toEqual([]);
  });

  it("re-roots a subscene at the instance world transform, namespaced, standalone components stripped", () => {
    const scene = {
      version: 1 as const,
      name: "village-a",
      entities: {
        sky: { name: "Sky", parent: null, tags: [], components: { sky: { top: "#fff", bottom: "#eee" } } },
        house: {
          name: "House",
          parent: null,
          tags: ["static"],
          components: { transform: {}, subscene: { scene: "nested" } },
        },
        door: { name: "Door", parent: "house", tags: [], components: { transform: {} } },
      },
    };
    const { doc, rootId, stripped } = subsceneToSceneDoc(
      "world-marker",
      { position: [10, 0, -5], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      scene,
    );
    expect(rootId).toBe("__sub:world-marker");
    expect(
      (doc.entities[rootId]!.components["transform"] as { position: number[] }).position,
    ).toEqual([10, 0, -5]);
    expect(doc.entities[`${rootId}/door`]!.parent).toBe(`${rootId}/house`);
    // standalone-only components stripped: sky + nested subscene (no recursion v1)
    expect(stripped.sort()).toEqual(["house.subscene", "sky.sky"]);
    expect(doc.entities[`${rootId}/sky`]!.components["sky"]).toBeUndefined();
    expect(doc.entities[`${rootId}/house`]!.components["subscene"]).toBeUndefined();
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    registerChunkComponents(registry);
    expect(validateScene(doc, registry)).toEqual([]);
  });

  it("registers the chunkStreamer component with defaults", () => {
    const registry = new ComponentRegistry();
    registerChunkComponents(registry);
    const result = registry.validate("chunkStreamer", { source: "demo-world" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ cellSize: 16, radius: 2, keepPadding: 1 });
    }
  });
});
