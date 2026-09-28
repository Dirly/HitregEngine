# Human head (female) atlas prompt

The female head (recipe `human-head-female`, parts F_*), same prompt as the male `human-head` set; its faces join the male page as tiles of the one head mesh.

The player's head: one low-poly module worn by every human character, in 3
regions. The unwrap is PROJECTED by `unwrap-weapon` from the face panel, side
band, crown and jaw shells of `MMO/3d/HumanRig/Head/Face.obj`:

    pnpm -F playground unwrap-weapon --recipe human-head --islands

**Hand the generator `tools/atlas/sets/human-head/key-labelled.png`, NOT
`key.png`.** The eyes, nose and mouth are marked on it from the model's own face.

The hair, beard and moustache are SEPARATE meshes in the same file, wearing a
tiling hair swatch on their own UVs — so this sheet is a BALD, CLEAN-SHAVEN head
and the scalp is skin. Every head is one tile of a shared page
(`apps/playground/tools/heads.mjs`), so all faces a player can pick share one
mesh and one draw. They share ONE skin tone: swap only the SUBJECT's {who} and
FACE. Sixteen heads, eight male and eight female, on one 4x4 page.

    node tools/atlas/import-atlas.mjs --set human-head --theme <face>
    node apps/playground/tools/heads.mjs

---

**NO TEXT, NO LETTERS, NO GUIDE MARKS IN THE FINISHED SHEET.** The reference
carries labels and small black-and-white face marks; they tell you where things
go and must be painted over completely. Not one letter, ring or dot from the
reference may survive.

A flat 2D hand-painted texture atlas for a very low-poly PS1-era HUMAN HEAD,
1254x1254, painted directly over the supplied UV layout. This is a UV
sheet, NOT a portrait, NOT a 3D render. No perspective, no drop shadow, no
background scene, no border or frame.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. The red blocks are region IDs. The
head is not red. Decide the palette from the SUBJECT alone.

