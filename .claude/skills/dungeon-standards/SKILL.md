---
name: dungeon-standards
description: "Planning, dressing or reviewing an instanced dungeon: how many per zone, size classes, plan shape language, a room sheet per room, set pieces and unique rooms, caps on repeated rooms and fixtures, level variety, creatures, known engine limits. Use with hitreg-dungeon-authoring; the build and its gates are dungeon-build, light is dungeon-lighting, doors are portals."
---

# dungeon-standards

What a dungeon is held to by design. Measured rules live in the tools: `dungeon-build` (geometry and every quality
gate), `dungeon-lighting` (readability, matte, culling, buckets), `portals` (doors), `site-dressing` /
`interior-standards` (props). Read [placement and self-review](references/placement-review.md)
when planning dressing or reviewing a dungeon. Weeping Sun Tombs is the current
owner-approved quality bar (2026-11-08); the `compare` gate's older reference list
remains useful construction evidence, not a prop-density target. Open values:
`docs/world-standards/README.md` "Not encoded yet".

## Style and scale before dressing

- Keep the dungeon's own visual `authoring/style-guide.md`: materials, palette, shape/culture, texel reference,
  density, effects and explicit rejected examples. A "crypt" tag does not make a dark coffin fit a sandstone temple.
- Inspect actual rendered prop images at intended scale, including an in-room view. Record keep/rework/reject and
  source hashes. After layout, use actual room screenshots for sparse prop/effect concepts; generated images are
  proposals that must be reconciled with the measured architecture and usable space.
- Measure painted room/door/column dimensions with the existing `concept-scale` stage before export, using a
  figure of known height and inspected overlays. Review prop, statue/pedestal, shelf/body and equipped-boss scale
  separately. The shared reference describes the working gates and what is not yet automatically covered.

## How many, how big
- 3-5 dungeons per zone; a zone with a capital carries 5 (zone brief lint warns outside 3-5). Every landmark owns
  one; capitals and starter towns get one nearby or tied in (sewers, haunted house, abandoned mine, sunken ship).
- Each differs in shape language and palette from the others in its zone.
- Its world entrance is a grand landmark that reads from 300 m+: skill `grand-entrance`.
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
- A room sheet per room (`room-sheet.json`): purpose, occupants, usable space and light. Significant rooms have a
  clear focal feature, which may be architecture, existing carving, a mechanism or the encounter. Quiet transitions
  can have no loose props or new unique art. A kitchen has a cook; a chapel its congregation.
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
- Props by name through dressing plans; a few purposeful groups, walls first, centre and link passages clear.
  Reserve pull setup, patrol crossings, camera space and knockback recovery before dressing. Empty floor is valid.
  Finish with a removal pass for redundant props and their lights/VFX. Do not meet legacy prop/type minima by
  filling space: use a reasoned scoped exception as described in the placement review; do not waive physical checks.
- Nothing floats: `dress apply` seats every prop on the real floor (DC mesh, colliders) by its catalogue contact, and the
  pipeline's `float` stage (`tools/float.mts scene <project>`) must pass before portal play; a prop with no support moves in the plan.
- No see-through: every wall, vault and hull closes on screen — the pipeline's `see-through` stage must pass (docs/see-through.md); vault shells and arch springings at least 3 voxels thick in the source.
- One mesh owns each plane; zfight gate: no two DC groups, kit pieces, built pads or props draw the same surface (the pipeline's `zfight` stage, `tools/zfight.mts <project> --decals`, also checks every decal lands on its surface: `decal place`). Where groups meet, one group's wall stops short of the other's face.
- More bones in a tomb (an exception entry, `dungeon-build`); candles carry a barrow; nothing inside a hearth.
- A dungeon is a place to farm (`encounter-standards`). Boss mechanics are engine builtins, the dungeon is data
  (`encounter-waves`, `spawnArea.patrol`); a patrol is a route between named points.
- Shared data drives geometry and population: niches, wave mouths, statue spots computed once, read by both.
- A tile for large surfaces is tried on one test wall at room scale first; tile prompts carry the house look (dark,
  low contrast, no ripples, no parallel bands).

## Known limits
- Water: one still level at the lowest point of the dungeon, nothing moving (2026-10-25: a plunge pot under an inner fall, the Weep Hole, did not work). Plan a flooded bottom, never a stepped or weeping water feature.
- Verticality and depth (Derek 2026-11-09): stack storeys round a shared void so one level is seen from another (a pit with a spiral ledge, grates, overlooks); fight floors that overlap in plan stay >= 10 m apart. Offshoots: dead ends and side loops with a reason to enter, not one corridor. A giant dungeon has no player-only pocket to cheese from (see dungeon-build). Reference: projects/rustgut.
- One recorded way back per traveller: no dungeon-to-dungeon doors.
- Noised caves have no straight wall spans: no wall-backed props; posted lights at exact floor spots.

## Variety (owner ruling 2026-10-20)
Not every dungeon is humanoid. Each zone's dungeon set needs at least one creature LAIR where the bestiary allows it —
a wasp nest, an ant hive, a spider nest, a sewer of rats and crocs — with its own plan-shape language (galleries,
brood chambers, flooded culverts), not a barrow re-skinned. Any unit can be re-skinned through the atlas tooling for a
lair's own look; capsules are never shipped (populate renders the base body when a theme lacks art).
