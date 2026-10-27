import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOps, ComponentRegistry, createScene, dressingPlanSchema, registerCoreComponents, type Op } from "@hitreg/core";
import { planLocations, questAddOp, questDecls, questFindings, questObjectRows, placesFor } from "../tools/_dress-quest.mts";

// a throwaway project: one zone declaring a town object, a town readable and a POI object; one other plan placing the readable
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dress-quest-"));
  const zone = path.join(dir, "authoring", "zonegen", "w", "zones", "z");
  fs.mkdirSync(zone, { recursive: true });
  fs.writeFileSync(path.join(zone, "quests.json"), JSON.stringify({ entities: [
    { id: "parish-strongbox", kind: "object", location: "hagsend", what: "the strongbox" },
    { id: "parish-register", kind: "readable", location: "hagsend", what: "the register" },
    { id: "lych-bell", kind: "object", location: "lych-cairn", what: "the bell on a post" },
  ] }));
  const plans = path.join(dir, "authoring", "dressing", "plans");
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, "hagsend--sheer-kirk.json"), JSON.stringify({ id: "hagsend--sheer-kirk", map: "m", items: [{ id: "reg", prop: "book", place: { kind: "on", item: "shelf" }, quest: { entity: "parish-register" } }] }));
  fs.mkdirSync(path.join(dir, "assets", "places", "zones", "w", "z"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "places", "zones", "w", "z", "hagsend.json"), "{}");
  return dir;
}
const item = (entity: string) => ({ id: "box", prop: "house-interior/box-long-a", place: { kind: "auto", room: "G-1" }, quest: { entity } });

test("building plan: declared town object passes, wrong location refused, object in no plan warned", () => {
  const dir = project();
  const file = path.join(dir, "authoring", "dressing", "plans", "hagsend--reeve-house.json");
  const ok = questFindings(dir, file, dressingPlanSchema.parse({ id: "hagsend--reeve-house", map: "m", items: [item("parish-strongbox")] }), null);
  assert.deepEqual(ok.locations, ["hagsend"]);
  assert.deepEqual(ok.violations, []);
  assert.deepEqual(ok.warnings, []); // the register is placed by the kirk plan
  const bad = questFindings(dir, file, dressingPlanSchema.parse({ id: "hagsend--reeve-house", map: "m", items: [item("lych-bell")] }), null);
  assert.deepEqual(bad.violations.map((v) => v.code), ["quest-wrong-location"]);
  assert.deepEqual(bad.warnings.map((v) => v.code), ["quest-object-unplanned"]); // the strongbox is now in no plan
  const dup = questFindings(dir, file, dressingPlanSchema.parse({ id: "hagsend--reeve-house", map: "m", items: [item("parish-register")] }), null);
  assert.ok(dup.violations.some((v) => v.code === "quest-duplicate"));
});

test("site plan (<poi>--<area>, dress apply --poi) takes the same field through the same path", () => {
  const dir = project();
  assert.deepEqual(planLocations("lych-cairn--core", "lych-cairn"), ["lych-cairn"]);
  const file = path.join(dir, "authoring", "dressing", "plans", "lych-cairn--core.json");
  const r = questFindings(dir, file, dressingPlanSchema.parse({ id: "lych-cairn--core", map: "m", items: [item("lych-bell")] }), "lych-cairn");
  assert.deepEqual(r.violations, []);
  const decl = questDecls(dir).find((d) => d.id === "lych-bell")!;
  const add = { op: "add-entity" as const, id: "dress-lych-cairn--core-box", entity: { name: "box", parent: null, tags: ["dressing", "dress:lych-cairn--core", "poi:lych-cairn"], components: { transform: {}, prefab: { prefabId: "camp-props/bell-post" } } } };
  const op = questAddOp(add, { entity: "lych-bell" }, { decl, planId: "lych-cairn--core", poi: "lych-cairn" });
  assert.equal(op.id, "lych-bell");
  assert.ok(!op.entity.tags.some((t) => t.startsWith("town:")), "a site plan is not a town building");
  assert.ok(op.entity.tags.includes("poi:lych-cairn") && op.entity.tags.includes("zone:z"));
});

test("apply: exact entity id, tags, npc params, static overrides dropped; the inverse removes it", () => {
  const dir = project();
  const decl = questDecls(dir).find((d) => d.id === "parish-strongbox")!;
  const add = {
    op: "add-entity" as const,
    id: "dress-hagsend--reeve-house-box",
    entity: { name: "box", parent: null, tags: ["dressing", "dress:hagsend--reeve-house"], components: { transform: { position: [1, 2, 3] }, prefab: { prefabId: "house-interior/box-long-a", overrides: [{ path: "a/components/mesh/static", value: true }] } } },
  };
  const op = questAddOp(add, { entity: "parish-strongbox" }, { decl, planId: "hagsend--reeve-house", poi: null, places: placesFor(dir, decl.world, decl.zone, "hagsend") });
  assert.equal(op.id, "parish-strongbox");
  for (const t of ["dressing", "dress:hagsend--reeve-house", "quest-object", "interactable", "zone:z", "town:hagsend", "building:reeve-house"]) assert.ok(op.entity.tags.includes(t), t);
  assert.deepEqual(op.entity.components["script"], { name: "npc", params: { name: "Parish strongbox", face: false, radius: 2.5, dialogue: "zones/z/parish-strongbox", places: "zones/w/z/hagsend" } });
  assert.equal((op.entity.components["prefab"] as { overrides?: unknown }).overrides, undefined);
  const reg = new ComponentRegistry();
  registerCoreComponents(reg);
  const { doc, inverse } = applyOps(createScene("t"), [op as Op], reg);
  assert.ok(doc.entities["parish-strongbox"]);
  const rows = questObjectRows(dir, "z", doc, "hagsend");
  assert.deepEqual(rows.map((r) => [r.id, r.placed, r.plan]), [["parish-register", false, "hagsend--sheer-kirk"], ["parish-strongbox", true, ""]]);
  assert.equal(applyOps(doc, inverse, reg).doc.entities["parish-strongbox"], undefined);
});

test("a lab/proof copy with no zones of its own reads the quest objects of the projects it dependsOn", () => {
  const world = project();
  const lab = fs.mkdtempSync(path.join(path.dirname(world), "dress-quest-lab-"));
  fs.writeFileSync(path.join(lab, "project.json"), JSON.stringify({ name: "lab", dependsOn: [path.basename(world)] }));
  assert.deepEqual(questDecls(lab).map((d) => d.id).sort(), ["lych-bell", "parish-register", "parish-strongbox"]);
  assert.equal(questDecls(lab).find((d) => d.id === "parish-strongbox")!.location, "hagsend");
});
