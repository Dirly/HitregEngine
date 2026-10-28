# Texture-led PSX art direction

Derek's default for all game content going forward: low-poly forms with rich
painted textures. This applies to whole layouts, towns, buildings, dungeons,
landmarks, props, statues, characters, gear and Blender-only experiments. Read
this before choosing how a visual feature will be built. A particular model or
one tool's implementation does not limit this direction to that model or tool.
An explicit art direction in the user's brief takes precedence.

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
