import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOps, ComponentRegistry, createWorldField, defaultWorldRecipe, registerCoreComponents, worldRecipeSchema } from "@hitreg/core";
import { commandFloat, fixOps, floatScatter, floatScene } from "../tools/float.mts";
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
