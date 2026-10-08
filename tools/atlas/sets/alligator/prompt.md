# Alligator-atlas generation prompt

One alligator in 6 regions (the SAIL is an optional part the ubermesh can hide). The source (`MMO/3d/Mobs/Dragon/Alligator.glb`) is
a 622-triangle obj2gltf shell whose texture was lost; `work/split-gator.mjs`
cuts its near half into named parts and the unwrap is PROJECTED:

    pnpm -F playground unwrap-weapon --recipe alligator --islands

**Hand the generator `tools/atlas/sets/alligator/key-labelled.png`, NOT `key.png`.**
Every part is a HALF of the animal seen from its side and is worn on both
sides (mirrorCopy): front at the RIGHT of every block, back (spine) along the
TOP edge, belly along the BOTTOM edge.

Register, then bake ONLY to look at it — a theme is a texture, not a model:

    node tools/atlas/import-atlas.mjs --set alligator --theme <theme>
    pnpm -F playground unwrap-weapon --recipe alligator --atlas ../../tools/atlas/out/alligator/<theme>/atlas.png --out-mesh <scratch>/Alligator-<theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (HEAD, BODY, TAIL, LEG-FRONT,
LEG-BACK, SAIL). They are instructions for YOU, not artwork: paint straight over
them so that not one letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era ALLIGATOR,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration of an alligator. No perspective, no drop
shadow, no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.**

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
region ID, not a colour this animal is made of. Decide the palette from the
SUBJECT block alone.

**ALL 6 BLOCKS MUST BE PAINTED**, edge to edge.

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside HEAD is the EYE. Paint the eye exactly there, at that size, and paint over the mark itself (no white ring may survive). Painted once, it is worn on both sides. No other eye anywhere on the sheet.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — teeth and pale belly scales are a dirty
cream around #E8DCC0 or darker.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT
of a block. The small white holes inside BODY are gaps in the model (where the
legs join): paint around them.

HOW TO READ EVERY BLOCK: each is HALF the alligator seen from its LEFT SIDE and
is worn on both sides, mirrored. The animal's FRONT is at the RIGHT of every
block. The TOP EDGE of each block is the MIDDLE OF THE BACK (the spine ridge),
the BOTTOM EDGE is the MIDDLE OF THE BELLY. So every block runs, top to bottom:
armoured back -> flank -> pale belly. Nothing that belongs on one side only.

- BODY — the big block in the middle: the trunk from the hips (LEFT end, where
  it breaks into ragged points — those points are the joins to the tail and the
  hind leg, paint them as plain flank) to the shoulders and neck (RIGHT end).
  Top third: rows of raised bony back scutes (osteoderms) in lines running
  left-right. Middle: smaller pebbled flank scales. Bottom fifth: the belly, in
  regular rectangular belly scales, paler.
- TAIL — the long block at the TOP: tail TIP at the LEFT (the thin end), the
  base at the RIGHT where it joins the body (the forked points at the right are
  the join — plain scales there). Along the TOP edge a double row of upright
  saw-tooth scutes, the crest of the tail; flank scales below; a pale belly
  strip along the bottom edge. Same skin and value as BODY.
- HEAD — the block at the BOTTOM-LEFT: the head seen from the side, the neck
  at the LEFT (the straight left edge), the SNOUT TIP at the RIGHT. Top edge the
  top of the skull and snout, bottom edge the underside of the jaw. A long
  jaw line running left-right through the lower third with a ragged row of
  interlocking TEETH along it, the nostril bump at the far right on top, a
  heavy bony brow ridge at about 30% across from the left on the top edge. The EYE sits at its mark under the brow — nowhere else. Leathery armoured
  skin, the same as the body; the throat under the jaw paler.
- LEG-FRONT and LEG-BACK — the two tall blocks on the right: one front leg and
  one hind leg, seen from outside. The SHOULDER/HIP at the TOP, the FOOT at the
  BOTTOM: the lowest fifth is the foot with dark hooked CLAWS on it. Pebbled
  skin, the same value as the body flank, scutes on the outer upper leg.
- SAIL — the block at the BOTTOM-RIGHT, with the spiky top edge: a tall
  SPINOSAURUS-STYLE SAIL standing up from the middle of the back, seen flat
  from the side, front at the RIGHT. Its curved BOTTOM edge is where it grows
  out of the spine (paint it the back's scutes, blending up into the sail).
  Each POINT on the top edge is the tip of one long THIN bony SPINE: paint a NARROW needle-thin spine, a few pixels wide like a fin ray,
  running from the bottom edge straight up to every point, leaning slightly
  to the left, and leathery skin MEMBRANE stretched between the spines,
  darker and thinner-looking, with veins. Painted once and seen from both
  sides. It is the same creature: the same palette as the body.

**ONE VALUE RANGE.** BODY, TAIL, HEAD, both LEGS and the base of the SAIL are one hide: no block
lighter or darker than its partners.

SEAMS THAT HAVE TO LINE UP: the right end of TAIL with the left end of BODY;
the right end of BODY with the left (neck) edge of HEAD; the back crest along
every top edge; the belly along every bottom edge.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in (the back lighter-lit than the belly in shadow), no
photographic detail, no specular sheen, no smooth gradients. At a quarter size
every block must still read as scaly hide.

SUBJECT:
