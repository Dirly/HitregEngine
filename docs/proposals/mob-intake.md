# PROPOSAL: mob intake as a status command

**Status: PROPOSAL, not built.** It takes a creature from a Blockbench/GLB body
to a spawnable, animated, themed mob, using the same pattern as `worldgen status`
and `props.mts status`.

## Why

Of eight catalogued creatures (`authoring/zonegen/bestiary.json`), only rat and
wolf are rigged and installed; ogre, ghoul and ratkin have finished art but no
skeleton; Anansi is finished but outside the repo. Each stalled at a **silently
skipped** step, so every stage writes an artifact and a command checks it.

```
npx tsx tools/mobs.mts status [<mob>] --project <p> [--next] [--quiet]
```

One row per mob per stage: `ok`, `STALE` (an input changed after the artifact
was written, compared by mtime/hash the way `commandStatus` compares pipeline
stamps), or `MISSING`. `--next` prints the next command, or the human/agent
step. State lives in `authoring/mobs/<mob>.json` (source path, recipe name,
rig donor, clip map, themes, template id). The tool writes stage stamps there.

## Stages

| # | Stage | Tool | Input -> artifact | Gate | Who |
|---|---|---|---|---|---|
| 1 | **body** | to build: `mobs intake` | Blockbench `.obj/.fbx/.glb` in `MMO/3d/Mobs/` -> `authoring/mobs/<mob>.json` | one root; feet on y=0 (±2 cm); faces +Z; height within the declared range; no stray meshes (the ratkin export carried `SpiderHalf2/3`, `skinCluster1Set`) | human models it, command checks |
| 2 | **unwrap + key** | `unwrap-weapon --survey`, `--recipe <mob>` | body -> `tools/atlas/sets/<mob>/{key.png,key-labelled.png,manifest.json}` | prints **verified**; island clash 0 for a solved layout | agent writes the recipe (`docs/mob-atlas.md`) |
| 3 | **base theme** | `image-request.mjs gen` + `import-atlas --set <mob> --theme <t>` | `sets/<mob>/prompt.md` -> `out/<mob>/<t>/atlas-seamblend.png` | importer has no unread warnings; background-triangle audit shows 0 | image generator, agent registers |
| 4 | **rig** | quadruped: `autorig --rig Dog.glb`; biped: **to build** (see gaps); or a hand/Codex rig in Blender | body -> `<mob>-rigged.glb` | has a skin; every vertex is weighted; the rest pose is not inside the floor | command, or Blender agent |
| 5 | **clips** | `retarget --anim` with a `rig-map.mjs` preset; `_gait.mjs` for quadruped gaits; Blender for bespoke clips | rig -> clips in the GLB | the **minimum set** is present (below) and `_clips.mjs` loop hygiene passes | command or agent |
| 6 | **bake + install** | `unwrap-weapon --recipe <mob> --atlas …`, then copy | -> `assets/models/mmo/mobs/<mob>.glb` | the installed GLB has the skin, every clip in the map and the base theme | command |
| 7 | **template** | to build: `mobs template` | GLB + `authoring/mobs/<mob>.json` -> template subtree (controller + visual/animator + `mob-brain` + `combat-actor` + `combat-caster`) | every clip the scripts will request resolves: `deathClip`, `staggerClip`, the anim of each ability on the bar | command |
| 8 | **fight proof** | to build: headless (server test harness, like `spawn-areas.test.ts`) | template -> `authoring/mobs/reports/<mob>-fight.json` | it spawns on terrain, aggroes, closes to `attackRange`, lands a cast, takes damage, staggers, dies, plays Death, and leashes home | command |
| 9 | **catalogue** | `zonegen bestiary` | -> its row in `authoring/zonegen/bestiary.json` | body `ready`, template filled, gate passes | agent |

**Clip minimum.** The reference is Anansi (`MMO/3d/Mobs/Anansi-final/Anansi.glb`, 15 clips:
Walk, two punch variants, Heavy_Slam, four directional hits, Leap, Cast,
Cast_Channel, Death, the Charge start/loop/stop). Every mob needs a core set
that the engine actually requests: `Idle`, `Walk`, `Run`, `Attack1` (strike),
`Heavy` (cleave), `Death` (one-shot, clamped) and one hit clip for `staggerClip`.
Anansi has **no Idle and no Run**, so even the reference fails this minimum
today. The clip map in `authoring/mobs/<mob>.json` maps names (`Attack1=Attack_Tripo_Punch`,
`Run=Charge`) so that a mob never needs special handling in a script. Directional hits,
Cast and Leap are optional extras that ability work can rely on once a creature lists them.

## Adding a theme to an existing body (the cheap path)

Zone variants and rares should take this path. It needs no human, no rig and no clips:

```
mobs theme <mob> <theme>   ->  prompt.md SUBJECT swapped -> gen -> import-atlas --theme -> bake -> install
```

Gates: the key hash matches the one the art was painted against (a recut key
strands every sheet), importer warnings read, one `look-<theme>.png` reviewed.
Status is per theme; a zone bestiary's `art-request` warning should print this
command. One GLB per body, themes as textures (already decided); the wolf's two
whole GLBs predate that.

## Gaps to build, by value

1. **Install step + a `needs-install` state.** The ogre (6 themes), ghoul
   (5 themes), ratkin (3 themes) and the whole Anansi body exist but are not
   installed in the project. This is the cheapest gap with the biggest unlock, and the
   bestiary schema currently has to call finished art `needs-art`.
2. **Biped rigging.** `autorig` measures quadruped landmarks only. The ogre,
   ghoul and ratkin are all bipeds. Options: a landmark-fitted humanoid donor
   (the UAL mannequin, which also brings UAL1/UAL2 clips and the `undead`
   preset), or a repeatable Blender/Codex recipe distilled from the Anansi run.
3. **The `mobs.mts status` command itself** and the `authoring/mobs/<mob>.json` record.
4. **Template generator.** The ratkin templates are capsules, and the wolf template is
   a placed entity that no spawnArea uses.
5. **Headless fight proof.** No mob has ever been proven end to end.
6. **Clip-name map** in the template, so donor names (`Bite`, `Attack_Tripo_Punch`) need no rename.
7. **Caster abilities on mobs.** Only strike and cleave reach any mob today.

## Decisions for the owner

- Biped rig: UAL-mannequin donor via an autorig extension **or** a per-mob Blender/Codex rig?
- Clip minimum: the seven listed above, **or** a larger set (directional hits, Leap)?
- Clip names: rename inside the GLB **or** use a map in the template?
- Themes: texture-only on one GLB (wolves migrate) **or** keep one GLB per theme?
- Anansi: add an Idle and a Run before install **or** ship it with Walk/Charge stand-ins?
- Ratkin: one creature with roles by theme **or** three creatures per template (current)?
- Undead: write a faction story for ghouls (+ undead ogre theme) **or** keep them as wildlife?
