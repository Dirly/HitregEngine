import { describe, expect, it } from "vitest";
import {
  chunkDocSchema,
  chunkFileName,
  chunkToSceneDoc,
  chunkLocalToWorld,
  worldToChunkLocal,
  moveEntityAcrossChunks,
  parseChunkCoords,
  registerChunkComponents,
  subsceneToSceneDoc,
  ComponentRegistry,
  validateScene,
  registerCoreComponents,
  type ChunkDoc,
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

  it("chunk-local <-> world transforms round-trip for any cell", () => {
    const cellSize = 160;
    for (const [cx, cz] of [[0, 0], [3, -2], [-5, 7]] as const) {
      const local: [number, number, number] = [12.5, 4, -33];
      const world = chunkLocalToWorld(local, cx, cz, cellSize);
      expect(world).toEqual([12.5 + cx * 160, 4, -33 + cz * 160]);
      expect(worldToChunkLocal(world, cx, cz, cellSize)).toEqual(local);
    }
  });

  const cell = (entities: ChunkDoc["entities"]): ChunkDoc => ({ version: 1, entities });

  it("moves a top-level entity across cells, preserving world position and id", () => {
    const cellSize = 160;
    const src = cell({
      tower: { name: "Tower", parent: null, tags: [], components: { transform: { position: [10, 0, 20] } } },
      flag: { name: "Flag", parent: "tower", tags: [], components: { transform: { position: [0, 8, 0] } } },
    });
    const dst = cell({
      rock: { name: "Rock", parent: null, tags: [], components: { transform: {} } },
    });
    // tower's world pos in cell (1,1): [10+160, 0, 20+160] = [170, 0, 180]
    const result = moveEntityAcrossChunks("tower", { cx: 1, cz: 1, doc: src }, { cx: 2, cz: -1, doc: dst }, cellSize);
    if ("error" in result) throw new Error(result.error);

    // stable id, subtree came along
    expect(result.moved.sort()).toEqual(["flag", "tower"]);
    expect(result.source.entities["tower"]).toBeUndefined();
    expect(result.source.entities["flag"]).toBeUndefined();
    expect(result.dest.entities["rock"]).toBeDefined(); // dest content untouched

    // root re-localized so WORLD position is preserved: dest cell (2,-1) origin
    // is [320,0,-160], so local must be [170-320, 0, 180-(-160)] = [-150, 0, 340]
    const movedLocal = (result.dest.entities["tower"]!.components["transform"] as { position: number[] }).position;
    expect(movedLocal).toEqual([-150, 0, 340]);
    expect(chunkLocalToWorld(movedLocal as [number, number, number], 2, -1, cellSize)).toEqual([170, 0, 180]);
    // child transform (local to its parent) is unchanged
    expect((result.dest.entities["flag"]!.components["transform"] as { position: number[] }).position).toEqual([0, 8, 0]);
  });

  it("refuses invalid moves and writes nothing", () => {
    const cellSize = 16;
    const src = cell({
      a: { name: "A", parent: null, tags: [], components: { transform: {} } },
      b: { name: "B", parent: "a", tags: [], components: { transform: {} } },
    });
    const dst = cell({ a: { name: "A2", parent: null, tags: [], components: {} } });
    const cellA = { cx: 0, cz: 0, doc: src };
    const cellB = { cx: 1, cz: 0, doc: dst };

    // unknown id
    expect(moveEntityAcrossChunks("ghost", cellA, cellB, cellSize)).toMatchObject({ error: expect.stringContaining("not in source") });
    // nested entity (has a parent) may not cross cells
    expect(moveEntityAcrossChunks("b", cellA, cellB, cellSize)).toMatchObject({ error: expect.stringContaining("nested") });
    // id collision with the destination
    expect(moveEntityAcrossChunks("a", cellA, cellB, cellSize)).toMatchObject({ error: expect.stringContaining("already exists") });
    // inputs never mutated by a failed move
    expect(Object.keys(src.entities).sort()).toEqual(["a", "b"]);
    expect(Object.keys(dst.entities)).toEqual(["a"]);
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
