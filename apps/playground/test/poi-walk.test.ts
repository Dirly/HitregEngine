import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declaredNetwork, goalSurface, declaredRoutes, derivedRoutes, descendants, networkPath, dropHoldFault, entityTargets, fileTargets, highestWalkable, judgeLeg, landmarkToWorld, nearestRoutePoint, oneWayFaults,
  fellJustNow, portalSentAfterReach, portalWalkInPoint, reverseRoute, shadowFaults, sortOps, uncoveredPoints, worstDrop, type EntityView, type Sample,
} from "../tools/_poi-walk-lib.mts";

const near = (a: readonly (number | null)[], b: readonly number[], eps = 1e-6): void => {
  a.forEach((v, i) => assert.ok(Math.abs((v ?? NaN) - b[i]!) < eps, `${JSON.stringify(a)} != ${JSON.stringify(b)}`));
};
/** A straight walk at 6 m/s along +x at height y(t), 60 Hz. */
const walk = (seconds: number, y: (t: number) => number, x0 = 0): Sample[] =>
  Array.from({ length: Math.round(seconds * 60) + 1 }, (_, i) => { const t = i / 60; return { x: x0 + 6 * t, y: y(t), z: 0, t }; });

// ---- routes
test("declaredRoutes: navigation.routes and a bare array; [x,z] points have no height; < 2 points skipped", () => {
  const a = declaredRoutes({ navigation: { routes: [{ id: "bank", points: [[0, 5, 0], [10, 6, 0]], drops: [0] }, { id: "short", points: [[1, 1, 1]] }] } });
  assert.equal(a.length, 1);
  assert.deepEqual(a[0]!.points, [[0, 5, 0], [10, 6, 0]]);
  assert.deepEqual(a[0]!.drops, [0]);
  assert.equal(a[0]!.driver, "stick");
  const b = declaredRoutes({ navigation: [{ points: [[0, 0], [5, 5]], jump: false }] });
  assert.deepEqual(b[0]!.points, [[0, null, 0], [5, null, 5]]);
  assert.equal(b[0]!.jump, false);
  assert.equal(declaredRoutes({ navigation: [] }).length, 0);
});
test("derivedRoutes: every landmark's targets in order (planner); a removed `path` op derives nothing", () => {
  const r = derivedRoutes([
    { id: "levee", op: "path", points: [[0, 0], [10, 0], [20, 5]] },
    { id: "ramp", op: "landmark", at: [100, 200], y: 10, yaw: 0, targets: [{ name: "foot", at: [0, 0, 0] }, { name: "head", at: [0, 20, -50] }] },
    { id: "door", op: "landmark", at: [0, 0], y: 0, targets: [{ name: "only", at: [0, 0, 0] }] },
  ]);
  assert.deepEqual(r.map((x) => [x.id, x.driver]), [["landmark:ramp", "planner"]]);
  assert.deepEqual(r[0]!.points, [[100, 10, 200], [100, 30, 150]]);
});
test("reverseRoute: points reversed, drop legs renumbered", () => {
  const r = reverseRoute({ id: "x", source: "handoff", points: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]], drops: [0], jump: true, driver: "stick" });
  assert.deepEqual(r.points.map((p) => p[0]), [3, 2, 1, 0]);
  assert.deepEqual(r.drops, [2]);
});
test("nearestRoutePoint: along the densified line, null past the limit", () => {
  const routes = declaredRoutes({ navigation: [{ points: [[0, 0, 0], [100, 0, 0]] }] });
  const p = nearestRoutePoint(routes, [50, null, 10])!;
  assert.ok(Math.abs(p[0] - 50) <= 2);
  assert.equal(nearestRoutePoint(routes, [50, null, 500], 100), null);
});

// ---- targets
test("landmarkToWorld: the bake's yaw convention (yaw 90: local +x -> world -z, local +z -> world +x)", () => {
  near(landmarkToWorld({ at: [10, 20], y: 5, yaw: 90 }, [1, 2, 0]), [10, 7, 19]);
  near(landmarkToWorld({ at: [10, 20], y: 5, yaw: 90 }, [0, 0, 1]), [11, 5, 20]);
});
test("fileTargets: landmark targets, openings walked through along their axis, areas, circular clearings only", () => {
  const job = {
    handoff: { siteDressing: { areas: [{ id: "yard", centre: [5, 6, 7] }, { id: "deck", centre: [1, 2], floorY: 9 }] }, populateClearings: [{ id: "lip", center: [3, 4, 5], r: 8 }] },
    worldOps: [{ id: "door", op: "landmark", at: [0, 0], y: 10, yaw: 0, targets: [{ name: "forecourt", at: [0, 0.2, 8] }], openings: [{ name: "wicket", at: [0, 0, -4], depth: 2 }] }],
    clearings: [{ id: "camp", center: [50, 60], radius: 12 }, { id: "poly", polygon: [[0, 0], [1, 0], [1, 1]] }],
  };
  const t = fileTargets(job);
  const byId = new Map(t.map((x) => [x.id, x]));
  near(byId.get("door/forecourt")!.at, [0, 10.2, 8]);
  const w = byId.get("door/opening wicket")!;
  assert.equal(w.kind, "opening");
  near(w.at, [0, 10, -4]);
  near(w.from!, [0, 10, 0]); // 1 + 3 m out (+z)
  near(w.through!, [0, 10, -7]); // 1 + 2 m in
  near(byId.get("area:yard")!.at, [5, 6, 7]);
  near(byId.get("area:deck")!.at, [1, 9, 2]);
  assert.deepEqual(byId.get("clearing:camp")!.at, [50, null, 60]);
  near(byId.get("clearing:lip")!.at, [3, 4, 5]);
  assert.equal(byId.has("clearing:poly"), false);
});
test("entityTargets: a WFC doorway is walked from 4 m out on the door axis to the cell centre", () => {
  const s = Math.SQRT1_2;
  const views: EntityView[] = [
    { id: "hut:cell-1", parent: "hut", tags: ["wfc-cell"], position: [100, 7, 50], quaternion: [0, 0, 0, 1], components: {} },
    // part at the cell origin, turned 90 deg about y; its box centre is 2 m along local +z -> world +x
    { id: "hut:cell-1:door", parent: "hut:cell-1", tags: ["wfc-part:doorway-reed"], position: [100, 7, 50], quaternion: [0, s, 0, s], components: { collider: { shape: "box", size: [4, 2.75, 0.3], offset: [0, 1.4, 2] } } },
    { id: "hut:cell-1:wall", parent: "hut:cell-1", tags: ["wfc-part:wall-hide"], position: [100, 7, 50], quaternion: [0, 0, 0, 1], components: {} },
  ];
  const t = entityTargets(views);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.kind, "door");
  near(t[0]!.at, [102, 7, 50]);
  near(t[0]!.from!, [106, 7, 50]);
  near(t[0]!.through!, [100, 7, 50]);
});
test("entityTargets: a mesh-collider doorway faces its slot in the cell's frame; its collider child is not a second door", () => {
  const yaw = (37.4 * Math.PI) / 180;
  const q: [number, number, number, number] = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const t = entityTargets([
    { id: "rook:cell-1-0-2", parent: "rook", tags: ["wfc-cell"], position: [3461.1, 7.05, 559.5], quaternion: q, components: {} },
    { id: "rook:cell-1-0-2:doorway-nz", parent: "rook:cell-1-0-2", tags: ["wfc-part:doorway-reed"], position: [3461.1, 7.05, 559.5], quaternion: [0, 0.947, 0, -0.32], components: {} },
    { id: "rook:cell-1-0-2:doorway-nz-collider", parent: "rook:cell-1-0-2:doorway-nz", tags: ["wfc-part:doorway-reed"], position: [3461.1, 7.05, 559.5], quaternion: [0, 0.947, 0, -0.32], components: { collider: { shape: "trimesh", offset: [0, 0, 0] } } },
  ]);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.id, "door:rook:cell-1-0-2/nz");
  near(t[0]!.at, [3460.01, 7.05, 558.07], 0.02); // the QA-B probe's door point for this hut
});
test("entityTargets: portals (interact or trigger) and quest objects within their radius", () => {
  const t = entityTargets([
    { id: "p", parent: null, tags: ["portal"], position: [1, 2, 3], quaternion: [0, 0, 0, 1], components: { script: { name: "portal", params: { scene: "x" } } } },
    { id: "v", parent: null, tags: [], position: [1, 2, 3], quaternion: [0, 0, 0, 1], components: { script: { name: "portal", params: { mode: "trigger" } } } },
    { id: "cart", parent: null, tags: ["interactable", "quest-object"], position: [9, 1, 9], quaternion: [0, 0, 0, 1], components: { script: { name: "npc", params: { radius: 4.5 } } } },
  ]);
  assert.deepEqual(t.map((x) => [x.id, x.kind]), [["portal:p", "portal"], ["portal:v", "portal"], ["quest:cart", "quest"]]);
  assert.equal(t[0]!.portal!.trigger, false);
  assert.equal(t[1]!.portal!.trigger, true);
  assert.equal(t[1]!.portal!.sealed, undefined, "a portal with no scene and no refusal is no sealed door");
  const sealed = entityTargets([{ id: "k", parent: null, tags: [], position: [0, 0, 0], quaternion: [0, 0, 0, 1], components: { script: { name: "portal", params: { mode: "trigger", scene: "", refusal: "Barred." } } } }]);
  assert.equal(sealed[0]!.portal!.sealed, "Barred.", "a sealed keep door (no scene, a refusal) is judged by its refusal (ravenstacks 2026-10-21)");
  // a fitted box behind its anchor (offset z -1.5 under a 0.88 scale, turned 180 deg): reach the anchor, walk in to the box centre
  const fitted = entityTargets([{ id: "f", parent: null, tags: [], position: [10, 5, 10], quaternion: [0, 1, 0, 0], scale: [0.88, 0.88, 0.88], components: { script: { name: "portal", params: { mode: "trigger", scene: "x", halfExtents: [2.85, 2.77, 0.85], offset: [0, 0.87, -1.5] } } } }]);
  assert.deepEqual(fitted[0]!.at, [10, 5, 10]);
  assert.deepEqual(fitted[0]!.portal!.box!.map((v) => (v === null ? null : Math.round(v * 100) / 100)), [10, null, 11.32], "Weeping Stair 2026-11-01: the box stood 0.65-2.35 m behind the anchor");
  assert.equal(Math.round(fitted[0]!.portal!.half! * 1000) / 1000, 0.748);
  assert.equal(t[1]!.portal!.box, undefined, "a box on its anchor keeps the plane walk-in");
  assert.equal(t[2]!.tolXZ, 3);
  assert.deepEqual(t[2]!.at, [9, null, 9]);
});
test("descendants + sortOps: what a job owns", () => {
  const m = new Map<string, { parent?: string | null }>([["poi", { parent: null }], ["a", { parent: "poi" }], ["a:b", { parent: "a" }], ["other", { parent: null }]]);
  assert.deepEqual([...descendants(m, ["poi", "missing"])].sort(), ["a", "a:b", "poi"]);
  const job = { sceneOps: [], worldOps: [], clearings: [] } as Parameters<typeof sortOps>[1];
  sortOps([{ op: "add-entity", id: "x" }, { op: "path", id: "p" }, { id: "c", center: [0, 0] }, 7], job);
  assert.deepEqual([job.sceneOps.length, job.worldOps.length, job.clearings.length], [1, 1, 1]);
});

// ---- judging
test("worstDrop: the biggest fall inside a 0.5 s window", () => {
  const s = walk(3, (t) => (t < 1 ? 10 : t < 1.3 ? 10 - (t - 1) * 20 : 4));
  const w = worstDrop(s);
  assert.ok(Math.abs(w.drop - 6) < 0.05, `drop ${w.drop}`);
  assert.equal(worstDrop(walk(10, (t) => 10 - t)).drop <= 0.51, true); // a steady 1 m/s descent is a ramp, not a fall
});
test("worstDrop: a stair run down at speed (feet on the treads) is no fall; the same drop airborne is", () => {
  // 4.2 m/s down 0.29 m risers: 2.1 m in 0.5 s, the feet never more than a riser over the tread under them
  const stair = walk(3, (t) => 20 - 4.2 * t).map((s) => ({ ...s, air: (s.t * 4.2) % 0.29 }));
  assert.equal(worstDrop(stair).drop, 0);
  const off = walk(3, (t) => 20 - 4.2 * t).map((s) => ({ ...s, air: s.t > 1 ? 3 : 0 }));
  assert.ok(worstDrop(off).drop > 2);
});
test("judgeLeg: ok on a clean arrival", () => {
  const r = judgeLeg("leg", walk(2, () => 5), [12, 5, 0]);
  assert.equal(r.ok, true);
});
test("judgeLeg: FALL through a missing collider; allowed on a declared drop leg", () => {
  const s = walk(2, (t) => (t < 1 ? 30 : 8));
  const r = judgeLeg("ramp", s, [12, 8, 0]);
  assert.deepEqual(r.faults.map((f) => f.kind), ["FALL"]);
  assert.equal(judgeLeg("ramp", s, [12, 8, 0], { drop: true }).ok, true);
});
test("judgeLeg: STUCK and MISS by distance at a doorway slab", () => {
  const s = walk(1, () => 7);
  const r = judgeLeg("door", s, [10, 7, 0], { stuckAt: [6, 7, 0] });
  assert.deepEqual(r.faults.map((f) => f.kind), ["STUCK", "MISS"]);
  assert.equal(r.dXZ, 4);
});
test("judgeLeg: MISS by height (arrived under the deck) unless the goal is wading water", () => {
  const s = walk(2, () => 5.5);
  const r = judgeLeg("deck", s, [12, 7.1, 0]);
  assert.deepEqual(r.faults.map((f) => f.kind), ["MISS"]);
  assert.match(r.faults[0]!.detail!, /below/);
  assert.equal(judgeLeg("bog", s, [12, 7.1, 0], { wet: true }).ok, true);
  assert.equal(judgeLeg("bog", s, [16, 7.1, 0], { wet: true, wadeXZ: 6 }).ok, true);
  assert.equal(judgeLeg("no-height", s, [12, null, 0]).ok, true);
});
test("oneWayFaults: a riser you can drop down but not climb", () => {
  const f = oneWayFaults("ramp", [{ ok: true, from: [0, 0, 0], to: [1, 2, 3] }, { ok: true, from: [1, 2, 3], to: [4, 5, 6] }], [{ ok: false }, { ok: true }]);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.kind, "ONE-WAY");
  assert.match(f[0]!.detail!, /fails coming back/);
});

