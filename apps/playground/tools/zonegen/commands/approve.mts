/**
 * zonegen approve <world> --project <p> --place <id> --stage concept|plan --by derek|coordinator [--ruling "YYYY-MM-DD ..."]
 *
 * Records an APPROVAL in the world's stage file (tools/world-order.mts) with the sha256 of what was approved: the
 * on-site concept sheet (`concept` -> concept-approved) or a town's plan picture (`plan` -> plan-approved, towns only).
 * A repaint / redraw after the approval changes that sha and the approval reads STALE. `--by coordinator` needs a dated
 * ruling (the coordinator approves only under a ruling Derek gave); `--by derek` records that Derek saw it.
 * Refused unless the stage before it (concept-painted / town-design) is ok on the current world.
 * (`--poi <id>` is accepted for --place.)
 */
import path from "node:path";
import { conceptSheet, currentWorldHash, evaluate, fileSha, isDatedRuling, loadStages, nextOf, planPicture, saveStages, short, stagesOf } from "../../world-order.mts";

interface Ctx { project: string; world: string; opt(name: string, fallback?: string): string; flag(name: string): boolean; paths: { projectDir: string } }

export async function run(ctx: Ctx): Promise<number> {
  const projectDir = ctx.paths.projectDir;
  const key = ctx.opt("place") || ctx.opt("poi") || ctx.opt("town"), kind = ctx.opt("stage"), by = ctx.opt("by"), ruling = ctx.opt("ruling");
  if (!key || !["concept", "plan"].includes(kind) || !["derek", "coordinator"].includes(by)) {
    console.error("usage: zonegen approve <world> --project <p> --place <id> --stage concept|plan --by derek|coordinator [--ruling \"YYYY-MM-DD ...\"]");
    return 2;
  }
  if (by === "coordinator" && !isDatedRuling(ruling)) { console.error('zonegen approve: --by coordinator needs --ruling "YYYY-MM-DD <Derek\'s words / the ruling it rests on>"'); return 2; }
  const doc = loadStages(projectDir, ctx.world);
  if (!doc) { console.error(`zonegen approve: ${ctx.world} has no stage file (zonegen stages ${ctx.world} --project ${ctx.project} --roles ...)`); return 2; }
  const p = doc.places.find((x) => x.id === key || x.name === key);
  if (!p) { console.error(`zonegen approve: no place ${key}`); return 2; }
  const stage = kind === "concept" ? "concept-approved" : "plan-approved";
  if (!stagesOf(p).includes(stage)) { console.error(`zonegen approve: a ${p.kind} has no plan approval (towns only)`); return 2; }
  const rows = evaluate(projectDir, doc).places.find((e) => e.place === p)!.rows;
  const before = rows[stagesOf(p).indexOf(stage) - 1]!;
  if (before.state !== "ok") {
    const n = nextOf(rows)!;
    console.error(`approve refused: ${p.id} ${before.stage} is ${before.state}${before.why ? ` (${before.why})` : ""} — nothing current to approve\n  next step: ${n.stage} -> ${n.how}`);
    return 1;
  }
  const file = kind === "concept" ? conceptSheet(projectDir, doc, p) : planPicture(projectDir, p);
  const sha = fileSha(file);
  if (!sha) { console.error(`zonegen approve: ${path.relative(process.cwd(), file)} does not exist`); return 2; }
  const of = p.stages[before.stage]!;
  // concept: the sheet IS the painted stage's evidence; plan: the picture is drawn from the design json, which is what
  // the approval pins (a redesigned plan changes it)
  if (kind === "concept" && of.evidenceSha && of.evidenceSha !== sha) { console.error(`zonegen approve: ${path.relative(process.cwd(), file)} changed since ${before.stage} was recorded — re-record it first`); return 1; }
  const hash = currentWorldHash(projectDir, doc)!;
  p.stages[stage] = { at: new Date().toISOString(), worldHash: hash, by, approves: of.evidenceSha ?? sha, evidence: path.relative(projectDir, file).split(path.sep).join("/"), evidenceSha: sha, ...(ruling ? { ruling } : {}) };
  saveStages(projectDir, doc);
  console.log(`${stage}: ${p.id} by ${by}${ruling ? ` (${ruling})` : ""}, ${path.basename(file)} ${short(sha)} on world ${short(hash)}`);
  return 0;
}
