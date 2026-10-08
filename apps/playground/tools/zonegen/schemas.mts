/**
 * zonegen — the planning documents of the zone pipeline, and nothing else.
 *
 * The pipeline's rule is PLAN EARLY, BUILD LATE: every relationship and
 * requirement is written down and linted as data before anything is built, so
 * a fresh builder agent gets a bounded contract instead of a paragraph. These
 * schemas are those contracts. Lints live in ./commands/*.mts; the stage order
 * lives in ./stages.mts and is printed by `zonegen status`.
 *
 * Where the files live (see ./paths.mts):
 *   projects/<p>/authoring/zonegen/bestiary.json                       the creature catalogue (world-independent)
 *   projects/<p>/authoring/zonegen/<world>/cast.json                   one row per zone, decided for the whole map at once
 *   projects/<p>/authoring/zonegen/<world>/links.json                  how towns relate (roads, trade, feuds)
 *   projects/<p>/authoring/zonegen/<world>/zones/<zone>/brief.json     the zone's identity and content budget
 *   .../zones/<zone>/bestiary.json                                     the zone's pick from the catalogue
 *   .../zones/<zone>/quests.json                                       quest graph + the locations and dungeons it needs
 *   .../zones/<zone>/reservations.json                                 where each location goes on the real ground
 *   .../zones/<zone>/assets.json                                       GENERATED: everything the zone needs that does not exist yet
 *   .../zones/<zone>/freeze.json                                       GENERATED: hashes of the plan when building began
 * Town plans stay where the town tools read them: authoring/towns/<town>-plan.json.
 */
import { z } from "zod";

const id = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes");
const xz = z.tuple([z.number().finite(), z.number().finite()]);
const levelBand = z
  .tuple([z.number().int().min(1), z.number().int().min(1)])
  .refine(([a, b]) => a <= b, "level band is [min, max]");
const unique = <T,>(rows: T[], key: (row: T) => string, ctx: z.RefinementCtx, path: string): void => {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const k = key(row);
    if (seen.has(k)) ctx.addIssue({ code: "custom", path: [path, index], message: `duplicate id "${k}"` });
    seen.add(k);
  });
};

// ------------------------------------------------------------------ bestiary

export const CREATURE_ROLES = ["melee", "ranged", "caster", "swarm", "brute", "skirmisher", "support", "elite", "boss"] as const;
export const HABITATS = [
  "forest", "grassland", "marsh", "coast", "water", "mountain", "tundra", "desert", "badlands", "canyon",
  "cave", "mine", "ruin", "graveyard", "farmland", "road", "town-outskirts",
] as const;

export const creatureSchema = z.object({
  id,
  name: z.string().min(1),
  family: id.describe("The body it shares with its relatives (\"wolf\", \"ratkin\", \"ghoul\"). One body, many themes: a variant is a texture, never a new mesh."),
  kind: z.enum(["wildlife", "faction", "unique"]).describe("wildlife: lives in a habitat whoever rules the zone. faction: belongs to an organised threat. unique: a named one-off."),
  body: z.object({
    model: z.string().default("").describe("Asset path of the rigged model. Empty while it does not exist."),
    status: z
      .enum(["ready", "needs-install", "needs-rig", "needs-body"])
      .describe("needs-install: the rigged body exists (see `source`) but not under assets/ yet — a command, not an artist. needs-rig: a mesh without a usable skeleton. needs-body means a HUMAN must model it: surface it at casting time, it is the longest lead in the pipeline."),
    source: z.string().default("").describe("Where the finished body lives when it is not installed yet (a path outside assets/)."),
  }),
  themes: z
    .array(
      z.object({
        id,
        atlas: z.string().default(""),
        status: z.enum(["ready", "needs-install", "needs-art"]).describe("needs-install: the art exists (`source`) but is not under assets/ yet."),
        source: z.string().default("").describe("Where finished art lives when it is not installed yet (e.g. tools/atlas/out/<family>/<theme>/)."),
      }),
    )
    .min(1)
    .describe("Texture themes on the one body. A zone's rare or boss is normally a NEW theme on an existing body: art only, no human."),
  roles: z.array(z.enum(CREATURE_ROLES)).min(1),
  abilities: z.array(z.string()).default([]).describe("Ability/spell ids it can use that the engine already implements. A quest may not assume one that is not listed."),
  habitats: z.array(z.enum(HABITATS)).min(1),
  level: levelBand,
  template: z.string().default("").describe("Mob template / prefab id the spawner instantiates. Empty = not built yet."),
  notes: z.string().default(""),
});
export type Creature = z.infer<typeof creatureSchema>;

