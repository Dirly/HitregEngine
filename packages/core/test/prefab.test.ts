import { describe, expect, it } from "vitest";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  createScene,
  expandScene,
  PrefabError,
  registerCoreComponents,
  type PrefabDoc,
  type SceneDoc,
} from "../src/index.js";

function setup() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  const assets = new AssetLibrary();
  return { registry, assets };
}

const streetlight: PrefabDoc = {
  version: 1,
  name: "Streetlight",
  root: "pole",
  entities: {
    pole: {
      name: "Pole",
      parent: null,
      tags: ["streetlight"],
      components: {
        transform: {},
        mesh: { source: { kind: "primitive", shape: "cylinder", size: [0.2, 4, 0.2] } },
      },
    },
    lamp: {
      name: "Lamp",
      parent: "pole",
      tags: [],
      components: {
        transform: { position: [0, 4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        light: { kind: "point", color: "#ffffff", intensity: 1, range: 10, angle: 0.5, castShadow: false },
      },
    },
  },
  props: {
    lightColor: {
      default: "#ffcc88",
      bindings: ["lamp/components/light/color"],
    },
  },
};

function sceneWithInstances(registry: ComponentRegistry): SceneDoc {
  const { doc } = applyOps(
    createScene("street"),
    [
      {
        op: "add-entity",
        id: "sl-1",
        entity: {
          name: "Streetlight A",
          parent: null,
          tags: [],
          components: {
            transform: { position: [-5, 0, 0] },
            prefab: { prefabId: "prefab-streetlight", props: {} },
          },
        },
      },
      {
        op: "add-entity",
        id: "sl-2",
        entity: {
          name: "Streetlight B",
          parent: null,
          tags: [],
          components: {
            transform: { position: [5, 0, 0] },
            prefab: {
              prefabId: "prefab-streetlight",
              props: { lightColor: "#ff2200" },
              overrides: [{ path: "lamp/components/light/intensity", value: 3 }],
            },
          },
        },
      },
    ],
    registry,
  );
  return doc;
}

describe("expandScene", () => {
  it("expands instances: props, defaults, overrides, namespaced children", () => {
    const { registry, assets } = setup();
    assets.addPrefab("prefab-streetlight", streetlight);
    const doc = sceneWithInstances(registry);

    const expanded = expandScene(doc, assets, registry);

    // instance keeps its id/name/transform; children are namespaced
    expect(expanded.entities["sl-1"]!.name).toBe("Streetlight A");
    expect(expanded.entities["sl-1"]!.components["transform"]).toMatchObject({
      position: [-5, 0, 0],
    });
    expect(expanded.entities["sl-1:lamp"]!.parent).toBe("sl-1");
    expect(expanded.entities["sl-1"]!.components["prefab"]).toBeUndefined();

    // default prop vs instance prop
    expect(expanded.entities["sl-1:lamp"]!.components["light"]).toMatchObject({
      color: "#ffcc88",
      intensity: 1,
    });
    expect(expanded.entities["sl-2:lamp"]!.components["light"]).toMatchObject({
      color: "#ff2200",
      intensity: 3, // override applied after props
    });

    // source doc untouched (collapsed document rule)
    expect(doc.entities["sl-1"]!.components["prefab"]).toBeDefined();
    expect(Object.keys(doc.entities)).toHaveLength(2);
  });

  it("propagates definition edits on re-expand while preserving overrides", () => {
    const { registry, assets } = setup();
    assets.addPrefab("prefab-streetlight", streetlight);
    const doc = sceneWithInstances(registry);

    const edited = structuredClone(streetlight);
    (edited.entities["lamp"]!.components["light"] as { range: number }).range = 25;
    assets.updatePrefab("prefab-streetlight", edited);

    const expanded = expandScene(doc, assets, registry);
    expect(expanded.entities["sl-1:lamp"]!.components["light"]).toMatchObject({ range: 25 });
    expect(expanded.entities["sl-2:lamp"]!.components["light"]).toMatchObject({
      range: 25,
      intensity: 3, // override survived the definition edit
    });
  });

  it("expands nested prefabs with compound namespacing", () => {
    const { registry, assets } = setup();
    assets.addPrefab("prefab-streetlight", streetlight);
    assets.addPrefab("prefab-plaza", {
      version: 1,
      name: "Plaza",
      root: "ground",
      entities: {
        ground: {
          name: "Ground",
          parent: null,
          tags: [],
          components: {
            transform: {},
            mesh: { source: { kind: "primitive", shape: "plane", size: [20, 1, 20] } },
          },
        },
        corner: {
          name: "Corner Light",
          parent: "ground",
          tags: [],
          components: {
            transform: { position: [8, 0, 8] },
            prefab: { prefabId: "prefab-streetlight", props: { lightColor: "#88aaff" } },
          },
        },
      },
      props: {},
    });

    const { doc } = applyOps(
      createScene("town"),
      [
        {
          op: "add-entity",
          id: "plaza-1",
          entity: {
            name: "Main Plaza",
            parent: null,
            tags: [],
            components: { transform: {}, prefab: { prefabId: "prefab-plaza" } },
          },
        },
      ],
      registry,
    );

    const expanded = expandScene(doc, assets, registry);
    expect(expanded.entities["plaza-1:corner"]!.parent).toBe("plaza-1");
    expect(expanded.entities["plaza-1:corner:lamp"]!.parent).toBe("plaza-1:corner");
    expect(expanded.entities["plaza-1:corner:lamp"]!.components["light"]).toMatchObject({
      color: "#88aaff",
    });
  });

  it("rejects prefab cycles", () => {
    const { registry, assets } = setup();
    assets.addPrefab("prefab-a", {
      version: 1,
      name: "A",
      root: "root",
      entities: {
        root: { name: "A", parent: null, tags: [], components: { transform: {} } },
        child: {
          name: "B inside A",
          parent: "root",
          tags: [],
          components: { prefab: { prefabId: "prefab-b" } },
        },
      },
      props: {},
    });
    assets.addPrefab("prefab-b", {
      version: 1,
      name: "B",
      root: "root",
      entities: {
        root: { name: "B", parent: null, tags: [], components: { transform: {} } },
        child: {
          name: "A inside B",
          parent: "root",
          tags: [],
          components: { prefab: { prefabId: "prefab-a" } },
        },
      },
      props: {},
    });

    const { doc } = applyOps(
      createScene("cyclic"),
      [
        {
          op: "add-entity",
          id: "x",
          entity: {
            name: "X",
            parent: null,
            tags: [],
            components: { prefab: { prefabId: "prefab-a" } },
          },
        },
      ],
      registry,
    );
    expect(() => expandScene(doc, assets, registry)).toThrow(/cycle/);
  });

  it("rejects unknown props and unknown prefab ids", () => {
    const { registry, assets } = setup();
    assets.addPrefab("prefab-streetlight", streetlight);
    const { doc } = applyOps(
      createScene("bad"),
      [
        {
          op: "add-entity",
          id: "s1",
          entity: {
            name: "S1",
            parent: null,
            tags: [],
            components: {
              prefab: { prefabId: "prefab-streetlight", props: { nope: 1 } },
            },
          },
        },
      ],
      registry,
    );
    expect(() => expandScene(doc, assets, registry)).toThrow(/unknown prop "nope"/);

    const { doc: doc2 } = applyOps(
      createScene("bad2"),
      [
        {
          op: "add-entity",
          id: "s2",
          entity: {
            name: "S2",
            parent: null,
            tags: [],
            components: { prefab: { prefabId: "prefab-ghost" } },
          },
        },
      ],
      registry,
    );
    expect(() => expandScene(doc2, assets, registry)).toThrow(/not found/);
  });

  it("rejects prop values that violate the bound component's schema", () => {
    const { registry, assets } = setup();
    assets.addPrefab("prefab-streetlight", streetlight);
    const { doc } = applyOps(
      createScene("bad-color"),
      [
        {
          op: "add-entity",
          id: "s1",
          entity: {
            name: "S1",
            parent: null,
            tags: [],
            components: {
              prefab: {
                prefabId: "prefab-streetlight",
                props: { lightColor: "not-a-color" },
              },
            },
          },
        },
      ],
      registry,
    );
    expect(() => expandScene(doc, assets, registry)).toThrow(PrefabError);
  });
});
