/**
 * worldgen — the site-needs commands (tools/site-needs.mts holds the needs; this file is the CLI and the files).
 *
 *   worldgen towns <world> --propose [--roles walled-town,harbour-town,capital] [--per-role 6] [--out <dir>]
 *                                    [--no-renders] [--port 5297] [--scene <id>] [--needs-file <design/<town>/needs.json>]
 *     --needs-file: a town designer's needs file (siteRole, radius, siteNeeds overrides; tools/site-needs.mts
 *     placeNeedsFileSchema) gives the role, radius and overrides; the overrides ride in candidates.json to --pick.
 *     THE TOWN-SITING STEP IS AN AGENT STEP. Writes the candidate list per role, every candidate scored against its
 *     role's needs (met / unmet per need, with numbers), to authoring/siting/<world>/candidates.json, a plan-map crop
 *     (plan-<id>.png; needs assets/maps/<world>.base.png) and one far render of the BARE terrain per candidate
 *     (far-<id>.png, tools/light-shots.mts fixed camera on a probe port of its own, default 5297). A role no candidate
 *     meets gets a SHORTFALL with the ground need to ask the generator for (recipe `needs`, then `worldgen needs`).
 *     A fresh Opus siting agent reads it with tools/zonegen/briefs/site-towns.md and writes the choice file.
 *   worldgen towns <world> --pick <file> [--candidates <file>]
 *     Applies the choice file { towns: [{ role, candidate, why, town?, id?, tier?, rulings? }] } (schema below): refuses a
 *     candidate whose ground fails a need of its role (re-measured now) unless a dated ruling excepts that need;
 *     re-sites `town` (keeps id, tier, tags) or adds a new town; stamps `siteRole` and `keep: true`.
 *   worldgen needs <world> [--only <id>] [--check]
 *     Solves every recipe `needs` entry (cliff-face, walled-neck) into a `need-<id>` height patch and stamps `solved`;
 *     --check is the `needs` status row.
 *
 * Needs are measured on the NATURAL ground (towns' pads taken out), so a pad's flatten never hides a missing cliff.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createWorldField, TOWN_SITE_ROLES, type GroundNeedDoc, type TownDoc, type WorldField, type WorldRecipe } from "@hitreg/core";
import { farCamera, FAR_MAX_M, groundSpread, GROUNDLESS_STD } from "./_far-camera.mts";
import { decodePng, encodePng } from "./_png.mjs";
import { drawText as drawGlyphs } from "./_map-text.mts";
import { coastalFaults, findCoastalSites, measureCoastalSite } from "./worldgen-coastal-towns.mts";
import {
  compassWord, measureNeeds, needArea, needGroundOf, needRulingSchema, needsLine, needStillMet, solveCliffFace, solveRoadsideRib, solveWalledNeck, unexcepted,
  parsePlaceNeeds, type NeedGround, type NeedsReport, type SitedPlace, type SiteNeedOverrides, type SiteRole, type V2,
} from "./site-needs.mts";

export interface SiteNeedsHost {
  argv: string[];
  world: string;
  project: string;
  loadRecipe(): { recipe: WorldRecipe; file: string };
  writeRecipe(recipe: WorldRecipe, file: string): void;
  fail(message: string): never;
  tiers: readonly { name: string; radius: number }[];
  /** Drop a town's own ramps, stairs and terrace walls (they belong to the old site). */
  clearTownSite(recipe: WorldRecipe, townId: string): void;
}

const PLAYGROUND = path.resolve(import.meta.dirname, "..");
const r1 = (v: number) => Math.round(v * 10) / 10;

/** The recipe with every town pad taken out: needs are judged on the ground, not on a pad laid over it. */
export function naturalField(recipe: WorldRecipe): WorldField {
  if (!recipe.features.towns.length) return createWorldField(recipe);
  return createWorldField({ ...recipe, features: { ...recipe.features, towns: [] } });
}

/** The needs ground. `shoreField` (default `field`) answers the shore rule: the coastal rule is judged with the pads in
 *  place, as `worldgen towns` and the towns row judge it (a quay pad meets the water by design). */
export function needGround(recipe: WorldRecipe, field: WorldField, shoreField: WorldField = field, places: readonly SitedPlace[] = []): NeedGround {
  return needGroundOf(field as never, recipe.seaLevel, {
    coastal: (x, z, r) => coastalFaults(measureCoastalSite(shoreField, recipe, x, z, r)),
    roads: recipe.features.roads.filter((r) => !/-(lane|ramp|stair)-/.test(r.id)).map((r) => ({ id: r.id, points: r.points })),
    // the recipe's towns, then whatever the caller knows (every zone's reservations): distance-from / on-route refs
    places: [...recipe.features.towns.map((t): SitedPlace => ({ id: t.id, kind: "town", at: [t.center[0], t.center[1]], radius: t.radius })), ...places],
  });
}

/** Read a designer's needs file (authoring/design/<place>/needs.json; tools/site-needs.mts placeNeedsFileSchema). */
export function readNeedsFile(file: string): ReturnType<typeof parsePlaceNeeds> {
  if (!fs.existsSync(file)) throw new Error(`no needs file ${file}`);
  return parsePlaceNeeds(JSON.parse(fs.readFileSync(file, "utf8")), `${path.basename(path.dirname(file))}/${path.basename(file)}`);
}

/** The role a town is held to: its `siteRole`, else what its flags say. */
export function roleOfTown(t: TownDoc): SiteRole {
  if (t.siteRole) return t.siteRole;
  if (t.coastal) return "harbour-town";
  if (t.gates.length > 0 || t.tags.includes("walled")) return "walled-town";
  if ((t.tier ?? (t.tags.includes("capital") ? "capital" : "town")) === "capital") return "capital";
  return "town";
}

