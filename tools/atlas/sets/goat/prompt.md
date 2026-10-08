# Goat-atlas generation prompt

One goat in 9 regions. The source (`MMO/3d/Mobs/Dragon/Mesh_Goat.gltf`) is a
622-triangle mesh whose texture was lost; `work/split-goat.mjs` cuts its near
half into named parts and the unwrap is PROJECTED:

    pnpm -F playground unwrap-weapon --recipe goat --islands

**Hand the generator `tools/atlas/sets/goat/key-labelled.png`, NOT `key.png`.**
Every part is worn on both sides (mirrorCopy). The body pieces are HALF the
animal seen from its side: front at the RIGHT, spine along the TOP edge, belly
along the BOTTOM. HORN and BEARD are optional parts the ubermesh can hide.

    node tools/atlas/import-atlas.mjs --set goat --theme <theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (BODY, LEG-BACK, LEG-FRONT,
NECK, HEAD, TAIL, HORN, EAR, BEARD). They are instructions for YOU, not
artwork: paint straight over them so that not one letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era GOAT,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration of a goat. No perspective, no drop
shadow, no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.**

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the
SUBJECT block alone.

**ALL 9 BLOCKS MUST BE PAINTED**, edge to edge, including the tiny EAR and BEARD blocks.

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside HEAD is the EYE. Paint the eye exactly there, at that size, and paint over the mark itself (no white ring may survive). Painted once, it is worn on both sides. No other eye anywhere on the sheet.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — pale fur and horn are a dirty cream around
#E8DCC0 or darker.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT of
a block. White holes inside a block are gaps in the model: paint around them.

HOW TO READ THE BLOCKS: BODY, NECK, HEAD, TAIL and both LEGS are each HALF the
goat seen from its LEFT SIDE, worn on both sides, mirrored. The FRONT is at the
RIGHT of every block, the TOP is up.

- BODY — the big block at the top-left: the trunk, rump at the LEFT, shoulder
  at the RIGHT, the back along the top edge, the belly along the bottom. The
  ragged points are joins to the legs and neck: plain coat there.
- NECK — the tall zig-zag block: the neck rising from the shoulders (bottom)
  to the head (top); the back of the neck on the left, the throat on the right.
- HEAD — the block beside NECK: the head from the side, the MUZZLE at the
  RIGHT, the narrow lower part is the jaw and throat underneath. A long face,
  a dark nose at the right tip, the mouth line low on the right. The EYE at its mark, with a horizontal bar pupil.
- LEG-BACK and LEG-FRONT — the two tall blocks on the right: a hind leg and a
  fore leg from outside, the HIP / SHOULDER at the TOP, the HOOF at the BOTTOM
  — the lowest tenth is a dark cloven hoof.
- TAIL — a short tail, base at the RIGHT, tip at the LEFT.
- HORN — one long curved ridged horn, base at the LEFT, point at the RIGHT.
- EAR — one ear, the inside darker. BEARD — a tuft of hair hanging down.

**ONE VALUE RANGE.** BODY, NECK, HEAD, TAIL and both LEGS are one coat.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no smooth gradients. At a quarter
size every block must still read as fur or horn.

SUBJECT:
