// place-build (tools/place-build.mts, tools/_place-archetype.mts): archetypes parse, the ground fit finds level dry
// ground, the plan is deterministic, and the lesson checks (approach read, stale entities, cleared structures) bite.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ribbonApproachOps, approachForBuilt, trackId, trimTrack, trackBand, TRACK_WIDTH_M, TRACK_JOIN_M,
  applySets, silhouetteHeight, forTier, approachLines, approachRead, approachReadAny, readHeightNeeded, readTargets, installGuard, RESEAT_MAX_M, SMOKE_READ_M, shoreRise, waterLevelNear, SHORE_RISE_M, routeOnRibbon, briefCount, expandRows, CAMP_ONLY_RE, ROOM_FILL, cutRing, wallGates, towerSides, withoutDenied, MIN_GATE_M, siteSearch, slopeMap, uniqueItemIds, DENIED_PROPS, fillOk, routeGrid, usableArea, approachSpots, readBand, firstPlanItems, arrangeFirstPlan, fitPocket, pickArchetype, placeArchetypeSchema, planPlace, primitiveMeshes, staleEntities, unclearedStructures, type PlaceGround,
} from "../tools/_place-archetype.mts";
import { placeLayoutSchema, withLayout, layoutCoverage, toWorld, discStats, waterAtMarker, sinkToBase, seatPad, mergeSeatPads, SEAT_PAD_MAX_M, PATH_GRADE_BAND_M, siteScale } from "../tools/_place-archetype.mts";
import { patchReaches } from "../tools/worldgen-scatter-float.mts";

const DIR = "projects/world-kit/authoring/place-archetypes";
const all = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => placeArchetypeSchema.parse(JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")))) : [];

// a gentle slope rising to the east, a 10 m bump at (40, 0), the sea west of x = -80
const ground: PlaceGround = {
  height: (x, z) => 20 + x * 0.02 + 10 * Math.exp(-((x - 40) ** 2 + z ** 2) / 200),
  wet: (x) => x < -80,
};
const input = {
  world: "w", zone: "z", project: "p",
  place: { id: "test-place", name: "Test Place", size: "medium" as const, at: [0, 0] as [number, number], faces: "S down the road" },
  reservation: { center: [0, 0] as [number, number], radius: 150, approaches: [[[0, 400], [0, 0], [0, -400]]] as [number, number][][] },
  builtStone: { face: "zone-stone/face", cap: "zone-stone/cap" },
};

test("every shipped archetype parses, and there are at least ten", () => {
  assert.ok(all.length >= 10, `${all.length} archetypes`);
  for (const a of all) assert.equal(a.pockets[0]!.id, "core");
});

test("an archetype without a fire must say why it does not read at dusk", () => {
  const raw = { id: "x", title: "x", description: "x", pockets: [{ id: "core", kind: "landmark", structures: [{ id: "s", role: "landmark", prefab: "a/b", landmark: { height: 4 } }] }] };
  assert.throws(() => placeArchetypeSchema.parse(raw), /dusk/);
  assert.doesNotThrow(() => placeArchetypeSchema.parse({ ...raw, read: { duskLight: false, reason: "wild" } }));
});

test("a hull is never a wall or a building, and fire is only the catalogued vfx fire", () => {
  const base = { id: "x", title: "x", description: "x", read: { duskLight: false, reason: "r" } };
  const s = (extra: object) => ({ ...base, pockets: [{ id: "core", kind: "shore", structures: [{ id: "lm", role: "landmark", prefab: "a/b", landmark: { height: 3 } }, extra] }] });
  assert.throws(() => placeArchetypeSchema.parse(s({ id: "w", role: "set-piece", prefab: "wreck/ship-hull-half" })), /hull/);
  assert.doesNotThrow(() => placeArchetypeSchema.parse(s({ id: "w", role: "boat", prefab: "wreck/ship-hull-half" })));
  assert.throws(() => placeArchetypeSchema.parse(s({ id: "f", role: "fire", prefab: "my/cone-fire" })), /vfx fire/);
});

test("--set swaps a slot's prefab and sets dotted fields", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, "shrine.json"), "utf8"));
  const out = applySets(raw, ["core.marker=parish-weep/weep-lych-gate", "spread.small=60", "core.radius=10"]);
  const a = placeArchetypeSchema.parse(out);
  assert.equal(a.pockets[0]!.structures[0]!.prefab, "parish-weep/weep-lych-gate");
  assert.equal(a.spread.small, 60);
  assert.equal(a.pockets[0]!.radius, 10);
});

test("the archetype is picked from the brief's words", () => {
  assert.equal(pickArchetype({ id: "lych-cairn", read: "A lone lych-gate on the bare gorge rim" }, all)?.id, "shrine");
  assert.equal(pickArchetype({ id: "carters-halt", name: "The Carters' Yard", read: "carts drawn up" }, all)?.id, "halt-yard");
  assert.equal(pickArchetype({ id: "kelp-kilns", read: "Smoking stone kelp kilns" }, all)?.id, "work-yard");
});

test("ground fit: the pad moves off the bump onto level dry ground and never into the sea", () => {
  const f = fitPocket(ground, [34, 0], { radius: 8, search: 20, near: "any", maxRelief: 3 }, { center: [0, 0], radius: 200 });
  assert.ok(f.ok, f.why);
  assert.ok(Math.hypot(f.at[0] - 40, f.at[1]) > 15, `moved off the bump: ${f.at}`);
  const w = fitPocket(ground, [-84, 0], { radius: 6, search: 12, near: "water", maxRelief: 3 }, { center: [0, 0], radius: 200 });
  assert.ok(w.at[0] - 6 >= -80, `stays dry: ${w.at}`);
});

test("the plan is deterministic and complete (pads, clearings, routes, plans, landmark)", () => {
  const a = all.find((x) => x.id === "halt-yard")!;
  const p1 = planPlace(a, input, ground), p2 = planPlace(a, input, ground);
  assert.deepEqual(JSON.parse(JSON.stringify(p1)), JSON.parse(JSON.stringify(p2)));
  assert.equal(p1.worldOps.length, p1.pockets.filter((k) => k.fit.stats.relief > 2).length);
  assert.ok(p1.ops.length > 3 && p1.operators.some((o) => o.op === "wall") && p1.operators.some((o) => o.op === "path"));
  assert.ok(p1.handoff.navigation.routes.length >= 2 && p1.handoff.landmark);
  assert.deepEqual(unclearedStructures(p1.handoff.siteDressing.keepClear, p1.clearings), []);
  // an outline clearing (no centre) never crashes the check (RETTING 2026-10-23: the place gate died 'reading 0')
  assert.deepEqual(unclearedStructures(p1.handoff.siteDressing.keepClear, [...p1.clearings, { polygon: [[0, 0], [1, 0], [1, 1]] } as never]), []);
  assert.deepEqual(primitiveMeshes(p1.ops), []);
  assert.ok(p1.clearings.every((c) => c.cover === true || /-lane-/.test(c.id)));
  // every route lane is cleared of scatter (a polygon round the planned line)
  for (const r of p1.handoff.navigation.routes) assert.ok(p1.clearings.some((c) => c.id === `test-place-lane-${r.id}` && c.scatter && c.polygon.length >= 4));
  // front faces south (+z): the other pockets spread behind the core (north), away from the approach
  for (const k of p1.pockets.slice(1)) assert.ok(k.at[1] < p1.centre[1] - 50, `${k.id} ${k.at}`);
});

test("a wall over 3 m gets buttresses (lesson REV-WS1 F1)", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, "halt-yard.json"), "utf8"));
  raw.pockets[0].walls[0].height = 3.5;
  const a = placeArchetypeSchema.parse(raw);
  const plan = planPlace(a, input, ground);
  assert.ok(plan.operators.find((o) => o.op === "wall").buttresses);
});

test("approach read: judged per tier window; a hill blocks it, open ground reads, a short line uses its far end", () => {
  assert.deepEqual(readBand("small"), [113, 150]);
  assert.deepEqual(readBand("medium"), [225, 300]);
  assert.deepEqual(readBand("large", [100, 200]), [100, 200]);
  const spots = approachSpots([0, 0], [[[0, 400], [0, 0]]], readBand("medium"));
  assert.ok(spots.length >= 4 && spots.every((s) => s.d >= 225 && s.d <= 300));
  const open = approachRead({ height: () => 0, wet: () => false }, { at: [0, 0], top: 5, fogReach: 450 }, spots);
  assert.ok(open.ok && open.rows.length === 1);
  const hill = approachRead({ height: (_x, z) => (z > 60 && z < 100 ? 30 : 0), wet: () => false }, { at: [0, 0], top: 5, fogReach: 450 }, spots);
  assert.ok(!hill.ok && hill.rows.every((r) => r.blockedAt !== null));
  const fog = approachRead({ height: () => 0, wet: () => false }, { at: [0, 0], top: 5, fogReach: 120 }, spots);
  assert.ok(!fog.ok);
  // small tier: the same hill sits beyond 150 m? no: a hill at 200 m does not matter to a small place read at 113-150 m
  const small = approachSpots([0, 0], [[[0, 400], [0, 0]]], readBand("small"));
  assert.ok(approachRead({ height: (_x, z) => (z > 190 && z < 210 ? 40 : 0), wet: () => false }, { at: [0, 0], top: 5, fogReach: 450 }, small).ok);
  assert.ok(!approachRead({ height: (_x, z) => (z > 190 && z < 210 ? 40 : 0), wet: () => false }, { at: [0, 0], top: 5, fogReach: 450 }, spots).ok);
  // a line that stops 80 m out is judged from its far end
  const short = approachSpots([0, 0], [[[0, 80], [0, 0]]], readBand("medium"));
  assert.equal(short.length, 1); assert.equal(Math.round(short[0]!.d), 80);
});

test("approach read: a smoke column reads over a convex rise that hides a low landmark", () => {
  const dome = { height: (_x: number, z: number) => Math.max(0, 150 - Math.max(0, z - 60) * 0.6), wet: () => false };
  const lines = [[[0, 300], [0, 0]]] as [number, number][][];
  const low = approachReadAny(dome, [{ at: [0, 0], top: 153.5, fogReach: 500 }], lines, readBand("medium"));
  assert.ok(!low.ok);
  const lit = approachReadAny(dome, [{ at: [0, 0], top: 153.5, fogReach: 500 }, { at: [0, -9], top: 190, fogReach: 500 }], lines, readBand("medium"));
  assert.ok(lit.ok && lit.rows[0]!.target === "smoke");
  // only the plan's own approach line is charged; a coast road passing under a cliff is reported, not failed
  const two = [lines[0]!, [[300, 0], [0, 0]]] as [number, number][][];
  const wall = { height: (x: number, _z: number) => (x > 40 && x < 60 ? 80 : 0), wet: () => false };
  const both = approachReadAny(wall, [{ at: [0, 0], top: 5, fogReach: 500 }], two, readBand("medium"));
  assert.ok(!both.ok && both.unread.join() === "1");
  assert.ok(approachReadAny(wall, [{ at: [0, 0], top: 5, fogReach: 500 }], two, readBand("medium"), [0]).ok);
});

// segment a-b crosses segment c-d
const cross = (a: number[], b: number[], c: number[], d: number[]) => { const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!)); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
const segD = (q: number[], a: number[], b: number[]) => { const dx = b[0]! - a[0]!, dz = b[1]! - a[1]!, L = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((q[0]! - a[0]!) * dx + (q[1]! - a[1]!) * dz) / L)); return Math.hypot(q[0]! - a[0]! - t * dx, q[1]! - a[1]! - t * dz); };
const wallSegs = (plan: any) => plan.operators.filter((o: any) => o.op === "wall").flatMap((o: any) => o.points.slice(1).map((q: number[], i: number) => [o.points[i], q]));

test("routes are planned over the ground: round a structure, through a gate gap, never through a wall", () => {
  const flat: PlaceGround = { height: () => 0, wet: () => false };
  const disc = routeGrid(flat, [0, 10], [0, -40], { discs: [{ at: [0.5, 0], r: 2 }], segs: [] })!;
  for (let i = 0; i + 1 < disc.length; i++) for (let t = 0; t <= 20; t++) {
    const q: [number, number] = [disc[i]![0] + ((disc[i + 1]![0] - disc[i]![0]) * t) / 20, disc[i]![1] + ((disc[i + 1]![1] - disc[i]![1]) * t) / 20];
    assert.ok(Math.hypot(q[0] - 0.5, q[1]) >= 2.7, `${q} inside the post`);
  }
  // a wall across the way with a 3 m gate at x = 20: the route goes through the gap
  const wall = { discs: [], segs: [[[-40, 0], [18.5, 0], 0.4], [[21.5, 0], [60, 0], 0.4]] as [[number, number], [number, number], number][] };
  const via = routeGrid(flat, [0, 15], [0, -15], wall)!;
  for (let i = 0; i + 1 < via.length; i++) for (const [p, q] of wall.segs) assert.ok(!cross(via[i]!, via[i + 1]!, p, q), `leg ${via[i]} -> ${via[i + 1]} crosses the wall`);
  assert.ok(via.some((q) => q[0] > 15 && q[0] < 25), "through the gate");
});

test("routes keep off steep ground: a steep knoll on the straight line is walked round, never climbed", () => {
  // a 30 m cone (slope 3) between the ends
  const g: PlaceGround = { height: (x, z) => Math.max(0, 30 - 3 * Math.hypot(x, z)), wet: () => false };
  const r = routeGrid(g, [0, -20], [0, 20], { discs: [], segs: [] })!;
  assert.ok(r, "a way exists");
  for (let i = 0; i + 1 < r.length; i++) {
    const n = Math.ceil(Math.hypot(r[i + 1]![0] - r[i]![0], r[i + 1]![1] - r[i]![1]));
    for (let t = 0; t < n; t++) {
      const p = [r[i]![0] + ((r[i + 1]![0] - r[i]![0]) * t) / n, r[i]![1] + ((r[i + 1]![1] - r[i]![1]) * t) / n], q = [r[i]![0] + ((r[i + 1]![0] - r[i]![0]) * (t + 1)) / n, r[i]![1] + ((r[i + 1]![1] - r[i]![1]) * (t + 1)) / n];
      assert.ok(Math.abs(g.height(q[0]!, q[1]!) - g.height(p[0]!, p[1]!)) / Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!) <= 0.75, `steep step at ${p}`);
    }
  }
  assert.equal(routeGrid({ height: (_x, z) => (z > 0 ? 50 : 0), wet: () => false }, [0, -10], [0, 10], { discs: [], segs: [] }, { margin: 10 }), null, "a cliff all round: no way");
});

test("a walled graveyard: every route goes through its gates and round the bell post, never through the wall (strangers-acre)", () => {
  const a = all.find((x) => x.id === "graveyard")!, plan = planPlace(a, input, ground), walls = wallSegs(plan);
  const posts = plan.ops.filter((o: any) => o.entity?.components?.prefab).map((o: any) => o.entity.components.transform.position).map((p: number[]) => [p[0]! + plan.centre[0], p[2]! + plan.centre[1]]);
  for (const r of plan.handoff.navigation.routes) {
    const pts = r.points.map((q: number[]) => [q[0], q[2]]);
    for (let i = 0; i + 1 < pts.length; i++) {
      for (const [p, q] of walls) assert.ok(!cross(pts[i], pts[i + 1], p, q), `${r.id} leg ${i} crosses a wall`);
      for (const b of posts) assert.ok(segD(b, pts[i], pts[i + 1]) >= 1.5, `${r.id} leg ${i} passes through a structure at ${b}`);
    }
  }
  // the footpath ribbons follow the planned lines, so they never cross a wall either
  for (const p of plan.operators.filter((o: any) => o.op === "path")) for (let i = 0; i + 1 < p.points.length; i++) for (const [a2, b2] of walls) assert.ok(!cross(p.points[i], p.points[i + 1], a2, b2), `${p.id} crosses a wall`);
  assert.deepEqual(plan.faults, []);
  // every clearing a body can stand in is reached from the route graph in a straight line that meets no wall
  const graph = plan.handoff.navigation.routes.flatMap((r: any) => r.points.slice(1).flatMap((q: number[], i: number) => { const p = r.points[i], n = Math.max(1, Math.ceil(Math.hypot(q[0]! - p[0], q[2]! - p[2]) / 2)); return Array.from({ length: n + 1 }, (_, t) => [p[0] + ((q[0]! - p[0]) * t) / n, p[2] + ((q[2]! - p[2]) * t) / n]); })); // poi-walk: 2 m samples
  for (const c of plan.clearings.filter((x: any) => x.center)) { if (posts.some((b: number[]) => Math.hypot(b[0]! - c.center[0], b[1]! - c.center[1]) < 3)) continue;
    const n = graph.reduce((m: number[], q: number[]) => (Math.hypot(q[0]! - c.center[0], q[1]! - c.center[1]) < Math.hypot(m[0]! - c.center[0], m[1]! - c.center[1]) ? q : m));
    for (const [p, q] of walls) assert.ok(!cross(n, c.center, p, q), `${c.id}: its reach from ${n} crosses a wall`); }
});

test("bank lines (cuttings): the approach and the pocket routes never cross a bank (retting-ponds)", () => {
  const a = all.find((x) => x.id === "cuttings")!, plan = planPlace(a, input, ground), walls = wallSegs(plan);
  assert.ok(walls.length > 0);
  for (const r of plan.handoff.navigation.routes) { const pts = r.points.map((q: number[]) => [q[0], q[2]]); for (let i = 0; i + 1 < pts.length; i++) for (const [p, q] of walls) assert.ok(!cross(pts[i], pts[i + 1], p, q), `${r.id} leg ${i} crosses a bank`); }
});

test("denied catalogue pieces are never placed: a denied slot takes its first allowed choice, fill skips them, wrong culture is a plan fault", () => {
  // the case needs the chain-post denied (it is, for its self z-fight; denied here if a fix ever lifts it)
  const wasDenied = !!DENIED_PROPS["spoilgate/chain-post"]; if (!wasDenied) DENIED_PROPS["spoilgate/chain-post"] = "test: denied";
  const plan = planPlace(placeArchetypeSchema.parse(JSON.parse(fs.readFileSync(path.join(DIR, "beach-landing.json"), "utf8"))), input, ground);
  const prefabs = plan.ops.map((o: any) => o.entity?.components?.prefab?.prefabId).filter(Boolean);
  assert.ok(!prefabs.some((p: string) => DENIED_PROPS[p]), prefabs.join());
  assert.ok(plan.notes.some((n) => n.includes("spoilgate/chain-post")));
  for (const d of plan.plans) for (const it of d.items) assert.ok(!DENIED_PROPS[it.prop], it.prop);
  if (!wasDenied) delete DENIED_PROPS["spoilgate/chain-post"];
  const items = firstPlanItems([], "core", 9, "yard", fillOk({ culture: ["rural"], deny: [] }, (p) => ({ cultures: p.includes("banner") ? ["bandit"] : ["rural"] })));
  assert.ok(items.length >= 2 && items.every((i) => !DENIED_PROPS[i.prop] && !i.prop.includes("banner")));
  const info = (p: string) => (p.includes("gravestone") ? { cultures: ["crypt", "sacred"] } : null);
  const grave = placeArchetypeSchema.parse({ ...JSON.parse(fs.readFileSync(path.join(DIR, "graveyard.json"), "utf8")), culture: ["rural"] });
  assert.ok(planPlace(grave, { ...input, propInfo: info }, ground).faults.some((f) => f.includes("wrong-culture")));
  assert.deepEqual(planPlace(all.find((x) => x.id === "graveyard")!, { ...input, propInfo: info }, ground).faults, []);
});

