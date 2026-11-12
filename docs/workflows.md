# Content workflows

How to build game content with the engine's tools: dungeons, zones, POIs, towns, characters,
gear, art and audio. Moved out of CLAUDE.md on 2026-10-08 so CLAUDE.md stays about the engine;
the rules below are unchanged. Load only the section for the task at hand.

**Where content lives** (`apps/playground/projects/`, each its own repo; see each README):
`foundation` — the shared game (characters, combat, items, spells, creatures, UI art, audio);
`world-kit` — shared world-building content (catalogued props, purchased packs, dressing sets,
kit Blockbench sources); a world such as `proving` — its map, zones, towns, POIs, NPCs, quests,
site-specific props and its instanced dungeons (`fieldfast-hall`, `fieldfast-barrow`,
`gnawspur-deeps`, `rime-hall`). Art, rig and audio tools run with `--project foundation`;
prop catalogue maintenance with `--project world-kit`; world tools with the world's project.
Tools read a project's `dependsOn` closure, so a world sees foundation and world-kit content.

**All visual content, layouts and Blender experiments:** read
[art-direction.md](art-direction.md) before the subsystem route below. Texture-led
PSX art is the shared default across environments, structures and assets. Plan the
painted finish along with the structural forms, and review a textured sample
before repeating a style or major asset group.

**Spider habitats and asset placement** (woodland, abandoned buildings, caves and
dungeons): read [spider-habitats.md](spider-habitats.md) alongside the relevant
location workflow below. It carries shared placement rules, implementation
references and the limits of current outdoor automation.

## Dungeons

- **Prop placement and self-review:** Weeping Sun Tombs is the current owner-approved quality bar (2026-11-08).
  Read [the shared skill reference](../.claude/skills/dungeon-standards/references/placement-review.md) for selective
  dressing, protected fight/travel space, a removal pass and checks drawn from its corrections. Both Claude and
  Codex route there. Legacy recipe prop/type count floors must not cause filler; use the documented scoped
  exceptions until the shared gate is revised. This direction does not authorize reworking other dungeons.
- **Dungeon style, image and size passes:** keep a visual `authoring/style-guide.md`, inspect actual candidate-prop
  images, and use post-layout room screenshots for sparse prop/effect concepts before installation. Generate useful
  missing effect artwork/runtime assemblies, then catalogue and review them in motion. The existing `concept-scale`
  stage verifies marked concept dimensions against plan/build sizes before export; stair headroom, transformed prop
  fit and posed equipped geometry are separate checks. The shared skill reference records their coverage and gaps.
- **Dungeon rooms and tunnels are modeled in Blender** (Blender MCP) and imported
  through the `tools/mesh-dc` bridge; read `docs/blender-dc-authoring.md` first. The
  DC construction tools carve, add stairs and fit portals inside imported stamps.
- **Dungeon construction/refinement:** use the installed `hitreg-dungeon-authoring`
  skill, its quickstart, and the existing kit README. Start with the current
  project's plan and `authoring/NOTES.md` when present. Open tool sources only
  for a concrete question those references do not answer. Reference images
  (plan, vertical section, concept), the measured plan, applicable carving/path/
  portal tools, lint, and the geometry/traversal/visual gates remain part of the
  workflow. A compact handoff carries their paths and current stage, not copies
  of their contents. Templates execute; they need not all be read as context.
- **Dungeon texture requests and theme swaps:** read `docs/dungeon-materials.md`.
  Keep the eight stone roles and add wood, metal and smooth stone: eleven textures
  by default, with stable asset roles for changing themes while reusing geometry.
- **Statues from human kits or mobs:** read `tools/statue-maker/SKILL.md` and its
  adjacent toolkit README. It covers static pose baking, male/female and outfit
  choices, smooth stone shading, decorated pedestals and placement verification.
  A statue base containing a tomb or walkable entrance also uses the dungeon route above.

## Zones, POIs and towns

