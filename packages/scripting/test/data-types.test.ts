import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AssetLibrary, EventRegistry, registerCoreAssetTypes } from "@hitreg/core";
import { Script, ScriptRegistry } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A project-owned ScriptableObject type declared by the script that uses it.
 * Built fresh per test (and per "hot reload") because a re-executed module
 * really does hand the registry a brand-new class object.
 */
function weaponScript(opts: { name?: string; type?: string; schema?: z.ZodType } = {}) {
  const schema = opts.schema ?? z.object({ damage: z.number(), name: z.string() });
  return class WeaponScript extends Script {
    static override scriptName = opts.name ?? "Weapon";
    static override dataTypes = [{ type: opts.type ?? "weapon-stats", schema }];
  };
}

describe("ScriptRegistry data-type registration", () => {
  it("defines a script's declared data types into the asset library", () => {
    const assets = new AssetLibrary();
    const registry = new ScriptRegistry();
    registry.register(weaponScript(), undefined, assets);

    expect(Object.keys(assets.dataTypeJsonSchemas())).toContain("weapon-stats");
    const stored = assets.addDataAsset({
      id: "w1",
      type: "weapon-stats",
      name: "Pick",
      data: { damage: 7, name: "pick" },
    });
    expect(stored.data).toEqual({ damage: 7, name: "pick" });
    // the declared schema is what validates, not a rubber stamp
    expect(() =>
      assets.addDataAsset({ id: "w2", type: "weapon-stats", name: "Bad", data: { damage: "lots" } }),
    ).toThrow();
  });

  it("is idempotent across hot reloads: the same script re-declaring is a silent no-op", () => {
    const assets = new AssetLibrary();
    const registry = new ScriptRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registry.register(weaponScript(), undefined, assets);

    // project-scripts.ts re-runs reregister for EVERY script on EVERY save;
    // defineDataType throws on duplicates, so this is the path that would
    // otherwise blow up on every keystroke.
    for (let i = 0; i < 3; i++) {
      expect(() => registry.reregister(weaponScript(), undefined, assets)).not.toThrow();
    }
    expect(warn).not.toHaveBeenCalled();
    expect(registry.get("Weapon")).toBeDefined();
  });

  it("warns and skips when a DIFFERENT script claims an already-defined type", () => {
    const assets = new AssetLibrary();
    const registry = new ScriptRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    registry.register(weaponScript(), undefined, assets);
    registry.register(
      weaponScript({ name: "Impostor", schema: z.object({ totallyDifferent: z.boolean() }) }),
      undefined,
      assets,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("already defined by script");
    // first declaration still governs validation
    expect(() =>
      assets.addDataAsset({
        id: "w1",
        type: "weapon-stats",
        name: "x",
        data: { totallyDifferent: true },
      }),
    ).toThrow();
  });

  it("warns instead of throwing when the library rejects a type, and keeps going", () => {
    const assets = new AssetLibrary();
    registerCoreAssetTypes(assets); // "material" is taken by the engine
    const registry = new ScriptRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    class Clash extends Script {
      static override scriptName = "Clash";
      static override dataTypes = [
        { type: "material", schema: z.object({ nope: z.string() }) },
        { type: "loot-table", schema: z.object({ rolls: z.number() }) },
      ];
    }
    expect(() => registry.register(Clash, undefined, assets)).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    // the declaration AFTER the bad one still landed — one bad type must not
    // take out the rest of the script
    expect(Object.keys(assets.dataTypeJsonSchemas())).toContain("loot-table");
    // and the engine's own material type is untouched
    expect(() =>
      assets.addDataAsset({ id: "m", type: "material", name: "m", data: { color: "#ffffff" } }),
    ).not.toThrow();
  });

  it("stays backward compatible: existing call shapes still work", () => {
    const registry = new ScriptRegistry();
    const events = new EventRegistry();
    class Plain extends Script {
      static override scriptName = "Plain";
    }
    class Eventful extends Script {
      static override scriptName = "Eventful";
      static override events = [{ name: "npc.hit", schema: z.object({ id: z.string() }) }];
      static override dataTypes = [{ type: "unused-without-a-sink", schema: z.object({}) }];
    }
    expect(() => registry.register(Plain)).not.toThrow();
    expect(() => registry.register(Eventful, events)).not.toThrow();
    expect(events.has("npc.hit")).toBe(true);
    // no sink passed = nothing to define into; declaring a type must not throw
    expect(registry.names().sort()).toEqual(["Eventful", "Plain"]);
  });

  it("a re-registered script's data type survives a class swap under one registry", () => {
    const assets = new AssetLibrary();
    const registry = new ScriptRegistry();
    registry.register(weaponScript(), undefined, assets);
    assets.addDataAsset({ id: "w1", type: "weapon-stats", name: "Pick", data: { damage: 7, name: "pick" } });

    // hot reload with an edited schema: the LIVE schema is the first one
    // (AssetLibrary is define-once), so assets keep validating as before —
    // documented in ScriptRegistry.declareDataTypes.
    registry.reregister(
      weaponScript({ schema: z.object({ damage: z.number(), name: z.string(), tier: z.number() }) }),
      undefined,
      assets,
    );
    expect(() =>
      assets.updateDataAsset({
        id: "w1",
        type: "weapon-stats",
        name: "Pick",
        data: { damage: 9, name: "pick" },
      }),
    ).not.toThrow();
  });
});
