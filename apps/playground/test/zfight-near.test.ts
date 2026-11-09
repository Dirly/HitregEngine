import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nearCells, parseNear, staticSoup, triangleNear } from "../tools/zfight.mts";

test("zfight --near: parse, triangle and cell selection", () => {
  assert.deepEqual(parseNear("3440,660,240"), { x: 3440, z: 660, r: 240 });
  assert.equal(parseNear(undefined), undefined);
  assert.throws(() => parseNear("1,2"));
  const n = { x: 0, z: 0, r: 10 };
  assert.equal(triangleNear([9, 0, 9, 30, 0, 9, 30, 0, 30], 0, n), true); // one corner inside
  assert.equal(triangleNear([-30, 0, 5, 30, 0, 5, 0, 0, 40], 0, n), true); // spans it without a vertex inside
  assert.equal(triangleNear([11, 0, 0, 20, 0, 0, 20, 0, 5], 0, n), false);
  assert.deepEqual(nearCells({ x: 32, z: 32, r: 1 }, 32), [[0, 0], [0, 1], [1, 0], [1, 1]]);
});

test("zfight --near: the soup keeps only the region's static meshes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zfight-near-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const box = (x: number) => ({ name: `b${x}`, parent: null, tags: [], components: { transform: { position: [x, 0, 0] }, mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } } } });
  const doc: any = { version: 1, entities: { near: box(0), far: box(500) } };
  const all = staticSoup("none", assets, doc, null);
  assert.deepEqual(all.labels.sort(), ["far", "near"]);
  const some = staticSoup("none", assets, doc, null, undefined, { x: 0, z: 0, r: 20 });
  assert.deepEqual(some.labels, ["near"]);
  assert.equal(some.meshes[0]!.positions.length, all.meshes.find((m) => m.id === "near")!.positions.length);
});

test("zfight: hidden prefab parts (a landmark bake's welded collider) never fight", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zfight-hidden-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(path.join(assets, "prefabs", "t"), { recursive: true });
  const mesh = { source: { kind: "primitive", shape: "box", size: [2, 2, 2] } };
  fs.writeFileSync(path.join(assets, "prefabs", "t", "lm.json"), JSON.stringify({ root: "r", entities: {
    r: { name: "r", parent: null, components: { transform: {} } },
    shell: { name: "shell", parent: "r", components: { transform: {}, mesh: { ...mesh, material: "a" } } },
    collider: { name: "collider", parent: "r", components: { transform: {}, visibility: { visible: false }, mesh: { ...mesh, material: "a" }, collider: { shape: "trimesh" } } },
  } }));
  const doc: any = { version: 1, entities: { lm: { name: "lm", parent: null, tags: [], components: { transform: {}, prefab: { prefabId: "t/lm" } } } } };
  const s = staticSoup("none", assets, doc, null);
  assert.deepEqual(s.labels, ["lm/t/lm:shell"]);
});

test("zfight: a bare collider (physics only, never drawn) never fights the visual it shadows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zfight-collider-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const doc: any = { version: 1, entities: {
    deck: { name: "deck", parent: null, tags: [], components: { transform: {}, mesh: { source: { kind: "primitive", shape: "box", size: [4, 0.2, 4] } } } },
    "deck-col": { name: "deck (collider)", parent: null, tags: ["static"], components: { transform: {}, collider: { shape: "box", size: [4, 0.2, 4] } } },
  } };
  assert.deepEqual(staticSoup("none", assets, doc, null).labels, ["deck"]);
});

test("two pieces' base planes where they overlap are not charged; a shared soffit above the base is (o-gates 2026-10-30)", async () => {
  const { isBaseOnBase, meshBottoms } = await import("../tools/zfight.mts");
  const b = meshBottoms([{ id: "gate:art", positions: [0, 126.3, 0, 1, 140, 0] }, { id: "pylon:art", positions: [0, 126.3, 0, 1, 166, 0] }]);
  assert.equal(isBaseOnBase({ a: { mesh: "gate:art" }, b: { mesh: "pylon:art" }, normal: [0, -1, 0], centre: [0, 126.3, 0] }, b), true);
  assert.equal(isBaseOnBase({ a: { mesh: "gate:art" }, b: { mesh: "pylon:art" }, normal: [0, -1, 0], centre: [0, 130.3, 0] }, b), false);
  assert.equal(isBaseOnBase({ a: { mesh: "gate:art" }, b: { mesh: "pylon:art" }, normal: [1, 0, 0], centre: [0, 126.3, 0] }, b), false);
  assert.equal(isBaseOnBase({ a: { mesh: "gate:art" }, b: { mesh: "voxel:w" }, normal: [0, -1, 0], centre: [0, 126.3, 0] }, b), false);
});

test("zfight gate: a layered thin prop held level on uneven ground fights it; tilted by thinTiltSeat it does not (r1b 2026-10-31)", async () => {
  const { findZFights } = await import("@hitreg/core");
  const { zfightThresholds } = await import("../tools/zfight.mts");
  const { boxTris, trs } = await import("../tools/_prop-geometry.mts");
  const { FLUSH_SINK_M, isThinGroundProp, thinTiltSeat, upFaces } = await import("../tools/_place-quality.mts");
  // the Drinking Stone's bedroll: a mat (top 0.045), a blanket over it (top 0.105) and a rolled pillow (0.35 tall)
  const bed: any[] = [];
  boxTris([0.8, 0.045, 2.0], trs([0, 0.0225, 0]), bed);
  boxTris([0.7, 0.06, 1.6], trs([0, 0.075, -0.15]), bed);
  boxTris([0.6, 0.35, 0.3], trs([0, 0.175, 0.8]), bed);
  const faces = upFaces(bed);
  assert.ok(isThinGroundProp(0.35, faces, 0.8 * 2.0), "a bedroll with a pillow is a thin ground prop");
  const { planeSeatKind: kindOf } = await import("../tools/_place-quality.mts");
  assert.equal(kindOf(0.35, faces, 1.6, [0, 0, 0]), "thin");
  assert.equal(kindOf(0.45, [{ h: 0.3, area: 0.2 }], 0.4, [0, 0.12, 0.23]), null, "a round log keeps the level sink (its outline is not flat)");
  assert.ok(!isThinGroundProp(0.45, [{ h: 0.45, area: 0.2 }], 0.2), "a crate is not");
  const { planeSeatKind } = await import("../tools/_place-quality.mts");
  assert.equal(planeSeatKind(0.46, [{ h: 0.275, area: 0.34 }, { h: 0.46, area: 0.4 }], 0.83, [0, 0.01]), "plate", "a trough with its floor 0.275 m up is seated by its plane");
  assert.equal(planeSeatKind(0.9, [{ h: 0.9, area: 0.3 }], 0.3, [0]), null, "a barrel is not");
  // uneven ground: a 2 deg fall plus a few mm of lumps (below the gate's 3 deg, so a level layer crossing it fights)
  const h = (x: number, z: number) => 10 + 0.035 * x + 0.012 * z + 0.004 * Math.sin(3 * x) * Math.cos(2 * z);
  const g: number[] = [], S = 0.25;
  for (let x = -2; x < 2; x += S) for (let z = -2; z < 2; z += S) {
    const p = (a: number, b: number) => [a, h(a, b), b];
    g.push(...p(x, z), ...p(x, z + S), ...p(x + S, z + S), ...p(x, z), ...p(x + S, z + S), ...p(x + S, z));
  }
  const ground = { id: "voxel:test", positions: g };
  const T = zfightThresholds();
  const posed = (rot: number[], y: number) => { const m = trs([0, y, 0], rot), out: any[] = []; for (const t of bed) for (const v of [t.a, t.b, t.c]) out.push(m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!, m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!, m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!); return out; };
  const failing = (pos: number[]) => findZFights([ground, { id: "bedroll", positions: pos }], { maxGap: T.maxGap, maxAngleDeg: T.maxAngleDeg, minArea: T.minClusterArea }).clusters.filter((c) => c.area >= T.failClusterArea);
  // the old seat: level, FLUSH_SINK_M under the median ground of its footprint
  const gs: number[] = []; for (let x = -0.4; x <= 0.4; x += 0.2) for (let z = -1; z <= 1; z += 0.25) gs.push(h(x, z)); gs.sort((a, b) => a - b);
  assert.ok(failing(posed([0, 0, 0, 1], gs[Math.floor(gs.length / 2)]! - FLUSH_SINK_M)).length > 0, "held level, a layer crosses the ground and fights it");
  const ts = thinTiltSeat(h, [0, 0], 0, [0.4, 1.0], 0.35, faces);
  assert.ok(ts.slopeDeg > 1.5 && ts.clear >= 0.02, `tilted ${ts.slopeDeg} deg, clear ${ts.clear} m`);
  assert.deepEqual(failing(posed(ts.rotation, ts.y)), [], "tilted to the ground plane, no layer fights it");
});

test("zfight: a plane primitive is one flat up-facing quad (a drain 0.5 m under a water plane does not fight it)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zfight-plane-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(assets, { recursive: true });
  const plane = (y: number) => ({ name: "p", parent: null, tags: [], components: { transform: { position: [0, y, 0] }, mesh: { source: { kind: "primitive", shape: "plane", size: [4, 1, 4] } } } });
  const soup = staticSoup("none", assets, { version: 1, entities: { water: plane(0), drain: plane(-0.5) } } as any, null);
  const water = soup.meshes.find((m) => m.id === "water")!;
  assert.equal(water.positions.length, 18); // two triangles
  for (let i = 1; i < water.positions.length; i += 3) assert.equal(water.positions[i], 0);
  const drain = soup.meshes.find((m) => m.id === "drain")!;
  for (let i = 1; i < drain.positions.length; i += 3) assert.equal(drain.positions[i], -0.5);
});
