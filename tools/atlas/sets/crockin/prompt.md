# crockin-atlas generation prompt

CrocKin (Derek's Blockbench model MMO/3d/Mobs/CrocKin.obj, cut by
MMO/3d/Mobs/CrocKin/split-crockin.mjs, which also fits the human body's belt,
buckle, robe and front tasset onto it as optional parts). Swap only the SUBJECT
for a new theme; every theme's SUBJECT must say what the BELT, ROBE and TASSET
are made of (they are drawn on every sheet, whether a look shows them or not).

The cut (2026-10-06, Derek's review): the TORSO is ONE strip unrolled round
the whole body, neck to crotch, so chest plate, flank plate, belt line and mail
skirt paint as continuous bands (separate chest/back/flank/groin views painted
a "girdle" at the crotch and armour that broke at every seam). Upper arm,
forearm, thigh and shin are each unrolled round their own length (one unroll
of a whole limb squeezed the forearm's front into stripes). The snout has no
separate island: its tip folds into the HEAD profile's right edge.

    node tools/atlas/import-atlas.mjs --set crockin --theme <theme> --no-match

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (TORSO, HEAD, HEAD TOP, UNDER
JAW, UPPER ARM, FOREARM, HAND, THIGH, SHIN, FOOT, ROBE FRONT, ROBE BACK,
SHOULDERS TOP, SPINE RIDGE, TASSET FRONT, BUCKLE, CREST, CREST TOP, TAIL,
BELT). They are
instructions for YOU, not artwork: paint straight over them so that not one
letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era CROCODILE-MAN
(a hulking, hunched reptile warrior that walks upright), 1254x1254, painted
directly over the supplied UV layout. This is a UV sheet, NOT a 3D render, NOT
an illustration. No perspective, no drop shadow, no background scene, no border
or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.** Small
unlabelled blocks share the colour of a labelled one: they are more of that
same part, paint them the same.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the
SUBJECT block alone.

**ALL BLOCKS MUST BE PAINTED**, edge to edge, the small ones too.

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside
HEAD is the EYE, on the top of the skull behind the snout. Paint the eye
exactly there and exactly that big, and paint over the mark itself (no white
ring may survive): a raised scaly brow ridge over a slit-pupil reptile eye.
Painted once, it is worn on both sides. No other eye anywhere on the sheet.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — the palest tones are a dirty cream around
#E8DCC0 or a light grey.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT of
a block. White holes inside a block are gaps in the model (where the arms
join): paint around them.

**THE TORSO IS ONE STRIP — THE WHOLE BODY UNROLLED**, like a label peeled off
a bottle: the big orange block at the top-left. Its MIDDLE column is the FRONT
CENTRE of the body (breastbone, belly, the middle of the crotch); left and
right of it are the two sides; its far LEFT and far RIGHT ends are the BACK
CENTRE (the spine), which meet at the back and must match. TOP edge = the neck
and the tops of the shoulders (the pointed lobes at the top are the neck and
the shoulder caps), BOTTOM edge = the crotch and the bottom of the hips. The
BELT sits about two-thirds of the way down, on the top of the hips (below the
narrow waist where the outline pinches in): a breastplate stops well above it. **Everything on the torso runs ACROSS it as continuous horizontal
bands**: a breastplate, a mail skirt, a baldric, the pale belly — one band
goes all the way round, unbroken from end to end, at the same height on both
sides. The pale belly scales are in the MIDDLE (front); the dark armoured back
scutes at both ENDS (back). It is mirror-symmetric about its middle column:
paint nothing one-sided. NO girdle, belt or strap drawn round the crotch.

Every block except the TORSO and the worn pieces is HALF of the creature
(painted once, worn on both sides). Seen from the side, the FRONT is at the
RIGHT.

- HEAD — the long crocodile head from the side: the snout at the RIGHT, the back of the skull at the LEFT, the EYE at its mark. A ragged row of jagged yellowed teeth (#C8B880, never white) along the BOTTOM edge of the snout, the gum line dark red. The teeth and gum line run all the way to the RIGHT edge of the block (the tip of the snout, the nostrils on top of it): ONE mouth, ending at the right edge at the same height — never a second mouth or a face drawn at the tip.
- HEAD TOP — the top of the skull and snout seen from ABOVE, snout pointing RIGHT: bony armoured scutes, no eye, no teeth.
- UNDER JAW — the underside of the jaw and throat seen from below: pale belly scales in rows.
- SHOULDERS TOP — the tops of the hulking shoulders, traps and shoulder caps seen from above: big dark bony scutes (or the top of a pauldron where the SUBJECT puts one).
- SPINE RIDGE — a raised ridge of tall bony dorsal scutes running down the spine, the darkest part of the hide.
- UPPER ARM and FOREARM — each is that piece of the arm UNROLLED round its length: shoulder (resp. elbow) at the TOP, elbow (resp. wrist) at the BOTTOM; the MIDDLE column is the OUTSIDE of the arm, both side edges are the inside of the arm (they meet there). The bottom of UPPER ARM meets the top of FOREARM at the elbow: same scales, same colour. A bracer or band is a horizontal band right across its block.
- HAND — the hand unrolled round its length: wrist at the TOP, knuckles and four hooked dark claws along the BOTTOM edge, the back of the hand in the MIDDLE, the paler palm at both side edges.
- THIGH and SHIN — the leg in two pieces, each UNROLLED round its length like the arm: hip (resp. knee) at the TOP, knee (resp. ankle) at the BOTTOM, the OUTSIDE of the leg in the MIDDLE column, the front and back of the leg either side of it, the inside of the leg at both side edges. A greave or mail band is a horizontal band right across its block, and lines up with the next block at the knee.
- FOOT — the clawed foot seen from above, toes at the RIGHT, dark curved claws.
- CREST — a pharaoh's NEMES headdress worn by the creature, painted as the SUBJECT says, seen from the SIDE (front at the RIGHT, painted once, worn on both sides): the top part is the cloth cap hugging the back of the skull BEHIND the eye (the eye is not under it), the long part hanging down at the right-hand bottom is the LAPPET that falls beside the jaw onto the chest. Bold HORIZONTAL STRIPES run across the whole of it, a plain band along the cap's front (brow) edge. Not skin, not scales.
- CREST TOP — the top of the same cap seen from above (front at the RIGHT): the same stripes and colours, continuing from CREST.
- TAIL — the heavy tail laid flat, its base (at the body) at the TOP, tapering to the tip at the bottom-left; dark scutes along its top edge, paler underneath.
- BELT — the long thin bar: a strap unrolled round the waist; its CENTRE is the front (where the buckle sits), both ENDS meet at the back and must match. Only a few texels tall on the finished sheet: tone, grain, a stitched or riveted edge, nothing fine.
- BUCKLE — the small lime block: a solid belt fitting filling its block corner to corner.
- ROBE FRONT — the two tall panels hanging at the FRONT of the hips, either side of an open gap (the TASSET hangs in the gap). Waist at the TOP, hem at the BOTTOM.
- ROBE BACK — ONE tall panel hanging at the back of the hip beside the tail (worn on both sides, the tail hangs between the two). Same garment as ROBE FRONT: same material, weave, colour and value. Waist at the TOP, hem at the BOTTOM.
- TASSET FRONT — a FLAT HANGING PANEL at the front of the hips between the robe panels, NOT a finger, NOT a bone, NOT a tail: waist at the TOP (a band of fixings matching the belt), hem at the BOTTOM, detail kept vertical and simple.
- **Do not draw the belt or buckle on the robe, the tasset or the torso** — they have their own blocks; and none of the worn pieces is skin: paint them as the SUBJECT says.

**THE FRAYED HEM IS CUT FOR YOU.** The importer tears the bottom of ROBE FRONT,
ROBE BACK and TASSET FRONT itself, in an uneven line. Paint those FULL, right
down to the bottom edge; put the hem treatment (mud, a darker rotted or worn
band, loose threads or split rings) in the bottom fifth, and leave the last
couple of texels plain for the cut to eat. No crisp line across the bottom.

**ONE HIDE.** Every block is the same creature's skin: no block lighter or
darker than the ones it meets, except the pale belly scales where the text
says so.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no smooth gradients. At a quarter
size every block must still read as what it is.

SUBJECT:
