# Greatsword-atlas generation prompt

The greatsword sheet. Same pipeline as the longsword (`sets/longsword/prompt.md`):
one modular two-handed sword ubermesh that the game mixes and matches at
runtime — four blades, four crossguards, two collars, three pommels, a grip and
two cut-out ornaments. **Sixteen parts, sixteen separate regions.**

Regenerate the key and the mesh's UVs (needed whenever the model changes):

    pnpm -F playground unwrap-weapon --recipe greatsword

The source file names two guards `CrossGuard4`; the recipe's `repeats` names the
first (the short bar across the blade's flat) CrossGuard2, and the unwrapped OBJ
carries that name back.

Paste the block below into the image generator together with
**`tools/atlas/sets/greatsword/key-labelled.png`**. Swap only the **SUBJECT**
block to make a new set. Save the result as `tools/atlas/art/greatsword/<theme>.png`,
then register it:

    node tools/atlas/import-atlas.mjs --set greatsword --theme <theme> --slices

and put it on the held-weapon page (every theme at once):

    pnpm -F playground weapon-page --recipe greatsword --project voxel-demo --themes <a>,<b>,…

**Only the TWO ORNAMENTS cut.** Every other region is filled edge to edge.

**Nothing painted may be white.** `bgLum` is 228: a bright steel cutting edge
painted near-white is eaten as ground and the blade stretched to cover it. Keep
the brightest steel a light grey with a colour cast.

**The blades are alternatives, not a set.** So are the guards, collars and
pommels. Anything off the sheet's palette ends up bolted to the rest.

---

NO TEXT. NO LETTERS. NO GUIDE MARKS. The reference carries a word on every
region; those words are labels for you and must NOT appear anywhere on the
finished sheet.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era two-handed
greatsword, 1254x1254, painted directly over the supplied UV colour-key layout.
This is a UV sheet, NOT a 3D render, NOT a weapon illustration, NOT a poster. No
perspective, no drop shadow, no background scene, and NO border, frame, banner,
label or divider anywhere on the sheet. The ground around the regions stays
pure white.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
REGION ID marking which piece goes where. NOT ONE of them is a colour this sword
is made of. Decide the palette from the SUBJECT block ALONE — four or five tones
for the whole sheet — then check every region against the block it replaced: if
they resemble each other, repaint it.

Draw each piece to FILL its block, edge to edge, following the block's outline
exactly. Leave no white inside a block (except the two ornaments). The top of
the sheet is the top of the sword everywhere.

Every solid piece is painted ONCE and appears on BOTH faces of the sword,
mirrored. There is no separate back to paint.

REGION KEY (by position — ignore what colour each block is):

- FOUR VERY TALL POINTED STRIPS filling the LEFT HALF, tips at the TOP .. the
  four BLADES (see BLADES). Left to right: a broad straight blade; a narrow
  blade; a blade with two short pointed LUGS sticking out near its base; a broad
  LEAF blade, widest in its upper third.
- TOP RIGHT, a large tall RECTANGLE .. the UPPER ORNAMENT (see ORNAMENTS)
- TOP RIGHT, three wide swept BANDS stacked beside it .. three CROSSGUARDS,
  each peeled open around its length (see CROSSGUARDS)
- MIDDLE RIGHT, a SMALL SQUARE .. the LOWER ORNAMENT
- MIDDLE RIGHT, a notched upright shape .. the fourth CROSSGUARD: a short
  square bar that runs THROUGH the blade, its two ends sticking out of the flat
  faces. Also peeled open around its length: fill it as plain forged metal.
- MIDDLE RIGHT, a HEXAGON with a narrow bar under it .. the small COLLAR, the
  chunky fitting where guard meets blade; the bar is its edge
- LOWER RIGHT, a wide shape rising into FOUR TALL POINTS .. the TALL COLLAR,
  a metal sleeve running up the base of the blade, peeled open all the way
  round; the four points are its four pointed tips reaching up the blade
- LOWER RIGHT, a tall plain RECTANGLE .. the GRIP (see GRIP)
- BOTTOM RIGHT, three tiny shapes in a row .. the three POMMELS: a narrow
  upright block; a small square that is a four-sided knob seen from ABOVE (its
  point in the middle, facets running to the corners); a hexagon with a bar
  under it (the bar is its edge)

THE BLADES — the four tall strips down the left:
Each strip IS the blade's own outline: point at the top, tang at the bottom.
Paint the blade INSIDE it, edge to edge.
- The LEFT and RIGHT edges of each strip are the two CUTTING EDGES. Run a
  brighter band of honed metal down both, the same width on each side.
- The MIDDLE is the flat of the blade: a long fuller (a groove down the blade),
  a ridge line, or an etched line, running LENGTHWISE. A band across the blade
  reads as a crack.
- Paint each strip SYMMETRICALLY about its own vertical centre line.
- All four are the SAME steel and finish; they differ in shape, not material.
- The bottom few percent is the tang, hidden in the guard: let the blade colour
  run off the bottom edge.

THE CROSSGUARDS AND THE TALL COLLAR — peeled pieces:
Each is a bar or sleeve peeled open and laid flat, so one shape is its whole
surface. Fill it edge to edge and light it from above — brightest along the top
edge, darkest along the bottom. A lengthwise band, a row of rivets, a chamfer,
worn tips: all good. Nothing that must line up with a shape.

THE SMALL COLLAR AND POMMELS — silhouette plus bar:
Fill the silhouette with metal (a boss, a rivet, a band, a worn chamfer), kept
MIRROR-SYMMETRIC left to right. Paint its bar as the same metal seen edge-on:
flat, slightly darker, no detail.

THE GRIP — the tall plain rectangle:
The long two-handed handle unrolled the whole way round. Top meets the guard,
bottom meets the pommel. Its LEFT and RIGHT edges are the same seam, so they
must match. Leather wrap or cord binding in bands ACROSS the rectangle; no
diagonal spiral.

THE TWO ORNAMENTS — THE ONLY REGIONS YOU MUST *NOT* FILL:
Each square is a BLANK SHEET OF PAPER on which you draw ONE thin openwork
ornament, with EMPTY WHITE ALL AROUND AND THROUGH IT.
- Leave the square WHITE #FFFFFF and draw the ornament onto that white.
- HALF OR MORE of each square must still be white when you are done.
- MATERIAL: wrought iron wire, feathers, thorns and briars, glass or crystal
  shards, icicles, bone, antler, chain, filigree. HARD, THIN, OPEN things.
- NOT CLOTH. No banner, no pennant, no tassel, no fabric, no leather.
- Every gap must have a clear path out to the white margin. Nothing enclosed.
- NO background behind the ornament. No plate, no backing, no border, no frame.

WHERE THEY SIT: flat plates in the plane of the blade, seen from both sides,
FIXED ALONG ONE EDGE ONLY, with the blade or the grip hiding a strip up the
MIDDLE, so the design lives in the LEFT and RIGHT thirds and is
MIRROR-SYMMETRIC:
- UPPER ORNAMENT (the tall rectangle): stands just above the crossguard, the
  blade running up through it. Joined at the BOTTOM-CENTRE; everything GROWS
  UPWARD AND OUTWARD from there along both sides of the blade.
- LOWER ORNAMENT (the small square): hangs below the pommel. Joined at the
  TOP-CENTRE; everything hangs DOWN and outward.
- The far edge of each is open air: keep the design clear of it.

SHADING, because this is a PS1-era game texture:
Paint the light INTO the texture: a lit edge, a darker recess, a worn corner.
Keep it broad and flat: no photographic gloss, no chrome reflections, no smooth
gradients that band at 256 pixels. Read the whole sheet at a quarter size and
every part should still be legible as metal, leather or wood.

SUBJECT:
A plain, serviceable soldier's greatsword. Grey forged iron blades with a long
darker fuller and brighter honed edges (brightest a light grey, never white).
Guards, collars and pommels in dark blackened iron with worn highlights on the
raised edges and rivet heads. A brown leather grip wrapped in bands. The
ornaments: thin iron briars and thorns, with plenty of daylight between them.
Palette: iron grey, blackened iron, brown leather — nothing else. Detail level:
a richly hand-painted PS1 game texture, NOT a flat vector graphic.

FINAL CHECK: no text, no letters, no label words, no guide marks anywhere on the
sheet; no white inside any region except the two ornaments; no region painted
in its key colour.
