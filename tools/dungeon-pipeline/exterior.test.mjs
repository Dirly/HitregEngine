import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dungeonDoor, dungeonExterior } from "./exterior.mjs";
import { evaluate, standardStages } from "./pipeline.mjs";
import { recordRuling } from "../poi-review/exterior-chain.mjs";

/** projects/wp: a zoned world `w` whose scene holds the portal into `dng` under the place `hold`; projects/dng: the dungeon. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dng-exterior-"));
  const projects = path.join(root, "projects"), wp = path.join(projects, "wp"), dng = path.join(projects, "dng");
  fs.mkdirSync(path.join(wp, "authoring", "zonegen", "w", "zones", "zone-1"), { recursive: true });
  fs.mkdirSync(path.join(wp, "assets", "worlds"), { recursive: true });
  fs.mkdirSync(path.join(wp, "assets", "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dng, "authoring"), { recursive: true });
  fs.writeFileSync(path.join(wp, "authoring", "zonegen", "w", "zones", "zone-1", "reservations.json"), JSON.stringify({ reservations: [{ location: "hold", center: [100, 50], radius: 20, entrance: true }] }));
  fs.writeFileSync(path.join(wp, "assets", "worlds", "w.json"), JSON.stringify({ seed: 1, features: {} }));
  fs.writeFileSync(path.join(wp, "assets", "scenes", "w.scene.json"), JSON.stringify({ entities: {
    "poi-hold": { tags: ["poi:hold"], components: {} },
    "hold-gate": { parent: "poi-hold", components: {} },
    "hold-door": { parent: "hold-gate", components: { script: { name: "portal", params: { scene: "dng", anchor: "entry" } } } },
  } }));
  return { root, wp, dng, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the world door is found from the world scene's portal and its poi tag (or declared)", () => {
  const fx = fixture();
  try {
    const d = dungeonDoor(fx.dng, "dng");
    assert.deepEqual([d.project, d.world, d.poi], ["wp", "w", "hold"]);
    const decl = dungeonDoor(fx.dng, "dng", { world: "w", poi: "other" });
    assert.deepEqual([decl.project, decl.poi, decl.how], ["wp", "other", "declared"]);
    fs.writeFileSync(path.join(fx.wp, "assets", "scenes", "w.scene.json"), JSON.stringify({ entities: {} }));
    assert.equal(dungeonDoor(fx.dng, "dng"), null);
    assert.equal(dungeonExterior(fx.dng, "dng").status, "MISSING", "no door place: the dungeon may not be built");
  } finally { fx.cleanup(); }
});

test("exterior is the first stage, cannot be overridden away, and BLOCKS every later stage until the door's chain is complete", () => {
  const fx = fixture();
  try {
    const stages = standardStages({ id: "dng", override: { exterior: null, scale: null } });
    assert.equal(stages[0].name, "exterior");
    assert.equal(stages.filter((s) => s.name === "exterior").length, 1);
    let rows = evaluate(fx.dng, stages);
    assert.equal(rows[0].status, "MISSING");
    assert.match(rows[0].failures[0], /door place hold .*grab MISSING/);
    assert.match(rows[0].run, /zonegen\.mts concept w --project wp --zone zone-1 --poi hold --renders-only/);
    assert.ok(rows.slice(1).every((r) => r.status === "BLOCKED"), rows.map((r) => `${r.name}:${r.status}`).join(" "));
    recordRuling(fx.wp, "w", "hold", "2026-11-10 coordinator: shipped before the chain", "test", "grandfather");
    rows = evaluate(fx.dng, stages);
    assert.equal(rows[0].status, "ok");
    assert.ok(!rows.slice(1).some((r) => r.status === "BLOCKED"), "unblocked");
  } finally { fx.cleanup(); }
});

test("a dungeon with no door place passes only on its own dated grandfather ruling", () => {
  const fx = fixture();
  try {
    fs.writeFileSync(path.join(fx.wp, "assets", "scenes", "w.scene.json"), JSON.stringify({ entities: {} }));
    fs.writeFileSync(path.join(fx.dng, "authoring", "exterior.json"), JSON.stringify({ grandfather: { ruling: "yes" } }));
    assert.equal(dungeonExterior(fx.dng, "dng").status, "MISSING", "an undated ruling does not count");
    fs.writeFileSync(path.join(fx.dng, "authoring", "exterior.json"), JSON.stringify({ grandfather: { ruling: "2026-11-10 coordinator: shipped with no world door" } }));
    assert.equal(dungeonExterior(fx.dng, "dng").status, "ok");
  } finally { fx.cleanup(); }
});
