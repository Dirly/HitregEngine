# Dungeon texture requests and theme control

The default dungeon request set contains **eleven textures**: retain all eight existing stone roles and add
wood, metal and smooth/polished stone. These are additions, not substitutions. Preserve this order for new
palettes based on the current kit:

| Slot | Stable role |
| --- | --- |
| 0 | `large-ashlar` |
| 1 | `coursed-stone` |
| 2 | `small-brick` |
| 3 | `flagstone` |
| 4 | `dressed-trim` |
| 5 | `vault-ceiling` |
| 6 | `basalt` |
| 7 | `lichen` |
| 8 | `wood` |
| 9 | `metal` |
| 10 | `smooth-stone` |

Every request set includes the three additional roles even when the first room does not use them:

| Stable role | Image request intent | Material behavior |
| --- | --- | --- |
| `wood` | One theme-appropriate timber type; readable grain, no assembled beams, framing or hardware | Nonmetallic; align grain along beams when assigning UVs |
| `metal` | One theme-appropriate continuous metal surface; no bars, gates, rivets or painted reflections | Set metallic and roughness in the material asset; the texture supplies base color |
| `smooth-stone` | Continuous smooth or polished stone; quiet mineral variation, no block joints, mortar, relief or carved objects | Nonmetallic; control polish with roughness and scene lighting |

Theme the appearance of all eleven roles to the dungeon. Additional roles such as earth, debris or treasure can
be requested when needed, within the current schema capacity. Do not drop an original stone role to make room
for the three additions. The complete material library need not be painted onto every mesh. Read the current
material/voxel schemas for layer capacity.

## Requesting a coordinated set

Define a shared brief covering the dungeon theme, color family, wear, visual style and world scale. Request each
surface separately, carrying that brief into each request and stating the intended stable role. Use seamless,
straight-on, evenly lit base-color tiles without baked highlights, directional shadows or perspective. Keep the
usual 2 m per tile unless a project explicitly defines another density. Store actual generation prompts only in
the image-request queue; project manifests reference request IDs, roles, source/runtime assets and hashes.
Generate the set with one `image-request.mjs gen-set` manifest whose shared `brief` carries the theme across all
eleven tiles — see `docs/image-generation.md`.

Before dispatch, check that `wood`, `metal` and `smooth-stone` each have a request or an explicitly accepted reused
asset. A masonry texture with mortar does not satisfy `smooth-stone`. Before calling a set complete, inspect the
three required surfaces along with the rest of the palette in repeat and on representative geometry. Record
roughness/metallic choices alongside the asset mapping; an image of a shiny surface does not provide those settings.

## Controlling appearance through assets

Keep stable, project-namespaced material IDs and a manifest mapping semantic roles to texture/material assets.
Theme variants replace the textures and material parameters behind those roles. Props and generated constructions
can use the same library: wood for scaffold beams, metal for gates, smooth stone for carved skulls. A separate prop
material need not occupy a DC painting layer unless the surface is actually painted onto the DC mesh.

Preserve painted region/slot meanings across theme swaps. Existing projects must retain their palette order;
append missing required roles where supported, or make an explicit slot remap and update dependent recipes and
audits together. Do not silently reinterpret an old painted layer. Adapt template material audits from the
eight-role example to the eleven-role default before using the expanded palette. An atlas is optional packaging, not the
source of the role mapping.

For Derek's appearance tests, prioritize strong visual changes using the same geometry. A mound may stand in for
bones, coins or other piles by switching its assigned surface. Silhouette differences do not block these tests.
Such a swap demonstrates asset-controlled appearance; it does not automatically change gameplay, collision or
the object's semantic identity. New mesh variants are only needed when requested or when geometry is the test.
