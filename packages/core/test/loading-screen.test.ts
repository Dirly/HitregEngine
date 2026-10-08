import { describe, expect, it } from "vitest";
import { applyOps, ComponentRegistry, createScene, loadingScreenOf, registerCoreComponents } from "../src/index.js";

const registry = new ComponentRegistry();
registerCoreComponents(registry);

describe("loadingScreen component", () => {
  it("is registered, validates its image path and undoes", () => {
    let doc = applyOps(createScene("deeps"), [{ op: "add-entity", id: "sky", entity: { name: "Sky", parent: null, tags: [], components: {} } }], registry).doc;
    expect(() =>
      applyOps(doc, [{ op: "set-component", id: "sky", component: "loadingScreen", data: { image: "textures/x.png" } }], registry),
    ).toThrow();
    const set = applyOps(
      doc,
      [{ op: "set-component", id: "sky", component: "loadingScreen", data: { image: "loading/deeps.png", title: "The Deeps" } }],
      registry,
    );
    expect(loadingScreenOf(set.doc)).toEqual({ image: "loading/deeps.png", title: "The Deeps", entity: "sky" });
    doc = applyOps(set.doc, set.inverse, registry).doc;
    expect(loadingScreenOf(doc)).toBeNull();
  });

  it("skips an invalid entry and reads none from an empty doc", () => {
    expect(loadingScreenOf(null)).toBeNull();
    const doc = createScene("x");
    doc.entities["a"] = { name: "a", parent: null, tags: [], components: { loadingScreen: { image: 3 } } };
    doc.entities["b"] = { name: "b", parent: null, tags: [], components: { loadingScreen: { image: "loading/x.webp" } } };
    expect(loadingScreenOf(doc)?.entity).toBe("b");
  });
});
