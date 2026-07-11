import { describe, expect, it } from "vitest";
import {
  applyOps,
  buildSceneIndex,
  ComponentRegistry,
  createScene,
  indexChildrenOf,
  indexSubtreeOf,
  registerCoreComponents,
  SceneStore,
  subtreeOf,
  type Op,
  type SceneDoc,
} from "../src/index.js";

function setup() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  return registry;
}

/** Nested doc with tags, components, and a prefab instance entity. */
function buildDoc(registry: ComponentRegistry): SceneDoc {
  const { doc } = applyOps(
    createScene("indexed"),
    [
      {
        op: "add-entity",
        id: "root",
        entity: { name: "Root", parent: null, tags: [], components: {} },
      },
      {
        op: "add-entity",
        id: "ground",
        entity: {
          name: "Ground",
          parent: "root",
          tags: ["terrain"],
          components: { transform: {} },
        },
      },
      {
        op: "add-entity",
        id: "rock",
        entity: {
          name: "Rock",
          parent: "ground",
          tags: ["terrain", "climbable"],
          components: { transform: {} },
        },
      },
      {
        op: "add-entity",
        id: "lamp",
        entity: {
          name: "Lamp",
          parent: "root",
          tags: [],
          components: {
            transform: {},
            prefab: { prefabId: "prefabs/lamp", props: {}, overrides: [] },
          },
        },
      },
      {
        op: "add-entity",
        id: "lamp2",
        entity: {
          name: "Lamp 2",
          parent: null,
          tags: [],
          components: {
            prefab: { prefabId: "prefabs/lamp", props: {}, overrides: [] },
          },
        },
      },
    ],
    registry,
  );
  return doc;
}

describe("buildSceneIndex", () => {
  it("indexes children (insertion-ordered), tags, components, and prefab instances", () => {
    const doc = buildDoc(setup());
    const index = buildSceneIndex(doc);

    expect(index.childrenByParent.get(null)).toEqual(["root", "lamp2"]);
    expect(index.childrenByParent.get("root")).toEqual(["ground", "lamp"]);
    expect(index.childrenByParent.get("ground")).toEqual(["rock"]);
    // leaf entities have no entry at all (no empty arrays)
    expect(index.childrenByParent.has("rock")).toBe(false);

    expect(index.entitiesByTag).toEqual(
      new Map([
        ["terrain", new Set(["ground", "rock"])],
        ["climbable", new Set(["rock"])],
      ]),
    );

    expect(index.entitiesByComponent.get("transform")).toEqual(
      new Set(["ground", "rock", "lamp"]),
    );
    expect(index.entitiesByComponent.get("prefab")).toEqual(
      new Set(["lamp", "lamp2"]),
    );

    expect(index.prefabInstances).toEqual(
      new Map([["prefabs/lamp", new Set(["lamp", "lamp2"])]]),
    );
  });

  it("indexChildrenOf and indexSubtreeOf agree with the doc-scanning helpers", () => {
    const doc = buildDoc(setup());
    const index = buildSceneIndex(doc);

    expect(indexChildrenOf(index, "root")).toEqual(["ground", "lamp"]);
    expect(indexChildrenOf(index, "rock")).toEqual([]);
    expect(indexSubtreeOf(index, doc, "root")).toEqual(subtreeOf(doc, "root"));
    expect(indexSubtreeOf(index, doc, "ground")).toEqual(["ground", "rock"]);
    expect(indexSubtreeOf(index, doc, "missing")).toEqual([]);
  });
});

describe("SceneStore.index incremental maintenance", () => {
  /**
   * The load-bearing equivalence test: after every batch (with the index kept
   * warm so the incremental path actually runs), the maintained index must
   * deep-equal a fresh build from the doc.
   */
  it("stays deep-equal to buildSceneIndex(store.doc) across a batch series", () => {
    const registry = setup();
    const store = new SceneStore(buildDoc(registry), registry);
    void store.index; // warm the cache so updates are incremental, not lazy

    const batches: Op[][] = [
      // non-structural: component + tag + name edits (incremental path)
      [
        {
          op: "set-component",
          id: "rock",
          component: "mesh",
          data: { source: { kind: "primitive", shape: "box" } },
        },
        { op: "set-tags", id: "ground", tags: ["terrain", "walkable"] },
        { op: "rename", id: "lamp", name: "Street Lamp" },
      ],
      // pure additions, including a child of a new entity
      [
        {
          op: "add-entity",
          id: "props",
          entity: { name: "Props", parent: "root", tags: [], components: {} },
        },
        {
          op: "add-entity",
          id: "crate",
          entity: {
            name: "Crate",
            parent: "props",
            tags: ["climbable"],
            components: { transform: {} },
          },
        },
      ],
      // prefab retarget + component removal on an existing entity
      [
        {
          op: "set-component",
          id: "lamp2",
          component: "prefab",
          data: { prefabId: "prefabs/lantern", props: {}, overrides: [] },
        },
        { op: "remove-component", id: "rock", component: "mesh" },
      ],
      // structural: reparent (rebuild path)
      [{ op: "reparent", id: "rock", parent: "props" }],
      // structural: cascading removal (rebuild path)
      [{ op: "remove-entity", id: "props" }],
      // mixed batch: add + change + remove together
      [
        {
          op: "add-entity",
          id: "sign",
          entity: { name: "Sign", parent: "root", tags: ["readable"], components: {} },
        },
        { op: "set-tags", id: "ground", tags: [] },
        { op: "remove-entity", id: "lamp2" },
      ],
    ];

    for (const batch of batches) {
      store.apply(batch);
      expect(store.index).toEqual(buildSceneIndex(store.doc));
    }

    while (store.canUndo) {
      store.undo();
      expect(store.index).toEqual(buildSceneIndex(store.doc));
    }
    while (store.canRedo) {
      store.redo();
      expect(store.index).toEqual(buildSceneIndex(store.doc));
    }
  });

  it("replace invalidates the index and rebuilds from the new doc", () => {
    const registry = setup();
    const store = new SceneStore(buildDoc(registry), registry);
    expect(store.index.entitiesByTag.has("terrain")).toBe(true);

    store.replace(createScene("blank"));
    expect(store.index).toEqual(buildSceneIndex(store.doc));
    expect(store.index.childrenByParent.size).toBe(0);
  });
});

describe("scene index perf sanity", () => {
  it("builds and queries a 10,000-entity doc well under a second", () => {
    // 100 roots x 99 children each = 10,000 entities, built directly (the doc
    // is authoring truth; no need to route a synthetic benchmark through ops)
    const doc = createScene("big");
    for (let r = 0; r < 100; r++) {
      const rootId = `group-${r}`;
      doc.entities[rootId] = {
        name: `Group ${r}`,
        parent: null,
        tags: ["group"],
        components: {},
      };
      for (let c = 0; c < 99; c++) {
        doc.entities[`${rootId}-item-${c}`] = {
          name: `Item ${c}`,
          parent: rootId,
          tags: c % 2 === 0 ? ["even"] : ["odd"],
          components: { transform: {} },
        };
      }
    }
    expect(Object.keys(doc.entities).length).toBe(10_000);

    const start = performance.now();
    const index = buildSceneIndex(doc);
    for (let r = 0; r < 100; r++) {
      expect(indexChildrenOf(index, `group-${r}`).length).toBe(99);
    }
    const elapsed = performance.now() - start;

    expect(index.entitiesByTag.get("group")!.size).toBe(100);
    // generous upper bound: a regression to accidental O(n^2) would blow this
    expect(elapsed).toBeLessThan(1000);
  });
});
