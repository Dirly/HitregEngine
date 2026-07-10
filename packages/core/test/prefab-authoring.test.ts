import { describe, expect, it } from "vitest";
import {
  applyOps,
  AssetLibrary,
  ComponentRegistry,
  createScene,
  expandScene,
  prefabFromSubtree,
  registerCoreComponents,
} from "../src/index.js";

describe("prefabFromSubtree", () => {
  it("converts a subtree to a prefab and replaces it with an instance", () => {
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    const assets = new AssetLibrary();

    const { doc } = applyOps(
      createScene("s"),
      [
        {
          op: "add-entity",
          id: "tower",
          entity: {
            name: "Tower",
            parent: null,
            tags: ["building"],
            components: { transform: { position: [3, 0, 0] } },
          },
        },
        {
          op: "add-entity",
          id: "beacon",
          entity: {
            name: "Beacon",
            parent: "tower",
            tags: [],
            components: {
              transform: { position: [0, 5, 0] },
              light: { kind: "point", color: "#ff0000" },
            },
          },
        },
      ],
      registry,
    );

    const { prefab, replaceOps } = prefabFromSubtree(doc, "tower", "prefab-tower");
    expect(prefab.root).toBe("tower");
    expect(prefab.entities["tower"]!.parent).toBeNull();
    expect(prefab.entities["beacon"]!.parent).toBe("tower");

    assets.addPrefab("prefab-tower", prefab);
    const { doc: next } = applyOps(doc, replaceOps, registry);

    // instance kept id, name, tags, transform
    const instance = next.entities["tower"]!;
    expect(instance.components["prefab"]).toMatchObject({ prefabId: "prefab-tower" });
    expect(instance.components["transform"]).toMatchObject({ position: [3, 0, 0] });
    expect(instance.tags).toEqual(["building"]);
    // original child is gone from the doc (lives in the prefab now)
    expect(next.entities["beacon"]).toBeUndefined();

    // expansion reproduces the original shape
    const expanded = expandScene(next, assets, registry);
    expect(expanded.entities["tower:beacon"]!.components["light"]).toMatchObject({
      color: "#ff0000",
    });
    expect(expanded.entities["tower:beacon"]!.parent).toBe("tower");
  });

  it("refuses to prefab an existing prefab instance", () => {
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    const { doc } = applyOps(
      createScene("s"),
      [
        {
          op: "add-entity",
          id: "x",
          entity: {
            name: "X",
            parent: null,
            tags: [],
            components: { prefab: { prefabId: "whatever" } },
          },
        },
      ],
      registry,
    );
    expect(() => prefabFromSubtree(doc, "x", "p")).toThrow(/already a prefab/);
  });
});