/** The `towns` status row's needs part: every town with a `siteRole` measured on the natural ground. */
export function townNeedsFindings(recipe: WorldRecipe): string[] {
  const roled = recipe.features.towns.filter((t) => t.siteRole);
  if (!roled.length) return [];
  const g = needGround(recipe, naturalField(recipe), createWorldField(recipe));
  const out: string[] = [];
  for (const t of roled) {
    const rep = measureNeeds(g, t.siteRole!, t.center[0], t.center[1], t.radius);
    for (const r of rep.results) if (!r.met) out.push(`${t.id} (${t.siteRole}) ${r.need}: ${r.message}`);
  }
  return out;
}

/** The `needs` status row: every recipe need solved and still measuring on the ground as it stands. */
export function needsStageCheck(recipe: WorldRecipe, field?: WorldField): string | null {
  const needs = recipe.needs ?? [];
  if (!needs.length) return null;
  const unsolved = needs.filter((n) => !n.solved);
  if (unsolved.length) return `${unsolved.length} ground need(s) not solved (${unsolved.map((n) => n.id).join(", ")}): worldgen needs <world>`;
  const missing = needs.filter((n) => n.solved!.patch && n.solved!.raised > 0 && !recipe.features.heightPatches.some((p) => p.id === n.solved!.patch));
  if (missing.length) return `${missing.length} need patch(es) gone (${missing.map((n) => n.solved!.patch).join(", ")}): re-run worldgen needs`;
  const g = needGround(recipe, field ?? naturalField(recipe));
  const bad = needs.map((n) => [n, needStillMet(g, n)] as const).filter(([, r]) => r && !r.met);
  return bad.length ? bad.map(([n, r]) => `need ${n.id} (${n.kind}) no longer measures: ${r!.message}`).join("; ") : null;
}

// ------------------------------------------------------------------ the choice file

export const pickFileSchema = z
  .object({
    candidates: z.string().optional().describe("The candidates.json the picks come from (default: candidates.json beside the pick file)."),
    towns: z
      .array(
        z.object({
          role: z.enum(TOWN_SITE_ROLES).describe("The role the town is sited for; its needs are re-measured and must be met."),
          candidate: z.string().min(1).describe("Candidate id from candidates.json (walled-town-2)."),
          why: z.string().min(1).describe("One line: why this ground carries the role (\"the only spur with cliff on three sides; the neck faces the coast road\")."),
          town: z.string().optional().describe("An existing town to re-site there (keeps id, tier, tags); omitted = a new town."),
          id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional().describe("A NEW town's id (the design's name, so place refs like `town:thirstgate` resolve); default town-<n>."),
          tier: z.enum(["capital", "city", "town", "village", "hamlet"]).optional().describe("A new town's tier (default: capital for the capital role, else town)."),
          rulings: z.array(needRulingSchema).default([]).describe("Dated coordinator rulings excepting a need this pick misses."),
        }),
      )
      .min(1),
  })
  .describe("The siting agent's choice file for `worldgen towns --pick`.");
export type PickFile = z.infer<typeof pickFileSchema>;

export interface TownCandidate {
  id: string;
  role: SiteRole;
  at: V2;
  y: number;
  radius: number;
  /** Bearing the far render looks FROM (the open / lowest side). */
  view: number;
  needs: NeedsReport;
  plan?: string;
  far?: string;
}

// ------------------------------------------------------------------ propose

const arg = (argv: string[], name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : fallback;
};
const num = (argv: string[], name: string, fallback: number): number => {
  const v = Number(arg(argv, name, ""));
  return Number.isFinite(v) && arg(argv, name, "") !== "" ? v : fallback;
};

function sitingDir(host: SiteNeedsHost): string {
  const out = arg(host.argv, "out", "");
  if (out) return path.resolve(out);
  if (!host.project) host.fail("--propose writes into a project (authoring/siting/<world>/): give --project <p>, or --out <dir>");
  return path.join(PLAYGROUND, "projects", host.project, "authoring", "siting", host.world);
}

const dirOf = (b: number): V2 => [Math.sin((b * Math.PI) / 180), -Math.cos((b * Math.PI) / 180)];

/** Grid cells worth measuring for a role, best prescore first. */
export function prescored(g: NeedGround, recipe: WorldRecipe, role: SiteRole, radius: number, step: number): { x: number; z: number; pre: number }[] {
  const limit = recipe.bounds?.limit ?? 3000;
  const out: { x: number; z: number; pre: number }[] = [];
  for (let z = -limit; z <= limit; z += step)
    for (let x = -limit; x <= limit; x += step) {
      if (g.wet(x, z)) continue;
      const h = g.height(x, z);
      if (h < recipe.seaLevel + 3 || h > recipe.seaLevel + 260) continue;
      const ring = [0, 90, 180, 270].map((b) => { const [dx, dz] = dirOf(b); return g.height(x + dx * radius, z + dz * radius); });
      if (ring.some((v, i) => g.wet(x + dirOf(i * 90)[0] * radius, z + dirOf(i * 90)[1] * radius) || Math.abs(v - h) > 30)) continue;
      let pre = -Math.max(...ring.map((v) => Math.abs(v - h)));
      if (role === "walled-town") {
        let protectedB = 0;
        for (let k = 0; k < 8; k++) { const [dx, dz] = dirOf(k * 45); const px = x + dx * (radius + 30), pz = z + dz * (radius + 30); if (g.wet(px, pz) || g.height(px, pz) < h - 8) protectedB++; }
        pre += protectedB * 10;
      } else if (role === "hill-town") {
        let ring150 = 0;
        for (let k = 0; k < 8; k++) { const [dx, dz] = dirOf(k * 45); ring150 += g.height(x + dx * (radius + 150), z + dz * (radius + 150)); }
        pre += (h - ring150 / 8) * 2;
      }
      out.push({ x, z, pre });
    }
  return out.sort((a, b) => b.pre - a.pre);
}

