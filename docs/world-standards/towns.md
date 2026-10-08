# Town standards (index)

Siting the wall, sizing the program to the ground, settling, wear, residents, walking and street lights: the
"Ground, wall, wear and lights" section of skill **`town-planner`** (`.claude/skills/town-planner/SKILL.md`), with
`building-constructor` (each building), `building-styles` (styles, types, windows) and `town-npcs` (residents).

## Lights
Every town street and every road near a town has lanterns. The numbers are data in
`apps/playground/tools/street-lights.json` (schema `streetLightingSchema`, `tools/town-lights-rule.mts`; a project may
override it with `authoring/street-lights.json`). `tools/town-lights.mts apply` places them as one ops batch,
`town-lights.mts check` judges the scene (`LIGHTS <town>: ... -> ok|FAILED`), `zonegen status` row `town <name>: lights`
comes before `walk`. Open values: `README.md` "Not encoded yet".
