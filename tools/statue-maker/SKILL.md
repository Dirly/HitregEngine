---
name: hitreg-statue-authoring
description: Build static stone statues from HitReg human kits or existing mob models, with baked poses, outfit choices, smooth shading, supported pedestals and verified scene placement.
---

# HitReg statue authoring

Use the reusable `hitreg.statue-maker` tool in this folder. Read [README.md](README.md) for its current CLI, recipe, human profile helper and registered-tool contract; use the tool's declared inputs rather than inventing fields. Start with the active project's source assets and saved statue recipes. Follow [CLAUDE.md](../../CLAUDE.md) for scene ops and project boundaries.

## Choose the source and pose

- **Human kit:** choose male or female from the project's creation catalog. Resolve the actual body/head parts, hair, hood, robe and shoulder options through the profile helper and catalog. Use their authored mounts and sex-specific remaps. Do not guess part indices or assume male mounts fit female parts. Default to simple shoulders; ornate pads are an explicit art choice, not a default.
- **Existing mob:** use its actual glTF model and selected parts/attachments. Freeze the authored rest pose or a named animation clip at a chosen time. A custom skeleton requires its own bone mapping for procedural posing; a humanoid arm solver is not an automatic pose generator for every creature. Report unsupported source capabilities instead of quietly substituting a human.
- For a sword-rest pose, solve the hands against the actual sword grip/pommel and support its point. Check wrists, elbows, hand contact and weapon orientation in the baked result. A source animation used offline does not authorize a runtime animation component.
- Preserve the source's head shape. Do not add geometric eyebrows, nose or mouth blocks to compensate for a texture-driven face. Existing hair/hood meshes are appropriate options. Check hood/hair intersections and use the kit's intended hiding/remap rules.

The requested height means the figure from lowest sole to highest head/hood/hair point, excluding the base. A relative size request refers to the existing figure being discussed: record the resulting metres in the recipe before generating. Monumental placement and a town-sized statue share the same generator.

## Bake a real static asset

Bake the selected pose, skinning, supported morph state and attachment transforms into the exported geometry. Inspect the report: no runtime skins, animation clips, animator, character script or rig should be needed by the statue. The output prefab must have an empty foot anchor; geometry and exact static colliders belong beneath it.

Use smooth shading on the statue: normals must be calculated on the posed geometry, with the tool's smoothing boundaries preventing unrelated parts or opposite thin-blade faces from merging. Smooth normals do not require smoothing away the silhouette. Inspect shoulders, elbows, robe folds and the face in a close render; a metadata flag alone is not proof.

Keep the source assets untouched. Save a project-local recipe, source hashes, model/prefab/material outputs and a build report so another agent can regenerate or change an option. Use the registered host's asset writer or the documented CLI output route; do not embed one project's paths in the reusable tool.

## Stone and base

Match the surrounding world's **metres per texture texel**, not just image dimensions. Measure texture size and world repeat. The current MMO ground near Brinehold is approximately 2.7cm/texel; treat that as a measured local example, not a universal engine constant. Use nearest magnification where the project's stone/ground uses it. Downsample individual source images with the existing tooling before any atlas packing; do not ask image generation to paint a packed atlas.

A statue benefits from quiet mineral variation and rough stone. Large cobble/mortar patterns obscure human forms. A proper pedestal uses dressed stone, a readable plinth and cap, and proportionate bands, recessed panels or other architectural decoration. Crushed-rock texture is not a substitute for a carved architectural base. Weather exposed edges without destroying the flat bearing surfaces.

Use a validated pedestal prefab and its measured top/footprint contract. Confirm the figure's feet and supported sword fit on that top and that the prefab's declared height matches the model. A supplied pedestal reference is not proof of support. For a base containing a tomb, portal or walkable chamber, follow the installed `hitreg-dungeon-authoring` workflow and [Blender/DC authoring](../../docs/blender-dc-authoring.md); this skill does not replace structural, terrain or traversal validation.

## Install and verify

Read current scene/context and pins before placement. In this world north is -Z. For an ocean-facing monument, sample the real coastline, record the heading, and inspect a view from the sea/shore and the intended approach; do not infer the ocean from a convenient camera angle. Keep large landmarks separated as requested.

Install with scoped `applyOps` and retain inverse ops, preserving unrelated entities and the user's spawn/camera. Sample actual rendered terrain for the base, not only a procedural height approximation. Prove underside burial, feet/base contact, sword contact where relevant, and exact published-mesh collision. Keep existing circulation clear; a walkable tomb also needs real-capsule and live approach checks. Read the current physics schema and assert the parsed test actor is actually kinematic: an unrecognized rigidbody field can silently leave the default dynamic body, producing misleading slope failures.

Inspect a cold renderer load, a close pose/material view and a normal-distance silhouette. Clear procedural vegetation from the actual structure and approach footprint. If an exclusion appears ignored, compare the recipe received and registered by the browser with the final file before changing generation code. Match claimed visibility to the actual captures: a crown peeking over a ridge is not a full-statue vista. Record passed, experimental and unresolved items separately. Toolkit changes need its focused regressions plus the repository's required test/typecheck/spec checks; a content-only texture adjustment needs the affected asset and visual checks.
