# Spider asset placement

Shared placement guidance for Claude, Codex and other agents. Use it for spider
habitats in woodland, abandoned buildings, caves and dungeons. It records Derek's
Webbed Wood corrections from 2026-11-06 and the intended indoor adaptations;
indoor placement automation has not yet been built or verified.

Read [art-direction.md](art-direction.md), then the owning place's brief, routes
and current review. Follow the normal [content workflow](workflows.md) for that
location. This guide adds spider dressing rules; it does not replace dungeon
construction, encounter design or the place's installation gates.

## Build a connected infestation

Connect patchy floor deposits, irregular growth on nearby surfaces, supported
draped webs, egg nests and hanging prey. Leave quieter gaps so the densest nesting
or feeding pocket reads clearly. A handful of isolated eggs and floating web
cards does not establish the habitat.

| Layer | Placement rule |
| --- | --- |
| Floor silk | Noisy, irregular deposits over local litter, timber or stone, with exposed floor between patches. Avoid painted paths, broad brush shapes and unexplained sand. |
| Surface silk | Broken patches climbing trunks, rocks, walls and beams. Preserve exposed surface; avoid horizontal wraps and cloth bands. |
| Suspended silk | Sag between real supports at varied heights and directions. Include low trunk-to-ground, bough-to-ground and tree-to-rock connections outdoors. |
| Eggs | Prefer darker intact variants on compact, irregular silk bedding fitted to the clutch's footprint. A modest supporting rim is enough; the mound must not dwarf the eggs. |
| Prey and remains | Hang existing cocoons from actual branches, beams or ceilings with visible suspension. Seat floor remains on the real floor. Avoid repeating the rejected broken pale egg cluster over an exposed bone pile. |

Reuse suitable catalogued assets through the place's dressing workflow. Current
Webbed Wood nest assemblies include `composite-props/silk-nest`,
`composite-props/silk-egg-clutch` and `composite-props/silk-brood-nest`; existing
`culture-craft/spider-hanging-human-prey` and
`culture-craft/spider-hanging-deer-prey` prefabs supply hanging victims.
Inspect the current prefab and dressing declaration
before reuse. Some older raw spider props contain the rejected free web cards or
single strands. Remove unsuitable attached web geometry in the owning producer,
retain useful eggs or prey, and regenerate/catalog the changed asset.

## Find supports before generating webs

Measure surrounding trees' transformed height, crown width, trunk diameter and
species mix. Keep native size cohorts and matching collider transforms. Fit webs
to the forest; do not shrink trees to lower their branches. Check the entire
basal rim against the final rendered ground, not just the pivot.

Choose finite points on actual transformed support surfaces. A bounding box,
tree centre, infinite plane or transparent leaf-card corner is not a contact.
Use exposed structural bark or boughs and actual rock faces. Vary attachment
height, spread and direction with a stable seed, then reject unsupported or
obstructive candidates. Randomness alone does not make placement believable.

Use subdivided quads for ordinary sheets and sag the interior under gravity.
An intentional three-anchor patch is acceptable with matching triangular edge
coverage. Keep the texture continuous across internal mesh triangles. Sparse
load strands must meet both a real support and visible silk within the sheet;
a strand ending in a fully faded or transparent hole still looks disconnected.

Reserve movement, fighting and third-person camera space before filling gaps.
Keep most broad spans overhead, with low skirts beside the route. Measure the
whole sagged sheet against the actual player/camera envelope. The outdoor
generator's clearance and exclusion values are not universal indoor dimensions.
Decorative webs should not silently become collision walls. A blocking web needs
explicit gameplay behavior and testing.

## Keep the silk readable and continuous

Use one pale neutral silk family across floor, bark, rock and suspended sheets.
Balance their apparent brightness together under normal lighting. Translucency
must leave threads visible against foliage, bark and floor, not only the sky.
Avoid opaque brilliant white walls, but do not fade the infestation until it
disappears. Start from the current shared materials rather than inventing a
different opacity for each placement.

Tiled artwork and sheet coverage are separate: repeat the seamless thread texture
at measured physical scale, and fade the whole sheet's perimeter using independent
continuous coordinates. Do not fade each internal triangle or stretch one texture
over a larger span. The current shared tile is 256px over 6.4m, matching world-kit's
40 texels/m. Preserve physical density when changing span size. Consult the live
spec or `spec.json` for material capabilities and the shared JSON for settings.

For surface growth, use continuous projection and joined, consistently offset
surfaces with compatible smooth normals. Separate face atlases, flat face offsets
and mismatched normals caused the visible bark seams. Break coverage with an
irregular continuous mask, sampled finely enough to avoid triangular alpha
patches. The existing shell implementation uses world triplanar artwork and
vertex alpha. Preserve all four color components through model merging and static
batching: dropping alpha restores unwanted solid coverage. Review the actual
batched result, including sorting and overlapping transparent layers.

## Adapt the supports to the location

| Location | Supports and composition |
| --- | --- |
| Woodland | Trunks, exposed boughs, rocks and ground. Keep native tree scale, connect nesting pockets and continue into deeper woods. |
| Abandoned building | Beam joints, rafters, posts, corners, broken openings and furniture edges. Concentrate brood in sheltered spaces and use ceiling height for hanging prey. Retain readable architecture, doors and stairs. |
| Cave | Actual wall shelves, rock projections, ceiling pockets and floor. Follow the uneven chamber shape with ceiling-to-wall, wall-to-floor and rock-to-rock connections. |
| Dungeon | Pillars, arches, vaults, wall returns and corners. Build silk around occupied rooms and recesses while preserving entrances, encounter space, stairs, portals and retreat routes. |

Indoor floors and ceilings must come from the actual room or cave geometry.
Outdoor terrain height cannot locate an upper-storey floor, a tunnel beneath
terrain, an overhang or a ceiling. Prove each anchor, deposit and egg seat against
its specific surface; hanging prey must also clear the floor and route. Check
silk under actual indoor lights while keeping room materials readable; do not
make it emissive to rescue poor placement.

Keep webs as separately supported visual meshes where dungeon conversion would
discard their UVs, alpha or coverage coordinates. Respect room/interior culling
and portal ownership so a connecting sheet does not disappear at a doorway.
Follow the dungeon workflow before changing structural cave or masonry geometry.
Spider dressing is not a reason to rebuild the room shell.

## Reuse the implementation without copying a whole site

Shared assets live in `apps/playground/projects/world-kit`; placements, fitted
geometry and encounters belong to the owning world or dungeon project.

| Reference | Purpose |
| --- | --- |
| [Spider web toolkit](../apps/playground/projects/world-kit/authoring/spider-webs/README.md) | `generate.mts` discovers supported tree-pair spans; `skirts.mts` plans ground skirts and tree-to-rock patches. Read current interfaces and limits before use. |
| `world-kit/assets/materials/spider-habitat/` | Shared drape, growth, skirt, triangular patch and load-strand materials. |
| `world-kit/authoring/spider-webs/catalog.json` | Shared runtime asset identities and dependencies. |
| [Webbed Wood repair](../apps/playground/projects/redstrand/authoring/zonegen/redstrand/zones/zone-1/pois/webbed-wood/repair/README.md) | Working reference for `silk-shell.mts`, floor deposits, compact nesting, support audits, visual evidence and reversible publication. |

These references require the corresponding content checkouts; the engine does
not ship those assets. The Webbed Wood replay edits that specific POI: do not
run it to dress another place. Supply explicit destination project, scene,
ownership IDs and output paths when using the shared planner instead of inheriting
its sample defaults.

Compare the actual [level-eye habitat](../apps/playground/projects/redstrand/authoring/zonegen/redstrand/zones/zone-1/pois/webbed-wood/repair/evidence/lightweight/postfx/habitat-core.png),
[close bark coverage](../apps/playground/projects/redstrand/authoring/zonegen/redstrand/zones/zone-1/pois/webbed-wood/repair/evidence/lightweight/postfx/habitat-bark-close.png)
and [tree-to-rock connection](../apps/playground/projects/redstrand/authoring/zonegen/redstrand/zones/zone-1/pois/webbed-wood/repair/evidence/lightweight/postfx/habitat-mixed-contact.png).
The repair's acceptance record identifies those reviewed bytes and capture limits;
new sites still need their own integrated review.

The current planner discovers selected tree/rock models and uses outdoor terrain.
Building beams, arbitrary cave meshes and dungeon floors/ceilings need an explicit
support/floor adapter and a representative verified sample before procedural
population is claimed to work there. Reuse the material and coverage approach
while adding that capability. Do not hide failed contacts with floating cards.

## Placement and review sequence

1. Survey the final space, supports, native scale, routes, camera space and existing
   assets. Record protected content and the intended densest pockets.
2. Finish one representative pocket with floor, surface growth, drapes, a compact
   clutch and supported prey where appropriate. Review at player height before
   repeating the treatment.
3. Populate with varied supported attachments. Recheck full prop bases, child
   egg-to-bedding seats, hanging load paths, texture scale and clearances.
4. Inspect close bark/rock/wall joins, level-eye webs against dark backgrounds,
   ground transitions, approaches and the whole place. Use actual materials,
   lighting, postprocessing, LOD and batching; state any preview omissions.
   Counts and contact tests do not establish visual quality.
5. Walk routes both ways with the real controller and normal colliders, including
   entrances, stairs and exits. Test requested encounters or blocking webs.
6. Update the producer and registered catalogs. Apply scene/prefab changes through
   locked `applyOps` batches and terrain changes through scoped recipe edits;
   retain their inverses. Install reviewed bytes while preserving unrelated work
   and shared-asset consumers. Record source/evidence identities and verify the
   installed result. Changes to geometry, materials, floor or supports invalidate
   the affected checks.

Reject floating or invisible webs, repeated cloth strips, close geometry seams,
unsupported prey, giant pale egg mounds, mismatched tree sizes and painted routes.
Correct the cause in the representative pocket before repeating that treatment.
