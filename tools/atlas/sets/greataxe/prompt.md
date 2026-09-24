# Greataxe-atlas generation prompt

The greataxe sheet. Same pipeline as the longsword (`sets/longsword/prompt.md`):
one modular two-handed axe ubermesh that the game mixes and matches at runtime —
three heads, a haft and a grip every axe wears, three collars where grip meets
haft, two pommels, two sleeves (the langets running up the haft through the
head) with a finial capping each, and three cut-out ornaments. **Seventeen
parts, seventeen separate regions.**

Regenerate the key and the mesh's UVs (needed whenever the model changes):

    pnpm -F playground unwrap-weapon --recipe greataxe

The source file names all three heads `AxeHead`; the recipe's `repeats` names
them AxeHead1..3 in file order, and the unwrapped OBJ carries those names back.

Paste the block below into the image generator together with
**`tools/atlas/sets/greataxe/key-labelled.png`**. Swap only the **SUBJECT**
block to make a new set. Save the result as `tools/atlas/art/greataxe/<theme>.png`,
then register it and bake it into the mesh:

    node tools/atlas/import-atlas.mjs --set greataxe --theme <theme> --slices

    pnpm -F playground weapon-page --recipe greataxe --project voxel-demo --themes <theme> …

**Only the THREE ORNAMENTS cut.** Every other region is filled edge to edge.

**Nothing painted may be white.** `bgLum` is 228: a bright steel cutting edge
painted near-white is eaten as ground and the head stretched to cover it. Keep
the brightest steel a light grey with a colour cast.

**The heads are alternatives, not a set.** So are the collars, pommels, sleeves
and finials. Anything off the sheet's palette ends up bolted to the rest.

**The double heads are mirrored** about the haft (`mirror: "z"`, `mirrorAt`):
each island is ONE bit, worn four times (both bits, both faces). The eye block
the haft runs through is the straight step on the island's left edge. The
bearded head is not symmetric and keeps its whole outline, seen from -X so its
bit is on the right like the others'.

**The ornaments stand INSIDE the head**, not beside a blade the way a sword's
do. `hiddenBy` shades the covered part of each square on `key-labelled.png`, and
the prompt says to draw only outside it. Those slots have no `contain` fit: it
would stretch a design drawn in the open part back over the hidden part. They
are drawn for the double heads.

---

NO TEXT. NO LETTERS. NO GUIDE MARKS. The reference carries a word on every
region; those words are labels for you and must NOT appear anywhere on the
finished sheet. The grey hatching is a guide mark too: it never appears.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era two-handed
great axe, 1254x1254, painted directly over the supplied UV colour-key layout.
This is a UV sheet, NOT a 3D render, NOT a weapon illustration, NOT a poster. No
perspective, no drop shadow, no background scene, and NO border, frame, banner,
label or divider anywhere on the sheet. The ground around the regions stays
pure white.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
REGION ID marking which piece goes where. NOT ONE of them is a colour this axe
is made of. Decide the palette from the SUBJECT block ALONE — four or five tones
for the whole sheet — then check every region against the block it replaced: if
they resemble each other, repaint it.

Draw each piece to FILL its block, edge to edge, following the block's outline
exactly. Leave no white inside a block (except the three ornaments). The top of
the sheet is the top of the axe everywhere.

Every solid piece is painted ONCE and appears on BOTH faces of the axe,
mirrored. There is no separate back to paint.

REGION KEY (by position — ignore what colour each block is):

- TOP ROW, THREE BIG SHAPES — the three AXE HEADS (see HEADS). In all three the
  CUTTING EDGE is the long curve on the RIGHT.
  - LEFT: a BEARDED head: a broad bit on the right whose lower corner hooks
    down into a beard, and a short pointed SPIKE sticking out to the LEFT.
  - MIDDLE: ONE BIT of a double-bitted head, flaring into long upper and lower
    horns; the short straight step on its LEFT edge is the eye.
  - RIGHT: ONE BIT of a rounder double-bitted head; the straight step on its
    LEFT edge is the eye.
- UNDER THE HEADS, left to right:
  - the tallest, narrowest strip .. the HAFT, the wooden shaft
  - a tall strip ending in a row of POINTED TEETH .. the LONG SLEEVE, a metal
    langet running up the haft through the head; the teeth are its pointed
    lower end
  - a shorter strip ... the GRIP, where the two hands hold it
  - a short wide rectangle ... the SHORT SLEEVE, a plain square metal collar
  - a small square under it, grey at its top ... the POMMEL ORNAMENT
- RIGHT SIDE, two squares side by side, both partly grey-hatched .. the TOP
  ORNAMENT (left) and the UNDER ORNAMENT (right) (see ORNAMENTS)
- BELOW THEM, three thin bands stacked .. three COLLARS round the haft where
  the grip ends; the middle one is pinched into points, its two spikes
- a tiny square .. a SPIKE POMMEL seen from directly above: a four-sided point,
  its tip in the centre, facets running to the corners
- a small hexagon with a block under it .. a HEXAGONAL DISC POMMEL; the block
  is its edge
- two thin bands on the far right .. the two FINIALS capping the sleeves (the
  top one rises into little points)

THE HEADS — the three big shapes across the top. Paint them like a sword's
blade: the edge is honed, the flat is forged.
- The long RIGHT-HAND curve of each shape is the CUTTING EDGE. Run a brighter
  band of honed metal all along it, the same width the whole way round, up
  into the tip of each horn and down into the beard.
- Behind the edge is the CHEEK, the flat of the bit: darker forged metal. This
  is where a fuller, an etched line, a rune or a maker's mark goes, following
  the curve of the edge.
- The LEFT edge is where the bit meets the haft. On the two double heads, the
  straight step on the left is the EYE, the heavy block the haft runs through:
  thicker metal, a band or rivets. The shape is MIRRORED at that left edge to
  make the other bit, so anything touching the left edge continues straight
  across into its mirror image: no border, no bevel, no edge highlight there.
- On the bearded head the spike on the left is the same metal, tapering to a
  point; the narrow middle is its eye.
- All three are the SAME metal and finish; they differ in shape, not material.

THE PEELED STRIPS — haft, grip, sleeves, collars, finials:
Each is a round or many-sided piece unrolled and laid flat. The LEFT and RIGHT
edges of a strip are the SAME seam, so they must match in value and colour.
Anything running ACROSS a strip (around the piece) works; a diagonal spiral does
not. Light collars and finials from above, brightest along the top edge.
- HAFT: dark wood, grain running up and down, maybe a metal band or two.
- GRIP: leather wrap or cord binding in bands ACROSS the strip.
- SLEEVES: metal, a row of rivets up the middle; fill every tooth.

THE POMMELS:
The spike pommel is four triangular facets meeting in the centre: shade each
differently so the point reads. The hexagon is a metal disc face with a boss at
its centre; its block is plain metal, a touch darker.

THE THREE ORNAMENTS — THE ONLY REGIONS YOU MUST *NOT* FILL:
Each square is a BLANK SHEET OF PAPER on which you draw ONE thin openwork
ornament, with EMPTY WHITE ALL AROUND AND THROUGH IT.
- Leave the square WHITE #FFFFFF and draw the ornament onto that white.
- HALF OR MORE of the coloured part must still be white when you are done.
- MATERIAL: wrought iron wire, feathers, thorns and briars, glass or crystal
  shards, icicles, bone, antler, horn, chain, filigree. HARD, THIN, OPEN things.
- NOT CLOTH. No banner, no pennant, no tassel, no fabric, no leather.
- Every gap must have a clear path out to the white margin. Nothing enclosed.
- NO background behind the ornament. No plate, no backing, no border, no frame.

THE GREY HATCHING — the most important thing about these three squares. Unlike
a sword's ornaments, these plates stand INSIDE the axe: the GREY HATCHED part of
each square is covered by the axe head, the sleeve or the haft, and nothing
painted there is ever seen. Leave every grey hatched texel plain WHITE. Draw
the ornament ONLY in the coloured part, ATTACHED to the edge of the grey, the
way a sword's ornament grows out of its guard:
- TOP ORNAMENT (left square): the grey along the bottom is the TOP OF THE AXE
  HEAD. The ornament RISES from that grey edge — horns, a crown of spikes,
  antlers, flames off a coal — up and outward, MIRROR-SYMMETRIC about the
  middle, reaching well up into the square.
- UNDER ORNAMENT (right square): the grey in the top corners is the UNDERSIDE
  OF THE AXE HEAD, and the grey stripe down the middle is the haft. The
  ornament HANGS from the bottom edge of the grey corners, either side of the
  haft — a beard of chain, icicles, thorns or feathers — down into the square,
  the two sides MIRROR-SYMMETRIC.
- POMMEL ORNAMENT (small square): the grey at the top is the butt of the axe.
  The ornament HANGS DOWN from that grey, mirror-symmetric.
- The far edge of each square is open air: keep the design clear of it.

SHADING, because this is a PS1-era game texture:
Paint the light INTO the texture: a lit edge, a darker recess, a worn corner.
Keep it broad and flat: no photographic gloss, no chrome reflections, no smooth
gradients that band at 256 pixels. Read the whole sheet at a quarter size and
every part should still be legible as metal, wood or leather.

SUBJECT:
A plain, serviceable soldier's great axe. Grey forged iron heads with darker
hammered cheeks and brighter honed cutting edges (brightest a light grey, never
white). Collars, sleeves, finials and pommels in dark blackened iron with worn
highlights on raised edges and rivet heads. A dark ash-wood haft with lengthwise
grain. A brown leather grip wrapped in bands. The ornaments: thin iron briars
and thorns, with plenty of daylight between them. Palette: iron grey, blackened
iron, dark wood, brown leather — nothing else. Detail level: a richly
hand-painted PS1 game texture, NOT a flat vector graphic.

FINAL CHECK: no text, no letters, no label words, no guide marks and no grey
hatching anywhere on the sheet; no white inside any region except the three
ornaments; nothing drawn on a grey hatched area; no region painted in its key
colour.