- **A new world's scene is playable through its game shell:** the player prefab, third-person camera rig,
  HUD, inventory, NPC talk, name tags, telegraph and fx pools, soundscape, combat audio and ambient
  particles, defined once as game data in `foundation/assets/game-shell.json`. `worldgen init --scene` /
  `worldgen scene` build the scene with it when the project `dependsOn` foundation; an older or capsule
  scene gets it from `npx tsx tools/game-shell.mts <world> --project <world>` (`--check` lists gaps,
  one applyOps batch, `--uninstall` from the saved inverse). `worldgen status` has a `game-shell` row.
  Creatures are not the shell (`zonegen populate`), nor are town NPCs (`town-npcs`).
- **Before reworking any world, town, POI or dungeon tool for the next world:** read
  `docs/postmortems/skelmorrow.md` (fault → check table). Every row is a check to build into the named
  tool, not a line for a brief; a tool rework that leaves its rows unbuilt is not done.
- **Making texture-first low-poly props:** read `docs/prop-cataloging.md` and
  `apps/playground/tools/prop-codex/README.md`. Use named painted surfaces for
  emblems, carved motifs and wear; keep geometry for silhouette and useful depth.
  `props paint` measures guides, generates or imports artwork and blocks stale
  artwork before the normal `world-kit` prop install.
- **Making a zone (towns, POIs, dungeons, quests) from a generated world, or dressing any
  space with props:** read `docs/zone-pipeline.md`. The order is a command, `zonegen status`
  (ok/STALE/MISSING + `--next`); do the row it names. Props are placed by NAME through a
  dressing plan (`dress check` / `dress apply`), never by writing a transform, and are chosen
  from `props menu`, never by reading a catalog.
- **Building places on a generated world (siting, concepts, designs, grey boxes, installs):** the world's ORDER is
  `zonegen stages <world> --project <p> [--next]` (`tools/world-order.mts`, `authoring/stages/<world>.json`): each place
  stage stands on the place's LOCAL ground (its site + concept camera lines; a far world write never stales it), a
  painted place's concept is approved before a design, and a catalogue place (small / roadside / camp) has no painting. The commands that do the work refuse out of order; `zonegen approve` records approvals.
- **Exterior chain (every dungeon door and painted place):** location -> `zonegen concept --renders-only` (the bare grab of the UNEDITED ground) -> `--paint-only` -> `zonegen concept-check ... --target <frame>` -> build. Every exterior build path refuses before that (`tools/poi-review/exterior-chain.mjs`; status `zonegen exterior <world> --project <p>`), and a dungeon pipeline is BLOCKED at its first stage `exterior` until its door's chain is complete. Bypass: an owner ruling only, `--no-concept-ruling "YYYY-MM-DD <Derek's words, verbatim>"` (recorded).
- **Running a whole zone** (design, look, places, life, quests, review): read `docs/zone-creation.md` (the
  `zone-creator` skill wraps it). Places are designed in the zone brief before any quest; reviewers use
  `docs/world-standards/review-rubric.md`.
- **World-building task skills** (each = commands + gates + what a failure means; index and the one
  "Not encoded yet" list: `docs/world-standards/README.md`): `site-finder` (where places go, wall lines),
  `terrain-edits` (patches, lips, roads, vegetation, clearings, floating plants, blades), `site-dressing`
  (outdoor props by name), `prop-intake` (catalogue, reskins, prop requests), `zone-mood` (tone not brightness),
  `dungeon-build` (room kit, role noise, every pipeline gate), `dungeon-lighting` (readability, matte, culling,
  buckets), `portals` (veil, cover/--fit, trip, real-client play, loading art). Design bars: `site-standards`,
  `dungeon-standards`, `interior-standards`, `encounter-standards`, `world-standards`; towns: `town-planner`
  (wall, settle, wear, lights). New lessons go into a skill or a check, not `docs/zone-creation-lessons.md`.
- **Laying out a town (terraces, streets, lots):** design before the cut — `tools/town-design.mts propose` ->
  a designer agent (`apps/playground/tools/zonegen/briefs/town-design.md`) iterates `town-design check` -> the plan
  picture is approved -> `worldgen terrace <w> --from-plan <design.json>` -> `town-layout --from-plan <design.json>`.
  Order and rules: the `town-planner` skill; schema: `town-design schema`.
- **Where towns, hero places and dungeon entrances go:** propose -> agent pick, judged on SITE NEEDS (the ground a
  role must have, measured: `apps/playground/tools/site-needs.mts`). Towns: `worldgen towns --propose` -> a fresh siting
  agent (`zonegen brief-for site-towns`) -> `worldgen towns --pick`. Places: `zonegen sites --role <r> --for <place>
  --propose` -> `brief-for site-places` -> `zonegen reserve --pick`. Ground no candidate has: recipe `needs` +
  `worldgen needs` (cliff-face, walled-neck). The `site-finder` skill has the commands and failures. A cliff-face
  block is BROKEN ROCK (lifts with ledges, set-back bays, a ragged crest, gullies, terraced ends and back;
  `cliffFaceRelief` in `tools/site-needs.mts` measures ledges / plane RMS / crest spread); re-shape a solved face in place with
  `worldgen needs --only <id> --keep-foot`.
- **Small/medium outdoor places** (camp, croft row, shrine, graveyard, landing, work yard, den, watch ruin, halt
  yard, cuttings): `tools/place-build.mts all` from a place archetype; read `docs/place-builder.md`. Hero places below.
- **Complete POI creation/revision:** use `tools/poi-review/creator/SKILL.md` for
  one owner agent per whole location, an explicit adventure brief and early
  playable design review. Its intake schema and preparer live beside it. The
  coordinator reviews and serializes installation; content corrections stay
  with the owner. Preparing the workflow does not authorize world edits.
- **Outdoor POI placement and dungeon entrance review:** read `tools/poi-review/SKILL.md`.
  The agent-agnostic authoring process is `tools/poi-review/README.md`; its shared
  CLI/API planner produces a sized work plan and review template from a JSON brief.
  Survey the rendered terrain before choosing the footprint; review discovery,
  spatial logic, terrain shaping and actual capsule access together. Numeric
  traversal alone does not establish a believable or visually finished site.
- **Town construction/export and static baking:** read `docs/town-baking.md`
  alongside the owning WFC kit's construction rules. Preserve editable sources;
  compile compatible atlas materials per building shell and separate room/floor
  interiors. The existing district exporter is a legacy path, not a partitioned
  bake implementation. Review its documented limitations before installing.
- **Town NPCs — story, residents, dialogue, shops, the bank vault, quest givers:**
  read `docs/town-npcs.md` (the `town-npcs` skill wraps it). Residents are data in
  `authoring/towns/<name>.json`, generated and linted by `tools/town-npcs.mts`;
  every outcome is decided by the `npc` builtin on the server. Quest/NPC text never
  contains a hand-written compass word: it names places (`{dir:id}`) resolved
  from the world (north is -Z); the tool's lint refuses anything else.
- **Character, boss, rare and deity names:** use `docs/name-registry.md` before
  choosing or reusing a name. Look up identities, atomically reserve new names,
  and validate recorded labels against the owning game's shared database.

## Worlds and water

- **Rivers, lakes, waterfalls, or regenerating a voxel world:** read
  `docs/world-editing/rivers-and-falls.md` — the rules (lowland rivers, one
  waterfall per river, banks, the network) and the rebuild order. Crafting one
  fall into a place: `docs/world-editing/fall-crafting.md` (the `fall-crafting` skill).
- **A bridge or aqueduct across a gap** (gorge, valley, river, cliff to sea stack): `worldgen bridge-place
  <world> --project <p> --id x --a "x,z" --b "x,z" [--kind arch|rope] [--style gnawspur|coastal] [--channel]`
  (fields: `features.bridgeSpans` in the spec; kits: world-kit `authoring/bridges/`, its build.mts header).
  Arch where piers can be founded (<= 14 m of water, <= 70 m tall); rope for sea stacks and chasms. Never
  hand-place bridge pieces: `--refit --all` after any terrain rebuild, `--check` lists STALE spans. On sea stacks and
  DC cliff tops seat the ends `--seat rock` (the end slides to the rim, the deck eases level over it). Straight spans
  between natural tops; slope instead of structures: rope spans run STRAIGHT between NATURAL TOPS and take the
  height as SLOPE (<= 30 deg end to end, deck <= 35 deg with the sag); no stairs, stages, towers or plinths to meet
  a deck (Derek's standing rule): too steep means a different anchor pair.
  `--seat stage` is only for docks / sea-level landings. Prove a chain with `world-kit authoring/bridges/walk-chain.mts`.

## Characters, gear and art

- **Any picture an agent needs drawn** — texture tiles, prop/gear art, plan,
  section or concept references: read `docs/image-generation.md`.
  `apps/playground/tools/image-request.mjs gen` drives the Codex CLI headlessly
  and verifies size/alpha before installing the PNG, so an agent gets its own
  art inside one turn. Never run `codex exec` by hand in a project folder.
- **A place's concept frames** (gate 16 `concept[]`, rubric P5) are painted ON its bare site, never from text:
  `node node_modules/tsx/dist/cli.mjs tools/zonegen.mts concept <world> --project <p> --zone <z> --poi <id>` (apps/playground; `--town <name>` for a town) renders the site,
  repaints it through `image-request.mjs gen-set --paint` and prints the fit numbers beside the frames
  (`concept/<id>-sheet.png`). Rule and check: `tools/poi-review/concept-site.mjs`.
  When what counts as ground changes (never when the ground moved), `npx tsx tools/concept-site.mts restamp <id>.site.json
  --ruling "<dated ruling>"` rewrites the stamp without re-rendering; it refuses unless the place's `bare-renders` stage is ok.
  Stamps carry `fingerprintParts`, so a gate-16 refusal names which part moved (global ground fields or features under the reservation).
  A town also gets the NEAR set (gate 40-70 m out on the main road, street just inside the gate, square), at player
  height on a plan staked from the site (wall ring + gatehouse where the road crosses it, street, square, chapel lot,
  street lots, drawn over the bare render for scale; `stakes` in `<id>.site.json`). `--views gate,street,square`
  renders/paints a subset; `--measure` back-projects the painted town's outline in `<id>.concept-marks.json`
  (`{ extent: { view, outline, masses } }`, the place-scale schema) to metres and keeps it as `extent` in the manifest.
- **Texturing a mob or a weapon:** read `docs/mob-atlas.md` for a creature
  (the unwrap-to-atlas process, what each recipe setting is for, and the prompt
  rules that make artwork land) and `docs/weapon-atlas.md` for a modular
  weapon ubermesh. The `weapon-unwrap` skill wraps both for Claude sessions.
- **Ghosts and spectral creatures:** read `docs/ghost-authoring.md` before
  choosing their wardrobe or effects. Reuse the shared restrained ghost surface,
  smooth foot fade and rectangular eyes, with measured fitting for each rig and
  clothing/equipment designed for the location. The `ghost-authoring` skill
  wraps this for Claude; `hitreg-ghost-authoring` is the Codex entry point.
- **Player armor sets** (body + helm + shoulder art, then items per slot): ONE command from
  one brief, `node --import tsx tools/armor.mts run <set-id> --project foundation` (`armor brief
  new <id>` first; `armor status`; `armor queue <ids…>` for several). Read `docs/armor-sets.md`
  → One command (the `armor-sets` skill wraps it). Ornaments only on rare+ gear.
- **Texture pages (weapon, armor, helm, shoulder, body, head) are always SQUARE:**
  a tile is `[u, v, scale]` with one scale; every packer goes through
  `apps/playground/tools/_page.mjs`, which refuses anything else.
- **Inventory icons:** read `docs/item-icons.md` (the `item-icons` skill wraps
  it). An item with a model is rendered from it; only model-less loot is generated.
- **Equipped items — parts, theme, glow, effects:** read `docs/item-looks.md`
  (the `item-looks` skill wraps it). Every holder of a model is one draw;
  never give an item its own material or mesh.
- **Character clips, weapon stances, grips:** read `docs/character-animation.md`
  (*Libraries on different rigs*, *Weapon stances*). A held item's socket is
  computed with `tools/fit-grip.mjs` and checked with `tools/pose-sheet.mjs`,
  never nudged by eye; a weapon's animations are `<Stance>_<clip>` clips.

## Audio

- **Any sound or music** — generating with ElevenLabs, restyling, or wiring beds/
  music/spots: read `docs/audio.md`. Prompts are composed from the project's
  `authoring/audio/template.json` (the house style) + a catalog entry; never write
  a one-off prompt around it. `tools/sfx-request.mjs status` says what is stale.
