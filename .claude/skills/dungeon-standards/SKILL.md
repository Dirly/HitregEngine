---
name: dungeon-standards
description: Planning, dressing or reviewing an instanced dungeon: how many per zone, size classes, plan shape language, a room sheet per room, set pieces and unique rooms, caps on repeated rooms and fixtures, level variety, creatures, known engine limits. Use with hitreg-dungeon-authoring; the build and its gates are dungeon-build, light is dungeon-lighting, doors are portals.
---

# dungeon-standards

What a dungeon is held to by design. Measured rules live in the tools: `dungeon-build` (geometry and every quality
gate), `dungeon-lighting` (readability, matte, culling, buckets), `portals` (doors), `site-dressing` /
`interior-standards` (props). The owner-approved references are the `compare` gate's list
(`tools/dungeon-pipeline/thresholds.json` `references`); every review starts beside their sheets. Open values:
`docs/world-standards/README.md` "Not encoded yet".

## How many, how big
- 3-5 dungeons per zone; a zone with a capital carries 5 (zone brief lint warns outside 3-5). Every landmark owns
  one; capitals and starter towns get one nearby or tied in (sewers, haunted house, abandoned mine, sunken ship).
- Each differs in shape language and palette from the others in its zone.
- A FIRST dungeon is about 23 rooms and 600 m of route; a LARGE one about twice that. Never buy size with filler.

## Plan and shape
- Each theme has its own plan shape language, decided before the first export (a warren: winding runs of varying
  width, necks, side burrows, irregular rooms, cross-links). Compare plan pictures with the neighbours' first:
  builders drift to the last dungeon's shapes, and a copied toolchain copies its layout grammar.
- "Few, huge spaces" means one dominant space, not several equal peers.
- No two spaces fight over a floor: interiors overlap by no more than a wall's depth.
- Natural rooms are shaped volumes; man-made rooms use masonry methods, the room kit or the WFC vaults/arcades.
  No flat-roofed prisms with box lumps.

## Every room is a place
- A room sheet per room (`room-sheet.json`): purpose, who is in it, ONE set piece, its light, one unique art piece
  (texture, decal, carving). A kitchen has a cook; a chapel its congregation.
- A set piece shows what the occupants DO there (forge, midden, pen, lookout); lore follows the place, never an
  invented backstory illustrated by an odd object.
- Set pieces are crafted from the start (DC pieces, catalogue props, owner-made mechanisms); grey-box boxes do not survive.
- A set piece contrasts with what holds it (a statue in its niche's material vanishes).
- At least one room breaks the pattern outright; an ACCIDENTAL break of a regular pattern is a fault.
- Cap how often one room recipe repeats and how often one fixture appears (a fireplace in every room is a fault).
- Level variety: a basement, a flooded part, a material change partway through. A material theme is a ratio (the
  house stone with the theme in bands, frames, lumps), not a wall role.
- The inside reads as the kind of place the outside promised.
- Unique named NPCs fit the rooms they stand in, not only a boss at the end.

## Dressing and creatures
- Props by name through dressing plans; walls first, centre clear; link passages on the route stay empty.
- More bones in a tomb (an exception entry, `dungeon-build`); candles carry a barrow; nothing inside a hearth.
- A dungeon is a place to farm (`encounter-standards`). Boss mechanics are engine builtins, the dungeon is data
  (`encounter-waves`, `spawnArea.patrol`); a patrol is a route between named points.
- Shared data drives geometry and population: niches, wave mouths, statue spots computed once, read by both.
- A tile for large surfaces is tried on one test wall at room scale first; tile prompts carry the house look (dark,
  low contrast, no ripples, no parallel bands).

## Known limits
- No stacked fight floors (ground found by a ray straight down); storeys side by side, joined by real stairs.
- One recorded way back per traveller: no dungeon-to-dungeon doors.
- Noised caves have no straight wall spans: no wall-backed props; posted lights at exact floor spots.
