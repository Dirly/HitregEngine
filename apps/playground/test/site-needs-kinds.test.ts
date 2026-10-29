/**
 * The site-need roles and kinds the redstrand designers asked for (2026-10-29 t-needs): large-place, roadside-place,
 * subsite, biome, landmark-visible, distance-from, on-route; the designers' needs files; the dogfood place columns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureNeed, measureNeeds, needsFor, parsePlaceNeeds, routeCandidates, siteNeedSchema, unexcepted, type NeedGround, type SiteNeed, type SitedPlace } from "../tools/site-needs.mts";
import { parseNeedSpecs, seedNeedsTable } from "../tools/worldgen-dogfood-needs.mts";

const ground = (h: (x: number, z: number) => number, extra: Partial<NeedGround> = {}): NeedGround => ({ height: h, wet: (x, z) => h(x, z) < 0.3, sea: 0, ...extra });
const need = (n: Record<string, unknown>): SiteNeed => siteNeedSchema.parse(n);
const plain = ground(() => 10);
const town: SitedPlace = { id: "thirstgate", kind: "town", at: [0, 0], radius: 55 };
const dial: SitedPlace = { id: "red-dial", kind: "place", at: [1200, 0], radius: 150 };

test("biome: share of the pad in the allowed biomes/anchors, none in the forbidden one", () => {
  // badlands west of x = 0, the riparian forest east of it
  const g = ground(() => 10, { biome: (x) => (x < 0 ? { id: "badlands", zone: "badlands" } : { id: "forest", zone: "forest" }) });
  const n = need({ kind: "biome", any: ["badlands", "savanna"], none: ["forest"] });
  assert.equal(measureNeed(g, n, -300, 0, 60).met, true);
  const half = measureNeed(g, n, 0, 0, 60);
  assert.equal(half.met, false);
  assert.ok(half.faults.some((f) => /forbidden forest/.test(f)), half.message);
  assert.equal(measureNeed(plain, n, 0, 0, 60).met, false, "no sampler: unmet, said");
});

test("landmark-visible: a 36 m needle on open ground reads from 300 m; behind a ridge it does not", () => {
  const n = need({ kind: "landmark-visible", height: 36, distance: 300 });
  const open = measureNeed(plain, n, 0, 0, 60);
  assert.equal(open.met, true, open.message);
  assert.ok(Number(open.numbers.seenFrom) >= 300);
  // a 60 m ring wall 100 m out hides it from every bearing
  const walled = ground((x, z) => (Math.abs(Math.hypot(x, z) - 100) < 10 ? 70 : 10));
  const hid = measureNeed(walled, n, 0, 0, 60);
  assert.equal(hid.met, false);
  assert.match(hid.faults[0]!, /shows 0 px at best from 300 m/);
  // from a place: only the bearing toward it counts (a ridge on the town side hides it; open elsewhere)
  const ridgeWest = ground((x) => (x > 40 && x < 80 ? 60 : 10), { places: [{ ...town, at: [400, 0] }] });
  assert.equal(measureNeed(ridgeWest, need({ kind: "landmark-visible", height: 5, distance: 120, from: "town:thirstgate" }), 0, 0, 60).met, false);
  assert.equal(measureNeed(ridgeWest, need({ kind: "landmark-visible", height: 5, distance: 120 }), 0, 0, 60).met, true, "any bearing finds the open side");
});

test("distance-from: edge to edge, min and max, an unsited place is unmet", () => {
  const g = ground(() => 10, { places: [town, { id: "weeping-sun", kind: "place", at: [0, 900], radius: 60 }] });
  const far = need({ kind: "distance-from", place: "town:thirstgate", min: 700, max: 1600 });
  const r = measureNeed(g, far, 1000, 0, 150);
  assert.equal(r.met, true, r.message);
  assert.equal(r.numbers.metres, 1000 - 150 - 55);
  assert.equal(measureNeed(g, far, 600, 0, 150).met, false);
  assert.equal(measureNeed(g, far, 2500, 0, 150).met, false);
  const notUnder = need({ kind: "distance-from", place: "place:weeping-sun", min: 400 });
  assert.equal(measureNeed(g, notUnder, 0, 700, 150).met, false, "the Dial under the entrance cliff");
  assert.match(measureNeed(g, need({ kind: "distance-from", place: "place:nowhere", min: 1 }), 0, 0, 10).faults[0]!, /not sited yet/);
  assert.equal(measureNeed(g, need({ kind: "distance-from", place: "town:*", min: 10 }), 500, 0, 10).numbers.place, "town:thirstgate");
});

test("on-route: within the offset window, inside the along window, of the line between two places or a road", () => {
  const g = ground(() => 10, { places: [town, dial] });
  const n = need({ kind: "on-route", from: "town:thirstgate", to: "place:red-dial", along: [0.35, 0.65], offset: [20, 40] });
  assert.equal(measureNeed(g, n, 600, 30, 60).met, true);
  assert.equal(measureNeed(g, n, 600, 5, 60).met, false, "on the road itself");
  assert.equal(measureNeed(g, n, 200, 30, 60).met, false, "too near the town end");
  assert.equal(measureNeed(g, n, 600, 200, 60).met, false, "off the route");
  // a road between them that bows north: the road, not the straight line, is the route
  const road = { id: "r1", points: [[0, 0], [600, -300], [1200, 0]] };
  const gr = ground(() => 10, { places: [town, dial], roads: [road] });
  assert.equal(measureNeed(gr, n, 600, -270, 60).met, true, measureNeed(gr, n, 600, -270, 60).message);
  // no ends given: any road or any line between two sited places; self is not a neighbour
  const any = need({ kind: "on-route" });
  assert.equal(measureNeed(ground(() => 10, { places: [town, dial] }), any, 600, 50, 60).met, true);
  assert.equal(measureNeed(ground(() => 10, { places: [town] }), any, 600, 50, 60).met, false);
  assert.equal(measureNeed(ground(() => 10, { places: [town, dial] }), any, 600, 50, 60, { self: "red-dial" }).met, false);
  // candidates along the route sit inside both windows
  const pts = routeCandidates(g, [n]);
  assert.ok(pts.length >= 10);
  for (const [x, z] of pts) assert.equal(measureNeed(g, n, x, z, 60).met, true, `[${x}, ${z}]`);
});

test("subsite: a rock face measured at a second point under the table lip", () => {
  // a 40 m table (r 150) over a plain at 10 m; its west edge a 1:1 scarp from x = -150 down to x = -180
  const table = ground((x, z) => (Math.hypot(x, z) < 150 && x > -150 ? 50 : x <= -150 && x > -180 && Math.abs(z) < 150 ? 50 - (-150 - x) * (40 / 30) : 10));
  const sump = need({ kind: "subsite", id: "sump", within: [90, 260], below: 15, radius: 20, need: { kind: "rock-face", frontHeight: 10, ratio: 1.5, apronM2: 400, readDistance: 0, footReach: 30 } });
  const r = measureNeed(table, sump, 0, 0, 150);
  assert.equal(r.met, true, r.message);
  assert.equal(r.numbers.inner, "rock-face");
  assert.match(r.message, /^sump at \[-?\d+, -?\d+\] \d+ m [NESW]+, [\d.]+ m under the site: face/);
  // a flat plain: no ground 15 m under the site
  assert.match(measureNeed(plain, sump, 0, 0, 150).faults[0]!, /lies 15 m under the site/);
  // a subsite cannot nest a subsite
  assert.equal(siteNeedSchema.safeParse({ kind: "subsite", id: "a", need: { kind: "subsite", id: "b", need: { kind: "flat-pad" } } }).success, false);
});

test("roles: large-place and roadside-place are measured, overrides add kinds, an incomplete added need throws", () => {
  const hill = ground((x, z) => 10 + Math.max(0, 40 - Math.hypot(x, z) * 0.12));
  const big = measureNeeds(hill, "large-place", 0, 0, 150);
  assert.deepEqual(big.results.map((r) => r.need), ["flat-pad", "high-ground", "crossroads", "landmark-visible"]);
  assert.equal(big.met, true, big.results.map((r) => r.message).join(" | "));
  assert.equal(measureNeeds(plain, "large-place", 0, 0, 150).met, false, "flat ground is not high ground");
  const g = ground(() => 10, { places: [town, dial] });
  const side = measureNeeds(g, "roadside-place", 600, 40, 60);
  assert.equal(side.met, true, side.results.map((r) => r.message).join(" | "));
  const kinds = needsFor("large-place", { biome: { any: ["badlands"] }, add: [{ kind: "distance-from", place: "town:thirstgate", min: 700, edges: true }] }).map((n) => n.kind);
  assert.deepEqual(kinds.slice(-2), ["biome", "distance-from"]);
  assert.throws(() => needsFor("large-place", { "distance-from": { min: 700 } }), /distance-from \(added by the place's siteNeeds\): place/);
  // a ruling excepts a new kind like any other
  const near = measureNeeds(g, "large-place", 100, 0, 150, { add: [{ kind: "distance-from", place: "town:thirstgate", min: 700, edges: true }] });
  assert.equal(unexcepted(near).some((r) => r.need === "distance-from"), true);
  assert.equal(unexcepted(near, [{ need: "distance-from", ruling: "2026-10-29 coordinator: the Dial watches the gate" }]).some((r) => r.need === "distance-from"), false);
});

const DESIGN = path.resolve(import.meta.dirname, "..", "projects", "redstrand", "authoring", "design");

test("the redstrand designers' needs files validate, and the dogfood sites them in dependency order", { skip: !fs.existsSync(DESIGN) }, () => {
  for (const p of ["town", "large", "small", "entrance"]) {
    const f = path.join(DESIGN, p, "needs.json");
    if (!fs.existsSync(f)) continue;
    parsePlaceNeeds(JSON.parse(fs.readFileSync(f, "utf8")), f);
  }
  const order = parseNeedSpecs(`@${DESIGN}`).map((s) => s.label);
  if (order.includes("dropped-hour") && order.includes("red-dial")) assert.ok(order.indexOf("red-dial") < order.indexOf("dropped-hour"));
  if (order.includes("red-dial") && order.includes("thirstgate")) assert.ok(order.indexOf("thirstgate") < order.indexOf("red-dial"));
});

test("dogfood: @<dir> reads every needs.json in dependency order; the table has one column per place", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-"));
  try {
    const write = (sub: string, doc: object) => { fs.mkdirSync(path.join(dir, sub)); fs.writeFileSync(path.join(dir, sub, "needs.json"), JSON.stringify(doc)); };
    write("a-small", { place: "stop", siteRole: "roadside-place", siteNeeds: { "on-route": { from: "town:keep", to: "place:big" } } });
    write("b-large", { place: "big", siteRole: "large-place", siteNeeds: { add: [{ kind: "distance-from", place: "town:keep", min: 700 }] } });
    write("c-town", { town: "keep", siteRole: "walled-town", radius: 55, preferences: ["a bench over the river"] });
    const specs = parseNeedSpecs(`@${dir},grand-entrance:70:350`);
    assert.deepEqual(specs.map((s) => s.label), ["keep", "grand-entrance:70:350", "big", "stop"]);
    assert.equal(specs.find((s) => s.label === "keep")!.place!.kind, "town");
    assert.throws(() => parseNeedSpecs(`@${path.join(dir, "nope")}`), /no such file or folder/);
    const report = (met: boolean) => ({ role: "x", met, results: [{ need: "flat-pad" as const, met, numbers: {}, faults: met ? [] : ["relief"], message: "" }] });
    const table = seedNeedsTable([
      { seed: 1, needs: [{ label: "keep", met: 2, measured: 9, best: { at: [1, 2], report: report(true) } }, { label: "big", met: 0, measured: 9, best: { at: [3, 4], report: report(false) } }] },
    ]);
    assert.equal(table[0], "| seed | keep | big |");
    assert.equal(table[2], "| 1 | met 2/9 | UNMET flat-pad (best [3, 4]) |");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no need can ask for metres that make a measurement run for hours (a 1e9 m2 apron, a 1e5 m pad)", () => {
  assert.equal(siteNeedSchema.safeParse({ kind: "rock-face", apronM2: 1e9 }).success, false);
  assert.equal(siteNeedSchema.safeParse({ kind: "flat-pad", radius: 1e5 }).success, false);
  assert.equal(siteNeedSchema.safeParse({ kind: "defensible", overlookBand: 1e7 }).success, false);
  assert.equal(siteNeedSchema.safeParse({ kind: "crossroads", reach: 1e6 }).success, false);
  assert.throws(() => parsePlaceNeeds({ place: "p", siteRole: "large-place", radius: 1e6 }), /radius/);
  // the largest allowed asks still measure quickly
  const t0 = performance.now();
  measureNeed(plain, need({ kind: "rock-face", apronM2: 40_000, footReach: 400, frontHeight: 400 }), 0, 0, 60);
  measureNeed(plain, need({ kind: "flat-pad", radius: 1_000 }), 0, 0, 60);
  assert.ok(performance.now() - t0 < 5_000, `${Math.round(performance.now() - t0)} ms`);
});
