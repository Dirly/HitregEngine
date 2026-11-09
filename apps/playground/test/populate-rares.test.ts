import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { buildOps, placePopulationTemplates, populationTemplateFindings, rareFindings, RARE_RULES, type Area, type Template } from "../tools/zonegen/commands/populate.mts";
import type { Ctx } from "../tools/zonegen/lib.mts";
import { SpawnAreaManager } from "../../../packages/server/src/spawn-areas.js";

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

test("site-pack chance-only queens are emitted as conditional templates and held back by the spawn manager", () => {
  const template = (id: string, body: string): Template => ({
    id, creature: id, family: "ant", theme: "painted", name: id, level: 7, levels: [7, 7],
    role: "elite", faction: "wild", placeholder: false, body, why: "ready body + theme", abilities: ["mobBite"],
  });
  const queens = ["pop-rustmother-l9", "pop-cinder-queen-l7"];
  const workers = ["pop-rustblood-worker", "pop-cinder-worker"];
  const templates = new Map([
    ...workers.map((id) => [id, template(id, "mobs/ant-worker")] as const),
    ...queens.map((id, i) => [id, template(id, i ? "mobs/cinder-queen" : "mobs/rustmother")] as const),
  ]);
  const areas: Area[] = queens.map((queen, i) => ({
    id: `hive-${i}`, kind: "group", x: i * 100, y: 0, z: 0, level: 7, creature: "giant-ant", habitats: ["badlands"],
    radius: 60, sleepRadius: 90, idleSeconds: 10, leash: 26, roam: 4,
    spawns: [{ template: workers[i]!, count: 3, spread: 5 }],
    rares: [{ template: queen, chance: 0.25, lockout: [600, 900], placeholders: [workers[i]!] }],
  }));
  const used = placePopulationTemplates(templates, areas);
  assert.equal(used.length, 4);
  for (const [i, queen] of queens.entries()) {
    assert.equal(templates.get(queen)!.standsAt, areas[i]!.id);
    assert.equal(templates.get(queen)!.templateOnly, true);
    // Only the authored COMMON body consumes one pack slot. A queen never gains a normal spawn entry.
    assert.deepEqual(areas[i]!.spawns, [{ template: workers[i], count: 2, spread: 5 }]);
  }

  const scratch = path.join(os.tmpdir(), `hitreg-populate-test-${randomUUID()}`);
  const ctx = { world: "test", opt: (_key: string, fallback: string) => fallback,
    paths: { projectDir: scratch, zoneDir: () => scratch } } as unknown as Ctx;
  const ops = buildOps(ctx, "zone-1", areas, used, [], null, []);
  const added = new Map(ops.flatMap((o) => o.op === "add-entity" ? [[o.id, o.entity] as const] : []));
  assert.equal((added.get(queens[0]!)!.components.prefab as { prefabId: string }).prefabId, "mobs/rustmother");
  assert.equal((added.get(queens[1]!)!.components.prefab as { prefabId: string }).prefabId, "mobs/cinder-queen");
  assert.deepEqual(populationTemplateFindings(areas, [...added.keys()]), []);
  for (const a of areas) for (const row of [...a.spawns, ...a.rares!]) assert.ok(added.has(String(row.template)));

  // Exercise the real server adoption contract: its templates remain clonable, while authored rare bodies despawn.
  const live = new Map([...templates.keys()].map((id) => [id, { authored: true }]));
  const removed: string[] = [];
  const manager = {
    server: { world: { positionOf: () => [0, 0, 0] } }, areas: new Map(),
    npcs: { npcs: live, despawn: (id: string) => { live.delete(id); removed.push(id); } },
  } as unknown as SpawnAreaManager;
  for (const a of areas) SpawnAreaManager.prototype.adopt.call(manager, a.id, added.get(a.id)!);
  assert.deepEqual(removed, queens);
  assert.ok(workers.every((id) => live.has(id)));
  assert.ok(queens.every((id) => !live.has(id)));
});

test("population rejects dangling common, rare, roaming, and companion template references", () => {
  const area = {
    id: "broken-table", spawns: [{ template: "worker", count: 1, spread: 2 }],
    rares: [{ template: "queen" }], life: { mix: [{ template: "roamer", with: ["companion"] }], rares: [{ template: "night-queen" }] },
  } as Area;
  const findings = populationTemplateFindings([area], ["worker"]);
  assert.equal(findings.length, 4);
  assert.ok(findings.every((f) => f.level === "error" && f.code === "missing-spawn-template"));
  for (const id of ["queen", "roamer", "companion", "night-queen"]) assert.ok(findings.some((f) => f.message.includes(id)));
});
