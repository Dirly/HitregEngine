# Lion-atlas generation prompt

One lion in 6 regions. The source (`MMO/3d/Mobs/Dragon/Lion.gltf`) is a
1350-triangle mesh whose texture was lost; `work/split-lion.mjs` cuts its
near half into named parts and the unwrap is PROJECTED:

    pnpm -F playground unwrap-weapon --recipe lion --islands

**Hand the generator `tools/atlas/sets/lion/key-labelled.png`, NOT `key.png`.**
Every part is HALF the animal seen from its side and is worn on both sides
(mirrorCopy): front at the RIGHT, spine along the TOP edge, belly along the
BOTTOM. MANE is an optional part: hidden, the same mesh is a lioness.

    node tools/atlas/import-atlas.mjs --set lion --theme <theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (BODY, TAIL, LEG-BACK,
LEG-FRONT, MANE, HEAD). They are instructions for YOU, not artwork: paint
straight over them so that not one letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era LION,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration of a lion. No perspective, no drop
shadow, no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.**

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the
SUBJECT block alone.

**ALL 6 BLOCKS MUST BE PAINTED**, edge to edge.

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside HEAD is the EYE. Paint the eye exactly there, at that size, and paint over the mark itself (no white ring may survive). Painted once, it is worn on both sides. No other eye anywhere on the sheet.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — teeth and pale fur are a dirty cream around
#E8DCC0 or darker.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT
of a block. White holes inside a block are gaps in the model: paint around
them.

HOW TO READ EVERY BLOCK: each is HALF the lion seen from its LEFT SIDE, worn on
both sides, mirrored. The FRONT is at the RIGHT of every block. The TOP EDGE
is the middle of the back, the BOTTOM EDGE the middle of the belly.

- BODY — the big block: the trunk, hips at the LEFT, shoulders at the RIGHT.
  Short coat with the darker back along the top, the paler belly along the
  bottom fifth, faint muscle shading over shoulder and haunch.
- TAIL — the long thin block: the tail, base at the RIGHT, tip at the LEFT,
  ending in a dark tuft at the far LEFT end.
- LEG-BACK and LEG-FRONT — a hind leg and a fore leg seen from outside: the
  HIP / SHOULDER at the TOP, the PAW at the BOTTOM — the lowest fifth is a big
  paw with dark claws. The same coat as the body.
- HEAD — the head from the side: the MUZZLE and nose at the RIGHT, the cheek
  and ear at the LEFT. The muzzle paler, a dark nose, a snarling mouth line with
  bared fangs along the lower right, a heavy brow. One EYE, painted once at its mark (it is worn on both sides).
- MANE — the block beside HEAD: a HALF of the great mane seen from the side,
  framing the face, front at the RIGHT. Thick shaggy locks of hair, darker
  toward the back and the bottom, the top edge the crest of the mane.

**ONE VALUE RANGE.** BODY, TAIL, both LEGS and HEAD are one coat.

**THE CENTRE LINE.** Every block is worn on BOTH sides of the animal, mirrored, so anything on the centre line (the spine, a ridge, a stripe down the back) is painted ONLY hard against the centre-line edge — here the very TOP edge of BODY and of MANE — touching that edge, never a band just below it (a band below the edge shows up TWICE on the model, one row on each flank).

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no smooth gradients. At a quarter
size every block must still read as fur.

SUBJECT:
