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

Placement quality and self-review: [the Weeping Sun lessons](../dungeon-standards/references/placement-review.md).
The current recipe still has legacy minimum prop/type and built-piece counts. They are not placement targets:
review purposeful sparse dressing and use scoped, justified exceptions for those count failures. Decals are
optional. Keep contact, traversal, material, lighting and encounter failures actionable. Shared replacement checks
are proposed in that reference; they are not implemented merely by adding the notes.

Boss arenas: use the reusable `boss-gate` builtin documented in
`tools/dungeon-pipeline/README.md` → "Reusable boss arena gates". Entrance gates
close on actual boss aggro, not room entry; side/progression gates and the
entrance open on the same stable boss actor's defeat. Include non-aggro entry,
each boss alternative, wipe/evade recovery, late joins and physical clearance
in the gameplay proof. Parameter truth remains in the generated spec.

## Commands
```
node authoring/pipeline.mjs [--next] [--json]                     # from projects/<id>: ok|STALE|FAILED|MISSING per stage
node ../../../../tools/dungeon-pipeline/quality.mjs <gate|all> [--build] [--print]   # run gates
node ../../../../tools/dungeon-pipeline/quality.mjs <gate> --dry --metrics          # measure WITHOUT writing reports
node tools/dungeon-room-kit/roomkit.mjs all <rooms.json> [--voxel .12]               # engine root: build+noise+bake
node tools/dungeon-room-kit/roomkit.mjs counts <source-audit.json>                   # detail as the recipe gate counts
```
Order: plan, export, noise, originality, thin-walls, dc-bake, import, merged bake, split-floor, stairs, materials, atlas, matte,
dress maps, scene, portals, lighting, recipe, culling, walk, fight, views, readability, compare, loading art,
portal play. A FAILED gate blocks `--next` and shows on the dungeon's `zonegen status` row.

## Gates: failure -> fix (numbers: `thresholds.json`, never edited for one dungeon)
- `scale` (before export, `tools/dungeon-pipeline/concept-scale.mjs`): a painted room built off its painting by more than ±15% (column height, span, ceiling, door) -> resize the plan/kit to `authoring/concept-sizes.json`. Measure each painting with its figure as a 1.8 m ruler (`authoring/concept/<painting>.marks.json`), LOOK at the overlays, and shoot compare frames with the person in the grey box (`paintingCamera` + spot `figure`), never a capsule.
- `thin-walls` (pre-bake, `tools/mesh-dc/thin-walls.mjs <stamp> --plan authoring/plan.json`): a SHELL wall (one side looks out of the map) under 3 DC voxels -> the bake perforates it; thicken the source (room kit: `MIN_SHELL_VOXELS`, barrel lunettes closed, `JOINT_VOXELS` lap at open sides) or bake finer. Planks/hulls/decals/flat-art are exempt by name or `dc_thin_ok`; never exempt a shell.
- `noise`: no `authoring/noise.json`, stamp not embedding it, < 90% natural triangles noised, flat-slab roofs, box
  `rock` lumps -> write the role table (defaults in `docs/blender-dc-authoring.md` "DC role noise"), re-export; replace
  flat roofs with shaped volumes (`shapes_blender.py`: domes, lofted tunnels). Noise on a flat slab still reads as a slab.
- `originality`: a builder function / > 60% of a builder file shared with another dungeon -> write your own set-piece
  builders; shared primitives (listed in thresholds) and the room kit are fine. The copy fails, not the original.
- `stairs`: clear < 2.6 m above the nosing, clear band too wide, stepped roof, floor missing -> room kit
  `"kind": "stair"` with `ceiling` barrel/segmental/pointed/raked (natural: lofted tunnel); never a flat slab over a flight.
- `atlas`: > 1 page, tint shifts hue or darkens, a tile outside its family band -> ONE atlas per dungeon; one stone
  colouring, one wood tone, one metal tone; variety from pattern, wear and light, never hue. Banded two-tone stone
  declares ONE accent in plan.json `atlas.accent` {roles, hue, maxSat} (never exceptions).
