import path from "node:path";
import fs from "node:fs";
/**
 * zonegen reserve <world> --project <p> --zone <id> — lint where every planned location goes.
 *
 * Every reservation is at least its size tier (tools/poi-review/size-tiers.mjs: diameter and approaches; owner ruling
 * 2026-10-03, a large place is 300-600 m): `under-tier` refuses it. The tier is the brief place's size when the
 * location IS a place, else the location's own.
 *
 * SITE NEEDS (tools/site-needs.mts): a reservation whose location has a site role — its brief place's `archetype`, or
 * a dungeon-entrance location (grand-entrance when its place's dungeon entrance is "landmark", else dungeon-door) — is
 * measured on the natural ground at its entrance (else its centre); every unmet need FAILS (`site-need`) unless the
 * reservation's `needRulings` carries a dated ruling for it. --pick <file> applies the zone master's choice from
 * `zonegen sites --propose` ({ places: [{ location, candidate, why, rulings?, radius?, approach? }] }): re-measured,
 * refused when it fails a need, else the reservation is centred there (its entrance at the face foot, facing the front)
 * and the brief place's `site` recorded.
 *
 * Plan-level geometry from the recipe only (no world field): inside the zone, clear of towns, roads, rivers and each
 * other, on a site of a fitting kind, reached from something that exists. Whether a walking body can actually get
 * there is NOT proven here: that is the POI owner's traversal gate (tools/poi-review), run on the real ground.
 */
import { exists, finish, load, loadRecipe, readJson, writeJson, type Ctx, type Finding } from "../lib.mts";
import { questGraphSchema, reservationSchema, reservationsSchema, zoneBriefSchema } from "../schemas.mts";
import { distToPolyline, err, inZone, requireZone, warn } from "./_shared.mts";
import { hostileOnMainRoads, travelRoads, type Content } from "./_site-finder.mts";
import { reservationTierFault, tierFor } from "../../../../../tools/poi-review/size-tiers.mjs";
import { z } from "zod";
import { measureNeeds, needRulingSchema, unexcepted, type SitedPlace, type SiteNeedOverrides, type SiteRole } from "../../site-needs.mts";
import { naturalField, needGround } from "../../worldgen-site-needs.mts";

/** Every reservation as a sited place (`place:<location>`): this zone's as they stand in memory, the other zones' from disk. */
function placesFor(ctx: Ctx, own: readonly { location: string; center: [number, number]; radius: number }[]): SitedPlace[] {
  const out: SitedPlace[] = own.map((r) => ({ id: r.location, kind: "place", at: [r.center[0], r.center[1]], radius: r.radius }));
  const zonesDir = path.join(ctx.paths.worldDir, "zones");
  if (exists(zonesDir))
    for (const zone of fs.readdirSync(zonesDir)) {
      if (zone === ctx.zone || !exists(ctx.paths.reservations(zone))) continue;
      for (const r of ((readJson(ctx.paths.reservations(zone)) as { reservations?: { location: string; center: [number, number]; radius: number }[] }).reservations ?? []))
        out.push({ id: r.location, kind: "place", at: [r.center[0], r.center[1]], radius: r.radius });
    }
  return out;
}

/** The zone master's choice file for `reserve --pick`. */
export const placePickSchema = z.object({
  from: z.string().optional().describe("The `zonegen sites --propose` file the candidates come from (default: the only <zone>-*.json beside the pick)."),
  places: z
    .array(
      z.object({
        location: z.string().min(1).describe("Quest-graph location id to reserve there."),
        candidate: z.string().min(1).describe("Candidate id in the propose file (s07, foot-2)."),
        why: z.string().min(1).describe("One line: why this ground carries the place (\"62 m face over a 2,000 m2 shelf, seen from the coast road\")."),
        rulings: z.array(needRulingSchema).default([]),
        radius: z.number().positive().optional().describe("A NEW reservation's radius (an existing one keeps its own)."),
        approach: z.string().optional().describe("A NEW reservation's approach (road / town / location id)."),
      }),
    )
    .min(1),
});

/** Metres an approach (road or river line, town pad, POI, other reservation) may stay from the reservation's edge. */
const APPROACH_REACH = 150;

/**
 * An approach may carry a PLANNED route (`points`: a trail the trails stage will build). It counts when the route
 * has a point within APPROACH_REACH of its `from` (it is anchored there) and passes within APPROACH_REACH of this
 * reservation's edge.
 * Returns the gap to judge: the route's when it is anchored on `from` and comes closer, else the direct gap.
 */
export function plannedRouteGap(
  direct: number,
  points: readonly (readonly [number, number])[],
  x: number,
  z: number,
  radius: number,
  gapAt: (px: number, pz: number, pr: number) => number | null,
): number {
  if (points.length < 2) return direct;
  const near = points.map(([px, pz]) => gapAt(px, pz, 0) ?? Infinity);
  if (Math.min(...near) > APPROACH_REACH) return direct;
  return Math.min(direct, distToPolyline(x, z, points as [number, number][]) - radius);
}

export async function run(ctx: Ctx): Promise<number> {
  const bad = requireZone(ctx.zone, "reserve");
  if (bad !== null) return bad;
  const f: Finding[] = [];
  const p = ctx.paths;
  const zone = ctx.zone;
  const res = load(p.reservations(zone), reservationsSchema, f, "reservations");
  const g = load(p.quests(zone), questGraphSchema, f, "quest graph");
  if (res && g) {
    const recipe = loadRecipe(p);
    if (res.zone !== zone) err(f, "wrong-zone", `reservations.zone is "${res.zone}", not "${zone}"`);
    const region = recipe.regions.find((r) => r.id === zone && r.within === undefined);
    if (!region) err(f, "unknown-zone", `${zone} is not a wilderness zone`);
    const locations = new Map(g.locations.map((l) => [l.id, l]));
    // the ground each place was picked from (brief places[].site, from `zonegen sites`)
    const parsedBrief = exists(p.brief(zone)) ? zoneBriefSchema.safeParse(readJson(p.brief(zone))) : null;
    const placeSize = new Map((parsedBrief?.success ? parsedBrief.data.places : []).map((x) => [x.id, x.size] as const));
    const picks = new Map((parsedBrief?.success ? parsedBrief.data.places : []).flatMap((x) => (x.site ? [[x.id, x.site] as const] : [])));
    const towns = recipe.features.towns;
    const roads = recipe.features.roads;
    const rivers = recipe.features.rivers;
    const pois = new Map(recipe.features.pois.map((x) => [x.id, x]));
    // features a site's own build added carry its job id as a prefix (the-undercut-path, fieldfast-hall-track...)
    const jobsDir = path.join(p.zoneDir(zone), "pois");
    const jobIds = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir) : [];
    const builtBy = (id: string): boolean => jobIds.some((j) => id === j || id.startsWith(`${j}-`)) || g.locations.some((l) => id.startsWith(`${l.id}-`));

    // --prune-approaches: drop the SECONDARY approaches (`approaches[]`) whose `from` no longer exists in the world — a
    // trail the trails stage stopped cutting, a road renamed away (2026-10-28 s1e: re-siting Saltharrow put a border pass
    // on peak-3, so trail-peak-3 was never cut again and two reservations named it). The primary `approach` is never
    // pruned (a place must be reached from something: re-plan it). Writes reservations.json, schema-validated.
    if (ctx.flag("prune-approaches")) {
      const base = (id: string) => id.replace(/(\.[sj]?\d+)+$/, "");
      const exists = (from: string) =>
        roads.some((x) => x.id === from || base(x.id) === base(from)) || rivers.some((x) => x.id === from) || towns.some((t) => t.id === from) ||
        pois.has(from) || res.reservations.some((x) => x.location === from) || locations.has(from);
      let pruned = 0;
      for (const r of res.reservations) {
        const before = r.approaches.length;
        r.approaches = r.approaches.filter((a) => {
          if (exists(a.from)) return true;
          console.log(`  pruned ${r.location} approach "${a.from}": no such road, river, town, POI or location in the world any more`);
          return false;
        });
        pruned += before - r.approaches.length;
      }
      if (pruned > 0) {
        writeJson(p.reservations(zone), reservationsSchema.parse(res));
        console.log(`  wrote ${p.reservations(zone)} (${pruned} approach(es) pruned)`);
      }
    }
    if (ctx.flag("pick")) {
      const code = pickPlaces(ctx, res, recipe, locations, parsedBrief?.success ? parsedBrief.data.places : []);
      if (code !== 0) return code;
    }
    for (const l of g.locations) if (l.kind !== "town" && !res.reservations.some((r) => r.location === l.id)) err(f, "unreserved", `location ${l.id} has no reservation`, l.id);

    // a SUB-SITE (location `place` = a brief place: its camp, pool, hold, dungeon door) lies INSIDE that place's
    // reservation and shares its ways in: the roads and rivers the place names may cross the sub-site too
    const parentRes = (r: { location: string }): (typeof res.reservations)[number] | undefined => {
      const pl = locations.get(r.location)?.place;
      return pl ? res.reservations.find((x) => x.location === pl) : undefined;
    };
    const namedWays = (r: (typeof res.reservations)[number]): string[] => {
      const up = parentRes(r);
      return [r.approach, ...r.approaches, ...(up ? [up.approach, ...up.approaches] : [])].map((a) => a.from);
    };
    // --adopt-roads: a generated road or trail that now runs through a reservation (a re-cut network, a renumbered peak
    // trail) is named as one of its approaches instead of failing `on-road` — what an owner did by hand before
    // (2026-10-28 s1e: the Knucklecrown's peak trail came back as trail-peak-6). Writes reservations.json, schema-validated.
    if (ctx.flag("adopt-roads")) {
      let adopted = 0;
      // L (KNUCKLECROWN close 2026-10-29: `approach-renumbered` warned on the knucklecrown and chisel-camp for
      // path-town-1-site-crown.s3, and no flag could rename it, so the owner had to ask the coordinator): an approach
      // naming a road PIECE that no longer exists is re-pointed at the piece of the same road nearest the reservation
      // (the leg that runs into the place); a secondary that then repeats another approach of the same reservation goes
      const pieceBase = (id: string) => id.replace(/(\.[sj]?\d+)+$/, "");
      for (const r of res.reservations) {
        for (const a of [r.approach, ...r.approaches]) {
          if (roads.some((x) => x.id === a.from) || rivers.some((x) => x.id === a.from)) continue;
          const pieces = roads.filter((x) => pieceBase(x.id) === pieceBase(a.from));
          if (!pieces.length) continue;
          const near = pieces.reduce((m, x) => (distToPolyline(r.center[0], r.center[1], x.points) < distToPolyline(r.center[0], r.center[1], m.points) ? x : m));
          console.log(`  renamed ${r.location} approach "${a.from}" -> "${near.id}" (the piece of ${pieceBase(a.from)} nearest the reservation)`);
          a.from = near.id;
          adopted++;
        }
        const seen = new Set([r.approach.from]);
        r.approaches = r.approaches.filter((a) => {
          if (a.points.length >= 2 || !seen.has(a.from)) { seen.add(a.from); return true; }
          console.log(`  dropped ${r.location} approach "${a.from}": it repeats another approach of the reservation`);
          adopted++;
          return false;
        });
      }
      for (const r of res.reservations) {
        for (const road of roads) {
          if (builtBy(road.id) || namedWays(r).includes(road.id)) continue;
          if (distToPolyline(r.center[0], r.center[1], road.points) >= r.radius + road.width / 2) continue;
          r.approaches.push({ from: road.id, points: [] } as (typeof r.approaches)[number]);
          console.log(`  adopted ${road.id} as an approach of ${r.location}`);
          adopted++;
        }
      }
      if (adopted > 0) {
        writeJson(p.reservations(zone), reservationsSchema.parse(res));
        console.log(`  wrote ${p.reservations(zone)} (${adopted} approach(es) adopted)`);
      }
    }
    for (const r of res.reservations) {
      const ref = r.location;
      const loc = locations.get(r.location);
      if (!loc) {
        err(f, "unknown-location", `${ref}: not a location of the quest graph`, ref);
        continue;
      }
      if (loc.kind === "town") warn(f, "town-reserved", `${ref}: a town location needs no reservation (the town plan owns it)`, ref);
      const [x, z] = r.center;
      if (region && !inZone(region, x, z)) err(f, "outside-zone", `${ref}: centre [${x}, ${z}] is outside ${zone}`, ref);

      for (const t of towns) {
        const d = Math.hypot(x - t.center[0], z - t.center[1]);
        if (loc.kind !== "town" && d < r.radius + t.radius + t.falloff) err(f, "on-town", `${ref}: overlaps town ${t.id}'s footprint (${Math.round(d)} m from its centre)`, ref);
        if (loc.minTownDistance > 0 && d - t.radius < loc.minTownDistance)
          err(f, "town-distance", `${ref}: ${Math.round(d - t.radius)} m from ${t.id}'s edge, must keep ${loc.minTownDistance} m`, ref);
      }
      for (const road of roads) {
        if (builtBy(road.id)) continue; // a track a site's own build laid is not a planning clash
        const d = distToPolyline(x, z, road.points);
        if (d < r.radius + road.width / 2 && !namedWays(r).includes(road.id)) err(f, "on-road", `${ref}: sits on ${road.id} (${Math.round(d)} m from it) without naming it as its approach`, ref);
      }
      for (const river of rivers) {
        // a dry painted line (water: false) is how site builds paint ground and clear trees: not a river to plan around
        if ((river as { water?: boolean }).water === false || builtBy(river.id)) continue;
        const d = distToPolyline(x, z, river.points);
        if (d < r.radius + river.width / 2 && !namedWays(r).includes(river.id)) err(f, "on-river", `${ref}: sits on river ${river.id} (${Math.round(d)} m)`, ref);
      }
      if (loc.kind !== "town") {
        const size = placeSize.get(r.location) ?? loc.size;
        const small = reservationTierFault(size, { radius: r.radius, approaches: 1 + r.approaches.length });
        // a dated approachRuling excepts the approach COUNT only: re-test with the tier's count met, so the diameter still fails
        const ruled = small && r.approachRuling ? reservationTierFault(size, { radius: r.radius, approaches: 99 }) === null : false;
        if (ruled) warn(f, "under-tier-ruled", `${ref}: ${small} — ruled: ${r.approachRuling}`, ref);
        else if (small) err(f, "under-tier", `${ref}: ${small} (tools/poi-review/size-tiers.mjs; grow the reservation or re-tier the place)`, ref);
        else if (2 * r.radius > tierFor(size).footprintDiameterM.max) warn(f, "over-tier", `${ref}: ${2 * r.radius} m across is more than a ${size} place (${tierFor(size).footprintDiameterM.max} m): the next tier up?`, ref);
      }
      if (r.terrainRadius > 0 && r.terrainRadius < r.radius) warn(f, "terrain-radius", `${ref}: may reshape terrain only inside ${r.terrainRadius} m of a ${r.radius} m site`, ref);

      if (r.site !== "new") {
        const poi = pois.get(r.site);
        const town = towns.find((t) => t.id === r.site);
        if (!poi && !town) err(f, "site", `${ref}: site "${r.site}" is neither a recipe POI nor a town (use "new" for surveyed ground)`, ref);
        if (poi) {
          if (loc.siteKinds.length === 0) err(f, "site-kind", `${ref}: the location asks for a new site (no siteKinds) but takes ${poi.id}`, ref);
          else if (!loc.siteKinds.includes(poi.kind)) err(f, "site-kind", `${ref}: ${poi.id} is a ${poi.kind}, the location wants ${loc.siteKinds.join(" / ")}`, ref);
          if (poi.zone && poi.zone !== zone) err(f, "site-zone", `${ref}: ${poi.id} stands in ${poi.zone}`, ref);
          const d = Math.hypot(poi.position[0] - x, poi.position[2] - z);
          if (d > r.radius) err(f, "site-far", `${ref}: centre is ${Math.round(d)} m from its site ${poi.id}, outside the ${r.radius} m reservation`, ref);
        }
      }
      // every named approach must exist AND come near: its line (road, river) or its place (town, POI, reservation)
      // within APPROACH_REACH of this reservation's edge
      for (const a of [r.approach, ...r.approaches]) {
        const from = a.from;
        const exact = roads.find((x) => x.id === from) ?? rivers.find((x) => x.id === from);
        // a road PIECE id (`path-a-b.s3`) is renumbered whenever the road is re-cut upstream: when the exact piece is gone,
        // the road's other pieces answer for it (2026-10-28 s1e: re-siting Saltharrow renumbered path-town-1-site-crown)
        const base = from.replace(/(\.[sj]?\d+)+$/, "");
        const pieces = exact ? [] : roads.filter((x) => x.id.replace(/(\.[sj]?\d+)+$/, "") === base);
        const line = exact ?? (pieces.length > 0 ? { id: from, points: pieces.flatMap((x) => x.points) } : undefined);
        if (!exact && pieces.length > 0) warn(f, "approach-renumbered", `${ref}: approach "${from}" is no longer a piece id; measured on ${base}'s ${pieces.length} piece(s) — rename it to one of ${pieces.map((x) => x.id).join(", ")}`, ref);
        const town = towns.find((t) => t.id === from);
        const poi = pois.get(from);
        const other = res.reservations.find((x) => x.location === from);
        // metres from `from` to the disc (px, pz, pr): its line, town pad, POI or reservation edge
        const gapAt = (px: number, pz: number, pr: number): number | null => {
          if (exact) return distToPolyline(px, pz, exact.points) - pr;
          if (line) return Math.min(...pieces.map((x) => distToPolyline(px, pz, x.points))) - pr;
          if (town) return Math.hypot(town.center[0] - px, town.center[1] - pz) - pr - town.radius - town.falloff;
          if (poi) return Math.hypot(poi.position[0] - px, poi.position[2] - pz) - pr;
          if (other) return Math.hypot(other.center[0] - px, other.center[1] - pz) - pr - other.radius;
          return null;
        };
        let gap = gapAt(x, z, r.radius);
        if (gap !== null) gap = plannedRouteGap(gap, a.points, x, z, r.radius, gapAt);
        if (gap === null) {
          if (locations.has(from)) warn(f, "approach-unplaced", `${ref}: approached from location ${from}, which has no reservation to measure`, ref);
          else err(f, "approach", `${ref}: approached from "${from}", which is no road, river, town, recipe POI or reserved location`, ref);
          continue;
        }
        if (gap > APPROACH_REACH) err(f, "approach-far", `${ref}: approach "${from}" passes ${Math.round(gap)} m from the reservation's edge (at most ${APPROACH_REACH} m${a.points.length >= 2 ? ", along its planned route too" : ""}): it does not lead here`, ref);
      }
      // a place that recorded its ground pick is reserved ON that ground
      const picked = picks.get(r.location);
      if (picked) {
        const d = Math.hypot(picked.at[0] - x, picked.at[1] - z);
        if (d > r.radius) err(f, "off-site", `${ref}: the brief picked the ${picked.kind} at [${picked.at.join(", ")}]; the reservation is centred ${Math.round(d)} m from it, outside its ${r.radius} m radius`, ref);
      }
      if (loc.kind === "dungeon-entrance" && !r.entrance) warn(f, "entrance", `${ref}: a dungeon entrance with no entrance position/yaw yet`, ref);
    }

    // major hostile places sit off town-to-town roads; a lookout over one is declared (location `overlooksRoad`)
    const content: Content[] = [
      ...towns.map((t) => ({ id: t.id, kind: "town" as const, x: t.center[0], z: t.center[1], radius: t.radius + t.falloff })),
      ...res.reservations.map((r) => ({ id: r.location, kind: "reservation" as const, x: r.center[0], z: r.center[1], radius: r.radius, zone, hostile: !!locations.get(r.location)?.hostile, overlooksRoad: locations.get(r.location)?.overlooksRoad === true })),
    ];
    for (const h of hostileOnMainRoads(content, travelRoads(recipe as never))) if (!h.lookout) err(f, "hostile-on-road", h.message, h.place);

    // ---- site needs: the ground under each reservation that has a role
    const briefPlaces = new Map((parsedBrief?.success ? parsedBrief.data.places : []).map((x) => [x.id, x] as const));
    const roleOf = (r: (typeof res.reservations)[number]): { role: SiteRole; overrides: SiteNeedOverrides } | null => {
      const loc = locations.get(r.location);
      if (!loc) return null;
      const own = briefPlaces.get(r.location);
      const parent = loc.place ? briefPlaces.get(loc.place) : undefined;
      if (own?.archetype) return { role: own.archetype, overrides: own.siteNeeds ?? {} };
      if (loc.kind === "dungeon-entrance") return { role: (parent ?? own)?.dungeon?.entrance === "landmark" ? "grand-entrance" : "dungeon-door", overrides: own?.siteNeeds ?? parent?.siteNeeds ?? {} };
      return null;
    };
    const roled = res.reservations.map((r) => [r, roleOf(r)] as const).filter(([, x]) => x !== null);
    if (roled.length) {
      const g = needGround(recipe, naturalField(recipe), undefined, placesFor(ctx, res.reservations));
      for (const [r, x] of roled) {
        const at: [number, number] = r.entrance ? [r.entrance.position[0], r.entrance.position[2]] : r.center;
        const rep = measureNeeds(g, x!.role, at[0], at[1], r.radius, x!.overrides, { self: r.location });
        for (const m of rep.results) {
          if (m.met) continue;
          const ruled = r.needRulings.find((q) => q.need === m.need);
          if (ruled) warn(f, "site-need-ruled", `${r.location} (${x!.role}) ${m.need} unmet but ruled (${ruled.ruling}): ${m.message}`, r.location);
          else err(f, "site-need", `${r.location} (${x!.role}) ${m.need} at [${at.map(Math.round).join(", ")}]: ${m.message}. Re-site it (zonegen sites --role ${x!.role} --propose, reserve --pick), ask the generator for the ground (recipe needs + worldgen needs), or a dated needRulings entry`, r.location);
        }
        if (rep.met) console.log(`  ${r.location} (${x!.role}): needs met — ${rep.results.map((m) => m.message).join("; ")}`);
      }
    }

    const list = res.reservations;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const d = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);
        const [outer, inner] = parentRes(b) === a ? [a, b] : parentRes(a) === b ? [b, a] : [null, null];
        if (outer && inner) {
          if (d + inner.radius > outer.radius) err(f, "outside-place", `${inner.location} is a sub-site of ${outer.location} and reaches ${Math.round(d + inner.radius - outer.radius)} m outside it`, `${outer.location}|${inner.location}`);
          continue;
        }
        if (d < a.radius + b.radius) err(f, "overlap", `${a.location} and ${b.location} overlap (${Math.round(d)} m apart, radii ${a.radius}+${b.radius})`, `${a.location}|${b.location}`);
        else if (a.interior === "embedded" && b.interior === "embedded") {
          const ra = Math.max(a.radius, a.terrainRadius);
          const rb = Math.max(b.radius, b.terrainRadius);
          if (d < ra + rb) err(f, "underground-overlap", `${a.location} and ${b.location} are embedded and their volumes overlap underground`, `${a.location}|${b.location}`);
        }
      }
    console.log(`reserve ${zone}: ${list.length} reservations; traversal NOT proven here (POI owner's walk gate)`);
  }
  return finish(ctx, "reserve", [p.reservations(zone), p.quests(zone), p.recipe, p.brief(zone)], f);
}

