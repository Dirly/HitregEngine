import { describe, expect, it } from "vitest";
import {
  bridgeSpanEntities,
  bridgeSpanFeatureId,
  bridgeSpanSchema,
  defaultWorldRecipe,
  voxelRecipeAssetRefs,
  worldRecipeSchema,
  type ChunkDoc,
  type WorldRecipe,
} from "../src/index.js";

const solved = {
  kind: "arch" as const,
  style: "gnawspur" as const,
  heading: 0,
  origin: [0, 40, 0] as [number, number, number],
  span: 24,
  deckY: 40,
  pieces: [
    { prefab: "bridges/gnawspur-w12-bay-deck", role: "bay-deck", position: [10, 33.4, 5] as [number, number, number], yaw: 0 },
    { prefab: "bridges/gnawspur-w12-bay-deck", role: "bay-deck", position: [70, 33.4, 5] as [number, number, number], yaw: 0 },
    { prefab: "bridges/gnawspur-w12-abut", role: "abut", position: [-1, 33.4, 5] as [number, number, number], yaw: 180 },
  ],
  profile: [[0, 40], [24, 40]] as [number, number][],
  derived: { patches: ["bs-gorge-a", "bs-gorge-b"], clearing: "bs-gorge" },
  ground: 12.5,
};

describe("bridge spans", () => {
  it("defaults an arch span between two ground anchors", () => {
    const doc = bridgeSpanSchema.parse({ id: "gorge", a: { at: [0, 0] }, b: { at: [60, 0] } });
    expect(doc.kind).toBe("arch");
    expect(doc.style).toBe("gnawspur");
    expect(doc.a.y).toBe("ground");
    expect(doc.tiers).toBe("auto");
    expect(doc.seat).toBe("pad");
    expect(doc.sag).toBeCloseTo(0.035);
    expect(bridgeSpanFeatureId("gorge")).toBe("bs-gorge");
  });

  it("rejects a bay width the kit does not build and a bad id", () => {
    expect(bridgeSpanSchema.safeParse({ id: "x", a: { at: [0, 0] }, b: { at: [9, 0] }, bay: 9 }).success).toBe(false);
    expect(bridgeSpanSchema.safeParse({ id: "Gorge", a: { at: [0, 0] }, b: { at: [9, 0] } }).success).toBe(false);
  });

  it("is recipe data that survives a parse", () => {
    const recipe = worldRecipeSchema.parse({
      ...defaultWorldRecipe(),
      features: { ...defaultWorldRecipe().features, bridgeSpans: [{ id: "gorge", a: { at: [0, 0], y: 40 }, b: { at: [24, 0], y: 40 }, solved }] },
    });
    expect(recipe.features.bridgeSpans?.[0]?.solved?.pieces).toHaveLength(3);
    expect(recipe.features.bridgeSpans?.[0]?.solved?.piers).toEqual([]);
  });

  it("emits each fitted piece in the cell its origin stands in, as a prefab instance", () => {
    const doc = bridgeSpanSchema.parse({ id: "gorge", a: { at: [0, 0] }, b: { at: [24, 0] }, solved });
    const cell0: ChunkDoc["entities"] = {};
    bridgeSpanEntities([doc], 64, 0, 0, cell0);
    expect(Object.keys(cell0).sort()).toEqual(["bs_gorge_0"]);
    expect(cell0["bs_gorge_0"]!.components["prefab"]).toMatchObject({ prefabId: "bridges/gnawspur-w12-bay-deck" });
    expect(cell0["bs_gorge_0"]!.components["transform"]).toMatchObject({ position: [10, 33.4, 5] });
    const cell1: ChunkDoc["entities"] = {};
    bridgeSpanEntities([doc], 64, 1, 0, cell1);
    expect(cell1["bs_gorge_1"]!.components["transform"]).toMatchObject({ position: [6, 33.4, 5] });
    const west: ChunkDoc["entities"] = {};
    bridgeSpanEntities([doc], 64, -1, 0, west);
    const rot = (west["bs_gorge_2"]!.components["transform"] as { rotation: number[] }).rotation;
    expect(rot[1]).toBeCloseTo(1);
    // a host without the prefab drops it; an unfitted span emits nothing
    const none: ChunkDoc["entities"] = {};
    bridgeSpanEntities([doc], 64, 0, 0, none, () => false);
    bridgeSpanEntities([bridgeSpanSchema.parse({ id: "raw", a: { at: [0, 0] }, b: { at: [9, 0] } })], 64, 0, 0, none);
    expect(none).toEqual({});
  });

  it("lists its pieces among the assets a worker host must answer for", () => {
    const recipe = { scatter: [], features: { pois: [], bridgeSpans: [{ id: "gorge", solved }] } } as unknown as WorldRecipe;
    expect(voxelRecipeAssetRefs(recipe).map((r) => `${r.kind}:${r.id}`).sort()).toEqual(["prefab:bridges/gnawspur-w12-abut", "prefab:bridges/gnawspur-w12-bay-deck"]);
  });
});
