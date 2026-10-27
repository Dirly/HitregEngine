---
name: poi-creator
description: Create complete HitReg POIs with one owner agent, using an explicit adventure-size, hostility, description and location brief through terrain, playable content and review.
---

Read `tools/poi-review/creator/SKILL.md` in the active Engine checkout and follow
that canonical tool-neutral workflow. The default checkout is
`D:/Users/Derek/Desktop/HitRegStudios/Engine`.

Small and medium places are built by the place builder, not by hand: `node node_modules/tsx/dist/cli.mjs tools/place-build.mts all <world> --zone z --location id [--archetype a] [--set k=v]` (from apps/playground; `docs/place-builder.md`). Only a hero place (its own concept and bespoke geometry) gets an owner agent writing its own build.

One fresh agent owns each whole POI and all its corrections. The coordinator
supplies the brief, reviews the result and serializes installation without
independently editing the POI. Preparing a brief or invoking this skill does not
override the user's authorization, stop instructions or world freeze.

Anything people live in (a village, camp, steading, rookery) is laid out with `tools/settle.mts plan|apply|check` from its culture profile (`world-kit/authoring/settlement/cultures/`): households facing one gathering spot, work where the work is, one path graph, cover cleared under every home and fire, creature spots by tier; stilt villages get one pinned WFC solve per cluster. `settle check` must be ok before dressing.

Size is a tier, not a guess: `tools/poi-review/size-tiers.mjs` (large = 300-600 m, 3+ linked features with a landmark and water or a cave, 3+ creature groups, 3+ approaches, own terrain shaping); record measured usable area, `measurements.features[]` and `approaches[]` in handoff.json and run `job.mjs measure <job>` — install refuses below the tier (gate 12), and only a fresh reviewer (not you, not the coordinator) answering every Q/S rubric line can pass the final review (gate 13).

Walk it as a player before you hand it over: declare `navigation.routes` in handoff.json (every approach to every level, `[x,y,z]` points on the walk surface, `drops` for intended drop legs), then run `tools/poi-walk.mts <job>` from apps/playground — it boots the scene as the server does and also walks every door, opening, portal, dressing area, clearing and quest target it finds; install refuses until `reports/walk.json` is ok (gate 14). Read `reports/walk.png` for where the body fell or stuck.

Then run `tools/art-check.mts <job>` (apps/playground): install refuses until `reports/art-check.json` is ok (gate 15) — texel match with the terrain and props around it, value inside the zone ground band, material variety, every door with a portal or `doors: [{ name, sealed: true }]` in handoff.json, and the landmark form lint (copies, butted raw boxes, `bevel`, course scale vs culture).

Design before anything repeats (gate 16, owner ruling 2026-10-22: a zone of places passed every gate and read as nothing): write `<job>/design.json` — premise, the player's journey, areas with their purpose, story elements each made of catalogued props (`<collection>/<id>`, checked against the closure's catalogues) or `structure:` / `creature:` / `decal:` / `terrain:`, ONE area finished at player height with its frames, the reference frames it is judged against, and a concept frame drawn from the premise BEFORE the build (`apps/playground/tools/image-request.mjs gen`, the zone concept frames as `--ref`, under `<job>/concept/`) — then `node tools/poi-review/job.mjs design <job>` (prints the design hash) and a fresh reviewer's Place lines P1-P5 recorded by `job.mjs design-review <job> --file <review>`. No stage past greybox-review and no install without that PASS; the final review answers P1-P5 again on the whole place. place-build refuses `build` without the written design and its `gates` table starts with `design`.
