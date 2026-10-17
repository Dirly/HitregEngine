import { z } from "zod";
import { pointInPolygon, polygonArea, polygonEdgeDistance } from "../scatter.js";
import { SURFACE_ROLES } from "./roles.js";
import { regionVegetationSchema } from "./vegetation.js";

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
const moodHex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "#rrggbb");

/**
 * A zone's MOOD: how its air and light differ from the world's. Applied as a
 * layer over the day/night cycle and under the weather (the `zone-mood`
 * builtin eases it in as a player crosses the border), so a cursed marsh stays
 * green at noon, at dusk and in a storm without repainting anything.
 */
export const regionMoodSchema = z
  .object({
    sky: moodHex.optional().describe("Colour the sky's ZENITH leans toward, by `amount` (a sickly marsh: #6f8a62; ash country: #6d625c)."),
    haze: moodHex
      .optional()
      .describe("Colour the HORIZON, the fog and the painted horizon band lean toward, by `amount` — the strongest tone-setter, because distance is drawn in it."),
    amount: z.number().min(0).max(1).default(0.5).describe("How far `sky` and `haze` go. 0.3 is a hint, 0.6 owns the zone, 1 replaces the world's sky."),
    light: moodHex.optional().describe("Multiplies the SUN's colour (#ffffff = unchanged; #ffd0a0 = a hot amber zone; #c8d8c0 = sickly)."),
    lightScale: z.number().min(0).max(3).default(1).describe("Multiplies the sun's intensity. Below 1 for an oppressive zone."),
    shade: moodHex.optional().describe("Multiplies the ambient fill and sky light — the colour SHADOWS take (#c0d0ff = cold blue shadow; #d0e8b0 = green murk)."),
    fogDensity: z.number().min(0).max(8).default(1).describe("Multiplies the fog density, on top of whatever the weather is doing."),
    mist: z.number().min(0).max(8).default(1).describe("Multiplies the scene's ground mist (sky.fog.mist.amount — needs it enabled there). 2-3 drowns a marsh; 0 clears it."),
    saturation: z.number().min(0).max(3).default(1).describe("Multiplies postfx.grade saturation (needs the scene's grade enabled). 0.7 = drained; 1.2 = lush."),
    contrast: z.number().min(0).max(3).default(1).describe("Multiplies postfx.grade contrast (needs the scene's grade enabled)."),
    temperature: z.number().min(-1).max(1).default(0).describe("Added to postfx.grade temperature: + warm, - cold (needs the scene's grade enabled)."),
    mistTop: z
      .number()
      .min(0)
      .max(60)
      .optional()
      .describe(
        "Ground-relative mist: metres above the LOCAL LOW GROUND (the lowest ground or still-water surface the " +
          "`zone-mood` builtin finds around the player) the scene's mist reaches while in this zone, instead of the " +
          "scene's absolute `sky.fog.mist.top`. A swamp at any height then keeps its mist hugging its pools " +
          "(2-4 m). Omit = the scene's absolute top. Needs the scene's mist enabled (amount > 0).",
      ),
    mistThickness: z
      .number()
      .positive()
      .max(60)
      .optional()
      .describe("With `mistTop`: metres over which that mist fades out below its top (small = a hard sheet, large = soft). Omit = the scene's `thickness`."),
  })
  .describe(
    "Optional look of this zone: tinted sky/haze, sun colour and strength, shadow colour, fog and colour grade. " +
      "Read by the `zone-mood` builtin, which eases it in over the day/night cycle and under the weather; a zone " +
      "without one shows the scene's own look, and a nested town zone without one inherits its parent's.",
  );

export type RegionMood = z.infer<typeof regionMoodSchema>;

/** One sound id (or a comma list of them) per time-of-day band; `*` stands in for any band left out. */
export const regionSoundBandsSchema = z
  .object({
    "*": z.string().optional().describe("Any band not listed."),
    dawn: z.string().optional().describe("05:00-07:30."),
    day: z.string().optional().describe("07:30-16:30."),
    dusk: z.string().optional().describe("16:30-19:30."),
    night: z.string().optional().describe("19:30-05:00."),
  })
  .describe("Per day/night band (the same edges as the day-night script, crossfaded by the soundscape): a sound id, or a comma list. `*` = every band not listed.");

export type RegionSoundBands = z.infer<typeof regionSoundBandsSchema>;

/**
 * A zone's own SOUND: what the `soundscape` builtin plays here instead of the
 * biome patterns. Resolved over the region chain (a `place` over its zone, a
 * nested town zone over its parent) field by field; anything left out falls
 * back to the biome beds, spots and music as before.
 */
