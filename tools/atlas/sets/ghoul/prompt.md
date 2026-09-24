# Ghoul-atlas generation prompt

One lich ghoul in 28 regions. The unwrap is PROJECTED by `unwrap-weapon`, not
authored — every part is one connected island, flared at the edges:

    pnpm -F playground unwrap-weapon --recipe ghoul --islands

**Hand the generator `tools/atlas/sets/ghoul/key-labelled.png`, NOT `key.png`.**
Every block carries its own name except the buckle — tall narrow blocks are
lettered on end. On the first three sheets the five blocks that were NOT
lettered (tassets, hands, buckle) were exactly the ones painted wrong: the
tassets came back as clawed hands, the hands as sleeve cuffs. Neighbours
matter as much: the hands parked beside SPINE BONE came back as coiled bone,
so they sit beside the arm now. The HEAD is one wide STRIP round the skull
(`method: "sphere", v: "height"`) with the CROWN as its own island centred
above it — mapped into the strip, the crown made the generator stretch the face.
Two importer passes fix what no prompt did: `flush` on the hood strips the
painted black opening and stretches the cloth to the island edge, `solid`
flattens the ribs to one bone colour. Some labels are
INSTRUCTIONS ("RIB-UPPER BONE", "BARE LEGS-FRONT", a slot's `label`): the ribs
came back as cloth on every sheet while lettered RIB-UPPER and parked beside the
belt, and the legs as trousers — so the ribs moved next to the spine and the
word on the block now says what it is made of.

Register, then bake ONLY to look at it — a theme is a texture, not a model. The
one mesh that ships is `MMO/3d/Mobs/LitchGhoul-unwrapped.glb`; send a theme's
bake to a scratch folder so it never lands beside it (the bake writes
`atlas-seamblend.png` next to the atlas, which is the sheet to use):

    node tools/atlas/import-atlas.mjs --set ghoul --theme <theme>

    pnpm -F playground unwrap-weapon --recipe ghoul --atlas ../../tools/atlas/out/ghoul/<theme>/atlas.png --out-mesh <scratch>/LitchGhoul-<theme>

Swap only the **SUBJECT** block to make a different ghoul, and name every piece
of kit in it — a block the SUBJECT never mentions comes back blank or borrowed.
Name no ORNAMENT on a piece that is not the ornament: a memorable detail in the
SUBJECT goes looking for a block shaped like it.

---

A flat 2D hand-painted texture atlas for a very low-poly PS1-era LICH GHOUL — a
gaunt, hollow-bodied undead in a deep hood and a ragged open robe — 1254x1254,
painted directly over the supplied UV layout. This is a UV sheet, NOT a 3D
render, NOT a character illustration. No perspective, no drop shadow, no
background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.** Read the
word in a block before painting it. Paint over the lettering — it is a guide,
not artwork, and it must not appear in the finished sheet.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
region ID. NOT ONE of them is a colour this creature is made of. Decide the
palette from the SUBJECT block alone.

The one unlabelled block: the small square right of HOOD-CROWN is the BUCKLE.

**ALL 28 BLOCKS MUST BE PAINTED** — every one except the ORNAMENT edge to edge.
A block left white is not a piece left off the ghoul; it is a piece that wears
its neighbour's skin on the model. Check the small blocks in particular before
finishing: the two RIB blocks under SPINE BONE in the right-hand column, ORNAMENT,
CHEST-BOTTOM and the long BELT along the bottom all have to be there — sheets
have come back missing RIB-LOWER and the BELT.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent, not
a tone. The importer finds its ground by flooding in from the border through
everything bright.

**Nothing painted may be white.** Bright pixels read as ground. Bone, teeth and
bare metal want a warm cream around #E8DCC0 or a light grey — keep them dirty.

**Fill each block edge to edge and a little past it.** The islands are drawn 8px
larger than the geometry on purpose. Nothing may hang OUT of a block: a piece
that continues onto another part is DRAWN AGAIN inside that part's block, never
across the gap.

**THE FRAYED HEM IS CUT FOR YOU.** The importer tears the bottom of ROBES-FRONT,
ROBES-BACK, TASSET-FRONT and TASSET-BACK itself, in an uneven line. Paint those
four FULL, right down to the bottom edge; put the hem treatment — grave dirt, a
darker rotted band, loose threads — in the bottom fifth, and leave the last
couple of texels plain for the cut to eat. No crisp line across the bottom.

THE IRON ORNAMENT — THE ONE BLOCK YOU MUST *NOT* FILL:
THIS IS THE EXCEPTION TO THE COVERAGE RULE. Every other block gets filled edge
to edge. This one does not, and filling it is the single most-repeated failure
of this kind of sheet — it comes back as a rusted square plaque with an emblem
on it, every time.

The block labelled ORNAMENT is NOT a plaque, NOT a panel, NOT a tile, NOT a
backing plate, NOT a shield. It is a BLANK SHEET OF PAPER on which you draw ONE
thin wrought-iron object, floating, with EMPTY WHITE ALL AROUND IT. On the model
it stands up behind the ghoul's head and shoulders like a halo; its BOTTOM edge
is where it is fixed to the back, so the ironwork rises from the bottom middle.

- Leave that block PURE WHITE #FFFFFF and draw the ironwork onto that white.
  Not cream, not parchment, not an off-white paper texture — a sheet came back
  with the ironwork on cream, and cream is not cut: it renders as a solid plate.
- **Draw it INSIDE the block's outline.** The white space BELOW the block is
  not the block — two sheets drew the halo down there, under the label, and
  none of it landed on the model. The iron's bottom sits on the block's bottom
  edge; the whole design fits inside the square.
- 60-80% of the block must still be white when you are done.
- The iron is a thin OPEN silhouette: a wire halo, a BROKEN ring, an arc of
  spikes or rays, a fan of iron rods, a crescent, a pair of horns, a spray of
  nails. Thin bars with daylight between them. Symmetrical left to right — it is
  seen from the front and from behind.
- Every gap between the bars is white and has a clear path out to the white
  margin around the design. Nothing enclosed.
- Leave a wide white margin on the top and both sides. The iron never touches
  those edges.
- NO background behind the ironwork. No rust plate, no leather backing, no
  stone, no cloth, no border, no frame, no vignette, no drop shadow. White only.

MATERIALS — which blocks are the same as which. **Do not carry a material across
these groups:**

    HEAD, HEAD-CROWN .............. the ghoul's own dead skin and skull
    CHEST-FRONT, CHEST-BACK,
    CHEST-BOTTOM, LEGS-FRONT,
    LEGS-BACK, LEGS-TOP ........... one withered corpse body, the SAME SKIN AS
                                    THE HEAD — it meets the head at the throat
    ARM-OUTSIDE, ARM-INSIDE,
    ARM-BACK, HAND-OUTSIDE, HAND-PALM, FOOT . the same skin again, BARE — no sleeve, no
                                    cuff, no cloth, no plate on any of them
    SPINE, RIB-UPPER, RIB-LOWER ... bare BONE, and nothing else
    HOOD, HOOD-CROWN .............. one cowl, same cloth throughout
    ROBES-FRONT, ROBES-BACK ....... one garment: same cloth, weave and value
    TASSET-FRONT, TASSET-BACK ..... one pair, hung either side of the same belt
    SHOULDER, SHOULDER-2 .......... one pauldron in two overlapping plates
    BELT, BUCKLE .................. a strap and its fitting
    ORNAMENT ...................... thin iron on white — see above

**ONE VALUE RANGE.** Within each group above, no block may stand out lighter or
darker than its partners — a hand paler than its arm reads as a glove.

THE HOLLOW BODY — this is what makes it a ghoul. The torso is OPEN: between the
bottom of the chest and the top of the hips there is no belly, only the SPINE
and two RIBS hanging in a hollow.
- CHEST-FRONT is the upper chest and pectorals; its bottom edge is the torn lip
  of the cavity. CHEST-BACK is the upper back and shoulder blades.
- CHEST-BOTTOM is the UNDERSIDE of that upper chest, seen looking up into the
  cavity: the ragged inside of the ribcage roof — dark, dried, sinewy, the ends
  of torn muscle. FRONT of the body at the BOTTOM of the block.
- LEGS-TOP is the FLOOR of the cavity, the top of the pelvis seen from above:
  dark shrivelled tissue with the bone of the hip showing through. FRONT of the
  body at the BOTTOM of the block.
- SPINE is the backbone in profile, top of the block at the chest, bottom at the
  hips, FRONT of the body on the RIGHT: a column of knobbled vertebrae, each a
  separate bead of bone with a dark gap under it.
- RIB-UPPER and RIB-LOWER are each ONE rib straightened out: the LEFT end joins
  the spine (a knobbed head), the RIGHT end is the broken tip at the front.
  ONE FLAT BONE COLOUR across the whole block, end to end — no bands, no rings,
  no knobs, no segments (that is the spine, not a rib). **Not cloth, not a strap, not a
  belt** — sheets have come back with both ribs painted as strips of the robe's
  cloth. Not a limb, not a finger, not a bar with bands on it.
- Inside the cavity everything is darker than outside — paint these four blocks
  a clear step down in value from the chest and legs, and the bone lighter than
  everything round it.

THE HEAD — the wide block lettered HEAD, low in the middle column. It is the
WHOLE SKULL UNROLLED INTO ONE STRIP, like a label peeled off a jar: the FACE in
the MIDDLE, the two sides of the head either side of it, and the BACK of the
skull split between the far LEFT and far RIGHT ends (the ends meet at the back
of the head, so they must match). Down the strip is straight down the head: the
TOP edge is the top of the forehead and skull, the BOTTOM edge the chin. It is
seen inside the hood and without one, so all of it is skin — no hood shadow.

**THE FACE IS MARKED ON THE REFERENCE.** Inside the HEAD block there are four
marks, measured off the model's own face — they are exactly where the features
go and exactly how big the face is:

- the TWO BLACK DOTS ringed in white are the two EYES;
- the SMALL DOT below them is the NOSE;
- the SHORT BAR below that is the MOUTH.

Paint the face AROUND those marks, at THAT size, and paint over the marks
themselves (they are guides, like the lettering). Brow to chin the face fills
most of the strip's height; cheek to cheek it spans about TWICE the distance
between the two eye marks, centred on them — in the middle of the strip, directly
under the HEAD-CROWN block. Two sheets got this wrong without the marks: one drew the face
tiny, one drew it off to the side.

- Two sunken EYE SOCKETS on the dots, each with a small dull pin of light
  (never white).
- The NOSE is gone: a dark triangular hole with two slits, on the nose dot.
- The MOUTH on the bar: lips shrunk back off long, uneven, stained teeth in a
  fixed grin, no wider than the bar. The teeth are cream, not white.
- A heavy brow just above the eyes, hollow cheeks, cheekbones standing out.
- Everywhere else on the strip — left and right of the face, all the way to
  both ends — is the sides and BACK of the skull: the same dead skin, a few lank
  strands of hair and cracked patches, darker toward the ends. No second face,
  no eyes, no teeth anywhere else.
- It is a surface painted edge to edge, not a skull picture with background.

HEAD-CROWN — the block centred ABOVE the head strip: the top of the skull from
above. Paint it the same skin as the top of the head strip; the importer
replaces it with the head's own painted skin, so nothing drawn here survives —
above all, no face.

HOOD — the block at the TOP-LEFT. **No face in it, no skull, no eyes, and no dark
opening**: the face is the HEAD strip, and this block is only the OUTSIDE of the
cowl. Paint cloth right to every edge, the face-opening edge at the RIGHT
included — no black hole, no dark lining, no shadowed interior. It is a SIDE PROFILE of the cowl, face opening to the RIGHT, painted once and
worn on both sides mirrored: one fold pattern, nothing that only belongs on one
side. Heavy cloth draped in thick folds, the rim at the right darker and more
worn. HOOD-CROWN is the top of the cowl from above, and it is HALF of it: its TOP edge
is the centre line running over the crown of the head, its BOTTOM edge is where
it meets the side of the hood, FRONT at the RIGHT. It is painted once and worn
on both sides, like the hood itself, so carry the hood's cloth straight across
it — same gauge, folds and brightness as the TOP of the hood block — and put
nothing on it that only belongs on one side.

THE ROBE — ROBES-FRONT is the two tall panels hanging OPEN at the front (the gap
between them is where the legs show), ROBES-BACK the broad back. Waist at the
top of all three, hem at the bottom. The outer edge of each front panel meets
the back block at the same height. **Do not draw the belt or buckle on the
robe** — they have their own blocks.

THE BELT — unrolled round the waist: its CENTRE is the front where the buckle
sits, both ENDS the same seam at the back and must match. Only four texels tall
on the finished sheet — tone, grain and edge stitching, nothing fine.

THE BUCKLE — filling its small block corner to corner as a solid fitting. No
white anywhere in it.

THE TASSETS — the two tall narrow bars lettered TASSET-FRONT and TASSET-BACK. One hangs at the FRONT
of the hips between the robe panels, one at the BACK: one piece of kit, same
material and value. **A TASSET IS A FLAT HANGING PANEL, NOT A FINGER, NOT A
BONE, NOT A SPINE** — no vertebrae, no ribs down it (a sheet came back with both tassets painted as backbones). Waist at the TOP (a band of fixings matching the belt), hem at the
BOTTOM, the wear running down it. Keep the detail vertical and simple.

THE SHOULDER PLATES — one pauldron in two overlapping lames, worn on both
shoulders. SHOULDER caps the shoulder; SHOULDER-2 hangs under it. Fill each
corner to corner; the lower one's top edge goes darker in the upper one's
shadow.

THE ARM and THE HAND — bare skin, no sleeve and no shoulder plate (the plates
have their own blocks). Shoulder at the TOP of both arm blocks, wrist at the
BOTTOM, the elbow at the same height in both; ARM-OUTSIDE is the outer face,
ARM-INSIDE the inner face toward the body, ARM-BACK the narrow back of the arm
(the tall bent strip right of TASSET-BACK) — all three the same arm. HAND-OUTSIDE and HAND-PALM are
the two small blocks right of ARM-BACK: wrist at the TOP, fingertips at the
BOTTOM, long bony fingers with the knuckles standing out and dark cracked nails
like claws — **a HAND with FINGERS, the same skin as the arm. Not ribs, not a
coil of bone, not vertebrae, not a sleeve.** A sheet came back with both hands
painted as stacked bone rings. The palm is the same skin at the same value.
The arm and hand exist once in the model and are worn on both sides.

THE FOOT — seen from DIRECTLY ABOVE, TOES at the RIGHT, HEEL at the LEFT, the
TOP edge the inner side. Bony, long-toed, dark-nailed. The sole is never seen
and shares this paint — draw no sole.

THE BODY — CHEST and LEGS are front and back views. **The LEGS blocks are bare
skin from hip to ankle.** The robe and the tassets are separate geometry
hanging OVER the legs; painting cloth, a robe skirt or a belt into the top of a
leg block puts a second robe on the ghoul. **Nothing detailed in the
top eighth of either chest block** (the neck and the tops of the shoulders —
hidden under the hood and plates, and folded hard). Light it from ABOVE: the
tops of the shoulders and thighs lighter, the underside of the ribcage and the
backs of the knees darker. The legs are bare, wasted, shins like sticks.

SEAMS THAT HAVE TO LINE UP: the throat (chest front and back to the head); the
sides of the body (front and back are two halves of one barrel); the waist; the
robe's sides; the leg blocks at ankles and hips; the hood and its crown.

SHADING, because this is a PS1-era game texture: paint the light INTO the
texture. Broad and flat, no photographic detail, no specular sheen, no
gradients so smooth they band at 256 pixels. At a quarter size every block
should still read as skin, bone, cloth, leather or metal.

SUBJECT:
