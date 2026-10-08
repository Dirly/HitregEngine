# Wolf-atlas generation prompt

The Blockbench wolf (`MMO/3d/Mobs/WolfPestilence.obj`), re-cut by `Mobs/Dragon/work/split-ratwolf.mjs`
into named half-body parts and PROJECTED:

    pnpm -F playground unwrap-weapon --recipe wolf --islands

**Hand the generator `tools/atlas/sets/wolf/key-labelled.png`.** Every part is HALF the
animal seen from its side (front at the RIGHT), worn on both sides. The eye is painted at its mark.

    node tools/atlas/import-atlas.mjs --set wolf --theme <theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (BODY, HEAD, TAIL, LEG-FRONT, LEG-BACK, EAR, CHEST, RUMP, BACK TOP, HEAD TOP, SNOUT FRONT). They are
instructions for YOU, not artwork: paint straight over them so that not one
letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era WOLF,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration. No perspective, no drop shadow, no
background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.** Small
unlabelled blocks share the colour of a labelled one: they are more of that
same part, paint them the same.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the
SUBJECT block alone.

**ALL 11 BLOCKS MUST BE PAINTED**, edge to edge.

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside HEAD is the EYE, placed where the real animal's eye is. Paint the eye exactly there — the mark's centre is the pupil's centre — and paint over the mark itself (no white ring may survive). It must read clearly at game distance: a DARK PUPIL, the SUBJECT's eye colour around it, and a LIGHT rim (a pale lid or ring) round the outside, sharp-edged, the whole eye about TWICE the mark's dot across, never a smudge or a dot lost in the fur. Painted once, it is worn on both sides. No other eye anywhere on the sheet — not on HEAD TOP or SNOUT FRONT.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — teeth and pale fur are a dirty cream around
#E8DCC0 or darker.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT of
a block. White holes inside a block are gaps in the model: paint around them.

HOW TO READ EVERY BLOCK: each is HALF the animal seen from its LEFT SIDE, worn
on both sides, mirrored. The FRONT is at the RIGHT of every block. The TOP EDGE
is the middle of the back, the BOTTOM EDGE the middle of the belly.

- BODY — the big block: the trunk, rump at the LEFT, shoulders and neck at the
  RIGHT. The back darker along the top, the belly paler along the bottom.
- HEAD — the head from the side: the MUZZLE and nose at the RIGHT, the cheek
  at the LEFT, the EYE at its mark — high and forward, where the brow meets the top of the muzzle, slanted, under a dark brow — a mouth line low on the muzzle.
- LEG-FRONT and LEG-BACK — a fore leg and a hind leg from outside: the
  SHOULDER / HIP at the TOP, the PAW at the BOTTOM with claws in the lowest
  fifth.
- TAIL — a bushy tail hanging down from the rump: base at the TOP, tip at the
  BOTTOM.
- EAR — one pointed ear, the inside darker.
- CHEST — the animal's chest and the front of the shoulders seen from the
  FRONT: neck at the TOP, between the forelegs at the BOTTOM. Paler fur, as the
  throat and belly.
- RUMP — the back end seen from BEHIND: the tail root at the TOP centre, the
  haunches either side. The coat's colour.
- BACK TOP — the back seen from ABOVE: the spine along one long edge (the
  centre line), the flank along the other; the darker back colour, the
  spine's markings running its length. HALF of the back, worn on both sides.
- HEAD TOP — the top of the head seen from ABOVE: the brow and skull, the
  snout pointing RIGHT; half of it, the centre line along one edge. Same coat as
  the head. HEAD TOP: plain fur, NO eye, NO nose, NO dark spot, no sparks or
  bright flecks (they read as eyes from the front).
- SNOUT FRONT — TWO pieces. The UPPER piece is the FOREHEAD between the eyes,
  seen from the front: plain brow fur, the head's coat — NO nose, NO eye, NO dark
  spot. The LOWER piece is the muzzle tip and chin: ONE dark wet nose at its TOP
  edge only, the chin fur below it (no second nose at the bottom).

**ONE VALUE RANGE.** BODY, CHEST, RUMP, BACK TOP, HEAD, HEAD TOP and the LEGS are one coat: they meet edge to edge on the animal.

**THE CENTRE LINE.** Every block is worn on BOTH sides of the animal, mirrored, so anything on the animal's centre line (the spine, a ridge, a mane crest, a stripe down the back) is painted ONLY on the centre-line block, along its centre-line edge, and NOWHERE else: here that is the TOP edge of BACK TOP (the TOP edge of HEAD TOP on the head). The TOP edge of BODY is NOT the spine — it meets the flank edge of BACK TOP; a spine painted there shows up TWICE on the model, one row on each flank. BODY, CHEST and RUMP carry no spine.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no smooth gradients. At a quarter
size every block must still read as fur.

SUBJECT:
