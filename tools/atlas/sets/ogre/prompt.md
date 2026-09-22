# Ogre-atlas generation prompt

The first CREATURE sheet. Same pipeline as the sword (`sets/longsword/prompt.md`) and
the armor sheet (`sets/armor/prompt.md`), different key: one ogre, modelled as ten shells —
the front and back of the torso, the front and back of the legs, the head, the
outer and inner faces of an arm, the back and palm of a hand, and a foot —
thirteen regions in all, because three of those shells turn a corner too sharp
for one flat view and are drawn in two pieces. Unlike a weapon they are not
alternatives:
every one of them is on the animal at once, so the whole sheet has to read as
one skin.

Regenerate the key and the mesh's UVs (needed whenever the model changes):

    pnpm -F playground unwrap-weapon --recipe ogre

Paste the block below into the image generator together with
**`tools/atlas/sets/ogre/key.png`**. Swap only the **SUBJECT** block to make a
different ogre. Then register the result and bake it into the mesh:

    node tools/atlas/import-atlas.mjs --set ogre --theme <theme>

    pnpm -F playground unwrap-weapon --recipe ogre \
      --atlas ../../tools/atlas/out/ogre/<theme>/atlas.png

    pnpm -F playground atlas-view --recipe ogre --height 3 \
      --project <project> --atlas ../../tools/atlas/out/ogre/<theme>/atlas.png

`--set ogre --theme <theme>` resolves all four paths from the standard layout:
the key and manifest in `sets/ogre/`, the sheet at `art/ogre/<theme>.png`, and
the atlas into `out/ogre/<theme>/`. So put the generated sheet at
`tools/atlas/art/ogre/<theme>.png` and the rest follows.

The second command writes `Ogre-unwrapped.glb` with the atlas inside it; look at
`sets/ogre/key-check.png` afterwards — that is the finished ogre, rendered, from
behind and from three-quarters.

**The islands are drawn 8px LARGER than the geometry, on purpose.** Each one is
grown outward in its own colour (`keyStroke`), so artwork that runs a little
past a block's outline is cropped rather than missed. Draw to the edge and
slightly over; do not draw inside it. Measured on the first sheet, every piece
came back one to three pixels short all the way round and that fringe rendered
as a wrong-coloured seam on the model.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF.** Every part of the sheet not
covered by a piece of the ogre — between the blocks, and the whole empty bottom
of the sheet — is white. Not black, not transparent, not a tone, not a colour.
The importer finds the ground by flooding in from the edge of the sheet through
everything BRIGHT, so a sheet handed back on black has no ground at all and
every piece reads as running off into it. It is rejected outright.

**Nothing on this sheet cuts.** An ogre is solid hide all the way round. There
are no alpha regions, no cyan, and no region that may be left white.

**Nothing painted may be white.** The importer finds the ground by flooding in
from the edge of the sheet through everything brighter than a light grey, so a
tusk or a claw painted in white loses itself to the background and the `contain`
fit then stretches the rest of that region to cover its island. The manifest
puts the bar at `bgLum` 236 — higher than the sword's, because nothing here
needs pure white for anything — so ivory, bone and claw want a warm cream around
#E8DCC0, never #FFFFFF. Pure white belongs to the background and nowhere else.

**Draw each piece to FILL its block.** Measured on the first sword sheet, pieces
came back between 0.46x and 1.9x the size of the region they belonged to and
shifted by up to 150 pixels. The importer rescales what it finds, but it can
only rescue artwork that is recognisably in the right place.

**The edges of the body shells are SEAMS, and they meet.** The left column is
the ogre's front and the middle column is its back; they are two halves of the
same barrel, joined all the way down both sides. Whatever tone runs off the left
edge of the chest-front block has to be the tone that runs off the left edge of
the chest-back block, or a stripe appears down the ogre's side. The same goes
for the legs, and for the waist where the torso blocks meet the leg blocks.

**Three seams have been got wrong once already, so they are called out twice
below**: the strap has to cross the side edges at the same height front and
back, the waist wrap has to continue onto the top of the leg blocks, and the
inner arm has to be the same tone as the outer arm.

**One animal, one palette — and ONE VALUE RANGE.** Pick three or four hide
tones and one or two accents from the SUBJECT block before painting anything,
and paint the whole sheet out of them. The failure this causes is not colour, it
is BRIGHTNESS: each block gets painted to look right on its own, so the hand
comes back paler than the arm it is bolted to and the foot paler than the leg,
and on the model that reads as a glove and a sock. Measured on two sheets, the
inner arm came back 18% brighter than the outer arm and a hand 26% brighter than
its forearm. So:

- The mid-tone of the hide is the SAME VALUE in every block. Squint at the
  finished sheet: no block should stand out as lighter or darker than its
  neighbours.
- **The hand is the wrist continued.** Match its value to the BOTTOM of the arm
  blocks, not to a palm you imagine in daylight.
- **The foot is the ankle continued.** Match its value to the BOTTOM of the
  front-leg block.
- **The inner arm is the outer arm from the other side.** Same value. It is not
  a highlight, not an underside, not a lit edge.
- Paler areas are allowed where an animal has them — belly, palms, inner thigh
  — but as a gentle shift within the same range, never a different exposure.

---

A flat 2D hand-painted texture atlas for a very low-poly PS1-era ogre,
1254x1254, painted directly over the supplied UV colour-key layout. This is a UV
sheet, NOT a 3D render, NOT a character illustration, NOT a poster. No
perspective, no drop shadow, no background scene, no ground behind the pieces,
and NO border, frame, banner, label or divider anywhere on the sheet.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT — THE MOST BROKEN RULE ON THIS
SHEET. Every solid colour block in the reference is a REGION ID marking which
piece of the ogre goes where. NOT ONE of them is a colour this creature is made
of. The orange block is not an orange chest. The green blocks are not green
legs. The red block is not a red head.

Decide the palette from the SUBJECT block ALONE, before you paint: pick three or
four tones and paint the ENTIRE sheet using only those. Then check every region
against the block it replaced — if they resemble each other, that region is
wrong and must be repainted.

HOW THE SHEET IS ARRANGED — read this once and it explains the whole thing. The
ogre has been cut into ten flat pieces, each drawn FLAT-ON, as its own
silhouette, with no shading trick and nothing in perspective. The sheet has
three columns:

    LEFT column .... the ogre from the FRONT, head at the top, then chest,
                     then legs
    MIDDLE column .. the ogre from the BACK, chest then legs, with one narrow
                     strip under them
    RIGHT column ... the arm, and the small parts below it

REGION KEY (by position — ignore what colour each block is):

LEFT COLUMN, top to bottom:

- BROAD WEDGE at the very top, with a point at its left end and a lobe filling
  its right-hand half ......................... the HEAD (see THE HEAD).
- TALL VEST-SHAPED BLOCK, with a small hook at each top corner, a scooped neck
  and a V at the bottom ....................... the CHEST AND BELLY, from the
  front. The two hooks are the TOPS OF THE SHOULDERS, folded up out of the
  front; the V is the groin.
- TWO LEGS JOINED AT THE TOP, with a gap between them ....... the LEGS FROM THE
  FRONT: hips at the top, ankles at the bottom, painted as a matching pair.

MIDDLE COLUMN, top to bottom:

- PLAIN ROUNDED RECTANGLE ................. the BACK, shoulders to buttocks. The
  plainest region on the sheet and the largest uninterrupted stretch of hide.
- TROUSER SHAPE ........................... the LEGS FROM BEHIND: buttocks and
  hamstrings at the top, calves and heels at the bottom.
- NARROW DIAGONAL STRIP at the bottom, running down to the left ..... the FRONT
  OF THE ARM (see THE ARM). Shoulder at the top, wrist at the bottom.

RIGHT COLUMN, top to bottom:

- LARGE NOTCHED LIMB SHAPE at the top, heavy and rounded, with a ragged
  right-hand edge ............................. the OUTSIDE OF THE ARM (see THE
  ARM): shoulder and deltoid at the top, elbow at the middle, wrist at the
  bottom. The ragged edge is where the front of the arm was taken out into its
  own strip; it is not a shape, it is a join.
- NARROWER LIMB SHAPE below it, with a flat wing at its top ..... the INSIDE OF
  THE ARM. The wing is the armpit.
- SMALL FLAT HEXAGON ...................... the FOOT SEEN FROM ABOVE (see THE
  FOOT).
- SMALL UPRIGHT SHAPE beside the foot ..... the BACK OF THE HAND. Knuckles at
  the top, fingertips at the bottom.
- THREE SMALL SHAPES IN A ROW at the very bottom ... the PALM (left), the OUTER
  EDGE OF THE HAND (middle) and the INNER EDGE (right). All three are the same
  hand; see THE HAND.

EVERY REGION IS FILLED EDGE TO EDGE AND A LITTLE PAST IT. No white inside a
block, no vignette, no soft fade at a block's border: a body has no edges, and
where a block ends the skin carries on onto the next one.

WHAT IS PAINTED ONCE AND SEEN TWICE, which decides how to compose three of the
regions:

- The HEAD is drawn in profile and that one profile is painted onto BOTH sides
  of the head, mirrored. One eye, one ear, one cheek — and the ogre gets two.
  Never draw two eyes on the head block.
- The ARM, the HAND and the FOOT are each drawn once and worn by BOTH sides of
  the body. Whatever scar, brand or marking goes on the arm appears on both
  arms, so it has to be something that reads as being on both — not "a bandage
  on the left arm".
- The two LEGS in a leg block are separate pieces of the sheet and are painted
  separately, but they are the same animal's legs: paint them as a matching
  pair, not as two different legs.

THE HEAD — the broad wedge in the top right:
Read the LEFT two thirds as a head seen from the SIDE, facing right: the back of
the skull is the left point, the crown and brow run along the top edge, the
cheek fills the middle, and the jaw hangs down at the bottom.

- Put the EYE high in the middle third, under the brow. ONE eye.
- The ear, if this ogre has one, sits behind and below the eye.
- The bottom-left corner is the neck, where the head meets the shoulders. It is
  hidden — let the skin run off it.
- THE LOBE FILLING THE RIGHT-HAND HALF IS THE FRONT OF THE MUZZLE, laid flat.
  It is the face seen head-on, folded down its own centre line, so it is HALF a
  face: the edge where it joins the profile is the SIDE of the muzzle, and its
  outer edge is the CENTRE of the face — the ridge of the nose, the middle of
  the mouth. Keep it simple and keep it continuous with the profile beside it:
  muzzle hide in the same tone, ONE nostril set HIGH and WIDE toward the outer
  edge, the mouth line running along the bottom, tusks growing up from it in
  warm cream. Do not draw a whole face in the lobe and do not leave it blank —
  it is the single largest piece of the ogre's face and it used to get nothing.

WHAT AN OGRE'S FACE IS, AND WHAT IT KEEPS COMING BACK AS. Asked for a low-poly
monster head, a generator draws a RODENT: a long tapering snout with a small
round nose on the tip, big soft eyes, a short upper lip, buck teeth. That is a
gerbil, and it is wrong every time. An ogre's head is BRUTISH and HEAVY:

- A BROAD, FLAT, BLUNT face. No snout. Nothing tapers to a point. The front of
  the face is a wide slab, not a nose on the end of a tube.
- A heavy shelf of BROW hanging over small, deep-set, mean little eyes. The eye
  should look sunk in shadow, not large and wet.
- A wide flat NOSE, more ape than rodent, with big nostrils set HIGH on the face
  and far apart — never a small round button on the tip of a muzzle.
- A massive UNDERSHOT lower jaw, wider than the skull above it, with heavy
  jowls and slabs of cheek. The lower tusks come up past the upper lip.
- Thick, coarse, wrinkled, leathery hide. Creases at the brow, the jowls and the
  corners of the mouth.
- NO whiskers, no buck teeth, no soft fur, no cute proportions, no big round
  eyes, no pointed snout, no muzzle that narrows toward the front.

THE FOOT — the small flat hexagon in the lower right:
It is the foot seen from DIRECTLY ABOVE, lying flat, and every edge of the block
is a real part of it:

    RIGHT end (the WIDE end) ... the TOES. All of them, spread across the full
                                height of that end — four or five short fat
                                toes, splayed, each with a thick blunt nail.
                                Draw them as separate toes with dark creases
                                between them; a plain rounded end reads as a
                                club.
    LEFT end (the POINT) ...... the HEEL.
    the middle .................. the instep, about a third in from the left is
                                the ankle.
    the TOP edge ................ the INNER side of the foot — the big-toe side,
                                the one nearest the other foot. The biggest toe
                                goes in the TOP-RIGHT corner.
    the BOTTOM edge ............. the OUTER side, the little-toe side. The
                                smallest toe goes in the BOTTOM-RIGHT corner.

Paint the TOP of the foot: tendons fanning from the ankle to the toes, dirt in
the creases, thick nails. **The sole is never seen and shares this same paint**,
so do not draw a sole, a footprint, a pad or a heel print — anything that reads
as underneath will appear on top.

THE ARM — three pieces, and they are ONE ARM:
The arm wraps a corner, so it is drawn in three strips that meet edge to edge:
the OUTSIDE (the big notched shape, right column), the FRONT (the narrow
diagonal strip at the bottom of the middle column) and the INSIDE (below the
outside). Read them as one limb cut open and laid flat.

- Paint all three in THE SAME SKIN at THE SAME VALUE. The inner one is not a
  pale underside and not a highlight; the front one is not a lit edge. Painted
  lighter they read as strip lamps down the ogre's ribs.
- Shoulder at the TOP of each, wrist at the BOTTOM of each. Keep the elbow at
  the same height in all three.
- The outside carries whatever the arm has — veins, scars, mottling. The front
  and inside are quieter, same colour.

THE HAND — four pieces, and they are ONE HAND:
The back of the hand, the palm, and the two narrow edge strips between them.
Knuckles and wrist at the TOP of every piece, fingertips at the BOTTOM.

- The back of the hand gets the knuckles, the tendons and the nails.
- The palm gets pads and creases, a shade pinker but the SAME VALUE.
- The two edge strips are the sides of the hand — the thumb side and the little
  finger side. Plain skin, continuous with the two big pieces beside them.
- Match all four to the bottom of the arm blocks. A hand painted lighter than
  its own wrist reads as a glove.

THE BODY — the four big blocks:
This is hide, not armour and not cloth. Paint it as SKIN with the muscle and the
weight painted INTO it:

- Light it from ABOVE: a touch brighter along the tops of the shoulders, the
  chest and the thighs; darker under the belly, under the buttocks and in the
  crease behind the knee.
- Belly, chest and back want broad, soft tonal blocks — no hard outlines, no
  cel-shaded rim lines, nothing that has to line up with a shape.
- Scars, old wounds, warts, boils, mottling, dirt and grime, sunburn across the
  shoulders, a paler underbelly: all good, all broad.

WHAT THE OGRE WEARS, and the three places it has to line up. There is no
separate clothing on this model — a strap or a wrap is painted into the skin —
so anything worn crosses from one block to another and has to MEET:

1. THE CHEST STRAP. If it crosses the chest it must leave the LEFT edge of the
   front block at exactly the height it enters the LEFT edge of the back block,
   and the same on the right. Easiest way to be sure: run it level, or run it
   diagonally on the front and continue that same diagonal, at the same height
   at the edges, across the back. A strap that stops at the edge of one block is
   a strap that is cut in half on the model.
2. THE WAIST WRAP. It is not a hem at the bottom of the torso blocks: it
   CONTINUES onto the leg blocks. Draw the wrap across the bottom of the front
   block AND across the top of the front-leg block, same colour, same height,
   same width — and the same across the back pair. The V at the bottom of the
   front block is the front panel of the loincloth; carry it down onto the top
   of the leg block so it hangs over the thighs instead of stopping dead at the
   waist.
3. THE LEG BLOCKS meet each other at the ankles and at the hips; keep the tone
   the same where they do.

SHADING, because this is a PS1-era game texture:
Paint the light INTO the texture — a lit shoulder, a shaded gut, a dirty knee.
Keep it broad and flat: no photographic skin pores, no specular sheen, no
gradients so smooth they band at 256 pixels. Read the whole sheet at a quarter
size and every region should still be legible as hide, hair or horn.

SUBJECT:
A big, filthy, slab-muscled ogre. Grey-green hide going yellow-grey across the
belly and the palms, blotched with darker moss-green mottling on the shoulders,
the back and the outsides of the arms and legs. Old pink scars across the chest
and knuckles, grime worked into the knees, the elbows and the soles. A wide
band of stiff brown hide wrapped at the waist and hanging over the thighs, tied
at the front V, with one dark leather strap crossing the chest and the same
strap continuing across the back. Thick cream-yellow nails on the fingers and
toes, two cream tusks growing up from the jaw, a small sunken eye under a heavy
brow, and a scalp a shade darker and dirtier than the rest of him.
