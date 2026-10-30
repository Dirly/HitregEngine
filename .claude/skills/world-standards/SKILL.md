---
name: world-standards
description: "Coordinating or reviewing generated world content: the standing rules for an unattended zone run (places before quests, a reviewer agent before detail work, acceptance on the server, no re-proving, revisions overwrite in place (no iteration files), rulings live in tools) and which task skill each job loads. Use before briefing, reviewing or installing any site, dungeon or town."
---

# world-standards

How a zone run is run: `docs/zone-creation.md` (skill `zone-creator`). Reviewer checklist:
`docs/world-standards/review-rubric.md`. Open values and unencoded rules: `docs/world-standards/README.md`.

## Which skill a job loads (name them in every brief)
| Job | Skills |
|---|---|
| where places go, town wall lines | `site-finder` |
| ground, trails, plants, holes | `terrain-edits` |
| air and light of a zone or place | `zone-mood` |
| outdoor site design / props | `site-standards`, `poi-creator` / `site-dressing`, `prop-intake` |
| dungeon design / build + gates / light / doors | `dungeon-standards` / `dungeon-build` / `dungeon-lighting` / `portals` |
| dungeon entrances, gatehouses, towers, hero landmarks | `grand-entrance` |
| towns, buildings, styles | `town-planner`, `building-constructor`, `building-styles`, `town-npcs` |
| rooms and furnishing | `interior-standards` |
| creatures | `encounter-standards` |

## Taste and decisions
- Owner feedback updates tools and shared standards so later work improves. When the owner requests a retrofit,
  revisit the shipped content within that scope; an old PASS cannot override the owner's rejection or new direction.
  Preserve unrelated work and distinguish rewritten plans from physically completed changes.
- Rules state what was learned, never where: no place names in a skill or standard.
- The coordinator decides design and scope calls inside the agreed direction and reports in one line; it asks only for
  new fan-outs, destructive or outward actions, or a contradicted ruling. Silence is not approval.
- New lessons go into a skill or a check. `docs/zone-creation-lessons.md` is the raw log only.

## Order and gates
- A world is built in ORDER, and the order is a tool (Derek 2026-10-29: "a step checker so shit is done in order"): world generate -> status-clean -> siting -> world-frozen, and per place (no world freeze needed: each place stands on its LOCAL ground — terrain, water, roads, needs inside its site + camera lines; scatter/mood/textures never count; a write there stales it and names the part) sited -> bare-renders -> [art painted: concept-painted -> concept-approved (Derek, or the coordinator under a dated ruling)] -> design -> design-review PASS -> [town: town-design -> plan-approved] -> grey-box -> grey-box-review PASS -> detail -> final-review PASS -> installed -> walked. `art: "catalogue"` places (default for small / roadside / camp roles; Derek 2026-10-29: camps are built from assets we have) skip the painting and approval, and their design may name catalogue props only (`--done design` refuses a Codex / prop request); set with `zonegen stages --art painted|catalogue --place <id>`. Encoded: `tools/world-order.mts` (`authoring/stages/<world>.json`); `zonegen stages <world> --project <p> [--next]` is the only answer to "what stage is X in" — say what it prints, never prose; `zonegen approve` records approvals with the sheet hash; `zonegen concept`, `place-build plan/build/install`, `town-design propose`, `worldgen terrace --from-plan`, `town-layout`, `town-install` refuse out of order; every worldgen write that changes a frozen world refuses without `--unfreeze "<dated ruling>"`, which marks every place stage on it STALE.
- Paths are carved + painted tracks (`worldgen road`); ribbons were removed 2026-10-30 and a world or job declaring one fails to load.
- Places before quests: sites and dungeons built and populated first; quests bound last.
- A cheap look before the expensive pass, by a reviewer agent that is NOT the builder; resume a reviewer, do not respawn.
- The grey box proves the read: the defining shot from its stated viewpoint, readable hour, clear weather. Encoded: `tools/poi-review/job.mjs stage` (no stage past blockout without `evidence.readShot` from a declared viewpoint).
- Loop cap: two returns, then install with the fault logged, or cut the feature. Encoded: `job.mjs fix` (third attempt needs --coordinator).
- Fire is the engine's fire: every flame is the standing `vfx` fire through a catalogued prefab, its light comes with the fixture. Encoded: `job.mjs fire` (gate 4; blocks the stage past blockout and the install on a primitive/fx-material flame or a raw light).
- Nothing floats: a placed object's height is measured on the REAL solid under its footprint (cuts, carves, formations, decks, DC floors), never taken from a number computed earlier; contact (base/legs/embed/hang/wall) comes from the catalogue. Encoded: `worldgen float` (zonegen `float` row, `worldgen status` stage), `tools/float.mts scene` (dungeon `float` stage), `job.mjs` gate 5 (install needs a passing `reports/float.json` newer than the ops).
- Stone follows the place: every rock, boulder and cliff mass (scatter or placed) is the stone the terrain draws where it stands (its zone's cliff, or the cliff it leans on), and its cap is what the ground beside it wears (snow over the snow line, nothing on bare stone). Encoded: `worldgen rock-skins` (zonegen `rock-skins` row, `worldgen status` stage), `job.mjs` gate 6 (install needs a passing `reports/rock-skins.json`); fix with `recipe.rockSkins`, never per-instance materials (docs/voxel-worlds.md "Rock skins").
- No water ends in the air: a fall curtain hangs from the lip the terrain REALLY has and hugs its face down to the pool; every water body's edge is buried in solid or ends at a declared finish (drain, lip-fall, dark, built). Encoded: `worldgen water-edges` (zonegen `water-edges` row, `worldgen status` stage), `tools/water-edges.mts scene` (dungeon `water-edges` stage, `--fix` re-cuts to the walls), `job.mjs` gate 7 (docs/voxel-worlds.md "Water edges").
- Water bodies agree: a river through a fen runs AT the fen's level and leaves it only over a declared outlet (`river.weirs`, the dam/weir/spillway the brief names); no lake takes a river and lets none out. Encoded: `worldgen water-logic` (`worldgen status` stage; docs/voxel-worlds.md "Weirs: rivers held at a fen's level").
- No holes you can see through the map: nothing shows the void where ground or built geometry must be, seen from eye height along the real route. Encoded: `tools/see-through.mts scene` (dungeon `see-through` stage; POIs with `--route <walk-route.json>`), `job.mjs` gate 8 for jobs with built structures, and the catalogue's see-through prop review for DC props >= 8 m (docs/see-through.md).
- One mesh owns each plane; zfight gate: two separately drawn surfaces on one plane (shell under a kit floor, a pad on terrain, overlapping kit pieces, a prop sunk flush) flicker at close range. Encoded: `tools/zfight.mts <project> [--scene id] [--decals]` (dungeon `zfight` + `decal place` stages; reports/engine/zfight.json names both meshes and where); fix the builder that emits the second copy.
- Ground is shaped by landform operators, never by raw carve boxes: an agent writes an operator doc (terrace, path, ...) with a handful of numbers, the owner approves its `worldgen op-preview` look, then `worldgen op --apply` installs it. Nothing finer than 6 m (three 2 m voxels) goes into the terrain: that is a kit or hero piece. Encoded: `worldgen fine` (the 6 m gate; `worldgen status` row `terrain-fine`, legacy carves recorded and counted), `job.mjs` gate 11 (coordinator-ruled exceptions only, per job in `<world>.fine-exceptions.json`; docs/voxel-worlds.md "Landform operators").
- Reviews compare side by side with the owner-approved references (rubric Q2, dungeon `compare`).
- Nothing installs before the final quality review passes (Encoded: installers call `requireFinalReview` from `tools/poi-review/job.mjs`; `--force-dogfood` is the coordinator's). Acceptance is on the dedicated server with creatures spawned.
- A real body walks every POI before install: geometric reach floods and coordinator PASSes are estimates. Encoded: `tools/poi-walk.mts <job>` (server boot scoped to the scene closure, cold starts, handoff `navigation.routes` both ways plus every derived door/opening/portal/area/clearing/quest target; FALL/STUCK/MISS/ONE-WAY/PORTAL/SHADOW/STREAM/NO-ROUTES), `job.mjs` gate 14 (install needs a whole-run passing `reports/walk.json` newer than the ops).
- A place looks like where it stands: its surfaces match the terrain's texel scale and the zone ground's value band, use more than one material, and every door leads somewhere or is shut. Encoded: `tools/art-check.mts <job>` (texel / value / variety / portal / form / scale; thresholds in tools/_art-check.mts), `job.mjs` gate 15 (install needs a passing `reports/art-check.json`), zonegen `portals` row (a zone brief dungeon with no portal is MISSING).
- A tiling texture has no lone mark: one clover, skull or bright fleck on a tile repeats into a grid of icons (Hagsheer rocks read as health packs). Encoded: `node tools/texture-swatch.mjs <tile.png>` writes the 4 x 4 swatch and exits 1 on MOTIF; `worldgen zone-textures` refuses such a tile. Look at the swatch before a new tile is used.
- POIs are the size of their tier and are reviewed by someone else: tiers live in `tools/poi-review/size-tiers.mjs` (large = 300-600 m district); Encoded: `zonegen reserve` `under-tier`, `poi-brief` refuses an under-tier reservation, `job.mjs measure` + install gate 12 (measured size), gate 13 (`Reviewer:` id that is not the owner or the coordinator, every Q/S rubric line answered; the coordinator never records a PASS — only Derek's hand-written `ownerApproval` overrides).
- Places are DESIGNED before they expand (owner ruling 2026-10-22): `design.json` (premise, journey, areas, story elements of catalogued things, one finished area, reference frames) and a fresh reviewer's PASS on the rubric's Place lines P1-P5 — story read from the frames, every element seen, nothing random, worth visiting, finished to the bar — before detail and before install; the final review answers P1-P5 again. Encoded: `job.mjs design` / `design-review`, gate 16 in `stageBlock` + `installBlock`, place-build `build` refusal + `design` gate row, `zonegen status` poi rows. A Place line is never n/a and a missing element is never a prop request.
- Proven work is not proved again unless its own inputs changed (content digests of the zone's slice).

## Agents and briefs
- Roles: Opus owners do terrain, structures, routes, anchors and socket maps; Sonnet places every loose prop by name;
  GPT draws art. An Opus owner writing prop transforms is a fault.
- Rulings live in tools and skills; a brief points at them and never restates or narrows them ("no new models" means
  no new MESHES for what the catalogue has; new skins are always allowed).
- Agents never author a creature BODY (owner 2026-10-27): themes and skins on an existing body only; a missing creature
  is a request to the owner, never a Blender build script or a mesh from the human rig's joints.
- Budgets: small ~150k, medium ~300k, large ~400k, dungeon ~450k; a long trail gets its own owner; a capital two owners.
  Every stage reports what it used. An owner past ~400k context hands off with its handoff file.
- A handoff states what is missing ("story not yet visible", prop requests).
- A builder stops at the first refusal of a tool and reports it with the fallback it used.
- Shared tools, not per-job copies: a copied harness carries the other job's routes and layout grammar.

## Evidence
- Counts come from a tool, never the builder's tally.
- A picture is evidence only with its camera stated, in play mode, readable hour, after a dev-server restart.
- Grey-box pictures use a flat review exposure; final pictures the shipped light.
- A gate that over-reports gets ignored; the same failure count in two places measures the rule: fix the gate.

## Files and installs
- A revision overwrites the same files in place: no `-v2`/`v3/`/`-final`/`-before` copies. Commit the installed
  version first; git and the install's inverse ops are the undo. One writer on a world file: builders
  deliver installers, one queue installs.
