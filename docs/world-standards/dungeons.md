# Dungeon standards (index)

| Topic | Skill | Tool / gate |
|---|---|---|
| how many, size, plan shape, room sheets, set pieces, creatures, known limits | `dungeon-standards` | review-rubric; `compare` gate |
| room kit, stairs, role noise, shaped volumes, pipeline stages, every quality gate, exceptions | `dungeon-build` | `tools/dungeon-pipeline` (README), `tools/dungeon-room-kit`, `tools/mesh-dc` |
| readability floor, matte, interior culling, light buckets | `dungeon-lighting` | `lighting.json` / `lighting.mts`; `readability`, `matte`, `culling` gates |
| world door, return portal, veil, cover, trips, loading art | `portals` | `portal-*`, `loading-art` |
| props in rooms | `interior-standards`, `prop-intake` | `dress`, `props` |

Workflow: `hitreg-dungeon-authoring`. Open values: `README.md` "Not encoded yet".

## Quality recipe
The gates and their numbers are `tools/dungeon-pipeline/README.md` and `thresholds.json` (never edited for one
dungeon; a justified miss goes in the dungeon's `authoring/quality-exceptions.json` with a `why`). The measured recipe
and per-dungeon fix lists: `apps/playground/projects/voxel-demo/authoring/reports/dungeon-quality-recipe.md`.
The readability floor (the dim hemisphere fill every dungeon shares) is `dungeon-lighting`.

Role-noise defaults for a project's `authoring/noise.json` (docs/blender-dc-authoring.md "DC role noise"; amount =
peak relief, `grow` on). Natural walls and ceilings ROUGH; built masonry, timber, trim and stairs CRISP:

| Key / role | amount (m) | scale (m) | octaves |
|---|---|---|---|
| raw rock walls of natural spaces (`rock-wall`; untagged basalt in built rooms stays crisp) | 0.25-0.40 | 1.6-2.4 | 3 |
| cave ceilings (`rock-roof`) | 0.35-0.55 | 2.0-3.0 | 3 |
| low burrow / tunnel roofs (`burrow-roof`) | 0.25-0.30 | 2.0-2.4 | 3 |
| ice walls | 0.15-0.25 | 3.0-4.0 | 2 |
| coursed-stone used as rubble | 0.08-0.12 | 1.2 | 2 |
| earth floors of NATURAL spaces only (`earth-floor`, `floor: true`) | <= 0.06; keep `null` while dressing (5 cm bumps read as stair cells) | 2.0 | 2 |
| flagstone, ashlar, dressed-trim, brick, smooth-stone, metal, wood, lichen, treads (`tread`), built floors | crisp (`null`) | - | - |

Walk lanes and doorways are protected, and every noised wall/roof role keeps the default floor band (no noise from
0.2 m under to 0.6 m over each floor). Rerun walk/doorway gates and the dress maps after any table change.
