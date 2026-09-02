import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AssetLibrary,
  ComponentRegistry,
  EventRegistry,
  NetStateStore,
  ToolRegistry,
  buildEngineSpec,
  registerChunkComponents,
  registerCoreAssetTypes,
  registerCoreComponents,
  registerCoreEvents,
  ENGINE_SPEC_VERSION,
} from "../src/index.js";

function engineRegistries() {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  registerChunkComponents(registry);
  const events = new EventRegistry();
  registerCoreEvents(events);
  const assets = new AssetLibrary();
  registerCoreAssetTypes(assets);
  return { registry, events, assets };
}

describe("buildEngineSpec", () => {
  it("emits the full schema surface from the registries", () => {
    const { registry, events, assets } = engineRegistries();
    const spec = buildEngineSpec({ registry, events, assets });

    expect(spec.version).toBe(ENGINE_SPEC_VERSION);
    // every registered component appears with a JSON Schema
    for (const name of registry.names()) {
      expect(spec.components[name]).toBeTruthy();
    }
    expect(spec.components["mesh"]).toBeTruthy();
    expect(spec.components["chunkStreamer"]).toBeTruthy(); // chunk components included
    // data-asset types + events flow through
    expect(spec.dataAssets["material"]).toBeTruthy();
    expect(Object.keys(spec.events).length).toBeGreaterThan(0);
    // the ops vocabulary is present and complete
    expect(spec.ops.map((o) => o.op)).toEqual([
      "add-entity",
      "remove-entity",
      "reparent",
      "rename",
      "set-tags",
      "set-locked",
      "set-component",
      "remove-component",
    ]);
  });

  it("cannot drift: a newly registered component shows up automatically", () => {
    const { registry, events, assets } = engineRegistries();
    const before = buildEngineSpec({ registry, events, assets });
    expect(before.components["turret"]).toBeUndefined();

    registry.register("turret", z.object({ range: z.number().default(10) }));
    const after = buildEngineSpec({ registry, events, assets });
    expect(after.components["turret"]).toBeTruthy();
  });

  it("includes net-state, scripts, and prefabs when provided; empty when not", () => {
    const { registry } = engineRegistries();
    const bare = buildEngineSpec({ registry });
    expect(bare.dataAssets).toEqual({});
    expect(bare.events).toEqual({});
    expect(bare.netState).toEqual({});
    expect(bare.scripts).toEqual({});
    expect(bare.tools).toEqual({});
    expect(bare.prefabs).toEqual({});

    const netState = new NetStateStore();
    netState.define("enemyHp", z.object({ hp: z.number() }));
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets);
    assets.addPrefab("lamp", {
      version: 1,
      name: "Lamp",
      root: "r",
      entities: { r: { name: "Lamp", parent: null, tags: [], components: {} } },
      props: {},
    });
    const spec = buildEngineSpec({
      registry,
      assets,
      netState,
      scripts: { spinner: { speed: { type: "number", default: 1 } } },
    });
    expect(spec.netState["enemyHp"]).toBeTruthy();
    expect(spec.scripts["spinner"]).toBeTruthy();
    expect(Object.keys(spec.prefabs)).toEqual(["lamp"]);
    expect(spec.prefabs["lamp"]!.name).toBe("Lamp");
    expect(spec.prefabs["lamp"]!.parts).toEqual([
      { id: "r", name: "Lamp", parent: null, depth: 0, tags: [], components: [] },
    ]);
  });

  it("includes registered editor tools and their invocation schemas", () => {
    const { registry } = engineRegistries();
    const tools = new ToolRegistry();
    tools.register({
      version: 1,
      id: "hitreg.test-tool",
      name: "Test tool",
      description: "Exercises the generated tool surface.",
      category: "Tests",
      surfaces: ["tools"],
      permissions: [],
      inputs: {
        count: { kind: "number", label: "Count", integer: true, min: 1, default: 2 },
      },
    });

    const spec = buildEngineSpec({ registry, tools });
    expect(spec.tools["hitreg.test-tool"]?.name).toBe("Test tool");
    expect(spec.tools["hitreg.test-tool"]?.inputSchema).toMatchObject({ type: "object" });
  });
});
