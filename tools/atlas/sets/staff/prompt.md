# Staff-atlas generation prompt

The staff sheet. Same pipeline as the swords (`sets/longsword/prompt.md`): one
modular two-handed staff ubermesh the game mixes and matches at runtime.
**Nineteen regions for sixteen parts** (the head has three).

Regenerate the key and the mesh's UVs (needed whenever the model changes):

    pnpm -F playground unwrap-weapon --recipe staff

What a staff is made of (the item generator's rules, not the painter's):

- always the **grip** (Handle);
- ONE **pommel** (Pummel1-2), ONE **collar** (CrossGuard1-3), ONE **upper
  shaft** (TopStaff1-4: plain rod, diamond frame, crook, double helix) and ONE
  **crown** (Crown1-3: octahedral gem, hex crystal, a HEAD);
- optional, rarest only: ONE **floating gem** (ShapeOrnate1-2) hanging free in
  the middle of the upper shaft — **never with TopStaff1**, whose rod runs
  straight through it — and the **top ornament** (OrnateTop), the cut-out plate
  rising out of the crown. The floating gem can wear a glow like a blade
  (docs/item-looks.md). The HEAD crown (Crown3) is rarest-of-rare too.

The head is a theme's chance to be strange: a golden idol, a mummy, a beholder,
a demon, a skull, a saint's reliquary bust — anything with a face. It is drawn
as a strip all the way round the skull, face in the MIDDLE, back of the head at
both ends.

Paste the block below into the image generator together with
**`tools/atlas/sets/staff/key-labelled.png`**. Swap only the **SUBJECT** block
to make a new set. Save the result as `tools/atlas/art/staff/<theme>.png`, then
register it:

    node tools/atlas/import-atlas.mjs --set staff --theme <theme> --slices

**Only the TOP ORNAMENT cuts.** Every other region is filled edge to edge.

**Nothing painted may be white.** `bgLum` is 228: a pale highlight is eaten as
ground and the piece stretched to cover it.

---

NO TEXT. NO LETTERS. NO GUIDE MARKS. The reference carries a word on most
regions and a grey hatched patch on one; those are labels for you and must NOT
appear anywhere on the finished sheet.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era two-handed
wizard's STAFF, 1254x1254, painted directly over the supplied UV colour-key
layout. This is a UV sheet, NOT a 3D render, NOT a weapon illustration, NOT a
poster. No perspective, no drop shadow, no background scene, and NO border,
frame, banner, label or divider anywhere on the sheet. The ground around the
regions stays pure white.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
REGION ID marking which piece goes where. NOT ONE of them is a colour this staff
is made of. Decide the palette from the SUBJECT block ALONE — four or five tones
for the whole sheet — then check every region against the block it replaced: if
they resemble each other, repaint it.

Draw each piece to FILL its block, edge to edge, following the block's outline
exactly. Leave no white inside a block (except the top ornament). The top of
the sheet is the top of the staff everywhere.

Every solid piece is painted ONCE and appears on BOTH faces of the staff,
mirrored. There is no separate back to paint.

REGION KEY (by position — ignore what colour each block is):

- FAR LEFT, a VERY TALL narrow rectangle running almost the full sheet height
  .. the GRIP: the lower haft, unrolled all the way round. Top meets the collar,
  bottom meets the pommel; its LEFT and RIGHT edges are the same seam and must
  match.
- TOP MIDDLE, four tall shapes side by side .. the four UPPER SHAFTS, each the
  part of the staff above the collar (see UPPER SHAFTS). Left to right:
  - a plain tall rectangle: a straight rod, unrolled all the way round;
  - a rod topped by an OPEN DIAMOND FRAME, seen flat-on;
  - a rod that bends into a CROOK, a hook curling over at the top, seen from
    the side;
  - TWO STRANDS TWISTED round each other into a double helix, seen flat-on.
- BELOW THE SHAFTS, LEFT, three small DIAMONDS stacked .. top to bottom: the
  GEM CROWN (an eight-faced crystal on top of the staff), the small FLOATING
  CRYSTAL, and the SPIKE POMMEL (an eight-faced point at the foot).
- BELOW THE SHAFTS, MIDDLE, five flat strips stacked .. top to bottom: the HEX
  CRYSTAL CROWN (a six-sided crystal, peeled open all the way round), the hex
  FLOATING CRYSTAL (same, smaller), the SQUARE COLLAR, the HEX COLLAR (both
  bands of metal peeled open round the haft), and the HEX KNOB POMMEL (a strip
  with a point at each end).
- BELOW THE SHAFTS, RIGHT, a shape with TWO PRONGS rising in a V and a bar under
  it .. the FORKED COLLAR, seen flat-on; the bar is its edge.
- TOP RIGHT, a large SQUARE with a grey hatched patch at the middle of its
  bottom edge .. the TOP ORNAMENT (see TOP ORNAMENT).
- RIGHT, under the square, three pieces stacked in a column .. the HEAD crown
  (see THE HEAD): a small rounded shape (the top of the skull seen from
  directly above, forehead at its BOTTOM edge), a wide strip (the whole head
  seen all the way round), and a small shape under it (the underside of the
  jaw and neck).

UPPER SHAFTS:
- The plain rod and the bottom of every other shaft are the SAME material as the
  grip, so the staff reads as one length. Grain or bands run LENGTHWISE.
- The DIAMOND FRAME is a square ring of the same material standing on one
  corner, the floating crystal hangs in its hollow. Paint the ring; its hollow
  centre is not part of the block and stays white.
- The CROOK is one bent length: let the grain follow the bend.
- The DOUBLE HELIX: two strands of the same material wound round each other,
  lit along the outer side of each strand; the gaps between them stay white.

THE CROWNS, FLOATING CRYSTALS AND POMMELS:
- The two CROWNS are made of whatever the SUBJECT says: a jewel, but just as
  often a carved wooden knob, a metal cap or a lump of stone. Only the two
  FLOATING CRYSTALS are always gems (glassy or stony, facets drawn as flat
  planes of colour, a lighter core and darker edges).
- A DIAMOND region is the piece seen from the front: its facets or carved faces
  meeting at the centre.
- A STRIP region is the piece peeled open: its faces run as vertical bands, the
  point at each end.
- The pommels and collars are the staff's METAL fittings: bands, rivets, worn
  edges; lit from above, mirror-symmetric left to right.

THE HEAD — the wide strip and the two small pieces with it:
- The strip is the head seen ALL THE WAY ROUND: the FACE in the MIDDLE third,
  the cheeks and ears either side of it, the BACK of the head at both ends
  (the two ends meet behind it, so they must match). TOP of the strip is the
  top of the skull, BOTTOM is the chin and neck.
- Eyes a little above the middle of the strip's height, nose below them,
  mouth near the bottom. The face is SYMMETRIC about the strip's centre line.
- The small shape ABOVE it is the scalp seen from directly above, the same
  covering as the top of the strip. The small shape BELOW is the underside of
  the chin, plain and in shadow.
- It is a CARVED or CRAFTED head on a staff, not a living person: see SUBJECT.

THE TOP ORNAMENT — THE ONLY REGION YOU MUST *NOT* FILL:
The square is a BLANK SHEET OF PAPER on which you draw ONE thin openwork
ornament, with EMPTY WHITE ALL AROUND AND THROUGH IT.
- Leave the square WHITE #FFFFFF and draw the ornament onto that white.
- HALF OR MORE of the square must still be white when you are done.
- It rises out of the CROWN, which sits in front of the grey hatched patch.
  Every stroke of the design must CONNECT, through other strokes, DOWN TO THE
  BOTTOM-CENTRE of the square, at the hatched patch; the design GROWS UPWARD AND
  OUTWARD from there. Nothing floats free.
- MIRROR-SYMMETRIC left to right. Keep the top and side edges clear: they are
  open air.
- MATERIAL: wrought metal wire, rays, horns, antlers, thorns, feathers, glass or
  crystal shards, bone, filigree. HARD, THIN, OPEN things. NOT CLOTH.
- NO background behind the ornament. No plate, no backing, no border, no frame.

SHADING, because this is a PS1-era game texture:
Paint the light INTO the texture: a lit edge, a darker recess, a worn corner.
Keep it broad and flat: no photographic gloss, no chrome reflections, no smooth
gradients that band at 256 pixels. Read the whole sheet at a quarter size and
every part should still be legible as wood, metal, crystal or bone.

SUBJECT:
A plain hedge-wizard's staff. Dark weathered oak haft with long lengthwise
grain, iron fittings (collars, pommels) blackened with worn highlights. The
crystals pale blue quartz. The head a carved oak face of an old bearded man,
eyes closed. The ornament thin iron rays and curls. Palette: dark oak, black
iron, pale blue quartz — nothing else. Detail level: a richly hand-painted PS1
game texture, NOT a flat vector graphic.

FINAL CHECK: no text, no letters, no label words, no guide marks anywhere on the
sheet; no white inside any region except the top ornament; no region painted in
its key colour.
