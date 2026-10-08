/**
 * The zone pipeline as ONE dependency-ordered list, evaluated against the disk: what `zonegen status` prints.
 *
 * Planning rows read the gate reports the lints write (ok | STALE | MISSING | FAILED, see lib.gateState). Build rows
 * read the REAL evidence the existing tools write — a survey JSON, a layout with per-lot problems, a walk report, a
 * dress check report, a POI job's progress.json, a dungeon's own pipeline — never a flag an agent could simply set.
 * Where no tool writes evidence yet the row says `no gate yet` (`gap: true`) and `--next` steps over it.
 *
 * Every row carries `how`: the exact command, or for an agent stage the brief to hand a fresh agent
 * (`zonegen brief-for <stage>`) followed by the gate it must pass.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DIGEST_VERSION, digest, exists, gateState, readJson, type Ctx, type Finding } from "./lib.mts";
import { bestiarySchema, freezeSchema, questGraphSchema, zoneBriefSchema } from "./schemas.mts";
import { manifestRows } from "./commands/manifest.mts";
import { townNames, type Adjacency } from "./commands/_shared.mts";
import { findSceneFile, readBindReport } from "./commands/_zone.mts";
import { populateRow } from "./commands/populate.mts";
import { systemsRow } from "./commands/systems.mts";
import { groundNear, streetsOf, TownStamps, type StampInput } from "./commands/_town-stamps.mts";
import { streetLightingFile } from "../town-lights-rule.mts";
import { atlasState } from "../town-atlas.mjs";
import { portalDigest, walkThroughPortals } from "../_portal-veil-ops.mts";
import type { SceneDoc } from "@hitreg/core";

export type Who = "procedural" | "gpt" | "fable" | "opus" | "sonnet" | "human";
export type State = "ok" | "STALE" | "MISSING" | "FAILED";
export interface Row {
  stage: string;
  who: Who;
  state: State;
  why: string;
  how: string;
  /** No machine gate exists for this stage yet: printed, never picked by --next. */
  gap?: boolean;
}

const mtime = (file: string): number => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : NaN);
const gap = (stage: string, who: Who, how: string, what: string): Row => ({ stage, who, state: "MISSING", why: `no gate yet: ${what}`, how, gap: true });

// ------------------------------------------------------------------ world

interface WorldgenRow { state: string; name: string; agent: boolean; why: string; optional: boolean }
/** `worldgen status`, parsed: the recipe's own pipeline stamps decide terrain and names; nothing is re-implemented here. */
function worldgenStatus(ctx: Ctx): { rows: WorldgenRow[]; error: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join("tools", "worldgen.mts"), "status", ctx.world, "--project", ctx.project], { encoding: "utf8", maxBuffer: 1 << 24 });
  const rows: WorldgenRow[] = [];
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const m = /^ {2}(ok|STALE|MISSING)\s+(\S+)\s*(\(agent\))?\s*(?:— (.*?))?\s*$/.exec(line);
    if (!m) continue;
    const why = (m[4] ?? "").replace(/\s*\(optional\)$/, "");
    rows.push({ state: m[1]!, name: m[2]!, agent: !!m[3], why, optional: /\(optional\)\s*$/.test(line) });
  }
  const first = (r.stderr || r.stdout || "").split(/\r?\n/).find((l) => l.trim());
  return { rows, error: rows.length ? "" : first?.trim() ?? "worldgen status printed nothing" };
}

function gateRow(ctx: Ctx, stage: string, zone: string, who: Who, how: string, file?: string): Row {
  // a folder that does not exist yet is scaffolded by init, which also prefills what the map already decides
  const folder = zone ? ctx.paths.zoneDir(zone) : ctx.paths.worldDir;
  if (!exists(folder) || (file && !exists(path.dirname(file)))) {
    const init = `npx tsx tools/zonegen.mts init ${ctx.world} --project ${ctx.project}${zone ? ` --zone ${zone}` : ""}`;
    return { stage, who, state: "MISSING", why: `${zone ? "zone" : "world"} folder missing`, how: `${init}  -> then: ${how}` };
  }
  if (file && !exists(file)) return { stage, who, state: "MISSING", why: `${path.basename(file)} not written`, how };
  const s = gateState(ctx.paths, stage, zone);
  return { stage, who, state: s.state, why: s.why, how };
}

export function worldRows(ctx: Ctx): Row[] {
  const { world, project, paths: p } = ctx;
  const cmd = (c: string): string => `npx tsx tools/zonegen.mts ${c} ${world} --project ${project}`;
  const agent = (stage: string, gate: string): string => `${cmd(`brief-for ${stage}`)}  -> then ${cmd(gate)}`;
  const wg = worldgenStatus(ctx);
  const terrain = wg.rows.find((r) => r.state !== "ok" && !r.agent && !r.optional);
  const landforms = wg.rows.find((r) => r.name === "landforms");
  const rows: Row[] = [];
  rows.push(
    wg.error
      ? { stage: "terrain", who: "procedural", state: "FAILED", why: `worldgen status: ${wg.error}`, how: `npx tsx tools/worldgen.mts status ${world} --project ${project}` }
      : terrain
        ? { stage: "terrain", who: "procedural", state: terrain.state as State, why: `worldgen ${terrain.name}: ${terrain.why || terrain.state}`, how: `npx tsx tools/worldgen.mts status ${world} --project ${project} --next` }
        : { stage: "terrain", who: "procedural", state: "ok", why: landforms && landforms.state !== "ok" ? "(optional landforms stage not run; it goes before rivers)" : "", how: `npx tsx tools/worldgen.mts status ${world} --project ${project}` },
  );
  const names = wg.rows.filter((r) => (r.name === "zone-names" || r.name === "town-names") && r.state !== "ok");
  rows.push({
    stage: "names",
    who: "opus",
    state: wg.error ? "FAILED" : names.length ? (names[0]!.state as State) : "ok",
    why: names.map((n) => n.why).join("; "),
    how: "the zone-setup skill / zone-architect agent (zones named from their landmarks, town zones for their settlement)",
  });
  const bestiary = gateRow(ctx, "bestiary", "", "opus", `edit authoring/zonegen/bestiary.json from the mob library -> ${cmd("bestiary")}`, p.bestiary);
  if (exists(p.bestiary)) {
    const cat = bestiarySchema.safeParse(readJson(p.bestiary));
    const drafts = cat.success ? cat.data.factions.filter((x) => x.draft).map((x) => x.id) : [];
    if (drafts.length) bestiary.why = [bestiary.why, `${drafts.length} DRAFT faction(s) await the owner's approval: ${drafts.join(", ")}`].filter(Boolean).join("; ");
  }
  rows.push(bestiary);
  rows.push(gateRow(ctx, "adjacency", "", "procedural", cmd("adjacency")));
  rows.push(gateRow(ctx, "cast", "", "opus", agent("cast", "cast"), p.cast));
  rows.push(gateRow(ctx, "links", "", "sonnet", `write links.json (towns from adjacency.json, roads from the recipe) -> ${cmd("links")}`, p.links));
  // the project's own game systems in the world's scene (HUD, combat effects, the mob attack bridge, sound)
  rows.push({ stage: "systems", who: "procedural", ...systemsRow(ctx) });
  return rows;
}

// ------------------------------------------------------------------- zone

export const PLANNING = ["sites", "brief", "bestiary", "town", "quests", "reserve", "manifest", "freeze"] as const;

export function zoneRows(ctx: Ctx, zone: string): Row[] {
  const { world, project, paths: p } = ctx;
  const cmd = (c: string): string => `npx tsx tools/zonegen.mts ${c} ${world} --project ${project} --zone ${zone}`;
  const agent = (stage: string, gate: string): string => `${cmd(`brief-for ${stage}`)}  -> then ${cmd(gate)}`;
  const rows: Row[] = [
    // the ground first: candidate sites, density and climbing-path lint, read by the brief and reserve agents
    gateRow(ctx, "sites", zone, "procedural", `${cmd("sites")}  (then open zones/${zone}/reports/sites.png + sites-candidates.json)`),
    gateRow(ctx, "brief", zone, "fable", agent("zone-brief", "brief"), p.brief(zone)),
    gateRow(ctx, "bestiary", zone, "sonnet", agent("zone-bestiary", "bestiary"), p.zoneBestiary(zone)),
    gateRow(ctx, "town", zone, "opus", agent("town", "town")),
    gateRow(ctx, "quests", zone, "opus", agent("quests", "quests"), p.quests(zone)),
    gateRow(ctx, "reserve", zone, "sonnet", agent("reserve", "reserve"), p.reservations(zone)),
    gateRow(ctx, "manifest", zone, "procedural", cmd("manifest")),
  ];

  // freeze: ok only while every frozen planning digest still matches (layout the build writes never counts)
  const freezeFile = p.freeze(zone);
  let frozen: { ok: boolean; why: string } = { ok: false, why: "plan not frozen" };
  if (exists(freezeFile)) {
    const fz = freezeSchema.safeParse(readJson(freezeFile));
    if (!fz.success) frozen = { ok: false, why: "freeze.json unreadable" };
    else if (fz.data.v !== DIGEST_VERSION) frozen = { ok: false, why: `freeze.json was written by an older zonegen (${fz.data.v ? `digest v${fz.data.v}` : "whole-file hashes"}): re-run zonegen freeze` };
    else {
      const changed = Object.entries(fz.data.hashes).filter(([rel, h]) => !exists(path.join(p.projectDir, rel)) || digest(p, path.join(p.projectDir, rel), zone) !== h).map(([rel]) => rel);
      frozen = changed.length ? { ok: false, why: `plan changed since the freeze: ${changed.join(", ")}` } : { ok: true, why: "" };
    }
    rows.push({ stage: "freeze", who: "procedural", state: frozen.ok ? "ok" : "STALE", why: frozen.why, how: cmd("freeze") });
  } else rows.push({ stage: "freeze", who: "procedural", state: "MISSING", why: "plan not frozen", how: cmd("freeze") });

  const build = buildRows(ctx, zone);
  build.push(lipsRow(ctx, zone));
  if (!exists(freezeFile)) for (const r of build) if (!r.gap) Object.assign(r, { state: "MISSING", why: `after freeze${r.state === "ok" ? " (evidence exists from before)" : ""}` });
  if (exists(freezeFile) && !frozen.ok) for (const r of build) if (!r.gap) Object.assign(r, { state: "STALE", why: frozen.why });
  return [...rows, ...build];
}

/**
 * The lip / sawtooth gate over the zone's ground (`worldgen lips --near` on the
 * zone polygon's bounding circle): every height patch and graded road in it,
 * measured on the 2 m lattice. Cached in reports/terrain-lips.json against the
 * recipe's size+mtime, so status only re-measures after a recipe change.
 */
function lipsRow(ctx: Ctx, zone: string): Row {
  const { world, project, paths: p } = ctx;
  const stage = "terrain-lips";
  const how = `npx tsx tools/worldgen.mts lips ${world} --project ${project} --near <x,z,r> --list  (fix: patch feather/edgeSlope/maxSlope, road maxCut; docs/voxel-worlds.md "Height-patch edges")`;
  if (!exists(p.recipe)) return { stage, who: "procedural", state: "MISSING", why: "no recipe", how };
  const st = fs.statSync(p.recipe);
  const key = `${st.size}:${st.mtimeMs}`;
  const cache = path.join(p.zoneDir(zone), "reports", "terrain-lips.json");
  let res: { key?: string; near?: number[]; ok?: boolean; totals?: { alias: number; step: number; lip: number }; owners?: { id: string; alias: number; step: number; lip: number }[] } | null = exists(cache) ? (readJson(cache) as never) : null;
  if (!res || res.key !== key) {
    const recipe = readJson(p.recipe) as { regions?: { id: string; polygon?: [number, number][] }[] };
    const poly = recipe.regions?.find((r) => r.id === zone)?.polygon;
    if (!poly?.length) return { stage, who: "procedural", state: "MISSING", why: `zone ${zone} has no polygon in the recipe regions`, how };
    const xs = poly.map((q) => q[0]), zs = poly.map((q) => q[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const r = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2;
    const near = [Math.round(cx), Math.round(cz), Math.ceil(r)];
    const out = spawnSync(process.execPath, ["--import", "tsx", path.join("tools", "worldgen.mts"), "lips", world, "--project", project, "--near", near.join(","), "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
    try {
      res = { key, near, ...JSON.parse(out.stdout.slice(out.stdout.indexOf("{"))) };
      fs.mkdirSync(path.dirname(cache), { recursive: true });
      fs.writeFileSync(cache, JSON.stringify(res, null, 1));
    } catch {
      return { stage, who: "procedural", state: "FAILED", why: `worldgen lips failed: ${(out.stderr || out.stdout || "").split(/\r?\n/).find((l) => l.trim()) ?? "no output"}`, how };
    }
  }
  const t = res!.totals!;
  const worst = (res!.owners ?? []).slice(0, 3).map((o) => `${o.id} ${o.alias}/${o.step}/${o.lip}`).join(", ");
  return res!.ok
    ? { stage, who: "procedural", state: "ok", why: "", how: how.replace("<x,z,r>", res!.near!.join(",")) }
    : { stage, who: "procedural", state: "FAILED", why: `alias ${t.alias}, step ${t.step}, lip ${t.lip} (worst: ${worst})`, how: how.replace("<x,z,r>", res!.near!.join(",")) };
}

/** The build half: per town, per reserved location, per dungeon, the art lane, then explore / bind / play / audit. */
function buildRows(ctx: Ctx, zone: string): Row[] {
  const { project, paths: p } = ctx;
  const rows: Row[] = [];
  const towns = path.join(p.projectDir, "authoring", "towns");
  const tool = (t: string, args: string): string => `npx tsx tools/${t}.mts --project ${project} ${args}`;
  const brief = exists(p.brief(zone)) ? zoneBriefSchema.safeParse(readJson(p.brief(zone))) : null;
  const names = townNames(p, ctx.world);

  for (const t of brief?.success ? brief.data.towns : []) {
    const name = names.get(t.id);
    const at = (s: string): string => `town ${name ?? t.id}: ${s}`;
    if (!name) {
      rows.push({ stage: at("survey"), who: "opus", state: "MISSING", why: "no town doc", how: "town-npcs skill (the town doc names the town)" });
      continue;
    }
    const plan = p.townPlan(name);
    const survey = path.join(towns, "survey", `${name}.json`);
    const layout = path.join(towns, `${name}-layout.json`);
    const install = path.join(towns, `${name}-install-ops.json`);
    const walk = path.join(towns, "survey", `${name}-walk.json`);
    const doc = p.townDoc(name);
    // staleness by CONTENT of what each gate reads (commands/_town-stamps.mts), not by file time
    const stamps = new TownStamps(path.join(p.zoneDir(zone), "reports", `town-${name}.stamps.json`));
    const step = (s: string, who: Who, how: string, file: string, judge: () => string | null, inputs: StampInput[], evidenceProj?: (raw: any) => unknown): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!exists(file)) return void rows.push({ stage: at(s), who, state: "MISSING", why: `${path.relative(p.projectDir, file).replaceAll("\\", "/")} not written`, how });
      const bad = judge();
      if (bad) return void rows.push({ stage: at(s), who, state: "FAILED", why: bad, how });
      const stale = stamps.judge(s, file, evidenceProj, inputs);
      rows.push({ stage: at(s), who, state: stale ? "STALE" : "ok", why: stale ?? "", how });
    };
    const json = <T,>(file: string): T => readJson(file) as T;

    step("survey", "procedural", tool("town-survey", `--town ${name}`), survey, () => {
      const n = json<{ failures?: string[] }>(survey).failures?.length ?? 0;
      return n ? `${n} survey failure(s)` : null;
    }, [{ file: p.recipe, authored: false, proj: groundNear(t.id, 200, true) }, { file: doc, authored: false, proj: (d) => ({ town: d.town, world: d.world }) }], (r: { ms?: unknown }) => ({ ...r, ms: 0 }));
    step("layout", "procedural", tool("town-layout", `--town ${name}`), layout, () => {
      const bad = json<{ buildings: { id: string; problems?: string[] }[] }>(layout).buildings.filter((b) => b.problems?.length);
      return bad.length ? `${bad.length} lot(s) with problems: ${bad.slice(0, 3).map((b) => b.id).join(", ")}` : null;
    }, [{ file: plan, authored: true, proj: (x) => ({ ...x, note: undefined }) }, { file: path.join(towns, `${name}-envelopes.json`), authored: true }, { file: survey, authored: false, proj: (r) => ({ coastal: r.coastal === true }) }, { file: p.recipe, authored: false, proj: groundNear(t.id, 200, true) }]);

    const lots = exists(layout) ? json<{ buildings: { id: string }[] }>(layout).buildings : [];
    const planBuildings = exists(plan) ? (json<{ buildings?: { id: string; model?: string }[] }>(plan).buildings ?? []) : [];
    const modelOf = (id: string): string => planBuildings.find((b) => b.id === id)?.model ?? id;
    const models = [...new Set(lots.map((l) => modelOf(l.id)))];
    // buildings: a model file per lot (the building-constructor's delivered model, exported as <model>.glb)
    const glbs = new Set<string>();
    const walkGlb = (d: string): void => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walkGlb(path.join(d, e.name)) : e.name.endsWith(".glb") && glbs.add(e.name.slice(0, -4));
    };
    if (models.length) walkGlb(path.join(p.projectDir, "assets", "models"));
    const noModel = models.filter((m) => !glbs.has(m));
    rows.push({
      stage: at("buildings"), who: "opus",
      state: !lots.length ? "MISSING" : noModel.length ? "MISSING" : "ok",
      why: !lots.length ? "no layout yet" : noModel.length ? `${noModel.length} of ${models.length} lot model(s) have no .glb under assets/models (${noModel.slice(0, 3).join(", ")})` : "",
      how: "building-constructor skill, one request per lot (town-planner hands them over)",
    });
    // atlas: every building of the town on ONE texture page and ONE material (docs/town-baking.md; tools/town-atlas.mjs).
    // A fresh export from the building-constructor is un-atlased: the row goes STALE until town-atlas folds it in.
    {
      const atlasDir = path.join(p.projectDir, "assets", "models", "towns", name);
      const a = lots.length ? atlasState(atlasDir) : { state: "MISSING" as const, why: "no layout yet" };
      rows.push({ stage: at("atlas"), who: "procedural", state: a.state as State, why: a.state === "ok" ? "" : a.why,
        how: `node tools/town-atlas.mjs projects/${project}/assets/models/towns/${name}` });
    }
    const sockets = path.join(p.projectDir, "authoring", "dressing", "sockets");
    const socketOf = (m: string): string | null => [path.join(sockets, `${name}-${m}.json`), path.join(sockets, `${m}.json`)].find(exists) ?? null;
    const noSockets = models.filter((m) => !socketOf(m));
    rows.push({
      stage: at("sockets"), who: "procedural",
      state: !lots.length || noSockets.length ? "MISSING" : "ok",
      why: !lots.length ? "no layout yet" : noSockets.length ? `${noSockets.length} of ${models.length} model(s) unmeasured (${noSockets.slice(0, 3).join(", ")})` : "",
      how: `npx tsx tools/dress.mts sockets --project ${project} --from-layout projects/${project}/authoring/towns/${name}-layout.json --building <id> --id <model>`,
    });
    const modelDir = path.join(p.projectDir, "assets", "models", "towns", name);
    const modelFiles = fs.existsSync(modelDir) ? fs.readdirSync(modelDir).filter((f) => f === "manifest.json" || f.endsWith(".glb")).map((f) => path.join(modelDir, f)) : [];
    const modelInputs: StampInput[] = modelFiles.map((file) => ({ file, authored: true }));
    step("install", "procedural", tool("town-install", `--town ${name}`), install, () => null, [{ file: layout, authored: false }, ...modelInputs]);
    // floors: no terrain pokes through a floor (docs/world-standards/towns.md): the ground under each model's FULL
    // footprint against its floor, re-judged after ANY ground change round the town (the recipe projection) or a layout
    // change; a failure is fixed by settling again (town-settle without --check), then re-installing
    const floors = path.join(towns, "survey", `${name}-floors.json`);
    step("floors", "procedural", `${tool("town-settle", `--town ${name} --check`)}  (a failure: ${tool("town-settle", `--town ${name}`)}, then install)`, floors, () => {
      const f = json<{ failures?: string[] }>(floors).failures ?? [];
      return f.length ? `${f.length} building(s) with terrain through the floor: ${f.slice(0, 2).join("; ")}` : null;
    }, [{ file: layout, authored: false, proj: (l) => (l.buildings ?? []).map((b: { id: string; groundY?: number; full?: unknown; ground?: unknown }) => [b.id, b.groundY, b.full ?? b.ground]) }, { file: p.recipe, authored: false, proj: groundNear(t.id, 200, true) }],
    (r: { at?: unknown }) => ({ ...r, at: 0 }));
    // paths: a footpath from every placed door to the nearest street, painted AFTER install (town-ground doors writes
    // <town>-paths.json); stale when the layout or the building models (manifest, .glb) change, so moved doors re-run it
    const pathsReport = path.join(towns, `${name}-paths.json`);
    step("paths", "procedural", tool("town-ground", `doors --town ${name}`), pathsReport, () => {
      const f = json<{ failures?: string[] }>(pathsReport).failures ?? [];
      return f.length ? `${f.length} door(s) without a path: ${f.slice(0, 3).join("; ")}` : null;
    }, [{ file: layout, authored: false }, ...modelInputs, { file: p.recipe, authored: false, proj: streetsOf(t.id) }]);
    // lights: the street-lighting standard (tools/street-lights.json, docs/world-standards/towns.md) — lanterns along
    // every street and lane, at plazas, gates and quays, and on the first stretch of every road out; town-lights.mts
    // check writes <town>-lights.json from what the SCENE holds. Stale when the streets, roads, footprints, docks, the
    // rule or the installed lanterns/residents change. Lanterns are solid, so walk reads this report too.
    const lightsReport = path.join(towns, `${name}-lights.json`);
    const townScene = exists(doc) ? path.join(p.projectDir, "assets", "scenes", `${(json<{ scene?: string }>(doc).scene ?? ctx.world)}.scene.json`) : "";
    const lightsScene = (s: { entities: Record<string, { tags?: string[]; components?: { transform?: { position?: number[] } } }> }): unknown =>
      Object.entries(s.entities).filter(([, e]) => e.tags?.some((x) => x === `town-lights:${name}` || x === `town-npc:${t.id}`)).map(([id, e]) => [id, e.components?.transform?.position]);
    step("lights", "procedural", tool("town-lights", `apply --town ${name}`), lightsReport, () => {
      const f = json<{ failures?: string[] }>(lightsReport).failures ?? [];
      return f.length ? `LIGHTS ${f.length} failure(s): ${f.slice(0, 2).join("; ")}` : null;
    }, [{ file: streetLightingFile(p.projectDir), authored: true }, { file: layout, authored: false, proj: (l) => (l.buildings ?? []).map((b: { id: string; full?: unknown; corners?: unknown; door?: unknown }) => [b.id, b.full ?? b.corners, b.door]) },
      { file: plan, authored: true, proj: (x) => x.structures ?? [] }, { file: p.recipe, authored: false, proj: groundNear(t.id, 250, false) },
      ...(townScene ? [{ file: townScene, authored: false, proj: lightsScene }] : [])]);
    step("walk", "procedural", tool("town-walk", `--town ${name}`), walk, () => {
      const routes = json<{ routes: { id: string; finished?: boolean; stuck?: unknown[] }[] }>(walk).routes;
      const bad = routes.filter((r) => !r.finished || (r.stuck?.length ?? 0) > 0);
      return bad.length ? `${bad.length} of ${routes.length} route(s) stuck or unfinished: ${bad.slice(0, 3).map((r) => r.id).join(", ")}` : null;
    }, [{ file: install, authored: false }, { file: p.recipe, authored: false, proj: groundNear(t.id, 50, false) }, { file: lightsReport, authored: false, proj: (r) => r.lanterns ?? [] }]);
    // residents: placed (every plan resident has a spot in the town doc) and linted (town-npcs only writes when its lint passes)
    const md = path.join(p.projectDir, "docs", "towns", `${name}.md`);
    step("residents", "sonnet", `${tool("town-place-npcs", `--town ${name}`)}  then  ${tool("town-npcs", `--town ${name}`)}  (town-npcs skill)`, md, () => {
      const placed = new Set((json<{ residents?: { id: string; place?: { at?: unknown } }[] }>(doc).residents ?? []).filter((r) => r.place?.at).map((r) => r.id));
      const planned = exists(plan) ? (json<{ residents?: { id: string }[] }>(plan).residents ?? []) : [];
      const unplaced = planned.filter((r) => !placed.has(r.id));
      return unplaced.length ? `${unplaced.length} planned resident(s) not placed: ${unplaced.slice(0, 3).map((r) => r.id).join(", ")}` : null;
    }, [{ file: doc, authored: true, proj: (d) => d.residents ?? [] }, { file: plan, authored: true, proj: (x) => x.residents ?? [] }, { file: layout, authored: false }]);
    // interiors: a passing `dress check` report for a plan on every measured model
    const plansDir = path.join(p.projectDir, "authoring", "dressing", "plans");
    const dressPlans = fs.existsSync(plansDir) ? fs.readdirSync(plansDir).filter((x) => x.endsWith(".json") && !x.endsWith(".report.json") && !x.endsWith(".inverse.json")) : [];
    const undressed: string[] = [];
    // per LOT, not per model: two lots sharing a model are two furnished buildings (plan <town>--<lot>.json, or any
    // plan that names the lot's socket map when the town has one building per model)
    for (const lot of lots) {
      const map = socketOf(modelOf(lot.id));
      if (!map) {
        undressed.push(lot.id);
        continue;
      }
      const mapId = path.basename(map, ".json");
      const own = `${name}--${lot.id}.json`;
      const candidates = dressPlans.includes(own) ? [own] : lots.filter((x) => modelOf(x.id) === modelOf(lot.id)).length === 1 ? dressPlans : [];
      const good = candidates.some((f) => {
        const file = path.join(plansDir, f);
        const report = file.replace(/\.json$/, ".report.json");
        try {
          if ((readJson(file) as { map?: string }).map !== mapId || !exists(report)) return false;
          return (readJson(report) as { ok?: boolean }).ok === true && mtime(report) >= mtime(file) && mtime(report) >= mtime(map);
        } catch {
          return false;
        }
      });
      if (!good) undressed.push(lot.id);
    }
    rows.push({
      stage: at("interiors"), who: "sonnet",
      state: !lots.length || undressed.length ? "MISSING" : "ok",
      why: !lots.length ? "no layout yet" : undressed.length ? `${undressed.length} of ${lots.length} lot(s) without a passing, current dress check (${undressed.slice(0, 3).join(", ")})` : "",
      how: `write authoring/dressing/plans/<id>.json per building -> npx tsx tools/dress.mts check --project ${project} --plan <id>`,
    });
    // exterior: streets, square and quay dressed by name — a street map of measured pitches (tools/town-exterior.mts
    // sockets), plan <town>--exterior.json with a passing, current dress check, applied (its inverse), and the town walk
    // re-run after it (the props are solid)
    {
      const extMap = path.join(sockets, `${name}-exterior.json`);
      const extPlan = path.join(plansDir, `${name}--exterior.json`);
      const extReport = extPlan.replace(/\.json$/, ".report.json"), extInv = extPlan.replace(/\.json$/, ".inverse.json");
      const how = `npx tsx tools/town-exterior.mts sockets --project ${project} --town ${name} -> write authoring/dressing/plans/${name}--exterior.json -> dress check -> dress apply --scene <scene> --at 0,0,0 --yaw 0 -> town-walk`;
      const why = !exists(extMap) ? "no street map (town-exterior sockets)" : !exists(extPlan) ? `no plan ${name}--exterior` :
        !exists(extReport) || (readJson(extReport) as { ok?: boolean }).ok !== true || mtime(extReport) < mtime(extPlan) || mtime(extReport) < mtime(extMap) ? "dress check not passing or older than the plan/map" :
        !exists(extInv) || mtime(extInv) < mtime(extReport) ? "checked plan not applied (dress apply)" :
        !exists(walk) || mtime(walk) < mtime(extInv) ? "town walk not re-run since the dressing went in" : "";
      rows.push({ stage: at("exterior"), who: "sonnet", state: why ? "MISSING" : "ok", why, how });
    }
    rows.push(gap(at("bake"), "procedural", "docs/town-baking.md (partitioned bake not implemented; legacy district exporter)", "no bake audit report is written by a shared tool"));
    stamps.save();
  }

  // reserved locations: one POI owner each; its job record is the evidence
  const graph = exists(p.quests(zone)) ? questGraphSchema.safeParse(readJson(p.quests(zone))) : null;
  const g = graph?.success ? graph.data : null;
  for (const l of g?.locations ?? []) {
    if (l.kind === "town") continue;
    if (l.kind === "wild") {
      // open country: nobody builds it. It is ready when the creatures that hold it are installed (populate tags their
      // areas `location:<id>`); its scenery needs are exterior dressing, which has no gate yet.
      const popOps = path.join(p.zoneDir(zone), "populate", "ops.json");
      const held = exists(popOps) && (readJson(popOps) as { entity?: { tags?: string[] } }[]).some((o) => o.entity?.tags?.includes(`location:${l.id}`));
      const installed = exists(path.join(p.zoneDir(zone), "populate", `installed-${ctx.world}.json`));
      const ready = !l.hostile || (held && installed);
      rows.push({
        stage: `wild ${l.id}`, who: "procedural", state: ready ? "ok" : "MISSING",
        why: ready ? (l.needs.length ? `${l.needs.length} scenery need(s) not dressed (no gate yet)` : "") : `no ${l.hostile} creature areas installed there`,
        how: `npx tsx tools/zonegen.mts populate ${ctx.world} --project ${project} --zone ${zone}  -> coordinator: its install.mts`,
      });
      continue;
    }
    const job = path.join(p.zoneDir(zone), "pois", l.id);
    const progress = path.join(job, "progress.json");
    const how = `npx tsx tools/zonegen.mts poi-brief ${ctx.world} --project ${project} --zone ${zone} --location ${l.id}  -> then ONE fresh owner (poi-creator skill) on ${path.relative(process.cwd(), job).replaceAll("\\", "/")}`;
    if (!exists(progress)) {
      rows.push({ stage: `poi ${l.id}`, who: "opus", state: "MISSING", why: "no POI job", how });
      continue;
    }
    const stage = (readJson(progress) as { stage?: string }).stage ?? "?";
    rows.push({ stage: `poi ${l.id}`, who: "opus", state: stage === "installed" ? "ok" : stage === "needs-input" ? "FAILED" : "MISSING", why: stage === "installed" ? "" : `job at stage "${stage}"`, how });
    // site dressing: the place's outdoor props placed by NAME (tools/site-sockets.mts writes one map per area). Each map
    // needs a plan whose dress check passes and is newer than plan and map, then applied (its inverse): the town exterior rule
    {
      const sockDir = path.join(p.projectDir, "authoring", "dressing", "sockets"), planDir = path.join(p.projectDir, "authoring", "dressing", "plans");
      const isSite = (f: string): boolean => { try { return /\(site /.test(String((readJson(path.join(sockDir, f)) as { source?: { model?: string } }).source?.model ?? "")); } catch { return false; } };
      const maps = fs.existsSync(sockDir) ? fs.readdirSync(sockDir).filter((f) => f.startsWith(`${l.id}-`) && f.endsWith(".json") && isSite(f)) : [];
      const plans = fs.existsSync(planDir) ? fs.readdirSync(planDir).filter((f) => f.endsWith(".json") && !/\.(report|inverse)\.json$/.test(f)).map((f) => path.join(planDir, f)) : [];
      const howSite = `npx tsx tools/site-sockets.mts --project ${project} --job ${path.relative(process.cwd(), job).replaceAll("\\", "/")} -> zonegen brief-for dress-site --poi ${l.id} --area <area> (one fresh Sonnet per area) -> coordinator: dress apply --scene <scene> --at 0,0,0 --yaw 0`;
      const open: string[] = [], unapplied: string[] = [];
      for (const m of maps) {
        const id = m.replace(/\.json$/, ""), mapFile = path.join(sockDir, m);
        const good = plans.filter((f) => { try { return (readJson(f) as { map?: string }).map === id; } catch { return false; } }).find((f) => {
          const rep = f.replace(/\.json$/, ".report.json");
          return exists(rep) && (readJson(rep) as { ok?: boolean }).ok === true && mtime(rep) >= mtime(f) && mtime(rep) >= mtime(mapFile);
        });
        if (!good) open.push(id.slice(l.id.length + 1));
        else if (!exists(good.replace(/\.json$/, ".inverse.json"))) unapplied.push(id.slice(l.id.length + 1));
      }
      const why = !maps.length ? "no site socket maps (site-sockets)" : open.length ? `${open.length} of ${maps.length} area(s) without a passing, current dress check (${open.slice(0, 3).join(", ")})` : unapplied.length ? `checked plan(s) not applied: ${unapplied.slice(0, 3).join(", ")}` : "";
      rows.push({ stage: `site-dress ${l.id}`, who: "sonnet", state: why ? "MISSING" : "ok", why, how: howSite });
    }
  }

  // dungeons: their own pipeline status command, when the dungeon project has one
  for (const d of g?.dungeons ?? []) {
    const pipe = path.join(path.dirname(p.projectDir), d.id, "authoring", "pipeline.mjs");
    const how = `hitreg-dungeon-authoring skill (project projects/${d.id}/, status: node authoring/pipeline.mjs)`;
    if (!exists(pipe)) {
      rows.push({ stage: `dungeon ${d.id}`, who: "opus", state: "MISSING", why: `no dungeon project with a pipeline (projects/${d.id}/authoring/pipeline.mjs)`, how });
      continue;
    }
    // `--next --json` on the shared dungeon pipeline (tools/dungeon-pipeline) names the stage and, for a quality gate,
    // its failures; an older per-project pipeline ignores --json and prints its `--next` line, read as before
    const r = spawnSync(process.execPath, [pipe, "--next", "--json"], { encoding: "utf8", cwd: path.dirname(pipe) });
    const line = (r.stdout ?? "").trim();
    let next: { name: string; status: string; gate: boolean; run: string; failures: string[] } | null | undefined;
    try { next = (JSON.parse(line) as { next: typeof next }).next; } catch { next = undefined; }
    if (next !== undefined) {
      const state: State = !next ? "ok" : next.status === "FAILED" ? "FAILED" : next.status === "STALE" ? "STALE" : "MISSING";
      const why = !next ? "" : next.gate
        ? `quality gate ${next.name} ${next.status}${next.failures.length ? `: ${next.failures[0]}${next.failures.length > 1 ? ` (+${next.failures.length - 1} more)` : ""}` : ""} -> ${next.run}`
        : `${next.name} ${next.status}: ${next.run}`;
      rows.push({ stage: `dungeon ${d.id}`, who: "opus", state, why, how });
      continue;
    }
    rows.push({ stage: `dungeon ${d.id}`, who: "opus", state: /^every stage is present and current/.test(line) ? "ok" : "MISSING", why: line.startsWith("every") ? "" : line || (r.stderr ?? "").trim(), how });
  }

  rows.push(...portalRows(ctx, zone));

  // mood: the zone's air and light (recipe regions[].mood, played by the `zone-mood` builtin) and each signature
  // place's own mood as a nested region (`within` the zone, same id as the place) — a nested region wins under the player
  rows.push(moodRow(ctx, zone, brief?.success ? brief.data.places.filter((x) => x.mood).map((x) => x.id) : []));

  // art lane: the manifest re-checked against the disk now
  if (exists(p.assets(zone))) {
    const f: Finding[] = [];
    const { rows: art } = manifestRows(ctx, zone, f);
    const left = art.filter((r) => r.status !== "have");
    const human = left.filter((r) => r.by === "human").length;
    rows.push({
      stage: "art", who: "gpt", state: f.length ? "FAILED" : left.length ? "MISSING" : "ok",
      why: f.length ? f[0]!.message : left.length ? `${left.length} of ${art.length} asset(s) not on disk${human ? ` (${human} wait on a human)` : ""}` : "",
      how: `work ${path.relative(process.cwd(), p.assets(zone)).replaceAll("\\", "/")} (each row names its skill)`,
    });
  } else rows.push({ stage: "art", who: "gpt", state: "MISSING", why: "no asset manifest", how: "zonegen manifest" });

  // populate: the wilderness creatures (reports/populate.json + the coordinator's install record); stale on bestiary/reservations/recipe zone
  rows.push({ stage: "populate", who: "procedural", ...populateRow(ctx, zone) });

  // explore: exploration.json (added after the freeze) against budget.expansion; the gate also lists sites left
  const zcmd = (c: string): string => `npx tsx tools/zonegen.mts ${c} ${ctx.world} --project ${project} --zone ${zone}`;
  rows.push(gateRow(ctx, "explore", zone, "sonnet", `add to zones/${zone}/exploration.json (poi-brief per added location) -> ${zcmd("explore")}`));

  // bind: reports/bind.json, written by `zonegen bind` (bound | blocked + reasons per planned quest)
  const qdir = path.join(p.projectDir, "assets", "quests");
  rows.push(bindRow(ctx, zone, g?.quests.length ?? 0, zcmd("bind")));
  const bindCheck = gateRow(ctx, "bind-check", zone, "procedural", `write the tasks in zones/${zone}/bind/tasks/ (agent or codex-task.mjs) -> ${zcmd("bind-check")}`);
  // a pass over nothing proves nothing: with no quest bound the row stays open
  if (bindCheck.state === "ok" && playable(ctx, zone).bound === 0) Object.assign(bindCheck, { state: "MISSING", why: "nothing bound yet (the check passed over 0 quests)" });
  rows.push(bindCheck);

  // play: the quest-play report covers every planned quest, none failing
  const play = path.join(p.projectDir, "authoring", "reports", "quest-play", "quest-play.json");
  // the zone's own quests only (a project holds other worlds' quests too), and only those whose proof inputs changed
  const playHow = `npx tsx tools/quest-play.mts --project ${project} --scene ${ctx.world} --plan ${path.relative(path.resolve("."), p.quests(zone)).replace(/\\/g, "/")} --changed`;
  if (!exists(play)) rows.push({ stage: "play", who: "procedural", state: "MISSING", why: "no quest-play report", how: playHow });
  else {
    const rep = readJson(play) as { quests?: { id: string; status?: string }[] };
    const got = new Map((rep.quests ?? []).map((q) => [q.id, q.status]));
    const missing = (g?.quests ?? []).filter((q) => !got.has(q.id));
    const failed = (g?.quests ?? []).filter((q) => got.get(q.id) === "fail");
    const late = (g?.quests ?? []).some((q) => mtime(path.join(qdir, `${q.id}.json`)) > mtime(play));
    rows.push({
      stage: "play", who: "procedural",
      state: failed.length ? "FAILED" : missing.length ? "MISSING" : late ? "STALE" : "ok",
      why: failed.length ? `${failed.length} quest(s) fail: ${failed.slice(0, 3).map((q) => q.id).join(", ")}` : missing.length ? `${missing.length} planned quest(s) not played` : late ? "a quest asset changed since the run" : "",
      how: playHow,
    });
  }
  const audit = gateRow(ctx, "audit", zone, "opus", `${zcmd("audit")}  (data audit; then a human playtest)`);
  if (audit.state === "ok" && exists(p.report("audit", zone))) {
    const warns = (readJson(p.report("audit", zone)) as { findings?: { level: string }[] }).findings?.filter((x) => x.level === "warn").length ?? 0;
    if (warns) audit.why = `no errors; ${warns} warning(s) to read in reports/audit.json`;
  }
  rows.push(audit);
  return rows;
}

/** The mood row: the zone region carries a mood, every place with a designed mood has its nested region with one, and the world's scene runs `zone-mood`. */
/**
 * portals: every walk-through portal of the zone in the world scene (a `portal` in mode "trigger" tagged zone:<zone>)
 * covers its measured opening: tools/portal-cover.mts' report for the world scene, per portal, with the digest of the
 * portal and its veil as they were measured (an edit to either makes the row STALE; other edits to the live scene do not).
 * The dungeon side of each trip is the dungeon pipeline's `portals` stage.
 */
function portalRows(ctx: Ctx, zone: string): Row[] {
  const file = findSceneFile(path.resolve("."), ctx.world);
  if (!file) return [];
  const doc = readJson(file) as SceneDoc;
  const ids = walkThroughPortals(doc).map(([id]) => id).filter((id) => (doc.entities[id]?.tags ?? []).includes(`zone:${zone}`));
  if (!ids.length) return [];
  const how = `npx tsx tools/portal-cover.mts --scene ${ctx.world} --portal ${ids.join(",")} (failing: add --fit; coordinator-authorised on a live scene)`;
  const rep = path.join(ctx.paths.projectDir, "reports", "portal-cover", `${ctx.world}.json`);
  if (!exists(rep)) return [{ stage: "portals", who: "procedural", state: "MISSING", why: "no portal-cover report", how }];
  const got = new Map(((readJson(rep) as { portals?: { id: string; status: string; digest: string; trigger: { gaps: string[] }; veil: { gaps: string[] } }[] }).portals ?? []).map((p) => [p.id, p]));
  const missing = ids.filter((id) => !got.has(id));
  const failed = ids.filter((id) => got.get(id)?.status === "FAIL");
  const stale = ids.filter((id) => got.has(id) && got.get(id)!.digest !== portalDigest(doc, id));
  const first = failed.length ? got.get(failed[0]!)! : null;
  const state: State = failed.length ? "FAILED" : missing.length ? "MISSING" : stale.length ? "STALE" : "ok";
  const why = first ? `${failed.join(", ")} do not cover the entrance: ${[...first.trigger.gaps, ...first.veil.gaps][0] ?? ""}`
    : missing.length ? `not measured: ${missing.join(", ")}` : stale.length ? `changed since measured: ${stale.join(", ")}` : "";
  return [{ stage: "portals", who: "procedural", state, why, how }, portalPlayRow(ctx, doc, ids)];
}

/**
 * portal play: every walk-through portal of the zone was walked IN and back OUT by a real browser client
 * (tools/portal-play.mts; it also reloads inside the instance and walks out). Per portal, the report keeps the digest
 * of both doors as they were walked: an edit to the world door or to the instance's return portal makes it STALE.
 */
function portalPlayRow(ctx: Ctx, doc: SceneDoc, ids: string[]): Row {
  const rep = path.join(ctx.paths.projectDir, "reports", "portal-play", `${ctx.world}.json`);
  const dungeonOf = (id: string) => String(((doc.entities[id]?.components["script"] as { params?: Record<string, unknown> } | undefined)?.params ?? {})["scene"] ?? "");
  const how = `npx tsx tools/portal-play.mts --dungeon <instance> --world ${ctx.world} (one per portal; HITREG_PLAYWRIGHT=<playwright dir>)`;
  if (!exists(rep)) return { stage: "portal play", who: "procedural", state: "MISSING", why: `never walked in a browser: ${ids.map(dungeonOf).join(", ")}`, how };
  const got = new Map(((readJson(rep) as { portals?: { id: string; exit: string; scene: string; status: string; digest: string; exitDigest: string; phases?: { name: string; ok: boolean; note: string }[] }[] }).portals ?? []).map((p) => [p.id, p]));
  const missing = ids.filter((id) => !got.has(id));
  const failed = ids.filter((id) => got.get(id)?.status !== "PASS" && got.has(id));
  const stale = ids.filter((id) => {
    const g = got.get(id);
    if (!g || g.digest !== portalDigest(doc, id)) return !!g;
    const f = findSceneFile(path.resolve("."), g.scene);
    return !f || portalDigest(readJson(f) as SceneDoc, g.exit) !== g.exitDigest;
  });
  const state: State = failed.length ? "FAILED" : missing.length ? "MISSING" : stale.length ? "STALE" : "ok";
  const bad = failed.length ? got.get(failed[0]!)!.phases?.find((p) => !p.ok) : undefined;
  const why = failed.length ? `${failed.map(dungeonOf).join(", ")}: ${bad ? `${bad.name}: ${bad.note}` : "failed"}`
    : missing.length ? `never walked in a browser: ${missing.map(dungeonOf).join(", ")}` : stale.length ? `a door changed since walked: ${stale.map(dungeonOf).join(", ")}` : "";
  return { stage: "portal play", who: "procedural", state, why, how };
}

function moodRow(ctx: Ctx, zone: string, moodyPlaces: string[]): Row {
  const p = ctx.paths;
  const how = `set regions[].mood in the world recipe (regionMoodSchema: sky, haze, light, shade, fogDensity, mist, saturation, contrast, temperature); a place's mood = a region within ${zone} with the place's id; the scene needs an entity running the zone-mood builtin (docs/zone-creation.md, "Look")`;
  const regions = (readJson(p.recipe) as { regions?: { id: string; within?: string; mood?: unknown }[] }).regions ?? [];
  const missing: string[] = [];
  if (!regions.find((r) => r.id === zone && r.within === undefined)?.mood) missing.push(`zone ${zone} has no mood`);
  const placesWithout = moodyPlaces.filter((id) => !regions.some((r) => r.id === id && r.within === zone && r.mood));
  if (placesWithout.length) missing.push(`${placesWithout.length} place mood(s) not applied (${placesWithout.slice(0, 3).join(", ")})`);
  const scene = path.join(p.projectDir, "assets", "scenes", `${ctx.world}.scene.json`);
  if (!exists(scene)) missing.push(`no scene ${ctx.world}`);
  else if (!fs.readFileSync(scene, "utf8").includes('"zone-mood"')) missing.push("the scene runs no zone-mood script");
  return { stage: "mood", who: "opus", state: missing.length ? "MISSING" : "ok", why: missing.join("; "), how };
}

/** The zones a world view summarises: from adjacency.json when it exists. */
export function zonesOf(ctx: Ctx): { id: string; name: string }[] {
  if (!exists(ctx.paths.adjacency)) return [];
  return (readJson(ctx.paths.adjacency) as Adjacency).zones.map((z) => ({ id: z.id, name: z.name }));
}

/** The bind row: from reports/bind.json; STALE when something it judged (scene, POI jobs, town docs, items) changed since. */
function bindRow(ctx: Ctx, zone: string, planned: number, how: string): Row {
  const p = ctx.paths;
  const report = readBindReport(ctx, zone);
  if (!report) return { stage: "bind", who: "procedural", state: "MISSING", why: planned ? `bind never run (${planned} planned quest(s))` : "no quest graph", how };
  const file = p.report("bind", zone);
  const bound = report.quests.filter((q) => q.state === "bound");
  const lost = bound.filter((q) => !exists(path.join(p.projectDir, "assets", "quests", `${q.id}.json`)));
  const tally = new Map<string, number>();
  for (const q of report.quests) for (const c of new Set(q.reasons.map((r) => r.code))) tally.set(c, (tally.get(c) ?? 0) + 1);
  const watched = [
    path.join(p.projectDir, "assets", "scenes", `${report.scene}.scene.json`),
    ...[...townNames(p, ctx.world).values()].map((n) => p.townDoc(n)),
    ...(fs.existsSync(path.join(p.zoneDir(zone), "pois")) ? fs.readdirSync(path.join(p.zoneDir(zone), "pois")).map((l) => path.join(p.zoneDir(zone), "pois", l, "progress.json")) : []),
    path.join(p.projectDir, "assets", "items"),
    // instance scenes a bound step happens in (a dungeon behind a portal): a rebuilt dungeon may move its boss
    ...[...new Set(report.quests.flatMap((q) => (q.instances ?? []).map((i) => i.scene)))].flatMap((s) => findSceneFile(path.resolve(p.projectDir, "..", ".."), s) ?? []),
  ];
  const late = watched.filter((w) => mtime(w) > mtime(file)).map((w) => path.basename(w));
  const blocked = report.quests.length - bound.length;
  const why = `${bound.length} of ${report.quests.length} bound${blocked ? `; blocked by ${[...tally].map(([c, n]) => `${c} ${n}`).join(", ")}` : ""}`;
  if (lost.length) return { stage: "bind", who: "procedural", state: "FAILED", why: `${lost.length} bound quest asset(s) missing: ${lost.slice(0, 3).map((q) => q.id).join(", ")}`, how };
  if (late.length) return { stage: "bind", who: "procedural", state: "STALE", why: `${why}; changed since it ran: ${late.slice(0, 3).join(", ")} (re-run: newly built things may unblock quests)`, how };
  return { stage: "bind", who: "procedural", state: blocked ? "MISSING" : "ok", why: blocked ? why : "", how };
}

/** "playable now": quests bound (reports/bind.json) and, of those, passing in the quest-play report. */
export function playable(ctx: Ctx, zone: string): { bound: number; played: number; planned: number } {
  const report = readBindReport(ctx, zone);
  const bound = new Set((report?.quests ?? []).filter((q) => q.state === "bound").map((q) => q.id));
  const play = path.join(ctx.paths.projectDir, "authoring", "reports", "quest-play", "quest-play.json");
  const passed = exists(play) ? ((readJson(play) as { quests?: { id: string; status?: string }[] }).quests ?? []).filter((q) => q.status === "pass" && bound.has(q.id)).length : 0;
  const g = exists(ctx.paths.quests(zone)) ? questGraphSchema.safeParse(readJson(ctx.paths.quests(zone))) : null;
  return { bound: bound.size, played: passed, planned: g?.success ? g.data.quests.length : 0 };
}
