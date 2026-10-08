# Review rubric (DRAFT)

What a reviewer agent checks (`docs/zone-creation.md`, "The reviewer"). Each line is answered pass / fault with
evidence. Measurable lines first; a taste line is a fault only when the picture shows it plainly. Cite a line by its
code (S3, D5 ...).

## Quality (every review, first)

- Q1 No bare primitive stands in for an object (a sphere as a boulder, a box as a cauldron, blocks as a dam). Primitives
  are fine when composed into something that reads as real (the Silkroot Grove: primitives + alpha cards, situational);
  land is terrain, buildings kit, crafted structures DC, objects catalogue.
- Q2 Side by side with the owner-approved references (Fieldfast Barrow, Fieldfast Hall estate, Old Watch), the work
  is at least as crafted. If not: RETURN, whatever else passes.
- Q3 One strong idea reads at a glance; features that only tick a design line are cut.
- Q4 "Why is this here?" is answerable from the pictures alone, without the design text: every set piece and story
  object is something a player can name (a toll needs a barrier people stop at; a trophy reads as a trophy).
- Q5 Every prop is a believable size for its kind and its users, and belongs to the place's culture and scale; no
  composites of unrelated parts standing in for an object that does not exist (that is a prop request).

## Design (the zone brief and plan, before the freeze)

- Z1 Every place has a read a passer-by would get in one look and could not mistake for another place ("giants camp round one huge hide tent over bone pits" passes; "some ruins" does not). Simple is good.
- Z2 No two places in the zone, or in a neighbour zone, share a set piece, landmark or unique thing.
- Z3 Most hostile places belong to groups other than the story faction; each group has its own small reason.
- Z4 Every large place has three or more linked features with water or caves among them where the land allows.
- Z5 Every landmark owns its own dungeon; its outside promises what the inside will be.
- Z6 On the map: every place is reachable from a road or path, none sits on a town, places are spread so the land
  between them is used, and landmark places are seen from a road. Places stand on the ground the site finder found
  (`zonegen sites`: `sites.png` + `sites-candidates.json`, the place's `site` pick): a door at the end of its canyon
  facing the mouth, a perch on the cliff over the water, a wall across the narrowest gap; each faces its approach.
  The `sites` gate is ok: every climbing path arrives somewhere, no large landform or empty disc is left unused, and
  density meets the floor. Strong unused candidates are either taken or named as deliberately left.
- Z7 Places are designed for their creatures (scale, tunnels, lairs) whether or not the body exists yet.

## Site (grey box, then final)

- S1 Size class met: measured usable area and feature count against `sites.md`.
- S2 The read is true in the pictures: a passer-by at 60 m would say the one-line read.
- S3 The landmark is the biggest thing there and is visible from the stated viewpoint.
- S4 Every feature is joined by a walked route; the real body walked them (report).
- S5 Mood shows: ground, plants (foliage system only), water, air. No floating plants over edits (`scatter-float`).
- S6 Built surfaces at the town texel standard, no see-through faces from the sides, top or inside.
- S7 Camps: tents and stands from the catalogue at 1.5x, tent doors face the fire; nothing hand-made that the
  catalogue has.
- S8 Clearings handed over for packs; named creature spots at the edge and further in.
- S9 The set piece exists as built geometry, props, decals or creatures, not only as text.

## Dungeon (grey box, then final)

- D1 Size class met (rooms, route metres) without filler; route walked by the real body.
- D2 A room sheet per room: purpose, occupants, one set piece, light, one piece of unique art.
- D3 At least one room breaks the pattern outright.
- D4 No room recipe repeats beyond the cap; no fixture in most rooms (the manor's fireplaces).
- D5 Level variety: a lower level, a flooded or collapsed part, or a change of material.
- D6 Lights from one bucket; rooms readable (dim pools of light, never near black).
- D7 Packs in every room and long passage, mixed members, patrols in corridors, several named creatures.
- D8 Entrance: walk-through portal deep in a real passage, swirl on both sides, `portal-trip` passes both ways.
- D9 The inside reads as the place the outside promised.

## Town (grey box = layout, then final)

- T1 Raised foundations (~0.6 m above the highest ground of the plot); door paths to every door.
- T2 Streets read as streets (paving), lanterns by the lighting standard.
- T3 The town's style is one style file; no kit-default grey or fallback tiles.
- T4 Plants everywhere except plots, streets and door paths.
- T5 A wall where the setting calls for one, with gates where roads arrive.
- T6 The landmark of the square exists; residents in the budget per town.

## Encounters

- E1 Counts per `encounters.md`; a pack is a mix, not N of one body.
- E2 Patrols where the standard requires them.
- E3 One view holds about 20 animated bodies at most.
- E4 Seen on the server, not only on paper.

## Zone (final)

- F1 Every place passes its final review or its logged fault is listed.
- F2 Riding the roads, something worth a detour is seen at least every few minutes.
- F3 The zone's look differs from its neighbours'; borders blend.
- F4 The ledger lists bodies waited on, faults logged and rows with no gate.
