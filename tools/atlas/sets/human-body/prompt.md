# Human body atlas prompt

The player's BODY sheet (`mmo/human-body.glb`, built by `tools/reskin.mjs`):
the modeller's own UVs on the 256px armor layout. The key is
`tools/atlas/sets/human-body/key.png` (attach it), rasterized from HumanBase.obj's UVs
(both sexes, both accessory sets) plus the old key's unused hood/head/shoulder regions;
regenerate it when the modeller moves islands. The body is headless and has no
skin sheet under it: every garment region is covered, bare hands are painted
skin, and the hood, head band and shoulder regions are unused. Adapted from
`sets/armor/prompt.md` (the older body with a head); the rules that carried
over were paid for there.

    node tools/atlas/import-atlas.mjs --key tools/atlas/sets/human-body/key.png \
      --art tools/atlas/art/human-body/<theme>.png --manifest tools/atlas/sets/human-body/manifest.json \
      --out tools/atlas/out/human-body/<theme>

then `reskin --theme mmo/human-body-<theme>.png=tools/atlas/out/human-body/<theme>/atlas.png`
for every outfit on the page.

---

A flat 2D hand-painted texture atlas for a very low-poly PS1-era character,
1254x1254, painted directly over the supplied UV colour-key layout. This is a UV
sheet, NOT a 3D render, NOT a character illustration, NOT a poster. No
perspective, no drop shadow, no background scene, no mannequin, and NO border,
frame, banner or divider anywhere on the sheet.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT — THE MOST BROKEN RULE ON THIS
SHEET. Every solid colour block in the reference is a REGION ID marking which
piece of gear goes where. NOT ONE of them is a colour this armour is made of.

Decide the set's palette from the SUBJECT block ALONE, before you paint: pick
four or five muted earth tones and paint the ENTIRE sheet using only those. Then
check every region against the block it replaced — if they resemble each other,
that region is wrong and must be repainted.

A leg region marked blue does not make blue trousers. A torso marked red does
not make a red shirt. A hood marked black does not make a black hood. A head
band marked tan does not make tan cloth. Replace each block COMPLETELY.

Regions are identified below by their POSITION and SHAPE. Where two regions form
a pair they are the FRONT and BACK of one part, and the reference marks them as
a lighter and a darker version of the same marker colour.

REGION KEY (by position — ignore what colour each block is):
- Legs, TOP LEFT, the darker of the two .. BACK of the trousers
- Legs, top left, the brighter one ....... FRONT of the trousers
- Wide short band, TOP CENTRE ............ NOT ON THIS BODY: leave it plain WHITE
- Pentagon, TOP RIGHT .................... NOT ON THIS BODY: leave it plain WHITE
- Trapezoid skirt, MIDDLE CENTRE ......... BACK of the robe skirt, one panel
- Split two-panel shape, middle right .... FRONT of the robe, TWO hanging panels
                                           with an open gap between them
- Torso, MIDDLE LEFT, the brighter one ... FRONT of the chest
- Torso, middle left, the darker one ..... BACK of the chest
- TWO narrow bars, centre .. .............. the FRONT and the BACK of ONE tasset
                                           panel, one on each bar. Identical
                                           silhouettes, identical colours.
- Narrow upright sliver, right of those
  bars ................................... SHOE / BOOT, flat SIDE PROFILE, one
                                           region serving both feet. The leg is
                                           UPRIGHT in the island, the foot at
                                           the BOTTOM, the toe pointing DOWN
                                           AND TO THE RIGHT
- Square, FAR RIGHT, below the pentagon .. IRON ORNAMENT (see ORNAMENT)
- Long strip, LOWER LEFT, the upper one .. FRONT / outer side of the arms. The
                                           arm lies ALONG the strip: SHOULDER at
                                           the LEFT end, WRIST at the RIGHT end.
                                           NO HAND (see ARMS AND HANDS)
- Long strip, lower left, the lower one .. BACK / inner side of the arms, same
                                           layout, same ends
- Narrow sliver, LOWER CENTRE, left ...... BACK of the hand, FINGERS DOWN
- Narrow sliver, lower centre, right ..... PALM of the hand, FINGERS DOWN
- Tiny square, BOTTOM LEFT corner ........ BELT BUCKLE, and nothing else
- Long thin bar, ALONG THE BOTTOM ........ BELT STRAP, plain leather
- Large wide band, BOTTOM RIGHT, with the
  darker panel inside it ................. NOT ON THIS BODY (the head is a separate
                                           model): leave it ALL plain WHITE

THE BACK ORNAMENT — THE ONE REGION YOU MUST *NOT* FILL:
It stands up behind the shoulders like a halo. Its BASE is at the BOTTOM-CENTRE
of the square, where it meets the back, and it rises and spreads from there:
nothing floats free of that base.
THIS IS THE EXCEPTION TO THE COVERAGE RULE. Every other region gets filled edge
to edge. This one does not, and filling it is the single most-repeated failure
on this sheet — it comes back as a rusted square plaque with an emblem on it,
every time.

That square is NOT a plaque, NOT a panel, NOT a tile, NOT a backing plate,
NOT a shield. It is a BLANK SHEET OF PAPER on which you draw ONE thin wrought
iron object, floating, with EMPTY WHITE ALL AROUND IT.

- Leave that square WHITE #FFFFFF and draw the ironwork onto that white.
- 60-80% of the square must still be white when you are done.
- The iron is a thin OPEN silhouette: a wire halo, a BROKEN ring, an arc of
  spikes or rays, a fan of iron rods, a low crescent, a pair of horns, a spray
  of nails. Thin bars with daylight between them.
- Every gap between the bars is white, and every gap must have a clear path out
  to the white margin around the design. Nothing enclosed.
- Leave a wide white margin on all four sides. The iron never touches the edge
  of the square.
- If a closed ring is unavoidable, its inner hole must be solid cyan #00FFFF —
  an enclosed white hole cannot be cut and will render as solid iron.
- NO background behind the ironwork. No rust plate, no leather backing, no stone,
  no cloth, no border, no frame, no vignette, no drop shadow. White only.

EVERY BODY REGION IS WORN — NEVER LEAVE ONE WHITE:
The chest, arms, hands, trousers, boots, belt, buckle, robe, tassets and back
ornament are all on every character (the game shows or hides whole pieces
itself). Paint every one of them for this outfit. Only the three regions marked
NOT ON THIS BODY stay plain white. Never fill a region with a vague dark smear:
give each piece real material, trim and wear.

ARMS AND HANDS — THE ARMS STOP AT THE WRIST:
The two long strips are the arm ONLY: shoulder at the left end, elbow in the
middle, wrist at the right end. They do NOT contain a hand, a fist, a gauntlet
cuff wrapped around fingers, or any fingers at all. Ending the strip with a
fist is the most common mistake on this sheet — the hand has its own two
regions and a hand drawn here is painted onto the forearm on the model.
The right end of each strip is a bare WRIST: finish it with a cuff, a strap or
a rolled edge and stop.

THE HANDS HANG WITH THE FINGERS POINTING DOWN:
The two narrow slivers in the lower centre are the hands, and they are NOT
drawn flat like a hand pressed on a table. Each is a hand hanging at rest:
- The WRIST is at the TOP of the sliver. The FINGERTIPS are at the BOTTOM.
- Fingers run vertically DOWN the region, parallel to its long axis.
- Never sideways, never fingers-up, never a hand rotated to fill the region,
  never a fist seen end-on.
- The left sliver is the BACK of the hand: knuckles, tendons, the outside of a
  glove. The right sliver is the PALM: pads, creases, grip leather.
- The two must match in cuff height, colour and material — they are two faces
  of the same hand.

THE BUCKLE IS ITS OWN REGION:
Draw ONE metal buckle, face on, in SOLID OPAQUE METAL, filling the small dark
maroon square almost edge to edge. Do NOT draw a buckle frame around an empty
window — the region IS the buckle, not the hole in it. Nothing empty anywhere
inside the square. If the set has no buckle, leave the whole square white.
The BELT STRAP HAS NO BUCKLE ON IT — the strap is plain leather end to end with
stitching along both long edges and a few punched holes. No second buckle, loop
or clasp anywhere on the strap, and no cut-out eyelets: punched holes are
painted as dark recesses, not cut.

TASSET — MATERIAL FOLLOWS THE SUBJECT:
The tasset is whatever the SUBJECT block says the set is made of, and it must
read as part of the same outfit — same material family, same palette, same wear
and dirt as the robe or skirt it hangs beside. If the set has robes, the tasset
is cut from the same cloth with the same trim and the same hem treatment. If the
set is scale, the tasset is scale. If it is boiled leather, the tasset is boiled
leather. Never a plain flat unrelated slab of colour, and never a material that
appears nowhere else on the sheet.
It hangs, so paint vertical drape whatever it is made of: soft folds or
overlapping plates top to bottom, ambient occlusion in every valley, a frayed,
scalloped or scalloped-metal hem, optional trim near the bottom. Its TOP is
attached to the belt: the top 25% of the region is 100% solid, full width, no
cut and no shaping.

NO SKIN SHEET UNDER THIS BODY — READ THIS:
There is nothing underneath: an area left white inside a garment region is a
HOLE through the character. Every chest, arm, trouser, boot and hand region is
painted edge to edge. Where the outfit leaves skin bare (an ungloved hand, a
bare forearm), PAINT the skin: weathered light-olive, face tone #B98A6A with
shadows #7E5641, the same skin as the head. Only the robe hems, the tasset
hems, the gap between the front robe panels and the back ornament are cut.

SUBJECT:
{subject}

STYLE: 1998 PSX / Dreamcast game texture, painted to be shrunk to 256 pixels: chunky readable shapes. Hand-painted gouache look with ALL
lighting BAKED INTO the albedo — soft light from above and slightly in front,
painted ambient occlusion in every fold and under every strap, painted
highlights on the shoulders, knees and buckle. Muted earthy palette, low
saturation, slight colour banding, chunky visible brush strokes. Painted cloth
weave, scuffed leather, pitted iron with worn edges. No smooth photographic
gradients, no modern PBR gloss, no clean vector edges, no cel-shaded outlines,
no rim lighting.

CUTOUTS — EMPTY MEANS "CUT THIS AWAY":
Leaving an area EMPTY is how a piece gets its silhouette: a frayed hem, an open
gap, a bare arm. Empty means plain WHITE #FFFFFF — just leave the reference's
white background showing. Solid cyan #00FFFF does the same job if you prefer it,
but WHITE IS THE DEFAULT and white is what to use.

THE ONE RULE THAT MAKES A CUT WORK: every empty area must have an unbroken path
of white out to the white background surrounding its region. An empty area
completely ringed by paint is NOT a cut — it stays solid. So cut IN FROM AN EDGE,
never as an island of white in the middle of a painted piece.

- ORNAMENT: see THE BACK ORNAMENT above. Mostly white.
- THE TWO ORANGE BARS: white around and below the tasset silhouette so its hem
  can be shaped and frayed. The two must have the IDENTICAL silhouette, being
  two faces of one flat panel.
- ROBE regions: white around and below the robe silhouette so the hem can be
  torn or scalloped, and white in the OPEN GAP between the two front panels so
  the legs show through. The robe's TOP is attached at the waist: the top 20% of
  each robe region is 100% solid cloth, full width, no cut. The front panels and
  the back skirt must end at the same height.
- The notches between fray teeth are white, cut in from the hem edge.
- NEVER cyan, teal or turquoise as an artwork COLOUR, and no verdigris or
  oxidised copper. If the set has GLOWING details — eyes, runes, embers, gems —
  paint them in pale amber, sickly green or ember-orange. NEVER a white or
  near-white glow: white is the cut colour on this sheet, so a white-hot rune or
  a glowing white eye can be punched out into a hole and lost. Keep any glow
  clearly coloured, and keep the brightest part of it under about 85% value.
- Minimum feature size ~20 pixels. No speckle, no isolated floating scraps.
- Paint the material colour right up to and slightly INTO the white at every cut
  edge, so no soft faded halo ever sits along a silhouette.

SIZE — the most important rule on this sheet:
Draw every piece to FILL ITS OWN REGION and stop there. Do not draw a piece
larger than its region and let it run past the edge; anything outside is
discarded. The tassets are exactly as long as their bars, the belt strap exactly
as long as its bar, and the ornament is one small thin object floating in a mostly white square.

HARD LAYOUT RULES:
1. COVERAGE: fill each garment region edge to edge, EXCEPT where you are
   deliberately cutting a silhouette (a frayed hem, an open gap, bare skin) or
   where the region is unused. THE IRON ORNAMENT IS EXEMPT — it is mostly white
   by design; do not fill it. Never leave a garment half-finished: a stray
   unpainted gap in the MIDDLE of a garment is a hole in it.
2. CONTAINMENT: each piece stays inside its own region. Nothing reaches into a
   neighbouring region, nothing spans two regions.
3. The white background is not a canvas. Do not draw in it, do not connect
   regions, do not treat any region as a frame or edge decoration.
4. SEAMS — keep straps, stripes and trim from crossing region borders. Where a
   band is unavoidable it must sit at the IDENTICAL height, thickness and colour
   on both halves of a pair: trouser front/back, chest front/back, arm
   front/back, hand back/palm, robe front/back, the two tasset bars, and the robe panels. Same for the wrist cuff, ankle hem and waistline.
5. Values and colours must match across every front/back pair — no brightness
   jump at a seam. Left and right legs within a region are mirrored and
   identical, and so are the two robe front panels.
6. No text, no letters, no numbers, no logos, no watermark, no signature, no
   grid or wireframe lines, no labels.

Negative prompt

border, frame, banner, footer, header, divider, horizontal rule, bar across
the image, buckle on the strap, two buckles, buckle frame around a hole, cyan
window, cyan glow, glowing cyan eyes, cyan eyelets, closed ring, solid filled
disc, filled circlet, solid iron disc, ornament filling its square, iron
plaque, backing plate, rusted panel behind the ornament, framed emblem, tile,
vignette, metal tasset on a cloth set, tasset in a material used nowhere else,
plain flat tasset, a face, a head, a hood, skin left white, holes in garments, muddy blob, featureless brown smear, 3d render, character render,
perspective, mannequin, full body illustration, photorealistic, PBR, glossy,
smooth gradients, blur, depth of field, outline, cel shading, text, letters,
logo, watermark, signature, UV wireframe, straps crossing region edges, detail
spilling between regions, hand on the arm strip, fist at the end of the arm,
fingers on the forearm, gauntlet fingers on the arm sheet, hand drawn
sideways, fingers pointing up, hand rotated to fill its region, foot pointing
left, foot lying flat, cyan artwork, turquoise, verdigris, patina, neon,
oversaturated, garment painted the same colour as the region marker it
replaced, saturated primary colours, flat unmixed hues
