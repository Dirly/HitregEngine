---
name: town-npcs
description: Populate a town with NPCs — write its story (why it exists, who lives there, their relationships), cast residents (bankers, merchants, quest givers, guards, townsfolk), dress them for the climate and their class, write their dialogue, shops and quests, and generate them onto real ground with the town-npcs tool (lint + scene + lineup review scene). Use when a town needs people, dialogue, vendors, a bank, or quest givers, or when a town's NPCs, conversations or shops need changing.
---

# Town NPCs

The full reference is the tool-neutral doc **docs/town-npcs.md**. Read it now,
then follow it. Outfits are armor-set work (**docs/armor-sets.md**, the
`armor-sets` skill); NPC icons for new items are **docs/item-icons.md**.

## Order

1. **Read the place**: town id, terraces, gates, sea; climate from
   `field.biome`; the zone story and spawn areas around it.
2. **Story** in `projects/<p>/authoring/towns/<name>.json`: what, why here,
   what's wrong now, who holds power, relationships (each one usable), hooks.
3. **Residents**: services first, then quest givers who carry the conflicts,
   then guards/townsfolk. 10–15. Place on flat reachable ground facing into
   the plaza (sample a height grid first).
4. **Outfits** for climate + class; new looks via the armor-sets skill (a
   subagent with a compact brief is fine); `wear` + `fallback`.
5. **Dialogue** per resident: first meeting, small talk list, services, quest
   branches (hand-ins before greetings), lines about each other, flag chains.
6. **Quests + shops**: an `autoStart` arrival quest → the leader → a tour with
   `talk` objectives → work out into the zone. Kill/collect targets must be
   killable and drop what is collected. Shops own real stock; prices come from
   item `value`.
7. **Generate + lint**: `cd apps/playground && npx tsx tools/town-npcs.mts
   --project <p> --town <name> --lineup <name>-lineup --with hud,character-ui`.
   Fix every ERROR; warnings about fallbacks are expected until art lands.
8. **Look and play**: the lineup scene (both sexes, nobody in the base layer),
   then the town itself end to end: arrival → leader → tour → hand-in → buy →
   bank. Headless: Playwright + system Chrome (see the headless smoke-test
   memory); `__hitreg.sim.setTranslation`, `__hitreg.cameraRig.setOrbit`.

## Never

- Write a compass word (north, south-west, "the eastern road") in quest, dialogue
  or story text. Name the place (`{dir:id}`, `{far:id}`, `{place:id}`); add it to
  the town doc's `places` if it is new. Directions are computed from the world
  (north is -Z) — every server has its own world, and hand-written ones were all
  flipped the first time.

- Hand-place NPC entities in the scene file: edit the town doc and re-run the
  tool (it replaces the town's NPCs by tag).
- Let a client decide an outcome: every service is an `npc` builtin request.
- Give an NPC its own material or mesh: bodies share the model, looks are
  per-part tiles.
