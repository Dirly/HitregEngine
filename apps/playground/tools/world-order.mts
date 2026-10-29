/**
 * WORLD ORDER — one ordered stage machine per world, enforced by the tools that do the work (2026-10-29).
 *
 * Why (Derek, 2026-10-29: "we need to make a step checker so shit is done in order"): on redstrand the coordinator
 * painted concepts before the terrain was final and then let three world fixes rewrite the ground under them, started a
 * place owner on a design + grey box from a painting Derek had not seen on ground that then changed, and reported a grey
 * box as under way when it was not. Every tool had its own gate; nothing enforced the ORDER across the run.
 *
 * The record lives in the world's project: `projects/<p>/authoring/stages/<world>.json` (`worldStagesSchema`). Each
 * stage record carries the time it was done and the WORLD HASH it was done on (`worldHash`: the recipe with the stage
 * stamps, zone moods and every place's own build features left out, so building a place never moves it, and any
 * world-generation write does). State is computed, never stored:
 *   ok        recorded, on the current world hash, its evidence file unchanged, its previous stage ok and older
 *   STALE     recorded, but one of those no longer holds (the reason says which)
 *   MISSING   not recorded and everything before it is ok: this is the next action
 *   BLOCKED   not recorded and something before it is not ok (BLOCKED-BY <that stage>)
 *
 * World: generate -> status-clean -> siting (every declared role has a sited place) -> world-frozen.
 * Place: sited -> bare-renders -> concept-painted -> concept-approved -> design -> design-review -> [town: town-design ->
 *   plan-approved ->] grey-box -> grey-box-review -> detail -> final-review -> installed -> walked.
 * bare-renders also needs world-frozen. A world without a stages file is not enforced (older worlds, test fixtures).
 *
 * Enforcement (each a small hook in the real command): `zonegen concept` (world-frozen + sited), `place-build
 * plan/build` (design-review), `town-design propose` (design-review), `worldgen terrace --from-plan` and `town-layout`
 * (plan-approved), `place-build install` / `town-install` (final-review); every worldgen recipe write refuses to change
 * the world hash of a frozen world unless `--unfreeze "<dated ruling>"`, which un-freezes, logs the ruling and names
 * every place stage that went STALE. Status / marks / approvals: `zonegen stages` and `zonegen approve`.
 * Plain data + node:fs; the world recipe schema from @hitreg/core.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { worldRecipeSchema } from "@hitreg/core";

// ------------------------------------------------------------------ the stages

export const WORLD_STAGES = ["generate", "status-clean", "siting", "world-frozen"] as const;
export type WorldStage = (typeof WORLD_STAGES)[number];
export const POI_STAGES = ["sited", "bare-renders", "concept-painted", "concept-approved", "design", "design-review", "grey-box", "grey-box-review", "detail", "final-review", "installed", "walked"] as const;
export const TOWN_STAGES = ["sited", "bare-renders", "concept-painted", "concept-approved", "design", "design-review", "town-design", "plan-approved", "grey-box", "grey-box-review", "detail", "final-review", "installed", "walked"] as const;
export type PlaceStage = (typeof TOWN_STAGES)[number];
export const PLACE_STAGE_NAMES = TOWN_STAGES as readonly string[];
/** Stages an agent's evidence file records (`zonegen stages --done <stage> --place <id> --evidence <file>`). */
export const MANUAL_STAGES = ["design", "design-review", "town-design", "grey-box", "grey-box-review", "detail", "final-review", "installed", "walked"] as const;
/** Stages whose evidence must say PASS (a fresh reviewer's verdict). */
export const REVIEW_STAGES = ["design-review", "grey-box-review", "final-review"] as const;
/** Approval stages (`zonegen approve`) and the stage whose evidence they approve. */
export const APPROVALS = { "concept-approved": "concept-painted", "plan-approved": "town-design" } as const;

const stageRecordSchema = z.object({
  at: z.string().describe("ISO time the stage was recorded."),
  worldHash: z.string().describe("worldHash() of the world recipe when the stage was done. `backfill:unknown` = done before the stage machine existed, on a world nobody hashed (reads STALE)."),
  by: z.string().optional().describe("Who did it: the tool (`zonegen concept`), an agent name, `derek`, or `coordinator`."),
  evidence: z.string().optional().describe("The file that proves the stage, relative to the project dir (a concept sheet, a review, a design). Changed later = the stage is STALE."),
  evidenceSha: z.string().optional().describe("sha256 of the evidence file when recorded."),
  approves: z.string().optional().describe("Approvals only: sha256 of the sheet / plan picture that was approved; a repaint after approval makes the approval STALE."),
  ruling: z.string().optional().describe("A dated ruling (YYYY-MM-DD ...) — required for a coordinator approval, an unfreeze, or a status-clean allowance."),
  site: z.object({ center: z.tuple([z.number(), z.number()]), radius: z.number() }).optional().describe("`sited` only: the reservation (POI) or town centre + radius it was sited at; moved = STALE."),
  note: z.string().optional().describe("Free text: what was done, what was allowed."),
});
export type StageRecord = z.infer<typeof stageRecordSchema>;

const placeSchema = z.object({
  id: z.string().describe("The place id: a reservation `location` (POI, entrance) or a recipe town id (town)."),
  kind: z.enum(["poi", "entrance", "town"]).describe("town adds the town-design + plan-approved stages before grey-box."),
  role: z.string().describe("The siting role it fills (one of the world's `roles`)."),
  zone: z.string().optional().describe("The zone (reservations live per zone). Towns may omit it."),
  name: z.string().optional().describe("Other names commands use for it: a town's file stem (authoring/towns/<name>-*.json), a concept id."),
  stages: z.record(z.string(), stageRecordSchema).default({}).describe("Recorded stages by name (the order is fixed by kind)."),
});
export type Place = z.infer<typeof placeSchema>;

export const worldStagesSchema = z.object({
  version: z.literal(1),
  world: z.string(),
  project: z.string(),
  roles: z.array(z.string()).default([]).describe("The siting roles this world must fill before `siting` is ok (e.g. walled-town, large-place, small-place, grand-entrance)."),
  stages: z.record(z.string(), stageRecordSchema).default({}).describe("World stages: status-clean and world-frozen are recorded; generate and siting are computed."),
  places: z.array(placeSchema).default([]),
  unfreezes: z.array(z.object({ at: z.string(), ruling: z.string(), from: z.string(), to: z.string(), command: z.string(), stale: z.array(z.string()) })).default([])
    .describe("Every unfreeze: the dated ruling, the world hash before / after and the place stages it made STALE."),
}).describe("authoring/stages/<world>.json — the order of a world's build (tools/world-order.mts).");
export type WorldStages = z.infer<typeof worldStagesSchema>;

// ------------------------------------------------------------------ files

type J = Record<string, any>;
const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
export const short = (h: string): string => (h.startsWith("backfill") ? h : h.slice(0, 10));
const readJson = (f: string): J => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
export const stagesFile = (projectDir: string, world: string): string => path.join(projectDir, "authoring", "stages", `${world}.json`);
export const recipeFile = (projectDir: string, world: string): string => path.join(projectDir, "assets", "worlds", `${world}.json`);
export const fileSha = (f: string): string | null => (fs.existsSync(f) ? sha256(fs.readFileSync(f)) : null);

export function loadStages(projectDir: string, world: string): WorldStages | null {
  const f = stagesFile(projectDir, world);
  return fs.existsSync(f) ? worldStagesSchema.parse(readJson(f)) : null;
}
export function saveStages(projectDir: string, doc: WorldStages): void {
  const f = stagesFile(projectDir, doc.world);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // overwritten in place (git is the history)
  fs.writeFileSync(f, JSON.stringify(worldStagesSchema.parse(doc), null, 1) + "\n");
}
/** Every world of a project that has a stages file. */
export function stagedWorlds(projectDir: string): string[] {
  const dir = path.join(projectDir, "authoring", "stages");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
}
export const stagesOf = (p: Pick<Place, "kind">): readonly string[] => (p.kind === "town" ? TOWN_STAGES : POI_STAGES);
export const matchPlace = (p: Place, key: string): boolean => p.id === key || p.name === key;

// ------------------------------------------------------------------ the world hash

const PLACE_PREFIXES = ["pb-", "op:pb-", "road-pb-", "bridge-road-pb-"];
/** Is a recipe feature a place's own build (never the world)? */
export function placeOwned(f: J, placeIds: ReadonlySet<string>, townIds: ReadonlySet<string>): boolean {
  if (!f || typeof f !== "object") return false;
  for (const k of ["owner", "poi"]) if (typeof f[k] === "string" && (placeIds.has(f[k]) || townIds.has(f[k]))) return true;
  const id = typeof f.id === "string" ? f.id : "";
  if (!id) return false;
  if (PLACE_PREFIXES.some((p) => id.startsWith(p))) return true;
  for (const t of townIds) if (id.startsWith(`${t}-`) || id === `town-plan-${t}`) return true;
  for (const p of placeIds) if (id === p || id.startsWith(`${p}-`) || id.startsWith(`pb-${p}-`)) return true;
  return false;
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => (v as J)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable((v as J)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
/**
 * The world's own content: the parsed recipe without its stage stamps (`pipeline`), zone moods, and every place's own
 * build (features owned by a registered place or any town: pb-/op:pb-/road-pb- ids, `<town>-` ids, `town-plan-<town>`,
 * `owner`); a town entry counts only for {id, tier, siteRole, center} (its radius, terraces, gates and flatten are the
 * town's build). Parsed first so a re-saved file with defaults filled in hashes the same.
 */
export function worldHash(recipeRaw: unknown, placeIds: Iterable<string> = []): string {
  const r = worldRecipeSchema.parse(recipeRaw) as J;
  const towns = ((r.features?.towns ?? []) as J[]).map((t) => String(t.id));
  const own = new Set(placeIds), townIds = new Set(towns);
  const features: J = {};
  for (const [k, list] of Object.entries((r.features ?? {}) as J)) {
    if (!Array.isArray(list)) { features[k] = list; continue; }
    features[k] = k === "towns" ? list.map((t: J) => ({ id: t.id, tier: t.tier, siteRole: t.siteRole, center: t.center })) : list.filter((f: J) => !placeOwned(f, own, townIds));
  }
  const regions = ((r.regions ?? []) as J[]).map(({ mood: _mood, ...rest }) => rest);
  const { pipeline: _p, features: _f, regions: _r, ...rest } = r;
  return sha256(stable({ ...rest, regions, features }));
}
export function currentWorldHash(projectDir: string, doc: WorldStages): string | null {
  const f = recipeFile(projectDir, doc.world);
  return fs.existsSync(f) ? worldHash(readJson(f), doc.places.map((p) => p.id)) : null;
}

// ------------------------------------------------------------------ state

export type StateName = "ok" | "STALE" | "MISSING" | "BLOCKED";
export interface StageState { stage: string; state: StateName; why: string; blockedBy?: string; how: string }
export interface Eval { worldHash: string | null; world: StageState[]; places: { place: Place; rows: StageState[] }[] }

/** The site a place stands on now: its reservation (POI) or its recipe town entry. */
export function currentSite(projectDir: string, doc: WorldStages, p: Place): { center: [number, number]; radius: number } | null {
  if (p.kind === "town") {
    const rf = recipeFile(projectDir, doc.world);
    if (!fs.existsSync(rf)) return null;
    const t = ((readJson(rf).features?.towns ?? []) as J[]).find((x) => x.id === p.id);
    return t ? { center: [t.center[0], t.center[1]], radius: t.radius } : null;
  }
  if (!p.zone) return null;
  const rf = path.join(projectDir, "authoring", "zonegen", doc.world, "zones", p.zone, "reservations.json");
  if (!fs.existsSync(rf)) return null;
  const r = ((readJson(rf).reservations ?? []) as J[]).find((x) => x.location === p.id);
  return r ? { center: [r.center[0], r.center[1]], radius: r.radius } : null;
}
/** The concept sheet a place's concept stages read and its approval approves. */
export function conceptSheet(projectDir: string, doc: WorldStages, p: Place): string {
  return p.kind === "town"
    ? path.join(projectDir, "authoring", "towns", "concept", `${p.name ?? p.id}-sheet.png`)
    : path.join(projectDir, "authoring", "zonegen", doc.world, "zones", p.zone ?? "", "concept", `${p.id}-sheet.png`);
}
export function conceptManifest(projectDir: string, doc: WorldStages, p: Place): string {
  return conceptSheet(projectDir, doc, p).replace(/-sheet\.png$/, ".site.json");
}
/** The town design's plan picture (`town-design render`), what a plan approval approves. */
export function planPicture(projectDir: string, p: Place): string {
  return path.join(projectDir, "authoring", "towns", "survey", `${p.name ?? p.id}-design.png`);
}

const relTo = (projectDir: string, f: string): string => path.relative(projectDir, f).split(path.sep).join("/");
export function howFor(doc: WorldStages, p: Place | null, stage: string): string {
  const w = `${doc.world} --project ${doc.project}`;
  // the world goes straight after the command word (zonegen.mts <command> <world> --project <p> ...)
  const zg = (c: string) => { const [cmd, ...args] = c.split(" "); return `npx tsx tools/zonegen.mts ${cmd} ${w}${args.length ? ` ${args.join(" ")}` : ""}`; };
  const at = p ? (p.kind === "town" ? `--town ${p.name ?? p.id}` : `--zone ${p.zone} --poi ${p.id}`) : "";
  const done = (s: string, ev: string) => zg(`stages --done ${s} --place ${p?.id} --evidence <${ev}> --by <agent>`);
  switch (stage) {
    case "generate": return `npx tsx tools/worldgen.mts all ${doc.world} --project ${doc.project} (then the world fixes)`;
    case "status-clean": return `npx tsx tools/worldgen.mts status ${w} until clean, then ${zg("stages --done status-clean")}`;
    case "siting": return `site every role (site-finder skill), then ${zg("stages --site <id> --kind poi|entrance|town --role <role> [--zone z] --by <agent>")}`;
    case "world-frozen": return zg(`stages --freeze --by coordinator`);
    case "sited": return zg(`stages --site ${p?.id} --kind ${p?.kind} --role ${p?.role}${p?.zone ? ` --zone ${p.zone}` : ""} --by <agent>`);
    case "bare-renders": return zg(`concept ${at} --renders-only`);
    case "concept-painted": return zg(`concept ${at} --paint-only`);
    case "concept-approved": return `show Derek the sheet, then ${zg(`approve --place ${p?.id} --stage concept --by derek`)} (or --by coordinator --ruling "<date> ...")`;
    case "design": return `owner agent writes the design from the approved painting, then ${done("design", "design.json")}`;
    case "design-review": return `fresh reviewer agent (PASS), then ${done("design-review", "review file saying PASS")}`;
    case "town-design": return `npx tsx tools/town-design.mts propose --project ${doc.project} --town ${p?.id} --name ${p?.name ?? p?.id} (designer reshapes until check passes), then ${done("town-design", `authoring/towns/${p?.name ?? p?.id}-design.json`)}`;
    case "plan-approved": return `show Derek the plan picture, then ${zg(`approve --place ${p?.id} --stage plan --by derek`)}`;
    case "grey-box": return p?.kind === "town"
      ? `worldgen terrace --from-plan + town-layout --from-plan + kit build, then ${done("grey-box", "grey-box sheet")}`
      : `place-build plan/lab/build/gates/shots, then ${done("grey-box", "grey-box sheet")}`;
    case "grey-box-review": return `fresh reviewer agent on the grey box (PASS), then ${done("grey-box-review", "review file saying PASS")}`;
    case "detail": return `owner details (dressing, lights, packs), then ${done("detail", "detail sheet")}`;
    case "final-review": return `fresh reviewer agent (PASS), then ${done("final-review", "review file saying PASS")}`;
    case "installed": return p?.kind === "town" ? `npx tsx tools/town-install.mts --project ${doc.project} --town ${p?.name ?? p?.id} (records it)` : `place-build install ${doc.world} --zone ${p?.zone} --location ${p?.id} --project ${doc.project} (records it)`;
    case "walked": return `walk it in the client on the server, then ${done("walked", "walk report / shots")}`;
    default: return "";
  }
}

/** A review file's verdict: a JSON `verdict`, else the first PASS / RETURN / FAIL word in the text. */
export function reviewVerdict(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  try { const j = JSON.parse(text); if (typeof j?.verdict === "string") return j.verdict.toUpperCase(); } catch { /* text */ }
  const m = /\b(PASS(?:ED)?|RETURN(?:ED)?|FAIL(?:ED)?)\b/.exec(text);
  return m ? (m[1]!.startsWith("PASS") ? "PASS" : m[1]!.startsWith("RETURN") ? "RETURN" : "FAIL") : null;
}

export function evaluate(projectDir: string, doc: WorldStages): Eval {
  const hash = currentWorldHash(projectDir, doc);
  const world: StageState[] = [];
  const rec = (r: StageRecord | undefined, what: string): string | null => {
    if (!r) return null;
    if (r.worldHash !== hash) return `${what} on world ${short(r.worldHash)}, world is now ${hash ? short(hash) : "missing"}`;
    return "";
  };
  // generate
  const recipeOk = hash !== null;
  world.push({ stage: "generate", state: recipeOk ? "ok" : "MISSING", why: recipeOk ? `world ${short(hash!)}` : "no recipe", how: howFor(doc, null, "generate") });
  // status-clean
  const sc = rec(doc.stages["status-clean"], "checked");
  world.push(sc === null ? { stage: "status-clean", state: recipeOk ? "MISSING" : "BLOCKED", blockedBy: recipeOk ? undefined : "generate", why: "never checked", how: howFor(doc, null, "status-clean") }
    : { stage: "status-clean", state: sc ? "STALE" : "ok", why: sc || (doc.stages["status-clean"]!.note ?? `checked ${doc.stages["status-clean"]!.at}`), how: howFor(doc, null, "status-clean") });
  const statusOk = world[1]!.state === "ok";

  const places = doc.places.map((place) => ({ place, rows: [] as StageState[] }));
  // sited first (siting reads it)
  const sitedState = (p: Place): StageState => {
    const r = p.stages["sited"];
    const how = howFor(doc, p, "sited");
    if (!r) return recipeOk ? { stage: "sited", state: "MISSING", why: "not sited", how } : { stage: "sited", state: "BLOCKED", blockedBy: "generate", why: "", how };
    const w = rec(r, "sited");
    if (w) return { stage: "sited", state: "STALE", why: w, how };
    const now = currentSite(projectDir, doc, p);
    if (!now) return { stage: "sited", state: "STALE", why: p.kind === "town" ? `no town ${p.id} in the recipe` : `no reservation ${p.id} in zone ${p.zone}`, how };
    // a town's radius grows when its plan is cut (terrace --from-plan): only its centre is the site
    if (r.site && (Math.hypot(now.center[0] - r.site.center[0], now.center[1] - r.site.center[1]) > 0.5 || (p.kind !== "town" && Math.abs(now.radius - r.site.radius) > 0.5)))
      return { stage: "sited", state: "STALE", why: `site moved: [${r.site.center}] r ${r.site.radius} -> [${now.center}] r ${now.radius}`, how };
    return { stage: "sited", state: "ok", why: r.note ?? `by ${r.by ?? "?"}`, how };
  };
  const sited = new Map(doc.places.map((p) => [p.id, sitedState(p)]));
  // siting: every role filled by an ok sited place
  const unfilled = doc.roles.filter((role) => !doc.places.some((p) => p.role === role && sited.get(p.id)!.state === "ok"));
  world.push(!doc.roles.length ? { stage: "siting", state: "MISSING", why: "no roles declared (stages --roles a,b,c)", how: howFor(doc, null, "siting") }
    : unfilled.length ? { stage: "siting", state: statusOk ? "MISSING" : "BLOCKED", blockedBy: statusOk ? undefined : "status-clean", why: `not sited: ${unfilled.join(", ")}`, how: howFor(doc, null, "siting") }
    : statusOk ? { stage: "siting", state: "ok", why: `${doc.roles.length} roles sited`, how: howFor(doc, null, "siting") }
    : { stage: "siting", state: "BLOCKED", blockedBy: "status-clean", why: `every role sited (${doc.roles.length}); waits on status-clean`, how: howFor(doc, null, "siting") });
  const sitingOk = world[2]!.state === "ok";
  // world-frozen
  const fr = doc.stages["world-frozen"];
  const fw = rec(fr, "frozen");
  world.push(fw === null ? { stage: "world-frozen", state: sitingOk ? "MISSING" : "BLOCKED", blockedBy: sitingOk ? undefined : world.slice(0, 3).find((s) => s.state !== "ok")!.stage, why: "not frozen", how: howFor(doc, null, "world-frozen") }
    : fw ? { stage: "world-frozen", state: "STALE", why: fw, how: howFor(doc, null, "world-frozen") }
    : { stage: "world-frozen", state: sitingOk ? "ok" : "STALE", why: sitingOk ? `frozen ${fr!.at}${fr!.by ? ` by ${fr!.by}` : ""}` : "siting is not ok", how: howFor(doc, null, "world-frozen") });
  const frozen = world[3]!;

  for (const entry of places) {
    const p = entry.place;
    const order = stagesOf(p);
    let prev: StageState | null = null, prevRec: StageRecord | undefined;
    for (const stage of order) {
      const how = howFor(doc, p, stage);
      let s: StageState;
      if (stage === "sited") s = sited.get(p.id)!;
      else {
        const r = p.stages[stage];
        // the gate before this stage: the previous place stage, and for bare-renders also the frozen world
        const gate: StageState = stage === "bare-renders" && frozen.state !== "ok" ? { ...frozen, stage: "world-frozen" } : prev!;
        if (!r) s = gate.state === "ok" ? { stage, state: "MISSING", why: "not done", how } : { stage, state: "BLOCKED", blockedBy: gate.state === "BLOCKED" ? gate.blockedBy : gate.stage, why: "", how };
        else {
          let why = rec(r, "done") ?? "";
          if (!why && r.evidence) {
            const now = fileSha(path.resolve(projectDir, r.evidence));
            if (now === null) why = `evidence ${r.evidence} is gone`;
            else if (r.evidenceSha && now !== r.evidenceSha) why = `evidence ${r.evidence} changed since it was recorded`;
          }
          if (!why && stage in APPROVALS) {
            const of = p.stages[APPROVALS[stage as keyof typeof APPROVALS]];
            if (!of || r.approves !== of.evidenceSha) why = `${stage === "concept-approved" ? "repainted" : "redrawn"} after the approval (approved ${short(r.approves ?? "?")}, now ${short(of?.evidenceSha ?? "none")})`;
          }
          if (!why && gate.state !== "ok") why = `${gate.stage} is ${gate.state}`;
          if (!why && prevRec && prevRec.at > r.at) why = `${prev!.stage} was redone after it (${prevRec.at})`;
          s = { stage, state: why ? "STALE" : "ok", why: why || r.note || `${r.by ? `by ${r.by} ` : ""}${r.at}`, how };
        }
      }
      entry.rows.push(s);
      prev = s; prevRec = p.stages[stage];
    }
  }
  return { worldHash: hash, world, places };
}

/** The single next allowed action: the first stage that is not ok (STALE or MISSING; BLOCKED points at its blocker). */
export function nextOf(rows: StageState[]): StageState | null {
  return rows.find((r) => r.state !== "ok") ?? null;
}

// ------------------------------------------------------------------ enforcement

const DATED = /\b20\d\d-\d\d-\d\d\b/;
export const isDatedRuling = (s: string): boolean => DATED.test(s) && s.replace(DATED, "").trim().length >= 8;

/**
 * Refuse a place command unless `stage` of the place is ok. Returns null when allowed (or when no world of the project
 * keeps a stages file: older worlds are not enforced), else the refusal text naming the missing step and its command.
 */
export function requirePlaceStage(projectDir: string, key: string, stage: string, command: string, world?: string): string | null {
  const worlds = world ? [world].filter((w) => fs.existsSync(stagesFile(projectDir, w))) : stagedWorlds(projectDir);
  if (!worlds.length) return null;
  for (const w of worlds) {
    const doc = loadStages(projectDir, w)!;
    const p = doc.places.find((x) => matchPlace(x, key));
    if (!p) continue;
    const ev = evaluate(projectDir, doc);
    const rows = ev.places.find((e) => e.place === p)!.rows;
    const gate = stage === "world-frozen" ? ev.world.find((r) => r.stage === "world-frozen")! : rows.find((r) => r.stage === stage);
    if (!gate) return `${command}: ${p.id} (${p.kind}) has no stage ${stage}`;
    if (gate.state === "ok") return null;
    const first = stage === "world-frozen" ? ev.world.find((r) => r.state !== "ok")! : nextOf(rows)!;
    return `${command} refused (world order, ${relTo(projectDir, stagesFile(projectDir, w))}): ${p.id} needs ${stage} ok, it is ${gate.state}${gate.why ? ` (${gate.why})` : ""}.\n  next step: ${first.stage} [${first.state}${first.why ? `: ${first.why}` : ""}]\n  do it:     ${first.how}`;
  }
  return `${command} refused (world order): no place "${key}" in ${worlds.map((w) => relTo(projectDir, stagesFile(projectDir, w))).join(", ")} — site it first: ${howFor(loadStages(projectDir, worlds[0]!)!, null, "siting")}`;
}

/** Record a place stage done now on the current world hash (the tool that did the work calls it). */
export function recordPlaceStage(projectDir: string, key: string, stage: string, fields: Partial<StageRecord> & { evidenceFile?: string }, world?: string): string | null {
  for (const w of world ? [world] : stagedWorlds(projectDir)) {
    const doc = loadStages(projectDir, w);
    const p = doc?.places.find((x) => matchPlace(x, key));
    if (!doc || !p) continue;
    const hash = currentWorldHash(projectDir, doc)!;
    const { evidenceFile, ...rest } = fields;
    p.stages[stage] = {
      at: new Date().toISOString(), worldHash: hash, ...rest,
      ...(evidenceFile ? { evidence: relTo(projectDir, path.resolve(evidenceFile)), evidenceSha: fileSha(path.resolve(evidenceFile)) ?? undefined } : {}),
    };
    saveStages(projectDir, doc);
    return `recorded ${p.id} ${stage} on world ${short(hash)} (${relTo(projectDir, stagesFile(projectDir, w))})`;
  }
  return null;
}

/**
 * The worldgen write guard. `file` is the recipe being written; `next` the recipe about to be written. A world whose
 * project keeps a stages file and is frozen refuses any write that changes the world hash, unless `unfreeze` is a dated
 * ruling: then the freeze is lifted, the unfreeze logged with the place stages it makes STALE, and the write goes on.
 * Returns { ok, message }.
 */
export function guardWorldWrite(file: string, next: unknown, unfreeze: string, command: string): { ok: boolean; message: string } {
  const m = /[\\/]projects[\\/]([^\\/]+)[\\/]assets[\\/]worlds[\\/]([^\\/]+)\.json$/.exec(path.resolve(file));
  if (!m) return { ok: true, message: "" };
  const projectDir = path.resolve(file, "..", "..", "..");
  const doc = loadStages(projectDir, m[2]!);
  if (!doc) return { ok: true, message: "" };
  const fr = doc.stages["world-frozen"];
  const ids = doc.places.map((p) => p.id);
  const before = fs.existsSync(file) ? worldHash(readJson(file), ids) : null;
  if (!fr || fr.worldHash !== before) return { ok: true, message: "" }; // not frozen (or already stale: nothing left to protect)
  const after = worldHash(next, ids);
  if (after === before) return { ok: true, message: "" };
  if (!unfreeze) return { ok: false, message: `${command} refused: world ${doc.world} is FROZEN (${fr.at}${fr.by ? ` by ${fr.by}` : ""}) and this write changes the world (${short(before)} -> ${short(after)}). Places are built on it. Only with a dated ruling: --unfreeze "YYYY-MM-DD <who>: <why>" — every place stage done on this world goes STALE (zonegen stages ${doc.world} --project ${doc.project} lists them).` };
  if (!isDatedRuling(unfreeze)) return { ok: false, message: `${command}: --unfreeze needs a dated ruling ("YYYY-MM-DD <who>: <why>"), got "${unfreeze}"` };
  const ev = evaluate(projectDir, doc);
  const stale: string[] = [];
  for (const e of ev.places) for (const r of e.rows) if (r.state === "ok") stale.push(`${e.place.id}:${r.stage}`);
  delete doc.stages["world-frozen"];
  doc.unfreezes.push({ at: new Date().toISOString(), ruling: unfreeze, from: before!, to: after, command, stale });
  saveStages(projectDir, doc);
  return { ok: true, message: `UNFROZE ${doc.world} (${unfreeze}): ${short(before!)} -> ${short(after)}. STALE now (redo in order): ${stale.length ? stale.join(", ") : "nothing"}. Re-freeze: zonegen stages ${doc.world} --project ${doc.project} --freeze` };
}

/** Place-command hook: print the refusal and exit 3 when the stage is not ok. */
export function enforceOrExit(projectDir: string, key: string, stage: string, command: string, world?: string): void {
  const why = requirePlaceStage(projectDir, key, stage, command, world);
  if (why) { console.error(why); process.exit(3); }
}