test("usable area floods from every pocket: ground beyond a steep bank still counts when a pocket stands on it", () => {
  const g: PlaceGround = { height: (x) => (x > 20 && x < 24 ? (x - 20) * 5 : x >= 24 ? 20 : 0), wet: () => false };
  const core = usableArea(g, [0, 0], 60), both = usableArea(g, [0, 0], 60, undefined, [[40, 0]]);
  assert.ok(both > core + 2000, `${core} -> ${both}`);
});

test("a low yard wall's gates are real gaps: the ring is cut into runs between them", () => {
  const sq: [number, number][] = [[13, -13], [-13, -13], [-13, 13], [13, 13], [13, -13]];
  const runs = cutRing(sq, [{ at: 13, width: 3 }, { at: 65, width: 4.5 }]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0]![0], [-1.5, -13]); assert.deepEqual(runs[0]!.at(-1), [-2.25, 13]);
  assert.deepEqual(runs[1]![0], [2.25, 13]); assert.deepEqual(runs[1]!.at(-1), [1.5, -13]);
  assert.equal(runs[1]!.length, 4); // through the two corners [13,13] and [13,-13]
  const one = cutRing(sq, [{ at: 65, width: 4 }]);
  assert.equal(one.length, 1); assert.equal(one[0]!.length, 6);
});

test("stale entities: a reinstall leaves nothing the source no longer delivers", () => {
  const scene = { entities: { "poi-x": { tags: ["poi:x"] }, "x-core-old-lining": { tags: ["poi:x"] }, "dress-x-core-crate-1": { tags: ["poi:x"] }, other: { tags: [] } } };
  assert.deepEqual(staleEntities(scene, "x", new Set(["poi-x"])), ["x-core-old-lining"]);
});

test("first dressing plans meet the room minimum dress check asks, topping up with non-containers", () => {
  const items = firstPlanItems([{ prop: "poi-props/crate", count: 1, prefer: "wall" }, { prop: "rock-kit/boulder-s-1", count: 1, prefer: "open" }], "core", 6);
  assert.equal(items.length, 6);
  assert.equal(items.filter((i) => i.prop === "poi-props/crate").length, 1);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
});

test("routes and areas end where a body can stand: never inside a kiln, a dyke or a structure", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, "work-yard.json"), "utf8"));
  raw.pockets[1].walls[0].points = [[-8, 0], [8, 0]]; // a dyke straight through the pocket centre
  const a = placeArchetypeSchema.parse(raw), plan = planPlace(a, input, ground);
  const dyke = plan.pockets[1]!, route = plan.handoff.navigation.routes.find((r: any) => r.id === "to-dyke");
  const end = route.points[route.points.length - 1];
  assert.ok(Math.hypot(end[0] - dyke.at[0], end[2] - dyke.at[1]) >= 2.5, `route end ${end} clear of the dyke at ${dyke.at}`);
});

// ---- PB-FIX (2026-10-20): pockets go on level ground, no straight fallback paths, unique dressing ids, capped shots
// a 42 deg gully under the reservation's centre, a level plateau east of x = 60 (y 54), a road along x = 250
const gully: PlaceGround = { height: (x, z) => (x >= 60 ? 54 + z * 0.005 : 0.9 * Math.abs(x)), wet: () => false };
const gullyIn = {
  world: "w", zone: "z", project: "p",
  place: { id: "gully-place", name: "Gully Place", size: "small" as const, at: [0, 0] as [number, number] },
  reservation: { center: [0, 0] as [number, number], radius: 130, approaches: [[[250, -400], [250, 400]]] as [number, number][][] },
};
const den = () => all.find((a) => a.id === "den") ?? placeArchetypeSchema.parse({ id: "den", title: "d", description: "d", read: { duskLight: false, reason: "r" },
  pockets: [{ id: "core", kind: "lair", radius: 9, structures: [{ id: "lm", role: "landmark", prefab: "a/b", landmark: { height: 4 } }] }, { id: "bones", kind: "lair", at: [-0.5, -0.87], radius: 7 }, { id: "rim", kind: "lookout", at: [0.5, -0.87], radius: 6 }] });

test("site search moves the core and every pocket out of a gully onto level connected ground, off the road", () => {
  const a = den(), roadR = 4.5;
  const site = siteSearch(a, gullyIn, gully, { needM2: 3000, blockers: { segs: [[[250, -400], [250, 400], roadR]], discs: [] } });
  assert.ok(site, "a layout on the plateau");
  for (const [id, at] of Object.entries(site!.pockets)) {
    const r = a.pockets.find((p) => p.id === id)!.radius;
    assert.ok(at[0] - r >= 60, `${id} at ${at} stands on the plateau, not the gully side`);
    assert.ok(Math.abs(at[0] - 250) > roadR + r - 0.01, `${id} at ${at} keeps off the road corridor`);
  }
  assert.ok(site!.relief < 1, `pads relief ${site!.relief}`);
  assert.ok(site!.moved > 60 && /reserved disc/.test(site!.why));
  // the planner builds exactly there: no relief fault, every route planned (no straight fallback)
  const p = planPlace(a, { ...gullyIn, place: { ...gullyIn.place, at: site!.at }, pocketAt: site!.pockets }, gully);
  assert.deepEqual(p.faults.filter((f) => /pocket|route/.test(f)), [], p.faults.join("; "));
});

test("a pinned --at only refines 14 m round the pin; a pin in the gully finds nothing", () => {
  const a = den();
  assert.equal(siteSearch(a, gullyIn, gully, { needM2: 3000, pinned: [-30, 0] }), null);
  const s = siteSearch(a, gullyIn, gully, { needM2: 3000, pinned: [120, 0] });
  assert.ok(s && Math.hypot(s.at[0] - 120, s.at[1]) <= 14.01, `${s?.at}`);
});

test("slope map: water and steep cells are not usable; components part across a cliff", () => {
  const m = slopeMap(gully, [60, 0], 40);
  const at = (x: number, z: number) => Math.round((z - m.z0) / m.step) * m.nx + Math.round((x - m.x0) / m.step);
  assert.equal(m.ok[at(40, 0)], 0, "the 42 deg gully side is not usable");
  assert.equal(m.ok[at(80, 0)], 1);
  assert.notEqual(m.comp[at(80, 0)], m.comp[at(21, 0)]);
});

test("a leg the ground holds no way for is a FIT fault and gets no footpath (no graded straight line)", () => {
  const a = den();
  // the core on the plateau, `bones` forced to the far gully bottom across the 42 deg bank
  const p = planPlace(a, { ...gullyIn, place: { ...gullyIn.place, at: [120, 0] }, pocketAt: { core: [120, 0], bones: [-80, 0], rim: [140, 60] } }, gully);
  assert.ok(p.faults.some((f) => /route core -> bones: no walkable way/.test(f)), p.faults.join("; "));
  assert.ok(!p.operators.some((o) => o.id === "pb-gully-place-to-bones"), "no path operator for the failed leg");
});

test("dressing item ids are made unique (the dup fill-1-1 dress check refused)", () => {
  const ids = uniqueItemIds([{ id: "fill-1-1" }, { id: "fill-1-1" }, { id: "crate-1" }, { id: "fill-1-1" }]).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 3), ["fill-1-1", "fill-1-1-b", "crate-1"]);
});

test("a capped tool run is killed at its deadline and says TIMEOUT (shots never hang the heavy slot)", async () => {
  const { runCapped } = await import("../tools/_run-capped.mts");
  const t0 = Date.now(), r = await runCapped(["-e", "setTimeout(() => {}, 20000)"], 800);
  assert.equal(r.timedOut, true); assert.equal(r.status, 124); assert.match(r.out, /TIMEOUT/);
  assert.ok(Date.now() - t0 < 10000);
  const ok = await runCapped(["-e", "console.log('done')"], 10000);
  assert.equal(ok.status, 0); assert.equal(ok.timedOut, false);
});

test("a creature clearing never sits on a structure (wolfhollow: boulder on the clearing made it unreachable)", () => {
  const a = den(), core = a.pockets[0]!;
  if (!core.encounter) return;
  const p = planPlace(a, { ...gullyIn, place: { ...gullyIn.place, at: [120, 0] }, pocketAt: { core: [120, 0] } }, gully);
  const enc = p.encounters.find((e) => e.id.endsWith("enc-core"))!;
  for (const s of core.structures) {
    const op = p.ops.find((o) => o.id === `gully-place-core-${s.id}`)!, pos = op.entity.components.transform.position;
    assert.ok(Math.hypot(pos[0] + 120 - enc.center[0], pos[2] - enc.center[1]) >= s.footprint + 1.49, `${s.id} clear of the clearing centre`);
  }
});

test("a tower's door spans one face: fewer sides when the face is narrower than the door + 0.8 m (fowlers-drop 2026-10-21)", () => {
  assert.equal(towerSides({ sides: 12, size: 4.5, gate: 2.4 }), 8, "a 2.4 m door on a 4.5 m tower: 12 faces of 2.33 m -> 8 of 3.44 m");
  assert.equal(towerSides({ sides: 12, size: 4.3, gate: 0 }), 12, "no door: the sides as asked");
  assert.equal(towerSides({ sides: 16, size: 9, gate: 2.4 }), 16, "a wide tower keeps its sides");
});

test("a curtain cut at a gatehouse: its ends buried in the gatehouse body are no door jambs (ravenstacks 2026-10-21)", () => {
  // the gatehouse: a 7 m square with arched doors on its west (s 3.5) and east (s 17.5) sides; the curtain ring, cut at
  // the gatehouse, is ONE open run whose two ends (6 m apart) stand inside the gatehouse's south and north walls
  const house = cutRing([[-3.5, -3.5], [-3.5, 3.5], [3.5, 3.5], [3.5, -3.5], [-3.5, -3.5]], [{ at: 3.5, width: 3.2 }, { at: 17.5, width: 3.2 }]);
  const curtain: [number, number][][] = [[[0, -3], [0, -26], [-40, -26], [-40, 26], [0, 26], [0, 3]]];
  const runs = [...house, ...curtain], hw = [...house.map(() => 0.9 + 0.4), ...curtain.map(() => 1.1 + 0.4)];
  const gates = wallGates(runs, hw);
  assert.equal(gates.length, 2, `the two doors only: ${JSON.stringify(gates.map((g) => [g.a, g.b]))}`);
  for (const g of gates) assert.ok(Math.abs(Math.abs(g.a[0]) - 3.5) < 0.01 && Math.abs(Math.abs(g.b[0]) - 3.5) < 0.01, "each gate spans a door in the west or east wall");
});

test("a narrow croft door (1.4 m, pier-ended square) is walked on its centre line, never through the wall (shielings)", () => {
  const flat: PlaceGround = { height: () => 0, wet: () => false };
  // the wall operator's square of size 4 with a 1.4 m gate on its west side: an open run from one door pier round to the other
  const run: [number, number][] = [[-4, 0.7], [-4, 4], [4, 4], [4, -4], [-4, -4], [-4, -0.7]];
  const segs = run.slice(1).map((q, i) => [run[i]!, q, 0.35 + 0.4] as [[number, number], [number, number], number]);
  const gates = wallGates([run], 0.75);
  assert.equal(gates.length, 1, "one gap: the door");
  assert.equal(routeGrid(flat, [-30, 0], [0, 0], { discs: [], segs }), null, "without the gate the door is too narrow for the router");
  for (const to of [[0, 0], [1.5, -1]] as [number, number][]) {
    const via = routeGrid(flat, [-30, 20], to, { discs: [], segs, gates })!;
    assert.ok(via, `a way in to ${to}`);
    for (let i = 0; i + 1 < via.length; i++) for (const [p, q] of segs) assert.ok(!cross(via[i]!, via[i + 1]!, p, q), `leg ${via[i]} -> ${via[i + 1]} crosses the wall`);
    // it passes the wall line x = -4 inside the door's walkable strip (|z| <= 0.05)
    for (let i = 0; i + 1 < via.length; i++) { const [a, b] = [via[i]!, via[i + 1]!]; if ((a[0] + 4) * (b[0] + 4) < 0) { const t = (-4 - a[0]) / (b[0] - a[0]), z = a[1] + (b[1] - a[1]) * t; assert.ok(Math.abs(z) <= 0.06, `crosses the door line at z ${z}`); } }
  }
});

test("site search: no layout at 0.6-1.25 x spread on a small mesa -> a COMPACT layout on it, never satellites down the cliff (hags-nose)", () => {
  const a = { ...den(), spreadMax: undefined }, spread = a.spread.medium, M = 0.29 * spread + 9; // the uncapped fallback (spreadMax would fit a normal layout)
  const mesa: PlaceGround = { height: (x, z) => { const d = Math.hypot(x - 200, z); return d <= M ? 54 : 54 - 1.2 * (d - M); }, wet: () => false };
  const inp = { ...gullyIn, place: { ...gullyIn.place, size: "medium" as const, at: [200, 0] as [number, number] }, reservation: { center: [200, 0] as [number, number], radius: 30, approaches: [] as [number, number][][] } };
  const site = siteSearch(a, inp, mesa, { needM2: 1000 });
  assert.ok(site, `a compact layout on the mesa (spread ${spread}, mesa r ${M})`);
  assert.match(site!.why, /^COMPACT/);
  for (const [id, at] of Object.entries(site!.pockets)) assert.ok(Math.hypot(at[0] - 200, at[1]) + a.pockets.find((p) => p.id === id)!.radius * 0.5 <= M, `${id} at ${at} on the mesa`);
});

test("approach lines are resolved from the world when the reservation names only `from` (peat-banks, gibbet-rise)", () => {
  const recipe = { features: { roads: [{ id: "path-a", points: [[-2000, 0, 0], [-500, 0, 0], [0, 0, 100], [500, 0, 100], [2000, 0, 0]] }], rivers: [{ id: "weep", points: [[0, 0, -900], [0, 0, -1200]] }], towns: [{ id: "town-1", center: [300, 0, 300] }], pois: [] }, regions: [{ id: "stone-row", polygon: [[100, -100], [140, -100], [140, -60], [100, -60]] }] };
  const res = { center: [0, 0] as [number, number], approach: { from: "path-a", points: [] }, approaches: [{ from: "stone-row", points: [] }, { from: "weep", points: [] }, { from: "town-1", points: [] }, { from: "other", points: [] }, { from: "nowhere", points: [] }, { from: "given", points: [[5, 5], [9, 9]] }] };
  const r = approachLines(recipe, [{ location: "other", center: [-300, 50] }], res);
  assert.deepEqual(r.unresolved, ["nowhere"]);
  assert.equal(r.lines.length, 6);
  assert.deepEqual(r.lines[0], [[-500, 0], [0, 100], [500, 100]], "the road's stretch within 600 m");
  assert.deepEqual(r.lines[1], [[120, -80], [0, 0]], "a region: its centroid to the centre");
  assert.deepEqual(r.lines[2], [[0, -900], [0, 0]], "a river: its nearest point to the centre");
  assert.deepEqual(r.lines[3], [[300, 300], [0, 0]]);
  assert.deepEqual(r.lines[4], [[-300, 50], [0, 0]]);
  assert.deepEqual(r.lines[5], [[5, 5], [9, 9]], "given points are kept");
});

test("the ruined tower is placeable again: its floor slab sits 7 cm under the origin plane, so it no longer z-fights level ground (old-dun; PROP-1 2026-10-20)", () => {
  assert.equal(DENIED_PROPS["old-watch/ruined-tower"], undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, "watch-ruin.json"), "utf8"));
  const notes: string[] = [], faults: string[] = [];
  const w = withoutDenied(placeArchetypeSchema.parse(applySets(raw, ["core.tower=old-watch/ruined-tower"])), undefined, faults, notes);
  assert.deepEqual(faults, []);
  assert.equal(w.pockets[0]!.structures.find((s) => s.id === "tower")!.prefab, "old-watch/ruined-tower");
});

test("scatter-float charges a masked height patch only where it has weight, not over its whole rectangle (gibbet-rise hoodoo)", () => {
  // a 100 x 100 m patch, 11 x 11 samples, weight only along its west column (x = 0)
  const weights = Array.from({ length: 121 }, (_, k) => (k % 11 === 0 ? 1 : 0));
  const h = { origin: [0, 0], size: [100, 100], columns: 11, rows: 11, weights, feather: 2 };
  assert.ok(patchReaches(h, 3, 50), "beside the weighted column");
  assert.ok(!patchReaches(h, 60, 50), "inside the rectangle, 60 m from any weight");
  assert.ok(!patchReaches(h, 200, 50), "outside the rectangle");
  assert.ok(patchReaches({ origin: [0, 0], size: [100, 100] }, 60, 50), "an unmasked patch reaches its whole rectangle");
});

test("a wall gate is never narrower than MIN_GATE_M: the 1.4 m croft door is built 2.2 m (voxel walls, piers, 0.84 m body)", () => {
  const croft = all.find((a) => a.id === "croft-row")!;
  const p = planPlace(croft, input, ground), walls = p.operators.filter((o: any) => o.op === "wall");
  assert.ok(walls.length);
  for (const w of walls) { const gaps = wallGates([w.points], 0); for (const gt of gaps) assert.ok(Math.hypot(gt.a[0] - gt.b[0], gt.a[1] - gt.b[1]) >= MIN_GATE_M - 0.05, `${w.id}: gap ${Math.hypot(gt.a[0] - gt.b[0], gt.a[1] - gt.b[1]).toFixed(2)} m`); }
});

test("the brief's count names the row: number words or digits before a shell noun, the largest, null when none", () => {
  const nouns = ["hut", "croft"];
  assert.equal(briefCount("the shieling huts: five turf-roofed stone huts on the lake's west shore", nouns), 5);
  assert.equal(briefCount("3 crofts by the burn", nouns), 3);
  assert.equal(briefCount("two huts and four crofts", nouns), 4);
  assert.equal(briefCount("Turf-roofed summer huts on a long lake shore", nouns), null);
  assert.equal(briefCount(undefined, nouns), null);
});

