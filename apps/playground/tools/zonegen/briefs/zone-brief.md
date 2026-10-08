# Brief: the zone brief for {zone} ({world})

You write the shared specification every later agent working on {zone} reads first.

**Read**
- `{cast}`: this zone's row (premise, faction, minor spill, level, palette, starter). It is decided; build on it.
- `{adjacency}`: this zone's towns (ids, tiers) and neighbours, and which borders have paths or passes.
- `{links}`: how its towns relate to towns elsewhere.
- The zone's region and POIs in `{recipe}` (POIs carry `zone`), and the map around it.
- `zoneBriefSchema` in `{schemas}`.

**Write** `{brief}` (`zonegen init` may have prefilled the towns, neighbours and level: keep those facts, fill the rest).

**Judgment**
- History explains the threat: what this place was, what changed, why the towns are still here.
- Each town has a reason to exist and a way to survive; wealth follows from it, not from tier.
- Traversal is what the ground really does: name the roads and passes, what blocks the way, what a detour costs.
- The budget is a promise the later lints hold you to. Fewer, denser places beat many thin ones; leave `expansion` for exploration finds.
- In a starter zone the hub is a modest town, never a capital.
- **Design the places before any quest** (`places`, `placeSchema`). The owner's test is whether a place feels
  hand-made and alive, never whether a quest works. Per place: what a passer-by sees in one line, the landmark and
  where it is seen from, the linked sub-sites, the set piece it is remembered for, the one thing no other place in
  the zone has, its mood (ground, plants, water, air), who holds it and who you meet there. Every landmark owns its
  own dungeon; every large place is several sub-sites round one landmark (the Barrens oasis: a lake and a cave
  system), never one camp. Read `docs/world-standards/sites.md` and `dungeons.md` first.
- Design for the creature even when its body is not built yet: a ratkin warren has spoil heaps, gnawed timber and
  tunnels sized for them; a giant's place has giant-scale furniture and doors. Bodies arrive later; places do not
  wait for them.
- **Pick the ground before writing a place.** `{zonegen} sites {flags}` lists the zone's land features (canyon ends,
  cliffs over water, plateaus, passes, the neck between a cliff and the shore, coves, falls, the tops of climbing
  paths, the largest empty land) with how the player arrives at each; open `{zoneDir}/reports/sites.png` and
  `sites-candidates.json` (`--focus x,z,r` draws one area close up). Each place starts from one or more of them and
  records the pick in `site` (kind, `at`, the way it faces its approach). Put the landmark where the road first sees
  it; put a door at the END of a canyon facing its mouth; put a town wall across the narrowest gap a road threads;
  every path that climbs must arrive at a place. Fill the empty land and the dead-end paths the finder lists before
  inventing ground of your own.
- Neighbouring zones' places are in their briefs: do not repeat their set pieces or landmarks.

**Gate** `{zonegen} brief {flags}` must print `brief ({zone}): ok`.

**Do not touch** the cast, the recipe, town plans, other zones, any scene.
