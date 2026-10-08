# Town baking and render boundaries

This is the agent-neutral export and installation policy for finished towns.
Read it with the owning WFC kit's construction rules and [culling.md](culling.md).
Construction rules decide which pieces form a valid building; this policy
decides how that valid building becomes efficient runtime content.

Here, **baking means compiling static geometry and compatible materials**.
It does not imply baked lighting, fewer triangles, or merging gameplay objects.
Choose the bake boundaries while planning the town, before exporting geometry.

## Keep source and runtime output separate

Retain the editable kit, building requests, solved layouts, named building/room
ownership, source textures, and source Blender collections or prefabs. Baked
assets are derived output under the project's assets folder. Fix the generator
or source and rebake the affected unit; do not hand-edit a compiled town.

Record the source paths and revision/content hashes, exporter version/options,
building and room ownership, and world anchors with the bake's authoring report.
Atlas layout changes invalidate every output using moved islands. Preserve
stable asset/entity identities where possible so NPCs, doors and scripts keep
their references. Install scene changes through `applyOps` and retain inverse
ops plus the previous derived assets for rollback.

## Choose units by what can be visible together

| Content | Default runtime unit |
| --- | --- |
| Near exterior | One building shell; split a large hall, castle or long wall into independently cullable sections. |
| Interior structure and static furnishings | Separate room or floor units, kept apart from the exterior. Use smaller units where different rooms have different visibility. |
| Small static street dressing | A local section with the same visibility lifetime, or existing instanced prop batches for repeated assets. |
| Doors, NPCs, loot, movable props and independently controlled effects | Preserve separate entities, behavior bindings and transforms. Do not absorb them into static geometry. |
| Distant town silhouette | An explicitly integrated block/district HLOD proxy, with interior detail omitted and a verified near/far handoff. |

A whole town or district is not the default **near** mesh: seeing one corner
keeps all its merged geometry eligible to draw. Conversely, splitting a district
into many buildings while retaining every material slot can increase draw calls.
Consolidate compatible materials before or alongside splitting it. A small
street cluster is an allowed measured tradeoff when its buildings are usually
visible together; record the reason and compare it with individual shells.

Do not duplicate shared walls or floors when dividing units. Assign each surface
an owner. Keep anything needed to close the outside silhouette or visible through
a doorway/window in a unit that remains visible from that viewpoint. Stairs,
galleries, atria and open porticos need explicit review across unit boundaries.

Attach culling boundaries to these units; a descriptive name alone has no effect.
The current engine's `interior` culling is proximity to bounds, **not doorway
or portal visibility**. Choose conservative reveal distances from actual sight
lines, including windows viewed from the street. Buildings currently do not
occlude other buildings; terrain supplies the horizon occlusion test. Merely
splitting meshes does not implement building occlusion. Base-scene assets also
do not become district HLOD proxies simply by being named or exported as one.

Rendering visibility must not remove collision needed by the player or simulation.
Keep colliders and gameplay ownership valid when render-only interiors disappear.
Simplified collision is useful only when it preserves doors, stairs, floor
support and relevant openings; validate the assembled capsule route.

## Atlas first, merge compatible materials second

**Every town is atlased, by a pipeline step, not by hand.** `apps/playground/tools/town-atlas.mjs`
puts all of a town's buildings on ONE texture page and ONE kit material (WindowGlass stays its own
material for its night glow). It runs in place on `assets/models/towns/<town>/` — the scene keeps
referencing the same files — and keeps the un-atlased exports in
`authoring/atlas/towns/<town>/src/` with `atlas-report.json` and `atlas-page.png` for review.
Repeat-preserving: UVs are left as authored and each vertex carries `_ATLASRECT` (its tile on the
page); the runtime material (`packages/render/src/town-atlas.ts`) wraps inside the tile per fragment.
Workflow: the building-constructor exports into the town folder as always; `zonegen status` shows
`town <name>: atlas` STALE (a fresh export is not on the page) until
`node tools/town-atlas.mjs projects/<p>/assets/models/towns/<town>` folds it in. `--check` prints the
state; `--all --project <p>` runs every tagged folder. Any OTHER model folder (a ruin kit, a POI's
building set) opts in by containing an `atlas.json`. A material is folded only when it is a plain
opaque base-colour kit material (no tint, metallic 0); others are kept and reported.

Use the shared project atlas tooling described in
[tools/wfc-3d/README.md](../tools/wfc-3d/README.md). Preserve the established
world texel density and nearest filtering. When new art is required, create
individual source tiles, downsample them appropriately, then pack with the
tooling; do not ask image generation to draw a complete atlas layout.

Packing textures alone does **not** merge material slots or glTF primitives.
Likewise, a fixed prop with `mesh.static: false` does not enter the existing
static batcher. Declare fixed placement meshes static (including prefab child
overrides); preserve moving, animated, scripted and independently hidden parts.
Check the expanded runtime output: a scene may have batched building furniture
while newer outdoor POI props still each draw separately on the same atlas.
The target is one primitive per compatible material/render state and atlas page
within each bake unit. Count the actual exported primitives and runtime draws,
including shadow passes. One GLB file or Blender object is not one draw call.
Multiple pages, transparency, or special shaders can legitimately require more.

Compare the complete material/render behavior before merging: texture roles and
UV sets/transforms, factors, alpha mode/cutoff, sidedness, normal and roughness
settings, emission, shader extensions, depth/shadow behavior and runtime bindings.
An image filename or material name is not a compatibility key. Preserve semantic
roles in the editable source even when compatible output slots are consolidated.
An emissive mask can share an otherwise compatible atlas material; independent
emission controls, wind and fire effects must retain their behavior. In particular,
preserve the engine's Embers/fire material path on props that use it.

**Resolve repeating UVs before atlas remapping.** The existing WFC packer clamps
UVs outside the unit square and warns. That warning is a failed review for a
finished town: clamping a tiled wall destroys its texture scale. Split triangles
at tile boundaries and remap the resulting islands with padding, or use another
validated repeat-preserving representation. Applying `fract` to vertex UVs alone
does not fix triangles crossing a seam. Check tile orientation and pixel density
on large walls, undersides, trim and thin parapets after export.

Retain the bridge-compatible self-contained texture embedding and shared image
identity used by the existing pipeline. Do not give every building a unique
copy of an otherwise identical GPU texture/material. A single page is a useful
target when it fits at the required density, not permission to degrade the art.

## Review before installing a new bake

1. Record source and output counts: primitives/material states, triangles,
   texture pages, UV wrapping issues and each unit's bounds. Check retained
   gameplay IDs, anchors and source ownership. Explain any increase in geometry.
2. Compare the assembled output with its source at matching viewpoints: street,
   side/rear, roof, entrance, interior, stairs and upper floors. Check gaps,
   coplanar overlaps, shading, texture scale, windows and effect behavior.
3. Walk through doors and every stair flight with the actual player capsule.
   Exercise culling from both sides of entrances and windows, across room/floor
   boundaries, and through any near/far transition. Inspect shadows as well.
4. Report draw/triangle changes separately from frame time. If claiming an FPS
   gain, use the profiler and comparable warmed camera views; follow
   [performance-lessons.md](performance-lessons.md). A draw reduction is useful
   evidence but is not an FPS measurement. Run the repo-required checks for any
   tooling or engine changes.

Include the nearby POIs in the overview check, not just the building shells.
A district proxy cannot reduce unbatched market stalls, grave markers, supplies
or signs placed outside that district model. Measure their actual submissions
and keep their compatible static meshes grouped within the visibility units
above. A screen-size cutoff on a whole meadow's detail group measures the whole
meadow, not the size of each crate; it cannot be assumed to remove tiny props.

## Existing exporter limitation

For an existing base-scene town, the instanced mesh path can now use an authored
3D far proxy and a per-asset switch distance (see the mesh schema in the spec).
The proxy must be a single static mesh/material in the original model frame.
Its collider remains the original source. Missing or invalid proxies retain
full geometry. `town-install.mts` accepts reviewed far-proxy metadata per district
and rejects stale source hashes by falling back to detail. This is an optional
distance representation; it does not implement per-building near partitions or
replace the streamed HLOD pipeline.

Judge proxies against the source from the approach, hills and above. Preserve
roofs, towers, outer walls and the gaps between buildings. A district billboard
can materially change that silhouette as the camera angle changes; use simplified
3D geometry when it fails the comparison. Texture detail may become averaged
vertex colours only beyond the reviewed switch distance. Treat a proxy as derived
content: catalog it, retain its source hash, and rebuild it after a source change.

As audited on 2026-10-01, `MMO/WFC/wfc/export_town.py` joins source collections
into **one GLB per district** and retains multiple material slots. Its material
deduplication uses an image/name key, not a full compatibility check. It does not
run the atlas packer. `apps/playground/tools/town-install.mts` consumes that
district manifest and installs one render/collider entity per district.

That legacy path is not an implementation of the partitioned bake policy above.
Migrating a town requires exporter and installer support together, source-level
shell/interior ownership, repeat-safe UV conversion, material consolidation, and
the review gates. Keep working installed towns intact until replacement assets
pass. Do not silently run the current packer on a tiled district GLB or claim a
town was rebaked merely because this policy or its source layout was updated.
