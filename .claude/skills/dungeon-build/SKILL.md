---
name: dungeon-build
description: Build an instanced dungeon's geometry and pass every quality gate — the dungeon room kit (rooms, doorways, stair passages with raked ceilings), mesh-dc role noise with the floor band and shaped natural volumes, the shared tools/dungeon-pipeline stages (noise, originality, stairs, atlas, matte, recipe, culling, readability, compare, portals, portal play) and the quality-exceptions file. Use when building, porting or fixing a dungeon, when its pipeline shows FAILED/STALE, or when a gate number seems wrong.
---

# dungeon-build

Sources (tool-neutral, read the section you need): `tools/dungeon-pipeline/README.md` (stages, every gate's exact
test, exceptions, porting), `tools/dungeon-room-kit/README.md` (room JSON, stairs, limits), `tools/mesh-dc/README.md`
+ `docs/blender-dc-authoring.md` ("The stages", "DC role noise", "Stair ceilings"), `docs/dungeon-materials.md`.
Workflow skill: `hitreg-dungeon-authoring`. Design rules: `dungeon-standards`. Light: `dungeon-lighting`.
Doors: `portals`.

## Commands
```
node authoring/pipeline.mjs [--next] [--json]                     # from projects/<id>: ok|STALE|FAILED|MISSING per stage
node ../../../../tools/dungeon-pipeline/quality.mjs <gate|all> [--build] [--print]   # run gates
node ../../../../tools/dungeon-pipeline/quality.mjs <gate> --dry --metrics          # measure WITHOUT writing reports
node tools/dungeon-room-kit/roomkit.mjs all <rooms.json> [--voxel .12]               # engine root: build+noise+bake
node tools/dungeon-room-kit/roomkit.mjs counts <source-audit.json>                   # detail as the recipe gate counts
```
Order: plan, export, noise, originality, dc-bake, import, merged bake, split-floor, stairs, materials, atlas, matte,
dress maps, scene, portals, lighting, recipe, culling, walk, fight, views, readability, compare, loading art,
portal play. A FAILED gate blocks `--next` and shows on the dungeon's `zonegen status` row.

## Gates: failure -> fix (numbers: `thresholds.json`, never edited for one dungeon)
- `noise`: no `authoring/noise.json`, stamp not embedding it, < 90% natural triangles noised, flat-slab roofs, box
  `rock` lumps -> write the role table (defaults in `docs/blender-dc-authoring.md` "DC role noise"), re-export; replace
  flat roofs with shaped volumes (`shapes_blender.py`: domes, lofted tunnels). Noise on a flat slab still reads as a slab.
- `originality`: a builder function / > 60% of a builder file shared with another dungeon -> write your own set-piece
  builders; shared primitives (listed in thresholds) and the room kit are fine. The copy fails, not the original.
- `stairs`: clear < 2.6 m above the nosing, clear band too wide, stepped roof, floor missing -> room kit
  `"kind": "stair"` with `ceiling` barrel/segmental/pointed/raked (natural: lofted tunnel); never a flat slab over a flight.
- `atlas`: > 1 page, tint shifts hue or darkens, a tile outside its family band -> ONE atlas per dungeon; one stone
  colouring, one wood tone, one metal tone; variety from pattern, wear and light, never hue.
- `matte`: roughness < 0.9 (metal < 0.6) or metalness on a non-metal -> fix the project's `materials.mjs` layers.
- `recipe`: per room built detail, props/kinds, bones, 2-5 visible light sources, decals, set piece; per passage
  bones and unlit runs; dungeon-wide prop kinds, decal textures, ambient, sourceless lights, prefabs outside a plan ->
  room kit for detail; dressing plans for props/decals; `room-sheet.json` `setPieceObjects` names a set piece the
  counter misses; a long passage meant dark says "unlit" in the plan.
- `culling`: a room's dressing appears > 2 m after entering -> the scene `cullingProfile` (lighting stage writes it).
- `readability` / `compare`: see `dungeon-lighting`; `compare --build` makes the side-by-side sheet; a person judges it.
- Real-body `walk` / `fight` / follow-sim fail -> clearance is soffit minus the floor UNDER each sample, 2.6 m
  everywhere across the width; enter doorways on their axis.

## Exceptions
`authoring/quality-exceptions.json`: `{ gate, check, space, why }` (why >= 8 chars or ignored). For justified misses
only (a tomb over the bone cap, an intended ice shine, a passage lit only by the swirl).

## Judgment
- Natural rooms ROUGH (rock walls, cave roofs), built work CRISP (masonry, trim, treads, built floors); keep
  `earth-floor` noise null while dressing (5 cm bumps read as stair cells). Rerun walk/doorway/dress maps after any table change.
- Arched doors are measured at the jambs: the kit refuses springing below 2.6 m; prefer segmental heads.
- Passages join the group of the room they leave; their ends are `openSides`.
- Walk the route with the real body right after the first bake, before dressing.
- The merged bake ships; volumes stay as the editable source. Never verify with a raised browser heap.
- Frames fit the noised opening, overlapping into the rock; never floating proud on the old outline.
- Scale to the creature: giant halls take a coarser voxel; ramps (<= 20 %) where risers would hit the autostep limit.
- No stacked fight floors (combat finds ground with a ray straight down): storeys side by side, joined by stairs.
- Noised caves have no straight wall spans: wall-backed props cannot go there; light them with posted lights.

- Arrival safe zone: no pack, patrol point, named, miniboss or boss within 25 m (walked) of any entry-*/exit-* anchor, so a player is never pinned at the door by the fight lock. Encoded: `arrival` gate in tools/dungeon-pipeline (thresholds.json).
