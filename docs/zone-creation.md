# Running a zone

How a coordinating session takes one zone of a generated world from its cast row to a place that feels hand-made and
alive, with no person in the loop. `docs/zone-pipeline.md` holds the mechanics and `zonegen status` holds the order;
this file says how to RUN that order: phases, who does each, budgets, the reviewer gates, the install queue and the
ledger. Standards the work is held to are TASK SKILLS, named per step below (index and the not-encoded list:
`docs/world-standards/README.md`).

The owner's test for a zone is not "do the quests work". It is "does every place feel hand-made and alive". Every
phase below serves that test; the quest loop is the last phase, not the first.

## The phases

| # | Phase | Who (proposal; the owner may reassign) | Budget | Gate | Skills |
|---|---|---|---|---|---|
| 1 | Zone design: brief WITH places, bestiary, town plans, quests, reserve, freeze | one Opus zone master | 300k | lints + design review | `site-finder`, `site-standards`, `dungeon-standards` |
| 2 | Look: zone ground tiles, town style, place moods, site role tiles | Opus look agent, GPT draws | 150k | `worldgen status` zone-textures, style sheet, look review | `zone-mood`, `terrain-edits` (vegetation), `building-styles` |
| 3 | Places: each town, each signature place, each dungeon | one Opus owner each, about 3 at once | town 300k, large place 400k, medium place 300k, small place 150k, dungeon 450k (measured on zone-3: a medium place could not finish under 180k) | owner's gates + grey-box review + final review | towns: `town-planner`, `building-constructor`; places: `poi-creator`, `terrain-edits`, `site-dressing`, `prop-intake`; dungeons: `dungeon-build`, `dungeon-lighting`, `portals` |
| 4 | Life: packs, patrols, named creatures | coordinator (populate, site-packs), Sonnet for site-pack rows | 60k | populate gate, encounter review | `encounter-standards` |
| 5 | Interiors | one Sonnet per building | 80k each | `dress check` + `dress walk` | `interior-standards`, `prop-intake` |
| 6 | Quests: items, bind, text, wire, bind-check, play | coordinator + Sonnet writers | 80k per writer | quest-play | `town-npcs` |
| 7 | Zone review and report | Opus reviewer | 120k | whole-zone review on the map | `world-standards` + rubric |

## Who spawns whom, and which skill each agent loads

The coordinator (this session) never builds a place itself. It spawns FRESH sub-agents (never forks) with a written
brief, names the skill each must load, and installs what they deliver. Owners may spawn their own workers; workers
never spawn further. A brief points at skills and standards; it never restates their rules. **Model split (owner ruling, 2026-10-01, re-stated 2026-10-05):** GPT draws art only; Sonnet places props (interiors, town exteriors, sites) through dressing plans; Opus owns layout, terrain, structures and masters. An Opus owner that writes prop transforms in its own build script is a fault.

| Agent | Spawned by | Loads | Spawns |
|---|---|---|---|
| Zone master | coordinator | `zone-creator`, `world-standards`, `site-finder`, `site-standards`, `dungeon-standards`, `zone-setup` if the borders need work; prints its stage briefs with `zonegen brief-for` | Sonnet workers for the zone bestiary and reserve rows |
| Look agent | coordinator | `building-styles` (style files), `zone-mood`, `terrain-edits` (region vegetation), `docs/image-generation.md`, `docs/dungeon-materials.md` for dungeon tiles | none (GPT draws through `image-request.mjs`) |
| Town master (Opus) | coordinator | `town-planner` (incl. wall, settle, wear, lights), `building-constructor`, `town-npcs`, `interior-standards`, `site-finder` (wall line), `terrain-edits` | Sonnet residents writer; Sonnet dressers (`brief-for dress-building`) one per building; Sonnet exterior dresser on `town-exterior` sockets |
| Place owner (Opus) | coordinator | `poi-creator` (via `zonegen poi-brief`), `site-standards`, `terrain-edits`, `prop-intake` (prop requests), `portals` (dungeon door), `encounter-standards`; `statue-maker`, `fall-crafting`, Blender MCP (`docs/blender-dc-authoring.md`) when the place calls for them | none. Owns terrain, structures, routes, anchors (hearths, tent doors, cave mouths) and the site socket map. Does NOT place loose props by transform |
| Site dresser (Sonnet) | coordinator | `site-dressing` (site socket map, `props menu` / `dress check` / `dress apply`), `prop-intake` | none. Places every loose prop BY NAME through a dressing plan (owner ruling: Sonnet does placement) |
| Dungeon owner (Opus) | coordinator | `hitreg-dungeon-authoring` (`.claude/skills/hitreg-dungeon-authoring/SKILL.md`), `dungeon-standards`, `dungeon-build`, `dungeon-lighting`, `portals`, `encounter-standards`, `interior-standards`, `docs/dungeon-materials.md` | Sonnet dressers per room group when the dungeon has a socket map |
| Art workers | coordinator | `item-icons`, `item-looks`, `armor-sets`, `weapon-unwrap` (skins), as the asset manifest row names | none |
| Quest writer | coordinator | `town-npcs` (dialogue rules), the bind task file | none |
| Reviewer | coordinator | `docs/world-standards/review-rubric.md` + the skill of the work (gates first) | none |

A budget is a cap given in the brief. An agent that reaches it reports what is done and stops; the coordinator decides
whether to resume it by id. Record what every agent used in the ledger: the next zone's budgets come from those numbers.

### 1. Zone design (places before quests)

`zonegen status <world> --project <p> --zone <z> --next` names the first row. The zone master runs the planning rows in
order with `zonegen brief-for <stage>`. What changed after the first zone:

- **Places come from the ground, first** (skill `site-finder`). The first planning row is `zonegen sites <world> --project <p> --zone <z>`:
  it reads the heightfield, water, roads/paths and everything already reserved, and lists scored land features
  (canyon ends, cliffs over water, plateaus and mesas, peaks, passes, wall gaps between cliff and shore, coves, falls,
  path dead-ends and switchback tops, the largest empty land), each with its approach: which road, how far, the
  climb, how much road sees it, which way it should face. It draws them on the review map
  (`zones/<z>/reports/sites.png`, `--focus x,z,r` for a close-up). The zone master picks places from this list and
  the picture before writing the brief, and each place records its pick (`site`). The gate fails while a climbing
  path leads nowhere, a large landform is empty, the largest empty disc of land exceeds its limit, or the zone has
  too few places per km2 (thresholds in `tools/zonegen/commands/_site-finder.mts`); re-run it after reserve, and the
  freeze requires it.
- **The brief designs the PLACES** (`places` in the zone brief, `placeSchema`): per place a one-line read, a
  landmark, linked features, a set piece, the one thing unique in the zone, a mood, a holder, named people and
  creatures, and its OWN dungeon when it is a landmark. The brief lint refuses a large place with fewer than three
  features, fewer large places or dungeons than the budget promises, and two places sharing a set piece, a landmark
  or a unique thing.
- **Quests attach to places.** Each place is a quest location of the same id and size; its sub-sites and dungeon
  entrance carry `place`. The quests lint refuses a place with no location, a resized place, and a place whose
  dungeon has no entrance there.
- **Design for the creature, even with no body yet.** A bestiary creature whose body is not rigged still gets its
  places, quests and looks designed for it; populate stands a labelled placeholder until the owner's body arrives.
  Never shrink a place because its creature is a capsule today. List in the ledger which bodies the zone waits on.
- **Size from the standards.** Reserve every large place with a terrain radius that holds its land features (caves,
  shores, cuttings are terrain). A site "on the shore" is reserved ON the shore.
- **Read the neighbours' briefs** before choosing set pieces and landmarks; the zone audit compares them.

Then the design review (below). Only after it passes: `zonegen freeze`.

### 2. Look

Before anything is built, so no builder falls back to a kit default (a missing tile is generated, never left grey):

- Zone ground: the cast palette's tiles (`authoring/zonegen/palettes/<palette>.json`), drawn with
  `image-request.mjs gen-set`, applied with `worldgen zone-textures`. Town streets get `paving`.
- Town style: pick or write one style file (`MMO/WFC/styles/<name>.json`, `MMO/WFC/STYLE-MAKING.md`) and run
  `style_make.py`. A style the zone needs and no file has is made here, not by the town master.
- **Zone mood** (the air and light; skill `zone-mood`, gate `zone-mood.mjs lint`): recipe `regions[].mood` (`regionMoodSchema` in packages/core/src/voxel/regions.ts:
  sky, haze, amount, light, lightScale, shade, fogDensity, mist, saturation, contrast, temperature), played by the
  `zone-mood` builtin, which eases it in over the day/night cycle when the player crosses a border. The house look is
  dark and foreboding; a zone's mood shifts that tone (cold pine shore, sickly bog), it never brightens it into a
  postcard. Neighbouring zones' moods must differ visibly; borders blend over `blendSeconds`.
- **Place moods**: a signature place whose brief `mood` breaks the zone's gets a NESTED region (`within` the zone,
  the place's id, a polygon round its reservation) with its own `mood`; a nested region wins under the player, and a
  nested region without a mood (a town) wears its zone's. The same place mood also sets region overrides on scatter
  and cover (dead trees, bare ground, reeds) and its own role tiles where it breaks the palette. Plants come only
  from the foliage system.
- **Place moods now set vegetation through data** (skill `terrain-edits`): `regions[].vegetation` on the zone (its palette's species: no
  palms on a northern shore, `margin` when its border runs along the waterline) and on each place region ("a few
  wind-bent pines", "dead pines, bare spoil"), written with `worldgen vegetation --region <id> --set`; site
  footprints are `features.clearings`. Example installer: `authoring/zonegen/proving/zones/zone-3/look/vegetation-install.mts`.
- Gate: the zone row `mood` (zone mood set, every place mood applied, the scene runs `zone-mood`). A fresh world's
  scene gets the `zone-mood` entity only if `authoring/zonegen/scene-systems.json` copies it: check before a run.
- Creature skins for rares and named creatures are asset-manifest rows (art only); bodies are not this phase's work.
  An oversized one (a giant croc, a hulking troll) is the base body with a bestiary `scale` — no new body needed;
  docs/zone-pipeline.md says what populate sizes with it.

### 3. Places

One owner per town (town-planner, building-constructor, town-npcs skills), per signature place (poi-creator skill,
`zonegen poi-brief`; ground through `terrain-edits`) and per dungeon (hitreg-dungeon-authoring + dungeon-standards,
built and gated with `dungeon-build`, lit with `dungeon-lighting`). Both doors of a dungeon follow `portals`. A dungeon's owner starts once its
place's entrance is reserved; the place's owner builds the entrance passage and the portal anchor, the dungeon's
owner builds the inside.

**Quality bar (owner ruling 2026-10-05).** No bare primitive stands in for an object (a sphere as a boulder, a box as a
cauldron). Primitives are fine when composed into something that reads as real (the Silkroot Grove used primitives +
alpha cards); the judge is the picture, not the method. Land is terrain, buildings come from the kit, crafted
structures from Blender->DC, objects from the catalogue (wrap, variant, compose).
One strong idea per place, not a checklist of features. Every review compares the pictures side by side with the
owner-approved references (Fieldfast Barrow, Fieldfast Hall estate, Old Watch). Nothing installs before the final
review passes.

Every owner works in two passes with a cheap look between them:

1. **Grey box**: massing, routes, the room or feature list, the encounter map, a plan picture and three player-height
   pictures. Stop and deliver.
2. **Grey-box review** by a fresh reviewer agent with the rubric (below). Pass, or named faults back to the SAME owner
   (resume by id). Two returns at most; then the work proceeds with the fault logged in the ledger.
3. **Detail**: texture, dressing, lights, named creatures' spots, set piece, evidence. Then the final review.

**Dungeons run on the shared pipeline.** A dungeon's `authoring/pipeline.mjs` imports `tools/dungeon-pipeline`
(README there) and names only its own paths and commands; it inherits every build stage and the quality gates
`noise`, `originality`, `stairs`, `atlas`, `matte`, `recipe`, `culling`, `readability` and `compare` (then `portals`
and `portal play`), whose numbers are `tools/dungeon-pipeline/thresholds.json`
(what each failure means and its fix: skills `dungeon-build`, `dungeon-lighting`). A FAILED gate blocks `--next`, and `zonegen status`
shows the failing gate on the dungeon's row, so a flat, sparse, tinted or cloned dungeon is never "done". A justified
miss goes in the dungeon's `authoring/quality-exceptions.json` with its `why`, never in the thresholds. The detail
pass ends with every gate passing and `reports/compare.png` judged beside the reference dungeons.

Owners deliver installers; they never write the shared world or scene (one writer, below).

Owners do NOT place props as transforms in build scripts (skill `site-dressing`; missing props: `prop-intake`). Opus owns layout, terrain and structures; outdoor props go
through `tools/site-sockets.mts` (owner declares `siteDressing` areas in `handoff.json`) and one fresh Sonnet per area
(`zonegen brief-for dress-site --poi <id> --area <area>`); gate `site-dress <poi>` (docs/zone-pipeline.md, Props).

### 4. Life

- Skill `encounter-standards`. Each place hands over its clearings; the coordinator writes `zones/<z>/site-packs.json` (mixed packs, a named
  leader, patrol routes when the format has them) and runs `zonegen populate` + its installer.
- Named creatures: one near each large place's edge, more further in, each with its own skin row and loot line.
- Acceptance is on the dedicated server with creatures spawned (skill `world-standards`); a count only true
  on paper is not reported as seen.

### 5. Interiors

`zonegen brief-for dress-building` per building, one fresh Sonnet each, about 5 at once (interior-standards skill).

### 6. Quests

In order: town-owned quest objects, `zonegen items`, `bind`, a Sonnet writer per few quests (tasks in
`zones/<z>/bind/tasks/`), `wire`, `bind-check`, `quest-play --plan <quests.json> --changed`. Proven quests are not
replayed unless their inputs changed.

### 7. Zone review and report

A fresh Opus reviewer walks the whole zone from the map (every place, the roads between, sight lines from the roads)
and from player-height pictures on the server, against the rubric's zone section. Its findings go back to owners
once; what remains is logged. Then report to the owner: the map with every place labelled, one sheet per place, the
ledger's open list (bodies waited on, faults logged, rows with no gate).

## The reviewer

A reviewer is never the agent that built the work. It gets the rubric (`docs/world-standards/review-rubric.md`), the
skill of the work (its gates first), the review map (`zonegen map <world> --project <p> --zone <z> --dev`, a labelled PNG + a .json of
every mark), the pictures and the measured reports, and nothing of the builder's reasoning. It answers
pass, or a numbered list of faults, each naming the rubric line, the evidence and the place (coordinates). Measurable
lines first, taste last. Budget 60-120k; it reads at most 12 pictures.

## One writer, an install queue

Only the coordinator installs into the world recipe and the zone's scene. Owners deliver `install.mts` (+ ops,
world-ops, inverse). Install one at a time; after any install that moves ground or re-places entities run, in order:
town-entities install, `zonegen wire`, `bind`; after a town re-install re-apply its interiors (install drops them);
after ground changes re-settle the spawn and check placed anchors. Then `zonegen status` for the zone.

## Lessons

A lesson becomes a check in a tool or a line in the task skill that owns it (Gates or Judgment), between runs. The
raw log `docs/zone-creation-lessons.md` keeps the evidence only; a rule nobody can check yet goes on the one list,
`docs/world-standards/README.md` "Not encoded yet".

## The ledger

`zones/<z>/RUN.md`, written by the coordinator only: per agent its id, model, task, cap, tokens used, stage, and what
was installed; faults logged after two returns; bodies the zone waits on; decisions taken on OPEN standards lines.
`zonegen status` is the truth about the work; the ledger is the truth about the run (resume after a rate limit reads
it first: resume agents by id, never restart a half-done owner).

## Concurrency

About three Opus owners at once, refilled as slots free; Sonnet dressers and writers about five at once. Near the
usage cap, slow down to one agent and small jobs; never stop running agents without asking the owner.
