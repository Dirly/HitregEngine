# Human headgear atlas prompt

The player's headgear sheet: ONE ubermesh sitting on the head module's socket,
sixteen parts, sixteen regions. Three exclusive helms (Helm1 with an optional
flared neck guard and a mouth plate, Helm2 with an optional jaw guard, Helm3),
two nose guards, three cut-out ornaments, and a hood, crown, headband, bandana
and full face cover that combine with them. Which pieces may be worn together
is the recipe's `rules`, baked into the model (core `partProblems`).

Regenerate the key and the mesh's UVs (needed whenever the model changes):

    pnpm -F playground unwrap-weapon --recipe human-helm

Most pieces were modelled as ONE half (+Z); `mirrorCopy` builds the other half
sharing the paint, so every shell is painted ONCE as its right-side profile.
Generate with **`key-labelled.png`** attached; replace only `{subject}`. Save
each sheet as `tools/atlas/art/human-helm/<theme>.png`, then:

    node tools/atlas/import-atlas.mjs --set human-helm --theme <theme> --slices
    pnpm -F playground weapon-page --recipe human-helm --project voxel-demo --model mmo/human-helm.glb --themes <theme> …

The sheet ships at 132 texels (109/m, the body's density), shrunk nearest.

---

NO TEXT. NO LETTERS. NO GUIDE MARKS. The reference carries a word on every
region; those words are labels for you and must NOT appear anywhere on the
finished sheet. The small black dots ringed white (EYE MARKS) are guide
marks too: paint an eye slit THERE, then no dot may remain.

A flat 2D hand-painted texture atlas for very low-poly PS1-era medieval
headgear, 1254x1254, painted directly over the supplied UV colour-key layout.
This is a UV sheet, NOT a 3D render, NOT an illustration of a helmet. Straight-on,
evenly lit, no baked highlights, no directional shadows, no perspective, no drop
shadow, and NO border, frame, label or divider. The ground around the regions
stays pure white. Chunky readable pixel-art detail: big shapes, strong value
contrast, few tones; it is shrunk to 132 pixels, so fine lines vanish.

THE REFERENCE COLOURS ARE LABELS, NOT PAINT. Every solid colour block is a
REGION ID. None of them is a colour this gear is made of. Take the palette from
the SUBJECT alone.

Draw each piece to FILL its block edge to edge, following its outline exactly.
No white inside a block, except the three ornaments and above the crown's points. Nothing painted is white:
the brightest metal is a light grey with a colour cast. The top of the sheet is
the top of the head everywhere.

Every shell is a RIGHT-SIDE PROFILE: the FACE is at the RIGHT edge of the
block, the BACK of the head at the LEFT, the crown at the top, the rim at the
bottom. It is painted once and worn on both sides of the head, mirrored, so
nothing on it may be one-sided (no single emblem that reads backwards).

Every big shell has a small BACK block right beside it: the back of that
same piece seen from BEHIND, its RIGHT edge on the centre line of the head,
the top the crown, the bottom the rim. Paint it as the continuation of the
shell next to it: same metal or cloth, same bands at the same heights, and
never a face, a slit or a hole.

REGION KEY (by position, ignore each block's colour):

- TOP ROW, four big shapes, all side profiles:
  - HELM1: an open-faced round steel cap, riveted brow band along the bottom
    rim, a raised ridge over the top.
  - HELM2: a flat-topped drum helm, straight sides, a band of rivets round
    the rim; a heavier, plainer helm.
  - HELM3: a tall helm whose back sweeps down into a neck guard, the long
    tail hanging down at the right is its cheek guard; ridged plates.
  - HOOD: a cloth hood, folds running from the crown down to the shoulders,
    a hemmed edge along the face opening at the right.
- MIDDLE ROW:
  - FACE COVER (with an EYE MARK): a full wrapped face covering, cloth or
    quilted padding, seen from the side, a near-black EYE SLIT centred on the
    eye mark and running to the right edge. It covers the whole head, so the
    slit is the only way to see the wearer: never leave it out.
  - BANDANA: a cloth mask tied over the nose and mouth, seen from the side:
    the top edge crosses the bridge of the nose, the knot and short tails at
    the back (left), the point hanging under the chin at the lower right.
  - The wide pale block (upper): HELM2's JAW GUARD from the side, a band of
    plate round the jaw below the helm, rivets along its top edge; its front
    continues on HELM2's front block.
  - The long pointed block (lower): HELM1's FLARED NECK GUARD, a flared skirt
    of overlapping plates sweeping back from the rim.
  - The tall narrow upright block with an EYE MARK: HELM1's WHOLE FRONT seen
    from the FRONT, brow to chin, the right half of it (its LEFT edge is the
    middle of the face). The top quarter is the front of HELM1's cap: carry
    HELM1's brow band and rivets across it at the same height as on HELM1.
    Below it the face plate: a near-black EYE SLIT centred on the eye mark
    running to the left edge, breathing holes below. ONE continuous plate.
  - The upright block beside it with an EYE MARK: HELM2's WHOLE FRONT seen from
    the FRONT, the right half (left edge = middle of the face): the drum
    helm's face above and its JAW GUARD below as ONE continuous surface, the
    same bands and rivets as HELM2 and the wide JAW GUARD block. A near-black
    horizontal EYE SLIT centred on the eye mark running to the left edge, a
    vertical strip down the left edge, breathing holes below the slit.
  - NOSE1 and NOSE2: two nose guards seen from the side, a bar over the brow
    bending down the nose. NOSE1 plain forged iron, NOSE2 decorated with a
    raised midrib. Solid metal, filled.
- BOTTOM ROW:
  - CROWN: a circlet band in the OUTFIT's own material, not always gold:
    blackened iron, bronze, silver, bone, carved wood or thorned vine, as the
    SUBJECT says; set stones or studs evenly spaced. Its POINTS rise into the top half of the block and the
    gaps between them are PURE WHITE down to the band: that white is cut away,
    so the points stand free against the sky. The band itself is filled.
  - BAND: a headband, leather or cloth, stitched edges, one small repeated
    motif.
  - Three ORNAMENT squares, CUT-OUTS. Each is ONE connected SILHOUETTE
    (plumes, feathers, horns, antlers, spikes) standing on the helm. The
    BOTTOM EDGE of the block is where it is fixed to the helm, so:
    - its BASE is a solid socket or quill cluster sitting ON the bottom edge,
      at the CENTRE of it, and every feather, horn or tine grows OUT OF that
      base. Nothing floats: no piece that does not connect back to the base.
    - pure white around it and between its parts, and a white margin on the
      left, right and top. Never a filled square, rectangle or plaque.
    - the tilted block: a SIDE ornament seen from the side, rising up and
      outward from its base: swept feathers, one curved horn, a small antler.
    - the smaller square: a low CREST seen from the FRONT: a short fan of
      separate feathers or spikes from one central base.
    - the big square: a tall CREST seen from the FRONT: a plume of long
      feathers, a pair of antlers or tall horns, all from one central base.

SUBJECT:
{subject}

FINAL CHECK: no text, no letters, no outlines of the key, no eye-mark dots
(an eye slit in their place), no white inside a block except around the three
ornaments and between the crown's points, every ornament one silhouette growing
from the centre of its bottom edge with white around it, the BACK blocks
plain continuations of their shells, every region filled in the SUBJECT's
palette, never in its key colour.
