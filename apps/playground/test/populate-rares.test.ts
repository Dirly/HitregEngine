import { test } from "node:test";
import assert from "node:assert/strict";
import { rareFindings, RARE_RULES } from "../tools/zonegen/commands/populate.mts";

const named = [
  { template: "pop-ned-cotter-l5", name: "Ned Cotter", kind: "rare" as const },
  { template: "pop-black-tam-l7", name: "Black Tam", kind: "named" as const },
];

test("rares with no placeholder entries at all: one rare-no-placeholders warning", () => {
  const f = rareFindings(named, []);
  assert.deepEqual(f.map((x) => x.code), ["rare-no-placeholders"]);
});

test("a rare no area rolls is always up; one that is rolled is not", () => {
  const f = rareFindings(named, [{ area: "camp", template: "pop-ned-cotter-l5", chance: 0.1 }]);
  assert.deepEqual(f.map((x) => x.code), ["rare-always-up"]);
  assert.match(f[0]!.message, /Black Tam/);
  assert.doesNotMatch(f[0]!.message, /Ned Cotter/);
});

test("a chance over the bar makes it nearly always up", () => {
  const all = named.map((n) => ({ area: "camp", template: n.template, chance: 0.1 }));
  assert.deepEqual(rareFindings(named, all), []);
  const f = rareFindings(named, [...all, { area: "road", template: "prefab:mobs/spider-venom", chance: RARE_RULES.maxChance + 0.1 }]);
  assert.deepEqual(f.map((x) => x.code), ["rare-chance"]);
});