/**
 * The largest landmass, as a predicate: a town stands on the island's main land, never on an islet or a stack
 * (redstrand 2026-10-29: walled-town-1 / hill-town-2 and hill-town-1 were sited on offshore islets the coast-shape step
 * makes, and their far renders "looked at an islet instead of the candidate"). Sampled every `step` m, 4-connected.
 */
export function mainLandOf(g: Pick<NeedGround, "height" | "sea">, limit: number, step = 24): (x: number, z: number) => boolean {
  const n = Math.ceil((limit * 2) / step) + 1;
  const land = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const x = -limit + i * step, z = -limit + j * step; if (g.height(x, z) > g.sea + 0.5) land[i + j * n] = 1; }
  const comp = new Int32Array(n * n).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let s0 = 0; s0 < land.length; s0++) {
    if (!land[s0] || comp[s0]! >= 0) continue;
    const stack = [s0]; comp[s0] = id; let size = 0;
    while (stack.length) {
      const c = stack.pop()!; size++;
      const ci = c % n, cj = (c - ci) / n;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const k = ni + nj * n; if (land[k] && comp[k]! < 0) { comp[k] = id; stack.push(k); }
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  return (x, z) => {
    const i = Math.round((x + limit) / step), j = Math.round((z + limit) / step);
    if (i < 0 || j < 0 || i >= n || j >= n) return false;
    // a shore pad's centre may sample as water at this step: any of the 3x3 cells on the main land counts
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < n && b < n && comp[a + b * n] === best) return true; }
    return false;
  };
}

/** The open side to look at a site from: the bearing whose ground 300 m out is lowest (a far view over open land). */
function viewBearing(g: NeedGround, x: number, z: number): number {
  let best = 0, low = Infinity;
  for (let k = 0; k < 16; k++) { const [dx, dz] = dirOf(k * 22.5); const h = g.height(x + dx * 300, z + dz * 300); if (h < low) { low = h; best = k * 22.5; } }
  return best;
}

export async function commandTownsPropose(host: SiteNeedsHost): Promise<void> {
  const { argv } = host;
  const { recipe } = host.loadRecipe();
  const field = naturalField(recipe);
  const g = needGround(recipe, field);
  // --needs-file <design/<town>/needs.json>: the designer's role, radius and overrides (tools/site-needs.mts placeNeedsFileSchema)
  const needsFileArg = arg(argv, "needs-file", "");
  let designed: ReturnType<typeof readNeedsFile> | null = null;
  if (needsFileArg) { try { designed = readNeedsFile(path.resolve(needsFileArg)); } catch (e) { host.fail((e as Error).message); } }
  if (designed && !(TOWN_SITE_ROLES as readonly string[]).includes(designed.siteRole)) host.fail(`--needs-file: ${designed.id} is a ${designed.siteRole}, not a town role (site places with zonegen sites --needs-file)`);
  const asked = (arg(argv, "roles", "") || (designed?.siteRole ?? "")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const r of asked) if (!(TOWN_SITE_ROLES as readonly string[]).includes(r)) host.fail(`--roles ${r}: expected ${TOWN_SITE_ROLES.join(", ")}`);
  const roles = (asked.length ? asked : [...new Set(recipe.features.towns.map(roleOfTown))]) as SiteRole[];
  if (!roles.length) host.fail("no roles: give --roles walled-town,harbour-town,... (the world has no towns to read them from)");
  const perRole = num(argv, "per-role", 6);
  const spacing = num(argv, "spacing", 400);
  const dir = sitingDir(host);
  fs.mkdirSync(dir, { recursive: true });
  const tierRadius = (name: string) => host.tiers.find((t) => t.name === name)?.radius ?? 45;
  const onMain = mainLandOf(g, (recipe.bounds?.limit ?? 3000) + 1200);
  const out: { role: SiteRole; radius: number; overrides: SiteNeedOverrides; candidates: TownCandidate[]; shortfall: null | { best: string | null; unmet: string[]; ask: Partial<GroundNeedDoc> | null } }[] = [];
  for (const role of roles) {
    const own = designed && designed.siteRole === role ? designed : null;
    const overrides: SiteNeedOverrides = own?.siteNeeds ?? {};
    const radius = num(argv, "radius", own?.radius ?? (role === "capital" ? tierRadius("capital") : tierRadius("town")));
    const others = recipe.features.towns.filter((t) => roleOfTown(t) !== role);
    const clear = (x: number, z: number) => others.every((t) => Math.hypot(t.center[0] - x, t.center[1] - z) > t.radius + radius + 100);
    let cells: { x: number; z: number; pre: number }[];
    if (role === "harbour-town") {
      const found = findCoastalSites(field, recipe, radius, clear);
      cells = found.sites.map((s) => ({ x: s.x, z: s.z, pre: s.score }));
      if (!cells.length) console.log(`  ${role}: no shore site passes the coastal rule (${found.tried} tried): ${[...found.reasons.entries()].map(([k, v]) => `${k} x${v}`).join("; ")}`);
    } else cells = prescored(g, recipe, role, radius, num(argv, "step", 48)).filter((c) => clear(c.x, c.z));
    const before = cells.length;
    cells = cells.filter((c) => onMain(c.x, c.z));
    if (cells.length < before) console.log(`  ${role}: ${before - cells.length} candidate cell(s) off the main landmass (islets, stacks) dropped`);
    const measured: (TownCandidate & { pre: number })[] = [];
    for (const c of cells.slice(0, num(argv, "measure", 80))) {
      const needs = measureNeeds(g, role, c.x, c.z, radius, overrides, { self: own?.id });
      measured.push({ id: "", role, at: [Math.round(c.x), Math.round(c.z)], y: r1(g.height(c.x, c.z)), radius, view: viewBearing(g, c.x, c.z), needs, pre: c.pre });
    }
    const unmetCount = (c: TownCandidate) => c.needs.results.reduce((n, r) => n + r.faults.length, 0);
    measured.sort((a, b) => Number(b.needs.met) - Number(a.needs.met) || unmetCount(a) - unmetCount(b) || b.pre - a.pre);
    const kept: TownCandidate[] = [];
    for (const c of measured) {
      if (kept.length >= perRole) break;
      if (kept.some((k) => Math.hypot(k.at[0] - c.at[0], k.at[1] - c.at[1]) < spacing)) continue;
      const { pre: _pre, ...rest } = c;
      kept.push({ ...rest, id: `${role}-${kept.length + 1}` });
    }
    let shortfall: (typeof out)[number]["shortfall"] = null;
    if (!kept.some((c) => c.needs.met)) {
      const best = kept[0] ?? null;
      const unmet = best ? best.needs.results.filter((r) => !r.met).map((r) => `${r.need}: ${r.message}`) : ["no candidate ground at all"];
      const ask: Partial<GroundNeedDoc> | null = role === "walled-town" ? { id: `${role}-ground`, kind: "walled-neck", for: role, near: best ? best.at : [0, 0], within: 500, radius } : null;
      shortfall = { best: best?.id ?? null, unmet, ask };
    }
    out.push({ role, radius, overrides, candidates: kept, shortfall });
    console.log(`\n  ${role}${own ? ` (${own.id})` : ""} (pad r${radius}): ${kept.filter((c) => c.needs.met).length} of ${kept.length} candidate(s) meet every need (${measured.length} measured)`);
    for (const c of kept) console.log(`    ${c.id.padEnd(18)} [${c.at.join(", ")}] y${Math.round(c.y)}  ${needsLine(c.needs)}`);
    if (shortfall) {
      console.log(`    SHORTFALL: no candidate meets every need of ${role}; best ${shortfall.best ?? "-"} misses ${shortfall.unmet.join("; ")}`);
      if (shortfall.ask) console.log(`    ask the generator: add to the recipe \`needs\` ${JSON.stringify(shortfall.ask)}, then worldgen needs ${host.world}`);
      else console.log("    the generator makes cliff-face and walled-neck ground only; a harbour needs a coast plan cove (worldgen coast), a crossroads the paths stage");
    }
  }
  const all = out.flatMap((r) => r.candidates);
  if (!argv.includes("--no-renders") && all.length) await renderCandidates(host, recipe, dir, all, { ground: g.height, wet: g.wet });
  const doc = {
    world: host.world,
    at: new Date().toISOString(),
    note: "Needs measured on the natural ground (pads taken out). Pick with tools/zonegen/briefs/site-towns.md -> worldgen towns --pick <file>.",
    roles: out,
  };
  const file = path.join(dir, "candidates.json");
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  console.log(`\n  wrote ${path.relative(process.cwd(), file)}${all.some((c) => c.far) ? ` + ${all.filter((c) => c.far).length} far render(s)` : ""}${all.some((c) => c.plan) ? ` + ${all.filter((c) => c.plan).length} plan crop(s)` : ""}`);
  console.log(`  next: a fresh siting agent (tools/zonegen/briefs/site-towns.md) writes ${path.join(path.relative(process.cwd(), dir), "pick.json")}; then worldgen towns ${host.world}${host.project ? ` --project ${host.project}` : ""} --pick <it>`);
}

/**
 * The bare-terrain pictures of each candidate: a plan-map crop (zonegen map's headless map renderer over the world's
 * base picture) and ONE far render from the open side (tools/light-shots.mts, fixed cameras, no reference characters,
 * noon, its own vite on --port). Both are best effort: a missing base picture or scene is said, not fatal.
 */
