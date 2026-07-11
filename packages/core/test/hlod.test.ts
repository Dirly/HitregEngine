import { describe, expect, it } from "vitest";
import {
  AssetLibrary,
  ComponentRegistry,
  registerChunkComponents,
  registerCoreAssetTypes,
  registerCoreComponents,
  supercellForCell,
  supercellOrigin,
  groupCellsBySupercell,
  isStaticRenderEntity,
  assembleHlodBuildDoc,
  hlodCacheKey,
  type AssembleHlodOptions,
  type ChunkCell,
  type ChunkDoc,
  type EntityDoc,
} from "../src/index.js";

function setup(): { assets: AssetLibrary; registry: ComponentRegistry } {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  return { assets, registry };
}

const box = (size: [number, number, number], material?: string): EntityDoc["components"]["mesh"] => ({
  source: { kind: "primitive", shape: "box", size },
  ...(material ? { material } : {}),
});

const cell = (cx: number, cz: number, entities: ChunkDoc["entities"]): ChunkCell => ({
  cx,
  cz,
  doc: { version: 1, entities },
});

function options(assets: AssetLibrary, registry: ComponentRegistry): AssembleHlodOptions {
  return { cellSize: 16, factor: 4, world: "demo", assets, registry };
}

describe("HLOD supercell geometry", () => {
  it("maps cells to supercells with floor division (negatives included)", () => {
    expect(supercellForCell(0, 0, 4)).toEqual([0, 0]);
    expect(supercellForCell(3, 3, 4)).toEqual([0, 0]);
    expect(supercellForCell(4, 4, 4)).toEqual([1, 1]);
    expect(supercellForCell(-1, -5, 4)).toEqual([-1, -2]);
  });

  it("supercell origin is its min-corner cell origin", () => {
    expect(supercellOrigin(0, 0, 16, 4)).toEqual([0, 0, 0]);
    expect(supercellOrigin(1, -1, 16, 4)).toEqual([64, 0, -64]);
  });

  it("groups cells into supercell buckets", () => {
    const cells = [cell(0, 0, {}), cell(3, 1, {}), cell(4, 0, {}), cell(-1, 0, {})];
    const groups = groupCellsBySupercell(cells, 4);
    expect(groups.get("0_0")!.map((c) => [c.cx, c.cz])).toEqual([[0, 0], [3, 1]]);
    expect(groups.get("1_0")!.map((c) => [c.cx, c.cz])).toEqual([[4, 0]]);
    expect(groups.get("-1_0")!.map((c) => [c.cx, c.cz])).toEqual([[-1, 0]]);
  });
});

describe("HLOD static-render eligibility", () => {
  const withComponents = (components: EntityDoc["components"]): EntityDoc => ({
    name: "e",
    parent: null,
    tags: [],
    components,
  });

  it("accepts a plain mesh (with or without a static collider)", () => {
    expect(isStaticRenderEntity(withComponents({ mesh: box([1, 1, 1]) }))).toBe(true);
    expect(
      isStaticRenderEntity(withComponents({ mesh: box([1, 1, 1]), collider: { shape: "box" } })),
    ).toBe(true);
    expect(
      isStaticRenderEntity(
        withComponents({ mesh: box([1, 1, 1]), rigidbody: { kind: "static" } }),
      ),
    ).toBe(true);
  });

  it("rejects non-mesh, terrain, and anything that can move", () => {
    expect(isStaticRenderEntity(withComponents({ light: { kind: "point" } }))).toBe(false);
    expect(
      isStaticRenderEntity(withComponents({ mesh: { source: { kind: "heightmap" } } })),
    ).toBe(false);
    expect(
      isStaticRenderEntity(withComponents({ mesh: box([1, 1, 1]), script: { name: "spin" } })),
    ).toBe(false);
    expect(
      isStaticRenderEntity(
        withComponents({ mesh: box([1, 1, 1]), rigidbody: { kind: "dynamic" } }),
      ),
    ).toBe(false);
    expect(
      isStaticRenderEntity(withComponents({ mesh: box([1, 1, 1]), animator: {} })),
    ).toBe(false);
  });
});

