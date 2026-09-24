# Mob atlases

How a creature goes from a modelled body to a textured mob in the engine:
unwrap its shells, hand a generator a colour KEY of that unwrap, register the
artwork it paints back onto the mesh, and look at the result.

Same pipeline and the same tools as **docs/weapon-atlas.md** — read that first
for what a key, a slot, an island and a manifest are. This doc is what is
DIFFERENT about an animal, and what has actually been found to work. The worked
example throughout is `ogre`, the first one; its recipe is at the top of
`apps/playground/tools/unwrap-weapon.mjs` and its prompt is
`tools/atlas/sets/ogre/prompt.md`.

```
Blockbench/DCC  →  unwrap-weapon  →  generator  →  import-atlas  →  in engine
    .fbx            key + mesh         art         atlas.png       look at it
```

## Where everything lives

One folder per SET, named for the recipe, and the things generated from it in
siblings beside it:

    tools/atlas/
      sets/<set>/        key.png, key-check.png, manifest.json, prompt.md
                         The set. Small, committed, and the only thing here that
                         cannot be regenerated.
      art/<set>/<theme>.png
                         The 1254 sheet the generator handed back. ~1.7 MB each,
                         GITIGNORED, and disposable once its atlas exists.
      out/<set>/<theme>/ atlas.png, atlas-preview.png, report.json. Gitignored
                         (`tools/*/out/`). `slices/` only with `--slices`, and a
                         stale one is deleted on the next run without it.

`unwrap-weapon --recipe <set>` writes into `sets/<set>/`, and the importer takes
the whole layout as two words:

    node tools/atlas/import-atlas.mjs --set ogre --theme frost

which resolves the key, the manifest, the art and the output folder. The
explicit `--key/--art/--manifest/--out` flags still work and still win, for a
one-off or a sheet that lives somewhere else.

**Flat, this folder reached 40 MB and 38 output directories across three
different keys** with nothing but a filename prefix to say which belonged to
which — and the only way to tell was to open each `report.json` and read the
key it recorded. Name a new set's folder after the recipe and that never
happens again.

**What is disposable, and when.** `node tools/atlas/tidy.mjs` reports every set,
theme, and what each one weighs; `--slices` and `--art` delete. Slices are
per-island cut-ups written to be looked at once. Art is disposable **once its
atlas exists**, because the atlas is what ships and a sheet is only ever painted
against one key — a key that changes needs NEW art, not this art again. Keep it
while you are still re-registering with different manifest settings (a theme
that needs `--no-match`, a different `--size`); drop it when the theme is
settled. `tidy` refuses to delete art that has no atlas beside it, which is the
one case where the sheet is the only copy of anything.

**Installing.** `installTo` in a set's manifest is its home directory, and
`--install <dir>` overrides it; the atlas is copied there as
`<set>-<theme>.png`. For a MOB the usual answer is not a loose PNG at all —
bake the sheet into the GLB with `unwrap-weapon --atlas`, which makes the model
self-contained. Install is for anything driven by an engine material.

## A creature is not a weapon

The machinery is identical; what a recipe MEANS changes.

| | weapon | creature |
|---|---|---|
| parts | alternatives — four blades, pick one | shells of one body — all drawn at once |
| families | `Blade1..4` → one family | none; every part is the only one of its kind |
| `combos` | one per sample weapon | one, listing everything |
| `cutoutSlots` | the ornaments | empty for a bare animal; the HEM of anything it wears |
| `partMask` / `--variant` | picks the look | does nothing |
| shading | flat — a bevel is a real crease | smooth — facets read as the cage they are |
| sheet | one page per weapon TYPE, packed | one sheet per mob, baked into its GLB |

## The process

1. **Survey before writing anything.**
   `pnpm -F playground unwrap-weapon --survey --in <file.fbx>` prints, per part,
   how much of its area faces each axis. That number decides the projection and
   guessing costs a whole round trip through a generator.
2. **Write the recipe** — `source`, `atlas`, one `slot` per part, one `parts`
   entry per mesh, a `layout`, `combos`. See *Choosing the projection* below.
3. **Cut it** — `pnpm -F playground unwrap-weapon --recipe <name>`. It must print
   **verified**. Add `--islands` to see where every island landed, in pixels and
   texels; that listing is what the prompt's region key gets written from.
4. **Look at the key** before going near a generator. Every island has to be
   recognisable as the body part it is — that is what makes the artwork land.
5. **Write `sets/<name>/prompt.md`** from the key you actually got. See *The prompt*.
6. **Generate** the art at exactly the key's size, over the key.
7. **Register** — `node tools/atlas/import-atlas.mjs --key … --art … --manifest
   … --out out/<set>/<theme> --slices`. Read every warning.
8. **Bake** — re-run step 3 with `--atlas ../../tools/atlas/out/<set>/<theme>/atlas.png`
   (the path is relative to `apps/playground`, which is where `pnpm -F` runs).
   That writes the GLB with the sheet inside it and re-renders
   `sets/<name>/key-check.png`.