- `matte`: roughness < 0.9 (metal < 0.6) or metalness on a non-metal -> fix the project's `materials.mjs` layers.
- `recipe`: per room built detail, props/kinds, bones, 2-5 visible light sources, decals, set piece; per passage
  bones and unlit runs; dungeon-wide prop kinds, decal textures, ambient, sourceless lights, prefabs outside a plan ->
  room kit for detail; dressing plans for props/decals; `room-sheet.json` `setPieceObjects` names a set piece the
  counter misses; a long passage meant dark says "unlit" in the plan.
- `decals` (optional, owner 2026-10-13): a decal texture that another dungeon uses (same file, byte copy, perceptual
  near copy), one decal > 40% of them, or a decal missing from `authoring/decals/set.json` -> make this dungeon's own
  set from its concept frames: that file is an `image-request.mjs gen-set` manifest (ids `<project>-decal-*`, `ref` =
  a concept frame, alpha); `gen-set --manifest projects/<id>/authoring/decals/set.json`.
- `flat-art`: a slab picture (door relief, plaque) upside down or mirrored -> `tools/flat-art.mts check <id> --fix`
  (engine material maps load flipY: a slab stores v = 1 - row; from Blender write bpy v = row).
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
- Water is ONE still level at the bottom (owner 2026-10-25): one surface height, no dry floor under it, nothing moving (no falls, cascades, curtains, channels; a fall is mist/vfx). The `water` gate's three checks cannot be excepted.
- Water fills to its walls: author a pool/channel as a rough rect at its level, then `tools/water-edges.mts scene <id> --fix` re-cuts it to the walls and puts a dark card / drain where it really goes on; the `water-edges` stage must pass (no edge in open air).
- No holes you can see through the map: the `see-through` stage (`tools/see-through.mts scene <id> --batch k/3`) draws the shipped scene with a magenta sentinel from eye height along the walk route and must pass; a hole's cause comes with it (thin DC shell: thicken the source wall to >= 3 voxels, `tools/mesh-dc/thin-walls.mjs` finds them before the bake; seam: overlap the groups; single-sided: close or double-side; culled: raise `cullingProfile.interiorReveal`). Real openings go in `authoring/see-through-openings.json` (docs/see-through.md).
- No faces seen from BEHIND (inverted normals, missing closing faces): `tools/backfaces.mts <project> --eyes <floor grid>` casts rays from a grid over every room and names each piece and local triangle that shows its back; see-through misses these wherever another wall stands behind the culled face. A hand-built mesh kit runs it as a pipeline stage (weeping-sun-tombs: `authoring/eyes.mjs` + an `insert` after zfight). Double-sided materials are skipped.
- No floor sheet hung over water: a walk floor (ledge, island, landing, platform) whose side stands over a pool needs a face under that side down into the basin, and the decks meeting it must touch it with no gap. See-through and backfaces miss this because the water fills the view below. weeping-sun-tombs gates it with `authoring/mesh-gates.mjs edges` and closes the sides with the kit's `ledge-edge` run.
- No floor you can fall through: `tools/fall-holes.mts <project> --eyes <floor grid>` floods the drawn floors a body can reach (floor grid, walk route, climbing out of the pools; walls block, wall cavities excluded) and fails every reached floor with no collider under it (FALL) and lists decor drawn without one (ghost: a plinth, a parapet, a sill). Natural rock (caverns) needs a mesh collider, not a box at its foot.
- A placed point light with no flame of its own (fill, face, rim, stall, lava stand-in) sets `glow: 0`: its default halo hangs as a floating orange ball in mid-air. Dressing hugs corners and walls, the floor stays clear; candles at statue feet, not a brazier at every spot.
- Scale to the creature: giant halls take a coarser voxel; ramps (<= 20 %) where risers would hit the autostep limit.
- No stacked fight floors (combat finds ground with a ray straight down): storeys side by side, joined by stairs.
- Noised caves have no straight wall spans: wall-backed props cannot go there; light them with posted lights.

- Arrival safe zone: no pack, patrol point, named, miniboss or boss within 25 m (walked) of any entry-*/exit-* anchor, so a player is never pinned at the door by the fight lock. Encoded: `arrival` gate in tools/dungeon-pipeline (thresholds.json).
