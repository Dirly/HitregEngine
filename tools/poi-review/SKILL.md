---
name: hitreg-poi-review
description: Plan and review HitReg outdoor POIs and dungeon approaches through the shared CLI/API, measured terrain integration, supported dressing and player access checks.
---

# POI site review

For complete POI creation/revision, start with [POI Creator](creator/SKILL.md).
It owns the adventure brief and single-author workflow; this reviewer supplies
the site-level planning and measured gates within that work.

Use `tools/poi-review/cli.mjs` or registered `hitreg.poi-review`; both run the
same read-only checks. The canonical manifest is validated by `schema.mjs`;
`schema.json` is its generated machine-readable form.
For the end-to-end agent-agnostic authoring process and a sized work-plan tool,
start with `README.md`. `plan-cli.mjs` and registered mode `plan-poi` share one
request schema and implementation; they create a plan, not an installed POI.
Read the active checkout's `CLAUDE.md`. Dungeon construction also follows the
installed dungeon-authoring skill; town generation follows its own workflow.

## Design against the place

For MMO POI creation/resizing and webs or other overhead dressing, read
`tools/poi-review/poi-design-rules.md`. Choose a pinpoint/small/medium/large playable-space
target, measure usable area separately from the edit footprint, and prove visible
attachments on final supports rather than relying on transparent plane corners.

Survey before choosing the footprint. First identify an established accessible
road or other verified playable ground; a clear ridge beside the POI is not proof
that players can climb there. Supply the current world recipe and a
bounded site in a manifest; `models: []` produces a terrain survey marked
incomplete for construction acceptance. Read the sampled rendered heights and
normals, the approach from surrounding playable ground, nearby roads and major
POIs. A heightfield alone misses carved caves and overhangs. Survey bounds must
start in air above the site and extend below the lowest proposed floor.

For a difficult ascent, `route-cli.mjs --world <world.json> --search <search.json>
--out <route.json>` proposes a route using a heightfield and limited cut/fill.
`terrain-route-schema.json` is generated from `routeSearchSchema` in
`terrain-route.mjs`. The registered tool's `plan-route` mode accepts `{world,
search}`. Search includes elevation choices, rather than forcing all waypoints
onto untouched ground. Its result is a planning candidate: inspect turns and
shoulders, smooth the route without violating grades, edit the terrain, then run
actual collision review. A coarse heightfield search cannot prove cave, cliff or
scatter clearance.
Supply padded `avoid` footprints for existing structures and protected POIs.
Plan terrain access to an exterior landing, then test the join with the actual
architectural colliders. A buried foundation still blocks a path even if the
terrain by itself is walkable; reach the entry's floor height before crossing it.

Check nearby legs of switchbacks in plan and section before applying a graded
road. Different elevations need room for both trail corridors and the terrain
voxel footprint; a heightfield cannot stack them. Two individually gentle legs
can become a steep lip where their grades compete inside one terrain cell.
At a snag, compare actual triangle floor profiles with the intended road heights
and isolate nearby terrain features before widening or changing tolerances.
The planner runs `auditTerrainRouteSeparation` from `route-separation.mjs` and
marks stacked or closely competing grades `usableCandidate: false`. Run that
audit again after smoothing or manual route changes. A found search path with
unresolved separation conflicts is not a usable construction plan.

Use `kind: "terrain-route"` for outdoor access segments without constructed
models/materials/support probes. Long trails can use consecutive bounded reviews
with exactly shared endpoints; verify the chain begins on established playable
ground and ends on the local POI approach. Keep segment reports on the same world
hash. `reviewRouteChain(reports, {start, end, currentWorldHash})` from `chain.mjs`
checks ordered reports for gaps, stale world identities and missing reverse/lane
passes. Do not substitute a collection of disconnected passing segments.
Include architectural colliders in the trail review wherever it reaches the
POI; `terrain-route` permits their absence only where no structures affect access.

Record the purpose, how the player discovers it, where the interior leads, and
how terrain supports it in `intent`. Choose spacing by the zone's pacing, not a
universal dungeon distance. A dungeon approach needs a reason to exist; a turn
must lead to a plausible volume inside the mountain, not the exterior wall the
player just walked beside. Draw the entrance section including actual ground,
floors, roofs and the volume beyond a portal before baking.

Terrain is editable design material. When authorized to create or revise a POI,
shape slopes, build shoulders, cut entrances and blend outcrops within that
scope. Use recipe ops and preserve unrelated features. Don't contort the route
around untouched terrain just to avoid landscaping. Organic walls and rock
outlines need distortion; keep walking floors usable, with wear toward edges.

## Measured gates

Run `node tools/poi-review/cli.mjs review --plan <manifest.json> --world
<world.json> --assets <project/assets> --out <report.json>` from the engine root.
`pack` with the same arguments creates a portable bundle for the registered tool.
Review an existing bundle with `node tools/poi-review/cli.mjs review --bundle
<bundle.json> --out <report.json>`; this needs no project asset paths.
Models must be self-contained GLB/glTF; list the final relevant collision models
with their world transforms, including neighbouring obstructions. Resolve scene
prefabs first. This tool does not infer missing scene colliders.

- Include a route from unmodified surrounding playable ground through the
  entrance to its actual destination, in both directions and lateral lanes.
  Use the game's player dimensions. Do not start the proof on an isolated landing.
- Mark enclosed segments for headroom sampling. Headroom is roof minus the floor
  under each sample, not roof minus the scene datum. Sample door width and turns,
  and include routes for fall recovery if a fall is possible.
- Include foundation support, buried wall/roof points and protected terrain-air
  probes throughout the passage. Sparse probes are evidence at those points,
  not certification of an entire enclosure; increase coverage around cuts/edges.
  Exclude the supported object from support rays so it cannot support itself.
- Model masonry sharing exposed surfaces in one unioned field, or place joins
  inside stone. Per-mesh manifold checks do not prove a clean assembly. The tool
  detects cross-instance coplanar intersections, not all self-intersections or
  all depth-buffer artifacts; retain the DC mesh audit and inspect moving views.
- Modeled joints get continuous stone grain; texture joints are for surfaces
  without modeled joints. Compare world metres per texel against the biome.
  `materials` are explicit author declarations that the visual reviewer must
  verify against actual assigned assets, not automatically inferred image content.

Failures block acceptance. Repair the terrain, route or construction and rerun
affected checks. Hashes identify the exact world, model bytes and manifest;
reports are stale after any corresponding change. Never call an incomplete
survey or a subset of passing tests a completed review.

## Visual reviewer and handoff

`needs-visual-review` is the successful numeric outcome, not a final approval.
Before interpreting that outcome, check that the manifest actually covers the
site's claims: enclosed routes have enclosure markers and headroom samples,
buried construction has burial/air probes, supported objects are excluded from
their own bearing rays, and the access origin belongs to the playable network.
These semantic choices cannot be inferred from an arbitrary bundle of meshes;
an omitted claim is unverified, not a pass. Record this coverage review explicitly.
Review a player-height approach, front/side views, doorway, interior and terrain
section in a private preview. Check discovery, scale, believable burial, terrain
transitions, organic distortion, supporting feet/base, material scale and seams.
Test the real player/controller in engine as well. Record screenshot paths,
remaining problems and a reasoned verdict alongside the report hashes. When a
separate reviewer agent is available, ask it to evaluate the plan and evidence
without the builder's claimed verdict; otherwise make an explicit separate pass.

Do not silently accept visual failures because traversal passes. A visual-only
portal is not a working dungeon transfer; state its actual behavior. Finish with
what changed, where to inspect it, which gates passed and any genuine limitation.