9. **Look at it in the engine** — `pnpm -F playground atlas-view --recipe <name>
   --height 3 --project <project> --atlas …`.

Steps 3 and 7 both re-read the key, so **any change to the recipe strands every
sheet already painted against it.** Batch recipe changes; regenerate art last.

## Choosing the projection

The survey gives the numbers. Two questions decide each part, and the second one
matters more than the first.

**Is the part a SHELL or a whole piece?** A body is usually modelled in halves
that already face the way they want to be looked at — measured on the ogre,
`ChestFront` has 58% of its area facing +X and 1% facing back. A shell like that
is a pure planar projection along the axis it faces, with nothing to fold.

**Which axis can it afford to fold?** A plane projection lands the front and the
back of a part on the same texels. That is free symmetry on a blade and a
disaster on a head:

- Looked at along the body's **front-to-back** axis, a head keeps the most area
  and paints the FACE onto the back of the skull.
- Looked at along the **left-to-right** axis it keeps less, and the fold puts the
  left cheek's paint on the right cheek — which is what a bilaterally symmetric
  animal wants. Draw one eye on the profile and the creature gets two, in the
  right places.

Always fold the axis the animal is symmetric about. The same choice gives a foot
a footprint island whose sole — never seen — shares the top's texels for free.

**`rim` is for a collar, not a shell.** A rim bar carries the faces the view
cannot see as a strip hung under the silhouette. That works for a part with a
handful of edge faces. Hang one under a shell with thirty and it comes out a
picket fence of one-pixel slivers with gaps between them — which is exactly what
the ogre's first head, arm, hand and foot islands did. **Shells take no rim.**

**A limb that is a tube has no good answer here.** Both `unroll` and `band` were
tried on the ogre's arm: the hull walk overlapped itself on a bent C-shell, and
either way the island is the limb's whole perimeter wide, which cost 30% of the
sheet's scale for every other part. The plane won; `flare` fixed what it lost.

## `flare` — unfolding what the projection cannot see

**This is the single most important setting on a creature recipe.**

A plane projection is honest about the face it looks at and brutal to everything
else. The front of an ogre's muzzle is edge-on to a profile, so it lands on a
one-texel line and the paint smears forward over the whole face as a starburst.
The sides of a chest, the outside of a thigh and the knuckles go the same way,
and a face turned further still gets one flat patch — the stray facets that show
up floating in a leg.

`flare` pushes every vertex outward along the way the surface is heading, by how
deep it sits under the part's outer surface. Unfolding a box that way lays its
sides out as bands attached to the front face, the way a paper model does; on a
curved shell it is the same thing continuously. It is monotonic, so an island
cannot fold over itself.

**Tune it per part and look at the key.** One value for the whole body ruins it:
at 0.6 the ogre's two legs flare into each other and the island reads as a pair
of shorts, which is then what the generator paints. What the ogre settled on:

| part | flare | why |
|---|---|---|
| head | 0.8 | a blob with nothing to collide with, and the part that needed it most |
| arm (outer) | 0.5 | the arm wraps; the silhouette alone loses its front and back |
| foot | 0.45 | a small slab, nothing to collide with |
| hands | 0.15 | **a hand folds over its own thumb**; flare doubled the overlap |
| torso shells | 0.3 | enough to unfold the sides, not enough to hook the shoulders badly |
| legs front | 0.28 | **the ceiling**: 0.34 starts pinching the gap between the legs shut |
| legs back | 0.2 | the back legs join higher, so they close sooner |

Sweep it with `--debug-slot <name>`, which draws one island's triangles in
alternating colours. That is the only way to see the gap between two legs
closing, and it is what set the 0.28.

Expect to pay in density — the ogre went 3.58 → 2.57 px/unit — and note what it
buys: surfaces that had no texels at all now have some.

**A flared lobe on a two-sided part is HALF a surface, mirrored**, and the
prompt has to say so. The ogre's muzzle lobe is half a face folded down the nose;
told to draw a whole face there, a generator draws a whole face and it comes out
doubled.

## Overlap, and `split`

A plane projection folds the two sides of the dropped axis onto each other. On a
head that IS the projection — the two cheeks are one mirrored surface, so the
island comes out ~100% doubled and every bit of it is correct. On a SHELL it is
a fault: an arm's outer shell wraps past its own silhouette, the sliver that
ends up facing back inward lands on top of the outer face, and two different
pieces of skin fight over one patch of sheet. That is warping no repainting
fixes, and it is invisible in the key — both faces are the same flat colour.

So measure it. Every cut prints the islands that are covered twice, and knows
the difference:

    pnpm -F playground unwrap-weapon --recipe ogre --overlap
        head: 100% doubled — mirrored, which is what this projection is for
        foot: 90% doubled — mirrored, which is what this projection is for
      ! hand-side: 5.6% of the island is covered twice — split the faces that
        a flat view cannot reach into their own group
        arm-top: 1.0% of the island is covered twice

A part is "mirrored" when real surface area faces BOTH ways along the dropped
axis — the same test `flare` uses to decide how to measure depth, so the two
always agree about what a part is. Anything over 5% on a one-sided part is
shouted about without `--overlap`; the rest is there when you ask.

**`split` is the fix, and it is the answer to a corner.** A shell that turns a
corner defeats a single projection outright: measured, 52% of the ogre's hand
faces +X and 56% faces -Z, and its arm's front faces point (0.98, 0.05, 0.18)
against an outer shell that wants to be looked at down Z. Look down one axis and
the other half is edge-on, folds onto the half you kept, and comes out as
triangles laid over each other. Neither axis is wrong; the assumption that ONE
axis has to do is.

So a part may declare face groups, each with the direction a face has to point,
the slot it goes to, and — this is the part that matters — its own projection:

    Ogre_Arm_Top: {
      slot: "arm-top", method: "plane", u: "+x", v: "-y", flare: 0.5,
      split: [{ slot: "arm-front", facing: "+x", above: 0.6,
                u: "+z", v: "-y", flare: 0.3 }],
    },

Those faces are then projected DOWN THEIR OWN AXIS and land square-on. Omit
`u`/`v` and the group inherits the base projection, which is the cheaper fix
for a lip that only needs to be somewhere ELSE rather than seen differently.
Groups are tested in order, first match wins, and anything unmatched stays with
the part's own slot.

On the ogre that took **arm-top from 13.3% doubled to 0%**, arm-bottom to 0%, and
hand-top from 23.6% to 1.8%, for 34 faces moved into three new islands.

**Budget for the layout, not for the islands.** Three extra islands looked
expensive — the first arrangement that held them solved to 2.24 px/unit against
2.74 before the split. Rebalancing the columns got it back to **2.77**, i.e. the
split cost nothing at all. Whenever an island count changes, re-solve the layout
before concluding the sheet got worse; `--islands` and two minutes of moving
columns around is the whole job.

**A normal-based split cuts a ragged edge**, because adjacent faces at similar
angles fall either side of the threshold. That is fine — the ragged edge is a
JOIN, not a shape — but say so in the prompt, or a generator treats it as an
outline and draws to it.

Measured on the ogre, `flare` REDUCES overlap on most parts, because unfolding a
wrap is the alternative to folding it onto itself: chest-front 1.7% → 0,
legs-front 4.7% → 0.2%, arm-top 13.3% → 3.9% before the split and 0% after.
The exception is a part that folds over its own outcrop — the hand and its
thumb, where flare took 10.5% to 23.6%. Sweep it and watch the number.

## The other four settings

**`keyStroke`** grows every island a few pixels outward in its own colour. A
generator draws a piece, not a mask: measured on the first ogre sheet, its
outline sat one to three pixels inside the island's the whole way round, which
renders as a wrong-coloured seam all the way around a limb. Drawn a little large
the artwork is cropped instead and nobody can tell. Tell the prompt to draw past
the edge or the margin goes unused.

It also **retires the needle patch**, which is the bigger win. A face turned
nearly edge-on samples a one-pixel line of the sheet; with a margin wider than a
texel that line is its own island, so it keeps its thin UVs and takes a smear of
the skin beside it instead of the one flat colour a patch gives it. On the
ogre's legs — which cannot flare far, because the gap has to survive — fifteen
inner-thigh faces of up to 225 square units had been coming out as flat facets
floating in the leg.

**Pay for the stroke out of the `bleed`, not the gutter.** An 8px stroke on both
sides of a 48px gutter leaves 32px of clear space, 6.5 texels at 256, which
carries a bleed of 3 and not 4. Widening the gutter instead re-cuts the layout
and strands every sheet already painted against that key.

**`smooth: <degrees>`** averages the exported normals **across the whole body**,
not per part: the shells share their border vertices, so smoothing each one
alone leaves a shading seam exactly where the chest meets the back. The degrees
are a crease threshold — 48 on the ogre keeps the jaw line and the top of the
foot as edges and smooths the rest.

**`matchTo`** names the piece a part MEETS on the body, and gains that island to
the named island's mean luminance. A generator cannot hold one value across ten
separate drawings: measured, the ogre's inner arm came back 18% brighter than
the outer arm and a hand 26% brighter than its forearm, which on the model reads
as a lighting bug, a glove and a sock. The gain is flat and luminance-only, so
it preserves the modelling, the dirt and the nails and moves only the level the
generator got wrong; hue is left alone, because a palm IS pinker than a forearm
and that is not the error. It clamps at ±35% and warns rather than silently
dragging something impossible into line. The ogre matches `arm-bottom`,
`hand-top` and `hand-palm` to `arm-top`, and `foot` to `legs-front`.

**And it assumes the two pieces are the SAME MATERIAL**, which a theme is free to
break on purpose. The armoured ogre paints a blackened iron gauntlet on the hands
and leaves the arm bare hide: measured, 38-51% apart in value, every one of them
clamped, and the correction was busy washing the gauntlets out. The tool cannot
tell a deliberate second material from a mistake — so when it warns that a piece
is far out AND clamped, that is the question being asked. Answer it with
`--no-match`, which turns the pass off for that sheet. Ordinary sheets want it
on: across six ogre themes the honest corrections ran 0.74 to 1.14.

## A distinctive detail goes looking for a shape

When a block keeps stealing an identity, look for the ORNAMENT in the SUBJECT
that is hunting for somewhere to go. The ratkin hood crown came back as an ear
sheet after sheet — and, tellingly, with a HOOP RING through it. The armoured
theme, whose SUBJECT names no ring, never had the problem; the shaman-s said "a
small bone ring through the rim" of the ear, and the generator put that memorable
detail on the nearest ear-shaped block. Deleting the ring fixed it in one roll:
the crown came back within 8% of the hood-s own colour unprompted.

Note what did NOT work first: labelling the block, moving it, and matchColor.
Colour correction can only recolour a wrongly-drawn ear; it cannot un-draw it.

## An island is painted partly from its NEIGHBOURS

Where an island SITS on the sheet is part of what it says. A generator paints a
sheet as one picture, so a block takes cues from whatever is next to it — and
that beats both the label and the prompt.

Measured on the ratkin hood crown, which must be the same cloth as the hood:
sitting 898px from the hood and wedged between the two shoulder lames, it came
back painted as a third shoulder plate on every sheet. Moved to the gap under
the head, 255px from the hood, it came back FLESH-PINK. Two different wrong
answers, both borrowed from the new neighbours. Labelling the block did not
shift it; neither did four rounds of prose.

**So put a piece near the piece it belongs to** — `move: [dx, dy]` on a part
slides its island in sheet pixels after reading it from the file, for a layout
fault not worth a round trip to the modeller (it diverges the shipped mesh from
their file by that offset, so the tool says so out loud).

**And when two islands are ONE material, force it.** `matchTo` moves luminance
only, deliberately, because a palm IS pinker than a forearm. That is wrong for a
pair that is one piece cut in two by the unwrap: a crown strip is the same cowl,
with the same dye. `matchColor: "<slot>"` gains all THREE channels to the
target-s mean, flat, so the weave and the dirt survive and only the material
moves. On the ratkin it pulled the pink crown back to the hood-s green at
x0.60/0.75/0.66 with no regeneration at all. Use matchColor for one-piece-cut-in-
two; keep matchTo for two pieces that merely meet.

## Label the key, then keep the prompt short

A generator reads a flat colour key as SHAPES and matches them against whatever
the prompt describes, so any block that happens to look like a distinctive thing
attracts that thing. Measured over six rounds on the ratkin: an EAR was painted
onto the top-of-hood block (a pointed pentagon) and onto the lower shoulder lame
(a rounded teardrop); a TASSET came back as a finger with a ring round it; the
robe took the shoulder-s material; the chest back took the shoulder-s bone.

Every one of those was answered with another paragraph of prose, and the prompt
grew from 19k to **37k characters while the per-block assignments got LESS
reliable** — the instructions that mattered drowned in the warnings. That is the
trap: each fix makes the next thing worse, and it looks like generator variance.

`unwrap-weapon` now writes **`key-labelled.png`** beside `key.png`, with each
slot-s name lettered inside its own island (`_font.mjs`, auto-scaled, contrast
ink, halo-checked so it never spills off the block). Hand the generator the
LABELLED one; `key.png` stays flat for the importer, so the lettering never
reaches the atlas. With the blocks self-identifying, the whole region-key section
and every "this is not an ear" warning can go, and the prompt halves.

**But do not cut the sections that were working.** Trimmed to 13k the sheet lost
its face and its tassets — the head landmark table needs its three named
mistakes beside it, and a narrow block needs to be told what it is NOT. 16k with
the labels was the sweet spot. Cut the SHAPE descriptions, keep the CONTENT ones.

**Label narrow blocks on end, and let a label be an instruction.** The
labeller letters a tall narrow block vertically when a horizontal word would be
tiny. On the ghoul's first sheets the five blocks too narrow to letter were
exactly the five painted wrong (tassets as clawed hands, hands as sleeve cuffs).
And `label: "rib-upper bone"` on a slot replaces the word: the ribs came back
as cloth on every sheet while lettered RIB-UPPER and parked beside the belt;
moved beside the spine and lettered with their material, all three came back
bone. Put the head ABOVE its hood, too — a generator draws "a hooded face" as
one picture into the first of the two blocks it meets.

## A face needs coordinates, not adjectives

The head is where every unwrap decision shows up first, and it is also the block
a generator places worst. The ratkin's first sheet came back with the eye out on
the snout, the mouth under the chin and a dark stripe over the skull — three
placement faults from a prompt that described the block in words ("one eye, set
high in the middle third"). Words do not work here, because flare makes the
island longer and taller than the head's true silhouette, so a generator drawing
a natural-looking rat head into the block puts every feature too far forward.

**Measure the landmarks and give the prompt percentages.** Sample each triangle
into the island, then for a world-space point on the skull find the covered
pixel nearest it and report it as a percentage across and down the block. The
ratkin's table — ear 35%/26%, brow 46%/15%, EYE 54%/42%, snout begins 64%/41%,
mouth line 68%/82%, chin 61%/97%, nose tip 99%/61% — replaced the prose and the
next sheet landed. Note how unobvious two of those are: the eye is barely past
the middle (the generator had it at 75%), and the mouth line is at 80% DOWN
rather than on the bottom edge, because the bottom fifth of the island is the
underside of the jaw. State the three failures by name in the prompt as well;
naming the mistake is what stops it.

**A crown is not a band, it is a surface.** A third of the ratkin's head faces
+Y. Left in the profile it can only be a compressed strip along the top of the
island, and a generator reads that strip as the top of the SILHOUETTE and paints
the head's outline into it — which renders as a dark stripe across the skull.
Flare does not fix it: the crown's share moved only 32% -> 27% across a flare
sweep from 0.8 to 0.25, so it is a real surface, not an artifact to tune away.
Split it (`facing: "+y"`, looked at down Y) and it becomes a plain oval, nose to
the right, that a generator paints correctly first time.

**Give a split its own `flare`.** A split group inherits the part's flare when
it does not declare one, and the value that unfolds a profile is far too much
for a top-down view: at the head's 0.8 the crown island ballooned and reported
11.8% overlap. Swept, `above: 0.75, flare: 0.15` gave 0.4% overlap at 10.02
px/unit — the same density as before the split, so the island was free.

**A crown split is NOT mirrored.** The profile folds left onto right and is
painted once for both cheeks; the crown holds both sides at once. The prompt has
to say so, or the artwork comes back with one ear root.

## A part with no good axis: `view`

`u`/`v` name world axes and the third is dropped, which is all an axis-aligned
shell needs. A DOME is not one. Measured, the ratkin shoulder pad faces
(0.24, 0.51, 0.83) on average and a flat view keeps 57% of its area down Z, 42%
down Y and 66% down its own mean normal — so down either axis about a third of
it is edge-on and warps visibly. `view: [x, y, z]` projects down an arbitrary
direction and derives u and v from it (u across the sheet, v down it):

    ShoulderPad: { slot: "shoulder", method: "plane",
                   view: [0.15, 0.5, 0.85], flare: 0.2 },

Measured on that pad, the area crushed to under a quarter of the median stretch
went from **29% to 2%**, at the same sheet density. Find the direction by
sweeping the hemisphere for the one that keeps the most projected area; the
area-weighted mean normal is a good first guess and was within a few degrees.

**Prefer `view` over `split` for a small, prominent piece.** A split would also
have fixed the pad, and was rejected: it puts a SEAM across the middle of a
dome a player looks straight at, and a seam on a visible curved surface is worse
than a little compression at the rim. Split a shell that turns a hard corner;
tilt the view for one that is merely oblique.

`rim` is not available on an oblique view — edgeBand walks a world axis and
there is not one — and the tool says so rather than writing a wrong bar.

## A bent tube: `tube`

`unroll` peels around ONE straight world axis. A rib curves half way round the
chest, so no axis runs along it. `method: "tube"` walks the tube's own rings
instead: the two open ends are the mesh's boundary loops, a vertex's ring is its
hop distance from one end, and the tube comes out as one straight rectangle —
arc round the rings across, mean vertex-to-vertex step along. No flare, no
overlap, every face connected. `seam` picks the side the cut runs down (the
side nobody sees); `u: "along"` lays the strip horizontal.

It also takes a tube CLOSED to a point at one end — the ghoul's belt is a band
with a hidden lid fanned to one apex; the fan collapses onto the strip's edge
and the rescue pass patches it.

    Ghoul_RibUpper: { slot: "rib-upper", method: "tube", seam: "+z", u: "along" },
    Belt:           { slot: "belt", method: "tube", seam: "-x" },

**A tube that narrows wants `taper: true`.** By default every ring is stretched
to the mean width, which suits a belt. A spider leg's thin tip then gets the
full strip width. The generator paints a pointed leg into that rectangle anyway,
and the empty corners smear over the tip on the model. With `taper` each ring is
laid out at its own perimeter, centred, and a closed end becomes a real point
one tip-length beyond the last ring, so the island is the leg's shape.
Measured on the anansi: the tip went from 4 patched needles per leg to 0, and the
unpainted share of each leg island from 12-18% to 4-6%.

## A strip over a mirrored piece: `mirror`

A crown strip seen from above holds BOTH sides of the head at once, but the hood
under it is a profile painted once and worn on both sides — so the two never
line up at the join. `mirror: "z"` on a plane projection (or a `split`
group) folds the part about the body's centre plane before projecting: the
island is half as wide, its top edge is the centre line, and it is painted once
for both sides like the piece it sits on. The overlap report knows a mirrored
part is doubled on purpose.

## A head that is seen from every side: `sphere`

Four cuts of the ghoul's head failed Derek's eye before this one. A FRONT view
folds the face onto the back of the skull; a PROFILE squeezes the face to a
7-texel sliver; front + back halves never matched at their joins; `unroll`
walked the lumpy outline into a ragged strip; and a latitude/longitude globe
with the crown mapped into it stretched the face ("major warping").

`method: "sphere", v: "height"` is the one that holds: a strip round the head,
across = true arc length round the head's own oval, down = plain height, so
every vertical surface — face, temples, back of the skull — is laid out at its
real size. The CROWN stays its own island (top-down, front toward the strip),
centred over it with `{ col: [crown, head], align: "center" }`. Measure the face
landmarks with rays from the front and give the percentages in the prompt; say
the face is a narrow panel drawn at real size, or it comes back wide enough to
wrap its eyes round onto the temples.

**The underside of the jaw splits off too.** A flat cap under the chin, fanned
from the chin to the back of the skull, can only be crushed into the strip's
bottom edge by a height mapping — on the anansi one such triangle ran out as a
sliver across half the island. `split` works on a `sphere` exactly as on a
plane: `split: [{ slot: "head-under", facing: "-y", above: 0.6, u: "+z", v: "-x" }]`
puts it on its own island seen from below, centred under the strip.

## Face MARKS on the key, and room for the face the generator draws

Percentages in the prompt did not place the ghoul's face: one sheet drew it
tiny, one off to the side. `marks` in a recipe draws landmarks into
key-labelled.png only — each a WORLD point on the model (`at: [x,y,z]`, or
`from`/`to` for a line), snapped to the part's surface and drawn where it
really lands: eyes as black discs ringed white, a nose dot, a mouth bar. Read
the points off the face's own vertex rings. `labelMax` keeps the slot's
lettering small so it cannot sit on the marks.

With the marks every face landed centred — and every face came back about
TWICE the real width, eyes wrapping onto the temples. The generator paints a
face at its own proportions whatever it is told, so the unwrap makes room:
`face: { half, scale, blend }` on a `sphere` head counts arc `scale` times
within `half` degrees of the front, easing back over `blend`. The face gets
the texels the painting wants; the sides and back stay at true size.

## Fixing the artwork at import: `flush`, `even`, `solidFrom`

Some mistakes survive every prompt, so the importer corrects them in sheet
space, under the key's island mask, before registration:

- **`flush: true`** — a generator asked for a hood draws a cowl with a black
  opening; on a flat profile island that is a dark band round the rim. Each row
  keeps only the cloth (brighter than `flushCavity` × the island median) and is
  resampled across the island's own span.
- **`even: { detail, shade, streak }`** — keep the TEXTURE, lose the big
  light/dark swings: fine detail (texel minus local blur) × `detail`, broad
  shading × `shade`, around the material colour (the `solidBand` luminance
  percentiles, default 40-85%; bone on a dark sheet wants [0.6, 0.95]).
  `streak: "x"` blurs by column, erasing bands that run ALONG a straightened
  rib. **Do not flatten to one colour** — Derek: a solid fill "looks odd as
  hell"; he wants texture with a narrow value range.
- **`boneFrom: [slots]`** (with `even`) — centre the island on the bone the
  generator painted ELSEWHERE: the brightest band (`boneBand`) of the unsaturated
  (`boneSat`) pixels of the named islands, so gold trim and ember glow stay out.
  The ghoul's spine and ribs match the ribcage painted on its chest; Derek wants
  every bone on a model to read as one material.
- **`clearPaper: { edge }`** — an ornament drawn on an off-white PAPER panel
  with a border registers as a solid plate; turn the dominant light unsaturated
  colour to ground and clear an `edge`-px rim.
- **`borrow: true`** (with `solidFrom` + `even`) — always take the source's
  artwork: the head crown borrows the head strip's painted top band, so it
  matches the head and never carries the second face the generator draws there.
- **`solidFrom: "<slot>[:top]"`** — take the colour (flat) from another island;
  with `even`, share its centre colour and borrow its artwork if this block
  came back blank. The ghoul's head crown uses `"head:top"`: left alone the
  generator drew a second little face there.

## A split has TWO seams, and they need different fixes

Splitting a shell buys a square-on view and costs a join, and the join shows up
as a line on the model in two independent ways. Both were measured on the
ratkin's crown; fixing one alone leaves the line there.

**The TEXTURE step.** The generator paints the two islands as two separate
drawings. `matchTo` is not the answer on its own: the crown was only 6% off the
head in MEAN value, and a flat gain moves an island's level without making its
EDGE agree with the edge it meets. So `unwrap-weapon --atlas` now runs a SEAM
BLEND before baking: it finds edges that are adjacent in 3D but far apart in UV,
averages the two sides across them and feathers inward over `seamBlend` texels
(default 2, `--seam-blend N`, `--no-seam-blend`). Measured across the ratkin's
69 split seams the step at the join roughly halved — head 19.5 -> 8.1, robe
21.6 -> 4.4, arm 19.9 -> 5.2 out of 255 — and the ogre picked up 23 seams of the
same treatment for free. It writes `atlas-seamblend.png` beside the atlas and
embeds that, so the GLB, the modeller's sheet and the check render all carry the
same pixels.

Only edges WITHIN one part are blended. That is exactly the set of splits, and
the only set where the two sides are guaranteed to be one surface and one
material — blending between two meshes would smear a robe into the body under
it. A mirrored part's fold is not a seam: both halves map to the same texels,
so the under-a-texel test skips it.

**The SHADING step.** `smooth` is a crease threshold, and an edge wider than it
stays HARD in the GLB — which the engine draws as a lighting line whatever the
texture does. Measured on the ratkin head at the body's 48 degrees, 8 of the 34
edges where the crown rejoins the profile were still hard. So the threshold is
now per-part: `smooth` on a `parts` entry overrides the recipe's, while the
normal accumulation stays global (which is what keeps the chest and the back
shading alike where they meet). The head runs 60, taking that to 2 of 34 and
still keeping the jaw, the brow and the ear as creases.

**Diagnose them apart.** `_softrender` computes FLAT per-face normals, so
`key-check.png` cannot show you a shading seam the engine will have, and it
makes every low-poly head look heavily faceted. Render with a flat grey texture
to see shading alone, and compute the crease normals yourself to preview what
ships. A line that survives a flat grey sheet is never a texture problem.

## A mob that wears something

A creature modelled with its kit — the ratkin has a robe, a hooded cowl and a
shoulder pad as their own meshes — is still one body for the sheet: every piece
is drawn at once, so they all share the palette and the value range. Two things
change.

**A hanging piece CUTS at its hem.** A robe, a tasset or a tabard ends on the
straight polygon edge the modeller gave it, and the only way to get a torn or
frayed one is alpha. That is the same pair of settings the human armour sheet
uses on its robe and its tasset, and the ratkin copies it:

    "robes-back": { color: "#5e8c00", fit: "contain",
                    transparency: true, cut: "bottom",
                    anchor: "top", fitPadding: 0 },

plus the slot's name in `cutoutSlots`, or the geometry stays on the opaque
material and the cut never renders. `anchor: "top"` pins the WAIST — the edge
that is actually attached — so the contain fit cannot slide the garment down and
eat the hem it was asked for; `fitPadding: 0` because the default for a cut
island insets the artwork by 3 and a robe fills its block.

**`cut: "bottom"`, not `cut: true`.** Two reasons, and the first one is a trap.
The importer defaults a MISSING `cut` to true, but `unwrap-weapon` always writes
the key, and it writes `cut: rest.cut ?? false` — so a slot given
`transparency: true` and nothing else lands in the manifest as `cut: false`,
which makes `hole()` return 0 outright and the transparency does nothing at all,
silently, with no warning anywhere. Always give a transparency slot an explicit
`cut`. And "bottom" is the better value than true: it opens an island only where
the empty run reaches the island's bottom edge, so a generator that paints the
robe a fifth too short loses that fifth off the HEM — which is what a hem is —
instead of punching a hole through the middle of the cloth.

**A cap cannot be flared out of a patch.** The ratkin's tail is a tapering box
projected down Z; its tip cap's normal is -X, so it lies in the dropped plane
and collapses to a line however hard the part is flared — flare measures depth
UNDER the outer surface and a cap has none. That is the case the patch exists
for (the same as a blade's flat tip), so a creature with a tail, a horn or a
stump reports a few patched triangles and is finished. Check WHICH slot before
chasing it; a needle on a shell is a real fault, a cap is not.

**One density for the whole animal.** The ogre's head carried a `sizeScale` of
1.3 on the theory that the face is what a player looks at. It reads as a
different material — a crisp face on a soft body — which is worse than either
alone. Give a creature's parts the texels their surface area asks for and
nothing else.

## Sizing the sheet

The sword ships at 128. The ogre ships at **256**, which is about 0.55 texels per
model unit on a 302-unit body: a chest shell ~90 texels tall, a head ~65×49, a
hand ~16×26. That is the PS1-era density this game is drawn at, and everything
upstream is resolution-independent, so `--size 512` re-cuts it denser without
touching anything else.

**Choose the size from a texel DENSITY, not from the body's size** (texels per
metre as the mob stands in the game): docs/weapon-atlas.md → *Texel density*.
Give the recipe `metresPerUnit` and `texelsPerMetre` and the unwrap prints the
density and the size that would hit the target. Mobs that fight side by side,
and the gear a mob holds, should agree, or one of them reads as a different art
style. The mob recipes predate the check and do not declare it yet.

Unlike weapons, a mob sheet is not packed onto a shared page — it is baked into
that mob's GLB, so `atlas-pack`'s capacity rules do not apply.

## The prompt

The prompt is half the pipeline. Every rule below was added because the artwork
came back wrong without it.

- **Region key by POSITION and SHAPE**, written from `--islands`, never from
  memory. A region key that no longer matches the sheet is worse than none.
- **The colours are LABELS, not paint.** State it loudly; it is the most broken
  rule on every sheet.
- **Nothing painted may be white.** The importer floods in from the sheet's edge
  through everything brighter than a light grey. A desert or bone palette walks
  straight into this — give an explicit floor (`#E8DCC0`) and say "keep it warm
  and dirty".
- **Draw to the edge and a little past it.** With `keyStroke` the overshoot is
  free and the shortfall is a seam.
- **Nothing may hang OUT of a block.** `fit: "contain"` maps the artwork's
  bounding box onto the island, so a sash drawn spilling into the gutter made
  the ogre's chest come back a third too tall, squashed to 0.79 and shoved up 62
  pixels. Say that a piece continuing onto another part means DRAW IT AGAIN
  inside that part's block, not draw across the gap.
- **One value range across every block** — see `matchTo` above. Name the pairs
  explicitly: the hand is the wrist continued, the foot is the ankle continued,
  the inner arm is the outer arm from the other side.
- **Say what is painted once and seen twice**: the head profile (one eye, not
  two), and every limb that exists once in the file and is mirrored.
- **Seams that must line up**, named one by one. On the ogre: the chest strap
  has to leave the left edge of the front block at the height it enters the left
  edge of the back block; the waist wrap has to continue onto the top of both
  leg blocks; the leg blocks have to match at ankles and hips.
- **Small parts need their edges named.** "Toes to the right" is not enough —
  say which end is the heel, which edge is the inner side, which corner the
  biggest toe goes in, and that the sole shares the top's paint so nothing may
  be drawn as a sole.
- **Name the failure mode you keep getting.** Asked for a low-poly monster head a
  generator draws a RODENT — long tapering snout, small round nose on the tip,
  big soft eyes, buck teeth. Banning it by name ("no snout, nothing tapers,
  nostrils set high and wide, undershot jaw, no whiskers, no buck teeth") is
  what fixed it.
- Keep the **SUBJECT block** last and self-contained, so a new theme is one
  paragraph swapped. Themes live as `art/<mob>/<theme>.png` +
  `out/<mob>/<theme>/`; the full prompt of every run is recorded in
  `.hitreg/image-requests/<id>.json`.

## Verifying

Five checks, cheapest first. Do not skip the first two.

1. **The tool's own.** `unwrap-weapon` samples the key inside every triangle's
   UVs. It must say **verified**. It also prints how many triangles were given a
   patch; on a creature with a stroke that number should be **0**.
2. **`sets/<recipe>/key-check.png`** — the mesh rendered wearing the key, by a
   software rasteriser, no browser needed. Every part must come out ONE flat
   slot colour.
3. **The overlap report.** Nothing over a few percent on a one-sided part. A
   mirrored part reading ~100% is correct and the tool says so.
4. **The importer's report.** Every `<-- check` row, every warning. `uncovered`
   over a few percent means the artwork missed; a `contain fit` warning means
   something was drawn outside its block.
5. **A background-sample audit.** Load the baked GLB, sample the atlas at each
   triangle's UV centroid, and count how many land on background. It must be
   **0/N**. This is what catches a seam that renders black, and it catches it
   before you are staring at the model wondering what you are looking at.
   **Test ALPHA, not darkness.** The atlas's unreached background is alpha 0;
   painted texels are alpha 255 however dark they are. A first version of this
   audit called anything under a luminance threshold "background" and then
   flagged two faces of the plague ogre's muzzle, where the nostril shadow is
   painted 13,10,6 — legitimate artwork on a dim palette, and a false alarm that
   costs a round of chasing nothing.

Then look at the thing in the engine, from the front, and at the head on its
own. A face is where every unwrap decision shows up first.

## Traps, all paid for once

**The FBX may be half a body.** The ogre's file has one arm, one hand and one
foot; the legs shells hold both legs. The other side is the same mesh mirrored,
so it wears the same paint by construction — but say so in the prompt, or you
get "a bandage on the left arm" on both arms.

**A model's own typos are load-bearing.** The ogre's hand meshes are named
`Orge_HandTop` / `Orge_HandPalm`. The recipe matches the FILE. Do not fix it.

**Blockbench OBJ is 1/100 of Blockbench FBX**, so the merged OBJ written back
for the modeller is scaled by `objScale` (default 0.01). If it opens as a speck
or not at all, that number is the first thing to check.

**The .mtl names a texture that has to BE there.** `unwrap-weapon --atlas` now
copies the sheet next to the OBJ as `<recipe>-atlas.png`. A texture an .mtl
points at and cannot find is indistinguishable, to whoever opened the file, from
no unwrap at all.

**A sheet handed back on BLACK has no ground at all.** The importer finds the
background by flooding in from the border through everything BRIGHT, so a dark
sheet has nothing to find: every piece then reads as running off into the
background, the contain fit stretches each one to cover it, and the run ends in
a faceful of overhang warnings that name the wrong problem. It happened once, on
a moss ogre sheet — six warnings, none of them the cause. The importer now
checks the border and refuses outright with the real reason, and the prompt says
the background must be pure white in as many words. Nothing downstream can
rescue one on black; ask the generator again.

**A generation can silently fail.** `image-request.mjs gen` reports
`failed: not written` when the generator wrote nothing, and installs nothing. A
straight retry has always worked.

**The check render looks from BEHIND by default.** `sets/<recipe>/key-check.png`
renders along +X, which sees the -X side. On a creature that is its back. Render
the front yourself before concluding the face is fine.
