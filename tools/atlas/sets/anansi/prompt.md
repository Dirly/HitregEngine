# Anansi-atlas generation prompt

One anansi — a hooded humanoid torso on a spider body — in 19 regions. The
unwrap is PROJECTED by `unwrap-weapon`, not authored (the Blockbench file has
default whole-sheet UVs only); every part is one connected island:

    pnpm -F playground unwrap-weapon --recipe anansi --islands

**Hand the generator `tools/atlas/sets/anansi/key-labelled.png`, NOT `key.png`.**
Every block carries its name except the buckle. The kit (hood + crown, belt +
buckle, tasset) and the head cut are the ghoul's, and so are the importer fixes:
`flush` on the hood, the hood crown `borrow`s the hood's painted top band. The
HEAD crown is the generator's own art — borrowing the head strip's top band put
a bald stripe over the skull.
The head is one STRIP round the skull with the crown centred above it and the
jaw underside (`head-under`, split off the strip) centred below it.

Register, then bake ONLY to look at it — a theme is a texture, not a model. The
one mesh that ships is `MMO/3d/Mobs/Anansi-unwrapped.glb`:

    node tools/atlas/import-atlas.mjs --set anansi --theme <theme>

    pnpm -F playground unwrap-weapon --recipe anansi --atlas ../../tools/atlas/out/anansi/<theme>/atlas.png --out-mesh <scratch>/Anansi-<theme>

Swap only the **SUBJECT** block to make a different anansi, and name every piece
of kit in it — a block the SUBJECT never mentions comes back blank or borrowed.
Name no ornament on a piece that is not meant to carry it: a memorable detail
in the SUBJECT goes looking for a block shaped like it.

---

A flat 2D hand-painted texture atlas for a very low-poly PS1-era ANANSI — a
creature that is a hooded humanoid from the waist up and a great SPIDER from the
waist down — 1254x1254, painted directly over the supplied UV layout. This is a
UV sheet, NOT a 3D render, NOT a character illustration. No perspective, no drop
shadow, no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.** Read the
word in a block before painting it. Paint over the lettering — it is a guide,
not artwork, and it must not appear in the finished sheet.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
region ID. NOT ONE of them is a colour this creature is made of. Decide the
palette from the SUBJECT block alone.

The one unlabelled block: the small square right of BELT is the BUCKLE.

**ALL 19 BLOCKS MUST BE PAINTED**, edge to edge. A block left white is not a
piece left off the anansi; it is a piece that wears its neighbour's skin on the
model. Check the small blocks before finishing: BUCKLE, UNDER JAW, HEAD-CROWN,
HOOD-CROWN, TASSET-FRONT, both HAND blocks and the long thin BELT.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent, not
a tone. The importer finds its ground by flooding in from the border through
everything bright.

**Nothing painted may be white.** Bright pixels read as ground. Bone, teeth,
silk and bare metal want a warm cream around #E8DCC0 or a light grey — keep
them dirty.

**Fill each block edge to edge and a little past it.** The islands are drawn 8px
larger than the geometry on purpose. Nothing may hang OUT of a block: a piece
that continues onto another part is DRAWN AGAIN inside that part's block, never
across the gap.

**THE FRAYED HEM IS CUT FOR YOU.** The importer tears the bottom of TASSET-FRONT
itself, in an uneven line. Paint it FULL, right down to the bottom edge; put the
hem treatment in the bottom fifth and leave the last couple of texels plain for
the cut to eat. No crisp line across the bottom.

MATERIALS — which blocks are the same as which. **Do not carry a material across
these groups:**

    HEAD, HEAD-CROWN, UNDER JAW ... the anansi's own face and scalp
    CHEST-FRONT, CHEST-BACK,
    ARM-OUTSIDE, ARM-INSIDE,
    HAND-OUTSIDE, HAND-PALM ....... the humanoid upper body, BARE, the SAME SKIN
                                    AS THE HEAD — no sleeve, no cuff, no glove;
                                    it turns to chitin at the waist (see TORSO)
    SPIDER-BODY, SPIDER LEG-FRONT,
    SPIDER LEG-MIDDLE,
    SPIDER LEG-BACK ............... the spider half: one chitin/hide throughout
    HOOD, HOOD-CROWN .............. one cowl, same cloth throughout
    BELT, BUCKLE .................. a strap and its fitting
    TASSET-FRONT .................. a hanging panel from the belt

**ONE VALUE RANGE.** Within each group above, no block may stand out lighter or
darker than its partners — a hand paler than its arm reads as a glove, one leg
darker than the other two reads as a different spider.

THE SPIDER HALF — the whole LEFT column.
- SPIDER-BODY, the big block at the TOP-LEFT, is the spider body SEEN FROM THE
  SIDE: FRONT at the RIGHT (the smaller lobe, where the humanoid waist rises
  from it), the great bulbous ABDOMEN at the LEFT. TOP edge is the back, BOTTOM
  edge the belly. Painted once and worn on both sides, mirrored — nothing that
  only belongs on one side. The back carries the pattern (the markings the
  SUBJECT names), the belly is darker and plainer. The white notch inside the
  block is a gap in the model, not part of it: paint around it.
- SPIDER LEG-FRONT, -MIDDLE and -BACK are each ONE jointed leg laid out flat,
  and **the block IS the leg's shape**: the HIP at the LEFT end (the short
  flared collar), the KNEE where the block steps in (about 40% across), a
  second joint where it narrows again (about 70% across), and the block's
  POINT at the RIGHT end is the tip of the leg. **The middle of the block, left
  to right, is the TOP of the leg; both long edges are its underside.** Fill
  the whole shape, right out to the point — the point is painted, not white.
  Joint rings at the hip, knee and second joint; the tip darkening to a hard
  point. Bristles are painted INSIDE the block, never as hairs sticking out of
  its edge. Legs, not tails, not ropes, not belts, not arms. The three are the
  three legs of one side and are worn on both sides.

THE HEAD — the wide block lettered HEAD, top of the right-hand column. It is the
WHOLE HEAD UNROLLED INTO ONE STRIP, like a label peeled off a jar: the FACE in
the MIDDLE, the two sides of the head either side of it, and the BACK of the
head split between the far LEFT and far RIGHT ends (the ends meet at the back of
the head, so they must match). TOP edge the top of the head, BOTTOM edge
the jaw line. It is seen inside the hood and without one — no hood shadow.

**THE FACE IS MARKED ON THE REFERENCE.** Inside the HEAD block:
- the TWO BLACK DOTS ringed in white are the two EYES;
- the SMALL DOT below them is the NOSE;
- the SHORT BAR below that is the MOUTH.

Paint the face AROUND those marks, at THAT size, and paint over the marks
themselves. Brow to chin the face fills most of the strip's height. The face is
BROAD: the bare skin of the temples, cheekbones, cheeks and jaw spans about
THREE TIMES the distance between the two eye marks, centred on them, directly
under the HEAD-CROWN block — then the sides of the head. **Nothing covers the
sides of the face**: no hair, no hood shadow, no dark band framing it, or the
face reads as a narrow strip on the model. Everywhere else on the strip is the
sides and back of the head — no second face, no eyes anywhere else. It is a
surface painted edge to edge, not a head picture with background.

**THE TOP QUARTER OF THE STRIP IS ONE BAND, ALL THE WAY ACROSS** — over the face
too. Whatever covers the scalp (hair, the SUBJECT says what) runs the full
width of the top edge in one even band, the hairline just above the brow in the
middle. No bare forehead reaching the top edge: it meets HEAD-CROWN there, and a
bare patch reads as a bald stripe over the skull. Below that band the scalp
covering stays on the BACK of the head only (the two far ends of the strip),
never down the sides of the face.