export const regionSoundSchema = z
  .object({
    bed: regionSoundBandsSchema
      .optional()
      .describe("Ambient bed LOOP per band (one sound id each, e.g. `ambience/biome/swamp-{band}.ogg` — `{band}` is filled in). Replaces the biome beds here (see `biomeMix`)."),
    bedMix: z.number().min(0).max(2).default(1).describe("Gain of `bed` relative to a biome bed (1 = as loud as one)."),
    biomeMix: z
      .number()
      .min(0)
      .max(1)
      .default(0)
      .describe("How much of the biome beds is still heard under `bed`: 0 = the zone's bed replaces them, 0.3 = a little of the land shows through."),
    spots: regionSoundBandsSchema
      .optional()
      .describe("Spot one-shots per band: comma list of ids (an id without extension is a variant family, e.g. `spot/frog-croak`). Replaces the biome spot table here."),
    music: regionSoundBandsSchema
      .optional()
      .describe(
        "Exploration tracks per band, comma list (`{daynight}` = day|night is filled in). Beats biome music; a town zone's town music " +
          "beats an INHERITED one (a town zone inherits its parent's bed and still water, never its music or spots).",
      ),
    stillWater: z
      .string()
      .optional()
      .describe("Bed near still inland water here (marsh pools: `ambience/water/swamp-water.ogg`). Replaces the soundscape's lake bed; rivers and the sea keep theirs."),
  })
  .describe(
    "Optional sound of this zone: its own ambient bed, spot sounds, music and still-water bed per day/night band. Read by the " +
      "`soundscape` builtin BEFORE the biome patterns; a place inherits its zone's, a nested town zone its parent's bed and still water.",
  );

export type RegionSound = z.infer<typeof regionSoundSchema>;

/**
 * One ambient particle layer a zone carries (fireflies, spores, ash): the
 * `ambient-particles` builtin drives the player's `ambient-<id>` emitter by it
 * while the player stands in the zone. The look is the emitter's own data.
 */
export const regionAmbientLayerSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, "lowercase slug")
      .describe("Layer id: drives the local player's child entity tagged `ambient-<id>` (the scene must carry that emitter)."),
    biomes: z.string().default("").describe("Comma list of biome ids it is limited to INSIDE the zone. Empty = the whole zone."),
    when: z.enum(["day", "night", "always"]).default("always").describe("Time of day it lives, eased across dusk and dawn."),
    town: z.enum(["any", "only", "never"]).default("any").describe("Town zones (region tag `town`): `never` keeps it out of the zone's towns."),
    needWater: z.boolean().default(false).describe("Only near water."),
    waterBoost: z.number().min(0).default(0).describe("Extra rate x closeness to water (1.5 = two and a half times as many at the edge)."),
    rate: z.number().min(0).default(4).describe("Particles per second at full strength (live count ~ rate x lifetime, capped by the emitter's `max`)."),
    storm: z.number().default(0).describe("Extra rate per unit of storm; negative thins it out in a storm."),
    wind: z.number().min(0).default(0).describe("Metres/second the wind carries it at full gust; 0 = the emitter's own aim."),
    rise: z.number().default(0).describe("Vertical drift m/s added to the wind aim: negative falls (ash), positive rises (spores)."),
    glow: z.number().min(0).max(1).default(0.25).describe("Night brightness floor: 1 = self-lit (fireflies), 0.2 = moonlit only."),
  })
  .describe("An ambient particle layer that lives in this zone (same fields as an `ambient-particles` layer, minus `zones`: the zone IS where).");

