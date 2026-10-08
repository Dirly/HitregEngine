# POI authoring process

This is the shared, agent-agnostic process for outdoor POIs and dungeon approaches.
The implementation is ordinary Node modules, JSON Schemas, a CLI and the registered
`hitreg.poi-review` tool. It works without Codex, Claude, MCP, or conversational memory.
Provider-specific skills are thin entry points into these files.

For complete POI creation/revision, start with [POI Creator](creator/SKILL.md).
It adds explicit adventure intent and single-owner authoring before this planner
and reviewer. Its brief preparer records intake without starting an agent or
changing game content. The measured planner below remains available for focused
planning and review work.

## Start a job

Write a brief using [`poi-request-schema.json`](./poi-request-schema.json), generated
from `poiRequestSchema` in `poi-plan.mjs`. Choose the place, discovery/story intent,
size reference, dungeon behavior and construction features before building.

```sh
node tools/poi-review/plan-cli.mjs --request request.json --out-dir apps/playground/projects/MY-PROJECT/authoring/MY-POI
```

The command creates `workflow.json` and `review-plan.json` and refuses to overwrite
existing work. The first contains the sized work plan, role handoffs and evidence
required by this brief. The second is an **incomplete survey template**, with no
invented paths or colliders. Fill it from the measured site as construction develops.
Planning does not create a site or certify its quality.

The same implementation is exposed as registered tool `hitreg.poi-review`, mode
`plan-poi`. Supply the request JSON through its `bundle` file input. The host returns
the plan and writes both files to the tool run directory. Discover its input contract
through `/__hitreg/spec`; the CLI requires no running editor. The other modes remain
`plan-route` and `review`.
The dev host discovers tool manifests at startup. An already-running server may
need its next normal restart to expose this mode; the CLI is available immediately.

Minimal illustrative brief (coordinates must come from the actual chosen site):

```json
{
  "version": 1,
  "name": "Grove discovery",
  "tier": "small",
  "smallReference": {"name": "Current Silkroot usable ground", "usableAreaM2": 1573},
  "site": {
    "anchor": [4328, 59, -2091],
    "bounds": {"min": [4260, 20, -2145], "max": [4400, 190, -2010]},
    "approachOrigin": [4270, 41, -2119],
    "originDescription": "Existing playable hill trail",
    "zone": "Brinehold outskirts"
  },
  "intent": {
    "purpose": "An outdoor nesting grove",
    "discovery": "A short spur behind the rock shoulder",
    "storySources": [],
    "pacing": "A local outdoor discovery between major destinations; no added dungeon"
  },
  "dungeon": {"mode": "none"},
  "features": {"terrain": true, "grove": true, "groundedWebs": true}
}
```

Read [`poi-design-rules.md`](./poi-design-rules.md) for the current scale and visual
rules. Pinpoint means a cache, hill camp or Seven Whispers. Small means a grove;
medium has roughly twice small's usable area, large twice medium. Declare one
small reference consistently. A deferred expansion is not an existing measurement.
Small/medium/large may each have a dungeon; size does not request one. Survey zone
spacing and travel pacing so the newbie zone does not become a cluster of entrances.

## Execute the work plan

1. **Survey and story.** Read runtime focus/pins and local NPC dialogue/quest data.
   Inspect rendered terrain, roads, neighbours and assets. Start access from known
   playable ground, not an isolated convenient ledge. Choose story and landscape
   together; preserve the sources for the decision.
2. **Measured layout.** Reserve connected usable floor, encounter pockets, retreats
   and camera space before dressing. Draw plan and section. Keep area, dimensions
   and terrain-edit footprint distinct. Empty floor is not a tested mob encounter.
3. **Construction handoffs.** A building constructor uses the existing WFC asset
   modules; a dungeon constructor follows the dungeon kit workflow; a statue uses
   the statue tool. These are roles any agent can perform. Supply measured bounds,
   entry elevations, material requirements and connection points. The site author
   owns combined terrain/structure access after accepting their outputs.
4. **Terrain and assets.** Use recipe ops and scene ops with inverse batches. Image
   heights can guide shaping; calibrate size, smooth and blend them, then check the
   actual meshed terrain. Distort organic walls, preserve usable floors and roads.
   Use the asset catalog rather than repeatedly importing raw packs. Every new or
   modified reusable prop must follow [prop intake](../../docs/prop-cataloging.md),
   update a registered project catalog, and pass `catalog-check.mjs` before live
   installation. Include effect-bearing prefabs and extracted parts in that intake.
5. **Dressing.** Reserve routes first. Use scatter for tree density and an outer
   grove screen. Mix compatible catalogued tree meshes and size variants by biome,
   retaining the total density budget when splitting rules. Web tips must touch real ground/bark/rock, with visible texture
   coverage at the contacts; these nest webs need a ground vertex. Match world
   texels independently of span. Revalidate attachments/colliders/LOD when source
   assets change. Image generation edits the designated texture, not mesh UVs;
   generate individual images, downsample, then use the existing atlas packer.
6. **Measure and review.** Measure reachable usable area after solid dressing.
   Run terrain/geometry, support, burial, texel and traversal gates appropriate to
   the brief. Use actual final model bytes/transforms and the current world.
   Apply [static baking and visibility boundaries](../../docs/town-baking.md) to
   POI dressing as well as buildings. Fixed meshes must opt into static batching,
   including meshes inside prefab instances; keep animated/interactive parts out.
   Check actual runtime submissions from a nearby and distant overview. An atlas
   or a single prefab file is not evidence of a single draw. A distant silhouette
   must retain trees and landmark geometry, and every LOD handoff needs review.
7. **Play and look.** Drive the real controller with procedural vegetation active.
   Review entry, interior, support contacts, third-person camera and exits. Large
   sites need distant silhouette views. Use a separate reviewer when available.
   Repair visual failures even if traversal passes.
8. **Install and hand off.** Verify that installed content matches the reviewed
   revision. Retain replay, inverse ops, measurements, hashes and image paths.
   Report coordinates and actual gameplay: spawned mobs, quest links, loot,
   working transfer/return, or explicitly environmental-only.

## Run the measured gates

```sh
node tools/poi-review/cli.mjs review --plan review-plan.json --world world.json --assets PROJECT/assets --out review.json
node tools/poi-review/cli.mjs pack --plan review-plan.json --world world.json --assets PROJECT/assets --out bundle.json
node tools/poi-review/cli.mjs review --bundle bundle.json --out review.json
```

`pack` makes a portable bundle for other machines/agents or the registered `review`
mode. `review.json` records world/plan/model hashes. A changed input invalidates
that evidence. Its numeric success is `needs-visual-review`, never final acceptance.
The template's empty routes cannot pass. Include all relevant solid dressing and
explicit support/enclosure claims; omitted claims are unverified.

For difficult approaches, use `route-cli.mjs` and the route-search schema, then edit
and review the final terrain. `dressing-checks.mjs` gates triangle texels and grove
perimeter distribution. Detailed judgement and reviewer coverage requirements are
in [`SKILL.md`](./SKILL.md). The planner routes work; it does not automatically
execute builders, invent quests, certify screenshots, or mutate the world.

Rebuild the request schema after schema changes:

```sh
node tools/poi-review/plan-cli.mjs --schema tools/poi-review/poi-request-schema.json
```