test("a croft ROW is N shells from the brief (default 3, cap 5), ~6 x 4 m, doors on the yard, byre and fold facing it (shielings)", () => {
  const croft = all.find((a) => a.id === "croft-row")!;
  const flat: PlaceGround = { height: () => 10, wet: () => false };
  const plan = (text?: string) => planPlace(croft, { ...input, place: { ...input.place, text } }, flat);
  const shells = (p: ReturnType<typeof plan>) => [...new Set(p.operators.filter((o: any) => /-core-croft-\d+-\d+$/.test(o.id)).map((o: any) => o.id.replace(/-\d+$/, "")))];
  const five = plan("the shieling huts: five turf-roofed stone huts on the lake's west shore (the landmark)");
  assert.equal(shells(five).length, 5, shells(five).join());
  assert.equal(shells(plan()).length, 3, "no number in the brief: 3");
  assert.equal(shells(plan("seven huts in a row")).length, 5, "capped at 5");
  assert.ok(five.notes.some((n) => /row of 5 shells 6 x 4 m/.test(n)), five.notes.join("; "));
  assert.equal(five.pockets[0]!.radius, 22, "the core grows to hold a 40 m row");
  // each shell is 6 x 4 m (wall centre lines), its door gap on the yard side (+z in the place frame = toward the approach)
  const front = five.front, core = five.centre, local = (q: number[]) => { const dx = q[0]! - core[0], dz = q[1]! - core[1]; return [dx * front[1] - dz * front[0], dx * front[0] + dz * front[1]]; };
  for (const id of shells(five)) {
    const runs = five.operators.filter((o: any) => o.id.startsWith(`${id}-`)), pts = runs.flatMap((o: any) => o.points.map(local));
    const xs = pts.map((q: number[]) => q[0]), zs = pts.map((q: number[]) => q[1]);
    assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 6) < 0.1 && Math.abs(Math.max(...zs) - Math.min(...zs) - 4) < 0.1, `${id}: ${(Math.max(...xs) - Math.min(...xs)).toFixed(1)} x ${(Math.max(...zs) - Math.min(...zs)).toFixed(1)}`);
    const gaps = wallGates(runs.map((o: any) => o.points), 0);
    assert.equal(gaps.length, 1, `${id}: one door`);
    assert.ok(local(gaps[0]!.a)[1]! > Math.max(...zs) - 0.1, `${id}: the door is on the yard side`);
  }
  // the byre opens on its back (toward the row), the landmark is the middle shell
  const byre = five.operators.filter((o: any) => /-core-byre-\d+$/.test(o.id)), bz = byre.flatMap((o: any) => o.points.map(local)).map((q: number[]) => q[1]);
  const door = wallGates(byre.map((o: any) => o.points), 0)[0]!;
  assert.ok(local(door.a)[1]! < Math.min(...bz) + 0.1, "the byre door faces the yard");
  assert.equal(five.operators.filter((o: any) => o.fog).length, 1);
  assert.ok(five.propRequests.some((q) => q.name === "turf croft hut, 6x4 m, human/rural"));
  assert.deepEqual(five.faults.filter((f) => /route|pocket/.test(f)), [], five.faults.join("; "));
  // the site search sees the grown core (expandRows is idempotent)
  assert.equal(expandRows(expandRows(croft, { size: "medium", text: "five huts" }), { size: "medium", text: "five huts" }).pockets[0]!.walls.filter((w) => /^croft-/.test(w.id)).length, 5);
});

test("fill never takes camp gear (banners, porter frames, tents) outside the camp archetype (weep-well, hags-nose)", () => {
  for (const [role, list] of Object.entries(ROOM_FILL)) if (role !== "camp") assert.ok(!list.some((p) => CAMP_ONLY_RE.test(p)), `${role}: ${list}`);
  const ok = fillOk({ culture: ["rural"], deny: [], id: "shrine" }, () => ({ cultures: ["any"] }));
  for (const p of ["camp-props/banner", "town-craft/porters-back-frame", "giant-camp/hide-tent", "camp-props/tent"]) assert.equal(ok(p), false, p);
  assert.equal(fillOk({ culture: ["rural"], deny: [], id: "camp" }, () => ({ cultures: ["rural"] }))("town-craft/porters-back-frame"), true);
  for (const a of all.filter((x) => x.id !== "camp")) for (const d of planPlace(a, input, ground).plans) for (const it of d.items)
    if (/^fill|^[a-z-]+-\d+$/.test(it.id) && !a.pockets.some((p) => p.dressing?.props.some((q) => q.prop === it.prop))) assert.ok(!CAMP_ONLY_RE.test(it.prop), `${a.id}: fill ${it.prop}`);
});

test("a shrine's ring: a shore paint band round the brief's tarn + stones on its dry rim, a prop request for the true reeds (weep-well)", () => {
  const shrine = all.find((a) => a.id === "shrine")!;
  const lake = { id: "tarn", center: [70, 0] as [number, number], radius: 20, waterY: 19 };
  const g: PlaceGround = { height: (x, z) => 20 + Math.max(0, 1 - Math.hypot(x - 70, z) / 20) * -2, wet: (x, z) => Math.hypot(x - 70, z) < 20 || x < -80 };
  const text = "The black tarn, ringed with reeds killed white by salt. the salt ring: dead white reeds and wrack round the tarn";
  const p = planPlace(shrine, { ...input, place: { ...input.place, at: [40, 0], text }, waters: [lake] }, g);
  const paint = p.worldOps.find((w: any) => w.kind === "groundPaints") as any;
  assert.ok(paint, "a ground paint");
  assert.deepEqual(paint.feature.center, [70, 0]);
  assert.equal(paint.feature.radius, 26);
  assert.deepEqual(paint.feature.height, [18, 21.5]);
  const stones = p.ops.filter((o: any) => /-ring-\d+$/.test(o.id));
  assert.equal(stones.length, 10);
  for (const s of stones) { const pos = s.entity.components.transform.position, x = pos[0] + p.centre[0], z = pos[2] + p.centre[1], d = Math.hypot(x - 70, z);
    assert.ok(d >= 20 && d <= 26, `stone at ${d.toFixed(1)} m from the tarn centre`); assert.ok(!g.wet(x, z)); }
  assert.ok(p.propRequests.some((q) => /salt-killed white reeds/.test(q.name)));
  // the visible ring: the world's own scatter rules on the rim (zone skin first), every slot filled
  const plants = (p.worldOps.find((w: any) => w.kind === "rockSets") as any)?.feature;
  assert.equal(plants?.id, "pb-test-place-ring-plants");
  assert.equal(plants.rocks.length, 34);
  assert.ok(plants.rocks.every((q: any) => !g.wet(q.at[0], q.at[1]) && Math.hypot(q.at[0] - 70, q.at[1]) <= 37));
  assert.deepEqual([...new Set(plants.rocks.map((q: any) => q.rule))], ["dry-brush-z", "dead-dried-tree-z"]);
  const only = planPlace(shrine, { ...input, place: { ...input.place, at: [40, 0], text }, waters: [lake], scatterRules: ["dry-brush", "dead-dried-tree"] }, g);
  assert.deepEqual([...new Set((only.worldOps.find((w: any) => w.kind === "rockSets") as any).feature.rocks.map((q: any) => q.rule))], ["dry-brush", "dead-dried-tree"]);
  assert.ok(planPlace(shrine, { ...input, place: { ...input.place, at: [40, 0], text }, waters: [lake], scatterRules: [] }, g).faults.some((f) => /ring scatter/.test(f)));
  // no ring word in the brief -> no ring; no lake near -> discs round the core
  assert.equal(planPlace(shrine, { ...input, place: { ...input.place, text: "a gibbet on the rise" }, waters: [lake] }, g).worldOps.filter((w: any) => w.kind === "groundPaints").length, 0);
  const dry = planPlace(shrine, { ...input, place: { ...input.place, text } }, ground);
  assert.ok(dry.worldOps.filter((w: any) => w.kind === "groundPaints").length >= 8 && dry.notes.some((n) => /no lake within 150 m/.test(n)));
});

test("a read view never stands under water: a spot by a lake lower than its surface slides back from the target (weep-well read-2)", () => {
  const shrine = all.find((a) => a.id === "shrine")!;
  // a tarn at (0, 60) whose field is dry but low (below waterY) out to 60 m: the 'dry' shore under the lake surface
  const lake = { id: "tarn", center: [0, 60] as [number, number], radius: 30, waterY: 20 };
  const g: PlaceGround = { height: (x, z) => (Math.hypot(x, z - 60) < 60 ? 19 : 21), wet: (x, z) => Math.hypot(x, z - 60) < 30 };
  const inp = { ...input, place: { ...input.place, at: [0, 0] as [number, number] }, reservation: { ...input.reservation, approaches: [[[0, 0], [0, 100], [0, 400]]] as [number, number][][] }, waters: [lake] };
  const p = planPlace(shrine, inp, g);
  assert.ok(p.notes.some((n) => /view .*(moved|dropped)/.test(n)), p.notes.join("; "));
  for (const v of p.handoff.viewpoints) {
    const rad = ((v.facing as number) * Math.PI) / 180, cam: [number, number] = [v.x - Math.sin(rad) * v.distance, v.z + Math.cos(rad) * v.distance];
    for (const q of [[v.x, v.z], cam] as [number, number][]) assert.ok(!(Math.hypot(q[0], q[1] - 60) <= 70 && g.height(q[0], q[1]) < 20.3), `${v.name} at ${q.map(Math.round)} under the tarn`);
  }
});

// L (read, Hagsheer batch 2026-10-20): seven medium places hid a 3.5-5 m landmark behind a crest at 225-300 m
const ridged: PlaceGround = { height: (x, z) => (z >= 110 && z <= 130 && x < -20 ? 45 : 20), wet: () => false };
test("read height needed: flat ground needs almost nothing, a 25 m ridge in front needs a tall target", () => {
  const line: [number, number][][] = [[[0, 400], [0, 150]]], band: [number, number] = [225, 300];
  assert.ok(readHeightNeeded(ridged, [60, 0], 20, line, band, 0) < 2, "east of the ridge: seen over flat ground");
  assert.ok(readHeightNeeded(ridged, [-60, 0], 20, line, band, 0) > 20, "west: the ridge hides it");
  assert.equal(readHeightNeeded(ridged, [0, 0], 20, [[]], band, 0), Infinity);
});

test("site search puts the core where its landmark reads from the approach (a ridge hides the brief site)", () => {
  const a = forTier(den(), "medium"), inp = { ...input, place: { ...input.place, at: [-60, 0] as [number, number] }, reservation: { center: [0, 0] as [number, number], radius: 60, approaches: [[[0, 400], [0, 150]]] as [number, number][][] } };
  const blind = siteSearch(a, inp, ridged, { needM2: 3000 }), seen = siteSearch(a, inp, ridged, { needM2: 3000, read: { band: [225, 300] } });
  assert.ok(blind && seen);
  assert.ok(readHeightNeeded(ridged, blind!.at, 20, inp.reservation.approaches, [225, 300], 0) > 5, `without read the core stays behind the ridge (${blind!.at})`);
  assert.ok(seen!.read && seen!.read.short <= 0, `with read the landmark reads (${JSON.stringify(seen!.read)} at ${seen!.at})`);
});

test("read targets: the landmark and every fire column; the camp's fire is a camp bonfire, the giants' pyre a choice (TOOLS-PB 2026-10-23)", () => {
  const camp = all.find((x) => x.id === "camp")!;
  const fire = camp.pockets[0]!.structures.find((s) => s.id === "fire")!;
  assert.equal(fire.prefab, "camp-props/bonfire"); assert.ok(fire.choices.includes("giant-camp/landmark-pyre"));
  for (const p of ["camp-props/bonfire", "poi-props/campfire", "poi-props/brazier", "giant-camp/landmark-pyre"]) assert.ok(SMOKE_READ_M[p]! > 0, `${p} has a read column`);
  const t = readTargets(camp, camp.pockets.map((p) => ({ id: p.id, at: [0, 0] as [number, number] })));
  assert.equal(t[0]!.height, SMOKE_READ_M["camp-props/bonfire"]);
  assert.ok(t.some((x) => x.height === fire.landmark!.height), "the fire's own landmark height too");
});

test("approach lines: a road named twice is judged once", () => {
  const recipe = { features: { roads: [{ id: "r", points: [[0, 0, 300], [0, 0, -300]] }] } };
  const { lines } = approachLines(recipe, [], { center: [10, 0], approach: { from: "r", points: [] }, approaches: [{ from: "r", points: [] }] });
  assert.equal(lines.length, 1);
});

test("approach lines: a road's legs are ONE line named by its base id, whichever leg is named (knucklecrown close)", () => {
  const recipe = { features: { roads: [{ id: "p", points: [[0, 0, 500], [0, 0, 300]] }, { id: "p.s2", points: [[10, 0, 280], [0, 0, 20]] }, { id: "q", points: [[400, 0, 0], [50, 0, 0]] }] } };
  const r = approachLines(recipe, [], { center: [0, 0], approach: { from: "p.s3", points: [] }, approaches: [{ from: "p.s2", points: [] }, { from: "q", points: [] }, { from: "p", points: [] }] });
  assert.deepEqual(r.unresolved, ["p.s3"]);
  assert.deepEqual(r.names, ["p", "q"], "p and p.s2 judged once, as the road p; the unresolved leg shifts nothing after it");
  assert.equal(r.lines[0]!.length, 4, "both legs of p");
});

test("approach read: judged at the road's first-sight point, sampled finely enough to land on it (knucklecrown close)", () => {
  // a lip at z 256.5..261.5 hides the target from beyond it; the first spot on it (260 m) sees it, 15 m sampling stepped over it
  const lip: PlaceGround = { height: (_x, z) => (z > 256.5 && z < 261.5 ? 6 : 0), wet: () => false };
  const spots = approachSpots([0, 0], [[[0, 400], [0, 0]]], [255, 450]);
  assert.ok(spots.some((q) => q.d > 255 && q.d < 262), "a spot between the lip and the band edge");
  const r = approachRead(lip, { at: [0, 0], top: 12, fogReach: 600, foot: 0 }, spots);
  assert.ok(r.ok, JSON.stringify(r.rows));
  assert.ok((r.rows[0] as any).firstSight.distance < 262);
});

test("install guard: same ground installs, a drift under 0.5 m installs and re-seats, more refuses", () => {
  assert.equal(installGuard(0.03), "same");
  assert.equal(installGuard(0.24), "reseat");
  assert.equal(installGuard(RESEAT_MAX_M), "reseat");
  assert.equal(installGuard(0.94), "refuse");
});

test("a shore core stays on the shore of the brief's own water: a cliff top over the sea or a tarn's bank does not count (weepmouth, kelpmane-cove)", () => {
  // sea (level 0) west of x = -80; a 100 m cliff from x = -60 east; a tarn at level 98 round (100, 0)
  const tarn = (x: number, z: number) => Math.hypot(x - 100, z) < 20;
  const g: PlaceGround = { height: (x, z) => (x < -80 ? -5 : x < -60 ? 1 : tarn(x, z) ? 95 : 100), wet: (x, z) => x < -80 || tarn(x, z), waterY: (x, z) => (x < -80 ? 0 : tarn(x, z) ? 98 : null) };
  assert.ok(shoreRise(g, [-70, 0], 0) <= SHORE_RISE_M, "the beach");
  assert.ok(shoreRise(g, [-50, 0], 0) > SHORE_RISE_M, "the cliff top 30 m from the sea is 100 m above it");
  assert.equal(waterLevelNear(g, [-70, 0]), 0);
  assert.equal(shoreRise(g, [70, 0], 0), Infinity, "the tarn is not the brief's sea");
});

test("a walk route follows its footpath ribbon as built, not the taut polyline across the bend (hags-garth)", () => {
  // polyline corner at (0,0); the ribbon rounds it 3 m inside
  const pts = [[-40, 0, 0], [0, 0, 0], [0, 0, 40], [5, 0, 60]];
  const samples: number[][] = [];
  for (let x = -40; x <= -6; x += 1) samples.push([x, 0, 0]);
  for (let a = 0; a <= 90; a += 10) { const t = (a * Math.PI) / 180; samples.push([-6 + 6 * Math.sin(t), 0, 6 - 6 * Math.cos(t)]); }
  for (let z = 7; z <= 40; z += 1) samples.push([0, 0, z]);
  const r = routeOnRibbon(pts, samples, 1.2);
  const off = (q: number[]) => Math.min(...samples.map((s) => Math.hypot(s[0]! - q[0]!, s[2]! - q[2]!)));
  assert.ok(r.slice(0, -1).every((q) => off(q) < 0.01), "every point but the pocket end lies on the ribbon");
  assert.deepEqual(r[r.length - 1], [5, 0, 60], "the end off the ribbon is kept");
  assert.ok(!r.some((q) => q[0] === 0 && q[2] === 0), "the corner the ribbon rounds is gone");
});

test("a footpath lands on the ground: a leg coming down a steep bank runs on into the pocket (tinkers-camp)", async () => {
  const { landedStretch, ribbonEndsOff, LAND_TOL_M } = await import("../tools/_place-archetype.mts");
  // a 0.45 bank falling east onto level ground at x >= -10; the pocket (r 10) at the origin
  const bank = { height: (x: number) => (x < -10 ? 0.45 * (-10 - x) : 0) };
  const line: [number, number][] = Array.from({ length: 41 }, (_, i) => [-40 + i, 0]);
  const outside = (poly: [number, number][], discs: { at: [number, number]; radius: number }[]) => poly.filter((q) => discs.every((d) => Math.hypot(q[0] - d.at[0], q[1] - d.at[1]) > d.radius - 1));
  const route = { width: 2.4, style: "dirt", maxGrade: 0.35 };
  const edge = outside(line, [{ at: [0, 0], radius: 10 }]);
  const offEdge = ribbonEndsOff(bank, edge, route);
  assert.ok(offEdge > LAND_TOL_M, `the ribbon stopped at the pocket edge should end off the ground (${offEdge})`);
  const landed = landedStretch(bank, line, [{ at: [0, 0], radius: 10 }], outside, route);
  assert.ok(landed[landed.length - 1]![0] > edge[edge.length - 1]![0], "the stretch runs on into the pocket");
  assert.ok(ribbonEndsOff(bank, landed, route) < offEdge, "and its end lands nearer the ground");
  // level ground: nothing changes
  const flat = { height: () => 5 };
  assert.deepEqual(landedStretch(flat, line, [{ at: [0, 0], radius: 10 }], outside, route), edge);
});

test("a landmark pyre burns at dusk (coffin-road: the name test missed it)", async () => {
  const { burnsAtDusk } = await import("../tools/_place-archetype.mts");
  assert.ok(burnsAtDusk(["composite-props/stone-cairn", "giant-camp/landmark-pyre"]));
  assert.ok(burnsAtDusk(["poi-props/standing-torch"]));
  assert.ok(!burnsAtDusk(["composite-props/stone-cairn", "rock-kit/boulder-s-1"]));
  // bar-watch 2026-10-21: a cold brazier is named for a flame but burns nothing
  assert.ok(!burnsAtDusk(["composite-props/cold-brazier", "crockin-river-culture/lotus-oil-brazier-unlit"]));
});

test("zfight charges only clusters the live world does not have (sheer-crofts: ocean vs sea-level terrain)", async () => {
  const { newZfightClusters } = await import("../tools/_place-archetype.mts");
  const c = (a: string, b: string, centre: number[], area = 2) => ({ a: { mesh: a, material: "m1" }, b: { mesh: b, material: "terrain" }, centre, area });
  const lab = { thresholds: { failClusterArea: 0.05 }, clusters: [c("ocean", "voxel:pbsheercrofts", [-2964.3, 0.5, -887.7]), c("dress-x", "voxel:pbsheercrofts", [10, 5, 10]), c("ocean", "voxel:pbsheercrofts", [0, 0.5, 0], 0.01)] };
  const live = { clusters: [c("voxel:skelmorrow", "ocean", [-2964.1, 0.5, -887.5])].map((x) => ({ ...x, a: { mesh: "voxel:skelmorrow", material: "terrain" }, b: { mesh: "ocean", material: "m1" } })) };
  const mine = newZfightClusters(lab, live, "pbsheercrofts", "skelmorrow");
  assert.deepEqual(mine.map((x: any) => x.a.mesh), ["dress-x"]);
  assert.equal(newZfightClusters(lab, null, "pbsheercrofts", "skelmorrow").length, 2);
});

test("a pinpoint is the core pocket only: one marker, its fire, no satellites, routes or their prop requests (weepmouth 2026-10-21)", () => {
  const shrine = all.find((a) => a.id === "shrine")!, work = all.find((a) => a.id === "work-yard")!;
  assert.deepEqual(forTier(shrine, "pinpoint").pockets.map((p) => p.id), ["core"]);
  assert.equal(forTier(shrine, "small").pockets[0]!.fit, shrine.pockets[0]!.radius, "a small core is spread to its floor, its fit stays the archetype's");
  assert.deepEqual(forTier(work, "pinpoint").propRequests, [], "the huts' request goes with the huts pocket");
  const p = planPlace(forTier(shrine, "pinpoint"), { ...input, place: { ...input.place, size: "pinpoint" } }, ground);
  assert.deepEqual(p.pockets.map((k) => k.id), ["core"]);
  assert.ok(p.handoff.landmark && p.handoff.measurements.adventureSize === "pinpoint");
  assert.deepEqual(readBand("pinpoint"), [45, 60]);
  // owner ruling (bar-watch 2026-10-21): a pinpoint is reached on foot, no footpath ribbon; the leg stays a walk route
  assert.equal(p.operators.filter((o: any) => o.op === "path").length, 0, "no path operator for a pinpoint");
  assert.ok(p.handoff.navigation.routes.some((r: any) => r.id === "approach"), "the approach is still walked");
  assert.ok(planPlace(forTier(shrine, "small"), input, ground).operators.some((o: any) => o.op === "path"), "a small place keeps its footpath");
});

test("read.views adds far evidence views looking at the landmark (bar-watch 2026-10-21: across the gorge)", () => {
  const shrine = all.find((a) => a.id === "shrine")!;
  const a = placeArchetypeSchema.parse(applySets(shrine, ['read.views=[{"name":"gorge","at":[0,300]}]']));
  const p = planPlace(forTier(a, "pinpoint"), { ...input, place: { ...input.place, size: "pinpoint" } }, ground);
  const v = p.handoff.viewpoints.find((x: any) => x.name.startsWith("far-gorge-"));
  assert.ok(v, p.handoff.viewpoints.map((x: any) => x.name).join(", "));
});

test("quest objects the quest plan declares at the place are core plan items with quest.entity; one with no prop is a FIT fault (weepmouth, kelpmane-cove)", () => {
  const shrine = all.find((a) => a.id === "shrine")!;
  const questObjects = [{ id: "tide-stone", kind: "readable", what: "a tally stone" }, { id: "boats", kind: "object" }];
  const a = placeArchetypeSchema.parse(applySets(shrine, ["quest.tide-stone=rock-kit/boulder-m-3"]));
  const p = planPlace(a, { ...input, questObjects }, ground);
  const item = p.plans.find((d) => d.id === "test-place-core")!.items.find((it: any) => it.id === "tide-stone");
  assert.deepEqual(item?.quest, { entity: "tide-stone" });
  assert.equal(item?.prop, "rock-kit/boulder-m-3");
  assert.equal(p.plans.find((d) => d.id === "test-place-core")!.items[0].id, "tide-stone", "the quest object is placed first (never the item dropped for room)");
  assert.ok(p.faults.some((f) => /quest object boats .*--set quest\.boats=/.test(f)), p.faults.join("; "));
});

