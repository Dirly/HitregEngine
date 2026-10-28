# Skelmorrow post-mortem (2026-10-10 to 2026-10-26)

Skelmorrow was the second generated world and the first built mostly by agents
through tools. Derek tabled it on 2026-10-27: "a lot of things were done wrong,
a lot of things need fixing, the POI tooling got abysmal, a lot of stuff didn't
make sense, even the towns didn't duplicate well." This document is the
evidence behind that verdict and the list of checks that come out of it. The
lessons are general; the places are only evidence. Paths are relative to the
repo root; `P/` is `apps/playground/projects/skelmorrow/`, `R` is a line of
`P/authoring/RUN.md`, `W1` is `P/authoring/W1-report.md`.

## Verdict in three lines

- Content was built before the tools that build it existed. The place builder,
  its gates and its review bar were all written mid-run, one gate after each of
  Derek's walks, so every place built before a gate carries the fault it checks.
- Done was defined as "every numeric gate passes". Composition, story and look,
  which are what Derek judges, were never blocking. Agents optimised to the
  gates and the places read as nothing.
- The process spent its budget on waiting and re-reading, not building: nine to
  fifteen agents queued on a two-slot lock, owners kept alive for 17 passes on
  one place, and nothing committed for ten days.

## Numbers

| Measure | Value | Source |
|---|---|---|
| Places planned (reservations) | ~166 | R797, zone briefs |
| Places with a job folder | 54 | `P/authoring/zonegen/skelmorrow/zones/*/pois` |
| Places installed in some form | ~47 | progress.json stages |
| Of those: forced in over a RETURN or FAIL verdict | 4 (7 forced installs) | progress.json `forcedInstalls`, R1087, R1118 |
| Places counted as physically finished after the narrative pass | 1 (peat-banks) | `P/authoring/narrative/status.json` |
| Installed POIs that passed the gates on the first audit | 0 of 11 | R531 |
| Reviews on the worst place (Old Kings + Kings' Path) | 9 | R-R1, R-K, REV-OK |
| Owner passes on the Weeping Stair | ~17 | R216 |
| Dungeons installed / planned | 4 of 8 projects | `P/project.json` dependsOn |
| Quality exceptions per installed dungeon | 12 to 29 | `*/authoring/quality-exceptions.json` |
| Terrain-fine cells passing only by exception | 1,565 (503 legacy + 1,062 ruled) | `worldgen status` |
| Towns | 3 built, 3 live | W1:37-41 |
| Distinct building shells per town | Cindermoot 12 of 17 lots, Hagsend 9 of 14, Reedholt 6 of 10 | md5 of `*-work/wfc/*/solution.json` |
| Scratch lab/proof projects still present | ~50, every one marked "delete when done" | `apps/playground/projects/*/project.json` |
| Iteration files found mid-run | 1,132 | R531 |
| Token spend on cache re-reads | 99 % (output 1 %) | `P/authoring/COST-NOTES.md` |
| Context rewrites caused by a >5 min lock wait | 243 of 249 | COST-NOTES |
| Budget on the Retting Ponds redo alone | ~7 % of the weekly 20x | R1065 |
| Commits during the build | 3, last on 10-16 | `git log` |
| Uncommitted work at the end | 529 files, ~57k lines | `git status` |

## Root causes

### 1. Tools came after the content

Proving went fast because towns came from the town builder and dungeons from
the dungeon pipeline. Skelmorrow's outdoor places had no builder when the zone
started (R505-506: a 419-primitive weir, a "stacked cubes" shelf, banned hull
walls). `place-build` landed on 10-19, gate 12 (size tiers) on 10-18, gate 14
(walk) on 10-18 after Derek fell through a shelf, the roads gate on 10-21 after
26 places had ribbon approaches installed, gate 16 (design) on 10-23. Every
place built before a gate had to be reopened for it, which is where the
3-to-9 review rounds came from.

**Check:** a zone run may not start a stage whose builder has no `status` row
and no test. `zonegen status` lists the builder version each place was built
with; a place built under an older gate set shows STALE, not ok.

### 2. Done meant "gates pass"

The reviewer brief said taste is logged, never blocking. The Gullet's PASS was
recorded by the coordinator itself (`P/.../the-gullet/review-final.md:5`).
Sonnet reviews passed places Derek later rejected (R866, R1047). "No nets
visible at net-green" became a prop request instead of a fail. After gate 16
made story a blocking question, three places were built and none was
installable, and a place that passed all 16 measured gates on chain 8 still got
RETURN because the builder re-fits positions every chain and cannot hold a
composition (gate16-first-day). The `layout.json` step fixed the mechanism; the
next gap (hero prop size at request time, overlap allowances) is logged.

**Checks:** reviewer identity rule (owner and coordinator may not record a
verdict); story/visual match blocking (P1-P6) with the concept frame beside
the shots; `--force-dogfood` removed or made to leave a FAIL row that blocks
the zone's status; a PASS table is never reported as quality.

### 3. The world did not make sense as geography

- Zones are Voronoi cells, one anchor each, 200 m blend, no climate adjacency:
  a cold shale moor touches a hot sandstone badland (`design-land.mts`
  anchors). A `fen` cell was drawn inside the badland by hash and patched by
  nudging a latitude number, which turned it into a 340 m massif (W1:151-156).
- No sub-biomes inside a zone: climate is flat per cell, so a zone is one
  biome in height bands. The Hagsheer cannot grow forest in its glens.
- Rivers could not reach the sea from their natural lakes, so every river
  starts at a hand-dug tarn (W1:45,56-59). Five lakes drain nowhere.
- The Hagsheer|Rustmarch border was ruler-straight, then an artificial ridge,
  then re-traced by hand onto an escarpment (W1:139-144, README:51).
- The procedural canyon stage made a 121 m zigzag on the Spine and was
  removed; gorges are hand-written (W1:84).

**Checks:** continent climate model (tabled 2026-10-27: continent band and
wind, one anchor per zone, sub-biomes from local ground); a zone-draw score
that fails neighbouring anchors beyond a climate distance; a hydrology check
that every lake either drains or is declared endorheic by the recipe; a border
check that every zone border lies on ridge/river/coast/escarpment for at least
a stated share of its length.

### 4. Towns: the solver repeats itself and the process did not repeat

Two readings of "didn't duplicate well", both true:

- **Buildings duplicate when they should not.** The WFC solver is seeded with
  0 and deterministic (`../MMO/WFC/wfc/core.py:23-24`, `run.py:18`), and the
  requested features (fireplace, shopfront, storeys) do not change the solved
  shell. Cindermoot's smithy, pawnhouse, embalmers, stonecutters and candle
  shop are byte-identical; Hagsend's hale, lowe, tull and weir likewise;
  Reedholt's smokehouse (asked for 1 storey) equals two 2-storey lofts, and one
  Reedholt hut is the same shell as a Hagsend cottage. The planner skill's own
  rule ("no two neighbours identical") has no check.
- **The town process did not duplicate.** `town-install` only installs merged
  district models, so each town got its own hand-written installer (162, 316
  and 337 lines), each a copy of the last. Each town hit new shared-tool faults
  (setback, floors dropped on re-layout, streets not snapped to gates, plank
  street tiles, palisade seating). Resident ids are scene-wide, so Reedholt's
  smith overwrote Hagsend's; the same first names recur in all three towns and
  a Reedholt quest mirrors a Cindermoot one. Cindermoot's ring wall still runs
  through the chapel, the smoke-tower and the smithy (`wall-clear.json`,
  `ok:false`, unresolved).

**Checks:** per-lot seed derived from town+lot and a distinct-shell gate
(hash of the solved shell unique per town, and features must change the
shell or the request is refused); one generic `town-install` that installs
any town from its plan; a cross-town id and name lint; `town-wall-clear` as a
zonegen status row; floors re-grounded by default.

### 5. Process burned the budget

- 99 % of tokens were cache re-reads; 243 of 249 big rewrites followed a
  lock wait over five minutes. Owners ran to 300-729k context against a 200k
  cap (R100, R324).
- Up to 10 agents at once, 15 queued on the heavy lock (R593, R1028); a shot
  job hung 4.5 h (R657); three BSODs plus garbled lab-world writes.
- Owner churn: 17 passes on one place, 12 on Ironspur which was then parked.
- Agents broke shared state: `git checkout` wiped another agent's code (R298),
  `git stash` was run (R553), the coordinator broke `place-build.mts`
  mid-batch (R719). A write race lost 551 world features (R910).
- Rulings reversed mid-run (scree fan, kit vs wall-operator, ribbon approaches).
- Nothing committed from 10-16 to the end; ~50 scratch projects never deleted;
  eight `*-tmp-*` scripts and an `apps/tmp-noop/` after the no-iteration-files
  rule.

**Checks:** one owner per place, retired at ~150k context with a handoff;
build/shots/gates as one locked script; at most 2 heavy agents; agents may not
run git commands that move the tree; a scene-write lock (built 10-21) and a
world-file validate on every read; `zonegen labs --sweep` that deletes every
lab/proof project whose install is stamped; a commit at the end of every
tools round, by the coordinator, with `pnpm test` green.

### 6. Pipeline integrity rotted

- `worldgen status`: float and water-logic never swept clean, rock-skins
  STALE; terrain-fine ok only through 1,565 exceptions; floating cover went
  266 → 352 → 200 and is still not clean (known cause in `voxel-ground.ts`).
- Dungeons carry 12-29 quality exceptions each.
- `zonegen status` crashes on one unparseable stamp input
  (`_town-stamps.mts:35`), so there was no zone table at the end.
- Lab copies shadow live assets through the closure (R287, R512); a
  coordinator "installed" claim was false (R733).
- Portals: a door with no portal, arrival spots inside rock, a dungeon
  missing from `dependsOn` (R510, R691, R792).

**Checks:** exceptions expire (each carries a date and a reason; status shows
the count and fails over a cap); status never crashes on one bad input, it
prints the row as BROKEN; lab projects cannot be in the closure of a live
scene; `portal play` on every portal is a zone status row.

## Fault to check table

Faults Derek found by walking, each with whether a check existed at the time
and the check that owns it now. Grouped by the tool that must carry it.

| Tool | Fault | Had a check? | Check to build or keep |
|---|---|---|---|
| worldgen zones | hot zone beside cold zone; fen drawn inside badland | no | climate adjacency score on the draw; continent band |
| worldgen zones | no forest in sheltered glens | no | sub-biome windows: coast, water, shelter, aspect |
| worldgen rivers | rivers start at hand-dug tarns; lakes without outlets | audit (buggy) | every lake drains or is declared; outlet offset test |
| worldgen barriers/paths | barriers moved under trails; 36 m embankments; lips 642 → 1744 | lips gate | stage order enforced; barriers after trails refused |
| worldgen float/scatter-float | 200+ floating tufts, lattice probe straddles lips | gate, never clean | fix probe at risers; status row must be ok to install |
| worldgen roads | ribbon trails buried, 26 ribbon approaches | no | carved+painted only; roads gate (built 10-21) |
| worldgen seated | ruins on a flat pad over a slope passed min-contact | wrong rule | max daylight gap along perimeter ≤ 0.05 m |
| voxel floaters | floating voxel islands along the river | no | floaters stage (built) as a required row |
| rock-skins | grey rocks on sandstone, tan on blue cliff, sand caps at snow altitude | no | zone role palette; caps follow the climate band |
| zone-textures | ground tiles climbing cliff faces; plank street tiles | no | slope-band sample gate; no wood as ground/paving |
| place-build | requested story prop silently not placed; 31 quest objects dropped | no | refuse at plan if a named prop cannot be placed |
| place-build | density top-up multiplies hero props (3 wagons) | no | hero class caps at 1 |
| place-build | pockets 120-150 m apart; no frame holds the place | no | pocket spread cap per tier |
| place-build | positions re-fitted every chain; composition lost | no | `layout.json` honoured exactly (built 10-24) |
| place-build | hero props too small (bell); texel floor caps scale | no | prop size at request time; Codex makes it at size |
| place-build | 9 m tower reads as 3 m | no | silhouette ratio (built 10-23) |
| place-build / site-finder | sites on 40° slopes, cove floor under water, 365-1300 m from any road | no | site search in plan (built 10-20); road reach gate |
| dress (outdoor) | props as clutter in one square; room rules used outdoors | no | vignette layout step, Opus layout, Sonnet by name |
| dress | graves not in rows; signs over windows; pews/altar/lectern faults | partial | arrangement rules in dress check (rows, over-door, clearance) |
| dress | flat-art stand-ins where a modelled prop exists (skull) | no | catalogue intake lists un-cut Blockbench elements |
| props | missing story props (gibbet, coffins, nets, turf huts) | no | prop request to Codex as a tool, 60 % reuse share |
| props | bare wheel pairs, camp banners at shrines, giant logs | no | culture and setting on every prop; filler from the story set |
| poi-review | self-certified PASS; stale or in-geometry cameras | partial | reviewer identity (built 10-18); camera clearance (10-21) |
| poi-review | places passing gates that read as nothing | no | gate 16 blocking P1-P6 with concept beside shots |
| poi-review | install forced over RETURN | no | no `--force-dogfood`; FAIL blocks the zone |
| town kit (WFC) | identical shells; features ignored | no | BUILT 2026-10-28: per-lot seed (`wfc/build.py seed_of`: `--seed`, the lot's `seed`, else crc32(town:lot)); every RESULT carries `seed` + `shell` (digest of the placed pieces); gate `tools/town-palette.mts check --results <build>_results.json` (no two lots with one shell or one seed) |
| town kit (WFC) | every house in a town the same style (a style = one wall + one roof baked into its kit; `build.py` one style per run; Cindermoot 17 x badland-stone) | no | BUILT 2026-10-28: palettes (`MMO/WFC/styles/palettes/<name>.json`, KIT-RULES 37); `build.py` groups lots by style and reloads the builder chain per group; `tools/town-palette.mts assign` (per-lot hash, quota-balanced, stone types stay stone) and `check` (no two adjacent lots share wall AND roof; shares within +-15 points) |
| town kit (WFC) | corner stones "not foundational", a second block band at grade (quoin column on LargeStone over a LargeStone plinth over the ExteriorBottom footing) | no | BUILT 2026-10-28: quoins are `trim.quoins` (off by default, `STONEWALLS_QUOINS`), plinth course on the wall tile; gate `tools/town-kit-check.mts seams <glb>` (exterior vertical faces on the wall roles only; LargeStone faces are findings) |
| town kit (WFC) | two-material seams: ground band (`ExteriorBottom.png`) a different tile from the upper wall, seam at the first beam, tiling at the base | no | BUILT 2026-10-28: `style_make` maps the ground role to the wall tile and `Generated/make_sill_tile.py` draws the sill at v 0.4 into it (one tile, the pattern runs through); gate `town-kit-check seams` |
| town kit (WFC) | "the smoke stack on the roofs doesn't work": every hearth an outside gable stack from grade past the ridge (a stone pillar glued to a timber house) | no | BUILT 2026-10-28: chimney mode `roof` (default; R71: `FireplaceWallIn` + a short stack through the roof 0.5 cell inside the gable wall) / `wall` (`tall_chimney`, open halls); gate `town-kit-check smoke <glb>` (every chimney-top marker found by the engine's `findChimneys`) |
| engine render (`chimney-smoke.ts`) | `findChimneys` kept at most SIX stacks per model and barred caps under 45 % of the MODEL's height; a district is one merged model (17 houses + a tower), so most stacks never smoked | no | BUILT 2026-10-28: cap 64, bar min(45 %, 4 m); the smoke gate runs the engine detector on the exported model, never a sheet |
| town kit export (`export_town.py`) | materials merged by image BASENAME: a town with two styles showed one style's `ExteriorNormal.png` on both | no | BUILT 2026-10-28: merged by image file path; `town-kit-check seams` per building catches a foreign wall tile |
| kit tiles | the kit root's `StuccoWall.png` / `WoodWall.png` are byte copies of `ExteriorNormal` / `InternalWAll`: a "stucco" or "plank" style was timber-frame / an interior wall | no | BUILT 2026-10-28: `style_make` verify line `wall tile` FAILS when the wall material's tile is a byte copy of another role; `themes/firstshore/` carries drawn stucco + plank tiles |
| town kit (WFC) | ruins show through their walls: every kit wall piece is two sheets 0.4 m apart with all edges open (`WallExterior` 2 faces, 8 open edges), so a bay that falls or a corner that drops exposes the neighbour as a hollow slot; shipped ruins have 20-37 open wall ends each, intact houses 0-3 | no | close pass in the kit: cap every exposed wall end and top with a solid core face (the R20 `WallEndcap` idea, for outer walls, ragged for ruins); open-end gate = 0 paired open vertical edges on the exported GLB |
| town-install | a new installer per town | no | one generic installer from the plan |
| town-npcs | id clashes across towns; names reused; duplicate geography rows | id lint (late) | cross-town id and name lint; doc generator test |
| town-wall-clear | wall through three buildings; model 1-8 m bigger than its envelope | tool, no row | status row; envelope = model bounds gate |
| town-ground | streets off the gate by 1.4 m; floors dropped on re-layout; floors coplanar with door paths | partial | gate snap (built); re-ground default; door-foot test |
| dungeon pipeline | see-through holes, floating props, one splatter decal everywhere, water edges | gates added 10-13 | keep; exceptions expire |
| dungeon water | water from the ceiling, opposite flows | no | one still level per dungeon (ruled 10-25) |
| portals | door with no portal; arrival in rock; dependsOn missing | partial | `portal play` per portal as a status row; closure check |
| culling | stairs and towns visible beyond loaded terrain | no | placed entities culled at the streamed horizon |
| streaming | sprint outruns chunk load and LOD | no | sprint-streaming harness: ready distance ahead, LOD latency |
| zonegen populate | undead at the starter town: the kirkyard rows anchor on Hagsend's own graveyard (365 m from centre, 110 m radius, 2 by day / 5 by night) and the whole-moor solo row carries Risen Bones up to 25 m past the town box; five undead template bodies stand in a ring in the graveyard in local play | no | BUILT 2026-10-27: populate `hub-halo` (roamers error, camps warn, `--hub-halo` 300 m, radius included; 14 hits on the Hagsheer). Open: night-only rows hidden outside their hours; templates hidden in local play |
| dress (interior) | props a cell or two from a door block the way in | 1.2 m `opening-clear` | BUILT 2026-10-27: `OPENING_CLEAR` 2 m in front of every doorway, entry and hallway mouth, both sides (core dressing resolver; tests moved) |
| town builder (interior light) | every house interior is black at night | lanterns on streets only | BUILT 2026-10-27: `town-lights check` fails any building with a door and no light inside its footprint (Hagsend: 1-8 per house, so the fault is intensity, not absence). Open: the interior light STEP and a night shot gate per dwelling |
| window prop / render window-lights | window panes glow from the inside at night; from outside lit and unlit houses look alike | no | BUILT 2026-10-27: glow on the street face only (inside face dark at night), every window of a house lit, no random dark panes (`window-lights.ts`, `scene-builder.ts`). Open: per-building dark flag for abandoned or lightless houses (shared pane material needs an instance attribute) |
| prop-intake (identity) | `house-interior/stool-a` is the pack's `Stool_1`, 1.05 x 0.6 x 0.69 m with no mount or scale class: a side table named a stool; dressers seat it beside tables | real-size check bounded height only | BUILT 2026-10-27: kinds may bound width too (`long`); stool ≤ 0.6 m across, so `props status` and `dress check` flag the 1.05 m "stool" as a side table. Skill: a pack name is never an identity |
| prop texel standard | purchased props were reskinned (78 of 80) but to the town standard of 40 texels/m, while the player body, armour and held gear are 109 texels/m, so props read 2-3x coarser than the character | 40 tx/m gate on props | ONE texel standard across world, props and characters, or a declared ratio; a gate that compares a prop's density with the character standard, not only with the town tile |
| ground cover (recipe.cover / render grass) | grass blades pop in at 16-48 m in a colour that does not match the zone's ground tile; every one of the 22 layers has the same tip colour `#8fd15c` and a hand-set blade colour, keyed on generic surface names while the zone paints its own ground tiles | no | BUILT 2026-10-27: `worldgen cover` compares each layer's drawn blade colour (sprite mean x bladeColor) with every ground tile it grows on, the zone's own tiles included, by value (x0.5-2) and hue (40°); 26 findings on Skelmorrow, the moor layers 40-68° off the Hagsheer tile. Open: tint blades from the terrain colour at the root |
| mob intake | an agent authored a whole mob body: the Risen Bones skeleton was modelled in Blender from the human rig's rest joints on 2026-10-22 (`projects/foundation/source/skeleton/build-skeleton.py`), with its own skull instead of the human head module and round ribs; Derek never authorised a new mob and it does not pass beside his models | no | RULED 2026-10-27 in encounter-standards, world-standards and weapon-unwrap: agents re-skin only; a body never comes from a build script. Open: a mob-intake check on the body's source |
| zonegen status | crash on one bad JSON; stamps STALE forever | no | BROKEN row, never a crash; stamp tests |
| labs | ~50 scratch projects in the closure | no | `labs --sweep`; labs never in a live scene's closure |
| coordinator | 10-day uncommitted tree; tmp scripts | rule only | commit per tools round; iteration-file lint in status |
| worldgen continents / sea cliffs | the shore was three systems that never spoke (coast noise ~17 % steep, hand-drawn `seaCliffs` stretches, the beach biome's window): nothing decided per stretch of shore what it is, nothing checked the mix, so a coast read all cliff or all beach | no | BUILT 2026-10-28: `worldgen coast` stage (segments by headland/bay + exposure, one type each, written as `coast-*` stretches + `features.coastSegments`), `--check` gate = the `coast` status row (shares, max run 600 m, beaches sheltered, a cliff and a beach per zone, stretch/segment pairing), drawn on `worldgen map` with a legend |
| sea cliffs (`terrain.seaCliffs`) | a stretch held its profile `reach` metres (300+) along the coast PAST its polyline's ends in every direction, so a cliff drawn next to a beach buried the beach under the wall | no | BUILT 2026-10-28: opt-in `endFade` (reach/fade across the polyline, the wall ends over `endFade` m beyond its ends); core test `sea-cliff stretches with endFade`; the coast stage writes one stretch per cliff run |
| engine tests | rock-skins / rock-audit tests read the live Skelmorrow project (zone textures, rock materials, the closure); archiving the world failed 9 tests, and projects are gitignored so a bare checkout could never pass | no | BUILT 2026-10-28: `HITREG_PROJECTS_ROOT` hook (`projectsRoot()` in `tools/_closure.mjs`), generated `fixture-world` (`test/fixtures/rock-skins/build.mts`), and the lint `test/no-live-projects.test.ts` that fails on any `projects/<name>/` path in `test/*.test.ts` other than foundation, world-kit, a placeholder or a fixture |
| `worldgen init` | into a fresh project it died with ENOENT on the recipe's lock file: the project's `assets/worlds` folder did not exist yet | no | BUILT 2026-10-28: `writeJsonFile` creates the folder before it locks |
| `worldgen scene` | wrote `voxelWorld` with no `mesher`, so a fresh world's scene never declared the mesher the standards require | no | BUILT 2026-10-28: the scene writer emits `mesher: "auto"` |
| `worldgen climate` / `planar-cliffs` | a temperate climate (anchors) and the DC cliff profile of another world could only be hand-edited into the recipe | no | BUILT 2026-10-28: `worldgen climate --anchors a,b,c`, `worldgen planar-cliffs --from <world> | --off` |
| `worldgen towns` | no way to site a town at a planned shore (the cove the coast plan drew): only the scorer's own pick | no | BUILT 2026-10-28: `towns --at x,z [--at-radius]` scores the cells round the asked point |
| `worldgen rivers` / status | a lake with no outlet was silent: nothing said whether it was meant to be endorheic or the solve had failed | no | BUILT 2026-10-28: `rivers --endorheic <ids|dry>` tags lakes; the `rivers` status row fails on an undeclared dry lake |
| `worldgen zones` | naming a zone, its landmarks and its border on the coast, and dropping the `draft` tag, were hand edits (the agent status rows) | no | BUILT 2026-10-28: `worldgen zone-name --zone --name --landmarks --hub [--border coast[:loop]]` |
| `worldgen paths` | roads only joined towns: a planned POI site could not be a road end, and a destination inside the sea-cliff keep-out was a silent "no route" | no | BUILT 2026-10-28: `paths --to "x,z=name;..."` (ids `path-<town>-site-<name>`); a keep-out destination's road ends at the nearest routable cell within `--to-snap 90` m, said aloud |
| `worldgen paths` | a path onto a sea-cliff top was an obstacle to the profile: the 120 m headland it climbed fell into a 50 m pit beside the road (`lips`: 757 walls, worst 46 m); the fowlers-drop lesson lived only in place-build | no | BUILT 2026-10-28: `paths` sets `keepLandforms` on every path that reaches a sea-cliff / butte hold (`--keep-landforms` for all) and says so |
| `worldgen coast` | a sheer-cliff top was 36 m deep and undulating: no landmark pad fit on it and nothing measured the flat top a brief asks for (120 x 120 m) | no | BUILT 2026-10-28: `worldgen coast-top --segment --edge` (a level top kept across re-runs by `coastSegments[].topEdge`); `coast --check` rule `flat-top` measures the largest flat square |
| typecheck | `apps/playground` typechecked `src` only: tools and tests never compiled (751 errors in the tools tree: `_prop-geometry` 241, `_prop-reskin` 129, `worldgen` 13, `worldgen-operators` 32, ...) | no | PARTLY BUILT 2026-10-28: `tsconfig.tools.json` (new tools/tests compile clean, `pnpm typecheck` runs it); the backlog is counted, not fixed |
| `worldgen rivers --endorheic dry` | tagged a lake as a sink whose level sat at its sill into a dry valley the solver cut no river for; the shaped shore (bank 16 m) cut the sill 0.6 m under the water, so the sheet stood over lower dry ground (firstshore lake-3) | yes, late (`water-logic` perched-sheet, a whole-world sweep) | no new check: the sweep is the gate; fixed by dropping the shallow basin (`rivers --step 8 --lake-depth 2`); a stage-local perched check at `rivers` stays open |
| `worldgen lips` / `paths` | a 6 m road's cut edge drew 0.5-0.7 m sawteeth on the 2 m lattice at two steep crossings and beside a lake bank (`--smooth-passes 2`, the default) | yes (`lips`) | fixed by data: `--smooth-passes 4` and a road end 42-50 m off the lake polygon; no new check |

## What worked and is kept

- The dungeon pipeline: every dungeon looked different, boss-near-exit drops
  read well, the shared lighting floor held.
- The role-split pilot on the Lych Span bridge: concept frames, layout, one
  water owner, one review. Derek: "100x better".
- Codex's focused redo of the net house at ~4 % of the agent rounds' cost.
- `layout.json` as a mechanism: owner-placed pieces honoured exactly or
  refused at plan.
- Towns from the town kit were liked; the fault is in repetition and
  installation, not the kit.
- Carved and painted roads. Nothing else ships.
- The cost measurement itself (`COST-NOTES.md`): the 5-minute cache rule and
  the 150k owner cap are measured, not guessed.

## Order for the next world

1. Archive Skelmorrow and its labs. Keep `foundation` and `world-kit`.
2. Commit the current tree (tests green) and clear the tmp scripts.
3. Build the continent climate model (tabled design) with its checks, then
   generate the continent and read it as a map before any zone is drawn.
4. Fix the town kit seed and installer; run ONE town end to end, alone, on
   the server, and walk it.
5. Run ONE POI end to end under gate 16 with the layout step, alone.
6. Only then the zone's roster, in batches of five, one review per place.

Every fault found in steps 4 and 5 becomes a row in the table above before
step 6 starts.
