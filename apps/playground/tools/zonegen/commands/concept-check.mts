/**
 * zonegen concept-check <world> --project <p> --zone <z> --poi <id> [--target <frame>] [--dry-run]
 *
 * The automated CONCEPT CHECK, step 4 of the exterior chain (tools/poi-review/exterior-chain.mjs conceptCheck; Derek
 * 2026-11-10: "I don't need to approve it ... you just need to have the steps in place ... you follow the recipe to a T").
 * No human in the loop: it passes only when
 *   - the place is at its reservation (location),
 *   - its bare render is of the UNEDITED ground and that ground has not moved (grab: `zonegen concept --renders-only`),
 *   - every painted frame <id>-<view>.png is a repaint of one of THOSE renders (concepts: gate 16, `--paint-only`),
 *   - the reviewer sheet <id>-sheet.png exists, is written after every frame, and is the sheet the world order's
 *     concept-painted record names (in a staged world),
 *   - ONE frame is picked as the build target: --target <frame>, else the place design's `conceptTarget`
 *     (<zone>/pois|dungeons/<id>/design.json: a path, or { file, sha256 }).
 * It records { frames: sha256 each, sheet sha256, target sha256, the unedited fingerprint, the edits left out } in
 * projects/<p>/authoring/exterior/<world>.json `checks.<id>` (overwritten in place) and, in a staged world whose
 * concept-painted stage is ok, the world order's concept-approved stage (by "zonegen concept-check"). A repaint, a new
 * sheet or a moved unedited ground makes the record STALE; every exterior build path reads it.
 */
import fs from "node:fs";
import path from "node:path";
// @ts-ignore plain JS engine tool module
import { conceptCheck, exteriorFile, writeConceptCheck } from "../../../../../tools/poi-review/exterior-chain.mjs";
import * as order from "../../world-order.mts";

interface Ctx { project: string; world: string; zone: string; opt(name: string, fallback?: string): string; flag(name: string): boolean; paths: { projectDir: string; zoneDir(z: string): string } }
type J = Record<string, any>;
const tryJson = (f: string): J | null => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) : null; } catch { return null; } };

export async function run(ctx: Ctx): Promise<number> {
  const projectDir = ctx.paths.projectDir, poi = ctx.opt("poi");
  if (!poi) { console.error("usage: zonegen concept-check <world> --project <p> --zone <z> --poi <id> [--target <frame>] [--dry-run]"); return 2; }
  const stages = order.loadStages(projectDir, ctx.world);
  const sp = stages?.places.find((p) => order.matchPlace(p, poi));
  const painted = sp?.stages["concept-painted"];
  const zone = ctx.zone || sp?.zone || "";
  const design = zone ? ["pois", "dungeons"].map((k) => tryJson(path.join(ctx.paths.zoneDir(zone), k, poi, "design.json"))).find(Boolean) ?? null : null;
  const sheetName = `${poi}-sheet.png`;
  const r = conceptCheck({ projectDir, world: ctx.world, placeId: poi, target: ctx.opt("target"), design,
    paintedSheetSha: painted?.evidence && path.basename(painted.evidence) === sheetName ? painted.evidenceSha ?? null : null });
  console.log(`exterior chain of ${poi}:`);
  for (const row of r.chain.rows) console.log(`  ${row.step.padEnd(9)} ${row.state.padEnd(8)} ${row.why}`);
  if (!r.ok) { console.error(`\n${r.error}`); return r.code; }
  if (ctx.flag("dry-run")) { console.log(`\n(dry run) would record:\n${JSON.stringify(r.rec, null, 1)}`); return 0; }
  writeConceptCheck(projectDir, ctx.world, poi, r.rec);
  console.log(`\nconcept-check: ${poi} ok — ${r.frames.length} frame(s), target ${path.basename(r.target)}, unedited ground ${String(r.rec.unedited).slice(0, 10)} (${r.rec.excluded.length} edit(s) left out) -> ${path.relative(process.cwd(), exteriorFile(projectDir, ctx.world))}`);

  // the world order's concept-approved stage, recorded by this check (no human approval: the recipe IS the approval)
  if (stages && sp && order.stagesOf(sp).includes("concept-approved")) {
    const rows = order.evaluate(projectDir, stages).places.find((e) => e.place === sp)!.rows;
    const pr = rows.find((x) => x.stage === "concept-painted")!;
    if (pr.state !== "ok" || !painted) console.log(`  world order: concept-painted is ${pr.state}${pr.why ? ` (${pr.why})` : ""}: concept-approved not recorded (next: ${pr.how})`);
    else {
      const ground = order.groundRecord(projectDir, stages, sp);
      sp.stages["concept-approved"] = { at: r.rec.at, worldHash: order.currentWorldHash(projectDir, stages)!, by: "zonegen concept-check", ...(ground ? { ground } : {}), approves: painted.evidenceSha ?? r.rec.sheet.sha256, evidence: r.rec.sheet.file, evidenceSha: r.rec.sheet.sha256, note: `automated concept check; target ${path.basename(r.target)}` };
      order.saveStages(projectDir, stages);
      console.log("  world order: concept-approved recorded (by zonegen concept-check)");
    }
  }
  return 0;
}
