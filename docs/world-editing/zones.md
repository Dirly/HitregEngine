# Zones (regions), by hand

You are cutting a live voxel world into the **zones players and servers know
by name** — "the valley between the two ridges", "the canyon country east of
the river" — by writing entries into the recipe's `regions`. A zone is a
named polygon on the map with a story and a hub. It is coarse (minutes to
cross), it is not a biome, and it is not one of the generator's climate
cells (`climate.zones` are the ~2 km landform cells the world rolls; a zone
usually spans several and may cut one in half). You decide where the lines
go, and you decide by looking at the map.

Read this whole file once. Then work through **Steps** with the commands.

**Where it sits in the pipeline:** `init → canyons → rivers → towns →
zones → paths → pois → trails`. `worldgen zones <world>` writes a FIRST
DRAFT (seeded from towns, borders settled on rivers and ridges by a cost
flood, placeholder names) and `worldgen all` runs it in that slot; the
steps below are how you turn the draft into zones a player would name.
After rivers or towns move, the zones are stale: fix the affected border by
hand, or `worldgen zones --force` to redraft (names are lost).

## Why the borders matter more than the names

Three systems read a zone:

- **Chat.** A "zone" line reaches everyone standing in the same zone, on
  every server copy of the world. A zone that is too small is a chat room
  with two people in it; one that is too big is global chat.
- **Servers.** A zone is the unit players are grouped by: everyone in the
  same zone is on the same server copy (up to a cap), and **crossing a zone
  border is a server swap**. A swap must never show two worlds, so a border
  has to lie where a player cannot see across it: a ridge line, a river
  centreline, a gorge rim, the coast. A straight line across open grass is a
  place where two players ten metres apart are on different servers and
  cannot see each other. Never draw one.