export const factionSchema = z.object({
  id,
  name: z.string().min(1),
  premise: z.string().min(1).describe("What they want and why they are a problem, in two sentences."),
  creatures: z
    .array(z.union([id, z.object({ creature: id, theme: id.describe("The theme this faction's members wear.") })]))
    .min(1)
    .describe("Member creature ids, or { creature, theme } to fix the theme the faction dresses it in."),
  scope: z
    .enum(["story", "local"])
    .default("story")
    .describe("story: an organised threat that can be a zone's MAIN faction (one per zone, neighbours differ). local: a crew, cult, circle, nest or pack that may turn up in any zone as one of its other occupants, never as its main threat."),
  draft: z.boolean().default(false).describe("Added by a casting agent from catalogued creatures only; awaits the owner's approval (the world bestiary gate warns)."),
  motifs: z.array(z.string()).default([]).describe("Visual and story motifs their camps, shrines and dungeons carry (\"plague\", \"bone\", \"web\")."),
  dungeonThemes: z.array(z.string()).default([]).describe("Dungeon looks that belong to them (\"warren\", \"flooded-crypt\")."),
});
export type Faction = z.infer<typeof factionSchema>;
/** A faction's members as { creature, theme } ("" = any of the creature's themes). */
export const factionMembers = (f: { creatures: (string | { creature: string; theme: string })[] }): { creature: string; theme: string }[] =>
  f.creatures.map((c) => (typeof c === "string" ? { creature: c, theme: "" } : c));

export const bestiarySchema = z
  .object({ version: z.literal(1).default(1), creatures: z.array(creatureSchema), factions: z.array(factionSchema) })
  .superRefine((b, ctx) => {
    unique(b.creatures, (c) => c.id, ctx, "creatures");
    unique(b.factions, (f) => f.id, ctx, "factions");
    const known = new Set(b.creatures.map((c) => c.id));
    b.factions.forEach((f, i) => factionMembers(f).forEach((m, j) => { if (!known.has(m.creature)) ctx.addIssue({ code: "custom", path: ["factions", i, "creatures", j], message: `unknown creature "${m.creature}"` }); }));
  })
  .describe("The creature catalogue: everything the GAME supports, independent of any world. Zones select from it; they never invent.");
export type Bestiary = z.infer<typeof bestiarySchema>;

// ---------------------------------------------------------------------- cast

export const castRowSchema = z.object({
  zone: z.string().min(1).describe("Region id of a wilderness zone (not a town zone)."),
  premise: z.string().min(1).describe("What is wrong here, in one or two sentences. Must not read like a neighbour's."),
  faction: id.describe("The MAIN threat. No two adjacent zones may share it."),
  minor: z
    .array(z.object({ faction: id, from: z.string().min(1).describe("The ADJACENT zone it spills over from.") }))
    .default([])
    .describe("Continuity across a border: a neighbour's main faction present here as a minority. At most one or two."),
  wildlife: z.array(id).default([]).describe("Wildlife creature ids. Neighbours may share wildlife; habitats decide it."),
  others: z
    .array(z.object({ group: id.describe("A LOCAL catalogue faction."), flavour: z.string().min(1).describe("One line: how this group shows up in THIS zone, so the same crew is not identical everywhere.") }))
    .default([])
    .describe("The zone's other occupants besides its story faction: bandits, cultists, a necromancer's circle, a spider nest. Most places belong to one of these, not to the main threat."),
  level: levelBand,
  palette: z
    .string()
    .min(1)
    .describe(
      "Terrain/prop palette id. Adjacent zones must differ. Its ground look (role -> tile) is " +
        "authoring/zonegen/palettes/<palette>.json (`groundPaletteSchema`), applied by `worldgen zone-textures`.",
    ),
  buildingSet: z.string().min(1).describe("Architecture set its towns are built from. Reuse is fine; wealth and setting vary it."),
  dungeonTheme: z.string().default("").describe("The look of its dungeon(s)."),
  landforms: z.array(z.string()).default([]).describe("What the ground actually offers here (read off the map): \"crater\", \"sea cliffs\", \"mesa\"."),
  starter: z.boolean().default(false).describe("New characters may begin here. A starter zone's hub is never a capital."),
});
export type CastRow = z.infer<typeof castRowSchema>;

