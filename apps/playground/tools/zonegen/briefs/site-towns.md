# Brief: site the towns of {world} (siting agent)

You choose WHERE each town goes, from the ground. A generator scored the ground; you judge whether it carries the
town's idea. A walled town is never put in a cove under a hill (Saltharrow, 2026-10-29: no defensible wall line);
a grand place needs the rock or the shore it promises.

**Read**
- `{siting}/candidates.json` (from `npx tsx tools/worldgen.mts towns {world} --project {project} --propose`): per role
  the candidates, each with `needs.results[]` (met / unmet per need, with numbers: wall metres to the open ring,
  overlook height, open ways in, relief, shore faults) and a `shortfall` when no candidate meets every need.
  What each role needs and every threshold: `SITE_NEEDS` and the schema `.describe()` text in `tools/site-needs.mts`.
- OPEN every picture before you choose: `{siting}/plan-<id>.png` (the plan crop: ground, water, roads, the pad
  ringed green = needs met, red = unmet) and `{siting}/far-<id>.png` (the bare terrain from 400 m on the open side).
  A number that passes on a picture that reads wrong is a wrong pick; say what you saw for each pick.
- `{recipe}`: the existing towns (`features.towns`: id, tier, `siteRole`, `coastal`, gates) and the zones (`regions`).

**Judge each role against its ground**
- walled-town: cliff flanks or water on most of the ring and ONE short neck to wall and gate (the `defensible` numbers);
  no higher ground within 60 m looks over the wall; the neck faces the way the road will come.
- harbour-town: at the water on a sheltered cove or sand beach (the coastal rule), not on the hill above its landing.
- capital / crossroads-town: open ways in from several directions (where the roads of the island will meet), a pad
  that terraces, near water.
- hill-town: stands over its surroundings and is seen from them.
- Spread: towns of one island are a walk apart, not in each other's laps; a re-sited town keeps its neighbourhood
  (its zone story and roads were written for where it was) unless the ground there cannot carry the role.
- A role whose `shortfall` is set: do NOT pick an unmet candidate. Write the ground need instead (below).

**Write** `{siting}/pick.json`:
```
{ "towns": [ { "role": "walled-town", "candidate": "walled-town-2", "why": "<one line: what in the ground carries it>",
               "town": "<existing town id to re-site, or omit for a new one>", "tier": "<new town only>" } ] }
```
Schema: `pickFileSchema` in `tools/worldgen-site-needs.mts` (every row needs a `why`). A pick that misses a need is
refused unless a row carries `rulings: [{ "need": "defensible", "ruling": "YYYY-MM-DD <coordinator's ruling>" }]` —
you never write a ruling yourself; ask the coordinator in your report.

For a shortfall, report the ground need to add to the recipe instead: `{ "id": "<town>-ground", "kind": "walled-neck",
"near": [x, z] | "<zone> <side>", "within": 500, "radius": <pad>, "neck": 60 }` (or `cliff-face` with `minHeight`); the
coordinator adds it to `needs` and runs `worldgen needs {world} --project {project}`, then the propose again.

**Gate** `npx tsx tools/worldgen.mts towns {world} --project {project} --pick {siting}/pick.json` prints each town
`<- candidate` and writes the recipe; then `worldgen status {world}`: the `towns` row re-measures every `siteRole`.

**Report** each pick with its needs line and what the two pictures show, in under 15 lines.

**Do not touch** the recipe by hand, the terrain, scenes, zone plans, or any town that is not in your pick file.
