# Ratkin-atlas generation prompt

One ratkin in 23 regions. The model's UVs are AUTHORED by hand in Blockbench and
the recipe is `uvSource: "file"`, so nothing here is projected — re-running the
cut re-reads the mesh's own islands and writes the key, the margin and the
manifest from them:

    pnpm -F playground unwrap-weapon --recipe ratkin --islands

**Hand the generator `tools/atlas/sets/ratkin/key-labelled.png`, NOT `key.png`.**
Every block has its own name written inside it. That file exists because it had
to: a generator reads a flat colour key as SHAPES and matches them to whatever
the prompt describes, so any block that happens to look like a distinctive thing
attracts that thing. Measured over five rounds on this sheet, an EAR was painted
onto the top-of-hood block (a pointed pentagon) and onto the lower shoulder lame
(a rounded teardrop); the robe took the shoulder's material; the chest back took
the shoulder's bone. Every fix was another paragraph of prose, and this prompt
grew from 19k to 37k characters while the assignments got LESS reliable, because
what mattered drowned in the warnings. The labels ended it, and the prompt went
back to half the size. **If a block's identity is ever unclear, read the word
written in it — do not guess from its outline.**

`key.png` stays flat and is what the importer registers against, so the
lettering never reaches the atlas. Register and bake:

    node tools/atlas/import-atlas.mjs --set ratkin --theme <theme>

    pnpm -F playground unwrap-weapon --recipe ratkin \
      --atlas ../../tools/atlas/out/ratkin/<theme>/atlas.png \
      --out-mesh <MMO>/3d/Mobs/RatKin-<theme>-unwrapped

Put the sheet at `tools/atlas/art/ratkin/<theme>.png` and `--set ratkin --theme
<theme>` resolves the rest. Swap only the **SUBJECT** block to make a different
ratkin, and name every piece of kit in it — a block the SUBJECT never mentions
is a block that comes back blank or borrowed.

---

A flat 2D hand-painted texture atlas for a very low-poly PS1-era RATKIN — a
hunched, man-sized rat-person — 1254x1254, painted directly over the supplied UV
layout. This is a UV sheet, NOT a 3D render, NOT a character illustration. No
perspective, no drop shadow, no background scene, no border or frame.

**EVERY BLOCK IS LABELLED WITH ITS NAME. PAINT WHAT THE LABEL SAYS.** Read the
word in a block before painting it. Paint over the lettering — it is a guide,
not artwork, and it must not appear in the finished sheet.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
region ID. NOT ONE of them is a colour this creature is made of. Decide the
palette from the SUBJECT block alone.

**ALL 23 BLOCKS MUST BE PAINTED.** Check each one against the reference before
finishing. A block left white is not a piece left off the ratkin; it is a piece
that wears its neighbour's skin on the model.

**THE BACKGROUND MUST BE PURE WHITE #FFFFFF** — not black, not transparent, not
a tone. The importer finds its ground by flooding in from the sheet's border
through everything bright, so a sheet on black or on a transparent alpha channel
has no ground at all and is rejected.

**Nothing painted may be white.** Bright pixels read as ground, so a tooth, a
claw or a buckle painted white loses itself to the background. Ivory, bone and
bare metal want a warm cream around #E8DCC0 or a light grey.

**Fill each block edge to edge and a little past it.** The islands are drawn 8px
larger than the geometry on purpose, so artwork that runs slightly over is
cropped rather than leaving a wrong-coloured seam round a limb. Nothing may hang
OUT of a block: a piece that continues onto another part is DRAWN AGAIN inside
that part's block, never across the gap.

**THE FRAYED HEM IS CUT FOR YOU.** The importer tears a few texels off the
bottom of ROBES, TASSET-FRONT and TASSET-BACK itself, in an uneven line. Paint
those three FULL, right down to the bottom edge; put the hem treatment — the
dirt line, the darker worn band, loose threads, knotted charms — in the bottom
fifth, and leave the last couple of texels plain for the cut to eat. Do not draw
a crisp horizontal line across the bottom; it will be torn through.

MATERIALS — which blocks are the same as which. This is the rule this sheet
breaks most often, and it is always the same mistake: a material from one piece
of kit gets copied onto a block it does not belong on. **Do not carry a material
across these groups.**

    HEAD, HEAD-CROWN .............. the animal's own fur and face
    BODY-FRONT, BODY-BACK,
    LEGS-FRONT, LEGS-BACK ......... one surface wrapped round one body, and the
                                    SAME COAT AS THE HEAD — they meet it at the
                                    throat with nothing in between
    EAR-FRONT, EAR-BACK ........... two sides of one ear
    HOOD, HOOD-CROWN .............. one cowl, same weave and gauge throughout
    ROBES ......................... one garment; its front panels and its back
                                    bell are the same cloth, weave and value
    TASSET-FRONT, TASSET-BACK ..... one pair, hung either side of the same belt
    SHOULDER, SHOULDER-2 .......... one pauldron in two overlapping plates
    BELT, BUCKLE .................. a strap and its fitting
    ARM-TOP, ARM-UNDER ............ one limb; the inner face is not a pale
                                    underside and not a lit edge
    HAND-TOP, HAND-PALM, FOOT,
    TAIL .......................... bare extremities

**ONE VALUE RANGE.** Each block gets painted to look right on its own, so a hand
comes back paler than the arm it is bolted to and reads as a glove. Squint at
the finished sheet: within a group above, no block should stand out lighter or
darker than its partners.

WHAT IS PAINTED ONCE AND SEEN TWICE:
- HEAD and HOOD are PROFILES, painted onto both sides mirrored. ONE eye, never
  two. The ear is separate geometry — do not draw one on the head block; all
  that belongs there is the ear ROOT, a ring of shorter fur.
- TAIL and FOOT the same: drawn once, both sides worn.
- ARM, HAND, the EARS, the SHOULDER plates and the TASSETS exist once in the
  model and are worn by both sides, so anything on them must read as being on
  both — not "a bandage on the left arm".
- HEAD-CROWN, HOOD-CROWN and BELT are the exceptions: each holds BOTH sides at
  once, so paint them symmetrical about their own long centre line.

THE HEAD — measured off the model, as percentages ACROSS the block (0% = left
edge) and DOWN it (0% = top edge). These are not suggestions:

    across   down
      0%      49%    the BACK of the skull. It goes into the hood — let the fur
                     run off it.
     37%      11%    the EAR ROOT
     36%       7%    the BROW
     42%      24%    the EYE
     43%      64%    the CHEEK
     55%      34%    where the SNOUT begins
     60%      80%    the MOUTH LINE
     50%      97%    the CHIN
     99%      57%    the NOSE TIP, at the right edge, below mid height

THE THREE MISTAKES THIS BLOCK KEEPS COMING BACK WITH. All three have happened
on real sheets, and every one is PLACEMENT, not painting:

1. **THE EYE ENDS UP TOO FAR FORWARD.** It has come back at about 75% across,
   out on the snout. The eye goes at 42% ACROSS and 24% DOWN — high on the side
   of the skull, just under the brow ridge, well behind the snout. **Draw the
   eye FIRST, at that spot, and build the head around it.** The whole right-hand
   half of this block is SNOUT and has no eye in it.
2. **THE MOUTH ENDS UP UNDER THE CHIN.** The mouth line runs at about 80% DOWN,
   from roughly 55% across to the nose. It is NOT the bottom edge of the block.
   Everything below that line is the UNDERSIDE of the jaw and the throat, never
   seen from the side — paint it as plain throat fur. A mouth drawn along the
   bottom edge disappears under the head on the model.
3. **AN EAR GETS DRAWN HERE.** Do not draw one. The ear is separate geometry
   with its own two blocks and is already painted there. All that belongs on
   this block is the ear ROOT at 37% / 11% — a small ring of shorter, thinner
   fur where it grows out of the skull. An ear painted here lands on the side
   of the skull and smears down the cheek.

The rest of the head:

- ONE eye. Small, dark, wet, set deep under a fold of skin — never two, never
  big and round. A heavy brow ridge above it.
- The muzzle runs from where the snout begins out to the nose, narrowing the
  whole way, the hide on it continuous with the cheek behind: the same fur,
  thinning toward the front into bare scaly skin at the nose.
- The NOSE at the right edge is a dark wet pad, below mid height, the nostril
  set just behind it.
- ONE long chisel INCISOR in stained cream coming DOWN from the mouth line at
  about 70% across — on the line, not below the block. Too long, worn at an
  angle.
- Long stiff WHISKERS sweeping back from the muzzle as fine pale lines, and
  coarse guard hairs along the brow.
- The bottom-left corner is the neck, going into the hood. It is hidden — let
  the fur run off it and put nothing there.
