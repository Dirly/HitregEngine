---
name: hitreg-poi-creator
description: Create or revise a complete HitReg POI with one owner agent, from an explicit adventure-size, hostility, description and location brief through terrain, playable content, dressing and review. Use for whole locations rather than isolated prop edits or read-only POI audits.
---

# POI Creator

Create a believable place with a complete player experience. One fresh sub-agent owns each POI from survey to final correction. The coordinator supplies the brief, checks the owner's work and serializes installation; it does not independently redesign, dress or reshape the POI. Fixes go back to its owner. Separate POIs may have different owners, with protected boundaries and shared-world installation coordinated centrally.

This skill creates a workflow, not authorization. Creating the skill, preparing a brief, or discussing a POI does not authorize world changes. Honour a stopped/frozen world. A job's `mode` records the requested work; it cannot override the user's permission or constraints.

## Intake and owner

Read the active checkout's `CLAUDE.md`. Read [brief.schema.json](brief.schema.json) for the intake contract and [brief.example.json](brief.example.json) for a filled example. The schema is generated from [brief.mjs](brief.mjs), its source of truth.

The brief requires **adventure size, hostility, description and location**, plus project/name/id context. Resolve context from the session where possible. Ask concisely for missing size, hostility or intent rather than inventing them; use a location hint if exact coordinates still require a survey. Carry every user requirement and constraint into the brief, including roads, scale, materials, faction and existing content to preserve.

Prepare a job from the engine root:

```sh
node tools/poi-review/creator/prepare.mjs --brief brief.json --out-dir JOB-DIRECTORY
```

This validates intake and writes a brief, owner prompt and initial progress record. It neither starts an agent nor edits the game. It refuses to overwrite an existing job. To regenerate the contract after changing its source:

```sh
node tools/poi-review/creator/prepare.mjs --schema tools/poi-review/creator/brief.schema.json
```

The coordinator starts one fresh owner, without a conversation fork, with the canonical skill path, job directory, engine root, active project/server, current authorized stage and relevant source paths. Preserve the user's model preference. Record its agent ID in `progress.json`. It owns terrain, structure, assets, gameplay, scene integration, evidence and repairs. **Do not split this POI among a terrain agent, dungeon agent and dressing agent.** The owner performs the necessary construction roles using the available toolkits. Follow their modeling and validation requirements, with this ownership rule retained.

## Size and the adventure

Read [../poi-design-rules.md](../poi-design-rules.md) for current sizing. Declare the actual small-site reference before setting usable-area targets; derive medium/large from the same reference. The current reference is Silkroot's measured 1,573 m², unless the user chooses another. Count connected, reachable usable ground after exclusions; report terrain-edit bounds separately.

**Size describes the whole requested adventure.** Explicitly state outdoor and interior scope in the measured plan. An entrance, facade, rectangular clearing, long empty corridor or asset count cannot substitute for that scope. A large mine needs its described network and destinations; a large non-hostile hub needs its described activities and spatial organization. Do not impose a fixed tunnel length or room count on every POI. Choose those measures from this brief's experience and record them before construction.

Allocate the overall usable-area target across connected outdoor and interior regions in `handoff.json`. Measure actual reachable floor surfaces per level for interiors; a top-down terrain grid misses stacked floors. Count each usable surface once, exclude approach-only travel, walls, inaccessible slopes and substantial solid dressing, and retain the route graph proving all counted regions are reachable. Record network length, destinations, choices and activities alongside area so area alone cannot satisfy the requested experience.

The existing `poiRequestSchema`/`planPoi` describes an **outdoor site or approach** and has one site-area target. Set its `tier` to the actual outdoor component, which may be pinpoint/small even when this creator brief's `adventureSize` is large. Its `targetUsableAreaM2` applies to that component only. Review the interior with the dungeon workflow and join both through the actual route graph; report the combined complete-adventure measurement separately. Never map a large mine brief directly to a large exterior grading pad. Declare component tiers and target allocation before construction; do not silently substitute the entrance measurement for the whole adventure.

For hostile places, specify adversary identity, the reason it occupies the place, encounter spaces, warning cues, progression and retreat. For non-hostile places, specify the activities, residents or discovery that make the place useful. For mixed places, map the safe-to-hostile transition and prove actual aggro/leash behavior where mobs are required. Town proximity and roads follow the brief's safety constraints; hostility is not permission for roadside ambushes.

## Own the complete build

1. **Survey and premise.** Inspect the rendered map, player-height terrain, focus/pins, neighbours, current story/gameplay and usable assets. Find a reachable approach and exits. Choose how the landform supports the described activity. Record protected content and bounded edits before committing the footprint.
2. **Measured design and playable blockout.** Reserve paths, choices, destinations, encounter/work spaces, height changes, recovery routes and camera space. State the size reference, outdoor/interior targets and expected player journey. Draw plan and section, with dungeon reference images where required. Build the complete structural blockout in a private preview for build-mode jobs. Include a representative finish sample before repeating major prop/fence/grave/stall groups. Submit player-height, overview and route evidence early. The coordinator reviews scale, terrain fit and whether the intended adventure is present before detailed dressing; this is not an automatic human approval request.
3. **Functional content and construction.** Implement the activities explicitly required by the brief using project-owned gameplay. Use the existing WFC modules for suitable buildings, Blender-to-DC for custom dungeon structures, and supported carving/terrain tools. Resolve a missing capability before relying on it. Keep the whole progression connected, including the joins between outdoor terrain and interiors. A requested enemy, quest, reward, interaction or transfer needs working behavior and a test. A capacity sketch or prop is not evidence of that behavior. Do not invent unrelated systems to fill an optional field.
4. **Purposeful terrain and dressing.** Fit clearing edges, slopes, vegetation and routes to the activity and landform. Explain and inspect broad grading in the blockout; a rectangle is appropriate for an engineered yard when the brief calls for one, not a default landscape solution. Use local working courts, footing pads and graded connections where they serve the design. Place each asset group for a legible use or story, with tent openings, stalls, carts, supports and props oriented accordingly. Reuse full catalogued assets and request custom constructions where they improve the place. Measure dimensions and texels; resizing or retexturing assets still requires the catalog workflow.
5. **Whole-place review and correction.** Validate actual final terrain plus all relevant colliders, support, enclosure, material scale and both-direction routes. Drive the real player/controller with vegetation and required gameplay active. Review discovery, architecture, terrain transitions, functional activities, inhabited/abandoned evidence, threats, camera and exits against the original description, using [design-review.md](design-review.md). Capture distant, overview and player-height views appropriate to the site. Numeric success does not establish design quality. The coordinator makes a read-only design pass and returns failures to the same owner.
6. **Handoff and installation.** Deliver the reviewed private scene/world, queued ops and inverses, registered catalogs, measurements, gameplay status and evidence identities. Recheck the current main files for concurrent edits. Install only within the user's existing authorization, preserving unrelated work and applying the reviewed content without coordinator redesign. Rebase conflicts and changed inputs through the owner, rerunning affected gates. Verify the installed result matches the reviewed revision.

Plan-mode jobs stop with a surveyed plan and recommendations; no blockout, terrain, game asset, gameplay or installation edits. Build-mode jobs carry the complete authorized scope through review rather than stopping at an entrance or an environmental sketch.

## Read only the relevant mechanics

- Every POI: [../SKILL.md](../SKILL.md), [../README.md](../README.md), and applicable scene/world ops references in `docs/scene-authoring.md` and `docs/voxel-worlds.md`. Populate the existing `poiRequestSchema` and measured review plan **after** the survey supplies real bounds and an approach. Its construction roles are capabilities performed by this POI's owner, not instructions to divide authorship.
- Dungeon/interior: installed `hitreg-dungeon-authoring`, its quickstart/kit, `docs/blender-dc-authoring.md` and the current project plan. Preserve the image-reference, geometry-partition, merged-bake and actual traversal gates. Reuse an existing dungeon's palette only under its applicable reuse policy; record exceptions.
- Town/hub buildings: installed `hitreg-town-authoring` and its WFC builder references when applicable. The owner runs the builder workflow.
- NPCs/quests/shops: `docs/town-npcs.md`; use project gameplay events and existing systems. For other interactions, inspect the live `/__hitreg/spec` rather than inventing component fields.
- New/altered props: `docs/prop-cataloging.md`; culling: `docs/culling.md`; images: `docs/image-generation.md`.

Keep references and full logs on disk. Record setup, building and verification time separately in progress; do not repeatedly reload manuals or rerun unchanged checks. Run `pnpm test` and `pnpm typecheck` before finishing changes as required by the checkout.

## Completion record

The owner maintains `progress.json` and a compact `handoff.json` with:

- Original brief, owner ID, stage and protected scope.
- Measured outdoor/interior usable areas, size reference, route/destination graph and exclusions; requested experience versus built experience.
- Current preview/source paths, replay/inverse ops, asset/catalog identities and review hashes.
- Required gameplay features with implemented/tested status and actual test evidence. Any unfinished requirement keeps the job incomplete; environmental-only is acceptable only when that was the requested scope.
- Real-player walk, visual verdict, remaining problems and the precise limits of the checks. Hash changes invalidate corresponding evidence.
- Coordinates/teleport names, installed identities if applicable, and actionable limitations.

Use `briefed`, `survey`, `blockout`, `content`, `review`, `ready-to-install`, `installed`, or `needs-input` as truthful progress stages. A prepared job is not built; a numeric pass is not visual approval; a user-rejected preview is not ready for installation.

The preparer supplies the initial `handoff.json` structure with unset measurements,
unimplemented required features and no acceptance. Populate it with real evidence
as work progresses; null/empty fields are unknowns, not passes.
