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
| `cutoutSlots` | the ornaments | empty; an animal is solid |
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
