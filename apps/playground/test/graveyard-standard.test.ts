import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeArchetypeSchema, standardFaults, stonePieceFaults, type StandardWall } from "../tools/_place-archetype.mts";

// Derek 2026-11-10 (the Widows' Cairn): THE STANDARD for every graveyard, held as the graveyard archetype's `standard`
// and measured by standardFaults (walls, railing cover, gate, denied pieces) and stonePieceFaults (stone: "every").
const here = path.dirname(fileURLToPath(import.meta.url));
const archFile = path.join(here, "../projects/world-kit/authoring/place-archetypes/graveyard.json");
const std = {
  about: "test", walls: { maxThickness: 0.6, minHeight: 0.45, maxHeight: 1.1 }, railing: { match: "iron-railing", cover: 0.75, near: 0.6 },
  gate: { match: "iron-gate", near: 2.5 }, deny: [{ match: "burst-grave|grave-earth", why: "plain rows" }, { match: "coffin", why: "plain rows" }, { match: "lych-gate", why: "iron gate" }], stone: "every" as const,
};
// a 10 x 10 square, gate gap of 3 m in the south side (runs end at x 3.5 and 6.5 on z 0)
const wall = (thickness = 0.5, height = 0.8): StandardWall => ({ id: "core.kirkyard", thickness, height, runs: [[[3.5, 0], [0, 0], [0, 10], [10, 10], [10, 0], [6.5, 0]]] });
const railsAlong = (w: StandardWall, width = 1.0) => {
  const out: { id: string; prefab: string; at: [number, number]; width: number }[] = [];
  for (const r of w.runs) for (let i = 0; i + 1 < r.length; i++) { const [a, b] = [r[i]!, r[i + 1]!], L = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let s = width / 2; s < L; s += width) out.push({ id: `rail-${out.length}`, prefab: "composite-props/iron-railing-section", at: [a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L], width }); }
  return out;
};
const gate = { id: "gate", prefab: "composite-props/iron-gate-posts", at: [5, 0] as [number, number], width: 2.6 };

test("the graveyard archetype carries the standard and parses", () => {
  const a = placeArchetypeSchema.parse(JSON.parse(fs.readFileSync(archFile, "utf8")));
  assert.ok(a.standard, "graveyard has a standard");
  assert.equal(a.standard!.stone, "every");
  assert.ok(a.standard!.walls!.maxThickness <= 0.6 && a.standard!.walls!.maxHeight <= 1.1);
  for (const w of a.pockets.flatMap((p) => p.walls)) assert.ok(w.thickness <= a.standard!.walls!.maxThickness, `${w.id} thin`);
  for (const id of ["variant-props/burst-grave-earth", "variant-props/grave-earth-heap", "posed-props/coffin-b-tilted", "posed-props/lych-gate-small-weathered"])
    assert.ok(a.standard!.deny.some((d) => new RegExp(d.match).test(id)), `${id} denied`);
});

test("a thin low railed wall with an iron gate in its gap passes", () => {
  const w = wall();
  assert.deepEqual(standardFaults(std, [w], [...railsAlong(w), gate]), []);
});

test("a thick or tall wall fails", () => {
  const w = wall(0.8, 1.8);
  const f = standardFaults(std, [w], [...railsAlong(w), gate]);
  assert.ok(f.some((x) => /0\.8 m thick/.test(x)) && f.some((x) => /1\.8 m high/.test(x)), f.join("\n"));
});

test("railing must line the wall", () => {
  const w = wall(), rails = railsAlong(w);
  assert.ok(standardFaults(std, [w], [gate]).some((x) => /line 0 %/.test(x)));
  assert.ok(standardFaults(std, [w], [...rails.slice(0, Math.floor(rails.length / 2)), gate]).some((x) => /railing sections/.test(x)));
  // one bare side fails although the wall's total is lined (per leg)
  const bare = rails.filter((q) => !(q.at[0] === 0));
  assert.ok(bare.length / rails.length > 0.7, "most of the wall still railed");
  assert.ok(standardFaults(std, [w], [...bare, gate]).some((x) => /leg 2 .*line [0-9]+ %/.test(x)), "bare west side");
  // railing set 2 m off the wall line does not count
  assert.ok(standardFaults(std, [w], [...rails.map((q) => ({ ...q, at: [q.at[0] + 2, q.at[1] + 2] as [number, number] })), gate]).some((x) => /railing sections/.test(x)));
});

test("the gate must exist and stand in the wall's gap", () => {
  const w = wall(), rails = railsAlong(w);
  assert.ok(standardFaults(std, [w], rails).some((x) => /no gate piece/.test(x)));
  assert.ok(standardFaults(std, [w], [...rails, { ...gate, at: [5, 10] }]).some((x) => /stands in no gap/.test(x)));
});

test("burst graves, earth heaps, coffins and lych gates are denied", () => {
  const w = wall(), ok = [...railsAlong(w), gate];
  for (const prefab of ["variant-props/burst-grave-earth", "variant-props/grave-earth-heap", "posed-props/coffin-b-tilted", "posed-props/lych-gate-small"])
    assert.equal(standardFaults(std, [w], [...ok, { id: "x", prefab, at: [5, 5], width: 1 }]).length, 1, prefab);
});

test("stone: every stone piece is judged against the zone cliff tile", () => {
  const cliff: [number, number, number] = [150, 80, 60];
  assert.deepEqual(stonePieceFaults([{ id: "h1", prefab: "variant-props/gravestone-a-redstone", rgb: [140, 78, 62] }], cliff), []);
  assert.equal(stonePieceFaults([{ id: "h2", prefab: "variant-props/gravestone-a-weathered", rgb: [110, 108, 104] }], cliff).length, 1, "a grey headstone fails");
});

// L (n-yard2 widows-cairn 2026-11-10): railing cards stand ON the wall cap (layout `onWall` on a boundary wall reads the wall
// operator's station tops, report.tops), and a graveyard's gate gaps end plain (standard walls.piers false: the gate brings posts)
test("the wall operator reports its cap top at every station, following the slope", async () => {
  const { buildWall } = await import("@hitreg/core");
  const reader = { height: (x: number) => 100 + 0.1 * x, voxelSize: 2, seaLevel: 0, seed: 7 };
  const w = buildWall({ points: [[0, 0], [20, 0]], height: 0.8, thickness: 0.5, smooth: false, ends: { start: "none", end: "none" } }, reader as never, { id: "t-wall" });
  const tops = (w.report as { tops?: [number, number, number][] }).tops ?? [];
  assert.ok(tops.length >= 20, `a top per station (${tops.length})`);
  for (const [x, , y] of tops.filter((t) => t[0] > 6 && t[0] < 14)) assert.ok(Math.abs(y - (100 + 0.1 * x + 0.8)) < 0.35, `cap at x ${x}: ${y}`);
});

test("the graveyard standard ends its gate runs plain", () => {
  const a = placeArchetypeSchema.parse(JSON.parse(fs.readFileSync(archFile, "utf8")));
  assert.equal(a.standard!.walls!.piers, false);
});
