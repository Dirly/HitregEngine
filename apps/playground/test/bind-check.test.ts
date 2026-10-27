import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { questIdCollisions } from "../tools/zonegen/commands/bind-check.mts";

test("bind-check: a quest id that is also an item / data-asset id in the closure is a collision", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-ids-"));
  const world = path.join(dir, "world", "assets"), foundation = path.join(dir, "foundation", "assets");
  for (const d of [path.join(world, "quests"), path.join(world, "dialogues"), path.join(foundation, "items")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(foundation, "items", "lamp-oil.json"), "{}");
  fs.writeFileSync(path.join(world, "quests", "lamp-oil.json"), "{}");
  fs.writeFileSync(path.join(world, "quests", "foul-the-lamp.json"), "{}");
  fs.writeFileSync(path.join(world, "dialogues", "ferryman.json"), "{}");
  const hits = questIdCollisions([world, foundation], ["lamp-oil", "foul-the-lamp", "ferryman"]);
  assert.deepEqual(hits.get("lamp-oil"), ["items/lamp-oil.json (foundation)"], "shadowed by the foundation item");
  assert.deepEqual(hits.get("ferryman"), ["dialogues/ferryman.json (world)"]);
  assert.equal(hits.has("foul-the-lamp"), false, "the renamed quest is clean");
});

test("bind-check: kill bodies by tag (through parents for position), by id and by copy prefix", async () => {
  const { killBodies } = await import("../tools/zonegen/commands/bind-check.mts");
  const e = (id: string, parent: string | null, tags: string[], position?: number[]) => [id, { id, name: id, parent, tags, components: position ? { transform: { position } } : {} }] as const;
  const entities = new Map([
    e("camp", null, [], [100, 0, 200]),
    e("camp-wolf", "camp", ["npc", "creature:wolf"], [5, 0, 5]),
    e("boss-1", null, ["npc"], [0, 0, 0]),
    e("boss-1-add", null, ["npc"], [1, 0, 1]),
  ]);
  assert.deepEqual(killBodies(entities, "tag:creature:wolf"), [{ id: "camp-wolf", at: [105, 205] }]);
  assert.deepEqual(killBodies(entities, "boss-1").map((b) => b.id), ["boss-1", "boss-1-add"]);
  assert.deepEqual(killBodies(entities, "tag:creature:rat"), []);
});