export async function renderCandidates(host: Pick<SiteNeedsHost, "argv" | "world" | "project">, recipe: WorldRecipe, dir: string, cands: { id: string; at: V2; y: number; radius: number; view: number; plan?: string; far?: string }[], o: { readDistance?: number; ground?: (x: number, z: number) => number; wet?: (x: number, z: number) => boolean; prefix?: string } = {}): Promise<void> {
  const pre = o.prefix ?? "";
  const { argv } = host;
  const projectDir = host.project ? path.join(PLAYGROUND, "projects", host.project) : PLAYGROUND;
  // ---- plan crops
  const basePng = path.join(projectDir, "assets", "maps", `${host.world}.base.png`);
  if (!fs.existsSync(basePng)) console.warn(`  no plan crops: ${path.relative(process.cwd(), basePng)} missing (zonegen map ${host.world} --project ${host.project} --base)`);
  else {
    try {
      const map = (await import(pathToFileURL(path.join(PLAYGROUND, "tools", "zonegen", "commands", "map.mts")).href)) as { shootMap(o: unknown): Promise<string> };
      const layers = (await import(pathToFileURL(path.join(PLAYGROUND, "src", "map-layers.ts")).href)) as { collectMapData(r: unknown, s: unknown, e: unknown, w: string): unknown; layerCounts(d: unknown): unknown; DEFAULT_LAYERS: readonly string[] };
      const data = layers.collectMapData(recipe, null, { world: host.world }, host.world);
      const draw = String.raw`
for (const c of data.cands) {
  const x = toX(c.at[0]), y = toY(c.at[1]);
  ctx.strokeStyle = c.met ? "#69f0ae" : "#ff5252"; ctx.lineWidth = 3; ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(x, y, c.radius * scale, 0, Math.PI * 2); ctx.stroke();
  ctx.font = "bold 14px system-ui, sans-serif"; ctx.fillStyle = "rgba(0,0,0,0.75)";
  const t = c.id + (c.met ? "  needs met" : "  UNMET: " + c.unmet); const w = ctx.measureText(t).width + 8;
  ctx.fillRect(x - w / 2, y + c.radius * scale + 6, w, 18); ctx.fillStyle = "#fff"; ctx.fillText(t, x - w / 2 + 4, y + c.radius * scale + 20);
}`;
      for (const c of cands) {
        const span = Math.max(500, c.radius * 8);
        const view = { cx: c.at[0], cz: c.at[1], scale: 900 / span, width: 900, height: 900 };
        const out = path.join(dir, `plan-${pre}${c.id}.png`);
        const meta = c as { needs?: NeedsReport };
        const overlay = { data: { cands: [{ id: c.id, at: c.at, radius: c.radius, met: meta.needs?.met ?? true, unmet: meta.needs?.results.filter((r) => !r.met).map((r) => r.need).join(", ") ?? "" }] }, draw };
        const shot = await map.shootMap({ basePng, data, view, layers: new Set(layers.DEFAULT_LAYERS), title: `${c.id} · plan · ${(1 / view.scale).toFixed(1)} m/px`, counts: layers.layerCounts(data), out, overlay });
        if (shot) { console.warn(`  plan ${c.id}: ${shot}`); continue; }
        c.plan = path.basename(out);
      }
    } catch (e) { console.warn(`  plan crops skipped: ${(e as Error).message}`); }
  }
  // ---- far renders (the bare terrain: the world scene, no reference characters, a fixed camera per candidate)
  const scene = arg(argv, "scene", "") || findWorldScene(projectDir, host.world);
  if (!scene) { console.warn(`  no far renders: no scene streams ${host.world} (give --scene <id>)`); return; }
  const port = arg(argv, "port", "5297");
  if (["5173", "5287", "5291", "5293"].includes(port)) { console.warn(`  no far renders: port ${port} is not a probe port of this tool (default 5297)`); return; }
  const read = o.readDistance ?? 420;
  // a far camera ON LAND 300-400 m out (further only for a longer read distance), open side first, with a clear sight of
  // the pad and a frame that is not mostly sea (tools/_far-camera.mts; redstrand 2026-10-29: cameras stood at sea)
  const ground = o.ground ?? ((x: number, z: number) => createWorldField(recipe).height(x, z));
  const placed = cands.map((c) => ({ c, cam: farCamera({ at: c.at, y: c.y, view: c.view, ground, wet: o.wet, seaLevel: recipe.seaLevel, max: Math.max(FAR_MAX_M, Math.min(read, 600)) }) }));
  for (const { c, cam } of placed) {
    const meta = c as { farCamera?: unknown };
    meta.farCamera = cam ? { camera: cam.camera, bearing: cam.bearing, distance: cam.distance, water: cam.check.water } : { none: "no land point 300-400 m out sees the pad over mostly land" };
    if (!cam) console.warn(`  far ${c.id}: no camera on land 300-400 m out sees the pad over mostly land (no far render)`);
  }
  const spots = placed.filter((p) => p.cam).map(({ c, cam }) => ({ name: `${pre}${c.id}`, x: c.at[0], z: c.at[1], facing: (cam!.bearing + 180) % 360, camera: cam!.camera, target: cam!.target }));
  if (!spots.length) return;
  const shots = path.join(dir, `shots${pre ? `-${pre.replace(/-$/, "")}` : ""}`);
  fs.mkdirSync(shots, { recursive: true });
  const spotsFile = path.join(shots, "spots.json");
  fs.writeFileSync(spotsFile, JSON.stringify(spots, null, 2) + "\n");
  console.log(`  far renders: tools/light-shots.mts --scene ${scene} on :${port} (${spots.length} spot(s); minutes)`);
  const run = spawnSync(process.execPath, [path.join(PLAYGROUND, "node_modules", "tsx", "dist", "cli.mjs"), "tools/light-shots.mts", "--scene", scene, "--spots", spotsFile, "--out", shots, "--label", "siting", "--no-refs", "--times", "12", "--port", port, "--scope", String(read + 300), "--fixed-rig", "--spot-timeout", "300"], { cwd: PLAYGROUND, stdio: "inherit", timeout: 40 * 60_000 });
  if (run.status !== 0) { console.warn(`  far renders: light-shots exit ${run.status ?? run.signal}; see ${path.relative(process.cwd(), shots)}`); }
  for (const c of cands) {
    // <spot>-12.png, or <spot>-interior.png on a world with no clock
    const frames = path.join(shots, `${scene}-siting`);
    const hit = fs.existsSync(frames) ? fs.readdirSync(frames).find((x) => x === `${pre}${c.id}-12.png` || x === `${pre}${c.id}-interior.png`) : undefined;
    if (!hit) continue;
    const frame = path.join(frames, hit);
    // a frame whose ground never streamed in (sky over the sea plane) is not a picture of the site: no far-<id>.png
    const spread = groundSpread(decodePng(fs.readFileSync(frame)));
    if (spread < GROUNDLESS_STD) { console.warn(`  far render ${c.id}: NO GROUND drew (lower-frame luma spread ${spread.toFixed(1)} < ${GROUNDLESS_STD}) — re-render it (fewer spots per run)`); continue; }
    markFrame(frame, path.join(dir, `far-${pre}${c.id}.png`), c.id, (c as { farCamera?: { distance?: number; bearing?: number } }).farCamera);
    c.far = `far-${pre}${c.id}.png`;
  }
}

