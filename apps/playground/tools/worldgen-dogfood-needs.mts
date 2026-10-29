/**
 * `worldgen dogfood --needs <role[:face[:read]]>,...` — every seed of the loop judged against the SITE NEEDS the run
 * has (tools/site-needs.mts), numbers not adjectives (2026-10-29 redstrand: "for every passing seed, report against the
 * three needs this run has" — a grand-entrance face, a walled-town neck, a sheltered cove — was a hand probe per seed).
 *
 *   grand-entrance[:<face m>[:<read m>]]  rock-face feet found by `findFaceFeet`, each measured by the rock-face need
 *                                          with minHeight = face (default the role's 1.1 x 40 m front) and readDistance
 *   walled-town / town / hill-town / ...  the town roles: `prescored` grid cells measured by the role's needs
 *   harbour-town                           the coastal rule's shore sites (`findCoastalSites`) measured by the role
 *   large-poi[:<radius m>]                 ground for a LARGE place (default r 150 = a 300 m site; 2026-10-29 Derek widened
 *                                          redstrand to four places): a pad of that radius a terrace can step (flat-pad) that
 *                                          stands >= 15 m over the ground 150 m round it (high-ground), so it reads from 300 m+
 *
 * Measured on the natural ground (pads out), as `worldgen towns --propose` and `zonegen sites --propose` measure.
 */
import type { WorldField, WorldRecipe } from "@hitreg/core";
import { findFaceFeet, measureNeed, measureNeeds, needsFor, needsLine, SITE_ROLES, type NeedsReport, type SiteRole, type V2 } from "./site-needs.mts";
import { naturalField, needGround, prescored } from "./worldgen-site-needs.mts";
import { findCoastalSites } from "./worldgen-coastal-towns.mts";

export interface NeedSpec { role: SiteRole | "large-poi"; face?: number; read?: number; radius?: number; label: string }
export interface SeedNeed { label: string; met: number; measured: number; best: { at: V2; report: NeedsReport } | null }

export const DOGFOOD_TOWN_RADIUS = 45;
const MEASURE_TOWN = 60;
const MEASURE_SHORE = 40;
const MEASURE_FACES = 16;

export function parseNeedSpecs(text: string): NeedSpec[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [role, face, read] = s.split(":");
    if (role === "large-poi") return { role, radius: face ? Number(face) : 150, label: s };
    if (!(SITE_ROLES as readonly string[]).includes(role!)) throw new Error(`--needs: unknown role ${role} (${SITE_ROLES.join(", ")})`);
    return { role: role as SiteRole, face: face ? Number(face) : undefined, read: read ? Number(read) : undefined, label: s };
  });
}

export function seedNeeds(recipe: WorldRecipe, specs: readonly NeedSpec[]): SeedNeed[] {
  const field: WorldField = naturalField(recipe);
  const g = needGround(recipe, field);
  const limit = recipe.bounds?.limit ?? 3000;
  const land = (x: number, z: number) => g.height(x, z) > recipe.seaLevel + 1;
  return specs.map((spec): SeedNeed => {
    const cands: { at: V2; report: NeedsReport }[] = [];
    if (spec.role === "large-poi") {
      const radius = spec.radius ?? 150;
      const cells = prescored(g, recipe, "hill-town", radius, 64);
      const kept: typeof cells = [];
      for (const c of cells) if (kept.length < MEASURE_TOWN && kept.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > radius)) kept.push(c);
      const needs = [...needsFor("hill-town")];
      for (const c of kept) {
        const results = needs.map((n) => measureNeed(g, n, c.x, c.z, radius));
        cands.push({ at: [Math.round(c.x), Math.round(c.z)], report: { role: "large-poi", met: results.every((r) => r.met), results } });
      }
    } else if (spec.role === "grand-entrance" || spec.role === "dungeon-door") {
      const base = needsFor(spec.role)[0] as Extract<ReturnType<typeof needsFor>[number], { kind: "rock-face" }>;
      const want = spec.face ?? base.minHeight ?? base.frontHeight * base.ratio;
      const need = { ...base, minHeight: want, readDistance: spec.read ?? base.readDistance };
      for (const f of findFaceFeet(g, land, [-limit, -limit, limit, limit], want, { top: MEASURE_FACES })) {
        const r = measureNeed(g, need, f.at[0], f.at[1], 0);
        cands.push({ at: f.at, report: { role: spec.role, met: r.met, results: [r] } });
      }
    } else if (spec.role === "harbour-town" || spec.role === "harbour") {
      const found = findCoastalSites(field, recipe, DOGFOOD_TOWN_RADIUS, () => true);
      const sites = [...found.sites].sort((a, b) => b.score - a.score);
      const kept: typeof sites = [];
      for (const s of sites) if (kept.length < MEASURE_SHORE && kept.every((k) => Math.hypot(k.x - s.x, k.z - s.z) > 120)) kept.push(s);
      for (const s of kept) cands.push({ at: [Math.round(s.x), Math.round(s.z)], report: measureNeeds(g, spec.role, s.x, s.z, DOGFOOD_TOWN_RADIUS) });
    } else {
      const cells = prescored(g, recipe, spec.role, DOGFOOD_TOWN_RADIUS, 48);
      const kept: typeof cells = [];
      for (const c of cells) if (kept.length < MEASURE_TOWN && kept.every((k) => Math.hypot(k.x - c.x, k.z - c.z) > 120)) kept.push(c);
      for (const c of kept) cands.push({ at: [Math.round(c.x), Math.round(c.z)], report: measureNeeds(g, spec.role, c.x, c.z, DOGFOOD_TOWN_RADIUS) });
    }
    const faults = (c: { report: NeedsReport }) => c.report.results.reduce((n, r) => n + r.faults.length, 0);
    cands.sort((a, b) => Number(b.report.met) - Number(a.report.met) || faults(a) - faults(b));
    return { label: spec.label, met: cands.filter((c) => c.report.met).length, measured: cands.length, best: cands[0] ?? null };
  });
}

/** One line per need: "<label> 2/16 met, best [x, z]: met rock-face: ...". */
export function seedNeedLine(n: SeedNeed): string {
  return `${n.label} ${n.met}/${n.measured} met${n.best ? `, best [${n.best.at.join(", ")}]: ${needsLine(n.best.report)}` : ", no candidate ground"}`;
}
