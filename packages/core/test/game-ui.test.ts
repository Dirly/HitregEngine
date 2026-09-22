import { describe, expect, it } from "vitest";
import { advanceQuest, bearing, bearingDelta, nearbyTowns, questSchema, questJournalSchema, itemSchema, createSheet, addItem, equip, unequip, gridOf, gameHudSchema } from "../src/index.js";

describe("MMO navigation and quest contracts", () => {
  it("wraps bearings across north and excludes distant towns", () => {
    expect(bearing(0, -20)).toBe(0); expect(bearing(20, 0)).toBe(90);
    expect(bearingDelta(5, 355)).toBe(10); expect(bearingDelta(355, 5)).toBe(-10);
    expect(nearbyTowns([{ center: [3, 4] as const }, { center: [20, 0] as const }], 0, 0, 5)).toHaveLength(1);
  });
  it("completes only after all objectives and cannot complete twice", () => {
    const quest = questSchema.parse({ id: "q", title: "Q", description: "", area: { label: "Hills", center: [0, 0], radius: 100 }, objectives: [{ id: "a", label: "Ore", kind: "collect", required: 2 }, { id: "b", label: "Visit", kind: "visit" }] });
    let state = questJournalSchema.parse({ tracked: "q", quests: { q: { status: "active", progress: {} } } });
    state = advanceQuest(state, quest, "a", 50); expect(state.quests.q?.progress.a).toBe(2); expect(state.quests.q?.status).toBe("active");
    state = advanceQuest(state, quest, "b"); expect(state.quests.q?.status).toBe("complete"); expect(state.tracked).toBeNull();
    expect(advanceQuest(state, quest, "a")).toBe(state);
  });
  it("rejects quest minimap markers and exact waypoint policies", () => {
    const base = { frames: Object.fromEntries(["panel", "slot", "button"].map(k => [k, { texture: "frame.png", slice: 8, border: 8 }])), equipmentSlots: ["helm"], icons: {}, sounds: Object.fromEntries(["hover", "click", "open", "close", "equip", "unequip", "drop", "error", "quest"].map(k => [k, "sound.mp3"])) };
    expect(gameHudSchema.safeParse(base).success).toBe(true);
    expect(gameHudSchema.safeParse({ ...base, navigation: { questGuidance: "minimap" } }).success).toBe(false);
    expect(gameHudSchema.safeParse({ ...base, navigation: { mapMarkers: ["player", "town", "quest"] } }).success).toBe(false);
  });
  it("equips a consumable stack and keeps pockets without a bag", () => {
    const potion = itemSchema.parse({ name: "Potion", kind: "consumable", slots: ["consumable"], stack: 5 });
    const env = { catalog: () => potion };
    const given = addItem(createSheet(), "potion", 3, env); expect(given.ok).toBe(true); if (!given.ok) return;
    const uid = Object.keys(given.sheet.items)[0]!;
    const worn = equip(given.sheet, uid, "consumable", env); expect(worn.ok).toBe(true); if (!worn.ok) return;
    expect(worn.sheet.items[uid]?.qty).toBe(3); expect(gridOf(worn.sheet, "bag", env)).toBeNull(); expect(gridOf(worn.sheet, "pockets", env)).not.toBeNull();
    const removed = unequip(worn.sheet, "consumable", undefined, env); expect(removed.ok).toBe(true);
  });
});