export type RegionAmbientLayer = z.infer<typeof regionAmbientLayerSchema>;

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
  ground: z
    .partialRecord(z.enum(SURFACE_ROLES), z.string().min(1))
    .optional()
    .describe(
      "This zone's own ground: ground ROLE -> palette surface NAME (`{ grass: \"shelf-grass\", paving: \"shelf-cobble\" }`). " +
        "Natural roles (grass, ground, cliff, accent) replace the palette surfaces tagged with that role " +
        "(`surfaces[].role`); `road` and `paving` replace what roads with that `role` paint. Blended by zone " +
        "membership across `zoneGround.band`, so a border is a gradient. A zone without it renders the base " +
        "palette. Written by `worldgen zone-textures` from the cast's ground looks; a nested town zone uses its " +
        "parent's unless it declares its own.",
    ),
  mood: regionMoodSchema.optional(),
  sound: regionSoundSchema.optional(),
  ambient: z
    .array(regionAmbientLayerSchema)
    .optional()
    .describe(
      "Ambient particle layers that live in this zone (spores in a bog, ash in burned country). A place inherits its zone's and a " +
        "nested town zone its parent's (a layer with the same id nearer the point wins). Read by `ambient-particles` on top of its " +
        "scene `layers` param, so older scenes keep working.",
    ),
  vegetation: regionVegetationSchema.optional(),
  rockCap: z
    .object({
      layer: z.string().min(1).describe("Palette surface NAME the rocks of this zone wear on top (`snow`, a grass for moss, `sand`, the zone's own ground...)."),
      amount: z.number().min(0).max(1).default(0.6).describe("How far it reaches: 0 = bare, 0.4 = flat tops, 0.7 = tops and ledges, 1 = all but the steep sides."),
    })
    .optional()
    .describe(
      "This zone's rock cap: every scatter rule that opts in with `cap` wears it here, overriding the rule's own `cap` " +
        "(auto ground sampling or a fixed layer). The nearest region on the chain place -> zone -> parent that declares " +
        "one wins. Cosmetic and seed-stable: the same mesh and material everywhere, only the per-rock cap changes.",
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
 *
 * Regions tagged `place` (a signature place's own mood, cut out of its zone)
 * are LOOK only: they are not zones for hosting, chat or spawning, so they are
 * skipped unless `opts.places` asks for them (the mood lookup does).
 */
export function regionAt(regions: readonly RegionDoc[], x: number, z: number, opts?: { places?: boolean }): RegionDoc | null {
  const places = opts?.places === true;
  for (const region of regions) if (region.within !== undefined && (places || !region.tags.includes("place")) && pointInPolygon(x, z, region.polygon)) return region;
  for (const region of regions) if (region.within === undefined && pointInPolygon(x, z, region.polygon)) return region;
  return null;
}

/** What a point's region chain says about its look and sound — see `regionLookAt`. */
export interface RegionLook {
  /** The ZONE (hosting/chat/sanctuary sense): a nested town zone first, else the top-level zone. */
  region: RegionDoc;
  /** A signature place (tagged `place`) the point lies in, when one differs from `region`. */
  place: RegionDoc | null;
  /** Nearest mood on the chain place -> zone -> parent. */
  mood?: RegionMood;
  /** Sound resolved field by field along the chain (a town zone does not inherit `music` or `spots`). */
  sound?: RegionSound;
  /** Ambient layers along the chain, unique by id, the nearest region's winning. */
  ambient?: RegionAmbientLayer[];
}

/**
 * The region chain at (x, z) — place, zone, the zone's parent — resolved into
 * one look: mood, sound and ambient layers, each from the nearest region that
 * declares it. Null outside every zone. What the client's `ctx.regionAt`
 * hands to the zone-mood, soundscape and ambient-particles builtins.
 */
export function regionLookAt(regions: readonly RegionDoc[], x: number, z: number): RegionLook | null {
  const region = regionAt(regions, x, z);
  if (!region) return null;
  const hit = regionAt(regions, x, z, { places: true });
  const place = hit && hit !== region && hit.tags.includes("place") ? hit : null;
  const chain: RegionDoc[] = [];
  const push = (r: RegionDoc | undefined | null): void => {
    if (r && !chain.includes(r)) chain.push(r);
  };
  const parentOf = (r: RegionDoc): RegionDoc | undefined => (r.within !== undefined ? regions.find((p) => p.id === r.within) : undefined);
  if (place) push(place);
  push(region);
  push(parentOf(region));
  if (place) push(parentOf(place));
  const out: RegionLook = { region, place };
  for (const r of chain) {
    if (r.mood) {
      out.mood = r.mood;
      break;
    }
  }
  let sound: RegionSound | undefined;
  for (const r of chain) {
    if (!r.sound) continue;
    // a town zone has its own music and spot logic (town tracks, the town spot table); its parent's are the wilderness's
    const inherited = r !== chain[0] && chain.slice(0, chain.indexOf(r)).some((c) => c.tags.includes("town"));
    const s = r.sound;
    sound ??= { bedMix: s.bedMix, biomeMix: s.biomeMix };
    if (!sound.bed && s.bed) {
      sound.bed = s.bed;
      sound.bedMix = s.bedMix;
      sound.biomeMix = s.biomeMix;
    }
    if (!sound.spots && s.spots && !inherited) sound.spots = s.spots;
    if (!sound.music && s.music && !inherited) sound.music = s.music;
    if (sound.stillWater === undefined && s.stillWater !== undefined) sound.stillWater = s.stillWater;
  }
  if (sound) out.sound = sound;
  const ambient: RegionAmbientLayer[] = [];
  for (const r of chain) for (const layer of r.ambient ?? []) if (!ambient.some((a) => a.id === layer.id)) ambient.push(layer);
  if (ambient.length) out.ambient = ambient;
  return out;
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
    if (area < 0.5 && !region.tags.includes("town") && !region.tags.includes("place")) findings.push(`region "${region.id}": only ${area.toFixed(2)} km² — a zone should take minutes to cross`);
    const towns = features.towns.filter((t) => pointInPolygon(t.center[0], t.center[1], region.polygon)).map((t) => t.id);
    const pois = features.pois.filter((p) => pointInPolygon(p.position[0], p.position[2], region.polygon)).length;
    // a town zone holds its town by construction; a wilderness zone holds a
    // town when the town's own zone (or its centre) lies inside it
    if (towns.length === 0 && !region.tags.includes("town") && !region.tags.includes("place")) findings.push(`region "${region.id}": no town inside — where do players gather?`);
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