- **The story.** The AI dungeon master tells consequences per zone ("the
  boars of the Hollow Vale"), and the map shows your `story` as the zone's
  text. Write it for a player who has never been there.

## What you are writing

```json
{
  "id": "hollow-vale",
  "name": "The Hollow Vale",
  "story": "A long glacial valley between the Grey Teeth and the Saddle, farmed from Stonebrook down to the marsh where the Ashwater slows. The boar herds have been bolder since the mill burned; nobody will say who lit it.",
  "polygon": [[1200, -6600], [2400, -6900], [3300, -6100], [3100, -5200], [1900, -4900], [900, -5600]],
  "hub": [1727, -6238],
  "landmarks": ["town-1", "town-27", "river-a", "canyon-2"],
  "level": [1, 6],
  "tags": ["starter", "farmland"]
}
```

`id` is a stable slug (never rename one players have seen); `name` is what
they read; `polygon` is world metres `[x, z]`, any winding, no
self-crossing; `hub` is where an arriving player is placed and where the map
puts the label — a town centre inside the polygon; `landmarks` are the
feature ids you drew the border on and the places inside, so the next reader
knows why the line is where it is; `level` and `cap` are optional pitches
for the spawn tables and the cluster. Exact fields: the `regions` entry in
`spec.json` → `dataAssets.world-recipe`.

## How big, how many

- A zone should take **three to ten minutes to walk across** at the
  controller's run speed (about 6 m/s): roughly 1.5–4 km across, 2–12 km².
  Small enough that its players keep running into each other; big enough
  that its border is a real barrier. The draft aims at one zone per 6 km² of
  land (`worldgen zones --per-km2 4` for smaller, `--count N` to force).
  `worldgen regions` prints the area; under 0.5 km² is flagged.
- Every town belongs to exactly one zone. A town in no zone is a place with
  no chat and no server rule; a town claimed by two zones goes to whichever
  is first in the file. `worldgen regions` lists both cases.
- Every zone has at least one town — that is where its players gather and
  where its hub goes. A zone with none is scenery; fold it into a neighbour.
- A world of the demo's size (110 km² of land over four landmasses) is
  15–20 zones. Err small: the point is that the people in a valley keep
  meeting, and a zone nobody can cross in ten minutes is a zone nobody
  crosses.
- Water between landmasses needs no zone. Ocean is nobody's zone; the coast
  is a border.

## Steps

0. **Draft.** If `regions` is empty, `pnpm -F playground worldgen zones
   <world>` writes placeholder zones whose borders already sit on the
   barriers the cost flood found. Everything after this is checking and
   naming that draft; you rarely draw a polygon from nothing.
1. **Look at the world.** From `apps/playground`:
   `pnpm -F playground worldgen map <world> --size 1200` (the world at a
   glance: towns red, peaks yellow, rivers blue, canyons brown, paths tan)
   and `pnpm -F playground worldgen map <world> --zones` (climate cells
   coloured by kind — the landforms). Open both PNGs (the project root).
   Zoom into a candidate area with `--cx <x> --cz <z> --extent 1500`.
   Read `features.towns` (centres), `features.rivers` (points), the peak
   and falls entries in `features.pois`, and `features.canyons` from the
   recipe JSON — those coordinates are your border vertices.
2. **Find the barriers first, then the places.** Trace every ridge line
   (chains of `peak` pois, the mountain cells on the `--zones` map), every
   river centreline, every canyon rim and the coast. These are the only
   lines a border may follow. The land between barriers is a zone
   candidate; if it has a town, it is a zone.
3. **Name it.** The name comes from the landmark that defines it (a vale is
   named for its river or its ridges, canyon country for its rock). The
   `story` (two to five sentences: what the place is, why anyone goes, what
   is wrong there — the hook the dungeon master will pull on, not a travel
   brochure), `level`, and the POI and quest choices are a LATER pass, once
   the asset library exists; leave `story` empty today rather than invent
   one you will have to unwrite.
4. **Write the polygon.** Six to twenty vertices, each ON a barrier: a
   river point from `features.rivers[].points`, a peak position, a canyon
   rim point, a coast point (sample the coast with `worldgen profile
   --points "x,z;x,z"` — ground below the water level is sea). Where two
   zones share a river, both polygons use the SAME river points, so the
   border is the centreline on both sides. Set `hub` to the main town's
   centre. List `landmarks`.
5. **Check with data.** `pnpm -F playground worldgen regions <world>` —
   area, towns and POIs per zone, hubs outside their border, overlaps,
   unclaimed towns; exit 1 on findings. Fix until clean.
6. **Check with the picture.** `worldgen map <world>` again: zone borders
   are white, hubs are white rings, and the names print with their pixel
   position. Every white line should sit on a blue river, a yellow chain of
   peaks, a brown canyon or the coast. A white line over plain green is the
   mistake this whole file exists to prevent.
7. **Save the recipe whole and valid.** While `pnpm dev` runs the file
   live-syncs; regions change no terrain, so nothing re-cooks — chat and
   the map pick them up at once.

## What goes wrong

- **Borders on open ground.** See above. If two towns sit on a plain with
  no barrier between them, they are one zone. Do not invent a line.
- **Straddling a town.** A town centre exactly on a river you used as a
  border ends up in whichever zone is first in the file. Move the border to
  the far bank for that stretch, or claim the town explicitly by bulging the
  polygon around it.
- **Slivers.** Two adjacent polygons that trace the same river with
  different point subsets leave gaps and overlaps. Use the same points.
- **Renaming.** Chat, placement affinity and the dungeon master's memory
  key on `id`. Change `name` freely; never change `id` after players have
  seen the zone.
- **Zones as biomes.** A zone that is "the desert" because the climate
  cell is desert has a border on a climate blend, which is open ground.
  Zones are about barriers and places; biomes are the ground texture.

## The band, and spawn areas (hosting)

Since 2026-09-05 the cluster really does key placement by zone and moves a
player who walks past the **band** (20 m inside a zone their layer does
not host) to a copy of that zone — docs/hosting.md → "Zones". Two things
that makes true of your borders:

- nothing may be spawned within the band on either side. A layer warns at
  boot for every `spawnArea` whose reach (spread + leash + roam + band)
  crosses its zone's border, and `/admin/spawn-areas` on the layer lists
  them; move the area or the border;
- a crossing waits for the player to be out of combat and clear of packs
  on both sides, so a border over open ground is not a bug in the
  cluster's eyes — it is a place where two players a few metres apart can
  be on different copies and see nothing of each other. Ridges, rivers,
  the coast.

**Where a border has no barrier** (open ground after the draft), the plan is
not to move the line but to build one: `docs/world-editing/barriers.md` —
ridges written by a `barriers` stage, passes where paths cross, a
waystation sanctuary at each pass. Design only as of 2026-09-06; read it
before hand-fixing an open border.