/**
 * A palette's GROUND look: one tile per ground role, shared by every zone the
 * cast gives this palette (towns of one culture share their cobble).
 * `projects/<p>/authoring/zonegen/palettes/<palette>.json`. Kept out of
 * cast.json on purpose: a look is not planning, and the zone freeze hashes the
 * cast file whole.
 */
export const groundPaletteSchema = z.object({
  id: z.string().min(1).describe("The palette id the cast rows name."),
  ground: z
    .partialRecord(
      z.enum(["grass", "ground", "cliff", "road", "paving", "accent"]),
      z.union([
        z.string().min(1),
        z.object({
          texture: z.string().min(1),
          uvScale: z.number().positive().optional().describe("Metres per tile; default: the base surface's for that role."),
          roughness: z.number().min(0).max(1).optional(),
        }),
      ]),
    )
    .describe(
      "Ground role -> texture asset id (assets/textures/, e.g. \"zones/<palette>/grass.png\"), or { texture, uvScale, roughness }. " +
        "`worldgen zone-textures` registers each as palette surface `<palette>-<role>` and sets every cast zone's " +
        "`regions[].ground`; a role left out keeps the world's base surface. Tiles match the base ground tiles' pixel size.",
    ),
});
export type GroundPalette = z.infer<typeof groundPaletteSchema>;

export const castSchema = z
  .object({
    world: z.string().min(1),
    rules: z
      .object({
        maxFactionShare: z.number().min(0).max(1).default(0.25).describe("Most zones (as a fraction) one faction may be the MAIN threat of."),
        maxLevelStep: z.number().int().min(1).default(8).describe("Largest gap between the level bands of two adjacent zones that share a pass."),
      })
      .default({ maxFactionShare: 0.25, maxLevelStep: 8 }),
    rows: z.array(castRowSchema),
  })
  .superRefine((c, ctx) => unique(c.rows, (r) => r.zone, ctx, "rows"))
  .describe("World casting: one pass over the whole zone map so neighbours differ on purpose. Decided before any zone is planned.");
export type Cast = z.infer<typeof castSchema>;

export const linksSchema = z
  .object({
    world: z.string().min(1),
    links: z.array(
      z.object({
        a: z.string().min(1).describe("Town id."),
        b: z.string().min(1).describe("Town id."),
        kind: z.enum(["road", "trade", "ferry", "feud", "kin", "pilgrimage", "garrison"]),
        note: z.string().min(1).describe("What actually passes between them. The seed for a cross-town quest written much later."),
      }),
    ),
  })
  .describe("How towns relate. The RELATIONSHIP and the route are planned early; the quests that use them are written last.");
export type Links = z.infer<typeof linksSchema>;

// ---------------------------------------------------------------- zone brief

/**
 * A signature place: the unit a zone is designed in (docs/zone-creation.md). The owner's test is "does it feel
 * hand-made and alive", so each place states what a passer-by sees, the one thing nobody else in the zone has, and
 * who lives there, before a footprint or a quest exists.
 */
export const placeSchema = z.object({
  id,
  name: z.string().min(1),
  size: z.enum(["pinpoint", "small", "medium", "large"]).describe("Size class (docs/world-standards/sites.md). A large place is several linked sub-sites round one landmark."),
  read: z.string().min(1).describe("One line: what a passer-by sees at a glance (\"illegal hunters with hides on tanning racks\"). The build is that."),
  landmark: z.string().min(1).describe("The biggest thing there and where it is seen from (\"a gutted watchtower on the spur, seen from the coast road\")."),
  features: z.array(z.string().min(1)).default([]).describe("The sub-sites joined by walked routes. A large place has three or more, water or caves among them where the land allows."),
  setPiece: z.string().min(1).describe("The one moment or arrangement the place is remembered for (cultists round a pentagram, a giant asleep on a cart of stolen bells)."),
  unique: z.string().min(1).describe("What no other place in this zone has: a material, a creature, a structure, a light, a sound."),
  mood: z.string().default("").describe("Ground, vegetation, water and air (\"spoil-black ground, dead pines, green tarn, low mist\"). May break the zone palette."),
  holder: z.string().default("").describe("Zone bestiary group id (or a few words before the bestiary exists) holding it; empty = safe place."),
  named: z.array(z.string().min(1)).default([]).describe("Named creatures or people met here: one near the edge, more further in."),
  dungeon: z
    .object({
      name: z.string().min(1),
      entrance: z.enum(["landmark", "hidden"]).describe("A landmark entrance is obvious from afar; a hidden one is found."),
      promise: z.string().min(1).describe("What the outside promises the inside will be (the inside must read as that kind of place)."),
    })
    .optional()
    .describe("This place's OWN dungeon. One door; never shared with another place."),
  site: z
    .object({
      candidate: z.string().default("").describe("The `zonegen sites` candidate id it was picked from (s07); ids change when the finder re-runs, `at` is what counts."),
      kind: z.string().min(1).describe("The ground feature: canyon-end, cliff-water, plateau, peak, saddle, wall-gap, cove, waterfall, path-end, switchback, empty-land, or other (say what)."),
      at: z.tuple([z.number(), z.number()]).describe("World [x, z] of the feature the place is built on/around."),
      faces: z.string().default("").describe("Which way the place faces and why: its approach (\"the canyon mouth, NE, where the Ironspur road arrives\")."),
    })
    .optional()
    .describe("The GROUND this place was chosen from, picked from `zonegen sites` before the place was written: places come from the land and the player's path, not from text. Reserve checks the reservation stands on it."),
});
export type Place = z.infer<typeof placeSchema>;

export const zoneBriefSchema = z
  .object({
    zone: z.string().min(1),
    name: z.string().min(1),
    premise: z.string().min(1),
    history: z.string().min(1).describe("What this place was, and what changed. Three to six sentences."),
    threat: z.string().min(1).describe("Who or what is causing the problem now, and what it wants."),
    tone: z.string().default(""),
    level: levelBand,
    traversal: z.string().min(1).describe("How a player moves through it: the roads, the passes, what blocks the way and what a detour costs."),
    hub: z.string().min(1).describe("Town id of the zone's main town."),
    towns: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          tier: z.enum(["hamlet", "village", "town", "city", "capital"]),
          role: z.string().min(1).describe("Why this settlement exists and how it survives."),
          wealth: z.enum(["destitute", "poor", "comfortable", "wealthy", "noble"]),
        }),
      )
      .min(1),
    neighbours: z
      .array(z.object({ zone: z.string().min(1), relation: z.string().min(1).describe("What crosses this border: trade, refugees, the spill faction, nothing.") }))
      .default([]),
    budget: z
      .object({
        arcs: z.number().int().min(0),
        sideQuests: z.number().int().min(0),
        discoveryQuests: z.number().int().min(0),
        pois: z.object({ small: z.number().int().min(0), medium: z.number().int().min(0), large: z.number().int().min(0) }),
        dungeons: z.number().int().min(0),
        mainQuests: z.number().int().min(0).optional().describe("Main quests across all arcs, at most. Absent = counted only through `arcs`."),
        expansion: z.number().int().min(0).default(0).describe("Extra locations the exploration pass may add. Stops POI -> quest -> POI loops."),
      })
      .describe("How much content this zone gets. Every later lint counts against it."),
    budgetNote: z.string().default("").describe("Why the budget is what it is (a starter zone kept small, a dungeon traded for side quests). Read by later agents; not checked."),
    variety: z
      .object({
        maxRepeatPerZone: z.number().int().min(1).default(2).describe("Quests of this zone sharing one signature (or a near-duplicate of it) at most."),
        maxRepeatNeighbourhood: z.number().int().min(1).default(3).describe("The same, across this zone plus its `neighbours`."),
        nearDuplicate: z.number().min(0).max(1).default(0.8).describe("Jaccard similarity of two quests' block multisets at or above which they count as a repeat."),
        minNoKillShare: z.number().min(0).max(1).default(0.4).describe("Share of quests with no `kill` objective, at least."),
        minNonNpcSources: z.number().int().min(0).default(2).describe("Quests whose source is not an NPC (object, auto …), at least."),
        minWorldGated: z.number().int().min(0).default(2).describe("Quests gated by a world-state condition (a condition block of scope `world`: clock, weather), at least."),
        minDistinctActions: z.number().int().min(0).default(6).describe("Distinct action blocks used across the zone, at least."),
        maxKillCollectShare: z.number().min(0).max(1).default(0.3).describe("Share of quests that are nothing but an NPC sending you to kill, or to collect, at most."),
        maxLeadsPerQuest: z.number().int().min(1).default(3).describe("Leads one quest may have: a few hints, not a trail of breadcrumbs."),
        minGroups: z.number().int().min(1).default(4).describe("Distinct occupant groups the zone bestiary defines, at least (warning)."),
        maxMainHostileShare: z.number().min(0).max(1).default(0.5).describe("Share of hostile locations the main story faction may hold, at most (error above)."),
        minHostileGroups: z.number().int().min(1).default(3).describe("Distinct groups holding the hostile locations, at least (error below, when the zone has that many hostile locations)."),
        minKillGroups: z.number().int().min(1).default(3).describe("Distinct groups that kill objectives across the zone target, at least (warning)."),
      })
      .default({ maxRepeatPerZone: 2, maxRepeatNeighbourhood: 3, nearDuplicate: 0.8, minNoKillShare: 0.4, minNonNpcSources: 2, minWorldGated: 2, minDistinctActions: 6, maxKillCollectShare: 0.3, maxLeadsPerQuest: 3, minGroups: 4, maxMainHostileShare: 0.5, minHostileGroups: 3, minKillGroups: 3 })
      .describe("Sameness thresholds the quest lint WARNS against (for now). A zone argues for an exception here, in data."),
    places: z
      .array(placeSchema)
      .default([])
      .describe("The zone's signature PLACES, designed before any quest: quests are later attached to them (a quest location with the same id). Places first, quests last."),
  })
  .superRefine((b, ctx) => {
    unique(b.towns, (t) => t.id, ctx, "towns");
    unique(b.places, (p) => p.id, ctx, "places");
    if (!b.towns.some((t) => t.id === b.hub)) ctx.addIssue({ code: "custom", path: ["hub"], message: "the hub must be one of `towns`" });
  })
  .describe("The shared specification every agent working on this zone reads first.");
export type ZoneBrief = z.infer<typeof zoneBriefSchema>;

// ------------------------------------------------------------- zone bestiary

export const zoneBestiarySchema = z
  .object({
    zone: z.string().min(1),
    wildlife: z.array(z.object({ creature: id, habitats: z.array(z.enum(HABITATS)).min(1), density: z.enum(["sparse", "common", "dense"]).default("common") })),
    faction: z.array(z.object({ creature: id, theme: id, role: z.enum(CREATURE_ROLES) })).min(1).describe("The main faction's line-up here."),
    minor: z.array(z.object({ creature: id, theme: id, from: z.string().min(1) })).default([]),
    rares: z
      .array(
        z.object({
          id,
          name: z.string().min(1),
          base: id.describe("Catalogue creature whose body it uses."),
          theme: id.describe("Its own theme. Not in the catalogue yet = an atlas request in the asset manifest."),
          where: z.string().min(1).describe("Location id or habitat it haunts."),
          level: z.number().int().min(1),
          abilities: z.array(z.string()).default([]),
          scale: z.number().min(0.5).max(6).default(1).describe("Body size multiplier on the base creature (an enormous croc = 3). Populate scales its collider, reach, eye height and gait with it; the server sees anything bigger than a person from further away (up to 600 m) and places its pack beyond that, so a giant is seen coming."),
        }),
      )
      .default([]),
    groups: z
      .array(
        z.object({
          id,
          name: z.string().min(1),
          faction: z.string().default("").describe("The zone's main faction, one of its cast minors, or one of its cast row's `others`; empty = wildlife with a twist."),
          members: z.array(z.object({ creature: id, theme: z.string().default(""), role: z.enum(CREATURE_ROLES), scale: z.number().min(0.5).max(6).default(1).describe("Body size multiplier on the base creature (an enormous croc = 3). Populate scales its collider, reach, eye height and gait with it; the server sees anything bigger than a person from further away (up to 600 m) and places its pack beyond that, so a giant is seen coming."), })).min(1),
          where: z.string().min(1).describe("Location id, habitat or a few words of where they hold out."),
          premise: z.string().min(1).describe("Their own small reason to be here, apart from the zone's big story."),
        }),
      )
      .default([])
      .describe("The concrete occupant groups of the zone: one overarching story faction, but most places belong to someone else."),
    bosses: z
      .array(z.object({ id, name: z.string().min(1), base: id, theme: id, dungeon: z.string().default(""), story: z.string().min(1).describe("Its part in the zone's problem.") }))
      .default([]),
  })
  .describe("What lives in this zone, selected from the catalogue with the neighbours' selections in hand.");
export type ZoneBestiary = z.infer<typeof zoneBestiarySchema>;

// --------------------------------------------------------------- quest graph

export const LOCATION_SIZES = ["pinpoint", "small", "medium", "large"] as const;

