# Dungeon pipeline (shared stages + quality gates)

One stage runner and one standard stage list for every Blender-to-DC instanced dungeon, so a new dungeon gets every
build stage **and every quality gate** by default. It is a CLI library (no `tool.json`): a project's
`authoring/pipeline.mjs` imports it and names only its own paths and commands.

## Reusable boss arena gates

Use the registered `boss-gate` builtin for arena doors, with the real gate art
and a kinematic collider under the same root. Its parameters and replicated
timestamp contract are self-described in the live spec; do not write a
room-entry trigger to fake boss engagement.

An arena entrance uses `closeOnAggro: true`: it stays open while players enter
and prepare, then closes when the boss's AI publishes a target. Side/reward and
progression gates use the same boss id with the ordinary initially shut mode.
All gates rise or sink open after that boss dies, and victory remains latched
for late joins. Random boss alternatives must share a stable actor id, so one
set of gates works for either selection. `resetOnEvade` lets the entrance
re-arm after sustained disengagement without reopening the reward/exit gates
or respawning a defeated boss.

Author the root at its **closed** pose and fit the raised gate into a real
ceiling pocket. Keep a safe preparation area outside boss aggro range. Verify
entry without aggro, an actual AI pull, physical closure, defeat of every boss
alternative, wipe/evade recovery, and late-join pose; art and collider must
always follow the same clock. Static gate pictures do not prove these states.

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

A stage may judge an input by digest instead of mtime: `digests: { <input>: "<report field>" }`. dc-bake and import
record the stamp's `sourceSha256`, so a byte-identical Blender re-export (only the mtime moved) leaves them ok
(test: digest.test.mjs). A report without the field falls back to mtime.

`standardStages({ id, blender, exportInputs, override, insert })`: `override` merges fields into a stage by name
(`null` drops it), `insert: [{ after, stage }]` adds a project stage. A stage is `{ name, out, inputs, report?, check?,
fresh?, run, note }`; FAILED = its `report` has `passed !== true` (or `check(out)` is false). `run` may be a function of
the project root (the `portal play` command reads the plan).

**Exit far from the arrival:** `portal play` walks a straight line from the arrival to the return portal. A dungeon whose
exit is at the end of a long route declares where that walk starts in its plan, in ENGINE metres inside the instance:
`"portalPlay": { "exitFrom": [72, -6.4, 0], "note": "..." }` — the stage command then carries
`--exit-from 72,-6.4,0` (tools/portal-play.mts fast-travels there first). `portalPlay` is test data, not geometry: it
never moves the export's plan digest. Set by tipped-kirk (the straight walk stopped 23 m short).

## Standard order

**Placement direction (owner, 2026-11-08):** Weeping Sun Tombs is the current quality bar. Read the
[shared skill reference](../../.claude/skills/dungeon-standards/references/placement-review.md) for sparse purposeful
groups, encounter clear space and self-review. The recipe's remaining prop/type and built-piece minima are legacy
count checks, not density targets. Use a justified scoped exception for a reviewed sparse layout; do not add filler
or suppress unrelated checks. Removing those count floors and adding purpose/clear-space checks is a proposed
tool change, not implemented in this documentation pass. Decals are already optional in the current code.

plan, **scale**, export, **noise**, **originality**, thin-walls, dc-bake, import, merged bake, split-floor, **stairs**, materials, **atlas**, **matte**,
dress maps, scene, portals, lighting, **recipe**, **culling**, walk, fight, **loot**, views, **readability**, **compare**, loading art. A gate sits right after the stage that makes what it reads, so a
fault is caught before the next expensive stage. Its report is `reports/quality/<gate>.json`; it goes STALE when its
inputs, `thresholds.json`, `quality.mjs` or the project's exceptions file change.

## Scale (concept-scale.mjs: the painting in metres)

A painted dungeon is built to its paintings' SIZES, not a written room sheet's (Moon-Deep 2026-11-01: the Vigil was a
corridor beside a ~40 m painted hall; Red Dial 2026-10-30 the same). The `scale` stage sits before `export`:

1. **Mark each painting** in `authoring/concept/<painting>.marks.json`, by eye from the image: the eye line (where the
   floor lines meet), the painted figure's head and feet, and the room's key sizes (column foot and top, column spacing,
   wall to wall at the floor, ceiling or vault, the far door). The field of view comes from a floor rectangle of known
   proportions (a tile, a grid bay) or a guessed `vfov` with its uncertainty. The schema is in the tool's header.
2. `node ../../../../tools/dungeon-pipeline/concept-scale.mjs measure` (from the project) back-projects them through a
   level pinhole camera, using the figure as a 1.8 m ruler. The camera height comes from the eye line and the figure;
   heights and widths need no field of view. It writes `authoring/concept-sizes.json`, each size with 5th / 95th
   percentiles over jittered marks, and `reports/concept-scale/<painting>.png`, the marks drawn on the painting.
   LOOK at every overlay: a mark that misses its edge is a wrong size.
3. The project's `authoring/built-sizes.mjs` exports `builtSizes()` -> `{ room: { key: metres } }`, read from the
   plan / kit data the builder reads. `concept-scale.mjs gate` writes `reports/scale.json` and FAILS on any gated size
   off by more than `thresholds.json` `scale.tolerance` (0.15) or not reported. A measure marked `"gate": false` is
   advisory.
4. **A person in the grey box:** `paintingCamera(sizes.paintings[p].camera, { feet, facing })` gives a light-shots
   fixed-camera spot. It has the painting's camera height, distance, pitch and field of view behind a `figure` standing
   at `feet`, the place the painted figure stands in the built room. light-shots stands the real human body model
   there (idle pose, shown even with `--no-refs`). Every compare/views shot of a painted room carries it.

A dungeon with no paintings drops the stage (`override: { scale: null }`). Test: `concept-scale.test.mjs`.

## Gates (numbers in `thresholds.json`, the rules in docs/world-standards/dungeons.md "Quality recipe")

| Gate | Reads | Fails when |
|---|---|---|
| `noise` | `authoring/noise.json`, the stamp, `reports/source-audit.json`, plan | natural spaces (cave/burrow, or basalt/rock/ice walls) without a role-noise table; the stamp does not embed it (or embeds a different one); < 90% of natural-role triangles noised; a group whose natural downward faces are > 50% flat slabs (prism roofs); `<space>.rock.n` box lumps. A masonry dungeon with < 2% natural-role triangles is not judged. |
| `originality` | this project's builder `.py` / `crafted*` / `setpieces*` files vs every other dungeon project's | a function (normalised body, renamed or not) is the same as another dungeon's, unless it is a shared primitive listed in `thresholds.json`; a builder file is > 60% the same lines as another's. The references are the originals: a copy of their code fails the copier. |
| `decals` | the shipped scene's decals, `authoring/decals/set.json`, every other dungeon's scene decals | decals are optional; a decal texture that is the same file, a byte copy or a perceptual near copy (dHash distance <= 6) of one another dungeon uses; one texture > 40% of the dungeon's decals (from 5 decals); a decal not made through `authoring/decals/set.json` (an `image-request.mjs gen-set` manifest: ids `<project>-decal-*`, a concept frame as `ref`). Stage `flat-art` (tools/flat-art.mts) beside it: no slab picture upside down or mirrored. |
| `atlas` | `reports/materials.json`, `assets/materials/*/dc-palette.json`, the tiles | more than one palette (page) or texture folder; a painted role with no map; two roles one image; a tint that shifts hue (chroma > 0.12) or darkens below 60%; a stone / wood / metal tile outside its family's hue band (25 deg) or saturation band (0.16). |
| `recipe` | plan, `reports/source-audit.json`, the shipped scene, dressing plan reports, `room-sheet.json` | current legacy room floors: built detail < 18 (22 masonry), props < 6 or kinds < 4 (bones, lights, mobs aside); bones > 4 or > 35% of props, visible light sources outside 2-5 (fixture props within 1.5 m form one source), decals > 12, no set piece; per passage: bones > 4, > 15 m and no light unless the plan says "unlit"; dungeon: < 25 prop kinds, ambient fill > 6, a point/spot light with no fixture prop beside it, a prefab placed outside a dressing plan, a plan in the scene with no passing dress check. Decals are optional; the current recipe does not enforce decal texture-count/mid-value minima. See the placement direction above before addressing count-only failures. |
| `matte` | palette layers by role (`reports/materials.json`), own material assets, own GLBs | roughness < 0.9 (metal-named roles/materials < 0.6) or metalness > 0 on a non-metal. Schema defaults are matte (1 / 0). An intended shine (ice, water) is an exception with a why. |
| `stairs` | plan spaces (`run` profiles with steps, `burrow` floorProfiles that change height, a gallery `stair`), room-kit `stair` markers (`reports/kit/markers.json`), the shipped `assets/models` GLBs | along each stair/ramp line, from 1 m before the first riser to 1 m past the last, every 0.1 m on the centre line and both lane edges (width/2 - 0.45 m): cast down to the walking surface, then up to the first downward face. Fails on clear < 2.6 m, a clear-height band (max - min on one line) wider than max(0.9 m, 12% of the median), a ceiling step > 0.15 m within 0.2 m beyond the walk's own pitch (a stepped roof), or the floor found under < 60% of the samples. |
| `culling` | the scene, the plan route | a room whose dressing group (an interior culling unit) appears more than 2 m after the walker enters the room, the scene's `cullingProfile` applied (docs/culling.md "Interior scenes"). |
| `readability` | `reports/views/*.png` (shipped light) | a view > 90% near-black (luma < 12); the median view > 50% near-black (lights on black), its mean outside 14-45, or its 10th percentile > 10 (flat fill, no pools). |
| `loot` | `authoring/loot.json` (the drop list: id, slot, `weight` or `role`, rarity, `from`), plan named/boss loot strings, `plan.trashLoot`, the item files | an armor weight (cloth/leather/mail/plate) that never drops; an armor slot dropping in < 2 weights; a weapon role (caster, melee-1h, melee-2h, tank) that never drops; < 4 trash drops; a named that drops nothing or a boss with no rare; rarity above the level band (top level <= 10: uncommon, boss rare; <= 20: rare); ornament parts below rare; a drop with no item file or missing from its source's loot string. Owner ruling 2026-10-08: every instance gives every class a reason to go. |
| `water` | plan `water` bodies + `spaces` floors, the shipped scene | ONE STILL LEVEL AT THE BOTTOM (owner 2026-10-25): `oneWaterLevel` a body off the shared surface height; `lowest` a dry floor under any water surface (the water would run there); `static` moving water in the scene (tags `moving-water`/`waterfall`, path/ribbon water meshes, a sloping water surface: falls, cascades, curtains, channels). None can be excepted: sink the water to the lowest floor or remove it; a fall is mist/vfx or nothing |
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

## prove fight under load

`step-jitter.mjs` times every server tick of a proof. A fight that fails while the MEDIAN tick took more than 1.5x the
fixed step is written `{ passed: false, result: "unjudged (load)", unjudged: "<why>" }` and the pipeline shows the stage
UNJUDGED (re-run on a quiet machine), not FAILED. Wire it in a dungeon's `prove.mts`:
`const jitter = instrumentTicks(server, { fixedStepMs: world.fixedDt * 1000 })` after the GameServer is built, then
`out("fight.json", { ...judgeUnderLoad(passed, jitter.summary()), ...rest })` (test: step-jitter.test.mjs).