/**
 * reserve --pick <file>: centre each picked location's reservation on its candidate (re-measured: refused when the
 * ground fails a need of its role and no dated ruling excepts it) and record the pick as the brief place's `site`.
 * Writes reservations.json (schema-validated) and the brief; nothing when any row is refused.
 */
function pickPlaces(
  ctx: Ctx,
  res: { zone: string; reservations: import("../schemas.mts").Reservation[] },
  recipe: ReturnType<typeof loadRecipe>,
  locations: Map<string, { id: string; kind: string; place: string }>,
  places: readonly { id: string; dungeon?: { entrance: string }; archetype?: SiteRole; siteNeeds?: SiteNeedOverrides }[],
): number {
  const p = ctx.paths;
  const pickFile = path.resolve(ctx.opt("pick"));
  if (!exists(pickFile)) { console.error(`reserve --pick: no file ${pickFile}`); return 2; }
  const parsed = placePickSchema.safeParse(readJson(pickFile));
  if (!parsed.success) { console.error(`reserve --pick: ${pickFile} is not a choice file:\n${parsed.error.message}`); return 2; }
  const dir = path.dirname(pickFile);
  const fromFile = parsed.data.from ? path.resolve(dir, parsed.data.from) : fs.readdirSync(dir).filter((x) => x.startsWith(`${ctx.zone}-`) && x.endsWith(".json") && x !== path.basename(pickFile)).map((x) => path.join(dir, x))[0];
  if (!fromFile || !exists(fromFile)) { console.error(`reserve --pick: no propose file (give "from"; zonegen sites --role <r> --propose writes it)`); return 2; }
  const proposal = readJson(fromFile) as { zone: string; role: SiteRole; overrides?: SiteNeedOverrides; radius: number; candidates: { id: string; kind: string; at: [number, number]; y: number; view: number }[] };
  if (proposal.zone !== ctx.zone) { console.error(`reserve --pick: ${path.basename(fromFile)} is for ${proposal.zone}, not ${ctx.zone}`); return 2; }
  const g = needGround(recipe, naturalField(recipe), undefined, placesFor(ctx, res.reservations));
  const byPlace = new Map(places.map((x) => [x.id, x] as const));
  const refused: string[] = [];
  const plan: { row: (typeof parsed.data.places)[number]; c: (typeof proposal.candidates)[number] }[] = [];
  for (const row of parsed.data.places) {
    const c = proposal.candidates.find((x) => x.id === row.candidate);
    const loc = locations.get(row.location);
    if (!c) { refused.push(`${row.candidate}: not in ${path.basename(fromFile)}`); continue; }
    if (!loc) { refused.push(`${row.location}: not a location of the quest graph`); continue; }
    const place = byPlace.get(row.location) ?? byPlace.get(loc.place);
    const overrides = { ...(proposal.overrides ?? {}), ...(place?.siteNeeds ?? {}) };
    const rep = measureNeeds(g, proposal.role, c.at[0], c.at[1], proposal.radius, overrides, { self: row.location });
    const miss = unexcepted(rep, row.rulings);
    if (miss.length) { refused.push(`${row.location} on ${row.candidate} (${proposal.role}) fails ${miss.map((m) => `${m.need}: ${m.message}`).join("; ")}`); continue; }
    if (!res.reservations.some((r) => r.location === row.location) && (!row.radius || !row.approach)) { refused.push(`${row.location} has no reservation yet: give radius and approach in its row`); continue; }
    plan.push({ row, c });
  }
  if (refused.length) {
    console.error(`reserve --pick REFUSED (nothing written):\n  ${refused.join("\n  ")}`);
    return 1;
  }
  const brief = exists(p.brief(ctx.zone)) ? (readJson(p.brief(ctx.zone)) as { places?: { id: string; site?: unknown }[] }) : null;
  let touched = 0;
  for (const { row, c } of plan) {
    let r = res.reservations.find((x) => x.location === row.location);
    if (!r) {
      r = reservationSchema.parse({ location: row.location, site: "new", center: c.at, radius: row.radius, approach: { from: row.approach } });
      res.reservations.push(r);
    }
    r.center = [c.at[0], c.at[1]];
    if (locations.get(row.location)?.kind === "dungeon-entrance") {
      // the door at the face foot, facing the front (yaw: radians about +Y, 0 = facing +Z)
      const front = (c.view * Math.PI) / 180;
      r.entrance = { position: [c.at[0], Math.round(g.height(c.at[0], c.at[1]) * 10) / 10, c.at[1]], yaw: Math.round(Math.atan2(Math.sin(front), -Math.cos(front)) * 1000) / 1000 };
    }
    r.needRulings = [...r.needRulings.filter((q) => !row.rulings.some((x) => x.need === q.need)), ...row.rulings];
    const bp = brief?.places?.find((x) => x.id === row.location);
    if (bp) touched++;
    if (bp) bp.site = { candidate: c.id, kind: c.kind === "face-foot" ? "other (rock-face foot)" : c.kind, at: c.at, faces: row.why };
    console.log(`  ${row.location} <- ${c.id} [${c.at.join(", ")}] (${proposal.role}): ${row.why}`);
  }
  writeJson(p.reservations(ctx.zone), reservationsSchema.parse(res));
  console.log(`  wrote ${p.reservations(ctx.zone)}`);
  if (brief && touched) {
    const ok = zoneBriefSchema.safeParse(brief);
    if (ok.success) { writeJson(p.brief(ctx.zone), brief); console.log(`  wrote ${p.brief(ctx.zone)} (places[].site)`); }
    else console.warn(`  brief not updated (it does not validate: ${ok.error.issues[0]?.message})`);
  }
  return 0;
}
