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
 * A place needs no world freeze: its stages stand on its LOCAL ground (below), so bare-renders follows an ok `sited`
 * (2026-10-29 coordinator). A world without a stages file is not enforced.
 *
 * LOCAL GROUND (2026-10-29 redstrand c-concepts: a whole-world hash staled every painting on any world write, so no
 * place could start while a far fix ran): a PLACE stage hangs on `localGround` — the terrain shape, water, roads and
 * needs inside the place's footprint (its site circle + every concept camera and the sight line to it), never the whole
 * world and never scatter / cover / mood / surfaces / textures (a painting replaces those). A write elsewhere leaves the
 * place ok; a write inside its footprint stales it and names the part that moved. World stages keep the world hash.
 *
 * ART MODE (Derek 2026-10-29: "many POIs need NO artwork — small camps are made from assets we already have"): a place
 * is `art: "painted"` (sited -> bare-renders -> concept-painted -> concept-approved -> design ...) or `art: "catalogue"`
 * (sited -> bare-renders -> design ...: no painting, no approval; its design names catalogue props only and a Codex /
 * prop request in it refuses `--done design`). Default: small / roadside / camp roles catalogue, the rest painted.
 *
 * Enforcement (each a small hook in the real command): `zonegen concept` (sited on its local ground), `place-build
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

const footprintSchema = z.object({
  center: z.tuple([z.number(), z.number()]),
  radius: z.number().describe("Site radius + margin (m)."),
  views: z.array(z.tuple([z.number(), z.number()])).default([]).describe("Concept camera eyes [x, z]; the line from each to the centre is in the footprint."),
  corridor: z.number().default(30).describe("Half-width (m) of each sight line and the reach round each eye."),
}).describe("The ground a place stands on and is seen over.");
export type Footprint = z.infer<typeof footprintSchema>;

const stageRecordSchema = z.object({
  at: z.string().describe("ISO time the stage was recorded."),
  worldHash: z.string().describe("worldHash() of the world recipe when the stage was done. `backfill:unknown` = done before the stage machine existed, on a world nobody hashed (reads STALE)."),
  by: z.string().optional().describe("Who did it: the tool (`zonegen concept`), an agent name, `derek`, or `coordinator`."),
  evidence: z.string().optional().describe("The file that proves the stage, relative to the project dir (a concept sheet, a review, a design). Changed later = the stage is STALE."),
  evidenceSha: z.string().optional().describe("sha256 of the evidence file when recorded."),
  approves: z.string().optional().describe("Approvals only: sha256 of the sheet / plan picture that was approved; a repaint after approval makes the approval STALE."),
  ruling: z.string().optional().describe("A dated ruling (YYYY-MM-DD ...) — required for a coordinator approval, an unfreeze, or a status-clean allowance."),
  site: z.object({ center: z.tuple([z.number(), z.number()]), radius: z.number() }).optional().describe("`sited` only: the reservation (POI) or town centre + radius it was sited at; moved = STALE."),
  ground: z.object({
    footprint: footprintSchema,
    hash: z.string().describe("localGround() hash of the footprint when the stage was done."),
    parts: z.record(z.string(), z.string()).describe("Short hash per ground part (`world:terrain`, `roads/path-a`, ...): a change names the part that moved."),
  }).optional().describe("Place stages: the LOCAL ground the stage stands on. A record without it (older) is checked against the whole-world hash."),
  note: z.string().optional().describe("Free text: what was done, what was allowed."),
  frames: z.record(z.string(), z.string()).optional().describe("`concept-painted` only: sha256 of each painted frame (path relative to the project dir). A `--renders-only` re-render carries the record forward only while every frame still has this hash."),
});
export type StageRecord = z.infer<typeof stageRecordSchema>;

/** A part of the local ground accepted at a given state (roads/<id> -> its short hash; "" = the part is gone). */
const groundRulingSchema = z.object({
  at: z.string(),
  by: z.string().optional(),
  kind: z.enum(["road-trim", "ruling"]).describe("road-trim: written by `road-net --fold` (or `stages --road-trim`): road cells cut out of a doubled stretch, the kept tread unchanged. ruling: a dated coordinator ruling against a stage diff (`stages --ground-ruling`)."),
  ruling: z.string().optional().describe("The dated ruling (kind ruling) or what was folded (road-trim)."),
  place: z.string().optional().describe("Only this place (a ruling); absent = every place (a road trim)."),
  parts: z.record(z.string(), z.array(z.string())).describe("Ground part -> its accepted short hashes after the change, one per footprint it was seen from (a road part hashes only the segments that reach a place; \"\" = gone)."),
});
/** The stages a ROAD TRIM leaves to be re-checked (by the seated / float / lips gates, then `stages --recheck`): nothing is
 *  repainted, redrawn or re-reviewed for a road that only lost a doubled stretch (2026-10-31 coordinator: a fold under the
 *  Red Dial staled every stage from bare-renders to design-review and asked for a Codex repaint of an approved place). */
export const TRIM_STAGES = ["sited", "installed"] as const;

const placeSchema = z.object({
  id: z.string().describe("The place id: a reservation `location` (POI, entrance) or a recipe town id (town)."),
  kind: z.enum(["poi", "entrance", "town"]).describe("town adds the town-design + plan-approved stages before grey-box."),
  role: z.string().describe("The siting role it fills (one of the world's `roles`)."),
  zone: z.string().optional().describe("The zone (reservations live per zone). Towns may omit it."),
  name: z.string().optional().describe("Other names commands use for it: a town's file stem (authoring/towns/<name>-*.json), a concept id."),
  art: z.enum(["painted", "catalogue"]).optional().describe("painted: a Codex concept painting + approval before design. catalogue: no artwork — bare renders then a design from catalogue props only (no Codex / prop requests). Omitted: small / roadside / camp roles are catalogue, everything else painted (Derek 2026-10-29)."),
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
  groundRulings: z.array(groundRulingSchema).default([])
    .describe("Ground changes that do not redo a place's work: a ROAD TRIM (`worldgen road-net --fold` cut a doubled stretch out of a road, no regrade) or a coordinator ruling. A record whose ground moved ONLY by parts listed here (at exactly these hashes) is not STALE, except the TRIM_STAGES that the gates re-check."),
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
/** Top-level design.json fields that hold a coordinator ruling or bookkeeping (tools/poi-review/job.mjs DESIGN_RULING_KEY):
 *  recording a ruling never stales the design stage or its review (L o-small 2026-10-29). */
const RULING_KEY = (k: string): boolean => k === "size" || /Ruling$/.test(k);
/** The ground-stamp fields of a concept site manifest (tools/poi-review/concept-site.mjs stampOf + restamp log). */
export const SITE_STAMP_KEYS = new Set(["fingerprint", "fingerprintParts", "featuresUnder", "restamps"]);
/** A stage evidence hash: a design.json is hashed without its ruling fields, any other file by its bytes. */
export function evidenceSha(f: string): string | null {
  if (!fs.existsSync(f)) return null;
  if (path.basename(f) === "design.json") {
    try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) return sha256(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k]) => !RULING_KEY(k)))))); } catch { /* not JSON: its bytes */ }
  }
  // a concept SITE manifest is hashed without its ground stamp: `concept-site restamp` (a key-set change, the ground
  // provably unmoved) rewrites only the stamp and must not stale bare-renders (o-gates 2026-10-30)
  if (/.site.json$/.test(f)) {
    try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j && typeof j === "object" && !Array.isArray(j)) return sha256(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k]) => !SITE_STAMP_KEYS.has(k)))))); } catch { /* not JSON: its bytes */ }
  }
  return fileSha(f);
}

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
/** The place's art mode: its `art`, else by role (small / roadside / camp POIs are catalogue). */
export const artOf = (p: Pick<Place, "kind" | "role" | "art">): "painted" | "catalogue" =>
  p.art ?? (p.kind === "poi" && /small|roadside|camp/.test(p.role) ? "catalogue" : "painted");
const PAINT_STAGES = new Set(["concept-painted", "concept-approved"]);
export const stagesOf = (p: Pick<Place, "kind" | "role" | "art">): readonly string[] => {
  const all = p.kind === "town" ? TOWN_STAGES : POI_STAGES;
  return artOf(p) === "catalogue" ? all.filter((s) => !PAINT_STAGES.has(s)) : all;
};
const NEW_ART = (s: string): boolean => /\bcodex\b(?!-craft)/i.test(s) || /\b(prop|codex|art) requests?\b/i.test(s);
/** A catalogue place's design may not ask for new art: a Codex / prop-request mention or a non-empty request field is a
 *  fault (`codex-craft/<id>` is a catalogue prop and is fine). */
export function catalogueDesignFaults(text: string): string[] {
  const faults: string[] = [];
  let j: unknown;
  try { j = JSON.parse(text); } catch { j = undefined; }
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (/^(codex\w*|prop ?requests?|requests?|codexRequests?)$/i.test(k) && x && (!Array.isArray(x) || x.length)) faults.push(`${at}.${k}: a request field`);
        walk(x, `${at}.${k}`);
      }
    } else if (typeof v === "string" && NEW_ART(v)) faults.push(`${at}: "${v.slice(0, 90)}"`);
  };
  if (j !== undefined) walk(j, "design");
  else text.split(/\r?\n/).forEach((l, i) => { if (NEW_ART(l)) faults.push(`line ${i + 1}: "${l.trim().slice(0, 90)}"`); });
  return faults;
}
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
  // a town wall fitter's own patches are `tw-<wall id>` (tw-<town>-plan-<terrace>, 2026-10-30 town-1 grey box)
  for (const t of townIds) if (id.startsWith(`${t}-`) || id === `town-plan-${t}` || id.startsWith(`tw-${t}-`)) return true;
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

// ------------------------------------------------------------------ the local ground hash

/** Recipe keys that never shape the ground a place stands on (stamps, labels, paint, plants, air). Anything else — the
 *  seed, bounds, terrain noise, climate relief anchors, a key added later — counts everywhere. */
const NOT_LOCAL_GROUND = new Set(["features", "pipeline", "name", "version", "surfaces", "biomes", "patches", "scatter", "cover", "regions",
  "macroNoise", "material", "waterMaterial", "riverMaterial", "marshMaterial", "bridgeMaterial", "splat", "zoneGround", "rockSkins", "textureFilter"]);
/** Feature kinds that are plants / paint only. */
const NOT_GROUND_KINDS = new Set(["clearings", "fields"]);
/** Feature fields that only paint or label (never move ground or water). */
const PAINT_FIELDS = new Set(["surface", "surfaceEdge", "surfaceByBiome", "turf", "mood", "scatter", "cover", "rules", "tags", "name", "story", "reason"]);
const LINE_KEYS = ["points", "along"];
const AREA_KEYS = ["polygon", "footprint"];
// "from"/"to": an operator doc's source and toe (scree); a doc with no key it knows counts EVERYWHERE, so a scree fan by
// Rustgut staled every place in the world (w15)
const POINT_KEYS = ["center", "position", "near", "at", "start", "end", "from", "to"];
const REACH_KEYS = ["radius", "falloff", "width", "reach", "within", "inland", "terrainRadius", "feather", "bank"];
type P2 = [number, number];
const toXZ = (v: unknown): P2 | null => (Array.isArray(v) && typeof v[0] === "number" ? (v.length >= 3 ? [v[0], v[2] as number] : [v[0], v[1] as number]) : null);
const ptsOf = (v: unknown): P2[] => { const one = toXZ(v); if (one) return [one]; return Array.isArray(v) ? v.flatMap(ptsOf) : []; };
const segDist = (p: P2, a: P2, b: P2): number => {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = dx * dx + dz * dz;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
};
/** The footprint as probe discs: the site disc, each camera eye, and samples every 10 m along each sight line. */
function probes(fp: Footprint): { p: P2; r: number }[] {
  const out = [{ p: fp.center, r: fp.radius }];
  for (const e of fp.views) {
    const n = Math.max(1, Math.ceil(Math.hypot(e[0] - fp.center[0], e[1] - fp.center[1]) / 10));
    for (let i = 0; i <= n; i++) out.push({ p: [e[0] + (fp.center[0] - e[0]) * (i / n), e[1] + (fp.center[1] - e[1]) * (i / n)], r: fp.corridor });
  }
  return out;
}
/** Does a feature's geometry come within reach of the footprint? A feature with no coordinates counts (it may shape everything). */
function reachesFootprint(f: J, pr: { p: P2; r: number }[]): boolean {
  let reach = 0;
  for (const k of REACH_KEYS) if (typeof f[k] === "number" && Number.isFinite(f[k])) reach = Math.max(reach, f[k]);
  if (Array.isArray(f.widths)) for (const w of f.widths) if (typeof w === "number") reach = Math.max(reach, w);
  const lines = LINE_KEYS.map((k) => ptsOf(f[k])).filter((l) => l.length);
  const points = POINT_KEYS.flatMap((k) => ptsOf(f[k]));
  if (f.solved) points.push(...ptsOf(f.solved.at));
  // a rock set's instances (an operator's `rocks` piece)
  if (Array.isArray(f.rocks)) for (const r of f.rocks as J[]) points.push(...ptsOf(r?.at));
  const boxes: [number, number, number, number][] = [];
  for (const k of AREA_KEYS) { const a = ptsOf(f[k]); if (a.length) boxes.push([Math.min(...a.map((q) => q[0])), Math.min(...a.map((q) => q[1])), Math.max(...a.map((q) => q[0])), Math.max(...a.map((q) => q[1]))]); }
  const o = toXZ(f.origin), sz = toXZ(f.size) ?? (Array.isArray(f.size) ? [f.size[0], f.size[1]] as P2 : null);
  if (o && sz) boxes.push([o[0], o[1], o[0] + sz[0], o[1] + sz[1]]);
  if (!lines.length && !points.length && !boxes.length) return true;
  for (const { p, r } of pr) {
    const lim = r + reach;
    if (points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= lim)) return true;
    for (const l of lines) for (let i = 0; i < l.length; i++) if (segDist(p, l[i]!, l[Math.min(i + 1, l.length - 1)]!) <= lim) return true;
    for (const [x0, z0, x1, z1] of boxes) if (Math.hypot(Math.max(x0 - p[0], 0, p[0] - x1), Math.max(z0 - p[1], 0, p[1] - z1)) <= lim) return true;
  }
  return false;
}
const strip = (f: J): J => Object.fromEntries(Object.entries(f).filter(([k]) => !PAINT_FIELDS.has(k)));
/** How far a road's ground influence reaches past its band (m): the seam blend and the lattice beside the band. */
export const ROAD_GROUND_MARGIN = 15;
/**
 * The part of a ROAD that can move a footprint's ground: its segments whose band (half width + shoulder + smooth) plus
 * ROAD_GROUND_MARGIN reaches a probe, one segment either side (the seam blend mixes neighbours), with the per-point
 * values at their ends and the doc's scalars. Null when no segment reaches. Hashing the whole doc made an edit 400 m
 * along the road stale every place it passes (2026-10-30 redstrand w13: trimming the first point of a path piece by
 * lake-1 staled red-dial at its far end).
 */
export function roadLocal(f: J, pr: { p: P2; r: number }[]): J | null {
  const pts = ptsOf(f.points);
  if (pts.length < 2) return reachesFootprint(f, pr) ? strip(f) : null;
  const band = (Number(f.width) || 0) / 2 + (Number(f.shoulder) || 0) + (Number(f.smooth) || 0) + ROAD_GROUND_MARGIN;
  const hit = new Set<number>();
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pr.some(({ p, r }) => segDist(p, pts[i]!, pts[i + 1]!) <= r + band)) for (const k of [i - 1, i, i + 1]) if (k >= 0 && k + 1 < pts.length) hit.add(k);
  }
  if (!hit.size) return null;
  const idx = [...new Set([...hit].flatMap((k) => [k, k + 1]))].sort((a, b) => a - b);
  const out: J = {};
  for (const [k, v] of Object.entries(strip(f))) {
    if (Array.isArray(v) && v.length === pts.length) out[k] = idx.map((i) => v[i]);
    else out[k] = v;
  }
  return out;
}
const short12 = (s: string): string => sha256(s).slice(0, 12);
/** The parsed recipe (parse once, hash many footprints). */
export const parseRecipe = (raw: unknown): J => worldRecipeSchema.parse(raw) as J;
/**
 * The LOCAL ground under a footprint: every global ground key (seed, bounds, terrain noise without its sea-cliff list,
 * climate relief, ...) plus every world feature, sea-cliff stretch and need that reaches the footprint, with paint-only
 * fields dropped and the places' own builds left out. Returns the hash and a short hash per part, so a change can say
 * WHICH part moved.
 */
export function localGround(recipe: J, fp: Footprint, placeIds: Iterable<string> = [], scheme: GroundScheme = "segments"): { hash: string; parts: Record<string, string> } {
  const pr = probes(fp);
  const towns = ((recipe.features?.towns ?? []) as J[]).map((t) => String(t.id));
  const own = new Set(placeIds), townIds = new Set(towns);
  const parts: Record<string, string> = {};
  for (const [k, v] of Object.entries(recipe)) {
    if (NOT_LOCAL_GROUND.has(k) || v === undefined) continue;
    if (k === "terrain" && v && typeof v === "object") {
      const { seaCliffs, ...rest } = v as J;
      parts["world:terrain"] = short12(stable(rest));
      for (const c of (seaCliffs ?? []) as J[]) if (reachesFootprint(c, pr)) parts[`seaCliffs/${c.id}`] = short12(stable(strip(c)));
    } else if (k === "needs" && Array.isArray(v)) {
      for (const n of v as J[]) if (reachesFootprint(n, pr)) parts[`needs/${n.id}`] = short12(stable(strip(n)));
    } else parts[`world:${k}`] = short12(stable(v));
  }
  for (const [kind, list] of Object.entries((recipe.features ?? {}) as J)) {
    if (!Array.isArray(list) || NOT_GROUND_KINDS.has(kind)) continue;
    list.forEach((f: J, i: number) => {
      if (kind === "towns") { if (reachesFootprint({ center: f.center }, pr)) parts[`towns/${f.id}`] = short12(stable({ id: f.id, tier: f.tier, siteRole: f.siteRole, center: f.center })); return; }
      if (placeOwned(f, own, townIds)) return;
      if (kind === "roads" && scheme === "segments") {
        const local = roadLocal(f, pr);
        if (local) parts[`${kind}/${f.id ?? i}`] = short12(stable(local));
        return;
      }
      if (!reachesFootprint(f, pr)) return;
      parts[`${kind}/${f.id ?? i}`] = short12(stable(strip(f)));
    });
  }
  return { hash: sha256(stable(parts)), parts };
}
/**
 * Records made before 2026-10-30 hashed every reaching road as its whole doc ("doc"). `rehashGround` moves them to the
 * segment scheme on the world they were made on (`was`): a record whose doc-scheme hash on `was` matches is re-hashed
 * there; any other is left alone (it was already stale there, and stays so).
 */
export type GroundScheme = "segments" | "doc";
export function rehashGround(doc: WorldStages, was: J): { rehashed: string[]; left: string[] } {
  const ids = doc.places.map((p) => p.id), rehashed: string[] = [], left: string[] = [];
  for (const p of doc.places) for (const [stage, r] of Object.entries(p.stages)) {
    if (!r?.ground) continue;
    const old = localGround(was, r.ground.footprint, ids, "doc");
    if (old.hash !== r.ground.hash) { left.push(`${p.id}:${stage}`); continue; }
    const now = localGround(was, r.ground.footprint, ids, "segments");
    r.ground = { ...r.ground, hash: now.hash, parts: now.parts };
    rehashed.push(`${p.id}:${stage}`);
  }
  return { rehashed, left };
}
/** What moved between two part maps, as `roads/path-a changed`, `lakes/lake-2 new`, `needs/x gone`. */
export function groundDiff(was: Record<string, string>, now: Record<string, string>): string[] {
  const out: string[] = [];
  for (const k of Object.keys({ ...was, ...now }).sort()) {
    if (!(k in now)) out.push(`${k} gone`);
    else if (!(k in was)) out.push(`${k} new`);
    else if (was[k] !== now[k]) out.push(`${k} changed`);
  }
  return out;
}
/** The footprint a place stands on now: its site (+ 40 m) and the cameras of its current concept manifest. */
export function currentFootprint(projectDir: string, doc: WorldStages, p: Place): Footprint | null {
  const site = currentSite(projectDir, doc, p);
  if (!site) return null;
  const views: P2[] = [];
  const mf = conceptManifest(projectDir, doc, p);
  if (fs.existsSync(mf)) {
    try {
      const m = readJson(mf);
      const c = m.reservation?.center;
      if (Array.isArray(c) && Math.hypot(c[0] - site.center[0], c[1] - site.center[1]) <= 0.5)
        for (const r of Object.values((m.renders ?? {}) as J)) { const e = toXZ(r?.camera); if (e) views.push([Math.round(e[0]), Math.round(e[1])]); }
    } catch { /* no cameras */ }
  }
  return { center: site.center, radius: site.radius + 40, views, corridor: 30 };
}
/** The `ground` a record made now carries. */
export function groundRecord(projectDir: string, doc: WorldStages, p: Place, recipe?: J): StageRecord["ground"] | undefined {
  const fp = currentFootprint(projectDir, doc, p);
  const f = recipeFile(projectDir, doc.world);
  if (!fp || (!recipe && !fs.existsSync(f))) return undefined;
  const g = localGround(recipe ?? parseRecipe(readJson(f)), fp, doc.places.map((x) => x.id));
  return { footprint: fp, hash: g.hash, parts: g.parts };
}

/**
 * Does a set of ground rulings cover a record's whole ground diff? Every part that differs between the record and now
 * must be listed by one entry (for every place, or this one) at exactly its current hash ("" = gone). Returns the
 * covering kind ("road-trim (<what>)" / "ruling <text>") or null. Pure.
 */
export function coveringRulings(doc: Pick<WorldStages, "groundRulings">, placeId: string | undefined, was: Record<string, string>, now: Record<string, string>): string | null {
  const rulings = (doc.groundRulings ?? []).filter((g) => !g.place || g.place === placeId);
  if (!rulings.length) return null;
  const keys = Object.keys({ ...was, ...now }).filter((k) => was[k] !== now[k]);
  if (!keys.length) return null;
  const used = new Set<(typeof rulings)[number]>();
  for (const k of keys) {
    const want = now[k] ?? "";
    const g = rulings.find((x) => x.parts[k]?.includes(want));
    if (!g) return null;
    used.add(g);
  }
  // a ruling outranks a road trim: a place a ruling covers is not even re-checked
  const list = [...used];
  const ruling = list.find((g) => g.kind === "ruling");
  if (ruling && list.every((g) => g.kind === "ruling")) return `ruling ${ruling.ruling ?? ""}`.trim();
  return `road-trim (${list.map((g) => g.ruling ?? g.at).filter((v, i, a) => a.indexOf(v) === i).join("; ")})`;
}

/**
 * Record a ROAD TRIM: the given roads were folded (doubled stretches cut out, the kept tread not regraded). For every
 * place record whose ground diff names one of those roads (or a piece of one), the road part's CURRENT hash is accepted.
 * Returns the parts recorded. `worldgen road-net --fold --write` calls it after writing; `stages --road-trim` backfills.
 */
export function recordRoadTrim(doc: WorldStages, recipe: J, roadIds: readonly string[], what: string, by?: string): Record<string, string[]> {
  const base = (id: string) => id.replace(/(\.[sj]?\d+)+$/, "");
  const ids = new Set(roadIds.flatMap((id) => [id, base(id)]));
  const placeIds = doc.places.map((p) => p.id);
  const parts: Record<string, string[]> = {};
  const cache = new Map<string, { hash: string; parts: Record<string, string> }>();
  for (const p of doc.places) for (const r of Object.values(p.stages)) {
    if (!r.ground) continue;
    const key = stable(r.ground.footprint);
    let now = cache.get(key);
    if (!now) { now = localGround(recipe, r.ground.footprint, placeIds); cache.set(key, now); }
    for (const k of Object.keys({ ...r.ground.parts, ...now.parts })) {
      if (!k.startsWith("roads/") || r.ground.parts[k] === now.parts[k]) continue;
      const id = k.slice("roads/".length);
      if (ids.has(id) || ids.has(base(id))) { const h = now.parts[k] ?? ""; if (!(parts[k] ??= []).includes(h)) parts[k]!.push(h); }
    }
  }
  if (Object.keys(parts).length) (doc.groundRulings ??= []).push({ at: new Date().toISOString(), ...(by ? { by } : {}), kind: "road-trim", ruling: what, parts });
  return parts;
}

/** `stages --recheck <place>`: after the gates passed, re-hash the ground of every record a road trim covers (the record's
 *  time is kept, so nothing after it goes stale). Returns the stages re-hashed. */
export function recheckTrim(doc: WorldStages, recipe: J, placeId: string): string[] {
  const p = doc.places.find((x) => x.id === placeId);
  if (!p) throw new Error(`no place ${placeId}`);
  const placeIds = doc.places.map((x) => x.id);
  const out: string[] = [];
  for (const [stage, r] of Object.entries(p.stages)) {
    if (!r.ground) continue;
    const now = localGround(recipe, r.ground.footprint, placeIds);
    if (now.hash === r.ground.hash) continue;
    const by = coveringRulings(doc, placeId, r.ground.parts, now.parts);
    if (!by) continue;
    r.ground = { footprint: r.ground.footprint, hash: now.hash, parts: now.parts };
    r.note = `${r.note ? `${r.note}; ` : ""}rechecked after ${by} ${new Date().toISOString().slice(0, 10)}`;
    out.push(stage);
  }
  return out;
}

// ------------------------------------------------------------------ state

export type StateName = "ok" | "STALE" | "MISSING" | "BLOCKED";
export interface StageState { stage: string; state: StateName; why: string; blockedBy?: string; how: string; /** STALE only for a road-trim re-check (gates, not a redo): does not stale the stages after it. */ trim?: boolean }
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
  // place records: the LOCAL ground under the place (a record made before local ground falls back to the world hash)
  const rf = recipeFile(projectDir, doc.world);
  let parsed: J | null | undefined;
  const ids = doc.places.map((p) => p.id);
  const cache = new Map<string, { hash: string; parts: Record<string, string> }>();
  /** Per record: the trim/ruling that covers its whole ground diff (a not-STALE reason), keyed by record. */
  const covered = new Map<StageRecord, string>();
  const placeRec = (r: StageRecord | undefined, what: string, placeId?: string): string | null => {
    if (!r) return null;
    if (!r.ground) return rec(r, what);
    if (parsed === undefined) parsed = fs.existsSync(rf) ? parseRecipe(readJson(rf)) : null;
    if (!parsed) return `${what}, world is missing`;
    const key = stable(r.ground.footprint);
    let now = cache.get(key);
    if (!now) { now = localGround(parsed, r.ground.footprint, ids); cache.set(key, now); }
    if (now.hash === r.ground.hash) return "";
    const by = coveringRulings(doc, placeId, r.ground.parts, now.parts);
    if (by) { covered.set(r, by); return ""; }
    const d = groundDiff(r.ground.parts, now.parts);
    return `ground under the place moved since ${what}: ${d.slice(0, 4).join(", ")}${d.length > 4 ? ` (+${d.length - 4})` : ""}`;
  };
  /** A covered record: ok, unless its stage is a TRIM_STAGE under a road trim (re-checked by the gates, not redone). */
  const coveredState = (r: StageRecord | undefined, stage: string): string | null => {
    const by = r ? covered.get(r) : undefined;
    if (!by) return null;
    if (by.startsWith("road-trim") && (TRIM_STAGES as readonly string[]).includes(stage)) return `${by}: re-run the seated / float / lips gates under the place, then zonegen stages <world> --recheck <place> --by <who>`;
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
    const w = placeRec(r, "sited", p.id);
    if (w) return { stage: "sited", state: "STALE", why: w, how };
    const trim = coveredState(r, "sited");
    if (trim) return { stage: "sited", state: "STALE", why: trim, how, trim: true };
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
        // the gate before this stage: the previous place stage (a place needs no world freeze: its ground is local)
        const gate: StageState = prev!;
        if (!r) s = gate.state === "ok" ? { stage, state: "MISSING", why: "not done", how } : { stage, state: "BLOCKED", blockedBy: gate.state === "BLOCKED" ? gate.blockedBy : gate.stage, why: "", how };
        else {
          let why = placeRec(r, "done", p.id) ?? "";
          const trimWhy = !why ? coveredState(r, stage) : null;
          if (trimWhy) why = trimWhy;
          if (!why && r.evidence) {
            const ef = path.resolve(projectDir, r.evidence), now = evidenceSha(ef);
            if (now === null) why = `evidence ${r.evidence} is gone`;
            else if (r.evidenceSha && now !== r.evidenceSha && fileSha(ef) !== r.evidenceSha) why = `evidence ${r.evidence} changed since it was recorded`;
          }
          if (!why && stage in APPROVALS) {
            const of = p.stages[APPROVALS[stage as keyof typeof APPROVALS]];
            if (!of || r.approves !== of.evidenceSha) why = `${stage === "concept-approved" ? "repainted" : "redrawn"} after the approval (approved ${short(r.approves ?? "?")}, now ${short(of?.evidenceSha ?? "none")})`;
          }
          // a stage STALE only for a road-trim re-check does not stale the work after it (nothing there is redone)
          if (!why && gate.state !== "ok" && !gate.trim) why = `${gate.stage} is ${gate.state}`;
          // a re-site at the SAME site (an owner re-checking after a road change) is not a redo: each later record carries its
          // own ground hash, which already says whether the ground under it moved (2026-10-31: a same-site re-site after a road
          // trim staled an approved place from bare-renders to installed)
          const sameSite = prev!.stage === "sited" && !!r.ground && !!prevRec?.site
            && Math.hypot(r.ground.footprint.center[0] - prevRec.site.center[0], r.ground.footprint.center[1] - prevRec.site.center[1]) <= 0.5
            && (p.kind === "town" || Math.abs(r.ground.footprint.radius - 40 - prevRec.site.radius) <= 0.5);
          if (!why && prevRec && prevRec.at > r.at && !sameSite) why = `${prev!.stage} was redone after it (${prevRec.at})`;
          const coveredBy = covered.get(r);
          s = { stage, state: why ? "STALE" : "ok", why: why || (coveredBy ? `ok under ${coveredBy}` : "") || r.note || `${r.by ? `by ${r.by} ` : ""}${r.at}`, how, ...(trimWhy ? { trim: true } : {}) };
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
 * May a bare re-render (`zonegen concept --renders-only`) carry the `concept-painted` record forward? The sheet (its
 * evidence) is re-composed around the paintings, so the record is kept only when the PAINTINGS are the ones recorded:
 * every frame's sha256 equal to the record's `frames`. A record from before `frames` existed cannot be checked, so it is
 * carried only on a dated ruling that the paintings are unchanged (the new record then stores the hashes). Content
 * hashes, never mtimes: a copy or a checkout rewrites mtimes (coordinator 2026-10-31).
 */
export function paintedCarry(prior: StageRecord | undefined, now: Record<string, string | null>, ruling = ""): { carry: boolean; why: string } {
  if (!prior) return { carry: false, why: "no concept-painted record to carry (a painting run records it)" };
  const missing = Object.entries(now).filter(([, sha]) => !sha).map(([f]) => f);
  if (missing.length || !Object.keys(now).length) return { carry: false, why: `painted frame(s) missing: ${missing.join(", ") || "none named"}` };
  if (!prior.frames) {
    if (isDatedRuling(ruling)) return { carry: true, why: `record of ${prior.at} has no frame hashes; carried on the ruling "${ruling}" (hashes recorded now)` };
    return { carry: false, why: `the record of ${prior.at} has no frame hashes, so the paintings cannot be proved unchanged: pass --paint-ruling "YYYY-MM-DD ..." (a dated ruling that they are) or repaint` };
  }
  const changed = Object.entries(now).filter(([f, sha]) => prior.frames![f] !== sha).map(([f]) => f);
  if (changed.length) return { carry: false, why: `painted frame(s) changed since ${prior.at}: ${changed.join(", ")} (a painting run judges and records them)` };
  return { carry: true, why: `paintings unchanged since ${prior.at} (${Object.keys(now).length} frame hash(es) match)` };
}

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

/** A place's art mode by id / name, or null when no staged world knows it. */
export function artFor(projectDir: string, key: string, world?: string): "painted" | "catalogue" | null {
  for (const w of world ? [world] : stagedWorlds(projectDir)) {
    const p = loadStages(projectDir, w)?.places.find((x) => matchPlace(x, key));
    if (p) return artOf(p);
  }
  return null;
}

/** Record a place stage done now on the current world hash (the tool that did the work calls it). */
export function recordPlaceStage(projectDir: string, key: string, stage: string, fields: Partial<StageRecord> & { evidenceFile?: string }, world?: string): string | null {
  for (const w of world ? [world] : stagedWorlds(projectDir)) {
    const doc = loadStages(projectDir, w);
    const p = doc?.places.find((x) => matchPlace(x, key));
    if (!doc || !p) continue;
    const hash = currentWorldHash(projectDir, doc)!;
    const { evidenceFile, ...rest } = fields;
    // L (Red Dial 2026-10-30: re-recording an unchanged design.json STALEd its design-review): the same evidence (same
    // sha) recorded again is a no-op — the old record and its time stay, so the stages after it stay current
    const prior = p.stages[stage], sameSha = evidenceFile ? evidenceSha(path.resolve(evidenceFile)) : null;
    if (prior && sameSha && prior.evidenceSha === sameSha) return `${p.id} ${stage}: evidence unchanged since ${prior.at} (no-op: the stages after it stay as they are)`;
    const ground = groundRecord(projectDir, doc, p);
    p.stages[stage] = {
      at: new Date().toISOString(), worldHash: hash, ...(ground ? { ground } : {}), ...rest,
      ...(evidenceFile ? { evidence: relTo(projectDir, path.resolve(evidenceFile)), evidenceSha: evidenceSha(path.resolve(evidenceFile)) ?? undefined } : {}),
    };
    saveStages(projectDir, doc);
    return `recorded ${p.id} ${stage} on world ${short(hash)}${ground ? `, local ground ${short(ground.hash)} (${Object.keys(ground.parts).length} parts, ${ground.footprint.views.length} camera(s))` : ""} (${relTo(projectDir, stagesFile(projectDir, w))})`;
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
  const after = worldHash(next, ids);
  if (after === before) return { ok: true, message: "" };
  // which places this write moves the ground under (their ok stages go STALE); every other place is untouched
  const moved = groundMoves(projectDir, doc, next);
  const movedText = moved.length ? moved.map((x) => `${x.place} (${x.stages.join(", ")}: ${x.parts.slice(0, 3).join(", ")}${x.parts.length > 3 ? ` +${x.parts.length - 3}` : ""})`).join("; ") : "";
  if (!fr || fr.worldHash !== before) return { ok: true, message: movedText ? `world order: this write moves the ground under ${movedText} — those stages go STALE (zonegen stages ${doc.world} --project ${doc.project})` : "" }; // not frozen
  if (!unfreeze) return { ok: false, message: `${command} refused: world ${doc.world} is FROZEN (${fr.at}${fr.by ? ` by ${fr.by}` : ""}) and this write changes the world (${short(before)} -> ${short(after)}). Places are built on it. Only with a dated ruling: --unfreeze "YYYY-MM-DD <who>: <why>". Place stages it would stale (their local ground moves): ${movedText || "none"}.` };
  if (!isDatedRuling(unfreeze)) return { ok: false, message: `${command}: --unfreeze needs a dated ruling ("YYYY-MM-DD <who>: <why>"), got "${unfreeze}"` };
  const stale = moved.flatMap((x) => x.stages.map((st) => `${x.place}:${st}`));
  delete doc.stages["world-frozen"];
  doc.unfreezes.push({ at: new Date().toISOString(), ruling: unfreeze, from: before!, to: after, command, stale });
  saveStages(projectDir, doc);
  return { ok: true, message: `UNFROZE ${doc.world} (${unfreeze}): ${short(before!)} -> ${short(after)}. STALE now (redo in order): ${stale.length ? stale.join(", ") : "nothing"}. Re-freeze: zonegen stages ${doc.world} --project ${doc.project} --freeze` };
}

/** The places whose ok stages stand on ground that `next` (a recipe about to be written) changes, with the parts that move. */
export function groundMoves(projectDir: string, doc: WorldStages, next: unknown): { place: string; stages: string[]; parts: string[] }[] {
  const ev = evaluate(projectDir, doc);
  const recipe = parseRecipe(next), ids = doc.places.map((p) => p.id), hash = worldHash(next, ids);
  const cache = new Map<string, { hash: string; parts: Record<string, string> }>();
  const out: { place: string; stages: string[]; parts: string[] }[] = [];
  for (const e of ev.places) {
    const stages: string[] = [], parts = new Set<string>();
    for (const row of e.rows) {
      const r = e.place.stages[row.stage];
      if (row.state !== "ok" || !r) continue;
      if (!r.ground) { if (r.worldHash !== hash) { stages.push(row.stage); parts.add("world (record has no local ground)"); } continue; }
      const key = stable(r.ground.footprint);
      let now = cache.get(key);
      if (!now) { now = localGround(recipe, r.ground.footprint, ids); cache.set(key, now); }
      if (now.hash !== r.ground.hash) { stages.push(row.stage); for (const d of groundDiff(r.ground.parts, now.parts)) parts.add(d); }
    }
    if (stages.length) out.push({ place: e.place.id, stages, parts: [...parts] });
  }
  return out;
}

/** Place-command hook: print the refusal and exit 3 when the stage is not ok. */
export function enforceOrExit(projectDir: string, key: string, stage: string, command: string, world?: string): void {
  const why = requirePlaceStage(projectDir, key, stage, command, world);
  if (why) { console.error(why); process.exit(3); }
}

/**
 * The world-order stage a place-build command needs (`""` = none). A SAMPLE build (`--sample`) needs only `design`:
 * job.mjs records design-review only with the gate-16 sample shots, and those need a build, so plan / all / build / shots
 * of the design's sample area run on `design` alone, in a lab only (never `install`, never `--live`; refused here).
 * Everything else: plan / all / build need design-review, install (not a dry run or an uninstall) needs final-review.
 * A DRAFT (`--draft`, Derek 2026-11-03 i-drafts: "bring them in live as they are and we can alter them"): build (its lab)
 * and install wait on no review stage — those stay open and the install records a dated note on `installed` — while every
 * geometry guard still runs (job.mjs draftInstallBlock + place-build's overlap check). plan / all re-design: refused,
 * EXCEPT `plan` of a job whose owner wrote `<job>/layout.json` (`layout: true`; w-temple5 2026-11-03: the moon temple's
 * new layout had never been expanded into ops): that plan expands the owner's composition as it is, re-designing nothing.
 */
export function placeBuildGate(cmd: string, o: { sample?: boolean; live?: boolean; dryRun?: boolean; uninstall?: boolean; draft?: boolean; layout?: boolean } = {}): { stage: string; refuse?: string } {
  if (o.draft) {
    if (o.sample) return { stage: "", refuse: "--draft and --sample do not combine" };
    if (cmd === "plan" && o.layout) return { stage: "" };
    if (["plan", "all"].includes(cmd)) return { stage: "", refuse: "--draft takes a place AS IT IS (build its lab, install it): plan / all re-design it and need design-review (plan --draft only expands an owner's layout.json)" };
    if (["build", "install"].includes(cmd)) return { stage: "" };
  }
  if (o.sample) {
    if (cmd === "install") return { stage: "", refuse: "a --sample build never installs: the sample is for the design review's shots, in the lab" };
    if (o.live) return { stage: "", refuse: "a --sample build runs in the lab only, never --live" };
    return { stage: ["plan", "all", "build", "shots"].includes(cmd) ? "design" : "" };
  }
  if (["plan", "all", "build"].includes(cmd)) return { stage: "design-review" };
  if (cmd === "install" && !o.dryRun && !o.uninstall) return { stage: "final-review" };
  return { stage: "" };
}

/**
 * Whether a place-build write moves the job's progress stage to `installed`. Only a LIVE install does: a lab build
 * (`build`, `all`, a `--job` copy into a scratch lab) writes the lab project and an uninstall takes the place out
 * (i-drafts 2026-11-03: applyPlace stamped `installed` on every lab build; the stage guard happened to refuse it).
 */
export function stampsInstalled(o: { target: string; lab: string; remove?: boolean; dry?: boolean; jobCopy?: boolean }): boolean {
  return o.target !== o.lab && !o.remove && !o.dry && !o.jobCopy;
}