test("every route lane also clears the grass cover over the cut shoulder, narrower than the scatter lane (kelpmane-cove 2026-10-21)", () => {
  const p = planPlace(all.find((a) => a.id === "cuttings")!, input, ground);
  for (const r of p.handoff.navigation.routes) {
    const sc = p.clearings.find((c) => c.id === `test-place-lane-${r.id}`), cv = p.clearings.find((c) => c.id === `test-place-lane-cover-${r.id}`);
    assert.ok(sc && cv && cv.cover === true && cv.scatter === false && sc.cover === false, r.id);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// POI quality (Hagsheer 2026-10-21): size floors, density floors, built stone, the 300 m read in pixels, seated structures
import { baseOutline, seatStructure, seatGap, SEAT_GAP_M, RAISE_PAST_M, densityNeed, heightForPx, READ_PX_MIN, readPixels, wearsCliffTile, POCKET_FLOOR_M } from "../tools/_place-quality.mts";
const boxTris = (mn: number[], mx: number[]) => { const c = (i: number) => [i & 1 ? mx[0]! : mn[0]!, i & 2 ? mx[1]! : mn[1]!, i & 4 ? mx[2]! : mn[2]!];
  const f = [[0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 3, 7], [1, 7, 5], [0, 1, 3], [0, 3, 2], [4, 5, 7], [4, 7, 6]];
  return f.map(([a, b, d]) => ({ a: c(a!), b: c(b!), c: c(d!), material: "old-watch/ashlar" })); };

test("seated: a ruin on a slope sits on its highest ground with a skirt round its base; the gap is the MOST daylight along the outline (signal-tower)", () => {
  const base = baseOutline(boxTris([-3, 0, -3], [3, 8, 3]))!, slope = (x: number) => 100 + 0.2 * x;
  assert.ok(base.perimeter.length >= 20 && base.material === "old-watch/ashlar");
  const seat = seatStructure(base, [0, 0], 0, (x) => slope(x));
  assert.ok(seat.skirt && seat.skirt.length >= 5 && seat.raise, "the ground raised and a skirt round the base (1.2 m of fall)");
  assert.ok(Math.abs(seat.y - slope(2.75)) < 0.01, `on the highest ground (${seat.y})`);
  // the old placement (the centre's ground) stands clear on the low side though its middle touches: the gate fails it
  const old = seatGap(base, [0, 0], slope(0), 0, (x) => slope(x));
  assert.ok(old.gap > SEAT_GAP_M && old.at[0] < 0, `old seat gap ${old.gap} at ${old.at}`);
  assert.ok(seatGap(base, [0, 0], seat.y, 0, (x) => slope(x)).gap > SEAT_GAP_M, "without its skirt the new seat is clear on the low side");
  const withSkirt = seatGap(base, [0, 0], seat.y, 0, (x) => slope(x), { hull: seat.skirt!, top: seat.y - 0.02, reach: 0.7 });
  assert.ok(withSkirt.gap <= SEAT_GAP_M, `skirted gap ${withSkirt.gap}`);
  // level ground: no skirt; a rock is sunk below its lowest ground
  assert.equal(seatStructure(base, [0, 0], 0, () => 50).skirt, null);
  const rock = seatStructure(base, [0, 0], 0.7, (x) => slope(x), { rock: true });
  assert.ok(rock.sunk && rock.skirt === null && seatGap(base, [0, 0], rock.y, 0.7, (x) => slope(x)).gap <= 0);
});

test("seated: an open-court ruin on a big fall stands at the middle of it on LEVELLED ground (cut + fill), never sunk to its lowest (Red Dial)", () => {
  const legs = baseOutline([...boxTris([-6, 0, -2], [-5, 3, 2]), ...boxTris([5, 0, -2], [6, 3, 2])])!, slope = (x: number) => 100 + 0.3 * x; // 3.6 m of fall
  assert.ok(legs.fill < 0.3 && Math.max(...legs.extent) >= 6, `open base (fill ${legs.fill})`);
  const seat = seatStructure(legs, [0, 0], 0, (x) => slope(x), { sinkMax: 0.6 });
  assert.ok(seat.level && seat.raise && !seat.sunk, JSON.stringify(seat));
  assert.ok(Math.abs(seat.y - 100) < 0.2, `at the middle of the fall (${seat.y})`);
  assert.ok(seatGap(legs, [0, 0], seat.y, 0, () => seat.raise!.y).gap <= SEAT_GAP_M && seat.rect && seat.rect.half[0] >= 6, "no daylight on the levelled ground, over its own rectangle");
  // the levelled plateau runs RAISE_PAST_M past the base (o-small2 dropped-hour 2026-10-30: at +0.5 m the 2 m patch lattice sagged under the outline, a lodge 0.062 m clear)
  const xs = legs.cells.map((c) => c[0]), zs = legs.cells.map((c) => c[1]), far = Math.max(...legs.cells.map(([x, z]) => Math.hypot(x, z)));
  assert.ok(Math.abs(seat.rect!.half[0] - ((Math.max(...xs) - Math.min(...xs)) / 2 + RAISE_PAST_M)) < 0.02 && Math.abs(seat.rect!.half[1] - ((Math.max(...zs) - Math.min(...zs)) / 2 + RAISE_PAST_M)) < 0.02, JSON.stringify(seat.rect));
  assert.ok(Math.abs(seat.raise!.radius - (far + RAISE_PAST_M)) < 0.02, String(seat.raise!.radius));
  // a small legged piece (a table) is still sunk, with no terrain edit
  const table = baseOutline([...boxTris([-2, 0, -1], [-1.5, 1, 1]), ...boxTris([1.5, 0, -1], [2, 1, 1])])!;
  assert.ok(seatStructure(table, [0, 0], 0, (x) => slope(x), { sinkMax: 0.6 }).sunk);
});

test("the planner seats structures on their outline and skirts them on a slope (no structure floats on its low side)", () => {
  const slope: PlaceGround = { height: (x) => 20 + 0.08 * x, wet: () => false }; // 1.6 m over the 20 m pad: no pad, 0.5 m under the tower
  const base = baseOutline(boxTris([-3, 0, -3], [3, 8, 3]));
  const a = all.find((x) => x.id === "watch-ruin")!;
  const plan = planPlace(forTier(a, "medium"), { ...input, structureBase: (p: string) => (p.includes("tower") ? base : null), materialExists: () => true }, slope);
  // 0.5 m of fall: a ruin is sunk (no terrain edit); a dwelling gets its ground raised (raised foundations)
  assert.ok(plan.notes.some((n) => /core.tower: sunk/.test(n)), plan.notes.join("; "));
  const asDwelling = placeArchetypeSchema.parse({ ...a, pockets: a.pockets.map((k, i) => (i ? k : { ...k, structures: k.structures.map((st) => (st.id === "tower" ? { ...st, role: "dwelling" } : st)) })) });
  const dwell = planPlace(forTier(asDwelling, "medium"), { ...input, structureBase: (p: string) => (p.includes("tower") ? base : null), materialExists: () => true }, slope);
  const raised = dwell.worldOps.filter((o: any) => String(o.feature?.id).includes("-seat-"));
  assert.ok(raised.length >= 1 && raised.every((o: any) => o.feature.raiseOnly), dwell.notes.join("; "));
  assert.ok(!plan.operators.some((o: any) => String(o.id).includes("-skirt-")));
  // 1.9 m of fall under the base: a stone skirt in its own stone as well
  const steep: PlaceGround = { height: (x) => 20 + 0.9 * Math.sin(x / 2), wet: () => false }; // banks everywhere (the fit cannot dodge them), under 2 m: no pad
  const p2 = planPlace(forTier(a, "medium"), { ...input, structureBase: (p: string) => (p.includes("tower") ? base : null), materialExists: () => true }, steep);
  const skirts = p2.operators.filter((o: any) => String(o.id).includes("-skirt-"));
  assert.ok(skirts.length >= 1, p2.notes.join("; "));
  assert.equal(skirts[0].materials.face, "old-watch/ashlar", "the skirt is in the structure's own stone");
  assert.ok(skirts[0].footing.depth >= 0.6 && skirts[0].heightMode === "level");
});

test("size floor: every pocket covers its tier's floor, the layout spreads with it, the fit keeps the archetype's radius", () => {
  const g = all.find((x) => x.id === "graveyard")!, m = forTier(g, "medium");
  assert.equal(m.pockets[0]!.radius, POCKET_FLOOR_M.medium.core);
  assert.equal(m.pockets[0]!.fit, 14);
  const wall = m.pockets[0]!.walls.find((w) => w.id === "kirkyard")!;
  assert.ok(wall.size > 20, `the kirkyard grows with the core (${wall.size})`);
  for (const p of m.pockets.slice(1)) assert.ok(p.radius >= POCKET_FLOOR_M.medium.other);
  assert.equal(forTier(m, "medium").pockets[0]!.radius, m.pockets[0]!.radius, "idempotent");
});

test("density floor: a first plan holds the role's props per 100 m2; the listed props keep their exact counts, the rest is fill", () => {
  assert.equal(densityNeed("ruin", 24), 19);
  const items = firstPlanItems([{ prop: "house-interior/gravestone-a", count: 4, prefer: "open" }], "core", 24, "ruin");
  assert.ok(items.length >= 12 && items.filter((i) => i.prop.includes("gravestone")).length === 4, `${items.length}: ${items.map((i) => i.prop).join()}`);
  assert.ok(items.filter((i) => !i.prop.includes("gravestone")).every((i) => i.id.startsWith("fill-")));
});

test("built stone: walls take the zone's built stone, never the terrain cliff tile; none at all is a plan fault", () => {
  assert.ok(wearsCliffTile({}) && wearsCliffTile({ face: "zone" }) && !wearsCliffTile({ face: "hagsheer-widows/face" }));
  const g = all.find((x) => x.id === "graveyard")!;
  const ok = planPlace(g, input, ground), bare = planPlace(g, { ...input, builtStone: undefined }, ground);
  assert.ok(ok.operators.filter((o: any) => o.op === "wall").every((o: any) => o.materials.face === "zone-stone/face"));
  assert.ok(bare.faults.some((f) => f.includes("terrain cliff tile")));
});

test("the 300 m read is in pixels: a 1.8 m wall top over flat ground fails, a beacon tower reads; a short archetype gets its beacon", () => {
  const flat = { height: () => 20 };
  assert.ok(readPixels(flat, [0, 21.7, 300], { at: [0, 0], foot: 20, top: 21.8 }).px < READ_PX_MIN);
  assert.ok(readPixels(flat, [0, 21.7, 300], { at: [0, 0], foot: 20, top: 29 }).px >= READ_PX_MIN);
  assert.ok(heightForPx(300) > 7 && heightForPx(300) < 8.5);
  const m = forTier(all.find((x) => x.id === "graveyard")!, "medium"), core = m.pockets[0]!;
  assert.ok(core.walls.some((w) => w.id === "beacon" && w.landmark), "the beacon tower is the landmark");
  const tower = planPlace(m, input, ground).operators.find((o: any) => String(o.id).endsWith("-beacon"));
  assert.ok(tower && tower.smooth === false && !tower.buttresses, "a closed ring is a mitred polygon (a smooth closed ring fails the bake), a small tower has no buttresses");
  assert.equal(m.pockets.flatMap((p) => [...p.walls, ...p.structures]).filter((x) => x.landmark).length, 1);
  assert.ok(!forTier(all.find((x) => x.id === "camp")!, "medium").pockets[0]!.structures.some((s) => s.id === "beacon"), "a camp reads by its smoke");
  const r = approachRead(flat as PlaceGround, { at: [0, 0], top: 21.8, fogReach: 600, foot: 20 }, [{ p: [0, 290], d: 290, line: 0 }]);
  assert.ok(!r.ok && r.rows[0]!.px! < READ_PX_MIN, "seen but too small is not a read");
});

test("evidence views keep clear of the built pieces (the aerial sat in the pyre flames)", () => {
  const camp = all.find((x) => x.id === "camp")!, plan = planPlace(forTier(camp, "medium"), input, ground);
  const fire = plan.ops.find((o: any) => /landmark-pyre/.test(o.entity?.components?.prefab?.prefabId ?? ""));
  if (fire) { const p = fire.entity.components.transform.position, at = [p[0] + plan.centre[0], p[2] + plan.centre[1]];
    assert.ok(Math.hypot(plan.aerial[0] - at[0]!, plan.aerial[1] - at[1]!) > 2, `aerial body ${plan.aerial} off the pyre ${at}`); }
});

test("a route point past the ribbon's end stays (the way round a pen wall to its gate never collapses onto the end sample)", () => {
  const samples = [[0, 0, 0], [5, 0, 0], [10, 0, 0]];
  const pts = [[0, 0, 0], [10, 0, 0], [12, 0, 3], [12, 0, 6], [6, 0, 6]];
  const r = routeOnRibbon(pts, samples, 1.2);
  assert.ok(r.some((q) => q[0] === 12 && q[2] === 3), JSON.stringify(r));
});

test("an area whose own props are all denied still gets a first plan (the density floor fills it)", () => {
  const items = firstPlanItems([{ prop: "house-interior/handcart", count: 1, prefer: "open" }], "core", 24, "yard");
  assert.ok(items.length >= 2, JSON.stringify(items));
  assert.ok(!items.some((it: any) => it.prop === "house-interior/handcart"));
});

test("the approach is a carved + painted TRACK from the nearest road, never a ribbon (owner ruling 2026-10-20)", () => {
  const a = forTier(all.find((x) => x.id === "halt-yard")!, "medium"), road = { id: "path-a-b", points: [[-60, 200], [300, 200]] as [number, number][] };
  const p = planPlace(a, { ...input, roads: [road] }, ground);
  assert.deepEqual(ribbonApproachOps(p.operators, p.worldOps), [], "no ribbon approach");
  assert.ok(!p.operators.some((o: any) => /approach/.test(o.id)), "no approach operator at all");
  assert.ok(p.operators.some((o: any) => o.op === "path"), "the footpaths between pockets stay");
  assert.ok(p.track, p.notes.join(" | "));
  assert.equal(p.track!.id, trackId("test-place"));
  assert.equal(p.track!.width, TRACK_WIDTH_M.medium);
  assert.equal(p.track!.from, "path-a-b");
  assert.ok(Math.abs(p.track!.points[0]![1] - 200) < 0.5, `starts on the road: ${p.track!.points[0]}`);
  const core = p.pockets[0]!, end = p.track!.points[p.track!.points.length - 1]!;
  const st = p.track!.points[0]!; assert.ok(Math.hypot(end[0] - core.at[0], end[1] - core.at[1]) >= core.radius - 1.5 && Math.hypot(end[0] - core.at[0], end[1] - core.at[1]) < Math.hypot(st[0] - core.at[0], st[1] - core.at[1]), `runs toward the core and stops at or before its edge: ${end} (core r ${core.radius})`);
  // its lane clearings and keep-clear are as wide as the track, not the footpath
  const kc = p.handoff.siteDressing.keepClear.find((k: any) => k.id === "track-approach");
  assert.equal(kc?.width, TRACK_WIDTH_M.medium + 1.2);
  assert.deepEqual(p.handoff.approachTrack, { id: p.track!.id, width: 5, from: "path-a-b", lengthM: p.track!.lengthM });
  // width by tier; a pinpoint gets none (reached on foot), its approach still walked
  assert.equal(planPlace(forTier(all.find((x) => x.id === "halt-yard")!, "small"), { ...input, place: { ...input.place, size: "small" }, roads: [road] }, ground).track?.width, TRACK_WIDTH_M.small);
  const pin = planPlace(forTier(all.find((x) => x.id === "shrine")!, "pinpoint"), { ...input, place: { ...input.place, size: "pinpoint" }, roads: [road] }, ground);
  assert.equal(pin.track, null);
  assert.ok(pin.handoff.navigation.routes.some((r: any) => r.id === "approach"));
  // no road within TRACK_JOIN_M: the track starts on the approach line
  const far = planPlace(a, { ...input, reservation: { ...input.reservation, approaches: [[[120, 400], [120, -400]]] }, roads: [{ id: "path-far", points: [[-60, TRACK_JOIN_M + 100], [300, TRACK_JOIN_M + 100]] }] }, ground);
  assert.equal(far.track?.from, "the approach line");
  assert.ok(far.notes.some((n) => /no road, path or trail within/.test(n)));
});

test("gate roads: a ribbon / path-operator approach is named, footpaths between pockets are not", () => {
  assert.deepEqual(ribbonApproachOps([{ id: "pb-x-approach", op: "path" }, { id: "pb-x-to-yard", op: "path" }, { id: "pb-x-wall", op: "wall" }]), ["operator pb-x-approach (path ribbon)"]);
  assert.deepEqual(ribbonApproachOps([], [{ edit: "add-feature", kind: "ribbons", feature: { id: "op:pb-x-approach:ribbon" } }, { edit: "add-feature", kind: "roads", feature: { id: "road-pb-x-approach" } }]), ["features.ribbons op:pb-x-approach:ribbon"]);
});

test("the track stops where its regraded band would reach a built piece (kirk-knowe 2026-10-21: a bell post lifted 0.55 m)", () => {
  const band = trackBand(5);
  assert.deepEqual(trimTrack([[0, 0], [0, 40]], 5, [{ at: [0, 50], r: 2 }], []), [[0, 0], [0, 34]]);
  assert.deepEqual(trimTrack([[0, 0], [0, 40]], 5, [], [[[-10, 30], [10, 30], 0.8]]), [[0, 0], [0, 15]]);
  assert.deepEqual(trimTrack([[0, 0], [0, 40]], 5, [{ at: [0, 5], r: 2 }], []), [], "a start inside the band is no track");
  const a = forTier(all.find((x) => x.id === "halt-yard")!, "medium");
  const p = planPlace(a, { ...input, roads: [{ id: "path-a-b", points: [[-60, 200], [300, 200]] }] }, ground);
  const solids = p.handoff.siteDressing.keepClear.filter((k: any) => String(k.why).startsWith("structure"));
  for (const q of p.track!.points) for (const k of solids) assert.ok(Math.hypot(q[0] - k.at[0], q[1] - k.at[1]) >= k.radius + band - 1e-6, `track point ${q} inside the band of ${k.id}`);
});

test("approach only: planned round the place AS BUILT, from the nearest road, trimmed clear of its pieces (Hagsheer re-apply 2026-10-21)", () => {
  const flat: PlaceGround = { height: () => 10, wet: () => false };
  const b = { poi: "p", size: "medium" as const, core: { at: [0, 0] as [number, number], radius: 20 }, stand: [0, 5] as [number, number], maxGrade: 0.35,
    solids: [{ at: [0, 8] as [number, number], r: 3 }], walls: [{ points: [[-30, 40], [30, 40]] as [number, number][], thickness: 0.8 }], approaches: [], roads: [{ id: "path-x", points: [[-200, 150], [200, 150]] as [number, number][] }] };
  const r = approachForBuilt(flat, b);
  assert.ok(r.track && r.route, r.faults.join("; "));
  assert.equal(r.track!.from, "path-x");
  assert.equal(r.track!.width, TRACK_WIDTH_M.medium);
  const end = r.route!.points[r.route!.points.length - 1]!; assert.deepEqual([end[0], end[2]], [0, 5], "the walk ends at the recorded stand");
  for (const q of r.route!.points) assert.ok(!(Math.abs(q[2] - 40) < 0.8 && Math.abs(q[0]) <= 30), `the leg crosses the built wall at ${q}`);
  for (const q of r.track!.points) assert.ok(Math.hypot(q[0], q[1] - 8) >= 3 + trackBand(5) - 1e-6, `track point ${q} in the band of the built piece`);
  assert.deepEqual(r.clearings.map((c) => c.id), ["p-lane-approach", "p-lane-cover-approach"]);
  assert.equal(approachForBuilt(flat, { ...b, size: "pinpoint" }).track, null);
});

test("first plans are laid out in vignettes, item ids kept (owner walk 2026-10-21: clutter in a small square)", () => {
  const items = firstPlanItems([{ prop: "poi-props/crate", count: 2, prefer: "wall" }, { prop: "town-craft/porters-back-frame", count: 1, prefer: "wall" }, { prop: "rock-kit/boulder-s-1", count: 2, prefer: "open" }], "core", 11, "camp");
  const laid = arrangeFirstPlan(items, "camp", "core", [{ id: "fire", role: "fire" }, { id: "tent-a", role: "dwelling" }], "core");
  assert.deepEqual(laid.items.map((it) => it.id), items.map((it) => it.id), "ids kept");
  assert.deepEqual(laid.arrangements[0], { id: "camp", kind: "camp", room: "core", anchor: "structure:core-fire" });
  assert.ok(laid.items.filter((it) => it.place.arrangement === "camp").length >= 3);
  assert.ok(laid.items.filter((it) => /^rock-kit/.test(it.prop)).every((it) => !it.place.arrangement), "boulders stay loose");
  const yard = arrangeFirstPlan(items, "yard", "work", [{ id: "shelter", role: "work" }], "work");
  assert.equal(yard.arrangements[0].anchor, "structure:work-shelter front");
  // L (PLACES-FIX 2026-10-21): ruin / cave-mouth / path pockets and lookout / offering pockets get vignettes too
  const made = firstPlanItems([{ prop: "poi-props/crate", count: 3, prefer: "wall" }, { prop: "rock-kit/boulder-s-1", count: 1, prefer: "open" }], "yard", 11, "ruin");
  assert.equal(arrangeFirstPlan(made, "ruin", "yard", [], "yard").arrangements[0].kind, "yard");
  assert.equal(arrangeFirstPlan(made, "ruin", "core", [{ id: "tower", role: "landmark" }], "core").arrangements[0].anchor, "structure:core-tower front");
  assert.equal(arrangeFirstPlan(made, "ruin", "lookout", [], "lookout").arrangements[0].kind, "lookout");
  assert.equal(arrangeFirstPlan(made, "ruin", "offering", [], "offering").arrangements[0].kind, "shrine");
  assert.equal(arrangeFirstPlan(made, "path", "lane", [], "lane").arrangements[0].kind, "work-line");
  assert.ok(arrangeFirstPlan(made, "ruin", "yard", [], "yard").items.filter((it) => /^rock-kit/.test(it.prop)).every((it) => !it.place.arrangement));
  // the camp archetype's planned core: a camp vignette on its fire
  const a = all.find((x) => x.id === "camp");
  if (a) {
    const p = planPlace(forTier(a, "medium"), input, ground), core = p.plans.find((d: any) => d.id.endsWith("-core"));
    assert.ok(core?.arrangements?.some((v: any) => v.kind === "camp" && /^structure:core-/.test(v.anchor)), JSON.stringify(core?.arrangements));
  }
});

// ---- BUILT structure kinds (LANDMARKS 2026-10-21: castles and towers that break the skyline, from the one wall mesher)
import { cutLine, stationOn, CRENEL_PARAPET, placeWallSchema } from "../tools/_place-archetype.mts";
import { wallParamsSchema } from "../../../packages/core/src/voxel/operators-wall.ts";

test("built kinds: a lone tower's windows are raised openings on its faces, each with a night light, and a beacon on its top", () => {
  const lt = all.find((x) => x.id === "lone-tower")!;
  const moor: PlaceGround = { height: (x) => 30 + x * 0.01, wet: () => false };
  const plan = planPlace(forTier(lt, "medium"), input, moor);
  assert.deepEqual(plan.faults, []);
  const tower = plan.operators.find((o: any) => o.op === "wall" && o.id.endsWith("-tower"))! as any;
  const { id: _i, op: _o, fog: _f, ...rest } = tower; assert.ok(wallParamsSchema.safeParse(rest).success);
  const wins = tower.openings.filter((o: any) => o.sill > 0);
  assert.equal(wins.length, 3, "three slits");
  assert.ok(wins.every((o: any) => o.height - o.sill >= 0.6 && o.width <= 1), JSON.stringify(wins));
  assert.equal(new Set(wins.map((o: any) => o.sill)).size, 3, "at different heights");
  const door = tower.openings.find((o: any) => o.name === "door")!, P = (tower.points as number[][]).reduce((t, q, i, a) => (i ? t + Math.hypot(q[0]! - a[i - 1]![0]!, q[1]! - a[i - 1]![1]!) : 0), 0);
  for (const w of wins) { const d = Math.abs(w.at - door.at), gap = Math.min(d, P - d); assert.ok(gap > door.width, `window ${w.name} clear of the door (${gap.toFixed(1)} m)`); }
  const lights = plan.ops.filter((e: any) => (e.entity?.tags ?? []).includes("slot:window"));
  assert.equal(lights.length, 3);
  assert.ok(lights.every((e: any) => e.entity.components.prefab.prefabId === "giant-camp/window-glow"));
  assert.ok(plan.ops.some((e: any) => e.entity?.components?.prefab?.prefabId === "giant-camp/beacon-fire" && e.entity.components.transform.position[1] > tower.height - 3), "a beacon on the top");
});

test("built kinds: a castle plans level-topped crenellated towers and keep, a curtain cut at its gatehouse, its fire inside the keep", () => {
  const castle = all.find((x) => x.id === "castle")!;
  assert.ok(castle, "the castle archetype ships");
  const moor: PlaceGround = { height: (x) => 30 + x * 0.01, wet: () => false };
  const plan = planPlace(forTier(castle, "large"), { ...input, place: { ...input.place, size: "large" } }, moor);
  assert.deepEqual(plan.faults, []);
  const walls = plan.operators.filter((o: any) => o.op === "wall");
  for (const o of walls) { const { id: _i, op: _o, fog: _f, ...rest } = o as any; const r = wallParamsSchema.safeParse(rest); assert.ok(r.success, `${o.id}: ${JSON.stringify(r.success ? "" : r.error.issues).slice(0, 200)}`); }
  const keep = walls.find((o: any) => o.id.endsWith("-keep"))!, tower = walls.find((o: any) => o.id.endsWith("-tower-nw"))!, stump = walls.find((o: any) => o.id.endsWith("-tower-ne"))!;
  assert.equal(keep.heightMode, "level"); assert.equal(keep.smooth, false); assert.equal(keep.footing, null);
  assert.deepEqual(keep.parapet.crenels, CRENEL_PARAPET.crenels);
  assert.ok(keep.openings.some((d: any) => d.name === "door" && d.arch && d.width >= MIN_GATE_M));
  assert.equal(tower.points.length, 13, "a 12-sided mitred ring"); assert.equal(tower.smooth, false);
  assert.equal(stump.parapet, undefined, "a plain-topped stump has no walk");
  // height pass (coordinator 2026-10-22, "larger and more silhouetted"): corner towers >= 2 x the curtain, the keep clear above them
  const curtainH = walls.find((o: any) => /-curtain-\d+$/.test(o.id))!.height;
  for (const t of walls.filter((o: any) => /-tower-/.test(o.id))) assert.ok(t.height >= 2 * curtainH, `${t.id} ${t.height} m >= 2 x the curtain ${curtainH} m`);
  assert.ok(keep.height >= 1.5 * Math.max(...walls.filter((o: any) => /-tower-/.test(o.id)).map((t: any) => t.height)) * 0.99, "the keep stands clear above the towers");
  const gh = walls.find((o: any) => o.id.endsWith("-gatehouse"))!;
  assert.deepEqual(gh.openings.map((d: any) => d.name).sort(), ["back-door", "door"], "a gatehouse passage runs through front and back");
  const runs = walls.filter((o: any) => /-curtain-\d+$/.test(o.id));
  assert.equal(runs.length, 1, "the closed curtain is one run, cut at the gatehouse");
  const run = runs[0]!.points as [number, number][], gap = Math.hypot(run[0]![0] - run[run.length - 1]![0], run[0]![1] - run[run.length - 1]![1]);
  assert.ok(Math.abs(gap - (2 * 3.5 - 1)) < 0.05, `the cut is the gatehouse width less its side walls' overlap: ${gap}`);
  // ravenstacks 2026-10-21: a plain brazier on a 26 m walk never read from the road (its parapet hid it); 2026-10-22 (night
  // read, coordinator + SMOKE): the keep top carries a BEACON whose light (glow halo) stands over the parapet
  const fires = plan.ops.filter((e: any) => e.entity?.components?.prefab?.prefabId === "giant-camp/beacon-fire");
  assert.equal(fires.length, 1);
  const kx = keep.points.map((q: number[]) => q[0]), kz = keep.points.map((q: number[]) => q[1]), fp = fires[0].entity.components.transform.position;
  const root = plan.ops[0].entity.components.transform.position, fx = root[0] + fp[0], fz = root[2] + fp[2];
  assert.ok(fx >= Math.min(...kx) - 0.1 && fx <= Math.max(...kx) + 0.1 && fz >= Math.min(...kz) - 0.1 && fz <= Math.max(...kz) + 0.1, `the beacon stands on the keep (${fx}, ${fz})`);
  assert.ok(fp[1] > keep.height - 3, `up on the keep walk (${fp[1]} vs keep ${keep.height} m)`);
  const door = plan.ops.find((e: any) => e.entity?.components?.script?.name === "portal")!;
  assert.ok(door, "the keep door is a portal");
  assert.equal(door.entity.components.script.params.scene, "", "sealed: no destination yet");
  assert.equal(door.entity.components.script.params.mode, "trigger");
});

test("built kinds: the schema refuses a tall plain wall, a square tower, a thin crenellated walk and a wall walk that is not one", () => {
  const w = (o: any) => ({ id: "x", shape: "ring", size: 4, ...o });
  const bad = (o: any) => !placeWallSchema.safeParse(w(o)).success;
  assert.ok(bad({ kind: "wall", height: 20 }));
  assert.ok(bad({ kind: "tower", shape: "square", height: 20, thickness: 2 }));
  assert.ok(bad({ kind: "tower", height: 20, thickness: 1 }));
  assert.ok(!bad({ kind: "tower", height: 20, thickness: 2 }));
  assert.ok(!bad({ kind: "tower", height: 20, thickness: 1, top: "plain" }));
  const castle = all.find((x) => x.id === "castle")!, raw = structuredClone(castle);
  raw.pockets[0]!.structures[0]!.onWall = "curtain";
  assert.ok(planPlace(raw, input, ground).faults.some((f) => f.includes("onWall curtain")));
});

test("an open line is cut into its runs at a gap (cutRing would wrap round it)", () => {
  const runs = cutLine([[0, 0], [20, 0], [20, 10]], [{ at: 10, width: 4 }]);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0], [[0, 0], [8, 0]]);
  assert.deepEqual(runs[1], [[12, 0], [20, 0], [20, 10]]);
  assert.equal(stationOn([[0, 0], [20, 0], [20, 10]], [20, 5]).at, 25);
});

test("built kinds: a lone tower keeps its size when its pocket is spread to the tier floor, and its top fire rides the tower", () => {
  const lone = all.find((x) => x.id === "lone-tower")!;
  const moor: PlaceGround = { height: () => 30, wet: () => false };
  const plan = planPlace(forTier(lone, "medium"), input, moor);
  assert.deepEqual(plan.faults, []);
  const tower = plan.operators.find((o: any) => o.id.endsWith("-core-tower"))! as any;
  const xs = tower.points.map((q: number[]) => q[0]), zs = tower.points.map((q: number[]) => q[1]);
  const c = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...zs) + Math.min(...zs)) / 2];
  assert.ok(Math.max(...xs) - Math.min(...xs) < 9.1, "the tower's ring is not spread");
  const fire = plan.ops.find((e: any) => e.id.endsWith("top-fire"))!.entity.components.transform.position;
  const r = Math.hypot(fire[0] + plan.centre[0] - c[0]!, fire[2] + plan.centre[1] - c[1]!);
  assert.ok(Math.abs(r - 4.35) < 0.3, `the fire stands on the tower's walk (r ${r})`);
  assert.equal(fire[1] + plan.padY, tower.topY + 0.3);
});

test("a route follows its ribbon on to the paved end before leaving for a stand past it (net-green 2026-10-21: FALL off the bow)", () => {
  // a ribbon bowing 3 m north between x 0 and x 40; route points: start on it, then a stand 10 m past its end
  const samples = Array.from({ length: 41 }, (_, i) => [i, 0, 3 * Math.sin((Math.PI * i) / 40)]);
  const r = routeOnRibbon([[0, 0, 0], [5, 0, 2.3], [50, 0, 0]], samples, 1.2);
  assert.deepEqual(r[r.length - 1], [50, 0, 0]);
  assert.ok(r.some((p) => Math.abs(p[0]! - 20) < 2 && p[2]! > 2.5), "the bow is walked, not the chord");
  assert.ok(r.some((p) => p[0] === 40), "on to the ribbon's end");
});

test("every place gets ONE silhouette: >= 2x its tallest other piece and the 300 m px floor (owner ruling 2026-10-21 23:25)", () => {
  const camp = all.find((x) => x.id === "camp")!, cut = all.find((x) => x.id === "cuttings")!;
  const t = forTier(camp, "medium", (p) => (/tent/.test(p) ? 5 : 1));
  const b = t.pockets[0]!.walls.find((w) => w.id === "beacon")!;
  assert.ok(b && b.height >= 10 && b.landmark?.height === b.height, `camp silhouette ${b?.height}`);
  const tall = forTier(camp, "medium", (p) => (/tent/.test(p) ? 8 : 1)).pockets[0]!.walls.find((w) => w.id === "beacon")!;
  assert.equal(tall.kind, "tower"); assert.ok(tall.height >= 16 && tall.thickness >= 1.8);
  // a pyre beacon keeps burning beside the silhouette tower; only one landmark
  const c = forTier(cut, "medium", () => 2), core = c.pockets[0]!;
  assert.ok(core.structures.some((s) => s.id === "beacon-fire") && core.walls.some((w) => w.id === "beacon"));
  assert.equal([...c.pockets.flatMap((p) => [...p.structures, ...p.walls])].filter((x) => x.landmark).length, 1);
  assert.deepEqual(forTier(c, "medium", () => 2).pockets[0]!.walls.filter((w) => w.id === "beacon").length, 1, "idempotent");
});

