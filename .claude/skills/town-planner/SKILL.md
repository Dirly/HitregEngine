---
name: town-planner
description: Plan a medieval town district from Derek's modular building kit. Decides the building program (bank, guilds, market, taverns, houses…), lays out lots along streets on the cell grid, writes one building request per lot (system, size, storeys, roof, features such as vaulted bank halls or grand entrances), then has the building constructor build and place them all and reviews the result. Use when a town, a street or a district needs buildings, or a town's building mix changes.
---

# Town planner

Reference: **MMO/WFC/wfc/README.md** (the request and town-plan formats). Every building goes through the
`building-constructor` skill's rules. The planner only chooses WHAT and WHERE; the rules decide HOW.
For engine installation, also read [the shared town-baking policy](../../../docs/town-baking.md).
Plan exterior shells and independent room/floor visibility units before export;
keep interactive entities separate and retain the editable town plan.

**Risers and town walls must read hand-made:** a built riser is a DC riser unless a street or building stands within 2.5 m of its top edge (then a kit wall, whose copings vary at every wear level); town walls (wall operator) pass `handmade: {}`. `npx tsx tools/handmade-check.mts <world.json>` fails a top flat for 12 m or a one-tile face.

## Order: site -> design -> approve -> cut -> build
The ground is cut TO THE DESIGN, never the other way round (2026-10-29: Saltharrow's lots were squeezed onto shelves
cut from a radius and read as rows). From apps/playground:
- **Site**: the town is sited by the siting step (`worldgen towns --propose` -> agent pick, site needs).
- **Design**: a fresh designer agent (`tools/zonegen/briefs/town-design.md`) runs `npx tsx tools/town-design.mts
  propose --project <p> --town <id> --name <stem> --world <w>`, reshapes `authoring/towns/<stem>-design.json`
  (platform polygons at levels, streets, squares, stairs/ramps, every building at a kit-proven size facing its street,
  the landmark) and iterates `town-design check` to `TOWN DESIGN <stem>: ok` (fit, doors, reach <= 12 % ramps / 50 %
  stairs, cut/fill <= 6 m, the per-riser rule, landmark sightline, square at the gate or harbour, not rows, not `bands`, kit-fit).
  `bands` fails parallel levels stacked up the slope that each carry ONE street with their houses strung along it:
  every level needs a second, LINKED street crossing it (the main street climbing across the levels, a stair lane, a
  lane to a square, or a block turned onto it).
- **Approve**: the coordinator or Derek opens `authoring/towns/survey/<stem>-design.png` (+ the concept on the site)
  and sets `status: "approved"` + `approval`. A draft is never cut.
- **Cut**: `npx tsx tools/worldgen.mts terrace <w> --project <p> --from-plan authoring/towns/<stem>-design.json` (one
  masked patch, banks 1 : 2, kit walls / stepped walls with 4.5 m treads, stairs and ramps; prints each wall's gates
  and the level share of every platform; writes an undo inverse); `town-design render --built` redraws on the cut.
- **Lots**: `npx tsx tools/town-layout.mts --project <p> --from-plan <file>`: exactly as designed, no solver; a lot off
  its level means the cut is wrong, never move the lot. Then build (below) and install.
The old radius / program-band path (`worldgen terrace` without `--from-plan`) is only the designer's starting draft.

### Program and requests
1. **Program**: list what the town needs by its story and size: a bank, guilds (fighters, mages, merchants), a market,
   a chapel, taverns and inns, workshops, houses. If the town has an NPC story (`town-npcs`), the buildings its residents
   work in come first.
2. **Streets and lots** on the cell grid (1 cell = 3.2 m): streets 2–3 cells wide, a square for the market. Each lot is
   the building footprint plus clearance:
   - 1 cell of open ground in front (entrance steps; a grand door or portico needs 2);
   - 1 cell of open ground beside any gable end that may carry a chimney (R31);
   - 1 cell between neighbours so jetties, dormers and oriels have air.

   Rotate each lot so its street is the building's front (`rot` 0/90/180/270; the front is -y at rot 0).
3. **One request per lot**:
   - Size and features follow the type: a bank is stone, flat or gable roofed, with a `vault` and optionally a
     `dome`/`portico`/`grand_door` (not vault + grand door together — R33 vs R35).
   - A chapel is stone with a `steep` roof and a `nave` (even sides, e.g. 4x6); a church is a `basilica` (deeper than
     wide, e.g. 6x8; it gets a narthex 2 cells in front, so leave 3 cells of street clearance). Neither takes a
     `grand_door` (R33 vs R35).
   - Guild halls are large, with a `gallery`, `grand_door` and `tower`. Taverns are common, 2–3 storeys, with a
     `gallery` and `fireplace`. Houses are common, 2 storeys, 3–5 cells wide, with `jetty`/`dormers` on the street.
   - Vary sizes and features so no two neighbours are identical.
4. **Build**: write the town plan JSON (`{"town": ..., "lots": [...]}`) and run `MMO/WFC/wfc/build.py -- <town>.json`
   (see the building-constructor skill). Fix requests that come back `ok:false` (resize, drop a feature); rebuild.
5. **Review the district**: every building's sheet, then the whole town in Derek's Blender. The streets must read, and
   entrances must face the streets.
6. **Runtime handoff, when installing**: follow the shared baking policy's material,
   visibility and traversal gates. A district GLB with many material slots is not
   a completed partitioned bake. Confirm exporter/installer support before promising
   per-building output; preserve source assets and scene undo.

## Ground, wall, wear and lights (engine side, from apps/playground)
- **Wall**: site it from `zonegen sites` `wall-gap` (`site-finder` skill): one short heavy wall across the narrowest
  neck between cliff and water, not a ring from the brief. Lots respect wall and gate lines; trails leave by a gate.
  **Wall clear**: `npx tsx tools/town-wall-clear.mts --project <p> --town <t>` after the wall is baked and the buildings
  installed: every SHIPPED model (its glb bounds, as placed) clear of every wall body by >= 0.5 m; a wall that reaches
  into a building fails. Draw the wall line round the shipped models, not the layout envelopes (Cindermoot 2026-10-25:
  chapel, smoke tower and smithy were 2.4-6 m larger than their envelopes and the ring ran through them).
- **Program fits the ground**: measure buildable area (slope under ~20 % inside the wall line) against the planned
  envelopes before the freeze; resize the program or the wall, never terrace the town to fit.
- **Settle the FULL footprint**: `npx tsx tools/town-settle.mts --project <p> --town <t>` after pads, lanes and road
  regrade, then export with `--lift 0`. Floors sit raised ~0.6 m over the highest ground of their foundation, never
  flush. Encoded: it casts the model's FULL footprint (`full`); `town-settle --check` (`terrain-through-floor`) is the
  town's `floors` row, STALE after any ground change.
- **Nothing installed floats** (Derek 2026-10-31: "Why is shit floating if we have code assist for placement?"): after
  install, `npx tsx tools/town-seated.mts --project <p> --town <t>` judges every piece on the walked ground (structures
  along their base outline at their true bottom, dressing by the float rule; none unmeasured). Daylight under a raised
  slab is fixed by construction: `town-settle --skirts` lays a foundation skirt in the piece's foundation material.
  Encoded: the town's `seated` row.
- **No default grey** (Derek 2026-10-31, Bell Strand): `npx tsx tools/town-grey.mts --project <p> --town <t>` reads every town piece's texels where its UVs land (grey or cold blue-grey stone over 25 % and 2 m2 fails), skirts' materials and the town's terrace-wall masonry. Fix by re-skin: `tools/prop-regrade.mts <prefab> --palette <region stone tile> --out <png>` then `props variant ... --project world-kit`, confirm with `props status` (blank-uv + texel density).
- **Wear follows occupancy**: style `wear` 3 (holed walls, slipped roofs) for ruins and abandoned buildings only;
  inhabited poor quarters 1-2. An abandoned house carries a story (things left behind, vermin). Encoded: `zonegen town`
  `wear-inhabited` (style or request wear 3 on a lived-in building) and `skinned-budget` (plan `bodyCap`, else the tier's).
- **Lights**: `npx tsx tools/town-lights.mts apply --project <p> --town <t>` places catalogued lanterns from the
  town's data (`tools/street-lights.json`: spacing on streets, lanes, plazas, gate pairs, quays, roads out, junctions,
  bridge ends) as one ops batch; `town-lights.mts check` prints `LIGHTS <town>: ... -> ok|FAILED`; row
  `town <t>: lights` comes before `walk` (lanterns are solid). FAILED -> fix the town data or the rule file, rerun
  apply; never place or move a lantern by hand, never a new lantern model.
- **Stone inside the walls** (Derek 2026-11-02, Bell Strand): `worldgen terrace --from-plan` paves every intramural terrace with the zone's `ground.paving` stone (`<town>-plan-paving-<terrace>` ground paints); gate `npx tsx tools/town-paving.mts --project <p> --town <t>` (bare share <= 3 % per intramural terrace; a garden bed is a ground paint whose id has `garden`/`green`). Steps up to a chapel close or a raised square are a `stair` connection with `form: "axial"` (insert `stair-axial`: broad straight flight square to the wall, cheek walls), never a ramp along the face. Streets meet an axial stair at its FOOT on its axis, never at the wall beside its head (town-design check faults a street crossing its cheek). When the zone's paving is the same tone as its dirt (red flag on red clay), give the design `paving: { surface, map }` with a stone that contrasts in VALUE (never grey).
- **Walk**: `npx tsx tools/town-walk.mts --project <p> --town <t>` with the real body; kit stairs are walked from the
  real ground (a plinth lip the body cannot step is bridged on the stair's own slope).
- Two streets never run side by side at different heights; vegetation grows everywhere off plots, streets and door
  paths; capitals and starter towns get a dungeon close by or tied in (sewers, a mine, a wreck).
- Fill the space first, then fit residents into it (`town-npcs`); not everyone needs a house.
- **Rows are packed by plan type** (k-town9): `packRow` in `tools/town-row-pack.mts` picks the row's house types from
  the kit catalogue's `plan` (lots = `plan.rowPitchMetres`, party sides) and the kit's `row-fit.json` (re-run
  `town-kit-check row-fit ... --json <kit authoring>/row-fit.json` after adding a type: it records the `lots`): proven
  pairs only, a corner type on the row's +x end, no side-by-side repeats. Never cycle a fixed list of house ids.
- Lanterns face the middle of what they light, never along the road (not checked yet).

## Never
- Change a rule to fit a lot. Change the lot or the request.
- Place a building so its steps, portico, chimney or jetty lands in another lot or the street's centre line.

- Residents with bodies stay within the town tier budget (plan `bodyCap`, else the per-tier table); the rest are ambient. Encoded: `zonegen town` lint `skinned-budget` (town-npcs still builds every listed resident: list only the skinned ones).
