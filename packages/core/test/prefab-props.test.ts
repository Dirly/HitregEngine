import { describe, expect, it } from "vitest";
import {
  AssetLibrary,
  describePrefab,
  inferPropKind,
  registerCoreAssetTypes,
  validatePrefab,
  type PrefabDoc,
} from "../src/index.js";

/**
 * Prefab props are the tweakable surface of anything generated — the knobs a
 * human turns after an agent one-shots a thing. These tests pin the two
 * guarantees that make that work: a declaration always resolves to exactly one
 * control kind, and a malformed knob fails loudly at authoring time.
 */

function rifle(props: PrefabDoc["props"]): PrefabDoc {
  return {
    version: 1,
    name: "Rifle",
    root: "body",
    entities: {
      body: {
        name: "Body",
        parent: null,
        tags: ["weapon"],
        components: { transform: {}, script: { name: "gun", params: { rpm: 600 } } },
      },
      muzzle: {
        name: "Muzzle",
        parent: "body",
        tags: [],
        components: { transform: {}, light: { kind: "point", intensity: 0 } },
      },
    },
    props,
  };
}

describe("prop kind inference", () => {
  it("reads the control kind off the default value", () => {
    expect(inferPropKind({ default: 3 })).toBe("number");
    expect(inferPropKind({ default: true })).toBe("boolean");
    expect(inferPropKind({ default: "burst" })).toBe("string");
    expect(inferPropKind({ default: "#ffcc88" })).toBe("color");
    expect(inferPropKind({ default: [0, 1, 0] })).toBe("vec3");
    expect(inferPropKind({ default: { a: 1 } })).toBe("json");
  });

  it("lets options and assetKind imply their control, and an explicit kind win", () => {
    expect(inferPropKind({ default: "burst", options: ["auto", "burst"] })).toBe("enum");
    expect(inferPropKind({ default: "steel", assetKind: "material" })).toBe("asset");
    // a number that is really a preset id: declaring kind overrides inference
    expect(inferPropKind({ default: 2, kind: "enum", options: [1, 2, 3] })).toBe("enum");
  });
});

describe("knob validation", () => {
  it("accepts a fully-declared knob", () => {
    expect(() =>
      validatePrefab(
        rifle({
          rpm: {
            default: 600,
            bindings: ["body/components/script/params/rpm"],
            label: "Rate of fire",
            group: "Handling",
            min: 60,
            max: 1200,
            step: 10,
            unit: "rpm",
            description: "Rounds per minute.",
          },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects a default outside its declared range", () => {
    expect(() =>
      validatePrefab(rifle({ rpm: { default: 5000, bindings: [], min: 60, max: 1200 } })),
    ).toThrow(/above max/);
    expect(() =>
      validatePrefab(rifle({ rpm: { default: 10, bindings: [], min: 60, max: 1200 } })),
    ).toThrow(/below min/);
  });

  it("rejects an inverted range", () => {
    expect(() =>
      validatePrefab(rifle({ rpm: { default: 600, bindings: [], min: 1200, max: 60 } })),
    ).toThrow(/is above max/);
  });

  it("rejects an enum default that is not one of its options", () => {
    expect(() =>
      validatePrefab(rifle({ mode: { default: "safety", bindings: [], options: ["auto", "burst"] } })),
    ).toThrow(/not one of options/);
  });

  it("rejects a binding that names no local entity", () => {
    expect(() =>
      validatePrefab(rifle({ glow: { default: 1, bindings: ["scope/components/light/intensity"] } })),
    ).toThrow(/does not start with a local entity id/);
  });

  it("still accepts the original untyped prop shape", () => {
    expect(() =>
      validatePrefab(rifle({ glow: { default: 1, bindings: ["muzzle/components/light/intensity"] } })),
    ).not.toThrow();
  });
});

describe("describePrefab", () => {
  const doc = rifle({
    rpm: {
      default: 600,
      bindings: ["body/components/script/params/rpm"],
      group: "Handling",
      min: 60,
      max: 1200,
      unit: "rpm",
      label: "Rate of fire",
    },
    muzzleGlow: {
      default: 2,
      bindings: ["muzzle/components/light/intensity"],
      group: "Look",
      min: 0,
      max: 10,
    },
    tint: { default: "#ffcc88", bindings: [] },
  });

  it("flattens the definition into parts, depth-first from the root", () => {
    const spec = describePrefab(doc);
    expect(spec.parts).toEqual([
      {
        id: "body",
        name: "Body",
        parent: null,
        depth: 0,
        tags: ["weapon"],
        components: ["transform", "script"],
      },
      {
        id: "muzzle",
        name: "Muzzle",
        parent: "body",
        depth: 1,
        tags: [],
        components: ["transform", "light"],
      },
    ]);
  });

  it("resolves every knob's kind and label, and groups them", () => {
    const spec = describePrefab(doc);
    const byName = Object.fromEntries(spec.props.map((p) => [p.name, p]));
    expect(byName["rpm"]).toMatchObject({ kind: "number", label: "Rate of fire", unit: "rpm" });
    expect(byName["tint"]).toMatchObject({ kind: "color", label: "tint" });
    // ungrouped knobs sort first; the rest follow in group order
    expect(spec.groups).toEqual(["", "Handling", "Look"]);
    expect(spec.props[0]!.name).toBe("tint");
  });

  it("surfaces every prefab's knobs through the asset library", () => {
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    assets.addPrefab("rifle", doc);
    const specs = assets.prefabSpecs();
    expect(Object.keys(specs)).toEqual(["rifle"]);
    expect(specs["rifle"]!.props.map((p) => p.name).sort()).toEqual([
      "muzzleGlow",
      "rpm",
      "tint",
    ]);
  });
});
