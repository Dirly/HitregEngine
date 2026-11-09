import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOps, ComponentRegistry, createWorldField, defaultWorldRecipe, registerCoreComponents, worldRecipeSchema } from "@hitreg/core";
import { afloat, buriedReason, commandFloat, crossingColumns, fixOnCurrent, fixOps, floatScatter, floatScene, inverseState, LANDMARK_SUPPORT, sceneDigest, tautSpanEnds, withLandmarkSupport } from "../tools/float.mts";
import { standardStages } from "../../../tools/dungeon-pipeline/pipeline.mjs";
import { floatBlock } from "../../../tools/poi-review/job.mjs";

const reg = (): ComponentRegistry => { const r = new ComponentRegistry(); registerCoreComponents(r); return r; };

/** A temp project: a 1 m crate prefab and a scene with a 10 m deck (box collider, top at y=1) and two crates. */
function project(crateY: number): { assets: string; doc: any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-"));
  const assets = path.join(dir, "assets");
  fs.mkdirSync(path.join(assets, "prefabs", "t"), { recursive: true });
  // the crate's box is centred on its root: put its bottom at the root by nesting the mesh half a metre up
  fs.writeFileSync(path.join(assets, "prefabs", "t", "crate.json"), JSON.stringify({
    root: "r", entities: { r: { name: "crate", parent: null, components: { transform: {} } }, m: { name: "m", parent: "r", components: { transform: { position: [0, 0.5, 0] }, mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } } } } },
  }));
  const doc = {
    version: 1, name: "t",
    entities: {
      deck: { name: "deck", parent: null, components: { transform: { position: [0, 0.5, 0] }, collider: { shape: "box", size: [10, 1, 10] } } },
      group: { name: "g", parent: null, components: { transform: { position: [0, 0, 0] } } },
      a: { name: "a", parent: "group", components: { transform: { position: [1, crateY, 1] }, prefab: { prefabId: "t/crate" } } },
      b: { name: "b", parent: null, components: { transform: { position: [-2, 0.98, -2] }, prefab: { prefabId: "t/crate" } } },
    },
  };
  return { assets, doc };
}

test("float scene: a crate 0.4 m over the deck is off; --fix re-seats it through applyOps, and a second fix is a no-op", () => {
  const { assets, doc } = project(1.4);
  const r = floatScene(assets, doc as never, null, {}, 0.05);
  assert.equal(r.checked, 2);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.id, "a");
  assert.equal(r.rows[0]!.status, "off");
  assert.ok(Math.abs(r.rows[0]!.gap - 0.4) < 0.02);
  const { doc: fixed, inverse } = applyOps(doc as never, fixOps(doc as never, r.rows, false) as never, reg());
  const again = floatScene(assets, fixed, null, {}, 0.05);
  assert.equal(again.rows.length, 0);
  assert.equal(fixOps(fixed, again.rows, false).length, 0); // idempotent
  // the inverse restores the floating crate exactly
  const back = applyOps(fixed, inverse, reg()).doc as any;
  assert.deepEqual(back.entities.a.components.transform.position, [1, 1.4, 1]);
});

test("float scene: a rock's rule is EMBEDDED — one resting on the deck is a fault; --fix sinks it 15% and it passes", () => {
  const { assets, doc } = project(1);
  // a 1 m boulder (an id the contact rules read as a rock: embed) standing ON the deck top, touching only
  fs.mkdirSync(path.join(assets, "prefabs", "rock-kit"), { recursive: true });
  fs.writeFileSync(path.join(assets, "prefabs", "rock-kit", "boulder-t.json"), fs.readFileSync(path.join(assets, "prefabs", "t", "crate.json")));
  doc.entities.r = { name: "r", parent: null, components: { transform: { position: [3, 1, 3] }, prefab: { prefabId: "rock-kit/boulder-t" } } };
  const r = floatScene(assets, doc as never, null, {}, 0.05).rows.find((q) => q.id === "r")!;
  assert.equal(r.contact, "embed");
  assert.equal(r.status, "off");
  assert.match(r.reason ?? "", /embedded 0% of its height \(< 10%\)/);
  assert.ok(Math.abs(r.fix!.y! - (1 - 0.15)) < 0.01, `sunk 15% of its 1 m height: ${r.fix!.y}`);
  const fixed = applyOps(doc as never, fixOps(doc as never, [r], false) as never, reg()).doc;
  assert.equal(floatScene(assets, fixed, null, {}, 0.05).rows.find((q) => q.id === "r"), undefined, "embedded 15%: passes");
  // 8% in still fails, 12% in passes
  (doc.entities.r.components.transform.position as number[])[1] = 0.92;
  assert.equal(floatScene(assets, doc as never, null, {}, 0.05).rows.find((q) => q.id === "r")?.status, "off");
  (doc.entities.r.components.transform.position as number[])[1] = 0.88;
  assert.equal(floatScene(assets, doc as never, null, {}, 0.05).rows.find((q) => q.id === "r"), undefined);
});

test("float scene: hanging pieces are checked for their hook, not the floor (chandelier mount ceiling, its chain links)", () => {
  const { assets, doc } = project(1);
  const crate = JSON.parse(fs.readFileSync(path.join(assets, "prefabs", "t", "crate.json"), "utf8"));
  const withDressing = (d: object) => ({ ...crate, entities: { ...crate.entities, r: { ...crate.entities.r, components: { transform: {}, dressing: d } } } });
  fs.mkdirSync(path.join(assets, "prefabs", "poi-props"), { recursive: true });
  fs.writeFileSync(path.join(assets, "prefabs", "poi-props", "chain-one-metre.json"), JSON.stringify(withDressing({ mount: "part" })));
  fs.writeFileSync(path.join(assets, "prefabs", "t", "lamp.json"), JSON.stringify(withDressing({ mount: "ceiling", chain: "poi-props/chain-one-metre" })));
  // a beam whose underside is at y=5; the chain's two links hang from it (tops at 5 and 4), the lamp from the lower link
  doc.entities.beam = { name: "beam", parent: null, components: { transform: { position: [0, 5.5, 0] }, collider: { shape: "box", size: [10, 1, 10] } } };
  doc.entities["l--chain-0"] = { name: "l/chain-0: poi-props/chain-one-metre", parent: null, components: { transform: { position: [3, 4, 3] }, prefab: { prefabId: "poi-props/chain-one-metre" } } };
  doc.entities.link = { name: "link", parent: null, components: { transform: { position: [3, 3, 3] }, prefab: { prefabId: "poi-props/chain-one-metre" } } };
  doc.entities.lamp = { name: "lamp", parent: null, components: { transform: { position: [3, 2, 3] }, prefab: { prefabId: "t/lamp" } } };
  // a link the dresser named, whatever its prefab: a hang
  doc.entities["m--chain-1"] = { name: "m/chain-1: t/crate", parent: null, components: { transform: { position: [-3, 4, -3] }, prefab: { prefabId: "t/crate" } } };
  const r = floatScene(assets, doc as never, null, {}, 0.05);
  assert.deepEqual(r.rows.map((q) => q.id), [], JSON.stringify(r.rows));
  // a link that does not reach the beam is a fault of its hook ("not touching what it hangs from"), never "floating"
  doc.entities["l--chain-0"].components.transform.position = [3, 3.9, 3];
  doc.entities.link.components.transform.position = [3, 2.9, 3];
  const off = floatScene(assets, doc as never, null, {}, 0.05).rows.find((q) => q.id === "l--chain-0")!;
  assert.equal(off.contact, "hang");
});

test("float --fix inverse is keyed to the scene build: a rebuilt scene's old inverse is stale, not 'already applied'", () => {
  const { assets, doc } = project(1.4);
  const r = floatScene(assets, doc as never, null, {}, 0.05);
  const { doc: fixed, inverse } = applyOps(doc as never, fixOps(doc as never, r.rows, false) as never, reg());
  const inv = path.join(assets, "float-fix.inverse.json");
  fs.writeFileSync(inv, JSON.stringify({ scene: "t.scene.json", digest: sceneDigest(fixed), ops: inverse }));
  assert.equal(inverseState(inv, fixed), "current", "the fixed build: applied");
  // the scene is rebuilt (the crate floats again, ids the same): the old inverse no longer describes it
  assert.equal(inverseState(inv, doc as never), "stale");
  assert.equal(inverseState(path.join(assets, "none.json"), doc as never), "none");
  // a legacy bare-array inverse: stale once the scene file is newer
  const legacy = path.join(assets, "legacy.inverse.json"), scene = path.join(assets, "t.scene.json");
  fs.writeFileSync(legacy, JSON.stringify(inverse)); fs.writeFileSync(scene, "{}");
  fs.utimesSync(legacy, new Date(1000), new Date(1000));
  assert.equal(inverseState(legacy, doc as never, scene), "stale");
});

test("float scene: a crate over nothing is unsupported, removed only with drop", () => {
  const { assets, doc } = project(1);
  doc.entities.a.components.transform.position = [30, 1, 30];
  const r = floatScene(assets, doc as never, null, {}, 0.05);
  assert.equal(r.rows[0]!.status, "unsupported");
  assert.equal(fixOps(doc as never, r.rows, false).length, 0);
  assert.equal(fixOps(doc as never, r.rows, true)[0].op, "remove-entity");
});

test("worldgen float: scatter rocks are seated by the runtime (0 faults), the legacy placement is measured", () => {
  const recipe = worldRecipeSchema.parse({ ...defaultWorldRecipe(), cellSize: 48, resolution: 24 });
  const field = createWorldField(recipe);
  const seated = floatScatter(field, { rect: [-96, -96, 96, 96] }, 0.05, false);
  const legacy = floatScatter(field, { rect: [-96, -96, 96, 96] }, 0.05, true);
  if (legacy.checked > 0) assert.ok(seated.rows.filter((r) => r.status === "off").length <= legacy.rows.filter((r) => r.status === "off").length);
  // the command runs headless and reports through --json
  const lines: string[] = [], log = console.log;
  console.log = (m: unknown) => { lines.push(String(m)); };
  try { commandFloat({ argv: ["float", "w", "--near", "0,0,40", "--json", "--no-scene"], loadRecipe: () => ({ recipe, file: path.join(os.tmpdir(), "x", "assets", "worlds", "w.json") }), fail: (m: string) => { throw new Error(m); } }); } finally { console.log = log; process.exitCode = 0; }
  const rep = JSON.parse(lines.at(-1)!);
  assert.equal(typeof rep.ok, "boolean");
  assert.equal(rep.passed, rep.ok);
});

test("wiring: the dungeon pipeline has a float stage before its final check; poi-review gate 5 reads reports/float.json", () => {
  const names = standardStages({ id: "d" }).map((s: { name: string }) => s.name);
  assert.ok(names.includes("float"));
  assert.ok(names.indexOf("float") < names.indexOf("portal play"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-job-"));
  assert.match(floatBlock(dir)!, /no float gate evidence/);
});

test("withLandmarkSupport adds the newest bake of each landmark op as a support-only entity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-lm-"));
  const lm = path.join(dir, "prefabs", "landmarks");
  fs.mkdirSync(lm, { recursive: true });
  const old = path.join(lm, "weir-aaaaaaaa.json"), cur = path.join(lm, "weir-bbbbbbbb.json");
  fs.writeFileSync(old, "{}"); fs.writeFileSync(cur, "{}"); fs.writeFileSync(path.join(lm, "gate-cccccccc.json"), "{}");
  fs.utimesSync(old, new Date(1000), new Date(1000));
  const ops = [{ id: "weir", op: "landmark", at: [10, 20], y: 3, yaw: 90 }, { id: "gate", op: "landmark", at: [0, 0], y: 1 }];
  const doc = withLandmarkSupport(dir, { version: 1, name: "s", entities: { a: { name: "a", parent: null, components: {} } } } as any, ops) as any;
  assert.deepEqual(doc.entities[`${LANDMARK_SUPPORT}weir`].components.transform.position, [10, 3, 20], "placed at the operator pose");
  assert.equal(withLandmarkSupport(dir, { entities: {} } as any, []).entities[`${LANDMARK_SUPPORT}weir`], undefined, "no operator, no support");
  assert.equal(doc.entities[`${LANDMARK_SUPPORT}weir`].components.prefab.prefabId, "landmarks/weir-bbbbbbbb");
  assert.equal(doc.entities[`${LANDMARK_SUPPORT}gate`].components.prefab.prefabId, "landmarks/gate-cccccccc");
  assert.ok(doc.entities.a, "keeps the scene's own entities");
});