// ---- streaming, shadowing
test("uncoveredPoints: a collider carried by its origin cell only is missing at its far end", () => {
  const ring = (x: number, z: number): string[] => { const cx = Math.round(x / 48), cz = Math.round(z / 48); const out: string[] = []; for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (Math.hypot(dx, dz) <= 2) out.push(`${cx + dx}_${cz + dz}`); return out; };
  const foot: [number, number, number][] = [[10, 0, 10], [60, 0, 10], [200, 0, 10]];
  assert.deepEqual(uncoveredPoints(foot, new Set(["0_0"]), ring).map((p) => p[0]), [200]);
  assert.deepEqual(uncoveredPoints(foot, new Set(["0_0", "4_0"]), ring), []); // per-cell carriers: covered
});
test("shadowFaults: the same id with other bytes in another project", () => {
  const files: Record<string, string> = {
    "P/skel/assets/prefabs/landmarks/a.json": "1", "P/lab/assets/prefabs/landmarks/a.json": "2",
    "P/skel/assets/models/m.glb": "x", "P/kit/assets/models/m.glb": "x",
  };
  const fp = (f: string): string | null => files[f.replace(/\\/g, "/")] ?? null;
  const f = shadowFaults([{ kind: "prefabs", id: "landmarks/a.json" }, { kind: "models", id: "m.glb" }], ["P/skel", "P/kit"], ["P/kit", "P/lab", "P/skel"], fp);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.kind, "SHADOW");
  assert.match(f[0]!.detail!, /served from skel.*lab/);
});

test("shadowFaults: a job's pending delivery (job folder bytes = served lab bytes) is no shadow of its home project; a third project still is", () => {
  const files: Record<string, string> = {
    "P/lab/assets/models/door.glb": "new", "P/skel/assets/models/door.glb": "old", "P/skel/job/assets/models/door.glb": "new",
    "P/lab/assets/models/rock.glb": "new", "P/skel/assets/models/rock.glb": "old", "P/other/assets/models/rock.glb": "older", "P/skel/job/assets/models/rock.glb": "new",
    "P/lab/assets/models/tree.glb": "lab", "P/skel/assets/models/tree.glb": "live", // not the job's: still a shadow
  };
  const fp = (f: string): string | null => files[f.replace(/\\/g, "/")] ?? null;
  const refs = [{ kind: "models", id: "door.glb" }, { kind: "models", id: "rock.glb" }, { kind: "models", id: "tree.glb" }];
  const f = shadowFaults(refs, ["P/lab", "P/skel"], ["P/lab", "P/skel", "P/other"], fp, { home: "P/skel", jobAssets: "P/skel/job/assets" });
  assert.deepEqual(f.map((x) => x.what), ["models/rock.glb", "models/tree.glb"]);
  assert.match(f[0]!.detail!, /different bytes under the same id in other \(/);
  assert.equal(shadowFaults(refs, ["P/lab", "P/skel"], ["P/lab", "P/skel", "P/other"], fp).length, 3); // without the job: all three
});

test("height-less targets get the drop test: highest walkable surface, stand within 0.75 m (no free pass)", () => {
  // a deck 4 m over the ground, a pole top above it (too steep / tiny normal): the deck is the surface
  assert.equal(highestWalkable([{ y: 9, ny: 0.2 }, { y: 4, ny: 0.99 }, { y: 0, ny: 1 }], 0), 4);
  assert.equal(highestWalkable([], 1.5), 1.5); // nothing hit: the terrain
  assert.equal(dropHoldFault("area:yard", [0, 4.1, 0], 4, false), null);
  const f = dropHoldFault("area:yard", [0, 0.2, 0], 4, false);
  assert.equal(f?.kind, "MISS");
  assert.equal(f?.what, "area:yard hold");
  assert.match(f!.detail!, /below/);
  assert.equal(dropHoldFault("area:yard", [0, 0.2, 0], 4, true), null); // open water floats the body
});

// ---- portals: the travel the reach itself caused counts (it was cleared after the reach: no walk ever saw a send)
test("portalSentAfterReach: a send during the reach counts; else step out and walk in / [E]; other portals do not count", () => {
  const calls: string[] = [];
  const steps = (travels: unknown[], on: string, portalId: string) => ({
    stepOut: () => calls.push("out"), idle: () => calls.push("idle"), interact: () => { calls.push("E"); if (on === "E") travels.push({ portalId }); },
    walkIn: () => { calls.push("in"); if (on === "in") travels.push({ portalId }); },
  });
  const during = [{ portalId: "veil" }];
  assert.equal(portalSentAfterReach({ entityId: "veil", trigger: true }, during, steps(during, "", "veil")), true);
  assert.deepEqual(calls, [], "sent on the reach: nothing more to do");
  const later: unknown[] = [];
  assert.equal(portalSentAfterReach({ entityId: "veil", trigger: true }, later, steps(later, "in", "veil")), true);
  assert.deepEqual(calls, ["out", "idle", "in", "idle"]);
  const door: unknown[] = [];
  assert.equal(portalSentAfterReach({ entityId: "door", trigger: false }, door, steps(door, "E", "door")), true);
  const other: unknown[] = [];
  assert.equal(portalSentAfterReach({ entityId: "veil", trigger: true }, other, steps(other, "in", "elsewhere")), false);
});

test("fellJustNow: a > 2 m drop in 0.5 s with the feet in the air stops a leg, but never a declared drop leg (a flight run down)", () => {
  const s: Sample[] = [];
  for (let i = 0; i <= 60; i++) s.push({ x: i * 0.1, y: 30 - (i > 30 ? (i - 30) * 0.1 : 0), z: 0, t: i / 60, air: i > 30 ? 1.5 : 0 });
  assert.equal(fellJustNow(s, 1 / 60), true);
  assert.equal(fellJustNow(s, 1 / 60, true), false);
  const flat = s.map((q) => ({ ...q, y: 30, air: 0 }));
  assert.equal(fellJustNow(flat, 1 / 60), false);
});

test("networkPath: an area target is reached along the declared network, not straight over water or between levels", () => {
  // way in: bank (0,0) -> communal (20,0) at deck 7.5; network: communal -> stair up to a raised deck (20,0)->(20,10) at 9
  // -> along it to (5,10). The target (5,9) sits on the raised deck right over the bank-side route's start.
  const handoff = {
    navigation: {
      routes: [{ id: "bank-to-communal", points: [[0, 6.5, 0], [10, 7.5, 0], [20, 7.5, 0]] }],
      network: [{ id: "to-h1", points: [[0, 6.5, 0], [10, 7.5, 0], [20, 7.5, 0], [20, 7.5, 4], [20, 9, 7], [20, 9, 10], [5, 9, 10]] }],
    },
  };
  const lines = [...declaredRoutes(handoff), ...declaredNetwork(handoff)];
  assert.deepEqual(declaredNetwork(handoff).map((r) => r.id), ["network:to-h1"]);
  const path = networkPath(lines, [5, 9, 9])!;
  assert.ok(path, "a way along the network");
  near(path[0]!, [0, 6.5, 0]);
  const end = path[path.length - 1]!;
  // it ends on the raised deck by the target (not the route point 9 m below-and-beside it at the bank)
  assert.ok(Math.hypot(end[0] - 5, end[2] - 9) <= 1.01 && Math.abs(end[1]! - 9) < 0.01, `ended at ${JSON.stringify(end)}`);
  assert.ok(path.some((p) => p[0] === 20 && p[2] === 10), "it goes round by the stair, not straight across");
  // a target on no level the graph has within reach: the nearest graph point at all; none within maxM: null
  assert.equal(networkPath(lines, [100, null, 100]), null);
});

test("shadowFaults: a job folder that keeps its delivery straight under <kind>/ (no assets/) is pending too", () => {
  const files: Record<string, string> = { "P/lab/assets/materials/m/lip.json": "new", "P/skel/assets/materials/m/lip.json": "old", "P/skel/job/materials/m/lip.json": "new" };
  const fp = (f: string): string | null => files[f.replace(/\\/g, "/")] ?? null;
  const refs = [{ kind: "materials", id: "m/lip.json" }];
  assert.equal(shadowFaults(refs, ["P/lab", "P/skel"], ["P/lab", "P/skel"], fp, { home: "P/skel", jobAssets: "P/skel/job/assets" }).length, 0);
  assert.equal(shadowFaults(refs, ["P/lab", "P/skel"], ["P/lab", "P/skel"], fp).length, 1);
});

// ---- BODY
test("bodyClashes: a board standing across the walked line is a BODY fault; boards on the walls, treads and the ceiling are not", async () => {
  const { bodyClashes, bodyTrail, pointTriDist } = await import("../tools/_poi-walk-lib.mts");
  assert.ok(Math.abs(pointTriDist([0, 1, 0], [-1, 0, -1], [1, 0, -1], [0, 0, 1]) - 1) < 1e-9);
  // a passage along +x, 3.6 m wide (walls at z = +-1.66), floor y 0; feet along z = 0 every 0.3 m
  const feet = bodyTrail(Array.from({ length: 40 }, (_, i) => ({ x: i * 0.3, y: 0, z: 0, t: i / 60, air: 0 })));
  const quad = (p: number[][]): number[] => [...p[0]!, ...p[1]!, ...p[2]!, ...p[0]!, ...p[2]!, ...p[3]!];
  const wall = quad([[0, 0, 1.66], [12, 0, 1.66], [12, 3.8, 1.66], [0, 3.8, 1.66]]);
  const ceiling = quad([[0, 3.8, -1.7], [12, 3.8, -1.7], [12, 3.8, 1.7], [0, 3.8, 1.7]]);
  const tread = quad([[0, 0.16, -1.6], [12, 0.16, -1.6], [12, 0.16, 1.6], [0, 0.16, 1.6]]);
  const across = quad([[6, 0, -1.66], [6, 0, 1.66], [6, 3.8, 1.66], [6, 3.8, -1.66]]);   // the next leg's wall run on through the corner
  const f = bodyClashes(feet, [{ id: "wall", world: wall }, { id: "ceiling", world: ceiling }, { id: "tread", world: tread }, { id: "across", world: across }]);
  assert.deepEqual(f.map((x) => x.what), ["across"]);
  assert.equal(f[0]!.kind, "BODY");
  // a board hung over head height and a sloped board whose bottom passes 0.3 m over the body are clear
  const high = quad([[6, 2.3, -1.66], [6, 2.3, 1.66], [6, 3.8, 1.66], [6, 3.8, -1.66]]);
  assert.equal(bodyClashes(feet, [{ id: "high", world: high }]).length, 0);
  // airborne samples are not walked points
  assert.equal(bodyTrail([{ x: 0, y: 5, z: 0, t: 0, air: 4 }]).length, 0);
});

test("WALK_THROUGH_TAGS: the scene's player avatar and the veils are no BODY obstacle", async () => {
  const { WALK_THROUGH_TAGS } = await import("../tools/_poi-walk-lib.mts");
  for (const t of ["player", "zone-boundary", "portal-veil", "walk-through"]) assert.ok(WALK_THROUGH_TAGS.has(t), t);
  assert.ok(!WALK_THROUGH_TAGS.has("static"));
});

test("a leg's goal is the walkable surface the body arrived on, not the terrain under stairs (PB-FIX 2026-10-20)", () => {
  // route point declared on the ground at 10.0; the body ends on ribbon steps at 12.6 (stair tops at 12.6 and a deck at 15)
  assert.equal(goalSurface(10, [15, 12.6], 12.62), 12.6);
  const samples: Sample[] = [{ x: 0, y: 12, z: 0, t: 0 }, { x: 0.3, y: 12.62, z: 0.2, t: 1 }];
  assert.equal(judgeLeg("up the steps", samples, [0, goalSurface(10, [12.6], 12.62), 0]).ok, true);
  assert.equal(judgeLeg("up the steps", samples, [0, 10, 0]).ok, false, "against the terrain it was a false MISS");
  // no surface near the end: still judged against the declared ground (a real miss stays a miss)
  assert.equal(goalSurface(10, [], 12.62), 10);
  assert.equal(goalSurface(null, [12.6], 12.62), null);
});

test("bodySkip: a creature's meshes (dynamic body, npc/populate tag on an ancestor) are no BODY obstacle; a static wall is", async () => {
  const { bodySkip } = await import("../tools/_poi-walk-lib.mts");
  const mesh = { mesh: { source: { kind: "asset", assetId: "x.glb" } } };
  const entities: Record<string, any> = {
    mob: { parent: null, tags: ["npc", "populate"], components: { rigidbody: { kind: "dynamic" } } },
    "mob-visual": { parent: "mob", tags: [], components: { ...mesh } },
    "mob-weapon": { parent: "mob-visual", tags: [], components: { ...mesh } },
    cart: { parent: null, tags: [], components: { ...mesh, rigidbody: { kind: "dynamic" } } },
    wall: { parent: null, tags: ["static"], components: { ...mesh, rigidbody: { kind: "fixed" } } },
    veil: { parent: null, tags: ["portal-veil"], components: { ...mesh } },
    bare: { parent: null, tags: [], components: {} },
  };
  for (const id of ["mob-visual", "mob-weapon", "cart", "veil", "bare"]) assert.equal(bodySkip(entities, id), true, id);
  assert.equal(bodySkip(entities, "wall"), false);
});

test("nearestRoutePoint: a target with no height is reached from a route point on the surface, not a stair corner down a shaft", async () => {
  const { nearestRoutePoint } = await import("../tools/_poi-walk-lib.mts");
  const routes = [{ id: "r", source: "handoff", points: [[-2298, 147, -1948], [-2276, 136.7, -1948], [-2276, 132, -1936]], drops: [], jump: true, driver: "stick" }] as any;
  const surface = () => 148;
  const p = nearestRoutePoint(routes, [-2224, null, -1868], 260, surface)!;
  assert.ok(p[1]! >= 145, `surface point, got y ${p[1]}`);
  assert.equal(nearestRoutePoint(routes, [-2224, null, -1868])![1], 132, "without surfaceY: plain nearest");
  assert.equal(nearestRoutePoint(routes, [-2276, 132, -1936], 260, surface)![1], 132, "a target with a height keeps the plain nearest");
});

test("routeLegKeeps / legOnLevel: declared walk legs are kept clear for the dressing, each on its own level", async () => {
  const { routeLegKeeps, legOnLevel } = await import("../tools/_poi-walk-lib.mts");
  const h = { navigation: { routes: [{ id: "cut", points: [[-2430, 134, -1944], [-2408, 124.6, -1938], [-2497, 2.1, -1929], [-2496.3, 2.1, -1944.9]] }], network: [{ id: "deck", points: [[0, 0], [5, 0]] }] } };
  const legs = routeLegKeeps(h);
  assert.equal(legs.length, 4);
  assert.deepEqual(legs[2]!.points, [[-2497, -1929], [-2496.3, -1944.9]]);
  assert.equal(legs[2]!.y, 2.1);
  assert.equal(legs[3]!.y, null);
  assert.equal(legOnLevel(2.1, "built", 2, 152), true, "the chapel deck line on the chapel deck");
  assert.equal(legOnLevel(129.3, "built", 2, 152), false, "a stair leg far above the deck");
  assert.equal(legOnLevel(70, "ground", null, 152), false, "a stair leg down a shaft under a heath area");
  assert.equal(legOnLevel(null, "ground", null, 152), true);
  assert.equal(legOnLevel(null, "cave", 2, 152), false);
});

test("declaredFloorKind: a declared floor deep under the ground is a cave, a clear top is built, else ground", async () => {
  const { declaredFloorKind } = await import("../tools/_poi-walk-lib.mts");
  assert.equal(declaredFloorKind(0, 50, 1.6, 148), "cave", "the tide cave under the heath");
  assert.equal(declaredFloorKind(20, 50, 2, 0.5), "built", "a deck over the water");
  assert.equal(declaredFloorKind(0, 50, 146, 147.5), "ground");
});
test("entityTargets: a catalogued building's door marker is walked in from 4 m outside to 2.5 m inside, never jumping", () => {
  const s = Math.SQRT1_2; // turned +90 deg about y: local +z (the door's way out) -> world +x
  const views: EntityView[] = [
    { id: "farm-core-house", parent: "poi-farm", tags: ["prefab"], position: [200, 105, 300], quaternion: [0, 0, 0, 1], components: {} },
    { id: "farm-core-house:shell", parent: "farm-core-house", tags: ["static"], position: [200, 105, 300], quaternion: [0, s, 0, s], components: { mesh: { source: { kind: "asset", assetId: "strand-town/strand-house-s.glb" } } } },
  ];
  const t = entityTargets(views, (asset) => (asset === "strand-town/strand-house-s.glb" ? [{ id: "door-1", position: [-1.6, 0, 4.36], yaw: 0 }] : []));
  assert.equal(t.length, 1);
  assert.equal(t[0]!.kind, "door");
  assert.equal(t[0]!.noJump, true);
  near(t[0]!.at, [204.36, 105, 301.6]);
  near(t[0]!.from!, [208.36, 105, 301.6]);
  near(t[0]!.through!, [201.86, 105, 301.6]);
  assert.equal(entityTargets(views).length, 0); // without a marker reader: no door targets (old callers unchanged)
});

test("portalWalkInPoint: a trigger portal's walk-in stops just inside the box's near face, toward where it came from", () => {
  // moon 2026-10-31: box half 0.75 m, the walk from 20 m out along -z; the stop is 0.5 m in front of the anchor
  near(portalWalkInPoint([10, 4, 30], [10, 4, 10], 0.75) as number[], [10, 4, 29.5]);
  // no box size, or a box thinner than the margin: the anchor itself
  near(portalWalkInPoint([10, 4, 30], [10, 4, 10], undefined) as number[], [10, 4, 30]);
  near(portalWalkInPoint([10, 4, 30], [10, 4, 10], 0.2) as number[], [10, 4, 30]);
  // y may be null (a target at no fixed height)
  assert.equal(portalWalkInPoint([0, null, 0], [3, null, 4], 1.25)[1], null);
  near([portalWalkInPoint([0, null, 0], [3, null, 4], 1.25)[0], portalWalkInPoint([0, null, 0], [3, null, 4], 1.25)[2]] as number[], [0.6, 0.8]);
});
