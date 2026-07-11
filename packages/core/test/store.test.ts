import { describe, expect, it } from "vitest";
import {
  ComponentRegistry,
  createScene,
  registerCoreComponents,
  SceneStore,
  type StoreChange,
} from "../src/index.js";

function setup() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  const store = new SceneStore(createScene("s"), registry);
  return store;
}

const addBox = {
  op: "add-entity" as const,
  id: "box",
  entity: {
    name: "Box",
    parent: null,
    tags: [],
    components: { transform: {} },
  },
};

describe("SceneStore", () => {
  it("applies ops, undoes, and redoes", () => {
    const store = setup();
    store.apply([addBox]);
    expect(store.doc.entities["box"]).toBeDefined();
    expect(store.canUndo).toBe(true);

    store.undo();
    expect(store.doc.entities["box"]).toBeUndefined();
    expect(store.canRedo).toBe(true);

    store.redo();
    expect(store.doc.entities["box"]).toBeDefined();
  });

  it("a new apply clears the redo stack", () => {
    const store = setup();
    store.apply([addBox]);
    store.undo();
    store.apply([{ ...addBox, id: "other" }]);
    expect(store.canRedo).toBe(false);
  });

  it("notifies subscribers once per change and supports unsubscribe", () => {
    const store = setup();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.apply([addBox]);
    expect(calls).toBe(1);
    off();
    store.undo();
    expect(calls).toBe(1);
  });

  it("replace swaps the document and clears history", () => {
    const store = setup();
    store.apply([addBox]);
    const other = createScene("other");
    store.replace(other);
    expect(store.doc.name).toBe("other");
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it("notifies with the batch's ApplyResult so subscribers can reconcile", () => {
    const store = setup();
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change));

    store.apply([addBox]);
    expect(changes[0]!.kind).toBe("ops");
    const applied = changes[0] as Extract<StoreChange, { kind: "ops" }>;
    expect([...applied.result.addedEntities]).toEqual(["box"]);

    store.apply([
      { op: "set-component", id: "box", component: "transform", data: { position: [1, 2, 3] } },
    ]);
    const edited = changes[1] as Extract<StoreChange, { kind: "ops" }>;
    expect([...edited.result.changedEntities]).toEqual(["box"]);
    expect([...edited.result.changedComponents.get("box")!]).toEqual(["transform"]);

    // undo pops the last batch (the transform edit) — its inverse is a change
    store.undo();
    const undone = changes[2] as Extract<StoreChange, { kind: "ops" }>;
    expect([...undone.result.changedEntities]).toEqual(["box"]);
    expect(undone.result.removedEntities.size).toBe(0);

    store.replace(createScene("other"));
    expect(changes[3]).toEqual({ kind: "replace" });
  });

  it("failed batches do not touch the doc or the undo stack", () => {
    const store = setup();
    expect(() =>
      store.apply([
        { op: "set-component", id: "ghost", component: "transform", data: {} },
      ]),
    ).toThrow();
    expect(store.canUndo).toBe(false);
  });
});
