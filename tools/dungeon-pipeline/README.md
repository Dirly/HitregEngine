# Dungeon pipeline (shared stages + quality gates)

One stage runner and one standard stage list for every Blender-to-DC instanced dungeon, so a new dungeon gets every
build stage **and every quality gate** by default. It is a CLI library (no `tool.json`): a project's
`authoring/pipeline.mjs` imports it and names only its own paths and commands.

```js
// projects/<id>/authoring/pipeline.mjs
import { runPipeline, standardStages, writePlanGeometry } from "../../../../../tools/dungeon-pipeline/pipeline.mjs";
const id = "<id>";
runPipeline(import.meta.url, standardStages({ id, exportInputs: ["authoring/warren.py"], override: { fight: { run: "..." } } }),
  { before: (root) => writePlanGeometry(root, { populationKeys: ["packs", "minibosses", "lengthM"], stamp: `authoring/${id}.mesh-stamp.json` }) });
```

```
node authoring/pipeline.mjs                 table: ok | STALE | FAILED | MISSING per stage, the gate failures, notes
node authoring/pipeline.mjs --next          `<stage>: <command>` (the first stage not ok)
node authoring/pipeline.mjs --next --json   the same with status, gate flag and failures (zonegen status reads this)
node ../../../../tools/dungeon-pipeline/quality.mjs <gate|all> [--build] [--print]   run gates (from projects/<id>)
```

`writePlanGeometry` digests the plan's SHAPE (population keys and prose left out: every `note` / `about` and a space's `name`) into
`authoring/.plan-geometry.json`, the export's input: re-populating, renaming or writing "unlit" in a note never asks for a
Blender export.

`standardStages({ id, blender, exportInputs, override, insert })`: `override` merges fields into a stage by name
(`null` drops it), `insert: [{ after, stage }]` adds a project stage. A stage is `{ name, out, inputs, report?, check?,
fresh?, run, note }`; FAILED = its `report` has `passed !== true` (or `check(out)` is false).

## Standard order

plan, export, **noise**, **originality**, thin-walls, dc-bake, import, merged bake, split-floor, **stairs**, materials, **atlas**, **matte**,
dress maps, scene, portals, lighting, **recipe**, **culling**, walk, fight, **loot**, views, **readability**, **compare**, loading art. A gate sits right after the stage that makes what it reads, so a
fault is caught before the next expensive stage. Its report is `reports/quality/<gate>.json`; it goes STALE when its
inputs, `thresholds.json`, `quality.mjs` or the project's exceptions file change.

## Gates (numbers in `thresholds.json`, the rules in docs/world-standards/dungeons.md "Quality recipe")

| Gate | Reads | Fails when |
|---|---|---|
| `noise` | `authoring/noise.json`, the stamp, `reports/source-audit.json`, plan | natural spaces (cave/burrow, or basalt/rock/ice walls) without a role-noise table; the stamp does not embed it (or embeds a different one); < 90% of natural-role triangles noised; a group whose natural downward faces are > 50% flat slabs (prism roofs); `<space>.rock.n` box lumps. A masonry dungeon with < 2% natural-role triangles is not judged. |
| `originality` | this project's builder `.py` / `crafted*` / `setpieces*` files vs every other dungeon project's | a function (normalised body, renamed or not) is the same as another dungeon's, unless it is a shared primitive listed in `thresholds.json`; a builder file is > 60% the same lines as another's. The references are the originals: a copy of their code fails the copier. |
| `decals` | the shipped scene's decals, `authoring/decals/set.json`, every other dungeon's scene decals | decals are optional; a decal texture that is the same file, a byte copy or a perceptual near copy (dHash distance <= 6) of one another dungeon uses; one texture > 40% of the dungeon's decals (from 5 decals); a decal not made through `authoring/decals/set.json` (an `image-request.mjs gen-set` manifest: ids `<project>-decal-*`, a concept frame as `ref`). Stage `flat-art` (tools/flat-art.mts) beside it: no slab picture upside down or mirrored. |
| `atlas` | `reports/materials.json`, `assets/materials/*/dc-palette.json`, the tiles | more than one palette (page) or texture folder; a painted role with no map; two roles one image; a tint that shifts hue (chroma > 0.12) or darkens below 60%; a stone / wood / metal tile outside its family's hue band (25 deg) or saturation band (0.16). |
| `recipe` | plan, `reports/source-audit.json`, the shipped scene, dressing plan reports, `room-sheet.json` | per room: built detail < 25 (35 masonry), props < 7 or kinds < 4 (bones, lights, mobs aside), bones > 4 or > 35% of props, visible light sources outside 2-5 (fixture props within 1.5 m form one source), decals outside 6-12, no set piece; per passage: bones > 4, > 15 m and no light unless the plan says "unlit"; dungeon: < 25 prop kinds, < 3 decal textures or none of mid value, ambient fill > 6 (was 1.5 until 2026-10-06), a point/spot light with no fixture prop beside it, a prefab placed outside a dressing plan, a plan in the scene with no passing dress check. |
| `matte` | palette layers by role (`reports/materials.json`), own material assets, own GLBs | roughness < 0.9 (metal-named roles/materials < 0.6) or metalness > 0 on a non-metal. Schema defaults are matte (1 / 0). An intended shine (ice, water) is an exception with a why. |
| `stairs` | plan spaces (`run` profiles with steps, `burrow` floorProfiles that change height, a gallery `stair`), room-kit `stair` markers (`reports/kit/markers.json`), the shipped `assets/models` GLBs | along each stair/ramp line, from 1 m before the first riser to 1 m past the last, every 0.1 m on the centre line and both lane edges (width/2 - 0.45 m): cast down to the walking surface, then up to the first downward face. Fails on clear < 2.6 m, a clear-height band (max - min on one line) wider than max(0.9 m, 12% of the median), a ceiling step > 0.15 m within 0.2 m beyond the walk's own pitch (a stepped roof), or the floor found under < 60% of the samples. |
| `culling` | the scene, the plan route | a room whose dressing group (an interior culling unit) appears more than 2 m after the walker enters the room, the scene's `cullingProfile` applied (docs/culling.md "Interior scenes"). |
| `readability` | `reports/views/*.png` (shipped light) | a view > 90% near-black (luma < 12); the median view > 50% near-black (lights on black), its mean outside 14-45, or its 10th percentile > 10 (flat fill, no pools). |
| `loot` | `authoring/loot.json` (the drop list: id, slot, `weight` or `role`, rarity, `from`), plan named/boss loot strings, `plan.trashLoot`, the item files | an armor weight (cloth/leather/mail/plate) that never drops; an armor slot dropping in < 2 weights; a weapon role (caster, melee-1h, melee-2h, tank) that never drops; < 4 trash drops; a named that drops nothing or a boss with no rare; rarity above the level band (top level <= 10: uncommon, boss rare; <= 20: rare); ornament parts below rare; a drop with no item file or missing from its source's loot string. Owner ruling 2026-10-08: every instance gives every class a reason to go. |
| `compare` | the dungeon's view sheet and the references' | `reports/compare.png` (this dungeon, then fieldfast-barrow, fieldfast-hall, side by side) missing or older than the views. `--build` makes it. A person still judges it. |

How things are counted: rooms/passages are plan space kinds (`thresholds.json` `spaces`). Built detail is every
source-audit object `<space>.<kind>.n` whose kind is not structural (walls, floors, roofs, steps...); objects named
after a plan feature (`tally-stone.n` for `chamber.tallyStones`) go to the one space with that key. Props, bones and
fixtures are the scene's `dressing`-tagged entities, by their plan (`dress:<id>-<space>`) or else by position. A
fixture is a prefab that holds a light (or is in a light bucket). Decals go to the space that holds them. A set piece
is a built kind or a plan feature only that room has, a prop of this project's own prefabs, a catalogue prop no other
room has, or `room-sheet.json` `rooms[].setPieceObjects`.

## Lighting stage (the readability floor)

`npx tsx ../../tools/dungeon-pipeline/lighting.mts --project projects/<id> [--dry]` (from apps/playground) applies
`lighting.json`, merged with the project's own `authoring/lighting.json` (only the keys it changes, with a why), as one
applyOps batch: a hemisphere fill (ambient `light.groundColor`) at ONE intensity for every dungeon, toned warm / cold /
neutral by the bucket most spaces (or dressing plans) use; fog and sky dome to the fill tone (never black); ONE post preset
(house grade, bloom, vignette <= 0.25, no pixelate) and a shared character rim; exposure 1;
the interior `cullingProfile`. Inverse ops land in `reports/lighting.json`. Mood is tone and fixtures, never darkness.

Measure without writing reports (calibrating on a dungeon you must not touch): `quality.mjs <gate> --dry --metrics`.

## Exceptions

A dungeon that justifiably misses a number writes `authoring/quality-exceptions.json`:

```json
{ "version": 1, "exceptions": [ { "gate": "recipe", "check": "lightsMin", "space": "drowned", "why": "the flooded tunnel is lit only by the portal swirl (owner, 2026-10-05)" } ] }
```

`check` is the failure's `check` field in the gate report; `space` is a space id or `*`. An exception without a `why`
(8+ characters) is ignored. Excepted lines stay in the report under `excepted`. Never edit `thresholds.json` for one
dungeon.

## Porting a dungeon

1. Replace `authoring/pipeline.mjs` with the import above; move each differing command or input into `override`
   (compare `node authoring/pipeline.mjs` before and after: the build stages must keep their statuses).
2. Run `node ../../../../tools/dungeon-pipeline/quality.mjs all --build` and read the failures.
3. Fix what the dungeon can fix; record justified exceptions; never weaken `thresholds.json` for one dungeon.

Ported: gnawspur-deeps, fieldfast-barrow (2026-10-05), rime-hall (2026-10-06). Not yet: fieldfast-hall (calibrated through the CLI only; its
`fresh()` sha checks go in `override`), gloomvein-hold, gnawspur-rough (a proof copy).