**ALL 3 BLOCKS MUST BE PAINTED**, edge to edge: HEAD, the scalp block above it
and UNDER JAW below it.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent, not
a tone. **Nothing painted may be white**: the whites of the eyes are a warm dull
cream (#D8CDB8 or darker), never paper white.

**Fill each block edge to edge and a little past it.** The blocks are drawn a
little larger than the model on purpose. Nothing may hang OUT of a block.

THE HEAD — the wide block in the middle. It is the WHOLE HEAD UNROLLED INTO ONE
STRIP, like a label peeled off a jar: the FACE in the MIDDLE, the ears and the
sides of the head either side of it, and the BACK of the head split between the
far LEFT and far RIGHT ends (the ends meet at the back of the head, so they must
match). TOP edge is the top of the head, BOTTOM edge the jaw line and the nape
of the neck.

**THE FACE IS MARKED ON THE REFERENCE.** Inside the HEAD block:
- the TWO BLACK DOTS ringed in white are the two EYES;
- the SMALL DOT below them is the TIP OF THE NOSE;
- the SHORT BAR below that is the MOUTH.

Paint the face AROUND those marks, at THAT size, and paint over the marks. The
eyes sit exactly on the dots, the nose tip on the small dot, the lips on the
bar, the brow just above the eyes, the chin at the bottom edge under the mouth.
**The face is centred EXACTLY on the marks** — the bridge of the nose, the
nose tip and the middle of the mouth on one vertical line straight through the
small dot, halfway between the eye dots. **The nose is SHORT**: it starts
between the eyes and ENDS at the small dot, nostrils right on it; the upper lip
is short, the mouth right under the nose.
The face is BROAD: bare skin of forehead, temples, cheekbones, cheeks and jaw
spans about THREE TIMES the distance between the two eye marks, centred on
them. Dead straight on and perfectly SYMMETRICAL, left and right halves mirror
images — no head turn, no tilt, no lopsided smile, no scar, mole or mark on
one side only. Eyes open and looking forward, mouth closed.
Everywhere else on the strip is the sides and back of the head — one ear on
each side, level with the eyes and nose, about halfway between the face and
the ends of the strip, painted flat as seen from the side. No second face, no
eyes anywhere else.

FOUR FAILURES TO AVOID, by name: the face drawn WIDE so the eyes wrap round
onto the sides of the head; the face drawn small and floating in the middle of
a skin-coloured block; features drawn in the wrong place — the eyes must be ON
the dots, not above or below them; a LONG NOSE running down past the small dot.

**THE HEAD IS BALD AND CLEAN-SHAVEN.** Hair, beard and moustache are separate
models laid on top. The scalp is SKIN, a touch darker and duller than the face
(the SUBJECT says whether it carries a faint cropped shadow). The jaw and upper
lip are clean skin. Eyebrows ARE painted — they belong to the face.

The SCALP block, centred ABOVE the head strip: the top of the bald head seen
from DIRECTLY ABOVE, the FOREHEAD at the BOTTOM of the block, touching the head
strip's face. The same scalp skin and stubble shadow as the TOP of the head
strip, same colour and value, edge to edge. No face, no hair, no ears in it.

UNDER JAW — the block centred BELOW the head strip: the underside of the chin
and jaw seen from below, CHIN at the TOP. Plain skin at the face's value, a
little darker toward the bottom (the throat and the back of the neck). No face.

**ONE SKIN.** All three blocks are one person's skin at one value; the scalp and
the underside of the jaw may be a shade darker, never a different colour.
Every head in this set shares that skin exactly — the faces change, the skin
does not.

SEAMS THAT HAVE TO LINE UP: the two ends of the head strip (the back of the
head); the top of the strip against the scalp block; the jaw line against UNDER
JAW.

THE PLACEMENT MODEL. TWO images are attached: the FIRST is the labelled
layout key described above; the SECOND is a FINISHED sheet from this same set,
the one whose face works best on the model. **Copy the SECOND image's face
layout exactly** — where it puts the eyes and how BIG they are (small, set
deep under the brow), the heavy brow line right above them, the nose (short,
the nostrils on the small dot, strong shadow down both sides of it), the mouth
(wide, flat, on the bar), the shading from the nose to the mouth corners, the
chin and jaw shading, the ears, the scalp — and its CONTRAST: dark readable
features that survive being shrunk to 72 pixels. Change ONLY who the person is:
their age, build and the features the FACE line names, and their sex. Do not
copy its frown lines or forehead wrinkles unless the FACE line asks for them.

SHADING, because this is a PS1-era game texture: paint the light INTO the
texture, lit softly from the front and above — darker eye sockets, under the
brow, under the nose, under the lower lip and under the jaw. Broad and flat,
chunky readable features, no photographic detail, no specular sheen, no smooth
airbrushed gradients. At a quarter size the face must still read clearly: two
eyes, a nose, a mouth.

Final check before you finish: no text, no letters, no black dots or white
rings from the reference anywhere on the sheet; the background is pure white;
every block is painted to its edge.

SUBJECT:
{who}, a player character in a medieval dark-fantasy MMO. SKIN: weathered
light-olive skin, mid value, warm (face around #B98A6A, shadows #7E5641) —
EXACTLY this skin tone. Grounded and believable, a real person, not a cartoon
and not a monster.
FACE: {face}

(MALE: {who} = "A human man"; the scalp and jaw carry the faintest cropped
stubble shadow; eyebrows dark brown unless the FACE says otherwise.
FEMALE: {who} = "A human woman"; smooth scalp and jaw with NO stubble shadow at
all, a feminine face ON THE PLACEMENT MODEL'S LAYOUT — the same eye position
and size, mouth position and chin shading, with a softer jaw, a finer nose,
fuller defined lips with natural colour, and dark, clearly drawn shapely
eyebrows and lash lines (they are what read at 72 pixels); weathered and
capable, not glamorous, no makeup. As much contrast in the features as the
placement model — a pale soft face disappears at this size.)
