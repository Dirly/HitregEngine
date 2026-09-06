---
name: zone-setup
description: Cut a voxel world into named zones (recipe `regions`) — draft them with `worldgen zones`, then fix the borders onto ridges/rivers/canyons/coast and name each one from its landmarks. Use when a world has towns but no zones, when `worldgen regions` reports unclaimed towns or overlaps, or when zones need redrawing after rivers or towns moved. Today: placement and names only — story, POIs and quests are a later pass.
---

# Zone setup

The full procedure is the tool-neutral playbook **docs/world-editing/zones.md**
— read it now, then follow its Steps. This skill is the order of operations
and what not to skip.

## Where it sits in the pipeline

`init → canyons → rivers → towns → **zones** → paths → pois → trails`.
Zones are seeded from towns and their borders follow rivers, so they come
after both; `worldgen all` runs the draft in that slot. **After rivers or
towns change, redraft or fix the zones** (`worldgen zones <world> --force`
throws the names away — prefer moving vertices by hand when only one border
is stale).

## The order of operations

1. `pnpm -F playground worldgen zones <world>` — the draft. Farthest-apart
   towns seed it; every land cell goes to the seed that is cheapest to reach
   with rivers tolled and ridges expensive, so the fronts already sit on the
   barriers. It writes `regions` with placeholder names ("Zone 3") and
   prints the audit. The default is about one zone per 6 km² of land;
   `--per-km2 4` draws smaller ones, `--count N` forces a number. Err
   small — a zone's players should keep meeting.
2. `pnpm -F playground worldgen map <world> --size 1200` — look. Zone
   borders are white, hubs white rings, names in capitals. Every white line
   should sit on blue (river), yellow (peaks), brown (canyon) or the coast.
   A white line over plain ground is the thing to fix: move those vertices
   onto the nearest barrier (river points from `features.rivers[].points`,
   peak positions from `features.pois`), or merge the two zones.
3. **Name each zone** from the landmark that defines it (the playbook's
   rule), keep the `id` the draft gave it unless it is brand new, set
   `landmarks` to what the border follows, and drop the `draft` tag.
4. `pnpm -F playground worldgen regions <world>` — must exit 0: sensible
   area, a town in every zone, hubs inside, no overlaps, no unclaimed towns.
5. `worldgen map` once more, and report: name, id, km², towns, and the
   landmark each border follows — plus anything you could not place
   cleanly, with coordinates, for a human to decide.

## Do not

- Draw a border across open ground because two towns "feel" separate.
- Invent `story`, `level`, POIs or quests now — that pass waits for the
  asset library. Leave `story` empty.
- Rename an `id` players may have seen. Names are free; ids are forever.
- Leave the recipe half-written. Write the whole file, valid JSON.
