# Weapon atlases

How a modular weapon goes from a Blockbench file to a textured ubermesh in the
engine: unwrap it, hand a generator a colour KEY of that unwrap, register the
artwork it paints back onto the mesh, and look at the result.

This is the weapon half of the armor-atlas pipeline in `tools/atlas` — same
importer, same idea, different keys. `tools/atlas/prompt.md` is the character
sheet; this doc covers weapons.

## What a modular weapon is here

One **ubermesh**: every variant of every part, all modelled in their assembled
positions, stacked in the same file. The longsword is four blades, four
crossguards, three collars, three pommels, a grip and two ornament plates — 17
parts in one model. A weapon *instance* is one choice out of each family; the
parts already meet where they were modelled to meet, so building one is nothing
more than choosing which nodes to show.

Families come from the node names with the trailing number removed
(`Blade1..4` → blade). Name parts that way and every tool downstream picks the
families up for free.

## The pipeline

```
Blockbench  →  unwrap-weapon  →  generator  →  import-atlas  →  atlas-view
   .obj         key + mesh         art           atlas.png       look at it
```

1. **Model it** in Blockbench, parts named by family, and export OBJ.
2. **Unwrap** — `pnpm -F playground unwrap-weapon --recipe <name>`. Writes the
   colour key, the slot manifest, and the mesh with UVs (GLB + two OBJs).
3. **Generate** art over `key-<name>.png` using `prompt-<name>.md`. The art must
   come back at exactly the key's size.
4. **Register** — `node tools/atlas/import-atlas.mjs --key … --art … --manifest
   manifest-<name>.json --out out-<set>`. Writes `atlas.png`.
5. **Look** — `pnpm -F playground atlas-view --recipe <name> --atlas
   out-<set>/atlas.png`. Point it at several sheets to compare sets.

To ship a self-contained mesh with its sheet inside it, re-run step 2 with
`--atlas out-<set>/atlas.png`.

## Writing a recipe for a new weapon

Recipes live at the top of `apps/playground/tools/unwrap-weapon.mjs`. One entry
per ubermesh:

- `source` / `sourceScale` — the file, and what to multiply it by. **A
  Blockbench OBJ is 1/100 of the units its FBX export uses**, so a Blockbench
  OBJ wants `sourceScale: 100`.
- `atlas: { size, bleed, bgLum }` — the finished texture. See *Sizes are in
  texels* below.
- `slots` — **one per part**. Never share an island between two parts, however
  alike they look: the sheet exists to tell four crossguards apart. Colours are
  arbitrary LABELS; white and cyan `#00ffff` are reserved (ground and cut).
- `parts` — a mesh name → the slot it paints and how it is unwrapped.
- `layout` — a flexbox-ish tree of rows and columns. Sizes come from the mesh;
  the layout only says what sits beside what, and the scale is solved to fit.
- `cutoutSlots` — which slots are alpha cut-outs. These get their own
  double-sided masked material in the exported mesh, and everything downstream
  reads that material to know which parts are decoration.
- `combos` — sample assemblies for the check render.

Then write `prompt-<name>.md` beside the key, describing every region **by
position and shape**. The prompt and the layout have to be changed together — a
region key that no longer matches the sheet is worse than none.

## Choosing an unwrap method

Measure before choosing — the tool will tell you:

    pnpm -F playground unwrap-weapon --survey --in <file.obj>

For each part it prints how much of its area faces each axis, and how much a
flat-on view along X would keep. That one number decides every case below, and
guessing instead costs a whole round trip through a generator.

| what the part looks like | method | example |
|---|---|---|
| ≥95% of its area faces one axis | `plane`, no rim | blades: 99% face the flat |
| a flat-on view plus edges it cannot see | `plane` + `rim: true` | collars, disc pommels, a cube pommel |
| a bar with no dominant face | `band` around its length, `fold: "x"` | crossguards: only ~40% faces the flat |
| a tube — six sides, no flat-on view | `unroll` around its axis | the grip |
| every facet equally slanted | `plane` along the *other* axis | a bipyramid pommel, seen from above |

**`plane`** looks along X, the weapon's thickness, so the island is the part's
own silhouette and its front and back land on the same texels — painted once,
mirrored. That is what a symmetric weapon wants.

**`rim`** hangs a bar under that silhouette carrying the faces the view cannot
see, in the same slot: as wide as the piece, as tall as the piece is thick.

**`band`** peels the whole part open around its length into one rectangle, so
the top of a bar — more than half its surface — keeps its texels instead of
being squashed into a strip. `fold` mirrors the far face onto the near one.

Whatever you choose, the island must be **the shape a generator would draw**.
Asked for a crossguard, a generator draws a crossguard, tips and all. The first
version of the longsword sheet gave the guards unrolled rectangles and two
thirds of that artwork landed on nothing.

## Sizes are in texels

Everything upstream is resolution-independent — UVs are 0..1, the art sheet
stays 1254 — but two numbers are measured in ATLAS texels and must be read
against the size you are actually shipping:

- **bleed** — how far each island is dilated outward.
- **the gutter** the layout leaves between islands, which the importer wants to
  be at least `2 × bleed`.

A 60-pixel gutter on a 1254 sheet is 12 texels at a 256 atlas but only **6 at
128**. The longsword ships at 128, so it runs `bleed: 3`. Getting this wrong
shows up as islands trading colours in the lower mips, not as an error.

For scale: 17 parts on a 128 atlas is about 2 texels per model unit — a blade
89 texels long, a pommel 6 across. If the small parts read too coarse, the
answer is `--size 256`, not a tighter layout.

