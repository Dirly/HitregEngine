import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import {
  evaluate, guardWorldWrite, loadStages, nextOf, recordPlaceStage, requirePlaceStage, reviewVerdict, saveStages, worldHash, worldStagesSchema, type WorldStages,
} from "../tools/world-order.mts";
import { run as stagesRun } from "../tools/zonegen/commands/stages.mts";
import { run as approveRun } from "../tools/zonegen/commands/approve.mts";

// 2026-10-29 redstrand: concepts painted before the terrain was final, three world fixes rewrote the ground under them,
// an owner started a design + grey box from a painting Derek had not seen. The stage machine refuses the order break.
let dir = "", projectDir = "";
const W = "fx";
const recipeFile = () => path.join(projectDir, "assets", "worlds", `${W}.json`);
const zoneDir = () => path.join(projectDir, "authoring", "zonegen", W, "zones", "zone-1");
const sheet = () => path.join(zoneDir(), "concept", "dial-sheet.png");
function writeRecipe(extraRoads: unknown[] = []): void {
  const r = worldRecipeSchema.parse({ ...defaultWorldRecipe(), name: W, features: { towns: [{ id: "town-1", center: [0, 0], radius: 40 }], roads: [{ id: "path-a", points: [[0, 0], [100, 0]] }, ...extraRoads] } });
  fs.mkdirSync(path.dirname(recipeFile()), { recursive: true });
  fs.writeFileSync(recipeFile(), JSON.stringify(r));
}
const ctx = (opts: Record<string, string>, flags: string[] = []) => ({
  project: "fx", world: W, zone: opts.zone ?? "",
  opt: (n: string, f = "") => opts[n] ?? f, flag: (n: string) => flags.includes(n), paths: { projectDir },
});
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const e = console.error, l = console.log;
  console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = e; console.log = l; }
};
const rowsOf = (id: string) => evaluate(projectDir, loadStages(projectDir, W)!).places.find((p) => p.place.id === id)!.rows;
const state = (id: string, stage: string) => rowsOf(id).find((r) => r.stage === stage)!;

/** A world sited, status-clean and frozen, with the POI `dial` and the town `town-1`. */
function frozenWorld(): void {
  writeRecipe();
  fs.mkdirSync(zoneDir(), { recursive: true });
  fs.writeFileSync(path.join(zoneDir(), "reservations.json"), JSON.stringify({ reservations: [{ location: "dial", center: [300, 0], radius: 60 }] }));
  const doc: WorldStages = worldStagesSchema.parse({ version: 1, world: W, project: "fx", roles: ["large", "town"], places: [
    { id: "dial", kind: "poi", role: "large", zone: "zone-1", stages: {} },
    { id: "town-1", kind: "town", role: "town", stages: {} },
  ] });
  saveStages(projectDir, doc);
  const hash = worldHash(JSON.parse(fs.readFileSync(recipeFile(), "utf8")), ["dial", "town-1"]);
  const at = new Date(Date.now() - 60_000).toISOString();
  doc.stages["status-clean"] = { at, worldHash: hash };
  doc.places[0]!.stages["sited"] = { at, worldHash: hash, site: { center: [300, 0], radius: 60 } };
  doc.places[1]!.stages["sited"] = { at, worldHash: hash, site: { center: [0, 0], radius: 40 } };
  doc.stages["world-frozen"] = { at, worldHash: hash, by: "test" };
  saveStages(projectDir, doc);
}
/** concept-painted on the dial, as `zonegen concept` records it. */
function painted(bytes = "sheet-1"): void {
  fs.mkdirSync(path.dirname(sheet()), { recursive: true });
  fs.writeFileSync(path.join(zoneDir(), "concept", "dial.site.json"), "{}");
  fs.writeFileSync(sheet(), bytes);
  recordPlaceStage(projectDir, "dial", "bare-renders", { by: "test", evidenceFile: path.join(zoneDir(), "concept", "dial.site.json") }, W);
  recordPlaceStage(projectDir, "dial", "concept-painted", { by: "test", evidenceFile: sheet() }, W);
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "world-order-")); projectDir = path.join(dir, "projects", "fx"); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("world order", () => {
  it("a world without a stages file is not enforced", () => {
    writeRecipe();
    assert.equal(requirePlaceStage(projectDir, "dial", "design-review", "place-build plan"), null);
  });

  it("concept is refused before the world is frozen, and says what to run", () => {
    frozenWorld();
    const doc = loadStages(projectDir, W)!;
    delete doc.stages["world-frozen"];
    saveStages(projectDir, doc);
    const why = requirePlaceStage(projectDir, "dial", "world-frozen", "zonegen concept", W);
    assert.match(why ?? "", /refused/);
    assert.match(why ?? "", /--freeze/);
    assert.equal(state("dial", "bare-renders").state, "BLOCKED");
    assert.equal(state("dial", "bare-renders").blockedBy, "world-frozen");
  });

  it("out-of-order place commands are refused: grey box before design review, install before final review", () => {
    frozenWorld();
    painted();
    assert.match(requirePlaceStage(projectDir, "dial", "design-review", "place-build plan", W) ?? "", /concept-approved/);
    assert.match(requirePlaceStage(projectDir, "dial", "final-review", "place-build install", W) ?? "", /refused/);
    assert.match(requirePlaceStage(projectDir, "town-1", "plan-approved", "worldgen terrace --from-plan", W) ?? "", /bare-renders/);
    assert.match(requirePlaceStage(projectDir, "nowhere", "design-review", "place-build plan", W) ?? "", /no place "nowhere"/);
  });

  it("an agent stage is refused unless the stage before it is ok; a review must say PASS", async () => {
    frozenWorld();
    painted();
    const design = path.join(dir, "design.json");
    fs.writeFileSync(design, "{}");
    assert.equal(await quiet(() => stagesRun(ctx({ done: "design", place: "dial", evidence: design, by: "owner" }))), 1, "design before the concept approval");
    assert.equal(await quiet(() => approveRun(ctx({ place: "dial", stage: "concept", by: "coordinator" }))), 2, "a coordinator approval needs a dated ruling");
    assert.equal(await quiet(() => approveRun(ctx({ place: "dial", stage: "concept", by: "derek" }))), 0);
    assert.equal(await quiet(() => stagesRun(ctx({ done: "design", place: "dial", evidence: design, by: "owner" }))), 0);
    const review = path.join(dir, "review.md");
    fs.writeFileSync(review, "# Design review\n\nVerdict: RETURN — six faults\n");
    assert.equal(reviewVerdict(review), "RETURN");
    assert.equal(await quiet(() => stagesRun(ctx({ done: "design-review", place: "dial", evidence: review, by: "rev" }))), 1);
    fs.writeFileSync(review, "# Design review 3\n\nVerdict: PASS\n");
    assert.equal(await quiet(() => stagesRun(ctx({ done: "design-review", place: "dial", evidence: review, by: "rev" }))), 0);
    assert.equal(requirePlaceStage(projectDir, "dial", "design-review", "place-build plan", W), null);
    // the design edited after its review: the review no longer stands
    fs.writeFileSync(design, '{"changed":true}');
    assert.equal(state("dial", "design").state, "STALE");
    assert.equal(state("dial", "design-review").state, "STALE");
  });

  it("a repaint after approval makes the approval STALE", async () => {
    frozenWorld();
    painted("sheet-1");
    assert.equal(await quiet(() => approveRun(ctx({ place: "dial", stage: "concept", by: "coordinator", ruling: "2026-10-29 Derek: the dial painting is the target" }))), 0);
    assert.equal(state("dial", "concept-approved").state, "ok");
    painted("sheet-2");
    const s = state("dial", "concept-approved");
    assert.equal(s.state, "STALE");
    assert.match(s.why, /repainted|changed/);
  });

  it("a frozen world refuses a world write; --unfreeze with a dated ruling lifts it and marks downstream STALE", async () => {
    frozenWorld();
    painted();
    await quiet(() => approveRun(ctx({ place: "dial", stage: "concept", by: "derek" })));
    const next = JSON.parse(fs.readFileSync(recipeFile(), "utf8"));
    // a place's own build is not a world change
    next.features.roads.push({ id: "road-pb-dial-approach", points: [[300, 0], [200, 0]] }, { id: "town-1-street-a", points: [[0, 0], [10, 0]] });
    next.features.towns[0].radius = 70;
    assert.deepEqual(guardWorldWrite(recipeFile(), next, "", "worldgen road"), { ok: true, message: "" });
    // a world road is
    next.features.roads.push({ id: "path-b", points: [[0, 50], [100, 50]] });
    const refused = guardWorldWrite(recipeFile(), next, "", "worldgen paths");
    assert.equal(refused.ok, false);
    assert.match(refused.message, /FROZEN/);
    assert.equal(guardWorldWrite(recipeFile(), next, "because", "worldgen paths").ok, false, "an undated ruling is refused");
    const lifted = guardWorldWrite(recipeFile(), next, "2026-10-29 coordinator: third road to the dial", "worldgen paths");
    assert.equal(lifted.ok, true);
    assert.match(lifted.message, /dial:concept-approved/);
    fs.writeFileSync(recipeFile(), JSON.stringify(worldRecipeSchema.parse(next)));
    const ev = evaluate(projectDir, loadStages(projectDir, W)!);
    // the world changed, so status-clean is STALE and the re-freeze waits on it
    assert.equal(ev.world.find((s) => s.stage === "status-clean")!.state, "STALE");
    assert.equal(ev.world.find((s) => s.stage === "world-frozen")!.blockedBy, "status-clean");
    for (const st of ["sited", "bare-renders", "concept-painted", "concept-approved"]) assert.equal(state("dial", st).state, "STALE", st);
    assert.equal(loadStages(projectDir, W)!.unfreezes.length, 1);
  });

  it("--next gives the single next allowed action per place", () => {
    frozenWorld();
    painted();
    const n = nextOf(rowsOf("dial"))!;
    assert.equal(n.stage, "concept-approved");
    assert.equal(n.state, "MISSING");
    assert.match(n.how, /zonegen\.mts approve/);
    const t = nextOf(rowsOf("town-1"))!;
    assert.equal(t.stage, "bare-renders");
    assert.match(t.how, /concept .*--town town-1 --renders-only/);
    // a moved reservation un-sites the place
    fs.writeFileSync(path.join(zoneDir(), "reservations.json"), JSON.stringify({ reservations: [{ location: "dial", center: [340, 0], radius: 60 }] }));
    assert.equal(nextOf(rowsOf("dial"))!.stage, "sited");
    assert.match(state("dial", "sited").why, /site moved/);
  });

  it("the town order has town-design and plan-approved before grey-box", () => {
    frozenWorld();
    const stages = rowsOf("town-1").map((r) => r.stage);
    assert.ok(stages.indexOf("design-review") < stages.indexOf("town-design"));
    assert.ok(stages.indexOf("plan-approved") < stages.indexOf("grey-box"));
    assert.ok(!rowsOf("dial").some((r) => r.stage === "plan-approved"));
  });
});