- **No outline anywhere in this block**, and nothing drawn along its top edge:
  the top of the skull is a different block and a dark line here renders as a
  stripe over the head.

WHAT A RATKIN'S HEAD IS, AND WHAT IT MUST NOT COME BACK AS. A man-sized,
intelligent, vicious rat-person — not a pet and not an animal:

- LEAN and HARD: taut skin over bone, a hollow under the cheekbone, scabs and
  bald patches, a scarred muzzle. Not plump, not soft, not fluffy.
- The long tapering snout and the wet nose are RIGHT and wanted here.
- Yellow-brown STAINED chisel incisors, too long, worn at an angle.
- Bare scaly pinkish-grey skin on the nose and around the eye; fur elsewhere.
- NO cute proportions, no big soft round eyes, no smiling mouth, no pink button
  nose, no clean white fur, no cartoon whisker dots, no Disney mouse.

HEAD-CROWN — the top of the skull unrolled, NOSE AT THE RIGHT, NAPE AT THE LEFT,
running the whole length. Its centre line runs along the middle of the strip and
its two long edges join the head block. **It is the plainest block on the
sheet** — a narrow strip down the middle of the head, so any mark with a long
axis reads as a painted line down the skull. No stripe, band, crest or parting
down the centre; no dark edging near either long edge; nothing that belongs on
the side of the head. One fur tone, the same brightness as the top of the head
block, with only the faintest mottling. The two ear roots sit around 33% across,
one near each long edge.

HOOD-CROWN — the top of the cowl unrolled and stood on end: the FRONT of the
hood at the BOTTOM, the BACK at the TOP, its long edges joining the hood block.
Carry the hood's material straight across it, same gauge and brightness. Paint
the hood first, then this.

THE EARS — one ear in two halves. EAR-FRONT is the inner cup: bare skin, thin
enough to be translucent, fine veins fanning up from the root, a darker hollow
low in the middle. EAR-BACK is the outer side, duller and greyer with sparse
short hair near the root. Tip at the TOP, root at the BOTTOM in both. Both want
the same notch bitten out of the same place.

THE ROBE — the two tall panels are its FRONT hanging open, the broad bell its
BACK. Waist at the top of all three, hem at the bottom. The panels' outer edges
run round onto the back block and must meet it at the same height, or a stripe
appears down the ratkin's side. **Do not draw the belt or its buckle here** —
both have their own blocks and sit on top of the robe; a belt painted here as
well gives the ratkin two.

THE BELT — unrolled, its CENTRE the front of the waist where the buckle sits,
both ENDS the same seam at the back, so the two ends must match. Only four
texels tall on the finished sheet: tone, grain, edge stitching, nothing fine.

THE BUCKLE — filling its block, corner to corner, as a solid frame with the
darker belt showing through the opening and the tongue across the middle. **No
white anywhere in it** — this block does not cut, so white is a blotch, not a
hole.

THE TASSETS — TASSET-FRONT and TASSET-BACK, the two tall narrow blocks in the
right-hand column. One hangs at the FRONT of the hips and one at the BACK, and
they are ONE piece of kit: the same material, the same colour and the same
value as each other, hanging either side of the same belt.

**A TASSET IS A FLAT HANGING PANEL, NOT A FINGER.** These blocks are tall and
narrow, and that outline keeps being read as a digit — the last sheet came back
with the front one painted as a finger with a ring round it. It is a slab of
armour or hide as wide as a hip, hanging straight down like the flap of a
sporran. Nothing on it is skin, a knuckle, a nail, a joint or a ring round it.

- WAIST AT THE TOP of both, HEM AT THE BOTTOM of both. The top edge is where it
  hangs from the belt, so it wants a band of fixings — rivets, a stitched edge,
  punched holes, a leather tab — matching the BELT block.
- The body of it is one broad flat surface: whatever the SUBJECT says it is made
  of, edge to edge, with the wear running DOWN it — cleaner at the top where it
  is protected, dirtier and more battered toward the hem.
- Keep the detail VERTICAL and simple: a centre line, a lashed-on bone, a
  stitched seam, a split. Nothing fine; these are narrow blocks.
- The hem is cut for you — paint to the bottom edge and leave the last couple of
  texels plain.
- Do not draw a buckle on them. The buckle has its own block.

THE SHOULDER PLATES — one pauldron, two overlapping lames, worn on both
shoulders. SHOULDER caps the shoulder; SHOULDER-2 hangs under it over the arm.
Both are drawn square on to the face a player sees, so fill each corner to
corner. Where they overlap — the lower one's top edge — goes darker, as if in
the upper one's shadow.

THE TAIL — thick RIGHT end joins the rump, thin LEFT end is the tip; top edge of
the strip is the top of the tail. Bare, ringed, SCALY, not furry, darker on top
and paler underneath, dirty in the rings. Match the thick end to the bottom of
LEGS-BACK.

THE FOOT — seen from DIRECTLY ABOVE. RIGHT end is the TOES, long and splayed
with curved dark claws and dark creases between them; LEFT end is the HEEL; the
TOP edge is the inner side (biggest toe top-right), the BOTTOM edge the outer.
**The sole is never seen and shares this paint** — draw no sole, pad or
footprint.

THE ARM and THE HAND — shoulder at the TOP of each arm block, wrist at the
BOTTOM, elbow at the same height in both. The fur thins toward the wrist into
bare skin, continuing into the hand. Knuckles and wrist at the TOP of each hand
block, claw tips at the BOTTOM: the back of the hand gets knuckles, tendons and
long dark claws; the palm gets pads and creases, a shade pinker at the same
value.

THE BODY — the four big blocks. **NOTHING DETAILED GOES IN THE TOP OF THE CHEST
OR BACK BLOCK** — the scooped neck and the two hooks at the top corners, roughly
the top eighth. On the model that strip is where the shoulders run into the
neck: very few texels, hidden under the hood and plates, and folded hard.
Anything there — a strap, a collar, a charm, a painted band — comes out as a
smear round the base of the neck. Start the detail lower down the chest. Light
the body from ABOVE: brighter along the tops of the shoulders and thighs, darker
under the ribs, under the rump, in the crease behind the knee.

SEAMS THAT HAVE TO LINE UP: the throat (chest and back both meet the head); the
sides of the body (front and back are two halves of one barrel); the waist
(chest to legs, front and back); the robe's sides; the leg blocks at ankles and
hips; the head and hood each down both long edges of their crown strip; the
tail's thick end to the bottom of the back legs.

SHADING, because this is a PS1-era game texture: paint the light INTO the
texture — a lit shoulder, a shaded gut, a dirty knee. Broad and flat, no
photographic fur, no specular sheen, no gradients so smooth they band at 256
pixels. Read the sheet at a quarter size and every region should still be
legible as fur, cloth, scale, leather or metal.

SUBJECT:
A RATKIN SHAMAN — a plague-priest of the warren, hung with bone, hide and
charms. No forged armour anywhere: every hard thing on it is BONE, HORN or
TOOTH, and everything soft is filthy hide, sacking and matted fur.

- HEAD, HEAD-CROWN and the four BODY blocks: ash-grey fur, mangy and patchy over
  a ribby frame, going dirty cream over the belly, with soot in the shoulders.
  Broad bands of dry OCHRE and CHALK-WHITE warpaint in crude finger-drawn
  stripes across the chest and back, the same bands continuing round both sides.
  The head carries a white stripe across the muzzle, a milky blind left eye and
  soot round the socket. **No plates, lames, scales or armour on these blocks.**
- EARS: bare pink-grey skin, thin and veined, a small bone ring through the rim.
- HOOD and HOOD-CROWN: heavy undyed sackcloth gone mildew green-grey, filthy,
  drawn into a deep cowl, with a band of greasy dark hide round the face rim.
- ROBES: the SAME mildewed sackcloth as the hood, stained darker from the hem
  up, patched with squares of stiff brown hide sewn in gut cord, smeared with
  dried ochre handprints, small bones and beads knotted into the bottom.
- BELT: twisted hide and braided gut, dark and greasy, strung with small teeth.
- BUCKLE: a heavy ring of yellowed BONE carved with a spiral, bound with cord.
- TASSETS: stiff cracked brown hide, a RIB-BONE lashed down the centre of each
  with gut cord at top and bottom.
- SHOULDER and SHOULDER-2: yellowed BONE — a curved shoulder blade above, a
  smaller fragment below — scrimshawed with scratched spirals, lashed on with
  dark gut cord through drilled holes, stained brown where they meet the fur.
- ARMS, HANDS, FEET, TAIL: bare. Scaly pink-grey skin, long dark claws stained
  with ochre, cord wrapped round each wrist with a tooth hanging from it. The
  tail is ringed, grubby and unadorned.
