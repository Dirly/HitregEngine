# Texture-led PSX art direction

Derek's default for all game content going forward: low-poly forms with rich
painted textures. This applies to whole layouts, towns, buildings, dungeons,
landmarks, props, statues, characters, gear and Blender-only experiments. Read
this before choosing how a visual feature will be built. A particular model or
one tool's implementation does not limit this direction to that model or tool.
An explicit art direction in the user's brief takes precedence.

Audio follows [the game's audio direction](audio.md): polished orchestral
fantasy music and organic sound effects with darker atmosphere where fitting.
The PSX visual treatment is not a direction to reduce audio fidelity or use
retro console/chiptune sounds.

## Ant and wasp nests

Ants and wasps are non-sapient swarm animals in this game (owner direction,
2026-10-28). Author nest matter and traces of instinctive animal behavior:
excavated soil, irregular burrows, chewed paper envelopes and combs, brood,
pupal skins, loose food deposits and refuse. Natural hexagonal cells and
species-appropriate fungal substrate are valid. Furniture, craft stations,
vessels, racks, lamps, ceremonial forms, glyphs and deliberately framed gates
are not. An insect silhouette or organic material does not make a human-made
object appropriate. Keep existing creature models and useful natural materials;
do not invent an insect civilization to supply a town-style prop list.

## Redstrand Crockin

Redstrand ecology direction (2026-11-06): use occupied habitat pockets with many
independently wandering creatures, not only isolated singles across empty land.
Reuse existing rats and pigs as nonhostile farm crop pests. Beetles, including
their rare, defend themselves alone (Neutral). Ant workers are peaceful until
provoked and nearby foragers help (Protective). Soldiers use the existing larger
mandibles and attack on sight (Aggressive); mound and hive guards are Aggressive
regardless of caste. A soldier's unprovoked attack must not recruit peaceful
workers. Keep the foragers' assist faction separate from hostile nest guards.

Owner direction (2026-11-06): Redstrand Crockin use a practical freshwater and
wetland appearance. Keep natural scales, worn cloth, leather, reeds and scavenged
metal readable in the regional palette. The owner rejects an Egyptian look:
avoid pharaonic headdresses, striped nemes cloth, broad ceremonial collars,
hieroglyphs, ankhs and royal gilt. Review the silhouette and worn equipment as
well as the painted skin; repainting does not remove an unsuitable shape.

## Trees

Owner direction (2026-10-29): match the existing trees' measured triangle counts
and construction. Keep shaped, bent, tapered trunks with a handful of irregular
structural boughs, and reuse the large curved foliage-panel approach. Avoid dense branch scaffolds,
regular radial fans and visible spiral layouts. Leaf artwork and a few shaped
panels supply the crown's richness. Omit modeled roots that would be underground.
Preserve the painted leaves' proportions when changing a crown: reposition and
uniformly scale foliage panels, or correct their UV mapping. Inspect the texture-only
view for stretched leaves, as well as the silhouette and the crown from above.

Owner direction (2026-11-06): match site trees to the surrounding forest in measured
world-space height, crown width and trunk diameter, retaining its species mix and
native size cohorts. Reusing the same model does not establish matching scale.
Do not shrink supporting trees to bring their branches down to webs or cocoons;
fit the attachments to the established forest. Check the entire transformed basal
rim against the final rendered ground, with matching collider transforms.

## Spider habitats

Owner direction (2026-11-06): a spider area should feel thoroughly infested, with
silk spreading across the woodland floor, climbing trunks and linking real
supports through layered webs and hanging cocoons. Blend a painted ground-silk
surface into the local forest litter and connect it visually to supported web
geometry. A few isolated sheets and egg props do not establish the habitat.
Keep routes and camera space usable. Egg bedding should closely support the
clutch's actual footprint, with an irregular webbed edge rather than an oversized
pale mound. Check every solid prop and tree across its full ground-contact area;
visible hovering is a failure even when its pivot or a traversal check passes.

Owner refinement (2026-11-06): suspended silk should drape under gravity, sit
higher between its real supports and remain translucent, with muted grey/olive
threads rather than brilliant white walls. Fade the whole sheet's outer edges
independently of its repeating artwork; internal mesh subdivisions must not
produce visible seams. Keep a few believable load strands connecting the wispy
sheet to bark or rock. Continue the liked conforming trunk silk onto selected
rocks. Break ground coverage into noisy, irregular deposits with exposed litter,
and remove artificial painted paths from the infestation. Extend the woodland
behind the nesting pockets so the habitat occupies a deeper forest space.

Owner refinement (2026-11-06, close review): translucency must leave the webbing
clearly visible. Keep floor, bark, rock and suspended silk in one pale neutral
material family; balance brighter ground silk with translucent surface silk.
Avoid opaque horizontal trunk wraps or repeating cloth bands. Use irregular
coverage that climbs and spreads from varied real contacts: low trunks, ground,
rocks and structural boughs at different heights. Close views must show continuous
silk across mesh joins, without atlas borders, separate face offsets or obvious
triangle lighting seams. Judge infestation density and consistency in the assembled
player view, not from sheet counts or a silhouette against the sky alone.

Placement workflow, reusable sources and future indoor adaptations:
[spider-habitats.md](spider-habitats.md). Read it for spider dressing in woods,
abandoned buildings, caves and dungeons.

## Divide the work before modeling

Start new prop designs with generated or supplied concept art (owner direction,
2026-10-28). Keep the chosen reference with the owning collection and compare
the textured model against it before installation. Concept art guides silhouette,
palette and painted surfaces; it does not justify rebuilding existing books,
candles, skulls or other suitable library assets. Reuse those parts and preserve
their materials and behavior. Routine repairs can use the existing asset as their
reference rather than generating a new design.

Use the concept to model structural depth as well as silhouette. Texture-led
does not mean stacked plain boxes: where the reference has proud columns around
an inset panel, give those supports and reveals real depth, then align the
painted artwork to them. Keep engraving and small wear painted. Review the clay
view for those deliberate structural forms before accepting the textured result.

Geometry establishes silhouette, volume, meaningful depth, openings, supports,
moving parts and playable space. Textures establish surface identity and most
visual richness: masonry joints, timber grain, carved patterns, shell divisions,
faces on reliefs, symbols, bevel shading, patina, seams, stains and wear. A large
ornament can still be painted. Its size alone does not justify modeling it.

For each important feature, decide which outline or interaction requires real
geometry and which marks the player will read from artwork. Describe the intended
artwork while planning the feature. Do not finish an elaborate untextured mesh
and leave texture work as an optional cleanup pass.

Examples:

- A decorated gate needs real doors, jambs, passage clearance and useful thickness;
  its beetle, engraved borders and inscriptions can occupy painted door panels.
- An emblem usually needs a shallow disc or panel with a painted face. Add raised
  geometry only where the depth or outline matters at the intended view.
- A statue needs shaped masses and a convincing pose; painted shell plates,
  eyes, ornament and wear supply the finer read.
- A building needs a complete shell, roof, usable doors and stairs. Repeating
  wall art and trim supply brick courses, roof shingles and small carved detail.
  A decorative sealed window can be painted or shallowly recessed; a window the
  player sees through needs a real opening and finished reveals.

Real routes and structure remain real. Paint cannot make a stair reach a landing,
clear a doorway, close a missing wall or supply the depth of a playable entrance.

## Plan the whole layout around its finished read

Choose focal masses, approaches, usable space and visual hierarchy first. Plan
the palette and the distribution of painted detail across the composition:
strong focal artwork, quieter surrounding surfaces and deliberate repetition.
Do not fill a town or room with small meshes to manufacture surface richness.
Do not replace spatial layout, terrain or required gameplay with a painted view.

Before repeating a building style or major asset group, finish a representative
sample with its actual textures and inspect it at player height and the intended
approach distance. A greybox proves space and scale; the textured sample proves
the proposed finish. Carry its material/texture choices into the reused kit.

## Choose the appropriate texture route

Use shared tiling materials for broad repeated surfaces, trim strips for repeated
borders and edges, unique mapped regions for focal artwork, and supported decals
or cutout cards where a surface overlay or effect needs them. Preserve the owning
project's measured texel standard, palette and nearest sampling. A universal
image size or a bigger image is not a substitute for correct UV scale. Paint
readable value shapes and local form shading; keep scene lighting separate.

- Named artwork on generated props: `apps/playground/tools/prop-codex/README.md`.
- Images and provenance: `docs/image-generation.md`.
- Modular architecture and runtime packing: `docs/wfc-kit-authoring.md` and
  `docs/town-baking.md`.
- Dungeon structure: `docs/blender-dc-authoring.md` and
  `docs/dungeon-materials.md`. DC conversion discards source UVs, so unique mapped
  artwork belongs on separate supported display/prop meshes or decals; repeated
  structural surfaces use the palette. Do not promise UV artwork survives DC.
- Characters and equipment keep their established unwrap/atlas workflows from
  `docs/workflows.md`, under this same visual direction.

The named prop painting command is one implementation of this direction. It is
not a universal unwrap/importer for buildings, DC structures or characters.
Use each subsystem's supported material path and report a missing capability
instead of replacing intended artwork with ornamental geometry.

## Review the finished result

Review simple form and functional depth in clay, painted identity and seams
without scene lighting, and the integrated result under normal lighting. Existing
renderers may supply these views manually; automatic clay/unlit cards currently
exist on the named prop path. Judge the assembled layout at its intended scale,
alongside the project's visual references, before its existing final review.

A simple mesh completed by convincing artwork is valid. An unfinished primitive
substitute, missing motif, broken UVs or excessive ornamental geometry is a fault.
Do not reject a completed textured asset merely because its clay view is simple,
or approve a detailed clay model whose intended artwork is absent. These are
visual review judgments; geometry and atlas checks do not certify artistic quality.
