---
name: site-finder
description: Choose where places go from the ground and its approaches with `zonegen sites` — canyon ends, cliffs over water, plateaus, peaks, passes, wall gaps, coves, falls, path dead-ends — plus its density, empty-land and dead-end-path gates. Use before writing a zone brief or reserve, when siting a town wall, when `sites` fails in `zonegen status`, or when a place feels randomly placed.
---

# site-finder

Source: `docs/zone-pipeline.md` "The site finder: places from the ground" (thresholds and errors) and
`docs/zone-creation.md` phase 1. Engine: `apps/playground/tools/zonegen/commands/_site-finder.mts` (thresholds live
there; test `test/site-finder.test.ts`). Run from `apps/playground`.

## When
First planning row of a zone, before the brief; again after `reserve`, after any road/path edit (the gate digest does
not cover road edits) and before `freeze` (which requires it).

## Commands
```
npx tsx tools/zonegen.mts sites <world> --project <p> --zone <z> [--focus x,z,r] [--out <dir>] [--no-map]
```
Read `zones/<z>/reports/sites.png` (candidates, wall lines, empty discs, path faults drawn) and
`sites-candidates.json` (ranked, each with its approach: road, distance, climb, metres of road that see it, first
seen from, facing bearing). Gate report: `sites.json`. `--out` = read-only look at a live world.
Record each place's pick in the brief as `places[].site`; the reserve lint refuses a reservation centred off it.

## Gates: failure -> fix
- `path-leads-nowhere` / `dead-end` (a path climbing >= 25 m to nothing; a hairpin run topping out at nothing) ->
  put a place at its top, or cut the path. A generated peak trail ending at a peak POI still needs a place.
- `wasted-climb` (warning: a route climbs a crest only to give it back) -> re-route, or put the place on the crest.
- `empty-landform` (a plateau/large flat landform with under a quarter near a place) -> a place on it, or declare it a
  deliberate hidden find.
- Empty disc over the limit / density under the floor (places per km2; radius >= 10 m counts, pinpoints do not) ->
  add places, small finds count. Target: something round every corner, no land far from anything.
- `off-site` (reserve) -> centre the reservation on the pick. A reservation circle is not a site; the pick is.
- `wall-gap` -> the town wall: one short heavy wall on the drawn line across the narrowest neck between cliff and
  water (or two cliffs). Open ground elsewhere is a choice, not a site.

## Judgment (not checks yet)
- The ground picks the site, not the story; the player's road drives location and layout; each place faces its approach.
- A door at the canyon end's back-wall foot facing the mouth; a perch on the cliff over the water.
- Major hostile places sit off town-to-town roads (a lookout over a road is fine). Encoded: `zonegen sites` / `reserve` `hostile-on-road` (location `overlooksRoad` allows a lookout).
- Islands in lakes are easy, strong places. Encoded: `zonegen sites` lists them as `island` candidates.
- A strong high or remote site with no way up gets an access device (lift, cliff stair, rope way, ladder, hoist). Encoded: `zonegen sites` `access` candidates + `access-device` warning.
- A premise's landmarks must stand on walkable ground before a story is written round them.
- Survey slope at the creature's footprint scale; a coarse slope map hides shelves.
- Sight-line a stated viewpoint against the natural ground (including beyond the radius) before the freeze.
- Measure what a place depends on before the freeze (a conduit's source level; a trail's grade-capped length).
- A dungeon door needs rock behind it along its facing, deep enough for its creatures' door height.
- Ranking is heuristic: rim perches on one cliff crowd the top; look at the picture, not only rank 1.
