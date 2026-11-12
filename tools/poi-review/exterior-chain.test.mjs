import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONCEPT_TOOL, fileSha, uneditedRecipe, uneditedStamp, hasToken } from "./concept-site.mjs";
import { conceptCheck, exteriorChain, exteriorPlaces, exteriorVerdict, exteriorWriteGuard, loadExterior, placeOwnership, recordRuling, requireExterior, writeConceptCheck } from "./exterior-chain.mjs";

const REQUESTS = fs.mkdtempSync(path.join(os.tmpdir(), "exterior-requests-"));
process.env.HITREG_IMAGE_REQUESTS = REQUESTS;
process.on("exit", () => fs.rmSync(REQUESTS, { recursive: true, force: true }));
const NO_ARGV = ["node", "test"];

/** A tiny zoned world `w` with one entrance `hold` at [100, 50]: its need, need patch, operators (pb- and a talus named
 *  for it), landmark, clearings, a road made for it; and world features that are NOT its. */
function world() {
  return {
    seed: 1, terrain: { amp: 40 }, pipeline: {},
    needs: [{ id: "hold-face", kind: "cliff-face", for: "hold", near: [100, 50], solved: { at: [100, 50], patch: "need-hold-face" } }, { id: "far-face", for: "other", near: [900, 900] }],
    features: {
      heightPatches: [
        { id: "need-hold-face", origin: [80, 30], size: [40, 40] },
        { id: "op:talus-hold-apron:fan", origin: [90, 40], size: [10, 10] },
        { id: "op:pb-hold-front:ground", origin: [95, 45], size: [10, 10] },
        { id: "world-bump", origin: [95, 45], size: [5, 5] },
        { id: "x-hold-far", origin: [3000, 3000], size: [5, 5] },
      ],
      operators: [
        { id: "talus-hold-apron", op: "scree", from: [[95, 45]], to: [100, 50], compiled: { pieces: ["heightPatches/op:talus-hold-apron:fan"] } },
        { id: "pb-hold-front", op: "landmark", at: [100, 50], compiled: { pieces: ["heightPatches/op:pb-hold-front:ground", "landmarks/op:pb-hold-front:landmark"] } },
      ],
      landmarks: [{ id: "op:pb-hold-front:landmark", position: [100, 0, 50], radius: 10 }],
      clearings: [
        { id: "camp", owner: "hold", center: [100, 50], radius: 10 },
        { id: "dress-hold-yard-camp", center: [100, 50], radius: 5 },
        { id: "woodland-keep-hold", center: [100, 50], radius: 50, owner: "woodland" },
        { id: "meadow", center: [100, 50], radius: 5 },
      ],
      roads: [{ id: "road-hold-track", points: [[60, 50], [100, 50]] }, { id: "road-main", points: [[0, 0], [200, 0]] }],
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exterior-"));
  const pd = path.join(root, "projects", "wp");
  const zone = path.join(pd, "authoring", "zonegen", "w", "zones", "zone-1");
  fs.mkdirSync(path.join(zone, "concept"), { recursive: true });
  fs.mkdirSync(path.join(pd, "assets", "worlds"), { recursive: true });
  fs.mkdirSync(path.join(pd, "assets", "scenes"), { recursive: true });
  fs.writeFileSync(path.join(zone, "reservations.json"), JSON.stringify({ reservations: [{ location: "hold", center: [100, 50], radius: 20, terrainRadius: 40, entrance: true }, { location: "cart", center: [500, 500], radius: 10 }] }));
  const recipe = world();
  fs.writeFileSync(path.join(pd, "assets", "worlds", "w.json"), JSON.stringify(recipe));
  fs.writeFileSync(path.join(pd, "assets", "scenes", "w.scene.json"), JSON.stringify({ entities: { "poi-hold": { tags: ["poi:hold"], components: {} }, "hold-door": { parent: "poi-hold", components: { script: { name: "portal", params: { scene: "dng" } } } }, tree: { components: {} } } }));
  return { root, pd, zone, recipe, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const place = (fx) => exteriorPlaces(fx.pd, "w").find((p) => p.id === "hold");
const writeRecipe = (fx, r) => fs.writeFileSync(path.join(fx.pd, "assets", "worlds", "w.json"), JSON.stringify(r));

/** What `zonegen concept --renders-only` leaves: the render and a manifest with the unedited stamp. */
function grab(fx, { unedited = true } = {}) {
  const c = path.join(fx.zone, "concept"), render = path.join(c, "hold-approach.site.png");
  fs.writeFileSync(render, `bare ${Date.now()} ${Math.random()}`);
  const recipe = JSON.parse(fs.readFileSync(path.join(fx.pd, "assets", "worlds", "w.json"), "utf8"));
  const own = placeOwnership(recipe, place(fx));
  fs.writeFileSync(path.join(c, "hold.site.json"), JSON.stringify({
    tool: CONCEPT_TOOL, poi: "hold", reservation: { center: [100, 50], radius: 20, terrainRadius: 40 }, worldFile: path.join(fx.pd, "assets", "worlds", "w.json"), ownership: own,
    ...(unedited ? { unedited: uneditedStamp(recipe, { center: [100, 50], radius: 40 }, own) } : {}), renderedAt: new Date().toISOString(),
    renders: { approach: { file: path.basename(render), sha256: fileSha(render) } },
  }));
  return render;
}
/** What `--paint-only` leaves: the frame, its image-request record naming the render, and the reviewer sheet after it. */
function paint(fx, render) {
  const c = path.join(fx.zone, "concept"), frame = path.join(c, "hold-approach.png");
  fs.writeFileSync(frame, `painted ${Math.random()}`);
  fs.writeFileSync(path.join(REQUESTS, `hold-${Date.now()}-${Math.random()}.json`), JSON.stringify({ id: "concept-hold-approach", status: "done", createdAt: new Date().toISOString(), target: frame, refs: [render] }));
  fs.writeFileSync(path.join(c, "hold-sheet.png"), `sheet ${Math.random()}`);
  return frame;
}
const rows = (c) => Object.fromEntries(c.rows.map((r) => [r.step, r.state]));

test("token rule: the place id as a whole token", () => {
  assert.ok(hasToken("talus-rustgut-apron", "rustgut"));
  assert.ok(hasToken("op:pb-red-dial-x:fan", "red-dial"));
  assert.ok(!hasToken("rustguts-yard", "rustgut"));
  assert.ok(!hasToken("red-dialogue", "red-dial"));
});

test("the unedited recipe leaves out every edit of the place and nothing else", () => {
  const fx = fixture();
  try {
    const own = placeOwnership(fx.recipe, place(fx));
    const { recipe, excluded } = uneditedRecipe(fx.recipe, own);
    for (const e of ["needs/hold-face", "heightPatches/need-hold-face", "heightPatches/op:talus-hold-apron:fan", "heightPatches/op:pb-hold-front:ground", "operators/talus-hold-apron", "operators/pb-hold-front",
      "landmarks/op:pb-hold-front:landmark", "clearings/camp", "clearings/dress-hold-yard-camp", "clearings/woodland-keep-hold", "roads/road-hold-track"]) assert.ok(excluded.includes(e), `${e} excluded (${excluded.join(", ")})`);
    for (const k of ["heightPatches/world-bump", "heightPatches/x-hold-far", "clearings/meadow", "roads/road-main", "needs/far-face"]) assert.ok(!excluded.includes(k), `${k} kept`);
    assert.deepEqual(recipe.features.heightPatches.map((p) => p.id), ["world-bump", "x-hold-far"]);
  } finally { fx.cleanup(); }
});

test("the unedited fingerprint: building the place never moves it, a world change under it does", () => {
  const fx = fixture();
  try {
    const own = placeOwnership(fx.recipe, place(fx)), at = { center: [100, 50], radius: 40 };
    const a = uneditedStamp(fx.recipe, at, own).fingerprint;
    const built = world();
    built.needs[0].solved.raised = 62; built.features.heightPatches[0].size = [60, 60]; built.features.clearings[0].radius = 30;
    built.features.operators.push({ id: "pb-hold-back", op: "wall", at: [110, 60], compiled: { pieces: ["heightPatches/op:pb-hold-back:ground"] } });
    built.features.heightPatches.push({ id: "op:pb-hold-back:ground", origin: [100, 50], size: [5, 5] });
    assert.equal(uneditedStamp(built, at, own).fingerprint, a, "the place's own edits never move it");
    const moved = world(); moved.features.heightPatches[3].size = [9, 9];
    assert.notEqual(uneditedStamp(moved, at, own).fingerprint, a, "a world patch under the site moves it");
  } finally { fx.cleanup(); }
});

test("the chain: location -> grab -> concepts -> check, each step refusing until the one before is current", () => {
  const fx = fixture();
  try {
    let c = exteriorChain(fx.pd, "w", "hold", { playground: fx.root });
    assert.deepEqual(rows(c), { location: "ok", grab: "MISSING", concepts: "BLOCKED", check: "BLOCKED" });
    assert.match(c.next.how, /zonegen\.mts concept w --project wp --zone zone-1 --poi hold --renders-only/);
    grab(fx, { unedited: false });
    c = exteriorChain(fx.pd, "w", "hold", { playground: fx.root });
    assert.equal(rows(c).grab, "STALE"); assert.match(c.next.why, /before the unedited-ground rule/);
    const render = grab(fx);
    c = exteriorChain(fx.pd, "w", "hold", { playground: fx.root });
    assert.deepEqual(rows(c), { location: "ok", grab: "ok", concepts: "MISSING", check: "BLOCKED" });
    const frame = paint(fx, render);
    c = exteriorChain(fx.pd, "w", "hold", { playground: fx.root });
    assert.deepEqual(rows(c), { location: "ok", grab: "ok", concepts: "ok", check: "MISSING" });
    assert.equal(exteriorVerdict(fx.pd, "w", "hold", { playground: fx.root }).ok, false);
    // the concept check: a target is required, then recorded
    assert.equal(conceptCheck({ projectDir: fx.pd, world: "w", placeId: "hold", playground: fx.root }).code, 2);
    const r = conceptCheck({ projectDir: fx.pd, world: "w", placeId: "hold", target: frame, playground: fx.root });
    assert.ok(r.ok, r.error);
    writeConceptCheck(fx.pd, "w", "hold", r.rec);
    c = exteriorChain(fx.pd, "w", "hold", { playground: fx.root });
    assert.ok(c.ok, JSON.stringify(c.rows));
    // building the place keeps it ok; a repaint stales the check; a world change stales the grab
    const built = world(); built.features.clearings[0].radius = 30; built.needs[0].solved.raised = 70; writeRecipe(fx, built);
    assert.ok(exteriorChain(fx.pd, "w", "hold", { playground: fx.root }).ok, "the place's own build does not stale its chain");
    fs.writeFileSync(frame, "repainted");
    c = exteriorChain(fx.pd, "w", "hold", { playground: fx.root });
    assert.equal(rows(c).check, "STALE", "a frame overwritten after the check");
    const moved = world(); moved.features.heightPatches[3].size = [9, 9]; writeRecipe(fx, moved);
    assert.equal(rows(exteriorChain(fx.pd, "w", "hold", { playground: fx.root })).grab, "STALE");
  } finally { fx.cleanup(); }
});

test("a repainted frame after the check stales the check, not the concepts", () => {
  const fx = fixture();
  try {
    const render = grab(fx), frame = paint(fx, render);
    writeConceptCheck(fx.pd, "w", "hold", conceptCheck({ projectDir: fx.pd, world: "w", placeId: "hold", target: frame, playground: fx.root }).rec);
    paint(fx, render); // a new painting from the same grab
    const c = exteriorChain(fx.pd, "w", "hold", { playground: fx.root });
    assert.deepEqual(rows(c), { location: "ok", grab: "ok", concepts: "ok", check: "STALE" });
    assert.match(c.next.why, /repainted since the check/);
  } finally { fx.cleanup(); }
});

test("requireExterior: refusal names the step and command; a dated owner ruling passes and is recorded; grandfather passes", () => {
  const fx = fixture();
  try {
    const why = requireExterior({ projectDir: fx.pd, world: "w", place: "hold", command: "worldgen needs --only hold-face", argv: NO_ARGV, env: {} });
    assert.match(why, /worldgen needs --only hold-face refused/);
    assert.match(why, /missing step: grab \[MISSING/);
    assert.match(why, /do it: .*--renders-only/);
    assert.match(requireExterior({ projectDir: fx.pd, world: "w", place: "hold", command: "x", argv: [...NO_ARGV, "--no-concept-ruling", "yes"], env: {} }), /needs a dated owner ruling/);
    assert.equal(requireExterior({ projectDir: fx.pd, world: "w", place: "hold", command: "x", argv: [...NO_ARGV, "--no-concept-ruling", "2026-11-10 Derek: build the door as it is"], env: {} }), null);
    assert.equal(loadExterior(fx.pd, "w").rulings.at(-1).kind, "no-concept");
    assert.equal(requireExterior({ projectDir: fx.pd, world: "w", place: "cart", command: "x", argv: NO_ARGV, env: {} }), null, "a non-entrance unstaged reservation is not enforced");
    recordRuling(fx.pd, "w", "hold", "2026-11-10 coordinator: shipped before the chain", "test", "grandfather");
    assert.equal(requireExterior({ projectDir: fx.pd, world: "w", place: "hold", command: "x", argv: NO_ARGV, env: {} }), null);
  } finally { fx.cleanup(); }
});

test("the write guard: a world write adding or changing the place's own items is refused; removals and other items pass", () => {
  const fx = fixture();
  try {
    const wf = path.join(fx.pd, "assets", "worlds", "w.json"), sf = path.join(fx.pd, "assets", "scenes", "w.scene.json");
    const before = world(), g = (b, a, f = wf) => exteriorWriteGuard(f, b, a, { argv: NO_ARGV, env: {}, label: "test" });
    const need = world(); need.needs[0].solved.raised = 9;
    assert.match(g(before, need), /hold in w is not ready/, "re-solving the place's need");
    const op = world(); op.features.landmarks[0].radius = 12;
    assert.match(g(before, op), /not ready/, "its landmark piece");
    const clr = world(); clr.features.clearings.push({ id: "dress-hold-gate-camp", center: [100, 50], radius: 4 });
    assert.match(g(before, clr), /not ready/, "a dressing clearing");
    const other = world(); other.features.clearings[3].radius = 9;
    assert.equal(g(before, other), null, "an item that is not the place's");
    const gone = world(); gone.features.clearings = gone.features.clearings.filter((c) => c.id !== "camp");
    assert.equal(g(before, gone), null, "a removal builds nothing");
    const s0 = JSON.parse(fs.readFileSync(sf, "utf8"));
    const s1 = JSON.parse(JSON.stringify(s0)); s1.entities["veil"] = { parent: "hold-door", components: {} };
    assert.match(g(s0, s1, sf), /not ready/, "an entity under the place's tagged root");
    const s2 = JSON.parse(JSON.stringify(s0)); s2.entities.tree.name = "oak";
    assert.equal(g(s0, s2, sf), null);
    assert.equal(exteriorWriteGuard(sf, s0, s1, { argv: [...NO_ARGV, "--no-concept-ruling", "2026-11-10 Derek: put the veil up"], env: {}, label: "test" }), null, "an owner ruling");
  } finally { fx.cleanup(); }
});
