# Dungeon placement and self-review: the Weeping Sun bar

Owner direction, 2026-11-08: Weeping Sun Tombs is the current quality reference.
Moon-Deep and Sunken Temple were called out as too cluttered; Weeping Sun also
needed unnecessary props removed. These are owner judgments, not a new measured
audit of those other dungeons. This note authorizes no scene changes to them.

Use the owner's original-WoW comparison as a density brief: a few objects where
they matter, strong architecture, readable encounters and deliberate empty space.
Carry forward the quality of the decisions, not Weeping Sun's layout, religious
motifs, exact light values, prop inventory or room-specific creature rules.

## Placement decisions before adding objects

For each significant room, record its purpose, focal feature, combat and travel
space, and the few supporting prop groups that make those things readable. A
focal feature can be architecture, a mural, a mechanism or the encounter itself.
A transition can be intentionally quiet and contain no loose props. Empty floor
is useful space, not unfinished work; the architecture and painted finish still
need to be complete.

Each prop group needs a visible job: interaction, navigation, a credible light
source, evidence of the occupants' activity, or support for the focal feature.
"Fills this corner", "adds variety" and "meets the count" are insufficient.
Group supporting objects at a few meaningful anchors instead of distributing
one at every interval. Keep the approach to a hero feature quieter than the
feature. Repeated architecture and painted surfaces can carry richness without
another freestanding object or decal.

Reserve doors, gate travel, stairs and approaches, pull setup, melee movement,
caster sight lines, patrol crossings, retreat and hazard recovery before dressing.
Use the actual party/creature and camera footprint. A centrepiece may occupy the
middle deliberately; a spare brazier should not consume a pull or turning lane.
Wall placement alone is insufficient: objects can still hide murals, block a
camera, obstruct a niche or trap a knocked-back player against the wall.

Before repeating a group, inspect one finished example at player height from
the approach, side and reverse. Then distribute selectively. For candles, use
supported ledges and a seeded selection of burial bays at different heights;
do not fill every shelf or scatter candles uniformly over the floor. Keep the
seed stable while reviewing. Repeat with variation in location and purpose,
not by adding unrelated prop types to every room.

Finish with a **removal pass**. For each group, ask whether removing it improves
the route, focal read or theme without losing its job. Remove redundant groups
and their dependent lights/VFX. Record the retained groups and the reason for
any deliberately dense pocket. Judge density in the player view and in combat,
not only from above or by objects per square metre.

## What Weeping Sun taught us

| Correction | Rule to carry forward |
|---|---|
| Remove central entrance/crossroads/pre-arena braziers, pit clutter and most walkway fire. | Put fixtures at useful architectural anchors. Preserve preparation and fight space. More fire is not the default response to a dim scene. |
| Remove wooden chests, black coffins and mismatched sarcophagi. | Reuse requires a theme and scale check. Remove an unnecessary object rather than spending another pass making it fit. |
| Move candles onto selected upper/lower crypt shelves. | Use existing architecture and vertical composition; avoid a continuous floor-level border. |
| Space useful brazier pillars and remove redundant bare pillars. | Preserve supports that explain structure or light the route. Review distribution across the whole room, not one end in isolation. |
| Fit statues to pedestals; free exposed hands from rock; seat and texture the gem. | Check transformed visible geometry and intended contacts, not pivots. Declare where embedding is intentional, such as a statue carved from rock. |
| Recess burial bays and fix shelf textures and oversized bodies. | A painted cavity needs real functional depth where visible. Check shelf UVs and body scale against the actual player. |
| Repair walkway joins, lips, exposed undersides and wall holes; block access behind turn wheels. | Inspect the assembled scene from both directions and from reachable hazard floors. Use a matching small landing lip where that is the intended edge, rather than a bulky stock railing. A clean centreline walk misses side traps and underside defects. |
| Place recovery stairs at the intended landings rather than beside the boss. | Derive stairs from the encounter's fall-and-recovery loop. Test where a knocked-back player must travel to rejoin the fight. |
| Make blood a coherent shallow surface; remove blood decals and dry-floor steam. | Specify pool surface, basin depth, hazard and recovery routes together. Use a continuous surface per connected pool where appropriate; confine complete particle envelopes to the liquid. |
| Match the mural/emblem to existing carving, palette and texel scale. | Measure runtime texture dimensions, UV coverage and transformed world size. Nearest filtering alone does not establish matching texel density. |
| Centre beams in real roof apertures and remove the unwanted floor sheen/decal. | Align a visible effect with its architectural source. Inspect the receiving material and leftover projectors as well as the beam. |
| Reduce model glow, enlarge weapon effects and balance global fill separately. | Review environment, characters, effect size and local spill as separate controls. A bright room can still contain unreadable actors; actor emission can make the player look self-lit. |

The blood-only undead, solo shield patrols and their knockback lanes were this
encounter's design. Preserve their reasoning: props must leave pulls, patrol
timing and recovery legible. Do not transplant those exact populations into an
unrelated dungeon. Verify actual movement, walk clips and separation in Play;
a patrol flag or spawn count does not prove a patrol.

## Catch the errors before asking the owner to find them

Use deterministic checks for measurable defects, then a visual self-review of
the actual shipped scene. Do not report an aesthetic judgment as mathematically
proved. The existing checks below cover parts of the problem; their command
contracts and limits remain in their owning documentation.

| Failure | Existing coverage to run | Additional review or missing automation |
|---|---|---|
| Excess props and blocked encounter space | Dressing plans/checks; real-body walk/fight and camera clearance. | **Missing shared check:** purposeful groups and reserved combat/recovery areas. Measure transformed solid footprints and obstruction; counts are diagnostics, not quality scores. Visual review decides which groups earn their space. |
| Floating props, undersized bases or inaccessible gaps | `float`, `fall-holes`, dressing support checks. | Probe full contact footprints, exposed hands/feet and pedestal bounds. Test capsule entry and escape around mechanisms and wall recesses; intentional embedding needs a declared contact. |
| Holes, bad reverse faces, disconnected edges and trim fighting | `see-through`, `backfaces`, `zfight`, stairs and fall-hole checks. Weeping Sun also has `authoring/mesh-gates.mjs edges`. | Include reverse views, lateral lanes and the basin floor. Water can conceal a missing vertical edge from ordinary hole/backface tests. The project edge check is not yet a general shared guarantee. |
| Orphan glows, offset candle light or VFX on dry ground | Recipe source-light checks catch some sourceless lights; Weeping Sun has fixture/steam/alignment audits. | **Missing shared check:** group ownership for prop + flame + light + steam, attachment checks at actual effect anchors, and effect-envelope exclusion from dry surfaces. Removal must remove dependants. |
| Pale/untextured rock, stretched shelves, shiny floor or mixed material response | Material manifest/audit, `atlas`, `matte`, texel/art review. | Inspect actual loaded materials/maps and UVs on the mesh, including skinned variants. Compare wall/roof junctions and wet/dry materials under the same light; inspect normals and color space before tinting around a defect. |
| Murals too sharp/coarse, rotated or unreadable | `flat-art`; measured texel workflows and Weeping Sun's embedded-texture checks. | **Missing shared check:** compare runtime texel density and filtering with declared local reference surfaces. Large murals need a readable approach shot and a close shot. No universal Weeping Sun resolution. |
| Dark actors, glowing actors, overlit pools or invisible ceiling | `readability`, `matte`, `culling`; actual character/light probes. | Freeze camera/exposure and vary one control at a time. Review player, both trash sexes, dark/light gear, undead and equipped bosses from front/back in dim and lit areas. Confirm runtime uniforms and active light-budget slots. No copying Weeping Sun's numeric settings as a universal preset. |
| Flames pop or freeze, actors stand still, weapons drift after scaling | Culling/walk/fight checks; Weeping Sun's runtime motion, equipped-envelope and cinematic-clock proofs. | Follow the actual particle pool and named item effect anchor, not just the static VFX system or hand origin. Measure live movement and posed equipped bounds; scale the owning hierarchy and inspect the resulting gear. Shared coverage is incomplete. |
| Arena gates close early, do not reopen, or clip the roof | Shared `boss-gate` behavior and its encounter tests. | Exercise non-aggro entry, actual aggro, each boss alternative, victory, evade/wipe and late join; inspect art/collider together at closed, moving and raised poses. |

Use a small stable capture set: room entrance, combat position, reverse view,
hero close-up and any side/hazard recovery route. Add an upward view where the
ceiling carries the design. Review the whole room first, then contacts and UVs.
If an independent agent is used, give it the brief, current source and captures;
ask it to find defects before showing the author's pass/fail verdict. One review
of a coherent draft is more useful than repeatedly reviewing every edit.

The review records entity/group IDs, a concrete observed problem, evidence and
the corrective action. Report checks as passed, failed or not run, with source
and dependency hashes. Missing or empty view selections are not a pass. After
fixing a defect, rerun the affected checks and inspect the changed view. Human
taste can still refine the result; ordinary fit, material, motion, clutter and
lighting faults should already have been challenged by the author/reviewer.

For a promotional render, check a short real equipped-boss/particle sequence
before a long capture and watch relevant source/asset changes early. Preserve
recorded footage when the user authorizes it; document segment differences
honestly instead of repeatedly restarting or claiming unchanged assets. This
is a capture concern, not a reason to add more scene dressing.

## Legacy quota conflict and the tool changes we should make

The current `tools/dungeon-pipeline/thresholds.json` still sets `recipe` minima
for room props/types and dungeon-wide prop types. `quality.mjs` enforces them.
Some older instructions also describe decal minima that no longer exist in the
code. **The newer owner direction is selective dressing, not filling quotas.**

Until the tool is revised, use the existing `authoring/quality-exceptions.json`
for a reasoned sparse-room miss, naming the actual reported check and room:
`props`, `propKinds`, or dungeon-wide `dungeonPropKinds`. Tie the reason to this
owner direction, room purpose, clear space and reviewed views. Do not suppress
the whole recipe gate or silently edit shared thresholds for one dungeon. A
justified sparse layout does not need another permission request. Contact,
traversal, lighting and other safety/quality failures remain real failures.

Recommended shared-tool changes, **not implemented by this notes update**:

1. Remove positive prop/type and built-piece count floors as release gates.
   Keep the metrics, useful excess/repetition warnings and genuine structural
   checks. A small palette and an intact large surface must not fail for having
   too few types or separately counted pieces. Decals remain optional.
2. Replace inventory scoring with declared room purpose, resolvable focal
   features, meaningful prop groups and reserved encounter/travel/recovery
   space. A unique crate or a nonexistent `setPieceObjects` name is not proof of
   a visible focal feature. Review bone-share fractions too: a percentage cap
   must not encourage adding unrelated props just to dilute a bone count.
3. Generalize the project's successful contact/edge/effect-owner, live entity
   lighting, movement and equipped-geometry checks into shared stages. Keep
   the visual review for theme, hierarchy and unnecessary repetition. Until
   those checks exist, report the gap and use the bounded project audit; do not
   describe this table as an installed automatic validator.

## Evidence to consult when refining these rules

All paths below are under `apps/playground/projects/weeping-sun-tombs/` and are
local content evidence, not a new portable engine dependency:

- `authoring/NOTES.md` and `reports/STATUS.md`: current state and qualified history.
- `reports/owner-polish-validation.json`, `reports/cleanup-finish.json`,
  `reports/crypt-flame-alignment.json`, `reports/steam-runtime.json`: dressing and effect repairs.
- `reports/presentation-scene.json`, `reports/boss-fit/proof.json`,
  `reports/promo/current-envelope-measurements.json`: assembled scene and equipped fit.
- `reports/lighting-balance/review.json`, `reports/promo/lighting-balance-proof.json`,
  `reports/promo/model-fill-proof.json`, `reports/promo/weapon-light-proof.json`:
  controlled comparisons versus actual recorded lighting/effects.
- `reports/encounter-hethre.json`, `reports/encounter-veyra.json`: real encounter branches.
- `reports/promo/picture-sheet.jpg`, `reports/promo/decoded-153_47.jpg`,
  `reports/promo/final-review.json`, `reports/promo/recording-continuation.json`:
  accepted visual reference, exact lineage and limits of the promotional evidence.

Use current playable captures for new judgments. A promo can hide targeting,
disable aggression or show only one boss alternative; it does not establish
ordinary party difficulty, every route or a complete playable review.
