# frogkin-atlas generation prompt

FrogKin (Derek's Blockbench model MMO/3d/Mobs/FrogKin.obj, cut by
MMO/3d/Mobs/FrogKin/split-frogkin.mjs, which also fits the human body's belt,
buckle, robe and tassets onto it as optional parts). Swap only the SUBJECT for
a new theme; every theme's SUBJECT must say what the BELT, ROBE and TASSETS are
made of (they are drawn on every sheet, whether a look shows them or not).
The HEAD is ONE strip round the whole head since 2026-10-06: a side profile
plus a separate mouth-front island painted two lips that never met at the
front of the face (Derek: "the mouth slit does not align on the front").
The TORSO is ONE strip round the whole body, neck to crotch, so armour and the
belly paint as continuous bands (separate chest/back/flank/groin views painted
a "girdle" at the crotch and armour that broke at every seam); forearm,
thigh, shin and hand are each unrolled round their own length; the sloping
upper arm is a flat outside view (unrolled, its front came out striped).

    node tools/atlas/import-atlas.mjs --set frogkin --theme <theme> --no-match
    node ../MMO/3d/Mobs/FrogKin/frog-mouth.mjs --atlas tools/atlas/out/frogkin/<theme>/atlas.png

THE MOUTH IS NOT PAINTED BY THE GENERATOR (round 4, 2026-10-06). After every
import, frog-mouth.mjs draws the lip onto the imported atlas from the head's
own crease geometry (unbroken across the front, ending at the corners); run it
BEFORE baking, every time, for every theme. The prompt below asks for plain
head skin where the mouth goes.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (TORSO, HEAD TOP, THROAT, UPPER
ARM, FOREARM, HAND, THIGH, SHIN, FOOT, BELT, BUCKLE, ROBE FRONT, ROBE BACK,
TASSET FRONT, TASSET BACK, FEATHER 1, FEATHER 2, FEATHER 3). They are
instructions for YOU,
not artwork:
paint straight over them so that not one letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era FROG-MAN
(a squat, pot-bellied swamp frog warrior that walks upright), 1254x1254, painted
directly over the supplied UV layout. This is a UV sheet, NOT a 3D render, NOT
an illustration. No perspective, no drop shadow, no background scene, no border
or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.** Small
unlabelled blocks share the colour of a labelled one: they are more of that
same part, paint them the same.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the
SUBJECT block alone.

**ALL BLOCKS MUST BE PAINTED**, edge to edge, the small ones too.

**THE HEAD IS THE WHOLE HEAD UNROLLED INTO ONE STRIP**, like a label peeled off
a jar: the long red block at the top-right, under HEAD TOP. The FRONT of the face (the tip
of the wide snout) is the exact MIDDLE of the strip, the two sides of the head
run out to the left and right of it, and the BACK of the head is split between
the far LEFT and far RIGHT ends (they meet at the back, so they must match).
The TOP edge is the top of the head, the BOTTOM edge the jaw line over the
throat. It is mirror-symmetric about its middle: paint nothing one-sided.

**THE EYES ARE MARKED ON THE REFERENCE.** The two black dots ringed in white
on the HEAD strip are the two EYES, big bulging frog eyes on the top of the
head, one either side of the middle. Paint each eye exactly there and exactly
that big, and paint over the marks themselves (no white ring may survive): a
domed eye with a horizontal slit pupil. No other eye anywhere on the sheet.

**PAINT NO MOUTH.** The mouth is drawn onto the model afterwards, exactly on
its lip crease. On the HEAD strip paint NO lip line, NO mouth slit, NO teeth
and NO dark or pink band anywhere: the lower part of the strip is plain head
skin running down into the paler jaw, with no line between them.

**THE TORSO IS ONE STRIP — THE WHOLE BODY UNROLLED**, like the head: the big
orange block at the top-left. Its MIDDLE column is the FRONT CENTRE of the body
(throat, the middle of the pot belly, the middle of the crotch); left and right
of it are the two sides; its far LEFT and far RIGHT ends are the BACK CENTRE
(the spine), which meet at the back and must match. TOP edge = the neck and the
tops of the shoulders, BOTTOM edge = the crotch and the underside of the belly.
The BELT sits level round the hips right along the BOTTOM edge of the TORSO
(under the pot belly); the belt itself is its own block, so do NOT draw a belt
on the torso. Below the torso the THIGH block starts — the "pants" region.
**Everything on the torso runs ACROSS it as continuous horizontal bands**: the
pale belly in the MIDDLE (front) grading to the dark warty back at both ENDS,
a breastplate or a scale skirt as one band all the way round, unbroken from
end to end, at the same height on both sides. It is mirror-symmetric about its
middle column: paint nothing one-sided. NO girdle, belt or strap drawn round
the crotch.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — the palest tones are a dirty cream around
#E8DCC0 or a light grey.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT of
a block. White holes inside a block are gaps in the model: paint around them.

Every block except the TORSO, the HEAD strip, HEAD TOP, THROAT and the worn
pieces is HALF of the creature (painted once, worn on both sides). Seen from
the side, the FRONT is at the RIGHT. The worn pieces (BELT, BUCKLE, ROBE, TASSETS) are seen flat from
the front or back, as described below.

- HEAD — the strip described above: the wide flat frog head all the way round, snout front in the MIDDLE, the EYES at their marks, NO mouth (see above).
- HEAD TOP — the block centred ABOVE the head strip: the top of the head seen from ABOVE, the snout toward the BOTTOM edge (it sits over the middle of the strip), symmetric left to right: warty skin, the domes of the two eyes' brows, no mouth.
- THROAT — the block centred BELOW the head strip: the throat sac under the jaw, pale, wrinkled, slightly translucent-looking skin, symmetric left to right.
- SHOULDERS — the two small unlabelled magenta blocks: the tops of the shoulders seen from above, the same dark warty back skin.
- UPPER ARM — the upper arm seen flat from OUTSIDE the body (it slopes out from the shoulder): shoulder at the TOP, elbow at the BOTTOM, dark blotched skin, painted once for both sides.
- FOREARM — the forearm UNROLLED round its length: elbow at the TOP, wrist at the BOTTOM; the MIDDLE column is the OUTSIDE of the arm (dark, blotched), both side edges the paler inside (they meet there). A bracer is a horizontal band right across its block.
- HAND — the webbed mitten-like frog hand UNROLLED round its length: wrist at the TOP, the BACK of the hand in the MIDDLE column with four long fingers running straight DOWN it, side by side, ending in round sticky pads along the BOTTOM edge; the paler palm at both side edges. Fingers point DOWN, never sideways or up.
- BELT — the long thin bar along the bottom: a strap unrolled round the waist (it sits UNDER the pot belly); its CENTRE is the front (where the buckle sits), both ENDS meet at the back and must match. Only a few texels tall on the finished sheet: tone, grain, a stitched or tied edge, nothing fine.
- BUCKLE — the small lime block: a solid belt fitting filling its block corner to corner.
- ROBE FRONT — the two tall panels hanging at the FRONT of the hips, either side of an open gap (the front TASSET hangs in the gap). Waist at the TOP, hem at the BOTTOM.
- ROBE BACK — the broad panel hanging at the back of the hips. Same garment as ROBE FRONT: same material, weave, colour and value. Waist at the TOP, hem at the BOTTOM.
- TASSET FRONT / TASSET BACK — two FLAT HANGING PANELS, one at the front of the hips and one at the back, one pair of the same kit, same material and value: NOT fingers, NOT bones, NOT tongues. Waist at the TOP (a band of fixings matching the belt), hem at the BOTTOM, detail kept vertical and simple.
- **Do not draw the belt or buckle on the robe, the tassets or the torso** — they have their own blocks; and none of the worn pieces is skin: paint them as the SUBJECT says.
- THIGH and SHIN — the leg in two pieces, each UNROLLED round its length like the arm: hip (resp. knee) at the TOP, knee (resp. ankle) at the BOTTOM, the OUTSIDE of the leg in the MIDDLE column (dark, blotched bands), the paler inside at both side edges. A shin guard is a horizontal band right across its block and lines up with THIGH at the knee.
- FEATHER 1 to FEATHER 5 — the five small blocks at the right (the two small unlabelled blocks under FEATHER 2 and FEATHER 3, pink and mint, are FEATHER 4 and FEATHER 5): a PLUMAGE of five separate feathers worn on top of the head. Each block is ONE feather: quill at the BOTTOM end of the block, tip at the TOP end, FOLLOWING the block's own bend so the whole feather stays inside its block, as long as the block, on PURE WHITE with white either side of it. Everything white is cut away, so each feather's own edge is its silhouette: crisp feather shapes with a few notched barbs, never filled rectangles. FEATHERS 1-3 are long flight feathers; FEATHERS 4-5 short, fluffier plumes. Paint them as the SUBJECT says.
- FOOT — the webbed foot seen from above, toes at the RIGHT, webbing between long toes.

**THE FRAYED HEM IS CUT FOR YOU.** The importer tears the bottom of ROBE FRONT,
ROBE BACK, TASSET FRONT and TASSET BACK itself, in an uneven line. Paint those
FULL, right down to the bottom edge; put the hem treatment (bog mud, a darker
rotted band, loose threads or reed ends) in the bottom fifth, and leave the
last couple of texels plain for the cut to eat. No crisp line across the bottom.

**ONE HIDE.** Every block is the same creature's skin: no block lighter or
darker than the ones it meets, except the pale belly where the text says so.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no smooth gradients. At a quarter
size every block must still read as what it is.

SUBJECT:
