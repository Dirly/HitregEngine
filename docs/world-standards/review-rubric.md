# Review rubric (DRAFT)

What a reviewer agent checks (`docs/zone-creation.md`, "The reviewer"). Each line is answered pass / fault with
evidence. Measurable lines first; a taste line is a fault only when the picture shows it plainly. Cite a line by its
code (S3, D5 ...).

The Place lines (P1-P5) are not taste lines (owner ruling 2026-10-22, after a zone of places passed every gate and
read as nothing): a story element that is not in the frames, or a prop no element explains, is a FAULT. It is never a
logged note and never a prop request. A reviewer who writes "no nets visible" and passes has failed the review.

## Place (the design review on ONE finished area, then again on the whole place at the final review)

The owner's `design.json` (tools/poi-review/job.mjs gate 16) states the premise, the player's journey, the areas and
the story elements, and names one finished area with its player-height frames and the reference frames it is judged
against. The reviewer answers from the frames, reading the design text only to check it against them.

- P1 The story reads from the frames alone: before reading the premise, the reviewer writes in one line what this
  place is and what its occupants do or did there; it then matches the premise. A read of "some huts", "a yard" or a
  different place is a fault. The world is DARK HIGH FANTASY (owner ruling 2026-10-23): the read carries a threat, a
  wrongness or a cost — what the place does to people, what it hides, what comes for it at night. A read that is a
  farm chore, a trade yard or a pleasant village scene with nothing wrong in it is a fault, however well built.
  Follow `adventure-design.md`: ordinary work plus wolves, a corpse or grim backstory is not sufficient.
  Name the particular fantasy discovery and its visible evidence; do not infer it from a newly ominous name.
- P2 Every story element is seen: each `elements[]` entry of design.json is visible in a named frame as built
  geometry, a catalogue prop, a decal or a creature. One missing is a fault; a prop request does not stand in for it. A
  creature or NPC element belongs to populate / town-npcs, not to the place: it passes when its spot is open and named.
- P3 Nothing is random: every prop and structure in the frames is explained by an element or a journey step. The
  reviewer names each one that is not; one or more is a fault.
- P4 Worth visiting: a player who sees the place from the road has a reason to walk over and is paid for it there
  (something to do, take, learn or fight, or a sight). State the attraction, what investigation reveals and its
  particular payoff. Generic pests or a commodity chore alone do not establish that adventure.
  Fine-but-forgettable is a fault, even when layout and quest mechanics pass.
- P5 Finished to the bar: the finished area (at the final review, every area) stands beside the reference frames the
  design names at the same craft (prop choice, wear, light) and beside its concept frame (drawn from the premise before
  the build) with the same composition and set pieces. Not as crafted, or not the place the concept shows, is a fault.
- P6 Made of the world (owner ruling 2026-10-23): at least 60% of the props and pieces in the frames are the catalogue's
  reusable props and kits — tents, huts, lean-tos, racks, carts, boats, barrels, hurdles, bone piles, a kin's dwellings
  — placed to the story; props custom to this place are the few that carry the one thing the story cannot say
  otherwise. More custom than reused, or a place with no reusable kit in it, is a fault. (`job.mjs design` measures
  the same share on design.json: at most 40% of its props may be made for this place.)

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
- Z5 Every planned dungeon belongs to its own place; its outside promises what the inside will be.
  Landmark status or size alone does not require a dungeon; justify destinations through adventure and zone pacing.
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
