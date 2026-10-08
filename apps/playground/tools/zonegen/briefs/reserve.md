# Brief: reserve the ground for {zone} ({world})

Decide where every planned location goes on the real ground. After the freeze a builder owns its reservation and nothing outside it.

**Read**
- `{quests}`: `locations` (size, siteKinds, minTownDistance, hostile, needs) and `dungeons`.
- `{recipe}`: zone polygon, towns, roads, rivers, POIs (`features.pois`, `zone` = {zone}).
- The ground: `npx tsx tools/worldgen.mts map {world} --project {project} --cx <x> --cz <z> --extent <m>` writes a PNG of the area (water, paths, towns; no dev server) and prints its path; look at it before choosing a footprint. `tools/poi-review/SKILL.md` covers sizes and approaches.
- If `zonegen status` shows the terrain stage incomplete, reserve against the recipe's POIs and paths only, choose no `new` sites, and list every reservation as unverified on the ground in your report.
- `{zoneDir}/reports/sites-candidates.json` and `sites.png` (from `{zonegen} sites {flags}`): the land features and
  how the player arrives at each. A place whose brief entry records `site` is reserved ON that ground (the reserve
  lint refuses a centre outside the radius); name the road the finder found as its approach.
- `reservationSchema` in `{schemas}`.

**Write** `{reservations}`: one reservation per non-town location.

**Judgment**
- Prefer an existing POI of a fitting kind; `new` only where none fits, saying why.
- Name every real way in (`approach`, then `approaches`); each must reach the site; roadless ground is reached from another reservation or a recipe POI id.
- The radius covers place, fight and terrain transition.
- Embedded interiors reserve the rock beneath too; keep them apart.
- Do not reshape terrain unless the location needs it (`terrainRadius`).

**Gate** `{zonegen} reserve {flags}` must print `reserve ({zone}): ok`, then re-run `{zonegen} sites {flags}`: its
density, empty-land and climbing-path errors count the reservations and must clear before the freeze. It does not prove walkability: report which approaches you checked on the map.

**Do not touch** the recipe, terrain, scenes, the quest graph.
