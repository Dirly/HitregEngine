# Ghost authoring

Use this workflow for new spirits, spectral creatures and revisions to existing
ghosts. The Moon-Deep and bestiary ghosts are the approved presentation reference:
fully painted characters under a restrained translucent surface, smooth fading
at the feet, a soft silhouette glow and bright rectangular eyes. The clothing,
weapons, faces and behavior must tell the particular ghost's story. A blue tint
on an unrelated mob is not a finished ghost.

Read [art-direction.md](art-direction.md) and the owning world's premise, roster
and encounter notes first. Shared character assets and presentation live in
`apps/playground/projects/foundation`; world placements and encounters belong to
the owning world. This guide assumes that content checkout is available. The
engine repository itself does not ship those game assets.

## Design the person or creature before the effect

Record a short brief beside the owning content source:

| Decision | What the design should explain |
| --- | --- |
| Origin and situation | Who lived here, what happened, and why this spirit remains |
| Role and behavior | Mourner, sentry, duelist, scholar, hunter, animal or named figure; how it moves and fights |
| Painted identity | Region, faith, occupation, materials, insignia, age and local wear |
| Silhouette and equipment | Actual armor, clothing, hair, face, weapon and supported stance |
| Variations | Meaningful male/female and role differences; hierarchy for rares and bosses |
| Spectral treatment | Shared approved surface, creature-specific eyes and feet, any intentional exception |

A drowned watchman, a temple attendant and a dead pack hunter should remain
recognizable without their glow. Reuse suitable rigs and equipment, but choose
the outfit and weapon for the role. Avoid automatically giving every spirit a
hood, mask, staff or the previous dungeon's symbols. Bosses can be larger and
more ornate, with equipment and attacks that distinguish their role. Weapon
spectacle belongs on the requested named/boss weapons rather than every caster.

Physical people with supernatural eyes are a separate case: Hushed Mother is a
pale, weathered physical human with a stitched-shut mouth and hood, using eyes-only
presentation. Pale Sleepers and charred husks remain opaque physical creatures;
awakened stone guardians remain stone. Do not ghost them merely because they
share a dungeon or donor prefab.

## Reuse the existing authoring paths

Use [armor-sets.md](armor-sets.md), [mob-atlas.md](mob-atlas.md),
[weapon-atlas.md](weapon-atlas.md), and [item-looks.md](item-looks.md) for their
respective assets. Choose actual ubermesh parts and armor types; preserve the
normal player head's geometry, landmarks and UV layout for human faces. Keep
painted ornament and native cutouts rather than adding ornamental geometry.

Measure world-space texel density at the final size, including boss and socket
scales. The established held/worn gear reference is 109 texels/m; use the owning
asset's measured standard and approved ornament treatment. Doubling a character's
linear size requires twice the logical texture resolution to retain the same
pixel size. Increasing a packed page's dimensions alone does not do that. Compare
face, mask, crown, shoulder and weapon pixels side by side in Play.

Record source models, selected parts, atlas recipes, materials, items, animation
clips and measured scale in the collection manifest. Put changes in the producer
as well as installed outputs. Preserve source animation, skinning and shared
physical variants. Scene changes use `applyOps` and the shared JSON file lock.

## Shared presentation and source map

Paths below are relative to `apps/playground/projects/foundation/`:

| Source | Purpose |
| --- | --- |
| `scripts/moon-spirit-look.ts` | Reusable client presentation despite its historical Moon name |
| `scripts/lib/spirit-style.ts` | Shared body appearance strengths, including the owner's 50% body-glow reduction |
| `scripts/lib/spirit-eyes.ts` | Rectangular eyes and measured model/rig fitting |
| `assets/materials/moon-deep/spirit.json` | Current humanoid surface reference |
| `authoring/mob-intake/ghost-surface.md` | Legacy ghost alpha recovery, UV conventions and finishing stage |
| `authoring/moon-deep-mobs/` | Assembled scene/prefab producer, content checks and actual Play capture |
| `authoring/moon-deep-wardrobe/prepare.mts`, `install.mts`, `appearances.json` | Existing human wardrobe producer and per-role sex/face/armor selections; references for a new collection, not commands to overwrite Moon content |
| `authoring/moon-deep-weapons/` | Existing named weapon designs and durable item/effect producers |
| `authoring/moon-deep-guardians/` | Reused wolf rigs, spectral variants and living stone guardians |
| `authoring/helm-eye-effect/README.md` | Real selectable native helmet eye parts and their fit limits |

Read the current script's declared params and relevant prefab bindings rather
than copying stale parameter lists into a new system. Apply presentation to the
intended actor subtree after its named maps or dressed appearance graph loads.
The target reference must be bound to the actual actor when the prefab expands
or spawns. Keep this client-side; existing authoritative combat remains intact.
Placement, floor or water depth, roam envelopes and encounter rules remain the
owning world's work. The ghost presentation does not make an unsupported spawn
or a submerged route traversable.

The shared surface must retain the real dressed texture graph, per-part atlas
choices, skin uniforms, UV orientation and authored cutouts. It adds translucency,
paint-weighted moving shimmer and silhouette emission. It must not replace every
garment with the same flat blue map. Clone/cache appropriately so a spectral
variant never changes the shared material of a physical creature.

Body glow is reduced by half from the initially approved bright presentation;
eyes retain their approved intensity. Apply the body multiplier once to the
combined base, shimmer and rim emission, before the spatial fade. Do not halve
opacity, make the artwork darker, increase the dissolve, or dim the eyes to
achieve this. The live constants are authoritative. Review in normal scene
lighting and existing bloom before changing them; an individual setting should
not silently retune every ghost in the game.
A creature can have a different authored opacity or shimmer strength. Preserve
that profile when adding eyes and fading; apply the final glow reduction rather
than first boosting its material to the humanoid defaults.

## Feet and creature-specific fitting

Use a smooth spatial fade, not a Bayer/dither pattern painted into the atlas.
Preserve genuine ragged holes and cloth cutouts. For legacy pages with baked
dither, use the exact pre-dither source only when RGB and orientation match;
missing provenance is a reported limitation, not a reason to make every dark
pixel transparent. The legacy finishing command is a bounded migration of its
known prefabs, not a generic command that creates a new ghost.

Anchor the fade to actual feet: live capsules use the correct root-to-floor
distance, foot-rooted review stands use their foot convention, and model, actor
and parent scale must be applied exactly once. Human bodies use the approved
.05 to .65 local-metre fade. A wolf needs a shorter quadruped profile so the
fade does not erase its torso. Fade the intended body/paws; a modular head,
helmet or staff should not start fading at its own origin. Both alpha and body
emission must fade together, retaining the authored cut edge.

A new model ID is not automatically supported. Check the current body-model
selector and eye-fit adapter, then add a measured adapter if needed. Reuse the
shared implementation rather than copying the whole shader for each dungeon.
Creature landmarks, bone names and units are model-specific. Human eye positions
must never be reused on wolves or a different rig by assumption.

## Rectangular eyes and helmet reuse

Keep the approved pixel-shaped rectangular cores and soft pale-blue halo. The
eyes are separate from the body shader: changing body opacity, shimmer or glow
must not dim them or apply the foot fade to them. They should follow animation,
remain depth-tested, and be removed when their actor/effect is disposed.

For modular humans, fit to the frontmost visible head, mask or visor surface at
the measured face landmarks. Looking only for a helmet triangle can hit the
back wall of an open helmet and place the eyes inside the skull. Hide the actual
human head for enclosed ghost helms when it conflicts with the intended mask;
keep it for an exposed face. Review front, profile and three-quarter views in
Idle and the relevant movement/cast/attack clips.

For skinned creatures, measure each eye against actual painted UV landmarks and
surface triangles. Follow the weighted/skinned surface when several joints
affect the eye; a rigid head-bone attachment may drift during a howl or bite.
Check both sides, occlusion by brows/ears and the larger variant's scale.

Three native helmet parts also exist: `SpiritEyesMale`, `SpiritEyesFemale` and
`SpiritEyesHelm3`. Their companion items can compose with compatible NPC outfits
as separate texture groups on one helm model. They are not universal closed-mask
fits, and two helm-slot items cannot be equipped on a normal player sheet.
Follow the native-effect README for supported fits, artwork routing, rebuild
hooks and the current 24-part mask ceiling. Do not append unsupported high bits
or globally light the hood to simulate eye glow.

Apply normal item glow after appearance/material styling. The ghost surface
currently builds its own emissive graph, so do not assume native item glow will
survive an arbitrary material pass. Existing ghost NPCs use the independently
fitted eye effect. Select one eye implementation for an actor; avoid duplicate
overlapping pairs.

## Review and acceptance

Build a review scene without world login and show the whole role lineup plus
closeups. Show both sexes and boss/normal sizes when used, eyes unobscured by
labels, all sides of masks/helms, full feet and held weapon poses. Review one
finished representative in its intended dungeon lighting before repeating it.

Check actual Play state and pictures, not just exported meshes or material
metadata. Acceptance requires readable painted identity, restrained body glow,
two visibly glowing eyes where intended, smooth body fade, intact alpha/UVs,
animation-following fit, expected armor/hair and no changes to physical donors.
Inspect indexed visible geometry; a visible attachment group with a zero-index
hidden mesh is not evidence that hair or armor renders. Preserve registered
script names when remapping local entity references.

Existing reference checks, run from `apps/playground`:

```powershell
node --import tsx --test projects/foundation/authoring/moon-deep-mobs/material.test.mts
node --import tsx projects/foundation/authoring/moon-deep-mobs/check.mts
node projects/foundation/authoring/moon-deep-mobs/capture.mjs
node --import tsx projects/foundation/authoring/moon-deep-mobs/bestiary-capture.mjs
node --import tsx projects/foundation/authoring/helm-eye-effect/verify.mts
```

The browser checks default to a private review server on 5294; set
`HITREG_REVIEW_URL` for another server. These commands check the existing
collections; give a new collection equivalent targeted checks and actual Play
evidence. Run repository tests/typecheck as required by the checkout. Record
content failures separately from existing renderer/prewarm or baseline test
failures, and report them accurately. Runtime TypeScript may require a dev-server
restart when a QA config deliberately disables source watching; a new browser
alone can still run cached server transforms.
