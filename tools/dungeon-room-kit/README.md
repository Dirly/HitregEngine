# Dungeon room kit

A room plan in, crafted architecture out. A builder writes one short JSON entry per room (outline, floor, height,
style, doorways); the kit places pilasters, bases and capitals, arched and dressed doorways, vault ribs, cornice and
plinth courses, niches, wainscot, aisled arcades, daises, timber roof bays, or a shaped natural cave with rock
pillars and stalactites, all by rule, and hands closed solids grouped by room to the existing Blender to DC bridge
(`tools/mesh-dc`). Role noise applies as usual. A dungeon's own set pieces stay in its own builder; the kit is a
shared primitive layer, like `tools/mesh-dc/shapes_blender.py`, so the `originality` gate does not count it.

It is a CLI library (no `tool.json`), like `tools/dungeon-pipeline`: it needs a headless Blender, and its output is
a mesh stamp that the registered **Blender to DC** tool imports.

## What a builder writes per room

```json
{ "id": "chamber", "kind": "chamber", "style": "barrow-masonry",
  "x": [-8, 8], "y": [138.4, 160.4], "floor": -17, "height": 3.6,
  "doors": [{ "side": "E", "at": 140.4, "width": 2.4, "height": 3.2 }] }
```

- Footprint: `x`/`y` ranges, or `outline` (CCW or CW polygon, plan frame: x east, y north, metres). Masonry and
  timber rules want right angles (the timber hall a rectangle); natural rooms take any star-shaped outline.
