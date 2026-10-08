/**
 * zonegen bind-check <world> --project <p> --zone <z> [--scene <id>]
 *
 * The gate after `bind` and its writers: runs the existing content lint (tools/town-content-check.mts, unchanged) over
 * every BOUND quest of the zone and the dialogues that carry it, and WRITES the result as a gate report
 * (reports/bind-check.json) so `zonegen status` can show ok / FAILED / STALE.
 *
 * Per zone town, a staging folder gets `quest.<id>.json` for each bound quest whose places table is that town's, plus
 * `dialogue.<id>.json` for every dialogue that offers, hands in or is a step of one (residents and placed entities).
 * town-content-check judges one town at a time, so three of its findings are expected for zone quests and are
 * EXPLAINED here, not hidden: a talk target / giver that is a resident of another zone town or a placed quest entity,
 * and a place id that the quest's zone places table holds. Everything else it prints is an error.
 * Own checks: the writer's text is in (no `[write]` label, a journal description), every place token resolves in the
 * table its step uses, the giver's dialogue carries `acceptQuest` and the turn-in's `turnInQuest`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { placeTokens, questSchema, type Quest } from "@hitreg/core";
import { exists, finish, readJson, type Ctx, type Finding } from "../lib.mts";
import { loadZonePlan, readBindReport, residents, sceneIndex } from "./_zone.mts";
import { isUnwritten } from "./bind.mts";
import { err, requireZone } from "./_shared.mts";

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "bind-check");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const p = ctx.paths;
  const inputs: string[] = [p.report("bind", ctx.zone)];
  const plan = loadZonePlan(ctx, ctx.zone, f);
  const report = readBindReport(ctx, ctx.zone);
  if (!report) err(f, "no-bind", "no bind report: run `zonegen bind` first");
  if (!plan || !report) return finish(ctx, "bind-check", inputs, f);

  const assets = path.join(p.projectDir, "assets");
  const people = residents(ctx);
  const scene = sceneIndex(ctx);
  const entityIds = new Set(plan.graph.entities.map((e) => e.id));
  const dialogueId = (id: string): string => {
    const r = people.get(id);
    if (r) return r.dialogue || `${r.townName}/${id}`;
    const script = scene.entities.get(id)?.components.script as { params?: { dialogue?: string } } | undefined;
    return script?.params?.dialogue ?? "";
  };
  const dialogueFile = (id: string): string => path.join(assets, "dialogues", `${id}.json`);
  const placesTable = (id: string): Set<string> => {
    const file = path.join(assets, "places", `${id}.json`);
    return exists(file) ? new Set(Object.keys((readJson(file) as { places?: object }).places ?? {})) : new Set();
  };

  const bound = report.quests.filter((r) => r.state === "bound");
  const byTown = new Map<string, { quests: Quest[]; dialogues: Set<string> }>();
  for (const row of bound) {
    const file = path.join(assets, "quests", `${row.id}.json`);
    if (!exists(file)) {
      err(f, "asset-missing", `bound quest ${row.id} has no asset (re-run bind)`, row.id);
      continue;
    }
    inputs.push(file);
    const parsed = questSchema.safeParse(readJson(file));
    if (!parsed.success) {
      err(f, "schema", `${row.id}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, row.id);
      continue;
    }
    const q = parsed.data;
    // the writer's text
    if (!q.description.trim()) err(f, "text-unwritten", `${q.id}: no journal description yet (writing task zones/${ctx.zone}/bind/tasks/${q.id}.md)`, q.id);
    const unwritten = q.objectives.filter((o) => isUnwritten(o.label)).map((o) => o.id);
    if (unwritten.length) err(f, "text-unwritten", `${q.id}: ${unwritten.length} objective label(s) not written: ${unwritten.join(", ")}`, q.id);
    // tokens resolve in the table each text uses
    const check = (text: string, table: string, where: string): void => {
      const known = placesTable(table);
      for (const t of placeTokens(text)) if (!known.has(t)) err(f, "unknown-place", `${q.id} ${where}: {…:${t}} is not in places ${table || "(none)"}`, q.id);
    };
    check(`${q.title} ${q.description} ${q.area?.label ?? ""}`, q.places, "text");
    for (const o of q.objectives) check(`${o.label} ${o.area?.label ?? ""}`, o.places || q.places, `objective ${o.id}`);
    // the giver offers it, the turn-in takes it
    const carries = (who: string, action: string): boolean => {
      const id = dialogueId(who);
      const file = id ? dialogueFile(id) : "";
      if (!file || !exists(file)) return false;
      return JSON.stringify(readJson(file)).includes(`"do":"${action}","quest":"${q.id}"`) || new RegExp(`"do":"${action}"[^}]*"quest":"${q.id}"`).test(JSON.stringify(readJson(file)));
    };
    if (q.giver && !carries(q.giver, "acceptQuest")) err(f, "offer-missing", `${q.id}: ${q.giver}'s dialogue (${dialogueId(q.giver) || "none"}) has no acceptQuest for it`, q.id);
    if (q.turnIn && !carries(q.turnIn, "turnInQuest")) err(f, "hand-in-missing", `${q.id}: ${q.turnIn}'s dialogue (${dialogueId(q.turnIn) || "none"}) has no turnInQuest for it`, q.id);

    const town = q.places.split("/").pop() ?? "";
    const slot = byTown.get(town) ?? { quests: [], dialogues: new Set<string>() };
    slot.quests.push(q);
    for (const who of [q.giver, q.turnIn, ...q.objectives.filter((o) => o.kind === "talk" || o.kind === "read").map((o) => o.target)]) {
      const id = who ? dialogueId(who) : "";
      if (id && exists(dialogueFile(id))) slot.dialogues.add(id);
    }
    byTown.set(town, slot);
  }

  // town-content-check, one staging folder per town, its findings classified
  let raw = 0;
  let explained = 0;
  for (const [town, slot] of byTown) {
    if (!exists(p.townDoc(town))) {
      err(f, "no-town-doc", `quests ${slot.quests.map((q) => q.id).join(", ")} use town ${town}, which has no town doc for town-content-check`);
      continue;
    }
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "zonegen-bindcheck-"));
    try {
      for (const q of slot.quests) fs.copyFileSync(path.join(assets, "quests", `${q.id}.json`), path.join(stage, `quest.${q.id}.json`));
      for (const id of slot.dialogues) {
        fs.copyFileSync(dialogueFile(id), path.join(stage, `dialogue.${id.replaceAll("/", "~")}.json`));
        inputs.push(dialogueFile(id));
      }
      const r = spawnSync(process.execPath, ["--import", "tsx", path.join("tools", "town-content-check.mts"), "--project", ctx.project, "--town", town, "--stage", stage], { encoding: "utf8" });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const problems = out.split(/\r?\n/).filter((l) => l.startsWith("  ! ")).map((l) => l.slice(4));
      if (r.status !== 0 && !problems.length) err(f, "content-check", `town-content-check (${town}) failed: ${out.trim().split(/\r?\n/).slice(-2).join(" | ")}`);
      for (const pr of problems) {
        raw++;
        const who = /"([^"]+)" is not a resident/.exec(pr)?.[1];
        const place = /unknown place "([^"]+)"/.exec(pr)?.[1];
        const quest = /^quest\.([^.]+)\.json/.exec(pr)?.[1];
        const q = slot.quests.find((x) => x.id === quest);
        const tables = q ? new Set([q.places, ...q.objectives.map((o) => o.places)].filter(Boolean)) : new Set<string>();
        const inZoneTables = place ? [...tables].some((t) => placesTable(t).has(place)) : false;
        if (who && (people.has(who) || (entityIds.has(who) && scene.entities.has(who)))) {
          explained++;
          f.push({ level: "warn", code: "explained", message: `town-content-check (${town}): ${pr} — ${people.has(who) ? `a resident of ${people.get(who)!.townName}` : "a placed quest entity"}`, ref: quest ?? "" });
        } else if (place && inZoneTables) {
          explained++;
          f.push({ level: "warn", code: "explained", message: `town-content-check (${town}): ${pr} — in the quest's zone places table`, ref: quest ?? "" });
        } else err(f, "content-check", `town-content-check (${town}): ${pr}`, quest);
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  console.log(`bind-check ${ctx.zone}: ${bound.length} bound quest(s) in ${byTown.size} town stage(s); town-content-check raised ${raw}, ${explained} explained by zone data`);
  if (!bound.length) console.log("  (nothing bound yet: the gate passes vacuously and says so)");
  return finish(ctx, "bind-check", [...new Set(inputs)], f);
}

