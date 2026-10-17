import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTownLights, planTownLights, resolveStreetLighting, townWealth, type TownLightInput } from "../tools/town-lights-rule.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(HERE, "../tools/street-lights.json"), "utf8"));

// a straight high street with a gate at each end, one lane off it, an alehouse on the street, a road out east
const input: TownLightInput = {
  town: { id: "town-9", name: "testby", center: [0, 0], radius: 60, gates: [
    { id: "west-gate", at: [-50, 0], facing: [-1, 0], width: 6 },
    { id: "east-gate", at: [50, 0], facing: [1, 0], width: 6 },
  ] },
  roads: [
    { id: "town-9-street-street-1", points: [[-50, 0], [50, 0]], width: 4 },
    { id: "town-9-street-lane-1", points: [[0, 2], [0, 40]], width: 2.5 },
    { id: "path-town-9-town-8", points: [[50, 0], [250, 0]], width: 3 },
  ],
  bridges: [],
  buildings: [{ id: "alehouse", poly: [[10, 5], [20, 5], [20, 15], [10, 15]], door: [15, 5], use: "alehouse and kitchen", facing: [0, -1] }],
  docks: [],
  obstacles: [],
  ground: { height: () => 0, waterY: () => null },
};

test("town wealth is the plan's, else the residents' median", () => {
  assert.equal(townWealth({ wealth: "wealthy", residents: [{ wealth: "poor" }] }), "wealthy");
  assert.equal(townWealth({ residents: [{ wealth: "poor" }, { wealth: "poor" }, { wealth: "comfortable" }, { wealth: "destitute" }] }), "poor");
  assert.equal(townWealth({}), undefined);
});

test("a poor village gets few lanterns: one per gate, one per lane mouth, one at the alehouse; and passes its gate", () => {
  const { rule, profile } = resolveStreetLighting(raw, { tier: "village", wealth: "poor" });
  assert.equal(profile, "poor-village");
  const plan = planTownLights(input, rule);
  const kinds = plan.lanterns.map((l) => l.kind).sort();
  assert.deepEqual(kinds, ["door", "gate", "gate", "lane"]);
  const check = checkTownLights(input, rule, plan.lanterns);
  assert.deepEqual(check.failures, []);
});

test("a town keeps the full standard, which a poor village's lanterns would fail", () => {
  const { rule, profile } = resolveStreetLighting(raw, { tier: "town", wealth: "comfortable" });
  assert.equal(profile, null);
  const plan = planTownLights(input, rule);
  assert.ok(plan.lanterns.filter((l) => l.kind === "street").length >= 4);
  assert.ok(plan.lanterns.some((l) => l.kind === "road"));
  assert.ok(!plan.lanterns.some((l) => l.kind === "door"));
  const poor = planTownLights(input, resolveStreetLighting(raw, { tier: "village", wealth: "poor" }).rule);
  assert.ok(!checkTownLights(input, rule, poor.lanterns).ok);
});