export const locationSchema = z.object({
  id,
  name: z.string().min(1),
  kind: z.enum(["town", "poi", "dungeon-entrance", "landmark", "wild"]),
  size: z.enum(LOCATION_SIZES).default("small"),
  siteKinds: z.array(z.string()).default([]).describe("Worldgen POI kinds that would suit it (\"mine-site\", \"ruin-site\", \"lakeshore\"). Empty = needs a new site."),
  hostile: z.string().default("").describe("Zone bestiary group id (preferred) or faction id holding it; empty for a safe place."),
  overlooksRoad: z.boolean().default(false).describe("A hostile LOOKOUT over a town-to-town road (a watch post, a toll gang): allowed beside the road. Every other hostile place keeps off those roads (`zonegen sites` / `reserve` lint `hostile-on-road`)."),
  needs: z.array(z.string()).default([]).describe("What must physically exist there, one requirement per entry: \"three inspectable graves\", \"a tomb door\"."),
  entranceTo: z.string().default("").describe("Dungeon id, when this is its way in."),
  discovery: z.boolean().default(false).describe("Found by exploring; no town quest points at it."),
  minTownDistance: z.number().min(0).default(0).describe("Metres it must keep from any town (a hermit is not beside the gate)."),
  town: z.string().default("").describe("kind town: the town id."),
  place: z.string().default("").describe("The brief's signature place this location is part of (a dungeon entrance inside a large place, a camp on its shore). Empty when the location IS a place (same id) or stands alone."),
  note: z.string().default(""),
});
export type Location = z.infer<typeof locationSchema>;

export const dungeonConceptSchema = z.object({
  id,
  name: z.string().min(1),
  origin: z.string().min(1).describe("What it was built or formed as."),
  now: z.string().min(1).describe("Who controls it and what they do there."),
  antagonist: z.string().min(1).describe("Boss id from the zone bestiary."),
  surfaceEffect: z.string().min(1).describe("How it shows on the surface: what a player meets before ever going in."),
  climax: z.string().min(1),
  entrance: id.describe("Location id of the way in."),
  kind: z.enum(["masonry", "cave", "mixed"]),
  instanced: z.boolean().default(true),
  rooms: z.array(z.string()).default([]).describe("Rooms the quests REQUIRE (a prisoner cell, a ritual chamber). The layout is designed later and must contain them."),
});
export type DungeonConcept = z.infer<typeof dungeonConceptSchema>;

export const objectiveSchema = z.object({
  id,
  action: z.string().min(1).describe("A registered quest ACTION block (engine spec `questBlocks.action`, read at lint time so it cannot drift): visit, kill, collect, talk, interact, read, deliver, endure, perform."),
  target: z.object({
    type: z.enum(["npc", "creature", "item", "place", "entity"]),
    ref: z.string().min(1).describe("npc: resident id. creature: catalogue creature, rare or boss id. item: quest item id. place: location id. entity: a declared quest entity (presence, object, readable)."),
  }),
  count: z.number().int().positive().default(1),
  at: z.string().default("").describe("Location id where it happens."),
  after: z.array(id).default([]).describe("Objective ids (same quest) that must be done first."),
  needs: z.array(id).default([]).describe("Quest item ids the player must already hold (a key before its door)."),
  grants: z.array(id).default([]).describe("Quest item ids doing this gives."),
  when: z.enum(["any", "night", "day"]).default("any").describe("Shorthand for a `clock` condition (night 20-4, day 6-20). For any other window use `if`."),
  if: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("A full condition object (engine dialogue condition: { clock: { from, to } }, { weather: { min } }, { flag }, all/any/not …). Every key must be a registered CONDITION block."),
  params: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("The action block's own fields, validated against its registered schema (endure: seconds; perform: action, range; deliver: item)."),
  conditions: z.array(z.string().min(1)).default([]).describe("Registered CONDITION block names gating this step (legacy shorthand; prefer `if`)."),
  then: z
    .array(z.union([z.string().min(1), z.record(z.string(), z.unknown())]))
    .default([])
    .describe("CONSEQUENCES this step triggers: a registered block name, or the consequence itself ({ do: setFlag, flag: <name> })."),
});
export type Objective = z.infer<typeof objectiveSchema>;

export const plannedQuestSchema = z
  .object({
    id,
    title: z.string().min(1),
    kind: z.enum(["main", "side", "discovery", "dungeon", "link"]),
    arc: z.string().default(""),
    giver: z.object({
      type: z.string().min(1).describe("A registered quest SOURCE block (engine spec `questBlocks.source`): npc, object, presence, auto. Only npc is advertised (a marker); the others are found through `leads`."),
      ref: z.string().default("").describe("npc: resident id. object / presence: a declared quest entity (or, legacy, the location it stands at). auto: empty."),
      when: z.record(z.string(), z.unknown()).optional().describe("auto: the condition that starts it (validated against the source block)."),
      area: z.object({ label: z.string(), center: xz, radius: z.number() }).optional().describe("auto: the region that starts it (validated against the source block)."),
    }),
    turnIn: z.string().default("").describe("Resident id, or empty to complete on the last objective."),
    requires: z.array(id).default([]),
    level: z.number().int().min(1),
    summary: z.string().min(1).describe("What the player does and learns. NOT final prose: directions and dialogue are written after placement."),
    objectives: z.array(objectiveSchema).min(1),
    rewards: z.object({ xp: z.number().int().min(0).default(0), coins: z.number().int().min(0).default(0), items: z.array(z.string()).default([]) }).default({ xp: 0, coins: 0, items: [] }),
    leads: z
      .array(
        z.object({
          kind: z.enum(["rumour", "lore", "sight"]).describe("rumour: a line a resident says; lore: text someone can read; sight: something seen at a place."),
          from: z.object({
            type: z.enum(["resident", "readable", "location", "entity"]).describe("resident: who says it; readable: a declared readable entity; location: where it is seen; entity: a declared presence or object."),
            ref: z.string().min(1),
          }),
          summary: z
            .string()
            .min(1)
            .describe(
              "One line: what the player learns. Names the place by its name ({place:id} allowed) and gives circumstances in words — when, " +
                "what was seen, who went there. Never a direction or distance ({dir:}, {far:}, a compass word) and never coordinates: a lead puts nothing on the compass or map.",
            ),
        }),
      )
      .default([])
      .describe("How a player FINDS a quest that no person offers: rumour, lore, a sight. A lead never starts the quest and never marks anything."),
  })
  .superRefine((q, ctx) => unique(q.objectives, (o) => o.id, ctx, "objectives"));
export type PlannedQuest = z.infer<typeof plannedQuestSchema>;

export const questGraphSchema = z
  .object({
    zone: z.string().min(1),
    arcs: z.array(z.object({ id, title: z.string().min(1), premise: z.string().min(1), quests: z.array(id).min(1) })).default([]),
    quests: z.array(plannedQuestSchema),
    locations: z.array(locationSchema),
    dungeons: z.array(dungeonConceptSchema).default([]),
    items: z
      .array(
        z.object({
          id,
          name: z.string().min(1),
          kind: z.enum(["key", "evidence", "delivery", "trophy"]),
          unique: z.boolean().default(false).describe("True would mean ONE exists in the shared world: refused, another player must never strand everyone else."),
          source: z
            .object({ type: z.enum(["creature", "location", "npc", "entity"]), ref: z.string().min(1) })
            .optional()
            .describe("Where a collected item comes from when no objective `grants` it: a creature that drops it, a location it lies at, an NPC or entity that hands it over."),
        }),
      )
      .default([]),
    entities: z
      .array(
        z.object({
          id,
          kind: z.enum(["presence", "object", "readable"]).describe("presence: someone only there while a condition holds; object: a thing that offers or takes; readable: text to read."),
          location: z.string().min(1).describe("Location id where it stands."),
          what: z.string().min(1).describe("What it is, in a few words (\"a drowned surveyor's ghost\", \"the tithe stone\")."),
        }),
      )
      .default([])
      .describe("Non-resident things a quest talks to, uses, reads or is offered by. Each becomes an entity the POI owner places."),
  })
  .superRefine((g, ctx) => {
    unique(g.quests, (q) => q.id, ctx, "quests");
    unique(g.locations, (l) => l.id, ctx, "locations");
    unique(g.dungeons, (d) => d.id, ctx, "dungeons");
    unique(g.items, (i) => i.id, ctx, "items");
  })
  .describe("The adventure's logic and everything it needs to exist. Many quests share a location and one arc spans several: do not mint a place per quest.");
export type QuestGraph = z.infer<typeof questGraphSchema>;

// -------------------------------------------------------------- reservations

