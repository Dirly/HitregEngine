import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AssetLibrary } from "../src/index.js";

const weaponStats = z.object({
  damage: z.number().min(0),
  fireRate: z.number().positive().default(2),
  magazineSize: z.number().int().positive().default(12),
});

describe("AssetLibrary data assets (ScriptableObjects)", () => {
  it("validates assets against their declared type schema", () => {
    const assets = new AssetLibrary();
    assets.defineDataType("weapon-stats", weaponStats);

    const stored = assets.addDataAsset({
      id: "pistol",
      type: "weapon-stats",
      name: "Pistol",
      data: { damage: 10 },
    });
    // defaults normalized in
    expect(stored.data).toEqual({ damage: 10, fireRate: 2, magazineSize: 12 });

    expect(() =>
      assets.addDataAsset({
        id: "broken",
        type: "weapon-stats",
        name: "Broken",
        data: { damage: -1 },
      }),
    ).toThrow(/damage/);

    expect(() =>
      assets.addDataAsset({ id: "x", type: "loot-table", name: "X", data: {} }),
    ).toThrow(/unknown data type/);
  });

  it("shared-reference semantics: updates are visible through the GUID", () => {
    const assets = new AssetLibrary();
    assets.defineDataType("weapon-stats", weaponStats);
    assets.addDataAsset({
      id: "pistol",
      type: "weapon-stats",
      name: "Pistol",
      data: { damage: 10 },
    });

    assets.updateDataAsset({
      id: "pistol",
      type: "weapon-stats",
      name: "Pistol",
      data: { damage: 14, fireRate: 3 },
    });

    expect(assets.getDataAsset("pistol")!.data).toMatchObject({ damage: 14, fireRate: 3 });
    expect(assets.dataAssetsOfType("weapon-stats")).toHaveLength(1);
  });

  it("exports JSON Schema per data type for the AI spec", () => {
    const assets = new AssetLibrary();
    assets.defineDataType("weapon-stats", weaponStats);
    const schemas = assets.dataTypeJsonSchemas();
    const ws = schemas["weapon-stats"] as { properties: Record<string, unknown> };
    expect(ws.properties).toHaveProperty("damage");
  });
});
