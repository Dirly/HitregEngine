/**
 * armor — one command makes a whole player armor set (body, the woman's chest, helm, shoulders) through Codex,
 * gates it, bakes it onto the three human pages and cuts it into items (docs/armor-sets.md → One command).
 *
 *   node --import tsx tools/armor.mts <command> [<set-id> …] --project foundation [--force] [--dry-run]
 *
 *   brief new <id>          write projects/<p>/authoring/armor-sets/<id>.json from the schema's template
 *   brief lint <id>         check it (TODOs, ornaments rare+ only, one helm base, the models' `rules`)
 *   brief schema            the brief's JSON Schema (every field described)
 *   gen <id> [--dry-run]    ONE image-request gen-set manifest in the doc's order; existing sheets are skipped
 *                           (--force regenerates all; --redo body|female|helm|shoulder[,…] regenerates those and
 *                           every sheet painted from them); --dry-run prints the manifest, the sessions and every prompt
 *   import <id>             import all four sheets, composite the woman's chest (<id>-f), match-material, measure
 *                           (holes on the body's real UVs, cut-out free edges, texels/m) — fail = nothing installed
 *   bake <id>               body-page + weapon-page (helm, shoulder: every theme on the page) + icons
 *   items <id>              one item per slot per tier into assets/items, icons, items lint
 *   items lint <id>         lint the installed items only
 *   review <id>             bind-pose renders (both sexes, front + back, per tier) + icon strip ->
 *                           authoring/armor-sets/review/<id>.png
 *   run <id>                brief lint -> gen -> import -> bake -> items -> review, stopping at the first failure
 *   queue <id> <id> …       run several sets back to back (one Codex session pair each); a failed set does not stop
 *                           the next
 *   status [<id>]           every stage ok / STALE / MISSING / FAILED, and the next command
 *
 * Codex token counts land in authoring/armor-sets/ledger.md. Exit 0 = every stage asked for passed.
 */
import { z } from "zod";
import { armorBriefSchema } from "./armor-codex/schema.mts";
import { RUNNERS, STAGES, listBriefs, lintItems, newBrief, readBrief, stageStatus, type Ctx, type Stage } from "./armor-codex/stages.mts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d = "") => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : d;
};
const VALUE_FLAGS = new Set(["--project", "--redo"]);
const words = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1] ?? ""));
const [cmd, ...rest] = words;
const project = opt("project");
function usage(msg = ""): never {
  if (msg) console.error(`armor: ${msg}`);
  console.error("usage: armor <brief new|brief lint|brief schema|gen|import|bake|items|items lint|review|run|queue|status> [<set-id> …] --project <p> [--force] [--dry-run]");
  process.exit(2);
}
if (!cmd) usage();
if (cmd !== "brief" || rest[0] !== "schema") if (!project) usage("give --project (foundation)");
const redo = opt("redo").split(",").filter(Boolean);
if (redo.some((r) => !["body", "female", "helm", "shoulder"].includes(r))) usage(`--redo takes body|female|helm|shoulder, got ${redo.join(",")}`);
const ctx: Ctx = { project, force: flag("force"), dryRun: flag("dry-run"), log: (s) => console.log(s), redo };

function runStages(id: string, stages: readonly Stage[]): boolean {
  const b = readBrief(project, id);
  for (const s of stages) {
    console.log(`[${id}] ${s}`);
    const r = RUNNERS[s](ctx, b);
    for (const l of r.lines) console.log(l);
    if (!r.ok) {
      console.log(`[${id}] ${s}: FAILED — stage kept for a retry (armor ${s} ${id} --project ${project}); nothing after it ran`);
      return false;
    }
  }
  return true;
}

function status(ids: string[]): void {
  for (const id of ids) {
    const b = readBrief(project, id);
    const rows = STAGES.map((s) => ({ s, ...stageStatus(project, b, s) }));
    const next = rows.find((r) => r.status !== "ok");
    console.log(`${id}${next ? `  next: armor ${next.s === "brief" ? "brief lint" : next.s} ${id} --project ${project}` : "  done"}`);
    for (const r of rows) console.log(`  ${r.s.padEnd(7)} ${r.status.padEnd(8)} ${r.note}`);
  }
}

try {
  if (cmd === "brief") {
    const [sub, id] = rest;
    if (sub === "schema") console.log(JSON.stringify(z.toJSONSchema(armorBriefSchema, { io: "input" }), null, 2));
    else if (sub === "new" && id) console.log(`wrote ${newBrief(project, id, ctx.force)} — fill every TODO, then: armor brief lint ${id} --project ${project}`);
    else if (sub === "lint" && id) process.exit(runStages(id, ["brief"]) ? 0 : 1);
    else usage();
  } else if (cmd === "items" && rest[0] === "lint") {
    const id = rest[1] ?? usage("items lint <id>");
    const problems = lintItems(project, readBrief(project, id as string));
    for (const p of problems) console.log(`  ! ${p}`);
    console.log(problems.length ? `items lint ${id}: ${problems.length} problem(s)` : `items lint ${id}: ok`);
    process.exit(problems.length ? 1 : 0);
  } else if ((STAGES as readonly string[]).includes(cmd) && cmd !== "brief") {
    const id = rest[0] ?? usage(`${cmd} <set-id>`);
    process.exit(runStages(id as string, [cmd as Stage]) ? 0 : 1);
  } else if (cmd === "run") {
    const id = rest[0] ?? usage("run <set-id>");
    process.exit(runStages(id as string, STAGES) ? 0 : 1);
  } else if (cmd === "queue") {
    if (!rest.length) usage("queue <set-id> …");
    const failed = rest.filter((id) => !runStages(id, STAGES));
    console.log(`queue: ${rest.length - failed.length}/${rest.length} sets done${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
    process.exit(failed.length ? 1 : 0);
  } else if (cmd === "status") status(rest.length ? rest : listBriefs(project));
  else usage(`unknown command ${cmd}`);
} catch (e) {
  console.error(`armor: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
