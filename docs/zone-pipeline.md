# The zone pipeline

How a zone (a named region with its towns, POIs, dungeons and quests) gets made
from a freshly generated world. The order is not written here: **it is a
command.**

```
npx tsx tools/zonegen.mts status <world> --project <p> [--zone <id>] [--next]     # from apps/playground
```

Every stage, procedural and agentic, in dependency order, as ok / STALE /
MISSING / FAILED with the reason, who does it, and the exact command or brief.
Run it before doing anything on a zone and do the row it names. A stage is
done when its GATE says so, never when an agent says so; a row reading
`no gate yet` means exactly that, and no report may claim it.

Formats are Zod schemas, so they are not repeated here:
`apps/playground/tools/zonegen/schemas.mts` (planning files) and, for props,
the `dressing` component and the `socket-map` / `dressing-set` /
`dressing-plan` data types in the engine spec.

## The rules the order encodes

- **Plan early, build late.** Relationships and requirements are linted data
  before anything is built: who lives in a town before its buildings, what a
  quest needs before its POI, why a dungeon exists before its rooms. Building
  starts only after `zonegen freeze`; editing a planning file afterwards turns
  the freeze and every build row STALE on purpose. The freeze and the gates
  hash planning content only (`digest` in `tools/zonegen/lib.mts`): a town
  plan's roster, relationships, services and building/structure ids, names and
  uses count, while its lots, terraces, setbacks, models, requests and lanes
  are layout the build writes; the recipe counts only for the zone's region,
  its towns' ids and tiers and its reserved POI sites.
- **Neighbours are decided once, for the whole map.** `cast.json` assigns each
  zone its main faction, wildlife, level band and palette in one pass over the
  adjacency graph, and its lint refuses two adjacent zones that share a faction
  or palette. A zone's bestiary is then picked WITH the neighbours' picks in
  hand. Never cast a zone alone: the result would depend on which zone ran
  first.
- **The bestiary catalogue is what the game supports.** Zones select from it;
  they never invent. A rare or a boss is a new texture theme on an existing
  body (art only). A new body needs a human, so it is surfaced at casting, the
  earliest point its need is known.
- **Ground moves before anything stands on it.** The optional `landforms`
  stage (an image generator draws a flat-colour KEY of landform classes; the
  tool computes the metres) runs before rivers. Generators are good at layout
  and bad at measurement: never feed a generated greyscale heightmap in raw.
  Re-running `worldgen canyons` wipes landform gorges and craters: re-apply.
- **A zone is an ecosystem with one story, not one faction.** The cast gives each zone one
  overarching story faction (the neighbour rules apply to it) plus several LOCAL groups: a bandit
  crew, a cult, a wolf pack, each flavoured for that zone. Most places belong to someone other
  than the story faction; the quest lint fails a zone where it holds more than half of the hostile
  places or fewer than three groups hold them. Human hostiles come from the human body and its
  outfits; a zone variant of a beast is a texture theme on an existing body.
- **Not a theme park.** Quests are assembled from the engine's registered quest blocks (the spec's
  `questBlocks`): sources other than an NPC, clock and weather conditions, reading, delivering,
  enduring, performing an action. The planner refuses a block the game cannot run and measures
  sameness by signature. A started quest is always in the journal; what is hidden is only where an
  off-the-path quest STARTS, found through leads (rumour, lore, something seen). A lead names a
  place and circumstances in words: it never uses direction or distance tokens and never touches
  the compass, which belongs to the objectives of a started quest.
- **Terrain is ground, not architecture.** Terrain shaping and painting are for the land itself and
  for roads, streets and paths. Anything built (a quay, dock or jetty, a harbour wall, a retaining
  wall, stairs, a bridge, salt pans with their bunds) is real geometry: a kit module or a
  Blender-to-DC structure standing on ground that was only levelled for it. A town key may mark
  where a structure goes; the ground stage reserves and levels the site, and never sculpts the
  structure out of the height field.
- **Many quests share a location.** The quest lint warns when locations are
  nearly one per quest. Exploration content may add at most the brief's
  `expansion` budget, which is what stops POI -> quest -> POI loops.
- **Quest text is written after placement**, when "beside the bridge" can
  name a real bridge. The plan carries a summary, not prose.

## Creatures, game systems and the quest loop

- **A fresh world's scene has no game in it.** `worldgen scene` writes terrain, sky and a player. The project's own
  systems (HUD, inventory, combat effects, the bridge from a mob's attack request to a real hit, sound) are listed
  once in `authoring/zonegen/scene-systems.json` and copied in by `zonegen systems`; the world row `systems`
  stays MISSING until they are there.
- **Creatures have ONE writer: `zonegen populate`.** It stands wildlife in its habitats, every group at the places
  it holds and the rares where they haunt, as level-tiered spawn templates tagged `creature:<id>`. A POI owner adds
  no spawn area or creature; its brief lists where populate already stood them. A place a quest sends the player to
  takes the level of the easiest quest acting there. Re-running populate is safe over its own installed batch.
- **An oversized creature is a `scale` in the zone bestiary** (a rare, a group member, a site pack's member or
  named; `3` = an enormous croc). Populate makes it its own template (`pop-<creature>-x3-l<level>`) and sizes
  everything measured in metres with it: collider and mesh, the brain's reach, body radius and eyes, the
  caster's ability volumes and telegraphs (`reach`), the clip speeds (so it lumbers instead of sliding). The
  server then sees it from further away (≈ 250 m × height / 2.6 m, up to 600 m) and places its pack beyond
  that, so players see it coming. Toughness is still its role and level: a team fight is `elite`/`boss`.
- **A mob body needs three scripts:** `mob-brain` asks to attack, `combat-caster` resolves the request,
  `combat-actor` takes the hit. Populate refuses a prefab missing one (`mob-unarmed`), and its proof fails when a
  pack cannot hurt a player who stands still.
- **A kill objective names a creature by tag** (`tag:creature:wolf`), so every level tier and theme counts. Bind
  writes that form whenever populate's templates exist.
- **Open country is not a POI.** A `wild` location is ready when its creatures are installed (row `wild <id>`);
  its scenery needs are exterior dressing.
- **After placement, in this order:** town-owned quest objects (the zone's `town-entities/install.mts`), then
  `zonegen items` (item assets the plan declares), `zonegen bind`, the text tasks, `zonegen wire` (points each
  placed quest entity at its written dialogue), `zonegen bind-check`, then `quest-play --quest a,b,c`.
- **quest-play proves logic, not balance.** It sets the clock through the day-night script and freezes it, buys a
  delivery item from the NPC that sells it, and on an endure step stands its ground and keeps the test body alive,
  printing a BALANCE NOTE with the health it had to restore.

## One master per layout, fresh workers, one writer

- A zone, a town, a POI and a dungeon each have ONE owner agent. It writes the
  plan and a short brief per worker; `zonegen brief-for <stage>` prints the
  brief with paths filled in, so every worker of a stage gets the same bounded
  contract. Workers are fresh agents, never forks.
- Workers build in private previews and return ops plus a manifest. Only the
  coordinating session installs into the shared world and scene files.
- A worker that cannot meet its brief reports the conflict. It never
  reinterprets the quest, moves a road, or edits outside its reservation.
- Deterministic steps get no agent. Fan out a few agents at a time and resume a
  stopped agent by id rather than restarting it.

## Props: declared once, placed by name

Engine-wide, not per world. Full intake rules: `docs/prop-cataloging.md`.

- A prop is a prefab whose root carries a `dressing` component: its ONE mount
  (floor, wall, ceiling, surface, slot, part), measured size, and the sockets
  it offers. A prop that can go two ways (a paper lying flat, the same paper
  pinned up) is two prefabs. Behaviour tweaks (a lit candle = art + flame +
  light) go in a wrapper prefab, because kit generators rewrite the art
  prefabs.
- A space has a measured socket map (`dress sockets`): free floor, walls with
  their uninterrupted spans, headroom, stairs and doorways. One map per
  building MODEL, reused wherever the model is.
  A `<model>.markers.json` beside the model turns its hearths, sconces,
  lanterns and chandeliers into anchors and each hearth clearance into 'H'
  keep-out cells, and `dress fixtures` puts the default lit prefab
  (`fixtures/hearth-fire`, ...) on every fixture anchor of a plan.
- A dressing plan names a prop and where it goes (a wall and a distance along
  it, a floor point, a ceiling point, a socket on another item). It never
  contains a transform. `dress check` resolves it and refuses what the prop's
  declaration does not allow; `dress apply` installs it as one ops batch with a
  saved inverse.
- **No agent reads a catalog.** `props menu --room <role> ...` is the only
  view a placing agent uses; a full record is hundreds of tokens per prop.
- **A plan says whose place it is**: `space: { kind: "dungeon" | "building" | "site", scale, cultures }`. The menu
  (`--plan`, or `--scale`/`--culture`) offers only that scale class and people (or `any`); the check refuses the
  rest. In a dungeon every room keeps its middle clear (one set piece excepted), walls and corners fill first, and
  walk lines keep a 0.4 m margin. Decals go on before props; `dress check --scene <s> --at x,y,z` reads the scene's
  decals and statues so no prop stands in a decal or overlaps placed geometry. `dress review` scores each room
  (wall share, centre clutter, scale/culture). Details: `docs/zone-creation-lessons.md` "Prop scale + placement rules".
- One fresh agent per building (`brief-for dress-building`), never one agent
  for a town.
- **Outdoor sites** (camps, ruins, cave mouths, shores) get the same treatment:
  `npx tsx tools/site-sockets.mts --project <p> --job <poi job dir> [--scene <s>]` measures the INSTALLED
  scene (read only) into one map per area, `authoring/dressing/sockets/<poi>-<area>.json`, in world
  coordinates (apply with `--at 0,0,0 --yaw 0`). Routes (+0.6 m), doorways, portal passages, quest spots and
  creature-pack clearings are kept-clear `x`; built things and slopes `#`; fires keep an `H` ring; tent and
  building sides and straight cliff edges are walls, so `prefer: wall` backs a prop onto them. Named pitches:
  `hearth-seat`, `spit-side`, `firewood-side`, `door-left/right`, `cave-inside`, `cave-flank`, `path-side`,
  `edge`, `water-edge`. Area roles: camp, yard, cave-mouth, path, shore, ruin. The owner (Opus) declares
  areas/anchors/keep-outs in `handoff.json` `siteDressing` (fields in the tool header; default: a 14 m camp
  per hearth); one fresh Sonnet per area dresses it (`brief-for dress-site --poi <id> --area <area>`), and
  the coordinator applies. Gate: `site-dress <poi>` in `zonegen status`.

## What a builder may generate

The catalogue comes first. A builder searches `props menu` and uses what exists; remaking a barrel, a tent or a
stand that the catalogue already has is the fastest way to lose consistency.

**Reuse first** (`docs/prop-cataloging.md`, "Reuse first"), in this order:

1. **Search**: `props menu --search <word>` ("do we have a barrel?"), `props menu --setting outdoor --room camp`
   (or ruin, yard, quay, street, plaza). Copy ids exactly as printed, folder included.
2. **Wrap** what exists but must be bigger, turned or re-seated: `props wrap <id> --id <coll/name> --scale/--yaw/
   --pitch/--roll`. Tents and tarp shelters are placed at 1.5 (`camp-props/tent`), stands at 1.25.
3. **Variant** for new art on the same mesh: `props variant <id> --id <coll/name> --art <png> [--part <entity>]`
   or `--material <id> [--triplanar <m per tile>]` (a hide roof on the lean-to, a silk-wrapped bone pile).
4. **Compose** props, models, primitives and alpha cards with a recipe: `props compose <recipe.json>` (the
   Silkroot Grove's egg clutch and web nest, a poachers' tanning rack with a hide).
5. **Only then** new site stonework or timber, of the kinds below; ruins start from `ruin-props/` (the DC stamp
   kit's columns, arches and walls, leaning and toppled as wrappers). Before cataloguing a new prefab run
   `props dupes <id>`: `DUPLICATE of <existing id>` means use that one.

- **May generate:** ruins (from the DC stamp kit's columns and pieces, deformed and broken, not plain boxes),
  wooden docks, shacks, rocks, bones through the DC tool (no skulls), and flat art from the image generator: a hide
  on a tanning rack, carvings, banners, decals of dragged reeds or mud.
- **Never generates:** animals or any wildlife, plants, grass or reeds, or anything the catalogue has.
- **Land is site material.** Caves, mines, dens and mountain paths are cut with the voxel tools, sized from one
  town-kit grid cell (3.2 m) as the smallest clear width, height and depth.
- **A site reads at a glance.** One line says what a passer-by sees ("illegal hunters with hides on tanning
  racks"), and the build is that. A place is sized like a landmark of the map, with several linked features, not
  a single camp or ruin.
- **A dungeon entrance is a landmark:** large set pieces, obvious from a distance, with generated carving and
  decals. Everything built is checked from the sides, the top and inside for see-through faces.
- **Not every town has a wall.** A wall is added where the setting calls for one, as real geometry with gates
  where the roads arrive.

## One art style

Pixels of two sizes side by side read as two art styles. Everything a site or town builder makes is drawn at the
project's texel standard (`texelDensity` in `authoring/prop-catalogs.json`: 128 px across 3.2 m, nearest filtering).
Stone, masonry and wood on anything built use the town's own role tiles (`detailRoles` there), cropped to a tiling
texture when they must repeat. `props status` reports a large surface (25 m2 or more) drawn finer than 1.2x the
target as HIGH, and anything below the minimum as LOW. Small hand-made props are finer on purpose and are not judged.
Every site's evidence includes one picture of its work beside a town wall or the terrain at player distance.

## The review map: where everything is

```
npx tsx tools/zonegen.mts map <world> --project <p> [--zone <id>] [--dev] [--sites] [--scene <id>] [--base]
```

renders the map's layers — ALL of them, unlike a player's map, which shows only
terrain, zones, roads, towns and the player's own markers — (zones, roads,
towns by name, named places, dungeon entrances, quest givers; `--dev` adds spawn areas by level and
radius, packs and placed creatures, reservations with their radii) to a
labelled PNG with a legend: `zones/<zone>/reports/map[-dev].png`, or the
world's `reports/` folder without `--zone`, plus a `.json` beside it
listing every mark in view with its coordinates. It is the same drawing code
the game runs on **M** (headless Chrome); the places, dungeons, quest givers
and dev data it adds are what the editor's **D** shows, never a player. A reviewer of a site, a pack plan
or a whole zone opens `map-dev.png` first: spawns on a road or in a town,
packs nobody passes, a reservation overlapping another, a dungeon entrance
far from any path all show at a glance. It also refreshes
`assets/maps/<world>.layers.json` for the in-game map, and draws the terrain
picture (`worldgen map <world> --base`, about 90 s) when it is missing or
with `--base` after the terrain changed.

## The site finder: places from the ground

```
npx tsx tools/zonegen.mts sites <world> --project <p> --zone <z> [--focus x,z,r] [--out <dir>] [--no-map]
```

runs before the zone brief (the first planning row of `zonegen status`). It samples the world field on an 8 m grid
and finds what a designer circles on a height map: canyon ends (with the back-wall foot where a door goes, facing the
mouth), cliffs over water with a standable perch, plateaus and mesas, peaks, passes, the narrowest neck between a
cliff and water a road threads (a town wall: one short heavy wall, the line is drawn), coves, waterfalls, path
dead-ends and switchback tops, and the largest empty land. Every candidate carries its approach — nearest road or
path, distance, climb from it, metres of road from which an 8 m landmark there is seen, where it is first seen, the
bearing it should face — and whether a place already stands on it. Writes `zones/<z>/reports/sites-candidates.json`
(ranked) and `sites.png` (the review map with the candidates, wall lines, empty discs and path faults drawn); the
gate report is `sites.json`. Errors: a path that climbs 25 m or more and stops at nothing, a hairpin run that tops out
at nothing (a pass only warns), a plateau or large flat landform with under a quarter of it near a place, the
largest empty disc of land over 450 m, fewer than 4 places (towns + reservations of 20 m or more) per km2 of land.
Warnings: a route that climbs a crest only to give the height back, unused strong candidates. `--out` writes every
file elsewhere (a read-only look at a live world). The brief records each place's pick in `places[].site`; the
reserve lint refuses a reservation centred off it. The engine is `tools/zonegen/commands/_site-finder.mts` (no I/O;
`test/site-finder.test.ts`).

## Gates that prove rather than assert

- `quest-play.mts` plays every quest through the real server systems. Logic
  mode teleports; `--walk` starts at each objective and walks BACK until it
  joins a known road or enters a town, which is the leg nothing else proves
  (roads and streets belong to the town-walk gate). A report row says
  `proven` or `simulated`; simulated is not a pass.
- `town-walk.mts`, `dress check`, `props status`, the POI creator's
  `progress.json` and a dungeon's own `pipeline.mjs` are the evidence the
  status rows read.

## Zone ground: a palette's tiles, applied by one command

A zone's ground look belongs to its cast `palette`, not to the zone: the tiles live in
`authoring/zonegen/palettes/<palette>.json` (`groundPaletteSchema`: ground role -> texture, roles `grass`,
`ground`, `cliff`, `road`, `paving`, `accent`), so towns of one culture share their cobble and a look is never
planning (the freeze hashes cast.json whole, so the look stays out of it). Draw the tiles with
`image-request.mjs gen-set`, at the base ground tiles' pixel size, with two of them as `ref`. Then
`worldgen zone-textures <world> --project <p> [--zone <id>]` registers them and sets `regions[].ground`;
`worldgen status` row `zone-textures` is MISSING until every cast zone with a look carries it, the terrain
material matches, and the zone's town streets are `role: "paving"` (`town-ground paving --town <t>`; a fresh
`town-ground build` writes the role itself). Borders blend over `zoneGround.band` (150 m). Mechanics:
`docs/voxel-worlds.md`, "Zone ground".

## Known gaps (status shows them as `no gate yet`)

Exterior dressing of streets and plazas (except their lanterns: row `town <name>: lights`, below; outdoor POI sites have row `site-dress <poi>`), static bake, exploration fill, the
zone audit against neighbours, and a report from the quest content check.
The town exporter writes merged district models; a socket map per building
type needs one model per building. `dress sockets --check-steps` measures door and stair
steps against the player controller; today's kit stairs fail it. Proposals awaiting a decision
live in `docs/proposals/`.

## Sites outside the quest plan: creatures, lights, portals

Three small rules that large sites (an estate, a cave system, a shore camp, an instanced dungeon) all follow.

**Creatures at a site the plan never reserved.** `zonegen populate` fills the wilderness and the places the quest plan
reserved. A site added afterwards hands over its clearings (8 m, dry, standable) and the coordinator lists who stands
there in `zones/<zone>/site-packs.json`: per pack the site, the spot (`at`, plus `y` when it is underground), faction,
level, members (`creature`, `theme`, `role`, `count`) and an optional `named` creature that leads it. Populate places
them as written (step 3b), before wildlife, so wildlife keeps its distance. An area whose `y` is well under the open
ground is a cave area: the server spawns it on the cave floor (`terrain.groundNear`), not on the mountain above. A
large site is not finished until it is populated, and it carries named creatures to farm: one near its edge, more
further in.

**Every street and the roads out of a town are lit.** `npx tsx tools/town-lights.mts apply --project <p> --town <t>`
places catalogued lanterns from the town's own data (streets, lanes, plazas, gates, quays, roads out, junctions,
bridge ends) by the numbers in `tools/street-lights.json`, installs them as one ops batch and runs its check; the row
`town <t>: lights` reads the report and comes before `walk` (lanterns are solid). Standard:
`docs/world-standards/towns.md`.

**One place, one bucket of lights.** `apps/playground/tools/light-buckets.json` lists the buckets (tomb, manor, delve,
camp, street) and the fixtures in each. A dressing plan names its bucket (`"lights": "tomb"`); `dress check` prints a
`LIGHTS:` line when a plan uses a fixture from outside it, or when its lights fit no single bucket. Several kinds from
one bucket are wanted; a fixture from another bucket is what reads wrong.

**Every walk-through portal shows the swirl.** After a portal is installed or a scene is rebuilt, run
`npx tsx tools/portal-veil.mts --project <p> --scene <id>`: it hangs the shared blue instance-boundary veil
(`hollow-bastion/zone-boundary`) in each `portal` in mode `trigger`, on both sides of the trip. The default veil stands
on the trigger box and is 25% larger than its opening, so the passage walls cut it to size; a doorway that is not a
plain passage (a door recess, a stair) states its veil in `<project>/authoring/portal-veils.json`. A landmark site gets
its own dungeon: do not point a second site's door at an existing instance.

**Every walk-through portal covers its opening.** `npx tsx tools/portal-cover.mts --scene <id> [--portal <ids>]` measures
the opening from the server's colliders and voxel ground (width at each height, height, the narrowest section along the
passage) and checks that no body can step past, under or over the trigger box and that no part of the visible opening
shows past the veil. `--fit` sizes both from the rock, writes them to `portal-veils.json` (kept through rebuilds) and to
the scene as one ops batch with its inverse (`--undo <inverse>` takes it back). Gates: row `portals` in `zonegen status`
(the world side), stage `portals` in a dungeon pipeline (the return side); `portal-trip` runs it on both doors first.

**A player gets in AND out, in a real client.** `npx tsx tools/portal-play.mts --dungeon <instance>` (Playwright + system
Chrome on the dev app, local play, the body walked with W) walks in through the world door, back out through the return
portal, then reloads inside the instance and walks straight out. It is the LAST stage of a dungeon pipeline
(`portal play`) and the `portal play` row of `zonegen status` (STALE when either door changes). The headless `portal-trip`
does not replace it: it waits out the arrival grace, a player does not.

## Site dressing tool

- Built 2026-10-05 (`tools/site-sockets.mts`, `@hitreg/core` `buildSiteSocketMap`). One map per area keeps each
  grid small and lets a level carry a `ground` raster (0.05 m steps): outdoor floor props stand on the terrain
  under their centre, not on one floor height. Outdoor anchors on such a grid count in their room and collide
  like any floor prop.
- Inside caves the field height is the roof, so a cave interior area measures as all slope: dress a cave from a
  `cave-mouth` area outside the lip, or measure the interior with a DC socket map.
- Pack clearings take a large share of a yard (8 m discs as `x`); size areas past them, not around them.