- `floor`, `height` (wall / springing height above the floor; vaults, roofs and cave domes rise above it).
- `doors`: `side` (N/E/S/W, matched by the wall's outward normal) and `at` = the absolute plan coordinate along that
  wall (x on N/S walls, y on E/W walls; the barrow plan's convention), or `edge` index + `t` metres along it.
  `width`, `height` (crown, from the floor), `arch` (`round`, `segmental`, `pointed`, `flat`), `rise`, `frame`.
- `openSides`: sides with no wall (a passage that runs into a neighbour's doorway). No wall, floor or vault laps
  over an open side, so two rooms never show coplanar surfaces from two groups.
- `group` (default the room id): passages join the group of the room they leave, so their joint unions in one field.
- `seed`, `rules` (any style key, deep-merged for this room only), `ceiling`, `pilasters`, `timber`, `natural`.

A rooms file wraps them: `{ "id", "name", "anchor": [x, y, z], "noise": "noise.json", "route": [[x, y], ...],
"palette"?, "styles"?: { "<style>": overrides }, "rooms": [...] }`. `route` drives the walk-lane noise protection.
See `examples/sample-rooms.json` (one room per style) and
`apps/playground/projects/roomkit-proof/authoring/rooms.json` (the proof).

## Commands (engine root)

```
node tools/dungeon-room-kit/roomkit.mjs all <rooms.json> [--out dir] [--voxel .12]   build + noise protection + DC bake/audit, timed
node tools/dungeon-room-kit/roomkit.mjs build <rooms.json> [--out dir] [--blend]     Blender headless -> <id>.mesh-stamp.json, source-audit.json, markers.json, kit-report.json
node tools/dungeon-room-kit/roomkit.mjs bake <stamp.json> [--out dir] [--group id]   convertMeshStamp -> dual contouring -> meshAudit per room
node tools/dungeon-room-kit/roomkit.mjs counts <source-audit.json>                  built detail per room, counted as the recipe gate counts it
node tools/dungeon-room-kit/roomkit.mjs styles
```

`$BLENDER` overrides the Blender path. Inside a dungeon's own `build.py` (where its set pieces live):

```python
import sys; sys.path.insert(0, r"<engine>/tools/dungeon-room-kit/kit")
import blender_build as kit
report = kit.build_rooms("<abs>/authoring/rooms.json")   # objects tagged dc_group / dc_role / dc_noise, named <room>.<kind>.<n>
# ... this dungeon's own set pieces, same dc_group per room ...
kit.export("<abs>/authoring/rooms.json", stamp_path, audit_path)
```

Outputs: the stamp (one group per room; the noise table and its protection zones embedded), `source-audit.json`
(what the `recipe` gate counts), `markers.json` (doorways with clear width/height, sconce sockets on pilasters,
niches, shelves, daises, roof-bay hanging points, piers with radius) for dressing plans and walk routes, and
`timing.json`.

## Parts

**Carved DC library, 9-sliced** (`apps/playground/projects/dc-carved-library/authoring/recipes`, read live). Each
recipe's add nodes become solids; its slice bands (from that project's `references/slicing-rules.md`) are planes the
geometry never crosses with a slanted face, so the piecewise-linear map is exact: corner and edge regions keep their
measurements and only the middle band grows (or shrinks to the band width).

| Part | Bands (u / v / w) | Used for |
|---|---|---|
| `wall-plain` | -0.9..0.9 / 1.0..2.2 / -0.12..0.12 | every masonry wall run: stock, plinth, string course, frieze, coping, sliced to the run length, wall height and thickness; its upper courses continue over doorways |
| `column-octagonal` | -0.07..0.07 / 0.95..2.25 / -0.07..0.07 | freestanding piers, height sliced, base and capital fixed |
| `base-moulded` | -0.07..0.07 / - / -0.07..0.07 | timber post pads |
| `coping-straight` | -1..1 / - / - | coped dais edges |

Library pieces that depend on cutters (`arch-*`, `column-recessed`, `wall-panel`) are not used: the bridge takes
closed solids, not subtractions. The kit draws arches natively.

**Native parts** (`kit/geom.py`, `kit/rules.py`): arch curves (round, segmental, two-centre pointed, flat) with
spandrel walling and a voussoir ring (proud keystone, alternating depths); dressed jambs and imposts; pilasters
(two-step base, shaft, two-step capital); blind arched niches built around their opening (no booleans); segmental or
round barrel vaults with transverse ribs on the bays; flat slabs with segmental ribs; boarded ceilings on beams and
corbels; panelled wainscot whose stiles repeat along each run (`repeat_slice`, the repeat mode of the 9-slice);
swept profiles with mitred corners (`sweep`); a pitched timber roof with posts, knee braces, tie beams, king posts,
principal rafters, struts, purlins, ridge and wall plates; daises with steps; natural rock walls (mitred), domed
cave roofs (`shapes_blender.cave_ceiling`), lofted rock pillars, stalactite and stalagmite cones, rock shelves.

## Styles (`styles/*.json`, data)

| Style | Construction | What the rules place |
|---|---|---|
| `barrow-masonry` | masonry | library wall runs, pilasters every 3.2 m, segmental dressed doorways (9 voussoirs; round or pointed per door), segmental barrel with ribs on the pilasters, loculus niches in alternate bays, aisled arcades of octagonal piers when both spans >= 11 m (then a ribbed slab), a coped dais in rooms >= 10 m |
| `manor-panelled` | masonry (extends barrow) | smooth-stone walls, repeating panelled wainscot, slim pilasters, flat-headed lintelled doors, boarded ceiling on beams and corbels |
| `giant-timber` | timber | library stone walls to 6 m eaves, steep pitched roof on 4.2 m timber bays, posts on moulded pads, aisle posts over 15 m spans, round doorways with 11 voussoirs |
| `warren-gnawed` | natural | basalt rock walls and domed roof (noise keys `rock-wall`, `rock-roof`), silt floor (`earth-floor`), a pillar per 60 m2, two stalactite clusters, five stalagmites, a rock shelf |
| `ice-cave` | natural (extends warren) | ice roles, higher dome, thinner and more pillars, three icicle clusters, `ice-wall` / `ice-roof` keys |

A style names roles (`wall`, `trim`, `floor`, `ceiling`, `pier`, `timber`, `panel`, `rock`), spacings and
proportions. A dungeon overrides any of it in its rooms file (`styles`) or per room (`rules`); a new style is a new
JSON file (`extends` an existing one). Roles map to the dungeon's atlas palette; the default palette is the Barrow's
twelve roles in the Barrow's order.

## Rules worth knowing

- One `dc_group` per room; every piece of a room may overlap any other (the field unions them). Nothing uses a
  boolean, so there are no slivers.
- Door heights are from the room floor (the crown). The kit REFUSES a door whose arch springs below `door.minSpring`
  (2.6 m): an arch loses headroom toward its jambs, and clearance is measured across the whole width. Otherwise
  run the walk (soffit minus the floor under each sample) as with any dungeon.
- Pilasters and niches skip doorways (door half width + jamb + margin). A rib whose pilaster fell on a door springs
  from the coping.
- Natural rooms: pillars stay `pillarWall` from walls and `lane` from every doorway-to-centre and door-to-door lane;
  stalactite tips stay above the springing (the plan's clear height); the shelf needs a 7 m room.
- Detail counts are honest geometry: each solid of a non-structural piece counts once, under the kinds the recipe
  gate reads (`pilaster`, `voussoir`, `jamb`, `impost`, `rib`, `niche`, `plinth`, `string-course`, `frieze`,
  `cornice`, `pier`, `arcade`, `post`, `brace`, `rafter`, `purlin`, `pillar`, `stalactite`...).

## Stairs whose ceiling follows the flight

A room with `"kind": "stair"` (or a `stair` block) is a stair passage between two levels. Its ceiling FOLLOWS the
flight instead of a flat slab the stair runs up into:

```json
{ "id": "east-stair", "kind": "stair", "group": "chamber", "style": "barrow-masonry",
  "x": [8.8, 18.6], "y": [139.0, 141.8], "floor": -17, "openSides": ["W", "E"],
  "stair": { "up": "E", "rise": 3.2, "riser": 0.2, "tread": 0.32, "landing": 1.6, "headroom": 3.6, "ceiling": "barrel" } }
```

- A rectangle; `up` is the climbing direction, `floor` the lower landing; `rise` / `riser` give the step count,
  `tread` the going, `landing` the lower landing length (the upper landing is the rest, >= 0.8 m or it refuses).
  Both ends are `openSides` running into the neighbours' doorways; `lap` (0.3 m) carries floor, walls and vault
  into the neighbour's wall (same `group`: the field unions the joint).
- `headroom` is measured above the NOSING line and is constant along the flight (2.6 m minimum for human scale;
  scale it for giant styles). The kinks at both landings are filleted over `fillet` (1.6 m), so the ceiling meets
  each landing's level ceiling, and a neighbour's door head at the same height, without a step.
- Masonry / timber styles, `ceiling`: `barrel` (round raking barrel), `segmental` (`archRise` x width), `pointed`,
  or `raked` (a sloped slab parallel to the flight). Raking side walls rise to the springing; a raking plinth on the
  pitch line and a raking string course at the springing; transverse ribs every pilaster bay (square to the axis,
  raking with it). Treads are `step` solids in the trim role, crisp.
- Natural styles: `shapes_blender.cave_tunnel` lofted along the pitch line (feet buried a riser + 0.35 m), its walls
  and sloped roof carrying the style's `rock-roof` noise; rock-cut treads stay crisp.
- markers.json gets a `stair` marker (centre line, pitch profile, flight, width, headroom, ceiling) that the
  `stairs` gate in `tools/dungeon-pipeline` measures against the bake.

## Limits

- Masonry outlines must be rectilinear for the library wall runs (other angles fall back to plain mitred walls);
  the barrel vault and the timber roof need a rectangle; other outlines get a ribbed slab.
- Stairs are straight flights in a rectangle (no winders, no turning landings: chain two stair rooms through a
  landing room); inside a room, a second floor height comes from a dais (masonry, timber) or a rock shelf (natural).
- Set pieces, props, lights and decals are not the kit's job: markers give the sockets, dressing plans place them.

## Proof

`apps/playground/projects/roomkit-proof` (a gitignored proof copy, not a dungeon): three rooms of a copy of the
Fieldfast Barrow plan, rebuilt with the kit, walked by the real server body. Its `NOTES.md` has the numbers.

Self-test: `node --test tools/dungeon-room-kit/self-test.mjs` (builds `examples/sample-rooms.json` in Blender and
checks every solid exported closed; skipped when Blender is absent).
