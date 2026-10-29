# Next world dogfood — paste this into a fresh session

You are the coordinator of a one-zone proof run on a NEW world in the HitReg Engine repo
(`D:\Users\Derek\Desktop\HitRegStudios\Engine`). We are dogfooding how worlds are built: every fault becomes a tool
fix + a check, never a hand patch.

## Read first (in this order, then stop reading)

1. `CLAUDE.md`, then `docs/postmortems/skelmorrow.md` (the fault → check table; every row dated 2026-10-28/29 is a
   lesson from the last world).
2. `apps/playground/projects/firstshore/authoring/RUN.md` → "Standing rules" and the whole Decisions list (or its
   archived copy under `HitRegStudios/projects-archive/firstshore/` if firstshore has been archived). Those rulings
   bind this run.
3. The four tools-round briefs that must have LANDED before you start: `docs/briefs/site-needs-and-town-siting.md`,
   `docs/briefs/concept-on-site.md`, `docs/briefs/town-design-phase.md`,
   `docs/briefs/dc-risers-and-handmade-walls.md`. Check each one's commands exist and its tests pass. If one is
   missing, finishing that tool is your first job.
4. Skills: `world-standards`, `zone-creator`, `site-finder`, `town-planner`, `poi-creator`, `grand-entrance`.

## State of the new tools (2026-10-29, read before trusting them)

- **Site needs + agent siting** (`tools/site-needs.mts`, `worldgen towns --propose/--pick`, `zonegen sites
  --propose`, `reserve --pick`, `worldgen needs`, briefs `tools/zonegen/briefs/site-{towns,places}.md`): built and
  tested. It caught both firstshore misfits on the real ground.
- **Concept on site** (`zonegen concept`): built, committed, and proven on proving's Hrimgard. Its repaints come
  out painterly rather than PSX. Use them to judge fit, not style.
- **Town design** (`tools/town-design.mts propose|check|render`, `worldgen terrace --from-plan`,
  `town-layout --from-plan`, designer brief `tools/zonegen/briefs/town-design.md`): works end to end. But its own
  test towns still read as ROWS on stacked shelves, and the `rows` check passed them. Tighten that check first:
  parallel bands with one street each must fail. Then use a SEPARATE designer agent, never the coordinator or the
  check tool, and judge the plan picture against the concept on site.
- **DC risers** (`features.dcRisers`, the per-riser rule picks bank / DC riser / kit wall): DC is the default for
  a built riser. Its rubble/damp/top tiles did NOT show on the DC face in the untextured lab, so prove the paint in
  the new world's first town before passing it. The town wall's `handmade` option exists but `town-wall-line` does
  not pass it yet: wire it. `tools/handmade-check.mts` is standalone: hook it into `terrace-place --check`.
- **Armor**: dungeon loot is planned per source (`armor loot-plan`, EQ style: named pieces off specific mobs and
  areas, mixed weights per sheet, a full set only when the dungeon's size, difficulty or a zone-spread rule calls
  for one). Use that for the new world's dungeon, never four full kits.

## Stage 0: clear the old world

Move `apps/playground/projects/firstshore` (and `shackle-halls`, `pb-*` labs it made) to
`HitRegStudios/projects-archive/` with a line in the archive README. Check that `projects-archive` and every
project's `--check-deps` stay clean. Ask Derek once before the move; that is the only question before the walk.

## The world (algorithm-driven; nobody hand-edits terrain)

A new project with `dependsOn: ["foundation", "world-kit"]`. Climate: red sandstone sea cliffs over dry scrub, a
river-valley oasis, pine highlands. That gives 3-4 biome anchors with legal transitions and at least 5 feature
kinds. Run `worldgen dogfood --seeds N` and look at the contact sheet yourself. Pick a seed that already offers
(a) a real cliff face tall enough for a grand entrance, (b) cliff flanks or a neck for a walled town, (c) a
sheltered cove. If no seed does, put those needs in the recipe's `needs` list and let the generator make them. Run
`worldgen status` until there is no STALE. Look at the map before passing the stage.

## The proof scope (then stop)

ONE town, ONE place (large POI), ONE dungeon entrance. Each one goes through the new order:
1. **Site needs → propose → agent pick.** A fresh siting agent opens the bare-terrain renders and needs scores,
   and writes the choice file. The tool refuses a pick that fails its needs.
2. **Concept on site.** The concept tool renders the bare site from the approach and from far. Codex repaints
   those renders. Text-only concept frames are refused.
3. **Town design first.** A designer agent writes the town plan: streets across the slope, a square, the landmark
   seen from the gate, footprints at kit-proven sizes, and terraces designed to hold them. The plan must pass
   `town-design check`. Approve the plan picture yourself, then `terrace --from-plan` and
   `town-layout --from-plan`.
4. **Grey box → fresh reviewer → detail → fresh final reviewer → install.** Do not use `--force-dogfood` unless
   Derek asks to see something unfinished.

## Agent hierarchy (binding)

| role | who | does |
|---|---|---|
| coordinator | you | decides, briefs, looks at EVERY picture before passing a stage, installs (the only writer of the live world/scene), commits each tools round |
| owners / masters / siting / designer / world-fix agents | Opus (`model: "opus"` on every spawn) | terrain, structures, routes, plans, tool fixes; one owner per place; fresh briefs in `authoring/briefs/`, never forks |
| reviewers | fresh Opus, never the owner | grey-box and final reviews against the rubric and Decisions |
| dressers / placement | Sonnet (`model: "sonnet"`), one per area, one at a time | every loose prop BY NAME through dressing plans |
| art | Codex (GPT), art only | concept repaints on site renders, PSX textures, LARGE set pieces (gates, arches, façades, monument parts), armor sets via `armor` |
| fine props | Derek | missing small props go on `authoring/props-for-derek.md` with the concept frame; never generated |

At most 5 concurrent agents (6 on this 64 GB box if the heavy lock allows). One Blender at a time
(`tools/blender-lock.mjs`). Probe ports per owner; never touch :5173; never kill a process by name.

## Standing rules (short)

No ships/wrecks/hulls/boat walls. No switchbacks. Roads carved + painted. Structures seat on ground. Raised
foundations. Town walls in town masonry, on ground that defends the town, never overlooked. Retaining risers are
banks, or DC risers that feel hand-built. KISS classic-MMO geometry, texture-led PSX, dark high fantasy. 60%
reusable props. No iteration files; overwrite in place; git is history. Human out of the loop: fix through tools,
log the fault → check row, keep going, never ask mid-run.

## The one ping

When the town, the place and the entrance are installed, reviewed, and walkable on the server: send Derek
`?scene=<world>&server=ws://...` plus the player-height shots (day and night). Keep the ledger in the new
project's `authoring/RUN.md` with the model column filled from the spawn calls.
