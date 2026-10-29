/**
 * Coastal towns sit at the SHORE (2026-10-28, firstshore s1e).
 *
 * `worldgen towns` sited Saltharrow — "the walled fishing town on the south cove" — on a hilltop 100-107 m above its
 * cove, 220 m back up a 40-45 deg face: the town master could only reach the water with a banned seven-leg switchback
 * stair. Nothing in the stage knew a harbour town has to stand at the water. This module is that rule, shared by
 * `worldgen towns` (siting, refusal), the `towns` status row and `worldgen gates` (the check). The schema's
 * `townSchema.coastal` `.describe()` states the same numbers.
 *
 * The slope limits are not picked: they are what `worldgen terrace` can step with its own defaults
 * (`TERRACE_DEFAULTS`, which `commandTerrace` reads), so a coastal site is by construction ground the next stage grades.
 */
import type { CoastSegmentDoc, TownDoc, TownGateDoc, WorldField, WorldRecipe } from "@hitreg/core";

/** `worldgen terrace`'s default character (its --step-height / --riser / --min-shelf / --max-terraces / --ramp-grade). */
export const TERRACE_DEFAULTS = { stepHeight: 6, riser: 5, minShelf: 9, maxTerraces: 5, rampGrade: 0.12 } as const;

/**
 * The ground `worldgen terrace` can step with its defaults:
 * - relief: at most `maxTerraces` shelves, one `stepHeight` apart -> maxTerraces x stepHeight;
 * - mean slope: one step of rise per shelf pitch (two minimum half-widths plus the riser's face) -> stepHeight / (2 minShelf + riser);
 * - steepest face: one riser carries one step -> stepHeight / riser. Steeper than that, a riser is a cliff the ramps fail.
 */
export function terraceReach(d: { stepHeight: number; riser: number; minShelf: number; maxTerraces: number } = TERRACE_DEFAULTS): { maxRelief: number; maxSlope: number; maxFace: number } {
  return { maxRelief: d.maxTerraces * d.stepHeight, maxSlope: d.stepHeight / (2 * d.minShelf + d.riser), maxFace: d.stepHeight / d.riser };
}

/** The shore rule (see `townSchema.coastal`). */
export const COASTAL_TOWN = {
  /** centre at most this far over the sea (m) */
  maxAltitude: 12,
  /** centre at most this far from the shoreline (m) */
  maxShore: 90,
  /** the landing the town is on */
  types: ["cove", "sand-beach"] as readonly string[],
  exposure: "sheltered",
  /** this share of the pad radius must be dry ground (the seaward rim may meet the water: that is the quay line) */
  dryShare: 0.85,
} as const;

export interface CoastalSite {
  x: number;
  z: number;
  altitude: number;
  /** metres from the centre to the nearest shoreline point */
  shore: number;
  shorePoint: [number, number];
  segment: CoastSegmentDoc | null;
  /** unit XZ from the shore point to the centre: the way the land gate faces */
  landward: [number, number];
  relief: number;
  meanSlope: number;
  /** p95 of the pad's gradient: the steepest face that matters, not one voxel */
  steepest: number;
  wet: number;
}

function segDistance(px: number, pz: number, a: readonly [number, number], b: readonly [number, number]): { d: number; x: number; z: number } {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = dx * dx + dz * dz;
  const t = len < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / len));
  const x = a[0] + dx * t, z = a[1] + dz * t;
  return { d: Math.hypot(px - x, pz - z), x, z };
}

/** Nearest shoreline point (any coast-plan segment) and its segment. */
export function nearestShore(recipe: WorldRecipe, x: number, z: number): { d: number; point: [number, number]; segment: CoastSegmentDoc | null } {
  let best = { d: Infinity, point: [x, z] as [number, number], segment: null as CoastSegmentDoc | null };
  for (const s of recipe.features.coastSegments ?? []) {
    for (let i = 0; i + 1 < s.points.length; i++) {
      const hit = segDistance(x, z, s.points[i]!, s.points[i + 1]!);
      if (hit.d < best.d) best = { d: hit.d, point: [hit.x, hit.z], segment: s };
    }
  }
  return best;
}

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.round(q * (s.length - 1))))]!;
};

/** Measure one candidate centre for a pad of `radius` (a square lattice of `step` m clipped to the disc). */
export function measureCoastalSite(field: WorldField, recipe: WorldRecipe, x: number, z: number, radius: number, step = 6): CoastalSite {
  const sea = recipe.seaLevel;
  const n = Math.ceil(radius / step);
  const side = 2 * n + 1;
  const h = new Float64Array(side * side);
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) h[i + j * side] = field.height(x + (i - n) * step, z + (j - n) * step);
  const heights: number[] = [];
  const grads: number[] = [];
  let wet = 0;
  for (let j = 1; j < side - 1; j++) {
    for (let i = 1; i < side - 1; i++) {
      const r = Math.hypot((i - n) * step, (j - n) * step);
      if (r > radius) continue;
      const k = i + j * side;
      heights.push(h[k]!);
      const gx = (h[k + 1]! - h[k - 1]!) / (2 * step), gz = (h[k + side]! - h[k - side]!) / (2 * step);
      grads.push(Math.hypot(gx, gz));
      if (r <= radius * COASTAL_TOWN.dryShare && (h[k]! < sea + 0.5 || field.waterY(x + (i - n) * step, z + (j - n) * step) !== null)) wet++;
    }
  }
  const shore = nearestShore(recipe, x, z);
  const lx = x - shore.point[0], lz = z - shore.point[1];
  const ll = Math.hypot(lx, lz) || 1;
  return {
    x,
    z,
    altitude: h[n + n * side]! - sea,
    shore: shore.d,
    shorePoint: shore.point,
    segment: shore.segment,
    landward: [lx / ll, lz / ll],
    relief: quantile(heights, 0.95) - quantile(heights, 0.05),
    meanSlope: grads.reduce((a, b) => a + b, 0) / Math.max(1, grads.length),
    steepest: quantile(grads, 0.95),
    wet,
  };
}

/** Why a measured site is not a coastal town site; empty = it is one. */
export function coastalFaults(site: CoastalSite, reach = terraceReach(), opts: { ground?: boolean } = {}): string[] {
  const out: string[] = [];
  const ground = opts.ground !== false;
  if (site.altitude > COASTAL_TOWN.maxAltitude) out.push(`centre ${site.altitude.toFixed(1)} m over the sea (max ${COASTAL_TOWN.maxAltitude})`);
  if (site.altitude < 1) out.push(`centre ${site.altitude.toFixed(1)} m over the sea (awash)`);
  if (site.shore > COASTAL_TOWN.maxShore) out.push(`${site.shore.toFixed(0)} m from the shoreline (max ${COASTAL_TOWN.maxShore})`);
  if (!site.segment) out.push("no coast plan (run worldgen coast)");
  else {
    if (!COASTAL_TOWN.types.includes(site.segment.type)) out.push(`nearest shore ${site.segment.id} is ${site.segment.type} (wants ${COASTAL_TOWN.types.join(" / ")})`);
    if (site.segment.exposure !== COASTAL_TOWN.exposure) out.push(`nearest shore ${site.segment.id} is ${site.segment.exposure} (wants ${COASTAL_TOWN.exposure})`);
  }
  if (ground && site.relief > reach.maxRelief) out.push(`relief ${site.relief.toFixed(1)} m (terrace steps ${reach.maxRelief} m)`);
  if (ground && site.meanSlope > reach.maxSlope) out.push(`mean slope ${site.meanSlope.toFixed(2)} (terrace steps ${reach.maxSlope.toFixed(2)})`);
  if (ground && site.steepest > reach.maxFace) out.push(`steepest face ${site.steepest.toFixed(2)} (one riser carries ${reach.maxFace.toFixed(2)})`);
  if (ground && site.wet > 0) out.push(`${site.wet} wet sample(s) inside ${Math.round(COASTAL_TOWN.dryShare * 100)} % of the pad`);
  return out;
}

/** A gate is landward when it faces within 60 deg of the landward direction AND stands on the land side of the centre. */
export function gateIsLandward(town: Pick<TownDoc, "center">, gate: Pick<TownGateDoc, "at" | "facing">, landward: readonly [number, number]): boolean {
  const fl = Math.hypot(gate.facing[0], gate.facing[1]) || 1;
  const facingDot = (gate.facing[0] * landward[0] + gate.facing[1] * landward[1]) / fl;
  const side = (gate.at[0] - town.center[0]) * landward[0] + (gate.at[1] - town.center[1]) * landward[1];
  return facingDot >= 0.5 && side > 0;
}

/**
 * Search every sheltered cove / sand-beach for a coastal pad of `radius`: stations every 16 m along each segment,
 * centres 30..90 m inland along the local normal. Returns the passing sites best first (cove before beach, flatter,
 * lower, nearer the water) and, for a refusal, the reasons the candidates failed.
 */
export function findCoastalSites(
  field: WorldField,
  recipe: WorldRecipe,
  radius: number,
  clear: (x: number, z: number) => boolean,
): { sites: (CoastalSite & { score: number })[]; tried: number; reasons: Map<string, number>; nearMiss: { site: CoastalSite; faults: string[] } | null } {
  const reach = terraceReach();
  const sites: (CoastalSite & { score: number })[] = [];
  const reasons = new Map<string, number>();
  let tried = 0;
  let nearMiss: { site: CoastalSite; faults: string[] } | null = null;
  const segments = (recipe.features.coastSegments ?? []).filter((s) => COASTAL_TOWN.types.includes(s.type) && s.exposure === COASTAL_TOWN.exposure);
  if (segments.length === 0) reasons.set(`no ${COASTAL_TOWN.exposure} ${COASTAL_TOWN.types.join("/")} segment in the coast plan`, 1);
  for (const seg of segments) {
    for (let i = 0; i + 1 < seg.points.length; i++) {
      const a = seg.points[i]!, b = seg.points[i + 1]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const tx = (b[0] - a[0]) / len, tz = (b[1] - a[1]) / len;
      for (let s = 0; s < len; s += 16) {
        const px = a[0] + tx * s, pz = a[1] + tz * s;
        // inland = the side of the line whose ground is higher
        const side = field.height(px - tz * 20, pz + tx * 20) >= field.height(px + tz * 20, pz - tx * 20) ? 1 : -1;
        const nx = -tz * side, nz = tx * side;
        for (let d = 30; d <= COASTAL_TOWN.maxShore; d += 10) {
          const x = px + nx * d, z = pz + nz * d;
          const quick = field.height(x, z) - recipe.seaLevel;
          if (quick > COASTAL_TOWN.maxAltitude + 2 || quick < 1) {
            const why = quick < 1 ? "awash" : "centre too high";
            reasons.set(why, (reasons.get(why) ?? 0) + 1);
            tried++;
            continue;
          }
          if (!clear(x, z)) {
            reasons.set("too near another town", (reasons.get("too near another town") ?? 0) + 1);
            tried++;
            continue;
          }
          tried++;
          const site = measureCoastalSite(field, recipe, x, z, radius);
          const faults = coastalFaults(site, reach);
          if (faults.length > 0) {
            for (const f of faults) {
              const key = f.replace(/[\d.]+/g, "#");
              reasons.set(key, (reasons.get(key) ?? 0) + 1);
            }
            if (!nearMiss || faults.length < nearMiss.faults.length) nearMiss = { site, faults };
            continue;
          }
          const score =
            (site.segment!.type === "cove" ? 1 : 0.6) +
            (1 - site.meanSlope / reach.maxSlope) * 0.6 +
            (1 - site.altitude / COASTAL_TOWN.maxAltitude) * 0.3 +
            (1 - site.shore / COASTAL_TOWN.maxShore) * 0.3 +
            (site.segment!.concave ? 0.2 : 0);
          sites.push({ ...site, score });
        }
      }
    }
  }
  sites.sort((p, q) => q.score - p.score);
  return { sites, tried, reasons, nearMiss };
}

/** The landward gate a coastal town gets from `towns`: on the pad edge, facing away from the nearest shore point. */
export function landGate(site: Pick<CoastalSite, "x" | "z" | "landward">, radius: number, width = 6, approach = 30): TownGateDoc {
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    id: "land-gate",
    at: [r2(site.x + site.landward[0] * radius), r2(site.z + site.landward[1] * radius)],
    facing: [r2(site.landward[0]), r2(site.landward[1])],
    width,
    approach,
    tags: ["coastal"],
  };
}

/** Status / gates check: every coastal town measured against the rule; one line per fault. */
export function coastalTownFindings(recipe: WorldRecipe, field: WorldField): string[] {
  const out: string[] = [];
  for (const town of recipe.features.towns) {
    if (!town.coastal) continue;
    const site = measureCoastalSite(field, recipe, town.center[0], town.center[1], town.radius);
    // the town's own pad/terraces are in the field, so the slope terms (a riser IS steep) are judged at siting, not
    // here: the built check is height over the sea, distance to the shoreline, the landing it is on, a dry pad, the gate
    for (const f of coastalFaults(site, terraceReach(), { ground: false })) out.push(`${town.id} (coastal): ${f}`);
    // dry on the BUILT ground = the town's floors are out of the sea (the seaward rim meeting the water is the quay line)
    const floors = town.terraces.length > 0 ? town.terraces.map((t) => ({ id: t.id, y: t.groundY })) : [{ id: "pad", y: town.groundY ?? site.altitude + recipe.seaLevel }];
    for (const f of floors) if (f.y < recipe.seaLevel + 1) out.push(`${town.id} (coastal): ${f.id} at ${f.y.toFixed(1)} m is under 1 m over the sea`);
    if (field.waterY(town.center[0], town.center[1]) !== null) out.push(`${town.id} (coastal): the centre is in the water`);
    if (town.gates.length > 0 && !town.gates.some((g) => gateIsLandward(town, g, site.landward))) {
      out.push(`${town.id} (coastal): no gate faces landward (gates ${town.gates.map((g) => g.id).join(", ")}; landward [${site.landward.map((v) => v.toFixed(2)).join(", ")}])`);
    }
  }
  return out;
}