## Traps

Every one of these was paid for once.

**A Blockbench export has no usable UVs.** Every face of every part is mapped
onto the same single texel — measured on LongSword.fbx, the whole model occupied
u 0..0.004. The unwrap and the key must be produced together, by one program,
from the mesh itself. Draw a key by hand and the artwork lands next to the
geometry rather than on it.

**Blockbench OBJ is 1/100 of Blockbench FBX.** Measured on one model exported
both ways: `Male.obj` is 0.92122375 tall against `HumanTest.fbx`'s 92.122 —
exactly 100.000 on all three axes, no offset. An OBJ written in FBX units
re-imports a hundred times too big and a hundred times too far from the origin,
which is what "it lost its position" looks like.

**Give the modeller a MERGED OBJ.** Seventeen objects come back as seventeen
elements, each re-origined by the importer. One object has nothing left to
re-origin. A second `-parts.obj` with one object each is written alongside for
looking at, but the merged one is the one to re-import.

**A working Blockbench file is not a clean export.** The longsword's carries a
hood from the character work and eleven leftovers from previous runs of this
very tool, re-imported and left in place. Take the parts the recipe names, first
occurrence only, and print what was ignored.

**Never let the artwork go near-white.** The importer finds the ground by
flooding in from the edge of the sheet through everything brighter than a light
grey. A blade painted with a light steel edge lost the edge — measured, a
209-luminance edge band was eaten as background and the `contain` fit then
stretched the rest of the blade 1.33× to cover its island. Weapon sheets are
bright metal, so raise `bgLum` (228 is as far as it safely goes while the
ornaments are still asked for in pure white) **and** say so in the prompt.

**A generator sizes each piece to look right, not to fill its island.** Measured
on the first real sheet: pieces came back between 0.46× and 1.9× their island
and shifted by up to 150 pixels. Put `fit: "contain"` on every slot so the
importer maps what it finds onto where it belongs, and tell the prompt to fill
each block.

**Mirror only where the model is built in halves.** Folding a band so the far
face lands on the near one is free symmetry — but a face that straddles the
middle plane folds onto itself and collapses to a line. These crossguards are
modelled as two mirrored halves so nothing straddles; the code checks rather
than assuming, and skips the fold where it would break.

**Parameterising an outline by position does not survive a concave shape.**
Measuring a vertex's place around a rim by its angle from the centre is
meaningless on a bar twelve units long and one and a half tall; measuring by
nearest point on the outline is stable but not injective, and on a guard made of
several merged boxes sixteen edge faces share an eight-sided outline. Islands
came out as bowties with white wedges bitten out of them. Hand each face its own
stretch of the band instead.

**The engine flips textures; glTF does not.** A mesh's UVs are glTF's (V from
the top), but a texture ASSET loads through three's `TextureLoader`, whose
`flipY` is true. A sheet applied through an engine material therefore lands
upside down. Two ways out: bake the atlas into the GLB (`unwrap-weapon
--atlas`), which is what a shipped weapon wants, or pre-flip the image, which is
what `atlas-view` does so a sheet can be swapped by dropping a PNG in place.
`--flip-v` writes the mesh for the other convention if you ever need it.

**An engine material overrides EVERY submesh of the model it is put on.** One
material for the whole weapon makes the ornaments solid and wastes their alpha.
Give each part its own entity with its own `node`, and the cut-out parts their
own masked double-sided material.

**Scene-authoring mines, hit while building the viewer.** A `plane` primitive is
laid flat by the renderer (it is a floor tile — use a thin box for an upright
panel), and `size` is the full extent on every shape and wants all THREE
numbers. Passing two throws during scene expansion, which aborts the whole build
and leaves a black viewport with no error in the scene file to find.

## Verifying

Three checks, cheapest first. Do not skip the first two.

1. **The tool's own.** `unwrap-weapon` samples the key inside every triangle's
   UVs and reports any that land outside their island. It must say *verified*.
   Triangles smaller than a texel are counted separately and left to the bleed —
   they cannot be point-sampled reliably and take their colour from their own
   island anyway.
2. **`key-<recipe>-check.png`** — the mesh rendered wearing the key, by a
   software rasteriser, so it works with no browser. Every part must come out
   ONE flat slot colour. White at an edge is a UV hanging off its island; a
   neighbour's colour is a layout fault.
3. **`atlas-view`** in the playground — the finished weapons, assembled, in the
   real renderer with the real materials. This is where a cut-out that did not
   cut, or a sheet applied upside down, becomes obvious.

`--debug-slot <name>` draws one island's triangles in alternating colours,
zoomed. It is the only way to see whether they tile the island or fight over it,
and it is what found every unwrap bug listed above.

## Ornaments

The cut-out plates are the only parts with alpha, and they have rules the rest
of the sheet does not:

- **Never cloth.** Wrought wire, feathers, thorns, glass or crystal shards,
  icicles, bone, chain, filigree. A banner on a sword's guard reads wrong at
  every angle.
- **Never solid.** Half or more of the square stays white; daylight goes through
  it everywhere.
- **Attached along one edge.** A plate above the guard grows up out of it, so
  its artwork anchors to the island's bottom; one hanging under the pommel
  anchors to the top. Anchor them in the manifest and say so in the prompt — a
  design that floats free of that edge reads as a decal in mid-air.
- **The middle is hidden.** The blade or the grip runs up the middle of the
  plate, so the design lives in the left and right thirds and is mirror
  symmetric.
- Plain gear does not wear filigree. Whatever picks parts for an item should
  leave the cut-out parts off common ones; the mesh says which those are, by
  their material.
