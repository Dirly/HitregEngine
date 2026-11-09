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
 *   picks                   every set's helm and shoulder pieces, and the cross-set lint (identical picks fail,
 *                           a shared base warns)
 *   loot-plan <dungeon> --set <instance-id> [--input <sources.json>] [--bestiary <bestiary.json> --area <poi>]
 *                           plan an instance's loot from the dungeon: its size, difficulty, levels and sources
 *                           (bestiary groups standing in --area as trash, rares there as named, bosses whose
 *                           dungeon is <dungeon>; or a sources fixture). Writes the plan skeleton (named pieces
 *                           per source, TODO names) when absent, lints it when present
 *   retire <id> …           take whole sets out: tiles off the pages (re-baked square), items, icons, sheets,
 *                           briefs, reviews, art; prints the removed item ids (--dry-run lists them)
 *
 * Codex token counts land in authoring/armor-sets/ledger.md. Exit 0 = every stage asked for passed.
 */
import { z } from "zod";
import { armorBriefSchema } from "./armor-codex/schema.mts";
import fs from "node:fs";
import path from "node:path";
import { RUNNERS, STAGES, listBriefs, lintItems, newBrief, readBrief, readPlan, retireSets, paths, stageStatus, type Ctx, type Stage } from "./armor-codex/stages.mts";
import { crossSetLint, piecesOf, sheetWeights } from "./armor-codex/set.mts";
import { lootInputSchema, lootPlanSchema, lootPlanLint, planSkeleton, type LootInput } from "./armor-codex/loot.mts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d = "") => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : d;
};
const VALUE_FLAGS = new Set(["--project", "--redo", "--set", "--input", "--bestiary", "--area", "--zone"]);
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
if (redo.some((r) => !/^(body|female)(:[a-z0-9-]+)?$|^(helm|shoulder)$/.test(r))) usage(`--redo takes body|female|helm|shoulder (an instance: body:<theme>, female:<theme>), got ${redo.join(",")}`);
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

function picks(): boolean {
  const sets = listBriefs(project).map((id) => readBrief(project, id)).map((b) => ({ b, plan: readPlan(project, b) }));
  for (const { b, plan } of sets) {
    console.log(`${b.id} (${b.kind}${b.weight ? ` ${b.weight}` : ""})`);
    for (const slot of ["helm", "shoulders"] as const) {
      const seen = new Map<string, string[]>();
      for (const p of piecesOf(b, plan).filter((x) => x.slot === slot)) {
        const k = `${p.name} [${p.weight}]: ${p.parts.join(" + ")}`;
        seen.set(k, [...(seen.get(k) ?? []), p.rarity]);
      }
      for (const [k, r] of seen) console.log(`  ${slot.padEnd(9)} ${k}  (${r.join(", ")})`);
    }
  }
  const c = crossSetLint(sets);
  for (const p of c.problems) console.log(`  ! ${p}`);
  for (const w of c.warnings) console.log(`  ~ ${w}`);
  console.log(c.problems.length ? `picks: ${c.problems.length} unapproved identical pick(s) across sets` : `picks: no unapproved identical pick across ${sets.length} sets`);
  return !c.problems.length;
}

/** Sources of a dungeon from a zone bestiary: groups standing in `area` = trash, rares there = named, bosses of the dungeon. */
function fromBestiary(file: string, dungeon: string, area: string): LootInput["sources"] {
  const b = JSON.parse(fs.readFileSync(file, "utf8"));
  const out: LootInput["sources"] = [];
  for (const g of b.groups ?? []) if (g.where === area) out.push({ id: g.id, kind: "trash", name: g.name, creatures: [...new Set<string>(g.members.map((m: { creature: string }) => m.creature))], area, story: g.premise ?? "" });
  for (const r of b.rares ?? []) if (r.where === area) out.push({ id: r.id, kind: "named", name: `${r.name}${r.title ? `, ${r.title}` : ""}`, creatures: [r.base], area, story: "" });
  for (const x of b.bosses ?? []) if (x.dungeon === dungeon) out.push({ id: x.id, kind: "boss", name: x.name, creatures: [x.base], area: dungeon, story: x.story ?? "" });
  return out;
}

function lootPlan(dungeon: string): boolean {
  const setId = opt("set") || usage("loot-plan needs --set <instance brief id>");
  const b = readBrief(project, setId);
  if (b.kind !== "instance" || !b.loot) usage(`${setId} is not an instance brief with a loot file`);
  const planFile = path.join(paths(project).authoring, ...b.loot!.split("/"));
  if (fs.existsSync(planFile) && !ctx.force) {
    const plan = lootPlanSchema.parse(JSON.parse(fs.readFileSync(planFile, "utf8")));
    const l = lootPlanLint(plan, sheetWeights(b));
    for (const p of l.problems) console.log(`  ! ${p}`);
    for (const w of l.warnings) console.log(`  ~ ${w}`);
    const ws = ["cloth", "leather", "mail", "plate"].map((w) => `${w} ${plan.pieces.filter((p) => p.weight === w).length}`).join(", ");
    console.log(`loot-plan ${dungeon}: ${plan.pieces.length} pieces from ${plan.sources.length} sources (${ws}); set: ${plan.set ? `${plan.set.name} (${plan.set.rule})` : "none (loose pieces)"}; ${l.problems.length ? `${l.problems.length} problem(s)` : "ok"}`);
    return !l.problems.length;
  }
  let input: LootInput;
  if (opt("input")) input = lootInputSchema.parse(JSON.parse(fs.readFileSync(path.resolve(opt("input")), "utf8")));
  else if (opt("bestiary")) {
    const area = opt("area") || usage("--bestiary needs --area <poi where the dungeon's mobs stand>");
    input = lootInputSchema.parse({ dungeon, zone: opt("zone") || "?", sizeClass: "medium", levelBand: b.levelBand, sources: fromBestiary(path.resolve(opt("bestiary")), dungeon, area), note: `from ${opt("bestiary")} (area ${area}); size class and difficulty defaulted: check them` });
  } else usage("loot-plan needs --input <sources.json> or --bestiary <file> --area <poi>");
  const plan = planSkeleton(input!, b.id, sheetWeights(b));
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), planFile)}: ${plan.pieces.length} pieces over ${plan.sources.length} sources — name every piece, tie its story to its source, pick its parts, then: armor loot-plan ${dungeon} --set ${b.id} --project ${project}`);
  return true;
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
  else if (cmd === "picks") process.exit(picks() ? 0 : 1);
  else if (cmd === "loot-plan") process.exit(lootPlan(rest[0] ?? usage("loot-plan <dungeon> --set <instance-id>")) ? 0 : 1);
  else if (cmd === "retire") {
    if (!rest.length) usage("retire <id> …");
    const r = retireSets(ctx, rest);
    for (const l of r.lines) console.log(l);
    console.log(`removed item ids (${r.removedItems.length}): ${r.removedItems.join(", ")}`);
    process.exit(r.ok ? 0 : 1);
  }
  else usage(`unknown command ${cmd}`);
} catch (e) {
  console.error(`armor: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
