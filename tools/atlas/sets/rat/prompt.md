# Rat-atlas generation prompt

The Blockbench rat (`MMO/3d/Mobs/Rat.fbx`), re-cut by `Mobs/Dragon/work/split-ratwolf.mjs`
into named half-body parts and PROJECTED:

    pnpm -F playground unwrap-weapon --recipe rat --islands

**Hand the generator `tools/atlas/sets/rat/key-labelled.png`.** Every part is HALF the
animal seen from its side (front at the RIGHT), worn on both sides. The eye is painted at its mark.

    node tools/atlas/import-atlas.mjs --set rat --theme <theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (BODY, HEAD, TAIL, LEG-FRONT, LEG-BACK, CHEST, RUMP, BACK TOP, HEAD TOP, SNOUT FRONT, EAR). They are
instructions for YOU, not artwork: paint straight over them so that not one
letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era GIANT RAT,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration. No perspective, no drop shadow, no
background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.** Small
unlabelled blocks share the colour of a labelled one: they are more of that
same part, paint them the same.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the
SUBJECT block alone.

**ALL 11 BLOCKS MUST BE PAINTED**, edge to edge.

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside HEAD is the EYE, placed where the real animal's eye is. Paint the eye exactly there and exactly that big — the mark's centre is the pupil's centre — and paint over the mark itself (no white ring may survive). It must read clearly at game distance: a DARK PUPIL, the SUBJECT's eye colour around it, and a LIGHT rim (a pale lid or ring) round the outside, sharp-edged, never a smudge or a dot lost in the fur. Painted once, it is worn on both sides. No other eye anywhere on the sheet — not on HEAD TOP, SNOUT FRONT or EAR.

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
  at the LEFT, the EYE at its mark (high on the side, about halfway between nose and ear), a mouth line low on the muzzle.
- LEG-FRONT and LEG-BACK — a fore leg and a hind leg from outside: the
  SHOULDER / HIP at the TOP, the PAW at the BOTTOM with claws in the lowest
  fifth.
- TAIL — the long thin block: a naked scaly rat tail, base at the RIGHT, tip at
  the LEFT, ringed with fine scale bands, no fur.
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
  the head, no eye, no face.
- SNOUT FRONT — the very front of the muzzle seen head-on: the nose, the top
  of the lips. Half of it, mirrored. (Too small to letter: the small unlabelled block just under HEAD TOP.)
- EAR — one round rat ear seen from the FRONT: thin, the inside naked
  pink-grey skin, a rim of the coat's fur round the edge. Not a face.

**ONE VALUE RANGE.** BODY, CHEST, RUMP, BACK TOP, HEAD, HEAD TOP and the LEGS are one coat: they meet edge to edge on the animal.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no smooth gradients. At a quarter
size every block must still read as fur.

SUBJECT:
