/**
 * SITE NEEDS — the ground a place or a town needs, as measured data (2026-10-29, Derek on firstshore).
 *
 * The Wristgate (a 52 m carved front) went on a 40 m gorge beside a 31 m falls: "the river cliff doesn't support
 * this... you need a cliff for something of this calibre". Saltharrow, a WALLED town, went in a cove under a hill
 * where no wall line is defensible: "the cliffs beside them would have been better suited". Places were sited BY TYPE
 * (an entrance -> a falls, a harbour -> a cove) and nothing asked whether the ground could carry the idea.
 *
 * Here every role declares what it needs, in metres, and `measureNeeds` says met / unmet per need with the numbers.
 * Defaults live in SITE_NEEDS (this file is the one place); a brief place overrides them with `siteNeeds`.
 * Read by: `zonegen sites --role` / `--propose`, `zonegen reserve` (a reservation whose site fails a need FAILS unless a
 * dated coordinator ruling excepts it), `worldgen towns --propose` / `--pick` and the `towns` status row (a town's
 * `siteRole`), and `worldgen needs` (the generator making ground no candidate has: GENERATORS below).
 *
 * Pure: no I/O. The ground is a sampler (NeedGround), so tests run on synthetic fields.
 */
import { z } from "zod";
import { TOWN_SITE_ROLES, type GroundNeedDoc, type HeightPatchDoc } from "@hitreg/core";
import { OVERLOOK_RULE } from "./_town-wall-rules.mts";
import { terraceReach } from "./worldgen-coastal-towns.mts";
import { heightForPx, readPixels } from "./_place-quality.mts";

export type V2 = [number, number];

/** The ground the needs are measured on. `height` is the DRAWN ground (DC terrain: `field.ground`). */
export interface NeedGround {
  height(x: number, z: number): number;
  /** Standing water (sea, lake, river) at (x, z). */
  wet(x: number, z: number): boolean;
  sea: number;
  /** harbour-town: the coastal rule's faults at a pad (tools/worldgen-coastal-towns.mts coastalFaults); empty = a shore site. */
  coastal?(x: number, z: number, radius: number): string[];
  /** Travel roads, when the world has them (a crossroads counts the roads that meet). */
  roads?: readonly { id: string; points: readonly (readonly number[])[] }[];
  /** The biome id and the zone anchor id at (x, z) (`field.biome`): the `biome` need. */
  biome?(x: number, z: number): { id: string; zone: string };
  /** Places already sited (towns, reservations, a dogfood run's earlier picks): `distance-from`, `on-route`, `landmark-visible` from. */
  places?: readonly SitedPlace[];
}

/** A sited place a need can refer to as `town:<id>`, `place:<id>` or a bare `<id>` (`town:*` = the nearest town). */
export interface SitedPlace {
  id: string;
  kind: "town" | "place";
  at: V2;
  radius: number;
}

// ------------------------------------------------------------------ the schema (facts in .describe())

const reach = terraceReach();
/** Caps on the metres a need may ask (2026-10-29 t-needs): every measure loops over these (apron cells, pad samples, ring bands,
 *  probe runs), so an unbounded number (an apron of 1e9 m2, a pad of radius 1e5) made a measurement run for hours. */
export const MAX_M = { height: 400, reach: 400, apronM2: 40_000, distance: 3_000, band: 1_000, radius: 1_000 } as const;
const rockFace = z.object({
  kind: z.literal("rock-face"),
  frontHeight: z.number().positive().max(MAX_M.height).default(40).describe("Height of the carved / built front the face must carry, m."),
  ratio: z.number().min(1).default(1.1).describe("The face must stand this many times the front's height (rock above the lintel)."),
  minHeight: z.number().positive().max(MAX_M.height).optional().describe("Explicit face height, m (overrides frontHeight x ratio)."),
  faceSlope: z.number().positive().default(1).describe("Rise/run counted as rock face (1 = 45 deg)."),
  footReach: z.number().positive().max(MAX_M.reach).default(40).describe("The face's foot must start within this many metres of the site point."),
  apronM2: z.number().min(0).max(MAX_M.apronM2).default(1600).describe("Flat apron at the foot (plaza, stair landing), m2: dry, within 3 m of the foot's height, slope <= apronSlope."),
  apronSlope: z.number().positive().default(0.15).describe("Steepest rise/run counted as apron."),
  readDistance: z.number().min(0).max(MAX_M.distance).default(300).describe("The face must be seen (line of sight to its mid-height, eye 1.7 m) from at least this far in front of it; 0 = not measured."),
});
const defensible = z.object({
  kind: z.literal("defensible"),
  margin: z.number().min(0).max(MAX_M.reach).default(12).describe("The wall ring stands this far outside the pad radius, m."),
  maxWall: z.number().positive().default(260).describe("Most metres of wall the open (unprotected) ring may need: cliff flanks or a neck <= this to wall."),
  flankDrop: z.number().positive().default(8).describe("A bearing is PROTECTED when the ground within flankBand outside the ring falls this far under the pad, or is water."),
  flankBand: z.number().positive().max(MAX_M.band).default(30).describe("Metres outside the ring a protecting drop must happen within."),
  overlookBand: z.number().positive().max(MAX_M.band).default(OVERLOOK_RULE.band).describe("No ground within this many metres outside the ring may see over the wall top (the town-wall-line overlook rule, pre-layout)."),
  wallHeight: z.number().positive().default(6).describe("Wall height over the pad, m (town-wall-line draw --height default)."),
  parapet: z.number().min(0).default(1.2).describe("Parapet over the wall top, m."),
});
const shore = z.object({ kind: z.literal("shore") }).describe("The coastal rule (tools/worldgen-coastal-towns.mts COASTAL_TOWN: <= 12 m over the sea, <= 90 m from a sheltered cove / sand-beach, steppable, dry).");
const flatPad = z.object({
  kind: z.literal("flat-pad"),
  radius: z.number().positive().max(MAX_M.radius).optional().describe("Pad radius measured, m (default the site's radius): a large place's core inside a wider site."),
  maxRelief: z.number().positive().default(reach.maxRelief).describe("Most relief (p05..p95) across the pad a terrace steps, m (worldgen terrace defaults)."),
  maxSlope: z.number().positive().default(Math.round(reach.maxSlope * 100) / 100).describe("Most mean rise/run across the pad a terrace steps."),
});
const highGround = z.object({
  kind: z.literal("high-ground"),
  radius: z.number().positive().max(MAX_M.radius).optional().describe("Pad radius the rise is measured from, m (default the site's radius)."),
  minRise: z.number().positive().default(15).describe("The pad stands at least this far over the median ground on a ring `ring` m outside it."),
  ring: z.number().positive().max(MAX_M.band).default(150).describe("Metres outside the pad edge the surroundings are read at."),
});
const crossroads = z.object({
  kind: z.literal("crossroads"),
  minWays: z.number().int().min(1).default(4).describe("Open ways in (of 8 compass sectors: walkable ground out to `reach` m) or roads meeting within 150 m of the pad edge."),
  reach: z.number().positive().max(MAX_M.distance).default(500).describe("Metres a way must run open."),
  maxGrade: z.number().positive().default(0.2).describe("Steepest rise/run over a 12 m step a way may climb (two steps over it are allowed)."),
});

const placeRef = z
  .string()
  .min(1)
  .describe("A sited place: `town:<id>` (a recipe town), `place:<id>` (a reservation's location, a dogfood run's earlier place) or a bare id; `town:*` = the nearest town.");
const biome = z.object({
  kind: z.literal("biome"),
  any: z.array(z.string().min(1)).min(1).describe("Allowed biome ids or zone anchor ids (recipe `biomes[].id`, `climate.zones.anchors[].id`): a sample counts when its biome OR its anchor is listed."),
  none: z.array(z.string().min(1)).default([]).describe("Forbidden biome / anchor ids (the riparian ribbon's anchor, say)."),
  share: z.number().min(0).max(1).default(0.7).describe("Least share of the pad samples in an allowed biome/anchor."),
  maxNone: z.number().min(0).max(1).default(0.05).describe("Most share of the pad samples in a forbidden biome/anchor."),
  radius: z.number().positive().max(MAX_M.radius).optional().describe("Radius sampled, m (default the site's radius)."),
});
const landmarkVisible = z.object({
  kind: z.literal("landmark-visible"),
  height: z.number().positive().max(MAX_M.height).default(20).describe("Height of the BUILT landmark at the site centre over its ground, m (the Needle 36, a tilted stone 5)."),
  distance: z.number().positive().max(MAX_M.distance).default(300).describe("It must show from at least this far out, m (a large place 300, small 150, roadside 120)."),
  px: z.number().positive().default(16).describe("Least pixels of it showing over the ground between, in the 1280x720 / 60 deg evidence frame (tools/_place-quality.mts READ_PX_MIN: the place-read rule)."),
  from: z
    .string()
    .default("any")
    .describe("Where the eye stands (1.7 m over dry ground): `any` = the best of 16 bearings; `road` = on a travel road; or a place ref (`town:<id>`, `place:<id>`): along the bearing to it, +-30 deg."),
});
const distanceFrom = z.object({
  kind: z.literal("distance-from"),
  place: placeRef,
  min: z.number().min(0).default(0).describe("Least metres to it."),
  max: z.number().positive().optional().describe("Most metres to it."),
  edges: z.boolean().default(true).describe("Measure edge to edge (centre distance less both radii); false = centre to centre."),
});
const onRoute = z.object({
  kind: z.literal("on-route"),
  from: placeRef.optional().describe("One end of the route (a place ref). With `to` omitted too: any travel road, or the straight line between any two sited places."),
  to: placeRef.optional().describe("The other end of the route."),
  along: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0, 1]).describe("Fraction of the route's length (from `from`) the site's nearest point must fall in."),
  offset: z.tuple([z.number().min(0), z.number().positive().max(MAX_M.band)]).default([0, 80]).describe("Metres from the route line to the site centre: [least, most]. The route is a road passing within 150 m of both ends' edges when one exists, else the straight line between the two places."),
});
const baseNeeds = [rockFace, defensible, shore, flatPad, highGround, crossroads, biome, landmarkVisible, distanceFrom, onRoute] as const;
const subsite = z.object({
  kind: z.literal("subsite"),
  id: z.string().min(1).describe("The sub-site's name (sump, gate, camp)."),
  within: z.tuple([z.number().min(0), z.number().positive().max(MAX_M.band)]).default([60, 200]).describe("Metres from the site centre the second point is searched in (an annulus, 16 bearings, 20 m steps)."),
  below: z.number().min(0).default(0).describe("The second point's ground lies at least this far under the site centre's ground, m (a cave under the table lip)."),
  radius: z.number().positive().max(MAX_M.radius).default(20).describe("Radius the inner need is measured with at the second point, m."),
  need: z.discriminatedUnion("kind", [...baseNeeds]).describe("The need measured at the second point (any kind but subsite)."),
});

export const siteNeedSchema = z
  .discriminatedUnion("kind", [...baseNeeds, subsite])
  .describe("One measured requirement on the ground under a place or town.");
export type SiteNeed = z.infer<typeof siteNeedSchema>;
export type NeedKind = SiteNeed["kind"];
export const NEED_KINDS = [
  "rock-face", "defensible", "shore", "flat-pad", "high-ground", "crossroads", "biome", "landmark-visible", "distance-from", "on-route", "subsite",
] as const satisfies readonly NeedKind[];

export const siteNeedOverridesSchema = z
  .object({
    "rock-face": rockFace.omit({ kind: true }).partial(),
    defensible: defensible.omit({ kind: true }).partial(),
    "flat-pad": flatPad.omit({ kind: true }).partial(),
    "high-ground": highGround.omit({ kind: true }).partial(),
    crossroads: crossroads.omit({ kind: true }).partial(),
    biome: biome.omit({ kind: true }).partial(),
    "landmark-visible": landmarkVisible.omit({ kind: true }).partial(),
    "distance-from": distanceFrom.omit({ kind: true }).partial(),
    "on-route": onRoute.omit({ kind: true }).partial(),
    add: z.array(siteNeedSchema).describe("Further needs beyond the role's (a second distance-from, a subsite): appended whole."),
  })
  .partial()
  .describe(
    "Per-place overrides of its role's needs (tools/site-needs.mts SITE_NEEDS): { \"rock-face\": { frontHeight: 52 } }. An override of a kind the role " +
      "does not have ADDS that need (it must then be complete: { \"biome\": { any: [\"badlands\"] } }); `add` appends further whole needs.",
  );
export type SiteNeedOverrides = z.infer<typeof siteNeedOverridesSchema>;

/** Roles of places (POIs, dungeon doors) beside the town roles of the recipe (`townSchema.siteRole`). */
export const PLACE_SITE_ROLES = ["grand-entrance", "dungeon-door", "lookout", "harbour", "large-place", "roadside-place"] as const;
export const SITE_ROLES = [...TOWN_SITE_ROLES, ...PLACE_SITE_ROLES] as const;
export type SiteRole = (typeof SITE_ROLES)[number];
export const siteRoleSchema = z.enum(SITE_ROLES).describe(
  "What the site is FOR, so its ground needs can be measured (tools/site-needs.mts SITE_NEEDS): grand-entrance = a rock face >= 1.1 x the front, " +
    "a 1600 m2 apron, seen from 300 m; dungeon-door = rock >= 1.5 x an 8 m door behind it; lookout = high ground; harbour = the shore rule; " +
    "large-place = a steppable r60 core 15 m over the ground 150 m round it, 3 open ways in, a 20 m landmark seen from 300 m (site r150); " +
    "roadside-place = a level r60 pad (relief <= 6 m) within 80 m of a road or the line between two sited places, a 5 m landmark seen from 120 m; " +
    "walled-town = flanks or a neck <= 260 m to wall and no ground within 60 m over the wall top; harbour-town = the coastal rule; " +
    "capital / crossroads-town = 4 open ways in; hill-town = 15 m over its surroundings; every town = a steppable pad.",
);

/** THE DEFAULTS: what each role needs (one place; a brief place overrides with `siteNeeds`). */
export const SITE_NEEDS: Record<SiteRole, readonly Record<string, unknown>[]> = {
  "grand-entrance": [{ kind: "rock-face" }],
  "dungeon-door": [{ kind: "rock-face", frontHeight: 8, ratio: 1.5, apronM2: 150, readDistance: 0, footReach: 25 }],
  lookout: [{ kind: "high-ground", minRise: 25, ring: 120 }],
  harbour: [{ kind: "shore" }],
  // a large place (300-600 m): the core steps, stands clear of its surroundings, is reached three ways and reads from 300 m
  "large-place": [
    { kind: "flat-pad", radius: 60 },
    { kind: "high-ground", radius: 60, minRise: 15, ring: 150 },
    { kind: "crossroads", minWays: 3, reach: 300 },
    { kind: "landmark-visible", height: 20, distance: 300 },
  ],
  // a small place on or beside a route between two places: level, by the route, its landmark seen from the road
  "roadside-place": [
    { kind: "flat-pad", maxRelief: 6 },
    { kind: "on-route" },
    { kind: "landmark-visible", height: 5, distance: 120 },
  ],
  town: [{ kind: "flat-pad" }],
  capital: [{ kind: "flat-pad" }, { kind: "crossroads" }],
  "walled-town": [{ kind: "flat-pad" }, { kind: "defensible" }],
  "harbour-town": [{ kind: "shore" }],
  "hill-town": [{ kind: "flat-pad" }, { kind: "high-ground" }],
  "crossroads-town": [{ kind: "flat-pad" }, { kind: "crossroads", minWays: 5 }],
};

/** The site radius a role is measured with when none is given (the place's reserved radius; towns: the tier's). */
export const ROLE_RADIUS: Partial<Record<SiteRole, number>> = { "grand-entrance": 60, "dungeon-door": 20, lookout: 40, harbour: 60, "large-place": 150, "roadside-place": 60 };

/** The needs of a role with a place's overrides merged, schema-parsed (defaults filled in). An override of a kind the
 *  role lacks adds that need; `add` appends whole needs. */
export function needsFor(role: SiteRole, overrides: SiteNeedOverrides = {}): SiteNeed[] {
  const o = overrides as Record<string, object | undefined>;
  const parse = (n: object, why: string): SiteNeed => {
    const r = siteNeedSchema.safeParse(n);
    if (!r.success) throw new Error(`site need ${why}: ${r.error.issues.map((i) => `${i.path.join(".") || "(need)"} ${i.message}`).join("; ")}`);
    return r.data;
  };
  const kinds = new Set(SITE_NEEDS[role].map((n) => n.kind as string));
  const out = SITE_NEEDS[role].map((n) => {
    const kind = n.kind as NeedKind;
    return parse({ ...n, ...(kind === "shore" ? {} : (o[kind] ?? {})) }, `${kind} of ${role}`);
  });
  for (const [kind, v] of Object.entries(o)) if (kind !== "add" && v && !kinds.has(kind)) out.push(parse({ kind, ...v }, `${kind} (added by the place's siteNeeds)`));
  for (const n of overrides.add ?? []) out.push(parse(n, `${n.kind} (siteNeeds.add)`));
  return out;
}

// ------------------------------------------------------------------ measuring

export interface NeedResult {
  need: NeedKind;
  met: boolean;
  /** The measured numbers (metres, m2, bearings). */
  numbers: Record<string, number | string | null>;
  /** What is short, in words with numbers; empty when met. */
  faults: string[];
  /** One line. */
  message: string;
}
export interface NeedsReport {
  role: string;
  met: boolean;
  results: NeedResult[];
}

const R1 = (v: number) => Math.round(v * 10) / 10;
const dirOf = (bearing: number): V2 => [Math.sin((bearing * Math.PI) / 180), -Math.cos((bearing * Math.PI) / 180)];
export const bearingOf = (dx: number, dz: number): number => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compassWord = (b: number): string => COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8]!;
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!;
};

/** Heights and slopes over a pad disc (6 m grid). */
function padStats(g: NeedGround, x: number, z: number, radius: number): { median: number; max: number; relief: number; meanSlope: number; wet: number } {
  const step = 6;
  const hs: number[] = [];
  let slope = 0, n = 0, wet = 0;
  for (let dz = -radius; dz <= radius; dz += step)
    for (let dx = -radius; dx <= radius; dx += step) {
      if (dx * dx + dz * dz > radius * radius) continue;
      const px = x + dx, pz = z + dz;
      const h = g.height(px, pz);
      hs.push(h);
      const gx = (g.height(px + 3, pz) - g.height(px - 3, pz)) / 6, gz = (g.height(px, pz + 3) - g.height(px, pz - 3)) / 6;
      slope += Math.hypot(gx, gz);
      n++;
      if (g.wet(px, pz)) wet++;
    }
  return { median: quantile(hs, 0.5), max: Math.max(...hs), relief: quantile(hs, 0.95) - quantile(hs, 0.05), meanSlope: slope / Math.max(1, n), wet };
}

/** The best rock face rising from within `footReach` of (x, z): its height, the bearing INTO the rock, foot and top. */
export function bestFace(g: NeedGround, x: number, z: number, o: { faceSlope: number; footReach: number; maxRun?: number; bearings?: number }): {
  height: number; into: number; foot: V2; footY: number; top: V2; run: number;
} {
  const step = 2;
  const nb = o.bearings ?? 36;
  const maxRun = o.maxRun ?? 160;
  let best = { height: 0, into: 0, foot: [x, z] as V2, footY: g.height(x, z), top: [x, z] as V2, run: 0 };
  for (let k = 0; k < nb; k++) {
    const b = (k * 360) / nb;
    const [dx, dz] = dirOf(b);
    const H = (s: number) => g.height(x + dx * s, z + dz * s);
    let start = -1;
    for (let s = 0; s <= o.footReach; s += step) if ((H(s + 4) - H(s)) / 4 >= o.faceSlope) { start = s; break; }
    if (start < 0) continue;
    if (g.wet(x + dx * start, z + dz * start)) continue; // a foot under water is no door foot
    let top = start, gentle = 0;
    for (let s = start; s < start + maxRun; s += step) {
      if ((H(s + step) - H(s)) / step >= o.faceSlope * 0.5) { top = s + step; gentle = 0; }
      else if ((gentle += step) > 6) break;
    }
    const height = H(top) - H(start);
    if (height > best.height) best = { height, into: b, foot: [x + dx * start, z + dz * start], footY: H(start), top: [x + dx * top, z + dz * top], run: top - start };
  }
  return best;
}

/** Line of sight from (vx, vy, vz) to (tx, ty, tz) over the ground (sampled every 4 m, the last 6 m skipped). */
function sees(g: NeedGround, v: [number, number, number], t: [number, number, number]): boolean {
  const len = Math.hypot(t[0] - v[0], t[2] - v[2]);
  for (let s = 4; s < len - 6; s += 4) {
    const f = s / len;
    const y = v[1] + (t[1] - v[1]) * f;
    if (g.height(v[0] + (t[0] - v[0]) * f, v[2] + (t[2] - v[2]) * f) > y) return false;
  }
  return true;
}

