# town-design-phase — design the town first, then cut the ground to the design

Engine root `D:\Users\Derek\Desktop\HitRegStudios\Engine`; tools from `apps/playground`.

## Why (Derek, 2026-10-29)

"the layouts for our towns dont feel good — you should be able to make terraces to put buildings there — there
should be more of a design phase with the towns." Today the order is backwards: `worldgen terrace` cuts shelves
from a radius or an area total (`tools/worldgen-town-program.mts`), then `town-layout` squeezes lots onto whatever
came out. Saltharrow took four masters (hilltop, discs, narrow bands, program bands) and still reads as rows of
houses along parallel shelves. Read `docs/postmortems/skelmorrow.md` (the Saltharrow rows from 2026-10-28/29),
`apps/playground/projects/firstshore/authoring/handoffs/z1-town.md` (all rounds) and `s1-world.md` (s1e, s1f,
s1g sections), the `town-planner`, `building-constructor`, `site-finder` skills, `tools/town-layout.mts`,
`tools/worldgen-town-program.mts`, `tools/worldgen-terrace-walls.mts` (read only: another agent is editing it),
the kit-fit check (`D:\Users\Derek\Desktop\HitRegStudios\MMO\WFC\wfc\kit_fit.py`), `docs/art-direction.md`.

## Deliverable

1. **A town plan document** (Zod schema, `.describe()` → spec), authored by a town DESIGNER agent before any
   ground is cut: districts (harbour, market, chapel close, high town…), the main street and side lanes as
   centre-lines with widths, the square(s), the landmark and its sightline from the gate, each building as a
   footprint at a kit-proven size with its door side and street, and TERRACES as designed platforms: each terrace
   a polygon at a level holding named buildings and street lengths, with its stair/ramp connections placed where
   the streets cross levels, and its edge treatment (bank or stepped wall, per the per-riser rule in
   `tools/worldgen-riser-rule.mts`). Design rules from real towns: a street climbs across the slope, not up it;
   a square at the gate or the harbour; buildings face the street with backs to the slope; the landmark closes a
   view; irregular block shapes, not rows.
2. **`town-design` tool** (`tools/town-design.mts`): `propose` reads the site (heights, slope, coast, roads in, the
   site-needs score), drafts a starting plan, and renders a plan picture over the terrain (streets, terraces with
   levels, footprints, doors, landmark sightline); `check` validates: every building fits its terrace with the
   kit's margins, every door on a street, every terrace reachable by a stair/ramp ≤ the grade cap, cut/fill per
   terrace within the 6 m rule, street grades ≤ cap, the landmark visible from the gate, kit-fit for every
   request; `render` redraws the picture. A designer agent brief template `tools/zonegen/briefs/town-design.md`:
   a fresh Opus designer opens the site renders and the plan picture, iterates the plan file through `check`,
   and the concept-on-site tool (being built by another agent: `docs/briefs/concept-on-site.md`; call it when
   present) paints the town on its real site. The coordinator or Derek approves the plan picture before any cut.
3. **Cut the ground to the plan**: `worldgen terrace --from-plan <plan.json>` (put the logic in a new file, e.g.
   `tools/worldgen-terrace-from-plan.mts`, and only a small hook in `worldgen.mts`: another agent is editing the
   towns stage) cuts exactly the designed terraces, banks and stepped walls, stairs and ramps; `town-layout
   --from-plan` places the lots exactly as designed (no re-fitting). The old radius/area path stays only as the
   designer's starting draft.
4. Tests (plan schema, check rules, from-plan cut on a small fixture world), docs (`town-planner` skill order:
   site → design → approve → cut → build; `docs/workflows.md`), post-mortem rows with their checks built.

Dogfood on a throwaway lab world you create and delete (never `projects/firstshore`, which is being archived):
design one small coastal town and one hill town, cut them from their plans, and show the plan pictures + one
player-height render each in your report. Rules: no commits; never :5173; probe ports of your own (not
5287/5291/5293); Blender only under `tools/blender-lock.mjs`; no iteration files. Run the playground tests and both
typechecks. Budget 350k. Report once, under 20 lines.
