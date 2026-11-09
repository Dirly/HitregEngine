/**
 * zonegen stages <world> --project <p>  — the world's build ORDER (tools/world-order.mts): a table place x stage with
 * ok / STALE / MISSING / BLOCKED-BY, read from authoring/stages/<world>.json against the current world hash. This is
 * the answer to "what stage is X in": the coordinator reads it and tells Derek what it says, never prose.
 *
 *   stages <world> --project <p> [--next] [--json]          the table; --next = the one next allowed action per place
 *   stages <world> --project <p> --roles a,b,c              start the file / set the siting roles the world must fill
 *   stages <world> --project <p> --site <id> --kind poi|entrance|town --role <r> [--zone z] [--name stem] [--art painted|catalogue] --by <who> [--evidence f] [--note ..]
 *                                                           record a place sited (on the reservation / town centre it has now,
 *                                                           and the LOCAL ground hash of its footprint: no world freeze needed)
 *   stages <world> --project <p> --art painted|catalogue --place <id>   set a place's art mode (catalogue: no painting / approval)
 *   stages <world> --project <p> --done status-clean [--allow row,row --ruling "YYYY-MM-DD ..."]
 *                                                           runs `worldgen status`; records it only when every non-optional row is ok
 *   stages <world> --project <p> --rehash-ground <was.json>   move records hashed with whole road docs to the road-segment scheme, on the recipe they were made on
 *   stages <world> --project <p> --road-trim <id,id> --by <who> [--note ..]   record a road trim (worldgen road-net --fold does it itself):
 *                                                           only TRIM_STAGES (sited, installed) re-check; nothing is redone
 *   stages <world> --project <p> --recheck <place> --by <who>   after seated / float / lips pass: re-hash the trim-covered records (times kept)
 *   stages <world> --project <p> --ground-ruling "YYYY-MM-DD <who>: <why>" --place <id>   accept the place's current ground diff by ruling
 *   stages <world> --project <p> --freeze --by <who>        world-frozen (needs status-clean + siting ok). From here every worldgen
 *                                                           write that changes the world refuses without --unfreeze "<dated ruling>"
 *   stages <world> --project <p> --done <stage> --place <id> --evidence <file> --by <who> [--note ..]
 *                                                           an agent stage (design, design-review, town-design, grey-box,
 *                                                           grey-box-review, detail, final-review, installed, walked); refused
 *                                                           unless the stage before it is ok; a review's evidence must say PASS
 *   stages <world> --project <p> --schema                   the file's JSON Schema
 * Approvals: `zonegen approve`. Concept stages are recorded by `zonegen concept` itself.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import {
  MANUAL_STAGES, REVIEW_STAGES, parseRecipe, rehashGround, recordRoadTrim, recheckTrim, localGround, artOf, catalogueDesignFaults, currentSite, groundRecord, currentWorldHash, evaluate, evidenceSha, fileSha, isDatedRuling, loadStages, nextOf, reviewVerdict, saveStages, short, stagesFile,
  stagesOf, worldStagesSchema, type StageState, type WorldStages,
} from "../../world-order.mts";

interface Ctx { project: string; world: string; zone: string; opt(name: string, fallback?: string): string; flag(name: string): boolean; paths: { projectDir: string } }

const cell = (s: StageState): string => (s.state === "ok" ? "ok" : s.state === "BLOCKED" ? `BLOCKED-BY ${s.blockedBy}` : s.state);

export function table(projectDir: string, doc: WorldStages): string {
  const ev = evaluate(projectDir, doc);
  const out: string[] = [`${doc.world}: world ${ev.worldHash ? short(ev.worldHash) : "MISSING"}  (${path.relative(process.cwd(), stagesFile(projectDir, doc.world))})`];
  out.push("world");
  for (const s of ev.world) out.push(`  ${cell(s).padEnd(26)} ${s.stage.padEnd(17)} ${s.why}`);
  for (const { place, rows } of ev.places) {
    out.push(`${place.id} (${place.kind}, ${place.role}${place.zone ? `, ${place.zone}` : ""}, art ${artOf(place)})`);
    for (const s of rows) out.push(`  ${cell(s).padEnd(26)} ${s.stage.padEnd(17)} ${s.why}`);
  }
  if (doc.unfreezes.length) {
    const u = doc.unfreezes[doc.unfreezes.length - 1]!;
    out.push(`last unfreeze ${u.at}: ${u.ruling} (${u.stale.length} stage(s) went STALE)`);
  }
  return out.join("\n");
}

export function nextLines(projectDir: string, doc: WorldStages): string[] {
  const ev = evaluate(projectDir, doc);
  const lines: string[] = [];
  const w = nextOf(ev.world);
  if (w) lines.push(`world: ${w.stage} [${cell(w)}${w.why ? `: ${w.why}` : ""}] -> ${w.how}`);
  for (const { place, rows } of ev.places) {
    const n = nextOf(rows);
    if (!n) { lines.push(`${place.id}: done (walked)`); continue; }
    // a place stands on its LOCAL ground (tools/world-order.mts localGround): it never waits on the world freeze
    lines.push(`${place.id}: ${n.stage} [${cell(n)}${n.why ? `: ${n.why}` : ""}] -> ${n.how}`);
  }
  return lines;
}

function worldgenStatusFaults(doc: WorldStages): { faults: string[]; error: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join("tools", "worldgen.mts"), "status", doc.world, "--project", doc.project], { encoding: "utf8", maxBuffer: 1 << 24 });
  const faults: string[] = [];
  let rows = 0;
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const m = /^ {2}(ok|STALE|MISSING)\s+(\S+)/.exec(line);
    if (!m) continue;
    rows++;
    if (m[1] !== "ok" && !/\(optional\)\s*$/.test(line)) faults.push(`${m[2]} ${m[1]}${line.includes("—") ? ` —${line.split("—").slice(1).join("—").trimEnd()}` : ""}`);
  }
  return { faults, error: rows ? "" : (r.stderr || r.stdout || "worldgen status printed nothing").trim().split(/\r?\n/)[0]! };
}

export async function run(ctx: Ctx): Promise<number> {
  const projectDir = ctx.paths.projectDir;
  if (ctx.flag("schema")) { console.log(JSON.stringify(z.toJSONSchema(worldStagesSchema, { io: "input" }), null, 2)); return 0; }
  let doc = loadStages(projectDir, ctx.world);
  const by = ctx.opt("by");
  const now = () => new Date().toISOString();

  if (ctx.opt("roles")) {
    doc ??= worldStagesSchema.parse({ version: 1, world: ctx.world, project: ctx.project });
    doc.roles = ctx.opt("roles").split(",").map((s) => s.trim()).filter(Boolean);
    saveStages(projectDir, doc);
    console.log(`roles: ${doc.roles.join(", ")}`);
  }
  if (!doc) { console.error(`zonegen stages: no ${path.relative(process.cwd(), stagesFile(projectDir, ctx.world))} — start it: zonegen stages ${ctx.world} --project ${ctx.project} --roles <role,role,...>`); return 2; }
  const hash = currentWorldHash(projectDir, doc);

  const art = ctx.opt("art");
  if (art && !["painted", "catalogue"].includes(art)) { console.error("zonegen stages: --art painted|catalogue"); return 2; }
  // ---- art mode ----
  if (art && !ctx.opt("site")) {
    const p = doc.places.find((x) => x.id === ctx.opt("place") || x.name === ctx.opt("place"));
    if (!p) { console.error(`zonegen stages --art ${art} --place <id> (sited: ${doc.places.map((x) => x.id).join(", ") || "none"})`); return 2; }
    p.art = art as "painted";
    saveStages(projectDir, doc);
    console.log(`${p.id}: art ${art} (stages: ${stagesOf(p).join(" -> ")})`);
    return 0;
  }
  // ---- sited ----
  if (ctx.opt("site")) {
    const id = ctx.opt("site"), kind = ctx.opt("kind"), role = ctx.opt("role");
    if (!["poi", "entrance", "town"].includes(kind) || !role || !by) { console.error("zonegen stages --site <id> --kind poi|entrance|town --role <role> --by <who> [--zone z] [--name stem]"); return 2; }
    if (!doc.roles.includes(role)) { console.error(`zonegen stages: role ${role} is not one of this world's roles (${doc.roles.join(", ")})`); return 2; }
    if (!hash) { console.error("zonegen stages: no world recipe"); return 2; }
    let p = doc.places.find((x) => x.id === id);
    if (!p) { p = { id, kind: kind as "poi", role, stages: {} }; doc.places.push(p); }
    p.kind = kind as "poi"; p.role = role;
    if (ctx.zone) p.zone = ctx.zone;
    if (ctx.opt("name")) p.name = ctx.opt("name");
    if (art) p.art = art as "painted";
    const site = currentSite(projectDir, doc, p);
    if (!site) { console.error(`zonegen stages: ${id} has no ${kind === "town" ? "town in the recipe" : `reservation in zone ${p.zone ?? "(give --zone)"}`}: reserve / pick it first`); return 2; }
    const ev = ctx.opt("evidence");
    const ground = groundRecord(projectDir, doc, p);
    p.stages["sited"] = { at: now(), worldHash: hash, by, site, ...(ground ? { ground } : {}), ...(ctx.opt("note") ? { note: ctx.opt("note") } : {}), ...(ev ? { evidence: path.relative(projectDir, path.resolve(ev)).split(path.sep).join("/"), evidenceSha: fileSha(path.resolve(ev)) ?? undefined } : {}) };
    saveStages(projectDir, doc);
    console.log(`sited ${id} (${kind}, ${role}, art ${artOf(p)}) at [${site.center}] r ${site.radius} on world ${short(hash)}${ground ? `, local ground ${short(ground.hash)} (${Object.keys(ground.parts).length} parts)` : ""}`);
    return 0;
  }

  // ---- status-clean ----
  if (ctx.opt("done") === "status-clean") {
    if (!hash) { console.error("zonegen stages: no world recipe"); return 2; }
    const { faults, error } = worldgenStatusFaults(doc);
    if (error) { console.error(`zonegen stages: worldgen status failed: ${error}`); return 1; }
    const allow = ctx.opt("allow").split(",").map((s) => s.trim()).filter(Boolean);
    const left = faults.filter((f) => !allow.includes(f.split(" ")[0]!));
    if (allow.length && !isDatedRuling(ctx.opt("ruling"))) { console.error('zonegen stages: --allow needs --ruling "YYYY-MM-DD <who>: <why>"'); return 2; }
    if (left.length) { console.error(`status-clean refused: worldgen status has ${left.length} open row(s):\n${left.map((f) => `  ${f}`).join("\n")}`); return 1; }
    doc.stages["status-clean"] = { at: now(), worldHash: hash, by: by || "zonegen stages", note: allow.length ? `allowed open: ${allow.join(", ")}` : "every non-optional row ok", ...(allow.length ? { ruling: ctx.opt("ruling") } : {}) };
    saveStages(projectDir, doc);
    console.log(`status-clean recorded on world ${short(hash)}`);
    return 0;
  }

  // ---- road trims and ground rulings (tools/world-order.mts groundRulings) ----
  if (ctx.opt("road-trim") || ctx.opt("recheck") || ctx.opt("ground-ruling")) {
    const recipe = parseRecipe(JSON.parse(fs.readFileSync(path.join(projectDir, "assets", "worlds", `${doc.world}.json`), "utf8")));
    if (ctx.opt("road-trim")) {
      if (!by) { console.error("zonegen stages --road-trim <ids> --by <who>"); return 2; }
      const parts = recordRoadTrim(doc, recipe, ctx.opt("road-trim").split(",").map((x) => x.trim()).filter(Boolean), ctx.opt("note") || `road-net --fold ${ctx.opt("road-trim")}`, by);
      saveStages(projectDir, doc);
      console.log(`road trim recorded: ${Object.keys(parts).length} part(s) (${Object.keys(parts).join(", ") || "none moved"})`);
      return 0;
    }
    if (ctx.opt("recheck")) {
      if (!by) { console.error("zonegen stages --recheck <place> --by <who>"); return 2; }
      const done = recheckTrim(doc, recipe, ctx.opt("recheck"));
      saveStages(projectDir, doc);
      console.log(`${ctx.opt("recheck")}: re-hashed ${done.length} trim-covered record(s) (${done.join(", ") || "none"})`);
      return 0;
    }
    const ruling = ctx.opt("ground-ruling"), placeId = ctx.opt("place");
    if (!isDatedRuling(ruling) || !placeId) { console.error('zonegen stages --ground-ruling "YYYY-MM-DD <who>: <why>" --place <id>'); return 2; }
    const p = doc.places.find((x) => x.id === placeId);
    if (!p) { console.error(`no place ${placeId}`); return 2; }
    const parts: Record<string, string[]> = {};
    for (const r of Object.values(p.stages)) {
      if (!r.ground) continue;
      const g = localGround(recipe, r.ground.footprint, doc.places.map((x) => x.id));
      for (const k of Object.keys({ ...r.ground.parts, ...g.parts })) if (r.ground.parts[k] !== g.parts[k]) { const h = g.parts[k] ?? ""; if (!(parts[k] ??= []).includes(h)) parts[k]!.push(h); }
    }
    (doc.groundRulings ??= []).push({ at: now(), ...(by ? { by } : {}), kind: "ruling", ruling, place: placeId, parts });
    saveStages(projectDir, doc);
    console.log(`ground ruling recorded for ${placeId}: ${Object.keys(parts).length} part(s)`);
    return 0;
  }

  // ---- rehash-ground: move records made under the whole-doc road hash to the segment scheme, on the world they were made on ----
  if (ctx.opt("rehash-ground")) {
    const was = parseRecipe(JSON.parse(fs.readFileSync(path.resolve(ctx.opt("rehash-ground")), "utf8")));
    const { rehashed, left } = rehashGround(doc, was);
    saveStages(projectDir, doc);
    console.log(`rehashed ${rehashed.length} record(s) on the given world (${rehashed.join(", ") || "none"}); left ${left.length} that did not match it (${left.join(", ") || "none"})`);
    return 0;
  }

  // ---- freeze ----
  if (ctx.flag("freeze")) {
    if (!by) { console.error("zonegen stages --freeze --by <who>"); return 2; }
    const ev = evaluate(projectDir, doc);
    const bad = ev.world.slice(0, 3).filter((s) => s.state !== "ok");
    if (bad.length) { console.error(`freeze refused: ${bad.map((s) => `${s.stage} is ${cell(s)}${s.why ? ` (${s.why})` : ""}`).join("; ")}\n  do it: ${bad[0]!.how}`); return 1; }
    doc.stages["world-frozen"] = { at: now(), worldHash: hash!, by };
    saveStages(projectDir, doc);
    console.log(`FROZE ${doc.world} on world ${short(hash!)}: worldgen now refuses world changes without --unfreeze "<dated ruling>"`);
    return 0;
  }

  // ---- an agent stage ----
  if (ctx.opt("done")) {
    const stage = ctx.opt("done"), key = ctx.opt("place"), ev = ctx.opt("evidence");
    if (!(MANUAL_STAGES as readonly string[]).includes(stage)) { console.error(`zonegen stages: --done takes status-clean or ${MANUAL_STAGES.join(", ")} (concept stages: zonegen concept; approvals: zonegen approve)`); return 2; }
    if (!key || !ev || !by) { console.error(`zonegen stages --done ${stage} --place <id> --evidence <file> --by <who>`); return 2; }
    const p = doc.places.find((x) => x.id === key || x.name === key);
    if (!p) { console.error(`zonegen stages: no place ${key} (sited: ${doc.places.map((x) => x.id).join(", ") || "none"})`); return 2; }
    const order = stagesOf(p);
    const i = order.indexOf(stage);
    if (i < 0) { console.error(`zonegen stages: a ${p.kind} has no ${stage} stage`); return 2; }
    const rows = evaluate(projectDir, doc).places.find((e) => e.place === p)!.rows;
    const before = rows[i - 1]!;
    if (before.state !== "ok") { const n = nextOf(rows)!; console.error(`${stage} refused for ${p.id}: ${before.stage} is ${cell(before)}${before.why ? ` (${before.why})` : ""}\n  next step: ${n.stage} -> ${n.how}`); return 1; }
    const file = path.resolve(ev);
    if (!fs.existsSync(file)) { console.error(`zonegen stages: no evidence file ${ev}`); return 2; }
    if ((REVIEW_STAGES as readonly string[]).includes(stage)) {
      const v = reviewVerdict(file);
      if (v !== "PASS") { console.error(`${stage} refused: the review ${ev} says ${v ?? "no verdict (PASS / RETURN / FAIL)"} — a RETURN is fixed and reviewed again by a FRESH reviewer`); return 1; }
    }
    if (stage === "design" && artOf(p) === "catalogue") {
      const faults = catalogueDesignFaults(fs.readFileSync(file, "utf8"));
      if (faults.length) { console.error(`design refused for ${p.id}: a catalogue place (no artwork, Derek 2026-10-29) asks for new art — use catalogue props only:\n${faults.slice(0, 12).map((x) => `  ${x}`).join("\n")}`); return 1; }
    }
    // L (Red Dial 2026-10-30: re-recording an unchanged design.json STALEd its design-review): the same evidence recorded
    // again (same bytes, or the same design with only ruling fields changed) is a no-op: the record and its time stay
    // L (o-smalls 2026-10-30: a design gone STALE because the ground moved or bare-renders were redone could never be
    // re-recorded — the unchanged design.json was a no-op — so the place was stuck): the no-op holds only while the record is ok
    const prior = p.stages[stage];
    if (rows[i]?.state === "ok" && prior?.evidenceSha && (prior.evidenceSha === fileSha(file) || prior.evidenceSha === evidenceSha(file))) {
      console.log(`${p.id} ${stage}: evidence unchanged since ${prior.at} — no-op (the stages after it stay as they are)`);
      return 0;
    }
    const ground = groundRecord(projectDir, doc, p);
    p.stages[stage] = { at: now(), worldHash: hash!, by, ...(ground ? { ground } : {}), evidence: path.relative(projectDir, file).split(path.sep).join("/"), evidenceSha: fileSha(file) ?? undefined, ...(ctx.opt("note") ? { note: ctx.opt("note") } : {}) };
    saveStages(projectDir, doc);
    console.log(`recorded ${p.id} ${stage} on world ${short(hash!)}`);
    const n = nextOf(evaluate(projectDir, doc).places.find((e) => e.place.id === p.id)!.rows);
    if (n) console.log(`next: ${n.stage} -> ${n.how}`);
    return 0;
  }

  if (ctx.flag("json")) { console.log(JSON.stringify(evaluate(projectDir, doc), null, 1)); return 0; }
  if (ctx.flag("next")) { console.log(nextLines(projectDir, doc).join("\n")); return 0; }
  console.log(table(projectDir, doc));
  console.log(`\n${nextLines(projectDir, doc).map((l) => `next  ${l}`).join("\n")}`);
  return 0;
}
