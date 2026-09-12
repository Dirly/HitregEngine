# Longsword-atlas generation prompt

The weapon sheet. Same pipeline as the armor sheet (`prompt.md`), different key:
one modular sword ubermesh — four blades, four crossguards, three collars, three
pommels, a grip and two cut-out ornaments — that the game mixes and matches at
runtime. **Seventeen parts, seventeen separate regions.** Nothing on this sheet
is shared between two parts any more.

Regenerate the key and the mesh's UVs (needed whenever the model changes):

    pnpm -F playground unwrap-weapon --recipe longsword

Paste the block below into the image generator together with
**`tools/atlas/key-longsword.png`**. Swap only the **SUBJECT** block to make a
new set. Then register the result and bake it into the mesh:

    node tools/atlas/import-atlas.mjs \
      --key tools/atlas/key-longsword.png --art <art.png> \
      --manifest tools/atlas/manifest-longsword.json \
      --out tools/atlas/out-<name> --slices

    pnpm -F playground unwrap-weapon --recipe longsword \
      --atlas tools/atlas/out-<name>/atlas.png

The second run writes `LongSword-unwrapped.glb` with the atlas inside it and the
ornaments already on a double-sided cut-out material. Look at
`key-longsword-check.png` afterwards — that is the finished sword, rendered.

**Cut with WHITE, not cyan.** Measured across whole generated sheets: zero cyan
pixels out of 1.57M, at any threshold. Generators do not produce it. They leave
white readily, and the importer treats border-connected white on a cut island
exactly like cyan.

**Only the TWO ORNAMENTS cut.** A sword is solid. Every other region is filled
edge to edge, and white left inside one of them is filled in from the paint
beside it, not cut.

**Nothing painted may be white, and on a weapon sheet that is a real trap.** The
importer finds the ground by flooding in from the edge of the sheet through
everything brighter than a light grey, and a blade painted with a white-hot
cutting edge loses the edge — measured: a 209-luminance edge band was eaten as
background and the blade was then stretched a third wider to cover its island.
This key's manifest raises the bar as far as it safely goes (`bgLum` 228), so
keep the brightest steel a LIGHT GREY, never white, and give it a slight colour
cast. Pure white belongs to the ground and to the ornaments' cutwork, nowhere
else.

**Draw each piece to FILL its block.** Measured on the first real sheet, pieces
came back between 0.46x and 1.9x the size of the region they belonged to, and
shifted by up to 150 pixels — two of the crossguards ended up more than half
unpainted. The importer rescales what it finds, but it can only rescue artwork
that is recognisably in the right place.

**The four blades are alternatives, not a set of four swords.** So are the four
guards, the three collars and the three pommels. The game builds a weapon by
picking one of each, so anything that does not share a palette with everything
else on the sheet will end up bolted to it.

---

A flat 2D hand-painted texture atlas for a very low-poly PS1-era sword,
1254x1254, painted directly over the supplied UV colour-key layout. This is a UV
sheet, NOT a 3D render, NOT a weapon illustration, NOT a poster. No perspective,
no drop shadow, no background scene, no metal plate behind the pieces, and NO
border, frame, banner, label or divider anywhere on the sheet.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT — THE MOST BROKEN RULE ON THIS
SHEET. Every solid colour block in the reference is a REGION ID marking which
piece of the sword goes where. NOT ONE of them is a colour this weapon is made
of. A blade marked blue does not make a blue blade. A guard marked red does not
make a red guard. A grip marked brown does not have to be brown.

Decide the palette from the SUBJECT block ALONE, before you paint: pick four or
five tones and paint the ENTIRE sheet using only those. Then check every region
against the block it replaced — if they resemble each other, that region is
wrong and must be repainted.

HOW EVERY SOLID PIECE IS LAID OUT — read this once and it explains the whole
sheet. Each piece is drawn FLAT-ON, as its own silhouette, and most of them have
a NARROW BAR attached directly underneath. The silhouette is the piece as you
see it looking at the flat of the blade. The bar is that same piece's EDGE — the
thickness you see when the sword turns side-on. Paint the silhouette as the
part; paint the bar as plain metal, a touch darker, no pattern, nothing that has
to line up. Both halves are one piece and must be the same material.

Every piece is painted ONCE and appears on BOTH sides of the sword, mirrored.
There is no separate back to paint.

REGION KEY (by position — ignore what colour each block is):

- FOUR TALL POINTED STRIPS filling the LEFT HALF, tips at the TOP .. the four
  BLADES (see BLADES). Left to right: a wide blade; two narrow blades; a wide
  leaf blade. These four have no bar: a blade is all flat.
- FOUR WIDE BANDS STACKED DOWN THE MIDDLE COLUMN ... the four CROSSGUARDS (see
                                                     CROSSGUARDS). These four
                                                     have no bar under them —
                                                     the band already is the
                                                     whole surface.
- THREE SMALL SHAPES DOWN THE RIGHT COLUMN, each with its own bar: a HEXAGON, a
  CHEVRON, a DIAMOND ................................. the three COLLARS, the
  chunky fitting that sits where the guard meets the blade.
- Tall plain RECTANGLE, right column, below the diamond .. the GRIP (see GRIP)
- THREE SMALL SHAPES IN A ROW, middle column, below the guards: a narrow
  UPRIGHT, a small SQUARE, a HEXAGON with a bar .. the three POMMELS, the
  counterweight at the butt of the sword, seen from the side. The small square
  one is seen from ABOVE instead — a four-sided knob, its point in the middle of
  the square and its facets running out to the corners.
- LARGE SQUARE, BOTTOM LEFT ........................ the UPPER ORNAMENT (see
                                                     ORNAMENTS)
- SMALLER SQUARE beside it ......................... the LOWER ORNAMENT

THE BLADES — the four tall strips down the left:
Each strip IS the blade's own outline: point at the top, tang at the bottom.
Paint the blade INSIDE it, edge to edge, leaving no white anywhere in the strip.

- The LEFT and RIGHT edges of each strip are the two CUTTING EDGES. Run a
  brighter, cleaner band of metal down both, the same width on each side.
- The MIDDLE of each strip is the flat of the blade: this is where a fuller
  (the groove down a blade), a ridge line, an etched line or a maker's mark
  goes. Keep it running LENGTHWISE — a band across the blade reads as a crack.
- Shade ALONG the length, not across it: a little darker toward the tang, a
  little brighter toward the point.
- Paint each strip SYMMETRICALLY about its own vertical centre line.
- All four are the SAME steel, the same finish, the same palette. They differ in
  shape, not in material. Vary only what suits each silhouette — a fuller on the
  wide ones, a plain diamond section on the narrow ones.
- The bottom few percent of each strip is the tang, hidden inside the guard. Do
  not decorate it; let the blade colour run off the bottom edge.

THE CROSSGUARDS — the four wide bands down the middle:
Each is a whole crossguard PEELED OPEN around its own length and laid flat, so
one band is the entire surface of the bar. Read it:

    LEFT and RIGHT ends of the band .. the two TIPS of the guard
    the TOP edge ..................... the TOP of the bar, where the blade
                                       leaves it
    the BOTTOM edge ................. the UNDERSIDE, where the hand is

So going down the band you are travelling over the guard from its top face,
across its side, to its underside — and the far side of the guard is ALREADY
this same paint mirrored onto it. Both faces match by construction; you never
paint a back.

Fill the band edge to edge. Light it top-down — brightest along the top edge,
darkest along the bottom — which is exactly how the guard is lit in the world.
A lengthwise band of a second material, a row of rivets, a chamfer running the
length of the bar, wear on the tips: all good. Anything that must line up with a
shape is not, because this is a curved surface flattened out.

THE COLLARS AND POMMELS — silhouette plus bar:
Fill the silhouette edge to edge with metal. This is where a boss, a rivet, a
band, an engraved rune, an inlaid stone or a worn chamfer belongs. Keep every
one of them MIRROR-SYMMETRIC left to right, because the parts are.
Then paint the bar below it as the same metal seen edge-on: flat, slightly
darker than the face, with at most a soft highlight along its middle. The bar is
narrow and wraps a curved edge — anything detailed painted there will smear.

THE GRIP — the tall plain rectangle on the right:
The handle unrolled the WHOLE way around, seam at the back. Top of the rectangle
is the end that meets the guard; bottom is the end that meets the pommel.
Its LEFT and RIGHT edges are the same seam, so they must match in value and
colour, or a stripe appears down the back of the grip.
Leather wrap, cord binding, ray skin, wire — bands or a weave running ACROSS the
rectangle (around the grip) all work. A diagonal spiral does NOT: it will not
meet itself at the seam.

THE TWO ORNAMENTS — THE ONLY REGIONS YOU MUST *NOT* FILL:
These are the exception to the coverage rule, and filling them is the single
most-repeated failure on this kind of sheet — the region comes back as a solid
plaque, a banner or a tile with an emblem on it, every time.

Each square is a BLANK SHEET OF PAPER on which you draw ONE thin openwork
ornament, with EMPTY WHITE ALL AROUND AND THROUGH IT.

- Leave the square WHITE #FFFFFF and draw the ornament onto that white.
- HALF OR MORE of each square must still be white when you are done. It must
  never read as solid: daylight goes through it everywhere.
- MATERIAL: wrought iron wire, feathers, thorns and briars, glass or crystal
  shards, icicles, bone, antler, chain, filigree. HARD, THIN, OPEN things.
- NOT CLOTH. No banner, no pennant, no flag, no tassel, no torn fabric, no
  leather. A hanging cloth on a sword's guard reads wrong at every angle and is
  the one material to avoid outright.
- Every gap must have a clear path out to the white margin. Nothing enclosed. If
  a closed ring is unavoidable, its inner hole must be solid cyan #00FFFF.
- NO background behind the ornament. No plate, no backing, no stone, no border,
  no frame, no vignette, no drop shadow. White only.

WHERE THE TWO ORNAMENTS ACTUALLY SIT, which decides how to compose each one.
Both are flat plates standing in the plane of the blade, seen from both sides,
and each is FIXED TO THE SWORD ALONG ONE EDGE ONLY:

- The LARGE square is the UPPER ornament. It stands just above the crossguard
  with the blade running up through it. It is joined to the sword at the
  BOTTOM-CENTRE of the square, and everything you draw must GROW UPWARD AND
  OUTWARD from that point — like a plant out of a pot, or flames off a coal.
  Nothing may float free of it.
- The SMALLER square is the LOWER ornament. It hangs below the pommel at the
  butt of the sword. It is joined at the TOP-CENTRE, and everything hangs DOWN
  and outward from there.
- In BOTH, the blade or the grip hides a narrow strip up the MIDDLE of the
  square, so the design must live in the LEFT and RIGHT thirds and be
  MIRROR-SYMMETRIC left to right. Think two matching wings, sprays, fans or
  clusters either side.
- The far edge — the top of the upper one, the bottom of the lower one — is open
  air. Whatever reaches it is cut off flat, so keep the design clear of it.

SHADING, because this is a PS1-era game texture:
Paint the light INTO the texture — a lit edge, a darker recess, a worn corner.
Keep it broad and flat: no photographic gloss, no chrome reflections, no
gradients so smooth they band at 256 pixels. Read the whole sheet at a quarter
size and every part should still be legible as metal, leather or wood.

SUBJECT:
A plain, serviceable knight's arming sword. Cold grey steel blades with a soft
blue cast and brighter cutting edges. Guards, collars, pommels and their edge
bars in dark blackened iron with worn steel highlights on the raised edges. A
deep oxblood leather grip with a tight cord binding and one iron band. The
ornaments: thin iron briars and thorns, curling up either side of the blade and
trailing down under the pommel, with plenty of daylight between them.
