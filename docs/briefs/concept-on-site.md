# concept-on-site — every place's concept frame is painted onto a render of its real site

Engine root `D:\Users\Derek\Desktop\HitRegStudios\Engine`; tools from `apps/playground`.

## Why (Derek, 2026-10-29)

Every firstshore concept frame was generated from TEXT only (checked: `.hitreg/image-requests/firstshore-*.json` have
no refs). Codex invented a cliff tall enough for a 50 m gate; the real gorge was 40 m with a 31 m falls; the owner
built to the invented cliff. Derek: "do you take a snapshot of the area then feed those for the concept art?" — we
did not; we must.

Read `tools/image-request.mjs` (gen, `--paint`: the one `--ref` is a screenshot whose COMPOSITION is repainted),
`docs/image-generation.md`, `tools/light-shots.mts` (fixed rig, spots, shows), `tools/place-build.mts` (views, lab),
the `zone-creator`, `poi-creator`, `grand-entrance` skills (concept frames first, gate 16 `concept[]`, rubric P5),
`tools/poi-review/job.mjs` (concept gate).

## Deliverable

1. **`zonegen concept <world> --project <p> --zone <z> --poi <id>`** (or `tools/concept-on-site.mts`): renders the
   BARE site (the world with no place entities, probe port of its own, fixed rig): (a) the approach view at player
   height from the place's first-sight point on its main road, (b) a far view from ≥ the read distance, (c) a
   plan-map crop with the reservation drawn. Then `image-request gen --paint` each render with the place's premise
   + style text (texture-led PSX, dark high fantasy, the zone mood), at the render's aspect, writing
   `concept/<id>-{approach,far}.png` plus the bare renders beside them (`<id>-{approach,far}.site.png`), overwriting
   in place. The prompt tells Codex the ground is fixed: keep the horizon, the rock heights, the water line and
   the slope; add only the built place.
2. **The gate**: a concept frame counts for gate 16 / P5 only if its request record names a `site.png` ref made by
   this tool for the same reservation (and not older than the last world change under it). Text-only concept frames
   are refused for new jobs (`job.mjs`), with a clear message naming the command. Tests.
3. **Fit read in the same step**: print the measured site numbers beside the frames (face height under the place,
   apron area, read distance, overlook verdict from `town-wall-line check` for walled towns) so the reviewer and
   Derek judge the painting against the numbers.
4. Docs: the skills' "concept frames first" lines and `docs/workflows.md` route through this command; post-mortem
   row (text-only concepts) with the check built.

Dogfood it once on any existing reserved site in a kept project (or a throwaway lab world you create and delete),
and show the before/after (bare render vs painted) in your report paths. Rules: no commits; never :5173; probe
ports of your own (not 5287/5291/5293); Blender only under `tools/blender-lock.mjs`; no iteration files; do not
write into `apps/playground/projects/firstshore` (being archived). Run the playground tests and the tools
typecheck. Budget 250k. Report once, under 15 lines.
