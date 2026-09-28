# Human body: the woman's version of an outfit

The female body shares the male's UV islands, so an outfit's sheet paints both,
except the CHEST FRONT: a bust painted on a flat chest does not read. Each
outfit therefore gets a woman's sheet made from the man's:

1. Generate with `key-female.png` (the body key plus two bust marks: the area
   centroid of the forward-most triangles of each breast of
   `HumanFemale_ChestFront`, UV 0.103 / 0.160 across, 0.505 down on the current chest) FIRST and
   the finished man's art SECOND. The prompt is `prompt.md` with the outfit's
   SUBJECT, plus the block below.
2. Import it like any body sheet, then copy ONLY the chest-front island (key
   colour #ff0000, with a 3-texel gutter) onto the man's atlas: everything
   else stays pixel-identical to his. The result is
   `tools/atlas/out/human-body/<theme>-f/atlas.png`, tile
   `mmo/human-body-<theme>-f.png` on the same body page.

Re-measure the marks if the female chest is remodelled (the apex vertex alone
sits too high: the painted bust landed above the modelled one).

---

THIS IS THE WOMAN'S VERSION OF AN OUTFIT THAT ALREADY EXISTS. The SECOND
attached image is the finished man's sheet for this exact outfit. Paint the
whole sheet as a faithful copy of it — same garments, materials, colours,
trims, rivets, belts and wear, region by region — with ONE change:

THE CHEST FRONT (the brighter torso, middle left) is shaped for a WOMAN. The
two small black dots ringed white on the FIRST image mark the CENTRES OF THE
BREASTS, measured from the model: the FULLEST, most forward and most shaded
part of each breast sits exactly ON its dot (not above it), the top of the bust
curving in well above the dots and its underside shadow just below them. Paint
the garment with a bust there — two soft rounded forms centred on the dots, lit
from above with shading underneath and between them, the cloth or plate
following the curve (a shaped breastplate, a fitted bodice, a laced leather
front) — and a gently tapered waist below.

EVERY STRAP, BELT, BALDRIC, CLASP AND TRIM ON THE MAN'S CHEST FRONT CARRIES
OVER, at the same width and in the same place: a strap that crosses his chest
crosses hers too, running BETWEEN the breasts and curving over the bust. Keep
the collar, shoulders, side edges and waistband at the SAME heights and widths
so the chest still joins the chest back and the arms. Tasteful, practical
armour, fully covered. The dots are guide marks: no dot may remain.
