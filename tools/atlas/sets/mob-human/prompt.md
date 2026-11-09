# Mob-human atlas prompt

The shared UV layout of the older human mobs `mmo/mobs/ghost.glb` and
`mmo/mobs/zombie.glb` (identical TEXCOORD_0 and part ids; the body the
statue-maker freezes for robed priests and wrapped dead). The key is cut from the
models' own UVs by part (TEXCOORD_1 ids), CROPPED to the used corner: the key
square is UV 0..0.6875 on both axes (the rest of the UV square is empty), so an
atlas imported from it fills the top-left 0.6875 of a full sheet. Paste it there
(nearest/area resample to `round(0.6875 * sheet)`) before a material uses it.

Every island is opaque (`transparency: false`): this set is used for carved stone
statues, where a cut would be a hole. The tasset plates (front and back, keyed
2026-11-02 for the Moon-Deep's Hushed) are rasterised from the models' own UVs;
buckle and the chest halo are not keyed (no statue wears them).

    node tools/atlas/import-atlas.mjs --set mob-human --theme <theme> --size <n>

Orientation, measured from the mesh: every body island is UPRIGHT (top of the
island = up on the body). Arms: shoulder at the LEFT end, wrist at the RIGHT.
Hands: wrist at the top, fingers down. The head is ONE band unrolled round the
skull, seam at the back, FACE IN THE MIDDLE of the band (lower two thirds), crown
octagon above it, under-chin octagon below it. The hood is double-walled and both
walls share its two islands: paint it symmetric.

---

The attached image is the UV colour-key layout to paint over.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era character,
1254x1254, painted directly over the supplied UV colour-key layout. This is a UV
sheet, NOT a 3D render, NOT a character illustration, NOT a poster. No
perspective, no drop shadow, no background scene, no mannequin, and NO border,
frame, banner or divider anywhere on the sheet. The white background stays
plain white.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block in the
reference is a REGION ID. NOT ONE of them is a colour of the subject. Replace
each block COMPLETELY, edge to edge, with the subject's material. No region is
cut or left white: fill every coloured region fully.

REGION KEY (by position — ignore what colour each block is):
- Two leg shapes, TOP LEFT, the left (darker) one ... BACK of the legs, waist at
  the top, ankles at the bottom, two legs side by side
- Two leg shapes, top left, the right (brighter) one  FRONT of the legs, same
- Trapezoid, TOP CENTRE ............................. BACK of the robe skirt,
                                                      waist at the top, hem at
                                                      the bottom
- Two hanging panels, top centre-right .............. FRONT of the robe, two
                                                      panels, waist at the top
- Two small shapes, TOP RIGHT ....................... the HOOD (both walls, both
                                                      halves): paint it
                                                      symmetric, folds running
                                                      down, crown at the top
- Torso, MIDDLE LEFT, the left (brighter) one ....... FRONT of the chest, neck
                                                      at the top
- Torso, middle left, the right (darker) one ........ BACK of the chest
- Two tall upright strips, CENTRE, the left (bright)
  one the FRONT, the right (dark) one the BACK ........ the TASSET: a long hanging
                                                      panel of plates over the
                                                      shins, belt at the top,
                                                      hem at the bottom
- Narrow upright sliver, right of the tasset ....... FOOT, side profile
- Cross shape, RIGHT: a wide band with a small
  octagon above and one below ....................... the HEAD. The band is the
                                                      head unrolled all the way
                                                      round: the FACE is in the
                                                      MIDDLE of the band, seen
                                                      straight on (brow, eyes,
                                                      nose, mouth, chin, from top
                                                      to bottom), the sides of
                                                      the head and the ears either
                                                      side, the back of the head
                                                      at both ends. The octagon
                                                      above is the crown, the one
                                                      below is under the chin.
- Long strip, LOWER LEFT, the upper one ............. OUTER side of the arms:
                                                      shoulder at the LEFT end,
                                                      wrist at the RIGHT end. No
                                                      hand on it.
- Long strip, lower left, the lower one ............. INNER side of the arms,
                                                      same ends
- Two narrow slivers, lower centre-left ............. the hand: left one the
                                                      BACK of the hand, right one
                                                      the PALM, wrist at the top,
                                                      fingers pointing DOWN
- Long thin bar, ALONG THE BOTTOM ................... the BELT / sash

Front/back pairs (legs, chest, arms, hand, robe, tasset) must match in value, colour and
band heights at the seams. Left and right legs are mirrored and identical.

SUBJECT:
<theme block>

STYLE: 1998 PSX game texture, painted to be shrunk to 512 pixels: chunky
readable shapes. Hand-painted gouache look with the carved relief's light BAKED
INTO the albedo — soft light from above, painted ambient occlusion in every
groove and fold, highlights on raised edges. Low saturation, slight colour
banding, chunky visible brush strokes. No smooth photographic gradients, no
modern PBR gloss, no clean vector edges, no cel-shaded outlines.

HARD LAYOUT RULES:
1. COVERAGE: fill each region edge to edge. A white gap inside a region is a hole.
2. CONTAINMENT: each piece stays inside its own region; nothing spans two regions.
3. Do not draw in the white background.
4. No text, letters, numbers, logos, watermark, signature, grid or wireframe lines.
