import { describe, expect, it } from "vitest";
import {
  acceptQuest,
  advanceQuest,
  buildEngineSpec,
  choiceFlag,
  choiceLockedByFlags,
  escortLength,
  escortPoint,
  escortRouteSchema,
  objectiveChoice,
  objectiveLocked,
  objectiveOpen,
  stepEscort,
  tideLevel,
  tidePhase,
  TIDE_PERIOD_HOURS,
  type EscortState,
  ComponentRegistry,
  conditionBlockNames,
  questBlocks,
  questJournalSchema,
  questObjectiveSchema,
  questOfferProblem,
  questSchema,
  questSource,
  migrateJournal,
  repeatLabel,
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
    expect(questBlocks.names("action").sort()).toEqual(["collect", "deliver", "endure", "escort", "interact", "kill", "perform", "read", "talk", "visit"]);
    expect(questBlocks.names("condition").sort()).toEqual(["clock", "coins", "flag", "item", "level", "quest", "tide", "weather"]);
    expect(questBlocks.names("consequence")).toEqual(["flag", "choose", "repeat"]);
    for (const unbuilt of ["die", "status", "reveal", "spawn", "passage", "world", "reputation", "faction"])
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

describe("repeat", () => {
  const facts = (journal: QuestJournal, hour: number | null, day = 0): DialogueFacts => ({ npcId: "", memory: null, journal, sheet: null, quest: () => daily, metBefore: false, world: { hour, day, weather: null, biome: null } });
  const daily = quest({ repeat: { after: "day" } });
  const run = (j: QuestJournal, q = daily, now: number): QuestJournal => {
    const a = acceptQuest(j, q, true, now);
    expect(a.error).toBeNull();
    return advanceQuest(a.journal, q, "a", 1, now);
  };
  it("is a registered consequence block with described fields in the spec, and the quest asset validates it", () => {
    const spec = buildEngineSpec({ registry: new ComponentRegistry() });
    const block = spec.questBlocks.consequence["repeat"] as { scope: string; schema: { properties: Record<string, { description?: string }> } };
    expect(block.scope).toBe("character");
    expect(block.schema.properties["after"]?.description).toBeTruthy();
    expect(block.schema.properties["limit"]?.description).toBeTruthy();
    expect(() => quest({ repeat: { after: "week" } })).toThrow();
    expect(() => quest({ repeat: { after: 6, every: 2 } })).toThrow();
    expect(repeatLabel({ after: "day", limit: 3 })).toBe("daily, 3 times at most");
  });
  it("a daily is offered again after the next midnight, resets its objectives and completes again", () => {
    let j = run(empty(), daily, 10); // day 0, 10:00
    expect(j.quests["q"]).toMatchObject({ status: "complete", completions: 1, completedAt: 10 });
    expect(questOfferProblem(j, daily, 23)).toMatch(/not yet/);
    expect(testCondition({ quest: "q", status: "available" }, facts(j, 23))).toBe(false);
    expect(testCondition({ quest: "q", status: "available" }, facts(j, 0.5, 1))).toBe(true);
    const again = acceptQuest(j, daily, true, 24.5);
    expect(again.error).toBeNull();
    expect(again.journal.quests["q"]).toMatchObject({ status: "active", progress: {}, completions: 1 });
    j = advanceQuest(again.journal, daily, "a", 1, 25);
    expect(j.quests["q"]).toMatchObject({ status: "complete", completions: 2, completedAt: 25 });
    expect(questOfferProblem(j, daily, 30)).toMatch(/not yet/);
  });
  it("hours count from the completion; limit caps runs; a hand-in stamps it too; no clock never repeats", () => {
    const twice = quest({ repeat: { after: 6, limit: 2 }, turnIn: "n" });
    let j = acceptQuest(empty(), twice, true, 100).journal;
    j = advanceQuest(j, twice, "a", 1, 100);
    expect(j.quests["q"]!.status).toBe("ready");
    j = turnInQuest(j, twice, 101).journal;
    expect(j.quests["q"]).toMatchObject({ status: "complete", completions: 1, completedAt: 101 });
    expect(questOfferProblem(j, twice, 106.9)).toMatch(/again in 1 h/);
    expect(questOfferProblem(j, twice, null)).toMatch(/no world clock/);
    expect(questOfferProblem(j, twice, 50)).toBeNull(); // the clock restarted (a fresh server): the wait is over
    j = turnInQuest(advanceQuest(acceptQuest(j, twice, true, 107).journal, twice, "a", 1, 107), twice, 108).journal;
    expect(j.quests["q"]!.completions).toBe(2);
    expect(questOfferProblem(j, twice, 1000)).toMatch(/limit/);
    expect(questOfferProblem(run(empty(), quest({}), 10), quest({}), 1000)).toBe("already completed");
  });
});

describe("tide condition", () => {
  const facts = (day: number | null, hour: number | null): DialogueFacts => ({ npcId: "", memory: null, journal: null, sheet: null, quest: () => undefined, metBefore: false, world: { hour, day, weather: null, biome: null } });
  it("is one world function of day * 24 + hour with a fixed period: high at 0, ebb, low, flood, slipping each day", () => {
    expect(tidePhase(0)).toBe("high");
    expect(tidePhase(TIDE_PERIOD_HOURS * 0.25)).toBe("ebb");
    expect(tidePhase(TIDE_PERIOD_HOURS * 0.5)).toBe("low");
    expect(tidePhase(TIDE_PERIOD_HOURS * 0.75)).toBe("flood");
    expect(tidePhase(TIDE_PERIOD_HOURS * 3)).toBe("high");
    expect(tideLevel(0)).toBeCloseTo(1);
    expect(tideLevel(TIDE_PERIOD_HOURS / 2)).toBeCloseTo(-1);
    expect(testCondition({ tide: "low" }, facts(0, 6.2))).toBe(true);
    expect(testCondition({ tide: "low" }, facts(2, 6.2))).toBe(false); // two days later low water has moved on
    expect(testCondition({ tide: "low" }, facts(null, null))).toBe(false);
    expect(testCondition({ any: [{ tide: "low" }, { tide: "flood" }] }, facts(0, 9.3))).toBe(true);
    expect(() => questSchema.parse({ id: "q", title: "Q", description: "", objectives: [{ id: "a", label: "A", kind: "visit", when: { tide: "spring" } }] })).toThrow();
  });
  it("is a registered world condition with a described schema", () => {
    expect(questBlocks.get("condition", "tide")?.scope).toBe("world");
    expect([...conditionBlockNames({ all: [{ tide: "ebb" }, { clock: { from: 1, to: 2 } }] })].sort()).toEqual(["clock", "tide"]);
    const spec = buildEngineSpec({ registry: new ComponentRegistry() });
    expect((spec.questBlocks.condition["tide"] as { schema: { enum: string[] } }).schema.enum).toEqual(["high", "ebb", "low", "flood"]);
  });
});

describe("escort", () => {
  const st = (extra: Partial<EscortState> = {}): EscortState => ({ by: "p", quest: "q", objective: "a", state: "walk", d: 0, away: 0, t: 0, radius: 10, grace: 5, ...extra });
  const tick = { dt: 1, length: 10, speed: 2, hold: 3, near: true, dead: false };
  it("walks while the escorter is near, waits while away, arrives, holds, walks back and ends", () => {
    let s: EscortState | null = st();
    s = stepEscort(s, tick)!;
    expect(s.d).toBe(2);
    s = stepEscort(s, { ...tick, near: false })!;
    expect(s).toMatchObject({ d: 2, away: 1, state: "walk" });
    for (let i = 0; i < 4; i++) s = stepEscort(s, tick)!;
    expect(s).toMatchObject({ d: 10, state: "arrived", away: 0 });
    for (let i = 0; i < 3; i++) s = stepEscort(s, tick)!;
    expect(s.state).toBe("return");
    for (let i = 0; i < 4; i++) s = stepEscort(s, tick)!;
    expect(s.d).toBe(2);
    expect(stepEscort(s, tick)).toBeNull();
  });
  it("fails when the escorter stays away past grace, or the NPC dies", () => {
    let s: EscortState = st({ d: 4 });
    for (let i = 0; i < 5; i++) s = stepEscort(s, { ...tick, near: false })!;
    expect(s.state).toBe("walk");
    s = stepEscort(s, { ...tick, near: false })!;
    expect(s.state).toBe("failed");
    expect(stepEscort(st({ d: 4 }), { ...tick, dead: true })!.state).toBe("failed");
  });
  it("places the NPC along post + route and faces it down its leg", () => {
    const post = [0, 0, 0] as const;
    const route: [number, number, number][] = [[0, 2, 10], [10, 2, 10]];
    expect(escortLength(post, route)).toBe(20);
    expect(escortPoint(post, route, 5).at).toEqual([0, 1, 5]);
    expect(escortPoint(post, route, 15).at).toEqual([5, 2, 10]);
    expect(escortPoint(post, route, 15).yaw).toBeCloseTo(Math.PI / 2);
    expect(escortPoint(post, route, 99).at).toEqual([10, 2, 10]);
  });
  it("is an action whose fields default and validate, and the route param has its own schema", () => {
    const q = questSchema.parse({ id: "q", title: "Q", description: "", objectives: [{ id: "a", label: "A", kind: "escort", target: "old-maud" }] });
    expect(q.objectives[0]).toMatchObject({ kind: "escort", radius: 15, grace: 10 });
    expect(() => questSchema.parse({ id: "q", title: "Q", description: "", objectives: [{ id: "a", label: "A", kind: "escort", target: "m", radius: 1 }] })).toThrow();
    expect(escortRouteSchema.parse({ route: [[1, 2, 3]] })).toEqual({ route: [[1, 2, 3]], speed: 1.6, hold: 8 });
    expect(escortRouteSchema.safeParse({ route: [] }).success).toBe(false);
  });
});

describe("choose (exclusive choice)", () => {
  const q = questSchema.parse({
    id: "q", title: "Q", description: "",
    objectives: [
      { id: "find", label: "Find the bell", kind: "talk", target: "n" },
      { id: "ring", label: "Ring it", kind: "interact", target: "bell", after: ["find"], then: [{ do: "choose", choice: "bell-fate", option: "rang" }] },
      { id: "muffle", label: "Muffle it", kind: "interact", target: "bell", after: ["find"], then: [{ do: "choose", choice: "bell-fate", option: "muffled" }] },
      { id: "report", label: "Report", kind: "talk", target: "n", after: ["ring", "muffle"] },
    ],
  });
  it("taking one option locks the other, which then counts as settled for `after` and completion", () => {
    let j = acceptQuest(empty(), q).journal;
    j = advanceQuest(j, q, "find");
    expect(objectiveOpen(q, j.quests["q"]!.progress, "report")).toBe(false);
    j = advanceQuest(j, q, "ring");
    expect(objectiveLocked(q, j.quests["q"]!.progress, q.objectives[2]!)).toBe(true);
    const before = j;
    expect(advanceQuest(j, q, "muffle")).toBe(before); // locked: no progress
    expect(objectiveOpen(q, j.quests["q"]!.progress, "report")).toBe(true);
    j = advanceQuest(j, q, "report");
    expect(j.quests["q"]!.status).toBe("complete");
    expect(objectiveChoice(q.objectives[1]!)).toEqual({ do: "choose", choice: "bell-fate", option: "rang" });
  });
  it("the flag `<choice>=<option>` locks the other options in any quest", () => {
    expect(choiceFlag("bell-fate", "rang")).toBe("bell-fate=rang");
    expect(choiceLockedByFlags({ "bell-fate=rang": true }, "bell-fate", "muffled")).toBe(true);
    expect(choiceLockedByFlags({ "bell-fate=rang": true }, "bell-fate", "rang")).toBe(false);
    expect(choiceLockedByFlags({ "bell-fate=rang": false, other: true }, "bell-fate", "muffled")).toBe(false);
  });
  it("a choice needs two or more steps with different options, one choose per step", () => {
    const one = { id: "q", title: "Q", description: "", objectives: [{ id: "a", label: "A", kind: "talk", target: "n", then: [{ do: "choose", choice: "c", option: "x" }] }] };
    expect(questSchema.safeParse(one).success).toBe(false);
    const same = { ...one, objectives: [...one.objectives, { id: "b", label: "B", kind: "talk", target: "m", then: [{ do: "choose", choice: "c", option: "x" }] }] };
    expect(questSchema.safeParse(same).success).toBe(false);
    expect(questBlocks.get("consequence", "choose")?.schema.safeParse({ do: "choose", choice: "c", option: "x" }).success).toBe(true);
    expect(questBlocks.get("consequence", "flag")?.schema.safeParse({ do: "choose", choice: "c", option: "x" }).success).toBe(false);
  });
});
