import { describe, expect, it } from "vitest";
import { createSheet, MemoryPlayerDataBackend } from "@hitreg/core";
import { PlayerStore } from "../src/index.js";

describe("PlayerStore records", () => {
  it("saves quests, NPC memory and the vault beside the sheet, and merges partial commits", async () => {
    const store = new PlayerStore(new MemoryPlayerDataBackend(), "exp");
    const quests = { version: 1, tracked: "landfall", quests: { landfall: { status: "ready", progress: { a: 1 } } } };
    const npc = { met: { "warden-oswin": 2 }, flags: { "heard-crates": true } };
    await store.commit("p1", { sheet: createSheet(), records: { quests, npc }, scene: "mmo", position: [1, 2, 3], yaw: 0 });
    // a later commit that only carries the vault keeps the rest
    await store.commit("p1", { sheet: undefined, records: { vault: { capacity: 24, coins: 500, items: [] } }, scene: "mmo", position: null, yaw: 0 });
    const save = await store.load("p1", "mmo");
    expect(save.records).toEqual({ quests, npc, vault: { capacity: 24, coins: 500, items: [] } });
    expect(save.sheet).not.toBeNull();
    expect((await store.load("nobody", "mmo")).records).toEqual({});
  });
});
