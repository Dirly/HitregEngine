# Brief: site {siteFor} ({siteRole}) in {zone} ({world})

You choose the ground for one place or dungeon entrance by what it must CARRY. The Wristgate (a 52 m carved front)
went on a 40 m gorge beside a 31 m falls (2026-10-29); an entrance is sited on a face that stands taller than its
front, with a plaza at its foot and a long sight line in front, not by type ("an entrance goes at a falls").

**Read**
- `{siting}/{siteFile}.json` (from `{zonegen} sites {flags} --role {siteRole}{siteForFlag} --propose`): the candidates
  (finder sites plus `foot-*`, the feet of the zone's tallest faces), each with `needs.results[]` — face height vs
  needed, apron m2, seen-from distance, the bearing the front faces — and a `shortfall` when none meets every need.
  Thresholds and overrides: `SITE_NEEDS` in `tools/site-needs.mts`; the place's own `archetype` / `siteNeeds` in `{brief}`.
- OPEN each candidate's `plan` and `far` pictures (`{siting}/plan-{zone}-{siteRole}-<id>.png`, `far-...`) for every candidate you consider: the far render is the
  bare terrain from the front at the read distance. Judge the rock, not the number alone.
- `{reservations}` and `{quests}` (the location, its approach) and the place's read and landmark in `{brief}`.
- A large or roadside place (`large-place`, `roadside-place`): its needs also read the places sited before it
  (`distance-from`, `on-route`, `landmark-visible` from a town) and a `subsite` result names WHERE the second point
  (the sump, the gate) was found: open the plan crop at that point too. A ref "not sited yet" means the order is wrong:
  report it, do not pick around it.

**Judge**
- The face carries the front with rock over its lintel; the apron holds the plaza and the stair; the approach sees the
  face before it arrives and the front faces that approach.
- Hostile places stay off town-to-town roads; the door has rock behind it along its facing.
- Shortfall: do not pick an unmet candidate. Report the ground need the shortfall printed (`cliff-face`, `minHeight`,
  `near`) for the coordinator to add to the recipe `needs` and solve with `worldgen needs`.

**Write** `{siting}/{zone}-pick.json`:
```
{ "from": "{siteFile}.json",
  "places": [ { "location": "<location id>", "candidate": "<id>", "why": "<one line: what in the ground carries it>" } ] }
```
(`radius` and `approach` only for a location with no reservation yet; a missed need is refused unless the coordinator
gives a dated ruling: `rulings: [{ "need": "rock-face", "ruling": "YYYY-MM-DD ..." }]`.)

**Gate** `{zonegen} reserve {flags} --pick {siting}/{zone}-pick.json` re-measures, centres the reservation (a dungeon
entrance's door at the face foot, facing the front), records the brief place's `site`, and must print
`reserve ({zone}): ok` (rule `site-need` fails a reservation whose ground misses a need).

**Do not touch** the recipe, terrain, scenes, the quest graph.
