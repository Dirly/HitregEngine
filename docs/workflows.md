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

## Dungeons

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

- **Making a zone (towns, POIs, dungeons, quests) from a generated world, or dressing any
  space with props:** read `docs/zone-pipeline.md`. The order is a command, `zonegen status`
  (ok/STALE/MISSING + `--next`); do the row it names. Props are placed by NAME through a
  dressing plan (`dress check` / `dress apply`), never by writing a transform, and are chosen
  from `props menu`, never by reading a catalog.
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

## Worlds and water

- **Rivers, lakes, waterfalls, or regenerating a voxel world:** read
  `docs/world-editing/rivers-and-falls.md` — the rules (lowland rivers, one
  waterfall per river, banks, the network) and the rebuild order. Crafting one
  fall into a place: `docs/world-editing/fall-crafting.md` (the `fall-crafting` skill).

## Characters, gear and art

- **Any picture an agent needs drawn** — texture tiles, prop/gear art, plan,
  section or concept references: read `docs/image-generation.md`.
  `apps/playground/tools/image-request.mjs gen` drives the Codex CLI headlessly
  and verifies size/alpha before installing the PNG, so an agent gets its own
  art inside one turn. Never run `codex exec` by hand in a project folder.
- **Texturing a mob or a weapon:** read `docs/mob-atlas.md` for a creature
  (the unwrap-to-atlas process, what each recipe setting is for, and the prompt
  rules that make artwork land) and `docs/weapon-atlas.md` for a modular
  weapon ubermesh. The `weapon-unwrap` skill wraps both for Claude sessions.
- **Player armor sets** (body + helm + shoulder art, then items per slot): read
  `docs/armor-sets.md` (the `armor-sets` skill wraps it). Ornaments only on rare+ gear.
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
