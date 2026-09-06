import { z } from "zod";
import { pointInPolygon, polygonArea, polygonEdgeDistance } from "../scatter.js";

/**
 * Regions — the zones players and servers know by name.
 *
 * A region is a named piece of the world an agent DRAWS on the map: "the
 * valley between the two ridges", "the canyon country east of the river",
 * with a story, a hub, and a border that follows landmarks (a ridge line, a
 * river, a gorge) so that nobody can see across it. It is deliberately not a
 * biome and not one of the recipe's climate cells (`climate.zones` are ~2 km
 * landform cells the generator rolls; a region usually spans several and may
 * cut one in half). Coarse on purpose: a region takes many minutes to cross.
 *
 * What reads them:
 * - chat: "zone" lines reach everyone in the same region, across every layer
 *   of the cluster (docs/comms.md);
 * - the cluster: placement is keyed by region, a border crossing is a
 *   transfer (docs/hosting.md, planned);
 * - the AI dungeon master: consequences and stories are told per region.
 *
 * Authoring procedure: docs/world-editing/zones.md.
 */
export const regionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "lowercase slug")
    .describe("Stable slug, referenced by chat, placement and stories. Never rename one players have seen."),
  name: z.string().min(1).describe("What players see: 'Ashfall Canyon', 'The Hollow Vale'."),
  story: z
    .string()
    .default("")
    .describe(
      "Two to five sentences: what this place is, why anyone goes there, what is wrong with it. The seed the AI " +
        "dungeon master grows consequences from; also the tooltip text on the map.",
    ),
  polygon: z
    .array(z.tuple([z.number(), z.number()]))
    .min(3)
    .describe(
      "Border in world metres [x, z], clockwise or counter-clockwise, no self-crossing. Follow LANDMARKS a player " +
        "cannot see across — ridge lines, river centrelines, gorge rims, the coast — never a straight line over " +
        "open ground: the border is where a server swap can happen, and a swap must not show two worlds.",
    ),
  hub: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe("Where an arriving player is placed and the map labels the region — normally a town centre inside the polygon."),
  landmarks: z
    .array(z.string())
    .default([])
    .describe("Feature ids inside or bounding the region (towns, rivers, canyons, peaks, pois) — what its borders were drawn on."),
  level: z
    .tuple([z.number().int().min(1), z.number().int().min(1)])
    .optional()
    .describe("Intended character level band [min, max]; the spawn tables and the story pitch to it."),
  cap: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Players per server copy of this region before another copy opens. Omit = the cluster default."),
  within: z
    .string()
    .optional()
    .describe(
      "Id of the region this one is CUT OUT of: wherever this polygon lies inside its parent, this region wins " +
        "(regionAt prefers the nested zone). How a town is a zone of its own inside the wilderness around it — " +
        "a simple polygon cannot hold a hole, so the cut-out is declared, not drawn. Never overlaps otherwise.",
    ),
  tags: z
    .array(z.string())
    .default([])
    .describe('"town" marks a town zone (hub = the town centre, landmarks[0] = its town id); "safe" makes the whole zone a sanctuary; "draft" = placeholder from worldgen zones.'),
});

export type RegionDoc = z.infer<typeof regionSchema>;
export type RegionInput = z.input<typeof regionSchema>;

/**
 * The region containing (x, z) — or null. A region cut out of another
 * (`within`) wins over its parent; otherwise the first polygon in recipe
 * order that contains the point.
 */
export function regionAt(regions: readonly RegionDoc[], x: number, z: number): RegionDoc | null {
  for (const region of regions) if (region.within !== undefined && pointInPolygon(x, z, region.polygon)) return region;
  for (const region of regions) if (region.within === undefined && pointInPolygon(x, z, region.polygon)) return region;
  return null;
}

/** The region tagged `town` that is `townId`'s own (its first landmark), or null. */
export function townRegionOf(regions: readonly RegionDoc[], townId: string): RegionDoc | null {
  for (const region of regions) if (region.tags.includes("town") && region.landmarks[0] === townId) return region;
  return null;
}

/** Whether every point of the circle (cx, cz, r) lies inside the polygon (sampled around the rim). */
export function polygonEnclosesCircle(polygon: readonly (readonly [number, number])[], cx: number, cz: number, r: number, samples = 16): boolean {
  if (!pointInPolygon(cx, cz, polygon)) return false;
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    if (!pointInPolygon(cx + Math.cos(a) * r, cz + Math.sin(a) * r, polygon)) return false;
  }
  return true;
}

export interface RegionReport {
  id: string;
  name: string;
  /** Square kilometres of the polygon. */
  areaKm2: number;
  centroid: [number, number];
  /** Whether `hub` (when set) lies inside the polygon. */
  hubInside: boolean | null;
  /** Feature ids of towns/pois inside. */
  towns: string[];
  pois: number;
  /** Other regions whose polygon overlaps this one's (by sampling), a placement ambiguity. */
  overlaps: string[];
  /** Region this one is cut out of, when nested (`within`). */
  within?: string;
}

export interface RegionsAudit {
  regions: RegionReport[];
  /** Towns no region claims — players there have no zone. */
  unclaimedTowns: string[];
  /** Problems worth fixing before the file is used. */
  findings: string[];
}

