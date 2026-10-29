/**
 * `worldgen dogfood --needs <spec>,...` — every seed of the loop judged against the SITE NEEDS the run has
 * (tools/site-needs.mts), numbers not adjectives (2026-10-29 redstrand: "for every passing seed, report against the
 * three needs this run has" — a grand-entrance face, a walled-town neck, a sheltered cove — was a hand probe per seed).
 *
 *   grand-entrance[:<face m>[:<read m>]]  rock-face feet found by `findFaceFeet`, each measured by the rock-face need
 *                                          with minHeight = face (default the role's 1.1 x 40 m front) and readDistance
 *   walled-town / town / hill-town / ...  the town roles: `prescored` grid cells measured by the role's needs
 *   harbour-town                           the coastal rule's shore sites (`findCoastalSites`) measured by the role
 *   large-place[:<radius m>]              (alias large-poi) the large-place role (site r 150): flat r60 core, 15 m over
 *                                          the ground 150 m round it, 3 ways in, a 20 m landmark seen from 300 m
 *   roadside-place                         the roadside role; its route is any line between two places sited earlier in
 *                                          the same spec list
 *   @<dir or needs.json>                   THE DESIGNERS' PLACES (2026-10-29 t-needs): every <dir>/<place>/needs.json
 *                                          (tools/site-needs.mts placeNeedsFileSchema) measured with its role, radius and
 *                                          overrides. Places are sited in dependency order (a place whose needs name
 *                                          `town:thirstgate` comes after the town); each one's best candidate becomes a
 *                                          sited place the later ones measure distance-from / on-route / landmark-visible
 *                                          against. The run's report gets one met/unmet column per place.
 *
 * Measured on the natural ground (pads out), as `worldgen towns --propose` and `zonegen sites --propose` measure.
 */
import fs from "node:fs";
import path from "node:path";
import type { WorldField, WorldRecipe } from "@hitreg/core";
import {
  findFaceFeet, measureNeeds, needRefs, needsFor, needsLine, routeCandidates, ROLE_RADIUS, SITE_ROLES,
  type NeedsReport, type SiteNeed, type SiteNeedOverrides, type SitedPlace, type SiteRole, type V2,
} from "./site-needs.mts";
import { naturalField, needGround, prescored, readNeedsFile } from "./worldgen-site-needs.mts";
import { findCoastalSites } from "./worldgen-coastal-towns.mts";

export interface NeedSpec {
  role: SiteRole;
  face?: number;
  read?: number;
  radius?: number;
  label: string;
  /** A designed place (from a needs file): its id, town or place, and overrides. */
  place?: { id: string; kind: "town" | "place"; overrides: SiteNeedOverrides };
}
export interface SeedNeed { label: string; met: number; measured: number; best: { at: V2; report: NeedsReport } | null }

export const DOGFOOD_TOWN_RADIUS = 45;
const MEASURE_TOWN = 60;
const MEASURE_LARGE = 30;
const MEASURE_SHORE = 40;
const MEASURE_FACES = 16;
const MEASURE_ROUTE = 60;

/** The needs files a `@` spec names: one file, or every <dir>/<x>/needs.json (and <dir>/needs.json). */
export function needsFilesOf(target: string): string[] {
  const p = path.resolve(target);
  if (!fs.existsSync(p)) throw new Error(`--needs @${target}: no such file or folder`);
  if (fs.statSync(p).isFile()) return [p];
  const out = fs.existsSync(path.join(p, "needs.json")) ? [path.join(p, "needs.json")] : [];
  for (const d of fs.readdirSync(p).sort()) if (fs.existsSync(path.join(p, d, "needs.json"))) out.push(path.join(p, d, "needs.json"));
  if (!out.length) throw new Error(`--needs @${target}: no needs.json in it or its sub-folders`);
  return out;
}

/** Order specs so a designed place comes after every designed place its needs refer to (refs to others stay unresolved). */
function dependencyOrder(specs: NeedSpec[]): NeedSpec[] {
  const ids = new Set(specs.filter((s) => s.place).map((s) => s.place!.id));
  const deps = new Map(specs.map((s) => [s, s.place ? needRefs(needsFor(s.role, s.place.overrides)).map((r) => r.replace(/^(town|place):/, "")).filter((r) => ids.has(r) && r !== s.place!.id) : []] as const));
  const out: NeedSpec[] = [];
  const done = new Set<string>();
  let left = [...specs];
  while (left.length) {
    const ready = left.filter((s) => deps.get(s)!.every((d) => done.has(d)));
    const next = ready.length ? ready : [left[0]!]; // a cycle: take the first and let its refs report unsited
    for (const s of next) { out.push(s); if (s.place) done.add(s.place.id); }
    left = left.filter((s) => !next.includes(s));
  }
  return out;
}

export function parseNeedSpecs(text: string): NeedSpec[] {
  const specs: NeedSpec[] = [];
  for (const s of text.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (s.startsWith("@")) {
      for (const file of needsFilesOf(s.slice(1))) {
        const f = readNeedsFile(file);
        specs.push({ role: f.siteRole, radius: f.radius, label: f.id, place: { id: f.id, kind: f.kind, overrides: f.siteNeeds } });
      }
      continue;
    }
    const [r, face, read] = s.split(":");
    const role = r === "large-poi" ? "large-place" : r;
    if (!(SITE_ROLES as readonly string[]).includes(role!)) throw new Error(`--needs: unknown role ${role} (${SITE_ROLES.join(", ")}, or @<design dir>)`);
    if (role === "large-place") specs.push({ role, radius: face ? Number(face) : undefined, label: s });
    else specs.push({ role: role as SiteRole, face: face ? Number(face) : undefined, read: read ? Number(read) : undefined, label: s });
  }
  return dependencyOrder(specs);
}

const faultCount = (r: NeedsReport) => r.results.reduce((n, x) => n + x.faults.length, 0);

export function seedNeeds(recipe: WorldRecipe, specs: readonly NeedSpec[]): SeedNeed[] {
  const field: WorldField = naturalField(recipe);
  const sited: SitedPlace[] = [];
  const g = needGround(recipe, field, field, sited); // `sited` grows as the specs are measured (the ground reads it live)
  const groundPlaces = g.places as SitedPlace[];
  const limit = recipe.bounds?.limit ?? 3000;
  const land = (x: number, z: number) => g.height(x, z) > recipe.seaLevel + 1;
  return specs.map((spec): SeedNeed => {
    const overrides = spec.place?.overrides ?? {};
    const needs: SiteNeed[] = needsFor(spec.role, overrides);
    const radius = spec.radius ?? ROLE_RADIUS[spec.role] ?? DOGFOOD_TOWN_RADIUS;
    const self = { self: spec.place?.id };
    const face = needs.find((n): n is Extract<SiteNeed, { kind: "rock-face" }> => n.kind === "rock-face");
    const cands: { at: V2; report: NeedsReport }[] = [];
    const measure = (x: number, z: number) => cands.push({ at: [Math.round(x), Math.round(z)], report: measureNeeds(g, spec.role, x, z, radius, overrides, self) });
    if (face && !spec.place && (spec.role === "grand-entrance" || spec.role === "dungeon-door")) {
      // the old face spec: the role's rock-face with the asked face height and read distance
      const want = spec.face ?? face.minHeight ?? face.frontHeight * face.ratio;
      const need = { ...face, minHeight: want, readDistance: spec.read ?? face.readDistance };
      for (const f of findFaceFeet(g, land, [-limit, -limit, limit, limit], want, { top: MEASURE_FACES })) {
        const r = measureNeeds(g, spec.role, f.at[0], f.at[1], radius, { "rock-face": need }, self);
        cands.push({ at: f.at, report: r });
      }
    } else if (face) {
      const want = face.minHeight ?? face.frontHeight * face.ratio;
      for (const f of findFaceFeet(g, land, [-limit, -limit, limit, limit], want, { top: MEASURE_FACES })) measure(f.at[0], f.at[1]);
    } else if (needs.some((n) => n.kind === "shore")) {
      const found = findCoastalSites(field, recipe, DOGFOOD_TOWN_RADIUS, () => true);
      const sites = [...found.sites].sort((a, b) => b.score - a.score);
      const kept: typeof sites = [];
      for (const s of sites) if (kept.length < MEASURE_SHORE && kept.every((k) => Math.hypot(k.x - s.x, k.z - s.z) > 120)) kept.push(s);
      for (const s of kept) measure(s.x, s.z);
    } else if (needs.some((n) => n.kind === "on-route")) {
      const pts = routeCandidates(g, needs, { ...self, step: 40 });
      const keep = pts.filter((_, i) => i % Math.max(1, Math.ceil(pts.length / MEASURE_ROUTE)) === 0);
      for (const p of keep) measure(p[0], p[1]);
    } else {
      const pad = needs.find((n): n is Extract<SiteNeed, { kind: "flat-pad" }> => n.kind === "flat-pad");
      const core = pad?.radius ?? radius;
      const high = needs.some((n) => n.kind === "high-ground");
      const pre = spec.role === "walled-town" ? "walled-town" : high ? "hill-town" : spec.role;
      const cap = spec.role === "large-place" ? MEASURE_LARGE : MEASURE_TOWN;
      const cells = prescored(g, recipe, pre, core, core > 60 ? 64 : 48);
      const kept: typeof cells = [];
      for (const c of cells) if (kept.length < cap && kept.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > Math.max(120, core))) kept.push(c);
      for (const c of kept) measure(c.x, c.z);
    }
    cands.sort((a, b) => Number(b.report.met) - Number(a.report.met) || faultCount(a.report) - faultCount(b.report));
    const best = cands[0] ?? null;
    // the best candidate stands in for the place in every later spec's distance-from / on-route / landmark refs
    if (best && spec.place) groundPlaces.push({ id: spec.place.id, kind: spec.place.kind, at: best.at, radius });
    return { label: spec.label, met: cands.filter((c) => c.report.met).length, measured: cands.length, best };
  });
}

/** One line per need: "<label> 2/16 met, best [x, z]: met rock-face: ...". */
export function seedNeedLine(n: SeedNeed): string {
  return `${n.label} ${n.met}/${n.measured} met${n.best ? `, best [${n.best.at.join(", ")}]: ${needsLine(n.best.report)}` : ", no candidate ground"}`;
}

/** The met / unmet columns: one row per seed, one column per need spec (a designed place). */
export function seedNeedsTable(rows: readonly { seed: number; needs: readonly SeedNeed[] }[]): string[] {
  const labels = [...new Set(rows.flatMap((r) => r.needs.map((n) => n.label)))];
  if (!labels.length) return [];
  const cell = (n: SeedNeed | undefined): string => {
    if (!n) return "-";
    if (!n.best) return `UNMET no ground (0/${n.measured})`;
    if (n.met) return `met ${n.met}/${n.measured}`;
    return `UNMET ${n.best.report.results.filter((r) => !r.met).map((r) => r.need).join("+")} (best [${n.best.at.join(", ")}])`;
  };
  return [
    `| seed | ${labels.join(" | ")} |`,
    `|---|${labels.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.seed} | ${labels.map((l) => cell(r.needs.find((n) => n.label === l))).join(" | ")} |`),
  ];
}
