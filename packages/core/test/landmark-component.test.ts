import { describe, expect, it } from "vitest";
import {
  AssetLibrary,
  ComponentRegistry,
  assembleHlodBuildDoc,
  landmarkComponentSchema,
  expandScene,
  landmarkColliderTileId,
  landmarkColliderTileRefs,
  landmarkEntities,
  landmarkTileCells,
  landmarkOf,
  registerChunkComponents,
  registerCoreAssetTypes,
  registerCoreComponents,
  type ChunkDoc,
  type SceneDoc,
} from "../src/index.js";

describe("landmark component", () => {
  it("defaults, bounds and registration", () => {
    expect(landmarkComponentSchema.parse({})).toEqual({ fogReach: 600, silhouette: 0.6 });
    expect(landmarkComponentSchema.parse({ fogReach: 900, silhouette: 1 })).toEqual({ fogReach: 900, silhouette: 1 });
    expect(() => landmarkComponentSchema.parse({ fogReach: 10 })).toThrow();
    expect(() => landmarkComponentSchema.parse({ silhouette: 1.5 })).toThrow();
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    expect(registry.validate("landmark", { fogReach: 450 }).ok).toBe(true);
    expect(registry.validate("landmark", { fogReach: -1 }).ok).toBe(false);
  });

  it("landmarkOf finds the nearest landmark up the parent chain", () => {
    const doc: SceneDoc = {
      name: "t",
      version: 1,
      entities: {
        poi: { name: "poi", parent: null, tags: ["poi"], components: {} },
        gate: { name: "gate", parent: "poi", tags: [], components: { landmark: { fogReach: 800 } } },
        arch: { name: "arch", parent: "gate", tags: [], components: {} },
        crate: { name: "crate", parent: "poi", tags: [], components: {} },
      },
    };
    expect(landmarkOf(doc, "arch")).toEqual({ fogReach: 800, silhouette: 0.6 });
    expect(landmarkOf(doc, "gate")).toEqual({ fogReach: 800, silhouette: 0.6 });
    expect(landmarkOf(doc, "crate")).toBeNull();
  });

  it("HLOD bake entities carry their landmark so the far proxy keeps its fog curve", () => {
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    registerChunkComponents(registry);
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    const box = { source: { kind: "primitive", shape: "box", size: [4, 20, 4] }, static: true };
    const entities: ChunkDoc["entities"] = {
      gate: { name: "gate", parent: null, tags: [], components: { transform: {}, landmark: { fogReach: 700, silhouette: 0.8 } } },
      pillar: { name: "pillar", parent: "gate", tags: [], components: { transform: { position: [2, 0, 0] }, mesh: box } },
      rock: { name: "rock", parent: null, tags: [], components: { transform: { position: [8, 0, 0] }, mesh: box } },
    };
    const result = assembleHlodBuildDoc(0, 0, [{ cx: 0, cz: 0, doc: { version: 1, entities } }], { cellSize: 16, factor: 4, world: "w", assets, registry });
    const byName = Object.fromEntries(Object.values(result.doc.entities).map((e) => [e.name, e]));
    expect(byName["pillar"]!.components["landmark"]).toEqual({ fogReach: 700, silhouette: 0.8 });
    expect(byName["rock"]!.components["landmark"]).toBeUndefined();
  });

  it("HLOD bake entities of a landmark-tagged prefab never LOD to an impostor card, fog or not", () => {
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    registerChunkComponents(registry);
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    const box = { source: { kind: "primitive", shape: "box", size: [4, 20, 4] }, static: true };
    const entities: ChunkDoc["entities"] = {
      wall: { name: "wall", parent: null, tags: ["landmark", "built"], components: { transform: {}, mesh: box } },
      cap: { name: "cap", parent: "wall", tags: [], components: { transform: { position: [2, 0, 0] }, mesh: box } },
      tree: { name: "tree", parent: null, tags: ["scatter"], components: { transform: { position: [8, 0, 0] }, mesh: box } },
    };
    const result = assembleHlodBuildDoc(0, 0, [{ cx: 0, cz: 0, doc: { version: 1, entities } }], { cellSize: 16, factor: 4, world: "w", assets, registry });
    const byName = Object.fromEntries(Object.values(result.doc.entities).map((e) => [e.name, e]));
    expect((byName["wall"]!.components["mesh"] as { lod?: boolean }).lod).toBe(false);
    expect((byName["cap"]!.components["mesh"] as { lod?: boolean }).lod).toBe(false);
    expect((byName["tree"]!.components["mesh"] as { lod?: boolean }).lod).not.toBe(false);
  });

  it("a world landmark with fog places its prefab under a landmark that survives prefab expansion", () => {
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    assets.addPrefab("landmarks/gate-1", {
      version: 1,
      name: "gate",
      root: "rock",
      entities: {
        rock: { name: "rock", parent: null, tags: [], components: { transform: {}, mesh: { source: { kind: "primitive", shape: "box", size: [4, 4, 4] } } } },
        spire: { name: "spire", parent: "rock", tags: [], components: { transform: {}, mesh: { source: { kind: "primitive", shape: "box", size: [1, 9, 1] } } } },
      },
    } as never);
    const entities: ChunkDoc["entities"] = {};
    landmarkEntities([{ id: "op:gate:landmark", prefab: "landmarks/gate-1", position: [10, 0, 10], radius: 5, digest: "1", fog: { fogReach: 700, silhouette: 0.5 } }], 48, 0, 0, entities);
    const expanded = expandScene({ version: 1, entities } as SceneDoc, assets, registry);
    const spire = Object.entries(expanded.entities).find(([, e]) => e.name === "spire")![0];
    expect(landmarkOf(expanded, spire)).toEqual({ fogReach: 700, silhouette: 0.5 });
  });

  it("a long landmark streams its collider tile in every cell it covers, its visuals only in the origin cell", () => {
    // a 135 m ramp: origin cell (2,0) at cellSize 48, bounds reaching 3 cells each way
    const ramp = { id: "op:ramp:landmark", prefab: "landmarks/ramp-1", position: [120, 30, 20] as [number, number, number], radius: 135, digest: "1" };
    expect(landmarkTileCells(ramp, 48)).toEqual({ cx0: -1, cx1: 5, cz0: -3, cz1: 3 });
    // the bake wrote tiles only where the ramp has triangles: both ends and the middle
    const written = new Set([[-1, 0], [2, 0], [5, 1]].map(([x, z]) => landmarkColliderTileId(ramp.prefab, x!, z!)));
    const exists = (id: string, kind: "prefab" | "model") => (kind === "prefab" ? id === ramp.prefab : written.has(id));
    const at = (cx: number, cz: number, ex: typeof exists | null = exists) => { const e: ChunkDoc["entities"] = {}; landmarkEntities([ramp], 48, cx, cz, e, ex ?? undefined); return e; };
    const end = at(-1, 0);
    expect(Object.keys(end)).toEqual(["lmc_op:ramp:landmark"]);
    const tile = end["lmc_op:ramp:landmark"]!.components as Record<string, any>;
    expect(tile["collider"]).toEqual({ shape: "trimesh" });
    expect(tile["visibility"]).toEqual({ visible: false });
    expect(tile["mesh"].source.assetId).toBe("landmarks/ramp-1.collider.-1_0.glb");
    expect(tile["transform"].position).toEqual([120 + 48, 30, 20]); // the landmark origin in this cell's frame
    expect(Object.keys(at(2, 0)).sort()).toEqual(["lm_op:ramp:landmark", "lmc_op:ramp:landmark"]);
    expect(Object.keys(at(5, 1))).toEqual(["lmc_op:ramp:landmark"]);
    expect(at(4, 0)).toEqual({}); // inside the bounds but no triangles there: nothing (never a box fallback)
    expect(at(9, 0)).toEqual({});
    // an older bake (colliders inside the prefab, no tiles) streams as before; without assetExists no tile is guessed
    expect(Object.keys(at(2, 0, (_id, k) => k === "prefab"))).toEqual(["lm_op:ramp:landmark"]);
    expect(at(-1, 0, null)).toEqual({});
    // every candidate tile is in the presence list a worker host sends
    const refs = landmarkColliderTileRefs([ramp], 48);
    expect(refs).toHaveLength(7 * 7);
    for (const id of written) expect(refs).toContain(id);
  });
});
