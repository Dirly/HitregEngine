import { describe, expect, it } from "vitest";
import { AssetLibrary } from "../src/assets.js";
import { ComponentRegistry } from "../src/components/registry.js";
import { registerCoreComponents } from "../src/components/core.js";
import { registerCoreAssetTypes } from "../src/assets.js";
import { createScene } from "../src/scene.js";
import { expandScene } from "../src/prefab.js";

/**
 * A prefab knob must be able to bind to ONE component of a vector — a "height"
 * prop writing mesh/source/size/1, or a low-poly "facets" prop writing
 * mesh/source/segments/0. Before arrays were traversable, the only options were
 * exposing the whole tuple as a raw array control or dropping the knob.
 */
function setup() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  assets.addPrefab("test/post", {
    version: 1,
    name: "Post",
    root: "post",
    entities: {
      post: {
        name: "Post",
        parent: null,
        tags: [],
        components: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          mesh: {
            source: { kind: "primitive", shape: "cylinder", size: [1, 4, 1], segments: [8, 1] },
            castShadow: true,
            receiveShadow: true,
          },
        },
      },
    },
    props: {
      height: { default: 4, bindings: ["post/components/mesh/source/size/1"] },
      facets: { default: 8, bindings: ["post/components/mesh/source/segments/0"] },
    },
  });
  return { assets, registry };
}

describe("prefab bindings into arrays", () => {
  it("writes a single vector component", () => {
    const { assets, registry } = setup();
    const scene = createScene("s");
    scene.entities["a"] = {
      name: "A",
      parent: null,
      tags: [],
      components: { prefab: { prefabId: "test/post", props: { height: 9, facets: 6 } } },
    };
    const out = expandScene(scene, assets, registry);
    const mesh = out.entities["a"]!.components["mesh"] as {
      source: { size: number[]; segments: number[] };
    };
    expect(mesh.source.size).toEqual([1, 9, 1]);
    expect(mesh.source.segments).toEqual([6, 1]);
  });

  it("rejects a non-numeric index into an array", () => {
    const { assets, registry } = setup();
    assets.addPrefab("test/bad", {
      version: 1,
      name: "Bad",
      root: "p",
      entities: {
        p: {
          name: "P",
          parent: null,
          tags: [],
          components: {
            transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
        },
      },
      props: { x: { default: 1, bindings: ["p/components/transform/position/nope"] } },
    });
    const scene = createScene("s");
    scene.entities["b"] = {
      name: "B",
      parent: null,
      tags: [],
      components: { prefab: { prefabId: "test/bad", props: { x: 5 } } },
    };
    expect(() => expandScene(scene, assets, registry)).toThrow(/numeric index|array/);
  });
});
