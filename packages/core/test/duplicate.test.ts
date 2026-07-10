import { describe, expect, it } from "vitest";
import {
  applyOps,
  ComponentRegistry,
  createScene,
  duplicateSubtree,
  registerCoreComponents,
} from "../src/index.js";

describe("duplicateSubtree", () => {
  it("copies the subtree with fresh ids under the same parent", () => {
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    const { doc } = applyOps(
      createScene("s"),
      [
        {
          op: "add-entity",
          id: "parent",
          entity: { name: "Parent", parent: null, tags: [], components: { transform: {} } },
        },
        {
          op: "add-entity",
          id: "child",
          entity: { name: "Child", parent: "parent", tags: ["x"], components: {} },
        },
      ],
      registry,
    );

    const ops = duplicateSubtree(doc, "parent");
    expect(ops).toHaveLength(2);
    const { doc: next } = applyOps(doc, ops, registry);

    expect(Object.keys(next.entities)).toHaveLength(4);
    const copyRootId = (ops[0] as { id: string }).id;
    expect(copyRootId).not.toBe("parent");
    expect(next.entities[copyRootId]!.name).toBe("Parent Copy");
    const copyChildId = (ops[1] as { id: string }).id;
    expect(next.entities[copyChildId]!.parent).toBe(copyRootId);
    expect(next.entities[copyChildId]!.tags).toEqual(["x"]);
  });
});