/**
 * What the map cannot tell you at a glance: size, what each region holds,
 * which towns fall between the lines, and whether two regions overlap.
 */
export function auditRegions(
  regions: readonly RegionDoc[],
  features: {
    towns: ReadonlyArray<{ id: string; center: readonly [number, number]; radius?: number; falloff?: number }>;
    pois: ReadonlyArray<{ id: string; position: readonly [number, number, number] }>;
  },
  opts: {
    /**
     * Metres a border may cross into a neighbour before it counts as an
     * overlap (default 150 — three cells of a `worldgen zones` draft). Two
     * zones drawn on the same river never match vertex for vertex; what
     * matters is a border that takes real ground.
     */
    overlapTolerance?: number;
  } = {},
): RegionsAudit {
  const tolerance = opts.overlapTolerance ?? 150;
  const findings: string[] = [];
  const seen = new Set<string>();
  const byId = new Map(regions.map((r) => [r.id, r]));
  // a world with town zones has opted in: every town must then have one
  const townZones = regions.some((r) => r.tags.includes("town"));
  const reports: RegionReport[] = regions.map((region) => {
    if (seen.has(region.id)) findings.push(`duplicate region id "${region.id}"`);
    seen.add(region.id);
    const area = Math.abs(polygonArea(region.polygon)) / 1e6;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of region.polygon) {
      cx += x;
      cz += z;
    }
    cx /= region.polygon.length;
    cz /= region.polygon.length;
    const hubInside = region.hub ? pointInPolygon(region.hub[0], region.hub[1], region.polygon) : null;
    if (hubInside === false) findings.push(`region "${region.id}": hub is outside its own border`);
    // a town zone is small by design: the town and its outskirts
    if (area < 0.5 && !region.tags.includes("town")) findings.push(`region "${region.id}": only ${area.toFixed(2)} km² — a zone should take minutes to cross`);
    const towns = features.towns.filter((t) => pointInPolygon(t.center[0], t.center[1], region.polygon)).map((t) => t.id);
    const pois = features.pois.filter((p) => pointInPolygon(p.position[0], p.position[2], region.polygon)).length;
    // a town zone holds its town by construction; a wilderness zone holds a
    // town when the town's own zone (or its centre) lies inside it
    if (towns.length === 0 && !region.tags.includes("town")) findings.push(`region "${region.id}": no town inside — where do players gather?`);
    if (region.within !== undefined) {
      const parent = byId.get(region.within);
      if (!parent) findings.push(`region "${region.id}": within "${region.within}", which does not exist`);
      else if (!region.polygon.every(([x, z]) => pointInPolygon(x, z, parent.polygon)))
        findings.push(`region "${region.id}": not wholly inside "${region.within}", which it claims to be cut out of`);
    }
    const overlaps: string[] = [];
    for (const other of regions) {
      if (other === region) continue;
      // a cut-out and its parent share ground by design
      if (other.within === region.id || region.within === other.id) continue;
      // a cheap overlap test: any vertex of one INSIDE the other — nudged a
      // metre toward its own centroid, so two zones that share a border (the
      // same river points on both sides) are neighbours, not an overlap
      if (anyVertexInside(other, region, tolerance) || anyVertexInside(region, other, tolerance)) overlaps.push(other.id);
    }
    if (overlaps.length > 0) findings.push(`region "${region.id}" overlaps ${overlaps.join(", ")} — the first in file order wins, the rest lose that ground`);
    return {
      id: region.id,
      name: region.name,
      areaKm2: Math.round(area * 100) / 100,
      centroid: [Math.round(cx), Math.round(cz)],
      hubInside,
      towns,
      pois,
      overlaps,
      ...(region.within !== undefined ? { within: region.within } : {}),
    };
  });
  const unclaimedTowns = features.towns.filter((t) => !regionAt(regions, t.center[0], t.center[1])).map((t) => t.id);
  if (unclaimedTowns.length > 0) findings.push(`${unclaimedTowns.length} town(s) in no region: ${unclaimedTowns.join(", ")}`);
  if (townZones) {
    // a town is a zone of its own (docs/world-editing/barriers.md → "Towns are
    // zones of their own"): its region must enclose the whole pad, wall to
    // outskirts, or a border runs through the town
    for (const town of features.towns) {
      const own = townRegionOf(regions, town.id);
      if (!own) {
        findings.push(`town "${town.id}" has no zone of its own (a region tagged "town" with it as first landmark)`);
        continue;
      }
      const reach = (town.radius ?? 45) + (town.falloff ?? 35);
      if (!polygonEnclosesCircle(own.polygon, town.center[0], town.center[1], reach))
        findings.push(`town "${town.id}": its zone "${own.id}" does not enclose the town (radius + falloff = ${reach} m) — a border runs through it`);
    }
  }
  return { regions: reports, unclaimedTowns, findings };
}

/** Any vertex of `a` lying inside `b` by more than `tolerance` metres from b's border. */
function anyVertexInside(a: RegionDoc, b: RegionDoc, tolerance: number): boolean {
  return a.polygon.some(([x, z]) => pointInPolygon(x, z, b.polygon) && polygonEdgeDistance(x, z, b.polygon) > tolerance);
}
