import { describe, expect, it } from "vitest";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  diffSceneDocs,
  registerCoreComponents,
  SceneStore,
  type EntityDoc,
  type Op,
  type SceneDoc,
} from "../src/index.js";

function setup() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  return registry;
}

function entity(partial: Partial<EntityDoc> & { name: string }): EntityDoc {
  return { parent: null, tags: [], components: {}, ...partial };
}

function doc(entities: Record<string, EntityDoc>): SceneDoc {
  return { version: 1, name: "test", entities };
}

/** Diff, apply to `current`, and assert the result deep-equals `incoming`. */
function assertConverges(
  registry: ComponentRegistry,
  current: SceneDoc,
  incoming: SceneDoc,
): Op[] {
  const ops = diffSceneDocs(current, incoming);
  const { doc: result } = applyOps(current, ops, registry);
  expect(result.entities).toEqual(incoming.entities);
  return ops;
}

describe("diffSceneDocs", () => {
  it("returns [] for identical docs", () => {
    const registry = setup();
    const base = doc({
      root: entity({ name: "Root" }),
      child: entity({ name: "Child", parent: "root", components: { transform: {} } }),
    });
    const { doc: current } = applyOps(createScene("test"), diffSceneDocs(createScene("test"), base), registry);
    expect(diffSceneDocs(current, structuredClone(current))).toEqual([]);
  });

  it("adds new entities, parent before child when both are new", () => {
    const registry = setup();
    const current = doc({ root: entity({ name: "Root" }) });
    const incoming = doc({
      root: entity({ name: "Root" }),
      // deliberately listed child-first: topological order must fix it
      leaf: entity({ name: "Leaf", parent: "branch" }),
      branch: entity({ name: "Branch", parent: "root" }),
    });
    const ops = assertConverges(registry, current, incoming);
    expect(ops.every((op) => op.op === "add-entity")).toBe(true);
    const order = ops.map((op) => op.id);
    expect(order.indexOf("branch")).toBeLessThan(order.indexOf("leaf"));
  });

  it("emits rename, set-tags, set-component, and remove-component for survivors", () => {
    const registry = setup();
    const current = doc({
      a: entity({
        name: "Old",
        tags: ["x", "y"],
        components: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          light: { kind: "point", color: "#ffffff", intensity: 1 },
        },
      }),
    });
    const incoming = doc({
      a: entity({
        name: "New",
        tags: ["y", "x"], // order-sensitive: this must produce set-tags
        components: {
          transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      }),
    });
    const ops = assertConverges(registry, current, incoming);
    expect(ops.map((op) => op.op).sort()).toEqual([
      "remove-component",
      "rename",
      "set-component",
      "set-tags",
    ]);
  });

  it("does not emit set-component when component JSON is unchanged", () => {
    const registry = setup();
    const current = doc({
      a: entity({ name: "A", components: { transform: { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } }),
    });
    const incoming = structuredClone(current);
    incoming.entities["a"]!.name = "B";
    const ops = assertConverges(registry, current, incoming);
    expect(ops).toEqual([{ op: "rename", id: "a", name: "B" }]);
  });

  it("reparents survivors whose parent changed", () => {
    const registry = setup();
    const current = doc({
      a: entity({ name: "A" }),
      b: entity({ name: "B" }),
      c: entity({ name: "C", parent: "a" }),
    });
    const incoming = structuredClone(current);
    incoming.entities["c"]!.parent = "b";
    const ops = assertConverges(registry, current, incoming);
    expect(ops).toEqual([{ op: "reparent", id: "c", parent: "b" }]);
  });

  it("orders reparents so a parent/child swap does not transiently cycle", () => {
    const registry = setup();
    // current: a -> null, b under a; incoming: b -> null, a under b
    const current = doc({
      a: entity({ name: "A" }),
      b: entity({ name: "B", parent: "a" }),
    });
    const incoming = doc({
      a: entity({ name: "A", parent: "b" }),
      b: entity({ name: "B" }),
    });
    assertConverges(registry, current, incoming);
  });

  it("removes only the roots of vanished subtrees (cascade covers the rest)", () => {
    const registry = setup();
    const current = doc({
      keep: entity({ name: "Keep" }),
      top: entity({ name: "Top" }),
      mid: entity({ name: "Mid", parent: "top" }),
      leaf: entity({ name: "Leaf", parent: "mid" }),
      other: entity({ name: "Other", parent: "keep" }),
    });
    const incoming = doc({
      keep: entity({ name: "Keep" }),
      other: entity({ name: "Other", parent: "keep" }),
    });
    const ops = assertConverges(registry, current, incoming);
    expect(ops).toEqual([{ op: "remove-entity", id: "top" }]);
  });

  it("removes disjoint vanished subtrees as separate roots", () => {
    const registry = setup();
    const current = doc({
      keep: entity({ name: "Keep" }),
      goneA: entity({ name: "GoneA" }),
      goneAChild: entity({ name: "GoneAChild", parent: "goneA" }),
      goneB: entity({ name: "GoneB", parent: "keep" }),
    });
    const incoming = doc({ keep: entity({ name: "Keep" }) });
    const ops = assertConverges(registry, current, incoming);
    const removed = ops.filter((op) => op.op === "remove-entity").map((op) => op.id);
    expect(removed.sort()).toEqual(["goneA", "goneB"]);
  });

  it("reparents a survivor out of a vanished subtree before the cascade", () => {
    const registry = setup();
    const current = doc({
      root: entity({ name: "Root" }),
      doomed: entity({ name: "Doomed", parent: "root" }),
      escapee: entity({ name: "Escapee", parent: "doomed" }),
      doomedLeaf: entity({ name: "DoomedLeaf", parent: "escapee" }),
    });
    const incoming = doc({
      root: entity({ name: "Root" }),
      escapee: entity({ name: "Escapee", parent: "root" }),
    });
    const ops = assertConverges(registry, current, incoming);
    // the reparent must precede the removal, or the cascade eats the escapee
    const reparentIdx = ops.findIndex((op) => op.op === "reparent");
    const removeIdx = ops.findIndex((op) => op.op === "remove-entity");
    expect(reparentIdx).toBeGreaterThanOrEqual(0);
    expect(reparentIdx).toBeLessThan(removeIdx);
  });

  it("handles a survivor reparented under a freshly added entity", () => {
    const registry = setup();
    const current = doc({
      a: entity({ name: "A" }),
      b: entity({ name: "B", parent: "a" }),
    });
    const incoming = doc({
      a: entity({ name: "A" }),
      group: entity({ name: "Group", parent: "a" }),
      b: entity({ name: "B", parent: "group" }),
    });
    assertConverges(registry, current, incoming);
  });
});

// -- randomized equivalence sweep ---------------------------------------------

/** Deterministic LCG so failures reproduce (no Math.random in tests). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function buildBaseDoc(
  registry: ComponentRegistry,
  rand: () => number,
): SceneDoc {
  const ops: Op[] = [];
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    const id = `e${i}`;
    const parent = ids.length > 0 && rand() < 0.7 ? pick(rand, ids) : null;
    const components: Record<string, unknown> =
      rand() < 0.6 ? { transform: { position: [i, 0, 0] } } : {};
    ops.push({
      op: "add-entity",
      id,
      entity: {
        name: `Entity ${i}`,
        parent,
        tags: rand() < 0.3 ? ["tagged"] : [],
        components,
      },
    });
    ids.push(id);
  }
  return applyOps(createScene("sweep"), ops, registry).doc;
}

function mutate(
  registry: ComponentRegistry,
  base: SceneDoc,
  rand: () => number,
): SceneDoc {
  let current = base;
  let nextId = 0;
  const mutations = 30;
  for (let i = 0; i < mutations; i++) {
    const ids = Object.keys(current.entities);
    if (ids.length === 0) break;
    const kind = Math.floor(rand() * 7);
    const id = pick(rand, ids);
    let op: Op;
    switch (kind) {
      case 0:
        op = {
          op: "add-entity",
          id: `n${nextId++}`,
          entity: {
            name: `Added ${nextId}`,
            parent: rand() < 0.5 ? id : null,
            tags: [],
            components: rand() < 0.5 ? { transform: {} } : {},
          },
        };
        break;
      case 1:
        op = { op: "remove-entity", id };
        break;
      case 2:
        op = { op: "rename", id, name: `Renamed ${i}` };
        break;
      case 3:
        op = { op: "set-tags", id, tags: rand() < 0.5 ? ["a", "b"] : [] };
        break;
      case 4:
        op = {
          op: "set-component",
          id,
          component: "transform",
          data: { position: [rand() * 10, rand() * 10, rand() * 10] },
        };
        break;
      case 5:
        op = { op: "remove-component", id, component: "transform" };
        break;
      default:
        op = {
          op: "reparent",
          id,
          parent: rand() < 0.2 ? null : pick(rand, ids),
        };
        break;
    }
    try {
      current = applyOps(current, [op], registry).doc;
    } catch {
      // invalid random op (cycle, missing component, ...): skip it
    }
  }
  return current;
}

describe("diffSceneDocs randomized equivalence", () => {
  it("applyOps(current, diff(current, incoming)) always converges to incoming", () => {
    const registry = setup();
    for (let seed = 1; seed <= 8; seed++) {
      const rand = lcg(seed * 0x9e3779b9);
      const current = buildBaseDoc(registry, rand);
      const incoming = mutate(registry, current, rand);
      const ops = diffSceneDocs(current, incoming);
      const { doc: result } = applyOps(current, ops, registry);
      expect(result.entities, `seed ${seed}`).toEqual(incoming.entities);
    }
  });
});

describe("diffSceneDocs undo roundtrip", () => {
  it("store.apply(diff ops) then undo restores the original entities", () => {
    const registry = setup();
    const rand = lcg(0xdecafbad);
    const original = buildBaseDoc(registry, rand);
    const incoming = mutate(registry, original, rand);
    const store = new SceneStore(structuredClone(original), registry);
    store.apply(diffSceneDocs(store.doc, incoming));
    expect(store.doc.entities).toEqual(incoming.entities);
    store.undo();
    expect(store.doc.entities).toEqual(original.entities);
  });
});