test("a STORY silhouette (read.beacon.structures) is used as given, scaled pieces judged at their scaled height (PLACES-FIX 2026-10-22)", () => {
  const cut = all.find((x) => x.id === "cuttings")!;
  const story = placeArchetypeSchema.parse({ ...JSON.parse(JSON.stringify(cut)), read: { ...cut.read, beacon: { structures: [
    { id: "x", role: "set-piece", prefab: "wrackmouth/net-drying-frame-double", at: [-10, -6], scale: 1.6, landmark: { fogReach: 600, silhouette: 0.6, height: 8.6 } },
    { id: "y", role: "set-piece", prefab: "wrackmouth/net-drying-frame-double", at: [10, -10], scale: 1.6 } ] } } });
  const core = forTier(story, "medium", () => 2).pockets[0]!;
  assert.deepEqual(core.structures.filter((s) => /^beacon/.test(s.id)).map((s) => [s.id, s.scale, !!s.landmark]), [["beacon", 1.6, true], ["beacon-2", 1.6, false]]);
  assert.ok(!core.walls.some((w) => w.id === "beacon"), "no generic tower beside a story element");
  const sh = silhouetteHeight(forTier(story, "medium", () => 2), "medium", () => 2);
  assert.ok(sh.floor < sh.need && sh.landmark >= sh.floor, JSON.stringify(sh));
});

test("a piece `on` another stands on that piece's mesh top, and is not seated on the ground (PLACES-FIX 2026-10-22)", () => {
  const den = all.find((x) => x.id === "den")!;
  const parsed = placeArchetypeSchema.parse({ ...JSON.parse(JSON.stringify(den)), read: { ...den.read, beacon: { structures: [
    { id: "a", role: "landmark", prefab: "rock-kit/crag-3", at: [-10, -8], footprint: 4, landmark: { fogReach: 600, silhouette: 0.7, height: 13 } },
    { id: "c", role: "set-piece", prefab: "composite-props/stone-cairn", at: [-10, -8], on: "beacon", footprint: 1.5 } ] } } });
  const core = forTier(parsed, "medium", () => 2).pockets[0]!;
  assert.equal(core.structures.find((s) => s.id === "beacon-2")?.on, "beacon");
});

test("a basin (RETTING): a level stone kerb, a water sheet over the highest inner ground buried in the kerb, its contents seated as structures; a floor is a ground paint", () => {
  const raw = { id: "pits", title: "pits", description: "pits", read: { duskLight: false, reason: "test" }, pockets: [{ id: "core", kind: "landmark", radius: 30,
    floor: { surface: "zone-paving", at: [0, 2], radius: 5, contents: [{ prefab: "a/board", at: [1, 0] }, { prefab: "a/sheaf", at: [-1, 0] }, { prefab: "a/sheaf", at: [-1, 0], on: 1 }] },
    structures: [{ id: "lm", role: "landmark", prefab: "a/crane", at: [6, 0], landmark: { height: 8 } }],
    walls: [{ id: "pit", shape: "square", at: [0, -10], size: 4, depth: 3, height: 0.6, thickness: 0.9, gate: 0,
      basin: { material: "m/brown-water", level: 0.15, kerb: 0.4, contents: [{ prefab: "a/sheaf", at: [-1, 0] }, { prefab: "rock-kit/boulder-s-2", at: [-1, 0], on: 0 }, { prefab: "a/heap", at: [4, 0], kerb: true }] } }] }] };
  const a = placeArchetypeSchema.parse(raw);
  const plan = planPlace(a, input, ground);
  const kerb = plan.operators.find((o) => o.id === "pb-test-place-core-pit")!;
  const water = plan.ops.find((o) => o.id === "test-place-core-pit-water")!, root = plan.ops[0].entity.components.transform.position;
  assert.ok(kerb && water, "the kerb and its water");
  const wy = water.entity.components.transform.position[1] + root[1];
  assert.equal(kerb.heightMode, "level");
  assert.ok(Math.abs(kerb.topY - (wy + 0.4)) < 0.011, `kerb ${kerb.topY} vs water ${wy}`);
  assert.equal(kerb.footing, null);
  // the bed under the water is levelled (a masked pad round the kerb, >= 6 m) and the sheet stands `level` over it, spanning to the kerb's centre line
  const bed = (plan.worldOps as any[]).find((o) => o.feature?.id === "pb-test-place-core-pit-bed");
  assert.equal(bed?.kind, "heightPatches"); assert.ok(bed.feature.size[0] >= 6);
  // the bed is levelled INSIDE the kerb only: no weight past the kerb's outer face (no ditch round the pit)
  { const f = bed.feature, st = f.size[0] / (f.columns - 1), cx = f.origin[0] + f.size[0] / 2, cz = f.origin[1] + f.size[1] / 2; let centre = 0;
    for (let j = 0; j < f.rows; j++) for (let i = 0; i < f.columns; i++) { const w = f.weights[j * f.columns + i], d = Math.hypot(f.origin[0] + i * st - cx, f.origin[1] + j * st - cz);
      if (d > Math.hypot(4.45, 3.45) + 0.01) assert.equal(w, 0, `weight ${w} ${d.toFixed(1)} m out, past the kerb`); if (d < 1) centre = Math.max(centre, w); }
    assert.equal(centre, 1); }
  assert.ok(Math.abs(wy - (bed.feature.heights[0] + 0.15)) < 0.011, `water ${wy} over the bed ${bed.feature.heights[0]}`);
  const mesh = water.entity.components.mesh;
  assert.equal(mesh.source.kind, "surface"); assert.equal(mesh.material, "m/brown-water");
  assert.deepEqual([Math.max(...mesh.source.positions.filter((_: number, i: number) => i % 3 === 0)), Math.max(...mesh.source.positions.filter((_: number, i: number) => i % 3 === 2))], [4, 3]);
  assert.equal(water.entity.components.water.swim, false);
  assert.ok(water.entity.tags.includes("water"));
  assert.deepEqual(primitiveMeshes(plan.ops), []);
  // contents are structures of the pocket: the stone stands ON the sheaf
  const sheaf = plan.ops.find((o) => o.id === "test-place-core-pit-1"), stone = plan.ops.find((o) => o.id === "test-place-core-pit-2");
  assert.ok(sheaf && stone && stone.entity.tags.includes("on:pit-1"), plan.faults.join(" | "));
  // a stone in a basin draws with the kerb's stone (the zone's built stone here), never the rock skin
  assert.ok(stone.entity.tags.includes("stone:zone-stone/face"), stone.entity.tags.join());
  assert.ok(!sheaf.entity.tags.some((t: string) => t.startsWith("stone:")));
  // a `kerb` content lies on the kerb top (the level coping), not in the water
  const heap = plan.ops.find((o) => o.id === "test-place-core-pit-3");
  assert.ok(heap, plan.faults.join(" | "));
  assert.ok(heap.entity.tags.includes("on:pit"), "a kerb piece is on its wall (the seated gate skips it)");
  assert.ok(Math.abs(heap.entity.components.transform.position[1] + root[1] - kerb.topY) < 0.011, `heap ${heap.entity.components.transform.position[1] + root[1]} vs kerb ${kerb.topY}`);
  assert.ok(plan.handoff.siteDressing.keepClear.some((k: any) => k.id === "core-pit-basin"));
  assert.ok(plan.clearings.some((k: any) => k.id === "test-place-core-pit-basin" && k.walk === false));
  assert.deepEqual(unclearedStructures(plan.handoff.siteDressing.keepClear.filter((k: any) => k.id === "core-pit-basin"), plan.clearings), [], "the basin clearing covers the kerb corners");
  // the floor is a ground paint, its grass cleared
  const floor = (plan.worldOps as any[]).find((o) => o.feature?.id === "pb-test-place-core-floor");
  assert.equal(floor?.kind, "groundPaints"); assert.equal(floor.feature.surface, "zone-paving"); assert.equal(floor.feature.radius, 5);
  // a floor's contents are set as structures at fixed spots (stacked with `on`)
  const board = plan.ops.find((o) => o.id === "test-place-core-floor-1"), top = plan.ops.find((o) => o.id === "test-place-core-floor-3");
  assert.ok(board && top && top.entity.tags.includes("on:floor-2"));
  // a basin is a closed square kerb
  const bad = (w: object) => placeArchetypeSchema.parse({ ...raw, pockets: [{ ...raw.pockets[0], walls: [{ ...raw.pockets[0]!.walls[0], ...w }] }] });
  assert.throws(() => bad({ gate: 2 }), /closed square kerb/);
  assert.throws(() => bad({ shape: "ring" }), /closed square kerb/);
  assert.throws(() => bad({ basin: { material: "m", contents: [{ prefab: "a/b", on: 0 }] } }), /EARLIER/);
  // a flight steps by its beds: `bed` = metres from the pocket's ground
  const stepped = planPlace(placeArchetypeSchema.parse({ ...raw, pockets: [{ ...raw.pockets[0], walls: [{ ...raw.pockets[0]!.walls[0], basin: { ...raw.pockets[0]!.walls[0]!.basin, bed: -0.5 } }] }] }), input, ground);
  const sb = (stepped.worldOps as any[]).find((o) => o.feature?.id === "pb-test-place-core-pit-bed");
  assert.ok(Math.abs(sb.feature.heights[0] - (stepped.pockets[0]!.y - 0.5)) < 0.011);
  // a basin's bed paint covers the bed and its cut faces to the kerb's outer face
  const painted = planPlace(placeArchetypeSchema.parse({ ...raw, pockets: [{ ...raw.pockets[0], walls: [{ ...raw.pockets[0]!.walls[0], basin: { ...raw.pockets[0]!.walls[0]!.basin, bedSurface: "zone-ground" } }] }] }), input, ground);
  const bp = (painted.worldOps as any[]).find((o) => o.feature?.id === "pb-test-place-core-pit-bed-paint");
  assert.equal(bp?.kind, "groundPaints"); assert.equal(bp.feature.surface, "zone-ground"); assert.equal(bp.feature.faces, true); assert.equal(bp.feature.polygon.length, 4);
  // an open-backed basin (a sluice chute) is a U: its kerb runs three sides, the back left to its gate
  const chute = planPlace(placeArchetypeSchema.parse({ ...raw, pockets: [{ ...raw.pockets[0], walls: [{ ...raw.pockets[0]!.walls[0], basin: { ...raw.pockets[0]!.walls[0]!.basin, open: "back" } }] }] }), input, ground);
  const u = chute.operators.find((o: any) => o.id === "pb-test-place-core-pit");
  assert.equal(u.points.length, 4, JSON.stringify(u.points));
  assert.notDeepEqual(u.points[0], u.points[3], "not closed");
  // a SIGHT pocket (huts on the far bank) is placed but never walked to: no route, its pad no walk target
  const seen = planPlace(placeArchetypeSchema.parse({ ...raw, pockets: [raw.pockets[0], { id: "far", kind: "shore", at: [0.3, 0.3], radius: 6, sight: true, structures: [{ id: "hut", role: "set-piece", prefab: "a/hut", at: [0, 0] }] }] }), input, ground);
  assert.ok(seen.ops.some((o: any) => o.id === "test-place-far-hut"), seen.faults.join(" | "));
  assert.ok(!seen.handoff.navigation.routes.some((r: any) => r.id === "to-far"));
  assert.ok(seen.clearings.some((c: any) => c.id === "test-place-far-pad" && c.walk === false));
  // a sight with no pad stands where it is drawn, wet or not (no dry-pad fit)
  const wetGround = { ...ground, wet: () => true } as typeof ground;
  const drawn = planPlace(placeArchetypeSchema.parse({ ...raw, pockets: [raw.pockets[0], { id: "far", kind: "shore", at: [0.3, 0.3], radius: 6, sight: true, pad: false, structures: [{ id: "hut", role: "set-piece", prefab: "a/hut", at: [0, 0] }] }] }), input, wetGround);
  assert.ok(!drawn.faults.some((f: string) => /pocket far/.test(f)), drawn.faults.filter((f: string) => /far/.test(f)).join(" | "));
  assert.ok(drawn.faults.some((f: string) => /pocket core: no dry ground/.test(f)), "the core still needs its dry pad");
  // its pieces are no rival to the landmark's silhouette (a tall hut across the lake adds no beacon tower)
  const tall = (p: string) => (p === "a/hut" ? 40 : 1);
  assert.equal(silhouetteHeight(placeArchetypeSchema.parse({ ...raw, pockets: [raw.pockets[0], { id: "far", kind: "shore", at: [0.3, 0.3], radius: 6, sight: true, structures: [{ id: "hut", role: "set-piece", prefab: "a/hut", at: [0, 0] }] }] }), "small", tall).other, silhouetteHeight(placeArchetypeSchema.parse(raw), "small", tall).other);
  // a missing water material is a plan fault
  assert.ok(planPlace(a, { ...input, materialExists: () => false }, ground).faults.some((f) => /water material m\/brown-water/.test(f)));
});

test("a basin dug into a rise: its kerb clears the highest ground on its line, the water stays at the bed + level (RETTING)", async () => {
  const { basinWater, KERB_OVER_GROUND_M } = await import("../tools/_place-archetype.mts");
  const wl = placeWallSchema.parse({ id: "pit", shape: "square", at: [0, 0], size: 4, depth: 3, height: 0.6, thickness: 0.9, gate: 0, basin: { material: "m", level: 0.6, kerb: 0.3 } });
  // a level bed at 10 inside the kerb; the ground rises to 11.5 on the +x side outside it
  const ground = (x: number, z: number) => (Math.abs(x) <= 3.56 && Math.abs(z) <= 2.56 ? 10 : 10 + Math.max(0, x) * 0.3);
  const b = basinWater(wl, [0, 0], [0, 1], ground);
  assert.equal(b.waterY, 10.6);
  assert.ok(b.topY >= 10 + 4 * 0.3 + KERB_OVER_GROUND_M - 0.011, `kerb top ${b.topY}`);
  // on level ground the kerb is water + kerb, as before
  assert.equal(basinWater(wl, [0, 0], [0, 1], () => 10).topY, 10.9);
});

test("read.ratio: a farm's silhouette need not stand twice its byre (owner ruling 2026-10-23: a burnt croft is never a 9 m tower)", () => {
  const raw = { id: "steading", title: "steading", description: "a burnt croft", pockets: [{ id: "core", kind: "landmark", radius: 30,
    walls: [{ id: "croft", shape: "square", at: [0, -7], height: 5, thickness: 0.7, gate: 1.4, landmark: { fogReach: 600, silhouette: 0.6, height: 5 } }],
    structures: [{ id: "byre", role: "set-piece", prefab: "a/hut", at: [-8, 9] }] }] };
  const hut = (p: string) => (p === "a/hut" ? 4.5 : 1);
  const strict = silhouetteHeight(placeArchetypeSchema.parse({ ...raw, read: { band: [60, 90], duskLight: false, reason: "test" } }), "small", hut);
  assert.equal(strict.other, 4.5);
  assert.equal(strict.floor, Math.max(heightForPx(90), 2 * 4.5), "the default: the landmark stands twice the tallest other piece");
  const farm = silhouetteHeight(placeArchetypeSchema.parse({ ...raw, read: { band: [60, 90], ratio: 1.1, duskLight: false, reason: "test" } }), "small", hut);
  assert.equal(farm.floor, Math.max(heightForPx(90), 1.1 * 4.5));
  assert.ok(farm.landmark >= farm.floor, `a 5 m house shell beside a 4.5 m byre is the silhouette of a farm (floor ${farm.floor.toFixed(2)})`);
  assert.throws(() => placeArchetypeSchema.parse({ ...raw, read: { ratio: 0.5, duskLight: false, reason: "test" } }), /ratio/);
});

// --- TOOLS-PB 2026-10-23: builder faults found auditing the Tinkers' Camp lab against its sets ---
import { requestedShortfall, fillerFor, spreadReach, CLOSE_VIEW_M } from "../tools/_place-archetype.mts";
const campRaw = () => JSON.parse(fs.readFileSync(path.join(DIR, "camp.json"), "utf8"));
const flat: PlaceGround = { height: () => 20, wet: () => false };

