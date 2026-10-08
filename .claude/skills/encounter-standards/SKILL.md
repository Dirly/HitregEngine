---
name: encounter-standards
description: Placing creatures in a dungeon or an outdoor site: counts per class, mixed packs, patrols, named creatures to farm, sight budget, reviewing on the server. Use before populating anything or writing site packs.
---

# encounter-standards

Mechanics: `docs/zone-pipeline.md` "Sites outside the quest plan" (site packs) and `docs/mob-ai.md`. Open values:
`docs/world-standards/README.md` "Not encoded yet".

## Commands (from apps/playground)
```
npx tsx tools/zonegen.mts populate <world> --project <p> --zone <z>     # + its installer; reads zones/<z>/site-packs.json
npx tsx tools/zonegen.mts map <world> --project <p> --zone <z> --dev    # spawn areas, packs, placed creatures
```
`site-packs.json`: per pack the site, spot (`at`, `y` when underground: spawned on the cave floor), faction, level,
members (`creature`, `theme`, `role`, `count`), optional `named` leader. Placed before wildlife.

## Gates: failure -> fix
- Populate gate fails -> a site with no clearing handed over (8 m, dry, standable) or a pack off the ground.
- `map-dev.png` shows spawns on a road or in a town, packs nobody passes -> move the pack spots.

## Rules
- A first dungeon holds 70+ creatures alive at once, a large one 120+; every room and long passage on the route holds a pack.
- A pack is a mix (a front line, something at range or casting, sometimes a leader), not copies of one body.
- Outdoor ambient life (starter zones above all) is roamers, not packs: `spawnArea` `placement: "anywhere"` with a
  `mix` of singles and pairs, mostly `temperament` passive/territorial; a wandering rare is `placement: "route"`,
  `unique`. `populate` warns `starter-thin` / `starter-hostile` / `starter-packs` (bar: `STARTER_LIFE` in populate.mts).
- Corridors, galleries and the ground between sub-sites have walkers on routes between named points.
- Several named creatures per dungeon and per large site: one near the edge as an easy first kill, others further in,
  each with its own skin and loot line.
- Rares and named creatures are not always up: they sit behind placeholders (`spawnArea.rares`, chance ≤ 0.3, a lockout)
  in a camp's slots, among roamers or on a route; `populate` warns `rare-always-up` / `rare-chance` (`RARE_RULES`).
- Design for the creature even with no body yet: a placeholder stands in; never shrink a place for a capsule.
- Seen on the server: an encounter is reviewed with the dedicated server's spawns; a count only true on paper is not seen.
- Sight budget: rooms and doors break sight lines so one view holds ~20 animated bodies at most.
- Counts are reported from a tool, never a tally.
