import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultWorldRecipe, worldRecipeSchema } from "@hitreg/core";
import {
  artOf, catalogueDesignFaults, coveringRulings, evaluate, recordRoadTrim, groundRecord, localGround, parseRecipe, rehashGround, guardWorldWrite, stagesOf, loadStages, nextOf, recordPlaceStage, requirePlaceStage, reviewVerdict, saveStages, worldHash, worldStagesSchema, type WorldStages,
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
  doc.places[0]!.stages["sited"] = { at, worldHash: hash, site: { center: [300, 0], radius: 60 }, ground: groundRecord(projectDir, doc, doc.places[0]!) };
  doc.places[1]!.stages["sited"] = { at, worldHash: hash, site: { center: [0, 0], radius: 40 }, ground: groundRecord(projectDir, doc, doc.places[1]!) };
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

  it("a place needs no world freeze: on an unfrozen world its bare renders are the next step; unsited it is refused", () => {
    frozenWorld();
    const doc = loadStages(projectDir, W)!;
    delete doc.stages["world-frozen"];
    saveStages(projectDir, doc);
    assert.equal(requirePlaceStage(projectDir, "dial", "sited", "zonegen concept", W), null);
    assert.equal(state("dial", "bare-renders").state, "MISSING");
    fs.writeFileSync(path.join(zoneDir(), "reservations.json"), JSON.stringify({ reservations: [] }));
    assert.match(requirePlaceStage(projectDir, "dial", "sited", "zonegen concept", W) ?? "", /refused/);
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
    // a coordinator ruling recorded in design.json (size, *Ruling) is bookkeeping: the review still stands (o-small 2026-10-29)
    fs.writeFileSync(design, '{"size":"pinpoint","sizeRuling":"2026-10-29 coordinator: camp scale"}');
    assert.equal(state("dial", "design").state, "ok");
    assert.equal(state("dial", "design-review").state, "ok");
    // L (Red Dial 2026-10-30): `--done design` again on the UNCHANGED design is a no-op: the review still stands
    assert.equal(await quiet(() => stagesRun(ctx({ done: "design", place: "dial", evidence: design, by: "owner" }))), 0);
    assert.equal(state("dial", "design-review").state, "ok", "re-recording the same design must not stale its review");
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
    next.features.roads.push({ id: "path-b", points: [[250, 50], [350, 50]] }); // through the dial's ground
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

  it("local ground: a far write leaves a place ok, a write inside its footprint stales it and names the part", () => {
    frozenWorld();
    const doc = loadStages(projectDir, W)!;
    delete doc.stages["world-frozen"]; // places need no world freeze any more
    saveStages(projectDir, doc);
    painted();
    assert.equal(state("dial", "concept-painted").state, "ok", "painted on an unfrozen world");
    assert.ok(loadStages(projectDir, W)!.places[0]!.stages["concept-painted"]!.ground, "the record carries its local ground");
    const r = JSON.parse(fs.readFileSync(recipeFile(), "utf8"));
    // a far road (2 km off): the world changed, the dial did not
    r.features.roads.push({ id: "path-far", points: [[2000, 2000], [2100, 2000]] });
    assert.deepEqual(guardWorldWrite(recipeFile(), r, "", "worldgen paths"), { ok: true, message: "" });
    fs.writeFileSync(recipeFile(), JSON.stringify(worldRecipeSchema.parse(r)));
    assert.equal(state("dial", "concept-painted").state, "ok", "a far write leaves the place ok");
    // a road through the reservation
    r.features.roads.push({ id: "path-near", points: [[250, -50], [350, 50]] });
    const g = guardWorldWrite(recipeFile(), r, "", "worldgen paths");
    assert.equal(g.ok, true);
    assert.match(g.message, /dial \(.*roads\/path-near new/);
    fs.writeFileSync(recipeFile(), JSON.stringify(worldRecipeSchema.parse(r)));
    const s = state("dial", "concept-painted");
    assert.equal(s.state, "STALE");
    assert.match(s.why, /roads\/path-near new/);
    assert.equal(state("town-1", "sited").state, "ok", "the town 300 m away is untouched");
  });

  // 2026-10-31 redstrand: road-net --fold cut a doubled stretch out of a path under the Red Dial (no regrade) and every stage
  // from bare-renders to design-review went STALE, asking for a Codex repaint of an approved place.
  it("a road TRIM re-checks sited only (gates, then --recheck); the concept stages stay ok; any other change still stales", async () => {
    frozenWorld();
    const r = JSON.parse(fs.readFileSync(recipeFile(), "utf8"));
    r.features.roads.push({ id: "path-dial", points: [[200, 0], [300, 0], [400, 0]] });
    fs.writeFileSync(recipeFile(), JSON.stringify(worldRecipeSchema.parse(r)));
    const doc0 = loadStages(projectDir, W)!;
    delete doc0.stages["world-frozen"];
    doc0.places[0]!.stages["sited"]!.ground = groundRecord(projectDir, doc0, doc0.places[0]!);
    saveStages(projectDir, doc0);
    painted();
    assert.equal(state("dial", "concept-painted").state, "ok");
    // the fold: the path loses its east half, nothing regraded
    r.features.roads.find((x: { id: string }) => x.id === "path-dial").points = [[200, 0], [300, 0]];
    fs.writeFileSync(recipeFile(), JSON.stringify(worldRecipeSchema.parse(r)));
    assert.equal(state("dial", "concept-painted").state, "STALE", "untreated, a trim stales the painting (the fault)");
    const doc = loadStages(projectDir, W)!;
    const parts = recordRoadTrim(doc, parseRecipe(JSON.parse(fs.readFileSync(recipeFile(), "utf8"))), ["path-dial"], "test fold", "test");
    assert.deepEqual(Object.keys(parts), ["roads/path-dial"]);
    saveStages(projectDir, doc);
    const sited = state("dial", "sited");
    assert.equal(sited.state, "STALE");
    assert.match(sited.why, /road-trim.*--recheck/);
    assert.equal(state("dial", "bare-renders").state, "ok", "a trim re-check does not stale the work after it");
    assert.equal(state("dial", "concept-painted").state, "ok", "the painting stands");
    // the gates passed: --recheck re-hashes the covered records and keeps their times
    const at = loadStages(projectDir, W)!.places[0]!.stages["sited"]!.at;
    assert.equal(await quiet(() => stagesRun(ctx({ recheck: "dial", by: "test" }) as never)), 0);
    assert.equal(state("dial", "sited").state, "ok");
    assert.equal(loadStages(projectDir, W)!.places[0]!.stages["sited"]!.at, at, "the record time is kept");
    // a later regrade of the same road is not a trim
    r.features.roads.find((x: { id: string }) => x.id === "path-dial").points = [[200, 0], [300, 10]];
    fs.writeFileSync(recipeFile(), JSON.stringify(worldRecipeSchema.parse(r)));
    assert.equal(state("dial", "concept-painted").state, "STALE", "a different road shape is not covered");
    // a dated coordinator ruling covers it for that place, every stage ok without a re-check
    assert.equal(await quiet(() => stagesRun(ctx({ "ground-ruling": "2026-10-31 coordinator: shoulder only", place: "dial", by: "test" }) as never)), 0);
    assert.equal(state("dial", "concept-painted").state, "ok");
    assert.equal(state("dial", "sited").state, "ok");
    assert.equal(coveringRulings({ groundRulings: [] }, "dial", { a: "1" }, { a: "2" }), null);
    // an owner re-sites at the SAME site after the change: not a redo, the painting stands; a moved site is a redo
    const d2 = loadStages(projectDir, W)!;
    d2.places[0]!.stages["sited"]!.at = new Date(Date.now() + 1000).toISOString();
    saveStages(projectDir, d2);
    assert.equal(state("dial", "bare-renders").state, "ok", "same-site re-site");
    d2.places[0]!.stages["sited"]!.site = { center: [320, 0], radius: 60 };
    saveStages(projectDir, d2);
    assert.equal(state("dial", "bare-renders").state, "STALE", "a moved site is a redo");
  });

  it("local ground: mood, scatter, cover and surfaces never stale a place", () => {
    frozenWorld();
    painted();
    const r = JSON.parse(fs.readFileSync(recipeFile(), "utf8"));
    r.scatter = [...(r.scatter ?? []).slice(1)];
    r.cover = [];
    r.regions = [{ id: "zone-1", name: "Zone", polygon: [[0, 0], [500, 0], [500, 500]], mood: { haze: "#806040", amount: 0.4 } }];
    r.features.clearings = [{ id: "clear-dial", center: [300, 0], radius: 40 }];
    fs.writeFileSync(recipeFile(), JSON.stringify(worldRecipeSchema.parse(r)));
    for (const st of ["sited", "bare-renders", "concept-painted"]) assert.equal(state("dial", st).state, "ok", st);
  });

  it("a catalogue place skips the painting: sited -> bare-renders -> design, and its design may not ask for new art", async () => {
    frozenWorld();
    const doc = loadStages(projectDir, W)!;
    doc.roles.push("small-place");
    doc.places.push({ id: "camp", kind: "poi", role: "small-place", zone: "zone-1", stages: {} });
    saveStages(projectDir, doc);
    fs.writeFileSync(path.join(zoneDir(), "reservations.json"), JSON.stringify({ reservations: [{ location: "dial", center: [300, 0], radius: 60 }, { location: "camp", center: [-300, 0], radius: 30 }] }));
    const p = loadStages(projectDir, W)!.places.find((x) => x.id === "camp")!;
    assert.equal(artOf(p), "catalogue", "small places default to catalogue");
    assert.equal(artOf(loadStages(projectDir, W)!.places[0]!), "painted");
    assert.ok(!stagesOf(p).includes("concept-painted") && !stagesOf(p).includes("concept-approved"));
    assert.equal(await quiet(() => stagesRun(ctx({ site: "camp", kind: "poi", role: "small-place", zone: "zone-1", by: "test" }))), 0);
    fs.mkdirSync(path.join(zoneDir(), "concept"), { recursive: true });
    fs.writeFileSync(path.join(zoneDir(), "concept", "camp.site.json"), "{}");
    recordPlaceStage(projectDir, "camp", "bare-renders", { by: "test", evidenceFile: path.join(zoneDir(), "concept", "camp.site.json") }, W);
    assert.equal(nextOf(rowsOf("camp"))!.stage, "design");
    const design = path.join(dir, "camp-design.json");
    fs.writeFileSync(design, JSON.stringify({ elements: [{ id: "totem", madeOf: ["structure: one Codex landmark piece (prop request camp/totem)"] }] }));
    assert.equal(await quiet(() => stagesRun(ctx({ done: "design", place: "camp", evidence: design, by: "owner" }))), 1, "a Codex request is refused");
    assert.ok(catalogueDesignFaults(JSON.stringify({ propRequests: ["x"] })).length);
    fs.writeFileSync(design, JSON.stringify({ elements: [{ id: "fire", madeOf: ["codex-craft/sun-fire-basin", "foundation/tent-a"] }] }));
    assert.equal(await quiet(() => stagesRun(ctx({ done: "design", place: "camp", evidence: design, by: "owner" }))), 0);
    assert.equal(await quiet(() => approveRun(ctx({ place: "camp", stage: "concept", by: "derek" }))), 2, "nothing to approve");
    assert.equal(await quiet(() => stagesRun(ctx({ art: "painted", place: "camp" }))), 0);
    assert.equal(nextOf(rowsOf("camp"))!.stage, "concept-painted", "switched to painted, the painting is owed");
  });

  it("the town order has town-design and plan-approved before grey-box", () => {
    frozenWorld();
    const stages = rowsOf("town-1").map((r) => r.stage);
    assert.ok(stages.indexOf("design-review") < stages.indexOf("town-design"));
    assert.ok(stages.indexOf("plan-approved") < stages.indexOf("grey-box"));
    assert.ok(!rowsOf("dial").some((r) => r.stage === "plan-approved"));
  });
});

// 2026-10-30 redstrand w13: trimming the first point of a path piece by lake-1 staled red-dial 400 m along the same road.
// A place's local ground holds only the road SEGMENTS whose band (+15 m) reaches its footprint.
describe("localGround: roads count by the segments that reach the place", () => {
  const base = worldRecipeSchema.parse(defaultWorldRecipe());
  const fp = { center: [0, 0] as [number, number], radius: 100, views: [] as [number, number][], corridor: 30 };
  const road = (pts: [number, number][]) => ({ id: "path-a", points: pts, width: 4, shoulder: 3, smooth: 5, surfaceY: pts.map((p) => 10 + p[0] / 100), flatten: 1 });
  const line: [number, number][] = [[600, 0], [500, 0], [400, 0], [300, 0], [200, 0], [100, 0], [50, 0]];
  const with_ = (r: unknown) => parseRecipe({ ...base, features: { ...base.features, roads: [r] } });
  it("an edit 400 m along the road leaves the place's ground hash alone", () => {
    const a = localGround(with_(road(line)), fp), b = localGround(with_(road(line.slice(1))), fp);
    assert.equal(a.hash, b.hash);
  });
  it("an edit inside the reach stales it", () => {
    const moved = line.map((p, i) => (i === line.length - 1 ? [50, 20] : p)) as [number, number][];
    assert.notEqual(localGround(with_(road(line)), fp).hash, localGround(with_(road(moved)), fp).hash);
  });
  it("rehashGround moves a whole-doc record to the segment scheme on the world it was made on", () => {
    const was = with_(road(line));
    const old = localGround(was, fp, [], "doc");
    const doc = { places: [{ id: "p", stages: { sited: { at: "", worldHash: "", ground: { footprint: fp, hash: old.hash, parts: old.parts } } } }] } as unknown as WorldStages;
    const res = rehashGround(doc, was);
    assert.deepEqual(res.rehashed, ["p:sited"]);
    assert.equal((doc.places[0]!.stages as Record<string, { ground: { hash: string } }>).sited!.ground.hash, localGround(with_(road(line.slice(1))), fp).hash);
  });
});

// 2026-10-30 redstrand w15: a scree fan by Rustgut (an operator doc keyed by `from`/`to`, and its rock set keyed by
// `rocks[].at`) had no coordinates the hash knew, so it counted everywhere and staled every place in the world.
describe("localGround: an operator and its rock set count only where they reach", () => {
  const base = worldRecipeSchema.parse(defaultWorldRecipe());
  const fp = { center: [0, 0] as [number, number], radius: 100, views: [] as [number, number][], corridor: 30 };
  const op = (at: [number, number]) => ({ id: "talus-x", op: "scree", from: [[at[0], at[1]], [at[0] + 20, at[1]]], to: [at[0], at[1] - 30], angle: 33 });
  const rocks = (at: [number, number]) => ({ id: "op:talus-x:rocks", rocks: [{ rule: "rock-small", at, yaw: 0, scale: 1 }] });
  const with_ = (o: unknown, r: unknown) => parseRecipe({ ...base, features: { ...base.features, operators: [o], rockSets: [r] } });
  const none = parseRecipe({ ...base, features: { ...base.features, operators: [], rockSets: [] } });
  it("a fan 800 m off leaves the place alone", () => {
    assert.equal(localGround(with_(op([800, 0]), rocks([800, -20])), fp).hash, localGround(none, fp).hash);
  });
  it("a fan beside the place stales it", () => {
    assert.notEqual(localGround(with_(op([60, 0]), rocks([60, -20])), fp).hash, localGround(none, fp).hash);
  });
});

it("place-build --sample builds the design's sample area on `design` alone, lab only (the design-review deadlock)", async () => {
  const { placeBuildGate } = await import("../tools/world-order.mts");
  // normal order: the grey box needs design-review, the install final-review
  assert.equal(placeBuildGate("build").stage, "design-review");
  assert.equal(placeBuildGate("install").stage, "final-review");
  assert.equal(placeBuildGate("install", { dryRun: true }).stage, "");
  // the sample: plan / all / build / shots on `design`, so the review's sample shots can exist before the review
  for (const c of ["plan", "all", "build", "shots"]) assert.equal(placeBuildGate(c, { sample: true }).stage, "design");
  // ... never installed, never live
  assert.match(placeBuildGate("install", { sample: true }).refuse ?? "", /never installs/);
  assert.match(placeBuildGate("gates", { sample: true, live: true }).refuse ?? "", /lab only/);
});

it("place-build --draft builds and installs a place as it is with no review stage; plan / all are refused (i-drafts 2026-11-03)", async () => {
  const { placeBuildGate } = await import("../tools/world-order.mts");
  assert.equal(placeBuildGate("build", { draft: true }).stage, "");
  assert.equal(placeBuildGate("install", { draft: true }).stage, "");
  for (const c of ["plan", "all"]) assert.match(placeBuildGate(c, { draft: true }).refuse ?? "", /AS IT IS/);
  // w-temple5 2026-11-03: plan --draft expands an owner's layout.json as it is; `all` still refused
  assert.deepEqual(placeBuildGate("plan", { draft: true, layout: true }), { stage: "" });
  assert.match(placeBuildGate("all", { draft: true, layout: true }).refuse ?? "", /AS IT IS/);
  assert.match(placeBuildGate("build", { draft: true, sample: true }).refuse ?? "", /do not combine/);
});

it("only a live install moves the job to `installed`; a lab build, a --job copy and an uninstall never do (i-drafts2 2026-11-03)", async () => {
  const { stampsInstalled } = await import("../tools/world-order.mts");
  assert.equal(stampsInstalled({ target: "redstrand", lab: "pb-noon-stone" }), true);
  assert.equal(stampsInstalled({ target: "pb-noon-stone", lab: "pb-noon-stone" }), false); // build / all into the lab
  assert.equal(stampsInstalled({ target: "redstrand", lab: "pb-noon-stone", remove: true }), false);
  assert.equal(stampsInstalled({ target: "redstrand", lab: "pb-noon-stone", dry: true }), false);
  assert.equal(stampsInstalled({ target: "tplace-x", lab: "tplace-x", jobCopy: true }), false);
});

// r-found 2026-10-31: a bare re-render after a road trim re-composed Red Dial's sheet (the concept-painted evidence) and
// STALEd Derek's approved paintings with no way back short of a Codex repaint. `--renders-only` now carries the record
// when the PAINTINGS are the recorded ones: content hashes (a copy or checkout rewrites mtimes), never file times.
describe("paintedCarry: a bare re-render keeps concept-painted only for the recorded paintings", async () => {
  const { paintedCarry } = await import("../tools/world-order.mts");
  const rec = (frames?: Record<string, string>) => ({ at: "2026-10-30T01:18:59.859Z", worldHash: "w", by: "zonegen concept", ...(frames ? { frames } : {}) });
  const now = { "c/dial-approach.png": "aa", "c/dial-far.png": "bb" };
  it("carries when every frame hash matches the record", () => {
    assert.equal(paintedCarry(rec({ ...now }), now).carry, true);
  });
  it("refuses a repainted frame and names it", () => {
    const c = paintedCarry(rec({ ...now, "c/dial-far.png": "old" }), now);
    assert.equal(c.carry, false);
    assert.match(c.why, /dial-far\.png/);
  });
  it("refuses a missing frame, and with no record at all", () => {
    assert.equal(paintedCarry(rec({ ...now }), { ...now, "c/dial-far.png": null }).carry, false);
    assert.equal(paintedCarry(undefined, now).carry, false);
  });
  it("a record from before the hashes carries only on a dated ruling", () => {
    assert.equal(paintedCarry(rec(), now).carry, false);
    assert.match(paintedCarry(rec(), now).why, /--paint-ruling/);
    assert.equal(paintedCarry(rec(), now, "trust me").carry, false);
    assert.equal(paintedCarry(rec(), now, "2026-10-31 coordinator: road trim only, paintings unchanged").carry, true);
  });
  it("the record keeps the frame hashes through the stages schema", () => {
    const doc = worldStagesSchema.parse({ version: 1, world: "fx", project: "p", places: [{ id: "dial", kind: "poi", role: "large-place", stages: { "concept-painted": rec({ ...now }) } }] });
    assert.deepEqual(doc.places[0]!.stages["concept-painted"]!.frames, now);
  });
});
