# dc-risers-and-handmade-walls — retaining risers as DC terrain; walls that feel hand-built

Engine root `D:\Users\Derek\Desktop\HitRegStudios\Engine`; tools from `apps/playground`.

## Why (Derek, 2026-10-29)

"those retaining walls just dont feel good... i feel like you could do this with a DC much better." and "my
problem with the walls is they dont feel hand made." The kit retaining wall is a flat panel set against the
ground (seam, ruler-straight top, the same pieces repeated). A previous agent built stepped kit walls (a riser over
2.5 m = 2-3 low walls with planted treads, `apps/playground/tools/worldgen-terrace-walls.mts`, tests in
`test/terrace-walls.test.ts`) and found: the mesher already picks DC per cell where planar cliffs reach it,
configured per zone (`packages/core/src/voxel/field.ts` ~781, `planar-cliffs.ts`); a riser as a planar DC volume
needs a new per-riser plane feature there. The kit's worn/missing caps exist only at wear 2-3
(`apps/playground/projects/world-kit/authoring/retaining-wall/plan.mjs`, `build.mts`). Read those, plus
`docs/voxel-worlds.md` (render/physics/placement source, seam and closed-volume invariants), `tools/mesh-dc/`,
`tools/worldgen-riser-rule.mts` (bank / wall verdict per riser), `docs/art-direction.md`, `docs/culling.md` only if
needed, the rock-skins tool (zone rock caps).

## Deliverable

1. **DC riser feature (engine)**: a recipe feature (schema `.describe()`, spec regenerated) for a terrace riser as a
   planar-faced DC volume: a polyline, a top and a foot height, a batter, an optional stepped profile (benches
   with planted treads for tall risers), and a face material role. The field makes the riser's cells DC (planar
   faces with the role noise used for Skelmorrow's cliffs: rough edges, joints) and MC elsewhere, with no seam
   where the riser meets the shelf and the slope (physics and placement read the same surface: the voxel-worlds
   invariants). Render + collision tests on a fixture.
2. **Riser rule**: `worldgen-riser-rule.mts` picks bank / DC riser / kit wall per riser: DC riser is the default
   for any riser that needs a built face; kit wall only where a street or building stands against the top edge
   and the DC top cannot hold a clean walkable edge (measure it). `terrace` prints the choice and why.
3. **Hand-made paint and silhouette**: the riser face and town walls take a seeded per-wall variation: irregular
   coursing (rubble fill, dressed stone only at corners/gates/quoins), course height and block size varying,
   moss and damp staining low, lighter weathered tops, a top that steps with the ground in short runs and has a
   few dropped/patched stones (kit: seeded cap variety at EVERY wear level + short height steps). Generated PSX
   textures through `image-request` where new paint is needed (texture-led PSX; register them like the zone
   tiles). A check (`terrace-walls check` / landmark bake report) fails a flat top over a long run or one texture
   tile on every face.
4. **Side-by-side**: on a throwaway lab world you create and delete (never `projects/firstshore`), the same 6 m
   riser as (a) the stepped kit wall, (b) the DC riser, plus one town-wall segment before/after the hand-made pass,
   each at player height and from 30 m, on your own probe port (not 5173/5287/5291/5293). LOOK at every frame and
   say which reads better and why.
5. Tests, docs (`docs/voxel-worlds.md`, the terrain-edits / town-planner skills), post-mortem rows with checks.

Coordination: another agent is editing `packages/core/src/voxel/recipe.ts` (town site roles, ground needs) and
`tools/worldgen.mts` towns stage, another `tools/town-*.mts` design files, another the concept tooling. Keep your
recipe edits to your own feature block; re-read before writing. Core has ~10 failing world-file round-trip tests
from that other work: do not "fix" them by editing its code; report whether your changes add any. Rules: never ask;
no commits; never :5173 or kill by name; Blender only under `tools/blender-lock.mjs`; no iteration files. Run the
playground and core tests and all typechecks. Budget 400k. Report once, under 20 lines with the render paths.
