/**
 * zonegen shared plumbing: where files live, loading with a schema, hashing, and the gate report every lint writes.
 * Commands (./commands/<name>.mts) export `run(ctx: Ctx): Promise<number>` (the exit code) and use only this module
 * for paths, so the layout is defined in one place.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { worldRecipeSchema, type WorldRecipe } from "@hitreg/core";
import { gateReportSchema, type GateReport } from "./schemas.mts";

export interface Ctx {
  /** Raw argv after the command and world. */
  argv: string[];
  project: string;
  world: string;
  /** `--zone <id>`; "" when the command is world-level. */
  zone: string;
  opt(name: string, fallback?: string): string;
  flag(name: string): boolean;
  paths: Paths;
}

export interface Paths {
  projectDir: string;
  recipe: string;
  /** authoring/zonegen */
  root: string;
  bestiary: string;
  /** authoring/zonegen/<world> */
  worldDir: string;
  adjacency: string;
  cast: string;
  links: string;
  zoneDir(zone: string): string;
  brief(zone: string): string;
  zoneBestiary(zone: string): string;
  quests(zone: string): string;
  reservations(zone: string): string;
  assets(zone: string): string;
  freeze(zone: string): string;
  /** Gate report of a stage: world-level when zone is "". */
  report(stage: string, zone?: string): string;
  townPlan(town: string): string;
  townDoc(town: string): string;
}

export function makePaths(project: string, world: string): Paths {
  const projectDir = path.resolve("projects", project);
  const root = path.join(projectDir, "authoring", "zonegen");
  const worldDir = path.join(root, world);
  const zoneDir = (zone: string): string => path.join(worldDir, "zones", zone);
  return {
    projectDir,
    recipe: path.join(projectDir, "assets", "worlds", `${world}.json`),
    root,
    bestiary: path.join(root, "bestiary.json"),
    worldDir,
    adjacency: path.join(worldDir, "adjacency.json"),
    cast: path.join(worldDir, "cast.json"),
    links: path.join(worldDir, "links.json"),
    zoneDir,
    brief: (zone) => path.join(zoneDir(zone), "brief.json"),
    zoneBestiary: (zone) => path.join(zoneDir(zone), "bestiary.json"),
    quests: (zone) => path.join(zoneDir(zone), "quests.json"),
    reservations: (zone) => path.join(zoneDir(zone), "reservations.json"),
    assets: (zone) => path.join(zoneDir(zone), "assets.json"),
    freeze: (zone) => path.join(zoneDir(zone), "freeze.json"),
    report: (stage, zone = "") => path.join(zone ? zoneDir(zone) : worldDir, "reports", `${stage}.json`),
    townPlan: (town) => path.join(projectDir, "authoring", "towns", `${town}-plan.json`),
    townDoc: (town) => path.join(projectDir, "authoring", "towns", `${town}.json`),
  };
}

export const exists = (file: string): boolean => fs.existsSync(file);
export const sha = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * PLANNING DIGESTS. A gate report and the freeze record a digest of each input, not a whole-file hash, because two
 * planning inputs are shared with the build stage, which legitimately writes into them:
 *  - a town plan (authoring/towns/<name>-plan.json): PLANNING = town, tier, arc, required, wealthTiers, the residents
 *    (every field), relationships, building ids/names/uses and structure ids/kinds/names — what `zonegen town`,
 *    `quests` and `manifest` judge. LAYOUT (owned by town-layout and the town planner's lot pass, never hashed) = the
 *    top-level note, lanes, and per building district/terrace/u/side/setback/street/model/request/planned, per
 *    structure note/by/at.
 *  - the world recipe: per zone, only that zone's region (id, name, level, polygon), its town zones and towns (ids,
 *    tiers), the POI sites its reservations name (id, kind, position) and whether the road/river/POI ids its
 *    approaches name exist; at world level, every region, every town's id/tier/tags, every POI, and the id +
 *    endpoints of every road a town did not lay (`<townId>-…` ramps, stairs and lanes are build output). Terraces,
 *    camps and earthworks never count.
 *  - the world cast and bestiary (shared by every zone, so one zone's planning must not stale another's): per zone,
 *    the cast's rules + that zone's row, and the bestiary factions/creatures that row or the zone bestiary names (by id,
 *    transitively through each kept faction). World-level gates hash both whole.
 * Also: a town doc counts only for {town, world} (its dialogue is the residents stage), a town survey only for
 * `coastal`, and generated JSON (adjacency.json, assets.json) by content without its `at` timestamp.
 * Bump DIGEST_VERSION whenever a projection changes: older freezes then read STALE ("re-run zonegen freeze").
 */
export const DIGEST_VERSION = 2;
const hashOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
const pick = (o: J | undefined, keys: string[]): J => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o![k]]));

/** The planning part of a town plan (see PLANNING DIGESTS). Exported so the split can be tested. */
export function planProjection(plan: J): J {
  return {
    ...pick(plan, ["town", "tier", "arc", "required", "wealthTiers", "residents", "relationships"]),
    buildings: ((plan.buildings ?? []) as J[]).map((b) => pick(b, ["id", "name", "use", "optional"])),
    structures: ((plan.structures ?? []) as J[]).map((x) => pick(x, ["id", "kind", "name"])),
  };
}

const townOwned = (recipe: J, id: string): boolean => ((recipe.features?.towns ?? []) as J[]).some((t) => id.startsWith(`${t.id}-`));
const ends = (pts: unknown): unknown => (Array.isArray(pts) && pts.length ? [pts[0], pts[pts.length - 1]] : []);

/** The part of the world recipe a zone's planning (or, zone "", the world's planning) depends on. */
export function recipeProjection(recipe: J, zone: string, reservations?: J): J {
  const regions = (recipe.regions ?? []) as J[];
  const towns = (recipe.features?.towns ?? []) as J[];
  const pois = (recipe.features?.pois ?? []) as J[];
  const roads = (recipe.features?.roads ?? []) as J[];
  if (!zone)
    return {
      regions: regions.map((r) => pick(r, ["id", "name", "within", "level", "polygon", "landmarks", "hub"])),
      towns: towns.map((t) => pick(t, ["id", "tier", "tags"])),
      pois: pois.map((x) => pick(x, ["id", "kind", "position"])),
      roads: roads.filter((r) => !townOwned(recipe, r.id)).map((r) => ({ id: r.id, ends: ends(r.points) })),
    };
  const townZones = regions.filter((r) => r.within === zone);
  const townIds = new Set(townZones.map((r) => r.landmarks?.[0]));
  const res = (reservations?.reservations ?? []) as J[];
  const sites = new Set(res.map((r) => r.site));
  const named = new Set(res.flatMap((r) => [r.approach?.from, ...((r.routes ?? []) as J[]).map((x) => x.from)]).filter(Boolean));
  const known = new Set([...roads, ...((recipe.features?.rivers ?? []) as J[]), ...pois, ...towns].map((x) => x.id));
  return {
    region: pick(regions.find((r) => r.id === zone && r.within === undefined), ["id", "name", "level", "polygon"]),
    townZones: townZones.map((r) => pick(r, ["id", "name", "polygon", "landmarks"])),
    towns: towns.filter((t) => townIds.has(t.id)).map((t) => pick(t, ["id", "tier"])),
    sites: pois.filter((x) => sites.has(x.id)).map((x) => pick(x, ["id", "kind", "position"])),
    approaches: [...named].sort().map((id) => [id, known.has(id)]),
  };
}

/** A zone's slice of the world cast: the rules and its own row (another zone's row is that zone's planning). */
export function castProjection(cast: J, zone: string): J {
  return { world: cast.world, rules: cast.rules, row: ((cast.rows ?? []) as J[]).find((r) => r.zone === zone) ?? null };
}

/**
 * A zone's slice of the world bestiary: the factions its cast row and zone bestiary name, and the creatures those
 * factions, that row or that bestiary name. A faction or creature another zone adds or edits is not this zone's plan.
 */
export function bestiaryProjection(bestiary: J, castRow: J | null, zoneBestiary: J | undefined): J {
  const names = new Set<string>();
  const collect = (v: unknown): void => {
    if (typeof v === "string") names.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  collect(castRow);
  collect(zoneBestiary);
  const factions = ((bestiary.factions ?? []) as J[]).filter((f) => names.has(f.id));
  collect(factions);
  return { version: bestiary.version, factions, creatures: ((bestiary.creatures ?? []) as J[]).filter((c) => names.has(c.id)) };
}

let recipeMemo: { file: string; mtime: number; raw: J } | null = null;
/**
 * The digest of one planning input: the hash of its planning content (see PLANNING DIGESTS), or of its bytes for a
 * file that is planning through and through. `zone` scopes the recipe ("" = the world's view of it).
 */
export function digest(paths: Paths, file: string, zone = ""): string {
  const norm = path.resolve(file).replaceAll("\\", "/");
  const base = path.basename(norm);
  const json = (): J => JSON.parse(fs.readFileSync(file, "utf8"));
  if (path.resolve(file) === path.resolve(paths.recipe)) {
    const mtime = fs.statSync(file).mtimeMs;
    if (!recipeMemo || recipeMemo.file !== norm || recipeMemo.mtime !== mtime) recipeMemo = { file: norm, mtime, raw: json() };
    const resFile = zone ? paths.reservations(zone) : "";
    const res = resFile && exists(resFile) ? (readJson(resFile) as J) : undefined;
    return hashOf({ v: DIGEST_VERSION, recipe: recipeProjection(recipeMemo.raw, zone, res) });
  }
  if (/\/authoring\/towns\/[^/]+-plan\.json$/.test(norm)) return hashOf({ v: DIGEST_VERSION, plan: planProjection(json()) });
  if (/\/authoring\/towns\/survey\/[^/]+\.json$/.test(norm)) return hashOf({ v: DIGEST_VERSION, coastal: json().coastal === true });
  if (/\/authoring\/towns\/[^/]+\.json$/.test(norm)) {
    const doc = json();
    if (doc.world !== undefined) return hashOf({ v: DIGEST_VERSION, townDoc: pick(doc, ["town", "world"]) });
  }
  if (zone && path.resolve(file) === path.resolve(paths.cast)) return hashOf({ v: DIGEST_VERSION, cast: castProjection(json(), zone) });
  if (zone && path.resolve(file) === path.resolve(paths.bestiary)) {
    const row = exists(paths.cast) ? castProjection(readJson(paths.cast) as J, zone).row : null;
    const zb = exists(paths.zoneBestiary(zone)) ? (readJson(paths.zoneBestiary(zone)) as J) : undefined;
    return hashOf({ v: DIGEST_VERSION, bestiary: bestiaryProjection(json(), row, zb) });
  }
  // the art manifest's PLAN is which assets the zone needs; a row's status/note is the art lane's progress (re-checked
  // against the disk by every manifest run), so art arriving never un-freezes the plan
  if (base === "assets.json" && Array.isArray(json().rows))
    return hashOf({ v: DIGEST_VERSION, assets: (json().rows as J[]).map((r) => pick(r, ["id", "kind", "for", "by"])) });
  if (base === "adjacency.json" || base === "assets.json") {
    const { at: _at, ...rest } = json();
    return hashOf({ v: DIGEST_VERSION, generated: rest });
  }
  return sha(file);
}
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export interface Finding {
  level: "error" | "warn";
  code: string;
  message: string;
  ref?: string;
}

/** Parse a planning file. A missing or invalid file becomes findings, never a throw, so a lint reports everything at once. */
export function load<S extends z.ZodType>(file: string, schema: S, findings: Finding[], what: string): z.infer<S> | null {
  if (!exists(file)) {
    findings.push({ level: "error", code: "missing-file", message: `${what} not written yet: ${path.relative(process.cwd(), file)}` });
    return null;
  }
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch (error) {
    findings.push({ level: "error", code: "bad-json", message: `${what}: ${(error as Error).message}` });
    return null;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) findings.push({ level: "error", code: "schema", message: `${what}: ${issue.path.join(".")}: ${issue.message}` });
    return null;
  }
  return parsed.data;
}

export function loadRecipe(paths: Paths): WorldRecipe {
  return worldRecipeSchema.parse(readJson(paths.recipe));
}

/**
 * Print findings, write the gate report, return the exit code. `inputs` are the files the gate read: their hashes
 * are what lets `zonegen status` call a passed gate STALE once one of them changes.
 */
export function finish(ctx: Ctx, stage: string, inputs: string[], all: Finding[]): number {
  // the same finding reached twice (two line-up rows wearing one theme) is printed and counted once
  const seen = new Set<string>();
  const findings = all.filter((f) => {
    const k = `${f.level}|${f.code}|${f.ref ?? ""}|${f.message}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const errors = findings.filter((f) => f.level === "error");
  const warns = findings.filter((f) => f.level === "warn");
  for (const f of findings) console.log(`  ${f.level === "error" ? "ERROR" : "warn "} ${f.code}${f.ref ? ` [${f.ref}]` : ""}: ${f.message}`);
  const report: GateReport = gateReportSchema.parse({
    stage,
    ok: errors.length === 0,
    at: new Date().toISOString(),
    v: DIGEST_VERSION,
    inputs: Object.fromEntries(inputs.filter(exists).map((file) => [path.relative(ctx.paths.projectDir, file).replaceAll("\\", "/"), digest(ctx.paths, file, ctx.zone)])),
    findings: findings.map((f) => ({ ...f, ref: f.ref ?? "" })),
  });
  writeJson(ctx.paths.report(stage, ctx.zone), report);
  console.log(`${stage}${ctx.zone ? ` (${ctx.zone})` : ""}: ${errors.length === 0 ? "ok" : `${errors.length} error(s)`}${warns.length ? `, ${warns.length} warning(s)` : ""}`);
  return errors.length === 0 ? 0 : 1;
}

/** Read a gate report and say whether it still stands: ok | STALE (an input changed) | MISSING | FAILED. */
export function gateState(paths: Paths, stage: string, zone = ""): { state: "ok" | "STALE" | "MISSING" | "FAILED"; why: string } {
  const file = paths.report(stage, zone);
  if (!exists(file)) return { state: "MISSING", why: "gate never run" };
  const parsed = gateReportSchema.safeParse(readJson(file));
  if (!parsed.success) return { state: "MISSING", why: "unreadable gate report" };
  const changed: string[] = [];
  for (const [rel, hash] of Object.entries(parsed.data.inputs)) {
    const full = path.join(paths.projectDir, rel);
    if (!exists(full)) changed.push(`${rel} (gone)`);
    // a report written before planning digests holds whole-file hashes: still valid while the bytes are unchanged
    else if (parsed.data.v === DIGEST_VERSION ? digest(paths, full, zone) !== hash : sha(full) !== hash) changed.push(rel);
  }
  if (changed.length) return { state: "STALE", why: `changed since the gate ran: ${changed.join(", ")}` };
  if (!parsed.data.ok) return { state: "FAILED", why: `${parsed.data.findings.filter((f) => f.level === "error").length} error(s)` };
  return { state: "ok", why: "" };
}