test("withLandmarkSupport adds wall-baked recipe landmarks at their recipe position", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "float-lmw-"));
  const lm = path.join(dir, "prefabs", "landmarks");
  fs.mkdirSync(lm, { recursive: true });
  fs.writeFileSync(path.join(lm, "stair-dddddddd.json"), "{}"); fs.writeFileSync(path.join(lm, "gate-cccccccc.json"), "{}");
  const ops = [{ id: "stair", op: "wall", points: [[0, 0], [10, 0]] }, { id: "gate", op: "landmark", at: [0, 0], y: 1 }];
  const recipeLms = [
    { id: "op:stair:landmark", prefab: "landmarks/stair-dddddddd", position: [5, 0, -3] },
    { id: "op:gate:landmark", prefab: "landmarks/gate-cccccccc", position: [9, 9, 9] },
    { id: "op:gone:landmark", prefab: "landmarks/gone-eeeeeeee", position: [0, 0, 0] },
  ];
  const doc = withLandmarkSupport(dir, { version: 1, name: "s", entities: {} } as any, ops, recipeLms) as any;
  assert.deepEqual(doc.entities[`${LANDMARK_SUPPORT}stair`].components.transform.position, [5, 0, -3], "the wall op's bake where the world draws it");
  assert.equal(doc.entities[`${LANDMARK_SUPPORT}stair`].components.prefab.prefabId, "landmarks/stair-dddddddd");
  assert.deepEqual(doc.entities[`${LANDMARK_SUPPORT}gate`].components.transform.position, [0, 1, 0], "a landmark op keeps its operator pose");
  assert.equal(doc.entities[`${LANDMARK_SUPPORT}gone`], undefined, "no bake file, no support");
});

test("float --fix writes onto the scene as it is NOW: another job's edit made during the sweep survives; a clash refuses", () => {
  const { assets, doc } = project(1.4);
  const file = path.join(assets, "t.scene.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  const loaded = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = floatScene(assets, loaded, null, {}, 0.05).rows;
  const ops = fixOps(loaded, rows, false);
  const res = applyOps(loaded, ops as never, reg());
  // unchanged file: the fixed doc as computed
  assert.equal(fixOnCurrent(file, loaded, { doc: res.doc as never, ops, inverse: res.inverse }).rebased, false);
  // another job adds an entity while the fix measured
  const other = JSON.parse(fs.readFileSync(file, "utf8"));
  other.entities.late = { name: "late", parent: null, components: { transform: { position: [9, 9, 9] } } };
  fs.writeFileSync(file, JSON.stringify(other));
  const out = fixOnCurrent(file, loaded, { doc: res.doc as never, ops, inverse: res.inverse });
  assert.equal(out.rebased, true);
  assert.ok((out.doc.entities as any).late, "the other job's entity is kept");
  assert.deepEqual((out.doc.entities as any).a.components.transform.position, (res.doc.entities as any).a.components.transform.position, "the fix still lands");
  assert.notDeepEqual((out.doc.entities as any).a.components.transform.position, [1, 1.4, 1]);
  // another job moved the very crate the fix re-seats: refuse, write nothing
  other.entities.a.components.transform.position = [5, 3, 5];
  fs.writeFileSync(file, JSON.stringify(other));
  assert.throws(() => fixOnCurrent(file, loaded, { doc: res.doc as never, ops, inverse: res.inverse }), /changed under the fix/);
});

test("tautSpanEnds: a sloped 14 m span is held when both ends thread solid, not by an edge vertex or a plan axis", () => {
  // a sloped bar from (0, 10, 0) to (12, 4, 7): a box-ish cloud of vertices round its axis, 0.4 m thick
  const a = [0, 10, 0], b = [12, 4, 7], w: number[] = [];
  for (let s = 0; s <= 1.0001; s += 0.05) for (const [ox, oy, oz] of [[0.4, 0, 0], [-0.4, 0, 0], [0, 0.4, 0], [0, -0.4, 0], [0, 0, 0.4], [0, 0, -0.4]]) w.push(a[0]! + (b[0]! - a[0]!) * s + ox!, a[1]! + (b[1]! - a[1]!) * s + oy!, a[2]! + (b[2]! - a[2]!) * s + oz!);
  // solid: a block round the high end (the wrist) and, optionally, one round the low end (the anchor)
  const probeOf = (blocks: number[][]) => ({
    floor: (x: number, z: number, hi: number, lo: number) => { for (const k of blocks) if (x >= k[0]! && x <= k[3]! && z >= k[2]! && z <= k[5]! && lo <= k[4]!) { if (hi <= k[4]! && hi >= k[1]!) return hi; if (k[4]! <= hi) return k[4]!; } return null; },
    wall: () => null,
  });
  const wrist = [-2, 8, -2, 1.5, 12, 1.5], anchor = [10.5, 0, 5.5, 14, 4.5, 9];
  const both = tautSpanEnds(w, probeOf([wrist, anchor]) as never, []);
  assert.equal(both.length, 2);
  assert.ok(both.every((e) => e.held), JSON.stringify(both));
  const one = tautSpanEnds(w, probeOf([wrist]) as never, []);
  assert.equal(one.filter((e) => e.held).length, 1, "the low end over air is not held");
  // the next span of the run holds an end
  const next = [11, 3.5, 6.5, 13, 5, 8]; // two corners of the next span's bounds
  assert.ok(tautSpanEnds(w, probeOf([wrist]) as never, [next]).every((e) => e.held));
});

test("buriedReason: a prop inside a closed built block, or crossed by a built top, is buried; one standing on it is not", () => {
  // a closed 10 x 6 x 10 m terrace block (y -3..3), 12 triangles
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] => {
    const v = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
    const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    return quads.flatMap(([a, b, c, d]) => [...v(a!), ...v(b!), ...v(c!), ...v(a!), ...v(c!), ...v(d!)]);
  };
  const built = crossingColumns(box(-5, -3, -5, 5, 3, 5));
  const fp = (y: number, height = 1.2) => ({ x: 0.3, z: 0.2, y, halfX: 1.5, halfZ: 1, yaw: 0.4, height });
  assert.match(buriedReason(built, null, fp(-0.4)) ?? "", /inside built mass/, "the sledge on the cut ground under the terrace");
  assert.equal(buriedReason(built, null, fp(3)), null, "on the terrace top");
  assert.equal(buriedReason(built, null, fp(2.8)), null, "sunk 0.2 m into the top is seating");
  assert.match(buriedReason(built, null, fp(2, 4)) ?? "", /buried/, "a 4 m block with its lower half inside");
  assert.equal(buriedReason(null, null, fp(-0.4)), null, "no built mass");
});

test("buried: a kit piece's declared footing is read as in the ground, its body from the foot up (Red Dial 2026-10-30)", async () => {
  const { buriedReason, bodyAboveFooting } = await import("../tools/float.mts");
  // a ruin house: mesh bottom 95 (a 3.2 m footing), its foot (origin) on the ground at 98.2, walls to 101.4; the field is solid below 98.2
  const field = { floor: (_x: number, _z: number, top: number, bottom: number) => (bottom < 98.2 ? Math.min(top, 98.2) : null) } as any;
  const fp = { x: 0, z: 0, y: 95, halfX: 6, halfZ: 5, height: 6.4 };
  assert.match(String(buriedReason(null, field, fp)), /buried/, "read from the footing's bottom, the ground crosses it");
  assert.equal(buriedReason(null, field, bodyAboveFooting(fp, 95, 3.2)), null, "read from its foot, it stands clear");
  assert.deepEqual(bodyAboveFooting(fp, 95, 0), fp);
});

test("TOOLS-FLOAT BEDDED: a bedded piece is held when its base is under the LOWEST ground of its footprint (sunk, not hovering)", async () => {
  const { beddedGround } = await import("../tools/float.mts");
  // a cliff rising 1 m per metre toward -z: the footprint (x 0, z 0, 4 x 4 m) has its lowest ground on its +z side
  const field = { height: (_x: number, z: number) => -z };
  const low = beddedGround(field, { x: 0, z: 0, halfX: 2, halfZ: 2, yaw: 0 })!;
  assert.ok(Math.abs(low - -1.8) < 1e-9, `lowest ground ${low}`);
  assert.equal(beddedGround({ height: () => NaN }, { x: 0, z: 0, halfX: 1, halfZ: 1, yaw: 0 }), null);
});

test("a boat afloat (slot:boat + wet) whose hull crosses sea level rides the water; a dry, sunk or flown boat is still judged (o-coast sunwine-hold 2026-10-31)", () => {
  const boat = ["poi:x", "slot:boat", "wet"];
  assert.equal(afloat(boat, { y: -2.5, height: 12 }, 0), true, "keel under the sea, deck above: afloat");
  assert.equal(afloat(boat, { y: 1.2, height: 12 }, 0), false, "base above the sea: not afloat (judged on the ground)");
  assert.equal(afloat(boat, { y: -14, height: 12 }, 0), false, "wholly under the sea: sunk, judged");
  assert.equal(afloat(["slot:boat"], { y: -2.5, height: 12 }, 0), false, "not marked wet");
  assert.equal(afloat(["slot:landmark", "wet"], { y: -2.5, height: 12 }, 0), false, "not a boat");
  assert.equal(afloat(boat, { y: 3, height: 12 }, 5), true, "a raised sea level");
});

test("float scene, NO SILENT SKIPS (t-ground 2026-10-31): a placed prefab with no geometry is a fault by id; a founded piece is listed as handed to seated", () => {
  const { assets, doc } = project(1);
  doc.entities.ghost = { name: "ghost", parent: null, components: { transform: { position: [2, 1, 2] }, prefab: { prefabId: "t/missing-prefab" } } };
  doc.entities.f = { name: "f", parent: null, components: { transform: { position: [-3, 1, 3] }, prefab: { prefabId: "t/crate" } } };
  doc.entities["f--foundation"] = { name: "f--foundation", parent: null, components: { transform: { position: [-3, 0.5, 3] }, collider: { shape: "box", size: [1.2, 1, 1.2] } } };
  const r = floatScene(assets, doc as never, null, {}, 0.05);
  const ghost = r.rows.find((q) => q.id === "ghost");
  assert.ok(ghost, "the geometry-less piece is a row");
  assert.equal(ghost!.status, "off");
  assert.match(ghost!.reason ?? "", /not measured, so not passed/);
  assert.deepEqual(r.deferred, ["f"]);
  assert.equal(r.unsized, 1);
  // a FLAT piece (zero height, real footprint) is judged as a slab, never skipped
  fs.writeFileSync(path.join(assets, "prefabs", "t", "mat.json"), JSON.stringify({ root: "r", entities: { r: { name: "mat", parent: null, components: { transform: {} } }, m: { name: "m", parent: "r", components: { transform: {}, mesh: { source: { kind: "primitive", shape: "box", size: [1, 0, 1] } } } } } }));
  doc.entities.mat = { name: "mat", parent: null, components: { transform: { position: [3, 1.5, -3] }, prefab: { prefabId: "t/mat" } } };
  const r2 = floatScene(assets, doc as never, null, {}, 0.05), mat = r2.rows.find((q) => q.id === "mat");
  assert.ok(mat && mat.status === "off" && Math.abs(mat.gap - 0.5) < 0.05, `a mat 0.5 m over the deck floats: ${JSON.stringify(mat)}`);
});

test("buried: a SHORT prop with the ground over its middle is buried (o-wild3 2026-11-02: a 0.33 m bone pile 69 % under passed)", () => {
  // flat ground at 10: the field is solid below it
  const field = { floor: (_x: number, _z: number, top: number, bottom: number) => (bottom <= 10 ? Math.min(top, 10) : null) } as any;
  const fp = (y: number) => ({ x: 0, z: 0, y, halfX: 0.4, halfZ: 0.4, height: 0.33 });
  assert.match(String(buriedReason(null, field, fp(9.77))), /buried/, "0.23 of 0.33 m under the ground");
  assert.equal(buriedReason(null, field, fp(9.93)), null, "seated 0.07 m in");
});