/** The far frame with the candidate marked: a ring at the frame centre (the camera aims at the pad) and its id + camera. */
function markFrame(src: string, dst: string, id: string, cam?: { distance?: number; bearing?: number }): void {
  const img = decodePng(fs.readFileSync(src));
  const { width: w, height: h, data } = img;
  const put = (x: number, y: number, c: [number, number, number]) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const o = (y * w + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255; };
  const cx = Math.round(w / 2), cy = Math.round(h / 2);
  for (let a = 0; a < 720; a++) { const t = (a / 720) * Math.PI * 2; for (const r of [22, 23, 24]) put(Math.round(cx + Math.cos(t) * r), Math.round(cy + Math.sin(t) * r), [255, 64, 64]); }
  for (let k = -6; k <= 6; k++) { put(cx + k, cy, [255, 64, 64]); put(cx, cy + k, [255, 64, 64]); }
  // label (the map font draws into an RGB buffer)
  const label = `${id}  ${cam?.distance ?? "?"} m from ${cam?.bearing ?? "?"} deg`.toUpperCase();
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = data[i * 4]!; rgb[i * 3 + 1] = data[i * 4 + 1]!; rgb[i * 3 + 2] = data[i * 4 + 2]!; }
  for (let y = 8; y < 34; y++) for (let x = 8; x < Math.min(w, 20 + label.length * 13); x++) { const o = (y * w + x) * 3; rgb[o] = 0; rgb[o + 1] = 0; rgb[o + 2] = 0; }
  drawGlyphs(rgb, w, 14, 14, label, [255, 255, 255], 2, h);
  for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[i * 3]!; data[i * 4 + 1] = rgb[i * 3 + 1]!; data[i * 4 + 2] = rgb[i * 3 + 2]!; }
  fs.writeFileSync(dst, encodePng(w, h, data));
}

function findWorldScene(projectDir: string, world: string): string {
  const dir = path.join(projectDir, "assets", "scenes");
  if (!fs.existsSync(dir)) return "";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".scene.json"));
  for (const f of [...files.filter((f) => f === `${world}.scene.json`), ...files]) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { entities?: Record<string, { components?: Record<string, { world?: string }> }> };
      if (Object.values(doc.entities ?? {}).some((e) => e.components?.["voxelWorld"]?.world === world)) return f.replace(/\.scene\.json$/, "");
    } catch { /* not a scene */ }
  }
  return "";
}

// ------------------------------------------------------------------ pick

export function commandTownsPick(host: SiteNeedsHost): void {
  const { argv } = host;
  const pickPath = path.resolve(arg(argv, "pick", ""));
  if (!fs.existsSync(pickPath)) host.fail(`--pick ${pickPath}: no such file`);
  const parsed = pickFileSchema.safeParse(JSON.parse(fs.readFileSync(pickPath, "utf8")));
  if (!parsed.success) host.fail(`--pick ${pickPath} is not a choice file:\n${parsed.error.message}`);
  const pick = parsed.data;
  const candFile = path.resolve(path.dirname(pickPath), arg(argv, "candidates", "") || pick.candidates || "candidates.json");
  if (!fs.existsSync(candFile)) host.fail(`no candidates file ${candFile} (worldgen towns --propose writes it)`);
  const roleRows = (JSON.parse(fs.readFileSync(candFile, "utf8")) as { roles: { role: SiteRole; overrides?: SiteNeedOverrides; candidates: TownCandidate[] }[] }).roles;
  const cands = new Map<string, TownCandidate>(roleRows.flatMap((r) => r.candidates).map((c) => [c.id, c]));
  const overridesOf = new Map(roleRows.map((r) => [r.role, r.overrides ?? {}] as const));
  const { recipe, file } = host.loadRecipe();
  const g = needGround(recipe, naturalField(recipe));
  const refused: string[] = [];
  const seen = new Set<string>();
  for (const row of pick.towns) {
    const c = cands.get(row.candidate);
    if (!c) { refused.push(`${row.candidate}: not in ${path.basename(candFile)}`); continue; }
    if (c.role !== row.role) { refused.push(`${row.candidate} was proposed for ${c.role}, picked as ${row.role}`); continue; }
    if (seen.has(row.candidate)) { refused.push(`${row.candidate} picked twice`); continue; }
    seen.add(row.candidate);
    const rep = measureNeeds(g, row.role, c.at[0], c.at[1], c.radius, overridesOf.get(row.role) ?? {}, { self: row.town ?? row.id });
    const miss = unexcepted(rep, row.rulings);
    if (miss.length) refused.push(`${row.candidate} (${row.role}) fails ${miss.map((r) => `${r.need}: ${r.message}`).join("; ")}`);
    if (row.town && !recipe.features.towns.some((t) => t.id === row.town)) refused.push(`${row.candidate}: town ${row.town} does not exist`);
    if (row.id && !row.town && recipe.features.towns.some((t) => t.id === row.id)) refused.push(`${row.candidate}: town id ${row.id} is taken (give it as \`town\` to re-site it)`);
  }
  if (refused.length) host.fail(`REFUSED (nothing written):\n  ${refused.join("\n  ")}\n  pick a candidate that meets its role's needs, or ask the generator for the ground (recipe needs + worldgen needs), or add a dated ruling`);
  const taken = new Set(recipe.features.towns.map((t) => t.id));
  let next = 1;
  for (const row of pick.towns) {
    const c = cands.get(row.candidate)!;
    const groundY = r1(g.height(c.at[0], c.at[1]));
    const old = row.town ? recipe.features.towns.find((t) => t.id === row.town)! : null;
    let doc: TownDoc;
    if (old) {
      host.clearTownSite(recipe, old.id);
      doc = { ...old, center: [c.at[0], c.at[1]], groundY, flatten: 0.95, terraces: [], gates: [], siteRole: row.role, keep: true, ...(row.role === "harbour-town" ? { coastal: true } : {}) };
      recipe.features.towns = recipe.features.towns.map((t) => (t === old ? doc : t));
    } else {
      if (!row.id) while (taken.has(`town-${next}`)) next++;
      const tier = row.tier ?? (row.role === "capital" ? "capital" : "town");
      const radius = host.tiers.find((t) => t.name === tier)?.radius ?? c.radius;
      doc = { id: row.id ?? `town-${next}`, tier, center: [c.at[0], c.at[1]], radius, falloff: r1(radius * 0.8), groundY, flatten: 0.95, gates: [], terraces: [], tags: [tier], siteRole: row.role, keep: true, ...(row.role === "harbour-town" ? { coastal: true } : {}) } as TownDoc;
      taken.add(doc.id);
      recipe.features.towns.push(doc);
    }
    console.log(`  ${doc.id} <- ${row.candidate} (${row.role}) [${doc.center.join(", ")}]: ${row.why}${row.rulings.length ? ` [ruled: ${row.rulings.map((r) => r.need).join(", ")}]` : ""}`);
  }
  host.writeRecipe(recipe, file);
  console.log(`  next: worldgen terrace ${host.world}, gates (walled towns), zones --towns-only, paths ...`);
}

// ------------------------------------------------------------------ worldgen needs

export function commandNeeds(host: SiteNeedsHost): void {
  const { argv } = host;
  const { recipe, file } = host.loadRecipe();
  if (argv.includes("--check")) {
    const why = needsStageCheck(recipe);
    console.log(why ? `needs: ${why}` : `needs: ok (${(recipe.needs ?? []).length} need(s))`);
    if (why) process.exitCode = 1;
    return;
  }
  const only = arg(argv, "only", "");
  const needs = (recipe.needs ?? []).filter((n) => !only || n.id === only);
  if (!needs.length) host.fail(only ? `no need ${only} in the recipe` : "the recipe has no `needs` (add one: { id, kind: cliff-face | walled-neck | roadside-rib, near: [x, z] | \"<zone> <side>\", minHeight / radius, neck })");
  const ids = new Set(needs.map((n) => `need-${n.id}`));
  // solve on the ground WITHOUT this run's own patches (re-running replaces them) and without town pads
  const base: WorldRecipe = { ...recipe, features: { ...recipe.features, towns: [], heightPatches: recipe.features.heightPatches.filter((p) => !ids.has(p.id)) } };
  let g = needGround(base, createWorldField(base));
  let failed = 0;
  for (const need of needs) {
    let area;
    try { area = needArea(need.near, need.within, recipe.regions as never); } catch (e) { console.error(`  ${need.id}: ${(e as Error).message}`); failed++; continue; }
    const s = need.kind === "cliff-face" ? solveCliffFace(g, need, area) : need.kind === "roadside-rib" ? solveRoadsideRib(g, need, area) : solveWalledNeck(g, need, area);
    if (!s.ok) { console.error(`  ${need.id} (${need.kind}): NOT SOLVED: ${s.message}`); failed++; continue; }
    recipe.features.heightPatches = recipe.features.heightPatches.filter((p) => p.id !== `need-${need.id}`);
    if (s.patch) {
      recipe.features.heightPatches.push(s.patch);
      // the next need is solved on the ground this one made (two needs side by side must not undo each other)
      base.features.heightPatches.push(s.patch);
      g = needGround(base, createWorldField(base));
    }
    need.solved = { at: s.at, faces: s.faces, height: s.height, patch: s.patch?.id ?? "", raised: s.raised, ran: new Date().toISOString() };
    console.log(`  ${need.id} (${need.kind}${need.for ? ` for ${need.for}` : ""}): ${s.message}; faces ${compassWord(s.faces)}`);
  }
  host.writeRecipe(recipe, file);
  const why = needsStageCheck(recipe);
  if (why) { console.error(`  needs check: ${why}`); process.exitCode = 1; }
  else if (!failed) console.log("  needs check: ok — re-run the stages downstream (rivers, towns --propose, zonegen sites)");
  if (failed) process.exitCode = 1;
}

// ------------------------------------------------------------------ check a designer's needs files (no world, no I/O beyond reading)
/**
 * `npx tsx tools/worldgen-site-needs.mts --check-needs <needs.json | design dir>`: validates every needs file (schema
 * plus `needsFor`: an added need must be complete) and prints its role and needs. Instant. Write no ad-hoc script for this.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href && process.argv.includes("--check-needs")) {
  const target = path.resolve(process.argv[process.argv.indexOf("--check-needs") + 1] ?? ".");
  const files = fs.statSync(target).isFile()
    ? [target]
    : [path.join(target, "needs.json"), ...fs.readdirSync(target).map((d) => path.join(target, d, "needs.json"))].filter((f) => fs.existsSync(f));
  let bad = 0;
  for (const f of files) {
    try { const n = readNeedsFile(f); console.log(`ok   ${path.relative(process.cwd(), f)}: ${n.id} (${n.kind}) ${n.siteRole}${n.radius ? ` r${n.radius}` : ""} -> ${n.needs.map((x) => x.kind).join(", ")}`); }
    catch (e) { bad++; console.error(`FAIL ${path.relative(process.cwd(), f)}: ${(e as Error).message}`); }
  }
  if (!files.length) { console.error(`no needs.json at ${target}`); bad++; }
  process.exitCode = bad ? 1 : 0;
}

/**
 * worldgen siting-map <world> --project <p>: ONE overview map of every candidate of every role proposed so far
 * (authoring/siting/<world>/candidates.json for towns + every <zone>-<role>[-<for>].json from `zonegen sites --propose`),
 * numbered per role, ringed green (needs met) or red, with a key down the right edge. Written to
 * authoring/siting/<world>/candidates-map.png so the owner sees WHERE the candidates are before any pick
 * (redstrand 2026-10-29: "where will the POIs and entrance go?").
 */