HEAD-CROWN — the block centred ABOVE the head strip: the top of the head seen
from DIRECTLY ABOVE, the FRONT (forehead) at the BOTTOM of the block, touching
the head strip's face. Paint it as the SAME scalp covering as the head strip's
top band — same colour, same value, same texture, filling the block edge to
edge (a crown of hair seen from above: parted or swirling from the middle).
Above all, no face and no skin patch in it.

UNDER JAW — the block centred BELOW the head strip: the underside of the chin
and jaw, seen from below, CHIN at the TOP. Plain skin at the head's value,
darker toward the bottom edge (the throat). No face.

HOOD — the block at the BOTTOM of the right-hand column. **No face in it, no eyes, and no dark
opening**: the face is the HEAD strip, and this block is only the OUTSIDE of the
cowl. Paint cloth right to every edge. It is a SIDE PROFILE of the cowl, face
opening to the RIGHT, painted once and worn on both sides mirrored. HOOD-CROWN,
beside it, is the top of the cowl from above and is HALF of it: its TOP edge is
the centre line over the crown, FRONT at the RIGHT. Carry the hood's cloth
straight across it — same folds and brightness as the TOP of the hood block.

THE TORSO — CHEST-FRONT and CHEST-BACK are front and back views of the
humanoid torso: shoulders at the TOP, the waist at the BOTTOM where it sinks
into the spider body. **Nothing detailed in the top eighth of either** (the
neck, hidden under the hood). Light it from ABOVE.

**THE WAIST IS WHERE THE TWO HALVES BECOME ONE CREATURE — there must be no
line there.** The bottom of both CHEST blocks sits right on the front of the
spider body, so paint the change INTO the skin: across the bottom fifth of
CHEST-FRONT and CHEST-BACK the skin turns into the spider's chitin — overlapping
chitin plates and bristles creeping UP the belly and lower back in a ragged,
uneven edge, fully chitin at the bottom edge. And the FRONT lobe of SPIDER-BODY
(its right end, where the torso rises) is the same chitin at the same value,
no pattern on it. The chest blocks and the spider blocks must meet at one
colour.

THE ARM and THE HAND — bare skin, same as the chest. Shoulder at the TOP of
both arm blocks, wrist at the BOTTOM, elbow at the same height in both;
ARM-OUTSIDE the outer face, ARM-INSIDE the inner face toward the body.
HAND-OUTSIDE (back of the hand) and HAND-PALM are the two small blocks right of
the arms: wrist at the TOP, fingertips at the BOTTOM — **a HAND with long
FINGERS, the same skin as the arm. Not a sleeve, not a glove.** The arm and
hand exist once in the model and are worn on both sides.

THE BELT — the long thin bar at the bottom-left, under the spider legs, unrolled round the waist:
its CENTRE is the front where the buckle sits, both ENDS the same seam at the
back and must match. Only four texels tall on the finished sheet — tone and
edge stitching, nothing fine.

THE BUCKLE — filling its small block corner to corner as a solid fitting. No
white anywhere in it.

TASSET-FRONT — the tall narrow bar right of the BUCKLE. **A FLAT HANGING PANEL,
NOT A FINGER, NOT A BONE, NOT A LEG** — it hangs from the belt over the front of
the spider body. Waist at the TOP (a band of fixings matching the belt), hem at
the BOTTOM. Keep the detail vertical and simple.

SEAMS THAT HAVE TO LINE UP: the throat (chest front and back to the head); the
sides of the torso (front and back are two halves of one barrel); the waist
(the bottom of both chest blocks against the front of the spider body); the
hood and its crown; the two ends of the head strip; the two ends of the belt.

SHADING, because this is a PS1-era game texture: paint the light INTO the
texture. Broad and flat, no photographic detail, no specular sheen, no
gradients so smooth they band at 256 pixels. At a quarter size every block
should still read as skin, chitin, cloth, leather or metal.

SUBJECT:
