import { describe, expect, it } from "vitest";
import {
  acceptQuest,
  advanceQuest,
  buildEngineSpec,
  ComponentRegistry,
  conditionBlockNames,
  questBlocks,
  questJournalSchema,
  questObjectiveSchema,
  questOfferProblem,
  questSchema,
  questSource,
  migrateJournal,
  testCondition,
  turnInQuest,
  type DialogueFacts,
  type QuestJournal,
} from "../src/index.js";

const quest = (extra: Record<string, unknown>) =>
  questSchema.parse({ id: "q", title: "Q", description: "", objectives: [{ id: "a", label: "A", kind: "talk", target: "n" }], ...extra });
const empty = (): QuestJournal => questJournalSchema.parse({ quests: {} });

describe("quest block registry", () => {
  it("lists exactly the implemented blocks, and every objective kind is a registered action", () => {
    expect(questBlocks.names("source").sort()).toEqual(["auto", "npc", "object", "presence"]);
    expect(questBlocks.names("action").sort()).toEqual(["collect", "deliver", "endure", "interact", "kill", "perform", "read", "talk", "visit"]);
    expect(questBlocks.names("condition").sort()).toEqual(["clock", "coins", "flag", "item", "level", "quest", "weather"]);
    expect(questBlocks.names("consequence")).toEqual(["flag"]);
    for (const unbuilt of ["die", "status", "reveal", "spawn", "passage"])
      for (const slot of ["source", "condition", "action", "consequence"] as const) expect(questBlocks.has(slot, unbuilt)).toBe(false);
    const kinds = questObjectiveSchema.options.map((o) => o.shape.kind.value).sort();
    expect(kinds).toEqual(questBlocks.names("action").sort());
  });

  it("is emitted in the engine spec with schemas", () => {
    const spec = buildEngineSpec({ registry: new ComponentRegistry() });
    expect(Object.keys(spec.questBlocks.action)).toContain("perform");
    expect((spec.questBlocks.condition["clock"] as { scope: string }).scope).toBe("world");
    expect((spec.questBlocks.action["deliver"] as { schema: { properties: Record<string, unknown> } }).schema.properties).toHaveProperty("item");
  });

  it("refuses a duplicate registration and names conditions recursively", () => {
    expect(() => questBlocks.register({ slot: "action", name: "visit", schema: questObjectiveSchema, description: "", scope: "character" })).toThrow();
    expect([...conditionBlockNames({ clock: { from: 1, to: 2 }, any: [{ flag: "x", is: false }, { not: { item: "i", qty: 2 } }] })].sort()).toEqual(["clock", "flag", "item"]);
  });
});

describe("quest schema extensions", () => {
  it("keeps the four classic kinds valid with no new fields, and derives the source", () => {
    const q = quest({ giver: "g" });
    expect(q.objectives[0]).toMatchObject({ kind: "talk", after: [], then: [], places: "" });
    expect(questSource(q)).toEqual({ kind: "npc", ref: "g" });
    expect(questSource(quest({}))).toEqual({ kind: "auto" });
  });

  it("rejects an `after` naming a missing objective, and an unknown kind", () => {
    expect(questSchema.safeParse({ id: "q", title: "Q", description: "", objectives: [{ id: "a", label: "A", kind: "talk", after: ["zz"] }] }).success).toBe(false);
    expect(questSchema.safeParse({ id: "q", title: "Q", description: "", objectives: [{ id: "a", label: "A", kind: "die" }] }).success).toBe(false);
    expect(questSchema.safeParse({ id: "q", title: "Q", description: "", objectives: [{ id: "a", label: "A", kind: "deliver", target: "t" }] }).success).toBe(false);
  });

  it("enforces `after`: a step waits on its predecessors", () => {
    const q = quest({
      objectives: [
        { id: "a", label: "A", kind: "interact", target: "lever" },
        { id: "b", label: "B", kind: "interact", target: "door", after: ["a"] },
      ],
    });
    let j = acceptQuest(empty(), q).journal;
    expect(advanceQuest(j, q, "b")).toBe(j);
    j = advanceQuest(j, q, "a");
    j = advanceQuest(j, q, "b");
    expect(j.quests.q?.status).toBe("complete");
  });

  it("a started quest is always in the journal; a legacy `hidden` map is migrated into it", () => {
    const q = quest({ source: { kind: "object", ref: "board" } });
    const j = acceptQuest(empty(), q).journal;
    expect(j.quests.q?.status).toBe("active");
    expect(j.tracked).toBe("q");
    const legacy = questJournalSchema.parse({ quests: {}, hidden: { q: { status: "active", progress: { a: 1 } } } });
    expect(questOfferProblem(legacy, q)).toBe("already accepted");
    const migrated = migrateJournal(legacy);
    expect(migrated.quests.q?.progress.a).toBe(1);
    expect(migrated.hidden).toBeUndefined();
    expect(questSchema.parse({ id: "x", title: "X", description: "", hidden: "until-progress", objectives: [{ id: "a", label: "A", kind: "talk" }] })).not.toHaveProperty("hidden");
    expect(turnInQuest(advanceQuest(acceptQuest(empty(), quest({ turnIn: "t" })).journal, quest({ turnIn: "t" }), "a"), quest({ turnIn: "t" })).journal.quests.q?.status).toBe("complete");
  });

  it("an old journal without `hidden` still parses", () => {
    expect(questJournalSchema.safeParse({ version: 1, tracked: null, quests: { a: { status: "active", progress: {} } } }).success).toBe(true);
  });
});

describe("world conditions", () => {
  const facts = (world: DialogueFacts["world"]): DialogueFacts => ({ npcId: "", memory: null, journal: null, sheet: null, quest: () => undefined, metBefore: false, world });
  it("clock windows wrap midnight; no clock never holds", () => {
    const night = { clock: { from: 20, to: 4 } };
    expect(testCondition(night, facts({ hour: 22, weather: null, biome: null }))).toBe(true);
    expect(testCondition(night, facts({ hour: 3.5, weather: null, biome: null }))).toBe(true);
    expect(testCondition(night, facts({ hour: 12, weather: null, biome: null }))).toBe(false);
    expect(testCondition(night, facts(null))).toBe(false);
  });
  it("weather bands read precipitation, storm and the biome underfoot", () => {
    const snow = { weather: { min: 0.3, biomes: ["tundra"] } };
    expect(testCondition(snow, facts({ hour: null, weather: { precipitation: 0.5, storm: 0 }, biome: "tundra" }))).toBe(true);
    expect(testCondition(snow, facts({ hour: null, weather: { precipitation: 0.5, storm: 0 }, biome: "meadow" }))).toBe(false);
    expect(testCondition(snow, facts({ hour: null, weather: { precipitation: 0.1, storm: 0 }, biome: "tundra" }))).toBe(false);
    expect(testCondition({ weather: { max: 0.05, storm: 0.5 } }, facts({ hour: null, weather: { precipitation: 0, storm: 0.7 }, biome: null }))).toBe(true);
  });
});
