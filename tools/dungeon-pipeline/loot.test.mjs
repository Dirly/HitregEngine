// The instance loot coverage gate (quality.mjs measureLoot): every armor weight, every slot in 2+ weights, every
// weapon role, a trash table, something from every named, a rare from the boss, rarity within the level band.
import { test } from "node:test";
import assert from "node:assert/strict";
import { measureLoot } from "./quality.mjs";

const plan = {
  minibosses: [{ id: "mini", level: 15, loot: "a:1:1" }],
  boss: { id: "boss", level: 18, loot: "r:1:1" },
  trashLoot: "",
};
const W = ["cloth", "leather", "mail", "plate"];
const SLOTS = ["helm", "shoulders", "chest", "legs", "gloves", "boots"];
// every slot in two weights, rotated so all four weights appear
const armor = SLOTS.flatMap((slot, i) => [0, 1].map((k) => ({ id: `${slot}-${k}`, slot, weight: W[(i + k) % 4], rarity: "uncommon", from: ["trash"] })));
const weapons = ["caster", "melee-1h", "melee-2h", "tank"].map((role) => ({ id: role, slot: "weapon", role, rarity: "uncommon", from: ["mini"] }));
const full = { items: [...armor, ...weapons, { id: "r", slot: "helm", weight: "plate", rarity: "rare", from: ["boss"] }] };
const checks = (m) => m.failures.filter((f) => f.check !== "wired").map((f) => f.check);

test("a full instance list passes coverage", () => {
  assert.deepEqual(checks(measureLoot(plan, full)), []);
});

test("a missing weight, a thin slot and a missing role are named", () => {
  const items = full.items.filter((i) => i.weight !== "cloth" && i.role !== "tank");
  const c = checks(measureLoot(plan, { items }));
  assert.ok(c.includes("weights") && c.includes("slots") && c.includes("roles"));
});

test("rarity is capped by the level band, boss drops one band higher in a starter dungeon", () => {
  const low = { ...plan, minibosses: [{ ...plan.minibosses[0], level: 8 }], boss: { ...plan.boss, level: 9 } };
  const items = [...full.items, { id: "x", slot: "chest", weight: "mail", rarity: "rare", from: ["mini"] }];
  const f = measureLoot(low, { items }).failures.filter((f) => f.check === "rarity").map((f) => f.what);
  assert.equal(f.length, 1);
  assert.match(f[0], /^x: rare is above the level-9 cap \(uncommon\)/);
});

test("ornament parts need rare, and every drop must be wired into its source", () => {
  const items = [...full.items, { id: "o", slot: "helm", weight: "mail", rarity: "uncommon", from: ["mini"], appearance: { parts: ["Helm1_Base", "OrnateTop"] } }];
  const m = measureLoot(plan, { items });
  assert.ok(m.failures.some((f) => f.check === "ornament" && f.what.startsWith("o:")));
  assert.ok(m.failures.some((f) => f.check === "wired" && f.what === "a: not in plan.trashLoot") === false);
  assert.ok(m.failures.some((f) => f.check === "wired" && f.what === "helm-0: not in plan.trashLoot"));
});
