# Site standards (index)

Outdoor places (camps, ruins, caves, estates, shores). Each micro-domain is a skill tied to its tool:

| Topic | Skill | Tool / gate |
|---|---|---|
| size, idea, story, what a site is made of, entrances | `site-standards` | review-rubric Q/Z lines; `zonegen poi-brief` |
| choosing the site, density, empty land, dead-end paths, wall gaps | `site-finder` | `zonegen sites` (row `sites`) |
| height patches, lips, seated slabs, roads, vegetation, clearings, floating plants, holes | `terrain-edits` | `worldgen lips/seated/vegetation/scatter-float`, `voxel-blades` (row `terrain-lips`) |
| loose props by name | `site-dressing` | `site-sockets`, `dress check/review/apply` (row `site-dress <poi>`) |
| air and light of a place | `zone-mood` | `zone-mood.mjs lint/install` (row `mood`) |
| dungeon doors | `portals` | `portal-cover`, `portal-trip`, `portal-play` |
| creatures | `encounter-standards` | `zonegen populate`, `site-packs.json` |

The place schema's `size` classes are drafts; their numbers are OPEN (`README.md` "Not encoded yet").
