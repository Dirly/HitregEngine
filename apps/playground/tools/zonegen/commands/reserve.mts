import path from "node:path";
import fs from "node:fs";
/**
 * zonegen reserve <world> --project <p> --zone <id> — lint where every planned location goes.
 *
 * Every reservation is at least its size tier (tools/poi-review/size-tiers.mjs: diameter and approaches; owner ruling
 * 2026-10-03, a large place is 300-600 m): `under-tier` refuses it. The tier is the brief place's size when the
 * location IS a place, else the location's own.
 *
 * Plan-level geometry from the recipe only (no world field): inside the zone, clear of towns, roads, rivers and each
 * other, on a site of a fitting kind, reached from something that exists. Whether a walking body can actually get
 * there is NOT proven here: that is the POI owner's traversal gate (tools/poi-review), run on the real ground.
 */
import { exists, finish, load, loadRecipe, readJson, type Ctx, type Finding } from "../lib.mts";
import { questGraphSchema, reservationsSchema, zoneBriefSchema } from "../schemas.mts";
import { distToPolyline, err, inZone, requireZone, warn } from "./_shared.mts";
import { hostileOnMainRoads, travelRoads, type Content } from "./_site-finder.mts";
import { reservationTierFault, tierFor } from "../../../../../tools/poi-review/size-tiers.mjs";

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

    for (const l of g.locations) if (l.kind !== "town" && !res.reservations.some((r) => r.location === l.id)) err(f, "unreserved", `location ${l.id} has no reservation`, l.id);

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
        if (d < r.radius + road.width / 2 && ![r.approach, ...r.approaches].some((a) => a.from === road.id)) err(f, "on-road", `${ref}: sits on ${road.id} (${Math.round(d)} m from it) without naming it as its approach`, ref);
      }
      for (const river of rivers) {
        // a dry painted line (water: false) is how site builds paint ground and clear trees: not a river to plan around
        if ((river as { water?: boolean }).water === false || builtBy(river.id)) continue;
        const d = distToPolyline(x, z, river.points);
        if (d < r.radius + river.width / 2 && ![r.approach, ...r.approaches].some((a) => a.from === river.id)) err(f, "on-river", `${ref}: sits on river ${river.id} (${Math.round(d)} m)`, ref);
      }
      if (loc.kind !== "town") {
        const size = placeSize.get(r.location) ?? loc.size;
        const small = reservationTierFault(size, { radius: r.radius, approaches: 1 + r.approaches.length });
        if (small) err(f, "under-tier", `${ref}: ${small} (tools/poi-review/size-tiers.mjs; grow the reservation or re-tier the place)`, ref);
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
        const line = roads.find((x) => x.id === from) ?? rivers.find((x) => x.id === from);
        const town = towns.find((t) => t.id === from);
        const poi = pois.get(from);
        const other = res.reservations.find((x) => x.location === from);
        // metres from `from` to the disc (px, pz, pr): its line, town pad, POI or reservation edge
        const gapAt = (px: number, pz: number, pr: number): number | null => {
          if (line) return distToPolyline(px, pz, line.points) - pr;
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

    const list = res.reservations;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const d = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);
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