export async function commandSitingMap(host: SiteNeedsHost): Promise<void> {
  const { recipe } = host.loadRecipe();
  const dir = sitingDir(host);
  if (!fs.existsSync(dir)) host.fail(`no siting dir ${dir}: run towns --propose / zonegen sites --propose first`);
  const projectDir = path.join(PLAYGROUND, "projects", host.project);
  const basePng = path.join(projectDir, "assets", "maps", `${host.world}.base.png`);
  if (!fs.existsSync(basePng)) host.fail(`${basePng} missing (zonegen map ${host.world} --project ${host.project} --base)`);
  type C = { id: string; at: V2; radius: number; met: boolean; role: string };
  const cands: C[] = [];
  const add = (role: string, list: { id: string; at: V2; radius?: number; needs?: NeedsReport }[], radius: number) => {
    for (const c of list) cands.push({ id: c.id, at: c.at, radius: c.radius ?? radius, met: c.needs?.met ?? false, role });
  };
  const towns = path.join(dir, "candidates.json");
  if (fs.existsSync(towns)) for (const r of (JSON.parse(fs.readFileSync(towns, "utf8")) as { roles: { role: string; radius: number; candidates: TownCandidate[] }[] }).roles) add(r.role, r.candidates, r.radius);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "candidates.json" && x !== "pick.json" && !x.endsWith("-pick.json"))) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { role?: string; radius?: number; candidates?: { id: string; at: V2; needs?: NeedsReport }[] };
    if (doc.role && doc.candidates) add(doc.role,doc.candidates, doc.radius ?? 60);
  }
  if (!cands.length) host.fail("no candidates in " + dir);
  const roles = [...new Set(cands.map((c) => c.role))];
  const palette = ["#ffd54f", "#4fc3f7", "#f48fb1", "#aed581", "#ce93d8", "#ffab91", "#80cbc4", "#fff59d"];
  const colour = Object.fromEntries(roles.map((r, i) => [r, palette[i % palette.length]!]));
  const numbered = roles.flatMap((r) => cands.filter((c) => c.role === r).map((c, i) => ({ ...c, n: i + 1, colour: colour[r] })));
  const xs = cands.map((c) => c.at[0]), zs = cands.map((c) => c.at[1]);
  const pad = 400, W = 1600, H = 1200;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const scale = Math.min((W - 360) / (Math.max(...xs) - Math.min(...xs) + pad * 2), H / (Math.max(...zs) - Math.min(...zs) + pad * 2));
  const view = { cx: cx + 150 / scale, cz, scale, width: W, height: H };
  const map = (await import(pathToFileURL(path.join(PLAYGROUND, "tools", "zonegen", "commands", "map.mts")).href)) as { shootMap(o: unknown): Promise<string> };
  const layers = (await import(pathToFileURL(path.join(PLAYGROUND, "src", "map-layers.ts")).href)) as { collectMapData(r: unknown, s: unknown, e: unknown, w: string): unknown; layerCounts(d: unknown): unknown; DEFAULT_LAYERS: readonly string[] };
  const data = layers.collectMapData(recipe, null, { world: host.world }, host.world);
  const draw = String.raw`
for (const c of data.cands) {
  const x = toX(c.at[0]), y = toY(c.at[1]), r = Math.max(7, c.radius * scale);
  ctx.lineWidth = 3; ctx.strokeStyle = c.met ? "#69f0ae" : "#ff5252"; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = c.colour; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#000"; ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(c.n), x, y + 4);
}
ctx.textAlign = "left";
let ky = 300; const kx = ctx.canvas.width - 380;
ctx.fillStyle = "rgba(0,0,0,0.78)"; ctx.fillRect(kx - 10, ky - 24, 385, 22 + data.cands.length * 17 + data.roles.length * 8);
ctx.font = "bold 13px system-ui, sans-serif";
for (const role of data.roles) {
  for (const c of data.cands.filter((q) => q.role === role)) {
    ctx.fillStyle = c.colour; ctx.fillText(role + " " + c.n, kx, ky);
    ctx.fillStyle = c.met ? "#69f0ae" : "#ff8a80"; ctx.fillText((c.met ? "met " : "UNMET ") + c.id + " [" + c.at.map(Math.round).join(", ") + "]", kx + 150, ky);
    ky += 17;
  }
  ky += 8;
}`;
  const out = path.join(dir, "candidates-map.png");
  const shot = await map.shootMap({ basePng, data, view, layers: new Set(layers.DEFAULT_LAYERS), title: `${host.world} · siting candidates (ring green = needs met)`, counts: layers.layerCounts(data), out, overlay: { data: { cands: numbered, roles }, draw } });
  if (shot) host.fail(`siting-map: ${shot}`);
  console.log(`wrote ${path.relative(process.cwd(), out)}  (${cands.length} candidates, ${roles.length} roles: ${roles.join(", ")})`);
}
