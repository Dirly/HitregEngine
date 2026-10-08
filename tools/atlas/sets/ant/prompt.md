# Ant-atlas generation prompt

One giant ant in 11 regions (a worker, a queen, a soldier and an army ant share them). The source (`MMO/3d/Mobs/Dragon/Mesh_Ant.gltf`) is a
720-triangle mesh whose texture was lost; `work/split-ant.mjs` cuts its near
half into named parts and the unwrap is PROJECTED:

    pnpm -F playground unwrap-weapon --recipe ant --islands

**Hand the generator `tools/atlas/sets/ant/key-labelled.png`, NOT `key.png`.**
Every part is worn on both sides (mirrorCopy). HEAD, THORAX and ABDOMEN are a
HALF of the ant seen from its side: front at the RIGHT, the back along the TOP
edge. Each leg and the antenna is a tapered tube laid flat, root at the TOP,
tip at the BOTTOM.

    node tools/atlas/import-atlas.mjs --set ant --theme <theme>

Swap only the **SUBJECT** block for a new theme.

---

ABSOLUTE RULE, CHECK IT LAST: THE FINISHED SHEET CONTAINS NO TEXT. The
reference has words lettered inside the blocks (ABDOMEN, THORAX, HEAD,
LEG-FRONT, LEG 2, LEG-BACK, ANTENNA, MANDIBLE, QUEEN ABDOMEN, SOLDIER JAW, ARMY JAW). They are instructions for
YOU, not artwork: paint straight over them so that not one letter survives.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era GIANT ANT,
1254x1254, painted directly over the supplied UV layout. This is a UV sheet,
NOT a 3D render, NOT an illustration of an ant. No perspective, no drop shadow,
no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.**

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Decide the palette from the
SUBJECT block alone.

**ALL 11 BLOCKS MUST BE PAINTED**, edge to edge, including the small MANDIBLE and SOLDIER JAW blocks and the ARMY JAW.

**THE EYE IS MARKED ON THE REFERENCE.** The black dot ringed in white inside HEAD is the EYE. Paint the eye exactly there, at that size, and paint over the mark itself (no white ring may survive). Painted once, it is worn on both sides. No other eye anywhere on the sheet.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent.
**Nothing painted may be white** — highlights on chitin are a light grey or a
dirty cream, never white.

**Fill each block edge to edge and a little past it.** Nothing may hang OUT of
a block.

- ABDOMEN — the big block at the TOP-LEFT: the bulbous gaster seen from its
  side, the tip at the LEFT, the waist at the RIGHT. Overlapping bands of
  segment plates running top to bottom, a glossy highlight along the top.
- THORAX — the middle block: the thorax from the side, the head end at the
  RIGHT, segment plates and ridges, sparse bristles.
- HEAD — the block at the TOP-RIGHT: the head from the side, the jaws at the
  RIGHT; a hard glossy shell with a few grooves. One big glossy compound EYE at its mark.
- LEG-FRONT, LEG 2 and LEG-BACK — the three tall blocks: one jointed leg each,
  laid flat, the HIP at the TOP, a joint where the block narrows (about 60%
  down), the FOOT at the BOTTOM. Joint rings at the hip and the narrowing,
  sparse bristles painted INSIDE the block. The three are the same chitin.
- ANTENNA — the tall block beside them: one segmented antenna, base at the TOP,
  tip at the BOTTOM, many thin rings.
- MANDIBLE — the small block: one jaw pincer, serrated inner edge.
- SOLDIER JAW — the small block under it: one HUGE jaw pincer of a soldier,
  base at the LEFT, curved point at the RIGHT, a serrated inner edge; the same
  material as MANDIBLE, heavier.
- ARMY JAW — the long arched block RIGHT of QUEEN ABDOMEN: one ENORMOUS
  stag-beetle pincer of an army ant, seen from ABOVE. Its base (where it
  grows out of the head) is the LEFT end; it arches over and its point is the
  RIGHT end. The TOP edge is the smooth outer curve; the BOTTOM edge is the
  INNER cutting edge, jagged with serrations, and the two prongs hanging down
  from it are its big inner teeth. Heavy armoured chitin, DARKER than the
  body, a hard glossy ridge running along its length, worn paler on the
  teeth and the point. The same material as MANDIBLE, scaled up.
- QUEEN ABDOMEN — the big block in the middle: the same gaster as ABDOMEN but
  swollen huge (a queen's), tip at the LEFT, waist at the RIGHT; the same plates
  and markings, stretched, glossier.

**ONE VALUE RANGE.** HEAD, THORAX, the LEGS and the ANTENNA are one chitin; the
ABDOMEN the same chitin (with the SUBJECT's markings if any).

SHADING, because this is a PS1-era game texture: broad and flat, light from
ABOVE painted in, no photographic detail, no smooth gradients. At a quarter
size every block must still read as chitin.

SUBJECT:
