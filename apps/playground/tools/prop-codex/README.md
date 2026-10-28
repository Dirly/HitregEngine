# Texture-first props

Use geometry for the outline, openings, walkable surfaces, collision and useful
depth. Use painted artwork for identity: the beetle on a door, the circular seal,
shell divisions on a statue, carved trim, wear and small bevel shading. A plain
clay render can be simple while the unlit texture render carries the character.
Do not add geometry merely to satisfy a part-count check; named painted surfaces
allow a single structural part.

The existing Mesh design helper now accepts named paint regions before `emit`:

```python
# Existing modeled parts: door-body and seal. No new geometry from paint().
paint(m, 'beetle-front', part='door-body', projection='front',
      detail='A broad carved beetle, ochre shell panels, deep painted grooves '
             'and worn bronze edging. Strong readable shapes at PSX resolution.')
paint(m, 'round-seal', part='seal', projection='front',
      detail='A circular sun and insect emblem, aged turquoise and bronze, '
             'with painted relief and chipped edges.')
emit(m, 'Painted insect gate', category='decor', cultures=['civic'])
```

The part names must match the modeled part names. Projections select outward
faces; a circular face retains its circular footprint. Front is Blender -Y,
back +Y, right +X, left -X, top +Z and bottom -Z. Opposite views have matching
readable orientation. `cylinder` wraps vertical side faces around Z, with a seam
at +X. Use separate parts for surfaces that overlap in a projection; this is an
explicit projection workflow, not an automatic arbitrary-mesh unwrap. Faces
cannot belong to two named paint regions. Unselected faces keep shared town
material roles.

## Authoring loop

Run `props reuse --project world-kit` before requesting geometry. Protected
existing parts are checked at job intake, the Blender geometry gate and install
preflight, including named components inside a larger prop. Build a new host
only where needed, then compose existing books, candles and Derek's skulls.
Retexture suitable existing models instead of generating another mesh. The
policy schema is available through `props reuse schema`; unchanged legacy
rebuilds do not certify the old asset's artistic quality.

Run from `apps/playground`, with designs in the shared `world-kit` project's
`authoring/codex-craft/designs/`. Search and intake still follow
[prop cataloging](../../../../docs/prop-cataloging.md).

```powershell
# Measure the actual mesh and write its labeled UV guide. No runtime export.
node --import tsx tools/props.mts paint plan insect-gate --project world-kit

# Generate artwork against that guide through the established image queue,
# then register it with the existing Atlas importer.
node --import tsx tools/props.mts paint gen insect-gate --project world-kit

# Or register supplied artwork with exactly the guide's dimensions.
node --import tsx tools/props.mts paint import insect-gate --art C:/Art/gate.png --project world-kit

node --import tsx tools/props.mts paint status insect-gate --project world-kit

# Normal collection install: rebuild, pack, catalog and render selected reviews.
node --import tsx tools/props.mts codex install --cards insect-gate --project world-kit
```

`paint gen --force` requests new artwork through the same queue. Image generation
requirements and diagnostics remain in [image generation](../../../../docs/image-generation.md).
Generated design jobs can declare `paint(...)`; they pass the geometry design
gate first. Installation then stops until their artwork is ready. The design job
does not silently spend an image-generation request.

Each design's stable authoring directory is `authoring/codex-craft/paint/<name>/`:
the measured layout, colored guide, Atlas manifest, artwork, registered source
page and hash receipt live together. `props paint schema` emits the validating
schemas. The registered **Armor / Weapon / Prop Atlas** tool also accepts the
guide, artwork and generated manifest for inspection in the editor; use
`props paint import` to finish the prop receipt and combine untouched town tiles.

## Resolution, packing and review

The guide measures surfaces at the town's 40 texels/metre, with a 32–48 acceptance
band after export. Artwork pages are square and nearest-filtered. The packer
selects a source page that fits without reducing resolution; oversized assets
fail with an actionable error. Split a large structure into reusable pieces
instead of shrinking its emblem or stretching a small texture over it.

Generic props keep the shared town atlas. Painted props use a separate budgeted
collection atlas while retaining one material and one opaque image per source
prop. Atlas limits are enforced before packing and never trigger automatic
downsampling. Existing town consumers must remain byte-identical.

Changing geometry, UV declarations, the UV helper, artwork or the town role sheet
invalidates the receipt. Missing, transparent or unchanged guide artwork cannot
be installed as a finished prop. Current paint regions are opaque; cutout cards
and arbitrary external UV layouts use their existing workflows.

For every selected painted review card, the installer renders `clay-<name>.png`,
`unlit-<name>.png` and the usual lit `prop-<name>.png` from the exported model.
Inspect all three: silhouette and construction in clay; motif placement, seams
and readable pixels unlit; materials and lighting in the lit view. A successful
registration or export is not an artistic approval. Catalog records retain
artwork provenance, hashes and measured surface density for that review.
