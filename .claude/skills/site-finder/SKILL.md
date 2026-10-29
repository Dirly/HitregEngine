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

## Site needs: the ground must carry the idea (propose -> agent pick)
Sites are not picked BY TYPE (an entrance at a falls). Every role declares measured needs (`tools/site-needs.mts`
`SITE_NEEDS`; facts in the schema `.describe()`): grand-entrance = a rock face >= 1.1 x the front, a 1600 m2 apron, seen
from 300 m; dungeon-door = rock >= 1.5 x an 8 m door; walled-town = cliff flanks or water round the ring and one neck
(<= 260 m of wall) with no ground within 60 m over the wall top; harbour-town = the coastal rule; capital = open ways in.
A place sets `archetype` and `siteNeeds` overrides in the brief (the Wristgate: `{ "rock-face": { "frontHeight": 52 } }`).
```
npx tsx tools/zonegen.mts sites <world> --project <p> --zone <z> --role grand-entrance --for <place> --propose
npx tsx tools/zonegen.mts brief-for site-places <world> --project <p> --zone <z> --role grand-entrance --for <place>
npx tsx tools/zonegen.mts reserve <world> --project <p> --zone <z> --pick authoring/siting/<world>/<z>-pick.json
npx tsx tools/worldgen.mts towns <world> --project <p> --propose [--roles walled-town,harbour-town,capital]
npx tsx tools/zonegen.mts brief-for site-towns <world> --project <p>
npx tsx tools/worldgen.mts towns <world> --project <p> --pick authoring/siting/<world>/pick.json
```
`--propose` writes `authoring/siting/<world>/` (candidates with met / unmet per need and numbers, `plan-*.png`, bare
`far-*.png` from a probe port, default 5297). The PICK is a fresh agent's (the brief), never the score's rank 1.
Failures: `site-need` (reserve) -> re-site through propose/pick, or a dated `needRulings` entry from the coordinator;
`towns` row "<town> (<role>) <need>" -> `towns --propose` + `--pick`; a SHORTFALL (nothing meets) -> add the printed
entry to the recipe `needs` (cliff-face / walled-neck), run `worldgen needs <world>`, then propose again.

## Gates: failure -> fix
- `path-leads-nowhere` / `dead-end` (a path climbing >= 25 m to nothing; a hairpin run topping out at nothing) ->
  put a place at its top, or cut the path. A generated peak trail ending at a peak POI still needs a place.
- `wasted-climb` (warning: a route climbs a crest only to give it back) -> re-route, or put the place on the crest.
- `empty-landform` (a plateau/large flat landform with under a quarter near a place) -> a place on it, or declare it a
  deliberate hidden find.
- `empty-land` (an empty disc over the limit) -> add places; small finds count. Target: something round every
  corner, no land far from anything.
- `sparse` / `crowded` / `no-big-places` (density = the share of the zone's dry land that place footprints claim,
  by size tier: `AREA_CLAIM` in `_site-finder.mts`, not places per km2) -> grow or add medium/large places (the size
  tiers want fewer, bigger places); finds fill corners but never carry the share.
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
- A dungeon door needs rock behind it along its facing, deep enough for its creatures' door height. Encoded: `reserve`
  `site-need` (dungeon-door / grand-entrance rock-face).
- Ranking is heuristic: rim perches on one cliff crowd the top; look at the picture, not only rank 1.
- A big river or gorge wants a bridge where it splits two banks' roads/places. Encoded: `crossing` candidates (rim-to-rim
  gap 25-260 m between natural tops, bank height match, depth, view along the course, users on each bank, an existing
  road crossing noted); `detail.banks[]` gives each top (x, y, z), its nearest road and place.
- DC terrain (recipe `planarCliffs` / `seaCliffs` / `buttes`): the finder samples the drawn ground (`field.ground`) and adds
  `fall-lip`, `plunge-pool`, `sea-stack`, `stack-cluster` (2-4 stacks near the cliff, a bridge chain), `headland`,
  `butte-top`, `canyon-bend`. Stacks and butte tops are unreachable by design: their `access` candidate is the bridge,
  ferry or lift to plan.
