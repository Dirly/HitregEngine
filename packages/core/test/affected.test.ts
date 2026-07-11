import { describe, expect, it } from "vitest";
import {
  applyOps,
  ComponentRegistry,
  createScene,
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

describe("applyOps affected sets", () => {
  it("add-entity lands in addedEntities only", () => {
    const registry = setup();
    const result = applyOps(
      buildScene(registry),
      [
        {
          op: "add-entity",
          id: "lamp",
          entity: { name: "Lamp", parent: "root", tags: [], components: {} },
        },
      ],
      registry,
    );
    expect(result.addedEntities).toEqual(new Set(["lamp"]));
    expect(result.changedEntities).toEqual(new Set());
    expect(result.removedEntities).toEqual(new Set());
    expect(result.changedComponents).toEqual(new Map());
  });

  it("rename, set-tags, and reparent mark the entity changed with no component entry", () => {
    const registry = setup();
    const ops: Op[] = [
      { op: "rename", id: "child", name: "Renamed" },
      { op: "set-tags", id: "child", tags: ["terrain", "climbable"] },
      { op: "reparent", id: "grandchild", parent: "root" },
    ];
    const result = applyOps(buildScene(registry), ops, registry);
    expect(result.changedEntities).toEqual(new Set(["child", "grandchild"]));
    expect(result.addedEntities).toEqual(new Set());
    expect(result.removedEntities).toEqual(new Set());
    expect(result.changedComponents).toEqual(new Map());
  });

  it("set-component and remove-component record the entity and component name", () => {
    const registry = setup();
    const ops: Op[] = [
      {
        op: "set-component",
        id: "root",
        component: "light",
        data: { kind: "point" },
      },
      { op: "remove-component", id: "child", component: "transform" },
    ];
    const result = applyOps(buildScene(registry), ops, registry);
    expect(result.changedEntities).toEqual(new Set(["root", "child"]));
    expect(result.changedComponents).toEqual(
      new Map([
        ["root", new Set(["light"])],
        ["child", new Set(["transform"])],
      ]),
    );
  });

  it("remove-entity records the whole cascaded subtree as removed", () => {
    const registry = setup();
    const result = applyOps(
      buildScene(registry),
      [{ op: "remove-entity", id: "child" }],
      registry,
    );
    expect(result.removedEntities).toEqual(new Set(["child", "grandchild"]));
    expect(result.changedEntities).toEqual(new Set());
    expect(result.addedEntities).toEqual(new Set());
  });

  it("an entity added then changed in one batch appears in addedEntities only", () => {
    const registry = setup();
    const ops: Op[] = [
      {
        op: "add-entity",
        id: "lamp",
        entity: { name: "Lamp", parent: "root", tags: [], components: {} },
      },
      { op: "rename", id: "lamp", name: "Street Lamp" },
      { op: "set-component", id: "lamp", component: "transform", data: {} },
    ];
    const result = applyOps(buildScene(registry), ops, registry);
    expect(result.addedEntities).toEqual(new Set(["lamp"]));
    expect(result.changedEntities).toEqual(new Set());
    expect(result.changedComponents).toEqual(new Map());
  });

  it("an entity added then removed in one batch appears in neither set", () => {
    const registry = setup();
    const ops: Op[] = [
      {
        op: "add-entity",
        id: "lamp",
        entity: { name: "Lamp", parent: "root", tags: [], components: {} },
      },
      { op: "set-component", id: "lamp", component: "transform", data: {} },
      { op: "remove-entity", id: "lamp" },
    ];
    const result = applyOps(buildScene(registry), ops, registry);
    expect(result.addedEntities).toEqual(new Set());
    expect(result.changedEntities).toEqual(new Set());
    expect(result.removedEntities).toEqual(new Set());
    expect(result.changedComponents).toEqual(new Map());
  });

  it("an entity removed then re-added in one batch counts as changed only", () => {
    const registry = setup();
    const ops: Op[] = [
      { op: "remove-entity", id: "grandchild" },
      {
        op: "add-entity",
        id: "grandchild",
        entity: { name: "Grandchild v2", parent: "root", tags: [], components: {} },
      },
    ];
    const result = applyOps(buildScene(registry), ops, registry);
    expect(result.changedEntities).toEqual(new Set(["grandchild"]));
    expect(result.addedEntities).toEqual(new Set());
    expect(result.removedEntities).toEqual(new Set());
  });

  it("component changes made before a removal are dropped from changedComponents", () => {
    const registry = setup();
    const ops: Op[] = [
      { op: "set-component", id: "grandchild", component: "transform", data: {} },
      { op: "remove-entity", id: "grandchild" },
    ];
    const result = applyOps(buildScene(registry), ops, registry);
    expect(result.removedEntities).toEqual(new Set(["grandchild"]));
    expect(result.changedEntities).toEqual(new Set());
    expect(result.changedComponents).toEqual(new Map());
  });
});