test("TOOLS-PB 1 silent drop: a requested prop that does not land is a dress fault naming the prop and why", () => {
  const a = forTier(placeArchetypeSchema.parse(applySets(campRaw(), ['core.dressing.props=[{"prop":"codex-craft/wreck-salvage-pile","count":1}]'])), "medium");
  const info = (p: string) => (p === "codex-craft/wreck-salvage-pile" ? { cultures: ["giant"] } : null);
  const p = planPlace(a, { ...input, propInfo: info }, flat), req = p.requested["test-place-core"]!;
  assert.deepEqual(req.map((q) => [q.prop, q.count]), [["codex-craft/wreck-salvage-pile", 1]]);
  const items = p.plans.find((d: any) => d.id === "test-place-core")?.items ?? [];
  const faults = requestedShortfall(req, items);
  assert.equal(faults.length, 1); assert.match(faults[0]!, /wreck-salvage-pile: 0\/1 placed \(wrong culture/);
  // a dress-loop drop (no room on the socket map) names its reason; a placed prop is no fault
  assert.match(requestedShortfall([{ prop: "x/y", count: 1 }], [], [{ prop: "x/y", why: "auto-no-room: no open spot >= footprint in core" }])[0]!, /x\/y: 0\/1 placed \(auto-no-room/);
  assert.match(requestedShortfall([{ prop: "x/y", count: 2 }], [{ prop: "x/y" }])[0]!, /1\/2 placed \(dropped without a record\)/);
  assert.deepEqual(requestedShortfall([{ prop: "x/y", count: 1 }], [{ prop: "x/y" }]), []);
});

test("TOOLS-PB 2 hero top-up: listed props keep their exact counts; the top-up draws only from the filler", () => {
  const items = firstPlanItems([{ prop: "codex-craft/figurehead", count: 1, prefer: "open" }], "core", 24, "camp", () => true, undefined, { filler: ["rock-kit/boulder-s-1", "rural-props/hay-bale", "codex-craft/figurehead"] });
  assert.ok(items.length >= 6, `${items.length}`);
  assert.equal(items.filter((i) => i.prop === "codex-craft/figurehead").length, 1);
  assert.ok(items.filter((i) => i.prop !== "codex-craft/figurehead").every((i) => ["rock-kit/boulder-s-1", "rural-props/hay-bale"].includes(i.prop) && i.id.startsWith("fill-")));
  assert.deepEqual(fillerFor([], "camp", () => true, ["camp-props/banner"]), ROOM_FILL.camp!.filter((q) => q !== "camp-props/banner"), "no filler: the role's fill, never a requested prop");
  assert.ok(all.find((x) => x.id === "camp")!.filler.length > 0, "camp declares its filler");
});

test("TOOLS-PB 3 pocket spread: spreadMax keeps every pocket near the core; the plan says the tier it built", () => {
  const camp = forTier(all.find((x) => x.id === "camp")!, "medium");
  assert.equal(camp.spreadMax, 30);
  const p = planPlace(camp, input, flat), core = p.pockets[0]!;
  for (const k of p.pockets.slice(1)) {
    const reach = spreadReach(camp, camp.pockets[0]!, camp.pockets.find((x) => x.id === k.id)!), d = Math.hypot(k.at[0] - core.at[0], k.at[1] - core.at[1]);
    assert.ok(d <= reach + 0.5 && reach < 60, `${k.id} ${d.toFixed(1)} m from the core (reach ${reach})`);
  }
  assert.ok(p.notes.some((n) => /^TIER: built medium; pockets within 30 m/.test(n)), p.notes.join(" | "));
  const free = planPlace({ ...camp, spreadMax: undefined }, input, flat);
  assert.ok(free.pockets.slice(1).some((k) => Math.hypot(k.at[0] - free.pockets[0]!.at[0], k.at[1] - free.pockets[0]!.at[1]) > 100), "uncapped: the tier's spread");
  for (const id of ["croft-row", "work-yard", "shrine", "den"]) assert.ok(all.find((x) => x.id === id)!.spreadMax! > 0, id);
  for (const id of ["castle", "engine-house", "beach-landing"]) assert.equal(all.find((x) => x.id === id)!.spreadMax, undefined, id);
});

test("TOOLS-PB 5 honest road read: no standable spot in the band is a named reason, never the far end as if measured", () => {
  const band = readBand("medium"), wetBand = (q: [number, number]) => { const d = Math.hypot(q[0], q[1]); return d < 200 || d > 420; };
  const spots = approachSpots([0, 0], [[[0, 560], [0, 0]]], band, wetBand);
  assert.equal(spots.length, 1); assert.match(spots[0]!.reason!, /^no standable spot in band 225-300 m \(wet\/steep\); nearest standable at \d+ m/);
  const r = approachRead(flat, { at: [0, 0], top: 30, fogReach: 900 }, spots);
  assert.ok(!r.ok && r.rows[0]!.reason && !r.rows[0]!.reads, JSON.stringify(r.rows));
  assert.equal(approachSpots([0, 0], [[[0, 80], [0, 0]]], band)[0]!.reason, undefined, "a short line is still judged from its far end");
});

test("TOOLS-PB 6 views as a set: design views in the place frame, two close views per pocket in place of core-front", () => {
  const a = forTier(placeArchetypeSchema.parse(applySets(campRaw(), ['views=[{"name":"forge-glow","camera":[0,1.7,12],"target":[0,1,0]}]'])), "medium");
  const p = planPlace(a, input, flat), names = p.handoff.viewpoints.map((v: any) => v.name);
  for (const k of a.pockets) assert.ok(names.includes(`${k.id}-close`) && names.includes(`${k.id}-close-side`), `${k.id}: ${names.join()}`);
  assert.ok(!names.includes("core-front"));
  const cc = p.handoff.viewpoints.find((v: any) => v.name === "core-close"), c = p.pockets[0]!.at;
  assert.ok(Math.hypot(cc.x - c[0], cc.z - c[1]) <= CLOSE_VIEW_M + 20, JSON.stringify(cc));
  assert.equal(p.setViews.length, 1);
  const v = p.setViews[0]; assert.equal(v.name, "forge-glow"); assert.equal(v.camera[1], Math.round((p.padY + 1.7) * 100) / 100); assert.equal(v.target[1], Math.round((p.padY + 1) * 100) / 100);
  assert.ok(Math.abs(Math.hypot(v.camera[0] - p.centre[0], v.camera[2] - p.centre[1]) - 12) < 0.05);
});

test("TOOLS-PB 7 burnt shell: croft shells stand 4-5 m charred walls, never with buttresses", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, "croft-row.json"), "utf8"));
  const a = forTier(placeArchetypeSchema.parse(applySets(raw, ["core.croft.shell=burnt"])), "medium");
  const walls = planPlace(a, input, flat).operators.filter((o: any) => o.op === "wall" && /-core-croft/.test(o.id));
  assert.ok(walls.length >= 3, walls.map((o: any) => o.id).join());
  for (const o of walls) { assert.ok(o.height >= 4 && o.height <= 5, `${o.id} ${o.height}`); assert.equal(o.buttresses, undefined, o.id); }
  const stub = planPlace(forTier(placeArchetypeSchema.parse(raw), "medium"), input, flat).operators.filter((o: any) => o.op === "wall" && /-core-croft/.test(o.id));
  assert.ok(stub.every((o: any) => o.height < 4), "without the set: as before");
});

// TOOLS-LAYOUT 2026-10-24: the owner's layout.json is the composition; the tool honours it exactly or refuses at plan
const SIZES: Record<string, number[]> = { "camp-props/bonfire": [4.81, 3.53, 5.1], "camp-props/tent": [4.16, 3.03, 4.16], "house-vehicles/cargo-wagon": [2.37, 3.45, 3.8], "x/slab": [12, 1, 12], "composite-props/ash-drift": [4, 0.02, 4] };
const sized = (p: string) => (SIZES[p] ? { size: SIZES[p] } : null);
const layoutOf = (pieces: any[], extra: any = {}) => placeLayoutSchema.parse({ version: 1, frame: "place", origin: [0, 0], pieces, ...extra });
const FIRE = { id: "fire", element: "smoke", kind: "fire", prefab: "camp-props/bonfire", at: [0, 0], scale: 0.5, landmark: { height: 9 } };
const layoutPlan = (l: any, a0 = forTier(placeArchetypeSchema.parse(campRaw()), "medium"), extra: any = {}) => planPlace(withLayout(a0, l, sized), { ...input, propInfo: sized, layout: l, ...extra }, flat);

test("TOOLS-LAYOUT 1: layout pieces stand exactly where drawn (place frame), never re-fitted; overlapping pieces are a refusal naming both", () => {
  const l = layoutOf([FIRE, { id: "tent-n", element: "tents", kind: "structure", prefab: "camp-props/tent", at: [6, 1], yaw: 200 }, { id: "wagon", element: "wagon", kind: "prop", prefab: "house-vehicles/cargo-wagon", at: [-7, -4], yaw: 70 }]);
  const p = layoutPlan(l);
  assert.deepEqual(p.centre, [0, 0], "the core is pinned on the layout's origin");
  assert.deepEqual(p.faults.filter((f) => /^LAYOUT/.test(f)), []);
  for (const q of l.pieces) {
    const e = p.ops.find((o: any) => o.id === `test-place-core-${q.id}`)!, w = toWorld(p.centre, p.front, q.at);
    assert.ok(e, q.id); const pos = e.entity.components.transform.position;
    assert.ok(Math.abs(pos[0] - (w[0] - p.centre[0])) < 0.01 && Math.abs(pos[2] - (w[1] - p.centre[1])) < 0.01, `${q.id} at ${pos} (want ${w})`);
    assert.equal(pos[1], 0, `${q.id} settled on the (flat) ground`);
  }
  const tent = p.ops.find((o: any) => o.id === "test-place-core-tent-n")!.entity.components.transform.rotation, ang = Math.atan2(p.front[0], p.front[1]) + (200 * Math.PI) / 180;
  assert.ok(Math.abs(Math.abs(tent[1]) - Math.abs(Math.sin(ang / 2))) < 1e-3, "yaw as drawn");
  const bad = layoutPlan(layoutOf([FIRE, { id: "tent-a", element: "tents", kind: "structure", prefab: "camp-props/tent", at: [5, 0] }, { id: "tent-b", element: "tents", kind: "structure", prefab: "camp-props/tent", at: [8, 1] }]));
  assert.ok(bad.faults.some((f) => /LAYOUT: pieces tent-a and tent-b overlap/.test(f)), bad.faults.join(" | "));
  assert.ok(!bad.faults.some((f) => /fire and tent/.test(f)), "the fire and a tent 5 m off do not touch");
  // wet, outside and uncatalogued are refusals naming the piece; the uncatalogued piece is not placed
  const wl = layoutOf([FIRE, { id: "boat", element: "x", kind: "prop", prefab: "x/slab", at: [-20, 0] }, { id: "wade", element: "x", kind: "prop", prefab: "house-vehicles/cargo-wagon", at: [20, 0] }]);
  const wet = planPlace(withLayout(forTier(placeArchetypeSchema.parse(campRaw()), "medium"), wl, sized), { ...input, propInfo: sized, layout: wl, catalogued: (id: string) => id !== "x/slab" }, { height: () => 20, wet: (x) => x < -15 });
  assert.ok(wet.faults.some((f) => /LAYOUT: piece wade: at 20,0 stands in water/.test(f)), wet.faults.join(' | '));
  assert.ok(wet.ops.some((o: any) => o.id === 'test-place-core-wade'), 'a refused piece that exists is placed where drawn, never moved');
  assert.ok(wet.faults.some((f) => /LAYOUT: piece boat: x\/slab is not catalogued/.test(f)), wet.faults.join(" | "));
  assert.ok(!wet.ops.some((o: any) => o.id === "test-place-core-boat"));
  const far = layoutPlan(layoutOf([FIRE, { id: "far", element: "x", kind: "prop", prefab: "house-vehicles/cargo-wagon", at: [0, 900] }]));
  assert.ok(far.faults.some((f) => /LAYOUT: piece far: .*outside the usable area/.test(f)), far.faults.join(" | "));
  // layout views replace the set (place frame, y over padY)
  const v = layoutPlan(layoutOf([FIRE], { views: [{ name: "fire-close", camera: [0, 1.7, 6], target: [0, 1, 0] }] }));
  assert.deepEqual(v.setViews.map((x: any) => x.name), ["fire-close"]);
});

test("TOOLS-LAYOUT 2: the filler yields to layout footprints; no archetype structure, beacon or listed prop is added under a layout", () => {
  const raw = applySets(campRaw(), ['read.beacon={"structures":[{"id":"a","role":"set-piece","prefab":"codex-craft/tinkers-pot-tripod","at":[0,-4],"footprint":3,"landmark":{"fogReach":700,"silhouette":0.7,"height":9}}]}']);
  const a0 = forTier(placeArchetypeSchema.parse(raw), "medium");
  assert.ok(a0.pockets[0]!.structures.some((s) => s.id === "beacon"), "the archetype alone adds its beacon");
  const fills = (p: ReturnType<typeof planPlace>) => (p.plans.find((d: any) => d.id === "test-place-core")?.items ?? []).filter((i: any) => /^fill-/.test(i.id)).length;
  const bare = layoutPlan(layoutOf([FIRE]), a0), slabs = layoutPlan(layoutOf([FIRE, { id: "s1", element: "x", kind: "prop", prefab: "x/slab", at: [10, 0] }, { id: "s2", element: "x", kind: "prop", prefab: "x/slab", at: [-10, 0] }]), a0);
  assert.ok(fills(slabs) < fills(bare), `fill with 288 m2 of pieces ${fills(slabs)} < without ${fills(bare)}`);
  assert.ok(slabs.notes.some((n) => /core dressing: 294.1 m2 of the area is layout pieces/.test(n)), slabs.notes.join(" | "));
  const ids = bare.ops.map((o: any) => o.id);
  assert.ok(!ids.some((id: string) => /beacon|tent-a|tent-b|shelter|torch/.test(id)), ids.join());
  assert.ok(!bare.operators.some((o: any) => /beacon/.test(o.id)), "no silhouette tower");
  const core = bare.plans.find((d: any) => d.id === "test-place-core")!;
  assert.ok(!core.items.some((i: any) => ["poi-props/crate", "house-interior/barrel-a"].includes(i.prop)), "the archetype's listed props are not added");
  assert.equal(core.arrangements?.[0]?.anchor, "structure:core-fire", "the camp vignette anchors on the layout's fire");
  // a pocket named by pieces is centred on them
  const work = layoutPlan(layoutOf([FIRE, { id: "forge", element: "x", kind: "structure", prefab: "camp-props/tent", at: [-11, 2], pocket: "work" }]));
  const wk = work.pockets.find((k) => k.id === "work")!, fw = toWorld(work.centre, work.front, [-11, 2]);
  assert.ok(Math.hypot(wk.at[0] - fw[0], wk.at[1] - fw[1]) < 0.01, JSON.stringify(wk.at));
});

test("TOOLS-LAYOUT 3: coverage both ways: an element made of catalogue props needs a piece; a piece must name a real element", () => {
  const design = { elements: [{ id: "tents", madeOf: ["camp-props/tent"] }, { id: "smoke", madeOf: ["camp-props/bonfire"] }, { id: "sully", madeOf: ["creature: Tinker Sully"] }, { id: "board", madeOf: ["house-interior/notice-board"] }, { id: "gone", madeOf: ["no/such"] }] };
  const l = layoutOf([FIRE, { id: "odd", element: "nowhere", kind: "prop", prefab: "camp-props/tent", at: [6, 0] }]);
  const f = layoutCoverage(design, l, { catalogued: (id) => id !== "no/such", questProps: ["house-interior/notice-board"] });
  assert.deepEqual(f.sort(), ["element tents has no layout piece", "piece odd names unknown element nowhere"]);
  assert.deepEqual(layoutCoverage(design, layoutOf([FIRE, { id: "t", element: "tents", kind: "structure", prefab: "camp-props/tent", at: [6, 0] }]), { questProps: ["house-interior/notice-board"], catalogued: (id) => id !== "no/such" }), []);
});

test("TOOLS-LAYOUT 4: ground wear is painted where drawn in the zone's surface; a kind with no surface is a refusal naming it", () => {
  const l = layoutOf([FIRE, { id: "ash-1", element: "smoke", kind: "decal", prefab: "composite-props/ash-drift", at: [1, 1] }],
    { ground: [{ id: "trodden", kind: "wear", at: [0, 0], radius: 7 }, { id: "lines", kind: "mud", at: [0, -16], radius: 5 }, { id: "ash", kind: "ash", at: [0, 0], radius: 3 }] });
  const p = layoutPlan(l, undefined, { surfaces: ["dirt", "mud", "z-paving", "w-z-road"] });
  const paint = (id: string) => p.worldOps.find((w: any) => w.feature?.id === `pb-test-place-ground-${id}`) as any;
  assert.equal(paint("trodden").feature.surface, "w-z-road", "the zone's own track surface first");
  assert.equal(paint("lines").feature.surface, "mud");
  const at = toWorld(p.centre, p.front, [0, -16]); assert.deepEqual(paint("lines").feature.center, [Math.round(at[0] * 100) / 100, Math.round(at[1] * 100) / 100]);
  assert.equal(paint("ash"), undefined);
  assert.ok(p.faults.some((f) => /LAYOUT: ground ash: no ash surface in the world palette \(tried w-z-ash, ash\)/.test(f)), p.faults.join(" | "));
  const decal = p.ops.find((o: any) => o.id === "test-place-core-ash-1")!;
  assert.ok(decal.entity.tags.includes("slot:decal") && !p.handoff.siteDressing.keepClear.some((k: any) => k.id === "core-ash-1"), "a decal is no solid");
  assert.ok(!p.faults.some((f) => /ash-1/.test(f)), "a decal under the fire is no overlap");
});

test("TOOLS-LAYOUT 5/6: hero sizes are WARN notes; the camp's default fire is human-scale (the 4.8 m bonfire carries scale 0.5)", () => {
  const p = layoutPlan(layoutOf([{ ...FIRE, scale: 1 }, { id: "slab", element: "x", kind: "prop", prefab: "x/slab", at: [15, 0] }]));
  assert.ok(p.notes.some((n) => /^WARN: piece fire: fire camp-props\/bonfire is 5.1 m across/.test(n)), p.notes.join(" | "));
  assert.ok(p.notes.some((n) => /^WARN: piece slab: prop x\/slab is 12 m across/.test(n)));
  assert.ok(!p.faults.some((f) => /WARN/.test(f)), "a warning, never a refusal");
  const fire = placeArchetypeSchema.parse(campRaw()).pockets[0]!.structures.find((s) => s.role === "fire")!;
  assert.equal(fire.prefab, "camp-props/bonfire");
  assert.ok(Math.max(SIZES[fire.prefab]![0]!, SIZES[fire.prefab]![2]!) * fire.scale <= 2.6, `${fire.scale}`);
});

test("TOOLS-LAYOUT 6: under a layout the core walls stand at their written `at` (the tier spread is undone), in the pieces' frame", () => {
  const raw = applySets(campRaw(), ['core.walls=[{"id":"chapel","kind":"wall","shape":"square","at":[28,-4],"size":4,"depth":5.5,"height":5,"thickness":0.9,"gate":3.5}]']);
  const a0 = forTier(placeArchetypeSchema.parse(raw), "medium");
  const spread = a0.pockets[0]!.walls.find((w) => w.id === "chapel")!;
  assert.ok(a0.pockets[0]!.fit && a0.pockets[0]!.radius > a0.pockets[0]!.fit!, "the camp core is spread to the medium floor");
  assert.ok(Math.abs(spread.at[0] - 28) > 1, `spreadToFloor moved the wall (${spread.at})`);
  const a1 = withLayout(a0, layoutOf([FIRE, { id: "bell", element: "bell", kind: "prop", prefab: "house-vehicles/cargo-wagon", at: [16, -2] }]), sized);
  const w = a1.pockets[0]!.walls.find((x) => x.id === "chapel")!;
  assert.deepEqual(w.at, [28, -4], `the wall stands where the owner wrote it (${w.at})`);
  assert.equal(w.size, spread.size, "a wall's size is not touched");
});

// TOOLS-LAYOUT-2 2026-10-24: the faults the Exiles' Bell left in the tools
import { shellStandIn, layoutSizeWarn } from "../tools/_place-archetype.mts";

test("TOOLS-LAYOUT-2 1: `over` exempts a piece pair from the overlap refusal, both directions; other pairs still refused", () => {
  const tents = (over: any) => [FIRE, { id: "tent-a", element: "tents", kind: "structure", prefab: "camp-props/tent", at: [5, 0], ...over }, { id: "tent-b", element: "tents", kind: "structure", prefab: "camp-props/tent", at: [8, 1] }];
  for (const l of [layoutOf(tents({ over: ["tent-b"] })), layoutOf([...tents({}).slice(0, 2), { ...tents({})[2], over: ["tent-a"] }])])
    assert.ok(!layoutPlan(l).faults.some((f) => /overlap/.test(f)), "a pair meant to overlap is no fault");
  const three = layoutPlan(layoutOf([...tents({ over: ["tent-b"] }), { id: "tent-c", element: "tents", kind: "structure", prefab: "camp-props/tent", at: [6.5, -2] }]));
  assert.ok(three.faults.some((f) => /pieces tent-a and tent-c overlap/.test(f)) && !three.faults.some((f) => /tent-a and tent-b/.test(f)), three.faults.join(" | "));
});

test("TOOLS-LAYOUT-2 2: a layout piece naming a quest slot puts the quest entity at its spot (the mending board lands at its piece)", () => {
  const l = layoutOf([FIRE, { id: "board", element: "board", kind: "prop", prefab: "house-interior/notice-board", at: [4, -6], yaw: 30, quest: "mending-board" }]);
  const a0 = forTier(placeArchetypeSchema.parse(applySets(campRaw(), ["quest.mending-board=house-interior/notice-board"])), "medium");
  const p = layoutPlan(l, a0, { questObjects: [{ id: "mending-board", kind: "readable" }] });
  const item = p.plans.find((d: any) => d.id === "test-place-core")!.items.find((it: any) => it.id === "mending-board");
  const w = toWorld(p.centre, p.front, [4, -6]), deg = ((((Math.atan2(p.front[0], p.front[1]) * 180) / Math.PI + 30) % 360) + 360) % 360;
  assert.equal(item.place.kind, "floor"); assert.deepEqual(item.quest, { entity: "mending-board" });
  assert.ok(Math.abs(item.place.at[0] - w[0]) < 0.01 && Math.abs(item.place.at[1] - w[1]) < 0.01, `${item.place.at} want ${w}`);
  assert.ok(Math.abs(item.place.yaw - deg) < 0.02, `${item.place.yaw} want ${deg}`);
  assert.ok(!p.ops.some((o: any) => o.id === "test-place-core-board"), "the quest piece is not also built as a structure");
  const design = { elements: [{ id: "board", madeOf: ["house-interior/notice-board"] }, { id: "smoke", madeOf: ["camp-props/bonfire"] }] };
  assert.deepEqual(layoutCoverage(design, l, { questProps: ["house-interior/notice-board"] }), [], "the quest element is covered by its piece");
});

test("TOOLS-LAYOUT-2 3: a hero prop is requested at its size and the Codex brief says so; a codex-craft piece scaled over x1.2 WARNs", async () => {
  const { addRequest, readRequests } = await import("../tools/_prop-composite-guard.mts");
  const { writeBrief } = await import("../tools/prop-codex/brief.mts");
  const os = await import("node:os"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-size-"));
  try {
    const r = addRequest(tmp, { name: "cracked great bell", culture: "rural", scale: "human", for: "exiles-bell", why: "hero", size: 2.6 });
    assert.equal(readRequests(tmp)[0]!.size, 2.6);
    assert.match(writeBrief({ request: { ...r, project: "p" }, name: "cracked-great-bell", scale: { id: "human", height: 1.8 } } as any), /The finished prop is 2.6 m tall; do not scale later/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.match(layoutSizeWarn({ kind: "prop", prefab: "codex-craft/salvage-winch-boom", scale: 1.5 }, [2, 3, 2]) ?? "", /made too small: re-request at 4.5 m/);
  assert.equal(layoutSizeWarn({ kind: "prop", prefab: "codex-craft/salvage-winch-boom", scale: 1.2 }, [2, 3, 2]), null, "x1.2 is allowed");
});

test("TOOLS-LAYOUT-2 4: ground discs read: >= 4 m, 1 m feather, wear in the darkest dirt (not the gravel road); rubble = 6-10 catalogued stones in the disc", () => {
  const l = layoutOf([FIRE], { ground: [{ id: "trodden", kind: "wear", at: [0, 0], radius: 2 }, { id: "spill", kind: "rubble", at: [10, -10], radius: 3 }] });
  const p = layoutPlan(l, undefined, { surfaces: ["dirt", "w-z-road", "w-z-ground"], surfaceColors: { dirt: "#6b543a", "w-z-road": "#645847", "w-z-ground": "#3e312a" }, catalogued: () => true });
  const wear = (p.worldOps.find((w: any) => w.feature?.id === "pb-test-place-ground-trodden") as any).feature;
  assert.equal(wear.surface, "w-z-ground", "the darkest candidate"); assert.equal(wear.radius, 4); assert.equal(wear.feather, 1); assert.ok(wear.edgeNoise > 0);
  const stones = p.ops.filter((o: any) => o.id.startsWith("test-place-core-spill-"));
  assert.ok(stones.length >= 6 && stones.length <= 10, `${stones.length}`);
  const c = toWorld(p.centre, p.front, [10, -10]);
  for (const s of stones) { const pos = s.entity.components.transform.position; assert.match(s.entity.components.prefab.prefabId, /^rock-kit\/boulder-s-/); assert.ok(s.entity.tags.includes("slot:rubble"));
    assert.ok(Math.hypot(pos[0] + p.centre[0] - c[0], pos[2] + p.centre[1] - c[1]) <= 4, "inside the (raised) disc"); }
  assert.ok(!p.worldOps.some((w: any) => w.feature?.id === "pb-test-place-ground-spill"), "rubble is stones, not a paint");
});

test("TOOLS-LAYOUT-2 8: a wall-operator building shell is noted (with the kit alternative once wfc-ruins exist), never refused — kit and custom builds mix", () => {
  assert.equal(shellStandIn({ id: "yard", kind: "wall", shape: "square", height: 1.4 }), null, "a dyke is a wall");
  assert.equal(shellStandIn({ id: "chapel", kind: "keep", shape: "square", height: 18 }), null, "a built kind is not a shell");
  assert.match(shellStandIn({ id: "chapel", kind: "wall", shape: "square", height: 5 }) ?? "", /names a building/);
  const raw = applySets(campRaw(), ['core.walls=[{"id":"chapel","kind":"wall","shape":"square","at":[20,-4],"size":4,"height":5,"thickness":0.9,"gate":2}]']);
  const a0 = forTier(placeArchetypeSchema.parse(raw), "medium");
  const plain = planPlace(a0, input, flat), withKit = planPlace(a0, { ...input, kitBuildings: true }, flat), re = /chapel is a wall-operator shell/;
  assert.ok(plain.notes.some((n) => re.test(n) && !/wfc-ruins/.test(n)) && !plain.faults.some((f) => re.test(f)), plain.notes.join(" | "));
  assert.ok(withKit.notes.some((n) => re.test(n) && /wfc-ruins/.test(n)) && !withKit.faults.some((f) => re.test(f)), withKit.faults.join(" | "));
});

test("TOOLS-LAYOUT-2 7: the shots cap grows with the spots; a stalled spot times out and the run goes on", async () => {
  const { shotsCapMs, withSpotTimeout } = await import("../tools/_run-capped.mts");
  assert.equal(shotsCapMs(3), 15 * 60_000); assert.equal(shotsCapMs(12), 12 * 2 * 50_000);
  assert.equal(await withSpotTimeout(new Promise(() => {}), 50), "timeout");
  assert.equal(await withSpotTimeout(Promise.resolve("shot"), 1000), "shot");
});

test("TOOLS-LAYOUT 9: a piece's `lift` raises it above its seat; a layout landmark piece strips the archetype walls' landmark", () => {
  const raw = applySets(campRaw(), ['core.walls=[{"id":"dyke","kind":"wall","shape":"line","points":[[-10,12],[10,12]],"height":1.1,"thickness":0.6,"landmark":{"fogReach":500,"silhouette":1,"height":16}}]', 'core.fire.landmark=null']);
  const a0 = forTier(placeArchetypeSchema.parse(raw), "medium");
  const l = layoutOf([{ ...FIRE, landmark: undefined }, { id: "hall", element: "hall", kind: "structure", prefab: "x/slab", at: [0, -8], lift: 0.6, landmark: { fogReach: 500, silhouette: 1, height: 16 } }]);
  const a1 = withLayout(a0, l, sized);
  assert.ok(a1.pockets[0]!.walls.every((w) => !w.landmark), "the dyke's placeholder landmark is dropped");
  assert.equal(a1.pockets[0]!.structures.find((s) => s.id === "hall")!.lift, 0.6);
  const p = layoutPlan(l, a0);
  const hall = p.ops.find((o: any) => o.id === "test-place-core-hall"), fire = p.ops.find((o: any) => o.id === "test-place-core-fire");
  assert.ok(hall && fire, p.ops.map((o: any) => o.id).join());
  assert.ok(hall.entity.tags.includes("lift:0.6"), "the seated gate reads the lift from the entity tags");
  assert.ok(hall.entity.components.transform.position[1] - fire.entity.components.transform.position[1] >= 0.55, `lifted ${hall.entity.components.transform.position[1]} vs ${fire.entity.components.transform.position[1]}`);
});

test("TOOLS-LAYOUT 10: wet ground refuses a piece unless it says `wet: true` (drowned steps, reeds)", () => {
  const a0 = forTier(placeArchetypeSchema.parse(campRaw()), "medium");
  const reeds = (at: [number, number], wet?: boolean) => layoutOf([FIRE, { id: "reeds", element: "reeds", kind: "prop", prefab: "house-vehicles/cargo-wagon", at, ...(wet ? { wet } : {}) }]);
  const plan = (l: any) => planPlace(withLayout(a0, l, sized), { ...input, propInfo: sized, layout: l }, ground);
  const inWater = (p: any) => p.faults.filter((f: string) => /piece reeds: .*stands in water/.test(f));
  // the place frame turns with the approach: find the spot that lands under the stub's sea (world x < -80)
  const spot = ([[-60, 0], [0, -60], [60, 0], [0, 60], [-90, 0], [0, -90], [90, 0], [0, 90]] as [number, number][]).find((q) => inWater(plan(reeds(q))).length === 1);
  assert.ok(spot, "no spot of the test frame lands in the stub's sea");
  assert.equal(inWater(plan(reeds(spot!, true))).length, 0, "wet: true lets the piece stand in water");
});

test("discStats: a piece under 2 m radius is sampled at its rim too, so a rock face under it reads steep (o-small 2026-10-29)", () => {
  // a 5 m step 1 m north of the centre: flat at z > -1, a face from z -1 to -2, the top behind
  const ground = { height: (_x: number, z: number) => (z > -1 ? 0 : z < -2 ? 5 : 5 * (-1 - z)), wet: () => false };
  assert.ok(discStats(ground, [0, 0], 1.65).steep > 0.6, "the trough's rim reaches the face: steep");
  assert.equal(discStats(ground, [0, 3], 1.65).steep, 0, "the same piece 3 m out on the flat is not");
  assert.ok(discStats(ground, [0, 0], 4).steep > 0.6, "the 2 m rings still see it for a big piece");
});

// L (Red Dial 2026-10-29): a layout piece may stand ON an earlier piece, and a layout `waters` entry fills a built
// basin at its marker (one still level) instead of the basin standing dry.
test("layout: `on` passes through to the core structure; `waters` parse, count for coverage, and land at the marker", () => {
  const l = layoutOf([{ id: "plinth", element: "p", kind: "structure", prefab: "x/plinth", at: [0, 0] }, { id: "ring", element: "p", kind: "structure", prefab: "x/ring", at: [0, -1], on: "plinth", over: ["plinth"] }, { id: "block", element: "w", kind: "structure", prefab: "x/basin", at: [20, 0] }],
    { waters: [{ id: "basin", element: "w", on: "block", material: "terrain/x-water" }] });
  assert.equal(l.waters[0]!.marker, "basin-water");
  assert.equal(l.waters[0]!.swim, false);
  assert.deepEqual(layoutCoverage({ elements: [{ id: "p", madeOf: ["x/plinth"] }, { id: "w", madeOf: ["water: the basin"] }] }, l), []);
  // unturned: the marker offset adds straight on; turned a quarter (+Z onto +X): local +Z lands on world +X
  assert.deepEqual(waterAtMarker({ w: [10, 5], ang: 0, y: 2, k: 1 }, { position: [1, -0.9, -1] }), { w: [11, 4], y: 1.1, ang: 0 });
  const q = waterAtMarker({ w: [0, 0], ang: Math.PI / 2, y: 0, k: 2 }, { position: [0, 0, 1] });
  assert.deepEqual(q.w, [2, 0]);
  assert.throws(() => layoutOf([{ id: "a", element: "p", kind: "structure", prefab: "x/a", at: [0, 0] }], { waters: [{ id: "w", on: "a" }] }));
});

test("layout sink: a decal piece may stand below its centre ground (a niche set into a face toe); other pieces default to 0", () => {
  const base = { version: 1, frame: "place", pieces: [{ id: "niche", element: "e", kind: "decal", prefab: "x/y", at: [0, 0], sink: 2.75 }, { id: "jar", element: "e", kind: "prop", prefab: "x/z", at: [3, 0] }] };
  const l = placeLayoutSchema.parse(base);
  assert.equal(l.pieces[0]!.sink, 2.75);
  assert.equal(l.pieces[1]!.sink, 0);
  assert.throws(() => placeLayoutSchema.parse({ ...base, pieces: [{ ...base.pieces[0], sink: 5 }] }), /sink|4/);
});

// L (Red Dial 2026-10-29): a large place needs a water/cave/interior feature; a layout `waters` sheet in a built basin
// (and a layout pool) is that water for the size gate
test("layout waters: the still sheet stands at the host's marker and counts as the size gate's water feature", () => {
  const l = layoutOf([FIRE, { id: "slab", element: "slab", kind: "structure", prefab: "x/slab", at: [14, 0] }], { waters: [{ id: "basin", element: "slab", on: "slab", material: "terrain/x-water" }] });
  const p = layoutPlan(l, undefined, { markerOf: (prefab: string, id: string) => (prefab === "x/slab" && id === "basin-water" ? { position: [0, 0.5, 0], size: [6, 0, 4] } : null), materialExists: () => true });
  assert.deepEqual(p.faults.filter((f: string) => /water/.test(f)), []);
  const w = p.ops.find((o: any) => o.id === "test-place-core-basin-water");
  assert.ok(w, "the water entity is written");
  assert.deepEqual(w.entity.components.mesh.source.positions.slice(0, 3), [-3, 0, -2]);
  assert.ok(p.handoff.measurements.features.some((f: any) => f.kind === "water" && f.id === "water-basin"), JSON.stringify(p.handoff.measurements.features));
  const none = layoutPlan(l, undefined, { markerOf: () => null, materialExists: () => true });
  assert.ok(none.faults.some((f: string) => /no marker basin-water/.test(f)));
});

// L (Red Dial 2026-10-30): the built re-seat sinks a piece to the lowest ground under its WHOLE footprint, capped by footing
test("sinkToBase: lowest ground under the turned footprint, never deeper than the cap below the highest; lowers, or raises one buried past the cap", () => {
  const slope = (x: number) => 10 - 0.2 * x; // falls 0.2 m per m toward +x
  // a 2 x 2 m pillar standing at its centre's ground (10): its +x edge is at 9.8 -> sinks to 9.77 (cap 0.6 allows it)
  assert.equal(sinkToBase({ x: 0, y: 10, z: 0, yaw: 0 }, [1, 1], 0.6, (x) => slope(x)), 9.77);
  // a 10 m wall: lowest 8.97, but at most 0.6 m below the highest (11): 10.4
  assert.equal(sinkToBase({ x: 0, y: 11, z: 0, yaw: 0 }, [5, 1], 0.6, (x) => slope(x)), 10.4);
  // turned 90 deg the long side runs along z (level): its x edges are +-1 m -> 9.77
  assert.equal(sinkToBase({ x: 0, y: 11, z: 0, yaw: Math.PI / 2 }, [5, 1], 0.6, (x) => slope(x)), 9.77);
  assert.equal(sinkToBase({ x: 0, y: 9.7, z: 0, yaw: 0 }, [1, 1], 0.6, (x) => slope(x)), null, "within the cap: never raised");
  assert.equal(sinkToBase({ x: 0, y: 9, z: 0, yaw: 0 }, [1, 1], 0.6, (x) => slope(x)), 9.6, "buried past the cap (a path filled over it): up to the cap");
});

// L (Red Dial 2026-10-30): after the footpaths, a piece still showing daylight gets a level seat pad at its foot
test("seatPad: a pad when the base shows daylight, none when seated or past the cap", () => {
  const slope = (x: number) => 10 - 0.4 * x;
  const p = seatPad({ x: 0, y: 10, z: 0, yaw: 0 }, [1.25, 1.25], (x) => slope(x));
  assert.ok(p && Math.abs(p.gap - 0.5) < 1e-6 && p.y === 10 && p.radius > 1.25 * Math.SQRT2, JSON.stringify(p));
  assert.equal(seatPad({ x: 0, y: 9.5, z: 0, yaw: 0 }, [1.25, 1.25], (x) => slope(x)), null, "sunk to its low edge: nothing shows");
  assert.equal(seatPad({ x: 0, y: 10, z: 0, yaw: 0 }, [5, 1], (x) => slope(x)), null, `a 2 m fall is past the ${SEAT_PAD_MAX_M} m cap`);
  assert.equal(PATH_GRADE_BAND_M, 3.5);
});

test("seat pads: overlapping pieces (a spit over its pyre) share ONE pad at the lowest base; apart ones keep their own (dropped-hour)", () => {
  const out = mergeSeatPads([
    { id: "pyre", at: [0, 0], radius: 1.5, y: 10.0, gap: 0.13 },
    { id: "spit", at: [0.4, 0], radius: 1.2, y: 10.2, gap: 0.15 },
    { id: "post", at: [20, 0], radius: 1, y: 12, gap: 0.3 },
    { id: "next", at: [21.5, 0], radius: 1, y: 12.5, gap: 0.2 }, // its pad touches the post's: a neighbour, not one spot
  ]);
  assert.equal(out.length, 3);
  const m = out.find((p) => p.id === "pyre--spit")!;
  assert.ok(m && m.y === 10 && m.gap === 0.15 && m.radius >= 1.5 && Math.hypot(m.at[0] - 0.2, m.at[1]) < 0.01, JSON.stringify(m));
  assert.ok(out.some((p) => p.id === "post" && p.y === 12));
});

test("site plans take their scale from the culture: an ogre camp is dressed at giant scale (o-small2 2026-10-30)", () => {
  assert.equal(siteScale(["ogre", "giant"]), "giant");
  assert.equal(siteScale(["giant"]), "giant");
  assert.equal(siteScale(["rural"]), "human");
  assert.equal(siteScale(["bandit", "any"]), "human");
});

test("a layout piece's prefab overrides reach its placed instance (a camp fire lit at night only, o-small2 2026-10-30)", () => {
  const ov = [{ path: "glow/components/light/when", value: "night" }];
  const p = layoutPlan(layoutOf([{ ...FIRE, overrides: ov }, { id: "tent-n", element: "tents", kind: "structure", prefab: "camp-props/tent", at: [6, 1] }]));
  assert.deepEqual(p.ops.find((o: any) => o.id === "test-place-core-fire")!.entity.components.prefab.overrides, ov);
  assert.equal(p.ops.find((o: any) => o.id === "test-place-core-tent-n")!.entity.components.prefab.overrides, undefined, "no overrides: none written");
});

test("layout areas join the handoff's dressing areas in world coordinates; one repeating a pocket's is a refusal (o-small2 2026-10-30)", () => {
  const p = layoutPlan(layoutOf([FIRE], { areas: [{ id: "midden", role: "yard", at: [0, -20], radius: 7, note: "bones", reach: [3, -14] }] }));
  const m = p.handoff.siteDressing.areas.find((x: any) => x.id === "midden")!, w = toWorld(p.centre, p.front, [0, -20]);
  assert.ok(m && m.role === "yard" && m.radius === 7 && Math.hypot(m.centre[0] - w[0], m.centre[1] - w[1]) < 0.01, JSON.stringify(m));
  const r = toWorld(p.centre, p.front, [3, -14]);
  assert.ok(Math.hypot(m.reach[0] - r[0], m.reach[2] - r[1]) < 0.01, `reach ${m.reach}`);
  const bad = layoutPlan(layoutOf([FIRE], { areas: [{ id: "core", role: "yard", at: [0, -20], radius: 7 }] }));
  assert.ok(bad.faults.some((f: string) => /area core repeats/.test(f)), bad.faults.join(" | "));
});

