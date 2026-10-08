# Spider-atlas generation prompt

One giant spider in 6 regions. The source (`MMO/3d/Mobs/Dragon/Spder.obj`) is a
504-triangle Maya mesh whose texture was lost; `work/split-spider.mjs` cuts its
near half into named parts and the unwrap is PROJECTED:

    pnpm -F playground unwrap-weapon --recipe spider --islands

**Hand the generator `tools/atlas/sets/spider/key-labelled.png`, NOT `key.png`.**
Every part is a half of the animal and is worn on both sides (mirrorCopy).
ABDOMEN is a side view (front at the RIGHT); HEAD is the half carapace seen
from ABOVE (fangs at the RIGHT, the centre line along its BOTTOM edge); each
leg is a tapered tube laid flat, hip at the TOP, tip at the BOTTOM.

Register, then bake ONLY to look at it — a theme is a texture, not a model:

    node tools/atlas/import-atlas.mjs --set spider --theme <theme>
    pnpm -F playground unwrap-weapon --recipe spider --atlas ../../tools/atlas/out/spider/<theme>/atlas.png --out-mesh <scratch>/Spider-<theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (ABDOMEN, HEAD FANGS,
LEG-FRONT, LEG 2, LEG 3, LEG-BACK). They are instructions for YOU, not artwork:
paint straight over them so that not one letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era GIANT SPIDER,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration of a spider. No perspective, no drop
shadow, no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.**

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
region ID, not a colour this spider is made of. Decide the palette from the
SUBJECT block alone.

**ALL 6 BLOCKS MUST BE PAINTED**, edge to edge, including the thin HEAD block.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — fangs and silk are a dirty cream around
#E8DCC0 or a light grey.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT
of a block: bristles are painted INSIDE a block, never as hairs sticking out
of its edge.

- ABDOMEN — the big block at the TOP-LEFT: the bulbous abdomen seen from its
  LEFT SIDE, worn on both sides mirrored. The REAR (spinnerets) at the LEFT,
  the FRONT at the RIGHT where it narrows to the waist (the ragged points at
  the right are the join — paint them plain). The TOP EDGE is the middle of the
  back and carries the markings the SUBJECT names, running left-right along
  the top third; the BOTTOM EDGE is the middle of the belly, darker and plain.
- HEAD — the thin block at the TOP-RIGHT: HALF of the head-and-thorax shell
  seen from DIRECTLY ABOVE. The FANGS and eyes end at the RIGHT, the waist at
  the LEFT. The BOTTOM EDGE of the block is the centre line of the back (the
  other half is this one mirrored), the TOP EDGE is the outer rim above the
  legs. A cluster of small glowing EYES near the RIGHT end, close to the bottom
  edge; the curved fangs (chelicerae) at the very right end, dark. A shallow
  groove and a few radiating ridges across the carapace. Same chitin as the
  legs.
- LEG-FRONT, LEG 2, LEG 3 and LEG-BACK — the four tall blocks along the bottom:
  each is ONE jointed leg laid out flat, and **the block IS the leg's shape**:
  the HIP at the TOP (the short flared collar), the KNEE where the block steps
  in (about 30-35% down), a second joint where it narrows again (about 55-60%
  down), and the POINT at the BOTTOM is the tip of the leg — painted, not
  white. Joint rings at hip, knee and second joint; the last stretch to the tip
  darker and hooked. The four legs of one side, worn on both sides: they must
  look like the SAME legs, the same colour and value.

**ONE VALUE RANGE.** HEAD and all four LEGS are one chitin; the ABDOMEN may
carry markings but its base chitin matches them.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no specular sheen, no smooth
gradients. At a quarter size every block must still read as chitin and
bristle.

SUBJECT:
