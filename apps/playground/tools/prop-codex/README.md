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

Big pieces fit one page by reusing pixels, never by shrinking them:

```python
# One painted face; the back reads the same pixels at the same world point.
paint(m, 'pier-front', part='pier', projection='front', mirror=('x', 0), detail='...')
paint(m, 'pier-rear', part='pier', projection='back', share='pier-front', mirror=('x', 0), flip=True)
# A plain face of any projection that fits inside the region reuses it.
paint(m, 'pier-side', part='pier sides', projection='left', share='pier-front')
```

`share='<surface>'` maps the faces into that surface's region at the same metres
per texel, anchored at its lower-left corner. A sharer bigger than its target
fails the build; it adds no region and no brief line of its own, and the
target's brief line names it. `flip` (True/'u', 'v', 'uv') mirrors the sharer
inside the region: `True` for a back face (same world point as the front), 'uv'
for a copy turned 180 degrees. `mirror=(axis, at)` folds the UVs about a plane
in the projection (the + side onto the - side; '-x' folds the other way), so the
region holds one side. Faces that cross the plane are split along it. A mirrored
back face needs `flip=True` to land on the same half as its front. `paint plan`
reports the page `fill` and the shared surfaces.

`glow=<0..1>` on an original surface makes it self-lit by its own painted pixels
(amber-cored eggs, embers): the faces take a second material on the same page
whose emissive texture is the artwork and whose emissive factor is the glow. The
packer keeps that emissive texture on the atlas page. No light is added. Paint the
glow into the art: dark pixels stay dark. Sharers inherit the glow. `paint gen --previous <png>`
sends a copy of the old artwork as the last reference when a prop is re-planned.

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

A design name may also be a path to a held `.py` outside `designs/`: plan, paint and import it there, and move it into
`designs/` only once `paint status` is ready. An unpainted design in `designs/` blocks every `codex install`.

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

Texel density is not only the UV scale: smooth, airbrushed art at 40 texels/m still
reads FINER than the rock and ashlar beside it. `paint status`
report a surface whose mean run of identical texels (5 bits/channel) is over 1.3 as
SMOOTH (`paintGrain`, a finding, not a gate). Re-paint it with per-texel stone grain
and a 5-bit posterize before import (the Weeping Sun face went 1.39 -> 1.19).

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
