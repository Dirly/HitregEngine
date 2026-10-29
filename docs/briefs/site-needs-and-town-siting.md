# site-needs-and-town-siting — places declare the ground they need; an agent sites the towns

Engine root `D:\Users\Derek\Desktop\HitRegStudios\Engine`; tools from `apps/playground`.

## Why (Derek, 2026-10-29)

On firstshore the Wristgate (a 52 m carved front) went on a 40 m gorge beside a 31 m falls: "the river cliff doesn't
support this... how do we figure out where this stuff fits? you need a cliff for something of this calibre". The
walled town Saltharrow went in a cove under a hill where no wall line is defensible: "if you wanted to make this
town a walled town the cliffs beside them would have been better suited". And: "an agent should pick the location
of the towns". Today places are sited BY TYPE (entrance → a falls, harbour → a cove) by `worldgen towns` /
`zonegen sites` scores, and nothing asks whether the ground can carry the idea. Read `docs/postmortems/skelmorrow.md`
(fault → check table), `.claude/skills/site-finder`, `zone-creator`, `grand-entrance`, `town-planner`,
`tools/zonegen/` (sites, reserve), `tools/worldgen.mts` (`towns`), `tools/worldgen-coastal-towns.mts`,
`tools/worldgen-town-program.mts`, `tools/town-wall-line.mts`, `docs/world-standards/`.

## Deliverable

1. **Site needs, as data** (Zod schema with `.describe()` → spec): every place archetype / town role declares the
   ground it needs, measured: e.g. grand entrance = a rock face ≥ the front's height (default 1.1×), a flat apron
   ≥ N m² at its foot, an approach that sees the face from ≥ the read distance; walled town = cliff flanks or a
   neck ≤ W m to wall, no ground within 60 m that overlooks the enclosure (reuse `town-wall-line check`); harbour
   town = sheltered cove/sand-beach at shore level (reuse the coastal rule); hill town, crossroads town, etc.
   Defaults live in one file (`tools/site-needs.mts` or the zonegen schema), overridable per place.
2. **Scoring against needs**: `zonegen sites` (and the towns stage) score every candidate against the needs of the
   role asked for and report met / unmet per need with numbers; a reservation whose site fails a need FAILS
   `reserve` (and `zonegen status`) unless a dated coordinator ruling excepts it. Tests.
3. **The town-siting step is an AGENT step**: `worldgen towns` gains a `--propose` mode that writes the candidate
   list (with needs scores and bare-terrain renders: the plan map crop + one far render per candidate on a probe
   port, via the existing shot harness) to `authoring/siting/<world>/candidates.json` + PNGs, and a `--pick
   <file>` mode that applies a choice file `{ towns: [{ role, candidate, why }] }` through the tool (schema
   validated, refuses a candidate that fails its needs). Add a brief template `tools/zonegen/briefs/site-towns.md`
   for a fresh Opus siting agent: open the renders, judge fit against the role (walled town needs cliffs/neck,
   harbour needs a cove, capital needs a crossroads), write the choice file with a one-line why each. Same
   propose/pick for POIs and dungeon entrances through `zonegen sites`/`reserve` (the zone master's job).
4. **The generator honours needs it cannot find**: when no candidate meets a need, `--propose` says so with the
   shortfall, and a `needs` list in the recipe (schema) lets the coordinator ask the world stages for the ground
   (e.g. `{ kind: "cliff-face", minHeight: 55, near: "zone-1 west" }`) so the generator makes it on the next
   run (relief/coast stages already make cliffs: route a need into them). Build it for the two kinds this run needs
   most: a cliff face for an entrance and cliff flanks/a neck for a walled town.
5. Docs: `site-finder` and `zone-creator` skills + `docs/workflows.md` route through propose → agent pick; the
   post-mortem gets the fault rows (Wristgate cliff, Saltharrow wall) with their checks built.

Rules: no commits; never :5173; probe ports of your own (not 5287/5291/5293); Blender only under
`tools/blender-lock.mjs`; no iteration files; do not write into `apps/playground/projects/firstshore` (being
archived). Run the playground tests and both typechecks. Budget 350k. Report once, under 20 lines.