describe("HLOD build-doc assembly", () => {
  it("flattens static entities into supercell-local space and collects deps", () => {
    const { assets, registry } = setup();
    assets.addModel({ id: "tree", name: "Tree", url: "/tree.glb" });
    assets.addDataAsset({
      id: "mat-a",
      type: "material",
      name: "A",
      data: { color: "#889988", map: "bark" },
    });

    // supercell (0,0) with factor 4, cellSize 16 -> origin [0,0,0]
    const cells = [
      cell(0, 0, {
        ground: { name: "Ground", parent: null, tags: [], components: { transform: { position: [1, 0, 2] }, mesh: box([16, 1, 16], "mat-a") } },
      }),
      cell(1, 0, {
        // cell (1,0) origin is world [16,0,0]; local [2,3,0] -> world [18,3,0]
        rock: { name: "Rock", parent: null, tags: [], components: { transform: { position: [2, 3, 0] }, mesh: { source: { kind: "asset", assetId: "tree" } } } },
        // dynamic: excluded
        npc: { name: "NPC", parent: null, tags: [], components: { transform: { position: [4, 0, 0] }, mesh: box([1, 1, 1]), script: { name: "wander" } } },
      }),
    ];

    const result = assembleHlodBuildDoc(0, 0, cells, options(assets, registry));

    expect(result.origin).toEqual([0, 0, 0]);
    const ids = Object.keys(result.doc.entities).sort();
    expect(ids).toEqual(["0_0/ground", "1_0/rock"]);

    // world positions rebased to supercell origin (== world here)
    const groundPos = (result.doc.entities["0_0/ground"]!.components["transform"] as { position: number[] }).position;
    expect(groundPos).toEqual([1, 0, 2]);
    const rockPos = (result.doc.entities["1_0/rock"]!.components["transform"] as { position: number[] }).position;
    expect(rockPos).toEqual([18, 3, 0]);

    // flattened: parentless, tagged hlod, mesh carried
    expect(result.doc.entities["1_0/rock"]!.parent).toBeNull();
    expect(result.doc.entities["1_0/rock"]!.tags).toEqual(["hlod"]);

    // dependency chain: model + material + material's texture map
    expect(result.deps.models).toEqual(["tree"]);
    expect(result.deps.materials).toEqual(["mat-a"]);
    expect(result.deps.textures).toEqual(["bark"]);

    // coarse bounds over baked origins
    expect(result.bounds).toEqual({ min: [1, 0, 0], max: [18, 3, 2] });
  });

  it("rebases geometry relative to a non-origin supercell", () => {
    const { assets, registry } = setup();
    // supercell (1,0), factor 4, cellSize 16 -> origin world [64,0,0]
    const cells = [
      cell(4, 0, {
        // cell (4,0) origin world [64,0,0]; local [5,0,0] -> world [69,0,0]
        post: { name: "Post", parent: null, tags: [], components: { transform: { position: [5, 0, 0] }, mesh: box([1, 4, 1]) } },
      }),
    ];
    const result = assembleHlodBuildDoc(1, 0, cells, options(assets, registry));
    expect(result.origin).toEqual([64, 0, 0]);
    const pos = (result.doc.entities["4_0/post"]!.components["transform"] as { position: number[] }).position;
    expect(pos).toEqual([5, 0, 0]); // 69 - 64
  });

  it("excludes static geometry parented under a dynamic entity", () => {
    const { assets, registry } = setup();
    const cells = [
      cell(0, 0, {
        platform: { name: "Platform", parent: null, tags: [], components: { transform: { position: [0, 2, 0] }, mesh: box([4, 1, 4]), script: { name: "elevator" } } },
        crate: { name: "Crate", parent: "platform", tags: [], components: { transform: { position: [0, 1, 0] }, mesh: box([1, 1, 1]) } },
      }),
    ];
    const result = assembleHlodBuildDoc(0, 0, cells, options(assets, registry));
    // platform is dynamic (script); crate rides it -> neither baked
    expect(Object.keys(result.doc.entities)).toEqual([]);
    expect(result.warnings.some((w) => w.includes("dynamic ancestor"))).toBe(true);
    expect(result.bounds).toBeNull();
  });

  it("expands prefab instances and pulls their models/materials into deps", () => {
    const { assets, registry } = setup();
    assets.addModel({ id: "lamp-model", name: "Lamp", url: "/lamp.glb" });
    assets.addPrefab("lamp", {
      version: 1,
      name: "Lamp",
      root: "root",
      entities: {
        root: { name: "Lamp", parent: null, tags: [], components: { transform: {}, mesh: { source: { kind: "asset", assetId: "lamp-model" } } } },
      },
      props: {},
    });
    const cells = [
      cell(0, 0, {
        lamp1: { name: "Lamp 1", parent: null, tags: [], components: { transform: { position: [3, 0, 3] }, prefab: { prefabId: "lamp" } } },
      }),
    ];
    const result = assembleHlodBuildDoc(0, 0, cells, options(assets, registry));
    // the expanded prefab's static mesh is baked
    expect(Object.keys(result.doc.entities)).toEqual(["0_0/lamp1"]);
    expect(result.deps.prefabs).toEqual(["lamp"]);
    expect(result.deps.models).toEqual(["lamp-model"]);
  });
});

