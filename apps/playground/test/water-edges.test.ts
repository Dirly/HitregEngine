import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOps, ComponentRegistry, registerCoreComponents, type SceneDoc } from "@hitreg/core";
import { sceneWaterEdges, waterFixOps, isWaterBody, seaHorizon, ensureDarkVeils, darkFinishEntities } from "../tools/water-edges.mts";
import { decodePng } from "../tools/_png.mjs";
import { standardStages } from "../../../tools/dungeon-pipeline/pipeline.mjs";
import { waterEdgesBlock } from "../../../tools/poi-review/job.mjs";

const reg = (): ComponentRegistry => { const r = new ComponentRegistry(); registerCoreComponents(r); return r; };
const box = (pos: [number, number, number], size: [number, number, number]) => ({ name: "rock", parent: null, tags: [], components: { transform: { position: pos }, collider: { shape: "box", size } } });

/** A 10 x 10 basin (floor top at -2, walls to +3) — open on the east for a 2 m channel when `channel` — and a 6 x 6 pool sheet at 0. */
function basin(channel: boolean): SceneDoc {
  const entities: Record<string, unknown> = {
    floor: box([10, -3, 0], [40, 2, 40]),
    west: box([-6, 0, 0], [2, 6, 14]),
    north: box([0, 0, -6], [14, 6, 2]),
    south: box([0, 0, 6], [14, 6, 2]),
    pool: { name: "pool water", parent: null, tags: ["water"], components: { transform: { position: [0, 0, 0] }, mesh: { source: { kind: "primitive", shape: "plane", size: [6, 1, 6] }, material: "x/water" }, water: { depth: 2 } } },
  };
  if (channel) {
    entities["east-n"] = box([6, 0, -3.5], [2, 6, 5]);
    entities["east-s"] = box([6, 0, 3.5], [2, 6, 5]);
    entities["chan-n"] = box([20, 0, -2], [26, 6, 2]);
    entities["chan-s"] = box([20, 0, 2], [26, 6, 2]);
  } else entities["east"] = box([6, 0, 0], [2, 6, 14]);
  return { version: 1, id: "t", name: "t", entities } as unknown as SceneDoc;
}

test("water-edges: a sheet stopping short of its walls is open; --fix re-cuts it to the walls, idempotent", () => {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "we-"));
  const doc = basin(false);
  assert.equal(isWaterBody((doc.entities as any).pool), true);
  const before = sceneWaterEdges(assets, doc, null);
  assert.equal(before.bodies, 1);
  assert.ok(before.rows.length > 0, "the 6 m sheet in a 10 m basin ends in open air");
  const { ops } = waterFixOps(assets, "t", doc, null, { grow: 6 });
  assert.ok(ops.length > 0);
  const next = applyOps(doc, ops as never, reg()).doc;
  assert.equal((next.entities as any).pool.components.mesh.source.kind, "surface");
  assert.deepEqual(sceneWaterEdges(assets, next, null).rows, []);
  assert.equal(waterFixOps(assets, "t", next, null).ops.length, 0, "a second run is a no-op");
});

test("water-edges: a channel running on past its reach gets a dark finish, declared on the water", () => {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "we-"));
  const doc = basin(true);
  const { ops, notes } = waterFixOps(assets, "t", doc, null, { grow: 6 });
  assert.ok(notes.some((n) => /dark finish/.test(n)), notes.join("\n"));
  const next = applyOps(doc, ops as never, reg()).doc;
  const water = (next.entities as any).pool.components.water;
  assert.equal(water.finishes[0].kind, "dark");
  const fid = water.finishes[0].entity;
  assert.ok((next.entities as any)[fid], "the finish entity exists");
  // depth, not a card: veils set back down the open channel, nearest the faintest, the last opaque; water under them
  const ents = next.entities as any;
  const veils = [0, 1, 2].map((k) => ents[`${fid}-veil-${k}`]).concat([ents[fid]]);
  assert.ok(veils.every(Boolean), "four veils");
  const out = water.finishes[0].from[0]; // the channel runs east (+x) past the stretch at x = from
  const xs = veils.map((v: any) => v.components.transform.position[0]);
  assert.ok(xs.every((x: number, i: number) => x > out && (i === 0 || x > xs[i - 1]!)), `veils step back down the channel: ${xs}`);
  assert.ok(xs[3]! - xs[0]! >= 3, `spread over the open run, not stacked at the mouth: ${xs}`);
  const ops2 = veils.map((v: any) => JSON.parse(fs.readFileSync(path.join(assets, "materials", `${v.components.mesh.material}.json`), "utf8")).opacity);
  assert.deepEqual(ops2, [...ops2].sort((a, b) => a - b), "each veil darker than the one before");
  assert.equal(ops2[3], 1);
  assert.equal(ents[`${fid}-water`].components.mesh.material, "x/water", "the water runs on under the veils");
  assert.deepEqual(sceneWaterEdges(assets, next, null).rows, []);
});