export const reservationSchema = z.object({
  location: id.describe("Location id from the quest graph."),
  site: z.string().min(1).describe("The worldgen POI id or town id it takes, or \"new\" for ground chosen by survey."),
  center: xz,
  radius: z.number().positive().describe("Metres reserved for the place itself: footprint, combat space and terrain transitions, not just the building."),
  terrainRadius: z.number().min(0).default(0).describe("Metres inside which its owner may reshape terrain. 0 = none allowed."),
  approach: z.object({ from: z.string().min(1).describe("What it is reached from: a road/path/trail or river id, a town id, a recipe POI id, or another reservation's location id (for ground no road reaches)."), points: z.array(xz).default([]) }),
  approaches: z
    .array(z.object({ from: z.string().min(1), points: z.array(xz).default([]) }))
    .default([])
    .describe("Further ways in, beyond `approach`. Each must actually reach the reservation."),
  entrance: z.object({ position: z.tuple([z.number(), z.number(), z.number()]), yaw: z.number().default(0) }).optional(),
  interior: z.enum(["none", "embedded", "instanced"]).default("none").describe("embedded reserves the underground volume too; instanced only needs the entrance."),
});
export type Reservation = z.infer<typeof reservationSchema>;

export const reservationsSchema = z
  .object({ zone: z.string().min(1), reservations: z.array(reservationSchema) })
  .superRefine((r, ctx) => unique(r.reservations, (x) => x.location, ctx, "reservations"))
  .describe("Where every planned location goes on the real ground. After this is frozen, a builder owns its reservation and nothing outside it.");
export type Reservations = z.infer<typeof reservationsSchema>;

// ------------------------------------------------------------ asset manifest

export const ASSET_KINDS = [
  "mob-body", "mob-atlas", "mob-template", "dungeon-textures", "dungeon-key", "town-palette", "town-heightmap",
  "building-model", "gear-page", "item", "item-icon", "prop", "prop-texture", "audio", "concept", "entity", "outfit",
] as const;

export const assetManifestSchema = z
  .object({
    zone: z.string().min(1),
    rows: z.array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(ASSET_KINDS),
        for: z.string().min(1).describe("What needs it: a creature, rare, boss, dungeon, town, quest item."),
        status: z.enum(["have", "install", "request", "blocked"]).describe("have: exists on disk. install: exists but not under assets/ — a command copies it in. request: can be produced now. blocked: waits on a human or on another row."),
        by: z.enum(["gpt", "human", "elevenlabs", "procedural", "opus", "sonnet"]),
        how: z.string().default("").describe("The command or skill that produces it."),
        note: z.string().default(""),
      }),
    ),
  })
  .describe("Generated by `zonegen manifest`: everything the frozen plan needs that the library lacks. The art lane works this list while terrain and buildings are built.");
export type AssetManifest = z.infer<typeof assetManifestSchema>;

export const freezeSchema = z.object({
  zone: z.string().min(1),
  at: z.string().min(1),
  v: z.number().int().optional().describe("Digest version (lib.DIGEST_VERSION). Absent = whole-file hashes from an older zonegen: read as STALE until re-frozen."),
  hashes: z.record(z.string(), z.string()).describe("Planning digest (lib.digest) of each planning file when building began: its planning content only, never the layout fields the build stage writes. A differing digest makes every build stage STALE."),
});
export type Freeze = z.infer<typeof freezeSchema>;

/** The standard gate report every `zonegen <lint>` writes, so `status` can tell ok from STALE without re-running. */
export const gateReportSchema = z.object({
  stage: z.string().min(1),
  ok: z.boolean(),
  at: z.string().min(1),
  v: z.number().int().optional().describe("Digest version (lib.DIGEST_VERSION). Absent = inputs are whole-file sha256."),
  inputs: z.record(z.string(), z.string()).describe("Planning digest (lib.digest) of every file the gate read."),
  findings: z.array(z.object({ level: z.enum(["error", "warn"]), code: z.string(), message: z.string(), ref: z.string().default("") })),
});
export type GateReport = z.infer<typeof gateReportSchema>;

// ---------------------------------------------------------------- exploration (after the freeze)

export const explorationSchema = z
  .object({
    zone: z.string().min(1),
    locations: z.array(locationSchema).default([]).describe("Locations the exploration pass ADDS. Counted against the brief's budget.expansion."),
    reservations: z.array(reservationSchema).default([]).describe("Where each added location goes; one per added location."),
    quests: z.array(plannedQuestSchema).default([]).describe("Quests the exploration pass adds. A discovery quest may only use places that already exist in the frozen plan."),
  })
  .describe("zones/<zone>/exploration.json: what exploration adds after the freeze, kept OUT of the frozen quests.json so adding to it never stales the build.");
export type Exploration = z.infer<typeof explorationSchema>;
