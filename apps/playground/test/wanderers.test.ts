import { test } from "node:test";
import assert from "node:assert/strict";
import { longestRun, offsetLine, resample, routeLength, wandererFindings, wanderersSchema, WANDER_RULES } from "../tools/zonegen/commands/_wanderers.mts";

const FAMILY: Record<string, string> = { wolf: "wolf", "giant-spider": "spider", "giant-bat": "bat", "giant-rat": "giant-rat", "bandit-cutthroat": "human", "giant-raven": "raven", "wild-horse": "horse" };
const fam = (id: string): string => FAMILY[id] ?? id;
const table = (rows: Array<{ creature: string; temperament?: string }>) =>
  wanderersSchema.parse({
    zone: "z",
    areas: rows.map((r, k) => ({ id: `a${k}`, name: "a", placement: "anywhere", at: { at: [0, 0] }, population: 4, mix: [{ creature: r.creature, temperament: r.temperament }] })),
  });

test("a starter zone's wanderers are never birds or livestock", () => {
  const f = wandererFindings(table([{ creature: "wolf" }, { creature: "giant-spider" }, { creature: "giant-bat" }, { creature: "giant-rat" }, { creature: "giant-raven" }, { creature: "wild-horse" }]), fam, true);
  const banned = f.filter((x) => x.code === "wanderer-banned");
  assert.equal(banned.length, 2);
  assert.ok(WANDER_RULES.neverInStarter.includes("raven") && WANDER_RULES.neverInStarter.includes("horse"));
  // the same table is legal outside a starter zone
  assert.equal(wandererFindings(table([{ creature: "wolf" }, { creature: "giant-spider" }, { creature: "giant-bat" }, { creature: "giant-rat" }, { creature: "giant-raven" }]), fam, false).length, 0);
});

test("the roaming set needs at least four hostile kinds", () => {
  const thin = wandererFindings(table([{ creature: "wolf" }, { creature: "giant-spider" }, { creature: "giant-rat", temperament: "passive" }, { creature: "giant-bat", temperament: "territorial" }]), fam, true);
  assert.ok(thin.some((x) => x.code === "wanderers-thin"));
  const ok = wandererFindings(table([{ creature: "wolf" }, { creature: "giant-spider" }, { creature: "giant-bat" }, { creature: "bandit-cutthroat" }]), fam, true);
  assert.equal(ok.length, 0);
  assert.ok(wandererFindings(null, fam, true).some((x) => x.code === "wanderers-none"));
});

test("band companions count as the roll's temperament", () => {
  const w = wanderersSchema.parse({
    zone: "z",
    areas: [{ id: "band", name: "b", placement: "route", route: { road: ["r"] }, population: 3, temperament: "hostile", mix: [{ creature: "bandit-cutthroat", with: [{ creature: "wolf" }, { creature: "giant-spider" }, { creature: "giant-bat" }] }] }],
  });
  assert.equal(wandererFindings(w, fam, true).length, 0);
});

test("route helpers: resample keeps the ends, offset shifts sideways, longest legal run", () => {
  const line: Array<[number, number]> = [[0, 0], [100, 0]];
  const r = resample(line, 25);
  assert.deepEqual(r[0], [0, 0]);
  assert.deepEqual(r.at(-1), [100, 0]);
  assert.equal(r.length, 5);
  assert.ok(Math.abs(routeLength(r) - 100) < 1e-9);
  const o = offsetLine(r, 10); // left of +x travel is +z
  assert.ok(o.every(([, z]) => Math.abs(z - 10) < 1e-9));
  assert.deepEqual(longestRun([1, 2, -1, 3, 4, 5, -1, 6], (x) => x > 0), [3, 4, 5]);
});

test("dispositions: wary and neutral rows are not hostile kinds; starter defaults keep rats and bats off the attack", async () => {
  const { starterDisposition, DISPOSITIONS } = await import("../tools/zonegen/commands/_wanderers.mts");
  const w = wanderersSchema.parse({ zone: "z", areas: [{ id: "a", name: "a", placement: "anywhere", at: { at: [0, 0] }, population: 4, mix: [{ creature: "wolf", disposition: "wary" }, { creature: "giant-spider" }, { creature: "giant-bat", disposition: "neutral" }, { creature: "bandit-cutthroat" }] }] });
  assert.ok(wandererFindings(w, fam, true).some((x) => x.code === "wanderers-thin"));
  assert.equal(DISPOSITIONS.wary, "territorial");
  assert.equal(starterDisposition("giant-rat", "k"), "passive");
  assert.equal(starterDisposition("bat", "k"), "passive");
  assert.equal(starterDisposition("beetle", "k"), "passive");
  assert.equal(starterDisposition("zombie", "k"), "aggressive");
  const wolves = Array.from({ length: 200 }, (_, i) => starterDisposition("wolf", `w${i}`));
  const wary = wolves.filter((d) => d === "wary").length / wolves.length;
  assert.ok(wary > 0.45 && wary < 0.75);
});

test("starter mix: passive / wary / aggressive shares are held to the EverQuest band; fodder stands under the zone's level", async () => {
  const { starterMixFindings, fodderLevel } = await import("../tools/zonegen/commands/_wanderers.mts");
  const { sharesOf } = await import("../tools/zonegen/commands/populate.mts");
  const s = sharesOf([
    { placement: "anywhere", population: 12, mix: [{ template: "rat", weight: 3, temperament: "passive" }, { template: "wolf", weight: 1, temperament: "territorial" }] },
    { spawns: [{ template: "bandit", count: 4 }] },
  ]);
  assert.deepEqual(s, { passive: 0.563, wary: 0.188, aggressive: 0.25 });
  assert.equal(starterMixFindings(s).length, 0);
  assert.ok(starterMixFindings({ passive: 0.3, wary: 0.1, aggressive: 0.6 }).some((x) => x.message.includes("aggressive")));
  for (let i = 0; i < 50; i++) {
    const l = fodderLevel(8, `k${i}`);
    assert.ok(l >= 5 && l <= 7);
  }
  assert.equal(fodderLevel(1, "k"), 1);
});