test("water-edges: a channel ending in rock just past the light gets a painted depth card, not a flat black one", () => {
  const assets = fs.mkdtempSync(path.join(os.tmpdir(), "we-"));
  const mats = ensureDarkVeils(assets, "t", "#0b0d0d", "#394343");
  const ents = darkFinishEntities("f", "pool", [5, 0], [1, 0], 4, 0, 1.5, () => 4, mats, "x/water");
  assert.deepEqual(Object.keys(ents).sort(), ["f", "f-water"], "one card at a short run, no veils in front of it");
  assert.equal(ents.f.components.mesh.material, "t/water-dark-depth");
  assert.ok(ents.f.components.transform.position[0] > 6, "set back to the run's end, the water running on under it");
  const mat = JSON.parse(fs.readFileSync(path.join(assets, "materials", "t", "water-dark-depth.json"), "utf8"));
  assert.equal(mat.filter, "nearest");
  // the picture: lit wall tone at the rim, black at the vanishing point, in a few hard steps
  const png = decodePng(fs.readFileSync(path.join(assets, "textures", mat.map)));
  const lum = (i: number, j: number): number => png.data[(j * png.width + i) * 4]! + png.data[(j * png.width + i) * 4 + 1]!;
  const c = png.width / 2;
  assert.equal(lum(c, c), 0, "black in the middle");
  assert.ok(lum(0, c) > 40 && lum(c, 0) > 40, "the rim is the wall tone, not black");
  const steps = new Set<number>();
  for (let i = 0; i < c; i++) steps.add(lum(i, c));
  assert.ok(steps.size >= 3 && steps.size <= 6, `banded, not smooth: ${steps.size} steps`);
});

test("water-edges: wired into the dungeon pipeline and poi-review gate 7", () => {
  assert.ok(standardStages({ id: "x" }).some((s: { name: string }) => s.name === "water-edges"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "we-job-"));
  assert.match(waterEdgesBlock(dir)!, /no water-edges gate evidence/);
  fs.mkdirSync(path.join(dir, "reports"));
  fs.writeFileSync(path.join(dir, "reports", "water-edges.json"), JSON.stringify({ ok: true, rows: [] }));
  assert.equal(waterEdgesBlock(dir), null);
});

test("water-edges: only a sea-level body gets the world-edge horizon, and only past the world boundary", () => {
  const field = { recipe: { seaLevel: 0, bounds: { limit: 4900 } }, height: () => -45 } as never;
  const plane = { world: [-5800, 0, -5800, 5800, 0, 5800] };
  const sea = seaHorizon(field, { surfaceY: 0, ...plane })!;
  assert.ok(sea, "the ocean plane at sea level");
  assert.equal(sea(5800, 0), true, "its rim past the 4900 m limit is the horizon");
  assert.equal(sea(3000, 0), false, "an edge inside the world is judged as any other");
  assert.equal(seaHorizon(field, { surfaceY: 12, ...plane }), undefined, "a placed lake above the sea never is");
  assert.equal(seaHorizon(null, { surfaceY: 0, ...plane }), undefined, "nor a dungeon's pool");
});
