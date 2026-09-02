# Armor-atlas generation prompt

Paste the block below into the image generator. Swap only the **SUBJECT** block
to make a new set. Run the result through:

    node tools/atlas/import-atlas.mjs \
      --key <key.png> --art <art.png> \
      --manifest tools/atlas/manifest-layered.json \
      --out tools/atlas/out-<name> --slices

Use `manifest-layered.json`, not `manifest.json` — it is the one where cyan on
the body, head and gear regions actually cuts a hole. With `manifest.json` every
skin cutout is silently filled over.

---

A flat 2D hand-painted texture atlas for a very low-poly PS1-era character,
1254x1254, painted directly over the supplied UV colour-key layout. This is a UV
sheet, NOT a 3D render, NOT a character illustration, NOT a poster. No
perspective, no drop shadow, no background scene, no mannequin, and NO border,
frame, banner or divider anywhere on the sheet.

IMPORTANT — the colours in the reference are REGION IDs, not a palette. Each
solid colour block marks which piece of gear belongs there. Do NOT tint the
artwork with those colours. Replace each block completely. Paired light/dark
colours are the FRONT and BACK of the same part.

REGION KEY:
- Dark navy legs, top left ............ BACK of the trousers
- Bright blue legs, next to it ........ FRONT of the trousers
- Black shape, top centre ............. HOOD (see HOOD)
- Pale pink shape, top centre right ... SHOE, flat SIDE PROFILE, one region
                                        serving both feet, toe pointing right
- Pale periwinkle pentagon, top right . SHOULDER PADS, one region serving both
                                        shoulders, keep it symmetrical
- Dark purple trapezoid, upper right .. BACK of the robe skirt, one solid panel
- Bright violet split shape, far right  FRONT of the robe, TWO hanging panels
                                        with an open gap between them
- Bright red torso, middle left ....... FRONT of the chest
- Dark red torso, beside it ........... BACK of the chest
- Orange bar, centre right ............ FRONT of the tasset panel
- Dark gold bar, beside it ............ BACK of the same tasset panel
- Salmon square, right ................ IRON ORNAMENT
- Bright magenta strip, lower left .... FRONT / outer side of the arms
- Dark purple strip, below it ......... BACK / inner side of the arms
- Bright green sliver, lower centre ... BACK of the hand
- Dark green sliver, beside it ........ PALM of the hand
- Small dark maroon square, bottom left BELT BUCKLE, and nothing else
- Long dark brown bar, along the bottom BELT STRAP, plain leather
- Greyish-tan blob, bottom right ...... SIDE OF THE HEAD (see HEAD)
- Light wheat shield shape, to its
  right, pointed at the top and
  rounded at the bottom ............... FRONT OF THE FACE (see HEAD)

THE HEAD IS TWO SEPARATE REGIONS — READ THIS TWICE:
The head is NOT one wide panel. It is split into a FRONT and a SIDE, and they
are two different shapes sitting next to each other at the bottom right with a
narrow white gutter between them. Nothing may span that gutter. Do not paint one
wide mask across both. Do not treat them as a mirrored pair.

  FRONT OF THE FACE — the light wheat shield shape, TALLER THAN IT IS WIDE:
  A straight-on, face-forward view of the front of the head only. Normal human
  proportions — do NOT stretch it horizontally, do NOT smear features sideways,
  do NOT unwrap or peel it. Paint it exactly as you would a mask seen head on.
  - The pointed top of the shape is the CROWN / hairline. The rounded bottom is
    the CHIN.
  - Nose and mouth sit on the vertical centre line; the two eyes sit either side
    of it at normal spacing, roughly 40% down from the crown.
  - The LEFT and RIGHT edges of this shape are THE EARS. The face stops there.
    Nothing wraps around the sides — the sides are the other region's job.
  - ONE face, centred, filling the shape edge to edge. Never three faces, never
    a small face floating in empty space, never repeated features.

  SIDE OF THE HEAD — the greyish-tan blob to its LEFT:
  A flat side profile of the head, starting AT THE EAR and running back to the
  base of the skull. One region serving BOTH sides of the head, mirrored, so
  keep it free of one-off asymmetric details (a single scar, one buckle, one
  strap end) that would read as duplicated on the other side.
  - The edge of this shape nearest the front region is the EAR LINE — it must
    match the front panel's outer edge in value and material so the seam
    disappears.
  - Whatever the set puts over the ear and temple goes here: helmet cheek plate,
    hood side, wrapped cloth, straps, hair. If nothing covers it, see SKIN.

SKIN — CYAN IS THE ONLY WAY SKIN EVER APPEARS:
There is no skin painted on this sheet. Skin comes from a separate sheet
underneath, and it can ONLY show through where you leave solid cyan #00FFFF.
If you paint a region edge to edge, that body part is fully clothed. This is the
single most-missed rule on this sheet — most sets should have cyan somewhere.
- Go region by region and ask "does THIS set actually cover this?" If it does
  not, that area is solid cyan #00FFFF, not a guess at flesh tone, not a blank,
  not a darker version of the garment.
- FRONT OF THE FACE: no head covering at all -> the WHOLE region is solid cyan.
  A full-face mask -> painted edge to edge, no cyan. A half-mask or visor ->
  paint the upper part, cyan the jaw. Eye slits, breathing holes and mouth
  grilles are painted as dark recesses in the metal, NOT cut with cyan.
- SIDE OF THE HEAD: bare temple and ear -> solid cyan. Covered by helm, hood or
  wrap -> painted.
- CHEST / ARMS / HANDS / TROUSERS: below a short sleeve, at an open collar, on
  an ungloved hand, on a bare shin — solid cyan.
- Paint a deliberate edge where cloth meets skin: a darker 1-2 pixel line of
  rolled fabric or stitching, with the garment's shadow falling just below it.

IF A PIECE ISN'T IN THE SET, CYAN THE WHOLE REGION:
Never fill a region with a vague dark smear to "use it up". A muddy blob is
worse than nothing — it renders as a brown smudge on the model. If this set has
no shoulder pads, no hood, no buckle, no ornament, no belt, or the piece is too
small to draw legibly at that region's size, fill that ENTIRE region with solid
cyan #00FFFF and move on. An empty region is correct and costs nothing.

HOOD — outer surface only:
Draw the hood as a flat SIDE PROFILE of its OUTER cloth surface, seen from the
wearer's left. Never show the inside lining, never the dark cavity where the
face goes, never a view down into the opening, never a front or three-quarter
view. The LEFT edge of the region is the BRIM — the front opening that frames
the face — so put the hem, trim, stitching or fur band there, running vertically
down the left edge. The hood runs back and up from there: crown at the top
right, back of the neck at the bottom right. Fill the whole region with cloth,
lit from above, folds falling from the crown toward the brim. Use a mid-value
cloth with visible folds, not a black one.

THE BUCKLE IS ITS OWN REGION:
Draw ONE metal buckle, face on, in SOLID OPAQUE METAL, filling the small dark
maroon square almost edge to edge. Do NOT draw a buckle frame around a cyan
window — the region IS the buckle, not the hole in it. No cyan anywhere inside
the square. If the set has no buckle, cyan the whole square instead.
The BELT STRAP HAS NO BUCKLE ON IT — the strap is plain leather end to end with
stitching along both long edges and a few punched holes. No second buckle, loop
or clasp anywhere on the strap, and no cyan eyelets: punched holes are painted
as dark recesses, not cut.

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

CUTOUTS — cyan #00FFFF means "cut this away":
- SALMON square: a flat ornamental iron plane standing BEHIND the head and
  spanning the shoulders, seen face on. It does NOT have to be a circle and does
  NOT have to fill the region — most of it should end up cyan. Prefer thin, open
  designs with lots of negative space: a wire halo, a broken ring, an arc of
  spikes or rays, a fan of iron rods, a low crescent. Everything the ornament
  does not occupy — around it, between its rods, inside any ring's hole — is
  solid cyan.
- ORANGE and DARK GOLD bars: cyan around and below the tasset silhouette so its
  hem can be shaped and frayed. The two must have the IDENTICAL silhouette,
  being two faces of one flat panel.
- ROBE regions: cyan around and below the robe silhouette so the hem can be torn
  or scalloped, and cyan the OPEN GAP between the two front panels so the legs
  show through. The robe's TOP is attached at the waist: the top 20% of each
  robe region is 100% solid cloth, full width, no cut. The front panels and the
  back skirt must end at the same height.
- Cyan the GAPS too: the notches between fray teeth are cyan, not white.
- CYAN IS A CUT, NEVER A COLOUR. No cyan, teal or turquoise as artwork anywhere,
  and no verdigris or oxidised copper. If the set has GLOWING details — eyes,
  runes, embers, gems — paint them in pale amber, bone-white, sickly green or
  ember-orange. A cyan glow is punched out into a hole and lost.
- Minimum feature size ~20 pixels. No speckle, no isolated floating scraps.
- Paint the material colour right up to and slightly INTO the cyan at every cut
  edge, so no unpainted gap ever touches a silhouette.

SIZE — the most important rule on this sheet:
Draw every piece to FILL ITS OWN REGION and stop there. Do not draw a piece
larger than its region and let it run past the edge; anything outside is
discarded. The tassets are exactly as long as their bars, the belt strap exactly
as long as its bar, the face fits inside its shield shape, the ornament fits
inside its square with clear space around it.

HARD LAYOUT RULES:
1. COVERAGE: every pixel of every region is either painted artwork or solid
   cyan. No white, no gaps, no unpainted pixels inside a region.
2. CONTAINMENT: each piece stays inside its own region. Nothing reaches into a
   neighbouring region, nothing spans two regions. This applies most strictly to
   the two head regions, which sit very close together.
3. The white background is not a canvas. Do not draw in it, do not connect
   regions, do not treat any region as a frame or edge decoration.
4. SEAMS — keep straps, stripes and trim from crossing region borders. Where a
   band is unavoidable it must sit at the IDENTICAL height, thickness and colour
   on both halves of a pair: trouser front/back, chest front/back, arm
   front/back, hand back/palm, robe front/back, tasset front/back, and face
   front / head side. Same for the wrist cuff, ankle hem and waistline.
5. Values and colours must match across every front/back pair — no brightness
   jump at a seam. Left and right legs within a region are mirrored and
   identical, and so are the two robe front panels.
6. No text, no letters, no numbers, no logos, no watermark, no signature, no
   grid or wireframe lines, no labels.

Negative prompt

border, frame, banner, footer, header, divider, horizontal rule, bar across the
image, buckle on the strap, two buckles, buckle frame around a hole, cyan window,
cyan glow, glowing cyan eyes, cyan eyelets, metal tasset on a cloth set, tasset
in a material used nowhere else, plain flat tasset, inside of hood, hood lining,
hood interior, dark cavity, empty hood, front view hood, three-quarter hood, one
wide face panel, mask spanning both head regions, stretched face, horizontally
smeared features, unwrapped face, peeled face, portrait, three faces, repeated
features, small face floating in empty space, muddy blob, featureless brown
smear, 3d render, character render, perspective, mannequin, full body
illustration, photorealistic, PBR, glossy, smooth gradients, blur, depth of
field, white gaps, outline, cel shading, text, letters, logo, watermark,
signature, UV wireframe, straps crossing region edges, detail spilling between
regions, solid filled disc, cyan artwork, turquoise, verdigris, patina, neon,
oversaturated, navy pants, blue pants, red shirt, purple robe, green gloves,
magenta sleeves, pink shoes