function measureRockFace(g: NeedGround, n: Extract<SiteNeed, { kind: "rock-face" }>, x: number, z: number): NeedResult {
  const want = n.minHeight ?? n.frontHeight * n.ratio;
  const f = bestFace(g, x, z, { faceSlope: n.faceSlope, footReach: n.footReach, maxRun: Math.max(80, want * 2.5) });
  const front = (f.into + 180) % 360;
  const [ix, iz] = dirOf(f.into);
  // the apron: dry level ground in front of the foot
  const ra = Math.sqrt(Math.max(n.apronM2, 100) / Math.PI);
  const cx = f.foot[0] - ix * ra * 0.9, cz = f.foot[1] - iz * ra * 0.9;
  let apron = 0;
  const cell = 4;
  for (let dz = -ra * 1.6; dz <= ra * 1.6; dz += cell)
    for (let dx = -ra * 1.6; dx <= ra * 1.6; dx += cell) {
      if (dx * dx + dz * dz > ra * ra * 2.56) continue;
      const px = cx + dx, pz = cz + dz;
      if ((px - f.foot[0]) * ix + (pz - f.foot[1]) * iz > 0) continue; // the rock side
      if (g.wet(px, pz)) continue;
      const h = g.height(px, pz);
      if (Math.abs(h - f.footY) > 3) continue;
      const gx = (g.height(px + 2, pz) - g.height(px - 2, pz)) / 4, gz = (g.height(px, pz + 2) - g.height(px, pz - 2)) / 4;
      if (Math.hypot(gx, gz) <= n.apronSlope) apron += cell * cell;
    }
  // the read: the face's mid-height seen from out in front
  let seenFrom = 0;
  if (n.readDistance > 0 && f.height > 0) {
    const midY = f.footY + f.height / 2;
    let s = 0;
    while (s < f.run && g.height(f.foot[0] + ix * s, f.foot[1] + iz * s) < midY) s += 2;
    const t: [number, number, number] = [f.foot[0] + ix * (s - 2), midY + 1, f.foot[1] + iz * (s - 2)];
    for (const d of [n.readDistance * 1.5, n.readDistance * 1.25, n.readDistance]) {
      for (const off of [0, -15, 15, -30, 30, -45, 45]) {
        const [vx, vz] = dirOf(front + off);
        const px = t[0] + vx * d, pz = t[2] + vz * d;
        if (g.wet(px, pz)) continue;
        if (sees(g, [px, g.height(px, pz) + 1.7, pz], t)) { seenFrom = Math.max(seenFrom, d); break; }
      }
      if (seenFrom) break;
    }
  }
  const faults: string[] = [];
  if (f.height < want) faults.push(`face ${R1(f.height)} m, needs ${R1(want)} m (${n.minHeight ? "asked" : `${n.ratio} x the ${n.frontHeight} m front`})`);
  if (apron < n.apronM2) faults.push(`apron ${Math.round(apron)} m2 at the foot, needs ${n.apronM2} m2`);
  if (n.readDistance > 0 && seenFrom < n.readDistance) faults.push(`face not seen from ${n.readDistance} m in front`);
  return {
    need: "rock-face",
    met: faults.length === 0,
    numbers: { face: R1(f.height), want: R1(want), apronM2: Math.round(apron), wantApronM2: n.apronM2, seenFrom: Math.round(seenFrom), readDistance: n.readDistance, faces: Math.round(front), foot: `${Math.round(f.foot[0])},${Math.round(f.foot[1])}`, footY: R1(f.footY) },
    faults,
    message: faults.length ? faults.join("; ") : `face ${R1(f.height)} m (>= ${R1(want)}), apron ${Math.round(apron)} m2, seen from ${Math.round(seenFrom)} m, front faces ${compassWord(front)}`,
  };
}

/** The ring round a pad: which bearings a cliff or water protects, and the wall the rest needs. */
export function measureDefensible(g: NeedGround, n: Extract<SiteNeed, { kind: "defensible" }>, x: number, z: number, radius: number): NeedResult {
  const pad = padStats(g, x, z, radius);
  const padY = pad.median;
  const R = radius + n.margin;
  const N = 72;
  const prot: boolean[] = [];
  for (let k = 0; k < N; k++) {
    const [dx, dz] = dirOf((k * 360) / N);
    let p = false;
    for (let s = 0; s <= n.flankBand && !p; s += 3) {
      const px = x + dx * (R + s), pz = z + dz * (R + s);
      if (g.wet(px, pz) || g.height(px, pz) < padY - n.flankDrop) p = true;
    }
    prot.push(p);
  }
  // open runs, as contiguous bearings, round the circle
  const runs: number[] = [];
  if (prot.every((p) => !p)) runs.push(N);
  else {
    const first = prot.indexOf(true);
    let len = 0;
    for (let i = 1; i <= N; i++) {
      const k = (first + i) % N;
      if (!prot[k]) len++;
      else if (len) { runs.push(len); len = 0; }
    }
    if (len) runs.push(len);
  }
  const theta = (cells: number) => (cells * 2 * Math.PI) / N;
  const wallOf = (cells: number) => (theta(cells) <= (100 * Math.PI) / 180 ? 2 * R * Math.sin(theta(cells) / 2) : R * theta(cells));
  const wallM = runs.reduce((a, c) => a + wallOf(c), 0);
  const neck = runs.length ? 2 * R * Math.sin(Math.min(Math.PI, theta(Math.max(...runs))) / 2) : 0;
  // overlook (pre-layout): an eye on ground outside the ring, within the band, above the wall top + parapet
  const wallTop = padY + n.wallHeight + n.parapet;
  let worst = -Infinity, worstAt: V2 = [x, z];
  for (let k = 0; k < N; k++) {
    const [dx, dz] = dirOf((k * 360) / N);
    for (let s = 0; s <= n.overlookBand; s += 4) {
      const px = x + dx * (R + s), pz = z + dz * (R + s);
      const over = g.height(px, pz) + OVERLOOK_RULE.eye - wallTop;
      if (over > worst) { worst = over; worstAt = [px, pz]; }
    }
  }
  const faults: string[] = [];
  if (wallM > n.maxWall) faults.push(`${Math.round(wallM)} m of open ring to wall (max ${n.maxWall}; ${runs.length} open run(s), widest ${Math.round(neck)} m): no cliff flanks or neck`);
  if (runs.length === 0) faults.push("cliff or water all round the ring: no way in on foot (it needs a neck to wall and gate)");
  if (worst > 0) faults.push(`ground at [${Math.round(worstAt[0])}, ${Math.round(worstAt[1])}] sees ${R1(worst)} m over a ${n.wallHeight} m wall (within ${n.overlookBand} m)`);
  const protShare = prot.filter(Boolean).length / N;
  return {
    need: "defensible",
    met: faults.length === 0,
    numbers: { wallM: Math.round(wallM), maxWall: n.maxWall, openRuns: runs.length, neckM: Math.round(neck), protectedShare: Math.round(protShare * 100) / 100, overlookM: R1(Math.max(0, worst)), padY: R1(padY) },
    faults,
    message: faults.length ? faults.join("; ") : `${Math.round(protShare * 100)} % of the ring protected by drop or water, ${Math.round(wallM)} m to wall (neck ${Math.round(neck)} m), nothing overlooks`,
  };
}

function measureFlat(g: NeedGround, n: Extract<SiteNeed, { kind: "flat-pad" }>, x: number, z: number, radius: number): NeedResult {
  const p = padStats(g, x, z, n.radius ?? radius);
  const faults: string[] = [];
  if (p.relief > n.maxRelief) faults.push(`relief ${R1(p.relief)} m across the pad (terrace steps ${n.maxRelief})`);
  if (p.meanSlope > n.maxSlope) faults.push(`mean slope ${p.meanSlope.toFixed(2)} (terrace steps ${n.maxSlope})`);
  if (p.wet > 0) faults.push(`${p.wet} wet sample(s) on the pad`);
  return { need: "flat-pad", met: !faults.length, numbers: { relief: R1(p.relief), meanSlope: Math.round(p.meanSlope * 100) / 100, wet: p.wet }, faults, message: faults.join("; ") || `relief ${R1(p.relief)} m, slope ${p.meanSlope.toFixed(2)}` };
}

function measureHigh(g: NeedGround, n: Extract<SiteNeed, { kind: "high-ground" }>, x: number, z: number, siteRadius: number): NeedResult {
  const radius = n.radius ?? siteRadius;
  const padY = padStats(g, x, z, radius).median;
  const ring: number[] = [];
  for (let k = 0; k < 36; k++) { const [dx, dz] = dirOf(k * 10); ring.push(g.height(x + dx * (radius + n.ring), z + dz * (radius + n.ring))); }
  const rise = padY - quantile(ring, 0.5);
  const faults = rise < n.minRise ? [`stands ${R1(rise)} m over its surroundings ${n.ring} m out (needs ${n.minRise})`] : [];
  return { need: "high-ground", met: !faults.length, numbers: { rise: R1(rise), minRise: n.minRise }, faults, message: faults.join("; ") || `${R1(rise)} m over its surroundings` };
}

function measureCrossroads(g: NeedGround, n: Extract<SiteNeed, { kind: "crossroads" }>, x: number, z: number, radius: number): NeedResult {
  let open = 0;
  const openBearings: number[] = [];
  for (let k = 0; k < 8; k++) {
    let ok = false;
    for (const off of [0, -18, 18]) {
      const [dx, dz] = dirOf(k * 45 + off);
      let over = 0, s = radius, prev = g.height(x + dx * s, z + dz * s), good = true;
      for (s = radius + 12; s <= radius + n.reach; s += 12) {
        const px = x + dx * s, pz = z + dz * s;
        if (g.wet(px, pz)) { good = false; break; }
        const h = g.height(px, pz);
        if (Math.abs(h - prev) / 12 > n.maxGrade && ++over > 2) { good = false; break; }
        prev = h;
      }
      if (good) { ok = true; break; }
    }
    if (ok) { open++; openBearings.push(k * 45); }
  }
  let roads = 0;
  for (const r of g.roads ?? []) {
    let d = Infinity;
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]!, b = r.points[i]!;
      const ax = a[0]!, az = a[a.length >= 3 ? 2 : 1]!, bx = b[0]!, bz = b[b.length >= 3 ? 2 : 1]!;
      const ddx = bx - ax, ddz = bz - az, L = ddx * ddx + ddz * ddz;
      const t = L < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - ax) * ddx + (z - az) * ddz) / L));
      d = Math.min(d, Math.hypot(x - ax - ddx * t, z - az - ddz * t));
    }
    if (d <= radius + 150) roads++;
  }
  const ways = Math.max(open, roads);
  const faults = ways < n.minWays ? [`${open} open way(s) of 8 sectors out to ${n.reach} m${roads ? `, ${roads} road(s) meet` : ""} (needs ${n.minWays})`] : [];
  return { need: "crossroads", met: !faults.length, numbers: { ways, openSectors: open, roads, minWays: n.minWays, openBearings: openBearings.map(compassWord).join(" ") }, faults, message: faults.join("; ") || `${ways} ways in (${openBearings.map(compassWord).join(" ")})` };
}

function measureShore(g: NeedGround, x: number, z: number, radius: number): NeedResult {
  if (!g.coastal) return { need: "shore", met: false, numbers: {}, faults: ["no coast plan to measure (run worldgen coast)"], message: "no coast plan to measure (run worldgen coast)" };
  const faults = g.coastal(x, z, radius);
  return { need: "shore", met: !faults.length, numbers: { faults: faults.length }, faults, message: faults.join("; ") || "a sheltered landing at shore level" };
}

// ------------------------------------------------------------------ the place-relative kinds (2026-10-29 redstrand)

/** Options of one measurement: `self` = the place being sited (its own entry in `g.places` is not a neighbour). */
export interface MeasureOpts { self?: string }

const xzOf = (p: readonly number[]): V2 => [p[0]!, p[p.length >= 3 ? 2 : 1]!];
const othersOf = (g: NeedGround, o: MeasureOpts): readonly SitedPlace[] => (g.places ?? []).filter((p) => !o.self || p.id !== o.self);

/** Resolve a place ref (`town:<id>`, `place:<id>`, `<id>`, `town:*` = the nearest town to (x, z)). */
export function resolvePlace(places: readonly SitedPlace[], ref: string, x = 0, z = 0): SitedPlace | null {
  const m = /^(town|place):(.+)$/.exec(ref.trim());
  const kind = m ? (m[1] as "town" | "place") : null;
  const id = m ? m[2]! : ref.trim();
  const pool = places.filter((p) => !kind || p.kind === kind);
  if (id === "*") return pool.reduce<SitedPlace | null>((b, p) => (!b || Math.hypot(p.at[0] - x, p.at[1] - z) < Math.hypot(b.at[0] - x, b.at[1] - z) ? p : b), null);
  return pool.find((p) => p.id === id) ?? null;
}

/** The nearest point of a polyline to (x, z): distance, and fraction of the polyline's length there. */
export function nearestOnLine(line: readonly V2[], x: number, z: number): { d: number; t: number; length: number } {
  let len = 0;
  const segs: number[] = [];
  for (let i = 1; i < line.length; i++) { const l = Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]); segs.push(l); len += l; }
  let best = { d: Infinity, at: 0 };
  let run = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!, L = segs[i - 1]!;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const u = L < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (L * L)));
    const d = Math.hypot(x - a[0] - dx * u, z - a[1] - dz * u);
    if (d < best.d) best = { d, at: run + u * L };
    run += L;
  }
  return { d: best.d, t: len > 0 ? best.at / len : 0, length: len };
}

function measureBiome(g: NeedGround, n: Extract<SiteNeed, { kind: "biome" }>, x: number, z: number, radius: number): NeedResult {
  if (!g.biome) return { need: "biome", met: false, numbers: {}, faults: ["no biome sampler on this ground (a world field gives one)"], message: "no biome sampler on this ground" };
  const r = n.radius ?? radius;
  const step = Math.max(6, r / 7);
  const counts = new Map<string, number>();
  let total = 0, ok = 0, bad = 0;
  for (let dz = -r; dz <= r; dz += step)
    for (let dx = -r; dx <= r; dx += step) {
      if (dx * dx + dz * dz > r * r || g.wet(x + dx, z + dz)) continue;
      const b = g.biome(x + dx, z + dz);
      total++;
      const key = b.zone && b.zone !== b.id ? `${b.id}/${b.zone}` : b.id;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (n.any.includes(b.id) || n.any.includes(b.zone)) ok++;
      if (n.none.includes(b.id) || n.none.includes(b.zone)) bad++;
    }
  const share = total ? ok / total : 0, noneShare = total ? bad / total : 0;
  const mix = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${Math.round((v / Math.max(1, total)) * 100)}%`).join(", ");
  const faults: string[] = [];
  if (!total) faults.push("no dry ground sampled");
  if (share < n.share) faults.push(`${Math.round(share * 100)} % in ${n.any.join("/")} (needs ${Math.round(n.share * 100)} %; ground is ${mix})`);
  if (noneShare > n.maxNone) faults.push(`${Math.round(noneShare * 100)} % in forbidden ${n.none.join("/")} (max ${Math.round(n.maxNone * 100)} %)`);
  return { need: "biome", met: !faults.length, numbers: { share: Math.round(share * 100) / 100, noneShare: Math.round(noneShare * 100) / 100, mix }, faults, message: faults.join("; ") || `${Math.round(share * 100)} % ${n.any.join("/")} (${mix})` };
}

/** The travel roads as polylines in plan. */
const roadLines = (g: NeedGround): { id: string; line: V2[] }[] => (g.roads ?? []).map((r) => ({ id: r.id, line: r.points.map(xzOf) }));

function measureLandmark(g: NeedGround, n: Extract<SiteNeed, { kind: "landmark-visible" }>, x: number, z: number, radius: number, o: MeasureOpts): NeedResult {
  const foot = g.height(x, z);
  const target = { at: [x, z] as V2, foot, top: foot + n.height };
  const eyes: { at: V2; d: number; b: number }[] = [];
  const ring = [n.distance, n.distance * 1.25, n.distance * 1.5];
  let fromNote = "16 bearings";
  if (n.from === "any") {
    for (let k = 0; k < 16; k++) for (const d of ring) { const [dx, dz] = dirOf(k * 22.5); eyes.push({ at: [x + dx * d, z + dz * d], d, b: k * 22.5 }); }
  } else if (n.from === "road") {
    fromNote = "the roads";
    for (const r of roadLines(g))
      for (let i = 1; i < r.line.length; i++) {
        const a = r.line[i - 1]!, b = r.line[i]!, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let s = 0; s < L; s += 20) {
          const p: V2 = [a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L], d = Math.hypot(p[0] - x, p[1] - z);
          if (d >= n.distance && d <= n.distance * 1.5) eyes.push({ at: p, d, b: bearingOf(p[0] - x, p[1] - z) });
        }
      }
    if (!eyes.length) return { need: "landmark-visible", met: false, numbers: { height: n.height, distance: n.distance }, faults: [`no road ${n.distance}-${Math.round(n.distance * 1.5)} m from the site to see it from`], message: `no road ${n.distance}-${Math.round(n.distance * 1.5)} m from the site to see it from` };
  } else {
    const p = resolvePlace(othersOf(g, o), n.from, x, z);
    if (!p) return { need: "landmark-visible", met: false, numbers: {}, faults: [`${n.from} is not sited yet (site it first)`], message: `${n.from} is not sited yet` };
    fromNote = `toward ${p.kind}:${p.id}`;
    const toward = bearingOf(p.at[0] - x, p.at[1] - z), far = Math.max(0, Math.hypot(p.at[0] - x, p.at[1] - z) - p.radius);
    for (const off of [0, -15, 15, -30, 30]) for (const d0 of ring) { const d = Math.min(d0, Math.max(far, radius)); const [dx, dz] = dirOf(toward + off); eyes.push({ at: [x + dx * d, z + dz * d], d, b: toward + off }); }
  }
  let best = { px: 0, d: 0, b: 0, visible: 0 };
  let seenFrom = 0, seenB = 0;
  for (const e of eyes) {
    if (g.wet(e.at[0], e.at[1])) continue;
    const r = readPixels(g, [e.at[0], g.height(e.at[0], e.at[1]) + 1.7, e.at[1]], target);
    if (r.px >= n.px && e.d > seenFrom) { seenFrom = e.d; seenB = e.b; }
    if (e.d >= n.distance - 1 && r.px > best.px) best = { px: r.px, d: e.d, b: e.b, visible: r.visible };
  }
  const faults = seenFrom >= n.distance - 1 ? [] : [`a ${n.height} m landmark shows ${best.px} px at best from ${n.distance} m (${fromNote}; needs ${n.px} px = ${R1(heightForPx(n.distance, n.px))} m clear of the ground between)`];
  return {
    need: "landmark-visible",
    met: !faults.length,
    numbers: { height: n.height, distance: n.distance, seenFrom: Math.round(seenFrom), px: best.px, visibleM: best.visible, bearing: seenFrom ? Math.round(seenB) : null },
    faults,
    message: faults.join("; ") || `a ${n.height} m landmark shows from ${Math.round(seenFrom)} m (${compassWord(seenB)}, ${fromNote})`,
  };
}

function measureDistance(g: NeedGround, n: Extract<SiteNeed, { kind: "distance-from" }>, x: number, z: number, radius: number, o: MeasureOpts): NeedResult {
  const p = resolvePlace(othersOf(g, o), n.place, x, z);
  if (!p) return { need: "distance-from", met: false, numbers: { place: n.place }, faults: [`${n.place} is not sited yet (site it first)`], message: `${n.place} is not sited yet` };
  const c = Math.hypot(p.at[0] - x, p.at[1] - z);
  const d = n.edges ? c - radius - p.radius : c;
  const what = `${Math.round(d)} m ${n.edges ? "edge to edge" : "centre to centre"} from ${p.kind}:${p.id}`;
  const faults: string[] = [];
  if (d < n.min) faults.push(`${what} (needs >= ${n.min})`);
  if (n.max !== undefined && d > n.max) faults.push(`${what} (needs <= ${n.max})`);
  return { need: "distance-from", met: !faults.length, numbers: { place: `${p.kind}:${p.id}`, metres: Math.round(d), min: n.min, max: n.max ?? null }, faults, message: faults.join("; ") || what };
}

/** The routes an on-route need is judged against. */
function routesOf(g: NeedGround, n: Extract<SiteNeed, { kind: "on-route" }>, x: number, z: number, o: MeasureOpts): { routes: { name: string; line: V2[]; along: boolean }[]; missing: string | null } {
  const places = othersOf(g, o);
  if (n.from || n.to) {
    if (!n.from || !n.to) return { routes: [], missing: "on-route takes both `from` and `to` (or neither)" };
    const a = resolvePlace(places, n.from, x, z), b = resolvePlace(places, n.to, x, z);
    if (!a || !b) return { routes: [], missing: `${!a ? n.from : n.to} is not sited yet (site it first)` };
    // a road passing within 150 m of both ends' edges: the part of it between them
    for (const r of roadLines(g)) {
      const na = r.line.map((p, i) => [Math.hypot(p[0] - a.at[0], p[1] - a.at[1]), i] as const).sort((u, v) => u[0] - v[0])[0];
      const nb = r.line.map((p, i) => [Math.hypot(p[0] - b.at[0], p[1] - b.at[1]), i] as const).sort((u, v) => u[0] - v[0])[0];
      if (!na || !nb || na[0] > a.radius + 150 || nb[0] > b.radius + 150 || na[1] === nb[1]) continue;
      const part = na[1] < nb[1] ? r.line.slice(na[1], nb[1] + 1) : r.line.slice(nb[1], na[1] + 1).reverse();
      return { routes: [{ name: `road ${r.id} (${a.id} -> ${b.id})`, line: part, along: true }], missing: null };
    }
    return { routes: [{ name: `line ${a.id} -> ${b.id}`, line: [a.at, b.at], along: true }], missing: null };
  }
  const routes = roadLines(g).map((r) => ({ name: `road ${r.id}`, line: r.line, along: false }));
  for (let i = 0; i < places.length; i++)
    for (let j = i + 1; j < places.length; j++) routes.push({ name: `line ${places[i]!.id} -> ${places[j]!.id}`, line: [places[i]!.at, places[j]!.at], along: true });
  return { routes, missing: routes.length ? null : "no route: no travel roads and fewer than two sited places" };
}

function measureOnRoute(g: NeedGround, n: Extract<SiteNeed, { kind: "on-route" }>, x: number, z: number, o: MeasureOpts): NeedResult {
  const { routes, missing } = routesOf(g, n, x, z, o);
  if (missing) return { need: "on-route", met: false, numbers: {}, faults: [missing], message: missing };
  let best: { name: string; d: number; t: number; miss: number; along: boolean } | null = null;
  for (const r of routes) {
    const q = nearestOnLine(r.line, x, z);
    const [a0, a1] = r.along ? n.along : [0, 1];
    const miss = Math.max(0, n.offset[0] - q.d, q.d - n.offset[1]) + Math.max(0, a0 - q.t, q.t - a1) * q.length;
    if (!best || miss < best.miss) best = { name: r.name, d: q.d, t: q.t, miss, along: r.along };
  }
  const b = best!;
  const where = `${Math.round(b.d)} m off ${b.name}${b.along ? ` at ${Math.round(b.t * 100)} % of its length` : ""}`;
  const faults = b.miss > 0 ? [`${where} (needs ${n.offset[0]}-${n.offset[1]} m off${b.along ? `, ${Math.round(n.along[0] * 100)}-${Math.round(n.along[1] * 100)} % along` : ""})`] : [];
  return { need: "on-route", met: !faults.length, numbers: { route: b.name, offM: Math.round(b.d), along: Math.round(b.t * 100) / 100 }, faults, message: faults.join("; ") || where };
}

function measureSubsite(g: NeedGround, n: Extract<SiteNeed, { kind: "subsite" }>, x: number, z: number, o: MeasureOpts): NeedResult {
  const y0 = g.height(x, z);
  const pts: { at: V2; y: number }[] = [];
  for (let d = n.within[0]; d <= n.within[1]; d += 20)
    for (let k = 0; k < 16; k++) {
      const [dx, dz] = dirOf(k * 22.5);
      const px = x + dx * d, pz = z + dz * d;
      if (g.wet(px, pz)) continue;
      const y = g.height(px, pz);
      if (y <= y0 - n.below) pts.push({ at: [px, pz], y });
    }
  if (!pts.length) {
    const msg = `no dry ground ${n.within[0]}-${n.within[1]} m out lies ${n.below} m under the site (${R1(y0)} m) for the ${n.id}`;
    return { need: "subsite", met: false, numbers: { id: n.id }, faults: [msg], message: msg };
  }
  // the lowest points first (a sump under the lip), then a spread of the rest; stop at the first that meets the need
  pts.sort((a, b) => a.y - b.y);
  const tried = [...pts.slice(0, 10), ...pts.slice(10).filter((_, i) => i % 6 === 0)].slice(0, 24);
  let best: { at: V2; r: NeedResult } | null = null;
  for (const p of tried) {
    const r = measureNeed(g, n.need, p.at[0], p.at[1], n.radius, o);
    if (r.met) { best = { at: p.at, r }; break; }
    if (!best || r.faults.length < best.r.faults.length) best = { at: p.at, r };
  }
  const b = best!;
  const where = `${n.id} at [${Math.round(b.at[0])}, ${Math.round(b.at[1])}] ${Math.round(Math.hypot(b.at[0] - x, b.at[1] - z))} m ${compassWord(bearingOf(b.at[0] - x, b.at[1] - z))}, ${R1(y0 - g.height(b.at[0], b.at[1]))} m under the site`;
  return {
    need: "subsite",
    met: b.r.met,
    numbers: { id: n.id, at: `${Math.round(b.at[0])},${Math.round(b.at[1])}`, inner: n.need.kind, ...Object.fromEntries(Object.entries(b.r.numbers).map(([k, v]) => [`${n.need.kind}.${k}`, v])) },
    faults: b.r.met ? [] : b.r.faults.map((f) => `${n.id} (${n.need.kind}): ${f}`),
    message: `${where}: ${b.r.met ? "" : "best of " + tried.length + " misses: "}${b.r.message}`,
  };
}

export function measureNeed(g: NeedGround, n: SiteNeed, x: number, z: number, radius: number, o: MeasureOpts = {}): NeedResult {
  switch (n.kind) {
    case "rock-face": return measureRockFace(g, n, x, z);
    case "defensible": return measureDefensible(g, n, x, z, radius);
    case "flat-pad": return measureFlat(g, n, x, z, radius);
    case "high-ground": return measureHigh(g, n, x, z, radius);
    case "crossroads": return measureCrossroads(g, n, x, z, radius);
    case "shore": return measureShore(g, x, z, radius);
    case "biome": return measureBiome(g, n, x, z, radius);
    case "landmark-visible": return measureLandmark(g, n, x, z, radius, o);
    case "distance-from": return measureDistance(g, n, x, z, radius, o);
    case "on-route": return measureOnRoute(g, n, x, z, o);
    case "subsite": return measureSubsite(g, n, x, z, o);
  }
}

/** Every need of `role` at (x, z) for a pad / site of `radius` m. */
export function measureNeeds(g: NeedGround, role: SiteRole, x: number, z: number, radius: number, overrides: SiteNeedOverrides = {}, o: MeasureOpts = {}): NeedsReport {
  const results = needsFor(role, overrides).map((n) => measureNeed(g, n, x, z, radius, o));
  return { role, met: results.every((r) => r.met), results };
}

/**
 * Candidate points ON the routes an on-route need judges (the site finder's landforms rarely lie beside a road): every
 * `step` m along each route inside its `along` window, on both sides at the middle of the `offset` window. Empty when
 * the needs have no on-route or its places are not sited.
 */
export function routeCandidates(g: NeedGround, needs: readonly SiteNeed[], o: MeasureOpts & { step?: number } = {}): V2[] {
  const n = needs.find((x): x is Extract<SiteNeed, { kind: "on-route" }> => x.kind === "on-route");
  if (!n) return [];
  const step = o.step ?? 40;
  const { routes } = routesOf(g, n, 0, 0, o);
  const off = (n.offset[0] + n.offset[1]) / 2;
  const out: V2[] = [];
  for (const r of routes) {
    const [a0, a1] = r.along ? n.along : [0, 1];
    let len = 0;
    for (let i = 1; i < r.line.length; i++) len += Math.hypot(r.line[i]![0] - r.line[i - 1]![0], r.line[i]![1] - r.line[i - 1]![1]);
    let run = 0;
    for (let i = 1; i < r.line.length; i++) {
      const a = r.line[i - 1]!, b = r.line[i]!, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-6) continue;
      const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
      for (let s = (step - (run % step)) % step; s < L; s += step) {
        const t = (run + s) / Math.max(1e-6, len);
        if (t < a0 || t > a1) continue;
        for (const side of [-1, 1]) {
          const px = a[0] + tx * s - tz * off * side, pz = a[1] + tz * s + tx * off * side;
          if (!g.wet(px, pz)) out.push([Math.round(px), Math.round(pz)]);
        }
      }
      run += L;
    }
  }
  return out;
}

// ------------------------------------------------------------------ the designers' needs file (authoring/design/<place>/needs.json)

/**
 * A designer's needs file: the role a place is sited for, its site radius and its overrides. Other keys (why, the
 * preferences the siting agent judges by eye, derived numbers) pass through untouched.
 */
export const placeNeedsFileSchema = z
  .object({
    place: z.string().min(1).optional().describe("The place's id (a POI / entrance location)."),
    town: z.string().min(1).optional().describe("The town's id, for a town's needs file."),
    siteRole: siteRoleSchema,
    radius: z.number().positive().max(MAX_M.radius).optional().describe("Site radius it is measured with, m (default ROLE_RADIUS, towns the tier's)."),
    siteNeeds: siteNeedOverridesSchema.default({}),
  })
  .passthrough()
  .refine((f) => !!(f.place ?? f.town), { message: "a needs file names its `place` or `town`" })
  .describe("authoring/design/<place>/needs.json: what ground a designed place needs, read by `zonegen sites --needs-file`, `worldgen towns --propose --needs-file` and `worldgen dogfood --needs @<design dir>`.");
export type PlaceNeedsFile = z.infer<typeof placeNeedsFileSchema>;

/** Parse a needs file and check its needs resolve (needsFor throws on an incomplete added need). */
export function parsePlaceNeeds(raw: unknown, where = "needs file"): PlaceNeedsFile & { id: string; kind: "town" | "place"; needs: SiteNeed[] } {
  const r = placeNeedsFileSchema.safeParse(raw);
  if (!r.success) throw new Error(`${where}: ${r.error.issues.map((i) => `${i.path.join(".") || "(file)"} ${i.message}`).join("; ")}`);
  const f = r.data;
  const needs = needsFor(f.siteRole, f.siteNeeds);
  return { ...f, id: (f.place ?? f.town)!, kind: f.town && !f.place ? "town" : "place", needs };
}

/** The place refs a needs list depends on (distance-from, on-route ends, landmark-visible from, inside subsites). */
export function needRefs(needs: readonly SiteNeed[]): string[] {
  const out: string[] = [];
  for (const n of needs) {
    if (n.kind === "distance-from") out.push(n.place);
    else if (n.kind === "on-route") { if (n.from) out.push(n.from); if (n.to) out.push(n.to); }
    else if (n.kind === "landmark-visible" && n.from !== "any" && n.from !== "road") out.push(n.from);
    else if (n.kind === "subsite") out.push(...needRefs([n.need]));
  }
  return out;
}

/** A need excepted by a dated coordinator ruling ({ need, ruling: "2026-10-29 ..." }). */
export const needRulingSchema = z.object({
  need: z.enum(NEED_KINDS).describe("The need kind the ruling excepts."),
  ruling: z.string().regex(/\d{4}-\d{2}-\d{2}/, "a ruling quotes its date (YYYY-MM-DD)").describe("The coordinator's ruling with its date: why this site stands although the ground misses the need."),
});
export type NeedRuling = z.infer<typeof needRulingSchema>;

/** The unmet needs no ruling excepts. */
export function unexcepted(report: NeedsReport, rulings: readonly NeedRuling[] = []): NeedResult[] {
  return report.results.filter((r) => !r.met && !rulings.some((x) => x.need === r.need));
}

export function needsLine(report: NeedsReport): string {
  return report.results.map((r) => `${r.met ? "met" : "UNMET"} ${r.need}: ${r.message}`).join(" | ");
}

// ------------------------------------------------------------------ the world field as a NeedGround

export function needGroundOf(
  field: { height(x: number, z: number): number; ground?(x: number, z: number): number | null; waterY(x: number, z: number): number | null; biome?(x: number, z: number): { id: string; zone: string } },
  sea: number,
  extra: Partial<Pick<NeedGround, "coastal" | "roads" | "places">> = {},
): NeedGround {
  return {
    height: (x, z) => field.ground?.(x, z) ?? field.height(x, z),
    wet: (x, z) => field.waterY(x, z) !== null || field.height(x, z) < sea + 0.3,
    sea,
    ...(field.biome ? { biome: (x: number, z: number) => { const b = field.biome!(x, z); return { id: b.id, zone: b.zone }; } } : {}),
    ...extra,
  };
}

// ------------------------------------------------------------------ candidate search (feet of rock faces)

/**
 * Feet of tall rock faces in an area: a coarse relief prefilter (`step` m grid, 60 m probes), then `bestFace` on what
 * passes. For a grand entrance the finder's canyon ends and cliffs rarely stand where the TALLEST faces are.
 */
export function findFaceFeet(g: NeedGround, inside: (x: number, z: number) => boolean, box: [number, number, number, number], want: number, o: { step?: number; top?: number } = {}): { at: V2; face: number; into: number }[] {
  const step = o.step ?? 32;
  const out: { at: V2; face: number; into: number; apron: boolean }[] = [];
  for (let z = box[1]; z <= box[3]; z += step)
    for (let x = box[0]; x <= box[2]; x += step) {
      if (!inside(x, z) || g.wet(x, z)) continue;
      const h = g.height(x, z);
      let up = 0;
      for (let k = 0; k < 8; k++) { const [dx, dz] = dirOf(k * 45); up = Math.max(up, g.height(x + dx * 60, z + dz * 60) - h); }
      if (up < want * 0.6) continue;
      const f = bestFace(g, x, z, { faceSlope: 1, footReach: 30, bearings: 16, maxRun: want * 2.5 });
      if (f.height < want * 0.6) continue;
      // a foot with standable ground in front of it (a sea cliff's foot is the surf): probe 20 m out from the face
      const [ix, iz] = dirOf(f.into);
      const ax = f.foot[0] - ix * 20, az = f.foot[1] - iz * 20;
      const apron = !g.wet(ax, az) && Math.abs(g.height(ax, az) - f.footY) <= 4;
      out.push({ at: [Math.round(x), Math.round(z)], face: R1(f.height), into: f.into, apron });
    }
  out.sort((a, b) => Number(b.apron) - Number(a.apron) || Math.min(b.face, want) - Math.min(a.face, want) || b.face - a.face);
  const kept: typeof out = [];
  for (const c of out) if (kept.every((k) => Math.hypot(k.at[0] - c.at[0], k.at[1] - c.at[1]) > 60)) kept.push(c);
  return kept.slice(0, o.top ?? 24);
}

// ------------------------------------------------------------------ GENERATORS: ground no candidate has

export interface NeedArea {
  inside(x: number, z: number): boolean;
  box: [number, number, number, number];
  /** Prefer spots near this point. */
  near: V2;
}

/** Resolve `near` ([x, z] or "<zone> <side>") into a search area. */
export function needArea(near: GroundNeedDoc["near"], within: number, regions: readonly { id: string; polygon: readonly (readonly number[])[]; within?: string }[]): NeedArea {
  if (Array.isArray(near)) {
    const [nx, nz] = near as [number, number];
    return { near: [nx, nz], box: [nx - within, nz - within, nx + within, nz + within], inside: (x, z) => Math.hypot(x - nx, z - nz) <= within };
  }
  const [zoneId, sideWord = "centre"] = String(near).trim().split(/\s+/);
  const region = regions.find((r) => r.id === zoneId && r.within === undefined) ?? regions.find((r) => r.id === zoneId);
  if (!region) throw new Error(`need near "${near}": no region ${zoneId}`);
  const poly = region.polygon.map((p) => [p[0]!, p[1]!] as V2);
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cz = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  const inPoly = (x: number, z: number): boolean => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i]!, [xj, zj] = poly[j]!;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const sides: Record<string, number> = { north: 0, n: 0, ne: 45, east: 90, e: 90, se: 135, south: 180, s: 180, sw: 225, west: 270, w: 270, nw: 315 };
  const side = sides[sideWord.toLowerCase()];
  const box: [number, number, number, number] = [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1])), Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))];
  if (side === undefined) return { near: [cx, cz], box, inside: (x, z) => inPoly(x, z) && Math.hypot(x - cx, z - cz) <= within };
  const [sx, sz] = dirOf(side);
  // the side's half of the zone, preferring its far edge: spots whose bearing from the centroid is within 50 deg
  let far = 0;
  for (const p of poly) far = Math.max(far, (p[0] - cx) * sx + (p[1] - cz) * sz);
  const nearPt: V2 = [cx + sx * far * 0.6, cz + sz * far * 0.6];
  return {
    near: nearPt,
    box,
    inside: (x, z) => {
      if (!inPoly(x, z)) return false;
      const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
      return d > 1 && (dx * sx + dz * sz) / d >= Math.cos((50 * Math.PI) / 180) && Math.hypot(x - nearPt[0], z - nearPt[1]) <= within;
    },
  };
}

const smooth = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/** A masked, raise-only height patch over a box, from a function giving the wanted height (null = leave the ground). */
function patchOver(id: string, box: [number, number, number, number], cell: number, natural: (x: number, z: number) => number, wantY: (x: number, z: number) => number | null, blendM?: number): { patch: HeightPatchDoc; raised: number } {
  const columns = Math.min(1025, Math.max(2, Math.round((box[2] - box[0]) / cell) + 1));
  const rows = Math.min(1025, Math.max(2, Math.round((box[3] - box[1]) / cell) + 1));
  const sx = (box[2] - box[0]) / (columns - 1), sz = (box[3] - box[1]) / (rows - 1);
  const heights: number[] = [], weights: number[] = [];
  let raised = 0;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const x = box[0] + i * sx, z = box[1] + j * sz;
      const nat = natural(x, z);
      const w = wantY(x, z);
      if (w === null || w <= nat + 0.05) { heights.push(Math.round(nat * 100) / 100); weights.push(0); continue; }
      heights.push(Math.round(w * 100) / 100);
      weights.push(1);
      raised = Math.max(raised, w - nat);
    }
  // a small feature passes its own blend (with a box margin wider than it): the default 12 m feather inside a 30 m box
  // smoothed the whole dropped-hour rib into a dome (2026-10-29 w9)
  const blend = blendM ?? Math.max(4, Math.min(12, Math.min(box[2] - box[0], box[3] - box[1]) / 2 - 1));
  return {
    patch: { id, origin: [box[0], box[1]], size: [box[2] - box[0], box[3] - box[1]], columns, rows, heights, weights, blend, raiseOnly: true, edgeSlope: 1.5 } as HeightPatchDoc,
    raised,
  };
}

export interface NeedSolve {
  ok: boolean;
  /** Already met on the natural ground: nothing written. */
  existing: boolean;
  at: V2;
  faces: number;
  height: number;
  raised: number;
  patch: HeightPatchDoc | null;
  message: string;
}

/**
 * cliff-face: pick the spot in the area whose natural face is tallest (cheapest uplift; nearer `near` breaks ties),
 * and raise the ground BEHIND its foot into a scarp `minHeight` tall (face at rise/run 1.5, a crest 30 m deep, a back
 * slope of 0.35 to natural ground, the ends tapered over one face height), and fill the `apron` m in front of the foot
 * level with it (raise-only, a 45 deg fill edge), so the plaza the rock-face need measures is there.
 *
 * NARROW GROUND (2026-10-29 redstrand w10: the Moon face on the arm between lake-3 and the sea, the Sun's face across the
 * lake): only the apron itself must be dry in front (the fill beyond it never fills water: a shore plaza), and only the
 * face plus a lip behind it must be dry (`SHORE_LIP`). Where the block meets water (a sea behind it, a river beside it) it
 * falls to that shore at no more than SHORE_FALL (the lips gate's need-face slope) instead of standing as a wall.
 */
/** Narrow ground: the dry ground the face needs behind its run (a crest lip), and the steepest fall from the block to a
 *  shore behind it (= worldgen-lips NEED_FACE_MAX_SLOPE, the slope the lips gate allows a need patch). */
const SHORE_LIP = 12, SHORE_FALL = 3, SHORE_KEEP = 12;
/** A set-bearing face may stand on ground rising into it up to this grade (the apron fill levels it). */
const RISING_APRON_MAX = 0.6;

/** A lake a need may hold (`need.holds`): its outline and surface. */
export interface HeldLake { id: string; waterY: number; center: V2; radius: number; polygon?: readonly V2[] }
const RIM_REACH = 36, RIM_FLAT = 20, RIM_FREEBOARD = 1.5, RIM_EASE = 0.5;

/** Signed-free distance from (x, z) to a lake's outline and whether it is inside. */
function lakeOutline(l: HeldLake): (x: number, z: number) => { inside: boolean; d: number } {
  const poly = l.polygon && l.polygon.length >= 3 ? l.polygon : null;
  return (x, z) => {
    if (!poly) { const r = Math.hypot(x - l.center[0], z - l.center[1]); return { inside: r < l.radius, d: Math.abs(r - l.radius) }; }
    let inside = false, d = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, az] = poly[i]!, [bx, bz] = poly[j]!;
      if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
      d = Math.min(d, Math.hypot(x - ax - t * ex, z - az - t * ez));
    }
    return { inside, d };
  };
}

/** The rim a held lake needs at (x, z): water + freeboard within RIM_FLAT m outside the outline, easing out to RIM_REACH. */
function heldRimY(g: NeedGround, lakes: readonly HeldLake[]): { at: (x: number, z: number) => number | null; box: [number, number, number, number] | null } {
  if (!lakes.length) return { at: () => null, box: null };
  const shapes = lakes.map((l) => ({ l, o: lakeOutline(l) }));
  let box: [number, number, number, number] | null = null;
  for (const { l } of shapes) {
    const pts = l.polygon && l.polygon.length >= 3 ? l.polygon : [[l.center[0] - l.radius, l.center[1] - l.radius], [l.center[0] + l.radius, l.center[1] + l.radius]] as V2[];
    const b: [number, number, number, number] = [Math.floor(Math.min(...pts.map((p) => p[0])) - RIM_REACH), Math.floor(Math.min(...pts.map((p) => p[1])) - RIM_REACH), Math.ceil(Math.max(...pts.map((p) => p[0])) + RIM_REACH), Math.ceil(Math.max(...pts.map((p) => p[1])) + RIM_REACH)];
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
  }
  return {
    box,
    at: (x, z) => {
      if (g.wet(x, z)) return null;
      let best: number | null = null;
      for (const { l, o } of shapes) {
        const { inside, d } = o(x, z);
        if (inside || d > RIM_REACH) continue;
        const y = l.waterY + RIM_FREEBOARD - Math.max(0, d - RIM_FLAT) * RIM_EASE;
        if (y > g.height(x, z) && (best === null || y > best)) best = y;
      }
      return best;
    },
  };
}

/** Distance (m) to the nearest wet sample on a `cell` m grid over `box` (two-pass chamfer; Infinity with no water). */
function waterDistance(g: NeedGround, box: [number, number, number, number], cell: number): (x: number, z: number) => number {
  const nx = Math.max(2, Math.ceil((box[2] - box[0]) / cell) + 1), nz = Math.max(2, Math.ceil((box[3] - box[1]) / cell) + 1);
  const d = new Float32Array(nx * nz);
  let any = false;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const w = g.wet(box[0] + i * cell, box[1] + j * cell); d[j * nx + i] = w ? 0 : 1e9; any ||= w; }
  if (!any) return () => Infinity;
  const D = cell * Math.SQRT2;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i; let v = d[k]!;
    if (i > 0) v = Math.min(v, d[k - 1]! + cell);
    if (j > 0) { v = Math.min(v, d[k - nx]! + cell); if (i > 0) v = Math.min(v, d[k - nx - 1]! + D); if (i < nx - 1) v = Math.min(v, d[k - nx + 1]! + D); }
    d[k] = v;
  }
  for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i; let v = d[k]!;
    if (i < nx - 1) v = Math.min(v, d[k + 1]! + cell);
    if (j < nz - 1) { v = Math.min(v, d[k + nx]! + cell); if (i < nx - 1) v = Math.min(v, d[k + nx + 1]! + D); if (i > 0) v = Math.min(v, d[k + nx - 1]! + D); }
    d[k] = v;
  }
  return (x, z) => {
    const i = Math.round((x - box[0]) / cell), j = Math.round((z - box[1]) / cell);
    if (i < 0 || j < 0 || i >= nx || j >= nz) return Infinity;
    return d[j * nx + i]!;
  };
}

export function solveCliffFace(g: NeedGround, need: GroundNeedDoc, area: NeedArea, o: { lakes?: readonly HeldLake[] } = {}): NeedSolve {
  const held = (need.holds ?? []).map((id) => o.lakes?.find((l) => l.id === id) ?? null);
  const missing = (need.holds ?? []).filter((_, i) => !held[i]);
  if (missing.length) return { ok: false, existing: false, at: area.near, faces: 0, height: 0, raised: 0, patch: null, message: `holds names no lake: ${missing.join(", ")}` };
  const rim = heldRimY(g, held as HeldLake[]);
  const H = need.minHeight;
  const step = 24;
  let best: { at: V2; face: number; into: number; score: number } | null = null;
  for (let z = area.box[1]; z <= area.box[3]; z += step)
    for (let x = area.box[0]; x <= area.box[2]; x += step) {
      if (!area.inside(x, z) || g.wet(x, z)) continue;
      // the apron spot itself must be level, dry ground — or, for a face with a set bearing, ground that rises INTO the face
      // (the apron fill levels it to the foot; a lake-side bench climbing to a ridge, redstrand w10) with a level cross-fall
      const gx = (g.height(x + 6, z) - g.height(x - 6, z)) / 12, gz = (g.height(x, z + 6) - g.height(x, z - 6)) / 12;
      if (Math.hypot(gx, gz) > 0.2) {
        if (need.faces === undefined) continue;
        const [qx, qz] = dirOf((need.faces + 180) % 360);
        const along = gx * qx + gz * qz, across = Math.abs(gx * -qz + gz * qx);
        if (along < 0 || along > RISING_APRON_MAX || across > 0.2) continue;
      }
      const f = bestFace(g, x, z, { faceSlope: 1, footReach: need.apron, bearings: 12, maxRun: H * 2.5 });
      let into = f.into;
      if (f.height < 4) into = bearingOf(gx, gz); // no face: the rock rises uphill
      if (need.faces !== undefined) into = (need.faces + 180) % 360;
      // dry behind (the scarp) and dry in front (the apron and its fill); the apron's natural fall counts against it
      const [dx, dz] = dirOf(into);
      let wet = 0, fall = 0;
      // the apron in front of the foot (the foot stands apron/2 behind this spot) and the face plus a lip behind it
      for (let s = -need.apron / 2; s <= need.apron / 2 + H / 1.5 + SHORE_LIP; s += 4) if (g.wet(x + dx * s, z + dz * s)) wet++;
      for (const side of [-need.width / 2, 0, need.width / 2]) {
        const qx = x - dz * side, qz = z + dx * side;
        if (g.wet(qx, qz)) wet++;
        fall = Math.max(fall, Math.abs(g.height(qx, qz) - g.height(x, z)), Math.abs(g.height(qx - dx * need.apron, qz - dz * need.apron) - g.height(x, z)));
      }
      if (wet) continue;
      const score = Math.min(f.height, H) - fall - Math.hypot(x - area.near[0], z - area.near[1]) / 50;
      if (!best || score > best.score) best = { at: [x, z], face: f.height, into, score };
    }
  if (!best) return { ok: false, existing: false, at: area.near, faces: 0, height: 0, raised: 0, patch: null, message: "no dry level spot in the area with dry ground behind it" };
  const front = (best.into + 180) % 360;
  if (best.face >= H) {
    // the ground already carries it only when the whole grand-entrance need passes there (apron and read included)
    const check = measureRockFace(g, siteNeedSchema.parse({ kind: "rock-face", minHeight: H, apronM2: need.apron * need.apron, footReach: need.apron }) as Extract<SiteNeed, { kind: "rock-face" }>, best.at[0], best.at[1]);
    if (check.met) return { ok: true, existing: true, at: best.at, faces: front, height: R1(best.face), raised: 0, patch: null, message: `the ground already carries it: ${check.message} at [${best.at.map(Math.round).join(", ")}] — site the place there` };
  }
  const [ix, iz] = dirOf(best.into);
  const px = -iz, pz = ix;
  const footD = need.apron / 2;
  const fx = best.at[0] + ix * footD, fz = best.at[1] + iz * footD;
  // the apron level is the HIGHEST natural ground across it: the patch only fills, so a lower level would leave the
  // apron's high side standing proud of the plaza
  let footY = g.height(fx, fz);
  for (let u = -need.apron; u <= 0; u += 4)
    for (let v = -need.width / 2; v <= need.width / 2; v += 6) footY = Math.max(footY, g.height(fx + ix * u - iz * v, fz + iz * u + ix * v));
  const top = footY + H * 1.05 + 1; // a margin over the asked height: the measure reads the face from where its slope starts
  const run = H / 1.5, crest = 30, back = Math.min(160, H / 0.35), taper = H;
  const half = need.width / 2;
  const wantY = (x: number, z: number): number | null => {
    const u = (x - fx) * ix + (z - fz) * iz, v = Math.abs((x - fx) * px + (z - fz) * pz);
    // the APRON: level at the foot across the face, `apron` m deep, then a 45 deg fill down to natural ground (raise-only:
    // only hollows fill), so the plaza and stair have the flat the rock-face need measures
    if (u < 0) return u < -(need.apron + 45) || v > half + 45 ? null : footY - Math.hypot(Math.max(0, -u - need.apron), Math.max(0, v - half));
    if (u > run + crest + back || v > half + taper) return null;
    let y = u <= run ? footY + (u / run) * (top - footY) : u <= run + crest ? top : top - (u - run - crest) * 0.35;
    if (v > half) y = footY + (y - footY) * (1 - smooth((v - half) / taper));
    return y;
  };
  const span = run + crest + back + 8, wide = half + taper + 8;
  const behind = -(need.apron + 45);
  const corners = [[behind, -wide], [behind, wide], [span, -wide], [span, wide]].map(([u, v]) => [fx + ix * u! + px * v!, fz + iz * u! + pz * v!]);
  const box: [number, number, number, number] = [
    Math.floor(Math.min(...corners.map((c) => c[0]!))), Math.floor(Math.min(...corners.map((c) => c[1]!))),
    Math.ceil(Math.max(...corners.map((c) => c[0]!))), Math.ceil(Math.max(...corners.map((c) => c[1]!))),
  ];
  // every edge of the patch falls to the natural ground at no more than EDGE_FALL (rise/run): the lifted block behind the
  // face otherwise ended at the box edge as a wall (2026-10-29 redstrand w6: a 121 m lift on the SE cape left 33 m steps
  // at the back and sides where the cape falls to the sea; `worldgen lips` failed 834 cells)
  const EDGE_FALL = 1.2;
  // metres from (x, z) to the nearest standing water in any direction (a sea behind the block, a river beside it): a
  // chamfer distance over a 3 m wet mask of the box, so the block falls to every shore, not only the one behind it
  const shore = waterDistance(g, box, 3);
  const edgeClamped = (x: number, z: number): number | null => {
    const y = wantY(x, z);
    if (y === null) return null;
    // distance to the edge of the shape wantY draws (a rectangle turned to the face, inside the axis-aligned box)
    const u = (x - fx) * ix + (z - fz) * iz, v = Math.abs((x - fx) * px + (z - fz) * pz);
    // the apron and its 45 deg fill fall to the ground on their own, and never fill standing water: by a lake they ease
    // down to the shore at EDGE_FALL (a lake-side apron), never a wall at the waterline
    if (u < 0) return g.wet(x, z) ? null : Math.min(y, g.height(x, z) + shore(x, z) * EDGE_FALL);
    const d = Math.min(u - behind, run + crest + back - u, half + taper - v);
    return Math.min(y, g.height(x, z) + Math.max(0, d) * EDGE_FALL, Math.max(0, shore(x, z) - SHORE_KEEP) * SHORE_FALL + g.height(x, z));
  };
  // a held lake's rim rides in the same patch (the box grows to cover it); the higher of the two wins
  const withRim = (x: number, z: number): number | null => {
    const a = edgeClamped(x, z), b = rim.at(x, z);
    return a === null ? b : b === null ? a : Math.max(a, b);
  };
  const patchBox: [number, number, number, number] = rim.box ? [Math.min(box[0], rim.box[0]), Math.min(box[1], rim.box[1]), Math.max(box[2], rim.box[2]), Math.max(box[3], rim.box[3])] : box;
  const { patch, raised } = patchOver(`need-${need.id}`, patchBox, 3, (x, z) => g.height(x, z), withRim);
  return { ok: true, existing: false, at: [Math.round(fx), Math.round(fz)], faces: Math.round(front), height: H, raised: R1(raised), patch, message: `a ${H} m scarp behind [${Math.round(fx)}, ${Math.round(fz)}], front facing ${compassWord(front)}, ${need.width} m wide (lifted at most ${R1(raised)} m)` };
}

/**
 * walled-neck: pick the spot in the area that needs the least lift to stand as a promontory, and raise it: a level
 * pad of `radius` m at the top, flanks falling at rise/run 1.5 to natural ground on every side but one, and the NECK
 * (`neck` m wide) ramping down at 0.15 toward the open/lowest side (or `faces`). The top clears every bearing's
 * natural ground within 30 m of the ring by `flankDrop` (so the flanks protect) and the 60 m band by the wall
 * (so nothing overlooks). A spot needing more than 50 m of lift is refused.
 */
export function solveWalledNeck(g: NeedGround, need: GroundNeedDoc, area: NeedArea): NeedSolve {
  const r = need.radius, R = r + 12;
  const step = 32;
  type Spot = { at: V2; top: number; lift: number; neck: number; score: number };
  let best: Spot | null = null;
  const dflt = siteNeedSchema.parse({ kind: "defensible" }) as Extract<SiteNeed, { kind: "defensible" }>;
  for (let z = area.box[1]; z <= area.box[3]; z += step)
    for (let x = area.box[0]; x <= area.box[2]; x += step) {
      if (!area.inside(x, z) || g.wet(x, z)) continue;
      const pad = padStats(g, x, z, r);
      if (pad.wet > 0) continue;
      let band30 = -Infinity, band60 = -Infinity, lowB = 0, low = Infinity;
      for (let k = 0; k < 24; k++) {
        const b = k * 15;
        const [dx, dz] = dirOf(b);
        for (let s = 0; s <= 60; s += 6) {
          const h = g.height(x + dx * (R + s), z + dz * (R + s));
          if (s <= 30) band30 = Math.max(band30, h);
          band60 = Math.max(band60, h);
        }
        const out = g.height(x + dx * (R + 60), z + dz * (R + 60));
        if (out < low) { low = out; lowB = b; }
      }
      const neckB = need.faces ?? lowB;
      // the top must clear the flanks by flankDrop and the overlook band by the wall (eye vs wall top + parapet)
      const top = Math.max(pad.max + 1, band30 + need.flankDrop, band60 + OVERLOOK_RULE.eye - dflt.wallHeight - dflt.parapet);
      const lift = top - pad.median;
      const score = -lift - Math.hypot(x - area.near[0], z - area.near[1]) / 40;
      if (lift <= 50 && (!best || score > best.score)) best = { at: [x, z], top, lift, neck: neckB, score };
    }
  if (!best) return { ok: false, existing: false, at: area.near, faces: 0, height: 0, raised: 0, patch: null, message: "no dry spot in the area stands within 50 m of lift of a defensible promontory" };
  const already = measureDefensible(g, dflt, best.at[0], best.at[1], r);
  if (already.met) return { ok: true, existing: true, at: best.at, faces: best.neck, height: g.height(best.at[0], best.at[1]), raised: 0, patch: null, message: `the ground already carries it at [${best.at.join(", ")}] (${already.message}) — site the town there` };
  const [cx, cz] = best.at;
  const [nx, nz] = dirOf(best.neck);
  const top = best.top;
  const fallRun = (best.lift + need.flankDrop + 20) / 1.5;
  const rampRun = (best.lift + need.flankDrop + 20) / 0.15;
  const wantY = (x: number, z: number): number | null => {
    const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
    const fall = d <= R ? top : top - (d - R) * 1.5;
    const u = dx * nx + dz * nz, v = Math.abs(-dx * nz + dz * nx);
    const ramp = u > 0 && v <= need.neck / 2 ? (u <= R ? top : top - (u - R) * 0.15) : -Infinity;
    // the neck's own side walls fall like the flanks
    const rampSide = u > R && v > need.neck / 2 ? top - (u - R) * 0.15 - (v - need.neck / 2) * 1.5 : -Infinity;
    const y = Math.max(fall, ramp, rampSide);
    return Number.isFinite(y) ? y : null;
  };
  const ext = R + Math.max(fallRun, Math.min(rampRun, 400)) + 8;
  const box: [number, number, number, number] = [Math.floor(cx - ext), Math.floor(cz - ext), Math.ceil(cx + ext), Math.ceil(cz + ext)];
  const { patch, raised } = patchOver(`need-${need.id}`, box, 4, (x, z) => g.height(x, z), wantY);
  return { ok: true, existing: false, at: [Math.round(cx), Math.round(cz)], faces: Math.round(best.neck), height: R1(top), raised: R1(raised), patch, message: `a promontory pad r${r} at [${Math.round(cx)}, ${Math.round(cz)}] top ${R1(top)} m, neck ${need.neck} m wide facing ${compassWord(best.neck)} (lifted at most ${R1(raised)} m)` };
}

/**
 * roadside-rib (2026-10-29 redstrand w9: dropped-hour, a small roadside place, sat on a flat road): a rock rib or
 * outcrop `minHeight` m tall and `width` m long rising beside the travel road nearest `near`, its foot `apron` m off
 * the road's centre line. The side is `faces` (the bearing the rib's face looks toward, i.e. toward the road) or, by
 * default, the side whose ground already rises (the rib reads as the bank breaking into rock). Profile across: a steep
 * road face (rise/run 2.2, so the slope paints rock), a narrow crest, a back slope of 1; along: the ends taper over one
 * height and the crest line steps a little (a rib, not a berm). Raise-only: the road itself is never touched.
 */
/** roadside-rib profile: face rise/run (2.4 = 67 deg), back slope, metres over which each end drops. */
export const RIB_FACE = 3, RIB_BACK = 0.6, RIB_END = 4;
export function solveRoadsideRib(g: NeedGround, need: GroundNeedDoc, area: NeedArea): NeedSolve {
  const H = need.minHeight, L = need.width;
  const fail = (message: string): NeedSolve => ({ ok: false, existing: false, at: area.near, faces: 0, height: 0, raised: 0, patch: null, message });
  // the road point nearest `near` (within the area), and the road's direction there
  let best: { x: number; z: number; tx: number; tz: number; d: number } | null = null;
  for (const r of g.roads ?? []) {
    const pts = r.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = [pts[i]![0]!, pts[i]![pts[i]!.length - 1]!];
      const [bx, bz] = [pts[i + 1]![0]!, pts[i + 1]![pts[i + 1]!.length - 1]!];
      const sx = bx - ax, sz = bz - az, len2 = sx * sx + sz * sz;
      if (len2 < 1e-6) continue;
      const t = Math.max(0, Math.min(1, ((area.near[0] - ax) * sx + (area.near[1] - az) * sz) / len2));
      const x = ax + sx * t, z = az + sz * t;
      if (!area.inside(x, z)) continue;
      const d = Math.hypot(x - area.near[0], z - area.near[1]);
      const l = Math.sqrt(len2);
      if (!best || d < best.d) best = { x, z, tx: sx / l, tz: sz / l, d };
    }
  }
  if (!best) return fail(`no travel road within ${need.within} m of [${area.near.map(Math.round).join(", ")}]`);
  const roadY = g.height(best.x, best.z);
  // the side: `faces` (toward the road) or the side that already rises; never a wet side
  const nx = -best.tz, nz = best.tx;
  const side = (s: number) => {
    let rise = 0, wet = 0;
    for (const off of [need.apron, need.apron + H / 2, need.apron + H]) {
      const x = best!.x + nx * s * off, z = best!.z + nz * s * off;
      rise += g.height(x, z) - roadY;
      if (g.wet(x, z)) wet++;
    }
    return { rise, wet };
  };
  let s: 1 | -1;
  if (need.faces !== undefined) {
    const [fx, fz] = dirOf(need.faces);
    s = fx * nx + fz * nz > 0 ? -1 : 1; // the face looks toward the road: the rib stands opposite the bearing
  } else {
    const a = side(1), b = side(-1);
    s = a.wet !== b.wet ? (a.wet < b.wet ? 1 : -1) : a.rise >= b.rise ? 1 : -1;
  }
  if (side(s).wet) return fail("the only side of the road there is wet");
  const ox = nx * s, oz = nz * s; // across, away from the road
  // PROFILE (2026-10-29 w9: the first cut, a 2.2 face + 45 deg back under a 12 m feather, rendered as a smooth dome):
  // a broken rock FACE toward the road at rise/run RIB_FACE (>= 60 deg: the slope paints the cliff tile, not turf) in
  // two lifts with a narrow ledge between, a crest that steps along the rib, a gentle back (RIB_BACK) and ends that
  // stay steep (they drop over RIB_END m). The patch feathers over 3 m inside a 10 m margin, so the shape is what draws.
  const foot = need.apron, run = H / RIB_FACE, ledge = 1.6, crest = 3;
  const half = L / 2;
  const fx0 = best.x + ox * foot, fz0 = best.z + oz * foot;
  const footY = Math.max(roadY, g.height(fx0, fz0));
  const wantY = (x: number, z: number): number | null => {
    const u = (x - best!.x) * best!.tx + (z - best!.z) * best!.tz, v = (x - best!.x) * ox + (z - best!.z) * oz;
    const au = Math.abs(u);
    if (au > half || v < foot) return null;
    // the crest steps along the rib (three blocks of different height), never a uniform berm
    const block = Math.floor(((u + half) / L) * 3);
    const top = H * [0.86, 1, 0.78][Math.min(2, block)]!;
    const w = v - foot;
    const lift1 = top * 0.55, r1 = lift1 / RIB_FACE, r2 = (top - lift1) / RIB_FACE;
    let y: number;
    if (w <= r1) y = (w / r1) * lift1;
    else if (w <= r1 + ledge) y = lift1;
    else if (w <= r1 + ledge + r2) y = lift1 + ((w - r1 - ledge) / r2) * (top - lift1);
    else if (w <= r1 + ledge + r2 + crest) y = top;
    else y = top - (w - r1 - ledge - r2 - crest) * RIB_BACK;
    // steep ends: the rib drops over RIB_END m at each end instead of tapering into a mound
    if (au > half - RIB_END) y = Math.min(y, ((half - au) / RIB_END) * top);
    return y > 0.05 ? footY + y : null;
  };
  const span = foot + run + ledge + crest + H / RIB_BACK + 10;
  const corners = [[-half - 10, foot - 10], [-half - 10, span], [half + 10, foot - 10], [half + 10, span]].map(([u, v]) => [best!.x + best!.tx * u! + ox * v!, best!.z + best!.tz * u! + oz * v!]);
  const box: [number, number, number, number] = [
    Math.floor(Math.min(...corners.map((c) => c[0]!))), Math.floor(Math.min(...corners.map((c) => c[1]!))),
    Math.ceil(Math.max(...corners.map((c) => c[0]!))), Math.ceil(Math.max(...corners.map((c) => c[1]!))),
  ];
  const { patch, raised } = patchOver(`need-${need.id}`, box, 1, (x, z) => g.height(x, z), wantY, 3);
  // a light prefilter only: the default (one voxel step) rounded the 60+ deg face to 59 and filled the ledge
  (patch as { filter?: number }).filter = 0.4;
  const faces = Math.round(bearingOf(-ox, -oz));
  return { ok: true, existing: false, at: [Math.round(fx0), Math.round(fz0)], faces, height: H, raised: R1(raised), patch, message: `a ${H} m rock rib ${L} m long beside the road at [${Math.round(best.x)}, ${Math.round(best.z)}], its foot ${foot} m off the centre line, face toward ${compassWord(faces)} (lifted at most ${R1(raised)} m)` };
}

/** rise/run of a rock face (60 deg): the rib measure counts only rise climbed at least this steep. */
const RIB_STEEP = 1.73;
/** roadside-rib re-measured: the crest stands at least 0.85 x minHeight over the road beside it, and at least
 * 0.6 x minHeight of the road face is climbed at >= 60 deg (a dome climbs none of it steep). */
export function measureRib(g: NeedGround, need: GroundNeedDoc): NeedResult {
  const [x, z] = need.solved!.at;
  const [fx, fz] = dirOf(need.solved!.faces);
  const run = need.minHeight / RIB_FACE + 3.6;
  const roadY = g.height(x + fx * need.apron, z + fz * need.apron);
  let top = -Infinity;
  for (let u = -need.width / 4; u <= need.width / 4; u += 2) for (let w = run - 2; w <= run + 4; w += 1) top = Math.max(top, g.height(x - fx * w - fz * u, z - fz * w + fx * u));
  const h = top - roadY;
  // the median, over the middle half of the rib, of the rise climbed at >= 60 deg walking from the foot to the crest
  const steepRise: number[] = [];
  for (let u = -need.width / 4; u <= need.width / 4; u += 2) {
    let rise = 0;
    for (let w = -1; w < run + 2; w += 0.5) {
      const a = g.height(x - fx * w - fz * u, z - fz * w + fx * u), b = g.height(x - fx * (w + 0.5) - fz * u, z - fz * (w + 0.5) + fx * u);
      if ((b - a) / 0.5 >= RIB_STEEP) rise += b - a;
    }
    steepRise.push(rise);
  }
  steepRise.sort((p, q) => p - q);
  const face = steepRise[Math.floor(steepRise.length / 2)] ?? 0;
  const faults: string[] = [];
  if (h < need.minHeight * 0.85) faults.push(`the rib stands ${R1(h)} m over the road, under ${R1(need.minHeight * 0.85)}`);
  if (face < need.minHeight * 0.6) faults.push(`only ${R1(face)} m of the road face is >= 60 deg (needs ${R1(need.minHeight * 0.6)}): a mound, not a rock face`);
  return { need: "rock-face", met: faults.length === 0, numbers: { ribHeight: R1(h), steepFace: R1(face) }, faults, message: `the rib stands ${R1(h)} m over the road, ${R1(face)} m of its face at >= 60 deg` };
}

/** How a solved need is re-measured on the ground as it now stands (the `needs` status row). */
export function needStillMet(g: NeedGround, need: GroundNeedDoc): NeedResult | null {
  if (!need.solved) return null;
  const [x, z] = need.solved.at;
  if (need.kind === "roadside-rib") return measureRib(g, need);
  if (need.kind === "cliff-face") {
    // measured from the apron centre in front of the foot
    const [fx, fz] = dirOf(need.solved.faces);
    return measureRockFace(g, siteNeedSchema.parse({ kind: "rock-face", minHeight: need.minHeight * 0.95, apronM2: (need.apron * need.apron) / 2, readDistance: 0, footReach: need.apron }) as Extract<SiteNeed, { kind: "rock-face" }>, x + fx * (need.apron / 2), z + fz * (need.apron / 2));
  }
  return measureDefensible(g, siteNeedSchema.parse({ kind: "defensible", flankDrop: Math.min(need.flankDrop, 8), maxWall: Math.max(260, need.neck * 1.6) }) as Extract<SiteNeed, { kind: "defensible" }>, x, z, need.radius);
}
