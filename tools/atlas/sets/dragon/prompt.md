# Dragon-atlas generation prompt

One dragon in 10 regions. The source (`MMO/3d/Mobs/Dragon/Mesh_Dragon.gltf`) is
a 1028-triangle mesh whose texture was lost; `work/split-dragon.mjs` cuts its
near half into named parts and the unwrap is PROJECTED:

    pnpm -F playground unwrap-weapon --recipe dragon --islands

**Hand the generator `tools/atlas/sets/dragon/key-labelled.png`, NOT `key.png`.**
Every part is worn on both sides (mirrorCopy). The body pieces are a HALF of
the animal seen from its side: front at the RIGHT, spine along the TOP edge,
belly along the BOTTOM. WING, HORN and SPIKE are optional parts the ubermesh
can hide (a wingless drake).

Register, then bake ONLY to look at it — a theme is a texture, not a model:

    node tools/atlas/import-atlas.mjs --set dragon --theme <theme>
    pnpm -F playground unwrap-weapon --recipe dragon --atlas ../../tools/atlas/out/dragon/<theme>/atlas.png --out-mesh <scratch>/Dragon-<theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (TAIL, WING, BODY, NECK, HEAD,
LEG-FRONT, LEG-BACK, HORN, SPIKE, UNDER JAW). They are instructions for YOU, not
artwork: paint straight over them so that not one letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era DRAGON,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration of a dragon. No perspective, no drop
shadow, no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.**

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
region ID, not a colour this dragon is made of. Decide the palette from the
SUBJECT block alone.

**ALL 10 BLOCKS MUST BE PAINTED**, edge to edge, including the small SPIKE and UNDER JAW blocks.

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside HEAD is the EYE. Paint the eye exactly there, at that size, and paint over the mark itself (no white ring may survive). Painted once, it is worn on both sides. No other eye anywhere on the sheet.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — horns, teeth and claws are a dirty cream
around #E8DCC0 or darker.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT
of a block. The white holes inside BODY are gaps in the model (where the legs
and wings join): paint around them. The ragged points at the ends of BODY,
TAIL and NECK are joins to the next piece: plain scales there.

HOW TO READ THE BODY BLOCKS: TAIL, BODY, NECK and HEAD are each HALF the
dragon seen from its LEFT SIDE, worn on both sides mirrored. The FRONT is at
the RIGHT of every block. The TOP EDGE is the middle of the back (the spine
ridge), the BOTTOM EDGE the middle of the belly. So every block runs, top to
bottom: armoured back -> flank -> belly plates.

- BODY — the wide block in the middle-left: the trunk, hips at the LEFT end,
  shoulders at the RIGHT end. Overlapping scales, a row of ridge scales along
  the top edge, ribbed belly plates along the bottom fifth.
- TAIL — the long block at the TOP-LEFT: the TIP at the LEFT, the base (the
  ragged points) at the RIGHT. A ridge of small spines along the top edge,
  belly plates along the bottom edge.
- NECK — the tall block beside BODY: the neck seen from the side, rising up to
  the head; its TOP-right is where the head attaches, its BOTTOM where it meets
  the shoulders. Ridge scales along the left/top edge (the back of the neck),
  belly plates along the right edge (the throat).
- HEAD — the block at the right with a hooked shape: the head from the side,
  the SNOUT at the RIGHT, the back of the skull at the LEFT, the EYE at its
  mark under a heavy brow ridge. **THE MOUTH IS MARKED: the black line ringed
  in white running back from the snout is the MOUTH LINE.** Paint the lips
  along that line — a dark seam with a short row of fangs hanging down along
  it — and paint over the mark. The hook below it is the LOWER JAW from the
  side: plain scales like the cheek, NO teeth, NO gums, no open mouth. Small
  nostrils at the very right tip, not big holes.
- UNDER JAW — the small block under HEAD: the underside of the jaw and chin
  seen from below, snout at the RIGHT. Plain throat scales the colour of the
  belly plates. No teeth, no mouth, no face.
- LEG-FRONT and LEG-BACK — the two blocks at the BOTTOM-LEFT: a front leg and
  a hind leg, seen from outside. The SHOULDER / HIP at the TOP (the ragged
  points are joins to the body — plain scales), the FOOT at the BOTTOM: the
  lowest fifth is the foot with dark hooked CLAWS.
- WING — the big block at the TOP-RIGHT: one leathery bat-like wing seen flat
  and spread, painted once and seen from both sides. Its ROOT (where it grows
  from the shoulder) is along the BOTTOM edge, its TIP at the TOP-RIGHT corner.
  A thick bony leading arm along the top edge, three or four long finger bones
  fanning from the bottom-left to the top and right edges, and thin leathery
  MEMBRANE stretched between them, darker, veined, a few small torn notches.
- HORN — the long curved block at the bottom-right: one great horn seen from
  the side, the BASE at the LEFT (where it grows from the skull), the POINT at
  the RIGHT. Ridged rings along it, darkening to a sharp tip.
- SPIKE — the small block: one back spike, BASE at the BOTTOM, point at the
  TOP, the same horn material.

**ONE VALUE RANGE.** TAIL, BODY, NECK, HEAD and both LEGS are one hide: no block
lighter or darker than its partners. HORN and SPIKE are one material.

SEAMS THAT HAVE TO LINE UP: tail base to the hip end of BODY; the shoulder end
of BODY to the bottom of NECK; the top of NECK to the back of HEAD; the back
ridge along every top edge; the belly along every bottom edge.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no specular sheen, no smooth
gradients. At a quarter size every block must still read as scale, leather or
horn.

SUBJECT:
