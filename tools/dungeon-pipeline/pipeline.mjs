/**
 * The shared dungeon pipeline: one stage runner and the standard stage list, so every dungeon gets every
 * build stage AND every quality gate by default. A project's authoring/pipeline.mjs only names its own paths and
 * commands:
 *
 *   import { runPipeline, standardStages } from "../../../../../tools/dungeon-pipeline/pipeline.mjs";
 *   runPipeline(import.meta.url, standardStages({ id: "my-dungeon", override: { fight: { run: "..." } } }));
 *
 * For every stage: ok / STALE (older than an input, or its `fresh()` says no) / FAILED (its report says it did not
 * pass) / MISSING, and the command that produces it. The first stage not ok is the next to run.
 *
 *   node authoring/pipeline.mjs              the table
 *   node authoring/pipeline.mjs --next       just the next command (`<stage>: <command>`)
 *   node authoring/pipeline.mjs --next --json  the same as JSON, with the gate's failures (zonegen status reads it)
 *
 * Commands marked (pg) run from apps/playground; the rest from the project folder. Quality gates are
 * tools/dungeon-pipeline/quality.mjs (README.md there); their numbers are thresholds.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { GATES, gateInputs, gateReport } from "./quality.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BLENDER = '"P:/Program Files/Blender Foundation/Blender 5.2/blender.exe"';

/** newest mtime of a file, or of any file under a directory; null when absent */
export function mtimeOf(full) {
  if (!fs.existsSync(full)) return null;
  const st = fs.statSync(full);
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else newest = Math.max(newest, fs.statSync(f).mtimeMs); } };
  walk(full);
  return newest || null;
}
const readJson = (full) => { try { return JSON.parse(fs.readFileSync(full, "utf8")); } catch { return null; } };

/**
 * The geometry export reads the plan's SHAPE (spaces, doors, water, rules), not who stands in it. Re-populating or
 * renaming a creature must not ask for a Blender export again, so the export's input is a digest file that only
 * moves when the shape does: authoring/.plan-geometry.json, rewritten when (and only when) the plan's geometry
 * keys change.
 */
export function writePlanGeometry(root, { populationKeys, stamp }) {
  const plan = readJson(path.join(root, "authoring/plan.json"));
  if (!plan) return;
  const shape = Object.fromEntries(Object.entries(plan).filter(([k]) => !populationKeys.includes(k)));
  const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 20);
  // prose (a space's name, any note / about) never changes geometry: renaming a room or writing "unlit" in its note
  // must not ask for a Blender export
  const prose = (v, depth = 0) => Array.isArray(v) ? v.map((x) => prose(x, depth + 1)) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "note" && k !== "about" && !(k === "name" && depth === 2)).map(([k, x]) => [k, prose(x, depth + 1)])) : v;
  const legacy = hash(shape), digest = hash(prose(shape));
  const file = path.join(root, "authoring/.plan-geometry.json");
  const have = readJson(file);
  if (have?.digest === digest) return;
  const before = mtimeOf(file);
  fs.writeFileSync(file, JSON.stringify({ digest, keysLeftOut: populationKeys, proseLeftOut: ["note", "about", "spaces[].name"] }, null, 1) + "\n");
  // the same shape under the older digest (prose still hashed): only the digest rule changed, keep the file's age
  if (have?.digest === legacy && before !== null) { fs.utimesSync(file, new Date(before), new Date(before)); return; }
  // first time: the shape has not changed since the last export (only the population did), so it is not newer than it
  const exp = mtimeOf(path.join(root, stamp));
  if (!have && exp !== null) fs.utimesSync(file, new Date(exp - 1000), new Date(exp - 1000));
}

/** The quality gate stage `name` (tools/dungeon-pipeline/quality.mjs), run from the project folder. */
export function gateStage(name) {
  const g = GATES[name];
  return { name, gate: true, out: `reports/quality/${name}.json`, report: `reports/quality/${name}.json`, inputs: (root) => gateInputs(name, root),
    run: `node ../../../../tools/dungeon-pipeline/quality.mjs ${name}${name === "compare" ? " --build" : ""}`, note: g.note };
}

/**
 * The standard stage list. `id` names the project (projects/<id>/), its stamp (authoring/<id>.mesh-stamp.json) and
 * every (pg) command path. `override` merges fields into a stage by name ({ run, note, inputs, ... }; null drops the
 * stage); `insert` adds project stages ({ after: "<stage>", stage }); `exportInputs` adds builder files to the export.
 */
export function standardStages({ id, blender = BLENDER, exportInputs = [], override = {}, insert = [] }) {
  const pj = `projects/${id}/authoring`;
  const stamp = `authoring/${id}.mesh-stamp.json`;
  const big = "NODE_OPTIONS=--max-old-space-size=8192";
  let stages = [
    { name: "plan", out: "reports/plan-check.json", inputs: ["authoring/plan.json", "authoring/plan-check.mts"], report: "reports/plan-check.json", run: `(pg) npx tsx ${pj}/plan-check.mts`, note: "plan.json (hand-written: spaces, doors, water, portal anchors, route, packs) -> gate + authoring/views/plan.png" },
    { name: "export", out: stamp, inputs: ["authoring/.plan-geometry.json", "authoring/build.py", "authoring/lib", "authoring/noise.json", ...exportInputs], report: "reports/assemble.json",
      run: `${blender} --background --python authoring/build.py -- --export`, note: "every stone a closed solid, one dc_group; closure + cell budget gate; the role-noise table embedded (export_mesh_stamp(noise=...))" },
    gateStage("noise"),
    gateStage("originality"),
    { name: "dc-bake", out: "reports/dc-bake.json", inputs: [stamp], report: "reports/dc-bake.json", run: `(pg) ${big} npx tsx ${pj}/dc-bake.mts --voxel .12`, note: "offline convert -> dual contouring -> meshAudit" },
    { name: "import", out: "reports/import.json", inputs: [stamp], run: "node authoring/import.mjs", note: "the registered Blender to DC tool (hitreg.mesh-dc run.mjs): editable volume, palette, stamp prefab" },
    { name: "merged bake", out: "reports/engine/bake-merged.json", inputs: ["reports/import.json"], check: (j) => j && (j.auditFailures ?? []).length === 0, run: `(pg) ${big} npx tsx ${pj}/bake.mts --force`, note: "exact coplanar merge to GLB, audited both sides (what ships)" },
    { name: "split-floor", out: "reports/split-floor.json", inputs: ["reports/engine/bake-merged.json", "authoring/split-floor.mts"], report: "reports/split-floor.json", run: `(pg) npx tsx ${pj}/split-floor.mts`, note: "floors -> TERRAIN layer, masonry -> WORLD (combat's ground ray, mob steering)" },
    gateStage("stairs"),
    { name: "materials", out: "reports/materials.json", inputs: ["reports/import.json", "authoring/materials.mjs"], report: "reports/materials.json", run: "node authoring/materials.mjs", note: "the dungeon's roles on ONE atlas page at 40 texels/m, nearest; re-run after every import (the tool writes colour only)" },
    gateStage("atlas"),
    gateStage("matte"),
    { name: "dress maps", out: "reports/dress-maps.json", inputs: ["reports/engine/bake-merged.json", "authoring/dress-maps.mjs"], report: "reports/dress-maps.json", run: `(pg) node ${pj}/dress-maps.mjs`, note: "socket maps of every dressable floor; then the dressing plans (props by name, one light bucket)" },
    { name: "scene", out: "reports/scene-build.json", inputs: ["reports/split-floor.json", "reports/materials.json", "reports/dress-maps.json", "authoring/build-scene.mts", "authoring/plan.json"], report: "reports/scene-build.json", run: `(pg) npx tsx ${pj}/build-scene.mts`, note: "applyOps scene + dress check/apply of every plan + the return portal" },
    gateStage("arrival"),
    { name: "portals", out: `reports/portal-cover/${id}.json`, inputs: ["reports/scene-build.json", "authoring/portal-veils.json"], report: `reports/portal-cover/${id}.json`, run: `(pg) npx tsx tools/portal-cover.mts --scene ${id}`, note: "every walk-through portal's trigger and veil cover the measured opening (server colliders, approach-side views); a failure: re-run with --fit (sizes kept in authoring/portal-veils.json)" },
    { name: "lighting", out: "reports/lighting.json", inputs: ["reports/scene-build.json", "../../../../tools/dungeon-pipeline/lighting.json", "authoring/lighting.json"], run: `(pg) npx tsx ../../tools/dungeon-pipeline/lighting.mts --project projects/${id}`, note: "the readability floor: hemisphere fill, fog to the fill tone, exposure/vignette, interior cullingProfile (lighting.json; one applyOps batch, inverse in the report)" },
    gateStage("recipe"),
    gateStage("culling"),
    { name: "walk", out: "reports/walk.json", inputs: ["reports/scene-build.json", "authoring/prove.mts"], report: "reports/walk.json", run: `(pg) npx tsx ${pj}/prove.mts walk`, note: "real server-side player body over the whole route; doorway headroom; wading" },
    { name: "fight", out: "reports/fight.json", inputs: ["reports/scene-build.json", "authoring/prove.mts"], report: "reports/fight.json", run: `(pg) npx tsx ${pj}/prove.mts fight --player-hp 3000`, note: "the packs, the named and the boss hurt the player, die to strikes, drops in the bags" },
    { name: "views", out: "reports/views/sheet.png", inputs: ["reports/scene-build.json", "authoring/views/views.json"],
      run: `(pg) PLAYWRIGHT_MODULE=<playwright index.mjs> node tools/town-shots.mjs --base http://localhost:5403/ --scene ${id} --views ${pj}/views/views.json --out projects/${id}/reports/views  (own vite on 5403)`,
      note: "player-height pictures at the SHIPPED light (reports/views)" },
    gateStage("readability"),
    gateStage("compare"),
    { name: "loading art", out: `assets/loading/${id}.png`, inputs: [], report: "reports/loading-art.json",
      run: `(pg) PLAYWRIGHT_MODULE=<playwright index.mjs> npx tsx tools/loading-art.mts --project ${id} --base <dev server>  [--view <name>]`,
      note: "the portal's loading screen: a views snapshot repainted by the image generator at half display resolution, recorded as the scene's loadingScreen (docs/hosting.md → \"Loading art\"); mark the set-piece view \"loading\": true in views.json" },
    { name: "portal play", out: "reports/portal-play.json", inputs: [`assets/scenes/${id}.scene.json`, "authoring/portal-veils.json"], report: "reports/portal-play.json",
      run: `(pg) HITREG_PLAYWRIGHT=<playwright package dir> npx tsx tools/portal-play.mts --dungeon ${id}  (own vite on 5263; --url <dev app> to reuse one)`,
      note: "LAST CHECK, a real browser client: walk in through the world's door and back out through the return portal, then open the dungeon itself (a reload) and walk out — a player must get in AND out (reports/portal-play/*.png)" },
  ];
  for (const { after, stage } of insert) { const i = stages.findIndex((s) => s.name === after); stages.splice(i < 0 ? stages.length : i + 1, 0, stage); }
  stages = stages.flatMap((s) => (s.name in override ? (override[s.name] === null ? [] : [{ ...s, ...override[s.name] }]) : [s]));
  return stages;
}

/** Evaluate every stage of a project (root = the project folder). */
export function evaluate(root, stages) {
  const full = (rel) => path.resolve(root, rel);
  return stages.map((s) => {
    const inputs = typeof s.inputs === "function" ? s.inputs(root) : s.inputs ?? [];
    const out = mtimeOf(full(s.out));
    const newest = inputs.map((i) => mtimeOf(full(i))).filter((t) => t !== null).sort((a, b) => b - a)[0] ?? null;
    const stale = (out !== null && newest !== null && out < newest) || (out !== null && s.fresh && !s.fresh());
    let failed = false, failures = [];
    if (out !== null && s.report) { const j = readJson(full(s.report)); failed = j?.passed !== true; if (s.gate && j) failures = (j.failures ?? []).map((f) => f.what ?? String(f)); }
    if (out !== null && s.check) failed = !s.check(readJson(full(s.out)));
    const status = out === null ? "MISSING" : failed ? "FAILED" : stale ? "STALE" : "ok";
    return { ...s, inputs, status, out_mtime: out, failures };
  });
}

/** The status command. `metaUrl` is the project pipeline's import.meta.url (authoring/pipeline.mjs). */
export function runPipeline(metaUrl, stages, { argv = process.argv, before } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
  if (before) before(root);
  const rows = evaluate(root, stages);
  const blocking = rows.filter((r) => r.status !== "ok");
  if (argv.includes("--next")) {
    const b = blocking[0];
    if (argv.includes("--json")) {
      console.log(JSON.stringify(b ? { next: { name: b.name, status: b.status, gate: !!b.gate, run: b.run, failures: b.failures.slice(0, 8) } } : { next: null }));
    } else console.log(b ? `${b.name}: ${b.run}` : "every stage is present and current");
    return rows;
  }
  const when = (t) => (t === null ? "" : new Date(t).toISOString().replace("T", " ").slice(0, 16));
  console.log("stage          status   artifact                                        updated");
  console.log("-".repeat(92));
  for (const r of rows) console.log(`${(r.name + (r.gate ? " *" : "")).padEnd(14)} ${r.status.padEnd(8)} ${r.out.padEnd(47)} ${when(r.out_mtime)}`);
  console.log("  (* = quality gate, tools/dungeon-pipeline/quality.mjs; thresholds.json holds the numbers)\n");
  if (!blocking.length) console.log("every stage is present and current.");
  else { console.log(`${blocking.length} stage(s) need running, in order:`); for (const b of blocking) console.log(`  ${b.name.padEnd(14)} ${b.run}`); }
  const failedGates = rows.filter((r) => r.gate && r.status === "FAILED");
  for (const g of failedGates) { console.log(`\n${g.name} FAILED (${g.report}):`); for (const f of g.failures.slice(0, 12)) console.log(`  - ${f}`); if (g.failures.length > 12) console.log(`  ... ${g.failures.length - 12} more`); }
  console.log("\nnotes:");
  for (const r of rows) if (r.note) console.log(`  ${r.name.padEnd(14)} ${r.note}`);
  return rows;
}

export { HERE as PIPELINE_DIR, gateReport };
