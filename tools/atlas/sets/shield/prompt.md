# Shield-atlas generation prompt

The shield sheet. Same pipeline as the longsword (`sets/longsword/prompt.md`):
one modular ubermesh, three shield bodies (round, heater, tower) and two deflectors (the boss on the
face), which the game mixes and matches at runtime. **A shield is ONE body and
at most one deflector**: plain shields wear a boss, an emblem shield goes bare
so the emblem owns the centre. Eight regions: each body has its own FRONT and its own
BACK, and each deflector is a single front.

Regenerate the key and the mesh's UVs (needed whenever the model changes):

    pnpm -F playground unwrap-weapon --recipe shield

Paste the block below into the image generator together with
**`tools/atlas/sets/shield/key-labelled.png`**. Swap only the **SUBJECT** block
to make a new set. Save the result as `tools/atlas/art/shield/<theme>.png`, then
register it and bake it into the mesh:

    node tools/atlas/import-atlas.mjs --set shield --theme <theme> --slices

    pnpm -F playground unwrap-weapon --recipe shield \
      --atlas ../../tools/atlas/out/shield/<theme>/atlas.png

**Nothing cuts.** A shield is solid; every region is filled edge to edge.

**Nothing painted may be white.** The importer floods the ground in from the
sheet's edge through everything brighter than a light grey (`bgLum` 228). A
bright steel rim or a white painted device gets eaten. Keep the brightest
highlight a light grey with a colour cast.

**An emblem theme** (a skull, a crest filling the field) is worn WITHOUT a
deflector: replace the paragraph about the boss in THE FRONTS with "this set is
worn without a boss; the emblem is the centrepiece, big and centred", and give
its items no Deflector part. `art/shield/skull-legendary.png` was made that way.

**Front and back are different things, not one painting twice.** Each piece is
projected straight on from each side, so the FRONT region is the face you see
from in front and the BACK region is the inside you see from behind, the way
you would see it: neither is mirrored.

---

NO TEXT. NO LETTERS. NO GUIDE MARKS. The reference carries a word on every
region; those words are labels for you and must NOT appear anywhere on the
finished sheet.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era shield,
1254x1254, painted directly over the supplied UV colour-key layout. This is a UV
sheet, NOT a 3D render, NOT a shield illustration, NOT a poster. No perspective,
no drop shadow, no background scene, and NO border, frame, banner, label or
divider anywhere on the sheet. The ground around the regions stays pure white.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
REGION ID marking which piece goes where. NOT ONE of them is a colour this
shield is made of. Decide the palette from the SUBJECT block ALONE — four or
five tones for the whole sheet — then check every region against the block it
replaced: if they resemble each other, repaint it.

Draw each piece to FILL its block, edge to edge, following the block's outline
exactly. Leave no white inside a block.

REGION KEY (by position — ignore what colour each block is):

- TALL RECTANGLE, TOP LEFT ........................... the FRONT of the TOWER
  SHIELD, seen from in front (a tall slightly curved board).
- The same tall rectangle, TOP MIDDLE ............... the BACK of the TOWER
  SHIELD, seen from behind.
- HEATER SHAPE, BOTTOM LEFT (flat top, rounded point at the bottom) .. the
  FRONT of the HEATER SHIELD, seen from in front.
- The same heater shape, BOTTOM MIDDLE .............. the BACK of the HEATER
  SHIELD, seen from behind.
- TWELVE-SIDED ROUND SHAPE, TOP RIGHT ............... the FRONT of the ROUND
  SHIELD, seen from in front.
- The same round shape, MIDDLE RIGHT ................ the BACK of the ROUND
  SHIELD, seen from behind.
- SMALL DIAMOND, BOTTOM RIGHT ...................... a pointed pyramid BOSS
  (deflector), seen from in front: four facets meeting at a point in the
  middle.
- SMALL OCTAGON beside it ........................... a domed, stepped BOSS
  (deflector), seen from in front.

THE FRONTS — the tower, the heater and the upper round shape:
The face of the shield. A thick rim band around the whole outline (a metal
edge or a darker border of the same wood), the field inside it, and any device
or painted pattern on the field. A boss MAY be bolted over the MIDDLE of a
front and then hides roughly the central fifth, so keep the device's important
parts away from the exact centre: a device that radiates from the boss, bands
across it or quarters the field works; a single emblem in the middle does not.
Keep the device MIRROR-SYMMETRIC left to right. Light it top-down, a little
brighter toward the top edge.

THE BACKS — the middle column and the lower round shape:
The inside of the same shield. Plain construction, not decoration: planks or
the back of the hide, the inside of the same rim band around the outline, a
horizontal iron or leather strap across the middle and a hand grip, rivet heads
where the boss and the rim are fixed through. Darker and duller than the front,
and in the SAME materials, because it is the same object.

THE DEFLECTORS — the two small shapes at the bottom right:
Each is a metal boss filling its shape. The DIAMOND is a four-sided pyramid:
shade each of its four triangular facets differently (the top two lighter) so
the point reads, and keep the point in the exact centre. The OCTAGON is a dome
seen from in front: a bright raised centre, a darker ring toward the edge, and a
flat flange at the octagon's rim with rivets. Both are the same metal as the
shield's rim, so either one fits either shield.

SHADING, because this is a PS1-era game texture:
Paint the light INTO the texture: a lit edge, a darker recess, a worn corner.
Keep it broad and flat: no photographic gloss, no chrome reflections, no smooth
gradients that band at 256 pixels. Read the whole sheet at a quarter size and
every part should still be legible.

SUBJECT:
A plain, serviceable soldier's shield. Weathered oak planks painted a faded
oxblood red, with a pale ochre band running diagonally across the field on both
the heater and the round shield. Rims and both bosses in dark blackened iron
with worn steel-grey highlights on the raised edges and a row of iron rivets.
The backs are bare dark oak with a black iron strap and a worn leather grip.

FINAL CHECK: no text, no letters, no label words, no guide marks anywhere on the
sheet; no white inside any region; no region painted in its key colour.
