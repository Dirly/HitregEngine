# Human shoulder-pad atlas prompt

The player's shoulder-pad sheet: ONE ubermesh on the shoulder socket, ten
parts, ten regions. Four exclusive BASES (the pad itself, one shows), an
optional raised RIM plate and an optional leaning ACCENT plate standing at the
pad's neck edge, a FRINGE of crossed cut-out planes along each plate (leaves,
spikes, feathers, fur: every plane of a fringe wears the SAME square), and two
cut-out plume ORNAMENTS. Which pieces go together is the recipe's `rules`,
baked into the model (core `partProblems`).

Regenerate the key and the mesh's UVs (needed whenever the model changes):

    pnpm -F playground unwrap-weapon --recipe human-shoulder

Only the left shoulder is modelled; the game mounts a mirrored copy on the
other arm, so nothing may be one-sided. Generate with **`key-labelled.png`**
attached (plus the matching body sheet); replace only `{subject}`. Save each
sheet as `tools/atlas/art/human-shoulder/<theme>.png`, then:

    node tools/atlas/import-atlas.mjs --set human-shoulder --theme <theme> --slices
    pnpm -F playground weapon-page --recipe human-shoulder --project voxel-demo --model mmo/human-shoulder.glb --themes <theme> …

The sheet ships at 112 texels (109/m, the body's density), shrunk nearest.

---

NO TEXT. NO LETTERS. NO GUIDE MARKS. The reference carries a word on every
region; those words are labels for you and must NOT appear anywhere on the
finished sheet.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era medieval
SHOULDER PAD (pauldron), 1254x1254, painted directly over the supplied UV
colour-key layout. This is a UV sheet, NOT a 3D render, NOT an illustration
of armour. Straight-on, evenly lit, no baked highlights, no directional
shadows, no perspective, no drop shadow, and NO border, frame, label or
divider. The ground around the regions stays pure white. Chunky readable
pixel-art detail: big shapes, strong value contrast, few tones; it is shrunk
to 112 pixels, so fine lines vanish.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
REGION ID. None of them is a colour this gear is made of. Take the palette
from the SUBJECT alone.

Draw each solid piece to FILL its block edge to edge, following its outline
exactly. No white inside a solid block. Nothing painted is white: the
brightest metal or cloth is a light grey or cream with a colour cast.

REGION KEY (by position, ignore each block's colour):

- The four big irregular blocks at the LEFT, two rows of two (BASE1, BASE2
  above, BASE3, BASE4 below): four different SHOULDER PADS, each HALF a pad
  seen from above and in front. The TOP edge is the crest running over the
  top of the shoulder; the BOTTOM edge is the pad's lower rim hanging down
  over the upper arm; the LEFT edge is the end against the neck; the pointed
  RIGHT end is the outer end over the arm. The same painting is worn on the
  front half and the back half of the pad, so keep it symmetric in spirit:
  no emblem that reads backwards. Paint the pad's surface: overlapping lames
  or plates running from the top edge down to the bottom edge, each lame
  overlapping the next from left to right, riveted, a trim band along the
  bottom rim and the right end. The underside of the pad shares this paint,
  so no hole or dark opening anywhere.
  - BASE1: a rounded dome pauldron, three overlapping lames, a rolled edge.
  - BASE2: a heavier layered pauldron, four or five lames, rivets along each.
  - BASE3: a single smooth cap plate with a raised central ridge.
  - BASE4: a pad of the SUBJECT's softer material (quilting, leather or
    wool) with a plate or stitched band across it.
- The two wide trapezoids along the BOTTOM LEFT (RIM, then ACCENT): two flat
  PLATES that stand up at the pad's neck edge, each seen FACE-ON. The flat
  bottom edge is where the plate meets the pad; the narrow top edge with the
  cut corners is its free edge. Painted once, seen from both faces.
  - RIM: an upright raised collar plate, a thick trim band along the top
    edge and down both sloped sides, rivets along the bottom.
  - ACCENT: a decorative flange plate leaning out over the pad: an engraved
    or embossed motif in its centre (symmetric), a trim band round it.
- The two TALL NARROW upright blocks at the TOP RIGHT (ORN, ORN2): ORNAMENT
  CUT-OUTS, each ONE connected SILHOUETTE standing up off the shoulder
  (plumes, long feathers, a horn, a spike, a flame). The BOTTOM EDGE of the
  block is where it is fixed to the pad, so:
  - its BASE is a solid socket or quill cluster sitting ON the bottom edge,
    at the CENTRE of it, and everything grows UP out of that base. Nothing
    floats: no piece that does not connect back to the base.
  - pure white around it and between its parts, and a white margin on the
    left, right and top. Never a filled rectangle or plaque.
  - ORN: a tall single plume or long feather, or one tall spike.
  - ORN2: a spray of two or three swept feathers, horns or blades from the
    one base.
- The two SMALL SQUARES under the ornaments (RIM FRINGE, then ACCENT FRINGE):
  FRINGE CUT-OUTS. Every square is ONE small MOTIF (a leaf cluster, a burst
  of spikes, a tuft of feathers, a tuft of fur) whose HEART sits EXACTLY on
  the CENTRE of the square and whose points RADIATE OUTWARD from that centre
  in every direction, like a star or a rosette seen straight on. It is
  pasted on dozens of crossed planes along the plate, so:
  - the centre of the square is always painted: that is where the motif
    starts.
  - PURE WHITE all round it: a white margin on ALL FOUR sides; no point,
    tip or hair may touch ANY edge of the square. Nothing in the corners.
  - chunky: four to eight thick points, no hairlines; it ends up about ten
    pixels across.
  - RIM FRINGE and ACCENT FRINGE are two different motifs of the same
    outfit.

SUBJECT:
{subject}

FINAL CHECK: no text, no letters, no outlines of the key, no white inside a
solid block, every ornament one silhouette growing from the centre of its
bottom edge with white around it, every fringe square one motif radiating
from its centre with a white margin on all four sides, every region filled in
the SUBJECT's palette, never in its key colour.
