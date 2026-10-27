# Skeleton-atlas generation prompt

The Risen Bones skeleton (`projects/foundation/source/skeleton/build-skeleton.py` -> `skeleton.obj`), PROJECTED:

    pnpm -F playground unwrap-weapon --recipe skeleton --islands

**Hand the generator `tools/atlas/sets/skeleton/key-labelled.png`.** Limbs, the ribcage half and the pelvis half are
the LEFT side, worn on both sides (mirrored). The skull is one strip round the head, face in the middle.

    node tools/atlas/import-atlas.mjs --set skeleton --theme <theme>

Swap only the **SUBJECT** block for a new theme (moor, kirk, drowned).

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The reference has words lettered inside the
blocks (SKULL, SKULL TOP, SKULL BASE, JAW BONE, SPINE BONE, RIBS SIDE, RIBS FRONT, RIBS BACK, PELVIS BONE, UPPER ARM
BONE, FOREARM BONE, THIGH BONE, SHIN BONE, HAND BONES, FOOT BONES). They are instructions for YOU, not artwork: paint
straight over them so that not one letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era undead SKELETON warrior, 1254x1254, painted directly
over the supplied UV layout. This is a UV sheet, NOT a 3D render, NOT an illustration. No perspective, no drop shadow,
no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.** Small unlabelled blocks share the colour family
of their neighbours: the small pale-green block beside JAW BONE is the COLLAR BONE, the small dark-green block beside
PELVIS BONE is the FRONT of the pelvis. Paint them as bone.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the SUBJECT block alone.

**ALL 17 BLOCKS MUST BE PAINTED**, edge to edge and a little past it. Nothing may hang OUT of a block. White holes
inside a block are gaps in the model: paint around them.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent. **Nothing painted may be white** — the
palest bone is a dirty cream or grey around #D8CCB0 or darker.

EVERY BLOCK IS BONE. One bone material across the whole sheet, the SAME colour and value range on every block (they
meet on the model), with the SUBJECT's grime, stains and growth over it. NO flesh, NO skin, NO cloth, NO armour, NO
fur — this creature is bare bone.

HOW TO READ THE BLOCKS:
- SKULL — the long strip is the whole skull seen all the way round: the FACE in the MIDDLE, the back of the skull at
  BOTH ENDS, the top edge the crown, the bottom edge the jaw line. **THE FACE IS MARKED ON THE REFERENCE**: the two
  black rings are the EYE SOCKETS, the dot below them the NOSE HOLE, the line under that the UPPER TEETH. Paint
  exactly there and paint over the marks: two DEEP BLACK hollow eye sockets about TWICE the ring's size, a
  pin-point of the SUBJECT's eye glow deep in each; a black upside-down-heart nose hole at the dot; a row of square
  cracked teeth along the line, dark gaps between them. Heavy brow ridge over the sockets, sunken temples beside them.
  MENACING: a grinning death's head, never cute, never a cartoon. Only ONE face, in the middle. The ends are plain
  cracked skull.
- SKULL TOP — the top of the skull seen from above, the forehead at the BOTTOM edge: plain cranium with a jagged
  suture crack down the middle. NO face, NO eyes.
- SKULL BASE — the underside of the skull: plain bone, darker. NO face.
- JAW BONE — the lower jaw from the side: a row of square teeth along the TOP edge, the chin at the RIGHT.
- SPINE BONE — the spine from the side, the neck at the TOP: a stack of knobbly vertebrae, a dark gap between each.
- RIBS SIDE, RIBS FRONT, RIBS BACK — the ribcage: five curved ribs running across each block with dark shadowed gaps
  between them. RIBS FRONT carries the flat breastbone down its LEFT edge, RIBS BACK the spine knobs down its RIGHT
  edge.
- PELVIS BONE — the hip bone from the side: a broad curved wing.
- UPPER ARM BONE, FOREARM BONE, THIGH BONE, SHIN BONE — long bones running down the block: a knobbly joint at the TOP
  and BOTTOM ends, a long shaft between them with cracks along it.
- HAND BONES — a bony hand: the palm bones at the TOP, three long jointed claw fingers at the BOTTOM.
- FOOT BONES — a bony foot seen from above: the heel at the LEFT, splayed toe bones at the RIGHT.

SHADING, because this is a PS1-era game texture: broad and flat, light from ABOVE painted in, dark crevices at joints,
no photographic detail, no smooth gradients. At a quarter size every block must still read as old bone. Keep the
value range tame: no block a flat solid colour, no block much lighter or darker than the rest.

SUBJECT:
