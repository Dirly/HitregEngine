# Armor-atlas generation prompt

Paste the block below into the image generator. Swap only the **SUBJECT** block
to make a new set. Run the result through:

    node tools/atlas/import-atlas.mjs \
      --key <key.png> --art <art.png> \
      --manifest tools/atlas/manifest-layered.json \
      --out tools/atlas/out-<name> --slices

Use `manifest-layered.json`, not `manifest.json` — it is the one where an empty
area on the body, head and gear regions actually cuts a hole. With
`manifest.json` every skin cutout is silently filled over.

**Cut with WHITE, not cyan.** Measured over a whole generated sheet: zero cyan
pixels out of 1.57M, at any threshold. Generators simply do not produce it, so
every cyan instruction was dead weight. They leave white readily, and the
importer treats border-connected white on a transparency island exactly like
cyan (`hole = transparency && (cyan || bg)`). Cyan still works if it ever
appears; white is what to ask for.

**The hood's inside shares its region.** The hood is double-walled, and both
walls plus its left and right halves are mapped onto the one band — so anything
painted there lands four times. That is why hoods used to come back apparently
showing their own lining. It is fine as long as nothing asymmetric is painted;
the HOOD section states the rules.

**The head is one region now.** It used to be two — a front-of-face shield and a
mirrored side-of-skull blob — and no generator ever managed to relate them, so
every set came back with one wide banner smeared across both. The head is now a
single cylindrical band: the whole head unrolled, seam at the back, face in the
middle. Everything the old prompt said about "two head regions", "never span the
gutter" and "never stretch the face" is gone, and several of those instructions
are now actively wrong — a stretched, unwrapped, edge-to-edge face is exactly
what this layout wants.

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
- Wide short band, TOP CENTRE ............ HOOD (see HOOD)
- Pentagon, TOP RIGHT .................... SHOULDER PADS, one region serving
                                           both shoulders, keep it symmetrical
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
- Large wide band, BOTTOM RIGHT .......... THE WHOLE HEAD (see HEAD BAND)
- Darker panel INSIDE that band, centred . THE FACE (see HEAD BAND)

THE TAN BAND IS THE ENTIRE HEAD, UNROLLED — READ THIS TWICE:
The large wide band across the bottom right is the whole head — face, both ears,
and the back of the skull — peeled off and laid out flat, like a paper label
unrolled from a bottle. It is ONE continuous surface. Read it left to right:

    far LEFT edge ....... the BACK of the skull, on its centre line
    a quarter in ........ the EAR and temple
    the CENTRE .......... the FACE. Nose and mouth sit exactly on this line
    three quarters in ... the OTHER ear and temple
    far RIGHT edge ...... the BACK of the skull again, same centre line

THE TWO ENDS ARE THE SAME SEAM. When the band wraps around the head, its left
edge meets its right edge at the back of the skull. Whatever touches the left
edge must match the right edge in value, colour and material, or a bright line
appears down the back of the head.

The TOP edge of the band is the CROWN of the head. The BOTTOM edge is the JAW
and the neck.

THE DARKER PANEL IN THE MIDDLE OF THE BAND IS THE FACE, and it is where every
facial feature goes. It covers the front of the head from cheekbone to
cheekbone. Nothing outside it is face: to its left and right are the temples,
the ears and the sides of the skull.

THE FACE PANEL IS VERY NEARLY SQUARE AND IS BARELY STRETCHED — about 1.14x
wider than life. Paint the face at NORMAL HUMAN PROPORTIONS inside it. Do NOT
spread the features out to fill the band; the band is wide because it wraps the
whole skull, not because the face is wide.

MEASURED FEATURE PLACEMENT, as a percentage across the FACE PANEL (0% is its
left edge, 100% its right edge). These come from the model's own geometry, so
they land on the mesh correctly:

    pupils / centres of the eyes ....... 30% and 70%
    inner corners of the eyes .......... 39% and 61%
    outer corners of the eyes .......... 18% and 82%
    sides of the nose .................. 45% and 55%
    corners of the mouth ............... 36% and 64%
    centre line of nose and mouth ...... 50%

Vertically the eyes sit a little above the middle of the panel, the nose base
around two thirds down, the mouth about four fifths down.

Only the WRAP is stretched: outside the face panel, going towards each ear, the
sheet spreads out. Straps, buckles and plates that live on the sides are wider
there than they look on a model. Inside the face panel, nothing is.

ANY BAND THAT RUNS AROUND THE HEAD — a brow rim, a helmet band, a circlet, a
strap, a fur trim — is a straight HORIZONTAL STRIPE at a constant height,
crossing the FACE PANEL and the band on both sides of it without a step. The
face panel and the band around it are ONE surface: a strap must meet the panel's
edge at exactly the same height and thickness on both sides, or it breaks on the
model. This is the single most valuable thing to get right on this sheet, and on
this layout it is easy.

ONE face, in the face panel, once. Never a face at each end of the band. Never
three faces. Never a second face out on the sides. Never a small mask floating
in the middle with empty space around it. Never a mirror seam down the centre — the two halves are NOT a mirrored pair, so a
one-sided detail (a single cheek plate, one buckled strap, one dented eye slit)
appears on that side only, which is correct and wanted.

WHAT THIS SET PUTS ON THE HEAD:
- No head covering at all -> leave the WHOLE band plain WHITE. The head comes
  from the skin sheet underneath.
- A full helm or full-face mask -> painted edge to edge across the whole band,
  no white left anywhere. The back of the skull gets the back of the helmet.
- A half-mask or visor -> paint the upper part of the band across its full
  width and leave the jaw WHITE as a strip along the bottom edge.
- An open-faced helm -> paint the helm across the band and leave the face
  opening WHITE at the centre. Open it downward to the bottom edge of the band
  so the white has a way out; a white oval ringed by helmet cannot be cut.
- A hood worn over a bare head -> the hood is its own region; leave this band
  white.
- Eye slits, breathing holes and mouth grilles are painted as dark recesses in
  the metal, NOT cut. The mask is solid.

THE IRON ORNAMENT — THE ONE REGION YOU MUST *NOT* FILL:
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

SKIN — EMPTY WHITE IS THE ONLY WAY SKIN EVER APPEARS:
There is no skin painted on this sheet. Skin comes from a separate sheet
underneath, and it can ONLY show through where you leave the area EMPTY — plain
white. If you paint a region edge to edge, that body part is fully clothed. This
is the single most-missed rule on this sheet — most sets should have some empty
white somewhere.
- Go region by region and ask "does THIS set actually cover this?" If it does
  not, leave that area plain white — not a guess at flesh tone, not a darker
  version of the garment. Open it out to the edge of the region so the white
  connects to the background.
- HEAD BAND: see WHAT THIS SET PUTS ON THE HEAD above.
- CHEST / ARMS / HANDS / TROUSERS: below a short sleeve, at an open collar, on
  an ungloved hand, on a bare shin — leave it white, cut in from the edge.
- Paint a deliberate edge where cloth meets skin: a darker 1-2 pixel line of
  rolled fabric or stitching, with the garment's shadow falling just below it.

IF A PIECE ISN'T IN THE SET, LEAVE THE WHOLE REGION WHITE:
Never fill a region with a vague dark smear to "use it up". A muddy blob is
worse than nothing — it renders as a brown smudge on the model. If this set has
no shoulder pads, no hood, no buckle, no ornament, no belt, or the piece is too
small to draw legibly at that region's size, leave that ENTIRE region plain
white and move on. An empty region is correct and costs nothing.

HOOD — ONE REGION, AND THE INSIDE SHARES IT:
The wide short band at the top centre is the hood, unrolled flat. Read it left
to right:

    left edge ....... the BRIM — the front opening that frames the face
    right edge ...... the BACK of the hood, on its centre line
    top edge ........ the CROWN
    bottom edge ..... the NECK

So the hem, trim or stitching goes down the LEFT EDGE, running vertically, and
the cloth runs back and up from there. Folds fall from the crown toward the
brim, with visible weave and wear.

THE HOOD'S INNER LINING IS MAPPED ONTO THESE SAME PIXELS, and so are its left
and right halves. Everything painted here therefore lands FOUR times: on both
sides of the hood, and on the inside as well as the outside. A hood is the same
cloth inside and out, so that is fine — but it sets three rules:
- No one-off asymmetric detail. A single buckle, one torn corner or a stain on
  one side would appear on both sides at once.
- Anything that runs around the hood is a HORIZONTAL stripe at a constant
  height, edge to edge.
- A hem or trim band at the LEFT EDGE is good and wanted. The brim is exactly
  where the inside and the outside of real cloth meet, so it reading on both
  faces is correct rather than a mistake.
Do NOT paint an opening, a dark cavity, or a "lining" as a drawn feature. The
inside of the hood is real geometry and it is already handled; drawing one just
puts a second, fake opening on the model.

HOOD — MATERIAL FOLLOWS THE SUBJECT:
The hood is made of whatever the SUBJECT block says the set is made of, and it
must read as part of the same outfit — same cloth, same palette, same wear and
dirt as the robe it hangs behind. Mid-value, lit from above, with visible weave
and folds. Its marker on the reference is BLACK; that is a label, not the
colour of the cloth, and a black hood is the single most common way this region
comes back wrong.

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

SUBJECT (swap this block to test other sets):
A plague-order executioner's kit — blackened steel over dark boiled leather, a
riveted FULL-FACE STEEL MASK with narrow horizontal eye slits and a grille over
the mouth, heavy iron shoulders, an iron-buckled belt, a ragged canvas tasset,
worn leather shoes, and a tarnished iron ornament.

STYLE: 1998 PSX / Dreamcast game texture. Hand-painted gouache look with ALL
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

- ORNAMENT: see THE IRON ORNAMENT above. Mostly white.
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
as long as its bar, the head covering runs the full width of the head band, and
the ornament is one small thin object floating in a mostly white square.

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
   front/back, hand back/palm, robe front/back, the two tasset bars, and the two
   ENDS of the head band. Same for the wrist cuff, ankle hem and waistline.
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
plain flat tasset, black hood, hood painted the colour of its marker, dark
cavity in the hood, hood opening, hood interior, drawn lining, front view
hood, three-quarter hood, face at both ends of the head band, second face, two
faces, three faces, repeated features, mirror seam down the centre of the head
band, mirrored head halves, small mask floating in empty space, portrait
vignette, muddy blob, featureless brown smear, 3d render, character render,
perspective, mannequin, full body illustration, photorealistic, PBR, glossy,
smooth gradients, blur, depth of field, outline, cel shading, text, letters,
logo, watermark, signature, UV wireframe, straps crossing region edges, detail
spilling between regions, hand on the arm strip, fist at the end of the arm,
fingers on the forearm, gauntlet fingers on the arm sheet, hand drawn
sideways, fingers pointing up, hand rotated to fill its region, foot pointing
left, foot lying flat, cyan artwork, turquoise, verdigris, patina, neon,
oversaturated, garment painted the same colour as the region marker it
replaced, saturated primary colours, flat unmixed hues
