import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BESIDE_COST, REUSE_COST, cellsAlong, graphDistance, loopWanted, measureNetwork, mergeIntoNetwork, networkCost, networkFaults,
  type NetPlace, type NetRoad,
} from "../tools/_road-network.mts";
import { routeBetween, type RouteGrid } from "../tools/worldgen-routing.mts";

// Derek 2026-10-31: "a lot of criss-crossing and overlapping". On redstrand two paths left town-1's one gate and ran
// 390 m side by side, crossing 8 times; place tracks and hand-routed roads ran beside the paths. The network measure
// (`worldgen road-net`, the `roads` status row) fails each of those, and the routers fold every new line into the network.

const town: NetPlace = { id: "town", x: 0, z: 0, reach: 30 };
const far: NetPlace = { id: "far", x: 400, z: 0, reach: 30 };

/** a wavy line from [0,0] to [400,0], amplitude a, phase p */
const wave = (a: number, p: number): number[][] => Array.from({ length: 41 }, (_, i) => [i * 10, a * Math.sin(i * 0.9 + p)]);

test("a braid of two routes between the same places fails: crossings, side by side, redundant", () => {
  const roads: NetRoad[] = [{ id: "path-a", points: wave(6, 0) }, { id: "path-b", points: wave(6, Math.PI) }];
  const rep = measureNetwork(roads, [town, far]);
  assert.ok(rep.crossings.length >= 3, `crossings ${rep.crossings.length}`);
  assert.ok(rep.overlaps.length >= 1 && rep.overlaps[0]!.length > 300, JSON.stringify(rep.overlaps));
  assert.ok(rep.redundant.length >= 1);
  assert.ok(networkFaults(rep));
});

test("a square crossroads with level treads passes; a shallow or stepped crossing fails", () => {
  const level: NetRoad[] = [
    { id: "road-ns", points: [[0, -200], [0, 200]], surfaceY: [10, 10] },
    { id: "road-ew", points: [[-200, 0], [200, 0]], surfaceY: [10.2, 10.2] },
  ];
  const ends: NetPlace[] = [[0, -200], [0, 200], [-200, 0], [200, 0]].map(([x, z], i) => ({ id: `p${i}`, x: x!, z: z!, reach: 20 }));
  const ok = measureNetwork(level, ends);
  assert.equal(ok.crossings.length, 0);
  assert.equal(ok.crossroads.length, 1);
  assert.equal(networkFaults(ok), null);
  const stepped = measureNetwork([level[0]!, { ...level[1]!, surfaceY: [12, 12] }], ends);
  assert.equal(stepped.crossings.length, 1, "treads 2 m apart are a bridge or a step, not a crossroads");
  const shallow = measureNetwork([level[0]!, { id: "road-x", points: [[-40, -200], [40, 200]] }], ends);
  assert.equal(shallow.crossings.length, 1, "11 deg is two roads sliding over each other");
});

test("a T-junction is a junction; the pieces of one route across a gap are one road; a stub is flagged", () => {
  const roads: NetRoad[] = [
    { id: "path-main", points: [[0, 0], [400, 0]] },
    { id: "trail-up", points: [[200, 5], [200, 200]] },
    // one route split at a bridge: 30 m gap, not two dead ends
    { id: "trail-far", points: [[400, 0], [400, 150]] },
    { id: "trail-far.s2", points: [[400, 180], [400, 300]] },
    { id: "road-stub", points: [[100, 0], [100, 25]] },
  ];
  const rep = measureNetwork(roads, [town, far, { id: "top", x: 200, z: 200, reach: 20 }, { id: "far-top", x: 400, z: 300, reach: 20 }]);
  assert.equal(rep.crossings.length, 0);
  assert.ok(rep.nodes.some((n) => n.degree === 3 && Math.abs(n.at[0] - 200) < 15), "the trail meets the path at a junction");
  assert.deepEqual(rep.deadEnds.filter((d) => d.road.startsWith("trail-far")), []);
  assert.deepEqual(rep.deadEnds.map((d) => d.kind), ["stub"]);
  assert.equal(rep.components, 1);
});

test("mergeIntoNetwork drops the run beside a road and ends the new piece on it", () => {
  const network: NetRoad[] = [{ id: "path-main", points: [[0, 0], [400, 0]], surfaceY: [5, 5] }];
  // 150 m beside the road (8 m off), then away north
  const line: [number, number][] = [];
  for (let x = 0; x <= 150; x += 10) line.push([x, 8]);
  for (let z = 20; z <= 200; z += 10) line.push([150, z]);
  const m = mergeIntoNetwork(line, network);
  assert.equal(m.pieces.length, 1);
  const p = m.pieces[0]!;
  assert.ok(p.start && p.start.road === "path-main" && Math.abs(p.start.at[1]) < 1e-6, "starts ON the road");
  assert.equal(p.start!.y, 5, "pinned to the road's tread");
  assert.ok(line[p.from]![0] >= 140, `piece starts where it leaves the road (${line[p.from]})`);
  assert.ok(m.absorbed >= 130);
  // a line the network already carries cuts nothing
  assert.equal(mergeIntoNetwork([[10, 3], [100, 3], [200, 2], [300, 3]], network).pieces.length, 0);
  // a short departure at a junction is kept whole; a free end 20 m off a road is snapped onto it
  const t = mergeIntoNetwork([[200, 0], [200, 100], [300, 100], [300, 20]], network);
  assert.equal(t.pieces.length, 1);
  assert.equal(t.pieces[0]!.from, 0);
  assert.ok(t.pieces[0]!.end && Math.abs(t.pieces[0]!.end.at[1]) < 1e-6, "the free end 20 m from the road meets it");
  // i-moon 2026-11-02: both free ends near one road END snap to the same spot: only the nearer joins (no loop back)
  const dead: NetRoad[] = [{ id: "road-end", points: [[0, -100], [0, 0]], surfaceY: [5, 5] }];
  const loop = mergeIntoNetwork([[10, 15], [40, 40], [-10, 40], [-12, 15]], dead);
  assert.equal(loop.pieces.length, 1);
  assert.ok(loop.pieces[0]!.start && !loop.pieces[0]!.end, JSON.stringify(loop.pieces[0]));
});

test("network pricing: a second link follows the first instead of running beside it", () => {
  const n = 60, step = 10;
  const flat: RouteGrid = { n, step, height: new Float32Array(n * n), cost: new Float32Array(n * n).fill(1), river: new Float32Array(n * n) };
  const at = (x: number, z: number) => x + z * n;
  const opts = { maxGrade: 0.2, gradeWeight: 10, riverToll: 100 };
  const first = routeBetween(flat, at(5, 30), at(55, 30), opts)!;
  const toLine = (r: number[]) => r.map((c) => [(c % n) * step, ((c / n) | 0) * step] as [number, number]);
  const onRoad = cellsAlong(toLine(first), (x, z) => at(Math.round(x / step), Math.round(z / step)), step);
  const priced = { ...flat, cost: networkCost(flat.cost, n, onRoad) };
  assert.ok(Math.abs(priced.cost[at(30, 30)]! - REUSE_COST) < 1e-6);
  assert.ok(Math.abs(priced.cost[at(30, 31)]! - BESIDE_COST) < 1e-6);
  // the second link from the same start to a goal just past the far end, 3 cells off the line
  const second = routeBetween(priced, at(5, 30), at(55, 33), opts)!;
  const net: NetRoad[] = [{ id: "path-first", points: toLine(first) }];
  const merged = mergeIntoNetwork(toLine(second), net);
  assert.ok(merged.absorbed > 300, `the shared way is the first road's (absorbed ${merged.absorbed} m)`);
  const built: NetRoad[] = [...net, ...merged.pieces.map((p, k) => ({ id: `path-second${k ? `.j${k + 1}` : ""}`, points: [...(p.start ? [p.start.at] : []), ...toLine(second).slice(p.from, p.to + 1)] }))];
  const rep = measureNetwork(built, [{ id: "a", x: 50, z: 300, reach: 20 }, { id: "b", x: 550, z: 300, reach: 20 }, { id: "c", x: 550, z: 330, reach: 20 }]);
  assert.equal(rep.overlaps.length, 0);
  assert.equal(rep.crossings.length, 0);
  // unpriced, the second link is a separate track for most of the way
  const bare = routeBetween(flat, at(5, 30), at(55, 33), opts)!;
  assert.ok(measureNetwork([...net, { id: "path-bare", points: toLine(bare) }], []).overlaps.length > 0);
});

test("loops are cut only where the network's way round is long and the link saves enough", () => {
  assert.equal(loopWanted(300, 200), false); // 1.5x round: no loop
  assert.equal(loopWanted(600, 200), true);
  assert.equal(loopWanted(600, 200, 500), false); // the link itself winds 500 m: saves under 1.3x
  assert.equal(graphDistance([[0, 1, 100], [1, 2, 50], [0, 2, 400]], 0, 2), 150);
  assert.equal(graphDistance([[0, 1, 100]], 0, 2), Infinity);
});

test("foldRoadDoc cuts the doubled stretch out of a graded doc and keeps the rest exactly as solved", async () => {
  const { foldRoadDoc } = await import("../tools/_road-network.mts");
  const main: NetRoad = { id: "path-main", points: [[0, 0], [400, 0]], surfaceY: [5, 5] };
  // a sparse graded doc (vertices 50 m apart): 150 m beside the main road, then away north
  const doc = { id: "path-second", points: [[0, 6], [50, 6], [100, 6], [150, 6], [150, 100], [150, 200]], surfaceY: [5, 5.5, 6, 6.5, 9, 12], leftY: [1, 2, 3, 4, 5, 6], rightY: [1, 2, 3, 4, 5, 6], width: 3.4 };
  const f = foldRoadDoc(doc, [main], { snap: 0 });
  assert.equal(f.changed, true);
  assert.equal(f.pieces.length, 1);
  const p = f.pieces[0]!;
  assert.equal(p.id, "path-second");
  assert.deepEqual(p.points.slice(-2), [[150, 100], [150, 200]], "the kept vertices are the doc's own");
  assert.deepEqual(p.surfaceY!.slice(-2), [9, 12], "and so is their solved tread");
  assert.equal(p.points.length, p.surfaceY!.length);
  assert.equal(p.points.length, p.leftY!.length);
  assert.ok(Math.abs(p.points[0]![1]!) < 1e-6 && p.surfaceY![0] === 5, "it starts ON the main road, level with its tread");
  // a road nothing doubles is returned untouched
  const far = { ...doc, id: "path-far", points: doc.points.map((q) => [q[0]!, q[1]! + 500]) };
  const g = foldRoadDoc(far, [main], { snap: 0 });
  assert.equal(g.changed, false);
  assert.equal(g.pieces[0], far);
});

test("the network grows from the hub: a place joins the trunk toward town, never a stray fragment", async () => {
  const { nextToJoin, connectedRoads } = await import("../tools/_road-network.mts");
  // the hub at [0,0]; a trunk east to [600,0]; a spur from [600,0] north to [600,-400]; a stray track out at [900,300]
  const trunk: NetRoad = { id: "path-trunk", points: [[0, 0], [600, 0]], width: 3.4 };
  const spur: NetRoad = { id: "path-spur", points: [[600, 0], [600, -400]], width: 3.4 };
  const stray: NetRoad = { id: "road-pb-x-approach", points: [[880, 300], [900, 300]], width: 4 };
  const live = connectedRoads([trunk, spur, stray], [{ x: 0, z: 0, reach: 40 }]);
  assert.deepEqual(live.map((r) => r.id).sort(), ["path-spur", "path-trunk"]);
  // a place at [760,-300]: nearest road point is on the spur ([600,-300], 160 m); weighted by the way back to the hub
  // (spur point 900 m round vs trunk end 600 m) it still takes the spur (160 + 0.4*900 = 520 < 335 + 0.4*600 = 575)
  const hub = (p: readonly [number, number]) => Math.abs(p[0]) + Math.abs(p[1]);
  const a = nextToJoin([{ id: "a", x: 760, z: -300 }], [{ id: "hub", x: 0, z: 0 }], live, hub)!;
  assert.equal(a.road?.id, "path-spur");
  // beside the spur near the junction: the hub weight pulls the join toward the trunk (plain Prim: straight across)
  const b = nextToJoin([{ id: "b", x: 640, z: -60 }], [{ id: "hub", x: 0, z: 0 }], live, hub)!;
  const plain = nextToJoin([{ id: "b", x: 640, z: -60 }], [{ id: "hub", x: 0, z: 0 }], live)!;
  assert.ok(Math.abs(plain.at[1] + 60) <= 4, `plain Prim joins straight across (${plain.at.map(Math.round)})`);
  assert.ok(b.at[1] > plain.at[1] + 10, `joins nearer the trunk (${b.at.map(Math.round)})`);
});

// 2026-10-31 redstrand group C: folding road-moon and the s3 path away uncovered the edge of need-weeping-sun-face and
// of road-weeping-sun (5 new lips faults), and the splice eased the tread under banks left where they were.
test("a fold splice moves the banks with the tread; a pinned point keeps its tread", async () => {
  const { foldRoadDoc, nearestOn } = await import("../tools/_road-network.mts");
  const main: NetRoad = { id: "path-main", points: [[0, 0], [400, 0]], surfaceY: [5, 5] };
  const doc = { id: "path-second", points: [[0, 6], [50, 6], [100, 6], [150, 6], [150, 100], [150, 200]], surfaceY: [8, 8, 8, 8, 9, 12], leftY: [10, 10, 10, 10, 11, 14], rightY: [6, 6, 6, 6, 7, 10], width: 3.4 };
  const p = foldRoadDoc(doc, [main], { snap: 0 }).pieces[0]!;
  assert.equal(p.surfaceY![0], 5, "the junction is level with the main tread");
  assert.equal(p.leftY![0]! - p.surfaceY![0]!, 2, "its left bank keeps its 2 m over the tread (was a 3 m step)");
  assert.equal(p.rightY![0]! - p.surfaceY![0]!, -2);
  for (let i = 0; i < p.points.length - 2; i++) assert.ok(Math.abs(p.leftY![i]! - p.surfaceY![i]! - 2) < 0.02, `bank offset kept through the eased stretch (${i})`);
  // pin a point in the doubled stretch: the tread there stays
  const pinned = foldRoadDoc(doc, [main], { snap: 0, keep: (q) => Math.hypot(q[0] - 75, q[1] - 6) <= 12 });
  assert.ok(pinned.pieces.some((r) => nearestOn(r.points, [75, 6]).d < 1), "a piece still runs over the pinned point");
  assert.ok(!foldRoadDoc(doc, [main], { snap: 0 }).pieces.some((r) => nearestOn(r.points, [75, 6]).d < 1), "unpinned, the stretch is cut");
});

test("foldRoadsChecked keeps the tread where a fold would uncover a lip, and refuses a fold it cannot clean", async () => {
  const { foldRoadsChecked } = await import("../tools/worldgen-road-net.mts");
  const { nearestOn } = await import("../tools/_road-network.mts");
  const { defaultWorldRecipe, worldRecipeSchema } = await import("@hitreg/core");
  const recipe = worldRecipeSchema.parse({ ...defaultWorldRecipe(), name: "fx", features: { roads: [
    { id: "path-main", points: [[0, 0], [400, 0]] },
    { id: "path-second", points: [[0, 6], [50, 6], [100, 6], [150, 6], [150, 100], [150, 200]] },
  ] } });
  // a lip at [76,10] that path-second's tread covers: uncovered when no piece of it runs within 8 m
  const lips = (r: typeof recipe) => r.features.roads.some((d) => d.id.startsWith("path-second") && nearestOn(d.points, [76, 10]).d <= 8) ? [] : [{ x: 76, z: 10, owner: "need-x", kind: "alias", size: 0.9 }];
  const ok = foldRoadsChecked(recipe, ["path-second"], [], lips);
  assert.ok(ok.edits.length > 0, "the fold still happens");
  assert.deepEqual(ok.kept, [[76, 10]]);
  assert.equal(ok.refused.length, 0);
  assert.ok(ok.roads.some((d) => d.id.startsWith("path-second") && nearestOn(d.points, [76, 10]).d <= 8), "the tread over the lip is kept");
  // a fault no kept tread can cover: refused, nothing written
  const bad = foldRoadsChecked(recipe, ["path-second"], [], (r) => r === recipe ? [] : [{ x: 1000, z: 1000, owner: "x", kind: "lip", size: 1 }]);
  assert.equal(bad.edits.length, 0);
  assert.deepEqual(bad.refused, ["path-second"]);
  assert.match(bad.log.join("\n"), /REFUSED/);
});

test("a fold junction takes the HOST's banks: its tread where it leaves square, the host's banks where it runs along", async () => {
  const { junctionBanks, foldRoadDoc } = await import("../tools/_road-network.mts");
  const host: NetRoad = { id: "path-main", points: [[0, 0], [400, 0]], surfaceY: [5, 5], leftY: [7, 7], rightY: [3, 3] };
  assert.deepEqual(junctionBanks(host, [150, 0], [0, 1], 5), { leftY: 5, rightY: 5 }, "square: the band edges lie on the host tread");
  assert.deepEqual(junctionBanks(host, [150, 0], [1, 0], 5), { leftY: 7, rightY: 3 }, "along: the host's banks");
  assert.deepEqual(junctionBanks(host, [150, 0], [-1, 0], 5), { leftY: 3, rightY: 7 }, "along, the other way: sides swap");
  // the s3 fault: the folded piece's own banks were 4 m over the junction tread; now the host's are used
  const doc = { id: "path-second", points: [[0, 6], [50, 6], [100, 6], [150, 6], [150, 100], [150, 200]], surfaceY: [8, 8, 8, 8, 9, 12], leftY: [12, 12, 12, 12, 13, 16], rightY: [4, 4, 4, 4, 5, 8], width: 3.4 };
  const p = foldRoadDoc(doc, [host], { snap: 0 }).pieces[0]!;
  assert.equal(p.surfaceY![0], 5);
  assert.ok(Math.abs(p.leftY![0]! - 5) < 0.6 && Math.abs(p.rightY![0]! - 5) < 0.6, `junction banks near the host tread (${p.leftY![0]}, ${p.rightY![0]})`);
});

test("foldRoads keeps a replaced road at its place in the array, and cuts a hairpin's two tails back together", async () => {
  const { foldRoads } = await import("../tools/worldgen-road-net.mts");
  const { defaultWorldRecipe, worldRecipeSchema, applyRecipeEdits } = await import("@hitreg/core");
  const mk = (roads: unknown[]) => worldRecipeSchema.parse({ ...defaultWorldRecipe(), name: "fx", features: { roads } });
  // order: overlapping roads are drawn in array order, so the folded road's piece goes back where it was
  const r1 = mk([
    { id: "path-main", points: [[0, 0], [400, 0]] },
    { id: "path-second", points: [[0, 6], [50, 6], [100, 6], [150, 6], [150, 100], [150, 200]] },
    { id: "path-last", points: [[600, 0], [700, 0]] },
  ]);
  const f1 = foldRoads(r1, ["path-second"]);
  assert.deepEqual(applyRecipeEdits(r1, f1.edits).recipe.features.roads.map((r) => r.id), ["path-main", "path-second", "path-last"]);
  // a hairpin: path-out runs east to [300,0]; road-back starts there and runs straight back west to [100,1], then north.
  // Folding path-out alone would leave road-back's 200 m tail as a dead end; both tails go back to where they part.
  const r2 = mk([
    { id: "path-out", points: [[-200, 200], [0, 0], [100, 0], [200, 0], [300, 0]] },
    { id: "road-back", points: [[300, 1], [200, 1], [100, 1], [100, 100], [100, 300]] },
  ]);
  const f2 = foldRoads(r2, ["path-out"]);
  assert.match(f2.log.join("\n"), /road-back: a hairpin with path-out/);
  const back = f2.roads.find((r) => r.id === "road-back")!;
  assert.ok(back.points[0]![0]! < 160, `road-back now starts where the two part (${back.points[0]})`);
  const out = f2.roads.find((r) => r.id === "path-out")!;
  assert.ok(out.points[out.points.length - 1]![0]! < 160, `path-out ends there too (${out.points[out.points.length - 1]})`);
});

test("a documented network exception removes that crossing / run from the roads row and nothing else", async () => {
  const { exceptNetwork } = await import("../tools/_road-network.mts");
  const rep = {
    roads: 3, metres: 0, nodes: [], edges: [], components: 1, crossroads: [], redundant: [], deadEnds: [],
    crossings: [{ a: "road-weeping-sun", b: "road-moon", at: [0, 0] as [number, number], angle: 34, dy: 0.7 }, { a: "path-x", b: "path-y", at: [9, 9] as [number, number], angle: 5, dy: 0 }],
    overlaps: [{ a: "road-moon.j2", b: "road-weeping-sun", from: [0, 0] as [number, number], to: [1, 1] as [number, number], length: 110 }],
  };
  const out = exceptNetwork(rep as never, [
    { kind: "crossing", roads: ["road-moon", "road-weeping-sun"], ruling: "2026-10-31 c: stacked" },
    { kind: "overlap", roads: ["road-weeping-sun", "road-moon"], ruling: "2026-10-31 c: stacked" },
  ]);
  assert.deepEqual(out.rep.crossings.map((c) => c.a), ["path-x"], "either order, by base id; other crossings stay");
  assert.equal(out.rep.overlaps.length, 0, "a piece (.j2) of an excepted route is excepted");
  assert.equal(out.excepted.length, 2);
});
