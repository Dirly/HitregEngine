import { describe, expect, it } from "vitest";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  OpError,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "../src/index.js";

function setup() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  return registry;
}

function buildScene(registry: ComponentRegistry): SceneDoc {
  const { doc } = applyOps(
    createScene("test"),
    [
      {
        op: "add-entity",
        id: "root",
        entity: { name: "Root", parent: null, tags: [], components: {} },
      },
      {
        op: "add-entity",
        id: "child",
        entity: {
          name: "Child",
          parent: "root",
          tags: ["terrain"],
          components: { transform: {} },
        },
      },
      {
        op: "add-entity",
        id: "grandchild",
        entity: { name: "Grandchild", parent: "child", tags: [], components: {} },
      },
    ],
    registry,
  );
  return doc;
}

describe("applyOps", () => {
  it("adds entities and applies component schema defaults", () => {
    const registry = setup();
    const doc = buildScene(registry);
    expect(doc.entities["child"]!.components["transform"]).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
  });

  it("rejects unknown component types and leaves the input untouched", () => {
    const registry = setup();
    const doc = buildScene(registry);
    const before = structuredClone(doc);
    expect(() =>
      applyOps(
        doc,
        [{ op: "set-component", id: "child", component: "warp-drive", data: {} }],
        registry,
      ),
    ).toThrow(OpError);
    expect(doc).toEqual(before);
  });

  it("is atomic: a failing op late in the batch changes nothing", () => {
    const registry = setup();
    const doc = buildScene(registry);
    const before = structuredClone(doc);
    const ops: Op[] = [
      { op: "rename", id: "child", name: "Renamed" },
      { op: "set-component", id: "missing", component: "transform", data: {} },
    ];
    expect(() => applyOps(doc, ops, registry)).toThrow(OpError);
    expect(doc).toEqual(before);
  });

  it("inverse of set-component restores the previous value", () => {
    const registry = setup();
    const doc = buildScene(registry);
    const { doc: next, inverse } = applyOps(
      doc,
      [
        {
          op: "set-component",
          id: "child",
          component: "transform",
          data: { position: [5, 0, -2] },
        },
      ],
      registry,
    );
    expect(next.entities["child"]!.components["transform"]).toMatchObject({
      position: [5, 0, -2],
    });
    const { doc: restored } = applyOps(next, inverse, registry);
    expect(restored).toEqual(doc);
  });

  it("remove-entity cascades to the subtree, and inverse restores it", () => {
    const registry = setup();
    const doc = buildScene(registry);
    const { doc: next, inverse } = applyOps(
      doc,
      [{ op: "remove-entity", id: "child" }],
      registry,
    );
    expect(next.entities["child"]).toBeUndefined();
    expect(next.entities["grandchild"]).toBeUndefined();
    expect(next.entities["root"]).toBeDefined();

    const { doc: restored } = applyOps(next, inverse, registry);
    expect(restored).toEqual(doc);
  });

  it("rejects reparenting an entity under its own descendant", () => {
    const registry = setup();
    const doc = buildScene(registry);
    expect(() =>
      applyOps(
        doc,
        [{ op: "reparent", id: "child", parent: "grandchild" }],
        registry,
      ),
    ).toThrow(/descendant/);
  });

  it("inverse of a multi-op batch restores the original document", () => {
    const registry = setup();
    const doc = buildScene(registry);
    const ops: Op[] = [
      { op: "rename", id: "child", name: "Cliff_02" },
      { op: "set-tags", id: "child", tags: ["terrain", "climbable"] },
      { op: "reparent", id: "grandchild", parent: "root" },
      { op: "remove-entity", id: "child" },
      {
        op: "add-entity",
        id: "lamp",
        entity: {
          name: "Lamp",
          parent: "root",
          tags: [],
          components: { light: { kind: "point", intensity: 2 } },
        },
      },
    ];
    const { doc: next, inverse } = applyOps(doc, ops, registry);
    expect(next.entities["lamp"]!.components["light"]).toMatchObject({
      kind: "point",
      intensity: 2,
      color: "#ffffff",
    });
    const { doc: restored } = applyOps(next, inverse, registry);
    expect(restored).toEqual(doc);
  });
});
