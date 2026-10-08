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

## Order
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
- **Program fits the ground**: measure buildable area (slope under ~20 % inside the wall line) against the planned
  envelopes before the freeze; resize the program or the wall, never terrace the town to fit.
- **Settle the FULL footprint**: `npx tsx tools/town-settle.mts --project <p> --town <t>` after pads, lanes and road
  regrade, then export with `--lift 0`. Floors sit raised ~0.6 m over the highest ground of their foundation, never
  flush. Encoded: it casts the model's FULL footprint (`full`); `town-settle --check` (`terrain-through-floor`) is the
  town's `floors` row, STALE after any ground change.
- **Wear follows occupancy**: style `wear` 3 (holed walls, slipped roofs) for ruins and abandoned buildings only;
  inhabited poor quarters 1-2. An abandoned house carries a story (things left behind, vermin). Encoded: `zonegen town`
  `wear-inhabited` (style or request wear 3 on a lived-in building) and `skinned-budget` (plan `bodyCap`, else the tier's).
- **Lights**: `npx tsx tools/town-lights.mts apply --project <p> --town <t>` places catalogued lanterns from the
  town's data (`tools/street-lights.json`: spacing on streets, lanes, plazas, gate pairs, quays, roads out, junctions,
  bridge ends) as one ops batch; `town-lights.mts check` prints `LIGHTS <town>: ... -> ok|FAILED`; row
  `town <t>: lights` comes before `walk` (lanterns are solid). FAILED -> fix the town data or the rule file, rerun
  apply; never place or move a lantern by hand, never a new lantern model.
- **Walk**: `npx tsx tools/town-walk.mts --project <p> --town <t>` with the real body; kit stairs are walked from the
  real ground (a plinth lip the body cannot step is bridged on the stair's own slope).
- Two streets never run side by side at different heights; vegetation grows everywhere off plots, streets and door
  paths; capitals and starter towns get a dungeon close by or tied in (sewers, a mine, a wreck).
- Fill the space first, then fit residents into it (`town-npcs`); not everyone needs a house.
- Lanterns face the middle of what they light, never along the road (not checked yet).

## Never
- Change a rule to fit a lot. Change the lot or the request.
- Place a building so its steps, portico, chimney or jetty lands in another lot or the street's centre line.

- Residents with bodies stay within the town tier budget (plan `bodyCap`, else the per-tier table); the rest are ambient. Encoded: `zonegen town` lint `skinned-budget` (town-npcs still builds every listed resident: list only the skinned ones).