describe("HLOD content-hash cache key", () => {
  function baseInput() {
    const { assets, registry } = setup();
    assets.addModel({ id: "tree", name: "Tree", url: "/tree.glb" });
    assets.addDataAsset({ id: "mat-a", type: "material", name: "A", data: { color: "#889988", map: "bark" } });
    assets.addTexture({ id: "bark", name: "Bark", url: "/bark.png" });
    const cells = [
      cell(0, 0, { g: { name: "G", parent: null, tags: [], components: { transform: {}, mesh: box([2, 2, 2], "mat-a") } } }),
    ];
    const result = assembleHlodBuildDoc(0, 0, cells, options(assets, registry));
    return {
      assets,
      registry,
      cells,
      input: { settings: { factor: 4 }, scx: 0, scz: 0, cells, deps: result.deps, assets },
    };
  }

  it("is stable across object key ordering and repeated calls", () => {
    const a = baseInput();
    const b = baseInput();
    expect(hlodCacheKey(a.input)).toBe(hlodCacheKey(b.input));
    // same key, reordered settings fields
    const reordered = { ...a.input, settings: { z: 1, factor: 4 } };
    const original = { ...a.input, settings: { factor: 4, z: 1 } };
    expect(hlodCacheKey(reordered)).toBe(hlodCacheKey(original));
    expect(hlodCacheKey(a.input)).toMatch(/^hlod1-[0-9a-f]{16}$/);
  });

  it("changes when the generator version, settings, or supercell change", () => {
    const { input } = baseInput();
    const key = hlodCacheKey(input);
    expect(hlodCacheKey({ ...input, generatorVersion: "x" })).not.toBe(key);
    expect(hlodCacheKey({ ...input, settings: { factor: 8 } })).not.toBe(key);
    expect(hlodCacheKey({ ...input, scx: 1 })).not.toBe(key);
  });

  it("changes when source cell content changes", () => {
    const { input, cells } = baseInput();
    const key = hlodCacheKey(input);
    const moved = [
      cell(0, 0, { g: { name: "G", parent: null, tags: [], components: { transform: { position: [9, 0, 0] }, mesh: box([2, 2, 2], "mat-a") } } }),
    ];
    void cells;
    expect(hlodCacheKey({ ...input, cells: moved })).not.toBe(key);
  });

  it("changes down the whole dependency chain: material edit and texture swap", () => {
    const { assets, input } = baseInput();
    const key = hlodCacheKey(input);

    // edit the material a baked mesh references -> different bake
    assets.updateDataAsset({ id: "mat-a", type: "material", name: "A", data: { color: "#112233", map: "bark" } });
    const afterMaterial = hlodCacheKey(input);
    expect(afterMaterial).not.toBe(key);

    // swap the texture the material maps -> different bake again
    assets.updateDataAsset({ id: "mat-a", type: "material", name: "A", data: { color: "#112233", map: "bark2" } });
    // deps still list "bark" (from the first assembly), but the material def changed,
    // which the key captures via the material definition hash.
    expect(hlodCacheKey(input)).not.toBe(afterMaterial);
  });

  it("changes when a referenced model definition changes", () => {
    const { assets, cells } = baseInput();
    assets.addModel({ id: "extra", name: "Extra", url: "/a.glb" });
    const deps = { prefabs: [], models: ["extra"], materials: [], textures: [] };
    const input = { settings: {}, scx: 0, scz: 0, cells, deps, assets };
    const key = hlodCacheKey(input);
    // a model with the same id but different url must produce a different key
    const { assets: assets2, cells: cells2 } = baseInput();
    assets2.addModel({ id: "extra", name: "Extra", url: "/b.glb" });
    const key2 = hlodCacheKey({ settings: {}, scx: 0, scz: 0, cells: cells2, deps, assets: assets2 });
    expect(key2).not.toBe(key);
  });
});
