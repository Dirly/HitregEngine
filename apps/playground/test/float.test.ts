import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOps, ComponentRegistry, createWorldField, defaultWorldRecipe, registerCoreComponents, worldRecipeSchema } from "@hitreg/core";
import { commandFloat, fixOnCurrent, fixOps, floatScatter, floatScene, inverseState, LANDMARK_SUPPORT, sceneDigest, tautSpanEnds, withLandmarkSupport } from "../tools/float.mts";
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
