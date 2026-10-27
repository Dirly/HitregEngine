import { test } from "node:test";
import assert from "node:assert/strict";
import { questMix } from "../tools/zonegen/commands/quests.mts";
import type { PlannedQuest } from "../tools/zonegen/schemas.mts";

const step = (id: string, action: string, at: string, target: PlannedQuest["objectives"][number]["target"] = { type: "creature", ref: "wolf" }) =>
  ({ id, action, target, count: 1, at, after: [], needs: [], grants: [], when: "any", params: {}, conditions: [], then: [] }) as PlannedQuest["objectives"][number];
const quest = (id: string, giver: string, objectives: PlannedQuest["objectives"]) =>
  ({ id, title: id, kind: "side", arc: "", giver: { type: giver, ref: "" }, turnIn: "", requires: [], level: 3, summary: "s", objectives, rewards: { xp: 0, coins: 0, items: [] }, leads: [] }) as PlannedQuest;
const brief = { places: [{ id: "crag", size: "large" }, { id: "den", size: "medium" }], variety: { maxInteractShare: 0.3, minFieldShare: 0.7 } };
const locations = [{ id: "crag" }, { id: "den" }, { id: "crag-ledge", place: "crag" }, { id: "hole-door" }];
const dungeons = [{ id: "hole", entrance: "hole-door" }];

test("quest-mix: an interact-heavy zone fails on both shares, the large place and the dungeon", () => {
  const m = questMix(
    {
      quests: [
        quest("a", "npc", [step("x", "interact", "den", { type: "entity", ref: "gate" }), step("y", "kill", "den")]),
        quest("b", "npc", [step("x", "interact", "hole-door", { type: "entity", ref: "bell" }), step("y", "kill", "hole-door")]),
      ],
      locations,
      dungeons,
    },
    brief,
  );
  assert.equal(m.objectives, 4);
  assert.equal(m.interact, 2);
  assert.equal(m.field, 2);
  assert.deepEqual(m.largeWithoutDiscovery, ["crag"]);
  assert.deepEqual(m.dungeonsWithoutChain, ["hole"]);
  assert.equal(m.problems.length, 4);
});

test("quest-mix: field work, an arrival quest inside the large place and a dungeon chain pass", () => {
  const m = questMix(
    {
      quests: [
        // offered on arrival: an auto source acting at a location inside the large place
        quest("arrive", "auto", [step("k", "kill", "crag-ledge"), step("c", "collect", "crag-ledge", { type: "item", ref: "pelt" })]),
        quest("deep", "npc", [step("k", "kill", "hole-door"), step("c", "collect", "hole-door", { type: "item", ref: "button" }), step("r", "interact", "hole-door", { type: "entity", ref: "roll" })]),
        quest("walk", "npc", [step("v", "visit", "den", { type: "place", ref: "den" }), step("k", "kill", "den")]),
      ],
      locations,
      dungeons,
    },
    brief,
  );
  assert.equal(m.interact, 1);
  assert.equal(m.field, 6);
  assert.deepEqual(m.problems, []);
});
