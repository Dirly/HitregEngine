# Trout-atlas generation prompt

One giant trout in 2 regions (the eye painted on the body). The source (`MMO/3d/Mobs/Dragon/Mesh_Trout.gltf`)
is a 268-triangle mesh whose texture was lost; `work/split-trout.mjs` cuts its
near half and the unwrap is PROJECTED:

    pnpm -F playground unwrap-weapon --recipe trout --islands

**Hand the generator `tools/atlas/sets/trout/key-labelled.png`, NOT `key.png`.**
BODY is the fish seen from its side, head at the RIGHT; the five FINS blocks
sit where the fins sit on the fish. Worn on both sides (mirrorCopy).

    node tools/atlas/import-atlas.mjs --set trout --theme <theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (BODY, FINS). They are
instructions for YOU, not artwork: paint straight over them so that not one
letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era GIANT TROUT,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration of a fish. No perspective, no drop
shadow, no background scene, no border or frame.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the
SUBJECT block alone.

**ALL BLOCKS MUST BE PAINTED**, edge to edge: BODY and every orange FINS block (five of them, only one is lettered).

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside BODY is the EYE. Paint the eye exactly there, at that size, and paint over the mark itself (no white ring may survive). Painted once, it is worn on both sides. No other eye anywhere on the sheet.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — the belly is a dirty cream or pale grey,
never white.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT of
a block.

- BODY — the long block at the TOP: the whole fish seen from its LEFT SIDE,
  worn on both sides. The HEAD at the RIGHT (gill cover a curved line about a
  fifth in from the right, the mouth at the far right tip with small hooked
  teeth), the TAIL FIN at the LEFT end (the forked part — paint it as fin rays,
  not scales). The TOP EDGE is the back (darker), the BOTTOM EDGE the belly
  (paler); a lateral line running the length at about half height. The EYE at its mark near the head end.
- FINS — the five orange blocks below BODY: the big triangle is the dorsal fin,
  the small ones the anal, pelvic, pectoral and adipose fins. Each is a thin fin:
  bony rays fanning from its base with translucent-looking membrane between.

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no smooth gradients. At a quarter
size the body must still read as a scaled fish.

SUBJECT:
